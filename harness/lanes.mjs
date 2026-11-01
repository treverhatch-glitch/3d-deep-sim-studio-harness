#!/usr/bin/env node
/**
 * harness/lanes.mjs — 2.65.0: the conductor's lane table, and refreshing a lane with main as one mechanical job.
 *
 * The crew's orchestrator (an agent outside the harness) rebuilt the state of every lane by hand eight times in one day
 * and ran about fifteen sub-agents doing the same "merge main, re-stamp, run the lane's tests" recipe. Both are code now.
 *
 *   npm run lanes [-- --json] [--no-stamps]
 *       One row per lane copy (.lanes/<agent>) and per lane branch with unlanded work (.studio/lane-branches.json, the
 *       train queue): task, agent, branch, ahead/behind main, hook stamps (harness/hook-stamp.mjs on the lane's own
 *       commits, within STUDIO_LANES_STAMP_MS, 4000 ms in all; past that "not checked"), whether main changed
 *       harness/ or scripts/ since the lane branched, queued for the train (with its tier when the train recorded one),
 *       held (npm run task -- hold) or held for the owner (tier C), the last targeted-test or verify result recorded for
 *       the lane (a refresh, task done's game checks, the lane's own full verify), its declared Pin-Moves, predicted
 *       conflicts (git merge-tree with main, and pairwise among queued lanes that touch the same files; git older than
 *       2.38: the hotspots overlap, with a note), and its age. Read-only: nothing is written, nothing is merged.
 *       2.65.3: a running merge train's current step and ETA (harness/train-status.mjs), with a note on STUDIO_TRAIN_MAX
 *       when it has more than 6 lanes.
 *
 *   npm run lanes -- refresh <task|agent|branch|--all> --by <name> [--busy-ok] [--no-tests] [--json]
 *       Per lane, in its own copy: refuses when its session is running (a launched session alive, a process working in
 *       the copy, a claim renewed in the last STUDIO_LANE_LIVE_MIN minutes) unless --busy-ok, with uncommitted work, or
 *       mid-merge/rebase; re-stamps through the real hooks first if a commit's stamp no longer matches
 *       (hook-stamp.mjs restamp, judged from the same base as the hooks gate: the main checkout's local branch); merges
 *       main into it (git merge, never a rebase: the lane's commits and their stamps stay as they are; the merge commit
 *       is stamped by the commit-msg hook); and runs the lane's targeted tests (harness/game-gates.mjs on the lane's own
 *       files with related tests only, STUDIO_GATE_RELATED=on, as task done scopes them). A textual conflict stops it:
 *       `git merge --abort`, the files are listed, nothing is resolved. Goldens and pins change only as the merge brings
 *       them from main (goldens unchanged from main need no Golden-Reason since 2.60.1). Events: lanes.refresh.ok,
 *       lanes.refresh.conflict, lanes.refresh.red, lanes.refresh.refused; the result is kept in
 *       .studio/lanes/refresh.json for the table.
 *       Who: a person, a Producer or Director session, or an agent outside the harness (harness/permission.mjs); a
 *       worker never. --busy-ok is theirs too.
 *
 * Exit: 0 all fine; 1 a conflict or red; 2 refused or bad usage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { emitEvent, readRecentEvents, STUDIO_STATE_DIR } from './event.mjs';
import { mainRoot, mainBranch, laneCopies, laneLive, unmerged, LANES_DIR } from './worktree.mjs';
import { readQueue, heldNow, pinMoves, trainManifest } from './train.mjs';
import { readTrainStatus, trainStatusLine, capNote } from './train-status.mjs';
import { mergeTreeSupport, mergeTree, placesFor } from './merge-tree.mjs';
import { readPass } from './merge-lane.mjs';
import { readHolds } from './task-hold.mjs';
import { listLocks } from './lock.mjs';
import { recordAlive } from './proc-identity.mjs';
import { DECIDER_ROLES, WORKER_NAME } from './permission.mjs';

const isSha = (s) => /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(String(s || ''));
const cleanEnv = (extra = {}) => { const e = { ...process.env, ...extra }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|PREFIX|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/.test(k)) delete e[k]; return e; };
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanEnv(), maxBuffer: 64 * 1024 * 1024, windowsHide: true });
const out = (r) => (r.status === 0 ? String(r.stdout || '').trim() : '');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const TASK_ID = /^[A-Z]+-\d+$/;

export const REFRESH_FILE = (root = mainRoot()) => path.join(root, '.studio', 'lanes', 'refresh.json');
export const readRefreshes = (root = mainRoot()) => readJson(REFRESH_FILE(root), {});
function recordRefresh(root, key, rec) {
  const f = REFRESH_FILE(root);
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const all = readJson(f, {});
    all[key] = rec;
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`);
    fs.renameSync(tmp, f);
  } catch {}
}

/** Does this git have `git merge-tree --write-tree` (2.38)? (harness/merge-tree.mjs, shared with the queue's prediction) */
export function mergeTreeSupported() {
  return mergeTreeSupport(mainRoot()).ok;
}
/**
 * Files two commits would conflict in (merge-tree touches no index and no files): [] when they merge clean, null when
 * git couldn't tell. 2.65.1: harness/merge-tree.mjs's call; files listed in unionFiles don't count (the train merges
 * them with git's union driver), as at queue time.
 */
