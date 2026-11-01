#!/usr/bin/env node
/**
 * harness/heavy.mjs — 2.59.0 (#11, #2): the machine:heavy lock, and the load a gate's timeout is scaled for.
 *
 * Full verifies, a Unity editor run (6-7 GB) and 3D browser playtests (about 5 GB each) overlapping on one PC gave
 * e2e timeouts ("Test timed out in 120000ms", "timed out after 600 s") and a dip to 2.6 GB free. Gate slots
 * (merge-lane.mjs withGateSlot, STUDIO_GATE_SLOTS) only spread single game checks; nothing kept whole heavy runs
 * apart. Heavy work now takes one of STUDIO_HEAVY_SLOTS (1) slots in <main checkout>/.studio/locks/
 * machine-heavy-<n>.lock (every lane copy shares the main checkout's, like the gate slots) while it runs:
 *   - a full verify (scripts/run-gates.mjs: the full set, or any run that includes a heavy gate: game, browser-play);
 *   - the Unity landing gate (harness/unity-gate.mjs);
 *   - anything wrapped in `node harness/heavy.mjs run --label <what> -- <command>` (a game's own browser playtest).
 * It is one slot class beside the gate slots: a full verify holds machine:heavy for its whole run and its game
 * checks still take gate slots, so a landing's game checks (task done) are not held up by it.
 *
 * A holder records its pid and start identity (harness/proc-identity.mjs): a dead holder, or a pid now used by
 * another program (Linux /proc start), is stale and taken over, as is one older than STUDIO_HEAVY_STALE_MIN (240).
 * A waiter waits, naming the holder (again every 5 min), up to STUDIO_HEAVY_WAIT_MIN (60), then fails clearly
 * (code HEAVY_BUSY): heavy work never runs on top of other heavy work just because it waited. A landing
 * (STUDIO_GATE_PRIORITY=landing) leaves a machine-heavy-landing-<pid>.wait marker and goes ahead of other waiters;
 * a running holder is never stopped. The children of a holder (the gates a verify runs) see STUDIO_HEAVY_HELD and
 * don't wait for their own parent. STUDIO_HEAVY_SLOTS=0 turns it off.
 *
 *   node harness/heavy.mjs status                       who holds machine:heavy now (JSON with --json)
 *   node harness/heavy.mjs run --label <what> -- <cmd>  run a command under the lock; exits with its code
 *   node harness/heavy.mjs stop [--label <x> | --all] --by <name>
 *                                                       kill a holder's whole process tree and free its slot
 *
 * 2.60.0 (#5): killing a bash landing loop on Windows left `npm run verify` and its vitest workers running (Git Bash
 * can't kill a process group there; the crew used taskkill /T /F by hand). So a holder also records its process tree
 * ("tree": its root pid and start, the POSIX process groups it runs its work in, and how it is killed: taskkill /T /F
 * on Windows, the process group elsewhere). `stop` lists the processes once (harness/proc-identity.mjs
 * listProcesses), kills the holder's tree (the root, its descendants, every process left in its groups), checks
 * they are gone, frees the slot and records a heavy.stop event; it is refused in a worker session (harness/
 * permission.mjs: a launched non-Producer/Director role, or a worker agent's name). A holder whose root is gone
 * frees its slot on the next take as before, and processes its tree left running (orphans: a killed parent's
 * children) are found and killed first (POSIX: still in its group; Windows: they still name the dead parent's pid
 * and started after it), so the next heavy job doesn't run on top of them (STUDIO_HEAVY_REAP=off only names them).
 * `heavy.mjs run` runs its command in a process group of its own (POSIX) and records it; a full verify
 * (scripts/run-gates.mjs) re-runs itself as the leader of a new group (heavyOwnGroup), so a stop gets its gates.
 * A live holder past STUDIO_HEAVY_STALE_MIN loses its slot as before but is never killed by a take.
 *
 * 2.60.1 (B-17, B-35): on Windows os.loadavg() is always zeros, so a game check timed out at its base 600 s with the
 * CPU 63% busy and a Unity editor open (the suite takes about 555 s quiet), and no scaling line was printed.
 *   - Where there is no load average (Windows, or all zeros), loadFactor samples os.cpus() twice ~500 ms apart; a
 *     busy fraction over STUDIO_CPU_BUSY_THRESHOLD (0.6) adds 0.5 at the threshold up to 2 at 100%, as the load
 *     term does (STUDIO_CPU_PROBE=off skips the probe).
 *   - A heavy program running outside the lock (STUDIO_HEAVY_PROGRAMS, default Unity.exe,Unity: a Unity editor
 *     someone opened) that is in no holder's tree is an implicit holder: it counts like another heavy job in
 *     loadFactor and `status` lists it. It doesn't make heavy jobs wait (an editor can stay open all day).
 *   - scaledTimeout(base, root, { label }) never gives less than STUDIO_GAME_GATE_TIMEOUT_FLOOR (1.5) times the
 *     check's last passing run at factor 1 (recordGateTime, .studio/gates/game-gate-times.json in the main checkout),
 *     capped at STUDIO_GAME_GATE_TIMEOUT_MAX_FACTOR (3) times the base like the load factor: one bound, and a suite
 *     whose quiet time nears that needs its base raised, which is the owner's setting, not the harness's.
 *   - acquireHeavy checks free memory against STUDIO_HEAVY_RAM_FLOOR_GB, else STUDIO_RAM_FLOOR_GB (supervisor.mjs
 *     ramCheck, 3; 0 turns it off): under it the job
 *     waits, saying so, up to STUDIO_HEAVY_RAM_WAIT_MIN (10, at most STUDIO_HEAVY_WAIT_MIN), then fails HEAVY_BUSY.
 *
 * Test hooks: STUDIO_TEST_LOADAVG=<1-min load> stands in for os.loadavg()[0] in loadFactor (unset: the real one; set,
 * the CPU probe is not used); STUDIO_TEST_CPU_BUSY=<0..1> stands in for the CPU probe (and is used even where a load
 * average exists); STUDIO_PROC_LIST_STUB (proc-identity.mjs) for the process list; STUDIO_TEST_FREEMEM_MB for free
 * memory (supervisor.mjs ramCheck).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { selfIdentity, spawnedIdentity, pidAlive, processGroup, listProcesses, sameProcess } from './proc-identity.mjs';
import { DECIDER_ROLES, WORKER_NAME } from './permission.mjs';
import { emitEvent } from './event.mjs';
import { landingWaiters } from './merge-lane.mjs';
import { ramCheck } from './ram.mjs';

const PREFIX = 'machine-heavy';
const SLOT_RE = /^machine-heavy-(\d+)\.lock$/;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const num = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const mins = (ms) => Math.max(0, Math.round(ms / 60000));
const span = (ms) => (ms < 120000 ? `${Math.round(ms / 1000)} s` : `${mins(ms)} min`);

/** The main checkout (lane copies share its .studio/locks), else this checkout. */
export async function heavyRoot() {
  try { return (await import('./worktree.mjs')).mainRoot(); } catch { return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); }
}
export const heavyDir = (root) => path.join(root, '.studio', 'locks');
export const heavySlots = (env = process.env) => num(env.STUDIO_HEAVY_SLOTS, 1);
const staleOf = (env) => num(env.STUDIO_HEAVY_STALE_MIN, 240) * 60000;

