/**
 * harness/engine-gates.mjs — 2.90: two land runs at once. engines.<x>.gates names a second gate copy (its own land command,
 * folder and gate worktree; the existing keys are the first gate). Off by default; `npm run task -- train parallel on|off
 * --engine <x> --by <name>` switches it (the Line Producer may), .studio/train/<x>-parallel.json records who and when.
 * When it is on, a second gate is configured, the land script honours STUDIO_LAND_PROBE and the machine admits two engine
 * land runs, the train's search after a red runs two steps by name at once, one per gate; neither lands anything.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { emitEvent } from './event.mjs';
import { readJson, writeAtomic } from './fsafe.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE_KEYS = ['land', 'landMany', 'cwd', 'gateWorktree', 'folder'];
const parallelFile = (root, engine) => path.join(root, '.studio', 'train', `${engine}-parallel.json`);

/** Gate k's config (1: the engine's own keys; 2: engines.<x>.gates[0] over them), or null when gate k is not configured. */
export function gateConfig(cfg = {}, k = 1) {
  if (k <= 1) return cfg;
  const g = Array.isArray(cfg?.gates) ? cfg.gates[k - 2] : null;
  if (!g || typeof g !== 'object' || typeof g.land !== 'string' || !g.land.trim()) return null;
  const own = Object.fromEntries(GATE_KEYS.filter((x) => typeof g[x] === 'string' && g[x].trim()).map((x) => [x, g[x].trim()]));
  return { ...cfg, ...own, gates: undefined };
}

/** Is a second gate usable: { ok, why }. It must have its own land command and its own gate worktree or folder. */
export function secondGate(cfg = {}) {
  const g2 = gateConfig(cfg, 2);
  if (!g2) return { ok: false, why: 'no second gate is configured (studio/game.json engines.<x>.gates)' };
  const same = (k) => (g2[k] || '') === (cfg[k] || '');
  if (same('gateWorktree') && same('cwd')) return { ok: false, why: 'the second gate has the same gate worktree and folder as the first: it needs its own copy' };
  return { ok: true, why: '' };
}

/** Who switched two land runs at once on or off: { on, by?, at?, why? } (off when nothing is recorded). */
export function parallelState(root, engine) {
  const j = readJson(parallelFile(root, engine));
  return j && typeof j === 'object' ? { on: j.on === true, by: j.by || '?', at: j.at || null, why: j.why || '' } : { on: false, by: null, at: null, why: '' };
}

/**
 * May the train use the second gate now? { ok, why }. on: the switch; probeOk: the land script honours STUDIO_LAND_PROBE
 * (unity-train.mjs probeHonoured); admit: { slots, freeGb, needGb } from the machine budget (heavy.mjs).
 */
export function parallelUse({ state, cfg = {}, probeOk = false, admit = null, env = process.env } = {}) {
  if (!state?.on) return { ok: false, why: 'two land runs at once are off (npm run task -- train parallel on --engine <x> --by <name>)' };
  const g = secondGate(cfg);
  if (!g.ok) return g;
  if (!probeOk) return { ok: false, why: 'the land script has not shown it honours STUDIO_LAND_PROBE=1 (or that was revoked): a second run could land, so one gate is used' };
  if (String(env.STUDIO_HEAVY_HELD || '').trim()) return { ok: false, why: 'this train runs inside another machine:heavy hold: a second run would not get its own admission' };
  if (admit && !(admit.slots >= 2)) return { ok: false, why: `the machine admits ${admit.slots} engine land run(s) at once (STUDIO_ENGINE_SLOTS, STUDIO_HEAVY_SLOTS, and for Unity STUDIO_HEAVY_MAX_UNITY)` };
  if (admit && Number.isFinite(admit.freeGb) && Number.isFinite(admit.needGb) && admit.freeGb < admit.needGb) return { ok: false, why: `free RAM ${admit.freeGb} GB is under the ${admit.needGb} GB two land runs need` };
  return { ok: true, why: '' };
}

/** `train status`: one line on two land runs at once. */
export function parallelLine(root, engine, use) {
  const st = parallelState(root, engine);
  const said = st.at ? ` (by ${st.by} at ${String(st.at).slice(0, 16)}${st.why ? `: ${st.why}` : ''})` : '';
  if (!st.on) return `Two land runs at once: off${said}; npm run task -- train parallel on --engine ${engine} --by <name> turns it on`;
  return `Two land runs at once: on${said}; ${use.ok ? 'the next red search uses both gates' : `not used now: ${use.why}`}`;
}

