/**
 * harness/round-cap.mjs — 2.72.0 (b): the two-round cap. Red twice in a row on the same failure: hand back, restart.
 *
 * Patching the last attempt has diminishing returns (Stripe's practice is "one or two rounds"). A round is one
 * verify of a task (a full `npm run verify` by the agent that holds it; --only and --tier fast runs don't count) or one
 * merge-train result for its lane: a task.round event { task, agent, ok, source, sig }. The signature is the failing
 * check's sub-id (a game check's id, "game:unit", else the gate's id) and its first FAIL line
 * (harness/handback-facts.mjs signatureKey), until verify sub-ids exist.
 *
 * When the last STUDIO_ROUND_CAP (2) rounds of a task by one agent in one session are red with the same signature, the
 * task is handed back (task pause) with the mechanical summary: the harness's hand-back facts (files touched, gates,
 * failure signature), the sub-id, the red signatures, the decisions logged on the task, and a note to restart from the
 * spec instead of patching the last attempt; one task.round_cap event. The next attempt in that session is refused: a
 * verify while the agent still holds the task, and `task start` of it again. A new session (agent.session.start or
 * .end after the cap) may take it. A session is the agent's time since its newest agent.session.start/end; an agent
 * with neither (outside the launcher) counts the last 12 hours. STUDIO_ROUND_CAP=0 turns the cap off.
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { REPO_ROOT, emitEvent, readRecentEvents } from './event.mjs';
import { readGateLog, signatureKey, normaliseLine } from './handback-facts.mjs';

const NO_SESSION_MS = 12 * 3600000;

/** STUDIO_ROUND_CAP: rounds red on one signature before the hand-back (default 2; 0 = off). */
export function roundCap(env = process.env) {
  const v = String(env.STUDIO_ROUND_CAP ?? '').trim();
  if (!v) return 2;
  if (/^(off|no|false)$/i.test(v)) return 0;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : 2;
}

/** The task this agent holds (its task: claim), or null. */
export async function taskOf(agent) {
  if (!agent) return null;
  try { const { listLocks } = await import('./lock.mjs'); return listLocks().find((l) => l.owner === agent && l.key.startsWith('task:'))?.key.slice(5) || null; } catch { return null; }
}

/** Where this agent's session starts (ms): its newest agent.session.start or .end; with neither, 12 hours ago. */
export function sessionStart(agent, events, now = Date.now()) {
  let t = null;
  for (const e of events) if ((e.type === 'agent.session.start' || e.type === 'agent.session.end') && e.agent === agent) t = Math.max(t || 0, Date.parse(e.ts) || 0);
  return t === null ? now - NO_SESSION_MS : t;
}

const inSession = (task, agent, events, now) => {
  const from = sessionStart(agent, events, now);
  return events.filter((e) => e.task === task && e.agent === agent && (Date.parse(e.ts) || 0) >= from);
};

/** A red run's signature: { sub, line, key } from its output (run-gates' or game-gates' lines) or a reason text. */
export function redSignature(text, { gate = null } = {}) {
  const t = String(text || '');
  const sub = t.match(/\[game-gates\] FAIL (\S+?)(?::\s|:?$|\s)/m)?.[1] || null;
  const r = readGateLog(t);
  const id = sub || gate || r.failGate || 'verify';
  const line = r.failLine || normaliseLine(t.split('\n').find((l) => l.trim()) || '') || '';
  return { sub: id, line, key: signatureKey(id, line) };
}

/** Why this agent may not make another attempt at the task in this session, or ''. */
export function capRefusal(task, agent, { events = null, env = process.env, now = Date.now() } = {}) {
  if (!task || !agent || !roundCap(env)) return '';
  const ev = events || readRecentEvents(20000);
  const hit = inSession(task, agent, ev, now).filter((e) => e.type === 'task.round_cap').pop();
  if (!hit) return '';
  return `${task} was handed back by the round cap (STUDIO_ROUND_CAP=${roundCap(env)}) in this session at ${String(hit.ts).slice(11, 19)} UTC: red ${roundCap(env)} times in a row on ${hit.meta?.sub || 'the same failure'}. Another attempt in the same session is refused: restart from the spec in a new session (the hand-back note in .studio/handoffs/ has the summary), or pick another task`;
}

