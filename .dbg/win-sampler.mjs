// Debug only (never merged): what does the real Windows sampler helper do?
import { spawn, spawnSync } from 'node:child_process';
import { windowsHelperScript } from '../harness/run-sampler.mjs';
import { psEnv } from '../harness/proc-identity.mjs';

const t0 = Date.now();
const say = (s) => console.log(`[${String(Date.now() - t0).padStart(6)} ms] ${s}`);
const ps = (script, ms = 60000) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', windowsHide: true, env: psEnv(process.env), timeout: ms });

say('--- each query alone, timed');
for (const [name, q] of [
  ['Win32_Process', "@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize,CreationDate).Count"],
  ['PerfProc_Process (all)', "@(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Property IDProcess,PercentProcessorTime).Count"],
  ['PerfOS_Memory', "(Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory -Property AvailableBytes,CommittedBytes,CommitLimit).AvailableBytes"],
  ['PerfOS_Processor', "(Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter \"Name='_Total'\" -Property PercentProcessorTime).PercentProcessorTime"],
  ['Get-Process', '(Get-Process -Id $PID).Id'],
]) {
  const a = Date.now(); const r = ps(q);
  say(`${name}: ${Date.now() - a} ms, status ${r.status}, out ${JSON.stringify(String(r.stdout).trim().slice(0, 80))}, err ${JSON.stringify(String(r.stderr).trim().slice(0, 300))}${r.error ? ', error ' + r.error.code : ''}`);
}

say('--- the helper itself, 25 s, against a child that spawns a grandchild holding 300 MB');
const child = spawn(process.execPath, ['-e', "const {spawn}=require('child_process');const g=spawn(process.execPath,['-e','const b=Buffer.alloc(300*1024*1024,1);setTimeout(()=>{},20000)'],{stdio:'ignore',windowsHide:true});setTimeout(()=>{},20000)"], { stdio: 'ignore', windowsHide: true });
const script = windowsHelperScript(child.pid, process.pid, 1000);
say(`script (${script.length} chars):\n${script}`);
for (const [label, text] of [['as shipped', script], ['errors shown', script.replace("$ErrorActionPreference='SilentlyContinue'", "$ErrorActionPreference='Continue'")]]) {
  await new Promise((done) => {
    say(`--- helper ${label}`);
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', text], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: psEnv(process.env) });
    p.stdout.on('data', (d) => say(`OUT ${JSON.stringify(d.toString())}`));
    p.stderr.on('data', (d) => say(`ERR ${JSON.stringify(d.toString().slice(0, 1500))}`));
    p.on('exit', (c, s) => { say(`helper exit ${c} ${s}`); done(); });
    p.on('error', (e) => { say(`helper error ${e.code}`); done(); });
    setTimeout(() => { say('killing the helper'); try { p.kill(); } catch { /* gone */ } }, 11000);
  });
}
try { child.kill(); } catch { /* gone */ }
say('done');
process.exit(0);
