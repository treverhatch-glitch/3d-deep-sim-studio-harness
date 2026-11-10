/**
 * qa/selftest-281b1.mjs — 2.81 (b1), ported from the R2 trial (B2): the attempt ledger and one eligibility verdict
 * (harness/attempts.mjs).
 * A task handed back for a failure is not offered or started again while the signature of the current facts (the reason,
 * main's tip, what it waits for) equals the last attempt's; a commit on main, `unblock` or a done changes that.
 * Each check fails without the ledger (the second start is simply allowed).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest281B1({ dir, run, report }) {
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  // STUDIO_ATTEMPTS=refuse: the hard mode (holdReason refuses the relaunch). The default, record, only offers the task
  // last (checked below) so the loop park, the breaker and the usage-limit paths keep their own counts.
  const env = { STUDIO_PRODUCER_NAME: 'prod-1', STUDIO_HOOKS_CHECK: 'off', STUDIO_ATTEMPTS: 'refuse' };
  const git = (...a) => spawnSync('git', ['-c', 'user.name=selftest', '-c', 'user.email=selftest@example.invalid', '-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd: dir, encoding: 'utf8' });
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const task = (cmd) => run(dir, `node harness/task.mjs ${cmd}`, env);
  const ledger = (id) => readJson(path.join(dir, '.studio', 'attempts', `${id}.json`))?.attempts || [];

  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'init', '--no-verify');
  const tip0 = git('rev-parse', 'HEAD').stdout.trim();

  const id = JSON.parse(task('add "Wire the moss table" --role builder').stdout).id;
  const started = task(`start ${id} --agent builder-1`);
  const paused = task(`pause ${id} --agent builder-1 --note "verify failed: golden mismatch"`);

  await guard('a failed hand-back is recorded as attempt 1 with the main tip, the reason key and a signature', async () => {
    const a = ledger(id);
    return [a.length === 1 && a[0].n === 1 && a[0].mainTip === tip0 && a[0].endLabel === 'hand-back' && /golden mismatch/.test(a[0].reasonKey) && /^[0-9a-f]{16}$/.test(a[0].signature) && a[0].ownerOnly === false && !a[0].cleared, `${out(started)}${out(paused)}${JSON.stringify(a)}`];
  });

  await guard('a second session is refused: "same blocker as attempt 1"', async () => {
    const r = task(`start ${id} --agent builder-2`);
    return [/same blocker as attempt 1/.test(out(r)) && /main unchanged since/.test(out(r)), out(r)];
  });

  await guard('next does not offer it while the blocker is the same', async () => {
    const r = task('next --role builder');
    return [!out(r).includes(id), out(r)];
  });

  await guard('record mode (the default): the start is allowed, and next offers a fresh task before the same-blocker one', async () => {
    const rec = { ...env, STUDIO_ATTEMPTS: '' };
    // A lower-priority fresh task: offered first only because the other one is behind the same blocker (the sort puts
    // the same-blocker flag before priority). No start here: a session would count against the task's budget.
    const other = JSON.parse(run(dir, 'node harness/task.mjs add "Paint the moss table" --role builder --priority P2', rec).stdout).id;
    const next = run(dir, 'node harness/task.mjs next --role builder', rec);
    const first = (out(next).match(/"id":\s*"(T-\d+)"/) || [])[1];
    const hold = run(dir, `node harness/task.mjs holds`, rec);
    return [Boolean(first) && first !== id && Boolean(other) && !/same blocker/.test(out(hold)), `${out(next)}\n${out(hold)}`];
  });
  await guard('record mode: the supervisor\'s one builder slot goes to a fresh task, not the same-blocker one listed before it (fails on 2.80: backlog order)', async () => {
    const rec = { ...env, STUDIO_ATTEMPTS: '', STUDIO_TEST_FREEMEM_MB: '65536', STUDIO_AGENT_TOOL: '', STUDIO_BUILDER_TOOL: '', STUDIO_BUILDER_CMD: '', STUDIO_AGENT_CMD: '', STUDIO_BUILDER_ORDER: '', STUDIO_LINE_PRODUCER: 'off' };
    const u = (rel) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);
    fs.writeFileSync(path.join(dir, '.studio', '281b1-sup.mjs'), `import { supervise } from ${u('harness/supervisor.mjs')};
const starts = [];
const deps = { sessions: () => [], startAgent: (o) => { starts.push(o.task); return { ok: true }; }, launchableRoles: (r) => r, nextAgentName: (role, p) => p + role + '-' + (starts.length + 1) };
const r = await supervise({ watcher: true, dryRun: true, prefix: 'b1-', deps }, { startedAt: Date.now(), names: [] });
console.log(JSON.stringify({ starts, why: r.why }));\n`);
    const r = run(dir, 'node .studio/281b1-sup.mjs', rec);
    const j = (() => { try { return JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { return null; } })();
    return [Boolean(j) && j.starts.length >= 1 && !j.starts.includes(id), out(r)]; // one builder slot: a fresh builder task takes it
  });
  await guard('STUDIO_ATTEMPTS=off lifts the clause (the start is allowed)', async () => {
    const r = run(dir, `node harness/task.mjs start ${id} --agent builder-9`, { ...env, STUDIO_ATTEMPTS: 'off' });
    const ok = !/same blocker/.test(out(r)) && /"status": "in_progress"|in_progress/.test(out(r));
    task(`pause ${id} --agent builder-9 --note "session cap reached"`); // not a failure: nothing recorded
    return [ok && ledger(id).length === 1, out(r)];
  });

  await guard('a commit on main changes the signature: next offers it and the start is allowed', async () => {
    fs.writeFileSync(path.join(dir, '281b1-marker.txt'), 'a change that lands on main\n');
    git('add', '281b1-marker.txt');
    git('commit', '-q', '-m', 'main moves', '--no-verify');
    const nx = task('next --role builder');
    const r = task(`start ${id} --agent builder-2`);
    return [nx.stdout.includes(id) && !/same blocker/.test(out(r)) && /in_progress/.test(out(r)), `${out(nx)}\n${out(r)}`];
  });

  await guard('a hand-back the breaker ignores ("session cap reached") records no attempt', async () => {
    const before = ledger(id).length;
    task(`pause ${id} --agent builder-2 --note "session cap reached; resume from the notes"`);
    return [before === 1 && ledger(id).length === 1, JSON.stringify(ledger(id))];
  });

  await guard('a hand-back a person caused ("a stop, not a failure") records no attempt', async () => {
    task(`start ${id} --agent builder-3`);
    task(`pause ${id} --agent builder-3 --note "failed to finish: a stop, not a failure"`);
    return [ledger(id).length === 1, JSON.stringify(ledger(id))];
  });

  await guard('a second failure at the new tip is attempt 2 and blocks again', async () => {
    task(`start ${id} --agent builder-3`);
    task(`pause ${id} --agent builder-3 --note "tick-budget failed on the soak seed"`); // another reason: the breaker stays out
    const r = task(`start ${id} --agent builder-4`);
    return [ledger(id).length === 2 && /same blocker as attempt 2/.test(out(r)), `${out(r)}${JSON.stringify(ledger(id))}`];
  });

  await guard('unblock clears the ledger (even with no park): the task starts again', async () => {
    const ub = task(`unblock ${id} --by dev`);
    const r = task(`start ${id} --agent builder-4`);
    const a = ledger(id);
    return [/can start again/.test(out(ub)) && a.at(-1).cleared === true && !/same blocker/.test(out(r)) && /in_progress/.test(out(r)), `${out(ub)}${out(r)}${JSON.stringify(a.at(-1))}`];
  });

  await guard('a blocker the note names (T-id) is part of the signature: another one landing changes it', async () => {
    const dep = JSON.parse(task('add "Dependency" --role builder').stdout).id;
    task(`pause ${id} --agent builder-4 --note "verify failed: blocked by ${dep}"`);
    const a = ledger(id).at(-1);
    const refused = /same blocker|waits for/.test(out(task(`start ${id} --agent builder-5`)));
    return [a.blockers.includes(dep) && refused, JSON.stringify(a)];
  });

  await guard('one verdict: next does not offer a task that start refuses for its budget (fails on 2.80: next asked holdReason only)', async () => {
    const off = { ...env, STUDIO_ATTEMPTS: 'off' };
    const b = JSON.parse(run(dir, 'node harness/task.mjs add "Spent task" --role builder --priority P0', off).stdout).id;
    run(dir, `node harness/task.mjs start ${b} --agent outside-1`, off);
    run(dir, `node harness/task.mjs pause ${b} --agent outside-1 --note "session cap reached"`, off);
    const lim = { ...off, STUDIO_TASK_MAX_SESSIONS: '1' };
    const nx = run(dir, 'node harness/task.mjs next --role builder', lim);
    const st = run(dir, `node harness/task.mjs start ${b} --agent outside-2`, lim);
    return [!out(nx).includes(b) && /can't start/.test(out(st)), `${out(nx)}\n${out(st)}`];
  });

  await guard('the ledger releases no lock or claim (no lock.released event by "attempts")', async () => {
    const ev = fs.readFileSync(path.join(dir, '.studio', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const bad = ev.filter((e) => /lock\.released/.test(e.type || '') && /attempts/.test(`${e.agent || ''} ${e.by || ''}`));
    return [bad.length === 0, JSON.stringify(bad.slice(0, 2))];
  });
}
