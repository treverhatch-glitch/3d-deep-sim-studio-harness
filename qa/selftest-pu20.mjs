/**
 * qa/selftest-pu20.mjs — PU-20: the protected-files check judges the working tree, not only commits since the base.
 * Before, it said "no base branch to compare with" and passed when the base was at HEAD: an uncommitted edit with
 * no remote, or with origin/main == HEAD (also right after a push), and even a committed edit on a main with no
 * remote. Now: a base at HEAD still judges uncommitted edits, and with no base branch at all the check compares
 * with the commit that set the owner key, file by file against the hashes the owner's approvals recorded.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export async function selftestPU20({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd: dir, encoding: 'utf8' });
  const ownerKey = path.join(tmpRoot, `owner-pu20-${process.pid}.pem`);
  const env = { STUDIO_OWNER_KEY: ownerKey };
  const check = () => run(dir, 'node qa/protected-check.mjs', env);
  const qa = 'cartridges/example-sim/qa.mjs';
  const edit = (tag) => fs.appendFileSync(path.join(dir, qa), `// ${tag}\n`);
  const failsOn = (r, file, since) => r.status !== 0 && new RegExp(`FAIL 1 protected file\\(s\\) changed since ${since}`).test(r.stderr) && r.stderr.includes(file) && !/no base branch to compare with/.test(out(r));

  g('init', '-q', '-b', 'main'); g('config', 'core.autocrlf', 'false');
  g('add', '-A'); g('commit', '-qm', 'studio', '--no-verify');
  fs.rmSync(ownerKey, { force: true });
  const kg = run(dir, 'node harness/approve.mjs keygen', env);
  g('add', 'studio/keys'); g('commit', '-qm', 'owner key', '--no-verify');

  // No remote, on main.
  const clean = check();
  report('PU-20: an untouched tree with an owner key and no remote passes, and says what it compared with (not "no base branch")',
    kg.status === 0 && clean.status === 0 && /PASS: no protected file changed since [0-9a-f]{8} \(the commit that set the owner key; no base branch\)/.test(clean.stdout), `${out(kg)}\n${out(clean)}`);
  edit('a');
  const a = check();
  const aGate = run(dir, 'node scripts/run-gates.mjs --only protected', env);
  report('PU-20 (a): an uncommitted edit to a protected file with no remote fails the check and the protected gate (was: "no base branch", exit 0)',
    failsOn(a, qa, '[0-9a-f]{8} \\(the commit that set the owner key') && aGate.status !== 0, `${out(a)}\n---\n${out(aGate).slice(-800)}`);
  g('commit', '-qam', 'edit a', '--no-verify');
  const a2 = check();
  report('PU-20: the same edit committed on a main with no remote still fails (was: passed)', failsOn(a2, qa, '[0-9a-f]{8} \\(the commit that set the owner key'), out(a2));
  const ok1 = run(dir, 'node harness/approve.mjs protected --note "the owner approves edit a"', env);
  g('add', 'studio/approvals'); g('commit', '-qm', 'approval', '--no-verify');
  const a3 = check();
  report('PU-20: with no remote, the owner\'s approval passes the approved contents (matched by its recorded hashes)',
    ok1.status === 0 && a3.status === 0 && /PASS: every protected file changed since .* has contents an owner approval recorded/.test(a3.stdout), `${out(ok1)}\n---\n${out(a3)}`);

  // A remote whose main is HEAD.
  const bare = path.join(tmpRoot, `origin-pu20-${process.pid}.git`);
  spawnSync('git', ['clone', '-q', '--bare', dir, bare], { encoding: 'utf8' });
  g('remote', 'add', 'origin', bare); g('fetch', '-q', 'origin'); g('branch', '-q', '-u', 'origin/main');
  const bClean = check();
  edit('b');
  const b = check();
  report('PU-20 (b): with origin/main == HEAD an untouched tree passes and an uncommitted protected edit fails (was: "no base branch", exit 0)',
    bClean.status === 0 && /PASS: no protected file changed since origin\/main/.test(bClean.stdout) && failsOn(b, qa, 'origin/main'), `${out(bClean)}\n---\n${out(b)}`);
  g('commit', '-qam', 'edit b', '--no-verify');
  const b2 = check();
  g('push', '-q', 'origin', 'main');
  edit('b3');
  const b3 = check();
  report('PU-20 (b3): after a push (origin/main == HEAD again) a new uncommitted protected edit fails; committed ahead of origin/main still fails',
    failsOn(b2, qa, 'origin/main') && failsOn(b3, qa, 'origin/main'), `${out(b2)}\n---\n${out(b3)}`);
  const ok2 = run(dir, 'node harness/approve.mjs protected --note "the owner approves edit b3"', env);
  const b4 = check();
  edit('b4');
  const b5 = check();
  report('PU-20: an approved uncommitted change passes; any later edit needs a new approval',
    ok2.status === 0 && b4.status === 0 && /approved by/.test(b4.stdout) && b5.status !== 0 && /different contents/.test(b5.stderr), [ok2, b4, b5].map(out).join('\n---\n'));
}
