#!/usr/bin/env node
/**
 * harness/communicator.mjs — 2.76.0 (l): the Communicator. The owner (2026-11-04): "a new role of a 'communicator' so its
 * job is to update in our discord chat every 30 minutes and also message when emergencies happen or things are needed
 * right away ... with the ability to tag [the orchestrator] directly and [the key holder] and me".
 *
 * Harness code that posts, not an AI session that talks: two extra chat sessions confused names and answered things they
 * couldn't. It never reads the chat and spends no model tokens. The supervisor calls communicatorPass() once per pass.
 *
 *   npm run comm -- status [--json]     the set-up (webhook shown masked), what was sent, what is held, what is due
 *   npm run comm -- preview [--json]    what it would post now (status + every open alert), mentions as @names; sends nothing
 *   npm run comm -- test                posts one line (no one tagged), to check the webhook
 *
 * Status, every STUDIO_COMM_STATUS_MIN (30) minutes: one fixed-format post from the harness's own data, the same facts
 * `status -- --brief` reads (harness/brief-status.mjs briefFacts, the event stream): agents and tasks, landed since the
 * run's T0 (the supervisor's start) and per hour, the train (running step and ETA, or the last one's end and length, the
 * queue), the rig (harness/machine.mjs), API $ when tracked (harness/autonomy.mjs dollarsOf), what is blocked and why,
 * what waits on a yes (harness/digest.mjs needsPerson), beta mode (harness/beta-mode.mjs), the Line Producer's line.
 *
 * Alerts, at once, each tagging exactly who must act (studio/communicator.json "mentions": Discord user ids, not
 * secrets):
 *   orchestrator  a train died (its lock's process is gone, or it started and never ended) or is red on real failures
 *                 (main red; a red train that isn't flaky or infrastructure); fewer builders busy than the Line
 *                 Producer's target (.studio/line/status.json, for 10 min; else STUDIO_COMM_MIN_BUILDERS); the crew
 *                 breaker or a supervisor halt; a stop file; a stuck lane (queued past STUDIO_COMM_STUCK_MIN, or a stalled
 *                 session); a harness error (the supervisor's pass threw, the whole-game check errored, the hub keeps
 *                 restarting); in beta mode also what the orchestrator may now do itself (releases, ordinary asks).
 *   keys          an owner-key step (a lane held for the owner's release, protected files changed without approval);
 *                 never in beta mode, nor when the orchestrator holds a delegation for it (harness/delegation.mjs).
 *   owner         only owner decisions (asks; in beta mode only those about money, deleting, direction or scope; spend over
 *                 budget; a policy proposal) and disasters (disk under STUDIO_COMM_DISK_GB 30, STUDIO_COMM_CRASHES 3 crashes
 *                 in an hour, everything blocked over STUDIO_COMM_BLOCKED_MIN 60). A disaster tags the orchestrator too.
 * Rules: one alert at most once per STUDIO_COMM_DEDUP_MIN (30); one still open is tagged again at most every
 * STUDIO_COMM_REPEAT_MIN (120; disasters every DEDUP_MIN); a pass's alerts go in one post (with the status when it is
 * due); an alert the orchestrator can fix never tags the owner; STUDIO_COMM_QUIET "23:00-07:00" (local time) holds
 * owner-only alerts that aren't disasters until it ends. Alerts that closed are named once ("Cleared: …").
 *
 * One identity: the webhook's username (studio/communicator.json "username", default "Studio Status"); plain text,
 * parts of at most 2000 characters cut at line ends (never inside a mention); Discord allowed_mentions lists only the
 * ids tagged in that part (no @everyone). The webhook is STUDIO_COMM_WEBHOOK, else STUDIO_REPORT_WEBHOOK (environment or
 * the studio's .env), never printed, logged or put in an event (harness/report-post.mjs masks and scrubs it; its postOnce
 * sends). On: STUDIO_COMM_WEBHOOK set, or the report webhook with studio/communicator.json or STUDIO_COMM=on;
 * STUDIO_COMM=off turns it off. A failed post is tried again after 5 minutes. State: .studio/comm/state.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent, readRecentEvents } from './event.mjs';
import { loadDotEnv } from './dotenv.mjs';
import { webhookFrom, maskWebhook, scrub, formatFor, postOnce, DISCORD_MAX } from './report-post.mjs';

export const CONFIG_REL = 'studio/communicator.json';
export const ROLES = ['orchestrator', 'keys', 'owner'];
export const OWNER_KINDS = new Set(['decision', 'disaster']);
export const DEFAULT_USERNAME = 'Studio Status';
const RETRY_MS = 5 * 60000;
const LOW_BUILDERS_MS = 10 * 60000;
const LINE_FRESH_MS = 10 * 60000;
const ID_RE = /^\d{5,25}$/;
const stateFile = (root) => path.join(root, '.studio', 'comm', 'state.json');
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, `${JSON.stringify(v, null, 2)}\n`); fs.renameSync(t, f); } catch {} };
const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const mins = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return m < 90 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
const cut = (ids, k = 6) => (ids.length <= k ? ids.join(', ') : `${ids.slice(0, k).join(', ')} +${ids.length - k} more`);
const short = (s, n = 160) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const alive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; } };
/** Harness data put into a post can't ping anyone: no raw mentions, no @everyone/@here. */
const quiet = (s) => String(s ?? '').replace(/<@[!&]?(\d+)>/g, '@$1').replace(/<!(channel|here|everyone)>/g, '!$1').replace(/@(everyone|here)\b/g, '@​$1');

// ---- settings ------------------------------------------------------------------------------------------------------

