// Explicit integration check against an installed CLI and exact local adaptor.
// No network installation or hosted OpenFn instance is used during execution.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DurableInbox } from '../src/inbox.js';
import { runOnce } from '../src/worker.js';

if (!process.env.OPENFN_BINARY || !process.env.OPENFN_COMMON_PATH) {
  throw new Error('Set OPENFN_BINARY and OPENFN_COMMON_PATH to installed CLI and common adaptor paths');
}
const directory = await mkdtemp(join(tmpdir(), 'registry-real-cli-'));
const path = join(directory, 'inbox.sqlite');
let inbox = new DurableInbox(path);
try {
  const job = join(directory, 'job.js');
  const success = `fn(state => {
    if (state.data.data.values.reference !== 'SYNTHETIC-ONLY' || !state.eventEffectId) {
      throw new Error('invalid handoff');
    }
    return state;
  });`;
  await writeFile(job, success);
  const envelope = { event: { source: 'urn:synthetic:cli-proof', id: '1' },
    data: { values: { reference: 'SYNTHETIC-ONLY' } } };
  const config = { inboxPath: path, binary: resolve(process.env.OPENFN_BINARY), timeoutMs: 20000,
    workflows: { notify: { job,
      adaptor: `@openfn/language-common=${resolve(process.env.OPENFN_COMMON_PATH)}` } } };
  const id = inbox.accept(envelope, 'notify');
  await runOnce(inbox, config);
  assert.equal(inbox.status()[0].status, 'succeeded');
  inbox.close();
  inbox = new DurableInbox(path);
  assert.equal(inbox.accept(envelope, 'notify'), id);
  assert.equal(await runOnce(inbox, config), false);
  await writeFile(job, `fn(() => { throw new Error('SYNTHETIC_EXPECTED_FAILURE'); });`);
  inbox.accept({ ...envelope, event: { ...envelope.event, id: '2' } }, 'notify');
  await runOnce(inbox, config);
  assert.equal(inbox.status()[1].status, 'pending');
  await writeFile(job, success);
  await new Promise(resolveRetry => setTimeout(resolveRetry, 1100));
  await runOnce(inbox, config);
  assert.equal(inbox.status()[1].status, 'succeeded');
  assert.equal((await readdir(directory)).some(file => file.startsWith('attempt-')), false);
  console.log('PASS: real CLI success, restart/replay, zero-exit workflow failure, retry and transient cleanup');
} finally {
  inbox.close();
  await rm(directory, { recursive: true, force: true });
}
