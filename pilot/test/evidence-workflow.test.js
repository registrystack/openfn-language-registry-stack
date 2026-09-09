import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import compile from '@openfn/compiler';
import run from '@openfn/runtime';
import { projectDocument } from '../lightning/project.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const bindings = {
  accessProfile: 'pilot', createFarmOperation: 'create', createCorrectionOperation: 'correct',
  requirement: 'farm-registered', registeredConcept: 'urn:example:concept:registered',
};
const revision = `sha256:${'a'.repeat(64)}`;
const subjectBinding = `urn:evidence:subject:v1_${randomBytes(32).toString('base64url')}`;
const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
const spec = {
  requirement: 'urn:example:requirement:farm-registered', purpose: 'registration-check',
  audience: 'urn:example:openfn', evidenceType: 'urn:example:evidence-type:registered',
  issuedBy: 'urn:example:agricultural-registry', providedBy: 'urn:example:evidence',
};
const envelope = () => ({
  event: { specversion: '1.0', source: 'urn:registrystack:registry:agricultural-holdings:instance:pilot',
    id: '22222222-2222-4222-8222-222222222222', type: 'registry.record.committed',
    time: '2026-01-01T00:00:00Z', dataschema: 'urn:example:committed-event' },
  delivery: { generation: 3, attempt: 2, time: '2026-09-09T00:00:00Z', idempotencyKey: `sha256:${'c'.repeat(64)}` },
  data: { entity: 'farm', recordId: '11111111-1111-4111-8111-111111111111', revision: 7,
    trigger: 'patched', packageRevision: `sha256:${'b'.repeat(64)}`,
    values: { 'local-identifier': 'synthetic-farm-selector' } },
});

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const kid = createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest('base64url');
  return { privateKey, jwks: { keys: [{ ...jwk, kid, alg: 'ES256' }] },
    privateJwk: { ...privateKey.export({ format: 'jwk' }), kid, alg: 'ES256' }, kid };
}

