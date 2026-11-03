/**
 * harness/canaries.mjs — 2.72.0 (b): must-fail canaries for the game's own checks.
 *
 * The harness's own gates are each shown to fail when broken (qa/selftest.mjs ends "every required gate was shown to
 * fail when broken"); a game's checks had nothing like it, and an outside review found 4 checks that stayed green
 * whatever they were given. A check in <game>/studio.gates.json may declare a canary, input built to make it fail:
 *
 *   "canary": "<command>"         a command that runs the check on something broken (exit 0 = the check didn't fail)
 *   "canary": "<path>"            a fixture file or folder in the repo: the check runs on it, through its "focus"
 *                                 command with {files}, else with the path appended when its command clearly runs
 *                                 vitest, jest or node --test (harness/train-focus.mjs focusCommand); the run also gets
 *                                 STUDIO_CANARY=<absolute path> for a script that reads it
 *
 *   npm run gates -- --canaries [--json]     runs every check's canary (also the nightly slow tier, after its run)
 *
 * Each check is reported as proven (its canary made it fail), silently green (its canary passed: a
 * gate.silently_green event, a line in the digest and, through the workaround queue (harness/workaround.mjs), one task in
 * studio/HARNESS-TASKS.md), unproven (no canary, or a fixture its command can't take) or broken (the canary itself
 * couldn't run: not found, killed, timed out). Report only: it never runs in a verify and never blocks a landing; the
 * command exits 1 when a check is silently green, so a scheduled run shows red.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, emitEvent } from './event.mjs';

const DAY = 86400000;

/** Is the canary a fixture path in the repo (else it is a command)? */
export function canaryKind(canary, root = REPO_ROOT) {
  const c = String(canary || '').trim();
  if (!c) return null;
  if (!/\s/.test(c) && fs.existsSync(path.join(root, c))) return 'fixture';
  return 'command';
}