/** Linux: a process that has ended but whose parent hasn't collected it yet (a zombie) still answers kill(pid, 0). */
function zombie(pid) {
  if (process.platform !== 'linux') return false;
  try { const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return st.slice(st.lastIndexOf(')') + 2, st.lastIndexOf(')') + 3) === 'Z'; } catch { return false; }
}
/** A holder record is live: its process runs (same start identity where the OS tells) and it isn't too old. */
export function holderLive(h, { staleMs = 240 * 60000 } = {}) {
  return Boolean(h?.pid) && pidAlive(h.pid, h.identity) && !zombie(h.pid) && !(Date.now() - Number(h.at || 0) > staleMs);
}
export const describeHolder = (h) => `${h.label || 'heavy work'}${h.owner ? ` by ${h.owner}` : ''} (pid ${h.pid}, for ${span(Date.now() - Number(h.at || 0))})`;

/** Live machine:heavy holders: [{ pid, label, owner, at, file }]. Read-only (stale files are left to a waiter). */
export function heavyHolders(root, { env = process.env } = {}) {
  const dir = heavyDir(root);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!SLOT_RE.test(n)) continue;
    const h = readJson(path.join(dir, n));
    if (holderLive(h, { staleMs: staleOf(env) })) out.push({ ...h, file: n });
  }
  return out;
}

// ---- 2.60.0 (#5): a holder's process tree, and killing it ----

const TREE_TOL_MS = 3000;
const off = (v) => /^(off|0|false|no)$/i.test(String(v || ''));

/** This process as a tree root: its pid, its POSIX process group when it leads one, and how its tree is killed. */
export function selfTree({ platform = process.platform, group = undefined } = {}) {
  const g = group !== undefined ? group : platform === 'win32' ? null : processGroup(process.pid);
  const own = g === process.pid ? g : null;
  return { root: process.pid, groups: own ? [own] : [], kill: platform === 'win32' ? 'taskkill /T /F <root>' : own ? 'the process group' : 'the root and its descendants' };
}

/** The holder's root process has ended (or its number is another program's now, or it is a zombie). */
export function holderGone(h) {
  return !h?.pid || !pidAlive(h.pid, h.identity) || zombie(h.pid);
}

/**
 * Which processes in `procs` (listProcesses) belong to holder `h`'s tree: { members: [pid], top: [pid] (members whose
 * parent isn't one: what taskkill /T is pointed at), groups: [pgid] (POSIX groups with members left), rootLive }.
 *  - root alive and the same process (start identity): it and every descendant (a child started before its parent
 *    can't be one: a reused parent number);
 *  - root gone, or its number reused: its orphans. Windows keeps a child's ParentProcessId after the parent ends, so
 *    those still naming the root's pid that started after the root (and before a reusing process) and their
 *    descendants; POSIX re-parents orphans, so there:
 *  - the recorded process groups: every live member that started after the root, and its descendants (a group's
 *    number isn't reused while it has members; a group whose leader number is now another program is skipped).
 * Never this process or its ancestors (a stop run from inside the tree).
 */
export function holderTree(h, procs, { self = process.pid } = {}) {
  const list = (procs || []).filter((p) => p && Number.isInteger(Number(p.pid)));
  const byPid = new Map(list.map((p) => [Number(p.pid), p]));
  const kids = new Map();
  for (const p of list) {
    const k = Number(p.ppid);
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k).push(p);
  }
  const root = Number(h?.tree?.root || h?.pid);
  const recId = h?.tree?.root && Number(h.tree.root) !== Number(h.pid) ? h.tree.rootIdentity : h?.identity;
  const cur = byPid.get(root);
  const sameAs = cur && !cur.zombie ? sameProcess(recId, cur) : false;
  const rootLive = Boolean(cur && !cur.zombie && sameAs !== false);
  const rootStart = Number(recId?.start) || 0;
  const earliest = rootStart ? rootStart - (recId?.self ? 10000 : TREE_TOL_MS) : 0;
  const reusedAt = cur && !rootLive ? Number(cur.start) || 0 : 0;
  const members = new Set();
  const startOf = (p) => Number(p.start) || 0;
  const walk = (pid, parentStart) => {
    for (const c of kids.get(pid) || []) {
      const cp = Number(c.pid);
      if (members.has(cp) || c.zombie || cp === pid) continue;
      if (parentStart && startOf(c) && startOf(c) < parentStart - TREE_TOL_MS) continue;
      members.add(cp);
      walk(cp, startOf(c) || parentStart);
    }
  };
  if (rootLive) {
    members.add(root);
    walk(root, rootStart);
  } else {
    for (const c of kids.get(root) || []) {
      const st = startOf(c);
      if (c.zombie || (st && earliest && st < earliest) || (st && reusedAt && st >= reusedAt)) continue;
      members.add(Number(c.pid));
      walk(Number(c.pid), st);
    }
  }
  {
    // 2.60.0 (#5, Windows): the holder's own children are recorded (tree.children). When the holder dies, Node's job
    // object takes its direct child (the shell) with it, but the shell's children broke away and live on, naming the
    // dead shell as their parent: they are found through the recorded child, as the root's orphans are through it.
    // 2.65.0: also while the holder still runs (a full verify's gate shell that ended and left children running:
    // scripts/run-gates.mjs records each gate's shell, harness/gate-spawn.mjs); a live recorded child is already in the
    // walk above then.
    for (const [cpRaw, cRec] of Object.entries(h?.tree?.children || {})) {
      const cp = Number(cpRaw);
      if (!Number.isInteger(cp) || cp <= 0 || cp === root) continue;
      const cur2 = byPid.get(cp);
      const same = cur2 && !cur2.zombie ? sameProcess(cRec, cur2) : false;
      const cStart = Number(cRec?.start) || 0;
      if (cur2 && !cur2.zombie && same !== false) {
        if (!(cStart && startOf(cur2) && startOf(cur2) < cStart - TREE_TOL_MS)) { members.add(cp); walk(cp, startOf(cur2) || cStart); }
        continue;
      }
      const reused2 = cur2 ? startOf(cur2) : 0;
      for (const c of kids.get(cp) || []) {
        const st = startOf(c);
        if (c.zombie || (st && cStart && st < cStart - TREE_TOL_MS) || (st && reused2 && st >= reused2)) continue;
        members.add(Number(c.pid));
        walk(Number(c.pid), st);
      }
    }
  }
  const groups = [];
  for (const g of [...new Set((h?.tree?.groups || []).map(Number).filter((x) => Number.isInteger(x) && x > 0))]) {
    const leader = byPid.get(g);
    if (g === root && cur && !rootLive) continue; // the root's number is another program's now
    const leaderRec = g === root ? recId : h?.tree?.groupIds?.[g];
    if (g !== root && leader && leaderRec && sameProcess(leaderRec, leader) === false) continue;
    const inG = list.filter((p) => Number(p.pgid) === g && !p.zombie && !(earliest && startOf(p) && startOf(p) < earliest));
    if (!inG.length) continue;
    groups.push(g);
    for (const p of inG) {
      members.add(Number(p.pid));
      walk(Number(p.pid), startOf(p));
    }
  }
  // Never this process or the processes it runs under.
  for (let p = self, n = 0; p && n < 64; n += 1) {
    members.delete(p);
    const rec = byPid.get(p);
    if (!rec || Number(rec.ppid) === p) break;
    p = Number(rec.ppid);
  }
  const selfGroup = byPid.get(self)?.pgid;
  const top = [...members].filter((pid) => !members.has(Number(byPid.get(pid)?.ppid)));
  return { members: [...members].sort((a, b) => a - b), top, groups: groups.filter((g) => Number(g) !== Number(selfGroup)), rootLive };
}

