/**
 * qa/selftest-265t.mjs — 2.65.0 (hands-off by default): decisions from evidence, self-triage, the daily digest, the
 * autonomy level command, cost per merged change.
 *   1. A "bug"-titled task whose commits change only tests/config is judged a "change" (no replay; one
 *      task.type.evidence event); one that changes a sim path stays a bug and needs its replay; an owner's type record
 *      outranks the evidence.
 *   2. Self-triage: a supervisor halt for a tool not on PATH is fixed (the tool marked out, the next tool takes over,
 *      the halt cleared by "self-triage") once per cause per window, then left for a person; unknown causes and custom
 *      commands stay halted; a dead heavy holder's orphans are killed and its slot freed; a game check that timed out
 *      under load runs once more at the cap (not without load, not twice); rescues of landed tasks are closed; a hub
 *      that stopped answering is started again when no supervisor runs.
 *   3. `npm run digest` writes studio/digest/<date>.md (under 200 words) with what needs a person, the scorecard line
 *      and what self-triage did, and one event; nothing waiting: one line; the watchdog's daily run at the hour.
 *   4. `npm run autonomy -- level` sets the level for a person, a Producer session, or an outside agent on permission;
 *      workers and an outside agent without permission are refused; one autonomy.level event.
 *   5. The scorecard: tokens per landed task (and the window before), tokens only without a price table (dollars with
 *      studio/prices.json), person round-trips per landed task, conductor notes, and a self-triage resume is no
 *      person's intervention.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest265T({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const ident = { GIT_AUTHOR_NAME: 'hatch', GIT_AUTHOR_EMAIL: 'owner@example.com', GIT_COMMITTER_NAME: 'hatch', GIT_COMMITTER_EMAIL: 'owner@example.com' };
  const env = { ...ident, STUDIO_ROLE: '', STUDIO_LOCK_OWNER: '', STUDIO_AGENT: '', STUDIO_MAIN_ROOT: '', CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', CLAUDE_PROJECT_DIR: '', STUDIO_GAME: '', STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_SELF_TRIAGE: '', STUDIO_TYPE_EVIDENCE: '', STUDIO_DIGEST: '', STUDIO_DIGEST_HOUR: '', STUDIO_TEST_ON_PATH: '', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-265t-${process.pid}.pem`) };
  const git = (cmd, e = {}) => run(dir, `git -c user.name=hatch -c user.email=owner@example.com ${cmd}`, { ...env, ...e });
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  const task = (cmd, e = {}) => run(dir, `node harness/task.mjs ${cmd}`, { ...env, ...e });
  const add = (title, role = 'builder') => JSON.parse(task(`add "${title}" --role ${role}`).stdout).id;
  const doneCheck = (id, e = {}) => out(run(dir, `node harness/done-check.mjs ${id}`, { ...env, ...e }));
  const events = () => { try { return fs.readFileSync(path.join(dir, '.studio', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }); } catch { return []; } };
  const probe = (name, code, e = {}) => {
    const f = path.join(dir, `.probe-265t-${name}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node ${path.basename(f)}`, { ...env, ...e });
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return { ...JSON.parse(line), _err: String(r.stderr || '').slice(-1500) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const REG = /Regression saved/;

  git('init -q -b main');
  git('config core.autocrlf false');
  git('add -A');
  git('commit -q -m base --no-verify');

  // ---- 1. the type from the diff ----
  w('game/toy/sim/fees.mjs', 'export const fee = 1;\n');
  w('game/toy/tests/camera.test.mjs', 'export const t = 1;\n');
  w('game/toy/vitest.config.mjs', 'export default { test: { testTimeout: 5000 } };\n');
  git('add -A');
  git('commit -q -m toy --no-verify');
  const tFlaky = add('Bug: the camera test times out on a busy machine');
  w('game/toy/tests/camera.test.mjs', 'export const t = 2;\n');
  w('game/toy/vitest.config.mjs', 'export default { test: { testTimeout: 15000 } };\n');
  git('add -A');
  git(`commit -q -m flaky --no-verify --trailer "Studio-Task: ${tFlaky}"`);
  const dcFlaky = doneCheck(tFlaky);
  doneCheck(tFlaky);
  const evFlaky = events().filter((e) => e.type === 'task.type.evidence' && e.task === tFlaky);
  const tSim = add('Bug: fees go negative after a loan');
  w('game/toy/sim/fees.mjs', 'export const fee = Math.max(0, 1);\n');
  w('game/toy/tests/camera.test.mjs', 'export const t = 3;\n');
  git('add -A');
  git(`commit -q -m fees --no-verify --trailer "Studio-Task: ${tSim}"`);
  const dcSim = doneCheck(tSim);
  const tOwn = add('Bug: the fee test is flaky');
  const typed = task(`type ${tOwn} bug --by hatch --why "it is a real bug: keep the replay"`);
  w('game/toy/tests/camera.test.mjs', 'export const t = 4;\n');
  git('add -A');
  git(`commit -q -m owntest --no-verify --trailer "Studio-Task: ${tOwn}"`);
  const dcOwn = doneCheck(tOwn);
  report('2.65.0 (evidence): a "Bug:" task whose commits change only a test and a test config is judged a "change" ("type: change (evidence: only tests/config changed: …)", no regression replay asked) with one task.type.evidence event; a bug that changes a sim path stays a bug and needs its replay; an owner\'s "bug" record outranks the evidence',
    /is a "change" task \(evidence: only tests\/config changed: game\/toy\/tests\/camera\.test\.mjs, game\/toy\/vitest\.config\.mjs\)/.test(dcFlaky) && /type: change \(evidence: only tests\/config changed:/.test(dcFlaky) && !REG.test(dcFlaky) && evFlaky.length === 1 && evFlaky[0].meta?.from === 'bug'
      && /is a "bug" task/.test(dcSim) && REG.test(dcSim) && !/evidence/.test(dcSim)
      && typed.status === 0 && /is a "bug" task/.test(dcOwn) && REG.test(dcOwn),
    `${dcFlaky.slice(0, 900)}\n${JSON.stringify(evFlaky).slice(0, 300)}\n---\n${dcSim.slice(0, 600)}\n---\n${out(typed).slice(0, 300)}\n${dcOwn.slice(0, 600)}`);

  // ---- 2a. a supervisor halt: the tool isn't on PATH ----
  const st = path.join(dir, '.studio');
  fs.mkdirSync(st, { recursive: true });
  w('studio/budget.json', JSON.stringify({ order: ['nim', 'claude', 'codex'], tools: {} }, null, 2));
  const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
  fs.appendFileSync(path.join(st, 'events.jsonl'), ['nim-s1', 'nim-s2'].map((a, i) => `${JSON.stringify({ ts: ago(30 - i * 10), type: 'agent.session.end', agent: a, status: 'error', meta: { role: 'builder', tool: 'nim', code: 127, reason: 'exit 127' } })}\n`).join(''));
  const sup = probe('sup', `import fs from 'node:fs';
import { supervise } from ${u('harness/supervisor.mjs')};
const deps = { sessions: () => [], startAgent: () => ({ ok: false }), launchableRoles: () => [], nextAgentName: () => 'x-s9' };
const state = { startedAt: Date.now() - 3600000, names: ['nim-s1', 'nim-s2'] };
const r1 = await supervise({ deps }, state);
const resume = fs.existsSync('.studio/supervisor-resume') ? JSON.parse(fs.readFileSync('.studio/supervisor-resume', 'utf8')) : null;
const quota = JSON.parse(fs.readFileSync('.studio/tool-quota.json', 'utf8'));
const r2 = await supervise({ deps }, state);
const { pickTool } = await import(${u('harness/budget.mjs')});
console.log(JSON.stringify({ r1: r1.why, halted: state.halted, resume, quotaNim: quota.nim, r2: r2.why, pick: pickTool('nim') }));`, { STUDIO_TEST_ON_PATH: 'claude' });
  const evs = events();
  const resumed = evs.filter((e) => e.type === 'supervisor.resumed').pop();
  const fixEv = evs.filter((e) => e.type === 'selftriage.switch-tool');
  const hrs = (Date.parse(sup.quotaNim?.until || '') - Date.now()) / 3600000;
  report('2.65.0 (self-triage, switch-tool): two sessions ending exit 127 (nim not on PATH) halt the supervisor; self-triage marks nim out for the window (6 h), claude takes over, the halt is cleared as studio:resume does with by "self-triage", and one selftriage.switch-tool event names the cause',
    /halted: two sessions in a row ended with exit 127/.test((sup.r1 || []).join(' ')) && sup.resume?.by === 'self-triage' && /nim not on PATH/.test(sup.resume?.why || '') && hrs > 5.5 && hrs <= 6.01 && sup.pick === 'claude'
      && resumed?.meta?.by === 'self-triage' && fixEv.length === 1 && fixEv[0].meta?.cause === 'tool-missing:nim' && fixEv[0].meta?.to === 'claude' && !(sup.r2 || []).some((x) => /^halted/.test(x)),
    JSON.stringify({ sup, resumed, fixEv }).slice(0, 2500));

  const tri = probe('tri', `import fs from 'node:fs';
import { triageHalt } from ${u('harness/self-triage.mjs')};
fs.rmSync('.studio/supervisor-resume', { force: true });
const again = await triageHalt({ code: 127, tool: 'nim', why: "two sessions in a row ended with exit 127: nim wasn't found" }, { onPath: (p) => p === 'claude' });
const unknown = await triageHalt({ code: 1, tool: 'claude', why: 'two sessions in a row ended with exit 1: check npm run agent -- logs x' }, { onPath: () => true });
const custom = await triageHalt({ code: 127, tool: 'mytool', custom: true, why: "mytool wasn't found" }, { onPath: () => true });
const none = await triageHalt({ code: 9009, tool: 'codex', why: "codex wasn't found" }, { onPath: () => false });
console.log(JSON.stringify({ again, unknown, custom, none, resume: fs.existsSync('.studio/supervisor-resume') }));`);
  const declined = events().filter((e) => e.type === 'selftriage.declined');
  report('2.65.0 (self-triage): the same cause inside the window, an unknown cause (exit 1), a custom command and a tool with no other tool on PATH all stay halted for a person (no resume written; selftriage.declined names the reason for the listed causes)',
    tri.again?.fixed === false && /at most once per cause/.test(tri.again?.why || '') && tri.unknown?.fixed === false && /not on the self-triage list/.test(tri.unknown?.why || '') && tri.custom?.fixed === false && /custom command/.test(tri.custom?.why || '') && tri.none?.fixed === false && tri.resume === false && declined.length >= 3,
    JSON.stringify({ tri, declined: declined.map((e) => e.msg) }).slice(0, 2500));

  // ---- 2b. a dead heavy holder's orphans ----
  const reap = probe('reap', `import fs from 'node:fs';
import path from 'node:path';
import { reapPass } from ${u('harness/self-triage.mjs')};
const now = Date.now();
fs.mkdirSync('.studio/locks', { recursive: true });
const rec = { pid: 999991, label: 'verify', owner: 'builder-s1', at: now - 60000, identity: { start: now - 61000 }, tree: { root: 999991 } };
fs.writeFileSync('.studio/locks/machine-heavy-0.lock', JSON.stringify(rec));
let procs = [{ pid: 999992, ppid: 999991, pgid: 999992, start: now - 30000, cmd: 'node vitest' }, { pid: 999993, ppid: 999992, pgid: 999992, start: now - 29000, cmd: 'node worker' }];
const killed = [];
const killOpts = { listProcs: () => procs, signal: (pid) => { killed.push(pid); procs = procs.filter((p) => p.pid !== Math.abs(pid)); return true; }, platform: 'linux', graceMs: 0, self: process.pid };
const a = await reapPass({ root: process.cwd(), killOpts });
const slot = fs.existsSync('.studio/locks/machine-heavy-0.lock');
console.log(JSON.stringify({ a, killed, slot, left: procs.length }));`);
  const reapEv = events().filter((e) => e.type === 'selftriage.reap-orphans');
  report('2.65.0 (self-triage, reap-orphans): a machine:heavy holder whose root is gone with two processes of its tree still running: both are killed, its slot is freed, and one selftriage.reap-orphans event names the holder',
    reap.left === 0 && reap.killed?.includes(999992) && reap.killed?.includes(999993) && reap.slot === false && reapEv.length === 1 && /verify/.test(reapEv[0].msg || ''), JSON.stringify({ reap, reapEv }).slice(0, 2000));

  // ---- 2c. a game check that timed out under load ----
  w('game/slowtoy/studio.gates.json', JSON.stringify({ gates: [{ id: 'suite', command: 'node game/slowtoy/slow.mjs' }] }, null, 2));
  w('game/slowtoy/slow.mjs', 'setTimeout(() => { console.log("12 tests passed"); process.exit(0); }, 4600);\n');
  const gg = { STUDIO_GAME: 'slowtoy', STUDIO_GAME_GATE_TIMEOUT_MS: '2000', STUDIO_TEST_LOADAVG: '0', STUDIO_GAME_GATE_TIMEOUT_FLOOR: 'off', STUDIO_SILENT_GREEN: 'off' };
  const g1 = run(dir, 'node harness/game-gates.mjs', { ...env, ...gg, STUDIO_TEST_CPU_BUSY: '0.7' });
  const g2 = run(dir, 'node harness/game-gates.mjs', { ...env, ...gg, STUDIO_TEST_CPU_BUSY: '0.7' });
  const rr = events().filter((e) => e.type === 'selftriage.rerun-timeout');
  report('2.65.0 (self-triage, rerun-timeout): a game check that timed out under load (factor 1.9: 3.8 s) runs once more at the cap (3 x 2 s = 6 s) and passes, with one selftriage.rerun-timeout event; the next timeout of the same check inside the window gets no second re-run',
    g1.status === 0 && /once more at the cap, 6 s/.test(out(g1)) && /PASS game:suite/.test(out(g1)) && rr.length === 1 && rr[0].meta?.rerunMs === 6000
      && g2.status !== 0 && /no re-run \(already fixed once/.test(out(g2)) && /timed out after 4 s/.test(out(g2)),
    `${out(g1).slice(-1200)}\n---\n${out(g2).slice(-1200)}\n${JSON.stringify(rr).slice(0, 400)}`);
  w('game/slowtoy2/studio.gates.json', JSON.stringify({ gates: [{ id: 'suite', command: 'node game/slowtoy/slow.mjs' }] }, null, 2));
  const g3 = run(dir, 'node harness/game-gates.mjs', { ...env, ...gg, STUDIO_GAME: 'slowtoy2', STUDIO_TEST_CPU_BUSY: '0' });
  report('2.65.0 (self-triage, rerun-timeout): a timeout with no load measured (factor 1) is not re-run: it fails as before',
    g3.status !== 0 && /timed out after 2 s/.test(out(g3)) && !/once more at the cap/.test(out(g3)) && events().filter((e) => e.type === 'selftriage.rerun-timeout').length === 1, out(g3).slice(-1200));

  // ---- 2d. rescues of a landed task, and the hub ----
  const tLanded = add('Port the toy menu');
  task(`start ${tLanded} --agent hatch`);
  const landedDone = task(`done ${tLanded} --agent hatch --force --reason "landed by hand in this test"`);
  // A rescue the landing's own close missed (filed after it, as a racing watchdog pass can): the sweep's job.
  const tRescue = add(`Rescue: ${tLanded} stuck (241 min claimed)`);
  const sweep = probe('sweep', `import { rescueSweep } from ${u('harness/self-triage.mjs')};
import { parseNextQueue } from ${u('harness/task.mjs')};
const a = await rescueSweep();
const q = parseNextQueue();
console.log(JSON.stringify({ a, open: [...q.backlog, ...q.inProgress].map((t) => t.id) }));`);
  const swEv = events().filter((e) => e.type === 'selftriage.close-rescues');
  const hub = probe('hub', `import { hubPass } from ${u('harness/self-triage.mjs')};
let up = true; const spawned = [];
const deps = { hubUp: async () => up, spawnHub: () => { spawned.push(1); return 4242; }, supervisorAlive: false };
const a0 = await hubPass(deps);
up = false;
const a1 = await hubPass(deps);
const a2 = await hubPass(deps);
const a3 = await hubPass({ ...deps, supervisorAlive: true });
console.log(JSON.stringify({ a0, a1, a2, a3, spawned: spawned.length }));`);
  report('2.65.0 (self-triage, close-rescues and restart-hub): the rescue of a task that landed is closed with one selftriage.close-rescues event; a hub that answered and then stopped is started again once (selftriage.restart-hub), not twice in the window',
    !sweep.open?.includes(tRescue) && sweep.a?.some((x) => x.task === tRescue) && swEv.length === 1 && swEv[0].meta?.stuck === tLanded
      && hub.a0?.length === 0 && hub.a1?.length === 1 && hub.a2?.length === 0 && hub.spawned === 1 && events().filter((e) => e.type === 'selftriage.restart-hub').length === 1,
    `${out(landedDone).slice(-600)}\n${JSON.stringify({ sweep, swEv, hub }).slice(0, 2000)}`);
  const wdSrc = fs.readFileSync(path.join(dir, 'harness', 'watchdog.mjs'), 'utf8');
  report('2.65.0 (self-triage): the watchdog\'s pass runs the self-triage list before the rescue ladder, and the daily digest', /selfTriagePass/.test(wdSrc) && wdSrc.indexOf('selfTriagePass') < wdSrc.indexOf('rescuePass') && /digestIfDue/.test(wdSrc), '');

  // ---- 3. the daily digest ----
  fs.mkdirSync(path.join(st, 'train'), { recursive: true });
  fs.writeFileSync(path.join(st, 'train', 'queue.json'), JSON.stringify([{ task: 'T-901', head: 'abc1234', agent: 'builder-s2', held: { tier: 'C', why: 'a protected file (studio/protected.json and the shipped list): studio/game.json' } }]));
  fs.writeFileSync(path.join(st, 'supervisor.json'), JSON.stringify({ status: 'running', pid: process.pid, halted: { code: 1, tool: 'claude', why: 'two sessions in a row ended with exit 1 (a-s1, a-s2): check npm run agent -- logs a-s2' } }));
  const dg = run(dir, 'npm run digest --silent', env);
  const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
  const dFile = path.join(dir, 'studio', 'digest', `${today}.md`);
  const dText = fs.existsSync(dFile) ? fs.readFileSync(dFile, 'utf8') : '';
  const dEv = events().filter((e) => e.type === 'digest.written');
  report('2.65.0 (digest): npm run digest writes studio/digest/<date>.md under 200 words: the tier-C lane waiting for release, the halt self-triage can\'t fix, the autonomy line and what self-triage fixed; one digest.written event',
    dg.status === 0 && /T-901 waits for your release \(tier C/.test(dText) && /supervisor is halted: two sessions in a row ended with exit 1/.test(dText) && /^Autonomy \(7 d\)/m.test(dText) && /Self-triage fixed \d+ routine stop/.test(dText) && /switch-tool 1/.test(dText)
      && (dText.match(/\S+/g) || []).length < 200 && dEv.length === 1 && dEv[0].meta?.needs >= 2,
    `${out(dg).slice(0, 600)}\n---\n${dText}\n${JSON.stringify(dEv).slice(0, 400)}`);
  fs.rmSync(path.join(st, 'train', 'queue.json'), { force: true });
  fs.rmSync(path.join(st, 'supervisor.json'), { force: true });
  fs.rmSync(path.join(dir, 'studio', 'digest'), { recursive: true, force: true });
  const auto = probe('digest', `import { digestIfDue, buildDigest } from ${u('harness/digest.mjs')};
const d = new Date(); d.setHours(10, 0, 0, 0);
const late = await digestIfDue({ now: d.getTime(), env: { STUDIO_DIGEST_HOUR: '11' } });
const first = await digestIfDue({ now: d.getTime(), env: { STUDIO_DIGEST_HOUR: '9' } });
const second = await digestIfDue({ now: d.getTime() + 60000, env: { STUDIO_DIGEST_HOUR: '9' } });
const off = await digestIfDue({ now: d.getTime() + 86400000, env: { STUDIO_DIGEST: 'off' } });
console.log(JSON.stringify({ late, first: first && { file: first.file, text: first.text, need: first.need.length }, second, off }));`, { STUDIO_SELF_TRIAGE: 'off', AGENT_EVENTS_FILE: path.join(dir, '.studio', 'events-265t-quiet.jsonl') });
  report('2.65.0 (digest): the watchdog\'s daily run writes once per day at or after STUDIO_DIGEST_HOUR (not before, not twice, not with STUDIO_DIGEST=off), and with nothing waiting it says so in one line',
    auto.late === null && /^studio\/digest\/\d{4}-\d{2}-\d{2}\.md$/.test(auto.first?.file || '') && auto.first?.need === 0 && /\nNothing needs you today\.\n/.test(auto.first?.text || '') && auto.second === null && auto.off === null,
    JSON.stringify(auto).slice(0, 1500));

  // ---- 4. the autonomy level ----
  const lvl = (args, e = {}) => run(dir, `node harness/autonomy.mjs level ${args}`, { ...env, ...e });
  const aj = () => JSON.parse(fs.readFileSync(path.join(dir, 'studio', 'autonomy.json'), 'utf8'));
  const before = aj();
  const byWorker = lvl('L4 --by hatch --why "faster" --permission "hatch said L4 in chat tonight"', { STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-s3' });
  const byBotNoPerm = lvl('L3 --by hatch', { STUDIO_LOCK_OWNER: 'opus-bot', CLAUDECODE: '1' });
  const unchanged = aj().level === before.level;
  const byPerson = lvl('L3 --by hatch --why "the bars held for a week"');
  const afterPerson = aj();
  const byBot = lvl('L4 --by hatch --why "hands-off" --permission "hatch in chat 21:40: go to L4"', { STUDIO_LOCK_OWNER: 'opus-bot', CLAUDECODE: '1' });
  const afterBot = aj();
  const byProd = lvl('L2 --by prod-1 --why "two reopens today"', { STUDIO_ROLE: 'producer', STUDIO_LOCK_OWNER: 'prod-1' });
  const lvEv = events().filter((e) => e.type === 'autonomy.level');
  report('2.65.0 (autonomy level): a builder (even with a permission line) and an outside agent without permission are refused and nothing changes; a person, an outside agent on permission and a Producer session set "level" (the bar kept), each with one autonomy.level event naming who and why',
    byWorker.status !== 0 && /worker|builder session/.test(out(byWorker)) && byBotNoPerm.status !== 0 && /permission/.test(out(byBotNoPerm)) && unchanged
      && byPerson.status === 0 && afterPerson.level === 'L3' && afterPerson.l3?.minLanded === before.l3?.minLanded && afterPerson.levelSet?.by === 'hatch'
      && byBot.status === 0 && afterBot.level === 'L4' && afterBot.levelSet?.recordedBy === 'opus-bot' && /go to L4/.test(afterBot.levelSet?.permission || '')
      && byProd.status === 0 && aj().level === 'L2' && aj().levelSet?.via === 'producer'
      && lvEv.length === 3 && lvEv[0].meta?.from === before.level && lvEv[0].meta?.to === 'L3' && lvEv[0].meta?.why === 'the bars held for a week' && lvEv[1].meta?.recordedBy === 'opus-bot',
    `${out(byWorker)}\n${out(byBotNoPerm)}\n${out(byPerson)}\n${out(byBot)}\n${out(byProd)}\n${JSON.stringify(lvEv.map((e) => e.meta)).slice(0, 800)}`);

  // ---- 5. the scorecard: cost per merged change, round-trips, conductor notes ----
  const card = probe('card', `import { buildAutonomy, personClassifier } from ${u('harness/autonomy.mjs')};
const isPersonName = await personClassifier();
const now = Date.parse('2026-11-08T00:00:00Z');
const at = (h) => new Date(now - h * 3600000).toISOString();
const ev = [];
ev.push({ ts: at(300), type: 'agent.session.end', agent: 'b-s0', model: 'm-big', tokensIn: 50000, tokensOut: 50000 });
ev.push({ ts: at(299), type: 'task.done', agent: 'b-s0', task: 'T-0' });
ev.push({ ts: at(100), type: 'supervisor.start', agent: 'supervisor' });
for (let i = 1; i <= 4; i++) { ev.push({ ts: at(90 - i), type: 'agent.session.end', agent: 'b-s' + i, model: 'm-big', tokensIn: 100000, tokensOut: 100000 }); ev.push({ ts: at(89 - i), type: 'task.done', agent: 'b-s' + i, task: 'T-' + i }); }
ev.push({ ts: at(50), type: 'conductor.note', agent: 'opus-bot', task: 'T-2', meta: { by: 'opus-bot' } });
ev.push({ ts: at(40), type: 'supervisor.halted', agent: 'supervisor' });
ev.push({ ts: at(39), type: 'supervisor.resumed', agent: 'supervisor', meta: { by: 'self-triage', via: 'self-triage' } });
ev.push({ ts: at(30), type: 'task.reordered', agent: 'hatch', task: 'T-3' });
const plain = buildAutonomy(ev, { now, days: 7, isPersonName });
const priced = buildAutonomy(ev, { now, days: 7, isPersonName, prices: { 'm-big': { in: 3, out: 15 } } });
console.log(JSON.stringify({ cost: plain.cost, pricedCost: priced.cost, orch: plain.orchestrator, rt: plain.roundTripsPerLanded, unplanned: plain.interventions.unplanned, who: plain.interventions.list.map((x) => x.who) }));`);
  const cli = run(dir, 'node harness/autonomy.mjs', env);
  report('2.65.0 (scorecard): cost per landed task in tokens (200k, and 100k the window before), "tokens only" with no price table and dollars with one ($1.80); 1 conductor note; person round-trips per landed task; a halt cleared by self-triage is no person\'s intervention',
    card.cost?.tokensPerLanded === 200000 && card.cost?.previousTokensPerLanded === 100000 && card.cost?.priced === false && /tokens only/.test(card.cost?.note || '')
      && card.pricedCost?.priced === true && card.pricedCost?.dollarsPerLanded === 1.8 && card.orch?.conductorNotes === 1 && card.orch?.by?.['opus-bot'] === 1
      && card.unplanned === 1 && card.rt === 0.25 && !card.who?.includes('self-triage')
      && cli.status === 0 && /Cost per landed task: .*tokens only/.test(out(cli)) && /Orchestrator interventions: \d+ conductor note/.test(out(cli)),
    `${JSON.stringify(card).slice(0, 1500)}\n${out(cli).slice(0, 1200)}`);
}
