#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, statSync } from 'node:fs';

const GENERATED = '/config/evidence-client/generated.json';
const CA_BUNDLE = '/run/pilot-ca.pem';
const IDENTIFIER = 'SYNTHETIC-DIRECT-SMOKE-001';
const MISSING_IDENTIFIER = 'SYNTHETIC-DIRECT-SMOKE-MISSING';

const require = createRequire('/opt/registry-adaptors/package.json');
const { EvidenceClient, EvidenceClientError } = require('@registrystack/client').evidence;
const clientPackage = require('/opt/registry-adaptors/node_modules/@registrystack/client/package.json');

assert.equal(clientPackage.version, '0.45.0');
assert.equal(process.env.SSL_CERT_FILE, undefined, 'explicit client proof must not inherit SSL_CERT_FILE');
assert.equal(process.env.NODE_EXTRA_CA_CERTS, undefined, 'explicit client proof must not inherit NODE_EXTRA_CA_CERTS');
assert.equal(statSync(GENERATED).mode & 0o777, 0o600, 'generated client binding must remain owner-only');

const generated = JSON.parse(readFileSync(GENERATED, 'utf8'));
assert.equal(generated.schema, 'synthetic-agriculture-evidence-client/v1');
const configuration = generated?.evidence?.configuration?.evidence;
const requestTemplate = generated?.evidence?.request;
assert.ok(configuration && requestTemplate, 'generated explicit Evidence binding is incomplete');
const mountedCa = readFileSync(CA_BUNDLE, 'utf8');
assert.equal(configuration.trustedRootCertificates, mountedCa, 'Evidence service CA is not the pinned pilot CA');
assert.equal(
  configuration.token?.privateKeyJwt?.trustedRootCertificates,
  mountedCa,
  'token endpoint CA is not the pinned pilot CA',
);

const client = new EvidenceClient(configuration);

function requestFor(identifier) {
  const request = structuredClone(requestTemplate);
  assert.equal(request.subjects.length, 1);
  assert.deepEqual(request.subjects[0].selectorValues, {
    'local-identifier': { valueFrom: 'data.values.local-identifier' },
  });
  request.subjects[0].selectorValues = { 'local-identifier': identifier };
  return request;
}

// Constructor and prepare are deliberately available as an offline image gate.
// The default acceptance continues through token exchange, request and verify.
if (process.argv.includes('--construct-only')) {
  client.prepare(requestFor(IDENTIFIER));
  console.log(JSON.stringify({ verified: 'explicit-evidence-client-construction', sdk: clientPackage.version }));
  process.exit(0);
}

const prepared = client.prepare(requestFor(IDENTIFIER));
const raw = await client.send(prepared);
const verified = client.verify(prepared, raw);
assert.ok(Buffer.isBuffer(raw.body) && raw.body.length > 0, 'Evidence returned no signed response');
assert.deepEqual(verified.evidence.supportedValues, [{
  providesValueFor: 'urn:example:concept:holding-registered:registered',
  value: true,
}]);
assert.equal(verified.pinnedSubjectExpectations.length, 1);
assert.equal(verified.pinnedSubjectExpectations[0].role, 'subject');
const minimized = JSON.stringify(verified.evidence);
assert.equal(minimized.includes(IDENTIFIER), false, 'signed assertion disclosed the source identifier');
assert.equal(minimized.includes('SYNTHETIC-PRIVATE-NAME-CANARY'), false, 'signed assertion disclosed a private source field');

const missing = client.prepare(requestFor(MISSING_IDENTIFIER));
let unavailable;
try {
  await client.send(missing);
} catch (error) {
  unavailable = error;
}
assert.ok(unavailable instanceof EvidenceClientError, 'missing source did not return a native Evidence error');
assert.equal(unavailable.kind, 'not-available', 'missing source was not mapped to Evidence unavailability');

console.log(JSON.stringify({
  verified: 'native-explicit-evidence-send-and-verify',
  assurance: requestTemplate.expectedAssuranceProfile,
  unavailable: unavailable.kind,
  sdk: clientPackage.version,
}));
