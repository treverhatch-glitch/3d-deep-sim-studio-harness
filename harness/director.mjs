#!/usr/bin/env node
/**
 * harness/director.mjs — the Director (of Knowledge) keeps the studio on the game the Bible describes.
 *
 *   npm run director -- ping --reason "new tasks for Phase 1" [--from producer]
 *   npm run director -- review [--phase 1]   start a dated review for the Director agent to fill in
 *   npm run director -- drift [--json]       the free drift report (a script, no tokens)
 *   npm run director -- brief                rewrite the Director's brief only
 *   npm run director -- flow [--json]        the flow pass: idle builders, expired claims, refill (2.30h)
 *
 * A ping means: a "Director review" task is queued (or the open one gets the new reason), the
 * Director's brief is written to .studio/briefs/director.md (the docs to read first, the open phase,
 * kept and crossed-out layers, what finished since the last review, the drift report, ideas waiting
 * for a decision), and the Director agent is woken. If STUDIO_DIRECTOR_CMD is set (a launch line from
 * `npm run kickoff -- --role director --agent director-1 --tool …`), the ping starts it, at most once
 * per STUDIO_DIRECTOR_COOLDOWN_MIN (default 60) and under the spend cap. If not, the Producer and the
 * person are told a Director is needed.
 *
 * Pinged: daily by the HUB, by the Producer before it generates tasks, on a phase change, and when
 * an idea is placed and waits for a decision. The Director reviews and edits the Bible; the Producer
 * still creates and assigns every task.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, readRecentEvents, emitEvent } from './event.mjs';
import { dailyCap } from './budget.mjs';
import { parseNextQueue, addTask } from './task.mjs';
import { taskType } from './done-check.mjs';
import { readBible, checkBible, latestReview, crossedLayersIn, readIdeas, LAYERS, REVIEWS_DIR } from './bible.mjs';
import { spendToday } from './route.mjs';
import { effectiveMode, AUTOSTART_OFF } from './mode.mjs';
import { startAgent } from './agent.mjs';
import { flowBrief, flowPass } from './director-flow.mjs';
import { limitsBrief } from './model-limits.mjs';
import { readLastFidelity } from './fidelity.mjs';
import { constraintsBlock } from './learning-edge.mjs';
import { pitfallPartsForRole } from './pitfalls.mjs';
import { untrustedBlock } from './untrusted.mjs';

const BRIEF = path.join(STUDIO_STATE_DIR, 'briefs', 'director.md');
const PHASE_NAMES = { 1: 'early game', 2: 'mid game', 3: 'endgame' };

/** The drift report: where the work and the Bible disagree. Scripts only. */
export function driftReport() {
  const b = readBible();
  if (!b) return { bible: false, items: [{ kind: 'no-bible', msg: 'No Game Bible yet: run npm run intake.' }] };
  const q = parseNextQueue();
  const open = [...q.inProgress, ...q.backlog];
  const events = readRecentEvents(20000);
  const meta = new Map(events.filter((e) => e.type === 'task.added' && e.task).map((e) => [e.task, e.meta || {}]));
  const items = [];
  const builds = open.filter((t) => taskType(t) === 'change');
  for (const t of builds) {
    const m = meta.get(t.id) || {};
    if (!m.prototype && !m.infra && !m.serves && !m.idea && !/^prototype\b/i.test(t.title)) items.push({ kind: 'serves-nothing', task: t.id, msg: `${t.id} serves no pillar, layer or idea: ${t.title}` });
    if (m.phase && m.phase > (b.phase?.open || 1)) items.push({ kind: 'phase-ahead', task: t.id, msg: `${t.id} is Phase ${m.phase} work while Phase ${b.phase?.open || 1} is open` });
  }
  for (const t of open) {
    const crossed = crossedLayersIn(t.title, b);
    if (crossed.length) items.push({ kind: 'crossed-out', task: t.id, msg: `${t.id} touches crossed-out ${crossed.map((l) => l.id).join(', ')}: ${t.title}` });
  }
  const last = (b.phase?.history || []).at(-1);
  const days = Number(process.env.STUDIO_PHASE_DAYS || 14);
  if (b.signed && last && Date.now() - Date.parse(last.at) > days * 86400000) items.push({ kind: 'phase-long', msg: `Phase ${b.phase.open} has been open ${Math.round((Date.now() - Date.parse(last.at)) / 86400000)} days (STUDIO_PHASE_DAYS=${days}). Is it ready, or is it stuck?` });
  const allTasks = [...open, ...q.done];
  for (const l of LAYERS.filter((x) => b.layers?.[x.id]?.answer === 'yes' && b.layers[x.id].phase <= (b.phase?.open || 1))) {
    const touched = allTasks.some((t) => (meta.get(t.id)?.serves || '') === `layer:${l.id}` || l.keywords.some((k) => t.title.toLowerCase().includes(k)));
    if (b.signed && !touched) items.push({ kind: 'layer-idle', msg: `Kept layer ${l.id} (Phase ${b.layers[l.id].phase}) has no work yet` });
  }
  const ideas = readIdeas();
  const waiting = ideas.filter((i) => i.stage === 'placed');
  if (waiting.length) items.push({ kind: 'ideas-waiting', msg: `Ideas waiting for the Director's decision: ${waiting.map((i) => `${i.id} ${i.title}`).join('; ')}` });
  const r = latestReview();
  if (b.signed && (!r || Date.now() - r.at > 36 * 3600000)) items.push({ kind: 'review-stale', msg: r ? `Last Director review is ${Math.round((Date.now() - r.at) / 3600000)} h old` : 'No Director review yet' });
  return { bible: true, signed: Boolean(b.signed), open: b.phase?.open || 0, items };
}

