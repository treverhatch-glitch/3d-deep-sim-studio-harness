/**
 * harness/ask-post.mjs — 2.79 (c, the crew's item 2.15 and "cut the fat" 5.6): one post per state change for the asks
 * the harness sends (agent.ask events: "T-xxx is parked: …", "Needs you: …").
 *
 * The crew's run (6 days): 252 agent.ask events against 20 ask.answered, most of them the same "T-xxx is parked: 2
 * sessions in a row ended with no work" again after the orchestrator had acted on it. Each harness emitter posted on
 * every new occurrence, with nothing that remembered it had asked, or that the thing it asked about was over. Now every
 * harness agent.ask goes through postAsk:
 *   - an ask is (task, subject); it posts once. While it is open, the same ask again is counted, not posted: it shows in
 *     the daily digest (harness/digest.mjs needsPerson) instead, and posts again at most once per
 *     STUDIO_ASK_DIGEST_HOURS (24) since its last post;
 *   - it closes by itself (an ask.closed event, once) when what it asked about is over: the task is done, or the state
 *     it was asked in is gone (the park it reported was lifted or replaced, the train hold released). closeStaleAsks runs
 *     on every watchdog pass and before each post. A closed ask that comes back within STUDIO_ASK_DIGEST_HOURS of its last
 *     post is the same question again (the same task parked for the same reason after an unpark): it reopens counted,
 *     not posted, and the digest lists it with how often it came back;
 *   - an answered formal ask (studio/asks, harness/ask.mjs) is never open again; one asked with --task closes (status
 *     closed, ask.closed) when that task is done.
 * State: .studio/asks-posted.json in the main checkout. No harness imports beyond event.mjs and fsafe.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { emitEvent, boardRoot } from './event.mjs';
import { writeAtomic, withFileLock, readJson } from './fsafe.mjs';

const H = 3600000;
const root = () => { try { return boardRoot(); } catch { return process.cwd(); } };
export const postedFile = (r = root()) => path.join(r, '.studio', 'asks-posted.json');
/** STUDIO_ASK_DIGEST_HOURS (24): how often an open (or recurring) ask is posted again at most. */
export const digestHours = (env = process.env) => { const v = String(env.STUDIO_ASK_DIGEST_HOURS ?? '').trim(); const n = Number(v); return v !== '' && Number.isFinite(n) && n >= 0 ? n : 24; };

/** The state a task-subject ask was asked in: its park (when, why), or 'open'. '' for an ask with no task. */
export function subjectState(task, { holds = null, r = root() } = {}) {
  if (!task) return '';
  const all = holds || readJson(path.join(r, 'studio', 'task-holds.json'), {}).tasks || {};
  const p = all[task]?.parked;
  return p ? `parked:${p.at || ''}:${String(p.why || '').slice(0, 60)}` : 'open';
}

const withState = (r, fn) => {
  const f = postedFile(r);
  return withFileLock('asks-posted', () => {
    const j = readJson(f, {});
    const st = j && typeof j === 'object' && j.asks ? j : { asks: {} };
    const out = fn(st);
    try { fs.mkdirSync(path.dirname(f), { recursive: true }); writeAtomic(f, `${JSON.stringify(st, null, 2)}\n`, { fsync: false }); } catch { /* best effort */ }
    return out;
  }, { dir: path.join(r, '.studio', 'locks'), what: 'The posted asks (.studio/asks-posted.json)' });
};

/**
 * Post one harness ask (an agent.ask event) unless it is already open, or came back within the digest window.
 * subject: what it is about ('parked', 'shelved', 'session-check', …); with a task, the ask also closes when the task's
 * state changes (subjectState). Returns { posted, key, why }. Never throws.
 */
