#!/usr/bin/env node
/**
 * harness/state-probe.mjs — 2.72.0 (c): the state probe. A game prints its sim's state digest at a few ticks,
 * headless, and the gate compares them with main's.
 *
 * Goldens catch a changed final hash; they don't say when the run first went another way, and an engine port (a C#
 * sim next to the TS one) has no golden of its own. A game declares a probe in its manifest (<game>/studio.gates.json,
 * the owner's file), and the game's checks (harness/game-gates.mjs) then run it as game:state-probe:
 *
 *   "stateProbe": { "command": "node game/<name>/tools/probe.mjs --ticks {ticks}", "ticks": [0, 100, 1000],
 *                   "baseline": "game/<name>/qa/state-probe.json", "timeoutMin": 10 }
 *
 * The command runs from the checkout's root ({ticks} becomes "0,100,1000") and prints one line per tick:
 * `tick <n> <digest>` (or a JSON line {"tick": n, "digest": "…"}). The baseline (default <game>/qa/state-probe.json) is
 * the digests recorded on main: `node harness/state-probe.mjs record` writes it from this checkout's build.
 *
 *   node harness/state-probe.mjs [check]   the gate (game:state-probe in the game's checks): run the probe on this
 *                                          checkout and compare with the baseline as main has it (git show <main>:<file>)
 *   node harness/state-probe.mjs record    write the baseline from this checkout (commit it; a change needs a
 *                                          Golden-Reason trailer, like a golden)
 *   node harness/state-probe.mjs show      the probe, the baseline on main and this checkout's digests
 *
 * The verdict: the same digests as main's: PASS. Different, and no commit since main carries a Golden-Reason trailer:
 * FAIL with the first differing tick. Different with a Golden-Reason: PASS only when this checkout's baseline file holds
 * the new digests (re-recorded and committed with the change), else FAIL "record it". A probe that fails, times out
 * or leaves a tick out: FAIL. No baseline on main yet: PASS with a note (record one). No probe declared: nothing to do.
 * Main is STUDIO_STATE_PROBE_BASE, else the main checkout's branch (harness/worktree.mjs mainBranch).
 * Engine-agnostic: the digests are strings, so a second engine's probe can later be compared with the same baseline.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from './event.mjs';

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
const fwd = (p) => String(p || '').split(path.sep).join('/');

/** The studio game's folder (game/<name> or web/<name>) from studio/game.json "game" or STUDIO_GAME. */
function gameRoot(root, env = process.env) {
  const name = String(env.STUDIO_GAME || readJson(path.join(root, 'studio', 'game.json'))?.game || '').trim();
  if (!name || !/^[\w.-]+$/.test(name)) return null;
  return ['game', 'web'].map((t) => `${t}/${name}`).find((r) => fs.existsSync(path.join(root, r))) || null;
}

/**
 * The declared probe: { command, ticks, baseline, timeoutMin, manifest } or null (none declared), or
 * { invalid: why, manifest } when it is declared wrong.
 */
export function probeConfig(root = REPO_ROOT, env = process.env) {
  const g = gameRoot(root, env);
  for (const c of g ? [{ file: `${g}/studio.gates.json`, game: g }] : []) {
    const j = readJson(path.join(root, c.file));
    const p = j?.stateProbe;
    if (p === undefined || p === null || p === false) continue;
    if (typeof p !== 'object' || typeof p.command !== 'string' || !p.command.trim()) return { invalid: '"stateProbe" needs a "command" (a string)', manifest: c.file };
    const ticks = Array.isArray(p.ticks) ? p.ticks.map(Number) : [];
    if (!ticks.length || ticks.some((t) => !Number.isInteger(t) || t < 0)) return { invalid: '"stateProbe.ticks" must be a list of whole ticks, e.g. [0, 100, 1000]', manifest: c.file };
    const baseline = fwd(typeof p.baseline === 'string' && p.baseline.trim() ? p.baseline.trim() : `${c.game || 'qa'}/qa/state-probe.json`);
    if (path.isAbsolute(baseline) || baseline.split('/').includes('..')) return { invalid: `"stateProbe.baseline" must be a path inside the checkout (got ${baseline})`, manifest: c.file };
    return { command: p.command.trim(), ticks: [...new Set(ticks)].sort((a, b) => a - b), baseline, timeoutMin: Number(p.timeoutMin) > 0 ? Number(p.timeoutMin) : 10, manifest: c.file };
  }
  return null;
}

