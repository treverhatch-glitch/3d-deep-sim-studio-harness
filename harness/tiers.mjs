/**
 * harness/tiers.mjs — 2.63.0: blast-radius tiers for landing, decided by code from a lane's diff (never by a model).
 *
 * The merge train (harness/train.mjs) used to land every green lane alike. Now each lane gets a tier from what it
 * changes, sorted by how costly a wrong change is to undo:
 *
 *   C  never lands by itself (a closed lane, not a threshold): protected files (studio/protected.json at main's tip and
 *      the shipped list), harness code (harness/, hub/, scripts/, qa/*.mjs), a deleted test or regression file, files
 *      the game declares irreversible (save/schema formats: manifest "irreversible"), an upgrade merge (Upgrade-Ref:
 *      trailer). Held in the train queue as "needs the owner" until a person releases it (train release).
 *   B  deterministic checks plus history: sim/behaviour (the game's sim paths, goldens, declared pin moves), shared
 *      utilities, the registry/import barrel, changed (not added) tests, and any file no rule names. The train
 *      verifies it with --all, a moved golden needs a Golden-Reason trailer, a changed pin file a Pin-Moves trailer,
 *      and a task handed back more than STUDIO_TRAIN_MAX_HANDBACKS (3) times waits for a person.
 *   A  contained: docs, added tests, the game's tools folders, assets, UI outside the sim paths. Lands in a train with
 *      the normal verify.
 *
 * A file's tier is the highest of every rule it matches (no rule: "default", B); the lane's is the highest of its files
 * and its lane-wide rules. The rules are data (DEFAULT_TIER_RULES). A game may extend or change them only through its
 * manifest (<game>/studio.gates.json, a protected file read from main's tip), "tiers":
 *   { "rules": [{ "id": "render", "tier": "A", "paths": ["src/render/**"], "why": "drawing only" }],
 *     "set": { "shared": "A" }, "default": "B" }
 * A rule marked `locked` (every C rule) can't be lowered or removed, by a manifest or anything else: only raised.
 * Pure: no git, no files. harness/train.mjs reads the diff and the manifest and calls classifyLane.
 */
import { matchAny } from './merge-lane.mjs';
import { isGoldenPath, isTestPath } from './test-weakening.mjs';
import { DEFAULT_PROTECTED } from './approve.mjs';

export const TIERS = ['A', 'B', 'C'];
/**
 * The shipped protected list (studio/protected.json as the harness ships it, and approve.mjs's defaults): always tier C,
 * whatever the studio's own list says (it can add globs, never take these out of tier C).
 */
export const SHIPPED_PROTECTED = [...new Set([
  ...DEFAULT_PROTECTED,
  'studio/game.json', 'game/*/studio.gates.json', 'web/*/studio.gates.json', 'studio/secrets-allow.json',
])];
const rank = (t) => TIERS.indexOf(t);
export const higher = (a, b) => (rank(b) > rank(a) ? b : a);

/**
 * The default rules. A rule matches a changed file by:
 *   paths     globs (harness/merge-lane.mjs globRe: ** any depth, * one segment)
 *   from      a manifest key whose globs are added to `paths` (simPaths, shared, unionFiles, registry, ui, irreversible)
 *   status    'A' added, 'M' changed, 'D' deleted (a rename is R: neither added nor deleted)
 *   kind      'test' (harness/test-weakening.mjs isTestPath), 'golden' (isGoldenPath), 'protected' (the protected list)
 *           'proposal-protected' (2.65.0: a studio-proposals/ file whose targets, classifyLane's `proposals`, match the
 *           protected list, or can't be read)
 * or lane-wide by `trailer` (a key in the lane's own commits' trailers). Every condition given must hold.
 */
