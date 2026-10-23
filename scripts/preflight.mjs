#!/usr/bin/env node
/**
 * scripts/preflight.mjs — is this clone ready for a test run? Checks, and with --fix makes it safe.
 *
 *   npm run preflight                 check only
 *   npm run preflight -- --fix        also: install the hooks, freeze the harness, turn off pushing,
 *                                     make .env from the example with a strong HUB token
 *   npm run preflight -- --quick      skip running the gates
 *
 * A test run builds a game in a clone and leaves the harness itself unchanged, so the results say
 * how the harness does as shipped. --fix makes that hold: the pre-commit hook refuses changes to
 * harness files (.studio/harness-frozen), and `git push` is turned off for this clone so nothing
 * reaches the public repo. Harness problems go in notes (npm run notes -- add --kind bad "...").
 * Undo after the run: delete .studio/harness-frozen; git remote set-url --push origin <url>.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, emitEvent } from '../harness/event.mjs';
import { findPython } from '../qa/run-python.mjs';
import { activeCartridge, isTemplateCartridge } from '../harness/cartridge.mjs';
import { ensureGameId } from '../harness/game-id.mjs';
import { launchableRoles } from '../harness/agent.mjs';
import { effectiveMode, describeMode, readMode, scopeOf, CLAUDE_MD, SCOPES } from '../harness/mode.mjs';
import { cleanQuotaMarks, dailyCap } from '../harness/budget.mjs';
import { readTrack, engineBin } from '../harness/engine.mjs';
import { modelFamily } from '../harness/families.mjs';
import { worktreeSupport, laneCopies, removeLaneCopy, laneLive } from '../harness/worktree.mjs';
import { sessions } from '../harness/agent.mjs';
import { savePatch } from '../harness/wip.mjs';

const argv = process.argv.slice(2);
const FIX = argv.includes('--fix');
const QUICK = argv.includes('--quick');
const rows = [];
const row = (level, label, detail = '') => rows.push({ level, label, detail });
const git = (...a) => spawnSync('git', a, { cwd: REPO_ROOT, encoding: 'utf8' });
const FROZEN = path.join(STUDIO_STATE_DIR, 'harness-frozen');
const ENV = path.join(REPO_ROOT, '.env');

// The files a frozen clone must leave alone (the same list the pre-commit hook guards).
const FROZEN_SUMS = path.join(STUDIO_STATE_DIR, 'harness-frozen.json');
const FROZEN_RE = /^(harness|hub|scripts|tools|\.github)\/|^qa\/[^/]+\.(mjs|py)$|^studio\/gates\.json$|^AGENTS(\.lite)?\.md$|^package\.json$/;
function harnessFiles() {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(REPO_ROOT, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!['node_modules', '.git', '__pycache__'].includes(e.name)) walk(r);
      } else if (e.isFile() && FROZEN_RE.test(r)) out.push(r);
    }
  };
  for (const top of ['harness', 'hub', 'scripts', 'tools', '.github', 'qa']) if (fs.existsSync(path.join(REPO_ROOT, top))) walk(top);
  for (const f of ['studio/gates.json', 'AGENTS.md', 'AGENTS.lite.md', 'package.json']) if (fs.existsSync(path.join(REPO_ROOT, f))) out.push(f);
  return out.sort();
}
export function harnessSums() {
  return Object.fromEntries(harnessFiles().map((f) => [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO_ROOT, f))).digest('hex')]));
}
/** Harness files changed since the freeze: against the fingerprints taken then, or (older freezes) git. */
export function editedHarnessFiles() {
  let sums = null;
  try {
    sums = JSON.parse(fs.readFileSync(FROZEN_SUMS, 'utf8'));
  } catch {
    // frozen before 2.24: ask git instead
  }
  if (sums) {
    const now = harnessSums();
    return [...new Set([...Object.keys(sums), ...Object.keys(now)])].filter((f) => sums[f] !== now[f]).sort();
  }
  const st = git('status', '--porcelain', '--untracked-files=all');
  if (st.status !== 0) return [];
  return st.stdout.split('\n').map((l) => l.slice(3).trim().replace(/^"|"$/g, '')).filter((f) => f && FROZEN_RE.test(f.split(' -> ').pop())).sort();
}

