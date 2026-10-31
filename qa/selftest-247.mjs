/**
 * qa/selftest-247.mjs — the 2.47.0 checks: an engine port in its own repo (npm run engine -- link), its build
 * target and browser export, parity against a web game that isn't a cartridge, and the CI switch to a
 * self-hosted runner.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export async function selftest247({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const env = { STUDIO_PRODUCER_NAME: 'prod-1', STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off' };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' });

  // An adopted web game (not a cartridge) and its Unity port in a repo beside the studio.
  fs.mkdirSync(path.join(dir, 'game/runway'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'game/runway/package.json'), '{"name":"runway"}');
  fs.mkdirSync(path.join(dir, 'studio'), { recursive: true });
  const gj = path.join(dir, 'studio/game.json');
  fs.writeFileSync(gj, JSON.stringify({ ...(fs.existsSync(gj) ? JSON.parse(fs.readFileSync(gj, 'utf8')) : {}), game: 'runway' }));
  const port = path.join(tmpRoot, `runway-unity-247-${process.pid}`);
  fs.cpSync(path.join(dir, 'engine/_unity'), port, { recursive: true });
  g(port, 'init', '-q', '-b', 'main'); g(port, 'add', '-A'); g(port, 'commit', '-qm', 'port start');
  // Stand-ins for the two sides of parity: each prints one JSON line per seed.
  fs.writeFileSync(path.join(dir, 'web-side-247.mjs'), "for (const s of process.argv[2].split(',')) console.log(JSON.stringify({ seed: Number(s), outcome: 'won', tick: 100 + Number(s), cash: 5000 + Number(s) }));\n");
  fs.writeFileSync(path.join(dir, 'port-side-247.mjs'), "const off = process.env.OFF_247 === '1';\nfor (const s of process.argv[2].split(',')) console.log(JSON.stringify({ seed: Number(s), outcome: 'won', tick: 100 + Number(s), cash: 5000 + Number(s) + (off && s === '3' ? 7 : 0) }));\n");
  const rel = path.relative(dir, port).split(path.sep).join('/');
  const link = run(dir, `node harness/engine.mjs link unity "${rel}" --build windows --web "node web-side-247.mjs {seeds}" --source game/runway/src --by prod-1`, env);
  const tf = path.join(dir, 'engine/runway/engine.json');
  const t = (() => { try { return JSON.parse(fs.readFileSync(tf, 'utf8')); } catch { return {}; } })();
  const sim = run(dir, 'node harness/unity.mjs purity', env);
  report('2.47.0: npm run engine -- link unity <repo> records a port that lives in its own repo beside the studio (folder, remote and commit, gate, parity, Windows build, no browser export, the web rule folders) without copying anything into it, and the Unity checks find it from the track', link.status === 0 && t.folder === rel && t.engine === 'unity' && t.game === 'runway' && t.buildTarget === 'windows' && t.webExport === null && t.repo?.sha && t.gate === `node harness/unity.mjs gate ${rel}` && t.parity?.web === 'node web-side-247.mjs {seeds}' && JSON.stringify(t.portSource) === '["game/runway/src"]' && !fs.existsSync(path.join(port, 'engine.json')) && sim.status === 0 && /PASS sim purity/.test(out(sim)), `${out(link)}\n${JSON.stringify(t)}\n${out(sim)}`);

  // Parity against the web game's own runs; a mismatch names the seed and the field.
  fs.writeFileSync(tf, JSON.stringify({ ...t, parity: { ...t.parity, command: 'node port-side-247.mjs {seeds}', compare: ['outcome', 'tick', 'cash'] } }, null, 2));
  fs.appendFileSync(path.join(port, 'Assets/Sim/Sim.cs'), '// runway rules\n');
  const p1 = run(dir, 'node qa/parity.mjs', env);
  const p2 = run(dir, 'node qa/parity.mjs', { ...env, OFF_247: '1' });
  report('2.47.0: parity for a game that isn\'t a cartridge compares the port with the web game\'s own runs (engine.json parity.web), and a mismatch names the seed and the field', p1.status === 0 && /PASS 5 seeds agree on outcome and tick and cash \(against the web game's own runs/.test(out(p1)) && p2.status !== 0 && /seed 3: cash is 5003 on the web, 5010 in Unity/.test(out(p2)), `${out(p1)}\n---\n${out(p2)}`);

  // The build's default target comes from the track; without the editor it says so for the Windows build.
  const b = run(dir, 'node harness/unity.mjs build', { ...env, STUDIO_UNITY: path.join(tmpRoot, 'no-unity-247') });
  report('2.47.0: with the track\'s build target set to windows, npm run engine:build makes the Windows build by default (here: no editor, so it says so for Windows)', b.status !== 0 && /Windows build also needs that platform's module/.test(out(b)), out(b));

  // CI: every GitHub-hosted job is skipped when HARNESS_RUNNER is self-hosted, and one self-hosted job runs instead.
  const ci = fs.readFileSync(path.join(dir, '.github/workflows/ci.yml'), 'utf8').split(/^jobs:\n/m)[1] || '';
  const jobs = [...ci.matchAll(/^ {2}([a-z0-9-]+):\n((?: {4}.*\n|\n)*)/gm)].map((m) => ({ name: m[1], body: m[2] }));
  const hosted = jobs.filter((j) => j.name !== 'self-hosted');
  const self = jobs.find((j) => j.name === 'self-hosted');
  report('2.47.0: CI switches to the owner\'s PC with one variable: every GitHub-hosted job is skipped when HARNESS_RUNNER is self-hosted, and a self-hosted Windows job runs the release checks, the browser checks and the Unity template instead', hosted.length >= 6 && hosted.every((j) => /if: .*vars\.HARNESS_RUNNER != 'self-hosted'/.test(j.body)) && self && /if: vars\.HARNESS_RUNNER == 'self-hosted'/.test(self.body) && /runs-on: \[self-hosted, Windows\]/.test(self.body) && /scripts\/release\.mjs/.test(self.body) && /check-unity-template\.mjs/.test(self.body), JSON.stringify(jobs.map((j) => [j.name, (j.body.match(/if: .*/) || [''])[0]])));
}