/** Run one check's canary: { id, status: proven|silent|unproven|broken, why, cmd }. */
export function runCanary(g, { root = REPO_ROOT, env = process.env, focusCommand = null, gateEnv = (e) => e } = {}) {
  if (!g.canary) return { id: g.id, status: 'unproven', why: 'no "canary" declared in studio.gates.json' };
  const kind = canaryKind(g.canary, root);
  let cmd = g.canary;
  const extra = { STUDIO_CANARY: '1' };
  if (kind === 'fixture') {
    const fc = focusCommand ? focusCommand(g, [g.canary]) : { why: 'no focus helper' };
    if (!fc.cmd) return { id: g.id, status: 'unproven', why: `the fixture ${g.canary} can't be passed to it: ${fc.why}; declare a command canary instead` };
    cmd = fc.cmd;
    extra.STUDIO_CANARY = path.join(root, g.canary);
  }
  const ms = Number(env.STUDIO_GAME_GATE_TIMEOUT_MS || 600000);
  const r = spawnSync(cmd, { cwd: root, shell: true, encoding: 'utf8', env: { ...gateEnv({ ...env, CI: 'true' }), ...extra }, timeout: ms, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  const tail = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 240);
  if (r.error?.code === 'ETIMEDOUT' || (r.status === null && r.signal)) return { id: g.id, kind, cmd, status: 'broken', why: `the canary ${r.signal ? `was killed (${r.signal})` : 'timed out'} after ${Math.round(ms / 1000)} s: no proof either way` };
  if (r.error || r.status === 126 || r.status === 127) return { id: g.id, kind, cmd, status: 'broken', why: `the canary couldn't run (${r.error?.code || `exit ${r.status}`}${tail ? `: ${tail}` : ''})` };
  if (r.status !== 0) return { id: g.id, kind, cmd, status: 'proven', why: `it fails on its canary (exit ${r.status})` };
  return { id: g.id, kind, cmd, status: 'silent', why: `it stays green on its canary ${kind === 'fixture' ? `fixture ${g.canary}` : `(${String(g.canary).slice(0, 120)})`}: it can't fail as it is${tail ? ` (last output: ${tail})` : ''}` };
}

/** Run every game check's canary and report: { game, rows, counts } (rows empty with `none` when there is no studio game). */
export async function runCanaries({ root = REPO_ROOT, env = process.env, log = (m) => console.log(m), record = true } = {}) {
  const gg = await import('./game-gates.mjs');
  const game = await gg.studioGame();
  if (!game?.root) { log('[canaries] no studio game with its own checks (the harness gates prove themselves in qa/selftest.mjs)'); return { game: null, rows: [], counts: {}, none: true }; }
  const { focusCommand } = await import('./train-focus.mjs');
  const { gateEnv } = await import('./gate-env.mjs');
  const rows = gg.declaredGates(game).map((g) => runCanary(g, { root, env, focusCommand, gateEnv }));
  const counts = { proven: 0, silent: 0, unproven: 0, broken: 0 };
  for (const r of rows) counts[r.status] += 1;
  const word = { proven: 'PROVEN', silent: 'SILENTLY GREEN', unproven: 'UNPROVEN', broken: 'BROKEN CANARY' };
  for (const r of rows) log(`[canaries] ${word[r.status]} ${r.id}: ${r.why}`);
  log(`[canaries] ${game.name}: ${counts.proven} proven, ${counts.silent} silently green, ${counts.unproven} unproven, ${counts.broken} with a broken canary (report only; never blocks a landing)`);
  if (!record) return { game: game.name, rows, counts };
  try { emitEvent({ type: 'gate.canaries', agent: env.STUDIO_LOCK_OWNER || 'canaries', status: counts.silent ? 'warn' : 'ok', msg: `canaries for ${game.name}: ${counts.proven} proven, ${counts.silent} silently green${counts.silent ? ` (${rows.filter((r) => r.status === 'silent').map((r) => r.id).join(', ')})` : ''}, ${counts.unproven} unproven, ${counts.broken} broken`.slice(0, 500), meta: { game: game.name, counts, rows: rows.map((r) => ({ id: r.id, status: r.status })) } }); } catch {}
  const day = new Date().toISOString().slice(0, 10);
  for (const r of rows.filter((x) => x.status === 'silent')) {
    try { emitEvent({ type: 'gate.silently_green', agent: 'canaries', to: 'producer', status: 'warn', msg: `${r.id} is silently green: ${r.why}`.slice(0, 500), meta: { game: game.name, gate: r.id, canary: r.cmd } }); } catch {}
    try {
      const w = await import('./workaround.mjs');
      w.recordWorkaround({ what: `the game check ${r.id} stays green on its must-fail canary`, why: 'a check that passes on input built to make it fail checks nothing (silently green): fix the check, not the canary', cmd: 'npm run gates -- --canaries', by: 'canaries', detected: true, kind: 'canary', evidence: [r.why], key: `canary:${game.name}:${r.id}:${day}` });
    } catch (err) { log(`[canaries] note: the harness task for ${r.id} couldn't be recorded (${err.message})`); }
  }
  return { game: game.name, rows, counts };
}

/** `npm run gates -- --canaries [--json]` (scripts/run-gates.mjs): exit 1 when a check is silently green. */
export async function canariesCli(argv = [], { root = REPO_ROOT, env = process.env } = {}) {
  const json = argv.includes('--json');
  const res = await runCanaries({ root, env, log: json ? () => {} : (m) => console.log(m) });
  if (json) console.log(JSON.stringify(res));
  return res.counts?.silent ? 1 : 0;
}

/** The digest's line: the newest canary run in the last day, or ''. */
export function canaryDigestLine(events = [], now = Date.now()) {
  const e = events.filter((x) => x.type === 'gate.canaries' && (Date.parse(x.ts) || 0) >= now - DAY).pop();
  if (!e) return '';
  const c = e.meta?.counts || {};
  const silent = (e.meta?.rows || []).filter((r) => r.status === 'silent').map((r) => r.id);
  return `Canaries${e.meta?.game ? ` (${e.meta.game})` : ''}: ${c.proven || 0} proven, ${c.silent || 0} silently green${silent.length ? ` (${silent.join(', ')}: they can't fail; a harness task is open)` : ''}, ${c.unproven || 0} unproven${c.broken ? `, ${c.broken} broken canar${c.broken === 1 ? 'y' : 'ies'}` : ''} (npm run gates -- --canaries).`;
}
