#!/usr/bin/env node
/**
 * harness/score.mjs — 2.81: the round scorecard. Fifteen fixed measures of one studio's run, from its logs, re-run every
 * round so two rounds can be compared. A script: no model, no tokens. docs/SCORECARD.md says what each measure means.
 *
 *   npm run score                                   the last 7 days of this studio
 *   npm run score -- --days 8 [--now <ISO>] [--json]
 *   npm run score -- --events <a.jsonl,b.jsonl> [--machine <machine-history.jsonl>]   an exported log (now = its last event)
 *   npm run score -- --record <label> [--note "…"]  also write studio/scores/<label>.json and compare with the last one
 *
 * It measures; it changes nothing in how the studio runs. Hands-free, interventions, cost and reopen come from the
 * autonomy report (harness/autonomy.mjs: who is a person, what an intervention is), attempts from harness/metrics.mjs;
 * the rest is counted here from the event log and the machine samples.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, readRecentEvents } from './event.mjs';

const DAY = 86400000;
const HOUR = 3600000;
const at = (e) => Date.parse(e?.ts) || 0;
const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
const pct = (k, n) => (n > 0 ? r1((100 * k) / n) : null);
const quantile = (xs, p) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const readLines = (file) => { try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };

/** The measures, in the order they print: [id, label, unit, better ('up' | 'down'), target]. Targets are the L3 bar's or the maintainer's (docs/SCORECARD.md). */
export const MEASURES = [
  ['handsFreePct', 'Landed with no person or overseer step', '%', 'up', 80],
  ['hoursBetweenInterventions', 'Supervisor hours per unplanned intervention', 'h', 'up', 8],
  ['overseerStepsPerLanded', 'Outside-overseer steps per landed task', '', 'down', 0.2],
  ['costPerLandedUsd', 'Cost per landed task', '$', 'down', 1.5],
  ['coordinationSpendPct', 'Spend on Producer and Director sessions', '%', 'down', 25],
  ['firstClaimDonePct', 'Done tasks finished on their first claim', '%', 'up', 75],
  ['harnessHandBackPct', 'Attempts handed back for a harness or machine cause', '%', 'down', 5],
  ['laneDropPct', 'Lanes a merge train dropped', '%', 'down', 10],
  ['fullVerifyP50Min', 'Full verify, median (p90 in the note)', 'min', 'down', 8],
  ['leadTimeP50H', 'Task added to done, median (p90 in the note)', 'h', 'down', 2],
  ['landedPerDay', 'Tasks done per supervisor day', '', 'up', 60],
  ['rigIdlePct', 'Machine samples under 25% CPU while the supervisor ran', '%', 'down', 30],
  ['engineLandPassPct', 'Engine land runs that passed (queue wait p90 in the note)', '%', 'up', 60],
  ['stallsPerDay', 'Stalls, dead trains, halts and lost sessions per day', '', 'down', 5],
  ['escapedPct', 'Landed, then reopened or the cause of a bug within 7 days', '%', 'down', 5],
];

