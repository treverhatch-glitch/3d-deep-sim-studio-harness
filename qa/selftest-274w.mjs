/**
 * qa/selftest-274w.mjs — 2.74.0 (helper w): the War Room refresh.
 *   pairing    `npm run hub -- pair --by <name>`: a one-time code, refused in an agent's shell and for an agent's name; the
 *              browser swaps it once for an HttpOnly SameSite=Strict cookie whose token is kept only as a hash; a paired
 *              write needs the cookie, the X-Hub-Paired header and a loopback origin, and acts as the paired person
 *   act        "Fixed it: try again" runs `studio:resume` (supervisor.mjs resumeCli) as the paired person: the halt clears
 *              with its decision record, and a refusal comes back in resumeCli's own words; /api/act runs hold and
 *              `delegate revoke` as the CLI does
 *   B-70       a request whose handler throws answers 500 and the hub keeps running (on 2.73.0 it ended the hub); every
 *              exit is logged in .studio/logs/hub-exit.log; the supervisor's keeper restarts the hub with backoff, never
 *              while a hub process is still there, and studio:status says when it last restarted and why
 *   live       /health names the boot and the page version, and the page carries the same version (it reloads only when
 *              the page changed); the page makes no outside request (no web fonts)
 *   panels     harness/war-room.mjs: the Train Room's lanes, the run clock's landed/h, the machine, the owner proxy, each
 *              agent's step and actions; the Studio floor's assignment rooms (Rail Yard, Watchtower, Engine Bay)
 * Each check fails on 2.73.0 (none of this exists there, or it behaves the old way: say so in its name).
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest274W({ dir, run, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!fs.existsSync(path.join(dir, 'node_modules', 'typescript')) && fs.existsSync(path.join(harnessRoot, 'node_modules', 'typescript'))) {
    try { fs.rmSync(path.join(dir, 'node_modules'), { force: true }); } catch {}
    try { fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(dir, 'node_modules'), 'junction'); } catch {}
  }
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, args) => spawnSync('git', args, { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const nm = path.join(dir, 'node_modules');
  const TOKEN = 'w274'.repeat(8);
  const base = {
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_WATCH_INTERVAL: '0', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '',
    STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '', STUDIO_TRACK: '', STUDIO_RESUME_BY: '', STUDIO_RUN_T0: '', STUDIO_HUB_PAIR_DAYS: '', STUDIO_HUB_PAIR_CODE_MIN: '', STUDIO_HUB_HANG_MIN: '',
    CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', NODE_OPTIONS: '', STUDIO_MACHINE_SCAN: 'off', HUB_TOKEN: TOKEN, HUB_HOST: '', HUB_ALLOWED_HOSTS: '', ...ident,
  };
  let n = 0;
  const made = [];
  const kids = [];
  const studio = (name) => {
    const S = path.join(tmpRoot, `274w-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    for (const x of ['.studio/agents', '.studio/locks', '.studio/train', '.studio/decisions.jsonl', '.studio/supervisor.json', '.studio/hub-pairs.json', '.studio/logs', '.studio/hub.json', 'studio/delegation.json', 'studio/divisions.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
    const ev = path.join(S, '.studio', 'events-274w.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
    g(S, ['init', '-q', '-b', 'main']); g(S, ['config', 'core.autocrlf', 'false']);
    g(S, ['add', '-A']); g(S, ['commit', '-qm', 'studio', '--no-verify']);
    made.push(S);
    return { S, ev, env: { ...process.env, ...base, AGENT_EVENTS_FILE: ev } };
  };
  const events = (ev) => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const read = (S, rel) => { try { return fs.readFileSync(path.join(S, rel), 'utf8'); } catch { return ''; } };
  const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const req = (port, { method = 'GET', path: p = '/', headers = {}, body = null } = {}) => new Promise((resolve) => {
    const data = body === null ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let t = '';
      res.on('data', (d) => { t += d; });
      res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, headers: res.headers, text: t, json: j }); });
    });
    r.on('error', (e) => resolve({ status: 0, text: String(e), json: null, headers: {} }));
    if (data) r.write(data);
    r.end();
  });
  const startHub = async (S, env) => {
    const port = await freePort();
    let log = '';
    const h = spawn(process.execPath, ['hub/server.mjs'], { windowsHide: true, cwd: S, env: { ...env, HUB_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    h.stdout.on('data', (d) => { log += d; });
    h.stderr.on('data', (d) => { log += d; });
    kids.push(h);
    for (let i = 0; i < 80; i++) { if ((await req(port, { path: '/health' })).status === 200) break; await sleep(150); }
    return { h, port, log: () => log };
  };
  const pairCli = (S, env, by, extra = {}) => spawnSync(process.execPath, ['hub/server.mjs', 'pair', '--by', by], { windowsHide: true, cwd: S, env: { ...env, ...extra }, encoding: 'utf8' });
  const codeOf = (r) => (/code=([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(r.stdout || '') || [])[1] || null;
  const claim = (port, code, headers = { 'X-Hub-Paired': '1' }) => req(port, { method: 'POST', path: '/pair/claim', headers, body: { code } });
  const cookieOf = (r) => String((r.headers['set-cookie'] || [])[0] || '').split(';')[0];

  try {
    // ---- pairing ----
    {
      const { S, env } = studio('pair');
      const hub = await startHub(S, env);
      const refused = pairCli(S, env, 'hatch', { CLAUDECODE: '1' });
      const agentName = pairCli(S, env, 'builder-s9');
      const ok = pairCli(S, env, 'hatch');
      const code = codeOf(ok);
      await guard('274w pairing: `hub pair` is refused in a coding agent\'s shell and for an agent\'s name, and for a person prints a one-time code and link, never HUB_TOKEN (fails on 2.73.0: no pair command, the hub just starts)', () => [
        refused.status === 1 && /coding agent \(CLAUDECODE is set\)/.test(`${refused.stdout}${refused.stderr}`) && agentName.status === 1 && /agent's name/.test(`${agentName.stdout}${agentName.stderr}`)
          && ok.status === 0 && Boolean(code) && /\/pair\?code=/.test(ok.stdout) && !`${ok.stdout}${ok.stderr}`.includes(TOKEN),
        `refused ${refused.status}: ${refused.stdout}${refused.stderr}\nagent ${agentName.status}: ${agentName.stdout}${agentName.stderr}\nok ${ok.status}: ${String(ok.stdout).replace(TOKEN, '(TOKEN)')}`]);
      const noHeader = await claim(hub.port, code, {});
      const first = await claim(hub.port, code);
      const second = await claim(hub.port, code);
      const cookie = cookieOf(first);
      const setc = String((first.headers['set-cookie'] || [])[0] || '');
      const store = read(S, '.studio/hub-pairs.json');
      const tok = cookie.split('=')[1] || '';
      await guard('274w pairing: the code is swapped once (without the X-Hub-Paired header it is refused) for an HttpOnly SameSite=Strict cookie; only the token\'s hash is kept (fails on 2.73.0: /pair/claim is 404)', () => [
        noHeader.status === 403 && first.status === 200 && first.json?.by === 'hatch' && /^hub_pair=/.test(cookie) && /HttpOnly/.test(setc) && /SameSite=Strict/.test(setc) && second.status === 401
          && tok.length >= 40 && /"by": "hatch"/.test(store) && !store.includes(tok),
        `no header ${noHeader.status}; first ${first.status} ${first.text} ${setc.replace(tok, '(tok)')}; second ${second.status}; store ${store.slice(0, 300)}`]);
      const me = await req(hub.port, { path: '/api/pair/me', headers: { cookie } });
      const body = { type: 'note.274w', agent: 'x', msg: 'paired write' };
      const cookieOnly = await req(hub.port, { method: 'POST', path: '/api/events', headers: { cookie }, body });
      const foreign = await req(hub.port, { method: 'POST', path: '/api/events', headers: { cookie, 'X-Hub-Paired': '1', origin: 'https://evil.example.com' }, body });
      const good = await req(hub.port, { method: 'POST', path: '/api/events', headers: { cookie, 'X-Hub-Paired': '1', origin: `http://127.0.0.1:${hub.port}` }, body });
      const wrong = await req(hub.port, { method: 'POST', path: '/api/events', headers: { cookie: 'hub_pair=not-a-real-token-at-all-0000000000000000', 'X-Hub-Paired': '1' }, body });
      const scripted = await req(hub.port, { method: 'POST', path: '/api/events', headers: { 'x-hub-token': TOKEN }, body });
      await guard('274w pairing: a paired write needs the cookie AND the X-Hub-Paired header AND a loopback origin; a wrong token is refused; HUB_TOKEN still works for scripts (fails on 2.73.0: no paired writes)', () => [
        me.json?.paired === true && me.json.by === 'hatch' && cookieOnly.status === 401 && foreign.status === 401 && good.status === 201 && wrong.status === 401 && scripted.status === 201,
        `me ${me.text}; cookie only ${cookieOnly.status}; foreign ${foreign.status}; good ${good.status} ${good.text}; wrong ${wrong.status}; token ${scripted.status}`]);
      const un = spawnSync(process.execPath, ['hub/server.mjs', 'unpair', '--by', 'hatch'], { windowsHide: true, cwd: S, env, encoding: 'utf8' });
      const after = await req(hub.port, { method: 'POST', path: '/api/events', headers: { cookie, 'X-Hub-Paired': '1' }, body });
      await guard('274w pairing: `hub unpair --by hatch` forgets it; the browser is read-only at once (fails on 2.73.0: no unpair)', () => [
        un.status === 0 && /Forgot 1 paired browser/.test(un.stdout) && after.status === 401, `${un.status} ${un.stdout}${un.stderr}; after ${after.status}`]);
      hub.h.kill();
    }

    // ---- Act: resume, hold, revoke run the CLI's code as the paired person ----
    {
      const { S, ev, env } = studio('act');
      const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { windowsHide: true, stdio: 'ignore' });
      kids.push(sleeper);
      fs.writeFileSync(path.join(S, '.studio', 'supervisor.json'), JSON.stringify({ pid: sleeper.pid, status: 'running', startedAt: new Date(Date.now() - 3600000).toISOString(), sessions: 2, tasksDone: 0, hubDown: [], halted: { at: new Date().toISOString(), code: 1, why: 'two sessions in a row ended with exit 1 (b1, b2): test' } }));
      // The hub was started from an agent's shell (B-60): the paired person's button must still work.
      const hub = await startHub(S, { ...env, STUDIO_LOCK_OWNER: 'opus-9' });
      const code = codeOf(pairCli(S, env, 'hatch'));
      const cookie = cookieOf(await claim(hub.port, code));
      const H = { cookie, 'X-Hub-Paired': '1' };
      const asAgent = await req(hub.port, { method: 'POST', path: '/api/supervisor', headers: { 'x-hub-token': TOKEN }, body: { action: 'resume', by: 'builder-s3' } });
      const r = await req(hub.port, { method: 'POST', path: '/api/supervisor', headers: H, body: { action: 'resume', by: 'someone-else', why: 'fixed the PATH' } });
      const resume = read(S, '.studio/supervisor-resume');
      const dec = read(S, '.studio/decisions.jsonl');
      await guard('274w act: "Fixed it: try again" runs studio:resume (resumeCli) as the paired person: resume file by hatch via cli, a studio-resume decision, the harness\'s words back; an agent\'s name is refused in resumeCli\'s words (fails on 2.73.0: the hub wrote the file for anyone and always said yes)', () => [
        asAgent.status === 400 && /^Not resumed: /.test(asAgent.json?.error || '') && r.status === 200 && /Cleared the halt \(two sessions in a row/.test(r.json?.next || '') && /names hatch/.test(r.json?.next || '')
          && /"by":"hatch"/.test(resume) && /"via":"cli"/.test(resume) && /"why":"fixed the PATH"/.test(resume) && /"action":"studio-resume"/.test(dec) && /"by":"hatch"/.test(dec),
        `as agent ${asAgent.status} ${asAgent.text}\nresume ${r.status} ${r.text}\nfile ${resume}\ndecisions ${dec.slice(-400)}`]);
      fs.writeFileSync(path.join(S, 'studio', 'delegation.json'), `${JSON.stringify({ agent: 'crew-lead', actions: ['hold'], until: new Date(Date.now() + 86400000).toISOString(), by: 'hatch', at: new Date().toISOString(), why: 'test' }, null, 2)}\n`);
      g(S, ['add', 'studio/delegation.json']); g(S, ['commit', '-qm', 'delegate', '--no-verify']);
      const task = (/\*\*(T-\d+)\*\*/.exec(read(S, 'studio/NEXT.md')) || [])[1] || 'T-001';
      const hold = await req(hub.port, { method: 'POST', path: '/api/act', headers: H, body: { action: 'hold', task, why: 'waits for the chain' } });
      const cli = spawnSync(process.execPath, ['harness/task.mjs', 'unhold', task, '--by', 'hatch'], { windowsHide: true, cwd: S, env, encoding: 'utf8' });
      const revoke = await req(hub.port, { method: 'POST', path: '/api/act', headers: H, body: { action: 'revoke' } });
      const bad = await req(hub.port, { method: 'POST', path: '/api/act', headers: H, body: { action: 'rm -rf' } });
      const ev2 = events(ev);
      await guard('274w act: /api/act runs `task hold` and `delegate revoke` as the CLI does, as hatch, with their own words; an unknown action is refused (fails on 2.73.0: no /api/act)', () => [
        hold.status === 200 && new RegExp(`${task} is held for landing by hatch`).test(hold.json?.next || '') && ev2.some((e) => e.type === 'task.held' && e.agent === 'hatch') && cli.status === 0
          && revoke.status === 200 && /Revoked the delegation to crew-lead/.test(revoke.json?.next || '') && !fs.existsSync(path.join(S, 'studio', 'delegation.json')) && ev2.some((e) => e.type === 'delegation.revoked' && e.agent === 'hatch')
          && bad.status === 400 && /Unknown action/.test(bad.json?.error || ''),
        `hold ${hold.status} ${hold.text}\nunhold ${cli.status} ${cli.stdout}${cli.stderr}\nrevoke ${revoke.status} ${revoke.text}\nbad ${bad.status} ${bad.text}`]);
      hub.h.kill();
    }

    // ---- B-70: the hub survives a handler that throws, and logs every exit ----
    {
      const { S, env } = studio('b70');
      const hub = await startHub(S, env);
      fs.writeFileSync(path.join(S, 'studio', 'divisions.json'), '{"divisions":[null]}\n');
      const boom = await req(hub.port, { path: '/api/hud' });
      await sleep(400);
      const still = await req(hub.port, { path: '/health' });
      fs.rmSync(path.join(S, 'studio', 'divisions.json'), { force: true });
      const log1 = read(S, '.studio/logs/hub-exit.log');
      await guard('274w B-70: a request whose handler throws answers 500 with the error, is logged, and the hub keeps running (fails on 2.73.0: the unhandled rejection ended the hub)', () => [
        boom.status === 500 && /The hub hit an error/.test(boom.json?.error || '') && still.status === 200 && hub.h.exitCode === null && /"kind":"error"/.test(log1) && /GET \/api\/hud/.test(log1),
        `boom ${boom.status} ${boom.text.slice(0, 300)}; health ${still.status}; exit ${hub.h.exitCode}; log ${log1.slice(-500)}\n${hub.log().slice(-800)}`]);
      const h1 = still.json || {};
      const page = await req(hub.port, { path: '/' });
      const ver = (/<meta name="hub-page" content="([^"]+)"/.exec(page.text) || [])[1];
      await guard('274w live: /health names the boot and the page version, the page carries the same version, and the page loads nothing from outside on load (no web fonts) (fails on 2.73.0: no version, Google Fonts)', () => [
        /^[0-9a-f]{12}$/.test(h1.bootId || '') && /^[0-9a-f]{12}$/.test(h1.page || '') && ver === h1.page && !/fonts\.(googleapis|gstatic)\.com/.test(page.text) && !/<(link|script)\b[^>]*\b(href|src)="https?:/i.test(page.text) && /id="live"/.test(page.text),
        `health ${JSON.stringify(h1)}; page version ${ver}; outside urls ${(page.text.match(/https?:\/\/[^\s"')]+/g) || []).filter((u) => !/127\.0\.0\.1|localhost|w3\.org/.test(u)).slice(0, 5).join(', ')}`]);
      hub.h.kill('SIGTERM');
      for (let i = 0; i < 40 && hub.h.exitCode === null && hub.h.signalCode === null; i++) await sleep(100);
      const log2 = read(S, '.studio/logs/hub-exit.log');
      const second = await startHub(S, env);
      const busy = spawn(process.execPath, ['hub/server.mjs'], { windowsHide: true, cwd: S, env: { ...env, HUB_PORT: String(second.port) }, stdio: 'ignore' });
      kids.push(busy);
      for (let i = 0; i < 60 && busy.exitCode === null; i++) await sleep(100);
      const log3 = read(S, '.studio/logs/hub-exit.log');
      const hubJson = JSON.parse(read(S, '.studio/hub.json') || '{}');
      await guard('274w B-70: every hub exit is one line in .studio/logs/hub-exit.log: stopped by SIGTERM, and "port in use" (exit 2) for a second hub; .studio/hub.json names the running one (fails on 2.73.0: no log, the second hub crashed unlogged)', () => [
        /"kind":"exit","cause":"stopped by SIGTERM/.test(log2) && busy.exitCode === 2 && /port \d+ is in use/.test(log3) && hubJson.pid === second.h.pid,
        `log ${log3.slice(-700)}; second exit ${busy.exitCode}; hub.json ${JSON.stringify(hubJson)}`]);
      second.h.kill();
    }

    // ---- the supervisor's keeper ----
    try {
      const { S, ev, env } = studio('keeper');
      // On a harness without the keeper every check below fails on its own (not one crash for the block).
      const mod = await import(pathToFileURL(path.join(S, 'harness', 'hub-keeper.mjs')).href).catch((e) => ({ keepHub: async () => { throw e; }, backoffMs: () => { throw e; } }));
      const emitted = [];
      const emit = (e) => emitted.push(e);
      const state = {};
      let spawned = 0;
      const fakeChild = (alive) => ({ pid: 424242, exitCode: alive ? null : 1, signalCode: null, kill() { this.exitCode = 143; } });
      const spawnHub = () => { spawned += 1; return fakeChild(false); };
      fs.mkdirSync(path.join(S, '.studio', 'logs'), { recursive: true });
      const t0 = Date.parse('2026-11-03T12:00:00Z');
      fs.writeFileSync(path.join(S, '.studio', 'logs', 'hub-exit.log'), `${JSON.stringify({ at: new Date(t0 - 30000).toISOString(), pid: 1, kind: 'exit', cause: 'uncaught exception: TypeError: x is not a function\n    at y' })}\n`);
      const step = (now, up, child = null) => mod.keepHub({ state, port: 1, child, now, root: S, healthy: async () => up, spawnHub, emit, loopMs: 60000 });
      const a = await step(t0, false);
      const b = await step(t0 + 10000, false);
      const c = await step(t0 + 31000, false);
      const d = await step(t0 + 40000, false, fakeChild(true));
      const e = await step(t0 + 90000, true);
      await guard('274w keeper: a dead hub is restarted at once with its cause from hub-exit.log, then backs off (30 s, 1 min …), a live hub process that doesn\'t answer is left alone, and recovery is recorded (fails on 2.73.0: no keeper; the supervisor respawned every pass with no cause)', () => [
        a.action === 'restarted' && /uncaught exception: TypeError: x is not a function/.test(a.why) && b.action === 'backoff' && c.action === 'restarted' && d.action === 'waiting' && e.action === 'ok' && spawned === 2
          && state.hubKeep.restarts === 2 && state.hubKeep.lastRestart?.why && state.hubDown.length === 1 && emitted.filter((x) => x.type === 'supervisor.hub_restart').length === 2 && emitted.some((x) => x.type === 'supervisor.hub_restarted')
          && mod.backoffMs(1) === 30000 && mod.backoffMs(2) === 60000 && mod.backoffMs(9) === 600000,
        JSON.stringify({ a, b, c, d, e, spawned, keep: state.hubKeep, down: state.hubDown, emitted: emitted.map((x) => x.type) })]);
      const st2 = {};
      const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { windowsHide: true, stdio: 'ignore' });
      kids.push(sleeper);
      fs.writeFileSync(path.join(S, '.studio', 'hub.json'), JSON.stringify({ pid: sleeper.pid, port: 3847 }));
      const other = await mod.keepHub({ state: st2, port: 1, child: null, now: t0, root: S, healthy: async () => false, spawnHub, emit, loopMs: 60000 });
      const spawnedThen = spawned;
      const hung = fakeChild(true);
      const st3 = {};
      fs.rmSync(path.join(S, '.studio', 'hub.json'));
      await mod.keepHub({ state: st3, port: 1, child: hung, now: t0, root: S, healthy: async () => false, spawnHub, emit, env: { STUDIO_HUB_HANG_MIN: '5' } });
      const ended = await mod.keepHub({ state: st3, port: 1, child: hung, now: t0 + 6 * 60000, root: S, healthy: async () => false, spawnHub, emit, env: { STUDIO_HUB_HANG_MIN: '5' } });
      const re = await mod.keepHub({ state: st3, port: 1, child: hung, now: t0 + 6 * 60000 + 1000, root: S, healthy: async () => false, spawnHub, emit, env: { STUDIO_HUB_HANG_MIN: '5' } });
      await guard('274w keeper: another hub process holding the port (.studio/hub.json, alive) is never touched; our own hub silent past STUDIO_HUB_HANG_MIN is ended, then restarted with that reason (fails on 2.73.0)', () => [
        other.action === 'other-hub' && spawnedThen === 2 && ended.action === 'ended' && hung.exitCode === 143 && re.action === 'restarted' && /didn't answer \/health for 6 min/.test(re.why),
        JSON.stringify({ other, ended, re, spawned })]);
      fs.writeFileSync(path.join(S, '.studio', 'supervisor.json'), JSON.stringify({ pid: 999999, status: 'stopped', startedAt: new Date(t0).toISOString(), sessions: 1, tasksDone: 0, hubDown: [{ from: new Date(t0).toISOString(), to: new Date(t0 + 90000).toISOString() }], hubKeep: state.hubKeep }));
      const status = spawnSync(process.execPath, ['harness/supervisor.mjs', 'status'], { windowsHide: true, cwd: S, env, encoding: 'utf8' });
      await guard('274w keeper: studio:status says when the hub last restarted, why, and how many times (fails on 2.73.0: only the down spans)', () => [
        /Hub last restarted 12:00 UTC \(uncaught exception: TypeError: x is not a function\); 2 restarts this run\./.test(status.stdout), `${status.stdout}${status.stderr}`]);
      const sup = read(S, 'harness/supervisor.mjs');
      await guard('274w keeper: the supervisor\'s pass uses the keeper (one call, a separate function), and its hub spawn is hidden on Windows (fails on 2.73.0: inline respawn without windowsHide)', () => [
        /hub = await keepHubUp\(state, port, hub\)/.test(sup) && /async function keepHubUp\(/.test(sup) && !/hub = spawn\(process\.execPath, \[path\.join\(REPO_ROOT, 'hub', 'server\.mjs'\)\]/.test(sup) && /windowsHide: true/.test(read(S, 'harness/hub-keeper.mjs')),
        'supervisor.mjs still respawns the hub inline']);
      void ev;
    } catch (e) {
      // A harness without the keeper (2.73.0): each keeper check fails on its own line.
      for (const name of ['274w keeper: a dead hub is restarted at once with its cause, then backs off (fails on 2.73.0: no harness/hub-keeper.mjs)', '274w keeper: another hub process is never touched; a silent own hub is ended and restarted (fails on 2.73.0)', '274w keeper: studio:status says when the hub last restarted and why (fails on 2.73.0)', '274w keeper: the supervisor\'s pass uses the keeper, hidden on Windows (fails on 2.73.0)']) report(name, false, e.stack || String(e));
    }

    // ---- the panels and the Studio floor's rooms ----
    {
      const { S, ev, env } = studio('panels');
      const now = Date.now();
      const iso = (ago) => new Date(now - ago).toISOString();
      const st = path.join(S, '.studio');
      fs.mkdirSync(path.join(st, 'locks'), { recursive: true });
      fs.writeFileSync(path.join(st, 'locks', 'train.lock'), JSON.stringify({ pid: process.pid, at: now - 20 * 60000, id: 'tr-w', by: 'train-daemon' }));
      fs.mkdirSync(path.join(st, 'train', 'tr-w'), { recursive: true });
      fs.writeFileSync(path.join(st, 'train', 'tr-w', 'status.json'), JSON.stringify({ train: 'tr-w', step: 'verify', text: 'verify 1: lanes 1-2', lanes: 3, eta: { text: 'about 9 min' } }));
      fs.writeFileSync(path.join(st, 'train', 'queue.json'), JSON.stringify([{ task: 'T-901', agent: 'b-1', head: 'h1' }, { task: 'T-903', agent: 'b-3', head: 'h3', held: { tier: 'C', why: 'a protected file' } }]));
      const evs = [
        { ts: iso(2 * 3600000), type: 'task.train.landed', agent: 'train-daemon', meta: { train: 'tr-v', lanes: ['T-880', 'T-881'] } },
        { ts: iso(2 * 3600000 - 1000), type: 'task.train.done', agent: 'train-daemon', status: 'ok', msg: 'train tr-v: landed T-880, T-881', meta: { train: 'tr-v', landed: ['T-880', 'T-881'], dropped: [] } },
        { ts: iso(20 * 60000), type: 'task.done', agent: 'b-9', task: 'T-882' },
        { ts: iso(19 * 60000), type: 'task.train.start', agent: 'train-daemon', meta: { train: 'tr-w', lanes: ['T-900', 'T-901', 'T-902'] } },
        { ts: iso(15 * 60000), type: 'task.train.dropped', agent: 'train-daemon', task: 'T-902', meta: { train: 'tr-w' } },
        { ts: iso(14 * 60000), type: 'task.train.landed', agent: 'train-daemon', meta: { train: 'tr-w', lanes: ['T-900'] } },
        { ts: iso(30 * 60000), type: 'delegation.used', agent: 'crew-lead', task: 'T-870', msg: 'crew-lead ran train-release T-870 under delegation', meta: { action: 'train-release' } },
      ];
      fs.appendFileSync(ev, evs.map((e) => JSON.stringify(e)).join('\n') + '\n');
      fs.writeFileSync(path.join(st, 'decisions.jsonl'), `${JSON.stringify({ kind: 'decision', id: 'D-w1', at: iso(25 * 60000), action: 'hold', subject: 'T-871', by: 'crew-lead', as: `delegation ${iso(86400000)}`, why: 'waits for the chain' })}\n${JSON.stringify({ kind: 'decision', id: 'D-w2', at: iso(25 * 60000), action: 'type', subject: 'T-872', by: 'hatch', as: 'person', why: 'a person' })}\n`);
      fs.writeFileSync(path.join(st, 'machine.json'), JSON.stringify({ at: iso(10000), os: 'linux', ram: { totalGb: 32, freeGb: 8 }, cpu: { busy: 0.5 }, gpus: [], disk: { freeGb: 100 } }));
      fs.writeFileSync(path.join(st, 'machine-history.jsonl'), [20, 22, 24].map((u, i) => JSON.stringify({ at: iso((3 - i) * 60000), ram: [u, 32], cpu: 40 + i * 10, disk: 100 })).join('\n') + '\n');
      fs.writeFileSync(path.join(S, 'studio', 'delegation.json'), `${JSON.stringify({ agent: 'crew-lead', actions: ['hold'], until: new Date(now + 86400000).toISOString(), by: 'hatch', at: iso(86400000), why: 'test' }, null, 2)}\n`);
      g(S, ['add', '-A']); g(S, ['commit', '-qm', 'panels', '--no-verify']);
      const code = `
        process.env.AGENT_EVENTS_FILE = ${JSON.stringify(ev)};
        process.env.STUDIO_RUN_T0 = ${JSON.stringify(iso(3 * 3600000))};
        const w = await import('./harness/war-room.mjs');
        const s = await w.warRoomState({ supervisor: { startedAt: ${JSON.stringify(iso(3600000))}, opts: { until: ${JSON.stringify(new Date(now + 10 * 3600000).toISOString())} }, last: { why: ['ram low'] } }, launched: [{ running: true, role: 'builder' }, { running: true, role: 'builder' }],
          agents: [{ name: 'b-1', task: 'T-901' }, { name: 'b-3', task: 'T-903' }], queue: { inProgress: [{ id: 'T-901', title: 'one' }, { id: 'T-903', title: 'three' }, { id: 'T-904', title: 'four' }], backlog: [], done: [] }, holds: { 'T-904': { parked: { why: 'x' } } } });
        const steps = w.agentSteps({ root: process.cwd(), agents: [{ name: 'b-1', task: 'T-901' }, { name: 'b-3', task: 'T-903' }, { name: 'b-4', task: 'T-904' }, { name: 'b-5', task: 'T-905' }], queue: { inProgress: [{ id: 'T-901', title: 'one' }, { id: 'T-903', title: 'three' }, { id: 'T-904', title: 'four' }, { id: 'T-905', title: 'five' }], backlog: [], done: [] }, holds: { 'T-904': { parked: { why: 'x' } }, 'T-905': { held: { by: 'p' } } }, trainQueue: JSON.parse(require('fs').readFileSync('.studio/train/queue.json', 'utf8')) });
        const rooms = [w.roomFor({ name: 'train-daemon' }), w.roomFor({ name: 'unity-worker-1' }), w.roomFor({ name: 'b-2', track: 'engine:godot' }), w.roomFor({ name: 'Crew-Lead', proxyAgent: 'crew-lead' }), w.roomFor({ name: 'builder-s1' }), w.roomFor({ name: 'x', role: 'merge-captain' })];
        const { listDivisions } = await import('./harness/divisions.mjs');
        require('fs').writeFileSync('studio/divisions.json', JSON.stringify({ divisions: [{ id: 'engine', name: 'Engine Transfer', active: false }] }));
        const eng = listDivisions().find((d) => d.id === 'engine');
        console.log(JSON.stringify({ s, steps, rooms, eng }));`;
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);${code}`], { windowsHide: true, cwd: S, env: { ...env, AGENT_EVENTS_FILE: ev }, encoding: 'utf8' });
      let j = null;
      try { j = JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch {}
      const web = j?.s?.trains?.find((t) => t.kind === 'web');
      const lane = (t) => web?.lanes?.find((l) => l.task === t)?.state;
      await guard('274w panels: the Train Room reads the running train (step, eta, minutes), each lane\'s state (landed, verifying, handed back), the last train and the lane held for a release (fails on 2.73.0: no harness/war-room.mjs)', () => [
        web && web.running && web.id === 'tr-w' && web.step === 'verify' && web.eta === 'about 9 min' && web.elapsedMin === 20 && lane('T-900') === 'landed' && lane('T-901') === 'verifying' && lane('T-902') === 'dropped'
          && web.last?.id === 'tr-v' && web.last.landed.join() === 'T-880,T-881' && web.needsRelease.join() === 'T-903',
        `${r.status} ${String(r.stderr).slice(-800)}\n${JSON.stringify(web)}`]);
      await guard('274w panels: the run clock counts from STUDIO_RUN_T0 (tasks landed: task.done and train lanes, per hour) and to the supervisor\'s --until; the machine averages its samples and gives RAM per session; the crew says why not more (fails on 2.73.0)', () => {
        const rc = j?.s?.runClock; const m = j?.s?.machine; const c = j?.s?.crew;
        return [rc && rc.from === 'STUDIO_RUN_T0' && rc.landed === 4 && Math.abs(rc.perHour - 1.3) < 0.11 && rc.lastHour === 2 && Math.abs(rc.leftH - 10) < 0.2 && m?.ram.usedGb === 24 && m.ram.avgUsedGb === 22 && m.ram.perSessionGb === 12 && m.cpu.avgPct === 50 && c?.running === 2 && c.why[0] === 'ram low',
          JSON.stringify({ rc, m, c })];
      });
      await guard('274w panels: the owner proxy lists delegation.used events and decisions made "as delegation …", not a person\'s, with the delegation on file (fails on 2.73.0)', () => {
        const p = j?.s?.ownerProxy;
        return [p && p.delegation?.agent === 'crew-lead' && p.recent.some((x) => /ran train-release T-870/.test(x.what)) && p.recent.some((x) => /^hold T-871: waits for the chain/.test(x.what)) && !p.recent.some((x) => /T-872/.test(x.what)) && p.count24h === 2, JSON.stringify(p)];
      });
      await guard('274w steps: each agent\'s step and its actions: on the train, waiting on a release (Release), parked (Unpark), held (Unhold), editing (Hold) (fails on 2.73.0)', () => {
        const s = j?.steps || {};
        return [s['b-1']?.step === 'on-train' && s['b-3']?.step === 'needs-release' && s['b-3'].actions.some((a) => a.action === 'release') && s['b-4']?.step === 'parked' && s['b-4'].actions[0].action === 'unpark' && s['b-5']?.step === 'held' && s['b-5'].actions.some((a) => a.action === 'unhold'),
          JSON.stringify(s)];
      });
      await guard('274w rooms: the train sits in the Rail Yard, engine workers and engine-track tasks in Engine Bay (a saved "Engine Transfer" is shown as Engine Bay), the delegated agent and overseers in the Watchtower; a builder keeps its division (fails on 2.73.0)', () => [
        j && j.rooms.join() === 'rails,engine,engine,watchtower,,rails' && j.eng?.name === 'Engine Bay' && j.eng.roles.includes('engine-porter') && j.s.rooms.map((x) => x.name).join() === 'Rail Yard,Watchtower', JSON.stringify(j && { rooms: j.rooms, eng: j.eng })]);
      // The HUD itself: a train-daemon event seats it in the Rail Yard; the hub's /api/hud carries the panels.
      fs.rmSync(path.join(S, 'studio', 'divisions.json'), { force: true });
      fs.appendFileSync(ev, `${JSON.stringify({ ts: new Date().toISOString(), type: 'task.progress', agent: 'unity-worker-7', msg: 'port' })}\n`);
      const hub = await startHub(S, { ...env, AGENT_EVENTS_FILE: ev });
      const hud = (await req(hub.port, { path: '/api/hud' })).json || {};
      const room = (nm2) => (hud.agents || []).find((a) => a.name === nm2)?.room;
      await guard('274w rooms: /api/hud seats train-daemon in rails and unity-worker-7 in engine, lists the assignment rooms, and carries warRoom (fails on 2.73.0)', () => [
        room('train-daemon') === 'rails' && room('unity-worker-7') === 'engine' && (hud.assignmentRooms || []).map((x) => x.id).join() === 'rails,watchtower' && Array.isArray(hud.warRoom?.trains) && hud.warRoom.trains.length >= 1,
        JSON.stringify({ rooms: (hud.agents || []).map((a) => `${a.name}:${a.room}`), assignment: hud.assignmentRooms, warRoom: hud.warRoom && Object.keys(hud.warRoom) })]);
      hub.h.kill();
    }
  } finally {
    for (const k of kids) { try { k.kill(); } catch {} }
    await sleep(300);
    for (const S of made) { try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} }
  }
}
