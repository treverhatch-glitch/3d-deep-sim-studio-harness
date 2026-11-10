#!/usr/bin/env node
/**
 * harness/remote-workers.mjs — 2.77.0 (o): remote (cloud) workers, the first step to more than one rig.
 *
 * The owner asked whether work can run on cloud computers to take load off the PC. A cloud session (Claude Code on
 * the web, or any session that works through Git) can do a self-contained task and push a branch; the studio's PC
 * keeps everything that is local: the board, the locks, .studio state, the merge train and Unity. The flow:
 *
 *   npm run remote -- mark <T-ID> [--test "<cmd>"]... [--allow <path>]... [--off] --by <name>
 *       marks a task remote-eligible (studio/task-holds.json "remote", the board's record). A research, design or docs
 *       task needs nothing more; a code task needs the commands that run its own tests (--test, else the repo's
 *       `npm test` when package.json has one). Never eligible: a person's or a planning role's task, a Unity task
 *       (Windows, GPU and a licence), a task whose lane is studio/ or .studio/ (the board and the state are local).
 *   npm run remote -- brief <T-ID> [--worker <name>] --by <name> [--json]
 *       claims the task for remote-<worker> with a lease of STUDIO_REMOTE_LEASE_H hours (12) and writes a
 *       self-contained brief for the cloud session (.studio/remote/briefs/<T-ID>.md, printed): the task and what done
 *       means, the commands for its own tests, the branch to push (remote/<T-ID>-<short>), the Studio-Task trailer,
 *       the "Studio-Remote: done" marker, what not to touch. The lease is on the board (studio/task-holds.json), in
 *       .studio/remote/leases.json, in `npm run remote -- status` and in the Line Producer's status.
 *   npm run remote -- fetch [--dry-run] [--json] --by <name>
 *       fetches remote/* from STUDIO_REMOTE_NAME (origin) and, for each branch with a live lease whose last commit says
 *       "Studio-Remote: done": every commit of its own carries "Studio-Task: <T-ID>" (no other task's), it touches only
 *       allowed paths (never studio/, .studio/, .lanes/, .env or node_modules; within the task's lane and --allow
 *       paths when it has any), and not the harness's own code (harness/, scripts/, tools/, qa/*.mjs,
 *       package.json: that would run on this PC at once; a person queues it by hand after reading it). Then a lane copy
 *       is made for it (harness/lane-create.mjs: studio/ linked to main), its commits re-stamped through the local
 *       hooks when needed (harness/lanes.mjs refreshLane), and `task done <T-ID> --train` queues it for the NORMAL
 *       train in that copy: every task-done check, the tier rules (tier C waits for a release), one full verify, as
 *       for any lane. Nothing lands without the train. "Studio-Remote: handback <why>" hands the task back instead.
 *   npm run remote -- release <T-ID> --by <name> [--note "…"]   end a lease by hand (the task goes back to the board)
 *   npm run remote -- status [--json]                             leases, offers, the last fetch
 *
 * The Line Producer (harness/line-producer.mjs) offers remote-eligible ready tasks to remote workers when the local
 * builders are at their target (a "remote" line in its status and `npm run line -- plan`, a remote.offer event when the
 * offer changes), and with STUDIO_REMOTE=on its pass also ends leases that ran out (an expired lease releases the
 * claim and hands the task back) and starts a background fetch every STUDIO_REMOTE_FETCH_MIN minutes while a lease
 * is out. The rig budget (harness/rig-budget.mjs) counts a remote task as zero local CPU until its branch is queued.
 *
 * Settings: STUDIO_REMOTE (off; on: the Line Producer's sweep and fetch), STUDIO_REMOTE_NAME (origin),
 * STUDIO_REMOTE_LEASE_H (12), STUDIO_REMOTE_MAX (2 tasks out at once), STUDIO_REMOTE_FETCH_MIN (10).
 * docs/REMOTE-WORKERS.md has the setup (a push-enabled remote: the studio's origin push is disabled on the owner's PC).
 * Who: mark, brief, fetch and release: a person, a Producer or Director session, or an agent outside the harness
 * (harness/lanes.mjs refreshRefusal, the rule `lanes -- refresh` uses); a launched worker session never.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { emitEvent, readRecentEvents } from './event.mjs';
import { mainRoot, mainBranch, MAIN_CHECKOUT_ROLES, removeLaneCopy, LANES_DIR } from './worktree.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TASK_ID = /^[A-Z]+-\d+$/;
const WORKER = /^[a-z0-9][a-z0-9-]{0,30}$/i;
export const OWNER_PREFIX = 'remote-';
/** 2.77.0: the old form "remote:<worker>" (a colon is an NTFS stream separator on Windows) is still recognized when read, never written. */
export const OLD_OWNER_PREFIX = 'remote:';
export const isRemoteOwner = (o) => typeof o === 'string' && (o.startsWith(OWNER_PREFIX) || o.startsWith(OLD_OWNER_PREFIX));
export const BRANCH_PREFIX = 'remote/';
export const ACTIVE = new Set(['leased', 'working', 'refused', 'needs-review', 'queued']);
export const NEVER = [/^studio\//, /^\.studio\//, /^\.lanes\//, /^\.env($|\.)/, /(^|\/)node_modules(\/|$)/, /^\.git\//];
export const HARNESS_CODE = /^(harness|scripts|tools|\.claude|\.githooks)\/|^qa\/[^/]+\.mjs$|^package(-lock)?\.json$/;
const DOCS_TYPES = new Set(['research', 'study', 'idea', 'docs', 'design']);
const num = (v, d) => { const s = String(v ?? '').trim(); const n = Number(s); return s !== '' && Number.isFinite(n) ? n : d; };
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const cleanEnv = (extra = {}) => { const e = { ...process.env, ...extra }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|PREFIX|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/.test(k)) delete e[k]; return e; };
const git = (cwd, args, opts = {}) => spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanEnv(), maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...opts });
const out = (r) => (r.status === 0 ? String(r.stdout || '').trim() : '');
const alive = (pid) => { if (!pid) return false; try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// ---- settings --------------------------------------------------------------------------------------------------------

/** STUDIO_REMOTE: on | off (default off): the Line Producer's lease sweep and background fetch. The commands always work. */
export const remoteOn = (env = process.env) => /^(on|1|true|yes)$/i.test(String(env.STUDIO_REMOTE || '').trim());
export const remoteName = (env = process.env) => String(env.STUDIO_REMOTE_NAME || '').trim() || 'origin';
export const leaseHours = (env = process.env) => Math.max(0.01, num(env.STUDIO_REMOTE_LEASE_H, 12));
export const remoteMax = (env = process.env) => Math.max(0, Math.floor(num(env.STUDIO_REMOTE_MAX, 2)));
export const fetchEveryMin = (env = process.env) => Math.max(1, num(env.STUDIO_REMOTE_FETCH_MIN, 10));

export const REMOTE_DIR = (root = mainRoot()) => path.join(root, '.studio', 'remote');
export const LEASES_FILE = (root = mainRoot()) => path.join(REMOTE_DIR(root), 'leases.json');
export const FETCH_FILE = (root = mainRoot()) => path.join(REMOTE_DIR(root), 'fetch.json');
export const OFFER_FILE = (root = mainRoot()) => path.join(REMOTE_DIR(root), 'offer.json');
export const briefFile = (root, task) => path.join(REMOTE_DIR(root), 'briefs', `${task}.md`);
export const laneAgentFor = (task) => `remote-${String(task).toLowerCase()}`;

export const readLeases = (root = mainRoot()) => readJson(LEASES_FILE(root), {}) || {};
export function writeLeases(root, leases) {
  const f = LEASES_FILE(root);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(leases, null, 2)}\n`);
  fs.renameSync(tmp, f);
}
function patchLease(root, task, patch) {
  const all = readLeases(root);
  if (!all[task]) return null;
  all[task] = { ...all[task], ...patch };
  writeLeases(root, all);
  return all[task];
}

/** A short branch suffix from a title: "Write the docs for X" -> "write-the-docs-for". */
export function shortName(title = '') {
  const s = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').filter(Boolean).slice(0, 4).join('-').slice(0, 24).replace(/-+$/, '');
  return s || 'task';
}
export const branchFor = (task, title) => `${BRANCH_PREFIX}${task}-${shortName(title)}`;

/** Why this caller may not hand out or take in remote work, or '' (the `lanes -- refresh` rule). */
export async function remoteRefusal({ by, env = process.env } = {}) {
  const { refreshRefusal } = await import('./lanes.mjs');
  return refreshRefusal({ by, env }).replace(/can't refresh lanes|refresh lanes|lanes are refreshed by/g, (m) => (m === "can't refresh lanes" ? "can't hand out remote work" : m === 'refresh lanes' ? 'hand out remote work' : 'remote work is handed out by'));
}

// ---- eligibility ------------------------------------------------------------------------------------------------------

/** The commands that run the repo's own tests when a code task names none: `npm test` if package.json has one. */
export function defaultTests(root = mainRoot()) {
  const pj = readJson(path.join(root, 'package.json'), {});
  return pj?.scripts?.test ? ['npm test'] : [];
}

/**
 * Can this task go to a remote worker? { ok, why, kind: 'docs'|'code', tests }. Pure: t { id, role, title }, meta (its
 * task.added meta), type (done-check's), mark (studio/task-holds.json "remote"), lane (its lane), tests (the default).
 */
export function remoteEligible(t, { meta = {}, type = '', mark = null, lane = null, tests = [] } = {}) {
  if (!t) return { ok: false, why: 'not on the board' };
  const role = String(t.role || '').toLowerCase();
  if (!role || MAIN_CHECKOUT_ROLES.has(role)) return { ok: false, why: `a ${role || 'person'}'s task works on the board, on this PC` };
  const track = String(meta.track || '');
  if (/unity/i.test(track) || /\bunity\b/i.test(String(t.title || '')) || /unity/i.test(String(meta.engine || ''))) return { ok: false, why: 'a Unity task needs this PC (Windows, the GPU and the licence)' };
  const marked = mark ? mark.on !== false : meta.remote === true;
  if (!marked) return { ok: false, why: `not marked remote-eligible (npm run remote -- mark ${t.id} --by <name>)` };
  const lanes = String(lane || '').split(',').map((x) => x.trim().replace(/\\/g, '/')).filter(Boolean);
  if (lanes.some((l) => /^(studio|\.studio)(\/|$)/.test(l))) return { ok: false, why: `its lane (${lanes.join(', ')}) is the board or the studio's state, which stay on this PC` };
  const kind = DOCS_TYPES.has(String(type || meta.type || '').toLowerCase()) ? 'docs' : 'code';
  const cmds = [...(mark?.tests || []), ...(meta.remoteTests || [])].filter(Boolean);
  const run = cmds.length ? cmds : kind === 'code' ? tests : [];
  if (kind === 'code' && !run.length) return { ok: false, why: `a code task needs the commands that run its own tests (npm run remote -- mark ${t.id} --test "<cmd>")`, kind };
  return { ok: true, why: kind === 'docs' ? 'a research/design/docs task' : `a code task that runs its own tests (${run.join('; ')})`, kind, tests: run };
}