const numEnv = (env, k, d, min = 0) => { const v = String(env[k] ?? '').trim(); const n = Number(v); return v !== '' && Number.isFinite(n) && n >= min ? n : d; };
export function commSettings(env = process.env) {
  return {
    statusMin: numEnv(env, 'STUDIO_COMM_STATUS_MIN', 30, 1),
    dedupMin: numEnv(env, 'STUDIO_COMM_DEDUP_MIN', 30, 0),
    repeatMin: numEnv(env, 'STUDIO_COMM_REPEAT_MIN', 120, 0),
    diskGb: numEnv(env, 'STUDIO_COMM_DISK_GB', 30, 0),
    crashes: numEnv(env, 'STUDIO_COMM_CRASHES', 3, 1),
    blockedMin: numEnv(env, 'STUDIO_COMM_BLOCKED_MIN', 60, 1),
    stuckMin: numEnv(env, 'STUDIO_COMM_STUCK_MIN', 120, 1),
    minBuilders: numEnv(env, 'STUDIO_COMM_MIN_BUILDERS', 0, 0),
    quiet: /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(String(env.STUDIO_COMM_QUIET || '').trim()) ? String(env.STUDIO_COMM_QUIET).trim() : '',
  };
}
/** Local time inside "HH:MM-HH:MM" (wraps past midnight). An empty window is never in. */
export function inQuiet(win, now = Date.now()) {
  const m = String(win || '').match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  const d = new Date(now);
  const t = d.getHours() * 60 + d.getMinutes();
  const a = Number(m[1]) * 60 + Number(m[2]);
  const b = Number(m[3]) * 60 + Number(m[4]);
  return a === b ? false : a < b ? t >= a && t < b : t >= a || t < b;
}

/** studio/communicator.json: { mentions: {role: id}, names: {role: name}, username, agents: {orchestrator}, notes: [] }. */
export function readCommConfig(root = REPO_ROOT) {
  const f = path.join(root, CONFIG_REL);
  const raw = readJson(f, null);
  const notes = [];
  if (raw === null && fs.existsSync(f)) notes.push(`${CONFIG_REL} isn't valid JSON: no one is tagged`);
  const c = raw && typeof raw === 'object' ? raw : {};
  const mentions = {}; const names = {};
  for (const r of ROLES) {
    const id = String(c.mentions?.[r] ?? '').trim().replace(/^<@!?(\d+)>$/, '$1');
    if (id && ID_RE.test(id)) mentions[r] = id;
    else if (id) notes.push(`mentions.${r} isn't a Discord user id (digits only): not tagged`);
    names[r] = short(String(c.names?.[r] || '').trim(), 40) || r;
  }
  const username = short(String(c.username || '').trim(), 80) || DEFAULT_USERNAME;
  return { exists: raw !== null, mentions, names, username, agents: { orchestrator: String(c.agents?.orchestrator || '').trim() || null }, notes };
}

/** The webhook: STUDIO_COMM_WEBHOOK (environment, then .env), else STUDIO_REPORT_WEBHOOK. { url, source, name } or null. */
export function commWebhook(env = process.env, root = REPO_ROOT) {
  let url = String(env.STUDIO_COMM_WEBHOOK || '').trim(); let source = 'env';
  if (!url) { const file = {}; try { loadDotEnv(path.join(root, '.env'), file); } catch {} url = String(file.STUDIO_COMM_WEBHOOK || '').trim(); source = '.env'; }
  if (url) return /^https?:\/\/[^\s/]+/i.test(url) ? { url, source, name: 'STUDIO_COMM_WEBHOOK' } : { url: null, bad: true, source, name: 'STUDIO_COMM_WEBHOOK' };
  const r = webhookFrom(env, root);
  return r ? { ...r, name: 'STUDIO_REPORT_WEBHOOK' } : null;
}
/** On or off, and why. */
export function commEnabled({ env = process.env, root = REPO_ROOT, hook = commWebhook(env, root), config = readCommConfig(root) } = {}) {
  const sw = String(env.STUDIO_COMM || '').trim().toLowerCase();
  if (/^(off|0|no|false)$/.test(sw)) return { on: false, why: 'STUDIO_COMM=off' };
  if (!hook?.url) return { on: false, why: hook?.bad ? `${hook.name} isn't an http(s) URL` : 'no webhook (STUDIO_COMM_WEBHOOK or STUDIO_REPORT_WEBHOOK, in the environment or .env)' };
  if (hook.name === 'STUDIO_COMM_WEBHOOK' || config.exists || /^(on|1|yes|true)$/.test(sw)) return { on: true, why: '' };
  return { on: false, why: `only the report webhook is set: add ${CONFIG_REL} or STUDIO_COMM=on to post status and alerts there` };
}

// ---- facts ---------------------------------------------------------------------------------------------------------

/** The Line Producer's status (.studio/line/status.json), normalized: { running, target, text, blocked, fresh } or null. */
export function readLineStatus(root = REPO_ROOT, now = Date.now()) {
  const f = path.join(root, '.studio', 'line', 'status.json');
  const s = readJson(f, null);
  if (!s || typeof s !== 'object') return null;
  let at = Date.parse(s.at || s.ts || '');
  if (!Number.isFinite(at)) { try { at = fs.statSync(f).mtimeMs; } catch { at = 0; } }
  const b = s.builders && typeof s.builders === 'object' ? s.builders : s;
  const pick = (...ks) => { for (const k of ks) { const v = Number(b[k]); if (b[k] !== undefined && b[k] !== null && Number.isFinite(v)) return v; } return null; };
  const running = pick('running', 'busy', 'active', 'now');
  const target = pick('target', 'want', 'wanted', 'n', 'goal');
  const blocked = (Array.isArray(s.blocked) ? s.blocked : []).slice(0, 5).map((x) => (typeof x === 'string' ? x : `${x?.task || x?.id || '?'}: ${x?.why || x?.reason || '?'}`)).map((x) => short(x, 100));
  return { running, target, text: short(s.text || s.line || s.summary || '', 200), blocked, at, fresh: now - at <= LINE_FRESH_MS && now - at >= -60000 };
}

/**
 * Everything a post is built from, read once. deps (tests): { events, needs, beta, delegated, machine }. Never throws on
 * a missing source: each one that can't be read is left out.
 */
