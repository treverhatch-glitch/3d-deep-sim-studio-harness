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
let failed = 0;
let n = 0;

// The self-test never reads the live studio: every copy starts from the template's board and an
// empty pre-production state (qa/fixtures/studio/), whatever game this checkout is building.
const FIXTURE = path.join(root, 'qa', 'fixtures', 'studio');
const LIVE_STATE = ['studio/bible/bible.json', 'studio/bible/BIBLE.md', 'studio/bible/NOT-DOING.md', 'studio/bible/REFERENCES.md', 'studio/bible/STORYBOARD.md', 'studio/bible/ideas', 'studio/bible/systems', 'studio/signed', 'studio/data-consent.json', 'studio/mode.json', 'studio/game.json', 'studio/asks', 'studio/art', 'studio/divisions.json', 'studio/task-holds.json', 'studio/budget.json', 'studio/tricks', 'studio/playtest', 'studio/proof', 'studio/assets', 'studio/decisions/divisions.md', 'studio/intake-answers.json'];
// A game's own folders. In a studio building a game, the copy takes these from the harness release this
// clone last merged (git merge-base HEAD origin/main), never from the live game: run #1's selftest
// failed on a real studio because its divisions, references, assets, goldens and logs leaked in.
const GAME_OWNED = ['studio', 'assets', 'game', 'cartridges', 'web', 'qa/golden', 'qa/regressions'];
const isGameOwned = (rel) => GAME_OWNED.some((g) => rel === g || rel.startsWith(`${g}/`));
let TEMPLATE = null; // { dir, rev } once extracted; { dir: null } means this checkout is the template
function templateTree() {
  if (TEMPLATE) return TEMPLATE;
  const git = (args, input) => spawnSync('git', args, { cwd: root, ...(input === undefined ? { encoding: 'utf8' } : {}), input, maxBuffer: 256 * 1024 * 1024 });
  const building = fs.existsSync(path.join(root, 'studio', 'game.json'));
  const rev = building ? String(git(['merge-base', 'HEAD', 'origin/main']).stdout || '').trim() : '';
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
  'hub-smoke': (d) => edit(d, 'hub/server.mjs', (s) => s.replace('return tokenMatches(headerToken(req));', 'return true;')),
  reviewer: (d) => fs.writeFileSync(path.join(d, 'studio/reviews/2026-10-20-T-001.md'), 'Review of T-001. Verdict: approve.\n'),
  assets: (d) => {
    fs.mkdirSync(path.join(d, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(d, 'assets/stray.glb'), 'not recorded');
  },
  docs: (d) => fs.writeFileSync(path.join(d, 'docs/STALE.md'), 'Run `npm run no-such-script` first.\n'),
  secrets: (d) => fs.writeFileSync(path.join(d, 'leak.txt'), `OPENAI_API_KEY=${'sk-'}${'a'.repeat(24)}\n`),
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
  const forced = run(dir, `node harness/task.mjs done ${ids.change} --agent alice-1 --force`);
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
  run(dir, 'node harness/task.mjs done T-003 --agent alice-1 --force');
  const note = run(dir, 'node harness/handoff.mjs note "Chose spawnCost 400 because wins land on time" --agent producer');
  const brief = run(dir, 'node harness/handoff.mjs');
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
  report('onboard leaves the game untouched and queues its tasks once', fs.readFileSync(path.join(gameDir, 'src/sim.js'), 'utf8') === before && /started an unsigned Game Bible/.test(first.stdout) && /queued 9 task/.test(first.stdout) && /queued 0 task/.test(second.stdout), `${first.stdout}${second.stdout}`);
  report('the Producer briefing shows the onboarded game', /## The game[\s\S]*Tiny: A tiny test game/.test(run(dir, 'node harness/handoff.mjs').stdout));
}

// Model scorecard: bugs land on the model that closed the work; the retro turns patterns into suggestions.
{
  const dir = copyRepo();
  run(dir, 'node harness/task.mjs start T-003 --agent cursor-a --model model-a');
  run(dir, 'node harness/task.mjs done T-003 --agent cursor-a --force');
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
  report('the briefing shows the scorecard and the retro suggestions', /## Models[\s\S]*model-a/.test(run(dir, 'node harness/handoff.mjs').stdout) && /What the studio learned[\s\S]*ran out of usage/.test(run(dir, 'node harness/handoff.mjs').stdout));
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
  report('done-check refuses a change task with no changes', none.status !== 0 && /\[ \] Changes exist/.test(`${none.stdout}${none.stderr}`), `${none.stdout}${none.stderr}`);
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
  report('Phase 2 opens once the Director says Phase 1 is ready', run(dir, 'node harness/bible.mjs phase open 2 --by hatch', env).status === 0);

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
  const brief2 = run(dir, 'node harness/handoff.mjs', env).stdout;
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
  report('a focus brief carries lessons filed for the role', /## Lessons filed for `builder`[\s\S]*BUG-ROLE-1/.test(brief), brief);
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
  report('a system task starts with everything missing', /is a "system" task/.test(empty) && /\[ \] Spec written/.test(empty) && /\[ \] Approved by a reviewer/.test(empty), empty);
  fs.mkdirSync(path.join(dir, 'studio/bible/systems'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'studio/bible/systems/visitors.md'), `# Visitors\n\n${'Visitors arrive after the first terrace opens and rate the garden by moss coverage and paths. '.repeat(6)}\n\n## For the next agent\n\nTUNING.visitorRate sets arrivals; the invariant keeps ratings between 0 and 5.\n`);
  edit(dir, 'cartridges/example-sim/qa.mjs', (s) => `${s}\n// visitors scenario\n`);
  edit(dir, 'cartridges/example-sim/index.mjs', (s) => s.replace('startCredits: 1500,', 'startCredits: 1550,'));
  run(dir, 'node qa/check-golden.mjs --update');
  run(dir, 'node qa/check-regressions.mjs --update');
  run(dir, 'node qa/playtest.mjs --stage 1 --quiet');
  git('add -A');
  git(`commit -q -m visitors --no-verify --trailer "Studio-Task: ${id}"`);
  fs.writeFileSync(path.join(dir, '.studio/gates-last.json'), JSON.stringify({ at: new Date(Date.now() + 5000).toISOString(), rows: [{ id: 'golden', required: true, ok: true }] }));
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
  const mood = run(dir, 'node harness/task.mjs add "Renderer: give each room its own mood" --phase 1 --serves pillar:Calm', env);
  report('a scope refusal names the word that matched and the layer', mood.status !== 0 && /the word "mood"/.test(mood.stderr) && /--not-layer npc-needs/.test(mood.stderr), mood.stderr);
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
  const forced = run(dir, `node harness/task.mjs done ${t} --agent writer-2 --force --reason "fixture" --accepted-by jed`, env);
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
  const ok = run(dir, 'node harness/agent.mjs start --role builder --agent builder-8 --model fake-1', { ...env, STUDIO_BUILDER_CMD: 'node qa/fixtures/agents/fake-agent.mjs {agent} T-003 ok' });
  report('an agent that finishes ends cleanly and keeps its work', ok.status === 0 && /## DONE[\s\S]*T-003/.test(fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8')), ok.stdout + ok.stderr);
  // Caps: Precise allows one builder; MAX SPEED doubles it.
  const waitEnv = { ...env, STUDIO_BUILDER_CMD: 'node qa/fixtures/agents/fake-agent.mjs {agent} T-004 wait' };
  run(dir, 'node harness/mode.mjs set precise --by hatch', env);
  run(dir, 'node harness/agent.mjs start --role builder --agent builder-1 --model fake-1 --detach', waitEnv);
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 && !/running/.test(run(dir, 'node harness/agent.mjs list', env).stdout)) spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},300)']);
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
  const sup = run(dir, 'node harness/supervisor.mjs --no-hub --until 9s --foreground', env);
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
  while (Date.now() - t0 < 8000 && lanes.length < 2) {
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
  report('npm run budget shows tokens used against the week\'s target', /codex: [\d,]+ tokens this week \(\d+% of 1,000; target \d+% by now/.test(run(dir, 'node harness/budget.mjs', env).stdout), run(dir, 'node harness/budget.mjs', env).stdout);
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
  while (Date.now() - t0 < 8000 && !/zed-1/.test(run(dir, 'node harness/lock.mjs list', env).stdout)) spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},300)']);
  fs.writeFileSync(path.join(dir, 'hudjson.mjs'), "import { buildHudState } from './harness/hud.mjs';\nconsole.log(JSON.stringify(buildHudState()));\n");
  const hud = JSON.parse(run(dir, 'node hudjson.mjs', env).stdout || '{}');
  const zed = (hud.agents || []).find((a) => a.name === 'zed-1');
  report('an agent hired into a division sits in that room, and the room opens', hire.status === 0 && zed?.room === 'sound' && (hud.divisions || []).find((d) => d.id === 'sound')?.active === true && /Note from hatch: keep it subtle/.test(fs.readFileSync(path.join(dir, '.studio/kickoff/zed-1.md'), 'utf8')), hire.stdout + hire.stderr + JSON.stringify(zed));
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
  run(dir, `node harness/task.mjs done ${a} --agent prod-1 --force --reason test --accepted-by selftest`, env);
  report('once the task it waits for is done, the waiting task can start', run(dir, `node harness/task.mjs start ${b} --agent qa-x`, env).status === 0);
  // A stopped agent's task doesn't restart for a while.
  const c = id('node harness/task.mjs add "Floor two lighting" --role builder');
  run(dir, `node harness/agent.mjs start --role builder --agent stop-1 --task ${c} --detach`, { ...env, STUDIO_BUILDER_CMD: 'node qa/fixtures/agents/fake-agent.mjs {agent} {task} wait' });
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 && !/stop-1/.test(run(dir, 'node harness/lock.mjs list', env).stdout)) pause(300);
  const st = run(dir, 'node harness/agent.mjs stop stop-1 --by jed', env);
  // Wait for the launcher to hand the task back (slower on Windows), then try to restart it.
  const t2 = Date.now();
  while (Date.now() - t2 < 15000 && /stop-1/.test(run(dir, 'node harness/lock.mjs list', env).stdout)) pause(400);
  const again = run(dir, `node harness/task.mjs start ${c} --agent other-1`, env);
  report('after agent stop, its task can\'t restart straight away (run #1: it restarted within seconds)', st.status === 0 && /won't restart before/.test(st.stdout) && again.status !== 0 && /can restart after/.test(again.stderr), st.stdout + again.stdout + again.stderr);
  run(dir, `node harness/task.mjs done ${c} --agent prod-1 --force --reason test --accepted-by selftest`, env);
  run(dir, `node harness/task.mjs done ${b} --agent qa-x --force --reason test --accepted-by selftest`, env);
  // Builders never share files: without lanes one builder holds the whole game; with lanes, one per lane.
  run(dir, 'node harness/mode.mjs set fast --by hatch', env);
  for (const t of ['Fix the elevator doors', 'Fix the gun direction']) run(dir, `node harness/task.mjs add "${t}" --role builder`, env);
  const wenv = { ...env, STUDIO_BUILDER_CMD: 'node qa/fixtures/agents/fake-agent.mjs {agent} {task} wait' };
  run(dir, 'node harness/supervisor.mjs --no-hub --until 5s --foreground', wenv);
  const live = () => JSON.parse(run(dir, 'node -e "import(\'./harness/agent.mjs\').then(m=>console.log(JSON.stringify(m.sessions().filter(s=>s.running).map(s=>s.agent))))"', env).stdout || '[]');
  const one = live();
  report('two builders without lanes never run at once, even in a fast pace (run #1: they edited the same files)', one.length === 1, JSON.stringify(one));
  for (const s of one) run(dir, `node harness/agent.mjs stop ${s}`, env);
  // Wait for the launcher to hand the stopped agent's task back.
  const t1 = Date.now();
  let q0 = JSON.parse(run(dir, 'node harness/task.mjs list', env).stdout);
  while (Date.now() - t1 < 10000 && (live().length || q0.backlog.filter((t) => /^Fix the/.test(t.title)).length < 2)) {
    pause(400);
    q0 = JSON.parse(run(dir, 'node harness/task.mjs list', env).stdout);
  }
  const [l1, l2] = q0.backlog.filter((t) => /^Fix the/.test(t.title)).map((t) => t.id);
  run(dir, `node harness/task.mjs done ${tq2} --agent prod-1 --force --reason test --accepted-by selftest`, env);
  run(dir, `node harness/task.mjs lane ${l1} docs/lane-c --by prod-1`, env);
  run(dir, `node harness/task.mjs lane ${l2} docs/lane-d --by prod-1`, env);
  // Other waiting builder tasks have no lane, so one of them would take the whole game: park them.
  for (const t of JSON.parse(run(dir, 'node harness/task.mjs list', env).stdout).backlog.filter((x) => x.role === 'builder' && ![l1, l2].includes(x.id))) run(dir, `node harness/task.mjs park ${t.id} --by prod-1 --why "not this round"`, env);
  fs.writeFileSync(path.join(dir, 'studio/task-holds.json'), JSON.stringify({ tasks: Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(dir, 'studio/task-holds.json'), 'utf8')).tasks).map(([k, v]) => [k, { ...v, cooldownUntil: undefined }])) }));
  run(dir, 'node harness/supervisor.mjs --no-hub --until 5s --foreground', wenv);
  const two = live();
  report('task lane gives each builder its own folder, and then they run side by side', two.length === 2, `l1=${l1} l2=${l2} q0=${JSON.stringify(q0.backlog.map((t) => t.id))} inprog=${JSON.stringify(q0.inProgress.map((t) => t.id))} ` + JSON.stringify(two) + JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, '.studio/supervisor.json'), 'utf8')).last) + run(dir, 'node harness/task.mjs holds', env).stdout + JSON.stringify(JSON.parse(run(dir, 'node harness/task.mjs list', env).stdout).backlog.map((t) => t.id + t.role)));
  const names = fs.readdirSync(path.join(dir, '.studio/agents')).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  report('agent names never repeat across supervisor restarts', names.length === new Set(names).size && names.filter((n) => /^builder-s\d+$/.test(n)).length >= 3, names.join(', '));
  for (const s of two) run(dir, `node harness/agent.mjs stop ${s}`, env);
  pause(1500);
  // Two sessions ending the same bad way: stop starting, and ask once.
  for (const t of ['Polish one', 'Polish two', 'Polish three', 'Polish four']) run(dir, `node harness/task.mjs add "${t}" --role rnd`, env);
  run(dir, 'node harness/supervisor.mjs --no-hub --until 8s --foreground', { ...env, STUDIO_RND_CMD: 'node -e "process.exit(127)"' });
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
  fs.appendFileSync(path.join(dir, 'studio/producer/LOG.md'), '\nRecorded the pack with npm run asset.\n');
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
  while (Date.now() - t0 < 8000 && !/rnd-1/.test(run(dir, 'node harness/agent.mjs list', env).stdout)) spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},300)']);
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
    variant('keys that never reach the game fail it: start-to-win is not won', "if (e.key === 'b' || e.key === 'B') buy();", 'void e;', /BROWSER-NO-OUTCOME[^\n]*ended lost/);
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
    return run(dir, `node harness/task.mjs done ${id} --agent builder-1 --force`, env);
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
  const q2 = fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8');
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
  const id = JSON.parse(run(dir, 'node harness/task.mjs add "Visitors" --type system', ollama).stdout).id;
  run(dir, `node harness/task.mjs start ${id} --agent builder-1 --model claude-opus-5-5`, ollama);
  fs.mkdirSync(path.join(dir, 'studio/bible/systems'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'studio/bible/systems/visitors.md'), `# Visitors\n\n${'Visitors arrive after the first terrace opens and rate the garden by moss coverage and paths. '.repeat(6)}\n\n## For the next agent\n\nTUNING.visitorRate sets arrivals.\n`);
  edit(dir, 'cartridges/example-sim/qa.mjs', (s) => `${s}\n// visitors scenario\n`);
  edit(dir, 'cartridges/example-sim/index.mjs', (s) => s.replace('startCredits: 1500,', 'startCredits: 1550,'));
  run(dir, 'node qa/check-golden.mjs --update');
  run(dir, 'node qa/check-regressions.mjs --update');
  run(dir, 'node qa/playtest.mjs --stage 1 --quiet');
  git('add -A');
  git(`commit -q -m visitors --no-verify --trailer "Studio-Task: ${id}"`);
  fs.writeFileSync(path.join(dir, '.studio/gates-last.json'), JSON.stringify({ at: new Date(Date.now() + 5000).toISOString(), rows: [{ id: 'golden', required: true, ok: true }] }));
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
  report('harness notes survive a studio reset and show in the briefing', /Rerun the done-check by hand/.test(fs.readFileSync(path.join(dir, 'studio/harness-notes/NOTES.md'), 'utf8')) && /Workaround: Rerun the done-check by hand/.test(run(dir, 'node harness/handoff.mjs').stdout));
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
