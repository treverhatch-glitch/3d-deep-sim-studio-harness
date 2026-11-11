/**
 * qa/selftest-284j.mjs — 2.84 (j): the drift check judges a session on the files THAT SESSION changed.
 *
 * The overseer's report: drift.check flagged two builders for "137 files outside scope" that were the overseer's own
 * uncommitted patches in the main checkout. The check listed `git status` of the folder it was given: for a session
 * first observed in the main checkout (before its lane copy exists) that is main's dirty files, and for a lane copy
 * any file that matches main's dirty ones. harness/drift-baseline.mjs now leaves out what the session did not touch.
 * Each check fails before the fix (the out-of-scope Check counts main's files).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest284J({ dir, report, tmpRoot }) {
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3000)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 3000)); } };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd, encoding: 'utf8' });
  const write = (b, rel, text) => { fs.mkdirSync(path.dirname(path.join(b, rel)), { recursive: true }); fs.writeFileSync(path.join(b, rel), text); };
  const T = path.join(tmpRoot, `s284j-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  fs.mkdirSync(path.join(dir, '.studio'), { recursive: true });
  const evFile = path.join(dir, '.studio', 'events-284j.jsonl');
  fs.writeFileSync(evFile, '');
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);
  let pn = 0;
  // One driftCheck call in a folder, in its own process (the harness's state paths come from the studio copy).
  const check = (agent, cwd) => {
    const f = path.join(dir, `.probe-284j-${++pn}.mjs`);
    fs.writeFileSync(f, `import { driftCheck } from ${u('harness/stall.mjs')};
const s = { agent: ${JSON.stringify(agent)}, role: 'builder', task: 'T-1', lane: 'game/x/src', startedAt: '2026-11-01T10:00:00.000Z' };
const t0 = Date.now();
const r = driftCheck(s, { cwd: ${JSON.stringify(cwd)}, now: Date.parse('2026-11-01T12:00:00Z'), events: [], locks: [] });
console.log(JSON.stringify({ ms: Date.now() - t0, raised: r.map((x) => ({ signal: x.signal, why: x.why, files: x.detail?.files || [] })) }));`);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: dir, encoding: 'utf8', timeout: 120000, env: { ...process.env, AGENT_EVENTS_FILE: evFile, STUDIO_DRIFT: '', STUDIO_DRIFT_ADVISOR: '' } });
    try { fs.rmSync(f, { force: true }); } catch { /* swept later */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { const j = JSON.parse(l); return { ...j, oos: j.raised.find((x) => x.signal === 'out-of-scope') || null }; } catch { return { raised: [], oos: null, _raw: `${r.stdout}${r.stderr}`.slice(-1500) }; }
  };
  // A main checkout: an in-scope file, and N tracked files outside the scope that the overseer has edited and not committed.
  let mn = 0;
  const mainRepo = (n, { untracked = 0 } = {}) => {
    const M = path.join(T, `main-${++mn}`);
    write(M, 'game/x/src/a.js', 'export const a = 1;\n');
    write(M, '.gitignore', 'x\n');
    for (let i = 0; i < n; i++) write(M, `harness/p${i}.mjs`, `export const p = ${i};\n`);
    g(M, 'init', '-q', '-b', 'main'); g(M, 'add', '-A'); g(M, 'commit', '-qm', 'start');
    write(M, '.gitignore', 'x\ny\n');
    for (let i = 0; i < n; i++) write(M, `harness/p${i}.mjs`, `export const p = ${i}; // overseer patch\n`);
    for (let i = 0; i < untracked; i++) write(M, `junk/j${i}.txt`, `${i}\n`);
    return M;
  };
  const count = (r) => (/edited (\d+) file/.exec(r.oos?.why || '') || [])[1] ? Number(/edited (\d+) file/.exec(r.oos.why)[1]) : 0;
  // A lane copy of M: a worktree of the same repo; `copied` = the overseer's dirty files that reached it, content and all.
  let ln = 0;
  const laneOf = (M, { copied = true, record = false, agent } = {}) => {
    const L = path.join(T, `lane-${++ln}`);
    g(M, 'worktree', 'add', '-q', '-b', `lane/${agent}`, L, 'HEAD');
    if (copied) {
      for (const f of ['.gitignore', ...fs.readdirSync(path.join(M, 'harness')).map((x) => `harness/${x}`)]) fs.copyFileSync(path.join(M, f), path.join(L, f));
    }
    return L;
  };

  await guard('fails before this fix: a session in the main checkout that changed ONE in-scope file is not charged with main\'s 5 dirty files, and no out-of-scope Check is raised', () => {
    const M = mainRepo(5);
    const first = check('a-main', M);             // first observation: the record is made here
    write(M, 'game/x/src/a.js', 'export const a = 2;\n');
    const second = check('a-main', M);
    return [!first.oos && !second.oos, JSON.stringify({ first, second })];
  });

  await guard('fails before this fix: a session that really edits 6 files outside its scope is still flagged, with a count of 6 (not 6 plus main\'s 10)', () => {
    const M = mainRepo(10);
    const first = check('b-main', M);
    for (let i = 0; i < 6; i++) write(M, `docs/n${i}.md`, `note ${i}\n`);
    const second = check('b-main', M);
    return [!first.oos && second.oos && count(second) === 6, JSON.stringify({ first, second })];
  });

  await guard('fails before this fix: a file that was already dirty in main and that the session then edits further DOES count (1, not main\'s 4)', () => {
    const M = mainRepo(4);
    check('c-main', M);
    write(M, 'harness/p2.mjs', 'export const p = 2; // overseer patch\nexport const mine = true;\n');
    const second = check('c-main', M);
    return [second.oos && count(second) === 1 && second.oos.files.includes('harness/p2.mjs'), JSON.stringify(second)];
  });

  await guard('fails before this fix: a lane made before 2.84 (no record) that holds copies of main\'s dirty files and one in-scope change by the session raises nothing', () => {
    const M = mainRepo(5);
    const L = laneOf(M, { agent: 'd-lane' });
    write(L, 'game/x/src/a.js', 'export const a = 3;\n');
    const r = check('d-lane', L);
    return [!r.oos, JSON.stringify(r)];
  });

  await guard('a lane made before 2.84: 6 real out-of-scope edits count 6, and a copied file the session changed further counts too (7)', () => {
    const M = mainRepo(5);
    const L = laneOf(M, { agent: 'e-lane' });
    for (let i = 0; i < 6; i++) write(L, `docs/n${i}.md`, `note ${i}\n`);
    write(L, 'harness/p1.mjs', 'export const p = 1; // overseer patch\nexport const mine = true;\n');
    const r = check('e-lane', L);
    return [r.oos && count(r) === 7, JSON.stringify(r)];
  });

  await guard('a lane made with a record (2.84): main\'s dirty files in the lane are not the session\'s; a record path the session edited further and 6 new files count (7)', async () => {
    const { writeLaneBaseline } = await import(pathToFileURL(path.join(dir, 'harness', 'drift-baseline.mjs')).href);
    const M = mainRepo(5);
    const L = laneOf(M, { agent: 'f-lane' });
    const n = writeLaneBaseline('f-lane', M);
    write(L, 'game/x/src/a.js', 'export const a = 4;\n');
    const quiet = check('f-lane', L);
    // The record also covers a case the content comparison cannot: main's file changed since the lane was made.
    write(M, 'harness/p0.mjs', 'export const p = 0; // overseer patched again\n');
    for (let i = 0; i < 6; i++) write(L, `docs/n${i}.md`, `note ${i}\n`);
    write(L, 'harness/p3.mjs', 'export const p = 3; // overseer patch\nexport const mine = true;\n');
    const loud = check('f-lane', L);
    return [n >= 6 && !quiet.oos && loud.oos && count(loud) === 7, JSON.stringify({ n, quiet, loud })];
  });

  await guard('bounded: with 2,000 dirty paths in main the check finishes in a couple of seconds, raises nothing for an in-scope edit, and counts only the session\'s 3 new files', () => {
    const M = mainRepo(5, { untracked: 2000 });
    const t0 = Date.now();
    const first = check('g-main', M);
    write(M, 'game/x/src/a.js', 'export const a = 5;\n');
    for (let i = 0; i < 3; i++) write(M, `docs/n${i}.md`, `note ${i}\n`);
    const second = check('g-main', M);
    const wall = Date.now() - t0;
    return [!first.oos && second.oos && count(second) === 3 && first.ms < 3000 && second.ms < 3000, JSON.stringify({ wall, first: { ms: first.ms, oos: first.oos }, second: { ms: second.ms, why: second.oos?.why } })];
  });
}
