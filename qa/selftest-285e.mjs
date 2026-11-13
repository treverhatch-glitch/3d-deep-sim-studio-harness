/**
 * qa/selftest-285e.mjs — 2.85 (e): six things a crew's overseer had to do by hand in its first 16 hours on 2.84.
 *
 *   1  the web train starts itself: an agent's `train auto off` lapses; why no train starts is said once per reason and in
 *      `train status`; it runs beside an engine land when RAM allows; tier C lanes are named with the one command
 *   2  "everything is blocked" does not fire while an engine train, an engine land or a rules check runs
 *   3  `studio:reload-env` names the settings the harness no longer reads on every path (one line, the event, the answer)
 *   4  a model's review carries its verdict: asked first, a larger output limit, one verdict-only follow-up
 *   5  a board command from a lane copy is not reported as a hand edit; a real edit still is, once
 *   6  unstamped commits from a harness release merged by a plain `git merge` get the one command that lists them
 *
 * Every model call goes to a stand-in; every train start to a stand-in starter. No network.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest285E({ dir, report, tmpRoot }) {
  const guard = async (name, fn) => { try { const [ok, d] = await fn(); report(name, Boolean(ok), ok ? '' : String(d || '').slice(0, 3000)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 3000)); } };
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI|VERTEX)/i.test(k)) clean[k] = '';
  if (process.platform === 'win32') for (const k of ['SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData']) if (process.env[k]) clean[k] = process.env[k];
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_DRIFT: 'off', STUDIO_LANELESS: 'shared', STUDIO_UPGRADE_WATCH_MIN: 'off', STUDIO_VISUAL_GATE: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-285e-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '', npm_config_node_options: '',
  };
  let n = 0;
  const studio = (name, { git = true, dotenv = '' } = {}) => {
    const S = path.join(tmpRoot, `285e-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    fs.writeFileSync(path.join(S, '.env'), dotenv);
    const ev = path.join(S, '.studio', 'events-285e.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
    if (git) { g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify'); }
    return { S, ev, env: { ...base, AGENT_EVENTS_FILE: ev } };
  };
  const events = (ev) => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  const probe = (S, env, code) => {
    const f = path.join(tmpRoot, `probe-285e-${process.pid}-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 240000 });
    try { fs.rmSync(f, { force: true }); } catch { /* swept later */ }
    const l = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(l), _out: out(r).slice(-1500) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const node = (cwd, args, env) => spawnSync(process.execPath, args, { windowsHide: true, cwd, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120000 });

  // ================= 1. the web train starts itself =================
  {
    const { S, env, ev } = studio('daemon');
    const r = probe(S, env, `import fs from 'node:fs'; import path from 'node:path';
import * as td from ${u(S, 'harness/train-daemon.mjs')};
const root = process.cwd(); const r = {}; const evs = []; const emit = (e) => evs.push(e);
const old = new Date(Date.now() - 3600000).toISOString();
const lane = (task, extra = {}) => ({ task, agent: 'builder-a', dir: '/x', head: 'h-' + task, at: old, ...extra });
const go = { trainOn: true, halted: null, drain: null, winddown: null, stopped: null, lock: null, next: null, running: null, redMain: null, heldOut: () => false, rules: { min: 1, waitMin: 0 }, betaRelease: false };
let spawned = 0; const spawnTrain = () => { spawned += 1; return { pid: null }; };
const reset = () => { for (const f of ['daemon.json', 'daemon-why.json']) fs.rmSync(path.join(root, '.studio', 'train', f), { force: true }); };
fs.mkdirSync(path.join(root, '.studio', 'train'), { recursive: true });
// (a) an agent's off switch from five hours ago has lapsed; a person's has not.
fs.writeFileSync(td.AUTO_FILE(root), JSON.stringify({ off: true, by: 'overseer-a', why: '', at: new Date(Date.now() - 5 * 3600000).toISOString(), via: 'delegation', recordedBy: 'overseer-a' }));
r.lapsed = await td.trainDaemonPass({ root, env: {}, emit, spawnTrain, ...go, queue: [lane('T-11')], room: { ok: true } });
r.autoAfter = JSON.parse(fs.readFileSync(td.AUTO_FILE(root), 'utf8'));
reset();
fs.writeFileSync(td.AUTO_FILE(root), JSON.stringify({ off: true, by: 'Dana', why: 'demo day', at: new Date(Date.now() - 50 * 3600000).toISOString(), via: 'person' }));
r.person = await td.trainDaemonPass({ root, env: {}, emit, spawnTrain, ...go, queue: [lane('T-11')], room: { ok: true } });
r.person2 = await td.trainDaemonPass({ root, env: {}, emit, spawnTrain, ...go, queue: [lane('T-11')], room: { ok: true } });
r.personLine = td.daemonWaitingLine(root, { env: {}, queue: [lane('T-11')] });
fs.rmSync(td.AUTO_FILE(root), { force: true }); reset();
// (b) tier A/B lanes ready, the machine has room: a train starts (the room read from given machine facts).
const profile = (freeGb) => ({ at: new Date(Date.now() - 600000).toISOString(), ram: { totalGb: 32, freeGb }, cores: { logical: 8 } });
const engine = { pid: process.pid, at: Date.now(), label: 'the engine land', claim: { kind: 'engine-land', engine: 'unity', ramGb: 12, cpuThreads: 2 } };
const e2 = { STUDIO_RESERVE_RAM_GB: '2' };
r.free = await td.trainDaemonPass({ root, env: e2, emit, spawnTrain, ...go, queue: [lane('T-21')], heldNow: () => false, machine: { profile: profile(26), holders: [], slots: 1 } });
reset();
// (c) an engine land runs and RAM covers the web verify: it starts beside it.
r.beside = await td.trainDaemonPass({ root, env: e2, emit, spawnTrain, ...go, queue: [lane('T-22')], heldNow: () => false, machine: { profile: profile(26), holders: [engine], slots: 1 } });
reset();
// (d) not enough RAM beside it: waiting, said once although the figures move.
const n0 = evs.length;
r.tight1 = await td.trainDaemonPass({ root, env: e2, emit, spawnTrain, ...go, queue: [lane('T-23')], heldNow: () => false, machine: { profile: profile(14), holders: [engine], slots: 1 } });
r.tight2 = await td.trainDaemonPass({ root, env: e2, emit, spawnTrain, ...go, queue: [lane('T-23')], heldNow: () => false, machine: { profile: profile(14.6), holders: [engine], slots: 1 } });
r.tightEvents = evs.slice(n0).filter((e) => e.type === 'train.daemon.waiting').map((e) => e.msg);
r.tightLine = td.daemonWaitingLine(root, { env: e2, queue: [lane('T-23')] });
reset();
// (e) only tier C lanes: waiting with the lanes and the one command; never released.
const held = [lane('T-31', { held: { tier: 'C', why: 'a protected file' } }), lane('T-32', { held: { tier: 'C', why: 'a protected file' } })];
const n1 = evs.length;
r.tierC = await td.trainDaemonPass({ root, env: {}, emit, spawnTrain, ...go, betaRelease: true, queue: held, heldNow: (e) => Boolean(e.held), room: { ok: true } });
r.tierCPerson = td.daemonDecision({ auto: { on: true }, ...go, betaRelease: false, queue: held, heldNow: (e) => Boolean(e.held), room: { ok: true } });
r.tierCEvents = evs.slice(n1).filter((e) => e.type === 'train.daemon.waiting').map((e) => e.msg);
r.heldStill = held.every((e) => e.held && !e.released);
r.spawned = spawned;
r.autoOnEvents = evs.filter((e) => e.type === 'task.train.auto_on').map((e) => e.msg);
console.log(JSON.stringify(r));`);
    await guard('2.85 (e1): an off switch an agent set (via its delegation) lapses after STUDIO_TRAIN_AUTO_OFF_HOURS (4) and the next pass starts the train, with one task.train.auto_on saying so; a person\'s off stays until they turn it on, is said once (not every pass) and is the line `train status` prints (fails before this fix: an agent\'s off lasted for days, and while off the daemon said nothing anywhere)', () => [
      r.lapsed?.started === true && r.autoAfter?.off === false && r.autoOnEvents?.length === 1 && /ended at/.test(r.autoOnEvents[0])
        && r.person?.started === false && /train auto is off \(by Dana/.test(r.person.why) && r.person2?.started === false
        && /^The automatic start is waiting: train auto is off \(by Dana/.test(r.personLine || ''),
      JSON.stringify(r).slice(0, 2500)]);
    await guard('2.85 (e1): with tier A/B lanes ready and the machine budget admitting the web verify, the daemon starts a train with no person: on a free machine, and beside a running engine land when free RAM covers the verify (the engine land takes no machine:heavy slot; its RAM counts) (fails before this fix: verifyRoom could not be given the machine, so this was not checkable; the starts are the budget\'s existing rule)', () => [
      r.free?.started === true && r.beside?.started === true && (r.beside.lanes || []).includes('T-22'),
      JSON.stringify({ free: r.free, beside: r.beside, out: r._out || r._raw })]);
    await guard('2.85 (e1): beside an engine land without RAM for the web verify the daemon waits and says so ONCE (one train.daemon.waiting while only the RAM figures move) and `train status` reads "The automatic start is waiting: no room on the machine for a verify" (fails before this fix: the whole text was compared, so a moving RAM figure said it again on most passes, and train status said nothing)', () => [
      r.tight1?.started === false && r.tight2?.started === false && /no room on the machine for a verify: waiting for RAM/.test(r.tight1.why) && r.tightEvents?.length === 1
        && /^The automatic start is waiting: no room on the machine for a verify/.test(r.tightLine || ''),
      JSON.stringify({ t1: r.tight1, t2: r.tight2, ev: r.tightEvents, line: r.tightLine })]);
    await guard('2.85 (e1): when only tier C lanes wait, the daemon starts nothing and releases nothing; its waiting reason names the lanes and the one command (npm run task -- train release <ID> --by <name>), saying a stand-in may release in beta mode, and a person otherwise (fails before this fix: "every queued lane waits for the owner or is held out of trains", no lane, no command)', () => [
      r.tierC?.started === false && /T-31, T-32 need the owner \(tier C\)/.test(r.tierC.why) && /npm run task -- train release <ID> --by <name>/.test(r.tierC.why) && /stand-in may release/.test(r.tierC.why)
        && /a person releases it/.test(r.tierCPerson?.why || '') && r.tierCEvents?.length === 1 && r.heldStill === true && r.spawned === 3,
      JSON.stringify({ c: r.tierC, p: r.tierCPerson, ev: r.tierCEvents, spawned: r.spawned })]);
    // `train status` itself prints the line (the command a person reads).
    fs.mkdirSync(path.join(S, '.studio', 'train'), { recursive: true });
    fs.writeFileSync(path.join(S, '.studio', 'train', 'queue.json'), JSON.stringify([{ task: 'T-41', agent: 'builder-a', branch: 'lane/builder-a', head: 'abcdef12', at: new Date().toISOString(), dir: '/x' }]));
    fs.writeFileSync(path.join(S, '.studio', 'train', 'auto.json'), JSON.stringify({ off: true, by: 'Dana', why: 'demo day', at: new Date().toISOString(), via: 'person' }));
    const st = node(S, ['harness/task.mjs', 'train', 'status'], env);
    await guard('2.85 (e1): `npm run task -- train status` prints "The automatic start is waiting: <reason>" while lanes wait and the daemon is off (fails before this fix: train status never mentioned the daemon)', () => [
      /The automatic start is waiting: train auto is off \(by Dana/.test(out(st)), out(st).slice(-1500)]);
    void ev;
  }

  // ================= 2. "everything is blocked" counts a running engine train =================
  {
    const { S, env } = studio('comm', { git: false });
    fs.mkdirSync(path.join(S, '.studio', 'locks'), { recursive: true });
    const r = probe(S, env, `import fs from 'node:fs'; import path from 'node:path';
import * as cm from ${u(S, 'harness/communicator.mjs')};
const root = process.cwd(); const r = {};
fs.writeFileSync(path.join(root, '.studio', 'locks', 'unity-train.lock'), JSON.stringify({ pid: process.pid, id: 'u-77', at: Date.now() }));
r.wip = typeof cm.workInProgress === 'function' ? await cm.workInProgress(root, { env: process.env }) : null;
const now = Date.now();
const f = (inProgress) => ({ now, supRunning: true, workers: [], blockers: [{ text: 'every task waits for T-1' }], stopFiles: [], held: [], needs: [], asks: [], events: [], train: null, trainLock: null, diskFreeGb: 500, line: null, crewPaused: [], queue: [], sup: null, unendedTrains: [], inProgress });
const state = { blockedSince: new Date(now - 3 * 3600000).toISOString() };
const keys = (a) => a.map((x) => x.key);
r.engine = cm.alertsNow(f([{ text: 'the unity train u-77', work: true }]), { env: {}, state }); r.engineBlocked = keys(r.engine).includes('all-blocked');
r.other = cm.alertsNow(f([{ text: 'a browser playtest', work: false }]), { env: {}, state }); r.otherText = (r.other.find((a) => a.key === 'all-blocked') || {}).text || '';
r.none = keys(cm.alertsNow(f([]), { env: {}, state })).includes('all-blocked');
console.log(JSON.stringify(r));`);
    await guard('2.85 (e2): "everything is blocked" does not fire while an engine train holds its lock (workInProgress finds .studio/locks/<engine>-train.lock with a live pid) or an engine land / rules check runs; with nothing but other heavy work running it still fires and names it (fails before this fix: it counted only agents and the web train, and fired during an engine train)', () => [
      Array.isArray(r.wip) && r.wip.some((x) => x.work && /unity train u-77/.test(x.text)) && r.engineBlocked === false && /running, not landing work: a browser playtest/.test(r.otherText) && r.none === true,
      JSON.stringify(r).slice(0, 2000)]);
  }

  // ================= 3. studio:reload-env names the names on every path =================
  {
    const MISSPELT = 'STUDIO' + '_HEAVY_SLOTZ';
    const GONE = 'STUDIO' + '_QQQ_NEVER_EXISTED_SETTING';
    const { S, env } = studio('env', { git: false, dotenv: 'STUDIO_HEAVY_SLOTS=3\n' });
    const r = probe(S, env, `import fs from 'node:fs'; import path from 'node:path';
import * as er from ${u(S, 'harness/env-reload.mjs')};
const r = {}; const evs = [];
fs.writeFileSync(path.join(process.cwd(), '.env'), ['STUDIO_HEAVY_SLOTS=3', '${MISSPELT}=2', '${GONE}=hunter2-secret-value', ''].join('\\n'));
r.res = er.reloadEnvIfChanged({ by: 'test', force: true, emit: (e) => evs.push(e) });
r.msg = evs.map((e) => e.msg).join(' | ');
console.log(JSON.stringify(r));`);
    const cli = node(S, ['harness/env-reload.mjs', '--by', 'test'], env);
    const one = out(cli).split('\n').find((l) => /no longer reads/.test(l)) || '';
    await guard('2.85 (e3): the names the harness no longer reads are on ONE line (the summary line of `studio:reload-env`) and in the env.reloaded event, each with the closest current name or "none is close", and no value anywhere (fails before this fix: the summary line said only "2 names the harness no longer reads" with the names on the lines after it, so a filtered or cut output lost them, and the event named none)', () => [
      new RegExp(`${MISSPELT} \\(closest current name: STUDIO_HEAVY_SLOTS\\)`).test(one) && new RegExp(`${GONE} \\(none is close\\)`).test(one)
        && new RegExp(`no longer reads: .*${MISSPELT} \\(closest current name: STUDIO_HEAVY_SLOTS\\)`).test(r.msg || '') && new RegExp(`${GONE} \\(none is close\\)`).test(r.msg || '')
        && !/hunter2/.test(`${out(cli)}${r.msg || ''}`),
      `line: ${one} | event: ${r.msg} | ${r._raw || ''}`]);
  }

  // ================= 4. a model's review carries its verdict =================
  {
    const next = ['# Studio Task Queue (`studio/NEXT.md`)', '', '## IN_PROGRESS', '- [ ] **T-101** [P1] (`builder`) — Add a rules toggle to the sim', '', '## BACKLOG', '', '## DONE', ''].join('\n');
    const mk = (name, dotenv = '') => {
      const s = studio(name, { git: false, dotenv });
      fs.rmSync(path.join(s.S, 'studio', 'models.json'), { force: true });
      fs.rmSync(path.join(s.S, 'studio', 'review.json'), { force: true });
      fs.writeFileSync(s.ev, `${JSON.stringify({ id: 'evt_285e_1', ts: new Date().toISOString(), type: 'task.start', agent: 'builder-w1', task: 'T-101', model: 'claude-opus-5-5' })}\n`);
      fs.writeFileSync(path.join(s.S, 'studio', 'NEXT.md'), next);
      g(s.S, 'init', '-q', '-b', 'main'); g(s.S, 'add', '-A'); g(s.S, 'commit', '-qm', 'studio', '--no-verify');
      fs.mkdirSync(path.join(s.S, 'game', 'rules'), { recursive: true });
      fs.writeFileSync(path.join(s.S, 'game', 'rules', 'toggle.mjs'), 'export const toggle = (s) => ({ ...s, on: !s.on });\n');
      g(s.S, 'add', '-A'); g(s.S, 'commit', '-qm', 'Add a rules toggle\n\nStudio-Task: T-101\nStudio-Model: claude-opus-5-5', '--no-verify');
      return s;
    };
    const { S, env } = mk('review');
    const r = probe(S, env, `import fs from 'node:fs';
import { askReview } from ${u(S, 'harness/review-ask.mjs')};
const r = {}; const calls = [];
const answers = ['WHY: the toggle is pure but has no test.\\nISSUES:\\n- game/rules/toggle.mjs: add a test', 'VERDICT: changes'];
const transport = async ({ messages, maxTokens }) => { calls.push({ n: messages.length, last: messages.at(-1).content, maxTokens }); return { ok: true, text: answers[calls.length - 1] || '' }; };
r.a = await askReview('T-101', { model: 'google/gemini-3.1-pro-preview', noCommit: true, deps: { transport, doneSummary: () => 'x' } });
r.text = r.a.file ? fs.readFileSync(r.a.file, 'utf8') : '';
r.calls = calls.map((c) => ({ n: c.n, maxTokens: c.maxTokens, firstAsk: /FIRST line, before any finding, must be exactly one of: VERDICT: approve \\| VERDICT: changes \\| VERDICT: unsure/.test(c.last), verdictOnly: /^Give only the verdict line/.test(c.last) }));
const calls2 = [];
r.b = await askReview('T-101', { model: 'google/gemini-3.1-pro-preview', noCommit: true, env: { ...process.env, STUDIO_REVIEW_MAX_TOKENS: '6000' }, deps: { transport: async ({ maxTokens }) => { calls2.push(maxTokens); return { ok: true, text: 'VERDICT: unsure\\nWHY: cannot tell without the spec.' }; }, doneSummary: () => 'x' } });
r.calls2 = calls2;
console.log(JSON.stringify(r));`);
    await guard('2.85 (e4): `review ask` asks for the verdict as the FIRST line (approve|changes|unsure) with an output limit of STUDIO_REVIEW_MAX_TOKENS (4000 by default, 6000 when set); an answer with findings but no verdict line gets ONE verdict-only follow-up and is then recorded with that verdict; an unsure verdict is a draft (fails before this fix: max 2000 tokens, the verdict asked for last, and a cut answer became a draft at once)', () => [
      r.a?.ok === true && r.a.verdict === 'request changes' && /^Verdict: request changes$/m.test(r.text) && r.calls?.length === 2 && r.calls[0].firstAsk && r.calls[0].maxTokens === 4000
        && r.calls[1].verdictOnly && r.calls[1].n === r.calls[0].n + 2 && r.b?.ok === false && /unsure/.test(r.b.line) && /\.rejected\.txt$/.test(r.b.draft || '') && r.calls2?.[0] === 6000 && r.calls2.length === 1,
      JSON.stringify(r).slice(0, 2500)]);
    const TOKEN = `fakeTok285e${process.pid}QQ`;
    const v = mk('vertex', `VERTEX_API_KEY=${TOKEN}\nVERTEX_PROJECT_ID=p-285e\nSTUDIO_VERTEX_BASE_URL=http://127.0.0.1:9/v1\n`);
    const rv = probe(v.S, { ...v.env, VERTEX_API_KEY: TOKEN }, `
import { askReview } from ${u(v.S, 'harness/review-ask.mjs')};
const bodies = [];
const fetchImpl = async (url, init) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({ model: 'google/gemini-3.1-pro-preview', choices: [{ message: { content: 'VERDICT: approve\\nWHY: fine.\\nISSUES:\\n- none' } }] }), { status: 200 }); };
const a = await askReview('T-101', { model: 'google/gemini-3.1-pro-preview', noCommit: true, deps: { fetchImpl, doneSummary: () => 's' } });
console.log(JSON.stringify({ ok: a.ok, max: bodies.map((b) => b.max_tokens) }));`);
    await guard('2.85 (e4): the Vertex transport asks for max_tokens 4000 (STUDIO_REVIEW_MAX_TOKENS) (fails before this fix: 2000, which a thinking model spent before its VERDICT line)', () => [
      rv.ok === true && JSON.stringify(rv.max) === '[4000]', JSON.stringify(rv).split(TOKEN).join('<TOKEN>')]);
  }

  // ================= 5. the harness does not accuse itself of hand-editing the board =================
  {
    const { S, env } = studio('board');
    const lane = path.join(S, '.lanes', 'builder-a');
    g(S, 'worktree', 'add', '-q', '-b', 'lane/builder-a', lane);
    const r = probe(S, env, `import fs from 'node:fs'; import path from 'node:path';
import * as wa from ${u(S, 'harness/workaround.mjs')};
const main = process.cwd(); const lane = ${JSON.stringify(lane)};
const file = path.join(main, 'studio', 'NEXT.md');
const base = fs.readFileSync(file, 'utf8');
const later = () => { const t = new Date(Date.now() + 5000); fs.utimesSync(file, t, t); };
const write = (root, text) => { wa.stampWrite(file, text, { root }); fs.writeFileSync(file, text); later(); };
const r = {};
write(main, base + '\\n- [ ] **T-901** [P1] (\`builder\`) — from main\\n');
write(lane, base + '\\n- [ ] **T-902** [P1] (\`builder\`) — from the lane copy\\n');
r.mainSees = wa.checkStamped(file, { root: main });
write(main, base + '\\n- [ ] **T-903** [P1] (\`builder\`) — from main again\\n');
r.laneSees = wa.checkStamped(file, { root: lane });
fs.writeFileSync(file, base + '\\n- [ ] **T-904** [P1] (\`builder\`) — typed by hand\\n'); later();
r.hand1 = wa.checkStamped(file, { root: main });
r.hand2 = wa.checkStamped(file, { root: main });
r.hand3 = wa.checkStamped(file, { root: lane });
console.log(JSON.stringify({ mainSees: r.mainSees?.what || null, laneSees: r.laneSees?.what || null, hand1: r.hand1?.what || null, hand2: r.hand2?.what || null, hand3: r.hand3?.what || null }));`);
    await guard('2.85 (e5): board writes from a lane copy and from the main checkout are both the harness\'s: neither side reports the other\'s write as a hand edit; a real edit with no harness write is reported once, as studio/NEXT.md (fails before this fix: a lane copy stamped the board under its own root as "../../studio/NEXT.md", so main reported "hand-edited studio/NEXT.md" and the copy "../../studio/NEXT.md")', () => [
      r.mainSees === null && r.laneSees === null && r.hand1 === 'hand-edited studio/NEXT.md' && r.hand2 === null && r.hand3 === null,
      JSON.stringify(r).slice(0, 2000)]);
  }

  // ================= 6. the hooks gate names the one fix after a plain `git merge` of a release =================
  {
    const R = path.join(tmpRoot, `285e-hooks-${process.pid}-${++n}`);
    fs.mkdirSync(R, { recursive: true });
    const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(R, rel)), { recursive: true }); fs.writeFileSync(path.join(R, rel), text); };
    const commit = (msg) => { g(R, 'add', '-A'); g(R, 'commit', '-qm', msg, '--no-verify'); return g(R, 'rev-parse', 'HEAD').stdout.trim(); };
    g(R, 'init', '-q', '-b', 'main');
    put('package.json', '{ "name": "studio", "version": "1.0.0" }\n'); put('game/a.js', 'export const a = 1;\n'); put('harness/x.mjs', 'export const x = 1;\n');
    const baseSha = commit('base');
    g(R, 'checkout', '-q', '-b', 'release');
    put('harness/x.mjs', 'export const x = 2;\n'); const rel1 = commit('harness: x is 2');
    put('package.json', '{ "name": "studio", "version": "1.1.0" }\n'); put('docs/RELEASE-NOTES.md', 'notes\n'); const rel2 = commit('1.1.0');
    g(R, 'update-ref', 'refs/remotes/origin/main', rel2);
    g(R, 'checkout', '-q', 'main');
    put('game/b.js', 'export const b = 2;\n'); const own = commit('game: b');
    g(R, 'merge', '-q', '--no-ff', '--no-edit', 'release');
    const m = g(R, 'rev-parse', 'HEAD').stdout.trim();
    const hintFile = path.join(dir, 'harness', 'hooks-upgrade-hint.mjs');
    const r = probe(R, { ...base, STUDIO_LOCK_OWNER: '' }, `
import { upgradeMergeHint } from ${JSON.stringify(pathToFileURL(hintFile).href)};
import { hooksAfterUpgrade } from ${JSON.stringify(pathToFileURL(path.join(dir, 'harness', 'upgrade-guard.mjs')).href)};
import fs from 'node:fs'; import path from 'node:path';
const cwd = process.cwd(); const r = {};
const open = [${JSON.stringify(m)}, ${JSON.stringify(rel2)}, ${JSON.stringify(rel1)}].map((sha) => ({ sha }));
r.hint = await upgradeMergeHint(open, { cwd, base: ${JSON.stringify(baseSha)} });
r.notAll = await upgradeMergeHint([...open, { sha: ${JSON.stringify(own)} }], { cwd, base: ${JSON.stringify(baseSha)} });
fs.mkdirSync(path.join(cwd, 'harness'), { recursive: true }); fs.copyFileSync(${JSON.stringify(hintFile)}, path.join(cwd, 'harness', 'hooks-upgrade-hint.mjs'));
r.after = await hooksAfterUpgrade(cwd, { deps: { check: () => ({ ok: false, open, baseSha: ${JSON.stringify(baseSha)} }) } });
r.afterClean = await hooksAfterUpgrade(cwd, { deps: { check: () => ({ ok: true, open: [] }) } });
console.log(JSON.stringify({ hint: r.hint ? { command: r.hint.command, who: r.hint.who, lines: r.hint.lines, to: r.hint.to } : null, notAll: r.notAll, after: r.after, afterClean: r.afterClean }));`);
    // The same shape where the merge also brings a game file: not a harness release.
    fs.rmSync(path.join(R, 'harness', 'hooks-upgrade-hint.mjs'), { force: true });
    g(R, 'checkout', '-q', '-b', 'mixed', rel2); put('game/c.js', 'export const c = 4;\n'); put('package.json', '{ "name": "studio", "version": "1.2.0" }\n'); const mixTip = commit('mixed');
    g(R, 'checkout', '-q', 'main');
    g(R, 'merge', '-q', '--no-ff', '--no-edit', 'mixed');
    const m2 = g(R, 'rev-parse', 'HEAD').stdout.trim();
    const r2 = probe(R, { ...base, STUDIO_LOCK_OWNER: '' }, `
import { upgradeMergeHint } from ${JSON.stringify(pathToFileURL(hintFile).href)};
const h = await upgradeMergeHint([{ sha: ${JSON.stringify(m2)} }, { sha: ${JSON.stringify(mixTip)} }], { cwd: process.cwd(), base: ${JSON.stringify(m)} });
console.log(JSON.stringify({ h }));`);
    const hs = fs.readFileSync(path.join(dir, 'harness', 'hook-stamp.mjs'), 'utf8');
    await guard('2.85 (e6): unstamped commits that all came in with a harness release merged by a plain `git merge` (the merge changed package.json\'s version and only harness-owned paths) get the one command "node harness/hook-stamp.mjs grandfather --ref origin/main" and who may run it (a person; beta mode off here), in the hooks gate\'s failure output instead of the reset advice and in the after-upgrade report ("hooks check: N upstream commit(s) are unstamped; run: ..."); a studio commit among them, or a merge that touches game files, gets no such hint; nothing is exempted (fails before this fix: the gate printed only "git reset --soft ...", and agents wrote that only a person could fix it)', () => [
      r.hint?.command === 'node harness/hook-stamp.mjs grandfather --ref origin/main' && /a person runs it/.test(r.hint.who) && r.hint.to === '1.1.0' && !r.hint.lines.some((l) => /reset --soft/.test(l))
        && r.notAll === null && /hooks check: 3 upstream commit\(s\) are unstamped .*; run: node harness\/hook-stamp\.mjs grandfather --ref origin\/main/.test(r.after || '') && r.afterClean === ''
        && r2.h === null && /upgradeMergeHint\(r\.open/.test(hs) && !fs.existsSync(path.join(R, '.git', 'studio-hooks-grandfather.json')),
      JSON.stringify({ r, r2 }).slice(0, 2500)]);
  }
}
