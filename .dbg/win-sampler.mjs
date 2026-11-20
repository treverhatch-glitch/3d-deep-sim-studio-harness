// Debug only (never merged): the unit's own environment.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runLimitedSync } from '../harness/run-limited.mjs';
import { windowsHelperScript } from '../harness/run-sampler.mjs';
import { psEnv } from '../harness/proc-identity.mjs';

const t0 = Date.now();
const say = (s) => console.log(`[${String(Date.now() - t0).padStart(6)} ms] ${s}`);
const src = fs.readFileSync('qa/selftest-296a.mjs', 'utf8');
const re = new RegExp(src.match(/if \(\/(\^\(SystemRoot[^\n]*?\)\$)\/i\.test\(k\)\)/)[1], 'i');
const clean = {};
for (const k of Object.keys(process.env)) if (re.test(k)) clean[k] = process.env[k];
for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
const unitEnv = { ...clean, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', STUDIO_REFILL_WAKE: 'off', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off', CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '' };
say(`the unit's environment: ${Object.keys(unitEnv).length} names: ${Object.keys(unitEnv).join(' ')}`);
say(`not passed through from the full one: ${Object.keys(process.env).filter((k) => !(k in unitEnv)).join(' ')}`);

const S = fs.mkdtempSync(path.join(os.tmpdir(), 'dbg studio '));
fs.writeFileSync(path.join(S, 'grand.cjs'), "const b = Buffer.alloc(300 * 1024 * 1024, 1); setTimeout(function () { b[0] = 2; }, 14000);");
fs.writeFileSync(path.join(S, 'mid.cjs'), "require('child_process').spawnSync(process.execPath, ['grand.cjs'], { stdio: 'inherit', windowsHide: true }); console.log('done-ok');");
const cmd = JSON.stringify(process.execPath) + ' mid.cjs';

say('--- A. runLimitedSync from a child node that has the unit environment (as the unit\'s probe does)');
fs.writeFileSync(path.join(S, 'probe.mjs'), `import fs from 'node:fs';
import { runLimitedSync } from ${JSON.stringify(new URL('../harness/run-limited.mjs', import.meta.url).href)};
const r = runLimitedSync(${JSON.stringify(cmd)}, { sample: { file: 'p.csv', meta: { kind: 'quick', engine: 'unity' }, everyMs: 1000 }, encoding: 'utf8', timeoutMs: 120000 });
console.log('status', r.status, JSON.stringify(String(r.stdout).trim()), JSON.stringify(String(r.stderr).slice(0, 300)));
console.log(fs.readFileSync('p.csv', 'utf8'));`);
await new Promise((done) => {
  const p = spawn(process.execPath, ['probe.mjs'], { cwd: S, env: unitEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  p.stdout.on('data', (d) => say(`OUT ${d.toString()}`)); p.stderr.on('data', (d) => say(`ERR ${d.toString().slice(0, 800)}`)); p.on('exit', done);
});

say('--- B. the helper direct with psEnv(the unit environment), errors shown, 12 s');
const child = spawn(process.execPath, ['-e', 'setTimeout(function(){},15000)'], { stdio: 'ignore', windowsHide: true });
await new Promise((done) => {
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', windowsHelperScript(child.pid, process.pid, 1000).replace("$ErrorActionPreference='SilentlyContinue'", "$ErrorActionPreference='Continue'")], { cwd: S, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: psEnv(unitEnv) });
  p.stdout.on('data', (d) => say(`OUT ${JSON.stringify(d.toString())}`));
  p.stderr.on('data', (d) => say(`ERR ${JSON.stringify(d.toString().slice(0, 1500))}`));
  p.on('exit', (c, s) => { say(`helper exit ${c} ${s}`); done(); });
  p.on('error', (e) => { say(`helper error ${e.code}`); done(); });
  setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, 12000);
});
try { child.kill(); } catch { /* gone */ }
say('done');
process.exit(0);
