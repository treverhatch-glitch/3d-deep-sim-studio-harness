/**
 * qa/selftest-265p.mjs — 2.65.0 (helper p): the conductor's tools, for an orchestrator outside the harness.
 *   lanes:        `npm run lanes -- --json` lists every lane copy with ahead/behind, hook stamps, harness drift, queue,
 *                 hold, Pin-Moves, merge-tree conflicts with main and between queued lanes, and age, in seconds.
 *   refresh:      `npm run lanes -- refresh` refuses workers and busy lanes (unless --busy-ok), merges main (never a
 *                 rebase: the lane's own commit is kept), keeps the hooks gate green, runs the lane's targeted tests,
 *                 stops on a textual conflict (merge aborted, files listed) and reports a red targeted test.
 *   brief:        `npm run status -- --brief` is fixed-format, under 100 words with long lists, and deterministic.
 *   notes:        `npm run task -- note` appends a ruling (conductor.note) shown in the task's brief inside the
 *                 untrusted block; a worker is refused; conductorInterventions counts them.
 *   job.done:     a heavy run, the game's checks, a train and a full verify each end with a uniform job.done event.
 *   events wait:  blocks until a matching event, exits 2 on timeout, and --since last misses nothing between waits;
 *                 job.done alerts for train/verify only behind STUDIO_ALERT_JOBS.
 * Every check fails on 2.64.0 (no lanes.mjs, jobs.mjs, conductor.mjs, brief-status.mjs, task note, job.done).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest265P({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = (extra = {}) => { const e = { ...process.env, ...ident, ...extra }; for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete e[k]; return e; };
  const g = (cwd, args, extra = {}) => spawnSync('git', args, { cwd, encoding: 'utf8', env: gEnv(extra) });
  const head = (cwd, ref = 'HEAD') => g(cwd, ['rev-parse', ref]).stdout.trim();
  const write = (base, rel, text) => { fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true }); fs.writeFileSync(path.join(base, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, ok, detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const events = path.join(dir, '.studio', 'events-265p.jsonl');
  const evs = () => { try { return fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const env = {
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '', GITHUB_BASE_REF: '', GITHUB_EVENT_NAME: '', STUDIO_TASK_BASE: '', STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_EXPERIMENT: '', STUDIO_AGENT_MODEL: '', STUDIO_HARNESS_REF: '', STUDIO_COMPACT_OUTPUT: '', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-265p-${process.pid}.pem`), STUDIO_MAIN_COMMIT: '',
    STUDIO_GAME: 'demo', STUDIO_REACHABILITY: 'off', STUDIO_HOOKS_CHECK: 'on', STUDIO_LANE_LIVE_MIN: '0', STUDIO_GATE_RELATED: '', STUDIO_GATE_CHANGED: '', STUDIO_GATE_PATHS: '', STUDIO_RAM_FLOOR_GB: '0', STUDIO_ALERT_JOBS: '', AGENT_EVENTS_FILE: events,
    CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', ...ident,
  };
  const outside = { ...env, AI_AGENT: 'conductor-test' }; // an agent outside the harness

  // ---- the fixture: a game with one path-scoped check, hooks installed, four lane copies ----
  write(dir, 'game/demo/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'check', command: 'node game/demo/check.mjs', paths: ['game/demo/**'] }] }, null, 2)}\n`);
  write(dir, 'game/demo/check.mjs', "import fs from 'node:fs';\nif (fs.existsSync('game/demo/red.flag')) { console.error('FAIL demo: red.flag is there'); process.exit(1); }\nconsole.log('demo ok');\n");
  write(dir, 'game/demo/shared.txt', 'one\ntwo\nthree\n');
  write(dir, 'game/demo/main.txt', 'alpha\nbeta\n');
  g(dir, ['init', '-q', '-b', 'main']); g(dir, ['config', 'core.autocrlf', 'false']);
  g(dir, ['add', '-A']); g(dir, ['commit', '-qm', 'studio', '--no-verify']);
  g(dir, ['config', 'core.hooksPath', 'scripts/hooks']);
  const addTask = (title) => (out(run(dir, `node harness/task.mjs add "${title}" --role builder --priority P1`, env)).match(/"id": "(T-\d+)"/) || [])[1];
  const ids = { a: addTask('Lane a shared line'), b: addTask('Lane b shared line'), c: addTask('Lane c main line'), d: addTask('Lane d red') };
  g(dir, ['add', '-A']); g(dir, ['commit', '-qm', 'board', '--no-verify']);
  const laneProbe = path.join(tmpRoot, `lane-265p-${process.pid}.mjs`);
  fs.writeFileSync(laneProbe, `import { createLaneCopy } from ${JSON.stringify(pathToFileURL(path.join(dir, 'harness', 'worktree.mjs')).href)};\nconsole.log(JSON.stringify(createLaneCopy(process.argv[2], { task: process.argv[3] })));\n`);
  const mkLane = (agent, id, rel, text, msg = '') => {
    run(dir, `node "${laneProbe}" ${agent} ${id}`, env);
    const ld = path.join(dir, '.lanes', agent);
    write(ld, rel, text);
    g(ld, ['add', rel]);
    const c = spawnSync('git', ['commit', '-q', '-m', `${id}: ${rel}`, ...(msg ? ['-m', msg] : [])], { cwd: ld, encoding: 'utf8', env: gEnv({ ...env, STUDIO_MAIN_ROOT: dir }) });
    return { agent, id, dir: ld, ok: c.status === 0, log: out(c), head: head(ld) };
  };
  const A = mkLane('bld-a', ids.a, 'game/demo/shared.txt', 'one\nTWO-A\nthree\n', 'Pin-Moves: speed');
  const B = mkLane('bld-b', ids.b, 'game/demo/shared.txt', 'one\nTWO-B\nthree\n');
  const C = mkLane('bld-c', ids.c, 'game/demo/main.txt', 'alpha\nBETA-C\n');
  const D = mkLane('bld-d', ids.d, 'game/demo/red.flag', 'red\n');
  // Main moves on: a harness-side file and the line lane c changes.
  write(dir, 'scripts/zz-265p-note.txt', 'moved on main\n');
  write(dir, 'game/demo/main.txt', 'alpha\nBETA-MAIN\n');
  g(dir, ['add', '-A', 'scripts', 'game']); g(dir, ['commit', '-qm', 'main moves', '--no-verify']);
  const tip = head(dir, 'main');
  // Lanes a and b queued for the train; b held for the owner (tier C); a held by a conductor.
  const at = new Date(Date.now() - 2 * 3600000).toISOString();
  write(dir, '.studio/train/queue.json', `${JSON.stringify([
    { task: A.id, agent: A.agent, dir: A.dir, branch: g(A.dir, ['symbolic-ref', '--short', 'HEAD']).stdout.trim(), head: A.head, at },
    { task: B.id, agent: B.agent, dir: B.dir, branch: g(B.dir, ['symbolic-ref', '--short', 'HEAD']).stdout.trim(), head: B.head, at, held: { tier: 'C', why: 'harness code', head: B.head, at } },
  ], null, 2)}\n`);
  const hold = run(dir, `node harness/task.mjs hold ${A.id} --by conductor --why "waits for the chain"`, outside);
  const lanesJson = () => { const r = run(dir, 'node harness/lanes.mjs --json', env); try { return { r, t: JSON.parse(r.stdout.trim().split('\n').pop()) }; } catch { return { r, t: null }; } };

  await guard('2.65.0 (conductor, lanes): `npm run lanes -- --json` lists every lane copy with its task, ahead/behind main, hook stamps ok, harness stale (main changed scripts/), queued (held for the owner, tier C), the conductor\'s hold, Pin-Moves, merge-tree conflicts with main (lane c) and between queued lanes on the same line (a and b), and an age, in a few seconds (fails on 2.64.0: no harness/lanes.mjs)', () => {
    const t0 = Date.now();
    const { r, t } = lanesJson();
    const ms = Date.now() - t0;
    const by = (id) => t?.lanes.find((l) => l.task === id);
    const a = by(A.id); const b = by(B.id); const c = by(C.id); const d = by(D.id);
    const ok = A.ok && B.ok && C.ok && D.ok && hold.status === 0 && r.status === 0 && t && t.lanes.length === 4 && t.tip === tip
      && a && a.agent === 'bld-a' && a.ahead === 1 && a.behind === 1 && a.stamps?.ok === true && a.stamps.open === 0 && a.harness?.current === false
      && a.queued && !a.queued.held && b.queued?.held?.tier === 'C' && a.hold?.by === 'conductor' && (a.pinMoves || []).join() === 'speed'
      && a.conflicts.some((x) => x.with === B.id && x.files.includes('game/demo/shared.txt')) && b.conflicts.some((x) => x.with === A.id)
      && c.conflicts.some((x) => x.with === 'main' && x.files.includes('game/demo/main.txt')) && !a.conflicts.some((x) => x.with === 'main')
      && d.conflicts.length === 0 && !d.queued && a.ageMs >= 0 && ms < 15000;
    const text = run(dir, 'node harness/lanes.mjs', env);
    return [ok && /TASK\s+AGENT\s+BRANCH/.test(text.stdout) && text.stdout.includes(A.id) && /HELD-owner/.test(text.stdout), `lanes ${A.log}${B.log} hold=${out(hold)}\nms=${ms}\n${out(r).slice(-2500)}\n${text.stdout}`];
  });

  await guard('2.65.0 (conductor, refresh refusals): a worker (--by builder-3, or a launched builder session) is refused with lanes.refresh.refused and nothing merged; a lane whose session is running is refused without --busy-ok (fails on 2.64.0: no lanes refresh)', () => {
    const before = head(C.dir);
    const w1 = run(dir, `node harness/lanes.mjs refresh ${C.id} --by builder-3`, env);
    const w2 = run(dir, `node harness/lanes.mjs refresh ${C.id} --by someone`, { ...env, STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-2' });
    write(dir, '.studio/agents/bld-d.json', JSON.stringify({ agent: 'bld-d', role: 'builder', task: D.id, status: 'running', pid: process.pid, startedAt: new Date().toISOString() }));
    const busy = run(dir, `node harness/lanes.mjs refresh ${D.id} --by conductor --json`, outside);
    let bj = null; try { bj = JSON.parse(busy.stdout.trim().split('\n').pop()); } catch {}
    fs.rmSync(path.join(dir, '.studio/agents/bld-d.json'), { force: true });
    const refused = evs().filter((e) => e.type === 'lanes.refresh.refused');
    const ok = w1.status === 2 && /worker agent/.test(out(w1)) && w2.status === 2 && /launched builder session/.test(out(w2)) && head(C.dir) === before
      && busy.status === 2 && bj?.results?.[0]?.status === 'refused' && /session is running/.test(bj.results[0].why) && head(D.dir) === D.head && refused.length >= 3;
    return [ok, `${out(w1)}\n${out(w2)}\n${out(busy)}\nrefused=${refused.length}`];
  });

  await guard('2.65.0 (conductor, refresh ok): refreshing lane a merges main into it with a merge commit (the lane\'s own commit stays, no rebase), the hooks gate in the lane passes (merge stamp), the lane\'s targeted test runs and is green, lanes.refresh.ok and a job.done for the game checks are logged, and the table shows it current with green tests (fails on 2.64.0)', () => {
    const r = run(dir, `node harness/lanes.mjs refresh ${A.id} --by conductor --json`, outside);
    let j = null; try { j = JSON.parse(r.stdout.trim().split('\n').pop()); } catch {}
    const res = j?.results?.[0];
    const now = head(A.dir);
    const parents = g(A.dir, ['log', '-1', '--format=%P', 'HEAD']).stdout.trim().split(' ');
    const hooks = run(A.dir, 'node harness/hook-stamp.mjs check', { ...env, STUDIO_MAIN_ROOT: dir });
    const okEv = evs().filter((e) => e.type === 'lanes.refresh.ok' && e.task === A.id).pop();
    const gameJob = evs().filter((e) => e.type === 'job.done' && e.meta?.kind === 'game-gates' && e.task === A.id).pop();
    const { t } = lanesJson();
    const row = t?.lanes.find((l) => l.task === A.id);
    const ok = r.status === 0 && res?.status === 'ok' && res.merged === true && parents.length === 2 && parents.includes(A.head) && parents.includes(tip)
      && g(dir, ['merge-base', '--is-ancestor', A.head, now]).status === 0 && hooks.status === 0
      && (res.tests?.ran || []).includes('game:check') && res.tests.ok === true && okEv && gameJob && gameJob.meta.code === 0
      && row && row.behind === 0 && row.harness?.current === true && row.last?.what === 'refresh tests' && row.last.ok === true && row.last.current === true;
    return [ok, `${out(r).slice(-2000)}\nparents=${parents}\nhooks=${out(hooks).slice(-800)}\nrow=${JSON.stringify(row)}`];
  });

  await guard('2.65.0 (conductor, refresh conflict and red): lane c, which conflicts with main, is handed back: merge aborted (no MERGE_HEAD, head unchanged), the file named, lanes.refresh.conflict; lane d merges but its targeted test fails: lanes.refresh.red with the failing check, exit 1 (fails on 2.64.0)', () => {
    const rc = run(dir, `node harness/lanes.mjs refresh ${C.id} --by conductor --json`, outside);
    let jc = null; try { jc = JSON.parse(rc.stdout.trim().split('\n').pop()); } catch {}
    const gd = g(C.dir, ['rev-parse', '--absolute-git-dir']).stdout.trim();
    const rd = run(dir, `node harness/lanes.mjs refresh ${D.id} --by conductor --json`, outside);
    let jd = null; try { jd = JSON.parse(rd.stdout.trim().split('\n').pop()); } catch {}
    const cEv = evs().filter((e) => e.type === 'lanes.refresh.conflict' && e.task === C.id).pop();
    const dEv = evs().filter((e) => e.type === 'lanes.refresh.red' && e.task === D.id).pop();
    const ok = rc.status === 1 && jc?.results?.[0]?.status === 'conflict' && (jc.results[0].files || []).includes('game/demo/main.txt') && head(C.dir) === C.head && !fs.existsSync(path.join(gd, 'MERGE_HEAD'))
      && !g(C.dir, ['status', '--porcelain', '--untracked-files=no']).stdout.trim() && cEv
      && rd.status === 1 && jd?.results?.[0]?.status === 'red' && jd.results[0].stage === 'tests' && /check/.test(jd.results[0].why) && dEv;
    return [ok, `${out(rc).slice(-1500)}\n${out(rd).slice(-1500)}`];
  });

  await guard('2.65.0 (conductor, refresh re-stamps): a lane with a commit made without the hooks shows "1 bad" stamp in the table; refresh re-commits it through the real hooks (same files, a stamp now), then merges main, and the hooks gate in the lane passes (fails on 2.64.0)', () => {
    const id = addTask('Lane e unstamped');
    run(dir, `node "${laneProbe}" bld-e ${id}`, env);
    const ld = path.join(dir, '.lanes', 'bld-e');
    write(ld, 'game/demo/e.txt', 'e\n');
    g(ld, ['add', 'game/demo/e.txt']);
    const c = spawnSync('git', ['commit', '-q', '--no-verify', '-m', `${id}: e`], { cwd: ld, encoding: 'utf8', env: gEnv({ ...env, STUDIO_MAIN_ROOT: dir }) });
    const before = head(ld);
    const tree = head(ld, 'HEAD^{tree}');
    write(dir, 'game/demo/later.txt', 'later\n');
    g(dir, ['add', 'game/demo/later.txt']); g(dir, ['commit', '-qm', 'main moves again', '--no-verify']);
    const { t } = lanesJson();
    const row = t?.lanes.find((l) => l.task === id);
    const r = run(dir, `node harness/lanes.mjs refresh ${id} --by conductor --json`, outside);
    let j = null; try { j = JSON.parse(r.stdout.trim().split('\n').pop()); } catch {}
    const res = j?.results?.[0];
    const hooks = run(ld, 'node harness/hook-stamp.mjs check', { ...env, STUDIO_MAIN_ROOT: dir });
    const own = g(ld, ['log', '--no-merges', '--format=%H %T', `${head(dir, 'main')}..HEAD`]).stdout.trim().split('\n').filter(Boolean);
    const ok = c.status === 0 && row?.stamps?.open === 1 && r.status === 0 && res?.status === 'ok' && res.restamped === 1 && res.merged === true
      && hooks.status === 0 && own.length === 1 && !own[0].startsWith(before) && own[0].endsWith(tree) && /Studio-Hooks:/.test(g(ld, ['log', '-1', '--format=%B', own[0].split(' ')[0]]).stdout);
    return [ok, `row=${JSON.stringify(row?.stamps)}\n${out(r).slice(-2000)}\nhooks=${out(hooks).slice(-800)}\nown=${own}`];
  });

  await guard('2.65.0 (conductor, status --brief): the brief has the fixed lines (workers, landed, bugs fixed, Unity, blockers, PC), stays under 100 words with 40 landings, 12 workers and long blockers, shows the running worker, the owner hold and the open ask, and two --peek runs give the same text (fails on 2.64.0: --brief is ignored)', () => {
    const now = Date.now();
    const lines = [];
    for (let i = 0; i < 40; i += 1) {
      const ts = new Date(now - 20 * 60000 + i * 1000).toISOString();
      lines.push(JSON.stringify({ id: `evt_b${i}`, ts, type: 'task.done', agent: 'bld', task: `T-${500 + i}`, msg: 'done', meta: {} }));
      if (i % 3 === 0) lines.push(JSON.stringify({ id: `evt_a${i}`, ts: new Date(now - 86400000).toISOString(), type: 'task.added', agent: 'p', task: `T-${500 + i}`, msg: 'added', meta: { type: 'bug' } }));
    }
    const bev = path.join(dir, '.studio', 'events-265p-brief.jsonl');
    fs.writeFileSync(bev, `${lines.join('\n')}\n`);
    for (let i = 0; i < 12; i += 1) write(dir, `.studio/agents/brief-w${i}.json`, JSON.stringify({ agent: `brief-w${i}`, role: i ? 'builder' : 'qa-playtester', task: `T-${600 + i}`, status: 'running', pid: process.pid }));
    write(dir, 'studio/asks/A-001.json', JSON.stringify({ id: 'A-001', question: 'which?', status: 'open' }));
    write(dir, '.studio/supervisor.json', JSON.stringify({ status: 'running', pid: process.pid, halted: { why: 'two sessions in a row ended with exit 1 (builder-1, builder-2): check the provider' } }));
    const iso = new Date(now).toISOString();
    const since = new Date(now - 30 * 60000).toISOString();
    const b1 = run(dir, `node harness/status.mjs --brief --peek --json --now ${iso} --since ${since}`, { ...env, AGENT_EVENTS_FILE: bev, STUDIO_TEST_FREEMEM_MB: '5300' });
    const b2 = run(dir, `node harness/status.mjs --brief --peek --now ${iso} --since ${since}`, { ...env, AGENT_EVENTS_FILE: bev, STUDIO_TEST_FREEMEM_MB: '5300' });
    for (let i = 0; i < 12; i += 1) fs.rmSync(path.join(dir, `.studio/agents/brief-w${i}.json`), { force: true });
    fs.rmSync(path.join(dir, '.studio/supervisor.json'), { force: true });
    let j = null; try { j = JSON.parse(b1.stdout.trim().split('\n').pop()); } catch {}
    const text = j?.text || '';
    const words = text.split(/\s+/).filter(Boolean).length;
    const ok = b1.status === 0 && j && words < 100 && j.words === words && text === b2.stdout.trim()
      && /^Studio \d\d:\d\d UTC, since \d\d:\d\d\./.test(text) && /Workers \(12\): qa-playtester T-600, builder T-601/.test(text) && /Landed \(40\): T-500/.test(text) && /\+\d+ more/.test(text)
      && /Bugs fixed \(14\)/.test(text) && /Unity: no land run recorded\./.test(text) && /Blockers: halted \(two sessions in a row ended with exit 1 \(builder-1, builder-2\)\); owner hold: [^;]*\bT-\d+/.test(text) && /asks: A-001/.test(text) && /PC: 5\.2 GB free; heavy: free\./.test(text);
    return [ok, `words=${words}\n${text}\n---\n${out(b2)}`];
  });

  await guard('2.65.0 (conductor, notes): `npm run task -- note <ID> "<ruling>" --by` from an agent outside the harness appends to studio/handoffs/<ID>.conductor.md and logs conductor.note; the task\'s brief shows the ruling inside the untrusted block; a worker (launched builder, or --by qa-2) is refused and nothing is written; conductorInterventions counts the notes (fails on 2.64.0: no task note)', async () => {
    const n1 = run(dir, `node harness/task.mjs note ${C.id} "lands after ${A.id}; keep the old save format" --by opus-bot`, outside);
    const n2 = run(dir, `node harness/task.mjs note ${C.id} "second ruling" --by hatch`, env);
    const file = path.join(dir, 'studio', 'handoffs', `${C.id}.conductor.md`);
    const text1 = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const w1 = run(dir, `node harness/task.mjs note ${C.id} "worker ruling" --by someone`, { ...env, STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-5' });
    const w2 = run(dir, `node harness/task.mjs note ${C.id} "worker ruling two" --by qa-2`, env);
    const text2 = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const probe = path.join(tmpRoot, `focus-265p-${process.pid}.mjs`);
    fs.writeFileSync(probe, `import { buildFocus, renderFocus } from ${JSON.stringify(pathToFileURL(path.join(dir, 'harness', 'focus.mjs')).href)};\nconsole.log(renderFocus(buildFocus(process.argv[2], 'bld-c')));\n`);
    const f = run(dir, `node "${probe}" ${C.id}`, env);
    const brief = f.stdout;
    const begin = brief.indexOf('----- BEGIN: written by agents or people -----');
    const end = brief.indexOf('----- END: written by agents or people -----');
    const at = brief.indexOf('keep the old save format');
    const { conductorInterventions } = await import(pathToFileURL(path.join(dir, 'harness', 'conductor.mjs')).href);
    const count = conductorInterventions(evs(), { from: Date.now() - 3600000 });
    const notes = evs().filter((e) => e.type === 'conductor.note' && e.task === C.id);
    const ok = n1.status === 0 && n2.status === 0 && (text1.match(/^- \[/gm) || []).length === 2 && /opus-bot \(outside agent\): lands after/.test(text1) && /hatch \(person\): second ruling/.test(text1)
      && w1.status !== 0 && /Refused/.test(out(w1)) && w2.status !== 0 && /qa-2 is a worker agent/.test(out(w2)) && text2 === text1
      && notes.length === 2 && notes[0].meta?.by === 'opus-bot' && begin >= 0 && at > begin && at < end && /Conductor notes: rulings on this task/.test(brief)
      && count.count === 2 && count.byWho['opus-bot'] === 1 && count.tasks.includes(C.id);
    return [ok, `${out(n1)}\n${out(n2)}\n${out(w1)}\n${out(w2)}\n${text2}\n${out(f).slice(0, 3000)}\ncount=${JSON.stringify(count)}`];
  });

  await guard('2.65.0 (conductor, job.done): a heavy run (exit 3), a train (no lanes) and a full verify each end with a uniform job.done event (kind, id, exit code, duration, tail or log) beside their own events (fails on 2.64.0: no job.done)', () => {
    const h = run(dir, 'node harness/heavy.mjs run --label probe-265p -- node -e process.exitCode=3', env);
    const probe = path.join(tmpRoot, `train-265p-${process.pid}.mjs`);
    fs.writeFileSync(probe, `import { runTrain } from ${JSON.stringify(pathToFileURL(path.join(dir, 'harness', 'train.mjs')).href)};\nconst r = await runTrain({ lanes: [], by: 'tester', deps: {}, log: () => {} });\nconsole.log(JSON.stringify({ ok: r.ok, id: r.id }));\n`);
    const tr = run(dir, `node "${probe}"`, env);
    const gates = path.join(dir, 'studio', 'gates.json');
    const saved = fs.readFileSync(gates, 'utf8');
    fs.writeFileSync(gates, `${JSON.stringify({ gates: [{ id: 'noop', command: 'node -e "process.exit(0)"', required: true, lite: true, cache: false }] }, null, 2)}\n`);
    const v = run(dir, 'node scripts/run-gates.mjs', { ...env, STUDIO_LOCK_OWNER: 'verifier-265p' });
    fs.writeFileSync(gates, saved);
    const jobs = evs().filter((e) => e.type === 'job.done');
    const hj = jobs.find((e) => e.meta?.kind === 'heavy' && e.meta.id === 'probe-265p');
    let tid = null; try { tid = JSON.parse(tr.stdout.trim().split('\n').pop()).id; } catch {}
    const tj = jobs.find((e) => e.meta?.kind === 'train' && e.meta.id === tid);
    const vj = jobs.filter((e) => e.meta?.kind === 'verify').pop();
    const gr = evs().filter((e) => e.type === 'gates.run').pop();
    const ok = h.status === 3 && hj && hj.meta.code === 3 && hj.status === 'error' && Number.isFinite(hj.durationMs)
      && tr.status === 0 && tj && tj.meta.result === 'nothing' && typeof tj.meta.log === 'string'
      && v.status === 0 && vj && vj.meta.code === 0 && vj.meta.id === 'verifier-265p' && vj.meta.log === '.studio/gates/verifier-265p-full.json' && gr;
    return [ok, `heavy=${out(h).slice(-300)} ${JSON.stringify(hj)}\ntrain=${out(tr).slice(-500)} ${JSON.stringify(tj)}\nverify=${out(v).slice(-800)} ${JSON.stringify(vj)}`];
  });

  await guard('2.65.0 (conductor, events wait): `npm run events -- wait --type job.done --match kind=heavy --match id=w1` blocks until that event is written and prints it (exit 0); a wait with nothing coming exits 2 with {"timeout":true}; --since last with the same --cursor returns an event written between two waits; job.done alerts only for train/verify and only with STUDIO_ALERT_JOBS=on (fails on 2.64.0: no events command)', async () => {
    const wenv = { ...process.env, ...env, STUDIO_EVENTS_WAIT_POLL_MS: '100' };
    const waitAsync = (args) => new Promise((resolve) => {
      const p = spawn(process.execPath, ['harness/jobs.mjs', 'wait', ...args], { cwd: dir, env: wenv });
      let so = ''; let se = '';
      p.stdout.on('data', (d) => { so += d; }); p.stderr.on('data', (d) => { se += d; });
      p.on('exit', (code) => resolve({ code, stdout: so, stderr: se }));
    });
    const emit = (meta) => run(dir, `node harness/event.mjs --type job.done --agent tester --quiet --meta "${JSON.stringify(meta).replace(/"/g, '\\"')}"`, env);
    const w = waitAsync(['--type', 'job.done', '--match', 'kind=heavy', '--match', 'id=w1', '--timeout', '1', '--cursor', 'c265p']);
    await new Promise((r) => setTimeout(r, 1200));
    emit({ kind: 'heavy', id: 'w0' });
    emit({ kind: 'heavy', id: 'w1', code: 0 });
    const got = await w;
    let ge = null; try { ge = JSON.parse(got.stdout.trim()); } catch {}
    const to = await waitAsync(['--type', 'job.done', '--match', 'kind=never', '--timeout', '0.01']);
    let te = null; try { te = JSON.parse(to.stdout.trim()); } catch {}
    emit({ kind: 'train', id: 'between' });
    const last = await waitAsync(['--type', 'job.*', '--since', 'last', '--cursor', 'c265p', '--timeout', '0.05']);
    let le = null; try { le = JSON.parse(last.stdout.trim()); } catch {}
    const { shouldAlert } = await import(pathToFileURL(path.join(dir, 'harness', 'alerts.mjs')).href);
    const cfg = { on: true, channel: 'ntfy', topic: 't' };
    const ev = (kind) => ({ type: 'job.done', meta: { kind } });
    const alerts = [shouldAlert(ev('train'), cfg, {}), shouldAlert(ev('train'), cfg, { STUDIO_ALERT_JOBS: 'on' }), shouldAlert(ev('verify'), cfg, { STUDIO_ALERT_JOBS: 'on' }), shouldAlert(ev('heavy'), cfg, { STUDIO_ALERT_JOBS: 'on' }), shouldAlert({ type: 'studio.stopped' }, cfg, {})];
    const ok = got.code === 0 && ge?.meta?.id === 'w1' && ge.type === 'job.done' && to.code === 2 && te?.timeout === true
      && last.code === 0 && le?.meta?.id === 'between' && alerts.join() === 'false,true,true,false,true';
    return [ok, `emitted=${JSON.stringify(evs().filter((e) => e.agent === 'tester').map((e) => e.meta))}\nwait=${got.code} ${got.stdout}${got.stderr}\ntimeout=${to.code} ${to.stdout}${to.stderr}\nlast=${last.code} ${last.stdout}${last.stderr}\nalerts=${alerts}`];
  });
}
