#!/usr/bin/env node
/**
 * harness/restart.mjs — "Throw it all away and restart": the game's code, Bible, board, art and builds
 * go, and the studio starts fresh at the intake. The harness, your roles, departments, budget and pace stay.
 *
 *   npm run studio:restart                         show what would go
 *   npm run studio:restart -- --by <name> --yes --yes   do it (two yeses, like the War Room's two warnings)
 *   [--name "<new game name>"]
 *
 * Nothing is lost for good: before anything is removed, the whole working tree (committed or not) is
 * saved as a git tag, archive/<game>-<time>, without moving your branch. Undo: git checkout <tag> -- .
 * The War Room asks twice (two warnings back to back) and the server needs both: the first press gets
 * a ticket, the second spends it within two minutes.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, emitEvent } from './event.mjs';
import { activeCartridge, isTemplateCartridge, GAME_FILE } from './cartridge.mjs';

const git = (args, env = {}) => spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, ...env } });
const exists = (rel) => fs.existsSync(path.join(REPO_ROOT, rel));
// Studio state that belongs to the game (studio:reset clears the board, Bible, reviews and logs itself).
const GAME_STATE = ['studio/game.json', 'studio/art', 'studio/asks', 'studio/signed', 'studio/proof', 'studio/playtest', 'studio/tricks', 'studio/task-holds.json', 'studio/intake-answers.json', 'studio/assets', 'studio/references', 'studio/experiments'];

function gameName() {
  try {
    const g = JSON.parse(fs.readFileSync(GAME_FILE, 'utf8'));
    return g.name || g.title || g.cartridge || null;
  } catch {
    return null;
  }
}

/** What a restart would remove, without touching anything. */
export function restartPlan() {
  const cart = activeCartridge().name;
  const game = isTemplateCartridge(cart) ? null : cart;
  const folders = game ? [`cartridges/${game}`, `game/${game}`, `web/${game}`].filter(exists) : [];
  const recorded = [];
  for (const dir of ['qa/golden', 'qa/regressions']) {
    if (!exists(dir)) continue;
    for (const f of fs.readdirSync(path.join(REPO_ROOT, dir))) {
      if (!f.endsWith('.json') || /^example-/.test(f)) continue;
      let c = null;
      try {
        c = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, dir, f), 'utf8')).cartridge || null;
      } catch {
        // not a recording
      }
      if (!c || c === game || !isTemplateCartridge(c)) recorded.push(`${dir}/${f}`);
    }
  }
  const assets = exists('assets') ? fs.readdirSync(path.join(REPO_ROOT, 'assets')).filter((f) => f.toLowerCase() !== 'readme.md').map((f) => `assets/${f}`) : [];
  const state = GAME_STATE.filter(exists);
  return { game, title: gameName() || game || 'this studio', folders, recorded, assets, state, builds: exists('.studio/builds') ? ['.studio/builds'] : [] };
}

/** Save the whole working tree as a commit under a tag, without moving the branch or running hooks. */
export function snapshot(label) {
  if (git(['rev-parse', '--is-inside-work-tree']).stdout.trim() !== 'true') return { ok: false, message: 'This folder is not a git clone, so there is nowhere safe to save the game first. Nothing was removed.' };
  const index = path.join(STUDIO_STATE_DIR, `restart-index-${process.pid}`);
  fs.mkdirSync(STUDIO_STATE_DIR, { recursive: true });
  const env = { GIT_INDEX_FILE: index };
  try {
    const head = git(['rev-parse', '--verify', 'HEAD']).stdout.trim();
    if (head) git(['read-tree', head], env);
    const add = git(['add', '-A', '--', '.'], env);
    if (add.status !== 0) return { ok: false, message: `git couldn't save the game: ${add.stderr.trim()}` };
    const tree = git(['write-tree'], env).stdout.trim();
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
    const slug = String(label || 'game').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'game';
    const commit = git(['-c', 'user.name=studio', '-c', 'user.email=studio@localhost', 'commit-tree', tree, ...(head ? ['-p', head] : []), '-m', `Archive of ${label} before "throw it all away and restart"`]).stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) return { ok: false, message: "git couldn't save the game. Nothing was removed." };
    const tag = `archive/${slug}-${stamp}`;
    const t = git(['tag', tag, commit]);
    if (t.status !== 0) return { ok: false, message: `git couldn't tag the save: ${t.stderr.trim()}. Nothing was removed.` };
    return { ok: true, tag, commit };
  } finally {
    fs.rmSync(index, { force: true });
  }
}

