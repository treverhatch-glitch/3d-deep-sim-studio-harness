/**
 * harness/gate-tracks.mjs — gates run for the engine a task is on, so docs-only or other-engine work skips web gates.
 * Every gate has a track: `web`, `engine:<name>` (or `engine:*`), `harness`, or `all` (every change but a docs-only
 * one). GATE_TRACKS is the one table; a gate it doesn't name gets its kind's default (`game:<id>` is `web`, a Godot
 * project's `engine:<project>` is `engine:godot`, anything else `all`: never silently skipped). A `"track"` field
 * (string or list) on a gate in studio/gates.json or a game's studio.gates.json overrides it.
 * A verify covers a set of tracks (decideTracks): those of the changed paths (pathTracks) plus each task's
 * (taskTracks). A docs-only change covers `docs`: only DOCS_GATES run. No task and no diff, a path outside every
 * track, --all or STUDIO_GATES_BY_TRACK=off: every gate runs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './event.mjs';
import { isOff as off, readJsonOrNull as readJson } from './helpers.mjs';

/** The one table: gate id -> track (or tracks). studio/gates.json "track" on a gate wins. */
export const GATE_TRACKS = Object.freeze({
  // the studio and the harness itself
  session: 'harness', docs: 'harness', reviewer: 'harness', selftest: 'harness',
  // safety checks of every change (a docs-only one runs those in DOCS_GATES)
  approvals: 'all', protected: 'all', secrets: 'all', hooks: 'all', 'weakened-tests': 'all', holdout: 'all',
  // the web game (cartridge gates, its own checks, its build and look)
  purity: 'web', isolation: 'web', golden: 'web', 'golden-py': 'web', regressions: 'web', 'vertical-slice': 'web', playtest: 'web',
  'browser-play': 'web', soak: 'web', 'tick-budget': 'web', assets: 'web', fidelity: 'web', 'content-schema': 'web', balance: 'web',
  fun: 'web', 'renderer-budget': 'web', 'module-size': 'web', 'function-size': 'web', vision: 'web', journey: 'web',
  // the game gate runs the web game's checks and, for a Godot project among the changed paths, the Godot gate
  game: ['web', 'engine:godot'],
  'godot-unit': 'engine:godot',
  // the Game Bible's controls and the web/engine parity: either side
  controls: ['web', 'engine:*'], parity: ['web', 'engine:*'],
  // the engine track's own gate (engine/<game>/engine.json): the engines named there (gateTrack)
  engine: 'engine:*',
});

/** The gates that judge docs, run for a docs-only change (and with their own track otherwise). */
export const DOCS_GATES = Object.freeze(['docs', 'secrets', 'hooks', 'protected', 'approvals', 'session', 'reviewer']);

const ENGINE_RE = /^[a-z][a-z0-9-]{1,30}$/;
const asList = (t) => (Array.isArray(t) ? t : [t]).map((x) => String(x || '').trim()).filter(Boolean);

/** STUDIO_GATES_BY_TRACK=off: every gate every time (default on). */
export const byTrackOn = (env = process.env) => !off(env.STUDIO_GATES_BY_TRACK);

/** The engines engine/<game>/engine.json names: ['godot', ...]. */
export function engineFolderEngines(root = REPO_ROOT) {
  const out = new Set();
  try { for (const g of fs.readdirSync(path.join(root, 'engine'))) { const e = readJson(path.join(root, 'engine', g, 'engine.json'))?.engine; if (ENGINE_RE.test(String(e || ''))) out.add(e); } } catch {}
  return [...out].sort();
}

/**
 * A gate's tracks: [track]. Its own "track" first, then the table, then its kind's default; an unknown id is `all`.
 * { tracks, from: 'gate' | 'table' | 'kind' | 'default' }.
 */
export function gateTrack(gate, { root = REPO_ROOT } = {}) {
  const id = String(gate?.id || '');
  if (gate?.track !== undefined && asList(gate.track).length) return { tracks: asList(gate.track), from: 'gate' };
  if (id === 'engine') { const es = engineFolderEngines(root); return { tracks: es.length ? es.map((e) => `engine:${e}`) : ['engine:*'], from: 'table' }; }
  if (Object.hasOwn(GATE_TRACKS, id)) return { tracks: asList(GATE_TRACKS[id]), from: 'table' };
  if (id.startsWith('game:')) return { tracks: ['web'], from: 'kind' };
  if (id.startsWith('engine:')) return { tracks: ['engine:godot'], from: 'kind' };
  return { tracks: ['all'], from: 'default' };
}