export const DEFAULT_TIER_RULES = [
  { id: 'protected', tier: 'C', locked: true, kind: 'protected', why: 'a protected file (studio/protected.json and the shipped list): only the owner approves it' },
  { id: 'harness', tier: 'C', locked: true, paths: ['harness/**', 'hub/**', 'scripts/**', 'qa/*.mjs'], why: 'the studio\'s own code and checks (harness/, hub/, scripts/, qa/*.mjs)' },
  { id: 'test-deleted', tier: 'C', locked: true, kind: 'test', status: 'D', why: 'it deletes a test' },
  { id: 'golden-deleted', tier: 'C', locked: true, kind: 'golden', status: 'D', why: 'it deletes a golden or snapshot' },
  { id: 'regression-deleted', tier: 'C', locked: true, paths: ['qa/regressions/**'], status: 'D', why: 'it deletes a regression replay' },
  { id: 'irreversible', tier: 'C', locked: true, from: 'irreversible', why: 'a file the game declares irreversible (manifest "irreversible": a save or schema format)' },
  { id: 'upgrade', tier: 'C', locked: true, trailer: 'Upgrade-Ref', why: 'a harness upgrade merge (Upgrade-Ref: trailer)' },
  // 2.65.0 (B-40): a config proposal (studio-proposals/<ID>.json, harness/config-proposal.mjs) for a protected studio
  // file is the owner's decision like the file itself; one the harness can't read counts as protected.
  { id: 'config-proposal-protected', tier: 'C', locked: true, kind: 'proposal-protected', paths: ['studio-proposals/**'], why: 'a config proposal for a protected studio file (studio-proposals/): only the owner decides it' },
  { id: 'golden', tier: 'B', kind: 'golden', why: 'it moves a golden or snapshot (behaviour)' },
  { id: 'config-proposal', tier: 'B', paths: ['studio-proposals/**'], why: 'a studio config proposal (studio-proposals/): it changes main\'s studio/ config when it lands' },
  { id: 'pins', tier: 'B', trailer: 'Pin-Moves', why: 'it declares pin moves (Pin-Moves: trailer)' },
  { id: 'pin-files', tier: 'B', from: 'pinFiles', why: 'it changes pinned expectations (manifest pins.files)' },
  { id: 'sim', tier: 'B', paths: ['game/*/sim/**', 'web/*/sim/**', 'cartridges/**'], from: 'simPaths', why: 'the game\'s sim (behaviour)' },
  { id: 'shared', tier: 'B', paths: ['package.json', 'package-lock.json', '**/shared/**', '**/utils/**', '**/util/**', '**/lib/**'], from: 'shared', why: 'a shared utility or package file' },
  { id: 'registry', tier: 'B', paths: ['**/index.ts', '**/index.js', '**/index.mjs'], from: ['unionFiles', 'registry'], why: 'the registry or import barrel' },
  { id: 'test-changed', tier: 'B', kind: 'test', status: 'M', why: 'it changes an existing test' },
  { id: 'docs', tier: 'A', paths: ['docs/**', '**/*.md'], why: 'docs' },
  { id: 'test-added', tier: 'A', kind: 'test', status: 'A', why: 'an added test' },
  { id: 'game-tools', tier: 'A', paths: ['game/*/tools/**', 'web/*/tools/**'], why: 'the game\'s tools folder' },
  { id: 'assets', tier: 'A', paths: ['assets/**', '**/assets/**', '**/*.png', '**/*.jpg', '**/*.jpeg', '**/*.webp', '**/*.svg', '**/*.glb', '**/*.gltf', '**/*.ogg', '**/*.wav', '**/*.mp3'], why: 'an asset' },
  { id: 'ui', tier: 'A', paths: ['**/ui/**', '**/hud/**', '**/*.css'], from: 'ui', why: 'UI outside the sim paths' },
];
export const DEFAULT_TIER = { tier: 'B', why: 'no tier rule names it (unclassified code)' };

const strs = (a) => (Array.isArray(a) ? a.map((x) => String(x).trim()).filter(Boolean) : []);

