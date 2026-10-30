#!/usr/bin/env node
/**
 * harness/health.mjs — 2.34.0: how well the HARNESS is doing (not the game, not the models), from the event
 * log. A script: no model, no tokens.
 *
 *   npm run harness-health [-- --since 24h|7d|<ISO>] [--json] [--write <folder>]
 *
 * The numbers the Marina run needed and had to dig out by hand:
 *   landings          work that reached the studio's branch (lane.merged, else task.done)
 *   refusals/landing  task done refusals per landing, and the reasons, grouped
 *   harness-caused    the share of hand-backs the harness caused (claim ran out under a running done, the
 *                     main checkout refused a merge, …), which should be near 0
 *   forced, budget    dones forced past a check; tasks stopped by their budget; stalled sessions
 *   verify time       median full verify, scoped vs unscoped (gates.run events, 2.34.0)
 *   done time         median from task done started to landed (task.done.start, 2.34.0)
 *   tokens/landing    weighted tokens of launched sessions plus self-reported usage, per landing; dones by
 *                     builders with no usage at all are counted apart (untracked)
 *   launches skipped  budget stops, over-budget tasks
 * --morning adds what landed and what needs a person: parked tasks (budget, breaker, watchdog), forced work
 * waiting for review, protected changes waiting for the owner's approval, a stopped studio, a red CI on main
 * (when the GitHub CLI is signed in; STUDIO_HEALTH_CI=off skips it).
 * --write puts HEALTH-<date>.md in the folder (STUDIO_RESULTS_DIR works).
 * Targets (a release must not make these worse): refusals per landing ≤ 1.5, harness-caused hand-backs ≤ 5%.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readRecentEvents } from './event.mjs';
import { weightedTokens } from './budget.mjs';
import { harnessCaused } from './busy.mjs';

export const TARGETS = { refusalsPerLanding: 1.5, harnessCausedShare: 0.05 };

const REASONS = [
  ['no code changed', /no code changed/i],
  ['uncommitted files', /uncommitted|commit your work/i],
  ['game checks failed', /failed$|game.?gates|game checks|FAIL game/i],
  ['visual proof missing', /visual|before\/after|capture/i],
  ['verify missing or stale', /verify/i],
  ['merge conflict or branch moved', /changed files you changed|rebase|kept moving|couldn't be added/i],
  ['regression or lesson missing', /regression|lesson/i],
  ['review missing', /review/i],
];
const reasonOf = (msg) => (REASONS.find(([, re]) => re.test(String(msg || ''))) || ['other'])[0];
const median = (xs) => { const a = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q); return a.length ? a[Math.floor((a.length - 1) / 2)] : null; };

export function parseSince(v, now = Date.now()) {
  const m = /^(\d+)\s*([hd])$/.exec(String(v || '24h'));
  if (m) return now - Number(m[1]) * (m[2] === 'd' ? 86400000 : 3600000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : now - 86400000;
}

export function health(events, { since = 0, now = Date.now() } = {}) {
  const evs = events.filter((e) => (Date.parse(e.ts) || 0) >= since && (Date.parse(e.ts) || 0) <= now);
  const merged = evs.filter((e) => e.type === 'lane.merged');
  const doneEv = evs.filter((e) => e.type === 'task.done');
  const landings = merged.length || doneEv.length;
  const refusals = evs.filter((e) => e.type === 'task.not_done');
  const reasons = {};
  for (const r of refusals) reasons[reasonOf(r.msg)] = (reasons[reasonOf(r.msg)] || 0) + 1;
  const paused = evs.filter((e) => e.type === 'task.paused');
  const harnessPaused = paused.filter((e) => harnessCaused(e)).length;
  const gates = evs.filter((e) => e.type === 'gates.run' && !e.meta?.partial);
  const starts = new Map();
  const doneMs = [];
  for (const e of evs) {
    if (e.type === 'task.done.start' && e.task) starts.set(e.task, Date.parse(e.ts));
    if ((e.type === 'lane.merged' || e.type === 'task.done') && starts.has(e.task)) { doneMs.push(Date.parse(e.ts) - starts.get(e.task)); starts.delete(e.task); }
  }
  // Tokens: launched sessions (weighted) plus self-reports. Dones by agents with no usage at all are untracked.
  const sessionTokens = evs.filter((e) => e.type === 'agent.session.end').reduce((s, e) => s + weightedTokens(e), 0);
  const reported = evs.filter((e) => e.type === 'usage.reported').reduce((s, e) => s + (Number(e.tokensIn) || 0) + (Number(e.tokensOut) || 0), 0);
  const metered = new Set(evs.filter((e) => (e.type === 'agent.session.start' || e.type === 'usage.reported') && e.agent).map((e) => e.agent));
  const untrackedDones = doneEv.filter((e) => e.agent && !metered.has(e.agent) && !/^(launcher|watchdog|director|producer)/.test(e.agent)).length;
  const out = {
    since: new Date(since).toISOString(),
    landings,
    refusals: refusals.length,
    refusalsPerLanding: landings ? +(refusals.length / landings).toFixed(2) : null,
    reasons: Object.fromEntries(Object.entries(reasons).sort((a, b) => b[1] - a[1])),
    handBacks: paused.length,
    harnessCaused: harnessPaused,
    harnessCausedShare: paused.length ? +(harnessPaused / paused.length).toFixed(3) : 0,
    forced: evs.filter((e) => e.type === 'task.forced').length,
    budgetStops: evs.filter((e) => e.type === 'task.budget').length,
    stalls: evs.filter((e) => e.type === 'session.stall').length,
    launchesSkipped: evs.filter((e) => e.type === 'launch.skipped').length,
    verifyMedianSec: { scoped: median(gates.filter((g) => g.meta?.scoped).map((g) => g.meta.ms / 1000)), unscoped: median(gates.filter((g) => !g.meta?.scoped).map((g) => g.meta?.ms / 1000)), runs: gates.length },
    doneMedianMin: doneMs.length ? +(median(doneMs) / 60000).toFixed(1) : null,
    tokens: Math.round(sessionTokens + reported),
    tokensPerLanding: landings ? Math.round((sessionTokens + reported) / landings) : null,
    untrackedDones,
    // 2.40.0: the watchdog's own noise (the research pack measured 11-23 watchdog events per finished task),
    // and the 2.36-2.38 signals: checks that ran nothing, whole-game reds, unwired code at done.
    watchdogEvents: evs.filter((e) => e.type === 'watchdog.action').length,
    watchdogPerLanding: landings ? +(evs.filter((e) => e.type === 'watchdog.action').length / landings).toFixed(1) : null,
    silentGreens: evs.filter((e) => e.type === 'gate.silent_green').length,
    wholeRed: evs.filter((e) => e.type === 'whole.red').length,
    wholeEnvironment: evs.filter((e) => e.type === 'whole.environment').length,
    unwired: evs.filter((e) => e.type === 'task.unwired').length,
  };
  out.misses = [];
  if (out.refusalsPerLanding !== null && out.refusalsPerLanding > TARGETS.refusalsPerLanding) out.misses.push(`refusals per landing ${out.refusalsPerLanding} (target ≤ ${TARGETS.refusalsPerLanding})`);
  if (out.harnessCausedShare > TARGETS.harnessCausedShare) out.misses.push(`harness-caused hand-backs ${Math.round(out.harnessCausedShare * 100)}% (target ≤ ${TARGETS.harnessCausedShare * 100}%)`);
  if (untrackedDones) out.misses.push(`${untrackedDones} done(s) by builders with no usage recorded`);
  return out;
}

export function renderHealth(h) {
  const v = h.verifyMedianSec;
  const lines = [
    `# Harness health since ${h.since.slice(0, 16).replace('T', ' ')} UTC`,
    '',
    h.misses.length ? `**Off target:** ${h.misses.join('; ')}.` : '**On target** (refusals per landing, harness-caused hand-backs, usage tracked).',
    '',
    `- Landings: ${h.landings}; refusals: ${h.refusals}${h.refusalsPerLanding !== null ? ` (${h.refusalsPerLanding} per landing)` : ''}`,
    `- Why refused: ${Object.entries(h.reasons).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`,
    `- Hand-backs: ${h.handBacks}, of which the harness caused ${h.harnessCaused} (${Math.round(h.harnessCausedShare * 100)}%)`,
    `- Forced dones: ${h.forced}; stopped by budget: ${h.budgetStops}; stalled sessions: ${h.stalls}; launches skipped: ${h.launchesSkipped}`,
    `- Verify (median): ${v.scoped !== null ? `${Math.round(v.scoped)} s scoped` : 'no scoped runs'}, ${v.unscoped !== null ? `${Math.round(v.unscoped)} s unscoped` : 'no unscoped runs'} (${v.runs} runs); task done to landed: ${h.doneMedianMin !== null ? `${h.doneMedianMin} min` : 'n/a'}`,
    `- Tokens: ${(h.tokens / 1e6).toFixed(2)}M${h.tokensPerLanding !== null ? ` (${(h.tokensPerLanding / 1e6).toFixed(2)}M per landing)` : ''}; dones with no usage recorded: ${h.untrackedDones}`,
    `- Watchdog log lines: ${h.watchdogEvents ?? 0}${h.watchdogPerLanding != null ? ` (${h.watchdogPerLanding} per landing)` : ''}; checks that ran nothing: ${h.silentGreens ?? 0}; whole-game reds: ${h.wholeRed ?? 0} (environment ${h.wholeEnvironment ?? 0}); unwired code noted at done: ${h.unwired ?? 0}`,
  ];
  return `${lines.join('\n')}\n`;
}

/** What landed since, and what is waiting on a person: the second half of the morning report. */
export async function needsYou(events, { since = 0 } = {}) {
  const landed = events.filter((e) => e.type === 'lane.merged' && (Date.parse(e.ts) || 0) >= since).map((e) => e.task).filter(Boolean);
  const out = { landed: [...new Set(landed)], parked: [], rescuing: [], pending: [], protectedChanges: null, stopped: null };
  try {
    const { readHolds } = await import('./task-hold.mjs');
    for (const [id, h] of Object.entries(readHolds())) {
      const p = h?.parked;
      if (!p || p.superseded) continue; // a stuck rescue the next ladder step replaced
      const row = { id, by: p.by, why: String(p.why || '').split('. ')[0].slice(0, 160), shelved: Boolean(p.shelved) };
      // A rescue is working on it (harness/rescue.mjs): reported, but not a person's job yet.
      if (/^T-\d+$/.test(String(p.rescue || ''))) out.rescuing.push({ ...row, rescue: `rescue ${p.rescue} is on it` });
      else if (p.rescue === 'split') out.rescuing.push({ ...row, rescue: 'split into smaller tasks; close it when they land' });
      else out.parked.push(row);
    }
  } catch {}
  try { const { listPending } = await import('./pending-review.mjs'); out.pending = listPending().map((i) => ({ id: i.task, why: String(i.reason || i.missing || '').slice(0, 120) })); } catch {}
  try { const { checkProtected } = await import('./approve.mjs'); const r = checkProtected(); if (r.enforced && !r.ok) out.protectedChanges = r.changes.map((c) => c.path); } catch {}
  try { const { wholeLine } = await import('./whole-game.mjs'); out.whole = wholeLine(); } catch {}
  try { const { readStop } = await import('./task.mjs'); const st = readStop(); if (st) out.stopped = `${st.by}${st.reason ? `: ${st.reason}` : ''}`; } catch {}
  // The main branch's CI on GitHub, when the GitHub CLI is there and signed in (a week of red CI went unseen).
  if (process.env.STUDIO_HEALTH_CI !== 'off') {
    try {
      const r = spawnSync('gh', ['run', 'list', '--branch', 'main', '--workflow', 'ci.yml', '--limit', '1', '--json', 'conclusion,status,headSha,createdAt'], { encoding: 'utf8', timeout: 15000 });
      const run = r.status === 0 ? JSON.parse(r.stdout || '[]')[0] : null;
      if (run) out.ci = { status: run.status, conclusion: run.conclusion, sha: String(run.headSha || '').slice(0, 7), at: run.createdAt };
    } catch {}
  }
  return out;
}