const safeEvent = (e) => { try { emitEvent(e); } catch {} };
const defaultSignal = (pid, sig) => { try { process.kill(pid, sig); return true; } catch { return false; } };
const defaultExec = (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore', windowsHide: true, timeout: 30000 });

/**
 * Kill holder `h`'s tree and check it is gone: { members, killed, survivors, commands, rootLive }. Windows: taskkill
 * /T /F for each top member (the root while it lives, else each orphan). POSIX: SIGTERM to each group and each other
 * member, then after STUDIO_HEAVY_STOP_GRACE_MS (3000) SIGKILL to what is left. Injectable for tests: listProcs
 * (listProcesses), exec(cmd, args) (taskkill), signal(pid, sig) (process.kill), platform.
 */
export function killHolderTree(h, { listProcs = listProcesses, exec = defaultExec, signal = defaultSignal, platform = process.platform, graceMs = num(process.env.STUDIO_HEAVY_STOP_GRACE_MS, 3000), self = process.pid } = {}) {
  const t = holderTree(h, listProcs(), { self });
  const commands = [];
  if (!t.members.length) return { ...t, killed: [], survivors: [], commands };
  // The same process as before the kill (not a new one given its number): same /proc start, else start within 2 s.
  const before = new Map();
  const same = (a, b) => (a.proc && b.proc ? a.proc === b.proc : !a.start || !b.start || Math.abs(Number(a.start) - Number(b.start)) < 2000);
  const alive = () => {
    let now;
    try { now = listProcs(); } catch { return t.members; }
    const m = new Map(now.map((p) => [Number(p.pid), p]));
    return t.members.filter((pid) => { const p = m.get(pid); return p && !p.zombie && (!before.has(pid) || same(before.get(pid), p)); });
  };
  try { for (const p of listProcs()) if (t.members.includes(Number(p.pid))) before.set(Number(p.pid), p); } catch {}
  if (platform === 'win32') {
    for (const pid of t.top) { commands.push(['taskkill', '/T', '/F', '/PID', String(pid)]); exec('taskkill', ['/T', '/F', '/PID', String(pid)]); }
  } else {
    for (const g of t.groups) { commands.push(['kill', '-TERM', `-${g}`]); signal(-g, 'SIGTERM'); }
    for (const pid of t.members) { commands.push(['kill', '-TERM', String(pid)]); signal(pid, 'SIGTERM'); }
  }
  let left = alive();
  for (const t0 = Date.now(); left.length && Date.now() - t0 < graceMs; left = alive()) sleep(100);
  if (left.length) {
    if (platform === 'win32') for (const pid of left) { commands.push(['taskkill', '/T', '/F', '/PID', String(pid)]); exec('taskkill', ['/T', '/F', '/PID', String(pid)]); }
    else {
      for (const g of t.groups) { commands.push(['kill', '-KILL', `-${g}`]); signal(-g, 'SIGKILL'); }
      for (const pid of left) { commands.push(['kill', '-KILL', String(pid)]); signal(pid, 'SIGKILL'); }
    }
    for (const t0 = Date.now(); left.length && Date.now() - t0 < 5000; left = alive()) sleep(100);
  }
  return { ...t, killed: t.members.filter((p) => !left.includes(p)), survivors: left, commands };
}

/** A gone holder's leftovers, at a take (acquireHeavy): killed (STUDIO_HEAVY_REAP=off: only named). Never throws. */
function reapOrphans(h, { log = () => {}, env = process.env, ...opts } = {}) {
  try {
    if (off(env.STUDIO_HEAVY_REAP)) {
      const t = holderTree(h, (opts.listProcs || listProcesses)());
      if (t.members.length) log(`[heavy] ${describeHolder(h)} left ${t.members.length} process(es) running (pids ${t.members.join(', ')}); STUDIO_HEAVY_REAP=off: not stopped (node harness/heavy.mjs stop --all --by <name> stops them)`);
      return null;
    }
    const r = killHolderTree(h, opts);
    if (r.members.length) {
      log(`[heavy] ${describeHolder(h)} left ${r.members.length} process(es) of its tree running (pids ${r.members.join(', ')}): stopped ${r.killed.length}${r.survivors.length ? `, still running: ${r.survivors.join(', ')}` : ''}`);
      safeEvent({ type: 'heavy.reap', agent: env.STUDIO_LOCK_OWNER || 'heavy', status: r.survivors.length ? 'warn' : 'ok', msg: `machine:heavy: ${h.label || 'heavy work'} (pid ${h.pid}) was gone; ${r.killed.length} leftover process(es) of its tree stopped${r.survivors.length ? `, ${r.survivors.length} still running` : ''}`, meta: { label: h.label || null, pid: h.pid, killed: r.killed, survivors: r.survivors } });
    }
    return r;
  } catch (err) {
    log(`[heavy] couldn't check what ${describeHolder(h)} left running: ${String(err.message || err).slice(0, 120)}`);
    return null;
  }
}

/** Every machine:heavy slot record, live or not: [{ ...record, file, live }]. */
export function heavyRecords(root, { env = process.env } = {}) {
  const dir = heavyDir(root);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => SLOT_RE.test(n)).sort().map((n) => ({ h: readJson(path.join(dir, n)), n })).filter((x) => x.h?.pid).map(({ h, n }) => ({ ...h, file: n, live: holderLive(h, { staleMs: staleOf(env) }) }));
}

