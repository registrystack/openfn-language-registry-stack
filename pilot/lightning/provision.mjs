import { mkdir, readFile, open, rename, link, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes, generateKeyPairSync, createPublicKey, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { projectDocument, projectId, triggerIds } from './project.mjs';

// Publish complete owner-only bytes. A failed write never truncates a checkpoint.
export async function privateFile(path, value, exclusive = false) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(value);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (exclusive) await link(temporary, path);
    else await rename(temporary, path);
  } finally {
    await handle?.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function optionalText(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return undefined; }
}

function envFields(text) {
  return Object.fromEntries(text.trim().split('\n').map(line => {
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error('Existing pilot environment file is invalid');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

async function prepareEnvironment(files, secrets) {
  const checkpoint = join(secrets, 'environment.json');
  let saved = await optionalText(checkpoint);
  if (saved === undefined) {
    const lightning = await optionalText(join(files, 'lightning.env'));
    const postgres = await optionalText(join(files, 'postgres.env'));
    const worker = await optionalText(join(files, 'worker.env'));
    if (!lightning && worker) throw new Error('Existing worker keys have no matching Lightning environment; restore lightning.env before preparing');
    let lightningFields;
    let databasePassword;
    let keys;
    let shared;
    if (lightning) {
      lightningFields = envFields(lightning);
      const url = new URL(lightningFields.DATABASE_URL);
      if (url.hostname !== 'lightning-db' || url.username !== 'lightning' || url.pathname !== '/lightning') {
        throw new Error('Existing Lightning database binding does not match this pilot');
      }
      databasePassword = decodeURIComponent(url.password);
      shared = lightningFields.WORKER_SECRET;
      if (!databasePassword || !shared || !lightningFields.WORKER_RUNS_PRIVATE_KEY) {
        throw new Error('Existing Lightning environment is incomplete; restore it before preparing');
      }
      const privateKey = Buffer.from(lightningFields.WORKER_RUNS_PRIVATE_KEY, 'base64');
      keys = {publicKey: createPublicKey(privateKey).export({type: 'spki', format: 'pem'})};
    } else {
      databasePassword = postgres ? envFields(postgres).POSTGRES_PASSWORD : randomBytes(32).toString('hex');
      if (!databasePassword || !/^[a-zA-Z0-9_-]+$/.test(databasePassword)) throw new Error('Existing pilot database password cannot be safely retained');
      shared = randomBytes(32).toString('hex');
      keys = generateKeyPairSync('rsa', {modulusLength: 2048,
        privateKeyEncoding: {type: 'pkcs8', format: 'pem'}, publicKeyEncoding: {type: 'spki', format: 'pem'}});
    }
    if (postgres && envFields(postgres).POSTGRES_PASSWORD !== databasePassword) {
      throw new Error('Existing pilot database environments disagree; no credentials were replaced');
    }
    const publicKey = Buffer.from(keys.publicKey).toString('base64');
    if (worker) {
      const fields = envFields(worker);
      if (fields.WORKER_SECRET !== shared || fields.WORKER_LIGHTNING_PUBLIC_KEY !== publicKey) {
        throw new Error('Existing pilot worker keys disagree; no keys were replaced');
      }
    }
    const environment = {
      'postgres.env': postgres ?? `POSTGRES_USER=lightning\nPOSTGRES_DB=lightning\nPOSTGRES_PASSWORD=${databasePassword}\n`,
      'lightning.env': lightning ?? [
        `DATABASE_URL=postgresql://lightning:${databasePassword}@lightning-db:5432/lightning`,
        `SECRET_KEY_BASE=${randomBytes(64).toString('base64')}`,
        `PRIMARY_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`,
        `WORKER_RUNS_PRIVATE_KEY=${Buffer.from(keys.privateKey).toString('base64')}`,
        `WORKER_SECRET=${shared}`, 'PHX_SERVER=true', 'LISTEN_ADDRESS=0.0.0.0', 'MAX_DATACLIP_SIZE_MB=1', 'DISABLE_DB_SSL=true',
        'ORIGINS=http://localhost:4000,http://127.0.0.1:4000,http://lightning:4000',
        'WORKER_MAX_RUN_DURATION_SECONDS=60', 'USAGE_TRACKING_ENABLED=false',
      ].join('\n') + '\n',
      'worker.env': worker ?? [
        `WORKER_LIGHTNING_PUBLIC_KEY=${publicKey}`, `WORKER_SECRET=${shared}`,
        'WORKER_CAPACITY=2', 'NODE_OPTIONS=--experimental-vm-modules',
      ].join('\n') + '\n',
    };
    try { await privateFile(checkpoint, JSON.stringify(environment), true); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    saved = await readFile(checkpoint, 'utf8');
  }
  const environment = JSON.parse(saved);
  for (const name of ['postgres.env', 'lightning.env', 'worker.env']) {
    if (typeof environment[name] !== 'string') throw new Error('Pilot environment checkpoint is incomplete');
    const path = join(files, name);
    const current = await optionalText(path);
    if (current !== undefined && current !== environment[name]) {
      throw new Error('Existing pilot environment differs from its retained checkpoint; no keys were replaced');
    }
    if (current === undefined) {
      try { await privateFile(path, environment[name], true); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
  }
}

export async function run(command = 'prepare', runtime = 'pilot/agriculture/.runtime', {
  base = process.env.OPENFN_URL ?? 'http://127.0.0.1:4000', fetchImpl = fetch,
} = {}) {
  runtime = resolve(runtime);
  const secrets = join(runtime, 'openfn', 'secrets');
  await mkdir(secrets, {recursive: true, mode: 0o700});
  const json = async path => JSON.parse(await readFile(path, 'utf8'));
  const fresh = async (name, value) => {
    try { await privateFile(join(secrets, name), value, true); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  };
  if (command === 'prepare') {
    await fresh('operator.json', JSON.stringify({email: 'operator@agriculture.example.invalid',
      first_name: 'Pilot', last_name: 'Operator', password: randomBytes(32).toString('base64url')}));
    await fresh('webhook-api-key', randomBytes(32).toString('hex'));
    await fresh('committed-api-key', randomBytes(32).toString('hex'));
    await fresh('destination-api-key', randomBytes(32).toString('hex'));
    const files = join(runtime, 'openfn');
    await prepareEnvironment(files, secrets);
    await mkdir(join(runtime, 'destination'), {recursive: true, mode: 0o700});
    await privateFile(join(runtime, 'destination', 'api-key'), await readFile(join(secrets, 'destination-api-key')));
    await privateFile(join(runtime, 'bridge', 'openfn-api-key'), await readFile(join(secrets, 'committed-api-key')));
    const bridgeSource = (await readFile(join(runtime, 'bridge', 'expected-source'), 'utf8')).trim();
    await privateFile(join(files, 'bridge.env'), `BREG_EXPECTED_SOURCE=${bridgeSource}\nOPENFN_WEBHOOK_URL=http://lightning:4000/i/${triggerIds.committed}\n`);
    console.log('Pilot-local operator and webhook secret files prepared.');
    return;
  }
  const token = (await readFile(join(secrets, 'api-token'), 'utf8')).trim();
  async function api(path, method = 'GET', body) {
    const response = await fetchImpl(new URL(path, base), {method, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
      ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    if (!response.ok) throw new Error(`OpenFn ${method} ${path} returned HTTP ${response.status}`);
    return response.json();
  }
  const generated = await json(join(runtime, 'workflow-bindings.json'));
  const bindings = {
    accessProfile: generated.breg.accessProfile,
    createFarmOperation: generated.breg.farmCreateOperation,
    createCorrectionOperation: generated.breg.correctionCreateOperation,
    requirement: generated.evidence.requirement,
    registeredConcept: generated.evidence.registeredConcept,
  };
  if (command === 'provision') {
    const empty = projectDocument(bindings);
    // Create the dedicated project before associating credentials; jobs stay disabled.
    const probe = await fetchImpl(new URL(`/api/provision/${projectId}`, base), {
      redirect: 'error', signal: AbortSignal.timeout(5000), headers: {authorization: `Bearer ${token}`},
    });
    if (probe.status === 404) await api('/api/provision', 'POST', {...empty, workflows: []});
    else if (!probe.ok) throw new Error(`Cannot inspect pilot project: HTTP ${probe.status}`);
    let state;
    try { state = await json(join(secrets, 'credentials.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; state = {}; }
    const credentialBodies = {
      breg: await json(join(runtime, 'openfn', 'breg-credential.json')),
      evidence: await json(join(runtime, 'openfn', 'evidence-credential.json')),
      destination: {baseUrl: 'http://destination:8082', apiKey: (await readFile(join(secrets, 'destination-api-key'), 'utf8')).trim()},
    };
    const statePath = join(secrets, 'credentials.json');
    if (state.credentialFormat !== 2) {
      // Legacy body layouts are not inspectable through the metadata API. Keep
      // their associations untouched and select a fresh, checkpointed namespace.
      state = {credentialFormat: 2, previous: state, credentialNames: {}};
      await privateFile(statePath, JSON.stringify(state));
    }
    state.credentialNames ??= {};
    for (const [name, body] of Object.entries(credentialBodies)) {
      if (state[name]) continue;
      if (!state.credentialNames[name]) {
        state.credentialNames[name] = `Agriculture ${name} main ${randomUUID()}`;
        await privateFile(statePath, JSON.stringify(state));
      }
      // Recover a POST which committed but whose response/checkpoint was lost.
      // This pinned API returns metadata only, never credential body values.
      const listed = await api(`/api/credentials?project_id=${projectId}`);
      const matches = listed.credentials.filter(value => value.name === state.credentialNames[name]);
      if (matches.length > 1) throw new Error('Pilot credential metadata is ambiguous; no credentials were replaced');
      let credential = matches[0];
      if (!credential) {
        const result = await api('/api/credentials', 'POST', {name: state.credentialNames[name], schema: 'raw',
          credential_bodies: [{name: 'main', body}], project_credentials: [{project_id: projectId}]});
        credential = result.credential;
      }
      const association = credential.schema === 'raw' && credential.project_credentials.find(value => value.project_id === projectId);
      if (!association) throw new Error('OpenFn did not associate the intended raw credential with the pilot');
      state[name] = association.id;
      await privateFile(statePath, JSON.stringify(state));
    }
    await api('/api/provision', 'POST', projectDocument(bindings, state));
    await privateFile(join(secrets, 'project.json'), JSON.stringify({projectId, triggerIds}));
    console.log('Pilot workflows provisioned with disabled triggers. Attach webhook authentication before enabling.');
  } else if (command === 'enable') {
    const intakeKey = (await readFile(join(secrets, 'webhook-api-key'), 'utf8')).trim();
    const committedKey = (await readFile(join(secrets, 'committed-api-key'), 'utf8')).trim();
    if (!intakeKey || !committedKey || intakeKey === committedKey) {
      throw new Error('Refusing to enable webhooks without distinct intake and committed-event keys');
    }
    // Lightning v2.18.2 authenticates GET /i/* through WebhookAuth, then
    // WebhooksController.check returns 200 without creating a work order.
    // Missing credentials return 401; wrong credentials conceal the route as
    // 404. These checks work while triggers are disabled, unlike POST intake.
    async function check(trigger, key) {
      return fetchImpl(new URL(`/i/${trigger}`, base), {method: 'GET', redirect: 'error',
        signal: AbortSignal.timeout(5000), headers: {accept: 'application/json',
          ...(key === undefined ? {} : {'x-api-key': key})}});
    }
    for (const [kind, trigger] of Object.entries(triggerIds)) {
      if ((await check(trigger)).status !== 401) {
        throw new Error('Refusing to enable a webhook without authentication');
      }
      const ownKey = kind === 'committed' ? committedKey : intakeKey;
      const otherKey = kind === 'committed' ? intakeKey : committedKey;
      if ((await check(trigger, otherKey)).status !== 404) {
        throw new Error('Refusing to enable webhooks whose intake and committed-event authority overlap');
      }
      if ((await check(trigger, ownKey)).status !== 200) {
        throw new Error('Refusing to enable a webhook whose intended key is not accepted');
      }
    }
    const state = await json(join(secrets, 'credentials.json'));
    await api('/api/provision', 'POST', projectDocument(bindings, state, true));
    console.log('Pilot authenticated triggers enabled.');
  } else throw new Error('Expected prepare, provision, or enable');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv[2], process.argv[3]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