// Two presses: the first gets a ticket, the second spends it (within two minutes).
const TICKET = path.join(STUDIO_STATE_DIR, 'restart-ticket.json');
export function restartTicket(by) {
  const t = { id: crypto.randomBytes(8).toString('hex'), by, at: Date.now() };
  fs.mkdirSync(STUDIO_STATE_DIR, { recursive: true });
  fs.writeFileSync(TICKET, JSON.stringify(t));
  return { ...t, plan: restartPlan() };
}
function spendTicket(id) {
  try {
    const t = JSON.parse(fs.readFileSync(TICKET, 'utf8'));
    fs.rmSync(TICKET, { force: true });
    return t.id === id && Date.now() - t.at < 2 * 60000;
  } catch {
    return false;
  }
}

/** Do it. `ticket` (War Room) or `confirmed: 2` (CLI with --yes --yes) is required. */
export async function restartStudio({ by, ticket = null, confirmed = 0, name = null }) {
  if (!by) return { ok: false, message: 'Say who is restarting the studio (--by <name>).' };
  if (!(confirmed >= 2 || (ticket && spendTicket(ticket)))) return { ok: false, message: 'A restart needs two confirmations (the War Room asks twice; on the command line, --yes --yes).' };
  const plan = restartPlan();
  // 1. Stop everything, so nothing writes while the game goes.
  const { setStop, clearStop } = await import('./task.mjs');
  const { stopAllAgents } = await import('./agent.mjs');
  setStop(by, 'throwing it all away and restarting');
  stopAllAgents(by, 'restart');
  fs.writeFileSync(path.join(STUDIO_STATE_DIR, 'supervisor-stop'), new Date().toISOString());
  // 2. Save everything first.
  const snap = snapshot(plan.title);
  if (!snap.ok) {
    clearStop(by);
    return snap;
  }
  // 3. Remove the game.
  const gone = [...plan.folders, ...plan.recorded, ...plan.assets, ...plan.state, ...plan.builds];
  for (const rel of gone) {
    const full = path.join(REPO_ROOT, rel);
    // A studio folder keeps its README (the template ships one); everything else in it goes.
    if (plan.state.includes(rel) && fs.existsSync(full) && fs.statSync(full).isDirectory()) {
      for (const f of fs.readdirSync(full)) if (f.toLowerCase() !== 'readme.md') fs.rmSync(path.join(full, f), { recursive: true, force: true });
    } else fs.rmSync(full, { recursive: true, force: true });
  }
  // 4. A fresh board, Bible and log (studio:reset archives those to .studio/archive/ too).
  const fresh = name || 'New game';
  const reset = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'studio-reset.mjs'), '--name', fresh, '--yes'], { cwd: REPO_ROOT, encoding: 'utf8' });
  // 5. Commit the clean slate so the history shows it, when the hooks allow.
  const specs = ['studio', 'cartridges', 'game', 'web', 'qa/golden', 'qa/regressions', 'assets'].filter((d) => exists(d) || git(['ls-files', '--', d]).stdout.trim());
  git(['add', '-A', '--', ...specs]);
  const c = git(['commit', '-q', '-m', `Restart: threw away ${plan.title} (saved as ${snap.tag})`, '-m', `Studio-Agent: ${by}`]);
  clearStop(by);
  emitEvent({ type: 'studio.restarted', agent: by, to: 'producer', msg: `${by} threw away ${plan.title} and restarted the studio. Saved first as git tag ${snap.tag} (undo: git checkout ${snap.tag} -- .). Next: npm run intake.` });
  return { ok: true, tag: snap.tag, removed: gone.length, title: plan.title, committed: c.status === 0, reset: reset.status === 0, next: `Saved as git tag ${snap.tag}, then removed ${gone.length} game file${gone.length === 1 ? '' : 's'} and folders. The studio starts at the intake: npm run intake. Undo: git checkout ${snap.tag} -- .` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  const yeses = argv.filter((a) => a === '--yes').length;
  const p = restartPlan();
  if (yeses < 2) {
    console.log(`Throw it all away and restart ${p.title}? This would remove:`);
    for (const x of [...p.folders, ...p.recorded, ...p.assets, ...p.state, ...p.builds]) console.log(`  ${x}`);
    console.log('  and the board, Bible, reviews and logs (studio:reset).');
    console.log('Kept: the harness, roles, skills, departments, budget, pace. Everything is saved as a git tag first.');
    console.log('To do it: npm run studio:restart -- --by <name> --yes --yes');
    process.exit(0);
  }
  const r = await restartStudio({ by: flag('by'), confirmed: yeses, name: flag('name') });
  console[r.ok ? 'log' : 'error'](r.ok ? r.next : r.message);
  process.exit(r.ok ? 0 : 1);
}
