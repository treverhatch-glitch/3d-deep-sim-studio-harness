/**
 * harness/futility.mjs — 2.68.0: the futility cap, shadow first.
 *
 * Failed runs are the expensive ones and agents notice too late (research 2026-11-01, F3: stopping hopeless runs early
 * saved 28-64% of their tokens; on this studio's own log a cap at the p90 of successful runs saved 32% of all tokens and
 * cut 4 good runs short). So: per task type (the task's type, an owner's retype, else the session's role), the 90th
 * percentile of SUCCESSFUL sessions' weighted tokens and wall time (a session whose task landed in it). With fewer than
 * STUDIO_FUTILITY_MIN_N (20) successful sessions of that type there is no cap.
 *
 * The supervisor's loop calls futilityPass() each pass. A running session past either p90 raises one Check event
 * (futility.check, to the Producer: "past the p90 of good runs"). STUDIO_FUTILITY:
 *   shadow (default)  only the Check event; when the session ends, futility.shadow logs what the cap would have saved
 *                     (its tokens and minutes after the check) and whether it would have cut a good run short
 *                     (.studio/futility-log.jsonl too), so the owner can judge the cap on real data;
 *   on                also hands the task back (the launcher's pause: the diff is saved and the lane copy kept, never
 *                     deleted) so a fresh session continues from it;
 *   off               nothing.
 * No harness imports but event.mjs and token-weight.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, STUDIO_STATE_DIR, emitEvent } from './event.mjs';
import { weightedTokens, cacheReadWeight } from './token-weight.mjs';

const STATE = () => path.join(STUDIO_STATE_DIR, 'futility.json');
export const FUTILITY_LOG = () => path.join(STUDIO_STATE_DIR, 'futility-log.jsonl');
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const ts = (e) => Date.parse(e?.ts) || 0;
const num = (v, d) => (v === undefined || v === null || String(v).trim() === '' || !Number.isFinite(Number(v)) ? d : Number(v));

export function futilityMode(env = process.env) {
  const v = String(env.STUDIO_FUTILITY ?? '').trim().toLowerCase();
  if (/^(off|0|false|no)$/.test(v)) return 'off';
  if (/^(on|1|true|yes)$/.test(v)) return 'on';
  return 'shadow';
}
export const futilityMinN = (env = process.env) => Math.max(1, Math.round(num(env.STUDIO_FUTILITY_MIN_N, 20)));

/** The 90th percentile (nearest rank). */
export function p90(xs) {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.min(s.length - 1, Math.ceil(0.9 * s.length) - 1)];
}

/** Each task's type from the log: task.added meta.type, an owner's task.retyped outranks it. */
export function taskTypes(events) {
  const m = new Map(); const retyped = new Set();
  for (const e of events) {
    if (e.type === 'task.added' && e.task && e.meta?.type && !retyped.has(e.task)) m.set(e.task, e.meta.type);
    if (e.type === 'task.retyped' && e.task && e.meta?.to) { m.set(e.task, e.meta.to); retyped.add(e.task); }
  }
  return m;
}

/**
 * Successful sessions' norms per type: { [type]: { n, p90Tokens, p90Ms } }. A session is successful when its outcome
 * says done, or its task landed (task.done) by that agent between its start and its end.
 */
export function successNorms(events, { weight = (e) => weightedTokens(e) } = {}) {
  const sorted = [...events].sort((a, b) => ts(a) - ts(b));
  const types = taskTypes(sorted);
  const start = new Map();
  const rows = {};
  for (const e of sorted) {
    if (e.type === 'agent.session.start') { start.set(e.agent, e); continue; }
    if (e.type !== 'agent.session.end' || e.meta?.outside) continue;
    const s = start.get(e.agent);
    const task = e.meta?.outcome?.task || s?.task || e.task || null;
    const t0 = s ? ts(s) : null;
    const done = Boolean(e.meta?.outcome?.done) || (task && t0 !== null && sorted.some((d) => d.type === 'task.done' && d.task === task && d.agent === e.agent && ts(d) >= t0 && ts(d) <= ts(e)));
    if (!done) continue;
    const type = (task && types.get(task)) || e.meta?.taskType || e.meta?.role || s?.meta?.role || 'unknown';
    const r = (rows[type] ||= { tokens: [], ms: [] });
    r.tokens.push(weight(e));
    if (t0 !== null) r.ms.push(ts(e) - t0);
  }
  const out = {};
  for (const [type, r] of Object.entries(rows)) out[type] = { n: r.tokens.length, p90Tokens: p90(r.tokens), p90Ms: r.ms.length ? p90(r.ms) : null };
  return out;
}

/** A live session's weighted tokens from its stream-json log (cache reads at the meters' weight). */
export function logWeightedTokens(text, w = cacheReadWeight()) {
  let tin = 0; let tout = 0; let cache = 0; const seen = new Set();
  for (const l of String(text || '').split(/\r?\n/)) {
    const t = l.trim();
    if (!t.startsWith('{')) continue;
    let o; try { o = JSON.parse(t); } catch { continue; }
    const u = o.message?.usage || o.usage;
    if (!u) continue;
    const id = o.message?.id;
    if (id) { if (seen.has(id)) continue; seen.add(id); }
    tin += (u.input_tokens ?? u.prompt_tokens ?? 0) + (u.cache_creation_input_tokens || 0);
    cache += u.cache_read_input_tokens || u.cached_input_tokens || 0;
    tout += u.output_tokens ?? u.completion_tokens ?? 0;
  }
  return Math.round(tin + tout + cache * w);
}
const readLogTokens = (s) => { try { return logWeightedTokens(fs.readFileSync(path.resolve(REPO_ROOT, s.log), 'utf8')); } catch { return 0; } };