async function fixture(outcome = 'true') {
  const key = keyPair();
  const clientKey = keyPair();
  const directory = mkdtempSync(resolve(tmpdir(), 'openfn-pilot-evidence-'));
  const requests = [];
  let origin;
  const json = (res, value, status = 200, mediaType = 'application/json') => {
    res.writeHead(status, { 'content-type': mediaType, traceparent: `00-${traceId}-00f067aa0ba902b7-01` });
    res.end(JSON.stringify(value));
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ path: req.url, body, authorization: req.headers.authorization });
      if (req.url === '/.well-known/oauth-protected-resource') return json(res, {
        resource: origin, authorization_servers: [origin], jwks_uri: `${origin}/.well-known/evidence/jwks.json`, bearer_methods_supported: ['header'],
      });
      if (req.url === '/.well-known/oauth-authorization-server') return json(res, {
        issuer: origin, token_endpoint: `${origin}/token`, grant_types_supported: ['client_credentials'], token_endpoint_auth_methods_supported: ['private_key_jwt'],
      });
      if (req.url === '/.well-known/evidence/jwks.json') return json(res, key.jwks, 200, 'application/jwk-set+json');
      if (req.url === '/token') return json(res, { access_token: 'synthetic-evidence-token', token_type: 'Bearer', expires_in: 300 });
      if (req.url === '/v1/evidence-definitions') return json(res, {
        schema: 'registry.evidence-definitions/v1', assuranceProfile: 'local', audience: spec.audience, issuedBy: spec.issuedBy, providedBy: spec.providedBy,
        definitions: [{ handle: bindings.requirement, requirement: spec.requirement, configurationRevision: revision,
          kind: 'criterion', evidenceType: spec.evidenceType, purpose: spec.purpose, responseFormats: ['signed-jws'],
          referenceFrameworks: ['urn:example:framework:registration'],
          subjects: [{ role: 'farm', cardinality: 'one', selector: { profile: 'farm-id', valueOrigin: 'request',
            fields: [{ type: 'string', name: 'local-identifier', minimumBytes: 1, maximumBytes: 200 }] } }],
          concepts: [{ handle: 'registered', concept: bindings.registeredConcept, required: true, form: 'boolean' }] }],
      });
      if (req.url === '/updates') return json(res, { status: 'applied', revision: JSON.parse(body).revision });
      if (req.url === '/v1/evidence') {
        if (outcome === 'unavailable') return json(res, {
          type: 'https://id.registrystack.org/problems/registry-evidence/evidence/unavailable',
          title: 'Evidence could not be produced', status: 422,
          detail: 'evidence could not be produced for this request', code: 'evidence.unavailable', traceId,
        }, 422, 'application/problem+json');
        const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
        const assertion = { schema: 'registry.assertion-evidence/v1', assuranceProfile: 'local', subjectBinding: 'audience-scoped',
          requestNonce: JSON.parse(body).requestNonce, id: 'urn:example:assertion:current-observation', type: 'Evidence',
          supportsRequirement: spec.requirement, isConformantTo: spec.evidenceType, issuedBy: spec.issuedBy, providedBy: spec.providedBy,
          issuedAt: now, observedAt: now, validUntil: new Date(Date.now() + 60_000).toISOString().replace(/\.\d+Z$/, 'Z'),
          purpose: spec.purpose, audience: spec.audience, configurationRevision: revision,
          subjects: [{ role: 'farm', binding: subjectBinding }],
          supportedValues: outcome === 'missing-value' ? [] : [{ providesValueFor: bindings.registeredConcept, value: outcome !== 'false' }],
        };
        const protectedPart = Buffer.from(JSON.stringify({ alg: 'ES256', kid: key.kid, typ: 'evidence+jws', cty: 'application/evidence+json' })).toString('base64url');
        const payload = Buffer.from(JSON.stringify(assertion)).toString('base64url');
        const signature = sign('sha256', Buffer.from(`${protectedPart}.${payload}`), { key: key.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
        return json(res, { protected: protectedPart, payload, signature }, 200, 'application/jose+json');
      }
      json(res, {}, 404);
    });
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const profilePath = resolve(directory, 'client.json');
  writeFileSync(profilePath, JSON.stringify({ schema: 'registry.evidence-client-profile/v1', baseUrl: origin,
    clientId: 'openfn-pilot', privateKey: { source: 'file', path: 'unused.jwk' },
    trust: { type: 'local-loopback-discovery' }, contracts: { type: 'published' } }), { mode: 0o600 });
  return { requests, destinationConfiguration: { baseUrl: origin, apiKey: 'synthetic-destination-key' }, configuration: { evidence: { profilePath, privateKeyJwk: clientKey.privateJwk } },
    close: async () => { await new Promise(done => server.close(done)); rmSync(directory, { recursive: true, force: true }); } };
}