/** The hand-back note: sub-id, the red signatures, the decisions on the task, and the restart advice (<= 20 lines). */
export function capNote(task, reds, { root = REPO_ROOT, cap = 2 } = {}) {
  let decisions = [];
  try {
    const f = path.join(root, '.studio', 'decisions.jsonl');
    decisions = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((d) => d?.kind === 'decision' && String(d.subject || '').split(/[\s,]+/).includes(task));
  } catch { decisions = []; }
  const L = [
    `Round cap (STUDIO_ROUND_CAP=${cap}): red ${reds.length} times in a row on the same failure, so this attempt stops here.`,
    `- Sub-id: ${reds[reds.length - 1]?.meta?.sig?.sub || 'unknown'}`,
    ...reds.map((e, i) => `- Red ${i + 1} (${e.meta?.source || 'verify'}, ${String(e.ts).slice(0, 16).replace('T', ' ')} UTC): ${e.meta?.sig?.line || '(no failing line)'} [sig ${e.meta?.sig?.key || '?'}]`),
    `- Decisions on ${task}: ${decisions.length ? decisions.slice(-4).map((d) => `${d.action} by ${d.by}${d.why ? ` (${String(d.why).slice(0, 80)})` : ''}`).join('; ') : 'none logged'}`,
    'Next: restart from the spec (the task\'s brief and its acceptance), not from the last attempt\'s patch: read the brief again, look at the failing check fresh, then change code. Another attempt in this session is refused; a new session can pick it up.',
  ];
  return L.join('\n');
}

/**
 * Record one round and apply the cap. Returns { capped: boolean, note, reds } (note: the hand-back note when capped).
 * Doesn't hand back itself: the caller does (handBackCapped for a verify; the train's own drop for a train).
 */
export function recordRound({ task, agent, ok, sig = null, source = 'verify', env = process.env, now = Date.now(), root = REPO_ROOT } = {}) {
  if (!task || !agent) return { capped: false };
  const cap = roundCap(env);
  try { emitEvent({ type: 'task.round', agent, task, status: ok ? 'ok' : 'blocked', msg: `${task}: ${source} ${ok ? 'green' : `red${sig ? ` on ${sig.sub}: ${String(sig.line || '').slice(0, 160)}` : ''}`}`.slice(0, 400), meta: { ok: Boolean(ok), source, ...(sig ? { sig } : {}) } }); } catch { return { capped: false }; }
  if (ok || !cap) return { capped: false };
  const ev = inSession(task, agent, readRecentEvents(20000), now);
  if (ev.some((e) => e.type === 'task.round_cap')) return { capped: false, already: true };
  const rounds = ev.filter((e) => e.type === 'task.round');
  const last = rounds.slice(-cap);
  if (last.length < cap || last.some((e) => e.meta?.ok || !e.meta?.sig?.key || e.meta.sig.key !== sig?.key)) return { capped: false };
  const note = capNote(task, last, { root, cap });
  try { emitEvent({ type: 'task.round_cap', agent, task, to: 'producer', status: 'blocked', msg: `${task} handed back by the round cap: red ${cap} times in a row on ${sig.sub} (${String(sig.line || '').slice(0, 160)})`.slice(0, 500), meta: { cap, sub: sig.sub, sigs: last.map((e) => e.meta.sig), source } }); } catch {}
  return { capped: true, note, reds: last };
}

/** Hand the task back (task pause, as the agent) with the cap's note. */
export function handBackCapped(task, agent, note, { root = REPO_ROOT, env = process.env } = {}) {
  const r = spawnSync(process.execPath, [path.join(root, 'harness', 'task.mjs'), 'pause', task, '--agent', agent, '--note', note], { cwd: root, encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim().slice(-400) };
}

/**
 * scripts/run-gates.mjs's step after a full verify: one round for the task the owner holds; on the cap, the hand-back.
 * `failText` is the first failing required gate's output (with its id). Never throws.
 */
export async function verifyRound({ ok, failGate = null, failText = '', env = process.env, root = REPO_ROOT, log = (m) => console.log(m) } = {}) {
  try {
    const agent = String(env.STUDIO_LOCK_OWNER || '').trim();
    const task = await taskOf(agent);
    if (!task) return null;
    const sig = ok ? null : redSignature(`${failText}\n[gates] FAIL ${failGate || 'verify'}`, { gate: failGate });
    const r = recordRound({ task, agent, ok, sig, source: 'verify', env, root });
    if (!r.capped) return r;
    const hb = handBackCapped(task, agent, r.note, { root, env });
    log(`[gates] round cap: ${task} was red ${r.reds.length} times in a row on ${sig.sub}; ${hb.ok ? 'handed back with a summary (restart from the spec, not the last patch)' : `the hand-back failed (${hb.out}); hand it back yourself: npm run task -- pause ${task} --agent ${agent} --note "…"`}. Another attempt at ${task} in this session is refused (STUDIO_ROUND_CAP=${roundCap(env)}; 0 turns it off).`);
    return { ...r, handedBack: hb.ok };
  } catch { return null; }
}

/** scripts/run-gates.mjs's refusal before a verify: the owner's task was capped in this session. */
export async function verifyRefusal({ env = process.env } = {}) {
  try {
    const agent = String(env.STUDIO_LOCK_OWNER || '').trim();
    const task = await taskOf(agent);
    return task ? capRefusal(task, agent, { env }) : '';
  } catch { return ''; }
}
