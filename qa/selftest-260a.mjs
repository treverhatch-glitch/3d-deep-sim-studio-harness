/**
 * qa/selftest-260a.mjs — 2.60.0 (helper a): the merge train's pin refresh, prefix bisection and union files
 * (final brief items 1 and 2c).
 *   Lanes built in parallel each re-pin a seeded game's exact numbers against an old main, so the second to land failed
 *   on stale pins; a red train blamed "the last" lane when lanes passed alone but failed together; two lanes adding a
 *   line to the same import barrel conflicted every time. Now a red train re-runs only its failing checks on prefixes
 *   (main+A, main+A+B, ...), a red that is only declared pins is refreshed in one train commit (Pin-Refresh:) when
 *   every move was declared by its lane (Pin-Moves:) and none is an invariant, and a conflict only inside a manifest
 *   "unionFiles" entry is merged with git's union driver.
 * A tiny studio: a made-up game whose "sim" sums small numbers in game/demo/tune/<pin>-*.txt into three pins, whose
 * check compares them to game/demo/pins.expected.json (printing FAIL pin:<name>), fails on a note that says BROKEN and
 * on two notes that clash; lane copies (git worktrees) with the commit hooks installed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest260A({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8' });
  const write = (base, rel, text) => { fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true }); fs.writeFileSync(path.join(base, rel), text); };
  const events = path.join(dir, '.studio', 'events-260a.jsonl');
  const env = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', GITHUB_BASE_REF: '', STUDIO_GAME: 'demo', STUDIO_REACHABILITY: 'off', STUDIO_DONE_NOOP: 'allow', STUDIO_DONE_REUSE_VERIFY: '', STUDIO_GATE_INCOMING_FILE: '', STUDIO_GATE_PRIORITY: '', STUDIO_GATE_CHANGED: '', STUDIO_GATE_PATHS: '', STUDIO_TRAIN: '', STUDIO_TRAIN_BISECT: '', STUDIO_HOOKS_CHECK: 'on', STUDIO_LANE_LIVE_MIN: '0', STUDIO_COMPACT_OUTPUT: '', STUDIO_GAME_GATE_RETRY: '', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-260a-${process.pid}.pem`), AGENT_EVENTS_FILE: events, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const evs = () => { try { return fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const mainHas = (rel) => g(dir, 'cat-file', '-e', `main:${rel}`).status === 0;
  const mainFile = (rel) => g(dir, 'show', `main:${rel}`).stdout || '';
  const board = () => `${fs.existsSync(path.join(dir, 'studio/NEXT.md')) ? fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8') : ''}`;
  const doneBoard = () => `${fs.existsSync(path.join(dir, 'studio/DONE.md')) ? fs.readFileSync(path.join(dir, 'studio/DONE.md'), 'utf8') : ''}`;
  const isDone = (id) => new RegExp(`\\b${id}\\b`).test(doneBoard()) && !new RegExp(`\\b${id}\\b`).test(board().split(/^## Done/m)[0]);
  const queue = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, '.studio', 'train', 'queue.json'), 'utf8')).map((e) => e.task); } catch { return []; } };
  const handBack = (id) => { const f = path.join(dir, 'studio', 'handoffs', `${id}.md`); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''; };
  const dropped = (id) => evs().some((e) => e.type === 'task.train.dropped' && e.task === id);
  const mainLog = () => g(dir, 'log', '--format=%B%x00', 'main').stdout || '';
  const expected = () => { try { return JSON.parse(mainFile('game/demo/pins.expected.json')); } catch { return {}; } };

  // ---- the studio and its made-up game ----
  write(dir, 'studio/gates.json', `${JSON.stringify({ gates: [
    { id: 'protected', command: 'node qa/protected-check.mjs', required: true, lite: true },
    { id: 'secrets', command: 'node scripts/secret-scan.mjs', required: true, lite: true },
    { id: 'hooks', command: 'node harness/hook-stamp.mjs check', required: true, lite: true, cache: false },
    { id: 'game', command: 'node harness/game-gates.mjs', required: true, lite: true, cache: false },
  ] }, null, 2)}\n`);
  write(dir, 'game/demo/studio.gates.json', `${JSON.stringify({
    gates: [{ id: 'check', command: 'node game/demo/check.mjs' }],
    pins: { tests: ['pin:*'], report: 'node game/demo/pins.mjs report {out}', refresh: 'node game/demo/pins.mjs refresh {in}', invariants: ['retryCap'] },
    unionFiles: ['game/demo/barrel.txt'],
  }, null, 2)}\n`);
  // The pins: three numbers, base + the numbers in game/demo/tune/<prefix>-*.txt. The expectations file keeps a blank
  // line between keys, so two lanes re-pinning different pins don't touch neighbouring lines.
  write(dir, 'game/demo/pins.mjs', [
    "import fs from 'node:fs'; import path from 'node:path';",
    "const base = { queueWindow: 15, retryCap: 2, throughput: 10 };",
    "const from = { queueWindow: 'queue', retryCap: 'cap', throughput: 'flow' };",
    "export function actual() {",
    "  const v = { ...base }; const d = 'game/demo/tune';",
    "  if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) for (const [k, p] of Object.entries(from)) if (f.startsWith(`${p}-`)) v[k] += Number(fs.readFileSync(path.join(d, f), 'utf8').trim() || 0);",
    "  return v;",
    "}",
    "export const format = (o) => `{\\n${Object.keys(o).sort().map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(o[k])}`).join(',\\n\\n')}\\n}\\n`;",
    "const [cmd, file] = process.argv.slice(2);",
    "if (cmd === 'report') fs.writeFileSync(file, JSON.stringify(actual()));",
    "if (cmd === 'refresh') { const r = JSON.parse(fs.readFileSync(file, 'utf8')); const e = JSON.parse(fs.readFileSync('game/demo/pins.expected.json', 'utf8')); for (const k of Object.keys(e)) if (k in r) e[k] = r[k]; fs.writeFileSync('game/demo/pins.expected.json', format(e)); }",
    ''].join('\n'));
  write(dir, 'game/demo/check.mjs', [
    "import fs from 'node:fs'; import path from 'node:path';",
    "import { actual } from './pins.mjs';",
    "let bad = 0;",
    "const exp = JSON.parse(fs.readFileSync('game/demo/pins.expected.json', 'utf8')); const act = actual();",
    "for (const k of Object.keys(exp)) if (exp[k] !== act[k]) { console.log(`FAIL pin:${k}: expected ${exp[k]}, got ${act[k]}`); bad += 1; }",
    "const d = 'game/demo/notes';",
    "const notes = fs.existsSync(d) ? fs.readdirSync(d) : [];",
    "for (const f of notes) if (fs.readFileSync(path.join(d, f), 'utf8').includes('BROKEN')) { console.log(`FAIL notes: ${f} says BROKEN`); bad += 1; }",
    "if (notes.includes('clash-a.md') && notes.includes('clash-b.md')) { console.log('FAIL interaction: clash-a and clash-b together'); bad += 1; }",
    "if (bad) process.exit(1);",
    "console.log('demo ok');", ''].join('\n'));
  write(dir, 'game/demo/pins.expected.json', '{\n  "queueWindow": 15,\n\n  "retryCap": 2,\n\n  "throughput": 10\n}\n');
  write(dir, 'game/demo/barrel.txt', 'import base\n');
  write(dir, 'game/demo/notes/shared.md', '# Shared\n\nline one\n');
  g(dir, 'init', '-q', '-b', 'main'); g(dir, 'config', 'core.autocrlf', 'false');
  g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'studio', '--no-verify');
  g(dir, 'config', 'core.hooksPath', 'scripts/hooks');

  const addTask = (title) => (out(run(dir, `node harness/task.mjs add "${title}" --role builder --priority P1`, env)).match(/"id": "(T-\d+)"/) || [])[1];
  const laneProbe = path.join(tmpRoot, `lane-260a-${process.pid}.mjs`);
  fs.writeFileSync(laneProbe, `import { createLaneCopy } from ${JSON.stringify(pathToFileURL(path.join(dir, 'harness', 'worktree.mjs')).href)};\nconst r = createLaneCopy(process.argv[2], { task: process.argv[3] });\nconsole.log(JSON.stringify(r));\n`);
  /** A task, its lane copy, the task started there, files written and committed with the hooks; `edit(ld)` may change more. */
  const lane = (agent, title, files, { trailers = [], edit = null } = {}) => {
    const id = addTask(title);
    const made = run(dir, `node "${laneProbe}" ${agent} ${id}`, env);
    const ld = path.join(dir, '.lanes', agent);
    const as = { ...env, STUDIO_MAIN_ROOT: dir, STUDIO_LOCK_OWNER: agent };
    const st = run(ld, `node harness/task.mjs start ${id} --agent ${agent}`, as);
    for (const [rel, text] of Object.entries(files)) write(ld, rel, typeof text === 'function' ? text(fs.existsSync(path.join(ld, rel)) ? fs.readFileSync(path.join(ld, rel), 'utf8') : '') : text);
    if (edit) edit(ld);
    g(ld, 'add', '-A');
    const c = spawnSync('git', ['commit', '-q', '-m', `${id}: ${title}`, ...trailers.flatMap((t) => ['-m', t])], { cwd: ld, encoding: 'utf8', env: { ...process.env, ...as } });
    return { id, agent, dir: ld, as, ok: fs.existsSync(ld) && st.status === 0 && c.status === 0, log: `${out(made)}\n${out(st)}\n${out(c)}` };
  };
  /** A lane that moves pins: +1 on each named pin, its own expectations re-pinned against the main it started from. */
  const pinLane = (agent, title, moves, trailers) => lane(agent, title, Object.fromEntries(moves.map((p) => [`game/demo/tune/${{ throughput: 'flow', queueWindow: 'queue', retryCap: 'cap' }[p]}-${agent}.txt`, '1\n'])), {
    trailers,
    edit: (ld) => {
      const f = path.join(ld, 'game/demo/pins.expected.json');
      const e = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const p of moves) e[p] += 1;
      fs.writeFileSync(f, `{\n${Object.keys(e).sort().map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(e[k])}`).join(',\n\n')}\n}\n`);
    },
  });
  const queueIt = (l) => run(l.dir, `node harness/task.mjs done ${l.id} --agent ${l.agent} --train`, l.as);
  const train = (extra = '') => run(dir, `node harness/task.mjs train --by tester ${extra}`, env);
  const pinsRecords = () => { const d = path.join(dir, '.studio', 'train'); const outR = []; try { for (const n of fs.readdirSync(d)) { const f = path.join(d, n, 'pins.json'); if (fs.existsSync(f)) outR.push(JSON.parse(fs.readFileSync(f, 'utf8'))); } } catch {} return outR; };

  // ---- 1. two lanes each moving a declared pin: one Pin-Refresh commit, correct attribution, both land ----
  const a = pinLane('pin-a', 'Tune: flow a', ['throughput'], ['Pin-Moves: throughput']);
  const b = pinLane('pin-b', 'Tune: flow and queue b', ['throughput', 'queueWindow'], ['Pin-Moves: throughput, queueWindow']);
  const qa = queueIt(a); const qb = queueIt(b);
  const t1 = train();
  const rec1 = pinsRecords().find((r) => r.refreshed && r.lanes.map((l) => l.task).join(',') === `${a.id},${b.id}`);
  const refreshCommits = mainLog().split('\0').filter((m) => /pin refresh/.test(m));
  const e1 = expected();
  report('2.60.0 (#1): two lanes that each re-pinned throughput (and one queueWindow) against the same main, each declaring it (Pin-Moves:), land in one train with ONE extra "pin refresh" commit (Pin-Refresh: both lanes) whose expectations are the combined values; the report (.studio/train/<id>/pins.json) attributes throughput to both lanes and queueWindow to the second (fails on 2.59.1: the second lane waited for the next train with stale pins)',
    a.ok && b.ok && qa.status === 0 && qb.status === 0 && t1.status === 0 && isDone(a.id) && isDone(b.id) && refreshCommits.length === 1 && new RegExp(`^Pin-Refresh: ${a.id}, ${b.id}$`, 'm').test(refreshCommits[0] || '')
      && e1.throughput === 12 && e1.queueWindow === 16 && e1.retryCap === 2 && rec1?.moved?.throughput?.by?.join(',') === `${a.id},${b.id}` && rec1?.moved?.queueWindow?.by?.join(',') === b.id
      && rec1?.before?.throughput === 10 && rec1?.after?.throughput === 12 && evs().some((e) => e.type === 'task.train.pin_refresh'),
    `${a.log.slice(-300)}\n${out(qa).slice(-300)}\n${out(qb).slice(-300)}\n${out(t1).slice(-2500)}\nexpected=${JSON.stringify(e1)} commits=${refreshCommits.length}\nrec=${JSON.stringify(rec1?.moved)}`);

  // ---- 2. an undeclared move: the train stays red on it and hands back the lane that moved it (the first one) ----
  const d = pinLane('pin-d', 'Tune: flow d, undeclared', ['throughput'], []);
  const c = pinLane('pin-c', 'Tune: flow c', ['throughput'], ['Pin-Moves: throughput']);
  queueIt(d); queueIt(c);
  const t2 = train();
  const noteD = handBack(d.id);
  report('2.60.0 (#1): a lane that moves a pin without declaring it (no Pin-Moves: throughput) is handed back with a note naming the pin, even when it is not the last lane; the declaring lane lands with no pin refresh (fails on 2.59.1: the last lane waited and the undeclared move landed)',
    d.ok && c.ok && dropped(d.id) && !isDone(d.id) && /throughput/.test(noteD) && /Pin-Moves/.test(noteD) && isDone(c.id) && mainLog().split('\0').filter((m) => /pin refresh/.test(m)).length === 1 && expected().throughput === 13 && queue().length === 0,
    `${out(t2).slice(-2500)}\nnote: ${noteD.slice(-600)}\nexpected=${JSON.stringify(expected())}`);

  // ---- 3. an invariant pin is never refreshed, even when declared ----
  const e = pinLane('pin-e', 'Tune: go-around cap e', ['retryCap'], ['Pin-Moves: retryCap']);
  const f = pinLane('pin-f', 'Tune: go-around cap f', ['retryCap'], ['Pin-Moves: retryCap']);
  queueIt(e); queueIt(f);
  const t3 = train();
  report('2.60.0 (#1): an invariant pin (pins.invariants: retryCap) moved by two lanes that both declare it is never refreshed: no refresh commit, main\'s expectation unchanged, both lanes handed back with a note saying it is an invariant (fails on 2.59.1: the first lane landed its cap change)',
    e.ok && f.ok && !mainHas(`game/demo/tune/cap-pin-e.txt`) && !mainHas(`game/demo/tune/cap-pin-f.txt`) && expected().retryCap === 2 && dropped(e.id) && dropped(f.id) && /invariant/.test(handBack(e.id)) && /invariant/.test(handBack(f.id))
      && mainLog().split('\0').filter((m) => /pin refresh/.test(m)).length === 1,
    `${out(t3).slice(-2500)}\nexpected=${JSON.stringify(expected())}`);

  // ---- 4. an interaction culprit: G and H each pass alone, G+H fails; I is last. Prefix bisection hands back H ----
  const gL = lane('int-g', 'Docs: clash a', { 'game/demo/notes/clash-a.md': '# A\n' });
  const hL = lane('int-h', 'Docs: clash b', { 'game/demo/notes/clash-b.md': '# B\n' });
  const iL = lane('int-i', 'Docs: note i', { 'game/demo/notes/i.md': '# I\n' });
  queueIt(gL); queueIt(hL); queueIt(iL);
  const t4 = train();
  const noteH = handBack(hL.id);
  const bis = evs().filter((x) => x.type === 'task.train.bisect' && x.meta?.mode === 'prefix').pop();
  report('2.60.0 (#1): prefix bisection on the failing checks only: with lanes G, H, I where G and H each pass alone but fail together, the first red prefix (main+G+H) hands back H with a note that it breaks the checks together with G; G and I land; no lane waits (fails on 2.59.1: "the last" lane I waited, then H waited, nobody was handed back)',
    gL.ok && hL.ok && iL.ok && isDone(gL.id) && isDone(iL.id) && !isDone(hL.id) && dropped(hL.id) && /together with/.test(noteH) && new RegExp(gL.id).test(noteH) && bis?.meta?.culprit === hL.id && queue().length === 0
      && !evs().some((x) => x.type === 'task.train.deferred' && [gL.id, hL.id, iL.id].includes(x.task)),
    `${out(t4).slice(-2500)}\nnote: ${noteH.slice(-500)}\nbisect=${JSON.stringify(bis?.meta)}`);

  // ---- 5. two lanes that both add a line to a union file land together with both lines ----
  const j = lane('uni-j', 'Wire module j', { 'game/demo/barrel.txt': (t) => `${t}import j\n`, 'game/demo/notes/j.md': '# J\n' });
  const k = lane('uni-k', 'Wire module k', { 'game/demo/barrel.txt': (t) => `${t}import k\n`, 'game/demo/notes/k.md': '# K\n' });
  queueIt(j); queueIt(k);
  const t5 = train();
  const barrel = mainFile('game/demo/barrel.txt');
  report('2.60.0 (#2c): two lanes that each add an import line at the end of a manifest "unionFiles" file conflict only there: the train merges it with git\'s union driver (both lines kept, in train order; the merge commit says Union-Merge:) and both land in one train (fails on 2.59.1: the second lane waited for the next train, where it conflicted with main and was handed back)',
    j.ok && k.ok && isDone(j.id) && isDone(k.id) && barrel === 'import base\nimport j\nimport k\n' && /^Union-Merge: game\/demo\/barrel\.txt/m.test(mainLog()) && queue().length === 0,
    `${out(t5).slice(-2000)}\nbarrel=${JSON.stringify(barrel)}`);

  // ---- 6. a conflict outside the union files still waits (guard: the union path stays narrow) ----
  const l = lane('uni-l', 'Wire l, shared line', { 'game/demo/barrel.txt': (t) => `${t}import l\n`, 'game/demo/notes/shared.md': '# Shared\n\nline one, as l says\n' });
  const m = lane('uni-m', 'Wire m, shared line', { 'game/demo/barrel.txt': (t) => `${t}import m\n`, 'game/demo/notes/shared.md': '# Shared\n\nline one, as m says\n' });
  queueIt(l); queueIt(m);
  const t6 = train();
  report('2.60.0 (#2c): two lanes that conflict in a union file AND in another file are not union-merged: the first lands, the second waits for the next train as before (its deferral logged once), and main never holds its line (fails on 2.59.1 only because the deferral was logged twice: the train handled its first build\'s deferred and conflicting lanes again in round 0)',
    l.ok && m.ok && isDone(l.id) && !isDone(m.id) && queue().join(',') === m.id && !/import m/.test(mainFile('game/demo/barrel.txt')) && /as l says/.test(mainFile('game/demo/notes/shared.md')) && evs().filter((x) => x.type === 'task.train.deferred' && x.task === m.id).length === 1,
    `${out(t6).slice(-1500)}\nqueue=${queue()}`);

  // ---- 7. a red main hands nobody back (prefix mode re-checks main first) ----
  write(dir, 'game/demo/notes/main-broken.md', 'BROKEN on main\n');
  g(dir, 'add', 'game/demo/notes/main-broken.md');
  const mc = spawnSync('git', ['commit', '-qm', 'main: broken note'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env, STUDIO_MAIN_COMMIT: 'allow' } });
  const n = lane('red-n', 'Docs: note n', { 'game/demo/notes/n.md': '# N\n' });
  const o = lane('red-o', 'Docs: note o', { 'game/demo/notes/o.md': '# O\n' });
  queueIt(n); queueIt(o);
  const t7 = train();
  report('2.60.0 (#1): with prefix bisection, a train whose failing check fails on main itself (re-checked first) lands nothing and hands nobody back: both lanes wait, the train says main is red (a guard; passes on 2.59.1 too, by its every-lane-alone path)',
    mc.status === 0 && n.ok && o.ok && !isDone(n.id) && !isDone(o.id) && !dropped(n.id) && !dropped(o.id) && /itself fails its checks/.test(out(t7)) && evs().some((x) => x.type === 'task.train.red_main') && queue().includes(n.id) && queue().includes(o.id),
    `${out(mc).slice(-300)}\n${out(t7).slice(-1500)}`);

  // ---- 8. the pure pieces: settings, pin-test names, pins-only detection, STUDIO_TRAIN_BISECT=alone ----
  const probe = path.join(tmpRoot, `pins-260a-${process.pid}.mjs`);
  fs.writeFileSync(probe, `import { readTrainSettings, isPinTest, pinNameMatches, pinsOnlyRed, bisectMode } from ${JSON.stringify(pathToFileURL(path.join(dir, 'harness', 'train.mjs')).href)};
