/**
 * qa/selftest-264l.mjs — 2.64.0 (l): thread subscription, pass-through and the trigger table, shadow mode first
 * (harness/threads.mjs, studio/triggers.json, the per-task inbox, the inbox-notice hook, hub /api/inbox's task key).
 * Made-up studio: the example board's T-001..T-005, made-up shas, branches and train ids.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest264L({ dir, run, report, tmpRoot }) {
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const base = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_ROLE: '', STUDIO_LOCK_OWNER: '', STUDIO_THREADS: '' };
  const probe = (name, code, env = {}) => {
    const f = path.join(dir, `.probe-264l-${name}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node ${path.basename(f)}`, { ...base, ...env });
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return { ...JSON.parse(line), _err: r.stderr }; } catch { return { _raw: out(r).slice(-1500) }; }
  };
  const evFile = (n) => path.join(dir, '.studio', `events-264l-${n}.jsonl`);
  const events = (n) => { try { return fs.readFileSync(evFile(n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const inbox = (id) => { try { return fs.readFileSync(path.join(dir, 'studio', 'handoffs', `${id}.inbox.md`), 'utf8'); } catch { return ''; } };
  const producerInbox = () => { try { return fs.readFileSync(path.join(dir, 'studio', 'producer', 'INBOX.md'), 'utf8'); } catch { return ''; } };
  const fresh = () => {
    for (const f of ['.studio/threads.json']) fs.rmSync(path.join(dir, f), { force: true });
    fs.rmSync(path.join(dir, '.studio', 'inbox-notice'), { recursive: true, force: true });
    for (const id of ['T-001', 'T-002', 'T-003', 'T-004', 'T-005']) fs.rmSync(path.join(dir, 'studio', 'handoffs', `${id}.inbox.md`), { force: true });
    fs.rmSync(path.join(dir, 'studio', 'producer', 'INBOX.md'), { force: true });
  };
  const emit = (n, list, env = {}) => probe(`emit-${n}`, `import { emitEvent } from ${u('harness/event.mjs')};
const out = []; for (const e of ${JSON.stringify(list)}) out.push(emitEvent(e).id);
console.log(JSON.stringify({ ids: out }));`, { AGENT_EVENTS_FILE: evFile(n), ...env });
  const thread = (n, args, env = {}) => run(dir, `node harness/threads.mjs ${args}`, { ...base, AGENT_EVENTS_FILE: evFile(n), ...env });
  const trigFile = path.join(dir, 'studio', 'triggers.json');
  // Change studio/triggers.json for one step (put back after; on an old harness without the file, removed after).
  const setTriggers = (edit) => {
    const was = fs.existsSync(trigFile) ? fs.readFileSync(trigFile, 'utf8') : null;
    const t = was ? JSON.parse(was) : { sources: {} };
    t.sources = t.sources || {};
    edit(t);
    fs.writeFileSync(trigFile, JSON.stringify(t, null, 2));
    return () => (was === null ? fs.rmSync(trigFile, { force: true }) : fs.writeFileSync(trigFile, was));
  };
  const nextBefore = fs.readFileSync(path.join(dir, 'studio', 'NEXT.md'), 'utf8');
  const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' });
  if (!fs.existsSync(path.join(dir, '.git'))) { g('init', '-q', '-b', 'main'); g('add', '-A'); g('commit', '-qm', 'studio', '--no-verify'); }

  // A fake gh: CI on any sha is red, also after its one re-run.
  const fakeGh = path.join(tmpRoot, `fake-gh-264l-${process.pid}.mjs`);
  fs.writeFileSync(fakeGh, `import fs from 'node:fs';
const a = process.argv.slice(2); const st = ${JSON.stringify(path.join(dir, 'gh-264l.json'))};
const s = fs.existsSync(st) ? JSON.parse(fs.readFileSync(st, 'utf8')) : { lists: 0 };
if (a[0] === '--version') { console.log('gh version 0'); process.exit(0); }
if (a[0] === 'run' && a[1] === 'rerun') process.exit(0);
if (a[0] === 'run' && a[1] === 'list') { s.lists++; fs.writeFileSync(st, JSON.stringify(s)); console.log(JSON.stringify([{ databaseId: 7, name: 'ci', workflowName: 'ci', status: 'completed', conclusion: 'failure' }])); process.exit(0); }
if (a[0] === 'run' && a[1] === 'view') { console.log(JSON.stringify({ jobs: [{ name: 'windows', conclusion: 'failure' }] })); process.exit(0); }
process.exit(1);`);
  const gh = `node "${fakeGh}"`;
  const SHA = 'ab12cd34'.repeat(5);

  // 1. A CI failure on a lane's sha: shadow logs where it would go; on puts it in that task's inbox.
  {
    fresh();
    emit('ci-s', [{ type: 'task.train.queued', agent: 'builder-s1', task: 'T-003', msg: 'T-003 is checked and waits', meta: { head: SHA, branch: 'lane/builder-s1-1' } }]);
    const r = run(dir, `node harness/ci-watch.mjs --sha ${SHA} --poll-sec 0`, { ...base, AGENT_EVENTS_FILE: evFile('ci-s'), STUDIO_GH: gh, STUDIO_THREADS: 'shadow' });
    const ev = events('ci-s');
    const would = ev.find((e) => e.type === 'thread.would_route');
    const shadowOk = r.status === 1 && !inbox('T-003') && would?.meta?.to === 'task' && would.meta.tasks?.join() === 'T-003' && would.meta.type === 'ci.failed' && !ev.some((e) => e.type === 'thread.routed');
    fresh();
    fs.rmSync(path.join(dir, 'gh-264l.json'), { force: true });
    emit('ci-on', [{ type: 'task.train.queued', agent: 'builder-s1', task: 'T-003', msg: 'T-003 is checked and waits', meta: { head: SHA, branch: 'lane/builder-s1-1' } }]);
    const r2 = run(dir, `node harness/ci-watch.mjs --sha ${SHA} --poll-sec 0`, { ...base, AGENT_EVENTS_FILE: evFile('ci-on'), STUDIO_GH: gh, STUDIO_THREADS: 'on' });
    const ev2 = events('ci-on');
    const onOk = r2.status === 1 && /· ci · CI red on ab12cd3/.test(inbox('T-003')) && ev2.some((e) => e.type === 'thread.routed' && e.meta?.tasks?.join() === 'T-003') && !ev2.some((e) => e.type === 'thread.would_route');
    report('2.64.0 (l): a CI failure on a lane\'s sha (task.train.queued) routes to that task\'s inbox with STUDIO_THREADS=on, and with shadow (the default) only logs thread.would_route (no inbox written)',
      shadowOk && onOk, `shadow ${shadowOk} on ${onOk}\n${out(r)}${out(r2)}\nT-003 inbox: ${inbox('T-003')}\n${JSON.stringify(would || null).slice(0, 400)}`);
  }

  // 2. A red train and a lane handed back: in the lanes' inboxes; the session holding the task hears at its next tool call.
  {
    fresh();
    const TR = '20261101-101500-4242';
    probe('claim', `import { claim } from ${u('harness/lock.mjs')}; claim('task:T-004', 'builder-s9', 3600); console.log(JSON.stringify({ ok: true }));`);
    emit('train', [{ type: 'agent.info', msg: 'before' }]);
    thread('train', 'sweep', { STUDIO_THREADS: 'on' }); // first sweep: learns history, routes nothing old
    emit('train', [
      { type: 'task.train.start', agent: 'train', msg: `train ${TR}: 2 lane(s): T-002, T-004`, meta: { train: TR, lanes: ['T-002', 'T-004'] } },
      { type: 'task.train.verify', agent: 'train', msg: `train ${TR}: verify 1 red`, meta: { train: TR } },
      { type: 'task.train.red', agent: 'train', status: 'blocked', msg: `train ${TR}: the train of T-002, T-004 is red (golden)`, meta: { train: TR, lanes: ['T-002', 'T-004'] } },
      { type: 'task.train.dropped', agent: 'train', task: 'T-004', to: 'builder-s9', status: 'blocked', msg: `train ${TR}: T-004 handed back: golden hash moved`, meta: { train: TR } },
    ]);
    const sw = thread('train', 'sweep', { STUDIO_THREADS: 'on' });
    const t4 = inbox('T-004');
    const t2 = inbox('T-002');
    const notice = fs.existsSync(path.join(dir, '.studio', 'inbox-notice', 'builder-s9.json'));
    const ok = /T-004 handed back: golden hash moved/.test(t4) && /is red \(golden\)/.test(t4) && /is red \(golden\)/.test(t2) && !/handed back/.test(t2) && !/verify 1 red/.test(t4 + t2) && notice;
    report('2.64.0 (l): a red merge train lands in its lanes\' inboxes (train id -> lanes from task.train.start) and the lane handed back gets its own line; the holder gets a notice (respond)', ok, `${out(sw)}\nT-004: ${t4}\nT-002: ${t2}\nnotice ${notice}`);

    const hook = (env) => spawnSync(process.execPath, [path.join(dir, '.claude', 'hooks', 'inbox-notice.mjs')], { cwd: dir, encoding: 'utf8', input: '{}', env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ...env } });
    const h1 = hook({ STUDIO_LOCK_OWNER: 'builder-s9' });
    const h2 = hook({ STUDIO_LOCK_OWNER: 'builder-s9' });
    let ctx = '';
    try { ctx = JSON.parse(h1.stdout).hookSpecificOutput.additionalContext; } catch {}
    report('2.64.0 (l): the PostToolUse hook tells the session holding the task once ("New in T-004\'s inbox", the command, never the text); the next tool call hears nothing more',
      /New in T-004's inbox: 1 follow-up/.test(ctx) && /npm run thread -- inbox T-004/.test(ctx) && !/golden hash/.test(ctx) && !h2.stdout.trim(), `${h1.stdout}${h1.stderr}|${h2.stdout}`);

    const f = run(dir, 'node harness/focus.mjs T-004 --agent builder-s9', { ...base, AGENT_EVENTS_FILE: evFile('train') });
    const kp = probe('kick', `import { kickoffParts } from ${u('harness/kickoff.mjs')}; import { outsideUntrusted } from ${u('harness/untrusted.mjs')};
const k = kickoffParts({ role: 'builder', agent: 'builder-s9', model: 'm', task: 'T-004', launched: true });
const f = await import(${u('harness/focus.mjs')}); const md = f.renderFocus(f.buildFocus('T-004', 'builder-s9'));
console.log(JSON.stringify({ vol: k.volatile, stable: k.stable.includes('inbox has'), outside: outsideUntrusted(md), md }));`, { AGENT_EVENTS_FILE: evFile('train') });
    report('2.64.0 (l): the task\'s brief shows its inbox (the lines inside the marked untrusted block, a pointer outside it) and the kickoff\'s volatile part names the count and the command',
      f.status === 0 && /## Inbox/.test(kp.md || '') && /golden hash moved/.test(kp.md || '') && !/golden hash moved/.test(kp.outside || 'golden hash moved') && /npm run thread -- inbox T-004/.test(kp.outside || '') && /T-004's inbox has 2 follow-up/.test(kp.vol || '') && kp.stable === false,
      `${out(f).slice(-600)}\n${JSON.stringify({ vol: kp.vol, stable: kp.stable, raw: kp._raw }).slice(0, 800)}`);
    probe('unclaim', `import { release } from ${u('harness/lock.mjs')}; release('task:T-004', 'builder-s9'); console.log(JSON.stringify({ ok: true }));`);
  }

  // 3. An unknown key (and a thread whose task is done) goes to the Producer path; nothing lands in a task inbox.
  {
    fresh();
    emit('unk', [{ type: 'agent.info', msg: 'before' }]);
    thread('unk', 'sweep', { STUDIO_THREADS: 'on' });
    emit('unk', [
      { type: 'ci.failed', agent: 'ci-watch', to: 'producer', status: 'error', msg: 'CI red on 99aa001 after one re-run: ci/windows failed', meta: { sha: '99aa0011'.repeat(5), failing: ['ci/windows'] } },
      { type: 'task.train.dropped', agent: 'train', task: 'T-000', status: 'blocked', msg: 'train x: T-000 handed back: late', meta: { train: '20261101-000000-1' } },
    ]);
    thread('unk', 'sweep', { STUDIO_THREADS: 'on' });
    const p = producerInbox();
    const ev = events('unk');
    const inboxes = ['T-001', 'T-002', 'T-003', 'T-004', 'T-005'].map(inbox).join('');
    report('2.64.0 (l): an event with no thread (unknown sha) goes to the Producer\'s inbox (thread.to_producer), and one whose task is done does too, saying so; no task inbox is written',
      /\*\*ci\*\* \(no thread\): CI red on 99aa001/.test(p) && /\*\*train\*\* \(thread task:T-000 \(T-000 is done\)\)/.test(p) && ev.filter((e) => e.type === 'thread.to_producer').length === 2 && !inboxes, `${p}\n${inboxes}`);
  }

  // 4. A source set to ignore is dropped (on: nothing delivered; shadow: trigger.would_drop).
  {
    fresh();
    const restore = setTriggers((t) => { t.live = ['ci', 'train', 'github']; t.sources.github = { policy: 'ignore' }; });
    const r = thread('ign', 'post task:T-002 "please look at the failing check" --source github --by relay-bot --ref 77', { STUDIO_THREADS: 'on' });
    const ev = events('ign');
    const dropped = /dropped \(github: ignore\)/.test(out(r)) && !inbox('T-002') && !producerInbox() && ev.some((e) => e.type === 'trigger.dropped');
    emit('ign2', [{ type: 'agent.info', msg: 'before' }]);
    thread('ign2', 'sweep');
    emit('ign2', [{ type: 'task.train.verify', agent: 'train', msg: 'train z: verify 1 green', meta: { train: 'z' } }, { type: 'ci.green', agent: 'ci-watch', msg: 'CI green on 1234567', meta: { sha: '1234567' } }]);
    thread('ign2', 'sweep');
    const ev2 = events('ign2');
    restore();
    report('2.64.0 (l): an event from a source (or type) set to ignore is dropped: nothing in any inbox or the Producer\'s; shadow mode logs trigger.would_drop for it',
      dropped && ev2.filter((e) => e.type === 'trigger.would_drop').length === 2 && !ev2.some((e) => e.type === 'thread.would_route'), `${out(r)}\n${JSON.stringify(ev2.map((e) => e.type))}`);
  }

  // 5. Linking: a bot or the Producer may tie a Discord message to a task; a worker never.
  {
    fresh();
    const w1 = thread('link', 'link discord:123456789012 T-002 --by opus-bot', { STUDIO_LOCK_OWNER: 'builder-s3' });
    const w2 = thread('link', 'link discord:123456789012 T-002 --by opus-bot', { STUDIO_ROLE: 'builder' });
    const w3 = thread('link', 'link discord:123456789012 T-002 --by qa-playtester-s2');
    const none = thread('link', 'resolve discord:123456789012');
    const ok = thread('link', 'link discord:123456789012 T-002 --by producer-1', { STUDIO_ROLE: 'producer', STUDIO_LOCK_OWNER: 'producer-1' });
    const bot = thread('link', 'link pr:41 T-005 --by opus-bot');
    const res = thread('link', 'resolve discord:123456789012');
    const again = thread('link', 'link discord:123456789012 T-003 --by opus-bot');
    const code = thread('link', `link sha:${SHA} T-003 --by opus-bot`);
    const done = thread('link', 'link pr:42 T-000 --by opus-bot');
    const refusedAll = [w1, w2, w3].every((r) => r.status === 1 && /worker|launched builder session/.test(out(r)));
    report('2.64.0 (l): thread link refuses a worker (its STUDIO_LOCK_OWNER, a launched builder session, or a worker\'s name in --by); the Producer and an outside bot may link a Discord message or PR; a key linked elsewhere, a code-built key and a done task are refused',
      refusedAll && /no thread/.test(out(none)) && ok.status === 0 && bot.status === 0 && /discord:123456789012 -> T-002/.test(out(res)) && again.status === 1 && /already linked/.test(out(again)) && code.status === 1 && /built by code/.test(out(code)) && done.status === 1,
      [w1, w2, w3, none, ok, bot, res, again, code, done].map(out).join('|').slice(0, 1500));
    // The linked key routes a bot's post (discord live in this run).
    const restore = setTriggers((t) => { t.live = ['ci', 'train', 'discord']; });
    const p = thread('link', 'post discord:123456789012 "the menu flickers on resize" --source discord --by opus-bot --ref 123456789012', { STUDIO_THREADS: 'on' });
    const pw = thread('link', 'post discord:123456789012 "x" --source discord --by builder-s3');
    restore();
    report('2.64.0 (l): a bot\'s post on a linked Discord message lands in that task\'s inbox (discord live); a worker can\'t post',
      /in T-002's inbox/.test(out(p)) && /discord · opus-bot: the menu flickers on resize · ref 123456789012/.test(inbox('T-002')) && pw.status === 1, `${out(p)}${out(pw)}\n${inbox('T-002')}`);
  }

  // 6. shadow-report: counts and an even sample for the owner.
  {
    fresh();
    emit('rep', [{ type: 'agent.info', msg: 'before' }]);
    thread('rep', 'sweep');
    const TR = '20261101-111111-7';
    emit('rep', [
      { type: 'task.train.start', agent: 'train', msg: 'start', meta: { train: TR, lanes: ['T-001'] } },
      { type: 'task.train.red', agent: 'train', msg: `train ${TR}: red`, meta: { train: TR } },
      { type: 'task.train.dropped', agent: 'train', task: 'T-001', msg: `train ${TR}: T-001 handed back`, meta: { train: TR } },
      { type: 'ci.failed', agent: 'ci-watch', msg: 'CI red on 5555555', meta: { sha: '5555555' } },
    ]);
    thread('rep', 'sweep');
    const r = thread('rep', 'shadow-report --sample 2 --json');
    let j = {};
    try { j = JSON.parse(r.stdout.trim().split('\n').pop()); } catch {}
    const txt = thread('rep', 'shadow-report --sample 3');
    report('2.64.0 (l): npm run thread -- shadow-report prints the shadow decisions\' counts and a sample of the asked size (task, Producer or drop, with the key)',
      j.total === 4 && j.sample?.length === 2 && j.counts?.['train to task'] === 2 && j.counts?.['ci to producer'] === 1 && j.counts?.['train drop'] === 1 && /Sample of 3/.test(out(txt)) && /-> T-001 \[train:/.test(out(txt)) && !inbox('T-001'),
      `${out(r).slice(0, 800)}\n${out(txt).slice(0, 800)}`);
  }

  // 7. The War Room's /api/inbox takes a task key (auth unchanged): on and hub live -> the task's inbox.
  {
    fresh();
    const restore = setTriggers((t) => { t.live = ['ci', 'train', 'hub']; });
    const port = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    const token = crypto.randomBytes(24).toString('hex');
    const child = spawn(process.execPath, [path.join(dir, 'hub', 'server.mjs')], { cwd: dir, env: { ...process.env, ...base, HUB_PORT: String(port), HUB_HOST: '127.0.0.1', HUB_TOKEN: token, HUB_ALLOWED_HOSTS: '', STUDIO_WATCH_INTERVAL: '0', STUDIO_THREADS: 'on', AGENT_EVENTS_FILE: evFile('hub') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
    const req = (body, headers = {}) => new Promise((resolve) => {
      const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/inbox', headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', ...headers } }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
      r.on('error', () => resolve({ status: 0, body: '' }));
      r.end(JSON.stringify(body));
    });
    let up = false;
    for (let i = 0; i < 80 && !up; i++) { await new Promise((r) => setTimeout(r, 150)); up = (await req({ msg: '' }, { 'x-hub-token': token })).status === 400; }
    const noTok = await req({ task: 'T-002', msg: 'hi' });
    const toTask = await req({ task: 'T-002', msg: 'try the slower spawn rate first', by: 'dev' }, { 'x-hub-token': token });
    const unknown = await req({ task: 'T-999', msg: 'what about the other one', by: 'dev' }, { 'x-hub-token': token });
    child.kill();
    await new Promise((r) => setTimeout(r, 200));
    restore();
    const p = producerInbox();
    report('2.64.0 (l): hub /api/inbox with a task key puts the message in that task\'s inbox (threads on, hub live) and not the Producer\'s; an unknown task reaches the Producer as before; no token is still 401',
      up && noTok.status === 401 && toTask.status === 201 && /"routed":\["T-002"\]/.test(toTask.body) && /dev: try the slower spawn rate first/.test(inbox('T-002')) && !/slower spawn/.test(p) && unknown.status === 201 && /what about the other one/.test(p) && !inbox('T-999'),
      `up ${up} ${noTok.status} ${toTask.status} ${toTask.body} ${unknown.status} ${unknown.body}\n${p}\n${log.slice(-800)}`);
  }

  // 8. Pass-through never creates a task or edits the board; the heartbeat sweeps.
  {
    const all = fs.readdirSync(path.join(dir, '.studio')).filter((f) => /^events-264l-.*\.jsonl$/.test(f)).flatMap((f) => fs.readFileSync(path.join(dir, '.studio', f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
    let src = null;
    try { src = fs.readFileSync(path.join(dir, 'harness', 'threads.mjs'), 'utf8'); } catch {}
    const agentSrc = fs.readFileSync(path.join(dir, 'harness', 'agent.mjs'), 'utf8');
    const beat = agentSrc.slice(agentSrc.indexOf('const beat = setInterval'), agentSrc.indexOf('}, HEARTBEAT_MS)'));
    report('2.64.0 (l): pass-through never creates a task or edits studio/NEXT.md (no task.added in any run above, the board unchanged, threads.mjs neither imports task.mjs nor writes the board); the launcher\'s heartbeat sweeps the threads',
      fs.readFileSync(path.join(dir, 'studio', 'NEXT.md'), 'utf8') === nextBefore && all.length > 10 && !all.some((e) => e.type === 'task.added') && src !== null && !/addTask|writeNextQueue|task\.mjs'/.test(src) && /sweepThreads\(/.test(beat),
      `${all.length} events; task.added ${all.filter((e) => e.type === 'task.added').length}; beat ${/sweepThreads\(/.test(beat)}`);
  }
}
