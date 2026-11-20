// Debug only (never merged): why does a sampled run get no rows on Windows?
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { runLimitedSync } from '../harness/run-limited.mjs';
import { windowsHelperScript } from '../harness/run-sampler.mjs';
import { psEnv } from '../harness/proc-identity.mjs';

const t0 = Date.now();
const say = (s) => console.log(`[${String(Date.now() - t0).padStart(6)} ms] ${s}`);
const KEEP = /^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|PROCESSOR_IDENTIFIER|OS|COMPUTERNAME|USERNAME|USERDOMAIN|HOMEDRIVE|HOMEPATH)$/i;
const cut = Object.fromEntries(Object.entries(process.env).filter(([k]) => KEEP.test(k)));
say(`full env has ${Object.keys(process.env).length} names; the cut-down one ${Object.keys(cut).length}`);

const inner = "const b = Buffer.alloc(300 * 1024 * 1024, 1); setTimeout(() => { b[0] = 2; }, 9000)";
const cmd = JSON.stringify(process.execPath) + ' -e ' + JSON.stringify("require('child_process').spawnSync(process.execPath, ['-e', " + JSON.stringify(inner) + "], { stdio: 'inherit', windowsHide: true })");
say(`command: ${cmd}`);
for (const [label, env] of [['full env', process.env], ['cut-down env', cut]]) {
  const f = `dbg-${label.replace(/\W+/g, '-')}.csv`;
  fs.rmSync(f, { force: true });
  const a = Date.now();
  const r = runLimitedSync(cmd, { sample: { file: f, meta: { kind: 'quick', engine: 'unity' }, everyMs: 1000 }, encoding: 'utf8', timeoutMs: 120000, env });
  say(`--- runLimitedSync, ${label}: status ${r.status}, ${Date.now() - a} ms, stderr ${JSON.stringify(String(r.stderr || '').slice(0, 400))}${r.error ? ', error ' + r.error.code : ''}`);
  say(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '(no file)');
}

say('--- the helper direct, cut-down env through psEnv, stderr shown, 8 s');
const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},15000)'], { stdio: 'ignore', windowsHide: true });
await new Promise((done) => {
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', windowsHelperScript(child.pid, process.pid, 1000).replace("$ErrorActionPreference='SilentlyContinue'", "$ErrorActionPreference='Continue'")], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: psEnv(cut) });
  p.stdout.on('data', (d) => say(`OUT ${JSON.stringify(d.toString())}`));
  p.stderr.on('data', (d) => say(`ERR ${JSON.stringify(d.toString().slice(0, 1200))}`));
  p.on('exit', (c, s) => { say(`helper exit ${c} ${s}`); done(); });
  p.on('error', (e) => { say(`helper error ${e.code}`); done(); });
  setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, 8000);
});
try { child.kill(); } catch { /* gone */ }
say('done');
process.exit(0);
