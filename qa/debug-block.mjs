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
// 2.59.0: the supervisor starts no agent under STUDIO_RAM_FLOOR_GB free memory; checks run with it off so a busy test
// machine doesn't change their result (qa/selftest-259d.mjs tests the floor with its own setting).
// 2.60.1 (B-17, B-35): the same for heavy work's memory floor, the CPU probe (Windows) and an open Unity editor
// counted as heavy work (qa/selftest-2601m.mjs tests them with its own settings).
const CLEAN_ENV = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(STUDIO_|HUB_|AGENT_|PLAYTEST_|OLLAMA_|NVIDIA_|ANTHROPIC_|OPENAI_|XAI_|GEMINI_|VERTEX_|GROQ_|OPENROUTER_|CODEX_|CURSOR_)|_API_KEY|_TOKEN$/.test(k))), STUDIO_RAM_FLOOR_GB: '0', STUDIO_HEAVY_RAM_FLOOR_GB: '0', STUDIO_CPU_PROBE: 'off', STUDIO_HEAVY_PROGRAMS: 'off' };
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
  console.log(`[selftest] ${ok ? 'PASS' : 'FAIL'} ${label}${ok || !detail ? '' : `\n${detail.slice(-6000)}`}`);
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
// The supervisor keeps the studio running: one task per session, the next session when one ends, a stop
// time, lanes so builders never share a folder, and tools out of quota skipped until they reset.
{ const __t0 = Date.now();

  const dir = copyRepo();
  const git = (cmd) => run(dir, `git -c user.name=selftest -c user.email=selftest@example.com ${cmd}`);
  git('init -q');
  git('add -A');
  git('commit -q -m init --no-verify');
  // 2.58.5: laneless tasks keep the shared checkout here, as custom commands did before H-9 (a lane copy and a landing
  // per session take seconds on Windows, and this checks the supervisor's sequence, not lanes; the lanes part below
  // still uses copies). The fake agent commits in a copy anyway (qa/fixtures/agents/fake-agent.mjs).
  const env = { STUDIO_PRODUCER_NAME: 'prod-1', STUDIO_HEARTBEAT_SEC: '1', STUDIO_SUPERVISOR_SEC: '1', STUDIO_LANELESS: 'shared', STUDIO_BUILDER_CMD: 'node qa/fixtures/agents/fake-agent.mjs {agent} {task} ok' };
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
  const child = spawn(process.execPath, ['harness/supervisor.mjs', '--no-hub', '--lanes', 'auto', '--until', '6s', '--foreground'], { cwd: dir, env: { ...CLEAN_ENV, STUDIO_CARTRIDGE: '', AGENT_EVENTS_FILE: '', ...wenv }, stdio: ['ignore', fs.openSync(path.join(tmpRoot, 'sup-lanes.log'), 'w'), fs.openSync(path.join(tmpRoot, 'sup-lanes.err'), 'w')] });
  const t0 = Date.now();
  let lanes = [];
  while (Date.now() - t0 < 60000 && lanes.length < 2) {
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},400)']);
    lanes = fs.readdirSync(path.join(dir, '.studio/locks')).map((f) => fs.readFileSync(path.join(dir, '.studio/locks', f), 'utf8')).filter((x) => /path:docs\/lane-[ab]/.test(x));
  }
  report('with --lanes auto, each lane gets its own agent holding that folder', lanes.length === 2, lanes.join('\n'));
  console.log('[debug] lanes found after', Date.now() - t0, 'ms; SLOW =', SLOW);
  await new Promise((r) => child.on('exit', r)).catch(() => {});
  try { console.log('[debug] supervisor out:\n' + fs.readFileSync(path.join(tmpRoot, 'sup-lanes.log'), 'utf8').slice(-3000) + '\n[debug] err:\n' + fs.readFileSync(path.join(tmpRoot, 'sup-lanes.err'), 'utf8').slice(-3000)); } catch (e) { console.log('[debug] no log', e.message); }
  try { console.log('[debug] events:\n' + fs.readFileSync(path.join(dir, '.studio/events.jsonl'), 'utf8').split('\n').filter((l) => /lane|session|agent\./.test(l)).slice(-30).map((l) => l.slice(0, 300)).join('\n')); } catch {}
  await new Promise((r) => child.on('exit', r));
  for (const s of fs.readdirSync(path.join(dir, '.studio/agents')).filter((f) => f.endsWith('.json'))) run(dir, `node harness/agent.mjs stop ${s.replace(/\.json$/, '')}`, env);
  // Quota: a tool that ran out is skipped until its reset; its lanes go to the next tool.
  fs.writeFileSync(path.join(dir, 'q.mjs'), "import { markExhausted, pickTool, exhaustedUntil } from './harness/budget.mjs';\nmarkExhausted('claude', \"You've hit your usage limit. Try again at 6:12 AM.\");\nconsole.log(JSON.stringify({ until: exhaustedUntil('claude'), next: pickTool('claude') }));\n");
  const q = JSON.parse(run(dir, 'node q.mjs', env).stdout);
  report('a tool out of quota is skipped until its reset time, for the next tool in the order', /T\d{2}:12/.test(new Date(q.until).toTimeString().slice(0, 5).replace(/^(\d{2}):(\d{2})$/, 'T$1:$2')) && q.next === 'codex', JSON.stringify(q));
  run(dir, 'node harness/budget.mjs set codex --weekly 1000 --reset monday --target 100%', env);
  report('npm run budget shows tokens used against the week\'s target', /codex: [\d,]+ tokens in the last 5 h, [\d,]+ this week, cache reads counted at [\d.]+x \([\d,]+ read\) \(\d+% of 1,000; target \d+% by now/.test(run(dir, 'node harness/budget.mjs', env).stdout), run(dir, 'node harness/budget.mjs', env).stdout);

console.log('[debug] block took', Date.now()-__t0, 'ms'); }
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