export function conflictFiles(root, a, b, { unionFiles = [] } = {}) {
  const m = mergeTree(root, a, b, { unionFiles });
  return m.error ? null : m.files;
}

/** A launched session for this agent that is running (its record says so and its process is alive). */
export function sessionRunning(root, agent) {
  if (!agent) return null;
  const s = readJson(path.join(root, '.studio', 'agents', `${agent}.json`), null);
  if (!s || s.status !== 'running') return null;
  let alive = false;
  try { alive = recordAlive(s); } catch {}
  return alive ? { agent, task: s.task || null, role: s.role || null, since: s.startedAt || null } : null;
}

const ageText = (ms) => (!Number.isFinite(ms) || ms < 0 ? '?' : ms < 3600000 ? `${Math.max(1, Math.round(ms / 60000))}m` : ms < 48 * 3600000 ? `${Math.round(ms / 3600000)}h` : `${Math.round(ms / 86400000)}d`);

/**
 * The lanes: lane copies, lane branches with unlanded work, queued lanes. [{ task, agent, branch, dir, head, queued }].
 * One per branch; a queued lane without a branch name is keyed by its head.
 */
export function collectLanes(root = mainRoot()) {
  const byKey = new Map();
  const queue = readQueue(root);
  const branchOf = readJson(path.join(root, '.studio', 'lane-branches.json'), {});
  const taskOfBranch = new Map(Object.entries(branchOf).filter(([k, v]) => TASK_ID.test(k) && typeof v === 'string').map(([k, v]) => [v, k]));
  let taskOfAgent = new Map();
  try { taskOfAgent = new Map(listLocks().filter((l) => /^task:/.test(l.key)).map((l) => [l.owner, l.key.slice(5)])); } catch {}
  let copies = [];
  try { copies = laneCopies(root); } catch {}
  for (const c of copies) {
    const s = readJson(path.join(root, '.studio', 'agents', `${c.agent}.json`), null);
    byKey.set(c.branch || `copy:${c.agent}`, { task: taskOfBranch.get(c.branch) || taskOfAgent.get(c.agent) || (s?.task && TASK_ID.test(s.task) ? s.task : null), agent: c.agent, branch: c.branch, dir: c.dir, dirty: c.dirty, copy: true });
  }
  for (const [task, branch] of Object.entries(branchOf)) {
    if (!TASK_ID.test(task) || typeof branch !== 'string' || byKey.has(branch)) continue;
    if (!isSha(out(git(root, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)))) continue;
    if (unmerged(branch, root) > 0) byKey.set(branch, { task, agent: null, branch, dir: null, dirty: false, copy: false });
  }
  for (const e of queue) {
    if (!e?.task) continue;
    const key = e.branch && byKey.has(e.branch) ? e.branch : [...byKey.entries()].find(([, l]) => l.task === e.task)?.[0] || e.branch || e.head;
    const had = byKey.get(key) || { task: e.task, agent: e.agent || null, branch: e.branch || null, dir: e.dir && fs.existsSync(e.dir) ? e.dir : null, dirty: false, copy: false };
    byKey.set(key, { ...had, task: had.task || e.task, agent: had.agent || e.agent || null, queued: e });
  }
  return [...byKey.values()];
}

