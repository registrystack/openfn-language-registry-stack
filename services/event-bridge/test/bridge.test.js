import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBridge, loadConfig, EVENT_PATH, webhookSignature } from '../src/server.js';
import { DurableInbox } from '../src/inbox.js';

const key = Buffer.from('a-synthetic-hmac-key-at-least-32-bytes');
const source = 'urn:registrystack:registry:agricultural-holdings:instance:pilot';
const schema = `urn:breg:event-schema:agricultural-holdings:farm:farm-created-v1:sha256:${'a'.repeat(64)}`;
const data = { entity: 'farm', recordId: '11111111-1111-4111-8111-111111111111', revision: 1,
  trigger: 'created', packageRevision: `sha256:${'b'.repeat(64)}`, values: { 'local-identifier': 'SYNTHETIC-FARM-001' } };

// Independent implementation of the ordered Rust signing contract, deliberately
// not the production verifier helper. Any body or signed-header change is bound.
function sign(headers, body, path = EVENT_PATH, method = 'POST') {
  const parts = [Buffer.from('breg-webhook-signature-v1')];
  for (const value of [headers['ce-specversion'], headers['ce-id'], headers['ce-source'], headers['ce-type'],
    headers['ce-time'], headers['ce-dataschema'], headers['x-registry-event-generation'],
    headers['x-registry-delivery-attempt'], headers['x-registry-delivery-time'], method, path,
    headers['content-type'], headers['idempotency-key'], body]) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    parts.push(length, bytes);
  }
  return `v1=${createHmac('sha256', key).update(Buffer.concat(parts)).digest('base64url')}`;
}

function delivery(changes = {}, value = data, path = EVENT_PATH) {
  const body = Buffer.from(JSON.stringify(value));
  const headers = { 'content-type': 'application/json', 'ce-specversion': '1.0',
    'ce-id': '22222222-2222-4222-8222-222222222222', 'ce-source': source, 'ce-type': 'farm-created-v1',
    'ce-time': '2020-01-01T00:00:00Z', 'ce-dataschema': schema,
    'x-registry-event-generation': '1', 'x-registry-delivery-attempt': '1',
    'x-registry-delivery-time': new Date().toISOString(), 'idempotency-key': `sha256:${'c'.repeat(64)}`,
    ...changes };
  headers['x-registry-signature'] = sign(headers, body, path);
  return { headers, body };
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

async function fixture(t, upstreamHandler, overrides = {}) {
  const calls = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    calls.push({ headers: request.headers, data: JSON.parse(Buffer.concat(chunks)) });
    if (upstreamHandler) return upstreamHandler(request, response, calls.length);
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ work_order_id: '33333333-3333-4333-8333-333333333333' }));
  });
  const upstreamUrl = await listen(upstream);
  const config = { hmacKey: key, apiKey: 'synthetic-openfn-key', expectedSource: source, expectedEntity: 'farm',
    expectedEvents: { 'farm-created-v1': { schema, trigger: 'created' } }, allowedValueFields: ['local-identifier'],
    maxBodyBytes: 65536, maxDeliverySkewSeconds: 300, timeoutMs: 100, openfnUrl: new URL(`${upstreamUrl}/fixed`), ...overrides };
  const bridge = createBridge(config);
  const url = await listen(bridge);
  t.after(async () => { await close(bridge); await close(upstream); });
  return { url, calls, config };
}

test('forwards verified envelope only after real work-order acceptance; old event time is permitted', async t => {
  const { url, calls } = await fixture(t);
  const request = delivery();
  assert.equal(webhookSignature(key, request.headers, request.body), request.headers['x-registry-signature']);
  const response = await fetch(`${url}${EVENT_PATH}`, { method: 'POST', ...request });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { status: 'accepted' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers['x-api-key'], 'synthetic-openfn-key');
  assert.equal(calls[0].headers['x-registry-signature'], undefined);
  assert.deepEqual(calls[0].data.data, data);
  assert.equal(calls[0].data.event.source, source);
  assert.equal(calls[0].data.delivery.generation, 1);
  assert.equal(JSON.stringify(calls[0]).includes(key.toString()), false);
});

test('configured event path is exact and bound into the HMAC', async t => {
  const eventPath = '/events/laboratory';
  const { url, calls } = await fixture(t, undefined, { eventPath });
  assert.equal((await fetch(`${url}${EVENT_PATH}`, { method: 'POST', ...delivery() })).status, 404);
  assert.equal((await fetch(`${url}${eventPath}?other=1`, { method: 'POST', ...delivery({}, data, eventPath) })).status, 404);
  assert.equal((await fetch(`${url}${eventPath}`, { method: 'POST', ...delivery() })).status, 401);
  assert.equal(calls.length, 0);
  assert.equal((await fetch(`${url}${eventPath}`, { method: 'POST', ...delivery({}, data, eventPath) })).status, 202);
  assert.equal(calls.length, 1);
});

