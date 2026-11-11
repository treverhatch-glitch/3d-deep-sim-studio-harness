/**
 * harness/native.mjs — 2.82: native-engine mode. A studio whose game is presented and shipped in one engine builds each
 * feature once: the rules in plain code the engine's rules check tests without the editor (harness/engine-rules.mjs),
 * scenes and visuals in the engine. The web presentation and the web-to-engine porting steps are off and cost nothing.
 *
 * A studio is native <engine> when
 *   - studio/game.json says so: "native": "<engine>" (an engine it configures under "engines"; the owner's file), or
 *   - studio/game.json names a game and exactly one engine, and the studio has no web game (no "cartridge", no
 *     game/<name>, web/<name> or cartridges/<name> folder, no engine twins of web paths): there is nothing else the game
 *     could be presented in. A studio with no game of its own yet (the template) is never native by inference.
 * "native": false, or STUDIO_NATIVE=off, turns it off. STUDIO_NATIVE=<engine> (a configured engine) turns it on for a run.
 *
 * What native mode changes (each place says so once, in its own output):
 *   task add          a builder task with no --track goes on engine:<engine> (--track web keeps a web task, for the web
 *                     rules a studio is still moving out of); one that names web code (a path under the web game's
 *                     folder, a .ts/.tsx/.js/.mjs file) goes on the web track instead (webCodeNamed, 2.83)
 *   the Line Producer no game-tester runs on the web build, no engine twins of web tasks
 *   the game's train  no playable web build and clip after a landing
 *   engine drift      no port tasks from web commits (npm run engine -- drift --queue says why)
 *   kickoffs          the Producer, the Director and builders are told: one build per feature, rules in plain code, no
 *                     web presentation work, no port tasks
 * It adds no gate and removes none: a studio's own web checks still run for the web files a task changes.
 *
 *   node harness/native.mjs [--json]      is this studio native, why, and what is off
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from './event.mjs';
import { readJson } from './fsafe.mjs';

const off = (v) => /^(off|0|false|no)$/i.test(String(v ?? '').trim());
const NAME_RE = /^[a-z][a-z0-9-]{1,30}$/;

/** What native mode switches off, in plain words (docs/NATIVE-ENGINE.md lists the same). */
export const NATIVE_OFF = Object.freeze([
  'the game tester on the web build (npm run tester -- now still runs one on demand)',
  'the playable web build and clip after a landing',
  'engine twins of web tasks, and port tasks from web commits',
  'a web lane for a builder task that names no track',
]);

/**
 * Is this studio native, and in which engine? { native: true, engine, from } or { native: false, why }.
 * root: the studio (the main checkout). Reads studio/game.json only.
 */
export function nativeVerdict(root = REPO_ROOT, env = process.env) {
  const sw = String(env.STUDIO_NATIVE ?? '').trim();
  if (off(sw)) return { native: false, why: 'STUDIO_NATIVE=off' };
  const g = readJson(path.join(root, 'studio', 'game.json')) || {};
  const engines = Object.keys(g.engines && typeof g.engines === 'object' ? g.engines : {}).filter((n) => NAME_RE.test(n)).sort();
  if (sw && NAME_RE.test(sw.toLowerCase())) {
    if (engines.includes(sw.toLowerCase())) return { native: true, engine: sw.toLowerCase(), from: 'STUDIO_NATIVE' };
    return { native: false, why: `STUDIO_NATIVE=${sw} names no engine of studio/game.json "engines" (${engines.join(', ') || 'none'})` };
  }
  if (g.native === false) return { native: false, why: 'studio/game.json "native": false' };
  if (typeof g.native === 'string' && g.native.trim()) {
    const n = g.native.trim().toLowerCase();
    if (engines.includes(n)) return { native: true, engine: n, from: 'studio/game.json "native"' };
    return { native: false, why: `studio/game.json "native": "${g.native}" names no engine of its "engines" (${engines.join(', ') || 'none'})` };
  }
  if (engines.length !== 1) return { native: false, why: engines.length ? `studio/game.json names ${engines.length} engines (${engines.join(', ')}) and no "native" one` : 'studio/game.json names no engine' };
  if (g.cartridge) return { native: false, why: `the game is the web cartridge ${g.cartridge} (studio/game.json "cartridge"): set "native": "${engines[0]}" when the engine build is the game` };
  const name = typeof g.game === 'string' ? g.game.trim() : '';
  // A studio with no game of its own yet is the template (its sample game is a web cartridge): never native by inference.
  if (!name) return { native: false, why: `studio/game.json names no game of its own ("game"): set "native": "${engines[0]}" when the engine build is the game` };
  const web = [`game/${name}`, `web/${name}`, `cartridges/${name}`].find((d) => fs.existsSync(path.join(root, d)));
  if (web) return { native: false, why: `the studio has a web game (${web}): set "native": "${engines[0]}" in studio/game.json when the engine build is the game` };
  if (g.engines[engines[0]]?.twins) return { native: false, why: `engines.${engines[0]}.twins lists web paths that have an engine twin, so the studio builds web features too: set "native": "${engines[0]}" to end that` };
  return { native: true, engine: engines[0], from: 'the only engine, and no web game' };
}

