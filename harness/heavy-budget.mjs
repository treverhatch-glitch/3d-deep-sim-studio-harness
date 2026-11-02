/**
 * harness/heavy-budget.mjs — 2.68.0 (n): the machine:heavy lock as a budgeted pool, test workers and agent sessions
 * sized to the machine, and the out-of-memory retry. No harness imports at load (heavy.mjs, game-gates.mjs and the
 * supervisor all import it; the supervisor's CLI uses top-level await, so nothing here may import it back).
 *
 * The machine profile is helper m's scan (harness/machine.mjs readMachine(), written to <studio>/.studio/machine.json):
 *   { os, cores: { logical, performance, efficiency }, ram: { totalGb, freeGb, commitUsedGb, commitLimitGb },
 *     gpus: [{ name, vramGb, vramFreeGb, busy }], disk, power, at }
 * Admission reads the last scan only (it never runs a scan itself: a heavy take must not wait on PowerShell); a scan
 * older than STUDIO_MACHINE_MAX_AGE_MIN (15) counts as none. No scan (or STUDIO_MACHINE_SCAN=off) keeps the 2.67
 * behaviour: one slot, the STUDIO_RAM_FLOOR_GB floor.
 *
 * Areas (a claim must fit every one it names):
 *   RAM  free = commit headroom on Windows (commitLimitGb - commitUsedGb), else freeGb (MemAvailable), minus
 *        STUDIO_RESERVE_RAM_GB (default max(4, 10% of RAM)) and minus the claims of holders that started after the
 *        scan; never more than total - reserve - every live claim.
 *   GPU  the largest GPU's free VRAM minus STUDIO_GPU_RESERVE_GB (2.5 when it drives the display; 0 for a GPU the scan
 *        marks display: false), minus GPU claims the same way. No GPU in the scan: GPU claims aren't held back.
 *   CPU  the threads every non-GPU-only holder claims stay within STUDIO_CPU_OVERCOMMIT (1.5) x logical cores.
 *   slots  at most STUDIO_HEAVY_SLOTS holders (default computed: min((RAM - reserve) / 4, cores / 4), 1..6; 1 with no
 *        scan). A GPU-only claim (Blender preview, a GPU playtest) uses the GPU area and no slot or CPU share, so it
 *        runs beside a CPU verify.
 * A claim bigger than its whole area can never fit: it runs alone (no other holder in that area) rather than waiting
 * for ever. Test hook: STUDIO_TEST_MACHINE (a profile as JSON, a path to one, or "none" for a failed scan).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const num = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const off = (v) => /^(off|0|false|no)$/i.test(String(v || ''));
const r1 = (x) => Math.round(x * 10) / 10;
const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/** Default claims per job kind; studio/machine-budget.json "jobs": { "<kind>": { ramGb, cpuThreads, vramGb, gpuOnly } } overrides. */
export const JOB_KINDS = {
  verify: { ramGb: null, cpuThreads: null, vramGb: 0, gpuOnly: false, what: 'game verify: 1 GB + 0.45 GB per test worker' },
  unity: { ramGb: 8, cpuThreads: 4, vramGb: 2, gpuOnly: false, what: 'Unity editor run' },
  'browser-playtest': { ramGb: 5, cpuThreads: 2, vramGb: 1, gpuOnly: false, what: 'browser playtest' },
  'gpu-playtest': { ramGb: 2, cpuThreads: 1, vramGb: 1, gpuOnly: true, what: 'GPU playtest' },
  'blender-preview': { ramGb: 2, cpuThreads: 1, vramGb: 1, gpuOnly: true, what: 'Blender preview render' },
  'asset-roundtrip': { ramGb: 1, cpuThreads: 1, vramGb: 0, gpuOnly: false, what: 'asset export/re-import round trip' },
  heavy: { ramGb: 4, cpuThreads: 2, vramGb: 0, gpuOnly: false, what: 'heavy command' },
};
export const WORKER_GB = (env = process.env) => Math.max(0.05, num(env.STUDIO_TEST_WORKER_GB, 0.45));

const toMs = (at) => (fin(at) ? at : Number.isFinite(Date.parse(at)) ? Date.parse(at) : NaN);