export function writeDirectorBrief(reasons = []) {
  const b = readBible();
  const r = latestReview();
  const since = r ? r.at : 0;
  const finished = readRecentEvents(20000).filter((e) => e.type === 'task.done' && Date.parse(e.ts) > since).slice(-15);
  const drift = driftReport();
  const c = b ? checkBible(b) : null;
  const L = ['# Director brief', '', '> Written by `npm run director`. You guard the Game Bible; the Producer creates and assigns tasks. Read this, then the docs below, then answer.', ''];
  L.push('## Why you were pinged', ...(reasons.length ? reasons.map((x) => `- ${x}`) : ['- Routine check.']), '');
  L.push('## 1. Read first', '- `studio/bible/BIBLE.md` (the game: pitch, pillars, phases, layers)', '- `studio/bible/NOT-DOING.md` (crossed out: never suggest these)', '- `studio/bible/STORYBOARD.md`', '- `studio/PLAN.md` and `studio/VISION_LOCK.md`', r ? `- Your last review: \`${r.file}\` (${r.verdict || 'no verdict'}, Phase ${r.phase || '?'})` : '- No earlier review.', '');
  if (b) {
    L.push('## Where the game is', `- ${b.answers.title || '(untitled)'}: ${b.signed ? `signed; Phase ${b.phase.open} (${PHASE_NAMES[b.phase.open]}) is open` : 'not signed (pre-production)'}`, `- Kept layers: ${c.kept.join(', ') || 'none'}`, `- Crossed out: ${c.crossed.join(', ') || 'none'}`, '');
  }
  L.push('## Finished since your last review', ...(finished.length ? finished.map((e) => `- ${e.task}: ${e.msg}`) : ['- Nothing.']), '');
  L.push('## Drift report (free, from scripts)', ...(drift.items.length ? drift.items.map((i) => `- ${i.msg}`) : ['- Nothing drifting.']), '');
  // 2.61 (the learning edge): confirmed causes and repeated lessons shape how the next work is cut, not only workers' prompts.
  const constraints = constraintsBlock({ for: 'director' });
  if (constraints) L.push(constraints, '');
  const own = untrustedBlock(pitfallPartsForRole('director'));
  if (own) L.push('## Pitfalls for the Director', own.trimEnd(), '');
  // 2.30h: the Director owns the flow (idle builders, expired claims), knows each model's limits, and sees the fidelity score.
  L.push('## The flow (you keep the builders working)', ...flowBrief(), '');
  L.push('## Models in use and their limits', ...limitsBrief(), '');
  const fid = readLastFidelity();
  if (fid?.configured) L.push('## Design fidelity', `- ${fid.passed}/${fid.scored} mechanics of ${fid.reference} present${fid.missing.length ? `; missing: ${fid.missing.join(', ')}` : ''}${fid.unscored.length ? `; no probe yet: ${fid.unscored.join(', ')}` : ''}. Missing ones go back to the builders as tasks (tagged [fidelity:<id>]).`, '');
  L.push('## 2. Answer', '`npm run director -- review` starts a dated file in `studio/bible/reviews/`. Fill in:', '```', `Phase: ${b?.phase?.open || 1}`, 'Verdict: on course | drifting | off course | phase-ready', 'Checked: pillar:<name>, layer:<id>, …', '', '## Findings', '## Stop', '## Next', '- suggested tasks, each with --phase and --serves', '```');
  L.push('', 'You may edit the Bible through `npm run bible` and `npm run idea -- decide`. You may not change a signed pillar or bring back a crossed-out layer; ask the person. Talk to the Producer with `node harness/event.mjs --type agent.ask --agent <you> --to producer --msg "…"` until it has what it needs, then finish your task.');
  fs.mkdirSync(path.dirname(BRIEF), { recursive: true });
  fs.writeFileSync(BRIEF, `${L.join('\n')}\n`);
  return '.studio/briefs/director.md';
}