/** A worker session may not stop heavy work: why not, or '' (harness/permission.mjs's worker test). */
export function stopRefusal(env = process.env) {
  const role = String(env.STUDIO_ROLE || '').trim();
  const owner = String(env.STUDIO_LOCK_OWNER || '').trim();
  if (role && !DECIDER_ROLES.test(role)) return `a launched ${role} session can't stop heavy work; a person, a Producer or Director session, or an agent outside the harness can`;
  if (owner && WORKER_NAME.test(owner)) return `${owner} is a worker agent; a person, a Producer or Director session, or an agent outside the harness can stop heavy work`;
  return '';
}

/**
 * `heavy.mjs stop`: kill each chosen holder's tree, free its slot once its root is gone, record heavy.stop.
 * Returns { ok, code, lines, stopped: [{ label, pid, killed, survivors, freed }] }.
 */
export function stopHeavy(root, { label = null, all = false, by = '', env = process.env, ...opts } = {}) {
  const lines = [];
  const refused = stopRefusal(env);
  if (refused) return { ok: false, code: 3, lines: [`[heavy] stop refused: ${refused}`], stopped: [] };
  if (!String(by || '').trim()) return { ok: false, code: 2, lines: ['[heavy] stop: say who stops it: --by <name>'], stopped: [] };
  let list;
  try { list = opts.listProcs ? opts.listProcs() : listProcesses(); } catch (err) { return { ok: false, code: 1, lines: [`[heavy] stop: couldn't list the processes: ${String(err.message || err).slice(0, 120)}`], stopped: [] }; }
  const recs = heavyRecords(root, { env }).map((r) => ({ r, t: holderTree(r, list, { self: opts.self || process.pid }) })).filter(({ r, t }) => r.live || t.members.length);
  const want = label ? String(label).toLowerCase() : null;
  let pick = want ? recs.filter(({ r }) => String(r.label || '').toLowerCase() === want) : recs;
  if (want && !pick.length) pick = recs.filter(({ r }) => String(r.label || '').toLowerCase().includes(want));
  const shown = (xs) => xs.map(({ r }) => `${describeHolder(r)}${r.live ? '' : ' (gone; its tree still runs)'}`).join('; ');
  if (!pick.length) return { ok: false, code: 1, lines: [recs.length ? `[heavy] stop: no machine:heavy holder matches "${label}"; holding: ${shown(recs)}` : '[heavy] stop: machine:heavy is free; nothing to stop'], stopped: [] };
  if (pick.length > 1 && !all) return { ok: false, code: 1, lines: [`[heavy] stop: ${pick.length} holders match (${shown(pick)}); name one with --label or stop them all with --all`], stopped: [] };
  const stopped = [];
  for (const { r } of pick) {
    const k = killHolderTree(r, { ...opts, listProcs: opts.listProcs || (() => listProcesses()) });
    let freed = false;
    if (holderGone(r)) {
      const f = path.join(heavyDir(root), r.file);
      try { const cur = readJson(f); if (cur?.pid === r.pid && cur.at === r.at) fs.rmSync(f, { force: true }); freed = !fs.existsSync(f) || readJson(f)?.pid !== r.pid; } catch {}
    }
    stopped.push({ label: r.label || null, pid: r.pid, killed: k.killed, survivors: k.survivors, freed, commands: k.commands });
    lines.push(`[heavy] stopped ${describeHolder(r)} for ${by}: ${k.killed.length} process(es) of its tree killed (${r.tree?.kill || 'its root and descendants'})${k.killed.length ? `: pids ${k.killed.join(', ')}` : ''}${k.survivors.length ? `; still running: ${k.survivors.join(', ')}` : ''}; ${freed ? 'its machine:heavy slot is free' : 'its slot is still held'}`);
    safeEvent({ type: 'heavy.stop', agent: by, status: k.survivors.length ? 'warn' : 'ok', msg: `machine:heavy: ${by} stopped ${r.label || 'heavy work'} (pid ${r.pid}): ${k.killed.length} process(es) killed${k.survivors.length ? `, ${k.survivors.length} still running` : ''}${freed ? ', slot freed' : ''}`.slice(0, 400), meta: { by, recordedBy: env.STUDIO_LOCK_OWNER || null, label: r.label || null, pid: r.pid, owner: r.owner || null, killed: k.killed, survivors: k.survivors, freed } });
  }
  const bad = stopped.filter((x) => x.survivors.length || !x.freed);
  return { ok: !bad.length, code: bad.length ? 1 : 0, lines, stopped };
}

/**
 * POSIX: run this script again as the leader of a process group of its own and wait for it (its exit code), so
 * every process it starts can be killed with its group, even after it is killed itself (a full verify: npm, node,
 * vitest workers). null when that isn't needed: Windows (taskkill /T walks the tree, and orphans keep their parent's
 * pid), already a group leader, inside a parent's machine:heavy hold, STUDIO_HEAVY_SLOTS=0, or
 * STUDIO_HEAVY_OWN_GROUP=off. Signals this process gets (Ctrl+C, a SIGTERM) go on to the group.
 */