/**
 * The rules in force: the defaults, changed by the manifest's "tiers" (set: a rule's tier; rules: added rules;
 * default: the tier of a file no rule names). A locked rule is never lowered. Returns { rules, fallback, notes }.
 */
export function tierRules(manifestTiers = null) {
  const notes = [];
  const rules = DEFAULT_TIER_RULES.map((r) => ({ ...r }));
  let fallback = { ...DEFAULT_TIER };
  const t = manifestTiers && typeof manifestTiers === 'object' ? manifestTiers : null;
  if (!t) return { rules, fallback, notes };
  for (const [id, tier] of Object.entries(t.set && typeof t.set === 'object' ? t.set : {})) {
    const r = rules.find((x) => x.id === id);
    const to = String(tier).toUpperCase();
    if (!r) { notes.push(`tiers.set: no rule "${id}"`); continue; }
    if (!TIERS.includes(to)) { notes.push(`tiers.set.${id}: "${tier}" is not A, B or C`); continue; }
    if (r.locked && rank(to) < rank(r.tier)) { notes.push(`tiers.set.${id}: ${r.id} is a locked tier-${r.tier} rule; it can't be lowered to ${to}`); continue; }
    r.tier = to;
    r.why = `${r.why} (tier ${to} by the game's manifest)`;
  }
  for (const x of Array.isArray(t.rules) ? t.rules : []) {
    const to = String(x?.tier || '').toUpperCase();
    const paths = strs(x?.paths);
    if (!TIERS.includes(to) || !paths.length) { notes.push(`tiers.rules: ${JSON.stringify(x).slice(0, 80)} needs "tier" (A, B or C) and "paths"`); continue; }
    const id = String(x.id || `game-${rules.length}`);
    if (rules.some((r) => r.id === id && r.locked)) { notes.push(`tiers.rules: "${id}" is a locked rule's id`); continue; }
    rules.push({ id, tier: to, paths, why: String(x.why || `the game's manifest puts ${paths.join(', ')} in tier ${to}`), game: true });
  }
  if (t.default !== undefined) {
    const to = String(t.default).toUpperCase();
    if (TIERS.includes(to)) fallback = { tier: to, why: `no tier rule names it (the game's manifest: default tier ${to})` };
    else notes.push(`tiers.default: "${t.default}" is not A, B or C`);
  }
  return { rules, fallback, notes };
}

/**
 * The tier of one lane. Pure.
 *   files     [{ status: 'A'|'M'|'D'|'R'|..., path }] (the lane's own diff: merge-base with main .. its head)
 *   trailers  { key: [values] } of the lane's own commits (Pin-Moves, Golden-Reason, Upgrade-Ref, ...)
 *   settings  the manifest's train settings (harness/train.mjs readTrainSettings): simPaths, shared, unionFiles,
 *             registry, ui, irreversible, pins.files, tiers, runAlone
 *   protectedGlobs  studio/protected.json "globs" at main's tip (the shipped list is always added)
 *   addOnly   protected globs where a NEW file is fine (a new regression replay)
 *   proposals 2.65.0: { 'studio-proposals/<ID>.json': [target files] | null (unreadable) } for the lane's proposals
 * Returns { tier, why: [reasons for the tier], files: [{ path, status, tier, rules }], rules: [ids], needs: {...},
 *           runAlone: { yes, why }, notes }.
 */
