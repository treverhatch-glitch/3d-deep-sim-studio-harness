#!/usr/bin/env node
/**
 * harness/winddown.mjs — 2.68.0: usage wind-down. Stop starting work before the plan runs out, not at the wall.
 *
 *   npm run studio:winddown                       is the studio winding down, and why
 *   npm run studio:winddown -- --now --by <name> [--why "…"]   wind down now, on demand
 *   npm run studio:winddown -- --off --by <name> [--permission "…"]   end a wind-down before the reset
 *
 * STUDIO_USAGE_WINDDOWN_PCT (unset: off), e.g. 90. The usage figure is the one the harness already tracks
 * (harness/budget.mjs budgetStatus): the highest share of a tool's week used (tools with --weekly set), and a tool
 * marked out of quota (its provider's limit line) counts as 100% until its reset. At or above the setting the
 * supervisor starts no new sessions, lets the running ones finish, writes .studio/restart-log.md (what was running,
 * queued and held, and the next steps) and emits studio.winddown. When the usage resets (the figure falls back under
 * the setting, or a wind-down asked with --now reaches the soonest reset), the supervisor resumes on its own and its
 * studio.winddown_resumed event links the restart log.
 * Who: --now, anyone but a worker (it only stops new starts); --off, a person, an agent under the owner's delegation for
 * hold, or a Producer/Director session or outside agent on a person's permission (harness/decider.mjs).
 * State: .studio/winddown.json. Only event.mjs is imported at load (the supervisor imports this file).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STUDIO_STATE_DIR, emitEvent } from './event.mjs';

export const WINDDOWN_FILE = () => path.join(STUDIO_STATE_DIR, 'winddown.json');
export const RESTART_LOG = () => path.join(STUDIO_STATE_DIR, 'restart-log.md');
export const RESTART_LOG_REL = '.studio/restart-log.md';
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

/** STUDIO_USAGE_WINDDOWN_PCT as a percent (1-100), or null (off). */
export function winddownPct(env = process.env) {
  const raw = String(env.STUDIO_USAGE_WINDDOWN_PCT ?? '').trim().replace(/%$/, '');
  if (!raw || /^(off|no|false)$/i.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(100, n) : null;
}

/** The usage figure from budgetStatus rows: { pct (0-1), tool, resets } or null when nothing is known. */
export function usageFigure(rows = [], now = Date.now()) {
  let best = null;
  for (const r of rows || []) {
    const out = r.exhaustedUntil && Date.parse(r.exhaustedUntil) > now;
    const pct = out ? Math.max(1, Number(r.pct) || 0) : Number.isFinite(r.pct) && r.pct !== null ? r.pct : null;
    if (pct === null) continue;
    const resets = out ? r.exhaustedUntil : r.resets || null;
    if (!best || pct > best.pct) best = { pct, tool: r.tool, resets, out: Boolean(out) };
  }
  return best;
}
export const readWinddown = () => readJson(WINDDOWN_FILE(), null);

/** The restart log's text. live: [{ agent, role, task }]; queued: [{ id, role, title }]; held: [{ id, why }]. */
export function restartLogText({ at, why, resets = null, live = [], queued = [], held = [] }) {
  const L = [`# Restart log (usage wind-down) ${at}`, '', `Why: ${why}`, `Resumes: ${resets ? `when usage resets (${resets})` : 'when usage falls back under the setting'}, by itself; its studio.winddown_resumed event links this file.`, '', `## Running (left to finish their task) (${live.length})`];
  L.push(...(live.length ? live.map((s) => `- ${s.agent} (${s.role || '?'})${s.task ? ` on ${s.task}` : ''}`) : ['- none']));
  L.push('', `## Queued (not started) (${queued.length})`, ...(queued.length ? queued.slice(0, 60).map((t) => `- ${t.id}${t.role ? ` (${t.role})` : ''}${t.title ? `: ${String(t.title).slice(0, 100)}` : ''}`) : ['- none']));
  if (queued.length > 60) L.push(`- … ${queued.length - 60} more (studio/NEXT.md)`);
  L.push('', `## Held (${held.length})`, ...(held.length ? held.map((h) => `- ${h.id}: ${String(h.why || '').slice(0, 140)}`) : ['- none']));
  L.push('', '## Next steps', '1. The sessions above finish their tasks; read their hand-backs (studio/handoffs/) when they end.', '2. At the reset the supervisor starts the queued work again in board order; nothing to do by hand.', '3. Held tasks stay held until their reason clears (npm run task -- holds).', '4. To resume before the reset: npm run studio:winddown -- --off --by <name>.', '');
  return L.join('\n');
}

function begin({ now, why, figure, threshold, manual = false, by = null, until = null, live = [], queued = [], held = [], emit = emitEvent }) {
  const at = new Date(now).toISOString();
  const resets = until || figure?.resets || null;
  fs.mkdirSync(STUDIO_STATE_DIR, { recursive: true });
  fs.writeFileSync(RESTART_LOG(), restartLogText({ at, why, resets, live, queued, held }));
  const st = { at, why, pct: figure ? Math.round(figure.pct * 1000) / 10 : null, threshold, tool: figure?.tool || null, resets, manual, by, until, file: RESTART_LOG_REL, running: live.length, queued: queued.length, held: held.length };
  fs.writeFileSync(WINDDOWN_FILE(), `${JSON.stringify(st, null, 2)}\n`);
  emit({ type: 'studio.winddown', agent: by || 'supervisor', to: 'producer', status: 'warn', msg: `Winding down: ${why}. No new sessions; ${live.length} running finish their task. Restart log: ${RESTART_LOG_REL}`.slice(0, 600), meta: st });
  return st;
}

/**
 * The supervisor's pass. rows: budgetStatus(now); lists: { live, queued, held } (or a function giving it, called only
 * when a wind-down starts) for the restart log. Returns { active, why, state }.
 */
export function winddownPass({ now = Date.now(), env = process.env, rows = [], lists = null, emit = emitEvent, dryRun = false } = {}) {
  const threshold = winddownPct(env);
  const st = readWinddown();
  const figure = usageFigure(rows, now);
  if (st) {
    // An automatic wind-down ends when the figure is back under the setting it started at (the week rolled over, or
    // the quota mark expired); one asked with --now at the soonest reset it knew of.
    const reset = st.manual ? (st.until ? now >= Date.parse(st.until) : false) : (!figure || figure.pct * 100 < (st.threshold || threshold || 100));
    if (!reset) return { active: true, why: `winding down since ${st.at.slice(11, 16)} UTC: ${st.why} (restart log ${st.file})`, state: st };
    if (!dryRun) {
      fs.rmSync(WINDDOWN_FILE(), { force: true });
      emit({ type: 'studio.winddown_resumed', agent: 'supervisor', to: 'producer', msg: `Usage reset${figure ? ` (${figure.tool} at ${Math.round(figure.pct * 100)}%)` : ''}: starting sessions again. Restart log from ${st.at}: ${st.file}`, meta: { restartLog: st.file, since: st.at, pct: figure ? Math.round(figure.pct * 1000) / 10 : null, tool: figure?.tool || null } });
    }
    return { active: false, resumed: true, restartLog: st.file };
  }
  if (threshold === null || !figure || figure.pct * 100 < threshold) return { active: false };
  const why = `usage ${Math.round(figure.pct * 100)}% (${figure.tool}${figure.out ? ', out of quota' : ''}) is at or above STUDIO_USAGE_WINDDOWN_PCT=${threshold}%`;
  if (dryRun) return { active: true, why: `would wind down: ${why}` };
  let l = {};
  try { l = (typeof lists === 'function' ? lists() : lists) || {}; } catch { l = {}; }
  const s = begin({ now, why, figure, threshold, live: l.live || [], queued: l.queued || [], held: l.held || [], emit });
  return { active: true, started: true, why: `winding down: ${why} (restart log ${s.file})`, state: s };
}

async function studioLists() {
  let live = []; let queued = []; let held = [];
  try { live = (await import('./agent.mjs')).sessions().filter((s) => s.running).map((s) => ({ agent: s.agent, role: s.role, task: s.task })); } catch {}
  try { const q = (await import('./task.mjs')).parseNextQueue(); queued = (q.backlog || []).map((t) => ({ id: t.id, role: t.role, title: t.title })); } catch {}
  try { held = Object.entries((await import('./task-hold.mjs')).readHolds()).filter(([, h]) => h?.held).map(([id, h]) => ({ id, why: h.held.why || h.held.reason || 'held' })); } catch {}
  return { live, queued, held };
}

/** `--now`: wind down on demand (until the soonest known reset; --off ends it). */
export async function winddownNow({ by, why = '', env = process.env, now = Date.now(), rows = null, lists = null } = {}) {
  const who = String(by || '').trim();
  if (!who) return { code: 1, text: 'Say who asks: npm run studio:winddown -- --now --by <name> [--why "…"]' };
  const { WORKER_NAME } = await import('./permission.mjs');
  const role = String(env.STUDIO_ROLE || '').trim();
  const worker = [String(env.STUDIO_LOCK_OWNER || '').trim(), who].find((n) => n && WORKER_NAME.test(n)) || (role && !/^(producer|director)$/i.test(role) ? `a launched ${role} session` : null);
  if (worker) return { code: 1, text: `Refused: ${worker} is a worker; a person, the Producer or Director, or an outside agent winds the studio down.` };
  if (readWinddown()) return { code: 0, text: `Already winding down (since ${readWinddown().at}); restart log ${RESTART_LOG_REL}.` };
  let r = rows;
  if (!r) { try { r = (await import('./budget.mjs')).budgetStatus(now); } catch { r = []; } }
  const figure = usageFigure(r, now);
  const resets = (r || []).map((x) => (x.exhaustedUntil && Date.parse(x.exhaustedUntil) > now ? x.exhaustedUntil : x.resets)).filter((x) => x && Date.parse(x) > now).sort()[0] || null;
  const l = lists || (await studioLists());
  const s = begin({ now, why: `asked by ${who}${why ? `: ${String(why).slice(0, 200)}` : ''}${figure ? ` (usage ${Math.round(figure.pct * 100)}%, ${figure.tool})` : ''}`, figure, threshold: winddownPct(env), manual: true, by: who, until: resets, ...l });
  return { code: 0, text: `Winding down: no new sessions; ${l.live.length} running finish their task. Restart log: ${s.file}. ${resets ? `Resumes at ${resets}` : 'No reset time known: resume with npm run studio:winddown -- --off --by <name>'}.` };
}

/** `--off`: end a wind-down before the reset. */
export async function winddownOff({ by, permission = '', env = process.env } = {}) {
  const st = readWinddown();
  if (!st) return { code: 0, text: 'Not winding down; nothing to end.' };
  const { deciderCheck } = await import('./decider.mjs');
  const d = await deciderCheck({ by, permission, env, what: 'end a usage wind-down' });
  if (!d.ok) return { code: 1, text: d.why };
  fs.rmSync(WINDDOWN_FILE(), { force: true });
  emitEvent({ type: 'studio.winddown_resumed', agent: String(d.recordedBy || d.by).slice(0, 60), to: 'producer', msg: `${d.by} ended the wind-down from ${st.at} before the reset${d.via !== 'person' ? ` (recorded by ${d.recordedBy})` : ''}. Restart log: ${st.file}`, meta: { restartLog: st.file, since: st.at, by: d.by, via: d.via, recordedBy: d.recordedBy, permission: d.permission || null } });
  return { code: 0, text: `Ended the wind-down (since ${st.at}); the supervisor starts sessions again on its next pass. Restart log: ${st.file}.` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  let r;
  if (argv.includes('--now')) r = await winddownNow({ by: flag('by'), why: flag('why') || '' });
  else if (argv.includes('--off')) r = await winddownOff({ by: flag('by'), permission: flag('permission') || '' });
  else if (!argv.length) { const st = readWinddown(); r = { code: 0, text: st ? `Winding down since ${st.at}: ${st.why}. Restart log: ${st.file}.` : `Not winding down (STUDIO_USAGE_WINDDOWN_PCT ${winddownPct() === null ? 'unset: off' : `${winddownPct()}%`}).` }; }
  else r = { code: 2, text: 'Usage: npm run studio:winddown [-- --now --by <name> [--why "…"] | --off --by <name> [--permission "…"]]' };
  (r.code ? console.error : console.log)(r.text);
  process.exit(r.code);
}