function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.preflight-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe);
    return true;
  } catch {
    return false;
  }
}

export function preflight() {
  // Node
  const [maj, min] = process.versions.node.split('.').map(Number);
  row(maj > 22 || (maj === 22 && min >= 3) ? 'ok' : 'fail', `Node ${process.versions.node}`, maj > 22 || (maj === 22 && min >= 3) ? '' : 'needs 22.3 or newer');

  // A git clone, its branch, and no pushing back to the public repo.
  const inGit = git('rev-parse', '--is-inside-work-tree').stdout.trim() === 'true';
  if (!inGit) row('fail', 'This folder is a git clone', 'clone the repo: git clone <url>');
  else {
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
    const origin = git('remote', 'get-url', 'origin').stdout.trim();
    let push = git('remote', 'get-url', '--push', 'origin').stdout.trim();
    if (origin && push && push === origin && FIX) {
      git('remote', 'set-url', '--push', 'origin', 'DISABLED-during-test-run');
      push = 'DISABLED-during-test-run';
    }
    row('ok', `On branch ${branch}`, origin ? `cloned from ${origin.replace(/\/\/[^@]+@/, '//')}` : 'no origin remote');
    row(!origin || push !== origin ? 'ok' : 'warn', 'Pushing to the public repo is off', !origin || push !== origin ? '' : 'run with --fix (sets the push URL to DISABLED-during-test-run)');
    const hooks = git('config', 'core.hooksPath').stdout.trim();
    if (hooks !== 'scripts/hooks' && FIX) spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'install-hooks.mjs')], { cwd: REPO_ROOT, stdio: 'ignore' });
    const hooksNow = git('config', 'core.hooksPath').stdout.trim() === 'scripts/hooks';
    row(hooksNow ? 'ok' : 'fail', 'Git hooks installed (secrets, locks, purity, frozen harness)', hooksNow ? '' : 'run with --fix, or npm run hooks:install');
    const tracked = git('ls-files', '--error-unmatch', '.env').status === 0;
    row(tracked ? 'fail' : 'ok', '.env is not tracked by git', tracked ? 'git rm --cached .env (it holds keys)' : '');
  }

  // The harness stays as shipped.
  if (FIX && !fs.existsSync(FROZEN)) {
    fs.mkdirSync(STUDIO_STATE_DIR, { recursive: true });
    fs.writeFileSync(FROZEN, `Frozen by npm run preflight -- --fix at ${new Date().toISOString()}. Delete this file to unfreeze.\n`);
    fs.writeFileSync(FROZEN_SUMS, `${JSON.stringify(harnessSums(), null, 2)}\n`);
  }
  row(fs.existsSync(FROZEN) ? 'ok' : 'warn', 'Harness frozen for the run', fs.existsSync(FROZEN) ? '' : 'run with --fix so commits to harness files are refused');
  // Frozen means unedited too, not only uncommitted: Gemini's run loosened two self-tests in qa/selftest.mjs
  // without committing, so the hook never saw it and the results no longer measured the shipped harness.
  if (fs.existsSync(FROZEN)) {
    const all = editedHarnessFiles();
    // New files in harness folders are usually a game's own tools in the wrong place (test #2: art and
    // asset agents wrote tools/art/*.mjs, and the frozen-harness hook then refused the game's commit).
    let sums = {};
    try {
      sums = JSON.parse(fs.readFileSync(FROZEN_SUMS, 'utf8'));
    } catch {
      // older freeze
    }
    const added = all.filter((f) => !(f in sums) && fs.existsSync(path.join(REPO_ROOT, f)));
    const edited = all.filter((f) => !added.includes(f));
    row(edited.length ? 'fail' : 'ok', 'Harness files unedited since the freeze', edited.length ? `${edited.slice(0, 6).join(', ')}${edited.length > 6 ? ` and ${edited.length - 6} more` : ''} changed. Put them back (git checkout -- <file>) and record the problem instead: npm run notes -- add --kind bad "…"` : '');
    if (added.length) {
      const g = activeCartridge().name || '<game>';
      row('fail', 'No new files in harness folders', `${added.slice(0, 6).join(', ')}${added.length > 6 ? ` and ${added.length - 6} more` : ''}: a game's own tools go in game/${g}/tools/ (move them there and fix their paths); harness ideas go in npm run notes`);
    }
  }

  // .env and the HUB token.
  if (!fs.existsSync(ENV) && FIX) {
    const example = fs.readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8');
    fs.writeFileSync(ENV, example.replace(/^HUB_TOKEN=.*$/m, `HUB_TOKEN=${crypto.randomBytes(24).toString('hex')}`));
  }
  const envText = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '';
  const fromFile = (k) => [...envText.matchAll(new RegExp(`^${k}=(.*)$`, 'gm'))].map((m) => m[1].trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).at(-1) || '';
  const envVal = (k) => (process.env[k] || fromFile(k)).trim();
  row(envText ? 'ok' : 'fail', '.env exists', envText ? '' : 'run with --fix (copies .env.example with a fresh HUB token)');
  const token = envVal('HUB_TOKEN');
  row(token.length >= 24 && !/change-me/.test(token) ? 'ok' : 'warn', 'HUB token is strong (War Room buttons work)', token.length >= 24 ? '' : 'npm run setup, or set HUB_TOKEN to 24+ random characters');
  const producer = envVal('STUDIO_PRODUCER_NAME');
  row(producer ? 'ok' : 'warn', `Producer name${producer ? `: ${producer}` : ''}`, producer ? '' : 'set STUDIO_PRODUCER_NAME in .env (the name the Producer agent uses)');

  // Where results and backups go.
  for (const [k, what] of [['STUDIO_BACKUP_DIR', 'Backups folder'], ['STUDIO_RESULTS_DIR', 'Results folder (npm run run-report)']]) {
    const dir = envVal(k);
    if (!dir) row('warn', `${what} not set`, `set ${k} in .env to a synced Google Drive folder`);
    else row(writable(dir) ? 'ok' : 'fail', `${what}: ${dir}`, writable(dir) ? '' : 'not writable: is Google Drive for desktop running and the folder shared with you as an editor?');
  }

  // Keys and the spend cap (names only, never values).
  const keys = [...envText.matchAll(/^([A-Z0-9_]*(?:API_KEY|_TOKEN)(?:_\d+)?)=[ \t]*([^\s]+)/gm)].map((m) => m[1]).filter((k) => k !== 'HUB_TOKEN');
  row('ok', keys.length ? `Router keys set: ${keys.join(', ')}` : 'No router keys set', keys.length ? '' : 'fine when agents run in their own tools (Claude Code, Codex, ...)');
  const cap = dailyCap({ STUDIO_DAILY_TOKEN_CAP: envVal('STUDIO_DAILY_TOKEN_CAP') ?? '' });
  if (keys.length) row(cap > 0 ? 'ok' : 'warn', `Daily token cap: ${cap ? cap.toLocaleString() : 'none'}`, cap ? '' : 'set STUDIO_DAILY_TOKEN_CAP before running with paid keys');

  // The game the gates test, and its ID (made here if it has none: harness/game-id.mjs).
  const game = activeCartridge();
  if (!isTemplateCartridge(game.name)) {
    const ident = ensureGameId(game.name, { by: 'preflight' });
    if (ident) row('ok', `Game ID ${ident.id}`, ident.parent ? `started from ${ident.parent}` : '');
  }
  // A studio set up before new-game wrote studio/game.json picks its game from STUDIO_CARTRIDGE; write
  // the file, so everything that asks "is this studio building a game?" agrees (test #2, FIX 03).
  const gameJson = path.join(REPO_ROOT, 'studio', 'game.json');
  if (!isTemplateCartridge(game.name) && game.name && !fs.existsSync(gameJson)) {
    fs.mkdirSync(path.dirname(gameJson), { recursive: true });
    fs.writeFileSync(gameJson, `${JSON.stringify({ cartridge: game.name, since: new Date().toISOString(), by: 'preflight' }, null, 2)}\n`);
    row('ok', `Wrote studio/game.json for ${game.name}`, `it came from ${game.from || 'STUDIO_CARTRIDGE'}; commit it with the game`);
  }
  // Quota marks: one written by an older harness, or naming another tool's error, isn't trusted (test #2:
  // claude was marked out by agy's 429 under 2.22, and the mark outlived the update).
  const marks = cleanQuotaMarks();
  for (const d of marks.dropped) row('ok', `Cleared a stale quota mark for ${d.tool}`, d.why);
  for (const k of marks.kept) row('warn', `${k.tool} is marked out of quota until ${k.until.slice(0, 16).replace('T', ' ')} UTC`, `the provider said: "${k.line}". Wrong? npm run budget -- probe ${k.tool}`);
  row(isTemplateCartridge(game.name) ? 'warn' : 'ok', `Gates test the game "${game.name || 'none'}" (from ${game.from || 'nowhere'})`, isTemplateCartridge(game.name) ? 'still the template: once your game exists, npm run new-game <name> makes it the active game (studio/game.json)' : '');

  // The engine track, if there is one: its program must be findable (STUDIO_GODOT …, or on the PATH).
  const track = readTrack(game.name);
  if (track) {
    const bin = engineBin(track.engine);
    const has = fs.existsSync(bin) || spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' }).status === 0;
    row(has ? 'ok' : 'warn', `Engine track: ${track.label} in ${track.folder}`, has ? '' : `${bin} isn't found: set ${{ godot: 'STUDIO_GODOT', unity: 'STUDIO_UNITY', unreal: 'STUDIO_UNREAL' }[track.engine] || 'its path'} in .env (npm run engine:gate needs it)`);
  }

  // Pace and who can start on their own.
  const mode = effectiveMode();
  row(mode.chosen ? 'ok' : 'warn', `Pace: ${describeMode(mode)}`, mode.chosen ? '' : 'the game dev picks one at intake, in the Game plan view, or npm run mode -- set <mode> --by <name>');
  const auto = launchableRoles();
  row(auto.length || !mode.autoLaunch ? 'ok' : 'warn', auto.length ? `Agents that can start on their own: ${auto.join(', ')}` : 'No agent can start on its own', auto.length ? '' : mode.autoLaunch ? 'this pace starts agents automatically: set STUDIO_AGENT_TOOL and STUDIO_AGENT_MODEL (or per role, STUDIO_BUILDER_TOOL …) in .env' : 'fine: start agents by hand, from the War Room, or npm run agent -- start');

  // Tools.
  const py = findPython();
  row(py ? 'ok' : 'fail', `Python 3${py ? ` (${py.cmd})` : ''}`, py ? '' : 'install Python 3 (Windows: tick "Add python.exe to PATH")');
  row(fs.existsSync(path.join(REPO_ROOT, 'node_modules')) ? 'ok' : 'fail', 'npm install has been run', fs.existsSync(path.join(REPO_ROOT, 'node_modules')) ? '' : 'npm install');
  // A lock whose version lags package.json is rewritten by the next npm install and then shows up as a
  // changed file in every agent's hand-back. --fix sets the two version fields only (no dependency change).
  try {
    const pkgV = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
    const lockFile = path.join(REPO_ROOT, 'package-lock.json');
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    const lockFixed = lock.version !== pkgV && FIX;
    if (lockFixed) {
      lock.version = pkgV;
      if (lock.packages?.['']) lock.packages[''].version = pkgV;
      fs.writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
    }
    const lockV = JSON.parse(fs.readFileSync(lockFile, 'utf8')).version;
    row(lockV === pkgV ? 'ok' : 'warn', lockV === pkgV ? 'package-lock.json matches package.json' : `package-lock.json says ${lockV}, package.json ${pkgV}`, lockV === pkgV ? (lockFixed ? 'fixed; commit package-lock.json' : '') : 'npm run preflight -- --fix sets it, then commit package-lock.json');
  } catch {}
  // Scope: what Claude Code auto-loads (CLAUDE.md) follows the studio's scope. The release ships the Lite
  // CLAUDE.md for fresh clones; a studio that builds a game is Full unless someone chose Lite.
  try {
    const scope = scopeOf(readMode());
    const cm = path.join(REPO_ROOT, 'CLAUDE.md');
    const now = fs.existsSync(cm) ? fs.readFileSync(cm, 'utf8').replace(/\r\n/g, '\n') : '';
    const want = CLAUDE_MD[scope];
    const matches = now.trim() === want.trim() || (scope === 'full' && /@AGENTS\.md/.test(now)) || (scope === 'lite' && /@AGENTS\.lite\.md/.test(now) && !/@AGENTS\.md/.test(now));
    if (!matches && FIX) fs.writeFileSync(cm, want);
    row(matches || FIX ? 'ok' : 'warn', `Scope: ${SCOPES[scope]}${!matches && FIX ? ' (CLAUDE.md updated to match; commit it)' : ''}`, matches || FIX ? '' : `CLAUDE.md doesn't load ${scope === 'lite' ? 'AGENTS.lite.md' : 'AGENTS.md'}: npm run preflight -- --fix`);
  } catch {}
  // One working copy per lane (2.29): available here, and no copies left behind by ended sessions.
  try {
    const wt = worktreeSupport();
    row(wt.ok ? 'ok' : 'warn', wt.ok ? 'Agents with a code lane get their own working copy (.lanes/)' : `Agents share one working copy: ${wt.why}`, wt.ok ? '' : 'their unfinished work can leak into each other\'s tests; STUDIO_WORKTREES=off silences this');
    const live = new Set(sessions().filter((x) => x.running).map((x) => x.agent));
    const stale = laneCopies().filter((c) => !live.has(c.agent));
    if (stale.length && FIX) {
      for (const c of stale) {
        if (laneLive(c.agent).live) continue;
        if (c.dirty) savePatch(c.agent, 'lane-copy', [], { cwd: c.dir });
        removeLaneCopy(c.agent, { keepBranch: c.unmerged > 0, ifIdle: true });
      }
    }
    if (stale.length) row(FIX ? 'ok' : 'warn', FIX ? `Removed ${stale.length} lane copy(ies) left by ended sessions (unmerged commits kept on their branches, uncommitted work saved in .studio/wip/)` : `${stale.length} lane copy(ies) left by ended sessions: ${stale.map((c) => c.agent).join(', ')}`, FIX ? '' : 'npm run preflight -- --fix removes them and keeps unmerged commits on their branches');
  } catch {}
  // FIX 06 (test #3): before 2.26 the review fallback could end at the implementer's own family. Such a
  // note, honestly marked as not an approval, then fails the reviewer gate after an update. --fix moves it
  // to studio/reviews/same-family/ and records the cross-family review as owed.
  try {
    const rdir = path.join(REPO_ROOT, 'studio', 'reviews');
    const same = [];
    for (const f of fs.existsSync(rdir) ? fs.readdirSync(rdir).filter((n) => n.endsWith('.md') && n.toLowerCase() !== 'readme.md') : []) {
      const text = fs.readFileSync(path.join(rdir, f), 'utf8');
      const rev = (text.match(/model-family\s*:\s*(\S+)/i) || [])[1];
      const imp = (text.match(/implementer-family\s*:\s*(\S+)/i) || [])[1];
      if (rev && imp && modelFamily(rev) === modelFamily(imp) && /not (?:a |an )?(?:cross-family )?approval|same[- ]family/i.test(text)) same.push({ f, text });
    }
    if (same.length && FIX) {
      // Same shape as harness/review.mjs oweReview (written here directly: preflight stays synchronous).
      const owedFile = path.join(rdir, 'OWED.json');
      let owed = [];
      try {
        owed = JSON.parse(fs.readFileSync(owedFile, 'utf8')).owed || [];
      } catch {}
      fs.mkdirSync(path.join(rdir, 'same-family'), { recursive: true });
      for (const { f, text } of same) {
        fs.writeFileSync(path.join(rdir, 'same-family', f), `> Moved here by preflight: a same-family review is a note, not an approval. The cross-family review is owed (studio/reviews/OWED.json).\n\n${text}`);
        fs.unlinkSync(path.join(rdir, f));
        const task = (f.match(/T-\d+/) || [])[0];
        if (task && !owed.some((o) => o.task === task)) owed.push({ task, at: new Date().toISOString(), why: 'only a same-family review was written (moved to studio/reviews/same-family/)', nextTry: new Date().toISOString() });
      }
      fs.writeFileSync(owedFile, `${JSON.stringify({ owed }, null, 2)}\n`);
    }
    if (same.length) row(FIX ? 'ok' : 'warn', FIX ? `Moved ${same.length} same-family review note(s) to studio/reviews/same-family/; their reviews are owed` : `${same.length} same-family review note(s) in studio/reviews/ (${same.map((x) => x.f).slice(0, 3).join(', ')})`, FIX ? 'commit studio/reviews/' : 'npm run preflight -- --fix moves them and records the reviews as owed');
  } catch {}
  const stopped = fs.existsSync(path.join(STUDIO_STATE_DIR, 'STOP.json'));
  row(stopped ? 'warn' : 'ok', stopped ? 'The studio is stopped' : 'The studio is not stopped', stopped ? 'npm run task -- resume --by <name>' : '');

  // The gates, without the slow self-test.
  if (!QUICK) {
    let ids = [];
    try {
      ids = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'studio', 'gates.json'), 'utf8')).gates.filter((g) => g.required && g.id !== 'selftest').map((g) => g.id);
    } catch {
      ids = [];
    }
    const g = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'run-gates.mjs'), '--only', ids.join(',')], { cwd: REPO_ROOT, encoding: 'utf8' });
    const failedIds = (g.stdout + g.stderr).match(/FAIL[^\n]*/g) || [];
    row(g.status === 0 ? 'ok' : 'fail', `Required gates (${ids.length}, self-test skipped)`, g.status === 0 ? '' : failedIds.slice(0, 3).join(' | '));
  }
  return rows;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const r = preflight();
  const mark = { ok: 'PASS', warn: 'WARN', fail: 'FAIL' };
  for (const x of r) console.log(`[preflight] ${mark[x.level]} ${x.label}${x.detail ? ` — ${x.detail}` : ''}`);
  const fails = r.filter((x) => x.level === 'fail').length;
  const warns = r.filter((x) => x.level === 'warn').length;
  console.log(fails ? `[preflight] NOT READY: ${fails} to fix${warns ? `, ${warns} to check` : ''}.` : `[preflight] READY${warns ? ` (${warns} to check)` : ''}.`);
  emitEvent({ type: 'studio.preflight', agent: 'producer', status: fails ? 'error' : 'ok', msg: `Preflight: ${fails} fail, ${warns} warn${FIX ? ' (with --fix)' : ''}` });
  process.exit(fails ? 1 : 0);
}
