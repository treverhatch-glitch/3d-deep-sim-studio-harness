/**
 * qa/selftest-270t.mjs — 2.70.0 (t): GPU area jobs, browser GPU flags (opt-in), Blender out of machine:heavy, and a
 * playable build + clip after each landing. Every machine profile is a stub (STUDIO_TEST_MACHINE: with a GPU, without
 * one, or "none" for a failed scan); Blender and the clip recorder are stub programs; the games are made up. Nothing
 * here scans the real machine or needs a GPU.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest270T({ dir, run, report, tmpRoot }) {
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  const evFile = path.join(dir, '.studio', 'events-270t.jsonl');
  const base = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_MAIN_ROOT: '', STUDIO_HEAVY_SLOTS: '', STUDIO_HEAVY_HELD: '', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '0.03', STUDIO_HEAVY_RAM_WAIT_MIN: '', STUDIO_GATE_PRIORITY: '', STUDIO_LOCK_OWNER: '', STUDIO_GAME: '', STUDIO_TEST_LOADAVG: '0', STUDIO_RAM_FLOOR_GB: '0', STUDIO_TEST_FREEMEM_MB: '', STUDIO_RESERVE_RAM_GB: '', STUDIO_GPU_RESERVE_GB: '', STUDIO_TEST_WORKERS: '', STUDIO_MACHINE_SCAN: '', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_BROWSER_GPU: '', STUDIO_GPU_AREA: '', STUDIO_BLENDER_THREADS: '', STUDIO_LANDING_BUILD: '', STUDIO_LANDING_CLIP_CMD: '', STUDIO_CARTRIDGE: '', STUDIO_TEST_MACHINE: '', AGENT_EVENTS_FILE: evFile };
  const machine = (o = {}) => JSON.stringify({ os: 'linux', cores: { logical: o.cores ?? 16 }, ram: { totalGb: o.total ?? 32, freeGb: o.free ?? 18, commitUsedGb: null, commitLimitGb: null }, gpus: o.gpus ?? [{ name: 'Test GPU', vramGb: 12, vramFreeGb: 11, busy: 0.03 }], disk: { freeGb: 100, totalGb: 500 }, power: { onBattery: false }, at: new Date(Date.now() - 60000).toISOString() });
  const noGpu = machine({ gpus: [] });
  let n = 0;
  const probe = (code, env = {}) => {
    const f = path.join(dir, `.probe-270t-${(n += 1)}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node "${f}"`, { ...base, ...env });
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return { ...JSON.parse(line), _err: String(r.stderr || '').slice(-1500) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const guard = async (name, fn) => { try { await fn(); } catch (e) { report(`${name} (threw)`, false, e.stack || String(e)); } };
  const clearLocks = () => { try { for (const f of fs.readdirSync(path.join(dir, '.studio', 'locks'))) if (/^machine-heavy|^gate-slot/.test(f)) fs.rmSync(path.join(dir, '.studio', 'locks', f), { force: true }); } catch {} };
  // Takes heavy jobs in order inside one process (each with its own env, so none counts as inside another's hold).
  const takes = (jobs) => `import { acquireHeavy } from ${u('harness/heavy.mjs')};
const logs = []; const got = [];
for (const j of ${JSON.stringify(jobs)}) {
  try { const lk = acquireHeavy(process.cwd(), j.label, { ...j, env: { ...process.env, STUDIO_HEAVY_HELD: '' }, log: (m) => logs.push(m) }); got.push({ label: j.label, ok: true, held: lk.held, claim: lk.claim || null }); }
  catch (e) { got.push({ label: j.label, ok: false, code: e.code, msg: e.message }); }
}
console.log(JSON.stringify({ got, logs }));`;
  const J = (x) => String(JSON.stringify(x)).slice(0, 2500);
  // A job that waited for the one slot (not for RAM, the GPU or a cap) and never started.
  const slotWait = (p, label) => p.got?.find((g) => g.label === label)?.code === 'HEAVY_BUSY' && (p.logs || []).some((l) => l.startsWith(`[heavy] ${label} waits for the machine:heavy lock (1 slot`)) && !(p.logs || []).some((l) => l.startsWith(`[heavy] ${label} took`));

  // ================= 1. the GPU area for jobs =================
  await guard('2.70.0 (t, 1)', () => {
    clearLocks();
    const jobs = [{ label: 'full verify', kind: 'verify' }, { label: 'round trip', kind: 'asset-roundtrip' }, { label: 'gpu play', kind: 'browser-playtest' }, { label: 'graphics tests', kind: 'unity-visual' }, { label: 'second blender', kind: 'blender-preview' }];
    const p = probe(takes(jobs), { STUDIO_TEST_MACHINE: machine({ total: 64, free: 40 }), STUDIO_HEAVY_SLOTS: '1', STUDIO_BROWSER_GPU: 'on' });
    const [v, rt, bp, uv, b2] = p.got || [];
    const logs = (p.logs || []).join('\n');
    report('2.70.0 (t, 1): with a GPU in the scan and one machine:heavy slot held by a CPU verify, the asset round trip, a browser playtest with GPU flags on (STUDIO_BROWSER_GPU=on) and a Unity graphics run take the GPU area (VRAM + a small RAM/CPU claim, area gpu) and start beside it; a second harness Blender job waits ("1 blender job already running", one at a time); each logs which area it took and why (fails on 2.69.0: the round trip and the playtest waited for the one slot, unity-visual was not a kind)',
      v?.ok && rt?.ok && bp?.ok && uv?.ok && rt.claim?.area === 'gpu' && rt.claim.gpuOnly === true && bp.claim?.area === 'gpu' && bp.claim.gpu?.vramGb === 1 && bp.claim.cpuThreads === 1 && uv.claim?.kind === 'unity-visual' && uv.claim.area === 'gpu'
        && b2 && !b2.ok && b2.code === 'HEAVY_BUSY' && /waiting: 1 blender job already running \(max 1; STUDIO_HEAVY_MAX_BLENDER/.test(b2.msg)
        && /round trip took the GPU area: mostly GPU work and the scan shows Test GPU/.test(logs) && /gpu play took the GPU area: the browser runs with GPU flags \(STUDIO_BROWSER_GPU=on\)/.test(logs),
      J(p));

    // No GPU in the scan, a failed scan: exactly the 2.69 claims (a slot).
    const want = { 'asset-roundtrip': { ramGb: 1, cpuThreads: 1, gpu: null, gpuOnly: false }, 'browser-playtest': { ramGb: 5, cpuThreads: 2, gpu: { vramGb: 1 }, gpuOnly: false } };
    const same = (c, k) => c && c.kind === k && c.ramGb === want[k].ramGb && c.cpuThreads === want[k].cpuThreads && JSON.stringify(c.gpu) === JSON.stringify(want[k].gpu) && c.gpuOnly === want[k].gpuOnly && c.area === undefined;
    clearLocks();
    const a = probe(takes([{ label: 'full verify', kind: 'verify' }, { label: 'round trip', kind: 'asset-roundtrip' }]), { STUDIO_TEST_MACHINE: noGpu, STUDIO_HEAVY_SLOTS: '1', STUDIO_BROWSER_GPU: 'on' });
    clearLocks();
    const b = probe(takes([{ label: 'full verify', kind: 'verify' }, { label: 'gpu play', kind: 'browser-playtest' }]), { STUDIO_TEST_MACHINE: 'none', STUDIO_BROWSER_GPU: 'on' });
    clearLocks();
    const c = probe(`import { jobClaim } from ${u('harness/heavy-budget.mjs')};
const p = ${noGpu};
console.log(JSON.stringify({ rt: jobClaim('asset-roundtrip', { profile: p }), bp: jobClaim('browser-playtest', { profile: p }), none: jobClaim('asset-roundtrip', { profile: null }) }));`, { STUDIO_BROWSER_GPU: 'on' });
    report('2.70.0 (t, 1): with no GPU in the scan, or a failed scan, the same jobs keep the 2.69 claims and wait for the slot behind the verify (HEAVY_BUSY after "waits for the machine:heavy lock (1 slot"), and the log says why ("took a machine:heavy slot: no GPU in the machine scan" / "no machine scan") (fails on 2.69.0: no line saying which area a job took)',
      a.got?.[0]?.ok && a.got?.[1]?.ok === false && slotWait(a, 'round trip') && b.got?.[0]?.ok && b.got?.[1]?.ok === false && slotWait(b, 'gpu play')
        && same(c.rt, 'asset-roundtrip') && same(c.bp, 'browser-playtest') && same(c.none, 'asset-roundtrip')
        && /a machine:heavy slot: no GPU in the machine scan/.test(c.rt?.areaWhy || '') && /no machine scan/.test(c.none?.areaWhy || ''),
      J({ a, b, c }));

    // Browser GPU off: the playtest stays a CPU job; STUDIO_GPU_AREA=off; machine-budget.json gpuJobs; VRAM too small.
    clearLocks();
    const d = probe(takes([{ label: 'full verify', kind: 'verify' }, { label: 'cpu play', kind: 'browser-playtest' }]), { STUDIO_TEST_MACHINE: machine(), STUDIO_HEAVY_SLOTS: '1' });
    clearLocks();
    const e = probe(takes([{ label: 'full verify', kind: 'verify' }, { label: 'round trip', kind: 'asset-roundtrip' }]), { STUDIO_TEST_MACHINE: machine(), STUDIO_HEAVY_SLOTS: '1', STUDIO_GPU_AREA: 'off' });
    clearLocks();
    write('studio/machine-budget.json', JSON.stringify({ gpuJobs: { 'asset-roundtrip': { ramGb: 2.5, vramGb: 3 } } }));
    const f = probe(takes([{ label: 'round trip', kind: 'asset-roundtrip' }]), { STUDIO_TEST_MACHINE: machine() });
    fs.rmSync(path.join(dir, 'studio', 'machine-budget.json'), { force: true });
    clearLocks();
    const g = probe(takes([{ label: 'bake A', kind: 'unity-bake' }, { label: 'preview', kind: 'blender-preview' }]), { STUDIO_TEST_MACHINE: machine({ gpus: [{ name: 'Small GPU', vramGb: 6, vramFreeGb: 5 }] }), STUDIO_HEAVY_SLOTS: '1' });
    clearLocks();
    report('2.70.0 (t, 1): every number is overridable: with STUDIO_BROWSER_GPU unset (off) the browser playtest renders on the CPU and waits for the slot ("the browser renders on the CPU"); STUDIO_GPU_AREA=off keeps the round trip in the slot; studio/machine-budget.json "gpuJobs" sets its GPU-area claim (2.5 GB RAM, 3 GB VRAM); a GPU job whose VRAM isn\'t free waits for the GPU ("waiting for the GPU") (fails on 2.69.0: none of these existed)',
      d.got?.[1]?.ok === false && slotWait(d, 'cpu play') && e.got?.[1]?.ok === false && slotWait(e, 'round trip')
        && f.got?.[0]?.ok && f.got[0].claim?.ramGb === 2.5 && f.got[0].claim?.gpu?.vramGb === 3 && f.got[0].claim?.area === 'gpu'
        && g.got?.[0]?.ok && g.got[0].claim?.area === 'gpu' && g.got?.[1]?.ok === false && /waiting for the GPU/.test(g.got[1].msg),
      J({ d, e, f, g }));
    const dw = probe(`import { jobClaim } from ${u('harness/heavy-budget.mjs')};
console.log(JSON.stringify({ c: jobClaim('browser-playtest', { profile: ${machine()} }), auto: jobClaim('browser-playtest', { profile: ${machine()}, env: { ...process.env, STUDIO_BROWSER_GPU: 'auto' } }) }));`);
    report('2.70.0 (t, 1): the claim says why a browser playtest keeps its slot ("the browser renders on the CPU (STUDIO_BROWSER_GPU is off by default)") and STUDIO_BROWSER_GPU=auto with a GPU in the scan moves it to the GPU area (fails on 2.69.0: no reason, no auto)',
      /a machine:heavy slot: the browser renders on the CPU \(STUDIO_BROWSER_GPU is off by default\)/.test(dw.c?.areaWhy || '') && dw.auto?.area === 'gpu' && /STUDIO_BROWSER_GPU=auto and the machine scan shows Test GPU/.test(dw.auto?.areaWhy || ''),
      J(dw));

    // Per-kind caps stay: one Unity (every Unity kind counts), even with free slots.
    const h = probe(takes([{ label: 'editor run', kind: 'unity' }, { label: 'graphics tests', kind: 'unity-visual' }, { label: 'bake', kind: 'unity-bake' }]), { STUDIO_TEST_MACHINE: machine({ total: 64, free: 50, cores: 28 }), STUDIO_HEAVY_SLOTS: '4' });
    clearLocks();
    report('2.70.0 (t, 1): per-kind caps stay: with free slots and a GPU, a Unity graphics run and a Unity bake wait while a Unity editor run holds ("1 unity job already running (max 1"): every Unity kind counts as one Unity (fails on 2.69.0: unity-visual and unity-bake were generic heavy jobs and started a second editor)',
      h.got?.[0]?.ok && h.got?.[1]?.ok === false && /waiting: 1 unity job already running \(max 1/.test(h.got[1].msg) && h.got?.[2]?.ok === false && /1 unity job already running/.test(h.got[2].msg),
      J(h));
  });

  // ================= 2. browser GPU flags (opt-in, UNVERIFIED) =================
  await guard('2.70.0 (t, 2)', () => {
    const p = probe(`import fs from 'node:fs';
import * as C from ${u('qa/chromium.mjs')};
const gpuM = ${machine()}; const noM = ${noGpu};
const launches = [];
const fake = { launch: async (o) => { launches.push(o); return { close: async () => {} }; } };
const env = (v) => ({ ...process.env, STUDIO_BROWSER_GPU: v, PLAYWRIGHT_CHROMIUM: '/x/chrome' });
const b1 = await C.launchChromium(fake, { args: ['--use-angle=metal'] }, { env: env('on'), platform: 'darwin', profile: noM });
const b2 = await C.launchChromium(fake, { args: ['--foo'] }, { env: env('on'), platform: 'win32', profile: noM });
const b3 = await C.launchChromium(fake, { args: ['--foo'] }, { env: env(''), platform: 'linux', profile: gpuM });
const b4 = await C.launchChromium(fake, {}, { env: env('auto'), platform: 'linux', profile: gpuM });
const b5 = await C.launchChromium(fake, {}, { env: env('auto'), platform: 'linux', profile: noM });
const page = (r) => ({ evaluate: async () => ({ renderer: r, vendor: 'Google Inc.', unmasked: true, webgl: true }) });
const said = [];
const file = process.cwd() + '/.studio/renderer-270t.json';
const r1 = await C.rendererReport(b1, page('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'), { log: (m) => said.push(m), env: { ...process.env, STUDIO_RENDERER_FILE: file } });
const r2 = await C.rendererReport(b2, page('Google SwiftShader'), { log: (m) => said.push(m), env: process.env });
const r3 = await C.rendererReport(b4, page('ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)'), { log: (m) => said.push(m), env: process.env });
const r4 = await C.rendererReport(b3, page('Google SwiftShader'), { log: (m) => said.push(m), env: process.env });
console.log(JSON.stringify({ args: launches.map((o) => o.args || []), gpu: [b1.__gpu, b2.__gpu, b3.__gpu, b4.__gpu, b5.__gpu].map((g) => g && g.mode + ':' + g.on), flags: [C.browserGpuFlags('win32'), C.browserGpuFlags('darwin'), C.browserGpuFlags('linux')], r1, r2, r3, r4, said, file: JSON.parse(fs.readFileSync(file, 'utf8')) }));`);
    report('2.70.0 (t, 2): STUDIO_BROWSER_GPU=on adds the platform\'s GPU flags once beside the caller\'s args (Windows --enable-gpu --use-angle=d3d11; macOS --use-angle=metal, not twice; Linux --enable-gpu --use-gl=angle); off (the default) adds none; auto is on only when the machine scan shows a GPU; the browser carries the setting it got (fails on 2.69.0: qa/chromium.mjs passed no GPU flag)',
      J(p.flags) === J([['--enable-gpu', '--use-angle=d3d11'], ['--use-angle=metal'], ['--enable-gpu', '--use-gl=angle']])
        && J(p.args) === J([['--use-angle=metal'], ['--foo', '--enable-gpu', '--use-angle=d3d11'], ['--foo'], ['--enable-gpu', '--use-gl=angle'], []])
        && J(p.gpu) === J(['on:true', 'on:true', 'off:false', 'auto:true', 'auto:false']),
      J(p));
    report('2.70.0 (t, 2): the report records the renderer the page got (UNMASKED_RENDERER, cpuRenderer true for SwiftShader); with the flags on and a CPU renderer it says "GPU flags on but CPU renderer in use" once per run (not again for the second page), never with a hardware renderer or with the flags off; STUDIO_RENDERER_FILE gets the record (fails on 2.69.0: no renderer was recorded)',
      p.r1?.cpuRenderer === true && /GPU flags on but CPU renderer in use/.test(p.r1.note || '') && p.r1.gpu === 'on' && /SwiftShader/.test(p.r1.renderer)
        && /GPU flags on but CPU renderer in use/.test(p.r2?.note || '') && p.r3?.cpuRenderer === false && !p.r3.note && p.r4?.gpu === 'off' && !p.r4.note
        && (p.said || []).length === 1 && /^\[browser\] GPU flags on but CPU renderer in use/.test(p.said[0]) && /SwiftShader/.test(p.file?.renderer || ''),
      J(p));

    // A real headless Chromium (CPU WebGL here): the page's renderer is read and, with the flags on, the CPU note shows.
    const rp = probe(`import { chromium } from 'playwright';
import { launchChromium, rendererReport } from ${u('qa/chromium.mjs')};
const said = [];
const b = await launchChromium(chromium, {}, { profile: null });
if (b.error) { console.log(JSON.stringify({ skipped: String(b.error.message).split('\\n')[0] })); process.exit(0); }
try { const page = await b.newPage(); await page.setContent('<canvas></canvas>'); const r = await rendererReport(b, page, { log: (m) => said.push(m) }); console.log(JSON.stringify({ r, said })); } finally { await b.close(); }`, { STUDIO_BROWSER_GPU: 'on' });
    report(`2.70.0 (t, 2): a real headless Chromium launched with STUDIO_BROWSER_GPU=on reports the renderer it actually got${rp.skipped ? ' (SKIPPED: no Chromium here)' : ''}, and a CPU renderer (SwiftShader/llvmpipe in this container) is named with the "GPU flags on but CPU renderer in use" note (fails on 2.69.0: no renderer report)`,
      Boolean(rp.skipped) || (rp.r?.gpu === 'on' && (rp.r.renderer === null || (rp.r.cpuRenderer ? /GPU flags on but CPU renderer in use/.test(rp.r.note || '') && rp.said?.length === 1 : !rp.r.note))),
      J(rp));

    // The visual baseline records the renderer; a renderer change re-baselines the noise with a note and is never a pass.
    const vp = probe(`import fs from 'node:fs'; import path from 'node:path';
import { encodePng } from ${u('harness/png.mjs')};
import * as V from ${u('harness/visual-proof.mjs')};
const W = 64, H = 64;
const img = (bump = new Set()) => { const rgba = new Uint8Array(W * H * 4); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; const v = 40 + x + y + (bump.has(y * W + x) ? 100 : 0); rgba[i] = v; rgba[i + 1] = v; rgba[i + 2] = v; rgba[i + 3] = 255; } return { width: W, height: H, rgba }; };
const cells = (from, n) => new Set(Array.from({ length: n }, (_, k) => from + k));
const put = (task, side, im, renderer) => { const d = path.join(V.proofDir(task), side); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'deck.png'), encodePng(im)); if (renderer !== undefined) fs.writeFileSync(path.join(d, 'renderer.json'), JSON.stringify(renderer)); };
const cpu = { renderer: 'Google SwiftShader', gpu: 'off' }, gpu = { renderer: 'ANGLE (NVIDIA, RTX, D3D11)', gpu: 'on' };
// T-981: the second before was drawn by another renderer: 3% "noise" (over the cap), a 2.5% change.
put('T-981', 'before', img(), cpu); put('T-981', 'before-noise', img(cells(0, 314)), gpu); put('T-981', 'after', img(cells(2000, 261)), cpu);
// T-982: before on the CPU, after on the GPU: a big change that is the renderer's.
put('T-982', 'before', img(), cpu); put('T-982', 'before-noise', img(), cpu); put('T-982', 'after', img(cells(1000, 2090)), gpu);
// T-983: the same noise on ONE renderer stays "too noisy" (the tolerance is never loosened).
put('T-983', 'before', img(), cpu); put('T-983', 'before-noise', img(cells(0, 314)), cpu); put('T-983', 'after', img(cells(1000, 2090)), cpu);
// T-984: no renderer records at all: as before (2.65 rules).
put('T-984', 'before', img()); put('T-984', 'before-noise', img(cells(0, 63))); put('T-984', 'after', img(cells(2000, 261)));
const r = { a: V.checkVisualProof('T-981'), b: V.checkVisualProof('T-982'), c: V.checkVisualProof('T-983'), d: V.checkVisualProof('T-984') };
// captureWithCommand for "after": the before was taken with GPU flags on; this shell has them off: the capture runs with on.
const before = path.join(V.proofDir('T-985'), 'before'); fs.mkdirSync(before, { recursive: true }); fs.writeFileSync(path.join(before, 'renderer.json'), JSON.stringify({ renderer: null, gpu: 'on' }));
fs.writeFileSync('cap-270t.mjs', "import fs from 'node:fs'; import path from 'node:path'; import { encodePng } from " + ${JSON.stringify(JSON.stringify(pathToFileURL(path.join(dir, 'harness/png.mjs')).href))} + "; const out = process.argv[2]; fs.writeFileSync(path.join(out, 'deck.png'), encodePng({ width: 2, height: 2, rgba: new Uint8Array(16).fill(200) })); fs.writeFileSync(path.join(out, 'seen.txt'), String(process.env.STUDIO_BROWSER_GPU) + '|' + String(process.env.STUDIO_RENDERER_FILE || ''));");
const cap = V.captureWithCommand('node cap-270t.mjs {out}', path.join(V.proofDir('T-985'), 'after'), { phase: 'after' });
const seen = fs.readFileSync(path.join(V.proofDir('T-985'), 'after', 'seen.txt'), 'utf8');
const rec = JSON.parse(fs.readFileSync(path.join(V.proofDir('T-985'), 'after', 'renderer.json'), 'utf8'));
console.log(JSON.stringify({ r, cap: { ok: cap.ok, log: cap.log.slice(0, 400) }, seen, rec }));`, { STUDIO_BROWSER_GPU: 'off' });
    const cam = (x) => x?.cameras?.[0] || {};
    report('2.70.0 (t, 2): the visual baseline knows its renderer: two before captures drawn by different renderers re-baseline the noise with a note (no "too noisy" failure from the renderer; judged against the minimum, said in notes), the same noise on one renderer is still too noisy (never loosened), and no renderer record keeps the 2.65 rules (fails on 2.69.0: T-981 failed "too noisy to judge" on the renderer change)',
      vp.r?.a?.ok === true && cam(vp.r.a).noise === null && /different renderers/.test((vp.r.a.notes || []).join(' ')) && /renderer changed between the before captures/.test(cam(vp.r.a).bar || '')
        && vp.r?.c?.ok === false && /too noisy to judge/.test(vp.r.c.why) && vp.r?.d?.ok === true && Math.abs(cam(vp.r.d).noise - 0.00603) < 0.0002,
      J(vp));
    report('2.70.0 (t, 2): before drawn by SwiftShader and after by a GPU is never a pass ("a renderer change shifts pixels, so this pair can\'t be compared", naming both, asking for a new before); an after capture runs with the GPU setting its before was taken with (STUDIO_BROWSER_GPU=on pinned, said in the log) and gets STUDIO_RENDERER_FILE, and a capture that writes no renderer still records the setting (fails on 2.69.0: the 20% renderer change passed, and nothing recorded the renderer)',
      vp.r?.b?.ok === false && /before was drawn by Google SwiftShader and after by ANGLE/.test(vp.r.b.why) && /can't be compared/.test(vp.r.b.why) && cam(vp.r.b).rendererChanged === true
        && vp.cap?.ok === true && /^on\|.*renderer\.json$/.test(vp.seen || '') && /captured with STUDIO_BROWSER_GPU=on, the setting its before was taken with/.test(vp.cap.log) && vp.rec?.gpu === 'on' && vp.rec.renderer === null,
      J(vp));
  });

  // ================= 3. Blender out of machine:heavy =================
  await guard('2.70.0 (t, 3)', () => {
    // A stub Blender that records its arguments (blender.cmd on Windows, an executable node script elsewhere).
    const bin = path.join(tmpRoot, `bin-270t-${process.pid}`);
    fs.mkdirSync(bin, { recursive: true });
    const argsLog = path.join(bin, 'args.jsonl');
    fs.writeFileSync(path.join(bin, 'blender.mjs'), `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`);
    fs.writeFileSync(path.join(bin, 'blender'), `#!/usr/bin/env node\nimport(${JSON.stringify(pathToFileURL(path.join(bin, 'blender.mjs')).href)});\n`);
    fs.chmodSync(path.join(bin, 'blender'), 0o755);
    fs.writeFileSync(path.join(bin, 'blender.cmd'), `@node "%~dp0blender.mjs" %*\r\n`);
    const PATH = `${bin}${path.delimiter}${process.env.PATH || process.env.Path || ''}`;
    const p = probe(`import { acquireHeavy } from ${u('harness/heavy.mjs')};
import { runRoundTrip } from ${u('harness/asset-gate.mjs')};
import * as B from ${u('harness/blender-job.mjs')};
const env = { ...process.env, STUDIO_HEAVY_HELD: '' };
const logs = [];
const verify = acquireHeavy(process.cwd(), 'full verify', { kind: 'verify', env, log: (m) => logs.push(m) });
const cfg = { roundTrip: { command: 'blender -b --factory-startup -P tools/rt.py -- {file}', timeoutMin: 1 } };
const t0 = Date.now();
const r1 = await runRoundTrip(process.cwd(), cfg, ['assets/crate.glb'], { env, log: (m) => logs.push(m) });
const ms = Date.now() - t0;
// One harness Blender job at a time: a preview render holds; the round trip waits and comes back busy.
const prev = acquireHeavy(process.cwd(), 'preview render', { kind: 'blender-preview', env, log: (m) => logs.push(m) });
const r2 = await runRoundTrip(process.cwd(), cfg, ['assets/crate.glb'], { env, log: (m) => logs.push(m) });
prev.release(); verify.release();
const unityKind = B.blenderKind('"C:/Program Files/Unity/Hub/Editor/6000.0/Editor/Unity.exe" -batchmode -quit');
console.log(JSON.stringify({ r1, r2, ms, logs, unityKind,
  w: [B.withBlenderThreads('blender -b --factory-startup -P tools/x.py -- a.glb', 8), B.withBlenderThreads('blender -b scene.blend -t 4 -f 1', 8), B.withBlenderThreads('"C:/Blender 4.2/blender.exe" -b s.blend -a', 6), B.withBlenderThreads('node tools/x.mjs', 8), B.withBlenderThreads('blender -b s.blend', 3)],
  th: [B.blenderThreads({ env: { STUDIO_BLENDER_THREADS: '6' } }), B.blenderThreads({ env: { STUDIO_BLENDER_THREADS: '0' }, profile: { cores: { logical: 28 } } }), B.blenderThreads({ env: {}, profile: { cores: { logical: 2 } } }), B.blenderThreads({ env: {}, profile: { cores: { logical: 12 } } })] }));`, { STUDIO_TEST_MACHINE: machine({ cores: 12 }), STUDIO_HEAVY_SLOTS: '1', PATH, Path: PATH });
    let calls = [];
    try { calls = fs.readFileSync(argsLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch {}
    const logs = (p.logs || []).join('\n');
    report('2.70.0 (t, 3): the asset round trip (a stub Blender) runs beside a full verify holding the only slot, in the GPU area ("asset round trip took the GPU area"), with -t <n> from the scan (12 cores / 3 = 4) placed before -P; a second harness Blender job waits (one at a time) and the round trip comes back busy, never on top (fails on 2.69.0: the round trip waited for machine:heavy behind the verify and came back busy)',
      p.r1 && !p.r1.busy && p.r1.ran === 1 && (p.r1.failures || []).length === 0 && /asset round trip took the GPU area/.test(logs) && /Blender render threads: 4/.test(logs)
        && calls.length === 1 && J(calls[0]) === J(['-b', '--factory-startup', '-t', '4', '-P', 'tools/rt.py', '--', 'assets/crate.glb'])
        && p.r2?.busy === true && /1 blender job already running/.test(p.r2.why || ''),
      J({ p, calls }));
    report('2.70.0 (t, 3): -t is added only to Blender commands that set none (before -P/-f/-a/--, else at the end; a quoted Windows path works), STUDIO_BLENDER_THREADS wins, 0 is never used (ignored and said: Blender\'s 0 is every core), the scan default is cores / 3 within 1..8, and a Unity batchmode command claims the Unity cap (fails on 2.69.0: harness/blender-job.mjs did not exist)',
      J(p.w) === J(['blender -b --factory-startup -t 8 -P tools/x.py -- a.glb', 'blender -b scene.blend -t 4 -f 1', '"C:/Blender 4.2/blender.exe" -b s.blend -t 6 -a', 'node tools/x.mjs', 'blender -b s.blend -t 3'])
        && p.th?.[0]?.n === 6 && p.th[1].n === 8 && /ignored \(never 0/.test(p.th[1].why) && p.th[2].n === 1 && p.th[3].n === 4 && p.unityKind === 'unity',
      J(p));
    clearLocks();
    try { fs.rmSync(bin, { recursive: true, force: true }); } catch {}
  });

  // ================= 4. a playable build + clip after a landing =================
  await guard('2.70.0 (t, 4)', async () => {
    // A made-up browser game (a page build), and a game with no browser build.
    write('cartridges/lander-demo/index.mjs', `export const createInitialState = () => ({ tick: 0 });\nexport const step = (s) => ({ tick: s.tick + 1 });\n`);
    write('cartridges/lander-demo/qa.mjs', `export const scenarios = {};\nexport const browser = { page: 'web/lander-demo/index.html' };\n`);
    write('web/lander-demo/index.html', '<!doctype html><title>lander demo</title><canvas></canvas>\n');
    write('cartridges/sim-only-demo/index.mjs', `export const createInitialState = () => ({ tick: 0 });\nexport const step = (s) => ({ tick: s.tick + 1 });\n`);
    write('cartridges/sim-only-demo/qa.mjs', 'export const scenarios = {};\n');
    // A stub clip recorder: prints what qa/clip.mjs prints and writes the file; it sleeps so "never blocks" shows.
    write('tools-270t/clip-stub.mjs', `import fs from 'node:fs'; const name = process.argv[2]; const secs = process.argv[3]; await new Promise((r) => setTimeout(r, Number(process.env.CLIP_STUB_MS || 0))); fs.mkdirSync('qa/reports/clips', { recursive: true }); fs.writeFileSync('qa/reports/clips/' + name + '.mp4', 'x'); fs.appendFileSync('tools-270t/clip-calls.txt', name + ' ' + secs + ' held=' + Boolean(process.env.STUDIO_HEAVY_HELD) + '\\n'); console.log('Saved qa/reports/clips/' + name + '.mp4 (1 KB).');\n`);
    const env4 = { STUDIO_CARTRIDGE: 'lander-demo', STUDIO_LANDING_CLIP_CMD: 'node tools-270t/clip-stub.mjs {name} {seconds}', STUDIO_LANDING_CLIP_SECONDS: '7', STUDIO_TEST_MACHINE: 'none', STUDIO_HEAVY_WAIT_MIN: '0.5' };
    try { fs.rmSync(evFile, { force: true }); } catch {}
    const q = probe(`import fs from 'node:fs'; import path from 'node:path';
import * as L from ${u('harness/landing-build.mjs')};
const root = process.cwd();
const spawned = [];
const fakeSpawn = (r) => { spawned.push(r); fs.writeFileSync(path.join(L.lbDir(r), 'worker.json'), JSON.stringify({ pid: process.pid })); return process.pid; };
const logs = [];
const a = await L.queueLandingBuild({ root, train: 'tr-1', tasks: ['T-1', 'T-2'], env: process.env, log: (m) => logs.push(m), spawn: fakeSpawn });
const b = await L.queueLandingBuild({ root, train: 'tr-2', tasks: ['T-3'], env: process.env, log: (m) => logs.push(m), spawn: fakeSpawn });
const pending = JSON.parse(fs.readFileSync(path.join(L.lbDir(root), 'pending.json'), 'utf8'));
fs.rmSync(path.join(L.lbDir(root), 'worker.json'), { force: true });
const offR = await L.queueLandingBuild({ root, train: 'tr-3', tasks: ['T-4'], env: { ...process.env, STUDIO_LANDING_BUILD: 'off' }, spawn: fakeSpawn });
const noBuild = await L.queueLandingBuild({ root, train: 'tr-4', tasks: ['T-5'], env: { ...process.env, STUDIO_CARTRIDGE: 'sim-only-demo' }, log: (m) => logs.push(m), spawn: fakeSpawn });
const tmpl = await L.queueLandingBuild({ root, train: 'tr-5', tasks: ['T-6'], env: { ...process.env, STUDIO_CARTRIDGE: 'example-sim' }, spawn: fakeSpawn });
const pending2 = JSON.parse(fs.readFileSync(path.join(L.lbDir(root), 'pending.json'), 'utf8'));
// The worker runs the one queued job (real heavy lock, real snapshot of the made-up game, the stub clip).
const w = await L.runLandingWorker({ root, env: process.env, log: (m) => logs.push(m) });
const left = fs.existsSync(path.join(L.lbDir(root), 'pending.json'));
console.log(JSON.stringify({ a, b, pending, offR, noBuild, tmpl, pending2, spawned: spawned.length, w: w.done.map((d) => ({ ran: d.ran, build: d.build && { ok: d.build.ok, id: d.build.build && d.build.build.id }, clip: d.clip })), left, logs }));`, env4);
    const events = () => { try { return fs.readFileSync(evFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
    const evs = events();
    const snap = evs.filter((e) => e.type === 'build.snapshot');
    const clip = evs.filter((e) => e.type === 'clip.recorded');
    const buildId = q.w?.[0]?.build?.id;
    let calls = '';
    try { calls = fs.readFileSync(path.join(dir, 'tools-270t', 'clip-calls.txt'), 'utf8'); } catch {}
    report('2.70.0 (t, 4): after a landing ONE build-clip job is queued; a newer landing replaces the queued one (one pending, its tasks added: T-1, T-2, T-3; the worker is started once, not again while it runs); the worker saves a playable build of the made-up game (harness/builds.mjs) and records a clip (the clip command, 7 s, inside the heavy hold), with build.snapshot and clip.recorded events naming the landed tasks, and nothing stays queued (fails on 2.69.0: nothing was built or recorded after a landing)',
      q.a?.queued === true && q.b?.queued === true && q.b.replaced === true && J(q.pending?.tasks) === J(['T-1', 'T-2', 'T-3']) && J(q.pending?.trains) === J(['tr-1', 'tr-2']) && q.spawned === 1
        && q.w?.length === 1 && q.w[0].ran === true && q.w[0].build?.ok === true && buildId && fs.existsSync(path.join(dir, '.studio', 'builds', buildId, 'web', 'lander-demo', 'index.html'))
        && q.w[0].clip?.ok === true && q.w[0].clip.file === 'qa/reports/clips/landing-tr-2.mp4' && /^landing-tr-2 7 held=true/.test(calls)
        && snap.length === 1 && snap[0].meta?.ok === true && snap[0].meta.build === buildId && J(snap[0].meta.tasks) === J(['T-1', 'T-2', 'T-3'])
        && clip.length === 1 && clip[0].meta?.ok === true && clip[0].meta.file === 'qa/reports/clips/landing-tr-2.mp4' && J(clip[0].meta.tasks) === J(['T-1', 'T-2', 'T-3']) && q.left === false,
      J({ q, snap, clip, calls }));
    report('2.70.0 (t, 4): STUDIO_LANDING_BUILD=off queues nothing; a game with no browser build and the template cartridge are skipped with the reason ("declares no browser build"), leaving the queue as it was (fails on 2.69.0: no landing build at all)',
      q.offR?.queued === false && q.offR.why === 'STUDIO_LANDING_BUILD=off' && q.noBuild?.queued === false && /declares no browser build/.test(q.noBuild.why) && q.tmpl?.queued === false && /template cartridge/.test(q.tmpl.why)
        && J(q.pending2?.tasks) === J(['T-1', 'T-2', 'T-3']),
      J(q));

    // status --brief and the digest show the latest.
    const s = probe(`import { briefFacts, briefText } from ${u('harness/brief-status.mjs')};
import { buildDigest } from ${u('harness/digest.mjs')};
import { readRecentEvents } from ${u('harness/event.mjs')};
const f = await briefFacts({ root: process.cwd() });
const d = await buildDigest({ root: process.cwd(), events: readRecentEvents(2000) });
console.log(JSON.stringify({ build: f.build, text: briefText(f), digest: d.text }));`, env4);
    report('2.70.0 (t, 4): npm run status -- --brief and the daily digest show the latest playable build with its landed tasks and the clip ("Playable build <id> (T-1, T-2 +1); clip landing-tr-2.mp4") (fails on 2.69.0: neither mentioned builds)',
      new RegExp(`Playable build ${buildId} \\(T-1, T-2 \\+1\\); clip landing-tr-2\\.mp4`).test(s.text || '') && new RegExp(`Playable build ${buildId} \\(T-1, T-2, T-3\\); clip landing-tr-2\\.mp4 \\(npm run play\\)`).test(s.digest || ''),
      J(s));

    // The train hook: queued after a landing (never throws, never waits), nothing when nothing landed; a real detached
    // worker finishes the job after the queue call has returned.
    try { fs.rmSync(evFile, { force: true }); } catch {}
    const t = probe(`import { landingBuildAfterTrain } from ${u('harness/train.mjs')};
import fs from 'node:fs';
const logs = [];
const seen = [];
const none = await landingBuildAfterTrain(process.cwd(), { id: 'tr-9', landed: [] }, { queue: async (o) => { seen.push(o); return { queued: true }; } });
const stub = await landingBuildAfterTrain(process.cwd(), { id: 'tr-9', landed: ['T-7'] }, { log: (m) => logs.push(m), queue: async (o) => { seen.push({ train: o.train, tasks: o.tasks }); o.log('queued'); return { queued: true }; } });
const boom = await landingBuildAfterTrain(process.cwd(), { id: 'tr-9', landed: ['T-7'] }, { log: (m) => logs.push(m), queue: async () => { throw new Error('disk full'); } });
const t0 = Date.now();
const real = await landingBuildAfterTrain(process.cwd(), { id: 'tr-10', landed: ['T-8'] }, { log: (m) => logs.push(m) });
const ms = Date.now() - t0;
const src = fs.readFileSync(${JSON.stringify(path.join(dir, 'harness', 'train.mjs'))}, 'utf8');
const body = src.slice(src.indexOf('export async function runTrain('), src.indexOf('export function trainJobDone('));
console.log(JSON.stringify({ none, stub, boom, real, ms, seen, logs, hooked: /landingBuildAfterTrain\\(root, locked/.test(body) && /!opts\\.dryRun/.test(body) }));`, { ...env4, CLIP_STUB_MS: '1500' });
    let got = [];
    for (let i = 0; i < 120 && !got.some((e) => e.type === 'clip.recorded'); i += 1) { await new Promise((r) => setTimeout(r, 250)); got = events(); }
    report('2.70.0 (t, 4): the train queues it after a landing (runTrain calls landingBuildAfterTrain unless a dry run; tasks and train id passed; the queue\'s line in the train log), returns null when nothing landed, survives a failing queue with a log line, and a real queue call returns at once (under 3 s) while a detached low-priority worker records the build and clip afterwards (fails on 2.69.0: no hook)',
      t.none === null && J(t.seen) === J([{ train: 'tr-9', tasks: ['T-7'] }]) && t.stub?.queued === true && (t.logs || []).some((l) => /^\[train\] tr-9: queued$/.test(l)) && t.boom === null && (t.logs || []).some((l) => /not queued: disk full/.test(l))
        && t.real?.queued === true && t.ms < 3000 && t.hooked === true
        && got.some((e) => e.type === 'build.snapshot' && J(e.meta?.tasks) === J(['T-8'])) && got.some((e) => e.type === 'clip.recorded' && e.meta?.ok && J(e.meta.tasks) === J(['T-8'])),
      J({ t, got: got.map((e) => [e.type, e.msg]) }));
    // Leave no worker behind.
    for (let i = 0; i < 40 && fs.existsSync(path.join(dir, '.studio', 'landing-build', 'worker.json')); i += 1) await new Promise((r) => setTimeout(r, 250));
  });
}
