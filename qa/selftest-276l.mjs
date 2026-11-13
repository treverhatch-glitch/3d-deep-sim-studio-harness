/**
 * qa/selftest-276l.mjs — 2.76.0 (helper l): the Communicator (harness/communicator.mjs), harness code that posts the
 * studio's status and alerts to the chat's webhook and tags who must act. No network: a local stand-in webhook.
 *   status    one fixed-format post from the harness's own data (agents and tasks, landed since the run's T0 and per hour,
 *             the train, the rig line, blocked, waiting on yes, beta mode), as "Studio Status", tagging no one; not again
 *             before STUDIO_COMM_STATUS_MIN; again after it
 *   alerts    a dead train, a stop file, the crew breaker and a harness error tag the orchestrator; a lane held for the
 *             owner's release tags the key holder; an ask tags the owner; all in one post, allowed_mentions only those ids
 *   dedup     the same alert isn't posted again within STUDIO_COMM_DEDUP_MIN; an open one is tagged again only after
 *             STUDIO_COMM_REPEAT_MIN; a closed one is named "Cleared" once
 *   beta      in beta mode the held lane and an ordinary ask go to the orchestrator (no key holder, no owner); an ask
 *             about scope still tags the owner
 *   quiet     STUDIO_COMM_QUIET holds an owner-only ask; a disaster (disk under STUDIO_COMM_DISK_GB) still tags the owner
 *             (and the orchestrator); after the quiet hours the held ask is posted
 *   disaster  3 crashes in an hour, everything blocked over STUDIO_COMM_BLOCKED_MIN (only with a supervisor running)
 *   line      the Line Producer's .studio/line/status.json: fewer builders than its target for 10 min tags the
 *             orchestrator; its absence is fine
 *   secret    comm -- status, preview and test never print the webhook or its token (masked "webhook ...<last 4>"); no
 *             event or state file holds it; preview shows mentions as @names; test posts one line tagging no one;
 *             launched agents don't get STUDIO_COMM_WEBHOOK
 *   failing   a webhook that refuses: the pass doesn't throw, tries again only after 5 minutes; the supervisor calls the
 *             pass each loop (source)
 *   split     a long post is cut into parts of at most 2000 characters at line ends, never inside a mention, each part's
 *             allowed_mentions naming only its own ids
 * Every check fails on 2.75.0 (no harness/communicator.mjs, no npm run comm).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest276L({ dir, run, report, tmpRoot }) {
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', env: gEnv(), windowsHide: true });
  const write = (rel, v) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v, null, 2)); };
  const rm = (rel) => fs.rmSync(path.join(dir, rel), { recursive: true, force: true });
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const events = path.join(dir, '.studio', 'events-276l.jsonl');
  const evs = () => { try { return fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const addEvent = (e) => fs.appendFileSync(events, `${JSON.stringify({ agent: 't', status: 'ok', meta: {}, ...e })}\n`);
  const TOKEN = `tok${'Wq8z'.repeat(10)}Ab3c`;
  const env = {
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_MAIN_ROOT: '', STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '',
    CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', STUDIO_PRODUCER_NAME: '', STUDIO_REPORT_WEBHOOK: '', STUDIO_COMM_WEBHOOK: '', STUDIO_COMM: '', STUDIO_REPORT_FORMAT: 'discord',
    STUDIO_COMM_STATUS_MIN: '', STUDIO_COMM_DEDUP_MIN: '', STUDIO_COMM_REPEAT_MIN: '', STUDIO_COMM_DISK_GB: '0', STUDIO_COMM_CRASHES: '', STUDIO_COMM_BLOCKED_MIN: '', STUDIO_COMM_STUCK_MIN: '',
    STUDIO_COMM_MIN_BUILDERS: '', STUDIO_COMM_QUIET: '', STUDIO_MACHINE_SCAN: 'off', STUDIO_DIGEST: 'off', STUDIO_HOOKS_CHECK: 'off', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-key-276l-${process.pid}.pem`),
    AGENT_EVENTS_FILE: events, AGENT_EVENTS_MIRROR: '', NODE_OPTIONS: '', ...ident,
  };
  let n = 0;
  const seen = [];
  const probe = (code, extra = {}) => {
    const f = path.join(tmpRoot, `p276l-${++n}-${process.pid}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node "${f}"`, { ...env, ...extra });
    fs.rmSync(f, { force: true });
    seen.push(out(r));
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return { ...JSON.parse(line), _out: out(r).slice(-3000) }; } catch { return { _out: out(r).slice(-3000) }; }
  };
  const T = Date.now();
  const pass = (at, extra = {}, passWhy = []) => probe(`import { communicatorPass } from ${u('harness/communicator.mjs')}; console.log(JSON.stringify(await communicatorPass({ now: ${at}, passWhy: ${JSON.stringify(passWhy)} })));`, extra);
  const R = (cmd, extra = {}) => { const r = run(dir, cmd, { ...env, ...extra }); seen.push(out(r)); return r; };

  // ---- the stand-in webhook: a separate process (the probes run with spawnSync), each request logged to a file ----
  const srvFile = path.join(tmpRoot, `hook-276l-${process.pid}.mjs`);
  fs.writeFileSync(srvFile, `import http from 'node:http'; import fs from 'node:fs';
const [log] = process.argv.slice(2);
http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
  fs.appendFileSync(log, JSON.stringify({ path: req.url, body: b }) + '\\n'); res.writeHead(204); res.end();
}); }).listen(0, '127.0.0.1', function () { console.log('listening ' + this.address().port); });
`);
  const hookLog = path.join(tmpRoot, `hook-276l-${process.pid}.jsonl`);
  fs.writeFileSync(hookLog, '');
  const srv = spawn(process.execPath, [srvFile, hookLog], { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve) => { let buf = ''; srv.stdout.on('data', (c) => { buf += c; const m = buf.match(/listening (\d+)/); if (m) resolve(Number(m[1])); }); setTimeout(() => resolve(0), 20000); });
  const HOOK = `http://127.0.0.1:${port}/api/webhooks/4242/${TOKEN}`;
  env.STUDIO_COMM_WEBHOOK = HOOK;
  const reqs = () => { try { return fs.readFileSync(hookLog, 'utf8').split('\n').filter(Boolean).map((l) => ({ ...l && JSON.parse(l), json: JSON.parse(JSON.parse(l).body || '{}') })); } catch { return []; } };
  const posts = () => reqs().map((r) => r.json);
  const clear = () => fs.writeFileSync(hookLog, '');
  const deadPid = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', windowsHide: true }).stdout.trim();
  const iso = (ms) => new Date(ms).toISOString();
  const fresh = () => {
    for (const x of ['.studio/comm', '.studio/locks', '.studio/train', '.studio/line', '.studio/agents', '.studio/STOP.json', '.studio/supervisor-stop', '.studio/crew-paused.json', '.studio/supervisor.json', 'studio/asks']) rm(x);
    fs.writeFileSync(events, ''); clear();
  };

  try {
    fs.mkdirSync(path.dirname(events), { recursive: true });
    for (const f of ['studio/beta.json', 'studio/delegation.json', 'studio/policy.json', 'studio/communicator.json']) rm(f);
    write('studio/communicator.json', { mentions: { orchestrator: '111111111111', keys: '222222222222', owner: '333333333333' }, names: { orchestrator: 'Orch', keys: 'Keyholder', owner: 'Boss' }, agents: { orchestrator: 'orch-1' } });
    g('init', '-q', '-b', 'main'); g('config', 'core.autocrlf', 'false'); g('add', '-A'); g('commit', '-qm', 'studio', '--no-verify');

    // ---- 1. status ----
    fresh();
    write('.studio/supervisor.json', { status: 'running', pid: process.pid, startedAt: iso(T - 2 * 3600000) });
    write('.studio/agents/builder-7.json', { agent: 'builder-7', role: 'builder', task: 'T-5', status: 'running', pid: process.pid });
    addEvent({ ts: iso(T - 3 * 3600000), type: 'task.done', task: 'T-1' });
    addEvent({ ts: iso(T - 90 * 60000), type: 'task.done', task: 'T-2' });
    addEvent({ ts: iso(T - 60 * 60000), type: 'task.done', task: 'T-3' });
    addEvent({ ts: iso(T - 50 * 60000), type: 'task.train.start', meta: { train: 'tr-a' } });
    addEvent({ ts: iso(T - 28 * 60000), type: 'task.train.done', msg: 'train tr-a: landed T-3', meta: { train: 'tr-a' } });
    const s1 = pass(T);
    const p1 = posts();
    const s2 = pass(T + 5 * 60000);
    const n2 = posts().length;
    const s3 = pass(T + 31 * 60000);
    const n3 = posts().length;
    const c1 = String(p1[0]?.content || '');
    await guard('276l status: one post as "Studio Status" from the harness data: the agent and its task, landed since the run\'s T0 (T-2, T-3, not T-1) at 1/h, the last train with its time and length, blocked, waiting on yes, beta mode off; no one tagged; not again 5 min later, again after STUDIO_COMM_STATUS_MIN (fails on 2.75.0: no communicator)', () => [
      s1.posted === true && s1.kind === 'status' && p1.length === 1 && p1[0].username === 'Studio Status' && /^Studio status /.test(c1) && /builder-7 T-5/.test(c1) && /Landed since \d\d:\d\d: 2 \(1\/h\): T-2, T-3/.test(c1) && !/T-1\b/.test(c1)
        && /Train: idle; last tr-a ended \d\d:\d\d after 22 min: landed T-3/.test(c1) && /Blocked: /.test(c1) && /Waiting on yes/.test(c1) && /Beta mode: off/.test(c1) && !/<@/.test(c1) && (p1[0].allowed_mentions?.users || []).length === 0 && (p1[0].allowed_mentions?.parse || []).length === 0
        && s2.posted === false && n2 === 1 && s3.posted === true && n3 === 2,
      JSON.stringify({ s1, s2, s3, n2, n3, c1 }, null, 1).slice(0, 2500)]);

    // ---- 2. alerts: who is tagged ----
    fresh();
    write('.studio/supervisor.json', { status: 'running', pid: process.pid, startedAt: iso(T - 3600000) });
    write('.studio/locks/train.lock', { pid: Number(deadPid), at: T - 20 * 60000, id: 'tr-dead', by: 'train' });
    write('.studio/STOP.json', { by: 'someone', reason: 'checking', at: iso(T) });
    write('.studio/crew-paused.json', { roles: { builder: { at: iso(T), why: '7 sessions, 0 landed' } } });
    write('.studio/train/queue.json', [{ task: 'T-40', head: 'abc', at: iso(T), held: { tier: 'C', why: 'changes a protected file' } }]);
    write('studio/asks/A-001.json', { id: 'A-001', status: 'open', question: 'Which color for the gate sign?', options: ['red', 'blue'], by: 'producer-1' });
    const a1 = pass(T, {}, ['error: boom in a pass']);
    const p2 = posts();
    const c2 = String(p2[0]?.content || '');
    const lineOf = (re) => c2.split('\n').find((l) => re.test(l)) || '';
    await guard('276l alerts: one post: the dead train, the stop file, the crew breaker and the harness error tag the orchestrator; the held lane tags the key holder; the ask tags the owner; allowed_mentions lists exactly those ids (fails on 2.75.0)', () => [
      a1.posted === true && p2.length === 1 && /^Studio alert /.test(c2)
        && /^<@111111111111> Train tr-dead died/.test(lineOf(/tr-dead/)) && /^<@111111111111> Stop file/.test(lineOf(/Stop file/)) && /^<@111111111111> Crew breaker/.test(lineOf(/Crew breaker/))
        && /^<@111111111111> Harness error.*boom/.test(lineOf(/boom/)) && /^<@222222222222> T-40 waits for the owner's release/.test(lineOf(/T-40 waits/)) && /^<@333333333333> Question A-001/.test(lineOf(/A-001/))
        && !/333333333333/.test(lineOf(/tr-dead|Stop file|Crew breaker|boom|T-40 waits/)) && JSON.stringify([...(p2[0].allowed_mentions?.users || [])].sort()) === JSON.stringify(['111111111111', '222222222222', '333333333333']),
      JSON.stringify({ a1, c2 }, null, 1).slice(0, 3000)]);

    // ---- 3. dedup, repeat, cleared ----
    const d1 = pass(T + 5 * 60000);
    const k1 = posts().length;
    rm('.studio/STOP.json');
    const d2 = pass(T + 31 * 60000);
    const c3 = String(posts()[k1]?.content || '');
    const k2 = posts().length;
    const d3 = pass(T + 125 * 60000);
    const c4 = String(posts()[k2]?.content || '');
    await guard('276l dedup: nothing again within STUDIO_COMM_DEDUP_MIN; at 31 min the status comes with "Cleared: stop:studio" and no open alert tagged again; at 125 min (STUDIO_COMM_REPEAT_MIN) the open ones are tagged again (fails on 2.75.0)', () => [
      d1.posted === false && k1 === 1 && d2.posted === true && d2.kind === 'status' && /Cleared: .*stop:studio/.test(c3) && !/<@/.test(c3) && /^Studio status /m.test(c3)
        && d3.posted === true && /alerts/.test(d3.kind) && /<@111111111111> Crew breaker/.test(c4) && /<@222222222222> T-40/.test(c4) && !/Cleared:.*stop:studio/.test(c4),
      JSON.stringify({ d1, d2, d3, c3: c3.slice(0, 600), c4: c4.slice(0, 900) }, null, 1)]);

    // ---- 4. beta mode ----
    fresh();
    write('.studio/train/queue.json', [{ task: 'T-41', head: 'abd', at: iso(T), held: { tier: 'B', why: 'tier B' } }]);
    write('studio/asks/A-002.json', { id: 'A-002', status: 'open', question: 'Which color for the gate sign?', by: 'producer-1' });
    write('studio/asks/A-003.json', { id: 'A-003', status: 'open', question: 'Cut the night level from the scope?', by: 'producer-1' });
    write('studio/beta.json', { on: true, by: 'owner-person', at: iso(T - 60000), why: 'beta', agents: ['orch-1'], roles: ['producer', 'director'] });
    g('add', '-A', 'studio/beta.json'); g('commit', '-qm', 'beta on', '--no-verify');
    const b1 = pass(T);
    const c5 = String(posts()[0]?.content || '');
    const l5 = (re) => c5.split('\n').find((l) => re.test(l)) || '';
    rm('studio/beta.json'); g('add', '-A', 'studio'); g('commit', '-qm', 'beta gone', '--no-verify');
    await guard('276l beta: in beta mode the held lane and an ordinary ask tag the orchestrator (not the key holder, not the owner); the ask about scope still tags the owner; the status says beta mode on (fails on 2.75.0)', () => [
      b1.posted === true && /^<@111111111111> T-41 waits.*beta mode/.test(l5(/T-41/)) && /^<@111111111111> Question A-002/.test(l5(/A-002/)) && /^<@333333333333> Question A-003/.test(l5(/A-003/)) && !/222222222222/.test(c5) && /Beta mode: on \(set by owner-person/.test(c5),
      c5.slice(0, 1500)]);

    // ---- 5. quiet hours ----
    fresh();
    write('studio/asks/A-004.json', { id: 'A-004', status: 'open', question: 'Which color for the gate sign?', by: 'producer-1' });
    const hm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
    const QUIET = `${hm(T - 60 * 60000)}-${hm(T + 60 * 60000)}`;
    const q1 = pass(T, { STUDIO_COMM_QUIET: QUIET, STUDIO_COMM_DISK_GB: '100000000' });
    const c6 = String(posts()[0]?.content || '');
    const k6 = posts().length;
    const q2 = pass(T + 70 * 60000, { STUDIO_COMM_QUIET: QUIET });
    const c7 = posts().slice(k6).map((p) => p.content).join('\n');
    await guard('276l quiet: inside STUDIO_COMM_QUIET the owner-only ask is held, the disk disaster still tags the owner and the orchestrator; after the quiet hours the held ask tags the owner (fails on 2.75.0)', () => [
      q1.posted === true && (q1.held || []).includes('ask:A-004') && !/<@\d+> Question A-004/.test(c6) && /^<@333333333333> <@111111111111> Disk low/m.test(c6) && q2.posted === true && /<@333333333333> Question A-004/.test(c7),
      JSON.stringify({ q1, q2, c6: c6.slice(0, 500), c7: c7.slice(0, 500) }, null, 1)]);

    // ---- 5b. disasters: everything blocked over STUDIO_COMM_BLOCKED_MIN, repeated crashes ----
    fresh();
    write('.studio/supervisor.json', { status: 'running', pid: process.pid, startedAt: iso(T - 3600000) });
    write('.studio/crew-paused.json', { roles: { builder: { at: iso(T), why: 'x' } } });
    for (const m of [3, 2, 1]) addEvent({ ts: iso(T - m * 60000), type: 'task.train.died', status: 'warn', msg: 'train 2026-x died (its process is gone)' }); // 2.81: was three hub restarts; the hub is gone
    const z1 = pass(T);
    const zc1 = posts().map((p) => p.content).join('\n');
    const z2 = pass(T + 61 * 60000);
    const zc2 = posts().map((p) => p.content).join('\n');
    await guard('276l disasters: 3 crashes in an hour (dead trains, halts) tag the owner and the orchestrator at once; no agent and no train with a blocker for over STUDIO_COMM_BLOCKED_MIN (supervisor running) tags them too, not before; without a supervisor it never does (fails on 2.75.0)', () => [
      z1.posted === true && /<@333333333333> <@111111111111> Repeated crashes: 3 in the last hour/.test(zc1) && !/Everything is blocked/.test(zc1) && /<@333333333333> <@111111111111> Everything is blocked for 61 min/.test(zc2)
        && !/Everything is blocked/.test(c7),
      `${zc1.slice(0, 600)}\n---\n${zc2.slice(-900)}`]);

    // ---- 6. the Line Producer's status ----
    fresh();
    write('.studio/line/status.json', { at: iso(T), builders: { running: 2, target: 5 }, blocked: [{ task: 'T-50', why: 'waits for T-49' }] });
    const ln1 = pass(T);
    const lp1 = posts().map((p) => p.content).join('\n');
    write('.studio/line/status.json', { at: iso(T + 11 * 60000), builders: { running: 2, target: 5 }, blocked: [{ task: 'T-50', why: 'waits for T-49' }] });
    const ln2 = pass(T + 11 * 60000);
    const lp2 = posts().map((p) => p.content).join('\n');
    rm('.studio/line'); rm('.studio/comm');
    const ln3 = pass(T + 12 * 60000);
    await guard('276l line: fewer builders than the Line Producer\'s target tags the orchestrator once it lasted 10 min (not on the first pass), with its blocked reasons; the status shows the line; no line status file is fine (fails on 2.75.0)', () => [
      ln1.posted === true && !/builders busy \(the Line/.test(lp1) && /Line Producer: 2 of 5 builders busy/.test(lp1) && /<@111111111111> Only 2 of 5 builders busy \(the Line Producer\).*T-50: waits for T-49/.test(lp2) && ln3.posted === true && !ln3.why,
      JSON.stringify({ ln1, ln2, ln3, lp2: lp2.slice(-700) }, null, 1)]);

    // ---- 7. the webhook stays secret; preview and test ----
    fresh();
    write('.studio/crew-paused.json', { roles: { builder: { at: iso(T), why: 'x' } } });
    const st = R('npm run comm --silent -- status');
    const stj = R('npm run comm --silent -- status --json');
    const pv = R('npm run comm --silent -- preview');
    const pvj = R('npm run comm --silent -- preview --json');
    clear();
    const ts = R('npm run comm --silent -- test');
    const tp = posts();
    pass(T);
    const ae = probe(`import { agentEnv } from ${u('harness/agent-env.mjs')}; const e = agentEnv({ tool: 'claude', role: 'builder', env: { PATH: '/bin', STUDIO_COMM_WEBHOOK: 'secret-hook', STUDIO_GATE_SLOTS: '1' } }); console.log(JSON.stringify({ has: 'STUDIO_COMM_WEBHOOK' in e, slots: e.STUDIO_GATE_SLOTS }));`);
    const stateText = (() => { try { return fs.readFileSync(path.join(dir, '.studio', 'comm', 'state.json'), 'utf8'); } catch { return ''; } })();
    const everything = `${seen.join('\n')}\n${fs.readFileSync(events, 'utf8')}\n${stateText}`;
    await guard('276l secret: comm -- status/preview/test print the webhook only as "webhook ...<last 4>", never the URL or its token; no event or state file holds it; preview shows @names, not ids, and sends nothing; test posts one line tagging no one; launched agents don\'t get STUDIO_COMM_WEBHOOK (fails on 2.75.0)', () => [
      st.status === 0 && /webhook \.\.\.Ab3c/.test(out(st)) && /@Orch/.test(out(st)) && stj.status === 0 && pv.status === 0 && /@Orch Crew breaker/.test(out(pv)) && !/<@111/.test(out(pv)) && /Nothing was sent/.test(out(pv))
        && JSON.parse(pvj.stdout).alerts.some((a) => a.who.includes('@Orch')) && ts.status === 0 && tp.length === 1 && /test/.test(tp[0].content) && (tp[0].allowed_mentions?.users || []).length === 0 && !/<@/.test(tp[0].content)
        && !everything.includes(TOKEN) && !everything.includes(HOOK) && evs().some((e) => e.type === 'comm.posted') && ae.has === false && ae.slots === '1',
      `${out(st)}\n${out(pv).slice(0, 600)}\n${out(ts)}\n${JSON.stringify(ae)}\nleak: ${everything.includes(TOKEN)}`]);

    // ---- 8. a failing webhook; the supervisor's call ----
    fresh();
    const closed = `http://127.0.0.1:1/api/webhooks/4242/${TOKEN}`;
    const f1 = pass(T, { STUDIO_COMM_WEBHOOK: closed });
    const f2 = pass(T + 60000, { STUDIO_COMM_WEBHOOK: closed });
    const f3 = pass(T + 6 * 60000);
    const sup = fs.readFileSync(path.join(dir, 'harness', 'supervisor.mjs'), 'utf8').replace(/\r\n/g, '\n');
    const tick = sup.slice(sup.indexOf('const tick = async'), sup.indexOf('await tick();'));
    await guard('276l failing: a refusing webhook doesn\'t throw (posted false, scrubbed why), isn\'t tried again within 5 minutes, posts after; the supervisor\'s loop calls communicatorPass each pass (fails on 2.75.0)', () => [
      f1.posted === false && f1.kind === 'status' && !String(f1.why || '').includes(TOKEN) && f2.kind === null && f3.posted === true && /communicatorPass\(\{ passWhy: r\.why \}\)/.test(tick) && !JSON.stringify([f1, f2]).includes(TOKEN),
      JSON.stringify({ f1, f2, f3 }, null, 1)]);

    // ---- 9. split ----
    const sp = probe(`import { commPayloads } from ${u('harness/communicator.mjs')}; const lines = []; for (let i = 0; i < 60; i++) lines.push('<@' + (100000 + i) + '> ' + 'word '.repeat(12)); lines.push('<@999999> ' + 'x'.repeat(2500) + ' <@888888> end'); const p = commPayloads(lines.join('\\n'), 'discord', {}); console.log(JSON.stringify({ n: p.length, max: Math.max(...p.map((x) => x.content.length)), broken: p.some((x) => /<@\\d*$/.test(x.content) || /^\\d*>/.test(x.content)), own: p.every((x) => (x.allowed_mentions.users || []).every((id) => x.content.includes('<@' + id + '>')) && [...x.content.matchAll(/<@(\\d+)>/g)].every((m) => x.allowed_mentions.users.includes(m[1]))), user: p.every((x) => x.username === 'Studio Status') }));`);
    await guard('276l split: a long post becomes parts of at most 2000 characters, never cut inside a mention, each part\'s allowed_mentions naming only its own ids, all as "Studio Status" (fails on 2.75.0)', () => [sp.n >= 3 && sp.max <= 2000 && sp.broken === false && sp.own === true && sp.user === true, JSON.stringify(sp)]);
  } finally {
    try { srv.kill(); } catch {}
    for (const f of [srvFile, hookLog]) { try { fs.rmSync(f, { force: true }); } catch {} }
  }
}
