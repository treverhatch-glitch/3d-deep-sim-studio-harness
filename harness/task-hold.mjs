/**
 * harness/task-hold.mjs — why a waiting task must not start yet, and which folder (lane) it works in.
 *
 *   npm run task -- add "…" --after T-011[,T-012]          waits until those tasks are done
 *   npm run task -- block T-020 --until T-011|2026-10-22T09:00 --by <name> [--why "…"]
 *   npm run task -- park T-020 --by <name> --why "…"         parked: never starts until unparked
 *   npm run task -- unpark T-020 --by <name>
 *   npm run task -- lane T-020 game/next-floor/src/floors --by <name>   (or "none" to clear it)
 *   npm run task -- hold T-020 --by <name> --why "…"         2.60.1 (B-39): held for landing (a conductor or integrator
 *   npm run task -- unhold T-020 --by <name>                 parks the lane on purpose): no claim clock, no rescue
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
import { REPO_ROOT, STUDIO_STATE_DIR, emitEvent, readRecentEvents } from './event.mjs';
import { activeGame, isTemplateCartridge } from './cartridge.mjs';
import { isFixTask, trunkState } from './baseline.mjs';
import { withFileLock, writeAtomic } from './fsafe.mjs';
import { WORKER_NAME, DECIDER_ROLES } from './permission.mjs';

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
  // 2.57.0 (PU-16): replaced whole, so a reader never sees half of it.
  writeAtomic(HOLDS_FILE, `${JSON.stringify({ tasks }, null, 2)}\n`);
}
/**
 * 2.57.0 (PU-16, P-041): read, change and write the holds under one lock (.studio/locks/holds.mutex): ten parks at
 * the same moment used to keep one. `fn(all)` changes the map in place; its return value is returned. A holds file
 * that is there but unreadable is copied aside (studio/task-holds.json.unreadable-<time>) before it is replaced.
 */