/** Count the measures the autonomy report doesn't have. events: sorted, inside the window. machine: [{ at, cpu, ram }]. */
export function countRest(events, { from, now, machine = [] } = {}) {
  const T = (type) => events.filter((e) => e.type === type);
  const out = { notes: {} };
  // Spend by role (what each session's tool reported).
  const ends = T('agent.session.end');
  const usd = (e) => Number(e.meta?.costUsd) || 0;
  const total = ends.reduce((n, e) => n + usd(e), 0);
  out.coordinationSpendPct = pct(ends.filter((e) => /^(producer|director)$/.test(e.meta?.role || '')).reduce((n, e) => n + usd(e), 0), total);
  out.notes.coordinationSpendPct = `$${r1(total)} reported by ${ends.length} session(s)`;
  // Redo: claims per done task.
  const done = T('task.done');
  const claims = {};
  for (const e of T('task.start')) claims[e.task] = (claims[e.task] || 0) + 1;
  const perDone = [...new Set(done.map((e) => e.task))].map((id) => claims[id] || 0).filter(Boolean);
  out.firstClaimDonePct = pct(perDone.filter((n) => n === 1).length, perDone.length);
  out.notes.firstClaimDonePct = perDone.length ? `${r1(perDone.reduce((a, b) => a + b, 0) / perDone.length)} claims per done task` : '';
  // Trains.
  const trains = T('task.train.done');
  const landed = trains.reduce((n, e) => n + (e.meta?.landed || []).length, 0);
  const dropped = trains.reduce((n, e) => n + (e.meta?.dropped || []).length, 0);
  out.laneDropPct = pct(dropped, landed + dropped);
  out.notes.laneDropPct = `${trains.length} train(s): ${landed} lane(s) landed, ${dropped} dropped; ${T('task.train.red_main').length} found main red`;
  // Test time: full verify runs (not scoped, not partial).
  const full = T('gates.run').filter((e) => e.meta?.ms && !e.meta.scoped && !e.meta.partial).map((e) => e.meta.ms / 60000);
  out.fullVerifyP50Min = r1(quantile(full, 0.5));
  out.notes.fullVerifyP50Min = full.length ? `p90 ${r1(quantile(full, 0.9))} min, ${full.length} run(s)` : 'no full verify in the window';
  // Lead time: task added to done.
  const added = new Map(T('task.added').map((e) => [e.task, at(e)]));
  const lead = done.filter((e) => added.has(e.task)).map((e) => (at(e) - added.get(e.task)) / HOUR);
  out.leadTimeP50H = r1(quantile(lead, 0.5));
  out.notes.leadTimeP50H = lead.length ? `p90 ${r1(quantile(lead, 0.9))} h, ${lead.length} task(s)` : '';
  // The rig: samples while the supervisor ran (it takes them).
  const samples = (machine.length ? machine.map((m) => ({ t: Date.parse(m.at), cpu: m.cpu })) : T('machine.sample').map((e) => ({ t: at(e), cpu: e.meta?.cpu }))).filter((s) => s.t >= from && s.t <= now && Number.isFinite(s.cpu));
  out.rigIdlePct = pct(samples.filter((s) => s.cpu < 25).length, samples.length);
  out.notes.rigIdlePct = samples.length ? `mean CPU ${r1(samples.reduce((n, s) => n + s.cpu, 0) / samples.length)}%, over 90% in ${pct(samples.filter((s) => s.cpu > 90).length, samples.length)}% of ${samples.length} sample(s)` : 'no machine samples';
  // Engine lands (Unity, Godot): runs that passed, and how long a queued task waited for its train.
  const lands = T('engine.land');
  out.engineLandPassPct = pct(lands.filter((e) => e.meta?.status === 'pass').length, lands.length);
  const starts = events.filter((e) => /^task\.train\.\w+\.start$/.test(e.type));
  const waits = events.filter((e) => /^task\.train\.\w+\.queued$/.test(e.type)).map((q) => { const s = starts.find((x) => at(x) >= at(q) && (x.meta?.lanes || []).includes(q.task)); return s ? (at(s) - at(q)) / HOUR : null; }).filter((x) => x !== null);
  out.notes.engineLandPassPct = lands.length ? `${lands.length} land run(s); queue wait p90 ${r1(quantile(waits, 0.9)) ?? 'n/a'} h (median ${r1(quantile(waits, 0.5)) ?? 'n/a'} h)` : 'no engine land in the window';
  // Stalls and losses.
  const lost = ends.filter((e) => /process gone/.test(e.meta?.reason || '')).length;
  const stalls = T('session.stall').length + T('task.train.died').length + T('supervisor.halted').length + lost;
  out.stallCount = stalls;
  out.notes.stallsPerDay = `${T('session.stall').length} stalled session(s), ${T('task.train.died').length} dead train(s), ${T('supervisor.halted').length} halt(s), ${lost} session(s) whose process was gone`;
  out.doneCount = done.length;
  return out;
}