export async function commFacts({ root = REPO_ROOT, env = process.env, now = Date.now(), state = {}, deps = {} } = {}) {
  const events = deps.events || readRecentEvents(20000);
  const sup = readJson(path.join(root, '.studio', 'supervisor.json'), null);
  const supRunning = sup?.status === 'running' && (!sup.pid || alive(sup.pid));
  const supT0 = Date.parse(sup?.startedAt || '');
  const t0 = supRunning && Number.isFinite(supT0) ? supT0 : Number.isFinite(Date.parse(state.t0 || '')) ? Date.parse(state.t0) : now;
  let brief = null;
  try { brief = await (await import('./brief-status.mjs')).briefFacts({ root, since: new Date(t0).toISOString(), now, events, env }); } catch {}
  const f = { now, t0, supRunning, sup, events, brief, workers: brief?.workers || [], landed: brief?.landed || [], blockers: brief?.blockers || [] };
  f.perHour = Math.round((f.landed.length / Math.max(0.25, (now - t0) / 3600000)) * 10) / 10;
  // The train: the running one, else the last one's end; the queue.
  f.train = brief?.train || null;
  const lock = readJson(path.join(root, '.studio', 'locks', 'train.lock'), null);
  f.trainLock = lock && lock.pid ? { ...lock, dead: !alive(lock.pid) } : null;
  const starts = events.filter((e) => e.type === 'task.train.start' && e.meta?.train);
  const ends = events.filter((e) => /^task\.train\.(done|died|dead|crashed)$/.test(e.type) && e.meta?.train);
  const lastEnd = ends[ends.length - 1] || null;
  if (lastEnd) { const st = starts.filter((e) => e.meta.train === lastEnd.meta.train).pop(); f.lastTrain = { id: lastEnd.meta.train, at: Date.parse(lastEnd.ts) || 0, ms: st ? (Date.parse(lastEnd.ts) || 0) - (Date.parse(st.ts) || 0) : null, msg: short(String(lastEnd.msg || '').replace(/^train \S+:\s*/, ''), 110), died: lastEnd.type !== 'task.train.done' }; }
  const endedIds = new Set(ends.map((e) => e.meta.train));
  f.unendedTrains = starts.filter((e) => !endedIds.has(e.meta.train) && (!lock?.id || lock.id !== e.meta.train) && now - (Date.parse(e.ts) || 0) > 2 * 60000 && now - (Date.parse(e.ts) || 0) < 12 * 3600000).map((e) => ({ id: e.meta.train, at: Date.parse(e.ts) || 0 }));
  const q = readJson(path.join(root, '.studio', 'train', 'queue.json'), []);
  f.queue = Array.isArray(q) ? q.filter((e) => e && e.task) : [];
  f.held = f.queue.filter((e) => e.held && !(e.released && e.released.head === e.head));
  // The rig: the last scan (the supervisor's pass sampled it just before), never a new one from here.
  let machine = deps.machine;
  if (machine === undefined) { try { const m = await import('./machine.mjs'); machine = m.readMachine({ root, env, scan: false, maxAgeMs: 30 * 60000, now }); f.rigLine = m.machineLine(machine); const d = m.diskBudget({ root, env, profile: machine }); f.diskFreeGb = d.freeGb; } catch { machine = null; } }
  else { try { const m = await import('./machine.mjs'); f.rigLine = machine ? m.machineLine(machine) : ''; } catch {} f.diskFreeGb = machine?.disk?.freeGb ?? null; }
  if (!f.rigLine && brief?.machine) f.rigLine = brief.machine;
  // API $ since T0, when the sessions report it or studio/prices.json prices them.
  try {
    const a = await import('./autonomy.mjs');
    const se = events.filter((e) => e.type === 'agent.session.end' && (Date.parse(e.ts) || 0) > t0);
    const d = a.dollarsOf(se, a.readPrices(root), a.readPriceMultipliers(root));
    if (d.reported + d.priced > 0) f.api = { usd: Math.round(d.usd * 100) / 100, sessions: d.reported + d.priced, unpriced: d.unpriced };
  } catch {}
  // Waiting on a yes.
  try { f.needs = deps.needs || await (await import('./digest.mjs')).needsPerson({ now, root, events }); } catch { f.needs = []; }
  try { f.asks = fs.readdirSync(path.join(root, 'studio', 'asks')).filter((n) => /^A-\d+\.json$/.test(n)).sort().map((n) => readJson(path.join(root, 'studio', 'asks', n))).filter((x) => x && x.status === 'open'); } catch { f.asks = []; }
  // Beta mode and delegation: may the orchestrator do it itself?
  try { f.beta = deps.beta !== undefined ? deps.beta : (await import('./beta-mode.mjs')).readBeta({ root }); } catch { f.beta = { on: false }; }
  f.config = readCommConfig(root);
  f.delegatedRelease = false;
  if (deps.delegated !== undefined) f.delegatedRelease = Boolean(deps.delegated);
  else if (f.config.agents.orchestrator) {
    try { const d = await import('./delegation.mjs'); f.delegatedRelease = Boolean(d.delegationFor({ action: 'train-release', by: f.config.agents.orchestrator, env: { STUDIO_LOCK_OWNER: f.config.agents.orchestrator }, root, now, lane: false, autonomy: false }).ok); } catch {}
  }
  f.line = readLineStatus(root, now);
  f.stopFiles = [];
  const stopJson = readJson(path.join(root, '.studio', 'STOP.json'), null) || (fs.existsSync(path.join(root, '.studio', 'STOP.json')) ? { by: 'unknown' } : null);
  if (stopJson) f.stopFiles.push({ key: 'studio', text: `the studio is stopped${stopJson.by ? ` by ${short(stopJson.by, 40)}` : ''}${stopJson.reason ? `: ${short(stopJson.reason, 100)}` : ''} (no new tasks start)` });
  if (fs.existsSync(path.join(root, '.studio', 'supervisor-stop'))) f.stopFiles.push({ key: 'supervisor', text: 'npm run studio:stop was asked: the supervisor is stopping (agents finish their task)' });
  f.crewPaused = Object.entries(readJson(path.join(root, '.studio', 'crew-paused.json'), {})?.roles || {}).map(([role, p]) => ({ role, why: short(p?.why || '', 120) }));
  return f;
}

