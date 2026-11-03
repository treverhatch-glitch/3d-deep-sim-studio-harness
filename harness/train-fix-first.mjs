/**
 * harness/train-fix-first.mjs — 2.73.2 (d, B-75): a lane that fixes the check main is stuck red on trains alone, first.
 *
 * With main red on a check (a per-test timeout that the worker count outgrew), every combined train failed on that same
 * check, the train carrying the fix included: the fix was one lane among five, the train was red, nobody landed. It took
 * `task hold` on the other lanes by hand to let the fix ride alone. Now the train remembers its reds:
 *
 *   noteTrainRed      a train's red verify (the checks that failed) and a "main itself is red" verdict, in
 *                     .studio/train/red-streak.json (the last 6 trains; a train that lands anything clears it: noteTrainLanded)
 *   stuckChecks       the game checks main is stuck on: the checks of a "main itself is red" verdict since the last landing,
 *                     or a check that failed in the last two trains in a row
 *   fixFirstOrder     a queued lane whose diff changes that check's configuration (the game's test config: vitest / vite /
 *                     jest configs and workspaces, .npmrc, the game's studio.gates.json, the test entries of a game
 *                     package.json; harness/test-toolchain.mjs) goes first and alone (runAlone), logged with the reason
 *                     (task.train.fix_first). Once per lane head: a fix lane that trained alone and didn't land isn't put
 *                     first again until it changes.
 * It reorders only: a lane held for the owner (tier C) still waits for the owner, and every check still runs.
 * STUDIO_TRAIN_FIX_FIRST=off turns it off. Node built-ins and two harness helpers that import nothing back.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { TOOLCHAIN_GLOBS, testKeys, manifestScripts } from './test-toolchain.mjs';
import { matchAny } from './merge-lane.mjs';

const KEEP = 6;
const file = (root) => path.join(root, '.studio', 'train', 'red-streak.json');
const read = (root) => { try { const j = JSON.parse(fs.readFileSync(file(root), 'utf8')); return { trains: Array.isArray(j.trains) ? j.trains : [], tried: j.tried && typeof j.tried === 'object' ? j.tried : {} }; } catch { return { trains: [], tried: {} }; } };
const write = (root, j) => { try { fs.mkdirSync(path.dirname(file(root)), { recursive: true }); fs.writeFileSync(file(root), `${JSON.stringify(j, null, 2)}\n`); } catch {} };
export const fixFirstOn = (env = process.env) => !/^(off|0|false|no)$/i.test(String(env.STUDIO_TRAIN_FIX_FIRST || ''));

/** A train's red: the checks that failed (merged per train id); redMain: the train found them red on main itself. */
export function noteTrainRed(root, { id, gates = [], redMain = false, now = Date.now() } = {}) {
  const j = read(root);
  const list = (gates || []).map(String).filter(Boolean);
  const e = j.trains.find((t) => t.id === id);
  if (e) { e.gates = [...new Set([...e.gates, ...list])]; e.redMain = Boolean(e.redMain || redMain); e.at = new Date(now).toISOString(); }
  else j.trains.push({ id: String(id), at: new Date(now).toISOString(), gates: list, redMain: Boolean(redMain) });
  j.trains = j.trains.slice(-KEEP);
  write(root, j);
}

/** A train landed something: main passed its checks, so the streak is over (the fix lanes tried are forgotten too). */
export function noteTrainLanded(root) {
  if (fs.existsSync(file(root))) write(root, { trains: [], tried: {} });
}

/** A fix lane was put first at this head (it won't be put first again at the same head). */
export function noteFixTried(root, task, head) {
  const j = read(root);
  j.tried[task] = head;
  write(root, j);
}

/**
 * The game checks main is stuck red on: { gates, why } or null. `gameIds` are the studio gates that run the game's checks.
 */
