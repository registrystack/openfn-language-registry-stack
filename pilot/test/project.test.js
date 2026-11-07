import assert from 'node:assert/strict';
import http from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import compile from '@openfn/compiler';
import run from '@openfn/runtime';
import * as bregAdaptor from '../../packages/registry-breg/src/index.js';
import { projectDocument, projectId, triggerIds, id } from '../lightning/project.mjs';
import { metadata as baseMetadata, record as baseRecord, ETAG, ID, TRACE } from '../../packages/registry-breg/test/fixtures.js';

const PROFILE = 'editor';
const bindings = { accessProfile: PROFILE, createFarmOperation: 'records.farm.create', requirement: 'urn:synthetic:registered', registeredConcept: 'urn:synthetic:registered-concept' };
const packagePath = fileURLToPath(new URL('../../packages/registry-breg', import.meta.url));
let cacheId = 0;

function compileJob(body) {
  return compile(body, { 'add-imports': { adaptors: [{ name: '@openfn/language-registry-breg', exports: Object.keys(bregAdaptor) }] } }).code;
}
async function runJob(name, baseUrl, data) {
  const workflow = projectDocument(bindings).workflows.find(item => item.name === `Agriculture ${name}`);
  const code = compileJob(workflow.jobs[0].body);
  return run({ workflow: { steps: [{ id: 'pilot', expression: code }], start: 'pilot' }, options: { start: 'pilot' } },
    { configuration: { breg: { baseUrl, authorization: { static: 'synthetic-pilot-token' } } }, data },
    { linker: { modules: { '@openfn/language-registry-breg': { path: packagePath }, '@openfn/language-common': { path: fileURLToPath(new URL('../../node_modules/@openfn/language-common', import.meta.url)) } }, cacheKey: `pilot-project-${process.pid}-${cacheId++}` } });
}
function metadata() {
  const value = baseMetadata();
  const ids = ['local-identifier', 'name'];
  const fields = [['local-identifier', 'localIdentifier', 'Local identifier'], ['name', 'name', 'Name']]
    .map(([id, apiName, label]) => ({ id, apiName, label, schema: { type: 'string' }, required: true, nullable: false, readOnly: false, removable: false }));
  value.recordTypes = [{ id: 'farm', datasetIdentifier: 'farms', route: 'farms', operations: [{ operation: 'create', accessProfile: PROFILE }], readableFields: ids, schema: '/v1/schemas/farm' }];
  value.operations = value.operations.filter(operation => operation.operation === 'create');
  for (const operation of value.operations) {
    operation.id = 'records.farm.create';
    operation.path = '/v1/records/farms';
    operation.sourceRecordType = 'farm';
    operation.responseRecordType = 'farm';
    operation.recordTypeLabel = 'Farms';
    operation.accessProfile = PROFILE;
    operation.titleFields = [ids[0]];
    operation.fields = fields;
    operation.readableFields = ids;
    operation.createWritableFields = ids;
  }
  return value;
}
function record(data) {
  const value = baseRecord();
  value.data.recordIdentifier = ID;
  value.data.domainData = data;
  value.meta.recordTypeIdentifier = 'farm';
  value.meta.datasetIdentifier = 'farms';
  return value;
}
async function fixture({ failStatus } = {}) {
  const requests = [];
  const metadataValue = metadata();
  let stored;
  let mutationCount = 0;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.setHeader('traceparent', `00-${TRACE}-00f067aa0ba902b7-01`);
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('vary', 'authorization, accept');
    if (failStatus) {
      res.statusCode = failStatus;
      res.setHeader('content-type', 'application/problem+json');
      res.end(JSON.stringify({ type: 'about:blank', status: failStatus, code: 'auth.forbidden', traceId: TRACE, title: 'secret-failure-canary', detail: 'secret-failure-canary' }));
      return;
    }
    if (req.url.includes('/v1/registry')) return res.end(JSON.stringify(metadataValue));
    res.setHeader('link', '<https://id.registrystack.org/profiles/registry-record/v1>; rel="profile", </tenant/v1/schemas/farm>; rel="describedby"');
    res.setHeader('etag', ETAG);
    const incoming = JSON.parse(body).data;
    if (!stored) { stored = incoming; mutationCount++; }
    else if (!isDeepStrictEqual(incoming, stored)) {
      res.statusCode = 409;
      res.setHeader('content-type', 'application/problem+json');
      return res.end(JSON.stringify({ type: 'about:blank', status: 409, code: 'mutation.conflict', traceId: TRACE }));
    }
    res.statusCode = 201;
    res.setHeader('location', `/tenant/v1/records/farms/${ID}`);
    return res.end(JSON.stringify(record(stored)));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { requests, mutationCount: () => mutationCount, baseUrl: `http://127.0.0.1:${server.address().port}/tenant`, close: () => new Promise(resolve => server.close(resolve)) };
}

