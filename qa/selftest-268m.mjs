/**
 * qa/selftest-268m.mjs — 2.68.0 (m): the machine scan, the resource monitor and the disk budget (harness/machine.mjs).
 * Every probe is stubbed (no PowerShell, sysctl or nvidia-smi on CI): Windows CIM JSON, macOS sysctl/vm_stat/pmset/
 * system_profiler text, Linux /proc text; nvidia-smi present and absent; failed probes give nulls, not a crash; the
 * one-line summary in status --brief and lanes; the disk-low warning in task start, the train hook and the digest;
 * ramCheck using the commit headroom on Windows. Each check fails on 2.67.2 (no harness/machine.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const GB = 1024 ** 3;
// The crew's PC (the 2.68 research): i7 20 cores / 28 threads, 32 GB with 55/60 GB committed, RTX 12 GB, 1 TB disk.
const WIN_JSON = JSON.stringify({
  cpu: [{ name: 'Example 20-core CPU', cores: 20, logical: 28, load: 32 }],
  cs: { logical: 28, ram: 32 * GB },
  os: { caption: 'Windows 11 Pro', totalKb: 32 * 1024 * 1024, freeKb: 6 * 1024 * 1024, virtTotalKb: 60 * 1024 * 1024, virtFreeKb: 5 * 1024 * 1024 },
  mem: { committed: 55 * GB, limit: 60 * GB, available: 6 * GB },
  batt: null,
  video: { name: 'Example GPU 12GB', ram: 4293918720 },
  procs: [{ name: 'editor', ws: 4 * GB, cpu: 56 }, { name: 'browser#2', ws: 1.5 * GB, cpu: 0 }],
});
const NV = 'Example GPU 12GB, 12282, 1843, 1\n';
const stubRun = (map) => (cmd, args) => {
  const v = map[cmd];
  if (v === undefined) return { ok: false, stdout: '', why: `${cmd} not found` };
  if (v instanceof Error) throw v;
  return typeof v === 'object' ? v : { ok: true, stdout: v };
};
const statfs130 = () => ({ bavail: (130 * GB) / 4096, blocks: (931 * GB) / 4096, bsize: 4096 });
const idleCpus = (() => { let n = 0; return () => { n += 1; return [{ times: { user: n * 32, nice: 0, sys: 0, irq: 0, idle: n * 68 } }]; }; })();

// The same machine as a written profile (so the brief and ramCheck checks don't need machine.mjs to set up).
const winLiteral = () => ({ os: 'win32', arch: 'x64', osName: 'Windows 11 Pro', cores: { logical: 28, physical: 20, performance: 8, efficiency: 12, source: 'threads per core (Win32_Processor)' }, cpu: { model: 'Example 20-core CPU', busy: 0.32 },
  ram: { totalGb: 32, freeGb: 6, commitUsedGb: 55, commitLimitGb: 60, pressure: null }, gpus: [{ name: 'Example GPU 12GB', vramGb: 12, vramFreeGb: 10.2, busy: 0.01, source: 'nvidia-smi' }],
  disk: { path: '.', freeGb: 130, totalGb: 931 }, power: { onBattery: false, percent: null, source: 'no battery' }, processes: [{ name: 'editor', mb: 4096, cpu: 2 }], errors: {}, at: new Date().toISOString() });

export async function selftest268M({ dir, run, report, tmpRoot }) {
  const env = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off' };
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const guard = async (name, fn) => { try { const r = await fn(); report(name, r === true || r?.ok === true, r?.detail ?? JSON.stringify(r).slice(0, 2500)); } catch (e) { report(name, false, e.stack || e.message); } };
  const imp = (p) => import(pathToFileURL(path.join(dir, p)).href);
  const probe = (name, code, extra = {}) => {
    const f = path.join(dir, `.probe-268m-${name}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node ${path.basename(f)}`, { ...env, ...extra });
    try { fs.rmSync(f, { force: true }); } catch {}
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return { ...JSON.parse(line), _err: r.stderr }; } catch { return { _raw: out(r).slice(-1500) }; }
  };
  const mfile = path.join(dir, '.studio', 'machine.json');
  const winProfile = async (now = Date.now()) => (await imp('harness/machine.mjs')).scanMachine({ root: dir, platform: 'win32', arch: 'x64', run: stubRun({ 'powershell.exe': WIN_JSON, 'nvidia-smi': NV }), statfs: statfs130, cpus: idleCpus, wait: () => {}, now });

  await guard('2.68.0 (m): a Windows scan from stubbed CIM JSON and nvidia-smi: 8 performance + 12 efficiency cores from 20 cores/28 threads, RAM 32 GB with commit 55/60, the GPU with VRAM and busy, no battery = mains, processes by name only, and the one-line summary (fails on 2.67.2: no harness/machine.mjs)', async () => {
    const m = await imp('harness/machine.mjs');
    const p = await winProfile();
    const line = m.machineLine(p);
    const ok = p.os === 'win32' && p.cores.logical === 28 && p.cores.physical === 20 && p.cores.performance === 8 && p.cores.efficiency === 12
      && p.ram.totalGb === 32 && p.ram.commitUsedGb === 55 && p.ram.commitLimitGb === 60 && p.gpus.length === 1 && p.gpus[0].vramGb === 12 && p.gpus[0].busy === 0.01
      && p.power.onBattery === false && p.processes[0].name === 'editor' && p.processes[0].mb === 4096 && p.processes[1].name === 'browser' && p.processes.every((x) => Object.keys(x).sort().join() === 'cpu,mb,name')
      && line === 'Machine: RAM 26/32 GB (commit 55/60), CPU 32%, GPU 1% (1.8/12 GB), disk 130 GB free' && m.memHeadroomGb(p) === 5;
    return { ok, detail: JSON.stringify({ line, p }).slice(0, 2500) };
  });

  await guard('2.68.0 (m): a macOS scan from stubbed sysctl, vm_stat, pmset and system_profiler: performance vs efficiency cores from hw.perflevel, unified memory as the GPU memory, on battery 76%, no commit charge in the line; nvidia-smi absent leaves no error (fails on 2.67.2)', async () => {
    const m = await imp('harness/machine.mjs');
    const p = m.scanMachine({ root: dir, platform: 'darwin', arch: 'arm64', statfs: statfs130, cpus: idleCpus, wait: () => {}, run: stubRun({
      sysctl: 'hw.perflevel0.logicalcpu: 10\nhw.perflevel1.logicalcpu: 4\nhw.physicalcpu: 14\nhw.logicalcpu: 14\nhw.memsize: 38654705664\nkern.memorystatus_level: 30\n',
      vm_stat: 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                               262144.\nPages active:                             900000.\nPages inactive:                           131072.\nPages speculative:                         65536.\n',
      pmset: "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1234)\t76%; discharging; 4:10 remaining present: true\n",
      system_profiler: JSON.stringify({ SPDisplaysDataType: [{ _name: 'Apple M3 Pro', sppci_model: 'Apple M3 Pro', sppci_cores: '18' }] }),
      ps: '  2048000  12.5 /Applications/Editor.app/Contents/MacOS/Editor\n   512000   1.0 /usr/sbin/somed\n',
    }) });
    const line = m.machineLine(p);
    const ok = p.cores.performance === 10 && p.cores.efficiency === 4 && p.cores.logical === 14 && p.ram.totalGb === 36 && p.ram.freeGb === 7 && p.ram.pressure === 'warn' && p.ram.commitUsedGb === null
      && p.gpus[0]?.name === 'Apple M3 Pro' && p.gpus[0].unified === true && p.gpus[0].vramGb === 36 && p.power.onBattery === true && p.power.percent === 76
      && p.processes[0].name === 'Editor' && p.processes[0].mb === 2000 && !('gpu' in p.errors) && /^Machine: RAM 29\/36 GB \(pressure warn\), CPU 32%, GPU \? \(36 GB unified\), disk 130 GB free, on battery 76%$/.test(line);
    return { ok, detail: JSON.stringify({ line, p }).slice(0, 2500) };
  });

  await guard('2.68.0 (m): a Linux scan from stubbed /proc and /sys text: hybrid cores from cpu_core/cpu_atom, MemAvailable and Committed_AS/CommitLimit, mains power; nvidia-smi present gives the GPU, absent gives none (fails on 2.67.2)', async () => {
    const m = await imp('harness/machine.mjs');
    const cpuinfo = Array.from({ length: 6 }, (_, i) => `processor\t: ${i}\nmodel name\t: Example CPU\nphysical id\t: 0\ncore id\t\t: ${i < 4 ? Math.floor(i / 2) : i - 2}\n`).join('\n');
    const files = {
      '/proc/cpuinfo': cpuinfo, '/sys/devices/cpu_core/cpus': '0-3\n', '/sys/devices/cpu_atom/cpus': '4-5\n',
      '/proc/meminfo': 'MemTotal:       16384000 kB\nMemFree:         1000000 kB\nMemAvailable:    8192000 kB\nCommitLimit:    12000000 kB\nCommitted_AS:   20000000 kB\n',
      '/sys/class/power_supply/AC/type': 'Mains\n', '/sys/class/power_supply/AC/online': '1\n',
    };
    const read = (f) => { if (f in files) return files[f]; throw new Error(`ENOENT ${f}`); };
    const base = { root: dir, platform: 'linux', arch: 'x64', read, list: (d) => (d === '/sys/class/power_supply' ? ['AC'] : []), statfs: statfs130, cpus: idleCpus, wait: () => {} };
    const ps = '  900000  3.0 node\n';
    const withGpu = m.scanMachine({ ...base, run: stubRun({ 'nvidia-smi': NV, ps }) });
    const noGpu = m.scanMachine({ ...base, run: stubRun({ ps }) });
    const ok = withGpu.cores.logical === 6 && withGpu.cores.physical === 4 && withGpu.cores.performance === 4 && withGpu.cores.efficiency === 2 && withGpu.ram.freeGb === 7.8 && withGpu.ram.totalGb === 15.6
      && withGpu.ram.commitUsedGb === 19.1 && withGpu.power.onBattery === false && withGpu.gpus[0]?.vramGb === 12 && noGpu.gpus.length === 0 && /no GPU found/.test(m.machineLine(noGpu))
      && !/commit/.test(m.machineLine(withGpu)) && m.memHeadroomGb(withGpu) === 7.8;
    return { ok, detail: JSON.stringify({ withGpu, noGpu: m.machineLine(noGpu) }).slice(0, 2500) };
  });

  await guard('2.68.0 (m): failed probes give nulls and reasons, never a crash: PowerShell timing out, a probe that throws, unreadable /proc, a failing statfs and garbage output (fails on 2.67.2)', async () => {
    const m = await imp('harness/machine.mjs');
    const bad = () => { throw new Error('EACCES'); };
    const w = m.scanMachine({ root: dir, platform: 'win32', run: stubRun({ 'powershell.exe': { ok: false, stdout: '', why: 'powershell.exe timed out after 15000 ms' }, 'nvidia-smi': new Error('spawn EPERM') }), statfs: bad, cpus: () => [], wait: () => {}, totalmem: bad, freemem: bad });
    const g = m.scanMachine({ root: dir, platform: 'win32', run: stubRun({ 'powershell.exe': 'not json at all' }), statfs: bad, cpus: idleCpus, wait: () => {} });
    const l = m.scanMachine({ root: dir, platform: 'linux', read: bad, list: bad, run: stubRun({}), statfs: bad, cpus: idleCpus, wait: () => {} });
    const ok = w.ram.totalGb === null && w.ram.commitLimitGb === null && w.disk.freeGb === null && w.gpus.length === 0 && /timed out/.test(w.errors.windows) && w.errors.disk
      && /not JSON/.test(g.errors.windows) && l.cores.physical === null && l.errors.ram && l.errors.processes && l.ram.totalGb > 0 && l.errors.disk && typeof m.machineLine(w) === 'string'
      && m.diskBudget({ root: dir, statfs: bad }).low === false;
    return { ok, detail: JSON.stringify({ w, g: g.errors, l: l.errors }).slice(0, 2500) };
  });

  await guard('2.68.0 (m): readMachine writes .studio/machine.json, gives the last scan while it is fresh, rescans when stale, and STUDIO_MACHINE_SCAN=off gives null (fails on 2.67.2)', async () => {
    const m = await imp('harness/machine.mjs');
    let scans = 0;
    const opts = { root: dir, platform: 'win32', run: (c, a) => { if (c === 'powershell.exe') scans += 1; return stubRun({ 'powershell.exe': WIN_JSON })(c, a); }, statfs: statfs130, cpus: idleCpus, wait: () => {} };
    fs.rmSync(mfile, { force: true });
    const t = Date.now();
    const a = m.readMachine({ ...opts, maxAgeMs: 60000, now: t });
    const b = m.readMachine({ ...opts, maxAgeMs: 60000, now: t + 30000 });
    const c = m.readMachine({ ...opts, maxAgeMs: 60000, now: t + 120000 });
    const d = m.readMachine({ ...opts, maxAgeMs: 60000, now: t + 999999, scan: false });
    const off = m.readMachine({ ...opts, env: { STUDIO_MACHINE_SCAN: 'off' } });
    const onDisk = JSON.parse(fs.readFileSync(mfile, 'utf8'));
    fs.rmSync(mfile, { force: true });
    return { ok: a?.ram?.commitLimitGb === 60 && b?.at === a.at && scans === 2 && c.at !== a.at && d === null && off === null && onDisk.at === c.at, detail: JSON.stringify({ scans, a: a?.at, b: b?.at, c: c?.at, d, off }) };
  });

  await guard('2.68.0 (m): the resource monitor samples once per STUDIO_MACHINE_SAMPLE_S into a compact machine.sample event and .studio/machine-history.jsonl (capped by STUDIO_MACHINE_HISTORY_KB), and a low disk is one machine.disk_low event naming what the janitor can free (fails on 2.67.2)', async () => {
    const m = await imp('harness/machine.mjs');
    fs.rmSync(mfile, { force: true });
    const hist = path.join(dir, '.studio', 'machine-history.jsonl');
    fs.rmSync(hist, { force: true });
    fs.rmSync(path.join(dir, '.studio', 'machine-disk.json'), { force: true });
    const ev = [];
    const e2 = { STUDIO_TELEMETRY: 'full', /* 2.79 (f): machine.sample is one hourly summary by default; this check counts every sample */ STUDIO_MACHINE_SAMPLE_S: '300', STUDIO_MACHINE_HISTORY_KB: '4', STUDIO_DISK_MIN_FREE_GB: '200' };
    const opts = { root: dir, env: e2, platform: 'win32', run: stubRun({ 'powershell.exe': WIN_JSON, 'nvidia-smi': NV }), statfs: statfs130, cpus: idleCpus, wait: () => {}, emit: (e) => ev.push(e), janitor: () => ({ gb: 4.2 }) };
    const t0 = Date.now();
    const first = await m.sampleMachine({ ...opts, now: t0 });
    const again = await m.sampleMachine({ ...opts, now: t0 + 60000 });
    for (let i = 1; i <= 60; i += 1) await m.sampleMachine({ ...opts, now: t0 + i * 301000 });
    const size = fs.statSync(hist).size;
    const lines = fs.readFileSync(hist, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const samples = ev.filter((e) => e.type === 'machine.sample');
    const low = ev.filter((e) => e.type === 'machine.disk_low');
    const off = await m.sampleMachine({ ...opts, env: { STUDIO_MACHINE_SCAN: 'off' } });
    for (const f of [mfile, hist, path.join(dir, '.studio', 'machine-disk.json')]) fs.rmSync(f, { force: true });
    const ok = first.sampled && !again.sampled && samples.length === 61 && samples[0].msg.startsWith('Machine: RAM 26/32 GB (commit 55/60)') && JSON.stringify(samples[0].meta).length < 200
      && size <= 4096 && lines.length > 3 && lines.at(-1).commit[0] === 55 && low.length === 1 && /disk low: 130 GB free \(under 200 GB/.test(low[0].msg) && /janitor can free 4\.2 GB/.test(low[0].msg) && off === null;
    return { ok, detail: JSON.stringify({ first: first.sampled, again: again.sampled, samples: samples.length, low: low.map((e) => e.msg), size, lines: lines.length, meta: samples[0]?.meta }) };
  });

  await guard('2.68.0 (m): `status --brief` and `npm run lanes` print the machine line from the last scan ("Machine: RAM 26/32 GB (commit 55/60), CPU 32%, GPU 1% (1.8/12 GB), disk 130 GB free"), the brief stays under 100 words, and the War Room snapshot carries the fields (fails on 2.67.2: no machine line)', async () => {
    fs.mkdirSync(path.dirname(mfile), { recursive: true });
    fs.writeFileSync(mfile, JSON.stringify(winLiteral()));
    const want = 'Machine: RAM 26/32 GB (commit 55/60), CPU 32%, GPU 1% (1.8/12 GB), disk 130 GB free';
    const b = run(dir, 'node harness/status.mjs --brief --peek --json', { ...env, STUDIO_TEST_FREEMEM_MB: '5300' });
    let j = null; try { j = JSON.parse(b.stdout.trim().split('\n').pop()); } catch {}
    const lanes = run(dir, 'node harness/lanes.mjs --no-stamps', env);
    const snap = probe('snap', "const { buildStudioSnapshot } = await import('./harness/status.mjs'); const s = buildStudioSnapshot(); console.log(JSON.stringify({ m: s.machine }));");
    fs.rmSync(mfile, { force: true });
    const ok = j && j.text.includes(`${want}.`) && j.words < 100 && /PC: 5\.2 GB free/.test(j.text) && out(lanes).includes(want) && snap.m?.line === want && snap.m.ram.commitLimitGb === 60 && snap.m.headroomGb === 5 && snap.m.gpus[0].vramGb === 12;
    return { ok, detail: `${j?.text}\n--- lanes:\n${out(lanes).slice(-800)}\n--- snap: ${JSON.stringify(snap).slice(0, 600)}` };
  });

  await guard('2.68.0 (m): the disk budget: under STUDIO_DISK_MIN_FREE_GB `task start` warns "disk low: N GB free", the train hook says what the janitor can free, the default floor is max(20 GB, 5% of the disk), and the digest has a line for a machine.disk_low event (fails on 2.67.2)', async () => {
    const st = run(dir, 'node harness/task.mjs start T-004 --agent disk-1', { ...env, STUDIO_LOCK_OWNER: 'disk-1', STUDIO_DISK_MIN_FREE_GB: '999999' });
    const m = await imp('harness/machine.mjs');
    const w = await m.diskWarning({ root: dir, env: { STUDIO_DISK_MIN_FREE_GB: '200' }, statfs: statfs130, janitor: async () => 3.25 });
    const none = await m.diskWarning({ root: dir, env: {}, statfs: statfs130 });
    const big = m.diskBudget({ root: dir, env: {}, statfs: () => ({ bavail: (60 * GB) / 4096, blocks: (2000 * GB) / 4096, bsize: 4096 }) });
    const { buildDigest } = await imp('harness/digest.mjs');
    const now = Date.now();
    const d = await buildDigest({ now, root: dir, events: [{ ts: new Date(now - 3600000).toISOString(), type: 'machine.disk_low', msg: 'disk low: 12 GB free (under 46.6 GB, STUDIO_DISK_MIN_FREE_GB)' }] });
    const ok = st.status === 0 && /Warning: disk low: [\d.]+ GB free \(under 999999 GB, STUDIO_DISK_MIN_FREE_GB\)/.test(st.stderr) && /disk low: 130 GB free \(under 200 GB.*the janitor can free 3\.3 GB \(npm run janitor\)/.test(w) && none === ''
      && big.minGb === 100 && big.low === true && /Disk low: disk low: 12 GB free/.test(d.text);
    return { ok, detail: `${out(st).slice(-1200)}\n--- ${w}\n--- ${JSON.stringify(big)}\n--- ${d.text}` };
  });

  await guard('2.68.0 (m): ramCheck uses the commit headroom on Windows: 5.8 GB "available" with 58/60 GB committed is under the 3 GB floor (low, and the reason names the commit), read from .studio/machine.json; a Linux scan and STUDIO_MACHINE_SCAN=off keep the old reading (fails on 2.67.2: free memory alone, never low)', async () => {
    const p = winLiteral();
    p.ram.commitUsedGb = 58;
    fs.mkdirSync(path.dirname(mfile), { recursive: true });
    fs.writeFileSync(mfile, JSON.stringify(p));
    const code = "const { ramCheck } = await import('./harness/ram.mjs'); console.log(JSON.stringify(ramCheck({}, process.env)));";
    // The full selftest runs every check with STUDIO_RAM_FLOOR_GB=0 (CLEAN_ENV); this check is about the 3 GB floor, so it
    // sets it (CI release-gate 22: floorGb 0 there).
    const floor = { STUDIO_RAM_FLOOR_GB: '3' };
    const win = probe('ram-win', code, { ...floor, STUDIO_TEST_FREEMEM_MB: String(5.8 * 1024) });
    const off = probe('ram-off', code, { ...floor, STUDIO_TEST_FREEMEM_MB: String(5.8 * 1024), STUDIO_MACHINE_SCAN: 'off' });
    fs.writeFileSync(mfile, JSON.stringify({ ...p, os: 'linux' }));
    const lin = probe('ram-lin', code, { ...floor, STUDIO_TEST_FREEMEM_MB: String(5.8 * 1024) });
    fs.rmSync(mfile, { force: true });
    const { ramCheck } = await imp('harness/ram.mjs');
    const inj = ramCheck({ freemem: () => 5.8 * GB, machine: p }, {});
    const ok = win.low === true && win.freeGb === 2 && /commit headroom 2 GB \(58\/60 GB committed; 5\.8 GB available\)/.test(win.why) && off.low === false && off.freeGb === 5.8 && lin.low === false && lin.freeGb === 5.8 && inj.low === true;
    return { ok, detail: JSON.stringify({ win, off, lin, inj }) };
  });
}
