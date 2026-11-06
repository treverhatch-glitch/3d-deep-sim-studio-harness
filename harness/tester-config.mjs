/**
 * harness/tester-config.mjs — 2.79 (t): what the game tester (harness/tester.mjs) needs to know about the game, read
 * synchronously so the done-check and the gate runner can ask it too.
 *
 * studio/game.json "tester" (docs/TESTER.md):
 *   { "build": "<command>", "dist": "<folder>", "url"?: "<own dev server>", "testids"?: true,
 *     "modes": [...], "styles": [...], "goals": [...], "areas": [...] }
 * Absent: the tester falls back to the cartridge's browser contract (qa.mjs { dist, build } or { page }), and says so.
 *
 * stage1Replaced(): a studio whose game has its own build (game.json "tester".build or .url) or its own checks (its
 * studio.gates.json, or <sim>/qa.mjs|playtest.mjs|golden.mjs) no longer runs the template cartridge's stage-1 playtest
 * per task: the done-check's playtest rows and the "playtest" gate say "replaced by the game tester (npm run tester)".
 * A template studio (no game, or the game is a cartridge) keeps it as before.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './event.mjs';
import { activeGame } from './cartridge.mjs';

export const REPLACED_WORDS = 'replaced by the game tester (npm run tester)';
export const DEFAULT_STYLES = ['cautious', 'greedy', 'ignore-staff', 'max-speed', 'idle'];
export const DEFAULT_GOALS = ['reach the first milestone', 'survive 10 minutes', 'reach the first failure state'];
export const DEFAULT_AREAS = ['first minutes', 'core loop', 'economy', 'HUD and panels', 'save and load'];

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const list = (v) => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x.trim() : x && typeof x === 'object' && typeof x.name === 'string' ? x : null)).filter(Boolean) : []);

/** studio/game.json, or {}. */
export const readGameJson = (root = REPO_ROOT) => readJson(path.join(root, 'studio', 'game.json')) || {};

/** game.json's "tester" object, normalized, or null when there is none. */
export function gameTesterConfig(root = REPO_ROOT) {
  const t = readGameJson(root).tester;
  if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    source: 'studio/game.json "tester"',
    build: str(t.build), dist: str(t.dist), url: str(t.url), page: str(t.page) || 'index.html', testids: t.testids === true,
    modes: list(t.modes), styles: list(t.styles), goals: list(t.goals), areas: list(t.areas),
  };
}

/** The studio's game when it is not a cartridge: { name, root } (root null when its folder isn't there), or null. */
export function studioGameSync(root = REPO_ROOT) {
  let g;
  try { g = activeGame(); } catch { return null; }
  if (!g?.name || !['STUDIO_GAME', 'studio/game.json game'].includes(g.from)) return null;
  if (fs.existsSync(path.join(root, 'cartridges', g.name, 'index.mjs'))) return null;
  const dir = [`game/${g.name}`, `web/${g.name}`].find((d) => fs.existsSync(path.join(root, d))) || null;
  return { name: g.name, root: dir };
}

/**
 * Does the template cartridge's stage-1 playtest give way to the game tester here? { replaced, why }.
 */
export function stage1Replaced(root = REPO_ROOT, env = process.env) {
  const t = gameTesterConfig(root);
  const sg = studioGameSync(root);
  if (t && (t.build || t.url || t.dist)) return { replaced: true, why: `the game declares its own build (${t.source})`, words: REPLACED_WORDS };
  if (sg?.root) {
    if (fs.existsSync(path.join(root, sg.root, 'studio.gates.json'))) return { replaced: true, why: `${sg.name} runs its own checks (${sg.root}/studio.gates.json)`, words: REPLACED_WORDS };
    const sim = path.join(root, sg.root, 'sim');
    if (['qa.mjs', 'playtest.mjs', 'golden.mjs'].some((f) => fs.existsSync(path.join(sim, f)))) return { replaced: true, why: `${sg.name} runs its own checks (${sg.root}/sim)`, words: REPLACED_WORDS };
  }
  return { replaced: false, why: sg ? `${sg.name} has no build or checks of its own yet` : 'a template studio (no game of its own)', words: REPLACED_WORDS };
}
