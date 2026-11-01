/**
 * harness/gate-spawn.mjs — 2.65.0: how scripts/run-gates.mjs runs one gate's command, and (Windows) records its shell in
 * the machine:heavy holder's process tree.
 *
 * 2.60.0 fixed orphans for `heavy run` by recording its shell child (harness/heavy.mjs tree.children): on Windows a
 * killed holder's job object takes its direct child (the shell) with it, but the shell's own children (npm, node,
 * vitest workers) break away and live on, still naming the dead shell as their parent. A full verify holds machine:heavy
 * itself and ran every gate with spawnSync, so no gate's shell was ever recorded and its grandchildren escaped the same
 * way. Now, on Windows only, while the run holds the slot, each gate runs with an async spawn whose shell pid (and
 * start identity) goes into the holder's tree.children before the gate's own work starts; `heavy stop` and the next take
 * find what such a shell left running (heavy.mjs holderTree), during the run as well as after it.
 * POSIX is unchanged: spawnSync as before (a full verify there leads a process group of its own: heavyOwnGroup).
 * STUDIO_GATE_SPAWN=recorded takes the Windows way on any OS (how the selftest checks the wiring on Linux).
 * Small and apart from heavy.mjs: run-gates imports it without loading anything else.
 */
import { spawn, spawnSync } from 'node:child_process';
import { spawnedIdentity } from './proc-identity.mjs';

/** Most gate shells one holder records (the oldest are dropped first). */
export const MAX_RECORDED = 64;

/** Add a gate's shell to the holder's tree.children (lk: acquireHeavy's handle). False when nothing was recorded. */
export function recordGateShell(lk, pid, { identity = spawnedIdentity } = {}) {
  if (!lk?.update || !pid) return false;
  return lk.update((cur) => {
    const children = { ...(cur.tree?.children || {}), [pid]: identity(pid, 'cmd') };
    const keys = Object.keys(children);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_RECORDED))) delete children[k];
    return { ...cur, tree: { ...(cur.tree || {}), children } };
  });
}

/**
 * Run one gate's command line through the shell: { status, stdout, stderr, pid, recorded }.
 * compact: capture the output (else inherit the terminal). lk: the machine:heavy handle this run holds, or null.
 * On POSIX, or with no slot held, exactly the old spawnSync. On Windows with a slot: async spawn, the shell recorded.
 */
export async function runGateCommand(command, { cwd, compact = false, lk = null, platform = process.platform, env = process.env, maxBuffer = 256 * 1024 * 1024, spawnFn = spawn, spawnSyncFn = spawnSync, identity = spawnedIdentity } = {}) {
  // STUDIO_GATE_SPAWN=recorded runs the Windows way on any OS (a check of the wiring; POSIX never needs it).
  const recordedWay = platform === 'win32' || /^recorded$/i.test(String(env.STUDIO_GATE_SPAWN || ''));
  if (!recordedWay || !lk?.update) {
    const r = compact ? spawnSyncFn(command, { cwd, shell: true, encoding: 'utf8', maxBuffer, env }) : spawnSyncFn(command, { cwd, shell: true, stdio: 'inherit', env });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', pid: r.pid || null, recorded: false };
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(command, { cwd, shell: true, env, windowsHide: true, stdio: compact ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    } catch (e) {
      resolve({ status: 1, stdout: '', stderr: `could not start the gate: ${e.message}`, pid: null, recorded: false });
      return;
    }
    const recorded = child.pid ? recordGateShell(lk, child.pid, { identity }) : false;
    let stdout = '';
    let stderr = '';
    let size = 0;
    const take = (which) => (d) => {
      size += d.length;
      if (size > maxBuffer) return;
      if (which === 'out') stdout += d; else stderr += d;
    };
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', take('out'));
    child.stderr?.on('data', take('err'));
    child.on('error', (e) => resolve({ status: 1, stdout, stderr: `${stderr}could not run the gate: ${e.message}`, pid: child.pid || null, recorded }));
    child.on('close', (code) => resolve({ status: code === null ? 1 : code, stdout, stderr, pid: child.pid || null, recorded }));
  });
}
