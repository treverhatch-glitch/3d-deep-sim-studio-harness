#!/usr/bin/env node
/**
 * harness/experiment.mjs — try something in the game, then keep it or take it back out.
 *
 *   npm run experiment -- start "<what>" [--idea I-001] [--by <name>]   open X-001
 *   npm run experiment -- task X-001 "<title>" [--role builder]           queue work inside it
 *   npm run experiment -- show X-001                                      its commits and files
 *   npm run experiment -- keep X-001 --by <name>                          it stays in the game
 *   npm run experiment -- drop X-001 --by <name> [--only <path,path>]     take it (or parts) back out
 *   npm run experiment -- list
 *
 * Every commit made for an experiment carries a `Studio-Experiment: X-001` trailer: the commit-msg
 * hook adds it for work on the experiment's tasks, or when STUDIO_EXPERIMENT=X-001 is set. That is
 * how `drop` finds exactly what to remove, even after other work landed on top. Dropping makes new
 * commits that undo the experiment's changes (history is kept, nothing is force-pushed), so it is
 * safe while other agents share the checkout. `--only` undoes just the named files or folders.
 *
 * Inside the game, keep a prototype behind a switch in the cartridge's TUNING table
 * (`experiments: { X001: true }`) so it can be played or turned off without touching the main path.
 * Records live in studio/experiments/X-001.json and show in the War Room's Game plan view.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent } from './event.mjs';
import { addTask } from './task.mjs';
import { readIdea } from './bible.mjs';

export const EXP_DIR = path.join(REPO_ROOT, 'studio', 'experiments');
const now = () => new Date().toISOString();
const git = (args, input) => spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });

export function readExperiments() {
  if (!fs.existsSync(EXP_DIR)) return [];
  return fs.readdirSync(EXP_DIR).filter((f) => /^X-\d+\.json$/.test(f)).sort().map((f) => JSON.parse(fs.readFileSync(path.join(EXP_DIR, f), 'utf8')));
}
const readExp = (id) => readExperiments().find((x) => x.id === id) || null;
function writeExp(x) {
  fs.mkdirSync(EXP_DIR, { recursive: true });
  x.updatedAt = now();
  fs.writeFileSync(path.join(EXP_DIR, `${x.id}.json`), `${JSON.stringify(x, null, 2)}\n`);
  return x;
}

/** Commits tagged with this experiment, oldest first, with the files each touched. */
export function experimentCommits(id) {
  const r = git(['log', '--reverse', `--format=%x1e%H%x09%s%x09%(trailers:key=Studio-Experiment,valueonly,separator=%x2C)`, '--name-only']);
  if (r.status !== 0) return [];
  return r.stdout.split('\x1e').slice(1).map((block) => {
    const [head, ...names] = block.trim().split('\n');
    const [hash, subject, exps] = head.split('\t');
    return { hash, subject, exps: (exps || '').split(',').map((s) => s.trim()).filter(Boolean), files: names.filter(Boolean) };
  }).filter((c) => c.exps.includes(id));
}

export function startExperiment({ title, idea = null, by = process.env.STUDIO_LOCK_OWNER || 'game-dev' }) {
  if (!String(title || '').trim()) return { ok: false, message: 'Say what the experiment tries: experiment start "<what>".' };
  if (idea && !readIdea(idea)) return { ok: false, message: `No idea ${idea}.` };
  const n = readExperiments().reduce((m, x) => Math.max(m, Number(x.id.slice(2))), 0) + 1;
  const id = `X-${String(n).padStart(3, '0')}`;
  const head = git(['rev-parse', '--short', 'HEAD']).stdout.trim() || null;
  const x = writeExp({ id, title: String(title).trim().slice(0, 160), idea, by, status: 'open', startedAt: now(), base: head, flag: `${id.replace('-', '')}`, tasks: [], history: [{ status: 'open', at: now(), by }] });
  emitEvent({ type: 'experiment.start', agent: by, to: 'producer', msg: `${id} started: ${x.title}` });
  return { ok: true, experiment: x };
}

export function experimentTask(id, { title, role = 'builder', by = process.env.STUDIO_LOCK_OWNER || 'producer' }) {
  const x = readExp(id);
  if (!x || x.status !== 'open') return { ok: false, message: `${id} isn't an open experiment.` };
  const t = addTask({ title: `Prototype (${id}): ${title}`.slice(0, 180), role, priority: 'P2', agent: by, meta: { experiment: id, prototype: true } });
  if (t.error) return { ok: false, message: t.message };
  x.tasks.push(t.id);
  writeExp(x);
  return { ok: true, task: t.id };
}

export function keepExperiment(id, by) {
  const x = readExp(id);
  if (!x || x.status !== 'open') return { ok: false, message: `${id} isn't an open experiment.` };
  if (!by) return { ok: false, message: 'Say who decided: --by <name>.' };
  x.status = 'kept';
  x.history.push({ status: 'kept', at: now(), by });
  writeExp(x);
  emitEvent({ type: 'experiment.kept', agent: by, to: 'producer', msg: `${id} kept by ${by}: ${x.title}. Remove its TUNING switch when it's part of the game for good.` });
  return { ok: true };
}