export async function heavyOwnGroup({ env = process.env, argv = process.argv.slice(1) } = {}) {
  if (process.platform === 'win32' || !(heavySlots(env) > 0) || off(env.STUDIO_HEAVY_OWN_GROUP)) return null;
  if (env.STUDIO_HEAVY_REEXEC && env.STUDIO_HEAVY_REEXEC === String(process.ppid)) return null;
  if (heldByParent(heavyDir(await heavyRoot()), env)) return null;
  const g = processGroup(process.pid);
  if (g === null || g === process.pid) return null;
  const child = spawn(process.execPath, [...process.execArgv, ...argv], { stdio: 'inherit', detached: true, env: { ...env, STUDIO_HEAVY_REEXEC: String(process.pid) } });
  const fwd = (sig) => () => { try { process.kill(-child.pid, sig); } catch {} };
  const sigs = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => [s, fwd(s)]);
  for (const [s, f] of sigs) process.on(s, f);
  return new Promise((resolve) => {
    child.on('error', () => resolve(1));
    child.on('exit', (code, sig) => {
      for (const [s, f] of sigs) process.off(s, f);
      resolve(code ?? (sig ? 128 + (os.constants.signals[sig] || 1) : 1));
    });
  });
}

/** STUDIO_HEAVY_HELD="<lock file>:<pid>": a parent of this process holds machine:heavy (and still does). */
function heldByParent(dir, env) {
  const m = String(env.STUDIO_HEAVY_HELD || '').match(/^(machine-heavy-\d+\.lock):(\d+)$/);
  if (!m) return null;
  const h = readJson(path.join(dir, m[1]));
  return h && Number(h.pid) === Number(m[2]) && holderLive(h, { staleMs: staleOf(env) }) ? h : null;
}

/**
 * Take a machine:heavy slot (sync; waits). Returns { release(), held, waitedMs, skipped?, inside? }. Throws an
 * Error with code HEAVY_BUSY when the wait limit passes. While held, process.env.STUDIO_HEAVY_HELD names the slot
 * so the processes this one starts don't wait for it.
 */
export function acquireHeavy(root, label, { log = () => {}, env = process.env, owner = null, freemem = undefined } = {}) {
  const n = heavySlots(env);
  const none = { release: () => {}, update: () => false, held: null, waitedMs: 0 };
  if (!(n > 0)) return { ...none, skipped: true };
  const dir = heavyDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const parent = heldByParent(dir, env);
  if (parent) return { ...none, inside: parent };
  const staleMs = staleOf(env);
  const waitMs = num(env.STUDIO_HEAVY_WAIT_MIN, 60) * 60000;
  // 2.60.1 (B-35): free memory under STUDIO_RAM_FLOOR_GB holds the start back, for at most this long.
  const ramWaitMs = Math.min(waitMs, num(env.STUDIO_HEAVY_RAM_WAIT_MIN, 10) * 60000);
  const poll = num(env.STUDIO_HEAVY_POLL_MS, 2000);
  const remind = num(env.STUDIO_HEAVY_REMIND_MS, 5 * 60000);
  const landing = String(env.STUDIO_GATE_PRIORITY || '').toLowerCase() === 'landing';
  const marker = landing ? path.join(dir, `${PREFIX}-landing-${process.pid}.wait`) : null;
  const t0 = Date.now();
  let mine = null;
  let toldAt = 0;
  let holders = [];
  let ram = { low: false };
  // STUDIO_HEAVY_RAM_FLOOR_GB, when set, is heavy work's own floor; else the agents' STUDIO_RAM_FLOOR_GB (3).
  const ownFloor = env.STUDIO_HEAVY_RAM_FLOOR_GB !== undefined && env.STUDIO_HEAVY_RAM_FLOOR_GB !== '';
  const ramVar = ownFloor ? 'STUDIO_HEAVY_RAM_FLOOR_GB' : 'STUDIO_RAM_FLOOR_GB';
  const ramEnv = ownFloor ? { ...env, STUDIO_RAM_FLOOR_GB: env.STUDIO_HEAVY_RAM_FLOOR_GB } : env;
  let ramTold = false;
  try {
    while (!mine) {
      const ahead = landing ? [] : landingWaiters(dir, { staleMs, prefix: PREFIX });
      try { ram = ramCheck(freemem ? { freemem } : {}, ramEnv); } catch { ram = { low: false }; }
      const ramWhy = ram.low ? `free memory is ${ram.freeGb} GB, under the floor (${ramVar}=${ram.floorGb})` : '';
      if (ram.low && Date.now() - t0 >= ramWaitMs) {
        throw Object.assign(new Error(`[heavy] ${label} did not start: ${ramWhy} and stayed there for ${span(Date.now() - t0)} (STUDIO_HEAVY_RAM_WAIT_MIN). Heavy work never starts that low on memory (a Unity editor run takes 6-7 GB). Close what holds the memory (an open editor, a browser playtest) or run it again later; ${ramVar}=0 turns the check off.`), { code: 'HEAVY_BUSY', ram: true, holders });
      }
      if (ram.low && !ramTold) {
        log(`[heavy] ${label} waits: ${ramWhy}; it starts once more is free, waiting up to ${span(ramWaitMs)}`);
        ramTold = true;
        toldAt = Date.now();
      }
      if (!ram.low && ramTold) { log(`[heavy] ${label}: free memory is back over the floor (${ram.freeGb ?? '?'} GB)`); ramTold = false; }
      holders = [];
      for (let i = 1; i <= n && !mine; i += 1) {
        const f = path.join(dir, `${PREFIX}-${i}.lock`);
        const h = readJson(f);
        if (h && holderLive(h, { staleMs })) { holders.push(h); continue; }
        if (fs.existsSync(f)) {
          // Stale (dead holder, reused pid, too old) or unreadable for more than a moment: take it over.
          if (h || Date.now() - (fs.statSync(f, { throwIfNoEntry: false })?.mtimeMs || 0) > 5000) {
            if (h) log(`[heavy] ${describeHolder(h)} is gone: its machine:heavy slot is free again`);
            // 2.60.0 (#5): what its tree left running (a killed parent's children) goes first.
            if (h && holderGone(h)) reapOrphans(h, { log, env });
            try { fs.rmSync(f, { force: true }); } catch {}
          } else continue;
        }
        if (ahead.length || ram.low) continue;
        try {
          fs.writeFileSync(f, JSON.stringify({ pid: process.pid, identity: selfIdentity(), at: Date.now(), label, owner: owner || env.STUDIO_LOCK_OWNER || null, tree: selfTree(), ...(landing ? { landing: true } : {}) }), { flag: 'wx' });
          mine = f;
        } catch (err) {
          if (err.code !== 'EEXIST') throw err;
        }
      }
      if (mine) break;
      if (ram.low && !holders.length && !ahead.length) { sleep(poll); continue; }
      const busyWith = holders.length ? holders.map(describeHolder).join('; ') : ahead.length ? `a landing waiting first (${ahead.map((w) => w.label).join(', ')})` : 'unknown';
      if (Date.now() - t0 >= waitMs) {
        throw Object.assign(new Error(`[heavy] waited ${span(Date.now() - t0)} for the machine:heavy lock and it is still held: ${busyWith}. ${label} did not run (it never runs on top of other heavy work). Run it again when that ends (node harness/heavy.mjs status shows the holder); STUDIO_HEAVY_WAIT_MIN sets the wait.`), { code: 'HEAVY_BUSY', holders });
      }
      if (marker && !fs.existsSync(marker)) { try { fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, at: Date.now(), label })); } catch {} }
      if (!toldAt || Date.now() - toldAt >= remind) {
        log(`[heavy] ${label} waits for the machine:heavy lock (${n} slot${n === 1 ? '' : 's'}, STUDIO_HEAVY_SLOTS), held by ${busyWith}${landing ? '; a landing: it takes the next free slot ahead of other waiters' : ''}; waiting up to ${span(waitMs)}, which doesn't count toward its own timeouts`);
        toldAt = Date.now();
      }
      sleep(poll);
    }
  } finally {
    if (marker) try { fs.rmSync(marker, { force: true }); } catch {}
  }
  const waitedMs = Date.now() - t0;
  if (toldAt) log(`[heavy] ${label} got the machine:heavy lock after ${Math.round(waitedMs / 1000)} s`);
  const token = `${path.basename(mine)}:${process.pid}`;
  const prevEnv = process.env.STUDIO_HEAVY_HELD;
  process.env.STUDIO_HEAVY_HELD = token;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try { if (readJson(mine)?.pid === process.pid) fs.rmSync(mine, { force: true }); } catch {}
    if (process.env.STUDIO_HEAVY_HELD === token) { if (prevEnv === undefined) delete process.env.STUDIO_HEAVY_HELD; else process.env.STUDIO_HEAVY_HELD = prevEnv; }
  };
  // 2.60.0 (#5): add to the record while held (heavy.mjs run adds its command's process group to the tree).
  const update = (fn) => {
    if (released) return false;
    try {
      const cur = readJson(mine);
      if (cur?.pid !== process.pid) return false;
      fs.writeFileSync(mine, JSON.stringify(fn(cur)));
      return true;
    } catch { return false; }
  };
  return { release, update, held: path.basename(mine), waitedMs };
}

