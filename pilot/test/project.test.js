import assert from 'node:assert/strict';
import http from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import compile from '@openfn/compiler';
import run from '@openfn/runtime';
import * as bregAdaptor from '../../packages/registry-breg/src/index.js';
import { projectDocument, projectId, triggerIds, id } from '../lightning/project.mjs';
import { metadata as baseMetadata, record as baseRecord, ETAG, ACTION_ETAG, ID, TRACE } from '../../packages/registry-breg/test/fixtures.js';

const PROFILE = 'editor';
const REQUEST_ID = '00000000-0000-4000-8000-000000000002';
const bindings = { accessProfile: PROFILE, createFarmOperation: 'records.farm.create', createCorrectionOperation: 'records.name-correction.create', requirement: 'urn:synthetic:registered', registeredConcept: 'urn:synthetic:registered-concept' };
const correctionInput = { submissionId: 'correction-001', recordId: ID, name: 'Synthetic Farm Corrected', reason: 'Synthetic correction', supportingReference: 'SYNTHETIC-001' };
const correctionData = input => ({ record: input.recordId, name: input.name, reason: input.reason, supportingReference: input.supportingReference });
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

function metadata(entity, route, fields) {
  const value = baseMetadata();
  const fieldId = name => name.replace(/[A-Z]/g, letter => "-" + letter.toLowerCase());
  const fieldIds = Object.keys(fields).map(fieldId);
  value.entities[0].id = entity;
  value.entities[0].route = route;
  value.entities[0].readableFields = fieldIds;
  value.entities[0].schema = `/v1/schemas/${entity}`;
  value.entities[0].operations.forEach(operation => { operation.accessProfile = PROFILE; });
  value.operations.forEach(operation => {
    operation.id = operation.id.replace('company', entity);
    operation.path = operation.path.replace('companies', route);
    operation.sourceEntity = entity;
    operation.responseEntity = entity;
    operation.accessProfile = PROFILE;
    operation.titleFields = [fieldIds[0]];
    operation.fields = Object.entries(fields).map(([field, type]) => ({ id: fieldId(field), apiName: field, label: field, schema: { type }, required: true, nullable: false, readOnly: false, removable: false }));
    operation.readableFields = fieldIds;
    operation.createWritableFields = operation.operation === 'create' ? fieldIds : [];
    operation.patchWritableFields = operation.operation === 'patch' ? fieldIds : [];
  });
  return value;
}
function record(entity, recordId, data, lifecycleState) {
  const value = baseRecord(Boolean(lifecycleState));
  value.data.recordIdentifier = recordId;
  value.data.snapshot = `breg1_${recordId}`;
  value.data.domainData = data;
  value.meta.entityTypeIdentifier = entity;
  if (lifecycleState) {
    value.data.request.bregState = lifecycleState;
    value.data.request.actions = lifecycleState === 'draft' ? [{ operation: 'submit_request', method: 'POST', href: `/v1/records/name-corrections/${recordId}/actions/submit?accessProfile=${PROFILE}`, ifMatch: ACTION_ETAG }] : [];
  }
  return value;
}
async function fixture({ entity = 'farm', currentState = 'draft', currentData, storedData, failStatus } = {}) {
  const requests = [];
  const route = entity === 'farm' ? 'farms' : 'name-corrections';
  const recordId = entity === 'farm' ? ID : REQUEST_ID;
  const fields = entity === 'farm' ? { localIdentifier: 'string', name: 'string' } : { record: 'string', name: 'string', reason: 'string', supportingReference: 'string' };
  const metadataValue = metadata(entity, route, fields);
  let stored = storedData;
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
    if (req.url.includes('/actions/')) {
      mutationCount++;
      currentState = 'submitted';
      const value = record(entity, recordId, stored, 'draft');
      return res.end(JSON.stringify({ id: recordId, revision: 8, snapshot: `breg1_${recordId}`, request: { bregState: 'submitted', proposalVersion: 7, effectDigest: value.data.request.effectDigest, application: null } }));
    }
    res.setHeader('link', `<https://id.registrystack.org/profiles/registry-record/v1>; rel="profile", </tenant/v1/schemas/${entity}>; rel="describedby"`);
    res.setHeader('etag', ETAG);
    if (req.method === 'POST') {
      const incoming = JSON.parse(body).data;
      if (!stored) { stored = incoming; mutationCount++; }
      else if (!isDeepStrictEqual(incoming, stored)) {
        res.statusCode = 409;
        res.setHeader('content-type', 'application/problem+json');
        return res.end(JSON.stringify({ type: 'about:blank', status: 409, code: 'mutation.conflict', traceId: TRACE }));
      }
      res.statusCode = 201;
      res.setHeader('location', `/tenant/v1/records/${route}/${recordId}`);
      return res.end(JSON.stringify(record(entity, recordId, stored)));
    }
    return res.end(JSON.stringify(record(entity, recordId, currentData ?? stored, currentState)));
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

test('compiled correction creates a draft, reads its action and submits with a separate idempotency key', async () => {
  const stub = await fixture({ entity: 'name-correction' });
  try {
    const result = await runJob('correction', stub.baseUrl, correctionInput);
    assert.equal(result.errors, undefined, JSON.stringify(result));
    assert.deepEqual(result.data, { status: 'submitted', requestId: REQUEST_ID });
    assertClean(result);
    const writes = stub.requests.filter(request => request.method === 'POST');
    assert.equal(writes.length, 2);
    assert.deepEqual(JSON.parse(writes[0].body), { data: correctionData(correctionInput) });
    assert.equal(writes[0].headers['idempotency-key'], 'correction:correction-001');
    assert.equal(writes[1].headers['idempotency-key'], 'correction-submit:correction-001');
    assert.equal(writes[1].headers['if-match'], ACTION_ETAG);
    assert.deepEqual(JSON.parse(writes[1].body), {});
  } finally { await stub.close(); }
});

test('same correction replay reconciles current state without duplicate lifecycle mutation', async () => {
  const stub = await fixture({ entity: 'name-correction' });
  try {
    const first = await runJob('correction', stub.baseUrl, correctionInput);
    const replay = await runJob('correction', stub.baseUrl, correctionInput);
    assert.equal(first.errors, undefined, JSON.stringify(first));
    assert.equal(replay.errors, undefined, JSON.stringify(replay));
    assert.deepEqual(replay.data, { status: 'already_submitted', requestId: REQUEST_ID });
    assert.equal(stub.mutationCount(), 2);
    assert.equal(stub.requests.filter(request => request.url.includes('/actions/')).length, 1);
    assertClean(replay);
  } finally { await stub.close(); }
});

test('changed correction content is refused before already-submitted classification or action execution', async () => {
  for (const currentState of ['draft', 'submitted']) {
    const stub = await fixture({ entity: 'name-correction', currentState, currentData: { ...correctionData(correctionInput), name: 'A different correction' } });
    try {
      const result = await runJob('correction', stub.baseUrl, correctionInput);
      assert.ok(result.errors, JSON.stringify(result));
      assert.match(result.errors.pilot.message, /Correction content does not match/);
      assert.equal(stub.requests.length, 3);
      assert.equal(stub.requests.some(request => request.url.includes('/actions/')), false);
      assertClean(result);
    } finally { await stub.close(); }
  }
});

test('unknown request states and native failures stop dependent mutations and retain safe failures', async () => {
  for (const options of [{ entity: 'name-correction', currentState: 'cancelled' }, { entity: 'name-correction', failStatus: 403 }]) {
    const stub = await fixture(options);
    try {
      const result = await runJob('correction', stub.baseUrl, correctionInput);
      assert.ok(result.errors, JSON.stringify(result));
      assert.match(result.errors.pilot.message, options.failStatus ? /Registry operation did not complete: denied/ : /Correction is not ready for submission/);
      assert.equal(stub.requests.some(request => request.url.includes('/actions/')), false);
      assertClean(result);
    } finally { await stub.close(); }
  }
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

test('a rejected correction replay returns its existing request without submission or mutation', async () => {
  const stub = await fixture({ entity: 'name-correction', currentState: 'rejected', storedData: correctionData(correctionInput) });
  try {
    for (let retry = 0; retry < 2; retry++) {
      const result = await runJob('correction', stub.baseUrl, correctionInput);
      assert.equal(result.errors, undefined, JSON.stringify(result));
      assert.deepEqual(result.data, { status: 'already_submitted', requestId: REQUEST_ID });
      assertClean(result);
    }
    assert.equal(stub.mutationCount(), 0);
    assert.equal(stub.requests.some(request => request.url.includes('/actions/')), false);
    const replays = stub.requests.filter(request => request.method === 'POST');
    assert.equal(replays.length, 2);
    assert.ok(replays.every(request => request.headers['idempotency-key'] === 'correction:correction-001'));
    for (const request of replays) assert.deepEqual(JSON.parse(request.body).data, correctionData(correctionInput));
  } finally { await stub.close(); }
});
