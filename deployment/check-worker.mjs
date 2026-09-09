// Executes the generated Lightning job bodies with the released worker's exact
// compiler autoinjection and runtime linker. No live Registry Stack is needed.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { projectDocument } from './pilot-project.mjs';

const require = createRequire('/opt/registry-adaptors/package.json');
const client = require('@registrystack/client');
assert.equal(typeof client.evidence.EvidenceClient, 'function');
new client.breg.BaseRegistryClient({ baseUrl: 'http://127.0.0.1:8090' });
assert.equal(JSON.parse(readFileSync('/opt/registry-adaptors/node_modules/@registrystack/client/package.json')).version, '0.27.0');
assert.ok(process.report.getReport().header.glibcVersionRuntime, 'worker must use glibc');
const { default: compile, preloadAdaptorExports } = await import('/app/packages/compiler/dist/index.js');
const { default: run } = await import('/app/packages/runtime/dist/index.js');
const paths = {
  '@openfn/language-registry-breg': '/opt/registry-adaptors/packages/registry-breg',
  '@openfn/language-registry-evidence': '/opt/registry-adaptors/packages/registry-evidence',
  '@openfn/language-http': '/opt/registry-adaptors/packages/http',
};
const linker = Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, { path }]));

async function executeJob(job, input) {
  const name = job.adaptor.slice(0, job.adaptor.lastIndexOf('@'));
  // Matches engine-multi/src/worker/thread/compile.ts in ws-worker v1.29.0.
  // No explicit common import is added: each chosen adaptor must export the
  // actual helpers the Lightning job uses, including fn and execute.
  const exports = await preloadAdaptorExports(paths[name]);
  const { code } = compile(job.body, {
    name: job.name,
    'add-imports': { adaptors: [{ name, exports, exportAll: true }] },
  });
  assert.ok(code.includes(name), `compiler did not inject ${name}`);
  return run({
    workflow: { steps: [{ id: job.id, name: job.name, expression: code, linker }], start: job.id },
    options: { start: job.id },
  }, input, {
    strict: false,
    linker: { repo: '/tmp/pilot-compile-gate', modules: linker, cacheKey: `pilot-${job.id}-${process.pid}` },
  });
}

const document = projectDocument({
  accessProfile: 'openfn-service',
  createFarmOperation: 'records.farm.create',
  createCorrectionOperation: 'records.name-correction.create',
  requirement: 'urn:example:requirement:holding-registered:v1',
  registeredConcept: 'urn:example:concept:holding-registered:registered',
});
assert.equal(document.workflows.length, 3);
const jobs = document.workflows.flatMap(workflow => workflow.jobs);
assert.equal(jobs.length, 4);
for (const job of jobs.filter(job => !job.adaptor.startsWith('@openfn/language-http'))) {
  const result = await executeJob(job, { data: {}, configuration: { fixture: 'synthetic-test-value' } });
  // These exact bodies validate before any registry call. Reaching their own
  // validation proves the full injected module graph linked and evaluated.
  const expected = job.name === 'verify-registration'
    ? /A committed registry event with identity, revision, and selector is required/
    : /A stable submissionId is required/;
  assert.match(JSON.stringify(result.errors), expected, `generated job ${job.name} did not reach its input validation`);
  assert.equal('configuration' in result, false);
}

// Execute the exact HTTP destination body against a controlled loopback server.
// This tests its injected post/fn exports and its request options, without any
// external call or pilot destination side effect.
let received = 0;
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  assert.equal(req.url, '/updates');
  assert.equal(req.method, 'POST');
  assert.equal(req.headers['x-destination-key'], 'synthetic-destination-key');
  assert.deepEqual(body, { revision: 1, values: { registered: true } });
  received += 1;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 'accepted', revision: 1 }));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
try {
  const result = await executeJob(jobs.find(job => job.name === 'record-update'), {
    data: { revision: 1, values: { registered: true } },
    configuration: { baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'synthetic-destination-key' },
  });
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  assert.equal(received, 1);
  assert.deepEqual(result.data, { status: 'accepted', revision: 1 });
  assert.equal('configuration' in result, false);
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

const composed = await executeJob({
  id: 'composed-operation-boundary', name: 'composed-operation-boundary', adaptor: '@openfn/language-registry-breg@local',
  body: `fn(state => ({...state, data: {first: !!state.configuration.fixture}}));\nfn(state => ({...state, data: {...state.data, second: !!state.configuration.fixture}}));`,
}, { data: {}, configuration: { fixture: 'synthetic-test-value' } });
assert.equal(composed.errors, undefined, JSON.stringify(composed.errors));
assert.deepEqual(composed.data, { first: true, second: true });
assert.equal('configuration' in composed, false);
console.log(JSON.stringify({ verified: 'generated-lightning-jobs-and-native-adaptors', workflows: 3, jobBodies: 4, node: process.version, architecture: process.arch, glibc: process.report.getReport().header.glibcVersionRuntime }));