/**
 * 2.82: the engine's flow, beside the fifteen measures (it is one engine's queue, not the whole studio). events: sorted,
 * inside the window. { runs, landedLanes, passPct, refusedPct, minutesPerLanded, redMinutesPct, passMedianMin, redMedianMin,
 * waitMin, stages: [{ name, medianMin, runs, failedFirst }], rules: { checks, runs, minutes, refused } } or null (no land run).
 *   minutesPerLanded  every land-run minute (pass, red, refused waits) divided by the lanes that landed: what one landed
 *                     engine task costs the machine
 *   redMinutesPct     the share of those minutes spent in runs that ended red or in a conflict
 *   stages            from the land command's own stage report (unity-gate.mjs landStages), when it gives one
 *   rules             the rules check before the land run (engine-rules.mjs): lanes it refused never cost a land run
 */
export function engineFlow(events) {
  const lands = events.filter((e) => e.type === 'engine.land' && e.meta?.status);
  if (!lands.length) return null;
  const min = (e) => (Number(e.meta?.ms) || 0) / 60000;
  const by = (s) => lands.filter((e) => s.includes(e.meta.status));
  const total = lands.reduce((n, e) => n + min(e), 0);
  const landedLanes = events.filter((e) => /^task\.train\.\w+\.landed$/.test(e.type)).reduce((n, e) => n + (Array.isArray(e.meta?.lanes) ? e.meta.lanes.length : 1), 0) || by(['pass']).length;
  const stageMap = new Map();
  for (const e of lands) {
    const st = Array.isArray(e.meta.stages) ? e.meta.stages : [];
    const firstBad = st.find((x) => !['pass', 'skipped', 'ok'].includes(x.status));
    for (const x of st) {
      const row = stageMap.get(x.name) || { name: x.name, secs: [], failedFirst: 0 };
      if (Number.isFinite(x.seconds)) row.secs.push(x.seconds / 60);
      if (firstBad && firstBad.name === x.name && ['red', 'conflict'].includes(e.meta.status)) row.failedFirst += 1;
      stageMap.set(x.name, row);
    }
  }
  const rules = events.filter((e) => e.type === 'engine.rules');
  return {
    runs: lands.length,
    landedLanes,
    passPct: pct(by(['pass']).length, lands.length),
    refusedPct: pct(by(['refused', 'not-run']).length, lands.length),
    minutesPerLanded: landedLanes ? r1(total / landedLanes) : null,
    redMinutesPct: total > 0 ? r1((100 * by(['red', 'conflict']).reduce((n, e) => n + min(e), 0)) / total) : null,
    passMedianMin: r1(quantile(by(['pass']).map(min), 0.5)),
    redMedianMin: r1(quantile(by(['red', 'conflict']).map(min), 0.5)),
    waitMin: r1(by(['refused', 'not-run']).reduce((n, e) => n + min(e), 0)),
    waitedForRam: by(['refused', 'not-run']).filter((e) => e.meta.infra === 'ram-floor' || /free RAM|waiting for RAM|out of memory/i.test(String(e.msg || ''))).length,
    totalMin: r1(total),
    stages: [...stageMap.values()].map((r) => ({ name: r.name, medianMin: r1(quantile(r.secs, 0.5)), runs: r.secs.length, failedFirst: r.failedFirst })),
    rules: { checks: rules.length, runs: rules.reduce((n, e) => n + (Number(e.meta?.runs) || 0), 0), minutes: r1(rules.reduce((n, e) => n + (Number(e.meta?.ms) || 0), 0) / 60000), refused: rules.reduce((n, e) => n + (Array.isArray(e.meta?.dropped) ? e.meta.dropped.length : 0), 0) },
  };
}

