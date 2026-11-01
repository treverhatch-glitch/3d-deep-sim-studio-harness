/**
 * qa/selftest-259f.mjs — 2.59.0: render tasks on games that aren't Godot projects can prove themselves with pictures.
 *
 * Found in a crew's studio (a web game): `task done` told render tasks "capture before/after (npm run visual -- capture
 * <T> before|after --godot <project>)", the only capture the harness had. The game has no Godot project, so the tasks
 * could not finish (refused 7 times; one parked, the rest forced). Now the game names its own capture command in its
 * check manifest (<root>/studio.gates.json, a protected file): "visual": { "capture": "..." }; `capture` runs it, and
 * the same check (missing, blank, unchanged frames) applies. The hint `task done` prints names the right route.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest259F({ dir, run, report }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const env = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_LOCK_OWNER: 'v259f', STUDIO_GAME: '' };
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  let n = 0;
  const probe = (code) => {
    const f = path.join(dir, `.probe-259f-${n++}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node ${path.basename(f)}`, env);
    try { return { ...JSON.parse(String(r.stdout).trim().split('\n').pop()), raw: out(r) }; } catch { return { raw: out(r) }; }
  };
  const write = (rel, data) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), data); };

  // A web game with checks but, at first, no capture command.
  const gameJson = path.join(dir, 'studio', 'game.json');
  const before = fs.existsSync(gameJson) ? fs.readFileSync(gameJson, 'utf8') : null;
  write('studio/game.json', `${JSON.stringify({ ...(before ? JSON.parse(before) : {}), game: 'demo259f' }, null, 2)}\n`);
  write('web/demo259f/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'test', command: 'node -e "0"' }] }, null, 2)}\n`);
  // The game's own capture tool: one gradient picture per camera, brighter after than before.
  write('web/demo259f/tools/capture.mjs', `import fs from 'node:fs';
import path from 'node:path';
import { encodePng } from ${u('harness/png.mjs')};
const [out, cams, phase] = process.argv.slice(2);
if (process.env.CAPTURE_259F_NOTHING === '1') process.exit(0);
const w = 64, h = 64, rgba = new Uint8Array(w * h * 4);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const i = (y * w + x) * 4, v = Math.round((x / w) * 200) + (phase === 'after' ? 40 : 0) * ((y > 32) ? 1 : 0);
  rgba[i] = v; rgba[i + 1] = (y * 3) % 255; rgba[i + 2] = 255 - v; rgba[i + 3] = 255;
}
for (const cam of (cams || 'main').split(',').filter(Boolean)) fs.writeFileSync(path.join(out, cam + '.png'), encodePng({ width: w, height: h, rgba }));
`);
  const task = { id: 'T-901', title: 'Render: brighter lobby lighting', role: 'builder' };
  const hintNoCmd = probe(`import { summarize } from ${u('harness/verdict-split.mjs')};
console.log(JSON.stringify(summarize('T-901', ${JSON.stringify(task)}, { parts: {} })));`);
  report('2.59.0: a render task on a game with no Godot project is not told to capture with --godot; the hint names the game\'s manifest and the visual.capture command the owner adds (or visual: off)',
    hintNoCmd.render === true && hintNoCmd.ok === false && !/--godot/.test(hintNoCmd.why || '') && /web\/demo259f\/studio\.gates\.json/.test(hintNoCmd.why || '') && /"capture"/.test(hintNoCmd.why || ''),
    hintNoCmd.why || hintNoCmd.raw);

  const noCmd = run(dir, 'node harness/visual-proof.mjs capture T-901 before', env);
  report('2.59.0: capture with no --godot and no capture command fails and says where the command goes',
    noCmd.status === 1 && /no capture command/.test(out(noCmd)) && /studio\.gates\.json/.test(out(noCmd)), out(noCmd).slice(-600));

  // The owner adds the capture command to the manifest.
  write('web/demo259f/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'test', command: 'node -e "0"' }], visual: { capture: 'node web/demo259f/tools/capture.mjs {out} {cams} {phase}' } }, null, 2)}\n`);
  const hintCmd = probe(`import { summarize } from ${u('harness/verdict-split.mjs')};
console.log(JSON.stringify(summarize('T-901', ${JSON.stringify(task)}, { parts: {} })));`);
  const b = run(dir, 'node harness/visual-proof.mjs capture T-901 before --cams lobby,gate', env);
  const a = run(dir, 'node harness/visual-proof.mjs capture T-901 after --cams lobby,gate', env);
  const c = run(dir, 'node harness/visual-proof.mjs check T-901', env);
  const proof = path.join(dir, '.studio', 'proof', 'T-901', 'visual');
  const shots = ['before', 'after'].map((p) => (fs.existsSync(path.join(proof, p)) ? fs.readdirSync(path.join(proof, p)).sort().join(',') : ''));
  report('2.59.0: with "visual": { "capture": ... } in the game\'s manifest, capture runs the game\'s command (one PNG per camera, {out} {cams} {phase} filled) and the before/after check passes on a real change; the hint names that route',
    b.status === 0 && a.status === 0 && c.status === 0 && shots[0] === 'gate.png,lobby.png' && shots[1] === 'gate.png,lobby.png' && /PASS T-901/.test(out(c)) && /the game's own capture command/.test(hintCmd.why || '') && !/--godot/.test(hintCmd.why || ''),
    `before (${b.status}): ${out(b).slice(-300)}\nafter (${a.status}): ${out(a).slice(-300)}\ncheck (${c.status}): ${out(c).slice(-300)}\nshots: ${shots.join(' | ')}\nhint: ${hintCmd.why || hintCmd.raw}`);

  // The intent stays: a command that saves nothing fails, and an unchanged after fails the check.
  const nothing = run(dir, 'node harness/visual-proof.mjs capture T-902 before', { ...env, CAPTURE_259F_NOTHING: '1' });
  run(dir, 'node harness/visual-proof.mjs capture T-903 before --cams lobby', env);
  run(dir, 'node harness/visual-proof.mjs capture T-903 before --cams lobby', env);
  fs.mkdirSync(path.join(dir, '.studio', 'proof', 'T-903', 'visual', 'after'), { recursive: true });
  const beforeShot = path.join(dir, '.studio', 'proof', 'T-903', 'visual', 'before', 'lobby.png');
  if (fs.existsSync(beforeShot)) fs.copyFileSync(beforeShot, path.join(dir, '.studio', 'proof', 'T-903', 'visual', 'after', 'lobby.png'));
  const same = run(dir, 'node harness/visual-proof.mjs check T-903', env);
  report('2.59.0: the same proof rules hold for a game\'s own capture: a command that saves no picture fails, and an after identical to before fails the check',
    nothing.status === 1 && /saved no \.png/.test(out(nothing)) && same.status === 1 && /FAIL T-903/.test(out(same)),
    `nothing (${nothing.status}): ${out(nothing).slice(-300)}\nsame (${same.status}): ${out(same).slice(-300)}`);

  // A Godot-track task keeps the Godot hint.
  const godotHint = probe(`import { summarize } from ${u('harness/verdict-split.mjs')};
console.log(JSON.stringify(summarize('T-904', { id: 'T-904', title: 'Port the lobby scene', role: 'engine-porter', track: 'engine:godot' }, { parts: {} })));`);
  report('2.59.0: a Godot-track render task still gets the Godot capture hint, even when the main game has its own capture command',
    godotHint.render === true && /--godot <project>/.test(godotHint.why || '') && !/the game's own capture command/.test(godotHint.why || ''),
    godotHint.why || godotHint.raw);

  if (before === null) fs.rmSync(gameJson, { force: true }); else fs.writeFileSync(gameJson, before);
  fs.rmSync(path.join(dir, 'web', 'demo259f'), { recursive: true, force: true });
}
