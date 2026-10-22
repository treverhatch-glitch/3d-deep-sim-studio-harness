/**
 * harness/hud.mjs — everything the War Room v3 shows, read from files. Nothing is estimated.
 *
 * Sources: studio/NEXT.md (queue), .studio/locks (claims), .studio/events.jsonl (activity, router
 * calls with real token counts), .studio/gates-last.json (last gate run), qa/reports (latest
 * playtest), studio/divisions.json (switches), studio/memory/failures.md (lessons).
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, readRecentEvents, emitEvent } from './event.mjs';
import { DEFAULT_DIVISIONS, listDivisions, setDivision } from './divisions.mjs';

export { DEFAULT_DIVISIONS, listDivisions, setDivision };
const divisions = () => listDivisions();
import { parseNextQueue } from './task.mjs';
import { listLocks } from './lock.mjs';
import { activeMeeting } from './meeting.mjs';
import { buildScorecard } from './scorecard.mjs';
import { taskType, checkDone } from './done-check.mjs';
import { readTaskHandoff } from './task.mjs';
import { effectiveMode, describeMode, MODES } from './mode.mjs';
import { sessions as agentSessionsList } from './agent.mjs';
import { openAsks, allAsks } from './ask.mjs';
import { readDesigns, latestRounds, readArtRefs, numberOf } from './art.mjs';
import { readTricks } from './tricks.mjs';
import { forcedGroups, readAccepted } from './cause-store.mjs';
import { listBuilds } from './builds.mjs';
import { readTrack } from './engine.mjs';

/** The engine track for the Arcade: which engine, its web export if built, its last frames. */
function engineInfo() {
  const t = readTrack();
  if (!t) return null;
  const caps = path.join(REPO_ROOT, t.folder, 'captures');
  const frames = fs.existsSync(caps) ? fs.readdirSync(caps).filter((f) => /\.png$/.test(f)).sort().slice(-1) : [];
  return { label: t.label, folder: t.folder, track: t.track, web: Boolean(t.webExport && fs.existsSync(path.join(REPO_ROOT, t.webExport, 'index.html'))), frames, started: t.started };
}
import { readStatus as supervisorStatus } from './supervisor.mjs';
import { budgetStatus } from './budget.mjs';
import { holdReason, holdOwner, readHolds } from './task-hold.mjs';
import { latestVerdict } from './verdict.mjs';
import { tokenTotals } from './tokens.mjs';
import { refreshBoard, sessionLimits } from './session-cap.mjs';
import { modelWarning } from './model-tiers.mjs';
import { allAttached } from './cheatsheet.mjs';
import { dailyCap, cacheReadWeight, weightedTokens, readCcusage } from './budget.mjs';
import { pendingEchoes } from './intent.mjs';
import { readWatchdog } from './watchdog.mjs';

const readJson = (rel, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
  } catch {
    return fallback;
  }
};


const ROOM_FOR_ROLE = {
  producer: 'production',
  watch: 'production',
  human: 'production',
  builder: 'engineering',
  'qa-playtester': 'qa',
  playtester: 'qa',
  'designer-calibrator': 'design',
  balancer: 'design',
  'fun-tester': 'design',
  reviewer: 'review',
  'reference-scout': 'design',
  director: 'production',
  liaison: 'production',
  rnd: 'design',
  planner: 'design',
  'asset-3d': '3d',
  'sound-designer': 'sound',
  composer: 'sound',
  'listen-checker': 'sound',
  art: 'art',
  artist: 'art',
  'art-director': 'art',
  localizer: 'localization',
  translator: 'localization',
  'ui-designer': 'ui',
  'accessibility-checker': 'ui',
  writer: 'narrative',
  'release-manager': 'release',
  'store-manager': 'release',
  devlogger: 'devlog',
  'engine-porter': 'engine',
  'dev-hacker': 'hacks',
  hacker: 'hacks',
};
// Custom roles named after their division ("sound-mixer", "art-lead") land in that room, and so do
// names that say what the agent does ("audio-1", "concept-artist", "mesh-bot"), however it was started.
const KEYWORD_ROOMS = [
  [/^(audio|sound|music|sfx|composer|foley)$/, 'sound'],
  [/^(3d|model|models|mesh|blender|rig|asset3d)$/, '3d'],
  [/^(art|artist|concept|texture|textures|sprite|sprites|illustrator|painter|assets?)$/, 'art'],
  [/^(qa|test|tester|playtest|playtester)$/, 'qa'],
  [/^(review|reviewer)$/, 'review'],
  [/^(design|designer|balance|balancer|fun|rnd|planner)$/, 'design'],
  [/^(ui|ux|accessibility)$/, 'ui'],
  [/^(writer|narrative|story|dialogue)$/, 'narrative'],
  [/^(loc|localizer|translator)$/, 'localization'],
  [/^(release|store)$/, 'release'],
  [/^(devlog)$/, 'devlog'],
  [/^(port|porter|engine)$/, 'engine'],
];
const keywordRoom = (name) => {
  const tokens = String(name || '').toLowerCase().split(/[-_.\s]+/);
  return KEYWORD_ROOMS.find(([re]) => tokens.some((t) => re.test(t)))?.[1] || null;
};
const roomForRole = (role, divs) => ROOM_FOR_ROLE[role] || (/(^|-)producer($|-)/.test(role || '') ? 'production' : null) || divs.find((d) => role && (role === d.id || role.startsWith(`${d.id}-`)))?.id || keywordRoom(role) || null;