/** Does a gate with these tracks run for the covered set? covered: a Set, or '*' (everything). */
export function runsFor(tracks, covered, { id = null, overridden = false } = {}) {
  if (covered === '*') return true;
  const c = covered instanceof Set ? covered : new Set(covered || []);
  const anyEngine = [...c].some((t) => t.startsWith('engine:'));
  for (const t of asList(tracks)) {
    if (t === 'all' && (c.has('web') || c.has('harness') || anyEngine)) return true;
    if (t === 'harness' && c.has('harness')) return true;
    if (t === 'web' && c.has('web')) return true;
    if (t === 'docs' && (c.has('docs') || c.has('harness'))) return true;
    if (t === 'engine:*' && anyEngine) return true;
    if (t.startsWith('engine:') && t !== 'engine:*' && (c.has(t) || c.has('engine:*'))) return true;
  }
  return Boolean(c.has('docs') && id && !overridden && DOCS_GATES.includes(id));
}

/** Does a verify that covered `covered` (list or '*') stand for a change that needs `need` (list)? Returns the missing ones. */
export function missingTracks(covered, need) {
  if (covered === '*' || (Array.isArray(covered) && covered.includes('*'))) return [];
  const c = new Set(covered || []);
  return [...new Set(need || [])].filter((t) => {
    if (t === '*') return true;
    if (t === 'docs') return !(c.has('docs') || c.has('harness'));
    if (t.startsWith('engine:') && t !== 'engine:*') return !(c.has(t) || c.has('engine:*'));
    return !c.has(t);
  });
}