/** Run fn under machine:heavy (a returned promise is waited for before the slot is freed). */
export function withHeavy(root, label, fn, opts = {}) {
  const lk = acquireHeavy(root, label, opts);
  let out;
  try {
    out = fn(lk);
  } catch (err) {
    lk.release();
    throw err;
  }
  if (out && typeof out.then === 'function') return out.finally(() => lk.release());
  lk.release();
  return out;
}

/** Other gate-slot holders (merge-lane.mjs withGateSlot) than this process: [{ pid, label }]. */
function otherGateSlots(root, env) {
  const dir = heavyDir(root);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const staleMs = num(env.STUDIO_GATE_SLOT_STALE_MIN, 120) * 60000;
  return names.filter((n) => /^gate-slot-\d+\.lock$/.test(n)).map((n) => readJson(path.join(dir, n))).filter((h) => h?.pid && h.pid !== process.pid && pidAlive(h.pid, h.identity) && Date.now() - Number(h.at || 0) <= staleMs);
}

// ---- 2.60.1 (B-17, B-35): what loads the machine outside the lock ----

/** Heavy programs that may run outside the lock, lower-cased: STUDIO_HEAVY_PROGRAMS (comma list; '' or off: none). */
export function heavyPrograms(env = process.env) {
  const v = env.STUDIO_HEAVY_PROGRAMS === undefined ? 'Unity.exe,Unity' : String(env.STUDIO_HEAVY_PROGRAMS);
  return off(v) ? [] : v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * Heavy programs (heavyPrograms: a Unity editor) running outside every live machine:heavy holder's tree, and not
 * this process or one it runs under: [{ pid, cmd, start }]. Only the topmost of a program's own processes counts
 * (Unity's asset-import workers are Unity.exe children of the editor). Never throws: [] when processes can't be
 * listed. Injectable: procs (a listProcesses array) or listProcs.
 */
export function implicitHolders(root, { env = process.env, procs = null, listProcs = listProcesses, self = process.pid } = {}) {
  const names = heavyPrograms(env);
  if (!names.length) return [];
  let list;
  try { list = (procs || listProcs()).filter((p) => p && Number.isInteger(Number(p.pid))); } catch { return []; }
  const isHeavy = (p) => Boolean(p && !p.zombie && names.includes(String(p.cmd || '').toLowerCase()));
  if (!list.some(isHeavy)) return [];
  const byPid = new Map(list.map((p) => [Number(p.pid), p]));
  const covered = new Set();
  for (const h of heavyHolders(root, { env })) { try { for (const m of holderTree(h, list, { self: -1 }).members) covered.add(m); } catch {} }
  for (let p = self, k = 0; p && k < 64; k += 1) { covered.add(p); const rec = byPid.get(p); if (!rec || Number(rec.ppid) === p) break; p = Number(rec.ppid); }
  return list.filter((p) => isHeavy(p) && !covered.has(Number(p.pid)) && !(isHeavy(byPid.get(Number(p.ppid))))).map((p) => ({ pid: Number(p.pid), cmd: p.cmd, start: p.start || null }));
}
export const describeImplicit = (p) => `${p.cmd} (pid ${p.pid}${p.start ? `, for ${span(Date.now() - Number(p.start))}` : ''})`;

/**
 * How busy every core is: two os.cpus() samples `ms` apart (sync), 0..1, or null when they can't be read. Used where
 * there is no load average (Windows). Injectable: cpus (os.cpus), wait(ms).
 */
export function cpuBusy({ ms = 500, cpus = os.cpus, wait = sleep } = {}) {
  const sum = (list) => (list || []).reduce((a, c) => {
    const t = c?.times || {};
    const busy = Number(t.user || 0) + Number(t.nice || 0) + Number(t.sys || 0) + Number(t.irq || 0);
    a.idle += Number(t.idle || 0);
    a.total += busy + Number(t.idle || 0);
    return a;
  }, { idle: 0, total: 0 });
  try {
    const a = sum(cpus());
    wait(ms);
    const b = sum(cpus());
    const total = b.total - a.total;
    if (!(total > 0)) return null;
    return Math.min(1, Math.max(0, 1 - (b.idle - a.idle) / total));
  } catch { return null; }
}

/**
 * The CPU's busy fraction when it stands in for the load average: STUDIO_TEST_CPU_BUSY (or opts.cpuBusy, a number
 * or a function) when given; else, only where there is no load average (Windows, or all zeros) and no
 * STUDIO_TEST_LOADAVG, the probe (STUDIO_CPU_PROBE=off: none). { busy, load }: load is the 1-min load to use instead.
 */
function cpuOrLoad({ env, loadavg, cpuBusy: given, platform, cpus }) {
  const testBusy = given !== undefined && given !== null ? given : env.STUDIO_TEST_CPU_BUSY !== undefined && env.STUDIO_TEST_CPU_BUSY !== '' ? Number(env.STUDIO_TEST_CPU_BUSY) : null;
  const load = loadavg ?? (env.STUDIO_TEST_LOADAVG !== undefined && env.STUDIO_TEST_LOADAVG !== '' ? Number(env.STUDIO_TEST_LOADAVG) : null);
  if (testBusy !== null) {
    const b = Number(typeof testBusy === 'function' ? testBusy() : testBusy);
    return { busy: Number.isFinite(b) ? b : null, load: null };
  }
  if (load !== null) return { busy: null, load };
  const la = os.loadavg();
  if (platform !== 'win32' && la.some((x) => x > 0)) return { busy: null, load: la[0] };
  return { busy: off(env.STUDIO_CPU_PROBE) ? null : cpuBusy(cpus ? { cpus } : {}), load: null };
}

/**
 * 2.59.0 (#2): how loaded the machine is, as a factor for a gate's timeout: 1 + 1 per other live machine:heavy holder
 * (not the one this process runs inside) + 0.5 per other running gate check + the 1-minute load above 1.5 per core.
 * 2.60.1 (B-17): + 1 per heavy program outside the lock (implicitHolders: a Unity editor), and where there is no
 * load average (Windows: os.loadavg is all zeros) the CPU's busy fraction over STUDIO_CPU_BUSY_THRESHOLD (0.6) adds
 * 0.5 at the threshold up to 2 at 100% busy, as the load term does. Capped at STUDIO_GAME_GATE_TIMEOUT_MAX_FACTOR
 * (3), never below 1. { factor, why }. Injectable: loadavg, cpus (core count), cpuBusy, cpuSample (os.cpus for the
 * probe), platform, procs, listProcs.
 */
export function loadFactor(root, { env = process.env, loadavg = null, cpus = null, cpuBusy: busyGiven = null, cpuSample = null, platform = process.platform, procs = null, listProcs = undefined } = {}) {
  const dir = heavyDir(root);
  const parent = heldByParent(dir, env);
  const heavy = heavyHolders(root, { env }).filter((h) => h.pid !== process.pid && !(parent && h.pid === parent.pid));
  const slots = otherGateSlots(root, env);
  const implicit = implicitHolders(root, { env, procs, ...(listProcs ? { listProcs } : {}) });
  const { busy, load } = cpuOrLoad({ env, loadavg, cpuBusy: busyGiven, platform, cpus: cpuSample });
  const cores = cpus ?? Math.max(1, (os.availableParallelism ? os.availableParallelism() : os.cpus().length) || 1);
  const why = [];
  let f = 1;
  if (heavy.length) { f += heavy.length; why.push(`${heavy.length} other heavy job${heavy.length === 1 ? '' : 's'} running: ${heavy.map(describeHolder).join('; ')}`); }
  if (implicit.length) { f += implicit.length; why.push(`${implicit.map(describeImplicit).join('; ')} running outside the machine:heavy lock`); }
  if (slots.length) { f += 0.5 * slots.length; why.push(`${slots.length} other game check${slots.length === 1 ? '' : 's'} running (${slots.map((s) => s.label).join(', ')})`); }
  const per = Number.isFinite(load) ? load / cores : 0;
  if (per > 1.5) { f += Math.min(2, per - 1); why.push(`load ${load.toFixed(1)} on ${cores} core${cores === 1 ? '' : 's'}`); }
  const thr = Math.min(0.99, Math.max(0.05, num(env.STUDIO_CPU_BUSY_THRESHOLD, 0.6)));
  if (Number.isFinite(busy) && busy > thr) { f += Math.min(2, 0.5 + (1.5 * (busy - thr)) / (1 - thr)); why.push(`CPU ${Math.round(busy * 100)}% busy (over ${Math.round(thr * 100)}%, STUDIO_CPU_BUSY_THRESHOLD; no load average here)`); }
  const cap = maxFactor(env);
  return { factor: Math.round(Math.min(cap, Math.max(1, f)) * 10) / 10, why: why.join('; ') };
}
const maxFactor = (env) => Math.max(1, num(env.STUDIO_GAME_GATE_TIMEOUT_MAX_FACTOR, 3));

// ---- 2.60.1 (B-17): the last quiet run of each game check ----

const timesFile = (root) => path.join(root, '.studio', 'gates', 'game-gate-times.json');
/** The last passing run of `label` at load factor 1: { ms, at } or null. */
export function lastQuietTime(root, label) {
  const r = readJson(timesFile(root))?.[label];
  return r && Number(r.ms) > 0 ? { ms: Number(r.ms), at: r.at || null } : null;
}
/** Record a passing run of `label` at load factor 1 (the caller decides that). Never throws. */
export function recordGateTime(root, label, ms) {
  if (!label || !(Number(ms) > 0)) return false;
  const f = timesFile(root);
  try {
    const cur = readJson(f) || {};
    cur[label] = { ms: Math.round(Number(ms)), at: new Date().toISOString() };
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cur, null, 2));
    fs.renameSync(tmp, f);
    return true;
  } catch { return false; }
}