test('rejects body and every signed header tampering without upstream effects', async t => {
  const { url, calls } = await fixture(t);
  for (const field of ['ce-specversion', 'ce-id', 'ce-source', 'ce-type', 'ce-time', 'ce-dataschema',
    'x-registry-event-generation', 'x-registry-delivery-attempt', 'x-registry-delivery-time',
    'content-type', 'idempotency-key', 'x-registry-signature']) {
    const request = delivery();
    request.headers[field] += 'x';
    const response = await fetch(`${url}${EVENT_PATH}`, { method: 'POST', ...request });
    assert.ok(response.status >= 400, field);
  }
  const request = delivery();
  request.body = Buffer.from(request.body.toString().replace('SYNTHETIC-FARM-001', 'SYNTHETIC-FARM-002'));
  assert.equal((await fetch(`${url}${EVENT_PATH}`, { method: 'POST', ...request })).status, 401);
  assert.equal(calls.length, 0);
});

test('rejects correctly signed wrong source/type/schema, old/future delivery and unprojected payload', async t => {
  const { url, calls } = await fixture(t);
  for (const changes of [
    { 'ce-source': `${source}-other` }, { 'ce-type': 'unexpected' }, { 'ce-dataschema': `${schema}f` },
    { 'x-registry-delivery-time': new Date(Date.now() - 301000).toISOString() },
    { 'x-registry-delivery-time': new Date(Date.now() + 301000).toISOString() },
  ]) assert.equal((await fetch(`${url}${EVENT_PATH}`, { method: 'POST', ...delivery(changes) })).status, 400);
  for (const value of [
    { ...data, values: { ...data.values, ownerName: 'SYNTHETIC-PRIVATE-CANARY' } },
    { ...data, trigger: 'patched' }, { ...data, entity: 'other' }, { ...data, revision: 0 },
    { ...data, recordId: [data.recordId] }, { ...data, packageRevision: [data.packageRevision] },
    { ...data, ownerName: 'SYNTHETIC-PRIVATE-CANARY' },
  ]) {
    const response = await fetch(`${url}${EVENT_PATH}`, { method: 'POST', ...delivery({}, value) });
    assert.equal(response.status, 400);
    assert.equal((await response.text()).includes('SYNTHETIC-PRIVATE-CANARY'), false);
  }
  assert.equal(calls.length, 0);
});

test('fixed method/path, duplicate signed headers and body ceiling reject', async t => {
  const { url, calls } = await fixture(t, undefined, { maxBodyBytes: 1024 });
  assert.equal((await fetch(`${url}${EVENT_PATH}?target=other`, { method: 'POST', ...delivery() })).status, 404);
  assert.equal((await fetch(`${url}${EVENT_PATH}`, { method: 'PUT', ...delivery() })).status, 404);
  assert.equal((await fetch(`${url}${EVENT_PATH}`, { method: 'POST', ...delivery({}, { ...data, extra: 'x'.repeat(1024) }) })).status, 413);
  const duplicate = delivery();
  const status = await new Promise((resolve, reject) => {
    const headers = Object.entries(duplicate.headers).flat();
    headers.push('CE-ID', duplicate.headers['ce-id']);
    const request = http.request(`${url}${EVENT_PATH}`, { method: 'POST', headers }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject); request.end(duplicate.body);
  });
  assert.equal(status, 400);
  assert.equal(calls.length, 0);
});

test('upstream failure is retryable and bridge performs no hidden retries', async t => {
  const { url, calls } = await fixture(t, (_request, response, attempt) => {
    response.writeHead(attempt === 1 ? 503 : 201);
    response.end(attempt === 1 ? 'unavailable' : JSON.stringify({ work_order_id: '33333333-3333-4333-8333-333333333333' }));
  });
  assert.equal((await fetch(`${url}${EVENT_PATH}`, { method: 'POST', ...delivery() })).status, 502);
  assert.equal(calls.length, 1);
  assert.equal((await fetch(`${url}${EVENT_PATH}`, { method: 'POST', ...delivery({ 'x-registry-delivery-attempt': '2' }) })).status, 202);
  assert.equal(calls.length, 2);
});

test('redirect, generic 2xx, incomplete acceptance and oversized response are not acknowledgements', async t => {
  for (const [status, body, headers] of [[302, '{}', { location: '/other' }], [200, '{}', {}],
    [201, '{"work_order_id":"x"}', {}],
    [200, JSON.stringify({work_order_id: '33333333-3333-4333-8333-333333333333', error: 'too_many_runs'}), {}], [200, 'x'.repeat(17000), {}]]) {
    await t.test(String(status) + body.length, async t => {
      const { url, calls } = await fixture(t, (_request, response) => { response.writeHead(status, headers); response.end(body); });
      assert.equal((await fetch(`${url}${EVENT_PATH}`, { method: 'POST', ...delivery() })).status, 502);
      assert.equal(calls.length, 1);
    });
  }
});

