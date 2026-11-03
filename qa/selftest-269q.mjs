/**
 * qa/selftest-269q.mjs — 2.69.0 (q): a red train's prefix search checks several prefixes at once, and an optional
 * remote verify on the repo's own CI.
 *   Two red trains overnight bisected for 75-95 min each: 2.65.3 made each re-check short but still asked one prefix
 *   per round. Now (1) the binary search is K-ary: [lo, hi] is split into K+1 parts and the K boundary prefixes are
 *   re-checked at once, each in its own scratch copy, K = the focused re-check claims that fit the machine budget now
 *   (STUDIO_TRAIN_BISECT_PARALLEL caps it; no scan: 1, as before); (2) STUDIO_VERIFY_REMOTE=github pushes the train's
 *   commit to train/<id>, uses a green CI result as the verify, falls back to the local verify on anything else, and
 *   deletes only its own train/<id> branch. Tested with a fake GitHub client and a fake fetch (no network).
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
  const env = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', GITHUB_BASE_REF: '', STUDIO_GAME: 'demo', STUDIO_REACHABILITY: 'off', STUDIO_DONE_NOOP: 'allow', STUDIO_DONE_REUSE_VERIFY: '', STUDIO_GATE_INCOMING_FILE: '', STUDIO_GATE_PRIORITY: '', STUDIO_GATE_CHANGED: '', STUDIO_GATE_PATHS: '', STUDIO_GATE_FOCUS: '', STUDIO_TRAIN: '', STUDIO_TRAIN_BISECT: '', STUDIO_TRAIN_LAND_PREFIX: 'off', STUDIO_TRAIN_MAX: '', STUDIO_TRAIN_CHAIN_TAIL: '', STUDIO_HOOKS_CHECK: 'on', STUDIO_LANE_LIVE_MIN: '0', STUDIO_COMPACT_OUTPUT: '', STUDIO_GAME_GATE_RETRY: '', STUDIO_HEAVY_SLOTS: '', STUDIO_TEST_WORKERS: '', STUDIO_RESERVE_RAM_GB: '', STUDIO_MACHINE_SCAN: '', STUDIO_TEST_MACHINE: 'none', STUDIO_TRAIN_BISECT_PARALLEL: '', STUDIO_VERIFY_REMOTE: '', GH_TOKEN: '', GITHUB_TOKEN: '', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-269q-${process.pid}.pem`), AGENT_EVENTS_FILE: events, RAN_LOG: ranLog, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
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

  // ---- 4-5. remote verify: the pure flow with a fake client and a fake fetch ----
  const rp = path.join(tmpRoot, `remote-269q-${process.pid}.mjs`);
  fs.writeFileSync(rp, `import { remoteVerify, parseGithubRemote, githubClient, remoteMode, localGateIds } from ${href('harness/remote-verify.mjs')};
const TOKEN = 'tok-secret-269q';
const env = { STUDIO_VERIFY_REMOTE: 'github', GH_TOKEN: TOKEN, STUDIO_VERIFY_REMOTE_TIMEOUT_MIN: '60', STUDIO_VERIFY_REMOTE_START_MIN: '10', STUDIO_VERIFY_REMOTE_POLL_S: '30' };
const mk = (o = {}) => {
  const calls = [];
  let polls = 0;
  const client = {
    async repo() { calls.push('repo'); if (o.repoErr) throw new Error('HTTP 500 for ' + TOKEN); return { private: Boolean(o.private) }; },
    async branchExists(b) { calls.push('exists ' + b); return Boolean(o.exists); },
    async push(sha, b) { calls.push('push ' + b); if (o.pushErr) throw new Error('push refused, token ' + TOKEN); },
    async checkRuns() { polls += 1; calls.push('runs'); return o.runs ? o.runs(polls) : []; },
    async deleteBranch(b) { calls.push('delete ' + b); },
  };
  return { calls, client };
};
const go = async (o, e = env) => { const f = mk(o); let t = 0; const logs = []; const r = await remoteVerify({ root: process.cwd(), id: '20261102-1', sha: 'abc1234def', env: e, client: o.noClient ? null : f.client, log: (m) => logs.push(m), now: () => t, sleep: async (ms) => { t += ms; } }); return { r, calls: f.calls, logs, t }; };
const done = (c) => [{ name: 'lint', status: 'completed', conclusion: 'success' }, { name: 'release-gate', status: 'completed', conclusion: c }];
const out = {
  green: await go({ runs: (n) => (n < 3 ? [{ name: 'release-gate', status: 'in_progress', conclusion: null }] : done('success')) }),
  skipped: await go({ runs: () => done('skipped') }),
  noNamed: await go({ runs: () => [{ name: 'lint', status: 'completed', conclusion: 'success' }, { name: 'docs', status: 'completed', conclusion: 'success' }] }),
  custom: await go({ runs: () => [{ name: 'ci', status: 'completed', conclusion: 'success' }] }, { ...env, STUDIO_VERIFY_REMOTE_CHECK: '^ci$' }),
  red: await go({ runs: () => done('failure') }),
  pushErr: await go({ pushErr: true }),
  repoErr: await go({ repoErr: true }),
  timeout: await go({ runs: () => [{ name: 'release-gate', status: 'in_progress', conclusion: null }] }),
  noStart: await go({ runs: () => [] }),
  exists: await go({ exists: true }),
  priv: await go({ private: true }),
  off: await go({}, { ...env, STUDIO_VERIFY_REMOTE: '' }),
  noToken: await go({ noClient: true }, { STUDIO_VERIFY_REMOTE: 'github' }),
};
const seen = [];
const fakeFetch = async (url, init) => { seen.push(init.method + ' ' + url.replace('https://api.github.com', '') + ' auth=' + (init.headers.Authorization === 'Bearer ' + TOKEN)); return { status: 204, ok: true, json: async () => ({}) }; };
const real = githubClient({ root: process.cwd(), owner: 'o', repo: 'r', token: TOKEN, fetchImpl: fakeFetch });
const refused = [];
for (const b of ['main', 'train/../main', 'refs/heads/main', 'feature/x']) { try { await real.deleteBranch(b); } catch { refused.push(b); } }
await real.deleteBranch('train/20261102-1');
console.log(JSON.stringify({ out, seen, refused, local: localGateIds([{ id: 'protected' }, { id: 'secrets' }, { id: 'hooks' }, { id: 'weakened-tests' }, { id: 'golden' }, { id: 'regressions' }, { id: 'game', command: 'node harness/game-gates.mjs' }, { id: 'unit2', command: 'node harness/game-gates.mjs --x' }, { id: 'engine' }, { id: 'engine:godot' }, { id: 'godot-unit' }, { id: 'browser-play' }, { id: 'soak', heavy: true }], ['game']), parse: [parseGithubRemote('https://github.com/acme/demo.git'), parseGithubRemote('git@github.com:acme/demo.git'), parseGithubRemote('https://gitlab.com/acme/demo.git')], modes: [remoteMode({}), remoteMode({ STUDIO_VERIFY_REMOTE: 'GitHub' })], leak: JSON.stringify(out).includes(TOKEN) }));
`);
  const rr = run(dir, `node "${rp}"`);
  const rj = parse(rr);
  const O = rj.out || {};
  const del = (c) => (c?.calls || []).filter((x) => x.startsWith('delete'));
  const onlyOwn = Object.values(O).every((c) => del(c).every((x) => x === 'delete train/20261102-1'));
  report('2.69.0 (q, 2): remote verify with a fake client: green CI (after two pending polls) is used as the verify; red CI is a result (ok false); a push error, a repo error, CI still running at STUDIO_VERIFY_REMOTE_TIMEOUT_MIN, no check run within STUDIO_VERIFY_REMOTE_START_MIN, an existing train/<id>, a private repo (paid minutes), no token and STUDIO_VERIFY_REMOTE unset all fall back (used: false); only its own train/<id> is deleted and only after its own push; the token never appears in a result (fails on 2.68.0: harness/remote-verify.mjs does not exist)',
    rr.status === 0 && O.green?.r?.used === true && O.green.r.ok === true && O.green.calls.filter((x) => x === 'runs').length === 3 && JSON.stringify(del(O.green)) === '["delete train/20261102-1"]'
      && O.red?.r?.used === true && O.red.r.ok === false && /CI red: release-gate failure/.test(O.red.r.why) && del(O.red).length === 1
      && O.pushErr?.r?.used === false && /\*\*\*/.test(O.pushErr.r.why) && !del(O.pushErr).length && O.repoErr?.r?.used === false && !O.repoErr.calls.some((x) => /^push|^delete/.test(x))
      && O.timeout?.r?.used === false && /STUDIO_VERIFY_REMOTE_TIMEOUT_MIN/.test(O.timeout.r.why) && O.timeout.t >= 3600000 && del(O.timeout).length === 1
      && O.noStart?.r?.used === false && /STUDIO_VERIFY_REMOTE_START_MIN/.test(O.noStart.r.why) && O.noStart.t < 3600000 && del(O.noStart).length === 1
      && O.exists?.r?.used === false && !O.exists.calls.some((x) => /^push|^delete/.test(x)) && O.priv?.r?.used === false && /paid minutes/.test(O.priv.r.why) && !O.priv.calls.some((x) => /^push/.test(x))
      && O.off?.r?.why === 'off' && !O.off.calls.length && O.noToken?.r?.used === false && /GH_TOKEN/.test(O.noToken.r.why) && onlyOwn && rj.leak === false,
    out(rr).slice(-2500));
  report('2.69.0 (q, 2, review): only the NAMED check run counts (STUDIO_VERIFY_REMOTE_CHECK, default release-gate): a CI whose runs are all green but has no release-gate run falls back to the local verify as soon as its runs are done (not used, the pattern named); a skipped release-gate is not green; a custom pattern (^ci$) picks its own run; the safety gates kept local are every gate but the game checks, engine and heavy ones (fails on a3b7117: any green run passed, and there was no local part)',
    rr.status === 0 && O.noNamed?.r?.used === false && /no CI check run named \/release-gate\/i/.test(O.noNamed.r.why) && /STUDIO_VERIFY_REMOTE_CHECK/.test(O.noNamed.r.why) && O.noNamed.t < 600000 && del(O.noNamed).length === 1
      && O.skipped?.r?.used === true && O.skipped.r.ok === false && O.custom?.r?.used === true && O.custom.r.ok === true
      && JSON.stringify(rj.local) === '["protected","secrets","hooks","weakened-tests","golden","regressions"]',
    out(rr).slice(-2000));
  report('2.69.0 (q, 2): the real GitHub client (with a fake fetch, no network) refuses to delete any branch but train/<id> (main, train/../main, refs/heads/main, feature/x), deletes train/<id> with one DELETE /repos/o/r/git/refs/heads/train/<id> carrying the token as a Bearer header; github remotes parse (https, ssh), others don\'t (fails on 2.68.0: no such client)',
    rr.status === 0 && JSON.stringify(rj.refused) === '["main","train/../main","refs/heads/main","feature/x"]' && JSON.stringify(rj.seen) === '["DELETE /repos/o/r/git/refs/heads/train/20261102-1 auth=true"]'
      && JSON.stringify(rj.parse) === '[{"owner":"acme","repo":"demo"},{"owner":"acme","repo":"demo"},null]' && JSON.stringify(rj.modes) === '["off","github"]',
    out(rr).slice(-1500));

  // ---- 6. the train with a fake remote client: green CI lands with no local verify; an error falls back ----
  const tp = path.join(tmpRoot, `train-269q-${process.pid}.mjs`);
  fs.writeFileSync(tp, `import { runTrain } from ${href('harness/train.mjs')};
const mode = process.argv[2];
const calls = [];
const remoteClient = {
  async repo() { calls.push('repo'); return { private: false }; },
  async branchExists(b) { calls.push('exists ' + b); return false; },
  async push(sha, b) { calls.push('push ' + b); if (mode === 'error') throw new Error('network down'); },
  async checkRuns() { calls.push('runs'); return mode === 'noNamed' ? [{ name: 'lint', status: 'completed', conclusion: 'success' }] : [{ name: 'release-gate', status: 'completed', conclusion: 'success' }]; },
  async deleteBranch(b) { calls.push('delete ' + b); },
};
const logs = [];
const r = await runTrain({ by: 'tester', now: true, deps: { remoteClient }, log: (m) => logs.push(m) });
console.log(JSON.stringify({ id: r.id, landed: r.landed, dropped: (r.dropped || []).map((d) => d.task), verifies: r.verifies, calls, logs: logs.join('\\n').slice(-12000) }));
`);
  const Rg = [1, 2].map((k) => lane(`pq-g${k}`, `Docs: note g${k}`, { [`game/demo/notes/g${k}.md`]: `# g${k}\n` }));
  resetRan();
  const remoteEnv = { ...env, STUDIO_VERIFY_REMOTE: 'github', GH_TOKEN: 'tok-secret-269q' };
  const o6 = run(dir, `node "${tp}" green`, remoteEnv);
  const j6 = parse(o6);
  const verifyRan6 = ran().filter((r) => /^train-/.test(r.owner) && !/-re\d*$/.test(r.owner));
  let split6 = null;
  try { const d = path.join(dir, '.studio', 'train', 'split'); split6 = JSON.parse(fs.readFileSync(path.join(d, fs.readdirSync(d).find((f) => f.startsWith(String(j6.id)))), 'utf8')); } catch {}
  const Re = [1, 2].map((k) => lane(`pq-e${k}`, `Docs: note e${k}`, { [`game/demo/notes/e${k}.md`]: `# e${k}\n` }));
  resetRan();
  const o6b = run(dir, `node "${tp}" error`, remoteEnv);
  const j6b = parse(o6b);
  const verifyRan6b = ran().filter((r) => /^train-/.test(r.owner) && !/-re\d*$/.test(r.owner));
  report('2.69.0 (q, 2): a train with STUDIO_VERIFY_REMOTE=github and a fake client: green CI (the named release-gate run) on train/<id> stands for the game checks and the local safety gates (protected, secrets, hooks) ran on the same tree, recorded part by part in .studio/train/split/<id>-<n>.json (both lanes land, no local game check ran, the client pushed and then deleted exactly train/<id>); a push error falls back to the local verify (it ran, both lanes land, nothing deleted); the token is never printed (fails on 2.68.0: the train never asks a remote)',
    Rg.every((l) => l.ok) && Re.every((l) => l.ok) && o6.status === 0 && (j6.landed || []).length === 2 && !verifyRan6.length && j6.verifies === 0
      && JSON.stringify(j6.calls) === JSON.stringify(['repo', `exists train/${j6.id}`, `push train/${j6.id}`, 'runs', `delete train/${j6.id}`])
      && onMain('game/demo/notes/g1.md') && onMain('game/demo/notes/g2.md') && /local safety gates green \(protected, secrets, hooks\), the game's checks from the repo's CI/.test(j6.logs)
      && split6?.from?.game === 'remote CI: release-gate' && /^local/.test(split6?.from?.protected || '') && /^local/.test(split6?.from?.hooks || '') && split6?.tree
      && o6b.status === 0 && (j6b.landed || []).length === 2 && verifyRan6b.length >= 1 && !(j6b.calls || []).some((x) => /^delete/.test(x)) && /remote verify not used \(remote verify failed: network down\): the local verify runs/.test(j6b.logs)
      && onMain('game/demo/notes/e1.md') && !`${out(o6)}${out(o6b)}`.includes('tok-secret-269q'),
    `split=${JSON.stringify(split6?.from)}\n${(j6.logs || "").split("\n").filter((l) => /local safety/.test(l)).join("\n")}\nverifyRan=${verifyRan6.length}\n---\n${out(o6b).slice(-1500)}\nverifyRan=${verifyRan6b.length}`);

  // ---- 7-8 (review). a local safety-gate violation with a green remote is red; a CI lacking the named check falls back ----
  const V = [1, 2].map((k) => lane(`pq-v${k}`, `Docs: note v${k}`, { [`game/demo/notes/v${k}.md`]: k === 2 ? 'VIOLATES-PROTECTED\n' : `# v${k}\n` }));
  resetRan();
  const o7 = run(dir, `node "${tp}" green`, remoteEnv);
  const j7 = parse(o7);
  const firstPush = (j7.calls || []).indexOf((j7.calls || []).find((x) => /^push/.test(x)));
  report('2.69.0 (q, 2, review): with STUDIO_VERIFY_REMOTE=github and a GREEN remote, a lane that turns a local safety gate red (the protected gate) still makes the train red: the remote is not asked for that tree ("the local safety gates are red ... a remote result never stands for them"), the lane is handed back by the prefix search on that gate, the other lane lands (its own tree: safety gates local, game from the remote) (fails on a3b7117: the remote green stood for every gate and both lanes landed)',
    V.every((l) => l.ok) && o7.status === 0 && /remote verify not asked: the local safety gates are red on tree [0-9a-f]{8} \(failed: protected\); a remote result never stands for them/.test(j7.logs || '')
      && (j7.dropped || []).includes(V[1].id) && (j7.landed || []).join(',') === V[0].id && onMain('game/demo/notes/v1.md') && !onMain('game/demo/notes/v2.md') && firstPush >= 0 && (j7.calls || []).filter((x) => /^push/.test(x)).length === 1,
    `${out(o7).slice(-2500)}`);
  const N = [1, 2].map((k) => lane(`pq-n${k}`, `Docs: note n${k}`, { [`game/demo/notes/n${k}.md`]: `# n${k}\n` }));
  resetRan();
  const o8 = run(dir, `node "${tp}" noNamed`, remoteEnv);
  const j8 = parse(o8);
  const verifyRan8 = ran().filter((r) => /^train-/.test(r.owner) && !/-re\d*$/.test(r.owner));
  report('2.69.0 (q, 2, review): a train whose remote CI ran only other checks (no release-gate run) falls back to the full local verify (it ran the game checks; both lanes land; its own train/<id> deleted) (fails on a3b7117: any green run stood for the verify, no local run)',
    N.every((l) => l.ok) && o8.status === 0 && (j8.landed || []).length === 2 && verifyRan8.length >= 1 && /remote verify not used \(no CI check run named \/release-gate\/i/.test(j8.logs || '') && (j8.calls || []).includes(`delete train/${j8.id}`),
    `${out(o8).slice(-2000)}\nverifyRan=${verifyRan8.length}`);
  for (const p of [pure, laneProbe, rp, tp, ranLog]) { try { fs.rmSync(p, { force: true }); } catch {} }
}
