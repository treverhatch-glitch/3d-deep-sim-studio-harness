/**
 * harness/task-hold.mjs — why a waiting task must not start yet, and which folder (lane) it works in.
 *
 *   npm run task -- add "…" --after T-011[,T-012]          waits until those tasks are done
 *   npm run task -- block T-020 --until T-011|2026-10-22T09:00 --by <name> [--why "…"]
 *   npm run task -- park T-020 --by <name> --why "…"         parked: never starts until unparked
 *   npm run task -- unpark T-020 --by <name>
 *   npm run task -- lane T-020 game/next-floor/src/floors --by <name>   (or "none" to clear it)
 *   npm run agent -- stop|pause <agent>                      the task can't restart for STUDIO_STOP_COOLDOWN_MIN (15)
 *
 * Run #1: QA started on an unmerged build, Director-parked tasks still started, and a stopped agent's
 * task restarted within seconds under a new name. The supervisor, `task next` and `task start` all
 * ask holdReason() first. Holds live in studio/task-holds.json (a studio file: it travels with the game).
 *
 * Lanes: a task's folder comes from `task lane`, else `--lane` when it was added, else its part:
 * --part sim → cartridges/<game>, --part renderer → game/<game> (or web/<game>). A builder with no
 * lane works on the whole game, so no other builder runs beside it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, emitEvent, readRecentEvents } from './event.mjs';
import { activeCartridge, isTemplateCartridge } from './cartridge.mjs';

export const HOLDS_FILE = path.join(REPO_ROOT, 'studio', 'task-holds.json');
export const STOP_COOLDOWN_MIN = () => Number(process.env.STUDIO_STOP_COOLDOWN_MIN ?? 15);

export function readHolds() {
  try {
    return JSON.parse(fs.readFileSync(HOLDS_FILE, 'utf8')).tasks || {};
  } catch {
    return {};
  }
}
function writeHolds(tasks) {
  fs.mkdirSync(path.dirname(HOLDS_FILE), { recursive: true });
  fs.writeFileSync(HOLDS_FILE, `${JSON.stringify({ tasks }, null, 2)}\n`);
}
/** Merge fields into one task's hold; a null value removes that field. */
export function setHold(id, patch, { by = 'producer', msg = '' } = {}) {
  const all = readHolds();
  const h = { ...(all[id] || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || (Array.isArray(v) && !v.length)) delete h[k];
    else h[k] = v;
  }
  if (Object.keys(h).length) all[id] = h;
  else delete all[id];
  writeHolds(all);
  if (msg) emitEvent({ type: 'task.hold', agent: by, task: id, msg });
  return h;
}

const doneIds = (q) => new Set(q.done.map((t) => t.id));
const hhmm = (iso) => new Date(iso).toTimeString().slice(0, 5);

/**
 * A park with --until ends by itself (Jed's run: tasks parked "until Phase 2" stayed parked 5 h after it
 * opened): a task id (done), phase:N (Phase N is open in the Game Bible), or a time.
 */
export function parkOver(until, done, now = Date.now()) {
  if (!until) return false;
  if (/^[A-Z]+-\d+$/.test(until)) return done.has(until);
  const ph = String(until).match(/^phase:(\d+)$/i);
  if (ph) {
    try {
      return (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'studio', 'bible', 'bible.json'), 'utf8')).phase?.open || 0) >= Number(ph[1]);
    } catch {
      return false;
    }
  }
  const t = Date.parse(until);
  return Number.isFinite(t) && t <= now;
}

/** Why this task can't start now, or null. `q` is parseNextQueue(). */
export function holdReason(taskId, q, now = Date.now(), holds = readHolds()) {
  const h = holds[taskId];
  if (!h) return null;
  const done = doneIds(q);
  if (h.parked && !parkOver(h.parked.until, done, now)) return `parked by ${h.parked.by}${h.parked.why ? `: ${h.parked.why}` : ''}${h.parked.until ? ` (until ${h.parked.until})` : ''}`;
  const waiting = (h.after || []).filter((id) => !done.has(id));
  if (waiting.length) return `waits for ${waiting.join(', ')}`;
  if (h.until && Date.parse(h.until) > now) return `blocked until ${hhmm(h.until)}${h.why ? `: ${h.why}` : ''}`;
  if (h.cooldownUntil && Date.parse(h.cooldownUntil) > now) return `stopped by ${h.cooldownBy || 'someone'}; can restart after ${hhmm(h.cooldownUntil)}`;
  return null;
}

/** The game's folders, for lanes inferred from --part. */
export function gameFolders() {
  const name = activeCartridge().name;
  if (!name || isTemplateCartridge(name)) return { sim: null, renderer: null, name };
  const rel = (p) => (fs.existsSync(path.join(REPO_ROOT, p)) ? p : null);
  return { name, sim: rel(`cartridges/${name}`), renderer: rel(`game/${name}`) || rel(`web/${name}`) };
}

/** A task's lane: `task lane`, else --lane when added, else from --part; null = the whole game. */
export function laneOf(taskId, events = readRecentEvents(20000), holds = readHolds()) {
  const h = holds[taskId];
  if (h && 'lane' in h) return h.lane || null;
  const meta = events.filter((e) => e.type === 'task.added' && e.task === taskId).pop()?.meta || {};
  if (meta.lane) return meta.lane;
  const f = gameFolders();
  if (meta.part === 'sim') return f.sim;
  if (meta.part === 'renderer') return f.renderer;
  return null;
}

/** Two lanes clash when one holds the other (or either is the whole game). */
export const lanesClash = (a, b) => !a || !b || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/** After `agent stop` / `agent pause`: the task can't restart for a while (default 15 min). */
export function cooldown(taskId, by, minutes = STOP_COOLDOWN_MIN()) {
  if (!taskId || !(minutes > 0)) return null;
  const until = new Date(Date.now() + minutes * 60000).toISOString();
  setHold(taskId, { cooldownUntil: until, cooldownBy: by });
  return until;
}