export function updateHolds(fn) {
  return withFileLock('holds', () => {
    let all = {};
    let raw = null;
    try { raw = fs.readFileSync(HOLDS_FILE, 'utf8'); } catch { /* none yet */ }
    if (raw !== null) {
      try {
        all = JSON.parse(raw).tasks || {};
      } catch {
        try { fs.writeFileSync(`${HOLDS_FILE}.unreadable-${new Date().toISOString().replace(/[-:.]/g, '')}`, raw); } catch { /* best effort */ }
        console.warn('[holds] studio/task-holds.json was unreadable; a copy was kept beside it and it starts empty');
      }
    }
    const out = fn(all);
    writeHolds(all);
    return out;
  }, { dir: path.join(STUDIO_STATE_DIR, 'locks'), what: 'The task holds (studio/task-holds.json)' });
}
/** Merge fields into one task's hold; a null value removes that field. */
export function setHold(id, patch, { by = 'producer', msg = '' } = {}) {
  const h = updateHolds((all) => {
    const one = { ...(all[id] || {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === undefined || (Array.isArray(v) && !v.length)) delete one[k];
      else one[k] = v;
    }
    if (Object.keys(one).length) all[id] = one;
    else delete all[id];
    return one;
  });
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

/**
 * 2.60.1 (B-39): a task whose lane is waiting to land on purpose: held (`task hold`, by a Producer, Director or an
 * outside agent such as a merge conductor) or queued for the merge train (`task done --train`). Its claim clock doesn't
 * run and no rescue is filed for it. Returns { via: 'hold'|'train', by, why, at } or null.
 */
export function heldForLanding(taskId, { holds = readHolds(), queue = null } = {}) {
  const h = holds[taskId]?.held;
  if (h) return { via: 'hold', by: h.by || 'someone', why: h.why || '', at: h.at || null };
  let q = queue;
  if (!q) { try { q = JSON.parse(fs.readFileSync(path.join(STUDIO_STATE_DIR, 'train', 'queue.json'), 'utf8')); } catch { q = []; } }
  const e = Array.isArray(q) ? q.find((x) => x?.task === taskId) : null;
  return e ? { via: 'train', by: e.agent || 'the merge train', why: `queued for the merge train${e.at ? ` since ${String(e.at).slice(0, 16)}` : ''}`, at: e.at || null } : null;
}
export const heldWords = (h) => (h.via === 'train' ? h.why : `held for landing by ${h.by}${h.why ? `: ${h.why}` : ''}`);

/** Who may hold a lane: a person, a Producer or Director session, or an agent outside the harness; never a worker. */
export function holdRefusal(by, env = process.env, { workerName = WORKER_NAME, deciders = DECIDER_ROLES } = {}) {
  const role = String(env.STUDIO_ROLE || '').trim();
  const owner = String(env.STUDIO_LOCK_OWNER || '').trim();
  if (!String(by || '').trim()) return 'Say who holds it: --by <name>.';
  if (role && !deciders.test(role)) return `Refused: a launched ${role} session can't hold a lane; a Producer or Director session, a person, or an agent outside the harness (a merge conductor) can.`;
  const worker = [owner, String(by).trim()].find((n) => n && workerName.test(n));
  if (worker) return `Refused: ${worker} is a worker agent; a Producer or Director session, a person, or an agent outside the harness (a merge conductor) holds lanes.`;
  return null;
}

/** Why this task can't start now, or null. `q` is parseNextQueue(). */
export function holdReason(taskId, q, now = Date.now(), holds = readHolds()) {
  // 2.54.0 (PU-06): a red trunk starts only fix tasks (work in progress carries on).
  if (q && !q.inProgress?.some((t) => t.id === taskId)) {
    const t = [...(q.backlog || [])].find((x) => x.id === taskId);
    if (t && t.role === 'builder' && !isFixTask(t)) {
      const tr = trunkState();
      if (tr.red) return `the game's trunk is red (${tr.why}); only fix tasks start until it is green (npm run task -- trunk green --by <name>)`;
    }
  }
  // 2.60.1 (B-39): a rescue for a lane that is held or queued for the train would send a builder into mid-integration work.
  const rt = q ? [...(q.backlog || []), ...(q.inProgress || [])].find((x) => x.id === taskId) : null;
  const stuck = rt && !q.inProgress?.some((x) => x.id === taskId) ? (String(rt.title || '').match(/^Rescue:\s*(T-\d+)\b/) || [])[1] : null;
  if (stuck) {
    const hl = heldForLanding(stuck, { holds });
    if (hl) return `a rescue for ${stuck}, which is ${heldWords(hl)}; it closes when ${stuck} lands`;
  }
  const h = holds[taskId];
  if (!h) return null;
  const done = doneIds(q);
  if (h.held && !q?.inProgress?.some((x) => x.id === taskId)) return `${heldWords({ via: 'hold', ...h.held })} (npm run task -- unhold ${taskId} --by <name>)`;
  if (h.needsYes) return `an agent-proposed mechanic; it starts when the dev says yes (npm run task -- yes ${taskId} --by <dev>)`;
  if (h.parked && !parkOver(h.parked.until, done, now)) return `parked by ${h.parked.by}${h.parked.why ? `: ${h.parked.why}` : ''}${h.parked.until ? ` (until ${h.parked.until})` : ''}`;
  const waiting = (h.after || []).filter((id) => !done.has(id));
  if (waiting.length) return `waits for ${waiting.join(', ')}`;
  if (h.until && Date.parse(h.until) > now) return `blocked until ${hhmm(h.until)}${h.why ? `: ${h.why}` : ''}`;
  if (h.cooldownUntil && Date.parse(h.cooldownUntil) > now) return `stopped by ${h.cooldownBy || 'someone'}; can restart after ${hhmm(h.cooldownUntil)}`;
  return null;
}

/**
 * Who a waiting task waits on, and why (2.30, J10): every "waiting on" names an owner.
 * Returns null when the task can start.
 */
export function holdOwner(taskId, q, now = Date.now(), holds = readHolds(), holders = new Map()) {
  const why = holdReason(taskId, q, now, holds);
  if (!why) return null;
  if (/trunk is red/.test(why)) return { owner: 'the trunk fix', why };
  const h = holds[taskId] || {};
  if (h.needsYes) return { owner: 'the dev', why };
  if (h.parked && !parkOver(h.parked.until, doneIds(q), now)) return { owner: h.parked.by || 'the Producer', why };
  const waiting = (h.after || []).filter((id) => !doneIds(q).has(id));
  if (waiting.length) return { owner: holders.get(waiting[0]) || (q.inProgress.some((t) => t.id === waiting[0]) ? 'its builder' : 'the queue (not started yet)'), why };
  if (h.cooldownUntil && Date.parse(h.cooldownUntil) > now) return { owner: h.cooldownBy || 'the Producer', why };
  return { owner: h.by || 'the clock', why };
}

/** The game's folders, for lanes inferred from --part. */
export function gameFolders() {
  const name = activeGame().name;
  if (!name || isTemplateCartridge(name)) return { sim: null, renderer: null, name };
  const rel = (p) => (fs.existsSync(path.join(REPO_ROOT, p)) ? p : null);
  const renderer = rel(`game/${name}`) || rel(`web/${name}`);
  // 2.30l: a web game keeps its sim beside the renderer (web/<game>/sim) when it has no cartridge.
  return { name, sim: rel(`cartridges/${name}`) || (renderer ? rel(`${renderer}/sim`) : null), renderer };
}

/** A lane as a list of paths (2.30k): one folder, or several files joined by commas. */
export const laneList = (lane) => (Array.isArray(lane) ? lane : String(lane || '').split(','))
  .map((p) => p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')).filter(Boolean);

// Words in a title that point at a file whose name doesn't say it (2.30k). Kept short on purpose.
const HINTS = {
  boats: /\b(boats?|ships?|yachts?|vessels?|wake|dock(ing|ed)?|moor(ing)?|sail(ing|s)?|ferr(y|ies))\b/i,
  water: /\b(water|waves?|sea|ocean|tide|foam|ripples?)\b/i,
  world: /\b(world|buildings?|harbou?r|marina|piers?|scenery|lights?|lighting|sky|terrain|fuel dock|shadows?)\b/i,
  hud: /\b(hud|ui|buttons?|panels?|menus?|toolbar|tooltips?|css|layout)\b/i,
  copy: /\b(copy|text|labels?|wording|messages?|strings?)\b/i,
  sim: /\b(sim|economy|money|balance|prices?|score|win|lose|losing|bankrupt|rules?|fees?|policy)\b/i,
};

/**
 * The files a task likely touches (2.30k), from its title and brief and the game's own code files.
 * A file counts when its name is in the text or a hint word for it is. Returns [] when nothing
 * matches, so the caller falls back to the whole folder.
 */
export function inferPaths(text, folder, files = null) {
  if (!folder || !text) return [];
  let list = files;
  if (!list) {
    const map = (() => { try { return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.studio', 'MAP.json'), 'utf8')); } catch { return null; } })();
    list = (map?.files || []).map((f) => f.file);
    if (!list.some((f) => f.startsWith(`${folder}/`))) {
      const walk = (d) => { try { return fs.readdirSync(path.join(REPO_ROOT, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`])); } catch { return []; } };
      list = walk(folder);
    }
  }
  const own = list.filter((f) => f.startsWith(`${folder}/`) && !/\/(jsm|vendor|node_modules|assets?)\//.test(f) && !/(^|\/)three\.[^/]+$/.test(f) && /\.(m?js|ts|css|html|gd|json)$/.test(f));
  const out = new Set();
  for (const f of own) {
    const rel = f.slice(folder.length + 1);
    const stem = path.basename(f).replace(/\.[^.]+$/, '').toLowerCase();
    const dir = rel.includes('/') ? rel.split('/')[0] : null;
    const key = dir && HINTS[dir] ? dir : stem;
    if (stem.length > 2 && new RegExp(`\\b${stem.replace(/[^a-z0-9]/g, '')}\\b`, 'i').test(text)) out.add(dir && HINTS[dir] ? `${folder}/${dir}` : f);
    else if (HINTS[key] && HINTS[key].test(text)) out.add(dir && HINTS[dir] ? `${folder}/${dir}` : f);
  }
  // "hud" hints mean the page's markup and styles both.
  if ([...out].some((f) => /hud\.css$/.test(f))) for (const f of own) if (/index\.html$/.test(f)) out.add(f);
  return [...out].sort();
}

/**
 * 2.54.0 (P-025): folders a game says no agent may touch, from "Do not touch `src/x`" lines in its own
 * AGENTS.md or CLAUDE.md (paths relative to the game folder). The lane guess never picks a file inside one.
 */
export function noTouchPaths(root) {
  if (!root) return [];
  const out = new Set();
  for (const doc of ['AGENTS.md', 'CLAUDE.md']) {
    let text = '';
    try { text = fs.readFileSync(path.join(REPO_ROOT, root, doc), 'utf8'); } catch { continue; }
    for (const m of text.matchAll(/do\s+not\s+touch\s+[`'"]?([A-Za-z0-9_.\/-]+?)[`'"]?(?=[\s).,;:*_]|$)/gi)) {
      const p = m[1].replace(/^\.\//, '').replace(/\/+$/, '');
      if (p && !p.includes('..')) out.add(`${root}/${p}`);
    }
  }
  return [...out];
}

/** 2.54.0 (P-025): studio paths a task names in its text (studio/bible, docs/x.md): a docs task's own lane. */
export function namedStudioPaths(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/(?:^|[\s`'"(])((?:studio|docs)\/[A-Za-z0-9_.\/-]*[A-Za-z0-9_-])/g)) out.add(m[1]);
  return [...out];
}

/** A task's lane: `task lane`, else --paths/--lane when added, else studio paths it names, else files from its title, else --part; null = the whole game. */
export function laneOf(taskId, events = readRecentEvents(20000), holds = readHolds()) {
  const h = holds[taskId];
  if (h && 'lane' in h) return h.lane || null;
  const added = events.filter((e) => e.type === 'task.added' && e.task === taskId).pop();
  const meta = added?.meta || {};
  if (meta.paths?.length) return laneList(meta.paths).join(',');
  if (meta.lane) return meta.lane;
  const f = gameFolders();
  const text = added ? `${String(added.msg || '').replace(/^Queued [^:]+:\s*/, '')} ${meta.why || ''} ${meta.asked || ''}` : '';
  // 2.54.0 (P-025): a task that names studio paths (a docs task: "write the core loop doc in studio/bible") works there.
  const role = meta.role || (String(added?.msg || '').match(/^Queued T-\d+ \[[^\]]*\] \(([a-z-]+)\)/) || [])[1] || null;
  const named = role && role !== 'builder' ? namedStudioPaths(text) : [];
  if (named.length) return laneList(named).join(',');
  // 2.30k: guess the files from the title and brief, so builders on different files run side by side.
  if (process.env.STUDIO_LANE_INFER !== 'off' && f.renderer && added) {
    const banned = noTouchPaths(f.renderer);
    const guess = (meta.part === 'sim' ? [] : inferPaths(text, f.renderer)).filter((p) => !banned.some((b) => p === b || p.startsWith(`${b}/`)));
    if (guess.length) return guess.join(',');
  }
  if (meta.part === 'sim') return f.sim;
  if (meta.part === 'renderer') return f.renderer;
  return null;
}

/** Two lanes clash when any path of one holds a path of the other (or either is the whole game). */
const pathsClash = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
export const lanesClash = (a, b) => {
  const A = laneList(a);
  const B = laneList(b);
  return !A.length || !B.length || A.some((x) => B.some((y) => pathsClash(x, y)));
};

/** After `agent stop` / `agent pause`: the task can't restart for a while (default 15 min). */
export function cooldown(taskId, by, minutes = STOP_COOLDOWN_MIN()) {
  if (!taskId || !(minutes > 0)) return null;
  const until = new Date(Date.now() + minutes * 60000).toISOString();
  setHold(taskId, { cooldownUntil: until, cooldownBy: by });
  return until;
}
