import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { privateFile, run } from '../lightning/provision.mjs';
import { projectId, triggerIds } from '../lightning/project.mjs';

const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agriculture-provision-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const files = join(root, 'openfn');
  const secrets = join(files, 'secrets');
  await mkdir(secrets, {recursive: true});
  await mkdir(join(root, 'bridge'));
  await writeFile(join(root, 'bridge', 'expected-source'), 'urn:synthetic:registry');
  await privateFile(join(secrets, 'api-token'), 'synthetic-test-token');
  await privateFile(join(secrets, 'destination-api-key'), 'synthetic-destination-key');
  await privateFile(join(files, 'breg-credential.json'), JSON.stringify({breg: {synthetic: 'private-breg'}}));
  await privateFile(join(files, 'evidence-credential.json'), JSON.stringify({evidence: {profilePath: '/synthetic/profile.json'}}));
  await privateFile(join(root, 'workflow-bindings.json'), JSON.stringify({
    breg: {accessProfile: 'synthetic', farmCreateOperation: 'records.farm.create', correctionCreateOperation: 'records.name-correction.create'},
    evidence: {requirement: 'holding-registered', registeredConcept: 'registered'},
  }));
  return {root, files, secrets};
}

function remote({loseFirstCreate = false, credentials = []} = {}) {
  const creations = [];
  const provisioned = [];
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    assert.equal(options.headers.authorization, 'Bearer synthetic-test-token');
    if (url.pathname === `/api/provision/${projectId}`) return new Response('{}');
    if (url.pathname === '/api/credentials' && options.method === 'GET') {
      assert.equal(url.searchParams.get('project_id'), projectId);
      return Response.json({credentials});
    }
    if (url.pathname === '/api/credentials' && options.method === 'POST') {
      const body = JSON.parse(options.body);
      assert.equal(body.schema, 'raw');
      assert.deepEqual(Object.keys(body.credential_bodies[0]), ['name', 'body']);
      assert.ok(!credentials.some(value => value.name === body.name), 'must not POST an already-created credential');
      creations.push(body);
      const credential = {id: `credential-${creations.length}`, name: body.name, schema: 'raw',
        project_credentials: [{project_id: projectId, id: `association-${creations.length}`}]};
      credentials.push(credential);
      if (loseFirstCreate) { loseFirstCreate = false; throw new Error('synthetic response lost after commit'); }
      return Response.json({credential}, {status: 201});
    }
    if (url.pathname === '/api/provision' && options.method === 'POST') {
      provisioned.push(JSON.parse(options.body));
      return Response.json({});
    }
    assert.fail(`Unexpected fixture route ${options.method} ${url.pathname}`);
  };
  return {fetchImpl, creations, credentials, provisioned};
}

test('credential creation survives lost POST response and resumes without duplicates', async t => {
  const {root, secrets} = await fixture(t);
  const api = remote({loseFirstCreate: true});
  await assert.rejects(run('provision', root, api), /response lost/);
  const partial = await readJson(join(secrets, 'credentials.json'));
  assert.equal(partial.credentialFormat, 2, 'format must be durable before the first POST');
  assert.ok(partial.credentialNames.breg);
  assert.equal(partial.breg, undefined);
  await run('provision', root, api);
  const completed = await readJson(join(secrets, 'credentials.json'));
  assert.equal(completed.breg, 'association-1');
  assert.equal(api.creations.length, 3);
  assert.equal(api.provisioned.length, 1);
  await run('provision', root, api);
  assert.equal(api.creations.length, 3, 'repeat must preserve selected remote credentials');
});

test('legacy associations remain untouched while replacement format uses a fresh namespace', async t => {
  const {root, secrets} = await fixture(t);
  const legacy = {breg: 'old-association'};
  await privateFile(join(secrets, 'credentials.json'), JSON.stringify(legacy));
  const old = {id: 'old', name: 'Agriculture breg main', schema: 'raw', project_credentials: [{project_id: projectId, id: 'old-association'}]};
  const api = remote({credentials: [old]});
  await run('provision', root, api);
  const completed = await readJson(join(secrets, 'credentials.json'));
  assert.deepEqual(completed.previous, legacy);
  assert.equal(api.credentials[0], old);
  assert.ok(api.creations.every(item => item.name !== old.name));
});

test('prepare restores interrupted environment publication without rotating keys', async t => {
  const {root, files, secrets} = await fixture(t);
  await run('prepare', root);
  const original = await readJson(join(secrets, 'environment.json'));
  await unlink(join(files, 'worker.env'));
  await unlink(join(files, 'lightning.env'));
  await run('prepare', root);
  for (const [name, value] of Object.entries(original)) {
    assert.equal(await readFile(join(files, name), 'utf8'), value);
    assert.equal((await stat(join(files, name))).mode & 0o777, 0o600);
  }
});

test('prepare repairs legacy missing worker env using retained private key and database password', async t => {
  const {root, files, secrets} = await fixture(t);
  await run('prepare', root);
  const original = await readJson(join(secrets, 'environment.json'));
  await unlink(join(secrets, 'environment.json'));
  await unlink(join(files, 'worker.env'));
  await run('prepare', root);
  for (const [name, value] of Object.entries(original)) assert.equal(await readFile(join(files, name), 'utf8'), value);
});

test('prepare refuses conflicting retained env files without replacing them', async t => {
  const {root, files} = await fixture(t);
  await run('prepare', root);
  const changed = 'WORKER_SECRET=synthetic-conflict\n';
  await privateFile(join(files, 'worker.env'), changed);
  await assert.rejects(run('prepare', root), /differs from its retained checkpoint/);
  assert.equal(await readFile(join(files, 'worker.env'), 'utf8'), changed);
});