/** Undo the experiment's commits (newest first), all of them or only some paths, as new commits. */
export function dropExperiment(id, { by, only = null }) {
  const x = readExp(id);
  if (!x || !['open', 'kept'].includes(x.status)) return { ok: false, message: `${id} can't be dropped (it is ${x?.status || 'missing'}).` };
  if (!by) return { ok: false, message: 'Say who decided: --by <name>.' };
  const commits = experimentCommits(id);
  if (!commits.length) return { ok: false, message: `No commits carry "Studio-Experiment: ${id}". Nothing to take out (work on it with STUDIO_EXPERIMENT=${id} or through its tasks).` };
  const paths = only ? only.split(',').map((p) => p.trim().replace(/\\/g, '/').replace(/\/$/, '')).filter(Boolean) : null;
  // Parts already taken out by an earlier --only drop are skipped.
  const undone = x.undone || {};
  // The studio's own records (studio/, .studio/) aren't part of the experiment, even if committed with it.
  const todo = (c) => c.files.filter((f) => !/^\.?studio\//.test(f) && (!paths || paths.some((p) => f === p || f.startsWith(`${p}/`))) && !(undone[c.hash] || []).includes(f));
  const files = [...new Set(commits.flatMap(todo))];
  if (!files.length && !paths && Object.keys(undone).length) {
    x.status = 'dropped';
    x.history.push({ status: 'dropped', at: now(), by, files: [] });
    writeExp(x);
    return { ok: true, files: [], commits: commits.length };
  }
  if (!files.length) return { ok: false, message: paths ? `The experiment didn't change ${paths.join(', ')} (or that part is already out).` : 'Nothing to undo.' };
  // Only the experiment's own files need to be clean; other agents can keep working elsewhere.
  const dirty = git(['status', '--porcelain', '--', ...files]).stdout.trim();
  if (dirty) return { ok: false, message: `Commit or set aside the uncommitted changes in ${files.join(', ')} first, so the undo only contains the experiment.` };
  const applied = [];
  for (const c of commits.slice().reverse()) {
    const mine = todo(c);
    if (!mine.length) continue;
    const patch = git(['diff', '--binary', c.hash, `${c.hash}^`, '--', ...mine]).stdout;
    if (!patch.trim()) continue;
    const r = git(['apply'], patch);
    if (r.status !== 0) {
      // git apply is all or nothing per patch: roll back the ones already applied, newest first.
      for (const p of applied.reverse()) git(['apply', '-R'], p);
      return { ok: false, message: `Couldn't undo ${c.hash.slice(0, 7)} (${c.subject}) cleanly: later work changed the same lines. Nothing was changed. Undo that part by hand, or drop the rest with --only.\n${r.stderr.trim()}` };
    }
    applied.push(patch);
    undone[c.hash] = [...new Set([...(undone[c.hash] || []), ...mine])];
  }
  git(['add', '-A', '--', ...files]);
  // 2.58.2 (PU-29): committed without the hooks, so it says so (Studio-Harness), and the hooks gate lets it through.
  const msg = `Drop ${id}${paths ? ` (only ${paths.join(', ')})` : ''}: ${x.title}\n\nStudio-Experiment-Drop: ${id}\nStudio-Harness: experiment-drop`;
  const commit = spawnSync('git', ['-c', `user.name=${by}`, '-c', 'user.email=studio@localhost', 'commit', '-q', '--no-verify', '-m', msg, '--', ...files], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (commit.status !== 0) return { ok: false, message: commit.stderr || 'git commit failed' };
  x.undone = undone;
  if (!paths) x.status = 'dropped';
  x.history.push({ status: paths ? 'partly dropped' : 'dropped', at: now(), by, files });
  writeExp(x);
  emitEvent({ type: 'experiment.dropped', agent: by, to: 'producer', msg: `${id} ${paths ? `partly dropped (${paths.join(', ')})` : 'dropped'} by ${by}: ${files.length} file(s) restored. If a golden hash changed, run npm run golden -- --update and commit it.` });
  return { ok: true, files, commits: commits.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) i++;
    } else pos.push(argv[i]);
  }
  const [cmd = 'list', a1, ...rest] = pos;
  const who = flag('by') || process.env.STUDIO_LOCK_OWNER;
  const fail = (m) => {
    console.error(m);
    process.exit(1);
  };
  if (cmd === 'start') {
    const r = startExperiment({ title: [a1, ...rest].join(' '), idea: flag('idea'), by: who || 'game-dev' });
    if (!r.ok) fail(r.message);
    console.log(`${r.experiment.id} started. Work on it through its tasks (npm run experiment -- task ${r.experiment.id} "…") or with STUDIO_EXPERIMENT=${r.experiment.id} set, so every commit is tagged. In the game, put it behind TUNING.experiments.${r.experiment.flag}.`);
  } else if (cmd === 'task') {
    const r = experimentTask(a1, { title: rest.join(' '), role: flag('role') || 'builder', by: who || 'producer' });
    if (!r.ok) fail(r.message);
    console.log(`Queued ${r.task} inside ${a1}.`);
  } else if (cmd === 'keep') {
    const r = keepExperiment(a1, who);
    if (!r.ok) fail(r.message);
    console.log(`${a1} kept.`);
  } else if (cmd === 'drop') {
    const r = dropExperiment(a1, { by: who, only: flag('only') });
    if (!r.ok) fail(r.message);
    console.log(`Took ${a1} out of ${r.files.length} file(s) across ${r.commits} commit(s): ${r.files.join(', ')}. Run npm run verify; if a golden hash changed, npm run golden -- --update and commit it.`);
  } else if (cmd === 'show') {
    const x = readExp(a1);
    if (!x) fail(`No experiment ${a1}`);
    const commits = experimentCommits(a1);
    console.log(JSON.stringify({ ...x, commits: commits.map((c) => ({ commit: c.hash.slice(0, 7), subject: c.subject, files: c.files })) }, null, 2));
  } else {
    const list = readExperiments();
    console.log(list.length ? list.map((x) => `${x.id} [${x.status}] ${x.title}${x.idea ? ` (${x.idea})` : ''}: ${experimentCommits(x.id).length} commit(s)`).join('\n') : 'No experiments yet: npm run experiment -- start "<what>"');
  }
}
