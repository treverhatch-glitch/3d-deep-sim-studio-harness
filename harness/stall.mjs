#!/usr/bin/env node
/**
 * harness/stall.mjs — 2.30o: end a session that has stopped producing work.
 *
 * In the Marina run a Director planning session read about 2M tokens, wrote about 11.5k, ran 56 minutes
 * and landed nothing: session-cap only counts context and turns, so a session that keeps re-reading never
 * tripped it. Now every heartbeat (and every watchdog pass) asks:
 *   - progress: did the session write a file, commit, or change a task's state since its last progress?
 *     (fingerprint = HEAD + `git status --porcelain` of its working copy + its task.* events)
 *   - stall: no progress for STUDIO_STALL_MIN minutes (15; Producer/Director/planner: STUDIO_STALL_PLAN_MIN, 8)
 *   - burn: over the last STUDIO_STALL_RATIO_WINDOW_TOKENS (300000) input tokens the input:output ratio
 *     passed STUDIO_STALL_RATIO (120:1) with no progress in that window
 *   - wall clock: the session ran longer than STUDIO_SESSION_MAX_MIN (90; planning roles
 *     STUDIO_SESSION_PLAN_MAX_MIN, 25)
 * A stalled session is ended and its task handed back with the reason (event session.stall). 0 turns a
 * limit off; STUDIO_STALL=off turns the whole check off.
 *
 *   node harness/stall.mjs check [--json]     every running session's stall state (read-only)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, emitEvent, readRecentEvents } from './event.mjs';

export const PLANNING_ROLES = new Set(['producer', 'director', 'planner']);
const num = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
export function stallLimits(role, env = process.env) {
  const plan = PLANNING_ROLES.has(String(role || '').toLowerCase());
  return {
    stallMin: plan ? num(env.STUDIO_STALL_PLAN_MIN, 8) : num(env.STUDIO_STALL_MIN, 15),
    maxMin: plan ? num(env.STUDIO_SESSION_PLAN_MAX_MIN, 25) : num(env.STUDIO_SESSION_MAX_MIN, 90),
    ratio: num(env.STUDIO_STALL_RATIO, 120),
    ratioWindow: num(env.STUDIO_STALL_RATIO_WINDOW_TOKENS, 300000),
  };
}

const DIR = path.join(STUDIO_STATE_DIR, 'stall');
const stateFile = (agent) => path.join(DIR, `${agent}.json`);
export function readStall(agent) {
  try { return JSON.parse(fs.readFileSync(stateFile(agent), 'utf8')); } catch { return null; }
}
function writeStall(agent, s) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(stateFile(agent), `${JSON.stringify(s, null, 2)}\n`);
}
export const clearStall = (agent) => fs.rmSync(stateFile(agent), { force: true });

/** What the session has produced so far, as one hash. */
export function progressFingerprint(agent, cwd = REPO_ROOT, events = readRecentEvents(5000)) {
  const g = (...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
  const head = g('rev-parse', 'HEAD').stdout?.trim() || '';
  const st = g('status', '--porcelain', '--untracked-files=all').stdout || '';
  // mtimes of changed files, so a rewrite of an already-dirty file counts as a write
  const times = st.split('\n').filter(Boolean).map((l) => l.slice(3).trim()).map((f) => { try { return `${f}:${fs.statSync(path.join(cwd, f)).mtimeMs}`; } catch { return f; } });
  // Not a git checkout: the newest file times stand in (bounded walk).
  if (!head) {
    let seen = 0;
    const walk = (d, depth) => {
      if (depth > 4 || seen > 5000) return;
      let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (/^(node_modules|\.git|\.studio|\.lanes)$/.test(e.name)) continue;
        const p = path.join(d, e.name); seen++;
        if (e.isDirectory()) walk(p, depth + 1);
        else { try { times.push(`${p}:${fs.statSync(p).mtimeMs}`); } catch {} }
      }
    };
    walk(cwd, 0);
    times.sort();
  }
  const ev = events.filter((e) => e.agent === agent && /^(task\.|verdict\.|visual\.)/.test(e.type || '')).length;
  return crypto.createHash('sha1').update(`${head}\n${times.join('\n')}\n${ev}`).digest('hex');
}

/**
 * Pure verdict. s = { role, startedAt, lastProgressAt, tokensIn, tokensOut, windowIn, windowOut }
 * (window* = tokens since the last progress). Returns { stalled, kind, why }.
 */
