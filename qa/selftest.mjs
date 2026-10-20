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
const gates = JSON.parse(fs.readFileSync(path.join(root, 'studio', 'gates.json'), 'utf8')).gates;
const SKIP = new Set(['.git', 'node_modules', '.env', 'dist']);
let failed = 0;
let n = 0;

function copyRepo() {
  const dest = path.join(tmpRoot, `copy-${++n}`);
  fs.cpSync(root, dest, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(root, src).replace(/\\/g, '/');
      if (!rel) return true;
      const top = rel.split('/')[0];
      return !SKIP.has(top) && !rel.startsWith('qa/reports/') && !rel.startsWith('.studio/') && !rel.includes('__pycache__');
    },
  });
  return dest;
}
const edit = (dir, rel, fn) => fs.writeFileSync(path.join(dir, rel), fn(fs.readFileSync(path.join(dir, rel), 'utf8')));
const run = (dir, cmd, env = {}) => spawnSync(cmd, { cwd: dir, shell: true, encoding: 'utf8', env: { ...process.env, STUDIO_CARTRIDGE: '', AGENT_EVENTS_FILE: '', ...env } });
const plantInvariant = (tick) => (s) =>
  s.replace('  if (state.won && state.lost)', `  if (state.tick === ${tick}) findings.push({ id: 'PLANTED', severity: 'P0', summary: 'planted at tick ${tick}' });\n  if (state.won && state.lost)`);