// ---- alerts ----------------------------------------------------------------------------------------------------------

const PATCH_CAN = (f) => Boolean(f.beta?.on);
const OWNER_TOPIC = /\b(money|spend|pay|purchase|buy|budget|price|cost|delete|remove|wipe|direction|vision|pillars?|scope|bible|signature|sign(?:ing)? (?:the )?bible)\b/i;

/**
 * Who must act on an alert. kind: 'fix' (the orchestrator), 'key' (an owner-key step), 'decision' or 'disaster' (the
 * owner). The rule the owner set: never the owner for something the orchestrator can fix.
 */
export function routeAlert(a) {
  if (a.kind === 'disaster') return ['owner', 'orchestrator'];
  if (a.kind === 'decision') return ['owner'];
  if (a.kind === 'key') return ['keys'];
  return ['orchestrator'];
}

/** The alerts open now: [{ key, kind, text }] (text without mentions). */
export function alertsNow(f, { env = process.env, state = {}, passWhy = [] } = {}) {
  const s = commSettings(env);
  const out = [];
  const add = (key, kind, text) => { if (!out.some((x) => x.key === key)) out.push({ key, kind, text: quiet(short(text, 380)) }); };
  const since = Date.parse(state.cursor || '') || f.now - 10 * 60000;
  const fresh = f.events.filter((e) => { const t = Date.parse(e.ts) || 0; return t > since && t <= f.now + 60000; });
  // Trains.
  if (f.trainLock?.dead) add(`train-dead:${f.trainLock.id || 'lock'}`, 'fix', `Train ${f.trainLock.id || '?'} died: its lock is held by pid ${f.trainLock.pid}, which is gone${f.trainLock.at ? ` (started ${hhmm(Number(f.trainLock.at) || Date.parse(f.trainLock.at))})` : ''}. The lanes wait until it is cleared: npm run lanes, then start the train again.`);
  for (const t of f.unendedTrains || []) add(`train-dead:${t.id}`, 'fix', `Train ${t.id} started at ${hhmm(t.at)} and never ended (no done event, no lock): it died silently. npm run lanes`);
  for (const e of fresh) {
    const id = e.meta?.train || '?';
    if (/^task\.train\.(died|dead|crashed)$/.test(e.type)) add(`train-dead:${id}`, 'fix', `Train ${id} died: ${short(String(e.msg || '').replace(/^train \S+:\s*/, ''), 200)}`);
    else if (e.type === 'task.train.red_main') add('train-red-main', 'fix', `Main is red: ${short(String(e.msg || '').replace(/^train \S+:\s*/, ''), 240)}`);
    else if (e.type === 'task.train.red' && !e.meta?.infra && !e.meta?.infrastructure && !e.meta?.flaky && !/flaky|infrastructure|lane copy (?:is )?missing|crlf|re-?queue/i.test(String(e.msg || ''))) add(`train-red:${id}`, 'fix', `Train ${id} is red on real failures: ${short(String(e.msg || '').replace(/^train \S+:\s*/, ''), 240)}`);
    else if (e.type === 'session.stall') add(`stall:${e.task || e.meta?.target || '?'}`, 'fix', `Stuck: ${short(e.msg, 240)}`);
    else if (e.type === 'whole.error') add('harness-error:whole', 'fix', `Harness error (the whole-game check): ${short(e.msg, 240)}`);
    else if (e.type === 'supervisor.hub_restart' && e.status === 'warn') add('harness-error:hub', 'fix', `Harness error: ${short(e.msg, 240)}`);
  }
  const err = (passWhy || []).find((w) => /^error:/i.test(String(w)));
  if (err) add('harness-error:supervisor', 'fix', `Harness error: the supervisor's pass failed (${short(String(err).replace(/^error:\s*/i, ''), 200)}). npm run studio:status`);
  // Builders.
  const builders = f.workers.filter((w) => /^builder/i.test(w.role || '')).length;
  const stopped = f.stopFiles.length > 0 || Boolean(f.sup?.halted) || f.blockers.some((b) => b.kind === 'winddown');
  let low = null;
  if (f.line?.fresh && Number.isFinite(f.line.target) && Number.isFinite(f.line.running) && f.line.running < f.line.target) low = { have: f.line.running, want: f.line.target, from: 'the Line Producer' };
  else if (!f.line?.fresh && s.minBuilders > 0 && f.supRunning && builders < s.minBuilders) low = { have: builders, want: s.minBuilders, from: 'STUDIO_COMM_MIN_BUILDERS' };
  if (low && !stopped && Date.parse(state.lowSince || '') && f.now - Date.parse(state.lowSince) >= LOW_BUILDERS_MS) add('builders-low', 'fix', `Only ${low.have} of ${low.want} builders busy (${low.from}) for ${mins(f.now - Date.parse(state.lowSince))}${f.line?.blocked?.length ? `; blocked: ${f.line.blocked.slice(0, 3).join('; ')}` : ''}.`);
  f.lowNow = Boolean(low && !stopped);
  // The crew breaker, a halt, stop files.
  for (const c of f.crewPaused) add(`breaker:${c.role}`, 'fix', `Crew breaker: launching ${c.role} is paused${c.why ? ` (${c.why})` : ''}. New work clears it, or: npm run crew -- resume ${c.role} --by <name>`);
  if (f.sup?.halted && f.supRunning) add('halted', 'fix', `The supervisor is halted: ${short(f.sup.halted.why || 'no reason recorded', 200)}. npm run studio:resume -- --by <name>`);
  for (const st of f.stopFiles) add(`stop:${st.key}`, 'fix', `Stop file: ${st.text}.`);
  // Stuck lanes: queued, not held, past STUDIO_COMM_STUCK_MIN, no train running.
  if (!f.train) for (const e of f.queue) { const t = Date.parse(e.at || '') || 0; if (!e.held && t && f.now - t >= s.stuckMin * 60000) add(`stuck:${e.task}`, 'fix', `Stuck lane: ${e.task} has waited for the train ${mins(f.now - t)}${e.waitTold ? ` (${short(e.waitTold, 60)})` : ''} and no train is running. npm run lanes`); }
  // Owner-key steps (none in beta mode; the orchestrator's own when it holds a delegation for releases).
  for (const e of f.held) {
    const text = `${e.task} waits for the owner's release (tier ${e.held.tier || 'C'}${e.held.why ? `: ${short(e.held.why, 80)}` : ''}): npm run task -- train release ${e.task} --by <owner>`;
    add(`held:${e.task}`, PATCH_CAN(f) || f.delegatedRelease ? 'fix' : 'key', PATCH_CAN(f) ? `${text} (beta mode: release it --by <your name>)` : text);
  }
  for (const n of f.needs || []) if (n.kind === 'gate' && /protected files/i.test(n.line)) add('protected', PATCH_CAN(f) ? 'fix' : 'key', `Owner-key step: ${n.line}`);
  // Owner decisions.
  for (const a of f.asks) {
    const ownerTopic = OWNER_TOPIC.test(`${a.question || ''} ${a.why || ''}`);
    add(`ask:${a.id}`, PATCH_CAN(f) && !ownerTopic ? 'fix' : 'decision', `Question ${a.id}${a.by ? ` from ${short(a.by, 30)}` : ''}: "${short(a.question, 160)}"${Array.isArray(a.options) && a.options.length ? ` (${cut(a.options.map(String), 4)}${a.default ? `; default ${a.default}` : ''})` : ''}: npm run ask -- answer ${a.id} "<answer>" --by <name>`);
  }
  for (const n of f.needs || []) {
    if (n.kind === 'spend') add('spend', 'decision', `Money: ${n.line}`);
    else if (n.kind === 'policy') add('policy', 'decision', `Decision: ${n.line}`);
  }
  // Disasters.
  if (Number.isFinite(f.diskFreeGb) && s.diskGb > 0 && f.diskFreeGb < s.diskGb) add('disk-low', 'disaster', `Disk low: ${f.diskFreeGb} GB free (under ${s.diskGb} GB). npm run janitor frees old lane copies.`);
  const hour = f.events.filter((e) => (Date.parse(e.ts) || 0) > f.now - 3600000 && (e.type === 'supervisor.hub_restart' || e.type === 'supervisor.halted' || e.type === 'harness.crash' || /^task\.train\.(died|dead|crashed)$/.test(e.type)));
  if (hour.length >= s.crashes) add('crashes', 'disaster', `Repeated crashes: ${hour.length} in the last hour (${cut([...new Set(hour.map((e) => e.type.replace(/^supervisor\.|^task\./, '')))], 4)}).`);
  const trainRunning = Boolean(f.train) || Boolean(f.trainLock && !f.trainLock.dead);
  f.blockedNow = f.supRunning && f.workers.length === 0 && !trainRunning && (f.blockers.length > 0 || f.stopFiles.length > 0);
  if (f.blockedNow && Date.parse(state.blockedSince || '') && f.now - Date.parse(state.blockedSince) >= s.blockedMin * 60000) add('all-blocked', 'disaster', `Everything is blocked for ${mins(f.now - Date.parse(state.blockedSince))}: no agent and no train running; ${short(f.blockers.map((b) => (b.ids ? `${b.text}: ${cut(b.ids, 3)}` : b.text)).join('; ') || f.stopFiles.map((x) => x.text).join('; '), 200)}.`);
  return out;
}

