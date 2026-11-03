/**
 * qa/selftest-271z.mjs — 2.71.0 (helper z): the self-repair loop (harness/workaround.mjs).
 *   log       `npm run workaround -- log "<what>" --why "<harness>" --cmd … --by …` writes .studio/workarounds.jsonl and a
 *             harness.workaround event with a signature; with --why it opens one harness task in studio/HARNESS-TASKS.md,
 *             never on studio/NEXT.md.
 *   group     the same trouble on different task ids is one signature: the first (no --why) opens nothing, the second
 *             opens ONE task; a third adds to it.
 *   force     `--force` on a task or lock command is a detected workaround.
 *   retry     the same refused task command run 3 times in 10 minutes by one agent is one detected workaround;
 *             `done --check` and another agent's runs don't count.
 *   hand-edit the board (studio/NEXT.md) and the train queue changed outside the harness are detected at the next harness
 *             write; the harness's own writes and a file put back to git's HEAD copy are not.
 *   restart   supervisor stop by hand and a start within 5 minutes is detected; with an upgrade between, or 20 minutes
 *             later, not.
 *   kill      a session whose launcher vanished with no stop asked, the machine up since it started, is detected; the
 *             watcher (markGone) records the times it needs.
 *   fixed     an open task whose signature isn't seen for 7 days after an upgrade is "maybe fixed in <version>"; close
 *             needs --by and --note, a builder session can't close; seen again, a closed task reopens.
 *   measure   the digest shows workarounds per day, top signatures and open harness tasks; the impact report shows
 *             workarounds before/after the upgrade and the trend ("fewer").
 *   export    `export --since 7d` writes one markdown file with the records and tasks and no secrets.
 * Made-up studios in temp folders; no network.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export async function selftest271Z({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = (cwd, args) => { const e = { ...process.env, ...ident }; for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete e[k]; return spawnSync('git', args, { cwd, encoding: 'utf8', env: e }); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const nm = path.join(dir, 'node_modules');
  const base = {
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '',
    STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '', STUDIO_REACHABILITY: 'off', STUDIO_LANE_INFER: 'off', STUDIO_OVERLAP: '', STUDIO_COMPACT_OUTPUT: '', STUDIO_DIGEST: '', STUDIO_IMPACT_MIN_N: '',
    STUDIO_WORKAROUND_DETECT: '', STUDIO_WORKAROUND_RETRIES: '', STUDIO_WORKAROUND_RETRY_MIN: '', STUDIO_WORKAROUND_RESTART_MIN: '', STUDIO_WORKAROUND_FIXED_DAYS: '', STUDIO_WORKAROUND_SCAN_MIN: '',
    STUDIO_HOOKS_CHECK: 'off', CLAUDECODE: '', AI_AGENT: '', AGENT_EVENTS_MIRROR: '', ...ident,
  };
  let n = 0;
  const studio = (name) => {
    const S = path.join(tmpRoot, `271z-${name}-${process.pid}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    for (const x of ['.studio/agents', '.studio/train', '.studio/locks', '.studio/write-stamps', '.studio/exports']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
    for (const x of ['.studio/workarounds.jsonl', '.studio/harness-tasks.json', '.studio/cmd-runs.jsonl', '.studio/workaround-state.json', 'studio/HARNESS-TASKS.md']) fs.rmSync(path.join(S, x), { force: true });
    const ev = path.join(S, '.studio', 'events-271z.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
    g(S, ['init', '-q', '-b', 'main']); g(S, ['config', 'core.autocrlf', 'false']);
    g(S, ['add', '-A']); g(S, ['commit', '-qm', 'studio', '--no-verify']);
    return { S, ev, env: { ...base, AGENT_EVENTS_FILE: ev } };
  };
  const events = (ev) => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const recs = (S) => { try { return fs.readFileSync(path.join(S, '.studio', 'workarounds.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const tasks = (S) => { try { return JSON.parse(fs.readFileSync(path.join(S, '.studio', 'harness-tasks.json'), 'utf8')).tasks; } catch { return []; } };
  const md = (S) => { try { return fs.readFileSync(path.join(S, 'studio', 'HARNESS-TASKS.md'), 'utf8'); } catch { return ''; } };
  const board = (S) => fs.readFileSync(path.join(S, 'studio', 'NEXT.md'), 'utf8');
  const probe = (S, code, env) => {
    const f = path.join(S, `.probe-271z-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(S, `node ${path.basename(f)}`, env);
    fs.rmSync(f, { force: true });
    let j = null;
    try { j = JSON.parse(String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop()); } catch {}
    return { ...(j || {}), _out: out(r).slice(-2500) };
  };
  const addEvents = (ev, list) => fs.appendFileSync(ev, list.map((e, i) => `${JSON.stringify({ id: `evt_z_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`, status: 'ok', msg: '', meta: {}, ...e })}\n`).join(''));
  const DAY = 86400000;
  const iso = (ms) => new Date(ms).toISOString();

  // ---- A: logging, grouping, the separate queue, force, retries, hand edits --------------------------------------
  const A = studio('a');
  const before = board(A.S);
  await guard('271z log: `npm run workaround -- log` records the workaround, a harness.workaround event with a signature, and with --why opens ONE harness task in studio/HARNESS-TASKS.md (not on NEXT.md)', () => {
    const r = run(A.S, 'node harness/workaround.mjs log "re-ran the train by hand after T-12 was refused" --why "train refused a green lane" --cmd "npm run task -- train" --by overseer-1', A.env);
    const rs = recs(A.S); const ev = events(A.ev).filter((e) => e.type === 'harness.workaround');
    const t = tasks(A.S);
    const ok = r.status === 0 && rs.length === 1 && rs[0].by === 'overseer-1' && rs[0].why && rs[0].cmdKey === 'task train' && /^task train: /.test(rs[0].signature)
      && ev.length === 1 && ev[0].meta?.signature === rs[0].signature && t.length === 1 && t[0].status === 'open' && /H-001/.test(md(A.S)) && /train refused a green lane/.test(md(A.S))
      && board(A.S) === before && !/H-001|re-ran the train/.test(board(A.S));
    return [ok, `${out(r)}\n${JSON.stringify(rs)}\n${JSON.stringify(t)}`];
  });
  await guard('271z group: the same trouble on different task ids is one signature; the first (no --why) opens nothing, the second opens ONE task, the third adds to it', () => {
    const w = (id) => run(A.S, `node harness/workaround.mjs log "edited .studio/agents record of ${id} by hand to free a stuck claim" --cmd "npm run task -- start ${id} --agent b-1" --by overseer-1`, A.env);
    w('T-31'); const t1 = tasks(A.S).length;
    w('T-44'); const t2 = tasks(A.S);
    w('T-58'); const t3 = tasks(A.S);
    const sigs = new Set(recs(A.S).slice(1).map((r) => r.signature));
    const mine = t3.find((t) => t.signature === [...sigs][0]);
    return [t1 === 1 && t2.length === 2 && t3.length === 2 && sigs.size === 1 && mine?.occurrences === 3 && mine.commands.length === 3, `${t1} ${JSON.stringify(t3)}`];
  });
  await guard('271z force: --force on a task command and on a lock command is a detected workaround (detected: true, kind force, evidence the command line)', () => {
    run(A.S, 'node harness/task.mjs start T-900 --agent b-2 --force', A.env);
    run(A.S, 'node harness/lock.mjs release path:game/x --owner b-2 --force', A.env);
    const f = recs(A.S).filter((r) => r.kind === 'force');
    return [f.length === 2 && f.every((r) => r.detected === true && r.evidence.some((e) => /--force/.test(e))) && f[0].cmdKey === 'task start' && f[1].cmdKey === 'lock release', JSON.stringify(f)];
  });
  await guard('271z retry: a refused task command run 3 times in 10 min by one agent is ONE detected workaround; done --check and another agent\'s runs are not', () => {
    for (let i = 0; i < 3; i++) run(A.S, 'node harness/task.mjs done T-404 --agent b-3 --check', A.env);
    run(A.S, 'node harness/task.mjs done T-404 --agent b-4', A.env); run(A.S, 'node harness/task.mjs done T-404 --agent b-5', A.env);
    const none = recs(A.S).filter((r) => r.kind === 'retry').length;
    for (let i = 0; i < 4; i++) run(A.S, 'node harness/task.mjs done T-404 --agent b-3', A.env);
    const r = recs(A.S).filter((x) => x.kind === 'retry');
    return [none === 0 && r.length === 1 && r[0].by === 'b-3' && r[0].cmdKey === 'task done' && r[0].evidence.filter((e) => /exit [1-9]/.test(e)).length === 2, `none=${none} ${JSON.stringify(r)}`];
  });
  await guard('271z hand-edit: the board changed outside the harness is detected at the next harness write (evidence: sizes and times); the harness\'s own writes and a file put back to git\'s HEAD copy are not', () => {
    const add = (t) => run(A.S, `node harness/task.mjs add "${t}" --role builder`, A.env);
    add('Paint the fence'); add('Sweep the yard');
    const own = recs(A.S).filter((r) => r.kind === 'hand-edit').length;
    sleep(30);
    fs.appendFileSync(path.join(A.S, 'studio', 'NEXT.md'), '- [ ] **T-777** [P2] (`builder`) — added by hand\n');
    add('Oil the gate');
    const h = recs(A.S).filter((r) => r.kind === 'hand-edit');
    add('Stack the logs');
    const once = recs(A.S).filter((r) => r.kind === 'hand-edit').length;
    g(A.S, ['add', 'studio']); g(A.S, ['commit', '-qm', 'board', '--no-verify']);
    add('Fix the roof'); sleep(30);
    g(A.S, ['checkout', '--', 'studio/NEXT.md']);
    add('Clean the shed');
    const afterHead = recs(A.S).filter((r) => r.kind === 'hand-edit').length;
    return [own === 0 && h.length === 1 && h[0].detected && /studio\/NEXT\.md/.test(h[0].what) && /changed outside the harness/.test(h[0].evidence[0]) && once === 1 && afterHead === 1, `own=${own} once=${once} afterHead=${afterHead} ${JSON.stringify(h)}`];
  });
  await guard('271z hand-edit: the train queue (.studio/train/queue.json) changed by hand between two harness writes is detected', () => {
    const p = probe(A.S, `import fs from 'node:fs';\nimport { enqueue } from './harness/train.mjs';\nconst root = process.cwd();\nenqueue(root, { task: 'T-1', agent: 'a', dir: 'x', branch: 'b', head: 'h', all: false });\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);\nconst f = '.studio/train/queue.json'; const q = JSON.parse(fs.readFileSync(f, 'utf8')); q.push({ task: 'T-2', agent: 'hand' }); fs.writeFileSync(f, JSON.stringify(q));\nenqueue(root, { task: 'T-3', agent: 'c', dir: 'x', branch: 'b', head: 'h', all: false });\nconsole.log(JSON.stringify({ ok: true }));\n`, A.env);
    const h = recs(A.S).filter((r) => r.kind === 'hand-edit' && /queue\.json/.test(r.what));
    return [p.ok && h.length === 1, `${p._out}\n${JSON.stringify(h)}`];
  });

  // ---- B: events (restart, kill), maybe fixed, close/reopen ----------------------------------------------------------
  const B = studio('b');
  await guard('271z restart: supervisor stopped by hand and started within 5 min is detected; with an upgrade between, or 20 min later, not; a second scan adds nothing', () => {
    const now = Date.now();
    addEvents(B.ev, [
      { ts: iso(now - 60 * 60000), type: 'supervisor.stop', agent: 'supervisor', msg: 'Supervisor stopped (stopped by hand) after 40 min: 2 sessions started' },
      { ts: iso(now - 58 * 60000), type: 'supervisor.start', agent: 'supervisor', msg: 'Supervisor running' },
      { ts: iso(now - 50 * 60000), type: 'supervisor.stop', agent: 'supervisor', msg: 'Supervisor stopped (studio:stop was asked) after 8 min' },
      { ts: iso(now - 49 * 60000), type: 'upgrade.merged', agent: 'upgrade', meta: { to: '7.1.0', from: '7.0.0' } },
      { ts: iso(now - 47 * 60000), type: 'supervisor.start', agent: 'supervisor', msg: 'Supervisor running' },
      { ts: iso(now - 40 * 60000), type: 'supervisor.stop', agent: 'supervisor', msg: 'Supervisor stopped (stopped by hand) after 7 min' },
      { ts: iso(now - 20 * 60000), type: 'supervisor.start', agent: 'supervisor', msg: 'Supervisor running' },
    ]);
    run(B.S, 'node harness/workaround.mjs scan', B.env); run(B.S, 'node harness/workaround.mjs scan', B.env);
    const r = recs(B.S).filter((x) => x.kind === 'restart');
    return [r.length === 1 && r[0].detected && r[0].evidence.length === 2 && /120 s later/.test(r[0].evidence[1]), JSON.stringify(r)];
  });
  await guard('271z kill: a session whose launcher vanished with no stop asked and the machine up since it started is detected; one stopped through the harness, or from before a reboot, is not; markGone records the times', () => {
    const now = Date.now();
    addEvents(B.ev, [
      { ts: iso(now - 30 * 60000), type: 'agent.session.end', agent: 'b-7', status: 'error', msg: 'b-7 ended: its process is gone', meta: { reason: 'process gone', startedAt: iso(now - 90 * 60000), bootAt: iso(now - 9 * DAY) } },
      { ts: iso(now - 29 * 60000), type: 'agent.session.end', agent: 'b-8', status: 'ok', msg: 'b-8 ended', meta: { reason: 'process gone', stoppedBy: 'producer', startedAt: iso(now - 90 * 60000), bootAt: iso(now - 9 * DAY) } },
      { ts: iso(now - 28 * 60000), type: 'agent.session.end', agent: 'b-9', status: 'error', msg: 'b-9 ended', meta: { reason: 'process gone', startedAt: iso(now - 90 * 60000), bootAt: iso(now - 60 * 60000) } },
    ]);
    run(B.S, 'node harness/workaround.mjs scan', B.env);
    const k = recs(B.S).filter((x) => x.kind === 'kill');
    fs.mkdirSync(path.join(B.S, '.studio', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(B.S, '.studio', 'agents', 'b-gone.json'), JSON.stringify({ agent: 'b-gone', status: 'running', pid: 999999, startedAt: iso(now - 10 * 60000), role: 'builder', tool: 'claude' }));
    probe(B.S, "import { markGone } from './harness/agent.mjs';\nconsole.log(JSON.stringify({ gone: markGone() }));\n", B.env);
    const end = events(B.ev).filter((e) => e.type === 'agent.session.end' && e.agent === 'b-gone').pop();
    return [k.length === 1 && /b-7/.test(k[0].evidence[0]) && end?.meta?.startedAt && end?.meta?.bootAt && Date.parse(end.meta.bootAt) < Date.now(), `${JSON.stringify(k)}\n${JSON.stringify(end?.meta)}`];
  });
  await guard('271z fixed: an open harness task not seen for 7 days after an upgrade landed is marked "maybe fixed in <version>"; one seen after it is not', () => {
    const now = Date.now();
    const p = probe(B.S, `import { recordWorkaround } from './harness/workaround.mjs';\nconst now = ${now};\nfor (const id of ['T-1', 'T-2']) recordWorkaround({ what: 'copied the lane by hand because refresh failed on ' + id, cmd: 'npm run lanes -- refresh', by: 'overseer-2', now: now - 10 * 86400000 });\nfor (const id of ['T-3', 'T-4']) recordWorkaround({ what: 'set PATH by hand for the tool on ' + id, cmd: 'npm run agent -- start', by: 'overseer-2', now: now - 10 * 86400000 });\nrecordWorkaround({ what: 'set PATH by hand for the tool on T-5', cmd: 'npm run agent -- start', by: 'overseer-2', now: now - 2 * 86400000 });\nconsole.log(JSON.stringify({ ok: true }));\n`, B.env);
    addEvents(B.ev, [{ ts: iso(now - 9 * DAY), type: 'upgrade.merged', agent: 'upgrade', meta: { to: '7.2.0', from: '7.1.0' } }]);
    run(B.S, 'node harness/workaround.mjs scan', B.env);
    const t = tasks(B.S);
    const lanes = t.find((x) => /lanes refresh/.test(x.signature)); const agent = t.find((x) => /agent start/.test(x.signature));
    return [p.ok && lanes?.maybeFixed?.version === '7.2.0' && agent && !agent.maybeFixed && /Maybe fixed in 7\.2\.0/.test(md(B.S)) && events(B.ev).some((e) => e.type === 'harness.task_maybe_fixed'), `${p._out}\n${JSON.stringify(t, null, 1).slice(0, 2000)}`];
  });
  await guard('271z close: close needs --by and --note, a builder session can\'t close, a close is recorded; seen again, the task reopens', () => {
    const id = tasks(B.S).find((x) => /lanes refresh/.test(x.signature))?.id;
    const bad = run(B.S, `node harness/workaround.mjs close ${id} --by owner-1`, B.env);
    const builder = run(B.S, `node harness/workaround.mjs close ${id} --by b-1 --note "fixed it myself"`, { ...B.env, STUDIO_ROLE: 'builder' });
    const ok = run(B.S, `node harness/workaround.mjs close ${id} --by owner-1 --note "lane refresh fixed in 7.2.0"`, B.env);
    const count = tasks(B.S).length;
    const closed = tasks(B.S).find((x) => x.id === id);
    const closedMd = /Closed \(1\)/.test(md(B.S));
    run(B.S, 'node harness/workaround.mjs log "copied the lane by hand because refresh failed on T-9" --cmd "npm run lanes -- refresh" --by overseer-2', B.env);
    const again = tasks(B.S).find((x) => x.id === id);
    return [bad.status !== 0 && builder.status !== 0 && ok.status === 0 && closed?.status === 'closed' && closed.closedBy === 'owner-1' && closedMd && again?.status === 'open' && /seen again/.test(again.reopenNote || '') && tasks(B.S).length === count, `${out(bad)}\n${out(builder)}\n${out(ok)}\n${JSON.stringify(again)}`];
  });

  // ---- C: measures and the export ------------------------------------------------------------------------------------
  const C = studio('c');
  await guard('271z measure: the impact report shows workarounds per day before -> after the upgrade, the top signatures and the trend ("fewer")', () => {
    const now = Date.now(); const up = now - 4 * DAY;
    const w = (ms, s) => ({ ts: iso(ms), type: 'harness.workaround', agent: 'overseer-3', status: 'warn', meta: { signature: s, sig: 'S1', detected: false } });
    addEvents(C.ev, [
      ...[1, 2, 3, 4, 5, 6].map((i) => w(up - i * 10 * 3600000, 'task done: re ran refused harness command task done')),
      { ts: iso(up), type: 'upgrade.merged', agent: 'upgrade', meta: { to: '8.0.0', from: '7.9.0' } },
      w(up + DAY, 'lock claim: used force lock claim'),
    ]);
    const r = run(C.S, 'node harness/autonomy.mjs impact --days 3 --json', C.env);
    let j = null; try { j = JSON.parse(r.stdout); } catch {}
    const txt = run(C.S, 'node harness/autonomy.mjs impact --days 3', C.env);
    const wk = j?.workarounds;
    return [wk && wk.before.n === 6 && wk.after.n === 1 && wk.verdict === 'fewer' && wk.top[0]?.signature === 'lock claim: used force lock claim' && /Workarounds per day/.test(out(txt)), `${out(r).slice(0, 1500)}\n${out(txt).slice(-800)}`];
  });
  await guard('271z measure: the digest shows workarounds in 24 h and per day, the top signatures and the open harness tasks', () => {
    run(C.S, 'node harness/workaround.mjs log "restarted the hub by hand because the War Room froze" --why "hub stopped answering" --cmd "npm run hub" --by overseer-3', C.env);
    const d = run(C.S, 'node harness/digest.mjs --print', C.env);
    return [d.status === 0 && /Workarounds: 1 in 24 h/.test(out(d)) && /\/day over 7 days/.test(out(d)) && /`hub: restarted hub hand/.test(out(d)) && /1 harness task open/.test(out(d)), out(d)];
  });
  await guard('271z export: `export --since 7d` writes one markdown file with the records, the tasks and the trend, and no secrets', () => {
    const r62 = (k) => { const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; let s = ''; for (const b of crypto.randomBytes(k)) s += a[b % 62]; return s; };
    const key = `${'sk-'}${'ant-'}${r62(40)}`;
    const hook = `https://discord.com/api/${'webhooks'}/${'1234567890'}${'12345678'}/${r62(68)}`;
    run(C.S, `node harness/workaround.mjs log "posted the report by hand with ${key} to ${hook}" --why "report post failed" --cmd "npm run report -- post --token ${key}" --by overseer-3`, C.env);
    const r = run(C.S, 'node harness/workaround.mjs export --since 7d', C.env);
    const dirE = path.join(C.S, '.studio', 'exports');
    const files = fs.existsSync(dirE) ? fs.readdirSync(dirE).filter((f) => /^harness-workarounds-.*\.md$/.test(f)) : [];
    const text = files.length ? fs.readFileSync(path.join(dirE, files[0]), 'utf8') : '';
    const recsText = fs.readFileSync(path.join(C.S, '.studio', 'workarounds.jsonl'), 'utf8');
    const leaked = [key, hook.split('/').pop()].some((s) => text.includes(s) || recsText.includes(s));
    return [r.status === 0 && files.length === 1 && !leaked && /\[removed\]/.test(text) && /restarted the hub by hand/.test(text) && /## Harness tasks/.test(text) && /8\.0\.0/.test(text), `files=${files.length} leaked=${leaked}\n${out(r)}\n${text.replace(/[A-Za-z0-9]{30,}/g, '<long>').slice(0, 1500)}`];
  });

  for (const x of [A, B, C]) { try { fs.rmSync(x.S, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }); } catch {} }
}
