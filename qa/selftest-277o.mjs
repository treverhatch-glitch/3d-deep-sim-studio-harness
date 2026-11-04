/**
 * qa/selftest-277o.mjs — 2.77.0 (helper o): remote (cloud) workers and `npm run lane -- create`.
 *   lane       `lane -- create <T-ID> --from a --from b` makes .lanes/<agent> the launcher's way (studio/ and .studio/
 *              linked to main's, the lane record, the task's branch remembered), both branches merged in order, and
 *              `task done --check` from the copy finds the task (a bare `git worktree add` said 'Task not found')
 *   mixed      a branch carrying another open task's commits is refused (nothing made) unless --allow-mixed; a
 *              conflict leaves no copy and no branch; a launched worker session is refused
 *   eligible   `remote -- mark`: a docs task is eligible, a code task needs its own test commands, a Unity task and a
 *              person's task never are
 *   brief      `remote -- brief` claims the task for remote-<worker> with a STUDIO_REMOTE_LEASE_H lease (the lock, the
 *              board's record, the lease file), writes the self-contained brief (branch, trailer, done marker, tests,
 *              never-touch list); the rig budget counts it as 0 local CPU; its claim clock doesn't run
 *   fetch      `remote -- fetch` from a push-enabled remote: a branch with a commit lacking the trailer, or touching
 *              studio/, is refused; one without "Studio-Remote: done" is still working; harness code waits for a
 *              person; a finished one gets a lane copy and is queued for the normal train under remote-<worker>
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

  // ---- remote: mark and eligibility ----
  await guard('277o eligible: remote -- mark: a docs task is eligible; a code task needs its own test commands (--test); a Unity task and a person\'s task never are (fails on 2.76.0: no npm run remote)', async () => {
    const { S, env } = studio('elig', { tasks: [{ id: 'T-201', title: 'Research: how other studios split soak tests' }, { id: 'T-202', title: 'Add the fee panel' }, { id: 'T-203', title: 'Unity pass 9: the plane model' }, { id: 'T-204', title: 'Decide the art style', role: 'human' }], events: [added('T-201', { type: 'research' }), added('T-202'), added('T-203', { track: 'engine:unity' }), added('T-204')] });
    const m = (args) => json(node(S, env, ['harness/remote-workers.mjs', 'mark', ...args, '--by', 'opus-1', '--json']));
    const docs = m(['T-201']);
    const code0 = m(['T-202']);
    const code1 = m(['T-202', '--test', 'npm run test:fees']);
    const unity = m(['T-203']);
    const human = m(['T-204']);
    const holds = readJ(path.join(S, 'studio', 'task-holds.json'))?.tasks || {};
    const ok = docs?.eligible?.ok && docs.eligible.kind === 'docs' && code0?.eligible?.ok === false && /own tests/.test(code0.eligible.why) && code1?.eligible?.ok && code1.eligible.tests.join() === 'npm run test:fees'
      && unity?.ok === false && /Unity/.test(unity.why) && human?.ok === false && /board/.test(human.why) && !holds['T-203'] && !holds['T-204'] && holds['T-202']?.remote?.tests?.[0] === 'npm run test:fees';
    return [ok, JSON.stringify({ docs, code0, code1, unity, human, holds })];
  });

  // ---- remote: brief, fetch, queue ----
  const remoteStudio = (name) => {
    const st = studio(name, { tasks: [{ id: 'T-301', title: 'Docs: the save-format notes' }, { id: 'T-302', title: 'Other work on the board' }], events: [added('T-301', { type: 'docs' }), added('T-302')] });
    const bare = path.join(tmpRoot, `277o-${name}-cloud-${process.pid}-${++n}.git`);
    g(tmpRoot, ['init', '-q', '--bare', bare]);
    g(st.S, ['remote', 'add', 'cloud', bare]);
    g(st.S, ['push', '-q', 'cloud', 'main']);
    g(st.S, ['fetch', '-q', 'cloud']);
    return { ...st, bare, env: { ...st.env, STUDIO_REMOTE_NAME: 'cloud', STUDIO_REMOTE_LEASE_H: '12' } };
  };
  await guard('277o brief: remote -- brief claims the task for remote-<worker> with a 12 h lease (lock, board record, lease file), the brief names the branch, the trailer, the done marker and the never-touch list; the rig budget counts 0 local CPU; the claim clock doesn\'t run; a worker session is refused (fails on 2.76.0)', async () => {
    const { S, env } = remoteStudio('brief');
    node(S, env, ['harness/remote-workers.mjs', 'mark', 'T-301', '--by', 'opus-1']);
    const w = node(S, { ...env, STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-z1' }, ['harness/remote-workers.mjs', 'brief', 'T-301', '--worker', 'web1', '--by', 'builder-z1']);
    const r = node(S, env, ['harness/remote-workers.mjs', 'brief', 'T-301', '--worker', 'web1', '--by', 'opus-1', '--json']);
    const j = json(r);
    const lockDir = path.join(S, '.studio', 'locks');
    const lock = fs.existsSync(lockDir) ? fs.readdirSync(lockDir).filter((f) => f.endsWith('.lock')).map((f) => readJ(path.join(lockDir, f))).find((l) => l?.key === 'task:T-301') : null;
    const hours = lock ? (Date.parse(lock.expiresAt) - Date.parse(lock.claimedAt)) / 3600000 : 0;
    const next = fs.readFileSync(path.join(S, 'studio', 'NEXT.md'), 'utf8');
    const inProg = next.split('## BACKLOG')[0].includes('T-301');
    const hold = readJ(path.join(S, 'studio', 'task-holds.json'))?.tasks?.['T-301']?.remote?.lease;
    const brief = fs.existsSync(path.join(S, '.studio', 'remote', 'briefs', 'T-301.md')) ? fs.readFileSync(path.join(S, '.studio', 'remote', 'briefs', 'T-301.md'), 'utf8') : '';
    const { j: rig } = probe(S, env, `import { rigBudget } from '../harness/rig-budget.mjs'; import { taskSpend } from '../harness/task-budget.mjs'; import { readRecentEvents } from '../harness/event.mjs';
const b = await rigBudget({}); const ev = readRecentEvents(5000);
console.log(JSON.stringify({ remote: b.remote, spend: taskSpend('T-301', ev, Date.now() + 5 * 3600000) }));`);
    const ok = w.status !== 0 && /Refused/.test(out(w)) && r.status === 0 && j?.ok && lock?.owner === 'remote-web1' && hours > 11.9 && hours < 12.1 && inProg && hold?.owner === 'remote-web1' && j.lease.branch === 'remote/T-301-docs-the-save-format'
      && /git push cloud remote\/T-301-docs-the-save-format/.test(brief) && /Studio-Task: T-301/.test(brief) && /Studio-Remote: done/.test(brief) && /Never touch `studio\/`/.test(brief) && /npm ci/.test(brief)
      && rig?.remote?.out === 1 && rig.remote.cpu === 0 && rig.spend.minutes === 0;
    return [ok, `worker ${w.status}: ${out(w)}\nbrief ${r.status}: ${out(r).slice(0, 1500)}\nlock ${JSON.stringify(lock)} hours ${hours}\nhold ${JSON.stringify(hold)}\nrig ${JSON.stringify(rig)}`];
  });

  await guard('277o fetch: remote -- fetch refuses a branch with a commit lacking the Studio-Task trailer or touching studio/, keeps one without "Studio-Remote: done" working, holds harness code for a person, and queues a finished one for the normal train in its own lane copy under remote-<worker> (fails on 2.76.0)', async () => {
    const { S, ev, env, bare } = remoteStudio('fetch');
    node(S, env, ['harness/remote-workers.mjs', 'mark', 'T-301', '--by', 'opus-1']);
    const b = json(node(S, env, ['harness/remote-workers.mjs', 'brief', 'T-301', '--worker', 'web1', '--by', 'opus-1', '--json']));
    const branch = b?.lease?.branch;
    if (!branch) return [false, `no brief: ${JSON.stringify(b)}`];
    // The cloud session: a clone of the push-enabled remote.
    const C = path.join(tmpRoot, `277o-cloud-clone-${process.pid}-${++n}`);
    g(tmpRoot, ['clone', '-q', '-b', 'main', bare, C]); g(C, ['config', 'core.autocrlf', 'false']);
    g(C, ['checkout', '-qb', branch]);
    const fetch = () => { const r = node(S, env, ['harness/remote-workers.mjs', 'fetch', '--by', 'opus-1', '--json']); return { r, j: json(r), st: (json(r)?.results || []).find((x) => x.task === 'T-301') }; };
    // 1. no trailer
    commit(C, 'docs/save-format-277o.md', '# Save format\n', 'notes, no trailer');
    g(C, ['push', '-q', '-f', 'origin', branch]);
    const f1 = fetch();
    // 2. trailer, but touches studio/
    g(C, ['reset', '-q', '--hard', 'origin/main']);
    commit(C, 'studio/NEXT.md', 'scribble\n', 'board edit\n\nStudio-Task: T-301\nStudio-Remote: done');
    g(C, ['push', '-q', '-f', 'origin', branch]);
    const f2 = fetch();
    // 3. good commits, not finished yet
    g(C, ['reset', '-q', '--hard', 'origin/main']);
    commit(C, 'docs/save-format-277o.md', '# Save format\n\nThe notes.\n', 'save-format notes\n\nStudio-Task: T-301');
    g(C, ['push', '-q', '-f', 'origin', branch]);
    const f3 = fetch();
    // 4. harness code: waits for a person
    commit(C, 'harness/extra-277o.mjs', 'export const x = 1;\n', 'a harness helper\n\nStudio-Task: T-301\nStudio-Remote: done');
    g(C, ['push', '-q', 'origin', branch]);
    const f4 = fetch();
    // 5. finished, docs only
    g(C, ['reset', '-q', '--hard', 'HEAD~1']);
    g(C, ['commit', '-q', '--allow-empty', '-m', 'T-301 ready', '-m', 'Studio-Task: T-301', '-m', 'Studio-Remote: done']);
    g(C, ['push', '-q', '-f', 'origin', branch]);
    const f5 = fetch();
    const q = readJ(path.join(S, '.studio', 'train', 'queue.json'), []);
    const entry = q.find((e) => e.task === 'T-301');
    const lane = path.join(S, '.lanes', 'remote-t-301');
    const lease = readJ(path.join(S, '.studio', 'remote', 'leases.json'), {})['T-301'];
    const evs = events(ev).map((e) => e.type);
    const ok = f1.st?.status === 'refused' && /no "Studio-Task: T-301" trailer/.test(f1.st.why)
      && f2.st?.status === 'refused' && /studio\/NEXT\.md/.test(f2.st.why)
      && f3.st?.status === 'working' && f4.st?.status === 'needs-review' && /harness\/extra-277o\.mjs/.test(f4.st.why)
      && f5.st?.status === 'queued' && entry?.agent === 'remote-web1' && real(entry.dir) === real(lane) && fs.existsSync(path.join(lane, 'docs', 'save-format-277o.md')) && real(path.join(lane, 'studio')) === real(path.join(S, 'studio'))
      && lease?.status === 'queued' && evs.includes('task.remote.refused') && evs.includes('task.remote.queued');
    return [ok, `f1 ${JSON.stringify(f1.st)}\nf2 ${JSON.stringify(f2.st)}\nf3 ${JSON.stringify(f3.st)}\nf4 ${JSON.stringify(f4.st)}\nf5 ${JSON.stringify(f5.st)} ${out(f5.r)}\nqueue ${JSON.stringify(q)}\nlease ${JSON.stringify(lease)}`];
  });

  await guard('277o expire: a lease past its time is ended by the Line Producer pass (STUDIO_REMOTE=on): the claim released, the task back on the board, the lease "expired", a task.remote.ended event (fails on 2.76.0)', async () => {
    const { S, ev, env } = remoteStudio('expire');
    node(S, env, ['harness/remote-workers.mjs', 'mark', 'T-301', '--by', 'opus-1']);
    const b = json(node(S, env, ['harness/remote-workers.mjs', 'brief', 'T-301', '--worker', 'web2', '--by', 'opus-1', '--json']));
    const lf = path.join(S, '.studio', 'remote', 'leases.json');
    const all = readJ(lf, {});
    if (!all['T-301']) return [false, `no lease: ${JSON.stringify(b)}`];
    all['T-301'].until = iso(now - 60000);
    fs.writeFileSync(lf, JSON.stringify(all));
    const { j, r } = probe(S, { ...env, STUDIO_REMOTE: 'on' }, `import * as lp from '../harness/line-producer.mjs'; import * as lock from '../harness/lock.mjs';
const s = await lp.lineProducerPass({ deps: { spawnFetch: () => 4242, sessions: [], pace: { maxAgents: 2, perRole: { builder: 2 }, label: 'test' }, rig: { known: false } } });
console.log(JSON.stringify({ swept: s.remote?.swept, locked: lock.status('task:T-301').locked }));`);
    const next = fs.readFileSync(path.join(S, 'studio', 'NEXT.md'), 'utf8');
    const back = next.split('## BACKLOG')[1]?.includes('T-301');
    const lease = readJ(lf, {})['T-301'];
    const ended = events(ev).some((e) => e.type === 'task.remote.ended' && e.task === 'T-301');
    const ok = j && j.locked === false && back && lease?.status === 'expired' && ended && (j.swept || []).some((x) => x.task === 'T-301' && x.status === 'expired');
    return [ok, `${out(r)}\nlease ${JSON.stringify(lease)} back ${back} ended ${ended}`];
  });

  await guard('277o line: the Line Producer offers remote-eligible ready tasks to remote workers when the local builders are at their target (a "remote" line in line -- plan and its status), and none while a local slot is free (fails on 2.76.0)', async () => {
    const { S, env } = studio('line', { tasks: [{ id: 'T-401', title: 'Research: save systems in other tycoon games' }, { id: 'T-402', title: 'Local work' }], events: [added('T-401', { type: 'research' }), added('T-402')] });
    node(S, env, ['harness/remote-workers.mjs', 'mark', 'T-401', '--by', 'opus-1']);
    const { j, r } = probe(S, { ...env, STUDIO_REMOTE: 'on' }, `import * as lp from '../harness/line-producer.mjs';
const deps = (running) => ({ spawnFetch: () => null, sessions: Array.from({ length: running }, (_, i) => ({ agent: 'builder-l' + i, role: 'builder', task: null, running: true })), pace: { maxAgents: 2, perRole: { builder: 2 }, label: 'test' }, rig: { known: false } });
const full = await lp.lineProducerPass({ dryRun: true, deps: deps(2) });
const free = await lp.lineProducerPass({ dryRun: true, deps: deps(0) });
console.log(JSON.stringify({ full: full.remote, free: free.remote, text: lp.statusText(full), line: full.text }));`);
    const pl = node(S, { ...env, STUDIO_REMOTE: 'on' }, ['harness/line-producer.mjs', 'plan', '--json']);
    const pj = json(pl);
    const ok = j && j.full?.offer?.map((o) => o.task).join() === 'T-401' && j.free?.offer?.length === 0 && /local first/.test(j.free.why) && /Remote: 0 out .*offer: T-401/.test(j.text) && pj && 'remote' in pj;
    return [ok, `${out(r)}\nplan: ${out(pl).slice(0, 800)}`];
  });

  await guard('277o docs: docs/REMOTE-WORKERS.md covers the flow for Claude Code on the web (a push-enabled remote, the brief, fetch, the lease) and what doesn\'t fit (train, locks, board, Unity); package.json has "remote" (fails on 2.76.0)', async () => {
    const f = path.join(dir, 'docs', 'REMOTE-WORKERS.md');
    const t = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts || {};
    const ok = /Claude Code on the web/.test(t) && /STUDIO_REMOTE_NAME/.test(t) && /push-enabled/i.test(t) && /STUDIO_REMOTE_LEASE_H/.test(t) && /npm run remote -- brief/.test(t) && /npm run remote -- fetch/.test(t) && /Unity/.test(t) && /locks/.test(t) && /train/.test(t) && pkg.remote === 'node harness/remote-workers.mjs';
    return [ok, t.slice(0, 400)];
  });
}
