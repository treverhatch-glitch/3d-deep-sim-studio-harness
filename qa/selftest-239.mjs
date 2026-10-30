/**
 * qa/selftest-239.mjs — the 2.39.0 checks: what a control must change, said in the Game Bible
 * (harness/control-effects.mjs). The real-browser proof is scripts/check-control-effects.mjs (CI's
 * war-room-browser job).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest239({ dir, run, report, tmpRoot }) {
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  let n = 0;
  const probe = (code) => {
    const f = path.join(tmpRoot, `p239-${++n}-${process.pid}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node "${f}"`);
    try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { error: out(r) }; }
  };

  // 1. Paths and changes.
  const p = probe(`import { readPath, checkEffect } from ${u('harness/control-effects.mjs')};
const before = { resources: { credits: 500 }, entities: [{ kind: 'unit' }, { kind: 'rock' }], flags: { bell: false } };
const after = { resources: { credits: 420 }, entities: [{ kind: 'unit' }, { kind: 'rock' }, { kind: 'unit' }], flags: { bell: true } };
const r = (e) => checkEffect(e, before, after);
console.log(JSON.stringify({
  len: readPath(after, 'entities.length'), units: readPath(after, 'entities[kind=unit].length'), none: readPath(after, 'nope.x'),
  up: r({ path: 'entities[kind=unit].length', change: 'up' }).ok, down: r({ path: 'resources.credits', change: 'down' }).ok,
  by: r({ path: 'resources.credits', change: -80 }).ok, byWrong: r({ path: 'resources.credits', change: -50 }).why,
  changes: r({ path: 'flags.bell', change: 'changes' }).ok, same: r({ path: 'entities[kind=rock].length', change: 'same' }).ok,
  missing: r({ path: 'fleet.size', change: 'up' }).why, wrongWay: r({ path: 'resources.credits', change: 'up' }).why,
}));`);
  report('2.39.0: a Game Bible effect reads dotted paths, list lengths and [field=value] filters, and checks up, down, changes, same and an exact difference, saying why when it fails', p.len === 3 && p.units === 2 && p.none === undefined && p.up && p.down && p.by && /should change by -50 \(was 500, now 420\)/.test(p.byWrong || '') && p.changes && p.same && /the sim state has no fleet\.size/.test(p.missing || '') && /resources\.credits should go up \(was 500, now 420\)/.test(p.wrongWay || ''), JSON.stringify(p));

  // 2. The controls gate: a control with a Bible effect passes only when the result shows the effect was checked.
  const bible = path.join(tmpRoot, `bible-239-${process.pid}.json`);
  const reports = path.join(tmpRoot, `reports-239-${process.pid}`);
  fs.mkdirSync(reports, { recursive: true });
  fs.writeFileSync(bible, JSON.stringify({ tracks: ['web', 'godot'], controls: [{ id: 'buy', name: 'Buy', effect: { path: 'entities.length', change: 'up' } }, { id: 'pause', name: 'Pause' }] }));
  const write = (name, controls) => fs.writeFileSync(path.join(reports, name), JSON.stringify({ controls }));
  write('browser_1.json', [{ id: 'buy', ok: true }, { id: 'pause', ok: true }]);
  write('controls-godot.json', [{ id: 'buy', ok: true }, { id: 'pause', ok: true }]);
  const cc = (tag) => probe(`import { controlsCheck } from ${u('qa/controls-check.mjs')};
console.log(JSON.stringify(await controlsCheck({ bibleFile: ${JSON.stringify(bible)}, reportsDir: ${JSON.stringify(reports)}, template: false })));`);
  const old = cc();
  const t = Date.now() / 1000 + 5;
  write('browser_2.json', [{ id: 'buy', ok: true, effects: [{ path: 'entities.length', change: 'up', before: 1, after: 2, ok: true }] }, { id: 'pause', ok: true }]);
  fs.utimesSync(path.join(reports, 'browser_2.json'), t, t);
  const fresh = cc();
  report('2.39.0: the controls gate refuses a web pass for a control whose Bible effect the result does not show was checked, passes once it does, and notes that other tracks check effects on web only', !old.ok && old.problems.some((x) => /"buy" passed, but the result doesn't show the Game Bible's effect was checked/.test(x)) && fresh.ok && fresh.notes.some((x) => /godot: "buy"'s Game Bible effect is checked on the web track only/.test(x)), JSON.stringify({ old, fresh }));

  // 3. The template's own Bible names an effect for each control, and the proof script is wired into CI.
  const tb = JSON.parse(fs.readFileSync(path.join(dir, 'studio/bible/controls.json'), 'utf8'));
  const ci = fs.readFileSync(path.join(dir, '.github/workflows/ci.yml'), 'utf8');
  report('2.39.0: the template\'s Game Bible names what each control must change, and CI runs the planted-dead-button proof in a real browser', tb.controls.every((c) => c.effect?.path) && /node scripts\/check-control-effects\.mjs/.test(ci), JSON.stringify(tb.controls));
}