/** The last targeted-test or verify result recorded for this lane, newest first: { what, ok, at, head, current }. */
export function lastResult(root, lane, head) {
  const found = [];
  const ref = lane.task ? readRefreshes(root)[lane.task] : null;
  if (ref?.tests) found.push({ what: 'refresh tests', ok: ref.tests.ok, at: ref.at, head: ref.head });
  const pass = lane.task ? readPass(root, lane.task) : null;
  if (pass) found.push({ what: 'task done game checks', ok: true, at: pass.at, head: pass.head });
  if (lane.agent && /^[\w.-]+$/.test(lane.agent)) {
    const v = readJson(path.join(root, '.studio', 'gates', `${lane.agent}-full.json`), null);
    if (v?.at) found.push({ what: 'full verify', ok: Array.isArray(v.rows) && v.rows.length > 0 && v.rows.every((r) => r.ok || r.required === false), at: v.at, head: v.head || null });
  }
  found.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  const best = found[0];
  return best ? { ...best, current: Boolean(head && best.head === head) } : null;
}

/** The tier the train recorded for this task (held entry, else its last task.train.tier event), or null. */
function recordedTier(entry, task, events) {
  if (entry?.held?.tier) return entry.held.tier;
  if (entry?.tier) return entry.tier;
  const e = events.filter((x) => x.type === 'task.train.tier' && x.task === task).pop();
  return e?.meta?.tier || null;
}

/**
 * The lane table. Options: stamps (check hook stamps, within budgetMs in all), conflicts (merge-tree predictions).
 * Returns { main, tip, lanes: [...], notes: [] }.
 */