// Events that mean "an agent reports to the Producer" in the Studio view.
const TO_PRODUCER = new Set(['task.done', 'task.forced', 'task.not_done', 'task.lock_denied', 'closedloop.escalate']);


function latestPlaytest() {
  const dir = path.join(REPO_ROOT, 'qa', 'reports');
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^qa_.*\.json$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!files.length) return null;
  const report = readJson(path.join('qa', 'reports', files[0].f));
  const s1 = report?.stage1 || {};
  return {
    report: `qa/reports/${files[0].f.replace(/\.json$/, '.md')}`,
    at: report?.timestamp,
    passed: report?.passed,
    cartridge: s1.cartridge,
    scenario: s1.scenario,
    seed: s1.seed,
    ticksRun: s1.ticksRun,
    outcome: s1.outcome,
    failingTick: s1.failingTick,
    hash: s1.finalHash,
    finding: s1.findings?.[0] ? `${s1.findings[0].id}: ${s1.findings[0].summary}` : null,
  };
}

let rtkCache = { at: 0, value: undefined };
function rtkGain() {
  // rtk measures how much shell output it filtered. Cached for a minute; null when rtk is absent.
  if (Date.now() - rtkCache.at < 60000) return rtkCache.value;
  const res = spawnSync('rtk', ['gain'], { encoding: 'utf8', timeout: 3000 });
  rtkCache = { at: Date.now(), value: res.status === 0 ? String(res.stdout).trim().split('\n').slice(0, 6).join('\n') : null };
  return rtkCache.value;
}

