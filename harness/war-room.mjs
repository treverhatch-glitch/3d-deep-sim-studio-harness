/**
 * harness/war-room.mjs — 2.74.0: what the refreshed War Room's panels show, read from files (nothing estimated).
 *
 *   crew        sessions running against the cap, and why not more (the Director's flow pass, the supervisor's last pass)
 *   trains      one Train Room per train (B-62): the web merge train (.studio/locks/train.lock + .studio/train/<id>/status.json,
 *               the task.train.* events, the queue) and the Unity train (harness/unity-train.mjs), each with its lanes,
 *               the verify's step and time, the last result, and the lanes waiting on a person's release
 *   runClock    the run's clock (STUDIO_RUN_T0, else the supervisor's start; until its --until) and tasks landed per hour
 *               (task.done, lane.merged, the lanes of task.train.landed: the impact report's count, harness/impact.mjs)
 *   machine     RAM / CPU / GPU / disk now and averaged over the last samples (B-63; harness/machine.mjs), RAM per session
 *   ownerProxy  the owner's standing delegation (harness/delegation.mjs) and what was done under it: delegation.used events
 *               and decision-log records made "as delegation …" or autonomous (harness/decisions-log.mjs)
 *   steps       per agent: its task, title and current step (editing, verifying, waiting on the train, held for a person's
 *               release, handed back, parked) and the actions a person can take on it (release, hold, unhold, unpark)
 *   rooms       the Studio floor's assignment rooms: Rail Yard (the merge train), Watchtower (the owner proxy / outside
 *               overseer); engine sessions sit in Engine Bay (the engine division). roomFor() is the role mapping.
 * Never throws: a part that can't be read is null.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, readRecentEvents } from './event.mjs';
import { pidAlive } from './proc-identity.mjs';
import { readTrainStatus } from './train-status.mjs';
import { readHolds } from './task-hold.mjs';

const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const H = 3600000;
const safe = (fn, d = null) => { try { return fn(); } catch { return d; } };
const ts = (e) => Date.parse(e?.ts) || 0;

/** The Studio floor's rooms for specific assignments (beside the divisions). Generic names, no game words. */
export const ASSIGNMENT_ROOMS = [
  { id: 'rails', name: 'Rail Yard', roles: ['train', 'train-daemon', 'merge-captain'], about: 'the merge train: lanes queued, the verify, landing' },
  { id: 'watchtower', name: 'Watchtower', roles: ['overseer', 'owner-proxy'], about: 'the outside overseer and the owner\'s proxy: what it did for the owner, and revoke' },
];
const ROLE_ROOM = { train: 'rails', 'train-daemon': 'rails', 'merge-captain': 'rails', merger: 'rails', overseer: 'watchtower', 'owner-proxy': 'watchtower', orchestrator: 'watchtower', 'engine-worker': 'engine', 'engine-porter': 'engine' };
const KEYWORDS = [
  [/^(train|trains|rails?|merge|merger|landing|lander)$/, 'rails'],
  [/^(overseer|proxy|orchestrator|watchtower)$/, 'watchtower'],
  [/^(unity|godot|unreal|engine|porter)$/, 'engine'],
];
/**
 * The assignment room for an agent, or null (the HUD's own division mapping then applies): the owner's delegated agent
 * sits in the Watchtower, a session on an engine track (--track engine:<name>) in Engine Bay, then by role or name.
 */
export function roomFor({ name = '', role = '', track = '', proxyAgent = '' } = {}) {
  if (proxyAgent && String(name).toLowerCase() === String(proxyAgent).toLowerCase()) return 'watchtower';
  if (/^engine:/i.test(String(track || ''))) return 'engine';
  if (ROLE_ROOM[role]) return ROLE_ROOM[role];
  for (const n of [role, name]) {
    const tokens = String(n || '').toLowerCase().split(/[-_.\s]+/);
    const hit = KEYWORDS.find(([re]) => tokens.some((t) => re.test(t)));
    if (hit) return hit[1];
  }
  return null;
}

