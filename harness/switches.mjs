/**
 * harness/switches.mjs — which rule systems are switched ON in the engine (studio/game.json engines.<x>.switches).
 * { "files": "<glob>", "name": "<regex, group 1 = the name>", "on": "<regex that matches when on>", "total": 64,
 *   "task": "<regex with {name}>" }. Read from the engine target with git (ls-tree, cat-file): nothing is checked out.
 *   readSwitches   { on, off: [{ name, task }], missing, total } or { bad } or null (unset)
 *   switchesLines  "Systems ON: 16 of 64" for each engine that sets it (score, brief, studio:status)
 *   npm run engine -- switches [--engine <x>] [--json]   the systems still off, each with the open task that switches it
 * Unset: no line and nothing read. A bad setting is one plain line, never a throw.
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from './event.mjs';
import { flagOf } from './helpers.mjs';
import { enginesConfig } from './engine-tracks.mjs';
import { globRe } from './merge-lane.mjs';

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const git = (repo, args, input) => spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: repo, windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...(input !== undefined ? { input } : {}) });

/** engines.<x>.switches checked: { files, name, on, total, task } (compiled), { bad: why }, or null when unset. */
export function switchesConfig(engine, { root = REPO_ROOT } = {}) {
  const s = enginesConfig(root)[engine]?.switches;
  if (s === undefined || s === null || s === false) return null;
  const where = `engines.${engine}.switches`;
  if (typeof s !== 'object' || Array.isArray(s)) return { bad: `${where} is not an object like { "files", "name", "on" }` };
  for (const k of ['files', 'name', 'on']) if (typeof s[k] !== 'string' || !s[k].trim()) return { bad: `${where}.${k} is missing: it must be a text` };
  const re = (k, src, flags) => { try { return { re: new RegExp(src, flags) }; } catch (err) { return { bad: `${where}.${k} is not a valid regex (${String(err.message).slice(0, 80)})` }; } };
  const name = re('name', s.name, 'm');
  if (name.bad) return name;
  const on = re('on', s.on, 'm');
  if (on.bad) return on;
  if (s.task !== undefined && (typeof s.task !== 'string' || !s.task.includes('{name}'))) return { bad: `${where}.task must be a regex with {name} in it` };
  const task = s.task ? re('task', s.task.split('{name}').join('x'), 'i') : {};
  if (task.bad) return task;
  if (s.total !== undefined && !(Number.isInteger(Number(s.total)) && Number(s.total) >= 0)) return { bad: `${where}.total must be a whole number` };
  return { files: s.files.trim(), name: name.re, on: on.re, total: Number(s.total) || 0, task: s.task || null };
}

/** The engine repo and the ref the switches are read at: the target in the gate worktree, else the engine's cwd. */
function repoOf(engine, root) {
  const cfg = enginesConfig(root)[engine] || {};
  for (const d of [cfg.gateWorktree, cfg.cwd]) {
    if (typeof d !== 'string' || !d.trim()) continue;
    const abs = path.resolve(root, d);
    if (git(abs, ['rev-parse', '--git-dir']).status === 0) return { repo: abs, ref: typeof cfg.target === 'string' && cfg.target ? `refs/heads/${cfg.target}` : 'HEAD' };
  }
  return null;
}

/** The open task that switches `name`: the studio's regex, else a title with the word "switch" and the name as a whole word. */
export function switchTaskOf(name, open = [], taskRe = null) {
  const re = taskRe ? new RegExp(taskRe.split('{name}').join(esc(name)), 'i') : null;
  const word = new RegExp(`(^|[^A-Za-z0-9_])${esc(name)}($|[^A-Za-z0-9_])`, 'i');
  const t = open.find((x) => (re ? re.test(x.title) : /\bswitch(es|ed|ing)?\b/i.test(x.title) && word.test(x.title)));
  return t ? { id: t.id, title: t.title } : null;
}

/** The board's open tasks [{ id, title }] ([] when it cannot be read). */
async function openTasks() {
  try { const q = (await import('./task.mjs')).parseNextQueue(); return [...q.inProgress, ...q.backlog].map((t) => ({ id: t.id, title: String(t.title || '') })); } catch { return []; }
}

/**
 * The switches of one engine: null (unset), { engine, bad } or { engine, on: [names], off: [{ name, task }], missing, total,
 * files, sha }. total: the larger of the planned number and the systems found; missing: systems with no file yet.
 */