/** The nearest engine project holding a path (a folder with project.godot, a Unity ProjectSettings/, a .uproject): 'engine:<x>' or null. */
function engineProjectOf(rel, root) {
  let d = path.posix.dirname(rel);
  while (d && d !== '.' && d !== '/') {
    const abs = path.join(root, ...d.split('/'));
    if (fs.existsSync(path.join(abs, 'project.godot'))) return 'engine:godot';
    if (fs.existsSync(path.join(abs, 'ProjectSettings', 'ProjectVersion.txt'))) return 'engine:unity';
    try { if (fs.readdirSync(abs).some((n) => n.endsWith('.uproject'))) return 'engine:unreal'; } catch {}
    const up = path.posix.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

/**
 * The tracks one changed path needs: [track], or ['*'] (outside every track: everything runs).
 * docs/, studio/ notes, logs, the board, .md outside game and engine folders: docs. A file inside an engine project:
 * engine:<that engine>. engine/<game>/: the engine its engine.json names. game/<name>/, web/<name>/, cartridges/, src/,
 * assets/, public/, qa/golden/, qa/regressions/: web. harness/, scripts/, qa/, tools/, .github/: harness.
 */
export function pathTrack(file, { root = REPO_ROOT, engines = null } = {}) {
  const f = String(file || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!f) return [];
  if (/^studio\//.test(f)) {
    if (!/\.json$/i.test(f)) return ['docs'];
    if (f === 'studio/godot-unit.json') return ['harness', 'engine:godot'];
    return ['*'];
  }
  if (/^docs\//.test(f)) return ['docs'];
  // A note inside the game's own folder is the game's (its checks may read it); a .md anywhere else is docs.
  const inGame = /^(game|web)\/[^/]+\//.test(f) || /^(cartridges|src|assets|public)\//.test(f) || /^qa\/(golden|regressions)\//.test(f) || /^engine\//.test(f);
  if (/\.md$/i.test(f) && !inGame) return ['docs'];
  const proj = engineProjectOf(f, root);
  if (proj) return [proj];
  const m = f.match(/^engine\/([^/]+)\//);
  if (m) {
    const named = readJson(path.join(root, 'engine', m[1], 'engine.json'))?.engine;
    if (ENGINE_RE.test(String(named || ''))) return [`engine:${named}`];
    const known = engines || [];
    return [known.includes(m[1]) ? `engine:${m[1]}` : 'engine:*'];
  }
  if (/^(game|web)\/[^/]+\//.test(f) || /^(cartridges|src|assets|public)\//.test(f) || /^qa\/(golden|regressions)\//.test(f)) return ['web'];
  if (/^(harness|scripts|qa|tools|\.github)\//.test(f)) return ['harness'];
  return ['*'];
}

/** The tracks a set of changed paths needs: { tracks: [...], wide: <first path outside every track> | null }. */
export function pathTracks(files, { root = REPO_ROOT, engines = null } = {}) {
  const out = new Set();
  let wide = null;
  for (const f of files || []) {
    for (const t of pathTrack(f, { root, engines })) {
      if (t === '*') wide ||= String(f);
      out.add(t);
    }
  }
  return { tracks: [...out].sort(), wide };
}

/**
 * The tracks these tasks are on: an engine pass's engine:<x> (harness/engine-tracks.mjs engineTask), or `web` for a
 * task explicitly set back to web; a task with no track record adds nothing (its paths decide). [{ task, track }].
 */
export async function taskTracks(ids, { root = null } = {}) {
  const et = await import('./engine-tracks.mjs');
  const r = root || (await import('./worktree.mjs')).mainRoot();
  return tracksOfTasks(ids, et, r);
}

/** taskTracks without the imports, for a caller that has harness/engine-tracks.mjs (et) already. */
export function tracksOfTasks(ids, et, root) {
  const list = [...new Set((ids || []).map(String).filter((x) => /^[A-Za-z]+-\d+$/.test(x)))];
  const out = [];
  for (const id of list) {
    let rec = null;
    try { rec = et.engineTask(id, { root }); } catch { rec = null; }
    if (rec?.engine) { out.push({ task: id, track: `engine:${rec.engine}` }); continue; }
    try { if (et.readEngineTasks(root)[id]?.track === 'web') out.push({ task: id, track: 'web' }); } catch {}
  }
  return out;
}

/**
 * What a verify must cover. { mode: 'by-track' | 'all' | 'off', covered: [...] | '*', why, paths: [...], tasks: [{ task, track }] }.
 * all: --all asked. paths: the lane's changed files (null: no diff). tasks: taskTracks().
 */
export function decideTracks({ paths = null, tasks = [], all = false, env = process.env, root = REPO_ROOT, engines = null } = {}) {
  if (!byTrackOn(env)) return { mode: 'off', covered: '*', why: 'STUDIO_GATES_BY_TRACK=off: every gate every time', paths: [], tasks };
  if (all) return { mode: 'all', covered: '*', why: '--all: every gate', paths: [], tasks };
  const pt = paths?.length ? pathTracks(paths, { root, engines }) : null;
  const tt = [...new Set((tasks || []).map((t) => t.track).filter(Boolean))];
  if (!pt && !tt.length) return { mode: 'all', covered: '*', why: 'no task track and no changed paths: every gate', paths: [], tasks };
  if (pt?.wide) return { mode: 'all', covered: '*', why: `${pt.wide} is outside every track: every gate`, paths: pt.tracks, tasks };
  const covered = [...new Set([...(pt?.tracks || []), ...tt])].sort();
  const from = [pt ? `the changed paths (${pt.tracks.join(', ')})` : '', tt.length ? `the task track${tt.length === 1 ? '' : 's'} (${(tasks || []).map((t) => `${t.task}: ${t.track}`).join(', ')})` : ''].filter(Boolean).join(' and ');
  return { mode: 'by-track', covered, why: `from ${from}`, paths: pt?.tracks || [], tasks };
}

/** The line that says which mode ran. */
export function modeLine(d) {
  if (d.mode === 'off') return 'gates by track: off (STUDIO_GATES_BY_TRACK=off): every gate runs';
  if (d.mode === 'all') return `gates by track: on, every gate runs (${d.why.replace(/: every gate$/, '')})`;
  return `gates by track: on, this change covers ${d.covered.join(', ')} (${d.why})`;
}

/** The "not run for this change" line: [{ id, tracks }] -> text, or ''. */
export function notRunLine(notRun, d) {
  if (!notRun.length) return '';
  const by = new Map();
  for (const n of notRun) { const k = n.tracks.join('+'); by.set(k, [...(by.get(k) || []), n.id]); }
  const parts = [...by].map(([k, ids]) => `${ids.join(', ')} (${k} track)`);
  const only = Array.isArray(d.covered) ? d.covered.join(', ') : 'everything';
  return `not run for this change: ${parts.join('; ')}; this change touches ${only} only`;
}

/** Split gates into those that run for the decision and those that don't: { run, notRun: [{ id, tracks }] }. */
export function splitByTrack(gates, d, { root = REPO_ROOT } = {}) {
  if (d.covered === '*') return { run: [...gates], notRun: [] };
  const cov = new Set(d.covered);
  const run = [];
  const notRun = [];
  for (const g of gates) {
    const t = gateTrack(g, { root });
    if (runsFor(t.tracks, cov, { id: g.id, overridden: t.from === 'gate' })) run.push(g);
    else notRun.push({ id: g.id, tracks: t.tracks });
  }
  return { run, notRun };
}

/** The covered tracks a child check reads (STUDIO_GATE_TRACKS, set by run-gates for the game gate only): a Set, or '*'. */
export function coveredFromEnv(env = process.env) {
  const v = String(env.STUDIO_GATE_TRACKS || '').trim();
  if (!v || v === '*') return '*';
  return new Set(v.split(',').map((x) => x.trim()).filter(Boolean));
}