function maybeStartDirector() {
  const cmd = process.env.STUDIO_DIRECTOR_CMD;
  if (!cmd) {
    // No custom command: the launcher can start one with the Director's (or the studio's) tool and model.
    if (process.env.STUDIO_DIRECTOR_TOOL || process.env.STUDIO_AGENT_TOOL) {
      const r = startAgent({ role: 'director', agent: 'director-1' }, { detach: true });
      if (r.ok) emitEvent({ type: 'director.started', agent: 'director', to: 'producer', msg: `Started director-1 through the launcher (${r.tool}, ${r.model})` });
      return r.ok ? { started: true } : { started: false, why: r.message };
    }
    return { started: false, why: 'no way to start a Director on its own: set STUDIO_DIRECTOR_TOOL (or STUDIO_AGENT_TOOL) and a model in .env, or STUDIO_DIRECTOR_CMD' };
  }
  const coolMin = Number(process.env.STUDIO_DIRECTOR_COOLDOWN_MIN || 60);
  const lastStart = readRecentEvents(5000).filter((e) => e.type === 'director.started').pop();
  if (lastStart && Date.now() - Date.parse(lastStart.ts) < coolMin * 60000) return { started: false, why: `a Director was started ${Math.round((Date.now() - Date.parse(lastStart.ts)) / 60000)} min ago (cooldown ${coolMin} min)` };
  const cap = dailyCap();
  if (cap > 0 && spendToday() >= cap) return { started: false, why: 'the daily spend cap is reached' };
  const log = fs.openSync(path.join(STUDIO_STATE_DIR, 'director-run.log'), 'a');
  const child = spawn(cmd, { cwd: REPO_ROOT, shell: true, detached: true, stdio: ['ignore', log, log], env: { ...process.env } });
  child.unref();
  emitEvent({ type: 'director.started', agent: 'director', to: 'producer', msg: `Started a Director agent (STUDIO_DIRECTOR_CMD); output in .studio/director-run.log` });
  return { started: true };
}

