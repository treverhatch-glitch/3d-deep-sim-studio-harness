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

const argv = process.argv.slice(2);
const FIX = argv.includes('--fix');
const QUICK = argv.includes('--quick');
const rows = [];
const row = (level, label, detail = '') => rows.push({ level, label, detail });
const git = (...a) => spawnSync('git', a, { cwd: REPO_ROOT, encoding: 'utf8' });
const FROZEN = path.join(STUDIO_STATE_DIR, 'harness-frozen');
const ENV = path.join(REPO_ROOT, '.env');

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
  }
  row(fs.existsSync(FROZEN) ? 'ok' : 'warn', 'Harness frozen for the run', fs.existsSync(FROZEN) ? '' : 'run with --fix so commits to harness files are refused');

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
  const cap = Number(envVal('STUDIO_DAILY_TOKEN_CAP') || 0);
  if (keys.length) row(cap > 0 ? 'ok' : 'warn', `Daily token cap: ${cap ? cap.toLocaleString() : 'none'}`, cap ? '' : 'set STUDIO_DAILY_TOKEN_CAP before running with paid keys');

  // Tools.
  const py = findPython();
  row(py ? 'ok' : 'fail', `Python 3${py ? ` (${py.cmd})` : ''}`, py ? '' : 'install Python 3 (Windows: tick "Add python.exe to PATH")');
  row(fs.existsSync(path.join(REPO_ROOT, 'node_modules')) ? 'ok' : 'fail', 'npm install has been run', fs.existsSync(path.join(REPO_ROOT, 'node_modules')) ? '' : 'npm install');
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
