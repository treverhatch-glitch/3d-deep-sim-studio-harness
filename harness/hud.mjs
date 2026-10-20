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
import { REPO_ROOT, readRecentEvents } from './event.mjs';
import { parseNextQueue } from './task.mjs';
import { listLocks } from './lock.mjs';

const readJson = (rel, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
  } catch {
    return fallback;
  }
};

// Divisions ship switched off; studio/divisions.json (phase 1) overrides this list.
export const DEFAULT_DIVISIONS = [
  { id: 'production', name: 'Producer', core: true },
  { id: 'engineering', name: 'Engineering', core: true },
  { id: 'qa', name: 'QA Lab', core: true },
  { id: 'design', name: 'Design & Balance', core: true },
  { id: 'review', name: 'Review', core: true },
  { id: 'sound', name: 'Sound Studio' },
  { id: 'art', name: 'Art' },
  { id: '3d', name: '3D' },
  { id: 'localization', name: 'Localization' },
  { id: 'ui', name: 'UI & Accessibility' },
  { id: 'narrative', name: 'Narrative' },
  { id: 'release', name: 'Release & Store' },
  { id: 'devlog', name: 'Devlog' },
  { id: 'engine', name: 'Engine Transfer' },
];

const ROOM_FOR_ROLE = {
  producer: 'production',
  human: 'production',
  builder: 'engineering',
  'qa-playtester': 'qa',
  playtester: 'qa',
  'designer-calibrator': 'design',
  balancer: 'design',
  'fun-tester': 'design',
  reviewer: 'review',
  'reference-scout': 'design',
  'asset-3d': '3d',
};

function divisions() {
  const cfg = readJson('studio/divisions.json');
  const list = Array.isArray(cfg?.divisions) ? cfg.divisions : DEFAULT_DIVISIONS;
  return list.map((d) => ({ ...d, active: Boolean(d.core || d.active) }));
}

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

export function buildHudState() {
  const now = Date.now();
  const events = readRecentEvents(400);
  const queue = parseNextQueue();
  const locks = listLocks();
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
  const roleOfTask = new Map([...queue.inProgress, ...queue.backlog, ...queue.done].map((t) => [t.id, t.role]));
  const agents = new Map();
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
  const agentList = [...agents.values()].map((a) => {
    const idleMin = a.lastSeen ? Math.round((now - Date.parse(a.lastSeen)) / 60000) : null;
    const role = ROOM_FOR_ROLE[a.name] ? a.name : roleOfTask.get(a.task) || null;
    const errored = /error|fail|escalate|bug/.test(a.lastType || '');
    return {
      ...a,
      role,
      room: ROOM_FOR_ROLE[role] || 'engineering',
      status: errored ? 'needs-attention' : idleMin !== null && idleMin > 15 ? 'idle' : 'working',
      idleMin,
    };
  });

  // Needs a person: escalations and exhausted routing since the last pass.
  const needs = [];
  for (const e of events.slice().reverse()) {
    if (e.type === 'closedloop.pass') break;
    if (e.type === 'closedloop.escalate' || e.type === 'route.exhausted') needs.push({ ts: e.ts, agent: e.agent, msg: e.msg, task: e.task });
  }

  const gates = readJson('.studio/gates-last.json');
  const total = queue.inProgress.length + queue.backlog.length + queue.done.length;
  return {
    generatedAt: new Date(now).toISOString(),
    queue,
    progress: { done: queue.done.length, total, ratio: total ? queue.done.length / total : 0 },
    locks,
    agents: agentList.sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen))),
    events: events.slice(-120).reverse(),
    needs: needs.slice(0, 10),
    gates,
    playtest: latestPlaytest(),
    router: { providers, failovers, exhausted },
    divisions: divisions(),
    lessons: lessons(),
    rtk: rtkGain(),
  };
}
