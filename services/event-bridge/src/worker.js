import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DurableInbox } from './inbox.js';

export function loadWorkerConfig(env = process.env) {
  try {
    const workflowsPath = resolve(env.OPENFN_WORKFLOWS_FILE);
    const workflows = JSON.parse(readFileSync(workflowsPath, 'utf8'));
    if (!workflows || Array.isArray(workflows) || typeof workflows !== 'object' ||
        !Object.keys(workflows).length || !env.OPENFN_INBOX_PATH) throw new Error();
    for (const [effect, binding] of Object.entries(workflows)) {
      const adaptors = binding?.adaptors ?? (binding?.adaptor ? [binding.adaptor] : []);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(effect) || !binding ||
          typeof binding.job !== 'string' || !binding.job ||
          (binding.adaptor !== undefined && binding.adaptors !== undefined) ||
          !Array.isArray(adaptors) || adaptors.length === 0 ||
          adaptors.some(adaptor => typeof adaptor !== 'string' || !adaptor) ||
          (binding.configurationFile !== undefined && typeof binding.configurationFile !== 'string') ||
          Object.keys(binding).some(key => !['job', 'adaptor', 'adaptors', 'configurationFile'].includes(key))) throw new Error();
      binding.job = resolve(dirname(workflowsPath), binding.job);
      if (binding.configurationFile) binding.configurationFile = resolve(dirname(workflowsPath), binding.configurationFile);
    }
    const timeoutMs = Number(env.OPENFN_JOB_TIMEOUT_MS ?? 60000);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 1800000) throw new Error();
    return { inboxPath: resolve(env.OPENFN_INBOX_PATH), workflows,
      binary: env.OPENFN_BINARY ?? 'openfn', timeoutMs };
  } catch { throw new Error('invalid worker configuration'); }
}

export async function runCli(item, config) {
  const binding = config.workflows[item.effect];
  if (!binding) throw new Error('workflow unavailable');
  const configuration = binding.configurationFile
    ? JSON.parse(readFileSync(binding.configurationFile, 'utf8')) : {};
  const directory = await mkdtemp(join(dirname(config.inboxPath), 'attempt-'));
  try {
    const state = join(directory, 'state.json');
    const output = join(directory, 'output.json');
    await writeFile(state, JSON.stringify({ configuration, data: item.envelope,
      eventEffectId: item.id }), { mode: 0o600 });
    await new Promise((resolveRun, rejectRun) => {
      // Reviewed executable/job/adaptor paths only. Event data never becomes
      // shell syntax, CLI arguments, a job name, or log output.
      const adaptors = binding.adaptors ?? [binding.adaptor];
      const child = spawn(config.binary, [binding.job, ...adaptors.flatMap(adaptor => ['-a', adaptor]),
        '-s', state, '-o', output, '--no-cache-steps',
        '--no-autoinstall', '--no-expand-adaptors', '--repo-dir', join(directory, 'repo'),
        '--timeout', String(config.timeoutMs)],
      { cwd: directory, shell: false, detached: process.platform !== 'win32', stdio: 'ignore' });
      const timer = setTimeout(() => {
        try {
          if (process.platform === 'win32') child.kill('SIGKILL');
          else process.kill(-child.pid, 'SIGKILL');
        } catch { /* Child may have exited before the deadline callback. */ }
      }, config.timeoutMs);
      child.once('error', () => { clearTimeout(timer); rejectRun(new Error('workflow unavailable')); });
      child.once('close', code => {
        clearTimeout(timer);
        code === 0 ? resolveRun() : rejectRun(new Error('workflow failed'));
      });
    });
    // CLI 1.40.1 exits zero for workflow errors and records them in state.errors.
    // A missing, oversized, invalid or failed result must remain retryable.
    if ((await stat(output)).size > 16 * 1024 * 1024) throw new Error('workflow failed');
    const result = JSON.parse(await readFile(output, 'utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result) ||
        (Object.hasOwn(result, 'errors') && (!result.errors || typeof result.errors !== 'object' ||
          Array.isArray(result.errors) || Object.keys(result.errors).length > 0))) {
      throw new Error('workflow failed');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function runOnce(inbox, config, execute = runCli) {
  const item = inbox.claim({ leaseMs: config.timeoutMs + 5000 });
  if (!item) return false;
  try {
    await execute(item, config);
    inbox.complete(item);
  } catch { inbox.fail(item); }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let inbox;
  try {
    const config = loadWorkerConfig();
    inbox = new DurableInbox(config.inboxPath);
    const [command = 'run', id] = process.argv.slice(2);
    if (command === 'status') process.stdout.write(`${JSON.stringify(inbox.status())}\n`);
    else if (command === 'replay' && /^[0-9a-f]{64}$/.test(id ?? '')) {
      if (!inbox.replay(id)) throw new Error('replay unavailable');
      process.stdout.write('queued\n');
    } else if (command === 'once') await runOnce(inbox, config);
    else if (command === 'run') {
      let stopping = false;
      for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; });
      while (!stopping) {
        if (!await runOnce(inbox, config)) await new Promise(resolvePoll => setTimeout(resolvePoll, 500));
      }
    } else throw new Error('invalid worker command');
  } catch { process.stderr.write('worker unavailable\n'); process.exitCode = 1; }
  finally { inbox?.close(); }
}
