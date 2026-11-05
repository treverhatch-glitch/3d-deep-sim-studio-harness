/**
 * harness/gate-reaper.mjs — 2.78.1: end gate runs nobody waits for any more.
 *
 * A `run-gates.mjs --only protected` ran 13 h on the crew's main checkout with no live parent: whoever started it (a
 * task done, a train, a verify's shell) was gone, and nothing ever ended it. The supervisor's pass now asks this
 * module (at most every STUDIO_ORPHAN_GATE_SCAN_MIN, default 10, minutes): every node process running
 * scripts/run-gates.mjs whose parent is gone and that has run longer than STUDIO_ORPHAN_GATE_MIN (default 60) minutes is
 * ended with its whole tree (harness/heavy.mjs killHolderTree: taskkill /T on Windows, the process group and children
 * on POSIX), and a gate.orphan_ended event says which, how old, and its command line. STUDIO_ORPHAN_GATE_MIN=0/off:
 * never.
 *
 * "Parent gone" (harness/proc-identity.mjs listProcesses, one OS query; Windows keeps the dead parent's pid):
 *   - no process has the parent's pid, or the process that has it started after this one (Windows reuses pids);
 *   - POSIX: the parent is pid 1 or an init/systemd reaper the orphan was re-parented to;
 *   - the same, one level up, through the shells and npm wrappers that started it (cmd.exe, sh, npm: a shell waiting for
 *     its gate run stays alive after its own parent is gone);
 *   - `npm run verify`'s host (run-gates.mjs --verify-stage host <status file>) is started parentless on purpose (so a
 *     killed shell doesn't stop the verify): it counts as having a live parent while its verify record still names it
 *     (hostPid) as running, no longer than STUDIO_VERIFY_MAX_MIN (360), as `npm run verify -- --wait` judges it. Its
 *     gates (run-gates.mjs --no-detach) have it as their parent. The short-lived hop (--verify-stage hop) is never ended.
 * Never this process or its ancestors. Returns { scanned, ended: [{ pid, ageMin, args, why }], skipped, why }.
 */
import fs from 'node:fs';
import path from 'node:path';
import { listProcesses, processArgs } from './proc-identity.mjs';

