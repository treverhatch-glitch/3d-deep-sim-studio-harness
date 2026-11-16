#!/usr/bin/env node
/**
 * harness/ask.mjs — questions for the game dev, with a deadline and a default the Producer stands behind.
 *   npm run ask -- "<question>" --options "a,b,c" --default b --timeout 4h [--why "…"] [--by producer-1] [--task T-1]
 *   npm run ask -- answer A-001 "<option or words>" --by <name>
 *   npm run ask -- reverse A-001 "<option or words>" --by <name>   undo a decision made without you
 *   npm run ask -- list [--open] | show A-001 | help | followed A-001 --task T-1 | --none "why" --by <name> (2.90)
 * A question shows under "Needs you" in every War Room view and in the Game plan. If nobody answers by the deadline, the
 * default is applied: logged as decision.timeout, written to studio/decisions/decided-without-you.md; the dev can reverse it.
 * Never on a timer: signing the Bible, changing pillars, bringing back a crossed-out layer, or deleting anything. An ask with
 * a --default and no --timeout gets STUDIO_ASK_TIMEOUT_H (4) hours; one that cannot decide itself is escalated once at
 * STUDIO_ASK_STALE_H (8) hours (ask.stale). The owner's own asks (harness/owner-acts.mjs) get no deadline.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent } from './event.mjs';
import { proxyShell } from './owner-proxy.mjs';
import { betaActor } from './beta-mode.mjs';
import { ownerOnlyTopic, ownerOnlyWhy, ownerOnlyReadAs } from './owner-acts.mjs';
import { selfNamingShell, DECIDER_ROLES, WORKER_NAME } from './permission.mjs';
import { logDecision } from './decisions-log.mjs';
import { doneExit as out, flagOf, readJsonOrNull as read } from './helpers.mjs';

export const ASKS_DIR = path.join(REPO_ROOT, 'studio', 'asks');
const LOG = path.join(REPO_ROOT, 'studio', 'decisions', 'decided-without-you.md');
// What never gets a timer: signing, pillars, bringing back a crossed-out layer, deleting.
const PROTECTED_CORE = /\b(sign|re-?sign|signature|pillars?|crossed[- ]out|bring back|delete|remove (?:the )?repo|wipe)\b/i;
// Names agents use (a role, a tool or a model, often with -1, -auto-2 …): they can't answer for a person.
const AGENTISH = /^(prod|producer|director|builder|rnd|qa|qa-playtester|playtester|reviewer|planner|art|artist|scout|reference-scout|designer|balancer|agent|watch|unknown|codex|claude|gemini|agy|gpt|grok|opus|sonnet|haiku|cursor|aider|hermes)\b/i;
export const isAgent = (by) => AGENTISH.test(by) || by === process.env.STUDIO_LOCK_OWNER || by === process.env.STUDIO_PRODUCER_NAME;

export function allAsks() {
  if (!fs.existsSync(ASKS_DIR)) return [];
  return fs.readdirSync(ASKS_DIR).filter((f) => /^A-\d+\.json$/.test(f)).sort().map((f) => read(path.join(ASKS_DIR, f))).filter(Boolean);
}
export const openAsks = () => allAsks().filter((a) => a.status === 'open');
/** 2.90: when an open ask's default applies (ms), or null when it never does (the owner's, protected, or no default). */
export function askDueAt(a, now = Date.now(), env = process.env) {
  if (askOwnerTopic(a) || a.protected) return null;
  const set = a.deadline ? Date.parse(a.deadline) : null;
  const H = askTimeoutMs(env);
  if (set != null) return Number.isFinite(set) ? set : null;
  return a.default && H > 0 && (!a.options?.length || a.options.includes(a.default)) ? (Date.parse(a.at) || now) + H : null;
}
/** 2.90: the open asks that still wait for a person: not past the time their default applies (expireAsks decides those). */
export const waitingAsks = (now = Date.now(), env = process.env) => openAsks().filter((a) => { const due = askDueAt(a, now, env); return due == null || due > now; });
const write = (a) => {
  fs.mkdirSync(ASKS_DIR, { recursive: true });
  fs.writeFileSync(path.join(ASKS_DIR, `${a.id}.json`), `${JSON.stringify(a, null, 2)}\n`);
  return a;
};