/** The native engine's name, or null. */
export const nativeEngine = (root = REPO_ROOT, env = process.env) => { try { const v = nativeVerdict(root, env); return v.native ? v.engine : null; } catch { return null; } };

/**
 * 2.83: does the text of a new builder task (title, --scope, --paths, --lane) name web code, in a native studio? A path under
 * the web game's folder (game/<game>/, web/<game>/, cartridges/<game>/, <game> from studio/game.json "game") or a file
 * ending in .ts, .tsx, .js or .mjs is web code: a rules bug there was routed to the engine track (T-rules). Pure: text and
 * the studio root in, { web, why } out; not a native studio: { web: false }. A bare "Node.js" is a product name, not a file.
 */
export function webCodeNamed(text, root = REPO_ROOT, env = process.env) {
  const none = { web: false, why: '' };
  const t = String(text ?? '');
  if (!t.trim()) return none;
  let v;
  try { v = nativeVerdict(root, env); } catch { return none; }
  if (!v.native) return none;
  const g = readJson(path.join(root, 'studio', 'game.json')) || {};
  const game = typeof g.game === 'string' ? g.game.trim() : '';
  if (game) {
    const esc = game.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = t.replace(/\\/g, '/').match(new RegExp(`(?:^|[^\\w./-])(?:\\./)?((?:game|web|cartridges)/${esc}(?:/[^\\s"'\`,;)]*)?)`, 'i'));
    if (m) return { web: true, why: `${m[1]} is the web game's folder` };
  }
  for (const m of t.matchAll(/(?:^|[^\w.-])([\w@./-]*[\w-]\.(?:tsx|ts|mjs|js))(?![\w-])/gi)) {
    if (/^(node|next|vue|react|three|d3|express)\.js$/i.test(m[1])) continue;
    return { web: true, why: `${m[1]} is a web file` };
  }
  return none;
}

/** The lines a kickoff carries in a native studio ('' otherwise). */
export function nativeBrief(root = REPO_ROOT, env = process.env) {
  const v = (() => { try { return nativeVerdict(root, env); } catch { return { native: false }; } })();
  if (!v.native) return '';
  return [
    `This studio is native ${v.engine} (${v.from}): the ${v.engine} build is the game.`,
    `- Build each feature once: its rules in plain code with no engine types, tested without the editor (npm run engine -- rules shows the command); scenes, input and visuals in ${v.engine}.`,
    '- Plan and build no web presentation work and no port tasks: nothing ships from a web view. A task that names no track goes on the engine track.',
    '- Web rules that still exist are moved out one system at a time (their own tests are the checklist); until a system is moved, a fix to it is a --track web task.',
    ...(fs.existsSync(path.join(root, 'studio', 'roles', 'engine-porter.md')) ? ['- A builder on the engine track also follows `studio/roles/engine-porter.md`: it holds the working rules for the engine repo (one role file for engine work, whoever does it).'] : []),
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const v = nativeVerdict(REPO_ROOT, process.env);
  if (process.argv.includes('--json')) console.log(JSON.stringify({ ...v, ...(v.native ? { off: NATIVE_OFF } : {}) }));
  else if (v.native) console.log(`[native] this studio is native ${v.engine} (${v.from}). Off: ${NATIVE_OFF.join('; ')}.`);
  else console.log(`[native] not a native studio: ${v.why}.`);
}
