/**
 * qa/selftest-277o.mjs — 2.77.0 (helper o): `npm run lane -- create` (remote workers follow).
 *   lane       `lane -- create <T-ID> --from a --from b` makes .lanes/<agent> the launcher's way (studio/ and .studio/
 *              linked to main's, the lane record, the task's branch remembered), both branches merged in order, and
 *              `task done --check` from the copy finds the task (a bare `git worktree add` said 'Task not found')
 *   mixed      a branch carrying another open task's commits is refused (nothing made) unless --allow-mixed; a
 *              conflict leaves no copy and no branch; a launched worker session is refused
 *   eligible   `remote -- mark`: a docs task is eligible, a code task needs its own test commands, a Unity task and a
 *              person's task never are
 *   brief      `remote -- brief` claims the task for remote:<worker> with a STUDIO_REMOTE_LEASE_H lease (the lock, the
 *              board's record, the lease file), writes the self-contained brief (branch, trailer, done marker, tests,
 *              never-touch list); the rig budget counts it as 0 local CPU; its claim clock doesn't run
 *   fetch      `remote -- fetch` from a push-enabled remote: a branch with a commit lacking the trailer, or touching
 *              studio/, is refused; one without "Studio-Remote: done" is still working; harness code waits for a
 *              person; a finished one gets a lane copy and is queued for the normal train under remote:<worker>
 *   expire     a lease past its time releases the claim and hands the task back (a Line Producer pass, STUDIO_REMOTE=on)
 *   line       the Line Producer offers remote-eligible ready tasks when the local builders are at their target (a
 *              "remote" line in `line -- plan` and its status), local first when a slot is free
 *   docs       docs/REMOTE-WORKERS.md, package.json "remote" and "lane"
 * Each check fails on 2.76.0 (no harness/remote-workers.mjs, harness/lane-create.mjs, npm run remote or npm run lane).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export async function selftest277O({ dir, run, report, tmpRoot, root }) {
  void run; void root;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: gEnv(), windowsHide: true });
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const base = {
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_WATCH_INTERVAL: '0', STUDIO_MAIN_ROOT: '', STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '',
    CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', NODE_OPTIONS: '', STUDIO_MACHINE_SCAN: 'off', STUDIO_TEST_MACHINE: '', STUDIO_RAM_FLOOR_GB: '0', STUDIO_HEAVY_SLOTS: '0',
    STUDIO_LINE_PRODUCER: '', STUDIO_LINE_RIG: 'heavy', STUDIO_LINE_EXPANSION_SHARE: '0', STUDIO_TRAIN_AUTO: 'off', STUDIO_REPORT_WEBHOOK: '', STUDIO_HOOKS_CHECK: 'off', STUDIO_VISUAL_GATE: 'off',
    STUDIO_REMOTE: '', STUDIO_REMOTE_NAME: '', STUDIO_REMOTE_LEASE_H: '', STUDIO_REMOTE_MAX: '', STUDIO_REMOTE_FETCH_MIN: '', STUDIO_WORKTREES: '', STUDIO_LANELESS: '', STUDIO_GAME: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-277o-${process.pid}.pem`), STUDIO_VERIFY_DETACH: 'off', STUDIO_COMPACT_OUTPUT: '', ...ident,
  };
  let n = 0;
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const studio = (name, { tasks = [], holds = {}, events = [] } = {}) => {
    const S = path.join(tmpRoot, `277o-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    for (const x of ['.studio/agents', '.studio/locks', '.studio/train', '.studio/line', '.studio/remote', '.studio/lanes', '.studio/lane-branches.json', '.studio/supervisor.json', 'studio/divisions.json', 'studio/policy.json', 'studio/delegation.json', 'studio/beta.json', 'studio/handoffs']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
    const ev = path.join(S, '.studio', 'events-277o.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true });
    fs.writeFileSync(ev, events.map((e, i) => JSON.stringify({ id: `evt_${i}`, status: 'ok', ts: iso(now - 3600000 + i * 1000), ...e })).join('\n') + (events.length ? '\n' : ''));
    fs.writeFileSync(path.join(S, 'studio', 'NEXT.md'), `# Studio Task Queue (\`studio/NEXT.md\`)\n\n## IN_PROGRESS\n\n## BACKLOG\n${tasks.map((t) => `- [ ] **${t.id}** [${t.p || 'P1'}] (\`${t.role || 'builder'}\`) — ${t.title}`).join('\n')}\n\n## DONE\n`);
    fs.writeFileSync(path.join(S, 'studio', 'DONE.md'), '# Finished tasks (`studio/DONE.md`)\n\n## DONE\n');
    fs.writeFileSync(path.join(S, 'studio', 'task-holds.json'), `${JSON.stringify({ tasks: holds }, null, 2)}\n`);
    fs.writeFileSync(path.join(S, 'studio', 'mode.json'), `${JSON.stringify({ mode: 'extreme', history: [] }, null, 2)}\n`);
    fs.appendFileSync(path.join(S, '.gitignore'), '\n/.lanes/\n/.studio/\n');
    g(S, ['init', '-q', '-b', 'main']); g(S, ['config', 'core.autocrlf', 'false']); g(S, ['add', '-A']); g(S, ['commit', '-qm', 'studio', '--no-verify']);
    return { S, ev, env: { ...base, AGENT_EVENTS_FILE: ev } };
  };
  const added = (id, meta = {}) => ({ type: 'task.added', agent: 'producer', task: id, msg: `Queued ${id}`, meta });
  const events = (ev) => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const node = (cwd, env, args) => spawnSync(process.execPath, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true, timeout: 300000 });
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`.slice(-3000);
  const json = (r) => { const t = String(r.stdout || '').trim(); try { return JSON.parse(t); } catch { const l = t.split('\n').filter((x) => x.startsWith('{')).pop(); try { return JSON.parse(l); } catch { return null; } } };
  const readJ = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const probe = (S, env, body) => {
    const f = path.join(S, 'qa', `_probe-277o-${++n}.mjs`);
    fs.writeFileSync(f, `${body}\n`);
    const r = node(S, env, [f]);
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return { r, j: JSON.parse(line) }; } catch { return { r, j: null }; }
  };
  const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
  const commit = (cwd, file, text, msg) => { fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true }); fs.writeFileSync(path.join(cwd, file), text); g(cwd, ['add', '-A']); return g(cwd, ['commit', '-qm', msg, '--no-verify']); };

  // ---- lane create ----
  await guard('277o lane: lane -- create <T-ID> --from a --from b makes .lanes/<agent> with studio/ and .studio/ linked to main, merges both branches in order, writes the lane record and remembers the branch; task done --check from the copy finds the task (fails on 2.76.0: no npm run lane)', async () => {
    const { S, env } = studio('lane', { tasks: [{ id: 'T-181', title: 'Split the long soak' }, { id: 'T-182', title: 'Other work' }], events: [added('T-181'), added('T-182')] });
    g(S, ['checkout', '-qb', 'part-a']); commit(S, 'src/a-277o.txt', 'a\n', 'part a\n\nStudio-Task: T-181');
    g(S, ['checkout', '-q', 'main']); g(S, ['checkout', '-qb', 'part-b']); commit(S, 'src/b-277o.txt', 'b\n', 'part b\n\nStudio-Task: T-181');
    g(S, ['checkout', '-q', 'main']);
    const r = node(S, env, ['harness/lane-create.mjs', 'create', 'T-181', '--from', 'part-a', '--from', 'part-b', '--agent', 'clean-181', '--by', 'opus-1', '--json']);
    const j = json(r);
    const L = path.join(S, '.lanes', 'clean-181');
    const linked = real(path.join(L, 'studio')) === real(path.join(S, 'studio')) && real(path.join(L, '.studio')) === real(path.join(S, '.studio'));
    const both = fs.existsSync(path.join(L, 'src', 'a-277o.txt')) && fs.existsSync(path.join(L, 'src', 'b-277o.txt'));
    const log = g(L, ['log', '--format=%s', '-3']).stdout;
    const order = /Merge part-b/.test(log.split('\n')[0]);
    const rec = readJ(path.join(S, '.studio', 'lanes', 'clean-181.lane.json'));
    const branches = readJ(path.join(S, '.studio', 'lane-branches.json'), {});
    const chk = node(L, { ...env, STUDIO_MAIN_ROOT: S }, ['harness/task.mjs', 'done', 'T-181', '--agent', 'clean-181', '--check']);
    const ok = r.status === 0 && j?.ok && linked && both && order && rec?.task === 'T-181' && rec.from.map((x) => x.ref).join(',') === 'part-a,part-b' && branches['T-181'] === j.branch && !/not found/i.test(out(chk)) && JSON.parse(fs.readFileSync(path.join(S, 'package.json'), 'utf8')).scripts?.lane === 'node harness/lane-create.mjs';
    return [ok, `${out(r)}\nlinked ${linked} both ${both} log ${log}\nrec ${JSON.stringify(rec)}\nbranches ${JSON.stringify(branches)}\ncheck: ${out(chk)}`];
  });

  await guard('277o mixed: lane -- create refuses a branch carrying another open task\'s commits (nothing made) and takes it with --allow-mixed; a conflict leaves no copy and no branch; a launched worker is refused (fails on 2.76.0)', async () => {
    const { S, env } = studio('mixed', { tasks: [{ id: 'T-134', title: 'The task' }, { id: 'T-135', title: 'Another open task' }], events: [added('T-134'), added('T-135')] });
    g(S, ['checkout', '-qb', 'mixed-lane']); commit(S, 'src/m1-277o.txt', '1\n', 'own work\n\nStudio-Task: T-134'); commit(S, 'src/m2-277o.txt', '2\n', 'other task\n\nStudio-Task: T-135');
    g(S, ['checkout', '-q', 'main']); g(S, ['checkout', '-qb', 'clash-a']); commit(S, 'src/clash-277o.txt', 'A\n', 'clash a\n\nStudio-Task: T-134');
    g(S, ['checkout', '-q', 'main']); g(S, ['checkout', '-qb', 'clash-b']); commit(S, 'src/clash-277o.txt', 'B\n', 'clash b\n\nStudio-Task: T-134');
    g(S, ['checkout', '-q', 'main']);
    const refused = node(S, env, ['harness/lane-create.mjs', 'create', 'T-134', '--from', 'mixed-lane', '--agent', 'mx', '--by', 'opus-1']);
    const madeAfterRefusal = fs.existsSync(path.join(S, '.lanes', 'mx'));
    const allowed = node(S, env, ['harness/lane-create.mjs', 'create', 'T-134', '--from', 'mixed-lane', '--agent', 'mx', '--by', 'opus-1', '--allow-mixed', '--json']);
    const before = g(S, ['branch', '--list', 'lane/cl-*']).stdout.trim();
    const clash = node(S, env, ['harness/lane-create.mjs', 'create', 'T-134', '--from', 'clash-a', '--from', 'clash-b', '--agent', 'cl', '--by', 'opus-1']);
    const after = g(S, ['branch', '--list', 'lane/cl-*']).stdout.trim();
    const worker = node(S, { ...env, STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-x1' }, ['harness/lane-create.mjs', 'create', 'T-134', '--agent', 'wk', '--by', 'builder-x1']);
    const ok = refused.status === 1 && /T-135/.test(out(refused)) && /--allow-mixed/.test(out(refused)) && !madeAfterRefusal
      && allowed.status === 0 && json(allowed)?.ok && fs.existsSync(path.join(S, '.lanes', 'mx', 'src', 'm2-277o.txt'))
      && clash.status === 1 && /conflicts in src\/clash-277o\.txt/.test(out(clash)) && !fs.existsSync(path.join(S, '.lanes', 'cl')) && !before && !after
      && worker.status === 1 && /Refused/.test(out(worker)) && !fs.existsSync(path.join(S, '.lanes', 'wk'));
    return [ok, `refused ${refused.status}: ${out(refused)}\nallowed ${allowed.status}: ${out(allowed)}\nclash ${clash.status}: ${out(clash)} branches ${before}|${after}\nworker ${worker.status}: ${out(worker)}`];
  });

}
