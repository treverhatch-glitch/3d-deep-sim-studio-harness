/**
 * harness/type-evidence.mjs — 2.65.0 (hands-off by default): a task's type decided from its diff, never by asking.
 *
 * A "bug"-titled task whose changes are only tests, docs or config (a flaky test, a typo, a timeout setting) has no
 * game behaviour to replay, yet done-check asked it for a regression that fails before the fix, so the crew had to
 * ask the owner to retype it (B-36). Now done-check reads the task's changed files (done-check.mjs taskChanges, the
 * same list the render decision reads) and, when every file is a test, a doc or a config file and none is game logic,
 * judges it a "change" task, says why ("type: change (evidence: only tests/config changed: …)") and records one
 * task.type.evidence event. A file is game logic, so the task stays a bug and still needs its replay, when it is:
 *   - in the game's sim paths: harness/tiers.mjs's "sim" rule (game/<g>/sim, web/<g>/sim, cartridges/) plus the game
 *     manifest's "simPaths", "pins.files", "irreversible", "shared" and "registry" globs (<game>/studio.gates.json);
 *   - a golden or snapshot (behaviour), a deleted test, or the studio's own code (harness/, hub/, scripts/, qa/*.mjs);
 *   - anything else that isn't a test (harness/test-weakening.mjs isTestPath), a doc (*.md, docs/) or a config file
 *     (json/yaml/toml/ini settings, *.config.*, dotfile settings; package files are shared code, not config).
 * An owner or permission record (harness/reclassify.mjs) always outranks the evidence; no commits yet: the title
 * decides as before. Pure classification here; done-check.mjs reads the files and writes the event.
 */
import fs from 'node:fs';
import path from 'node:path';
import { classifyLane } from './tiers.mjs';
import { isTestPath, isGoldenPath, isTestConfig } from './test-weakening.mjs';

// Rules whose files are game logic or behaviour (a bug there keeps its replay).
const LOGIC_RULES = new Set(['sim', 'golden', 'pin-files', 'irreversible', 'shared', 'registry', 'harness', 'test-deleted', 'golden-deleted', 'regression-deleted', 'protected-code']);
const CONFIG_RX = /\.(json|jsonc|json5|ya?ml|toml|ini|cfg|conf|properties|env\.example)$/i;
const CONFIG_NAME_RX = /(^|\/)(\.[\w.-]*rc(\.[\w]+)?|\.editorconfig|\.gitignore|\.gitattributes|\.npmrc|\.nvmrc|\.node-version|\.prettierignore|\.eslintignore|[^/]+\.config\.(m?[jt]s|cjs|json)|tsconfig[^/]*\.json)$/i;
const PACKAGE_RX = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/i;

/** What kind of non-logic file f is ('test' | 'docs' | 'config'), or null (code, or anything else). */
export function fileKind(f) {
  const p = String(f).replace(/\\/g, '/');
  if (isGoldenPath(p) || PACKAGE_RX.test(p)) return null;
  if (/^(harness|hub|scripts)\//.test(p) || /^qa\/[^/]+\.mjs$/.test(p)) return null;
  if (isTestConfig(p)) return 'config';
  if (isTestPath(p)) return 'test';
  if (/\.md$/i.test(p) || /^docs\//.test(p)) return 'docs';
  if (CONFIG_RX.test(p) || CONFIG_NAME_RX.test(p)) return 'config';
  return null;
}

/** The game manifest's globs that tiers.mjs reads (simPaths, pins.files, irreversible, shared, registry, tiers). */
export function manifestSettings(root, gameName) {
  if (!gameName) return {};
  for (const top of ['game', 'web']) {
    const f = path.join(root, top, gameName, 'studio.gates.json');
    let j = null;
    try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    const strs = (a) => (Array.isArray(a) ? a.map((x) => String(x).trim()).filter(Boolean) : []);
    const s = {};
    for (const k of ['simPaths', 'shared', 'registry', 'irreversible']) if (j?.[k] !== undefined) s[k] = strs(j[k]);
    if (j?.pins && typeof j.pins === 'object') s.pins = { files: strs(j.pins.files) };
    if (j?.tiers && typeof j.tiers === 'object' && !Array.isArray(j.tiers)) s.tiers = j.tiers;
    s.manifest = `${top}/${gameName}/studio.gates.json`;
    return s;
  }
  return {};
}

/**
 * Judge a task's changed files. files: repo-relative paths; settings: manifestSettings(); exists(f): is it on disk
 * (a missing file is a deletion). Returns { onlyNonLogic, kinds: { test, docs, config }, logic: [{ path, why }] }.
 */
export function judgeFiles(files = [], { settings = {}, exists = () => true } = {}) {
  const list = [...new Set(files.map((f) => String(f).replace(/\\/g, '/')).filter(Boolean))];
  const lane = classifyLane({ files: list.map((p) => ({ path: p, status: exists(p) ? 'M' : 'D' })), settings });
  const kinds = { test: [], docs: [], config: [] };
  const logic = [];
  for (const f of lane.files) {
    const hit = f.rules.find((r) => LOGIC_RULES.has(r));
    if (hit) { logic.push({ path: f.path, why: hit === 'sim' ? 'a sim path' : hit === 'harness' ? 'the studio\'s own code' : `the ${hit} rule` }); continue; }
    const k = fileKind(f.path);
    if (!k) { logic.push({ path: f.path, why: 'code (not a test, doc or config file)' }); continue; }
    kinds[k].push(f.path);
  }
  return { onlyNonLogic: list.length > 0 && logic.length === 0, kinds, logic };
}

const list = (a, n = 4) => `${a.slice(0, n).join(', ')}${a.length > n ? ` (+${a.length - n} more)` : ''}`;
/** "only tests/config changed: a, b" from judgeFiles' kinds. */
export function evidenceWords(kinds) {
  const names = ['test', 'docs', 'config'].filter((k) => kinds[k].length).map((k) => (k === 'test' ? 'tests' : k));
  const all = [...kinds.test, ...kinds.docs, ...kinds.config];
  return `only ${names.join('/')} changed: ${list(all)}`;
}