export async function laneTable(root = mainRoot(), { stamps = true, conflicts = true, budgetMs = Number(process.env.STUDIO_LANES_STAMP_MS) >= 0 && String(process.env.STUDIO_LANES_STAMP_MS || '').trim() !== '' ? Number(process.env.STUDIO_LANES_STAMP_MS) : 4000, now = Date.now() } = {}) {
  const main = mainBranch(root);
  const tip = out(git(root, 'rev-parse', `refs/heads/${main}`));
  const notes = [];
  const holds = readHolds();
  let events = [];
  try { events = readRecentEvents(5000); } catch {}
  const lanes = [];
  for (const l of collectLanes(root)) {
    const head = out(git(root, 'rev-parse', '--verify', '--quiet', l.branch ? `refs/heads/${l.branch}^{commit}` : `${l.queued?.head}^{commit}`)) || (l.dir ? out(git(l.dir, 'rev-parse', 'HEAD')) : '') || l.queued?.head || '';
    const row = { task: l.task || null, agent: l.agent || null, branch: l.branch || null, dir: l.dir ? path.relative(root, l.dir).split(path.sep).join('/') : null, head: head || null, copy: l.copy, dirty: Boolean(l.dirty) };
    if (!isSha(head) || !isSha(tip)) { row.error = 'its head is not a commit here'; lanes.push(row); continue; }
    const times = out(git(root, 'log', '--format=%ct', `${tip}..${head}`)).split('\n').filter(Boolean).map(Number);
    row.ahead = times.length;
    row.behind = Number(out(git(root, 'rev-list', '--count', `${head}..${tip}`))) || 0;
    const mb = out(git(root, 'merge-base', tip, head));
    row.base = mb || null;
    const first = times.length ? Math.min(...times) * 1000 : NaN;
    const qAt = Date.parse(l.queued?.at || '');
    row.ageMs = Number.isFinite(first) ? now - first : Number.isFinite(qAt) ? now - qAt : null;
    // Main changed the harness the lane runs (its own harness/ and scripts/) since the lane branched.
    const drift = mb ? out(git(root, 'diff', '--name-only', '--no-renames', mb, tip, '--', 'harness', 'scripts')).split('\n').filter(Boolean) : [];
    row.harness = mb ? (drift.length ? { current: false, files: drift.length, sample: drift.slice(0, 3) } : { current: true }) : null;
    row.files = mb ? out(git(root, 'diff', '--name-only', '--no-renames', mb, head)).split('\n').filter(Boolean) : [];
    row.pinMoves = mb ? pinMoves(root, mb, head) : [];
    const q = l.queued;
    row.queued = q ? { at: q.at || null, tier: recordedTier(q, row.task, events), held: heldNow(q) ? { tier: q.held.tier, why: q.held.why } : null, stale: q.head !== head } : null;
    const h = row.task ? holds[row.task]?.held : null;
    row.hold = h ? { by: h.by || null, why: h.why || '', at: h.at || null } : null;
    row.last = lastResult(root, l, head);
    row.session = sessionRunning(root, l.agent);
    lanes.push(row);
  }
  // Hook stamps: hook-stamp.mjs's own check on each lane's own commits (main's tip..the lane), within one time budget.
  if (stamps) {
    let check = null;
    try { ({ checkHookStamps: check } = await import('./hook-stamp.mjs')); } catch (e) { notes.push(`hook stamps not checked: ${e.message}`); }
    const t0 = Date.now();
    let skipped = 0;
    for (const r of lanes) {
      if (!check || !r.ahead) { if (r.ahead === 0) r.stamps = { ok: true, open: 0, why: 'no commits of its own' }; continue; }
      if (Date.now() - t0 > budgetMs) { r.stamps = { skipped: true }; skipped += 1; continue; }
      try {
        const c = await check({ env: { ...process.env, STUDIO_HARNESS_REF_TIMEOUT_MS: process.env.STUDIO_HARNESS_REF_TIMEOUT_MS || '3000' }, range: { base: tip, head: r.head } });
        r.stamps = { ok: c.ok, open: (c.open || []).length, enforced: c.enforced !== false, off: Boolean(c.off), first: c.open?.[0] ? `${c.open[0].sha.slice(0, 8)} ${c.open[0].why}`.slice(0, 160) : null };
      } catch (e) { r.stamps = { error: String(e.message || e).slice(0, 160) }; }
    }
    if (skipped) notes.push(`hook stamps: ${skipped} lane(s) not checked within ${budgetMs} ms (STUDIO_LANES_STAMP_MS; npm run hooks -- check in the lane checks one)`);
  }
  // Predicted conflicts: with main (every lane both ahead and behind), and pairwise among queued lanes on shared files.
  if (conflicts && isSha(tip)) {
    const sup = mergeTreeSupport(root);
    if (sup.ok) {
      // 2.65.1: the same call, union-file exemption and file:line places as the queue's prediction (merge-tree.mjs).
      let unionFiles = [];
      try { unionFiles = (await trainManifest(root, tip)).unionFiles || []; } catch {}
      const unionOnly = new Map();
      const judge = (r, a, b) => {
        const m = mergeTree(root, a, b, { unionFiles });
        for (const f of m.union) unionOnly.set(f, [...new Set([...(unionOnly.get(f) || []), r.task || r.branch])]);
        return m.error ? null : m.files.length ? { files: m.files, places: placesFor(root, a, b, m.files) } : null;
      };
      for (const r of lanes) {
        r.conflicts = [];
        if (!r.ahead || !r.behind || !isSha(r.head)) continue;
        const m = mergeTree(root, tip, r.head, { unionFiles });
        for (const f of m.union) unionOnly.set(f, [...new Set([...(unionOnly.get(f) || []), r.task || r.branch])]);
        if (m.error) r.conflicts.push({ with: main, files: [], unknown: true });
        else if (m.files.length) r.conflicts.push({ with: main, files: m.files, places: placesFor(root, tip, r.head, m.files) });
      }
      const queued = lanes.filter((r) => r.queued && r.ahead && isSha(r.head));
      for (let i = 0; i < queued.length; i += 1) {
        for (let j = i + 1; j < queued.length; j += 1) {
          const a = queued[i];
          const b = queued[j];
          const shared = a.files.filter((x) => b.files.includes(x));
          if (!shared.length) continue;
          const c = judge(a, a.head, b.head);
          if (!c) continue;
          a.conflicts.push({ with: b.task || b.branch, ...c });
          b.conflicts.push({ with: a.task || a.branch, ...c });
        }
      }
      for (const [f, who] of unionOnly) notes.push(`${f} conflicts only as a union file (unionFiles) for ${who.join(', ')}: the train merges it with git's union driver, so it is not listed as a conflict`);
    } else {
      notes.push(`${sup.why || 'git has no merge-tree --write-tree (2.38+)'}: conflicts are predicted from overlapping changed lines (harness/hotspots.mjs) instead`);
      try {
        const { overlaps, lanesInFlight } = await import('./hotspots.mjs');
        for (const r of lanes) r.conflicts = [];
        for (const o of overlaps(root, lanesInFlight(root))) {
          for (const r of lanes) {
            const label = r.task ? `${r.task}${r.agent ? ` (${r.agent})` : ''}` : r.agent || r.branch;
            if (!o.lanes.includes(label)) continue;
            r.conflicts.push({ with: o.lanes.filter((x) => x !== label).join(', '), files: [`${o.file}:${o.line}`], overlap: true });
          }
        }
      } catch (e) { notes.push(`overlaps not read: ${e.message}`); }
    }
  }
  for (const r of lanes) delete r.files;
  // 2.65.3 (B-43): the running train's current step and ETA (.studio/train/<id>/status.json), and the lane cap.
  const train = readTrainStatus(root);
  { const cn = train ? capNote(train.lanes) : ''; if (cn) notes.push(cn); }
  return { main, tip, at: new Date(now).toISOString(), lanes, notes, ...(train ? { train } : {}) };
}

