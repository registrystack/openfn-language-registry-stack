import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import { dirname, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
class Refusal extends Error {
  constructor(status, code) { super(code); this.status = status; }
}

export function loadConfig(env = process.env) {
  try {
    const apiKey = readFileSync(env.DESTINATION_API_KEY_FILE, 'utf8');
    const databasePath = env.DESTINATION_DB_PATH;
    const port = Number(env.PORT ?? 8082);
    if (!/^[\x21-\x7e]{32,}$/.test(apiKey) || !databasePath || !isAbsolute(databasePath) ||
        !Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error();
    return { apiKey, databasePath, port };
  } catch { throw new Error('invalid destination configuration'); }
}

function validate(update) {
  const fields = ['source', 'eventId', 'effect', 'recordId', 'revision', 'values'];
  if (!object(update) || Object.keys(update).length !== fields.length || fields.some(key => !Object.hasOwn(update, key)) ||
      typeof update.source !== 'string' || !update.source.startsWith('urn:registrystack:registry:') ||
      Buffer.byteLength(update.source) > 512 || typeof update.eventId !== 'string' || !UUID.test(update.eventId) ||
      typeof update.recordId !== 'string' || !UUID.test(update.recordId) ||
      update.effect !== 'record-sync' || !Number.isSafeInteger(update.revision) || update.revision < 1 ||
      !object(update.values) || Object.keys(update.values).length !== 1 || typeof update.values.registered !== 'boolean') {
    throw new Refusal(400, 'invalid_update');
  }
  return update;
}

export class DestinationStore {
  constructor(databasePath) {
    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS effects (
        source TEXT NOT NULL, event_id TEXT NOT NULL, effect TEXT NOT NULL,
        payload_hash TEXT NOT NULL, record_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
        outcome TEXT NOT NULL CHECK(outcome IN ('applied', 'stale')),
        PRIMARY KEY(source, event_id, effect)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS records (
        source TEXT NOT NULL, record_id TEXT NOT NULL, effect TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0), registered INTEGER NOT NULL CHECK(registered IN (0, 1)),
        PRIMARY KEY(source, record_id, effect)
      ) STRICT;
    `);
  }

  apply(input) {
    const update = validate(input);
    // Fixed ordered fields make key order irrelevant without changing values.
    const payloadHash = createHash('sha256').update(JSON.stringify([
      update.source, update.eventId, update.effect, update.recordId, update.revision, update.values.registered,
    ])).digest('hex');
    const db = this.database;
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = db.prepare('SELECT payload_hash, revision FROM effects WHERE source = ? AND event_id = ? AND effect = ?')
        .get(update.source, update.eventId, update.effect);
      if (previous) {
        if (previous.payload_hash !== payloadHash) throw new Refusal(409, 'effect_conflict');
        db.exec('COMMIT');
        return { status: 'duplicate', revision: previous.revision };
      }
      const record = db.prepare('SELECT revision, registered FROM records WHERE source = ? AND record_id = ? AND effect = ?')
        .get(update.source, update.recordId, update.effect);
      // Two distinct events cannot silently assign different values to the same revision.
      if (record && record.revision === update.revision && record.registered !== Number(update.values.registered)) {
        throw new Refusal(409, 'revision_conflict');
      }
      const status = record && record.revision >= update.revision ? 'stale' : 'applied';
      if (status === 'applied') {
        db.prepare(`INSERT INTO records (source, record_id, effect, revision, registered) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(source, record_id, effect) DO UPDATE SET revision = excluded.revision, registered = excluded.registered`)
          .run(update.source, update.recordId, update.effect, update.revision, Number(update.values.registered));
      }
      db.prepare('INSERT INTO effects (source, event_id, effect, payload_hash, record_id, revision, outcome) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(update.source, update.eventId, update.effect, payloadHash, update.recordId, update.revision, status);
      db.exec('COMMIT');
      return { status, revision: Math.max(record?.revision ?? 0, update.revision) };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  status() {
    const counts = this.database.prepare(`SELECT count(*) AS acceptedEvents,
      coalesce(sum(outcome = 'applied'), 0) AS appliedEffects,
      coalesce(sum(outcome = 'stale'), 0) AS staleEvents FROM effects`).get();
    const records = this.database.prepare('SELECT revision FROM records ORDER BY revision').all();
    // No record ids, source values, evidence, or payloads are exposed by diagnostics.
    return { ...counts, records: records.length, revisions: records.map(record => record.revision) };
  }

  close() { this.database.close(); }
}

function authenticated(request, key) {
  const count = request.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'x-destination-key').length;
  const provided = request.headers['x-destination-key'];
  if (count !== 1 || typeof provided !== 'string') return false;
  // Fixed-size hashes avoid an input-controlled timingSafeEqual length exception.
  return timingSafeEqual(createHash('sha256').update(provided).digest(), createHash('sha256').update(key).digest());
}

function readUpdate(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Refusal(408, 'request_timeout')), 5000);
    request.on('data', chunk => {
      if (done) return;
      size += chunk.length;
      if (size > 16384) finish(new Refusal(413, 'body_too_large'));
      else chunks.push(chunk);
    });
    request.on('end', () => {
      try { finish(null, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
      catch { finish(new Refusal(400, 'invalid_update')); }
    });
    request.on('error', () => finish(new Refusal(400, 'invalid_update')));
  });
}

function respond(response, status, body) {
  if (!response.destroyed && !response.writableEnded) {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store',
      ...(status >= 400 ? { connection: 'close' } : {}) });
    response.end(JSON.stringify(body));
  }
}

export function createDestination(config, store = new DestinationStore(config.databasePath)) {
  const server = http.createServer({ maxHeaderSize: 8192 }, async (request, response) => {
    try {
      if (request.url === '/healthz' && request.method === 'GET') return respond(response, 200, { status: 'ok' });
      if (!authenticated(request, config.apiKey)) throw new Refusal(401, 'unauthorized');
      if (request.url === '/status' && request.method === 'GET') return respond(response, 200, store.status());
      if (request.url !== '/updates' || request.method !== 'POST') throw new Refusal(404, 'not_found');
      if (request.headers['content-type'] !== 'application/json' || request.headers['content-encoding'] !== undefined) {
        throw new Refusal(400, 'invalid_update');
      }
      const result = store.apply(await readUpdate(request));
      respond(response, 200, result);
    } catch (error) {
      respond(response, error instanceof Refusal ? error.status : 503,
        { status: error instanceof Refusal ? error.message : 'unavailable' });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.on('close', () => store.close());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.umask(0o077);
    const config = loadConfig();
    const server = createDestination(config);
    server.on('error', () => { process.stderr.write('destination unavailable\n'); process.exitCode = 1; });
    server.listen(config.port, '0.0.0.0');
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
  } catch { process.stderr.write('invalid destination configuration\n'); process.exitCode = 1; }
}