const s = readTrainSettings({ pins: { tests: ['pin:*'], report: 'x {out}', refresh: 'y' }, unionFiles: ['a/b.ts', '../c.ts'] });
const log = (lines) => lines.join('\\n');
const only = pinsOnlyRed(log(['[game-gates] FAIL game:check: exit 1: FAIL pin:a', '[game-gates] failing tests in game:check: ["pin:a: expected 1, got 2"]']), { failGates: ['game'], tests: ['pin:*'] });
const mixed = pinsOnlyRed(log(['[game-gates] FAIL game:check: exit 1', '[game-gates] failing tests in game:check: ["pin:a: x", "notes: BROKEN"]']), { failGates: ['game'], tests: ['pin:*'] });
const otherGate = pinsOnlyRed(log(['[game-gates] FAIL game:check: exit 1', '[game-gates] failing tests in game:check: ["pin:a: x"]']), { failGates: ['game', 'hooks'], tests: ['pin:*'] });
const unnamed = pinsOnlyRed(log(['[game-gates] FAIL game:check: exit 1']), { failGates: ['game'], tests: ['pin:*'] });
console.log(JSON.stringify({ pinsOff: s.pins === null, notes: s.notes.length, union: s.unionFiles, tok: isPinTest('suite > throughput holds', ['throughput']), notTok: isPinTest('throughputX', ['throughput']), glob: pinNameMatches('replays/start-2', ['replays/*']), only: only.ok, mixed: mixed.ok, otherGate: otherGate.ok, unnamed: unnamed.ok, alone: bisectMode({ STUDIO_TRAIN_BISECT: 'alone' }), prefix: bisectMode({}) }));`);
  const pr = run(dir, `node "${probe}"`, env);
  let pj = {};
  try { pj = JSON.parse(String(pr.stdout).trim().split('\n').pop()); } catch {}
  report('2.60.0 (#1, #2c): the manifest\'s pins block is off (with a note) when refresh lacks {in}; a unionFiles path outside the repo is refused; pin tests match by token; a red counts as pins-only only when every failing check is the game\'s, names its failing tests and all of them are pins; STUDIO_TRAIN_BISECT=alone keeps the 2.59 bisection (fails on 2.59.1: none of these exist)',
    pj.pinsOff === true && pj.notes === 2 && pj.union?.join(',') === 'a/b.ts' && pj.tok === true && pj.notTok === false && pj.glob === true && pj.only === true && pj.mixed === false && pj.otherGate === false && pj.unnamed === false && pj.alone === 'alone' && pj.prefix === 'prefix',
    out(pr).slice(-800));
  for (const p of [laneProbe, probe]) fs.rmSync(p, { force: true });
}
