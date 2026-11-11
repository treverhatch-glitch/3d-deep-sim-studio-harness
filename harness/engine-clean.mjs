#!/usr/bin/env node
/**
 * harness/engine-clean.mjs — 2.83 (h): the disk an engine's work leaves behind.
 *
 * Why (a crew's PC, 2.83): engine work happens in git worktrees of a separate engine repo at <studio>/.lanes/engine/<task>
 * (about 3.2 GB each). After a lane's branch landed on the engine's target branch the worktree stayed for ever, and every
 * engine landing wrote a ~1.6 GB player build into a builds folder (gate-<stamp>/); 25 piled up (43 GB) and the disk fell
 * to 62 GB. `npm run lanes -- prune` did not look at .lanes/engine.
 *
 *   removeLandedLane   one lane folder, removed only when it is clean and its commit is already on the target
 *   pruneEngineLanes   every folder under .lanes/engine/ by the same rule (wired into `npm run lanes -- prune`)
 *   pruneBuilds        keep the newest N build folders of a builds folder, remove the rest, write LATEST.txt
 *   buildsConfig       studio/game.json engines.<x>.builds { dir, keep, pattern } (the owner's); STUDIO_ENGINE_KEEP_BUILDS
 *
 * Nothing here deletes by hand except old build folders (fs.rmSync after the safety rules); a lane goes only through
 * `git worktree remove` (never --force), so git itself refuses a folder with work in it.
 *
 *   node harness/engine-clean.mjs lanes [--engine x] [--dry-run]
 *   node harness/engine-clean.mjs builds [--engine x] [--dry-run]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent } from './event.mjs';
import { engineRepo, engineTarget, engineTargets, samePath } from './engine-tracks.mjs';
import { readJson } from './fsafe.mjs';

const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120000 });
const fwd = (p) => String(p).split(path.sep).join('/');
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const say = (log, m) => { try { (log || (() => {}))(m); } catch {} };

/** The worktrees git lists for `repo`: [{ dir, head, branch }]. null when git can't say. */
function listWorktrees(repo) {
  const r = git(repo, 'worktree', 'list', '--porcelain');
  if (r.status !== 0) return null;
  const out = []; let cur = null;
  for (const l of String(r.stdout || '').split(/\r?\n/)) {
    if (l.startsWith('worktree ')) { cur = { dir: l.slice(9).trim(), head: null, branch: null }; out.push(cur); }
    else if (cur && l.startsWith('HEAD ')) cur.head = l.slice(5).trim();
    else if (cur && l.startsWith('branch ')) cur.branch = l.slice(7).trim();
  }
  return out;
}

/** The lane folder `dir` as a registered worktree of `repo`, or null. */
export function registeredLane(repo, dir) {
  const all = listWorktrees(repo);
  return all ? all.find((w) => samePath(w.dir, dir)) || null : null;
}

/**
 * Remove <root>/.lanes/engine/<task> when it is a registered worktree of the engine repo, its HEAD is already on the
 * engine's target branch, and nothing in it would be lost. { removed, why, dir, freedMb? }. On any doubt: keep, and say why.
 */
export function removeLandedLane({ root = REPO_ROOT, engine = 'unity', task, log, dryRun = false } = {}) {
  const dir = path.join(root, '.lanes', 'engine', String(task || ''));
  const keep = (why) => ({ removed: false, why, dir });
  if (!/^[A-Za-z0-9._-]+$/.test(String(task || '')) || /^\.+$/.test(String(task))) return keep('not a task folder name');
  if (!fs.existsSync(dir)) return keep('no such folder');
  const repo = engineRepo(engine, { root });
  if (!repo) return keep(`no separate ${engine} repo is configured`);
  const target = engineTarget(engine, { root })?.cfg?.target;
  if (!target || git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${target}`).status !== 0) return keep(`the target branch ${target || '(none)'} was not found in the repo`);
  const wt = registeredLane(repo, dir);
  if (!wt) return keep('not a registered worktree of the engine repo');
  if (samePath(wt.dir, repo)) return keep('this is the engine repo itself');
  const head = git(dir, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}');
  if (head.status !== 0) return keep('its HEAD could not be read');
  const sha = head.stdout.trim();
  const tip = git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${target}^{commit}`).stdout.trim();
  if (git(repo, 'merge-base', '--is-ancestor', sha, target).status !== 0) return keep(`its commit is not on ${target} yet (unlanded work)`);
  // A lane just made from the target has the target's own commit: that is a fresh lane as often as a landed one.
  if (sha === tip) return keep(`its commit is ${target}'s tip itself (a fresh lane, or landed by fast-forward: kept until ${target} moves on)`);
  const st = git(dir, 'status', '--porcelain');
  if (st.status !== 0) return keep('git status failed there');
  const dirty = String(st.stdout || '').split(/\r?\n/).filter(Boolean);
  if (dirty.length) return keep(`it holds ${dirty.length} change(s) or untracked file(s) (${dirty[0].trim().slice(0, 80)})`);
  if (dryRun) return { removed: false, why: `landed on ${target} and clean: would remove`, dir, would: true };
  const rm = git(repo, 'worktree', 'remove', dir);
  if (rm.status !== 0) return keep(`git refused to remove it: ${String(rm.stderr || rm.stdout).trim().split(/\r?\n/)[0].slice(0, 200)}`);
  git(repo, 'worktree', 'prune');
  try { emitEvent({ type: 'engine.lane.removed', agent: 'engine-clean', task, msg: `${task}: its engine lane folder was removed (the commit is on ${target}, nothing unsaved): ${fwd(dir)}`.slice(0, 400), meta: { engine, folder: fwd(dir), target } }); } catch {}
  say(log, `removed ${fwd(dir)}`);
  return { removed: true, why: `landed on ${target}, clean`, dir };
}