export function stallVerdict(s, now = Date.now(), lim = stallLimits(s.role)) {
  const ran = (now - Date.parse(s.startedAt)) / 60000;
  const quiet = (now - Date.parse(s.lastProgressAt || s.startedAt)) / 60000;
  if (lim.maxMin > 0 && ran >= lim.maxMin) return { stalled: true, kind: 'wall-clock', why: `ran ${Math.round(ran)} min, past the ${lim.maxMin} min cap for a ${s.role} session` };
  if (lim.stallMin > 0 && quiet >= lim.stallMin) return { stalled: true, kind: 'no-progress', why: `no file write, commit or task change for ${Math.round(quiet)} min (limit ${lim.stallMin})` };
  const wi = Number(s.windowIn || 0); const wo = Number(s.windowOut || 0);
  if (lim.ratio > 0 && lim.ratioWindow > 0 && wi >= lim.ratioWindow && wi / Math.max(1, wo) >= lim.ratio) return { stalled: true, kind: 'read-burn', why: `read ${wi} tokens and wrote ${wo} (${Math.round(wi / Math.max(1, wo))}:1, limit ${lim.ratio}:1) with no progress` };
  return { stalled: false, kind: null, why: '', ranMin: Math.round(ran), quietMin: Math.round(quiet) };
}

/**
 * One observation for a running session (called from the launcher's heartbeat and the watchdog).
 * tokens = { in, out } so far. Updates .studio/stall/<agent>.json and returns the verdict.
 */
export function observe(session, { tokens = { in: 0, out: 0 }, cwd = REPO_ROOT, now = Date.now(), events } = {}) {
  if (/^off$/i.test(process.env.STUDIO_STALL || '')) return { stalled: false, kind: null, why: 'STUDIO_STALL=off' };
  const fp = progressFingerprint(session.agent, cwd, events);
  const prev = readStall(session.agent);
  const fresh = !prev || prev.startedAt !== session.startedAt;
  let s = fresh ? { agent: session.agent, role: session.role, startedAt: session.startedAt, fp, lastProgressAt: session.startedAt, baseIn: 0, baseOut: 0 } : prev;
  if (!fresh && fp !== prev.fp) s = { ...s, fp, lastProgressAt: new Date(now).toISOString(), baseIn: tokens.in, baseOut: tokens.out };
  s.tokensIn = tokens.in; s.tokensOut = tokens.out;
  s.windowIn = tokens.in - (s.baseIn || 0); s.windowOut = tokens.out - (s.baseOut || 0);
  const v = stallVerdict(s, now);
  s.verdict = v;
  writeStall(session.agent, s);
  return v;
}

/** Cumulative tokens from a stream-json log (each assistant message's usage), for a live session. */
export function logTokens(log) {
  let tin = 0; let tout = 0; const seen = new Set();
  for (const l of String(log || '').split(/\r?\n/)) {
    const t = l.trim();
    if (!t.startsWith('{')) continue;
    let o; try { o = JSON.parse(t); } catch { continue; }
    const u = o.message?.usage || o.usage;
    if (!u) continue;
    const id = o.message?.id;
    if (id) { if (seen.has(id)) continue; seen.add(id); }
    tin += (u.input_tokens ?? u.prompt_tokens ?? 0) + (u.cache_read_input_tokens || u.cached_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    tout += u.output_tokens ?? u.completion_tokens ?? 0;
  }
  return { in: tin, out: tout };
}

/**
 * 2.30o: an idle session ends itself. idleSince = when it last held no task (null while it holds one).
 * Any role by default (STUDIO_IDLE_EXIT_ROLES, '*'); minutes: STUDIO_IDLE_EXIT_MIN (5, 0 = off). A session that
 * writes, commits or changes a task (stall.mjs progress) is not idle, so a planning pass that is writing stays.
 * Separate from the watchdog's whole-studio idle stop: this frees one slot.
 */
export function idleVerdict({ role, startedAt, idleSince }, now = Date.now(), env = process.env) {
  const roles = String(env.STUDIO_IDLE_EXIT_ROLES ?? '*').split(',').map((x) => x.trim()).filter(Boolean);
  const min = num(env.STUDIO_IDLE_EXIT_MIN, 5);
  if (!min || !(roles.includes('*') || roles.includes(String(role))) || !idleSince) return { exit: false };
  const since = Math.max(Date.parse(idleSince), Date.parse(startedAt || idleSince));
  const m = (now - since) / 60000;
  return m >= min ? { exit: true, why: `no task claimed for ${Math.round(m)} min (limit ${min})` } : { exit: false, idleMin: Math.round(m) };
}

/** Log a stall once. */
export function logStall(session, v) {
  emitEvent({ type: 'session.stall', agent: 'watchdog', to: 'producer', task: session.task || undefined, status: 'warn', msg: `Ended ${session.agent} (${session.role}${session.task ? `, ${session.task}` : ''}): ${v.why}`, meta: { kind: v.kind, target: session.agent, role: session.role } });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const { sessions } = await import('./agent.mjs');
  const rows = sessions().filter((s) => s.running).map((s) => ({ agent: s.agent, role: s.role, ...(readStall(s.agent)?.verdict || { stalled: false, why: 'not observed yet' }) }));
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows));
  else console.log(rows.length ? rows.map((r) => `${r.agent} (${r.role}): ${r.stalled ? `STALLED ${r.why}` : `ok${r.quietMin != null ? `, quiet ${r.quietMin} min` : ''}`}`).join('\n') : 'No running sessions.');
}
