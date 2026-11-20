/**
 * harness/run-sampler.mjs — 2.96 (a): samples one run's process tree and the machine while it runs. run-limited.mjs loads
 * it only for a sampled run (runLimitedSync's `sample`). Every `everyMs`: free RAM, commit charge (Windows), total CPU,
 * and the working set and CPU of the run's whole tree, as one CSV row in `file`. Linux reads /proc in this process;
 * Windows runs ONE long-lived PowerShell helper that prints one line per sample (never one PowerShell per sample, P-370);
 * elsewhere it is a no-op. It never throws, never holds the run up, and its helper ends with the run (and by itself
 * when the run's wrapper is gone). The file: a `# {meta}` line, a header, rows, and `# end {...}` when the run ends.
 */
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { psEnv } from './proc-identity.mjs';

export const CSV_HEAD = 't,availGb,commitUsedGb,commitLimitGb,cpuPct,treeGb,treeCpuPct,procs';
const MAX_ROWS = 20000;
const GB = 1024 ** 3;
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : '');
const HZ = 100;

/** One helper line `S|ms|availB|commitB|limitB|cpuPct|treeWsB|treeCpuPctOfOneCore|procs` as a row object, or null. */
export function parseHelperLine(line, cores = os.cpus().length || 1) {
  const f = String(line || '').trim().split('|');
  if (f[0] !== 'S' || f.length < 9) return null;
  const n = f.slice(1).map((x) => (x === '' ? NaN : Number(x)));
  if (!Number.isFinite(n[0]) || !Number.isFinite(n[5]) || n[5] < 0) return null;
  return { t: n[0], availGb: n[1] / GB, commitUsedGb: n[2] / GB, commitLimitGb: n[3] / GB, cpuPct: n[4], treeGb: n[5] / GB, treeCpuPct: Number.isFinite(n[6]) ? n[6] / Math.max(1, cores) : NaN, procs: n[7] };
}

/** The Windows helper: one PowerShell loop over CIM classes (names aren't localized). Ends when `parent` is gone. */
export function windowsHelperScript(rootPid, parentPid, everyMs) {
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    `$root=${Number(rootPid)}; $parent=${Number(parentPid)}; $ms=${Math.max(200, Number(everyMs))}`,
    'while ($true) {',
    ' if (-not (Get-Process -Id $parent)) { break }',
    ' $ps=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize,CreationDate)',
    ' $by=@{}; $kids=@{}; foreach ($p in $ps) { $by[[int]$p.ProcessId]=$p; $k=[int]$p.ParentProcessId; if (-not $kids.ContainsKey($k)) { $kids[$k]=@() }; $kids[$k]+=$p }',
    ' $in=@{}; $q=New-Object System.Collections.Queue; if ($by.ContainsKey($root)) { $in[$root]=1; $q.Enqueue($by[$root]) }',
    ' while ($q.Count) { $x=$q.Dequeue(); foreach ($c in @($kids[[int]$x.ProcessId])) { if ($c -and -not $in.ContainsKey([int]$c.ProcessId) -and $c.CreationDate -ge $x.CreationDate) { $in[[int]$c.ProcessId]=1; $q.Enqueue($c) } } }',
    ' $ws=0; foreach ($id in $in.Keys) { $ws+=[double]$by[$id].WorkingSetSize }',
    ' $cpu=0; foreach ($pp in @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Property IDProcess,PercentProcessorTime)) { if ($in.ContainsKey([int]$pp.IDProcess)) { $cpu+=[double]$pp.PercentProcessorTime } }',
    ' $m=Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory -Property AvailableBytes,CommittedBytes,CommitLimit',
    " $t=(Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter \"Name='_Total'\" -Property PercentProcessorTime).PercentProcessorTime",
    ' $now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()',
    " [Console]::Out.WriteLine(('S|{0}|{1}|{2}|{3}|{4}|{5}|{6}|{7}' -f $now,$m.AvailableBytes,$m.CommittedBytes,$m.CommitLimit,$t,$ws,$cpu,$in.Count)); [Console]::Out.Flush()",
    ' Start-Sleep -Milliseconds $ms',
    '}',
  ].join('\n');
}

