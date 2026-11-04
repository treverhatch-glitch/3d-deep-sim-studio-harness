/**
 * qa/selftest-276j.mjs — 2.76.0 (helper j): machine sharing (B-89), "waiting on yes" said out loud (B-87), and the
 * first-divergence report for a cartridge that imports its loader from outside its folder (B-94).
 *   B-89 share     a lane check beside the train's verify gets its share of the cores (not 26 of 28), the game's row
 *                  keeps testWorkers { workers, share, why, machineWorkers } and the per-test timeout reads every
 *                  check's workers on the machine
 *   B-89 priority  the train's verify > a builder's verify > a soak beside the same jobs; a train coming (lanes queued)
 *                  keeps its share free; Unity's claimed threads come off the top; STUDIO_TEST_WORKERS still wins and
 *                  STUDIO_RIG_SHARE=off sizes by RAM only
 *   B-89 rig       rigBudget() lists what runs (a verify's own gate slot counted once) and the shares, for the Line Producer
 *   B-87           studio:status's last-pass line, status --brief and the War Room's Needs a person name the tasks
 *                  waiting on a dev's yes; in beta mode the line says who may give it
 *   B-94           a made-up game whose cartridge re-exports game/<name>/tools/cartridge-loader.mjs (which imports the
 *                  sim beside it and a package from node_modules) gets its first divergence (tick, field)
 * Each check fails on 2.75.0.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest276J({ dir, run, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  void harnessRoot;
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const write = (b, rel, text) => { fs.mkdirSync(path.dirname(path.join(b, rel)), { recursive: true }); fs.writeFileSync(path.join(b, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = { ...clean, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off', STUDIO_TEST_LOADAVG: '0', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_SELF_TRIAGE: 'off', STUDIO_TIMEOUT_RERUN: 'off', STUDIO_GAME_GATE_CI: 'off', STUDIO_MACHINE_SCAN: '', npm_lifecycle_event: '', NODE_OPTIONS: '', npm_config_node_options: '', ...ident };
  const machine = JSON.stringify({ os: 'linux', cores: { logical: 28, performance: 8, efficiency: 12 }, ram: { totalGb: 64, freeGb: 60 } });
  const probe = (cwd, name, code, env = {}) => {
    const f = path.join(cwd, `.probe-276j-${name}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(cwd, `node ${path.basename(f)}`, { ...base, ...env });
    try { fs.rmSync(f, { force: true }); } catch {}
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return JSON.parse(line); } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const studio = (name) => {
    const S = path.join(tmpRoot, `276j-${name}-${process.pid}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    for (const x of ['.studio/gates', '.studio/locks', '.studio/train', '.studio/agents', '.studio/verify-running', '.studio/supervisor.json', '.studio/gates-last.json', 'studio/beta.json', 'studio/task-holds.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
    return S;
  };
  // A live machine:heavy holder (this test's own pid stands in for the holder's process).
  const holder = (S, n, rec) => write(S, `.studio/locks/machine-heavy-${n}.lock`, JSON.stringify({ pid: process.pid, at: Date.now(), ...rec }));

  // ---------- B-89: a lane check through game-gates beside the train's verify ----------
  {
    const S = studio('gates');
    const log = path.join(tmpRoot, `args-276j-${process.pid}.log`);
    write(S, 'game/rg/vitest.mjs', "import fs from 'node:fs';\nfs.appendFileSync(process.env.ARGS_LOG, JSON.stringify({ args: process.argv.slice(2), workers: process.env.STUDIO_TEST_WORKERS }) + '\\n');\nconsole.log(' Test Files  1 passed (1)'); console.log('      Tests  1 passed (1)');\n");
    write(S, 'game/rg/package.json', `${JSON.stringify({ name: 'rg', private: true, type: 'module', scripts: { test: 'node vitest.mjs run' } }, null, 2)}\n`);
    write(S, 'game/rg/vite.config.mjs', "export default { test: { environment: 'node', testTimeout: 15_000 } };\n");
    write(S, 'game/rg/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'test', command: 'cd game/rg && npm run test --silent' }] }, null, 2)}\n`);
    g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
    // The merge train's verify runs (a landing verify holding 18 workers).
    holder(S, 1, { label: 'full verify of train-scratch', landing: true, claim: { kind: 'verify', label: 'full verify of train-scratch', workers: 18, cpuThreads: 18, ramGb: 9.1 } });
    const genv = { ...base, STUDIO_GAME: 'rg', STUDIO_TEST_MACHINE: machine, STUDIO_HEAVY_SLOTS: '4', ARGS_LOG: log, AGENT_EVENTS_FILE: path.join(S, '.studio', 'events-276j.jsonl') };
    const gg = (env = {}) => {
      fs.rmSync(log, { force: true });
      const r = run(S, 'node harness/game-gates.mjs --json', { ...genv, ...env });
      let j = null;
      try { j = JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch {}
      let calls = [];
      try { calls = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch {}
      return { r, j, calls, row: j?.rows?.find((x) => x.id === 'game:test') || null };
    };
    const shared = gg();
    const pinned = gg({ STUDIO_TEST_WORKERS: '12' });
    await guard('276j B-89 share: a lane check run beside the train\'s verify (18 workers) on 28 cores gets 9 test workers (its share: weight 2 of 6), not 26; the row keeps testWorkers { workers 9, share, why naming the cores and the train\'s verify, machineWorkers 27 } and its per-test timeout reads the 27 workers on the machine (x4: --testTimeout=60000); STUDIO_TEST_WORKERS=12 still wins (fails on 2.75.0: sized by free RAM only, no testWorkers in the row)', () => {
      const tw = shared.row?.testWorkers;
      const ok = shared.r.status === 0 && shared.calls[0]?.workers === '9' && tw?.workers === 9 && tw.share?.workers === 9 && /9 of 28 cores as a lane check/.test(tw.why || '') && /the train's verify/.test(tw.why || '') && tw.machineWorkers === 27
        && shared.calls[0]?.args?.includes('--testTimeout=60000') && /game:test: 9 test workers \(STUDIO_TEST_WORKERS, VITEST_MAX_WORKERS: 9 of 28 cores/.test(out(shared.r))
        && pinned.calls[0]?.workers === '12' && pinned.row?.testWorkers?.why === 'STUDIO_TEST_WORKERS';
      return [ok, JSON.stringify({ status: shared.r.status, calls: shared.calls, tw, pinned: pinned.calls, tail: out(shared.r).slice(-1200) }).slice(0, 3000)];
    });
    fs.rmSync(S, { recursive: true, force: true });
    fs.rmSync(log, { force: true });
  }

  // ---------- B-89: priority, the train coming, fixed claims, the switch ----------
  {
    const S = studio('prio');
    const u = JSON.stringify(pathToFileURL(path.join(S, 'harness', 'heavy-budget.mjs')).href);
    write(S, '.studio/train/queue.json', JSON.stringify([{ task: 'T-9', head: 'abc', at: new Date().toISOString() }]));
    // A running supervisor (its passes start trains); this test's pid stands in for its process.
    write(S, '.studio/supervisor.json', JSON.stringify({ pid: process.pid, status: 'running', startedAt: Date.now() }));
    const r = probe(S, 'prio', `import * as hb from ${u};
const prof = ${machine};
const S = ${JSON.stringify(S)};
const verifyHolder = { pid: 1, at: Date.now() + 5, label: 'full verify of lane', claim: { kind: 'verify', workers: 9, cpuThreads: 9, ramGb: 5 } };
const unityHolder = { pid: 2, at: Date.now() + 5, label: 'unity', claim: { kind: 'unity', cpuThreads: 4, ramGb: 8 } };
const st = (h) => hb.budgetState(prof, h, {});
const w = (h, extra = {}, env = {}) => hb.jobClaim('verify', { root: S, state: st(h), profile: prof, env, ...extra });
const nothing = { root: '/nonexistent-276j' };
console.log(JSON.stringify({
  builderWithTrainComing: w([]).workers,
  builderWhy: w([]).workersWhy,
  builderNoReserve: w([], {}, { STUDIO_TRAIN_RESERVE: 'off' }).workers,
  train: hb.jobClaim('verify', { ...nothing, state: st([verifyHolder]), profile: prof, env: { STUDIO_GATE_PRIORITY: 'landing' } }).workers,
  builder: hb.jobClaim('verify', { ...nothing, state: st([verifyHolder]), profile: prof }).workers,
  soak: hb.jobClaim('verify', { ...nothing, state: st([verifyHolder]), profile: prof, label: 'soak 150 days' }).workers,
  besideUnity: hb.jobClaim('verify', { ...nothing, state: st([unityHolder]), profile: prof }).workers,
  pinned: hb.jobClaim('verify', { ...nothing, state: st([verifyHolder]), profile: prof, env: { STUDIO_TEST_WORKERS: '12' } }).workers,
  off: hb.jobClaim('verify', { ...nothing, state: st([verifyHolder]), profile: prof, env: { STUDIO_RIG_SHARE: 'off' } }).workers,
}));`);
    await guard('276j B-89 priority: beside one builder verify (9 workers) the train\'s verify gets 18, a builder\'s 14, a soak 9 (train > builder > soak); lanes queued for the train make a builder\'s verify alone leave the train its share (9, not 26; STUDIO_TRAIN_RESERVE=off: 26); a Unity run\'s 4 claimed threads come off the top (24); STUDIO_TEST_WORKERS=12 wins; STUDIO_RIG_SHARE=off sizes by RAM only (26) (fails on 2.75.0: every one gets 26)', () => [
      r.train === 18 && r.builder === 14 && r.soak === 9 && r.builderWithTrainComing === 9 && /lane queued for the train \(T-9\)/.test(r.builderWhy || '') && r.builderNoReserve === 26 && r.besideUnity === 24 && r.pinned === 12 && r.off === 26,
      JSON.stringify(r).slice(0, 2500)]);
    fs.rmSync(S, { recursive: true, force: true });
  }

  // ---------- B-89: rigBudget() for the Line Producer ----------
  {
    const S = studio('rig');
    holder(S, 1, { label: 'full verify of train-scratch', landing: true, claim: { kind: 'verify', label: 'full verify of train-scratch', workers: 18, cpuThreads: 18, ramGb: 9.1 } });
    // The train verify's own game check (its gate slot names the hold) and one lane check of a builder's task done.
    write(S, '.studio/locks/gate-slot-1.lock', JSON.stringify({ pid: process.pid, at: Date.now(), label: 'game:test', landing: true, heavyHeld: `machine-heavy-1.lock:${process.pid}` }));
    write(S, '.studio/locks/gate-slot-2.lock', JSON.stringify({ pid: process.pid, at: Date.now(), label: 'game:test', landing: true }));
    const r = probe(S, 'rig', `const { rigBudget } = await import(${JSON.stringify(pathToFileURL(path.join(S, 'harness', 'rig-budget.mjs')).href)});
const b = await rigBudget({ root: ${JSON.stringify(S)}, events: [{ type: 'job.done', status: 'ok', meta: { kind: 'verify', ms: 20 * 60000 } }] });
console.log(JSON.stringify(b));`, { STUDIO_TEST_MACHINE: machine });
    await guard('276j B-89 rig: rigBudget() gives { cores 28, freeGb, running, shares }: the train\'s verify (machine:heavy, 18 workers, an ETA from the last verifies) and one lane check (gate slot); the train\'s own check is counted once; shares say what a train, builder verify, lane check and soak would get now (train the most) and Unity\'s fixed claim (fails on 2.75.0: no harness/rig-budget.mjs)', () => {
      const run2 = r.running || [];
      const ok = r.cores === 28 && Number.isFinite(r.freeGb) && run2.length === 2 && run2[0].kind === 'train' && run2[0].workers === 18 && run2[0].source === 'machine:heavy' && run2[0].etaMin > 19 && run2[0].etaMin <= 20 && run2[1].kind === 'check' && run2[1].source === 'gate slot'
        && r.shares?.train?.workers > r.shares?.verify?.workers && r.shares.verify.workers >= r.shares.soak.workers && r.shares.check?.workers > 0 && r.shares.unity?.threads === 4 && typeof r.shares.train.why === 'string';
      return [ok, JSON.stringify(r).slice(0, 3000)];
    });
    fs.rmSync(S, { recursive: true, force: true });
  }

  // ---------- B-87: "waiting on yes" in studio:status, status --brief and the War Room ----------
  {
    const S = studio('yes');
    const next = fs.readFileSync(path.join(S, 'studio', 'NEXT.md'), 'utf8').replace(/\r\n/g, '\n');
    write(S, 'studio/NEXT.md', next.replace('## BACKLOG\n', '## BACKLOG\n- [ ] **T-166** [P1] (`builder`) — Add a stamina system\n- [ ] **T-167** [P1] (`builder`) — Add a grapple\n'));
    write(S, 'studio/task-holds.json', `${JSON.stringify({ tasks: { 'T-166': { needsYes: { by: 'builder-s1', at: '2026-11-04T05:00:00.000Z' } }, 'T-167': { needsYes: { by: 'builder-s2', at: '2026-11-04T05:01:00.000Z' } }, 'T-001': { needsYes: null } } }, null, 2)}\n`);
    write(S, '.studio/supervisor.json', JSON.stringify({ status: 'stopped', startedAt: '2026-11-04T04:00:00.000Z', sessions: 0, tasksDone: 0, tokens: 0, last: { started: [], why: [] } }));
    g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
    const env = { AGENT_EVENTS_FILE: path.join(S, '.studio', 'events-276j.jsonl'), STUDIO_MAIN_ROOT: S, STUDIO_TEST_FREEMEM_MB: '8000', STUDIO_MACHINE_SCAN: 'off' };
    const sup = run(S, 'node harness/supervisor.mjs status', { ...base, ...env });
    const brief = run(S, 'node harness/status.mjs --brief --peek', { ...base, ...env });
    const hud = probe(S, 'hud', `const { buildHudState } = await import(${JSON.stringify(pathToFileURL(path.join(S, 'harness', 'hud.mjs')).href)});
const s = buildHudState();
console.log(JSON.stringify({ needs: s.needs.map((n) => n.msg) }));`, env);
    // Beta mode on (set by a person, naming the crew's orchestrator): the line says who may give the yes.
    write(S, 'studio/beta.json', `${JSON.stringify({ on: true, by: 'owner', at: '2026-11-04T06:00:00.000Z', why: 'beta', agents: ['opus-1'], roles: ['producer', 'director'] }, null, 2)}\n`);
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'beta on', '--no-verify');
    const supBeta = run(S, 'node harness/supervisor.mjs status', { ...base, ...env });
    await guard('276j B-87: two agent-proposed tasks waiting on the dev\'s yes are named in studio:status after the last pass ("nothing started; waiting on yes: 2 (T-166, T-167)"), in status --brief\'s Blockers and in the War Room\'s Needs a person; with beta mode on the status line says opus-1 and the planning roles may say yes (fails on 2.75.0: "nothing started" and nothing else)', () => {
      const ok = /Last pass: nothing started; waiting on yes: 2 \(T-166, T-167\): npm run task -- yes <id> --by <dev>/.test(out(sup)) && !/beta mode is on/.test(out(sup))
        && /Blockers: [^\n]*waiting on yes \(2\): T-166, T-167/.test(out(brief))
        && (hud.needs || []).some((m) => /^waiting on yes: 2 \(T-166, T-167\): agent-proposed tasks start only after a yes \(npm run task -- yes T-166 --by <you>\)/.test(m))
        && /waiting on yes: 2 \(T-166, T-167\)[^\n]*beta mode is on: opus-1, a producer session, a director session may say yes/.test(out(supBeta));
      return [ok, JSON.stringify({ sup: out(sup).slice(-800), brief: out(brief).slice(-800), hud, beta: out(supBeta).slice(-800) }).slice(0, 3200)];
    });
    fs.rmSync(S, { recursive: true, force: true });
  }

  // ---------- B-94: the first divergence for a cartridge whose loader lives outside its folder ----------
  {
    const G = path.join(tmpRoot, `276j-div-${process.pid}`);
    fs.mkdirSync(G, { recursive: true });
    write(G, 'cartridges/orbit/index.mjs', "export { createInitialState, step } from '../../game/orbit/tools/cartridge-loader.mjs';\n");
    write(G, 'game/orbit/tools/cartridge-loader.mjs', "import { makeSim } from '../src/sim.mjs';\nimport { bump } from 'orbit-dep';\nconst sim = makeSim(bump);\nexport const createInitialState = sim.init;\nexport const step = sim.step;\n");
    write(G, 'game/orbit/src/sim.mjs', 'export function makeSim(bump) {\n  return {\n    init: (seed) => ({ pos: { x: seed % 7, y: 0 }, fuel: { left: 100 } }),\n    step: (s) => ({ pos: { x: s.pos.x + 1, y: s.pos.y }, fuel: { left: bump(s.fuel.left) } }),\n  };\n}\n');
    write(G, 'game/orbit/package.json', '{ "name": "orbit", "private": true, "type": "module" }\n');
    write(G, 'node_modules/orbit-dep/package.json', '{ "name": "orbit-dep", "type": "module", "exports": "./index.mjs" }\n');
    write(G, 'node_modules/orbit-dep/index.mjs', 'export const bump = (n) => n - 1;\n');
    write(G, '.gitignore', 'node_modules\n');
    write(G, 'qa/golden/orbit-3.json', `${JSON.stringify({ cartridge: 'orbit', seed: 3, tick: 20, actions: [] })}\n`);
    g(G, 'init', '-q', '-b', 'main'); g(G, 'add', '-A'); g(G, 'commit', '-qm', 'record', '--no-verify');
    // The sim changes after the golden was recorded: the position moves 2 a tick once past 8.
    write(G, 'game/orbit/src/sim.mjs', fs.readFileSync(path.join(G, 'game/orbit/src/sim.mjs'), 'utf8').replace('s.pos.x + 1', 's.pos.x + (s.pos.x > 8 ? 2 : 1)'));
    g(G, 'commit', '-qam', 'change', '--no-verify');
    const href = (f) => JSON.stringify(pathToFileURL(path.join(dir, 'harness', f)).href);
    const r = probe(dir, 'div', `const { goldenDivergence, divergenceLines } = await import(${href('divergence.mjs')});
const { loadCartridge } = await import(${href('cartridge.mjs')});
const G = ${JSON.stringify(G)};
const cart = await loadCartridge('orbit', { dir: G + '/cartridges/orbit' });
const spec = { cartridge: 'orbit', seed: 3, tick: 20, actions: [] };
spec.sha256 = 'x';
const d = await goldenDivergence({ root: G, file: 'orbit-3.json', rel: 'qa/golden/orbit-3.json', spec, cart, env: {} });
console.log(JSON.stringify({ d, lines: divergenceLines('[golden]', d) }));`);
    await guard('276j B-94: a made-up game whose cartridge re-exports game/<name>/tools/cartridge-loader.mjs (importing the sim beside it and a package from node_modules) gets its first divergence against the commit that recorded the golden: tick 7, pos.x 10 -> 11 (fails on 2.75.0: "the reference\'s cartridge didn\'t load", no report)', () => {
      const d = r.d || {};
      return [d.found === true && d.tick === 7 && d.field === 'pos.x' && d.from === 10 && d.to === 11 && !d.error && /first divergence: tick 7, pos\.x 10 -> 11/.test((r.lines || [])[0] || ''), JSON.stringify(r).slice(0, 2500)];
    });
    fs.rmSync(G, { recursive: true, force: true });
  }
}
