/**
 * qa/selftest-250.mjs — 2.50.0 (U-006): npm run parity hands the seeds to the web side in STUDIO_PARITY_SEEDS,
 * so a test runner reads them without shell-specific syntax, and test-runner noise around the JSON lines is ignored.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export async function selftest250({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const env = { STUDIO_PRODUCER_NAME: 'prod-1', STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off' };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' });
  fs.mkdirSync(path.join(dir, 'game/kite'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'game/kite/package.json'), '{"name":"kite"}');
  const gj = path.join(dir, 'studio/game.json');
  fs.writeFileSync(gj, JSON.stringify({ ...(fs.existsSync(gj) ? JSON.parse(fs.readFileSync(gj, 'utf8')) : {}), game: 'kite' }));
  const port = path.join(tmpRoot, `kite-unity-250-${process.pid}`);
  fs.cpSync(path.join(dir, 'engine/_unity'), port, { recursive: true });
  fs.appendFileSync(path.join(port, 'Assets/Sim/Sim.cs'), '// kite rules\n');
  g(port, 'init', '-q', '-b', 'main'); g(port, 'add', '-A'); g(port, 'commit', '-qm', 'port');
  // A web side that only reads the variable and prints test-runner noise around its JSON lines.
  fs.writeFileSync(path.join(dir, 'game/kite/runner-250.mjs'), "console.log(' RUN  v5 /game/kite');\nconsole.log('stdout | tests/sim/replay.test.ts > replays > prints parity lines');\nfor (const s of (process.env.STUDIO_PARITY_SEEDS || '').split(',').filter(Boolean)) console.log(JSON.stringify({ seed: Number(s), outcome: 'ran', tick: 180, cash: 1000 * Number(s) }));\nconsole.log(' Test Files  1 passed (1)');\n");
  fs.writeFileSync(path.join(dir, 'port-250.mjs'), "for (const s of process.argv[2].split(',')) console.log(JSON.stringify({ seed: Number(s), outcome: 'ran', tick: 180, cash: 1000 * Number(s) }));\n");
  const rel = path.relative(dir, port).split(path.sep).join('/');
  run(dir, `node harness/engine.mjs link unity "${rel}" --web "cd game/kite && node runner-250.mjs" --by prod-1`, env);
  const tf = path.join(dir, 'engine/kite/engine.json');
  const t = JSON.parse(fs.readFileSync(tf, 'utf8'));
  fs.writeFileSync(tf, JSON.stringify({ ...t, parity: { ...t.parity, command: 'node port-250.mjs {seeds}', compare: ['outcome', 'tick', 'cash'] } }, null, 2));
  const p = run(dir, 'node qa/parity.mjs --seeds 2,5,9', env);
  report('2.50.0 (U-006): npm run parity hands the seeds to the web side in STUDIO_PARITY_SEEDS (no shell-specific syntax; a Vite game\'s Vitest run reads them) and ignores the test runner\'s own lines around the JSON', p.status === 0 && /PASS 3 seeds agree on outcome and tick and cash/.test(out(p)), out(p));
}
