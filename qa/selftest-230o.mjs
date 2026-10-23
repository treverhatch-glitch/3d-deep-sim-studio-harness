/**
 * qa/selftest-230o.mjs — the 2.30o checks, run by qa/selftest.mjs on a copy of the repo.
 * Session stall check and wall-clock cap, visual proof (blank / near-identical captures, real Godot
 * capture), the split verdict, the layout gate, the Producer refill and milestones, the profile check,
 * credit tiers, and the always-on game-dev loop.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest230o({ dir, run, report, tmpRoot }) {
  let n = 0;
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const probe = (code, env = {}) => {
    const f = path.join(tmpRoot, `p230o-${++n}-${process.pid}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node "${f}"`, env);
    try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { error: out(r) }; }
  };
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  const base = { STUDIO_LOCK_OWNER: 'builder-o1', STUDIO_DONE_UNCOMMITTED: 'allow', STUDIO_DONE_NOOP: 'allow', STUDIO_REFILL_WAKE: 'off', STUDIO_WATCHDOG_LAUNCH: 'off', STUDIO_GAMEDEV_WAKE_DIRECTOR: 'off', STUDIO_DEV_CYCLE_WAKE: 'off' };

  // 1. Stall check and wall-clock cap.
  const sv = probe(`import { stallVerdict, stallLimits } from ${u('harness/stall.mjs')};
const t0 = Date.parse('2026-10-24T00:00:00Z'); const at = (m) => new Date(t0 + m * 60000).toISOString();
console.log(JSON.stringify({
  dir: stallVerdict({ role: 'director', startedAt: at(0), lastProgressAt: at(0) }, t0 + 9 * 60000),
  bld: stallVerdict({ role: 'builder', startedAt: at(0), lastProgressAt: at(0) }, t0 + 9 * 60000),
  bld16: stallVerdict({ role: 'builder', startedAt: at(0), lastProgressAt: at(0) }, t0 + 16 * 60000),
  wall: stallVerdict({ role: 'producer', startedAt: at(0), lastProgressAt: at(24) }, t0 + 26 * 60000),
  burn: stallVerdict({ role: 'builder', startedAt: at(0), lastProgressAt: at(4), windowIn: 2000000, windowOut: 11500 }, t0 + 5 * 60000),
  ok: stallVerdict({ role: 'builder', startedAt: at(0), lastProgressAt: at(4), windowIn: 2000000, windowOut: 400000 }, t0 + 5 * 60000),
  custom: stallLimits('builder', { STUDIO_STALL_MIN: '5' }).stallMin,
}));`);
  report('2.30o: a planning session with no progress for 8 min stalls; a builder gets 15', sv.dir?.stalled && sv.dir.kind === 'no-progress' && !sv.bld?.stalled && sv.bld16?.stalled && sv.custom === 5, JSON.stringify(sv));
  report('2.30o: a planning session past its wall-clock cap ends even while progressing', sv.wall?.stalled && sv.wall.kind === 'wall-clock', JSON.stringify(sv.wall));
  report('2.30o: an extreme input:output ratio with no progress (2M in, 11.5k out) is a read-burn stall; a normal ratio is not', sv.burn?.stalled && sv.burn.kind === 'read-burn' && !sv.ok?.stalled, JSON.stringify([sv.burn, sv.ok]));

  const ob = probe(`import fs from 'node:fs'; import path from 'node:path';
import { observe, readStall, logTokens } from ${u('harness/stall.mjs')};
const s = { agent: 'zz-stall', role: 'builder', startedAt: new Date(Date.now() - 20 * 60000).toISOString() };
const t = Date.now();
const a = observe(s, { now: t });
const b = observe(s, { now: t + 1000 });
fs.writeFileSync(path.join(${JSON.stringify(dir)}, 'zz-progress.txt'), 'x' + t);
const c = observe(s, { now: t + 2000 });
const tok = logTokens([JSON.stringify({ type: 'assistant', message: { id: 'm1', usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } } }), JSON.stringify({ type: 'assistant', message: { id: 'm1', usage: { input_tokens: 10, output_tokens: 5 } } }), JSON.stringify({ type: 'assistant', message: { id: 'm2', usage: { input_tokens: 1, output_tokens: 2 } } })].join('\\n'));
console.log(JSON.stringify({ a: a.stalled, b: b.stalled, c: c.stalled, last: readStall('zz-stall').lastProgressAt, tok }));`);
  fs.rmSync(path.join(dir, 'zz-progress.txt'), { force: true });
  report('2.30o: a file write counts as progress and clears the stall; tokens add up per message', ob.a === true && ob.b === true && ob.c === false && ob.tok?.in === 101 && ob.tok?.out === 7, JSON.stringify(ob));

  // 2. Visual proof.
  const vp = probe(`import fs from 'node:fs'; import path from 'node:path';
import { encodePng, decodePng } from ${u('harness/png.mjs')};
import { checkVisualProof, imageStats, proofDir } from ${u('harness/visual-proof.mjs')};
const img = (f) => { const W = 64, H = 48, rgba = new Uint8Array(W * H * 4); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; const v = f(x, y); rgba[i] = v[0]; rgba[i + 1] = v[1]; rgba[i + 2] = v[2]; rgba[i + 3] = v[3] ?? 255; } return { width: W, height: H, rgba }; };
const scene = img((x, y) => [x * 4, y * 5, 120]);
const changed = img((x, y) => (x > 20 && x < 44 && y > 10 && y < 40 ? [250, 220, 40] : [x * 4, y * 5, 120]));
const blank = img(() => [30, 30, 30]);
const clear = img((x, y) => [x * 4, y * 5, 120, 0]);
const rt = decodePng(encodePng(scene));
const put = (task, side, name, im) => { const d = path.join(proofDir(task), side); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name + '.png'), encodePng(im)); };
put('T-901', 'before', 'harbour', scene); put('T-901', 'after', 'harbour', changed);
put('T-902', 'before', 'harbour', scene); put('T-902', 'after', 'harbour', scene);
put('T-903', 'before', 'harbour', scene); put('T-903', 'after', 'harbour', blank);
put('T-905', 'before', 'harbour', scene); put('T-905', 'after', 'harbour', clear);
put('T-904', 'after', 'harbour', changed);
console.log(JSON.stringify({ rt: rt.width === 64 && rt.rgba[4 * 70] === scene.rgba[4 * 70], blank: imageStats(blank).blank, sceneBlank: imageStats(scene).blank,
  good: checkVisualProof('T-901'), same: checkVisualProof('T-902'), dark: checkVisualProof('T-903'), noBefore: checkVisualProof('T-904'), clear: checkVisualProof('T-905'), none: checkVisualProof('T-999') }));`);
  report('2.30o: the PNG reader round-trips; a flat frame is blank, a real one is not', vp.rt && vp.blank === true && vp.sceneBlank === false, JSON.stringify({ rt: vp.rt, blank: vp.blank, sceneBlank: vp.sceneBlank, e: vp.error }));
  report('2.30o: visual proof passes a changed before/after pair from the same camera', vp.good?.ok === true, JSON.stringify(vp.good));
  report('2.30o: visual proof fails a near-identical pair, a blank or transparent after frame, a missing before, and no captures', vp.same?.ok === false && /near-identical/.test(vp.same.why) && vp.dark?.ok === false && /blank/.test(vp.dark.why) && /transparent/.test(vp.clear?.why || '') && /no before capture/.test(vp.noBefore?.why || '') && vp.none?.ok === false, JSON.stringify([vp.same?.why, vp.dark?.why, vp.clear?.why, vp.noBefore?.why, vp.none?.why]));
  const vc = run(dir, 'node harness/visual-proof.mjs check T-901', base);
  const vcBad = run(dir, 'node harness/visual-proof.mjs check T-902', base);
  report('2.30o: npm run visual -- check exits 0/1 and records the visual result in the split verdict', vc.status === 0 && vcBad.status === 1 && /"visual"/.test(fs.readFileSync(path.join(dir, '.studio/proof/T-901/verdict.json'), 'utf8')), `${out(vc)}${out(vcBad)}`);

  // 3. Split verdict and task done.
  const vs = probe(`import { summarize, isRenderTask, setPart } from ${u('harness/verdict-split.mjs')};
setPart('T-950', 'build', { ok: true }); setPart('T-950', 'logic', { ok: true });
console.log(JSON.stringify({ r1: isRenderTask({ title: 'Godot: palms and beach' }), r2: isRenderTask({ title: 'Loan interest formula' }), r3: isRenderTask({ title: 'x', track: 'engine:godot' }),
  s: summarize('T-950', { title: 'Godot: palms and beach' }), l: summarize('T-950', { title: 'Loan interest formula' }) }));`);
  report('2.30o: render tasks are recognised by title or the Godot track; logic tasks are not', vs.r1 === true && vs.r2 === false && vs.r3 === true, JSON.stringify(vs));
  report('2.30o: the split verdict lists unchecked parts and blocks a render task without a visual result, not a logic task', vs.s?.ok === false && vs.s.unchecked.includes('visual') && vs.s.unchecked.includes('runtime') && vs.l?.ok === true, JSON.stringify([vs.s, vs.l]));
  const add = run(dir, 'node harness/task.mjs add "Godot: palm trees along the beach" --role builder --origin dev --asked "test"', base);
  const id = (out(add).match(/T-\d+/) || [])[0];
  run(dir, `node harness/task.mjs start ${id} --agent builder-o1`, base);
  const refused = run(dir, `node harness/task.mjs done ${id} --agent builder-o1`, base);
  const vdir = path.join(dir, '.studio/proof', id, 'visual');
  fs.cpSync(path.join(dir, '.studio/proof/T-901/visual'), vdir, { recursive: true });
  run(dir, `node harness/visual-proof.mjs check ${id}`, base);
  const ok = run(dir, `node harness/task.mjs done ${id} --agent builder-o1`, base);
  report('2.30o: task done refuses a render task until its visual proof passes, then moves on to its other checks', Boolean(id) && refused.status !== 0 && /visual result/.test(out(refused)) && !/visual result/.test(out(ok)), `${out(add)}${out(refused)}${out(ok)}`);

  // 4. Layout gate.
  const layout = { depth: { origin: [0, 0], cell: 1, rows: Array.from({ length: 10 }, (_, r) => Array.from({ length: 20 }, () => (r < 4 ? 0 : (r - 3) * 0.8))) },
    objects: [
      { id: 'pierA', kind: 'pier', x: 3, z: 6, w: 1, d: 8 }, { id: 'pierB', kind: 'pier', x: 10, z: 2, w: 1, d: 2 },
      { id: 'b1', kind: 'berth', x: 4, z: 8 }, { id: 'boat1', kind: 'boat', x: 4.5, z: 8, w: 1, d: 4, state: 'moored', berthOf: 'pierA' },
      { id: 'boat2', kind: 'boat', x: 15, z: 1, w: 0.3, d: 0.6, state: 'moored', berthOf: 'pierA' },
      { id: 'h1', kind: 'building', x: 3, z: 2.5, w: 3, d: 3 } ] };
  w('zz-layout.json', JSON.stringify(layout));
  const rules = { rules: [{ type: 'reach-depth', kind: 'pier', minDepth: 2 }, { type: 'on-water', kind: 'boat', minDepth: 0.5 }, { type: 'at-anchor', kind: 'boat', anchor: 'berth', maxDist: 1.5, when: 'moored' }, { type: 'no-overlap', kinds: ['pier', 'building'] }, { type: 'scale', kind: 'boat', min: 2, max: 30 }, { type: 'count', kind: 'pier', min: 2 }, { type: 'spread', kind: 'boat', by: 'berthOf', maxShare: 0.6, minCount: 2 }] };
  const lr = probe(`import fs from 'node:fs'; import { checkLayout } from ${u('harness/layout-gate.mjs')};
console.log(JSON.stringify(checkLayout(JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir, 'zz-layout.json'))}, 'utf8')), ${JSON.stringify(rules.rules)})));`);
  const byRule = Object.fromEntries((Array.isArray(lr) ? lr : []).map((r) => [r.rule.split(':')[0], r]));
  report('2.30o: the layout gate catches a pier on the sand, a boat on land and off its berth, overlaps, tiny boats and one berth taking all the demand',
    byRule['reach-depth']?.ok === false && /pierB/.test(byRule['reach-depth'].why) && !/pierA/.test(byRule['reach-depth'].why) && byRule['on-water']?.ok === false && /boat2/.test(byRule['on-water'].why) && byRule['at-anchor']?.ok === false && /boat2/.test(byRule['at-anchor'].why) && byRule['no-overlap']?.ok === false && byRule.scale?.ok === false && /boat2/.test(byRule.scale.why) && byRule.count?.ok === true && byRule.spread?.ok === false, JSON.stringify(lr));
  w('web/zz-lay/index.html', '<!doctype html>\n');
  w('web/zz-lay/sim/qa.mjs', 'process.exit(0);\n');
  w('web/zz-lay/studio.layout.json', JSON.stringify({ layout: 'zz-layout.json', rules: [{ type: 'reach-depth', kind: 'pier', minDepth: 2 }] }));
  const gl = run(dir, 'node harness/game-gates.mjs', { ...base, STUDIO_GAME: 'zz-lay' });
  w('web/zz-lay/studio.layout.json', JSON.stringify({ layout: 'zz-layout.json', hook: 'node -e "process.exit(0)"', rules: [{ type: 'count', kind: 'pier', min: 2 }] }));
  const gl2 = run(dir, 'node harness/game-gates.mjs', { ...base, STUDIO_GAME: 'zz-lay' });
  report('2.30o: a game with studio.layout.json gets a game:layout gate that fails on a broken rule and passes a met one', gl.status !== 0 && /FAIL game:layout/.test(out(gl)) && gl2.status === 0 && /PASS game:layout/.test(out(gl2)), `${out(gl)}${out(gl2)}`);

  // 5. Producer refill and milestones.
  w('studio/bible/CHARTER.md', '# Charter\n\n## Milestone ladder\n- M1 Early game — DONE.\n- M2 Busy Harbour: piers and berths.\n  Exit: moored-boats screenshot + overlap check 0; no dock takes >40% of waiting demand; two new boat types fire in seeds 1-8\n- M3 Resort: hotels.\n  Exit: visitor income 15% by day 20\n\n## Godot track\n- G3 Beach and piers. Exit: side-by-side shot\n');
  const ms = probe(`import { milestones, nextOpen } from ${u('harness/producer-refill.mjs')};
const m = milestones(); console.log(JSON.stringify({ ids: m.map((x) => x.id + ':' + x.closed + ':' + x.exit.length), next: nextOpen(m).map((x) => x.id) }));`);
  report('2.30o: the charter parses into ladders with exit criteria; M1 DONE is closed; the next open milestone per ladder', JSON.stringify(ms.ids) === JSON.stringify(['M1:true:0', 'M2:false:3', 'M3:false:1', 'G3:false:1']) && JSON.stringify(ms.next) === JSON.stringify(['M2', 'G3']), JSON.stringify(ms));
  const qbefore = fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8');
  const rf = run(dir, 'node harness/producer-refill.mjs --json', base);
  const rfj = (() => { try { return JSON.parse(out(rf).trim().split('\n').pop()); } catch { return {}; } })();
  const rf2 = run(dir, 'node harness/producer-refill.mjs --json', base);
  const rfj2 = (() => { try { return JSON.parse(out(rf2).trim().split('\n').pop()); } catch { return {}; } })();
  const nextNow = fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8');
  report('2.30o: with fewer than 4 builder tasks open the refill adds tasks from unmet exit criteria, tagged [ref:]', (rfj.refilled || []).length >= 2 && /\[ref:M2#1\]/.test(nextNow) && /\[ref:G3#1\]/.test(nextNow) && !/\[ref:M3#1\]/.test(nextNow) && qbefore !== nextNow, out(rf).slice(-1500));
  report('2.30o: a second refill never re-lists what is already queued', (rfj2.refilled || []).length === 0 || (rfj2.refilled || []).every((c) => !/M2#|G3#/.test(c.key)), out(rf2).slice(-1500));
  const dd = probe(`import { similar } from ${u('harness/producer-refill.mjs')};
console.log(JSON.stringify({ s: similar('Godot water with waves and shoreline foam', 'G1 Water with waves + shoreline foam: meet exit criterion') }));`);
  report('2.30o: a done task with the same words counts as covered (60% word overlap)', dd.s >= 0.6, JSON.stringify(dd));
  run(dir, 'node harness/producer-refill.mjs met M3 1 --by director', base);
  const wd = run(dir, 'node harness/watchdog.mjs pass', { ...base, STUDIO_GAME: 'zz-lay', STUDIO_GAMEDEV_SKIP: 'stall,landing,tiers,review,refill,cycle' });
  const ms2 = probe(`import { milestones } from ${u('harness/producer-refill.mjs')}; console.log(JSON.stringify(milestones().filter((m) => m.closed).map((m) => m.id)));`);
  report('2.30o: a milestone whose exit criteria are all met is closed by the game-dev loop and the next opens', Array.isArray(ms2) && ms2.includes('M3') && /M3 met every exit criterion/.test(out(wd)), `${out(wd)}${JSON.stringify(ms2)}`);

  // 6. The watchdog runs on its own while a game is active.
  const off = run(dir, 'node harness/watchdog.mjs pass', { ...base, STUDIO_GAME: '' });
  const offEnv = run(dir, 'node harness/watchdog.mjs pass', { ...base, STUDIO_GAME: 'zz-lay', STUDIO_WATCHDOG: 'off' });
  const auto = probe(`import { watchdogPass } from ${u('harness/watchdog.mjs')}; const r = await watchdogPass(); console.log(JSON.stringify({ on: r.on, auto: r.auto, kinds: r.actions.map((a) => a.kind) }));`, { ...base, STUDIO_GAME: 'zz-lay', STUDIO_GAMEDEV_SKIP: 'stall,landing,tiers' });
  report('2.30o: the watchdog is on by itself while a studio game is active (no away mode), off with no game or STUDIO_WATCHDOG=off', /Watchdog is off/.test(out(off)) && /Watchdog is off/.test(out(offEnv)) && auto.on === true && auto.auto === true && auto.kinds?.includes('review-pass'), `${out(off)}${out(offEnv)}${JSON.stringify(auto)}`);

  // 7. Profile check before launch.
  const pg = probe(`import { profileGuard, profileOf } from ${u('harness/profile-guard.mjs')};
const env = { STUDIO_SHARED_PROFILES: 'shared,pool' };
console.log(JSON.stringify({
  p1: profileOf('director', 'hermes -p gemini-b chat'), p2: profileOf('director', 'x --profile=dir1'), p3: profileOf('director', '', { STUDIO_DIRECTOR_PROFILE: 'mine' }), p4: profileOf('builder', 'claude'),
  shared: profileGuard({ role: 'director', profile: 'shared', running: [], env }),
  busy: profileGuard({ role: 'producer', profile: 'b2', running: [{ agent: 'builder-3', role: 'builder', profile: 'b2' }], env }),
  own: profileGuard({ role: 'director', profile: 'dir1', running: [{ agent: 'builder-3', role: 'builder', profile: 'b2' }], env }),
  builderShared: profileGuard({ role: 'builder', profile: 'shared', running: [], env }),
  max: profileGuard({ role: 'builder', profile: 'b2', running: [{ role: 'builder', profile: 'b2' }], env: { STUDIO_PROFILE_MAX_SESSIONS: '1' } }),
}));`);
  report('2.30o: the profile comes from STUDIO_<ROLE>_PROFILE or the launch command (-p / --profile)', pg.p1 === 'gemini-b' && pg.p2 === 'dir1' && pg.p3 === 'mine' && pg.p4 === 'default', JSON.stringify(pg));
  report('2.30o: a Producer/Director never starts on a shared builder profile or one a builder is using; per-profile limits hold', pg.shared?.ok === false && pg.busy?.ok === false && pg.own?.ok === true && pg.builderShared?.ok === true && pg.max?.ok === false, JSON.stringify(pg));
  const sa = probe(`import { startAgent } from ${u('harness/agent.mjs')}; console.log(JSON.stringify(startAgent({ role: 'director', agent: 'director-zz', tool: 'custom', model: 'm' })));`, { ...base, STUDIO_AGENT_CMD: 'hermes -p pool chat', STUDIO_SHARED_PROFILES: 'pool' });
  report('2.30o: startAgent refuses the Director on the shared profile before anything launches', sa.ok === false && /shared builder profile "pool"/.test(sa.message || ''), JSON.stringify(sa));

  // 8. Spend guard takeover (budget order) and idle sessions exiting.
  w('studio/budget.json', JSON.stringify({ order: ['gemini', 'hermes', 'claude'], tools: {} }));
  w('.studio/credit.json', JSON.stringify({ gemini: { used: 96, guard: 100 }, hermes: { used: 10, guard: 100 } }));
  const sg = probe(`import { spendGuardPass } from ${u('harness/spend-guard.mjs')}; import { pickTool, quotaMark, toolNamed } from ${u('harness/budget.mjs')};
const before = pickTool('gemini'); const r = spendGuardPass(); const again = spendGuardPass();
console.log(JSON.stringify({ before, r, again: again.length, after: pickTool('gemini'), mark: quotaMark('gemini'), named: [toolNamed('hermes: 429 too many requests'), toolNamed('grokbot out of credits')] }));`, { STUDIO_TOOL_HERMES_CMD: 'hermes -p b1 chat' });
  const ev = fs.existsSync(path.join(dir, '.studio/events.jsonl')) ? fs.readFileSync(path.join(dir, '.studio/events.jsonl'), 'utf8') : '';
  report('2.30o: a spend guard marks the tool out exactly like a quota error; the next tool in the order (hermes) takes over and the human is told', sg.before === 'gemini' && sg.r?.[0]?.to === 'hermes' && sg.after === 'hermes' && sg.again === 0 && sg.mark?.guard === true && /"type":"tool.takeover"/.test(ev) && /"to":"human"/.test(ev), JSON.stringify(sg));
  report('2.30o: hermes and grokbot errors are attributed to their own tools', JSON.stringify(sg.named) === JSON.stringify(['hermes', 'grokbot']), JSON.stringify(sg.named));
  const lt = probe(`import { startAgent } from ${u('harness/agent.mjs')}; console.log(JSON.stringify(startAgent({ role: 'builder', agent: 'builder-zzt', model: 'm' }, { detach: false }) && 'ok'));`, { ...base, STUDIO_AGENT_TOOL: 'gemini', STUDIO_TOOL_HERMES_CMD: 'node -e "process.exit(0)"', STUDIO_HEARTBEAT_SEC: '1' });
  const evs = fs.readFileSync(path.join(dir, '.studio/events.jsonl'), 'utf8');
  report('2.30o: a session started with no tool given goes to the next tool when the preferred one is marked out', /gemini is marked out; builder-zzt starts on hermes/.test(evs), `${JSON.stringify(lt)} ${evs.split('\n').filter((l) => /builder-zzt/.test(l)).slice(0, 3).join(' ')}`);
  const iv = probe(`import { idleVerdict } from ${u('harness/stall.mjs')}; const t = Date.parse('2026-10-24T00:00:00Z'); const at = (m) => new Date(t + m * 60000).toISOString();
console.log(JSON.stringify({ a: idleVerdict({ role: 'builder', startedAt: at(0), idleSince: at(0) }, t + 6 * 60000), b: idleVerdict({ role: 'builder', startedAt: at(0), idleSince: at(3) }, t + 6 * 60000), c: idleVerdict({ role: 'builder', startedAt: at(0), idleSince: null }, t + 60 * 60000), d: idleVerdict({ role: 'director', startedAt: at(0), idleSince: at(0) }, t + 60 * 60000, { STUDIO_IDLE_EXIT_ROLES: 'builder' }) }));`);
  report('2.30o: a session holding no task for 5 min exits; one that holds a task, or a role left out of STUDIO_IDLE_EXIT_ROLES, does not', iv.a?.exit === true && iv.b?.exit === false && iv.c?.exit === false && iv.d?.exit === false, JSON.stringify(iv));
  w('zz-sleep.mjs', 'setTimeout(() => {}, 60000);\n');
  const t0 = Date.now();
  const idle = run(dir, 'node harness/agent.mjs start --role builder --agent builder-idle --tool custom --model m', { ...base, STUDIO_AGENT_CMD: 'node zz-sleep.mjs', STUDIO_HEARTBEAT_SEC: '1', STUDIO_IDLE_EXIT_MIN: '0.05' });
  const secs = (Date.now() - t0) / 1000;
  const evi = fs.readFileSync(path.join(dir, '.studio/events.jsonl'), 'utf8');
  report('2.30o: the launcher ends an idle session itself (agent.idle_exit) and frees its slot, long before the work would end', /"type":"agent.idle_exit"[^\n]*builder-idle|builder-idle[^\n]*"type":"agent.idle_exit"/.test(evi) && secs < 40, `${secs}s ${out(idle).slice(-800)}`);
  const t1 = Date.now();
  run(dir, 'node harness/agent.mjs start --role director --agent director-stall --tool custom --model m', { ...base, STUDIO_AGENT_CMD: 'node zz-sleep.mjs', STUDIO_HEARTBEAT_SEC: '1', STUDIO_STALL_PLAN_MIN: '0.05' });
  const evs2 = fs.readFileSync(path.join(dir, '.studio/events.jsonl'), 'utf8');
  report('2.30o: the launcher ends a Director session that makes no progress (session.stall) and logs why', /"type":"session.stall"[^\n]*director-stall|director-stall[^\n]*"type":"session.stall"/.test(evs2) && (Date.now() - t1) / 1000 < 40, evs2.split('\n').filter((l) => /director-stall/.test(l)).slice(-3).join(' '));

  // 8b. Generic run-out: any launcher, any tool name; the next entry in the order takes the task over.
  const pt = probe(`import { providerTrouble } from ${u('harness/agent.mjs')};
const five = ['HTTP 503 Service Unavailable error', 'status 529 overloaded_error', 'HTTP 503 Service Unavailable error'].join('\\n');
console.log(JSON.stringify({ five: providerTrouble(five, 1)?.kind, two: providerTrouble('HTTP 503 Service Unavailable error\\nok', 1)?.kind ?? null, credit: providerTrouble('Error: credits refused for this key', 1)?.kind, cap: providerTrouble('Error: token cap reached for project', 1)?.kind, said: providerTrouble(JSON.stringify({ type: 'assistant', message: { content: 'HTTP 503 overloaded error' } }).repeat(1) + '\\n' + JSON.stringify({ type: 'assistant', message: { content: '503 error overloaded' } }) + '\\n' + JSON.stringify({ type: 'assistant', message: { content: '503 error overloaded' } }), 0) ?? null }));`);
  report('2.30o: run-outs are detected for any launcher: 5xx refusals in a loop, credit refused, a token cap; one 5xx or the agent quoting one is not', pt.five === 'quota' && pt.two === null && pt.credit === 'quota' && pt.cap === 'quota' && pt.said === null, JSON.stringify(pt));
  w('studio/budget.json', JSON.stringify({ order: ['zzalpha', 'zzbeta'], tools: {} }));
  fs.rmSync(path.join(dir, '.studio/tool-quota.json'), { force: true });
  w('zz-out.mjs', "console.error('Error: credits refused for this key'); process.exit(1);\n");
  w('zz-ok.mjs', "process.exit(0);\n");
  const to = run(dir, 'node harness/agent.mjs start --role qa-playtester --agent qa-zzto --tool zzalpha --model m1', { ...base, STUDIO_TOOL_ZZALPHA_CMD: 'node zz-out.mjs', STUDIO_TOOL_ZZBETA_CMD: 'node zz-ok.mjs', STUDIO_HEARTBEAT_SEC: '1' });
  const evt = fs.readFileSync(path.join(dir, '.studio/events.jsonl'), 'utf8');
  const qm = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, '.studio/tool-quota.json'), 'utf8')); } catch { return {}; } })();
  report('2.30o: a session on any tool that runs out is marked out and the next tool in the order takes over at once (no hardcoded tool names)', Boolean(qm.zzalpha) && /qa-zzto ran out on zzalpha[^"]*: zzbeta takes over/.test(evt) && /failed over to zzbeta/.test(evt), `${out(to).slice(-600)} ${JSON.stringify(qm)} ${evt.split('\n').filter((l) => /qa-zzto/.test(l)).slice(-4).join(' ')}`);
  const iv2 = probe(`import { idleVerdict } from ${u('harness/stall.mjs')}; const t = Date.parse('2026-10-24T00:00:00Z');
console.log(JSON.stringify({ d: idleVerdict({ role: 'director', startedAt: new Date(t).toISOString(), idleSince: new Date(t).toISOString() }, t + 6 * 60000), off: idleVerdict({ role: 'director', startedAt: new Date(t).toISOString(), idleSince: new Date(t).toISOString() }, t + 6 * 60000, { STUDIO_IDLE_EXIT_MIN: '0' }) }));`);
  report('2.30o: idle exit applies to any role by default (STUDIO_IDLE_EXIT_MIN=0 turns it off)', iv2.d?.exit === true && iv2.off?.exit === false, JSON.stringify(iv2));
  const gl0 = run(dir, 'node harness/watchdog.mjs loop 180 --once', { ...base, STUDIO_GAME: '' });
  report('2.30o: the stand-alone game-dev loop is off with no active game', /\[gamedev\] off/.test(out(gl0)), out(gl0));
  run(dir, 'node harness/away.mjs on --by zz', base);
  const aw = probe(`import { gamedevPass } from ${u('harness/gamedev-loop.mjs')}; import { parseNextQueue } from ${u('harness/task.mjs')};
const before = [...parseNextQueue().backlog, ...parseNextQueue().inProgress].filter((t) => t.role === 'builder').length;
await gamedevPass(Date.now() + 86400000);
console.log(JSON.stringify({ before, after: [...parseNextQueue().backlog, ...parseNextQueue().inProgress].filter((t) => t.role === 'builder').length }));`, { ...base, STUDIO_GAME: 'zz-lay', STUDIO_GAMEDEV_SKIP: 'stall,landing,tiers,review,launch,cycle', STUDIO_REFILL_AHEAD: '3' });
  run(dir, 'node harness/away.mjs back --by zz', base);
  report('2.30o: away mode means more autonomy: the refill keeps 6 builder tasks open instead of 4', aw.after >= 6 || (aw.after > aw.before && aw.after >= 5), JSON.stringify(aw));

  // 8c. The standing development cycle: thin-brief expansion, an always-extending ladder, a brief.
  const dc = probe(`import { bibleGaps, cyclePass, ladderEnds } from ${u('harness/dev-cycle.mjs')}; import { parseNextQueue } from ${u('harness/task.mjs')};
const gaps = bibleGaps();
const ends = await ladderEnds();
const first = await cyclePass({ wake: false, force: true });
const again = await cyclePass({ wake: false, now: Date.now() + 60000 });
const forced = await cyclePass({ wake: false, force: true });
const q = parseNextQueue(); const all = [...q.backlog, ...q.inProgress];
console.log(JSON.stringify({ gaps, ends, first, again, forcedFiled: forced.filed.length, director: all.filter((t) => t.role === 'director').map((t) => t.title) }));`, base);
  const dtitles = (dc.director || []).join(' | ');
  report('2.30o: a thin bible (no core loop, feel, progression, late game) gets Director tasks to write them as marked assumptions, without waiting', ['core loop', 'feel', 'progression', 'late game'].every((g) => (dc.gaps || []).includes(g)) && /core loop doc[^|]*ASSUMPTION/.test(dtitles) && /late game doc/.test(dtitles), JSON.stringify(dc).slice(0, 1500));
  report('2.30o: a ladder whose last milestone is half met (or done) gets a Director task to propose the next milestone', (dc.ends || []).some((e) => e.next === 'M4') && /Propose M4/.test(dtitles), JSON.stringify(dc.ends));
  report('2.30o: the cycle writes a brief, runs on its clock or when the queue is low, and never files the same task twice', dc.first?.ran === true && fs.existsSync(path.join(dir, '.studio/briefs/dev-cycle.md')) && dc.again?.ran === false && dc.forcedFiled === 0, JSON.stringify([dc.first, dc.again, dc.forcedFiled]));
  w('studio/bible/systems/core-loop.md', '# Core loop\n');
  const dg = probe(`import { bibleGaps } from ${u('harness/dev-cycle.mjs')}; console.log(JSON.stringify(bibleGaps()));`);
  report('2.30o: a bible doc named for a core part closes that gap', Array.isArray(dg) && !dg.includes('core loop'), JSON.stringify(dg));

  // 9. A real Godot frame (when the box has Godot), captured under OpenGL.
  const real = process.env.STUDIO_GODOT_REAL || '/workspace/tools/godot472/Godot_v4.7.2-stable_linux.x86_64';
  if (process.platform === 'linux' && fs.existsSync(real)) {
    const scene = (color) => `[gd_scene load_steps=3 format=3]\n\n[sub_resource type="BoxMesh" id="1"]\nsize = Vector3(4, 3, 2)\n\n[sub_resource type="StandardMaterial3D" id="2"]\nalbedo_color = Color(${color})\n\n[node name="Main" type="Node3D"]\n\n[node name="Sun" type="DirectionalLight3D" parent="."]\ntransform = Transform3D(1, 0, 0, 0, 0.7, 0.7, 0, -0.7, 0.7, 0, 5, 0)\n\n[node name="Box" type="MeshInstance3D" parent="."]\nmesh = SubResource("1")\nsurface_material_override/0 = SubResource("2")\n\n[node name="harbour" type="Camera3D" parent="."]\ntransform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0.6, 0.3, 5)\n`;
    w('godot/zo/project.godot', 'config_version=5\n\n[application]\nrun/main_scene="res://main.tscn"\n\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
    w('godot/zo/main.tscn', scene('0.05, 0.05, 0.3, 1'));
    const env = { ...base, STUDIO_GODOT: real, DISPLAY: '' };
    const c1 = run(dir, 'node harness/visual-proof.mjs capture T-960 before --godot godot/zo --cams harbour --frames 10', env);
    w('godot/zo/main.tscn', scene('1, 1, 1, 1'));
    const c2 = run(dir, 'node harness/visual-proof.mjs capture T-960 after --godot godot/zo --cams harbour --frames 10', env);
    const chk = run(dir, 'node harness/visual-proof.mjs check T-960', env);
    report('2.30o: real Godot 4.7.2: a named camera is captured under OpenGL (xvfb), and a visible change passes the visual proof', c1.status === 0 && c2.status === 0 && chk.status === 0, `${out(c1)}${out(c2)}${out(chk)}`.slice(-3000));
    const c3 = run(dir, 'node harness/visual-proof.mjs capture T-961 after --godot godot/zo --cams nosuchcam --frames 5', env);
    report('2.30o: real Godot: a camera name the scene lacks fails the capture', c3.status !== 0, out(c3).slice(-1500));
  }
}