function lessons() {
  try {
    const text = fs.readFileSync(path.join(REPO_ROOT, 'studio', 'memory', 'failures.md'), 'utf8');
    return (text.split('## Recorded Distilled Notes')[1] || '').match(/^### /gm)?.length || 0;
  } catch {
    return 0;
  }
}

// The scorecard reads the long event history; rebuild it at most every 30 s.
let scoreCache = { at: 0, value: [] };
function scorecardCached(queue) {
  if (Date.now() - scoreCache.at < 30000) return scoreCache.value;
  scoreCache = { at: Date.now(), value: buildScorecard({ queue }).models.slice(0, 12) };
  return scoreCache.value;
}

// Measured tokens (agent.session.end), for the last 5 h, today and the whole log; rebuilt every 30 s.
let tokenCache = { at: 0, value: null };
function tokensCached() {
  if (Date.now() - tokenCache.at < 30000) return tokenCache.value;
  try {
    const events = readRecentEvents(100000);
    const pick = (t) => ({ total: t.total, byRole: t.byRole, byModel: t.byModel, byAgent: t.byAgent.slice(0, 12), untracked: t.untracked });
    tokenCache = { at: Date.now(), value: { last5h: pick(tokenTotals({ since: '5h', events })), today: pick(tokenTotals({ since: 'today', events })), all: pick(tokenTotals({ since: 'all', events })), notCounted: 'Work outside the launcher (your own chat, IDE or terminal sessions) is not counted.' } };
  } catch {
    tokenCache = { at: Date.now(), value: null };
  }
  return tokenCache.value;
}

export function buildHudState() {
  const now = Date.now();
  const events = readRecentEvents(400);
  const queue = parseNextQueue();
  // Why a waiting task can't start yet (waits for, parked, cooldown), shown next to it in Ops.
  const holds = readHolds();
  const locks = listLocks();
  // 2.30 (J10): every "waiting on" names its owner; (J2) every task says whose idea it is.
  const holders = new Map(locks.filter((l) => l.key.startsWith('task:')).map((l) => [l.key.slice(5), l.owner]));
  if (Object.keys(holds).length) queue.backlog = queue.backlog.map((t) => {
    const w = holdOwner(t.id, queue, now, holds, holders);
    return { ...t, hold: w?.why || undefined, waitOwner: w?.owner || undefined, needsYes: Boolean(holds[t.id]?.needsYes) || undefined };
  });
  const added = readRecentEvents(20000).filter((e) => e.type === 'task.added' && e.task);
  const originOf = Object.fromEntries(added.filter((e) => e.meta?.origin).map((e) => [e.task, e.meta.origin]));
  for (const k of ['inProgress', 'backlog']) queue[k] = queue[k].map((t) => (originOf[t.id] ? { ...t, origin: originOf[t.id] } : t));
  const dayAgo = now - 24 * 3600 * 1000;

  // Router: real calls and real token counts from route.* events in the last 24 h.
  const providers = {};
  let failovers = 0;
  let exhausted = 0;
  for (const e of events) {
    if (Date.parse(e.ts) < dayAgo) continue;
    if (e.type === 'route.success') {
      const p = (providers[e.provider] ||= { calls: 0, tokensIn: 0, tokensOut: 0, model: e.model });
      p.calls += 1;
      p.tokensIn += Number(e.tokensIn || 0);
      p.tokensOut += Number(e.tokensOut || 0);
    }
    if (e.type === 'route.failover') failovers += 1;
    if (e.type === 'route.exhausted') exhausted += 1;
  }

  // Agents: everyone who wrote an event in the last 24 h, with what they hold now.
  const taskById = new Map([...queue.inProgress, ...queue.backlog, ...queue.done].map((t) => [t.id, t]));
  const roleOfTask = new Map([...queue.inProgress, ...queue.backlog, ...queue.done].map((t) => [t.id, t.role]));
  const agents = new Map();
  // Scripts log as "producer"; STUDIO_PRODUCER_NAME (e.g. grok-producer) merges them into one person.
  const pname = process.env.STUDIO_PRODUCER_NAME;
  if (pname) for (const e of events) if (e.agent === 'producer') e.agent = pname;
  for (const e of events) {
    if (!e.agent || Date.parse(e.ts) < dayAgo) continue;
    const a = agents.get(e.agent) || { name: e.agent, events: 0 };
    a.events += 1;
    a.lastSeen = e.ts;
    a.lastType = e.type;
    a.lastMsg = e.msg;
    if (e.task) a.task = e.task;
    if (e.model) a.model = e.model;
    agents.set(e.agent, a);
  }
  for (const l of locks) {
    const a = agents.get(l.owner) || { name: l.owner, events: 0 };
    a.holds = [...(a.holds || []), l.key];
    if (l.key.startsWith('task:')) a.task = l.key.slice(5);
    agents.set(l.owner, a);
  }
  const divs = divisions();
  // People: names used on War Room buttons, and whoever signed the Game Bible.
  const launchedNow = agentSessionsList();
  const humans = new Set(['war-room-human', ...(readJson('.studio/humans.json', []) || []), readJson('studio/bible/bible.json', {})?.signed?.by].filter(Boolean));
  const agentList = [...agents.values()].map((a) => {
    if (humans.has(a.name)) {
      const idleMin = a.lastSeen ? Math.round((now - Date.parse(a.lastSeen)) / 60000) : null;
      return { ...a, role: 'human', kind: 'human', room: 'production', status: idleMin !== null && idleMin > 15 ? 'idle' : 'working', idleMin };
    }
    const idleMin = a.lastSeen ? Math.round((now - Date.parse(a.lastSeen)) / 60000) : null;
    const sess = launchedNow.find((x) => x.agent === a.name);
    const role = pname && a.name === pname ? 'producer' : roomForRole(a.name, divs) ? a.name : roleOfTask.get(a.task) || null;
    const errored = /error|fail|escalate|bug|forced|not_done/.test(a.lastType || '');
    // Holding a task but silent for 30 minutes: probably out of usage or stuck (harness/watch.mjs).
    const stalled = Boolean(a.holds?.some((k) => k.startsWith('task:'))) && (idleMin === null || idleMin > 30);
    return {
      ...a,
      role,
      // Seated by the division it was hired into, then by role.
      room: (sess?.division && divs.some((d) => d.id === sess.division) ? sess.division : null) || roomForRole(role, divs) || 'engineering',
      // The launcher's heartbeat is the truth for agents it started.
      status: sess?.running ? (sess.stalled ? 'stalled' : 'working') : stalled ? 'stalled' : errored ? 'needs-attention' : idleMin !== null && idleMin > 15 ? 'idle' : 'working',
      launched: Boolean(sess?.running),
      kind: a.name === 'watch' ? 'script' : 'agent',
      // What kind of work it is doing, for the Studio view's animations.
      work: a.task && taskById.get(a.task) ? taskType(taskById.get(a.task)) : null,
      idleMin,
    };
  });
  // Out of quota, not stalled: the last thing an agent said was a usage limit (and when it resets).
  const QUOTA = /usage limit|rate.?limit|\b429\b|quota|insufficient[_ ]credit|credit balance/i;
  for (const a of agentList) {
    const last = events.filter((e) => e.agent === a.name || (e.type === 'task.paused' && e.task === a.task && e.agent === a.name)).pop();
    if (last && QUOTA.test(last.msg || '') && Date.parse(last.ts) > now - 12 * 3600 * 1000) {
      const until = (String(last.msg).match(/(?:resets?|try again)(?: at| after)?\s*(\d{1,2}:\d{2}(?:\s*[ap]m)?)/i) || [])[1] || null;
      a.status = 'out-of-quota';
      a.quotaUntil = until;
    }
  }
  // Bugs each agent caused: bugs filed --caused-by a task it finished, and its tasks reopened.
  const doneBy = new Map();
  for (const e of events) if (e.type === 'task.done' && e.task) doneBy.set(e.task, e.agent);
  const caused = new Map();
  for (const e of events) {
    const src = e.type === 'task.added' ? e.meta?.causedBy : e.type === 'task.reopened' ? e.task : null;
    const who = src && doneBy.get(src);
    if (who) caused.set(who, (caused.get(who) || 0) + 1);
  }
  for (const a of agentList) a.caused = caused.get(a.name) || 0;
  // Divisions switch on by themselves when an agent of theirs is at work.
  for (const d of divs) {
    if (!d.active && agentList.some((a) => a.room === d.id)) Object.assign(d, { active: true, autoOn: true });
  }
  // The Producer's office is never empty: the role exists even before it writes an event.
  if (!agentList.some((a) => a.room === 'production')) {
    agentList.push({ name: 'producer', role: 'producer', room: 'production', status: 'idle', events: 0, idleMin: null, placeholder: true });
  }
  // The watcher sits in the Producer's office as soon as it has run once, even with nothing to report.
  const watchLast = readJson('.studio/watch-last.json');
  if (watchLast && !agentList.some((a) => a.name === 'watch')) {
    agentList.push({ name: 'watch', role: 'watch', room: 'production', status: 'idle', kind: 'script', events: 0, idleMin: null, placeholder: true });
  }
  const producerName = (pname && agentList.find((a) => a.name === pname)?.name) || agentList.find((a) => a.room === 'production' && (a.name === 'producer' || a.role === 'producer'))?.name || agentList.find((a) => a.room === 'production').name;
  const byName = new Map(agentList.map((a) => [a.name, a]));

  // Conversations with the Producer, so the Studio view can walk people between rooms.
  const talks = [];
  for (const e of events.slice().reverse()) {
    if (talks.length >= 20 || Date.parse(e.ts) < now - 30 * 60000) break;
    if (!e.agent) continue;
    const fromRoom = byName.get(e.agent)?.room;
    if (e.to && e.to !== e.agent) {
      const to = e.to === 'producer' ? producerName : e.to;
      const toAgent = byName.get(to);
      talks.push({ id: e.id, ts: e.ts, from: e.agent, to: toAgent ? to : null, room: toAgent?.room || roomForRole(e.to, divs), msg: e.msg, type: e.type });
    } else if (TO_PRODUCER.has(e.type) && fromRoom !== 'production') {
      talks.push({ id: e.id, ts: e.ts, from: e.agent, to: producerName, room: 'production', msg: e.msg, type: e.type });
    } else if (e.type === 'task.added' && (e.agent === producerName || e.agent === 'producer')) {
      const role = roleOfTask.get(e.task);
      const room = roomForRole(role, divs) || 'engineering';
      if (room === 'production') continue;
      const toAgent = agentList.find((a) => a.room === room && a.role === role) || agentList.find((a) => a.room === room);
      talks.push({ id: e.id, ts: e.ts, from: producerName, to: toAgent?.name || null, room, msg: e.msg, type: e.type });
    }
  }

  // Needs a person: escalations and exhausted routing since the last pass, and forced work
  // the Producer has not checked yet.
  const needs = [];
  for (const e of events.slice().reverse()) {
    if (e.type === 'closedloop.pass') break;
    if (e.type === 'closedloop.escalate' || e.type === 'route.exhausted') needs.push({ ts: e.ts, agent: e.agent, msg: e.msg, task: e.task });
  }
  // Forced work, one card per cause (harness/causes.mjs), not one per task.
  for (const g of forcedGroups(queue)) needs.push({ agent: 'producer', msg: `${g.tasks.length} task${g.tasks.length === 1 ? '' : 's'} closed past the same check: ${g.cause} (${g.tasks.slice(0, 6).join(', ')}${g.tasks.length > 6 ? ', …' : ''})`, task: g.checks[0], action: { type: 'accept-cause', cause: g.cause, label: 'Accept for this run' } });
  for (const t of [...queue.inProgress, ...queue.backlog]) {
    if (/^Watch:/i.test(t.title)) needs.push({ agent: 'watch', msg: t.title, task: t.id });
  }
  // Golden changes someone should look at: the reason, and which recorded numbers moved.
  const okGolden = new Set((readJson('studio/decisions/golden-approvals.json', { approved: [] })?.approved || []).map((a) => a.sha));
  const glog = spawnSync('git', ['log', '-n', '12', '--since=14 days ago', '--format=%h%x1f%an%x1f%(trailers:key=Golden-Reason,valueonly,separator=%x20)%x1f%(trailers:key=Golden-Diff,valueonly,separator=%x20)%x1f%(trailers:key=Studio-Agent,valueonly)', '--', 'qa/golden'], { cwd: REPO_ROOT, encoding: 'utf8' });
  for (const line of (glog.status === 0 ? glog.stdout : '').split('\n').filter(Boolean)) {
    const [sha, author, reason, diff, agent] = line.split('\x1f').map((x) => x.trim());
    // Only the studio's own changes: a commit by an agent (Studio-Agent) or one that gave a reason.
    // A fresh clone's history (the template's own golden commits) is not something to check.
    if (okGolden.has(sha) || (!agent && !reason)) continue;
    needs.push({ agent: agent || author, msg: `Recorded answers (goldens) changed in ${sha}: ${reason || 'no reason given'}${diff ? `. Moved: ${diff}` : ''}`, action: { type: 'golden-ok', sha, label: 'Looks right' } });
  }
  // A studio that stopped: work waiting, nothing running, nobody heard from in an hour.
  const lastActivity = events.filter((e) => e.agent && !['watch', 'war-room-human'].includes(e.agent)).pop();
  const quietMin = lastActivity ? Math.round((now - Date.parse(lastActivity.ts)) / 60000) : null;
  if (queue.backlog.length && !queue.inProgress.length && !agentSessionsList().some((s) => s.running) && quietMin !== null && quietMin >= 60) {
    needs.push({ agent: 'watch', msg: `The studio is idle${quietMin !== null ? ` (${quietMin >= 120 ? `${Math.round(quietMin / 60)} h` : `${quietMin} min`})` : ''} with ${queue.backlog.length} task${queue.backlog.length === 1 ? '' : 's'} waiting: start an agent in Ops, or choose a faster pace`, action: { type: 'start-producer', label: 'Start the Producer' } });
  }
  // The supervisor stopped starting agents after two identical failures (exit 127: tool not on PATH).
  const sup = supervisorStatus();
  if (sup?.halted && sup.status === 'running') needs.push({ ts: sup.halted.at, agent: 'supervisor', msg: `The supervisor stopped starting agents: ${sup.halted.why}`, action: { type: 'supervisor-resume', label: 'Fixed it: try again' } });
  // Money, licences, publishing and deleting first; then what breaks play; then housekeeping.
  const rank = (n) => (/money|spend|pay|licen[cs]e|credit line|publish|delet/i.test(n.msg) ? 0 : /playtest|browser|blank|escalat|exhausted|won't load|idle|stopped starting/i.test(n.msg) ? 1 : 2);
  needs.sort((x, y) => rank(x) - rank(y));

  // Three separate signals, each with its reason, so "an agent needs you", "a check is red" and
  // "an agent died" never look the same.
  const bibleNow = readJson('studio/bible/bible.json', null);
  const launched = agentSessionsList();
  const signals = {
    needsYou: [
      ...needs.map((n) => (n.action?.type === 'accept-cause' ? n.msg : `${n.task ? `${n.task}: ` : ''}${n.msg}`)),
      ...(bibleNow && !bibleNow.signed ? ['The Game Bible is waiting for your signature (npm run bible -- check, then sign)'] : []),
      ...(bibleNow?.amended ? [`The Bible changed after signing (${bibleNow.amended.changes.map((c) => c.field).join(', ')}): re-sign it so build work can go on`] : []),
      ...(() => {
        const w = readDesigns().filter((d) => d.status === 'proposed');
        return w.length ? [`${w.length} design${w.length === 1 ? '' : 's'} waiting in the Asset studio (${w.slice(0, 4).map((d) => `#${numberOf(d)} ${d.title}`).join(', ')}${w.length > 4 ? ', …' : ''})`] : [];
      })(),
      ...openAsks().map((a) => `${a.id}: ${a.question}${a.deadline ? ` (if you don't answer in time, it goes with "${a.default}")` : ''}`),
    ].slice(0, 12),
    red: ((readJson('.studio/gates-last.json', null) || {}).rows || []).filter((r) => r.required && !r.ok).map((r) => r.id),
    stalled: [
      ...launched.filter((s) => s.stalled).map((s) => `${s.agent}: no heartbeat for ${s.beatAgeMin} min`),
      ...agentList.filter((a) => a.status === 'stalled' && !launched.some((s) => s.agent === a.name && s.running)).map((a) => `${a.name}: holds ${a.task || 'a task'} but silent ${a.idleMin} min`),
    ],
  };

  // A meeting in progress: who is at the table (role names resolve to the agent doing that role).
  let meeting = null;
  const m = activeMeeting();
  if (m) {
    const onDuty = new Set(divs.filter((d) => d.active).map((d) => d.id));
    const resolve = (who) => (byName.has(who) ? who : who === 'producer' ? producerName : agentList.find((a) => a.role === who)?.name || null);
    const people = [...new Set([resolve(m.by) || producerName, ...m.attendees.map(resolve)].filter(Boolean))];
    meeting = { topic: m.topic, room: onDuty.has(m.room) ? m.room : 'production', attendees: people, invited: m.attendees, by: m.by, startedAt: m.startedAt, file: m.file };
  }

  const gates = readJson('.studio/gates-last.json');
  const total = queue.inProgress.length + queue.backlog.length + queue.done.length;
  const out = {
    generatedAt: new Date(now).toISOString(),
    stopped: readJson('.studio/STOP.json', null),
    mode: { ...effectiveMode(), text: describeMode() },
    modes: Object.fromEntries(Object.entries(MODES).map(([id, m]) => [id, { label: m.label, pitch: m.pitch }])),
    art: (() => {
      const all = readDesigns();
      return {
        designs: latestRounds(all).slice(-60).map((d) => ({ id: d.id, n: numberOf(d), round: d.round || 1, kind: d.kind, title: d.title, file: d.file, image: d.image, model: d.model || /\.(glb|gltf)$/i.test(d.file), thumb: d.thumb || null, status: d.status, provisional: Boolean(d.provisional), by: d.by, at: d.at, licence: d.licence, generated: d.generated || null, feedback: (d.feedback || []).slice(-3), note: (d.feedback || []).slice(-1)[0]?.text || '', rounds: all.filter((x) => (x.asset || x.id) === (d.asset || d.id) && x.id !== d.id).map((x) => ({ id: x.id, round: x.round || 1, image: x.image, thumb: x.thumb || null })) })),
        references: readArtRefs(),
        reference: bibleNow?.artReference || null,
        waitHours: { precise: 24, budget: 24, fast: 8, extreme: 4 }[effectiveMode().id] / (effectiveMode().boost ? 2 : 1),
      };
    })(),
    asks: { open: openAsks(), decided: allAsks().filter((a) => a.status === 'decided').slice(-5) },
    launched: launched.map((s) => ({ agent: s.agent, role: s.role, tool: s.tool, model: s.model, task: s.task, running: s.running, stalled: s.stalled, beatAgeMin: s.beatAgeMin, reason: s.reason || null, wip: s.wip || null, now: s.now || null, lane: s.lane || null })),
    signals,
    queue,
    progress: { done: queue.done.length, total, ratio: total ? queue.done.length / total : 0 },
    locks,
    agents: agentList.sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen))),
    events: events.slice(-120).reverse(),
    talks,
    meeting,
    watch: watchLast ? { at: watchLast.at, findings: (watchLast.findings || []).map((f) => f.msg), pinged: watchLast.pinged } : null,
    scorecard: scorecardCached(queue),
    needs: needs.slice(0, 10),
    // The Arcade: saved playable builds, recent clips, and which phase each task belongs to (for the dungeon).
    tricks: readTricks().slice(-12).reverse().map((t) => ({ id: t.id, title: t.title, status: t.status, problem: t.problem, by: t.by, tasks: t.tasks || [], experiment: t.experiment || null })),
    builds: listBuilds().slice(0, 6),
    engine: engineInfo(),
    supervisor: (() => {
      const s = supervisorStatus();
      if (!s) return null;
      let up = false;
      try {
        process.kill(s.pid, 0);
        up = s.status === 'running';
      } catch {
        up = false;
      }
      return { ...s, running: up };
    })(),
    budget: budgetStatus(now, events),
    clips: (() => {
      const d = path.join(REPO_ROOT, 'qa', 'reports', 'clips');
      return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => /\.(mp4|webm|jpg)$/.test(f)).sort().reverse().slice(0, 8) : [];
    })(),
    taskPhase: Object.fromEntries(events.filter((e) => e.type === 'task.added' && e.task && e.meta?.phase).map((e) => [e.task, Number(e.meta.phase)])),
    // Progress toward the game, by phase: a phase with no tasks is "not planned", not 0% or 100%.
    phases: (() => {
      const tp = {};
      for (const e of events) if (e.type === 'task.added' && e.task && e.meta?.phase) tp[e.task] = Number(e.meta.phase);
      const all = [...queue.inProgress, ...queue.backlog, ...queue.done];
      return [1, 2, 3].map((n) => {
        const mine = all.filter((t) => tp[t.id] === n);
        const done = queue.done.filter((t) => tp[t.id] === n).length;
        const exitFile = path.join(REPO_ROOT, 'studio', 'bible', `PHASE-${n}-EXIT.md`);
        const exit = fs.existsSync(exitFile) ? fs.readFileSync(exitFile, 'utf8').match(/^\s*[-*] \[[ xX]\] .+$/gm) || [] : [];
        const fun = latestVerdict(n);
        return { n, player: bibleNow?.phases?.[n]?.player || null, open: (bibleNow?.phase?.open || 0) >= n, planned: mine.length > 0, total: mine.length, done, exit: { total: exit.length, done: exit.filter((l) => /\[[xX]\]/.test(l)).length }, fun: fun ? { said: fun.fun, by: fun.by, build: fun.build } : null };
      });
    })(),
    taskHolder: Object.fromEntries(locks.filter((l) => l.key.startsWith('task:')).map((l) => [l.key.slice(5), l.owner])),
    causes: readAccepted(),
    gates,
    playtest: latestPlaytest(),
    router: { providers, failovers, exhausted },
    // Tokens: the router's real counts plus what launched agents reported at the end of a session.
    tokens: (() => {
      const routed = Object.values(providers).reduce((n, p) => n + p.tokensIn + p.tokensOut, 0);
      const ends = events.filter((e) => e.type === 'agent.session.end' && Date.parse(e.ts) > dayAgo && (e.tokensIn || e.tokensOut));
      const agentsN = ends.reduce((n, e) => n + Number(e.tokensIn || 0) + Number(e.tokensOut || 0), 0);
      return { routed, agents: agentsN, total: routed + agentsN, tracked: routed + agentsN > 0, why: routed + agentsN > 0 ? null : 'not tracked: agents started outside the launcher and the router report no usage' };
    })(),
    // What is being worked on: every task with activity in the last 30 minutes.
    now: queue.inProgress.map((t) => ({ id: t.id, title: t.title, agents: [...new Set(events.filter((e) => e.task === t.id && Date.parse(e.ts) > now - 30 * 60000).map((e) => e.agent))] })).filter((t, i) => t.agents.length || i === 0),
    divisions: divs,
    lessons: lessons(),
    rtk: rtkGain(),
    tokenUse: tokensCached(),
    // 2.29.2: the budget meter with cache reads, per model; sessions against the refresh point; the
    // top-tier warning; the cheat sheet tricks attached to each task.
    meter: (() => {
      const today = new Date(now).toISOString().slice(0, 10);
      const w = cacheReadWeight();
      const ends = events.filter((e) => e.type === 'agent.session.end' && String(e.ts).startsWith(today));
      const byModel = {};
      for (const e of ends) {
        const m = (byModel[e.model || 'unknown'] ||= { model: e.model || 'unknown', sessions: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, counted: 0 });
        m.sessions += 1;
        m.tokensIn += Number(e.tokensIn || 0);
        m.tokensOut += Number(e.tokensOut || 0);
        m.cacheRead += Number(e.meta?.cacheRead || 0);
        m.counted += weightedTokens(e, w);
      }
      const rows = Object.values(byModel).map((m) => ({ ...m, counted: Math.round(m.counted) }));
      const used = rows.reduce((n, m) => n + m.counted, 0);
      const cap = dailyCap();
      return { day: today, cacheWeight: w, cap, used, pct: cap ? Math.round((used / cap) * 1000) / 10 : null, byModel: rows };
    })(),
    sessionCap: { limits: sessionLimits(), sessions: refreshBoard().sort((a, b) => Number(b.running) - Number(a.running)).slice(0, 12) },
    modelWarning: modelWarning(process.env, events, now),
    cheatsheet: allAttached(),
    // 2.30: intent cards (J2), the watchdog switch (G1), Claude Code's own count (ccusage, opt-in).
    intent: pendingEchoes(),
    watchdog: readWatchdog(),
    ccusage: (() => {
      const c = readCcusage();
      const d = c?.days?.at(-1);
      return d ? { at: c.at, ...d } : null;
    })(),
  };
  // 2.30 (J10): the plain status line. Building now, waiting on you, tokens today with the model named.
  const st = out;
  const waitingOnYou = [
    ...st.intent.map((e) => ({ what: `${e.id}: confirm "${e.asked}"`, owner: 'you', why: 'an intent card' })),
    ...st.queue.backlog.filter((t) => t.needsYes).map((t) => ({ what: `${t.id}: ${t.title}`, owner: 'you', why: 'an agent-proposed mechanic needs your yes' })),
    ...(st.modelWarning?.show ? [{ what: 'top-tier models on every role', owner: 'you', why: 'accept or change the models' }] : []),
    ...st.asks.open.filter((a) => !a.to || /human|dev|you/i.test(a.to)).map((a) => ({ what: `${a.id}: ${a.question}`, owner: 'you', why: 'a question' })),
  ];
  const waitingOnOthers = st.queue.backlog.filter((t) => t.waitOwner && t.waitOwner !== 'the dev').map((t) => ({ what: t.id, owner: t.waitOwner, why: t.hold }));
  const building = st.launched.filter((l) => l.running).map((l) => ({ agent: l.agent, task: l.task, model: l.model }));
  const top = [...st.meter.byModel].sort((a, b) => b.counted - a.counted).map((m) => m.model);
  st.status = {
    building,
    waitingOnYou,
    waitingOnOthers,
    tokensToday: st.meter.used,
    models: top,
    line: `Building now: ${building.length ? building.map((b) => `${b.agent} on ${b.task || 'no task'}`).join(', ') : 'nothing'} · Waiting on you: ${waitingOnYou.length || 'nothing'} · Tokens today: ${st.meter.used.toLocaleString()}${top.length ? ` (${top.join(', ')})` : ''}`,
  };
  // 2.30 (J8): what changed in each build, from the tasks finished between it and the build before.
  const doneEv = readRecentEvents(20000).filter((e) => e.type === 'task.done' && e.task);
  st.builds = st.builds.map((b, i) => {
    const prev = st.builds[i + 1]?.at || '';
    const items = doneEv.filter((e) => e.ts > prev && e.ts <= b.at).slice(-5).reverse().map((e) => ({ task: e.task, title: String(e.msg || '').replace(/^.*?:\s*/, '').slice(0, 120) }));
    return { ...b, changes: items };
  });
  return st;
}

/**
 * Everything the War Room shows when you click an agent: its task, who assigned it, the live done
 * checklist, the skill's steps, notes from before, its claims and what it did lately. Files only.
 */
export function buildAgentDetail(name) {
  const hud = buildHudState();
  const agent = hud.agents.find((a) => a.name === name);
  if (!agent) return null;
  const events = readRecentEvents(3000);
  const q = hud.queue;
  const all = [...q.inProgress, ...q.backlog, ...q.done];
  const held = hud.locks.filter((l) => l.owner === name);
  const taskId = held.find((l) => l.key.startsWith('task:'))?.key.slice(5) || agent.task || null;
  const task = all.find((t) => t.id === taskId) || null;
  let detail = null;
  if (task) {
    const added = events.find((e) => e.type === 'task.added' && e.task === task.id);
    const started = events.filter((e) => e.type === 'task.start' && e.task === task.id).pop();
    const check = checkDone(task);
    let steps = [];
    try {
      const skill = check.skill ? fs.readFileSync(path.join(REPO_ROOT, check.skill), 'utf8') : '';
      const block = (skill.match(/\*\*Steps\.?\*\*\s*([\s\S]*?)(?=\n\*\*[A-Z]|$)/) || [, ''])[1];
      steps = block.split(/\n(?=\d+\.\s)/).map((x) => x.replace(/^\d+\.\s*/, '').replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
    } catch {
      // no skill file
    }
    detail = {
      id: task.id,
      title: task.title,
      priority: task.priority,
      role: task.role,
      status: task.status,
      type: check.type,
      size: added?.meta?.size || null,
      causedBy: added?.meta?.causedBy || null,
      assignedBy: added?.agent || null,
      assignedAt: added?.ts || null,
      startedAt: started?.ts || null,
      means: check.means,
      skill: check.skill,
      checks: check.checks,
      steps,
      handoff: readTaskHandoff(task.id),
      brief: fs.existsSync(path.join(REPO_ROOT, '.studio', 'briefs', `${task.id}.md`)) ? `.studio/briefs/${task.id}.md` : null,
    };
  }
  const mine = events.filter((e) => e.agent === name);
  return {
    name,
    kind: agent.kind || 'agent',
    model: agent.model || null,
    role: agent.role || null,
    room: agent.room,
    status: agent.status,
    idleMin: agent.idleMin,
    task: detail,
    claims: held.map((l) => ({ key: l.key, until: l.expiresAt })),
    finishedToday: mine.filter((e) => e.type === 'task.done' && Date.parse(e.ts) > Date.now() - 86400000).map((e) => ({ ts: e.ts, task: e.task, msg: e.msg })),
    assignedByThem: mine.filter((e) => e.type === 'task.added').slice(-8).map((e) => ({ ts: e.ts, task: e.task, msg: e.msg })),
    recent: mine.slice(-10).reverse().map((e) => ({ ts: e.ts, type: e.type, msg: e.msg })),
    score: hud.scorecard.find((m) => m.model === agent.model) || null,
    watch: name === 'watch' ? hud.watch : null,
  };
}
