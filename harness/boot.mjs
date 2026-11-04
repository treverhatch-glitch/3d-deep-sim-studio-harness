#!/usr/bin/env node
/**
 * harness/boot.mjs — 2.73.1 (B-69): one command to bring the studio up after a restart ("the long boot up": 2.5 h of the
 * owner's time on 2026-11-03).
 *
 *   npm run studio:boot [-- --until 46h] [--window 09:00-23:00] [--budget 50%] [--lanes auto] [--no-hub] [--no-supervisor]
 *   npm run studio:boot -- --check        report only: nothing is cleared or started
 *   npm run studio:boot -- --shortcut     also write a Desktop file that runs `npm.cmd run studio:boot` here (Windows .cmd;
 *                                         elsewhere a .sh); prints its path
 *   --json                                the same as one JSON object
 *
 * Steps:
 *   1. preflight-lite: node against package.json engines, npm on the PATH (npm.cmd on Windows, with the hint that a
 *      PowerShell execution policy blocking npm.ps1 is passed by typing npm.cmd), the .env: no session identity in it
 *      (B-60, harness/dotenv.mjs), a War Room token long enough for the buttons (never printed);
 *   2. the stale sweep: train.lock, land.lock, unity-train.lock, verify-running/full.json and train/daemon.json whose
 *      recorded process is gone are removed, and a supervisor.json still saying "running" for a gone process is marked
 *      stopped; one boot.stale_cleared event names each. Live, unreadable or pid-less files are left. Lane copies, claims,
 *      logs and work are never touched;
 *   3. the hub, then the supervisor, each started only when not already running (the hub: /health answers on HUB_PORT;
 *      the supervisor: supervisor.json running with a live process that is still that supervisor, not another program
 *      holding a reused pid: supervisorAlive, 2.77.1 M5), detached and hidden (windowsHide), output in
 *      .studio/logs/hub.log and .studio/logs/supervisor.log. The train daemon runs inside each supervisor pass
 *      (harness/train-daemon.mjs), so it is up when the supervisor is; its switch is reported. The daemons get this
 *      shell's environment minus the session identity (STUDIO_LOCK_OWNER, STUDIO_ROLE, STUDIO_AGENT, STUDIO_MAIN_ROOT):
 *      they are the studio's, not an agent's;
 *   4. one status card: crew sessions, train, halts, what needs a person, outside agents seen lately (event log), lane
 *      copies and leftover folders in .lanes/ (B-51, listed, never removed), and the War Room address (no token).
 * Restarting outside orchestrators (chat sessions the harness doesn't launch) is not done here.
 * UNTESTED on Windows: detached + windowsHide starts (same options as studio:start), `where npm.cmd`, the Desktop path
 * (%USERPROFILE%\Desktop, else %OneDrive%\Desktop) and the .cmd file.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, emitEvent, readRecentEvents } from './event.mjs';
import { identityLines, SESSION_IDENTITY_KEYS } from './dotenv.mjs';
import { pidAlive, readStarts, sameProcess } from './proc-identity.mjs';
import { which, versionAtLeast } from './upgrade-preflight.mjs';

const BY = 'studio-boot';
const HUB_WAIT_MS = 20000;
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return undefined; } };
const rel = (root, f) => path.relative(root, f).split(path.sep).join('/');
const item = (id, status, detail, fix = '') => ({ id, status, detail, ...(fix ? { fix } : {}) });

/** Step 1: [{ id, status: PASS|WARN|FAIL|INFO, detail, fix? }]. Values from .env are never printed. */
export function preflightLite({ root = REPO_ROOT, env = process.env, platform = process.platform } = {}) {
  const out = [];
  const engines = readJson(path.join(root, 'package.json'))?.engines?.node || null;
  const ok = engines ? versionAtLeast(process.versions.node, engines) : true;
  out.push(ok === false ? item('node', 'FAIL', `node ${process.versions.node}, but package.json asks ${engines}`, `install node ${String(engines).replace(/^>=\s*/, '')} or newer (nodejs.org), then open a new terminal`) : item('node', 'PASS', `node ${process.versions.node}${engines ? ` (needs ${engines})` : ''}`));
  const npm = platform === 'win32' ? 'npm.cmd' : 'npm';
  out.push(which(npm, env) ? item('npm', 'PASS', `${npm} is on the PATH`) : item('npm', 'WARN', `${npm} is not on the PATH`, 'install node with npm (nodejs.org), then open a new terminal'));
  if (platform === 'win32') out.push(item('powershell', 'INFO', 'in PowerShell, "npm.ps1 cannot be loaded because running scripts is disabled" means the execution policy blocks npm.ps1: type npm.cmd instead (npm.cmd run studio:boot), or use the Desktop shortcut (npm.cmd run studio:boot -- --shortcut)'));
  let text = '';
  try { text = fs.readFileSync(path.join(root, '.env'), 'utf8'); } catch {}
  if (!text) out.push(item('dotenv', 'INFO', 'no .env: the defaults hold (npm run setup makes one with a War Room token)'));
  const hits = identityLines(text);
  if (hits.length) {
    const lines = hits.map((h) => h.line).join(', ');
    out.push(item('dotenv-identity', 'WARN', `.env sets ${[...new Set(hits.map((h) => h.key))].join(', ')} (line${hits.length === 1 ? '' : 's'} ${lines}): identity settings belong to a session, not the studio's .env; the harness ignores them there`, `remove line${hits.length === 1 ? '' : 's'} ${lines} from .env (the launcher sets these for each agent session)`));
  }
  const tok = String(env.HUB_TOKEN || '').trim();
  if (text && (tok.length < 24 || /change-me/.test(tok))) out.push(item('hub-token', 'WARN', 'HUB_TOKEN is unset, short or a placeholder: the War Room is read-only (its buttons are refused)', 'npm run setup (writes a fresh HUB_TOKEN to .env), then open the War Room link the hub prints'));
  const shell = SESSION_IDENTITY_KEYS.filter((k) => String(env[k] || '').trim());
  if (shell.length) out.push(item('shell-identity', 'INFO', `this shell carries ${shell.map((k) => (k === 'STUDIO_MAIN_ROOT' ? k : `${k}=${String(env[k]).trim().slice(0, 40)}`)).join(', ')}: not passed to the hub and supervisor (they are the studio's, not a session's)`));
  return out;
}

