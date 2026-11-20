/**
 * harness/landing-post.mjs — the post for one engine-train landing (task.train.<x>.landed), built for the Communicator.
 * The tasks landed with their titles (8 at most, then "and n more"), how many landed in the last 24 hours, the line of
 * engines.<x>.progress when it prints one, and "Systems ON: n of m" when engines.<x>.switches is set.
 * engines.<x>.announce: false turns the post off for that engine. A leaf: the communicator keeps what it posted.
 */
import { enginesConfig, engineTarget } from './engine-tracks.mjs';
import { landedCounts, tasksOf } from './landings.mjs';
import { tsMs } from './helpers.mjs';

const DAY = 86400000;
const MAX_TASKS = 8;
const ENGINE_LANDED = /^task\.train\.([a-z][a-z0-9-]{1,30})\.landed$/;
const line = (s, n) => { const t = String(s ?? '').replace(/\[ref:[^\]]*\]/g, '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** The landings of the last 24 h not posted yet (keys in `seen`): [{ key, engine, tasks, at }], oldest first. */
export function pendingLandings(events, seen = [], { now = Date.now(), root } = {}) {
  const done = new Set(seen);
  const out = [];
  for (const e of events || []) {
    const m = ENGINE_LANDED.exec(String(e?.type || ''));
    const at = tsMs(e);
    if (!m || at < now - DAY || at > now + 60000) continue;
    const key = String(e.id || `${e.ts}|${m[1]}|${e.meta?.train || ''}`);
    if (done.has(key) || out.some((x) => x.key === key)) continue;
    out.push({ key, engine: m[1], tasks: tasksOf(e, 'engine'), at, off: enginesConfig(root)[m[1]]?.announce === false });
  }
  return out;
}

/** The text of one landing. deps (tests): { titles: { id: title }, progress: (engine) => line|null, switches: async (engine) => line }. */
export async function landingText(l, { events = [], now = Date.now(), root, deps = {} } = {}) {
  let titles = deps.titles;
  if (!titles) {
    titles = {};
    try { const q = (await import('./task.mjs')).parseNextQueue(); for (const t of [...q.inProgress, ...q.backlog, ...q.done]) titles[t.id] = t.title; } catch { /* ids alone */ }
  }
  const label = engineTarget(l.engine, { root })?.label || l.engine;
  const shown = l.tasks.slice(0, MAX_TASKS).map((t) => `- ${t}${titles[t] ? ` ${line(titles[t], 90)}` : ''}`);
  const more = l.tasks.length - shown.length;
  const L = [`${label} landing ${hhmm(l.at)}: ${l.tasks.length} task${l.tasks.length === 1 ? '' : 's'} landed`, ...shown];
  if (more > 0) L.push(`and ${more} more`);
  const win = events.filter((e) => tsMs(e) >= now - DAY && tsMs(e) <= now + 60000);
  L.push(`${landedCounts(win, events).count} landed in the last 24 hours.`);
  try {
    let p = null;
    if (deps.progress) p = deps.progress(l.engine);
    else p = (await import('./score.mjs')).engineProgress(root, { timeoutMs: 10000, only: l.engine })[0]?.line || null;
    if (p) L.push(line(p, 200));
  } catch { /* a progress command that fails is left out */ }
  try {
    let s = '';
    if (deps.switches) s = await deps.switches(l.engine);
    else { const sw = await import('./switches.mjs'); const r = await sw.readSwitches(l.engine, { root, tasks: [] }); s = r && !r.bad ? sw.switchesLine(r) : ''; }
    if (s) L.push(s);
  } catch { /* left out */ }
  return L.join('\n');
}
