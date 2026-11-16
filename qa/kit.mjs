// The shared helpers of the self-test files (qa/selftest*.mjs): what used to be copied into each one.
// Rules for adding one:
//  - only a body that 3 or more test files define identically (whitespace and comments aside);
//  - no imports from harness/: node: built-ins only;
//  - a helper that read one local variable of its file is a factory taking that variable (guardOf(report));
//  - a variant that differs in any token is its own export, never a flag on an existing one.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

// bound to task; the tests' local name: add
export const addJsonOf = (task) => (title) => JSON.parse(task(`add "${title}" --role builder`).stdout).id;
// bound to dir; the tests' local name: board
export const boardOf = (dir) => () => `${fs.existsSync(path.join(dir, 'studio/NEXT.md')) ? fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8') : ''}`;
// bound to dir; the tests' local name: doneBoard
export const doneBoardOf = (dir) => () => `${fs.existsSync(path.join(dir, 'studio/DONE.md')) ? fs.readFileSync(path.join(dir, 'studio/DONE.md'), 'utf8') : ''}`;
// bound to evs; the tests' local name: dropped
export const droppedOf = (evs) => (id) => evs().some((e) => e.type === 'task.train.dropped' && e.task === id);
// bound to events; the tests' local name: evs
export const eventTypesOf = (events) => (re) => events().filter((e) => re.test(e.type));
// bound to events; the tests' local name: evs
export const eventsLenientOf = (events) => () => { try { return fs.readFileSync(events, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return {}; } }); } catch { return []; } };
// bound to events; the tests' local name: evs
export const eventsOf = (events) => () => { try { return fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
// the tests' local name: u
export const fileUrlIn = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
// bound to dir; the tests' local name: u
export const fileUrlOf = (dir) => (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
// bound to net; the tests' local name: freePort
export const freePortOf = (net) => () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
// the tests' local name: fwd
export const fwd = (p) => p.split(path.sep).join('/');
// bound to ident; the tests' local name: gEnv
export const gEnvExtraOf = (ident) => (extra = {}) => { const e = { ...process.env, ...ident, ...extra }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
// bound to ident; the tests' local name: gEnv
export const gEnvOf = (ident) => () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
// bound to ident; the tests' local name: gEnv
export const gEnvUnsetThreeOf = (ident) => (extra = {}) => { const e = { ...process.env, ...ident, ...extra }; for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete e[k]; return e; };
// bound to gatesDir; the tests' local name: recOf
export const gateRecOf = (gatesDir) => (owner) => { try { return JSON.parse(fs.readFileSync(path.join(gatesDir, `${owner}-full.json`), 'utf8')); } catch { return null; } };
// bound to gEnv; the tests' local name: g
export const gitArgsOf = (gEnv) => (cwd, args) => spawnSync('git', args, { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
// the tests' local name: g, gIn, gg
export const gitAsT = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { windowsHide: true, cwd, encoding: 'utf8' });
// the tests' local name: g, spawnGit
export const gitAsTShort = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { windowsHide: true, cwd, encoding: 'utf8' });
// bound to gEnv; the tests' local name: gitIn
export const gitCrlfOf = (gEnv) => (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
// bound to gEnv; the tests' local name: g
export const gitCrlfUserOf = (gEnv) => (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
// bound to dir; the tests' local name: g
export const gitDirOf = (dir) => (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { windowsHide: true, cwd: dir, encoding: 'utf8' });
// bound to gEnv; the tests' local name: g, gitIn
export const gitEolLfOf = (gEnv) => (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
// bound to gEnv; the tests' local name: g, gitIn
export const gitEolLfUserOf = (gEnv) => (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
// bound to gEnv; the tests' local name: g
export const gitExtraOf = (gEnv) => (cwd, args, extra = {}) => spawnSync('git', args, { windowsHide: true, cwd, encoding: 'utf8', env: gEnv(extra) });
// bound to gEnv; the tests' local name: g
export const gitPlainOf = (gEnv) => (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: gEnv(), windowsHide: true });
// bound to gEnv; the tests' local name: g
export const gitStdioOf = (gEnv) => (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
// bound to gEnv; the tests' local name: g
export const gitUserCrlfOf = (gEnv) => (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
// bound to report; the tests' local name: guard
export const guardAsyncPlainOf = (report) => async (name, fn) => { try { const [ok, detail] = await fn(); report(name, ok, detail); } catch (e) { report(name, false, e.stack || String(e)); } };
// bound to report; the tests' local name: guard
export const guardCap2500Of = (report) => async (name, fn) => {
  try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 2500)); }
  catch (e) { report(name, false, String(e?.stack || e).slice(0, 2500)); }
};
// bound to report; the tests' local name: guard
export const guardCap3000Of = (report) => async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3000)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 3000)); } };
// bound to report; the tests' local name: guard
export const guardCap3500Of = (report) => async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3500)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 2500)); } };
// bound to report; the tests' local name: guard
export const guardOf = (report) => async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
// bound to report; the tests' local name: guard
export const guardSyncBoolOf = (report) => (name, fn) => { try { const [ok, detail] = fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
// bound to report; the tests' local name: guard
export const guardSyncOf = (report) => (name, fn) => { try { const [ok, detail] = fn(); report(name, ok, detail); } catch (e) { report(name, false, e.stack || String(e)); } };
// bound to dir; the tests' local name: handBack
export const handBackOf = (dir) => (id) => { const f = path.join(dir, 'studio', 'handoffs', `${id}.md`); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''; };
// bound to g; the tests' local name: head
export const headOf = (g) => () => g('rev-parse', 'HEAD').stdout.trim();
// bound to g; the tests' local name: head
export const headRefOf = (g) => (cwd, ref = 'HEAD') => g(cwd, ['rev-parse', ref]).stdout.trim();
// bound to dir; the tests' local name: u
export const hrefInDirOf = (dir) => (rel) => pathToFileURL(path.join(dir, rel)).href;
// bound to dir; the tests' local name: imp
export const importInDirOf = (dir) => (rel) => import(pathToFileURL(path.join(dir, rel)).href);
// the tests' local name: iso
export const iso = (ms) => new Date(ms).toISOString();
// the tests' local name: killTree
export const killTree = (child) => {
  try { if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' }); else process.kill(-child.pid, 'SIGKILL'); } catch {}
  try { child.kill('SIGKILL'); } catch {}
};
// bound to out; the tests' local name: lastJson
export const lastJsonOf = (out) => (r) => { const t = String(r.stdout || '').trim(); const l = t.split('\n').filter((x) => x.startsWith('{')).pop(); try { return JSON.parse(l); } catch { return { _raw: out(r).slice(-2000) }; } };
// bound to out; the tests' local name: json
export const lastLineJsonOf = (out) => (r) => { try { return JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { return { _raw: out(r).slice(-1500) }; } };
// the tests' local name: minAgo
export const minAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
// the tests' local name: nap, sleep
export const napSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// the tests' local name: line
export const nextLine = (t) => `- [${t.ip ? '>' : ' '}] **${t.id}** [${t.p || 'P1'}] (\`${t.role || 'builder'}\`) — ${t.title}`;
// bound to ident; the tests' local name: node
export const nodeCwd180Of = (ident) => (cwd, args, env) => spawnSync(process.execPath, args, { windowsHide: true, cwd, encoding: 'utf8', env: { ...process.env, ...ident, ...env }, timeout: 180000 });
// bound to ident; the tests' local name: node
export const nodeCwd240Of = (ident) => (cwd, args, env, timeout = 240000) => spawnSync(process.execPath, args, { windowsHide: true, cwd, encoding: 'utf8', env: { ...process.env, ...ident, ...env }, timeout });
// bound to ident; the tests' local name: node
export const nodeS120Of = (ident) => (S, args, env) => spawnSync(process.execPath, args, { windowsHide: true, cwd: S, encoding: 'utf8', env: { ...process.env, ...ident, ...env }, timeout: 120000 });
// bound to ident; the tests' local name: node
export const nodeS180Of = (ident) => (S, args, env) => spawnSync(process.execPath, args, { windowsHide: true, cwd: S, encoding: 'utf8', env: { ...process.env, ...ident, ...env }, timeout: 180000 });
// the tests' local name: npmShim
export const npmShim = (pkg) => `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\${pkg}\\cli.js" %*\r\n`;
// the tests' local name: out, text, txt
export const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
// the tests' local name: parse
export const parseLastLine = (r) => { try { return JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { return {}; } };
// the tests' local name: pause
export const pause = (ms) => spawnSync(process.execPath, ['-e', `setTimeout(()=>{},${ms})`], { windowsHide: true });
// bound to run; the tests' local name: queueIt
export const queueDoneOf = (run) => (l) => run(l.dir, `node harness/task.mjs done ${l.id} --agent ${l.agent} --train`, l.as);
// bound to dir; the tests' local name: queue
export const queueTasksOf = (dir) => () => { try { return JSON.parse(fs.readFileSync(path.join(dir, '.studio', 'train', 'queue.json'), 'utf8')).map((e) => e.task); } catch { return []; } };
// bound to S; the tests' local name: queue
export const queueUnityOf = (S) => (E, lanes) => { fs.mkdirSync(path.join(S, '.studio', 'train'), { recursive: true }); fs.writeFileSync(path.join(S, '.studio', 'train', 'unity-queue.json'), JSON.stringify(lanes.map(([task, branch], i) => ({ task, agent: `porter-${i}`, branch, head: E.heads[branch], at: new Date(Date.now() + i).toISOString() })))); };
// the tests' local name: readRec
export const readAgentRec = (S, agent) => { try { return JSON.parse(fs.readFileSync(path.join(S, '.studio', 'agents', `${agent}.json`), 'utf8')); } catch { return null; } };
// bound to dir; the tests' local name: read, readT
export const readInDirOf = (dir) => (rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { return ''; } };
// the tests' local name: readJ, readJson, readJsonFile
export const readJsonFile = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
// the tests' local name: readIn
export const readJsonIn = (cwd, rel) => { try { return JSON.parse(fs.readFileSync(path.join(cwd, rel), 'utf8')); } catch { return null; } };
// bound to dir; the tests' local name: diskJson, j, readJ, readJson
export const readJsonInDirOf = (dir) => (rel) => { try { return JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8')); } catch { return null; } };
// the tests' local name: events, evs
export const readJsonl = (ev) => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
// the tests' local name: rulesRuns, runsOf
export const readJsonlTrimmed = (f) => { try { return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
// the tests' local name: runs, runsOf
export const readRunsJsonl = (ctl) => { try { return fs.readFileSync(`${ctl}-runs.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
// the tests' local name: readIf, readText
export const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
// the tests' local name: textIn
export const readTextIn = (cwd, rel) => { try { return fs.readFileSync(path.join(cwd, rel), 'utf8'); } catch { return ''; } };
// the tests' local name: real
export const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
// bound to ranLog; the tests' local name: clearRan, resetRan
export const resetRanOf = (ranLog) => () => { try { fs.rmSync(ranLog, { force: true }); } catch {} };
// the tests' local name: rev
export const revStr = (s) => `rev:${s.split('').reverse().join('')}`;
// bound to mark; the tests' local name: runs
export const runsCountOf = (mark) => () => { try { return fs.readFileSync(mark, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
// bound to setGame; the tests' local name: setEngines
export const setEnginesOf = (setGame) => (engines) => setGame({ engines });
// the tests' local name: sleep, wait
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// bound to out; the tests' local name: tail
export const tailOf = (out) => (r, n = 300) => `[${r.status}] ${out(r).replace(/\s+/g, ' ').trim().slice(-n)}`;
// bound to node; the tests' local name: task
export const taskCwdOf = (node) => (cwd, line, env, timeout) => node(cwd, ['harness/task.mjs', ...line], env, timeout);
// bound to node; the tests' local name: task
export const taskOf = (node) => (S, line, env) => node(S, ['harness/task.mjs', ...line], env);
// bound to nap; the tests' local name: until
export const untilNap100Of = (nap) => (fn, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms && !fn()) nap(100);
  return fn();
};
// bound to nap; the tests' local name: until
export const untilNapOf = (nap) => (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms && !fn()) nap(50); return fn(); };
// bound to wait; the tests' local name: until
export const untilWaitOf = (wait) => async (fn, ms) => { const t0 = Date.now(); for (;;) { let v = false; try { v = fn(); } catch {} if (v) return true; if (Date.now() - t0 > ms) return false; await wait(200); } };
// the tests' local name: writeIn
export const writeIn = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };
// bound to dir; the tests' local name: w, write, writeIn
export const writeInDirOf = (dir) => (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