/** The pid files the sweep reads: [{ file, what, kind }]. */
export function sweepTargets(root = REPO_ROOT) {
  const st = path.join(root, '.studio');
  return [
    { file: path.join(st, 'locks', 'train.lock'), what: 'the merge train lock', kind: 'remove' },
    { file: path.join(st, 'locks', 'land.lock'), what: 'the land lock', kind: 'remove' },
    { file: path.join(st, 'locks', 'unity-train.lock'), what: 'the Unity train lock', kind: 'remove' },
    { file: path.join(st, 'verify-running', 'full.json'), what: 'the full-verify record', kind: 'remove' },
    { file: path.join(st, 'train', 'daemon.json'), what: 'the train daemon\'s running-train record', kind: 'remove' },
    { file: path.join(st, 'supervisor.json'), what: 'the supervisor\'s status', kind: 'supervisor' },
  ];
}

/**
 * Step 2: [{ file, what, pid, action: cleared|would clear|kept, why }]. dry: nothing is changed. Only the listed files,
 * only when their recorded process is gone.
 */
export function staleSweep({ root = REPO_ROOT, dry = false, emit = emitEvent, alive = pidAlive, starts = readStarts, now = Date.now(), env = process.env } = {}) {
  const out = [];
  for (const t of sweepTargets(root)) {
    if (!fs.existsSync(t.file)) continue;
    const r = rel(root, t.file);
    const h = readJson(t.file);
    if (!h || typeof h !== 'object') { out.push({ file: r, what: t.what, pid: null, action: 'kept', why: 'unreadable: left for a person' }); continue; }
    if (t.kind === 'supervisor' && h.status !== 'running') continue;
    const pid = Number(h.pid) || null;
    if (!pid) { out.push({ file: r, what: t.what, pid: null, action: 'kept', why: 'no process recorded' }); continue; }
    if (t.kind === 'supervisor' ? supervisorAlive(h, { alive, starts, now, env }) : alive(pid, h.identity)) { out.push({ file: r, what: t.what, pid, action: 'kept', why: `pid ${pid} is running` }); continue; }
    const why = `pid ${pid} is gone${h.id ? ` (${h.id})` : ''}`;
    if (dry) { out.push({ file: r, what: t.what, pid, action: 'would clear', why }); continue; }
    try {
      if (t.kind === 'supervisor') fs.writeFileSync(t.file, `${JSON.stringify({ ...h, status: 'stopped', stopReason: `its process is gone (pid ${pid}; found by studio:boot)` }, null, 2)}\n`);
      else fs.rmSync(t.file, { force: true });
    } catch (e) { out.push({ file: r, what: t.what, pid, action: 'kept', why: `couldn't clear it: ${String(e.message || e).slice(0, 120)}` }); continue; }
    out.push({ file: r, what: t.what, pid, action: 'cleared', why });
    try { emit({ type: 'boot.stale_cleared', agent: BY, status: 'warn', msg: `studio:boot cleared ${t.what} (${r}): ${why}${t.kind === 'supervisor' ? '; marked stopped' : ''}`, meta: { file: r, pid, record: t.kind === 'supervisor' ? 'marked stopped' : 'removed' } }); } catch {}
  }
  return out;
}