test('failed checkpoint write preserves prior bytes and removes staging file', async t => {
  const {secrets} = await fixture(t);
  const path = join(secrets, 'checkpoint.json');
  await privateFile(path, '{"complete":true}');
  await assert.rejects(privateFile(path, Symbol('not writable')), TypeError);
  assert.equal(await readFile(path, 'utf8'), '{"complete":true}');
  assert.ok(!(await readdir(secrets)).some(name => name.endsWith('.tmp')));
});

test('partial format-two checkpoint reuses the credential saved before the next request failed', async t => {
  const {root, secrets} = await fixture(t);
  const api = remote();
  let failSecond = true;
  const interrupted = {fetchImpl: async (url, options) => {
    if (new URL(url).pathname === '/api/credentials' && options.method === 'POST' && api.creations.length === 1 && failSecond) {
      failSecond = false;
      throw new Error('synthetic second credential unavailable');
    }
    return api.fetchImpl(url, options);
  }};
  await assert.rejects(run('provision', root, interrupted), /second credential unavailable/);
  const before = await readJson(join(secrets, 'credentials.json'));
  assert.equal(before.credentialFormat, 2);
  assert.equal(before.breg, 'association-1');
  await run('provision', root, api);
  assert.equal(api.creations.length, 3);
  assert.equal((await readJson(join(secrets, 'credentials.json'))).breg, before.breg);
});

test('prepare gives the committed-event bridge a distinct retained key', async t => {
  const {root, secrets} = await fixture(t);
  await privateFile(join(secrets, 'webhook-api-key'), 'synthetic-retained-intake-key');
  await run('prepare', root);
  const intake = await readFile(join(secrets, 'webhook-api-key'), 'utf8');
  const committed = await readFile(join(secrets, 'committed-api-key'), 'utf8');
  assert.equal(intake, 'synthetic-retained-intake-key');
  assert.match(committed, /^[0-9a-f]{64}$/);
  assert.notEqual(committed, intake);
  assert.equal(await readFile(join(root, 'bridge', 'openfn-api-key'), 'utf8'), committed);
  await run('prepare', root);
  assert.equal(await readFile(join(secrets, 'committed-api-key'), 'utf8'), committed);
  assert.equal(await readFile(join(secrets, 'webhook-api-key'), 'utf8'), intake);
});

async function enableFixture(t, unsafeTrigger) {
  const local = await fixture(t);
  await privateFile(join(local.secrets, 'webhook-api-key'), 'synthetic-intake-key');
  await privateFile(join(local.secrets, 'committed-api-key'), 'synthetic-committed-key');
  await privateFile(join(local.secrets, 'credentials.json'), JSON.stringify({credentialFormat: 2}));
  const probes = [];
  let enabled = false;
  const fetchImpl = async (input, options) => {
    const path = new URL(input).pathname;
    if (path.startsWith('/i/')) {
      const trigger = path.slice(3);
      const key = options.headers['x-api-key'];
      assert.equal(options.method, 'GET', 'all auth checks must use the read-only route');
      assert.equal(options.body, undefined, 'no probe can enqueue a work order');
      const ownKey = trigger === triggerIds.committed ? 'synthetic-committed-key' : 'synthetic-intake-key';
      const isOwn = key === ownKey;
      probes.push({trigger, key, isOwn});
      return new Response('{}', {status: key === undefined ? 401 : isOwn ? 200 : trigger === unsafeTrigger ? 200 : 404});
    }
    assert.equal(path, '/api/provision');
    enabled = true;
    const body = JSON.parse(options.body);
    assert.ok(body.workflows.every(workflow => workflow.triggers.every(trigger => trigger.enabled)));
    return Response.json({});
  };
  return {...local, fetchImpl, probes, enabled: () => enabled};
}

test('enable proves anonymous and cross-key rejection before enabling any workflow', async t => {
  const fixture = await enableFixture(t);
  await run('enable', fixture.root, fixture);
  assert.equal(fixture.enabled(), true);
  assert.deepEqual(fixture.probes.filter(probe => !probe.key).map(probe => probe.trigger).sort(), Object.values(triggerIds).sort());
  assert.equal(fixture.probes.filter(probe => probe.key && !probe.isOwn).length, 3);
  assert.equal(fixture.probes.filter(probe => probe.isOwn).length, 3);
});

for (const [name, trigger] of Object.entries(triggerIds)) {
  test(`enable refuses ${name} webhook accepting the other authority's key`, async t => {
    const fixture = await enableFixture(t, trigger);
    await assert.rejects(run('enable', fixture.root, fixture), /authority overlap/);
    assert.equal(fixture.enabled(), false);
  });
}

test('enable refuses missing intended-key access instead of accepting concealed nonexistence', async t => {
  const fixture = await enableFixture(t);
  const fetchImpl = async (url, options) => {
    if (new URL(url).pathname === `/i/${triggerIds.committed}` && options.headers['x-api-key'] === 'synthetic-committed-key') {
      return new Response('{}', {status: 404});
    }
    return fixture.fetchImpl(url, options);
  };
  await assert.rejects(run('enable', fixture.root, {fetchImpl}), /intended key is not accepted/);
  assert.equal(fixture.enabled(), false);
});

test('enable refuses an anonymously accessible check route', async t => {
  const fixture = await enableFixture(t);
  const fetchImpl = async (url, options) => {
    if (new URL(url).pathname.startsWith('/i/') && options.headers['x-api-key'] === undefined) {
      return new Response('{}', {status: 200});
    }
    return fixture.fetchImpl(url, options);
  };
  await assert.rejects(run('enable', fixture.root, {fetchImpl}), /without authentication/);
  assert.equal(fixture.enabled(), false);
});
