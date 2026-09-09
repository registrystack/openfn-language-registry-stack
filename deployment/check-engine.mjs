// Exercise the released engine's child-process handshake, including its empty
// child environment, under the image's configured runtime identity.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import createEngine from '/app/packages/engine-multi/dist/index.js';

const repoDir = await mkdtemp(join(tmpdir(), 'pilot-engine-gate-'));
const timeout = setTimeout(() => {
  console.error('Released worker engine did not initialize within 20 seconds.');
  process.exit(1);
}, 20_000);
let engine;
try {
  engine = await createEngine({
    repoDir, memoryLimitMb: 500, maxWorkers: 2,
    workerValidationTimeout: 5000, workerValidationRetries: 1,
  });
  console.log(JSON.stringify({ verified: 'released-worker-engine-startup', uid: process.getuid(), gid: process.getgid() }));
} finally {
  if (engine) await engine.destroy();
  clearTimeout(timeout);
  await rm(repoDir, { recursive: true, force: true });
}