/** The digests in a probe's output: { <tick>: digest }. */
export function parseDigests(text) {
  const out = {};
  for (const raw of String(text || '').replace(/\r/g, '').split('\n')) {
    const l = raw.trim();
    if (l.startsWith('{')) {
      try { const j = JSON.parse(l); const d = j.digest ?? j.hash; if (Number.isInteger(j.tick) && d !== undefined && d !== null) out[j.tick] = String(d); } catch { /* not JSON */ }
      continue;
    }
    const m = l.match(/^tick\s*[=:]?\s*(\d+)\s*[:=]?\s+(\S+)$/i);
    if (m) out[Number(m[1])] = m[2];
  }
  return out;
}

/** Run the probe in `cwd`: { ok, digests, problems, out }. */
export function runProbe(cfg, { cwd = REPO_ROOT, env = process.env } = {}) {
  const cmd = cfg.command.replaceAll('{ticks}', cfg.ticks.join(','));
  const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', env: { ...env }, timeout: cfg.timeoutMin * 60000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const digests = parseDigests(r.stdout || '');
  const problems = [];
  if (r.error?.code === 'ETIMEDOUT') problems.push(`the probe timed out after ${cfg.timeoutMin} min (stateProbe.timeoutMin)`);
  else if (r.status !== 0) problems.push(`the probe failed (exit ${r.status}): ${out.trim().split('\n').slice(-4).join(' | ').slice(0, 400) || 'no output'}`);
  const missing = cfg.ticks.filter((t) => digests[t] === undefined);
  if (!problems.length && missing.length) problems.push(`the probe printed no digest for tick(s) ${missing.join(', ')} (one line "tick <n> <digest>" per tick in ${cfg.ticks.join(', ')})`);
  return { ok: problems.length === 0, digests, problems, out };
}

/**
 * Compare two digest maps over ticks: { same, first: { tick, base, now } | null, differing: [ticks], missing: [ticks] }
 * (missing: ticks the baseline has no digest for).
 */
export function compareDigests(base, now, ticks) {
  const differing = [];
  const missing = [];
  for (const t of ticks) {
    if (base?.[t] === undefined) { missing.push(t); continue; }
    if (String(base[t]) !== String(now?.[t])) differing.push(t);
  }
  const t0 = differing[0];
  return { same: !differing.length, first: t0 === undefined ? null : { tick: t0, base: String(base[t0]), now: String(now?.[t0]) }, differing, missing };
}

/** The ref this checkout is compared with. */
export async function baseRef(env = process.env) {
  if (String(env.STUDIO_STATE_PROBE_BASE || '').trim()) return String(env.STUDIO_STATE_PROBE_BASE).trim();
  try { const w = await import('./worktree.mjs'); return w.mainBranch(w.mainRoot()) || 'main'; } catch { return 'main'; }
}

/** The baseline as `ref` has it: { ticks } or null; and the Golden-Reason trailers of the commits since ref. */
export function mainSide(root, ref, baselineRel) {
  const r = git(root, 'show', `${ref}:${baselineRel}`);
  let baseline = null;
  if (r.status === 0) { try { baseline = JSON.parse(r.stdout); } catch { baseline = { invalid: true }; } }
  const mb = git(root, 'merge-base', ref, 'HEAD');
  const since = mb.status === 0 ? mb.stdout.trim() : null;
  const log = since ? git(root, 'log', '--format=%(trailers:key=Golden-Reason,valueonly,separator=%x3B )', `${since}..HEAD`) : null;
  const reasons = log && log.status === 0 ? [...new Set(log.stdout.split('\n').map((s) => s.trim()).filter(Boolean))] : [];
  return { baseline, reasons, refOk: git(root, 'rev-parse', '--verify', '-q', ref).status === 0 };
}

const pretty = (d) => (String(d).length > 16 ? `${String(d).slice(0, 16)}…` : String(d));

/**
 * The verdict (pure): { ok, line, notes: [] }. cfg; now: the digests this checkout printed; main: mainSide();
 * local: this checkout's baseline file ({ ticks } or null); ref: main's name.
 */