// ---- text ----------------------------------------------------------------------------------------------------------

const tag = (role, cfg, { preview = false } = {}) => (!preview && cfg.mentions[role] ? `<@${cfg.mentions[role]}>` : `@${cfg.names[role]}`);
export const alertLine = (a, cfg, opts = {}) => `${routeAlert(a).map((r) => tag(r, cfg, opts)).join(' ')} ${a.text}`;

/** The fixed-format status post (no mentions). */
export function statusText(f, { alerts = [] } = {}) {
  const L = [];
  L.push(`Studio status ${hhmm(f.now)} (run since ${hhmm(f.t0)}, ${mins(f.now - f.t0)}${f.supRunning ? '' : '; no supervisor running'})`);
  L.push(f.workers.length ? `Agents (${f.workers.length}): ${cut(f.workers.map((w) => `${w.agent}${w.task ? ` ${w.task}` : ''}`), 8)}` : 'Agents: none running');
  L.push(`Landed since ${hhmm(f.t0)}: ${f.landed.length} (${f.perHour}/h)${f.landed.length ? `: ${cut(f.landed, 8)}` : ''}`);
  const qn = f.queue.length; const hn = f.held.length;
  const queue = qn ? `; ${qn} lane${qn === 1 ? '' : 's'} queued${hn ? ` (${hn} held)` : ''}` : '';
  if (f.train) L.push(`Train ${f.train.train}${f.train.lanes ? ` (${f.train.lanes} lanes)` : ''}: ${short(String(f.train.text || f.train.step || '').split(';')[0], 80)}${f.train.since ? `, since ${hhmm(Date.parse(f.train.since))}` : ''}${f.train.eta?.text ? `; ${String(f.train.eta.text).replace(/\s*\(.*\)$/, '')}` : ''}${queue}`);
  else if (f.trainLock?.dead) L.push(`Train ${f.trainLock.id || '?'}: dead (its process is gone)${queue}`);
  else L.push(`Train: idle${queue}${f.lastTrain ? `; last ${f.lastTrain.id} ${f.lastTrain.died ? 'died' : 'ended'} ${hhmm(f.lastTrain.at)}${f.lastTrain.ms ? ` after ${mins(f.lastTrain.ms)}` : ''}${f.lastTrain.msg ? `: ${f.lastTrain.msg}` : ''}` : ''}`);
  L.push(f.rigLine ? f.rigLine.replace(/^Machine:/, 'Rig:') : 'Rig: no recent machine scan');
  if (f.api) L.push(`API: $${f.api.usd.toFixed(2)} since ${hhmm(f.t0)} (${f.api.sessions} session${f.api.sessions === 1 ? '' : 's'}${f.api.unpriced ? `; ${f.api.unpriced} unpriced` : ''})`);
  if (f.line && (f.line.text || Number.isFinite(f.line.target))) L.push(`Line Producer: ${f.line.text || `${f.line.running ?? '?'} of ${f.line.target} builders busy`}${f.line.fresh ? '' : ' (stale)'}`);
  const bl = f.blockers.map((b) => (b.ids ? `${b.text}: ${cut(b.ids, 4)}` : b.text));
  for (const b of f.line?.blocked || []) bl.push(b);
  L.push(bl.length ? `Blocked: ${short(bl.join('; '), 400)}` : 'Blocked: nothing');
  const needs = f.needs || [];
  L.push(needs.length ? `Waiting on yes (${needs.length}): ${short(needs.slice(0, 3).map((n) => short(n.line, 110)).join('; '), 400)}${needs.length > 3 ? ` +${needs.length - 3} more` : ''}` : 'Waiting on yes: nothing');
  L.push(f.beta?.on ? `Beta mode: on (set by ${short(f.beta.doc?.by || '?', 30)}${Number.isFinite(Date.parse(f.beta.doc?.at || '')) ? ` at ${hhmm(Date.parse(f.beta.doc.at))}` : ''}; owner gates off, every use logged)` : 'Beta mode: off');
  if (alerts.length) L.push(`Open alerts (${alerts.length}): ${cut(alerts.map((a) => a.key), 6)}`);
  return quiet(L.join('\n'));
}

