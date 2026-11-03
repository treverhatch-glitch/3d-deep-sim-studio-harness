/**
 * qa/selftest-270w.mjs — 2.70.0 (helper w): sparse lanes, the lane disk report, stale-lane proposals surfaced.
 *   sparse    a lane copy leaves out the game manifest's laneExclude paths, keeps its task's declared paths; an
 *             asset-track task keeps every file; STUDIO_LANE_EXCLUDE=off keeps every file.
 *   widen     `lanes widen <path> --lane <agent>` puts a path back and logs it (lane.widened, the copy's record).
 *   strays    a file written into a left-out path (git hides it) is found at task done and the lane widened over it.
 *   checks    the game's checks and the lane's verify (run-gates) widen over the left-out files a check about to run
 *             reads before running it, and a verify that still leaves files out doesn't write the gate cache.
 *   disk      `lanes disk` lists each lane copy's size, the total and what laneExclude would save; over
 *             STUDIO_LANES_MAX_GB a lanes.disk_over warning; the machine line names the lanes' total.
 *   proposals the supervisor runs the janitor's lane proposals (dry run) and the digest, status --brief and the War Room
 *             show "N stale lane copies (X GB) proposed: …"; a landed lane is stale after STUDIO_JANITOR_LANDED_H.
 *   delegate  janitor-lanes is a delegable action: a delegation for it lets the named outside agent delete stale lanes;
 *             a delegation for hold no longer does.
 * A made-up game (game/crate-yard) in a git checkout; lanes are real git worktrees.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest270W({ dir, run, report, tmpRoot }) {
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { windowsHide: true, cwd, encoding: 'utf8' });
  const write = (base, rel, text) => { fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true }); fs.writeFileSync(path.join(base, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const events = path.join(dir, '.studio', 'events-270w.jsonl');
  const evs = () => { try { return fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const env = {
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_MAIN_ROOT: '', STUDIO_LOCK_OWNER: '',
    STUDIO_ROLE: '', CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', STUDIO_AGENT: '', STUDIO_RAM_FLOOR_GB: '0', STUDIO_QUOTA_PROBE: 'off',
    STUDIO_CREW_WATCH: 'off', STUDIO_JANITOR: 'off', STUDIO_DAILY_TOKEN_CAP: 'off', STUDIO_LAUNCH_LOCK_SEC: '1', STUDIO_AGENT_TOOL: 'claude', STUDIO_BUILDER_CMD: '', STUDIO_AGENT_CMD: '',
    STUDIO_LANE_EXCLUDE: '', STUDIO_LANES_MAX_GB: '', STUDIO_JANITOR_LANES_MIN: '', STUDIO_JANITOR_LANDED_H: '', STUDIO_JANITOR_LANE_H: '', STUDIO_LANE_LIVE_MIN: '',
    STUDIO_UPGRADE_WATCH_MIN: 'off', STUDIO_LANE_INFER: 'off', STUDIO_GAME: '', STUDIO_CARTRIDGE: '', STUDIO_GATE_CHANGED: '', STUDIO_GATE_PATHS: '', STUDIO_GATE_RELATED: '',
    STUDIO_HOOKS_CHECK: 'off', STUDIO_HOOKS_RESTAMP: 'off', STUDIO_COMPACT_OUTPUT: '', STUDIO_MACHINE_SCAN: '', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-270w-${process.pid}.pem`),
    AGENT_EVENTS_FILE: events, AGENT_EVENTS_MIRROR: '', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
  };
  let n = 0;
  const probe = (code, extra = {}, cwd = dir) => {
    const f = path.join(tmpRoot, `p270w-${++n}-${process.pid}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(cwd, `node "${f}"`, { ...env, ...extra });
    fs.rmSync(f, { force: true });
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return { ...JSON.parse(line), _out: out(r).slice(-3000) }; } catch { return { _out: out(r).slice(-3000) }; }
  };

  // ---- a made-up game: code, big docs and media, a manifest with laneExclude and a check that reads docs ----
  for (const d of ['.studio/agents', '.lanes', '.studio/lanes']) fs.rmSync(path.join(dir, d), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(events), { recursive: true });
  fs.writeFileSync(events, '');
  const G = 'game/crate-yard';
  write(dir, 'studio/game.json', JSON.stringify({ game: 'crate-yard' }));
  write(dir, `${G}/src/crates.js`, 'export const crates = 3;\n');
  write(dir, `${G}/docs/lore.md`, `# Lore\n${'words '.repeat(4000)}\n`);
  write(dir, `${G}/docs/design/stacking.md`, '# Stacking\n');
  write(dir, `${G}/media/intro.bin`, 'm'.repeat(200000));
  write(dir, `${G}/tools/need-lore.mjs`, `import fs from 'node:fs'; if (!fs.existsSync(${JSON.stringify(`${G}/docs/lore.md`)})) { console.error('lore.md missing'); process.exit(1); } console.log('lore ok');\n`);
  write(dir, 'tools/need-media.mjs', `import fs from 'node:fs'; if (!fs.existsSync(${JSON.stringify(`${G}/media/intro.bin`)})) { console.error('intro.bin missing'); process.exit(1); } console.log('media ok');\n`);
  write(dir, `${G}/studio.gates.json`, JSON.stringify({ laneExclude: [`${G}/docs/**`, `${G}/media/**`], gates: [{ id: 'lore', command: `node ${G}/tools/need-lore.mjs`, needs: [`${G}/docs/**`] }] }, null, 2));
  const gatesJson = JSON.parse(fs.readFileSync(path.join(dir, 'studio', 'gates.json'), 'utf8'));
  gatesJson.gates.push({ id: 'needs-media', command: 'node tools/need-media.mjs', required: true, lite: true, needs: [`${G}/media/**`] });
  fs.writeFileSync(path.join(dir, 'studio', 'gates.json'), `${JSON.stringify(gatesJson, null, 2)}\n`);
  fs.rmSync(path.join(dir, 'studio', 'delegation.json'), { force: true });
  g(dir, 'init', '-q', '-b', 'main'); g(dir, 'config', 'core.autocrlf', 'false');
  g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'studio', '--no-verify');
  const addTask = (title, extra = '') => (out(run(dir, `node harness/task.mjs add "${title}" --role builder --priority P1 ${extra}`, env)).match(/"id": "(T-\d+)"/) || [])[1];
  const tCode = addTask('Tune the crate stacking', `--paths ${G}/src,${G}/docs/design`);
  const tArt = addTask('Recolor the intro clip', '--track asset');
  const mk = (agent, task, lane = null, extra = {}) => probe(`import { createLaneCopy } from ${u('harness/worktree.mjs')}; const r = createLaneCopy(${JSON.stringify(agent)}, { task: ${JSON.stringify(task)}, lane: ${JSON.stringify(lane)} }); console.log(JSON.stringify({ dir: r.dir || null, error: r.error || null }));`, extra);
  const lane = (a) => path.join(dir, '.lanes', a);
  const has = (a, rel) => fs.existsSync(path.join(lane(a), rel));

  // ---- sparse lanes ----
  const a = mk('builder-a', tCode, `${G}/src,${G}/docs/design`);
  const b = mk('builder-b', tArt);
  const c = mk('builder-c', tCode, `${G}/src`, { STUDIO_LANE_EXCLUDE: 'off' });
  const rec = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, '.studio', 'lanes', 'builder-a.sparse.json'), 'utf8')); } catch { return null; } })();
  await guard('270w sparse: a lane copy leaves out the manifest\'s laneExclude (docs, media) but keeps its task\'s declared paths (docs/design) and the code; an asset-track task keeps every file; STUDIO_LANE_EXCLUDE=off keeps every file (fails on 2.69.0: every lane carries docs and media)', () => [
    a.dir && has('builder-a', `${G}/src/crates.js`) && has('builder-a', `${G}/docs/design/stacking.md`) && !has('builder-a', `${G}/docs/lore.md`) && !has('builder-a', `${G}/media/intro.bin`) && has('builder-a', 'harness/worktree.mjs') && has('builder-a', `${G}/studio.gates.json`)
      && fs.existsSync(path.join(lane('builder-a'), 'studio', 'game.json')) && rec?.exclude?.length === 2
      && b.dir && has('builder-b', `${G}/media/intro.bin`) && has('builder-b', `${G}/docs/lore.md`)
      && c.dir && has('builder-c', `${G}/docs/lore.md`) && has('builder-c', `${G}/media/intro.bin`)
      && !(g(lane('builder-a'), 'status', '--porcelain').stdout || '').trim(),
    JSON.stringify({ a, b, c, rec })]);

  // ---- widen ----
  const w = run(dir, `node harness/lanes.mjs widen ${G}/media --lane builder-a --why "the clip is needed"`, env);
  const wev = evs().filter((e) => e.type === 'lane.widened').pop();
  const rec2 = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, '.studio', 'lanes', 'builder-a.sparse.json'), 'utf8')); } catch { return null; } })();
  await guard('270w widen: `lanes widen <path> --lane <agent>` puts the left-out path back, logged as lane.widened and in the copy\'s record (fails on 2.69.0: no widen command)', () => [
    w.status === 0 && has('builder-a', `${G}/media/intro.bin`) && !has('builder-a', `${G}/docs/lore.md`) && wev?.meta?.lane === 'builder-a' && /the clip is needed/.test(wev.msg) && rec2?.widened?.some((x) => x.paths.includes(`${G}/media`)),
    `${out(w)}\n${JSON.stringify({ wev, rec2 })}`.slice(0, 2500)]);

  // ---- strays: an edit to a left-out tracked file is hidden from git until the lane is widened over it ----
  const d = mk('builder-d', tCode, `${G}/src`);
  write(lane('builder-d'), `${G}/docs/lore.md`, '# Lore, rewritten\n');
  const hiddenBefore = !(g(lane('builder-d'), 'status', '--porcelain').stdout || '').includes('lore.md');
  const dv = probe(`import { deliver } from ${JSON.stringify(pathToFileURL(path.join(lane('builder-d'), 'harness', 'worktree.mjs')).href)}; const r = deliver(${JSON.stringify(tCode)}, { runChecks: false }); console.log(JSON.stringify(r));`, { STUDIO_MAIN_ROOT: dir, STUDIO_LOCK_OWNER: 'builder-d' }, lane('builder-d'));
  const sev = evs().filter((e) => e.type === 'lane.widened' && e.meta?.lane === 'builder-d').pop();
  await guard('270w strays: a file written into a left-out path (git hides the edit) is found at task done: the lane is widened over it (lane.widened) and task done asks for it to be committed (fails on 2.69.0: nothing is left out or widened)', () => [
    d.dir && hiddenBefore && dv.ok === false && /lore\.md/.test(dv.message || '') && sev && /written/.test(sev.msg || ''),
    JSON.stringify({ d, hiddenBefore, dv, sev })]);

  // ---- the checks never see a partial tree ----
  const e = mk('builder-e', tCode, `${G}/src`);
  const lenv = { ...env, STUDIO_MAIN_ROOT: dir, STUDIO_LOCK_OWNER: 'builder-e' };
  const gg = run(lane('builder-e'), 'node harness/game-gates.mjs --json', lenv);
  const ggev = evs().filter((x) => x.type === 'lane.widened' && x.meta?.lane === 'builder-e').pop();
  const loreBack = has('builder-e', `${G}/docs/lore.md`);
  const mediaStillOut = !has('builder-e', `${G}/media/intro.bin`);
  try { fs.rmSync(path.join(dir, '.studio', 'gate-cache.json'), { force: true }); } catch {}
  const h = mk('builder-h', tCode, `${G}/src`);
  const rg = run(lane('builder-h'), 'node scripts/run-gates.mjs --only needs-media --tier fast', { ...lenv, STUDIO_LOCK_OWNER: 'builder-h' });
  const cache = (() => { try { return fs.readFileSync(path.join(dir, '.studio', 'gate-cache.json'), 'utf8'); } catch { return ''; } })();
  await guard('270w checks: in a sparse lane the game\'s checks put back the left-out files they read (needs) before running and pass, and the lane\'s verify widens for a harness check that reads media, says so, passes, and writes no gate cache while files are still left out (fails on 2.69.0: nothing is widened)', () => [
    e.dir && gg.status === 0 && loreBack && mediaStillOut && ggev && /checks game:lore/.test(ggev.msg || '')
      && h.dir && rg.status === 0 && /widened to .*media/.test(out(rg)) && has('builder-h', `${G}/media/intro.bin`) && !has('builder-h', `${G}/docs/lore.md`) && !/needs-media/.test(cache),
    `${out(gg).slice(-1200)}\n---\n${out(rg).slice(-1500)}\n${JSON.stringify({ ggev, loreBack, mediaStillOut, cache: cache.slice(0, 200) })}`]);

  // ---- the lane disk report ----
  const dk = run(dir, 'node harness/lanes.mjs disk --json', { ...env, STUDIO_LANES_MAX_GB: '0.00001' });
  let dj = {}; try { dj = JSON.parse(String(dk.stdout).trim().split('\n').pop()); } catch {}
  const over = evs().filter((x) => x.type === 'lanes.disk_over').pop();
  const ml = probe(`import { scanMachine, machineLine } from ${u('harness/machine.mjs')}; console.log(JSON.stringify({ line: machineLine(scanMachine({ root: process.cwd() })) }));`, { STUDIO_MACHINE_SCAN: '' });
  const txt = run(dir, 'node harness/lanes.mjs disk --top 2', env);
  await guard('270w disk: `lanes disk` lists each lane copy\'s size, the total and what laneExclude would save in the lanes that still carry it; over STUDIO_LANES_MAX_GB a lanes.disk_over warning; the machine scan\'s disk line names the lanes\' total (fails on 2.69.0: no disk report)', () => [
    dk.status === 0 && dj.lanes?.length >= 5 && dj.totalBytes > 0 && dj.lanes.every((l) => l.bytes > 0) && dj.saveBytes > 0 && dj.lanes.find((l) => l.name === 'builder-a')?.sparse === true && dj.lanes.find((l) => l.name === 'builder-b')?.sparse === false
      && over?.status === 'warn' && /STUDIO_LANES_MAX_GB/.test(over.msg) && /lane copies [\d.]+ GB/.test(ml.line || '') && /Lane copies: \d+/.test(out(txt)) && /more/.test(out(txt)),
    `${out(dk).slice(-1500)}\n${JSON.stringify({ over, ml })}\n${out(txt)}`]);

  // ---- stale-lane proposals surfaced, landed lanes sooner ----
  const tDone = addTask('Paint the crate labels');
  const f = mk('builder-f', tDone, `${G}/src`);
  write(dir, '.studio/agents/builder-f.json', JSON.stringify({ agent: 'builder-f', role: 'builder', task: tDone, status: 'done' }));
  write(dir, '.studio/agents/builder-e.json', JSON.stringify({ agent: 'builder-e', role: 'builder', task: tCode, status: 'done' }));
  fs.appendFileSync(path.join(dir, 'studio', 'DONE.md'), `\n- [x] **${tDone}** Paint the crate labels\n`);
  const penv = { STUDIO_JANITOR_LANE_H: '1000', STUDIO_JANITOR_LANDED_H: '0', STUDIO_LANE_LIVE_MIN: '0' };
  const pass = (now) => probe(`import { supervise } from ${u('harness/supervisor.mjs')};
const deps = { sessions: () => [], startAgent: () => ({ ok: true }), launchableRoles: () => [], nextAgentName: (r) => r + '-z', pauseAgent: () => ({ ok: true }), lanesInline: true };
await supervise({ deps, dryRun: true }, { startedAt: Date.now() - 1000, names: [] }, ${now});
import fs from 'node:fs'; let p = null; try { p = JSON.parse(fs.readFileSync('.studio/lanes/proposals.json', 'utf8')); } catch {}
console.log(JSON.stringify({ p }));`, penv);
  const now = Date.now();
  const p1 = pass(now);
  const pev = evs().filter((x) => x.type === 'janitor.lanes_proposed');
  const p2 = pass(now + 60000);
  const pev2 = evs().filter((x) => x.type === 'janitor.lanes_proposed');
  const surf = probe(`import { buildDigest } from ${u('harness/digest.mjs')}; import { briefFacts } from ${u('harness/brief-status.mjs')}; import { buildStudioSnapshot } from ${u('harness/status.mjs')};
const d = await buildDigest({ root: process.cwd(), events: [] }); const b = await briefFacts({ root: process.cwd(), events: [] }); const s = buildStudioSnapshot();
console.log(JSON.stringify({ d: (typeof d === 'string' ? d : d.text || JSON.stringify(d)), b: b.staleLanes || '', s: s.staleLanes || null }));`, penv);
  const want = /1 stale lane copy \([\d.]+ [KMG]B\) proposed: npm run janitor -- --lanes --yes --by <name>/;
  await guard('270w proposals: the supervisor runs the janitor\'s lane proposals (dry run: nothing deleted), at most every STUDIO_JANITOR_LANES_MIN; a lane whose task landed is stale after STUDIO_JANITOR_LANDED_H while an unlanded one is kept; the digest, status --brief and the War Room snapshot show "1 stale lane copy (X) proposed: npm run janitor -- --lanes --yes --by <name>" (fails on 2.69.0: nothing runs or shows them)', () => [
    p1.p?.stale?.length === 1 && p1.p.stale[0].agent === 'builder-f' && p1.p.stale[0].landed === true && pev.length === 1 && pev2.length === 1 && fs.existsSync(lane('builder-f')) && fs.existsSync(lane('builder-e'))
      && want.test(surf.d || '') && want.test(surf.b || '') && want.test(surf.s?.line || '') && surf.s?.stale === 1,
    JSON.stringify({ p1: p1.p || p1._out, pev: pev.length, pev2: pev2.length, p2: p2.p?.at, surf }).slice(0, 3000)]);

  // ---- janitor-lanes is delegable; hold no longer covers deleting lanes ----
  const deleg = (actions) => {
    write(dir, 'studio/delegation.json', JSON.stringify({ agent: 'opus-x', actions, until: new Date(Date.now() + 6 * 3600000).toISOString(), by: 'owner', at: new Date(Date.now() - 60000).toISOString(), why: 'tidy lanes' }, null, 2));
    g(dir, 'add', 'studio/delegation.json'); g(dir, 'commit', '-qm', 'owner: delegation', '--no-verify');
  };
  const jenv = { ...penv, CLAUDECODE: '1' };
  deleg(['hold']);
  const viaHold = run(dir, 'node harness/janitor.mjs --lanes --yes --by opus-x', { ...env, ...jenv });
  const keptHold = fs.existsSync(lane('builder-f'));
  deleg(['janitor-lanes']);
  const viaJl = run(dir, 'node harness/janitor.mjs --lanes --yes --by opus-x', { ...env, ...jenv });
  const dl = probe(`import { DELEGABLE } from ${u('harness/delegation.mjs')}; console.log(JSON.stringify({ d: DELEGABLE }));`);
  const after = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, '.studio', 'lanes', 'proposals.json'), 'utf8')); } catch { return null; } })();
  await guard('270w delegate: janitor-lanes is a delegable action; an outside agent under a delegation for it deletes the stale (landed) lane copy and the proposals record is updated, while a delegation for hold alone no longer lets it (fails on 2.69.0: janitor-lanes is not delegable and hold covered it)', () => [
    (dl.d || []).includes('janitor-lanes') && viaHold.status !== 0 && keptHold && viaJl.status === 0 && !fs.existsSync(lane('builder-f')) && fs.existsSync(lane('builder-e')) && after?.stale?.length === 0,
    `${out(viaHold).slice(-800)}\n---\n${out(viaJl).slice(-800)}\n${JSON.stringify({ dl: dl.d, keptHold, after })}`]);
  fs.rmSync(path.join(dir, 'studio', 'delegation.json'), { force: true });
}
