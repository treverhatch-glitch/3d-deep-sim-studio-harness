#!/usr/bin/env node
/**
 * harness/machine.mjs — 2.68.0 (m): the machine scan, the resource monitor and the disk budget.
 *
 *   npm run machine [-- --json] [--cached]   scan now (or show the last scan), write .studio/machine.json, print it
 *
 * scanMachine() reads the hardware the studio runs on, read-only, with one bounded probe per source (each with a
 * timeout; a probe that fails leaves its fields null and says why in `errors`, never a crash):
 *   - OS and arch; logical cores and, where the OS says, performance vs efficiency cores (Windows: CIM
 *     Win32_Processor; macOS: sysctl hw.perflevel0/1.logicalcpu; Linux: /proc/cpuinfo and /sys/devices/cpu_core|cpu_atom);
 *   - RAM total/free and the commit charge (Windows: Win32_PerfFormattedData_PerfOS_Memory CommittedBytes/CommitLimit,
 *     else Win32_OperatingSystem's virtual memory; Linux: /proc/meminfo MemAvailable, Committed_AS, CommitLimit;
 *     macOS: vm_stat and kern.memorystatus_level, no commit charge);
 *   - GPUs: nvidia-smi when present (name, VRAM total/free, busy), macOS system_profiler (GPU, unified memory),
 *     Windows Win32_VideoController names; else none;
 *   - the disk holding the studio (fs.statfs), the power source (Win32_Battery, pmset -g batt, /sys/class/power_supply),
 *     the CPU's busy fraction (two os.cpus() samples), and the top 10 processes by memory: names, MB, CPU% only
 *     (never command lines; nothing is stopped or touched).
 * Shape: { os, arch, osName, cores: { logical, physical, performance, efficiency, source }, cpu: { model, busy },
 *   ram: { totalGb, freeGb, commitUsedGb, commitLimitGb, pressure }, gpus: [{ name, vramGb, vramFreeGb, busy }],
 *   disk: { path, freeGb, totalGb }, power: { onBattery, percent, source }, processes: [{ name, mb, cpu }], errors, at }.
 *   busy values are fractions 0..1 (as heavy.mjs cpuBusy); null = not known.
 *
 * readMachine({ maxAgeMs }) gives the last scan (.studio/machine.json) or rescans when it is older; STUDIO_MACHINE_SCAN=off
 * turns all of it off (null profile: callers keep their old behaviour). sampleMachine() is the supervisor's resource
 * monitor: every STUDIO_MACHINE_SAMPLE_S (300) a scan, a compact machine.sample event and a line in
 * .studio/machine-history.jsonl (kept under STUDIO_MACHINE_HISTORY_KB, 256). diskBudget(): free space under
 * STUDIO_DISK_MIN_FREE_GB (default max(20, 5% of the disk)) is a machine.disk_low event, a digest line and a warning in
 * `task start` and train output, naming what the temp-file janitor can free when harness/janitor.mjs is there.
 *
 * No harness imports at load (ram.mjs imports this, and heavy.mjs and supervisor.mjs import ram.mjs).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readJson } from './fsafe.mjs';

export const MACHINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const machineFile = (root = MACHINE_ROOT) => path.join(root, '.studio', 'machine.json');
export const historyFile = (root = MACHINE_ROOT) => path.join(root, '.studio', 'machine-history.jsonl');
const diskStateFile = (root) => path.join(root, '.studio', 'machine-disk.json');

const GB = 1024 ** 3;
const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
const numOr = (v, d) => (v === undefined || v === null || String(v).trim() === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const isOff = (v) => /^(off|0|false|no)$/i.test(String(v ?? '').trim());
export const scanOff = (env = process.env) => isOff(env.STUDIO_MACHINE_SCAN);
export const sampleMs = (env = process.env) => Math.max(10, numOr(env.STUDIO_MACHINE_SAMPLE_S, 300)) * 1000;
const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };

/** The default probe runner: no shell, hidden window on Windows, a timeout. { ok, stdout, why }. */
export function defaultRun(cmd, args = [], { timeoutMs = 15000 } = {}) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    if (r.error) return { ok: false, stdout: '', why: r.error.code === 'ENOENT' ? `${cmd} not found` : r.error.code === 'ETIMEDOUT' ? `${cmd} timed out after ${timeoutMs} ms` : `${cmd}: ${r.error.message}` };
    // sysctl exits non-zero for one unknown name but prints the others: keep any output.
    if (r.status !== 0 && !String(r.stdout || '').trim()) return { ok: false, stdout: '', why: `${cmd} exited ${r.status}` };
    return { ok: true, stdout: String(r.stdout || '') };
  } catch (e) { return { ok: false, stdout: '', why: `${cmd}: ${e.message}` }; }
}
const defaultRead = (f) => fs.readFileSync(f, 'utf8');
const defaultList = (d) => fs.readdirSync(d);