// ---- the table, in words ------------------------------------------------------------------------

const stampWord = (s) => (!s ? '-' : s.skipped ? 'not checked' : s.error ? 'error' : s.off ? 'off' : s.open ? `${s.open} bad${s.enforced ? '' : ' (not enforced)'}` : 'ok');
const lastWord = (x) => (!x ? '-' : `${x.ok ? 'green' : 'red'} ${x.what === 'full verify' ? 'verify' : x.what === 'refresh tests' ? 'tests' : 'done-checks'}${x.current ? '' : ' (older head)'}`);
export function tableText(t) {
  const rows = t.lanes.map((r) => [
    r.task || '-',
    r.agent || '-',
    r.branch || (r.head ? r.head.slice(0, 8) : '-'),
    r.error ? '?' : `+${r.ahead}/-${r.behind}`,
    stampWord(r.stamps),
    !r.harness ? '-' : r.harness.current ? 'current' : `stale (${r.harness.files})`,
    r.queued ? `yes${r.queued.tier ? ` ${r.queued.tier}` : ''}${r.queued.held ? ' HELD-owner' : ''}${r.queued.stale ? ' (new commits)' : ''}` : '-',
    r.hold ? `held by ${r.hold.by}` : '-',
    lastWord(r.last),
    r.pinMoves?.length ? r.pinMoves.join(',') : '-',
    !r.conflicts ? '-' : r.conflicts.length ? r.conflicts.map((c) => { const w = c.places?.length ? c.places.map((p) => `${p.file}:${p.line}`) : c.files; return `${c.with}${w.length ? `: ${w.slice(0, 2).join(',')}${w.length > 2 ? ` +${w.length - 2}` : ''}` : ''}`; }).join('; ') : 'none',
    `${r.ageMs === null || r.ageMs === undefined ? '-' : ageText(r.ageMs)}${r.session ? ' RUNNING' : ''}${r.dirty ? ' dirty' : ''}`,
  ]);
  const head = ['TASK', 'AGENT', 'BRANCH', 'AHEAD/BEHIND', 'STAMPS', 'HARNESS', 'QUEUED', 'HOLD', 'LAST TEST', 'PIN-MOVES', 'CONFLICTS', 'AGE'];
  const w = head.map((h, i) => Math.min(48, Math.max(h.length, ...rows.map((r) => String(r[i]).length))));
  const line = (r) => r.map((c, i) => String(c).slice(0, 48).padEnd(w[i])).join('  ').trimEnd();
  const L = [`Lanes against ${t.main} (${String(t.tip).slice(0, 8)}), ${t.lanes.length} lane(s), ${t.at.slice(0, 16).replace('T', ' ')} UTC`];
  if (rows.length) L.push(line(head), ...rows.map(line));
  else L.push('No lane copies, lane branches with unlanded work, or queued lanes.');
  if (t.train) L.push(trainStatusLine(t.train));
  for (const n of t.notes) L.push(`note: ${n}`);
  return L.join('\n');
}

// ---- refresh ------------------------------------------------------------------------------------

/**
 * Why this caller may not refresh lanes, or ''. A person, a Producer or Director session, or an agent outside the
 * harness may (harness/permission.mjs); a launched worker session or a worker's name never.
 */
