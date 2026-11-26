/**
 * qa/selftest-299f.mjs — 2.99 (f): a session's brief shows the first 8 open checklist items and the way to hand on work
 * in slices; a task over task.checklistSplitAt open items is advised to the producer once (0 = off); a hand-back with no
 * commit and no item done says so.
 * Scaffolding as qa/selftest-295d.mjs (a studio copy, the real task and ask commands, an injected disk reading).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { eventsOf as eventsFileOf, fileUrlOf as fileUrlRelSOf, gEnvOf, gitUserCrlfOf, guardCap3000Of, out, writeIn as write } from './kit.mjs';

export async function selftest299F({ dir, report, tmpRoot }) {
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = gitUserCrlfOf(gEnvOf(ident));
  const guard = guardCap3000Of(report);
  const clean = {};
  // Windows: the helpers below get a cut-down environment; PowerShell (used to read a process's start time and to list a
  // process tree) needs Windows' own system variables, which any real shell has. Pass those through as they are.
  if (process.platform === 'win32') for (const k of Object.keys(process.env)) if (/^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|COMPUTERNAME|HOMEDRIVE|HOMEPATH|USERNAME)$/i.test(k)) clean[k] = process.env[k];
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-299f-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };

  const S = path.join(tmpRoot, `299f-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json', 'studio/asks', 'studio/handoffs']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  write(S, 'studio/game.json', '{}\n');
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-299f.jsonl');
  const envOf = () => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S });
  const evs = eventsFileOf(evFile);
  const u = fileUrlRelSOf(S);
  let pn = 0;
  const probe = (code) => {
    const f = path.join(S, `.probe-299f-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: envOf(), encoding: 'utf8', timeout: 240000 });
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return JSON.parse(l); } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const cli = (file, args) => spawnSync(process.execPath, [path.join(S, 'harness', file), ...args], { windowsHide: true, cwd: S, env: envOf(), encoding: 'utf8', timeout: 120000 });
  const task = (args) => cli('task.mjs', args);
  const J = (x) => JSON.stringify(x).slice(0, 2000);
  const addTask = (title) => (task(['add', title, '--role', 'producer']).stdout.match(/"id":\s*"([^"]+)"/) || [])[1] || null;
  const items = (id, n) => probe(`import { changeChecklist } from ${u('harness/task-checklist.mjs')};
const r = changeChecklist(${JSON.stringify(id)}, 'add', Array.from({ length: ${n} }, (_, i) => 'Item ' + (i + 1)));
console.log(JSON.stringify({ ok: r.ok }));`);
  const brief = (id) => { try { return fs.readFileSync(path.join(S, '.studio', 'briefs', `${id}.md`), 'utf8'); } catch { return ''; } };
  const splitEvents = (id) => evs().filter((e) => e.type === 'task.split_advised' && e.task === id);
  const handoff = (id) => { try { return fs.readFileSync(path.join(S, 'studio', 'handoffs', `${id}.md`), 'utf8'); } catch { return ''; } };
  const pause = (id, o) => probe(`import { pauseTask } from ${u('harness/task.mjs')};
const r = pauseTask(${JSON.stringify(id)}, 'porter-x', 'Stopped for now.', { force: true, ${o} });
console.log(JSON.stringify({ ok: Boolean(r) }));`);

  try {
    // ---- 1. the brief, and the advice to split ----
    const [tA, tB, tD, tE1, tE2, tE3, tE4] = ['Port Fees rounding', 'Port MapNav costs', 'Port Game/Sim ticks', 'Port queue ordering', 'Port save format', 'Port tools/SimTests runner', 'Port port/main hooks'].map(addTask);
    items(tA, 12);
    const sA = task(['start', tA, '--agent', 'porter-a']);
    const bA = brief(tA);
    const sB = task(['start', tB, '--agent', 'porter-b']);
    const bB = brief(tB);
    await guard('2.99 (f1) the brief of a task with 12 open checklist items shows the first 8 and the count of the rest (4), and says: one item at a time, commit and mark each, queue the committed work as a slice rather than hand back with nothing (fails before this fix: the whole list was in the brief and no word about slices)', () => [
      sA.status === 0 && Array.from({ length: 8 }, (_, i) => `[ ] Item ${i + 1}\n`).every((x) => bA.includes(x)) && !/\[ \] Item 9\b/.test(bA) && /and 4 more open/.test(bA)
        && /Work one item at a time/.test(bA) && new RegExp(`checklist ${tA} done`).test(bA) && new RegExp(`done ${tA} --agent <you> --train --slice`).test(bA) && /rather than handing back with nothing/.test(bA),
      J({ start: out(sA).slice(-300), brief: bA.slice(0, 1500) })]);
    await guard('2.99 (f1) the brief of a task with no checklist has no checklist paragraph (guard)', () => [sB.status === 0 && bB.length > 100 && !/## Checklist/.test(bB) && !/Work one item at a time/.test(bB), J({ start: out(sB).slice(-300), brief: bB.slice(0, 400) })]);

    const adv1 = splitEvents(tA);
    task(['pause', tA, '--agent', 'porter-a', '--note', 'back to the queue']);
    const again = task(['start', tA, '--agent', 'porter-a']);
    const show = task(['show', tA]);
    await guard('2.99 (f2) a task with 12 open items (over the default 8) is told to the producer once, as an event and a line (`split <ID> --every 8`), and starting it again with the same 12 open does not say it again; `task show` carries the line (fails before this fix: the producer was never told)', () => [
      adv1.length === 1 && adv1[0].to === 'producer' && adv1[0].msg === `${tA} has 12 open items: split it (\`npm run task -- split ${tA} --every 8\`)` && again.status === 0 && splitEvents(tA).length === 1 && show.stdout.includes(`${tA} has 12 open items`) && splitEvents(tB).length === 0,
      J({ adv1, after: splitEvents(tA).length, again: out(again).slice(-200) })]);

    const setAt = (n) => write(S, 'studio/game.json', `${JSON.stringify({ task: { checklistSplitAt: n } })}\n`);
    const [tD2, tD3] = ['Port Fees refunds', 'Port MapNav links'].map(addTask);
    for (const t of [tD, tD2, tD3]) items(t, 20);
    setAt(0);
    const sD = task(['start', tD, '--agent', 'porter-d']);
    setAt(20);
    task(['start', tD2, '--agent', 'porter-d2']);
    setAt(5);
    task(['start', tD3, '--agent', 'porter-d3']);
    const five = splitEvents(tD3);
    await guard('2.99 (f3) task.checklistSplitAt 0 turns the advice off, a task with exactly that many open items (20) is not advised, and a lower setting (5) advises with its own number (fails before this fix: no such setting)', () => [
      sD.status === 0 && splitEvents(tD).length === 0 && splitEvents(tD2).length === 0 && five.length === 1 && /20 open items: split it .*--every 5/.test(five[0].msg), J({ off: splitEvents(tD), at: splitEvents(tD2), five })]);
    write(S, 'studio/game.json', '{}\n');

    // ---- 2. the hand-back with nothing done ----
    for (const [t, a] of [[tE1, 'p1'], [tE2, 'p2'], [tE3, 'p3'], [tE4, 'p4']]) { items(t, 3); task(['start', t, '--agent', a]); }
    probe(`import { changeChecklist } from ${u('harness/task-checklist.mjs')}; changeChecklist(${JSON.stringify(tE3)}, 'done', ['Item 1']); console.log('{}');`);
    pause(tE1, 'commits: 0');
    pause(tE2, 'commits: 2');
    pause(tE3, 'commits: 0');
    pause(tE4, '');
    const idle = (t) => /left no commit and marked no checklist item/.test(handoff(t));
    await guard('2.99 (f4) a hand-back with no commit and no item done gets one added line naming the first open item; with a commit, with an item done in the session, or when the commit count is unknown it does not (fails before this fix: the next session got no such line)', () => [
      idle(tE1) && /first open item \("Item 1"\)/.test(handoff(tE1)) && !idle(tE2) && !idle(tE3) && !idle(tE4) && handoff(tE1).match(/left no commit/g).length === 1,
      J({ e1: handoff(tE1).slice(-400), e3: handoff(tE3).slice(-200) })]);
  } finally {
    try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the OS cleans its temp folder */ }
  }
}