/** CPU busy fraction from two os.cpus() samples `ms` apart (sync); null when unreadable. */
export function sampleCpuBusy({ cpus = os.cpus, wait = sleepSync, ms = 250 } = {}) {
  const sum = (list) => (list || []).reduce((a, c) => { const t = c?.times || {}; const b = (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.irq || 0); a.idle += t.idle || 0; a.total += b + (t.idle || 0); return a; }, { idle: 0, total: 0 });
  try { const a = sum(cpus()); wait(ms); const b = sum(cpus()); const tot = b.total - a.total; return tot > 0 ? Math.min(1, Math.max(0, 1 - (b.idle - a.idle) / tot)) : null; } catch { return null; }
}

/** Performance/efficiency cores from threads vs cores, where P cores have two threads and E cores one (Intel hybrid). */
function hybridFromThreads(physical, logical) {
  if (!(physical > 0 && logical > physical && logical < 2 * physical)) return { performance: null, efficiency: null };
  return { performance: logical - physical, efficiency: 2 * physical - logical };
}
const cpuListCount = (s) => String(s || '').trim().split(',').filter(Boolean).reduce((n, part) => { const [a, b] = part.split('-').map(Number); return n + (Number.isFinite(b) ? b - a + 1 : Number.isFinite(a) ? 1 : 0); }, 0);

/** nvidia-smi --query-gpu=name,memory.total,memory.used,utilization.gpu --format=csv,noheader,nounits → gpus. */
export function parseNvidiaSmi(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const f = line.split(',').map((x) => x.trim());
    if (f.length < 4 || !f[0]) continue;
    const total = Number(f[1]); const used = Number(f[2]); const util = Number(f[3]);
    out.push({ name: f[0], vramGb: Number.isFinite(total) ? r1(total / 1024) : null, vramFreeGb: Number.isFinite(total) && Number.isFinite(used) ? r1((total - used) / 1024) : null, busy: Number.isFinite(util) ? Math.round(util) / 100 : null, source: 'nvidia-smi' });
  }
  return out;
}

/** `ps -Ao rss=,pcpu=,comm=` (Linux and macOS) → top processes by memory: names only. */
export function parsePs(text, n = 10) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+(.+)$/);
    if (!m) continue;
    rows.push({ name: path.basename(m[3].trim()).slice(0, 60), mb: Math.round(Number(m[1]) / 1024), cpu: Number(m[2]) });
  }
  return rows.sort((a, b) => b.mb - a.mb).slice(0, n);
}

/** /proc/meminfo text → { totalGb, freeGb, commitUsedGb, commitLimitGb }. */
export function parseMeminfo(text) {
  const kb = (k) => { const m = String(text || '').match(new RegExp(`^${k}:\\s+(\\d+)`, 'm')); return m ? Number(m[1]) * 1024 : null; };
  const g = (b) => (b === null ? null : r1(b / GB));
  return { totalGb: g(kb('MemTotal')), freeGb: g(kb('MemAvailable') ?? kb('MemFree')), commitUsedGb: g(kb('Committed_AS')), commitLimitGb: g(kb('CommitLimit')) };
}

/** /proc/cpuinfo text → { model, physical, logical }. */
export function parseCpuinfo(text) {
  const blocks = String(text || '').split(/\n\s*\n/).filter((b) => /^processor\s*:/m.test(b));
  const field = (b, k) => { const m = b.match(new RegExp(`^${k}\\s*:\\s*(.*)$`, 'm')); return m ? m[1].trim() : null; };
  const cores = new Set();
  for (const b of blocks) { const pid = field(b, 'physical id'); const cid = field(b, 'core id'); if (cid !== null) cores.add(`${pid}:${cid}`); }
  return { model: blocks.length ? field(blocks[0], 'model name') : null, logical: blocks.length || null, physical: cores.size || null };
}

/** macOS `sysctl name ...` output ("name: value" lines) → { name: value }. */
export function parseSysctl(text) {
  const o = {};
  for (const line of String(text || '').split(/\r?\n/)) { const m = line.match(/^([\w.]+):\s*(.*)$/); if (m) o[m[1]] = m[2].trim(); }
  return o;
}

/** macOS vm_stat → free GB (free + inactive + speculative pages). */
export function parseVmStat(text) {
  const s = String(text || '');
  const page = Number((s.match(/page size of (\d+) bytes/) || [])[1]) || 4096;
  const pages = (k) => Number((s.match(new RegExp(`Pages ${k}:\\s+(\\d+)`)) || [])[1]);
  const free = ['free', 'inactive', 'speculative'].map(pages).filter(Number.isFinite);
  return free.length ? r1((free.reduce((a, b) => a + b, 0) * page) / GB) : null;
}