export function pingDirector({ reason = 'Routine check', from = process.env.STUDIO_LOCK_OWNER || 'producer', daily = false } = {}) {
  const q = parseNextQueue();
  let task = [...q.inProgress, ...q.backlog].find((t) => /^director review\b/i.test(t.title));
  if (!task) {
    task = addTask({ title: `Director review: ${reason}`.slice(0, 160), role: 'director', priority: 'P1', agent: from });
    if (task.error) return { ok: false, message: task.message };
  }
  // One open review at a time: later pings add their reason to it instead of queueing more.
  const earlier = readRecentEvents(5000).filter((e) => e.type === 'director.ping' && e.task === task.id).map((e) => e.meta?.reason).filter(Boolean);
  const reasons = [...new Set([...earlier, reason])];
  const brief = writeDirectorBrief(reasons);
  emitEvent({ type: 'director.ping', agent: from, to: 'director', task: task.id, msg: `Director pinged by ${from}: ${reason}`, meta: { reason, daily } });
  // 2.58.0: the routine (daily) ping comes from the watcher or the HUB: it starts a Director only with auto-start on.
  const start = daily && !effectiveMode().autostart ? { started: false, why: AUTOSTART_OFF } : maybeStartDirector();
  if (!start.started && start.why === 'STUDIO_DIRECTOR_CMD is not set') emitEvent({ type: 'director.needed', agent: 'director', to: 'producer', task: task.id, msg: `A Director is needed for ${task.id}. Start one: npm run kickoff -- --role director --agent director-1 --tool <tool>, or set STUDIO_DIRECTOR_CMD so pings start it.` });
  return { ok: true, task: task.id, brief, start };
}

/** Once a day, if there is a Bible. Called by the HUB with the watcher. */
/** The Director's routine check: daily by default, more often in faster modes and with MAX SPEED. */
export function dailyPingIfDue() {
  if (!readBible()) return null;
  const every = effectiveMode().directorEveryHours;
  const last = readRecentEvents(5000).filter((e) => e.type === 'director.ping' && e.meta?.daily).at(-1);
  if (last && Date.now() - Date.parse(last.ts) < every * 3600000) return null;
  return pingDirector({ reason: every >= 24 ? 'Daily check' : `Routine check (every ${every} h in this mode)`, from: 'watch', daily: true });
}

export function startReview(phase) {
  const b = readBible();
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const file = path.join(REVIEWS_DIR, `${stamp}.md`);
  fs.mkdirSync(REVIEWS_DIR, { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `# Director review ${stamp.slice(0, 10)}\n\nPhase: ${phase || b?.phase?.open || 1}\nVerdict: \nChecked: \n\n## Findings\n\n## Stop\n\n## Next\n\n`);
  }
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  };
  const cmd = argv[0] || 'drift';
  if (cmd === 'ping') {
    const res = pingDirector({ reason: flag('reason') || 'Routine check', from: flag('from') || process.env.STUDIO_LOCK_OWNER || 'producer' });
    if (!res.ok) {
      console.error(res.message);
      process.exit(1);
    }
    console.log(`Director pinged: ${res.task}. Brief: ${res.brief}. ${res.start.started ? 'A Director agent was started.' : `Not started automatically (${res.start.why}).`}`);
    if (!res.start.started && res.start.why.startsWith('STUDIO_DIRECTOR_CMD')) console.log('Start one: npm run kickoff -- --role director --agent director-1 --tool <claude|codex|cursor|grok|agy|aider|nim>');
    process.exit(0);
  }
  if (cmd === 'review') {
    console.log(`Fill in ${startReview(flag('phase'))}: Phase, Verdict (on course | drifting | off course | phase-ready), Checked (pillar:… layer:…), and the Next list.`);
    process.exit(0);
  }
  if (cmd === 'brief') {
    console.log(`Wrote ${writeDirectorBrief()}`);
    process.exit(0);
  }
  if (cmd === 'drift') {
    const d = driftReport();
    if (argv.includes('--json')) console.log(JSON.stringify(d, null, 2));
    else console.log(d.items.length ? d.items.map((i) => `- ${i.msg}`).join('\n') : 'Nothing drifting.');
    process.exit(0);
  }
  if (cmd === 'flow') {
    const r = await flowPass({ fill: !argv.includes('--no-fill') });
    console.log(argv.includes('--json') ? JSON.stringify(r, null, 2) : flowBrief(r).join('\n'));
    process.exit(0);
  }
  console.log('Usage: npm run director -- ping --reason "…" | review [--phase n] | drift [--json] | brief | flow [--json] [--no-fill]');
  process.exit(1);
}
