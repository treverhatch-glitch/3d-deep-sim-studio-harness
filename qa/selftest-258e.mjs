/**
 * qa/selftest-258e.mjs — 2.58.0 (PU-41): `metrics` on a long log.
 *   P-059: `metrics` filtered the whole log once per attempt (20k events 14 s, 40k 53 s). Now sorted once with
 *          binary search and indexes: the same rows as the 2.57.0 code (kept below for the comparison), 40k fast.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** A made-up crew log: tasks, starts, dones, hand-backs, questions, stalls, session ends across agents and hours. */
function genEvents(n, seed = 1, t0 = Date.parse('2026-10-25T00:00:00Z')) {
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const agents = ['builder-1', 'builder-2', 'builder-3', 'tester-1', 'reviewer-1', 'claude-a', 'grok-b'].map((name, i) => ({ name, model: ['claude-opus', 'gpt-5', 'grok-4', 'gemini-pro', 'qwen-coder', 'claude-sonnet', 'grok-4'][i], beats: name !== 'claude-a', session: false, task: null, lastBeat: 0 }));
  const out = [];
  const open = [];
  const done = [];
  const asks = [];
  let now = t0;
  let nextTask = 1;
  let stopped = false;
  let askN = 0;
  const ev = (type, agent, x = {}) => {
    const ts = new Date(now).toISOString();
    out.push({ id: `evt_${out.length}`, ts: x.badTs ? 'not-a-date' : ts, startedAt: ts, durationMs: null, type, agent: agent?.name ?? agent ?? 'producer', provider: null, model: x.model ?? agent?.model ?? null, task: x.task ?? null, to: null, target: null, status: 'ok', tokensIn: x.tokensIn || 0, tokensOut: x.tokensOut || 0, tokensSaved: 0, latencyMs: null, msg: x.msg || `${type} event with some words to make it a realistic length for the log`, meta: x.meta || {} });
  };
  const sessionEnd = (a, why) => ev('agent.session.end', a, { tokensIn: Math.floor(rnd() * 90000), tokensOut: Math.floor(rnd() * 9000), msg: why, meta: { cacheRead: Math.floor(rnd() * 50000), costUsd: Math.round(rnd() * 300) / 100 } });
  while (out.length < n) {
    now += rnd() < 0.08 ? 0 : Math.floor(rnd() * 20000);
    if (open.length < 6 || rnd() < 0.02) { const id = `T-${String(nextTask++).padStart(3, '0')}`; open.push(id); ev('task.added', 'producer', { task: id, msg: `Queued ${id} [P1] (builder): Build part ${id}`, meta: { role: 'builder', paths: [`game/x/src/${id}`] } }); continue; }
    const a = pick(agents);
    if (!a.session) { a.session = true; ev('agent.session.start', a, { msg: `${a.name} session started` }); continue; }
    const x = rnd();
    if (!a.task) {
      if (x < 0.55 && open.length) { const t = pick(open); a.task = t; open.splice(open.indexOf(t), 1); ev('task.start', a, { task: t, msg: `Started ${t}: Build part`, meta: { head: `abc${out.length % 997}` } }); a.lastBeat = now; continue; }
      if (x < 0.65) { a.session = false; sessionEnd(a, rnd() < 0.1 ? 'hit the usage limit' : 'session ended'); continue; }
      if (x < 0.7 && done.length) { const t = pick(done); ev('task.reopened', 'reviewer-1', { task: t, msg: rnd() < 0.5 ? `Reopened ${t}: missed the task` : `Reopened ${t}` }); continue; }
      if (x < 0.73) { stopped = !stopped; ev(stopped ? 'studio.stopped' : 'studio.resumed', 'producer'); continue; }
      ev(pick(['agent.info', 'route.success', 'lock.renew', 'hub.ping']), a, { badTs: rnd() < 0.01 });
      continue;
    }
    const t = a.task;
    if (a.beats && now - a.lastBeat > 120000 && rnd() < 0.7) { a.lastBeat = now; ev('agent.heartbeat', a); continue; }
    if (x < 0.25) { ev(pick(['tool.call', 'file.edit', 'agent.info']), a, { task: rnd() < 0.5 ? t : null }); continue; }
    if (x < 0.32) { ev('gates.run', a, { msg: 'npm run verify', meta: { ms: Math.floor(rnd() * 300000) } }); continue; }
    if (x < 0.36) { const id = `A-${++askN}`; asks.push(id); ev('ask.open', a, { task: t, msg: `${id} which colour should the menu use?` }); continue; }
    if (x < 0.39 && asks.length) { const id = asks.splice(Math.floor(rnd() * asks.length), 1)[0]; ev('ask.answered', 'producer', { msg: `${id} answered: blue` }); continue; }
    if (x < 0.41) { ev('session.stall', 'watchdog', { task: rnd() < 0.5 ? t : null, msg: `${a.name} stalled for ${1 + Math.floor(rnd() * 20)} min${rnd() < 0.3 ? ' (burn loop)' : ''}`, meta: { target: a.name } }); continue; }
    if (x < 0.43) { ev(pick(['task.lock_denied', 'task.not_done', 'task.refused', 'task.rescue', 'task.budget', 'watchdog.action', 'task.hold', 'tool.takeover', 'gate.flaky', 'review.verdict', 'task.scope_override']), a, { task: t, msg: pick(['no full `npm run verify` in this attempt', 'over its task budget', 'refresh check went unanswered', 'handed back 3 times', 'usage limit reached', 'lane game/x is held', 'missed the task', 'merge refused', 'plain note']), meta: rnd() < 0.3 ? { target: a.name } : {} }); continue; }
    if (x < 0.5) {
      const end = pick(['task.done', 'task.done', 'task.done', 'task.paused', 'task.paused', 'task.forced', 'task.dropped', 'task.shelved']);
      ev(end, a, { task: t, msg: end === 'task.paused' ? pick([`Handed back ${t}: the harness lost the claim`, `Handed back ${t}: ended without task done or a hand-back`, `Handed back ${t}: stuck`]) : `${end} ${t}` });
      if (end === 'task.done') done.push(t);
      else if (end === 'task.paused') open.push(t);
      a.task = null;
      continue;
    }
    if (x < 0.52) { a.session = false; open.push(a.task); a.task = null; sessionEnd(a, rnd() < 0.2 ? 'hit the rate limit (429)' : 'session ended'); continue; }
    if (x < 0.53) { const b = pick(agents.filter((y) => y !== a && !y.task)); if (b) { b.task = t; a.task = null; ev('task.start', b, { task: t, msg: `Picked up ${t}` }); } continue; }
    ev(pick(['tool.call', 'file.edit']), a, { task: t });
  }
  return out;
}