/**
 * Every folder under <root>/.lanes/engine/ by the same rule: [{ task, dir, removed, why }]. `skipForeign`: a folder that
 * is not a worktree of THIS engine's repo is left out (many engines share the folder).
 */
export function pruneEngineLanes({ root = REPO_ROOT, engine = 'unity', dryRun = false, log, skipForeign = false } = {}) {
  const base = path.join(root, '.lanes', 'engine');
  let names = [];
  try { names = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { return []; }
  const repo = engineRepo(engine, { root });
  const res = [];
  for (const task of names) {
    const dir = path.join(base, task);
    if (skipForeign && (!repo || !registeredLane(repo, dir))) continue;
    const r = removeLandedLane({ root, engine, task, log, dryRun });
    res.push({ task, dir, removed: r.removed, would: Boolean(r.would), why: r.why });
  }
  return res;
}

// ---- builds ----------------------------------------------------------------------------------------------------------

const globRe = (pat) => new RegExp(`^${String(pat).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);

/**
 * Keep the newest `keep` (min 1) direct child folders of `dir` that match `pattern` (plus the one named `latest`), remove
 * the rest, write <dir>/LATEST.txt. { kept, removed, latestFile } or { kept: [], removed: [], latestFile: null, refused: why }.
 */
export function pruneBuilds({ dir, keep = 3, pattern = 'gate-*', latest = null, root = REPO_ROOT, dryRun = false, log } = {}) {
  const refuse = (why) => { say(log, `builds not pruned: ${why}`); return { kept: [], removed: [], latestFile: null, refused: why }; };
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return refuse('the builds folder is not an absolute path');
  let st; try { st = fs.statSync(dir); } catch { return refuse('the builds folder does not exist'); }
  if (!st.isDirectory()) return refuse('the builds path is not a folder');
  const d = fold(real(dir)).replace(/[\\/]+$/, '');
  if (path.parse(real(dir)).root === real(dir)) return refuse('the builds folder is a filesystem root');
  if (d === fold(real(os.homedir())).replace(/[\\/]+$/, '')) return refuse('the builds folder is the home folder');
  const studio = fold(real(root));
  if (studio === d || studio.startsWith(d + path.sep)) return refuse('the builds folder is the studio root or a parent of it');
  const lit = String(pattern || '').split(/[*?]/)[0];
  if (typeof pattern !== 'string' || lit.length < 3) return refuse('the pattern needs at least 3 literal characters before any wildcard');
  const re = globRe(pattern);
  const items = [];
  for (const e of fs.readdirSync(dir)) {
    if (!re.test(e)) continue;
    const p = path.join(dir, e);
    let l; try { l = fs.lstatSync(p); } catch { continue; }
    if (l.isSymbolicLink() || !l.isDirectory()) continue;
    items.push({ name: e, p, m: l.mtimeMs });
  }
  items.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : b.m - a.m));
  const n = Math.max(1, Math.floor(Number(keep)) || 1);
  const latestName = latest ? path.basename(String(latest)) : null;
  const kept = []; const removed = [];
  items.forEach((it, i) => { (i < n || it.name === latestName ? kept : removed).push(it); });
  const failed = [];
  for (const it of removed) {
    if (dryRun) continue;
    try { fs.rmSync(it.p, { recursive: true, force: true }); } catch (e) { failed.push(it.name); }
    if (fs.existsSync(it.p)) failed.push(it.name);
  }
  const target = latestName && items.some((i) => i.name === latestName) ? path.join(dir, latestName) : kept[0] ? kept[0].p : null;
  const latestFile = target ? path.join(dir, 'LATEST.txt') : null;
  if (latestFile && !dryRun) fs.writeFileSync(latestFile, `${target}\n`);
  const res = { kept: kept.map((i) => i.name), removed: removed.filter((i) => !failed.includes(i.name)).map((i) => i.name), latestFile };
  if (failed.length) res.failed = [...new Set(failed)];
  if (!dryRun) try { emitEvent({ type: 'engine.builds.pruned', agent: 'engine-clean', msg: `builds in ${fwd(dir)}: ${res.kept.length} kept, ${res.removed.length} removed`.slice(0, 400), meta: { dir: fwd(dir), kept: res.kept.length, removed: res.removed.length, pattern } }); } catch {}
  say(log, `builds in ${fwd(dir)}: ${dryRun ? 'would remove' : 'removed'} ${removed.length}, kept ${kept.length}`);
  return res;
}

/** studio/game.json engines.<x>.builds -> { dir, keep, pattern } | null. STUDIO_ENGINE_KEEP_BUILDS overrides keep (0 or "off": no pruning). */
export function buildsConfig(engine, { root = REPO_ROOT, env = process.env } = {}) {
  const b = readJson(path.join(root, 'studio', 'game.json'))?.engines?.[engine]?.builds;
  if (!b || typeof b !== 'object' || typeof b.dir !== 'string' || !b.dir.trim()) return null;
  let keep = Number.isFinite(Number(b.keep)) && Number(b.keep) >= 1 ? Math.floor(Number(b.keep)) : 3;
  const ov = String(env.STUDIO_ENGINE_KEEP_BUILDS ?? '').trim();
  if (ov) {
    if (/^(off|0|false|no)$/i.test(ov)) return null;
    if (Number(ov) >= 1) keep = Math.floor(Number(ov));
  }
  return { dir: path.resolve(root, b.dir), keep, pattern: typeof b.pattern === 'string' && b.pattern ? b.pattern : 'gate-*' };
}

/** The lane folders of every engine the studio names, for `npm run lanes -- prune`: [{ engine, task, dir, removed, would, why }]. */
export function pruneAllEngineLanes({ root = REPO_ROOT, dryRun = false, log } = {}) {
  const out = []; const seen = new Set();
  for (const t of engineTargets({ root })) {
    for (const r of pruneEngineLanes({ root, engine: t.name, dryRun, log, skipForeign: true })) { seen.add(r.task); out.push({ engine: t.name, ...r }); }
  }
  return out;
}

// ---- command line ----------------------------------------------------------------------------------------------------

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const opt = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
  const dry = argv.includes('--dry-run');
  const root = REPO_ROOT;
  const only = opt('--engine');
  const engines = engineTargets({ root }).map((t) => t.name).filter((n) => !only || n === only);
  const cmd = argv[0];
  if (cmd === 'lanes') {
    const rs = only ? pruneEngineLanes({ root, engine: only, dryRun: dry, log: () => {} }).map((r) => ({ engine: only, ...r })) : pruneAllEngineLanes({ root, dryRun: dry });
    for (const r of rs) console.log(`  ${r.removed ? 'removed' : r.would ? 'would remove' : 'kept'} ${fwd(r.dir)}: ${r.why}`);
    if (!rs.length) console.log('no engine lane folders');
  } else if (cmd === 'builds') {
    let any = false;
    for (const e of engines) {
      const c = buildsConfig(e, { root });
      if (!c) continue;
      any = true;
      const r = pruneBuilds({ ...c, root, dryRun: dry, log: (m) => console.log(m) });
      if (r.refused) console.log(`${e}: refused: ${r.refused}`);
      else console.log(`${e}: ${dry ? 'would remove' : 'removed'} ${r.removed.length}, kept ${r.kept.join(', ') || 'none'}`);
    }
    if (!any) console.log('no engines.<x>.builds is set in studio/game.json (or STUDIO_ENGINE_KEEP_BUILDS is off): nothing to prune');
  } else { console.error('Usage: node harness/engine-clean.mjs lanes|builds [--engine <x>] [--dry-run]'); process.exit(2); }
}
