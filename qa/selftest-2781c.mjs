/**
 * qa/selftest-2781c.mjs — 2.78.1 (c): the crew's day on 2.78.0 (B-120, grandfather, B-122, B-116, orphaned gate runs,
 * the "before a long run" preflight).
 *   B-120        on a main checkout that doesn't push, origin/main has no owner key: `approve -- hooks` never verified.
 *   grandfather  a release's own merge commits could not be grandfathered (git log --no-merges).
 *   B-122        a train started before an upgrade chain-started its successor in the same process.
 *   B-116        a re-check of main right after an upgrade, on the old harness, said "main itself fails its checks".
 *   orphans      a run-gates.mjs with no live parent ran for 13 h.
 *   preflight    `npm run upgrade -- --preflight` lists leftovers from earlier workarounds before a long run.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest2781C({ dir, run, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = path.join(harnessRoot, 'node_modules');
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const writeIn = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const base = { STUDIO_REFILL_WAKE: 'off', STUDIO_WATCHDOG: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_MAIN_ROOT: '', STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '', STUDIO_TASK_BASE: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '', CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', GITHUB_BASE_REF: '', GITHUB_EVENT_NAME: '', STUDIO_HARNESS_REF: '', STUDIO_KEY_BASE: '', STUDIO_GRANDFATHER_MERGES: '', STUDIO_TRAIN_HARNESS_GUARD: '', STUDIO_ORPHAN_GATE_MIN: '', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-2781c-${process.pid}.pem`) };
  let n = 0;
  const made = [];
  const studio = (name) => {
    const S = path.join(tmpRoot, `2781c-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    fs.rmSync(path.join(S, 'studio', 'approvals'), { recursive: true, force: true });
    fs.rmSync(path.join(S, 'studio', 'keys'), { recursive: true, force: true });
    fs.rmSync(path.join(S, '.env'), { force: true });
    const ev = path.join(S, '.studio', 'events-2781c.jsonl');
    writeIn(S, '.studio/events-2781c.jsonl', '');
    g(S, 'init', '-q', '-b', 'main'); g(S, 'config', 'core.autocrlf', 'false'); g(S, 'config', 'core.eol', 'lf');
    g(S, 'config', 'user.name', 't'); g(S, 'config', 'user.email', 't@example.invalid');
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
    made.push(S);
    return { S, env: { ...base, AGENT_EVENTS_FILE: ev }, ev };
  };
  const node = (S, args, env, opts = {}) => spawnSync(process.execPath, args, { windowsHide: true, cwd: S, encoding: 'utf8', env: { ...process.env, ...ident, ...env }, timeout: opts.timeout || 180000 });
  const probe = (S, code, env) => { const f = path.join(S, `.probe-2781c-${++n}.mjs`); fs.writeFileSync(f, code); const r = node(S, [f], env); const l = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop(); let j = null; try { j = JSON.parse(l); } catch {} return { ...r, j }; };
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  const events = (ev) => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const keyPair = (name) => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const priv = path.join(tmpRoot, `2781c-${name}-${process.pid}.pem`);
    fs.writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    return { pub: publicKey.export({ type: 'spki', format: 'pem' }), priv };
  };

  // ---- B-120: the hooks check on a main checkout whose origin/main never got the owner key ----
  {
    const { S, env } = studio('b120');
    g(S, 'update-ref', 'refs/remotes/origin/main', 'HEAD'); // pushes are off: origin/main stays here
    const owner = keyPair('owner');
    const other = keyPair('other');
    writeIn(S, 'studio/keys/owner-ed25519.pub.pem', owner.pub);
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'owner key', '--no-verify');
    writeIn(S, 'docs/b120-note.md', '# a commit made without the hooks\n');
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'board: snapshot', '--no-verify');
    const e = { ...env, STUDIO_HOOKS_CHECK: 'on' };
    const check = () => node(S, ['harness/hook-stamp.mjs', 'check'], e);
    const before = check();
    const forged = node(S, ['harness/approve.mjs', 'hooks', '--note', 'not the owner: another key signs this', '--by', 'pat'], { ...e, STUDIO_OWNER_KEY: other.priv });
    const withForged = check();
    for (const f of fs.readdirSync(path.join(S, 'studio', 'approvals'))) fs.rmSync(path.join(S, 'studio', 'approvals', f));
    const appr = node(S, ['harness/approve.mjs', 'hooks', '--note', 'the owner accepts the two unhooked commits on main', '--by', 'pat'], { ...e, STUDIO_OWNER_KEY: owner.priv });
    const after = check();
    const off = node(S, ['harness/hook-stamp.mjs', 'check'], { ...e, STUDIO_KEY_BASE: 'off' });
    await guard('2.78.1 (B-120): on a main checkout whose origin/main lags local main and has no owner key (pushes off), the hooks check lists the 2 unhooked commits since origin/main; the owner\'s `approve -- hooks` then verifies with the key-carrying base (local main\'s committed key) and the check passes, saying so; an approval signed with another key still fails, and STUDIO_KEY_BASE=off keeps the old reading (fails on 2.78.0: the approval was read with origin/main\'s key, which is none, so the check stayed red after the owner approved)', () => [
      before.status === 1 && /2 commit\(s\) since origin\/main skipped the git hooks/.test(out(before))
        && forged.status === 0 && withForged.status === 1
        && appr.status === 0 && after.status === 0 && /2 approved by the owner; the owner's approvals verified with main [0-9a-f]{8}'s key \(origin\/main has none/.test(out(after))
        && off.status === 1,
      JSON.stringify({ before: out(before).slice(-400), forged: out(forged).slice(-200), withForged: out(withForged).slice(-200), appr: out(appr).slice(-300), after: out(after).slice(-400), off: out(off).slice(-200) })]);
  }

  // ---- grandfather: a release's own merge commits ----
  {
    const { S, env } = studio('gf');
    g(S, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    // The release, made elsewhere without this studio's hooks: two commits and the merges that joined them.
    g(S, 'checkout', '-q', '-b', 'rel');
    writeIn(S, 'docs/rel-a.md', '# release a\n'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'release: a', '--no-verify');
    g(S, 'checkout', '-q', '-b', 'side', 'main');
    writeIn(S, 'docs/rel-b.md', '# release b\n'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'release: b', '--no-verify');
    g(S, 'checkout', '-q', 'rel');
    const m1 = g(S, 'merge', '-q', '--no-ff', '--no-verify', '-m', 'Merge 2.77.3 into claude/278', 'side');
    g(S, 'update-ref', 'refs/remotes/origin/claude/278', 'rel');
    g(S, 'checkout', '-q', 'main');
    g(S, 'merge', '-q', '--ff-only', 'rel');
    const e = { ...env, STUDIO_HOOKS_CHECK: 'on' };
    const before = node(S, ['harness/hook-stamp.mjs', 'check', '--json'], e);
    const gf = node(S, ['harness/hook-stamp.mjs', 'grandfather', '--ref', 'origin/claude/278'], e);
    const after = node(S, ['harness/hook-stamp.mjs', 'check', '--json'], e);
    // The studio's own merge made later, without the hooks, is still judged: only the release's merges are listed.
    g(S, 'checkout', '-q', '-b', 'mine', 'main');
    writeIn(S, 'docs/mine.md', '# mine\n'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'mine: work', '--no-verify');
    g(S, 'checkout', '-q', 'main');
    g(S, 'merge', '-q', '--no-ff', '--no-verify', '-m', 'Merge mine', 'mine');
    const later = node(S, ['harness/hook-stamp.mjs', 'check', '--json'], e);
    const j = (r) => { try { return JSON.parse(String(r.stdout || '').trim().split('\n').pop()); } catch { return null; } };
    const jb = j(before); const ja = j(after); const jl = j(later);
    const mineMerge = g(S, 'rev-parse', 'HEAD').stdout.trim();
    const mineWork = g(S, 'rev-parse', 'mine').stdout.trim();
    await guard('2.78.1 (grandfather): `grandfather --ref <release ref>` lists the release\'s own merge commit too ("Merge 2.77.3 into claude/278"), so the hooks check on main is green after taking it; a merge the studio makes later without the hooks is still judged, and only it and its own commit are listed (fails on 2.78.0: git log --no-merges, so the release\'s merge stayed red)', () => [
      m1.status === 0 && jb?.ok === false && jb.open.length === 3 && jb.open.some((o) => o.merge)
        && gf.status === 0 && /1 of them the update's own merge commits/.test(out(gf))
        && ja?.ok === true && ja.open.length === 0
        && jl?.ok === false && jl.open.length === 2 && jl.open.map((o) => o.sha).sort().join(',') === [mineMerge, mineWork].sort().join(','),
      JSON.stringify({ before: jb && { ok: jb.ok, open: jb.open.map((o) => o.subject) }, gf: out(gf).slice(-300), after: ja && { ok: ja.ok, why: ja.why, open: ja.open.map((o) => o.subject) }, later: jl && jl.open.map((o) => o.subject), raw: out(after).slice(-300) })]);
  }

  // ---- orphaned gate runs: the supervisor's reaper ends a parentless run-gates.mjs past the limit ----
  {
    const { S, env } = studio('orphan');
    const fake = path.join(tmpRoot, `2781c-gates-${process.pid}`, 'scripts', 'run-gates.mjs');
    writeIn(path.dirname(fake), 'run-gates.mjs', 'setInterval(() => {}, 1000);\n');
    // A parentless one: started by a hop that exits at once (as a crashed task done would leave it).
    const hop = path.join(tmpRoot, `2781c-hop-${process.pid}.mjs`);
    fs.writeFileSync(hop, `import { spawn } from 'node:child_process';\nconst c = spawn(process.execPath, [${JSON.stringify(fake)}, '--only', 'protected'], { detached: true, stdio: 'ignore', windowsHide: true });\nc.unref();\nconsole.log(c.pid);\n`);
    const h = spawnSync(process.execPath, [hop], { encoding: 'utf8', windowsHide: true });
    const orphanPid = Number(String(h.stdout || '').trim());
    // One started through a shell (cmd.exe on Windows waits for it, so its parent is that live shell) by a hop that exits.
    const hop2 = path.join(tmpRoot, `2781c-hop2-${process.pid}.mjs`);
    fs.writeFileSync(hop2, `import { spawn } from 'node:child_process';\nconst c = spawn(${JSON.stringify(`"${process.execPath}" "${fake}" --only game`)}, { shell: true, detached: true, stdio: 'ignore', windowsHide: true });\nc.unref();\n`);
    spawnSync(process.execPath, [hop2], { encoding: 'utf8', windowsHide: true });
    // One whose parent is alive (this test's own child): never ended.
    const kept = spawn(process.execPath, [fake, '--only', 'hooks'], { stdio: 'ignore', windowsHide: true });
    await new Promise((r) => setTimeout(r, 2500));
    // A killed orphan can stay a zombie until its new parent reaps it (some container inits never do): that is gone.
    const zombie = (pid) => { try { return /^\S+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; } };
    const alive = (pid) => { try { process.kill(pid, 0); return !zombie(pid); } catch { return false; } };
    // Only this test's processes (and their parents) are shown to the reaper: other runs on this machine are never touched.
    const r = probe(S, `import { reapOrphanGates } from ${u(S, 'harness/gate-reaper.mjs')};
import { listProcesses, processArgs } from ${u(S, 'harness/proc-identity.mjs')};
// Only this test's fake gate runs (by their folder) and their ancestors are shown to the reaper.
const all = listProcesses();
const byPid = new Map(all.map((p) => [Number(p.pid), p]));
const args = processArgs(all.map((p) => p.pid));
const mine = new Set();
for (const p of all) if (String(args[p.pid] || '').includes(${JSON.stringify(path.dirname(fake))})) for (let q = p, i = 0; q && i < 20; q = byPid.get(Number(q.ppid)), i += 1) mine.add(Number(q.pid));
const listProcs = () => listProcesses().filter((p) => mine.has(Number(p.pid)));
const shellRun = all.find((p) => / --only game/.test(String(args[p.pid] || '')) && /^node/i.test(String(p.cmd || '')));
const res = await reapOrphanGates({ force: true, env: { ...process.env, STUDIO_ORPHAN_GATE_MIN: '0.02' }, deps: { listProcs } });
const young = await reapOrphanGates({ force: true, env: { ...process.env, STUDIO_ORPHAN_GATE_MIN: '600' }, deps: { listProcs } });
console.log(JSON.stringify({ ended: res.ended.map((e) => ({ pid: e.pid, why: e.why })), why: res.why, young: young.ended.length, shellRun: shellRun ? Number(shellRun.pid) : null }));
`, env);
    await new Promise((res) => setTimeout(res, 500));
    const orphanAlive = alive(orphanPid);
    const shellAlive = r.j?.shellRun ? alive(r.j.shellRun) : true;
    if (r.j?.shellRun) { try { process.kill(r.j.shellRun, 'SIGKILL'); } catch {} }
    const keptAlive = alive(kept.pid);
    const evOk = events(env.AGENT_EVENTS_FILE).some((x) => x.type === 'gate.orphan_ended' && x.meta?.pid === orphanPid);
    try { process.kill(orphanPid, 'SIGKILL'); } catch {}
    try { kept.kill('SIGKILL'); } catch {}
    await guard('2.78.1 (orphans): the supervisor\'s gate reaper ends a run-gates.mjs whose parent is gone once it is older than STUDIO_ORPHAN_GATE_MIN (a gate.orphan_ended event names it and why), also one started through a shell whose own parent is gone, leaves one whose parent is alive, and leaves a young orphan alone (fails on 2.78.0: nothing ended a parentless gate run; it ran 13 h)', () => [
      orphanPid > 0 && r.j && r.j.ended.some((x) => x.pid === orphanPid) && !r.j.ended.some((x) => x.pid === kept.pid) && r.j.young === 0 && !orphanAlive && keptAlive && evOk
        && r.j.shellRun && r.j.ended.some((x) => x.pid === r.j.shellRun) && !shellAlive,
      JSON.stringify({ orphanPid, kept: kept.pid, j: r.j, orphanAlive, keptAlive, shellAlive, evOk, out: out(r).slice(-500) })]);
  }

  // ---- the preflight's "before a long run" section ----
  {
    const { S, env } = studio('pre');
    writeIn(S, '.env', 'STUDIO_STALL_RATIO=0\nSTUDIO_HEAVY_SLOTS=3\nSTUDIO_TRAIN_BATCH=4\n');
    const add = node(S, ['harness/task.mjs', 'add', 'Rework the arrivals board', '--role', 'builder'], env);
    const id = (out(add).match(/"id":\s*"([A-Z]+-\d+)"/) || [])[1];
    const scoped = node(S, ['harness/task.mjs', 'add', 'Scoped thing', '--role', 'builder', '--lane', 'docs'], env);
    const sid = (out(scoped).match(/"id":\s*"([A-Z]+-\d+)"/) || [])[1];
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'board', '--no-verify');
    fs.appendFileSync(path.join(S, 'harness', 'agy-stream.mjs'), '\n// a local patch\n');
    // A train still running from before the harness last changed (its process alive; another harness tree on record).
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    writeIn(S, '.studio/train/20261104-160000-1/life.json', `${JSON.stringify({ id: '20261104-160000-1', pid: sleeper.pid, by: 'train-daemon', at: '2026-11-04T16:00:00.000Z', lanes: [], ended: null, harness: { version: '2.77.2', tree: 'abc+def' } })}\n`);
    const r = node(S, ['harness/upgrade-guard.mjs', '--preflight', '--json'], env);
    try { sleeper.kill('SIGKILL'); } catch {}
    let j = null; try { j = JSON.parse(r.stdout); } catch {}
    const items = j?.items || [];
    const lr = items.filter((i) => /^long-run\//.test(i.id));
    const envW = lr.filter((i) => i.id === 'long-run/env' && i.status === 'WARN').map((i) => i.detail).join('\n');
    const lanes = lr.find((i) => i.id === 'long-run/lanes');
    const harn = lr.find((i) => i.id === 'long-run/harness');
    const runs = lr.find((i) => i.id === 'long-run/runs');
    const fails = items.filter((i) => i.status === 'FAIL').length;
    await guard('2.78.1 (preflight): `npm run upgrade -- --preflight` has a "before a long run" section that warns about .env workarounds a release since made unnecessary (STUDIO_STALL_RATIO=0, STUDIO_HEAVY_SLOTS, from harness/upgrade-leftovers.json; other keys not), a ready builder task with no lane (not the one with a lane), an uncommitted change in harness/, and a train still running from before the harness changed; WARN only, so the exit code is the existing items\' (fails on 2.78.0: there was no such section)', () => [
      id && sid && lr.length >= 4 && lr.every((i) => i.status !== 'FAIL')
        && /STUDIO_STALL_RATIO=0 in \.env, a workaround 2\.77\.3 made unnecessary/.test(envW) && /STUDIO_HEAVY_SLOTS is set in \.env/.test(envW) && !/STUDIO_TRAIN_BATCH/.test(envW) && !/=3/.test(envW)
        && lanes?.status === 'WARN' && lanes.detail.includes(id) && !lanes.detail.includes(sid)
        && harn?.status === 'WARN' && /harness\/agy-stream\.mjs/.test(harn.detail)
        && runs?.status === 'WARN' && /train 20261104-160000-1 .*harness 2\.77\.2/.test(runs.detail)
        && r.status === (fails ? 1 : 0),
      JSON.stringify({ lr, fails, status: r.status, err: String(r.stderr || '').slice(-300), add: out(add).slice(-200) })]);
  }

  // ---- B-122 and B-116: a train that runs across a harness update ----
  {
    const { S, env: e0, ev } = studio('train');
    const env = { ...e0, STUDIO_VISUAL_GATE: 'off', STUDIO_GAME: 'demo', STUDIO_REACHABILITY: 'off', STUDIO_DONE_NOOP: 'allow', STUDIO_DONE_REUSE_VERIFY: '', STUDIO_GATE_INCOMING_FILE: '', STUDIO_GATE_PRIORITY: '', STUDIO_GATE_CHANGED: '', STUDIO_GATE_PATHS: '', STUDIO_TRAIN: '', STUDIO_TRAIN_BISECT: '', STUDIO_TRAIN_PIPELINE: 'off', STUDIO_TRAIN_AUTO: 'off', STUDIO_TRAIN_MIN: '', STUDIO_HOOKS_CHECK: 'on', STUDIO_LANE_LIVE_MIN: '0', STUDIO_COMPACT_OUTPUT: '', STUDIO_GAME_GATE_RETRY: '', STUDIO_LANDING_BUILD: 'off', ...ident };
    const mark = path.join(tmpRoot, `2781c-upgraded-${process.pid}`);
    const arm = path.join(tmpRoot, `2781c-arm-${process.pid}`);
    writeIn(S, 'studio/gates.json', `${JSON.stringify({ gates: [
      { id: 'protected', command: 'node qa/protected-check.mjs', required: true, lite: true },
      { id: 'hooks', command: 'node harness/hook-stamp.mjs check', required: true, lite: true, cache: false },
      { id: 'game', command: 'node harness/game-gates.mjs', required: true, lite: true, cache: false },
    ] }, null, 2)}\n`);
    writeIn(S, 'game/demo/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'check', command: 'node game/demo/check.mjs' }] }, null, 2)}\n`);
    // The game's check, run in the train's copy. While armed, the first run also "takes a harness update" on the main
    // checkout (a commit there that bumps the harness version), as an owner merging a release mid-train would.
    writeIn(S, 'game/demo/check.mjs', [
      "import fs from 'node:fs'; import path from 'node:path'; import { spawnSync } from 'node:child_process';",
      `const MAIN = ${JSON.stringify(S)}; const MARK = ${JSON.stringify(mark)}; const ARM = ${JSON.stringify(arm)};`,
      'if (fs.existsSync(ARM) && !fs.existsSync(MARK)) {',
      "  fs.writeFileSync(MARK, '1');",
      "  const p = path.join(MAIN, 'package.json'); const j = JSON.parse(fs.readFileSync(p, 'utf8')); j.version = `${j.version}-next`; fs.writeFileSync(p, `${JSON.stringify(j, null, 2)}\\n`);",
      "  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|PREFIX|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/.test(k)));",
      "  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--no-verify', '-m', 'harness update', '--', 'package.json'], { cwd: MAIN, env, windowsHide: true });",
      '}',
      "const d = 'game/demo/notes'; const notes = fs.existsSync(d) ? fs.readdirSync(d) : [];",
      "let bad = 0; for (const f of notes) if (fs.readFileSync(path.join(d, f), 'utf8').includes('BROKEN')) { console.log(`FAIL notes: ${f} says BROKEN`); bad += 1; }",
      "if (bad) process.exit(1); console.log('demo ok');", ''].join('\n'));
    writeIn(S, 'game/demo/notes/shared.md', '# Shared\n');
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'the demo game', '--no-verify');
    g(S, 'config', 'core.hooksPath', 'scripts/hooks');
    const sh = (cwd, cmd, en) => run(cwd, cmd, en);
    const addTask = (title) => (out(sh(S, `node harness/task.mjs add "${title}" --role builder --priority P1 --lane game/demo/notes`, env)).match(/"id": "(T-\d+)"/) || [])[1];
    const laneProbe = path.join(tmpRoot, `lane-2781c-${process.pid}.mjs`);
    fs.writeFileSync(laneProbe, `import { createLaneCopy } from ${JSON.stringify(pathToFileURL(path.join(S, 'harness', 'worktree.mjs')).href)};\nconst r = createLaneCopy(process.argv[2], { task: process.argv[3] });\nconsole.log(JSON.stringify(r));\n`);
    const lane = (agent, title, files) => {
      const id = addTask(title);
      const made = sh(S, `node "${laneProbe}" ${agent} ${id}`, env);
      const ld = path.join(S, '.lanes', agent);
      const as = { ...env, STUDIO_MAIN_ROOT: S, STUDIO_LOCK_OWNER: agent };
      const st = sh(ld, `node harness/task.mjs start ${id} --agent ${agent}`, as);
      for (const [rel, text] of Object.entries(files)) writeIn(ld, rel, text);
      g(ld, 'add', '-A');
      const c = spawnSync('git', ['commit', '-q', '-m', `${id}: ${title}`], { windowsHide: true, cwd: ld, encoding: 'utf8', env: { ...process.env, ...as } });
      return { id, agent, dir: ld, as, ok: fs.existsSync(ld) && st.status === 0 && c.status === 0, log: `${out(made)}\n${out(st)}\n${out(c)}` };
    };
    const queueIt = (l) => sh(l.dir, `node harness/task.mjs done ${l.id} --agent ${l.agent} --train`, l.as);
    const train = (extra = {}) => sh(S, 'node harness/task.mjs train --by tester', { ...env, ...extra });
    const queue = () => { try { return JSON.parse(fs.readFileSync(path.join(S, '.studio', 'train', 'queue.json'), 'utf8')).map((x) => x.task); } catch { return []; } };
    const onMain = (rel) => g(S, 'cat-file', '-e', `main:${rel}`).status === 0;
    const evs = () => events(ev);

    // B-122: two lanes, one per train (STUDIO_TRAIN_BATCH=1). The first train's verify takes the harness update; it
    // lands its lane, and must not start the next train from its (old) process.
    const a = lane('chain-a', 'Docs: note a', { 'game/demo/notes/a.md': '# A\n' });
    const b = lane('chain-b', 'Docs: note b', { 'game/demo/notes/b.md': '# B\n' });
    const qa = queueIt(a); const qb = queueIt(b);
    fs.writeFileSync(arm, '1');
    const t1 = train({ STUDIO_TRAIN_BATCH: '1' });
    fs.rmSync(arm, { force: true });
    const stopped = evs().find((x) => x.type === 'task.train.chain_stopped');
    await guard('2.78.1 (B-122): a train whose process started before a harness update (taken while it verified) lands its own lane but does not chain-start the next train: the queued lane waits for a fresh train, and task.train.chain_stopped says the harness changed (version ... -> ...-next) (fails on 2.78.0: the old process ran the next train itself, mixing old and new harness code)', () => [
      a.ok && b.ok && qa.status === 0 && qb.status === 0 && onMain('game/demo/notes/a.md') && !onMain('game/demo/notes/b.md') && queue().includes(b.id)
        && stopped && /harness changed since this train's process started \(version [^)]*-> [^)]*-next/.test(stopped.msg),
      JSON.stringify({ a: a.log.slice(-300), qa: out(qa).slice(-300), t1: out(t1).slice(-2500), queue: queue(), stopped: stopped?.msg })]);

    // A fresh train (a new process, on the new harness) takes the waiting lane as usual.
    const t2 = train();
    const landedB = onMain('game/demo/notes/b.md');

    // B-116: main is red on its own; first without an update (a real red: main is blamed), then with one taken while the
    // train verifies (not run: harness changed underneath).
    writeIn(S, 'game/demo/notes/main-broken.md', 'BROKEN on main\n');
    g(S, 'add', 'game/demo/notes/main-broken.md');
    spawnSync('git', ['commit', '-qm', 'main: broken note', '--no-verify'], { windowsHide: true, cwd: S, encoding: 'utf8', env: { ...process.env, ...env, STUDIO_MAIN_COMMIT: 'allow' } });
    const c = lane('red-c', 'Docs: note c', { 'game/demo/notes/c.md': '# C\n' });
    queueIt(c);
    fs.rmSync(mark, { force: true });
    fs.writeFileSync(arm, '1');
    const t4 = train();
    fs.rmSync(arm, { force: true });
    const nc = evs().filter((x) => x.type === 'task.train.no_check' && x.meta?.harness).pop();
    const queuedAfter = queue().includes(c.id);
    const t3 = train();
    const realRed = /itself fails its checks/.test(out(t3));
    await guard('2.78.1 (B-116): a train whose verify and re-check of main are red while a harness update lands underneath it says "not run (harness changed underneath)", does not say main itself fails its checks, hands nobody back and keeps the lane queued; the same red with no update is still blamed on main (fails on 2.78.0: "main itself fails its checks" right after the update)', () => [
      landedB && c.ok && realRed && !/itself fails its checks/.test(out(t4)) && /not run \(harness changed underneath\)/.test(out(t4)) && nc && queuedAfter && !evs().some((x) => x.type === 'task.train.dropped' && x.task === c.id),
      JSON.stringify({ t2: out(t2).slice(-400), t3: out(t3).slice(-600), t4: out(t4).slice(-2000), nc: nc?.msg, queue: queue() })]);

    // The pure part: the copy's committed harness against the main checkout's (a tree change), and the import error.
    const old = g(S, 'rev-parse', 'HEAD').stdout.trim();
    writeIn(S, 'harness/zz-2781c-note.mjs', 'export const note = 1;\n');
    g(S, 'add', 'harness/zz-2781c-note.mjs'); spawnSync('git', ['commit', '-qm', 'harness: a new file', '--no-verify'], { windowsHide: true, cwd: S, encoding: 'utf8', env: { ...process.env, ...ident } });
    const pr = probe(S, `import { copyHarnessDrift, harnessImportError, processHarness } from ${u(S, 'harness/harness-version.mjs')};
processHarness();
const moved = copyHarnessDrift({ mainDir: ${JSON.stringify(S)}, copyRev: ${JSON.stringify(old)}, logText: "file:///x/harness/train.mjs:3\\nSyntaxError: The requested module './lane-sparse.mjs' does not provide an export named 'protectSharedLinks'" });
const same = copyHarnessDrift({ mainDir: ${JSON.stringify(S)}, copyRev: 'HEAD', logText: "SyntaxError: The requested module './lane-sparse.mjs' does not provide an export named 'x'" });
const offR = copyHarnessDrift({ mainDir: ${JSON.stringify(S)}, copyRev: ${JSON.stringify(old)}, env: { STUDIO_TRAIN_HARNESS_GUARD: 'off' } });
console.log(JSON.stringify({ moved, same, off: offR, imp: harnessImportError('Error [ERR_MODULE_NOT_FOUND]: Cannot find module /s/harness/gone.mjs') }));
`, env);
    await guard('2.78.1 (B-116): the harness check itself: a copy built from a commit whose committed harness differs from the main checkout\'s now is "changed" (and names the import error from the log); the same harness is not, even with an import error in the log (a real red), and STUDIO_TRAIN_HARNESS_GUARD=off turns it off (fails on 2.78.0: there was no such check)', () => [
      pr.j && pr.j.moved.changed && /checked copy ran the harness of/.test(pr.j.moved.why) && /does not provide an export named 'protectSharedLinks'/.test(pr.j.moved.why) && pr.j.same.changed === false && pr.j.off.changed === false && /ERR_MODULE_NOT_FOUND/.test(pr.j.imp),
      JSON.stringify({ j: pr.j, out: out(pr).slice(-400) })]);
  }

  for (const S of made) { try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch {} }
}
