/**
 * qa/selftest-253.mjs — 2.53.0: the public guard's per-repo private markers (a game's packed rules file).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export async function selftest253({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' });
  const repo = path.join(tmpRoot, `public-port-253-${process.pid}`);
  fs.mkdirSync(path.join(repo, 'Assets'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'Assets/Driver.cs'), 'public class Driver {}\n');
  g(repo, 'init', '-q', '-b', 'main'); g(repo, 'add', '-A'); g(repo, 'commit', '-qm', 'start');
  run(dir, `node harness/public-guard.mjs install "${repo}"`);
  fs.writeFileSync(path.join(repo, 'tools/public-guard/private-markers.json'), JSON.stringify({ why: 'the packed rules', files: ['(^|/)game-rules[^/]*\\.m?js$'], text: ['scheduleTheRunwayBank\\s*\\('] }));
  g(repo, 'add', '-A'); g(repo, 'commit', '-qm', 'guard');
  const clean = run(dir, `node harness/public-guard.mjs check "${repo}"`);
  fs.writeFileSync(path.join(repo, 'game-rules.mjs'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(repo, 'Assets/renamed.txt'), 'function scheduleTheRunwayBank(a) { return a }\n');
  g(repo, 'add', '-A');
  const dirty = run(dir, `node harness/public-guard.mjs check "${repo}"`);
  run(dir, `node harness/public-guard.mjs install "${repo}"`);
  const kept = JSON.parse(fs.readFileSync(path.join(repo, 'tools/public-guard/private-markers.json'), 'utf8'));
  report('2.53.0: a public repo\'s own private markers (tools/public-guard/private-markers.json) block its private code by name and by content (a renamed copy too); the markers file itself isn\'t flagged and installing again keeps it', clean.status === 0 && dirty.status !== 0 && /game-rules\.mjs: the packed rules/.test(out(dirty)) && /Assets\/renamed\.txt:1: the packed rules/.test(out(dirty)) && !/private-markers\.json/.test(out(dirty)) && kept.why === 'the packed rules', `${out(clean)}\n---\n${out(dirty)}`);
}
