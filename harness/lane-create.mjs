#!/usr/bin/env node
/**
 * harness/lane-create.mjs — 2.77.0 (o): a proper lane copy for a task, from chosen branches, in one command.
 *
 * The crew's orchestrator rebuilt clean lanes by hand with `git worktree add` (a lane for one task carried another
 * task's commits, so it built one off main with only the task's own). A bare worktree's studio/ is the branch's own
 * copy of the board, not main's, so `task done` there said 'Task "T-181" not found'. This makes the copy the way the
 * launcher makes one (harness/worktree.mjs createLaneCopy: studio/ and .studio/ linked to main, node_modules linked,
 * .env copied, the sparse plan of harness/lane-sparse.mjs and its record), then merges the branches given, in order:
 *
 *   npm run lane -- create <T-ID> [--from <branch>...] [--agent <name>] [--by <name>] [--allow-mixed] [--json]
 *
 *   --from     a local branch, a remote-tracking branch (origin/x) or a commit; repeat it, merged in that order (a
 *              merge commit only when it isn't a fast-forward). None given: the task's own unlanded branch is carried
 *              in, as the launcher does (.studio/lane-branches.json).
 *   --agent    the copy's name: .lanes/<agent> (default lane-<t-id>). Work there as that agent:
 *              `npm run task -- start <T-ID> --agent <agent>` from the copy, then `task done` from the copy.
 *   --allow-mixed  take a branch carrying commits of another OPEN task anyway (a Studio-Task trailer naming it, or the
 *              branch recorded as that task's in .studio/lane-branches.json). Without it such a branch is refused:
 *              it would train under the wrong task id (B-92).
 *
 * The lane record: .studio/lanes/<agent>.lane.json { agent, task, dir, branch, from: [{ ref, head }], by, at } and a
 * lane.created event; the task's branch is remembered (.studio/lane-branches.json), so the next agent on the task gets
 * it. A conflict merging a branch aborts the merge and removes the copy (nothing half-made is left); the files are named.
 *
 * Who: a person, a Producer or Director session, or an agent outside the harness (the conductor), as for
 * `npm run lanes -- refresh` (harness/lanes.mjs refreshRefusal); a launched worker session never.
 * Exit: 0 made; 1 refused or failed; 2 bad usage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { emitEvent } from './event.mjs';
import { mainRoot, mainBranch, createLaneCopy, removeLaneCopy, rememberTaskBranch, unmerged, LANES_DIR } from './worktree.mjs';

const TASK_ID = /^[A-Z]+-\d+$/;
const cleanEnv = (extra = {}) => { const e = { ...process.env, ...extra }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|PREFIX|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/.test(k)) delete e[k]; return e; };
const git = (cwd, args, env = {}) => spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanEnv(env), maxBuffer: 64 * 1024 * 1024, windowsHide: true });
const out = (r) => (r.status === 0 ? String(r.stdout || '').trim() : '');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

export const LANE_RECORD = (root, agent) => path.join(root, '.studio', 'lanes', `${agent}.lane.json`);
export const defaultLaneAgent = (task) => `lane-${String(task).toLowerCase()}`;

/** The open task ids on the board (studio/NEXT.md: in progress and waiting). */
export function openTaskIds(root = mainRoot()) {
  let text = '';
  try { text = fs.readFileSync(path.join(root, 'studio', 'NEXT.md'), 'utf8'); } catch { return new Set(); }
  return new Set([...text.matchAll(/^\s*[-*]\s+\[[ >~]\]\s+\*\*([A-Z]+-\d+)\*\*/gm)].map((m) => m[1]));
}

/**
 * The tasks a branch's own commits (base..ref) belong to: { commits: [{ sha, merge, tasks }], tasks: Set }. A commit's
 * tasks are its Studio-Task trailers.
 */
export function branchTasks(root, ref, base) {
  const r = git(root, ['log', '--format=%x1e%H%x09%P%x09%(trailers:key=Studio-Task,valueonly,separator=%x2C)', `${base}..${ref}`]);
  const commits = [];
  for (const rec of String(r.stdout || '').split('\x1e').map((x) => x.trim()).filter(Boolean)) {
    const [sha, parents = '', tr = ''] = rec.split('\t');
    commits.push({ sha, merge: parents.trim().split(/\s+/).filter(Boolean).length > 1, tasks: [...new Set(String(tr).split(/[,\s]+/).map((x) => x.trim()).filter((x) => TASK_ID.test(x)))] });
  }
  return { commits, tasks: new Set(commits.flatMap((c) => c.tasks)), ok: r.status === 0 };
}

/**
 * Does this branch carry another open task's commits? [{ task, how, commits }] (empty: clean). `name` is the branch
 * name as given (for the .studio/lane-branches.json lookup).
 */
