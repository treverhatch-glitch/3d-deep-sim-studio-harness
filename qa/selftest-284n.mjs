/**
 * qa/selftest-284n.mjs — 2.84 (n): the overseer and an outside signer keep their authority to decide unattended.
 *
 * The owner's order (2026-11-12): the studio's overseer (an outside coding agent in the main checkout: a beta-mode named
 * agent, or the owner's proxy) and an outside signer (STUDIO_OUTSIDE_SIGNERS in the main checkout's .env) keep their
 * authority to control and make unattended decisions in the harness: no person at a terminal, no prompt, no TTY.
 * One studio: an owner key, beta mode on naming overseer-1, STUDIO_OUTSIDE_SIGNERS=signer-1, an owner-signed proxy grant
 * to proxy-1, a made-up engine repo (port/main). Every command runs with stdin closed and no TTY. One check per decision
 * command added or changed in 2.82 to 2.84: the overseer (and the proxy) allowed and recorded, the signer allowed, a
 * launched worker session refused where the command has an actor check at all. A check that covers a fix says what
 * failed before it; the rows that already worked are regression guards, marked "(guard)".
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest284N({ dir, root, report, tmpRoot }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = fs.existsSync(path.join(dir, 'node_modules')) ? path.join(dir, 'node_modules') : path.join(harnessRoot, 'node_modules');
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const tail = (r, n = 300) => `[${r.status}] ${out(r).replace(/\s+/g, ' ').trim().slice(-n)}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3500)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 2500)); } };
  const fwd = (p) => p.split(path.sep).join('/');
  const write = (b, rel, text) => { fs.mkdirSync(path.dirname(path.join(b, rel)), { recursive: true }); fs.writeFileSync(path.join(b, rel), text); };
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const KEY = path.join(tmpRoot, `owner-key-284n-${process.pid}.pem`);
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_VERIFY_DETACH: 'off',
    STUDIO_HOOKS_CHECK: 'off', STUDIO_DRIFT: 'off', STUDIO_MACHINE_SCAN: 'off', STUDIO_THREADS: 'off', STUDIO_LANELESS: 'shared', STUDIO_IDLE_EXIT_MIN: '0', STUDIO_AUTO_FINISH: 'off', STUDIO_HEARTBEAT_SEC: '1',
    STUDIO_QUOTA_PROBE: 'off', STUDIO_POST_BROWSER_PLAY: 'off', STUDIO_LANE_INFER: 'off', STUDIO_REACHABILITY: 'off', STUDIO_NIM_CHECK: 'off', STUDIO_UPGRADE_WATCH_MIN: 'off',
    STUDIO_CREW_WATCH: 'off', STUDIO_STALL: 'off', STUDIO_LAUNCH_LOCK_SEC: '1', STUDIO_OVERLAP: 'off', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_RAM_FLOOR_GB: '0', STUDIO_CPU_PROBE: 'off', STUDIO_HEAVY_PROGRAMS: 'off',
    STUDIO_HEAVY_SLOTS: '1', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '0.03', STUDIO_UNITY_TRAIN_RETRIES: '0', STUDIO_UNITY_TRAIN_RETRY_MIN: '0', STUDIO_ENGINE_FULL_LAND_HOURS: 'off', STUDIO_TRAIN_DETACH: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-284n-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '', npm_config_node_options: '',
  };
  const T = path.join(tmpRoot, `s284n-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });

  // ---- the studio: owner key, beta mode naming overseer-1, signer-1 in the main checkout's .env, a proxy grant to proxy-1 ----
  const S = path.join(tmpRoot, `284n-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', '.env', 'studio/beta.json', 'studio/delegation.json', 'studio/approvals', 'studio/keys', 'studio/task-holds.json', 'studio/asks', 'studio/review.json', 'studio/mode.json', 'studio/engine', 'studio/allowlist.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch { /* the checks need no package */ } }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(KEY, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  write(S, 'studio/keys/owner-ed25519.pub.pem', publicKey.export({ type: 'spki', format: 'pem' }));
  write(S, 'studio/beta.json', `${JSON.stringify({ on: true, by: 'pat', at: '2026-11-05T01:00:00.000Z', why: 'beta for the selftest', agents: ['overseer-1'], roles: ['producer', 'director'] }, null, 2)}\n`);
  write(S, '.gitignore', `${fs.existsSync(path.join(dir, '.gitignore')) ? fs.readFileSync(path.join(dir, '.gitignore'), 'utf8') : ''}\n/.lanes/\n/.studio/\n.env\n`);
  write(S, '.env', 'STUDIO_OUTSIDE_SIGNERS=signer-1\n');
  // The made-up engine repo: target port/main, checked out in the land script's gate worktree; a land stand-in that merges.
  const R = path.join(T, 'repo');
  const GW = path.join(T, 'gate');
  fs.mkdirSync(R, { recursive: true });
  g(R, 'init', '-q', '-b', 'port/main'); g(R, 'config', 'core.autocrlf', 'false'); write(R, 'base.txt', 'base\n'); g(R, 'add', '-A'); g(R, 'commit', '-qm', 'start');
  g(R, 'checkout', '-q', '-b', 'dev'); g(R, 'worktree', 'add', '-q', GW, 'port/main');
  const landStub = path.join(T, 'land-stub.mjs');
  fs.writeFileSync(landStub, `import { spawnSync } from 'node:child_process';
const [gw, ...srcs] = process.argv.slice(2);
for (const s of srcs) { const m = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'merge', '--no-ff', '-m', 'land ' + s, 'refs/heads/' + s], { cwd: gw, encoding: 'utf8', windowsHide: true }); if (m.status !== 0) { console.log('conflict ' + s); process.exit(2); } }
console.log('landed ' + srcs.join(' '));
`);
  // The batch window (2.84 h) is set: 4 branches or 30 minutes.
  const engineCfg = { land: `node "${fwd(landStub)}" "${fwd(GW)}" {branch}`, target: 'port/main', cwd: fwd(R), gateWorktree: fwd(GW), timeoutMin: 5, rules: false, batchMin: 4, batchWaitMin: 30 };
  const gameBefore = readJson(path.join(S, 'studio', 'game.json')) || {};
  write(S, 'studio/game.json', `${JSON.stringify({ ...gameBefore, engines: { unity: engineCfg } }, null, 2)}\n`);
  const ev = path.join(S, '.studio', 'events-284n.jsonl');
  fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
  g(S, 'init', '-q', '-b', 'main'); g(S, 'config', 'core.autocrlf', 'false'); g(S, 'config', 'core.eol', 'lf'); g(S, 'config', 'user.name', 't'); g(S, 'config', 'user.email', 't@example.invalid');
  g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio, owner key, beta on', '--no-verify');
  // The studio's commit-msg hook (as `npm run hooks:install` sets it up), alone: it writes the Studio-Agent trailer a
  // stand-in's record is judged by.
  fs.mkdirSync(path.join(T, 'hooks'), { recursive: true });
  fs.copyFileSync(path.join(S, 'scripts', 'hooks', 'commit-msg'), path.join(T, 'hooks', 'commit-msg'));
  try { fs.chmodSync(path.join(T, 'hooks', 'commit-msg'), 0o755); } catch { /* Windows: git runs it with its own bash */ }
  g(S, 'config', 'core.hooksPath', fwd(path.join(T, 'hooks')));
  const env = { ...process.env, ...base, AGENT_EVENTS_FILE: ev, STUDIO_MAIN_ROOT: S };
  // Every command: stdin closed, no TTY.
  const cli = (actor, args, extra = {}) => spawnSync(process.execPath, args, { windowsHide: true, cwd: S, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240000, env: { ...env, ...actor, ...extra } });
  const events = () => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
  const lastEvent = (type, task = null) => events().filter((e) => e.type === type && (!task || e.task === task)).at(-1) || null;
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  let pn = 0;
  const probe = (code, actor = {}) => {
    const f = path.join(S, `.probe-284n-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = cli(actor, [f]);
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(l), _out: out(r).slice(-1200) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };

  const OWNER = {}; // a person's own terminal
  const OVER = { CLAUDECODE: '1', STUDIO_LOCK_OWNER: 'overseer-1' }; // the beta-mode named agent
  const PROXY = { CLAUDECODE: '1', STUDIO_LOCK_OWNER: 'proxy-1' }; // the owner's proxy shell
  const SIGNER = { AI_AGENT: '1', STUDIO_LOCK_OWNER: 'signer-1' }; // the outside signer the owner lists in .env
  const PROD = { STUDIO_ROLE: 'producer', STUDIO_LOCK_OWNER: 'producer-n1', STUDIO_TASK_PIN: '' };
  const WORK = { STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-n1', STUDIO_TASK_PIN: 'T-999' };
  const ACTORS = { owner: OWNER, proxy: PROXY, overseer: OVER, signer: SIGNER, producer: PROD, worker: WORK };
  const byName = { owner: 'pat', proxy: 'proxy-1', overseer: 'overseer-1', signer: 'signer-1', producer: 'producer-n1', worker: 'builder-n1' };
  const table = {};
  const mark = (row, who, ok) => { (table[row] ||= {})[who] = ok ? 'yes' : 'no'; };

  // The owner signs a standing proxy grant to proxy-1 (it commits studio/delegation.json).
  const grant = cli({ STUDIO_OWNER_KEY: KEY }, ['harness/delegation.mjs', 'proxy', 'proxy-1', '--by', 'pat', '--days', '30', '--why', 'the overseer proxy for the selftest']);
  const addTask = (title, extra = []) => (out(cli(OWNER, ['harness/task.mjs', 'add', title, '--role', 'builder', '--priority', 'P1', ...extra])).match(/\b(T-\d+)\b/) || [])[1];
  const holds = () => readJson(path.join(S, 'studio', 'task-holds.json'))?.tasks || {};
  const setupOk = grant.status === 0 && fs.existsSync(path.join(S, 'studio', 'delegation.json'));
  report('2.84 (n) setup: a studio with an owner key, beta mode naming overseer-1, signer-1 in the main checkout\'s .env and an owner-signed proxy grant to proxy-1', setupOk, setupOk ? '' : tail(grant, 800));

  // ---- 1. task alone <ID> on|off ----
  {
    const ids = {};
    for (const who of Object.keys(ACTORS)) { ids[who] = addTask(`Port the ${who} rules`, ['--track', 'engine:unity']); }
    const res = {};
    for (const [who, a] of Object.entries(ACTORS)) {
      const r = cli(a, ['harness/task.mjs', 'alone', ids[who], 'on']);
      const e = lastEvent('task.alone', ids[who]);
      res[who] = { r: tail(r), agent: e?.agent || null, alone: readJson(path.join(S, '.studio', 'engine', 'tasks.json'))?.[ids[who]]?.alone ?? null };
      mark('alone', who, r.status === 0 && res[who].alone === true);
    }
    await guard('2.84 (n) `task alone <ID> on` (guard): the overseer (beta-named), the owner\'s proxy and the outside signer each set it unattended (exit 0, the engine record says alone, the task.alone event names them); the command has no actor check, so a worker session is not refused either (left as it is)', () => [
      ['overseer', 'proxy', 'signer'].every((w) => res[w].alone === true && res[w].agent === byName[w]) && res.worker.alone === true, JSON.stringify(res)]);
  }

  // ---- 2. task train dequeue <ID> --engine unity ----
  {
    const res = {};
    for (const [who, a] of Object.entries(ACTORS)) {
      const id = addTask(`Dequeue the ${who} lane`, ['--track', 'engine:unity']);
      write(S, '.studio/train/unity-queue.json', JSON.stringify([{ task: id, agent: 'porter-0', branch: `unity/${id.toLowerCase()}`, head: '0'.repeat(40), at: new Date().toISOString() }]));
      const r = cli(a, ['harness/task.mjs', 'train', 'dequeue', id, '--engine', 'unity', '--by', byName[who]]);
      const q = readJson(path.join(S, '.studio', 'train', 'unity-queue.json')) || [];
      const e = lastEvent('task.train.dequeued', id);
      res[who] = { r: tail(r), out: !q.some((x) => x.task === id), agent: e?.agent || null };
      mark('dequeue', who, r.status === 0 && res[who].out);
    }
    fs.rmSync(path.join(S, '.studio', 'train', 'unity-queue.json'), { force: true });
    await guard('2.84 (n) `task train dequeue <ID> --engine unity` (guard): the overseer, the proxy and the signer take a lane out of the engine queue unattended, recorded as theirs (task.train.dequeued by them); no actor check, so a worker is not refused (left as it is)', () => [
      ['overseer', 'proxy', 'signer'].every((w) => res[w].out && res[w].agent === byName[w]), JSON.stringify(res)]);
  }

  // ---- 3. task after <ID> --set | --remove | --clear ----
  {
    const a1 = addTask('Wait list target');
    const a2 = addTask('Wait list other');
    const res = {};
    for (const [who, a] of Object.entries(ACTORS)) {
      const id = addTask(`After list of ${who}`);
      const set = cli(a, ['harness/task.mjs', 'after', id, '--set', `${a1},${a2}`, '--by', byName[who]]);
      const afterSet = holds()[id]?.after || [];
      const rm = cli(a, ['harness/task.mjs', 'after', id, '--remove', a2, '--by', byName[who]]);
      const afterRm = holds()[id]?.after || [];
      const clr = cli(a, ['harness/task.mjs', 'after', id, '--clear', '--by', byName[who]]);
      const e = lastEvent('task.hold', id);
      res[who] = { set: tail(set, 120), afterSet, afterRm, clr: tail(clr, 120), cleared: !(holds()[id]?.after || []).length, agent: e?.agent || null };
      mark('after', who, set.status === 0 && rm.status === 0 && clr.status === 0 && afterSet.join() === `${a1},${a2}` && afterRm.join() === a1 && res[who].cleared);
    }
    await guard('2.84 (n) `task after <ID> --set a,b | --remove a | --clear` (guard): the overseer, the proxy and the signer change a wait list unattended, each step recorded by them (task.hold events); no actor check, so a worker is not refused (left as it is)', () => [
      ['overseer', 'proxy', 'signer'].every((w) => table.after[w] === 'yes' && res[w].agent === byName[w]), JSON.stringify(res)]);
  }

  // ---- 4. task track <ID> web ----
  {
    const res = {};
    for (const [who, a] of Object.entries(ACTORS)) {
      const id = addTask(`Back to web ${who}`, ['--track', 'engine:unity']);
      const r = cli(a, ['harness/task.mjs', 'track', id, 'web', '--by', byName[who]]);
      const rec = readJson(path.join(S, '.studio', 'engine', 'tasks.json'))?.[id] || {};
      const e = lastEvent('task.track', id);
      res[who] = { r: tail(r), track: rec.track || null, agent: e?.agent || null };
      mark('track web', who, r.status === 0 && rec.track === 'web');
    }
    await guard('2.84 (n) `task track <ID> web` (guard): the overseer, the proxy and the signer set a task back to the web track unattended, recorded as theirs (task.track by them, setBy); a launched worker session is refused and the track stays', () => [
      ['overseer', 'proxy', 'signer'].every((w) => res[w].track === 'web' && res[w].agent === byName[w]) && table['track web'].worker === 'no' && res.worker.track !== 'web' && /Refused/.test(res.worker.r), JSON.stringify(res)]);
  }

  // ---- 5. task unpark / unhold ----
  {
    const res = {};
    for (const [who, a] of Object.entries(ACTORS)) {
      // The owner parks it in person (rank: owner); the harness parks one for an owner-only step (rank: orchestrator).
      const id = addTask(`Unpark by ${who}`);
      cli(OWNER, ['harness/task.mjs', 'park', id, '--by', 'pat', '--why', 'the owner parks it until the art is in']);
      const r = cli(a, ['harness/task.mjs', 'unpark', id, '--by', byName[who]]);
      const id2 = addTask(`Owner-only park ${who}`);
      write(S, 'studio/task-holds.json', JSON.stringify({ tasks: { ...holds(), [id2]: { parked: { by: 'harness', why: 'its step is the owner\'s', reason: 'owner-only', at: new Date().toISOString(), rank: 3, byRole: 'orchestrator', ownerOnly: true } } } }));
      const r2 = cli(a, ['harness/task.mjs', 'unpark', id2, '--by', byName[who]]);
      const e = lastEvent('task.hold', id);
      res[who] = { r: tail(r, 220), parked: Boolean(holds()[id]?.parked), r2: tail(r2, 160), parked2: Boolean(holds()[id2]?.parked), agent: e?.agent || null };
      mark('unpark', who, r.status === 0 && !res[who].parked && r2.status === 0 && !res[who].parked2);
    }
    await guard('2.84 (n) `task unpark <ID> --by <name>`: the overseer (beta-named), the owner\'s proxy and the outside signer unpark a task the owner parked in person and one the harness parked for an owner-only step, unattended, recorded as theirs; a worker session is refused both, a Producer session the owner\'s park (fails before this fix: the park rank read every agent whose name is not opus-N as "an agent" (rank 2), so the overseer, the proxy and the signer were refused the owner\'s parks and the harness\'s owner-only parks)', () => [
      ['overseer', 'proxy', 'signer'].every((w) => table.unpark[w] === 'yes' && res[w].agent === byName[w]) && table.unpark.worker === 'no' && res.worker.parked && res.worker.parked2 && res.producer.parked, JSON.stringify(res)]);

    const hres = {};
    for (const [who, a] of Object.entries(ACTORS)) {
      const id = addTask(`Unhold by ${who}`);
      cli(OWNER, ['harness/task.mjs', 'hold', id, '--by', 'pat', '--why', 'held for the merge chain']);
      const r = cli(a, ['harness/task.mjs', 'unhold', id, '--by', byName[who]]);
      const e = lastEvent('task.unheld', id);
      hres[who] = { r: tail(r, 200), held: Boolean(holds()[id]?.held), agent: e?.agent || null };
      mark('unhold', who, r.status === 0 && !hres[who].held);
    }
    await guard('2.84 (n) `task unhold <ID> --by <name>` (guard): the overseer, the proxy and the signer release a held task unattended, recorded as theirs (task.unheld by them); a worker session is refused and the hold stays', () => [
      ['overseer', 'proxy', 'signer'].every((w) => table.unhold[w] === 'yes' && hres[w].agent === byName[w]) && table.unhold.worker === 'no' && hres.worker.held, JSON.stringify(hres)]);
  }

  // ---- 6. review same-family on|off|auto ----
  {
    const res = {};
    for (const [who, a] of Object.entries(ACTORS)) {
      fs.rmSync(path.join(S, 'studio', 'review.json'), { force: true });
      const r = cli(a, ['harness/review.mjs', 'same-family', 'on', '--by', byName[who], '--why', 'beta: one model family for now']);
      const j = readJson(path.join(S, 'studio', 'review.json'));
      res[who] = { r: tail(r, 220), value: j?.sameFamily || null, by: j?.by || null, via: j?.via || null };
      mark('same-family', who, r.status === 0 && j?.sameFamily === 'on');
    }
    fs.rmSync(path.join(S, 'studio', 'review.json'), { force: true });
    await guard('2.84 (n) `review -- same-family on --by <name>` (guard): the overseer (via beta mode), the proxy (via owner proxy) and the signer set it unattended, recorded as theirs; a Producer session (no STUDIO_PRODUCER_APPROVES=protected) and a worker session are refused', () => [
      res.overseer.by === 'overseer-1' && res.overseer.via === 'beta mode' && res.proxy.by === 'proxy-1' && res.proxy.via === 'owner proxy' && res.signer.by === 'signer-1' && res.signer.via === 'beta mode'
        && table['same-family'].producer === 'no' && table['same-family'].worker === 'no', JSON.stringify(res)]);
  }

  // ---- 7. engine -- merge <ID> (Part 1) ----
  {
    const id = addTask('Port the fees rules', ['--track', 'engine:unity']);
    const la = probe(`const et = await import(${u('harness/engine-tracks.mjs')});
const la = et.engineLaunch({ task: ${JSON.stringify(id)}, agent: 'builder-n7', role: 'builder' });
console.log(JSON.stringify({ dir: la?.dir || null, error: la?.error || null }));`);
    const L = la.dir;
    let k = 0;
    const targetMoves = () => { write(GW, `t-${++k}.txt`, `${k}\n`); g(GW, 'add', '-A'); g(GW, 'commit', '-qm', `target adds ${k}`); };
    const res = {};
    for (const [who, a] of Object.entries(ACTORS)) {
      targetMoves();
      const pinned = who === 'worker' ? { STUDIO_TASK_PIN: id } : {};
      const before = L ? g(L, 'rev-parse', 'HEAD').stdout.trim() : '';
      const r = cli({ ...a, ...pinned }, ['harness/engine.mjs', 'merge', id]);
      const after = L ? g(L, 'rev-parse', 'HEAD').stdout.trim() : '';
      const e = events().filter((x) => x.type === 'engine.target_merge' && x.task === id && x.meta?.step === 'done').at(-1);
      res[who] = { r: tail(r, 260), merged: Boolean(L) && before !== after && fs.existsSync(path.join(L, `t-${k}.txt`)), agent: e?.agent || null, via: e?.meta?.via || null };
      mark('engine merge', who, r.status === 0 && res[who].merged);
    }
    // --abort and --continue for the overseer: a conflict it puts back, then one it resolves.
    let abortOk = false; let contOk = false; let ab = null; let co = null;
    if (L) {
      write(L, 'base.txt', 'lane side\n'); g(L, 'add', '-A'); g(L, 'commit', '-qm', 'lane side');
      write(GW, 'base.txt', 'target side\n'); g(GW, 'add', '-A'); g(GW, 'commit', '-qm', 'target side');
      const m1 = cli(OVER, ['harness/engine.mjs', 'merge', id]);
      ab = cli(OVER, ['harness/engine.mjs', 'merge', id, '--abort']);
      abortOk = m1.status === 2 && ab.status === 0 && g(L, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').status !== 0;
      const m2 = cli(SIGNER, ['harness/engine.mjs', 'merge', id]);
      write(L, 'base.txt', 'both sides\n'); g(L, 'add', 'base.txt');
      co = cli(SIGNER, ['harness/engine.mjs', 'merge', id, '--continue']);
      contOk = m2.status === 2 && co.status === 0 && g(L, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').status !== 0;
    }
    const wPin = cli({ ...WORK, STUDIO_TASK_PIN: 'T-998' }, ['harness/engine.mjs', 'merge', id]);
    await guard('2.84 (n) `engine -- merge <ID>`, `--abort`, `--continue`: the overseer (STUDIO_LOCK_OWNER set to its own name, no claim on the task), the owner\'s proxy and the outside signer merge the target into a task\'s engine worktree unattended, and the engine.target_merge event names them with via; --abort and --continue work for them too; a launched worker session without the claim is refused, pinned to the task or to another (fails before this fix: any caller with STUDIO_LOCK_OWNER set had to hold the task\'s claim, so the overseer was refused the merge it did by hand before the command existed)', () => [
      Boolean(L) && ['overseer', 'proxy', 'signer'].every((w) => res[w].merged && res[w].agent === byName[w] && res[w].via) && res.overseer.via === 'beta mode' && res.proxy.via === 'owner proxy'
        && table['engine merge'].worker === 'no' && /does not hold/.test(res.worker.r) && wPin.status === 1 && /launched for T-998/.test(out(wPin)) && abortOk && contOk,
      JSON.stringify({ la, res, ab: ab && tail(ab), co: co && tail(co), wPin: tail(wPin) })]);
  }

  // ---- 8. task train --engine unity: the overseer's start is never held by the batch window ----
  {
    const id = addTask('Land the loans rules', ['--track', 'engine:unity']);
    const br = `unity/${id.toLowerCase()}`;
    g(R, 'checkout', '-q', '-B', br, 'port/main'); write(R, 'loans.txt', 'loans\n'); g(R, 'add', '-A'); g(R, 'commit', '-qm', 'loans'); g(R, 'checkout', '-q', 'dev');
    const head = g(R, 'rev-parse', br).stdout.trim();
    const qEntry = [{ task: id, agent: 'porter-0', branch: br, head, at: new Date().toISOString() }];
    write(S, '.studio/train/unity-queue.json', JSON.stringify(qEntry));
    // The automatic start would wait: 1 of 4 queued, the oldest a moment ago, a session still working on a Unity task.
    const w = probe(`import { engineBatchWait, engineBatchRules } from ${u('harness/line-producer.mjs')};
const rules = engineBatchRules(${JSON.stringify(engineCfg)}, {});
console.log(JSON.stringify(engineBatchWait({ engine: 'unity', label: 'Unity', queue: ${JSON.stringify(qEntry)}, rules, working: ['T-901'] })));`);
    const r = cli(OVER, ['harness/task.mjs', 'train', '--engine', 'unity', '--by', 'overseer-1', '--foreground']);
    const landed = g(GW, 'log', '--format=%s', '-5').stdout;
    const q = readJson(path.join(S, '.studio', 'train', 'unity-queue.json')) || [];
    mark('train --engine', 'overseer', r.status === 0 && /land unity\//.test(landed));
    await guard('2.84 (n) `task train --engine unity` started by the overseer (guard): with a batch window that makes the automatic start wait (engineBatchWait: 1 of 4 queued, a session still working), the overseer\'s start runs at once and lands the branch unattended; the window applies only to the Line Producer\'s automatic start', () => [
      w.wait === true && r.status === 0 && new RegExp(`land ${br.replace('/', '\\/')}`).test(landed) && !q.some((x) => x.task === id), JSON.stringify({ w, r: tail(r, 900), landed, q })]);
  }

  // ---- 9. ask -- answer: a board ask, an owner-only (deleting data) ask ----
  {
    const askAs = (q) => (out(cli({ STUDIO_LOCK_OWNER: 'builder-n1' }, ['harness/ask.mjs', q, '--by', 'builder-n1'])).match(/\b(A-\d+)\b/) || [])[1];
    const doc = (id) => readJson(path.join(S, 'studio', 'asks', `${id}.json`));
    const res = {};
    for (const [who, a] of Object.entries(ACTORS)) {
      const board = askAs(`Should the fees panel go before the loans panel (${who})?`);
      const own = askAs(`Delete the save files of the old build (${who})?`);
      const rb = cli(a, ['harness/ask.mjs', 'answer', board, 'yes', '--by', byName[who]]);
      const ro = cli(a, ['harness/ask.mjs', 'answer', own, 'yes', '--by', byName[who]]);
      const [db, dOwn] = [doc(board), doc(own)];
      res[who] = { board: { st: rb.status, s: db?.status, recordedBy: db?.recordedBy, via: db?.via }, own: { st: ro.status, s: dOwn?.status, refused: /^Refused/m.test(out(ro)), out: tail(ro, 160) } };
      mark('ask board', who, rb.status === 0 && db?.status === 'answered');
      mark('ask owner-only (deleting data)', who, ro.status === 0 && dOwn?.status === 'answered');
    }
    const standIn = (w, via) => res[w].board.s === 'answered' && res[w].board.recordedBy === byName[w] && res[w].board.via === via
      && res[w].own.st !== 0 && res[w].own.s === 'open' && res[w].own.refused;
    await guard('2.84 (n) `ask -- answer <ID> "<answer>" --by <name>` (guard): the overseer and the signer (via beta mode) and the proxy (via owner proxy) answer a board ask unattended, recorded as theirs; an owner-only ask (deleting data) is refused to all three and stays open (the owner\'s own: correct, and it stays); a worker session is refused every ask; the owner in person answers both', () => [
      standIn('overseer', 'beta mode') && standIn('signer', 'beta mode') && standIn('proxy', 'owner proxy') && res.worker.board.s === 'open' && res.worker.own.s === 'open' && table['ask owner-only (deleting data)'].owner === 'yes',
      JSON.stringify({ proxy: res.proxy, overseer: res.overseer, signer: res.signer, owner: res.owner, worker: res.worker })]);
  }

  // ---- 10. task type <ID> <type> ----
  {
    const res = {};
    for (const [who, a] of Object.entries(ACTORS)) {
      const id = addTask(`Rates ${who}`, ['--type', 'system']);
      const r = cli(a, ['harness/task.mjs', 'type', id, 'chore', '--by', byName[who], '--why', 'chore work, not a system: unblock it']);
      const rec = readJson(path.join(S, 'studio', 'task-types.json'))?.tasks?.[id] || null;
      const seen = cli(OWNER, ['harness/task.mjs', 'type', id]);
      res[who] = { r: tail(r, 300), type: rec?.type || null, by: rec?.by || null, recordedBy: rec?.recordedBy || null, seen: out(seen).slice(0, 200) };
      mark('type', who, r.status === 0 && /is a "chore" task/.test(out(seen)));
    }
    const e = events().filter((x) => x.type === 'task.retyped');
    await guard('2.84 (n) `task type <ID> chore --by <name> --why "…"` (guard): the overseer, the proxy and the signer retype a task unattended and the board reads the new type at once (the check reads it back), recorded as theirs (task.retyped / the record); a worker session is refused', () => [
      ['overseer', 'proxy', 'signer'].every((w) => table.type[w] === 'yes') && table.type.worker === 'no' && e.length >= 3, JSON.stringify({ e: e.map((x) => [x.agent, x.meta?.recordedBy]), proxy: res.proxy, overseer: res.overseer, signer: res.signer, worker: res.worker.r.slice(0, 80) })]);
  }

  // ---- 11. mode boost on --builders-only --hours N ----
  {
    const res = {};
    for (const [who, a] of Object.entries(ACTORS)) {
      const r = cli(a, ['harness/mode.mjs', 'boost', 'on', '--builders-only', '--hours', '2', '--by', byName[who]]);
      const m = readJson(path.join(S, 'studio', 'mode.json'));
      res[who] = { r: tail(r, 120), by: m?.boost?.by || null, buildersOnly: Boolean(m?.boost?.buildersOnly) };
      mark('boost', who, r.status === 0 && m?.boost?.on === true && m.boost.by === byName[who]);
    }
    await guard('2.84 (n) `mode -- boost on --builders-only --hours 2 --by <name>` (guard): the overseer, the proxy and the signer turn it on unattended, recorded as theirs (studio/mode.json boost.by); no actor check, so a worker is not refused (left as it is)', () => [
      ['overseer', 'proxy', 'signer'].every((w) => table.boost[w] === 'yes' && res[w].buildersOnly), JSON.stringify(res)]);
  }

  // ---- 13. agent start --task <ID> after the overseer unparks it ----
  {
    const id = addTask('Doors rules');
    cli(OWNER, ['harness/task.mjs', 'park', id, '--by', 'pat', '--why', 'parked until the doors art is in']);
    const agentJs = path.join(T, 'stand-in-agent.mjs');
    fs.writeFileSync(agentJs, `import { spawnSync } from 'node:child_process';
const [task] = process.argv.slice(2);
const st = spawnSync(process.execPath, ['harness/task.mjs', 'start', task, '--agent', process.env.STUDIO_LOCK_OWNER], { cwd: process.env.STUDIO_MAIN_ROOT, encoding: 'utf8', windowsHide: true, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
console.log('[stand-in] start: ' + String(st.stdout || st.stderr || '').trim().split('\\n').pop());
`);
    const launch = (a) => cli(a, ['harness/agent.mjs', 'start', '--attach', '--role', 'builder', '--agent', 'builder-n9', '--model', 'fake-1', '--task', id, '--one-task'], { STUDIO_BUILDER_CMD: `node "${fwd(agentJs)}" ${id}` });
    const refused = launch(OVER);
    const up = cli(OVER, ['harness/task.mjs', 'unpark', id, '--by', 'overseer-1']);
    const started = launch(OVER);
    const st = events().filter((e) => e.type === 'task.start' && e.task === id);
    mark('agent start (parked task)', 'overseer', up.status === 0 && started.status === 0 && st.length > 0);
    await guard('2.84 (n) `agent start --task <ID>` by the overseer for a parked task: refused while parked (2.84 a), then `task unpark <ID> --by overseer-1` and the same `agent start` starts the session unattended (its task start runs) (fails before this fix: the overseer could not unpark a task the owner parked, so its normal sequence stopped at the first step)', () => [
      refused.status !== 0 && up.status === 0 && started.status === 0 && st.length > 0, JSON.stringify({ refused: tail(refused, 300), up: tail(up, 200), started: tail(started, 600), st: st.length })]);
  }

  // ---- Part 3: the planning back-off ends on news by the overseer, as on a person's ----
  {
    fs.writeFileSync(ev, '');
    const askAs = (q) => (out(cli({ STUDIO_LOCK_OWNER: 'builder-n1' }, ['harness/ask.mjs', q, '--by', 'builder-n1'])).match(/\b(A-\d+)\b/) || [])[1];
    const newsOf = (fn) => { const n = events().length; fn(); return events().slice(n).filter((e) => ['ask.answered', 'decision', 'inbound.message'].includes(e.type)); };
    const answerBy = (a, who) => newsOf(() => cli(a, ['harness/ask.mjs', 'answer', askAs(`Which panel first (${who} news)?`), 'fees', '--by', byName[who]]));
    const unholdBy = (a, who) => { const id = addTask(`News hold ${who}`); cli(OWNER, ['harness/task.mjs', 'hold', id, '--by', 'pat', '--why', 'held for the merge chain']); return newsOf(() => cli(a, ['harness/task.mjs', 'unhold', id, '--by', byName[who]])).filter((e) => e.type === 'decision'); };
    const postBy = (a, who) => newsOf(() => cli(a, ['harness/threads.mjs', 'post', 'discord:12345', `${who}: start the doors task next`, '--source', 'discord', '--by', byName[who]]));
    const strong = {
      overseerAnswer: answerBy(OVER, 'overseer'), proxyAnswer: answerBy(PROXY, 'proxy'), personAnswer: answerBy(OWNER, 'owner'),
      overseerDecision: unholdBy(OVER, 'overseer'), proxyDecision: unholdBy(PROXY, 'proxy'), signerDecision: unholdBy(SIGNER, 'signer'), personDecision: unholdBy(OWNER, 'owner'),
      overseerOrder: postBy(OVER, 'overseer'), personOrder: postBy(OWNER, 'owner'),
    };
    const weak = { producerAnswer: answerBy(PROD, 'producer'), producerDecision: unholdBy(PROD, 'producer'), producerOrder: postBy(PROD, 'producer') };
    // Through gateWake: a backed-off regular cycle (2 quiet sessions), the session ended; is the next one cut short?
    const verdicts = probe(`import fs from 'node:fs';
import { gateWake, isStrongNews, WAKE_GATE_FILE } from ${u('harness/wake-gate.mjs')};
const strong = ${JSON.stringify(strong)}; const weak = ${JSON.stringify(weak)};
const T0 = Date.now() - 10 * 60000;
const run = (role, news) => {
  fs.mkdirSync(WAKE_GATE_FILE().replace(/[\\\\/][^\\\\/]+$/, ''), { recursive: true });
  fs.writeFileSync(WAKE_GATE_FILE(), JSON.stringify({ ['cycle:' + role]: { at: T0, agent: role + '-z', quiet: 2, folded: role + '-z' } }));
  const evs = [{ type: 'agent.session.end', agent: role + '-z', ts: new Date(T0 + 60000).toISOString(), meta: { outcome: { boardEvents: 0 } } }, ...news.map((e) => ({ ...e, ts: new Date(T0 + 120000).toISOString() }))];
  return gateWake({ kind: 'cycle', role, fp: () => ({ empty: false, count: news.length, lines: [] }), events: evs, baseMs: 45 * 60000, emit: () => {} }).skip;
};
const out = {};
for (const [k, list] of Object.entries({ ...strong, ...weak })) out[k] = { strong: list.length > 0 && list.every((e) => isStrongNews(e)), any: list.some((e) => isStrongNews(e)), n: list.length, producer: run('producer', list), director: run('director', list) };
out.nothing = { producer: run('producer', []), director: run('director', []) };
console.log(JSON.stringify(out));`);
    const ends = (k) => verdicts[k]?.strong === true && verdicts[k].producer === false && verdicts[k].director === false;
    const keeps = (k) => verdicts[k]?.n > 0 && verdicts[k].any === false && verdicts[k].producer === true && verdicts[k].director === true;
    await guard('2.84 (n) the back-off, an answer (guard): an ask answered by the overseer (beta mode) or the owner\'s proxy, recorded with recordedBy/via, ends the Producer\'s and the Director\'s back-off exactly as a person\'s answer does (strong news, the next regular cycle due at once)', () => [
      verdicts.nothing?.producer === true && verdicts.nothing?.director === true && ['overseerAnswer', 'proxyAnswer', 'personAnswer'].every(ends), JSON.stringify(verdicts)]);
    await guard('2.84 (n) the back-off, a decision: a decision the overseer, the proxy or the signer records (a `task unhold`, in the decisions log) ends both back-offs as a person\'s does (fails before this fix: the overseer\'s and the signer\'s board decisions were logged "as agent" and were not news, so the Producer and the Director slept through them)', () => [
      ['overseerDecision', 'proxyDecision', 'signerDecision', 'personDecision'].every(ends), JSON.stringify(verdicts)]);
    await guard('2.84 (n) the back-off, an order (guard): a message the overseer posts through the inbound channel (`thread -- post <key> "…" --source discord --by overseer-1`: inbound.message; a person, an outside agent or a Producer/Director session may post, never a worker) ends both back-offs as a person\'s does', () => [
      ['overseerOrder', 'personOrder'].every(ends), JSON.stringify(verdicts)]);
    await guard('2.84 (n) the back-off, a launched session\'s own news: an answer (recorded via beta mode), a decision and a post by a launched Producer session do not end the back-off (fails before this fix: a Producer session\'s beta-mode answer and its post counted as strong news, so the Producer could wake itself)', () => [
      ['producerAnswer', 'producerDecision', 'producerOrder'].every(keeps), JSON.stringify(verdicts)]);
  }

  // ---- 12. a signer's approval of a protected change: studio/game.json and studio/allowlist.json ----
  {
    const res = {};
    for (const [rel, text] of [['studio/game.json', null], ['studio/allowlist.json', JSON.stringify([['the studio\'s formatter', 'npx prettier --check *']], null, 2)]]) {
      g(S, 'checkout', '-q', 'main');
      g(S, 'checkout', '-q', '-B', `feat/${path.basename(rel, '.json')}`);
      if (text === null) { const j = readJson(path.join(S, rel)) || {}; j.engines.unity.timeoutMin = 7; write(S, rel, `${JSON.stringify(j, null, 2)}\n`); } else write(S, rel, `${text}\n`);
      g(S, 'add', '--', rel); g(S, 'commit', '-qm', `change ${rel}`, '--no-verify');
      const before = cli(OWNER, ['qa/protected-check.mjs']);
      const made = cli({ AI_AGENT: '1' }, ['harness/approve.mjs', 'protected', '--note', `signer-1 approves the ${rel} change for the owner`, '--by', 'signer-1']);
      const file = (fs.existsSync(path.join(S, 'studio', 'approvals')) ? fs.readdirSync(path.join(S, 'studio', 'approvals')) : []).filter((f) => f.startsWith('protected-')).find((f) => (readJson(path.join(S, 'studio', 'approvals', f))?.approval?.files || []).some((x) => x.path === rel));
      const doc = file ? readJson(path.join(S, 'studio', 'approvals', file)) : null;
      if (file) { g(S, 'add', '--', `studio/approvals/${file}`); g(S, 'commit', '-qm', 'approval', '-m', 'Studio-Agent: signer-1', '--no-verify'); }
      const check = cli(OWNER, ['qa/protected-check.mjs']);
      res[rel] = { before: tail(before, 200), made: tail(made, 300), recordedBy: doc?.approval?.recordedBy || null, check: tail(check, 300), ok: before.status !== 0 && made.status === 0 && doc?.approval?.recordedBy === 'signer-1' && check.status === 0 && /PASS/.test(out(check)) };
    }
    g(S, 'checkout', '-q', 'main');
    mark('approve protected (game.json)', 'signer', res['studio/game.json'].ok);
    mark('approve protected (allowlist.json)', 'signer', res['studio/allowlist.json'].ok);
    await guard('2.84 (n) `approve -- protected --by signer-1` (guard): in a studio with an owner key, the outside signer\'s approval of a change to studio/game.json and of one to studio/allowlist.json (protected since 2.83) is written recorded by signer-1, unattended, and qa/protected-check.mjs accepts each once committed (it failed before the approval)', () => [
      res['studio/game.json'].ok && res['studio/allowlist.json'].ok, JSON.stringify(res)]);
  }

  // The table as the checks found it (docs/OVERSEER.md is written from this line).
  console.log(`[284n table] ${JSON.stringify(table)}`);
}
