/**
 * qa/selftest-245.mjs — the 2.45.0 checks that need no browser: the starter studio.browser.json onboarding
 * writes for a web game, how a control is pressed, the `to` effect, and the web track reading a
 * controls-play report. The real-browser proof is scripts/check-controls-play.mjs (CI's war-room-browser job).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest245({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const imp = (rel) => import(pathToFileURL(path.join(dir, rel)).href);
  const env = { AGENT_EVENTS_FILE: path.join(dir, '.studio', 'events-245.jsonl'), STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off' };

  // 1. Adopting a Vite game writes a starter studio.browser.json and the controls task points at it.
  const src = path.join(tmpRoot, `kite-245-${process.pid}`);
  fs.mkdirSync(path.join(src, 'src'), { recursive: true });
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'kite', scripts: { dev: 'vite', test: 'vitest run' }, devDependencies: { vite: '^8.0.0', vitest: '^5.0.0' } }));
  fs.writeFileSync(path.join(src, 'src/main.ts'), 'export const kite = 1;\n');
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' });
  g(src, 'init', '-q', '-b', 'main'); g(src, 'add', '-A'); g(src, 'commit', '-qm', 'start');
  const ad = run(dir, `node scripts/onboard-game.mjs --path "${src}" --name Kite --adopt`, env);
  const bf = path.join(dir, 'game/kite/studio.browser.json');
  const man = (() => { try { return JSON.parse(fs.readFileSync(bf, 'utf8')); } catch { return null; } })();
  const next = fs.existsSync(path.join(dir, 'studio/NEXT.md')) ? fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8') : '';
  report('2.45.0: onboard --adopt writes a starter game/<slug>/studio.browser.json for a Vite game (serve on a free port, ready, state, start, controls) and the controls task names it and npm run play:controls', /npx vite --port \{port\} --strictPort/.test(man?.serve?.command || '') && Array.isArray(man?.start) && typeof man?.state === 'string' && /wrote a starter game\/kite\/studio\.browser\.json/.test(out(ad)) && /game\/kite\/studio\.browser\.json so npm run play:controls/.test(next), `${out(ad)}\n${JSON.stringify(man)}`);

  // 2. How a control is pressed: the manifest first, else the Bible's "key X".
  const { actionFor } = await imp('qa/controls-play.mjs');
  const a = [actionFor('p', { input: 'key Space' }, {}), actionFor('d', { input: 'key 2' }, {}), actionFor('h', { input: 'key H' }, {}), actionFor('b', { input: 'click Buy' }, {}), actionFor('b', { input: 'click Buy' }, { controls: { b: { click: '#buy' } } })];
  report('2.45.0: a control is pressed from studio.browser.json, else from the Bible\'s "key X" input (Space, Digit2, KeyH); a click with no selector has no way to be pressed', a[0]?.key === 'Space' && a[1]?.key === 'Digit2' && a[2]?.key === 'KeyH' && a[3] === null && a[4]?.click === '#buy', JSON.stringify(a));

  // 3. The `to` effect: ends at the value, and fails when it was already there (the press proved nothing).
  const { checkEffect } = await imp('harness/control-effects.mjs');
  const t = [checkEffect({ path: 'speed', to: 0 }, { speed: 1 }, { speed: 0 }), checkEffect({ path: 'speed', to: 0 }, { speed: 1 }, { speed: 1 }), checkEffect({ path: 'speed', to: 0 }, { speed: 0 }, { speed: 0 }), checkEffect({ path: 'view', to: 'hall' }, { view: 'apron' }, { view: 'hall' })];
  report('2.45.0: a Bible effect { path, to } passes when the value ends there, fails when it doesn\'t, and fails when it was already there before the press', t[0].ok && !t[1].ok && !t[2].ok && /proved nothing/.test(t[2].why || '') && t[3].ok, JSON.stringify(t));

  // 4. The web track reads a controls-play report (controls-web-*.json), the newest one wins.
  const { trackResults } = await imp('qa/controls-check.mjs');
  const rd = path.join(tmpRoot, `reports-245-${process.pid}`);
  fs.mkdirSync(rd, { recursive: true });
  fs.writeFileSync(path.join(rd, 'browser_1.json'), JSON.stringify({ controls: [{ id: 'old', ok: true }] }));
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(rd, 'browser_1.json'), past, past);
  fs.writeFileSync(path.join(rd, 'controls-web-2.json'), JSON.stringify({ controls: [{ id: 'speed.pause', ok: true, effects: [{ ok: true }] }] }));
  const tr = trackResults('web', rd);
  report('2.45.0: the controls check\'s web track reads qa/controls-play.mjs\'s reports (controls-web-*.json) as well as browser-play\'s, newest first', tr?.file?.endsWith('controls-web-2.json') && tr.results.get('speed.pause')?.ok === true && !tr.results.has('old'), JSON.stringify(tr && { file: tr.file, ids: [...tr.results.keys()] }));

  // 5. Without a studio game, play:controls says what it is for instead of crashing.
  const nog = run(dir, 'node qa/controls-play.mjs', { ...env, STUDIO_GAME: 'no-such-game-245' });
  report('2.45.0: npm run play:controls with no studio game fails with what it is for', nog.status !== 0 && /no studio game/.test(out(nog)), out(nog));
}