/**
 * 2.82: does the landed work follow the owner's design? events: sorted, the whole log up to the window's end (a task's
 * `task.added` may be older than the window); from: the window's start. A done task is traced when it says what it
 * serves (a Bible pillar or a kept layer: task add --serves), comes from an approved idea, was asked for by the owner
 * (origin dev-asked), or fixes, wires or rescues a task that is traced. { done, tracedPct, devAskedPct, agentProposedPct,
 * byServes: [{ serves, done }], untraced } or null (nothing done in the window). It measures the link, not the quality:
 * a pillar with no landed work, or a rising untraced share, is the Director's and the owner's signal.
 */
export function visionFlow(events, { from = 0 } = {}) {
  const added = new Map();
  for (const e of events) if (e.type === 'task.added' && e.task) added.set(e.task, e.meta || {});
  const done = [...new Set(events.filter((e) => e.type === 'task.done' && e.task && at(e) >= from).map((e) => e.task))];
  if (!done.length) return null;
  const parentOf = (m) => m.causedBy || m.wireOf || m.rescueOf || m.fixOf || null;
  const servesOf = (id, depth = 0) => {
    const m = added.get(id);
    if (!m) return null;
    if (m.serves) return String(m.serves);
    if (m.idea) return `idea:${m.idea}`;
    const p = parentOf(m);
    return p && depth < 4 && p !== id ? servesOf(String(p), depth + 1) : null;
  };
  const norm = (s) => String(s).toLowerCase().replace(/[\s_]+/g, '-');
  const by = new Map();
  let traced = 0;
  let dev = 0;
  let agent = 0;
  let known = 0;
  for (const id of done) {
    const m = added.get(id);
    if (!m) continue;
    known += 1;
    const sv = servesOf(id);
    const asked = m.origin === 'dev-asked';
    if (asked) dev += 1; else if (m.origin === 'agent-proposed') agent += 1;
    if (sv || asked) traced += 1;
    if (sv) by.set(norm(sv), (by.get(norm(sv)) || 0) + 1);
  }
  if (!known) return null;
  return {
    done: known,
    tracedPct: pct(traced, known),
    devAskedPct: pct(dev, known),
    agentProposedPct: pct(agent, known),
    untraced: known - traced,
    byServes: [...by.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12).map(([serves, n]) => ({ serves, done: n })),
  };
}

/** The vision block as printed lines ([] when nothing was done). prev: an earlier record's vision block. */
export function visionText(v, prev = null) {
  if (!v) return [];
  const was = (k) => (prev && Number.isFinite(prev[k]) ? ` (was ${prev[k]}%)` : '');
  return [
    `Design link: ${v.tracedPct}% of ${v.done} done task(s) trace to a pillar, a kept layer, an approved idea or the owner's own ask${was('tracedPct')}; ${v.untraced} do not`,
    `  Asked for by the owner: ${v.devAskedPct}%${was('devAskedPct')}; proposed by agents: ${v.agentProposedPct}%${was('agentProposedPct')}`,
    v.byServes.length ? `  Done work by what it serves: ${v.byServes.map((r) => `${r.serves} ${r.done}`).join(', ')}` : '  No done task says what it serves (task add --serves pillar:<name>)',
  ];
}

/** The engine flow as printed lines ([] when there was no land run). prev: an earlier record's engine block. */
export function engineText(en, prev = null) {
  if (!en) return [];
  const was = (k, unit = '') => (prev && Number.isFinite(prev[k]) ? ` (was ${prev[k]}${unit})` : '');
  const L = [`Engine flow: ${en.runs} land run(s), ${en.landedLanes} lane(s) landed, ${en.totalMin} machine minute(s)`];
  L.push(`  Land-run minutes per landed lane: ${en.minutesPerLanded ?? 'n/a'}${was('minutesPerLanded')}`);
  L.push(`  Land runs that passed: ${en.passPct ?? 'n/a'}%${was('passPct', '%')}; refused or not run: ${en.refusedPct ?? 'n/a'}%${was('refusedPct', '%')} (${en.waitMin} min waiting; ${en.waitedForRam} of them for free memory)`);
  L.push(`  Minutes spent in red runs: ${en.redMinutesPct ?? 'n/a'}%${was('redMinutesPct', '%')}; a passing run takes ${en.passMedianMin ?? 'n/a'} min (median)${was('passMedianMin', ' min')}, a red one ${en.redMedianMin ?? 'n/a'} min`);
  if (en.stages.length) L.push(`  Stages (median minutes; red runs that failed there first): ${en.stages.map((s) => `${s.name} ${s.medianMin ?? 'n/a'} (${s.failedFirst})`).join(', ')}`);
  else L.push('  Stages: the land command reports none (STUDIO_LAND_RESULT, docs/NATIVE-ENGINE.md)');
  L.push(en.rules.checks ? `  Rules check before the land run: ${en.rules.checks} batch(es), ${en.rules.runs} run(s), ${en.rules.minutes} min; ${en.rules.refused} lane(s) refused before they cost a land run` : '  Rules check before the land run: none ran');
  return L;
}