let proxyCache = { at: 0, v: null, key: '' };
/**
 * The owner's delegation as it counts now ({ agent, by, until, actions, ok, why } or null), cached 30 s, or until
 * studio/delegation.json or the checkout's HEAD changes (a grant or a revoke shows on the next refresh).
 */
export async function loadProxy(now = Date.now(), root = REPO_ROOT) {
  const st = (rel) => { try { const x = fs.statSync(path.join(root, rel)); return `${x.mtimeMs}:${x.size}`; } catch { return '-'; } };
  const key = `${st('studio/delegation.json')}|${st('.git/HEAD')}|${st('.git/index')}`;
  if (now - proxyCache.at < 30000 && key === proxyCache.key) return proxyCache.v;
  try {
    const { readDelegation } = await import('./delegation.mjs');
    const d = readDelegation({ now });
    proxyCache = { at: now, key, v: d.doc ? { agent: d.doc.agent, by: d.doc.by, at: d.doc.at, until: d.doc.until, actions: d.doc.actions, ok: d.ok, why: d.why || '', signed: Boolean(d.signed) } : null };
  } catch { proxyCache = { at: now, key, v: null }; }
  return proxyCache.v;
}
export const cachedProxy = () => proxyCache.v;

// ---- trains ---------------------------------------------------------------------------------------------------------

function laneStates(events, trainId) {
  const mine = events.filter((e) => e.meta?.train === trainId && /^task\.train\./.test(e.type));
  const start = mine.filter((e) => e.type === 'task.train.start').pop();
  const lanes = (start?.meta?.lanes || []).map(String);
  const state = Object.fromEntries(lanes.map((t) => [t, 'verifying']));
  for (const e of mine) {
    const t = e.task;
    if (e.type === 'task.train.dropped' && t) state[t] = 'dropped';
    if (e.type === 'task.train.held' && t) state[t] = 'held';
    if (e.type === 'task.train.deferred' && t) state[t] = 'deferred';
    if ((e.type === 'task.train.landed' || e.type === 'task.train.prefix_landed') && Array.isArray(e.meta?.lanes)) for (const l of e.meta.lanes) state[l] = 'landed';
  }
  return Object.entries(state).map(([task, st]) => ({ task, state: st }));
}

function webTrain(root, events, now) {
  const running = safe(() => readTrainStatus(root));
  const queue = (readJson(path.join(root, '.studio', 'train', 'queue.json'), []) || []).filter((e) => e && e.task);
  const done = events.filter((e) => e.type === 'task.train.done').pop() || null;
  const daemon = readJson(path.join(root, '.studio', 'train', 'daemon-last.json'));
  const lastId = done?.meta?.train || daemon?.id || null;
  const last = done ? { id: done.meta?.train || null, at: done.ts, ok: done.status !== 'warn' && !(done.meta?.dropped || []).length, landed: done.meta?.landed || [], dropped: done.meta?.dropped || [], held: done.meta?.held || [], text: String(done.msg || '').replace(/^train [^:]+:\s*/, '').slice(0, 300) } : daemon ? { id: daemon.id, at: daemon.at, ok: daemon.ok, landed: daemon.landed || [], dropped: daemon.dropped || [], held: [], text: String(daemon.message || '').slice(0, 300) } : null;
  const id = running?.train || null;
  const lanes = id ? laneStates(events, id) : [];
  const since = running?.since ? Date.parse(running.since) : null;
  const waiting = queue.filter((e) => !lanes.some((l) => l.task === e.task)).map((e) => ({ task: e.task, agent: e.agent || null, held: e.held && !(e.released && e.released.head === e.head) ? { tier: e.held.tier, why: String(e.held.why || '').split('\n')[0].slice(0, 200) } : null, released: e.released?.by || null }));
  if (!running && !queue.length && !last && !lastId) return null;
  return {
    kind: 'web', name: 'Merge train', id,
    running: Boolean(running),
    step: running ? running.step || 'starting' : null,
    text: running ? String(running.text || running.step || '').slice(0, 300) : null,
    eta: running?.eta?.text || null,
    by: running?.by || null,
    elapsedMin: since ? Math.max(0, Math.round((now - since) / 60000)) : null,
    lanes: lanes.length ? lanes : running?.lanes ? [] : [],
    laneCount: running?.lanes || lanes.length || null,
    waiting,
    needsRelease: waiting.filter((w) => w.held).map((w) => w.task),
    last,
  };
}