export function parseDuration(s) {
  const m = String(s || '').trim().match(/^(\d+(?:\.\d+)?)\s*(m|min|h|d)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return n * ({ m: 60000, min: 60000, h: 3600000, d: 86400000 }[(m[2] || 'h').toLowerCase()]);
}

/** 2.85: hours as milliseconds from a setting (off/0: none). */
const hoursMs = (v, d) => { const s = String(v ?? '').trim(); if (/^(off|no|false)$/i.test(s)) return 0; const n = s === '' ? d : Number(s); return Number.isFinite(n) && n > 0 ? n * 3600000 : 0; };
/** 2.85: STUDIO_ASK_TIMEOUT_H (4): the deadline an ask with a default and no --timeout gets. */
export const askTimeoutMs = (env = process.env) => hoursMs(env.STUDIO_ASK_TIMEOUT_H, 4);
/** 2.85: STUDIO_ASK_STALE_H (8): when an ask that cannot decide itself is escalated, once. */
export const askStaleMs = (env = process.env) => hoursMs(env.STUDIO_ASK_STALE_H, 8);
/** The owner-only entry an ask is about, or null. */
export const askOwnerTopic = (a) => ownerOnlyTopic(a?.question, a?.why);

export function ask({ question, options = [], def = null, timeout = null, why = '', by = process.env.STUDIO_LOCK_OWNER || process.env.STUDIO_PRODUCER_NAME || 'producer', action = null, task = null, now = Date.now(), env = process.env }) {
  const q = String(question || '').trim();
  if (!q) return { ok: false, message: 'Ask something: npm run ask -- "<question>" --options "a,b" --default a --timeout 4h' };
  const opts = (Array.isArray(options) ? options : String(options).split(',')).map((o) => o.trim()).filter(Boolean);
  // 2.83: owner-only words read as something else (code removed in a lane) are recorded (readAs).
  const readAs = ownerOnlyReadAs(q, why);
  const protectedTopic = PROTECTED_CORE.test(q);
  const own = ownerOnlyTopic(q, why);
  const noTimer = protectedTopic || Boolean(own);
  let deadline = null;
  let deadlineFrom = null;
  if (timeout && !noTimer) {
    const ms = parseDuration(timeout);
    if (!ms) return { ok: false, message: `--timeout is a length like 30m, 4h or 1d (got "${timeout}")` };
    if (!def) return { ok: false, message: 'A question with a deadline needs --default: what the Producer will do if nobody answers.' };
    if (opts.length && !opts.includes(def)) return { ok: false, message: `--default must be one of the options (${opts.join(', ')})` };
    if (!why) return { ok: false, message: 'Say why that default is the right call if nobody answers: --why "…" (it is shown with the decision).' };
    deadline = new Date(now + ms).toISOString();
  } else if (!timeout && def && !noTimer && askTimeoutMs(env) > 0 && (!opts.length || opts.includes(def))) {
    // 2.85 (item 3): a default and no --timeout: STUDIO_ASK_TIMEOUT_H, so the ask never blocks a thread for good.
    deadline = new Date(now + askTimeoutMs(env)).toISOString();
    deadlineFrom = 'STUDIO_ASK_TIMEOUT_H';
  }
  const n = allAsks().length + 1;
  const a = write({ id: `A-${String(n).padStart(3, '0')}`, question: q.slice(0, 500), options: opts, default: def, why: String(why).slice(0, 500), by, at: new Date(now).toISOString(), deadline, ...(deadlineFrom ? { deadlineFrom } : {}), protected: protectedTopic, status: 'open', ...(action ? { action } : {}), ...(/^[A-Z]+-\d+$/.test(String(task || '')) ? { task: String(task) } : {}), ...(own ? { ownerOnly: own.act } : {}), ...(readAs.length ? { readAs } : {}) });
  emitEvent({ type: 'ask.open', agent: by, to: 'human', msg: `${a.id} for the game dev: ${a.question}${deadline ? ` (if no answer by ${deadline.slice(11, 16)} UTC: "${def}")` : ''}`, ...(readAs.length ? { meta: { ask: a.id, readAs } } : {}) });
  const note = noTimer && (timeout || def) ? (own ? `This is about ${own.what}, which only the owner answers: no deadline.` : 'This is about signing, pillars or deleting, so it waits for a person: no deadline.') : null;
  return { ok: true, ask: a, note };
}

/**
 * 2.79 (c): what kind of decision answering this ask is (permission.mjs mayDecide's kinds): an owner-only act's name
 * (harness/owner-acts.mjs: delete, credentials, publish, tools, beta-off), 'protected' when it is about a protected file,
 * gate, test, hook or approval, else 'board' (a budget, a hire, a plan …).
 */
const PROTECTED_ASK = /\bprotected\b|\bre-?pin|\bgolden|\bweaken|\bhooks?\b|\bgates?\b|\bapprov(?:e|al)\b|qa\.mjs|controls list|--force\b/i;
export function askKind(a) {
  const own = askOwnerTopic(a);
  if (own) return own.act;
  return PROTECTED_ASK.test(`${a?.question || ''}\n${a?.why || ''}`) ? 'protected' : 'board';
}

/**
 * The owner's stand-in in this shell: the owner proxy, or a beta-mode actor (beta mode's named agents, an outside signer,
 * a Producer/Director session), for this kind of decision. { owner, agent, via } | { refused } | null. `by` names the
 * agent in a shell the harness didn't launch and that names nobody (2.79 (c): --by grokbot, --by opus-1).
 * 2.84 (g): exported: `npm run review -- same-family` records its caller the same way.
 */
export function ownerStandIn(env = process.env, { by = '', kind = 'board' } = {}) {
  const said = selfNamingShell(env) && by ? { ...env, STUDIO_LOCK_OWNER: String(by).trim() } : env;
  try { const p = proxyShell({ env: said }); if (p.ok) return kind === 'board' || kind === 'protected' ? { owner: String(p.doc.by), agent: String(p.doc.agent), via: 'owner proxy' } : { refused: `${p.doc.agent} is the owner's proxy` }; } catch {}
  try {
    const b = betaActor({ env, by, kind });
    if (b.ok) return { owner: String(b.doc.by), agent: String(b.who), via: 'beta mode' };
    if (b.refused) return { refused: b.why };
  } catch {}
  return null;
}
/** The worker this shell is ('' if none): a launched session of a non-deciding role, or a worker-shaped STUDIO_LOCK_OWNER. */
const workerShell = (env = process.env) => {
  const role = String(env.STUDIO_ROLE || '').trim();
  const me = String(env.STUDIO_LOCK_OWNER || '').trim();
  if (role && !DECIDER_ROLES.test(role)) return `a launched ${role} session${me ? ` (${me})` : ''}`;
  return me && WORKER_NAME.test(me) ? `${me} (a worker agent)` : '';
};
/** Is this answer an agent's (a launched session, an agent's shell, an agent's name)? Owner-only asks refuse them all. */
const agentAnswer = (by, env = process.env) => isAgent(by) || Boolean(String(env.STUDIO_ROLE || '').trim()) || Boolean(String(env.STUDIO_LOCK_OWNER || '').trim());

function resolve(id, status, answer, by, extra = {}) {
  const a = read(path.join(ASKS_DIR, `${id}.json`));
  if (!a) return { ok: false, message: `No question ${id}` };
  // 2.79 (c): what stays the owner's own (deleting data, keys and credentials, publishing outside the PC, an owner tool,
  // turning beta mode off: harness/owner-acts.mjs) is answered by a person only, never a stand-in or any agent's shell.
  const kind = askKind(a);
  const own = status !== 'decided' ? askOwnerTopic(a) : null;
  const standInName = () => { const x = ownerStandIn(process.env, { by, kind: 'board' }); return Boolean(x?.agent) && [String(by), String(process.env.STUDIO_LOCK_OWNER || '')].some((n) => n.trim().toLowerCase() === x.agent.toLowerCase()); };
  if (own && by && (agentAnswer(by) || standInName())) return { ok: false, message: `Refused: ${a.id} is about ${own.what}, which ${ownerOnlyWhy(own, String(process.env.STUDIO_LOCK_OWNER || '').trim() || by)}.` };
  // 2.76.0 (B-86), 2.79 (c): the owner proxy's shell and, in beta mode, the owner's stand-ins (the orchestrator, an outside
  // signer, a Producer/Director session for what it may decide) answer for the owner, every kind of ask; recorded.
  if (by && status !== 'decided') {
    const s = ownerStandIn(process.env, { by, kind });
    // A stand-in refused this kind (a Producer session and a protected-file ask) is refused under any --by, its own or a person's.
    if (s?.refused && agentAnswer(by)) return { ok: false, message: s.refused };
    const shell = String(process.env.STUDIO_LOCK_OWNER || '').trim();
    if (s?.agent && s.agent.toLowerCase() === String(by).toLowerCase()) { extra = { ...extra, recordedBy: s.agent, via: s.via, kind }; by = s.owner; }
    // The stand-in's own shell typing the owner's name: still recorded as the stand-in's (not a person's) answer.
    else if (s?.agent && shell && s.agent.toLowerCase() === shell.toLowerCase() && s.owner.toLowerCase() === String(by).toLowerCase()) extra = { ...extra, recordedBy: s.agent, via: s.via, kind };
  }
  // 2.79 (c): a worker session (builder, reviewer, tester … : a launched session of a worker role, or a worker's name) never
  // answers, whatever name it types after --by: it was taken for a person's answer before.
  if (status !== 'decided' && !extra.recordedBy && workerShell()) return { ok: false, message: `Refused: ${workerShell()} answers no asks for the game dev, under any --by. Hand the task back (npm run task -- pause <ID> --note "…") and let the orchestrator or the owner answer.` };
  if (!by || (isAgent(by) && status !== 'decided')) return { ok: false, message: 'A person answers: --by <your name>. Agents ask; they don\'t answer for the game dev. In beta mode the orchestrator (or an outside signer the owner lists) answers with --by <its name>.' };
  if (status !== 'decided' && by === a.by) return { ok: false, message: `${by} asked ${id}; the game dev answers it.` };
  if (!String(answer || '').trim()) return { ok: false, message: 'Give the answer.' };
  // 2.83: an answer to an ask whose delete words were read as code removed in a lane says so on the record
  // (harness/owner-acts.mjs), so the owner can check every such reading.
  { const readAs = ownerOnlyReadAs(a.question, a.why); if (readAs.length) extra = { ...extra, readAs }; }
  return { ok: true, a: write({ ...a, ...extra, status, answer: String(answer).slice(0, 1000), answeredBy: by, answeredAt: new Date().toISOString() }) };
}

/**
 * A question that carries an action runs it on a person's "yes": a hire past the Producer's limit, or an
 * engine track. The War Room and `npm run ask -- answer` both call this. Never on a timeout.
 */
export async function runAskAction(a, by) {
  if (!a?.action || !/^yes$/i.test(a.answer || '') || a.status !== 'answered') return null;
  if (a.action.type === 'hire') {
    const { startAgent } = await import('./agent.mjs');
    const h = startAgent({ ...a.action.opts, approved: true, by }, { detach: true });
    return { ok: h.ok, next: h.ok ? `${h.agent} hired and starting (${h.tool}, ${h.model}).` : `Couldn't hire: ${h.message}`, hired: h.ok ? h.agent : null };
  }
  if (a.action.type === 'engine') {
    const { startEngine } = await import('./engine.mjs');
    const r = await startEngine(a.action.engine, { by });
    return { ok: r.ok, next: r.ok ? (r.already ? 'The engine track already exists.' : `Engine track started in ${r.track.folder} (${r.track.label}); ${r.tasks.join(', ')} queued for Engine Bay.`) : `Couldn't start the engine track: ${r.message}` };
  }
  return null;
}

export function answer(id, ans, by) {
  const r = resolve(id, 'answered', ans, by);
  if (!r.ok) return r;
  if (r.a.status === 'answered') {
    const rec = r.a.recordedBy;
    // 2.84 (n): meta.role: answered from a launched session's shell (never news to the planning back-off, wake-gate.mjs).
    emitEvent({ type: 'ask.answered', agent: rec || r.a.answeredBy || by, to: r.a.by, msg: `${id} answered by ${r.a.answeredBy || by}${rec ? ` (recorded by ${rec}, ${r.a.via})` : ''}: ${r.a.answer} (${r.a.question})`.slice(0, 600), meta: { ask: id, by: r.a.answeredBy || by, ...(rec ? { recordedBy: rec, via: r.a.via, kind: r.a.kind } : {}), ...(r.a.readAs?.length ? { readAs: r.a.readAs } : {}), ...(String(process.env.STUDIO_ROLE || '').trim() ? { role: String(process.env.STUDIO_ROLE).trim().toLowerCase() } : {}) } });
    // 2.79 (c): a stand-in's answer goes in the decisions log, like its releases and approvals.
    if (rec) { try { logDecision({ action: 'ask-answer', subject: id, by: rec, as: r.a.via === 'owner proxy' ? 'outside agent' : 'beta', why: `answered "${String(r.a.answer).slice(0, 120)}" for ${r.a.answeredBy}`, evidence: `${r.a.via} ${rec}: ${String(r.a.question).slice(0, 160)}` }); } catch {} }
  }
  return { ok: true, ask: r.a };
}

/**
 * 2.90 (h): answered (or decided) asks whose follow-up is not recorded yet, oldest first. With role: those its sessions
 * asked (an asker name that starts with the role) or tied to task; without: all (the Director's brief lists every one).
 */
export function toFollow({ role = null, task = null } = {}) {
  const mine = (a) => !role || String(a.by || '').toLowerCase().startsWith(String(role).toLowerCase()) || (task && a.task === task);
  return allAsks().filter((a) => ['answered', 'decided'].includes(a.status) && !a.followed && mine(a));
}
/** 2.90 (h): the must-do lines for toFollow()'s asks (the words of the asks themselves go in the caller's marked block). */
export const followLines = (list) => list.map((a) => `- ${a.id} was answered. If it needs work, file it now: \`npm run task -- add "<title>" …\`; then \`npm run ask -- followed ${a.id} --task <ID> --by <you>\`, or \`npm run ask -- followed ${a.id} --none "<why no work>" --by <you>\`.`);
export const followQuoted = (list) => list.map((a) => `${a.id}: "${String(a.question).slice(0, 200)}" answered "${String(a.answer).slice(0, 300)}"`).join('\n');

/** 2.90 (h): record that an answered ask's follow-up is filed (a task) or needs none (why). */
export function followed(id, { task = null, none = null, by = null } = {}) {
  const a = allAsks().find((x) => x.id === String(id || '').toUpperCase());
  if (!a) return { ok: false, message: `No question ${id || ''}.` };
  if (!['answered', 'decided'].includes(a.status)) return { ok: false, message: `${a.id} is ${a.status}: only an answered ask has a follow-up.` };
  const t = typeof task === 'string' && /^[A-Z]+-\d+$/.test(task) ? task : null;
  const why = typeof none === 'string' ? none.trim() : '';
  if (!t && why.length < 5) return { ok: false, message: `Say what followed: --task <the task you filed> or --none "<why no work is needed>".` };
  if (!by) return { ok: false, message: 'Say who: --by <name>.' };
  const b = write({ ...a, followed: { ...(t ? { task: t } : { none: why.slice(0, 300) }), by, at: new Date().toISOString() } });
  emitEvent({ type: 'ask.followed', agent: by, msg: `${a.id} followed up by ${by}: ${t ? `filed ${t}` : `no work (${why.slice(0, 160)})`}`, meta: { ask: a.id, ...(t ? { task: t } : { none: true }) } });
  return { ok: true, ask: b };
}

/**
 * Apply defaults to questions past their deadline. Run by the watcher (harness/watch.mjs watchPass, from the supervisor's
 * timed passes). 2.85: an ask with a default and no deadline of its own (made before 2.85, or by a module) gets
 * STUDIO_ASK_TIMEOUT_H from when it was asked; an ask that cannot decide itself is escalated once at STUDIO_ASK_STALE_H
 * (ask.stale); the owner's own asks are left alone (never a default, never escalated). Returns the ids decided.
 */
export function expireAsks(now = Date.now(), env = process.env) {
  const decided = [];
  const H = askTimeoutMs(env);
  const stale = askStaleMs(env);
  for (const a of openAsks()) {
    if (askOwnerTopic(a)) continue;
    const at = Date.parse(a.at) || now;
    const due = askDueAt(a, now, env);
    if (due == null) {
      if (stale > 0 && !a.staleAt && now - at >= stale) {
        const cmd = `npm run ask -- answer ${a.id} "<answer>" --by <you>`;
        const hours = Math.floor((now - at) / 3600000);
        write({ ...a, staleAt: new Date(now).toISOString() });
        emitEvent({ type: 'ask.stale', agent: 'watch', to: 'producer', msg: `${a.id} has waited ${hours} h with no default it can fall back on${a.protected ? ' (a protected subject)' : ''}; the overseer or the Producer answers it: ${cmd} (${String(a.question).slice(0, 200)})`.slice(0, 600), meta: { ask: a.id, ageH: hours, cmd, overseer: true, director: true } });
      }
      continue;
    }
    if (due > now) continue;
    const r = resolve(a.id, 'decided', a.default, a.by, a.deadline ? {} : { deadlineFrom: 'STUDIO_ASK_TIMEOUT_H' });
    if (!r.ok) continue;
    const by = a.deadline ? 'after the deadline passed' : `after STUDIO_ASK_TIMEOUT_H (${H / 3600000} h) with no answer`;
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    const head = fs.existsSync(LOG) ? '' : '# Decided without you\n\nQuestions nobody answered in time. The Producer applied its default; reverse any of them with `npm run ask -- reverse <id> "<answer>" --by <name>` or from the War Room.\n';
    fs.appendFileSync(LOG, `${head}\n## ${a.id} · ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC\n- Question: ${a.question}\n- Decided: ${a.default} (by ${a.by}, ${by})\n- Why: ${a.why || '(no reason given)'}\n${r.a.readAs?.length ? `- Read as: ${r.a.readAs.map((x) => x.why).join('; ')}\n` : ''}`);
    emitEvent({ type: 'decision.timeout', agent: a.by, to: 'producer', msg: `${a.id}: no answer ${a.deadline ? 'by the deadline' : `in ${H / 3600000} h (STUDIO_ASK_TIMEOUT_H)`}, so ${a.by} decided "${a.default}" (${a.why || 'no reason given'})`, meta: { ask: a.id, ...(a.deadline ? {} : { deadlineFrom: 'STUDIO_ASK_TIMEOUT_H' }), ...(r.a.readAs?.length ? { readAs: r.a.readAs } : {}) } });
    decided.push(a.id);
  }
  return decided;
}

export async function reverse(id, ans, by) {
  const a = read(path.join(ASKS_DIR, `${id}.json`));
  if (!a) return { ok: false, message: `No question ${id}` };
  if (a.status !== 'decided') return { ok: false, message: `${id} is ${a.status}; only a decision made without you can be reversed (answer it instead).` };
  const r = resolve(id, 'reversed', ans, by, { decidedWas: a.answer });
  if (!r.ok) return r;
  const { addTask } = await import('./task.mjs');
  const t = addTask({ title: `Reverse ${id}: ${by} chose "${String(ans).slice(0, 60)}" instead of "${a.answer}" (${a.question.slice(0, 50)})`, role: 'producer', priority: 'P1', agent: by });
  emitEvent({ type: 'decision.reversed', agent: by, to: 'producer', task: t.id, msg: `${by} reversed ${id}: "${ans}" instead of "${a.answer}"` });
  return { ok: true, ask: r.a, task: t.id };
}

// 2.84: the command-line part is an async function, not a top-level await: an import cycle through a top-level await ends the process with exit 13.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)))(async () => {
  const argv = process.argv.slice(2);
  const flag = flagOf(argv);
  // 2.85: --open and --help take no value, so the word after them is not theirs.
  const BOOL = new Set(['--open', '--help']);
  const pos = argv.filter((x, i) => !x.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && !BOOL.has(argv[i - 1])));
  if (pos[0] === 'answer') {
    const r = answer(pos[1], pos[2], flag('by'));
    const act = r.ok ? await runAskAction(r.ask, flag('by')) : null;
    out(r, (x) => `${x.ask.id} answered: ${x.ask.answer}${act ? `. ${act.next}` : ''}`);
  }
  if (pos[0] === 'followed') out(followed(pos[1], { task: flag('task'), none: flag('none'), by: flag('by') }), (r) => `${r.ask.id}: follow-up recorded (${r.ask.followed.task ? `filed ${r.ask.followed.task}` : 'no work needed'}).`);
  if (pos[0] === 'reverse') out(await reverse(pos[1], pos[2], flag('by')), (r) => `${r.ask.id} reversed; the Producer has ${r.task} to undo it.`);
  if (pos[0] === 'expire') {
    const d = expireAsks();
    console.log(d.length ? `Decided by default: ${d.join(', ')}` : 'Nothing past its deadline.');
    process.exit(0);
  }
  // 2.80 (d, A10): `show <id>` and `help` are read-only; a lone lowercase word is a mistyped subcommand, not a question.
  const usage = 'Usage: npm run ask -- "<question>" --options "a,b" --default a --timeout 4h [--why "…"] [--task <ID>] | show <id> | list [--open] | answer <id> "<answer>" --by <name> | reverse <id> "<answer>" --by <name> | followed <id> --task <ID> | --none "<why>" --by <name> | expire | help';
  if (argv.includes('--help') || argv.includes('-h') || pos[0] === 'help') { console.log(usage); process.exit(0); }
  if (pos[0] === 'show') {
    const a = allAsks().find((x) => x.id === String(pos[1] || '').toUpperCase());
    if (!a) { console.error(`No question ${pos[1] || ''}. ${usage}`); process.exit(1); }
    console.log(JSON.stringify(a, null, 2));
    process.exit(0);
  }
  if (pos.length === 1 && /^[a-z][a-z-]*$/.test(pos[0]) && pos[0] !== 'list') { console.error(`"${pos[0]}" is not a subcommand, and one word is not a question. ${usage}`); process.exit(1); }
  if (pos[0] === 'list' || !pos.length) {
    const list = argv.includes('--open') ? openAsks() : allAsks();
    // 2.85: an open ask shows its age, and whether only the owner answers it.
    const age = (a) => { const h = Math.max(0, Math.floor((Date.now() - (Date.parse(a.at) || Date.now())) / 3600000)); return `open ${h} h`; };
    console.log(list.length ? list.map((a) => `${a.id} [${a.status}] ${a.question}${a.options.length ? ` (${a.options.join(' / ')})` : ''}${a.status === 'open' ? ` (${age(a)}${askOwnerTopic(a) ? ', waiting for the owner' : ''}${a.staleAt ? ', escalated' : ''})` : ''}${a.status === 'open' && a.deadline ? `; default "${a.default}" at ${a.deadline.slice(0, 16)}` : ''}${a.answer ? ` -> ${a.answer}` : ''}`).join('\n') : 'No questions yet.');
    process.exit(0);
  }
  const made = ask({ question: pos[0], options: flag('options') || [], def: flag('default'), timeout: flag('timeout'), why: flag('why') || '', by: flag('by') || undefined, task: flag('task') });
  out(made, (r) => `${r.ask.id} asked${r.ask.deadline ? `; if nobody answers by ${r.ask.deadline.slice(0, 16)} UTC the default "${r.ask.default}" applies (logged)` : '; it waits for a person'}.${r.note ? ` ${r.note}` : ''}`);
})().catch((e) => { console.error(e?.stack || String(e)); process.exit(1); });
