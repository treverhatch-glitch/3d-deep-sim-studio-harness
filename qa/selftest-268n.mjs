/**
 * qa/selftest-268n.mjs — 2.68.0 (n): one resource-aware queue for heavy work (RAM, GPU and CPU areas from the machine
 * scan), the out-of-memory retry, test workers sized to the machine, and the supervisor's session cap by RAM. Every
 * machine profile here is a stub (STUDIO_TEST_MACHINE); nothing scans the real machine.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest268N({ dir, run, report }) {
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  const guard = (name, fn) => { try { const [ok, detail] = fn(); report(name, ok, detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const base = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_MAIN_ROOT: '', STUDIO_HEAVY_SLOTS: '', STUDIO_HEAVY_HELD: '', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '0.05', STUDIO_HEAVY_RAM_WAIT_MIN: '', STUDIO_GATE_PRIORITY: '', STUDIO_LOCK_OWNER: '', STUDIO_GAME: '', STUDIO_TEST_LOADAVG: '0', STUDIO_RAM_FLOOR_GB: '0', STUDIO_TEST_FREEMEM_MB: '', STUDIO_RESERVE_RAM_GB: '', STUDIO_GPU_RESERVE_GB: '', STUDIO_TEST_WORKERS: '', STUDIO_SESSION_RAM_GB: '', STUDIO_HEAVY_OOM_RETRY: '', STUDIO_MACHINE_SCAN: '', STUDIO_HEAVY_PROGRAMS: 'off', AGENT_EVENTS_FILE: path.join(dir, '.studio', 'events-268n.jsonl') };
  const machine = (o = {}) => JSON.stringify({ os: 'linux', cores: { logical: o.cores ?? 16 }, ram: { totalGb: o.total ?? 32, freeGb: o.free ?? 18, commitUsedGb: null, commitLimitGb: null }, gpus: o.gpus ?? [{ name: 'Test GPU', vramGb: 12, vramFreeGb: 11, busy: 1 }], disk: { freeGb: 100, totalGb: 500 }, power: { onBattery: false }, at: new Date(Date.now() - 60000).toISOString() });
  let n = 0;
  const probe = (code, env = {}) => {
    const f = path.join(dir, `.probe-268n-${(n += 1)}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node "${f}"`, { ...base, ...env });
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return { ...JSON.parse(line), _err: String(r.stderr || '').slice(-1500) }; } catch { return { _raw: out(r).slice(-2000) }; }
  };
  const clearLocks = () => { try { for (const f of fs.readdirSync(path.join(dir, '.studio', 'locks'))) if (/^machine-heavy|^gate-slot/.test(f)) fs.rmSync(path.join(dir, '.studio', 'locks', f), { force: true }); } catch {} };
  // Takes heavy jobs in order inside one process (each with its own env, so none counts as inside another's hold).
  const takes = (jobs) => `import { acquireHeavy } from ${u('harness/heavy.mjs')};
const logs = []; const got = [];
for (const j of ${JSON.stringify(jobs)}) {
  try { const lk = acquireHeavy(process.cwd(), j.label, { ...j, env: { ...process.env, STUDIO_HEAVY_HELD: '' }, log: (m) => logs.push(m) }); got.push({ label: j.label, ok: true, held: lk.held, claim: lk.claim || null }); }
  catch (e) { got.push({ label: j.label, ok: false, code: e.code, msg: e.message }); }
}
console.log(JSON.stringify({ got, logs }));`;

  // 1. Two claims that fit run together; a third waits, saying what for.
  {
    clearLocks();
    const p = probe(takes([{ label: 'play A', kind: 'browser-playtest' }, { label: 'job B', kind: 'heavy', ramGb: 5 }, { label: 'big C', kind: 'heavy', ramGb: 8 }]), { STUDIO_TEST_MACHINE: machine() });
    const [a, b, c] = p.got || [];
    guard('2.68.0 (n): two heavy claims that fit the RAM budget (5 + 5 GB of 14 free) hold machine:heavy together; a third (8 GB) waits with "waiting for RAM: needs 8 GB, 4 free" (2.67.2: one slot, the second waits as busy)', () => [
      a?.ok && b?.ok && a.held !== b.held && c && !c.ok && c.code === 'HEAVY_BUSY' && (p.logs || []).some((l) => /big C waiting for RAM: needs 8 GB, 4 free/.test(l)) && /waiting for RAM: needs 8 GB, 4 free/.test(c.msg),
      JSON.stringify(p).slice(0, 2500)]);
  }

  // 2. A GPU-only job runs beside a CPU verify (one slot); the verify's claim is sized from free RAM.
  {
    clearLocks();
    const p = probe(takes([{ label: 'full verify', kind: 'verify' }, { label: 'blender preview', kind: 'blender-preview' }, { label: 'round trip', kind: 'asset-roundtrip' }]), { STUDIO_TEST_MACHINE: machine(), STUDIO_HEAVY_SLOTS: '1' });
    const [v, g, r] = p.got || [];
    guard('2.68.0 (n): with one slot, a GPU-only job (Blender preview) starts beside a running verify on the GPU area while a CPU job still waits for the slot; the verify claims 1 GB + 0.45 GB x its workers (14 = cores - 2) (2.67.2: the GPU job waited)', () => [
      v?.ok && g?.ok && g.claim?.gpuOnly === true && r && !r.ok && r.code === 'HEAVY_BUSY' && v.claim?.workers === 14 && Math.abs(v.claim.ramGb - (1 + 0.45 * 14)) < 0.11,
      JSON.stringify(p).slice(0, 2500)]);
  }

  // 3. The reserve is kept back.
  {
    clearLocks();
    const kept = probe(takes([{ label: 'job 4 GB', kind: 'heavy', ramGb: 4 }]), { STUDIO_TEST_MACHINE: machine({ total: 16, free: 9 }), STUDIO_RESERVE_RAM_GB: '6' });
    clearLocks();
    const def = probe(takes([{ label: 'job 4 GB', kind: 'heavy', ramGb: 4 }]), { STUDIO_TEST_MACHINE: machine({ total: 64, free: 10 }) });
    clearLocks();
    const fits = probe(takes([{ label: 'job 4 GB', kind: 'heavy', ramGb: 4 }]), { STUDIO_TEST_MACHINE: machine({ total: 16, free: 9 }) });
    guard('2.68.0 (n): the RAM reserve is kept back: 9 GB free less STUDIO_RESERVE_RAM_GB=6 leaves 3 for a 4 GB job (it waits); the default max(4 GB, 10% of RAM) keeps 6.4 of 64 GB (3.6 free: waits); with 4 kept back it starts (2.67.2: started regardless)', () => [
      kept.got?.[0]?.ok === false && /needs 4 GB, 3 free/.test(kept.got[0].msg) && def.got?.[0]?.ok === false && /needs 4 GB, 3.6 free/.test(def.got[0].msg) && fits.got?.[0]?.ok === true,
      JSON.stringify({ kept, def, fits }).slice(0, 2500)]);
  }

  // 4. No scan (failed, off, or too old): one slot, as in 2.67; status says so.
  {
    clearLocks();
    const failed = probe(takes([{ label: 'job one', kind: 'blender-preview' }, { label: 'job two', kind: 'blender-preview' }]), { STUDIO_TEST_MACHINE: 'none' });
    clearLocks();
    write('.studio/machine.json', JSON.stringify({ ...JSON.parse(machine()), at: new Date(Date.now() - 3 * 3600000).toISOString() }));
    const old = probe(takes([{ label: 'job one', kind: 'heavy', ramGb: 1 }, { label: 'job two', kind: 'heavy', ramGb: 1 }]), {});
    const st = run(dir, 'node harness/heavy.mjs status', { ...base, STUDIO_TEST_MACHINE: 'none' });
    fs.rmSync(path.join(dir, '.studio', 'machine.json'), { force: true });
    guard('2.68.0 (n): with no machine scan (STUDIO_TEST_MACHINE=none, or a .studio/machine.json 3 h old) machine:heavy has one slot as in 2.67 (even GPU-only jobs wait), and heavy status says "no machine scan: 1 slot, as before" (2.67.2: no budget line)', () => [
      failed.got?.[0]?.ok && failed.got?.[1]?.ok === false && (failed.logs || []).some((l) => /waits for the machine:heavy lock \(1 slot, STUDIO_HEAVY_SLOTS\)/.test(l))
        && old.got?.[0]?.ok && old.got?.[1]?.ok === false && st.status === 0 && /budget: no machine scan: 1 slot, as before/.test(out(st)),
      JSON.stringify({ failed, old, st: out(st).slice(-600) }).slice(0, 2500)]);
  }

  // 5. Out of memory: re-queued once, not red.
  {
    clearLocks();
    write('.probe-268n-oom.mjs', `import fs from 'node:fs';
const f = process.argv[2]; const mode = process.argv[3];
const n = (fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0) + 1; fs.writeFileSync(f, String(n));
if (mode === 'once' && n === 1) { process.exitCode = ${process.platform === 'win32' ? -1073741801 : 137}; } else if (mode === 'heap') { console.error('FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'); process.exitCode = 134; }
`);
    const cnt1 = path.join(dir, '.oom-count-1');
    const cnt2 = path.join(dir, '.oom-count-2');
    const once = run(dir, `node harness/heavy.mjs run --label oom-once -- node .probe-268n-oom.mjs "${cnt1}" once`, { ...base, STUDIO_TEST_MACHINE: machine() });
    const heap = run(dir, `node harness/heavy.mjs run --label oom-heap -- node .probe-268n-oom.mjs "${cnt2}" heap`, { ...base, STUDIO_TEST_MACHINE: machine() });
    const count = (f) => { try { return Number(fs.readFileSync(f, 'utf8')); } catch { return 0; } };
    // A game check killed for memory once. Windows has no exit 137 (the harness reads it as OOM only on POSIX); there
    // the probe exits 0xC0000017 (STATUS_NO_MEMORY), which is what a Windows OOM looks like (CI windows, 2.68.0).
    const cnt3 = path.join(dir, '.oom-count-3');
    write('game/oom268/studio.gates.json', JSON.stringify({ gates: [{ id: 'suite', command: `node .probe-268n-oom.mjs "${cnt3.replace(/\\/g, '/')}" once`, required: true }] }));
    const gg = run(dir, 'node harness/game-gates.mjs --json', { ...base, STUDIO_GAME: 'oom268', STUDIO_GAME_GATE_CI: '', STUDIO_TEST_MACHINE: machine() });
    let row = null;
    try { row = JSON.parse(String(gg.stdout).trim().split('\n').pop()).rows?.find((x) => /suite$/.test(x.id)); } catch {}
    guard('2.68.0 (n): a heavy job that dies out of memory (exit 137) is re-queued once with a note and its second run counts (exit 0); "JavaScript heap out of memory" twice runs exactly twice and keeps its exit; a game check killed for memory runs once more and is green with an oomRetry note (2.67.2: exit 137, red)', () => [
      once.status === 0 && count(cnt1) === 2 && /oom-once died out of memory \(exit (137|3221225495|-1073741801)/.test(out(once))
        && heap.status === 134 && count(cnt2) === 2 && /died out of memory again: not retried a second time/.test(out(heap))
        && count(cnt3) === 2 && row?.ok === true && /exit (137|3221225495|-1073741801)/.test(row.oomRetry || ''),
      JSON.stringify({ st: [once.status, heap.status], once: out(once).slice(-500), heap: out(heap).slice(-500), c: [count(cnt1), count(cnt2), count(cnt3)], row, gg: out(gg).slice(-800) }).slice(0, 2500)]);
  }

  // 6. Test workers: computed from the budget, shared with running lane checks, always passed beside CI=true.
  {
    clearLocks();
    write('.probe-268n-env.mjs', `import fs from 'node:fs';\nfs.appendFileSync(process.argv[2], JSON.stringify({ w: process.env.STUDIO_TEST_WORKERS, v: process.env.VITEST_MAX_WORKERS, ci: process.env.CI }) + '\\n');\n`);
    const envF = path.join(dir, '.env-268n.jsonl');
    write('game/workers268/studio.gates.json', JSON.stringify({ gates: [{ id: 'suite', command: `node .probe-268n-env.mjs "${envF.replace(/\\/g, '/')}"`, required: true }] }));
    const genv = { ...base, STUDIO_GAME: 'workers268', STUDIO_GAME_GATE_CI: '' };
    const alone = run(dir, 'node harness/game-gates.mjs', { ...genv, STUDIO_TEST_MACHINE: machine({ free: 9 }) });
    // Another lane's game check running: a live gate-slot holder.
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true, stdio: 'ignore' });
    fs.mkdirSync(path.join(dir, '.studio', 'locks'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.studio', 'locks', 'gate-slot-1.lock'), JSON.stringify({ pid: other.pid, at: Date.now(), label: 'lane check' }));
    const shared = run(dir, 'node harness/game-gates.mjs', { ...genv, STUDIO_GATE_SLOTS: '4', STUDIO_TEST_MACHINE: machine({ free: 9 }) });
    try { other.kill(); } catch {}
    clearLocks();
    const forced = run(dir, 'node harness/game-gates.mjs', { ...genv, STUDIO_TEST_WORKERS: '3', STUDIO_TEST_MACHINE: 'none' });
    const none = run(dir, 'node harness/game-gates.mjs', { ...genv, STUDIO_TEST_MACHINE: 'none' });
    const seen = (() => { try { return fs.readFileSync(envF, 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } })();
    guard('2.68.0 (n): game checks get STUDIO_TEST_WORKERS and VITEST_MAX_WORKERS beside CI=true: 5 GB free / 0.45 = 11 alone, 5 with another lane check running (its share is half), STUDIO_TEST_WORKERS=3 wins, 2 with no scan (2.67.2: neither variable)', () => [
      seen.length === 4 && seen.map((s) => s.w).join(',') === '11,5,3,2' && seen.every((s) => s.v === s.w && s.ci === 'true') && /suite: 11 test workers/.test(out(alone)) && /shared with 1 other running lane check/.test(out(shared)),
      JSON.stringify({ seen, alone: out(alone).slice(-500), shared: out(shared).slice(-500), forced: out(forced).slice(-200), none: out(none).slice(-200) }).slice(0, 2500)]);
  }

  // 8. A per-kind cap: more slots never mean two Unity editors at once unless the owner asks.
  {
    clearLocks();
    const big = { STUDIO_TEST_MACHINE: machine({ total: 64, free: 30 }) };
    const two = probe(takes([{ label: 'unity A', kind: 'unity' }, { label: 'unity B', kind: 'unity' }, { label: 'round trip', kind: 'asset-roundtrip' }]), big);
    clearLocks();
    const envUp = probe(takes([{ label: 'unity A', kind: 'unity' }, { label: 'unity B', kind: 'unity' }]), { ...big, STUDIO_HEAVY_MAX_UNITY: '2' });
    clearLocks();
    write('studio/machine-budget.json', JSON.stringify({ maxConcurrent: { unity: 2, 'asset-roundtrip': 1 } }));
    const cfg = probe(takes([{ label: 'unity A', kind: 'unity' }, { label: 'unity B', kind: 'unity' }, { label: 'trip A', kind: 'asset-roundtrip' }, { label: 'trip B', kind: 'asset-roundtrip' }]), big);
    fs.rmSync(path.join(dir, 'studio', 'machine-budget.json'), { force: true });
    clearLocks();
    const ok = (p, i) => p.got?.[i]?.ok === true;
    guard('2.68.0 (n): two Unity claims that fit the RAM budget (8 + 8 GB of 23.6 free) don\'t run together: the second waits with "waiting: 1 unity job already running (max 1)" while an asset round trip still starts; STUDIO_HEAVY_MAX_UNITY=2 or studio/machine-budget.json "maxConcurrent" lets both run, and caps another kind (before: both Unity runs started)', () => [
      ok(two, 0) && two.got?.[1]?.ok === false && /waiting: 1 unity job already running \(max 1/.test(two.got[1].msg) && (two.logs || []).some((l) => /unity B waiting: 1 unity job already running \(max 1/.test(l)) && ok(two, 2)
        && ok(envUp, 0) && ok(envUp, 1) && ok(cfg, 0) && ok(cfg, 1) && ok(cfg, 2) && cfg.got?.[3]?.ok === false && /1 asset-roundtrip job already running \(max 1/.test(cfg.got[3].msg),
      JSON.stringify({ two, envUp: envUp.got, cfg: cfg.got }).slice(0, 2500)]);
  }

  // 7. The supervisor's session cap by RAM.
  {
    clearLocks();
    run(dir, 'node harness/task.mjs add "Build the session cap probe" --role builder', base);
    const sup = (claimGb) => probe(`import fs from 'node:fs';
import { supervise } from ${u('harness/supervisor.mjs')};
import { selfIdentity } from ${u('harness/proc-identity.mjs')};
const claim = ${claimGb};
if (claim) { fs.mkdirSync('.studio/locks', { recursive: true }); fs.writeFileSync('.studio/locks/machine-heavy-1.lock', JSON.stringify({ pid: process.pid, identity: selfIdentity(), at: Date.now(), label: 'unity run', claim: { kind: 'unity', ramGb: claim, cpuThreads: 4, gpu: null } })); }
const starts = [];
const deps = { sessions: () => [], startAgent: (o) => { starts.push(o.agent); return { ok: true }; }, launchableRoles: (r) => r, nextAgentName: (role, p) => p + role + '-' + (starts.length + 1) };
const r = await supervise({ watcher: true, dryRun: true, prefix: 'cap' + claim + '-', deps }, { startedAt: Date.now(), names: [] });
fs.rmSync('.studio/locks/machine-heavy-1.lock', { force: true });
console.log(JSON.stringify({ started: r.started, why: r.why, starts }));`, { STUDIO_TEST_MACHINE: machine({ total: 8, free: 6 }), STUDIO_TEST_FREEMEM_MB: '16384', STUDIO_RAM_FLOOR_GB: '', STUDIO_AGENT_TOOL: '', STUDIO_BUILDER_TOOL: '', STUDIO_BUILDER_CMD: '', STUDIO_AGENT_CMD: '' });
    const capped = sup(3.5);
    const free = sup(0);
    guard('2.68.0 (n): the supervisor caps sessions by RAM: 8 GB less 4 kept back less a 3.5 GB heavy claim leaves room for 0 sessions at 0.6 GB, so none starts and it says why (STUDIO_SESSION_RAM_GB); without the claim it starts (2.67.2: started regardless)', () => [
      Array.isArray(capped.starts) && capped.starts.length === 0 && (capped.why || []).some((w) => /no more start: RAM: 4 GB budget .*3\.5 GB of heavy claims leaves room for 0 sessions at 0\.6 GB each \(STUDIO_SESSION_RAM_GB\)/.test(w)) && free.starts?.length > 0,
      JSON.stringify({ capped, free }).slice(0, 2500)]);
  }
  clearLocks();
}
