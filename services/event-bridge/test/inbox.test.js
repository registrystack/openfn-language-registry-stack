import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DurableInbox } from '../src/inbox.js';
import { runOnce, runCli } from '../src/worker.js';

const envelope = { event: { source: 'urn:synthetic:registry', id: 'event-1' },
  delivery: { generation: 1 }, data: { values: { reference: 'synthetic-record' } } };

async function fixture(t, options) {
  const directory = await mkdtemp(join(tmpdir(), 'registry-inbox-'));
  const path = join(directory, 'inbox.sqlite');
  const inbox = new DurableInbox(path, options);
  t.after(async () => { inbox.close(); await rm(directory, { recursive: true, force: true }); });
  return { inbox, path, directory };
}

test('commit survives restart; new delivery generation retains one effect and conflicting payload is refused', async t => {
  const { inbox, path } = await fixture(t);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const id = inbox.accept(envelope, 'notify');
  const restarted = new DurableInbox(path);
  try {
    assert.equal(restarted.accept({ ...envelope, delivery: { generation: 2 } }, 'notify'), id);
    assert.throws(() => restarted.accept({ ...envelope, data: { values: {} } }, 'notify'), /identity conflict/);
    assert.equal(restarted.status().length, 1);
    const item = restarted.claim();
    assert.deepEqual(item.envelope, envelope);
    assert.equal(restarted.complete(item), true);
    assert.equal(restarted.accept(envelope, 'notify'), id);
    assert.equal(restarted.claim(), undefined);
    assert.notEqual(restarted.accept(envelope, 'intake'), id);
  } finally { restarted.close(); }
});

test('concurrent workers cannot claim one live lease; stale completion cannot overwrite recovery', async t => {
  const { inbox, path } = await fixture(t);
  inbox.accept(envelope, 'notify');
  const other = new DurableInbox(path);
  try {
    const first = inbox.claim({ now: 0, leaseMs: 1000 });
    assert.equal(other.claim({ now: 999 }), undefined);
    const recovered = other.claim({ now: 1000 });
    assert.equal(recovered.id, first.id);
    assert.equal(recovered.attempts, 2);
    assert.notEqual(recovered.lease, first.lease);
    assert.equal(inbox.complete(first), false);
    assert.equal(other.complete(recovered), true);
  } finally { other.close(); }
});

test('bounded retries reach dead-letter and explicit replay preserves effect identity', async t => {
  const { inbox } = await fixture(t);
  const id = inbox.accept(envelope, 'notify');
  const first = inbox.claim({ now: 0 });
  inbox.fail(first, { now: 0, maxAttempts: 2, retryMs: 100 });
  assert.equal(inbox.claim({ now: 99 }), undefined);
  const second = inbox.claim({ now: 100 });
  inbox.fail(second, { now: 100, maxAttempts: 2 });
  assert.equal(inbox.status()[0].status, 'dead');
  assert.equal(inbox.claim({ now: 100000 }), undefined);
  assert.equal(inbox.replay(id), true);
  assert.equal(inbox.replay(id), false);
  const replay = inbox.claim({ now: 100001 });
  assert.equal(replay.id, id);
  assert.equal(replay.attempts, 1);
});

test('repeated worker crashes also exhaust bounded attempts', async t => {
  const { inbox } = await fixture(t);
  inbox.accept(envelope, 'notify');
  assert.ok(inbox.claim({ now: 0, leaseMs: 1000, maxAttempts: 2 }));
  assert.ok(inbox.claim({ now: 1000, leaseMs: 1000, maxAttempts: 2 }));
  assert.equal(inbox.claim({ now: 2000, maxAttempts: 2 }), undefined);
  assert.equal(inbox.status()[0].status, 'dead');
});

test('capacity failure does not persist or evict an accepted pending event', async t => {
  const { inbox } = await fixture(t, { maxPending: 1 });
  inbox.accept(envelope, 'notify');
  assert.throws(() => inbox.accept(envelope, 'intake'), /inbox full/);
  assert.equal(inbox.status().length, 1);
  assert.ok(inbox.accept(envelope, 'notify'));
});

test('runner stores only redacted failure state and permits independent workflow recovery', async t => {
  const { inbox } = await fixture(t);
  inbox.accept(envelope, 'notify');
  const config = { timeoutMs: 1000 };
  await runOnce(inbox, config, async () => { throw new Error('SYNTHETIC-SECRET-CANARY'); });
  assert.equal(inbox.status()[0].status, 'pending');
  assert.equal(JSON.stringify(inbox.status()).includes('SYNTHETIC-SECRET-CANARY'), false);
  inbox.accept(envelope, 'intake');
  await runOnce(inbox, config, async item => { assert.equal(item.effect, 'intake'); });
  assert.equal(inbox.status()[1].status, 'succeeded');
});

test('CLI handoff uses protected state files, bounds execution and removes transient state', async t => {
  const { inbox, path, directory } = await fixture(t);
  inbox.accept(envelope, 'notify');
  const executable = join(directory, 'synthetic-cli');
  await writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs');
    const args=process.argv.slice(2); const state=JSON.parse(fs.readFileSync(args[args.indexOf('-s')+1]));
    if(state.data.event.id!=='event-1'||state.configuration.key!=='synthetic-secret'||!state.eventEffectId)process.exit(1);
    fs.writeFileSync(args[args.indexOf('-o')+1], JSON.stringify(state));
    process.stdout.write('SYNTHETIC-PRIVATE-OUTPUT'); process.stderr.write('SYNTHETIC-PRIVATE-ERROR');
  `);
  await chmod(executable, 0o700);
  const credentials = join(directory, 'credentials.json');
  await writeFile(credentials, JSON.stringify({ key: 'synthetic-secret' }), { mode: 0o600 });
  const config = { inboxPath: path, binary: executable, timeoutMs: 1000,
    workflows: { notify: { job: 'synthetic.js', adaptor: 'common@1.0.0', configurationFile: credentials } } };
  await runOnce(inbox, config);
  assert.equal(inbox.status()[0].status, 'succeeded');
  assert.equal((await readdir(directory)).some(file => file.startsWith('attempt-')), false);
  await writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs'); const args=process.argv.slice(2);
    fs.writeFileSync(args[args.indexOf('-o')+1],JSON.stringify({errors:{'job-1':{message:'SYNTHETIC-PRIVATE'}}}));`);
  await assert.rejects(runCli({ effect: 'notify', id: 'synthetic', envelope }, config), /workflow failed/);
  await writeFile(executable, `#!${process.execPath}\nsetInterval(()=>{},1000);`);
  await assert.rejects(runCli({ effect: 'notify', id: 'synthetic', envelope }, { ...config, timeoutMs: 100 }));
  assert.equal((await readdir(directory)).some(file => file.startsWith('attempt-')), false);
});