/**
 * The machine profile admission uses (sync, never scans): opts.machine (an object, null, or a function giving one),
 * else STUDIO_TEST_MACHINE, else <root>/.studio/machine.json when fresh. null = no scan (2.67 behaviour).
 */
export function machineProfile(root, { env = process.env, machine, now = Date.now() } = {}) {
  if (machine !== undefined) return typeof machine === 'function' ? machine() || null : machine || null;
  if (off(env.STUDIO_MACHINE_SCAN)) return null;
  const t = env.STUDIO_TEST_MACHINE;
  if (t !== undefined && t !== '') {
    if (/^(none|fail|null)$/i.test(t)) return null;
    try { return JSON.parse(t); } catch { return readJson(t); }
  }
  const p = readJson(path.join(root, '.studio', 'machine.json'));
  if (!p || typeof p !== 'object') return null;
  const at = toMs(p.at);
  const maxAge = num(env.STUDIO_MACHINE_MAX_AGE_MIN, 15) * 60000;
  if (!Number.isFinite(at) || now - at > maxAge) return null;
  return p;
}

/** studio/machine-budget.json (optional): { "jobs": { kind: {...} }, "reserveRamGb", "gpuReserveGb", "sessionRamGb", "workerGb" }. */
export function budgetConfig(root) {
  const c = readJson(path.join(root, 'studio', 'machine-budget.json'));
  return c && typeof c === 'object' ? c : {};
}
const cfgEnv = (root, env) => {
  const c = budgetConfig(root);
  const e = { ...env };
  const set = (k, v) => { if ((e[k] === undefined || e[k] === '') && v !== undefined && v !== null) e[k] = String(v); };
  set('STUDIO_RESERVE_RAM_GB', c.reserveRamGb);
  set('STUDIO_GPU_RESERVE_GB', c.gpuReserveGb);
  set('STUDIO_SESSION_RAM_GB', c.sessionRamGb);
  set('STUDIO_TEST_WORKER_GB', c.workerGb);
  return { env: e, jobs: c.jobs && typeof c.jobs === 'object' ? c.jobs : {} };
};

const isWin = (p) => /^win/i.test(String(p?.os?.platform || p?.os?.name || p?.os || ''));
export const logicalCores = (p) => Math.max(1, num(p?.cores?.logical, (os.availableParallelism ? os.availableParallelism() : os.cpus().length) || 1));
export const totalRamGb = (p) => (fin(p?.ram?.totalGb) ? p.ram.totalGb : null);
/** Free RAM by the scan: commit headroom on Windows (where "available" stayed 5.8 GB with commit at 55/60 GB), else freeGb. */
export function scanFreeGb(p) {
  const r = p?.ram || {};
  if (isWin(p) && fin(r.commitLimitGb) && fin(r.commitUsedGb)) return Math.max(0, r.commitLimitGb - r.commitUsedGb);
  return fin(r.freeGb) ? r.freeGb : null;
}
export function reserveGb(p, env = process.env) {
  const t = totalRamGb(p);
  return Math.max(0, num(env.STUDIO_RESERVE_RAM_GB, Math.max(4, t ? t * 0.1 : 4)));
}
/** The GPU the area is about (most VRAM), or null. */
export function mainGpu(p) {
  const g = (Array.isArray(p?.gpus) ? p.gpus : []).filter((x) => x && fin(Number(x.vramGb)) && Number(x.vramGb) > 0);
  return g.sort((a, b) => Number(b.vramGb) - Number(a.vramGb))[0] || null;
}
export const gpuReserveGb = (g, env = process.env) => Math.max(0, num(env.STUDIO_GPU_RESERVE_GB, g && g.display === false ? 0 : 2.5));

/** STUDIO_HEAVY_SLOTS, else computed from the scan; 1 with no scan (2.67). 0 turns the lock off. */
export function slotsFor(p, env = process.env) {
  if (env.STUDIO_HEAVY_SLOTS !== undefined && env.STUDIO_HEAVY_SLOTS !== '' && Number.isFinite(Number(env.STUDIO_HEAVY_SLOTS))) return Number(env.STUDIO_HEAVY_SLOTS);
  if (!p) return 1;
  const t = totalRamGb(p);
  const byRam = t ? Math.floor((t - reserveGb(p, env)) / 4) : 1;
  return Math.min(6, Math.max(1, Math.min(byRam, Math.floor(logicalCores(p) / 4))));
}

