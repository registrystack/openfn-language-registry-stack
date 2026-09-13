import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

// The receiver commits before acknowledging. Workers hold no transaction while
// executing a workflow. A crashed worker's lease eventually permits redelivery.
export class DurableInbox {
  constructor(path, { maxPending = 10000 } = {}) {
    if (!Number.isSafeInteger(maxPending) || maxPending < 1) throw new Error('invalid inbox limit');
    mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.maxPending = maxPending;
    this.db.exec(`PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS inbox (
        id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, effect TEXT NOT NULL,
        envelope TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, ready_at INTEGER NOT NULL DEFAULT 0,
        lease TEXT, lease_until INTEGER, failure TEXT,
        CHECK(status IN ('pending','running','succeeded','dead'))
      );
      CREATE INDEX IF NOT EXISTS inbox_ready ON inbox(status, ready_at);`);
  }

  accept(envelope, effect) {
    if (typeof effect !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(effect)) {
      throw new Error('invalid workflow effect');
    }
    const id = digest([envelope.event.source, envelope.event.id, effect]);
    const fingerprint = digest({ event: envelope.event, data: envelope.data });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.db.prepare('SELECT fingerprint FROM inbox WHERE id=?').get(id);
      if (prior && prior.fingerprint !== fingerprint) throw new Error('event identity conflict');
      if (!prior) {
        const { count } = this.db.prepare("SELECT count(*) AS count FROM inbox WHERE status != 'succeeded'").get();
        if (count >= this.maxPending) throw new Error('inbox full');
        this.db.prepare('INSERT INTO inbox(id,fingerprint,effect,envelope) VALUES(?,?,?,?)')
          .run(id, fingerprint, effect, JSON.stringify(envelope));
      }
      this.db.exec('COMMIT');
      return id;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  claim({ now = Date.now(), leaseMs = 65000, maxAttempts = 5 } = {}) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000) throw new Error('invalid lease');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`UPDATE inbox SET status=CASE WHEN attempts>=? THEN 'dead' ELSE 'pending' END,
        lease=NULL, lease_until=NULL, failure='worker_interrupted'
        WHERE status='running' AND lease_until<=?`).run(maxAttempts, now);
      const row = this.db.prepare("SELECT * FROM inbox WHERE status='pending' AND ready_at<=? ORDER BY ready_at, rowid LIMIT 1").get(now);
      if (row) {
        row.lease = randomUUID();
        row.attempts += 1;
        this.db.prepare("UPDATE inbox SET status='running', attempts=?, lease=?, lease_until=? WHERE id=?")
          .run(row.attempts, row.lease, now + leaseMs, row.id);
      }
      this.db.exec('COMMIT');
      return row ? { id: row.id, effect: row.effect, envelope: JSON.parse(row.envelope),
        attempts: row.attempts, lease: row.lease } : undefined;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  complete(item) {
    return this.db.prepare(`UPDATE inbox SET status='succeeded', envelope='{}', lease=NULL, lease_until=NULL, failure=NULL
      WHERE id=? AND status='running' AND lease=?`).run(item.id, item.lease).changes === 1;
  }

  fail(item, { now = Date.now(), maxAttempts = 5, retryMs = 1000 } = {}) {
    const status = item.attempts >= maxAttempts ? 'dead' : 'pending';
    return this.db.prepare(`UPDATE inbox SET status=?, ready_at=?, lease=NULL, lease_until=NULL, failure='workflow_failed'
      WHERE id=? AND status='running' AND lease=?`)
      .run(status, now + retryMs * 2 ** Math.min(item.attempts - 1, 10), item.id, item.lease).changes === 1;
  }

  replay(id) {
    return this.db.prepare("UPDATE inbox SET status='pending', attempts=0, ready_at=0, failure=NULL WHERE id=? AND status='dead'")
      .run(id).changes === 1;
  }

  // Operator status deliberately omits projected data and credential material.
  status() {
    return this.db.prepare('SELECT id,effect,status,attempts,ready_at,lease_until,failure FROM inbox ORDER BY rowid').all();
  }

  close() { this.db.close(); }
}