export function classifyLane({ files = [], trailers = {}, settings = {}, protectedGlobs = [], addOnly = ['qa/regressions/**'], proposals = {} } = {}) {
  const { rules, fallback, notes } = tierRules(settings.tiers);
  const prot = [...new Set([...SHIPPED_PROTECTED, ...strs(protectedGlobs)])];
  const extra = (key) => {
    if (key === 'pinFiles') return strs(settings.pins?.files);
    return strs(settings[key]);
  };
  const ruleGlobs = (r) => [...strs(r.paths), ...[].concat(r.from || []).flatMap(extra)];
  const has = (k) => Array.isArray(trailers[k]) && trailers[k].length > 0;
  const matches = (r, f) => {
    if (r.trailer) return false;
    if (r.status && !String(f.status || '').startsWith(r.status)) return false;
    if (r.kind === 'test' && !isTestPath(f.path)) return false;
    if (r.kind === 'golden' && !isGoldenPath(f.path)) return false;
    if (r.kind === 'protected' && !(matchAny(f.path, prot) && !(String(f.status).startsWith('A') && matchAny(f.path, addOnly)))) return false;
    if (r.kind === 'proposal-protected') {
      if (String(f.status).startsWith('D') || !Object.prototype.hasOwnProperty.call(proposals || {}, f.path)) return false;
      const targets = proposals[f.path];
      if (Array.isArray(targets) && !targets.some((t) => matchAny(t, prot))) return false;
    }
    const g = ruleGlobs(r);
    if (g.length) return matchAny(f.path, g);
    return Boolean(r.kind || r.status);
  };
  let tier = 'A';
  const why = new Map();
  const byFile = [];
  const add = (t, reason, what) => {
    if (rank(t) > rank(tier)) { tier = t; why.clear(); }
    if (t === tier) why.set(reason, [...(why.get(reason) || []), what].slice(0, 5));
  };
  for (const f of files) {
    const hit = rules.filter((r) => matches(r, f));
    let ft = hit.length ? 'A' : fallback.tier;
    for (const r of hit) ft = higher(ft, r.tier);
    const top = hit.filter((r) => r.tier === ft);
    byFile.push({ path: f.path, status: f.status, tier: ft, rules: hit.map((r) => r.id) });
    if (top.length) for (const r of top) add(ft, r.why, f.path);
    else add(ft, fallback.why, f.path);
  }
  const used = new Set(byFile.flatMap((f) => f.rules));
  for (const r of rules.filter((x) => x.trailer && has(x.trailer))) { used.add(r.id); add(r.tier, r.why, `${r.trailer}: ${trailers[r.trailer].join(', ').slice(0, 80)}`); }
  if (!files.length && !used.size) why.set('it changes no file', []);
  // What tier B asks of the lane (checked by the train, never by a model).
  const goldens = files.filter((f) => isGoldenPath(f.path) && /^[MD]/.test(String(f.status)));
  const pinFiles = extra('pinFiles').length ? files.filter((f) => matchAny(f.path, extra('pinFiles'))) : [];
  const needs = {
    all: tier !== 'A',
    goldenReason: goldens.length && !has('Golden-Reason') ? goldens.map((f) => f.path) : [],
    pinMoves: pinFiles.length && !has('Pin-Moves') ? pinFiles.map((f) => f.path) : [],
  };
  // Run alone: a lane whose diff is large or sim-wide (manifest "runAlone": { "maxFiles": N, "paths": [...] }).
  const ra = settings.runAlone && typeof settings.runAlone === 'object' ? settings.runAlone : null;
  let runAlone = { yes: false, why: '' };
  if (ra) {
    const max = Number(ra.maxFiles);
    const hit = files.find((f) => matchAny(f.path, strs(ra.paths)));
    if (Number.isFinite(max) && max > 0 && files.length > max) runAlone = { yes: true, why: `it changes ${files.length} files (runAlone.maxFiles ${max})` };
    else if (hit) runAlone = { yes: true, why: `it changes ${hit.path} (runAlone.paths)` };
  }
  const reasons = [...why.entries()].map(([w, list]) => (list.length ? `${w}: ${list.join(', ')}` : w));
  return { tier, why: reasons, files: byFile, rules: [...used], needs, runAlone, notes };
}

/** One line for logs and outputs: "tier B (the game's sim (behaviour): game/x/sim/a.mjs)". */
export const tierLine = (c) => `tier ${c.tier} (${c.why.join('; ').slice(0, 400) || 'no reason'})`;
