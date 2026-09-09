import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { createDestination, DestinationStore } from '../src/server.js';

const apiKey = 'synthetic-destination-key-at-least-32-bytes';
const input = { source: 'urn:registrystack:registry:agricultural-holdings:instance:pilot',
  eventId: '22222222-2222-4222-8222-222222222222', effect: 'record-sync',
  recordId: '11111111-1111-4111-8111-111111111111', revision: 1, values: { registered: true } };
const event = number => `22222222-2222-4222-8222-${String(number).padStart(12, '0')}`;

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'destination-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return join(path, 'state.sqlite');
}
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
const post = (url, value = input, key = apiKey) => fetch(`${url}/updates`, { method: 'POST',
  headers: { 'content-type': 'application/json', 'x-destination-key': key }, body: JSON.stringify(value) });

test('durable dedupe, stale revision rejection, and restart retain exactly one effect', async t => {
  const path = await directory(t);
  let store = new DestinationStore(path);
  assert.deepEqual(store.apply(input), { status: 'applied', revision: 1 });
  assert.deepEqual(store.apply(input), { status: 'duplicate', revision: 1 });
  assert.deepEqual(store.apply({ ...input, eventId: event(3), revision: 3, values: { registered: false } }), { status: 'applied', revision: 3 });
  assert.deepEqual(store.apply({ ...input, eventId: event(2), revision: 2 }), { status: 'stale', revision: 3 });
  assert.deepEqual(store.status(), { acceptedEvents: 3, appliedEffects: 2, staleEvents: 1, records: 1, revisions: [3] });
  store.close();
  store = new DestinationStore(path);
  assert.equal(store.apply(input).status, 'duplicate');
  assert.equal(store.apply({ ...input, eventId: event(2), revision: 2 }).status, 'duplicate');
  assert.deepEqual(store.status(), { acceptedEvents: 3, appliedEffects: 2, staleEvents: 1, records: 1, revisions: [3] });
  store.close();
});

test('same effect key with changed payload and equal revision with conflicting value refuse atomically', async t => {
  const store = new DestinationStore(await directory(t));
  t.after(() => store.close());
  store.apply(input);
  for (const changed of [{ ...input, revision: 2 }, { ...input, values: { registered: false } },
    { ...input, recordId: '99999999-9999-4999-8999-999999999999' }]) {
    assert.throws(() => store.apply(changed), { message: 'effect_conflict', status: 409 });
  }
  assert.throws(() => store.apply({ ...input, eventId: event(2), values: { registered: false } }),
    { message: 'revision_conflict', status: 409 });
  assert.deepEqual(store.status(), { acceptedEvents: 1, appliedEffects: 1, staleEvents: 0, records: 1, revisions: [1] });
});

test('an effect ledger failure rolls back its record update', async t => {
  const store = new DestinationStore(await directory(t));
  t.after(() => store.close());
  store.database.exec("CREATE TRIGGER fail_effect BEFORE INSERT ON effects BEGIN SELECT RAISE(ABORT, 'injected'); END");
  assert.throws(() => store.apply(input));
  assert.deepEqual(store.status(), { acceptedEvents: 0, appliedEffects: 0, staleEvents: 0, records: 0, revisions: [] });
  store.database.exec('DROP TRIGGER fail_effect');
  assert.equal(store.apply(input).status, 'applied');
});

test('concurrent independent SQLite writers atomically deduplicate one effect', async t => {
  const path = await directory(t);
  const initial = new DestinationStore(path);
  initial.close();
  const moduleUrl = new URL('../src/server.js', import.meta.url).href;
  const results = await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      import(workerData.moduleUrl).then(({ DestinationStore }) => {
        const store = new DestinationStore(workerData.path);
        const result = store.apply(workerData.input);
        store.close(); parentPort.postMessage(result);
      }).catch(error => { throw error; });
    `, { eval: true, workerData: { moduleUrl, path, input } });
    worker.once('message', resolve); worker.once('error', reject);
  })));
  assert.equal(results.filter(result => result.status === 'applied').length, 1);
  assert.equal(results.filter(result => result.status === 'duplicate').length, 5);
  const store = new DestinationStore(path);
  assert.equal(store.status().appliedEffects, 1);
  store.close();
});

test('HTTP authentication, minimized payload, concurrent retries, and safe diagnostics', async t => {
  const server = createDestination({ databasePath: await directory(t), apiKey });
  const url = await listen(server);
  t.after(() => close(server));
  assert.equal((await post(url, input, 'wrong-secret')).status, 401);
  assert.equal((await fetch(`${url}/status`)).status, 401);
  const rejected = await post(url, { ...input, values: { registered: true, ownerName: 'SYNTHETIC-PRIVATE-CANARY' } });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.text()).includes('SYNTHETIC-PRIVATE-CANARY'), false);
  const results = await Promise.all(Array.from({ length: 12 }, async () => (await post(url)).json()));
  assert.equal(results.filter(result => result.status === 'applied').length, 1);
  assert.equal(results.filter(result => result.status === 'duplicate').length, 11);
  const status = await fetch(`${url}/status`, { headers: { 'x-destination-key': apiKey } });
  assert.deepEqual(await status.json(), { acceptedEvents: 1, appliedEffects: 1, staleEvents: 0, records: 1, revisions: [1] });
  assert.equal((await post(url, { ...input, extra: 'x'.repeat(17000) })).status, 413);
});

test('lost response after committed effect is safe on workflow retry and service restart', async t => {
  const path = await directory(t);
  const store = new DestinationStore(path);
  const originalApply = store.apply.bind(store);
  let server;
  store.apply = update => {
    const result = originalApply(update);
    // Deterministically drop the TCP connection after commit, before any reply.
    server.closeAllConnections();
    return result;
  };
  server = createDestination({ apiKey, databasePath: path }, store);
  const url = await listen(server);
  await assert.rejects(post(url));
  await close(server);
  const restarted = createDestination({ apiKey, databasePath: path });
  const restartedUrl = await listen(restarted);
  t.after(() => close(restarted));
  assert.deepEqual(await (await post(restartedUrl)).json(), { status: 'duplicate', revision: 1 });
  const status = await fetch(`${restartedUrl}/status`, { headers: { 'x-destination-key': apiKey } });
  assert.equal((await status.json()).appliedEffects, 1);
});

test('generation is not an effect identity field and source scopes record revisions', async t => {
  const store = new DestinationStore(await directory(t));
  t.after(() => store.close());
  assert.throws(() => store.apply({ ...input, generation: 2 }), { message: 'invalid_update' });
  assert.throws(() => store.apply({ ...input, eventId: [input.eventId] }), { message: 'invalid_update' });
  assert.throws(() => store.apply({ ...input, recordId: [input.recordId] }), { message: 'invalid_update' });
  store.apply({ ...input, revision: 4 });
  assert.equal(store.apply({ ...input, source: `${input.source}-other` }).status, 'applied');
  assert.equal(store.status().records, 2);
});