async function unityTrain(root) {
  try {
    const u = await import('./unity-train.mjs');
    const st = u.unityTrainStatus(root);
    const configured = !u.unityTrainSettings(root).error;
    if (!configured && !st.queue.length && !st.running && !st.last) return null;
    const lanes = (st.running?.lanes || []).map((t) => ({ task: String(t), state: 'verifying' }));
    return {
      kind: 'unity', name: 'Unity train', id: st.running?.id || null,
      running: Boolean(st.running), step: st.running ? 'landing' : null, text: st.running?.now || null, eta: null, by: st.running?.by || null,
      elapsedMin: st.running?.at ? Math.max(0, Math.round((Date.now() - Number(st.running.at)) / 60000)) : null,
      lanes, laneCount: lanes.length || null,
      waiting: st.queue.filter((e) => !(st.running?.lanes || []).includes(e.task)).map((e) => ({ task: e.task, agent: e.agent || null, held: null })),
      needsRelease: [],
      last: st.last ? { id: st.last.id || null, at: st.last.at || null, ok: Boolean(st.last.ok), landed: st.last.landed || [], dropped: st.last.dropped || [], held: [], text: String(st.last.message || '').slice(0, 300) } : null,
      configured,
    };
  } catch { return null; }
}

// ---- run clock, machine, crew ---------------------------------------------------------------------------------------

const landingsOf = (e) => (e.type === 'task.done' || e.type === 'lane.merged' ? (e.task ? [e.task] : []) : e.type === 'task.train.landed' ? (Array.isArray(e.meta?.lanes) ? e.meta.lanes.map(String) : e.task ? [e.task] : []) : []);
export function runClock({ events, supervisor = null, env = process.env, now = Date.now() } = {}) {
  const t0 = Date.parse(env.STUDIO_RUN_T0 || '') || Date.parse(supervisor?.startedAt || '') || null;
  if (!t0) return null;
  const until = Date.parse(supervisor?.opts?.until || '') || null;
  const landed = new Set();
  const lastHour = new Set();
  for (const e of events) {
    const t = ts(e);
    if (t < t0 || t > now) continue;
    for (const x of landingsOf(e)) { landed.add(x); if (t >= now - H) lastHour.add(x); }
  }
  const hours = Math.max(1 / 60, (now - t0) / H);
  return { t0: new Date(t0).toISOString(), from: env.STUDIO_RUN_T0 ? 'STUDIO_RUN_T0' : 'supervisor start', until: until ? new Date(until).toISOString() : null, elapsedH: Math.round(hours * 10) / 10, leftH: until ? Math.round(((until - now) / H) * 10) / 10 : null, landed: landed.size, perHour: Math.round((landed.size / hours) * 10) / 10, lastHour: lastHour.size };
}