export const hubPort = (env = process.env) => Number(env.HUB_PORT || 3847);
export function hubUp(port) {
  return fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
}
/**
 * Is the supervisor that supervisor.json describes really running? 2.77.1 (M5). The cheap test (the pid exists; on Linux
 * its /proc start matches) can't tell on Windows and macOS: the OS reuses pids, so a killed supervisor's number held by
 * another program looked alive, boot said "running" and started nothing (and a supervisor started anyway refuses at
 * once, "already running", by the same cheap test). So a pid that exists is asked once what program it is (the kill-time
 * query of harness/proc-identity.mjs: its start time against the one on record). Same: running. Different: gone.
 * Can't be read: only a recent loop (lastLoop, as studio:stop judges it) counts.
 */
export function supervisorAlive(s, { alive = pidAlive, starts = readStarts, now = Date.now(), env = process.env } = {}) {
  if (!s || s.status !== 'running' || !s.pid) return false;
  if (!alive(s.pid, s.identity, { eperm: false })) return false;
  let cur = null;
  try { cur = starts([s.pid]).get(Number(s.pid)) || null; } catch { cur = null; }
  const same = cur ? sameProcess(s.identity, cur) : null;
  if (same !== null) return same;
  const loopMs = Number(env.STUDIO_SUPERVISOR_SEC || 60) * 1000;
  const age = now - Date.parse(s.lastLoop || s.startedAt || '');
  return Number.isFinite(age) && age <= Math.max(5 * 60000, 3 * loopMs);
}

/** The supervisor's status record when its process is alive, else null (supervisorAlive). */
export function runningSupervisor(root = REPO_ROOT, alive = pidAlive, opts = {}) {
  const s = readJson(path.join(root, '.studio', 'supervisor.json'));
  return supervisorAlive(s, { alive, ...opts }) ? s : null;
}

/** This shell's environment for a studio daemon: the session identity left out (B-60). */
export function daemonEnv(env = process.env) {
  const e = { ...env };
  for (const k of Object.keys(e)) if (SESSION_IDENTITY_KEYS.includes(k.toUpperCase())) delete e[k];
  return e;
}