/**
 * A timeout scaled for load: { ms, base, factor, why, floor }. Never shorter than the configured base;
 * STUDIO_GAME_GATE_TIMEOUT_SCALE=off keeps the base. 2.60.1 (B-17): with a `label`, never shorter than
 * STUDIO_GAME_GATE_TIMEOUT_FLOOR (1.5; 0 or off: none) times that check's last quiet run (lastQuietTime), capped at
 * the same STUDIO_GAME_GATE_TIMEOUT_MAX_FACTOR times the base as the load factor. floor: { lastMs, mult, capped,
 * why } when it raised the timeout, else null.
 */
export function scaledTimeout(base, root, { env = process.env, label = null, ...rest } = {}) {
  if (off(env.STUDIO_GAME_GATE_TIMEOUT_SCALE)) return { ms: base, base, factor: 1, why: '', floor: null };
  const { factor, why } = loadFactor(root, { env, ...rest });
  let ms = Math.max(base, Math.round(base * factor));
  let floor = null;
  const fv = env.STUDIO_GAME_GATE_TIMEOUT_FLOOR;
  const mult = off(fv) ? 0 : num(fv, 1.5);
  const last = label && mult > 0 ? lastQuietTime(root, label) : null;
  if (last) {
    const want = Math.round(last.ms * mult);
    const cap = Math.round(base * maxFactor(env));
    const got = Math.min(want, cap);
    if (got > ms) {
      ms = got;
      floor = { lastMs: last.ms, mult, capped: want > cap, why: `at least ${mult} x its last quiet run of ${Math.round(last.ms / 1000)} s (STUDIO_GAME_GATE_TIMEOUT_FLOOR)${want > cap ? `, capped at ${maxFactor(env)} x the base (STUDIO_GAME_GATE_TIMEOUT_MAX_FACTOR): the check's quiet time is near its base, raise STUDIO_GAME_GATE_TIMEOUT_MS` : ''}` };
    }
  }
  return { ms, base, factor, why, floor };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const root = await heavyRoot();
  const opt = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
  if (argv[0] === 'run') {
    const sep = argv.indexOf('--');
    const label = opt('--label') || 'heavy command';
    const cmd = sep >= 0 ? argv.slice(sep + 1) : [];
    if (!cmd.length) { console.error('Usage: node harness/heavy.mjs run --label <what> -- <command> [args]'); process.exit(2); }
    let lk;
    const t0Run = Date.now();
    try {
      lk = acquireHeavy(root, label, { log: (m) => console.error(m) });
    } catch (err) {
      if (err.code !== 'HEAVY_BUSY') throw err;
      console.error(err.message);
      process.exit(3);
    }
    // One command line, run by the shell as written (no glob of ours; quoting is the caller's). 2.60.0 (#5): in a
    // process group of its own on POSIX (recorded in the holder's tree), so `stop` and a later take find what it
    // started even after this process is killed; on Windows taskkill /T from this process covers it.
    const posix = process.platform !== 'win32';
    const child = spawn(cmd.join(' '), { cwd: process.cwd(), shell: true, stdio: 'inherit', windowsHide: true, detached: posix });
    // On Windows the shell itself is recorded: it dies with this process (Node's job object), its children don't.
    if (!posix && child.pid) lk.update((cur) => ({ ...cur, tree: { ...(cur.tree || {}), children: { ...(cur.tree?.children || {}), [child.pid]: spawnedIdentity(child.pid, 'cmd') } } }));
    if (posix && child.pid) lk.update((cur) => ({ ...cur, tree: { ...(cur.tree || {}), groups: [...new Set([...(cur.tree?.groups || []), child.pid])], groupIds: { ...(cur.tree?.groupIds || {}), [child.pid]: spawnedIdentity(child.pid, 'sh') }, kill: 'the process groups' } }));
    const fwd = (sig) => () => { try { if (posix) process.kill(-child.pid, sig); else child.kill(sig); } catch {} };
    for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, fwd(s));
    const code = await new Promise((resolve) => {
      child.on('error', (e) => { console.error(`[heavy] could not run ${label}: ${e.message}`); resolve(1); });
      child.on('exit', (c, sig) => resolve(c ?? (sig ? 128 + (os.constants.signals[sig] || 1) : 1)));
    });
    lk.release();
    // 2.65.0: the uniform job.done (harness/jobs.mjs) for a heavy run.
    try { (await import('./jobs.mjs')).jobDone({ kind: 'heavy', id: label, code, ms: Date.now() - t0Run, extra: { command: cmd.join(' ').slice(0, 200) } }); } catch {}
    process.exit(code);
  }
  if (argv[0] === 'stop') {
    const res = stopHeavy(root, { label: opt('--label'), all: argv.includes('--all'), by: opt('--by') || '' });
    for (const l of res.lines) (res.ok ? console.log : console.error)(l);
    process.exit(res.code);
  } else {
    const holders = heavyHolders(root);
    // 2.60.0 (#5): a gone holder whose tree still runs (only then are the processes listed).
    const left = [];
    for (const r of heavyRecords(root).filter((x) => !x.live && holderGone(x))) {
      try { const t = holderTree(r, listProcesses()); if (t.members.length) left.push({ ...r, orphans: t.members }); } catch {}
    }
    for (const r of left) console.error(`[heavy] ${describeHolder(r)} is gone but ${r.orphans.length} process(es) of its tree still run (pids ${r.orphans.join(', ')}): the next heavy take stops them, or node harness/heavy.mjs stop --all --by <name>`);
    // 2.60.1 (B-35): a Unity editor (STUDIO_HEAVY_PROGRAMS) running outside the lock is an implicit holder.
    const implicit = implicitHolders(root);
    if (argv.includes('--json')) console.log(JSON.stringify({ slots: heavySlots(), holders, orphaned: left, implicit }));
    else {
      console.log(holders.length ? `machine:heavy (${heavySlots()} slot${heavySlots() === 1 ? '' : 's'}): ${holders.map((h) => `${describeHolder(h)}${h.tree ? `, tree root ${h.tree.root} (killed with ${h.tree.kill})` : ''}`).join('; ')}; node harness/heavy.mjs stop --by <name> stops it` : `machine:heavy is free (${heavySlots()} slot${heavySlots() === 1 ? '' : 's'}, STUDIO_HEAVY_SLOTS)`);
      if (implicit.length) console.log(`implicit holder${implicit.length === 1 ? '' : 's'} (outside the lock): ${implicit.map(describeImplicit).join('; ')}: counted as heavy work when game checks scale their timeouts; heavy jobs still start beside it. Run editor batch work with node harness/heavy.mjs run --label <what> -- <command> so it takes the lock`);
    }
  }
}