/** The scorecard: { window, values: { id: number|null }, notes: { id: text }, measures }. */
export async function roundScore({ events = null, machine = null, now = null, days = 7, root = REPO_ROOT } = {}) {
  const all = (events || readRecentEvents(400000)).slice().sort((a, b) => at(a) - at(b));
  const end = now ?? (events && all.length ? at(all.at(-1)) : Date.now());
  const from = end - days * DAY;
  const inWin = all.filter((e) => at(e) >= from && at(e) <= end);
  const { autonomyReport } = await import('./autonomy.mjs');
  const { card } = await autonomyReport({ now: end, days, events: all, root });
  const rest = countRest(inWin, { from, now: end, machine: machine || readLines(path.join(STUDIO_STATE_DIR, 'machine-history.jsonl')) });
  const supDays = (card.supervisorHours || 0) / 24;
  const values = {
    handsFreePct: pct(card.handsFree, card.landed),
    hoursBetweenInterventions: card.hoursBetweenInterventions,
    overseerStepsPerLanded: card.landed ? Math.round(((card.orchestrator?.interventions || 0) / card.landed) * 100) / 100 : null,
    costPerLandedUsd: card.cost?.dollarsPerLanded ?? null,
    coordinationSpendPct: rest.coordinationSpendPct,
    firstClaimDonePct: rest.firstClaimDonePct,
    harnessHandBackPct: pct(card.handBacks?.byLabel?.['env-harness'] || 0, card.handBacks?.attempts || 0),
    laneDropPct: rest.laneDropPct,
    fullVerifyP50Min: rest.fullVerifyP50Min,
    leadTimeP50H: rest.leadTimeP50H,
    landedPerDay: supDays > 0 ? r1(rest.doneCount / supDays) : null,
    rigIdlePct: rest.rigIdlePct,
    engineLandPassPct: rest.engineLandPassPct,
    stallsPerDay: supDays > 0 ? r1(rest.stallCount / supDays) : null,
    escapedPct: pct(card.escaped, card.landed),
  };
  const notes = {
    ...rest.notes,
    handsFreePct: `${card.handsFree} of ${card.landed} landed`,
    hoursBetweenInterventions: `${card.interventions?.unplanned ?? 0} unplanned in ${card.supervisorHours} supervisor hour(s)`,
    overseerStepsPerLanded: `${card.orchestrator?.interventions || 0} step(s) by an outside agent`,
    costPerLandedUsd: `${Math.round((card.tokensPerLanded || 0) / 1000)}k tokens per landed task`,
    harnessHandBackPct: `${card.handBacks?.count ?? 0} of ${card.handBacks?.attempts ?? 0} attempt(s) were handed back in all`,
    landedPerDay: `${rest.doneCount} done in ${r1(supDays)} supervisor day(s)`,
    escapedPct: `${card.escaped} of ${card.landed}`,
  };
  return { window: { from: new Date(from).toISOString(), to: new Date(end).toISOString(), days, events: inWin.length }, values, notes, measures: MEASURES.map(([id, label, unit, better, target]) => ({ id, label, unit, better, target })), engine: engineFlow(inWin), vision: visionFlow(all.filter((e) => at(e) <= end), { from }) };
}

