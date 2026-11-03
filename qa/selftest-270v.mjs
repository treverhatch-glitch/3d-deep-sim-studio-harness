/**
 * qa/selftest-270v.mjs — 2.70.0 (v): a vision check on asset previews before an asset lands (harness/asset-review.mjs).
 *   1. the preview checks (pure Node, generated PNGs): blank, all-black, all-white, untextured magenta, clipped at the
 *      frame's edge and too small each fail the asset gate with a plain-words line and a Fix line; a good preview
 *      passes with its numbers recorded; a top-heavy front and 3/4 view is a warning, not a failure;
 *   2. thresholds come from studio/asset-review.json, and a lane changing that file is tier C (a silencer);
 *   3. task done on a passing asset writes ONE review request (.studio/asset-reviews/<asset>.md: previews, the brief's
 *      facts, the numbers, the four questions) and files ONE asset-review task for the art-director, and refuses until
 *      it is answered; a second task done files no second task; status --brief and the digest list the waiting assets
 *      oldest first;
 *   4. who answers: the maker can't pass its own review; a worker can't record a person's verdict without their words;
 *      another agent can, and then task done lands the asset and files its "Wire in" task; a re-export asks again;
 *      the owner's delegation for asset-review covers the outside agent;
 *   5. a failed review files a fix task with the reviewer's words, and task done names them;
 *   6. a hard preview failure at task done hands the asset straight back with the findings: no request, no review task.
 * Fixtures (tiny .glb files and generated PNGs) are written by the test; no binary file is committed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest270V({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const events = path.join(dir, '.studio', 'events-270v.jsonl');
  const base = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_MAIN_ROOT: '', STUDIO_HEAVY_SLOTS: '1', STUDIO_HEAVY_HELD: '', STUDIO_GATE_PRIORITY: '', STUDIO_LOCK_OWNER: '', STUDIO_AGENT: '', STUDIO_ROLE: '', STUDIO_GAME: '', STUDIO_TRAIN: 'off', STUDIO_GATE_CHANGED: '', STUDIO_DONE_GAME_GATES: 'skip', STUDIO_VISUAL_GATE: 'off', STUDIO_DONE_NOOP: 'allow', STUDIO_DONE_UNCOMMITTED: 'allow', STUDIO_REACHABILITY: 'off', STUDIO_HOOKS_CHECK: 'off', STUDIO_WEAKENED_TESTS: 'off', STUDIO_DONE_UNITY_GATE: 'skip', npm_lifecycle_event: '', AGENT_EVENTS_FILE: events, CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '' };
  const evs = () => { try { return fs.readFileSync(events, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return {}; } }); } catch { return []; } };
  const w = (rel, data) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); return rel; };
  const exists = (rel) => fs.existsSync(path.join(dir, rel));
  const rj = (rel) => { try { return JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8')); } catch { return {}; } };
  const { encodePng } = await import(pathToFileURL(path.join(dir, 'harness', 'png.mjs')).href);

  // ---------- fixtures ----------
  /** A preview: background colour, then rectangles (and rows of an upside-down triangle when `tri`). */
  const preview = ({ size = 512, bg = [40, 44, 52], rects = [], tri = null, noise = null } = {}) => {
    const rgba = Buffer.alloc(size * size * 4);
    for (let i = 0; i < size * size; i++) { const c = noise ? noise[i % 2] : bg; rgba[i * 4] = c[0]; rgba[i * 4 + 1] = c[1]; rgba[i * 4 + 2] = c[2]; rgba[i * 4 + 3] = 255; }
    const paint = (x, y, c) => { const i = (y * size + x) * 4; rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; };
    for (const r of rects) for (let y = r.y; y < Math.min(size, r.y + r.h); y++) for (let x = r.x; x < Math.min(size, r.x + r.w); x++) paint(x, y, r.c);
    if (tri) for (let y = tri.y; y < tri.y + tri.h; y++) { const half = Math.round((tri.w / 2) * (1 - (y - tri.y) / tri.h)); for (let x = tri.cx - half; x <= tri.cx + half; x++) paint(x, y, tri.c); }
    return encodePng({ width: size, height: size, rgba });
  };
  const GOOD = { rects: [{ x: 150, y: 120, w: 210, h: 280, c: [180, 140, 90] }] };
  const views = {
    good: GOOD,
    blank: {},
    black: { noise: [[2, 2, 2], [12, 12, 12]] },
    white: { noise: [[250, 250, 250], [242, 242, 242]] },
    magenta: { rects: [{ x: 150, y: 120, w: 210, h: 280, c: [255, 0, 255] }] },
    clipped: { rects: [{ x: 300, y: 120, w: 212, h: 280, c: [180, 140, 90] }] },
    tiny: { rects: [{ x: 246, y: 246, w: 20, h: 20, c: [180, 140, 90] }] },
    topheavy: { tri: { cx: 256, y: 100, w: 300, h: 300, c: [180, 140, 90] } },
  };
  /** A small binary glTF (one mesh). */
  const glb = (name = 'Prop', tris = 12) => {
    const json = { asset: { version: '2.0' }, scenes: [{ nodes: [0] }], nodes: [{ name, mesh: 0 }], meshes: [{ name, primitives: [{ attributes: { POSITION: 1 }, indices: 0 }] }], accessors: [{ bufferView: 0, componentType: 5123, count: tris * 3, type: 'SCALAR' }, { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 64 }], buffers: [{ byteLength: 64 }] };
    let js = Buffer.from(JSON.stringify(json));
    js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
    const bin = Buffer.alloc(64);
    const head = Buffer.alloc(12); head.write('glTF', 0, 'latin1'); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
    const ch = (type, data) => { const h = Buffer.alloc(8); h.writeUInt32LE(data.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, data]); };
    return Buffer.concat([head, ch(0x4e4f534a, js), ch(0x004e4942, bin)]);
  };
  const gameJson = path.join(dir, 'studio', 'game.json');
  const gameBefore = fs.existsSync(gameJson) ? JSON.parse(fs.readFileSync(gameJson, 'utf8')) : {};
  fs.writeFileSync(gameJson, JSON.stringify({ ...gameBefore, assets: { paths: ['assets'] } }, null, 2));
  const manifest = path.join(dir, 'studio', 'assets', 'manifest.json');
  const rows = [];
  const row = (file, more = {}) => { rows.push({ id: `A-${rows.length + 1}`, file, use: 'game', licence: 'own work', ...more }); fs.mkdirSync(path.dirname(manifest), { recursive: true }); fs.writeFileSync(manifest, JSON.stringify({ assets: rows }, null, 2)); };
  /** A model in assets/<folder>/ with a manifest row and previews: { front, 34, top } view kinds (or one old-style). */
  const model = (folder, name, kinds, { single = false, more = {} } = {}) => {
    const rel = w(`assets/${folder}/${name}.glb`, glb(name));
    if (single) w(`assets/${folder}/${name}.preview.png`, preview(views[kinds]));
    else for (const [v, k] of Object.entries(kinds)) w(`assets/${folder}/${name}.preview-${v}.png`, preview(views[k]));
    row(rel, more);
    return rel;
  };
  const gate = (files, env = {}) => {
    const r = run(dir, `node harness/asset-gate.mjs --json --no-round-trip --files ${files.join(',')}`, { ...base, ...env });
    let j = null;
    try { j = JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch {}
    return { code: r.status, j, text: out(r) };
  };
  const fails = (g, check, file) => g.j?.failures?.find((f) => f.check === check && f.file === file && /\S/.test(f.why || '') && /\S/.test(f.fix || '')) || null;
  const show = (g) => JSON.stringify({ code: g.code, j: g.j ? { status: g.j.status, failures: g.j.failures, notes: g.j.notes, review: g.j.review ? { required: g.j.review.required, pending: g.j.review.pending, items: (g.j.review.items || []).map((i) => ({ asset: i.asset, state: i.state, previews: i.previews.map((p) => ({ view: p.view, m: p.measured && { dom: p.measured.dominant, bbox: p.measured.bbox, up: p.measured.upRatio } })) })) } : null } : null, text: g.j ? '' : g.text.slice(-800) }).slice(0, 3000);
  const all3 = (k) => ({ front: k, 34: k, top: k });

  // 1. the preview checks
  {
    const blank = model('t1', 'blankbox', all3('blank'));
    const black = model('t1', 'blackbox', all3('black'));
    const white = model('t1', 'whitebox', all3('white'));
    const g1 = gate([blank, black, white]);
    await guard('2.70.0 (v1a): a blank render (one colour over 98%), an all-black and an all-white one fail the asset gate per view, each with a plain-words line and a Fix line (2.69.0: no preview check, they passed)', () => [
      g1.code === 1 && fails(g1, 'preview-blank', 'assets/t1/blankbox.preview-front.png') && /one colour/.test(fails(g1, 'preview-blank', 'assets/t1/blankbox.preview-front.png')?.why || '') && fails(g1, 'preview-black', 'assets/t1/blackbox.preview-34.png') && fails(g1, 'preview-white', 'assets/t1/whitebox.preview-top.png')
        && /\[asset-gate\] FAIL preview-blank assets\/t1\/blankbox\.preview-front\.png: .*\n\[asset-gate\] Fix: /.test(run(dir, `node harness/asset-gate.mjs --no-round-trip --files ${blank}`, base).stdout || ''),
      show(g1)]);
    const mag = model('t1', 'pinkbox', { front: 'magenta', 34: 'good', top: 'good' });
    const clip = model('t1', 'edgebox', { front: 'good', 34: 'clipped', top: 'good' });
    const tiny = model('t1', 'dotbox', { front: 'tiny', 34: 'tiny', top: 'tiny' });
    const g2 = gate([mag, clip, tiny]);
    await guard('2.70.0 (v1b): untextured magenta over 10% of the model, a model touching the frame\'s edge (clipped) and one under 10% of the frame (too small / wrong scale) fail, naming the preview and the number (2.69.0: passed)', () => [
      g2.code === 1 && /missing-texture magenta/.test(fails(g2, 'preview-magenta', 'assets/t1/pinkbox.preview-front.png')?.why || '') && /touches the edge/.test(fails(g2, 'preview-clipped', 'assets/t1/edgebox.preview-34.png')?.why || '') && /fills only 0\.\d+%/.test(fails(g2, 'preview-small', 'assets/t1/dotbox.preview-front.png')?.why || '')
        && !g2.j.failures.some((f) => f.file === 'assets/t1/pinkbox.preview-34.png' || f.file === 'assets/t1/edgebox.preview-front.png') && /pack/.test(fails(g2, 'preview-magenta', 'assets/t1/pinkbox.preview-front.png')?.fix || ''),
      show(g2)]);
    const good = model('t1', 'goodbox', all3('good'));
    const up = model('t1', 'conebox', { front: 'topheavy', 34: 'topheavy', top: 'good' });
    const g3 = gate([good, up]);
    const it = g3.j?.review?.items?.find((i) => i.model === good);
    const fm = it?.previews?.find((p) => p.view === 'front')?.measured;
    await guard('2.70.0 (v1c): a good preview set passes with its numbers recorded per view (one-colour share, box in frame, magenta, top/bottom mass) and the asset is listed for review; a top-heavy front and 3/4 view is an up-axis WARNING note, not a failure (2.69.0: no numbers, no review)', () => [
      g3.code === 0 && g3.j?.status === 'pass' && g3.j.review?.required === true && it && it.asset === 't1-goodbox' && it.previews.length === 3 && fm && fm.bbox.share > 0.2 && fm.bbox.share < 0.25 && fm.edgePx === 0 && fm.magenta === 0 && fm.upRatio === 1
        && g3.j.notes.some((n) => /^WARNING assets\/t1\/conebox\.glb: more of the model is in the top half/.test(n)) && (g3.j.review.pending || []).includes('t1-goodbox') && /\[asset-gate\] REVIEW t1-goodbox: /.test(run(dir, `node harness/asset-gate.mjs --no-round-trip --files ${good}`, base).stdout || ''),
      show(g3)]);
    // An old single preview counts as the front view; a preview the decoder can't read is a note for the reviewer.
    const one = model('t1', 'onebox', 'good', { single: true });
    const hdr = w('assets/t1/jpgbox.glb', glb('jpgbox')); row(hdr);
    w('assets/t1/jpgbox.preview.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const g4 = gate([one, hdr]);
    await guard('2.70.0 (v1d): the old single <name>.preview.png is checked as the front view (with a note asking for all three views); a preview the decoder can\'t read is a note (the reviewer looks), not a pass of the checks (2.69.0: never read)', () => [
      g4.code === 0 && g4.j?.review?.items?.find((i) => i.model === one)?.previews?.[0]?.view === 'front' && g4.j.notes.some((n) => /onebox\.glb: 1 preview view\(s\) \(front\)/.test(n)) && g4.j.notes.some((n) => /jpgbox\.preview\.jpg: preview checks not run/.test(n)),
      show(g4)]);
  }

  // 2. thresholds in studio/asset-review.json; a silencer (tier C)
  {
    const cfgFile = path.join(dir, 'studio', 'asset-review.json');
    const before = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : null;
    const tiny = 'assets/t1/dotbox.glb';
    fs.writeFileSync(cfgFile, JSON.stringify({ minFrameShare: 0.001 }));
    const g = gate([tiny]);
    if (before === null) fs.rmSync(cfgFile, { force: true }); else fs.writeFileSync(cfgFile, before);
    const back = gate([tiny]);
    const { classifyLane } = await import(pathToFileURL(path.join(dir, 'harness', 'tiers.mjs')).href);
    const direct = classifyLane({ files: [{ path: 'studio/asset-review.json', status: 'M' }] });
    const viaProposal = classifyLane({ files: [{ path: 'studio-proposals/T-1.json', status: 'A' }], proposals: { 'studio-proposals/T-1.json': ['studio/asset-review.json'] } });
    const lowered = classifyLane({ files: [{ path: 'studio/asset-review.json', status: 'M' }], settings: { tiers: { set: { silencer: 'A' } } } });
    await guard('2.70.0 (v2): the thresholds come from studio/asset-review.json (minFrameShare 0.001 lets the tiny model through; the shipped default fails it), and a lane that changes the file, directly or by a config proposal, is tier C that a manifest can\'t lower (2.69.0: no such file, tier B)', () => [
      g.code === 0 && !g.j?.failures?.length && back.code === 1 && fails(back, 'preview-small', 'assets/t1/dotbox.preview-front.png') && direct.tier === 'C' && viaProposal.tier === 'C' && lowered.tier === 'C' && /asset-review\.json/.test(JSON.stringify(direct.why || direct)),
      `${show(g)}\n${show(back)}\n${JSON.stringify({ direct, viaProposal, lowered }).slice(0, 1500)}`]);
  }

  // 3-6. task done, the review, who answers
  {
    const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a], { cwd: dir, encoding: 'utf8' });
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n.studio/\n');
    g('init', '-q', '-b', 'main'); g('add', '-A'); g('commit', '-qm', 'start');
    const task = (cmd, env = {}) => run(dir, `node harness/task.mjs ${cmd}`, { ...base, ...env });
    const idOf = (r) => (out(r).match(/"id":\s*"(T-\d+)"/) || [])[1];
    const added = (pred) => evs().filter((e) => e.type === 'task.added' && pred(e));
    const asset = (cmd, env = {}) => run(dir, `node harness/assets.mjs ${cmd}`, { ...base, ...env });
    const make = (title, agent, folder, name, kinds) => {
      const id = idOf(task(`add "${title}" --role asset-3d --track asset --prototype`));
      task(`start ${id} --agent ${agent}`);
      const rel = model(folder, name, kinds);
      g('add', '-A'); g('commit', '-qm', name);
      return { id, rel };
    };

    // 3. a passing asset: one request, one review task, refused until answered
    const A = make('Plan asset: dock crate prop', 'artist-270v', 'dock', 'crate', all3('good'));
    const d1 = task(`done ${A.id} --agent artist-270v`);
    const d2 = task(`done ${A.id} --agent artist-270v`);
    const reviews = added((e) => e.meta?.assetReview === 'dock-crate');
    const req = (() => { try { return fs.readFileSync(path.join(dir, '.studio', 'asset-reviews', 'dock-crate.md'), 'utf8'); } catch { return ''; } })();
    const rvId = reviews[0]?.task;
    await guard('2.70.0 (v3a): task done on a passing asset refuses ("waits for a look"), writes ONE review request with the preview paths, the brief\'s facts, the checks\' numbers and the four questions, and files ONE asset-review task for the art-director; a second task done files no second one (2.69.0: it landed unseen)', () => [
      d1.status !== 0 && /wait.? for a look/.test(out(d1)) && d2.status !== 0 && reviews.length === 1 && /\(art-director\)/.test(reviews[0].msg || '') && /^Queued T-\d+ \[P2\] \(art-director\): Review asset dock-crate/.test(reviews[0].msg || '')
        && /assets\/dock\/crate\.preview-front\.png \(512x512 px\)/.test(req) && /assets\/dock\/crate\.preview-top\.png/.test(req) && /Measured box \(m, glTF Y-up\): w 1 x d 1 x h 1/.test(req) && /Licence: own work/.test(req) && /one colour \d/.test(req)
        && /1\. Scale/.test(req) && /2\. Style/.test(req) && /3\. Orientation/.test(req) && /4\. Obvious defects/.test(req) && new RegExp(`Review task: ${rvId}`).test(req) && /made by artist-270v/.test(req)
        && !evs().some((e) => e.type === 'task.done' && e.task === A.id),
      JSON.stringify({ d1: out(d1).slice(-800), d2: out(d2).slice(-300), reviews, req: req.slice(0, 1200) }).slice(0, 3000)]);

    // a second asset waits too (newer): brief and digest list both, oldest first
    const B = make('Plan asset: dock barrel prop', 'artist-270v-b', 'dock', 'barrel', all3('good'));
    const rec = path.join(dir, '.studio', 'asset-reviews', 'dock-crate.json');
    if (fs.existsSync(rec)) { const back = rj('.studio/asset-reviews/dock-crate.json'); back.requestedAt = '2026-01-01T00:00:00.000Z'; fs.writeFileSync(rec, JSON.stringify(back)); }
    task(`done ${B.id} --agent artist-270v-b`);
    const brief = run(dir, 'node harness/status.mjs --brief --peek --json', base);
    let bj = null; try { bj = JSON.parse(String(brief.stdout).trim().split('\n').pop()); } catch {}
    const dig = run(dir, 'node harness/digest.mjs --all', base);
    const listed = run(dir, 'node harness/assets.mjs reviews', base);
    await guard('2.70.0 (v3b): status --brief names the assets waiting for review oldest first (a blocker), and the daily digest says how many wait, oldest first, with the review command; npm run asset -- reviews lists them (2.69.0: nothing waited)', () => [
      /asset reviews \(oldest first\): dock-crate, dock-barrel/.test(bj?.text || '') && /2 assets wait for a review, oldest first: dock-crate \(T-\d+\)/.test(out(dig)) && /npm run asset -- review <asset> --pass\|--fail/.test(out(dig)) && /^dock-crate .*\ndock-barrel /m.test(out(listed)),
      `${bj?.text}\n${out(dig).slice(-600)}\n${out(listed)}`]);

    // 4. who answers (B lands first: in this one checkout A's change since its start includes B's files)
    const own = asset('review dock-crate --pass --by artist-270v', { STUDIO_LOCK_OWNER: 'artist-270v' });
    const ownName = asset('review crate --pass --by Dana', { STUDIO_LOCK_OWNER: 'artist-270v' });
    const workerForPerson = asset('review dock-crate --pass --by Dana', { STUDIO_LOCK_OWNER: 'qa-playtester-9' });
    const other = asset('review dock-crate --pass --by art-director-270v', { STUDIO_LOCK_OWNER: 'art-director-270v' });
    const recA = rj('.studio/asset-reviews/dock-crate.json');
    const note = (() => { try { return fs.readdirSync(path.join(dir, 'studio', 'reviews')).filter((f) => f.startsWith('asset-dock-crate-')).map((f) => fs.readFileSync(path.join(dir, 'studio', 'reviews', f), 'utf8')).join('\n'); } catch { return ''; } })();
    const rvGone = !fs.readFileSync(path.join(dir, 'studio', 'NEXT.md'), 'utf8').includes(`**${rvId}**`);

    // a re-export after the request asks again; the owner's delegation for asset-review covers the outside agent
    w('assets/dock/barrel.preview-top.png', preview({ rects: [{ x: 140, y: 140, w: 230, h: 230, c: [170, 150, 80] }] }));
    g('add', '-A'); g('commit', '-qm', 'barrel top again');
    const passB = asset('review dock-barrel --pass --by Dana', base);
    const recB1 = rj('.studio/asset-reviews/dock-barrel.json');
    const dB = task(`done ${B.id} --agent artist-270v-b`);
    const recB2 = rj('.studio/asset-reviews/dock-barrel.json');
    const bReviews = added((e) => e.meta?.assetReview === 'dock-barrel');
    // The full selftest shares one studio: an earlier check (267g) commits an owner key, and with a key a delegation must
    // be signed to count (CI release-gate, 2.70.0: the grant was ignored and opus-bot answered as a plain agent). This
    // check is about the review, so the key is set aside here and put back after.
    const keyRel = 'studio/keys/owner-ed25519.pub.pem';
    const hadKey = fs.existsSync(path.join(dir, keyRel));
    if (hadKey) { g('rm', '-q', '--cached', keyRel); fs.renameSync(path.join(dir, keyRel), path.join(dir, `${keyRel}.270v`)); g('commit', '-qm', 'test: no owner key for the delegation check', '--no-verify'); }
    const gr = run(dir, 'node harness/delegation.mjs grant opus-bot --actions asset-review --hours 2 --by pat --why "asset reviews while the crew runs"', base);
    // Why the delegation does or doesn't count, printed first when this check fails (CI only: the shared studio differs).
    const delegWhy = (() => { const r = run(dir, `node -e "import('./harness/delegation.mjs').then((m) => { const d = m.readDelegation({ root: process.cwd() }); console.log(JSON.stringify({ ok: d.ok, why: d.why, signed: d.signed, commit: d.commit })); })"`, base); return out(r).trim().slice(-400); })();
    const dl = asset('review dock-barrel --pass --by opus-bot', { CLAUDECODE: '1', STUDIO_LOCK_OWNER: 'opus-bot' });
    const recB3 = rj('.studio/asset-reviews/dock-barrel.json');
    const dB2 = task(`done ${B.id} --agent artist-270v-b`);
    if (hadKey) { fs.renameSync(path.join(dir, `${keyRel}.270v`), path.join(dir, keyRel)); g('add', keyRel); g('commit', '-qm', 'test: owner key back', '--no-verify'); }

    const d3 = task(`done ${A.id} --agent artist-270v`);
    const wire = evs().filter((e) => e.type === 'asset.handoff' && e.meta?.from === A.id);
    await guard('2.70.0 (v4a): the worker who made the asset can\'t pass its own review (under any --by), a worker shell can\'t record a person\'s verdict without their words, another agent can; then task done lands the asset and files its "Wire in" task, the answered review task leaves the queue and a review note (approved) is written (2.69.0: no review command)', () => [
      own.status !== 0 && /can't pass its own review/.test(out(own)) && ownName.status !== 0 && /can't pass its own review/.test(out(ownName)) && workerForPerson.status !== 0 && /permission/.test(out(workerForPerson))
        && other.status === 0 && recA.verdict === 'pass' && recA.by === 'art-director-270v' && d3.status === 0 && wire.length === 1 && /Verdict: approved/.test(note) && new RegExp(A.id).test(note) && rvGone,
      JSON.stringify({ own: out(own).slice(-300), ownName: out(ownName).slice(-300), wfp: out(workerForPerson).slice(-300), other: out(other).slice(-300), recA, d3: out(d3).slice(-600), wire: wire.length, note, rvGone }).slice(0, 3000)]);
    await guard('2.70.0 (v4b): a preview re-rendered after the request makes a stale answer refused and the next task done asks again for the new checksums (the same open review task, its request rewritten: a pass counts for the files\' checksums only); the owner\'s delegation for asset-review lets the outside agent answer, recorded as via delegation, and the asset lands (2.69.0: no review)', () => [
      passB.status !== 0 && /changed since the request/.test(out(passB)) && recB1.verdict === null && dB.status !== 0 && recB2.verdict === null && recB2.hashes?.['assets/dock/barrel.preview-top.png'] && recB2.hashes['assets/dock/barrel.preview-top.png'] !== recB1.hashes?.['assets/dock/barrel.preview-top.png'] && bReviews.length === 1 && recB2.reviewTask === recB1.reviewTask
        && gr.status === 0 && dl.status === 0 && recB3.verdict === 'pass' && recB3.via === 'delegation' && dB2.status === 0,
      `${JSON.stringify({ passB: out(passB).slice(-200), dB: out(dB).slice(-200), bReviews: bReviews.length, dB2: out(dB2).slice(-200), recB3: { verdict: recB3.verdict, via: recB3.via } })}\n--- the delegation (last, so a cut report keeps it): ${delegWhy} | grant exit ${gr.status}: ${out(gr).slice(-200)} | review: ${out(dl).slice(-120)}`]);

    // 5. a failed review files a fix task with the reviewer's words
    const C = make('Plan asset: dock lamp prop', 'artist-270v-c', 'dock', 'lamp', all3('good'));
    task(`done ${C.id} --agent artist-270v-c`);
    const failR = asset('review dock-lamp --fail "the lamp head is twice the size of the reference and the glass is opaque" --by Dana', base);
    const fixes = added((e) => e.meta?.fixOf === C.id);
    const dC = task(`done ${C.id} --agent artist-270v-c`);
    await guard('2.70.0 (v5): a failed review files a fix task (asset track) carrying the reviewer\'s words, and task done on the asset refuses naming them (2.69.0: no review)', () => [
      failR.status === 0 && fixes.length === 1 && /Fix asset dock-lamp after its review .*twice the size of the reference/.test(fixes[0].msg || '') && fixes[0].meta?.track === 'asset' && dC.status !== 0 && /review failed \(Dana: "the lamp head is twice the size/.test(out(dC)),
      JSON.stringify({ failR: out(failR).slice(-400), fixes, dC: out(dC).slice(-500) }).slice(0, 3000)]);

    // 6. a hard failure hands the asset back at once: no request, no review task
    const D = make('Plan asset: dock buoy prop', 'artist-270v-d', 'dock', 'buoy', { front: 'blank', 34: 'good', top: 'good' });
    const dD = task(`done ${D.id} --agent artist-270v-d`);
    let facts = null;
    try { facts = JSON.parse(fs.readFileSync(path.join(dir, '.studio', 'handback-facts', `${D.id}.json`), 'utf8')); } catch {}
    await guard('2.70.0 (v6): a hard preview failure at task done hands the asset straight back with the findings (FAIL line and Fix, kept for the hand-back facts): no review request, no review task (2.69.0: it landed)', () => [
      dD.status !== 0 && /\[asset-gate\] FAIL preview-blank assets\/dock\/buoy\.preview-front\.png/.test(out(dD)) && /\[asset-gate\] Fix: /.test(out(dD)) && /FAIL preview-blank/.test(facts?.text || '') && !exists('.studio/asset-reviews/dock-buoy.md') && !added((e) => e.meta?.assetReview === 'dock-buoy').length,
      JSON.stringify({ dD: out(dD).slice(-900), facts }).slice(0, 2500)]);
  }
}
