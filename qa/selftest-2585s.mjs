/**
 * qa/selftest-2585s.mjs — 2.58.5 (helper s): from a crew orchestrator's report (harness 2.58.3, Windows).
 *   H-3: task done re-ran the game's checks right after a green full verify, and under load that second run timed out
 *        (600 s) or flaked. A green full verify of the same tree now stands in for them (never a partial, dirty, old,
 *        narrower or other-tree record); after a rebase only the game checks whose inputs main changed run again; a
 *        landing takes the next free gate slot ahead of verifies.
 *   H-4: an upgrade stash took the board (DONE.md rows, NEXT.md tasks). `npm run upgrade -- --check` refuses while a
 *        board file is uncommitted and names stashes that hold board changes; the docs say commit the board first.
 *   H-11: every "no owner key" note says how: keygen on a device no agent runs on, commit only the public key.
 *   Seed rule: a loop over seeds and an assertion about the seed are not a seed special case.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest2585S({ dir, run, report, tmpRoot }) {
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd: dir, encoding: 'utf8' });
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  const env = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', GITHUB_BASE_REF: '', STUDIO_GAME: 'demo', STUDIO_REACHABILITY: 'off', STUDIO_DONE_NOOP: 'allow', STUDIO_DONE_REUSE_VERIFY: '', STUDIO_GATE_INCOMING_FILE: '', STUDIO_GATE_PRIORITY: '', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-2585s-${process.pid}.pem`), AGENT_EVENTS_FILE: path.join(dir, '.studio', 'events-2585s.jsonl') };
  const as = (agent, extra = {}) => ({ ...env, STUDIO_LOCK_OWNER: agent, ...extra });
  const probe = (name, code, penv = env) => {
    const f = path.join(tmpRoot, `probe-2585s-${name}-${process.pid}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node "${f}"`, penv);
    fs.rmSync(f, { force: true });
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return { ...JSON.parse(line), _out: out(r) }; } catch { return { _out: out(r).slice(-2000) }; }
  };

  // ---- H-3 (pure): when may a verify record stand in for task done's game checks? ----
  const pure = probe('judge', `import { judgeVerifyReuse } from ${u('harness/merge-lane.mjs')};
const T = 'a'.repeat(40), O = 'b'.repeat(40);
const rec = (x = {}) => ({ at: new Date().toISOString(), head: 'c'.repeat(40), tree: T, dirty: false, partial: false, rows: [{ id: 'game', ok: true, required: true }], ...x });
const ctx = (x = {}) => ({ tree: T, recTree: T, clean: true, changed: ['game/x/a.ts'], ...x });
const j = (r, c) => judgeVerifyReuse(r, c).ok;
console.log(JSON.stringify({
  good: j(rec(), ctx()), scopedGood: j(rec({ scoped: true, changed: ['game/x/a.ts', 'game/x/b.ts'] }), ctx()),
  oldOptIn: j(rec({ tree: undefined }), ctx({ optIn: true })),
  refused: {
    dirty: j(rec({ dirty: true }), ctx()), dirtyUnknown: j(rec({ dirty: null }), ctx()), partial: j(rec({ partial: true }), ctx()), fast: j(rec({ tier: 'fast' }), ctx()),
    otherTree: j(rec({ tree: O }), ctx({ recTree: O })), forgedTree: j(rec(), ctx({ recTree: O })), noTreeNoOptIn: j(rec({ tree: undefined }), ctx()),
    notClean: j(rec(), ctx({ clean: false })), gameFailed: j(rec({ rows: [{ id: 'game', ok: false }] }), ctx()), noGameRow: j(rec({ rows: [] }), ctx()), cached: j(rec({ rows: [{ id: 'game', ok: true, cached: true }] }), ctx()),
    old: j(rec({ at: new Date(Date.now() - 30 * 3600000).toISOString() }), ctx()), narrower: j(rec({ scoped: true, changed: ['game/x/b.ts'] }), ctx()),
    scopedButDoneRunsAll: j(rec({ scoped: true, changed: ['game/x/a.ts'] }), ctx({ changed: null })), engineMissing: j(rec(), ctx({ needEngine: ['godot/x'], hadEngine: [] })),
    relatedOnly: j(rec({ related: true }), ctx()), incomingOnly: j(rec({ incomingOnly: true }), ctx()), none: j(null, ctx()), unknownTree: j(rec(), ctx({ tree: '' })),
  },
}));`);
  report('2.58.5 (H-3): a green full verify stands in for task done\'s game checks only on the same tree, clean, full and at least as wide; dirty, partial, fast, other or forged tree, untracked files, failing, cached, old, narrower, no engine gate, related-only and landing re-check records never do',
    pure.good === true && pure.scopedGood === true && pure.oldOptIn === true && pure.refused && Object.values(pure.refused).every((v) => v === false), JSON.stringify(pure).slice(0, 2000));

  // ---- H-3 (end to end): task done with a game check that fails when run again (as under load) ----
  write('studio/gates.json', `${JSON.stringify({ gates: [{ id: 'protected', command: 'node qa/protected-check.mjs', required: true, lite: true }, { id: 'secrets', command: 'node scripts/secret-scan.mjs', required: true, lite: true }, { id: 'game', command: 'node harness/game-gates.mjs', required: true, lite: true, cache: false }] }, null, 2)}\n`);
  write('game/demo/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'test', command: 'node game/demo/check.mjs' }] }, null, 2)}\n`);
  write('game/demo/check.mjs', "if (process.env.FAKE_LOAD_FAIL === '1') { console.error('FAIL e2e/panel.e2e.ts: Error: Test timed out in 5000ms'); process.exit(1); }\nconsole.log('Test Files  3 passed (3)\\n     Tests  12 passed (12)');\n");
  write('game/demo/README.md', '# Demo\n');
  g('init', '-q', '-b', 'main'); g('config', 'core.autocrlf', 'false');
  g('add', '-A'); g('commit', '-qm', 'studio', '--no-verify');
  const id = (out(run(dir, 'node harness/task.mjs add "Docs: the demo readme says how to play" --role builder --priority P1', env)).match(/"id": "(T-\d+)"/) || [])[1];
  run(dir, `node harness/task.mjs start ${id} --agent bld-s1`, as('bld-s1'));
  fs.appendFileSync(path.join(dir, 'game/demo/README.md'), '\nClick to start.\n');
  g('add', 'game/demo/README.md'); g('commit', '-qm', `readme\n\nStudio-Task: ${id}`, '--no-verify');
  // An untracked file the verify ran beside (verify's clean tree counts tracked files only): task done must not trust it.
  write('scratch-2585s.txt', 'not committed\n');
  const v = run(dir, 'node scripts/run-gates.mjs', as('bld-s1'));
  const recFile = path.join(dir, '.studio', 'gates', 'bld-s1-full.json');
  const rec = (() => { try { return JSON.parse(fs.readFileSync(recFile, 'utf8')); } catch { return null; } })();
  const tree = g('rev-parse', 'HEAD^{tree}').stdout.trim();
  report('2.58.5 (H-3): a verify record names the tree it tested (HEAD^{tree} at the start) and the paths that scoped its game gate',
    v.status === 0 && rec?.tree === tree && rec.dirty === false && Array.isArray(rec.gatePaths), `${out(v).slice(-1200)}\n${JSON.stringify(rec)?.slice(0, 600)}`);

  const done = (extra = {}) => run(dir, `node harness/task.mjs done ${id} --agent bld-s1`, as('bld-s1', { FAKE_LOAD_FAIL: '1', ...extra }));
  // Refusals first (each leaves the task open): an untracked file, the switch off, a record whose tree isn't its commit's.
  const untracked = done();
  fs.rmSync(path.join(dir, 'scratch-2585s.txt'), { force: true });
  const off = done({ STUDIO_DONE_REUSE_VERIFY: 'off' });
  const good = fs.readFileSync(recFile, 'utf8');
  fs.writeFileSync(recFile, JSON.stringify({ ...JSON.parse(good), tree: 'f'.repeat(40) }));
  const forged = done();
  fs.writeFileSync(recFile, good);
  const reused = done();
  report('2.58.5 (H-3): task done doesn\'t run the game\'s checks again after a green full verify of the same tree (here they would fail, as under load); the safety checks still run',
    reused.status === 0 && /on this same tree .*not run again \(STUDIO_DONE_REUSE_VERIFY\)/.test(out(reused)) && /"status": "done"/.test(out(reused)) && !/FAIL e2e\/panel/.test(out(reused)), out(reused).slice(-1500));
  report('2.58.5 (H-3): with an untracked file in the copy, with STUDIO_DONE_REUSE_VERIFY=off, or with a record whose tree isn\'t its commit\'s, task done runs the game\'s checks (and here they fail)',
    untracked.status !== 0 && /can't stand in for them \(this copy has uncommitted or untracked files/.test(out(untracked)) && /the game's checks fail/.test(out(untracked))
      && off.status !== 0 && /the game's checks fail/.test(out(off)) && !/not run again/.test(out(off))
      && forged.status !== 0 && /isn't its commit's tree/.test(out(forged)) && /the game's checks fail/.test(out(forged)),
    `${out(untracked).slice(-700)}\n---\n${out(off).slice(-500)}\n---\n${out(forged).slice(-700)}`);

  // ---- H-3: the landing re-check after a rebase runs only the game checks whose inputs main changed ----
  write('game/duo/studio.gates.json', `${JSON.stringify({ gates: [
    { id: 'web', command: 'node -e "console.log(\'Tests 1 passed\')"', paths: ['game/duo/web/**'] },
    { id: 'engine', command: 'node -e "console.log(\'Tests 1 passed\')"', paths: ['game/duo/godot/**'] },
    { id: 'all', command: 'node -e "console.log(\'Tests 1 passed\')"' },
  ] }, null, 2)}\n`);
  const incFile = path.join(tmpRoot, `incoming-2585s-${process.pid}.json`);
  const gg = (incoming) => {
    if (incoming) fs.writeFileSync(incFile, JSON.stringify({ incoming })); else fs.rmSync(incFile, { force: true });
    const r = run(dir, 'node harness/game-gates.mjs --json --changed game/duo/web/a.ts,game/duo/godot/b.gd', { ...env, STUDIO_GAME: 'duo', STUDIO_GATE_INCOMING_FILE: incFile });
    try { const j = JSON.parse(r.stdout.trim().split('\n').pop()); return { ran: j.rows.map((x) => x.id).sort().join(','), skipped: j.skipped.map((x) => x.id).join(','), why: j.skipped.map((x) => x.why).join(' | '), ok: j.ok }; } catch { return { err: out(r).slice(-800) }; }
  };
  const godotOnly = gg(['game/duo/godot/b.gd', 'docs/notes.md']);
  const harnessIn = gg(['harness/x.mjs']);
  const unreadable = gg(null);
  const env2 = probe('recheck-env', `import { landingRecheckEnv } from ${u('harness/merge-lane.mjs')};
const root = ${JSON.stringify(path.join(tmpRoot, `recheck-2585s-${process.pid}`))};
const okEnv = landingRecheckEnv(root, 'T-9', { head: 'abc' }, { preHead: 'abc', incoming: ['web/a.ts'] });
const f = okEnv.STUDIO_GATE_INCOMING_FILE;
console.log(JSON.stringify({ wrote: Boolean(f) && JSON.parse((await import('node:fs')).readFileSync(f, 'utf8')).incoming[0] === 'web/a.ts', stale: Object.keys(landingRecheckEnv(root, 'T-9', { head: 'abc' }, { preHead: 'def', incoming: [] })).length, none: Object.keys(landingRecheckEnv(root, 'T-9', null, { preHead: 'abc', incoming: [] })).length }));`);
  report('2.58.5 (H-3): after a rebase, a game check whose declared paths none of main\'s incoming files touch is skipped (its pass on the pre-rebase commit stands); unscoped checks, shared files (harness/) and an unknown incoming list run everything; only a pass for the pre-rebase commit allows it',
    godotOnly.ran === 'game:all,game:engine' && godotOnly.skipped === 'game:web' && /it passed on this lane's commit before the rebase/.test(godotOnly.why) && godotOnly.ok === true
      && harnessIn.ran === 'game:all,game:engine,game:web' && unreadable.ran === 'game:all,game:engine,game:web'
      && env2.wrote === true && env2.stale === 0 && env2.none === 0,
    JSON.stringify({ godotOnly, harnessIn, unreadable, env2 }).slice(0, 2000));

  // ---- H-3: a landing takes the next free gate slot ahead of verifies ----
  const slots = probe('slots', `import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { withGateSlot } from ${u('harness/merge-lane.mjs')};
const root = ${JSON.stringify(path.join(tmpRoot, `slots-2585s-${process.pid}`))};
const locks = path.join(root, '.studio', 'locks');
fs.mkdirSync(locks, { recursive: true });
const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
const base = { STUDIO_GATE_SLOTS: '1', STUDIO_GATE_SLOT_WAIT_MIN: '0.02', STUDIO_GATE_SLOT_POLL_MS: '100' };
const timed = (label, env) => { const logs = []; const t = Date.now(); withGateSlot(root, label, () => {}, { env, log: (m) => logs.push(m) }); return { ms: Date.now() - t, logs: logs.join(' | ') }; };
// A landing is waiting (live marker): a verify leaves the free slot to it; the landing itself doesn't wait.
fs.writeFileSync(path.join(locks, \`gate-slot-landing-\${sleeper.pid}.wait\`), JSON.stringify({ pid: sleeper.pid, at: Date.now(), label: 'game:test (T-9 landing)' }));
const verifyWaits = timed('game:test', base);
const landingGoes = timed('game:test', { ...base, STUDIO_GATE_PRIORITY: 'landing' });
// A landing that has to wait leaves its marker while it waits, and takes it away after.
fs.writeFileSync(path.join(locks, 'gate-slot-1.lock'), JSON.stringify({ pid: sleeper.pid, at: Date.now(), label: 'verify' }));
fs.rmSync(path.join(locks, \`gate-slot-landing-\${sleeper.pid}.wait\`), { force: true });
const child = spawn(process.execPath, ['--input-type=module', '-e', \`import { withGateSlot } from \${JSON.stringify(${u('harness/merge-lane.mjs')})}; withGateSlot(\${JSON.stringify(root)}, 'game:test', () => {}, { env: { STUDIO_GATE_SLOTS: '1', STUDIO_GATE_SLOT_WAIT_MIN: '1', STUDIO_GATE_SLOT_POLL_MS: '100', STUDIO_GATE_PRIORITY: 'landing' } });\`], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));
const markerWhileWaiting = fs.existsSync(path.join(locks, \`gate-slot-landing-\${child.pid}.wait\`));
fs.rmSync(path.join(locks, 'gate-slot-1.lock'), { force: true });
const code = await new Promise((r) => child.on('exit', r));
const markerAfter = fs.existsSync(path.join(locks, \`gate-slot-landing-\${child.pid}.wait\`));
sleeper.kill();
await new Promise((r) => setTimeout(r, 200));
const afterDead = timed('game:test', base);
console.log(JSON.stringify({ verifyWaits, landingGoes, markerWhileWaiting, code, markerAfter, afterDead }));`);
  report('2.58.5 (H-3): while a landing waits for a gate slot (its marker), a verify leaves the free slot to it; the landing doesn\'t wait; its marker is there while it waits and gone after; a dead landing\'s marker doesn\'t hold verifies back',
    slots.verifyWaits?.ms >= 1000 && /a landing is waiting for a gate slot/.test(slots.verifyWaits.logs) && slots.landingGoes?.ms < 800 && !/waiting/.test(slots.landingGoes.logs)
      && slots.markerWhileWaiting === true && slots.code === 0 && slots.markerAfter === false && slots.afterDead?.ms < 800,
    JSON.stringify(slots).slice(0, 2000));

  // ---- H-4: the board is committed before an upgrade, never stashed ----
  g('add', '-A', 'studio'); g('commit', '-qm', 'board after the landings above', '--no-verify');
  fs.appendFileSync(path.join(dir, 'studio/NEXT.md'), '\n- [ ] T-990 added this morning, not committed\n');
  const dirty = run(dir, 'node harness/upgrade-guard.mjs --check', env);
  g('add', 'studio/NEXT.md'); g('commit', '-qm', 'board: snapshot before harness upgrade', '--no-verify');
  fs.appendFileSync(path.join(dir, 'studio/DONE.md'), '\n- [x] T-991 landed, row not committed\n');
  g('stash', 'push', '-m', 'pre-upgrade-2585s', '--', 'studio/DONE.md');
  const clean = run(dir, 'node harness/upgrade-guard.mjs --check --snapshot', env);
  const snap = (out(clean).match(/board copied to (\S+)/) || [])[1];
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const relDoc = fs.readFileSync(path.join(dir, 'docs/RELEASE.md'), 'utf8');
  report('2.58.5 (H-4): npm run upgrade -- --check refuses while a board file is uncommitted (names it and the commit to make), passes once it is committed, names a stash that holds board changes with the restore-by-merge steps; --snapshot copies the board; RELEASE.md says commit the board first, never stash it',
    dirty.status === 1 && /STOP: 1 board file\(s\) are not committed/.test(out(dirty)) && /studio\/NEXT\.md/.test(out(dirty)) && /git commit -m "board: snapshot before harness upgrade"/.test(out(dirty))
      && clean.status === 0 && /OK: every board file is committed/.test(out(clean)) && /stash@\{0\} \w+ "On main: pre-upgrade-2585s": studio\/DONE\.md/.test(out(clean)) && /git stash apply <sha>/.test(out(clean))
      && Boolean(snap) && fs.existsSync(path.join(dir, snap, 'studio', 'NEXT.md')) && /T-990/.test(fs.readFileSync(path.join(dir, snap, 'studio', 'NEXT.md'), 'utf8'))
      && pkg.scripts?.upgrade === 'node harness/upgrade-guard.mjs' && /Commit the board first/.test(relDoc) && /never by stashing its board/.test(relDoc),
    `${out(dirty)}\n---\n${out(clean)}`);
  g('stash', 'drop', '-q');

  // ---- seed rule: ordinary seeded tests aren't a seed special case; weakenings still are ----
  const seeds = probe('seeds', `import { weakeningsInDiff } from ${u('harness/test-weakening.mjs')};
const flagged = (text, file = 'src/sim/engine.test.ts') => weakeningsInDiff([{ file, oldFile: file, deleted: false, hunks: [{ removed: [], added: [{ line: 1, text }], at: 1 }] }]).some((x) => x.kind === 'seed-special-case');
const ordinary = ['const seed = 42;', 'it.each(seeds)("replays seed %i", (seed) => {', 'withSeed(7, () => run());', 'if (seed === fixtureSeed) return cached(seed);', 'for (const seed of [1, 2, 3]) {', 'expect(sim.seed !== 0).toBe(true);', 'expect(world.seed).toBe(12345);'];
const py = ['for seed in [1, 2, 3]:', 'for seed in (7, 11):', 'assert seed != 0'];
const weak = ['if (seed === 2) continue;', 'if ([7, 9].includes(seed)) return;', 'switch (seed) {', 'if (seed === 7) expect(x).toBe(1); else expect(x).toBe(2);', 'const expected = seed === 7 ? 1 : run(seed);', 'if (frame === 3) return;'];
const weakPy = ['if seed in [7, 9]: return', 'for seed in [1, 2, 3]: if seed == 2: continue'];
console.log(JSON.stringify({ fp: [...ordinary.filter((t) => flagged(t)), ...py.filter((t) => flagged(t, 'tests/test_engine.py'))], missed: [...weak.filter((t) => !flagged(t)), ...weakPy.filter((t) => !flagged(t, 'tests/test_engine.py'))] }));`);
  report('2.58.5: the seed rule doesn\'t flag ordinary seeded tests (a seed constant, it.each(seeds), withSeed(7, …), a fixture\'s seed variable, a loop over seeds in Python or GDScript, an assertion about the seed) and still flags a special case for one seed or tick',
    Array.isArray(seeds.fp) && !seeds.fp.length && Array.isArray(seeds.missed) && !seeds.missed.length, JSON.stringify(seeds).slice(0, 1500));

  // ---- H-11: every "no owner key" note says how ----
  const show = run(dir, 'node harness/approve.mjs show', env);
  write('src/zz2585.test.ts', "import { it, expect } from 'vitest';\nit('adds', () => { expect(1 + 1).toBe(2); });\n");
  g('add', 'src/zz2585.test.ts'); g('commit', '-qm', 'a test', '--no-verify');
  write('src/zz2585.test.ts', `import { it, expect } from 'vitest';\nit${['.', 'sk', 'ip'].join('')}('adds', () => { expect(1 + 1).toBe(2); });\n`);
  const tests = run(dir, 'node harness/test-weakening.mjs', { ...env, STUDIO_PROTECT_BASE: 'HEAD' });
  g('checkout', '-q', '--', 'src/zz2585.test.ts');
  const sign = run(dir, 'node harness/approve.mjs force T-1 --reason "only to see the message here"', env);
  const fix = probe('fix', `import { fixText } from ${u('harness/hook-stamp.mjs')};
console.log(JSON.stringify({ text: fixText([{ sha: 'a'.repeat(40) }]).join(' ') }));`);
  const keyFile = path.join(tmpRoot, `owner-2585s-${process.pid}`, 'owner-ed25519.pem');
  const kg = run(dir, 'node harness/approve.mjs keygen', { ...env, STUDIO_OWNER_KEY: keyFile });
  fs.rmSync(path.join(dir, 'studio', 'keys', 'owner-ed25519.pub.pem'), { force: true });
  fs.rmSync(path.dirname(keyFile), { recursive: true, force: true });
  const how = (s) => /a device no agent runs on/.test(s) && /npm run approve -- keygen/.test(s) && /commit only the public key studio\/keys\/owner-ed25519\.pub\.pem/.test(s) && /never copy it to the agents' PC/.test(s) && /An agent never runs keygen/.test(s);
  report('2.58.5 (H-11): the protected, weakened-tests and signing "no owner key" notes say exactly how (keygen on a device no agent runs on, commit only the public key, the private key never on the agents\' PC); the hooks fix text and keygen\'s own output say it too',
    how(out(show)) && /a warning only/.test(out(tests)) && how(out(tests)) && sign.status !== 0 && how(out(sign))
      && /one no agent runs on/.test(fix.text || '') && /an agent never runs keygen/.test(fix.text || '')
      && kg.status === 0 && /never copy it to the PC agents run on/.test(out(kg)) && /Commit only that file/.test(out(kg)) && /If agents run on this device, this was the wrong place/.test(out(kg)),
    `${out(show).slice(-600)}\n---\n${out(tests).slice(-600)}\n---\n${out(sign).slice(-500)}\n---\n${fix.text || fix._out}\n---\n${out(kg)}`);
}
