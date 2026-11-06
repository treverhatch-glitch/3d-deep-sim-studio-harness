/**
 * qa/selftest-2791c.mjs — 2.79.1 (c): the crew's findings on 2.79.0 (items 3.3 to 3.9).
 *   - sizeRule.exemptMaxKb: an exempt file's KB cap comes from the game's manifest (default twice the file limit).
 *   - A "Golden-Reason:" line git doesn't read as a trailer is refused by task done / --check, with where it goes.
 *   - The divergence runs its builds with TMP/TEMP/TMPDIR under <repo>/.studio/tmp, never the OS temp folder.
 *   - studio:status / studio:stop / studio:start: the supervisor writes its own pid first; stop marks it stopped.
 *   - Engine passes: the target branch is merged into the pass worktree before a session (conflicts reported); the
 *     porter may git add / commit in its worktree (and nothing else of git there).
 *   - task add: an engine-porter task defaults to the only engine track; a builder task infers its lane from paths.
 *   - Janitor: landed engine pass worktrees, orphan temp copies, STUDIO_LANE_IDLE_HOURS default 4.
 * A tiny studio (a git repo made from the harness copy) per check; probe scripts run in it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest2791C({ dir, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = path.join(harnessRoot, 'node_modules');
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const writeIn = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };
  const textIn = (cwd, rel) => { try { return fs.readFileSync(path.join(cwd, rel), 'utf8'); } catch { return ''; } };
  const readIn = (cwd, rel) => { try { return JSON.parse(textIn(cwd, rel)); } catch { return null; } };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms) => { const t0 = Date.now(); for (;;) { let v = false; try { v = fn(); } catch {} if (v) return true; if (Date.now() - t0 > ms) return false; await wait(200); } };
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, STUDIO_REFILL_WAKE: 'off', STUDIO_WATCHDOG: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_RAM_FLOOR_GB: '0', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_RAM_FLOOR_GB: '0', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off', STUDIO_TEST_LOADAVG: '0',
    STUDIO_VISUAL_GATE: 'off', STUDIO_GAME: 'demo', STUDIO_REACHABILITY: 'off', STUDIO_DONE_NOOP: 'allow', STUDIO_LANE_LIVE_MIN: '0', STUDIO_LANDING_BUILD: 'off',
    STUDIO_FLAKE_TRIAGE: 'off', STUDIO_WHOLE_GAME: 'off', STUDIO_SLOW_TIER: 'off', STUDIO_LINE_PRODUCER: 'off', STUDIO_VERIFY_KEY_DIR: path.join(tmpRoot, 'verify-keys-2791c'),
    CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', GITHUB_BASE_REF: '', CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-2791c-${process.pid}.pem`),
  };
  let n = 0;
  const made = [];
  const studio = (name) => {
    const S = path.join(tmpRoot, `2791c-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    fs.rmSync(path.join(S, '.env'), { force: true });
    writeIn(S, '.studio/keep', '');
    writeIn(S, 'studio/gates.json', `${JSON.stringify({ gates: [
      { id: 'protected', command: 'node qa/protected-check.mjs', required: true, lite: true },
      { id: 'secrets', command: 'node scripts/secret-scan.mjs', required: true, lite: true },
      { id: 'game', command: 'node harness/game-gates.mjs', required: true, lite: true, cache: false },
    ] }, null, 2)}\n`);
    writeIn(S, 'game/demo/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'check', command: 'node game/demo/check.mjs' }] }, null, 2)}\n`);
    writeIn(S, 'game/demo/check.mjs', "console.log('ok');\n");
    writeIn(S, 'game/demo/notes/shared.md', '# Shared\n');
    writeIn(S, 'game/demo/notes/other.md', '# Other\n');
    writeIn(S, 'game/demo/src/clock.ts', 'export const tick = 1;\n');
    g(S, 'init', '-q', '-b', 'main'); g(S, 'config', 'core.autocrlf', 'false'); g(S, 'config', 'core.eol', 'lf');
    g(S, 'config', 'user.name', 't'); g(S, 'config', 'user.email', 't@example.invalid');
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
    made.push(S);
    const env = { ...base };
    const evs = () => textIn(S, '.studio/events.jsonl').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
    return { S, env, evs };
  };
  const node = (cwd, args, env, timeout = 240000) => spawnSync(process.execPath, args, { windowsHide: true, cwd, encoding: 'utf8', env: { ...process.env, ...ident, ...env }, timeout });
  const task = (cwd, line, env, timeout) => node(cwd, ['harness/task.mjs', ...line], env, timeout);
  const probe = (S, code, env) => { const f = path.join(S, `.probe-2791c-${++n}.mjs`); fs.writeFileSync(f, code); const r = node(S, [f], env); const l = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop(); let j = null; try { j = JSON.parse(l); } catch {} return { ...r, j }; };
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  const commitAs = (cwd, msgFile) => g(cwd, 'commit', '-q', '--no-verify', '-F', msgFile);
  /** An engine repo (outside the studio) with a target branch unity/main, and the studio's game.json naming it. */
  const withEngine = (S, names = ['unity']) => {
    const E = path.join(tmpRoot, `2791c-eng-${process.pid}-${++n}`);
    fs.mkdirSync(E, { recursive: true });
    g(E, 'init', '-q', '-b', 'unity/main'); g(E, 'config', 'user.name', 't'); g(E, 'config', 'user.email', 't@example.invalid');
    writeIn(E, 'Rules/a.txt', 'one\n');
    g(E, 'add', '-A'); g(E, 'commit', '-qm', 'engine base', '--no-verify');
    made.push(E);
    const gj = readIn(S, 'studio/game.json') || {};
    gj.engines = {};
    for (const nm2 of names) gj.engines[nm2] = { target: `${nm2}/main`, folder: nm2 === names[0] ? E : path.join(E, 'x') };
    writeIn(S, 'studio/game.json', `${JSON.stringify(gj, null, 2)}\n`);
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'engines', '--no-verify');
    return E;
  };

  try {
    // ---- 3.3: sizeRule.exemptMaxKb ----
    {
      const st = studio('size');
      const { S, env } = st;
      writeIn(S, 'game/demo/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'check', command: 'node game/demo/check.mjs' }], sizeRule: { exempt: ['src/big.ts', 'src/small.ts'], exemptMaxKb: 90 } }, null, 2)}\n`);
      g(S, 'add', '-A'); g(S, 'commit', '-qm', 'size rule', '--no-verify');
      const p = probe(S, `import { sizeRuleFor } from ${u(S, 'harness/size-rule.mjs')};
const lim = { lines: 400, kb: 30 };
const a = sizeRuleFor('game/demo/src/big.ts', 'main', lim);
console.log(JSON.stringify({ kb: a.cap?.kb, lines: a.cap?.lines, exempt: a.exempt }));`, env);
      writeIn(S, 'game/demo/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'check', command: 'node game/demo/check.mjs' }], sizeRule: { exempt: ['src/big.ts'] } }, null, 2)}\n`);
      g(S, 'add', '-A'); g(S, 'commit', '-qm', 'size rule default', '--no-verify');
      const d = probe(S, `import { sizeRuleFor } from ${u(S, 'harness/size-rule.mjs')};
const a = sizeRuleFor('game/demo/src/big.ts', 'main', { lines: 400, kb: 30 });
console.log(JSON.stringify({ kb: a.cap?.kb }));`, env);
      await guard('2.79.1 (c, 3.3): an exempt file\'s hard KB cap comes from the game\'s studio.gates.json sizeRule.exemptMaxKb (90 here), and is twice the file limit (60) without it (fails on 2.79.0: the cap was always twice the limit, so exempting a 1 MB file never helped)', () => [
        p.j?.exempt === true && p.j.kb === 90 && p.j.lines === 800 && d.j?.kb === 60,
        JSON.stringify({ p: p.j, d: d.j, err: out(p).slice(-300) })]);
    }

    // ---- 3.4: Golden-Reason placement ----
    {
      const st = studio('gr');
      const { S, env } = st;
      const a = task(S, ['add', 'Docs: a note', '--role', 'builder', '--priority', 'P1', '--lane', 'game/demo/notes'], env);
      const id = (out(a).match(/"id":\s*"(T-\d+)"/) || [])[1];
      const as = { ...env, STUDIO_LOCK_OWNER: 'gr-1' };
      const s1 = task(S, ['start', id, '--agent', 'gr-1'], as);
      writeIn(S, 'game/demo/notes/shared.md', '# Shared\nchanged\n');
      g(S, 'add', '-A');
      writeIn(S, '.msg-bad.txt', `${id}: change the note\nGolden-Reason: the recorded answers moved on purpose\n`.replace(/\n/g, '\r\n'));
      const c1 = commitAs(S, path.join(S, '.msg-bad.txt'));
      const bad = task(S, ['done', id, '--agent', 'gr-1', '--check'], as);
      const badText = out(bad);
      // Amend it the right way: a blank line, then the trailer as the last paragraph.
      writeIn(S, '.msg-good.txt', `${id}: change the note\n\nGolden-Reason: the recorded answers moved on purpose\n`);
      const c2 = g(S, 'commit', '-q', '--no-verify', '--amend', '-F', path.join(S, '.msg-good.txt'));
      const good = task(S, ['done', id, '--agent', 'gr-1', '--check'], as);
      const tm = probe(S, `import { misplacedTrailers } from ${u(S, 'harness/trailers.mjs')};
console.log(JSON.stringify({ found: misplacedTrailers(process.cwd(), 'HEAD~1', 'HEAD', 'Golden-Reason').length }));`, env);
      await guard('2.79.1 (c, 3.4): task done --check refuses a commit whose "Golden-Reason:" line git does not read as a trailer (right under the subject, even with CRLF), says it must go after a blank line as the last paragraph and names git commit --amend, and passes once it is a trailer (fails on 2.79.0: nothing checked, the train handed the lane back later)', () => [
        s1.status === 0 && c1.status === 0 && bad.status === 1 && /a blank line, then Golden-Reason: .* as the last paragraph of the commit message/.test(badText) && /git commit --amend/.test(badText)
          && c2.status === 0 && !/Golden-Reason/.test(out(good)) && tm.j?.found === 0,
        JSON.stringify({ bad: [bad.status, badText.slice(-500)], good: [good.status, out(good).slice(-300)], tm: tm.j, id })]);
    }

    // ---- 3.5: the divergence builds under .studio/tmp ----
    {
      const st = studio('div');
      const { S, env } = st;
      const decoy = path.join(tmpRoot, `2791c-ostmp-${process.pid}-${++n}`);
      fs.mkdirSync(decoy, { recursive: true });
      made.push(decoy);
      writeIn(S, 'tmp-probe.mjs', `import fs from 'node:fs'; import os from 'node:os';
fs.appendFileSync(process.env.PROBE_OUT, os.tmpdir() + '\\n');
console.log(JSON.stringify({ tick: 1, digests: { a: 'x' } }));
`);
      g(S, 'add', '-A'); g(S, 'commit', '-qm', 'probe', '--no-verify');
      const outFile = path.join(S, '.probe-out.txt');
      const p = probe(S, `import { gameDivergence } from ${u(S, 'harness/divergence.mjs')};
const env = { ...process.env, TMP: ${JSON.stringify(decoy)}, TEMP: ${JSON.stringify(decoy)}, TMPDIR: ${JSON.stringify(decoy)}, PROBE_OUT: ${JSON.stringify(outFile)} };
const r = await gameDivergence({ root: process.cwd(), game: null, conf: { command: 'node tmp-probe.mjs' }, gate: 'check', env });
console.log(JSON.stringify({ error: r.error || null, found: r.found }));`, env);
      const seen = textIn(S, '.probe-out.txt').split('\n').filter(Boolean);
      const under = path.resolve(S, '.studio', 'tmp').toLowerCase();
      const inRepo = seen.length === 2 && seen.every((x) => path.resolve(x).toLowerCase().startsWith(under + path.sep) && !path.resolve(x).toLowerCase().startsWith(path.resolve(decoy).toLowerCase()));
      const left = (() => { try { return fs.readdirSync(path.join(S, '.studio', 'tmp')); } catch { return []; } })();
      await guard('2.79.1 (c, 3.5): the divergence\'s two runs of the game\'s command (this tree and the reference) get TMP/TEMP/TMPDIR under <repo>/.studio/tmp, so no path under the OS temp folder is used, and nothing is left behind (fails on 2.79.0: the command inherited the OS temp folder, where its Vite build failed on Windows)', () => [
        p.j && !p.j.error && inRepo && left.length === 0,
        JSON.stringify({ p: p.j, seen, left, err: out(p).slice(-300) })]);
    }

    // ---- 3.6: studio:status after stop && start ----
    {
      const st = studio('sup');
      const { S, env } = st;
      const sj = (rel = '.studio/supervisor.json') => readIn(S, rel);
      // The old supervisor's record: a pid that is gone, still saying running.
      writeIn(S, '.studio/supervisor.json', `${JSON.stringify({ pid: 2147483000, status: 'running', startedAt: new Date(Date.now() - 3600000).toISOString(), lastLoop: new Date(Date.now() - 3000000).toISOString(), sessions: 0, tasksDone: 0 }, null, 2)}\n`);
      const supEnv = { ...process.env, ...ident, ...env, STUDIO_SUPERVISOR_SEC: '600' };
      const child = spawn(process.execPath, ['harness/supervisor.mjs', '--foreground', '--no-hub'], { cwd: S, env: supEnv, windowsHide: true, stdio: 'ignore' });
      let firstSeen = null;
      const mine = await until(() => { const j = sj(); if (j?.pid === child.pid) { firstSeen = j; return true; } return false; }, 60000);
      const status = node(S, ['harness/supervisor.mjs', 'status'], env);
      const reload = node(S, ['harness/env-reload.mjs'], { ...env, STUDIO_SUPERVISOR_SEC: '1' }, 60000);
      const stop = node(S, ['harness/supervisor.mjs', 'stop'], env);
      const after = sj();
      const status2 = node(S, ['harness/supervisor.mjs', 'status'], env);
      const exited = await until(() => child.exitCode !== null || child.signalCode !== null, 20000);
      if (!exited) { try { child.kill('SIGKILL'); } catch {} }
      await guard('2.79.1 (c, 3.6): a starting supervisor writes its own pid and status to supervisor.json before its first full pass; studio:status then says Running and reload-env sees it, and studio:stop marks the record stopped at once so a later status says Not running (fails on 2.79.0: the file held the previous supervisor\'s pid until the first pass ended, and a stop left it "running")', () => [
        mine && firstSeen?.status === 'running' && firstSeen.passes === undefined && /^Running since/.test(out(status)) && !/isn't running here/.test(out(reload)) && stop.status === 0 && after?.status === 'stopped' && /^Not running/.test(out(status2)),
        JSON.stringify({ mine, first: firstSeen && { pid: firstSeen.pid, status: firstSeen.status, passes: firstSeen.passes }, status: out(status).slice(0, 160), reload: out(reload).slice(0, 200), after: after && { status: after.status, why: after.stopReason }, status2: out(status2).slice(0, 120) })]);
    }

    // ---- 3.7: engine porters ----
    {
      const st = studio('eng');
      const { S, env } = st;
      const E = withEngine(S);
      const a = task(S, ['add', 'Port the clock', '--role', 'engine-porter', '--priority', 'P2', '--track', 'engine:unity'], env);
      const id = (out(a).match(/"id":\s*"(T-\d+)"/) || [])[1];
      // The target moves on after the pass worktree is made: a clean merge, then a conflicting one.
      const p1 = probe(S, `process.env.STUDIO_ROLE = '';
const ag = await import(${u(S, 'harness/agent.mjs')});
const r = ag.launchEngineLane({ task: ${JSON.stringify(id)}, agent: 'porter-1', role: 'engine-porter' });
console.log(JSON.stringify({ dir: r.dir, branch: r.branch, note: r.note }));`, env);
      const wt = p1.j?.dir;
      if (!wt) {
        report('2.79.1 (c, 3.7): before an engine-porter session the engine\'s target branch is merged (no fast-forward) into the pass worktree; on a conflict the merge is aborted, the worktree left as it was, and the conflicting files are named in the porter\'s brief and an engine.target_conflict event (fails on 2.79.0: launchEngineLane was not even reachable, the worktree kept the old base)', false, out(p1).slice(-300));
        report('2.79.1 (c, 3.7): an engine-porter\'s tool allowlist includes git add and git commit (and status, diff, log) in its own engine worktree, and not push, checkout, switch or reset; sessions without an engine worktree get none of these (fails on 2.79.0: the porter could edit files but not commit them)', false, 'no engine worktree was made');
      } else {
      writeIn(E, 'Rules/b.txt', 'newer target change\n');
      g(E, 'add', '-A'); g(E, 'commit', '-qm', 'target moves', '--no-verify');
      const p2 = probe(S, `const ag = await import(${u(S, 'harness/agent.mjs')});
const r = ag.launchEngineLane({ task: ${JSON.stringify(id)}, agent: 'porter-1', role: 'engine-porter' });
console.log(JSON.stringify({ note: r.note }));`, env);
      const hasB = Boolean(wt) && fs.existsSync(path.join(wt, 'Rules', 'b.txt'));
      const merges = wt ? g(wt, 'log', '--merges', '--format=%s').stdout : '';
      // Now both sides change the same file.
      writeIn(wt, 'Rules/a.txt', 'porter edit\n'); g(wt, 'add', '-A'); g(wt, 'commit', '-qm', 'porter edit', '--no-verify');
      writeIn(E, 'Rules/a.txt', 'target edit\n'); g(E, 'add', '-A'); g(E, 'commit', '-qm', 'target edit', '--no-verify');
      const p3 = probe(S, `const ag = await import(${u(S, 'harness/agent.mjs')});
const r = ag.launchEngineLane({ task: ${JSON.stringify(id)}, agent: 'porter-1', role: 'engine-porter' });
console.log(JSON.stringify({ note: r.note }));`, env);
      const mergeHead = fs.existsSync(path.join(g(wt, 'rev-parse', '--absolute-git-dir').stdout.trim(), 'MERGE_HEAD'));
      // Tracked files only: the launcher's own untracked files (a Windows junction, a brief) aren't the merge's doing.
      const statusOut = g(wt, 'status', '--porcelain', '--untracked-files=no').stdout.trim();
      const clean = !statusOut;
      const evs = st.evs();
      await guard('2.79.1 (c, 3.7): before an engine-porter session the engine\'s target branch is merged (no fast-forward) into the pass worktree; on a conflict the merge is aborted, the worktree left as it was, and the conflicting files are named in the porter\'s brief and an engine.target_conflict event (fails on 2.79.0: the worktree kept the old base, two sessions ran empty and the pass was parked)', () => [
        p1.j?.dir && hasB && /Merge unity\/main/.test(merges) && evs.some((e) => e.type === 'engine.target_merged')
          && /conflicts in Rules\/a\.txt/.test(p3.j?.note || '') && !mergeHead && clean && evs.some((e) => e.type === 'engine.target_conflict' && (e.meta?.conflicts || []).includes('Rules/a.txt')),
        JSON.stringify({ p1: p1.j, p2: p2.j, merges, hasB, p3: p3.j, mergeHead, clean, statusOut, ev: evs.filter((e) => /^engine\./.test(e.type)).map((e) => e.type), err: out(p3).slice(-300) })]);

      const al = probe(S, `import { toolCommand } from ${u(S, 'harness/agent.mjs')};
import { allowedToolsList } from ${u(S, 'harness/allowlist.mjs')};
const d = ${JSON.stringify((wt || '').replace(/\\/g, '/'))};
const argv = toolCommand('claude', { model: 'm', file: 'f', prompt: 'p', engineDir: d }).argv;
const plain = toolCommand('claude', { model: 'm', file: 'f', prompt: 'p' }).argv;
console.log(JSON.stringify({ argv: argv.filter((x) => /^Bash\\(git -C/.test(x)), plain: plain.filter((x) => /git -C/.test(x)), list: allowedToolsList({ engineDir: d }).filter((x) => /git -C/.test(x)) }));`, env);
      const w = (wt || '').replace(/\\/g, '/');
      const argv = al.j?.argv || [];
      await guard('2.79.1 (c, 3.7): an engine-porter\'s tool allowlist includes git add and git commit (and status, diff, log) in its own engine worktree, and not push, checkout, switch or reset; sessions without an engine worktree get none of these (fails on 2.79.0: the porter could edit files but not commit them)', () => [
        Boolean(wt) && argv.includes(`Bash(git -C ${w} add *)`) && argv.includes(`Bash(git -C ${w} commit *)`) && !argv.some((x) => /push|checkout|switch|reset/.test(x)) && (al.j?.plain || []).length === 0,
        JSON.stringify({ al: al.j, err: out(al).slice(-300) })]);
      }
    }

    // ---- 3.8: task add defaults ----
    {
      const st = studio('add');
      const { S, env } = st;
      withEngine(S);
      const one = task(S, ['add', 'Port the clock', '--role', 'engine-porter', '--priority', 'P2'], env);
      const idOne = (out(one).match(/"id":\s*"(T-\d+)"/) || [])[1];
      const track1 = st.evs().find((e) => e.type === 'task.added' && e.task === idOne)?.meta?.track;
      const st2 = studio('add2');
      withEngine(st2.S, ['unity', 'godot']);
      const two = task(st2.S, ['add', 'Port the clock', '--role', 'engine-porter', '--priority', 'P2'], st2.env);
      const st3 = studio('add3');
      const f1 = task(st3.S, ['add', 'Fix the clock in game/demo/src/clock.ts', '--role', 'builder', '--priority', 'P1'], st3.env);
      const id1 = (out(f1).match(/"id":\s*"(T-\d+)"/) || [])[1];
      const lane1 = st3.evs().find((e) => e.type === 'task.added' && e.task === id1)?.meta?.lane;
      const f2 = task(st3.S, ['add', 'Tidy game/demo/notes/shared.md and game/demo/notes/other.md', '--role', 'builder', '--priority', 'P1'], st3.env);
      const id2 = (out(f2).match(/"id":\s*"(T-\d+)"/) || [])[1];
      const lane2 = st3.evs().find((e) => e.type === 'task.added' && e.task === id2)?.meta?.lane;
      const f3 = task(st3.S, ['add', 'Retune the clock in game/demo/src/clock.ts', '--role', 'builder', '--priority', 'P1', '--lane', 'game/demo/notes'], st3.env);
      const id3 = (out(f3).match(/"id":\s*"(T-\d+)"/) || [])[1];
      const lane3 = st3.evs().find((e) => e.type === 'task.added' && e.task === id3)?.meta?.lane;
      await guard('2.79.1 (c, 3.8): task add --role engine-porter without --track goes on the studio\'s only engine (engine:unity), and with several engines is refused with the list (fails on 2.79.0: no track, the porter got a game lane)', () => [
        one.status === 0 && track1 === 'engine:unity' && /engine:unity/.test(out(one)) && two.status === 1 && /engine:unity/.test(out(two)) && /engine:godot/.test(out(two)),
        JSON.stringify({ one: out(one).slice(-300), track1, two: [two.status, out(two).slice(-300)] })]);
      await guard('2.79.1 (c, 3.8): task add with no --lane infers the lane from paths in the title that exist (the single file, or the common folder of several), says so, and an explicit --lane wins (fails on 2.79.0: no lane inferred)', () => [
        lane1 === 'game/demo/src/clock.ts' && /inferred game\/demo\/src\/clock\.ts/.test(out(f1)) && lane2 === 'game/demo/notes' && /inferred game\/demo\/notes/.test(out(f2)) && lane3 === 'game/demo/notes',
        JSON.stringify({ f1: out(f1).slice(-120), f2: out(f2).slice(-120), m1: st3.evs().find((e) => e.task === id1 && e.type === 'task.added')?.meta, lane1, lane2, lane3 })]);
    }

    // ---- 3.9: janitor ----
    {
      const st = studio('jan');
      const { S, env } = st;
      const E = withEngine(S);
      const mk = (t) => { const L = path.join(S, '.lanes', 'engine', t); g(E, 'worktree', 'add', '-q', '-b', `unity/${t.toLowerCase()}`, L, 'unity/main'); return L; };
      const landed = mk('T-701'); const open = mk('T-702'); const dirty = mk('T-703');
      writeIn(dirty, 'Rules/unsaved.txt', 'unsaved\n');
      const tdir = path.join(tmpRoot, `jan-${process.pid}-${++n}`);
      made.push(tdir);
      const mkTmp = (name, { age = 3, file = true } = {}) => {
        const d = path.join(tdir, name);
        fs.mkdirSync(d, { recursive: true });
        writeIn(d, 'copy/index.html', '<html></html>');
        const t = new Date(Date.now() - age * 3600000);
        for (const p of [path.join(d, 'copy', 'index.html'), path.join(d, 'copy'), d]) fs.utimesSync(p, t, t);
        return d;
      };
      const oldBuild = mkTmp('studio-build-abc123');
      const oldPlay = mkTmp('xp-play-2147483001-a');
      const livePlay = mkTmp(`xp-play-${process.pid}-b`);
      const freshPlay = mkTmp('xp-play-fresh', { age: 0.2 });
      const other = mkTmp('someone-elses-folder');
      const p = probe(S, `import { emitEvent } from ${u(S, 'harness/event.mjs')};
import { pruneEnginePasses, janitorPlan, laneIdleHours, runJanitor } from ${u(S, 'harness/janitor.mjs')};
emitEvent({ type: 'task.train.unity.landed', agent: 'unity-train', msg: 'landed', meta: { lanes: ['T-701', 'T-703'] } });
const idle = laneIdleHours({}); const idle12 = laneIdleHours({ STUDIO_LANE_IDLE_HOURS: '12' });
const env = { STUDIO_JANITOR_TMPDIR: ${JSON.stringify(tdir)}, STUDIO_JANITOR_TEMP_PREFIXES: 'xp-play-' };
const plan = janitorPlan({ root: process.cwd(), env });
const orphans = plan.items.filter((i) => i.kind === 'temp-orphan').map((i) => i.path.split(/[\\\\/]/).pop());
const r = await pruneEnginePasses({ root: process.cwd() });
const run = await runJanitor({ yes: true, auto: false, env, root: process.cwd() });
console.log(JSON.stringify({ idle, idle12, orphans, removed: r.removed.map((x) => x.task), kept: r.kept.map((x) => x.task + ':' + x.why), deleted: run.deleted.filter((d) => d.kind === 'temp-orphan').map((d) => d.path.split(/[\\\\/]/).pop()) }));`, { ...env, PARENT_PID: String(process.pid) });
      const exists = (x) => fs.existsSync(x);
      await guard('2.79.1 (c, 3.9): STUDIO_LANE_IDLE_HOURS defaults to 4 (12 still set by hand works) (fails on 2.79.0: the default was 12, so ~25 idle copies piled up in 4 h)', () => [
        p.j?.idle === 4 && p.j.idle12 === 12, JSON.stringify({ j: p.j, err: out(p).slice(-300) })]);
      await guard('2.79.1 (c, 3.9): the janitor removes an engine pass worktree once the engine train landed its task (clean, no session), keeps one that has not landed or has uncommitted changes, and keeps the branch (fails on 2.79.0: pass worktrees stayed, 3 x 3.2 GB)', () => [
        p.j?.removed?.length === 1 && p.j.removed[0] === 'T-701' && !exists(landed) && exists(open) && exists(dirty) && g(E, 'rev-parse', '--verify', 'unity/t-701').status === 0
          && p.j.kept.some((k) => /^T-702:/.test(k)) && p.j.kept.some((k) => /^T-703:.*uncommitted/.test(k)),
        JSON.stringify({ j: p.j, err: out(p).slice(-300) })]);
      await guard('2.79.1 (c, 3.9): the janitor removes orphan temp copies in the OS temp folder only when the name has the harness\'s prefix (studio-build-) or a listed one, they are over 2 h old by their newest file, and no owner process is alive; others are left (fails on 2.79.0: orphan copies piled up)', () => [
        (p.j?.orphans || []).sort().join() === ['studio-build-abc123', 'xp-play-2147483001-a'].join() && (p.j?.deleted || []).length === 2
          && !exists(oldBuild) && !exists(oldPlay) && exists(livePlay) && exists(freshPlay) && exists(other),
        JSON.stringify({ j: p.j, left: fs.readdirSync(tdir) })]);
    }

    // ---- every child process in the new code passes windowsHide ----
    await guard('2.79.1 (c): every spawn in the files this part adds or changes passes windowsHide: true (fails on 2.79.0: n/a, new code)', () => {
      const files = ['harness/trailers.mjs', 'harness/lane-infer.mjs', 'qa/selftest-2791c.mjs'];
      const bad = [];
      for (const f of files) {
        const t = textIn(dir, f);
        const calls = t.split(/\r?\n/).filter((l) => /\b(spawnSync|spawn|execFileSync|execSync)\(/.test(l) && !/^\s*(\/\/|\*)/.test(l) && !/import\s/.test(l));
        for (const l of calls) if (!/windowsHide: true/.test(l)) bad.push(`${f}: ${l.trim().slice(0, 100)}`);
      }
      return [bad.length === 0, bad.join('\n')];
    });
  } finally {
    for (const S of made) { try { g(S, 'worktree', 'prune'); } catch {} }
    for (const S of made) { try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch {} }
  }
}