/** Parts of at most `max` characters, cut at line ends; a longer line is cut at a space, never inside a mention. */
export function splitSafe(text, max = DISCORD_MAX) {
  const parts = []; let cur = '';
  const push = () => { if (cur) parts.push(cur); cur = ''; };
  for (let line of String(text || '').split('\n')) {
    while (line.length > max) {
      let at = line.lastIndexOf(' ', max);
      const open = line.lastIndexOf('<@', at > 0 ? at : max);
      if (open >= 0 && line.indexOf('>', open) >= (at > 0 ? at : max)) at = open;
      if (at <= 0) at = max;
      push(); parts.push(line.slice(0, at)); line = line.slice(at).replace(/^ /, '');
    }
    if (cur && cur.length + 1 + line.length > max) push();
    cur = cur ? `${cur}\n${line}` : line;
  }
  push();
  return parts.length ? parts : [''];
}

/** The request bodies for one post: Discord parts with username and only the ids tagged in each part. */
export function commPayloads(text, format, { username = DEFAULT_USERNAME, kind = 'status', now = Date.now() } = {}) {
  const ids = (p) => [...new Set([...p.matchAll(/<@(\d+)>/g)].map((m) => m[1]))].slice(0, 100);
  if (format === 'discord') return splitSafe(text).map((content) => ({ content, username, allowed_mentions: { parse: [], users: ids(content) } }));
  if (format === 'slack') return [{ text, username }];
  return [{ what: 'comm', kind, text, username, mentions: ids(text), at: new Date(now).toISOString() }];
}

async function send(hook, text, { kind, env, cfg, now, deps = {} }) {
  const format = formatFor(hook.url, env);
  const bodies = commPayloads(text, format, { username: cfg.username, kind, now });
  let sent = 0; let res = { ok: true, attempts: 0 };
  for (const b of bodies) {
    res = await postOnce(hook.url, b, { fetchImpl: deps.fetchImpl || globalThis.fetch, sleep: deps.sleep || ((ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5000)))), timeoutMs: 10000 });
    if (!res.ok) break;
    sent += 1;
  }
  const why = res.ok ? '' : scrub(res.why || 'failed', hook.url);
  return { ok: res.ok, format, parts: bodies.length, sent, why, target: maskWebhook(hook.url) };
}

// ---- the pass --------------------------------------------------------------------------------------------------------

/**
 * One pass (the supervisor's, once per loop). { posted, kind, alerts, status, why, text? }. dryRun: nothing is sent or
 * written; the text comes back. passWhy: the supervisor's reasons for this pass (an "error: …" is a harness error).
 * Never throws.
 */
