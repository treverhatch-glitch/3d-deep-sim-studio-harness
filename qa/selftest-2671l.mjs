/**
 * qa/selftest-2671l.mjs — 2.67.1 (l): one asset flow, `npm run asset -- need "<what>"`: the library first, reuse
 * first, the internet scout (a fixture offer list here: no network), pull + the Unity profile, else one make task.
 * Tiny generated glTF files only.
 */
import fs from 'node:fs';
import path from 'node:path';

/** A box glTF (12 triangles) with an embedded buffer; `s` scales it, `tag` makes the bytes differ. */
function boxGltf(s = 1, tag = 'box') {
  const p = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]].map((v) => v.map((x) => x * s));
  const idx = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 0, 3, 7, 0, 7, 4];
  const buf = Buffer.alloc(96 + 72);
  p.flat().forEach((x, i) => buf.writeFloatLE(x, i * 4));
  idx.forEach((x, i) => buf.writeUInt16LE(x, 96 + i * 2));
  return `${JSON.stringify({
    asset: { version: '2.0', generator: tag },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: tag }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: buf.length, uri: `data:application/octet-stream;base64,${buf.toString('base64')}` }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 96 }, { buffer: 0, byteOffset: 96, byteLength: 72 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [0, 0, 0], max: [s, s, s] }, { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' }],
  })}\n`;
}