/** The facts eligibility needs for one board task (reads the board's records). */
async function taskFacts(root, id, events = null) {
  const task = await import('./task.mjs');
  const q = task.parseNextQueue();
  const t = [...q.inProgress, ...q.backlog].find((x) => x.id === id) || null;
  const done = q.done.some((x) => x.id === id);
  const evs = events || readRecentEvents(20000);
  const meta = evs.filter((e) => e.type === 'task.added' && e.task === id).pop()?.meta || {};
  let type = '';
  try { type = t ? (await import('./done-check.mjs')).taskType(t) : ''; } catch {}
  const th = await import('./task-hold.mjs');
  const holds = th.readHolds();
  let lane = null;
  try { lane = th.laneOf(id, evs, holds); } catch {}
  return { q, t, done, meta, type, mark: holds[id]?.remote || null, lane, holds, inProgress: q.inProgress.some((x) => x.id === id) };
}

// ---- mark ---------------------------------------------------------------------------------------------------------------

export async function markRemote({ task, on = true, tests = [], allow = [], by, env = process.env } = {}) {
  const who = await remoteRefusal({ by, env });
  if (who) return { ok: false, refused: true, why: who };
  if (!TASK_ID.test(String(task || ''))) return { ok: false, why: 'Usage: npm run remote -- mark <T-ID> [--test "<cmd>"]... [--allow <path>]... [--off] --by <name>' };
  const root = mainRoot();
  const f = await taskFacts(root, task);
  if (!f.t) return { ok: false, why: `${task} isn't an open task on the board` };
  // Never eligible, whatever the mark says: a person's or a planning role's task, Unity, the board's own lane.
  if (on) { const never = remoteEligible(f.t, { meta: f.meta, type: f.type, mark: { on: true, tests: ['-'] }, lane: f.lane }); if (!never.ok) return { ok: false, why: `${task} can't be marked remote-eligible: ${never.why}` }; }
  const { setHold } = await import('./task-hold.mjs');
  const was = f.mark || {};
  const mark = on ? { ...was, on: true, ...(tests.length ? { tests } : {}), ...(allow.length ? { allow: allow.map((p) => p.replace(/\\/g, '/').replace(/^\.\//, '')) } : {}), by, at: new Date().toISOString() } : null;
  setHold(task, { remote: mark && was.lease ? { ...mark, lease: was.lease } : mark }, { by, msg: on ? `${task} marked remote-eligible by ${by}${tests.length ? ` (tests: ${tests.join('; ')})` : ''}` : `${task}: remote-eligible mark removed by ${by}` });
  const e = on ? remoteEligible(f.t, { meta: f.meta, type: f.type, mark, lane: f.lane, tests: defaultTests(root) }) : { ok: false, why: 'mark removed' };
  return { ok: true, task, mark, eligible: e };
}

// ---- brief --------------------------------------------------------------------------------------------------------------

/** The brief a cloud session gets: self-contained, no local paths it can't use. */
export function briefText(L, { title = '', means = '', told = '', priority = '', role = '', type = '', research = null, baseOnRemote = null, mainName = 'main' } = {}) {
  const rem = L.remote;
  const lines = [
    `# Remote task ${L.task}: ${title}`,
    '',
    `You are a remote worker (a cloud session) for this studio. Do ONLY this task, and push ONLY the branch named below. The studio's own PC lands your work: it fetches your branch, checks it and runs it through its merge train (one full verify of the whole tree). Nothing you push lands by itself, and the board, the claims and the studio's state are not in your copy to change.`,
    '',
    `- Task: ${L.task} [${priority || '?'}] (\`${role || '?'}\`, a ${type || 'change'} task): ${title}`,
    `- Claimed for: \`${L.owner}\` until ${L.until} (UTC; a lease of ${L.leaseH} h). After that the claim is released, the task goes back on the board and your branch is ignored.`,
    `- Start from: \`${rem}/${mainName}\`${L.base ? ` (the studio's ${mainName} was at ${L.base.slice(0, 12)} when this brief was written${baseOnRemote === false ? `; that commit isn't on ${rem} yet: start from ${rem}/${mainName} as it is, the studio merges the rest` : ''})` : ''}.`,
    `- Push to: \`${L.branch}\` on \`${rem}\`. Never push ${mainName} or any other branch, never force-push.`,
    '',
    '## Done means',
    means ? `${means}.` : 'The task title says what is wanted.',
    ...(research ? ['', `A research task: write it up in \`${research}\` (sources with links, findings, what the studio should do).`] : []),
    ...(told ? ['', '## What the task is, and notes left on it', told.trimEnd()] : []),
    '',
    '## Steps',
    `1. \`git fetch ${rem} && git checkout -b ${L.branch} ${rem}/${mainName}\``,
    '2. `npm ci` (the repo\'s own packages).',
    '3. Make the change. Keep it to this task.',
    ...(L.tests.length ? [`4. Run its own tests, and make them pass: ${L.tests.map((c) => `\`${c}\``).join(', ')}.`] : ['4. No tests to run for this kind of task; check every link and command you write.']),
    `5. Every commit carries the task's trailer: \`git commit -m "<what changed>" -m "Studio-Task: ${L.task}"\`.`,
    `6. When the task is finished, the LAST commit also carries \`Studio-Remote: done\` (an empty commit is fine: \`git commit --allow-empty -m "${L.task} ready" -m "Studio-Task: ${L.task}" -m "Studio-Remote: done"\`). Can't finish it? End with \`Studio-Remote: handback <one line: why, what is left>\` instead.`,
    `7. \`git push ${rem} ${L.branch}\``,
    '',
    '## Never',
    '- Never touch `studio/` (the board, the Bible, approvals), `.studio/` (claims, events, state), `.lanes/`, `.env` or `node_modules/`: they are the studio PC\'s, and a branch that changes them is refused.',
    `- ${L.allow.length ? `Change files only under: ${L.allow.map((p) => `\`${p}\``).join(', ')}.` : 'Change only what the task needs.'} A config change for \`studio/*.json\` goes in \`studio-proposals/${L.task}.json\` instead (\`{ "changes": [ { "file": "studio/<name>.json", "set": { "<a.b>": <value> } } ], "why": "…" }\`).`,
    '- A change to the harness\'s own code (harness/, scripts/, tools/, qa/*.mjs, package.json) is not queued by itself: a person reads it first. Protected files (studio/protected.json) make the lane wait for a person\'s release.',
    '- No Unity work, no outside assets without asking, never print or commit keys or tokens, never weaken a test to pass.',
    '',
    `(Written by harness/remote-workers.mjs for ${L.owner} at ${L.at}.)`,
  ];
  return `${lines.join('\n')}\n`;
}

export async function briefRemote({ task, worker = 'web', by, env = process.env, now = Date.now() } = {}) {
  const who = await remoteRefusal({ by, env });
  if (who) return { ok: false, refused: true, why: who };
  if (!TASK_ID.test(String(task || ''))) return { ok: false, why: 'Usage: npm run remote -- brief <T-ID> [--worker <name>] --by <name>' };
  if (!WORKER.test(String(worker || ''))) return { ok: false, why: `"${worker}" isn't a worker name (letters, digits and -, up to 31)` };
  const root = mainRoot();
  const f = await taskFacts(root, task);
  if (!f.t) return { ok: false, why: f.done ? `${task} is done` : `${task} isn't an open task on the board` };
  if (f.inProgress) return { ok: false, why: `${task} is in progress already (npm run task -- show ${task})` };
  const leases = readLeases(root);
  if (leases[task] && ACTIVE.has(leases[task].status)) return { ok: false, why: `${task} is out to ${leases[task].owner} already (until ${leases[task].until})` };
  const e = remoteEligible(f.t, { meta: f.meta, type: f.type, mark: f.mark, lane: f.lane, tests: defaultTests(root) });
  if (!e.ok) return { ok: false, why: `${task} can't go to a remote worker: ${e.why}` };
  const owner = `${OWNER_PREFIX}${worker}`;
  const h = leaseHours(env);
  const lock = await import('./lock.mjs');
  const c = lock.claim(`task:${task}`, owner, Math.round(h * 3600));
  if (!c.ok) return { ok: false, why: `${task} couldn't be claimed: ${c.message || (c.lock?.owner ? `claimed by ${c.lock.owner}` : c.reason)}` };
  const tm = await import('./task.mjs');
  const s = tm.startTask(task, owner, { model: 'remote' });
  if (!s || s.error) { try { lock.release(`task:${task}`, owner); } catch {} return { ok: false, why: `${task} couldn't be started: ${s?.message || s?.error || 'not on the board'}` }; }
  const main = mainBranch(root);
  const base = out(git(root, ['rev-parse', 'HEAD']));
  const rem = remoteName(env);
  const remMain = out(git(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/${rem}/${main}`]));
  const baseOnRemote = remMain ? git(root, ['merge-base', '--is-ancestor', base, remMain]).status === 0 : null;
  const L = {
    task, title: f.t.title, worker, owner, remote: rem, branch: branchFor(task, f.t.title), base, main,
    at: new Date(now).toISOString(), until: new Date(now + h * 3600000).toISOString(), leaseH: h,
    status: 'leased', kind: e.kind, tests: e.tests || [], allow: [...new Set([...String(f.lane || '').split(',').map((x) => x.split('#')[0].trim()).filter(Boolean), ...(f.mark?.allow || [])])], by,
  };
  let means = ''; let told = ''; let research = null;
  try {
    const fo = (await import('./focus.mjs')).buildFocus(task, owner);
    means = fo?.check?.means || '';
    const { untrustedBlock } = await import('./untrusted.mjs');
    const handoff = fo?.handoff ? String(fo.handoff).replace(/^# .*\n+/, '').replace(/^Newest last.*\n/m, '').trim().slice(-3000) : '';
    told = untrustedBlock([{ label: `Task title (${task})`, text: f.t.title }, { label: 'Notes from whoever worked on this before, newest last', text: handoff }]);
  } catch {}
  if (e.kind === 'docs' && /research|study/i.test(f.type)) { try { research = (await import('./research.mjs')).researchRel(task, root); L.allow = L.allow.length ? [...new Set([...L.allow, research])] : L.allow; } catch {} }
  const text = briefText(L, { title: f.t.title, means, told, priority: f.t.priority, role: f.t.role, type: f.type, research, baseOnRemote, mainName: main });
  const bf = briefFile(root, task);
  fs.mkdirSync(path.dirname(bf), { recursive: true });
  fs.writeFileSync(bf, text);
  L.brief = path.relative(root, bf).split(path.sep).join('/');
  leases[task] = L;
  writeLeases(root, leases);
  try { (await import('./task-hold.mjs')).setHold(task, { remote: { ...(f.mark || { on: true }), lease: { owner, until: L.until, branch: L.branch } } }, { by }); } catch {}
  emitEvent({ type: 'task.remote.leased', agent: owner, task, to: 'producer', msg: `${task} is out to ${owner} until ${L.until.slice(0, 16).replace('T', ' ')} UTC: it pushes ${L.branch} to ${rem} (briefed by ${by})`.slice(0, 500), meta: { owner, branch: L.branch, until: L.until, remote: rem, by, kind: e.kind } });
  return { ok: true, task, lease: L, brief: L.brief, text, ...(baseOnRemote === false ? { warn: `the studio's ${main} (${base.slice(0, 8)}) isn't on ${rem}/${main} as last fetched: the cloud session starts from an older ${main} (push ${main} to ${rem} first if you can; docs/REMOTE-WORKERS.md)` } : remMain ? {} : { warn: `no ${rem}/${main} here yet (git fetch ${rem}): check the cloud session can see the studio's ${main}` }) };
}

// ---- the sweep: leases that ran out, tasks that landed ------------------------------------------------------------------

/**
 * End what is over: a lease past its time (not queued) releases the claim and hands the task back; a landed task's lease
 * is closed; a queued lane's claim is kept while it waits for the train. Returns [{ task, what }].
 */
export async function remoteSweep({ root = mainRoot(), env = process.env, now = Date.now(), emit = emitEvent } = {}) {
  const leases = readLeases(root);
  const acts = [];
  if (!Object.values(leases).some((l) => ACTIVE.has(l.status))) return acts;
  const tm = await import('./task.mjs');
  const lock = await import('./lock.mjs');
  const q = tm.parseNextQueue();
  const doneIds = new Set(q.done.map((t) => t.id));
  const inProg = new Set(q.inProgress.map((t) => t.id));
  let trainQ = [];
  try { trainQ = (await import('./train.mjs')).readQueue(root); } catch {}
  const queued = new Set(trainQ.map((e) => e.task));
  const end = async (L, status, what) => {
    leases[L.task] = { ...L, status, endedAt: new Date(now).toISOString(), endWhy: what };
    try { const th = await import('./task-hold.mjs'); const m = th.readHolds()[L.task]?.remote; if (m?.lease) { const { lease, ...rest } = m; void lease; th.setHold(L.task, { remote: Object.keys(rest).length ? rest : null }, { by: 'remote' }); } } catch {}
    try { emit({ type: 'task.remote.ended', agent: L.owner, task: L.task, to: 'producer', status: status === 'landed' ? 'ok' : 'warn', msg: `${L.task}: ${what}`.slice(0, 500), meta: { status, owner: L.owner, branch: L.branch } }); } catch {}
    acts.push({ task: L.task, status, what });
  };
  for (const L of Object.values(leases)) {
    if (!ACTIVE.has(L.status)) continue;
    if (doneIds.has(L.task)) { await end(L, 'landed', `${L.owner}'s work landed`); continue; }
    const held = lock.status(`task:${L.task}`);
    const mine = held.locked && held.lock.owner === L.owner;
    if (L.status === 'queued' && queued.has(L.task)) { lock.renewOwner(L.owner, 2 * 3600); continue; }
    if (L.status === 'queued' && !queued.has(L.task) && !inProg.has(L.task)) { await end(L, 'handed-back', `the train handed ${L.task} back (it is on the board again)`); continue; }
    if (!inProg.has(L.task) && !mine) { await end(L, 'released', `${L.task}'s remote claim was ended elsewhere (it is no longer in progress)`); continue; }
    if (Date.parse(L.until) <= now && !(L.status === 'queued' && queued.has(L.task))) {
      let r = null;
      try { r = tm.pauseTask(L.task, L.owner, `remote lease ran out: ${L.owner} had it until ${L.until} (STUDIO_REMOTE_LEASE_H ${L.leaseH} h) and pushed no finished branch (${L.branch} on ${L.remote}${L.fetched?.head ? `, last seen at ${L.fetched.head.slice(0, 8)}: ${L.fetched.why || L.status}` : ''}). The claim is released; brief it again or take it locally.`, { force: true }); } catch (e) { r = { error: e.message }; }
      if (r?.error && held.locked && held.lock.owner === L.owner) { try { lock.release(`task:${L.task}`, L.owner); } catch {} }
      await end(L, 'expired', `the remote lease of ${L.owner} ran out (${L.until.slice(0, 16).replace('T', ' ')} UTC): claim released, back on the board`);
    }
  }
  if (acts.length) writeLeases(root, leases);
  return acts;
}

// ---- fetch --------------------------------------------------------------------------------------------------------------

/** Trailer values of a commit's message for a key. */
const trailer = (msg, key) => [...String(msg || '').matchAll(new RegExp(`^${key}:\\s*(.+)$`, 'gmi'))].map((m) => m[1].trim());
const globRe = (g) => new RegExp(`^${String(g).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\/$/, '')}(/.*)?$`);

/**
 * Check a fetched branch against its lease (pure git reads): { ok, problems: [], commits, files, done, handback, harness }.
 */
export function checkBranch(root, { ref, lease, main = mainBranch(root) }) {
  const problems = [];
  const head = out(git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]));
  if (!head) return { ok: false, problems: [`${ref} isn't here`], commits: [], files: [] };
  const base = out(git(root, ['merge-base', main, head]));
  if (!base) return { ok: false, head, problems: [`${ref} shares no history with ${main}`], commits: [], files: [] };
  const log = git(root, ['log', '--format=%x1e%H%x09%P%x09%B', `${main}..${head}`]);
  const commits = String(log.stdout || '').split('\x1e').map((x) => x.replace(/^\s+/, '')).filter(Boolean).map((rec) => { const [sha, parents, ...body] = rec.split('\t'); return { sha, parents: String(parents || '').split(/\s+/).filter(Boolean), msg: body.join('\t') }; });
  if (!commits.length) problems.push(`${ref} has no commits of its own`);
  for (const c of commits) {
    const tasks = trailer(c.msg, 'Studio-Task').flatMap((v) => v.split(/[,\s]+/)).filter(Boolean);
    const others = tasks.filter((t) => t !== lease.task);
    if (others.length) problems.push(`commit ${c.sha.slice(0, 8)} names another task (Studio-Task: ${others.join(', ')})`);
    if (tasks.includes(lease.task)) continue;
    // A merge of the studio's branch into the remote branch needs no trailer: every parent but the first is on main.
    if (c.parents.length > 1 && c.parents.slice(1).every((p) => git(root, ['merge-base', '--is-ancestor', p, main]).status === 0)) continue;
    if (!others.length) problems.push(`commit ${c.sha.slice(0, 8)} has no "Studio-Task: ${lease.task}" trailer`);
  }
  const files = out(git(root, ['diff', '--name-only', '--no-renames', `${base}..${head}`])).split('\n').filter(Boolean);
  const never = files.filter((f) => NEVER.some((re) => re.test(f)));
  if (never.length) problems.push(`it changes files that stay on the studio's PC: ${never.slice(0, 5).join(', ')}${never.length > 5 ? ` +${never.length - 5}` : ''}`);
  const allow = (lease.allow || []).filter(Boolean);
  if (allow.length) {
    const okFile = (f) => f === `studio-proposals/${lease.task}.json` || allow.some((g) => globRe(g).test(f));
    const outside = files.filter((f) => !NEVER.some((re) => re.test(f)) && !okFile(f));
    if (outside.length) problems.push(`it changes files outside its allowed paths (${allow.join(', ')}): ${outside.slice(0, 5).join(', ')}${outside.length > 5 ? ` +${outside.length - 5}` : ''}`);
  }
  const harness = files.filter((f) => HARNESS_CODE.test(f));
  const last = commits[0] || null; // newest first
  const mark = last ? trailer(last.msg, 'Studio-Remote')[0] || '' : '';
  const done = /^done\b/i.test(mark);
  const handback = /^hand-?back\b/i.test(mark) ? mark.replace(/^hand-?back\b[:\s]*/i, '').trim() || 'no reason given' : null;
  return { ok: !problems.length, head, base, problems, commits: commits.map((c) => c.sha), files, done, handback, harness };
}

/** The remote/* branches fetched from the remote: [{ ref, branch, task }]. */
export function remoteBranches(root, rem) {
  const r = git(root, ['for-each-ref', '--format=%(refname)', `refs/remotes/${rem}/${BRANCH_PREFIX}`]);
  return out(r).split('\n').filter(Boolean).map((ref) => { const branch = ref.slice(`refs/remotes/${rem}/`.length); const m = branch.match(/^remote\/([A-Z]+-\d+)(?:-|$)/); return { ref, branch, task: m ? m[1] : null }; });
}

/** Queue a checked lane copy for the train the normal way: its own `task done <ID> --train` (every task-done check). */
export function queueLane({ root, dir, task, owner, note, env = process.env }) {
  const script = path.join(dir, 'harness', 'task.mjs');
  const r = spawnSync(process.execPath, [script, 'done', task, '--agent', owner, '--train', '--note', note], { cwd: dir, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: cleanEnv({ ...env, STUDIO_MAIN_ROOT: root, STUDIO_LOCK_OWNER: owner, STUDIO_ROLE: '' }), timeout: num(env.STUDIO_REMOTE_QUEUE_TIMEOUT_S, 900) * 1000 });
  const text = `${r.stdout || ''}${r.stderr || ''}`.trim();
  return { ok: r.status === 0, status: r.status, text: text.split('\n').slice(-14).join('\n') };
}

/**
 * Fetch remote/* and take in each finished branch with a live lease. deps (tests): { fetch: (root, rem) -> { ok, why },
 * queue: (args) -> { ok, text } }. Returns { ok, fetched: { ok, why }, results: [{ task, branch, status, why }] }.
 */
export async function fetchRemote({ by, env = process.env, now = Date.now(), dryRun = false, check = true, deps = {} } = {}) {
  if (check) { const who = await remoteRefusal({ by, env }); if (who) return { ok: false, refused: true, why: who, results: [] }; }
  const root = mainRoot();
  const rem = remoteName(env);
  const results = [];
  const swept = dryRun ? [] : await remoteSweep({ root, env, now });
  const fetched = deps.fetch ? deps.fetch(root, rem) : (() => {
    if (!out(git(root, ['remote'])).split('\n').includes(rem)) return { ok: false, why: `no git remote "${rem}" here (STUDIO_REMOTE_NAME; docs/REMOTE-WORKERS.md)` };
    const r = git(root, ['fetch', '--no-tags', '--prune', rem, `+refs/heads/${BRANCH_PREFIX}*:refs/remotes/${rem}/${BRANCH_PREFIX}*`, `+refs/heads/${mainBranch(root)}:refs/remotes/${rem}/${mainBranch(root)}`], { timeout: num(env.STUDIO_REMOTE_FETCH_TIMEOUT_S, 120) * 1000 });
    if (r.status !== 0) {
      // A remote without the studio's branch yet: fetch the remote/* branches alone.
      const r2 = git(root, ['fetch', '--no-tags', '--prune', rem, `+refs/heads/${BRANCH_PREFIX}*:refs/remotes/${rem}/${BRANCH_PREFIX}*`], { timeout: num(env.STUDIO_REMOTE_FETCH_TIMEOUT_S, 120) * 1000 });
      if (r2.status !== 0) return { ok: false, why: `git fetch ${rem} failed: ${String(r2.stderr || r.stderr || '').trim().split('\n').pop() || `exit ${r2.status}`}` };
    }
    return { ok: true, why: '' };
  })();
  const leases = readLeases(root);
  if (fetched.ok) {
    let trainRunning = null;
    try { trainRunning = (await import('./train-daemon.mjs')).trainLockHeld(root, env, now); } catch {}
    const main = mainBranch(root);
    for (const b of remoteBranches(root, rem)) {
      const L = b.task ? leases[b.task] : null;
      const res = { task: b.task, branch: b.branch };
      if (!L || !ACTIVE.has(L.status) || L.branch !== b.branch) { results.push({ ...res, status: 'ignored', why: !b.task ? 'not a remote/<T-ID>-… branch' : !L ? `${b.task} has no remote lease here` : !ACTIVE.has(L.status) ? `${b.task}'s lease is over (${L.status})` : `${b.task}'s lease is for ${L.branch}` }); continue; }
      const c = checkBranch(root, { ref: b.ref, lease: L, main });
      if (L.fetched?.head === c.head && ['queued', 'refused', 'needs-review'].includes(L.status)) { results.push({ ...res, status: L.status, why: `no new commits since ${String(c.head).slice(0, 8)} (${L.fetched.why || L.status})`, unchanged: true }); continue; }
      const note = (status, why, extra = {}) => { results.push({ ...res, status, why, head: c.head, ...extra }); if (!dryRun) patchLease(root, L.task, { status, fetched: { head: c.head, at: new Date(now).toISOString(), why: String(why).slice(0, 400) }, ...extra }); };
      if (!c.ok) {
        note('refused', c.problems.join('; '));
        if (!dryRun) emitEvent({ type: 'task.remote.refused', agent: L.owner, task: L.task, to: 'producer', status: 'blocked', msg: `${L.task}: ${b.branch} at ${String(c.head || '').slice(0, 8)} not taken in: ${c.problems.join('; ')}`.slice(0, 600), meta: { branch: b.branch, head: c.head || null, problems: c.problems } });
        continue;
      }
      if (c.handback) {
        if (dryRun) { results.push({ ...res, status: 'handback', why: c.handback, head: c.head }); continue; }
        const tm = await import('./task.mjs');
        const r = tm.pauseTask(L.task, L.owner, `handed back by ${L.owner} (remote): ${c.handback} (its work is on ${b.branch} at ${c.head.slice(0, 8)} on ${rem})`);
        note('handed-back', c.handback);
        patchLease(root, L.task, { endedAt: new Date(now).toISOString(), endWhy: `handed back: ${c.handback}` });
        emitEvent({ type: 'task.remote.ended', agent: L.owner, task: L.task, to: 'producer', status: 'warn', msg: `${L.task}: ${L.owner} handed it back: ${c.handback}`.slice(0, 500), meta: { status: 'handed-back', branch: b.branch, head: c.head, paused: Boolean(r && !r.error) } });
        continue;
      }
      if (!c.done) { note('working', `no "Studio-Remote: done" on its last commit yet (${c.commits.length} commit(s))`); continue; }
      if (c.harness.length) {
        note('needs-review', `it changes the harness's own code (${c.harness.slice(0, 4).join(', ')}${c.harness.length > 4 ? ` +${c.harness.length - 4}` : ''}), which runs on this PC as soon as it is queued: a person reads it, then queues it: npm run lane -- create ${L.task} --from ${b.ref.replace(/^refs\/remotes\//, '')} --agent ${laneAgentFor(L.task)}, and in that copy npm run task -- done ${L.task} --agent ${L.owner} --train`);
        if (!dryRun) emitEvent({ type: 'task.remote.review', agent: L.owner, task: L.task, to: 'producer', status: 'blocked', msg: `${L.task}: ${b.branch} changes harness code (${c.harness.slice(0, 4).join(', ')}): read it before it is queued`.slice(0, 500), meta: { branch: b.branch, head: c.head, files: c.harness.slice(0, 20) } });
        continue;
      }
      if (trainRunning) { results.push({ ...res, status: L.status, why: 'a train is running: taken in on the next fetch', head: c.head }); continue; }
      if (dryRun) { results.push({ ...res, status: 'would-queue', why: `${c.commits.length} commit(s), ${c.files.length} file(s), checks pass`, head: c.head }); continue; }
      // The lane copy: a fresh one each time the branch moves (the old one's branch is ours: removed with it).
      const agent = laneAgentFor(L.task);
      const dir = path.join(root, LANES_DIR, agent);
      if (fs.existsSync(dir)) {
        const oldBranch = out(git(dir, ['symbolic-ref', '--short', 'HEAD']));
        removeLaneCopy(agent, { keepBranch: true });
        if (oldBranch && oldBranch.startsWith(`lane/${agent}-`)) git(root, ['branch', '-D', oldBranch]);
      }
      const lc = await (await import('./lane-create.mjs')).laneCreate({ task: L.task, from: [b.ref.replace(/^refs\/remotes\//, '')], agent, by: by || 'remote-fetch', env, root, check: false });
      if (!lc.ok) { note('refused', `no lane copy: ${lc.why}`); continue; }
      // Commits made in the cloud without the studio's hooks: re-stamped through the real hooks here (as a lanes refresh does).
      try {
        const lanes = await import('./lanes.mjs');
        const rf = await lanes.refreshLane(root, { task: L.task, agent, branch: lc.branch, dir: lc.dir }, { by: by || 'remote-fetch', tests: false, busyOk: true, env });
        if (rf.status === 'red' || rf.status === 'conflict') { note('refused', `the lane's stamps or merge: ${rf.why}`); continue; }
      } catch (e) { note('refused', `the lane's stamps couldn't be checked: ${e.message}`); continue; }
      const q = (deps.queue || queueLane)({ root, dir: lc.dir, task: L.task, owner: L.owner, note: `remote worker ${L.owner}: ${b.branch} at ${c.head.slice(0, 8)} (fetched from ${rem})`, env });
      if (!q.ok) {
        note('refused', `task done --train refused it: ${q.text.split('\n').filter(Boolean).slice(-3).join(' / ')}`, { lane: lc.rel });
        emitEvent({ type: 'task.remote.refused', agent: L.owner, task: L.task, to: 'producer', status: 'blocked', msg: `${L.task}: ${b.branch} not queued: ${q.text.split('\n').filter(Boolean).slice(-2).join(' / ')}`.slice(0, 600), meta: { branch: b.branch, head: c.head, lane: lc.rel } });
        continue;
      }
      note('queued', `queued for the train from ${lc.rel} (${c.commits.length} commit(s))${/tier C/i.test(q.text) ? '; tier C: it waits for a release' : ''}`, { lane: lc.rel });
      try { (await import('./lock.mjs')).renewOwner(L.owner, 2 * 3600); } catch {}
      emitEvent({ type: 'task.remote.queued', agent: L.owner, task: L.task, to: 'producer', msg: `${L.task}: ${L.owner}'s ${b.branch} (${c.head.slice(0, 8)}) is checked and queued for the train (${lc.rel})`.slice(0, 500), meta: { branch: b.branch, head: c.head, lane: lc.rel } });
    }
    for (const L of Object.values(leases)) if (ACTIVE.has(L.status) && !results.some((r) => r.task === L.task)) results.push({ task: L.task, branch: L.branch, status: L.status, why: `nothing pushed to ${rem}/${L.branch} yet` });
  }
  const rec = { at: new Date(now).toISOString(), by: by || null, remote: rem, ok: fetched.ok, why: fetched.why || '', results, swept, pid: null };
  if (!dryRun) { try { fs.mkdirSync(REMOTE_DIR(root), { recursive: true }); fs.writeFileSync(FETCH_FILE(root), `${JSON.stringify(rec, null, 2)}\n`); } catch {} }
  return { ok: fetched.ok, fetched, results, swept };
}

// ---- for the Line Producer and the rig budget ---------------------------------------------------------------------------

/** The live leases: [{ task, owner, branch, until, status, queued }]. */
export function activeLeases(root = mainRoot()) {
  return Object.values(readLeases(root)).filter((l) => ACTIVE.has(l.status)).map((l) => ({ task: l.task, owner: l.owner, branch: l.branch, until: l.until, status: l.status, queued: l.status === 'queued' }));
}

/**
 * The Line Producer's remote facts: { on, max, leases, eligible: { id: { ok, why, kind } } } for its ready tasks.
 * tasks: linePlan's rows. Never throws.
 */
export async function remoteFacts({ tasks = [], holds = {}, events = [], env = process.env, root = mainRoot() } = {}) {
  const eligible = {};
  const tests = defaultTests(root);
  let laneOf = null;
  try { laneOf = (await import('./task-hold.mjs')).laneOf; } catch {}
  for (const t of tasks.filter((x) => x.state === 'ready')) {
    const mark = holds[t.id]?.remote || null;
    if (!mark && t.meta?.remote !== true) { eligible[t.id] = { ok: false, why: 'not marked remote-eligible' }; continue; }
    let lane = null;
    try { lane = laneOf ? laneOf(t.id, events, holds) : null; } catch {}
    eligible[t.id] = remoteEligible(t, { meta: t.meta || {}, type: t.type, mark: holds[t.id]?.remote || null, lane, tests });
  }
  let leases = [];
  try { leases = activeLeases(root); } catch {}
  return { on: remoteOn(env), max: remoteMax(env), leases, eligible, remote: remoteName(env) };
}

/**
 * The remote line (pure): offer eligible ready tasks to remote workers when the local builders are at their target.
 * f.remote: remoteFacts; order, target, running: the local plan. Returns { on, max, out, queued, leases, offer, eligible, why }.
 */
export function remotePlan(rm, { order = [], target = 0, running = 0, roleOf = () => 'builder' } = {}) {
  if (!rm) return null;
  const leases = rm.leases || [];
  const out2 = leases.filter((l) => !l.queued).length;
  const queued = leases.filter((l) => l.queued).length;
  const free = Math.max(0, target - running);
  const local = new Set(order.filter((id) => roleOf(id) === 'builder').slice(0, free));
  const candidates = order.filter((id) => rm.eligible?.[id]?.ok && !local.has(id));
  const room = Math.max(0, (rm.max ?? 2) - out2);
  const atTarget = running >= target;
  const offer = rm.on && atTarget ? candidates.slice(0, room).map((id) => ({ task: id, kind: rm.eligible[id].kind, why: rm.eligible[id].why, cmd: `npm run remote -- brief ${id} --worker <name> --by <you>` })) : [];
  const why = !rm.on ? `STUDIO_REMOTE is off: nothing offered${candidates.length ? ` (${candidates.length} eligible)` : ''}` : !atTarget ? `${free} local builder slot(s) free: local first` : !candidates.length ? 'the local builders are at their target and no ready task is remote-eligible (npm run remote -- mark <T-ID>)' : !room ? `${out2} task(s) already out (STUDIO_REMOTE_MAX ${rm.max})` : `the local builders are at their target (${running}/${target}): ${offer.length} task(s) offered to remote workers`;
  return { on: Boolean(rm.on), max: rm.max ?? 2, out: out2, queued, leases, offer, eligible: candidates.length, why, cpu: 0 };
}

/**
 * The Line Producer's half with STUDIO_REMOTE=on: end what ran out, and start a background fetch when one is due (a lease
 * is out and the last fetch is older than STUDIO_REMOTE_FETCH_MIN, and no fetch is running). Never throws.
 */
export async function remotePass({ env = process.env, now = Date.now(), root = mainRoot(), spawnFetch = spawnBackgroundFetch, plan = null } = {}) {
  const res = { swept: [], fetch: null };
  if (!remoteOn(env)) return res;
  try { res.swept = await remoteSweep({ root, env, now }); } catch (e) { res.error = e.message; }
  try {
    const leases = activeLeases(root);
    const last = readJson(FETCH_FILE(root), null);
    const running = last?.pid && alive(last.pid) && now - Date.parse(last.startedAt || last.at || 0) < 30 * 60000;
    const due = leases.some((l) => !l.queued) && !running && (!last?.at || now - Date.parse(last.at) >= fetchEveryMin(env) * 60000);
    if (due) {
      const pid = spawnFetch(root, env);
      try { fs.mkdirSync(REMOTE_DIR(root), { recursive: true }); fs.writeFileSync(FETCH_FILE(root), `${JSON.stringify({ ...(last || {}), pid, startedAt: new Date(now).toISOString(), at: new Date(now).toISOString() }, null, 2)}\n`); } catch {}
      res.fetch = { started: true, pid };
    }
  } catch (e) { res.error = e.message; }
  // The offer, once per change: a remote.offer event (the Communicator and the orchestrator read it).
  try {
    if (plan?.offer) {
      const key = plan.offer.map((o) => o.task).join(',');
      const was = readJson(OFFER_FILE(root), null);
      if (key && was?.key !== key) emitEvent({ type: 'remote.offer', agent: 'line-producer', to: 'producer', msg: `Line Producer: the local builders are at their target; remote-eligible: ${key} (npm run remote -- brief <T-ID> --worker <name> --by <you>)`.slice(0, 500), meta: { offer: plan.offer.map((o) => o.task) } });
      if (was?.key !== key) { fs.mkdirSync(REMOTE_DIR(root), { recursive: true }); fs.writeFileSync(OFFER_FILE(root), `${JSON.stringify({ key, at: new Date(now).toISOString(), offer: plan.offer }, null, 2)}\n`); }
    }
  } catch {}
  return res;
}

/** The background fetch the Line Producer starts: node harness/remote-workers.mjs fetch --by line-producer (windowsHide). */
export function spawnBackgroundFetch(root, env = process.env) {
  const log = path.join(REMOTE_DIR(root), 'fetch.log');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const fd = fs.openSync(log, 'a');
  const child = spawn(process.execPath, [path.join(HERE, 'remote-workers.mjs'), 'fetch', '--by', 'line-producer'], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', fd, fd], env: { ...env, STUDIO_MAIN_ROOT: root, STUDIO_ROLE: '', STUDIO_LOCK_OWNER: 'line-producer' } });
  child.unref();
  try { fs.closeSync(fd); } catch {}
  return child.pid || null;
}

/** For the rig budget: what remote workers hold (0 local CPU until queued). */
export function rigRemote(root = mainRoot()) {
  let leases = [];
  try { leases = activeLeases(root); } catch {}
  const out2 = leases.filter((l) => !l.queued);
  return { out: out2.length, queued: leases.length - out2.length, cpu: 0, tasks: out2.map((l) => l.task), why: out2.length ? `${out2.length} task(s) on remote workers: 0 local CPU until their branch is queued for the train` : 'no task on a remote worker' };
}

// ---- release by hand, status ---------------------------------------------------------------------------------------------

export async function releaseRemote({ task, by, note = '', env = process.env, now = Date.now() } = {}) {
  const who = await remoteRefusal({ by, env });
  if (who) return { ok: false, refused: true, why: who };
  const root = mainRoot();
  const leases = readLeases(root);
  const L = leases[task];
  if (!L || !ACTIVE.has(L.status)) return { ok: false, why: `${task} has no live remote lease` };
  const tm = await import('./task.mjs');
  const r = tm.pauseTask(task, L.owner, `remote lease ended by ${by}${note ? `: ${note}` : ''} (${L.branch} on ${L.remote})`, { force: true });
  leases[task] = { ...L, status: 'released', endedAt: new Date(now).toISOString(), endWhy: `released by ${by}${note ? `: ${note}` : ''}` };
  writeLeases(root, leases);
  try { const th = await import('./task-hold.mjs'); const m = th.readHolds()[task]?.remote; if (m?.lease) { const { lease, ...rest } = m; void lease; th.setHold(task, { remote: Object.keys(rest).length ? rest : null }, { by }); } } catch {}
  emitEvent({ type: 'task.remote.ended', agent: String(by).slice(0, 60), task, to: 'producer', status: 'warn', msg: `${task}: the remote lease of ${L.owner} was ended by ${by}${note ? `: ${note}` : ''}`.slice(0, 500), meta: { status: 'released', owner: L.owner } });
  return { ok: true, task, paused: Boolean(r && !r.error) };
}

export function statusText(root = mainRoot(), env = process.env) {
  const leases = Object.values(readLeases(root));
  const live = leases.filter((l) => ACTIVE.has(l.status));
  const last = readJson(FETCH_FILE(root), null);
  const L = [`Remote workers: STUDIO_REMOTE ${remoteOn(env) ? 'on' : 'off'}, remote ${remoteName(env)}, lease ${leaseHours(env)} h, at most ${remoteMax(env)} out.`];
  L.push(live.length ? 'Live leases:' : 'No live lease.');
  for (const l of live) L.push(`  ${l.task} ${l.owner} ${l.status} until ${String(l.until).slice(0, 16).replace('T', ' ')} UTC, branch ${l.branch}${l.fetched ? `; last fetch ${String(l.fetched.head || '').slice(0, 8)}: ${l.fetched.why}` : ''}`);
  const ended = leases.filter((l) => !ACTIVE.has(l.status)).slice(-5);
  if (ended.length) L.push(`Ended: ${ended.map((l) => `${l.task} ${l.status}`).join(', ')}.`);
  if (last?.at) L.push(`Last fetch: ${String(last.at).slice(0, 16).replace('T', ' ')} ${last.ok === false ? `failed: ${last.why}` : `(${(last.results || []).length} branch(es))`}.`);
  return L.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'status';
  const opt = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
  const many = (k) => argv.flatMap((a, i) => (a === k && argv[i + 1] !== undefined ? [argv[i + 1]] : []));
  const json = argv.includes('--json');
  const by = opt('--by') || '';
  const usage = 'Usage: npm run remote -- status [--json] | mark <T-ID> [--test "<cmd>"]... [--allow <path>]... [--off] --by <name> | brief <T-ID> [--worker <name>] --by <name> [--json] | fetch [--dry-run] [--json] --by <name> | release <T-ID> --by <name> [--note "…"]';
  if (argv.includes('--help') || argv.includes('-h') || !['status', 'mark', 'brief', 'fetch', 'release'].includes(cmd)) { console.log(usage); process.exit(argv.includes('--help') || argv.includes('-h') ? 0 : 2); }
  const task = argv[1] && !argv[1].startsWith('--') ? argv[1] : null;
  let r;
  if (cmd === 'status') { console.log(json ? JSON.stringify({ leases: readLeases(), fetch: readJson(FETCH_FILE(), null), on: remoteOn() }) : statusText()); process.exit(0); }
  if (cmd === 'mark') r = await markRemote({ task, on: !argv.includes('--off'), tests: many('--test'), allow: many('--allow'), by });
  if (cmd === 'brief') r = await briefRemote({ task, worker: opt('--worker') || 'web', by });
  if (cmd === 'release') r = await releaseRemote({ task, by, note: opt('--note') || '' });
  if (cmd === 'fetch') {
    r = await fetchRemote({ by, dryRun: argv.includes('--dry-run') });
    if (!json) {
      if (r.refused) { console.error(r.why); process.exit(2); }
      console.log(r.fetched?.ok === false ? `[remote] fetch failed: ${r.fetched.why}` : `[remote] fetched ${remoteName()}${r.results.length ? '' : ': no remote/* branch and no live lease'}`);
      for (const x of r.results) console.log(`[remote] ${String(x.status).toUpperCase()} ${x.task || '?'} ${x.branch || ''}: ${x.why}`);
      for (const s of r.swept || []) console.log(`[remote] ${s.status.toUpperCase()} ${s.task}: ${s.what}`);
      process.exit(r.ok ? 0 : 1);
    }
  }
  if (json) { const { text, ...rest } = r; console.log(JSON.stringify(cmd === 'brief' ? { ...rest, text } : rest)); process.exit(r.ok ? 0 : r.refused ? 2 : 1); }
  if (!r.ok) { console.error(r.why); process.exit(r.refused ? 2 : 1); }
  if (cmd === 'mark') console.log(r.mark ? `[remote] ${task} marked remote-eligible. ${r.eligible.ok ? `Eligible: ${r.eligible.why}.` : `Not eligible yet: ${r.eligible.why}.`}` : `[remote] ${task}: mark removed.`);
  if (cmd === 'brief') { console.log(r.text); console.log(`[remote] ${task} is claimed by ${r.lease.owner} until ${r.lease.until}; the brief is in ${r.brief}. Give it to the cloud session; npm run remote -- fetch takes its branch in.${r.warn ? `\n[remote] warning: ${r.warn}` : ''}`); }
  if (cmd === 'release') console.log(`[remote] ${task}: lease ended; ${r.paused ? 'the task is back on the board' : 'the task was not in progress'}.`);
  process.exit(0);
}
