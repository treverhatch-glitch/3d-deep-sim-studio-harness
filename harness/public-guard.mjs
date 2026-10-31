#!/usr/bin/env node
/**
 * harness/public-guard.mjs — U-005 (2.51.0): a guard for a PUBLIC game repo, so nothing private leaves the studio.
 *
 *   npm run public-guard -- install <path to a game repo>   copy the guard in, turn its hooks on, add its CI check
 *   npm run public-guard -- check <path to a game repo>     run it now (every tracked file)
 *   npm run public-guard -- status <path to a game repo>    is it installed, current, and are its hooks on?
 *
 * The guard (harness/public-guard/check.mjs, copied to the repo's tools/public-guard/check.mjs) blocks keys and
 * tokens, licence files (Unity_lic.ulf), files and text from this private harness, and files marked private:
 * as a pre-push hook (.githooks/pre-push; Git LFS's hooks are kept working beside it) and in the repo's CI
 * (.github/workflows/public-guard.yml), so a skipped hook is still caught before a merge. Installing again
 * updates the copies to this harness's version. Never copies anything else from the harness.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from './event.mjs';

const SRC = path.join(REPO_ROOT, 'harness', 'public-guard');
const FILES = [
  ['check.mjs', 'tools/public-guard/check.mjs'],
  ['pre-push', '.githooks/pre-push'],
  ['public-guard.yml', '.github/workflows/public-guard.yml'],
];
const LFS_HOOKS = ['post-checkout', 'post-commit', 'post-merge'];
const lfsHook = (h) => `#!/bin/sh\n# Git LFS: kept here because core.hooksPath points at .githooks (the public guard's hooks folder).\ncommand -v git-lfs >/dev/null 2>&1 || exit 0\ngit lfs ${h} "$@"\n`;
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });

export function status(repo) {
  const files = FILES.map(([from, to]) => {
    const dest = path.join(repo, to);
    const have = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;
    return { file: to, present: have !== null, current: have === fs.readFileSync(path.join(SRC, from), 'utf8') };
  });
  const hooks = git(repo, 'config', '--get', 'core.hooksPath').stdout.trim() === '.githooks';
  return { files, hooks, ok: files.every((f) => f.current) && hooks };
}

export function install(repo) {
  if (path.resolve(repo) === path.resolve(REPO_ROOT)) return { ok: false, message: 'that is the harness itself: the guard goes in a public game repo' };
  if (!fs.existsSync(path.join(repo, '.git'))) return { ok: false, message: `${repo} is not a git repo` };
  for (const [from, to] of FILES) {
    const dest = path.join(repo, to);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(SRC, from), dest);
    if (to.startsWith('.githooks/')) fs.chmodSync(dest, 0o755);
  }
  for (const h of LFS_HOOKS) {
    const dest = path.join(repo, '.githooks', h);
    if (!fs.existsSync(dest)) { fs.writeFileSync(dest, lfsHook(h)); fs.chmodSync(dest, 0o755); }
  }
  git(repo, 'config', 'core.hooksPath', '.githooks');
  const gi = path.join(repo, '.gitignore');
  const want = ['Unity_lic.ulf', '*.ulf', '*.alf', '.env', '.env.*'];
  const have = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  const missing = want.filter((w) => !have.split(/\r?\n/).includes(w));
  if (missing.length) fs.appendFileSync(gi, `${have && !have.endsWith('\n') ? '\n' : ''}\n# Never commit licences or keys (tools/public-guard blocks them too)\n${missing.join('\n')}\n`);
  return { ok: true, message: `installed in ${repo}: ${FILES.map(([, to]) => to).join(', ')}; hooks on (core.hooksPath .githooks)${missing.length ? `; .gitignore += ${missing.join(' ')}` : ''}. Commit these files.` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const [cmd, target] = process.argv.slice(2);
  if (!cmd || !target) { console.error('usage: npm run public-guard -- install|check|status <path to a game repo>'); process.exit(2); }
  const repo = path.resolve(process.cwd(), target);
  if (cmd === 'install') {
    const r = install(repo);
    console[r.ok ? 'log' : 'error'](`[public-guard] ${r.ok ? '' : 'FAIL '}${r.message}`);
    process.exit(r.ok ? 0 : 1);
  }
  if (cmd === 'status') {
    const s = status(repo);
    for (const f of s.files) console.log(`[public-guard] ${f.file}: ${!f.present ? 'missing' : f.current ? 'current' : 'out of date (install again)'}`);
    console.log(`[public-guard] hooks ${s.hooks ? 'on' : 'off (git config core.hooksPath .githooks)'}`);
    process.exit(s.ok ? 0 : 1);
  }
  if (cmd === 'check') {
    const g = path.join(repo, 'tools', 'public-guard', 'check.mjs');
    const r = spawnSync(process.execPath, [fs.existsSync(g) ? g : path.join(SRC, 'check.mjs')], { cwd: repo, stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }
  console.error('usage: npm run public-guard -- install|check|status <path to a game repo>');
  process.exit(2);
}
