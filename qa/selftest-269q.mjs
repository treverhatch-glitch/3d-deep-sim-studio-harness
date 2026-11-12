/**
 * qa/selftest-269q.mjs — 2.69.0 (q): a red train's prefix search checks several prefixes at once. (2.84 (y): the optional
 * remote verify on the repo's own CI this file also covered is gone, and its checks with it.)
 *   Two red trains overnight bisected for 75-95 min each: 2.65.3 made each re-check short but still asked one prefix
 *   per round. Now (1) the binary search is K-ary: [lo, hi] is split into K+1 parts and the K boundary prefixes are
 *   re-checked at once, each in its own scratch copy, K = the focused re-check claims that fit the machine budget now
 *   (STUDIO_TRAIN_BISECT_PARALLEL caps it; no scan: 1, as before).
 * A tiny studio: a made-up game whose test check is a node script over game/demo/tests/*.test.mjs that fails a file a
 * note in game/demo/notes names ("BREAKS b.test.mjs") and logs each run (owner, start, end) to RAN_LOG.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest269Q({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { windowsHide: true, cwd, encoding: 'utf8' });
  const write = (base, rel, text) => { fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true }); fs.writeFileSync(path.join(base, rel), text); };
  const href = (rel) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);
  const parse = (r) => { try { return JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { return {}; } };

  // ---- 1-2. the pure pieces: the K-ary search and the width from the machine budget ----
  const pure = path.join(tmpRoot, `pure-269q-${process.pid}.mjs`);
  fs.writeFileSync(pure, `import { karySearch, karyPoints, karyCost, bisectWidth, parallelCap } from ${href('harness/train-parallel.mjs')};
const layouts = { first: [1], middle: [5], last: [9], two: [3, 7], twoLate: [8, 9] };
const n = 9;
const res = {};
for (const [name, culprits] of Object.entries(layouts)) {
  const row = {};
  for (const k of [1, 3]) {
    let maxPer = 0;
    const r = await karySearch({ lo: 0, hi: n, k, probe: async (pts) => { maxPer = Math.max(maxPer, pts.length); return pts.map((p) => ({ ok: !culprits.some((c) => c <= p) })); } });
    row[k] = { hi: r.hi, red: Boolean(r.red), rounds: r.rounds, maxPer };
  }
  res[name] = row;
}
const big = { os: { platform: 'linux' }, cores: { logical: 16 }, ram: { totalGb: 64, freeGb: 48 }, gpus: [], at: Date.now() };
const small = { os: { platform: 'linux' }, cores: { logical: 4 }, ram: { totalGb: 8, freeGb: 5 }, gpus: [], at: Date.now() };
const busy = [1, 2, 3, 4].map((i) => ({ pid: i, at: Date.now(), claim: { kind: 'verify', ramGb: 2, cpuThreads: 2 } }));
const env = { ...process.env, STUDIO_TRAIN_BISECT_PARALLEL: '3', STUDIO_HEAVY_SLOTS: '', STUDIO_RESERVE_RAM_GB: '', STUDIO_TEST_WORKERS: '', STUDIO_MACHINE_SCAN: '' };
const w = {
  none: await bisectWidth({ root: process.cwd(), env, machine: null, holders: [] }),
  big: await bisectWidth({ root: process.cwd(), env, machine: big, holders: [], nFiles: 1 }),
  cap1: await bisectWidth({ root: process.cwd(), env: { ...env, STUDIO_TRAIN_BISECT_PARALLEL: '1' }, machine: big, holders: [] }),
  busy: await bisectWidth({ root: process.cwd(), env, machine: big, holders: busy, nFiles: 1 }),
  small: await bisectWidth({ root: process.cwd(), env, machine: small, holders: [], nFiles: 1 }),
};
console.log(JSON.stringify({ res, w, pts: [karyPoints(0, 9, 3), karyPoints(0, 5, 3), karyPoints(2, 3, 3), karyPoints(0, 9, 1)], cost: [karyCost(9, 1), karyCost(9, 3), karyCost(32, 1), karyCost(32, 4)], capDef: parallelCap({}), capOff: parallelCap({ STUDIO_TRAIN_BISECT_PARALLEL: 'off' }) }));
`);
  const pr = run(dir, `node "${pure}"`);
  const pj = parse(pr);
  const L = pj.res || {};
  const same = Object.values(L).length === 5 && Object.values(L).every((row) => row[1] && row[3] && row[1].hi === row[3].hi && row[1].red === row[3].red);
  report('2.69.0 (q, 1): the K-ary prefix search finds the same first red prefix as the serial binary search on several layouts of 9 lanes (culprit first, middle, last, two culprits, two late) in fewer rounds (K=3: 2 rounds where serial takes 3-4), never more than K prefixes per round; the K boundaries split [lo, hi] into K+1 parts (fails on 2.68.0: harness/train-parallel.mjs does not exist)',
    pr.status === 0 && same && L.first[1].hi === 1 && L.middle[1].hi === 5 && L.last[1].hi === 9 && L.two[1].hi === 3 && L.twoLate[1].hi === 8
      && Object.values(L).every((row) => row[3].rounds < row[1].rounds && row[3].maxPer <= 3 && row[1].maxPer === 1)
      && JSON.stringify(pj.pts) === '[[2,4,6],[1,2,3],[],[4]]' && JSON.stringify(pj.cost) === JSON.stringify([{ rounds: 4, probes: 4 }, { rounds: 2, probes: 5 }, { rounds: 5, probes: 5 }, { rounds: 3, probes: 9 }]),
    `${out(pr).slice(-1500)}`);
  const W = pj.w || {};
  report('2.69.0 (q, 1): K respects the machine budget: no machine scan -> 1 (the 2.65.3 search); a 64 GB/16-thread scan -> 3 (capped by STUDIO_TRAIN_BISECT_PARALLEL=3); the cap 1 -> 1; every heavy slot already taken -> 1; an 8 GB/4-thread machine (one slot) -> 1; default cap 4, off -> 1 (fails on 2.68.0: no such width)',
    W.none?.k === 1 && /no machine scan/.test(W.none?.why || '') && W.big?.k === 3 && /fit the machine budget now/.test(W.big?.why || '') && W.cap1?.k === 1 && W.busy?.k === 1 && W.small?.k === 1 && pj.capDef === 4 && pj.capOff === 1,
    JSON.stringify(W));

  // ---- the studio and its made-up game ----
  const ranLog = path.join(tmpRoot, `ran-269q-${process.pid}.log`);
  const events = path.join(dir, '.studio', 'events-269q.jsonl');
  const env = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', GITHUB_BASE_REF: '', STUDIO_GAME: 'demo', STUDIO_REACHABILITY: 'off', STUDIO_DONE_NOOP: 'allow', STUDIO_DONE_REUSE_VERIFY: '', STUDIO_GATE_INCOMING_FILE: '', STUDIO_GATE_PRIORITY: '', STUDIO_GATE_CHANGED: '', STUDIO_GATE_PATHS: '', STUDIO_GATE_FOCUS: '', STUDIO_TRAIN: '', STUDIO_TRAIN_BISECT: '', STUDIO_TRAIN_LAND_PREFIX: 'off', STUDIO_TRAIN_MAX: '', STUDIO_TRAIN_BATCH: 'off', STUDIO_TRAIN_PIPELINE: 'off', STUDIO_TRAIN_CHAIN_TAIL: '', STUDIO_HOOKS_CHECK: 'on', STUDIO_LANE_LIVE_MIN: '0', STUDIO_COMPACT_OUTPUT: '', STUDIO_GAME_GATE_RETRY: '', STUDIO_HEAVY_SLOTS: '', STUDIO_TEST_WORKERS: '', STUDIO_RESERVE_RAM_GB: '', STUDIO_MACHINE_SCAN: '', STUDIO_TEST_MACHINE: 'none', STUDIO_TRAIN_BISECT_PARALLEL: '', GH_TOKEN: '', GITHUB_TOKEN: '', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-269q-${process.pid}.pem`), AGENT_EVENTS_FILE: events, RAN_LOG: ranLog, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const evs = () => { try { return fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const ran = () => { try { return fs.readFileSync(ranLog, 'utf8').split('\n').filter(Boolean).map((l) => { const [owner, file, start, end] = l.split('\t'); return { owner, file, start: Number(start), end: Number(end) }; }); } catch { return []; } };
  const resetRan = () => { try { fs.rmSync(ranLog, { force: true }); } catch {} };
  write(dir, 'studio/gates.json', `${JSON.stringify({ gates: [
    // A stand-in for qa/protected-check.mjs (a real violation is held at tier C before any verify): red when a note says VIOLATES-PROTECTED.
    { id: 'protected', command: 'node game/demo/protected-sim.mjs', required: true, lite: true },
    { id: 'secrets', command: 'node scripts/secret-scan.mjs', required: true, lite: true },
    { id: 'hooks', command: 'node harness/hook-stamp.mjs check', required: true, lite: true, cache: false },
    { id: 'game', command: 'node harness/game-gates.mjs', required: true, lite: true, cache: false },
  ] }, null, 2)}\n`);
  write(dir, 'game/demo/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'unit', command: 'node game/demo/run-tests.mjs', focus: 'node game/demo/run-tests.mjs {files}' }] }, null, 2)}\n`);
  write(dir, 'game/demo/run-tests.mjs', [
    "import fs from 'node:fs'; import path from 'node:path';",
    'const start = Date.now();',
    "const files = process.argv.slice(2); const d = 'game/demo/tests';",
    "const list = files.length ? files : fs.readdirSync(d).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => `${d}/${f}`);",
    "const nd = 'game/demo/notes';",
    "const notes = fs.existsSync(nd) ? fs.readdirSync(nd).map((f) => fs.readFileSync(path.join(nd, f), 'utf8')).join('\\n') : '';",
    'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);',
    'let bad = 0;',
    'for (const f of list) {',
    "  if (process.env.RAN_LOG) fs.appendFileSync(process.env.RAN_LOG, `${process.env.STUDIO_LOCK_OWNER || '-'}\\t${f}\\t${start}\\t${Date.now()}\\n`);",
    "  if (notes.includes(`BREAKS ${path.basename(f)}`)) { console.log(` FAIL  ${f} > adds up`); bad += 1; } else console.log(` \\u2713 ${f} (1 test)`);",
    '}',
    "console.log(`Test Files  ${bad ? `${bad} failed | ` : ''}${list.length - bad} passed (${list.length})`);",
    'process.exit(bad ? 1 : 0);', ''].join('\n'));
  write(dir, 'game/demo/protected-sim.mjs', "import fs from 'node:fs'; const d = 'game/demo/notes'; const bad = fs.readdirSync(d).filter((f) => fs.readFileSync(`${d}/${f}`, 'utf8').includes('VIOLATES-PROTECTED'));\nif (bad.length) { console.error(`[protected] FAIL a protected file changed without the owner's approval: ${bad.join(', ')}`); process.exit(1); }\nconsole.log('[protected] PASS');\n");
  for (const n of ['a', 'b']) write(dir, `game/demo/tests/${n}.test.mjs`, `// ${n}\n`);
  write(dir, 'game/demo/notes/readme.md', '# Notes\n');
  g(dir, 'init', '-q', '-b', 'main'); g(dir, 'config', 'core.autocrlf', 'false');
  g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'studio', '--no-verify');
  g(dir, 'config', 'core.hooksPath', 'scripts/hooks');
  const addTask = (title) => (out(run(dir, `node harness/task.mjs add "${title}" --role builder --priority P1`, env)).match(/"id": "(T-\d+)"/) || [])[1];
  const laneProbe = path.join(tmpRoot, `lane-269q-${process.pid}.mjs`);
  fs.writeFileSync(laneProbe, `import { createLaneCopy } from ${href('harness/worktree.mjs')};\nconsole.log(JSON.stringify(createLaneCopy(process.argv[2], { task: process.argv[3] })));\n`);
  const lane = (agent, title, files) => {
    const id = addTask(title);
    run(dir, `node "${laneProbe}" ${agent} ${id}`, env);
    const ld = path.join(dir, '.lanes', agent);
    const as = { ...env, STUDIO_MAIN_ROOT: dir, STUDIO_LOCK_OWNER: agent };
    const st = run(ld, `node harness/task.mjs start ${id} --agent ${agent}`, as);
    for (const [rel, text] of Object.entries(files)) write(ld, rel, text);
    g(ld, 'add', '-A');
    const c = spawnSync('git', ['commit', '-q', '-m', `${id}: ${title}`], { windowsHide: true, cwd: ld, encoding: 'utf8', env: { ...process.env, ...as } });
    const q = run(ld, `node harness/task.mjs done ${id} --agent ${agent} --train`, as);
    return { id, agent, ok: st.status === 0 && c.status === 0, log: `${out(st)}\n${out(c)}\n${out(q)}` };
  };
  const dropped = (id) => evs().some((e) => e.type === 'task.train.dropped' && e.task === id);
  const onMain = (rel) => g(dir, 'cat-file', '-e', `main:${rel}`).status === 0;

  // ---- 3. a red train of 5 lanes, the third breaks b.test.mjs, K = 3 from a roomy machine scan ----
  const P = [1, 2, 3, 4, 5].map((k) => lane(`pq-p${k}`, `Docs: note p${k}`, { [`game/demo/notes/p${k}.md`]: k === 3 ? 'BREAKS b.test.mjs\n' : `# p${k}\n` }));
  resetRan();
  const machine = JSON.stringify({ os: { platform: process.platform }, cores: { logical: 16 }, ram: { totalGb: 64, freeGb: 48 }, gpus: [], at: new Date().toISOString() });
  const before3 = evs().length;
  const t3 = run(dir, 'node harness/task.mjs train --by tester --now', { ...env, STUDIO_TEST_MACHINE: machine, STUDIO_TRAIN_BISECT_PARALLEL: '3' });
  const log3 = out(t3);
  const ev3 = evs().slice(before3);
  const re = ran().filter((r) => /-re\d*$/.test(r.owner));
  const r1 = re.filter((r) => ['re', 're2', 're3'].some((s) => r.owner.endsWith(`-${s}`)));
  const owners = [...new Set(r1.map((r) => r.owner.replace(/^.*-(re\d*)$/, '$1')))].sort();
  const overlap = r1.some((a) => r1.some((b) => a !== b && a.owner !== b.owner && a.start < b.end && b.start < a.end));
  const rounds = ev3.filter((e) => e.type === 'task.train.bisect_round');
  const leftovers = (() => { try { return fs.readdirSync(path.join(dir, '.lanes')).filter((n) => /^_train-.*-p\d+$/.test(n)); } catch { return []; } })();
  const branches = out(g(dir, 'branch', '--list', 'train/*')).trim();
  report('2.69.0 (q, 1): a red train of 5 lanes with room for 3 re-checks: "bisect round 1: checking prefixes 1, 2, 3 at once" names lane 3 in ONE round (serial: 2); the three re-checks ran at the same time, each in its own scratch copy (owners re, re2, re3), the culprit is handed back, lanes 1, 2, 4, 5 land, and the extra copies and their branches are removed (fails on 2.68.0: one prefix per round, no such line)',
    P.every((l) => l.ok) && t3.status === 0 && /the prefix search checks up to 3 prefixes at once: 3 re-check\(s\) fit the machine budget now/.test(log3) && /bisect round 1: checking prefixes 1, 2, 3 at once \(lanes 1-5; main green, red at 5 \(the verify\)\)/.test(log3)
      && rounds.length === 1 && JSON.stringify(rounds[0]?.meta?.prefixes) === '[1,2,3]' && JSON.stringify(owners) === '["re","re2","re3"]' && overlap
      && dropped(P[2].id) && [0, 1, 3, 4].every((i) => onMain(`game/demo/notes/p${i + 1}.md`)) && !onMain('game/demo/notes/p3.md') && !leftovers.length && !/-p\d/.test(branches),
    `ok=${P.map((l) => l.ok)} owners=${owners} overlap=${overlap} rounds=${rounds.length} left=${leftovers} branches=${branches}\nre=${JSON.stringify(re)}\n${log3.slice(-3000)}\n${P.find((l) => !l.ok)?.log.slice(-800) || ''}`);

  for (const p of [pure, laneProbe, ranLog]) { try { fs.rmSync(p, { force: true }); } catch {} }
}