export async function selftest2671L({ dir, run, report }) {
  const env = { NODE_PATH: '', STUDIO_LOCK_OWNER: '', STUDIO_AGENT: '', STUDIO_ROLE: '', STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_SKETCHFAB_KEY: '' };
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  const j = (rel) => { try { return JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8')); } catch { return null; } };
  const needs = () => { try { return fs.readdirSync(path.join(dir, '.studio/assets/needs')).filter((n) => /^N-\d+\.json$/.test(n)).map((n) => j(`.studio/assets/needs/${n}`)); } catch { return []; } };
  const asset = (args) => run(dir, `node harness/assets.mjs ${args}`, env);

  // The sources: the studio's own ledger, a shared library folder (indexed), an offer list standing in for the internet.
  w('studio/assets.json', `${JSON.stringify({ bar: 6, libraries: [{ id: 'shared', type: 'folder', dir: 'lib-shared' }], scout: { web: false, lists: ['fixtures/offers.json'] }, commands: { lod: 'blender-not-installed-2671l --background --python lod.py -- {in} {out} {ratio}' } }, null, 2)}\n`);
  w('assets/own/wooden_crate.gltf', boxGltf(1, 'crate'));
  const added = asset('add assets/own/wooden_crate.gltf --use game --owner "this studio" --licence "own work" --by dana');
  w('lib-shared/chairs/red_chair.gltf', boxGltf(0.9, 'chair'));
  w('lib-shared/misc/thing01.gltf', boxGltf(0.8, 'barrel'));
  w('lib-shared/manifest.json', JSON.stringify({ files: [{ file: 'chairs/red_chair.gltf', licence: 'CC-BY-NC-4.0', author: 'Someone', tags: ['chair', 'red'] }, { file: 'misc/thing01.gltf', licence: 'CC0' }] }));
  w('fixtures/dl/barrel_v2.gltf', boxGltf(0.8, 'barrel'));
  w('fixtures/dl/cone.gltf', boxGltf(2, 'cone'));
  w('fixtures/offers.json', JSON.stringify({ offers: [
    { title: 'Metal barrel', tags: ['barrel', 'metal'], licence: 'CC0', file: 'dl/barrel_v2.gltf', page: 'https://example.org/barrel', tris: 12 },
    { title: 'Traffic cone', tags: ['cone', 'traffic'], licence: 'CC-BY-4.0', author: 'Sam Example', file: 'dl/cone.gltf', page: 'https://example.org/cone' },
  ] }));
  const refresh1 = asset('library refresh lib-shared');
  const idxDir = path.join(dir, '.studio/assets/library');
  const idx = () => { try { return JSON.parse(fs.readFileSync(path.join(idxDir, fs.readdirSync(idxDir)[0]), 'utf8')); } catch { return null; } };
  const before = idx();

  // (a) a library hit stops the flow before the internet.
  const hit = asset('need "wooden crate" --for web --budget 500');
  const n1 = needs()[0];
  report('2.67.1 (l) asset need: a library hit stops the flow (found in the ledger, no scout, no make task)', added.status === 0 && hit.status === 0 && /found in library: studio:A-001/.test(out(hit)) && n1?.status === 'found' && !n1.trail.some((t) => ['scout', 'make'].includes(t.step)), out(added) + out(hit));

  // (b) reuse first: the same need again (words reordered) answers from the record and adds no second need.
  const again = asset('need "crate, wooden" --for web --budget 500');
  report('2.67.1 (l) asset need: the same need again says "already in library: <id>" and stops', again.status === 0 && /already in library: A-001/.test(out(again)) && needs().length === 1, out(again));

  // An NC-licensed library hit is skipped with its reason, never used.
  const nc = asset('need "red chair" --for web --budget 500');
  const n2 = needs().find((n) => n.what === 'red chair');
  report('2.67.1 (l) asset need: an NC-licensed library hit is skipped (logged why) and not used', refresh1.status === 0 && n2 && n2.status !== 'found' && n2.trail.some((t) => t.step === 'library' && /red_chair/.test(t.file || '') && /non-commercial/.test(t.why)), out(refresh1) + out(nc) + JSON.stringify(n2?.trail));

  // A hash duplicate under another name: the offer's bytes are the shared library's misc/thing01.gltf.
  const dup = asset('need "metal barrel" --for web --budget 500');
  const man = j('studio/assets/manifest.json');
  report('2.67.1 (l) asset need: an offer with the same content as a library file under another name is "already in library", not pulled', dup.status === 0 && /already in library: shared:L-[0-9a-f]+ misc\/thing01\.gltf/.test(out(dup)) && !man.assets.some((a) => /barrel_v2/.test(a.file)), out(dup));

  // Scout fixture hit -> pull -> Unity profile: normalised glTF, prefab stub, licence row; Blender LOD step skipped with a note.
  const cone = asset('need "traffic cone" --for unity --budget 1000 --size 0.7');
  const g = j('assets/adapted/unity/cone/cone.gltf');
  const stub = j('assets/adapted/unity/cone/cone.prefab.json');
  const root = g?.nodes?.find((n) => n.name === 'studio_root');
  const m2 = j('studio/assets/manifest.json');
  const gate = run(dir, 'node scripts/check-assets.mjs', env);
  const credits = (() => { try { return fs.readFileSync(path.join(dir, 'CREDITS.md'), 'utf8'); } catch { return ''; } })();
  report('2.67.1 (l) asset need: a scout hit is pulled and the Unity profile writes the normalised glTF (metres, bottom-centre pivot), a prefab stub with a collider and the licence row, and skips LODs with a note when Blender is not installed',
    cone.status === 0 && root && Math.abs(root.scale[0] - 0.35) < 1e-6 && root.translation[1] === 0 && Math.abs(g.asset.extras.studio.dims[0] - 0.7) < 1e-6
      && stub?.collider?.type === 'box' && Math.abs(stub.collider.size[1] - 0.7) < 1e-6 && stub.licence?.licence === 'CC-BY-4.0' && stub.licence?.author === 'Sam Example'
      && stub.lods.length === 3 && /not installed/.test(stub.lods[1].pending || '') && /LOD1: lod: blender-not-installed-2671l is not installed/.test(out(cone))
      && m2.assets.some((a) => a.file === 'assets/adapted/unity/cone/cone.prefab.json' && a.derivedFrom) && gate.status === 0 && /Sam Example/.test(credits),
    out(cone) + out(gate) + JSON.stringify(stub));

  // Nothing found -> one make task for the asset role; asked again, not a second one.
  const nextCount = () => (fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8').match(/Make asset: ornate fountain/g) || []).length;
  const make1 = asset('need "ornate fountain" --for unity --budget 3000 --size 2');
  const make2 = asset('need "ornate fountain" --for unity --budget 3000 --size 2');
  const n3 = needs().filter((n) => n.what === 'ornate fountain');
  report('2.67.1 (l) asset need: nothing found files ONE make task (asset-3d) with the brief, and not a second time',
    make1.status === 0 && /filed make task T-\d+ for asset-3d/.test(out(make1)) && /already asked/.test(out(make2)) && nextCount() === 1 && n3.length === 1 && n3[0].status === 'make' && /Triangle budget: 3000/.test(n3[0].brief || '') && /\(`asset-3d`\)/.test(fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8')),
    out(make1) + out(make2));

  // library refresh appends and never deletes: a removed file stays (marked missing), a new file is added.
  fs.rmSync(path.join(dir, 'lib-shared/chairs/red_chair.gltf'));
  w('lib-shared/new_lamp.gltf', boxGltf(0.5, 'lamp'));
  const refresh2 = asset('library refresh lib-shared');
  const after = idx();
  report('2.67.1 (l) asset library refresh: appends new files and never deletes (a gone file is kept, marked missing)',
    refresh2.status === 0 && before?.items?.length === 2 && after?.items?.length === 3 && after.items.some((i) => i.file === 'chairs/red_chair.gltf' && i.missing) && after.items.some((i) => i.file === 'new_lamp.gltf' && /^[0-9a-f]{64}$/.test(i.sha256)),
    out(refresh2) + JSON.stringify(after));
}