/** Start a node script detached and hidden, output to a log under .studio/logs/: its pid. */
export function startDetached(root, script, args, logName, env) {
  const logs = path.join(root, '.studio', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const fd = fs.openSync(path.join(logs, logName), 'a');
  try {
    const child = spawn(process.execPath, [path.join(root, script), ...args], { cwd: root, detached: true, stdio: ['ignore', fd, fd], env, windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return child.pid || null;
  } finally { try { fs.closeSync(fd); } catch {} }
}

/** The supervisor options boot passes on (--until, --window, --budget, --lanes). */
export function supervisorArgs(argv) {
  const out = [];
  for (const k of ['--until', '--window', '--budget', '--lanes']) { const i = argv.indexOf(k); if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) out.push(k, argv[i + 1]); }
  if (argv.includes('--no-hub')) out.push('--no-hub');
  return out;
}

/** Step 3: { hub: { state, pid?, why? }, supervisor: { state, pid?, why? } }. check: report only. */
export async function startDaemons({ root = REPO_ROOT, env = process.env, argv = [], check = false, up = hubUp, start = startDetached, alive = pidAlive, starts = readStarts, waitMs = HUB_WAIT_MS, emit = emitEvent } = {}) {
  const port = hubPort(env);
  const res = { port };
  const denv = daemonEnv(env);
  if (argv.includes('--no-hub')) res.hub = { state: 'skipped', why: '--no-hub' };
  else if (await up(port)) res.hub = { state: 'running', why: `answers on port ${port}` };
  else if (check) res.hub = { state: 'down', why: `nothing answers on port ${port}` };
  else {
    let pid = null;
    try { pid = start(root, 'hub/server.mjs', [], 'hub.log', denv); } catch (e) { res.hub = { state: 'failed', why: String(e.message || e).slice(0, 200) }; }
    if (!res.hub) {
      const until = Date.now() + waitMs;
      let ok = false;
      while (!ok && Date.now() < until) { await new Promise((r) => setTimeout(r, 300)); ok = await up(port); }
      res.hub = ok ? { state: 'started', pid } : { state: 'failed', pid, why: `started (pid ${pid}) but /health didn't answer within ${Math.round(waitMs / 1000)} s: see .studio/logs/hub.log` };
      try { emit({ type: ok ? 'boot.started' : 'boot.start_failed', agent: BY, status: ok ? 'ok' : 'warn', msg: `studio:boot ${ok ? 'started' : 'could not confirm'} the War Room hub (pid ${pid}, port ${port})`, meta: { what: 'hub', pid, port } }); } catch {}
    }
  }
  const sup = runningSupervisor(root, alive, { starts, env });
  if (argv.includes('--no-supervisor')) res.supervisor = { state: 'skipped', why: '--no-supervisor' };
  else if (sup) res.supervisor = { state: 'running', pid: sup.pid, why: `since ${String(sup.startedAt || '').slice(0, 16).replace('T', ' ')}` };
  else if (check) res.supervisor = { state: 'down', why: 'not running' };
  else {
    try {
      const pid = start(root, 'harness/supervisor.mjs', [...supervisorArgs(argv), '--foreground'], 'supervisor.log', denv);
      res.supervisor = { state: 'started', pid };
      try { emit({ type: 'boot.started', agent: BY, msg: `studio:boot started the supervisor (pid ${pid})`, meta: { what: 'supervisor', pid, args: supervisorArgs(argv) } }); } catch {}
    } catch (e) { res.supervisor = { state: 'failed', why: String(e.message || e).slice(0, 200) }; }
  }
  return res;
}

const NOT_OUTSIDE = new Set(['supervisor', 'watch', 'watchdog', 'launcher', 'unknown', 'agent', 'producer', 'conductor', 'harness', 'self-triage', 'train-daemon', 'locks', 'qa', BY]);
/** Agents with no launcher session record seen in the event log in the last 6 h: [{ agent, ageMin }], newest first. */
export async function outsideAgents({ root = REPO_ROOT, now = Date.now(), events = null } = {}) {
  const { agentLikeName } = await import('./agent-env.mjs');
  const ev = events || readRecentEvents(5000);
  const last = new Map();
  for (const e of ev) {
    const a = String(e?.agent || '').trim();
    const t = Date.parse(e?.ts || '') || 0;
    if (!a || NOT_OUTSIDE.has(a) || !/^[\w.-]{1,60}$/.test(a) || now - t > 6 * 3600000) continue;
    if (fs.existsSync(path.join(root, '.studio', 'agents', `${a}.json`))) continue;
    if (!agentLikeName(a, { stateDir: path.join(root, '.studio') })) continue;
    if (!last.has(a) || last.get(a) < t) last.set(a, t);
  }
  return [...last.entries()].sort((x, y) => y[1] - x[1]).map(([agent, t]) => ({ agent, ageMin: Math.max(0, Math.round((now - t) / 60000)) }));
}

/** Step 4's facts: { crew, train, halt, needs, outside, lanes, leftovers, url }. Every source is optional. */
export async function cardFacts({ root = REPO_ROOT, env = process.env, now = Date.now() } = {}) {
  const f = { crew: [], train: null, trainAuto: null, queue: { lanes: 0, held: 0 }, halt: null, needs: [], outside: [], lanes: 0, leftovers: [], url: `http://localhost:${hubPort(env)}/` };
  const tryIt = async (fn) => { try { await fn(); } catch { /* a source that can't be read is left out */ } };
  await tryIt(async () => { f.crew = (await import('./agent.mjs')).sessions().filter((s) => s.running).map((s) => ({ agent: s.agent, task: s.task || null, role: s.role || null })); });
  await tryIt(async () => { const ts = await import('./train-status.mjs'); f.train = ts.trainStatusLine(ts.readTrainStatus(root)) || null; });
  await tryIt(async () => { const a = (await import('./train-daemon.mjs')).trainAuto(root, env); f.trainAuto = a.on ? 'on (runs in each supervisor pass)' : `off: ${a.why}`; });
  await tryIt(async () => { const q = readJson(path.join(root, '.studio', 'train', 'queue.json')); if (Array.isArray(q)) f.queue = { lanes: q.length, held: q.filter((e) => e?.held && !(e.released && e.released.head === e.head)).length }; });
  await tryIt(async () => { const s = readJson(path.join(root, '.studio', 'supervisor.json')); if (s?.status === 'running' && s.halted) f.halt = String(s.halted.why || 'no reason recorded').slice(0, 160); });
  await tryIt(async () => { f.needs = (await (await import('./digest.mjs')).needsPerson({ now, root })).filter((n) => n.kind !== 'halt' || !f.halt).map((n) => n.line); });
  await tryIt(async () => { f.outside = await outsideAgents({ root, now }); });
  await tryIt(async () => { const wt = await import('./worktree.mjs'); f.lanes = wt.laneCopies(root).length; f.leftovers = wt.leftoverLaneFolders(root).map((x) => x.name).filter((n) => !n.startsWith('_train-')); });
  return f;
}

export function cardLines({ name, version, pre, swept, daemons, facts, check }) {
  const L = [`Studio boot${check ? ' (check: nothing cleared or started)' : ''}: ${name}, harness ${version}`];
  const bad = pre.filter((i) => i.status === 'WARN' || i.status === 'FAIL');
  L.push(`  preflight   ${pre.some((i) => i.status === 'FAIL') ? 'FAIL' : 'PASS'}: ${pre.filter((i) => i.status === 'PASS').map((i) => i.detail).join(' · ')}${bad.length ? ` · ${bad.length} to fix below` : ''}`);
  for (const i of pre.filter((x) => x.status !== 'PASS')) { L.push(`    ${i.status.padEnd(4)} ${i.id}: ${i.detail}`); if (i.fix) L.push(`         Fix: ${i.fix}`); }
  L.push(`  stale       ${swept.length ? swept.map((s) => `${s.file} ${s.action} (${s.why})`).join('; ') : 'nothing stale'}`);
  const d = (x) => (!x ? '?' : `${x.state}${x.pid ? ` (pid ${x.pid})` : ''}${x.why ? `: ${x.why}` : ''}`);
  L.push(`  hub         ${d(daemons.hub)}${daemons.hub?.state === 'started' ? ', log .studio/logs/hub.log' : ''}`);
  L.push(`  supervisor  ${d(daemons.supervisor)}${daemons.supervisor?.state === 'started' ? ', log .studio/logs/supervisor.log' : daemons.supervisor?.state === 'down' ? ' (npm run studio:boot starts it)' : ''}`);
  L.push(`  train       daemon ${facts.trainAuto || '?'} · ${facts.train || 'no train running'} · queue ${facts.queue.lanes} lane(s)${facts.queue.held ? `, ${facts.queue.held} held for a person` : ''}`);
  L.push(`  crew        ${facts.crew.length ? `${facts.crew.length} session(s) running: ${facts.crew.slice(0, 8).map((c) => `${c.agent}${c.task ? ` (${c.task})` : ''}`).join(', ')}${facts.crew.length > 8 ? ' …' : ''}` : 'no sessions running'}`);
  L.push(`  halts       ${facts.halt ? `the supervisor is halted: ${facts.halt} (npm run studio:resume -- --by <you>)` : 'none'}`);
  L.push(`  needs you   ${facts.needs.length ? `${facts.needs.length}:` : 'nothing'}`);
  for (const n of facts.needs.slice(0, 6)) L.push(`    - ${n}`);
  if (facts.needs.length > 6) L.push(`    … and ${facts.needs.length - 6} more (npm run digest)`);
  if (facts.outside.length) L.push(`  outside     agents with no launcher session, last seen: ${facts.outside.slice(0, 6).map((o) => `${o.agent} ${o.ageMin} min ago${o.ageMin > 30 ? ' (quiet)' : ''}`).join(', ')}`);
  L.push(`  lanes       ${facts.lanes} lane cop${facts.lanes === 1 ? 'y' : 'ies'}${facts.leftovers.length ? ` · ${facts.leftovers.length} leftover folder(s) in .lanes/ (not lanes, left alone): ${facts.leftovers.slice(0, 6).join(', ')}${facts.leftovers.length > 6 ? ' …' : ''}` : ''}`);
  L.push(`  War Room    ${facts.url}${daemons.hub?.state === 'started' || daemons.hub?.state === 'running' ? '' : ' (not answering)'} (the buttons need the link with your token: the hub prints it in .studio/logs/hub.log)`);
  return L;
}

/** The Desktop folder: %USERPROFILE%\Desktop (else %OneDrive%\Desktop) on Windows, ~/Desktop elsewhere. */
export function desktopDir({ env = process.env, platform = process.platform } = {}) {
  const home = platform === 'win32' ? env.USERPROFILE || os.homedir() : env.HOME || os.homedir();
  const cands = [path.join(home, 'Desktop'), ...(platform === 'win32' && env.OneDrive ? [path.join(env.OneDrive, 'Desktop')] : [])];
  return cands.find((d) => fs.existsSync(d)) || null;
}

/** --shortcut: { ok, file?, why? }. A .cmd on Windows (npm.cmd, so PowerShell's policy never blocks it), else a .sh. */
export function writeShortcut({ root = REPO_ROOT, env = process.env, platform = process.platform } = {}) {
  const desk = desktopDir({ env, platform });
  if (!desk) return { ok: false, why: 'no Desktop folder found' };
  const name = path.basename(root).replace(/[^\w.-]+/g, '-') || 'studio';
  if (platform === 'win32') {
    const file = path.join(desk, `Studio boot (${name}).cmd`);
    const dir = root.replace(/%/g, '%%');
    fs.writeFileSync(file, `@echo off\r\nrem Made by npm run studio:boot -- --shortcut: brings the studio up (hub, supervisor) and shows its status card.\r\ncd /d "${dir}"\r\ncall npm.cmd run studio:boot\r\npause\r\n`);
    return { ok: true, file };
  }
  const file = path.join(desk, `studio-boot-${name}.sh`);
  fs.writeFileSync(file, `#!/bin/sh\n# Made by npm run studio:boot -- --shortcut: brings the studio up (hub, supervisor) and shows its status card.\ncd '${root.replace(/'/g, "'\\''")}' && npm run studio:boot\n`, { mode: 0o755 });
  return { ok: true, file };
}

export async function boot({ root = REPO_ROOT, env = process.env, argv = [], now = Date.now() } = {}) {
  const check = argv.includes('--check');
  const pre = preflightLite({ root, env });
  const swept = staleSweep({ root, dry: check });
  const daemons = await startDaemons({ root, env, argv, check });
  const facts = await cardFacts({ root, env, now });
  const shortcut = argv.includes('--shortcut') ? writeShortcut({ root, env }) : null;
  const pkg = readJson(path.join(root, 'package.json')) || {};
  const lines = cardLines({ name: path.basename(root), version: pkg.version || '?', pre, swept, daemons, facts, check });
  if (shortcut) lines.push(shortcut.ok ? `  shortcut    ${shortcut.file}` : `  shortcut    not written: ${shortcut.why}`);
  const failed = [daemons.hub, daemons.supervisor].some((x) => x?.state === 'failed') || pre.some((i) => i.status === 'FAIL');
  return { ok: !failed, check, pre, swept, daemons, facts, shortcut, lines };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  fs.mkdirSync(STUDIO_STATE_DIR, { recursive: true });
  const r = await boot({ argv });
  if (argv.includes('--json')) console.log(JSON.stringify({ ...r, lines: undefined }));
  else console.log(r.lines.join('\n'));
  process.exit(r.ok ? 0 : 1);
}
