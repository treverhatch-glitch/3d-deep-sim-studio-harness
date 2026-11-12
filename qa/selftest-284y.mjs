/**
 * qa/selftest-284y.mjs — 2.84 (y): features nobody used are taken out, and what stays behaves as before.
 *
 * The overseer read twelve days of a live studio's event log: remote (cloud) workers and the remote verify, the weekly
 * harness scout and signed results never fired an event and their commands never ran. They are gone
 * (git history keeps them). These checks hold that: the modules are gone and nothing live still names them, the Line
 * Producer's plan for a studio with no remote settings is the plan it made before the cut, and a merge train lands an
 * ordinary local lane with one local verify, as before.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest284Y({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const guard = async (name, fn) => { try { const [ok, d] = await fn(); report(name, Boolean(ok), ok ? '' : String(d || '').slice(0, 3000)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 3000)); } };
  const write = (base, rel, text) => { fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true }); fs.writeFileSync(path.join(base, rel), text); };
  const href = (rel) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);
  const parse = (r) => { try { return JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { return {}; } };

  // ---- 1. the modules are gone, and nothing live names them ----
  const GONE = ['harness/remote-workers.mjs', 'harness/remote-verify.mjs', 'harness/harness-scout.mjs', 'harness/sign.mjs'];
  await guard('2.84 (y) cut: the removed modules (remote workers, remote verify, the harness scout, signed results) are not in the harness any more (fails before this cut: all four files were there)', () => {
    const left = GONE.filter((f) => fs.existsSync(path.join(dir, f)));
    return [left.length === 0, `still there: ${left.join(', ')}`];
  });
  await guard('2.84 (y) cut: no file under harness/, scripts/, qa/ (but the self-tests), studio/llms.txt or package.json names a removed module, its npm command (remote, sign) or its settings (the remote workers, the remote verify and the harness scout switch) (fails before this cut: the Line Producer, the train, the supervisor and package.json wired them in)', () => {
    const files = [];
    const walk = (rel) => {
      const abs = path.join(dir, rel);
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        const r = `${rel}/${e.name}`;
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(r); } else if (/\.(mjs|js|cjs|json|md|txt)$/.test(e.name)) files.push(r);
      }
    };
    walk('harness'); walk('scripts');
    for (const f of fs.readdirSync(path.join(dir, 'qa'))) if (/\.mjs$/.test(f) && !/^selftest/.test(f)) files.push(`qa/${f}`);
    files.push('studio/llms.txt');
    // The setting names are built from parts so the settings scanner does not count this file as a user of them.
    const S_ = 'STUDIO_';
    const RE = new RegExp(['remote-workers', 'remote-verify', 'harness-scout', '\\bsign\\.mjs', `${S_}REMOTE`, `${S_}VERIFY_REMOTE`, `${S_}HARNESS_SCOUT`, 'npm run (remote|sign)\\b'].join('|'));
    const hits = [];
    for (const f of files) {
      let text = '';
      try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
      text.split('\n').forEach((l, i) => { if (RE.test(l)) hits.push(`${f}:${i + 1}: ${l.trim().slice(0, 120)}`); });
    }
    const scripts = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts || {};
    const cmds = ['remote', 'sign'].filter((k) => k in scripts);
    const pkgHits = Object.entries(scripts).filter(([, v]) => RE.test(v)).map(([k]) => k);
    return [!hits.length && !cmds.length && !pkgHits.length, `${hits.slice(0, 20).join('\n')}\nscripts: ${cmds.join(', ')} ${pkgHits.join(', ')}`];
  });

  // ---- 2. the Line Producer's plan for a studio with no remote settings, as before the cut ----
  // The numbers were taken from the plan the commit before this cut made for the same board (gatherFacts then added
  // remote facts with the remote workers off; they never changed the crew or the picks).
  const lpProbe = path.join(tmpRoot, `lp-284y-${process.pid}.mjs`);
  fs.writeFileSync(lpProbe, `import * as lp from ${href('harness/line-producer.mjs')};
const tasks = [
  { id: 'T-901', title: 'Rules: score', role: 'builder', priority: 'P1', meta: {}, type: 'feature', state: 'ready' },
  { id: 'T-902', title: 'Rules: lives', role: 'builder', priority: 'P0', meta: {}, type: 'feature', state: 'ready' },
  { id: 'T-903', title: 'Rules: combo', role: 'builder', priority: 'P1', meta: { deps: ['T-901'] }, type: 'feature', state: 'blocked', block: { kind: 'chain', why: 'waits for T-901' } },
  { id: 'T-904', title: 'Rules: timer', role: 'builder', priority: 'P2', meta: {}, type: 'feature', state: 'running' },
  { id: 'T-905', title: 'Art: sprite', role: 'artist', priority: 'P1', meta: {}, type: 'art', state: 'ready' },
  { id: 'T-906', title: 'Rules: pause', role: 'builder', priority: 'P2', meta: {}, type: 'feature', state: 'ready' },
  { id: 'T-907', title: 'Rules: menu', role: 'builder', priority: 'P3', meta: {}, type: 'feature', state: 'ready' },
];
const f = { now: Date.parse('2026-11-10T10:00:00Z'), tasks, holds: {}, done: new Set(), sessions: [{ role: 'builder', task: 'T-904', running: true }], pace: { maxAgents: 4, perRole: { builder: 3 }, label: 'steady' }, rig: { known: false, why: 'no fresh machine scan: the pace decides' }, models: {}, share: 0.3, chainMin: 3, expansionMin: 2, sliceOpen: null, extraBlocked: [], dangling: [], inTrain: {}, fixed: [], lanes: { unscoped: [{ task: 'T-906' }] } };
const p = lp.linePlan(f);
const line = lp.summaryLine({ builders: p.builders, chainBreakers: p.chainBreakers, blocked: p.blocked });
console.log(JSON.stringify({ builders: p.builders, order: p.order, skip: p.skip, tiers: Object.fromEntries(Object.entries(p.routes).map(([k, v]) => [k, v.tier || null])), reasons: p.reasons.length, hasRemote: 'remote' in p, line }));
`);
  const lr = run(dir, `node "${lpProbe}"`);
  const L = parse(lr);
  await guard('2.84 (y) Line Producer: for a fixed board (3 builder slots by the pace, 1 running, 4 ready builder tasks of which one has no lane, one chained, one artist task) the plan is the plan before the cut: target 3, pace cap 3, no rig cap, picks T-902, T-901, T-905, T-907 in that order, T-906 skipped (no lane), every route the mid tier, one reason; and it carries no remote part', () => [
    lr.status === 0 && L.builders?.target === 3 && L.builders.paceCap === 3 && L.builders.rigCap === null && L.builders.running === 1 && L.builders.ready === 4
      && JSON.stringify(L.order) === '["T-902","T-901","T-905","T-907"]' && JSON.stringify(L.skip) === '["T-906"]'
      && Object.keys(L.tiers || {}).length === 6 && Object.values(L.tiers).every((t) => t === 'mid') && L.reasons === 1 && L.hasRemote === false && !/remote/i.test(L.line || ''),
    `${JSON.stringify(L)}\n${out(lr).slice(-1500)}`,
  ]);

  // ---- 3. a merge train lands an ordinary local lane with one local verify, as before ----
  // The studio and its made-up game are qa/selftest-269q.mjs's: a game check that logs each run to RAN_LOG.
  const ranLog = path.join(tmpRoot, `ran-284y-${process.pid}.log`);
  const events = path.join(dir, '.studio', 'events-284y.jsonl');
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { windowsHide: true, cwd, encoding: 'utf8' });
  const env = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', GITHUB_BASE_REF: '', STUDIO_GAME: 'demo', STUDIO_REACHABILITY: 'off', STUDIO_DONE_NOOP: 'allow', STUDIO_DONE_REUSE_VERIFY: '', STUDIO_TRAIN: '', STUDIO_TRAIN_BISECT: '', STUDIO_TRAIN_LAND_PREFIX: 'off', STUDIO_TRAIN_MAX: '', STUDIO_TRAIN_BATCH: 'off', STUDIO_TRAIN_PIPELINE: 'off', STUDIO_HOOKS_CHECK: 'on', STUDIO_LANE_LIVE_MIN: '0', STUDIO_HEAVY_SLOTS: '', STUDIO_TEST_WORKERS: '', STUDIO_MACHINE_SCAN: '', STUDIO_TEST_MACHINE: 'none', GH_TOKEN: '', GITHUB_TOKEN: '', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-284y-${process.pid}.pem`), AGENT_EVENTS_FILE: events, RAN_LOG: ranLog, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const evs = () => { try { return fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const ran = () => { try { return fs.readFileSync(ranLog, 'utf8').split('\n').filter(Boolean).map((l) => { const [owner, file] = l.split('\t'); return { owner, file }; }); } catch { return []; } };
  write(dir, 'studio/gates.json', `${JSON.stringify({ gates: [
    { id: 'secrets', command: 'node scripts/secret-scan.mjs', required: true, lite: true },
    { id: 'hooks', command: 'node harness/hook-stamp.mjs check', required: true, lite: true, cache: false },
    { id: 'game', command: 'node harness/game-gates.mjs', required: true, lite: true, cache: false },
  ] }, null, 2)}\n`);
  write(dir, 'game/demo/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'unit', command: 'node game/demo/run-tests.mjs', focus: 'node game/demo/run-tests.mjs {files}' }] }, null, 2)}\n`);
  write(dir, 'game/demo/run-tests.mjs', [
    "import fs from 'node:fs';",
    "const files = process.argv.slice(2); const d = 'game/demo/tests';",
    "const list = files.length ? files : fs.readdirSync(d).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => `${d}/${f}`);",
    "for (const f of list) { if (process.env.RAN_LOG) fs.appendFileSync(process.env.RAN_LOG, `${process.env.STUDIO_LOCK_OWNER || '-'}\\t${f}\\n`); console.log(` \\u2713 ${f} (1 test)`); }",
    'console.log(`Test Files  ${list.length} passed (${list.length})`);', ''].join('\n'));
  write(dir, 'game/demo/tests/a.test.mjs', '// a\n');
  write(dir, 'game/demo/notes/readme.md', '# Notes\n');
  g(dir, 'init', '-q', '-b', 'main'); g(dir, 'config', 'core.autocrlf', 'false');
  g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'studio', '--no-verify');
  g(dir, 'config', 'core.hooksPath', 'scripts/hooks');
  const id = (out(run(dir, 'node harness/task.mjs add "Docs: note y1" --role builder --priority P1', env)).match(/"id": "(T-\d+)"/) || [])[1];
  const laneProbe = path.join(tmpRoot, `lane-284y-${process.pid}.mjs`);
  fs.writeFileSync(laneProbe, `import { createLaneCopy } from ${href('harness/worktree.mjs')};\nconsole.log(JSON.stringify(createLaneCopy(process.argv[2], { task: process.argv[3] })));\n`);
  const agent = 'py-y1';
  run(dir, `node "${laneProbe}" ${agent} ${id}`, env);
  const ld = path.join(dir, '.lanes', agent);
  const as = { ...env, STUDIO_MAIN_ROOT: dir, STUDIO_LOCK_OWNER: agent };
  const st = run(ld, `node harness/task.mjs start ${id} --agent ${agent}`, as);
  write(ld, 'game/demo/notes/y1.md', '# y1\n');
  g(ld, 'add', '-A');
  const c = spawnSync('git', ['commit', '-q', '-m', `${id}: Docs: note y1`], { windowsHide: true, cwd: ld, encoding: 'utf8', env: { ...process.env, ...as } });
  const q = run(ld, `node harness/task.mjs done ${id} --agent ${agent} --train`, as);
  try { fs.rmSync(ranLog, { force: true }); } catch {}
  const tp = path.join(tmpRoot, `train-284y-${process.pid}.mjs`);
  fs.writeFileSync(tp, `import { runTrain } from ${href('harness/train.mjs')};
const logs = [];
const r = await runTrain({ by: 'tester', now: true, log: (m) => logs.push(m) });
console.log(JSON.stringify({ id: r.id, landed: r.landed, dropped: (r.dropped || []).map((d) => d.task), verifies: r.verifies, logs: logs.join('\\n').slice(-8000) }));
`);
  const before = evs().length;
  const t = run(dir, `node "${tp}"`, env);
  const j = parse(t);
  const trainRuns = ran().filter((r) => /^train-/.test(r.owner));
  const ev = evs().slice(before);
  await guard('2.84 (y) train: one ordinary local lane lands as before the cut: the train runs ONE local verify (the game check ran in the train\'s copy), the lane lands on main, nothing is handed back, and no remote step is logged or recorded (no remote_verify event, no .studio/train/split record) (the same on the commit before this cut, with no remote setting)', () => [
    st.status === 0 && c.status === 0 && t.status === 0 && JSON.stringify(j.landed || []) === JSON.stringify([id]) && !(j.dropped || []).length && j.verifies === 1 && trainRuns.length >= 1
      && g(dir, 'cat-file', '-e', 'main:game/demo/notes/y1.md').status === 0 && !ev.some((e) => /remote/.test(e.type || '')) && !/remote/i.test(j.logs || '')
      && !fs.existsSync(path.join(dir, '.studio', 'train', 'split')),
    `start=${st.status} commit=${c.status} train=${t.status} j=${JSON.stringify({ ...j, logs: undefined })} runs=${JSON.stringify(trainRuns)}\n${(j.logs || '').slice(-2000)}\n${out(q).slice(-800)}\n${out(t).slice(-1500)}`,
  ]);
  for (const p of [lpProbe, laneProbe, tp, ranLog]) { try { fs.rmSync(p, { force: true }); } catch {} }
}