const runAsync = (dir, cmd, env = {}) =>
  new Promise((resolve) => {
    const c = spawn(cmd, { cwd: dir, shell: true, env: { ...process.env, STUDIO_CARTRIDGE: '', AGENT_EVENTS_FILE: '', ...env } });
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
}

// Golden stubs are not a pass.
{
  const dir = copyRepo();
  edit(dir, 'qa/golden/example-1337.json', (s) => s.replace(/"sha256": "[0-9a-f]{64}"/, '"sha256": "REPLACE_AFTER_FIRST_RUN"'));
  report('golden stub hash fails (no silent rewrite)', run(dir, 'node qa/check-golden.mjs').status !== 0);
}

// Locks and task claims.
{
  const dir = copyRepo();
  report('lock refuses a shared owner name', run(dir, 'node harness/lock.mjs claim task:T-9 --owner cursor').status !== 0);
  run(dir, 'node harness/lock.mjs claim path:cartridges --owner alice-1');
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
  const results = await Promise.all(keys.flatMap((k, i) => [0, 1].map((j) => runAsync(dir, `node harness/lock.mjs claim ${k} --owner racer-${i}-${j}`))));
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
  report('npm run learn -- backup copies the studio\'s memory, with a one-file version', b.status === 0 && made.length === 1 && fs.existsSync(path.join(to, made[0], 'STUDIO-MEMORY.md')) && fs.existsSync(path.join(to, made[0], 'studio/memory/failures.md')), b.stdout + b.stderr);
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
  report('a person declares a game asset: it is copied to assets/ with who said so and a checksum', a.status === 0 && man.assets[0].declaredBy === 'hatch' && /hatch stated that Hatch owns this file/.test(man.assets[0].statement) && fs.existsSync(path.join(dir, 'assets/boat.glb')), a.stdout + a.stderr);
  report('the assets gate passes with every shipped file recorded', run(dir, 'node scripts/check-assets.mjs').status === 0);
  fs.appendFileSync(path.join(dir, 'assets/boat.glb'), 'changed');
  report('the assets gate fails when a recorded file changed', /changed since hatch recorded it/.test(run(dir, 'node scripts/check-assets.mjs').stdout));
  fs.writeFileSync(path.join(dir, 'assets/boat.glb'), 'model');
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
  fs.writeFileSync(path.join(dir, '.studio/gates-last.json'), JSON.stringify({ at: new Date().toISOString(), rows: [{ id: 'golden', required: true, ok: true }] }));
  report('signing needs a key first', run(dir, 'node harness/sign.mjs result --by hatch').status !== 0);
  const kg = run(dir, 'node harness/sign.mjs keygen');
  report('keygen keeps the private key out of git and the public key in studio/keys', kg.status === 0 && fs.existsSync(path.join(dir, '.studio/keys/studio-ed25519.pem')) && fs.existsSync(path.join(dir, 'studio/keys/studio-ed25519.pub.pem')) && git('check-ignore -q .studio/keys/studio-ed25519.pem').status === 0, kg.stdout + kg.stderr);
  const sr = run(dir, 'node harness/sign.mjs result --by hatch --note "slice 1"');
  const signed = path.join(dir, 'studio/signed', fs.readdirSync(path.join(dir, 'studio/signed'))[0]);
  const doc = JSON.parse(fs.readFileSync(signed, 'utf8'));
  report('a signed result lists every golden\'s SHA-256, the gates and the commit', sr.status === 0 && doc.manifest.goldens.length === 2 && doc.manifest.goldens.every((g) => /^[0-9a-f]{64}$/.test(g.sha256)) && doc.manifest.gates.required === 1 && /^[0-9a-f]{40}$/.test(doc.manifest.commit), sr.stdout + sr.stderr);
  const v = run(dir, `node harness/sign.mjs verify "${signed}" --replay`);
  report('verify --replay checks the signature and re-runs the goldens', v.status === 0 && /this code produces the signed results/.test(v.stdout), v.stdout + v.stderr);
  const tampered = path.join(dir, 'tampered.json');
  fs.writeFileSync(tampered, JSON.stringify({ ...doc, manifest: { ...doc.manifest, signedBy: 'someone-else' } }));
  report('a changed manifest fails verification', run(dir, `node harness/sign.mjs verify "${tampered}"`).status !== 0);
  edit(dir, 'qa/golden/example-1337.json', (s) => s.replace(/"sha256": "[0-9a-f]{64}"/, `"sha256": "${'1'.repeat(64)}"`));
  report('verify --replay fails when the repo no longer produces the signed results', run(dir, `node harness/sign.mjs verify "${signed}" --replay`).status !== 0);
  fs.writeFileSync(path.join(dir, '.studio/gates-last.json'), JSON.stringify({ at: new Date().toISOString(), rows: [{ id: 'golden', required: true, ok: false }] }));
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
  report('trajectory export refuses without consent and terms', run(dir, 'node harness/trajectories.mjs export', env).status !== 0);
  const ex = run(dir, 'node harness/trajectories.mjs export --consent "hatch, for the studio\'s own model tests" --licence "internal evaluation only"', env);
  const out = fs.readdirSync(path.join(dir, '.studio/exports'));
  const jsonl = fs.readFileSync(path.join(dir, '.studio/exports', out.find((f) => f.endsWith('.jsonl'))), 'utf8');
  const recs = jsonl.trim().split('\n').map((l) => JSON.parse(l));
  const man = JSON.parse(fs.readFileSync(path.join(dir, '.studio/exports', out.find((f) => f.endsWith('.manifest.json'))), 'utf8'));
  report('an export writes one labelled record per finished task, with its commits', ex.status === 0 && recs.length === 2 && recs.find((r) => r.id === a)?.label === 'clean' && recs.find((r) => r.id === a)?.commits.length === 1 && recs.find((r) => r.id === b)?.label === 'caused-bug', ex.stdout + ex.stderr + jsonl);
  report('exported text is scrubbed of key-shaped strings, and the manifest records consent and a SHA-256', !jsonl.includes(key) && /\[removed\]/.test(jsonl) && man.consent && man.licence && /^[0-9a-f]{64}$/.test(man.sha256) && man.scrubbedSecrets >= 1, JSON.stringify(man));
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
  run(dir, 'node harness/lock.mjs claim path:cartridges --owner alice-1');
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
  fs.writeFileSync(path.join(dir, 'notes.txt'), `key ${'gsk_'}${'b'.repeat(30)}\n`);
  git('add notes.txt');
  report('pre-commit blocks a staged secret', run(dir, 'git -c user.name=t -c user.email=t@example.com commit -q -m y', { STUDIO_LOCK_OWNER: 'bob-1' }).status !== 0);
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

fs.rmSync(tmpRoot, { recursive: true, force: true });
if (failed) {
  console.error(`[selftest] ${failed} check(s) failed`);
  process.exit(1);
}
console.log('[selftest] ok — every required gate was shown to fail when broken');