export function machineTiles({ root = REPO_ROOT, sessions = 0, env = process.env } = {}) {
  const m = readJson(path.join(root, '.studio', 'machine.json'));
  let hist = [];
  try { hist = fs.readFileSync(path.join(root, '.studio', 'machine-history.jsonl'), 'utf8').split('\n').filter(Boolean).slice(-12).map((l) => JSON.parse(l)); } catch {}
  if (!m && !hist.length) return null;
  const avg = (xs) => { const v = xs.filter((x) => Number.isFinite(x)); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null; };
  const r = m?.ram || {};
  const usedGb = Number.isFinite(r.totalGb) && Number.isFinite(r.freeGb) ? Math.round((r.totalGb - r.freeGb) * 10) / 10 : null;
  const floorGb = env.STUDIO_RAM_FLOOR_GB === undefined || env.STUDIO_RAM_FLOOR_GB === '' ? 3 : Number(env.STUDIO_RAM_FLOOR_GB);
  const g = (m?.gpus || [])[0] || null;
  const perSession = sessions > 0 && usedGb !== null ? Math.round((usedGb / sessions) * 10) / 10 : null;
  const roomFor = perSession && Number.isFinite(r.freeGb) ? Math.max(0, Math.floor((r.freeGb - floorGb) / perSession)) : null;
  return {
    at: m?.at || hist.at(-1)?.at || null,
    ram: { usedGb, totalGb: r.totalGb ?? null, freeGb: r.freeGb ?? null, avgUsedGb: avg(hist.map((h) => h.ram?.[0])), floorGb, perSessionGb: perSession, roomForMore: roomFor },
    cpu: { busyPct: Number.isFinite(m?.cpu?.busy) ? Math.round(m.cpu.busy * 100) : null, avgPct: avg(hist.map((h) => h.cpu)) },
    gpu: g ? { name: g.name || null, busyPct: Number.isFinite(g.busy) ? Math.round(g.busy * 100) : null, avgPct: avg(hist.map((h) => h.gpu?.[0])), vramGb: g.vramGb ?? null } : null,
    disk: { freeGb: m?.disk?.freeGb ?? hist.at(-1)?.disk ?? null },
    samples: hist.length,
    limit: usedGb !== null && Number.isFinite(r.freeGb) && r.freeGb - floorGb < (perSession || 2) ? 'RAM' : null,
  };
}

function crewTile({ root = REPO_ROOT, launched = [], supervisor = null }) {
  const flow = readJson(path.join(root, '.studio', 'director-flow.json'));
  const running = launched.filter((s) => s.running);
  const byRole = {};
  for (const s of running) byRole[s.role || 'agent'] = (byRole[s.role || 'agent'] || 0) + 1;
  const why = (supervisor?.last?.why || []).filter(Boolean).slice(0, 3);
  return { running: running.length, max: flow?.agents?.max ?? null, builders: flow?.builders ? { running: flow.builders.running, slots: flow.builders.slots } : null, ready: flow?.ready?.total ?? null, held: flow?.ready?.held ?? null, byRole, why, flowState: flow?.state || null };
}

// ---- the owner proxy ------------------------------------------------------------------------------------------------

let decCache = { key: '', list: [] };
async function ownerProxy({ events, now = Date.now(), root = REPO_ROOT }) {
  const d = await loadProxy(now, root);
  const used = events.filter((e) => e.type === 'delegation.used' && ts(e) >= now - 7 * 24 * H).map((e) => ({ at: e.ts, who: e.agent, what: String(e.msg || '').slice(0, 220), action: e.meta?.action || null, task: e.task || null, kind: 'used' }));
  let decided = [];
  try {
    const { readLog, decisionsFile } = await import('./decisions-log.mjs');
    let k = '-';
    try { const x = fs.statSync(decisionsFile()); k = `${x.mtimeMs}:${x.size}`; } catch {}
    if (decCache.key !== k) decCache = { key: k, list: readLog().decisions };
    decided = decCache.list.filter((r) => /^delegation\b|^autonomous$/.test(String(r.as || '')) && (Date.parse(r.at) || 0) >= now - 7 * 24 * H).map((r) => ({ at: r.at, who: r.by, what: `${r.action}${r.subject ? ` ${r.subject}` : ''}${r.why ? `: ${r.why}` : ''}`.slice(0, 220), action: r.action, task: /^[A-Z]+-\d+$/.test(String(r.subject || '')) ? r.subject : null, kind: r.as === 'autonomous' ? 'autonomous' : 'decision', id: r.id }));
  } catch {}
  const recent = [...used, ...decided].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 15);
  const workarounds = events.filter((e) => /^workaround\./.test(e.type) && ts(e) >= now - 24 * H).length;
  return { delegation: d, recent, count24h: [...used, ...decided].filter((x) => (Date.parse(x.at) || 0) >= now - 24 * H).length, workarounds24h: workarounds };
}

