#!/usr/bin/env node
/**
 * scripts/release.mjs — the one command to run before you tag, merge or hand off.  `npm run release`
 *
 * 1. Syntax-checks every JS module and Python tool.
 * 2. Runs every required gate (scripts/run-gates.mjs --required-only).
 * 3. Proves the closed loop still records and exits 1 on a failure.
 * 4. Fails if any gate modified a tracked file (gates must be read-only).
 * 5. Checks CHANGELOG.md has an entry for the package.json version.
 * Exit 1 if anything fails.
 */
import { findPython } from '../qa/run-python.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const steps = [];
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: root, encoding: 'utf8', ...opts });
const step = (label, ok, detail = '') => {
  steps.push({ label, ok });
  console.log(`[release] ${ok ? 'PASS' : 'FAIL'} ${label}${ok || !detail ? '' : `\n${detail}`}`);
};

function walk(dir, re, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!['node_modules', 'dist', '.git', '__pycache__'].includes(e.name)) walk(full, re, out);
    } else if (re.test(e.name)) out.push(full);
  }
  return out;
}

// 1. Syntax
const js = ['harness', 'qa', 'scripts', 'cartridges', 'tools'].flatMap((d) => walk(path.join(root, d), /\.(mjs|js)$/));
js.push(path.join(root, 'hub', 'server.mjs'), path.join(root, 'hub', 'server.js'));
const bad = js.filter((f) => run(process.execPath, ['--check', f]).status !== 0);
step(`syntax: ${js.length} JS module(s)`, bad.length === 0, bad.map((f) => `  ${path.relative(root, f)}`).join('\n'));
const py = ['tools', 'qa'].flatMap((d) => walk(path.join(root, d), /\.py$/));
const python = findPython();
const pyRes = python ? run(python.cmd, [...python.pre, '-m', 'py_compile', ...py], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }) : { status: 1, stderr: 'no Python 3 found (tried python3, python, py -3)' };
step(`syntax: ${py.length} Python file(s)`, pyRes.status === 0, pyRes.stderr);

// 4 (before): what git sees now
const isGit = run('git', ['rev-parse', '--is-inside-work-tree']).stdout.trim() === 'true';
const tracked = () => (isGit ? run('git', ['diff', '--name-only']).stdout.trim() : '');
const before = tracked();

// 2. Gates
const gates = spawnSync(process.execPath, [path.join(root, 'scripts', 'run-gates.mjs'), '--required-only', '--deep'], { cwd: root, stdio: 'inherit' });
step('required gates', gates.status === 0);

// 3. Closed loop still fails loudly
const loop = run(process.execPath, [path.join(root, 'harness', 'closed-loop.mjs'), '--simulate-fail']);
step('closed loop exits 1 on a simulated failure', loop.status === 1, loop.stdout + loop.stderr);

// 4 (after)
const after = tracked();
step('gates left tracked files unchanged', before === after, `changed by gates:\n${after}`);

// 5. Changelog
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const changelog = fs.existsSync(path.join(root, 'CHANGELOG.md')) ? fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8') : '';
step(`CHANGELOG.md has an entry for ${version}`, changelog.includes(version));
// npm install rewrites package-lock.json's version to match package.json, so a lagging lock shows up as
// a changed file in every studio after its first install (Jed's runs: "M package-lock.json" in every hand-back).
let lockVersion = null;
try {
  lockVersion = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')).version;
} catch {}
step(`package-lock.json says ${version} too`, lockVersion === null || lockVersion === version, `package-lock.json has ${lockVersion}; set its two "version" fields to ${version}`);

const failed = steps.filter((s) => !s.ok);
console.log(`\n[release] ${steps.length - failed.length}/${steps.length} steps passed`);
if (failed.length) {
  console.error(`[release] NOT READY: ${failed.map((s) => s.label).join('; ')}`);
  process.exit(1);
}
console.log(`[release] READY ${version}`);