export async function communicatorPass({ now = Date.now(), dryRun = false, env = process.env, root = REPO_ROOT, passWhy = [], deps = {} } = {}) {
  let hook = null;
  try {
    hook = commWebhook(env, root);
    const cfg = readCommConfig(root);
    const en = commEnabled({ env, root, hook, config: cfg });
    if (!en.on && !dryRun) return { posted: false, why: en.why };
    const s = commSettings(env);
    const st = readJson(stateFile(root), {}) || {};
    if (!st.t0) st.t0 = new Date(now).toISOString();
    st.sent = st.sent && typeof st.sent === 'object' ? st.sent : {};
    const f = await commFacts({ root, env, now, state: st, deps });
    if (f.supRunning && f.sup?.startedAt && st.runStartedAt !== f.sup.startedAt) { st.runStartedAt = f.sup.startedAt; st.lastStatusAt = null; }
    const open = alertsNow(f, { env, state: st, passWhy });
    // Conditions that must last before they alert.
    st.lowSince = f.lowNow ? st.lowSince || new Date(now).toISOString() : null;
    st.blockedSince = f.blockedNow ? st.blockedSince || new Date(now).toISOString() : null;
    const quietNow = inQuiet(s.quiet, now);
    const due = []; const held = [];
    for (const a of open) {
      const who = routeAlert(a);
      const last = st.sent[a.key];
      const gap = a.kind === 'disaster' ? s.dedupMin : Math.max(s.dedupMin, last?.cleared === false ? s.repeatMin : s.dedupMin);
      if (last && now - (Date.parse(last.at) || 0) < gap * 60000) continue;
      if (quietNow && a.kind !== 'disaster' && who.length === 1 && who[0] === 'owner') { held.push(a.key); continue; }
      due.push(a);
    }
    const openKeys = new Set(open.map((a) => a.key));
    const cleared = Object.keys(st.sent).filter((k) => st.sent[k].cleared === false && !openKeys.has(k));
    const lastStatus = Date.parse(st.lastStatusAt || '') || 0;
    const retryOk = now - (Date.parse(st.failedAt || '') || 0) >= RETRY_MS;
    const statusDue = now - lastStatus >= s.statusMin * 60000;
    const doStatus = statusDue && retryOk;
    const doAlerts = due.length > 0 && retryOk;
    // 2.77.0 (u, P5.5): notices other harness parts queued (the visual check's shots for the owner): one path line each,
    // posted once, tagging nobody (harness/visual-check.mjs postShots writes .studio/comm/notices.jsonl).
    const notices = retryOk ? pendingNotices(root, st) : [];
    const L = [];
    if (doAlerts) { L.push(`Studio alert ${hhmm(now)}`); for (const a of due) L.push(alertLine(a, cfg)); }
    if (notices.length) { if (L.length) L.push(''); L.push(`Studio notice ${hhmm(now)}`); for (const n of notices) L.push(quiet(short(n.text, 600))); }
    if ((doAlerts || doStatus) && cleared.length) L.push(`Cleared: ${cut(cleared, 6)}`);
    if (doStatus) { if (L.length) L.push(''); L.push(statusText(f, { alerts: open })); }
    const text = L.join('\n');
    const kind = doAlerts && doStatus ? 'alerts+status' : doAlerts ? 'alerts' : doStatus ? 'status' : notices.length ? 'notices' : null;
    const result = { posted: false, kind, alerts: due.map((a) => ({ key: a.key, kind: a.kind, who: routeAlert(a) })), held, cleared, open: open.length };
    if (dryRun) return { ...result, dryRun: true, text, enabled: en };
    if (kind) {
      const r = await send(hook, text, { kind, env, cfg, now, deps });
      result.posted = r.ok; result.parts = r.parts; result.why = r.why || '';
      if (r.ok) {
        st.failedAt = null;
        if (doStatus) st.lastStatusAt = new Date(now).toISOString();
        for (const a of due) st.sent[a.key] = { at: new Date(now).toISOString(), kind: a.kind, who: routeAlert(a), count: (st.sent[a.key]?.count || 0) + 1, cleared: false };
        for (const k of cleared) st.sent[k].cleared = true;
        st.notices = [...(st.notices || []), ...notices.map((n) => n.key)].slice(-200);
      } else st.failedAt = new Date(now).toISOString();
      st.lastPost = { at: new Date(now).toISOString(), kind, ok: r.ok, parts: r.parts, sent: r.sent, why: r.why || null };
      try { emitEvent({ type: 'comm.posted', agent: 'communicator', to: 'human', status: r.ok ? 'ok' : 'error', msg: r.ok ? `Posted ${kind}${due.length ? ` (${due.length} alert${due.length === 1 ? '' : 's'}: ${cut(due.map((a) => a.key), 4)})` : ''}` : `Couldn't post ${kind}: ${r.why}`, meta: { kind, ok: r.ok, parts: r.parts, sent: r.sent, alerts: due.map((a) => a.key), tagged: [...new Set(due.flatMap(routeAlert))], held, source: hook.source } }); } catch {}
    }
    // Forget alerts that closed long ago (a week).
    for (const k of Object.keys(st.sent)) if (st.sent[k].cleared && now - (Date.parse(st.sent[k].at) || 0) > 7 * 86400000) delete st.sent[k];
    st.held = held.map((k) => ({ key: k, since: (st.held || []).find((h) => h.key === k)?.since || new Date(now).toISOString() }));
    st.cursor = new Date(Math.max(now, Date.parse(st.cursor || '') || 0)).toISOString();
    st.checkedAt = new Date(now).toISOString();
    writeJson(stateFile(root), st);
    return result;
  } catch (e) {
    return { posted: false, why: scrub(`the communicator failed: ${e?.message || e}`, hook?.url).slice(0, 300) };
  }
}

/**
 * 2.77.0 (u): notices queued in .studio/comm/notices.jsonl ({ key, kind, text, at }) not posted yet (state.notices
 * holds the keys posted), the last 20 of the past day. queueNotice adds one.
 */
