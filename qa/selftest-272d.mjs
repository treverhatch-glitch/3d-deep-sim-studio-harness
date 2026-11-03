/**
 * qa/selftest-272d.mjs — 2.72.0 (helper d): the gameplay logic library and the self-test's CI shards.
 *   need       `npm run logic -- need "<what>"` finds the shipped example module in at most 15 lines (what it does, its
 *              interface, stack, assumptions, game and harness version, tests and golden); another stack is offered as
 *              a port; a miss says "not in the library: search open source next (a research task, 2.71), else write
 *              it" and --research files ONE research task.
 *   add        only landed code: a file not on main, a file that differs from main, a task not done, no spec, or a
 *              spec that fails on the code is refused; a landed module is proposed (copied with its spec) and isn't
 *              offered until it is confirmed.
 *   confirm    never its author, never a worker; a person confirms (a decision record); a library file changed
 *              afterwards takes the module out of `need` until it is confirmed again.
 *   licence    code from outside: MIT gets a credit line (CREDITS.md on confirm); GPL is held until the owner's yes
 *              (tier C; never a worker's), then confirmed; no licence or an unknown one is refused.
 *   stale      a module no game used for STUDIO_LOGIC_STALE_DAYS (90) is flagged in `logic -- list`; `use` clears it.
 *   check      a module's language-neutral spec passes on it, and fails on a wrong port naming the case.
 *   shipped    the library ships one made-up example module and nothing else.
 *   shards     `qa/selftest.mjs --list-shards N`: every unit in exactly one shard, every shard non-empty, the same split
 *              twice, the owner-key group together, no check outside a unit, every top-level block guarded; a bad
 *              --shard is refused; a one-unit shard runs only its unit; an empty shard fails.
 *   except     `run-gates --except <ids>` leaves those gates out (named as skipped), the run is partial; an unknown id
 *              is refused.
 *   ci         the release-gate and windows jobs run everything but the self-test, the self-test runs in N shard jobs
 *              (--shard i/N, i = 1..N) on each, and a summary job fails when any of them did not pass.
 * Made-up modules and games; no network.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export async function selftest272D({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*)$/.test(k)) delete e[k]; return e; };
  const g = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: gEnv() });
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const base = {
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_MAIN_ROOT: '', STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '',
    STUDIO_LOGIC_STALE_DAYS: '', STUDIO_VERIFY_DETACH: 'off', STUDIO_GAME: '', CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', npm_lifecycle_event: '',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-272d-${process.pid}.pem`), ...ident,
  };
  const logic = (args, env = {}) => run(dir, `node harness/logic-library.mjs ${args}`, { ...base, ...env });
  const task = (args, env = {}) => run(dir, `node harness/task.mjs ${args}`, { ...base, ...env });
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  const lib = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'studio/logic-library/library.json'), 'utf8')); } catch { return { modules: [] }; } };
  const mod = (name) => lib().modules.find((m) => m.name === name) || null;
  const hasLib = fs.existsSync(path.join(dir, 'harness', 'logic-library.mjs'));
  const doneTask = (title) => {
    const id = JSON.parse(task(`add "${title}" --role builder`).stdout || '{}').id;
    task(`start ${id} --agent claude-b`);
    task(`done ${id} --agent claude-b --force --reason "selftest 272d: landed"`);
    return id;
  };
  const commit = (msg) => { g('add', '-A'); return g('commit', '-qm', msg, '--no-verify'); };

  // ---- shipped: one made-up example, nothing else (read before anything is added) ----
  await guard('2.72.0 (d shipped): the logic library ships EMPTY except one made-up example module (example-step-toward: its code and spec.json under studio/logic-library/modules/, confirmed, example), with INDEX.md written from library.json and no game names (fails on 2.71.1: no library)', () => {
    const l = lib();
    const files = (() => { try { return fs.readdirSync(path.join(dir, 'studio/logic-library/modules')); } catch { return []; } })();
    const idx = (() => { try { return fs.readFileSync(path.join(dir, 'studio/logic-library/INDEX.md'), 'utf8'); } catch { return ''; } })();
    const text = JSON.stringify(l) + idx;
    return [l.modules.length === 1 && l.modules[0].name === 'example-step-toward' && l.modules[0].example === true && l.modules[0].status === 'confirmed' && files.join() === 'example-step-toward'
      && fs.existsSync(path.join(dir, 'studio/logic-library/modules/example-step-toward/spec.json')) && /\*\*example-step-toward\*\* \[ts\]/.test(idx) && !/hatchfield|airport|marina/i.test(text), `${JSON.stringify(l).slice(0, 800)}\n${files}\n${idx}`];
  });

  // ---- need ----
  await guard('2.72.0 (d need): `logic -- need "<what>"` prints at most 15 lines: the example module with what it does, its interface, stack, assumptions, game @ harness version, tests and golden, and how to reuse it; with --stack cs it is offered as a port its spec checks (fails on 2.71.1: no logic command)', () => {
    const r = logic('need "move a value toward a target step by step"');
    const c = logic('need "move a value toward a target" --stack cs');
    const lines = out(r).trim().split('\n');
    return [r.status === 0 && lines.length <= 15 && /example-step-toward \[ts\] — moves a number toward a target/.test(out(r)) && /stepToward\(value: number, target: number, maxStep: number\): number/.test(out(r))
      && /assumes plain finite numbers/.test(out(r)) && /@ harness 2\.72\.0/.test(out(r)) && /tests: spec 5 case\(s\); golden: none/.test(out(r)) && /Reuse: copy studio\/logic-library\/modules\/example-step-toward\//.test(out(r))
      && c.status === 0 && /port from ts: example-step-toward/.test(out(c)) && /spec\.json checks the port/.test(out(c)), `${out(r)}\n---\n${out(c)}`];
  });

  await guard('2.72.0 (d need miss): a need the library can\'t answer says "not in the library: search open source next (a research task, 2.71), else write it" in a few lines; --research files ONE research task (Research: …, the 2.71 type) and a second ask finds it open (fails on 2.71.1: no logic command)', () => {
    const a = logic('need "hex grid path finder" --stack gd');
    const b = logic('need "hex grid path finder" --stack gd --research --by producer-1');
    const c = logic('need "hex grid path finder" --stack gd --research --by producer-1');
    const nextMd = (() => { try { return fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8'); } catch { return ''; } })();
    const n = (nextMd.match(/Research: open-source code for "hex grid path finder" \(gd\)/g) || []).length;
    return [a.status === 0 && /not in the library: search open source next \(a research task, 2\.71\), else write it\./.test(out(a)) && out(a).trim().split('\n').length <= 15 && /--research/.test(out(a))
      && b.status === 0 && /research task T-\d+ filed/.test(out(b)) && /already open/.test(out(c)) && n === 1, `${out(a)}\n---\n${out(b)}\n---\n${out(c)}\nNEXT matches: ${n}`];
  });

  // ---- add: only landed code ----
  // A made-up module in a made-up game, in a git studio on main.
  const SRC = 'game/toy/src/logic/wrap-index.mjs';
  write(SRC, 'export function wrapIndex(i, n) {\n  return ((i % n) + n) % n;\n}\n');
  write('game/toy/src/logic/spec.json', JSON.stringify({ function: 'wrapIndex', cases: [{ name: 'inside', args: [2, 5], expect: 2 }, { name: 'past the end', args: [7, 5], expect: 2 }, { name: 'negative', args: [-1, 5], expect: 4 }] }, null, 2));
  write('game/toy/tests/wrap.test.mjs', "// made-up test file for the 272d library check\n");
  g('init', '-q', '-b', 'main');
  const pre = commit('base (without the new module)');
  // Not yet landed: a new file only on disk.
  write('game/toy/src/logic/ring-step.mjs', 'export function ringStep(i, d, n) {\n  return (((i + d) % n) + n) % n;\n}\n');
  const taskA = doneTask('Ring buffer index');
  await guard('2.72.0 (d add landed): `logic -- add` takes only code that landed: a file that isn\'t on main is refused, a committed file edited since is refused ("differs from main"), a task that isn\'t done is refused, a folder with no spec.json is refused, and a spec that fails on the code is refused (fails on 2.71.1: no logic command)', () => {
    const notOnMain = logic(`add game/toy/src/logic --name ring-step --task ${taskA} --does "steps an index around a ring" --by claude-b`);
    fs.rmSync(path.join(dir, 'game/toy/src/logic/ring-step.mjs'));
    fs.appendFileSync(path.join(dir, SRC), '// an edit that has not landed\n');
    const differs = logic(`add game/toy/src/logic --name wrap-index --task ${taskA} --does "wraps an index into 0..n-1" --by claude-b`);
    g('checkout', '-q', '--', SRC);
    const open = JSON.parse(task('add "Wrap helper still open" --role builder').stdout || '{}').id;
    const notDone = logic(`add game/toy/src/logic --name wrap-index --task ${open} --does "wraps an index into 0..n-1" --by claude-b`);
    write('game/toy/src/nospec/clamp01.mjs', 'export function clamp01(x) {\n  return Math.min(1, Math.max(0, x));\n}\n');
    write('game/toy/src/badspec/half.mjs', 'export function half(x) {\n  return x / 2;\n}\n');
    write('game/toy/src/badspec/spec.json', JSON.stringify({ function: 'half', cases: [{ name: 'halves', args: [4], expect: 3 }] }));
    commit('two more helpers');
    const noSpec = logic(`add game/toy/src/nospec --name clamp-unit --task ${taskA} --does "clamps to 0..1" --by claude-b`);
    const badSpec = logic(`add game/toy/src/badspec --name half --task ${taskA} --does "halves a number" --by claude-b`);
    return [pre.status === 0 && notOnMain.status !== 0 && /game\/toy\/src\/logic\/ring-step\.mjs isn't on main: only code that landed/.test(out(notOnMain))
      && differs.status !== 0 && /wrap-index\.mjs differs from main: land the change first/.test(out(differs))
      && notDone.status !== 0 && new RegExp(`task ${open} isn't done`).test(out(notDone))
      && noSpec.status !== 0 && /language-neutral test spec/.test(out(noSpec))
      && badSpec.status !== 0 && /its spec fails on game\/toy\/src\/badspec\/half\.mjs: 1 of 1 case\(s\) fail \(halves: got 2, expected 3\)/.test(out(badSpec)) && !mod('wrap-index') && !mod('half'),
    [notOnMain, differs, notDone, noSpec, badSpec].map(out).join('\n---\n')];
  });

  const added = logic(`add game/toy/src/logic --name wrap-index --task ${taskA} --does "wraps any integer index into 0..n-1 (negative too)" --assumptions "n > 0, integers" --tests game/toy/tests/wrap.test.mjs --by claude-b --game toy`);
  await guard('2.72.0 (d add proposed): a landed module whose task is done is proposed: its code and spec copied to studio/logic-library/modules/<name>/, with its interface read from the code, the game, the harness version, the task and its tests; `need` doesn\'t offer it before it is confirmed (fails on 2.71.1: no logic command)', () => {
    const m = mod('wrap-index');
    const n = logic('need "wrap an index"');
    return [added.status === 0 && /proposed: a game dev, an outside agent or a person confirms it/.test(out(added)) && m?.status === 'proposed' && m.by === 'claude-b' && m.task === taskA && m.game === 'toy' && m.stack === 'ts'
      && /^wrapIndex\(i, n\)/.test(m.interface) && m.tests.join() === 'game/toy/tests/wrap.test.mjs' && m.specCases === 3 && fs.existsSync(path.join(dir, 'studio/logic-library/modules/wrap-index/wrap-index.mjs')) && fs.existsSync(path.join(dir, 'studio/logic-library/modules/wrap-index/spec.json'))
      && !/wrap-index \[ts\]/.test(out(n)) && /not in the library/.test(out(n)) && /wrap-index: proposed/.test(out(n)), `${out(added)}\n${JSON.stringify(m)}\n---\n${out(n)}`];
  });

  // ---- confirm ----
  await guard('2.72.0 (d confirm): its author can\'t confirm a module (by name or as its shell), a worker can\'t, an agent can\'t record a person\'s confirm without their words; a person can: the module is offered by `need`, the decision is logged; a library file changed afterwards takes it out until it is confirmed again (fails on 2.71.1: no logic command)', () => {
    const self = logic('confirm wrap-index --by claude-b');
    const selfShell = logic('confirm wrap-index --by Dana', { STUDIO_LOCK_OWNER: 'claude-b' });
    const worker = logic('confirm wrap-index --by builder-7', { STUDIO_LOCK_OWNER: 'builder-7' });
    const agentNoWords = logic('confirm wrap-index --by Dana', { CLAUDECODE: '1', STUDIO_LOCK_OWNER: 'opus-bot' });
    const before = mod('wrap-index')?.status;
    const ok = logic('confirm wrap-index --by Dana');
    const n1 = logic('need "wrap an index"');
    const decisions = (() => { try { return fs.readFileSync(path.join(dir, '.studio/decisions.jsonl'), 'utf8'); } catch { return ''; } })();
    fs.appendFileSync(path.join(dir, 'studio/logic-library/modules/wrap-index/wrap-index.mjs'), '// changed after the confirm\n');
    const n2 = logic('need "wrap an index"');
    const list = logic('list');
    return [self.status !== 0 && /its author can't confirm it/.test(out(self)) && selfShell.status !== 0 && /its author can't confirm it/.test(out(selfShell))
      && worker.status !== 0 && /worker/.test(out(worker)) && agentNoWords.status !== 0 && /permission/.test(out(agentNoWords)) && before === 'proposed'
      && ok.status === 0 && /confirmed by Dana, person/.test(out(ok)) && /wrap-index \[ts\] — wraps any integer index/.test(out(n1)) && /"action":"logic-library","subject":"wrap-index","by":"Dana"/.test(decisions)
      && !/wrap-index \[ts\] — wraps/.test(out(n2)) && /changed since it was confirmed \(modules\/wrap-index\/wrap-index\.mjs\)/.test(out(list)),
    [self, selfShell, worker, agentNoWords, ok, n1, n2, list].map(out).join('\n---\n')];
  });

  // ---- licences ----
  write('game/toy/src/ease/ease-out.mjs', 'export function easeOut(t) {\n  return 1 - (1 - t) * (1 - t);\n}\n');
  write('game/toy/src/ease/spec.json', JSON.stringify({ function: 'easeOut', cases: [{ name: 'start', args: [0], expect: 0 }, { name: 'end', args: [1], expect: 1 }, { name: 'middle', args: [0.5], expect: 0.75 }] }));
  write('game/toy/src/gpl/lerp.mjs', 'export function lerp(a, b, t) {\n  return a + (b - a) * t;\n}\n');
  write('game/toy/src/gpl/spec.json', JSON.stringify({ function: 'lerp', cases: [{ name: 'half', args: [0, 10, 0.5], expect: 5 }] }));
  commit('outside helpers');
  await guard('2.72.0 (d licence): outside code: MIT with a source gets a credit line (CREDITS.md once confirmed); GPL-3.0 is held (not confirmable) until the owner\'s yes, which a worker can\'t record and an agent can\'t without the person\'s words, then confirmed; no licence or an unknown one is refused (fails on 2.71.1: no logic command)', () => {
    const none = logic(`add game/toy/src/ease --name ease-out --task ${taskA} --does "quadratic ease out" --source https://example.org/ease --by claude-b`);
    const unknown = logic(`add game/toy/src/ease --name ease-out --task ${taskA} --does "quadratic ease out" --source https://example.org/ease --licence WTFPL --by claude-b`);
    const mit = logic(`add game/toy/src/ease --name ease-out --task ${taskA} --does "quadratic ease out for tweens" --source https://example.org/ease --licence MIT --author "Ann Example" --by claude-b`);
    const mitConfirm = logic('confirm ease-out --by Dana');
    const credits = (() => { try { return fs.readFileSync(path.join(dir, 'studio/logic-library/CREDITS.md'), 'utf8'); } catch { return ''; } })();
    const gpl = logic(`add game/toy/src/gpl --name lerp-gpl --task ${taskA} --does "linear interpolation" --source https://example.org/lerp --licence GPL-3.0 --by claude-b`);
    const held = mod('lerp-gpl')?.status;
    const early = logic('confirm lerp-gpl --by Dana');
    const yesWorker = logic('licence-yes lerp-gpl --by Pat --permission "Pat said yes in chat at 10:02"', { STUDIO_LOCK_OWNER: 'builder-3' });
    const yesAgent = logic('licence-yes lerp-gpl --by Pat', { CLAUDECODE: '1' });
    const yes = logic('licence-yes lerp-gpl --by Pat --permission "Pat (the owner): yes, GPL is fine for this tool"');
    const late = logic('confirm lerp-gpl --by Dana');
    return [none.status !== 0 && /no licence can't be used/.test(out(none)) && unknown.status !== 0 && /isn't on the library's list/.test(out(unknown))
      && mit.status === 0 && mod('ease-out')?.credit === 'ease-out: code from https://example.org/ease (MIT), by Ann Example; keep its licence notice with the code' && mitConfirm.status === 0 && credits.includes('- ease-out: code from https://example.org/ease (MIT), by Ann Example')
      && gpl.status === 0 && held === 'licence-hold' && /copyleft/.test(out(gpl)) && early.status !== 0 && /needs the owner's yes first/.test(out(early))
      && yesWorker.status !== 0 && /worker/.test(out(yesWorker)) && yesAgent.status !== 0 && /permission/.test(out(yesAgent))
      && yes.status === 0 && /tier C/.test(out(yes)) && mod('lerp-gpl')?.licenceYes?.tier === 'C' && late.status === 0 && mod('lerp-gpl')?.status === 'confirmed',
    [none, unknown, mit, mitConfirm, gpl, early, yesWorker, yesAgent, yes, late].map(out).join('\n---\n') + `\n${credits}`];
  });

  // ---- stale ----
  await guard('2.72.0 (d stale): `logic -- list` flags a module no game used for STUDIO_LOGIC_STALE_DAYS (default 90) as STALE; a longer setting, or `logic -- use <name> --game <game>`, clears it; the example is never flagged (fails on 2.71.1: no logic command)', () => {
    const p = path.join(dir, 'studio/logic-library/library.json');
    const l = lib();
    const m = l.modules.find((x) => x.name === 'ease-out');
    m.landedAt = new Date(Date.now() - 120 * 86400000).toISOString();
    m.addedAt = m.landedAt;
    fs.writeFileSync(p, `${JSON.stringify(l, null, 2)}\n`);
    const stale = logic('list');
    const longer = logic('list', { STUDIO_LOGIC_STALE_DAYS: '365' });
    const use = logic('use ease-out --game toy-two --by claude-c');
    const fresh = logic('list');
    const line = (r) => (out(r).split('\n').find((x, i, a) => /^ {6}/.test(x) && /ease-out/.test(a[i - 1] || '')) || '');
    const exLine = (r) => (out(r).split('\n').find((x, i, a) => /^ {6}/.test(x) && /example-step-toward/.test(a[i - 1] || '')) || '');
    return [/STALE: no game used it for 90\+ days/.test(line(stale)) && !/STALE/.test(exLine(stale)) && !/STALE/.test(line(longer)) && use.status === 0 && !/STALE/.test(line(fresh)) && /uses: toy-two/.test(line(fresh)), [stale, longer, use, fresh].map(out).join('\n---\n')];
  });

  // ---- check (the language-neutral spec) ----
  write('ports/step-toward-wrong.mjs', 'export function stepToward(value, target, maxStep) {\n  return value + maxStep;\n}\n');
  await guard('2.72.0 (d check): `logic -- check <name>` runs the module\'s language-neutral spec.json on its code (5 cases pass for the example) and on a port (--impl), where a wrong port fails naming the case (fails on 2.71.1: no logic command)', () => {
    const okRun = logic('check example-step-toward');
    const bad = logic(`check example-step-toward --impl ${path.join('ports', 'step-toward-wrong.mjs')}`);
    return [okRun.status === 0 && /5 case\(s\) pass/.test(out(okRun)) && bad.status !== 0 && /FAIL never overshoots the target: got 13, expected 10/.test(out(bad)), `${out(okRun)}\n---\n${out(bad)}`];
  });

  // ---- shards ----
  const selftestSrc = (() => { try { return fs.readFileSync(path.join(dir, 'qa', 'selftest.mjs'), 'utf8'); } catch { return ''; } })();
  const hasShards = /function inShard\(/.test(selftestSrc);
  // Without the shard code an unknown flag would run the whole self-test: only ask a self-test that has it.
  const listOf = (n) => {
    if (!hasShards) return { status: 1, json: null, text: 'qa/selftest.mjs has no shards (no inShard)' };
    const r = run(dir, `node qa/selftest.mjs --list-shards ${n}`, base);
    let json = null;
    try { json = JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch {}
    return { status: r.status, json, text: out(r).slice(-1500) };
  };
  await guard('2.72.0 (d shards): `qa/selftest.mjs --list-shards 4` puts every unit (each top-level block, each gate\'s sabotage) in exactly one shard, every shard has units, the split is the same twice, the owner-key group (267g, 270v) shares a shard, no check runs outside a unit, every top-level block starts with the guard; 1 shard holds all and 3 shards hold the same units (fails on 2.71.1: no shards)', () => {
    const a = listOf(4);
    const b = listOf(4);
    const one = listOf(1);
    const three = listOf(3);
    const units = a.json?.units || [];
    const labels = units.map((u) => u.label);
    const per = [1, 2, 3, 4].map((i) => units.filter((u) => u.shard === i).length);
    const owner = units.filter((u) => u.group === 'owner-key');
    const bare = selftestSrc.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /^\{\s*$/.test(l));
    const sab = units.filter((u) => /^sabotage:/.test(u.label)).length;
    return [a.status === 0 && units.length > 150 && new Set(labels).size === labels.length && units.every((u) => [1, 2, 3, 4].includes(u.shard)) && per.every((c) => c > 0)
      && JSON.stringify(a.json) === JSON.stringify(b.json) && owner.length === 2 && owner[0].shard === owner[1].shard && (a.json.strays || []).length === 0 && bare.length === 0 && sab >= 10
      && labels.includes('control') && labels.includes('selftest-272d') && one.json?.units.every((u) => u.shard === 1) && JSON.stringify(three.json?.units.map((u) => u.label)) === JSON.stringify(labels),
    `${a.text.slice(0, 600)}\nper shard ${per}\nbare blocks ${JSON.stringify(bare.slice(0, 5))}\nowner ${JSON.stringify(owner)}`];
  });

  await guard('2.72.0 (d shard run): `--shard 0/4`, `--shard 5/4` and `--list-shards 0` are refused (exit 2); a shard holding only the hash unit runs that unit\'s checks and no other, and says so; a shard past the last unit fails as empty (fails on 2.71.1: no shards)', () => {
    if (!hasShards) return [false, 'qa/selftest.mjs has no shards (no inShard)'];
    const bad = ['--shard 0/4', '--shard 5/4', '--shard x', '--list-shards 0'].map((f) => run(dir, `node qa/selftest.mjs ${f}`, base));
    const keys = listOf(1).json?.units || [];
    const n = new Set(keys.map((u) => (u.group ? `g:${u.group}` : u.label))).size;
    const k = listOf(n).json?.units.find((u) => u.label === 'hashes')?.shard;
    const one = run(dir, `node qa/selftest.mjs --shard ${k}/${n}`, base);
    const empty = run(dir, `node qa/selftest.mjs --shard ${n + 1}/${n + 1}`, base);
    const passes = (out(one).match(/^\[selftest\] PASS /gm) || []).length;
    return [bad.every((r) => r.status === 2) && one.status === 0 && passes >= 3 && /PASS the display hash is standard FNV-1a 64-bit/.test(out(one)) && !/control: gate/.test(out(one)) && new RegExp(`shard ${k}/${n}: ran 1 of ${keys.length} unit\\(s\\)`).test(out(one))
      && empty.status !== 0 && /has no unit: it checked nothing/.test(out(empty)), `${bad.map((r) => r.status)}\n${out(one).slice(-800)}\n---\n${out(empty).slice(-400)}`];
  });

  // ---- run-gates --except ----
  await guard('2.72.0 (d except): `run-gates --except <ids>` leaves those gates out and names them as skipped (--except); the run is partial (its record says so); an id that isn\'t a gate is refused (fails on 2.71.1: --except was ignored and every gate ran)', () => {
    // Two cheap gates stand for the studio's list, so the run without --only stays short; put back after.
    const gf = path.join(dir, 'studio', 'gates.json');
    const kept = fs.readFileSync(gf, 'utf8');
    const two = JSON.parse(kept).gates.filter((x) => ['secrets', 'docs'].includes(x.id));
    let r; let rec; let full; let typo;
    try {
      fs.writeFileSync(gf, JSON.stringify({ gates: two }, null, 2));
      for (const f of ['gates-last.json', 'gates-last-full.json']) fs.rmSync(path.join(dir, '.studio', f), { force: true });
      r = run(dir, 'node scripts/run-gates.mjs --required-only --deep --except docs', base);
      rec = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, '.studio/gates-last.json'), 'utf8')); } catch { return null; } })();
      full = fs.existsSync(path.join(dir, '.studio', 'gates-last-full.json'));
      typo = run(dir, 'node scripts/run-gates.mjs --required-only --except selftst', base);
    } finally { fs.writeFileSync(gf, kept); }
    return [two.length === 2 && r.status === 0 && /skipped docs \(--except\)/.test(out(r)) && /PASS\s+secrets/.test(out(r)) && !/PASS\s+docs/.test(out(r)) && rec?.partial === true && !full && typo.status === 2 && /not a gate: selftst/.test(out(typo)), `${out(r).slice(-1200)}\n${JSON.stringify(rec)?.slice(0, 300)} full=${full}\n---\n${out(typo).slice(-300)}`];
  });

  // ---- CI ----
  await guard('2.72.0 (d ci): CI runs the release checks without the self-test (release.mjs / run-gates --except selftest, Linux and Windows), the self-test in N parallel shard jobs on each (node qa/selftest.mjs --shard ${{ matrix.shard }}/N, shards 1..N, both Node versions on Linux), and a summary job that needs all of them and fails unless each succeeded (fails on 2.71.1: one serial self-test)', () => {
    const ci = fs.readFileSync(path.join(dir, '.github/workflows/ci.yml'), 'utf8').replace(/\r\n/g, '\n');
    const jobs = Object.fromEntries([...(ci.split(/^jobs:\n/m)[1] || '').matchAll(/^ {2}([a-z0-9-]+):\n((?: {4}.*\n|\n)*)/gm)].map((m) => [m[1], m[2]]));
    const shardJob = (name) => {
      const b = jobs[name] || '';
      const N = Number((b.match(/node qa\/selftest\.mjs --shard \$\{\{ matrix\.shard \}\}\/(\d+)/) || [])[1]);
      const list = ((b.match(/shard: \[([\d, ]+)\]/) || [])[1] || '').split(',').map((x) => Number(x.trim()));
      return N >= 2 && JSON.stringify(list) === JSON.stringify(Array.from({ length: N }, (_, i) => i + 1)) && /fail-fast: false/.test(b);
    };
    const sum = jobs['release-gate-summary'] || '';
    return [/node scripts\/release\.mjs --except selftest/.test(jobs['release-gate'] || '') && /run-gates\.mjs --required-only --deep --except selftest/.test(jobs.windows || '')
      && shardJob('release-gate-selftest') && /node: \['22', '24'\]/.test(jobs['release-gate-selftest'] || '') && shardJob('windows-selftest') && /runs-on: windows-latest/.test(jobs['windows-selftest'] || '')
      && /needs: \[release-gate, release-gate-selftest, windows, windows-selftest\]/.test(sum) && /if: always\(\)/.test(sum) && /!= "success"/.test(sum) && /exit 1/.test(sum),
    Object.keys(jobs).join(', ')];
  });
  void hasLib;
}
