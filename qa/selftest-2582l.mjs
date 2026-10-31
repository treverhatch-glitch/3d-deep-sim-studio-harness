/**
 * qa/selftest-2582l.mjs — 2.58.2 (PU-22): the sim-purity gate flags engine-dependent Math calls in sim code.
 *   Math.sin, cos, atan2, hypot, pow, exp, log and the rest (and **) give different last bits in different
 *   engines; a sim that must replay the same in a port calls a detMath module instead. Per game: "warn" (the
 *   default), "required" (new games), "off". Aliases, computed keys and imported wrappers are caught; the
 *   detMath module itself is exempt; the runtime probe traps the same functions while a cartridge plays.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest2582L({ dir, run, report }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const env = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off' };
  const purity = (args = '') => run(dir, `node scripts/check-sim-purity.mjs${args ? ` ${args}` : ''}`, env);
  const ANCHOR = '  state.tick += 1;\n';
  const carts = [];
  // A cartridge copied from the template, with `plant` lines after the tick and extra files. Returns the
  // 1-based line of each planted line.
  const mk = (name, { meta, plant = [], files = {}, head = '' } = {}) => {
    const d = path.join(dir, 'cartridges', name);
    fs.cpSync(path.join(dir, 'cartridges', '_template'), d, { recursive: true });
    carts.push(d);
    const f = path.join(d, 'index.mjs');
    let src = fs.readFileSync(f, 'utf8');
    src = head + src.replace(ANCHOR, ANCHOR + plant.map((l) => `  ${l}\n`).join(''));
    fs.writeFileSync(f, src);
    if (meta !== undefined) fs.writeFileSync(path.join(d, 'cartridge.json'), JSON.stringify({ detMath: meta }, null, 2));
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
      fs.writeFileSync(path.join(d, rel), text);
    }
    const lines = src.split('\n');
    return plant.map((l) => lines.indexOf(`  ${l}`) + 1);
  };
  const clear = () => { while (carts.length) fs.rmSync(carts.pop(), { recursive: true, force: true }); };
  const has = (text, re) => re.test(text);

  // Required mode: Math.sin, a destructured cos, a bracket atan2, an alias's hypot and x ** 0.5 are reported with
  // file:line and the function; Math.sqrt, Math.floor and 2 ** 10 (exact) are not; the gate fails.
  const req = mk('dm-req', {
    meta: 'required',
    plant: [
      'const a1 = Math.sin(state.tick);',
      'const { cos } = Math; const a2 = cos(1);',
      "const a3 = Math['atan2'](1, 2);",
      'const MM = Math; const a4 = MM.hypot(3, 4);',
      'const a5 = state.tick ** 0.5;',
      'const ok1 = Math.sqrt(state.tick) + Math.floor(1.5) + 2 ** 10;',
    ],
  });
  const r1 = purity();
  const o1 = out(r1);
  const at = (n, fn) => new RegExp(`cartridges/dm-req/index\\.mjs:${n} \\[DET_MATH\\][^\\n]*${fn.replace(/[*[\]().]/g, '\\$&')}`).test(o1);
  report('2.58.2 (PU-22): in required mode a planted Math.sin, a destructured { cos } = Math, Math[\'atan2\'], an alias\'s M.hypot and x ** 0.5 in sim code are each reported (file:line, function, the detMath suggestion) and the purity gate fails; Math.sqrt, Math.floor and 2 ** 10 on their own line are not reported',
    r1.status === 1 && at(req[0], 'Math.sin()') && at(req[1], '{ cos }') && at(req[2], "Math['atan2']") && at(req[3], 'Math.hypot()') && at(req[4], '** operator') && !new RegExp(`dm-req/index\\.mjs:${req[5]} `).test(o1) && /use the game's detMath module \(sin, cos, atan2, hypot, …\) written to give the same bits in every engine/.test(o1),
    `${JSON.stringify(req)}\n${o1.slice(0, 2500)}`);
  clear();

  // Warn mode (the default when a game says nothing): printed, statically and at runtime, and the gate passes.
  const wl = mk('dm-warn', { plant: ['const w1 = Math.sin(state.tick);'] });
  const r2 = purity();
  const o2 = out(r2);
  report('2.58.2 (PU-22): with no detMath setting (an existing game) the mode is warn: the planted Math.sin is printed as a WARN with its file:line, the runtime probe prints the call it saw, and the purity gate still passes',
    r2.status === 0 && has(o2, new RegExp(`WARN deterministic math: 1 engine-dependent Math use\\(s\\) in cartridge dm-warn \\(mode warn, from the default`)) && has(o2, new RegExp(`! cartridges/dm-warn/index\\.mjs:${wl[0]} \\[DET_MATH\\] Math\\.sin\\(\\)`)) && has(o2, new RegExp(`\\[sim-runtime\\] WARN dm-warn called engine-dependent Math[^\\n]*\\n\\s+! cartridges/dm-warn/index\\.mjs:${wl[0]} Math\\.sin`)),
    o2.slice(0, 2500));
  clear();

  // The detMath module may use Math (a file named detMath, a folder named detMath, or a path in "allow"); the same
  // code in an ordinary helper is reported through the import that reaches it.
  const trig = 'export const sin = (x) => Math.sin(x);\nexport function atan2(y, x) {\n  return Math.atan2(y, x);\n}\n';
  mk('dm-exempt', { meta: 'required', head: "import { sin } from './detMath.mjs';\nimport { atan2 } from './trig/detMath/index.mjs';\nimport { sin as s2 } from './fastTrig.mjs';\n", plant: ['const e1 = sin(1) + atan2(1, 2) + s2(3);'], files: { 'detMath.mjs': trig, 'trig/detMath/index.mjs': trig, 'fastTrig.mjs': trig } });
  fs.writeFileSync(path.join(dir, 'cartridges', 'dm-exempt', 'cartridge.json'), JSON.stringify({ detMath: { mode: 'required', allow: ['fastTrig.mjs'] } }));
  const r3a = purity();
  mk('dm-helper', { meta: 'required', head: "import { sin } from './helpers.mjs';\n", plant: ['const e2 = sin(1);'], files: { 'helpers.mjs': trig } });
  const r3b = purity();
  report('2.58.2 (PU-22): the detMath module itself is exempt (a file named detMath.mjs, a detMath/ folder, and a file listed in "allow" may call Math.sin and Math.atan2; the required-mode gate passes, at runtime too), while the same code in an ordinary helpers.mjs inside the sim is reported and fails',
    r3a.status === 0 && !/DET_MATH|deterministic math|engine-dependent/.test(out(r3a)) && r3b.status === 1 && /cartridges\/dm-helper\/helpers\.mjs:1 \[DET_MATH\] Math\.sin\(\)/.test(out(r3b)) && /cartridges\/dm-helper\/helpers\.mjs:3 \[DET_MATH\] Math\.atan2\(\)/.test(out(r3b)),
    `${out(r3a).slice(0, 1500)}\n---\n${out(r3b).slice(0, 1500)}`);
  clear();

  // A wrapper outside the sim that just forwards to Math is reported at the sim's import line; importing an exact
  // helper from the same module is not.
  fs.mkdirSync(path.join(dir, 'lib-2582l'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib-2582l', 'mathx.mjs'), `${trig}export function clamp(v, a, b) {\n  return Math.min(b, Math.max(a, v));\n}\nexport { sin as sine };\n`);
  fs.writeFileSync(path.join(dir, 'lib-2582l', 'index.mjs'), "export { atan2 as angle, clamp } from './mathx.mjs';\n");
  mk('dm-wrap', { meta: 'required', head: "import { sine } from '../../lib-2582l/mathx.mjs';\nimport { angle } from '../../lib-2582l/index.mjs';\n", plant: ['const w2 = sine(1) + angle(1, 2);'] });
  mk('dm-clamp', { meta: 'required', head: "import { clamp } from '../../lib-2582l/mathx.mjs';\nimport { clamp as c2 } from '../../lib-2582l/index.mjs';\n", plant: ['const w3 = clamp(1, 0, 2) + c2(1, 0, 2);'] });
  const r4 = purity('--det-math-only');
  const o4 = out(r4);
  report('2.58.2 (PU-22): an imported wrapper that forwards to Math (export const sin = (x) => Math.sin(x), re-exported under another name and through an index file) is reported at the sim\'s import line with the module line it reaches; importing only clamp (Math.min/max) from the same modules is not',
    r4.status === 1 && /cartridges\/dm-wrap\/index\.mjs:1 \[DET_MATH\] imports sine from lib-2582l\/mathx\.mjs, which calls Math\.sin \(lib-2582l\/mathx\.mjs:1\)/.test(o4) && /cartridges\/dm-wrap\/index\.mjs:2 \[DET_MATH\] imports angle from lib-2582l\/index\.mjs, which calls Math\.atan2 \(lib-2582l\/mathx\.mjs:3\)/.test(o4) && !/dm-clamp/.test(o4),
    o4.slice(0, 2500));
  clear();
  fs.rmSync(path.join(dir, 'lib-2582l'), { recursive: true, force: true });

  // The runtime probe catches what no regex sees (Math held in an object), in required mode.
  const rt = mk('dm-rt', { meta: 'required', plant: ['const box = { m: Math }; const r5 = box.m.cbrt(8);'] });
  const r5 = purity();
  report('2.58.2 (PU-22): required mode at runtime: Math held in an object (box.m.cbrt) passes the static scan but the runtime probe fails the gate, naming Math.cbrt at the cartridge line that called it',
    r5.status === 1 && /static PASS/.test(out(r5)) && new RegExp(`\\[sim-runtime\\] FAIL dm-rt called engine-dependent Math[^\\n]*\\n\\s+x cartridges/dm-rt/index\\.mjs:${rt[0]} Math\\.cbrt \\(\\d+ calls?\\)`).test(out(r5)),
    out(r5).slice(0, 2500));
  clear();

  // "off" turns it off for that game.
  mk('dm-off', { meta: 'off', plant: ['const o1 = Math.sin(state.tick);'] });
  const r6 = purity('--det-math-only');
  report('2.58.2 (PU-22): "detMath": "off" skips that game (no warning, the deterministic-math check passes)', r6.status === 0 && /deterministic math PASS/.test(out(r6)) && !/dm-off/.test(out(r6)), out(r6).slice(0, 1500));
  clear();

  // The bundled cartridges stay clean even when required.
  const exMeta = path.join(dir, 'cartridges', 'example-sim', 'cartridge.json');
  const hadMeta = fs.existsSync(exMeta) ? fs.readFileSync(exMeta, 'utf8') : null;
  fs.writeFileSync(exMeta, JSON.stringify({ ...(hadMeta ? JSON.parse(hadMeta) : {}), detMath: 'required' }));
  const r7a = purity('--det-math-only');
  const r7b = purity();
  if (hadMeta === null) fs.rmSync(exMeta, { force: true }); else fs.writeFileSync(exMeta, hadMeta);
  report('2.58.2 (PU-22): the example cartridge and the template are clean: with example-sim set to required, the deterministic-math check passes with no warning, and so does the whole purity gate (static and runtime)',
    r7a.status === 0 && /\[sim-purity\] deterministic math PASS — \d+ file\(s\)/.test(out(r7a)) && !/WARN|DET_MATH/.test(out(r7a)) && r7b.status === 0 && !/WARN|DET_MATH/.test(out(r7b)),
    `${out(r7a)}\n${out(r7b)}`.slice(0, 2000));

  // A new game starts in required mode.
  const gameFile = path.join(dir, 'studio', 'game.json');
  const hadGame = fs.existsSync(gameFile) ? fs.readFileSync(gameFile, 'utf8') : null;
  const ng = run(dir, 'node scripts/new-game.mjs dm-new --keep-active', env);
  const ngDir = path.join(dir, 'cartridges', 'dm-new');
  let ngMeta = {};
  try { ngMeta = JSON.parse(fs.readFileSync(path.join(ngDir, 'cartridge.json'), 'utf8')); } catch {}
  const r8a = purity();
  const ngIdx = path.join(ngDir, 'index.mjs');
  fs.writeFileSync(ngIdx, fs.readFileSync(ngIdx, 'utf8').replace(ANCHOR, `${ANCHOR}  const p1 = Math.pow(2, 0.5);\n`));
  const r8b = purity();
  fs.rmSync(ngDir, { recursive: true, force: true });
  for (const f of ['dm-new-start-to-win.json', 'dm-new-seed-1.json']) fs.rmSync(path.join(dir, 'qa', 'golden', f), { force: true });
  report('2.58.2 (PU-22): npm run new-game writes "detMath": "required" into the new cartridge.json (beside its game ID); the new game passes the purity gate, and a Math.pow planted in it fails it',
    ng.status === 0 && ngMeta.detMath === 'required' && /^gid_/.test(ngMeta.id || '') && r8a.status === 0 && r8b.status === 1 && /cartridges\/dm-new\/index\.mjs:\d+ \[DET_MATH\] Math\.pow\(\)/.test(out(r8b)),
    `${out(ng).slice(0, 600)}\n${JSON.stringify(ngMeta)}\n${out(r8a).slice(0, 800)}\n${out(r8b).slice(0, 800)}`);

  // A studio game that isn't a cartridge opts in from its studio.gates.json: its sim paths are scanned, and the
  // game's own checks gain game:det-math (required or not, by mode).
  const gdir = path.join(dir, 'game', 'pier');
  fs.mkdirSync(path.join(gdir, 'src', 'sim'), { recursive: true });
  fs.writeFileSync(path.join(gdir, 'src', 'sim', 'boats.ts'), 'export function heading(dx: number, dy: number): number {\n  const len = Math.sqrt(dx * dx + dy * dy);\n  return Math.atan2(dy, dx) + len * 0;\n}\n');
  fs.writeFileSync(path.join(gdir, 'src', 'sim', 'detMath.ts'), 'export const atan2 = (y: number, x: number): number => Math.atan2(y, x);\n');
  const man = (detMath) => fs.writeFileSync(path.join(gdir, 'studio.gates.json'), JSON.stringify({ gates: [{ id: 'unit', command: 'node -e 0' }], detMath }, null, 2));
  fs.writeFileSync(gameFile, JSON.stringify({ ...(hadGame ? JSON.parse(hadGame) : {}), game: 'pier' }, null, 2));
  const probe = path.join(dir, '.probe-2582l-gates.mjs');
  fs.writeFileSync(probe, `const m = await import(${JSON.stringify(pathToFileURL(path.join(dir, 'harness', 'game-gates.mjs')).href)});\nconsole.log(JSON.stringify(m.declaredGates(await m.studioGame())));\n`);
  const gates = async () => {
    const r = run(dir, `node ${path.basename(probe)}`, env);
    try { return JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { return out(r); }
  };
  man({ mode: 'required', paths: ['src/sim'] });
  const g1 = await gates();
  const r9a = purity('--det-math-only');
  const r9g = run(dir, 'node harness/game-gates.mjs', env);
  man({ mode: 'warn', paths: ['src/sim'] });
  const g2 = await gates();
  const r9b = purity('--det-math-only');
  man('off');
  const g3 = await gates();
  if (hadGame === null) fs.rmSync(gameFile, { force: true }); else fs.writeFileSync(gameFile, hadGame);
  fs.rmSync(path.join(dir, 'game'), { recursive: true, force: true });
  fs.rmSync(probe, { force: true });
  const dm = (g) => (Array.isArray(g) ? g.find((x) => x.id === 'game:det-math') : null);
  report('2.58.2 (PU-22): a studio game opts in from its studio.gates.json "detMath" (mode, paths): required adds a required game:det-math check that fails on Math.atan2 in game/pier/src/sim (its detMath.ts exempt, Math.sqrt fine) and fails the game\'s checks; warn makes it optional and printed; off adds nothing',
    dm(g1)?.required === true && /check-sim-purity\.mjs --det-math-only/.test(dm(g1)?.command || '') && r9a.status === 1 && /game\/pier\/src\/sim\/boats\.ts:3 \[DET_MATH\] Math\.atan2\(\)/.test(out(r9a)) && !/boats\.ts:2 |detMath\.ts/.test(out(r9a)) && r9g.status === 1 && /FAIL game:det-math/.test(out(r9g)) && /PASS game:unit/.test(out(r9g))
      && dm(g2)?.required === false && r9b.status === 0 && /WARN deterministic math: 1 engine-dependent Math use\(s\) in game pier \(mode warn, from game\/pier\/studio\.gates\.json/.test(out(r9b)) && Array.isArray(g3) && !dm(g3),
    `${JSON.stringify(g1)}\n${out(r9a).slice(0, 800)}\n${out(r9g).slice(0, 800)}\n${JSON.stringify(g2)}\n${out(r9b).slice(0, 800)}\n${JSON.stringify(g3)}`);
}