export function postAsk({ agent = 'harness', to = 'producer', task = null, subject = 'ask', msg = '', status, meta = null, now = Date.now(), env = process.env, emit = emitEvent, r = root() } = {}) {
  const key = `${task || '-'}:${subject}`;
  try {
    const state = subjectState(task, { r });
    const hours = digestHours(env);
    const res = withState(r, (st) => {
      const a = st.asks[key];
      const t = new Date(now).toISOString();
      if (a?.open && (a.state === state || !task)) {
        a.repeats = (a.repeats || 0) + 1; a.lastSeen = t; a.msg = String(msg).slice(0, 600);
        if (now - (Date.parse(a.lastPost) || 0) < hours * H) return { posted: false, why: `already asked at ${a.lastPost.slice(0, 16)}; open, so it repeats in the daily digest (STUDIO_ASK_DIGEST_HOURS ${hours})` };
        a.lastPost = t; a.posts = (a.posts || 0) + 1;
        return { posted: true, again: true };
      }
      // A new state (or the first time). The same question back within the window after it closed: counted, not posted.
      // (An open ask whose state changed before the watchdog closed it is the same: it closed and came back.)
      const back = Boolean(a) && now - (Date.parse(a.lastPost) || 0) < hours * H;
      st.asks[key] = { key, task, subject, agent, to, msg: String(msg).slice(0, 600), state, open: true, firstAt: a?.firstAt || t, lastSeen: t, lastPost: back ? a.lastPost : t, posts: (a?.posts || 0) + (back ? 0 : 1), repeats: back ? (a.repeats || 0) + 1 : 0, cameBack: back ? (a.cameBack || 0) + 1 : (a?.cameBack || 0) };
      return back ? { posted: false, why: `asked at ${a.lastPost.slice(0, 16)} and came back (${a.open ? 'its state changed' : `closed: ${a.closedWhy || 'over'}`}): counted for the daily digest, not posted again within STUDIO_ASK_DIGEST_HOURS ${hours}` } : { posted: true };
    });
    if (res.posted) emit({ type: 'agent.ask', agent, to, ...(task ? { task } : {}), ...(status ? { status } : {}), msg: String(msg).slice(0, 600), meta: { ...(meta || {}), ask: key, ...(res.again ? { again: true } : {}) } });
    return { ...res, key };
  } catch (e) {
    // The record can't be read or written: post as before (an ask is never lost to a state-file problem).
    try { emit({ type: 'agent.ask', agent, to, ...(task ? { task } : {}), ...(status ? { status } : {}), msg: String(msg).slice(0, 600), ...(meta ? { meta } : {}) }); } catch {}
    return { posted: true, key, why: `unrecorded (${e.message})` };
  }
}

/**
 * Close the open asks whose subject is over: the task is done (done(task) -> bool), or its state changed since it was
 * asked. One ask.closed event each. Returns the closed keys. Never throws.
 */
export function closeStaleAsks({ done = () => false, now = Date.now(), emit = emitEvent, r = root() } = {}) {
  const closed = [];
  try {
    const holds = readJson(path.join(r, 'studio', 'task-holds.json'), {}).tasks || {};
    withState(r, (st) => {
      for (const a of Object.values(st.asks)) {
        if (!a?.open || !a.task) continue;
        const why = done(a.task) ? `${a.task} is done` : subjectState(a.task, { holds, r }) !== a.state ? `${a.task} is no longer ${String(a.state).startsWith('parked') ? 'parked as it was' : 'in that state'}` : '';
        if (!why) continue;
        Object.assign(a, { open: false, closedAt: new Date(now).toISOString(), closedWhy: why });
        closed.push({ key: a.key, task: a.task, why, msg: a.msg });
      }
    });
    for (const c of closed) { try { emit({ type: 'ask.closed', agent: 'harness', to: 'producer', task: c.task, msg: `Closed: ${c.why}, so the ask "${String(c.msg).slice(0, 160)}" is over (it isn't posted again)`.slice(0, 400), meta: { ask: c.key, why: c.why } }); } catch {} }
  } catch { /* best effort */ }
  // Formal asks (studio/asks) asked with --task: closed when that task is done.
  try {
    const dir = path.join(r, 'studio', 'asks');
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => /^A-\d+\.json$/.test(x)) : []) {
      const a = readJson(path.join(dir, f), null);
      if (!a || a.status !== 'open' || !a.task || !done(a.task)) continue;
      fs.writeFileSync(path.join(dir, f), `${JSON.stringify({ ...a, status: 'closed', closedAt: new Date(now).toISOString(), closedWhy: `${a.task} is done` }, null, 2)}\n`);
      closed.push({ key: a.id, task: a.task, why: `${a.task} is done` });
      try { emit({ type: 'ask.closed', agent: 'harness', to: a.by, task: a.task, msg: `${a.id} closed: ${a.task} is done, so "${String(a.question).slice(0, 160)}" needs no answer`.slice(0, 400), meta: { ask: a.id } }); } catch {}
    }
  } catch {}
  return closed.map((c) => c.key);
}

/** The open harness asks, for the daily digest: [{ key, task, msg, repeats, cameBack, lastPost }]. */
export function openPostedAsks({ r = root() } = {}) {
  const st = readJson(postedFile(r), { asks: {} });
  return Object.values(st.asks || {}).filter((a) => a?.open).sort((a, b) => String(a.firstAt).localeCompare(String(b.firstAt)));
}