/** macOS `pmset -g batt` → { onBattery, percent }. */
export function parsePmset(text) {
  const s = String(text || '');
  if (!/drawing from/i.test(s)) return null;
  const pct = s.match(/(\d+)%/);
  return { onBattery: /'Battery Power'/i.test(s), percent: pct ? Number(pct[1]) : null };
}

/** macOS system_profiler SPDisplaysDataType -json → gpus (Apple Silicon: unified memory = RAM). */
export function parseSystemProfiler(text, ramGb = null) {
  let j = null;
  try { j = JSON.parse(text); } catch { return []; }
  return (j?.SPDisplaysDataType || []).map((g) => {
    const vram = String(g.spdisplays_vram || g.spdisplays_vram_shared || g['spdisplays_vram'] || '');
    const m = vram.match(/([\d.]+)\s*(GB|MB)/i);
    const unified = !m && /apple/i.test(String(g.sppci_model || g._name || ''));
    return { name: g.sppci_model || g._name || 'GPU', vramGb: m ? r1(Number(m[1]) / (/mb/i.test(m[2]) ? 1024 : 1)) : unified ? ramGb : null, vramFreeGb: null, busy: null, unified, source: 'system_profiler' };
  });
}

/** The one PowerShell call on Windows: CIM classes (names aren't localized, unlike Get-Counter paths), as JSON. */
export const WINDOWS_PS = [
  "$ErrorActionPreference='SilentlyContinue'", '$o=@{}',
  '$o.cpu=@(Get-CimInstance Win32_Processor | ForEach-Object { @{ name=$_.Name; cores=$_.NumberOfCores; logical=$_.NumberOfLogicalProcessors; load=$_.LoadPercentage } })',
  '$cs=Get-CimInstance Win32_ComputerSystem; $o.cs=@{ logical=$cs.NumberOfLogicalProcessors; ram=$cs.TotalPhysicalMemory }',
  '$w=Get-CimInstance Win32_OperatingSystem; $o.os=@{ caption=$w.Caption; totalKb=$w.TotalVisibleMemorySize; freeKb=$w.FreePhysicalMemory; virtTotalKb=$w.TotalVirtualMemorySize; virtFreeKb=$w.FreeVirtualMemory }',
  '$m=Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory; $o.mem=@{ committed=$m.CommittedBytes; limit=$m.CommitLimit; available=$m.AvailableBytes }',
  '$o.batt=@(Get-CimInstance Win32_Battery | ForEach-Object { @{ status=$_.BatteryStatus; pct=$_.EstimatedChargeRemaining } })',
  '$o.video=@(Get-CimInstance Win32_VideoController | ForEach-Object { @{ name=$_.Name; ram=$_.AdapterRAM } })',
  "$o.procs=@(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.Name -ne '_Total' -and $_.Name -ne 'Idle' } | Sort-Object WorkingSetPrivate -Descending | Select-Object -First 10 | ForEach-Object { @{ name=$_.Name; ws=$_.WorkingSetPrivate; cpu=$_.PercentProcessorTime } })",
  '$o | ConvertTo-Json -Depth 4 -Compress',
].join('; ');

