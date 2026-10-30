#!/usr/bin/env node
/**
 * scripts/check-control-effects.mjs — 2.39.0 proof, in a real browser: a Buy button that does nothing, with
 * the game's own test gamed (`expect: () => true`), passes the controls check without the Game Bible's
 * effect and fails with it. Runs in CI's war-room-browser job (it needs Chromium); skips (exit 0) without it.
 *
 *   node scripts/check-control-effects.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'effects-'));
const run = (dir, cmd, env = {}) => spawnSync(cmd, { cwd: dir, shell: true, encoding: 'utf8', env: { ...process.env, AGENT_EVENTS_FILE: path.join(dir, '.studio', 'events.jsonl'), ...env }, maxBuffer: 64 * 1024 * 1024 });
const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;

function copy(name) {
  const dir = path.join(tmp, name);
  const files = spawnSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  for (const f of files) {
    const src = path.join(ROOT, f);
    if (!fs.existsSync(src) || fs.statSync(src).isDirectory()) continue;
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.copyFileSync(src, path.join(dir, f));
  }
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  // The planted bug: the Buy button is not wired, and the game's own test of it always says yes.
  const main = path.join(dir, 'web/example-sim/main.mjs');
  fs.writeFileSync(main, fs.readFileSync(main, 'utf8').replace("$('buy').addEventListener('click', buy);", "// $('buy').addEventListener('click', buy); (planted: not wired)"));
  const qa = path.join(dir, 'cartridges/example-sim/qa.mjs');
  const q = fs.readFileSync(qa, 'utf8');
  const gamed = q.replace(/(\{ id: 'buy-button'[^\n]*?)expect: \(before, after\) => [^,]+,/, '$1expect: () => true,');
  if (gamed === q) throw new Error('could not plant the gamed expect in qa.mjs (its buy-button line changed)');
  fs.writeFileSync(qa, gamed);
  return dir;
}

const results = [];
const check = (label, ok, detail) => { results.push(ok); console.log(`[effects] ${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `\n${String(detail).slice(-3000)}`}`); };

// Without the Bible's effect: the gamed test passes the dead button (the weakness 2.39.0 closes).
const a = copy('no-effect');
const bible = path.join(a, 'studio/bible/controls.json');
const j = JSON.parse(fs.readFileSync(bible, 'utf8'));
for (const c of j.controls) delete c.effect;
fs.writeFileSync(bible, JSON.stringify(j, null, 2));
const pa = run(a, 'node qa/browser-play.mjs');
if (/\[browser-play\] SKIP/.test(out(pa))) {
  console.log('[effects] skipped: no Chromium here (CI runs this in the war-room-browser job)');
  process.exit(0);
}
const ca = run(a, 'node qa/controls-check.mjs');
check('without the Game Bible effect, a dead Buy button with a gamed test passes the browser check and the controls gate', pa.status === 0 && ca.status === 0, `${out(pa)}\n${out(ca)}`);

// With the Bible's effect: the same planted bug fails, by name, for the Bible's reason.
const b = copy('with-effect');
const pb = run(b, 'node qa/browser-play.mjs');
const cb = run(b, 'node qa/controls-check.mjs');
check('with the Game Bible effect, the same dead button fails the browser check and the controls gate, naming the effect', pb.status !== 0 && /The Buy button buys a unit: didn't change what the Game Bible says \(entities\.length should go up/.test(out(pb)) && cb.status !== 0 && /"buy-button" didn't change what the Game Bible says/.test(out(cb)) && !/"buy-unit"/.test(out(cb)), `${out(pb)}\n${out(cb)}`);

fs.rmSync(tmp, { recursive: true, force: true });
process.exit(results.every(Boolean) ? 0 : 1);