const num = (v, d) => (v !== undefined && v !== null && String(v).trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const off = (v) => /^(off|false|no)$/i.test(String(v ?? '').trim());
/** STUDIO_ORPHAN_GATE_MIN: minutes a parentless gate run may run before it is ended (default 60; 0/off: never). */
export function orphanGateMin(env = process.env) {
  if (off(env.STUDIO_ORPHAN_GATE_MIN)) return 0;
  const n = num(env.STUDIO_ORPHAN_GATE_MIN, 60);
  return n > 0 ? n : 0;
}
const scanMs = (env) => Math.max(0, num(env.STUDIO_ORPHAN_GATE_SCAN_MIN, 10)) * 60000;
const RUN_GATES = /(^|[\s"'\\/])run-gates\.mjs(?=$|[\s"'])/;
const REAPERS = /^(init|systemd|launchd|tini|dumb-init|s6-svscan|runit)$/i;
const WRAPPERS = /^(cmd|sh|bash|dash|zsh|ash|pwsh|powershell|npm|npx|conhost)(\.exe|\.cmd)?$/i;
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/** The verify host's record still runs it: { live, why }. */
function hostRecordLive(args, pid, { env, now }) {
  const m = String(args).match(/--verify-stage\s+host\s+("([^"]+)"|(\S+))/);
  const file = m ? (m[2] || m[3]) : '';
  const st = file ? readJson(file) : null;
  if (!st) return { live: false, why: 'its verify record is gone' };
  if (Number(st.hostPid) !== Number(pid)) return { live: false, why: 'its verify record names another run' };
  if (st.state === 'done') return { live: false, why: 'its verify record says done' };
  const age = now - Date.parse(st.startedAt || 0);
  const maxMs = num(env.STUDIO_VERIFY_MAX_MIN, 360) * 60000;
  if (!(age < maxMs)) return { live: false, why: `its verify record is older than STUDIO_VERIFY_MAX_MIN (${Math.round(maxMs / 60000)} min)` };
  return { live: true, why: '' };
}

/**
 * The gate runs whose parent is gone and that are older than the limit: [{ pid, ageMin, args, why }]. Pure but for the
 * verify records it reads; procs: listProcesses() rows (args optional: processArgs fills them).
 */
export function orphanGateRuns({ procs, args = {}, now = Date.now(), env = process.env, self = process.pid, platform = process.platform } = {}) {
  const limitMin = orphanGateMin(env);
  if (!limitMin) return [];
  const byPid = new Map((procs || []).map((p) => [Number(p.pid), p]));
  // Never this process or one of its ancestors.
  const mine = new Set();
  for (let p = Number(self), i = 0; p && byPid.has(p) && i < 64; p = Number(byPid.get(p).ppid), i += 1) mine.add(p);
  const found = [];
  for (const p of procs || []) {
    const pid = Number(p.pid);
    const a = String(args[pid] ?? p.args ?? '');
    if (mine.has(pid) || p.zombie || !RUN_GATES.test(a) || /--verify-stage\s+hop\b/.test(a)) continue;
    const start = Number(p.start) || 0;
    const ageMin = start ? (now - start) / 60000 : 0;
    if (!start || ageMin < limitMin) continue;
    let gone = '';
    if (/--verify-stage\s+host\b/.test(a)) {
      const h = hostRecordLive(a, pid, { env, now });
      if (h.live) continue;
      gone = `npm run verify's host, and ${h.why}`;
    } else {
      // Up through the shells and npm wrappers that started it (cmd.exe waits for its child even when its own parent
      // is gone): the first other ancestor is the parent that counts.
      let cur = p;
      for (let i = 0; i < 16 && !gone; i += 1) {
        const ppid = Number(cur.ppid);
        const parent = byPid.get(ppid);
        const via = cur === p ? 'its parent' : `its ${cur.cmd || 'shell'}'s parent`;
        const curStart = Number(cur.start) || start;
        if (!parent || parent.zombie) gone = `${via} (pid ${ppid}) is gone`;
        else if (Number(parent.start) && Number(parent.start) > curStart + 2000) gone = `${via}'s pid ${ppid} now belongs to a newer process`;
        else if (platform !== 'win32' && (ppid <= 1 || REAPERS.test(String(parent.cmd || '')))) gone = `${cur === p ? 'it' : `its ${cur.cmd || 'shell'}`} was re-parented to ${parent.cmd || `pid ${ppid}`} (its own parent is gone)`;
        else if (WRAPPERS.test(String(parent.cmd || '')) && !mine.has(ppid)) cur = parent;
        else break;
      }
    }
    if (gone) found.push({ pid, ageMin: Math.round(ageMin), args: a.slice(0, 300), why: gone, start, ...(p.proc ? { proc: p.proc } : {}) });
  }
  return found;
}

let lastScan = 0;
/**
 * The supervisor's step: find and end the orphaned gate runs. deps: { listProcs, argsOf, kill(rec) -> { survivors },
 * emit } (tests). Throttled to STUDIO_ORPHAN_GATE_SCAN_MIN unless `force`. Never throws.
 */
export async function reapOrphanGates({ env = process.env, now = Date.now(), force = false, deps = {}, log = () => {} } = {}) {
  try {
    if (!orphanGateMin(env)) return { scanned: 0, ended: [], skipped: true, why: 'STUDIO_ORPHAN_GATE_MIN=off' };
    if (!force && now - lastScan < scanMs(env)) return { scanned: 0, ended: [], skipped: true, why: 'scanned recently' };
    lastScan = now;
    const procs = (deps.listProcs || listProcesses)();
    const nodes = procs.filter((p) => /^node(\.exe)?$/i.test(String(p.cmd || '')) || typeof p.args === 'string');
    const args = (deps.argsOf || ((pids) => processArgs(pids, { procs: procs.some((p) => typeof p.args === 'string') ? procs : null })))(nodes.map((p) => p.pid));
    const runs = orphanGateRuns({ procs, args, now, env });
    const ended = [];
    let kill = deps.kill;
    if (!kill) { const h = await import('./heavy.mjs'); kill = (rec) => h.killHolderTree({ pid: rec.pid, identity: { start: rec.start, ...(rec.proc ? { proc: rec.proc } : {}) } }); }
    let emit = deps.emit;
    if (!emit) emit = (await import('./event.mjs')).emitEvent;
    for (const r of runs) {
      let k = null;
      try { k = kill(r); } catch (e) { k = { error: e.message }; }
      const left = k?.survivors?.length || 0;
      const msg = `Ended an orphaned gate run (pid ${r.pid}, ${r.ageMin} min old, past STUDIO_ORPHAN_GATE_MIN=${orphanGateMin(env)}): ${r.why}. ${path.basename(r.args.split(/\s+/)[1] || 'run-gates.mjs')} ${r.args.split(/\s+/).slice(2).join(' ').slice(0, 160)}${left ? ` (${left} process(es) of its tree still run)` : ''}${k?.error ? ` (could not end it: ${k.error})` : ''}`;
      log(`[gate-reaper] ${msg}`);
      try { emit({ type: 'gate.orphan_ended', agent: 'supervisor', to: 'producer', status: 'warn', msg: msg.slice(0, 600), meta: { pid: r.pid, ageMin: r.ageMin, why: r.why, args: r.args, survivors: k?.survivors || [], error: k?.error || null } }); } catch {}
      ended.push({ ...r, survivors: k?.survivors || [] });
    }
    return { scanned: procs.length, ended, skipped: false, why: '' };
  } catch (e) { return { scanned: 0, ended: [], skipped: true, why: `error: ${e.message}` }; }
}