async function executeEvidence(configuration, data, destinationConfiguration) {
  const workflow = projectDocument(bindings).workflows.find(workflow => workflow.name === 'Agriculture committed');
  const job = workflow.jobs.find(job => job.name === 'verify-registration');
  const edge = workflow.edges.find(edge => edge.source_job_id === job.id);
  assert.equal(edge.condition_type, 'on_job_success');
  // Lightning injects operation imports from the selected adaptor. Keep the
  // exact stored job body here so missing common reexports fail as in a worker.
  const { code } = compile(job.body, {
    'add-imports': { adaptors: [{ name: '@openfn/language-registry-evidence', exportAll: true }] },
  });
  assert.match(code, /import \{[^}]*fn[^}]*\} from ["']@openfn\/language-registry-evidence["']/);
  assert.doesNotMatch(code, /from ["']@openfn\/language-common["']/);
  const destination = destinationConfiguration
    ? compile(workflow.jobs.find(job => job.name === 'record-update').body, {
      'add-imports': { adaptors: [{ name: '@openfn/language-http', exportAll: true }] },
    }).code
    : compile(`import { fn } from '@openfn/language-common'; fn(state => ({...state, destinationReached: true}));`).code;
  return run({ workflow: { steps: [
    { id: 'verify', expression: code, next: { destination: edge.condition_type } },
    { id: 'destination', expression: destination, configuration: destinationConfiguration },
  ], start: 'verify' }, options: { start: 'verify' } }, { configuration, data }, {
    linker: { modules: { '@openfn/language-common': { path: resolve(root, 'node_modules/@openfn/language-common') },
      '@openfn/language-registry-evidence': { path: resolve(root, 'packages/registry-evidence') },
      '@openfn/language-http': { path: resolve(root, 'node_modules/@openfn/language-http') } },
      cacheKey: `pilot-evidence-${Date.now()}-${Math.random()}` },
  });
}

test('committed workflow emits only event identity/revision and verified current registration', async () => {
  const service = await fixture();
  try {
    const input = envelope();
    const result = await executeEvidence(service.configuration, input);
    assert.equal(result.errors, undefined);
    assert.equal(result.destinationReached, true);
    assert.deepEqual(Object.keys(result.integration).sort(), ['committedRevision', 'deliveryGeneration', 'eventId', 'eventSource', 'evidenceObservedAt', 'evidenceTraceId']);
    assert.equal(result.integration.committedRevision, 7);
    assert.equal(result.integration.deliveryGeneration, 3);
    assert.equal(result.integration.eventSource, input.event.source);
    assert.equal(result.integration.eventId, input.event.id);
    assert.equal(result.integration.evidenceTraceId, traceId);
    assert.ok(Date.parse(result.integration.evidenceObservedAt) > Date.parse(input.event.time));
    for (const forbidden of ['jws', 'assertion', 'privateKeyJwk', 'subject_continuity', 'requestNonce']) {
      assert.equal(JSON.stringify(result).includes(forbidden), false);
    }
    assert.deepEqual(result.data, { source: input.event.source, eventId: input.event.id, effect: 'record-sync',
      recordId: input.data.recordId, revision: 7, values: { registered: true } });
    assert.equal(JSON.stringify(result).includes('synthetic-farm-selector'), false);
    assert.equal(JSON.stringify(result).includes('synthetic-evidence-token'), false);
    assert.equal(JSON.stringify(result).includes(revision), false);
    assert.equal('configuration' in result, false);
    const requests = service.requests.filter(request => request.path === '/v1/evidence');
    assert.equal(requests.length, 1);
    assert.deepEqual(JSON.parse(requests[0].body).subjects, [{ role: 'farm', selector: { profile: 'farm-id', values: { 'local-identifier': 'synthetic-farm-selector' } } }]);
  } finally { await service.close(); }
});

for (const outcome of ['false', 'unavailable', 'missing-value']) {
  test(`${outcome} evidence never reaches destination success`, async () => {
    const service = await fixture(outcome);
    try {
      const result = await executeEvidence(service.configuration, envelope());
      assert.ok(result.errors?.verify);
      assert.equal(result.destinationReached, undefined);
      assert.equal(result.data.effect, undefined);
      assert.equal('configuration' in result, false);
      assert.equal(service.requests.filter(request => request.path === '/v1/evidence').length, 1);
    } finally { await service.close(); }
  });
}

test('missing event metadata, selector, or revision refuses before Evidence I/O', async () => {
  const service = await fixture();
  try {
    for (const mutate of [input => { delete input.event.id; }, input => { delete input.data.values['local-identifier']; }, input => { input.data.revision = undefined; }, input => { input.delivery.generation = undefined; }]) {
      const input = envelope(); mutate(input);
      const result = await executeEvidence(service.configuration, input);
      assert.ok(result.errors?.verify);
      assert.equal(result.destinationReached, undefined);
    }
    assert.equal(service.requests.length, 0);
  } finally { await service.close(); }
});


test('destination job preserves integration metadata without adding it to the HTTP payload', async () => {
  const service = await fixture();
  try {
    const input = envelope();
    const result = await executeEvidence(service.configuration, input, service.destinationConfiguration);
    assert.equal(result.errors, undefined);
    assert.deepEqual(result.data, { status: 'applied', revision: 7 });
    assert.equal(result.integration.committedRevision, 7);
    assert.equal(result.integration.deliveryGeneration, 3);
    assert.equal(result.integration.eventId, input.event.id);
    assert.equal(result.integration.eventSource, input.event.source);
    assert.equal(result.integration.evidenceTraceId, traceId);
    assert.ok(Date.parse(result.integration.evidenceObservedAt) > Date.parse(input.event.time));
    const updates = service.requests.filter(request => request.path === '/updates');
    assert.equal(updates.length, 1);
    assert.deepEqual(JSON.parse(updates[0].body), { source: input.event.source, eventId: input.event.id, effect: 'record-sync', recordId: input.data.recordId, revision: 7, values: { registered: true } });
    for (const forbidden of ['jws', 'assertion', 'privateKeyJwk', 'synthetic-destination-key', 'synthetic-farm-selector']) {
      assert.equal(JSON.stringify(result).includes(forbidden), false);
    }
  } finally { await service.close(); }
});