/** Linux: every process's parent, CPU ticks and start, then the tree of `rootPid`. */
function linuxTree(rootPid) {
  const all = new Map();
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const st = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
      const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
      all.set(Number(name), { ppid: Number(f[1]), ticks: Number(f[11]) + Number(f[12]), start: Number(f[19]) });
    } catch { /* it ended */ }
  }
  const kids = new Map();
  for (const [pid, p] of all) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(pid); }
  const tree = new Set();
  if (all.has(rootPid)) tree.add(rootPid);
  const todo = [...tree];
  while (todo.length) { const x = todo.pop(); for (const c of kids.get(x) || []) if (!tree.has(c) && all.get(c).start >= all.get(x).start) { tree.add(c); todo.push(c); } }
  let kb = 0; let ticks = 0;
  for (const pid of tree) {
    ticks += all.get(pid).ticks || 0;
    try { const m = fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+)/m); if (m) kb += Number(m[1]); } catch { /* it ended */ }
  }
  return { gb: (kb * 1024) / GB, ticks, procs: tree.size };
}
const cpuTotals = () => { const n = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number); const idle = (n[3] || 0) + (n[4] || 0); return { idle, total: n.reduce((a, b) => a + (b || 0), 0) }; };
const memAvailGb = () => { const m = fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)/m); return m ? (Number(m[1]) * 1024) / GB : NaN; };

/**
 * Start sampling. { file, meta, rootPid, everyMs, helper? (a node script standing in for the Windows helper: tests),
 * platform }. Returns { stop({ code, signal }) }; never throws.
 */
export function startSampler({ file, meta = {}, rootPid, everyMs = 10000, helper = null, platform = process.platform }) {
  let rows = 0; let dead = false; let timer = null; let proc = null;
  const cores = os.cpus().length || 1;
  const write = (text) => { if (dead) return; try { fs.appendFileSync(file, text); } catch { dead = true; } };
  const row = (s) => { if (rows >= MAX_ROWS) return; rows += 1; write(`${[s.t, r2(s.availGb), r2(s.commitUsedGb), r2(s.commitLimitGb), r2(s.cpuPct), r2(s.treeGb), r2(s.treeCpuPct), s.procs ?? ''].join(',')}\n`); };
  try { write(`# ${JSON.stringify({ v: 1, ...meta, pid: process.pid, ppid: process.ppid, root: rootPid, at: Date.now(), everyMs, cores, platform })}\n${CSV_HEAD}\n`); } catch { dead = true; }
  try {
    if (helper || platform === 'win32') {
      const args = helper ? [helper, String(rootPid), String(process.pid), String(everyMs)] : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', windowsHelperScript(rootPid, process.pid, everyMs)];
      const env = helper ? process.env : psEnv(process.env);
      proc = spawn(helper ? process.execPath : 'powershell.exe', args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env });
      proc.on('error', () => { proc = null; });
      let buf = '';
      proc.stdout.on('data', (d) => {
        buf = (buf + d.toString('utf8')).slice(-65536);
        const lines = buf.split(/\r?\n/); buf = lines.pop();
        for (const l of lines) { const s = parseHelperLine(l, cores); if (s) row(s); }
      });
      proc.on('exit', () => { proc = null; });
      proc.unref(); proc.stdout.unref?.();
    } else if (platform === 'linux') {
      let last = null;
      const tick = () => {
        try {
          const now = Date.now(); const tr = linuxTree(rootPid); const c = cpuTotals();
          const s = { t: now, availGb: memAvailGb(), commitUsedGb: NaN, commitLimitGb: NaN, cpuPct: NaN, treeGb: tr.gb, treeCpuPct: NaN, procs: tr.procs };
          if (last) {
            const dt = c.total - last.c.total;
            if (dt > 0) s.cpuPct = 100 * (1 - (c.idle - last.c.idle) / dt);
            const wall = (now - last.t) / 1000;
            if (wall > 0) s.treeCpuPct = Math.max(0, (100 * (tr.ticks - last.ticks)) / (wall * HZ * cores));
          }
          last = { t: now, c, ticks: tr.ticks };
          if (tr.procs) row(s);
        } catch { /* one sample lost */ }
      };
      tick();
      timer = setInterval(tick, Math.max(100, everyMs));
      timer.unref();
    }
  } catch { /* no samples: the run goes on */ }
  return {
    stop({ code = null, signal = null } = {}) {
      try { if (timer) clearInterval(timer); } catch { /* gone */ }
      try { if (proc) proc.kill(); } catch { /* gone */ }
      write(`# end ${JSON.stringify({ at: Date.now(), code, signal, rows })}\n`);
      dead = true;
    },
  };
}