/** A holder record's claim (older records have none: the generic heavy claim). */
export const claimOf = (h) => (h && h.claim && typeof h.claim === 'object' ? h.claim : { kind: 'heavy', ramGb: JOB_KINDS.heavy.ramGb, cpuThreads: JOB_KINDS.heavy.cpuThreads, gpu: null, gpuOnly: false });

/**
 * What is free for one more heavy job: { known, freeRamGb, totalRamGb, reserveGb, claimedGb, freeVramGb, vramTotalGb,
 * gpuReserve, gpuClaimedGb, cpuCap, cpuUsed, holders }. `holders`: the live records (each with .at and .claim).
 */
export function budgetState(p, holders = [], { env = process.env } = {}) {
  if (!p) return { known: false, holders: holders.length };
  const scanAt = toMs(p.at);
  const after = (h) => !Number.isFinite(scanAt) || Number(h.at || 0) > scanAt;
  const claims = holders.map((h) => ({ h, c: claimOf(h) }));
  const sum = (xs, f) => xs.reduce((a, x) => a + (Number(f(x)) || 0), 0);
  const total = totalRamGb(p);
  const res = reserveGb(p, env);
  const free = scanFreeGb(p);
  const claimedAll = sum(claims, (x) => x.c.ramGb);
  const claimedSince = sum(claims.filter((x) => after(x.h)), (x) => x.c.ramGb);
  const parts = [fin(free) ? free - res - claimedSince : null, fin(total) ? total - res - claimedAll : null].filter(fin);
  const g = mainGpu(p);
  const gres = gpuReserveGb(g, env);
  const vAll = sum(claims, (x) => x.c.gpu?.vramGb);
  const vSince = sum(claims.filter((x) => after(x.h)), (x) => x.c.gpu?.vramGb);
  const vFree = g ? [fin(Number(g.vramFreeGb)) ? Number(g.vramFreeGb) - gres - vSince : null, Number(g.vramGb) - gres - vAll].filter(fin) : [];
  return {
    known: true,
    freeRamGb: parts.length ? r1(Math.max(0, Math.min(...parts))) : null,
    totalRamGb: total,
    usableRamGb: fin(total) ? r1(Math.max(0, total - res)) : null,
    reserveGb: r1(res),
    claimedGb: r1(claimedAll),
    freeVramGb: g ? r1(Math.max(0, Math.min(...vFree))) : null,
    vramTotalGb: g ? Number(g.vramGb) : null,
    usableVramGb: g ? r1(Math.max(0, Number(g.vramGb) - gres)) : null,
    gpuReserve: gres,
    gpuClaimedGb: r1(vAll),
    gpuName: g?.name || null,
    cpuCap: Math.floor(logicalCores(p) * Math.max(1, num(env.STUDIO_CPU_OVERCOMMIT, 1.5))),
    cpuUsed: sum(claims.filter((x) => !x.c.gpuOnly), (x) => x.c.cpuThreads),
    cores: logicalCores(p),
    holders: holders.length,
    ramHolders: claims.filter((x) => Number(x.c.ramGb) > 0).length,
    gpuHolders: claims.filter((x) => Number(x.c.gpu?.vramGb) > 0).length,
    cpuHolders: claims.filter((x) => !x.c.gpuOnly).length,
  };
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
/** Test workers for `budgetGb` of RAM: clamp(floor(budget / 0.45), 2, cores - 2). */
export function workersFor(budgetGb, cores, env = process.env) {
  return clamp(Math.floor(Math.max(0, budgetGb) / WORKER_GB(env)), 2, Math.max(2, cores - 2));
}
const envWorkers = (env) => (Number(env.STUDIO_TEST_WORKERS) > 0 ? Math.floor(Number(env.STUDIO_TEST_WORKERS)) : null);

/**
 * A heavy job's claim: { kind, label, ramGb, cpuThreads, gpu: { vramGb } | null, gpuOnly, workers? }. A verify sizes
 * itself to what is free now (state.freeRamGb): its workers, then 1 GB + 0.45 GB each. Overrides: studio/machine-budget.json
 * "jobs", then opts.ramGb / vramGb / gpuOnly (heavy.mjs run --ram-gb, --vram-gb, --gpu-only).
 */
export function jobClaim(kind, { root = process.cwd(), env = process.env, label = null, state = null, profile = null, ramGb, vramGb, gpuOnly } = {}) {
  const { env: e, jobs } = cfgEnv(root, env);
  const k = JOB_KINDS[kind] ? kind : 'heavy';
  const base = { ...JOB_KINDS[k], ...(jobs[k] && typeof jobs[k] === 'object' ? jobs[k] : {}) };
  const out = { kind: k, label: label || base.what, ramGb: base.ramGb, cpuThreads: base.cpuThreads, gpu: Number(base.vramGb) > 0 ? { vramGb: Number(base.vramGb) } : null, gpuOnly: Boolean(base.gpuOnly) };
  if (k === 'verify') {
    const cores = logicalCores(profile);
    const w = envWorkers(e) ?? (state?.known && fin(state.freeRamGb) ? workersFor(state.freeRamGb - 1, cores, e) : 2);
    out.workers = w;
    if (!(Number(base.ramGb) > 0)) out.ramGb = r1(1 + WORKER_GB(e) * w);
    if (!(Number(base.cpuThreads) > 0)) out.cpuThreads = w;
  }
  if (Number(ramGb) > 0) out.ramGb = Number(ramGb);
  if (vramGb !== undefined && vramGb !== null && vramGb !== '') out.gpu = Number(vramGb) > 0 ? { vramGb: Number(vramGb) } : null;
  if (gpuOnly !== undefined) out.gpuOnly = Boolean(gpuOnly);
  return out;
}

/**
 * Does `claim` fit now? { ok, area: 'slots'|'ram'|'gpu'|'cpu'|null, line, alone? }. `holders` are the live records,
 * `slots` the holder cap. Without a profile only the slot count decides (2.67).
 */
export function admit(claim, state, { slots = 1, holders = [] } = {}) {
  const slotHolders = state.known ? holders.filter((h) => !claimOf(h).gpuOnly).length : holders.length;
  if (!(state.known && claim.gpuOnly) && slotHolders >= slots) return { ok: false, area: 'slots', line: `all ${slots} machine:heavy slot${slots === 1 ? '' : 's'} are taken (STUDIO_HEAVY_SLOTS)` };
  if (!state.known) return { ok: true, area: null, line: '' };
  let alone = '';
  const ram = Number(claim.ramGb) || 0;
  if (ram > 0 && fin(state.freeRamGb) && ram > state.freeRamGb + 1e-9) {
    if (fin(state.usableRamGb) && ram > state.usableRamGb && !state.ramHolders) alone = `needs ${r1(ram)} GB of RAM, more than the whole budget (${state.usableRamGb} GB): runs alone`;
    else return { ok: false, area: 'ram', line: `waiting for RAM: needs ${r1(ram)} GB, ${state.freeRamGb} free (${state.totalRamGb ?? '?'} GB, ${state.reserveGb} GB kept back: STUDIO_RESERVE_RAM_GB; heavy claims ${state.claimedGb} GB)` };
  }
  const v = Number(claim.gpu?.vramGb) || 0;
  if (v > 0 && fin(state.freeVramGb) && v > state.freeVramGb + 1e-9) {
    if (v > state.usableVramGb && !state.gpuHolders) alone = `${alone ? `${alone}; ` : ''}needs ${r1(v)} GB of VRAM, more than the GPU area (${state.usableVramGb} GB): runs alone on the GPU`;
    else return { ok: false, area: 'gpu', line: `waiting for the GPU: needs ${r1(v)} GB VRAM, ${state.freeVramGb} free on ${state.gpuName || 'the GPU'} (${state.gpuReserve} GB kept back: STUDIO_GPU_RESERVE_GB; GPU claims ${state.gpuClaimedGb} GB)` };
  }
  const c = Number(claim.cpuThreads) || 0;
  if (!claim.gpuOnly && c > 0 && state.cpuHolders && state.cpuUsed + c > state.cpuCap) return { ok: false, area: 'cpu', line: `waiting for CPU: needs ${c} threads, ${Math.max(0, state.cpuCap - state.cpuUsed)} of ${state.cpuCap} free (STUDIO_CPU_OVERCOMMIT x ${state.cores} cores)` };
  return { ok: true, area: null, line: alone, alone: Boolean(alone) };
}

/** One line for status: the budget and its claims. */
export function describeBudget(state, slots) {
  if (!state.known) return `no machine scan: ${slots} slot${slots === 1 ? '' : 's'}, as before (npm run machine writes one)`;
  return `RAM ${state.freeRamGb ?? '?'} GB free for heavy work of ${state.usableRamGb ?? '?'} (${state.reserveGb} kept back, ${state.claimedGb} claimed)${state.vramTotalGb ? `; GPU ${state.freeVramGb} GB of ${state.usableVramGb} free (${state.gpuClaimedGb} claimed)` : ''}; CPU ${state.cpuUsed}/${state.cpuCap} threads claimed; ${slots} slot${slots === 1 ? '' : 's'}`;
}

/**
 * Test workers for a game check: { workers, why }. STUDIO_TEST_WORKERS wins; inside a heavy hold, its claim's workers;
 * no scan: 2 (what CI=true gave before); else the free budget shared with the other running lane checks.
 */
export function testWorkers({ profile = null, env = process.env, holdClaim = null, holders = [], laneChecks = 0, root = process.cwd() } = {}) {
  const { env: e } = cfgEnv(root, env);
  const ew = envWorkers(e);
  if (ew) return { workers: ew, why: 'STUDIO_TEST_WORKERS' };
  if (holdClaim && Number(holdClaim.workers) > 0) return { workers: Number(holdClaim.workers), why: `the ${holdClaim.label || 'heavy job'}'s claim (${holdClaim.ramGb} GB)` };
  if (!profile) return { workers: 2, why: 'no machine scan: 2, as CI=true gave before' };
  const st = budgetState(profile, holders, { env: e });
  if (!fin(st.freeRamGb)) return { workers: 2, why: 'the scan has no free-RAM figure: 2' };
  const share = st.freeRamGb / (laneChecks + 1);
  return { workers: workersFor(share, logicalCores(profile), e), why: `${r1(share)} GB of ${st.freeRamGb} GB free${laneChecks ? ` shared with ${laneChecks} other running lane check${laneChecks === 1 ? '' : 's'}` : ''} / ${WORKER_GB(e)} GB per worker, 2..cores-2` };
}

/**
 * The supervisor's session cap by RAM: { cap, why }. cap = min(configured, floor((RAM budget - heavy claims) /
 * STUDIO_SESSION_RAM_GB (0.6))); no scan: configured (2.67).
 */
export function sessionCap({ configured, profile = null, holders = [], env = process.env, root = process.cwd() } = {}) {
  if (!profile) return { cap: configured, why: '' };
  const { env: e } = cfgEnv(root, env);
  const st = budgetState(profile, holders, { env: e });
  if (!fin(st.usableRamGb)) return { cap: configured, why: '' };
  const per = Math.max(0.05, num(e.STUDIO_SESSION_RAM_GB, 0.6));
  const room = Math.max(0, st.usableRamGb - st.claimedGb);
  const byRam = Math.floor(room / per);
  if (byRam >= configured) return { cap: configured, why: '', byRam };
  return { cap: byRam, byRam, why: `RAM: ${st.usableRamGb} GB budget (${st.totalRamGb} GB, ${st.reserveGb} kept back) - ${st.claimedGb} GB of heavy claims leaves room for ${byRam} session${byRam === 1 ? '' : 's'} at ${per} GB each (STUDIO_SESSION_RAM_GB), under the pace's ${configured}` };
}

/**
 * A memory-kill signature in a finished job ({ status, signal, stdout, stderr }): a short text, or ''. Windows
 * STATUS_NO_MEMORY (0xC0000017: 3221225495 / -1073741801), Node "JavaScript heap out of memory", exit 137 on POSIX
 * (SIGKILL, the OOM killer).
 */
export function oomSignature(res, { platform = process.platform } = {}) {
  if (!res) return '';
  const code = res.status ?? res.code;
  if (code === 3221225495 || code === -1073741801) return `exit ${code} (0xC0000017, out of memory)`;
  const text = `${res.stdout || ''}\n${res.stderr || ''}`;
  if (/JavaScript heap out of memory/i.test(text)) return 'JavaScript heap out of memory';
  if (/0xC0000017/i.test(text)) return '0xC0000017 (out of memory)';
  if (platform !== 'win32' && code === 137) return 'exit 137 (killed: out of memory)';
  return '';
}