test('timeout and lost upstream acceptance response remain retryable', async t => {
  const { url, calls } = await fixture(t, (request, _response, count) => { if (count === 2) request.socket.destroy(); });
  assert.equal((await fetch(`${url}${EVENT_PATH}`, { method: 'POST', ...delivery() })).status, 504);
  assert.equal(calls.length, 1);
  assert.equal((await fetch(`${url}${EVENT_PATH}`, { method: 'POST', ...delivery({ 'x-registry-delivery-attempt': '2' }) })).status, 502);
  assert.equal(calls.length, 2);
});

test('configuration uses exact secret bytes, explicit HTTP trust and safe errors', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await Promise.all([
    writeFile(join(dir, 'hmac'), Buffer.concat([key, Buffer.from('\n')])),
    writeFile(join(dir, 'api'), 'SYNTHETIC-API-KEY'),
    writeFile(join(dir, 'events'), JSON.stringify({ 'farm-created-v1': { schema, trigger: 'created' } })),
    writeFile(join(dir, 'fields'), '["local-identifier"]'),
  ]);
  const env = { BREG_HMAC_KEY_FILE: join(dir, 'hmac'), OPENFN_API_KEY_FILE: join(dir, 'api'),
    BREG_EXPECTED_EVENTS_FILE: join(dir, 'events'), BREG_ALLOWED_VALUE_FIELDS_FILE: join(dir, 'fields'),
    BREG_EXPECTED_SOURCE: source, BREG_EXPECTED_ENTITY: 'farm', OPENFN_WEBHOOK_URL: 'http://openfn:4000/i/pilot' };
  assert.throws(() => loadConfig(env), /^Error: invalid bridge configuration$/);
  assert.equal(loadConfig({ ...env, ALLOW_HTTP: 'true' }).hmacKey.at(-1), 10);
  assert.equal(loadConfig({ ...env, ALLOW_HTTP: 'true', BREG_EVENT_PATH: '/events/laboratory' }).eventPath, '/events/laboratory');
  assert.throws(() => loadConfig({ ...env, ALLOW_HTTP: 'true', BREG_EVENT_PATH: '/events/laboratory?other=1' }),
    /^Error: invalid bridge configuration$/);
  assert.throws(() => loadConfig({ ...env, OPENFN_WEBHOOK_URL: 'https://secret:canary@example.org/' }), /^Error: invalid bridge configuration$/);
  await writeFile(join(dir, 'fields'), '[]');
  assert.deepEqual(loadConfig({ ...env, ALLOW_HTTP: 'true' }).allowedValueFields, []);
});


test('CLI delivery authenticates before durable acceptance and handles lifecycle events without upstream work', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-durable-'));
  const path = join(directory, 'inbox.sqlite');
  const { url, calls } = await fixture(t, () => { throw new Error('CLI mode must not forward'); }, {
    deliveryMode: 'cli', inboxPath: path,
    expectedEvents: { 'farm-created-v1': { schema, trigger: 'request_lifecycle', effect: 'notify',
      entity: 'correction-request', valueFields: ['record-reference'] } },
  });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const payload = { ...data, entity: 'correction-request', trigger: 'request_lifecycle',
    values: { 'record-reference': 'synthetic-reference' },
    request: { proposalVersion: 1, workflowRevision: 2, transition: 'request_revision',
      fromState: 'submitted', toState: 'needs_changes', stage: 'review', reasonPresent: false,
      effectDigest: `sha256:${'d'.repeat(64)}`, deduplicationKey: `sha256:${'e'.repeat(64)}` } };
  const invalid = delivery({}, payload);
  invalid.headers['x-registry-signature'] = `v1=${'x'.repeat(43)}`;
  assert.equal((await fetch(`${url}${EVENT_PATH}`, { method: 'POST', ...invalid })).status, 401);
  const persisted = new DurableInbox(path);
  try {
    assert.equal(persisted.status().length, 0);
    for (const generation of ['1', '2']) {
      const request = delivery({ 'x-registry-event-generation': generation }, payload);
      assert.equal((await fetch(`${url}${EVENT_PATH}`, { method: 'POST', ...request })).status, 202);
      assert.equal(persisted.status().length, 1, '202 means durable acceptance, even before worker starts');
    }
    assert.equal(calls.length, 0);
    assert.equal(persisted.claim().envelope.data.request.toState, 'needs_changes');
  } finally { persisted.close(); }
});
