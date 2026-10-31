/**
 * qa/selftest-251.mjs — 2.51.0 (U-005): npm run public-guard installs the public-repo guard into a game repo.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export async function selftest251({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' });
  const repo = path.join(tmpRoot, `public-game-251-${process.pid}`);
  fs.mkdirSync(path.join(repo, 'Assets'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'Assets/Plane.cs'), 'public class Plane {}\n');
  g(repo, 'init', '-q', '-b', 'main'); g(repo, 'add', '-A'); g(repo, 'commit', '-qm', 'start');
  const self = run(dir, `node harness/public-guard.mjs install "${dir}"`);
  const inst = run(dir, `node harness/public-guard.mjs install "${repo}"`);
  const st = run(dir, `node harness/public-guard.mjs status "${repo}"`);
  g(repo, 'add', '-A'); g(repo, 'commit', '-qm', 'guard');
  const clean = run(dir, `node harness/public-guard.mjs check "${repo}"`);
  // Planted: a harness folder, a token built at run time, a forced licence file.
  fs.mkdirSync(path.join(repo, 'harness'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'harness/task.mjs'), '// copied by mistake\n');
  fs.writeFileSync(path.join(repo, 'Assets/leak.txt'), `token = "${['gh', 'p_'].join('')}${'B'.repeat(36)}"\n`);
  fs.writeFileSync(path.join(repo, 'Unity_lic.ulf'), '<License id="x"><DeveloperData Value="x"/></License>\n');
  g(repo, 'add', '-A'); g(repo, 'add', '-f', 'Unity_lic.ulf');
  const dirty = run(dir, `node harness/public-guard.mjs check "${repo}"`);
  fs.appendFileSync(path.join(repo, 'tools/public-guard/check.mjs'), '// edited\n');
  const stale = run(dir, `node harness/public-guard.mjs status "${repo}"`);
  const gi = fs.readFileSync(path.join(repo, '.gitignore'), 'utf8');
  report('2.51.0 (U-005): npm run public-guard -- install puts the guard, its pre-push hook (with Git LFS kept working) and its CI check into a game repo and turns the hooks on; check passes a clean repo and blocks a harness folder, a token and a forced licence file; status spots an out-of-date copy; the harness itself is refused', self.status !== 0 && /that is the harness itself/.test(out(self)) && inst.status === 0 && st.status === 0 && /hooks on/.test(out(st)) && fs.existsSync(path.join(repo, '.githooks/post-checkout')) && /git lfs pre-push/.test(fs.readFileSync(path.join(repo, '.githooks/pre-push'), 'utf8')) && /Unity_lic\.ulf/.test(gi) && clean.status === 0 && dirty.status !== 0 && /harness\/task\.mjs: a private studio harness folder/.test(out(dirty)) && /Assets\/leak\.txt:1: a GitHub token/.test(out(dirty)) && /Unity_lic\.ulf: a Unity licence file/.test(out(dirty)) && stale.status !== 0 && /check\.mjs: out of date/.test(out(stale)), [self, inst, st, clean, dirty, stale].map(out).join('\n---\n'));
}