// ---- what each agent is doing now -----------------------------------------------------------------------------------

function verifyingAgents(root) {
  const out = new Set();
  const dir = path.join(root, '.studio', 'verify-running');
  try {
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
      const j = readJson(path.join(dir, f));
      if (j?.pid && pidAlive(Number(j.pid))) out.add(String(j.owner || j.agent || f.replace(/\.json$/, '')));
    }
  } catch {}
  return out;
}

/** { [agent]: { task, title, step, label, actions: [{ action, task, label }] } } for the agents holding a task. */
export function agentSteps({ root = REPO_ROOT, agents = [], queue = { inProgress: [], backlog: [], done: [] }, holds = {}, trainQueue = [], events = [] } = {}) {
  const verifying = verifyingAgents(root);
  const tasks = new Map([...queue.inProgress, ...queue.backlog].map((t) => [t.id, t]));
  const inTrain = new Map(trainQueue.map((e) => [e.task, e]));
  const out = {};
  for (const a of agents) {
    if (!a.task || a.placeholder || a.kind === 'human') continue;
    const t = tasks.get(a.task);
    const h = holds[a.task] || {};
    const q = inTrain.get(a.task);
    const last = events.filter((e) => e.task === a.task).pop();
    let step = 'editing';
    if (h.parked) step = 'parked';
    else if (q && q.held && !(q.released && q.released.head === q.head)) step = 'needs-release';
    else if (q) step = 'on-train';
    else if (verifying.has(a.name)) step = 'verifying';
    else if (h.held) step = 'held';
    else if (last?.type === 'task.paused' || a.lastType === 'task.paused') step = 'handed-back';
    else if (!t) step = 'done';
    const label = { editing: 'editing', verifying: 'verifying', 'on-train': 'waiting on the train', 'needs-release': 'waiting on a person\'s release', held: 'held for landing', 'handed-back': 'handed back', parked: 'parked', done: 'done' }[step];
    const actions = [];
    if (step === 'needs-release') actions.push({ action: 'release', task: a.task, label: 'Release' });
    if (step === 'parked') actions.push({ action: 'unpark', task: a.task, label: 'Unpark' });
    if (t && step !== 'parked') actions.push(h.held ? { action: 'unhold', task: a.task, label: 'Unhold' } : { action: 'hold', task: a.task, label: 'Hold' });
    out[a.name] = { task: a.task, title: t ? String(t.title || '').slice(0, 90) : '', step, label, actions };
  }
  return out;
}

// ---- all of it ------------------------------------------------------------------------------------------------------

let cache = { at: 0, v: null };
/**
 * Everything above for buildHudState(). hud = { queue, launched, agents, supervisor, holds }. The slow parts (events,
 * trains, the proxy) are cached 5 s; steps are computed on every call.
 */
export async function warRoomState(hud = {}, { root = REPO_ROOT, env = process.env, now = Date.now() } = {}) {
  if (!cache.v || now - cache.at > 5000) {
    const events = readRecentEvents(20000);
    const trains = [webTrain(root, events, now), await unityTrain(root)].filter(Boolean);
    cache = { at: now, v: { events, trains } };
  }
  const { events, trains } = cache.v;
  const proxy = await ownerProxy({ events, now, root });
  const launched = hud.launched || [];
  return {
    crew: crewTile({ root, launched, supervisor: hud.supervisor }),
    trains,
    runClock: runClock({ events, supervisor: hud.supervisor, env, now }),
    machine: machineTiles({ root, sessions: launched.filter((s) => s.running).length, env }),
    ownerProxy: proxy,
    steps: agentSteps({ root, agents: hud.agents || [], queue: hud.queue, holds: hud.holds || safe(() => readHolds(), {}), trainQueue: readJson(path.join(root, '.studio', 'train', 'queue.json'), []) || [], events: events.slice(-3000) }),
    rooms: ASSIGNMENT_ROOMS,
  };
}