function judgeProbe({ cfg, now, main, local, ref = 'main' }) {
  const notes = [];
  if (!main.refOk) return { ok: true, line: `no ${ref} branch to compare with (STUDIO_STATE_PROBE_BASE names one): ${cfg.ticks.length} tick(s) probed, nothing compared`, notes };
  if (!main.baseline || main.baseline.invalid || typeof main.baseline.ticks !== 'object' || !main.baseline.ticks) {
    const bad = Boolean(main.baseline);
    const why = bad ? `${cfg.baseline} on ${ref} is not a baseline (not JSON, or no "ticks")` : `${ref} has no baseline (${cfg.baseline})`;
    return { ok: !bad, line: `${why}: record one from a known-good build (node harness/state-probe.mjs record) and commit it${bad ? '' : '; nothing compared this time'}`, notes };
  }
  const c = compareDigests(main.baseline.ticks, now, cfg.ticks);
  if (c.missing.length) notes.push(`${ref}'s baseline has no digest for tick(s) ${c.missing.join(', ')} (re-record it: node harness/state-probe.mjs record)`);
  if (c.same) return { ok: true, line: `the sim's state matches ${ref}'s at tick(s) ${cfg.ticks.filter((t) => !c.missing.includes(t)).join(', ')}`, notes };
  const where = `first differing tick ${c.first.tick} (${ref} ${pretty(c.first.base)}, this build ${pretty(c.first.now)}; ${c.differing.length} of ${cfg.ticks.length} tick(s) differ: ${c.differing.join(', ')})`;
  if (!main.reasons.length) return { ok: false, line: `the sim's state changed with no Golden-Reason: ${where}. If the change is intended, record the new digests (node harness/state-probe.mjs record) and commit them with a Golden-Reason trailer; if not, the change broke the sim from tick ${c.first.tick} on (node harness/replay.mjs --trace finds the step)`, notes };
  const rec = compareDigests(local?.ticks || {}, now, cfg.ticks);
  if (!rec.same || rec.missing.length) return { ok: false, line: `the sim's state changed (Golden-Reason: ${main.reasons.join('; ').slice(0, 200)}), but ${cfg.baseline} in this checkout doesn't hold the new digests: ${where}. Record them (node harness/state-probe.mjs record) and commit the file with the change`, notes };
  return { ok: true, line: `the sim's state changed on purpose (Golden-Reason: ${main.reasons.join('; ').slice(0, 200)}): ${where}; the new digests are recorded in ${cfg.baseline}`, notes };
}

/** The gate: { ok, skipped, line, notes, problems }. */
export async function checkProbe({ root = REPO_ROOT, env = process.env } = {}) {
  const cfg = probeConfig(root, env);
  if (!cfg) return { ok: true, skipped: true, line: 'no "stateProbe" declared in the game manifest: nothing to compare', notes: [], problems: [] };
  if (cfg.invalid) return { ok: false, line: `${cfg.manifest}: ${cfg.invalid}`, notes: [], problems: [cfg.invalid] };
  const r = runProbe(cfg, { cwd: root, env });
  if (!r.ok) return { ok: false, line: r.problems.join('; '), notes: [], problems: r.problems, cfg };
  const ref = await baseRef(env);
  const main = mainSide(root, ref, cfg.baseline);
  const local = readJson(path.join(root, cfg.baseline));
  return { ...judgeProbe({ cfg, now: r.digests, main, local, ref }), cfg, digests: r.digests };
}

/** Write the baseline from this checkout's build. */
export function recordBaseline({ root = REPO_ROOT, env = process.env } = {}) {
  const cfg = probeConfig(root, env);
  if (!cfg || cfg.invalid) return { ok: false, message: cfg ? `${cfg.manifest}: ${cfg.invalid}` : 'no "stateProbe" declared in the game manifest' };
  const r = runProbe(cfg, { cwd: root, env });
  if (!r.ok) return { ok: false, message: `not recorded: ${r.problems.join('; ')}` };
  const f = path.join(root, cfg.baseline);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `${JSON.stringify({ command: cfg.command, ticks: Object.fromEntries(cfg.ticks.map((t) => [t, r.digests[t]])), recordedAt: new Date().toISOString() }, null, 2)}\n`);
  return { ok: true, message: `recorded ${cfg.ticks.length} digest(s) in ${cfg.baseline}: commit it (a changed baseline needs a Golden-Reason trailer)` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const cmd = process.argv[2] || 'check';
  if (cmd === 'record') {
    const r = recordBaseline();
    (r.ok ? console.log : console.error)(`[state-probe] ${r.ok ? 'PASS' : 'FAIL'} ${r.message}`);
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === 'check' || cmd === 'show') {
    const r = await checkProbe();
    if (cmd === 'show' && r.digests) for (const t of Object.keys(r.digests)) console.log(`[state-probe] tick ${t} ${r.digests[t]}`);
    for (const n of r.notes || []) console.log(`[state-probe] note: ${n}`);
    if (r.skipped) { console.log(`[state-probe] ${r.line}`); process.exit(0); }
    (r.ok ? console.log : console.error)(`[state-probe] ${r.ok ? 'PASS' : 'FAIL'} ${r.line}`);
    process.exit(cmd === 'show' ? 0 : r.ok ? 0 : 1);
  } else {
    console.error('usage: node harness/state-probe.mjs [check | record | show]');
    process.exit(2);
  }
}
