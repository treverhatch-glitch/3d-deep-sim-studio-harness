// Debug only (never merged): the wrapper flow on Windows, with a command that really runs.
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { runLimitedSync } from '../harness/run-limited.mjs';
import { startSampler, windowsHelperScript } from '../harness/run-sampler.mjs';
import { psEnv } from '../harness/proc-identity.mjs';

const t0 = Date.now();
const say = (s) => console.log(`[${String(Date.now() - t0).padStart(6)} ms] ${s}`);
fs.writeFileSync('grand.cjs', "const b = Buffer.alloc(300 * 1024 * 1024, 1); setTimeout(function () { b[0] = 2; }, 14000);");
fs.writeFileSync('mid.cjs', "require('child_process').spawnSync(process.execPath, ['grand.cjs'], { stdio: 'inherit', windowsHide: true }); console.log('done-ok');");
const cmd = JSON.stringify(process.execPath) + ' mid.cjs';
const KEEP = /^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|PROCESSOR_IDENTIFIER|OS|COMPUTERNAME|USERNAME|USERDOMAIN|HOMEDRIVE|HOMEPATH)$/i;
const cut = Object.fromEntries(Object.entries(process.env).filter(([k]) => KEEP.test(k)));

say('--- 1. startSampler in THIS process (as run-limited does), rows?');
{
  const child = spawn(process.execPath, ['mid.cjs'], { stdio: 'ignore', windowsHide: true });
  fs.rmSync('one.csv', { force: true });
  const s = startSampler({ file: 'one.csv', meta: { kind: 'x' }, rootPid: child.pid, everyMs: 1000 });
  await new Promise((r) => child.on('exit', r));
  s.stop({ code: 0 });
  say(fs.readFileSync('one.csv', 'utf8'));
}
for (const [label, env] of [['full env', process.env], ['cut-down env', cut]]) {
  const f = `dbg-${label.replace(/\W+/g, '-')}.csv`;
  fs.rmSync(f, { force: true });
  const a = Date.now();
  const r = runLimitedSync(cmd, { sample: { file: f, meta: { kind: 'quick', engine: 'unity' }, everyMs: 1000 }, encoding: 'utf8', timeoutMs: 120000, env });
  say(`--- 2. runLimitedSync, ${label}: status ${r.status}, ${Date.now() - a} ms, out ${JSON.stringify(String(r.stdout || '').trim())}, stderr ${JSON.stringify(String(r.stderr || '').slice(0, 300))}`);
  say(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '(no file)');
}
say('--- 3. the same queries without modules: [wmisearcher], timed in one PowerShell, cut-down env');
const q = [
  "$sw=[Diagnostics.Stopwatch]::StartNew()",
  "$p=@(([wmisearcher]'SELECT ProcessId,ParentProcessId,WorkingSetSize,CreationDate,KernelModeTime,UserModeTime FROM Win32_Process').Get())",
  "$a=$sw.ElapsedMilliseconds",
  "$o=@(([wmisearcher]'SELECT FreePhysicalMemory,TotalVirtualMemorySize,FreeVirtualMemory FROM Win32_OperatingSystem').Get())[0]",
  "$b=$sw.ElapsedMilliseconds",
  "$p2=@(([wmisearcher]'SELECT ProcessId,ParentProcessId,WorkingSetSize,CreationDate,KernelModeTime,UserModeTime FROM Win32_Process').Get())",
  "$c=$sw.ElapsedMilliseconds",
  "[Console]::Out.WriteLine(('procs {0} first {1} ms, os {2} ms, second {3} ms; free {4} KB, vtotal {5} KB, vfree {6} KB; sample {7} {8} {9} {10}' -f $p.Count,$a,($b-$a),($c-$b),$o.FreePhysicalMemory,$o.TotalVirtualMemorySize,$o.FreeVirtualMemory,$p[5].ProcessId,$p[5].ParentProcessId,$p[5].CreationDate,$p[5].KernelModeTime))",
].join('; ');
for (const [label, env] of [['cut-down env', psEnv(cut)], ['full env', process.env]]) {
  const a = Date.now();
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', q], { encoding: 'utf8', windowsHide: true, env, timeout: 60000 });
  say(`${label}: whole call ${Date.now() - a} ms: ${String(r.stdout).trim()} ${JSON.stringify(String(r.stderr).trim().slice(0, 400))}`);
}
say('done');
process.exit(0);
