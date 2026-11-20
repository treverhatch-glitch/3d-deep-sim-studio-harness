/**
 * Run a studio command with a time limit and end the WHOLE tree when the time is up (P-360). spawnSync's timeout ends
 * only the shell on Windows; the compiler or editor below it kept running.
 *   node harness/run-limited.mjs <ms> -- <command...>   exits with the command's code; 124 after the time limit
 *   runLimitedSync(command, { timeoutMs, sample, ...spawnSyncOptions })   a spawnSync that reports a time-out as spawnSync does
 * 2.96 (a): `sample` ({ file, meta, everyMs }, harness/run-cost.mjs runSample) samples the run's tree (run-sampler.mjs,
 * loaded only then). <ms> 0: no time limit. Otherwise Node built-ins only, so it loads fast and alone.
 */
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUN_LIMITED = fileURLToPath(import.meta.url);
const MARK = '[run-limited] ended after';

/** The wrapper's arguments: <ms> [--sample <json>] -- <command>. */
export const limitedArgs = (ms, command, sample = null) => [RUN_LIMITED, String(Math.max(0, Number(ms) || 0)), ...(sample?.file ? ['--sample', JSON.stringify(sample)] : []), '--', command];

export function runLimitedSync(command, { timeoutMs, sample = null, ...options } = {}) {
  if (!(Number(timeoutMs) > 0) && !sample?.file) return spawnSync(command, { shell: true, ...options, windowsHide: true });
  const { shell, timeout, ...rest } = options;
  const r = spawnSync(process.execPath, limitedArgs(timeoutMs, command, sample), { ...rest, ...(Number(timeoutMs) > 0 ? { timeout: timeoutMs + 60000 } : {}), windowsHide: true });
  const hit = (r.status === 124 && (r.stderr == null || String(r.stderr).includes(MARK))) || r.error?.code === 'ETIMEDOUT';
  if (hit) Object.assign(r, { error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), signal: 'SIGTERM', status: null });
  return r;
}

function run(argv) {
  const ms = Number(argv[0]);
  const sep = argv.indexOf('--');
  const command = argv.slice(sep + 1).join(' ');
  const win = process.platform === 'win32';
  let sample = null;
  try { const i = argv.indexOf('--sample'); if (i > 0 && i < sep) sample = JSON.parse(argv[i + 1]); } catch { sample = null; }
  const child = spawn(command, { shell: true, stdio: 'inherit', detached: !win, windowsHide: true });
  // 2.96 (a): a sampler that cannot load or start leaves the run as it was; one that loads after the run ended never starts.
  let sampler = null;
  let ended = false;
  const endSample = (code, signal) => { ended = true; try { sampler?.stop({ code, signal }); } catch { /* the run's result stands */ } sampler = null; };
  if (sample?.file && child.pid) import('./run-sampler.mjs').then((m) => { if (!ended) sampler = m.startSampler({ file: sample.file, meta: sample.meta || {}, rootPid: child.pid, everyMs: Number(sample.everyMs) || 10000, helper: sample.helper || null }); }).catch(() => {});
  // Ends the command's whole tree, then calls `then`. POSIX: the process group, SIGTERM then SIGKILL after 3 s.
  let ending = false;
  const stop = (then) => {
    ending = true;
    endSample(null, 'ended');
    if (win) { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); then(); return; }
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
    setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } then(); }, 3000);
  };
  const timer = ms > 0 ? setTimeout(() => stop(() => { console.error(`${MARK} ${Math.round(ms / 600) / 100} min: the time limit`); process.exit(124); }), ms) : null;
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { clearTimeout(timer); stop(() => process.exit(128 + os.constants.signals[sig])); });
  child.on('error', (e) => { endSample(127, null); console.error(`[run-limited] could not run the command: ${e.code || e.message}`); process.exit(127); });
  child.on('exit', (code, signal) => { if (ending) return; clearTimeout(timer); endSample(code, signal); process.exit(code ?? 128 + (os.constants.signals[signal] || 1)); });
}

if (process.argv[1] && path.resolve(process.argv[1]) === RUN_LIMITED) run(process.argv.slice(2));
