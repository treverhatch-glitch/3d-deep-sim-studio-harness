/**
 * qa/selftest-268o.mjs — 2.68.0 (helper o): the crew watchdog, the futility cap (shadow first), the usage wind-down,
 * the temp-file janitor and the release impact report.
 *   crew      a role with more sessions in the last hour than STUDIO_CREW_MAX_SESSIONS and nothing landed isn't
 *             launched (crew.unhealthy with the evidence; digest and status --brief show it); a worker can't resume it,
 *             a person can; new work for the role clears it on its own.
 *   futility  a running session past the p90 of its type's good runs raises one futility.check (shadow: nothing
 *             stopped; its end logs what a cap would have saved); under 20 samples no cap; =on hands it back.
 *   winddown  at STUDIO_USAGE_WINDDOWN_PCT nothing new starts, .studio/restart-log.md names the running, queued and held
 *             work, and the usage reset resumes with the log linked; --now does it on demand.
 *   janitor   a dry run by default; --yes deletes only the harness's temp files (dead train scratch, old .studio/tmp,
 *             logs over budget, marked test temp folders, caches over budget); a lane copy with work is never deleted
 *             and stale lanes need --lanes --yes --by <a decider>; train/verify jobs start it.
 *   impact    `autonomy -- impact` finds the upgrade (event or version bump) and compares before vs after, "not enough
 *             data" under 30 items; the digest names the verdict.
 * A made-up studio; events written straight into its log.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest268O({ dir, run, report, tmpRoot }) {
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { windowsHide: true, cwd, encoding: 'utf8' });
  const write = (base, rel, text) => { fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true }); fs.writeFileSync(path.join(base, rel), text); };
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const events = path.join(dir, '.studio', 'events-268o.jsonl');
  const evs = () => { try { return fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const addEv = (list) => fs.appendFileSync(events, list.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const iso = (ms) => new Date(ms).toISOString();
  const env = {
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_MAIN_ROOT: '', STUDIO_LOCK_OWNER: '',
    STUDIO_ROLE: '', CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', STUDIO_RAM_FLOOR_GB: '0', STUDIO_QUOTA_PROBE: 'off',
    STUDIO_CREW_WATCH: '', STUDIO_CREW_MAX_SESSIONS: '', STUDIO_FUTILITY: '', STUDIO_FUTILITY_MIN_N: '', STUDIO_USAGE_WINDDOWN_PCT: '',
    STUDIO_JANITOR: 'off', STUDIO_CACHE_MAX_GB: '', STUDIO_IMPACT_MIN_N: '', STUDIO_DAILY_TOKEN_CAP: 'off', STUDIO_LAUNCH_LOCK_SEC: '1',
    STUDIO_AGENT_TOOL: 'claude', STUDIO_BUILDER_CMD: '', STUDIO_AGENT_CMD: '', STUDIO_CACHE_READ_WEIGHT: '', STUDIO_NO_WORK_EXITS: '',
    AGENT_EVENTS_FILE: events, AGENT_EVENTS_MIRROR: '', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
  };
  let n = 0;
  const probe = (code, extra = {}) => {
    const f = path.join(tmpRoot, `p268o-${++n}-${process.pid}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node "${f}"`, { ...env, ...extra });
    fs.rmSync(f, { force: true });
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return { ...JSON.parse(line), _out: out(r).slice(-3000) }; } catch { return { _out: out(r).slice(-3000) }; }
  };
  // One supervisor pass with stub launcher functions: what it started and why.
  const pass = (extra = {}, sessionsJson = '[]') => probe(`import { supervise } from ${u('harness/supervisor.mjs')};
const started = []; const paused = [];
const deps = { sessions: () => ${sessionsJson}, startAgent: (o) => { started.push(o.role + ':' + o.task); return { ok: true }; }, launchableRoles: (r) => r.filter((x) => x === 'builder'), nextAgentName: (role) => role + '-z' + Math.random().toString(36).slice(2, 6), pauseAgent: (a) => { paused.push(a); return { ok: true }; } };
const r = await supervise({ deps }, { startedAt: Date.now() - 1000, names: [] });
console.log(JSON.stringify({ started, paused, why: r.why || [] }));`, extra);

  // ---- the studio: a git checkout on main with a board ----
  for (const d of ['.studio/agents', '.studio/train', '.lanes', '.studio/tmp']) fs.rmSync(path.join(dir, d), { recursive: true, force: true });
  for (const f of ['studio/task-holds.json', 'studio/budget.json', '.studio/crew-paused.json', '.studio/winddown.json', '.studio/futility.json', '.studio/tool-quota.json']) fs.rmSync(path.join(dir, f), { force: true });
  fs.mkdirSync(path.dirname(events), { recursive: true });
  fs.writeFileSync(events, '');
  g(dir, 'init', '-q', '-b', 'main'); g(dir, 'config', 'core.autocrlf', 'false');
  g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'studio', '--no-verify');
  const addTask = (title, role = 'builder') => (out(run(dir, `node harness/task.mjs add "${title}" --role ${role} --priority P1`, env)).match(/"id": "(T-\d+)"/) || [])[1];
  const t1 = addTask('Make the crate stack');
  const now = Date.now();

  // ---- crew watchdog ----
  {
    const burn = [];
    for (let i = 0; i < 8; i += 1) {
      const a = `builder-b${i}`; const t0 = now - 50 * 60000 + i * 5 * 60000;
      burn.push({ ts: iso(t0), type: 'agent.session.start', agent: a, task: t1, meta: { role: 'builder' } });
      burn.push({ ts: iso(t0 + 40000), type: 'agent.session.end', agent: a, tokensIn: 40000, tokensOut: 2000, meta: { role: 'builder', tool: 'claude', outcome: { task: t1, claimed: false, commits: 0, done: false, noWork: true, counts: true, why: 'its task start was refused: board lock busy' } } });
    }
    addEv(burn);
    const p1 = pass();
    const un = evs().filter((e) => e.type === 'crew.unhealthy').pop();
    await guard('268o crew: 8 builder sessions in an hour with 0 landed: the supervisor launches no builder and emits crew.unhealthy with the evidence', () => [
      !(p1.started || []).some((x) => x.startsWith('builder:')) && un?.meta?.role === 'builder' && un.meta.sessions === 8 && un.meta.noCommit === 8 && un.meta.shortExits === 8 && un.meta.landed === 0 && /resume builder/.test(un.msg) && (p1.why || []).some((w) => /crew watchdog/.test(w)),
      JSON.stringify({ p1, un }).slice(0, 2500)]);
    const brief = probe(`import { briefFacts, briefText } from ${u('harness/brief-status.mjs')}; import { needsPerson } from ${u('harness/digest.mjs')};
const f = await briefFacts({ since: new Date(Date.now() - 3600000).toISOString() }); const need = await needsPerson();
console.log(JSON.stringify({ text: briefText(f), need: need.filter((x) => x.kind === 'crew').map((x) => x.line) }));`);
    await guard('268o crew: status --brief and the digest name the paused role', () => [/crew paused[^\n]*builder/.test(brief.text || '') && (brief.need || []).some((l) => /builder paused/.test(l)), JSON.stringify(brief).slice(0, 1500)]);
    const w = run(dir, 'node harness/crew-watch.mjs resume builder --by builder-s3', env);
    const ag = run(dir, 'node harness/crew-watch.mjs resume builder --by tester', { ...env, CLAUDECODE: '1' });
    const ok = run(dir, 'node harness/crew-watch.mjs resume builder --by tester --why "fixed the board lock"', env);
    const p2 = pass();
    const res = evs().filter((e) => e.type === 'crew.resumed').pop();
    await guard('268o crew: a worker can\'t resume a paused role, an agent needs a person\'s permission, a person can (crew.resumed names them, the role launches again)', () => [
      w.status !== 0 && /worker/.test(out(w)) && ag.status !== 0 && /permission/.test(out(ag)) && ok.status === 0 && res?.meta?.by === 'tester' && (p2.started || []).some((x) => x.startsWith('builder:')),
      `${out(w)}\n${out(ag)}\n${out(ok)}\n${JSON.stringify({ p2, res })}`.slice(0, 2500)]);
    // Paused again (a fresh burst), then new work for the role clears it.
    const burn2 = [];
    const s2 = Date.now();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200); // the burst lies between the resume and now
    for (let i = 0; i < 8; i += 1) {
      const a = `builder-c${i}`; const t0 = s2 + 50 + i * 100;
      burn2.push({ ts: iso(t0), type: 'agent.session.start', agent: a, task: t1, meta: { role: 'builder' } });
      burn2.push({ ts: iso(t0 + 20), type: 'agent.session.end', agent: a, meta: { role: 'builder', tool: 'claude', outcome: { task: t1, commits: 0, done: false, noWork: true, counts: true, why: 'never claimed' } } });
    }
    addEv(burn2);
    const p3 = pass();
    const t2 = addTask('Paint the crate stack');
    const p4 = pass();
    const cleared = evs().filter((e) => e.type === 'crew.resumed' && e.meta?.by === 'supervisor').pop();
    await guard('268o crew: the pause clears on its own when new work for the role appears', () => [
      !p3.started?.some((s) => s.startsWith('builder:')) && p4.started?.some((s) => s.startsWith('builder:')) && new RegExp(t2).test(cleared?.meta?.cleared || ''),
      JSON.stringify({ p3, p4, cleared }).slice(0, 2500)]);
    fs.rmSync(path.join(dir, '.studio', 'crew-paused.json'), { force: true });
  }

  // ---- futility cap ----
  {
    fs.writeFileSync(events, '');
    const base = now - 3 * 86400000;
    const good = [{ ts: iso(base - 1000), type: 'task.added', task: 'T-900', meta: { type: 'change' } }];
    for (let i = 0; i < 20; i += 1) {
      const a = `builder-g${i}`; const t = `T-${700 + i}`; const t0 = base + i * 3600000;
      good.push({ ts: iso(t0 - 10), type: 'task.added', task: t, meta: { type: 'change' } });
      good.push({ ts: iso(t0), type: 'agent.session.start', agent: a, task: t, meta: { role: 'builder' } });
      good.push({ ts: iso(t0 + 600000), type: 'agent.session.end', agent: a, tokensIn: 10000 + i * 100, tokensOut: 0, meta: { role: 'builder', tool: 'claude', outcome: { task: t, done: true, commits: 1 } } });
    }
    addEv(good);
    const log = path.join(dir, '.studio', 'agents', 'builder-f1.log');
    write(dir, '.studio/agents/builder-f1.log', `${JSON.stringify({ message: { id: 'm1', usage: { input_tokens: 50000, output_tokens: 1000 } } })}\n`);
    const sess = JSON.stringify([{ agent: 'builder-f1', role: 'builder', task: 'T-900', running: true, startedAt: new Date(now - 5 * 60000).toISOString(), log: path.relative(dir, log) }]);
    const mod = (extra) => probe(`import { futilityPass } from ${u('harness/futility.mjs')}; import { readRecentEvents } from ${u('harness/event.mjs')};
const paused = [];
const r = futilityPass({ sessions: ${sess}, events: readRecentEvents(5000), pause: (a) => { paused.push(a); return { ok: true }; } });
console.log(JSON.stringify({ checks: r.checks.length, paused, mode: r.mode }));`, extra);
    const few = mod({ STUDIO_FUTILITY_MIN_N: '21' });
    await guard('268o futility: under the minimum of successful sessions (20) there is no cap', () => [few.checks === 0 && !evs().some((e) => e.type === 'futility.check'), JSON.stringify(few)]);
    const p = pass({}, sess);
    const chk = evs().filter((e) => e.type === 'futility.check');
    await guard('268o futility: a running session past the p90 of its type\'s good runs raises one Check, "past the p90 of good runs", and in shadow mode nothing is stopped', () => [
      chk.length === 1 && /past the p90 of good runs/.test(chk[0].msg) && chk[0].meta.type === 'change' && chk[0].meta.n === 20 && (p.paused || []).length === 0 && /Shadow mode/.test(chk[0].msg),
      JSON.stringify({ p, chk }).slice(0, 2000)]);
    const again = pass({}, sess);
    addEv([{ ts: iso(Date.now() + 5), type: 'agent.session.end', agent: 'builder-f1', tokensIn: 90000, tokensOut: 1000, meta: { role: 'builder', tool: 'claude', outcome: { task: 'T-900', done: false, commits: 0, noWork: true } } }]);
    const endPass = mod({});
    const sh = evs().filter((e) => e.type === 'futility.shadow').pop();
    const logged = (() => { try { return fs.readFileSync(path.join(dir, '.studio', 'futility-log.jsonl'), 'utf8'); } catch { return ''; } })();
    await guard('268o futility: once per session; its end logs what a cap would have saved (tokens, minutes, a good run cut short or not)', () => [
      evs().filter((e) => e.type === 'futility.check').length === 1 && sh?.meta?.savedTokens === 40000 && sh.meta.cutGoodRun === false && /would have saved 40,000 tokens/.test(sh.msg) && /"savedTokens":40000/.test(logged),
      JSON.stringify({ again, endPass, sh, logged }).slice(0, 2000)]);
    fs.rmSync(path.join(dir, '.studio', 'futility.json'), { force: true });
    const on = mod({ STUDIO_FUTILITY: 'on' });
    await guard('268o futility: STUDIO_FUTILITY=on hands the task back through the launcher\'s pause (diff kept)', () => [on.checks === 1 && (on.paused || []).includes('builder-f1'), JSON.stringify(on)]);
    fs.rmSync(path.join(dir, '.studio', 'futility.json'), { force: true });
    fs.writeFileSync(events, '');
  }

  // ---- usage wind-down ----
  {
    write(dir, 'studio/budget.json', `${JSON.stringify({ order: ['claude'], tools: { claude: { weeklyTokens: 1000, resetDay: 'monday' } } }, null, 2)}\n`);
    addEv([{ ts: iso(Date.now() - 1000), type: 'agent.session.end', agent: 'builder-u1', tokensIn: 950, tokensOut: 0, meta: { role: 'builder', tool: 'claude' } }]);
    run(dir, `node harness/task.mjs hold ${t1} --by tester --why "waits for the art pass"`, env);
    // A running session for the restart log.
    const live = JSON.stringify([{ agent: 'builder-u2', role: 'builder', task: 'T-901', running: true }]);
    const off = pass({}, live);
    const wd = pass({ STUDIO_USAGE_WINDDOWN_PCT: '90' }, live);
    const logText = (() => { try { return fs.readFileSync(path.join(dir, '.studio', 'restart-log.md'), 'utf8'); } catch { return ''; } })();
    const ev = evs().filter((e) => e.type === 'studio.winddown').pop();
    await guard('268o winddown: unset it does nothing; at STUDIO_USAGE_WINDDOWN_PCT the supervisor starts nothing new, writes .studio/restart-log.md (running, queued, held, next steps) and an event', () => [
      !/winding down/.test((off.why || []).join(' ')) && (wd.started || []).length === 0 && /winding down/.test((wd.why || []).join(' ')) && ev?.meta?.file === '.studio/restart-log.md' && /builder-u2/.test(logText) && /## Queued/.test(logText) && new RegExp(`${t1}: waits for the art pass`).test(logText) && /## Next steps/.test(logText),
      JSON.stringify({ off, wd, ev }).slice(0, 1500) + logText.slice(0, 800)]);
    write(dir, 'studio/budget.json', `${JSON.stringify({ order: ['claude'], tools: { claude: { weeklyTokens: 100000, resetDay: 'monday' } } }, null, 2)}\n`);
    run(dir, `node harness/task.mjs unhold ${t1} --by tester`, env);
    // The pass before the wind-down started T-003 (its launch lock lasts STUDIO_LAUNCH_LOCK_SEC, 120 s). A fast machine
    // reaches this pass inside that window and is told "T-003 is being started by builder-z..." (CI release-gate,
    // 2.68.0); this check is about the resume, so the earlier launch's lock is cleared first.
    try { for (const f of fs.readdirSync(path.join(dir, '.studio', 'locks'))) if (/^launch/.test(f)) fs.rmSync(path.join(dir, '.studio', 'locks', f), { force: true }); } catch {}
    const back = pass({ STUDIO_USAGE_WINDDOWN_PCT: '90' });
    const rs = evs().filter((e) => e.type === 'studio.winddown_resumed').pop();
    await guard('268o winddown: when the usage resets the supervisor resumes and links the restart log', () => [
      rs?.meta?.restartLog === '.studio/restart-log.md' && /restart-log\.md/.test(rs.msg) && (back.started || []).length > 0 && !fs.existsSync(path.join(dir, '.studio', 'winddown.json')),
      `${JSON.stringify({ rs: rs ? { msg: rs.msg, meta: rs.meta } : null, winddown: fs.existsSync(path.join(dir, '.studio', 'winddown.json')) })}\n--- back: ${JSON.stringify(back).slice(0, 1500)}`]);
    const worker = run(dir, 'node harness/winddown.mjs --now --by builder-s2', env);
    const now1 = run(dir, 'node harness/winddown.mjs --now --by tester --why "the owner travels"', env);
    const p5 = pass();
    const offW = run(dir, 'node harness/winddown.mjs --off --by builder-s2', env);
    const offOk = run(dir, 'node harness/winddown.mjs --off --by tester', env);
    await guard('268o winddown: studio:winddown --now does it on demand (not for a worker); --off ends it (a decider only)', () => [
      worker.status !== 0 && now1.status === 0 && (p5.started || []).length === 0 && /winding down/.test((p5.why || []).join(' ')) && offW.status !== 0 && offOk.status === 0 && !fs.existsSync(path.join(dir, '.studio', 'winddown.json')) && JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts['studio:winddown'],
      `${out(worker)}\n${out(now1)}\n${JSON.stringify(p5)}\n${out(offW)}\n${out(offOk)}`.slice(0, 2000)]);
    fs.rmSync(path.join(dir, 'studio', 'budget.json'), { force: true });
  }

  // ---- janitor ----
  {
    const jenv = { ...env, STUDIO_JANITOR_TMPDIR: path.join(tmpRoot, `systmp-268o-${process.pid}`), STUDIO_JANITOR_KEEP_LOGS: '2', STUDIO_JANITOR_LANE_H: '0', STUDIO_LANE_LIVE_MIN: '0', STUDIO_CACHE_MAX_GB: String(3000 / 1024 ** 3) };
    const old = (p) => { const t = (Date.now() - 3 * 86400000) / 1000; fs.utimesSync(p, t, t); };
    // .studio/tmp: one old, one new.
    write(dir, '.studio/tmp/old.txt', 'x'.repeat(100)); old(path.join(dir, '.studio/tmp/old.txt'));
    write(dir, '.studio/tmp/new.txt', 'y');
    // Train logs: five, keep two.
    for (let i = 1; i <= 5; i += 1) { write(dir, `.studio/train/tr${i}-verify-1.log`, `log ${i}`); const t = (Date.now() - (10 - i) * 60000) / 1000; fs.utimesSync(path.join(dir, `.studio/train/tr${i}-verify-1.log`), t, t); }
    // Marked temp folders: this studio's (old, its process gone), another studio's, and an unmarked one.
    const sys = jenv.STUDIO_JANITOR_TMPDIR;
    write(sys, 'mine/a.txt', 'a'); fs.writeFileSync(path.join(sys, 'mine', '.studio-temp.json'), JSON.stringify({ studio: dir, pid: 999999, at: new Date(Date.now() - 3 * 86400000).toISOString() }));
    write(sys, 'other/a.txt', 'a'); fs.writeFileSync(path.join(sys, 'other', '.studio-temp.json'), JSON.stringify({ studio: path.join(tmpRoot, 'another-studio'), pid: 999999, at: new Date(Date.now() - 3 * 86400000).toISOString() }));
    write(sys, 'plain/a.txt', 'a');
    // Caches: two 2 KB entries over a 3 KB budget: the older goes.
    write(dir, '.studio/unity-cache/p--old/Library/x.bin', 'o'.repeat(2048)); old(path.join(dir, '.studio/unity-cache/p--old'));
    write(dir, '.studio/unity-cache/p--new/Library/x.bin', 'n'.repeat(2048));
    // Train scratch copies: a dead train's (clean) and one with an uncommitted change.
    const sc = probe(`import { makeScratch } from ${u('harness/train.mjs')};
const a = makeScratch(process.cwd(), '901', 'HEAD'); const b = makeScratch(process.cwd(), '902', 'HEAD');
console.log(JSON.stringify({ a: a.error || a.dir, b: b.error || b.dir }));`);
    if (sc.b && fs.existsSync(sc.b)) fs.writeFileSync(path.join(sc.b, 'wip.txt'), 'half done');
    // Lane copies: one with an unmerged commit, one with an uncommitted change, one whose task is held, one stale.
    const mk = (agent, task) => probe(`import { createLaneCopy } from ${u('harness/worktree.mjs')}; console.log(JSON.stringify(createLaneCopy(${JSON.stringify(agent)}, { task: ${JSON.stringify(task)} })));`);
    const tw = addTask('Lane work');
    const th = addTask('Held lane');
    for (const [a, t] of [['builder-work', tw], ['builder-dirty', tw], ['builder-held', th], ['builder-stale', null]]) {
      mk(a, t);
      write(dir, `.studio/agents/${a}.json`, JSON.stringify({ agent: a, role: 'builder', task: t, status: 'done' }));
    }
    const lane = (a) => path.join(dir, '.lanes', a);
    write(lane('builder-work'), 'docs/work.md', 'work\n'); g(lane('builder-work'), 'add', '-A'); g(lane('builder-work'), 'commit', '-qm', 'work', '--no-verify');
    write(lane('builder-dirty'), 'docs/dirty.md', 'dirty\n');
    run(dir, `node harness/task.mjs hold ${th} --by tester --why "lands after the art pass"`, env);
    const exists = (p) => fs.existsSync(p);
    const dry = run(dir, 'node harness/janitor.mjs', jenv);
    await guard('268o janitor: a dry run by default: it lists what and how much and deletes nothing', () => [
      dry.status === 0 && /Dry run/.test(out(dry)) && /would delete \.studio\/tmp\/old\.txt/.test(out(dry)) && exists(path.join(dir, '.studio/tmp/old.txt')) && exists(path.join(sys, 'mine')) && exists(sc.a || 'x'),
      out(dry).slice(0, 2500)]);
    const yes = run(dir, 'node harness/janitor.mjs --yes', jenv);
    const jr = evs().filter((e) => e.type === 'janitor.run').pop();
    await guard('268o janitor: --yes deletes only the harness\'s temp files (old .studio/tmp, logs beyond the budget, this studio\'s marked temp folder, the oldest cache over budget, a dead train\'s clean scratch copy) and keeps the rest', () => [
      yes.status === 0 && !exists(path.join(dir, '.studio/tmp/old.txt')) && exists(path.join(dir, '.studio/tmp/new.txt'))
        && ['tr1', 'tr2', 'tr3'].every((t) => !exists(path.join(dir, `.studio/train/${t}-verify-1.log`))) && ['tr4', 'tr5'].every((t) => exists(path.join(dir, `.studio/train/${t}-verify-1.log`)))
        && !exists(path.join(sys, 'mine')) && exists(path.join(sys, 'other')) && exists(path.join(sys, 'plain'))
        && !exists(path.join(dir, '.studio/unity-cache/p--old')) && exists(path.join(dir, '.studio/unity-cache/p--new'))
        && sc.a && !exists(sc.a) && sc.b && exists(path.join(sc.b, 'wip.txt'))
        && ['builder-work', 'builder-dirty', 'builder-held', 'builder-stale'].every((a) => exists(lane(a))) && jr?.meta?.deleted >= 7 && jr.meta.freedBytes > 0,
      `${out(yes)}\n${JSON.stringify({ sc, jr })}`.slice(0, 3000)]);
    const props = run(dir, 'node harness/janitor.mjs --lanes', jenv);
    const wk = run(dir, 'node harness/janitor.mjs --lanes --yes --by builder-s4', jenv);
    const staleKept = exists(lane('builder-stale'));
    const del = run(dir, 'node harness/janitor.mjs --lanes --yes --by tester', jenv);
    await guard('268o janitor: stale lanes are proposals; a worker can\'t delete them; a person deletes only the stale clean one, NEVER a lane with commits not on main, uncommitted changes or a held task', () => [
      /proposed \.lanes\/builder-stale/.test(out(props)) && staleKept && wk.status !== 0 && /worker/.test(out(wk))
        && del.status === 0 && !exists(lane('builder-stale')) && exists(path.join(lane('builder-work'), 'docs', 'work.md')) && exists(path.join(lane('builder-dirty'), 'docs', 'dirty.md')) && exists(lane('builder-held'))
        && /kept \.lanes\/builder-work: 1 commit\(s\) not on main/.test(out(del)) && /kept \.lanes\/builder-dirty: it has uncommitted changes/.test(out(del)) && new RegExp(`kept \\.lanes/builder-held: its task ${th} is held`).test(out(del)),
      `${out(props)}\n${out(wk)}\n${out(del)}`.slice(0, 3000)]);
    const est = probe(`import { janitorEstimate, janitorFreeableGb, freeableGb } from ${u('harness/janitor.mjs')}; import fs from 'node:fs';
fs.mkdirSync('.studio/tmp', { recursive: true }); fs.writeFileSync('.studio/tmp/est.bin', 'e'.repeat(5000)); const t = (Date.now() - 3 * 86400000) / 1000; fs.utimesSync('.studio/tmp/est.bin', t, t);
const e = janitorEstimate(); const g = janitorFreeableGb({ root: process.cwd() }); const still = fs.existsSync('.studio/tmp/est.bin');
console.log(JSON.stringify({ ...e, g, alias: freeableGb === janitorFreeableGb, still }));`, { ...jenv });
    const hook = probe(`import { jobDone } from ${u('harness/jobs.mjs')}; jobDone({ kind: 'verify', code: 0 }); import fs from 'node:fs';
console.log(JSON.stringify({ stamp: fs.existsSync(${JSON.stringify(path.join(dir, '.studio', 'janitor-last.json'))}) }));`, { ...jenv, STUDIO_JANITOR: '' });
    await guard('268o janitor: a verify job starts it on its own (throttled stamp), and the disk monitor estimate (janitorEstimate, janitorFreeableGb) never deletes anything', () => [hook.stamp === true && est.bytes >= 5000 && /the janitor can free/.test(est.line) && typeof est.g === 'number' && est.alias && est.still, JSON.stringify({ hook, est })]);
    const t0 = Date.now(); while (Date.now() - t0 < 1500) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }

  // ---- release impact ----
  {
    fs.writeFileSync(events, '');
    const up = Date.now() - 3 * 86400000;
    const list = [{ ts: iso(up), type: 'upgrade.merged', agent: 'tester', meta: { from: '9.8.0', to: '9.9.0', commit: 'abc' } }];
    for (let i = 0; i < 35; i += 1) {
      const tb = up - 2.5 * 86400000 + i * 3600000;
      list.push({ ts: iso(tb), type: 'task.done', task: `T-${100 + i}`, agent: 'b' });
      list.push({ ts: iso(tb + 1), type: 'task.train.verify', meta: { ms: 20 * 60000, ok: i % 2 === 0 } });
    }
    for (let i = 0; i < 60; i += 1) {
      const ta = up + 3600000 + i * 1500000;
      list.push({ ts: iso(ta), type: 'task.done', task: `T-${200 + i}`, agent: 'b' });
      list.push({ ts: iso(ta + 1), type: 'task.train.verify', meta: { ms: 10 * 60000, ok: true } });
    }
    for (let i = 0; i < 10; i += 1) list.push({ ts: iso(up + 7200000 + i), type: 'agent.session.end', agent: `x${i}`, meta: { role: 'builder', outcome: { noWork: true } } });
    addEv(list);
    const r = run(dir, 'node harness/autonomy.mjs impact --days 3 --json', env);
    let j = {}; try { j = JSON.parse(r.stdout); } catch {}
    const row = (k) => (j.rows || []).find((x) => x.key === k) || {};
    await guard('268o impact: autonomy -- impact finds the upgrade and compares before vs after (landed per hour, verify p50/p90, red verify %), "not enough data" under 30 items', () => [
      r.status === 0 && j.release === '9.9.0' && row('landedPerHour').verdict === 'better' && row('verifyP50Min').verdict === 'better' && row('verifyP90Min').verdict === 'better' && row('redVerifyPct').verdict === 'better'
        && /not enough data/.test(row('noWorkPct').verdict) && /not enough data/.test(row('tokensPerKept').verdict) && j.verdict === 'better',
      `${out(r)}`.slice(0, 3000)]);
    const dg = probe(`import { impactDigestLine } from ${u('harness/impact.mjs')}; import { buildDigest } from ${u('harness/digest.mjs')};
const d = await buildDigest({ now: ${up} + 3 * 86400000 - 1000 });
console.log(JSON.stringify({ line: impactDigestLine({ now: ${up} + 3 * 86400000 - 1000 }), digest: d.text }));`);
    const miss = run(dir, 'node harness/autonomy.mjs impact --release 1.2.3', env);
    // A version bump in git counts as an upgrade too.
    const pk = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ ...pk, version: '9.9.1' }, null, 2)}\n`);
    g(dir, 'commit', '-qam', 'bump', '--no-verify');
    const bump = run(dir, 'node harness/autonomy.mjs impact --release 9.9.1 --json', env);
    let jb = {}; try { jb = JSON.parse(bump.stdout); } catch {}
    await guard('268o impact: a missing release says so; a package.json version bump is found as an upgrade; the digest names the verdict once enough data exists', () => [
      miss.status !== 0 && /no upgrade to 1\.2\.3/.test(out(miss)) && jb.release === '9.9.1' && jb.source === 'version bump' && /Upgrade 9\.9\.0[^\n]*better/.test(dg.digest || ''),
      `${out(miss)}\n${out(bump).slice(0, 800)}\n${JSON.stringify(dg).slice(0, 1500)}`]);
  }
}
