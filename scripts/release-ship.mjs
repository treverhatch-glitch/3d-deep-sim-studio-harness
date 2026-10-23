#!/usr/bin/env node
/**
 * scripts/release-ship.mjs — ship a release in one command (2.30c).  `npm run release -- <version>`
 *
 *   npm run release -- 2.30.0-c [--notes notes.md] [--title "…"] [--backup-dir <dir>] [--dry-run] [--no-ci]
 *
 * What a person used to do by hand for every release, in order; it stops at the first red step and
 * leaves the work uncommitted (nothing is pushed):
 *   1. on main, in step with origin/main (fetched), and the version is new;
 *   2. bumps package.json and package-lock.json, and writes the CHANGELOG entry from --notes (unless
 *      the CHANGELOG already has one for this version);
 *   3. makes ONE squashed commit of the whole working tree on top of origin/main (local only);
 *   4. clones that commit fresh into a temp folder, installs, and runs verify --deep there (every
 *      required gate, including the self-test and the War Room smoke test) and the War Room browser
 *      check (qa/hud-check.mjs, screenshots with --shots <dir>);
 *   5. bundles origin/main (the state before this release) into the backup folder, and checks the bundle;
 *   6. pushes the commit to main (never forced: a moved main is refused, and you rebase);
 *   7. waits for CI on that commit; a failed job is re-run once (known flaky timing checks) and both
 *      results are reported;
 *   8. reports in plain words, failing first, "not run" apart from "pass".
 * No branches are made. --dry-run does 1-5 and stops before the push (the commit is undone, the work
 * stays). Without the gh CLI, step 7 says "CI not checked", never "green".
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const version = argv[0];
const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
const has = (k) => argv.includes(`--${k}`);
const dry = has('dry-run');
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
const git = (...a) => sh('git', a);
const report = { version, steps: [], tests: {}, sha: null, ci: null, backup: null, shots: null };
const step = (label, ok, detail = '', state = ok ? 'pass' : 'fail') => {
  report.steps.push({ label, state, detail });
  console.log(`[ship] ${state.toUpperCase().padEnd(7)} ${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
};
function finish(code) {
  const failing = report.steps.filter((s) => s.state === 'fail');
  const notRun = report.steps.filter((s) => s.state === 'not run');
  console.log('\n[ship] report, failing first');
  console.log(failing.length ? failing.map((s) => `  FAILING: ${s.label}${s.detail ? ` — ${s.detail}` : ''}`).join('\n') : '  FAILING: none');
  if (notRun.length) console.log(notRun.map((s) => `  NOT RUN: ${s.label}${s.detail ? ` — ${s.detail}` : ''}`).join('\n'));
  console.log(report.steps.filter((s) => s.state === 'pass').map((s) => `  PASS:    ${s.label}${s.detail ? ` — ${s.detail}` : ''}`).join('\n'));
  if (report.sha) console.log(`  Commit: ${report.sha}`);
  const out = path.join(root, '.studio', 'release-last.json');
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  } catch {}
  process.exit(code);
}

if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version || '')) {
  console.error('Usage: npm run release -- <version, e.g. 2.30.0-c> [--notes notes.md] [--title "…"] [--backup-dir <dir>] [--shots <dir>] [--dry-run] [--no-ci]');
  process.exit(1);
}

// 1. Where we are.
const branch = git('symbolic-ref', '--short', 'HEAD').stdout.trim();
if (!step('on main', branch === 'main', branch ? `on ${branch}` : 'detached HEAD')) finish(1);
const fetched = git('fetch', '-q', 'origin', 'main');
if (!step('fetched origin/main', fetched.status === 0, fetched.stderr.trim().split('\n')[0])) finish(1);
const head = git('rev-parse', 'HEAD').stdout.trim();
const remote = git('rev-parse', 'origin/main').stdout.trim();
if (!step('in step with origin/main', head === remote, head === remote ? remote.slice(0, 7) : `local ${head.slice(0, 7)}, origin ${remote.slice(0, 7)}: pull or rebase first (never force)`)) finish(1);
const pkgFile = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
const shipped = git('log', '--format=%s', '-n', '200').stdout;
if (!step(`version ${version} is new`, !shipped.split('\n').some((s) => s.startsWith(`${version}:`) || s.startsWith(`${version.replace(/^(\d+\.\d+)\.0-(\w)$/, '$1$2')}:`)), `package.json had ${pkg.version}`)) finish(1);

// 2. Version and changelog.
pkg.version = version;
fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
// 2.30h: one helper sets the lock's version (scripts/lock-version.mjs), the same one the release check uses.
(await import('./lock-version.mjs')).syncLockVersion(root, version);
const clFile = path.join(root, 'CHANGELOG.md');
let cl = fs.readFileSync(clFile, 'utf8');
if (!cl.includes(`## [${version}]`)) {
  const notes = flag('notes') ? fs.readFileSync(path.resolve(flag('notes')), 'utf8').trim() : '';
  if (!step('CHANGELOG entry', Boolean(notes), notes ? '' : `no entry for ${version} and no --notes file`)) finish(1);
  const entry = `## [${version}] — ${new Date().toLocaleDateString('sv')}\n${notes}\n\n---\n\n`;
  const at = cl.indexOf('## [');
  cl = at >= 0 ? cl.slice(0, at) + entry + cl.slice(at) : `${cl}\n${entry}`;
  fs.writeFileSync(clFile, cl);
  step('CHANGELOG entry written', true, `from ${flag('notes')}`);
} else step('CHANGELOG entry', true, 'already there');

// 3. One squashed commit, local.
const title = flag('title') || (cl.slice(cl.indexOf(`## [${version}]`)).split('\n')[1] || '').replace(/[.:]\s*$/, '').slice(0, 100);
const short = version.replace(/^(\d+\.\d+)\.0-(\w)$/, '$1$2');
git('add', '-A');
const msg = `${short}: ${title || 'release'}`;
const c = git('commit', '-q', '-m', msg);
if (!step('one squashed commit (local)', c.status === 0, (c.stderr || c.stdout).trim().split('\n')[0])) finish(1);
report.sha = git('rev-parse', 'HEAD').stdout.trim();
const undo = () => git('reset', '-q', '--soft', remote);

// 4. Fresh clone of that commit: install, verify --deep, War Room browser check.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-'));
const clone = sh('git', ['clone', '-q', '--no-hardlinks', root, tmp]);
let ok = step('fresh clone of the commit', clone.status === 0, clone.stderr.trim().split('\n')[0]);
const inTmp = (cmd, args, env = {}) => sh(cmd, args, { cwd: tmp, env: { ...process.env, STUDIO_CARTRIDGE: '', AGENT_EVENTS_FILE: '', ...env } });
if (ok) {
  const ci = inTmp('npm', ['ci', '--no-audit', '--no-fund']);
  ok = step('npm ci in the clone', ci.status === 0, ci.status ? ci.stderr.trim().split('\n').slice(-2).join(' ') : '');
}
if (ok) {
  const t0 = Date.now();
  const v = inTmp(process.execPath, ['scripts/run-gates.mjs', '--required-only', '--deep']);
  const out = `${v.stdout}${v.stderr}`;
  fs.mkdirSync(path.join(root, '.studio'), { recursive: true });
  fs.writeFileSync(path.join(root, '.studio', 'release-verify.log'), out);
  const passN = (out.match(/^\[selftest\] PASS /gm) || []).length;
  const failN = (out.match(/^\[selftest\] FAIL /gm) || []).length;
  const fails = [...out.matchAll(/^\[selftest\] FAIL (.+)$/gm)].map((m) => m[1]);
  const gates = [...out.matchAll(/^\[gates\] (PASS|FAIL|WARN) (\S+)$/gm)].map((m) => [m[1], m[2]]);
  report.tests = { selftestPass: passN, selftestFail: failN, selftestFailing: fails, gatesPass: gates.filter((g) => g[0] === 'PASS').length, gatesFail: gates.filter((g) => g[0] === 'FAIL').map((g) => g[1]), minutes: Math.round((Date.now() - t0) / 60000) };
  ok = step('verify --deep in the fresh clone', v.status === 0, `${report.tests.gatesPass} gates passed${report.tests.gatesFail.length ? `, failing: ${report.tests.gatesFail.join(', ')}` : ''}; self-test ${passN} passed, ${failN} failed${fails.length ? ` (${fails.slice(0, 3).join(' | ')})` : ''}; log .studio/release-verify.log`);
}
if (ok) {
  const shots = flag('shots');
  const h = inTmp(process.execPath, ['qa/hud-check.mjs', ...(shots ? ['--shots', path.resolve(shots)] : [])]);
  const out = `${h.stdout}${h.stderr}`;
  const skipped = /\[hud\] SKIP/.test(out);
  report.tests.hudPass = (out.match(/^\[hud\] PASS /gm) || []).length;
  report.tests.hudFail = (out.match(/^\[hud\] FAIL /gm) || []).length;
  report.shots = shots ? path.resolve(shots) : null;
  if (skipped) step('War Room browser check', true, out.split('\n').find((l) => /SKIP/.test(l)), 'not run');
  else ok = step('War Room browser check', h.status === 0, `${report.tests.hudPass} passed, ${report.tests.hudFail} failed${shots ? `; screenshots in ${path.resolve(shots)}` : ''}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
if (!ok) {
  undo();
  step('work left uncommitted; nothing pushed', true);
  finish(1);
}

// 5. Backup of main as it was, before the push.
const dir = path.resolve(flag('backup-dir') || process.env.STUDIO_RELEASE_BACKUP_DIR || path.join(root, '..', 'backups'));
fs.mkdirSync(dir, { recursive: true });
const bundle = path.join(dir, `${path.basename(root)}-main-${remote.slice(0, 7)}-before-${short}-${new Date().toISOString().replace(/[:.]/g, '-')}.bundle`);
const b = git('bundle', 'create', bundle, 'origin/main');
const bv = b.status === 0 ? git('bundle', 'verify', bundle) : b;
report.backup = bundle;
if (!step('bundle backup of main', b.status === 0 && bv.status === 0, bundle)) {
  undo();
  finish(1);
}
if (dry) {
  undo();
  step('push', true, '--dry-run: stopped before the push; the commit is undone, the work stays', 'not run');
  finish(0);
}

// 6. Push, never forced.
const p = git('push', 'origin', 'HEAD:main');
if (!step('pushed to main (no force)', p.status === 0, p.status ? p.stderr.trim().split('\n').slice(-2).join(' ') : report.sha.slice(0, 7))) {
  undo();
  finish(1);
}

// 7. CI on that commit.
const ghOk = sh('gh', ['--version']).status === 0;
if (has('no-ci') || !ghOk) {
  step('CI on main', true, has('no-ci') ? '--no-ci' : 'gh CLI not found: CI not checked', 'not run');
  finish(0);
}
// 2.30h (5): the CI watch (harness/ci-watch.mjs) waits, re-runs failed jobs once, and alerts when still red.
const { watchCi } = await import('../harness/ci-watch.mjs');
const w = watchCi({ sha: report.sha, timeoutMin: 60 });
report.ci = { first: w.first, rerun: w.rerun, state: w.state };
if (w.state === 'timed out' || !w.first) {
  step('CI on main', false, 'no finished CI run after 60 min (ci.failed raised)');
  finish(1);
}
if (w.rerun) {
  step('CI on main, first run', false, `failed: ${w.first.flatMap((x) => x.jobs.filter((j) => j.conclusion !== 'success').map((j) => j.name)).join(', ')}; re-ran the failed jobs once`);
  if (!step('CI on main, after one re-run', w.state !== 'red', w.state !== 'red' ? 'green on the re-run (a flaky check; see the first run)' : `still red: ${w.failing.join(', ')} (ci.failed raised)`)) finish(1);
} else step('CI on main', true, `${w.first.reduce((n, x) => n + x.jobs.length, 0)} jobs green`);
finish(0);