/** Does this value meet its target? null when there is no value. */
export const meets = (better, target, v) => (v === null || v === undefined ? null : better === 'up' ? v >= target : v <= target);

/** The printed table; `prev` (an earlier record's values) adds the change since then. */
export function scoreText(score, prev = null, prevEngine = null, prevVision = null) {
  const L = [`Round score, ${score.window.from.slice(0, 10)} to ${score.window.to.slice(0, 10)} (${score.window.days} d, ${score.window.events} events)`];
  let met = 0;
  let known = 0;
  for (const m of score.measures) {
    const v = score.values[m.id];
    const ok = meets(m.better, m.target, v);
    if (ok !== null) { known += 1; if (ok) met += 1; }
    const was = prev?.[m.id];
    const delta = v !== null && Number.isFinite(was) ? ` (was ${was}${m.unit === '$' ? '' : m.unit})` : '';
    L.push(`  ${ok === null ? 'n/a ' : ok ? 'ok  ' : 'MISS'} ${m.label}: ${v === null ? 'n/a' : `${m.unit === '$' ? '$' : ''}${v}${m.unit === '$' ? '' : m.unit}`}${delta}; target ${m.better === 'up' ? 'at least' : 'at most'} ${m.unit === '$' ? '$' : ''}${m.target}${m.unit === '$' ? '' : m.unit}${score.notes[m.id] ? `. ${score.notes[m.id]}` : ''}`);
  }
  L.push(`${met} of ${known} measured targets met${known < score.measures.length ? ` (${score.measures.length - known} not measurable in this window)` : ''}.`);
  L.push(...engineText(score.engine, prevEngine));
  L.push(...visionText(score.vision, prevVision));
  return L.join('\n');
}

const SCORES_DIR = path.join(REPO_ROOT, 'studio', 'scores');
/** The newest record in studio/scores/ (by its window's end), or null. */
export function lastRecord(dir = SCORES_DIR, except = '') {
  let best = null;
  try { for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && x !== except)) { const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (r?.values && (!best || String(r.window?.to) > String(best.window?.to))) best = { ...r, file: f }; } } catch {}
  return best;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
  const files = flag('events') ? String(flag('events')).split(',').map((f) => f.trim()).filter(Boolean) : null;
  const events = files ? files.flatMap(readLines) : null;
  if (files && !events.length) { console.error(`[score] no events in ${files.join(', ')}`); process.exit(1); }
  const score = await roundScore({ events, machine: flag('machine') ? readLines(flag('machine')) : files ? [] : null, now: flag('now') ? Date.parse(flag('now')) : null, days: Number(flag('days')) > 0 ? Number(flag('days')) : 7 });
  const label = flag('record');
  if (label && !/^[\w.-]{1,60}$/.test(label)) { console.error('[score] --record takes a short label (letters, digits, . _ -), e.g. 2.81-baseline'); process.exit(1); }
  const prev = lastRecord(SCORES_DIR, label ? `${label}.json` : '');
  if (label) {
    fs.mkdirSync(SCORES_DIR, { recursive: true });
    fs.writeFileSync(path.join(SCORES_DIR, `${label}.json`), `${JSON.stringify({ label, note: flag('note') || '', recordedAt: new Date().toISOString(), ...score }, null, 2)}\n`);
  }
  if (argv.includes('--json')) console.log(JSON.stringify({ ...score, previous: prev ? { label: prev.label, values: prev.values, engine: prev.engine || null, vision: prev.vision || null } : null }));
  else console.log(`${scoreText(score, prev?.values, prev?.engine || null, prev?.vision || null)}${prev ? `\nCompared with "${prev.label}" (${String(prev.window?.to).slice(0, 10)}).` : ''}${label ? `\nRecorded as studio/scores/${label}.json.` : ''}`);
}