export function refreshRefusal({ by, env = process.env } = {}) {
  const role = String(env.STUDIO_ROLE || '').trim();
  const owner = String(env.STUDIO_LOCK_OWNER || '').trim();
  if (!String(by || '').trim()) return 'Say who refreshes: --by <name>.';
  if (role && !DECIDER_ROLES.test(role)) return `Refused: a launched ${role} session can't refresh lanes; a Producer or Director session, a person, or an agent outside the harness (a conductor) can.`;
  const worker = [owner, String(by).trim()].find((n) => n && WORKER_NAME.test(n));
  if (worker) return `Refused: ${worker} is a worker agent; lanes are refreshed by a Producer or Director session, a person, or an agent outside the harness (a conductor).`;
  return '';
}

/** Is someone working in this lane copy now? { busy, why }. A copy merely changed recently doesn't count. */
export function laneBusy(root, lane) {
  const s = sessionRunning(root, lane.agent);
  if (s) return { busy: true, why: `${lane.agent}'s session is running${s.task ? ` (${s.task})` : ''}` };
  if (lane.agent && lane.dir) {
    try {
      const l = laneLive(lane.agent, root);
      if (l.live && !/^changed /.test(String(l.why || ''))) return { busy: true, why: l.why };
    } catch {}
  }
  return { busy: false };
}

/** Find a lane by task id, agent name or branch. */
export function findLane(root, key) {
  const k = String(key || '').trim();
  const all = collectLanes(root);
  return all.find((l) => l.task === k) || all.find((l) => l.agent === k) || all.find((l) => l.branch === k) || null;
}

const tailOf = (text, n = 8) => String(text || '').trim().split('\n').slice(-n).join('\n');

/**
 * Refresh one lane: re-stamp if needed, merge main into it, run its targeted tests. Never rebases, never resolves a
 * conflict. Returns { lane, status: ok|conflict|red|refused|skipped, why, files?, merged?, restamped?, tests? }.
 */