function assertClean(result) {
  assert.equal('configuration' in result, false);
  assert.ok(!JSON.stringify(result).includes('synthetic-pilot-token'));
  assert.ok(!JSON.stringify(result).includes('secret-failure-canary'));
}

test('project graph has deterministic unique IDs and starts disabled with webhook authentication required', () => {
  const first = projectDocument(bindings);
  assert.deepEqual(first, projectDocument(bindings));
  assert.equal(first.id, projectId);
  const identifiers = [first.id];
  for (const workflow of first.workflows) {
    identifiers.push(workflow.id, ...workflow.jobs.map(job => job.id), ...workflow.triggers.map(trigger => trigger.id), ...workflow.edges.map(edge => edge.id));
    assert.equal(workflow.triggers[0].enabled, false);
    assert.equal(workflow.triggers[0].has_auth_method, true);
    assert.ok(workflow.jobs.every(job => job.project_credential_id === null));
    const jobs = new Set(workflow.jobs.map(job => job.id));
    for (const edge of workflow.edges) assert.ok(jobs.has(edge.target_job_id));
  }
  assert.equal(identifiers.length, new Set(identifiers).size);
  assert.ok(identifiers.every(value => /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)));
  assert.equal(triggerIds.registration, id('registration:trigger'));
  const configured = projectDocument(bindings, { breg: id('credential:breg'), evidence: id('credential:evidence'), destination: id('credential:destination') }, true);
  assert.ok(configured.workflows.every(workflow => workflow.triggers[0].enabled));
  assert.equal(configured.workflows[0].jobs[0].project_credential_id, id('credential:breg'));
});

test('binding strings are JavaScript literals and cannot inject operations', () => {
  const hostile = "synthetic'); throw new Error('injected'); //\n\u2028\"\\";
  const project = projectDocument(Object.fromEntries(Object.keys(bindings).map(key => [key, hostile])));
  for (const workflow of project.workflows) {
    for (const job of workflow.jobs) assert.doesNotThrow(() => compile(job.body));
  }
  assert.ok(project.workflows[0].jobs[0].body.includes(JSON.stringify(hostile).replace(/\u2028/g, "\\u2028")));
});

test('compiled registration invokes the native metadata-selected create and emits minimal output', async () => {
  const stub = await fixture();
  try {
    const input = { submissionId: 'registration-001', localIdentifier: 'SYNTHETIC-FARM-001', name: 'Synthetic Farm' };
    const result = await runJob('registration', stub.baseUrl, input);
    assert.equal(result.errors, undefined, JSON.stringify(result));
    assert.deepEqual(result.data, { status: 'registered', recordId: ID, traceId: TRACE });
    assertClean(result);
    assert.equal(stub.requests.length, 2);
    assert.equal(stub.requests[1].headers['idempotency-key'], 'registration:registration-001');
    assert.deepEqual(JSON.parse(stub.requests[1].body), { data: { localIdentifier: input.localIdentifier, name: input.name } });
    assert.ok(stub.requests.every(request => request.headers.authorization === 'Bearer synthetic-pilot-token'));
  } finally { await stub.close(); }
});

test('unstable submission identifiers fail before any HTTP exchange', async () => {
  const stub = await fixture();
  try {
    for (const submissionId of ['', 'event/with/path', undefined]) {
      const result = await runJob('registration', stub.baseUrl, { submissionId });
      assert.ok(result.errors, JSON.stringify(result));
      assert.match(result.errors.pilot.message, /A stable submissionId is required/);
      assertClean(result);
    }
    assert.equal(stub.requests.length, 0);
  } finally { await stub.close(); }
});

test('registration replay reuses the durable key and a changed payload conflicts', async () => {
  const stub = await fixture();
  try {
    const input = { submissionId: 'registration-replay-001', localIdentifier: 'SYNTHETIC-FARM-001', name: 'Synthetic Farm' };
    const first = await runJob('registration', stub.baseUrl, input);
    const replay = await runJob('registration', stub.baseUrl, input);
    const changed = await runJob('registration', stub.baseUrl, { ...input, name: 'A different payload' });
    assert.equal(first.errors, undefined, JSON.stringify(first));
    assert.equal(replay.errors, undefined, JSON.stringify(replay));
    assert.deepEqual(replay.data, first.data);
    assert.match(changed.errors.pilot.message, /Registry operation did not complete: conflict/);
    assert.equal(stub.mutationCount(), 1);
    assert.ok(stub.requests.filter(request => request.method === 'POST').every(request => request.headers['idempotency-key'] === 'registration:registration-replay-001'));
    assertClean(replay);
    assertClean(changed);
  } finally { await stub.close(); }
});