/** The Windows JSON (WINDOWS_PS) → the profile's Windows fields. */
export function parseWindows(text) {
  let j = null;
  try { j = JSON.parse(String(text || '').trim()); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  const arr = (x) => (Array.isArray(x) ? x : x ? [x] : []);
  const cpus = arr(j.cpu);
  const physical = cpus.reduce((a, c) => a + (Number(c.cores) || 0), 0) || null;
  const logical = Number(j.cs?.logical) || cpus.reduce((a, c) => a + (Number(c.logical) || 0), 0) || null;
  const kbGb = (k) => (Number.isFinite(Number(k)) && k !== null ? r1((Number(k) * 1024) / GB) : null);
  const bGb = (b) => (Number.isFinite(Number(b)) && b !== null && b !== '' ? r1(Number(b) / GB) : null);
  let commitUsedGb = bGb(j.mem?.committed);
  let commitLimitGb = bGb(j.mem?.limit);
  if (commitUsedGb === null || commitLimitGb === null) {
    const vt = kbGb(j.os?.virtTotalKb); const vf = kbGb(j.os?.virtFreeKb);
    if (vt !== null && vf !== null) { commitLimitGb = vt; commitUsedGb = r1(vt - vf); }
  }
  const batt = arr(j.batt);
  const loads = cpus.map((c) => Number(c.load)).filter(Number.isFinite);
  return {
    osName: j.os?.caption || null,
    model: cpus[0]?.name ? String(cpus[0].name).trim() : null,
    physical, logical,
    busy: loads.length ? loads.reduce((a, b) => a + b, 0) / loads.length / 100 : null,
    ram: { totalGb: kbGb(j.os?.totalKb) ?? bGb(j.cs?.ram), freeGb: bGb(j.mem?.available) ?? kbGb(j.os?.freeKb), commitUsedGb, commitLimitGb },
    // BatteryStatus 1 = discharging (on battery); 2+ = on AC / charging. No battery: a desktop on mains.
    power: batt.length ? { onBattery: batt.some((b) => Number(b.status) === 1), percent: Number.isFinite(Number(batt[0].pct)) ? Number(batt[0].pct) : null, source: 'Win32_Battery' } : { onBattery: false, percent: null, source: 'no battery' },
    video: arr(j.video).map((v) => ({ name: String(v.name || 'GPU'), vramGb: null, vramFreeGb: null, busy: null, source: 'Win32_VideoController' })),
    processes: arr(j.procs).map((p) => ({ name: String(p.name || '?').replace(/#\d+$/, '').slice(0, 60), mb: Math.round((Number(p.ws) || 0) / 1024 / 1024), cpu: r1((Number(p.cpu) || 0) / Math.max(1, logical || 1)) })),
  };
}

/**
 * Scan the machine. Every source is injectable for tests: run(cmd, args, { timeoutMs }) → { ok, stdout, why },
 * read(file) → text (throws when missing), list(dir) → names, statfs(path) → { bavail, blocks, bsize }, cpus (os.cpus),
 * wait(ms), platform, arch, totalmem/freemem (fallbacks), now.
 */
export function scanMachine({ root = MACHINE_ROOT, env = process.env, platform = process.platform, arch = process.arch, run = defaultRun, read = defaultRead, list = defaultList, statfs = (p) => fs.statfsSync(p), cpus = os.cpus, wait = sleepSync, totalmem = os.totalmem, freemem = os.freemem, now = Date.now() } = {}) {
  const timeoutMs = Math.max(500, numOr(env.STUDIO_MACHINE_PROBE_TIMEOUT_MS, 15000));
  const errors = {};
  const probe = (field, fn) => { try { return fn(); } catch (e) { errors[field] = String(e?.message || e).slice(0, 200); return null; } };
  const call = (field, cmd, args) => { let r = null; try { r = run(cmd, args, { timeoutMs }); } catch (e) { r = { ok: false, why: `${cmd}: ${e.message}` }; } if (!r?.ok) { errors[field] = r?.why || `${cmd} failed`; return null; } return r.stdout; };
  let cpuList = [];
  try { cpuList = cpus() || []; } catch {}
  const p = {
    os: platform, arch, osName: null,
    cores: { logical: cpuList.length || null, physical: null, performance: null, efficiency: null, source: null },
    cpu: { model: cpuList[0]?.model ? String(cpuList[0].model).trim() : null, busy: null },
    ram: { totalGb: null, freeGb: null, commitUsedGb: null, commitLimitGb: null, pressure: null },
    gpus: [], disk: { path: root, freeGb: null, totalGb: null }, power: { onBattery: null, percent: null, source: null }, processes: [], errors,
  };
  if (platform === 'win32') {
    const out = call('windows', 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_PS]);
    const w = out === null ? null : parseWindows(out);
    if (out !== null && !w) errors.windows = 'the PowerShell output was not JSON';
    if (w) {
      p.osName = w.osName;
      p.cpu.model = w.model || p.cpu.model;
      p.cpu.busy = w.busy;
      p.cores.physical = w.physical;
      p.cores.logical = w.logical || p.cores.logical;
      Object.assign(p.cores, hybridFromThreads(w.physical, p.cores.logical));
      if (p.cores.performance !== null) p.cores.source = 'threads per core (Win32_Processor)';
      Object.assign(p.ram, w.ram);
      p.power = w.power;
      p.processes = w.processes;
      p.gpus = w.video;
    }
  } else if (platform === 'darwin') {
    const s = parseSysctl(call('sysctl', 'sysctl', ['hw.perflevel0.logicalcpu', 'hw.perflevel1.logicalcpu', 'hw.physicalcpu', 'hw.logicalcpu', 'hw.memsize', 'kern.memorystatus_level', 'machdep.cpu.brand_string']) || '');
    const n = (k) => (s[k] !== undefined && Number.isFinite(Number(s[k])) ? Number(s[k]) : null);
    p.cores.logical = n('hw.logicalcpu') ?? p.cores.logical;
    p.cores.physical = n('hw.physicalcpu');
    if (n('hw.perflevel0.logicalcpu') !== null) { p.cores.performance = n('hw.perflevel0.logicalcpu'); p.cores.efficiency = n('hw.perflevel1.logicalcpu') ?? 0; p.cores.source = 'sysctl hw.perflevel'; }
    if (s['machdep.cpu.brand_string']) p.cpu.model = s['machdep.cpu.brand_string'];
    if (n('hw.memsize') !== null) p.ram.totalGb = r1(n('hw.memsize') / GB);
    // kern.memorystatus_level: the percentage of memory free (what `memory_pressure` reports); low = pressure.
    if (n('kern.memorystatus_level') !== null) p.ram.pressure = n('kern.memorystatus_level') < 20 ? 'high' : n('kern.memorystatus_level') < 40 ? 'warn' : 'normal';
    const vm = call('vm_stat', 'vm_stat', []);
    if (vm !== null) p.ram.freeGb = parseVmStat(vm);
    const batt = call('power', 'pmset', ['-g', 'batt']);
    const pb = batt === null ? null : parsePmset(batt);
    if (pb) p.power = { ...pb, source: 'pmset' };
    const sp = call('gpu', 'system_profiler', ['SPDisplaysDataType', '-json']);
    if (sp !== null) p.gpus = parseSystemProfiler(sp, p.ram.totalGb ?? r1(totalmem() / GB));
  } else {
    const ci = probe('cores', () => parseCpuinfo(read('/proc/cpuinfo')));
    if (ci) {
      p.cores.logical = ci.logical ?? p.cores.logical; p.cores.physical = ci.physical; p.cpu.model = ci.model || p.cpu.model;
      // Intel hybrid on Linux: the kernel lists P cores under cpu_core and E cores under cpu_atom (logical CPUs).
      const pc = probe('hybrid', () => { try { return { p: cpuListCount(read('/sys/devices/cpu_core/cpus')), e: cpuListCount(read('/sys/devices/cpu_atom/cpus')) }; } catch { return null; } });
      if (pc && pc.p > 0) { p.cores.performance = pc.p; p.cores.efficiency = pc.e; p.cores.source = '/sys/devices/cpu_core,cpu_atom'; delete errors.hybrid; }
    }
    const mi = probe('ram', () => parseMeminfo(read('/proc/meminfo')));
    if (mi) Object.assign(p.ram, mi);
    probe('power', () => {
      let names = [];
      try { names = list('/sys/class/power_supply'); } catch { names = []; }
      let mains = null; let battery = null; let pct = null;
      for (const nm of names) {
        const at = (f) => { try { return String(read(`/sys/class/power_supply/${nm}/${f}`)).trim(); } catch { return null; } };
        const type = at('type');
        if (type === 'Mains' || type === 'USB') { const on = at('online'); if (on !== null) mains = (mains || false) || on === '1'; }
        if (type === 'Battery') { battery = at('status'); const c = Number(at('capacity')); if (Number.isFinite(c)) pct = c; }
      }
      p.power = { onBattery: battery === null && mains === null ? (names.length ? false : null) : battery === 'Discharging' || mains === false, percent: pct, source: names.length ? '/sys/class/power_supply' : null };
      return true;
    });
  }
  if (p.cores.physical && p.cores.performance === null && platform !== 'darwin' && platform !== 'win32') {
    Object.assign(p.cores, hybridFromThreads(p.cores.physical, p.cores.logical));
    if (p.cores.performance !== null) p.cores.source = 'threads per core (/proc/cpuinfo)';
  }
  // nvidia-smi (any OS): its numbers replace the Windows names-only list.
  let nv = null;
  try { nv = run('nvidia-smi', ['--query-gpu=name,memory.total,memory.used,utilization.gpu', '--format=csv,noheader,nounits'], { timeoutMs }); } catch (e) { nv = { ok: false, why: e.message }; }
  if (nv?.ok) { const g = parseNvidiaSmi(nv.stdout); if (g.length) p.gpus = [...g, ...p.gpus.filter((x) => !/nvidia/i.test(x.name) && !g.some((y) => y.name === x.name))]; }
  // Processes on Linux and macOS: ps (names only: comm, never the command line).
  if (platform !== 'win32') { const ps = call('processes', 'ps', ['-Ao', 'rss=,pcpu=,comm=']); if (ps !== null) p.processes = parsePs(ps); }
  if (p.cpu.busy === null) p.cpu.busy = sampleCpuBusy({ cpus, wait });
  if (p.ram.totalGb === null) p.ram.totalGb = probe('ram', () => r1(totalmem() / GB));
  if (p.ram.freeGb === null) p.ram.freeGb = probe('ram', () => r1(freemem() / GB));
  probe('disk', () => { const s = statfs(root); p.disk.freeGb = r1((Number(s.bavail) * Number(s.bsize)) / GB); p.disk.totalGb = r1((Number(s.blocks) * Number(s.bsize)) / GB); return true; });
  // 2.70.0 (w): the lane copies' total from the last lane disk report (harness/lane-disk.mjs; never measured here).
  { const l = readJson(path.join(root, '.studio', 'lanes', 'disk.json')); if (Number.isFinite(l?.totalGb)) p.disk.lanesGb = l.totalGb; }
  p.at = new Date(now).toISOString();
  return p;
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  try { fs.renameSync(tmp, file); } catch { fs.writeFileSync(file, text); try { fs.rmSync(tmp, { force: true }); } catch {} }
}
export function writeMachine(profile, root = MACHINE_ROOT) { try { writeAtomic(machineFile(root), `${JSON.stringify(profile, null, 2)}\n`); } catch {} return profile; }

/**
 * The machine profile: the last scan when younger than maxAgeMs (default 2 × STUDIO_MACHINE_SAMPLE_S), else a new scan
 * (written to .studio/machine.json) unless scan is false (then null). STUDIO_MACHINE_SCAN=off: null. Never throws.
 */
export function readMachine({ maxAgeMs = null, root = MACHINE_ROOT, env = process.env, scan = true, now = Date.now(), ...scanOpts } = {}) {
  if (scanOff(env)) return null;
  const max = Number.isFinite(maxAgeMs) && maxAgeMs !== null ? maxAgeMs : 2 * sampleMs(env);
  const last = readJson(machineFile(root));
  const t = Date.parse(last?.at || '');
  if (last && Number.isFinite(t) && now - t <= max && now - t >= -60000) return last;
  if (!scan) return null;
  try { return writeMachine(scanMachine({ root, env, now, ...scanOpts }), root); } catch { return null; }
}

/**
 * The memory a new job can still get, in GB: on Windows the smaller of free memory and commit headroom (limit - used;
 * the 2.68 research: "available" stayed 5.8 GB while commit was 55/60 GB and allocations failed); elsewhere free memory
 * (Linux's Committed_AS routinely passes CommitLimit under overcommit, so it isn't a limit there). null when unknown.
 */
export function memHeadroomGb(profile) {
  const r = profile?.ram;
  if (!r) return null;
  const free = Number.isFinite(r.freeGb) ? r.freeGb : null;
  const commit = profile.os === 'win32' && Number.isFinite(r.commitLimitGb) && Number.isFinite(r.commitUsedGb) ? r1(Math.max(0, r.commitLimitGb - r.commitUsedGb)) : null;
  if (free === null) return commit;
  return commit === null ? free : Math.min(free, commit);
}

const fmt = (x) => (x === null || x === undefined || !Number.isFinite(Number(x)) ? '?' : String(Math.round(Number(x) * 10) / 10).replace(/\.0$/, ''));
const pct = (f) => `${Math.round(Number(f) * 100)}%`;
/** "Machine: RAM 26/32 GB (commit 55/60), CPU 32%, GPU 1% (1.8/12 GB), disk 130 GB free" ('' with no profile). */
export function machineLine(p) {
  if (!p) return '';
  const r = p.ram || {};
  const parts = [];
  const used = Number.isFinite(r.totalGb) && Number.isFinite(r.freeGb) ? r.totalGb - r.freeGb : null;
  parts.push(`RAM ${fmt(used)}/${fmt(r.totalGb)} GB${Number.isFinite(r.commitUsedGb) && Number.isFinite(r.commitLimitGb) && p.os === 'win32' ? ` (commit ${fmt(r.commitUsedGb)}/${fmt(r.commitLimitGb)})` : r.pressure && r.pressure !== 'normal' ? ` (pressure ${r.pressure})` : ''}`);
  parts.push(`CPU ${Number.isFinite(p.cpu?.busy) ? pct(p.cpu.busy) : '?'}`);
  const g = (p.gpus || [])[0];
  if (g) parts.push(`GPU ${Number.isFinite(g.busy) ? pct(g.busy) : '?'}${Number.isFinite(g.vramGb) ? ` (${Number.isFinite(g.vramFreeGb) ? `${fmt(g.vramGb - g.vramFreeGb)}/` : ''}${fmt(g.vramGb)} GB${g.unified ? ' unified' : ''})` : ''}`);
  else parts.push('no GPU found');
  parts.push(`disk ${fmt(p.disk?.freeGb)} GB free${Number.isFinite(p.disk?.lanesGb) ? ` (lane copies ${fmt(p.disk.lanesGb)} GB)` : ''}`);
  if (p.power?.onBattery) parts.push(`on battery${Number.isFinite(p.power.percent) ? ` ${p.power.percent}%` : ''}`);
  return `Machine: ${parts.join(', ')}`;
}

/** The fields the War Room card shows (from the last scan only; never scans: the hub snapshot is built often). */
export function machineCard(root = MACHINE_ROOT, env = process.env) {
  if (scanOff(env)) return null;
  const p = readJson(machineFile(root));
  if (!p?.at) return null;
  return { at: p.at, line: machineLine(p), os: p.os, cores: p.cores, cpuBusy: p.cpu?.busy ?? null, ram: p.ram, headroomGb: memHeadroomGb(p), gpus: p.gpus, disk: p.disk, power: p.power, processes: (p.processes || []).slice(0, 10), disk_low: diskBudget({ root, env, profile: p }).low };
}

// ---- the disk budget -----------------------------------------------------------------------------------------------

/** Free space on the studio's disk against STUDIO_DISK_MIN_FREE_GB (default max(20, 5% of the disk)). Cheap: one statfs. */
export function diskBudget({ root = MACHINE_ROOT, env = process.env, statfs = (p) => fs.statfsSync(p), profile = null } = {}) {
  let freeGb = profile?.disk?.freeGb ?? null; let totalGb = profile?.disk?.totalGb ?? null;
  if (freeGb === null) { try { const s = statfs(root); freeGb = r1((Number(s.bavail) * Number(s.bsize)) / GB); totalGb = r1((Number(s.blocks) * Number(s.bsize)) / GB); } catch { return { low: false, freeGb: null, totalGb: null, minGb: null }; } }
  const minGb = numOr(env.STUDIO_DISK_MIN_FREE_GB, Math.max(20, Number.isFinite(totalGb) ? r1(totalGb * 0.05) : 20));
  const low = minGb > 0 && Number.isFinite(freeGb) && freeGb < minGb;
  return { low, freeGb, totalGb, minGb, why: low ? `disk low: ${fmt(freeGb)} GB free (under ${fmt(minGb)} GB, STUDIO_DISK_MIN_FREE_GB)` : '' };
}

/** What the temp-file janitor (harness/janitor.mjs, when present) says it can free, in GB, or null. */
export async function janitorFreeableGb(root = MACHINE_ROOT, hook = null) {
  try {
    let fn = hook;
    if (!fn) {
      const f = path.join(path.dirname(fileURLToPath(import.meta.url)), 'janitor.mjs');
      if (!fs.existsSync(f)) return null;
      const m = await import('./janitor.mjs');
      fn = m.janitorFreeableGb || m.freeableGb || null;
    }
    if (typeof fn !== 'function') return null;
    const v = await fn({ root });
    const gb = typeof v === 'number' ? v : Number.isFinite(v?.gb) ? v.gb : Number.isFinite(v?.bytes) ? v.bytes / GB : null;
    return Number.isFinite(gb) ? r1(gb) : null;
  } catch { return null; }
}

/** The warning line for `task start` and the train ('' when the disk is fine or the scan is off). */
export async function diskWarning({ root = MACHINE_ROOT, env = process.env, statfs, janitor = null } = {}) {
  if (scanOff(env)) return '';
  const d = diskBudget({ root, env, ...(statfs ? { statfs } : {}) });
  if (!d.low) return '';
  const can = await janitorFreeableGb(root, janitor);
  return `${d.why}; ${can !== null ? `the janitor can free ${fmt(can)} GB (npm run janitor)` : 'free space on that disk (old lane copies, logs, caches)'}`;
}

/** The digest's line: the last machine.disk_low event in 24 h ('' when none). */
export function diskDigestLine(events, now = Date.now()) {
  const e = (events || []).filter((x) => x.type === 'machine.disk_low' && (Date.parse(x.ts) || 0) >= now - 86400000).pop();
  return e ? `Disk low: ${e.msg || 'under STUDIO_DISK_MIN_FREE_GB'} (npm run machine).` : '';
}

// ---- the resource monitor ------------------------------------------------------------------------------------------

/** A compact sample for the history and the event. */
export function compactSample(p) {
  const g = (p.gpus || [])[0];
  return { at: p.at, ram: [r1((p.ram?.totalGb ?? 0) - (p.ram?.freeGb ?? 0)), p.ram?.totalGb ?? null], ...(p.os === 'win32' && Number.isFinite(p.ram?.commitUsedGb) ? { commit: [p.ram.commitUsedGb, p.ram.commitLimitGb] } : {}), cpu: Number.isFinite(p.cpu?.busy) ? Math.round(p.cpu.busy * 100) : null, ...(g ? { gpu: [Number.isFinite(g.busy) ? Math.round(g.busy * 100) : null, Number.isFinite(g.vramGb) && Number.isFinite(g.vramFreeGb) ? r1(g.vramGb - g.vramFreeGb) : null, g.vramGb ?? null] } : {}), disk: p.disk?.freeGb ?? null, ...(p.power?.onBattery ? { battery: p.power.percent ?? true } : {}) };
}

/** Append one line to .studio/machine-history.jsonl; over STUDIO_MACHINE_HISTORY_KB (256) keep the newest half. */
export function appendHistory(root, sample, env = process.env) {
  const f = historyFile(root);
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, `${JSON.stringify(sample)}\n`);
    const cap = Math.max(4, numOr(env.STUDIO_MACHINE_HISTORY_KB, 256)) * 1024;
    if (fs.statSync(f).size > cap) {
      const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
      let keep = lines.slice(Math.floor(lines.length / 2));
      while (keep.length > 1 && Buffer.byteLength(keep.join('\n')) > cap / 2) keep = keep.slice(1);
      writeAtomic(f, `${keep.join('\n')}\n`);
    }
  } catch {}
}

/**
 * The supervisor's resource monitor, called every pass: when the last scan is older than STUDIO_MACHINE_SAMPLE_S, scan,
 * write machine.json, append the history and emit machine.sample; when the disk is under its budget, a machine.disk_low
 * event (at most every 6 h). Returns { sampled, profile, disk } or null when off. emit defaults to event.mjs emitEvent.
 */
export async function sampleMachine({ root = MACHINE_ROOT, env = process.env, now = Date.now(), emit = null, ...scanOpts } = {}) {
  if (scanOff(env)) return null;
  const last = readJson(machineFile(root));
  const t = Date.parse(last?.at || '');
  if (last && Number.isFinite(t) && now - t < sampleMs(env) && now >= t) return { sampled: false, profile: last };
  const p = writeMachine(scanMachine({ root, env, now, ...scanOpts }), root);
  const s = compactSample(p);
  appendHistory(root, s, env);
  const send = emit || (await import('./event.mjs')).emitEvent;
  try { (await import('./telemetry.mjs')).emitSampled({ type: 'machine.sample', agent: 'supervisor', msg: machineLine(p), meta: s }, 'sample', { now, emit: send, env }); } catch {}
  const disk = diskBudget({ root, env, profile: p });
  if (disk.low) {
    const st = readJson(diskStateFile(root)) || {};
    if (!(now - (Date.parse(st.lowAt || '') || 0) < 6 * 3600000)) {
      const can = await janitorFreeableGb(root, scanOpts.janitor || null);
      try { send({ type: 'machine.disk_low', agent: 'supervisor', to: 'producer', msg: `${disk.why}${can !== null ? `; the janitor can free ${fmt(can)} GB` : ''}`, meta: { freeGb: disk.freeGb, minGb: disk.minGb, janitorGb: can } }); } catch {}
      try { writeAtomic(diskStateFile(root), `${JSON.stringify({ lowAt: new Date(now).toISOString() })}\n`); } catch {}
    }
  }
  return { sampled: true, profile: p, disk };
}

// ---- CLI -----------------------------------------------------------------------------------------------------------

function text(p) {
  const L = [machineLine(p)];
  L.push(`OS: ${p.osName || p.os} ${p.arch}; cores: ${p.cores.logical ?? '?'} logical${p.cores.physical ? `, ${p.cores.physical} physical` : ''}${p.cores.performance !== null ? ` (${p.cores.performance} performance + ${p.cores.efficiency} efficiency, ${p.cores.source})` : ''}${p.cpu.model ? `; ${p.cpu.model}` : ''}`);
  for (const g of p.gpus) L.push(`GPU: ${g.name}${Number.isFinite(g.vramGb) ? `, ${fmt(g.vramGb)} GB${g.unified ? ' unified' : ''}` : ''}${Number.isFinite(g.vramFreeGb) ? ` (${fmt(g.vramFreeGb)} free)` : ''}${Number.isFinite(g.busy) ? `, ${pct(g.busy)} busy` : ''}`);
  L.push(`Disk: ${fmt(p.disk.freeGb)} of ${fmt(p.disk.totalGb)} GB free${Number.isFinite(p.disk.lanesGb) ? `, lane copies ${fmt(p.disk.lanesGb)} GB (npm run lanes -- disk)` : ''}; power: ${p.power.onBattery === null ? 'unknown' : p.power.onBattery ? `battery${Number.isFinite(p.power.percent) ? ` ${p.power.percent}%` : ''}` : 'mains'}`);
  if (p.processes.length) L.push(`Top processes by memory: ${p.processes.map((x) => `${x.name} ${x.mb} MB${Number.isFinite(x.cpu) ? ` ${fmt(x.cpu)}%` : ''}`).join(', ')}`);
  const errs = Object.entries(p.errors || {});
  if (errs.length) L.push(`Not read: ${errs.map(([k, v]) => `${k} (${v})`).join('; ')}`);
  return L.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h') || argv.some((a) => !['--json', '--cached'].includes(a))) {
    console.log('Usage: npm run machine [-- --json] [--cached]   (scan the machine; --cached: the last scan, no new one)');
    process.exit(argv.includes('--help') || argv.includes('-h') ? 0 : 2);
  }
  if (scanOff()) { console.log(argv.includes('--json') ? 'null' : 'The machine scan is off (STUDIO_MACHINE_SCAN=off).'); process.exit(0); }
  const p = argv.includes('--cached') ? readMachine({ scan: false, maxAgeMs: Infinity }) : writeMachine(scanMachine());
  if (!p) { console.log(argv.includes('--json') ? 'null' : 'No scan yet: npm run machine'); process.exit(0); }
  console.log(argv.includes('--json') ? JSON.stringify(p, null, 2) : text(p));
}
