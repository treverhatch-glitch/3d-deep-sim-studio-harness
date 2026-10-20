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
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
  golden: (d) => edit(d, 'qa/golden/example-1337.json', (s) => s.replace(/"hash": "[0-9a-f]{16}"/, '"hash": "0000000000000000"')),
  'golden-py': (d) => edit(d, 'qa/golden/example-1337.json', (s) => s.replace(/"hash": "[0-9a-f]{16}"/, '"hash": "0000000000000000"')),
  approvals: (d) => edit(d, 'cartridges/example-sim/qa.mjs', (s) => `// reference: https://unlisted-asset-store.example.org/pack\n${s}`),
  regressions: (d) => edit(d, 'qa/regressions/example-same-tick.json', (s) => s.replace(/"hash": "[0-9a-f]{16}"/, '"hash": "0000000000000000"')),
  'vertical-slice': (d) => edit(d, SIM, (s) => s.replace('winCredits: 25000', 'winCredits: 90000000')),
  playtest: (d) => edit(d, SIM, plantInvariant(37)),
  soak: (d) => edit(d, SIM, plantInvariant(150)),
  'tick-budget': () => ({ TICK_BUDGET_MS_PER_TICK: '0.0000001' }),
  'hub-smoke': (d) => edit(d, 'hub/server.mjs', (s) => s.replace('return tokenMatches(headerToken(req));', 'return true;')),
  secrets: (d) => fs.writeFileSync(path.join(d, 'leak.txt'), `OPENAI_API_KEY=${'sk-'}${'a'.repeat(24)}\n`),
};
// What the failure must mention, so a gate that fails for an unrelated reason does not count.
const EXPECT = {
  session: /MISSING studio\/CURRENT_TASK\.md/,
  purity: /touched: Math\.random/,
  isolation: /three/,
  golden: /expected 0000000000000000/,
  'golden-py': /hash .* != golden 0000000000000000|python hash/,
  approvals: /unlisted URL https:\/\/unlisted-asset-store/,
  regressions: /expected 0000000000000000/,
  'vertical-slice': /expected "won"/,
  playtest: /\[playtest\] FAIL/,
  soak: /PLANTED/,
  'tick-budget': /ms\/tick >/,
  'hub-smoke': /FAIL write without token is refused/,
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

// Golden stubs are not a pass.
{
  const dir = copyRepo();
  edit(dir, 'qa/golden/example-1337.json', (s) => s.replace(/"hash": "[0-9a-f]{16}"/, '"hash": "REPLACE_AFTER_FIRST_RUN"'));
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
  const pause = run(dir, 'node harness/task.mjs pause T-003 --agent cursor-a --note "Out of usage; adapter half done"');
  const pick = run(dir, 'node harness/task.mjs start T-003 --agent claude-b');
  report('task pause hands back with a note the next agent sees', pause.status === 0 && pick.status === 0 && /adapter half done/.test(pick.stderr), `${pause.stdout}${pause.stderr}${pick.stdout}${pick.stderr}`);
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
  report('onboard leaves the game untouched and queues its tasks once', fs.readFileSync(path.join(gameDir, 'src/sim.js'), 'utf8') === before && /queued 8 task/.test(first.stdout) && /queued 0 task/.test(second.stdout), `${first.stdout}${second.stdout}`);
  report('the Producer briefing shows the onboarded game', /## The game[\s\S]*Tiny: A tiny test game/.test(run(dir, 'node harness/handoff.mjs').stdout));
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
