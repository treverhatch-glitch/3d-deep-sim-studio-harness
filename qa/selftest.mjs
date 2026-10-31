#!/usr/bin/env node
/**
 * qa/selftest.mjs — prove every required gate can fail, and that the safety rules bite.
 *
 * For each required gate in studio/gates.json: copy the repo to a temp folder, plant one specific
 * breakage, run that gate's real command there, and require a non-zero exit. A required gate with
 * no sabotage below fails this test, so new gates cannot slip in unproven.
 * Then: locks, task claims, the pre-commit hook, golden stubs, the closed loop and new-game.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-selftest-'));
let gates = JSON.parse(fs.readFileSync(path.join(root, 'studio', 'gates.json'), 'utf8')).gates;
const SKIP = new Set(['.git', 'node_modules', '.env', 'dist']);
// Windows starts each process in about 1.5-2 s (Gemini's run on Hatch's PC: the 8 s supervisor runs timed
// out), so time limits in these tests scale with the platform. STUDIO_SELFTEST_SLOW overrides the factor.
const SLOW = Number(process.env.STUDIO_SELFTEST_SLOW) || (process.platform === 'win32' ? 2.5 : 1);
const secs = (n) => `${Math.ceil(n * SLOW)}s`;
let failed = 0;
let n = 0;

// The self-test never reads the live studio: every copy starts from the template's board and an
// empty pre-production state (qa/fixtures/studio/), whatever game this checkout is building.
const FIXTURE = path.join(root, 'qa', 'fixtures', 'studio');
const LIVE_STATE = ['studio/bible/bible.json', 'studio/bible/BIBLE.md', 'studio/bible/NOT-DOING.md', 'studio/bible/REFERENCES.md', 'studio/bible/STORYBOARD.md', 'studio/bible/ideas', 'studio/bible/systems', 'studio/signed', 'studio/data-consent.json', 'studio/mode.json', 'studio/game.json', 'studio/asks', 'studio/art', 'studio/divisions.json', 'studio/task-holds.json', 'studio/budget.json', 'studio/tricks', 'studio/playtest', 'studio/proof', 'studio/assets', 'studio/decisions/divisions.md', 'studio/intake-answers.json', 'studio/PITFALLS.md', 'studio/PITFALLS-ARCHIVE.md'];
// A game's own folders. In a studio building a game, the copy takes these from the harness release this
// clone last merged (git merge-base HEAD origin/main), never from the live game: run #1's selftest
// failed on a real studio because its divisions, references, assets, goldens and logs leaked in.
const GAME_OWNED = ['studio', 'assets', 'game', 'cartridges', 'web', 'engine', 'qa/golden', 'qa/regressions'];
const isGameOwned = (rel) => GAME_OWNED.some((g) => rel === g || rel.startsWith(`${g}/`));
let TEMPLATE = null; // { dir, rev } once extracted; { dir: null } means this checkout is the template
/**
 * Is this checkout building a game (not the bare template)? Test #2: studios set up before new-game wrote
 * studio/game.json pick their game with STUDIO_CARTRIDGE in .env, so game.json alone missed them and the
 * selftest read the live game (8 FAILs). Any of: game.json; STUDIO_CARTRIDGE naming another cartridge;
 * a cartridges/ folder the harness release doesn't have.
 */
function buildingAGame(base, git) {
  if (fs.existsSync(path.join(root, 'studio', 'game.json'))) return true;
  let cart = process.env.STUDIO_CARTRIDGE || '';
  if (!cart) {
    try {
      cart = (fs.readFileSync(path.join(root, '.env'), 'utf8').match(/^\s*STUDIO_CARTRIDGE\s*=\s*["']?([\w.-]+)/m) || [])[1] || '';
    } catch {
      // no .env
    }
  }
  if (cart && cart !== 'example-sim') return true;
  if (!/^[0-9a-f]{40}$/.test(base || '')) return false;
  const shipped = new Set(String(git(['ls-tree', '--name-only', base, 'cartridges/']).stdout || '').split('\n').filter(Boolean).map((f) => f.replace(/^cartridges\//, '')));
  const here = fs.existsSync(path.join(root, 'cartridges')) ? fs.readdirSync(path.join(root, 'cartridges'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
  return shipped.size > 0 && here.some((c) => !shipped.has(c));
}
// Files git ignores never go into a copy (test #2: the live references/ library leaked in and failed the
// reference-library check; hub/node_modules made every copy slow). The copy should be what CI sees.
let IGNORED = null;
function ignoredPaths() {
  if (IGNORED) return IGNORED;
  const r = spawnSync('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const list = r.status === 0 ? String(r.stdout).split('\0').filter(Boolean).map((x) => x.replace(/\\/g, '/')) : [];
  IGNORED = { files: new Set(list.filter((x) => !x.endsWith('/'))), dirs: list.filter((x) => x.endsWith('/')) };
  return IGNORED;
}
const isIgnored = (rel) => {
  const ig = ignoredPaths();
  return ig.files.has(rel) || ig.dirs.some((d) => `${rel}/`.startsWith(d)) || rel === 'references' || rel.startsWith('references/');
};
function templateTree() {
  if (TEMPLATE) return TEMPLATE;
  const git = (args, input) => spawnSync('git', args, { cwd: root, ...(input === undefined ? { encoding: 'utf8' } : {}), input, maxBuffer: 256 * 1024 * 1024 });
  const base = String(git(['merge-base', 'HEAD', 'origin/main']).stdout || '').trim();
  const building = buildingAGame(base, git);
  const rev = building ? base : '';
  if (!building || !/^[0-9a-f]{40}$/.test(rev)) {
    if (building) console.log('[selftest] note: no origin/main to read the template from; using this checkout with its game state removed.');
    return (TEMPLATE = { dir: null });
  }
  const files = String(git(['ls-tree', '-r', '--name-only', rev, '--', ...GAME_OWNED]).stdout || '').split('\n').filter(Boolean);
  const out = git(['cat-file', '--batch'], files.map((f) => `${rev}:${f}`).join('\n') + '\n').stdout;
  const dir = path.join(tmpRoot, 'template');
  let at = 0;
  for (const f of files) {
    const nl = out.indexOf(10, at);
    const size = Number(out.slice(at, nl).toString('utf8').split(' ')[2]);
    const body = out.subarray(nl + 1, nl + 1 + size);
    at = nl + 1 + size + 1;
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), body);
  }
  console.log(`[selftest] template folders from the harness release ${rev.slice(0, 7)} (${files.length} files); this studio's game is left out.`);
  return (TEMPLATE = { dir, rev });
}

function copyRepo() {
  const dest = path.join(tmpRoot, `copy-${++n}`);
  const tpl = templateTree();
  fs.cpSync(root, dest, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(root, src).replace(/\\/g, '/');
      if (!rel) return true;
      const top = rel.split('/')[0];
      if (tpl.dir && isGameOwned(rel)) return false;
      if (isIgnored(rel)) return false;
      return !SKIP.has(top) && !rel.startsWith('qa/reports/') && !rel.startsWith('.studio/') && !rel.includes('__pycache__');
    },
  });
  if (tpl.dir) fs.cpSync(tpl.dir, dest, { recursive: true });
  for (const rel of LIVE_STATE) fs.rmSync(path.join(dest, rel), { recursive: true, force: true });
  for (const dir of ['studio/reviews', 'studio/bible/reviews', 'studio/experiments']) {
    const d = path.join(dest, dir);
    if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) if (f.toLowerCase() !== 'readme.md') fs.rmSync(path.join(d, f), { recursive: true, force: true });
  }
  fs.cpSync(FIXTURE, path.join(dest, 'studio'), { recursive: true });
  return dest;
}
// The gates the template ships (a game's own gates.json may name its cartridge or add gates).
if (templateTree().dir) gates = JSON.parse(fs.readFileSync(path.join(templateTree().dir, 'studio', 'gates.json'), 'utf8')).gates;
const edit = (dir, rel, fn) => fs.writeFileSync(path.join(dir, rel), fn(fs.readFileSync(path.join(dir, rel), 'utf8')));
// A clean environment: nothing from the shell or .env (agent names, cartridge, keys, folders) leaks into a test.
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(STUDIO_|HUB_|AGENT_|PLAYTEST_|OLLAMA_|NVIDIA_|ANTHROPIC_|OPENAI_|XAI_|GEMINI_|VERTEX_|GROQ_|OPENROUTER_|CODEX_|CURSOR_)|_API_KEY|_TOKEN$/.test(k)));
const run = (dir, cmd, env = {}) => spawnSync(cmd, { cwd: dir, shell: true, encoding: 'utf8', env: { ...CLEAN_ENV, STUDIO_CARTRIDGE: '', AGENT_EVENTS_FILE: '', ...env } });
const plantInvariant = (tick) => (s) =>
  s.replace('  if (state.won && state.lost)', `  if (state.tick === ${tick}) findings.push({ id: 'PLANTED', severity: 'P0', summary: 'planted at tick ${tick}' });\n  if (state.won && state.lost)`);
const runAsync = (dir, cmd, env = {}) =>
  new Promise((resolve) => {
    const c = spawn(cmd, { cwd: dir, shell: true, env: { ...CLEAN_ENV, STUDIO_CARTRIDGE: '', AGENT_EVENTS_FILE: '', ...env } });
    let stdout = '';
    let stderr = '';
    c.stdout.on('data', (d) => (stdout += d));
    c.stderr.on('data', (d) => (stderr += d));
    c.on('close', (status) => resolve({ status, stdout, stderr }));
  });
const report = (label, ok, detail = '') => {
  console.log(`[selftest] ${ok ? 'PASS' : 'FAIL'} ${label}${ok || !detail ? '' : `\n${detail.slice(-600)}`}`);
  if (!ok) failed += 1;
};

const SIM = 'cartridges/example-sim/index.mjs';
const SABOTAGE = {
  // 2.32.0: a branch changes a scenario's expected outcome while main has an owner key, with no approval.
  protected: (d) => {
    const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', STUDIO_OWNER_KEY: path.join(d, '..', `owner-sab-${path.basename(d)}.pem`) };
    const sh = (cmd) => spawnSync(cmd, { cwd: d, shell: true, encoding: 'utf8', env: { ...CLEAN_ENV, ...env } });
    sh('git init -q -b main && git add -A && git commit -qm base && node harness/approve.mjs keygen && git add -A && git commit -qm key && git checkout -q -b sab');
    const qa = path.join(d, 'cartridges', 'example-sim', 'qa.mjs');
    fs.writeFileSync(qa, fs.readFileSync(qa, 'utf8').replace("expect: 'won' }", "expect: 'lost' }"));
    return { STUDIO_PROTECT_BASE: 'main' };
  },
  // 2.32.0: the newest real-input report says the Bible's Buy button did nothing.
  controls: (d) => {
    fs.mkdirSync(path.join(d, 'qa/reports'), { recursive: true });
    fs.writeFileSync(path.join(d, 'qa/reports/browser_9999999999999.json'), JSON.stringify({ controls: [{ id: 'buy-unit', ok: true }, { id: 'buy-button', ok: false, why: 'planted: nothing happened' }] }));
  },
  // 2.30n: the studio's game (not a cartridge) whose own scenarios fail.
  game: (d) => {
    fs.writeFileSync(path.join(d, 'studio/game.json'), JSON.stringify({ game: 'zz-sab' }));
    fs.mkdirSync(path.join(d, 'web/zz-sab/sim'), { recursive: true });
    fs.writeFileSync(path.join(d, 'web/zz-sab/index.html'), '<!doctype html>\n');
    fs.writeFileSync(path.join(d, 'web/zz-sab/sim/qa.mjs'), "console.log('FAIL idle: expected lost'); process.exit(1);\n");
  },
  'godot-unit': (d) => {
    // An enabled Godot project whose gdUnit4 run fails (exit 100) with one failing test in its JUnit XML.
    const g = path.join(d, 'gtest');
    fs.mkdirSync(path.join(g, 'addons', 'gdUnit4'), { recursive: true });
    fs.writeFileSync(path.join(g, 'project.godot'), '[application]\nconfig/name="gtest"\n');
    const xml = '<testsuites><testsuite name="Economy"><testcase name="test_ok" classname="Economy"/><testcase name="test_money_drains" classname="Economy"><failure message="expected money to drop"/></testcase></testsuite></testsuites>';
    fs.writeFileSync(path.join(g, 'addons', 'gdUnit4', 'runtest.sh'), `#!/bin/sh\nmkdir -p reports/report_1\ncat > reports/report_1/results.xml <<'X'\n${xml}\nX\nexit 100\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(d, 'fake-godot'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(d, 'studio', 'godot-unit.json'), JSON.stringify({ enabled: true, project: 'gtest', tests: 'res://test_gdunit', gdunit: 'v6.2.2', godot: '4.7.2', watch: ['sim'] }));
    return { GODOT_BIN: path.join(d, 'fake-godot'), STUDIO_GODOT_UNIT_ALL: '1' };
  },
  session: (d) => fs.rmSync(path.join(d, 'studio/CURRENT_TASK.md')),
  // An alias a regex cannot see: only the runtime probe catches it.
  purity: (d) => edit(d, SIM, (s) => s.replace('const drift =', "const M = Math; const k = 'ran' + 'dom'; M[k]();\n  const drift =")),
  isolation: (d) => edit(d, SIM, (s) => `import * as THREE from 'three';\n${s}`),
  golden: (d) => edit(d, 'qa/golden/example-1337.json', (s) => s.replace(/"sha256": "[0-9a-f]{64}"/, `"sha256": "${'0'.repeat(64)}"`)),
  'golden-py': (d) => edit(d, 'qa/golden/example-1337.json', (s) => s.replace(/"sha256": "[0-9a-f]{64}"/, `"sha256": "${'0'.repeat(64)}"`)),
  approvals: (d) => edit(d, 'cartridges/example-sim/qa.mjs', (s) => `// reference: https://unlisted-asset-store.example.org/pack\n${s}`),
  regressions: (d) => edit(d, 'qa/regressions/example-same-tick.json', (s) => s.replace(/"sha256": "[0-9a-f]{64}"/, `"sha256": "${'0'.repeat(64)}"`)),
  'vertical-slice': (d) => edit(d, SIM, (s) => s.replace('winCredits: 25000', 'winCredits: 90000000')),
  playtest: (d) => edit(d, SIM, plantInvariant(37)),
  soak: (d) => edit(d, SIM, plantInvariant(150)),
  'tick-budget': () => ({ TICK_BUDGET_MS_PER_TICK: '0.0000001' }),
  'hub-smoke': (d) => edit(d, 'hub/server.mjs', (s) => s.replace('return tokenMatches(headerToken(req)) || phoneWrite(req);', 'return true;')),
  reviewer: (d) => fs.writeFileSync(path.join(d, 'studio/reviews/2026-10-20-T-001.md'), 'Review of T-001. Verdict: approve.\n'),
  assets: (d) => {
    fs.mkdirSync(path.join(d, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(d, 'assets/stray.glb'), 'not recorded');
  },
  docs: (d) => fs.writeFileSync(path.join(d, 'docs/STALE.md'), 'Run `npm run no-such-script` first.\n'),
  secrets: (d) => fs.writeFileSync(path.join(d, 'leak.txt'), `OPENAI_API_KEY=${'sk-'}${'a'.repeat(24)}\n`),
  // 2.58.2 (PU-29): with the hooks installed, a branch commit made with --no-verify (no Studio-Hooks stamp).
  hooks: (d) => {
    const sh = (cmd) => spawnSync(cmd, { cwd: d, shell: true, encoding: 'utf8', env: { ...CLEAN_ENV, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    sh('git init -q -b main && git config core.hooksPath scripts/hooks && git add -A && git commit -qm base --no-verify && git checkout -q -b sab');
    fs.writeFileSync(path.join(d, 'sab.txt'), 'sab\n');
    sh('git add sab.txt && git commit -qm "sab skipped the hooks" --no-verify');
    return { STUDIO_PROTECT_BASE: 'main' };
  },
  // 2.58.2 (PU-29): a branch skips a test that runs on main (the word is put together here, so this file has none).
  'weakened-tests': (d) => {
    const sh = (cmd) => spawnSync(cmd, { cwd: d, shell: true, encoding: 'utf8', env: { ...CLEAN_ENV, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    fs.mkdirSync(path.join(d, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(d, 'tests/sab.test.mjs'), "test('sab', () => {\n  expect(1).toBe(1);\n});\n");
    sh('git init -q -b main && git add -A && git commit -qm base --no-verify && git checkout -q -b sab');
    edit(d, 'tests/sab.test.mjs', (t) => t.replace("test('sab'", `test${['.', 'skip'].join('')}('sab'`));
    return { STUDIO_PROTECT_BASE: 'main', STUDIO_WEAKENED_TESTS: 'on' };
  },
  // A real game (not the template) with a browser build, and no browser to play it in: that must fail, not skip.
  'browser-play': (d) => {
    fs.cpSync(path.join(d, 'cartridges/example-sim'), path.join(d, 'cartridges/moss-game'), { recursive: true });
    return { STUDIO_CARTRIDGE: 'moss-game' };
  },
};
// What the failure must mention, so a gate that fails for an unrelated reason does not count.
const EXPECT = {
  session: /MISSING studio\/CURRENT_TASK\.md/,
  purity: /touched: Math\.random/,
  isolation: /three/,
  golden: /sha256 expected 0{64}/,
  'golden-py': /python sha256 [0-9a-f]{64} != golden 0{64}/,
  approvals: /unlisted URL https:\/\/unlisted-asset-store/,
  regressions: /sha256 expected 0{64}/,
  'vertical-slice': /expected "won"/,
  playtest: /\[playtest\] FAIL/,
  soak: /PLANTED/,
  'tick-budget': /ms\/tick >/,
  'hub-smoke': /FAIL write without token is refused/,
  reviewer: /needs model-family and implementer-family/,
  assets: /stray\.glb has no record/,
  'browser-play': /a real game needs the browser check/,
  docs: /npm run no-such-script/,
  secrets: /leak\.txt/,
  'godot-unit': /test_money_drains: expected money to drop/,
  game: /FAIL game:qa/,
  controls: /web: "buy-button" did nothing \(planted/,
  protected: /protected file\(s\) changed since main with no owner approval/,
  hooks: /skipped the git hooks[\s\S]*sab skipped the hooks/,
  'weakened-tests': /tests\/sab\.test\.mjs:1 {2}skip-added/,
};
const CANNOT = { selftest: 'this file' };

// Control: an untouched copy must pass every required gate, so a failure below is caused by its sabotage.
{
  const dir = copyRepo();
  for (const gate of gates.filter((g) => g.required !== false && !CANNOT[g.id])) {
    const res = run(dir, gate.command);
    report(`control: gate ${gate.id} passes on a clean copy`, res.status === 0, `${res.stdout}${res.stderr}`);
  }
}

for (const gate of gates.filter((g) => g.required !== false)) {
  if (CANNOT[gate.id]) continue;
  const sabotage = SABOTAGE[gate.id];
  if (!sabotage) {
    report(`gate "${gate.id}" has no sabotage in qa/selftest.mjs, so nothing proves it can fail`, false);
    continue;
  }
  const dir = copyRepo();
  const env = sabotage(dir) || {};
  const res = run(dir, gate.command, env);
  const out = `${res.stdout}${res.stderr}`;
  const why = EXPECT[gate.id];
  report(`gate ${gate.id} fails when broken${why ? ' (for the planted reason)' : ''}`, res.status !== 0 && (!why || why.test(out)), out);
}

// Purity: the Function constructor reached through a prototype is caught, statically and at runtime.
{
  const dir = copyRepo();
  edit(dir, SIM, (s) => s.replace('const drift =', "const C = 'constr' + 'uctor'; const F = (() => {})[C]; F('return 1')();\n  const drift ="));
  const res = run(dir, 'node scripts/check-sim-purity.mjs');
  report('purity catches the Function constructor reached through a prototype', res.status !== 0 && /Function constructor/.test(`${res.stdout}${res.stderr}`), `${res.stdout}${res.stderr}`);
  const dir2 = copyRepo();
  edit(dir2, SIM, (s) => s.replace('const drift =', "const F = (() => {}).constructor.constructor;\n  const drift ="));
  const res2 = run(dir2, 'node scripts/check-sim-purity.mjs');
  report('purity flags .constructor.constructor in the source', res2.status !== 0 && /NO_CONSTRUCTOR_ESCAPE/.test(`${res2.stdout}${res2.stderr}`), `${res2.stdout}${res2.stderr}`);
}

// Hashes: the display hash is real FNV-1a 64 (standard vectors), the example cartridge's copy agrees with the
// harness, and SHA-256 matches Node's own over the same canonical bytes.
{
  const h = await import(pathToFileURL(path.join(root, 'harness/hash.mjs')).href);
  const enc = (s) => new TextEncoder().encode(s);
  report('the display hash is standard FNV-1a 64-bit', h.fnv1a64(enc('')) === 'cbf29ce484222325' && h.fnv1a64(enc('a')) === 'af63dc4c8601ec8c' && h.fnv1a64(enc('foobar')) === '85944171f73967e8');
  const cartMod = await import(pathToFileURL(path.join(root, 'cartridges/example-sim/index.mjs')).href);
  const s0 = cartMod.createInitialState(1337);
  report('the example cartridge\'s own display hash equals the harness hash64', cartMod.hashSimState(s0) === h.hash64(s0));
  const crypto = await import('node:crypto');
  report('sha256 is SHA-256 of the canonical JSON as UTF-8', h.sha256({ b: 1, a: 'é' }) === crypto.createHash('sha256').update('{"a":"é","b":1}', 'utf8').digest('hex') && h.isSha256(h.sha256({})));
  // The same vectors are checked in Python by qa/test-golden.py, so both languages write identical bytes.
  const { vectors } = JSON.parse(fs.readFileSync(path.join(root, 'qa/hash-vectors.json'), 'utf8'));
  const wrong = vectors.filter((v) => h.canonicalJson(JSON.parse(v.input)) !== v.canonical || h.sha256(JSON.parse(v.input)) !== v.sha256);
  report(`canonical JSON matches all ${vectors.length} shared hash vectors (integer-like keys, tiny floats, emoji keys)`, wrong.length === 0, wrong.map((v) => v.input).join('\n'));
  report('the example cartridge\'s display hash agrees on every hash vector', vectors.every((v) => cartMod.hashSimState(JSON.parse(v.input)) === h.hash64(JSON.parse(v.input))));
  report('integer-like keys keep code-point order (JSON.stringify would move them)', h.canonicalJson({ 10: 1, 2: 2, '-1': 3 }) === '{"-1":3,"10":1,"2":2}');
}

// Golden stubs are not a pass.
{
  const dir = copyRepo();
  edit(dir, 'qa/golden/example-1337.json', (s) => s.replace(/"sha256": "[0-9a-f]{64}"/, '"sha256": "REPLACE_AFTER_FIRST_RUN"'));
  report('golden stub hash fails (no silent rewrite)', run(dir, 'node qa/check-golden.mjs').status !== 0);
}

// A scenario golden pins the actions taken, not only the end state; a custom display hash still passes Python on SHA-256.
{
  const dir = copyRepo();
  edit(dir, 'qa/golden/example-sim-start-to-win.json', (s) => s.replace(/"actionsSha256": "[0-9a-f]{64}"/, `"actionsSha256": "${'1'.repeat(64)}"`));
  const res = run(dir, 'node qa/check-golden.mjs');
  report('a scenario that reaches the same end by other actions fails the golden', res.status !== 0 && /same end state reached a different way/.test(res.stderr), res.stderr);
  const dir2 = copyRepo();
  edit(dir2, SIM, (s) => s.replace('export function hashSimState(state) {', 'export function hashSimState(state) {\n  if (state) return String(state.tick ?? 0).padStart(16, "0");'));
  run(dir2, 'npm run golden -- --update');
  run(dir2, 'node qa/check-regressions.mjs --update');
  const py = run(dir2, 'node qa/run-python.mjs qa/test-golden.py');
  report('a cartridge with its own display hash is marked hashKind custom and passes Python on SHA-256', /"hashKind": "custom"/.test(fs.readFileSync(path.join(dir2, 'qa/golden/example-1337.json'), 'utf8')) && py.status === 0, py.stdout + py.stderr);
}

// Locks and task claims.
{
  const dir = copyRepo();
  report('lock refuses a shared owner name', run(dir, 'node harness/lock.mjs claim task:T-9 --owner cursor').status !== 0);
  const wide = run(dir, 'node harness/lock.mjs claim path:studio --owner alice-1');
  report('lock refuses a whole top-level folder without a reason, and says how to narrow it', wide.status !== 0 && /too-wide/.test(wide.stdout) && /narrowest/.test(wide.stdout), wide.stdout);
  run(dir, 'node harness/lock.mjs claim path:cartridges --owner alice-1 --wide "moving every cartridge"');
  report('lock refuses a second owner on a covered path', run(dir, 'node harness/lock.mjs claim path:cartridges/example-sim/index.mjs --owner bob-1').status !== 0);
  report('task start refuses work with no owner', run(dir, 'node harness/task.mjs start T-002').status !== 0);
  report('task start succeeds for the first owner', run(dir, 'node harness/task.mjs start T-002 --agent alice-1').status === 0);
  report('task start refuses claimed work', run(dir, 'node harness/task.mjs start T-002 --agent bob-1').status !== 0);
  report('task done refuses a non-owner', run(dir, 'node harness/task.mjs done T-002 --agent bob-1').status !== 0);
  run(dir, 'node scripts/balance-sweep.mjs --write');
  report('task done works for the owner once the check passes', run(dir, 'node harness/task.mjs done T-002 --agent alice-1').status === 0);
}

// Locks: agents claiming a folder and files inside it at the same moment can't all win.
{
  const dir = copyRepo();
  const keys = ['path:cartridges', 'path:cartridges/example-sim', 'path:cartridges/example-sim/index.mjs', 'path:cartridges/example-sim/qa.mjs'];
  const results = await Promise.all(keys.flatMap((k, i) => [0, 1].map((j) => runAsync(dir, `node harness/lock.mjs claim ${k} --owner racer-${i}-${j} --wide race`))));
  const holders = new Set(fs.readdirSync(path.join(dir, '.studio/locks')).filter((f) => f.endsWith('.lock')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, '.studio/locks', f), 'utf8'))));
  const paths = [...holders].map((l) => l.key.slice(5));
  const overlap = paths.some((a, i) => paths.some((b, j) => i !== j && (a === b || b.startsWith(`${a}/`))));
  report('parallel claims on a folder and its files leave no overlapping locks', !overlap && holders.size >= 1, `${paths.join(', ')} | exits ${results.map((r) => r.status).join(',')}`);
}

// Done-checks: each type of task refuses to close while its proof is missing, and forcing tells the Producer.
{
  const dir = copyRepo();
  const kinds = [
    ['change', 'node harness/task.mjs add "Wire the spawn table" --role builder'],
    ['bug', 'node harness/task.mjs add "Crash at tick 40" --type bug'],
    ['balance', 'node harness/task.mjs add "Spawn cost" --type balance --role designer-calibrator'],
    ['fun', 'node harness/task.mjs add "Early game pacing" --type fun --role fun-tester'],
    ['playtest', 'node harness/task.mjs add "Seed 7 run" --role qa-playtester'],
    ['study', 'node harness/task.mjs add "Build menu layouts" --type study --role reference-scout'],
    ['review', 'node harness/task.mjs add "Last merge" --type review --role reviewer'],
    ['docs', 'node harness/task.mjs add "Quickstart" --type docs'],
  ];
  const ids = {};
  for (const [kind, add] of kinds) {
    const id = JSON.parse(run(dir, add).stdout).id;
    ids[kind] = id;
    run(dir, `node harness/task.mjs start ${id} --agent alice-1`);
    const res = run(dir, `node harness/task.mjs done ${id} --agent alice-1`);
    report(`done-check refuses an unfinished ${kind} task`, res.status !== 0 && res.stderr.includes(`"${kind}" task`), `${res.stdout}${res.stderr}`);
  }
  run(dir, 'node qa/playtest.mjs --stage 1 --quiet');
  report('done-check passes a playtest task once a report exists', run(dir, `node harness/task.mjs done ${ids.playtest} --agent alice-1`).status === 0);
  fs.mkdirSync(path.join(dir, 'studio/research/build-menus'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'studio/research/build-menus/study.md'), '# Question\nHow do build menus group items?\n');
  report('done-check refuses a study under 120 words', run(dir, `node harness/task.mjs done ${ids.study} --agent alice-1`).status !== 0);
  fs.writeFileSync(path.join(dir, 'studio/research/build-menus/study.md'), `# Question\nHow do build menus group items?\n\n# Findings\n${'Both games group buildings by job, then by size, and show cost before placement. '.repeat(12)}\n`);

  report('done-check passes a study task once study.md exists', run(dir, `node harness/task.mjs done ${ids.study} --agent alice-1`).status === 0);
  const forced = run(dir, `node harness/task.mjs done ${ids.change} --agent alice-1 --force --reason "selftest forced close"`);
  const queue = fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8');
  const events = fs.readFileSync(path.join(dir, '.studio/events.jsonl'), 'utf8');
  report('--force closes the task and queues a check for the Producer', forced.status === 0 && new RegExp(`\\(\`producer\`\\) — Check forced done ${ids.change}`).test(queue), `${forced.stdout}${forced.stderr}\n${queue}`);
  report('--force writes a task.forced event addressed to the Producer', /"type":"task\.forced"[^\n]*"to":"producer"/.test(events));
}

// The Producer handoff reflects the studio's real state, and meetings leave notes, tasks and a log entry.
{
  const dir = copyRepo();
  run(dir, 'node harness/lock.mjs claim path:cartridges/example-sim --owner alice-1');
  run(dir, 'node harness/task.mjs start T-003 --agent alice-1');
  run(dir, 'node harness/task.mjs done T-003 --agent alice-1 --force --reason "selftest forced close"');
  const note = run(dir, 'node harness/handoff.mjs note "Chose spawnCost 400 because wins land on time" --agent producer');
  const brief = run(dir, 'node harness/handoff.mjs --full');
  const out = brief.stdout;
  report('handoff briefing builds from files', brief.status === 0 && fs.existsSync(path.join(dir, '.studio/briefs/producer.md')), `${brief.stdout}${brief.stderr}`);
  report('handoff shows the plan, the newest log note and decisions', note.status === 0 && /## The plan/.test(out) && /Chose spawnCost 400/.test(out) && /ADR-0001/.test(out), out);
  report('handoff puts the forced check first and names who holds what', /## Needs you first[\s\S]*Check forced done T-003/.test(out) && /alice-1: path:cartridges\/example-sim/.test(out), out);

  const start = run(dir, 'node harness/meeting.mjs start "Spawn pacing" --with builder,qa-playtester');
  report('meeting starts and a second one is refused while it runs', start.status === 0 && run(dir, 'node harness/meeting.mjs start "Other" --with builder').status !== 0, `${start.stdout}${start.stderr}`);
  run(dir, 'node harness/meeting.mjs say "Wins land at tick 298" --agent qa-playtester');
  const end = run(dir, 'node harness/meeting.mjs end --decision "Keep spawnCost at 400" --action "Playtest: seeds 1-20|qa-playtester|P2"');
  const notes = fs.readdirSync(path.join(dir, 'studio/meetings')).filter((f) => f !== 'README.md').map((f) => fs.readFileSync(path.join(dir, 'studio/meetings', f), 'utf8')).join('');
  const queue = fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8');
  const log = fs.readFileSync(path.join(dir, 'studio/producer/LOG.md'), 'utf8');
  report('meeting notes keep remarks, decisions and actions', end.status === 0 && /qa-playtester\*\*: Wins land/.test(notes) && /Keep spawnCost at 400/.test(notes) && /Playtest: seeds 1-20/.test(notes), `${end.stdout}${end.stderr}\n${notes}`);
  report('meeting actions become tasks and the outcome reaches the Producer log', /\(`qa-playtester`\) — Playtest: seeds 1-20/.test(queue) && /Meeting "Spawn pacing"/.test(log), `${queue}\n${log}`);
}

// Workers who stop hand back with a note; the watcher requeues abandoned work and pings the Producer once.
{
  const dir = copyRepo();
  run(dir, 'node harness/task.mjs start T-003 --agent cursor-a --model test-model-1');
  run(dir, 'node harness/lock.mjs claim path:cartridges/example-sim --owner cursor-a');
  const pause = run(dir, 'node harness/task.mjs pause T-003 --agent cursor-a --note "Out of usage; adapter half done"');
  const pick = run(dir, 'node harness/task.mjs start T-003 --agent claude-b');
  report('task pause hands back with a note the next agent sees', pause.status === 0 && pick.status === 0 && /adapter half done/.test(pick.stderr), `${pause.stdout}${pause.stderr}${pick.stdout}${pick.stderr}`);
  report('handing back frees the agent\'s folder claims for the next agent', run(dir, 'node harness/lock.mjs claim path:cartridges/example-sim --owner claude-b').status === 0);
  report('events carry the model an agent runs on', /"model":"test-model-1"/.test(fs.readFileSync(path.join(dir, '.studio/events.jsonl'), 'utf8')));
  // T-004 in progress with no claim: abandoned.
  edit(dir, 'studio/NEXT.md', (t) => t.replace(/- \[ \] (\*\*T-004\*\*.*)\n/, '').replace('## IN_PROGRESS\n', '## IN_PROGRESS\n- [>] **T-004** [P1] (`qa-playtester`) — Abandoned run\n'));
  const w1 = run(dir, 'node harness/watch.mjs --stall 0');
  const w2 = run(dir, 'node harness/watch.mjs --stall 0');
  const queue = fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8');
  report('watcher requeues work whose claim is gone, with a handoff note', w1.status === 0 && /- \[ \] \*\*T-004\*\*/.test(queue) && fs.existsSync(path.join(dir, 'studio/handoffs/T-004.md')), `${w1.stdout}${w1.stderr}\n${queue}`);
  report('watcher pings the Producer once, not on every pass', (queue.match(/— Watch: /g) || []).length === 1 && /not pinging again/.test(w2.stdout), `${w1.stdout}${w2.stdout}`);
}

// Onboarding an existing game: read-only scan, fact sheet, tasks once, and the briefing shows it.
{
  const dir = copyRepo();
  const gameDir = path.join(tmpRoot, `game-${n}`);
  fs.mkdirSync(path.join(gameDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(gameDir, 'package.json'), JSON.stringify({ name: 'tiny', scripts: { dev: 'vite' }, dependencies: { phaser: '^3.90.0' } }));
  fs.writeFileSync(path.join(gameDir, 'README.md'), '# Tiny\n\nA tiny test game.\n');
  fs.writeFileSync(path.join(gameDir, 'src/sim.js'), 'export const roll = () => Math.random();\n');
  const before = fs.readFileSync(path.join(gameDir, 'src/sim.js'), 'utf8');
  const first = run(dir, `node scripts/onboard-game.mjs --path ${JSON.stringify(gameDir)} --name "Tiny"`);
  const second = run(dir, `node scripts/onboard-game.mjs --path ${JSON.stringify(gameDir)} --name "Tiny"`);
  const sheet = fs.existsSync(path.join(dir, 'studio/game/GAME.md')) ? fs.readFileSync(path.join(dir, 'studio/game/GAME.md'), 'utf8') : '';
  report('onboard writes a fact sheet with engine and unrepeatable calls', first.status === 0 && /Phaser/.test(sheet) && /Math\.random: 1/.test(sheet), `${first.stdout}${first.stderr}`);
  report('onboard leaves the game untouched and queues its tasks once', fs.readFileSync(path.join(gameDir, 'src/sim.js'), 'utf8') === before && /started an unsigned Game Bible/.test(first.stdout) && /queued 10 task/.test(first.stdout) && /queued 0 task/.test(second.stdout), `${first.stdout}${second.stdout}`);
  report('the Producer briefing shows the onboarded game', /## The game[\s\S]*Tiny: A tiny test game/.test(run(dir, 'node harness/handoff.mjs --full').stdout));
}

// Model scorecard: bugs land on the model that closed the work; the retro turns patterns into suggestions.
{
  const dir = copyRepo();
  run(dir, 'node harness/task.mjs start T-003 --agent cursor-a --model model-a');
  run(dir, 'node harness/task.mjs done T-003 --agent cursor-a --force --reason "selftest forced close"');
  run(dir, 'node harness/task.mjs start T-004 --agent gem-b --model model-b');
  run(dir, 'node qa/playtest.mjs --stage 1 --quiet');
  run(dir, 'node harness/task.mjs done T-004 --agent gem-b');
  run(dir, 'node harness/task.mjs add "Spawn crash" --type bug --caused-by T-003');
  report('reopen refuses a task that is not done', run(dir, 'node harness/task.mjs reopen T-005 --reason x').status !== 0);
  run(dir, 'node harness/task.mjs reopen T-004 --reason "report missed the stall"');
  let sc = {};
  try {
    sc = JSON.parse(run(dir, 'node harness/scorecard.mjs --json').stdout);
  } catch {
    // reported below
  }
  const by = Object.fromEntries((sc.models || []).map((m) => [m.model, m]));
  report('scorecard puts a caused-by bug on the model that closed the task', by['model-a']?.bugs === 1 && by['model-a']?.forced === 1, JSON.stringify(sc));
  report('scorecard counts a reopened task as a bug for its closer', by['model-b']?.bugs === 1 && by['model-b']?.done === 1, JSON.stringify(sc));
  run(dir, 'node harness/task.mjs start T-005 --agent cursor-c --model model-a');
  run(dir, 'node harness/task.mjs pause T-005 --agent cursor-c --note "out of usage"');
  run(dir, 'node harness/task.mjs start T-005 --agent cursor-d --model model-a');
  run(dir, 'node harness/task.mjs pause T-005 --agent cursor-d --note "out of usage again"');
  const retro = run(dir, 'node harness/retro.mjs');
  const retroText = fs.existsSync(path.join(dir, 'studio/memory/retros')) ? fs.readdirSync(path.join(dir, 'studio/memory/retros')).filter((f) => f !== 'README.md').map((f) => fs.readFileSync(path.join(dir, 'studio/memory/retros', f), 'utf8')).join('') : '';
  report('retro writes suggestions from what happened', retro.status === 0 && /ran out of usage/.test(retroText) && /reopened/.test(retroText), `${retro.stdout}${retro.stderr}\n${retroText}`);
  report('the briefing shows the scorecard and the retro suggestions', /## Models[\s\S]*model-a/.test(run(dir, 'node harness/handoff.mjs --full').stdout) && /What the studio learned[\s\S]*ran out of usage/.test(run(dir, 'node harness/handoff.mjs --full').stdout));
}

// The daily spend cap stops model calls before they reach a provider; studio:reset starts a fresh project.
{
  const dir = copyRepo();
  run(dir, 'node harness/event.mjs --quiet --type route.success --agent builder --tokens-in 60 --tokens-out 60 --msg "earlier call"');
  const capped = run(dir, 'node harness/route.mjs --prompt hi --dry-run', { STUDIO_DAILY_TOKEN_CAP: '100' });
  report('spend cap refuses calls once today\'s tokens pass STUDIO_DAILY_TOKEN_CAP', capped.status !== 0 && /Daily token cap reached/.test(capped.stdout), `${capped.stdout}${capped.stderr}`);
  report('without a cap the same call goes through', run(dir, 'node harness/route.mjs --prompt hi --dry-run', { STUDIO_DAILY_TOKEN_CAP: '0' }).stdout.includes('"capped"') === false);
  const dry = run(dir, 'node scripts/studio-reset.mjs --name "Mini Farm"');
  const planBefore = fs.readFileSync(path.join(dir, 'studio/PLAN.md'), 'utf8');
  const reset = run(dir, 'node scripts/studio-reset.mjs --name "Mini Farm" --yes');
  const plan = fs.readFileSync(path.join(dir, 'studio/PLAN.md'), 'utf8');
  report('studio:reset changes nothing without --yes', /nothing changed/.test(dry.stdout) && planBefore !== plan === true);
  report('studio:reset writes a fresh plan and queue and archives the old one', reset.status === 0 && /Mini Farm/.test(plan) && /npm run new-game mini-farm/.test(fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8')) && fs.existsSync(path.join(dir, '.studio/archive')), `${reset.stdout}${reset.stderr}`);
}

// Done-checks read content in a git checkout, and the scorecard traces a bug to the commit before it.
{
  const dir = copyRepo();
  const git = (cmd) => run(dir, `git -c user.name=selftest -c user.email=selftest@example.com ${cmd}`);
  git('init -q');
  git('add -A');
  git('commit -q -m init --no-verify');
  const add = (cmd) => JSON.parse(run(dir, cmd).stdout).id;
  const change = add('node harness/task.mjs add "Faster spawns" --role builder');
  run(dir, `node harness/task.mjs start ${change} --agent alice-1 --model model-a`);
  const none = run(dir, `node harness/task.mjs done ${change} --agent alice-1`);
  report('done-check refuses a change task with no changes', none.status !== 0 && /\[ \] Changes exist|no code changed since it started/.test(`${none.stdout}${none.stderr}`), `${none.stdout}${none.stderr}`);
  edit(dir, 'cartridges/example-sim/qa.mjs', (x) => `${x}\n// faster spawns\n`);
  const noVerify = run(dir, `node harness/task.mjs done ${change} --agent alice-1`);
  report('done-check sees the change but still wants a verify after it', noVerify.status !== 0 && /\[x\] Changes exist/.test(`${noVerify.stdout}${noVerify.stderr}`), `${noVerify.stdout}${noVerify.stderr}`);
  git(`commit -qam "faster spawns" --trailer "Studio-Task: ${change}" --trailer "Studio-Model: model-a" --no-verify`);

  const review = add('node harness/task.mjs add "Review faster spawns" --type review --role reviewer');
  run(dir, `node harness/task.mjs start ${review} --agent rita-1`);
  fs.writeFileSync(path.join(dir, 'studio/reviews/spawns.md'), 'Looked at it. Seems fine overall.\n');
  report('done-check refuses a review that names nothing and gives no verdict', run(dir, `node harness/task.mjs done ${review} --agent rita-1`).status !== 0);
  fs.writeFileSync(path.join(dir, 'studio/reviews/spawns.md'), `Review of ${change}: spawn timing reads correctly. Verdict: approve.\n`);
  report('done-check passes a review that names the task and gives a verdict', run(dir, `node harness/task.mjs done ${review} --agent rita-1`).status === 0);

  const bug = add('node harness/task.mjs add "Spawns overlap" --type bug');
  edit(dir, 'cartridges/example-sim/qa.mjs', (x) => `${x}// fix overlap\n`);
  git(`commit -qam "fix overlap" --trailer "Studio-Task: ${bug}" --trailer "Studio-Model: model-b" --no-verify`);
  const sc = JSON.parse(run(dir, 'node harness/scorecard.mjs --json').stdout);
  const t = sc.traces.find((x) => x.bug === bug);
  report('scorecard traces a bug through commit trailers to the model that last changed the code', t?.model === 'model-a' && t?.task === change, JSON.stringify(sc.traces));
}

// The model check and the launch lines work without any keys.
{
  const dir = copyRepo();
  const mc = run(dir, 'node harness/models-check.mjs --dry-run', { OPENAI_API_KEY: 'test-not-a-key' });
  report('models:check --dry-run names what it would ask, and what has no key', mc.status === 0 && /would-check\s+openai-gpt/.test(mc.stdout) && /no-key/.test(mc.stdout), mc.stdout + mc.stderr);
  const kl = run(dir, 'node harness/kickoff.mjs --role builder --agent codex-a --model gpt-x --tool codex');
  report('kickoff --tool prints a headless launch line with the agent\'s name and model', kl.status === 0 && /STUDIO_LOCK_OWNER=codex-a STUDIO_AGENT_MODEL=gpt-x codex exec --sandbox workspace-write/.test(kl.stdout), kl.stdout);
}

// Pre-production: intake writes the Game Bible; build work waits for a person; phases, purpose and crossed-out layers are enforced.
{
  const dir = copyRepo();
  const env = { STUDIO_PRODUCER_NAME: 'prod-1' };
  const add = (args) => run(dir, `node harness/task.mjs add ${args}`, env);
  report('without a Game Bible, build tasks are queued as before', add('"Research tree screen"').status === 0);
  const intake = run(dir, 'node harness/intake.mjs --answers studio/templates/intake-example.json', env);
  run(dir, 'node harness/intake.mjs --answers studio/templates/intake-example.json', env);
  const queue = () => fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8');
  const notDoing = fs.readFileSync(path.join(dir, 'studio/bible/NOT-DOING.md'), 'utf8');
  report('intake writes the Bible and crosses out the layers answered no', intake.status === 0 && fs.existsSync(path.join(dir, 'studio/bible/BIBLE.md')) && /Tech or research tree/.test(notDoing), intake.stdout + intake.stderr);
  report('intake queues pre-production once (studies, storyboard, R&D, the sign-off)', (queue().match(/Sign the Game Bible/g) || []).length === 1 && /Study: explore the building and bases layer/.test(queue()) && /Docs: storyboard/.test(queue()), queue());
  const early = add('"Moss spreads after rain"');
  report('build tasks wait until a person signs the Bible', early.status !== 0 && /pre-production/.test(early.stderr), early.stderr);
  report('throwaway prototypes are allowed in pre-production', add('"Prototype: stepping stones" --prototype').status === 0);
  const crossed = add('"Add a tech tree for moss" --prototype');
  report('a task touching a crossed-out layer is refused, even as a prototype', crossed.status !== 0 && /crossed-out layer: Tech or research tree/.test(crossed.stderr), crossed.stderr);
  report('an agent can\'t sign the Bible', run(dir, 'node harness/bible.mjs sign --by producer', env).status !== 0);
  report('a person signs it and Phase 1 opens', run(dir, 'node harness/bible.mjs sign --by hatch', env).status === 0 && JSON.parse(fs.readFileSync(path.join(dir, 'studio/bible/bible.json'), 'utf8')).phase.open === 1);
  report('after signing, build tasks need a phase', /--phase 1/.test(add('"Moss spreads after rain"').stderr));
  report('build tasks for a phase that isn\'t open are refused', /Phase 2 isn't open/.test(add('"Terraces" --phase 2 --serves pillar:Calm').stderr));
  report('build tasks must say what they serve', /--serves pillar:Calm/.test(add('"Moss spreads after rain" --phase 1').stderr));
  const ok = add('"Moss spreads after rain" --phase 1 --serves pillar:Readable');
  report('a build task with a phase and a pillar is queued, with a nudge to ping the Director', ok.status === 0 && /npm run director -- ping/.test(ok.stderr), ok.stdout + ok.stderr);
  const drift = run(dir, 'node harness/director.mjs drift', env).stdout;
  report('the drift report flags old work on a crossed-out layer and work that serves nothing', /touches crossed-out tech-tree/.test(drift) && /serves no pillar/.test(drift), drift);

  // The Director: one review task however many pings, a brief, a checked review, and the phase gate.
  run(dir, 'node harness/director.mjs ping --reason "new tasks for Phase 1"', env);
  const ping2 = run(dir, 'node harness/director.mjs ping --reason "check the visitor score"', env);
  const reviewTasks = queue().match(/\*\*(T-\d+)\*\* \[P1\] \(`director`\) — Director review/g) || [];
  const brief = fs.readFileSync(path.join(dir, '.studio/briefs/director.md'), 'utf8');
  report('pings share one Director review task and its brief lists every reason', reviewTasks.length === 1 && /new tasks for Phase 1/.test(brief) && /check the visitor score/.test(brief) && /A Director is needed|STUDIO_DIRECTOR_CMD/.test(ping2.stdout + fs.readFileSync(path.join(dir, '.studio/events.jsonl'), 'utf8')), `${reviewTasks.join(',')}\n${brief}`);
  const rid = reviewTasks[0].match(/T-\d+/)[0];
  run(dir, `node harness/task.mjs start ${rid} --agent director-1`, env);
  const reviewFile = run(dir, 'node harness/director.mjs review', env).stdout.match(/studio\/bible\/reviews\/\S+\.md/)[0];
  report('an unfilled review doesn\'t finish the Director\'s task', run(dir, `node harness/task.mjs done ${rid} --agent director-1`, env).status !== 0);
  edit(dir, reviewFile, (s) => s.replace('Verdict: \n', 'Verdict: on course\n').replace('Checked: \n', 'Checked: pillar:Calm, layer:collections\n').replace('## Next\n', '## Next\n- Moss collection book\n'));
  report('a filled review (phase, verdict, what it checked, next) finishes it', run(dir, `node harness/task.mjs done ${rid} --agent director-1`, env).status === 0);
  report('Phase 2 won\'t open on an "on course" review', run(dir, 'node harness/bible.mjs phase open 2 --by hatch', env).status !== 0);
  edit(dir, reviewFile, (s) => s.replace('Verdict: on course', 'Verdict: phase-ready'));
  // Proven fun (2.25): a person played a build and said yes, and the exit checklist is ticked.
  const notProven = run(dir, 'node harness/bible.mjs phase open 2 --by hatch', env);
  report('Phase 2 won\'t open until a person played a build and said it\'s fun', notProven.status !== 0 && /isn't proven yet: .*nobody has played a build/.test(notProven.stderr + notProven.stdout), notProven.stdout + notProven.stderr);
  report('an agent can\'t give the fun verdict', /looks like an agent/.test(run(dir, 'node harness/verdict.mjs yes --by builder-1', env).stderr));
  fs.mkdirSync(path.join(dir, 'studio/playtest'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'studio/playtest/verdicts.json'), JSON.stringify({ verdicts: [{ at: new Date(Date.now() + 1000).toISOString(), by: 'hatch', fun: 'not-yet', build: 'b-1', phase: 1, note: 'too fast' }] }));
  report('a "not yet" verdict keeps the phase open', /the last verdict was "not yet" \(hatch: too fast\)/.test(run(dir, 'node harness/bible.mjs phase open 2 --by hatch', env).stderr));
  fs.writeFileSync(path.join(dir, 'studio/bible/PHASE-1-EXIT.md'), '# Phase 1 exit\n\n- [x] plays start to win\n- [ ] the moss feels calm\n');
  fs.writeFileSync(path.join(dir, 'studio/playtest/verdicts.json'), JSON.stringify({ verdicts: [{ at: new Date(Date.now() + 2000).toISOString(), by: 'hatch', fun: 'yes', build: 'b-2', phase: 1 }] }));
  report('an unticked exit checklist item keeps it open too', /1 of 2 items in PHASE-1-EXIT\.md aren't ticked/.test(run(dir, 'node harness/bible.mjs phase open 2 --by hatch', env).stderr));
  fs.writeFileSync(path.join(dir, 'studio/bible/PHASE-1-EXIT.md'), '# Phase 1 exit\n\n- [x] plays start to win\n- [x] the moss feels calm\n');
  report('Phase 2 opens once the Director says Phase 1 is ready, the checklist is done and a person said it\'s fun', run(dir, 'node harness/bible.mjs phase open 2 --by hatch', env).status === 0);

  // STUDIO_DIRECTOR_CMD: a ping starts the Director once, then the cooldown holds; the daily ping fires once a day.
  fs.writeFileSync(path.join(dir, 'fake-director.mjs'), "import fs from 'node:fs';\nfs.appendFileSync('director-started.txt', 'x\\n');\n");
  fs.writeFileSync(path.join(dir, 'daily.mjs'), "import { dailyPingIfDue } from './harness/director.mjs';\nconsole.log(dailyPingIfDue() ? 'pinged' : 'skipped');\n");
  const envD = { ...env, STUDIO_DIRECTOR_CMD: 'node fake-director.mjs' };
  const auto1 = run(dir, 'node harness/director.mjs ping --reason "auto start"', envD);
  run(dir, 'node harness/director.mjs ping --reason "auto again"', envD);
  await new Promise((r) => setTimeout(r, 1500));
  const starts = fs.existsSync(path.join(dir, 'director-started.txt')) ? fs.readFileSync(path.join(dir, 'director-started.txt'), 'utf8').trim().split(/\s+/).length : 0;
  report('a ping starts STUDIO_DIRECTOR_CMD once, then waits out the cooldown', /was started/.test(auto1.stdout) && starts === 1, `${auto1.stdout} starts=${starts}`);
  report('the daily Director ping fires once a day', run(dir, 'node daily.mjs', env).stdout.trim() === 'pinged' && run(dir, 'node daily.mjs', env).stdout.trim() === 'skipped');

  // The Idea Board: nothing is built until the Director approves it.
  run(dir, 'node harness/ideas.mjs add "Fireflies at dusk" --by hatch', env);
  run(dir, 'node harness/ideas.mjs add "Snails redraw paths" --by hatch', env);
  run(dir, 'node harness/watch.mjs', env);
  run(dir, 'node harness/watch.mjs', env);
  report('the watcher hands all new ideas to the Producer in one task', (queue().match(/Ideas: 2 new \(I-001, I-002\)/g) || []).length === 1, queue());
  const early2 = add('"Fireflies glow" --phase 2 --idea I-001');
  report('an idea that isn\'t approved can\'t become a task', early2.status !== 0 && /captured/.test(early2.stderr), early2.stderr);
  run(dir, 'node harness/ideas.mjs route I-001 --by prod-1', env);
  const shapeTask = (queue().match(/\*\*(T-\d+)\*\* \[P2\] \(`rnd`\) — Idea: shape I-001/) || [])[1];
  run(dir, `node harness/task.mjs start ${shapeTask} --agent rnd-1`, env);
  report('an R&D idea task isn\'t done until the idea moves', run(dir, `node harness/task.mjs done ${shapeTask} --agent rnd-1`, env).status !== 0);
  run(dir, 'node harness/ideas.mjs shape I-001 --notes "Phase 2 ambience; visitors rate higher at dusk" --by rnd-1', env);
  report('it is done once the idea is shaped', run(dir, `node harness/task.mjs done ${shapeTask} --agent rnd-1`, env).status === 0);
  const placed = run(dir, 'node harness/ideas.mjs place I-001 --phase 2 --layer map-expansion --unlock "second terrace" --schedule "M2" --by planner-1', env);
  report('placing an idea pings the Director', placed.status === 0 && /director\.ping[^\n]*Decide idea I-001/.test(fs.readFileSync(path.join(dir, '.studio/events.jsonl'), 'utf8')), placed.stdout + placed.stderr);
  report('the Director approves it', run(dir, 'node harness/ideas.mjs decide I-001 approve --by director-1 --note "fits Calm"', env).status === 0);
  const sched = add('"Fireflies glow over the moss" --phase 2 --idea I-001');
  const idea = JSON.parse(fs.readFileSync(path.join(dir, 'studio/bible/ideas/I-001.json'), 'utf8'));
  report('an approved idea becomes a task and is marked scheduled', sched.status === 0 && idea.stage === 'scheduled' && idea.tasks.length === 1 && /I-001 Fireflies/.test(fs.readFileSync(path.join(dir, 'studio/bible/BIBLE.md'), 'utf8')), sched.stderr + JSON.stringify(idea));
  const brief2 = run(dir, 'node harness/handoff.mjs --full', env).stdout;
  report('the Producer briefing shows the game plan and the idea waiting to be routed', /## The game plan/.test(brief2) && /Phase 2 of 3 is open/.test(brief2) && /New idea I-002/.test(brief2), brief2.slice(0, 1500));

  // A fresh studio starts in pre-production.
  run(dir, 'node scripts/studio-reset.mjs --name "Next Game" --yes', env);
  const after = add('"Build the first level"');
  report('studio:reset starts an unsigned Bible, so build work waits for the intake', after.status !== 0 && /pre-production/.test(after.stderr) && /npm run intake/.test(queue()), after.stderr);
}

// Experiments: tagged commits can be kept, or taken back out in part or in full, leaving other work alone.
{
  const dir = copyRepo();
  const git = (cmd, env = {}) => run(dir, `git -c user.name=selftest -c user.email=selftest@example.com ${cmd}`, env);
  git('init -q');
  git('add -A');
  git('commit -q -m init --no-verify');
  run(dir, 'node scripts/install-hooks.mjs');
  run(dir, 'node harness/experiment.mjs start "Glowing moss at night" --by hatch');
  const X = { STUDIO_EXPERIMENT: 'X-001' };
  edit(dir, 'cartridges/example-sim/qa.mjs', (s) => `${s}\n// night glow\n`);
  fs.writeFileSync(path.join(dir, 'cartridges/example-sim/glow.txt'), 'glow\n');
  git('add -A');
  git('commit -q -m "night glow"', X);
  edit(dir, 'cartridges/example-sim/index.mjs', (s) => `${s}\n// unrelated work\n`);
  git('commit -qam "unrelated"');
  const tagged = run(dir, 'git log --format=%B -n 2').stdout;
  report('commits made with STUDIO_EXPERIMENT carry the experiment trailer, others don\'t', (tagged.match(/Studio-Experiment: X-001/g) || []).length === 1, tagged);
  const part = run(dir, 'node harness/experiment.mjs drop X-001 --by hatch --only cartridges/example-sim/glow.txt');
  report('dropping part of an experiment takes out only that part', part.status === 0 && !fs.existsSync(path.join(dir, 'cartridges/example-sim/glow.txt')) && /night glow/.test(fs.readFileSync(path.join(dir, 'cartridges/example-sim/qa.mjs'), 'utf8')), part.stdout + part.stderr);
  const full = run(dir, 'node harness/experiment.mjs drop X-001 --by hatch');
  const qa = fs.readFileSync(path.join(dir, 'cartridges/example-sim/qa.mjs'), 'utf8');
  const idx = fs.readFileSync(path.join(dir, 'cartridges/example-sim/index.mjs'), 'utf8');
  const rec = JSON.parse(fs.readFileSync(path.join(dir, 'studio/experiments/X-001.json'), 'utf8'));
  report('dropping the rest takes it all out and leaves other work in place', full.status === 0 && !/night glow/.test(qa) && /unrelated work/.test(idx) && rec.status === 'dropped', full.stdout + full.stderr);
  run(dir, 'node harness/experiment.mjs start "Snails redraw paths" --by hatch');
  const t = run(dir, 'node harness/experiment.mjs task X-002 "snail trail prototype"').stdout.match(/T-\d+/)[0];
  run(dir, `node harness/task.mjs start ${t} --agent builder-x`);
  edit(dir, 'cartridges/example-sim/qa.mjs', (s) => `${s}// snail trail\n`);
  git('commit -qam "snail trail"', { STUDIO_LOCK_OWNER: 'builder-x' });
  report('work on an experiment\'s task is tagged with the experiment', /Studio-Experiment: X-002/.test(run(dir, 'git log -1 --format=%B').stdout), run(dir, 'git log -1 --format=%B').stdout);
  report('keeping an experiment records the decision', run(dir, 'node harness/experiment.mjs keep X-002 --by hatch').status === 0 && JSON.parse(fs.readFileSync(path.join(dir, 'studio/experiments/X-002.json'), 'utf8')).status === 'kept');
}

// The Liaison: nothing moves until the game dev confirms; then it reaches the Producer and the Director.
{
  const dir = copyRepo();
  const env = { STUDIO_PRODUCER_NAME: 'prod-1', STUDIO_LOCK_OWNER: 'liaison-1' };
  run(dir, 'node harness/intake.mjs --answers studio/templates/intake-example.json', env);
  run(dir, 'node harness/bible.mjs sign --by hatch', env);
  const d = run(dir, 'node harness/liaison.mjs draft --kind idea --title "Night tide" --summary "At night the moss glows and visitors rate higher" --from hatch', env);
  report('a draft is read back to the game dev and asks to push it on', /Shall I push it on\?/.test(d.stdout) && /Night tide/.test(d.stdout), d.stdout);
  report('nothing reaches the Idea Board before the game dev confirms', !fs.existsSync(path.join(dir, 'studio/bible/ideas/I-001.json')));
  report('an agent can\'t confirm for the game dev', run(dir, 'node harness/liaison.mjs confirm B-001 --by liaison-1', env).status !== 0);
  const c = run(dir, 'node harness/liaison.mjs confirm B-001 --by hatch --quote "yes push it"', env);
  const idea = JSON.parse(fs.readFileSync(path.join(dir, 'studio/bible/ideas/I-001.json'), 'utf8'));
  const q = fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8');
  report('a confirmed idea is labelled dev-confirmed, goes straight to R&D, and pings the Director', c.status === 0 && idea.source === 'dev-confirmed' && /\(`rnd`\) — Idea: shape I-001/.test(q) && /\(`director`\) — Director review: New dev-confirmed idea I-001/.test(q), c.stdout + c.stderr + q);
  run(dir, 'node harness/liaison.mjs draft --kind direction --title "Slower rain" --summary "Rain takes twice as long" --from hatch', env);
  run(dir, 'node harness/liaison.mjs confirm B-002 --by hatch', env);
  const q2 = fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8');
  report('a confirmed direction becomes a Producer task and joins the Director\'s open review', /\(`producer`\) — Plan: turn the game dev's direction into tasks: Slower rain/.test(q2) && (q2.match(/Director review/g) || []).length === 1, q2);
}

// The learning loop: the same failure on two days is flagged, with the lesson that didn't stick.
{
  const dir = copyRepo();
  const day = (d, msg) => JSON.stringify({ ts: `${d}T10:00:00.000Z`, type: 'closedloop.escalate', agent: 'watch', msg });
  fs.appendFileSync(path.join(dir, '.studio/events.jsonl'), `${[day('2026-10-01', 'BUG-11 replay drift at tick 120: Math.random in a helper'), day('2026-10-03', 'BUG-19 replay drift at tick 340: Math.random in a helper')].join('\n')}\n`);
  const l = run(dir, 'node harness/learn.mjs');
  report('npm run learn flags a failure seen on two days and the lesson that didn\'t stick', /on 2 days/.test(l.stdout) && /didn't stick: "\[2026-10-19\] BUG-SEED-001/.test(l.stdout), l.stdout);
  const to = path.join(tmpRoot, `backup-${n}`);
  const b = run(dir, `node harness/learn.mjs backup --to "${to}"`);
  const made = fs.existsSync(to) ? fs.readdirSync(to) : [];
  const store = path.join(to, made[0] || 'none');
  report('npm run learn -- backup copies the studio\'s memory, with a one-file version', b.status === 0 && made.length === 1 && fs.existsSync(path.join(store, 'latest/STUDIO-MEMORY.md')) && fs.existsSync(path.join(store, 'latest/studio/memory/failures.md')), b.stdout + b.stderr);
  const objects = () => fs.readdirSync(path.join(store, 'objects')).reduce((k, d) => k + fs.readdirSync(path.join(store, 'objects', d)).length, 0);
  const before = objects();
  run(dir, `node harness/learn.mjs backup --to "${to}"`);
  report('a second backup stores only what changed', objects() - before <= 3 && fs.readdirSync(path.join(store, 'history')).length === 2, `${before} -> ${objects()} objects`);
  edit(dir, 'studio/memory/failures.md', (s) => `${s}\n### lost line\n`);
  run(dir, `node harness/learn.mjs backup --to "${to}"`);
  const first = fs.readdirSync(path.join(store, 'history')).sort()[0].replace('.json', '');
  const back = path.join(tmpRoot, `restore-${n}`);
  const r = run(dir, `node harness/learn.mjs restore --from "${to}" --to "${back}" --at ${first}`);
  report('restore brings back a file as it was at an earlier backup', r.status === 0 && !/lost line/.test(fs.readFileSync(path.join(back, 'studio/memory/failures.md'), 'utf8')), r.stdout + r.stderr);
  const pr = run(dir, `node harness/learn.mjs prune --from "${to}" --keep 1`);
  report('prune keeps the newest backups and the first of the month', pr.status === 0 && fs.readdirSync(path.join(store, 'history')).length === 2, pr.stdout + pr.stderr);
  run(dir, 'node harness/notes.mjs add --kind eval "score 3; agents followed the loop; two forced dones"');
  report('the overseer\'s evaluations are kept with the harness notes', /## Overseer evaluations[\s\S]*score 3/.test(fs.readFileSync(path.join(dir, 'studio/harness-notes/NOTES.md'), 'utf8')));
}

// The dev's seat: references are kept, assets carry who may use them, follow-up questions get asked.
{
  const dir = copyRepo();
  const env = { STUDIO_PRODUCER_NAME: 'prod-1' };
  fs.writeFileSync(path.join(dir, 'clip.mp4'), 'a saved clip');
  const r1 = run(dir, 'node harness/refs.mjs add clip.mp4 --game "A Short Hike" --feature "climbing stamina" --at 0:42 --take "feathers as stamina"', env);
  const lib = fs.readdirSync(path.join(dir, 'references'));
  report('a reference file is kept in the library with a note, and listed in LIBRARY.md', r1.status === 0 && lib.length === 1 && fs.existsSync(path.join(dir, 'references', lib[0], 'clip.mp4')) && /climbing stamina/.test(fs.readFileSync(path.join(dir, 'studio/references/LIBRARY.md'), 'utf8')), r1.stdout + r1.stderr);
  const libDir = path.join(tmpRoot, `drive-${n}`);
  run(dir, 'node harness/refs.mjs add clip.mp4 --game "Viridi" --feature "watering"', { ...env, STUDIO_REFERENCE_DIR: libDir });
  report('STUDIO_REFERENCE_DIR puts the library in another folder (a synced drive)', fs.existsSync(libDir) && fs.readdirSync(libDir).length === 1);
  fs.writeFileSync(path.join(dir, 'boat.glb'), 'model');
  report('an agent can\'t declare a game asset', run(dir, 'node harness/assets.mjs add boat.glb --use game --owner Hatch --licence "own work" --by builder-1', env).status !== 0);
  const a = run(dir, 'node harness/assets.mjs add boat.glb --use game --owner Hatch --licence "own work" --by hatch', env);
  const man = JSON.parse(fs.readFileSync(path.join(dir, 'studio/assets/manifest.json'), 'utf8'));
  report('a person declares a game asset: it is copied to assets/own/ with who said so and a checksum', a.status === 0 && man.assets[0].declaredBy === 'hatch' && /hatch stated that Hatch owns this file/.test(man.assets[0].statement) && fs.existsSync(path.join(dir, 'assets/own/boat.glb')), a.stdout + a.stderr);
  report('the assets gate passes with every shipped file recorded', run(dir, 'node scripts/check-assets.mjs').status === 0);
  fs.appendFileSync(path.join(dir, 'assets/own/boat.glb'), 'changed');
  report('the assets gate fails when a recorded file changed', /changed since hatch recorded it/.test(run(dir, 'node scripts/check-assets.mjs').stdout));
  fs.writeFileSync(path.join(dir, 'assets/own/boat.glb'), 'model');
  edit(dir, 'cartridges/example-sim/qa.mjs', (s) => `${s}\n// const look = 'references/R-001-a-short-hike/clip.mp4';\n`);
  report('the assets gate fails when game code points at the reference library', /points at the reference library/.test(run(dir, 'node scripts/check-assets.mjs').stdout));

  run(dir, 'node harness/intake.mjs --answers studio/templates/intake-example.json', env);
  const pending = JSON.parse(run(dir, 'node harness/intake.mjs --followups --json', env).stdout);
  report('follow-up questions cover the phases and every kept or explore layer, and none that are crossed out', pending.some((f) => f.about === 'phase:1') && pending.some((f) => f.about === 'collections') && pending.some((f) => f.about === 'building') && !pending.some((f) => f.about === 'tech-tree'), JSON.stringify(pending.map((f) => f.about)));
  fs.writeFileSync(path.join(dir, 'fu.json'), JSON.stringify({ 'phase:1#1': 'Tap a bed to plant moss', 'collections#1': 'Twelve moss types' }));
  run(dir, 'node harness/intake.mjs --followups --answers fu.json', env);
  report('follow-up answers land in the Bible under Details', /## Details[\s\S]*Twelve moss types/.test(fs.readFileSync(path.join(dir, 'studio/bible/BIBLE.md'), 'utf8')));
  const fake = path.join(dir, 'fake-model.mjs');
  fs.writeFileSync(fake, `import http from 'node:http';
const content = 'phase:1 | How fast does moss spread after rain?\\nnot-a-layer | Is this kept?\\ntech-tree | What does research unlock?\\nphase:2 | What does a visitor do on a path?';
const s = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: 'fake-cheap', choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 10 } })); }); });
s.listen(0, '127.0.0.1', () => console.log(s.address().port));`);
  const server = spawn(process.execPath, [fake], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((r) => server.stdout.once('data', (d) => r(String(d).trim())));
  const m = await runAsync(dir, 'node harness/intake.mjs --followups --model --json', { ...env, OLLAMA_BASE_URL: `http://127.0.0.1:${port}/v1`, STUDIO_PREPARE_CHAIN: 'ollama-local' });
  server.kill();
  const ai = Object.values(JSON.parse(fs.readFileSync(path.join(dir, 'studio/bible/bible.json'), 'utf8')).followups || {}).filter((f) => f.source === 'model').map((f) => f.q);
  report('a cheap model adds follow-ups from the answers; questions about crossed-out or unknown layers are dropped', ai.length === 2 && ai.includes('How fast does moss spread after rain?') && !ai.some((q) => /research|kept/.test(q)), m.stdout + JSON.stringify(ai));
}

// Agent identity and the game's voice: briefs carry who the agent is, where its role gets refused,
// lessons filed for the role, and the voice; the fun check reads the game through the personas.
{
  const dir = copyRepo();
  const env = { STUDIO_PRODUCER_NAME: 'prod-1' };
  const id = JSON.parse(run(dir, 'node harness/task.mjs add "Wire the moss table"', env).stdout).id;
  run(dir, `node harness/task.mjs start ${id} --agent builder-1`, env);
  run(dir, `node harness/task.mjs done ${id} --agent builder-1`, env);
  edit(dir, 'studio/memory/failures.md', (s) => `${s}\n### [2026-10-20] BUG-ROLE-1 — Golden edited instead of the bug\n- **What broke**: x\n- **Root cause**: y\n- **The fix that worked**: z\n- **How to avoid it next time**: fix the code, then regenerate\n- **Role**: builder\n`);
  run(dir, 'node harness/intake.mjs --answers studio/templates/intake-example.json', env);
  run(dir, `node harness/focus.mjs ${id} --agent builder-1`, env);
  const brief = fs.readFileSync(path.join(dir, `.studio/briefs/${id}.md`), 'utf8');
  report('a focus brief says who the agent is, from its role card', /## Who you are \(studio\/roles\/builder\.md\)/.test(brief) && /Good work looks like/.test(brief), brief.slice(0, 800));
  report('a focus brief lists where agents in that role get refused most', /## Where `builder` agents get refused most[\s\S]*1x: /.test(brief), brief);
  report('a focus brief carries lessons filed for the role', /Lessons filed for `builder`[\s\S]*BUG-ROLE-1/.test(brief), brief);
  report('a focus brief for work players see carries the game\'s voice', /## The game's voice[\s\S]*Tone: Quiet, warm/.test(brief), brief);
  const fun = run(dir, 'node scripts/fun-check.mjs').stdout;
  report('the fun check reads the game through every persona with a lens', /## Through the personas/.test(fun) && /The first-timer: first win after/.test(fun) && /The min-maxer:/.test(fun) && /The calm player:/.test(fun) && /The explorer:/.test(fun), fun);
}

// Signed results: a signature proves who vouched; tampering breaks it; --replay re-runs the goldens.
{
  const dir = copyRepo();
  const git = (cmd) => run(dir, `git -c user.name=selftest -c user.email=selftest@example.com ${cmd}`);
  git('init -q');
  git('add -A');
  git('commit -q -m init --no-verify');
  const allGates = (ok = true) => JSON.stringify({ at: new Date(Date.now() + 5000).toISOString(), rows: gates.filter((g) => g.required).map((g) => ({ id: g.id, required: true, ok })) });
  fs.writeFileSync(path.join(dir, '.studio/gates-last.json'), JSON.stringify({ at: new Date(Date.now() + 5000).toISOString(), rows: [{ id: 'golden', required: true, ok: true }] }));
  run(dir, 'node harness/sign.mjs keygen');
  const partialSign = run(dir, 'node harness/sign.mjs result --by hatch');
  report('signing refuses a gate run that skipped required gates', partialSign.status !== 0 && /required gates that never ran/.test(partialSign.stderr), partialSign.stderr);
  fs.writeFileSync(path.join(dir, '.studio/gates-last.json'), JSON.stringify({ at: '2020-01-01T00:00:00.000Z', rows: JSON.parse(allGates()).rows }));
  const staleSign = run(dir, 'node harness/sign.mjs result --by hatch');
  report('signing refuses a gate run older than the last game change', staleSign.status !== 0 && /older than the last change/.test(staleSign.stderr), staleSign.stderr);
  fs.rmSync(path.join(dir, '.studio/keys'), { recursive: true, force: true });
  fs.rmSync(path.join(dir, 'studio/keys'), { recursive: true, force: true });
  fs.writeFileSync(path.join(dir, '.studio/gates-last.json'), allGates());
  report('signing needs a key first', run(dir, 'node harness/sign.mjs result --by hatch').status !== 0);
  const kg = run(dir, 'node harness/sign.mjs keygen');
  report('keygen keeps the private key out of git and the public key in studio/keys', kg.status === 0 && fs.existsSync(path.join(dir, '.studio/keys/studio-ed25519.pem')) && fs.existsSync(path.join(dir, 'studio/keys/studio-ed25519.pub.pem')) && git('check-ignore -q .studio/keys/studio-ed25519.pem').status === 0, kg.stdout + kg.stderr);
  const sr = run(dir, 'node harness/sign.mjs result --by hatch --note "slice 1"');
  const signed = path.join(dir, 'studio/signed', fs.readdirSync(path.join(dir, 'studio/signed'))[0]);
  const doc = JSON.parse(fs.readFileSync(signed, 'utf8'));
  report('a signed result lists every golden\'s SHA-256, the gates and the commit', sr.status === 0 && doc.manifest.goldens.length === 2 && doc.manifest.goldens.every((g) => /^[0-9a-f]{64}$/.test(g.sha256)) && doc.manifest.gates.required === gates.filter((g) => g.required).length && doc.manifest.goldens.every((g) => /^[0-9a-f]{64}$/.test(g.fileSha256)) && /^[0-9a-f]{64}$/.test(doc.manifest.code.cartridges[0]?.sha256) && /^[0-9a-f]{40}$/.test(doc.manifest.commit), sr.stdout + sr.stderr);
  const v = run(dir, `node harness/sign.mjs verify "${signed}" --replay`);
  report('verify --replay checks the signature and re-runs the goldens', v.status === 0 && /this code produces the signed results/.test(v.stdout), v.stdout + v.stderr);
  const tampered = path.join(dir, 'tampered.json');
  fs.writeFileSync(tampered, JSON.stringify({ ...doc, manifest: { ...doc.manifest, signedBy: 'someone-else' } }));
  report('a changed manifest fails verification', run(dir, `node harness/sign.mjs verify "${tampered}"`).status !== 0);
  edit(dir, 'cartridges/example-sim/qa.mjs', (s) => `${s}\n// edited after signing\n`);
  const codeChanged = run(dir, `node harness/sign.mjs verify "${signed}" --replay`);
  report('verify --replay fails when the cartridge code differs from the signed code', codeChanged.status !== 0 && /differs from the signed code/.test(codeChanged.stderr), codeChanged.stdout + codeChanged.stderr);
  edit(dir, 'qa/golden/example-1337.json', (s) => s.replace(/"sha256": "[0-9a-f]{64}"/, `"sha256": "${'1'.repeat(64)}"`));
  report('verify --replay fails when the repo no longer produces the signed results', run(dir, `node harness/sign.mjs verify "${signed}" --replay`).status !== 0);
  fs.writeFileSync(path.join(dir, '.studio/gates-last.json'), allGates(false));
  report('signing refuses a red verify unless told to record it', run(dir, 'node harness/sign.mjs result --by hatch').status !== 0);
}

// Trajectory export: opt-in only, one labelled record per finished task, secrets scrubbed.
{
  const dir = copyRepo();
  const env = { STUDIO_PRODUCER_NAME: 'prod-1' };
  const git = (cmd) => run(dir, `git -c user.name=selftest -c user.email=selftest@example.com ${cmd}`);
  git('init -q');
  git('add -A');
  git('commit -q -m init --no-verify');
  // 2.58.0: task done runs the secret scan itself; the board and hand-off notes, where the key-shaped title below
  // lands, stay out of git here.
  git('rm -q -r --cached --ignore-unmatch studio/NEXT.md studio/DONE.md studio/CURRENT_TASK.md studio/handoffs');
  fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
  fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), '\nstudio/NEXT.md\nstudio/DONE.md\nstudio/CURRENT_TASK.md\nstudio/handoffs/\n');
  git('commit -q -m "board out of git" --no-verify');
  const a = JSON.parse(run(dir, 'node harness/task.mjs add "Plan: the moss table" --role producer', env).stdout).id;
  run(dir, `node harness/task.mjs start ${a} --agent prod-1 --model model-a`, env);
  fs.writeFileSync(path.join(dir, 'notes.md'), 'plan\n');
  git(`add -A`);
  git(`commit -q -m plan --no-verify --trailer "Studio-Task: ${a}"`);
  run(dir, `node harness/task.mjs done ${a} --agent prod-1`, env);
  const key = `${'sk-'}${'z'.repeat(24)}`;
  const b = JSON.parse(run(dir, `node harness/task.mjs add "Plan: rotate ${key}" --role producer`, env).stdout).id;
  run(dir, `node harness/task.mjs start ${b} --agent prod-1`, env);
  run(dir, `node harness/task.mjs done ${b} --agent prod-1`, env);
  run(dir, `node harness/task.mjs reopen ${b} --reason "missed a file"`, env);
  run(dir, `node harness/task.mjs start ${b} --agent prod-1`, env);
  run(dir, `node harness/task.mjs done ${b} --agent prod-1`, env);
  report('trajectory export refuses without terms', run(dir, 'node harness/trajectories.mjs export', env).status !== 0);
  const shown = run(dir, 'node harness/data-consent.mjs', env).stdout;
  report('the data-sharing question starts ticked (allowed by default)', /\[x\] Yes/.test(shown) && /allowed by default/.test(shown), shown);
  run(dir, 'node harness/data-consent.mjs decline --by hatch', env);
  const refused = run(dir, 'node harness/trajectories.mjs export --licence "internal evaluation only"', env);
  report('after the game dev declines, nothing is exported, whatever flags are passed', refused.status !== 0 && /declined sharing/.test(refused.stderr) && !fs.existsSync(path.join(dir, '.studio/exports')), refused.stdout + refused.stderr);
  run(dir, 'node harness/data-consent.mjs allow --by hatch', env);
  const ex = run(dir, 'node harness/trajectories.mjs export --consent "hatch, for the studio\'s own model tests" --licence "internal evaluation only"', env);
  const out = fs.readdirSync(path.join(dir, '.studio/exports'));
  const jsonl = fs.readFileSync(path.join(dir, '.studio/exports', out.find((f) => f.endsWith('.jsonl'))), 'utf8');
  const recs = jsonl.trim().split('\n').map((l) => JSON.parse(l));
  const man = JSON.parse(fs.readFileSync(path.join(dir, '.studio/exports', out.find((f) => f.endsWith('.manifest.json'))), 'utf8'));
  report('an export writes one labelled record per finished task, with its commits', ex.status === 0 && recs.length === 2 && recs.find((r) => r.id === a)?.label === 'clean' && recs.find((r) => r.id === a)?.commits.length === 1 && recs.find((r) => r.id === b)?.label === 'caused-bug', ex.stdout + ex.stderr + jsonl);
  report('exported text is scrubbed of key-shaped strings, and the manifest records consent and a SHA-256', !jsonl.includes(key) && /\[removed\]/.test(jsonl) && man.consent && man.licence && man.consentRecord?.how === 'confirmed' && /^[0-9a-f]{64}$/.test(man.sha256) && man.scrubbedSecrets >= 1, JSON.stringify(man));
}

// A bug's regression must fail on the code before the fix, or it guards nothing.
{
  const dir = copyRepo();
  const env = { STUDIO_PRODUCER_NAME: 'prod-1' };
  const git = (cmd) => run(dir, `git -c user.name=selftest -c user.email=selftest@example.com ${cmd}`);
  git('init -q');
  git('add -A');
  git('commit -q -m init --no-verify');
  edit(dir, 'cartridges/example-sim/index.mjs', (s) => s.replace('startCredits: 1500,', 'startCredits: 1400,'));
  git('commit -qam "cheaper start" --no-verify --trailer "Studio-Task: T-900"');
  const bug = JSON.parse(run(dir, 'node harness/task.mjs add "Starting credits wrong" --type bug', env).stdout).id;
  run(dir, `node harness/task.mjs start ${bug} --agent fixer-1`, env);
  edit(dir, 'cartridges/example-sim/index.mjs', (s) => s.replace('startCredits: 1400,', 'startCredits: 1500,'));
  fs.copyFileSync(path.join(dir, 'qa/regressions/example-same-tick.json'), path.join(dir, 'qa/regressions/BUG-credits.json'));
  edit(dir, 'qa/regressions/BUG-credits.json', (s) => s.replace('"REG-same-tick"', '"BUG-credits"'));
  const uncommitted = run(dir, `node harness/done-check.mjs ${bug}`, env).stdout;
  report('the bug check asks for the fix to be committed with the task\'s tag', /\[ \] Regression fails on the code before the fix: no commit tagged/.test(uncommitted), uncommitted);
  git(`add -A`);
  git(`commit -q -m "restore credits" --no-verify --trailer "Studio-Task: ${bug}"`);
  const good = run(dir, `node harness/done-check.mjs ${bug}`, env).stdout;
  report('a regression that fails on the code before the fix passes the check', /\[x\] Regression fails on the code before the fix/.test(good), good);
  const bug2 = JSON.parse(run(dir, 'node harness/task.mjs add "Docs typo in the guide" --type bug', env).stdout).id;
  run(dir, `node harness/task.mjs start ${bug2} --agent fixer-2`, env);
  fs.copyFileSync(path.join(dir, 'qa/regressions/example-same-tick.json'), path.join(dir, 'qa/regressions/BUG-typo.json'));
  edit(dir, 'qa/regressions/BUG-typo.json', (s) => s.replace('"REG-same-tick"', '"BUG-typo"'));
  fs.writeFileSync(path.join(dir, 'GUIDE.md'), 'fixed typo\n');
  git('add -A');
  git(`commit -q -m "typo" --no-verify --trailer "Studio-Task: ${bug2}"`);
  const bad = run(dir, `node harness/done-check.mjs ${bug2}`, env).stdout;
  report('a regression that also passes before the fix is refused: it doesn\'t catch the bug', /\[ \] Regression fails on the code before the fix: the regression passes on/.test(bad), bad);
  report('checking before the fix leaves no worktree behind', !/fails-before-/.test(run(dir, 'git worktree list').stdout));
}

// System tasks: spec with hand-off, scenario, goldens, playtest, verify, and a review from another model family.
{
  const dir = copyRepo();
  const env = { STUDIO_PRODUCER_NAME: 'prod-1' };
  const git = (cmd) => run(dir, `git -c user.name=selftest -c user.email=selftest@example.com ${cmd}`);
  git('init -q');
  git('add -A');
  git('commit -q -m init --no-verify');
  const id = JSON.parse(run(dir, 'node harness/task.mjs add "Visitors" --type system', env).stdout).id;
  run(dir, `node harness/task.mjs start ${id} --agent builder-1 --model claude-opus-5-5`, env);
  const empty = run(dir, `node harness/done-check.mjs ${id}`, env).stdout;
  report('a system task starts with everything missing', /is a "system" task/.test(empty) && /\[ \] Spec (for this task )?written/.test(empty) && /\[ \] Approved by a reviewer/.test(empty), empty);
  fs.mkdirSync(path.join(dir, 'studio/bible/systems'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'studio/bible/systems/visitors.md'), `# Visitors (${id})\n\n${'Visitors arrive after the first terrace opens and rate the garden by moss coverage and paths. '.repeat(6)}\n\n## For the next agent\n\nTUNING.visitorRate sets arrivals; the invariant keeps ratings between 0 and 5.\n`);
  edit(dir, 'cartridges/example-sim/qa.mjs', (s) => `${s}\n// visitors scenario\n`);
  edit(dir, 'cartridges/example-sim/index.mjs', (s) => s.replace('startCredits: 1500,', 'startCredits: 1550,'));
  run(dir, 'node qa/check-golden.mjs --update');
  run(dir, 'node qa/check-regressions.mjs --update');
  run(dir, 'node qa/playtest.mjs --stage 1 --quiet');
  git('add -A');
  git(`commit -q -m visitors --no-verify --trailer "Studio-Task: ${id}"`);
  // 2.58.0 (PU-34): a verify counts only for the commit it ran on, with a clean tree.
  fs.writeFileSync(path.join(dir, '.studio/gates-last.json'), JSON.stringify({ at: new Date(Date.now() + 5000).toISOString(), head: git('rev-parse HEAD').stdout.trim(), dirty: false, rows: [{ id: 'golden', required: true, ok: true }] }));
  fs.writeFileSync(path.join(dir, 'studio/reviews/2026-10-20-visitors.md'), `model-family: claude\nimplementer-family: anthropic\n\nReview of ${id}: rates look right. Verdict: approve.\n`);
  const same = run(dir, `node harness/done-check.mjs ${id}`, env).stdout;
  report('a system task refuses an approval from the builder\'s own model family', /\[x\] Spec ends with a hand-off/.test(same) && /\[x\] Goldens updated/.test(same) && /\[ \] Approved by a reviewer from another model family: the approving review is from the same model family/.test(same), same);
  report('the reviewer gate refuses a review from the same family', run(dir, 'node scripts/check-reviewer.mjs').status !== 0);
  fs.writeFileSync(path.join(dir, 'studio/reviews/2026-10-20-visitors.md'), `model-family: gpt-5\nimplementer-family: anthropic\n\nReview of ${id}: rates look right. Verdict: approve.\n`);
  const ok = run(dir, `node harness/done-check.mjs ${id}`, env);
  report('a system task is done with every piece and a cross-family approval', ok.status === 0 && /Ready to finish/.test(ok.stdout), ok.stdout);
}

// Renderer budget: measured in Chromium when a build is running; the static scan still catches too many lights.
{
  const dir = copyRepo();
  const pages = fs.mkdtempSync(path.join(tmpRoot, 'render-'));
  const page = (calls) => `<!doctype html><title>r</title><script>function f(){window.__render={drawCalls:${calls},triangles:1000,lights:2,frameMs:4};requestAnimationFrame(f)}f()</script>`;
  fs.writeFileSync(path.join(pages, 'over.html'), page(420));
  fs.writeFileSync(path.join(pages, 'under.html'), page(40));
  fs.writeFileSync(path.join(pages, 'blank.html'), '<!doctype html><title>b</title>');
  const chromium = process.env.PLAYWRIGHT_CHROMIUM || ['/opt/pw-browsers/chromium'].find((p) => fs.existsSync(p));
  const env = { RENDER_SAMPLE_MS: '300', ...(chromium ? { PLAYWRIGHT_CHROMIUM: chromium } : {}) };
  const url = (f) => pathToFileURL(path.join(pages, f)).href;
  // Measured runs use this checkout, which has Playwright installed; the copies don't carry node_modules.
  const probe = run(root, 'node scripts/check-renderer-budget.mjs', { ...env, RENDER_URL: url('under.html') });
  if (/PASS measured/.test(probe.stdout)) {
    const over = run(root, 'node scripts/check-renderer-budget.mjs', { ...env, RENDER_URL: url('over.html') });
    report('the measured renderer budget fails a frame over the draw-call budget', over.status !== 0 && /drawCalls 420 > 150/.test(over.stderr), over.stderr + over.stdout);
    const blank = run(root, 'node scripts/check-renderer-budget.mjs', { ...env, RENDER_URL: url('blank.html'), RENDER_READY_MS: '1500' });
    report('a page without window.__render fails instead of passing', blank.status !== 0 && /never set window\.__render/.test(blank.stderr), blank.stderr);
  } else {
    console.log(`[selftest] SKIP measured renderer budget (no browser here: ${probe.stdout.trim().split('\n')[0]})`);
  }
  fs.writeFileSync(path.join(dir, 'cartridges/example-sim/lights.mjs'), Array.from({ length: 9 }, () => 'new PointLight();').join('\n'));
  const scan = run(dir, 'node scripts/check-renderer-budget.mjs', env);
  report('the static renderer scan fails nine lights', scan.status !== 0 && /9 lights > 8/.test(scan.stderr), scan.stderr);
}

// First real run (Jed, v2.14.0): fixes for what blocked or misled it.
{
  const dir = copyRepo();
  const env = { STUDIO_PRODUCER_NAME: 'prod-1' };
  const git = (cmd) => run(dir, `git -c user.name=selftest -c user.email=selftest@example.com ${cmd}`);
  git('init -q');
  git('add -A');
  git('commit -q -m init --no-verify');
  // B2: new-game makes the new game the one the gates test.
  const ng = run(dir, 'node scripts/new-game.mjs night-shift', env);
  const game = fs.existsSync(path.join(dir, 'studio/game.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'studio/game.json'), 'utf8')) : {};
  const gates = run(dir, 'node scripts/run-gates.mjs --only golden', env).stdout;
  report('new-game writes studio/game.json and the gate run names the game it tested', ng.status === 0 && game.cartridge === 'night-shift' && /testing the game "night-shift" \(from studio\/game\.json\)/.test(gates), ng.stdout + ng.stderr + gates);
  fs.rmSync(path.join(dir, 'studio/game.json'));
  // B13: intake takes references as a newline string; then sign.
  const answers = JSON.parse(fs.readFileSync(path.join(dir, 'studio/templates/intake-example.json'), 'utf8'));
  answers.answers.references = 'Viridi: tending\nIslanders: placement';
  fs.writeFileSync(path.join(dir, 'answers.json'), JSON.stringify(answers));
  const intake = run(dir, 'node harness/intake.mjs --answers answers.json', env);
  report('intake accepts "one per line" answers as a newline string', intake.status === 0 && /- Islanders: placement/.test(fs.readFileSync(path.join(dir, 'studio/bible/BIBLE.md'), 'utf8')), intake.stdout + intake.stderr);
  run(dir, 'node harness/bible.mjs sign --by jed --via "discord message 42"', env);
  const signed = JSON.parse(fs.readFileSync(path.join(dir, 'studio/bible/bible.json'), 'utf8')).signed;
  report('sign records where a remote approval came from', signed?.via === 'discord message 42', JSON.stringify(signed));
  // B12: the refusal names the word; --not-layer lets a different meaning through, logged.
  const mood = run(dir, 'node harness/task.mjs add "Renderer: add a mood meter to each room" --phase 1 --serves pillar:Calm', env);
  report('a scope refusal names the phrase that matched and the layer', mood.status !== 0 && /the word "add a mood meter"/.test(mood.stderr) && /--not-layer npc-needs/.test(mood.stderr), mood.stderr);
  const ok = run(dir, 'node harness/task.mjs add "Renderer: give each room its own mood" --phase 1 --serves pillar:Calm --not-layer npc-needs', env);
  report('--not-layer queues it and tells the Director', ok.status === 0 && /task\.scope_override/.test(fs.readFileSync(path.join(dir, '.studio/events.jsonl'), 'utf8')), ok.stdout + ok.stderr);
  // B7: changing the design after signing holds new build work until a person re-signs.
  answers.answers.verb = 'fight floor by floor';
  fs.writeFileSync(path.join(dir, 'answers.json'), JSON.stringify(answers));
  run(dir, 'node harness/intake.mjs --answers answers.json', env);
  const held = run(dir, 'node harness/task.mjs add "Build the stairwell" --phase 1 --serves pillar:Calm', env);
  report('a design change after signing holds new build tasks until a person re-signs', held.status !== 0 && /changed after jed signed it \(verb\)/.test(held.stderr), held.stderr);
  run(dir, 'node harness/bible.mjs sign --by jed', env);
  report('re-signing lets build work go on and keeps the earlier signature in history', run(dir, 'node harness/task.mjs add "Build the stairwell" --phase 1 --serves pillar:Calm', env).status === 0 && JSON.parse(fs.readFileSync(path.join(dir, 'studio/bible/bible.json'), 'utf8')).signHistory?.length === 1);
  const noDecision = run(dir, 'node harness/bible.mjs pillars set "A: x" "B: y" "C: z" --by jed', env);
  fs.mkdirSync(path.join(dir, 'studio/decisions'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'studio/decisions/pillars.md'), 'Why the pillars changed.\n');
  const pillars = run(dir, 'node harness/bible.mjs pillars set "Fight: rules out stealth" "Ride: rules out menus" "Floors: rules out open world" --by jed --decision studio/decisions/pillars.md', env);
  report('pillars change only with a person and a decision file, and the Bible is signed with them', noDecision.status !== 0 && pillars.status === 0 && JSON.parse(fs.readFileSync(path.join(dir, 'studio/bible/bible.json'), 'utf8')).pillars[0].name === 'Fight', pillars.stdout + pillars.stderr);
  // task next by role, task show.
  const next = JSON.parse(run(dir, 'node harness/task.mjs next --role producer --agent prod-1', env).stdout || '{}');
  report('task next gives the caller its own role\'s work', next.role === 'producer', JSON.stringify(next));
  const show = run(dir, `node harness/task.mjs show ${next.id}`, env);
  report('task show prints a task with its lane, type and checklist', show.status === 0 && /"lane": "waiting"/.test(show.stdout) && /"checklist"/.test(show.stdout), show.stdout.slice(0, 400));
  // B9: work committed before a hand-back counts when someone else closes the task.
  const t = JSON.parse(run(dir, 'node harness/task.mjs add "Docs: write the floor list" --role producer', env).stdout).id;
  run(dir, `node harness/task.mjs start ${t} --agent writer-1`, env);
  fs.writeFileSync(path.join(dir, 'docs/FLOORS.md'), '# Floors\n\nF1 Cubicle Hell.\n');
  git('add docs/FLOORS.md');
  git(`commit -q -m floors --no-verify --trailer "Studio-Task: ${t}"`);
  run(dir, `node harness/task.mjs pause ${t} --agent writer-1 --note "written, needs closing"`, env);
  run(dir, `node harness/task.mjs start ${t} --agent writer-2`, env);
  const dc = run(dir, `node harness/done-check.mjs ${t}`, env).stdout;
  report('done-check counts commits tagged with the task from before a hand-back', /\[x\] Docs changed for this task/.test(dc), dc);
  // Forcing with a person's acceptance is logged, without a follow-up task.
  const forced = run(dir, `node harness/task.mjs done ${t} --agent writer-2 --force --reason "fixture forced" --accepted-by jed`, env);
  report('a forced done accepted by a person is logged without a follow-up task', forced.status === 0 && /accepted by jed/.test(forced.stderr) && !/Check forced done/.test(fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8')), forced.stdout + forced.stderr);
  report('npm run idea -- --help prints how to use it', /Usage: npm run idea/.test(run(dir, 'node harness/ideas.mjs --help', env).stdout));
}

// The launcher: agents are started, watched and cleaned up; the mode's caps and MAX SPEED decide how many run.
{
  const dir = copyRepo();
  const git = (cmd) => run(dir, `git -c user.name=selftest -c user.email=selftest@example.com ${cmd}`);
  git('init -q');
  git('add -A');
  git('commit -q -m init --no-verify');
  const env = { STUDIO_PRODUCER_NAME: 'prod-1', STUDIO_HEARTBEAT_SEC: '1', STUDIO_BUILDER_CMD: 'node qa/fixtures/agents/fake-agent.mjs {agent} T-003 quota' };
  const died = run(dir, 'node harness/agent.mjs start --role builder --agent builder-9 --model fake-1', env);
  const q = fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8');
  const patch = path.join(dir, '.studio/wip/T-003-builder-9.patch');
  const ev = fs.readFileSync(path.join(dir, '.studio/events.jsonl'), 'utf8');
  report('an agent that runs out of quota mid-task is cleaned up: task handed back, work saved as a patch, claims freed', died.status !== 0 && /usage limit/.test(died.stdout + ev) && /## BACKLOG[\s\S]*T-003/.test(q) && fs.existsSync(patch) && /docs\/fake\/builder-9\.md/.test(fs.readFileSync(patch, 'utf8')) && !fs.readdirSync(path.join(dir, '.studio/locks')).some((f) => /builder-9/.test(fs.readFileSync(path.join(dir, '.studio/locks', f), 'utf8'))), died.stdout + died.stderr + q);
  report('the launcher reports session start and end, with the tokens the agent printed', /agent\.session\.start/.test(ev) && /"type":"agent\.session\.end"[^\n]*"tokensIn":1200/.test(ev), ev.split('\n').filter((l) => /agent\.session/.test(l)).join('\n'));
  fs.rmSync(path.join(dir, 'docs/fake'), { recursive: true, force: true });
  // 2.58.0 (PU-40, P-051): the limit above is now kept for this custom command's program, so a relaunch waits for its
  // reset; the rest of this block runs as if that reset had passed.
  const held = run(dir, 'node harness/agent.mjs start --role builder --agent builder-7 --model fake-1', { ...env, STUDIO_BUILDER_CMD: 'node qa/fixtures/agents/fake-agent.mjs {agent} T-003 ok' });
  report('2.58.0 (PU-40): right after a custom command hits its usage limit, the next start of that command waits for the reset', held.status !== 0 && /budget stop/.test(held.stdout + held.stderr) && /custom:fake-agent/.test(held.stdout + held.stderr), held.stdout + held.stderr);
  fs.rmSync(path.join(dir, '.studio/tool-quota.json'), { force: true });
  const ok = run(dir, 'node harness/agent.mjs start --role builder --agent builder-8 --model fake-1', { ...env, STUDIO_BUILDER_CMD: 'node qa/fixtures/agents/fake-agent.mjs {agent} T-003 ok' });
  report('an agent that finishes ends cleanly and keeps its work', ok.status === 0 && /## DONE[\s\S]*T-003/.test(fs.readFileSync(path.join(dir, 'studio/DONE.md'), 'utf8')), ok.stdout + ok.stderr);
  // Caps: Precise allows one builder; MAX SPEED doubles it.
  const waitEnv = { ...env, STUDIO_BUILDER_CMD: 'node qa/fixtures/agents/fake-agent.mjs {agent} T-004 wait' };
  run(dir, 'node harness/mode.mjs set precise --by hatch', env);
  run(dir, 'node harness/agent.mjs start --role builder --agent builder-1 --model fake-1 --detach', waitEnv);
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 * SLOW && !/running/.test(run(dir, 'node harness/agent.mjs list', env).stdout)) spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},300)']);
  const second = run(dir, 'node harness/agent.mjs start --role builder --agent builder-2 --model fake-1 --detach', waitEnv);
  report('the mode caps how many agents of a role run at once', second.status !== 0 && /allows 1/.test(second.stderr), second.stdout + second.stderr);
  run(dir, 'node harness/mode.mjs boost on --by hatch --hours 1', env);
  const boosted = run(dir, 'node harness/agent.mjs start --role builder --agent builder-2 --model fake-1 --detach', waitEnv);
  report('MAX SPEED raises the caps', boosted.status === 0, boosted.stdout + boosted.stderr);
  run(dir, 'node harness/task.mjs stop --by hatch', env);
  report('no agent starts while the studio is stopped', run(dir, 'node harness/agent.mjs start --role builder --agent builder-3 --model fake-1', waitEnv).status !== 0);
  run(dir, 'node harness/task.mjs resume --by hatch', env);
  for (const a of ['builder-1', 'builder-2']) run(dir, `node harness/agent.mjs stop ${a}`, env);
}

// The supervisor keeps the studio running: one task per session, the next session when one ends, a stop
// time, lanes so builders never share a folder, and tools out of quota skipped until they reset.
{
  const dir = copyRepo();
  const git = (cmd) => run(dir, `git -c user.name=selftest -c user.email=selftest@example.com ${cmd}`);
  git('init -q');
  git('add -A');
  git('commit -q -m init --no-verify');
  const env = { STUDIO_PRODUCER_NAME: 'prod-1', STUDIO_HEARTBEAT_SEC: '1', STUDIO_SUPERVISOR_SEC: '1', STUDIO_BUILDER_CMD: 'node qa/fixtures/agents/fake-agent.mjs {agent} {task} ok' };
  for (const t of ['Tidy the HUD', 'Tidy the menu', 'Tidy the end screen']) run(dir, `node harness/task.mjs add "${t}" --role builder`, env);
  const sup = run(dir, `node harness/supervisor.mjs --no-hub --until ${secs(9)} --foreground`, env);
  const st = JSON.parse(fs.readFileSync(path.join(dir, '.studio/supervisor.json'), 'utf8'));
  report('the supervisor starts a fresh agent per task, one after another, and stops at its time', st.status === 'stopped' && /time is up/.test(st.stopReason) && st.sessions >= 2 && st.tasksDone >= 2, sup.stdout + sup.stderr + JSON.stringify(st));
  report('npm run studio:status says what it did', /sessions started: \d+; tasks done: \d+/i.test(run(dir, 'node harness/supervisor.mjs status', env).stdout));
  // Lanes: two builders at once, each holding its own folder.
  run(dir, 'node harness/mode.mjs set fast --by hatch', env);
  run(dir, 'node harness/task.mjs add "Floor one props" --role builder --lane docs/lane-a', env);
  run(dir, 'node harness/task.mjs add "Floor two props" --role builder --lane docs/lane-b', env);
  const wenv = { ...env, STUDIO_BUILDER_CMD: 'node qa/fixtures/agents/fake-agent.mjs {agent} {task} wait' };
  const child = spawn(process.execPath, ['harness/supervisor.mjs', '--no-hub', '--lanes', 'auto', '--until', '6s', '--foreground'], { cwd: dir, env: { ...CLEAN_ENV, STUDIO_CARTRIDGE: '', AGENT_EVENTS_FILE: '', ...wenv }, stdio: 'ignore' });
  const t0 = Date.now();
  let lanes = [];
  while (Date.now() - t0 < 8000 * SLOW && lanes.length < 2) {
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},400)']);
    lanes = fs.readdirSync(path.join(dir, '.studio/locks')).map((f) => fs.readFileSync(path.join(dir, '.studio/locks', f), 'utf8')).filter((x) => /path:docs\/lane-[ab]/.test(x));
  }
  report('with --lanes auto, each lane gets its own agent holding that folder', lanes.length === 2, lanes.join('\n'));
  await new Promise((r) => child.on('exit', r));
  for (const s of fs.readdirSync(path.join(dir, '.studio/agents')).filter((f) => f.endsWith('.json'))) run(dir, `node harness/agent.mjs stop ${s.replace(/\.json$/, '')}`, env);
  // Quota: a tool that ran out is skipped until its reset; its lanes go to the next tool.
  fs.writeFileSync(path.join(dir, 'q.mjs'), "import { markExhausted, pickTool, exhaustedUntil } from './harness/budget.mjs';\nmarkExhausted('claude', \"You've hit your usage limit. Try again at 6:12 AM.\");\nconsole.log(JSON.stringify({ until: exhaustedUntil('claude'), next: pickTool('claude') }));\n");
  const q = JSON.parse(run(dir, 'node q.mjs', env).stdout);
  report('a tool out of quota is skipped until its reset time, for the next tool in the order', /T\d{2}:12/.test(new Date(q.until).toTimeString().slice(0, 5).replace(/^(\d{2}):(\d{2})$/, 'T$1:$2')) && q.next === 'codex', JSON.stringify(q));
  run(dir, 'node harness/budget.mjs set codex --weekly 1000 --reset monday --target 100%', env);
  report('npm run budget shows tokens used against the week\'s target', /codex: [\d,]+ tokens in the last 5 h, [\d,]+ this week, cache reads counted at [\d.]+x \([\d,]+ read\) \(\d+% of 1,000; target \d+% by now/.test(run(dir, 'node harness/budget.mjs', env).stdout), run(dir, 'node harness/budget.mjs', env).stdout);
}

// Hiring into departments, and the dev hacker: trick cards that reach the Producer without holding anything up.
{
  const dir = copyRepo();
  const env = { STUDIO_PRODUCER_NAME: 'prod-1', STUDIO_HEARTBEAT_SEC: '1' };
  report('the dev hacker and the missing department roles have role cards', ['dev-hacker', 'sound-designer', 'composer', 'artist', 'art-director'].every((r) => fs.existsSync(path.join(dir, `studio/roles/${r}.md`))));
  const op = run(dir, 'node harness/division.mjs open hacks --reason "the game hitches between floors" --by hatch', env);
  report('a division opens with a reason, logged', op.status === 0 && /Dev Hacker Lab is open/.test(op.stdout) && /opened Dev Hacker Lab: the game hitches/.test(fs.readFileSync(path.join(dir, 'studio/decisions/divisions.md'), 'utf8')), op.stdout + op.stderr);
  run(dir, 'node harness/watch.mjs', env);
  spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},500)']);
  run(dir, 'node harness/watch.mjs', env);
  const q1 = fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8');
  report('with the lab open, the watcher queues one low-priority trick hunt for the dev hacker', (q1.match(/\[P3\] \(`dev-hacker`\) — Trick hunt:/g) || []).length === 1, q1.split('\n').filter((l) => /Trick/.test(l)).join('\n'));
  const hunt = (q1.match(/\*\*(T-\d+)\*\* \[P3\] \(`dev-hacker`\)/) || [])[1];
  report('a trick card must say when not to use it', /--avoid-if/.test(run(dir, 'node harness/tricks.mjs propose "Elevator hides the load" --problem "F3 hitches" --trick "load during the ride" --fits "a building" --proof "frame time"', env).stderr));
  run(dir, `node harness/task.mjs start ${hunt} --agent dev-hacker-1`, env);
  run(dir, 'node harness/tricks.mjs propose "Elevator ride hides the next floor loading" --problem "F3 hitches 400 ms when its models load" --trick "Start loading floor N+1 when the doors close; open them when it is ready" --fits "Every level is a floor of one building; the ride is already in the fiction" --avoid-if "levels are not separated by a ride, or loads are already under a frame" --proof "longest frame on a floor change, browser check, before vs after" --by dev-hacker-1', env);
  const hdone = run(dir, `node harness/task.mjs done ${hunt} --agent dev-hacker-1`, env);
  report('a trick hunt is done when a card is written', hdone.status === 0, hdone.stdout + hdone.stderr);
  run(dir, 'node harness/watch.mjs', env);
  const q2 = fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8');
  report('new trick cards reach the Producer in one batch', /\(`producer`\) — Tricks: 1 new from the dev hacker \(K-001\)/.test(q2), q2.split('\n').filter((l) => /Trick/.test(l)).join('\n'));
  const ad = run(dir, 'node harness/tricks.mjs adopt K-001 --by prod-1', env);
  report('the Producer adopts a card: build work that names the trick and how to prove it', ad.status === 0 && /Build trick K-001: Elevator ride hides the next floor loading \(prove it: longest frame/.test(fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8')), ad.stdout + ad.stderr);
  report('a hunt that finds nothing is a fine result', run(dir, 'node harness/tricks.mjs none "frame times are flat; nothing measured to fix"', env).status === 0 && /nothing worth doing now/.test(fs.readFileSync(path.join(dir, 'studio/tricks/HUNTS.md'), 'utf8')));
  // Hiring: into a division, seated there whatever its name; paused hands the task back.
  const tid = JSON.parse(run(dir, 'node harness/task.mjs add "Footstep sounds for floor one" --role sound-designer', env).stdout).id;
  const henv = { ...env, STUDIO_SOUND_DESIGNER_CMD: 'node qa/fixtures/agents/fake-agent.mjs {agent} {task} wait' };
  const hire = run(dir, `node harness/agent.mjs hire --role sound-designer --agent zed-1 --division sound --task ${tid} --by hatch --note "keep it subtle" --detach`, henv);
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 * SLOW && !/zed-1/.test(run(dir, 'node harness/lock.mjs list', env).stdout)) spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},300)']);
  fs.writeFileSync(path.join(dir, 'hudjson.mjs'), "import { buildHudState } from './harness/hud.mjs';\nconsole.log(JSON.stringify(buildHudState()));\n");
  const hud = JSON.parse(run(dir, 'node hudjson.mjs', env).stdout || '{}');
  const zed = (hud.agents || []).find((a) => a.name === 'zed-1');
  report('an agent hired into a division sits in that room, and the room opens', hire.status === 0 && zed?.room === 'sound' && (hud.divisions || []).find((d) => d.id === 'sound')?.active === true && /Note from hatch[^\n]*:\n\| keep it subtle/.test(fs.readFileSync(path.join(dir, '.studio/kickoff/zed-1.md'), 'utf8')), hire.stdout + hire.stderr + JSON.stringify(zed));
  const pz = run(dir, 'node harness/agent.mjs pause zed-1 --note "wrong floor"', env);
  report('pausing an agent hands its task back with the note', pz.status === 0 && new RegExp(`## BACKLOG[\\s\\S]*${tid}`).test(fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8')), pz.stdout + pz.stderr);
  report('npm run agent -- logs shows an agent\'s output', run(dir, 'node harness/agent.mjs logs zed-1', env).status === 0);
  fs.writeFileSync(path.join(dir, 'studio/budget.json'), JSON.stringify({ producerMayHireUpTo: 0 }));
  const over = run(dir, 'node harness/agent.mjs hire --role builder --by prod-1 --detach', { ...env, STUDIO_BUILDER_CMD: 'node -e 0' });
  const asks = fs.existsSync(path.join(dir, 'studio/asks')) ? fs.readdirSync(path.join(dir, 'studio/asks')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, 'studio/asks', f), 'utf8'))) : [];
  report('past its hiring limit the Producer asks the game dev instead of hiring', over.status === 2 && asks.some((a) => a.action?.type === 'hire' && /Hire builder-/.test(a.question)), over.stdout + over.stderr);
  const dh = run(dir, 'node harness/agent.mjs hire --role builder --by director-1 --detach', { ...env, STUDIO_BUILDER_CMD: 'node -e 0' });
  fs.mkdirSync(path.join(dir, '.studio'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.studio/harness-frozen'), 'test');
  const fz = run(dir, 'node harness/agent.mjs hire --role builder --lane harness/ --by hatch --detach', { ...env, STUDIO_BUILDER_CMD: 'node -e 0' });
  fs.rmSync(path.join(dir, '.studio/harness-frozen'));
  report('the Director never hires, and a frozen clone never hires into the harness', dh.status !== 0 && /Director does not hire/.test(dh.stderr + dh.stdout) && fz.status !== 0 && /harness is frozen/.test(fz.stderr + fz.stdout), dh.stdout + dh.stderr + fz.stdout + fz.stderr);
}

// 2.24, from run #1 (Next Floor) and Gemini's Solar Outpost run: only real limit errors count as out of
// quota, dependencies and parked tasks, a stop's cooldown, builders never share files, names never
// repeat, a supervisor that stops after two identical failures, a browser contract a renderer can't
// skip, a frozen harness that stays unedited, and "throw it all away and restart" with an undo.
{
  const dir = copyRepo();
  const git = (cmd) => run(dir, `git -c user.name=selftest -c user.email=selftest@example.com ${cmd}`);
  git('init -q');
  git('add -A');
  git('commit -q -m init --no-verify');
  const pause = (ms) => spawnSync(process.execPath, ['-e', `setTimeout(()=>{},${ms})`]);
  const env = { STUDIO_PRODUCER_NAME: 'prod-1', STUDIO_HEARTBEAT_SEC: '1', STUDIO_SUPERVISOR_SEC: '1' };
  const id = (cmd) => JSON.parse(run(dir, cmd, env).stdout).id;
  const quotaFile = path.join(dir, '.studio/tool-quota.json');
  // Quota: a normal session that mentions rate limits and quota doesn't mark the tool out.
  const tq = id('node harness/task.mjs add "Tidy the HUD labels" --role builder');
  run(dir, `node harness/agent.mjs start --role builder --agent chat-1 --task ${tq}`, { ...env, STUDIO_BUILDER_CMD: 'node qa/fixtures/agents/fake-agent.mjs {agent} {task} chatty' });
  report('a normal session that mentions rate limits and quota leaves the tool usable (run #1 idled for an hour)', !fs.existsSync(quotaFile) || !JSON.parse(fs.readFileSync(quotaFile, 'utf8')).claude, fs.existsSync(quotaFile) ? fs.readFileSync(quotaFile, 'utf8') : '');
  fs.writeFileSync(path.join(dir, 'pt.mjs'), "import { providerTrouble as p } from './harness/agent.mjs';\nconst c = [[p('{\"type\":\"result\",\"is_error\":true,\"result\":\"Claude AI usage limit reached|1792600000\"}', 0)?.kind, 'quota'], [p('Error: 429 Too Many Requests', 1)?.kind, 'quota'], [p('read docs about quota exceeded handling\\nexit', 1)?.kind, undefined], [p('{\"type\":\"result\",\"is_error\":false,\"result\":\"fixed the rate limit bug\"}', 0)?.kind, undefined], [p('Invalid API key · Please run /login', 1)?.kind, 'auth']];\nconsole.log(c.every(([a, b]) => a === b), JSON.stringify(c));\n");
  report('only a real limit or auth error counts, read from the end of a failed session or an error result', /^true/.test(run(dir, 'node pt.mjs', env).stdout), run(dir, 'node pt.mjs', env).stdout);
  const tq2 = id('node harness/task.mjs add "Tidy the menu" --role builder');
  run(dir, `node harness/agent.mjs start --role builder --agent q-1 --task ${tq2}`, { ...env, STUDIO_QUOTA_SKIP: 'off', STUDIO_BUILDER_CMD: 'node qa/fixtures/agents/fake-agent.mjs {agent} {task} quota' });
  report('STUDIO_QUOTA_SKIP=off never skips a tool for quota (usage is watched outside the harness)', !fs.existsSync(quotaFile) || !JSON.parse(fs.readFileSync(quotaFile, 'utf8')).claude);
  // Dependencies and parking.
  const a = id('node harness/task.mjs add "Merge round 15" --role builder');
  const b = id(`node harness/task.mjs add "Playtest the merged build" --role builder --after ${a}`);
  run(dir, `node harness/task.mjs pause ${tq2} --force --note x`, env);
  const sb = run(dir, `node harness/task.mjs start ${b} --agent qa-x`, env);
  report('a task added --after another waits until that one is done', sb.status !== 0 && new RegExp(`waits for ${a}`).test(sb.stderr), sb.stdout + sb.stderr);
  run(dir, `node harness/task.mjs park ${a} --by director-1 --why "after the Bible change"`, env);
  const nx = run(dir, 'node harness/task.mjs next --role builder', env).stdout;
  report('a parked task is never picked, and what waits on it waits too', !new RegExp(`"${a}"|"${b}"`).test(nx), nx);
  run(dir, `node harness/task.mjs unpark ${a} --by prod-1`, env);
  run(dir, `node harness/task.mjs done ${a} --agent prod-1 --force --reason "selftest forced" --accepted-by selftest`, env);
  report('once the task it waits for is done, the waiting task can start', run(dir, `node harness/task.mjs start ${b} --agent qa-x`, env).status === 0);
  // A stopped agent's task doesn't restart for a while.
  const c = id('node harness/task.mjs add "Floor two lighting" --role builder');
  run(dir, `node harness/agent.mjs start --role builder --agent stop-1 --task ${c} --detach`, { ...env, STUDIO_BUILDER_CMD: 'node qa/fixtures/agents/fake-agent.mjs {agent} {task} wait' });
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 * SLOW && !/stop-1/.test(run(dir, 'node harness/lock.mjs list', env).stdout)) pause(300);
  const st = run(dir, 'node harness/agent.mjs stop stop-1 --by jed', env);
  // Wait for the launcher to hand the task back (slower on Windows), then try to restart it.
  const t2 = Date.now();
  while (Date.now() - t2 < 15000 * SLOW && /stop-1/.test(run(dir, 'node harness/lock.mjs list', env).stdout)) pause(400);
  const again = run(dir, `node harness/task.mjs start ${c} --agent other-1`, env);
  report('after agent stop, its task can\'t restart straight away (run #1: it restarted within seconds)', st.status === 0 && /won't restart before/.test(st.stdout) && again.status !== 0 && /can restart after/.test(again.stderr), st.stdout + again.stdout + again.stderr);
  run(dir, `node harness/task.mjs done ${c} --agent prod-1 --force --reason "selftest forced" --accepted-by selftest`, env);
  run(dir, `node harness/task.mjs done ${b} --agent qa-x --force --reason "selftest forced" --accepted-by selftest`, env);
  // Builders never share files: without lanes one builder holds the whole game; with lanes, one per lane.
  run(dir, 'node harness/mode.mjs set fast --by hatch', env);
  for (const t of ['Fix the elevator doors', 'Fix the gun direction']) run(dir, `node harness/task.mjs add "${t}" --role builder`, env);
  const wenv = { ...env, STUDIO_BUILDER_CMD: 'node qa/fixtures/agents/fake-agent.mjs {agent} {task} wait' };
  run(dir, `node harness/supervisor.mjs --no-hub --until ${secs(5)} --foreground`, wenv);
  const live = () => JSON.parse(run(dir, 'node -e "import(\'./harness/agent.mjs\').then(m=>console.log(JSON.stringify(m.sessions().filter(s=>s.running).map(s=>s.agent))))"', env).stdout || '[]');
  const one = live();
  report('two builders without lanes never run at once, even in a fast pace (run #1: they edited the same files)', one.length === 1, JSON.stringify(one));
  for (const s of one) run(dir, `node harness/agent.mjs stop ${s}`, env);
  // Wait for the launcher to hand the stopped agent's task back.
  const t1 = Date.now();
  let q0 = JSON.parse(run(dir, 'node harness/task.mjs list', env).stdout);
  while (Date.now() - t1 < 10000 * SLOW && (live().length || q0.backlog.filter((t) => /^Fix the/.test(t.title)).length < 2)) {
    pause(400);
    q0 = JSON.parse(run(dir, 'node harness/task.mjs list', env).stdout);
  }
  const [l1, l2] = q0.backlog.filter((t) => /^Fix the/.test(t.title)).map((t) => t.id);
  run(dir, `node harness/task.mjs done ${tq2} --agent prod-1 --force --reason "selftest forced" --accepted-by selftest`, env);
  run(dir, `node harness/task.mjs lane ${l1} docs/lane-c --by prod-1`, env);
  run(dir, `node harness/task.mjs lane ${l2} docs/lane-d --by prod-1`, env);
  // Other waiting builder tasks have no lane, so one of them would take the whole game: park them.
  for (const t of JSON.parse(run(dir, 'node harness/task.mjs list', env).stdout).backlog.filter((x) => x.role === 'builder' && ![l1, l2].includes(x.id))) run(dir, `node harness/task.mjs park ${t.id} --by prod-1 --why "not this round"`, env);
  fs.writeFileSync(path.join(dir, 'studio/task-holds.json'), JSON.stringify({ tasks: Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(dir, 'studio/task-holds.json'), 'utf8')).tasks).map(([k, v]) => [k, { ...v, cooldownUntil: undefined }])) }));
  run(dir, `node harness/supervisor.mjs --no-hub --until ${secs(5)} --foreground`, wenv);
  const two = live();
  report('task lane gives each builder its own folder, and then they run side by side', two.length === 2, `l1=${l1} l2=${l2} q0=${JSON.stringify(q0.backlog.map((t) => t.id))} inprog=${JSON.stringify(q0.inProgress.map((t) => t.id))} ` + JSON.stringify(two) + JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, '.studio/supervisor.json'), 'utf8')).last) + run(dir, 'node harness/task.mjs holds', env).stdout + JSON.stringify(JSON.parse(run(dir, 'node harness/task.mjs list', env).stdout).backlog.map((t) => t.id + t.role)));
  const names = fs.readdirSync(path.join(dir, '.studio/agents')).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  report('agent names never repeat across supervisor restarts', names.length === new Set(names).size && names.filter((n) => /^builder-s\d+$/.test(n)).length >= 3, names.join(', '));
  for (const s of two) run(dir, `node harness/agent.mjs stop ${s}`, env);
  pause(1500);
  // Two sessions ending the same bad way: stop starting, and ask once.
  for (const t of ['Polish one', 'Polish two', 'Polish three', 'Polish four']) run(dir, `node harness/task.mjs add "${t}" --role rnd`, env);
  run(dir, `node harness/supervisor.mjs --no-hub --until ${secs(8)} --foreground`, { ...env, STUDIO_RND_CMD: 'node -e "process.exit(127)"' });
  const sup = JSON.parse(fs.readFileSync(path.join(dir, '.studio/supervisor.json'), 'utf8'));
  const rndRuns = fs.readdirSync(path.join(dir, '.studio/agents')).filter((f) => /^rnd-s\d+\.json$/.test(f)).length;
  fs.writeFileSync(path.join(dir, 'hudjson.mjs'), "import { buildHudState } from './harness/hud.mjs';\nconsole.log(JSON.stringify(buildHudState()));\n");
  report('after two sessions in a row end with exit 127, the supervisor stops starting and says why (run #1 looped)', sup.halted?.code === 127 && /wasn't found/.test(sup.halted.why) && rndRuns === 2, JSON.stringify(sup.halted) + ` runs=${rndRuns}`);
  // Install: the login job gets this terminal's PATH and HOME, and the node on the PATH.
  fs.writeFileSync(path.join(dir, 'plist.mjs'), "import { launchdPlist } from './harness/supervisor.mjs';\nconsole.log(launchdPlist({ label: 'com.studio.x', node: '/usr/local/bin/node', args: ['s.mjs', '--foreground'], env: { PATH: '/Users/j/.local/bin:/usr/bin', HOME: '/Users/j' } }));\n");
  const pl = run(dir, 'node plist.mjs', env).stdout;
  report('the macOS login job carries PATH and HOME, so claude in ~/.local/bin is found', /<key>PATH<\/key><string>\/Users\/j\/\.local\/bin:\/usr\/bin<\/string>/.test(pl) && /<key>HOME<\/key><string>\/Users\/j<\/string>/.test(pl) && /<string>\/usr\/local\/bin\/node<\/string>/.test(pl), pl.slice(0, 600));
  // Chromium on Windows: Chrome and Edge are tried after Playwright's own.
  fs.writeFileSync(path.join(dir, 'chr.mjs'), "import { chromiumCandidates } from './qa/chromium.mjs';\nconsole.log(chromiumCandidates({}, 'win32').map((c) => c.label).join(' | '));\n");
  report('on Windows the browser checks also try Chrome and Edge', /Playwright's Chromium.*Chrome \(channel\).*Edge \(channel\)/.test(run(dir, 'node chr.mjs', env).stdout), run(dir, 'node chr.mjs', env).stdout);
  // Reviews without router keys go to an agent CLI from another family.
  fs.writeFileSync(path.join(dir, 'rv.mjs'), "import { reviewerTools } from './harness/review.mjs';\nconsole.log(reviewerTools('claude-opus-5-5', {}).map((t) => t.tool).join(','), reviewerTools('gpt-6', { STUDIO_REVIEWER_TOOL: 'codex' }).map((t) => t.tool).join(','));\n");
  report('with no router keys, a review goes to another family\'s agent CLI, never the builder\'s', run(dir, 'node rv.mjs', env).stdout.trim() === 'codex,agy agy,claude', run(dir, 'node rv.mjs', env).stdout);
  // A renderer folder without a browser contract fails the browser check instead of skipping.
  fs.mkdirSync(path.join(dir, 'cartridges/tin-moon'), { recursive: true });
  fs.copyFileSync(path.join(dir, 'cartridges/example-sim/index.mjs'), path.join(dir, 'cartridges/tin-moon/index.mjs'));
  fs.writeFileSync(path.join(dir, 'cartridges/tin-moon/qa.mjs'), 'export const scenarios = {};\n');
  fs.mkdirSync(path.join(dir, 'game/tin-moon'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'game/tin-moon/index.html'), '<canvas></canvas>\n');
  const bp = run(dir, 'node qa/browser-play.mjs --cartridge tin-moon --no-shots', env);
  report('a game with a renderer but no browser contract fails the browser check (run #1 printed PASS)', bp.status !== 0 && /BROWSER-CONTRACT-MISSING/.test(bp.stdout + bp.stderr), bp.stdout + bp.stderr);
  // Docs: "npm run asset." at the end of a sentence; reviews: a Director drift review in the wrong folder.
  fs.appendFileSync(path.join(dir, 'studio/PLAN.md'), '\nRecorded the pack with npm run asset.\n');
  report('the docs check reads "npm run asset." as the asset script', run(dir, 'node scripts/check-docs.mjs', env).status === 0, run(dir, 'node scripts/check-docs.mjs', env).stdout);
  fs.writeFileSync(path.join(dir, 'studio/reviews/director-drift-2026-10-21.md'), '# Director drift review\n\nVerdict: drifting.\n');
  const rg = run(dir, 'node scripts/check-reviewer.mjs', env);
  report('a Director drift review in studio/reviews/ is pointed to studio/bible/reviews/, not failed', rg.status === 0 && /Move it to studio\/bible\/reviews/.test(rg.stdout), rg.stdout + rg.stderr);
  // A frozen clone whose harness files were edited fails preflight (Gemini loosened two self-tests).
  fs.writeFileSync(path.join(dir, 'frz.mjs'), "import fs from 'node:fs';\nimport { harnessSums } from './scripts/preflight.mjs';\nfs.writeFileSync('.studio/harness-frozen', 'test');\nfs.writeFileSync('.studio/harness-frozen.json', JSON.stringify(harnessSums()));\n");
  run(dir, 'node frz.mjs', env);
  fs.appendFileSync(path.join(dir, 'qa/selftest.mjs'), '\n// loosened\n');
  const pf = run(dir, 'node scripts/preflight.mjs --quick', env);
  report('preflight fails when a frozen harness file was edited, and names it', /harness files unedited since the freeze/i.test(pf.stdout) && /qa\/selftest\.mjs/.test(pf.stdout), pf.stdout.split('\n').filter((l) => /unedited|selftest/i.test(l)).join('\n'));
  fs.rmSync(path.join(dir, '.studio/harness-frozen'));
  fs.rmSync(path.join(dir, '.studio/harness-frozen.json'));
  // Throw it all away and restart: two yeses, everything saved as a tag first, the template kept.
  fs.writeFileSync(path.join(dir, 'studio/game.json'), JSON.stringify({ cartridge: 'tin-moon', name: 'Tin Moon' }));
  fs.mkdirSync(path.join(dir, 'assets/own'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'assets/own/boat.txt'), 'boat\n');
  fs.writeFileSync(path.join(dir, 'qa/golden/tin-moon-1.json'), JSON.stringify({ cartridge: 'tin-moon', seed: 1 }));
  git('add -A');
  git('commit -q -m game --no-verify');
  const once = run(dir, 'node harness/restart.mjs --by hatch --yes', env);
  report('one yes only shows what a restart would remove', once.status === 0 && /cartridges\/tin-moon/.test(once.stdout) && fs.existsSync(path.join(dir, 'cartridges/tin-moon/index.mjs')), once.stdout);
  const rs = run(dir, 'node harness/restart.mjs --by hatch --yes --yes --name "Tin Moon 2"', env);
  const tag = (git('tag -l "archive/*"').stdout || '').trim();
  report('throw it all away and restart: saved as a git tag, then the game is gone and the template stays', rs.status === 0 && /^archive\/tin-moon-/.test(tag) && !fs.existsSync(path.join(dir, 'cartridges/tin-moon')) && !fs.existsSync(path.join(dir, 'game/tin-moon')) && !fs.existsSync(path.join(dir, 'qa/golden/tin-moon-1.json')) && !fs.existsSync(path.join(dir, 'assets/own/boat.txt')) && !fs.existsSync(path.join(dir, 'studio/game.json')) && fs.existsSync(path.join(dir, 'cartridges/example-sim/index.mjs')) && fs.existsSync(path.join(dir, 'studio/roles/builder.md')) && /Tin Moon 2/.test(fs.readFileSync(path.join(dir, 'studio/PLAN.md'), 'utf8')), rs.stdout + rs.stderr + tag);
  report('the restart can be undone from its tag', git(`show ${tag}:cartridges/tin-moon/index.mjs`).status === 0 && git(`show ${tag}:qa/golden/tin-moon-1.json`).status === 0);
}

// 2.25: every game has its own ID (made without anyone asking) on goldens, results, builds and events;
// a recording from another game fails; a copy records its parent; version tags; the Prototype sprint pace.
{
  const dir = copyRepo();
  const env = { STUDIO_PRODUCER_NAME: 'prod-1' };
  const ng = run(dir, 'node scripts/new-game.mjs tin-moon', env);
  const meta = fs.existsSync(path.join(dir, 'cartridges/tin-moon/cartridge.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'cartridges/tin-moon/cartridge.json'), 'utf8')) : {};
  const g1 = JSON.parse(fs.readFileSync(path.join(dir, 'qa/golden/tin-moon-start-to-win.json'), 'utf8'));
  report('a new game gets its own ID, and its goldens carry it', ng.status === 0 && /^gid_[a-z0-9]{26}$/.test(meta.id || '') && g1.gameId === meta.id && run(dir, 'node qa/check-golden.mjs', env).status === 0, ng.stdout + ng.stderr + JSON.stringify(meta));
  run(dir, 'node harness/event.mjs --type agent.info --agent builder-1 --msg "hello"', env);
  const lastEv = fs.readFileSync(path.join(dir, '.studio/events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).pop();
  report('events carry the game ID', lastEv.gameId === meta.id, JSON.stringify(lastEv));
  fs.writeFileSync(path.join(dir, 'qa/golden/tin-moon-seed-1.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(dir, 'qa/golden/tin-moon-seed-1.json'), 'utf8')), gameId: 'gid_aaaaaaaaaaaaaaaaaaaaaaaaaa' }, null, 2));
  const other = run(dir, 'node qa/check-golden.mjs', env);
  report('a golden recorded for another game fails, even when its hashes match', other.status !== 0 && /results from another game/.test(other.stderr), other.stdout + other.stderr);
  run(dir, 'node qa/check-golden.mjs --update', env);
  report('npm run golden -- --update stamps this game\'s ID on its goldens', JSON.parse(fs.readFileSync(path.join(dir, 'qa/golden/tin-moon-seed-1.json'), 'utf8')).gameId === meta.id);
  // A game made before 2.25: preflight gives it an ID.
  fs.rmSync(path.join(dir, 'cartridges/tin-moon/cartridge.json'));
  const pf = run(dir, 'node scripts/preflight.mjs --quick', env);
  const meta2 = JSON.parse(fs.readFileSync(path.join(dir, 'cartridges/tin-moon/cartridge.json'), 'utf8'));
  report('a game made before 2.25 gets an ID at preflight, without anyone asking', /^gid_/.test(meta2.id) && meta2.id !== meta.id && /Game ID gid_/.test(pf.stdout), pf.stdout.split('\n').filter((l) => /Game ID/.test(l)).join('\n'));
  // A game started from a setup that carries a game template is a new game, with its parent recorded.
  const setup = path.join(tmpRoot, `setup225-${n}`);
  fs.mkdirSync(path.join(setup, 'cartridges/tin-moon'), { recursive: true });
  fs.copyFileSync(path.join(dir, 'cartridges/tin-moon/index.mjs'), path.join(setup, 'cartridges/tin-moon/index.mjs'));
  fs.copyFileSync(path.join(dir, 'cartridges/tin-moon/cartridge.json'), path.join(setup, 'cartridges/tin-moon/cartridge.json'));
  const into = path.join(tmpRoot, `into225-${n}`);
  fs.mkdirSync(into, { recursive: true });
  run(dir, `node scripts/studio-setup.mjs apply "${setup}" --into "${into}"`, env);
  const child = JSON.parse(fs.readFileSync(path.join(into, 'cartridges/tin-moon/cartridge.json'), 'utf8'));
  report('a game copied from a setup gets a new ID and records the original as its parent', /^gid_/.test(child.id) && child.id !== meta2.id && child.parent === meta2.id, JSON.stringify(child));
  // Version tags.
  const tr = JSON.parse(run(dir, 'node harness/task.mjs add "Port the scorer to Godot" --role builder --track engine:godot', env).stdout);
  const added = fs.readFileSync(path.join(dir, '.studio/events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'task.added' && e.task === tr.id).pop();
  run(dir, 'node harness/notes.mjs add --kind bad --track engine:godot "the Godot import is slow"', env);
  report('tasks and notes carry a version tag (web or engine:<name>)', added?.meta?.track === 'engine:godot' && /· engine:godot\] the Godot import is slow/.test(fs.readFileSync(path.join(dir, 'studio/harness-notes/NOTES.md'), 'utf8')), JSON.stringify(added?.meta));
  // The Prototype sprint pace.
  run(dir, 'node harness/mode.mjs set prototype --by hatch', env);
  report('the Prototype sprint pace: several builders in lanes, the watcher starts them, the Director at phase end', /Prototype sprint/.test(run(dir, 'node harness/mode.mjs', env).stdout) && /20\. In the Prototype sprint pace/.test(fs.readFileSync(path.join(dir, '.claude/skills/producer-playbook/SKILL.md'), 'utf8')) && /producer-playbook/.test(run(dir, 'node harness/kickoff.mjs --role producer --agent prod-1 --model m', env).stdout));
}

// 2.26: from test #2 (Next Floor on 2.24 and 2.25) and the token work: another tool's limit is that tool's,
// long resets are read right, stale marks are cleared; a session that ends holding a task hands it back,
// and one that keeps coming back is parked; one launcher; never two sessions on a task; owed reviews;
// relayed chat verdicts; a map and a pitfall list every agent reads; real token counts; short hand-backs.
{
  const dir = copyRepo();
  const git = (cmd) => run(dir, `git -c user.name=selftest -c user.email=selftest@example.com ${cmd}`);
  git('init -q');
  git('add -A');
  git('commit -q -m init --no-verify');
  const pause = (ms) => spawnSync(process.execPath, ['-e', `setTimeout(()=>{},${ms})`]);
  const env = { STUDIO_PRODUCER_NAME: 'prod-1', STUDIO_HEARTBEAT_SEC: '1', STUDIO_SUPERVISOR_SEC: '1' };
  const id = (cmd) => JSON.parse(run(dir, cmd, env).stdout).id;
  const quotaFile = path.join(dir, '.studio/tool-quota.json');
  const quota = () => (fs.existsSync(quotaFile) ? JSON.parse(fs.readFileSync(quotaFile, 'utf8')) : {});
  const node = (name, code) => {
    fs.writeFileSync(path.join(dir, name), code);
    return run(dir, `node ${name}`, env);
  };
  // Another tool's limit, printed inside this session, marks that tool, with its real reset.
  const t1 = id('node harness/task.mjs add "Check the lobby" --role builder');
  run(dir, `node harness/agent.mjs start --role builder --agent ag-1 --task ${t1}`, { ...env, STUDIO_BUILDER_CMD: 'node qa/fixtures/agents/fake-agent.mjs {agent} {task} agyquota' });
  const q1 = quota();
  report('agy\'s 429 inside another tool\'s session marks agy, not the session\'s tool (test #2: claude was marked out)', q1.agy && !q1.claude && !q1.custom && Date.parse(q1.agy.until) - Date.now() > 70 * 3600000, JSON.stringify(q1));
  const pr = node('pr.mjs', "import { parseReset } from './harness/budget.mjs';\nconst n = Date.parse('2026-10-21T10:00:00Z');\nconst h = (t) => { const r = parseReset(t, n); return r ? (r - n) / 3600000 : null; };\nconsole.log(JSON.stringify([h('Resets in 80h54m54s.'), h('resets in 3 days'), h('try again in 45 minutes'), h('usage limit reached')]));\n");
  report('"Resets in 80h54m" reads as about 81 hours, "3 days" as 72, and no reset as unknown', pr.stdout.trim() === JSON.stringify([80 + 54 / 60 + 54 / 3600, 72, 0.75, null]), pr.stdout);
  const bud = run(dir, 'node harness/budget.mjs', env).stdout;
  report('npm run budget quotes the provider\'s own line and how to check it', /The provider said: ".*Resets in 80h54m/.test(bud) && /npm run budget -- probe agy/.test(bud), bud);
  // A mark from an older harness, or quoting another tool's error, is cleared at preflight.
  fs.writeFileSync(quotaFile, JSON.stringify({ claude: { until: new Date(Date.now() + 3600000).toISOString(), why: 'AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429)"}' } }));
  const pf0 = run(dir, 'node scripts/preflight.mjs --quick', env);
  report('preflight clears a quota mark an older harness wrote, and says so', !quota().claude && /Cleared a stale quota mark for claude/.test(pf0.stdout), pf0.stdout.split('\n').filter((l) => /quota/i.test(l)).join('\n'));
  // A session that ends without task done or a hand-back gives the task back at once, with a note.
  const t2 = id('node harness/task.mjs add "Wire the bellhop sweep" --role builder');
  // STUDIO_BREAKER=off: this proves the older 3-in-2-h rule still holds as the fallback (2.30c's breaker trips at 2; its own checks are below).
  run(dir, `node harness/agent.mjs start --role builder --agent quit-1 --task ${t2}`, { ...env, STUDIO_BREAKER: 'off', STUDIO_BUILDER_CMD: 'node qa/fixtures/agents/fake-agent.mjs {agent} {task} quit' });
  const ql = JSON.parse(run(dir, 'node harness/task.mjs list', env).stdout);
  const hf = path.join(dir, `studio/handoffs/${t2}.md`);
  report('a session that ends without task done hands its task back at once, with what it left (test #2: claims sat for an hour)', ql.backlog.some((t) => t.id === t2) && !/quit-1/.test(run(dir, 'node harness/lock.mjs list', env).stdout) && fs.existsSync(hf) && /ended without task done/.test(fs.readFileSync(hf, 'utf8')), JSON.stringify(ql.inProgress) + (fs.existsSync(hf) ? fs.readFileSync(hf, 'utf8') : 'no handoff'));
  for (const k of [2, 3]) run(dir, `node harness/agent.mjs start --role builder --agent quit-${k} --task ${t2}`, { ...env, STUDIO_BREAKER: 'off', STUDIO_BUILDER_CMD: 'node qa/fixtures/agents/fake-agent.mjs {agent} {task} quit' });
  const holds = run(dir, 'node harness/task.mjs holds', env).stdout;
  report('a task handed back three times in two hours is parked, with its last note, and the Producer is told (test #2: T-110 went to 12 sessions)', new RegExp(`${t2}[^\\n]*parked[^\\n]*launcher[^\\n]*handed back 3 times`).test(holds) && /keeps coming back/.test(fs.readFileSync(path.join(dir, '.studio/events.jsonl'), 'utf8')), holds);
  // Anyone may hand back a task whose holder's session has ended.
  const t3 = id('node harness/task.mjs add "Floor three ceiling" --role builder');
  run(dir, `node harness/task.mjs start ${t3} --agent ghost-1`, env);
  fs.mkdirSync(path.join(dir, '.studio/agents'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.studio/agents/ghost-1.json'), JSON.stringify({ agent: 'ghost-1', role: 'builder', status: 'ended', pid: 1 }));
  const hp = run(dir, `node harness/task.mjs pause ${t3} --agent prod-1 --note "ghost-1 is gone"`, env);
  report('the Producer can hand back a task whose agent has ended, without waiting for the claim to expire', hp.status === 0, hp.stdout + hp.stderr);
  // Never two sessions on one task.
  run(dir, `node harness/lock.mjs claim task:${t3} --owner someone-1`, env);
  const twice = run(dir, `node harness/agent.mjs start --role builder --agent dup-1 --task ${t3}`, { ...env, STUDIO_BUILDER_CMD: 'node qa/fixtures/agents/fake-agent.mjs {agent} {task} ok' });
  report('an agent is never started on a task someone else holds (test #2: two sessions on T-160)', twice.status !== 0 && /someone-1 holds/.test(twice.stderr), twice.stdout + twice.stderr);
  run(dir, `node harness/lock.mjs release task:${t3} --owner someone-1`, env);
  // Stop all saves each running agent's uncommitted work as a patch before it hands the task back.
  const t4 = id('node harness/task.mjs add "Stop me mid-work" --role builder');
  run(dir, `node harness/agent.mjs start --role builder --agent mid-1 --task ${t4} --detach`, { ...env, STUDIO_BUILDER_CMD: 'node qa/fixtures/agents/fake-agent.mjs {agent} {task} wait' });
  const tm = Date.now();
  while (Date.now() - tm < 8000 * SLOW && !fs.existsSync(path.join(dir, 'docs/fake/mid-1.md'))) pause(300);
  pause(500);
  run(dir, 'node harness/task.mjs stop --by jed --reason "harness update"', env);
  const wipF = path.join(dir, `.studio/wip/${t4}-mid-1.patch`);
  const tw = Date.now();
  while (Date.now() - tw < 8000 * SLOW && !fs.existsSync(wipF)) pause(300);
  report('Stop all saves a running agent\'s uncommitted work as a patch, then hands its task back', fs.existsSync(wipF) && /docs\/fake\/mid-1\.md/.test(fs.readFileSync(wipF, 'utf8')) && /saved to \.studio\/wip\//.test(fs.readFileSync(path.join(dir, `studio/handoffs/${t4}.md`), 'utf8')), fs.existsSync(path.join(dir, `studio/handoffs/${t4}.md`)) ? fs.readFileSync(path.join(dir, `studio/handoffs/${t4}.md`), 'utf8') : 'no handoff');
  run(dir, 'node harness/task.mjs resume --by jed', env);
  run(dir, `node harness/task.mjs done ${t4} --agent prod-1 --force --reason "selftest forced" --accepted-by selftest`, env);
  // One launcher: the watcher's auto-start does nothing while a supervisor runs, and uses lanes when none does.
  run(dir, 'node harness/mode.mjs set fast --by hatch', env);
  // 2.58.0: the watcher starts agents only with auto-start on (off by default).
  run(dir, 'node harness/mode.mjs autostart on --by hatch', env);
  for (const t of JSON.parse(run(dir, 'node harness/task.mjs list', env).stdout).backlog.filter((x) => x.role === 'builder')) run(dir, `node harness/task.mjs park ${t.id} --by prod-1 --why "not this round"`, env);
  for (const t of ['Lobby doors', 'Lobby lights']) run(dir, `node harness/task.mjs add "${t}" --role builder --lane docs/lobby`, env);
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, '.studio/supervisor.json'), JSON.stringify({ status: 'running', pid: sleeper.pid }));
  const wenv = { ...env, STUDIO_BUILDER_CMD: 'node qa/fixtures/agents/fake-agent.mjs {agent} {task} wait' };
  const f1 = run(dir, 'node harness/agent.mjs fill', wenv);
  sleeper.kill();
  fs.rmSync(path.join(dir, '.studio/supervisor.json'));
  report('while the supervisor runs, the watcher starts nothing (test #2: two launchers, four collisions)', /supervisor \(pid \d+\) starts agents/.test(f1.stdout), f1.stdout + f1.stderr);
  const f2 = run(dir, 'node harness/agent.mjs fill', wenv);
  // Poll, not fixed waits: a detached agent can take several seconds to show as running on a slow
  // Windows runner (CI, 2.30c: a 2.5 s + 1.5 s wait saw no session at all).
  const liveList = () => JSON.parse(run(dir, 'node -e "import(\'./harness/agent.mjs\').then(m=>console.log(JSON.stringify(m.sessions().filter(s=>s.running).map(s=>s.agent))))"', env).stdout || '[]');
  let liveNow = [];
  const tf = Date.now();
  while (Date.now() - tf < 10000 && !(liveNow = liveList()).length) pause(300);
  run(dir, 'node harness/agent.mjs fill', wenv);
  // The second fill must not add a builder to the same lane: watch for one for a few seconds.
  const tg = Date.now();
  while (Date.now() - tg < 3000 * SLOW && (liveNow = liveList()).length <= 1) pause(300);
  report('without a supervisor, the watcher uses its picker: one builder per lane, named from the name list', liveNow.length === 1 && /^builder-auto-\d+$/.test(liveNow[0]) && /docs\/lobby/.test(f2.stdout), f2.stdout + JSON.stringify(liveNow));
  for (const s of liveNow) run(dir, `node harness/agent.mjs stop ${s}`, env);
  // A halt names the program, not "custom".
  for (const t of ['Probe one', 'Probe two', 'Probe three']) run(dir, `node harness/task.mjs add "${t}" --role rnd`, env);
  run(dir, `node harness/supervisor.mjs --no-hub --until ${secs(8)} --foreground`, { ...env, STUDIO_RND_CMD: 'no-such-agent-tool {agent}' });
  const halted = JSON.parse(fs.readFileSync(path.join(dir, '.studio/supervisor.json'), 'utf8')).halted;
  report('when the supervisor halts, it names the program that wasn\'t found', /no-such-agent-tool wasn't found/.test(halted?.why || ''), JSON.stringify(halted));
  // Token counts from the tool's own final report; cache reads kept apart.
  const tk = node('tk.mjs', "import { tokensFrom } from './harness/agent.mjs';\nconst c = tokensFrom(['{\"type\":\"assistant\",\"message\":{\"usage\":{\"input_tokens\":9}}}', '{\"type\":\"result\",\"usage\":{\"input_tokens\":10,\"cache_creation_input_tokens\":200,\"cache_read_input_tokens\":5000,\"output_tokens\":30},\"total_cost_usd\":0.12}'].join('\\n'));\nconst x = tokensFrom(['{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":1000,\"cached_input_tokens\":800,\"output_tokens\":50}}', '{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":500,\"cached_input_tokens\":100,\"output_tokens\":20}}'].join('\\n'));\nconst p = tokensFrom('{\"usage\":{\"prompt_tokens\":40,\"completion_tokens\":4}}');\nconsole.log(JSON.stringify([c, x, p]));\n");
  const [tc, tx, tp] = JSON.parse(tk.stdout || '[{},{},{}]');
  report('tokens come from the tool\'s own final report, with cache reads kept apart (Claude, Codex, a plain report)', tc.tokensIn === 210 && tc.cacheRead === 5000 && tc.tokensOut === 30 && tc.costUsd === 0.12 && tx.tokensIn === 600 && tx.cacheRead === 900 && tx.tokensOut === 70 && tp.tokensIn === 40 && tp.tokensOut === 4, tk.stdout + tk.stderr);
  // A Claude session's log reads as a conversation.
  fs.writeFileSync(path.join(dir, '.studio/agents/talk-1.log'), ['{"type":"system","subtype":"init","session_id":"s1","model":"m"}', '{"type":"assistant","message":{"content":[{"type":"text","text":"Reading the map first."},{"type":"tool_use","name":"Bash","input":{"command":"npm run map"}}]}}', '{"type":"result","subtype":"success","result":"Done.","usage":{"input_tokens":5,"output_tokens":7,"cache_read_input_tokens":90}}'].join('\n'));
  const lg = run(dir, 'node harness/agent.mjs logs talk-1', env).stdout;
  report('agent logs show a Claude session as what it said and ran, not raw JSON', /talk-1: Reading the map first\./.test(lg) && /→ Bash "npm run map"/.test(lg) && /cache read 90/.test(lg), lg);
  // The map, and the pitfalls every agent reads.
  const mp = run(dir, 'node harness/map.mjs', env);
  const mapMd = fs.existsSync(path.join(dir, '.studio/MAP.md')) ? fs.readFileSync(path.join(dir, '.studio/MAP.md'), 'utf8') : '';
  report('npm run map writes a one-page map of the code: what each file is and what it exports', mp.status === 0 && /`harness\/task\.mjs` \(\d+ lines, \*\*big\*\*\)/.test(mapMd) && /Exports: [^\n]*parseNextQueue/.test(mapMd) && run(dir, 'node harness/map.mjs --check', env).status === 0, mp.stdout + mapMd.slice(0, 400));
  run(dir, 'node harness/pitfalls.mjs "never put the hotel ceiling texture on office floors" --by jed', env);
  run(dir, 'node harness/pitfalls.mjs "Never put the hotel ceiling texture on office floors!" --by jed', env);
  run(dir, 'node harness/notes.mjs add --kind bad "don\'t run the look check on dist without a per-tick timeout"', env);
  run(dir, 'node harness/notes.mjs add --kind bad "the import was slow today"', env);
  const pits = run(dir, 'node harness/pitfalls.mjs', env).stdout;
  const ko = node('ko.mjs', "import { pitfallsForPrompt } from './harness/pitfalls.mjs';\nconsole.log(pitfallsForPrompt());\n").stdout;
  report('pitfalls: one line per rule, no repeats, a "didn\'t work" note that reads as a rule is added, and every agent\'s prompt carries them', (pits.match(/hotel ceiling/g) || []).length === 1 && /per-tick timeout/.test(pits) && !/import was slow/.test(pits) && /Pitfalls seen in this game[^\n]*:\n\| - never put the hotel/.test(ko), pits + ko);
  run(dir, 'node harness/pitfalls.mjs remove 1 --by jed', env);
  report('a pitfall that no longer holds can be removed', !/hotel ceiling/.test(run(dir, 'node harness/pitfalls.mjs', env).stdout));
  // Hand-back notes are kept short.
  const t5 = id('node harness/task.mjs add "Long notes" --role builder');
  run(dir, `node harness/task.mjs start ${t5} --agent long-1`, env);
  // Through the module, not the command line: a newline in an argument doesn't survive cmd.exe on Windows.
  node('ln.mjs', `import { pauseTask } from './harness/task.mjs';\npauseTask('${t5}', 'long-1', Array.from({ length: 40 }, (_, i) => \`line \${i}\`).join('\\n'));\n`);
  const longNote = fs.readFileSync(path.join(dir, `studio/handoffs/${t5}.md`), 'utf8');
  report('a hand-back note is cut to 20 lines, with a reminder of the short shape', /line 19/.test(longNote) && !/line 20\b/.test(longNote) && /Cut to 20 lines/.test(longNote), longNote.slice(-300));
  // A verdict an owner gave in chat can be relayed, with their words and where they said them.
  const vr0 = run(dir, 'node harness/verdict.mjs yes --by jed', { ...env, STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'art-1' });
  const vr1 = run(dir, 'node harness/verdict.mjs yes --by jed --quote "love the burgers and the changes" --source "Discord #next-floor 18:30" --relayed-by art-1', { ...env, STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'art-1' });
  report('from an agent, a fun verdict needs the person\'s own words and where they said them (a relay), never just their name', vr0.status !== 0 && /needs jed's own words/.test(vr0.stderr) && /no saved build/i.test(vr1.stderr + vr1.stdout), vr0.stderr + vr1.stdout + vr1.stderr);
  // A review nobody could do is owed, with when to try again.
  const ow = node('ow.mjs', "import { oweReview, readOwed, dueOwed } from './harness/review.mjs';\nawait oweReview('T-990', 'codex: exit 1 (You\\'ve hit your usage limit)', 'claude-opus-5-5');\nconsole.log(readOwed().length, dueOwed(Date.now() + 2 * 3600000).map((o) => o.task).join(','));\n");
  report('a review no other-family reviewer could do is owed and comes due again on its own', ow.stdout.trim() === '1 T-990' && fs.existsSync(path.join(dir, 'studio/reviews/OWED.json')), ow.stdout + ow.stderr);
  // The watcher: a held task isn't "waiting for an agent".
  const t6 = id('node harness/task.mjs add "Waits for the lobby" --role builder');
  run(dir, `node harness/task.mjs start ${t6} --agent w-1`, env);
  run(dir, `node harness/task.mjs pause ${t6} --agent w-1 --note "blocked on the lobby"`, env);
  run(dir, `node harness/task.mjs block ${t6} --until ${t1} --by prod-1`, env);
  const wt = run(dir, 'node harness/watch.mjs --dry-run --wait 0', env).stdout;
  report('the watcher reports a held task as held, not as waiting for an agent (test #2: Watch tasks for nothing)', new RegExp(`${t6} is held`).test(wt) && !new RegExp(`${t6} was handed back`).test(wt), wt);
  // A partial verify never replaces the full one a done-check reads.
  run(dir, 'node scripts/run-gates.mjs --only docs', env);
  report('npm run verify -- --only keeps the last full verify apart (test #2: one agent\'s --only wiped another\'s)', fs.existsSync(path.join(dir, '.studio/gates-last.json')) && !fs.existsSync(path.join(dir, '.studio/gates-last-full.json')));
  // The docs check leaves the Producer's free-text log alone.
  fs.appendFileSync(path.join(dir, 'studio/producer/LOG.md'), '\nNext: npm run verify-everything-twice:\n');
  report('the docs check skips the Producer\'s log (test #2: a log line turned every verify red)', run(dir, 'node scripts/check-docs.mjs', env).status === 0, run(dir, 'node scripts/check-docs.mjs', env).stdout);
  // Preflight: game.json from STUDIO_CARTRIDGE, and new files in harness folders are named.
  fs.mkdirSync(path.join(dir, 'cartridges/tin-moon'), { recursive: true });
  for (const f of ['index.mjs', 'qa.mjs']) fs.copyFileSync(path.join(dir, `cartridges/example-sim/${f}`), path.join(dir, `cartridges/tin-moon/${f}`));
  fs.rmSync(path.join(dir, 'studio/game.json'), { force: true });
  node('frz2.mjs', "import fs from 'node:fs';\nimport { harnessSums } from './scripts/preflight.mjs';\nfs.writeFileSync('.studio/harness-frozen', 'test');\nfs.writeFileSync('.studio/harness-frozen.json', JSON.stringify(harnessSums()));\n");
  fs.mkdirSync(path.join(dir, 'tools/art'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tools/art/tint-glb.mjs'), '// a game tool in the wrong place\n');
  const pf1 = run(dir, 'node scripts/preflight.mjs --quick', { ...env, STUDIO_CARTRIDGE: 'tin-moon' });
  const gj = fs.existsSync(path.join(dir, 'studio/game.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'studio/game.json'), 'utf8')) : {};
  report('preflight writes studio/game.json for a game picked by STUDIO_CARTRIDGE (test #2, FIX 03)', gj.cartridge === 'tin-moon' && /Wrote studio\/game\.json/.test(pf1.stdout), pf1.stdout.split('\n').filter((l) => /game\.json|Gates test/.test(l)).join('\n'));
  report('preflight names a new file in a harness folder and says where a game\'s tools go (test #2: tools/art/*.mjs)', /No new files in harness folders/.test(pf1.stdout) && /tools\/art\/tint-glb\.mjs[^\n]*game\/tin-moon\/tools\//.test(pf1.stdout), pf1.stdout.split('\n').filter((l) => /harness folders|tools/.test(l)).join('\n'));
  // Balance a game's own knob without a config file.
  const bal = run(dir, 'node scripts/balance-sweep.mjs --knob spawnCost --values 300,400', env);
  report('npm run balance takes a knob and values on the command line', bal.status === 0 && /\| 300 /.test(bal.stdout), bal.stdout.slice(-400) + bal.stderr);
}

// 2.27: the engine track. Only after Phase 1 is proven, only on a person's yes; then its own folder,
// department, lane and gate, and a parity test against the web game. With a real Godot (STUDIO_GODOT),
// the shipped template's parity and gate run for real.
{
  const dir = copyRepo();
  const env = { STUDIO_PRODUCER_NAME: 'prod-1' };
  const node = (name, code, e = env) => {
    fs.writeFileSync(path.join(dir, name), code);
    return run(dir, `node ${name}`, e);
  };
  const opts = run(dir, 'node harness/engine.mjs', env).stdout;
  report('npm run engine shows the engines with their cost and trade-offs, Godot first', /No engine track/.test(opts) && /godot \(recommended\): Godot 4/.test(opts) && /unreal: Unreal 5, usage about 3 to 5 times Godot/.test(opts), opts);
  report('with no engine track, the engine gate and parity pass with a note', /no engine track/.test(run(dir, 'node scripts/check-engine.mjs', env).stdout) && /SKIP no engine track/.test(run(dir, 'node qa/parity.mjs', env).stdout));
  run(dir, 'node scripts/new-game.mjs tin-moon', env);
  const early = run(dir, 'node harness/engine.mjs propose godot --by prod-1', env);
  report('an engine track can\'t be proposed before Phase 1 is proven', early.status !== 0 && /Phase 1 isn't proven/.test(early.stderr), early.stdout + early.stderr);
  fs.mkdirSync(path.join(dir, 'studio/bible'), { recursive: true });
  const bj = path.join(dir, 'studio/bible/bible.json');
  fs.writeFileSync(bj, JSON.stringify({ ...(fs.existsSync(bj) ? JSON.parse(fs.readFileSync(bj, 'utf8')) : {}), phase: { open: 2 } }));
  const prop = run(dir, 'node harness/engine.mjs propose godot --by prod-1 --why "Phase 1 is fun"', env);
  const askId = (prop.stdout.match(/A-\d+/) || [])[0];
  report('once Phase 1 is proven, the Producer\'s proposal is a question for the game dev, not a start', prop.status === 0 && askId && !fs.existsSync(path.join(dir, 'engine/tin-moon')), prop.stdout + prop.stderr);
  const yes = run(dir, `node harness/ask.mjs answer ${askId} yes --by hatch`, env);
  const track = fs.existsSync(path.join(dir, 'engine/tin-moon/engine.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'engine/tin-moon/engine.json'), 'utf8')) : {};
  const ql = JSON.parse(run(dir, 'node harness/task.mjs list', env).stdout);
  const porter = ql.backlog.filter((t) => t.role === 'engine-porter');
  const ev = fs.readFileSync(path.join(dir, '.studio/events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const added = ev.filter((e) => e.type === 'task.added' && porter.some((t) => t.id === e.task));
  report('a yes starts the track: its folder from the Godot template, its record with the game ID, porter tasks in its lane, the department open', yes.status === 0 && track.engine === 'godot' && track.gameId && /\{bin\} --headless/.test(track.gate) && fs.existsSync(path.join(dir, 'engine/tin-moon/sim/sim.gd')) && fs.existsSync(path.join(dir, 'engine/tin-moon/tools/parity.gd')) && porter.length >= 2 && added.every((e) => e.meta?.lane === 'engine/tin-moon' && e.meta?.track === 'engine:godot') && /^true$/m.test(node('dv.mjs', "import { listDivisions } from './harness/divisions.mjs';\nconsole.log(Boolean(listDivisions().find((d) => d.id === 'engine')?.active));\n").stdout) && fs.existsSync(path.join(dir, 'studio/engine/PARITY.md')), yes.stdout + yes.stderr + JSON.stringify(track) + JSON.stringify(porter));
  // Parity: the engine's results against the web game's, seed by seed (a stand-in engine here).
  fs.writeFileSync(path.join(dir, 'fake-parity.mjs'), "import { loadCartridge, runScenario } from './harness/cartridge.mjs';\nconst cart = await loadCartridge('tin-moon');\nconst off = process.env.OFF_BY ? Number(process.env.OFF_BY) : 0;\nfor (const s of process.argv[2].split(',').map(Number)) { const r = runScenario(cart, 'start-to-win', { seed: s }); console.log(JSON.stringify({ seed: s, outcome: r.outcome, tick: r.ticksRun + (s === 3 ? off : 0) })); }\n");
  fs.writeFileSync(path.join(dir, 'engine/tin-moon/engine.json'), JSON.stringify({ ...track, parity: { command: 'node fake-parity.mjs {seeds}', compare: ['outcome', 'tick'] } }, null, 2));
  const p1 = run(dir, 'node qa/parity.mjs', env);
  const p2 = run(dir, 'node qa/parity.mjs', { ...env, OFF_BY: '2' });
  report('parity passes when the engine matches the web game, and fails naming the seed and the field when it doesn\'t', p1.status === 0 && /PASS 5 seeds agree on outcome and tick/.test(p1.stdout) && p2.status !== 0 && /seed 3: tick is \d+ on the web, \d+ in Godot 4/.test(p2.stderr), p1.stdout + p1.stderr + p2.stdout + p2.stderr);
  // The gate: the engine's own headless run; a script error fails it even with exit 0.
  const noEngine = run(dir, 'node scripts/check-engine.mjs', { ...env, PATH: path.dirname(process.execPath) });
  report('without the engine installed, the engine gate fails and says what to set (STUDIO_GODOT)', noEngine.status !== 0 && /godot isn't installed[^\n]*STUDIO_GODOT/.test(noEngine.stderr), noEngine.stdout + noEngine.stderr);
  fs.writeFileSync(path.join(dir, 'fake-gate.mjs'), "console.log('[gate] PASS test_sim.gd');\nif (process.env.BREAK) console.log('SCRIPT ERROR: Invalid call. Nonexistent function \\'foo\\' in base \\'Nil\\'.');\n");
  fs.writeFileSync(path.join(dir, 'engine/tin-moon/engine.json'), JSON.stringify({ ...track, gate: 'node fake-gate.mjs' }, null, 2));
  const g1 = run(dir, 'node scripts/check-engine.mjs', env);
  const g2 = run(dir, 'node scripts/check-engine.mjs', { ...env, BREAK: '1' });
  report('the engine gate passes a clean run and fails on a script error even when the engine exits 0', g1.status === 0 && /PASS Godot 4/.test(g1.stdout) && g2.status !== 0 && /1 script error/.test(g2.stderr), g1.stdout + g1.stderr + g2.stdout + g2.stderr);
  // How the port is made is followed run by run: the engine log, and the run report's engine and token sections.
  const elog = fs.existsSync(path.join(dir, 'studio/engine/LOG.md')) ? fs.readFileSync(path.join(dir, 'studio/engine/LOG.md'), 'utf8') : '';
  fs.mkdirSync(path.join(dir, '.studio'), { recursive: true });
  fs.appendFileSync(path.join(dir, '.studio/events.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), type: 'agent.session.start', agent: 'porter-s1', meta: { role: 'engine-porter' } })}\n${JSON.stringify({ ts: new Date().toISOString(), type: 'agent.session.end', agent: 'porter-s1', tokensIn: 10, tokensOut: 20, meta: { role: 'engine-porter', cacheRead: 1500000 } })}\n`);
  const rto = path.join(tmpRoot, `results-engine-${n}`);
  run(dir, `node harness/run-report.mjs --to "${rto}"`, env);
  const rmade = fs.existsSync(rto) ? fs.readdirSync(rto) : [];
  const rrep = rmade[0] ? fs.readFileSync(path.join(rto, rmade[0], 'REPORT.md'), 'utf8') : '';
  report('the engine track keeps its own log (start, gate, parity) and the run report shows it, with cache reads per session by role', /track started: Godot 4/.test(elog) && /gate PASS/.test(elog) && /gate FAIL[^\n]*script error/.test(elog) && /parity FAIL on seeds/.test(elog) && /## Engine track[\s\S]*Gate: 1 passed, 1 failed/.test(rrep) && /\| engine-porter \| 1 \| 0 \| 1\.5M \|/.test(rrep), elog + rrep.slice(rrep.indexOf('## Tokens'), rrep.indexOf('## Tokens') + 900));
  // 2.30h: a Godot run that only rendered smoke frames (no test ran) fails; the capture path is absolute.
  fs.writeFileSync(path.join(dir, 'fake-gate-frames.mjs'), "console.log('[gate] PASS: 0 test script(s), 0 failure(s), 300 smoke frames');\n");
  fs.writeFileSync(path.join(dir, 'engine/tin-moon/engine.json'), JSON.stringify({ ...track, gate: 'node fake-gate-frames.mjs' }, null, 2));
  const g3 = run(dir, 'node scripts/check-engine.mjs', env);
  fs.writeFileSync(path.join(dir, 'engine/tin-moon/engine.json'), JSON.stringify({ ...track, gate: 'node fake-gate.mjs' }, null, 2));
  report('2.30h: the engine gate fails a Godot run that rendered smoke frames but ran no test', g3.status !== 0 && /frames alone are not a check/.test(g3.stderr), g3.stdout + g3.stderr);
  // Asset studio: approving the last design waiting moves it to assets/approved/ and asks for the next round.
  fs.mkdirSync(path.join(dir, 'assets/staging/props'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'assets/staging/props/lamp.png'), 'png');
  const prA = run(dir, 'node harness/art.mjs propose assets/staging/props/lamp.png --title "Lobby lamp" --by art-1', env);
  const num = (prA.stdout.match(/#(\d+)/) || [])[1];
  const apA = run(dir, `node harness/art.mjs approve ${num} --by hatch`, env);
  const qA = JSON.parse(run(dir, 'node harness/task.mjs list', env).stdout);
  report('approving the last design waiting moves it to assets/approved/ and gives the art department its next round', fs.existsSync(path.join(dir, 'assets/approved/props/lamp.png')) && qA.backlog.some((t) => t.role === 'art' && /^Art: next round/.test(t.title)) && /next round/.test(apA.stdout), prA.stdout + prA.stderr + apA.stdout + apA.stderr);
  // The Arcade plays a bundled build whose files are asked for at the root (vite's default base '/').
  const vb = path.join(dir, '.studio/builds/209901010000-vite');
  fs.mkdirSync(path.join(vb, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(vb, 'build.json'), JSON.stringify({ id: '209901010000-vite', at: '2099-01-01T00:00:00Z', page: 'index.html', cartridge: 'tin-moon', outcome: 'won', ticks: 1 }));
  fs.writeFileSync(path.join(vb, 'index.html'), '<script type="module" src="/assets/index-abc.js"></script>\n');
  fs.writeFileSync(path.join(vb, 'assets/index-abc.js'), 'console.log("a bundled game");\n');
  const pause = (ms) => spawnSync(process.execPath, ['-e', `setTimeout(()=>{},${ms})`]);
  const hport = 3900 + Math.floor(Math.random() * 90);
  const hubP = spawn(process.execPath, ['hub/server.mjs'], { cwd: dir, env: { ...CLEAN_ENV, HUB_PORT: String(hport), HUB_TOKEN: 'selftest-token' }, stdio: 'ignore' });
  const get = (p) => spawnSync(process.execPath, ['-e', `fetch('http://127.0.0.1:${hport}${p}').then(async (r) => console.log(r.status, (await r.text()).slice(0, 40))).catch((e) => console.log('ERR', e.message))`], { encoding: 'utf8' }).stdout.trim();
  const th = Date.now();
  while (Date.now() - th < 10000 * SLOW && /^ERR/.test(get('/health'))) pause(300);
  const page = get('/play/209901010000-vite/index.html');
  const asset = get('/assets/index-abc.js');
  hubP.kill();
  report('the Arcade plays a bundled build whose files load from the root (/assets/…), not only from /play/<id>/', /^200/.test(page) && /^200 console\.log\("a bundled game"\)/.test(asset), `${page} | ${asset}`);
  // The real thing, when a Godot is installed: the template's port matches the web game, and its gate passes.
  const godot = process.env.STUDIO_GODOT || (spawnSync(process.platform === 'win32' ? 'where' : 'which', ['godot']).status === 0 ? 'godot' : null);
  if (godot) {
    const tpl = path.join(dir, 'engine/_godot');
    spawnSync(godot, ['--headless', '--path', tpl, '--import'], { encoding: 'utf8', timeout: 180000 });
    const out = spawnSync(godot, ['--headless', '--path', tpl, '--script', 'res://tools/parity.gd', '--', '1,2,3,1337'], { encoding: 'utf8', timeout: 180000 });
    const lines = String(out.stdout).split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
    const web = JSON.parse(node('webp.mjs', "import { loadCartridge, runScenario } from './harness/cartridge.mjs';\nconst cart = await loadCartridge('example-sim');\nconsole.log(JSON.stringify([1, 2, 3, 1337].map((s) => { const r = runScenario(cart, 'start-to-win', { seed: s }); return { seed: s, outcome: r.outcome, tick: r.ticksRun, 'resources.credits': r.state.resources.credits }; })));\n").stdout || '[]');
    report('with Godot installed: the shipped Godot port matches the web game on outcome, tick and credits (seeds 1, 2, 3, 1337)', lines.length === 4 && JSON.stringify(lines.map((l) => [l.seed, l.outcome, l.tick, l['resources.credits']])) === JSON.stringify(web.map((w) => [w.seed, w.outcome, w.tick, w['resources.credits']])), JSON.stringify(lines) + JSON.stringify(web) + out.stderr);
    const gate = spawnSync(godot, ['--headless', '--path', tpl, '--script', 'res://tools/gate.gd'], { encoding: 'utf8', timeout: 180000 });
    report('with Godot installed: the template\'s gate runs its tests and a smoke run, and passes', gate.status === 0 && /\[gate\] PASS: [1-9]\d* test script\(s\), 0 failure/.test(gate.stdout) && !/SCRIPT ERROR/.test(gate.stdout + gate.stderr), gate.stdout + gate.stderr);
  } else console.log('[selftest] note: no Godot (set STUDIO_GODOT) so the real template parity and gate were not run');
}

// Pace and timed questions: the game dev chooses how fast; the Producer may decide when the dev is slow, never on protected topics.
{
  const dir = copyRepo();
  const env = { STUDIO_PRODUCER_NAME: 'prod-1' };
  report('the pace defaults to precise until the game dev chooses', /Precise and slow \(default/.test(run(dir, 'node harness/mode.mjs', env).stdout));
  run(dir, 'node harness/mode.mjs set extreme --by hatch', env);
  const ext = run(dir, 'node harness/mode.mjs', env).stdout;
  run(dir, 'node harness/mode.mjs boost on --by hatch --hours 2', env);
  const boosted = run(dir, 'node harness/mode.mjs', env).stdout;
  report('Extreme speed starts agents itself; MAX SPEED doubles the agents and makes the Director and Producer check in more often', /up to 8 agents/.test(ext) && /Director every 6 h/.test(ext) && /up to 12 agents/.test(boosted) && /Producer every 1 h/.test(boosted) && /MAX SPEED on until/.test(boosted), ext + boosted);
  const noWhy = run(dir, 'node harness/ask.mjs "Which floor first?" --options "Cubicle,Food court" --default Cubicle --timeout 1m', env);
  report('a timed question needs the reason behind its default', noWhy.status !== 0 && /--why/.test(noWhy.stderr), noWhy.stderr);
  run(dir, 'node harness/ask.mjs "Which floor first?" --options "Cubicle,Food court" --default Cubicle --timeout 1m --why "it teaches the controls" --by prod-1', env);
  const prot = run(dir, 'node harness/ask.mjs "Can we spend 20 USD on a sound pack?" --options "yes,no" --default yes --timeout 1m --why "cheap" --by prod-1', env);
  report('questions about money, signing, pillars or deleting never get a deadline', /waits for a person/.test(prot.stdout) && JSON.parse(fs.readFileSync(path.join(dir, 'studio/asks/A-002.json'), 'utf8')).deadline === null, prot.stdout);
  const a1 = path.join(dir, 'studio/asks/A-001.json');
  fs.writeFileSync(a1, JSON.stringify({ ...JSON.parse(fs.readFileSync(a1, 'utf8')), deadline: new Date(Date.now() - 1000).toISOString() }));
  const w = run(dir, 'node harness/watch.mjs', env);
  const decided = JSON.parse(fs.readFileSync(a1, 'utf8'));
  report('past its deadline, the default applies and is logged for the dev to review', decided.status === 'decided' && decided.answer === 'Cubicle' && /it teaches the controls/.test(fs.readFileSync(path.join(dir, 'studio/decisions/decided-without-you.md'), 'utf8')) && JSON.parse(fs.readFileSync(path.join(dir, 'studio/asks/A-002.json'), 'utf8')).status === 'open', w.stdout + w.stderr);
  report('an agent can\'t answer for the game dev', run(dir, 'node harness/ask.mjs answer A-002 yes --by prod-1', env).status !== 0);
  const rev = run(dir, 'node harness/ask.mjs reverse A-001 "Food court" --by hatch', env);
  report('the dev can reverse a decision made without them, which gives the Producer a task', rev.status === 0 && /Reverse A-001: hatch chose "Food court"/.test(fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8')), rev.stdout + rev.stderr);
  const to = path.join(tmpRoot, `pace-report-${n}`);
  run(dir, `node harness/run-report.mjs --to "${to}"`, env);
  const rep = fs.readFileSync(path.join(to, fs.readdirSync(to)[0], 'REPORT.md'), 'utf8');
  report('the run report shows the pace and what was decided without the dev', /Pace: Extreme speed/.test(rep) && /## Decided without you[\s\S]*A-001/.test(rep), rep.slice(0, 600));
}

// The art department starts in pre-production; the dev approves its designs; War Room actions reach agents.
{
  const dir = copyRepo();
  const env = { STUDIO_PRODUCER_NAME: 'prod-1' };
  run(dir, 'node harness/intake.mjs --answers studio/templates/intake-example.json', env);
  const q = fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8');
  const artTask = (q.match(/\*\*(T-\d+)\*\* \[P1\] \(`art`\) — Art: style sheet and five placeholder assets/) || [])[1];
  report('pre-production queues the art department: a style sheet and five placeholder assets', Boolean(artTask), q);
  report('the Bible says there is no art reference yet', /no art reference yet/.test(run(dir, 'node harness/bible.mjs check', env).stdout));
  fs.mkdirSync(path.join(dir, 'studio/art'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'assets/placeholder'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'references/R-009'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'references/R-009/shot.png'), 'png');
  report('a file from the reference library can\'t be proposed for the game', /never to ship/.test(run(dir, 'node harness/art.mjs propose references/R-009/shot.png --title "Their look" --by art-1', env).stderr));
  const start = run(dir, `node harness/task.mjs start ${artTask} --agent art-1`, env);
  report('art work can start before the Bible is signed', start.status === 0, start.stdout + start.stderr);
  fs.writeFileSync(path.join(dir, 'studio/art/STYLE.md'), '# Style\nMoss greens, warm lamps, round shapes.\n');
  run(dir, `node harness/art.mjs propose studio/art/STYLE.md --kind style --title "Moss and lamplight" --task ${artTask} --by art-1`, env);
  fs.writeFileSync(path.join(dir, 'assets/placeholder/crate.glb'), 'glb');
  run(dir, `node harness/art.mjs propose assets/placeholder/crate.glb --title "Garden crate" --task ${artTask} --source "tools/blender/generate_glb.py --preset crate" --by art-1`, env);
  const early = run(dir, `node harness/task.mjs done ${artTask} --agent art-1`, env);
  report('the art task isn\'t done with one placeholder of five', early.status !== 0 && /1 of 5 placeholder assets/.test(early.stdout + early.stderr), early.stdout + early.stderr);
  for (const k of [2, 3, 4, 5]) {
    fs.writeFileSync(path.join(dir, `assets/placeholder/p${k}.glb`), `glb${k}`);
    run(dir, `node harness/art.mjs propose assets/placeholder/p${k}.glb --title "Prop ${k}" --task ${artTask} --by art-1`, env);
  }
  const done = run(dir, `node harness/task.mjs done ${artTask} --agent art-1`, env);
  report('with a style sheet and five placeholders proposed, the art task is done (approval stays with the dev)', done.status === 0, done.stdout + done.stderr);
  report('an agent can\'t approve a design', run(dir, 'node harness/art.mjs approve D-001 --by art-1', env).status !== 0 && run(dir, 'node harness/art.mjs approve D-001 --by prod-1', env).status !== 0);
  const ap = run(dir, 'node harness/art.mjs approve D-001 --by hatch', env);
  const bible = JSON.parse(fs.readFileSync(path.join(dir, 'studio/bible/bible.json'), 'utf8'));
  report('approving the style sheet makes it the art reference in the Bible', ap.status === 0 && bible.artReference?.file === 'studio/art/STYLE.md' && /Art reference: studio\/art\/STYLE\.md \(approved by hatch/.test(fs.readFileSync(path.join(dir, 'studio/bible/BIBLE.md'), 'utf8')), ap.stdout + ap.stderr);
  run(dir, 'node harness/art.mjs approve D-002 --by hatch', env);
  const man = JSON.parse(fs.readFileSync(path.join(dir, 'studio/assets/manifest.json'), 'utf8'));
  report('approving a placeholder asset records it in the asset ledger with who approved it and its source', man.assets.some((a) => a.file === 'assets/approved/placeholder/crate.glb' && a.declaredBy === 'hatch' && a.design === 'D-002' && /generate_glb/.test(a.source)), JSON.stringify(man));
  const noWords = run(dir, 'node harness/art.mjs changes D-003 --by hatch', env);
  const ch = run(dir, 'node harness/art.mjs changes D-003 "taller, with a lid" --by hatch', env);
  report('asking for changes needs your words, then gives the art department a task', noWords.status !== 0 && ch.status === 0 && /\(`art`\) — Art: round 2 of #3 Prop 2: taller, with a lid/.test(fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8')), noWords.stderr + ch.stdout + ch.stderr + fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8').split('\n').filter((l) => /Art:/.test(l)).join('\n'));
  fs.writeFileSync(path.join(dir, 'hudjson.mjs'), "import { buildHudState } from './harness/hud.mjs';\nconsole.log(JSON.stringify(buildHudState()));\n");
  const hud = JSON.parse(run(dir, 'node hudjson.mjs', env).stdout || '{}');
  report('the art division is on by default, and designs waiting show under Needs you', hud.divisions?.find((d) => d.id === 'art')?.active === true && (hud.signals?.needsYou || []).some((x) => /designs waiting in the Asset studio \(#4 Prop 3/.test(x)), JSON.stringify(hud.signals));
  // War Room actions start the right agent when a tool is set, and say what happens next either way.
  fs.writeFileSync(path.join(dir, 'wake.mjs'), "import { wake } from './harness/agent.mjs';\nconsole.log(JSON.stringify(wake(process.argv[2], { task: process.argv[3] || null })));\n");
  const none = JSON.parse(run(dir, 'node wake.mjs rnd T-001', env).stdout);
  report('with no tool set, a wake-up says the task waits and how to start an agent', none.started === false && /No tool is set to start R&D/.test(none.next), none.next);
  const wenv = { ...env, STUDIO_HEARTBEAT_SEC: '1', STUDIO_RND_CMD: 'node qa/fixtures/agents/fake-agent.mjs {agent} T-001 wait' };
  const up = JSON.parse(run(dir, 'node wake.mjs rnd T-001', wenv).stdout);
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 * SLOW && !/rnd-1/.test(run(dir, 'node harness/agent.mjs list', env).stdout)) spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},300)']);
  const again = JSON.parse(run(dir, 'node wake.mjs rnd T-001', wenv).stdout);
  report('a pitch or message starts the role\'s agent, and a second one finds it already running', up.started === true && /R&D is starting now as rnd-1/.test(up.next) && again.started === false && /is running/.test(again.next), `${up.next} | ${again.next}`);
  run(dir, 'node harness/agent.mjs stop rnd-1', env);
  // The Liaison chat on a cheap model: a brief is drafted and read back; a correction changes it.
  const fake = path.join(dir, 'fake-liaison.mjs');
  fs.writeFileSync(fake, `import http from 'node:http';
let n = 0;
const replies = ['What should the player see first?', 'BRIEF {"kind":"idea","title":"Fireflies at dusk","summary":"Fireflies light the garden at dusk.","detail":""}', 'BRIEF {"kind":"idea","title":"Fireflies at dusk, only in summer","summary":"Fireflies light the garden at dusk in summer.","detail":""}'];
const s = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: 'fake-cheap', choices: [{ message: { content: replies[Math.min(n++, 2)] } }], usage: { prompt_tokens: 5, completion_tokens: 5 } })); }); });
s.listen(0, '127.0.0.1', () => console.log(s.address().port));`);
  const server = spawn(process.execPath, [fake], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((r) => server.stdout.once('data', (d) => r(String(d).trim())));
  fs.writeFileSync(path.join(dir, 'chat.mjs'), "import { chatTurn } from './harness/liaison.mjs';\nconst out = [];\nlet m = [{ role: 'user', content: 'fireflies please' }];\nlet r = await chatTurn({ messages: m, from: 'hatch' }); out.push(r);\nm = [...m, { role: 'assistant', content: r.reply }, { role: 'user', content: 'the garden, at dusk' }];\nr = await chatTurn({ messages: m, from: 'hatch' }); out.push(r);\nm = [...m, { role: 'assistant', content: r.reply }, { role: 'user', content: 'only in summer' }];\nout.push(await chatTurn({ messages: m, from: 'hatch', pending: r.brief }));\nconsole.log(JSON.stringify(out));\n");
  const chat = await runAsync(dir, 'node chat.mjs', { ...env, OLLAMA_BASE_URL: `http://127.0.0.1:${port}/v1`, STUDIO_PREPARE_CHAIN: 'ollama-local' });
  server.kill();
  let turns = [];
  try {
    turns = JSON.parse(chat.stdout.trim().split('\n').pop());
  } catch {
    // reported below
  }
  report('the Liaison chat asks, then reads a brief back; a correction changes the same brief', turns.length === 3 && !turns[0].brief && /What should the player see first/.test(turns[0].reply) && turns[1].brief === turns[2].brief && /only in summer/.test(turns[2].reply) && /fireflies please/.test(fs.readFileSync(path.join(dir, 'studio/liaison/chat.md'), 'utf8')), chat.stdout + chat.stderr);
  report('nothing reaches the queue until the dev confirms the brief', !/Fireflies/.test(fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8')));
}

// The Asset studio: rounds without waiting, thumbs up moves a file to assets/approved/ and queues its
// import, feedback by #number, the Producer approves provisionally when the dev is away, and references.
{
  const dir = copyRepo();
  const env = { STUDIO_PRODUCER_NAME: 'prod-1' };
  fs.mkdirSync(path.join(dir, 'art-out'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'art-out/gun.glb'), 'gun v1');
  const p1 = run(dir, 'node harness/art.mjs propose art-out/gun.glb --title "Yellow gun" --pack weapons --generated "agy:nano-banana" --prompt art-out/prompt.txt --terms "Google AI Pro" --by art-1', env);
  report('a proposed game file goes to assets/staging/<pack>/, numbered #1', p1.status === 0 && fs.existsSync(path.join(dir, 'assets/staging/weapons/gun.glb')) && /#1 Yellow gun/.test(p1.stdout), p1.stdout + p1.stderr);
  report('the assets gate ignores work in progress in staging', run(dir, 'node scripts/check-assets.mjs', env).status === 0);
  fs.writeFileSync(path.join(dir, 'art-out/gun2.glb'), 'gun v2');
  const p2 = run(dir, 'node harness/art.mjs propose art-out/gun2.glb --round-of 1 --pack weapons --by art-1', env);
  const list = run(dir, 'node harness/art.mjs', env).stdout;
  report('a new round keeps the asset\'s number and needs nobody\'s answer', p2.status === 0 && /#1 Yellow gun · round 2 · proposed/.test(list) && !/round 1/.test(list), list);
  const say = run(dir, 'node harness/art.mjs say "the yellow gun #1 is still clunky" --by hatch', env);
  report('feedback naming #1 gives the art department round 3 with the dev\'s words', say.status === 0 && /Art: round 3 of #1 Yellow gun: the yellow gun #1 is still clunky/.test(fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8')), say.stdout + say.stderr);
  fs.writeFileSync(path.join(dir, 'art-out/gun3.glb'), 'gun v3');
  run(dir, 'node harness/art.mjs propose art-out/gun3.glb --round-of 1 --pack weapons --by art-1', env);
  const up = run(dir, 'node harness/art.mjs approve 1 --by hatch', env);
  const man = JSON.parse(fs.readFileSync(path.join(dir, 'studio/assets/manifest.json'), 'utf8'));
  const gun = man.assets.find((a) => a.file === 'assets/approved/weapons/gun3.glb');
  report('a thumbs up moves the file to assets/approved/, records who made it and how, and queues its import', up.status === 0 && gun && gun.madeBy === 'art-1' && gun.declaredBy === 'hatch' && /generated \(agy, nano-banana\)/.test(gun.licence) && gun.generated?.terms === 'Google AI Pro' && /Import: wire asset #1 Yellow gun/.test(fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8')) && run(dir, 'node scripts/check-assets.mjs', env).status === 0, up.stdout + up.stderr + run(dir, 'node scripts/check-assets.mjs', env).stdout + fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8').split('\n').filter((l) => /Import/.test(l)).join(' '));
  fs.mkdirSync(path.join(dir, 'web/x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'web/x/main.mjs'), "const url = 'assets/staging/weapons/gun2.glb';\n");
  report('the assets gate fails when game code loads a file still in staging', /points at assets\/staging/.test(run(dir, 'node scripts/check-assets.mjs', env).stdout));
  fs.rmSync(path.join(dir, 'web/x'), { recursive: true });
  // The dev is away: past the pace's limit the Producer approves provisionally, logged and reversible.
  fs.writeFileSync(path.join(dir, 'art-out/lamp.png'), 'png');
  run(dir, 'node harness/art.mjs propose art-out/lamp.png --title "Hotel lamp" --pack props --by art-1', env);
  const designs = path.join(dir, 'studio/art/designs.json');
  const dj = JSON.parse(fs.readFileSync(designs, 'utf8'));
  dj.designs.find((d) => d.title === 'Hotel lamp').at = new Date(Date.now() - 25 * 3600000).toISOString();
  fs.writeFileSync(designs, JSON.stringify(dj));
  run(dir, 'node harness/art.mjs expire', env);
  const lamp = JSON.parse(fs.readFileSync(designs, 'utf8')).designs.find((d) => d.title === 'Hotel lamp');
  report('a design waiting past the pace\'s limit is approved provisionally by the Producer, logged for the dev', lamp.status === 'approved' && lamp.provisional === true && /Asset #\d+[\s\S]*Hotel lamp[\s\S]*provisionally by prod-1/.test(fs.readFileSync(path.join(dir, 'studio/decisions/decided-without-you.md'), 'utf8')), JSON.stringify(lamp));
  const back = run(dir, `node harness/art.mjs changes ${Number(lamp.asset.slice(2))} "too bright for the hotel" --by hatch`, env);
  report('the dev can still send a provisional approval back for another round', back.status === 0 && /round 2 of #\d+ Hotel lamp: too bright/.test(fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8')), back.stdout + back.stderr);
  // References from the dev, labelled: one to look at (never shipped), one of their own to use.
  fs.writeFileSync(path.join(dir, 'art-out/lobby.jpg'), 'jpg');
  fs.writeFileSync(path.join(dir, 'art-out/mygun.glb'), 'my gun');
  const look = run(dir, 'node harness/art.mjs ref art-out/lobby.jpg --label "the hotel lobby mood" --kind look --by hatch', env);
  const use = run(dir, 'node harness/art.mjs ref art-out/mygun.glb --label "my yellow gun model" --kind use --by hatch', env);
  const refs = JSON.parse(fs.readFileSync(path.join(dir, 'studio/art/references.json'), 'utf8')).references;
  report('references are labelled: "look" goes to the reference library, "use" is recorded as the dev\'s own asset', look.status === 0 && use.status === 0 && refs[0].kind === 'look' && refs[0].ref && refs[1].file === 'assets/own/mygun.glb' && JSON.parse(fs.readFileSync(path.join(dir, 'studio/assets/manifest.json'), 'utf8')).assets.some((a) => a.file === 'assets/own/mygun.glb' && a.declaredBy === 'hatch'), look.stdout + look.stderr + use.stdout + use.stderr);
  // The ledger: a whole pack from its MANIFEST.json, in place and namespaced, and re-recorded after a re-export.
  fs.mkdirSync(path.join(dir, 'assets/env/f1'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'assets/env/f1/desk.glb'), 'desk');
  fs.writeFileSync(path.join(dir, 'assets/env/f1/MANIFEST.json'), JSON.stringify({ madeBy: 'art-1', files: [{ file: 'desk.glb', author: 'Poly Haven', source: 'https://polyhaven.com/a/desk', licence: 'CC0' }, { file: 'MANIFEST.json', licence: 'own work' }] }));
  const imp = run(dir, 'node harness/assets.mjs import-manifest assets/env/f1/MANIFEST.json --by hatch --owner "Jed"', env);
  const desk = JSON.parse(fs.readFileSync(path.join(dir, 'studio/assets/manifest.json'), 'utf8')).assets.find((a) => a.file === 'assets/env/f1/desk.glb');
  report('a pack is recorded from its manifest in place, with author, source and rights kept apart', imp.status === 0 && desk && desk.author === 'Poly Haven' && desk.rightsHolder === 'Jed' && desk.madeBy === 'art-1' && desk.creditRequired === false, imp.stdout + imp.stderr + JSON.stringify(desk));
  fs.writeFileSync(path.join(dir, 'assets/env/f1/desk.glb'), 'desk v2');
  const upd = run(dir, 'node harness/assets.mjs update assets/env/f1/desk.glb --by hatch', env);
  report('npm run asset -- update re-records a re-exported file', upd.status === 0 && run(dir, 'node scripts/check-assets.mjs', env).status === 0, upd.stdout + upd.stderr);
}

// The browser play gate: the example game is won with real key presses while the screen matches the sim;
// a blank canvas, a frozen clock, a HUD that disagrees, the camera in a wall, or keys that never arrive all fail it.
{
  const dir = copyRepo();
  const chromium = process.env.PLAYWRIGHT_CHROMIUM || ['/opt/pw-browsers/chromium'].find((p) => fs.existsSync(p));
  const env = chromium ? { PLAYWRIGHT_CHROMIUM: chromium } : {};
  const skip = run(dir, 'node qa/browser-play.mjs --no-shots', env);
  report('without a browser, the template game only notes that the browser check was skipped', skip.status === 0 && /SKIP example-sim/.test(skip.stdout), skip.stdout + skip.stderr);
  const played = fs.existsSync(path.join(root, 'node_modules', 'playwright')) && (fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'junction'), run(dir, 'node qa/browser-play.mjs --no-shots', env));
  if (played && /PASS/.test(played.stdout)) {
    report('the example game is won in the browser with real key presses, the screen matching the sim', /won at tick \d+, [1-9]\d* real inputs/.test(played.stdout), played.stdout);
    const builds = run(dir, 'node harness/builds.mjs list', env).stdout;
    run(dir, 'node qa/browser-play.mjs --no-shots', env);
    report('a passing browser check saves the build for npm run play and the Arcade, once per change', (run(dir, 'node harness/builds.mjs list', env).stdout.match(/won at tick/g) || []).length === 1 && /won at tick/.test(builds) && fs.existsSync(path.join(dir, '.studio/builds', builds.split(/\s+/)[0], 'web/example-sim/index.html')), builds);
    fs.writeFileSync(path.join(dir, 'clipjs.mjs'), "import { serveBuildFile, buildPagePath } from './harness/builds.mjs';\nconst res = { writeHead() {}, end() {} };\nconsole.log(serveBuildFile('latest', '../../../package.json', res), serveBuildFile('latest', 'web/example-sim/main.mjs', res), serveBuildFile('latest', '', res), buildPagePath('latest'));\n");
    report('a saved build serves only its own files, and its root redirects to the page\'s own folder (Gemini: a black screen)', /^false true false web\/example-sim\/index\.html/.test(run(dir, 'node clipjs.mjs', env).stdout.trim()), run(dir, 'node clipjs.mjs', env).stdout);
    const clip = run(dir, 'node qa/clip.mjs --seconds 6 --task T-001', env);
    report('npm run clip records the real build and keeps the clip with the task', clip.status === 0 && /Saved qa\/reports\/clips\/clip_\w+\.(mp4|jpg)/.test(clip.stdout) && fs.readdirSync(path.join(dir, 'studio/proof/T-001')).length === 1, clip.stdout + clip.stderr);
    // A bot that can lose (test #2: 3 wins and 1 loss on the same build): a loss with the screen matching
    // the sim passes with a note and a replayable input trace, unless the cartridge says the bot must win.
    const QA_B = 'cartridges/example-sim/qa.mjs';
    const qaOrigB = fs.readFileSync(path.join(dir, QA_B), 'utf8');
    const hopeful = qaOrigB.replace("idle: { seed: 1337, maxTicks: 600, expect: 'lost' },", "idle: { seed: 1337, maxTicks: 600, expect: 'lost' },\n  hopeful: { seed: 1337, maxTicks: 600, expect: 'won' },").replace("scenario: 'start-to-win',", "scenario: 'hopeful',");
    fs.writeFileSync(path.join(dir, QA_B), hopeful);
    const lost = run(dir, 'node qa/browser-play.mjs --no-shots', env);
    report('a bot that loses while the screen matches the sim passes, with a note and a replayable input trace', lost.status === 0 && /note: the bot lost at tick \d+/.test(lost.stdout) && /--trace qa\/reports\/browser_\d+-inputs\.json/.test(lost.stdout), lost.stdout + lost.stderr);
    fs.writeFileSync(path.join(dir, QA_B), hopeful.replace("scenario: 'hopeful',", "scenario: 'hopeful',\n  mustWin: true,"));
    const must = run(dir, 'node qa/browser-play.mjs --no-shots', env);
    report('with browser.mustWin, a loss fails the browser check', must.status !== 0 && /BROWSER-NO-OUTCOME/.test(must.stdout + must.stderr), must.stdout + must.stderr);
    fs.writeFileSync(path.join(dir, QA_B), qaOrigB);
    const MAIN = 'web/example-sim/main.mjs';
    const orig = fs.readFileSync(path.join(dir, MAIN), 'utf8');
    const variant = (label, from, to, re) => {
      if (!orig.includes(from)) return report(`${label} (the planted change no longer applies to ${MAIN})`, false);
      fs.writeFileSync(path.join(dir, MAIN), orig.replace(from, to));
      const r = run(dir, 'node qa/browser-play.mjs --no-shots', env);
      report(label, r.status !== 0 && re.test(r.stderr), r.stderr + r.stdout);
    };
    variant('a blank canvas fails the browser check', "const ctx = canvas.getContext('2d');", 'const ctx = { fillRect() {} };', /BROWSER-BLANK/);
    variant('a clock that never moves fails it', 'state = step(state, acts.length ? acts : null);', 'void acts;', /BROWSER-FROZEN/);
    variant('a HUD that shows a different number from the sim fails it', "$('hud-credits').textContent = String(Math.floor(state.resources.credits));", "$('hud-credits').textContent = String(Math.floor(state.resources.credits) + 100);", /BROWSER-WIRING[^\n]*HUD credits/);
    variant('the camera inside geometry fails it', 'camera: { inside: false },', 'camera: { inside: state.tick > 40 },', /camera is inside geometry/);
    variant('keys that never reach the game fail it: start-to-win is not won, and the B control is dead', "if (e.key === 'b' || e.key === 'B') buy();", 'void e;', /CONTROL-DEAD: B buys a unit[\s\S]*BROWSER-NO-OUTCOME[^\n]*ended lost|BROWSER-NO-OUTCOME[^\n]*ended lost[\s\S]*CONTROL-DEAD: B buys a unit/);
    fs.writeFileSync(path.join(dir, MAIN), orig);
    // A bundled game: the check runs its build command and plays dist/, never a dev server.
    fs.mkdirSync(path.join(dir, 'dist/cartridges/example-sim'), { recursive: true });
    fs.copyFileSync(path.join(dir, 'web/example-sim/index.html'), path.join(dir, 'dist/index.html'));
    fs.writeFileSync(path.join(dir, 'dist/main.mjs'), orig.replace('../../cartridges/example-sim/index.mjs', './cartridges/example-sim/index.mjs'));
    fs.copyFileSync(path.join(dir, 'cartridges/example-sim/index.mjs'), path.join(dir, 'dist/cartridges/example-sim/index.mjs'));
    const QA = 'cartridges/example-sim/qa.mjs';
    const qaOrig = fs.readFileSync(path.join(dir, QA), 'utf8');
    fs.writeFileSync(path.join(dir, QA), qaOrig.replace("page: 'web/example-sim/index.html',", "dist: 'dist', build: 'node -e \"require(\\'fs\\').writeFileSync(\\'built.txt\\', \\'yes\\')\"',"));
    const distRun = run(dir, 'node qa/browser-play.mjs --no-shots', env);
    report('a bundled game is built and its dist/ played, not a dev server', distRun.status === 0 && /PASS/.test(distRun.stdout) && fs.existsSync(path.join(dir, 'built.txt')), distRun.stdout + distRun.stderr);
    fs.writeFileSync(path.join(dir, QA), qaOrig);
    fs.mkdirSync(path.join(dir, 'qa/regressions/browser'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'qa/regressions/browser/T-900.mjs'), "export async function check({ page }) {\n  const t = await page.locator('#end').innerText();\n  return { ok: t === 'You won.', why: `end text was \"${t}\"` };\n}\n");
    const withReg = run(dir, 'node qa/browser-play.mjs --no-shots', env);
    fs.writeFileSync(path.join(dir, 'qa/regressions/browser/T-900.mjs'), "export async function check() {\n  return { ok: false, why: 'the HUD flickers on win' };\n}\n");
    const badReg = run(dir, 'node qa/browser-play.mjs --no-shots', env);
    report('browser regressions run on the live page and fail the gate when they fail', withReg.status === 0 && badReg.status !== 0 && /BROWSER-REGRESSION: T-900\.mjs: the HUD flickers on win/.test(badReg.stderr), withReg.stdout + badReg.stderr);
  } else console.log(`[selftest] SKIP playing in the browser (no Chromium here: ${(played ? played.stdout : 'Playwright not installed').trim().split('\n')[0]})`);
}

// Renderer work: bugs carry a part; a renderer bug closes with a browser regression, and screenshots need
// a line each and a check by someone other than the builder.
{
  const dir = copyRepo();
  const env = { STUDIO_PRODUCER_NAME: 'prod-1' };
  report('--part only takes sim, renderer or both', run(dir, 'node harness/task.mjs add "HUD lags" --type bug --part ui', env).status !== 0);
  const id = JSON.parse(run(dir, 'node harness/task.mjs add "HUD shows last tick\'s credits" --type bug --part renderer', env).stdout).id;
  run(dir, `node harness/task.mjs start ${id} --agent builder-1`, env);
  const before = run(dir, `node harness/done-check.mjs ${id}`, env).stdout;
  report('a renderer bug asks for a browser regression and screenshots, not a sim seed and tick', /\[ \] Browser regression in qa\/regressions\/browser/.test(before) && /\[ \] Screenshots, each with a line/.test(before) && !/Regression saved with seed/.test(before), before);
  fs.mkdirSync(path.join(dir, 'qa/regressions/browser'), { recursive: true });
  fs.writeFileSync(path.join(dir, `qa/regressions/browser/${id}.mjs`), 'export async function check() { return { ok: true }; }\n');
  fs.mkdirSync(path.join(dir, 'qa/reports'), { recursive: true });
  fs.writeFileSync(path.join(dir, `qa/reports/browser_${Date.now() + 5000}.json`), JSON.stringify({ passed: true, at: new Date(Date.now() + 5000).toISOString(), regressions: [{ file: `qa/regressions/browser/${id}.mjs`, ok: true }] }));
  fs.writeFileSync(path.join(dir, 'qa/reports/browser_1-end.png'), 'png');
  const short = run(dir, `node harness/proof.mjs add ${id} qa/reports/browser_1-end.png "the HUD"`, env);
  report('a screenshot needs a line that says what it shows', short.status !== 0 && /at least six words/.test(short.stderr), short.stderr);
  run(dir, `node harness/proof.mjs add ${id} qa/reports/browser_1-end.png "the HUD reads 5839 credits the same tick the sim does" --by builder-1`, env);
  report('the screenshot is kept with the proof, so it travels with the commit', fs.existsSync(path.join(dir, `studio/proof/${id}/browser_1-end.png`)) && /the HUD reads 5839 credits/.test(fs.readFileSync(path.join(dir, `studio/proof/${id}.md`), 'utf8')));
  report('the builder can\'t check their own screenshots', run(dir, `node harness/proof.mjs check ${id} --by builder-1 --verdict matches`, env).status !== 0);
  const wrong = run(dir, `node harness/proof.mjs check ${id} --by hatch --verdict wrong --note "the HUD in the image says 5739"`, env);
  const mid = run(dir, `node harness/done-check.mjs ${id}`, env).stdout;
  report('a check that says the image doesn\'t match keeps the task open, with the reason', wrong.status === 0 && /\[ \] Checked by someone other than the builder: the last check said they don't match: the HUD in the image says 5739/.test(mid), mid);
  run(dir, `node harness/proof.mjs check ${id} --by hatch --verdict matches`, env);
  const after = run(dir, `node harness/done-check.mjs ${id}`, env).stdout;
  report('with a browser regression, a passing browser play after it, and checked screenshots, those checks pass', /\[x\] Browser regression/.test(after) && /\[x\] Browser play passed with the regression/.test(after) && /\[x\] Screenshots, each with a line/.test(after) && /\[x\] Checked by someone other than the builder/.test(after), after);
}

// Run #1's art agent notes: forced work grouped by cause and accepted once; agents credited for their own
// notes; rooms that open for the agents in them; out-of-quota isn't "stalled"; a second game gets its own studio.
{
  const dir = copyRepo();
  const env = { STUDIO_PRODUCER_NAME: 'prod-1' };
  const add = (t) => JSON.parse(run(dir, `node harness/task.mjs add "${t}"`, env).stdout).id;
  const force = (id) => {
    run(dir, `node harness/task.mjs start ${id} --agent builder-1`, env);
    return run(dir, `node harness/task.mjs done ${id} --agent builder-1 --force --reason "selftest forced close"`, env);
  };
  const [a, b, c] = [add('Tidy the HUD label'), add('Tidy the menu label'), add('Tidy the end label')];
  force(a);
  force(b);
  const q1 = fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8');
  const checks = q1.split('\n').filter((l) => /Check forced done/.test(l));
  report('two tasks forced past the same cause share one check task', checks.length === 1 && checks[0].includes(`${a}, ${b}`), checks.join('\n'));
  report('an agent can\'t accept a cause for the run', run(dir, 'node harness/causes.mjs accept "x" --by prod-1', env).status !== 0);
  const cause = (run(dir, 'node harness/causes.mjs', env).stdout.match(/accept "([^"]+)"/) || [])[1];
  const acc = run(dir, `node harness/causes.mjs accept "${cause}" --by hatch --why "known: no git here"`, env);
  force(c);
  const q2 = fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8') + fs.readFileSync(path.join(dir, 'studio/DONE.md'), 'utf8'); // 2.30c: done tasks are in DONE.md
  report('accepting a cause closes its check task, and later tasks forced for it don\'t ask again', acc.status === 0 && !/- \[ \][^\n]*Check forced done/.test(q2) && /\[x\][^\n]*Check forced done/.test(q2), acc.stdout + acc.stderr + q2);
  run(dir, 'node harness/notes.mjs add --kind bad "the agy line exits early"', { ...env, STUDIO_LOCK_OWNER: 'art-1' });
  report('a note is credited to the agent that wrote it, not the Producer', /· art-1\] the agy line exits early/.test(fs.readFileSync(path.join(dir, 'studio/harness-notes/NOTES.md'), 'utf8')));
  run(dir, 'node harness/event.mjs --type task.progress --agent audio-1 --msg "menu music"', env);
  run(dir, 'node harness/event.mjs --type task.paused --agent builder-3 --msg "Handed back: usage limit, resets 06:12"', env);
  fs.writeFileSync(path.join(dir, 'hudjson.mjs'), "import { buildHudState } from './harness/hud.mjs';\nconsole.log(JSON.stringify(buildHudState()));\n");
  const hud = JSON.parse(run(dir, 'node hudjson.mjs', env).stdout || '{}');
  const audio = (hud.agents || []).find((x) => x.name === 'audio-1');
  const sound = (hud.divisions || []).find((d) => d.id === 'sound');
  report('an agent named for its work sits in its room, and the room opens for it', audio?.room === 'sound' && sound?.active === true && sound?.autoOn === true, JSON.stringify({ audio, sound }));
  const b3 = (hud.agents || []).find((x) => x.name === 'builder-3');
  report('an agent out of quota shows when it resets, and isn\'t listed as stalled', b3?.status === 'out-of-quota' && b3?.quotaUntil === '06:12' && !(hud.signals?.stalled || []).some((x) => /builder-3/.test(x)), JSON.stringify(b3));
  report('tokens nobody measured say "not tracked" instead of 0', hud.tokens?.tracked === false && /not tracked/.test(hud.tokens?.why || ''), JSON.stringify(hud.tokens));
  // A second game: its own studio in a sibling folder, never a folder made by hand.
  const git = (cmd) => run(dir, `git -c user.name=selftest -c user.email=selftest@example.com ${cmd}`);
  git('init -q');
  git('add -A');
  git('commit -q -m init --no-verify');
  const second = path.join(tmpRoot, `second-studio-${n}`);
  const ns = run(dir, `node scripts/new-studio.mjs --name "Moss Garden" --dir "${second}" --from local --no-install`, env);
  report('npm run new-studio makes a second studio next to this one, with its own War Room port and a fresh board', ns.status === 0 && /HUB_PORT=3848/.test(fs.readFileSync(path.join(second, '.env'), 'utf8')) && /Moss Garden/.test(fs.readFileSync(path.join(second, 'studio/NEXT.md'), 'utf8')) && fs.existsSync(path.join(second, 'START-HERE.md')), ns.stdout + ns.stderr);
  // A setup plugged in by the game dev or an agent: its roles, departments and settings, never keys or harness code.
  const setup = path.join(tmpRoot, `setup-${n}`);
  fs.mkdirSync(path.join(setup, 'studio/roles'), { recursive: true });
  fs.mkdirSync(path.join(setup, 'harness'), { recursive: true });
  fs.writeFileSync(path.join(setup, 'studio/roles/level-designer.md'), '# level-designer\n');
  fs.writeFileSync(path.join(setup, 'studio/divisions.json'), JSON.stringify({ divisions: [{ id: 'hacks', active: true }] }));
  fs.writeFileSync(path.join(setup, 'settings.env'), 'STUDIO_AGENT_TOOL=claude\nSTUDIO_FAKE_TOKEN=do-not-copy\nHUB_PORT=9999\n');
  fs.writeFileSync(path.join(setup, 'harness/evil.mjs'), 'process.exit(1)\n');
  const third = path.join(tmpRoot, `third-studio-${n}`);
  const ns3 = run(dir, `node scripts/new-studio.mjs --name "Tin Moon" --dir "${third}" --from local --no-install --setup "${setup}"`, env);
  const env3 = fs.existsSync(path.join(third, '.env')) ? fs.readFileSync(path.join(third, '.env'), 'utf8') : '';
  report('a third game gets the next free port, and a plugged-in setup brings roles, departments and settings but never keys or harness code', ns3.status === 0 && /^HUB_PORT=3849$/m.test(env3) && !/9999/.test(env3) && /STUDIO_AGENT_TOOL=claude/.test(env3) && !/do-not-copy/.test(env3) && fs.existsSync(path.join(third, 'studio/roles/level-designer.md')) && !fs.existsSync(path.join(third, 'harness/evil.mjs')) && /hacks/.test(fs.readFileSync(path.join(third, 'studio/divisions.json'), 'utf8')), ns3.stdout + ns3.stderr + env3);
  const saved = path.join(tmpRoot, `saved-setup-${n}`);
  const sv = run(third, `node scripts/new-studio.mjs --save-setup "${saved}"`, env);
  report('a studio saves its setup to reuse for the next game, without its keys', sv.status === 0 && fs.existsSync(path.join(saved, 'studio/roles/level-designer.md')) && !/do-not-copy/.test(fs.existsSync(path.join(saved, 'settings.env')) ? fs.readFileSync(path.join(saved, 'settings.env'), 'utf8') : ''), sv.stdout + sv.stderr);
}

// npm run review: a local model from another company reviews a task's commits and its verdict closes a system task.
{
  const http = await import('node:http');
  let answer = 'VERDICT: APPROVE\nWHY: The visitor rate is seeded and tested; the hand-off explains the tuning.\nISSUES:\n- none';
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'qwen2.5-coder:14b', choices: [{ message: { role: 'assistant', content: answer } }], usage: { prompt_tokens: 900, completion_tokens: 60 } }));
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const ollama = { OLLAMA_BASE_URL: `http://127.0.0.1:${fake.address().port}/v1`, OLLAMA_MODEL: 'qwen2.5-coder:14b', STUDIO_PRODUCER_NAME: 'prod-1' };
  const dir = copyRepo();
  const git = (cmd) => run(dir, `git -c user.name=selftest -c user.email=selftest@example.com ${cmd}`);
  git('init -q');
  git('add -A');
  git('commit -q -m init --no-verify');
  const id = JSON.parse(run(dir, 'node harness/task.mjs add "Visitors" --type system --origin dev', ollama).stdout).id;
  run(dir, `node harness/task.mjs start ${id} --agent builder-1 --model claude-opus-5-5`, ollama);
  fs.mkdirSync(path.join(dir, 'studio/bible/systems'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'studio/bible/systems/visitors.md'), `# Visitors (${id})\n\n${'Visitors arrive after the first terrace opens and rate the garden by moss coverage and paths. '.repeat(6)}\n\n## For the next agent\n\nTUNING.visitorRate sets arrivals.\n`);
  edit(dir, 'cartridges/example-sim/qa.mjs', (s) => `${s}\n// visitors scenario\n`);
  edit(dir, 'cartridges/example-sim/index.mjs', (s) => s.replace('startCredits: 1500,', 'startCredits: 1550,'));
  run(dir, 'node qa/check-golden.mjs --update');
  run(dir, 'node qa/check-regressions.mjs --update');
  run(dir, 'node qa/playtest.mjs --stage 1 --quiet');
  git('add -A');
  git(`commit -q -m visitors --no-verify --trailer "Studio-Task: ${id}"`);
  // 2.58.0 (PU-34): a verify counts only for the commit it ran on, with a clean tree.
  fs.writeFileSync(path.join(dir, '.studio/gates-last.json'), JSON.stringify({ at: new Date(Date.now() + 5000).toISOString(), head: git('rev-parse HEAD').stdout.trim(), dirty: false, rows: [{ id: 'golden', required: true, ok: true }] }));
  const rv = await runAsync(dir, `node harness/review.mjs ${id} --local`, ollama);
  const files = fs.readdirSync(path.join(dir, 'studio/reviews')).filter((f) => f.includes(id));
  const text = files[0] ? fs.readFileSync(path.join(dir, 'studio/reviews', files[0]), 'utf8') : '';
  report('npm run review -- --local writes a review with both families and one verdict', rv.status === 0 && /model-family: qwen/.test(text) && /implementer-family: anthropic/.test(text) && /Verdict: approve/.test(text), rv.stdout + rv.stderr + text);
  const dc = run(dir, `node harness/done-check.mjs ${id}`, ollama);
  report('that approval satisfies the system task\'s cross-family review', /\[x\] Approved by a reviewer from another model family/.test(dc.stdout), dc.stdout);
  answer = 'The diff looks mostly fine but I would approve only after a test.\nISSUES:\n- qa.mjs: no scenario';
  fs.rmSync(path.join(dir, 'studio/reviews', files[0]));
  await runAsync(dir, `node harness/review.mjs ${id} --local`, ollama);
  const vague = fs.readdirSync(path.join(dir, 'studio/reviews')).filter((f) => f.includes(id)).map((f) => fs.readFileSync(path.join(dir, 'studio/reviews', f), 'utf8')).join('');
  report('a review without a clear verdict counts as changes, even if it says approve in passing', /Verdict: request changes/.test(vague) && /\[ \] Approved by a reviewer/.test(run(dir, `node harness/done-check.mjs ${id}`, ollama).stdout), vague);
  fake.close();
}

// Cheap prepare, strong act: short history skips the model; a cheap model's draft is checked; a bad draft is thrown away.
{
  const dir = copyRepo();
  const add = (cmd) => JSON.parse(run(dir, cmd).stdout).id;
  const short = add('node harness/task.mjs add "Tidy the readme" --type docs');
  const quick = run(dir, `node harness/prepare-brief.mjs ${short} --model`);
  report('prepare skips the model when the history is short', quick.status === 0 && /no model was called/.test(quick.stdout), quick.stdout + quick.stderr);

  const id = add('node harness/task.mjs add "Spawn overlap at tick 40" --type bug');
  const lines = Array.from({ length: 40 }, (_, i) => JSON.stringify({ ts: new Date(Date.now() - (40 - i) * 60000).toISOString(), type: 'agent.note', agent: 'alice-1', task: id, target: 'cartridges/example-sim/index.mjs', msg: `try ${i}: changed spawn spacing, the replay at seed 1337 still overlaps two vehicles at tick 40 after the queue refills` }));
  fs.appendFileSync(path.join(dir, '.studio/events.jsonl'), `${lines.join('\n')}\n`);
  const fake = path.join(dir, 'fake-model.mjs');
  fs.writeFileSync(fake, `import http from 'node:http'; import fs from 'node:fs';
const s = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
  const content = fs.readFileSync(process.argv[2], 'utf8');
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ model: 'fake-cheap', choices: [{ message: { content } }], usage: { prompt_tokens: 900, completion_tokens: 120 } }));
}); });
s.listen(0, '127.0.0.1', () => console.log(s.address().port));`);
  const reply = path.join(dir, 'fake-reply.md');
  const server = spawn(process.execPath, [fake, reply], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((r) => server.stdout.once('data', (d) => r(String(d).trim())));
  const env = { OLLAMA_BASE_URL: `http://127.0.0.1:${port}/v1`, STUDIO_PREPARE_CHAIN: 'ollama-local' };
  fs.writeFileSync(reply, `## Goal\nFix ${id}: vehicles overlap at tick 40.\n\n## Relevant history\n- 40 tries changed spawn spacing; the seed 1337 replay still overlaps.\n\n## Known pitfalls\n- Spacing alone doesn't fix it; look at the queue refill.\n\n## Files to touch\n- cartridges/example-sim/index.mjs\n\n## Verify\n- node harness/done-check.mjs ${id}\n`);
  const good = await runAsync(dir, `node harness/prepare-brief.mjs ${id} --model`, env);
  const goodBrief = fs.readFileSync(path.join(dir, `.studio/briefs/${id}.prepared.md`), 'utf8');
  report('a cheap model drafts the brief and the check accepts it', good.status === 0 && /Prepared by ollama-local \(fake-cheap\)/.test(goodBrief) && /queue refill/.test(goodBrief), good.stdout + good.stderr);
  fs.writeFileSync(reply, `Here is everything: ${'long rambling text '.repeat(200)} see harness/does-not-exist.mjs and T-999`);
  const bad = await runAsync(dir, `node harness/prepare-brief.mjs ${id} --model`, env);
  const badBrief = fs.readFileSync(path.join(dir, `.studio/briefs/${id}.prepared.md`), 'utf8');
  report('a draft that fails the check is thrown away and the script writes the brief', bad.status === 0 && /Prepared by a script/.test(badBrief) && /failed checks/.test(badBrief) && /missing section/.test(badBrief), badBrief);
  server.kill();
  const ev = fs.readFileSync(path.join(dir, '.studio/events.jsonl'), 'utf8');
  report('the Producer sees each prepared brief with words in and out', /"type":"brief\.prepared"[^\n]*"to":"producer"[^\n]*words of history in/.test(ev));
}

// Agents get a one-page brief on start and a kickoff prompt; harness notes survive a studio reset.
{
  const dir = copyRepo();
  const start = run(dir, 'node harness/task.mjs start T-003 --agent claude-a --model model-x');
  const brief = fs.existsSync(path.join(dir, '.studio/briefs/T-003.md')) ? fs.readFileSync(path.join(dir, '.studio/briefs/T-003.md'), 'utf8') : '';
  report('task start writes a focus brief with done-means, steps and finish commands', /Your brief: \.studio\/briefs\/T-003\.md/.test(start.stderr) && /## Done means/.test(brief) && /## Steps/.test(brief) && /task\.mjs done T-003 --agent claude-a/.test(brief), `${start.stderr}\n${brief}`);
  const kick = run(dir, 'node harness/kickoff.mjs --role builder --agent claude-a --model model-x');
  report('kickoff prints a paste-ready loop for the agent', kick.status === 0 && /export STUDIO_LOCK_OWNER=claude-a STUDIO_AGENT_MODEL=model-x/.test(kick.stdout) && /task\.mjs pause/.test(kick.stdout));
  report('kickoff refuses a shared agent name', run(dir, 'node harness/kickoff.mjs --role builder --agent claude').status !== 0);
  run(dir, 'node harness/notes.mjs add --kind workaround "Rerun the done-check by hand on suspicious work"');
  run(dir, 'node scripts/studio-reset.mjs --name "Next Game" --yes');
  report('harness notes survive a studio reset and show in the briefing', /Rerun the done-check by hand/.test(fs.readFileSync(path.join(dir, 'studio/harness-notes/NOTES.md'), 'utf8')) && /Workaround: Rerun the done-check by hand/.test(run(dir, 'node harness/handoff.mjs --full').stdout));
}

// The pre-commit hook blocks a staged file locked by someone else, and a staged secret.
{
  const dir = copyRepo();
  const git = (cmd) => run(dir, `git -c user.name=selftest -c user.email=selftest@example.com ${cmd}`);
  git('init -q');
  git('add -A');
  git('commit -q -m init --no-verify');
  run(dir, 'node scripts/install-hooks.mjs');
  run(dir, 'node harness/lock.mjs claim path:cartridges --owner alice-1 --wide "selftest"');
  edit(dir, 'cartridges/example-sim/qa.mjs', (s) => `${s}\n// touch\n`);
  git('add cartridges/example-sim/qa.mjs');
  report('pre-commit blocks a file locked by another agent', run(dir, 'git -c user.name=t -c user.email=t@example.com commit -q -m x', { STUDIO_LOCK_OWNER: 'bob-1' }).status !== 0);
  git('reset -q');
  run(dir, 'node harness/lock.mjs claim task:T-004 --owner bob-1');
  fs.writeFileSync(path.join(dir, 'studio/reviews/trailer-test.md'), 'x\n');
  git('add studio/reviews/trailer-test.md');
  run(dir, 'git -c user.name=t -c user.email=t@example.com commit -q -m "trailer test"', { STUDIO_LOCK_OWNER: 'bob-1', STUDIO_AGENT_MODEL: 'model-y' });
  const body = run(dir, 'git log -1 --format=%B').stdout;
  report('commit-msg adds Studio-Agent, Studio-Model and Studio-Task trailers', /Studio-Agent: bob-1/.test(body) && /Studio-Model: model-y/.test(body) && /Studio-Task: T-004/.test(body), body);
  edit(dir, 'qa/golden/example-sim-start-to-win.json', (s) => s.replace('"tick": 300', '"tick": 312'));
  git('add qa/golden/example-sim-start-to-win.json');
  const noWhy = run(dir, 'git -c user.name=t -c user.email=t@example.com commit -q -m "re-record"', { STUDIO_LOCK_OWNER: 'bob-1' });
  const why = run(dir, 'git -c user.name=t -c user.email=t@example.com commit -q -m "re-record" -m "Golden-Reason: the bounds fix moves the win"', { STUDIO_LOCK_OWNER: 'bob-1' });
  const gbody = run(dir, 'git log -1 --format=%B').stdout;
  report('a golden change needs a Golden-Reason, and the commit records which numbers moved', noWhy.status !== 0 && /Golden-Reason/.test(noWhy.stdout + noWhy.stderr) && why.status === 0 && /Golden-Diff: example-sim-start-to-win: tick 300 → 312/.test(gbody), noWhy.stdout + noWhy.stderr + gbody);
  fs.writeFileSync(path.join(dir, 'notes.txt'), `key ${'gsk_'}${'b'.repeat(30)}\n`);
  git('add notes.txt');
  report('pre-commit blocks a staged secret', run(dir, 'git -c user.name=t -c user.email=t@example.com commit -q -m y', { STUDIO_LOCK_OWNER: 'bob-1' }).status !== 0);
  git('reset -q');
  fs.rmSync(path.join(dir, 'notes.txt'));
  fs.writeFileSync(path.join(dir, '.studio/harness-frozen'), 'test run\n');
  edit(dir, 'harness/hash.mjs', (s) => `${s}\n// tweak\n`);
  git('add harness/hash.mjs');
  const frozen = run(dir, 'git -c user.name=t -c user.email=t@example.com commit -q -m z', { STUDIO_LOCK_OWNER: 'bob-1' });
  report('a frozen harness refuses commits to harness files during a test run', frozen.status !== 0 && /harness is frozen/.test(frozen.stdout + frozen.stderr), frozen.stdout + frozen.stderr);
  git('reset -q');
  fs.writeFileSync(path.join(dir, 'studio/reviews/game-note.md'), 'game work\n');
  git('add studio/reviews/game-note.md');
  report('game and studio files still commit while the harness is frozen', run(dir, 'git -c user.name=t -c user.email=t@example.com commit -q -m g', { STUDIO_LOCK_OWNER: 'bob-1' }).status === 0);
}

// Test runs: the stop switch holds every start; the run report gathers results in one folder.
{
  const dir = copyRepo();
  const env = { STUDIO_PRODUCER_NAME: 'prod-1' };
  run(dir, 'node harness/task.mjs stop --by hatch --reason "checking costs"', env);
  const blocked = run(dir, 'node harness/task.mjs start T-001 --agent builder-1', env);
  report('while the studio is stopped no task can start', blocked.status !== 0 && /studio is stopped/.test(blocked.stderr), blocked.stdout + blocked.stderr);
  run(dir, 'node harness/task.mjs resume --by hatch', env);
  report('after resuming, tasks start again', run(dir, 'node harness/task.mjs start T-001 --agent builder-1', env).status === 0);
  const to = path.join(tmpRoot, `results-${n}`);
  run(dir, 'npm run notes -- add --kind bad "the brief missed the golden step"', env);
  const rr = run(dir, `node harness/run-report.mjs --to "${to}" --final`, env);
  const made = fs.existsSync(to) ? fs.readdirSync(to) : [];
  const rep = made[0] ? fs.readFileSync(path.join(to, made[0], 'REPORT.md'), 'utf8') : '';
  const to2 = path.join(tmpRoot, `results-env-${n}`);
  fs.writeFileSync(path.join(dir, '.env'), `STUDIO_RESULTS_DIR=\nHUB_TOKEN=change-me-local-only\nSTUDIO_RESULTS_DIR=${to2}\n`);
  const fromEnv = run(dir, 'node harness/run-report.mjs', env);
  report('settings in .env reach every command, and a value added below the empty example line wins', fromEnv.status === 0 && fs.existsSync(to2), fromEnv.stdout + fromEnv.stderr);
  fs.writeFileSync(path.join(dir, '.env'), 'GEMINI_API_KEY=\r\nVERTEX_API_KEY=\r\nNVIDIA_API_KEY=\r\nXAI_API_KEY=\r\n');
  const pf = run(dir, 'node scripts/preflight.mjs --quick', env).stdout;
  report('preflight sees no keys when every key line is empty (an empty line never borrows the next)', /No router keys set/.test(pf), pf);
  fs.rmSync(path.join(dir, '.env'));
  report('the run report writes REPORT.md, a snapshot and the event log to the results folder', rr.status === 0 && /Final report/.test(rep) && /the brief missed the golden step/.test(rep) && fs.readdirSync(path.join(to, made[0], 'snapshots')).length === 1 && fs.existsSync(path.join(to, made[0], 'files/events.jsonl.gz')), rr.stdout + rr.stderr + rep.slice(0, 400));
}

// The closed loop records the tick the cartridge failed on, and the trace replays to it.
{
  const dir = copyRepo();
  edit(dir, SIM, plantInvariant(37));
  const loop = run(dir, 'node harness/closed-loop.mjs');
  let trace = {};
  try {
    trace = JSON.parse(fs.readFileSync(path.join(dir, '.studio/last-seed-failure.json'), 'utf8'));
  } catch {
    // reported below
  }
  report('closed loop exits 1 and records failing tick 37 from the cartridge', loop.status === 1 && trace.tick === 37, `${loop.stdout}${loop.stderr}`);
  const rep = run(dir, 'node harness/replay.mjs --trace .studio/last-seed-failure.json');
  report('replaying the trace stops on tick 37', rep.status === 1 && /"failingTick": 37/.test(rep.stdout), rep.stdout);
}

// 2.28: measured tokens, Lite scope, park --until, a hand-back note that names a blocker, FIX 06, lock renewal.
{
  const dir = copyRepo();
  const ev = path.join(dir, '.studio', 'events.jsonl');
  const now = Date.now();
  const at = (minAgo) => new Date(now - minAgo * 60000).toISOString();
  const lines = [
    { ts: at(30), type: 'agent.session.start', agent: 'builder-x1', model: 'claude-opus-5-5', meta: { role: 'builder', tool: 'claude' } },
    { ts: at(20), type: 'task.done', agent: 'builder-x1', task: 'T-900' },
    { ts: at(19), type: 'agent.session.end', agent: 'builder-x1', model: 'claude-opus-5-5', tokensIn: 1000, tokensOut: 200, meta: { role: 'builder', tool: 'claude', cacheRead: 50000, turns: 12 } },
    { ts: at(15), type: 'agent.session.start', agent: 'art-x1', model: 'gemini', meta: { role: 'art', tool: 'agy' } },
    { ts: at(10), type: 'agent.session.end', agent: 'art-x1', model: 'gemini', tokensIn: 0, tokensOut: 0, meta: { role: 'art', tool: 'agy' } },
  ];
  fs.appendFileSync(ev, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const tk = run(dir, 'node harness/tokens.mjs --since 5h --json');
  let t = {};
  try {
    t = JSON.parse(tk.stdout);
  } catch {}
  report('npm run tokens sums what sessions reported and lists the ones that reported nothing', t.total?.cacheRead === 50000 && t.total?.tokensIn === 1000 && t.total?.turns === 12 && t.untracked?.agy === 1 && t.byRole?.find((r) => r.name === 'builder')?.tasksDone === 1, tk.stdout + tk.stderr);
  const hud = JSON.parse(run(dir, `node -e "import('./harness/hud.mjs').then(m=>console.log(JSON.stringify(m.buildHudState().tokenUse)))"`).stdout || '{}');
  report('the War Room gets the measured totals for the last 5 h', hud.last5h?.total?.cacheRead === 50000, JSON.stringify(hud).slice(0, 300));
  const noFake = ['hub/index.html', 'hub/server.mjs', 'scripts/pre-compact.mjs', 'scripts/append-event.mjs', 'scripts/seed-demo-events.mjs'].filter((f) => /248,500|tokensSaved: \d|--tokens-saved \d|--saved \d/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  report('no made-up token numbers are left in the War Room or the scripts', noFake.length === 0, noFake.join(', '));

  // Lite scope: 6 gates, AGENTS.lite.md, ten commands.
  run(dir, 'node harness/mode.mjs scope lite --by hatch');
  const lite = run(dir, 'node scripts/run-gates.mjs --only purity,isolation');
  const help = run(dir, 'node harness/help.mjs');
  const claudeMd = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  report('Lite scope: CLAUDE.md loads AGENTS.lite.md, help shows ten commands', /@AGENTS\.lite\.md/.test(claudeMd) && !/@AGENTS\.md/.test(claudeMd) && (help.stdout.match(/npm(\.cmd)? run /g) || []).length <= 12 && lite.status === 0, claudeMd + help.stdout);
  report('AGENTS.lite.md stays short (under 1k tokens)', fs.statSync(path.join(dir, 'AGENTS.lite.md')).size < 4000, String(fs.statSync(path.join(dir, 'AGENTS.lite.md')).size));
  run(dir, 'node harness/mode.mjs scope full --by hatch');
  report('Full scope puts AGENTS.md back in CLAUDE.md', /@AGENTS\.md/.test(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')));

  // park --until: a park that ends by itself.
  const add = (title) => (run(dir, `node harness/task.mjs add "${title}" --role builder --priority P2`).stdout.match(/T-\d+/) || [])[0];
  const a = add('Park test A');
  const b = add('Park test B');
  run(dir, `node harness/task.mjs park ${a} --by hatch --why "wait" --until ${new Date(now - 60000).toISOString()}`);
  run(dir, `node harness/task.mjs park ${b} --by hatch --why "wait" --until phase:9`);
  const holds = run(dir, `node -e "import('./harness/task-hold.mjs').then(async (h)=>{const {parseNextQueue}=await import('./harness/task.mjs');const q=parseNextQueue();console.log(JSON.stringify([h.holdReason('${a}',q),h.holdReason('${b}',q)]))})"`);
  let hr = [];
  try {
    hr = JSON.parse(holds.stdout.trim().split('\n').pop());
  } catch {}
  report('a park with --until ends by itself (a time passed), and holds until its phase opens', hr[0] === null && /parked by hatch/.test(hr[1] || ''), holds.stdout + holds.stderr);

  // A hand-back note that names a blocker holds the task until the blocker is done.
  const c = add('Blocked test C');
  run(dir, `node harness/task.mjs start ${c} --agent sel-w1`, { STUDIO_LOCK_OWNER: 'sel-w1' });
  const p = run(dir, `node harness/task.mjs pause ${c} --agent sel-w1 --note "blocked by ${a}: needs its floor first"`, { STUDIO_LOCK_OWNER: 'sel-w1' });
  report('"blocked by T-x" in a hand-back note holds the task until T-x is done', /held until/.test(p.stdout) && (JSON.parse(fs.readFileSync(path.join(dir, 'studio/task-holds.json'), 'utf8')).tasks?.[c]?.after || []).includes(a), p.stdout + p.stderr);
  const p2 = run(dir, `node harness/task.mjs pause ${c} --agent sel-w1`, { STUDIO_LOCK_OWNER: 'sel-w1' });
  report('pause says why when the task is not in progress', p2.status === 1 && /already in the queue/.test(p2.stderr), p2.stderr);

  // FIX 06: a same-family note that says it isn't an approval is moved and owed, not a red gate.
  fs.mkdirSync(path.join(dir, 'studio/reviews'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'studio/reviews/2026-10-21-T-166.md'), '# Review T-166\nmodel-family: claude-opus-5-5\nimplementer-family: claude-opus-5-5\nThis note is not a cross-family approval.\n');
  const before = run(dir, 'node scripts/check-reviewer.mjs');
  run(dir, 'node scripts/preflight.mjs --fix --quick');
  const after = run(dir, 'node scripts/check-reviewer.mjs');
  const owed = fs.existsSync(path.join(dir, 'studio/reviews/OWED.json')) ? fs.readFileSync(path.join(dir, 'studio/reviews/OWED.json'), 'utf8') : '';
  report('FIX 06: preflight --fix moves a self-declared same-family note and records the review as owed', before.status === 1 && /preflight -- --fix/.test(before.stderr) && after.status === 0 && fs.existsSync(path.join(dir, 'studio/reviews/same-family/2026-10-21-T-166.md')) && /T-166/.test(owed), before.stderr + after.stdout + after.stderr + owed);

  // The heartbeat renews claims.
  const lk = run(dir, `node -e "import('./harness/lock.mjs').then(m=>{m.claim('path:game/x','sel-r1',60);const n=m.renewOwner('sel-r1',3600);console.log(n, m.listLocks().find(l=>l.owner==='sel-r1').expiresAt)})"`);
  const [n, exp] = lk.stdout.trim().split(' ');
  report('the heartbeat renews an agent\'s claims', n === '1' && Date.parse(exp) > now + 50 * 60000, lk.stdout + lk.stderr);
}

// 2.29: one working copy per lane. An agent with a code lane works in .lanes/<agent> on its own branch;
// task done adds its commits to the studio's branch; a hand-back keeps its commits for the next agent.
{
  const dir = copyRepo();
  const g = (cmd) => run(dir, `git -c user.email=t@t -c user.name=t ${cmd}`);
  g('init -q -b main');
  g('add -A');
  g('commit -qm base');
  const support = run(dir, `node -e "import('./harness/worktree.mjs').then(m=>console.log(JSON.stringify(m.worktreeSupport())))"`);
  if (!/"ok":true/.test(support.stdout)) {
    report('lane copies: skipped, this machine can\'t make them', true, support.stdout);
  } else {
    const agentJs = (quit, noDone = false) => `import { spawnSync } from 'node:child_process';\nimport fs from 'node:fs';\nconst [task, agent] = process.argv.slice(2);\nconst sh = (cmd) => { const r = spawnSync(cmd, { shell: true, encoding: 'utf8' }); console.log('$ ' + cmd + '\\n' + r.stdout + r.stderr + '[exit ' + r.status + ']'); return r; };\nconsole.log('cwd ' + process.cwd());\nsh('node harness/task.mjs start ' + task + ' --agent ' + agent);\nfs.appendFileSync('cartridges/example-sim/index.mjs', '\\n// ' + agent + '\\n');\nsh('git status --porcelain');\nsh('git -c user.email=a@b -c user.name=' + agent + ' commit -qam "' + task + ': ' + agent + '"');\n${quit ? "fs.appendFileSync('cartridges/example-sim/index.mjs', '\\n// uncommitted\\n');" : noDone ? "sh('node scripts/run-gates.mjs');" : "sh('node scripts/run-gates.mjs');\nsh('node harness/task.mjs done ' + task + ' --agent ' + agent);"}\n`;
    fs.writeFileSync(path.join(tmpRoot, 'lane-agent.mjs'), agentJs(false));
    fs.writeFileSync(path.join(tmpRoot, 'lane-quit.mjs'), agentJs(true));
    fs.writeFileSync(path.join(tmpRoot, 'lane-nodone.mjs'), agentJs(false, true));
    const add = (title) => (run(dir, `node harness/task.mjs add "${title}" --role builder --priority P1 --lane cartridges/example-sim`).stdout.match(/"id": "(T-\d+)"/) || [])[1];
    const t1 = add('Lane copy one');
    const t2 = add('Lane copy two');
    const t3 = add('Lane copy three');
    g('commit -qam board');
    const start = (task, agent, script) => run(dir, `node harness/agent.mjs start --role builder --agent ${agent} --task ${task} --lane cartridges/example-sim`, { STUDIO_BUILDER_CMD: `node "${path.join(tmpRoot, script)}" {task} {agent}` });
    start(t1, 'lane-a1', 'lane-agent.mjs');
    const logA = fs.readFileSync(path.join(dir, '.studio/agents/lane-a1.log'), 'utf8');
    const mainLog = g('log --oneline').stdout;
    const statusInCopy = (logA.split('$ git status --porcelain\n')[1] || '').split('[exit')[0].trim();
    report('an agent with a code lane works in its own copy, and its git status shows only its own change', /[\\/]\.lanes[\\/]lane-a1/.test(logA) && statusInCopy === 'M cartridges/example-sim/index.mjs', logA.slice(0, 1500));
    report('task done in a copy adds its commit to the studio\'s branch, and the copy and its branch are removed', new RegExp(`${t1}: lane-a1`).test(mainLog) && /- \[x\] \*\*/.test(fs.readFileSync(path.join(dir, 'studio/DONE.md'), 'utf8')) && !fs.existsSync(path.join(dir, '.lanes/lane-a1')) && !/lane\/lane-a1/.test(g('branch').stdout), mainLog + g('branch').stdout + logA.slice(-1500));
    start(t2, 'lane-b1', 'lane-quit.mjs');
    const hand = fs.existsSync(path.join(dir, `studio/handoffs/${t2}.md`)) ? fs.readFileSync(path.join(dir, `studio/handoffs/${t2}.md`), 'utf8') : '';
    report('a session that quits in its copy keeps its commits on its branch and saves what it hadn\'t committed', /not yet in the studio's branch are on lane\/lane-b1/.test(hand) && fs.existsSync(path.join(dir, `.studio/wip/${t2}-lane-b1.patch`)) && /lane\/lane-b1/.test(g('branch').stdout) && !fs.existsSync(path.join(dir, '.lanes/lane-b1')), hand + g('branch').stdout);
    start(t2, 'lane-c1', 'lane-agent.mjs');
    const mainLog2 = g('log --oneline').stdout;
    start(t3, 'lane-d1', 'lane-nodone.mjs');
    const endD = fs.readFileSync(path.join(dir, '.studio/events.jsonl'), 'utf8').split('\n').filter((l) => /agent\.session\.end/.test(l) && /lane-d1/.test(l)).pop() || '';
    report('an agent that committed and verified but never called task done: the launcher closes the task once its check passes', new RegExp(`${t3}: lane-d1`).test(g('log --oneline').stdout) && /the launcher closed its task/.test(endD) && fs.readFileSync(path.join(dir, 'studio/DONE.md'), 'utf8').includes(`- [x] **${t3}**`), endD + g('log --oneline').stdout);
    report('the next agent\'s copy gets the earlier commits merged in, and done adds both; no lane branches are left', new RegExp(`${t2}: lane-b1`).test(mainLog2) && new RegExp(`${t2}: lane-c1`).test(mainLog2) && !/lane\//.test(g('branch').stdout) && !g('status --porcelain').stdout.split('\n').some((l) => /\.lanes/.test(l)), mainLog2 + g('branch').stdout + fs.readFileSync(path.join(dir, '.studio/agents/lane-c1.log'), 'utf8').slice(-1500));
  }
}

// 2.29: npm run map -- find answers in one call; the size ratchet refuses growth past the limit.
{
  const dir = copyRepo();
  // The parser is the harness's typescript dev dependency; the copies don't carry node_modules.
  const noParser = run(dir, 'node harness/map.mjs find spawnCost');
  report('without typescript, map find says it can\'t read the code instead of finding nothing', noParser.status === 1 && /typescript package isn't installed/.test(noParser.stderr), noParser.stdout + noParser.stderr);
  if (fs.existsSync(path.join(root, 'node_modules', 'typescript'))) fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  const f = run(dir, 'node harness/map.mjs find spawnCost');
  report('map find gives the file and line of a TUNING key in one call', /cartridges\/example-sim\/index\.mjs:\d+\s+TUNING\.spawnCost\b/.test(f.stdout), f.stdout + f.stderr);
  const g = (cmd) => run(dir, `git -c user.email=t@t -c user.name=t ${cmd}`);
  const body = (n, ret = 0) => `export function big() {\n${Array.from({ length: n }, (_, i) => `  const v${i} = ${i};`).join('\n')}\n  return ${ret};\n}\n`;
  fs.mkdirSync(path.join(dir, 'game/sz/src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'game/sz/src/a.js'), body(90));
  const gate = run(dir, 'node scripts/check-function-size.mjs');
  report('the function-size check names a game function over 80 lines', gate.status === 1 && /game\/sz\/src\/a\.js:1 big\(\): 9\d lines/.test(gate.stdout), gate.stdout + gate.stderr);
  g('init -q -b main');
  g('add -A');
  g('commit -qm base');
  const add = (title) => (run(dir, `node harness/task.mjs add "${title}" --role builder --priority P1`).stdout.match(/"id": "(T-\d+)"/) || [])[1];
  const t = add('Size ratchet');
  run(dir, `node harness/task.mjs start ${t} --agent sz-1`, { STUDIO_LOCK_OWNER: 'sz-1' });
  const growth = () => run(dir, `node -e "import('./harness/done-check.mjs').then(m=>console.log(JSON.stringify(m.sizeGrowth('${t}', ['game/sz/src/a.js']))))"`).stdout.trim();
  fs.writeFileSync(path.join(dir, 'game/sz/src/a.js'), body(90, 1));
  const edited = growth();
  fs.writeFileSync(path.join(dir, 'game/sz/src/a.js'), body(95, 1));
  const grown = growth();
  report('the size ratchet lets an edit inside an over-limit function through, and refuses one that makes it bigger', edited === '[]' && /big\(\) is 9\d lines \(was 9\d\)/.test(grown), `${edited}\n${grown}`);
}

// 2.29.2: refresh context by default, cache reads in the budget, a daily cap by default, per-role model
// warning, the cheat sheet check. Each module is exercised in a copy; the launcher end to end with a fake agent.
{
  const dir = copyRepo();
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);
  const probe = (code, env = {}) => {
    const f = path.join(tmpRoot, `p2292-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node "${f}"`, env);
    try {
      return JSON.parse(r.stdout.trim().split('\n').pop());
    } catch {
      return { error: r.stdout + r.stderr };
    }
  };
  const asst = (id, inp, cache) => JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: inp, cache_read_input_tokens: cache, cache_creation_input_tokens: 0 } } });
  const sc = probe(`import * as m from ${u('harness/session-cap.mjs')};
const log = [${JSON.stringify(asst('a', 10, 1000))}, ${JSON.stringify(asst('a', 10, 1000))}, ${JSON.stringify(asst('b', 20, 130000))}].join('\\n');
const lim = m.sessionLimits({});
const out = { p: m.sessionProgress(log), lim, ok: m.refreshState({ turns: 10, context: 50000 }, null, lim).state, due: m.refreshState({ turns: 41, context: 1 }, null, lim), exc: m.refreshState({ turns: 41, context: 1 }, { exception: { why: 'x' } }, lim), late: m.refreshState({ turns: 61, context: 1 }, null, lim), ctx: m.refreshState({ turns: 5, context: 165000 }, { exception: { why: 'x' } }, lim) };
console.log(JSON.stringify(out));`);
  report('session progress: turns by message id and context from the last usage (input + cache)', sc.p?.turns === 2 && sc.p?.context === 130020, JSON.stringify(sc));
  report('refresh point: 40 turns or 120k tokens by default; past it the state is due, or exception when flagged', sc.lim?.turns === 40 && sc.lim?.context === 120000 && sc.lim?.ceilingTurns === 80 && sc.ok === 'ok' && sc.due?.state === 'due' && sc.exc?.state === 'exception', JSON.stringify(sc));
  report('a flagged agent owes a check at the refresh point and every 20 turns / 40k tokens; an unflagged one a step later', sc.exc?.checkDue === true && sc.due?.checkDue === false && sc.late?.checksOwed === 1 && sc.ctx?.checksOwed === 2, JSON.stringify(sc));
  const hb = probe(`import * as m from ${u('harness/session-cap.mjs')};
import fs from 'node:fs';
const log = Array.from({ length: 45 }, (_, i) => JSON.stringify({ type: 'assistant', message: { id: 'm' + i, usage: { input_tokens: 5, cache_read_input_tokens: 1000 * i, cache_creation_input_tokens: 0 } } })).join('\\n');
const a = m.heartbeatCheck('hb-1', { log, model: 'claude-opus-5-5', task: 'T-1' });
const b = m.heartbeatCheck('hb-1', { log, model: 'claude-opus-5-5', task: 'T-1' });
m.flagException('hb-1', 'seed 7 tick 300 desyncs');
const c = m.heartbeatCheck('hb-1', { log, model: 'claude-opus-5-5', task: 'T-1' });
const ev = fs.readFileSync('.studio/events.jsonl', 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l));
m.recordCheck('hb-1', 'continue', { by: 'producer-1' });
console.log(JSON.stringify({ a: a.state, c: c.state, due: ev.filter((e) => e.type === 'agent.refresh.due').length, exc: ev.filter((e) => e.type === 'agent.refresh.exception').length, cards: ev.filter((e) => e.type === 'agent.ask' && /Check hb-1/.test(e.msg)).map((e) => e.msg), board: m.refreshBoard() }));`);
  report('the heartbeat marks a session past 40 turns as due once, and a flagged one gets one check card naming the model', hb.a === 'due' && hb.c === 'exception' && hb.due === 1 && hb.exc === 1 && hb.cards?.length === 1 && /claude-opus-5-5/.test(hb.cards[0]) && hb.board?.[0]?.checks?.length === 1 && hb.board[0].checks[0].decision === 'continue', JSON.stringify(hb).slice(0, 1500));
  const argv = probe(`import { toolCommand } from ${u('harness/agent.mjs')};
console.log(JSON.stringify(toolCommand('claude', { model: 'claude-sonnet-5-5', prompt: 'x' }).argv));`);
  const argvOff = probe(`import { toolCommand } from ${u('harness/agent.mjs')};
console.log(JSON.stringify(toolCommand('claude', { model: 'claude-sonnet-5-5', prompt: 'x' }).argv));`, { STUDIO_SESSION_CEILING_TURNS: '0' });
  report('Claude Code sessions get --max-turns at the ceiling (80), and 0 turns it off', Array.isArray(argv) && argv.join(' ').includes('--max-turns 80') && Array.isArray(argvOff) && !argvOff.includes('--max-turns'), JSON.stringify({ argv, argvOff }));
  const rule = probe(`import { refreshRule } from ${u('harness/agent.mjs')};
import { kickoff } from ${u('harness/kickoff.mjs')};
console.log(JSON.stringify({ rule: refreshRule({ oneTask: true, task: 'T-9' }), prod: kickoff({ role: 'producer', agent: 'producer-1', model: 'm' }), dir: kickoff({ role: 'director', agent: 'director-1', model: 'm' }) }));`);
  report('the kickoff gives launched sessions the refresh rule: one task, 40 turns / 120k, the hand-back template, the exception', /one task/.test(rule.rule || '') && /40 turns or 120k/.test(rule.rule || '') && /task\.mjs pause T-9 --note "Done:/.test(rule.rule || '') && /session -- exception/.test(rule.rule || ''), String(rule.rule || JSON.stringify(rule)));
  report('the Producer attaches cheat sheet tricks before handing out a task, and the Director checks the sheet for the next work', /producer-playbook/.test(rule.prod || '') && /cheatsheet -- attach <ID>/.test(fs.readFileSync(path.join(dir, '.claude/skills/producer-playbook/SKILL.md'), 'utf8')) && /cheatsheet -- match/.test(rule.dir || ''), '');
  // Budget: cache reads count, weighted; the daily cap has a default.
  const bud = probe(`import * as b from ${u('harness/budget.mjs')};
import { spentToday } from ${u('harness/agent.mjs')};
const ts = new Date().toISOString();
const ev = [{ type: 'agent.session.end', ts, model: 'claude-opus-5-5', tokensIn: 1000, tokensOut: 500, meta: { tool: 'claude', cacheRead: 100000 } }];
console.log(JSON.stringify({ used: b.usedSince('claude', 0, ev), w: b.cacheReadWeight(), cap: b.dailyCap({}), off: b.dailyCap({ STUDIO_DAILY_TOKEN_CAP: 'off' }), zero: b.dailyCap({ STUDIO_DAILY_TOKEN_CAP: '0' }), set: b.dailyCap({ STUDIO_DAILY_TOKEN_CAP: '1234' }), today: spentToday(Date.now(), ev), cache: b.cacheSince('claude', 0, ev) }));`);
  report('the budget meter counts cache reads at 0.1x by default (1,000 in + 500 out + 100,000 cache reads = 11,500)', bud.used === 11500 && bud.w === 0.1 && bud.cache?.cacheRead === 100000 && bud.cache?.models?.[0] === 'claude-opus-5-5', JSON.stringify(bud));
  report('the daily token cap defaults to 50M counted tokens; off and 0 turn it off; a number sets it; the launcher counts cache reads', bud.cap === 50000000 && bud.off === 0 && bud.zero === 0 && bud.set === 1234 && bud.today?.used === 11500, JSON.stringify(bud));
  const w2 = probe(`import * as b from ${u('harness/budget.mjs')};
console.log(JSON.stringify({ used: b.usedSince('claude', 0, [{ type: 'agent.session.end', ts: new Date().toISOString(), tokensIn: 0, tokensOut: 0, meta: { tool: 'claude', cacheRead: 1000 } }]) }));`, { STUDIO_CACHE_READ_WEIGHT: '0.5' });
  report('STUDIO_CACHE_READ_WEIGHT sets the cache-read weight', w2.used === 500, JSON.stringify(w2));
  // Per-role models: a warning, never a block.
  const mw = probe(`import * as m from ${u('harness/model-tiers.mjs')};
const top = { STUDIO_AGENT_MODEL: 'claude-opus-5-5' };
const mixed = { STUDIO_AGENT_MODEL: 'claude-opus-5-5', STUDIO_BUILDER_MODEL: 'claude-sonnet-5-5' };
const before = m.modelWarning(top, []);
m.acceptModelWarning('dev', top);
const after = m.modelWarning(top, []);
const changed = m.modelWarning({ STUDIO_AGENT_MODEL: 'gpt-5' }, []);
console.log(JSON.stringify({ before: before.show, roles: before.roles.length, after: after.show, acceptedBy: after.accepted?.by, mixed: m.modelWarning(mixed, []).allTop, changed: changed.show, tiers: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gpt-5-mini'].map(m.tierOf) }));`);
  report('top-tier models on every role show the warning; accepting hides it until the models change; a mid-tier builder never shows it', mw.before === true && mw.roles >= 2 && mw.after === false && mw.acceptedBy === 'dev' && mw.mixed === false && mw.changed === true, JSON.stringify(mw));
  report('model tiers: opus and gemini pro top, sonnet and gpt mini mid, haiku and flash cheap', JSON.stringify(mw.tiers) === JSON.stringify(['top', 'mid', 'cheap', 'top', 'cheap', 'mid']), JSON.stringify(mw.tiers));
  const startTop = run(dir, 'node harness/agent.mjs start --role builder --agent mw-1 --task T-999', { STUDIO_AGENT_MODEL: 'claude-opus-5-5', STUDIO_BUILDER_CMD: 'node -e "process.exit(0)"' });
  report('the warning never blocks: an agent on the top tier still starts', !/Not started/.test(startTop.stdout + startTop.stderr) && fs.existsSync(path.join(dir, '.studio/agents/mw-1.json')), startTop.stdout + startTop.stderr);
  // Cheat sheet: at most 3 matching tricks, attached to the brief.
  const cs = probe(`import * as c from ${u('harness/cheatsheet.mjs')};
console.log(JSON.stringify({ n: c.readCheatsheet().length, m: c.matchTricks('Add Godot unit tests for the elevator'), none: c.matchTricks('zzzz qqqq') }));`);
  report('studio/CHEATSHEET.md parses, stays under 150 lines, and a Godot test task matches at most 3 tricks including Gut', cs.n > 20 && fs.readFileSync(path.join(dir, 'studio/CHEATSHEET.md'), 'utf8').split('\n').length < 150 && cs.m?.length === 3 && cs.m.some((t) => /bitwes\/Gut/.test(t.text)) && cs.none?.length === 0, JSON.stringify(cs).slice(0, 1500));
  const tid = (run(dir, 'node harness/task.mjs add "Godot unit tests for the elevator" --role builder --priority P1').stdout.match(/"id": "(T-\d+)"/) || [])[1];
  const att = run(dir, `node harness/cheatsheet.mjs attach ${tid} --by producer-1`);
  fs.mkdirSync(path.join(dir, 'studio/handoffs'), { recursive: true });
  fs.writeFileSync(path.join(dir, `studio/handoffs/${tid}.md`), `# Handoff ${tid}\n\nOLDEST-NOTE ${'x'.repeat(5000)}\nNEWEST-NOTE: next step is the elevator test\n`);
  const brief = run(dir, `node harness/focus.mjs ${tid}`).stdout;
  report('cheatsheet attach puts the tricks in the task\'s brief as pre-approved, by whoever assigned it', att.status === 0 && /bitwes\/Gut/.test(att.stdout) && /## Pre-approved tricks for this task \(studio\/CHEATSHEET\.md, approved by producer-1\)/.test(brief) && /without asking\. Anything not listed here follows the normal approval rules/.test(brief) && /C-\d+ .*bitwes\/Gut/.test(brief), att.stdout + att.stderr + brief.slice(0, 2000));
  const pre = fs.readFileSync(path.join(dir, '.studio/events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'cheatsheet.preapproved' && e.task === tid).pop();
  report('the pre-approval is recorded: task id, trick ids, approved_by', pre?.meta?.task === tid && pre.meta.approved_by === 'producer-1' && pre.meta.tricks?.length >= 1 && pre.meta.tricks.length <= 3 && pre.meta.tricks.every((x) => /^C-\d+$/.test(x)), JSON.stringify(pre));
  const dm = probe(`import * as c from ${u('harness/cheatsheet.mjs')};
console.log(JSON.stringify({ dir: c.matchTricks('queue the next tasks with dependencies, split by size, one lane each', { forRole: 'director' }), work: c.matchTricks('queue the next tasks with dependencies, split by size, one lane each'), ids: c.readCheatsheet().map((e) => e.id) }));`);
  report('the cheat sheet has a director section (dependencies, size-3 split, one owner per lane) that only the Director and Producer get', dm.dir?.length === 3 && dm.dir.every((t) => t.tags.includes('director')) && (dm.work || []).every((t) => !t.tags.includes('director')) && dm.ids?.every(Boolean) && new Set(dm.ids).size === dm.ids.length, JSON.stringify(dm).slice(0, 1500));
  report('the Director consults its cheat sheet section when planning, and agents are told attached tricks are pre-approved', /match "<what you are planning>" --for director/.test(rule.dir || '') && /--for director/.test(rule.prod || '') && /pre-approved/.test(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')), '');
  report('the brief carries the newest 3k characters of the hand-back notes, not all of them', /NEWEST-NOTE/.test(brief) && !/OLDEST-NOTE/.test(brief) && /Older notes in studio\/handoffs/.test(brief), brief.slice(0, 600));
  // The launcher end to end: a session that hits the turn ceiling is a refresh, not a failure.
  const tr = (run(dir, 'node harness/task.mjs add "Refresh me" --role builder --priority P1').stdout.match(/"id": "(T-\d+)"/) || [])[1];
  const fake = path.join(tmpRoot, 'fake-capped.mjs');
  fs.writeFileSync(fake, `import { spawnSync } from 'node:child_process';\nimport fs from 'node:fs';\nconst [task, agent] = process.argv.slice(2);\nspawnSync('node harness/task.mjs start ' + task + ' --agent ' + agent, { shell: true });\nconst n = Number(fs.existsSync('.studio/fake-runs') ? fs.readFileSync('.studio/fake-runs', 'utf8') : 0) + 1;\nfs.writeFileSync('.studio/fake-runs', String(n));\nif (n === 1) { console.log(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 80, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 9000 } })); process.exit(1); }\nspawnSync('node harness/task.mjs pause ' + task + ' --agent ' + agent + ' --note "second session"', { shell: true });\nconsole.log(JSON.stringify({ type: 'result', subtype: 'success', num_turns: 3, usage: { input_tokens: 1, output_tokens: 1 } }));\n`);
  const cap = run(dir, `node harness/agent.mjs start --role builder --agent rf-1 --task ${tr} --one-task`, { STUDIO_BUILDER_CMD: `node "${fake}" {task} {agent}`, STUDIO_REFRESH_RELAUNCH: '1', STUDIO_LOOP_HANDBACKS: '1' });
  const evs = fs.readFileSync(path.join(dir, '.studio/events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const ends = evs.filter((e) => e.type === 'agent.session.end' && e.agent === 'rf-1');
  const hand = fs.existsSync(path.join(dir, `studio/handoffs/${tr}.md`)) ? fs.readFileSync(path.join(dir, `studio/handoffs/${tr}.md`), 'utf8') : '';
  report('a session that reaches the turn ceiling hands off: no failure, a refresh note, and a fresh session on the same task at once', ends.length === 2 && ends[0].status === 'ok' && ends[0].meta?.refreshed === true && /refreshed/.test(hand) && evs.some((e) => e.type === 'agent.refresh' && e.task === tr) && fs.readFileSync(path.join(dir, '.studio/fake-runs'), 'utf8') === '2', JSON.stringify(ends).slice(0, 1500) + cap.stdout + cap.stderr + hand);
  report('a refresh hand-back never parks the task as looping', !evs.some((e) => e.type === 'task.hold' && e.task === tr && /Parked/.test(e.msg || '')), JSON.stringify(evs.filter((e) => e.task === tr).map((e) => e.type)));
  // The War Room reads all of it.
  const hud = probe(`import { buildHudState } from ${u('harness/hud.mjs')};
const s = buildHudState();
console.log(JSON.stringify({ meter: s.meter, sc: s.sessionCap?.limits, rows: s.sessionCap?.sessions?.length, mw: typeof s.modelWarning?.show, cs: Object.keys(s.cheatsheet || {}) }));`, { STUDIO_AGENT_MODEL: 'claude-opus-5-5' });
  report('the War Room state has the budget meter (per model, cache reads), the sessions against the refresh point, the model warning and the attached tricks', hud.meter?.cap === 50000000 && hud.meter?.byModel?.length >= 1 && hud.sc?.turns === 40 && hud.rows >= 1 && hud.mw === 'boolean' && hud.cs?.includes(tid), JSON.stringify(hud).slice(0, 1500));
}

// 2.30a: intent cards and task origin, the dev's yes, phase override, owned waits, phrase scope checks,
// drop/reorder, quota accuracy, the watchdog, the Arcade's what-changed, ccusage. Each in a copy.
{
  const dir = copyRepo();
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);
  const probe = (code, env = {}) => {
    const f = path.join(tmpRoot, `p230a-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node "${f}"`, env);
    try {
      return JSON.parse(r.stdout.trim().split('\n').pop());
    } catch {
      return { error: r.stdout + r.stderr };
    }
  };
  // J2: origin tags; an agent's mechanic waits for the dev's yes; other agent work doesn't.
  const add = (args, env = {}) => run(dir, `node harness/task.mjs add ${args}`, env);
  const a1 = add('"Add sprint and jump" --origin dev --asked "add sprint/jump" --infra');
  // 2.30d (#6): a builder's add waits on the proposed list until the Producer promotes it; the origin rules still apply after.
  add('"Add a double jump mechanic" --infra --why "players asked for air control"', { STUDIO_LOCK_OWNER: 'builder-2' });
  add('"Tidy the HUD labels" --infra --why "labels overlap at 1280px"', { STUDIO_LOCK_OWNER: 'builder-2' });
  run(dir, 'node harness/task.mjs promote --all --by producer-1');
  const j = (r) => { try { return JSON.parse(r.stdout); } catch { return {}; } };
  const bl = fs.readFileSync(path.join(dir, 'studio', 'NEXT.md'), 'utf8');
  const idOf = (title) => (bl.split('\n').find((l) => l.includes(title))?.match(/\*\*(T-\d+)\*\*/) || [])[1];
  const [t1, t2, t3] = [j(a1), { id: idOf('double jump') }, { id: idOf('Tidy the HUD') }];
  const a2 = { stderr: '' };
  const hold = probe(`import { holdReason, holdOwner } from ${u('harness/task-hold.mjs')};
import { parseNextQueue } from ${u('harness/task.mjs')};
const q = parseNextQueue();
console.log(JSON.stringify({ h1: holdReason('${t1.id}', q), h2: holdOwner('${t2.id}', q), h3: holdReason('${t3.id}', q) }));`);
  const ev = () => fs.readFileSync(path.join(dir, '.studio', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const origins = Object.fromEntries(ev().filter((e) => e.type === 'task.added').map((e) => [e.task, e.meta?.origin]));
  report('every task is tagged dev-asked or agent-proposed; an agent-proposed mechanic waits on the dev, other agent work starts', origins[t1.id] === 'dev-asked' && origins[t2.id] === 'agent-proposed' && origins[t3.id] === 'agent-proposed' && !hold.h1 && hold.h2?.owner === 'the dev' && /yes/.test(hold.h2?.why || '') && !hold.h3, JSON.stringify({ origins, hold, a2: a2.stderr }));
  const noAgent = run(dir, `node harness/task.mjs yes ${t2.id} --by builder-2`);
  const relayNo = run(dir, `node harness/task.mjs yes ${t2.id} --by trever`, { STUDIO_LOCK_OWNER: 'producer-1' });
  const yes = run(dir, `node harness/task.mjs yes ${t2.id} --by trever`);
  const after = probe(`import { holdReason } from ${u('harness/task-hold.mjs')};
import { parseNextQueue } from ${u('harness/task.mjs')};
console.log(JSON.stringify({ h: holdReason('${t2.id}', parseNextQueue()) }));`);
  report('only the dev says yes (an agent name is refused, a relay needs their words and where); then the task can start', noAgent.status !== 0 && relayNo.status !== 0 && /own words/.test(relayNo.stderr) && yes.status === 0 && !after.h && ev().some((e) => e.type === 'task.dev_yes' && e.task === t2.id), JSON.stringify({ noAgent: noAgent.stderr, relayNo: relayNo.stderr, yes: yes.stdout + yes.stderr, after }));
  const echo = run(dir, `node harness/intent.mjs echo --asked "add sprint/jump" --wont "stamina, camera" --tasks ${t1.id} --by producer-1`);
  const conf = run(dir, 'node harness/intent.mjs confirm E-001 --by trever');
  const list = run(dir, 'node harness/intent.mjs list');
  report('the intent card says "You asked for: X. I will NOT change: Y." and one confirm by the dev closes it', /You asked for: add sprint\/jump\. I will NOT change: stamina, camera\./.test(echo.stdout) && conf.status === 0 && /E-001 confirmed by trever/.test(list.stdout) && ev().some((e) => e.type === 'intent.echo') && ev().some((e) => e.type === 'intent.confirmed'), echo.stdout + echo.stderr + conf.stderr + list.stdout);
  // J11: drop and reorder; phrase scope checks.
  const re = run(dir, `node harness/task.mjs reorder ${t3.id} --to top --by producer-1`);
  const order = probe(`import { parseNextQueue } from ${u('harness/task.mjs')};
console.log(JSON.stringify(parseNextQueue().backlog.map((t) => t.id)));`);
  const dropNo = run(dir, `node harness/task.mjs drop ${t1.id} --by producer-1`);
  const drop = run(dir, `node harness/task.mjs drop ${t1.id} --why "the dev said not now" --by producer-1`);
  const order2 = probe(`import { parseNextQueue } from ${u('harness/task.mjs')};
console.log(JSON.stringify(parseNextQueue().backlog.map((t) => t.id)));`);
  report('task reorder moves a waiting task; task drop needs a why, takes it off the queue and logs it', re.status === 0 && order[0] === t3.id && dropNo.status !== 0 && drop.status === 0 && !order2.includes(t1.id) && ev().some((e) => e.type === 'task.dropped' && /not now/.test(e.msg)), JSON.stringify({ order, order2, re: re.stderr, drop: drop.stderr }));
  const scope = probe(`import { crossedLayersIn } from ${u('harness/bible.mjs')};
const b = { layers: { unlocks: { answer: 'no' }, 'npc-needs': { answer: 'no' }, 'tech-tree': { answer: 'no' } } };
const ids = (t) => crossedLayersIn(t, b).map((l) => l.id);
console.log(JSON.stringify({ lic: ids('Fix the licence text in the credits'), mood: ids('Warm mood lighting on the dock'), sys: ids('Add a licence system for boats'), meter: ids('Crew mood meter'), tree: ids('Show the tech tree') }));`);
  report('scope checks match phrases: "licence text" and "mood lighting" pass; "add a licence system", "mood meter", "tech tree" are caught', !scope.lic?.length && !scope.mood?.length && scope.sys?.includes('unlocks') && scope.meter?.includes('npc-needs') && scope.tree?.includes('tech-tree'), JSON.stringify(scope));
  // J3: the dev's "do it now" opens the gate past an unfinished exit list and logs the risk.
  fs.mkdirSync(path.join(dir, 'studio', 'bible'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'studio', 'bible', 'bible.json'), JSON.stringify({ version: 1, answers: {}, pillars: [], phases: { 1: {}, 2: {}, 3: {} }, layers: {}, signed: { by: 'trever', at: new Date().toISOString() }, phase: { open: 1, history: [{ phase: 1, at: new Date().toISOString(), by: 'trever', reason: 'Bible signed' }] } }));
  fs.writeFileSync(path.join(dir, 'studio', 'bible', 'PHASE-1-EXIT.md'), '- [ ] floors 1-3 playable\n');
  const gated = run(dir, 'node harness/bible.mjs phase open 2 --by trever');
  const agentNow = run(dir, 'node harness/bible.mjs phase open 2 --now "port to Godot now" --by builder-1');
  const now2 = run(dir, 'node harness/bible.mjs phase open 2 --now "start Phase 2 now" --by trever');
  const bj = JSON.parse(fs.readFileSync(path.join(dir, 'studio', 'bible', 'bible.json'), 'utf8'));
  const ov = ev().find((e) => e.type === 'bible.phase_override');
  report('the dev\'s "do it now" opens the phase gate at once (an agent can\'t), and the risk it skipped is in the event log', gated.status !== 0 && agentNow.status !== 0 && now2.status === 0 && bj.phase.open === 2 && ov?.meta?.risk?.length >= 1 && /Risk taken/.test(ov.msg) && /start Phase 2 now/.test(bj.phase.history.at(-1).reason), JSON.stringify({ gated: gated.stderr, agentNow: agentNow.stderr, now2: now2.stdout + now2.stderr, ov }));
  // J12: the false limit path. A killed session whose last lines are its own transcript quoting a limit.
  const pt = probe(`import { providerTrouble } from ${u('harness/agent.mjs')};
import { limitLine } from ${u('harness/budget.mjs')};
const said = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'Error: usage limit reached (429) in the selftest fixture' }] } });
const real = 'Error: Claude AI usage limit reached|1792700000';
console.log(JSON.stringify({ transcript: providerTrouble([said, said].join('\\n'), 143), real: providerTrouble(real, 1)?.kind, review: limitLine('', 'The review: the quota code reads the rate limit wrong.', 0), reviewFail: limitLine('', 'This change touches the quota check.', 1), probe: limitLine('Error: 429 Too Many Requests', '', 1) }));`);
  report('quota stops are real: a transcript quoting "usage limit reached" or a review mentioning quota marks nothing; the provider\'s own 429 does', pt.transcript === null && pt.real === 'quota' && pt.review === null && pt.reviewFail === null && /429/.test(pt.probe || ''), JSON.stringify(pt));
  const mark = probe(`import * as b from ${u('harness/budget.mjs')};
import { emitEvent } from ${u('harness/event.mjs')};
emitEvent({ type: 'agent.session.end', agent: 'b-1', model: 'claude-opus-5-5', tokensIn: 1000, tokensOut: 1000, meta: { tool: 'claude', cacheRead: 10000 } });
const m = b.markExhausted('claude', 'Error: usage limit reached, resets 5pm');
console.log(JSON.stringify({ m, text: b.budgetStatus().find((s) => s.tool === 'claude')?.text }));`);
  report('a quota stop shows the numbers it used: tokens counted in the last 5 h and the model', mark.m?.used?.last5h === 3000 && /stopped at 3,000 counted tokens in the last 5 h, claude-opus-5-5/.test(mark.text || ''), JSON.stringify(mark).slice(0, 800));
  // G1: the watchdog is off by default; on, it parks a looping task.
  const wd = probe(`import * as w from ${u('harness/watchdog.mjs')};
import { emitEvent } from ${u('harness/event.mjs')};
import { readHolds } from ${u('harness/task-hold.mjs')};
const off = await w.watchdogPass();
for (let i = 0; i < 3; i++) emitEvent({ type: 'task.paused', agent: 'b', task: '${t3.id}', msg: 'handed back' });
const still = readHolds()['${t3.id}']?.parked || null;
w.setWatchdog(true, 'trever');
const on = await w.watchdogPass();
console.log(JSON.stringify({ off, still, on, parked: readHolds()['${t3.id}']?.parked?.by }));`);
  report('the watchdog is off by default and does nothing; turned on, it parks a task handed back 3 times in 2 h', wd.off?.on === false && !wd.still && wd.on?.on === true && wd.parked === 'watchdog' && wd.on.actions.some((a) => a.kind === 'park'), JSON.stringify(wd).slice(0, 800));
  // Plugins: godot-mcp and ccusage are listed and off; Serena's dashboard never opens over the War Room.
  const pl = JSON.parse(fs.readFileSync(path.join(dir, 'studio', 'plugins.json'), 'utf8')).plugins;
  const by = (id) => pl.find((p) => p.id === id);
  report('godot-mcp and ccusage are opt-in plugins (off, pinned); Serena starts with its dashboard closed', by('godot-mcp')?.enabled === false && /@0\.1\.1$/.test(by('godot-mcp').mcp.args.at(-1)) && by('ccusage')?.enabled === false && by('ccusage').ledger.args.includes('--json') && by('serena').mcp.args.join(' ').includes('--open-web-dashboard false'), '');
  const ccOff = run(dir, 'node harness/budget.mjs ccusage');
  run(dir, 'node harness/plugins.mjs enable ccusage');
  const fake = JSON.stringify({ daily: [{ date: '2026-10-22', inputTokens: 100, outputTokens: 50, cacheReadTokens: 9000, cacheCreationTokens: 10, totalTokens: 9160, modelsUsed: ['claude-opus-5-5'] }] });
  fs.writeFileSync(path.join(dir, 'cc-fake.json'), fake);
  const ccOn = run(dir, 'node harness/budget.mjs ccusage', { STUDIO_CCUSAGE_CMD: 'node -e "process.stdout.write(require(\'fs\').readFileSync(\'cc-fake.json\', \'utf8\'))"' });
  report('ccusage feeds the token ledger only when its plugin is on: daily tokens, cache reads and the model', ccOff.status !== 0 && ccOn.status === 0 && /9,160 tokens .*cache reads 9,000.*claude-opus-5-5/.test(ccOn.stdout) && fs.existsSync(path.join(dir, '.studio', 'ccusage.json')), ccOff.stderr + ccOn.stdout + ccOn.stderr);
  // J10 and J8 in the War Room state: the status line, owners, and what changed per build.
  fs.mkdirSync(path.join(dir, '.studio', 'builds', 'b1'), { recursive: true });
  run(dir, `node harness/task.mjs add "Study the dock" --type study --infra`);
  const hs = probe(`import { buildHudState } from ${u('harness/hud.mjs')};
import { emitEvent } from ${u('harness/event.mjs')};
import fs from 'node:fs';
emitEvent({ type: 'task.done', agent: 'b', task: 'T-900', msg: 'Completed T-900: Boats dock at the pier' });
fs.writeFileSync('.studio/builds/b1/build.json', JSON.stringify({ id: 'b1', at: new Date(Date.now() + 1000).toISOString(), page: 'index.html' }));
run();
function run() {
  const s = buildHudState();
  console.log(JSON.stringify({ line: s.status.line, you: s.status.waitingOnYou, origin: s.queue.backlog.map((t) => t.origin), changes: s.builds[0]?.changes, wd: s.watchdog.on }));
}`);
  report('the War Room status line says building now, waiting on you and tokens today; tasks carry their origin; a build lists what changed', /^Building now: .* · Waiting on you: .* · Tokens today: /.test(hs.line || '') && hs.origin?.includes('agent-proposed') && hs.changes?.[0]?.task === 'T-900' && /Boats dock/.test(hs.changes[0].title) && hs.wd === true, JSON.stringify(hs).slice(0, 1200));
}

// 2.30b: real-input fun probes (J1), sim features shown in the build (J4), the asset scout (G7). Each in a copy.
{
  const dir = copyRepo();
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);
  const probe = (code, env = {}) => {
    const f = path.join(tmpRoot, `p230b-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node "${f}"`, env);
    try {
      return JSON.parse(r.stdout.trim().split('\n').pop());
    } catch {
      return { error: r.stdout + r.stderr };
    }
  };
  // A fake page: a player that moves with held keys, in camera space (good) or world space (bad).
  const fakePage = `const fake = (o = {}) => {
  const s = { x: 0, y: 0, z: 0, vy: 0, fwd: [0.8, -0.6], held: new Set(), t: Date.now(), hits: { last: null, count: 0 }, target: 'E1' };
  const tick = () => {
    const now = Date.now(); const dt = (now - s.t) / 1000; s.t = now;
    const sp = (s.held.has('Shift') && !o.noSprint ? 2 : 1) * 3 * dt;
    const f = o.worldWasd ? [0, 1] : s.fwd; const r = [f[1], -f[0]];
    if (s.held.has('w')) { s.x += f[0] * sp; s.z += f[1] * sp; }
    if (s.held.has('d')) { s.x += r[0] * sp; s.z += r[1] * sp; }
    s.y = Math.max(0, s.y + s.vy * dt); s.vy = s.y > 0 || s.vy > 0 ? s.vy - 9 * dt : 0;
  };
  const v = () => { tick(); const out = { player: { x: s.x, y: s.y, z: s.z }, camera: { forward: s.fwd, inside: Boolean(o.inside) }, crosshair: { target: s.target }, hits: { ...s.hits } };
    if (o.noView) return null; if (o.noCrosshair) delete out.crosshair; return out; };
  return {
    evaluate: async () => v(),
    keyboard: { down: async (k) => { tick(); s.held.add(k); }, up: async (k) => { tick(); s.held.delete(k); }, press: async (k) => { tick(); if (k === 'Space' && !o.noJump) s.vy = 4; if (k === 'c') s.crouch = true; } },
    mouse: { move: async () => {}, click: async () => { s.hits.count++; s.hits.last = o.miss ? 'E2' : s.target; } },
    locator: () => ({ first: () => ({ boundingBox: async () => ({ x: 0, y: 0, width: 800, height: 600 }) }) }),
    click: async () => {},
  };
};`;
  const pr = probe(`import { runProbes, checkSimFeatures } from ${u('qa/fun-probes.mjs')};
${fakePage}
const all = ['move', 'sprint', 'jump', 'aim', 'camera'];
const good = await runProbes(fake(), { probes: all });
const bad = await runProbes(fake({ worldWasd: true, noSprint: true, noJump: true, miss: true, inside: true }), { probes: all });
const unwired = await runProbes(fake({ noCrosshair: true }), { probes: ['aim'] });
const none = await runProbes(fake({ noView: true }), { probes: ['move'] });
const sim = await checkSimFeatures(fake(), ['jump', 'crouch', 'crane'], { features: { crouch: { key: 'c', expect: () => true, waitMs: 10 } } }, good);
const simOff = await checkSimFeatures(fake(), ['crouch'], { features: { crouch: { key: 'c', expect: (a, b) => a.player.y !== b.player.y, waitMs: 10 } } }, []);
console.log(JSON.stringify({ good, bad, unwired, none, sim, simOff }));`);
  const ok = (arr, name) => arr?.find((p) => p.name === name)?.ok;
  report('J1: the fun probes pass a game with camera-relative WASD, sprint, jump, crosshair hits and a clear camera', ['move', 'sprint', 'jump', 'aim', 'camera'].every((p) => ok(pr.good, p)), JSON.stringify(pr.good || pr));
  report('J1: each probe fails its own fault: world-space WASD, no sprint, no jump, a shot that misses the crosshair target, the camera inside a wall', ['move', 'sprint', 'jump', 'aim', 'camera'].every((p) => ok(pr.bad, p) === false) && /camera-relative/.test(pr.bad?.find((p) => p.name === 'move')?.why || '') && /not E1/.test(pr.bad?.find((p) => p.name === 'aim')?.why || ''), JSON.stringify(pr.bad || pr));
  report('J1: a probe the build has no view for fails as unwired, not as passed', pr.unwired?.[0]?.unwired === true && pr.unwired[0].ok === false && pr.none?.[0]?.unwired === true, JSON.stringify({ u: pr.unwired, n: pr.none }));
  report('J4: a sim feature passes through its probe or its bound key, and fails when unbound or when the key shows nothing', ok(pr.sim, 'jump') && ok(pr.sim, 'crouch') && ok(pr.sim, 'crane') === false && /binds no input/.test(pr.sim?.find((f) => f.name === 'crane')?.why || '') && pr.simOff?.[0]?.ok === false && /changed nothing/.test(pr.simOff[0].why || ''), JSON.stringify({ sim: pr.sim, off: pr.simOff }));
  const bp = fs.readFileSync(path.join(dir, 'qa', 'browser-play.mjs'), 'utf8');
  report('J1/J4: browser play runs the probes and the sim features and fails on FUN-PROBE, PROBE-UNWIRED and SIM-ONLY', /runProbes\(page/.test(bp) && /checkSimFeatures\(page/.test(bp) && /'FUN-PROBE'/.test(bp) && /'PROBE-UNWIRED'/.test(bp) && /'SIM-ONLY'/.test(bp), 'browser-play.mjs is missing the probe wiring');
  // done-check: a gameplay task closes only on passing probes after the last change plus a clip.
  const reps = path.join(dir, 'qa', 'reports');
  fs.mkdirSync(path.join(reps, 'clips'), { recursive: true });
  const dc = (title, part = 'renderer') => probe(`import { gameplayChecks } from ${u('harness/done-check.mjs')};
const checks = []; gameplayChecks({ id: 'T-900', title: ${JSON.stringify(title)} }, '${part}', Date.now() - 60000, (label, ok, why) => checks.push({ label, ok: Boolean(ok), why }));
console.log(JSON.stringify(checks));`, { STUDIO_FUN_WAVES: '0' }); // per-task mode (2.30b); waves (2.30d) are tested below
  const writeRep = (i, probes, simFeatures = [], declared = { probes: ['move'], simFeatures: simFeatures.map((f) => f.name) }) => fs.writeFileSync(path.join(reps, `browser_${i}.json`), JSON.stringify({ at: new Date().toISOString(), passed: probes.every((p) => p.ok), probes, simFeatures, declared }));
  const c0 = dc('Fix WASD movement');
  writeRep(1, [{ name: 'move', ok: false, why: 'not camera-relative' }]);
  const c1 = dc('Fix WASD movement');
  writeRep(2, [{ name: 'move', ok: true }]);
  const c2 = dc('Fix WASD movement');
  fs.writeFileSync(path.join(reps, 'clips', 'T-900.webm'), 'x');
  const c3 = dc('Fix WASD movement');
  const cText = dc('Rewrite the credits text');
  writeRep(3, [{ name: 'move', ok: true }], [{ name: 'crane', ok: false, why: 'binds no input' }]);
  const cSim = dc('Add the crane arm to the sim', 'sim');
  const lbl = (c, l) => c?.find?.((x) => x.label.startsWith(l));
  report('J1: a gameplay task stays open while a probe fails, and without a clip; it closes with passing probes plus a clip', lbl(c0, 'Real-input')?.ok === false && /a probe fails/.test(lbl(c1, 'Real-input')?.why || '') && lbl(c2, 'Real-input')?.ok === true && lbl(c2, 'A clip')?.ok === false && lbl(c3, 'Real-input')?.ok && lbl(c3, 'A clip')?.ok && Array.isArray(cText) && !cText.length, JSON.stringify({ c0, c1, c2, c3, cText }));
  report('J4: a sim task on a game with a browser build stays open while a sim feature is sim-only', lbl(cSim, 'The build shows')?.ok === false && /crane/.test(lbl(cSim, 'The build shows')?.why || ''), JSON.stringify(cSim));
  for (const f of fs.readdirSync(reps)) if (/^browser_\d\.json$/.test(f)) fs.rmSync(path.join(reps, f));
  fs.rmSync(path.join(reps, 'clips', 'T-900.webm'));
  // G7: the scout searches CC0 APIs offline, pulls only CC0/CC-BY, writes the ledger and CREDITS.md, and the gate checks them.
  fs.writeFileSync(path.join(tmpRoot, 'crate.glb'), 'glb-bytes');
  fs.writeFileSync(path.join(tmpRoot, 'barrel.glb'), 'glb-bytes-2');
  const sc = probe(`import { scout, pull, allowedLicence } from ${u('harness/asset-scout.mjs')};
const fakeFetch = async (url) => ({ ok: true, json: async () => url.includes('polyhaven') ? { wooden_crate_01: { name: 'Wooden Crate 01', tags: ['crate', 'wood'], authors: { 'Jane Doe': 'All' } }, rock_02: { name: 'Rock', tags: ['rock'] } } : { foundAssets: [{ assetId: 'Wood051', displayName: 'Wood 051' }] } });
const found = await scout('crate', { fetch: fakeFetch });
const sa = await pull({ from: ${JSON.stringify(path.join(tmpRoot, 'crate.glb'))}, licence: 'CC-BY-SA 4.0', author: 'X', source: 'https://opengameart.org/x' });
const noAuthor = await pull({ from: ${JSON.stringify(path.join(tmpRoot, 'crate.glb'))}, licence: 'CC-BY 4.0', source: 'https://sketchfab.com/x' });
const cc0 = await pull({ from: ${JSON.stringify(path.join(tmpRoot, 'crate.glb'))}, licence: 'CC0', author: 'Jane Doe', source: 'https://polyhaven.com/a/wooden_crate_01', title: 'Wooden Crate 01', by: 'builder-1' });
const ccby = await pull({ from: ${JSON.stringify(path.join(tmpRoot, 'barrel.glb'))}, licence: 'CC-BY 4.0', author: 'Sam Roe', source: 'https://sketchfab.com/3d-models/barrel', title: 'Barrel', by: 'builder-1' });
console.log(JSON.stringify({ found, sa, noAuthor, cc0, ccby, lic: ['CC0', 'CC-BY 3.0', 'CC-BY-NC 4.0', 'CC-BY-ND', 'free for personal use'].map(allowedLicence) }));`);
  report('G7: the scout finds CC0 hits from the API sources and links the per-item sources with an allowlist filter', sc.found?.results?.some((r) => r.id === 'wooden_crate_01' && r.licence === 'CC0' && r.author === 'Jane Doe') && sc.found.results.some((r) => r.source === 'ambientcg') && !sc.found.results.some((r) => r.id === 'rock_02') && sc.found.check?.length === 3, JSON.stringify(sc.found || sc));
  report('G7: only CC0 and CC-BY pass the allowlist; SA, NC, ND and personal-use go to references; CC-BY needs an author', JSON.stringify(sc.lic) === JSON.stringify(['CC0', 'CC-BY', null, null, null]) && sc.sa?.ok === false && /--use reference/.test(sc.sa.message) && sc.noAuthor?.ok === false && /author/.test(sc.noAuthor.message), JSON.stringify({ sa: sc.sa, na: sc.noAuthor, lic: sc.lic }));
  const credits = fs.existsSync(path.join(dir, 'CREDITS.md')) ? fs.readFileSync(path.join(dir, 'CREDITS.md'), 'utf8') : '';
  const led = JSON.parse(fs.readFileSync(path.join(dir, 'studio', 'assets', 'manifest.json'), 'utf8')).assets;
  report('G7: a pulled asset lands in assets/scouted/, is marked scouted in the ledger, and CREDITS.md credits it', sc.cc0?.ok && sc.ccby?.ok && fs.existsSync(path.join(dir, 'assets', 'scouted', 'polyhaven', 'crate.glb')) && led.every((a) => a.scouted) && led.length === 2 && /"Barrel" by Sam Roe, CC-BY 4.0/.test(credits) && /Wooden Crate 01/.test(credits) && /Jane Doe/.test(credits), JSON.stringify({ cc0: sc.cc0, credits, led }));
  const gate = () => run(dir, 'node scripts/check-assets.mjs');
  const g1 = gate();
  fs.writeFileSync(path.join(dir, 'CREDITS.md'), credits.replace('Sam Roe', 'someone'));
  const g2 = gate();
  fs.writeFileSync(path.join(dir, 'CREDITS.md'), credits);
  const mf = path.join(dir, 'studio', 'assets', 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  m.assets[1].licence = 'CC-BY-NC 4.0';
  fs.writeFileSync(mf, JSON.stringify(m));
  const g3 = gate();
  report('G7: the assets gate passes a credited ledger and fails a stale CREDITS.md or a disallowed licence', g1.status === 0 && g2.status !== 0 && /CREDITS\.md is missing or out of date/.test(g2.stdout) && g3.status !== 0 && /not CC0 or CC-BY/.test(g3.stdout), JSON.stringify({ g1: g1.stdout, g2: g2.stdout, g3: g3.stdout }));
  fs.rmSync(dir, { recursive: true, force: true });
}

// 2.30c: short output (#4), circuit breakers (#8), the Producer on events (#11), dependency-aware
// handout (#12), DONE.md (#13), the allowlist in the kickoff (#15), gates in plain words (G3), the
// overnight summary (G6) and the release command. Each in a copy.
{
  const dir = copyRepo();
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);
  const probe = (code, env = {}) => {
    const f = path.join(tmpRoot, `p230c-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node "${f}"`, env);
    try {
      return JSON.parse(r.stdout.trim().split('\n').pop());
    } catch {
      return { error: r.stdout + r.stderr };
    }
  };
  // #4: a 21k hand-off history becomes a carry-forward of at most 3k, newest note kept; start prints a path and 10 lines.
  const long = ['# Handoff notes for T-003: x', '', 'Newest last. Read these before you pick the task up.', ...Array.from({ length: 30 }, (_, i) => `\n## 2026-10-2${i % 9}T0${i % 9}:00:00Z · b-${i}\n${`note ${i} `.repeat(90)}`), '\n## 2026-10-23T01:00:00Z · b-last\nNEWEST: the golden moved; regenerate it.'].join('\n');
  fs.mkdirSync(path.join(dir, 'studio', 'handoffs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'studio', 'handoffs', 'T-003.md'), long);
  const st = run(dir, 'node harness/task.mjs start T-003 --agent b-1');
  let js = {};
  try { js = JSON.parse(st.stdout); } catch {}
  const [summary, carry = ''] = (st.stderr.split('Your brief:')[1] || '').split('\nPicking up where someone else stopped.');
  const carryBody = carry.split('\n').slice(1).join('\n');
  report('#4: task start prints the brief path and a 10-line summary, and a carry-forward note of at most 3k characters instead of the whole history', long.length > 20000 && /\.studio\/briefs\/T-003\.md/.test(st.stderr) && summary.trim().split('\n').length <= 11 && carryBody.length <= 3000 && /NEWEST: the golden moved/.test(carryBody) && !('handoff' in js) && js.handoffFile === 'studio/handoffs/T-003.md' && !st.stderr.includes('note 3 note 3'), `${st.stderr.slice(0, 1500)}\n${carryBody.length}`);
  const longNote = 'x'.repeat(4000); // under cmd.exe's 8191-character command line on Windows
  run(dir, `node harness/task.mjs pause T-003 --agent b-1 --note "${longNote}"`);
  const h = fs.readFileSync(path.join(dir, 'studio', 'handoffs', 'T-003.md'), 'utf8');
  const last = h.split(/\n## /).pop();
  const ho = run(dir, 'node harness/handoff.mjs');
  const hf = run(dir, 'node harness/handoff.mjs --full');
  const printed = ho.stdout.replace(/\nSaved to .*\n?$/, '');
  report('#4: a hand-back note is cut under 3k characters, and npm run handoff prints at most 3k (the full briefing is saved and --full prints it)', last.length < 3000 && /Cut to 20 lines/.test(last) && printed.length <= 3000 && hf.stdout.length > printed.length && /Before you assign work/.test(hf.stdout) && fs.existsSync(path.join(dir, '.studio', 'briefs', 'producer.md')), `${last.length} ${printed.length} ${hf.stdout.length}`);
  // #8: two hand-backs for the same reason park the task with a card; a refresh never trips it; other work goes on; unblock clears it.
  const bp = probe(`import { startTask, pauseTask, nextFor, parseNextQueue } from ${u('harness/task.mjs')};
import { readHolds } from ${u('harness/task-hold.mjs')};
import { readRecentEvents } from ${u('harness/event.mjs')};
import { unblockTask } from ${u('harness/breaker.mjs')};
import { buildHudState } from ${u('harness/hud.mjs')};
const cycle = (id, note) => { startTask(id, 'b-2'); return pauseTask(id, 'b-2', note, { force: true }); };
const r1 = cycle('T-004', 'refreshed: reached the 40-turn refresh point');
const r2 = cycle('T-004', 'refreshed: reached the 40-turn refresh point');
const d1 = cycle('T-005', 'verify failed: golden mismatch in cartridges/example-sim (run 3)');
const d2 = cycle('T-005', 'tick-budget failed on soak seed 4');
const s1 = cycle('T-002', 'verify failed: golden mismatch in cartridges/example-sim (run 3)');
const s2 = cycle('T-002', 'verify failed: golden mismatch in cartridges/example-sim (run 4)');
const holds = readHolds();
const card = buildHudState().needs.find((n) => n.task === 'T-002' && n.action?.type === 'unblock');
const other = nextFor({}, parseNextQueue()).task?.id;
const blockedStart = startTask('T-002', 'b-3');
const ub = unblockTask('T-002', 'dev');
const after = readHolds()['T-002'];
console.log(JSON.stringify({ refreshParked: Boolean(holds['T-004']?.parked), diffParked: Boolean(holds['T-005']?.parked), sameParked: holds['T-002']?.parked?.breaker, s2: s2.parked || null, ev: readRecentEvents(500).some((e) => e.type === 'task.breaker' && e.task === 'T-002'), card: Boolean(card), other, blocked: blockedStart?.error, ub: ub.ok, after: after?.parked || null }));`);
  report('#8: a second hand-back for the same reason parks the task with that reason and a War Room card with Unblock; different reasons and refreshes never trip it', bp.sameParked === true && /circuit breaker/.test(bp.s2 || '') && bp.ev && bp.card && bp.refreshParked === false && bp.diffParked === false, JSON.stringify(bp));
  report('#8: other work keeps going while a task is tripped, and task unblock clears it', bp.other && bp.other !== 'T-002' && bp.blocked === 'held' && bp.ub === true && bp.after === null, JSON.stringify(bp));
  const ubCli = run(dir, 'node harness/task.mjs unblock T-001 --by dev');
  report('#8: task unblock on a task that is not parked says so', ubCli.status === 1 && /nothing to unblock/.test(ubCli.stderr), ubCli.stderr);
  // #11: the Producer starts on events only, at most every 15 min unless urgent, and backs off when nothing changed.
  const pw = probe(`import { producerWake, producerLaunched, readWake } from ${u('harness/producer-wake.mjs')};
const t0 = Date.parse('2026-10-23T00:00:00Z');
const ev = (type, min, extra = {}) => ({ ts: new Date(t0 + min * 60000).toISOString(), type, agent: 'b-1', msg: '', ...extra });
producerLaunched(t0);
const quiet = producerWake({ now: t0 + 20 * 60000, events: [], commit: true });
const i1 = readWake().interval;
producerWake({ now: t0 + 50 * 60000, events: [], commit: true });
const i2 = readWake().interval;
const soon = producerWake({ now: t0 + 5 * 60000, events: [ev('task.done', 2)] });
const urgent = producerWake({ now: t0 + 5 * 60000, events: [ev('closedloop.escalate', 2)] });
const p0 = producerWake({ now: t0 + 5 * 60000, events: [], queue: { backlog: [{ role: 'producer', priority: 'P0' }] } });
const later = producerWake({ now: t0 + 16 * 60000, events: [ev('task.forced', 10)] });
const own = producerWake({ now: t0 + 16 * 60000, events: [ev('task.done', 10, { agent: 'prod-1' })] });
producerLaunched(t0 + 60 * 60000);
console.log(JSON.stringify({ quiet: quiet.wake, i1, i2, soon: soon.wake, urgent: urgent.wake, p0: p0.wake, later: later.wake, own: own.wake, reset: readWake().interval }));`);
  report('#11: the Producer starts only on an event, at most once per 15 min unless urgent, and the wait doubles while nothing changes', pw.quiet === false && pw.i1 === 30 * 60000 && pw.i2 === 60 * 60000 && pw.soon === false && pw.urgent === true && pw.p0 === true && pw.later === true && pw.own === false && pw.reset === 15 * 60000, JSON.stringify(pw));
  // #12: a task whose prerequisite is done but unmerged, or whose folder another agent holds, is skipped and marked waiting.
  const hb = probe(`import { handoutBlock } from ${u('harness/handout.mjs')};
const q = { done: [{ id: 'T-010' }], inProgress: [], backlog: [] };
const holds = { 'T-011': { after: ['T-010'] } };
const a = handoutBlock('T-011', q, { holds, branches: { 'T-010': 'lane/b-1-x' }, unmerged: () => 2 });
const b = handoutBlock('T-011', q, { holds, branches: { 'T-010': 'lane/b-1-x' }, unmerged: () => 0 });
const c = handoutBlock('T-012', q, { holds: {}, lane: 'game/x/src/floors', locks: [{ key: 'path:game/x/src', owner: 'b-7' }] });
const d = handoutBlock('T-012', q, { holds: {}, lane: 'game/x/src/floors', locks: [{ key: 'path:game/x/docs', owner: 'b-7' }] });
console.log(JSON.stringify({ a, b, c, d }));`);
  report('#12: the handout skips a task whose prerequisite is done but not merged, or whose folder is held, and says who it waits on', /waiting on T-010: done, but 2 commits/.test(hb.a?.why || '') && hb.b === null && hb.c?.owner === 'b-7' && /holds path:game\/x\/src/.test(hb.c.why) && hb.d === null, JSON.stringify(hb));
  // #13: finished tasks move to studio/DONE.md; NEXT.md keeps open work only; an old NEXT.md's DONE still counts.
  const next0 = fs.readFileSync(path.join(root, 'qa', 'fixtures', 'studio', 'NEXT.md'), 'utf8'); // the board a copy starts with
  run(dir, 'node harness/task.mjs start T-001 --agent p-1');
  const dn = run(dir, 'node harness/task.mjs done T-001 --agent p-1 --force --reason "selftest forced"');
  const nx = fs.readFileSync(path.join(dir, 'studio', 'NEXT.md'), 'utf8');
  const dm = fs.existsSync(path.join(dir, 'studio', 'DONE.md')) ? fs.readFileSync(path.join(dir, 'studio', 'DONE.md'), 'utf8') : '';
  const list = JSON.parse(run(dir, 'node harness/task.mjs list').stdout || '{}');
  report('#13: a finished task moves to studio/DONE.md; NEXT.md keeps only open work; an older NEXT.md\'s DONE section still counts', /\[x\] \*\*T-000\*\*/.test(next0) && dn.status === 0 && !/- \[x\]/.test(nx) && /studio\/DONE\.md/.test(nx) && /\[x\] \*\*T-001\*\*/.test(dm) && /\[x\] \*\*T-000\*\*/.test(dm) && list.done?.some((t) => t.id === 'T-001') && list.done?.some((t) => t.id === 'T-000'), `${dn.stderr}\n${nx}\n${dm}`);
  // #15: every kickoff prints exactly what the agent may run, the same list the launcher allows.
  const ka = probe(`import { kickoff } from ${u('harness/kickoff.mjs')};
import { toolCommand } from ${u('harness/agent.mjs')};
import { ALLOWED, allowedTools } from ${u('harness/allowlist.mjs')};
const k = ['builder', 'producer', 'director', 'liaison'].map((role) => kickoff({ role, agent: role + '-1', model: 'm' }));
const c = toolCommand('claude', { model: 'm', prompt: 'x' });
// P-066: the launcher passes each pattern as its own argument after --allowedTools (no quoting can split them).
console.log(JSON.stringify({ all: k.every((t) => /You may run, without asking: \`node\`, \`npm\`/.test(t) && ALLOWED.every(([n]) => t.includes('\`' + n + '\`'))), same: c.argv.slice(c.argv.indexOf('--allowedTools') + 1, c.argv.indexOf('--allowedTools') + 1 + ALLOWED.length).join(',') === allowedTools(), n: ALLOWED.length }));`);
  report('#15: every kickoff lists exactly what the agent may run, the same allowlist the launcher passes (the 2.23 set)', ka.all === true && ka.same === true && ka.n === 15, JSON.stringify(ka));
  // G3: failing first in plain words; "not run" is never a pass.
  const gw = probe(`import { gateWords } from ${u('harness/gate-words.mjs')};
const all = [{ id: 'golden' }, { id: 'soak' }, { id: 'selftest', deep: true }, { id: 'fun', required: false }];
const w = gateWords({ rows: [{ id: 'soak', ok: true, required: true }, { id: 'golden', ok: false, required: true }], skipped: ['selftest (deep)'] }, all);
const none = gateWords(null, all);
console.log(JSON.stringify({ lines: w.lines, none: none.lines }));`);
  report('G3: gate results list failing first in plain words, and "not run" apart from "pass"', /^FAILING \(1\):/.test(gw.lines?.[0] || '') && /golden: the recorded results/.test(gw.lines[1]) && gw.lines.some((l) => /^NOT RUN \(2, not a pass\)/.test(l)) && gw.lines.some((l) => /selftest: deep check/.test(l)) && /^PASSING \(1\): soak$/.test(gw.lines.at(-1)) && /^NOT RUN: no verify/.test(gw.none?.[0] || '') && /^PASSING \(0\)/.test(gw.none.at(-1)), JSON.stringify(gw));
  const rr = run(dir, 'node harness/run-report.mjs --to "' + path.join(tmpRoot, 'rr230c') + '"');
  const rep = (() => { try { return fs.readFileSync(path.join(tmpRoot, 'rr230c', fs.readdirSync(path.join(tmpRoot, 'rr230c'))[0], 'REPORT.md'), 'utf8'); } catch { return ''; } })();
  report('G3: the run report shows the gates failing first, with "not run" kept apart', rr.status === 0 && /Gates, failing first:[\s\S]*NOT RUN/.test(rep), `${rr.stderr}${rep.slice(0, 600)}`);
  // G6: the overnight summary, from the run's events.
  const ov = probe(`import { buildOvernight, renderOvernight } from ${u('harness/overnight.mjs')};
const t0 = Date.parse('2026-10-23T00:00:00Z');
const e = (type, min, x = {}) => ({ ts: new Date(t0 + min * 60000).toISOString(), type, msg: '', ...x });
const events = [
  e('agent.session.start', 1, { agent: 'b-1', task: 'T-1' }), e('task.done', 30, { agent: 'b-1', task: 'T-1', msg: 'Completed T-1: Boats dock' }), e('agent.session.end', 31, { agent: 'b-1', model: 'model-a', tokensIn: 1000, tokensOut: 500, meta: { cacheRead: 100000 } }),
  e('agent.session.start', 40, { agent: 'b-2', task: 'T-2' }), e('agent.session.end', 90, { agent: 'b-2', model: 'model-b', tokensIn: 5000, tokensOut: 1000, meta: { cacheRead: 900000, reason: 'finished without task done' } }),
  e('task.forced', 95, { task: 'T-3', msg: 'Forced T-3 done without: a clip' }), e('review.written', 96, { task: 'T-1' }), e('task.done', 9999, { task: 'T-9' }),
];
const o = buildOvernight({ from: t0, to: t0 + 600 * 60000, events, openCards: ['T-4: parked by the circuit breaker'] });
const md = renderOvernight(o);
console.log(JSON.stringify({ done: o.done.length, noDone: o.noDone.map((s) => s.agent), forced: o.forced.length, reviews: o.reviews, top: o.top.map((s) => s.agent + '/' + s.model), perDone: o.perDone, md }));`);
  report('G6: the overnight summary counts tasks done, tokens per finished task (model named), no-done sessions, forced closes, reviews, the top sessions and open cards', ov.done === 1 && JSON.stringify(ov.noDone) === '["b-2"]' && ov.forced === 1 && ov.reviews === 1 && ov.top?.[0] === 'b-2/model-b' && ov.perDone > 0 && /Tasks done: 1/.test(ov.md) && /model-a: 1 session/.test(ov.md) && /Open cards: 1/.test(ov.md) && ov.md.split('\n').length <= 60, JSON.stringify(ov).slice(0, 1500));
  // Release tooling: refuses a bad version, and never runs outside main in step with origin.
  const rl = run(dir, 'node scripts/release-ship.mjs not-a-version');
  const rl2 = run(dir, 'node scripts/release-ship.mjs 9.9.9-z --dry-run');
  report('release: npm run release -- <version> ships; a bad version or a checkout not on main in step with origin is refused before anything changes', rl.status === 1 && /Usage/.test(rl.stderr) && rl2.status === 1 && /FAIL/.test(rl2.stdout) && JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version !== '9.9.9-z', `${rl.stdout}${rl.stderr}\n${rl2.stdout}${rl2.stderr}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 2.30d: forced work pending review, the size cap and split, the proposed list, model escalation, tricks on add,
// fun checks in waves, away mode and its review, phone alerts, phone login, the watchdog's kennel. Each in a copy.
{
  const dir = copyRepo();
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);
  const probe = (code, env = {}) => {
    const f = path.join(tmpRoot, `p230d-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node "${f}"`, env);
    try {
      return JSON.parse(r.stdout.trim().split('\n').pop());
    } catch {
      return { error: r.stdout + r.stderr };
    }
  };
  const ev = () => fs.readFileSync(path.join(dir, '.studio', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  // 2.30c: finished tasks live in studio/DONE.md.
  const queue = () => ['NEXT.md', 'DONE.md'].map((f) => (fs.existsSync(path.join(dir, 'studio', f)) ? fs.readFileSync(path.join(dir, 'studio', f), 'utf8') : '')).join('\n');
  const idOf = (title) => (queue().split('\n').find((l) => l.includes(title))?.match(/\*\*(T-\d+)\*\*/) || [])[1];
  // #9: --force records the reason, the task is done (pending), the lane moves on; another family or a person closes it.
  run(dir, 'node harness/task.mjs add "Write the dock notes" --type docs --infra');
  const tf = idOf('Write the dock notes');
  run(dir, `node harness/task.mjs start ${tf} --agent builder-7 --model claude-sonnet-4-5`);
  const forced = run(dir, `node harness/task.mjs done ${tf} --agent builder-7 --force --reason "docs check flaky on CI"`);
  const pend = JSON.parse(fs.readFileSync(path.join(dir, 'studio', 'pending-review.json'), 'utf8')).items;
  const self = run(dir, `node harness/task.mjs review ${tf} --close --by builder-7`);
  const same = run(dir, `node harness/task.mjs review ${tf} --close --by reviewer-1 --model claude-opus-4`);
  const agentNoModel = run(dir, `node harness/task.mjs review ${tf} --close --by reviewer-1`);
  const other = run(dir, `node harness/task.mjs review ${tf} --close --by reviewer-1 --model gemini-2.5-pro`);
  report('2.30d #9: --force records the reason and opens a pending card; the task is done and the lane moves on', forced.status === 0 && new RegExp(`\\[x\\] \\*\\*${tf}\\*\\*`).test(queue()) && pend[0]?.task === tf && pend[0].reason === 'docs check flaky on CI' && pend[0].family === 'anthropic' && ev().some((e) => e.type === 'task.pending_review' && e.task === tf), forced.stdout + forced.stderr + JSON.stringify(pend));
  report('2.30d #9: the forcing agent and a same-family reviewer cannot close it; another family (or a person) can', self.status !== 0 && same.status !== 0 && /another model family/.test(same.stderr) && agentNoModel.status !== 0 && other.status === 0 && ev().some((e) => e.type === 'task.pending_closed' && e.task === tf), [self.stderr, same.stderr, agentNoModel.stderr, other.stdout + other.stderr].join('\n'));
  run(dir, 'node harness/task.mjs add "Write the pier notes" --type docs --infra');
  const tf2 = idOf('Write the pier notes');
  run(dir, `node harness/task.mjs done ${tf2} --agent builder-7 --force --reason "no time left today"`);
  const reo = run(dir, `node harness/task.mjs review ${tf2} --reopen --by trever --note "needs the pier length"`);
  report('2.30d #9: a person reopens forced work: it goes back on the queue with the note', reo.status === 0 && new RegExp(`\\[ \\] \\*\\*${tf2}\\*\\*`).test(queue()) && /needs the pier length/.test(fs.readFileSync(path.join(dir, 'studio', 'handoffs', `${tf2}.md`), 'utf8')), reo.stdout + reo.stderr);
  // #5: a builder task over size 3 gets a linked planner split and waits for it.
  const big = run(dir, 'node harness/task.mjs add "Build the whole harbour economy" --size 5 --infra');
  const bigJ = (() => { try { return JSON.parse(big.stdout); } catch { return {}; } })();
  const holds = JSON.parse(fs.readFileSync(path.join(dir, 'studio', 'task-holds.json'), 'utf8')).tasks;
  report('2.30d #5: task add --size 5 for a builder auto-creates a linked planner split task, and the big task waits for it', big.status === 0 && bigJ.split && new RegExp(`\\(\`planner\`\\) — Split ${bigJ.id} into builder tasks of size 3`).test(queue()) && holds[bigJ.id]?.after?.includes(bigJ.split) && ev().some((e) => e.type === 'task.split_needed'), big.stdout + big.stderr);
  const small = run(dir, 'node harness/task.mjs add "Paint the bollards" --size 3 --infra');
  report('2.30d #5: size 3 or less queues normally', small.status === 0 && !/split/i.test(small.stderr), small.stderr);
  // #6: only the Director, Producer and planner add to the live queue; others propose with a reason.
  const bNo = run(dir, 'node harness/task.mjs add "Add rope physics" --infra', { STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-3' });
  const bYes = run(dir, 'node harness/task.mjs add "Add rope physics" --infra --size 5 --why "mooring looks stiff"', { STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-3' });
  const inQueue = /Add rope physics/.test(queue());
  const bProm = run(dir, 'node harness/task.mjs promote --all --by builder-3', { STUDIO_ROLE: 'builder' });
  const pProm = run(dir, 'node harness/task.mjs promote --all --by producer-1', { STUDIO_ROLE: 'producer' });
  const dYes = run(dir, 'node harness/task.mjs add "Plan the night market" --type study --infra', { STUDIO_ROLE: 'director', STUDIO_LOCK_OWNER: 'director-1' });
  report('2.30d #6: a builder\'s add needs a one-line why and waits on the proposed list; the Producer promotes it in a batch (a big one still gets its live planner split); the Director adds directly', bNo.status !== 0 && /--why/.test(bNo.stderr) && bYes.status === 0 && /Proposed P-1/.test(bYes.stdout) && !inQueue && bProm.status !== 0 && pProm.status === 0 && /Add rope physics/.test(queue()) && /\(`planner`\) — Split T-\d+ into builder tasks of size 3 or less: Add rope physics/.test(queue()) && /Plan the night market/.test(queue()) && ev().some((e) => e.type === 'proposed.promoted'), [bNo.stderr, bYes.stdout, bProm.stderr, pProm.stdout + pProm.stderr, dYes.stderr].join('\n'));
  // #3: after a failed hand-back, one model tier up (suggested, or applied when the tier's model is set).
  const esc = probe(`import { escalationFor } from ${u('harness/model-tiers.mjs')};
const t = (type, model) => ({ type, task: 'T-500', model, ts: new Date().toISOString() });
const one = [t('task.start', 'claude-haiku-4'), t('task.paused')];
const two = [...one, t('task.start', 'claude-sonnet-4-5'), t('task.paused')];
console.log(JSON.stringify({ none: escalationFor('T-500', { events: [t('task.start', 'claude-haiku-4')], env: {} }), one: escalationFor('T-500', { events: one, env: {} }), set: escalationFor('T-500', { events: one, env: { STUDIO_TIER_MID_MODEL: 'claude-sonnet-4-5' } }), two: escalationFor('T-500', { events: two, env: {} }), done: escalationFor('T-500', { events: [...one, t('task.done')], env: {} }) }));`);
  report('2.30d #3: a failed hand-back moves the next session one model tier up (suggested; applied when STUDIO_TIER_<TIER>_MODEL is set)', esc.none === null && esc.one?.from === 'cheap' && esc.one.tier === 'mid' && !esc.one.applied && esc.set?.applied && esc.set.model === 'claude-sonnet-4-5' && esc.two?.from === 'mid' && esc.two.tier === 'top' && esc.done === null, JSON.stringify(esc));
  const ag = fs.readFileSync(path.join(dir, 'harness', 'agent.mjs'), 'utf8');
  report('2.30d #3: the launcher applies the escalation when no model was named for the task', /escalationFor\(opts\.task\)/.test(ag) && /model\.escalated/.test(ag), '');
  // Cheat sheet tricks are matched and pre-approved when the task is added (up to 3, logged).
  fs.writeFileSync(path.join(dir, 'studio', 'CHEATSHEET.md'), '# Cheat sheet\n- C-001 [dock,boats] Reuse the berth grid → no new layout code\n- C-002 [boats] Keep boat paths in the sim → render reads them\n- C-003 [boats,waves] Waves are a shader → no sim cost\n- C-004 [boats] Extra boat line\n- C-009 [director,boats] Plan boats in size-3 slices\n');
  const tr = run(dir, 'node harness/task.mjs add "Give the boats wider hulls at the dock" --infra');
  const trJ = (() => { try { return JSON.parse(tr.stdout); } catch { return {}; } })();
  const att = fs.existsSync(path.join(dir, '.studio', 'cheatsheet', `${trJ.id}.json`)) ? JSON.parse(fs.readFileSync(path.join(dir, '.studio', 'cheatsheet', `${trJ.id}.json`), 'utf8')) : {};
  report('2.30d: task add auto-attaches up to 3 matching cheat sheet tricks as pre-approved (never a director line), and logs it', att.tricks?.length === 3 && att.tricks[0].id === 'C-001' && !att.tricks.some((t) => t.id === 'C-009') && att.preapproved?.ids?.length === 3 && ev().some((e) => e.type === 'cheatsheet.preapproved' && e.task === trJ.id), tr.stderr + JSON.stringify(att));
  // Fun check in waves: a gameplay task closes into the open wave; probes run on the batch once it is ready.
  const wv = probe(`import { gameplayChecks } from ${u('harness/done-check.mjs')};
import * as W from ${u('harness/waves.mjs')};
import fs from 'node:fs';
const checks = []; gameplayChecks({ id: 'T-901', title: 'Fix WASD movement' }, 'renderer', Date.now() - 60000, (label, ok, why) => checks.push({ label, ok: Boolean(ok), why }));
W.joinWave('T-901', { by: 'builder-1' }); W.joinWave('T-902', { by: 'builder-2' });
const ready = W.markReady({ by: 'producer-1' });
const next = W.joinWave('T-903', { by: 'builder-1' });
const noPlay = await W.checkWave({ by: 'producer-1' });
fs.mkdirSync('qa/reports', { recursive: true });
fs.writeFileSync('qa/reports/browser_9100.json', JSON.stringify({ at: new Date(Date.now() + 1000).toISOString(), probes: [{ name: 'move', ok: false, why: 'not camera-relative' }, { name: 'jump', ok: true }] }));
const failed = await W.checkWave({ by: 'producer-1' });
W.markReady({ by: 'producer-1' });
fs.writeFileSync('qa/reports/browser_9200.json', JSON.stringify({ at: new Date(Date.now() + 2000).toISOString(), probes: [{ name: 'move', ok: true }] }));
const passed = await W.checkWave({ by: 'producer-1' });
fs.rmSync('qa/reports/browser_9100.json'); fs.rmSync('qa/reports/browser_9200.json');
console.log(JSON.stringify({ checks, ready: ready.wave?.id, next: next.id, noPlay: noPlay.result, failed: { r: failed.result, fix: failed.wave?.fixTask, failing: failed.wave?.failing }, passed: passed.result }));`, { STUDIO_ROLE: 'producer' });
  report('2.30d #6 waves: in wave mode a gameplay task\'s done check names its wave instead of running the probes per task', wv.checks?.length === 1 && wv.checks[0].ok && /joins wave W-1/.test(wv.checks[0].label), JSON.stringify(wv.checks || wv));
  report('2.30d waves: a batch-ready wave is checked once; a new wave opens for work that keeps closing; a failing play gives one linked fix task; a passing play passes the wave', wv.ready === 'W-1' && wv.next === 'W-2' && wv.noPlay === 'no-play' && wv.failed?.r === 'failed' && /^T-\d+$/.test(wv.failed.fix || '') && /not camera-relative/.test(wv.failed.failing?.[0] || '') && wv.passed === 'passed' && new RegExp(`Fix wave W-1`).test(queue()), JSON.stringify(wv));
  // Away mode: the Director and Producer decide while the dev is away; the dev confirms, sends back or comments.
  run(dir, 'node harness/task.mjs add "Tune the ferry timetable" --type docs --infra');
  const ta = idOf('Tune the ferry timetable');
  fs.mkdirSync(path.join(dir, 'qa', 'reports', 'shots'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'qa', 'reports', 'shots', 'pier.png'), 'png');
  const aw = probe(`import * as A from ${u('harness/away.mjs')};
import { emitEvent } from ${u('harness/event.mjs')};
import { completeTask } from ${u('harness/task.mjs')};
import fs from 'node:fs';
A.goAway('trever', { note: 'sleeping' });
await new Promise((r) => setTimeout(r, 15));
emitEvent({ type: 'task.added', agent: 'producer-1', task: 'T-777', msg: 'Queued T-777: Night lights on the pier', meta: { shot: 'qa/reports/shots/pier.png' } });
emitEvent({ type: 'task.added', agent: 'builder-1', task: 'T-778', msg: 'not a decision' });
completeTask('${ta}', '', 'producer-1', { force: true, reason: 'fixture', acceptedBy: 'selftest' });
emitEvent({ type: 'decision.made', agent: 'director-1', msg: 'Ferries before trains', meta: { clip: 'qa/reports/clips/ferry.webm' } });
const back = A.comeBack('trever');
const items = A.listReview();
const pick = (re) => items.find((i) => re.test(i.title));
const great = await A.verdict(pick(/Night lights/).id, { by: 'trever', verdict: 'great' });
const redo = await A.verdict(pick(/${ta}/).id, { by: 'trever', verdict: 'redo', comment: 'wrong ferry times' });
let noComment = null; try { await A.verdict(pick(/Ferries/).id, { by: 'trever', verdict: 'comment' }); } catch (e) { noComment = e.message; }
await A.verdict(pick(/Ferries/).id, { by: 'trever', verdict: 'comment', comment: 'keep one train line' });
console.log(JSON.stringify({ n: back.items.length, types: items.map((i) => i.type), media: pick(/Night lights/).media, clip: pick(/Ferries/).media, left: A.listReview().length, learned: A.learnedSummary(), noComment, md: fs.readFileSync('studio/memory/decisions-learned.md', 'utf8') }));`);
  report('2.30d away: on return every Director/Producer decision made while away is listed with its pictures or clip (worker chatter is not)', aw.n >= 3 && !aw.types?.includes(undefined) && aw.media?.[0]?.kind === 'image' && aw.clip?.[0]?.kind === 'clip' && !JSON.stringify(aw).includes('not a decision'), JSON.stringify(aw).slice(0, 1500));
  report('2.30d away: ✅ marks it great, ❌ reopens the work, a comment needs words and goes to the workers; the verdicts are kept for the Director and Producer to learn from', aw.left === aw.n - 3 && aw.learned?.great === 1 && aw.learned.redo === 1 && aw.learned.comment === 1 && aw.learned.byDecider?.['producer-1']?.great === 1 && /comment/.test(aw.noComment || '') && /\[redo\]/.test(aw.md || '') && new RegExp(`\\[ \\] \\*\\*${ta}\\*\\*`).test(queue()) && ev().filter((e) => e.type === 'away.verdict').length === 3, JSON.stringify(aw).slice(0, 1500));
  // Phone alerts: opt-in, no key in a file or the log, the first pass never floods, a real event is sent once.
  const al = probe(`import * as A from ${u('harness/alerts.mjs')};
import { emitEvent, readRecentEvents } from ${u('harness/event.mjs')};
import fs from 'node:fs';
const calls = []; const fetchImpl = async (url, opts) => { calls.push({ url, h: opts.headers }); return { ok: true }; };
const off = await A.alertPass({ fetchImpl });
const noChat = A.setAlerts({ on: true, channel: 'telegram' }, 'trever');
A.setAlerts({ on: true, channel: 'ntfy', topic: 'studio-x7q2', server: 'https://ntfy.example' }, 'trever');
const first = await A.alertPass({ fetchImpl, cfg: A.readAlerts() });
emitEvent({ type: 'studio.stopped', agent: 'watchdog', msg: 'no task finished in 2 h' });
emitEvent({ type: 'task.done', agent: 'b', msg: 'not alerted' });
const second = await A.alertPass({ fetchImpl, cfg: A.readAlerts() });
const third = await A.alertPass({ fetchImpl, cfg: A.readAlerts() });
const dry = await A.sendAlert({ type: 'studio.stopped', msg: 'x' }, { cfg: { on: true, channel: 'telegram', chatId: '42' }, env: { STUDIO_TELEGRAM_BOT_TOKEN: '123:SECRET-TOKEN' }, dryRun: true });
console.log(JSON.stringify({ off, noChat: noChat.ok, first, second, third, calls, dry: dry.request?.url, file: fs.readFileSync('.studio/alerts.json', 'utf8'), log: readRecentEvents(200).some((e) => JSON.stringify(e).includes('SECRET-TOKEN')) }));`, { STUDIO_TELEGRAM_BOT_TOKEN: '' });
  report('2.30d alerts: off by default; turning on never floods; a stop is sent once by ntfy; a Telegram key never reaches a file, the log or a dry run', al.off?.sent === 0 && al.noChat === false && al.first?.sent === 0 && al.second?.sent === 1 && al.third?.sent === 0 && al.calls?.length === 1 && al.calls[0].url === 'https://ntfy.example/studio-x7q2' && /\*\*\*/.test(al.dry || '') && !/SECRET/.test(al.dry || '') && !/token/i.test(al.file || '') && al.log === false, JSON.stringify(al).slice(0, 1200));
  // Phone access: off by default; a one-time code, rate-limited; the session cookie reads, writes need its CSRF value.
  const ph = probe(`import * as P from ${u('harness/phone.mjs')};
import fs from 'node:fs';
const offLogin = P.login('ABCDEFGH', { ip: '10.0.0.9' });
const on = P.phoneOn('trever');
const bad = []; for (let i = 0; i < 6; i++) bad.push(P.login('WRONG123', { ip: '10.0.0.5' }));
const locked = P.login(on.code, { ip: '10.0.0.5' });
const ok = P.login(on.code.toLowerCase(), { ip: '10.0.0.6', ua: 'phone' });
const reuse = P.login(on.code, { ip: '10.0.0.7' });
const read = P.checkSession(ok.sid);
const writeNo = P.checkSession(ok.sid, { write: true });
const writeBad = P.checkSession(ok.sid, { write: true, csrf: 'nope' });
const writeOk = P.checkSession(ok.sid, { write: true, csrf: ok.csrf });
const files = ['phone', 'sessions'].map((f) => fs.readFileSync('.studio/phone/' + f + '.json', 'utf8')).join('');
P.phoneOff('trever');
const afterOff = P.checkSession(ok.sid);
console.log(JSON.stringify({ offLogin: offLogin.ok, code: /^[2-9A-HJKMNP-Z]{8}$/.test(on.code), bad5: bad[4].retryAfterSec === undefined && bad[5].retryAfterSec > 0, locked: locked.ok, ok: ok.ok, reuse: reuse.ok, read: read.ok, writeNo: writeNo.ok, writeBad: writeBad.ok, writeOk: writeOk.ok, leaked: files.includes(ok.sid) || files.includes(ok.csrf) || files.includes(on.code), afterOff: afterOff.ok, cookie: P.sessionCookie('x', new Date(Date.now() + 1000)) }));`);
  report('2.30d phone: off by default; a one-time code logs one phone in; 5 wrong codes lock that address; writes need the session\'s CSRF value; no code, session or CSRF value is stored in clear; off ends every session', ph.offLogin === false && ph.code && ph.bad5 && ph.locked === false && ph.ok && ph.reuse === false && ph.read && ph.writeNo === false && ph.writeBad === false && ph.writeOk && ph.leaked === false && ph.afterOff === false && /HttpOnly; SameSite=Strict/.test(ph.cookie || ''), JSON.stringify(ph));
  const srv = fs.readFileSync(path.join(dir, 'hub', 'server.mjs'), 'utf8');
  report('2.30d phone: the hub serves /phone only while phone access is on, and a phone write needs the cookie plus X-Phone-CSRF', /url\.pathname === '\/phone' && req\.method === 'GET'[\s\S]{0,80}readPhone\(\)\.on/.test(srv) && /x-phone-csrf/.test(srv) && /return tokenMatches\(headerToken\(req\)\) \|\| phoneWrite\(req\);/.test(srv), '');
  // The watchdog is a dog in its own room of the studio floor: asleep when off, patrolling when on.
  const html = fs.readFileSync(path.join(dir, 'hub', 'v3', 'index.html'), 'utf8');
  report('2.30d: the watchdog has its own kennel room on the studio floor and a dog that sleeps when off and patrols when on', /id: 'kennel'/.test(html) && /function renderDog/.test(html) && /classList\.toggle\('asleep', !on\)/.test(html) && /setInterval\(step/.test(html) && /id="away" class="skin"/.test(html), '');
  const hs = probe(`import { buildHudState } from ${u('harness/hud.mjs')};
const s = buildHudState();
console.log(JSON.stringify({ away: s.away && Array.isArray(s.away.review), pending: Array.isArray(s.pendingReview), waves: s.waves?.on, alerts: s.alerts?.on, phone: s.phone?.on }));`);
  report('2.30d: the War Room state carries away mode and its review, pending forced work, proposals, waves, alerts and phone', hs.away && hs.pending && hs.waves === true && hs.alerts === true && hs.phone === false, JSON.stringify(hs));
}

// 2.30e: the art scout widened (palettes, kinds) and the art agent's adapt step (recolour, resize, LODs, mesh fixes).
{
  const dir = copyRepo();
  const zlib = await import('node:zlib');
  // An offline Lospec: one CC0 palette, one CC-BY-NC palette.
  const fake = path.join(dir, 'fake-lospec.mjs');
  fs.writeFileSync(fake, `export default async (url) => {
  const nc = url.includes('nc-pal');
  if (url.endsWith('.json')) return { ok: true, json: async () => ({ name: nc ? 'NC Pal' : 'Sea Four', author: 'Pal Maker', colors: ['102030', 'e0d0c0', '3070b0', 'f0a040'] }) };
  return { ok: true, text: async () => '<p>Licence: ' + (nc ? 'CC BY-NC 4.0' : 'CC0') + '</p>' };
};\n`);
  const palOk = run(dir, `node harness/asset-scout.mjs palette sea-four --fetch fake-lospec.mjs`);
  const palNc = run(dir, `node harness/asset-scout.mjs palette nc-pal --fetch fake-lospec.mjs`);
  const pal = fs.existsSync(path.join(dir, 'studio/art/palette.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'studio/art/palette.json'), 'utf8')) : {};
  const man = () => JSON.parse(fs.readFileSync(path.join(dir, 'studio/assets/manifest.json'), 'utf8')).assets;
  report('2.30e G7: a CC0 palette is pulled into the ledger (kind palette) and becomes studio/art/palette.json; a CC-BY-NC one is refused', palOk.status === 0 && pal.colors?.length === 4 && man().some((a) => a.kind === 'palette' && a.file === 'assets/scouted/lospec/sea-four.json') && palNc.status !== 0 && /only CC0 or CC-BY/.test(palNc.stderr) && !fs.existsSync(path.join(dir, 'assets/scouted/lospec/nc-pal.json')), `${palOk.stdout}${palOk.stderr}${palNc.stdout}${palNc.stderr}`);
  // An 8x4 RGBA texture with colours off the palette, written by hand (not by the module's encoder).
  const crcT = new Uint32Array(256).map((_, k) => { let c = k; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b) => { let c = -1; for (const x of b) c = (c >>> 8) ^ crcT[(c ^ x) & 0xff]; return (c ^ -1) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const W = 8, H = 4;
  const rows = [];
  // Row 1 uses the Sub filter (each byte minus the one a pixel left), so the decoder's filters are exercised.
  for (let y = 0; y < H; y++) {
    const raw = [];
    for (let x = 0; x < W; x++) raw.push((x * 37 + y * 11) % 256, (x * 91) % 256, (y * 70) % 256, 200);
    rows.push(Buffer.from([y === 1 ? 1 : 0, ...(y === 1 ? raw.map((v, i) => (v - (i >= 4 ? raw[i - 4] : 0) + 256) % 256) : raw)]));
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
  fs.writeFileSync(path.join(dir, 'tex.png'), Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]));
  const pulled = run(dir, 'node harness/asset-scout.mjs pull tex.png --licence CC-BY-4.0 --author "Tex Author" --source https://example.org/tex --title "Sand tex" --kind texture');
  const texId = (pulled.stdout.match(/A-\d+/) || [])[0];
  const ad = run(dir, `node harness/art-adapt.mjs ${texId} --max 4 --by art-1`);
  const out = path.join(dir, 'assets/adapted/tex.png');
  let colours = [], size = '';
  if (fs.existsSync(out)) {
    const { decodePng } = await import(pathToFileURL(path.join(dir, 'harness/art-adapt.mjs')).href);
    const img = decodePng(fs.readFileSync(out));
    size = `${img.width}x${img.height}`;
    for (let i = 0; i < img.pixels.length; i += 4) colours.push('#' + [0, 1, 2].map((c) => img.pixels[i + c].toString(16).padStart(2, '0')).join('') + `/${img.pixels[i + 3]}`);
  }
  const adapted = man().find((a) => a.file === 'assets/adapted/tex.png');
  const credits = fs.existsSync(path.join(dir, 'CREDITS.md')) ? fs.readFileSync(path.join(dir, 'CREDITS.md'), 'utf8') : '';
  report('2.30e G7: adapt recolours a texture to the palette (alpha kept), resizes it to a power of two, and records it as derived with the credit carried', ad.status === 0 && size === '4x2' && colours.length === 8 && colours.every((c) => pal.colors.includes(c.split('/')[0]) && c.endsWith('/200')) && adapted?.derivedFrom === texId && /palette/.test(adapted?.adapted?.palette || '') && adapted?.licence === 'CC-BY-4.0' && (credits.match(/Tex Author/g) || []).length >= 2, `size=${size} ${colours.join(',')} ${ad.stdout}${ad.stderr} ${JSON.stringify(adapted)}\n${credits}`);
  // A 10x10 grid of quads, with a duplicate vertex and a degenerate face to fix.
  const L = [];
  for (let y = 0; y <= 10; y++) for (let x = 0; x <= 10; x++) L.push(`v ${x / 10} ${y / 10} 0`);
  L.push('v 0 0 0');
  for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) { const a = y * 11 + x + 1; L.push(`f ${a} ${a + 1} ${a + 12} ${a + 11}`); }
  L.push('f 1 1 2', 'f 122 2 13');
  fs.writeFileSync(path.join(dir, 'grid.obj'), `${L.join('\n')}\n`);
  const pm = run(dir, 'node harness/asset-scout.mjs pull grid.obj --licence CC0 --source https://example.org/grid --title Grid');
  const meshId = (pm.stdout.match(/A-\d+/) || [])[0];
  const am = run(dir, `node harness/art-adapt.mjs ${meshId} --lod 2 --by art-1`);
  const faces = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => l.startsWith('f ')).length : -1);
  const verts = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => l.startsWith('v ')).length : -1);
  const fixedF = faces('assets/adapted/grid.obj'), l1 = faces('assets/adapted/grid.lod1.obj'), l2 = faces('assets/adapted/grid.lod2.obj');
  const badRef = fs.existsSync(path.join(dir, 'assets/adapted/grid.lod1.obj')) && fs.readFileSync(path.join(dir, 'assets/adapted/grid.lod1.obj'), 'utf8').split('\n').filter((l) => l.startsWith('f ')).some((l) => l.slice(2).split(' ').some((v) => Number(v.split('/')[0]) > verts('assets/adapted/grid.lod1.obj')));
  report('2.30e G7: adapt fixes a mesh (welds the duplicate vertex, drops the degenerate face) and makes LODs with fewer faces and valid indices, all in the ledger', am.status === 0 && fixedF === 101 && verts('assets/adapted/grid.obj') === 121 && l1 > 0 && l1 < fixedF && l2 > 0 && l2 < l1 && !badRef && man().filter((a) => a.derivedFrom === meshId).length === 3, `${am.stdout}${am.stderr} fixed=${fixedF} v=${verts('assets/adapted/grid.obj')} lod1=${l1} lod2=${l2} badRef=${badRef}`);
  // glTF/GLB: checked, then passed through unchanged; a broken one is refused and nothing is written.
  const glb = (json, bin, lie = 0) => {
    const pad = (b, c) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, c)]);
    const j = pad(Buffer.from(JSON.stringify(json)), 0x20), b = pad(bin, 0);
    const head = Buffer.alloc(12); head.write('glTF', 0, 'ascii'); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + j.length + 8 + b.length + lie, 8);
    const ch = (buf, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(buf.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, buf]); };
    return Buffer.concat([head, ch(j, 0x4e4f534a), ch(b, 0x004e4942)]);
  };
  const gj = { asset: { version: '2.0' }, buffers: [{ byteLength: 12 }], bufferViews: [{ buffer: 0, byteLength: 12 }], accessors: [{ bufferView: 0, componentType: 5126, count: 1, type: 'VEC3' }] };
  fs.writeFileSync(path.join(dir, 'boat.glb'), glb(gj, Buffer.alloc(12)));
  fs.writeFileSync(path.join(dir, 'bad.glb'), glb({ ...gj, bufferViews: [{ buffer: 0, byteLength: 64 }] }, Buffer.alloc(12), 4));
  fs.writeFileSync(path.join(dir, 'lost.gltf'), JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'lost.bin', byteLength: 12 }] }));
  const gid = (f) => (run(dir, `node harness/asset-scout.mjs pull ${f} --licence CC0 --source https://example.org/${f} --title ${f}`).stdout.match(/A-\d+/) || [])[0];
  const okG = run(dir, `node harness/art-adapt.mjs ${gid('boat.glb')} --by art-1`);
  const badG = run(dir, `node harness/art-adapt.mjs ${gid('bad.glb')} --by art-1`);
  const lostG = run(dir, `node harness/art-adapt.mjs ${gid('lost.gltf')} --by art-1`);
  const same = fs.existsSync(path.join(dir, 'assets/adapted/boat.glb')) && fs.readFileSync(path.join(dir, 'assets/adapted/boat.glb')).equals(fs.readFileSync(path.join(dir, 'boat.glb')));
  report('2.30e G7: adapt checks a GLB and copies it unchanged into the ledger; a GLB with a wrong length and a view past its buffer, and a .gltf with a missing buffer file, are refused with nothing written', okG.status === 0 && same && man().some((a) => a.file === 'assets/adapted/boat.glb' && a.derivedFrom && a.adapted?.steps?.includes('validate-gltf')) && badG.status !== 0 && /header says/.test(badG.stderr) && /bufferView 0 runs past/.test(badG.stderr) && !fs.existsSync(path.join(dir, 'assets/adapted/bad.glb')) && lostG.status !== 0 && /lost\.bin is missing/.test(lostG.stderr) && !fs.existsSync(path.join(dir, 'assets/adapted/lost.gltf')), `${okG.stdout}${okG.stderr}|${badG.stderr}|${lostG.stderr}`);
  const gate = run(dir, 'node scripts/check-assets.mjs');
  report('2.30e G7: the assets gate passes with palettes and adapted art in the ledger', gate.status === 0, `${gate.stdout}${gate.stderr}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 2.30e: the scout judges quality (0-10) from resolution, maps, poly count, popularity and tags, with an optional vision judge.
{
  const dir = copyRepo();
  fs.writeFileSync(path.join(dir, 'fake-sources.mjs'), `export default async (url, opts) => {
  if (url.includes('api.polyhaven.com')) return { ok: true, json: async () => ({
    crate_good: { name: 'Crate Good', type: 2, tags: ['crate', 'wood', 'box', 'prop', 'cargo', 'old'], max_resolution: [4096, 4096], polycount: 5000, download_count: 900000, authors: { A: 'All' }, thumbnail_url: 'https://x/crate_good.png' },
    crate_bad: { name: 'Crate Bad', type: 2, tags: ['crate'], max_resolution: [512, 512], polycount: 3000000, download_count: 3, authors: { B: 'All' }, thumbnail_url: 'https://x/crate_bad.png' },
  }) };
  if (url.includes('ambientcg.com')) return { ok: true, json: async () => ({ foundAssets: [
    { assetId: 'CrateFull', displayName: 'Crate Full', maps: ['color', 'normal', 'roughness'], downloadCount: '5000', tags: ['crate', 'wood', 'planks', 'box'] },
    { assetId: 'CrateFlat', displayName: 'Crate Flat', maps: ['color'], downloadCount: '5000', tags: ['crate', 'wood', 'planks', 'box'] },
  ] }) };
  if (url.endsWith('/chat/completions')) return { ok: true, json: async () => ({ choices: [{ message: { content: '{"score": 2, "why": "muddy"}' } }], usage: { prompt_tokens: 700, completion_tokens: 30 } }) };
  return { ok: false, status: 404 };
};\n`);
  const all = run(dir, 'node harness/asset-scout.mjs find crate --kind any --fetch fake-sources.mjs');
  const q = (name, out = all.stdout) => Number((out.match(new RegExp(`q\\s*([\\d.]+)\\s+\\S+\\s+\\[\\w+\\] ${name} `)) || [])[1]);
  const order = [...all.stdout.matchAll(/q\s*([\d.]+)\s/g)].map((m) => Number(m[1]));
  report('2.30e G7: the scout scores each hit 0-10: a 4k, sane-poly, popular, well-tagged model beats a 512px 3M-tri one, and full maps beat colour only', all.status === 0 && q('Crate Good') >= 8 && q('Crate Bad') <= 3 && q('Crate Full') > q('Crate Flat') && order.length === 4 && order.every((v, i) => i === 0 || order[i - 1] >= v) && /maps albedo\+normal\+roughness/.test(all.stdout) && /poly 3000000 tris/.test(all.stdout), all.stdout + all.stderr);
  const min = run(dir, 'node harness/asset-scout.mjs find crate --kind any --min-quality 6 --fetch fake-sources.mjs');
  report('2.30e G7: --min-quality drops hits under the bar and says how many were left out', min.status === 0 && /Crate Good/.test(min.stdout) && !/Crate Bad/.test(min.stdout) && /below --min-quality 6 left out/.test(min.stdout), min.stdout + min.stderr);
  const vis = run(dir, 'node harness/asset-scout.mjs find crate --kind model --vision --fetch fake-sources.mjs', { STUDIO_VISION_URL: 'http://vision.test/v1', STUDIO_VISION_MODEL: 'fake-vision-1' });
  const led = run(dir, 'node harness/ledger.mjs --by model');
  report('2.30e G7: the vision judge (STUDIO_VISION_URL) is averaged into the score, and its tokens land in the token ledger under its model', vis.status === 0 && /vision 2\/10 \(fake-vision-1\)/.test(vis.stdout) && q('Crate Good', vis.stdout) < q('Crate Good') && /fake-vision-1\s+2 calls\s+in\s+1k/.test(led.stdout), vis.stdout + vis.stderr + led.stdout);
  const pulled = run(dir, `node harness/asset-scout.mjs pull fake-sources.mjs --licence CC0 --source https://polyhaven.com/a/crate_good --title "Crate Good" --quality ${q('Crate Good')}`);
  const entry = JSON.parse(fs.readFileSync(path.join(dir, 'studio/assets/manifest.json'), 'utf8')).assets.find((a) => a.title === 'Crate Good');
  report('2.30e G7: a pulled asset keeps its quality score in the asset ledger', pulled.status === 0 && entry?.quality === q('Crate Good'), pulled.stdout + pulled.stderr + JSON.stringify(entry));
}

// 2.30e: token ledger and gate cache.
{
  const dir = copyRepo();
  const eventsPath = path.join(dir, '.studio', 'events.jsonl');
  fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
  const ledgerLogPath = path.join(dir, 'studio', 'ledger', 'proxy.jsonl');
  fs.mkdirSync(path.dirname(ledgerLogPath), { recursive: true });

  const now = Date.now();
  const ts = (offset) => new Date(now - offset).toISOString();

  const events = [
    { ts: ts(3600e3), type: 'agent.session.start', agent: 'agent-1', task: 'T-001' },
    { ts: ts(3100e3), type: 'task.done', agent: 'agent-1', task: 'T-001' },
    { ts: ts(3000e3), type: 'agent.session.end', agent: 'agent-1', model: 'claude-3-opus', tokensIn: 100, tokensOut: 200, meta: { tool: 'anthropic', turns: 10 } },
    { ts: ts(2000e3), type: 'agent.session.start', agent: 'agent-2', task: 'T-002' },
    { ts: ts(1000e3), type: 'agent.session.end', agent: 'agent-2', model: 'claude-3-sonnet', tokensIn: 50, tokensOut: 50, meta: { tool: 'anthropic', turns: 5 } },
    { ts: ts(500e3), type: 'route.success', provider: 'openrouter-free', model: 'some-free-model', agent: 'agent-3', meta: { chars: 1000 } },
  ];
  fs.writeFileSync(eventsPath, events.map(JSON.stringify).join('\n') + '\n');
  fs.writeFileSync(ledgerLogPath, JSON.stringify({ at: ts(400e3), agent: 'agent-4', role: 'executor', model: 'gemini-1.5-pro', tokensIn: 1000, tokensOut: 1000 }) + '\n');

  const res = run(dir, 'node harness/ledger.mjs');
  report('2.30e: ledger: noDonePct is 50% for 2 sessions, 1 done; 300 tokens for the finished task', /No-done sessions: 50%/.test(res.stdout) && /Tokens per finished task: 300\b/.test(res.stdout), res.stdout + res.stderr);
  report('2.30e: ledger: every token count names its model (single model by name, mixed totals as shares, per group)', /Tokens per finished task: 300 \(claude-3-opus\)/.test(res.stdout) && /Measured: .*\(mixed: gemini-1\.5-pro \d+%, claude-3-opus \d+%/.test(res.stdout) && /Estimated: .*\(some-free-model est\.\)/.test(res.stdout) && /google .*\[gemini-1\.5-pro\]/.test(res.stdout), res.stdout + res.stderr);
  {
    const mod = await import(pathToFileURL(path.join(dir, 'harness/ledger.mjs')).href);
    const mix = mod.modelMix([{ model: 'unknown', tokensIn: 1, tokensOut: 0 }, { tokensIn: 1, tokensOut: 0 }]);
    report('2.30e: ledger: a session with no model reads "model not recorded", never "unknown"', mix === 'model not recorded', mix);
  }
  report('2.30e: ledger: free provider call is estimated', /openrouter-free .*\(1 est\. calls, out 250\)/.test(res.stdout), res.stdout + res.stderr);
  report('2.30e: ledger: proxy log is counted under google', /google\s+1 calls\s+in\s+1k\s+out\s+1k/.test(res.stdout), res.stdout + res.stderr);
  report('2.30e: ledger: output contains no cost figures', !/\$|cost/i.test(res.stdout), res.stdout + res.stderr);

  const dir2 = copyRepo();
  const cmd = 'node scripts/run-gates.mjs --tier fast --only purity';
  const res1 = run(dir2, cmd);
  report('2.30e: gate-cache: first run of purity passes', res1.status === 0 && /PASS purity/.test(res1.stdout) && !/cached/.test(res1.stdout), `${res1.stdout}${res1.stderr}`);

  const res2 = run(dir2, cmd);
  report('2.30e: gate-cache: second run of purity is cached', res2.status === 0 && /PASS purity \(cached/.test(res2.stdout), `${res2.stdout}${res2.stderr}`);

  SABOTAGE.purity(dir2);
  const res3 = run(dir2, cmd);
  report('2.30e: gate-cache: purity fails after sabotage, not from cache', res3.status === 1 && /FAIL purity/.test(res3.stdout) && !/cached/.test(res3.stdout), `${res3.stdout}${res3.stderr}`);

  const dir3 = copyRepo();
  run(dir3, 'node scripts/run-gates.mjs --tier fast --only purity'); // prime cache
  const resMerge = run(dir3, 'node scripts/run-gates.mjs --tier merge --only purity');
  report('2.30e: gate-cache: merge tier ignores cache', resMerge.status === 0 && /PASS purity/.test(resMerge.stdout) && !/\(cached/.test(resMerge.stdout), `${resMerge.stdout}${resMerge.stderr}`);
  for (const d of [dir, dir2, dir3]) fs.rmSync(d, { recursive: true, force: true });
}

// 2.30e: rehearsal mode (R6) runs the real launcher on board tasks with no model; F15 vision check is opt-in.
{
  const dir = copyRepo();
  run(dir, 'node harness/task.mjs add "Rehearsal task one" --role builder');
  run(dir, 'node harness/task.mjs add "Rehearsal task two" --role builder');
  const reh = run(dir, 'node harness/rehearsal.mjs --tasks 3', { STUDIO_HEARTBEAT_SEC: '1' });
  const ev = fs.existsSync(path.join(dir, '.studio/events.jsonl')) ? fs.readFileSync(path.join(dir, '.studio/events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const ends = ev.filter((e) => e.type === 'agent.session.end' && /rehearsal/.test(e.agent));
  const docs = fs.existsSync(path.join(dir, 'docs/rehearsal')) ? fs.readdirSync(path.join(dir, 'docs/rehearsal')).length : 0;
  report('2.30e R6: rehearse takes 3 builder tasks through the launcher (claim, work, done, session events) with 0 model tokens', reh.status === 0 && /3 started, 3 done/.test(reh.stdout) && /model tokens 0/.test(reh.stdout) && ends.length === 3 && ends.every((e) => !e.tokensIn && !e.tokensOut) && docs === 3, `${reh.stdout}${reh.stderr}`);
  const routed = run(dir, `node -e "import('./harness/route.mjs').then(async (m) => { const r = await m.routeChatCompletion({ role: 'producer', messages: [{ role: 'user', content: 'hi' }] }); console.log(JSON.stringify({ ok: r.ok, provider: r.provider, t: r.tokensIn + r.tokensOut, c: r.content })); })"`, { STUDIO_REHEARSAL: '1' });
  report('2.30e R6: in rehearsal the router answers from the script with zero tokens and no provider called', /"ok":true,"provider":"rehearsal","t":0,"c":"[^"]+"/.test(routed.stdout), `${routed.stdout}${routed.stderr}`);
  const off = run(dir, 'node qa/vision-check.mjs');
  fs.mkdirSync(path.join(dir, 'studio/proof'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'shot.png'), 'png');
  fs.writeFileSync(path.join(dir, 'studio/proof/T-800.json'), JSON.stringify({ task: 'T-800', shots: [{ file: 'shot.png', says: 'the beach' }], checks: [] }));
  fs.mkdirSync(path.join(dir, 'studio/art'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ref.png'), 'png');
  fs.writeFileSync(path.join(dir, 'studio/art/references.json'), JSON.stringify({ references: [{ id: 'AR-001', kind: 'look', label: 'the look', file: 'ref.png', image: true }] }));
  const low = run(dir, 'node qa/vision-check.mjs T-800 --on --min 60', { STUDIO_VISION_FAKE: '40' });
  const high = run(dir, 'node qa/vision-check.mjs T-800 --on --min 60', { STUDIO_VISION_FAKE: '80' });
  const advisory = run(dir, 'node qa/vision-check.mjs --on', { STUDIO_VISION_FAKE: '10' });
  const noModel = run(dir, 'node qa/vision-check.mjs T-800 --on --min 60', { STUDIO_VISION_URL: '', STUDIO_VISION_MODEL: '' });
  report('2.30e F15: the vision check is off by default; on, it blocks below --min, passes above it, is advisory without --min, and fails when blocking with no model set', off.status === 0 && /off/.test(off.stdout) && low.status === 1 && /score 40 < 60/.test(low.stdout) && high.status === 0 && /score 80 >= 60/.test(high.stdout) && advisory.status === 0 && /T-800|shot\.png/.test(advisory.stdout) && noModel.status === 1 && /no vision model set/.test(noModel.stdout) && fs.existsSync(path.join(dir, 'qa/reports/vision-T-800.json')), JSON.stringify({ off: off.stdout, low: low.stdout, high: high.stdout, advisory: advisory.stdout, noModel: noModel.stdout }));
  fs.rmSync(dir, { recursive: true, force: true });
}

// 2.30f: floors, phase scenarios and content schemas, in a copy.
{
  const dir = copyRepo();
  const env = { STUDIO_PRODUCER_NAME: 'prod-1' };
  const floorsJSON = { maxParallel: 1, autoOpen: true, requireScenarios: true };
  fs.writeFileSync(path.join(dir, 'studio', 'floors.json'), JSON.stringify(floorsJSON));

  const readJsonSafe = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      return { error: e.message };
    }
  };

  // Setup: Create and sign a bible to open Phase 1.
  run(dir, 'node harness/intake.mjs --answers studio/templates/intake-example.json', env);
  run(dir, 'node harness/bible.mjs sign --by hatch', env);

  // --- Floors & Scenarios Gate ---

  // Test: A failing scenario in the current phase (1) blocks the next floor (2) from opening.
  fs.mkdirSync(path.join(dir, 'qa', 'scenarios', 'phase-1'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'qa', 'scenarios', 'phase-1', 'fail.mjs'), `export default async () => ({ ok: false, why: 'planted failure' });`);
  run(dir, 'npm run floors -- stage 1 art --by hatch', env);
  const floorOpenFail = run(dir, 'npm run floors -- tick', env);
  run(dir, 'npm run floors -- stage 1 build --by hatch', env);
  const bible1 = readJsonSafe(path.join(dir, 'studio', 'bible', 'bible.json'));
  const floor2NotOpen = bible1 && !(bible1.error) && (!bible1.phase.floors || bible1.phase.floors.length === 0);
  report('floor-gate: tick fails to open floor if previous phase scenarios fail', floorOpenFail.status === 0 && /Cannot open floor 2:.*phase-scenarios gate failed.*planted failure/.test(floorOpenFail.stdout) && floor2NotOpen, floorOpenFail.stdout);

  // Test: open refuses n+2, duplicate, n=4, and an agent --by
  const openNPlus2 = run(dir, 'npm run floors -- open 3 --by hatch', env);
  report('floor-open: refuses n+2', openNPlus2.status !== 0 && /Next available floor is 2/.test(openNPlus2.stdout), openNPlus2.stdout);
  
  const openAgent = run(dir, 'npm run floors -- open 2 --by prod-1', env);
  report('floor-open: refuses agent', openAgent.status !== 0 && /A person opens a floor/.test(openAgent.stdout), openAgent.stdout);

  // Test: tick waits while main stage is build
  fs.writeFileSync(path.join(dir, 'qa', 'scenarios', 'phase-1', 'pass.mjs'), `export default async () => ({ ok: true });`);
  fs.unlinkSync(path.join(dir, 'qa', 'scenarios', 'phase-1', 'fail.mjs'));
  const tickWait = run(dir, 'npm run floors -- tick', env);
  const bibleWait = readJsonSafe(path.join(dir, 'studio', 'bible', 'bible.json'));
  report('floor-tick: waits while main stage is build', tickWait.status === 0 && (!bibleWait.phase.floors || bibleWait.phase.floors.length === 0), tickWait.stdout);

  // Test: tick opens after stage <main> art
  run(dir, 'npm run floors -- stage 1 art --by hatch', env);
  const floorOpenPass = run(dir, 'npm run floors -- tick', env);
  const bible2 = readJsonSafe(path.join(dir, 'studio', 'bible', 'bible.json'));
  const floor2IsOpen = bible2 && !(bible2.error) && bible2.phase.floors?.some(f => f.n === 2 && f.stage === 'build');
  report('floor-gate: tick opens next floor when scenarios pass and main is art', floorOpenPass.status === 0 && floor2IsOpen, floorOpenPass.stdout);

  // Test: duplicate open refusal
  const openDup = run(dir, 'npm run floors -- open 2 --by hatch', env);
  report('floor-open: refuses duplicate', openDup.status !== 0 && /already open/.test(openDup.stdout), openDup.stdout);

  // Test: maxParallel counts main phase
  // Main phase is art, floor 2 is build. maxParallel is 1.
  // tick won't open floor 3 while floor 2 is in 'build' stage.
  const maxParallelRefusal = run(dir, 'npm run floors -- tick', env);
  const bible3 = readJsonSafe(path.join(dir, 'studio', 'bible', 'bible.json'));
  const floor3NotOpen = bible3 && !(bible3.error) && bible3.phase.floors?.length === 1;
  report('floor-parallel: tick respects maxParallel and does not open another floor', maxParallelRefusal.status === 0 && floor3NotOpen, maxParallelRefusal.stdout);

  // Test: After staging floor 2 to 'art', tick will open floor 3 (if scenarios for phase 2 pass).
  run(dir, 'npm run floors -- stage 2 art --by hatch', env);
  fs.mkdirSync(path.join(dir, 'qa', 'scenarios', 'phase-2'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'qa', 'scenarios', 'phase-2', 'pass.mjs'), `export default async () => ({ ok: true });`);
  const floor3Open = run(dir, 'npm run floors -- tick', env);
  const bible4 = readJsonSafe(path.join(dir, 'studio', 'bible', 'bible.json'));
  const floor3IsOpen = bible4 && !(bible4.error) && bible4.phase.floors?.some(f => f.n === 3);
  report('floor-stage: tick opens next floor after previous is staged to art', floor3Open.status === 0 && floor3IsOpen, floor3Open.stdout);

  // Test: n=4 refusal
  run(dir, 'npm run floors -- stage 3 art --by hatch', env);
  fs.mkdirSync(path.join(dir, 'qa', 'scenarios', 'phase-3'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'qa', 'scenarios', 'phase-3', 'pass.mjs'), `export default async () => ({ ok: true });`);
  const openN4 = run(dir, 'npm run floors -- open 4 --by hatch', env);
  report('floor-open: refuses n=4', openN4.status !== 0 && /maximum phase is 3/.test(openN4.stdout), openN4.stdout);

  // Test: scenario timeout
  fs.writeFileSync(path.join(dir, 'qa', 'scenarios', 'phase-3', 'timeout.mjs'), `export default async () => new Promise(r => setTimeout(r, 2000));`);
  const timeoutEnv = { ...env, STUDIO_SCENARIO_TIMEOUT_MS: '500' };
  const timeoutRun = run(dir, 'node qa/check-phase-scenarios.mjs --phase 3', timeoutEnv);
  report('floor-scenario: timeout fails scenario', timeoutRun.status !== 0 && /timed out after 500 ms/.test(timeoutRun.stderr), timeoutRun.stderr);
  fs.unlinkSync(path.join(dir, 'qa', 'scenarios', 'phase-3', 'timeout.mjs'));

  // Test: lane collision
  // use the supervisor's lanesClash from harness/task-hold.mjs
  const { lanesClash } = await import(pathToFileURL(path.join(dir, 'harness', 'task-hold.mjs')).toString());
  const clash1 = lanesClash('cartridges/example-sim/floors/phase-2', 'cartridges/example-sim/floors');
  const clash2 = lanesClash('cartridges/example-sim/floors/phase-2', 'cartridges/example-sim/floors/phase-3');
  report('floor-lanes: floor task vs floor default clashes, floor-2 vs floor-3 does not', clash1 && !clash2, `clash1=${clash1} clash2=${clash2}`);

  // Test: Tasks for a floor can be added once it's open.
  const taskFail = run(dir, 'node harness/task.mjs add "Terraces" --phase 4 --serves pillar:Calm', env);
  report('task-add: a phase outside 1-3 is still refused with floors on', taskFail.status !== 0 && /--phase 1 \(early\)/.test(taskFail.stderr), taskFail.stderr);
  const taskOk = run(dir, 'node harness/task.mjs add "More Terraces" --phase 2 --serves pillar:Calm', env);
  report('task-add: succeeds for an open floor', taskOk.status === 0, taskOk.stdout + taskOk.stderr);

  // --- Content Schema Gate ---

  // Setup for content checks
  fs.mkdirSync(path.join(dir, 'studio', 'bible', 'schemas'), { recursive: true });
  // The intake process determines the cartridge, let's assume 'example-sim' from the template.
  const cartridgeDir = path.join(dir, 'cartridges', 'example-sim', 'content');
  fs.mkdirSync(cartridgeDir, { recursive: true });
  const schema = { type: 'object', properties: { id: { type: 'string' }, phase: { type: 'integer' }, damage: { type: 'number' } }, required: ['id', 'phase', 'damage'] };
  fs.writeFileSync(path.join(dir, 'studio', 'bible', 'schemas', 'gear-crafting.schema.json'), JSON.stringify(schema));
  run(dir, 'node harness/bible.mjs layer gear-crafting yes --by hatch --phase 1', env);

  // Test: Clean content passes the check.
  const validContent = [{ id: 'test_sword', phase: 1, damage: 5 }];
  fs.writeFileSync(path.join(cartridgeDir, 'gear-crafting.json'), JSON.stringify(validContent));
  const cleanPass = run(dir, 'npm run check:content', env);
  report('content-gate: clean pass', cleanPass.status === 0 && /PASS: All content files are valid/.test(cleanPass.stdout), cleanPass.stdout + cleanPass.stderr);

  // Test: Content with a schema violation (wrong type) fails.
  const invalidContent = [{ id: 'test_sword', phase: 1, damage: 'five' }];
  fs.writeFileSync(path.join(cartridgeDir, 'gear-crafting.json'), JSON.stringify(invalidContent));
  const schemaFail = run(dir, 'npm run check:content', env);
  report('content-gate: schema violation fails', schemaFail.status !== 0 && /\.damage: type should be number, but got string/.test(schemaFail.stderr), schemaFail.stderr);

  // Test: Content missing the required 'phase' property fails.
  const missingPhaseContent = [{ id: 'test_axe', damage: 10 }];
  fs.writeFileSync(path.join(cartridgeDir, 'gear-crafting.json'), JSON.stringify(missingPhaseContent));
  const phaseTagFail = run(dir, 'npm run check:content', env);
  report('content-gate: missing phase property fails', phaseTagFail.status !== 0 && /is missing an integer "phase" property/.test(phaseTagFail.stderr), phaseTagFail.stderr);

  // Test: Content for a crossed-out layer fails.
  run(dir, 'node harness/bible.mjs layer gear-crafting no --by hatch', env);
  const crossedOutFail = run(dir, 'npm run check:content', env);
  report('content-gate: crossed-out layer fails', crossedOutFail.status !== 0 && /corresponds to layer "gear-crafting" which is not 'yes' in the bible/.test(crossedOutFail.stderr), crossedOutFail.stderr);
}

// 2.30g: token savers. The kickoff's fixed part is the same bytes for every session of a role, the
// ledger measures it, cache writes are read from Claude's own usage, the hooks trim / guard / gate, token
// norms flag (never cap), verdicts become notes in briefs, and the Godot unit gate skips or reports.
{
  const dir = copyRepo();
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);
  const probe = (code, env = {}) => {
    const f = path.join(tmpRoot, `p230g-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node "${f}"`, env);
    try {
      return JSON.parse(r.stdout.trim().split('\n').pop());
    } catch {
      return { error: r.stdout + r.stderr };
    }
  };
  const k = probe(`import { kickoffParts, kickoff } from ${u('harness/kickoff.mjs')};
import { layoutPrompt, prefixHash, recordPrefix, prefixStability, cacheStats } from ${u('harness/prompt-layout.mjs')};
const a = kickoffParts({ role: 'builder', agent: 'claude-a', model: 'm-1', launched: true });
const b = kickoffParts({ role: 'builder', agent: 'codex-b', model: 'gpt-x', launched: true });
const p1 = layoutPrompt({ stable: a.stable, volatile: 'You are claude-a. T-1' });
const p2 = layoutPrompt({ stable: b.stable, volatile: 'You are codex-b. T-2' });
const r1 = recordPrefix({ role: 'builder', agent: 'claude-a', prompt: p1 });
const r2 = recordPrefix({ role: 'builder', agent: 'codex-b', prompt: p2 });
const r3 = recordPrefix({ role: 'builder', agent: 'x', prompt: layoutPrompt({ stable: a.stable + 'changed', volatile: '' }) });
const log = [JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 100 } } }), JSON.stringify({ type: 'result', usage: { input_tokens: 10, cache_read_input_tokens: 8000, cache_creation_input_tokens: 1990 } })].join('\\n');
console.log(JSON.stringify({ same: a.stable === b.stable, named: /claude-a|codex-b|m-1|gpt-x/.test(a.stable), paste: /claude-a/.test(kickoff({ role: 'builder', agent: 'claude-a', model: 'm-1' })), h: prefixHash(p1) === prefixHash(p2), r2: r2.changed, r3: r3.changed, st: prefixStability().builder, c: cacheStats(log) }));`);
  report('2.30g: the kickoff prefix is byte-identical across agents and models of a role, and the paste-ready kickoff still names the agent', k.same === true && k.named === false && k.paste === true && k.h === true, JSON.stringify(k).slice(0, 800));
  report('2.30g: the prefix ledger flags a changed prefix and reports stability per role', k.r2 === false && k.r3 === true && k.st?.sessions === 3 && k.st?.changes === 1 && Math.abs(k.st.stableRate - 0.5) < 1e-9, JSON.stringify(k.st));
  report('2.30g: cache hit vs write comes from Claude\'s result usage', k.c?.cacheRead === 8000 && k.c?.cacheWrite === 1990 && Math.abs(k.c.hitRate - 0.8) < 1e-9, JSON.stringify(k.c));
  const hook = (name, input, env = {}) => spawnSync(process.execPath, [path.join(dir, '.claude', 'hooks', name)], { cwd: dir, input: JSON.stringify(input), encoding: 'utf8', env: { ...CLEAN_ENV, CLAUDE_PROJECT_DIR: dir, ...env } });
  const big = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n') + '\nError: planted failure\n' + Array.from({ length: 60 }, (_, i) => `tail ${i}`).join('\n');
  const t = hook('trim-output.mjs', { tool_name: 'Bash', tool_use_id: 'tu1', tool_response: { stdout: big, stderr: '' } });
  let to = null;
  try {
    to = JSON.parse(t.stdout).hookSpecificOutput.updatedToolOutput.stdout;
  } catch {}
  const small = hook('trim-output.mjs', { tool_name: 'Bash', tool_response: { stdout: 'ok\n', stderr: '' } });
  report('2.30g: the trim hook keeps the failure and the tail of long output, saves the full text, and leaves short output alone', Boolean(to) && /planted failure/.test(to) && /tail 59/.test(to) && !/line 5\n/.test(to) && fs.existsSync(path.join(dir, '.studio', 'trimmed', 'tu1.log')) && small.stdout.trim() === '', `${t.stdout.slice(0, 400)}${t.stderr}`);
  const g1 = hook('guard-paths.mjs', { tool_name: 'Read', tool_input: { file_path: `${dir}/node_modules/x/index.js` } });
  const g2 = hook('guard-paths.mjs', { tool_name: 'Bash', tool_input: { command: 'npm run build && node build/serve.mjs' } });
  const g3 = hook('guard-paths.mjs', { tool_name: 'Bash', tool_input: { command: 'rg foo game/godot/.godot/imported' } });
  report('2.30g: the path guard denies reads of node_modules / build / .godot and lets running a build through', /"deny"/.test(g1.stdout) && g2.stdout.trim() === '' && /"deny"/.test(g3.stdout), JSON.stringify([g1.stdout, g2.stdout, g3.stdout]));
  const s0 = hook('stop-gate.mjs', { stop_hook_active: false });
  const s1 = hook('stop-gate.mjs', { stop_hook_active: true }, { STUDIO_LOCK_OWNER: 'builder-1' });
  report('2.30g: the stop gate stays out of a person\'s session and never loops', s0.status === 0 && s0.stdout.trim() === '' && s1.status === 0 && s1.stdout.trim() === '', JSON.stringify([s0.stdout, s1.stdout]));
  {
    // Fast-only: a lite gate that hangs is skipped inside the budget, the agent is never held up.
    const gj = path.join(dir, 'studio', 'gates.json');
    const keep = fs.readFileSync(gj, 'utf8');
    fs.writeFileSync(gj, JSON.stringify({ gates: [{ id: 'slow', command: 'node -e "setTimeout(()=>{},30000)"', required: true, lite: true }] }));
    fs.writeFileSync(path.join(dir, 'stop-gate-probe.txt'), 'x');
    const t0 = Date.now();
    const s2 = hook('stop-gate.mjs', { stop_hook_active: false }, { STUDIO_LOCK_OWNER: 'builder-1', STUDIO_STOP_GATE_MS: '3000' });
    const took = Date.now() - t0;
    fs.writeFileSync(gj, keep);
    fs.rmSync(path.join(dir, 'stop-gate-probe.txt'), { force: true });
    report('2.30g: the stop gate is fast-only: a hanging check is skipped within its few-second budget and never blocks', s2.status === 0 && !/"block"/.test(s2.stdout) && took < 8000, JSON.stringify({ took, out: s2.stdout.slice(0, 300) }));
  }
  const tn = probe(`import { tokenNorms, outliers } from ${u('harness/token-norms.mjs')};
const ev = [];
const add = (agent, task, type, tin) => { ev.push({ type: 'task.added', task, meta: { type } }); ev.push({ type: 'agent.session.start', agent, task, meta: { role: 'builder' } }); ev.push({ type: 'agent.session.end', agent, task, tokensIn: tin, tokensOut: 0, meta: {} }); };
for (let i = 0; i < 6; i++) add('d' + i, 'D' + i, 'docs', 1000 + i * 10);
for (let i = 0; i < 6; i++) add('g' + i, 'G' + i, 'godot-3d', 50000 + i * 1000);
add('d9', 'D9', 'docs', 9000);
add('g9', 'G9', 'godot-3d', 60000);
console.log(JSON.stringify({ norms: tokenNorms({ events: ev }), out: outliers({ events: ev }) }));`);
  report('2.30g: token norms are per task type: a 9k docs task is flagged, a 60k Godot 3D task is not', tn.out?.length === 1 && tn.out[0].task === 'D9' && tn.norms?.['godot-3d']?.n === 7, JSON.stringify(tn).slice(0, 600));
  const vn = probe(`import { addVerdictNote, notesForBrief } from ${u('harness/verdict-notes.mjs')};
addVerdictNote({ by: 'hatch', verdict: '❌', on: null, comment: 'ships all follow the same path, boats look narrow' });
addVerdictNote({ by: 'hatch', verdict: '✅', on: 'T-7', comment: 'upkeep finally drains money' });
console.log(JSON.stringify({ a: notesForBrief({ id: 'T-9', title: 'Give ships varied paths', role: 'builder' }), b: notesForBrief({ id: 'T-7', title: 'x', role: 'builder' }), c: notesForBrief({ id: 'T-1', title: 'Docs: credits', role: 'docs' }) }));`);
  report('2.30g: verdict notes reach the briefs they touch as context, not rules', /context, not rules/.test(vn.a || '') && /same path/.test(vn.a) && /upkeep/.test(vn.b || '') && vn.c === '', JSON.stringify(vn).slice(0, 600));
  const gr = probe(`import fs from 'node:fs'; import path from 'node:path'; import { runnerFor } from ${u('harness/godot-unit.mjs')};
const p = fs.mkdtempSync(path.join(process.cwd(), 'gr-')); fs.mkdirSync(path.join(p, 'addons', 'gdUnit4'), { recursive: true });
fs.writeFileSync(path.join(p, 'addons', 'gdUnit4', 'runtest.sh'), '');
const a = runnerFor(p, 'win32'), b = runnerFor(p, 'linux');
fs.writeFileSync(path.join(p, 'addons', 'gdUnit4', 'runtest.cmd'), '');
const c = runnerFor(p, 'win32'); fs.rmSync(p, { recursive: true, force: true });
console.log(JSON.stringify({ a, b, c }));`);
  report('2.30g: on Windows the godot-unit gate runs runtest.cmd, or runtest.sh through sh, never a bare .sh in cmd.exe', gr.a?.file === 'sh' && gr.a.shell === false && /runtest\.sh$/.test(gr.a.pre[0]) && /runtest\.sh$/.test(gr.b?.file || '') && /runtest\.cmd$/.test(gr.c?.file || ''), JSON.stringify(gr).slice(0, 600));
  const gu = run(dir, 'node harness/godot-unit.mjs --changed');
  report('2.30g: the godot-unit gate skips cleanly when the game has no Godot project or has not opted in', gu.status === 0 && /skipped/.test(gu.stdout), `${gu.stdout}${gu.stderr}`);
  const ss = run(dir, 'node scripts/session-start.mjs', { STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-1' });
  report('2.30g: a launched session gets one fixed session-start line, so the kickoff stays first in the cache', ss.stdout.trim() === 'Session start: launched by the studio; your kickoff has your task.', ss.stdout.slice(0, 300));
  fs.rmSync(dir, { recursive: true, force: true });
}

// 2.30h: design fidelity, the Director's flow, reasoning-only replies, model limits as awareness, the CI
// watch, GDScript parse failures and the lock version (qa/selftest-230h.mjs).
{
  const dir = copyRepo();
  const { selftest230h } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-230h.mjs')).href);
  await selftest230h({ dir, run, report, tmpRoot });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 });
}

// 2.30j: fixes from real HUD use (qa/selftest-230j.mjs).
{
  const dir = copyRepo();
  const { selftest230j } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-230j.mjs')).href);
  await selftest230j({ dir, run, report, tmpRoot });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 });
}

// 2.30i: launcher verify after a session ends without task done, .env for agent start, NIM one at a time,
// 429 in the stream json (qa/selftest-230i.mjs).
{
  const dir = copyRepo();
  const { selftest230i } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-230i.mjs')).href);
  await selftest230i({ dir, run, report, tmpRoot });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 });
}

// 2.30k: file-level lanes, task done refuses uncommitted changes (qa/selftest-230k.mjs).
{
  const dir = copyRepo();
  const { selftest230k } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-230k.mjs')).href);
  await selftest230k({ dir, run, report, tmpRoot });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 });
}

// 2.30l: one builder per task, the studio's game apart from the cartridge (qa/selftest-230l.mjs).
{
  const dir = copyRepo();
  const { selftest230l } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-230l.mjs')).href);
  await selftest230l({ dir, run, report, tmpRoot });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 });
}

// 2.30m: build tasks must change code or be closed as no-op with a reason (qa/selftest-230m.mjs).
{
  const dir = copyRepo();
  const { selftest230m } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-230m.mjs')).href);
  await selftest230m({ dir, run, report, tmpRoot });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 });
}

// 2.30n: the gates follow the studio's game; engine gate; lane, force and spec fixes (qa/selftest-230n.mjs).
{
  const dir = copyRepo();
  const { selftest230n } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-230n.mjs')).href);
  await selftest230n({ dir, run, report, tmpRoot });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 });
}

// 2.30o: stall cap, visual proof, split verdict, layout gate, refill, profile check, tiers, game-dev loop (qa/selftest-230o.mjs).
{
  const dir = copyRepo();
  const { selftest230o } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-230o.mjs')).href);
  await selftest230o({ dir, run, report, tmpRoot });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 });
}

// 2.30p: path-scoped gates, reused lane results, the land lock and a safe board write (qa/selftest-230p.mjs).
{
  const dir = copyRepo();
  const { selftest230p } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-230p.mjs')).href);
  await selftest230p({ dir, run, report, tmpRoot });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 });
}

// 2.30q: merge worktree landing, busy-not-stalled, budget stop on every launch path, untracked usage (qa/selftest-230q.mjs).
{
  const dir = copyRepo();
  const { selftest230q } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-230q.mjs')).href);
  await selftest230q({ dir, run, report, tmpRoot });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 });
}

// 2.31.0: task budgets, gate slots, verify scoped to a lane, scoped verify coverage, engine cache landings (qa/selftest-231.mjs).
{
  const dir = copyRepo();
  const { selftest231 } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-231.mjs')).href);
  await selftest231({ dir, run, report, tmpRoot });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 });
}

// 2.32.0: the Game Bible's controls list against each track's real-input results (qa/selftest-232.mjs).
{
  const dir = copyRepo();
  const { selftest232 } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-232.mjs')).href);
  await selftest232({ dir, run, report, tmpRoot });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 });
}

// 2.33.0: one door, scoped agent env, guard hook, re-claim baseline, --check, monotonic ids (qa/selftest-233.mjs).
{
  const dir = copyRepo();
  const { selftest233 } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-233.mjs')).href);
  await selftest233({ dir, run, report, tmpRoot });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 });
}

// 2.34.0: harness health numbers and the morning report (qa/selftest-234.mjs).
{
  const dir = copyRepo();
  const { selftest234 } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-234.mjs')).href);
  await selftest234({ dir, run, report, tmpRoot });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 });
}

// 2.35.0: the rescue ladder for a task stopped by its budget (qa/selftest-235.mjs).
{
  const dir = copyRepo();
  const { selftest235 } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-235.mjs')).href);
  await selftest235({ dir, run, report, tmpRoot });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 });
}

// 2.36.0: a check that exits 0 but ran no tests (qa/selftest-236.mjs).
{
  const dir = copyRepo();
  const { selftest236 } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-236.mjs')).href);
  await selftest236({ dir, run, report, tmpRoot });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 });
}

// 2.37.0: the whole-game check after work lands (qa/selftest-237.mjs).
{
  const dir = copyRepo();
  const { selftest237 } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-237.mjs')).href);
  await selftest237({ dir, run, report, tmpRoot });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 });
}

// 2.38.0: built but not wired (qa/selftest-238.mjs).
{
  const dir = copyRepo();
  const { selftest238 } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-238.mjs')).href);
  await selftest238({ dir, run, report, tmpRoot });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 });
}

// 2.39.0: what a control must change, in the Game Bible (qa/selftest-239.mjs).
{
  const dir = copyRepo();
  const { selftest239 } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-239.mjs')).href);
  await selftest239({ dir, run, report, tmpRoot });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 });
}

// 2.40.0: a quieter watchdog log and the health counts (qa/selftest-240.mjs).
{
  const dir = copyRepo();
  const { selftest240 } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-240.mjs')).href);
  await selftest240({ dir, run, report, tmpRoot });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 });
}

// 2.41.0: two greens before a new regression is protected (qa/selftest-241.mjs).
{
  const dir = copyRepo();
  const { selftest241 } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-241.mjs')).href);
  await selftest241({ dir, run, report, tmpRoot });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 });
}

// 2.42.0: Godot versions agree (qa/selftest-242.mjs).
{
  const dir = copyRepo();
  const { selftest242 } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-242.mjs')).href);
  await selftest242({ dir, run, report, tmpRoot });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 });
}

// 2.43.0: adopting a game that already exists (qa/selftest-243.mjs).
{
  const dir = copyRepo();
  const { selftest243 } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-243.mjs')).href);
  await selftest243({ dir, run, report, tmpRoot });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 });
}

// 2.44.0: sync, related tests, retry once (qa/selftest-244.mjs).
{
  const dir = copyRepo();
  const { selftest244 } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-244.mjs')).href);
  await selftest244({ dir, run, report, tmpRoot });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 });
}

// 2.45.0: real-input controls for a studio web game, the parts without a browser (qa/selftest-245.mjs).
{
  const dir = copyRepo();
  const { selftest245 } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-245.mjs')).href);
  await selftest245({ dir, run, report, tmpRoot });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 });
}

// 2.46.0: the Unity track's checks without .NET or Unity (qa/selftest-246.mjs).
{
  const dir = copyRepo();
  const { selftest246 } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-246.mjs')).href);
  await selftest246({ dir, run, report, tmpRoot });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 });
}

// 2.47.0: an engine port in its own repo, parity for an adopted game, the self-hosted runner (qa/selftest-247.mjs).
{
  const dir = copyRepo();
  const { selftest247 } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-247.mjs')).href);
  await selftest247({ dir, run, report, tmpRoot });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 });
}

// 2.48.0: Windows by default for a Unity track (qa/selftest-248.mjs).
{
  const dir = copyRepo();
  const { selftest248 } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-248.mjs')).href);
  await selftest248({ dir, run, report, tmpRoot });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 });
}

// 2.49.0 (U-004): npm run logs (qa/selftest-249.mjs).
{
  const dir = copyRepo();
  const { selftest249 } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-249.mjs')).href);
  await selftest249({ dir, run, report, tmpRoot });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 });
}

// 2.50.0 (U-006): parity seeds for a Vite game's test runner (qa/selftest-250.mjs).
{
  const dir = copyRepo();
  const { selftest250 } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-250.mjs')).href);
  await selftest250({ dir, run, report, tmpRoot });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 });
}

// 2.51.0 (U-005): the public-repo guard as a harness feature (qa/selftest-251.mjs).
{
  const dir = copyRepo();
  const { selftest251 } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-251.mjs')).href);
  await selftest251({ dir, run, report, tmpRoot });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 });
}

// 2.53.0: the public guard's per-repo private markers (qa/selftest-253.mjs).
{
  const dir = copyRepo();
  const { selftest253 } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-253.mjs')).href);
  await selftest253({ dir, run, report, tmpRoot });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 });
}

// 2.54.0: fixes from the first crew run, P-022 to P-027 (qa/selftest-254.mjs).
{
  const dir = copyRepo();
  const { selftest254 } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-254.mjs')).href);
  await selftest254({ dir, run, report, tmpRoot });
  // Its stand-in agents may still be exiting on Windows; the temp root is cleaned at the end either way.
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch {}
}

// 2.55.0: fixes from the crew's own logs, P-028, P-030, P-031, P-032 (qa/selftest-255.mjs).
{
  const dir = copyRepo();
  const { selftest255 } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-255.mjs')).href);
  await selftest255({ dir, run, report, tmpRoot });
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch {}
}

// 2.56.0 (PU-15): the visual-effect spec and frame checks (qa/selftest-256.mjs).
{
  const dir = copyRepo();
  const { selftest256 } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-256.mjs')).href);
  await selftest256({ dir, run, report, tmpRoot });
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch {}
}

// PU-20: the protected-files check also sees uncommitted and already-pushed edits (qa/selftest-pu20.mjs).
{
  const dir = copyRepo();
  const { selftestPU20 } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-pu20.mjs')).href);
  await selftestPU20({ dir, run, report, tmpRoot });
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch {}
}

// PU-19 (P-042): 5-hour and weekly limit messages count as usage limits, with their reset times (qa/selftest-pu19.mjs).
{
  const dir = copyRepo();
  const { selftestPU19 } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-pu19.mjs')).href);
  await selftestPU19({ dir, run, report, tmpRoot });
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch {}
}

// PU-18 (P-040): the secret scan catches Discord, Slack, Telegram and AWS secret tokens, named secrets and
// base64-wrapped tokens; placeholders and base64 data pass (qa/selftest-pu18.mjs).
{
  const dir = copyRepo();
  const { selftestPU18 } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-pu18.mjs')).href);
  await selftestPU18({ dir, run, report, tmpRoot });
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch {}
}

// 2.57.0 (PU-16): crash-safe studio state, P-037, P-038, P-041 (qa/selftest-pu16.mjs).
{
  const dir = copyRepo();
  const { selftestPU16 } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-pu16.mjs')).href);
  await selftestPU16({ dir, run, report, tmpRoot });
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch {}
}

// PU-17 (P-039, P-045): agent stop checks the process at kill time, with no extra process calls on launch or in
// listings; a stop during start-up stops the launcher (qa/selftest-pu17.mjs).
{
  const dir = copyRepo();
  const { selftestPU17 } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-pu17.mjs')).href);
  await selftestPU17({ dir, run, report, tmpRoot });
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch {}
}

// 2.58.0 (PU-41): the events log after a roll-over (P-058) and metrics on a long log (P-059) (qa/selftest-258e.mjs).
{
  const dir = copyRepo();
  const { selftest258E } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-258e.mjs')).href);
  await selftest258E({ dir, run, report, tmpRoot });
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch {}
}

// 2.58.0 (F): verify survives being reaped, runs game checks with CI=true, names files it changed (qa/selftest-258f.mjs).
{
  const dir = copyRepo();
  const { selftest258F } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-258f.mjs')).href);
  await selftest258F({ dir, run, report, tmpRoot });
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch {}
}

// 2.58.0 part A: size growth from the merge-base, the chore type, PU-34 (P-047), PU-35 (P-048) (qa/selftest-258a.mjs).
{
  const dir = copyRepo();
  const { selftest258A } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-258a.mjs')).href);
  await selftest258A({ dir, run, report, tmpRoot });
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch {}
}

// 2.58.0 part B (PU-37, PU-38, PU-42, PU-43): killed board writes, leaked and raced claims, live lock holders,
// hand-edited board lines, temp files, case-blind folder claims: P-052 to P-057, P-060 (qa/selftest-258b.mjs).
{
  const dir = copyRepo();
  const { selftest258B } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-258b.mjs')).href);
  await selftest258B({ dir, run, report, tmpRoot });
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch {}
}

// 2.58.0 part D: untrusted text marked in briefs and prompts (PU-36), stalled agents freed (PU-39), custom-command
// limits per program (PU-40), auto-start opt-in (qa/selftest-258d.mjs).
{
  const dir = copyRepo();
  const { selftest258D } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-258d.mjs')).href);
  await selftest258D({ dir, run, report, tmpRoot });
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch {}
}

// 2.58.0 (PU-33, P-046): the hook scans the staged blobs, verify's secrets gate scans the commits since the base
// (lines added and messages), UTF-16 files are read, the skip list is tied to real paths, scrub() shares the
// scan's list (qa/selftest-258c.mjs).
{
  const dir = copyRepo();
  const { selftest258C } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-258c.mjs')).href);
  await selftest258C({ dir, run, report, tmpRoot });
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch {}
}

// P-066 (crew P-036): agents start with no shell and their arguments intact on Windows: npm .cmd shims run as node on
// their .js entry, any other .cmd through cmd.exe with one quoting function, custom-command values quoted for the
// shell; end to end through `agent start` with stand-in programs on PATH (qa/selftest-259h.mjs).
{
  const dir = copyRepo();
  const { selftest259H } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-259h.mjs')).href);
  await selftest259H({ dir, run, report, tmpRoot });
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch {}
}

// P-067 (crew P-037): an owner-approved step writes agy's headless allow-rules from the harness allowlist, and the
// launcher says when they're missing (qa/selftest-259i.mjs).
{
  const dir = copyRepo();
  const { selftest259I } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-259i.mjs')).href);
  await selftest259I({ dir, run, report, tmpRoot });
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch {}
}

// PU-22: the sim-purity gate flags engine-dependent Math calls (sin, atan2, hypot, pow, ...) in sim code: warn by
// default, required for new games, the detMath module exempt (qa/selftest-2582l.mjs).
{
  const dir = copyRepo();
  const { selftest2582L } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-2582l.mjs')).href);
  await selftest2582L({ dir, run, report, tmpRoot });
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch {}
}

// PU-29: the hooks stamp each commit they pass and a gate lists commits without a valid stamp (--no-verify); a second
// gate flags weakened tests (removed asserts, skip/only, raised timeouts, wider tolerances, seed special cases, deleted
// tests, goldens without a reason) unless the owner signed them; both run at task done (qa/selftest-2582k.mjs).
{
  const dir = copyRepo();
  const { selftest2582K } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-2582k.mjs')).href);
  await selftest2582K({ dir, run, report, tmpRoot });
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch {}
}

// new-game produces a cartridge that passes purity, golden, slice and playtest.
{
  const dir = copyRepo();
  const made = run(dir, 'node scripts/new-game.mjs selftest-game');
  report('new-game scaffolds a cartridge', made.status === 0, `${made.stdout}${made.stderr}`);
  for (const cmd of ['node scripts/check-sim-purity.mjs', 'node qa/check-golden.mjs', 'node qa/vertical-slice.mjs', 'node qa/playtest.mjs --stage 1 --quiet --cartridge selftest-game']) {
    const res = run(dir, cmd);
    report(`new game passes: ${cmd}`, res.status === 0, `${res.stdout}${res.stderr}`);
  }
}

try {
  fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 });
} catch (err) {
  // Windows keeps a folder while any process still runs in it; the OS cleans its temp folder later.
  console.log(`[selftest] note: couldn't remove ${tmpRoot} yet (${err.code})`);
}
if (failed) {
  console.error(`[selftest] ${failed} check(s) failed`);
  process.exit(1);
}
console.log('[selftest] ok — every required gate was shown to fail when broken');