export function pendingNotices(root = REPO_ROOT, st = {}, now = Date.now()) {
  let lines = [];
  try { lines = fs.readFileSync(path.join(root, '.studio', 'comm', 'notices.jsonl'), 'utf8').split('\n').filter(Boolean); } catch { return []; }
  const sent = new Set(st.notices || []);
  const out = [];
  for (const l of lines.slice(-200)) { try { const n = JSON.parse(l); if (n?.key && n.text && !sent.has(n.key) && now - (Date.parse(n.at) || 0) < 86400000 && !out.some((x) => x.key === n.key)) out.push(n); } catch {} }
  return out.slice(-20);
}
export function queueNotice({ key, text, kind = 'notice', root = REPO_ROOT } = {}) {
  const f = path.join(root, '.studio', 'comm', 'notices.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, `${JSON.stringify({ key: key || `${kind}:${Date.now()}`, kind, text: String(text || '').slice(0, 1000), at: new Date().toISOString() })}\n`);
}

/** `comm -- status`: the set-up and the state, nothing secret. */
export function commStatus({ env = process.env, root = REPO_ROOT, now = Date.now() } = {}) {
  const hook = commWebhook(env, root);
  const cfg = readCommConfig(root);
  const en = commEnabled({ env, root, hook, config: cfg });
  const s = commSettings(env);
  const st = readJson(stateFile(root), {}) || {};
  const last = Date.parse(st.lastStatusAt || '') || 0;
  return {
    on: en.on, why: en.why, webhook: hook?.url ? `${maskWebhook(hook.url)} (${hook.name}, from ${hook.source})` : 'none', username: cfg.username,
    tags: Object.fromEntries(ROLES.map((r) => [r, cfg.mentions[r] ? `@${cfg.names[r]} (<@${cfg.mentions[r]}>)` : `@${cfg.names[r]} (no id: written, not tagged)`])),
    notes: cfg.notes, settings: s, quietNow: inQuiet(s.quiet, now),
    lastStatusAt: st.lastStatusAt || null, nextStatus: last ? new Date(last + s.statusMin * 60000).toISOString() : 'next pass',
    lastPost: st.lastPost || null, recent: Object.entries(st.sent || {}).filter(([, v]) => now - (Date.parse(v.at) || 0) < 86400000).map(([k, v]) => ({ key: k, at: v.at, who: v.who, count: v.count, open: v.cleared === false })), held: st.held || [],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const usage = 'Usage: npm run comm -- status|preview|test [--json]   (posts to STUDIO_COMM_WEBHOOK or STUDIO_REPORT_WEBHOOK; tags from studio/communicator.json)';
  const cmd = argv[0] || 'status';
  const json = argv.includes('--json');
  if (argv.includes('--help') || argv.includes('-h')) { console.log(usage); process.exit(0); }
  if (cmd === 'status') {
    const r = commStatus();
    if (json) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }
    console.log(`[comm] ${r.on ? 'on' : `off (${r.why})`}; webhook: ${r.webhook}; posts as "${r.username}"`);
    console.log(`[comm] tags: ${ROLES.map((k) => `${k} ${r.tags[k]}`).join('; ')}`);
    for (const n of r.notes) console.log(`[comm] note: ${n}`);
    console.log(`[comm] status every ${r.settings.statusMin} min (last ${r.lastStatusAt ? hhmm(Date.parse(r.lastStatusAt)) : 'never'}); an alert at most once per ${r.settings.dedupMin} min, again while open every ${r.settings.repeatMin} min; quiet hours ${r.settings.quiet || 'off'}${r.quietNow ? ' (now)' : ''}`);
    if (r.lastPost) console.log(`[comm] last post ${hhmm(Date.parse(r.lastPost.at))}: ${r.lastPost.kind}, ${r.lastPost.ok ? 'sent' : `failed (${r.lastPost.why})`}`);
    for (const x of r.recent) console.log(`[comm] ${x.open ? 'open' : 'cleared'} ${x.key}: tagged ${x.who.join(', ')} at ${hhmm(Date.parse(x.at))}${x.count > 1 ? ` (${x.count} times)` : ''}`);
    for (const h of r.held) console.log(`[comm] held for quiet hours: ${h.key} since ${hhmm(Date.parse(h.since))}`);
    process.exit(0);
  }
  if (cmd === 'preview') {
    const root = REPO_ROOT; const env = process.env; const now = Date.now();
    const cfg = readCommConfig(root);
    const st = readJson(stateFile(root), {}) || {};
    const f = await commFacts({ root, env, now, state: { ...st, cursor: new Date(now - 30 * 60000).toISOString() } });
    const open = alertsNow(f, { env, state: { ...st, cursor: new Date(now - 30 * 60000).toISOString() } });
    const text = [...(open.length ? [`Studio alert ${hhmm(now)}`, ...open.map((a) => alertLine(a, cfg, { preview: true })), ''] : []), statusText(f, { alerts: open })].join('\n');
    const hook = commWebhook(env, root);
    const en = commEnabled({ env, root, hook, config: cfg });
    if (json) { console.log(JSON.stringify({ on: en.on, why: en.why, target: hook?.url ? maskWebhook(hook.url) : 'none', username: cfg.username, alerts: open.map((a) => ({ ...a, who: routeAlert(a).map((r) => `@${cfg.names[r]}`) })), text }, null, 2)); process.exit(0); }
    console.log(`[comm] preview as "${cfg.username}" to ${hook?.url ? maskWebhook(hook.url) : 'no webhook'}${en.on ? '' : ` (off: ${en.why})`}. Nothing was sent.\n`);
    console.log(text);
    process.exit(0);
  }
  if (cmd === 'test') {
    const env = process.env; const root = REPO_ROOT;
    const hook = commWebhook(env, root);
    if (!hook?.url) { console.error(`[comm] not sent: ${hook?.bad ? `${hook.name} isn't an http(s) URL` : 'no webhook set: put STUDIO_COMM_WEBHOOK (or STUDIO_REPORT_WEBHOOK) in the environment or the studio\'s .env (never commit it)'}`); process.exit(1); }
    const cfg = readCommConfig(root);
    const tagged = ROLES.filter((r) => cfg.mentions[r]).map((r) => cfg.names[r]);
    const r = await send(hook, `${cfg.username} test ${hhmm(Date.now())}: the Communicator can post here. Tags set up for: ${tagged.length ? tagged.join(', ') : 'no one yet'} (${CONFIG_REL}); no one is tagged by this test.`, { kind: 'test', env, cfg, now: Date.now() });
    try { emitEvent({ type: 'comm.posted', agent: 'communicator', to: 'human', status: r.ok ? 'ok' : 'error', msg: r.ok ? 'Posted the test line' : `Couldn't post the test line: ${r.why}`, meta: { kind: 'test', ok: r.ok, parts: r.parts, source: hook.source } }); } catch {}
    if (r.ok) console.log(`[comm] posted the test line to ${r.target} (${r.format}).`);
    else console.error(`[comm] not posted: ${r.why} (${r.target})`);
    process.exit(r.ok ? 0 : 1);
  }
  console.error(usage);
  process.exit(2);
}