export function renderNeeds(n) {
  const lines = ['', '## Landed', n.landed.length ? n.landed.join(', ') : 'nothing', '', '## Needs you'];
  if (n.stopped) lines.push(`- The studio is stopped (${n.stopped}).`);
  if (n.whole) lines.push(`- ${n.whole}`);
  if (n.ci && n.ci.status === 'completed' && n.ci.conclusion !== 'success') lines.push(`- CI on main is ${n.ci.conclusion} (${n.ci.sha}, ${String(n.ci.at).slice(0, 16).replace('T', ' ')} UTC): nothing new should land until it is green.`);
  for (const p of n.parked) lines.push(p.shelved ? `- ${p.id} is shelved (the studio works around it): ${p.why.replace(/^shelved:\s*/, '')}` : `- ${p.id} is parked by ${p.by}: ${p.why}`);
  for (const p of n.pending) lines.push(`- ${p.id} was forced done and waits for your review: ${p.why}`);
  if (n.protectedChanges?.length) lines.push(`- Protected files changed without your approval: ${n.protectedChanges.join(', ')}`);
  if (lines.at(-1) === '## Needs you') lines.push('nothing');
  if (n.rescuing?.length) lines.push('', '## Being rescued (no action needed)', ...n.rescuing.map((p) => `- ${p.id}: ${p.rescue}`));
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const a = process.argv.slice(2);
  const flag = (n) => (a.includes(n) ? a[a.indexOf(n) + 1] : null);
  const events = readRecentEvents(0);
  const since = parseSince(flag('--since') || '24h');
  const h = health(events, { since });
  const n = a.includes('--morning') ? await needsYou(events, { since }) : null;
  const text = renderHealth(h) + (n ? renderNeeds(n) : '');
  if (a.includes('--json')) console.log(JSON.stringify(n ? { ...h, ...n } : h));
  else process.stdout.write(text);
  const dir = flag('--write') || (a.includes('--write') ? process.env.STUDIO_RESULTS_DIR : null);
  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `HEALTH-${new Date().toISOString().slice(0, 10)}.md`);
    fs.writeFileSync(f, text);
    console.log(`Written: ${f}`);
  }
  process.exit(0);
}
