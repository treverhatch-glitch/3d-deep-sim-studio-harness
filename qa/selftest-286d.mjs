/**
 * qa/selftest-286d.mjs — 2.86 (d): sessions that end for the harness's reasons do not cost the task.
 *
 *   1  the refresh rule is relative to where a session starts its work (harness/session-cap.mjs): a session whose brief
 *      and first reads fill 68 % of the window is not handed off before it has done work, nor until it has used the room
 *      the percentage gives; past the new threshold it is; a studio's own percentage (85) keeps a sensible meaning
 *   2  one reading of why a session ended (harness/handback-kind.mjs): refresh hand-offs with no work, launch failures and
 *      `task done` refusals for commits that are not the task's own count toward no park, hold, breaker or budget; real
 *      hand-backs still do; the scorecard's tally shows the harness kinds
 *   3  a claim whose session is gone is dropped: the lane-copy "still working" reading ignores an ended session, a claim
 *      the harness kept after the end is released by the sweep and taken by the next start; a train-queued task's claim
 *      and an outside owner's claim are untouched
 *   4  a lane session's command carries --add-dir <the main checkout> (not with STUDIO_LANE_ADD_MAIN_DIR=off, not in the
 *      main checkout)
 *   5  the supervisor's halt counts per task and cause: the same task failing twice holds that task (start back-off, one
 *      page), refresh hand-offs never halt, two different tasks failing the same way in a row do halt
 *
 * Each check imports a module from a copy of the repo (a probe script run in the copy).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest286D({ dir, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const gitIn = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3000)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 3000)); } };
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  if (process.platform === 'win32') for (const k of Object.keys(process.env)) if (/^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|COMPUTERNAME|HOMEDRIVE|HOMEPATH|USERNAME)$/i.test(k)) clean[k] = process.env[k];
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: '', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_DRIFT: 'off', STUDIO_WORKTREES: 'off', STUDIO_LANELESS: 'shared', STUDIO_UPGRADE_WATCH_MIN: 'off',
    STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off', STUDIO_DONE_NOOP: 'allow', STUDIO_LINE_PRODUCER: 'off', STUDIO_TELEMETRY: '', STUDIO_CREW_WATCH: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-286d-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };
  let n = 0;
  const made = [];
  const nm = path.join(harnessRoot, 'node_modules');
  const studio = (name, { git = true } = {}) => {
    const S = path.join(tmpRoot, `286d-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(nm, path.join(S, 'node_modules'), 'junction'); } catch { /* the checks need no package */ } }
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    fs.rmSync(path.join(S, '.env'), { force: true });
    const ev = path.join(S, '.studio', 'events-286d.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
    if (git) { gitIn(S, 'init', '-q', '-b', 'main'); gitIn(S, 'add', '-A'); gitIn(S, 'commit', '-qm', 'studio', '--no-verify'); }
    made.push(S);
    return { S, ev, env: { ...base, AGENT_EVENTS_FILE: ev } };
  };
  const events = (ev) => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  const probe = (S, env, code) => {
    const f = path.join(S, `.probe-286d-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 240000 });
    try { fs.rmSync(f, { force: true }); } catch { /* swept with the copy */ }
    const l = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(l), _out: out(r).slice(-1500) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };

  try {
    // ================= 1. the refresh rule starts where the session starts its work =================
    {
      const { S, ev, env } = studio('refresh', { git: false });
      const r = probe(S, env, `const m = await import(${u(S, 'harness/session-cap.mjs')});
const line = (i, ctx, use) => JSON.stringify({ type: 'assistant', message: { id: 'm' + i, usage: { input_tokens: 10, cache_read_input_tokens: ctx, cache_creation_input_tokens: 0 }, content: use ? [use] : [] } });
const edit = { type: 'tool_use', name: 'Edit', input: { file_path: 'Assets/Sim/Crowd/Crowd.cs', old_string: 'a', new_string: 'b' } };
const commit = { type: 'tool_use', name: 'Bash', input: { command: 'git -C .lanes/engine/T-1 commit -qm "T-1: crowd ported"' } };
// n turns; the brief and first reads reach 136k by turn 12; the first work at turn w (its context: at); the last reading: last.
const log = ({ n = 20, reads = 136000, w = -1, at = reads, last = reads, use = edit }) => Array.from({ length: n }, (_, i) => line(i, i === n - 1 ? last : i === w ? at : Math.min(reads, 20000 + i * 12000), i === w ? use : null)).join('\\n');
const run = (agent, l, env = {}) => { const h = m.heartbeatCheck(agent, { log: l, model: 'claude-opus-5-5', task: 'T-1', role: 'engine-porter', env: { ...process.env, ...env } }); const d = h.decided || null; return d ? { decision: d.decision, why: d.why, start: d.start, threshold: d.threshold, worked: d.worked } : null; };
const fresh = run('porter-fresh', log({}));
const big = run('porter-big', log({ last: 189000 }));
const brim = run('porter-brim', log({ last: 191000 }));
const under = run('porter-under', log({ n: 26, w: 14, at: 136000, last: 170000 }));
const past = run('porter-past', log({ n: 28, w: 14, at: 136000, last: 176000, use: commit }));
const crew85 = run('porter-85', log({ n: 26, w: 14, at: 140000, last: 185000 }), { STUDIO_REFRESH_HANDOFF_PCT: '85' });
const crew85past = run('porter-85b', log({ n: 26, w: 14, at: 140000, last: 192000 }), { STUDIO_REFRESH_HANDOFF_PCT: '85' });
const prog = m.sessionProgress(log({ n: 26, w: 14, at: 136000, last: 170000 }));
console.log(JSON.stringify({ fresh, big, brim, under, past, crew85, crew85past, prog: { worked: prog.worked, startContext: prog.startContext } }));`);
      const dec = events(ev).filter((e) => e.type === 'agent.refresh.decided');
      const decOf = (a) => dec.filter((e) => e.agent === a).map((e) => e.meta).pop() || {};
      await guard('2.86 (d1): a session whose brief and first reads fill 68 % of the window (136k of 200k) and that has done no work (no commit, no file edit) is not handed off for its context, at 136k nor at 189k (STUDIO_REFRESH_SAFETY_PCT 5: only within 5 % of the window, 191k, does it hand off) (fails before this fix: "hand off now" at 136k, 68 % of the window over 60 %, three times in eight minutes in a crew\'s log)', () => [
        r.fresh?.decision === 'continue' && r.fresh.worked === false && r.big?.decision === 'continue' && r.brim?.decision === 'handoff' && /STUDIO_REFRESH_SAFETY_PCT/.test(r.brim.why || ''),
        JSON.stringify(r).slice(0, 2500)]);
      await guard('2.86 (d1): a session that started its work (its first file edit) at 136k continues at 170k, under start + 60 % of the room left (174k), and hands off at 176k after its first commit; agent.refresh.decided says the start (136k), the threshold (174k), the reading and that it worked (fails before this fix: handed off at 170k, 85 % of the window; the event had no start or threshold)', () => [
        r.under?.decision === 'continue' && r.under.start === 136010 && r.under.threshold === 174404 && r.past?.decision === 'handoff' && /started its work at 136k/.test(r.past.why || '')
          && decOf('porter-past').start === 136010 && decOf('porter-past').threshold === 174404 && decOf('porter-past').reading === 176010 && decOf('porter-past').worked === true
          && r.prog?.worked === true && r.prog.startContext === 136010,
        JSON.stringify({ r, past: decOf('porter-past') }).slice(0, 2500)]);
      await guard('2.86 (d1): a studio\'s own STUDIO_REFRESH_HANDOFF_PCT=85 keeps a sensible meaning: 85 % of the room left after the start (start 140k: hand off at 191k), so 185k continues and 192k hands off (fails before this fix: 185k, 92.5 % of the window, handed off)', () => [
        r.crew85?.decision === 'continue' && r.crew85.threshold === 191002 && r.crew85past?.decision === 'handoff',
        JSON.stringify({ crew85: r.crew85, crew85past: r.crew85past })]);
    }

    // ================= 2. one reading of why a session ended =================
    {
      const { S, env } = studio('kinds', { git: false });
      const r = probe(S, env, `import { loopHandBacks } from ${u(S, 'harness/busy.mjs')};
import { handBackKind, handBackTally, harnessKindWords, sameRefusalAgain } from ${u(S, 'harness/handback-kind.mjs')};
import { taskSpend } from ${u(S, 'harness/task-budget.mjs')};
import { crewHealth } from ${u(S, 'harness/crew-watch.mjs')};
import { sessionOutcome } from ${u(S, 'harness/session-outcome.mjs')};
import { launchFailure } from ${u(S, 'harness/agent.mjs')};
const M = 60000; const t0 = Date.parse('2026-11-13T19:00:00Z'); const iso = (t) => new Date(t).toISOString();
let k = 0;
const ev = (at, type, agent, task, msg, meta) => ({ id: 'e' + (++k), ts: iso(t0 + at * M), type, agent, task, msg, ...(meta ? { meta } : {}) });
// One session: start, claim, (a refusal), hand-back, end. kind: refresh-no-work | launch | foreign | real.
const session = (agent, task, at, kind) => {
  const st = [ev(at, 'agent.session.start', agent, task, agent + ' started', { role: 'engine-porter', tool: 'claude' }), ev(at + 0.2, 'task.start', agent, task, 'Picked up ' + task)];
  if (kind === 'foreign') st.push(ev(at + 2, 'task.not_done', agent, task, task + ' not done yet: the hooks check failed for 1 commit(s) that are not ' + task + "'s own (cf9efbe)", { refusal: ['hooks'], foreign: ['cf9efbe'] }));
  const note = kind === 'refresh-no-work' ? agent + ' (claude, claude-opus-5-5) refreshed: handed off at a refresh check by the rule: context 139,730 tokens is past 120k. No uncommitted work. A fresh session continues from this hand-back.'
    : kind === 'launch' ? agent + ' (claude, claude-opus-5-5) stopped: it never got going (launch failure: it stopped on a permission prompt (requested permissions to read); exit code 1). No uncommitted work. Picked up by the launcher.'
    : kind === 'foreign' ? 'Done: nothing new; the branch is complete | Failed/tried: task done refused by the hooks check for a board commit on main'
    : 'Failed: verify red on golden (seed 3, tick 120) after the crowd port';
  const paused = ev(at + 3, 'task.paused', agent, task, 'Handed back ' + task + ': ' + note);
  const outcome = sessionOutcome({ agent, task, startedAt: iso(t0 + at * M), events: [...st, paused], commits: kind === 'real' ? 1 : 0, counts: kind === 'real' || kind === 'foreign' });
  const meta = { role: 'engine-porter', tool: 'claude', code: kind === 'real' || kind === 'foreign' ? 0 : 1, outcome,
    ...(kind === 'refresh-no-work' ? { refreshed: true, refreshNoWork: true, reason: 'refreshed (session cap): a fresh session continues', exitCause: { kind: 'refresh', ranSec: 180 } } : {}),
    ...(kind === 'launch' ? { launchFailure: { why: 'it stopped on a permission prompt (requested permissions to read)' }, exitCause: { kind: 'exit', ranSec: 20 } } : {}) };
  return [...st, paused, ev(at + 3.1, 'agent.session.end', agent, task, agent + ' ended', meta)];
};
const harnessEvs = [...session('engine-porter-s303', 'T-1', 0, 'refresh-no-work'), ...session('engine-porter-s303', 'T-1', 4, 'refresh-no-work'), ...session('engine-porter-s303', 'T-1', 8, 'refresh-no-work'),
  ...session('builder-s1', 'T-2', 10, 'launch'), ...session('builder-s2', 'T-2', 15, 'launch'), ...session('builder-s3', 'T-2', 20, 'launch'),
  ...session('builder-s4', 'T-3', 25, 'foreign'), ...session('builder-s5', 'T-3', 30, 'foreign'), ...session('builder-s6', 'T-3', 35, 'foreign'),
  ev(36, 'agent.start_refused', 'engine-porter-40', 'T-1', 'Not started: no lane copy could be made for engine-porter-40 (.lanes/engine-porter-40 is still in use; not replacing it).', { role: 'engine-porter', dir: '.lanes/engine-porter-40', error: '.lanes/engine-porter-40 is still in use; not replacing it' })];
const realEvs = [...session('builder-r1', 'T-4', 40, 'real'), ...session('builder-r2', 'T-4', 50, 'real'), ...session('builder-r3', 'T-4', 60, 'real')];
const flow = ev(45, 'task.paused', 'director', 'T-5', "Handed back T-5: The claim ran out with no running session on it: handed back by the Director's flow pass so a free builder can take it.");
const ready = ev(46, 'task.paused', 'builder-r9', 'T-6', 'Handed back T-6: all checks green; ready for the unity train, branch unity/t-6');
const all = [...harnessEvs, ...realEvs, flow, ready].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
const kindsOf = (task) => all.filter((e) => e.type === 'task.paused' && e.task === task).map((e) => handBackKind(e, all));
const loop = Object.fromEntries(['T-1', 'T-2', 'T-3', 'T-4'].map((t) => [t, loopHandBacks(t, all, { since: t0 - M }).length]));
const spend = Object.fromEntries(['T-1', 'T-2', 'T-3', 'T-4'].map((t) => { const s = taskSpend(t, all, t0 + 70 * M); return [t, { sessions: s.sessions, minutes: s.minutes }]; }));
const ends = all.filter((e) => e.type === 'agent.session.end' && e.task === 'T-3');
const sameAgain = sameRefusalAgain(ends[1], all);
const crew = crewHealth(harnessEvs, { now: t0 + 37 * M, env: {} });
const tally = handBackTally(all, { from: 0, to: Infinity });
const foreignOutcome = ends[0].meta.outcome;
const lf = {
  perm: launchFailure({ code: 1, tool: 'claude', log: '{"type":"system","subtype":"init"}\\nClaude requested permissions to read from C:\\\\studio-main, but you haven\\'t granted it yet.' }),
  noTurn: launchFailure({ code: 1, tool: 'claude', log: '{"type":"system","subtype":"init"}' }),
  aider: launchFailure({ code: 1, tool: 'aider', log: 'Error: the model is not found' }),
  crash: launchFailure({ code: 1, tool: 'claude', log: 'Error: build failed: 3 type errors' }),
  refresh: launchFailure({ code: 1, tool: 'claude', capped: true, log: '{"type":"system"}' }),
  stall: launchFailure({ code: 1, tool: 'claude', exit: { killedBy: { kind: 'stall' } }, log: '{"type":"system"}' }),
  worked: launchFailure({ code: 1, tool: 'claude', log: JSON.stringify({ type: 'assistant', message: { id: 'a', content: [] } }) }),
};
console.log(JSON.stringify({ kinds: { T1: kindsOf('T-1'), T2: kindsOf('T-2'), T3: kindsOf('T-3'), T4: kindsOf('T-4'), T5: kindsOf('T-5'), T6: kindsOf('T-6') }, loop, spend, sameAgain, crew: { noCommit: crew['engine-porter']?.noCommit ?? 0, shortExits: (crew['engine-porter']?.shortExits ?? 0) + (crew.builder?.shortExits ?? 0), builderNoCommit: crew.builder?.noCommit ?? 0 }, tally, words: harnessKindWords(tally.harness), foreignOutcome, lf }));`);
      await guard('2.86 (d2): three refresh hand-offs with no work on one task in two hours are kind "refresh-no-work": the watchdog\'s count (busy.mjs loopHandBacks) is 0, so nothing is parked, and the task\'s budget shows 0 sessions and 0 minutes (fails before this fix: 3 "real" hand-backs, the brand-new task parked, 3 sessions on its budget)', () => [
        JSON.stringify(r.kinds?.T1) === '["refresh-no-work","refresh-no-work","refresh-no-work"]' && r.loop?.['T-1'] === 0 && r.spend?.['T-1']?.sessions === 0 && r.spend['T-1'].minutes === 0,
        JSON.stringify({ kinds: r.kinds, loop: r.loop, spend: r.spend, raw: r._raw }).slice(0, 2500)]);
      await guard('2.86 (d2): a session that died on a permission prompt (or before its first turn, or never started) is kind "launch", and a task done refused by the hooks check only for commits that are not the task\'s own is kind "foreign-refusal" (its outcome counts: false, foreignRefusal): three of each count 0 toward the park, use none of the task\'s budget, never meet the same-refusal hold, and the crew breaker counts no no-work session and no short exit for them; launchFailure() reads only a Claude Code log, and never a refresh or a stall (fails before this fix: all "real", 3 sessions each on the budget, the second foreign refusal held the task)', () => [
        JSON.stringify(r.kinds?.T2) === '["launch","launch","launch"]' && JSON.stringify(r.kinds?.T3) === '["foreign-refusal","foreign-refusal","foreign-refusal"]'
          && r.loop['T-2'] === 0 && r.loop['T-3'] === 0 && r.spend['T-2'].sessions === 0 && r.spend['T-2'].minutes === 0 && r.spend['T-3'].sessions === 0 && r.spend['T-3'].minutes === 0
          && r.sameAgain === null && r.foreignOutcome?.counts === false && r.foreignOutcome.foreignRefusal === true
          && r.crew.noCommit === 0 && r.crew.builderNoCommit === 0 && r.crew.shortExits === 0
          && /permission prompt/.test(r.lf?.perm || '') && /before its first turn/.test(r.lf.noTurn || '') && r.lf.aider === null && r.lf.crash === null && r.lf.refresh === null && r.lf.stall === null && r.lf.worked === null,
        JSON.stringify({ kinds: r.kinds, loop: r.loop, spend: r.spend, sameAgain: r.sameAgain, crew: r.crew, fo: r.foreignOutcome, lf: r.lf }).slice(0, 2500)]);
      await guard('2.86 (d2, guard): a real hand-back still counts: three in two hours are three for the watchdog (it parks at 3) and 3 sessions on the task\'s budget; 2.85\'s kinds hold (the flow pass\'s "claim ran out" is "harness", a "ready for the train" note is "ready"); this held before the fix too', () => [
        JSON.stringify(r.kinds?.T4) === '["real","real","real"]' && r.loop?.['T-4'] === 3 && r.spend?.['T-4']?.sessions === 3 && r.spend['T-4'].minutes > 0
          && JSON.stringify(r.kinds.T5) === '["harness"]' && JSON.stringify(r.kinds.T6) === '["ready"]',
        JSON.stringify({ kinds: r.kinds, loop: r.loop, spend: r.spend })]);
      await guard('2.86 (d2): the scorecard\'s tally shows the attempts that ended for a harness reason, by kind (refresh with no work 3, launch failure 3, refused for commits not its own 3, no lane copy 1), apart from the 3 real hand-backs (fails before this fix: no harness tally; 9 more "real")', () => [
        r.tally?.real === 3 && r.tally.harness?.['refresh-no-work'] === 3 && r.tally.harness.launch === 3 && r.tally.harness['foreign-refusal'] === 3 && r.tally.harness['no-lane-copy'] === 1
          && r.words === 'refresh with no work 3, launch failure 3, refused for commits not its own 3, no lane copy 1',
        JSON.stringify({ tally: r.tally, words: r.words })]);

      // task done's reading of the hooks check's list: whose commits are they?
      const { S: G, env: genv } = studio('foreign', { git: true });
      fs.writeFileSync(path.join(G, 'board.txt'), 'board\n'); gitIn(G, 'add', 'board.txt'); gitIn(G, 'commit', '-qm', 'board: snapshot before harness upgrade', '--no-verify');
      const boardSha = gitIn(G, 'rev-parse', '--short=8', 'HEAD').stdout.trim();
      fs.writeFileSync(path.join(G, 'panel.txt'), 'panel\n'); gitIn(G, 'add', 'panel.txt'); gitIn(G, 'commit', '-qm', 'T-5: the fee panel', '--no-verify');
      const ownSha = gitIn(G, 'rev-parse', '--short=8', 'HEAD').stdout.trim();
      gitIn(G, 'branch', 'lane/x', 'HEAD'); gitIn(G, 'reset', '-q', '--hard', 'HEAD~1');
      const f = probe(G, genv, `import { foreignHookCommits } from ${u(G, 'harness/task.mjs')};
const list = (shas) => '[hooks] FAIL ' + shas.length + ' commit(s) since origin/main skipped the git hooks (no valid Studio-Hooks stamp):\\n' + shas.map((s) => '  ' + s + ' a subject — no stamp').join('\\n');
console.log(JSON.stringify({
  board: foreignHookCommits(list([${JSON.stringify(boardSha)}]), 'T-5', { lane: false }),
  own: foreignHookCommits(list([${JSON.stringify(boardSha)}, ${JSON.stringify(ownSha)}]), 'T-5', { lane: false }),
  laneBoard: foreignHookCommits(list([${JSON.stringify(boardSha)}]), 'T-6', { lane: true, main: () => 'main' }),
  laneOwn: foreignHookCommits(list([${JSON.stringify(ownSha)}]), 'T-6', { lane: true, main: () => 'main' }),
  none: foreignHookCommits('[hooks] FAIL could not check the commits', 'T-5', { lane: false }),
}));`);
      await guard('2.86 (d2): task done reads the hooks check\'s list: a commit that does not name the task (and, in a lane copy, is on the studio\'s main branch) is not the task\'s own, so the refusal is marked foreign; one commit naming the task, or one only on the lane, makes it the task\'s own refusal (fails before this fix: no such reading; every hooks refusal counted against the task)', () => [
        JSON.stringify(f.board) === JSON.stringify([boardSha]) && f.own === null && JSON.stringify(f.laneBoard) === JSON.stringify([boardSha]) && f.laneOwn === null && f.none === null,
        JSON.stringify({ f, boardSha, ownSha })]);
    }

    // ================= 3. a claim whose session is gone is dropped =================
    {
      const { S, ev, env } = studio('claims', { git: false });
      const r = probe(S, env, `import fs from 'node:fs'; import path from 'node:path';
import { claimActive, keepClaim } from ${u(S, 'harness/busy.mjs')};
import { listLocks, claim, holderGone, release } from ${u(S, 'harness/lock.mjs')};
import { releaseDeadLocks } from ${u(S, 'harness/agent.mjs')};
const now = Date.now(); const iso = (m) => new Date(now - m * 60000).toISOString();
fs.mkdirSync(path.join('.studio', 'agents'), { recursive: true });
// engine-porter-s9's session ended by a refresh two minutes ago; its lane copy changed just before.
fs.writeFileSync(path.join('.studio', 'agents', 'engine-porter-s9.json'), JSON.stringify({ agent: 'engine-porter-s9', role: 'engine-porter', status: 'ended', startedAt: iso(30), endedAt: iso(2), reason: 'refreshed (session cap): a fresh session continues' }));
fs.mkdirSync(path.join('.lanes', 'engine-porter-s9'), { recursive: true }); fs.writeFileSync(path.join('.lanes', 'engine-porter-s9', 'Crowd.cs'), 'x');
const evs = [{ ts: iso(25), type: 'task.start', agent: 'engine-porter-s9', task: 'T-1' }, { ts: iso(2), type: 'agent.session.end', agent: 'engine-porter-s9', task: 'T-1' }];
const active = claimActive('T-1', { root: process.cwd(), events: evs, now, env: {} });
// The claim the old flow pass made again in the dead session's name, after its end.
const kept = keepClaim('T-1', 'engine-porter-s9', { by: 'watch', why: 'still working on it' });
const lock1 = listLocks().find((l) => l.key === 'task:T-1') || null;
const gone = lock1 ? holderGone(lock1) : null;
// A train-queued task's kept claim, and an outside owner's (no session record): left alone.
fs.mkdirSync(path.join('.studio', 'train'), { recursive: true });
fs.writeFileSync(path.join('.studio', 'train', 'unity-queue.json'), JSON.stringify([{ task: 'T-2', agent: 'engine-porter-s9', branch: 'unity/t-2', head: 'abc', at: iso(5) }]));
keepClaim('T-2', 'engine-porter-s9', { by: 'director', why: 'still working on it' });
keepClaim('T-3', 'opus-bot', { by: 'director', why: 'active 3 min ago' });
const list = [{ agent: 'engine-porter-s9', running: false, endedAt: iso(2) }];
const sweep1 = await releaseDeadLocks(list);
const sweep2 = await releaseDeadLocks(list);
const left = listLocks().map((l) => l.key + ' ' + l.owner).sort();
const next = claim('task:T-1', 'engine-porter-s10');
// Without a sweep: a kept claim of an ended session is taken over by the next start (lock.mjs takeOver reads holderGone).
release('task:T-1', 'engine-porter-s10');
keepClaim('T-1', 'engine-porter-s9', { by: 'watch' });
const takeover = claim('task:T-1', 'engine-porter-s11');
console.log(JSON.stringify({ active, kept, keptMark: lock1?.kept || null, gone, sweep1, sweep2, left, next: { ok: next.ok, reason: next.reason || null }, takeover: { ok: takeover.ok, msg: takeover.message || null } }));`);
      const rel = events(ev).filter((e) => e.type === 'lock.dead_released');
      await guard('2.86 (d3): a lane copy that changed lately is not its owner "still working" when the owner\'s launched session ended (by a refresh) since it claimed: claimActive is not busy, so no flow pass or watcher keeps the claim in the dead session\'s name (fails before this fix: busy, "lane copy changed 0 min ago", lock.kept)', () => [
        r.active && r.active.busy === false, JSON.stringify(r).slice(0, 2000)]);
      await guard('2.86 (d3): a claim the harness kept in an ended session\'s name after its end carries the kept mark and is that session\'s: holderGone is true, the sweep (agent.mjs releaseDeadLocks) frees it once with one lock.dead_released event, and the next start\'s claim succeeds; without a sweep the next start takes it over (fails before this fix: spared as "someone else\'s under the same name", "Not started: engine-porter-s9 holds T-1")', () => [
        r.kept === true && r.keptMark?.by === 'watch' && r.gone === true && r.sweep1?.some((x) => /^task:T-1 \(engine-porter-s9\)/.test(x)) && r.sweep2?.length === 0
          && rel.length === 1 && r.next?.ok === true && r.takeover?.ok === true && /took over/.test(r.takeover.msg || ''),
        JSON.stringify({ r, rel: rel.map((e) => e.msg) }).slice(0, 2500)]);
      await guard('2.86 (d3, guard): a train-queued task\'s claim and a claim kept for an owner active outside the launcher (no session record) are untouched by the sweep; this held before the fix too', () => [
        Array.isArray(r.left) && r.left.includes('task:T-2 engine-porter-s9') && r.left.includes('task:T-3 opus-bot') && !(r.sweep1 || []).some((x) => /T-2|T-3/.test(x)),
        JSON.stringify(r).slice(0, 2000)]);
    }

    // ================= 4. a lane session reads the main checkout =================
    {
      const { S, env } = studio('adddir', { git: false });
      const r = probe(S, env, `import fs from 'node:fs';
import { laneAddDirs, toolCommand } from ${u(S, 'harness/agent.mjs')};
const main = fs.realpathSync.native(process.cwd());
const copy = { dir: '.lanes/builder-x', branch: 'lane/builder-x' };
const on = laneAddDirs({ copy, env: {} });
const off = laneAddDirs({ copy, env: { STUDIO_LANE_ADD_MAIN_DIR: 'off' } });
const inMain = laneAddDirs({ copy: null, env: {} });
const argv = toolCommand('claude', { model: 'claude-opus-5-5', prompt: 'x', addDirs: on }).argv;
const at = argv.indexOf(main);
console.log(JSON.stringify({ main, on, off, inMain, flag: at > 0 ? argv[at - 1] : null, argvOff: toolCommand('claude', { model: 'm', prompt: 'x', addDirs: off }).argv.includes(main) }));`);
      await guard('2.86 (d4, B-140): a Claude Code session in a lane copy is started with --add-dir <the main checkout> (besides its studio/ and .studio/), not with STUDIO_LANE_ADD_MAIN_DIR=off, and a session in the main checkout gets no extra folder (fails before this fix: only studio/ and .studio/; headless lane sessions died on "requested permissions to read from <the main checkout>")', () => [
        r.on?.[0] === r.main && r.flag === '--add-dir' && r.on.length === 3 && !r.off?.includes(r.main) && r.off.length === 2 && Array.isArray(r.inMain) && r.inMain.length === 0 && r.argvOff === false,
        JSON.stringify(r)]);
    }

    // ================= 5. one task's bad starts do not stop the studio =================
    {
      const { S, ev, env } = studio('halt', { git: false });
      const now = Date.now();
      const iso = (m) => new Date(now - m * 60000).toISOString();
      let k = 0;
      const end = (agent, task, at, extra = {}) => ({ id: `h${++k}`, ts: iso(at), type: 'agent.session.end', agent, task, msg: `${agent} ended (exit 1)`, meta: { role: 'builder', tool: 'claude', code: 1, reason: 'exit 1', exitCause: { kind: 'exit', code: 1, ranSec: 20, at: iso(at) }, outcome: { task, claimed: true, commits: 0, done: false, noWork: true, counts: true }, ...extra } });
      const refreshEnd = (agent, task, at) => end(agent, task, at, { reason: 'refreshed (session cap): a fresh session continues', refreshed: true, exitCause: { kind: 'refresh', code: 1, ranSec: 240, at: iso(at) }, outcome: { task, claimed: true, commits: 0, done: false, noWork: true, counts: false } });
      const permEnd = (agent, task, at) => end(agent, task, at, { launchFailure: { why: 'it stopped on a permission prompt (requested permissions to read)' } });
      fs.appendFileSync(ev, [permEnd('builder-a1', 'T-1', 12), permEnd('builder-a2', 'T-1', 8), end('builder-b1', 'T-2', 12), end('builder-b2', 'T-3', 8), refreshEnd('engine-porter-r1', 'T-4', 12), refreshEnd('engine-porter-r1', 'T-4', 6)].map((e) => JSON.stringify(e)).join('\n') + '\n');
      const r = probe(S, env, `import { supervise, holdTaskForEnds } from ${u(S, 'harness/supervisor.mjs')};
import { readRecentEvents } from ${u(S, 'harness/event.mjs')};
const now = ${now};
const deps = { sessions: () => [], startAgent: () => ({ ok: false, message: 'test' }), launchableRoles: () => ['builder'], nextAgentName: (role) => role + '-x1' };
const pass = async (names) => { const st = { startedAt: now - 60 * 60000, names }; let err = null; try { await supervise({ watcher: true, dryRun: true, deps }, st, now); } catch (e) { err = e.message; } return { halted: st.halted?.why || null, bo: st.startBackoff || {}, err }; };
const same = await pass(['builder-a1', 'builder-a2']);
const diff = await pass(['builder-b1', 'builder-b2']);
const refresh = await pass(['engine-porter-r1']);
// The page: one supervisor.backoff per hold; the same pair seen again pages nothing.
const pair = readRecentEvents(500).filter((e) => e.agent === 'builder-a1' || e.agent === 'builder-a2');
const st = {};
const h1 = holdTaskForEnds(st, 'T-1', pair, 1, now, { dryRun: false });
const h2 = holdTaskForEnds(st, 'T-1', pair, 1, now, { dryRun: false });
const pages = readRecentEvents(500).filter((e) => e.type === 'supervisor.backoff' && e.task === 'T-1').length;
console.log(JSON.stringify({ same: { halted: same.halted, t1: same.bo['T-1'] ? { until: same.bo['T-1'].until, count: same.bo['T-1'].count } : null, err: same.err }, diff: { halted: diff.halted, err: diff.err }, refresh: { halted: refresh.halted, err: refresh.err }, h1: Boolean(h1), h2, pages }));`);
      await guard('2.86 (d5, B-140): the same task\'s sessions ending with exit 1 on a permission prompt twice in a row (no work) hold THAT task with the start back-off (its next start waits, 4 min first) and page the Producer once (one supervisor.backoff; the same pair seen again pages nothing), and the supervisor does not halt (fails before this fix: "two sessions in a row ended with exit 1" halted the whole supervisor)', () => [
        r.same && r.same.halted === null && !r.same.err && r.same.t1 && r.same.t1.until >= now + 3.5 * 60000 && r.h1 === true && r.h2 === null && r.pages === 1,
        JSON.stringify(r).slice(0, 2500)]);
      await guard('2.86 (d5): two refresh hand-offs in a row (the launcher ends them with exit 1) never halt the supervisor (fails before this fix: a crew\'s supervisor halted three times on "engine-porter-s303, engine-porter-s303", each a refresh)', () => [
        r.refresh && r.refresh.halted === null && !r.refresh.err, JSON.stringify(r.refresh)]);
      await guard('2.86 (d5, guard): two DIFFERENT tasks\' sessions ending with exit 1 in a row with no work still halt the supervisor (a studio-wide fault: the tool or the machine is out); this held before the fix too', () => [
        r.diff && /two sessions in a row ended with exit 1/.test(r.diff.halted || ''), JSON.stringify(r.diff)]);
    }
  } finally {
    for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }); } catch { /* swept later */ } }
  }
}
