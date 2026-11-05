/**
 * qa/selftest-2773d.mjs — 2.77.3 (d): the crew's board and hold bugs.
 *   H3 / B-113  a builder task added with no folders "worked on the whole game" and blocked every launch.
 *   H4 / B-114  "T-124 waiting on T-152: 14 commits not merged" after T-152 landed through a rescue (new hashes).
 *   H5          a Producer unparked tasks the orchestrator had parked.
 *   M1 / B-115  a builder's stop cooldown also refused a reviewer; its time was local, not UTC.
 *   M2          `task add` named one missing flag at a time.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest2773D({ dir, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = path.join(harnessRoot, 'node_modules');
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const base = { STUDIO_MAIN_ROOT: '', STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '', STUDIO_TASK_BASE: '', STUDIO_PROTECT_BASE: '', STUDIO_GAME: '' };
  let n = 0;
  const studio = (name) => {
    const S = path.join(tmpRoot, `2773d-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
    const ev = path.join(S, '.studio', 'events-2773d.jsonl'); fs.writeFileSync(ev, '');
    return { S, env: { ...base, AGENT_EVENTS_FILE: ev } };
  };
  const cli = (S, env, args) => spawnSync(process.execPath, ['harness/task.mjs', ...args], { windowsHide: true, cwd: S, encoding: 'utf8', env: { ...process.env, ...ident, ...env }, timeout: 120000 });
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const probe = (S, code, env) => { const f = path.join(S, `.probe-2773d-${++n}.mjs`); fs.writeFileSync(f, code); const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, encoding: 'utf8', env: { ...process.env, ...ident, ...env }, timeout: 120000 }); const l = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop(); let j = null; try { j = JSON.parse(l); } catch {} return { ...r, j }; };
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  const holdsOf = (S) => { try { return JSON.parse(fs.readFileSync(path.join(S, 'studio', 'task-holds.json'), 'utf8')).tasks || {}; } catch { return {}; } };

  // ---- H3 ----
  {
    const { S, env } = studio('h3');
    const e = { ...env, STUDIO_REQUIRE_LANE: 'on' };
    const bare = cli(S, e, ['add', 'Wire the spawn table', '--role', 'builder']);
    const whole = cli(S, e, ['add', 'Rework the whole loop', '--role', 'builder', '--lane', 'all']);
    const lane = cli(S, e, ['add', 'Tune the tide table', '--role', 'builder', '--lane', 'game/x/src/tide']);
    let wholeId = ''; try { wholeId = JSON.parse(whole.stdout).id; } catch {}
    let laneId = ''; try { laneId = JSON.parse(lane.stdout).id; } catch {}
    const set = laneId ? cli(S, e, ['lane', laneId, 'game/x/src/a', 'game/x/src/b', '--by', 'producer-1']) : { stdout: '', stderr: 'no id' };
    const r = probe(S, `import { laneOf } from ${u(S, 'harness/task-hold.mjs')};
console.log(JSON.stringify({ whole: laneOf(${JSON.stringify(wholeId)}), lane: laneOf(${JSON.stringify(laneId)}) }));`, e);
    await guard('2.77.3 (H3): a builder task added with no folders is refused with "pass --lane <folders>"; --lane all is the whole game on purpose; task lane <ID> <folder> <folder> sets two folders (fails on 2.77.2: the bare add was queued and counted as the whole game)', () => [
      bare.status !== 0 && /--lane/.test(out(bare)) && whole.status === 0 && lane.status === 0 && set.status === 0 && r.j && r.j.whole === null && r.j.lane === 'game/x/src/a,game/x/src/b',
      JSON.stringify({ bare: out(bare).slice(-300), whole: out(whole).slice(-200), set: out(set).slice(-200), j: r.j })]);
  }

  // ---- H4 ----
  {
    const { S, env } = studio('h4');
    const r = probe(S, `import { handoutBlock, landedOnBoard } from ${u(S, 'harness/handout.mjs')};
const q = { done: [{ id: 'T-152' }, { id: 'T-153' }], inProgress: [], backlog: [] };
const holds = { 'T-124': { after: ['T-152'] }, 'T-125': { after: ['T-153'] } };
const branches = { 'T-152': 'lane/builder-agy11', 'T-153': 'lane/builder-agy12' };
const ev = (type, task) => ({ type, task, ts: '2026-11-04T00:00:00Z' });
const events = [ev('task.done', 'T-152'), ev('task.forced', 'T-153')];
const landed = (id) => landedOnBoard(id, events);
console.log(JSON.stringify({ rescued: handoutBlock('T-124', q, { holds, branches, unmerged: () => 14, landed }), forced: handoutBlock('T-125', q, { holds, branches, unmerged: () => 3, landed })?.why || null }));`, env);
    await guard('2.77.3 (H4): a dependency the board closed as done counts as landed whatever the old lane branch\'s hashes say; a forced done with unmerged commits still waits (fails on 2.77.2: "T-124 waiting on T-152: 14 commits not merged")', () => [
      r.j && r.j.rescued === null && /waiting on T-153/.test(r.j.forced || ''), JSON.stringify({ j: r.j, e: out(r).slice(-300) })]);
  }

  // ---- H5 ----
  {
    const { S, env } = studio('h5');
    const add = cli(S, env, ['add', 'Study the pier layouts', '--type', 'study', '--role', 'reference-scout']);
    let id = ''; try { id = JSON.parse(add.stdout).id; } catch {}
    const park = cli(S, { ...env, STUDIO_LOCK_OWNER: 'opus-1' }, ['park', id, '--why', 'needs the owner\'s retype', '--until', 'the owner retypes the C3 approval', '--by', 'opus-1']);
    const low = cli(S, { ...env, STUDIO_ROLE: 'producer', STUDIO_LOCK_OWNER: 'producer-116' }, ['unpark', id, '--by', 'producer-116']);
    const still = Boolean(holdsOf(S)[id]?.parked);
    const same = cli(S, { ...env, STUDIO_LOCK_OWNER: 'opus-1' }, ['unpark', id, '--by', 'opus-1']);
    await guard('2.77.3 (H5): a task the orchestrator parked (with --until "<condition>") is not unparked by a Producer (refusal names who parked it and why, the note shows); the orchestrator can (fails on 2.77.2: the Producer\'s unpark succeeded)', () => [
      park.status === 0 && low.status !== 0 && /opus-1/.test(out(low)) && /needs the owner/.test(out(low)) && /retypes the C3/.test(out(low)) && still && same.status === 0 && !holdsOf(S)[id]?.parked,
      JSON.stringify({ park: out(park).slice(-200), low: out(low).slice(-400), still, same: out(same).slice(-200) })]);
  }

  // ---- M1 ----
  {
    const { S, env } = studio('m1');
    const r = probe(S, `import { cooldown, holdReason } from ${u(S, 'harness/task-hold.mjs')};
const q = { done: [], inProgress: [], backlog: [{ id: 'T-173', role: 'builder', title: 'x' }] };
const until = cooldown('T-173', 'opus-1', 15, 'builder');
const holds = JSON.parse((await import('node:fs')).readFileSync('studio/task-holds.json', 'utf8')).tasks;
console.log(JSON.stringify({ builder: holdReason('T-173', q, Date.now(), holds, 'builder'), reviewer: holdReason('T-173', q, Date.now(), holds, 'reviewer'), until }));`, env);
    await guard('2.77.3 (M1): a builder\'s stop cooldown refuses a builder restart but not a reviewer, and the restart time is UTC (fails on 2.77.2: the reviewer was refused too, and the time was local with no zone)', () => [
      r.j && /can restart after \d\d:\d\d UTC/.test(r.j.builder || '') && r.j.reviewer === null, JSON.stringify({ j: r.j, e: out(r).slice(-300) })]);
  }

  // ---- M2 ----
  {
    const { S, env } = studio('m2');
    fs.mkdirSync(path.join(S, 'studio', 'bible'), { recursive: true });
    fs.writeFileSync(path.join(S, 'studio', 'bible', 'bible.json'), `${JSON.stringify({ signed: { by: 'tester', at: '2026-10-01T00:00:00.000Z' }, phase: { open: 1 }, pillars: [{ name: 'Smoke' }] }, null, 2)}\n`);
    const r = cli(S, { ...env, STUDIO_REQUIRE_LANE: 'on' }, ['add', 'Wire the spawn table', '--role', 'builder']);
    const t = out(r);
    await guard('2.77.3 (M2): task add names every missing flag at once (--phase, --serves, --lane) with the allowed values (fails on 2.77.2: only --phase was named)', () => [
      r.status !== 0 && /--phase 1/.test(t) && /--serves pillar:Smoke/.test(t) && /--lane/.test(t), t.slice(-500)]);
  }
}