/**
 * One pass. sessions: the launcher's session records (running ones are checked); events: the log; pause(agent, note):
 * the launcher's pauseAgent (mode on only). Returns { mode, checks: [...], logged: [...] }.
 */
export function futilityPass({ sessions = [], events = [], now = Date.now(), env = process.env, readTokens = readLogTokens, pause = null, emit = emitEvent, dryRun = false } = {}) {
  const mode = futilityMode(env);
  if (mode === 'off') return { mode, checks: [], logged: [] };
  const minN = futilityMinN(env);
  const st = readJson(STATE(), { flagged: {} }) || { flagged: {} };
  st.flagged ||= {};
  const norms = successNorms(events);
  const types = taskTypes(events);
  const checks = []; const logged = [];
  let changed = false;
  for (const s of sessions) {
    if (!s?.running || !s.task || st.flagged[s.agent]) continue;
    const type = types.get(s.task) || s.role || 'unknown';
    const n = norms[type];
    if (!n || n.n < minN) continue;
    const tokens = Number(readTokens(s)) || 0;
    const ms = now - (Date.parse(s.startedAt) || now);
    const overT = n.p90Tokens !== null && tokens > n.p90Tokens;
    const overM = n.p90Ms !== null && ms > n.p90Ms;
    if (!overT && !overM) continue;
    const what = [overT ? `${tokens.toLocaleString('en-US')} tokens (p90 ${Math.round(n.p90Tokens).toLocaleString('en-US')})` : '', overM ? `${Math.round(ms / 60000)} min (p90 ${Math.round(n.p90Ms / 60000)} min)` : ''].filter(Boolean).join(' and ');
    const flag = { at: new Date(now).toISOString(), task: s.task, type, role: s.role || null, kind: overT ? 'tokens' : 'time', tokensAt: tokens, msAt: ms, p90Tokens: n.p90Tokens, p90Ms: n.p90Ms, n: n.n, mode };
    st.flagged[s.agent] = flag; changed = true;
    let action = 'none (shadow mode)';
    if (mode === 'on' && typeof pause === 'function' && !dryRun) {
      try { const r = pause(s.agent, `Futility cap: past the p90 of good runs for ${type} (${what}). Handed back with its work kept; a fresh session continues from the saved diff.`, 'futility'); action = r?.ok === false ? `hand-back failed: ${r.message || '?'}` : 'handed back, diff kept'; } catch (err) { action = `hand-back failed: ${err.message}`; }
    }
    flag.action = action;
    const e = { type: 'futility.check', agent: 'supervisor', to: 'producer', task: s.task, status: 'warn', msg: `Check ${s.agent} on ${s.task}: past the p90 of good runs for ${type} (${what}; n=${n.n}). ${mode === 'on' ? `Futility cap on: ${action}.` : 'Shadow mode (STUDIO_FUTILITY=shadow): nothing was stopped; its end logs what a cap would have saved.'}`.slice(0, 600), meta: { target: s.agent, ...flag } };
    if (!dryRun) emit(e);
    checks.push(e);
  }
  // Flagged sessions that ended since: what the cap would have saved.
  for (const [agent, f] of Object.entries(st.flagged)) {
    const at = Date.parse(f.at) || 0;
    const end = events.find((e) => e.type === 'agent.session.end' && e.agent === agent && ts(e) >= at);
    if (!end) continue;
    const final = weightedTokens(end);
    const saved = Math.max(0, Math.round(final - f.tokensAt));
    const minutes = Math.max(0, Math.round((ts(end) - at) / 60000));
    const good = Boolean(end.meta?.outcome?.done) || events.some((d) => d.type === 'task.done' && d.task === f.task && d.agent === agent && ts(d) >= at && ts(d) <= ts(end));
    const rec = { at: new Date(now).toISOString(), agent, task: f.task, type: f.type, kind: f.kind, mode: f.mode, savedTokens: saved, savedMin: minutes, finalTokens: Math.round(final), cutGoodRun: good };
    const e = { type: 'futility.shadow', agent: 'supervisor', to: 'producer', task: f.task, status: good ? 'warn' : 'ok', msg: `${agent} on ${f.task} ended after its futility check: a cap would have saved ${saved.toLocaleString('en-US')} tokens and ${minutes} min${good ? ', but it landed its task: the cap would have cut a good run short' : ' (it landed nothing)'}.`, meta: rec };
    if (!dryRun) {
      emit(e);
      try { fs.mkdirSync(STUDIO_STATE_DIR, { recursive: true }); fs.appendFileSync(FUTILITY_LOG(), `${JSON.stringify(rec)}\n`); } catch {}
    }
    delete st.flagged[agent]; changed = true;
    logged.push(rec);
  }
  if (changed && !dryRun) { fs.mkdirSync(STUDIO_STATE_DIR, { recursive: true }); fs.writeFileSync(STATE(), `${JSON.stringify(st, null, 2)}\n`); }
  return { mode, checks, logged, norms };
}
