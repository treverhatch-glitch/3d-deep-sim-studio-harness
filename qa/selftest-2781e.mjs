/**
 * qa/selftest-2781e.mjs — 2.78.1 (e): fresh sessions that stay cheap, and finished work that doesn't get lost.
 *   - The launch prompt's prefix is the same bytes for every session of a role (builder, engine-porter, reviewer, producer)
 *     at another time, under another name, model and task; a clock time an agent wrote into a pitfall is not called a
 *     cache miss; a launched session leaves studio/CURRENT_TASK.md (imported by CLAUDE.md ahead of the prompt) alone.
 *   - Refresh points per role (reviewers and engine-porters at 70k by default) with per-role and per-model overrides.
 *   - Every hand-back carries the lane, the commits made, the last verify (green/red, which gate) and the next command,
 *     written by the harness; a refresh relaunch's prompt carries them.
 *   - A builder red on a different cause past half its refresh point hands off to a fresh session (a setting turns it
 *     off; the mid-debug exception keeps going); a reviewer's launch never resumes a session.
 *   - `lanes orphans` lists task commits on lane branches that main lacks; `lanes carry <ID>` cherry-picks only the
 *     task's own commits onto a fresh lane, refuses a worker outside its own copy, and stops on a conflict.
 *   - `agent start` with a name whose lane copy is still in use suggests a fresh name; --auto-name uses it.
 *   - An engine pass whose branch is checked out in another clean worktree works there; a dirty one refuses the launch.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest2781E({ dir, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = path.join(harnessRoot, 'node_modules');
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const writeIn = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };
  const readIn = (cwd, rel) => { try { return JSON.parse(fs.readFileSync(path.join(cwd, rel), 'utf8')); } catch { return null; } };
  const textIn = (cwd, rel) => { try { return fs.readFileSync(path.join(cwd, rel), 'utf8'); } catch { return ''; } };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const base = { STUDIO_REFILL_WAKE: 'off', STUDIO_WATCHDOG: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_MAIN_ROOT: '', STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '', STUDIO_TASK_BASE: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '', CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', GITHUB_BASE_REF: '', STUDIO_TASK_PIN: '', STUDIO_REHEARSAL: '', STUDIO_AUTO_NAME: '', STUDIO_CURRENT_TASK_FILE: '', STUDIO_REFRESH_ON_NEW_RED: '', STUDIO_SESSION_CONTEXT: '', STUDIO_SESSION_CONTEXT_EARLY: '', STUDIO_SESSION_EARLY_ROLES: '', STUDIO_LANE_LIVE_MIN: '' };
  let n = 0;
  const made = [];
  const studio = (name) => {
    const S = path.join(tmpRoot, `2781e-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    const ev = path.join(S, '.studio', 'events-2781e.jsonl');
    writeIn(S, '.studio/events-2781e.jsonl', '');
    g(S, 'init', '-q', '-b', 'main'); g(S, 'config', 'core.autocrlf', 'false'); g(S, 'config', 'core.eol', 'lf');
    g(S, 'config', 'user.name', 't'); g(S, 'config', 'user.email', 't@example.invalid');
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
    made.push(S);
    return { S, env: { ...base, AGENT_EVENTS_FILE: ev } };
  };
  const node = (S, args, env) => spawnSync(process.execPath, args, { windowsHide: true, cwd: S, encoding: 'utf8', env: { ...process.env, ...ident, ...env }, timeout: 180000 });
  const task = (S, line, env) => node(S, ['harness/task.mjs', ...line], env);
  const add = (S, title, env, extra = []) => { const r = task(S, ['add', title, '--role', 'builder', ...extra], env); return (out(r).match(/"id":\s*"([A-Z]+-\d+)"/) || [])[1] || null; };
  const probe = (S, code, env) => { const f = path.join(S, `.probe-2781e-${++n}.mjs`); fs.writeFileSync(f, code); const r = node(S, [f], env); const l = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop(); let j = null; try { j = JSON.parse(l); } catch {} return { ...r, j }; };
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  const commit = (cwd, rel, text, msg) => { writeIn(cwd, rel, text); g(cwd, 'add', '--', rel); return g(cwd, 'commit', '-qm', msg, '--no-verify'); };
  // What Claude Code reads ahead of the launch prompt: CLAUDE.md with its @imports filled in.
  const claudeContext = (S) => textIn(S, 'CLAUDE.md').split(/\r?\n/).map((l) => (/^@\S+$/.test(l.trim()) ? textIn(S, l.trim().slice(1)) : l)).join('\n');

  // ---- 1. the prompt prefix is the same bytes for every session of a role ----
  {
    const { S, env } = studio('prefix');
    writeIn(S, 'studio/PITFALLS.md', '# Pitfalls seen here (`studio/PITFALLS.md`)\n\n- [builder,engine-porter] never queue a second train while the engine land of 2026-11-04T10:00 runs (seen on T-9)\n- never read CHANGELOG.md\n');
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'pitfalls', '--no-verify');
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((x) => add(S, `Prefix task ${x}`, env));
    const roles = (k) => [['builder', `builder-s${k}`, k === 1 ? 'claude-opus-5-5' : 'claude-sonnet-4-6', ids[k === 1 ? 0 : 1]], ['engine-porter', `engine-porter-${k}`, 'claude-opus-5-5', ids[k === 1 ? 2 : 3]], ['reviewer', `reviewer-r${k}`, k === 1 ? 'gemini-3-pro' : 'claude-opus-5-5', ids[k === 1 ? 4 : 5]], ['producer', `prod-${k}`, 'claude-opus-5-5', ids[k === 1 ? 6 : 7]]];
    const build = (k, off) => probe(S, `const OFF = ${off};
if (OFF) { const RD = Date; globalThis.Date = class extends RD { constructor(...a) { if (!a.length) super(RD.now() + OFF); else super(...a); } static now() { return RD.now() + OFF; } }; }
const ag = await import(${u(S, 'harness/agent.mjs')});
const k = await import(${u(S, 'harness/kickoff.mjs')});
const pf = await import(${u(S, 'harness/pitfalls.mjs')});
const pl = await import(${u(S, 'harness/prompt-layout.mjs')});
const res = {};
for (const [role, agent, model, task] of ${JSON.stringify(roles(k))}) {
  let parts;
  if (ag.sessionPromptParts) parts = ag.sessionPromptParts({ role, agent, model, task, refreshes: 1, tool: 'claude', oneTask: true, lane: 'game/x' });
  else { const kp = k.kickoffParts({ role, agent, model, launched: true, task }); parts = { stable: kp.stable + pf.pitfallsForPrompt(role), volatile: kp.volatile }; }
  const prompt = pl.layoutPrompt(parts);
  res[role] = { prefix: prompt.slice(0, prompt.indexOf(pl.STABLE_MARKER)), leaks: pl.volatileLeaks(parts.stable, { agent, model, task }), tail: prompt.slice(prompt.indexOf(pl.STABLE_MARKER)).includes(agent) };
}
console.log(JSON.stringify(res));`, env);
    const ctx1 = claudeContext(S);
    const one = build(1, 0);
    // Between the two: the verify got slower, the builder's task got an inbox line, a launched builder started and paused a task.
    writeIn(S, '.studio/gates-last-full.json', JSON.stringify({ at: new Date().toISOString(), rows: [{ id: 'game:test', ms: 540000 }] }));
    const launched = { ...env, STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-s1', STUDIO_AGENT_MODEL: 'claude-opus-5-5' };
    const st = task(S, ['start', ids[0], '--agent', 'builder-s1'], launched);
    const pa = task(S, ['pause', ids[0], '--agent', 'builder-s1', '--note', 'handing back for the prefix check'], launched);
    const ctx2 = claudeContext(S);
    const two = build(2, 3 * 3600000);
    // A hand-run session (no STUDIO_ROLE) still keeps the checkpoint, as before.
    task(S, ['start', ids[1], '--agent', 'claude-a'], env);
    const handRun = /Active Task ID\*\*: [A-Z]+-\d+/.test(textIn(S, 'studio/CURRENT_TASK.md')) && textIn(S, 'studio/CURRENT_TASK.md').includes(ids[1]);
    await guard('2.78.1 (e, cache): the launch prompt above the stable marker is byte-identical for builder, engine-porter, reviewer and producer sessions built 3 h apart under other names, models and tasks (a slower verify, a hand-off in between), names nothing of the session, and the leak check calls nothing in it a cache miss (a clock time in a pitfall line is the file\'s, not the session\'s); CLAUDE.md\'s import of studio/CURRENT_TASK.md (read ahead of the prompt) is unchanged by a launched session\'s task start and pause, while a hand-run session still writes it (fails on 2.78.0: "builder prompt prefix carries a timestamp" for the pitfall line, and every launched task start rewrote CURRENT_TASK.md with its time and task)', () => {
      const r1 = one.j || {};
      const r2 = two.j || {};
      const same = ['builder', 'engine-porter', 'reviewer', 'producer'].every((ro) => r1[ro] && r2[ro] && r1[ro].prefix === r2[ro].prefix && r1[ro].prefix.length > 500 && !r1[ro].leaks.length && !r2[ro].leaks.length && r1[ro].tail);
      return [same && /2026-11-04T10:00/.test(r1.builder?.prefix || '') && st.status === 0 && pa.status === 0 && ctx1 === ctx2 && handRun,
        JSON.stringify({ leaks1: Object.fromEntries(Object.entries(r1).map(([k2, v]) => [k2, v.leaks])), leaks2: Object.fromEntries(Object.entries(r2).map(([k2, v]) => [k2, v.leaks])), diff: ['builder', 'engine-porter', 'reviewer', 'producer'].filter((ro) => r1[ro]?.prefix !== r2[ro]?.prefix), ctxSame: ctx1 === ctx2, handRun, st: out(st).slice(-200), pa: out(pa).slice(-200), err: `${out(one).slice(-400)} ${out(two).slice(-400)}` }).slice(0, 2500)];
    });
  }

  // ---- 2. per-role refresh points ----
  {
    const { S, env } = studio('points');
    const r = probe(S, `const sc = await import(${u(S, 'harness/session-cap.mjs')});
const ag = await import(${u(S, 'harness/agent.mjs')});
const E = { STUDIO_SESSION_CONTEXT: '120000' };
const pt = (role, model, extra = {}) => sc.sessionLimits({ ...E, ...extra }, { role, model }).context;
const rule = ag.refreshRule({ task: 'T-1', role: 'reviewer', model: 'claude-opus-5-5' });
const ruleB = ag.refreshRule({ task: 'T-1', role: 'builder', model: 'claude-opus-5-5' });
const log = JSON.stringify({ type: 'assistant', message: { id: 'm1', usage: { input_tokens: 1000, cache_read_input_tokens: 74000, cache_creation_input_tokens: 0 } } });
const hbR = sc.heartbeatCheck('reviewer-p1', { log, model: 'claude-opus-5-5', task: 'T-1', role: 'reviewer' });
const hbB = sc.heartbeatCheck('builder-p1', { log, model: 'claude-opus-5-5', task: 'T-1', role: 'builder' });
console.log(JSON.stringify({ builder: pt('builder', 'claude-opus-5-5'), reviewer: pt('reviewer', 'claude-opus-5-5'), porter: pt('engine-porter', 'claude-opus-5-5'), producer: pt('producer'),
  reviewerOwn: pt('reviewer', null, { STUDIO_SESSION_CONTEXT_REVIEWER: '60000' }), early: pt('engine-porter', null, { STUDIO_SESSION_CONTEXT_EARLY: '80000' }), earlyOff: pt('reviewer', null, { STUDIO_SESSION_EARLY_ROLES: 'none' }),
  sonnet: pt('builder', 'claude-sonnet-4-6', { STUDIO_SESSION_CONTEXT_FACTOR_SONNET: '0.8' }), opusF: pt('builder', 'claude-opus-5-5', { STUDIO_SESSION_CONTEXT_FACTOR_SONNET: '0.8' }),
  rule70: /or 70k tokens of context/.test(rule), rule120: /or 120k tokens of context/.test(ruleB), hbR: hbR.state, hbB: hbB.state }));`, env);
    await guard('2.78.1 (e, refresh points): builders keep 120k; reviewers and engine-porters refresh at 70k by default (STUDIO_SESSION_CONTEXT_EARLY, STUDIO_SESSION_EARLY_ROLES), STUDIO_SESSION_CONTEXT_REVIEWER=60000 sets one role, STUDIO_SESSION_CONTEXT_FACTOR_SONNET=0.8 moves a Sonnet session to 96k and leaves Opus at 120k; the prompt\'s refresh rule and the launcher\'s heartbeat use the role\'s point (a reviewer at 75k is due, a builder is not) (fails on 2.78.0: one 120k point for every role and model)', () => {
      const j = r.j || {};
      return [j.builder === 120000 && j.reviewer === 70000 && j.porter === 70000 && j.producer === 120000 && j.reviewerOwn === 60000 && j.early === 80000 && j.earlyOff === 120000 && j.sonnet === 96000 && j.opusF === 120000 && j.rule70 && j.rule120 && j.hbR === 'due' && j.hbB === 'ok', JSON.stringify({ j, err: out(r).slice(-600) })];
    });
  }

  // ---- 3. hand-off facts: lane, commits, last verify, next command ----
  {
    const { S, env } = studio('facts');
    const id = add(S, 'Panel restock button', env, ['--paths', 'game/toy/src/panel']);
    const who = { ...env, STUDIO_LOCK_OWNER: 'builder-f1' };
    const st = task(S, ['start', id, '--agent', 'builder-f1'], who);
    commit(S, 'game/toy/src/panel/a.mjs', 'export const a = 1;\n', `${id}: restock button`);
    commit(S, 'game/toy/src/panel/b.mjs', 'export const b = 2;\n', `${id}: restock count`);
    commit(S, 'game/toy/src/other.mjs', 'export const o = 3;\n', 'T-999999: someone else');
    writeIn(S, '.studio/gates/out/game_test.log', 'FAIL src/panel/restock.test.ts > restock adds stock\n  expected 3 to be 4\n[gates] FAIL game:test\n');
    writeIn(S, '.studio/gates/builder-f1.json', JSON.stringify({ at: new Date(Date.now() + 1000).toISOString(), rows: [{ id: 'lint', ok: true }, { id: 'game:test', ok: false }] }));
    const pa = task(S, ['pause', id, '--agent', 'builder-f1', '--note', 'out of turns'], who);
    const h = textIn(S, `studio/handoffs/${id}.md`);
    const k = probe(S, `const ag = await import(${u(S, 'harness/agent.mjs')}); console.log(JSON.stringify({ k: ag.refreshKickoff ? ag.refreshKickoff(${JSON.stringify(id)}) : '' }));`, env);
    await guard('2.78.1 (e, hand-off): a hand-back carries, from harness state, the lane (game/toy/src/panel), the commits the task made (sha + subject, the task\'s own only), the last verify (red, game:test) and the exact next command (fix game:test, npm run verify -- --only game:test, then npm run verify); a refresh relaunch\'s prompt carries that block (fails on 2.78.0: no lane, commits, verdict or next command, and the relaunch only said "read the hand-off")', () => [
      st.status === 0 && pa.status === 0 && /- Lane: game\/toy\/src\/panel/.test(h) && new RegExp(`- Commits since [0-9a-f]{8} \\(2\\): [0-9a-f]{7,} ${id}: restock button; [0-9a-f]{7,} ${id}: restock count`).test(h) && !/T-999999/.test(h)
        && /- Last verify: red \(game:test\)/.test(h) && /- Next command: fix game:test .*npm run verify -- --only game:test, then npm run verify/.test(h)
        && /Next command: fix game:test/.test(k.j?.k || '') && /fresh session after a refresh/.test(k.j?.k || ''),
      JSON.stringify({ h: h.slice(-1400), k: (k.j?.k || out(k)).slice(-600), st: out(st).slice(-200) })]);
  }

  // ---- 4. a red on a different cause: a fresh session; reviewers never resume ----
  {
    const { S, env } = studio('newred');
    const r = probe(S, `import fs from 'node:fs';
import path from 'node:path';
const ev = await import(${u(S, 'harness/event.mjs')});
const sc = await import(${u(S, 'harness/session-cap.mjs')});
const ag = await import(${u(S, 'harness/agent.mjs')});
const as = await import(${u(S, 'harness/agy-stream.mjs')});
const gd = path.join(ev.STUDIO_STATE_DIR, 'gates');
fs.mkdirSync(path.join(gd, 'out'), { recursive: true });
const since = Date.now() - 5000;
let t = Date.now();
const red = (agent, gate, line) => { t += 2000; fs.writeFileSync(path.join(gd, 'out', gate.replace(/[^\\w.-]/g, '_') + '.log'), line + '\\n[gates] FAIL ' + gate + '\\n'); fs.writeFileSync(path.join(gd, agent + '.json'), JSON.stringify({ at: new Date(t).toISOString(), rows: [{ id: gate, ok: false }] })); };
const check = (agent, extra = {}) => sc.newRedCheck ? sc.newRedCheck(agent, { since, context: 70000, role: 'builder', model: 'claude-opus-5-5', ...extra }) : null;
red('builder-n1', 'game:test', 'FAIL src/a.test.ts > restock adds stock');
const first = check('builder-n1');
red('builder-n1', 'golden', 'FAIL golden: hash mismatch at tick 120');
const second = check('builder-n1');
const flag = sc.readFlag('builder-n1');
red('builder-n2', 'game:test', 'FAIL src/a.test.ts > restock adds stock'); check('builder-n2');
red('builder-n2', 'game:test', 'FAIL src/a.test.ts > restock adds stock');
const same = check('builder-n2');
red('builder-n3', 'game:test', 'FAIL a'); check('builder-n3'); red('builder-n3', 'golden', 'FAIL b');
const off = check('builder-n3', { env: { ...process.env, STUDIO_REFRESH_ON_NEW_RED: 'off' } });
red('builder-n4', 'game:test', 'FAIL a'); check('builder-n4', { context: 30000 }); red('builder-n4', 'golden', 'FAIL b');
const early = check('builder-n4', { context: 30000 });
red('builder-n5', 'game:test', 'FAIL a'); check('builder-n5'); sc.flagException('builder-n5', 'live repro: seed 7 tick 120'); red('builder-n5', 'golden', 'FAIL b');
const debug = check('builder-n5');
red('reviewer-n6', 'game:test', 'FAIL a'); red('reviewer-n6', 'golden', 'FAIL b');
const rev = check('reviewer-n6', { role: 'reviewer' });
// claude: -c/-r are continue/resume; codex: the resume subcommand (its -c is a config flag); agy: --resume/--continue.
const RESUME = { claude: /^(--resume|--continue|-r|-c|--session-id|--fork-session)$/, codex: /^(resume|--last)$/, agy: /^(--resume|--continue|--session-id)$/ };
const argvs = ['claude', 'codex', 'agy'].map((tool) => ({ tool, argv: ag.toolCommand(tool, { model: 'm', file: 'f', prompt: 'p', stream: true })?.argv || [] }));
console.log(JSON.stringify({ first, second, endedBy: flag?.endedBy || null, same, off, early, debug, rev, noResume: argvs.every(({ tool, argv }) => argv.length && !argv.some((x) => RESUME[tool].test(x))), reviewerOneTurn: !as.agyStreamWanted({ role: 'reviewer', env: { STUDIO_AGY_STREAM: '1' } }) }));`, env);
    await guard('2.78.1 (e, fresh agent): a builder\'s verify red on a different cause (game:test, then golden) past half its refresh point hands off (the refresh flag\'s endedBy names both reds, so the launcher relaunches it fresh from the hand-back); the same cause again, STUDIO_REFRESH_ON_NEW_RED=off, under half the point, a session flagged mid-debug (session exception) and a reviewer keep going; a reviewer\'s launch never resumes a session (no --resume/--continue for claude, codex or agy; agy stream mode stays one-turn for reviewers) (fails on 2.78.0: no new-red check: a session went on with the first red\'s context)', () => {
      const j = r.j || {};
      return [j.first?.handoff === false && j.second?.handoff === true && /different cause \(golden.*previous red \(game:test\)/.test(j.endedBy || '') && j.same?.handoff === false && j.off?.handoff === false && j.early?.handoff === false && j.debug?.handoff === false && j.rev === null && j.noResume && j.reviewerOneTurn,
        JSON.stringify({ j, err: out(r).slice(-600) })];
    });
  }

  // ---- 5. orphaned finished work: list it, carry a task's own commits ----
  {
    const { S, env } = studio('orphans');
    const t1 = add(S, 'Parking meter (orphaned)', env);
    const t2 = add(S, 'Other work on the same lane', env);
    const t3 = add(S, 'Work that conflicts with main', env);
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'board', '--no-verify');
    commit(S, 'game/toy/shared.txt', 'base\n', 'shared file');
    g(S, 'checkout', '-q', '-b', 'lane/builder-a-20261101-1200');
    commit(S, 'game/toy/meter/a.mjs', 'export const a = 1;\n', `${t1}: meter model`);
    commit(S, 'game/toy/other/o.mjs', 'export const o = 1;\n', `${t2}: other task on this lane`);
    commit(S, 'game/toy/meter/b.mjs', 'export const b = 2;\n', `${t1}: meter panel`);
    g(S, 'checkout', '-q', 'main');
    g(S, 'checkout', '-q', '-b', 'lane/builder-b-20261102-0900');
    commit(S, 'game/toy/shared.txt', 'from the lane\n', `${t3}: change the shared file`);
    g(S, 'checkout', '-q', 'main');
    commit(S, 'game/toy/shared.txt', 'from main\n', 'main moved the shared file');
    const lanes = (args, e = env) => node(S, ['harness/lanes.mjs', ...args], e);
    const o = lanes(['orphans', '--json']);
    let oj = null; try { oj = JSON.parse(String(o.stdout || '').trim().split('\n').pop()); } catch {}
    const worker = lanes(['carry', t1, '--by', 'builder-z'], { ...env, STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-z' });
    const c1 = lanes(['carry', t1, '--by', 'pat']);
    const remembered = (readIn(S, '.studio/lane-branches.json') || {})[t1] || '';
    const carriedLog = remembered ? g(S, 'log', '--format=%s', `main..${remembered}`).stdout.trim().split('\n') : [];
    const c3 = lanes(['carry', t3, '--by', 'pat']);
    const after3 = readIn(S, '.studio/lane-branches.json') || {};
    const leftBranches = g(S, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/lane/').stdout.trim().split('\n').filter((b) => b.startsWith('lane/carry-'));
    await guard('2.78.1 (e, orphans): `lanes orphans` lists the task commits on lane branches that main lacks (task, lane branch, sha, subject, age); `lanes carry <ID> --by <person>` makes a fresh lane off main with only the commits naming the task (the other task\'s commit left out and listed), remembers it as the task\'s branch for its next copy and removes the copy folder; a worker outside its own copy is refused; a conflict stops it, names the commit and file, and carries nothing (fails on 2.78.0: no orphans or carry command)', () => {
      const rows = oj?.rows || [];
      const ok = o.status === 0 && rows.filter((x) => x.task === t1).length === 2 && rows.some((x) => x.task === t2) && rows.some((x) => x.task === t3 && x.branch === 'lane/builder-b-20261102-0900') && rows.every((x) => /^[0-9a-f]{40}$/.test(x.sha) && x.subject && Number.isFinite(x.ageH))
        && worker.status === 2 && /Refused/.test(out(worker))
        && c1.status === 0 && /carried 2 commit\(s\)/.test(out(c1)) && /left out 1 commit/.test(out(c1)) && /^lane\/carry-/.test(remembered) && carriedLog.length === 2 && carriedLog.every((s) => s.startsWith(`${t1}:`)) && !fs.existsSync(path.join(S, '.lanes', `carry-${t1.toLowerCase()}`))
        && c3.status === 1 && /conflict in game\/toy\/shared\.txt/.test(out(c3)) && !after3[t3] && !fs.existsSync(path.join(S, '.lanes', `carry-${t3.toLowerCase()}`)) && leftBranches.length === 1;
      return [ok, JSON.stringify({ o: out(o).slice(-600), worker: out(worker).slice(-300), c1: out(c1).slice(-500), remembered, carriedLog, c3: out(c3).slice(-400), leftBranches }).slice(0, 2500)];
    });
  }

  // ---- 6. agent stop + start with the same name ----
  {
    const { S, env } = studio('names');
    fs.mkdirSync(path.join(S, '.lanes', 'builder-agyf9'), { recursive: true });
    writeIn(S, '.lanes/builder-agyf9/left.txt', 'the stopped session\'s copy\n');
    const E = { ...env, STUDIO_BUILDER_CMD: `"${process.execPath}" -e "process.exit(0)"`, STUDIO_LANELESS: '' };
    const plain = node(S, ['harness/agent.mjs', 'start', '--role', 'builder', '--agent', 'builder-agyf9', '--tool', 'claude', '--model', 'm'], E);
    const auto = node(S, ['harness/agent.mjs', 'start', '--role', 'builder', '--agent', 'builder-agyf9', '--tool', 'claude', '--model', 'm', '--auto-name'], E);
    const evs = textIn(S, '.studio/events-2781e.jsonl');
    await guard('2.78.1 (e, names): `agent start --agent builder-agyf9` while .lanes/builder-agyf9 is still in use is refused up front with a fresh name to use (builder-agyf10, from PU-63\'s nextAgentName); with --auto-name the session starts under that name (agent.renamed logged) (fails on 2.78.0: no suggestion, and --auto-name was ignored)', () => [
      plain.status !== 0 && /still in use/.test(out(plain)) && /--agent builder-agyf10/.test(out(plain)) && auto.status === 0 && /"type":"agent\.renamed"/.test(evs) && /builder-agyf9 → builder-agyf1\d/.test(evs) && /builder-agyf1\d started/.test(evs),
      JSON.stringify({ plain: out(plain).slice(-400), auto: out(auto).slice(-400), ev: evs.split('\n').filter((l) => /renamed|session.start|start_refused/.test(l)).join('\n').slice(-800) })]);
  }

  // ---- 7. B-119: the engine branch checked out in another worktree ----
  {
    const { S, env } = studio('engine');
    const R = path.join(tmpRoot, `2781e-enginerepo-${process.pid}`);
    const W = path.join(tmpRoot, `2781e-enginewt-${process.pid}`);
    made.push(R, W);
    fs.mkdirSync(R, { recursive: true });
    g(R, 'init', '-q', '-b', 'main'); g(R, 'config', 'user.name', 't'); g(R, 'config', 'user.email', 't@example.invalid');
    commit(R, 'Assets/Start.cs', 'class Start {}\n', 'engine repo');
    g(R, 'branch', 'unity/pass-1');
    g(R, 'worktree', 'add', W, 'unity/pass-1');
    writeIn(S, 'studio/game.json', `${JSON.stringify({ ...(readIn(S, 'studio/game.json') || {}), engines: { unity: { folder: R, target: 'main' } } }, null, 2)}\n`);
    const a = task(S, ['add', 'Unity pass 1', '--role', 'engine-porter', '--track', 'engine:unity', '--branch', 'unity/pass-1'], env);
    const id = (out(a).match(/"id":\s*"([A-Z]+-\d+)"/) || [])[1];
    const launch = () => probe(S, `const et = await import(${u(S, 'harness/engine-tracks.mjs')}); console.log(JSON.stringify(et.engineLaunch({ task: ${JSON.stringify(id)}, agent: 'porter-e1' })));`, env).j || {};
    const clean = launch();
    writeIn(W, 'Assets/Half.cs', 'class Half {}\n');
    const dirty = launch();
    const run = probe(S, `const ag = await import(${u(S, 'harness/agent.mjs')}); const r = await ag.runAgent({ role: 'engine-porter', agent: 'porter-e2', tool: 'custom', model: 'm', task: ${JSON.stringify(id)} }); console.log(JSON.stringify({ ok: r.ok, skipped: r.skipped || false, message: r.message || '' }));`, { ...env, STUDIO_AGENT_CMD: `"${process.execPath}" -e "process.exit(0)"` });
    const same = (p, q) => { try { return fs.realpathSync(p) === fs.realpathSync(q); } catch { return false; } };
    await guard('2.78.1 (e, B-119): an engine pass whose branch is checked out in another clean worktree works in that worktree (named in its note); with uncommitted work there, engineLaunch says where and what to do, and the launch is refused ("no code access") instead of running a session that can\'t reach the code (fails on 2.78.0: git worktree add failed and the session started anyway)', () => [
      id && same(clean.dir || '', W) && clean.reused === true && /already checked out there and clean/.test(clean.note || '') && /checked out in .*uncommitted work \(Assets\/Half\.cs\)/.test(dirty.error || '') && /commit or stash/.test(dirty.error || '') && run.j?.ok === false && /no code access/.test(run.j?.message || ''),
      JSON.stringify({ id, clean, dirty, run: run.j || out(run).slice(-600) }).slice(0, 2000)]);
  }

  for (const S of made) { try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch {} }
}