/** The Line Producer's facts for the switch, in one line. */
export function parallelBrief({ engine, state, gate2, waiting, lastRed, freeGb, needGb, slots }) {
  return `two land runs at once: ${state.on ? 'on' : 'off'}; second gate ${gate2.ok ? 'configured' : `not usable (${gate2.why})`}; ${waiting} branch(es) wait; last train ${lastRed === null ? 'none yet' : lastRed ? 'red' : 'green'}; free RAM ${Number.isFinite(freeGb) ? `${freeGb} GB` : 'unknown'} against ${Number.isFinite(needGb) ? `${needGb} GB` : 'unknown'} for two runs, ${slots} engine slot(s); npm run task -- train parallel on|off --engine ${engine} --by line-producer`;
}

/**
 * `train parallel on|off --engine <x> --by <name> [--why "…"]`: who may is who may switch the automatic start
 * (engine-train-control.mjs mayControl), and the Line Producer (by its name or its role). { ok, message }.
 */
export async function setEngineParallel(root, { engine, on, by = '', why = '', env = process.env, emit = emitEvent, now = Date.now() } = {}) {
  const who = String(by || '').trim().slice(0, 60);
  if (!who) return { ok: false, message: `Say who switches it: npm run task -- train parallel ${on ? 'on' : 'off'} --engine ${engine} --by <name>.` };
  const ctl = await import('./engine-train-control.mjs');
  const pm = await import('./permission.mjs');
  const role = pm.actorOf({ env, root }).role;
  const lp = role === 'line-producer' && pm.permittedSetter(who);
  const may = lp ? { ok: true } : await ctl.mayControl({ by: who, env, root, what: 'switch two land runs at once' });
  if (!may.ok) return { ok: false, message: `Two land runs at once were not changed. ${may.why}` };
  const reason = String(why || '').trim().slice(0, 300);
  const at = new Date(now).toISOString();
  fs.mkdirSync(path.dirname(parallelFile(root, engine)), { recursive: true });
  writeAtomic(parallelFile(root, engine), `${JSON.stringify({ on, engine, by: who, at, why: reason }, null, 2)}\n`);
  try { emit({ type: `task.train.${engine}.parallel_${on ? 'on' : 'off'}`, agent: who, to: 'producer', track: `engine:${engine}`, status: 'ok', msg: `${who} turned two ${engine} land runs at once ${on ? 'on' : 'off'}${reason ? `: ${reason}` : ''}`.slice(0, 600), meta: { engine, on, by: who, why: reason || null } }); } catch {}
  return { ok: true, message: on ? `Two ${engine} land runs at once are on: when a second gate is configured, the land script honours STUDIO_LAND_PROBE and the machine admits two runs, the search after a red runs two steps by name at once (npm run task -- train status --engine ${engine} says whether it is used).` : `Two ${engine} land runs at once are off: the train uses one gate.` };
}

/**
 * One land run on gate k in its own process (harness/unity-gate.mjs --json --gate k, args: --branch b or --branches b), so two can run at once and each takes
 * its own machine:heavy admission. Resolves to the gate's result, or { status: 'error', why } when it gave none.
 */
export function runGateChild({ root, engine, gate, args = [], env, timeoutMs = 0 }) {
  return new Promise((resolve) => {
    let outText = '';
    const child = spawn(process.execPath, [path.join(HERE, 'unity-gate.mjs'), '--json', '--engine', engine, ...args, '--gate', String(gate)], { cwd: root, env, windowsHide: true });
    const timer = timeoutMs > 0 ? setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs) : null;
    child.stdout.on('data', (d) => { outText += d; if (outText.length > 4 * 1024 * 1024) outText = outText.slice(-1024 * 1024); });
    child.stderr.on('data', () => {});
    child.on('error', (e) => { if (timer) clearTimeout(timer); resolve({ status: 'error', why: `gate ${gate} could not start: ${e.message}` }); });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      const l = outText.trim().split('\n').filter((x) => x.startsWith('{')).pop();
      try { resolve({ ...JSON.parse(l), gate }); } catch { resolve({ status: 'error', gate, why: `gate ${gate} gave no result (exit ${code ?? signal ?? '?'})` }); }
    });
  });
}
