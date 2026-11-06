/**
 * qa/selftest-2782e.mjs — 2.78.2 (e): approvals and engine records (item 7), region lanes (item 9).
 *   7a  `approve -- protected` on the main checkout of a studio that doesn't push signed the change set since
 *       origin/main (which also held main's own protected commits), so the train (base: local main) never matched it.
 *   7b  keyFor missed when origin/main has pull-request merge commits local main doesn't (A-030).
 *   7c  an approval made in a lane copy wrote its event to that copy's own log (a copy without the .studio link), so the
 *       Line Producer kept holding the task.
 *   7d  an engine-porter task with no engine record got a plain lane.
 *   7e  (the 2.79 audit, D1.1; an assertion since 2.78.2 (h)): the protected check accepted a beta-format approval nobody
 *       committed.
 *   9   lane overlap was file-level: two lanes on regions of one big shared file never ran side by side.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest2782E({ dir, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = path.join(harnessRoot, 'node_modules');
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const writeIn = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const base = { STUDIO_REFILL_WAKE: 'off', STUDIO_WATCHDOG: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_MAIN_ROOT: '', STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '', STUDIO_TASK_BASE: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '', CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', GITHUB_BASE_REF: '', GITHUB_EVENT_NAME: '', STUDIO_HARNESS_REF: '', STUDIO_KEY_BASE: '', STUDIO_LANE_EVENTS: '', STUDIO_ENGINE_TRACK_INFER: '', STUDIO_ENGINE_LANES: '', STUDIO_REGION_FILES: '', STUDIO_SHARED_SIM: '', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-2782e-${process.pid}.pem`) };
  let n = 0;
  const studio = (name) => {
    const S = path.join(tmpRoot, `2782e-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    for (const rel of ['.studio', 'studio/approvals', 'studio/keys', 'studio/beta.json', '.env']) fs.rmSync(path.join(S, rel), { recursive: true, force: true });
    const ev = path.join(S, '.studio', 'events-2782e.jsonl');
    writeIn(S, '.studio/events-2782e.jsonl', '');
    g(S, 'init', '-q', '-b', 'main'); g(S, 'config', 'core.autocrlf', 'false'); g(S, 'config', 'core.eol', 'lf');
    g(S, 'config', 'user.name', 't'); g(S, 'config', 'user.email', 't@example.invalid');
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
    return { S, env: { ...base, AGENT_EVENTS_FILE: ev }, ev };
  };
  const node = (cwd, args, env) => spawnSync(process.execPath, args, { windowsHide: true, cwd, encoding: 'utf8', env: { ...process.env, ...ident, ...env }, timeout: 180000 });
  const probe = (cwd, code, env) => { const f = path.join(cwd, `.probe-2782e-${++n}.mjs`); fs.writeFileSync(f, code); const r = node(cwd, [f], env); fs.rmSync(f, { force: true }); const l = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop(); let j = null; try { j = JSON.parse(l); } catch {} return { ...r, j }; };
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  const events = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const keyPair = (name) => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const priv = path.join(tmpRoot, `2782e-${name}-${process.pid}-${++n}.pem`);
    fs.writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    return { pub: publicKey.export({ type: 'spki', format: 'pem' }), priv };
  };
  const PROT = 'qa/controls-check.mjs';
  const touch = (S, text) => fs.appendFileSync(path.join(S, PROT), `\n// ${text}\n`);

  // ---- 7a: approve -- protected on the main checkout, judged by the train's base ----
  {
    const { S, env } = studio('7a');
    g(S, 'update-ref', 'refs/remotes/origin/main', 'HEAD'); // pushes are off: origin/main stays here, with no key
    const owner = keyPair('owner'); const other = keyPair('other');
    writeIn(S, 'studio/keys/owner-ed25519.pub.pem', owner.pub);
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'owner key (a protected commit on main itself)', '--no-verify');
    touch(S, 'the owner re-pins a protected check');
    const jb = probe(S, `const a = await import(${u(S, 'harness/approve.mjs')}); const j = a.judgeBase(process.env, { exact: true }); const o = a.judgeBase({ ...process.env, STUDIO_KEY_BASE: 'off' }, { exact: true }); console.log(JSON.stringify({ ref: j?.ref, moved: j?.movedFrom || null, from: j?.key?.from, offRef: o?.ref, offFrom: o?.key?.from }));`, env);
    // The owner's switch: by default the main checkout's protected, weakened-tests and force checks stay "not enforced"
    // there (2.78.1's status); STUDIO_MAIN_CHECKOUT_ENFORCE=on enforces them with main's key.
    const ON = { STUDIO_MAIN_CHECKOUT_ENFORCE: 'on' };
    const showDefault = node(S, ['harness/approve.mjs', 'show'], env);
    const showOn = node(S, ['harness/approve.mjs', 'show'], { ...env, ...ON });
    const enf = (x) => probe(S, `const a = await import(${u(S, 'harness/approve.mjs')}); const w = await import(${u(S, 'harness/test-weakening.mjs')}); const r = await w.checkWeakening(); console.log(JSON.stringify({ tests: r.enforced, force: a.forceApproved('T-1') }));`, { ...env, STUDIO_WEAKENED_TESTS: '', ...x });
    const enfDefault = enf({}); const enfOn = enf(ON);
    const forged = node(S, ['harness/approve.mjs', 'protected', '--note', 'not the owner: another key signs this', '--by', 'pat'], { ...env, STUDIO_OWNER_KEY: other.priv });
    for (const f of fs.readdirSync(path.join(S, 'studio', 'approvals'))) fs.rmSync(path.join(S, 'studio', 'approvals', f));
    const appr = node(S, ['harness/approve.mjs', 'protected', '--note', 'the owner re-pins the controls check', '--by', 'pat'], { ...env, STUDIO_OWNER_KEY: owner.priv });
    const showOnAfter = node(S, ['harness/approve.mjs', 'show'], { ...env, ...ON });
    g(S, 'checkout', '-q', '-b', 'lane/x');
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'the re-pin and its approval', '--no-verify');
    const train = node(S, ['harness/approve.mjs', 'show'], { ...env, STUDIO_PROTECT_BASE: 'main' });
    await guard('2.78.2 (e, 7a B-120 again): on the main checkout of a studio that doesn\'t push (origin/main has no owner key, main committed one), `approve -- protected` signs the change set since the key-carrying base (local main: only the re-pinned file), so the train\'s check (base: local main) accepts it; an approval signed with another key says it won\'t verify; STUDIO_KEY_BASE=off keeps origin/main and no key. The main checkout\'s own enforcement stays as on 2.78.1 by default (protected files, weakened tests and task done --force "not enforced"), and STUDIO_MAIN_CHECKOUT_ENFORCE=on (the owner\'s switch) enforces all three there: NEEDS APPROVAL before the owner signs, approved after (fails on 2.78.1: the approval covered the change since origin/main, which also held main\'s own key commit, so its change id never matched and the train said NEEDS APPROVAL; and the switch didn\'t exist)', () => [
      jb.j?.ref === 'main' && jb.j?.moved === 'origin/main' && jb.j?.from === 'main' && jb.j?.offRef === 'origin/main' && jb.j?.offFrom === 'none'
        && showDefault.status === 0 && /aren't enforced/.test(out(showDefault))
        && showOn.status === 3 && /NEEDS APPROVAL: 1 protected file/.test(out(showOn)) && /qa\/controls-check\.mjs/.test(out(showOn)) && !/studio\/keys/.test(out(showOn))
        && enfDefault.j?.tests === false && enfDefault.j?.force === null && enfOn.j?.tests === true && enfOn.j?.force?.ok === false
        && showOnAfter.status === 0 && /OK: approved by pat/.test(out(showOnAfter))
        && forged.status === 0 && /does not verify with the owner key the checks read/.test(out(forged))
        && appr.status === 0 && !/studio\/keys/.test(out(appr)) && train.status === 0 && /OK: approved by pat/.test(out(train)),
      JSON.stringify({ jb: jb.j || out(jb).slice(-300), showDefault: out(showDefault).slice(-300), showOn: out(showOn).slice(-300), enfDefault: enfDefault.j || out(enfDefault).slice(-300), enfOn: enfOn.j || out(enfOn).slice(-300), showOnAfter: out(showOnAfter).slice(-300), forged: out(forged).slice(-300), appr: out(appr).slice(-400), train: out(train).slice(-400) })]);
  }

  // ---- 7b: keyFor when origin/main has a pull request's merge commit that main doesn't (A-030) ----
  {
    const { S, env } = studio('7b');
    const c0 = g(S, 'rev-parse', 'HEAD').stdout.trim();
    g(S, 'checkout', '-q', '-b', 'side');
    writeIn(S, 'docs/pr-side.md', '# merged on GitHub\n'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'pr: side', '--no-verify');
    g(S, 'checkout', '-q', '-b', 'gh', c0);
    g(S, 'merge', '-q', '--no-ff', '--no-verify', '-m', 'Merge pull request #1 from side', 'side');
    g(S, 'update-ref', 'refs/remotes/origin/main', 'gh');
    g(S, 'checkout', '-q', 'main'); g(S, 'branch', '-q', '-D', 'gh', 'side');
    const owner = keyPair('owner'); const other = keyPair('other');
    writeIn(S, 'studio/keys/owner-ed25519.pub.pem', owner.pub);
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'owner key', '--no-verify');
    writeIn(S, 'docs/a030-note.md', '# a commit made without the hooks\n'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'board: snapshot', '--no-verify');
    const e = { ...env, STUDIO_HOOKS_CHECK: 'on' };
    const check = (x = {}) => node(S, ['harness/hook-stamp.mjs', 'check'], { ...e, ...x });
    const before = check();
    const appr = node(S, ['harness/approve.mjs', 'hooks', '--note', 'the owner accepts the two unhooked commits on main', '--by', 'pat'], { ...e, STUDIO_OWNER_KEY: owner.priv });
    const after = check();
    const strict = check({ STUDIO_KEY_BASE: 'ancestor' });
    // Safety: an origin/main that carries ANOTHER owner key: main's key isn't used.
    g(S, 'checkout', '-q', '-b', 'gh2', 'refs/remotes/origin/main');
    writeIn(S, 'studio/keys/owner-ed25519.pub.pem', other.pub); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'another key on GitHub', '--no-verify');
    g(S, 'update-ref', 'refs/remotes/origin/main', 'gh2'); g(S, 'checkout', '-q', 'main'); g(S, 'branch', '-q', '-D', 'gh2');
    const otherKey = check();
    await guard('2.78.2 (e, 7b A-030): origin/main holds a pull request\'s merge commit local main lacks and has no owner key; on the main checkout the owner\'s `approve -- hooks` verifies with local main\'s key (the base shares main\'s history and its side never touched the key) and the check passes; STUDIO_KEY_BASE=ancestor keeps 2.78.1\'s rule; an origin/main carrying a different key gets no key (fails on 2.78.1: origin/main wasn\'t an ancestor of main, so no key and the check stayed red after the owner approved)', () => [
      before.status === 1 && /2 commit\(s\) since origin\/main skipped the git hooks/.test(out(before))
        && appr.status === 0 && after.status === 0 && /approved by the owner; the owner's approvals verified with main [0-9a-f]{8}'s key/.test(out(after))
        && strict.status === 1 && otherKey.status === 1,
      JSON.stringify({ before: out(before).slice(-300), appr: out(appr).slice(-300), after: out(after).slice(-400), strict: out(strict).slice(-200), otherKey: out(otherKey).slice(-300) })]);
  }

  // ---- 7c: an approval made in a lane copy (made by hand, no .studio link) reaches the main checkout's log ----
  {
    const { S, env } = studio('7c');
    const owner = keyPair('owner');
    writeIn(S, 'studio/keys/owner-ed25519.pub.pem', owner.pub);
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'owner key', '--no-verify');
    const e = { ...env, AGENT_EVENTS_FILE: '' };
    writeIn(S, '.studio/lane-branches.json', `${JSON.stringify({ 'T-777': 'lane/t777' }, null, 2)}\n`);
    const paused = probe(S, `const ev = await import(${u(S, 'harness/event.mjs')}); ev.emitEvent({ type: 'task.paused', agent: 'builder-1', task: 'T-777', msg: 'Handed back T-777: the controls check is a protected file; only the owner approves it', meta: { ownerStep: 'protected-file' } }); // 2.79 (d): routed on the structured field console.log(JSON.stringify({ ok: true }));`, e);
    const L = path.join(S, '.lanes', 'approver');
    const add = g(S, 'worktree', 'add', '-q', '-b', 'lane/t777', L);
    touch(L, 'the lane re-pins the controls check');
    const appr = node(L, ['harness/approve.mjs', 'protected', '--note', 'the owner re-pins the controls check', '--by', 'pat'], { ...e, STUDIO_OWNER_KEY: owner.priv });
    const mainEv = events(path.join(S, '.studio', 'events.jsonl'));
    const laneEv = events(path.join(L, '.studio', 'events.jsonl'));
    const ap = mainEv.find((x) => x.type === 'approval.protected');
    const routes = probe(S, `const ev = await import(${u(S, 'harness/event.mjs')}); const lp = await import(${u(S, 'harness/line-producer.mjs')}); const r = await lp.protectedRoutes({ tasks: [{ id: 'T-777', state: 'ready' }], events: ev.readRecentEvents(1000), act: false }); console.log(JSON.stringify({ n: r.length }));`, e);
    const own = probe(L, `const ev = await import(${u(L, 'harness/event.mjs')}); console.log(JSON.stringify({ p: ev.getEventPaths().primary }));`, { ...e, STUDIO_LANE_EVENTS: 'own' });
    const real = (p) => { try { const r = fs.realpathSync.native(p); return process.platform === 'win32' ? r.toLowerCase() : r; } catch { return String(p); } };
    const ownIsLane = Boolean(own.j?.p) && path.basename(own.j.p) === 'events.jsonl' && real(path.dirname(path.dirname(own.j.p))) === real(L);
    g(S, 'worktree', 'remove', '--force', L);
    await guard('2.78.2 (e, 7c): `approve -- protected` in a lane copy made by hand (git worktree add .lanes/<x>, no .studio link) writes approval.protected to the main checkout\'s log, naming the copy\'s task (its branch in .studio/lane-branches.json) though the note doesn\'t, and the Line Producer no longer holds the task for its protected step; STUDIO_LANE_EVENTS=own keeps the copy\'s own log (fails on 2.78.1: the event went to .lanes/<x>/.studio/events.jsonl, nobody read it, and the task stayed held)', () => [
      paused.status === 0 && add.status === 0 && appr.status === 0 && ap?.task === 'T-777' && !laneEv.length && routes.j?.n === 0
        && ownIsLane,
      JSON.stringify({ add: out(add).slice(-200), appr: out(appr).slice(-300), ap: ap || null, laneEv: laneEv.map((x) => x.type), routes: routes.j || out(routes).slice(-300), own: own.j })]);
  }

  // ---- 7d: an engine-porter task with no engine record ----
  {
    const { S, env } = studio('7d');
    const U = path.join(tmpRoot, `2782e-unity-${process.pid}-${++n}`);
    fs.mkdirSync(U, { recursive: true });
    g(U, 'init', '-q', '-b', 'main'); writeIn(U, 'Assets/readme.txt', 'unity project\n'); g(U, 'add', '-A'); g(U, 'commit', '-qm', 'unity', '--no-verify');
    const game = (engines) => writeIn(S, 'studio/game.json', `${JSON.stringify({ engines }, null, 2)}\n`);
    game({ unity: { folder: U, target: 'main' } });
    const launch = (id) => probe(S, `const et = await import(${u(S, 'harness/engine-tracks.mjs')}); const r = et.engineLaunch({ task: ${JSON.stringify(id)}, agent: 'engine-porter-1', role: 'engine-porter', root: process.cwd() }); console.log(JSON.stringify({ r: r ? { dir: r.dir || null, branch: r.branch || null, error: r.error || null } : null, rec: et.engineTask(${JSON.stringify(id)}, { root: process.cwd(), events: [] }) }));`, env);
    const one = launch('T-218');
    const plain = probe(S, `const et = await import(${u(S, 'harness/engine-tracks.mjs')}); console.log(JSON.stringify({ r: et.engineLaunch({ task: 'T-300', agent: 'builder-1', role: 'builder', root: process.cwd() }) }));`, env);
    game({ unity: { folder: U, target: 'main' }, godot: {} });
    const two = launch('T-219');
    const worker = node(S, ['harness/task.mjs', 'track', 'T-219', 'engine:godot', '--by', 'builder-3'], { ...env, STUDIO_LOCK_OWNER: 'builder-3' });
    await guard('2.78.2 (e, 7d): an engine-porter task with no engine record, in a studio naming one engine (studio/game.json engines.unity with its own repo), gets that track recorded (inferred, an engine.track_inferred event) and its engine worktree on unity/<task>; with two engines the launch is refused with `npm run task -- track <ID> engine:<name>`; a builder task is untouched (fails on 2.78.1: no record, engineLaunch returned null and the porter got a plain lane copy)', () => [
      one.j?.r?.branch === 'unity/t-218' && fs.existsSync(path.join(String(one.j?.r?.dir || ''), 'Assets', 'readme.txt')) && one.j?.rec?.track === 'engine:unity' && Boolean(one.j?.rec?.inferred)
        && plain.j && plain.j.r === null
        && /npm run task -- track T-219 engine:<godot\|unity>/.test(String(two.j?.r?.error || '')) && !two.j?.rec,
      JSON.stringify({ one: one.j || out(one).slice(-300), plain: plain.j || out(plain).slice(-200), two: two.j || out(two).slice(-300), worker: out(worker).slice(-200) })]);
    // The command: a person sets it, a worker can't.
    const id = (node(S, ['harness/task.mjs', 'add', 'Port the gates scene', '--role', 'engine-porter'], env).stdout.match(/"id":\s*"([A-Z]+-\d+)"/) || [])[1];
    const byWorker = id ? node(S, ['harness/task.mjs', 'track', id, 'engine:godot', '--by', 'builder-3'], { ...env, STUDIO_LOCK_OWNER: 'builder-3' }) : { status: -1 };
    const byPerson = id ? node(S, ['harness/task.mjs', 'track', id, 'engine:godot', '--by', 'pat'], env) : { status: -1 };
    const rec = probe(S, `const et = await import(${u(S, 'harness/engine-tracks.mjs')}); console.log(JSON.stringify({ rec: et.engineTask(${JSON.stringify(id || '')}, { root: process.cwd(), events: [] }) }));`, env);
    await guard('2.78.2 (e, 7d): `npm run task -- track <ID> engine:<name> --by <you>` records an engine pass\'s track for a person, the orchestrator or a Producer; a worker is refused (fails on 2.78.1: there was no such command, so the crew fixed T-218\'s record by hand)', () => [
      Boolean(id) && byWorker.status === 1 && /worker agent/.test(out(byWorker)) && byPerson.status === 0 && rec.j?.rec?.track === 'engine:godot',
      JSON.stringify({ id, byWorker: out(byWorker).slice(-200), byPerson: out(byPerson).slice(-200), rec: rec.j })]);
  }

  // ---- 7e: an uncommitted beta-format protected approval (report only in (e); an assertion since (h)) ----
  {
    const { S, env } = studio('7e');
    const owner = keyPair('owner');
    writeIn(S, 'studio/keys/owner-ed25519.pub.pem', owner.pub);
    const at = new Date().toISOString();
    writeIn(S, 'studio/beta.json', `${JSON.stringify({ on: true, by: 'pat', at, why: 'beta for the selftest', agents: ['opus-1'], roles: ['producer', 'director'] }, null, 2)}\n`);
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'owner key, beta on', '--no-verify');
    g(S, 'checkout', '-q', '-b', 'lane/b');
    touch(S, 'a builder edits a protected check');
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'builder: edit the controls check', '--no-verify');
    const before = node(S, ['harness/approve.mjs', 'show'], env);
    // A builder drops (never commits) a beta-format approval of exactly this change set.
    const drop = probe(S, `const a = await import(${u(S, 'harness/approve.mjs')}); const r = a.checkProtected(); const doc = { approval: { kind: 'protected', change: r.change, files: r.changes, base: r.base, by: 'pat', note: 'dropped by a builder, never committed', at: new Date().toISOString(), recordedBy: 'opus-1', via: 'beta agent' }, signature: null, beta: { by: 'pat', at: ${JSON.stringify(at)} } }; const fs = await import('node:fs'); fs.mkdirSync('studio/approvals', { recursive: true }); fs.writeFileSync('studio/approvals/protected-dropped.json', JSON.stringify(doc, null, 2)); const bm = await import(${u(S, 'harness/beta-mode.mjs')}); console.log(JSON.stringify({ change: r.change, betaOk: bm.betaApprovalOk(doc), committed: bm.betaRecordCommitted(process.cwd(), 'studio/approvals/protected-dropped.json', doc), verify: a.verifyApproval({ file: 'studio/approvals/protected-dropped.json', ...doc }, ${JSON.stringify(owner.pub)}) }));`, env);
    const status = g(S, 'status', '--porcelain', '--', 'studio/approvals').stdout.trim();
    const after = node(S, ['harness/approve.mjs', 'show'], env);
    const accepted = after.status === 0 && /OK: approved by/.test(out(after));
    const valid = before.status === 3 && drop.j?.betaOk === true && drop.j?.committed === false && /^\?\? studio\/approvals\//.test(status);
    // 2.78.2 (h): the same record, committed by the orchestrator (opus-1, an outside agent), counts.
    g(S, 'add', '--', 'studio/approvals/protected-dropped.json');
    g(S, 'commit', '-qm', 'the orchestrator commits its approval', '-m', 'Studio-Agent: opus-1', '--no-verify', '--', 'studio/approvals/protected-dropped.json');
    const committed = node(S, ['harness/approve.mjs', 'show'], env);
    const acceptedCommitted = committed.status === 0 && /OK: approved by/.test(out(committed));
    await guard('2.78.2 (e, 7e; an assertion since (h); the 2.79 audit D1.1): a builder-dropped, uncommitted beta-format protected approval of exactly the lane\'s change set, under beta mode, is REFUSED by the protected check; the same approval committed by the orchestrator (opus-1) is accepted (fails on 2.78.1: approve.mjs verifyApproval treated committedByAgent()=null, uncommitted, as fine, while beta-mode.mjs betaRecordCommitted refused it)', () => [
      valid && !accepted && /isn't committed/.test(out(after)) && acceptedCommitted,
      JSON.stringify({ accepted, acceptedCommitted, before: out(before).slice(-200), drop: drop.j || out(drop).slice(-300), status, after: out(after).slice(-300), committed: out(committed).slice(-200) })]);
  }

  // ---- 9: region lanes ----
  {
    const { S, env } = studio('9');
    const F = 'web/regiongame/sim/sim.ts';
    const body = ['export function alpha(n: number) {', ...Array.from({ length: 20 }, (_, i) => `  n += ${i};`), '  return n;', '}', '', 'export function beta(n: number) {', ...Array.from({ length: 20 }, (_, i) => `  n -= ${i};`), '  return n;', '}', '', 'export class Sim {', '  tick() {', '    return alpha(1) + beta(2);', '  }', '}', ''].join('\n');
    writeIn(S, F, body);
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'a big shared sim file', '--no-verify');
    const code = `const th = await import(${u(S, 'harness/task-hold.mjs')}); const lp = await import(${u(S, 'harness/lane-plan.mjs')});
const F = ${JSON.stringify(F)};
const c = (a, b) => th.lanesClash(a, b);
const files = [F];
const t = (fp) => lp.sharedTouches(fp, ['**/sim/sim.*'], files);
const rows = (a, b) => [{ id: 'T-1', state: 'running', touches: t(a) }, { id: 'T-2', state: 'ready', touches: t(b) }];
console.log(JSON.stringify({
  apart: c(F + '#alpha', F + '#beta'), same: c(F + '#alpha', F + '#alpha'), nested: c(F + '#Sim', F + '#tick'), lines: c(F + '#L1-L5', F + '#L30-L32'), linesHit: c(F + '#L1-L5', F + '#alpha'),
  whole: c(F + '#alpha', F), folder: c(F + '#alpha', 'web/regiongame/sim'), unknown: c(F + '#nosuch', F + '#beta'), plain: c('web/regiongame/sim/a.ts', 'web/regiongame/sim/b.ts'),
  stackApart: lp.stackShared(rows([F + '#alpha'], [F + '#beta'])).length, stackSame: lp.stackShared(rows([F + '#alpha'], [F + '#alpha'])).length, stackWhole: lp.stackShared(rows([F], [F + '#beta'])).length,
  list: th.laneList(F + '#alpha,' + F + '#beta'),
}));`;
    const on = probe(S, code, { ...env, STUDIO_REGION_FILES: 'web/*/sim/sim.ts' });
    const offR = probe(S, code, env);
    const o = on.j || {}; const f = offR.j || {};
    await guard('2.78.2 (e, 9): with STUDIO_REGION_FILES naming a big shared sim file, two lanes on regions of it that don\'t overlap (#alpha vs #beta, line ranges apart) don\'t clash and aren\'t stacked as shared sim code; the same region, nested symbols (#Sim vs #tick), overlapping lines, a symbol it can\'t find, a whole-file or folder lane all still clash and stack; with the file not opted in (the default) every one clashes and stacks at file level; laneList still gives the file (fails on 2.78.1: a lane clashed per file only, and an entry written path#region was plain text there: sim.ts#alpha didn\'t clash with a whole-file sim.ts lane nor stack with it, and laneList handed sim.ts#alpha to the claims and sparse checkouts as a path)', () => [
      o.apart === false && o.lines === false && o.same === true && o.nested === true && o.linesHit === true && o.whole === true && o.folder === true && o.unknown === true && o.plain === false
        && o.stackApart === 0 && o.stackSame === 1 && o.stackWhole === 1
        && f.apart === true && f.lines === true && f.stackApart === 1 && f.stackSame === 1
        && JSON.stringify(o.list) === JSON.stringify([F]),
      JSON.stringify({ on: on.j || out(on).slice(-400), off: offR.j || out(offR).slice(-400) })]);
  }
}