export function mixedTasks(root, { task, ref, name = ref, base, open = openTaskIds(root) } = {}) {
  const found = new Map();
  const bt = branchTasks(root, ref, base);
  for (const c of bt.commits) for (const t of c.tasks) if (t !== task && open.has(t)) { if (!found.has(t)) found.set(t, { task: t, how: 'a Studio-Task trailer', commits: [] }); found.get(t).commits.push(c.sha.slice(0, 8)); }
  const b = readJson(path.join(root, '.studio', 'lane-branches.json'), {});
  const short = String(name).replace(/^refs\/heads\//, '');
  for (const [k, v] of Object.entries(b)) {
    const t = k.split(':')[0];
    if (t === task || !TASK_ID.test(t) || !open.has(t) || found.has(t)) continue;
    const names = Array.isArray(v) ? v : [v];
    if (names.includes(short)) found.set(t, { task: t, how: `the branch is recorded as ${t}'s (.studio/lane-branches.json)`, commits: [] });
  }
  return [...found.values()];
}

/** Why this caller may not make lane copies, or ''. The rule of `lanes -- refresh` (harness/lanes.mjs). */
export async function createRefusal({ by, env = process.env } = {}) {
  const { refreshRefusal } = await import('./lanes.mjs');
  return refreshRefusal({ by, env }).replace(/refresh lanes|lanes are refreshed/g, (m) => (m === 'refresh lanes' ? 'make lane copies' : 'lane copies are made'));
}

/**
 * Make the lane copy. Returns { ok, task, agent, dir, rel, branch, from: [{ ref, head }], carried, steps } or
 * { ok: false, why, files? }.
 */
export async function laneCreate({ task, from = [], agent = null, allowMixed = false, by = null, env = process.env, root = mainRoot(), check = true } = {}) {
  const fail = (why, extra = {}) => ({ ok: false, task, agent, why, ...extra });
  if (!TASK_ID.test(String(task || ''))) return fail('give a task id: npm run lane -- create <T-ID> [--from <branch>...]');
  agent = agent || defaultLaneAgent(task);
  if (!/^[A-Za-z0-9][\w.-]{0,60}$/.test(agent)) return fail(`"${agent}" isn't a lane name (letters, digits, . _ -; it can't start with _ or .)`);
  if (check) { const who = await createRefusal({ by, env }); if (who) return fail(who, { refused: true }); }
  const open = openTaskIds(root);
  if (!open.has(task)) return fail(`${task} isn't an open task on the board (studio/NEXT.md): no lane copy made`);
  const dir = path.join(root, LANES_DIR, agent);
  const rel = `${LANES_DIR}/${agent}`;
  if (fs.existsSync(dir)) return fail(`${rel} is already there: pick another --agent, or remove it first (a lane copy with unlanded work keeps its branch)`);
  const main = mainBranch(root);
  // The branches: as given, or the task's own unlanded branch (carried by createLaneCopy, as the launcher does).
  const refs = [];
  for (const f of from) {
    const sha = out(git(root, ['rev-parse', '--verify', '--quiet', `${f}^{commit}`]));
    if (!sha) return fail(`--from ${f}: no such branch or commit here (git fetch it first, or check the name)`);
    refs.push({ ref: f, head: sha });
  }
  const remembered = readJson(path.join(root, '.studio', 'lane-branches.json'), {})[task];
  const carryCandidate = !refs.length && typeof remembered === 'string' && out(git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${remembered}`])) && unmerged(remembered, root) > 0 ? remembered : null;
  for (const r of [...refs, ...(carryCandidate ? [{ ref: carryCandidate }] : [])]) {
    const mixed = mixedTasks(root, { task, ref: r.ref, base: main, open });
    if (mixed.length && !allowMixed) {
      return fail(`${r.ref} carries work of another open task: ${mixed.map((m) => `${m.task} (${m.how}${m.commits.length ? `: ${m.commits.slice(0, 3).join(', ')}${m.commits.length > 3 ? ` +${m.commits.length - 3}` : ''}` : ''})`).join('; ')}. It would train under ${task}'s id. Build the lane from ${task}'s own commits (git branch ${task.toLowerCase()}-only ${main}; git cherry-pick <its commits>; then --from ${task.toLowerCase()}-only), or pass --allow-mixed if they belong together`, { mixed });
    }
  }
  let lane = null;
  try { lane = (await import('./task-hold.mjs')).laneOf(task); } catch { lane = null; }
  const c = createLaneCopy(agent, { task, lane, carry: !refs.length });
  if (c.error) return fail(`the lane copy couldn't be made: ${c.error}`);
  const steps = [];
  const ident = out(git(c.dir, ['config', 'user.email'])) ? [] : ['-c', 'user.name=launcher', '-c', 'user.email=launcher@studio.local'];
  for (const r of refs) {
    const m = git(c.dir, [...ident, 'merge', '--no-edit', '-m', `Merge ${r.ref} into ${c.branch} (lane create for ${task}${by ? ` by ${String(by).slice(0, 40)}` : ''})`, r.head], { STUDIO_MAIN_ROOT: root });
    if (m.status !== 0) {
      const files = out(git(c.dir, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
      git(c.dir, ['merge', '--abort']);
      removeLaneCopy(agent, { keepBranch: true });
      git(root, ['branch', '-D', c.branch]);
      try { emitEvent({ type: 'lane.create_conflict', agent: String(by || 'conductor').slice(0, 60), task, to: 'producer', status: 'blocked', msg: `lane create ${task}: merging ${r.ref} conflicts${files.length ? ` in ${files.join(', ')}` : ''}; nothing made`.slice(0, 500), meta: { from: refs.map((x) => x.ref), files } }); } catch {}
      return fail(`merging ${r.ref} conflicts${files.length ? ` in ${files.join(', ')}` : ` (${String(m.stderr || m.stdout || '').trim().split('\n').pop()})`}: merge aborted and the copy removed; nothing was made. Resolve it on a branch first, or give the branches in another order`, { files });
    }
    steps.push(`merged ${r.ref} (${r.head.slice(0, 8)})`);
  }
  if (refs.length) rememberTaskBranch(task, c.branch);
  const head = out(git(c.dir, ['rev-parse', 'HEAD']));
  const rec = { agent, task, dir: rel, branch: c.branch, head, from: refs, carried: c.carried || null, by: by || null, at: new Date().toISOString(), made: 'lane create' };
  try { fs.mkdirSync(path.dirname(LANE_RECORD(root, agent)), { recursive: true }); fs.writeFileSync(LANE_RECORD(root, agent), `${JSON.stringify(rec, null, 2)}\n`); } catch {}
  try { emitEvent({ type: 'lane.created', agent: String(by || 'conductor').slice(0, 60), task, msg: `lane create ${task}: ${rel} (branch ${c.branch})${refs.length ? ` from ${refs.map((x) => x.ref).join(' + ')}` : c.carried ? `, with ${c.carried} carried in` : ' off main'}`.slice(0, 500), meta: { dir: rel, branch: c.branch, from: refs.map((x) => x.ref), carried: c.carried || null, mixedAllowed: Boolean(allowMixed) } }); } catch {}
  return { ok: true, task, agent, dir: c.dir, rel, branch: c.branch, head, from: refs, carried: c.carried || null, steps, sparse: c.sparse || null };
}

/** The lines the CLI prints. */
export function createText(r, root = mainRoot()) {
  if (!r.ok) return `[lane] not made: ${r.why}`;
  const d = r.dir.replace(/\\/g, '/');
  return [
    `[lane] ${r.task}: ${r.rel} on branch ${r.branch} at ${String(r.head).slice(0, 8)}${r.from.length ? `, from ${r.from.map((x) => `${x.ref} (${x.head.slice(0, 8)})`).join(' + ')}` : r.carried ? `, with ${r.carried} carried in` : ', off the studio\'s branch'}.`,
    '[lane] studio/ and .studio/ in it are the main checkout\'s (links), so the board commands see one board.',
    `[lane] work there as ${r.agent}: cd ${JSON.stringify(d)}; npm run task -- start ${r.task} --agent ${r.agent}; … ; npm run task -- done ${r.task} --agent ${r.agent} --train`,
    `[lane] the main checkout is ${JSON.stringify(root.replace(/\\/g, '/'))} (STUDIO_MAIN_ROOT; a copy under .lanes/ finds it by itself).`,
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const usage = 'Usage: npm run lane -- create <T-ID> [--from <branch>...] [--agent <name>] [--by <name>] [--allow-mixed] [--json]';
  if (argv.includes('--help') || argv.includes('-h') || argv[0] !== 'create') { console.log(usage); process.exit(argv[0] === 'create' || argv.includes('--help') || argv.includes('-h') ? 0 : 2); }
  const vals = new Set(['--from', '--agent', '--by']);
  const from = argv.flatMap((a, i) => (a === '--from' && argv[i + 1] ? [argv[i + 1]] : []));
  const opt = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
  const task = argv.slice(1).find((a, i, all) => !a.startsWith('--') && !vals.has(all[i - 1]));
  if (!task) { console.error(usage); process.exit(2); }
  const r = await laneCreate({ task, from, agent: opt('--agent'), allowMixed: argv.includes('--allow-mixed'), by: opt('--by') || process.env.STUDIO_LOCK_OWNER || 'conductor' });
  console.log(argv.includes('--json') ? JSON.stringify(r) : createText(r));
  process.exit(r.ok ? 0 : 1);
}
