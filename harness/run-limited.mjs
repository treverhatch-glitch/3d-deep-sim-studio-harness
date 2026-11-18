/**
 * Run a studio command with a time limit and end the WHOLE tree when the time is up (P-360). spawnSync's timeout ends
 * only the shell on Windows; the compiler or editor below it kept running.
 *   node harness/run-limited.mjs <ms> -- <command...>   exits with the command's code; 124 after the time limit
 *   runLimitedSync(command, { timeoutMs, ...spawnSyncOptions })   a spawnSync that reports a time-out the way spawnSync does
 * Node built-ins only, so it loads fast and alone.
 */
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUN_LIMITED = fileURLToPath(import.meta.url);
const MARK = '[run-limited] ended after';

export function runLimitedSync(command, { timeoutMs, ...options } = {}) {
  if (!(Number(timeoutMs) > 0)) return spawnSync(command, { shell: true, ...options, windowsHide: true });
  const { shell, timeout, ...rest } = options;
  const r = spawnSync(process.execPath, [RUN_LIMITED, String(timeoutMs), '--', command], { ...rest, timeout: timeoutMs + 60000, windowsHide: true });
  const hit = (r.status === 124 && (r.stderr == null || String(r.stderr).includes(MARK))) || r.error?.code === 'ETIMEDOUT';
  if (hit) Object.assign(r, { error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), signal: 'SIGTERM', status: null });
  return r;
}

function run(argv) {
  const ms = Number(argv[0]);
  const command = argv.slice(argv.indexOf('--') + 1).join(' ');
  const win = process.platform === 'win32';
  const child = spawn(command, { shell: true, stdio: 'inherit', detached: !win, windowsHide: true });
  // Ends the command's whole tree, then calls `then`. POSIX: the process group, SIGTERM then SIGKILL after 3 s.
  let ending = false;
  const stop = (then) => {
    ending = true;
    if (win) { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); then(); return; }
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
    setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } then(); }, 3000);
  };
  const timer = setTimeout(() => stop(() => { console.error(`${MARK} ${Math.round(ms / 600) / 100} min: the time limit`); process.exit(124); }), ms);
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { clearTimeout(timer); stop(() => process.exit(128 + os.constants.signals[sig])); });
  child.on('error', (e) => { console.error(`[run-limited] could not run the command: ${e.code || e.message}`); process.exit(127); });
  child.on('exit', (code, signal) => { if (ending) return; clearTimeout(timer); process.exit(code ?? 128 + (os.constants.signals[signal] || 1)); });
}

if (process.argv[1] && path.resolve(process.argv[1]) === RUN_LIMITED) run(process.argv.slice(2));
