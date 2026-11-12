/**
 * qa/selftest-284q.mjs — 2.84 (q): in beta mode the overseer and an outside signer make the owner's decisions while the
 * owner is away: release a tier-C lane, force a done (also through the train), approve protected changes (their own
 * included, marked), unpark, resume a paused role; one rule (beta-mode.mjs standInMay), every use a beta.use event.
 *
 * One studio: an owner key, beta mode on naming overseer-1, STUDIO_OUTSIDE_SIGNERS=signer-1 in the main checkout's .env,
 * the studio's commit-msg hook. The overseer runs with CLAUDECODE and its own STUDIO_LOCK_OWNER; the signer runs in a
 * coding agent's shell (AI_AGENT) that names nobody, so --by names it. Every command: stdin closed, no TTY. For each
 * decision: the two stand-ins allowed and logged; a worker session, a pinned session and (where it had no right before)
 * a launched Producer refused; with beta mode off, all refused as before. The upgrade keeps beta mode on.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest284Q({ dir, root, report, tmpRoot }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = fs.existsSync(path.join(dir, 'node_modules')) ? path.join(dir, 'node_modules') : path.join(harnessRoot, 'node_modules');
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const tail = (r, n = 300) => `[${r.status}] ${out(r).replace(/\s+/g, ' ').trim().slice(-n)}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = (extra = {}) => { const e = { ...process.env, ...ident, ...extra }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3500)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 2500)); } };
  const fwd = (p) => p.split(path.sep).join('/');
  const write = (b, rel, text) => { fs.mkdirSync(path.dirname(path.join(b, rel)), { recursive: true }); fs.writeFileSync(path.join(b, rel), text); };
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const KEY = path.join(tmpRoot, `owner-key-284q-${process.pid}.pem`);
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_VERIFY_DETACH: 'off',
    STUDIO_HOOKS_CHECK: 'off', STUDIO_DRIFT: 'off', STUDIO_MACHINE_SCAN: 'off', STUDIO_THREADS: 'off', STUDIO_LANELESS: 'shared', STUDIO_IDLE_EXIT_MIN: '0', STUDIO_AUTO_FINISH: 'off', STUDIO_HEARTBEAT_SEC: '1',
    STUDIO_QUOTA_PROBE: 'off', STUDIO_POST_BROWSER_PLAY: 'off', STUDIO_LANE_INFER: 'off', STUDIO_REACHABILITY: 'off', STUDIO_NIM_CHECK: 'off', STUDIO_UPGRADE_WATCH_MIN: 'off',
    STUDIO_CREW_WATCH: 'off', STUDIO_STALL: 'off', STUDIO_LAUNCH_LOCK_SEC: '1', STUDIO_OVERLAP: 'off', STUDIO_CPU_PROBE: 'off', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_TRAIN_DETACH: 'off',
    STUDIO_UPGRADE_REFRESH: 'off', STUDIO_DONE_GAME_GATES: 'skip',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-284q-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '', npm_config_node_options: '',
  };
  const T = path.join(tmpRoot, `s284q-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });

  // ---- the studio: owner key, beta mode naming overseer-1, signer-1 in the main checkout's .env, the commit-msg hook ----
  const S = path.join(tmpRoot, `284q-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', '.env', 'studio/beta.json', 'studio/delegation.json', 'studio/approvals', 'studio/keys', 'studio/task-holds.json', 'studio/asks', 'studio/review.json', 'studio/mode.json', 'studio/engine', 'studio/allowlist.json', 'studio/policy.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch { /* the checks need no package */ } }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(KEY, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  write(S, 'studio/keys/owner-ed25519.pub.pem', publicKey.export({ type: 'spki', format: 'pem' }));
  const BETA_ON = { on: true, by: 'pat', at: '2026-11-05T01:00:00.000Z', why: 'beta for the selftest', agents: ['overseer-1'], roles: ['producer', 'director'] };
  write(S, 'studio/beta.json', `${JSON.stringify(BETA_ON, null, 2)}\n`);
  write(S, '.gitignore', `${fs.existsSync(path.join(dir, '.gitignore')) ? fs.readFileSync(path.join(dir, '.gitignore'), 'utf8') : ''}\n/.lanes/\n/.studio/\n.env\n`);
  write(S, '.env', 'STUDIO_OUTSIDE_SIGNERS=signer-1\n');
  const ev = path.join(S, '.studio', 'events-284q.jsonl');
  fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
  g(S, 'init', '-q', '-b', 'main'); g(S, 'config', 'core.autocrlf', 'false'); g(S, 'config', 'core.eol', 'lf'); g(S, 'config', 'user.name', 't'); g(S, 'config', 'user.email', 't@example.invalid');
  g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio, owner key, beta on', '--no-verify');
  fs.mkdirSync(path.join(T, 'hooks'), { recursive: true });
  fs.copyFileSync(path.join(S, 'scripts', 'hooks', 'commit-msg'), path.join(T, 'hooks', 'commit-msg'));
  try { fs.chmodSync(path.join(T, 'hooks', 'commit-msg'), 0o755); } catch { /* Windows: git runs it with its own bash */ }
  g(S, 'config', 'core.hooksPath', fwd(path.join(T, 'hooks')));
  const env = { ...process.env, ...base, AGENT_EVENTS_FILE: ev, STUDIO_MAIN_ROOT: S };
  const cli = (actor, args, extra = {}) => spawnSync(process.execPath, args, { windowsHide: true, cwd: S, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240000, env: { ...env, ...actor, ...extra } });
  const events = () => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
  const uses = (kind, who = null) => events().filter((e) => e.type === 'beta.use' && e.meta?.kind === kind && (!who || e.agent === who));
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  let pn = 0;
  const probe = (code, actor = {}) => {
    const f = path.join(S, `.probe-284q-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = cli(actor, [f]);
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(l), _out: out(r).slice(-1200) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };
  // A commit as an agent: the studio's hook writes the Studio-Agent trailer from STUDIO_LOCK_OWNER.
  const commitAs = (who, msg, ...files) => {
    g(S, 'add', '--', ...files);
    return spawnSync('git', ['commit', '-qm', msg, '--', ...files], { windowsHide: true, cwd: S, encoding: 'utf8', env: gEnv({ ...base, STUDIO_LOCK_OWNER: who, STUDIO_MAIN_ROOT: S }), stdio: ['ignore', 'pipe', 'pipe'] });
  };

  const OWNER = {}; // a person's own terminal
  const OVER = { CLAUDECODE: '1', STUDIO_LOCK_OWNER: 'overseer-1' }; // the beta-mode named agent
  const SIGNER = { AI_AGENT: '1' }; // an outside signer's shell: a coding agent's, naming nobody (--by signer-1)
  const PROD = { STUDIO_ROLE: 'producer', STUDIO_LOCK_OWNER: 'producer-q1' };
  const WORK = { STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-q1', STUDIO_TASK_PIN: 'T-999' };
  const PINNED = { CLAUDECODE: '1', STUDIO_TASK_PIN: 'T-998' }; // a pinned session that tries --by overseer-1
  const ACTORS = { overseer: OVER, signer: SIGNER, producer: PROD, worker: WORK, pinned: PINNED };
  const byName = { overseer: 'overseer-1', signer: 'signer-1', producer: 'producer-q1', worker: 'builder-q1', pinned: 'overseer-1' };
  const addTask = (title, extra = []) => (out(cli(OWNER, ['harness/task.mjs', 'add', title, '--role', 'builder', '--priority', 'P1', ...extra])).match(/\b(T-\d+)\b/) || [])[1];
  const mainSha = () => g(S, 'rev-parse', 'HEAD').stdout.trim();
  const setupOk = g(S, 'rev-parse', 'HEAD').status === 0 && fs.existsSync(path.join(S, 'studio', 'beta.json'));
  report('2.84 (q) setup: a studio with an owner key, beta mode naming overseer-1 and signer-1 in the main checkout\'s .env', setupOk, '');

  // ---- f. the one rule: standInMay(kind, { by, env, root }) ----
  {
    const ask = (kind, actor, by) => probe(`const bm = await import(${u('harness/beta-mode.mjs')}); const pm = await import(${u('harness/permission.mjs')});
const r = bm.standInMay(${JSON.stringify(kind)}, { by: ${JSON.stringify(by)}, root: ${JSON.stringify(S)} });
console.log(JSON.stringify({ ok: r.ok, via: r.via, why: r.why, same: pm.standInMay === bm.standInMay }));`, actor);
    const kinds = ['release', 'force', 'protected', 'unpark', 'crew-resume', 'engine-train'];
    const res = {};
    for (const k of kinds) res[k] = { overseer: ask(k, OVER, 'overseer-1'), signer: ask(k, SIGNER, 'signer-1'), producer: ask(k, PROD, 'producer-q1'), worker: ask(k, WORK, 'builder-q1'), pinned: ask(k, PINNED, 'overseer-1'), stranger: ask(k, { CLAUDECODE: '1' }, 'someone-else') };
    const money = { overseer: ask('money', OVER, 'overseer-1'), signer: ask('money', SIGNER, 'signer-1'), betaOff: ask('beta-off', OVER, 'overseer-1') };
    await guard('2.84 (q) standInMay(kind, { by, env, root }), the one rule for release, force, protected, unpark, crew-resume and engine-train: the overseer (via "beta agent") and the signer (via "signer", its --by in a shell naming nobody, AI_AGENT set) may; a launched Producer session, a worker session, a pinned session saying --by overseer-1 and a name beta mode doesn\'t list may not; real money and turning beta mode off stay refused (fails before this fix: there was no such function, each command had its own rule)', () => [
      kinds.every((k) => res[k].overseer.ok && res[k].overseer.via === 'beta agent' && res[k].overseer.same && res[k].signer.ok && res[k].signer.via === 'signer' && !res[k].producer.ok && !res[k].worker.ok && !res[k].pinned.ok && !res[k].stranger.ok)
        && !money.overseer.ok && /owner's own/.test(money.overseer.why) && !money.signer.ok && !money.betaOff.ok, JSON.stringify({ res, money })]);
  }

  // ---- a. train release <ID> of a tier-C lane ----
  {
    const res = {};
    for (const [who, a] of Object.entries(ACTORS)) {
      const id = addTask(`Release the ${who} lane`);
      probe(`const tr = await import(${u('harness/train.mjs')});
tr.holdLane(${JSON.stringify(S)}, { task: ${JSON.stringify(id)}, agent: 'builder-q7', dir: ${JSON.stringify(S)}, branch: 'feat/${id.toLowerCase()}', head: ${JSON.stringify(mainSha())} }, { tier: 'C', why: 'protected files: studio/game.json' });
console.log(JSON.stringify({ ok: true }));`);
      const r = cli(a, ['harness/task.mjs', 'train', 'release', id, '--by', byName[who]]);
      const e = (readJson(path.join(S, '.studio', 'train', 'queue.json')) || []).find((x) => x.task === id);
      res[who] = { r: tail(r, 260), released: e?.released ? (e.released.recordedBy || e.released.by) : null, use: uses('release').filter((x) => x.task === id).map((x) => x.meta) };
    }
    await guard('2.84 (q) a. `task train release <ID> --by <name>` of a tier-C lane, no --permission, no owner key: the overseer (CLAUDECODE set) and the signer (AI_AGENT set, --by signer-1) release it, each a beta.use event { kind: release, via }; a worker session and a pinned session are refused and the lane stays held; a Producer session gets no stand-in power (no beta.use by it) (the release itself worked before; fails before this fix: it was logged only as delegation.used, with no beta.use, and a pinned session with no STUDIO_ROLE could name itself overseer-1 with --by and release)', () => [
      res.overseer.released === 'overseer-1' && res.overseer.use.some((m) => m.via === 'beta agent' && m.by === 'overseer-1')
        && res.signer.released === 'signer-1' && res.signer.use.some((m) => m.via === 'signer' && m.by === 'signer-1')
        && !res.worker.released && !res.pinned.released && !res.producer.use.length, JSON.stringify(res)]);
  }

  // ---- b. a force approval, then task done --force, and --force --train ----
  {
    const res = {};
    for (const who of ['overseer', 'signer']) {
      const a = ACTORS[who];
      const id = addTask(`Force the ${who} task`);
      const ap = cli(a, ['harness/approve.mjs', 'force', id, '--reason', `${who} closes it: the check needs a reviewer nobody can reach`, '--by', byName[who]]);
      const f = `studio/approvals/force-${id}.json`;
      const made = fs.existsSync(path.join(S, f));
      if (made) commitAs(byName[who], `approve force ${id}`, f);
      const d = cli(a, ['harness/task.mjs', 'done', id, '--force', '--agent', byName[who]]);
      const done = /\bdone\b/i.test(fs.readFileSync(path.join(S, 'studio', 'DONE.md'), 'utf8').split('\n').find((l) => l.includes(id)) || '') || fs.readFileSync(path.join(S, 'studio', 'DONE.md'), 'utf8').includes(id);
      // --force --train with the approval: no longer "don't go together" (in the main checkout the train says it lands lane copies).
      const id2 = addTask(`Force-train the ${who} task`);
      cli(a, ['harness/approve.mjs', 'force', id2, '--reason', `${who} lands it through the train without the review`, '--by', byName[who]]);
      if (fs.existsSync(path.join(S, `studio/approvals/force-${id2}.json`))) commitAs(byName[who], `approve force ${id2}`, `studio/approvals/force-${id2}.json`);
      const ft = cli(a, ['harness/task.mjs', 'done', id2, '--force', '--train', '--agent', byName[who]]);
      const id3 = addTask(`Force-train without approval ${who}`);
      const ft3 = cli(a, ['harness/task.mjs', 'done', id3, '--force', '--train', '--reason', 'no approval for this one at all', '--agent', byName[who]]);
      res[who] = { ap: tail(ap, 200), made, d: tail(d, 300), done, ft: tail(ft, 300), ft3: tail(ft3, 300), use: uses('force', byName[who]).map((x) => x.meta) };
    }
    const w = addTask('Force by a worker');
    const wa = cli(WORK, ['harness/approve.mjs', 'force', w, '--reason', 'a worker tries to approve its own force', '--by', 'builder-q1']);
    const pa = cli(PROD, ['harness/approve.mjs', 'force', w, '--reason', 'a producer tries to approve a force', '--by', 'producer-q1']);
    const ok = (x) => x.made && x.done && x.use.length >= 1 && !/don't go together/.test(x.ft) && /lands lane copies/.test(x.ft) && /don't go together|owner's approval/.test(x.ft3);
    await guard('2.84 (q) b. `approve -- force <ID> --by <name>` then `task done <ID> --force`, and `--force --train`: the overseer and the signer record the force approval (beta.use { kind: force }), the done closes the task, and `--force --train` with that approval is no longer refused (it goes on to the train\'s lane check), while `--force --train` with no approval is still refused; a worker\'s and a Producer\'s force approval are refused (the approval and the plain forced done worked before; fails before this fix: `--force` and `--train` never went together, the T-662 deadlock, and the approval left no beta.use)', () => [
      ok(res.overseer) && ok(res.signer) && wa.status !== 0 && pa.status !== 0 && !fs.existsSync(path.join(S, `studio/approvals/force-${w}.json`)), JSON.stringify({ res, wa: tail(wa), pa: tail(pa) })]);

    // The train's lane check of a forced lane passes --force (a stand-in lane harness that prints what it was given).
    const L = path.join(T, 'fake-lane');
    write(L, 'harness/task.mjs', `// flags['train-check']\nconsole.log(JSON.stringify({ train: 'check', ok: true, argv: process.argv.slice(2) }));\n`);
    const pc = probe(`const tr = await import(${u('harness/train.mjs')});
const a = tr.precheckChild(${JSON.stringify(S)}, { task: 'T-1', agent: 'builder-q7', dir: ${JSON.stringify(L)}, forced: { by: 'overseer-1', file: 'studio/approvals/force-T-1.json' } });
const b = tr.precheckChild(${JSON.stringify(S)}, { task: 'T-1', agent: 'builder-q7', dir: ${JSON.stringify(L)} });
console.log(JSON.stringify({ a: a.argv, b: b.argv }));`);
    await guard('2.84 (q) b. the merge train checks a lane queued with --force --train as forced: its lane check runs `task done <ID> --train-check --force` (the approval is checked again there), and an unforced lane without --force (fails before this fix: the queue entry had no forced mark and the check never passed --force)', () => [
      Array.isArray(pc.a) && pc.a.includes('--force') && pc.a.includes('--train-check') && Array.isArray(pc.b) && !pc.b.includes('--force'), JSON.stringify(pc)]);
  }

  // ---- c. protected-file approvals, their own change included ----
  {
    const res = {};
    for (const [who, file] of [['overseer', 'studio/gates.json'], ['signer', 'studio/bible/controls.json']]) {
      g(S, 'checkout', '-q', 'main');
      g(S, 'checkout', '-q', '-B', `feat/self-${who}`);
      const j = readJson(path.join(S, file)) || {};
      j.selftestMark = `${who} changed this`;
      write(S, file, `${JSON.stringify(j, null, 2)}\n`);
      const c = commitAs(byName[who], `${who} changes ${file}`, file);
      const before = cli(OWNER, ['qa/protected-check.mjs']);
      const n0 = events().length;
      const made = cli(ACTORS[who], ['harness/approve.mjs', 'protected', '--note', `${who} approves its own change to ${file}`, '--by', byName[who]]);
      const af = (fs.existsSync(path.join(S, 'studio', 'approvals')) ? fs.readdirSync(path.join(S, 'studio', 'approvals')) : []).filter((f) => f.startsWith('protected-')).find((f) => (readJson(path.join(S, 'studio', 'approvals', f))?.approval?.files || []).some((x) => x.path === file));
      const doc = af ? readJson(path.join(S, 'studio', 'approvals', af)) : null;
      if (af) commitAs(byName[who], 'approval', `studio/approvals/${af}`);
      const check = cli(OWNER, ['qa/protected-check.mjs']);
      const use = events().slice(n0).filter((e) => e.type === 'beta.use' && e.meta?.kind === 'protected');
      res[who] = { commit: tail(c, 120), before: before.status, made: tail(made, 300), self: doc?.approval?.self === true, recordedBy: doc?.approval?.recordedBy || null, check: tail(check, 300), use: use.map((e) => ({ agent: e.agent, msg: e.msg, meta: e.meta })) };
    }
    g(S, 'checkout', '-q', 'main');
    const okC = (w, via) => res[w].before !== 0 && res[w].self && res[w].recordedBy === byName[w] && /PASS/.test(res[w].check) && res[w].use.some((e) => e.meta.self === true && e.meta.via === via && /approved its own change to/.test(e.msg));
    // A worker and a Producer (no STUDIO_PRODUCER_APPROVES=protected) are still refused.
    g(S, 'checkout', '-q', '-B', 'feat/worker-prot');
    const j = readJson(path.join(S, 'studio', 'gates.json')) || {}; j.workerMark = 1; write(S, 'studio/gates.json', `${JSON.stringify(j, null, 2)}\n`);
    commitAs('builder-q1', 'worker changes gates', 'studio/gates.json');
    const wr = cli(WORK, ['harness/approve.mjs', 'protected', '--note', 'a worker approves its own gates change', '--by', 'builder-q1']);
    const pr = cli(PROD, ['harness/approve.mjs', 'protected', '--note', 'a producer approves the gates change', '--by', 'producer-q1']);
    const after = cli(OWNER, ['qa/protected-check.mjs']);
    g(S, 'checkout', '-q', '-f', 'main');
    await guard('2.84 (q) c. `approve -- protected --by <name>` of a change that same agent committed (Studio-Agent trailer): the overseer and the signer approve their own change, the approval is marked self: true, qa/protected-check.mjs passes once it is committed, and a beta.use event { kind: protected, self: true } says "approved its own change to <file>"; a worker and a Producer session (owner\'s switch off) are refused and the check still fails (the approval itself counted before; fails before this fix: a self-approval was not marked and left no beta.use)', () => [
      okC('overseer', 'beta agent') && okC('signer', 'signer') && wr.status !== 0 && pr.status !== 0 && after.status !== 0, JSON.stringify({ res, wr: tail(wr), pr: tail(pr), after: tail(after) })]);
  }

  // ---- d. unpark at any rank (2.84 n: guard that it is the same rule) ----
  {
    const res = {};
    for (const who of ['overseer', 'signer', 'worker', 'pinned']) {
      const id = addTask(`Unpark ${who}`);
      const holds = readJson(path.join(S, 'studio', 'task-holds.json')) || { tasks: {} };
      holds.tasks = { ...(holds.tasks || {}), [id]: { parked: { by: 'harness', why: 'its step is the owner\'s', reason: 'owner-only', at: new Date().toISOString(), rank: 3, byRole: 'orchestrator', ownerOnly: true } } };
      write(S, 'studio/task-holds.json', JSON.stringify(holds));
      const r = cli(ACTORS[who], ['harness/task.mjs', 'unpark', id, '--by', byName[who]]);
      res[who] = { r: tail(r, 200), parked: Boolean(readJson(path.join(S, 'studio', 'task-holds.json'))?.tasks?.[id]?.parked), use: uses('unpark').filter((x) => x.task === id).map((x) => x.meta) };
    }
    await guard('2.84 (q) d. `task unpark <ID> --by <name>` of a task the harness parked for an owner-only step (rank 3): the overseer and the signer (a shell naming nobody, --by signer-1) unpark it, each a beta.use { kind: unpark }; a worker session and a pinned session saying --by overseer-1 are refused (the unpark itself worked before, from 2.84 n; fails before this fix: no beta.use was written)', () => [
      !res.overseer.parked && res.overseer.use.some((m) => m.via === 'beta agent') && !res.signer.parked && res.signer.use.some((m) => m.via === 'signer') && res.worker.parked && res.pinned.parked, JSON.stringify(res)]);
  }

  // ---- e. crew resume <role> --by <name> without --permission ----
  {
    const res = {};
    for (const [who, a] of Object.entries(ACTORS)) {
      write(S, '.studio/crew-paused.json', JSON.stringify({ roles: { builder: { at: new Date().toISOString(), why: 'no landings in an hour' } }, since: {} }));
      fs.rmSync(path.join(S, '.studio', 'crew-resume.json'), { force: true });
      const r = cli(a, ['harness/crew-watch.mjs', 'resume', 'builder', '--by', byName[who], '--why', 'the owner is away; the work is unblocked']);
      const ask = readJson(path.join(S, '.studio', 'crew-resume.json'))?.builder || null;
      res[who] = { r: tail(r, 260), by: ask?.by || null, via: ask?.via || null, use: uses('crew-resume', byName[who]).map((x) => x.meta) };
    }
    await guard('2.84 (q) e. `crew -- resume builder --by <name>` without --permission: the overseer and the signer ask the supervisor to launch the role again (recorded with via beta agent / signer, a beta.use { kind: crew-resume }); a worker session and a pinned session are refused (the resume itself worked before; fails before this fix: it was recorded via "delegation" with no beta.use, and a pinned session with no STUDIO_ROLE could name itself overseer-1 with --by and resume)', () => [
      res.overseer.by === 'overseer-1' && res.overseer.via === 'beta agent' && res.overseer.use.length >= 1 && res.signer.by === 'signer-1' && res.signer.via === 'signer' && res.signer.use.length >= 1 && !res.worker.by && !res.pinned.by, JSON.stringify(res)]);
  }

  // ---- g. review same-family (guard: the signer in a shell that names nobody) ----
  {
    fs.rmSync(path.join(S, 'studio', 'review.json'), { force: true });
    const r = cli(SIGNER, ['harness/review.mjs', 'same-family', 'off', '--by', 'signer-1', '--why', 'beta: back to the default']);
    const j = readJson(path.join(S, 'studio', 'review.json'));
    const w = cli(WORK, ['harness/review.mjs', 'same-family', 'on', '--by', 'builder-q1', '--why', 'a worker tries it']);
    fs.rmSync(path.join(S, 'studio', 'review.json'), { force: true });
    await guard('2.84 (q) g. `review -- same-family off --by signer-1` from a coding agent\'s shell that names nobody (guard): the signer sets it, recorded as signer-1; a worker session is refused', () => [
      r.status === 0 && j?.by === 'signer-1' && w.status !== 0, JSON.stringify({ r: tail(r), j, w: tail(w) })]);
  }

  // ---- the digest shows the uses, self-approvals in plain words ----
  {
    const d = probe(`const bm = await import(${u('harness/beta-mode.mjs')});
const fs = await import('node:fs');
const evs = fs.readFileSync(${JSON.stringify(ev)}, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l));
const lines = await bm.betaDigestLines({ events: evs, root: ${JSON.stringify(S)}, now: Date.now(), max: 200 });
console.log(JSON.stringify({ lines }));`);
    const L = (d.lines || []).join('\n');
    await guard('2.84 (q) the daily digest\'s beta section lists the stand-ins\' beta.use events (release, force, protected, crew-resume) and calls a self-approval out in plain words ("approved its own change to <file>") (fails before this fix: the digest read only delegation.used events)', () => [
      /overseer-1/.test(L) && /signer-1/.test(L) && /approved its own change to studio\/gates\.json/.test(L) && /SELF-APPROVED/.test(L) && /release/.test(L), L.slice(0, 3000) || JSON.stringify(d)]);
  }

  // ---- the upgrade keeps beta mode on ----
  {
    // A harness update whose ref deletes studio/beta.json (an upstream with no beta file of its own).
    g(S, 'checkout', '-q', '-B', 'upstream-284q', 'main');
    g(S, 'rm', '-q', '--', 'studio/beta.json');
    write(S, 'docs/UPSTREAM-284Q.md', 'an update\n');
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'upstream: an update', '--no-verify');
    g(S, 'checkout', '-q', '-f', 'main');
    const r = cli(OWNER, ['harness/upgrade-guard.mjs', '--merge', 'upstream-284q', '--by', 'pat']);
    const onAfter = (() => { const s = g(S, 'show', 'HEAD:studio/beta.json'); try { return JSON.parse(s.stdout).on === true; } catch { return false; } })();
    const merged = fs.existsSync(path.join(S, 'docs', 'UPSTREAM-284Q.md'));
    await guard('2.84 (q) upgrade: a harness update whose ref deletes studio/beta.json leaves beta mode on (the studio\'s own beta.json is kept) and the guard says "beta mode was on before the upgrade and is on after" (fails before this fix: the merge took the ref\'s side and beta mode went off with the update, unsaid)', () => [
      r.status === 0 && merged && onAfter && /beta mode was on before the upgrade and is on after/i.test(out(r)), tail(r, 1500)]);
  }

  // ---- beta mode off: every one refused as on main ----
  {
    write(S, 'studio/beta.json', `${JSON.stringify({ on: false, by: 'pat', at: '2026-11-06T01:00:00.000Z', why: 'beta over', agents: [], roles: [] }, null, 2)}\n`);
    g(S, 'add', '--', 'studio/beta.json'); g(S, 'commit', '-qm', 'beta off', '--no-verify');
    const res = {};
    for (const who of ['overseer', 'signer']) {
      const a = ACTORS[who];
      const id = addTask(`Off release ${who}`);
      probe(`const tr = await import(${u('harness/train.mjs')});
tr.holdLane(${JSON.stringify(S)}, { task: ${JSON.stringify(id)}, agent: 'builder-q7', dir: ${JSON.stringify(S)}, branch: 'feat/x', head: ${JSON.stringify(mainSha())} }, { tier: 'C', why: 'protected files' });
console.log('{}');`);
      const rel = cli(a, ['harness/task.mjs', 'train', 'release', id, '--by', byName[who]]);
      const released = Boolean((readJson(path.join(S, '.studio', 'train', 'queue.json')) || []).find((x) => x.task === id)?.released);
      const fa = cli(a, ['harness/approve.mjs', 'force', id, '--reason', 'beta is off, this must be refused', '--by', byName[who]]);
      write(S, '.studio/crew-paused.json', JSON.stringify({ roles: { builder: { at: new Date().toISOString(), why: 'x' } }, since: {} }));
      fs.rmSync(path.join(S, '.studio', 'crew-resume.json'), { force: true });
      const cr = cli(a, ['harness/crew-watch.mjs', 'resume', 'builder', '--by', byName[who]]);
      const sm = probe(`const bm = await import(${u('harness/beta-mode.mjs')}); console.log(JSON.stringify(bm.standInMay('release', { by: ${JSON.stringify(byName[who])}, root: ${JSON.stringify(S)} })));`, a);
      res[who] = { released, rel: tail(rel, 200), force: fa.status, forceFile: fs.existsSync(path.join(S, `studio/approvals/force-${id}.json`)), resumed: Boolean(readJson(path.join(S, '.studio', 'crew-resume.json'))?.builder), cr: tail(cr, 200), sm: { ok: sm.ok, why: sm.why } };
    }
    await guard('2.84 (q) beta mode off (studio/beta.json on: false): the overseer and the signer are refused a release, a force approval and a crew resume, and standInMay says beta mode is off', () => [
      ['overseer', 'signer'].every((w) => !res[w].released && res[w].force !== 0 && !res[w].forceFile && !res[w].resumed && res[w].sm.ok === false && /beta mode is off/.test(res[w].sm.why)), JSON.stringify(res)]);
  }
}