export async function readSwitches(engine, { root = REPO_ROOT, tasks = null } = {}) {
  const c = switchesConfig(engine, { root });
  if (!c) return null;
  if (c.bad) return { engine, bad: c.bad };
  const at = repoOf(engine, root);
  if (!at) return { engine, bad: `engines.${engine}.switches: the engine repo was not found (engines.${engine}.gateWorktree or cwd)` };
  const sha = String(git(at.repo, ['rev-parse', '--verify', '--quiet', `${at.ref}^{commit}`]).stdout || '').trim();
  if (!sha) return { engine, bad: `engines.${engine}.switches: ${at.ref.replace('refs/heads/', '')} was not found in ${at.repo}` };
  const re = globRe(c.files);
  const files = String(git(at.repo, ['ls-tree', '-r', '-z', '--name-only', sha]).stdout || '').split('\0').filter((f) => f && re.test(f));
  const byName = new Map();
  if (files.length) {
    // One cat-file for every file: "<sha> blob <size>\n<content>\n" each, in order.
    const buf = git(at.repo, ['cat-file', '--batch'], files.map((f) => `${sha}:${f}`).join('\n') + '\n').stdout || Buffer.alloc(0);
    let p = 0;
    for (const f of files) {
      const nl = buf.indexOf(10, p);
      if (nl < 0) break;
      const size = Number(String(buf.subarray(p, nl)).split(' ')[2]);
      const text = Number.isFinite(size) ? buf.subarray(nl + 1, nl + 1 + size).toString('utf8') : '';
      p = Number.isFinite(size) ? nl + 1 + size + 1 : nl + 1;
      // A file with no name line counts under its own file name.
      const name = (c.name.exec(text)?.[1] || path.posix.basename(f).replace(/\.[^.]+$/, '')).trim();
      if (name && !byName.has(name)) byName.set(name, c.on.test(text));
    }
  }
  const open = tasks || await openTasks();
  const names = [...byName.keys()].sort((a, b) => a.localeCompare(b));
  const on = names.filter((n) => byName.get(n));
  const off = names.filter((n) => !byName.get(n)).map((name) => ({ name, task: switchTaskOf(name, open, c.task) }));
  const total = Math.max(c.total, names.length);
  return { engine, on, off, missing: total - names.length, total, files: files.length, sha };
}

/** "Systems ON: 16 of 64", or the bad setting in plain words. */
export const switchesLine = (r, { many = false } = {}) => (!r ? '' : r.bad ? `Systems ON: not read (${r.bad})` : `Systems ON: ${r.on.length} of ${r.total}${many ? ` (${r.engine})` : ''}`);

/** Every engine that sets switches: [{ engine, r }]. */
export async function readAllSwitches({ root = REPO_ROOT } = {}) {
  const out = [];
  let tasks = null;
  for (const engine of Object.keys(enginesConfig(root)).sort()) {
    if (!switchesConfig(engine, { root })) continue;
    tasks = tasks || await openTasks();
    out.push(await readSwitches(engine, { root, tasks }));
  }
  return out;
}

/** The status lines ([] when no engine sets switches). Never throws. */
export async function switchesLines({ root = REPO_ROOT } = {}) {
  try { const all = await readAllSwitches({ root }); return all.map((r) => switchesLine(r, { many: all.length > 1 })); } catch { return []; }
}

/** The systems still off, for npm run engine -- switches. */
export function switchesText(r) {
  if (r.bad) return switchesLine(r);
  const L = [`${switchesLine(r)} (${r.engine}, at ${r.sha.slice(0, 7)}).`];
  if (r.on.length) L.push(`On: ${r.on.join(', ')}.`);
  for (const o of r.off) L.push(`  off: ${o.name}${o.task ? ` (${o.task.id}: ${o.task.title.slice(0, 100)})` : ' (no open task switches it)'}`);
  if (r.missing) L.push(`Not in the engine yet: ${r.missing} system(s) of the planned ${r.total}.`);
  return L.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const want = flagOf(argv)('engine');
  const all = (await readAllSwitches()).filter((r) => !want || r.engine === want);
  console.log(argv.includes('--json') ? JSON.stringify(all) : all.length ? all.map(switchesText).join('\n\n') : `No engine${want ? ` named ${want}` : ''} sets switches: add engines.<x>.switches to studio/game.json (docs/NATIVE-ENGINE.md).`);
}
