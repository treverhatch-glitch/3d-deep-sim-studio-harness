/**
 * qa/selftest-2671j.mjs — 2.67.1 (helper j): the asset track (harness/asset-gate.mjs).
 *   1. triangles per LOD over budget fail (LOD0 by default, a _LOD1 mesh against its own budget); an asset in budget passes;
 *   2. a texture over textureMaxPx fails, loose or embedded in a .glb;
 *   3. a new asset file with no manifest row fails; 4. an NC licence is blocked; 5. CC-BY needs its credit line;
 *   6. a configured brand name in a glTF node name fails; 7. a model with no preview render fails;
 *   8. the round trip: a failing command fails, a passing one passes, none configured and a program that isn't
 *      installed are skips with a note;
 *   9. share-alike asks: refused until a game dev's yes, which a worker can't record;
 *  10. task done on --track asset runs the gate (a refusal with a Fix line, kept for the hand-back facts), then lands
 *      and files ONE "Wire in" task --after it (Unity track when Unity is configured), never twice.
 * Fixtures (tiny .glb and .png files) are written by the test; no binary file is committed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export async function selftest2671J({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const guard = (name, fn) => { try { const [ok, detail] = fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const events = path.join(dir, '.studio', 'events-2671j.jsonl');
  const base = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_MAIN_ROOT: '', STUDIO_HEAVY_SLOTS: '1', STUDIO_HEAVY_HELD: '', STUDIO_GATE_PRIORITY: '', STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_GAME: '', STUDIO_TRAIN: 'off', STUDIO_GATE_CHANGED: '', STUDIO_DONE_GAME_GATES: 'skip', STUDIO_VISUAL_GATE: 'off', STUDIO_DONE_NOOP: 'allow', STUDIO_DONE_UNCOMMITTED: 'allow', STUDIO_REACHABILITY: 'off', STUDIO_HOOKS_CHECK: 'off', STUDIO_WEAKENED_TESTS: 'off', STUDIO_DONE_UNITY_GATE: 'skip', npm_lifecycle_event: '', AGENT_EVENTS_FILE: events, CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '' };
  const evs = () => { try { return fs.readFileSync(events, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return {}; } }); } catch { return []; } };
  const w = (rel, data) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); return rel; };

  // ---------- fixtures ----------
  const png = (wd, ht) => {
    const b = Buffer.alloc(8 + 25 + 12);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(wd, 16); b.writeUInt32BE(ht, 20); b[24] = 8; b[25] = 6;
    b.writeUInt32BE(0, 33); b.write('IEND', 37, 'latin1');
    return b;
  };
  /** A binary glTF: meshes [{ name, tris }], a node per mesh (nodeName), material names, an optional embedded PNG. */
  const glb = ({ meshes = [{ name: 'Crate', tris: 12 }], nodeNames = null, materials = ['CrateMat'], embed = null, pos = null, parentScale = null } = {}) => {
    const accessors = [];
    const gm = meshes.map((m) => { accessors.push({ bufferView: 0, componentType: 5123, count: m.tris * 3, type: 'SCALAR' }); accessors.push({ bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', ...(pos ? { min: pos.min, max: pos.max } : {}) }); return { name: m.name, primitives: [{ attributes: { POSITION: accessors.length - 1 }, indices: accessors.length - 2, material: 0 }] }; });
    const binParts = [Buffer.alloc(64)];
    const bufferViews = [{ buffer: 0, byteOffset: 0, byteLength: 64 }];
    const json = { asset: { version: '2.0' }, scenes: [{ nodes: gm.map((_, i) => i) }], nodes: gm.map((m, i) => ({ name: nodeNames?.[i] || m.name, mesh: i })), meshes: gm, materials: materials.map((n) => ({ name: n })), accessors, bufferViews };
    if (parentScale) { json.nodes.push({ name: 'Root', scale: parentScale, children: gm.map((_, i) => i) }); json.scenes[0].nodes = [json.nodes.length - 1]; }
    if (embed) { binParts.push(embed); bufferViews.push({ buffer: 0, byteOffset: 64, byteLength: embed.length }); json.images = [{ name: 'albedo', bufferView: 1, mimeType: 'image/png' }]; json.textures = [{ source: 0 }]; }
    let bin = Buffer.concat(binParts);
    bin = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
    json.buffers = [{ byteLength: bin.length }];
    let js = Buffer.from(JSON.stringify(json));
    js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
    const head = Buffer.alloc(12); head.write('glTF', 0, 'latin1'); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
    const ch = (type, data) => { const h = Buffer.alloc(8); h.writeUInt32LE(data.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, data]); };
    return Buffer.concat([head, ch(0x4e4f534a, js), ch(0x004e4942, bin)]);
  };

  const gameJson = path.join(dir, 'studio', 'game.json');
  const gameBefore = fs.existsSync(gameJson) ? JSON.parse(fs.readFileSync(gameJson, 'utf8')) : {};
  const setGame = (assets, extra = {}) => fs.writeFileSync(gameJson, JSON.stringify({ ...gameBefore, ...extra, assets }, null, 2));
  const manifest = path.join(dir, 'studio', 'assets', 'manifest.json');
  const rows = [];
  const row = (file, licence, more = {}) => { rows.push({ id: `A-${rows.length + 1}`, file, use: 'game', licence, ...more }); fs.mkdirSync(path.dirname(manifest), { recursive: true }); fs.writeFileSync(manifest, JSON.stringify({ assets: rows }, null, 2)); };
  /** A model with its preview and an own-work row. */
  const model = (name, opts = {}, { preview = true, licence = 'own work', more = {} } = {}) => {
    const rel = w(`assets/props/${name}.glb`, glb(opts));
    if (preview) w(`assets/props/${name}.preview.png`, png(256, 256));
    if (licence !== null) row(rel, licence, more);
    return rel;
  };
  const gate = (files, { rt = false, env = {} } = {}) => {
    const r = run(dir, `node harness/asset-gate.mjs --json${rt ? '' : ' --no-round-trip'} --files ${files.join(',')}`, { ...base, ...env });
    let j = null;
    try { j = JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch {}
    return { code: r.status, j, text: out(r) };
  };
  const failsOn = (g, check, file) => Boolean(g.j?.failures?.some((f) => f.check === check && f.file === file && /\S/.test(f.fix || '')));
  const show = (g) => JSON.stringify({ code: g.code, j: g.j ? { status: g.j.status, failures: g.j.failures, notes: g.j.notes } : null, text: g.j ? '' : g.text.slice(-800) }).slice(0, 2500);

  setGame({ paths: ['assets'], triangleBudget: { lod0: 2500, lod1: 1200 }, textureMaxPx: 2048, previewRequired: true, brandNames: ['Zentrix'] });

  // 1. triangles
  {
    const ok = model('crate', { meshes: [{ name: 'Crate', tris: 2400 }, { name: 'Crate_LOD1', tris: 1100 }] });
    const big = model('tower', { meshes: [{ name: 'Tower', tris: 3000 }] });
    const lod1 = model('mast', { meshes: [{ name: 'Mast', tris: 2000 }, { name: 'Mast_LOD1', tris: 1300 }] });
    const good = gate([ok]);
    const g = gate([big, lod1]);
    guard('2.67.1 (j1): a .glb over its triangle budget fails per LOD (LOD0 3000 > 2500; a _LOD1 mesh 1300 > its own 1200), counted from the glTF accessors; one in budget passes (2.67.0: no asset gate)', () => [
      good.code === 0 && good.j?.status === 'pass' && g.code === 1 && failsOn(g, 'triangles', big) && failsOn(g, 'triangles', lod1) && g.j.failures.filter((f) => f.check === 'triangles').length === 2 && /LOD 1 has 1300/.test(JSON.stringify(g.j.failures)),
      `${show(good)}\n${show(g)}`]);
  }
  // 2. textures
  {
    const loose = w('assets/tex/wall_albedo.png', png(4096, 1024));
    row(loose, 'CC0');
    const fine = w('assets/tex/floor_albedo.png', png(2048, 2048));
    row(fine, 'CC0');
    const emb = model('barrel', { embed: png(1024, 4096) });
    const g = gate([loose, fine, emb]);
    guard('2.67.1 (j2): a texture over textureMaxPx fails, a loose PNG (4096x1024) and one embedded in a .glb (1024x4096); a 2048 one passes (2.67.0: no asset gate)', () => [
      g.code === 1 && failsOn(g, 'texture', loose) && failsOn(g, 'texture', emb) && !failsOn(g, 'texture', fine), show(g)]);
  }
  // 3-5. licence rows
  {
    const norow = model('bench', {}, { licence: null });
    const nc = model('lamp', {}, { licence: 'CC BY-NC 4.0', more: { credit: 'Lamp by Someone, CC BY-NC 4.0' } });
    const byNo = model('sign', {}, { licence: 'CC-BY-4.0' });
    const byYes = model('cone', {}, { licence: 'CC-BY-4.0', more: { credit: 'Cone by Someone, CC BY 4.0, example.test/cone' } });
    const g = gate([norow, nc, byNo, byYes]);
    guard('2.67.1 (j3): a new asset file with no row in the assets manifest fails the licence check, with a Fix line (2.67.0: no asset gate)', () => [g.code === 1 && failsOn(g, 'licence', norow) && /npm run asset -- add/.test(g.j.failures.find((f) => f.file === norow)?.fix || ''), show(g)]);
    guard('2.67.1 (j4): a non-commercial (NC) licence is blocked even with a credit line (2.67.0: no asset gate)', () => [failsOn(g, 'licence', nc) && /blocked/.test(JSON.stringify(g.j.failures.filter((f) => f.file === nc))), show(g)]);
    guard('2.67.1 (j5): CC-BY without a credit line fails the credit check; CC-BY with one passes (2.67.0: no asset gate)', () => [failsOn(g, 'credit', byNo) && !g.j.failures.some((f) => f.file === byYes), show(g)]);
  }
  // 6. brand names
  {
    const branded = model('hauler', { meshes: [{ name: 'Hauler', tris: 100 }], nodeNames: ['ZENTRIX_logo_plate'] });
    const plain = model('hauler2', { meshes: [{ name: 'Hauler', tris: 100 }] });
    const g = gate([branded, plain]);
    guard('2.67.1 (j6): a configured brand name in a glTF node name fails (case-insensitive); the same model without it passes (2.67.0: no asset gate)', () => [g.code === 1 && failsOn(g, 'brand', branded) && !g.j.failures.some((f) => f.file === plain), show(g)]);
  }
  // 7. preview
  {
    const nop = model('fence', {}, { preview: false });
    const g = gate([nop]);
    guard('2.67.1 (j7): a model with no preview render next to it fails when previewRequired (2.67.0: no asset gate)', () => [g.code === 1 && failsOn(g, 'preview', nop) && /blender -b --factory-startup/.test(g.j.failures[0]?.fix || ''), show(g)]);
  }
  // 8. round trip
  {
    const m = model('pallet');
    const script = path.join(tmpRoot, `rt-2671j-${process.pid}.mjs`);
    const seen = path.join(tmpRoot, `rt-2671j-${process.pid}.log`);
    fs.writeFileSync(script, `import fs from 'node:fs';\nconst locks = ${JSON.stringify(path.join(dir, '.studio', 'locks'))};\nconst held = fs.existsSync(locks) && fs.readdirSync(locks).some((f) => /^machine-heavy-\\d+\\.lock$/.test(f));\nfs.appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ file: process.argv[2], held }) + '\\n');\nif (process.env.RT_FAIL === '1') { console.log('re-import: scale mismatch'); process.exit(1); }\nconsole.log('round trip ok');\n`);
    const cmd = `node "${script}" {file}`;
    const cfg = (roundTrip) => setGame({ paths: ['assets'], brandNames: ['Zentrix'], ...(roundTrip ? { roundTrip } : {}) });
    cfg({ command: cmd });
    const bad = gate([m], { rt: true, env: { RT_FAIL: '1' } });
    const good = gate([m], { rt: true, env: { RT_FAIL: '0' } });
    let runs = [];
    try { runs = fs.readFileSync(seen, 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch {}
    cfg(null);
    const none = gate([m], { rt: true });
    cfg({ command: 'blender-not-installed-2671j -b --factory-startup -P x.py -- {file}' });
    const absent = gate([m], { rt: true });
    guard('2.67.1 (j8a): the configured round-trip command exiting non-zero fails the gate with its last lines (2.67.0: no asset gate)', () => [bad.code === 1 && failsOn(bad, 'roundtrip', m) && /scale mismatch/.test(JSON.stringify(bad.j.failures)), show(bad)]);
    guard('2.67.1 (j8b): a round-trip command exiting 0 passes, run once per model ({file}) under the machine:heavy lock (2.67.0: no asset gate)', () => [good.code === 0 && good.j?.status === 'pass' && runs.length === 2 && runs.every((r) => r.file === m && r.held), `${show(good)}\n${JSON.stringify(runs)}`]);
    guard('2.67.1 (j8c): no round-trip command configured, or its program not installed: skipped with a note, not a failure (2.67.0: no asset gate)', () => [none.code === 0 && none.j?.status === 'pass' && none.j.notes.some((n) => /no round-trip command is configured/.test(n)) && absent.code === 0 && absent.j.notes.some((n) => /isn't installed/.test(n)), `${show(none)}\n${show(absent)}`]);
    setGame({ paths: ['assets'], brandNames: ['Zentrix'] });
  }
  // 9. share-alike asks
  {
    const sa = model('crate_sa', {}, { licence: 'CC-BY-SA-4.0', more: { credit: 'Crate by Someone, CC BY-SA 4.0' } });
    const before = gate([sa]);
    const worker = run(dir, `node harness/asset-gate.mjs allow ${sa} --by Dana --permission "Dana said yes in chat at 11:40"`, { ...base, STUDIO_LOCK_OWNER: 'builder-s3' });
    const stillRed = gate([sa]);
    const person = run(dir, `node harness/asset-gate.mjs allow ${sa} --by Dana --permission "Dana said yes in chat at 11:40"`, { ...base });
    const after = gate([sa]);
    guard('2.67.1 (j9): a share-alike licence fails until a game dev\'s yes (tier C); a worker can\'t record it, a person can, and then it passes (2.67.0: no asset gate)', () => [
      failsOn(before, 'licence-ask', sa) && worker.status !== 0 && failsOn(stillRed, 'licence-ask', sa) && person.status === 0 && after.code === 0 && after.j?.status === 'pass',
      `${show(before)}\nworker: ${out(worker).slice(-300)}\nperson: ${out(person).slice(-300)}\n${show(after)}`]);
  }

  // 11. scale within spec (owner, 11:30)
  {
    const half = { min: [-0.25, 0, -0.2], max: [0.25, 0.5, 0.2] }; // 0.5 x 0.5 x 0.4 m mesh
    const right = model('box_ok', { pos: half, parentScale: [2, 2, 2] }, { more: { size: { w: 1, d: 0.8, h: 1 } } }); // node scale applied: 1 x 0.8 x 1
    const cm = model('box_cm', { pos: { min: [-50, 0, -40], max: [50, 100, 40] } }, { more: { size: { w: 1, d: 0.8, h: 1 } } }); // exported in centimetres
    const side = model('box_side', { pos: half });
    w('assets/props/box_side.asset.json', JSON.stringify({ size: [1, 0.8, 1] }));
    const unknown = model('box_nosize', { pos: half });
    const g = gate([right, cm, side, unknown]);
    guard('2.67.1 (j11): scale within spec: the bounding box in metres (accessor min/max with node scales applied) against the row\'s or <name>.asset.json\'s size ± tolerance; a centimetre export and an unscaled mesh fail, the scaled one passes, no size is a note (2.67.0: no asset gate)', () => [
      g.code === 1 && failsOn(g, 'scale', cm) && failsOn(g, 'scale', side) && !g.j.failures.some((f) => f.file === right) && !g.j.failures.some((f) => f.file === unknown) && g.j.notes.some((n) => n.startsWith(`${unknown}: no expected size`)) && /100 x 80 x 100 m/.test(JSON.stringify(g.j.failures)),
      show(g)]);
  }

  // 10. task done on the asset track, and the hand-off
  {
    const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd: dir, encoding: 'utf8' });
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n.studio/\n');
    g('init', '-q', '-b', 'main'); g('add', '-A'); g('commit', '-qm', 'start');
    const task = (cmd, env = {}) => run(dir, `node harness/task.mjs ${cmd}`, { ...base, ...env });
    const idOf = (r) => (out(r).match(/"id":\s*"(T-\d+)"/) || [])[1];
    const added = (id) => evs().filter((e) => e.type === 'task.added' && e.task === id).pop()?.meta || {};
    // 2.70.0 (v): an asset whose checks pass lands only after a look by someone other than its maker.
    const reviewed = (id, asset) => { const w8 = task(`done ${id} --agent artist-2671j`); const rv = run(dir, `node harness/assets.mjs review ${asset} --pass --by art-director-2671j`, { ...base, STUDIO_LOCK_OWNER: 'art-director-2671j' }); return { waited: w8.status !== 0 && /wait.? for a look/.test(out(w8)), passed: rv.status === 0 }; };
    // a: refused (no row), then lands and hands off to a builder task
    const a = idOf(task('add "Plan asset: dock crane prop" --role asset-3d --track asset --prototype'));
    task(`start ${a} --agent artist-2671j`);
    const glbA = w('assets/dock/crane.glb', glb({ meshes: [{ name: 'Crane', tris: 500 }] }));
    w('assets/dock/crane.preview.png', png(256, 256));
    g('add', '-A'); g('commit', '-qm', 'crane');
    const refused = task(`done ${a} --agent artist-2671j`);
    let facts = null;
    try { facts = JSON.parse(fs.readFileSync(path.join(dir, '.studio', 'handback-facts', `${a}.json`), 'utf8')); } catch {}
    row(glbA, 'own work');
    g('add', '-A'); g('commit', '-qm', 'crane row');
    const rvA = reviewed(a, 'dock-crane');
    const done = task(`done ${a} --agent artist-2671j`);
    const hand = evs().filter((e) => e.type === 'asset.handoff' && e.meta?.from === a);
    const wid = hand[0]?.meta?.id;
    const wmeta = wid ? added(wid) : {};
    // a second landing of the same asset task never files a second one
    const again = run(dir, `node -e "Promise.all([import('./harness/asset-gate.mjs'), import('./harness/task.mjs')]).then(([ag, t]) => console.log(JSON.stringify(ag.fileAssetHandoff({ task: '${a}', addTask: t.addTask }))))"`, { ...base });
    const handAfter = evs().filter((e) => e.type === 'asset.handoff' && e.meta?.from === a).length;
    const wires = evs().filter((e) => e.type === 'task.added' && (e.msg?.replace(/^Queued T-\d+ \[\w+\] \([\w-]+\): /, '') || '').startsWith('Wire in crane.glb')).length;
    guard('2.67.1 (j10a): task done on --track asset runs the asset gate: refused with the FAIL line and its Fix (missing row), kept for the hand-back facts; with the row it lands (2.67.0: it closed with no asset checks)', () => [
      refused.status !== 0 && /\[asset-gate\] FAIL licence assets\/dock\/crane\.glb/.test(out(refused)) && /\[asset-gate\] Fix: /.test(out(refused)) && (facts?.gates || []).some((x) => x.id === 'asset' && !x.ok) && /FAIL licence assets\/dock\/crane\.glb/.test(facts?.text || '') && rvA.waited && rvA.passed && done.status === 0,
      JSON.stringify({ refused: out(refused).slice(-900), facts, rvA, done: out(done).slice(-600) }).slice(0, 3000)]);
    guard('2.67.1 (j10b): a landed asset task files ONE "Wire in" builder task naming its files, --after the asset task; a second landing files none (2.67.0: no hand-off)', () => [
      hand.length === 1 && wid && wmeta.after?.includes(a) && (wmeta.assetFiles || []).includes(glbA) && !wmeta.track && /"already":true/.test(out(again)) && handAfter === 1 && wires === 1,
      JSON.stringify({ hand, wmeta, again: out(again).slice(-300), handAfter, wires }).slice(0, 2500)]);
    // b: the studio has Unity configured: the hand-off is on the Unity track
    setGame({ paths: ['assets'], brandNames: ['Zentrix'] }, { engines: { unity: { land: 'node land.mjs {branch}' } } });
    g('add', '-A'); g('commit', '-qm', 'unity on');
    const b = idOf(task('add "Plan asset: tug boat prop" --role asset-3d --track asset --prototype'));
    task(`start ${b} --agent artist-2671j-b`);
    const glbB = w('assets/dock/tug.glb', glb({ meshes: [{ name: 'Tug', tris: 800 }] }));
    w('assets/dock/tug.preview.png', png(256, 256));
    row(glbB, 'CC0');
    g('add', '-A'); g('commit', '-qm', 'tug');
    const w8b = task(`done ${b} --agent artist-2671j-b`);
    const rvB = run(dir, 'node harness/assets.mjs review dock-tug --pass --by art-director-2671j', { ...base, STUDIO_LOCK_OWNER: 'art-director-2671j' });
    const doneB = task(`done ${b} --agent artist-2671j-b`);
    const hb = evs().filter((e) => e.type === 'asset.handoff' && e.meta?.from === b);
    const bmeta = hb[0]?.meta?.id ? added(hb[0].meta.id) : {};
    guard('2.67.1 (j10c): with the Unity engine configured the hand-off task is on the Unity track (--track engine:unity, an engine-porter), --after the asset task (2.67.0: no hand-off)', () => [
      w8b.status !== 0 && rvB.status === 0 && doneB.status === 0 && hb.length === 1 && bmeta.track === 'engine:unity' && bmeta.after?.includes(b) && /engine-porter/.test(evs().find((e) => e.type === 'task.added' && e.task === hb[0].meta.id)?.msg || ''),
      JSON.stringify({ doneB: out(doneB).slice(-700), hb, bmeta }).slice(0, 2500)]);
  }
}