export function stuckChecks(root, { gameIds = ['game'] } = {}) {
  const { trains } = read(root);
  const game = (g) => gameIds.includes(g) || /^game[:-]/.test(g);
  const rm = [...trains].reverse().find((t) => t.redMain && t.gates.some(game));
  if (rm) return { gates: rm.gates.filter(game), why: `${rm.gates.filter(game).join(', ')} failed on main itself in train ${rm.id}` };
  const [a, b] = trains.slice(-2);
  if (!a || !b) return null;
  const both = b.gates.filter((g) => game(g) && a.gates.includes(g));
  return both.length ? { gates: both, why: `${both.join(', ')} failed in the last two trains in a row (${a.id}, ${b.id})` } : null;
}

const CONFIG = /(^|\/)((vitest|vite|jest)(\.[\w-]+)?\.config\.[^/]+|vitest\.(workspace|projects)\.[^/]+|\.npmrc|studio\.gates\.json)$/;
const inGame = (f) => /^(game|web)\//.test(f) && !/(^|\/)node_modules\//.test(f);

/**
 * The files of a lane's diff (base..head, both commits) that configure the game's checks: test configs (TOOLCHAIN_GLOBS
 * and named configs such as vitest.<name>.config.ts), the game's studio.gates.json, and a game package.json whose test
 * entries changed (testKeys; listed as "<path>#test-scripts").
 */
export function checkConfigFiles(root, { base, head, git = defaultGit }) {
  const r = git(root, ['-c', 'core.quotePath=false', 'diff', '--name-only', `${base}...${head}`]);
  if (r.status !== 0) return [];
  const files = String(r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const out = files.filter((f) => inGame(f) && (CONFIG.test(f) || matchAny(f, TOOLCHAIN_GLOBS)));
  const show = (rev, f) => { const x = git(root, ['show', `${rev}:${f}`]); return x.status === 0 ? x.stdout : null; };
  const manifests = files.filter((f) => /(^|\/)studio\.gates\.json$/.test(f)).map((f) => show(base, f) || '');
  for (const f of files.filter((x) => inGame(x) && /(^|\/)package\.json$/.test(x))) {
    const scripts = manifestScripts([...manifests, show(base, path.posix.join(path.posix.dirname(f), 'studio.gates.json')) || '']);
    if (testKeys(show(base, f) || '{}', scripts) !== testKeys(show(head, f) || '{}', scripts)) out.push(`${f}#test-scripts`);
  }
  return [...new Set(out)];
}
const defaultGit = (cwd, args) => spawnSync('git', args, { windowsHide: true, cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/**
 * The lanes with the first one that changes a stuck check's configuration moved to the front and marked to run alone:
 * { lanes, fix } (fix: { task, gates, files, why } or null; note: why nothing was moved, when that's worth a line).
 * A train for an agent's own lane (task done --train) is left alone unless that lane is the fix.
 */
export function fixFirstOrder(root, lanes, { tip, gameIds, headOf = (l) => l.head, env = process.env, git = defaultGit } = {}) {
  if (!fixFirstOn(env) || !lanes.length) return { lanes, fix: null };
  const stuck = stuckChecks(root, { gameIds });
  if (!stuck) return { lanes, fix: null };
  const { tried } = read(root);
  const own = lanes.find((l) => l.own);
  let note = '';
  for (const lane of lanes) {
    if (own && lane !== own) continue;
    const head = headOf(lane);
    if (!head || !tip) continue;
    const files = checkConfigFiles(root, { base: tip, head, git });
    if (!files.length) continue;
    if (tried[lane.task] === head) { note = `${lane.task} changes ${stuck.gates.join(', ')}'s configuration but already trained alone at this commit without landing`; continue; }
    const why = `${stuck.why}, and it changes that check's configuration (${files.slice(0, 4).join(', ')}${files.length > 4 ? ` +${files.length - 4} more` : ''}): it trains alone and first (STUDIO_TRAIN_FIX_FIRST)`;
    const fix = { task: lane.task, head, gates: stuck.gates, files, why };
    const moved = { ...lane, fixFirst: fix };
    return { lanes: [moved, ...lanes.filter((l) => l !== lane)], fix };
  }
  return { lanes, fix: null, note };
}