/** harness/metrics.mjs attemptRows as it was in 2.57.0 (quadratic), kept only to compare rows with the new one. */
function oldMetrics() {
  const ts = (e) => Date.parse(e?.ts) || 0;
  const min = (ms) => Math.round((ms / 60000) * 10) / 10;
  const family = (model) => {
    const m = String(model || '').toLowerCase();
    if (/claude|opus|sonnet|haiku|fable|mythos/.test(m)) return 'anthropic';
    if (/gpt|o\d|codex|openai/.test(m)) return 'openai';
    if (/grok|xai/.test(m)) return 'xai';
    if (/gemini|vertex/.test(m)) return 'google';
    if (/llama|qwen|deepseek|glm|mistral|nemotron|ollama/.test(m)) return 'open-weights';
    return m ? 'other' : null;
  };
  const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  function stoppedSpans(events, end) {
    const spans = [];
    let from = null;
    for (const e of events) {
      if (e.type === 'studio.stopped' && from === null) from = ts(e);
      if (e.type === 'studio.resumed' && from !== null) { spans.push([from, ts(e)]); from = null; }
    }
    if (from !== null) spans.push([from, end]);
    return spans;
  }
  function askSpans(events, agent, end) {
    const spans = [];
    const open = new Map();
    for (const e of events) {
      const id = (String(e.msg || '').match(/^(A-\d+|ask-[\w-]+|Q-\d+)/) || [])[1] || null;
      if (e.type === 'ask.open' && e.agent === agent) open.set(id || `#${open.size}`, ts(e));
      if (e.type === 'ask.answered' && id && open.has(id)) { spans.push([open.get(id), ts(e)]); open.delete(id); }
    }
    for (const t of open.values()) spans.push([t, end]);
    return spans;
  }
  function buildAttempts(events, { now = Date.now() } = {}) {
    events = [...events].sort((a, b) => ts(a) - ts(b));
    const attempts = [];
    const open = new Map();
    const close = (a, end, outcome, endEvent = null) => { a.end = end; a.outcome = outcome; a.endEvent = endEvent; open.delete(a.task); attempts.push(a); };
    const tries = new Map();
    for (const e of events) {
      const task = e.task || null;
      if (e.type === 'task.start' && task) {
        if (open.has(task)) close(open.get(task), ts(e), 'reclaimed', e);
        const n = (tries.get(task) || 0) + 1;
        tries.set(task, n);
        open.set(task, { task, attempt: n, agent: e.agent || null, model: e.model || null, start: ts(e), startEvent: e });
        continue;
      }
      if (!task || !open.has(task)) {
        if (e.type === 'agent.session.end') for (const a of [...open.values()]) if (a.agent === e.agent) close(a, ts(e), 'session-ended', e);
        continue;
      }
      const a = open.get(task);
      if (e.type === 'task.done') close(a, ts(e), 'done', e);
      else if (e.type === 'task.forced') close(a, ts(e), 'forced', e);
      else if (e.type === 'task.paused') close(a, ts(e), 'handed-back', e);
      else if (['task.dropped', 'task.shelved'].includes(e.type)) close(a, ts(e), e.type.slice(5), e);
    }
    for (const a of open.values()) { a.end = now; a.outcome = 'open'; attempts.push(a); }
    return attempts.sort((x, y) => x.start - y.start);
  }
  function labelFailure(a, inWin, all) {
    if (a.outcome === 'done' || a.outcome === 'open') return null;
    const txt = (e) => `${e?.msg || ''} ${JSON.stringify(e?.meta || {})}`;
    const mine = inWin.filter((e) => e.task === a.task || e.agent === a.agent || e.meta?.target === a.agent);
    const has = (re, types = null) => mine.some((e) => (!types || types.includes(e.type)) && re.test(txt(e)));
    if (has(/usage limit|rate limit|\b429\b|quota|marked out|budget stop/i, ['agent.session.end', 'tool.takeover', 'task.budget', 'agent.stopped', 'task.paused'])) return 'quota';
    if (mine.some((e) => e.type === 'session.stall' && /burn|loop|repeat/i.test(txt(e))) || has(/handed back \d+ times/i, ['task.hold'])) return 'repetition';
    if (mine.some((e) => e.type === 'task.lock_denied') || has(/lane .* is held|holds T-\d+|already claimed/i)) return 'lane-conflict';
    if (a.outcome === 'forced' || has(/no full `?npm run verify|didn't run|no changes found/i, ['task.not_done'])) return 'verify-missing';
    if (has(/over (its|the) (task )?budget|refresh check went unanswered|session cap/i, ['task.budget', 'watchdog.action', 'agent.stopped', 'task.paused'])) return 'no-stop';
    if (mine.some((e) => e.type === 'task.refused' || e.type === 'task.scope_override') || has(/missed the task|off the spec|not what the task asked/i, ['review.verdict', 'task.reopened'])) return 'spec-ignored';
    if (mine.some((e) => ['studio.stopped', 'gate.flaky', 'whole.environment'].includes(e.type)) || has(/harness|merge refused|land lock|claim ran out|main checkout/i, ['task.paused'])) return 'env-harness';
    if (a.outcome === 'session-ended' || /ended without task done|without task done or a hand-back|finished without task done|session ended .* while it held/i.test(txt(a.endEvent))) {
      const lastEnd = all.filter((e) => e.type === 'agent.session.end' && e.agent === a.agent && ts(e) <= a.end).pop();
      if (lastEnd && ts(lastEnd) < a.start && a.endEvent?.agent !== a.agent) return 'env-harness';
      return 'premature-stop';
    }
    return 'unknown';
  }
  function attemptRows(events, { now = Date.now(), since = 0 } = {}) {
    events = [...events].sort((a, b) => ts(a) - ts(b));
    const end = now;
    const stops = stoppedSpans(events, end);
    const rows = [];
    for (const a of buildAttempts(events, { now })) {
      if (a.start < since) continue;
      const inWin = events.filter((e) => ts(e) >= a.start && ts(e) <= a.end);
      const wall = Math.max(0, a.end - a.start);
      const checks = inWin.filter((e) => e.type === 'gates.run' && e.agent === a.agent).reduce((s, e) => s + (Number(e.meta?.ms) || 0), 0);
      const person = [...askSpans(events, a.agent, end), ...stops].reduce((s, [x, y]) => s + overlap(a.start, a.end, x, y), 0);
      const own = inWin.filter((e) => e.agent === a.agent || e.meta?.target === a.agent);
      const heartbeats = own.some((e) => e.type === 'agent.heartbeat');
      let stalled = 0;
      if (heartbeats) {
        const beats = own.map(ts).concat([a.start, a.end]).sort((x, y) => x - y);
        for (let i = 1; i < beats.length; i++) if (beats[i] - beats[i - 1] > 5 * 60000) stalled += beats[i] - beats[i - 1];
      }
      for (const e of inWin.filter((x) => x.type === 'session.stall' && (x.meta?.target === a.agent))) {
        const m = String(e.msg || '').match(/for (\d+) min/);
        if (m) stalled += Number(m[1]) * 60000;
      }
      stalled = Math.min(Math.max(0, stalled - person - checks), Math.max(0, wall - checks - person));
      const agentMs = Math.max(0, wall - checks - person - stalled);
      const sessions = events.filter((e) => e.type === 'agent.session.end' && e.agent === a.agent && ts(e) >= a.start).slice(0, 1);
      const reopened = events.some((e) => e.type === 'task.reopened' && e.task === a.task && ts(e) > a.start);
      const sess = events.filter((e) => e.type === 'agent.session.start' && e.agent === a.agent && ts(e) <= a.end).pop();
      const model = sessions.find((e) => e.model)?.model || (sess && ts(sess) >= a.start - 6 * 3600000 ? sess.model : null) || a.model || null;
      const row = {
        task: a.task, attempt: a.attempt, retries: a.attempt - 1, agent: a.agent, model, family: family(model),
        start: new Date(a.start).toISOString(), end: new Date(a.end).toISOString(), outcome: a.outcome,
        minutes: min(wall), agentMin: min(agentMs), checksMin: min(checks), personMin: min(person), stalledMin: min(stalled),
        tokensIn: 0, tokensOut: 0, cacheRead: 0, costUsdReported: 0,
        sessions: sessions.length, heartbeats,
        handBacks: inWin.filter((e) => e.type === 'task.paused' && e.task === a.task).length,
        notDone: inWin.filter((e) => e.type === 'task.not_done' && e.task === a.task).length,
        rescues: inWin.filter((e) => /^task\.rescue/.test(e.type) && e.task === a.task).length,
        reopened,
      };
      row.failure = labelFailure(a, inWin, events);
      if (reopened && row.outcome === 'done') row.failure = 'verify-wrong';
      row._session = sessions[0] || null;
      row._wall = wall;
      rows.push(row);
    }
    const bySession = new Map();
    for (const r of rows) if (r._session) { if (!bySession.has(r._session)) bySession.set(r._session, []); bySession.get(r._session).push(r); }
    for (const [e, rs] of bySession) {
      const total = rs.reduce((x, r) => x + r._wall, 0) || rs.length;
      for (const r of rs) {
        const w = total === rs.length ? 1 / rs.length : r._wall / total;
        r.tokensIn = Math.round((Number(e.tokensIn) || 0) * w);
        r.tokensOut = Math.round((Number(e.tokensOut) || 0) * w);
        r.cacheRead = Math.round((Number(e.meta?.cacheRead) || 0) * w);
        r.costUsdReported = Math.round((Number(e.meta?.costUsd) || 0) * w * 100) / 100;
      }
    }
    for (const r of rows) { delete r._session; delete r._wall; }
    return rows;
  }
  return { attemptRows };
}

export async function selftest258E({ dir, run, report }) {
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const env = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_LANE_INFER: 'off' };
  const probe = (name, code, extra = {}) => {
    const f = path.join(dir, `.probe-258e-${name}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node ${path.basename(f)}`, { ...env, ...extra });
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return { ...JSON.parse(line), _err: String(r.stderr || '').slice(-1500) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };
  // P-059: the same rows as the 2.57.0 code, and fast on a long log.
  const met = probe('metrics', `import { attemptRows } from ${u('harness/metrics.mjs')};
${genEvents.toString()}
${oldMetrics.toString()}
const old = oldMetrics();
const now = Date.parse('2026-11-01T00:00:00Z');
const same = [];
for (const [n, seed] of [[3000, 2], [4000, 7]]) {
  let ev = genEvents(n, seed);
  if (seed % 2) ev = ev.slice().reverse(); // not in time order: both must sort the same way
  for (const since of [0, Date.parse(genEvents(n, seed)[Math.floor(n / 2)].ts) || 0]) {
    const a = JSON.stringify(old.attemptRows(ev, { now, since }));
    const b = JSON.stringify(attemptRows(ev, { now, since }));
    same.push({ n, seed, since: !!since, rows: JSON.parse(a).length, same: a === b });
  }
}
const big = genEvents(40000, 1);
const t = Date.now();
const rows = attemptRows(big, { now });
const ms = Date.now() - t;
console.log(JSON.stringify({ same, ms, rows: rows.length }));`);
  report('2.58.0 (PU-41, P-059): metrics gives exactly the rows of the 2.57.0 code on a generated log of a few thousand events (several agents and hours, every outcome and failure label, out of time order, with and without --since)',
    met.same?.length === 4 && met.same.every((x) => x.same && x.rows > 50), JSON.stringify(met).slice(0, 1500));
  report('2.58.0 (PU-41, P-059): metrics on 40,000 events takes seconds, not a minute (sorted once, binary search per attempt; was 53 s)',
    met.rows > 1000 && met.ms < 5000, JSON.stringify({ ms: met.ms, rows: met.rows, _raw: met._raw }));

}