export async function refreshLane(root, lane, { by, busyOk = false, tests = true, env = process.env, log = () => {} } = {}) {
  const name = lane?.task || lane?.agent || lane?.branch || '?';
  const t0 = Date.now();
  const main = mainBranch(root);
  const tip = out(git(root, 'rev-parse', `refs/heads/${main}`));
  const ev = (status, why, extra = {}) => {
    try { emitEvent({ type: `lanes.refresh.${status}`, agent: String(by || env.STUDIO_LOCK_OWNER || 'conductor').slice(0, 60), task: lane?.task || null, to: status === 'ok' ? null : 'producer', status: status === 'ok' ? 'ok' : status === 'refused' ? 'warn' : 'blocked', durationMs: Date.now() - t0, msg: `refresh ${name}: ${why}`.slice(0, 600), meta: { lane: lane?.agent || null, branch: lane?.branch || null, by: by || null, ...extra } }); } catch {}
  };
  const done = (status, why, extra = {}) => {
    ev(status, why, extra);
    if (lane?.task && status !== 'refused') recordRefresh(root, lane.task, { at: new Date().toISOString(), by: by || null, status, why: String(why).slice(0, 300), head: extra.head || null, tip, ...(extra.tests ? { tests: extra.tests } : {}) });
    return { lane: name, status, why, ...extra };
  };
  const refuse = (why) => { ev('refused', why); return { lane: name, status: 'refused', why }; };
  const who = refreshRefusal({ by, env });
  if (who) return refuse(who);
  if (!lane) return refuse('no such lane (npm run lanes lists them)');
  if (!lane.dir || !fs.existsSync(lane.dir)) return refuse(`it has no lane copy to merge in (${lane.branch || 'no branch'}); the next agent on ${lane.task || 'the task'} gets main when its copy is made`);
  if (!isSha(tip)) return refuse(`${main} has no commit`);
  const busy = laneBusy(root, lane);
  if (busy.busy && !busyOk) return refuse(`someone is working in it (${busy.why}); --busy-ok merges anyway (a Producer or Director session, a person, or an agent outside the harness)`);
  const gd = out(git(lane.dir, 'rev-parse', '--absolute-git-dir'));
  for (const f of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) if (gd && fs.existsSync(path.join(gd, f))) return refuse(`a ${f.replace(/_HEAD$|-\w+$/, '').toLowerCase()} is in progress in it`);
  const dirty = String(git(lane.dir, 'status', '--porcelain', '--untracked-files=no').stdout || '').split('\n').filter((l) => l.length > 3);
  if (dirty.length) return refuse(`uncommitted work in it (${dirty.slice(0, 3).map((l) => l.slice(3)).join(', ')}${dirty.length > 3 ? ` +${dirty.length - 3}` : ''}): its agent commits or hands it back first`);
  const branch = out(git(lane.dir, 'symbolic-ref', '--short', 'HEAD'));
  if (!branch) return refuse('its copy is on a detached HEAD');
  const before = out(git(lane.dir, 'rev-parse', 'HEAD'));
  const behind = Number(out(git(lane.dir, 'rev-list', '--count', `HEAD..${tip}`))) || 0;
  const laneEnv = cleanEnv({ STUDIO_MAIN_ROOT: root });
  // 1. Stamps: the lane's own commits (main..lane) through the hooks gate's check; re-stamp through the real hooks.
  const hs = await import('./hook-stamp.mjs');
  let restamped = 0;
  if (Number(out(git(lane.dir, 'rev-list', '--count', `${tip}..HEAD`))) > 0) {
    let c = null;
    try { c = await hs.checkHookStamps({ env: { ...laneEnv, STUDIO_HARNESS_REF_TIMEOUT_MS: env.STUDIO_HARNESS_REF_TIMEOUT_MS || '3000' }, range: { base: tip, head: before } }); } catch (e) { c = { ok: false, open: [{ why: e.message }] }; }
    if (c.open?.length && c.enforced !== false) {
      log(`[lanes] ${name}: ${c.open.length} commit(s) whose stamp no longer matches; re-stamping through the hooks (base ${main} ${tip.slice(0, 8)})`);
      let r;
      try { r = await hs.restamp({ cwd: lane.dir, base: tip, env: laneEnv }); } catch (e) { r = { ok: false, why: e.message }; }
      if (!r.ok) return done('red', `re-stamp failed: ${r.why}`, { stage: 'stamps', head: before, merged: false });
      restamped = r.replayed || 0;
    }
  }
  // 2. Merge main in (never a rebase). A conflict: abort, list the files, hand back.
  let merged = false;
  let head = out(git(lane.dir, 'rev-parse', 'HEAD'));
  if (behind > 0) {
    const ident = out(git(lane.dir, 'config', 'user.email')) ? [] : ['-c', 'user.name=launcher', '-c', 'user.email=launcher@studio.local'];
    const m = spawnSync('git', [...ident, 'merge', '--no-edit', '-m', `Merge ${main} into ${branch} (lanes refresh by ${String(by).slice(0, 40)})`, tip], { cwd: lane.dir, encoding: 'utf8', env: laneEnv, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    if (m.status !== 0) {
      const files = out(git(lane.dir, 'diff', '--name-only', '--diff-filter=U')).split('\n').filter(Boolean);
      const mergingNow = gd && fs.existsSync(path.join(gd, 'MERGE_HEAD'));
      if (mergingNow) git(lane.dir, 'merge', '--abort');
      const now = out(git(lane.dir, 'rev-parse', 'HEAD'));
      if (files.length || mergingNow) return done('conflict', `merging ${main} conflicts in ${files.length ? files.join(', ') : 'files git did not name'}; merge aborted, nothing resolved: the lane's agent (or an integrator) merges ${main} and resolves`, { files, head: now, merged: false, restamped });
      return done('red', `git merge failed: ${tailOf(`${m.stdout || ''}${m.stderr || ''}`, 4) || `exit ${m.status}`}`, { stage: 'merge', head: now, merged: false, restamped });
    }
    merged = true;
    head = out(git(lane.dir, 'rev-parse', 'HEAD'));
    // The merge commit's stamp (commit-msg writes a merge stamp), judged as the hooks gate will.
    let c = null;
    try { c = await hs.checkHookStamps({ env: { ...laneEnv, STUDIO_HARNESS_REF_TIMEOUT_MS: env.STUDIO_HARNESS_REF_TIMEOUT_MS || '3000' }, range: { base: tip, head } }); } catch (e) { c = { ok: false, open: [{ why: e.message }] }; }
    if (c && !c.ok) return done('red', `merged ${main}, but the hooks gate would refuse the lane: ${c.open?.[0]?.why || c.why}`, { stage: 'stamps', head, merged, restamped });
  }
  // 3. The lane's targeted tests: the game's checks scoped to the lane's own files, related tests only.
  let testRes = null;
  const own = out(git(lane.dir, 'diff', '--name-only', '--no-renames', `${tip}...HEAD`)).split('\n').filter(Boolean);
  if (tests && own.length) {
    const script = path.join(lane.dir, 'harness', 'game-gates.mjs');
    const r = spawnSync(process.execPath, [script, '--json', '--paths', own.join(','), '--changed', own.join(',')], { cwd: lane.dir, encoding: 'utf8', env: { ...laneEnv, STUDIO_GATE_RELATED: 'on', STUDIO_JOB_TASK: lane.task || '', ...(lane.agent ? { STUDIO_LOCK_OWNER: lane.agent } : {}) }, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    let j = null;
    try { j = JSON.parse(String(r.stdout || '').trim().split('\n').pop()); } catch {}
    testRes = { ok: r.status === 0 && Boolean(j?.ok ?? true), ran: (j?.rows || []).map((x) => x.id), failed: (j?.failed || []).map((x) => `${x.id}: ${String(x.why || '').slice(0, 200)}`), skipped: (j?.skipped || []).map((x) => x.id), ...(j ? {} : { tail: tailOf(`${r.stdout || ''}${r.stderr || ''}`) }) };
    if (!testRes.ok) return done('red', `merged ${main}${restamped ? `, re-stamped ${restamped}` : ''}; its targeted tests fail: ${testRes.failed.join(' | ') || testRes.tail || `exit ${r.status}`}`, { stage: 'tests', head, merged, restamped, tests: testRes });
  } else testRes = { ok: true, ran: [], failed: [], skipped: [], note: tests ? 'no files of its own' : 'not run (--no-tests)' };
  const words = [merged ? `merged ${main} (${behind} commit(s))` : `already has ${main}`, restamped ? `re-stamped ${restamped} commit(s)` : '', testRes.ran.length ? `targeted tests green (${testRes.ran.join(', ')})` : `tests: ${testRes.note || 'none to run'}`].filter(Boolean).join('; ');
  return done('ok', words, { head, merged, restamped, behind, tests: testRes });
}

// ---- CLI ----------------------------------------------------------------------------------------

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const opt = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
  const json = argv.includes('--json');
  const root = mainRoot();
  if (argv[0] === 'refresh') {
    const target = argv[1] && !argv[1].startsWith('--') ? argv[1] : null;
    const allLanes = argv.includes('--all');
    const by = opt('--by');
    if (!target && !allLanes) { console.error('Usage: npm run lanes -- refresh <task|agent|branch|--all> --by <name> [--busy-ok] [--no-tests] [--json]'); process.exit(2); }
    const who = refreshRefusal({ by });
    if (who) {
      try { emitEvent({ type: 'lanes.refresh.refused', agent: String(by || process.env.STUDIO_LOCK_OWNER || 'unknown').slice(0, 60), status: 'warn', msg: `refresh ${target || '--all'}: ${who}`.slice(0, 400) }); } catch {}
      if (json) console.log(JSON.stringify({ ok: false, refused: true, why: who })); else console.error(who);
      process.exit(2);
    }
    const lanes = allLanes ? collectLanes(root).filter((l) => l.dir && fs.existsSync(l.dir)) : [findLane(root, target)];
    const results = [];
    for (const l of lanes) {
      const r = await refreshLane(root, l, { by, busyOk: argv.includes('--busy-ok'), tests: !argv.includes('--no-tests'), log: (m) => console.error(m) });
      results.push(r);
      if (!json) console.log(`[lanes] ${r.status.toUpperCase()} ${r.lane}: ${r.why}`);
    }
    if (json) console.log(JSON.stringify({ ok: results.every((r) => r.status === 'ok'), results }));
    if (!results.length && !json) console.log('[lanes] no lane copy to refresh');
    process.exit(results.some((r) => r.status === 'conflict' || r.status === 'red') ? 1 : results.some((r) => r.status === 'refused') ? 2 : 0);
  }
  if (argv[0] && !argv[0].startsWith('--')) { console.error('Usage: npm run lanes [-- --json] [--no-stamps] | npm run lanes -- refresh <task|agent|branch|--all> --by <name> [--busy-ok] [--no-tests]'); process.exit(2); }
  const t = await laneTable(root, { stamps: !argv.includes('--no-stamps') });
  console.log(json ? JSON.stringify(t) : tableText(t));
  process.exit(0);
}

export { LANES_DIR };
