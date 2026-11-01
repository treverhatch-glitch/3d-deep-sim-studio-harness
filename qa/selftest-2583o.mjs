/**
 * qa/selftest-2583o.mjs — 2.58.3 (helper o): what `task done` asks for, from the crew's logs (harness 2.56.0, Windows).
 *   O1 (crew P-041): "Fix: bug batch N … see <file>.md" is a code fix, not docs: a .md only makes a fix a docs task when
 *       it is in the title's subject ("Fix: typo in docs/X.md"), not a "see <file>.md" reference.
 *   O2 (crew P-034): the size ratchet matches an anonymous function (a long test body) across versions by a stable key,
 *       so lines inserted above it don't make it "new"; growing it is still caught (with "was"); every item is listed.
 *   O3 (crew P-035): a tracked file whose only difference is line endings doesn't block task done, the verify record's
 *       clean tree, the lane copy's landing, or onboard --sync; a one-character change still does.
 *   O4: files someone else left in the game folders on the main checkout don't refuse a task that isn't code work,
 *       claimed no paths and committed no game code (a note and an event for the Producer instead).
 *   O5: "no full verify after your last change" says what is stale: main moved, another name ran it, or your files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest2583O({ dir, run, report, tmpRoot }) {
  const u = (p, base = dir) => JSON.stringify(pathToFileURL(path.join(base, p)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const gIn = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8' });
  const g = (...a) => gIn(dir, ...a);
  const head = () => g('rev-parse', 'HEAD').stdout.trim();
  const write = (rel, text, base = dir) => { fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true }); fs.writeFileSync(path.join(base, rel), text); };
  const env = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_DONE_GAME_GATES: 'skip', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', GITHUB_BASE_REF: '', STUDIO_GAME: 'pier', STUDIO_REACHABILITY: 'off', AGENT_EVENTS_FILE: path.join(dir, '.studio', 'events.jsonl') };
  const as = (agent, extra = {}) => ({ ...env, STUDIO_LOCK_OWNER: agent, ...extra });
  const add = (title, role = 'builder') => (out(run(dir, `node harness/task.mjs add "${title}" --role ${role} --priority P1`, env)).match(/"id": "(T-\d+)"/) || [])[1];
  const start = (id, agent) => run(dir, `node harness/task.mjs start ${id} --agent ${agent}`, as(agent));
  const done = (id, agent, extra = {}) => run(dir, `node harness/task.mjs done ${id} --agent ${agent}`, as(agent, extra));
  const verify = (agent) => run(dir, 'node scripts/run-gates.mjs', as(agent));
  // Only the named files (git commit -- <paths>): a file someone else left staged stays staged, as on the crew's checkout.
  const commit = (msg, ...files) => { g('add', '--', ...files); return g('commit', '-qm', msg, '--no-verify', '--', ...files); };
  const commitTask = (id, msg, ...files) => commit(`${msg}\n\nStudio-Task: ${id}`, ...files);
  const probe = (name, code, penv = env, cwd = dir) => {
    // Written outside the checkout, so it never shows up as an untracked file there.
    const f = path.join(tmpRoot, `probe-2583o-${name}-${process.pid}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(cwd, `node "${f}"`, penv);
    fs.rmSync(f, { force: true });
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return { ...JSON.parse(line), _out: out(r) }; } catch { return { _out: out(r).slice(-1500) }; }
  };
  const events = () => { try { return fs.readFileSync(path.join(dir, '.studio', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

  // The studio: a quick real verify (the two checks task done also runs) and a game folder (game/pier).
  write('studio/gates.json', `${JSON.stringify({ gates: [{ id: 'protected', command: 'node qa/protected-check.mjs', required: true, lite: true }, { id: 'secrets', command: 'node scripts/secret-scan.mjs', required: true, lite: true }] }, null, 2)}\n`);
  write('game/pier/src/snap.txt', 'line one\nline two\nline three\n');
  write('game/pier/src/dock.gd', 'var dock = 1\n');
  g('init', '-q', '-b', 'main'); g('config', 'core.autocrlf', 'false');
  g('add', '-A'); g('commit', '-qm', 'studio', '--no-verify');

  // ---- O1: typing ----
  const ty = probe('types', `import { taskType } from ${u('harness/done-check.mjs')};
const t = (title) => taskType({ title, role: 'builder' });
const code = ['Fix: bug batch 3 … see qa/reports/kept/known-bugs-2026-10-18-triage.md', 'Fix: bug batch 1 — 6 HUD bugs, see qa/reports/kept/known-bugs-2026-10-18-triage.md', 'Fix: bug batch 2 (see qa/reports/kept/known-bugs-2026-10-18-triage.md)', 'Fix: bug batch 4 per qa/reports/kept/known-bugs-2026-10-18-triage.md', 'Bug: the fee panel rounds wrong; ref docs/FEES.md'];
const docs = ['Fix: typo in docs/X.md', 'Fix typo in README.md', 'Fix docs gate', 'Fix the docs-gate on Windows', 'Bug: check-docs fails on CRLF', 'Fix: broken link in studio/skills/bug.md - two places'];
console.log(JSON.stringify({ code: code.map((x) => [x, t(x)]).filter(([, y]) => y !== 'bug'), docs: docs.map((x) => [x, t(x)]).filter(([, y]) => y !== 'docs'), chore: t('Fix the build'), bug: t('Fix a bug in the fee panel'), plainDocs: t('Docs: the quickstart') }));`);
  report('2.58.3 (O1, crew P-041): "Fix: bug batch N … see <file>.md" (and "(see …)", "— …, see …", "per …", "; ref …") types as a bug, not docs; "Fix: typo in docs/X.md", "Fix docs gate", "check-docs" stay docs; chores and plain bugs unchanged',
    Array.isArray(ty.code) && !ty.code.length && Array.isArray(ty.docs) && !ty.docs.length && ty.chore === 'chore' && ty.bug === 'bug' && ty.plainDocs === 'docs', JSON.stringify(ty).slice(0, 1500));

  // ---- O2: anonymous functions in the size ratchet ----
  const body = (n, tag = 'x') => Array.from({ length: n }, (_, i) => `    expect(${tag}${i}).toBe(${i});`).join('\n');
  const testFile = (pre, charges, refunds = 5) => `import { it, describe, expect } from 'vitest';\n${pre}describe('fees', () => {\n  it('charges', () => {\n${body(charges)}\n  });\n  it('refunds', () => {\n${body(refunds, 'y')}\n  });\n});\n`;
  // The describe body is anonymous too (75 lines) and the 'charges' test body 66: both over a limit of 60.
  write('game/pier/src/fees.test.ts', testFile('', 64));
  commit('fees test', 'game/pier/src/fees.test.ts');
  const t2 = add('Add a harbour toll test');
  start(t2, 'sz-1');
  write('game/pier/src/fees.test.ts', testFile(`const harbour = 1;\nconst toll = 2;\nconst dues = 3;\n// three lines above\n`, 64));
  commitTask(t2, 'lines above', 'game/pier/src/fees.test.ts');
  const szEnv = { ...env, STUDIO_FN_MAX_LINES: '60', STUDIO_FILE_MAX_LINES: '9999', STUDIO_FILE_MAX_KB: '9999' };
  const sz = (name) => probe(name, `import { sizeGrowth } from ${u('harness/done-check.mjs')};
console.log(JSON.stringify({ grew: sizeGrowth('${t2}', ['game/pier/src/fees.test.ts']) }));`, szEnv);
  const shifted = sz('shift');
  report('2.58.3 (O2, crew P-034): lines inserted above an unchanged long anonymous test body don\'t make it look new to the size ratchet',
    Array.isArray(shifted.grew) && shifted.grew.length === 0, JSON.stringify(shifted).slice(0, 1500));
  write('game/pier/src/fees.test.ts', testFile(`const harbour = 1;\nconst toll = 2;\nconst dues = 3;\n// three lines above\n`, 70));
  commitTask(t2, 'charges grows', 'game/pier/src/fees.test.ts');
  const grown = sz('grow');
  report('2.58.3 (O2): growing that anonymous test body is still caught, named by its test title and with its old size ("was 66"; the describe around it grew too, also with "was")',
    Array.isArray(grown.grew) && grown.grew.some((x) => /fees\.test\.ts \(anonymous, line \d+: describe\("fees"\) > it\("charges"\)\) is 72 lines \(was 66\), over the limit of 60/.test(x)) && grown.grew.every((x) => /\(was \d+\)/.test(x)), JSON.stringify(grown).slice(0, 1500));
  g('reset', '-q', '--hard', 'HEAD~1');

  // Every item in the message (GDScript: four functions grown past a limit of 5), and past 10 the first 10 + where the rest are.
  const gd = (n, grow) => Array.from({ length: n }, (_, k) => `func f${k}():\n${Array.from({ length: grow }, (_, i) => `\tvar v${i} = ${i}`).join('\n')}\n`).join('\n');
  write('game/pier/src/many.gd', gd(4, 3));
  commit('many', 'game/pier/src/many.gd');
  const t3 = add('Grow many functions');
  start(t3, 'sz-2');
  write('game/pier/src/many.gd', gd(4, 8));
  commitTask(t3, 'grow', 'game/pier/src/many.gd');
  const dc = run(dir, `node harness/done-check.mjs ${t3}`, as('sz-2', { STUDIO_FN_MAX_LINES: '5' }));
  const list = probe('list', `import { sizeList } from ${u('harness/done-check.mjs')};
const items = Array.from({ length: 12 }, (_, i) => 'game/x.gd f' + i + '() is 90 lines, over the limit of 80');
console.log(JSON.stringify({ s: sizeList('T-777', items) }));`);
  const listFile = path.join(dir, '.studio', 'size-growth', 'T-777.txt');
  report('2.58.3 (O2): the size message lists every grown function (4 here, not the first 3); past 10 it shows 10, "and 2 more" and the file with the full list',
    dc.status !== 0 && [0, 1, 2, 3].every((k) => out(dc).includes(`many.gd f${k}() is 9 lines`)) && /4 items: /.test(out(dc))
      && /12 items: .*f9\(\).*; and 2 more \(the full list: \.studio\/size-growth\/T-777\.txt\)/.test(list.s || '') && !/f10\(\)/.test(list.s || '') && fs.existsSync(listFile) && fs.readFileSync(listFile, 'utf8').trim().split('\n').length === 12,
    `${out(dc).slice(-1500)}\n---\n${JSON.stringify(list).slice(0, 800)}`);
  run(dir, `node harness/task.mjs done ${t3} --agent sz-2 --force --reason "selftest"`, as('sz-2'));
  run(dir, `node harness/task.mjs done ${t2} --agent sz-1 --force --reason "selftest"`, as('sz-1'));

  // ---- O3: line endings only ----
  const eol = probe('eol', `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { splitEolOnly } from ${u('harness/eol-only.mjs')};
const root = process.argv[2] || '.';
const gg = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8' });
const res = {};
for (const [name, autocrlf, attrs] of [['plain', 'false', ''], ['autocrlf', 'true', ''], ['textauto', 'false', '* text=auto\\n']]) {
  const d = ${JSON.stringify(path.join(tmpRoot, 'eol-2583o-'))} + name + '-' + process.pid;
  fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true });
  gg(d, 'init', '-q'); gg(d, 'config', 'core.autocrlf', 'false');
  if (attrs) fs.writeFileSync(d + '/.gitattributes', attrs);
  fs.writeFileSync(d + '/lf.snap', 'a\\nb\\nc\\n');          // committed with LF
  fs.writeFileSync(d + '/crlf.snap', 'a\\r\\nb\\r\\nc\\r\\n');  // committed with CRLF
  fs.writeFileSync(d + '/real.txt', 'one\\ntwo\\n');
  fs.writeFileSync(d + '/gone.txt', 'x\\n');
  gg(d, 'add', '-A'); gg(d, 'commit', '-qm', 'i');
  gg(d, 'config', 'core.autocrlf', autocrlf);
  fs.writeFileSync(d + '/lf.snap', 'a\\r\\nb\\r\\nc\\r\\n');    // CRLF rewrite of an LF file
  fs.writeFileSync(d + '/crlf.snap', 'a\\nb\\nc\\n');          // LF rewrite of a CRLF file (what a Windows checkout with autocrlf sees)
  fs.writeFileSync(d + '/real.txt', 'one\\ntwO\\n');           // one character
  fs.rmSync(d + '/gone.txt');
  fs.writeFileSync(d + '/new.txt', 'n\\n');
  const lines = gg(d, 'status', '--porcelain').stdout.split('\\n').filter((l) => l.length > 3);
  const s = splitEolOnly(d, lines);
  gg(d, 'add', 'lf.snap');
  const staged = splitEolOnly(d, gg(d, 'status', '--porcelain', '--', 'lf.snap').stdout.split('\\n').filter((l) => l.length > 3));
  res[name] = { listed: lines.map((l) => l.slice(3)), eol: s.eol, real: s.real.map((l) => l.slice(3)), staged };
}
console.log(JSON.stringify(res));`);
  const eolOk = (r) => r && r.real.includes('real.txt') && r.real.includes('gone.txt') && r.real.includes('new.txt') && r.listed.filter((f) => f.endsWith('.snap')).every((f) => r.eol.includes(f)) && r.eol.length >= 1 && !r.eol.some((f) => !f.endsWith('.snap')) && (!r.staged.real.length);
  report('2.58.3 (O3, crew P-035): a CRLF-only rewrite of a committed LF file (and an LF rewrite of a CRLF one, also with core.autocrlf=true; staged or not) counts as line endings only (and with \`* text=auto\`, where git status says M and the diff is empty); a one-character change, a deletion and a new file never do',
    eolOk(eol.plain) && eolOk(eol.autocrlf) && eolOk(eol.textauto) && eol.plain.eol.length === 2, JSON.stringify(eol).slice(0, 1500));

  // task done on the main checkout: a claimed folder holding a CRLF-only file, after a real verify.
  const t4 = add('Wire the dock bell');
  start(t4, 'eol-1');
  run(dir, 'node harness/lock.mjs claim path:game/pier --owner eol-1', env);
  write('game/pier/src/dock.gd', 'var dock = 1\nvar bell = 2\n');
  commitTask(t4, 'bell', 'game/pier/src/dock.gd');
  write('game/pier/src/snap.txt', 'line one\r\nline two\r\nline three\r\n');
  const v4 = verify('eol-1');
  const rec4 = JSON.parse(fs.readFileSync(path.join(dir, '.studio/gates/eol-1-full.json'), 'utf8'));
  const d4 = done(t4, 'eol-1');
  report('2.58.3 (O3): with a CRLF-only snapshot in the claimed game folder, verify records a clean tree and task done closes, naming the file in a note ("line endings only, ignored")',
    v4.status === 0 && rec4.dirty === false && d4.status === 0 && /"status": "done"/.test(out(d4)) && /in line endings only, ignored \(game\/pier\/src\/snap\.txt\)/.test(out(d4)) && events().some((e) => e.type === 'task.eol_ignored' && e.task === t4),
    `${JSON.stringify({ dirty: rec4.dirty })}\n${out(v4).slice(-400)}\n---\n${out(d4).slice(-1500)}`);
  g('checkout', '-q', '--', 'game/pier/src/snap.txt');
  run(dir, 'node harness/lock.mjs release path:game/pier --owner eol-1', env);

  const t5 = add('Wire the dock horn');
  start(t5, 'eol-2');
  run(dir, 'node harness/lock.mjs claim path:game/pier --owner eol-2', env);
  write('game/pier/src/dock.gd', 'var dock = 1\nvar bell = 2\nvar horn = 3\n');
  commitTask(t5, 'horn', 'game/pier/src/dock.gd');
  verify('eol-2');
  write('game/pier/src/snap.txt', 'line one\nline tw0\nline three\n');
  const d5 = run(dir, `node harness/task.mjs done ${t5} --agent eol-2 --check`, as('eol-2'));
  report('2.58.3 (O3): a one-character change in the same file still refuses task done (uncommitted)',
    d5.status !== 0 && /aren't committed yet[\s\S]*game\/pier\/src\/snap\.txt/.test(out(d5)), out(d5).slice(-1200));
  g('checkout', '-q', '--', 'game/pier/src/snap.txt');
  run(dir, `node harness/task.mjs done ${t5} --agent eol-2 --force --reason "selftest"`, as('eol-2'));
  run(dir, 'node harness/lock.mjs release path:game/pier --owner eol-2', env);

  // The lane copy's landing ("Commit your work first").
  {
    const repo = path.join(tmpRoot, `lane-2583o-${process.pid}`);
    fs.mkdirSync(repo, { recursive: true });
    for (const d of ['harness', 'scripts', 'studio', 'qa']) fs.cpSync(path.join(dir, d), path.join(repo, d), { recursive: true });
    fs.cpSync(path.join(dir, 'package.json'), path.join(repo, 'package.json'));
    if (fs.existsSync(path.join(dir, 'node_modules'))) fs.symlinkSync(fs.realpathSync(path.join(dir, 'node_modules')), path.join(repo, 'node_modules'), 'junction');
    write('game/q/snap.txt', 'a\nb\n', repo);
    write('game/q/w.gd', 'var w = 1\n', repo);
    write('.gitignore', '.lanes/\n.studio/\nnode_modules\n', repo);
    gIn(repo, 'init', '-q', '-b', 'main'); gIn(repo, 'config', 'core.autocrlf', 'false'); gIn(repo, 'add', '-A'); gIn(repo, 'commit', '-qm', 'init', '--no-verify');
    const lane = path.join(repo, '.lanes', 'lane-a');
    gIn(repo, 'worktree', 'add', '-q', '-b', 'lane/lane-a', lane, 'main');
    write('game/q/w.gd', 'var w = 2\n', lane);
    gIn(lane, 'commit', '-qam', 'T-1 w', '--no-verify');
    write('game/q/snap.txt', 'a\r\nb\r\n', lane);
    const lenv = { ...env, STUDIO_MAIN_ROOT: repo, STUDIO_LOCK_OWNER: 'lane-a', STUDIO_GAME: '' };
    const dl = probe('deliver', `import { deliver } from ${u('harness/worktree.mjs', lane)}; console.log(JSON.stringify(deliver('T-1', { runChecks: false })));`, lenv, lane);
    const landed = fs.readFileSync(path.join(repo, 'game/q/w.gd'), 'utf8');
    write('game/q/w.gd', 'var w = 3\n', lane);
    const dl2 = probe('deliver2', `import { deliver } from ${u('harness/worktree.mjs', lane)}; console.log(JSON.stringify(deliver('T-2', { runChecks: false })));`, lenv, lane);
    report('2.58.3 (O3): in a lane copy a CRLF-only file doesn\'t stop the landing ("Commit your work first"); it is set aside in a named stash and the lane lands; a real uncommitted change still stops it',
      dl.ok === true && /w = 2/.test(landed) && dl2.ok === false && /Commit your work first: 1 uncommitted file\(s\) in your copy \(game\/q\/w\.gd\)/.test(dl2.message || ''), JSON.stringify({ dl, dl2 }).slice(0, 1500));
  }

  // onboard --sync: a line-ending-only file in the adopted game doesn't refuse the sync.
  {
    const studio = path.join(tmpRoot, `sync-2583o-${process.pid}`);
    fs.cpSync(dir, studio, { recursive: true, filter: (s) => !/[\\/](node_modules|\.git|\.studio)([\\/]|$)/.test(s.slice(dir.length)) });
    if (fs.existsSync(path.join(dir, 'node_modules'))) fs.symlinkSync(fs.realpathSync(path.join(dir, 'node_modules')), path.join(studio, 'node_modules'), 'junction');
    const src = path.join(tmpRoot, `sync-src-2583o-${process.pid}`);
    write('package.json', JSON.stringify({ name: 'quay', scripts: { test: 'vitest run' } }, null, 2), src);
    write('src/boats.ts', 'export const boats = 1;\n', src);
    write('src/__snapshots__/boats.test.ts.snap', 'exports[`boats 1`] = `1`;\n', src);
    gIn(src, 'init', '-q', '-b', 'main'); gIn(src, 'config', 'core.autocrlf', 'false'); gIn(src, 'add', '-A'); gIn(src, 'commit', '-qm', 'start');
    gIn(studio, 'init', '-q', '-b', 'main'); gIn(studio, 'config', 'core.autocrlf', 'false'); gIn(studio, 'add', '-A'); gIn(studio, 'commit', '-qm', 'studio', '--no-verify');
    const senv = { ...env, STUDIO_GAME: '', AGENT_EVENTS_FILE: path.join(studio, '.studio', 'events-sync.jsonl') };
    const adopt = run(studio, `node scripts/onboard-game.mjs --path "${src}" --name Quay --adopt`, senv);
    gIn(studio, 'add', '-A'); gIn(studio, 'commit', '-qm', 'adopt', '--no-verify');
    const snapRel = 'game/quay/src/__snapshots__/boats.test.ts.snap';
    write('src/boats.ts', 'export const boats = 4;\n', src);
    gIn(src, 'commit', '-qam', 'upstream work');
    fs.writeFileSync(path.join(studio, snapRel), 'exports[`boats 1`] = `1`;\r\n');
    const syncEol = run(studio, 'node scripts/onboard-game.mjs --sync', senv);
    const snapAfter = gIn(studio, 'show', `HEAD:${snapRel}`).stdout;
    const boatsAfter = fs.readFileSync(path.join(studio, 'game/quay/src/boats.ts'), 'utf8');
    write('src/boats.ts', 'export const boats = 5;\n', src);
    gIn(src, 'commit', '-qam', 'more upstream work');
    fs.writeFileSync(path.join(studio, 'game/quay/src/boats.ts'), 'export const boats = 44;\n');
    const syncReal = run(studio, 'node scripts/onboard-game.mjs --sync', senv);
    report('2.58.3 (O3): onboard --sync isn\'t refused for a snapshot that differs only in line endings (named in a note, put back, not committed with CRLF); a real uncommitted change is still refused',
      adopt.status === 0 && syncEol.status === 0 && /synced 1 commit/.test(out(syncEol)) && /line endings only, ignored/.test(out(syncEol)) && !snapAfter.includes('\r') && /boats = 4/.test(boatsAfter)
        && syncReal.status !== 0 && /has uncommitted changes/.test(out(syncReal)),
      `${out(adopt).slice(-400)}\n---\n${out(syncEol).slice(-800)}\n---\n${out(syncReal).slice(-600)}`);
  }

  // ---- O4: strays left on the main checkout ----
  write('game/pier/src/stray.test.ts', 'export const stray = 1;\n');
  g('add', '--', 'game/pier/src/stray.test.ts'); // staged by someone else, never committed
  const t6 = add('Plan: the week\'s tasks', 'producer');
  start(t6, 'prod-1');
  write('studio/notes/week.md', '# The week\n');
  commitTask(t6, 'week plan', 'studio/notes/week.md');
  const d6 = done(t6, 'prod-1');
  report('2.58.3 (O4): a task that isn\'t code work, claimed no paths and committed no game code isn\'t refused for files someone else left staged in the game folder; a note and a checkout.strays event go to the Producer',
    d6.status === 0 && /"status": "done"/.test(out(d6)) && /left by someone else on the main checkout/.test(out(d6)) && events().some((e) => e.type === 'checkout.strays' && e.task === t6 && e.to === 'producer' && /stray\.test\.ts/.test(e.msg)),
    out(d6).slice(-1500));

  const t7 = add('Plan: the dock layout', 'producer');
  start(t7, 'prod-2');
  write('game/pier/src/layout.gd', 'var layout = 1\n');
  commitTask(t7, 'layout', 'game/pier/src/layout.gd');
  const d7 = done(t7, 'prod-2');
  const t8 = add('Plan: the dock signs', 'producer');
  start(t8, 'prod-3');
  run(dir, 'node harness/lock.mjs claim path:game/pier --owner prod-3', env);
  write('studio/notes/signs.md', '# Signs\n');
  commitTask(t8, 'signs', 'studio/notes/signs.md');
  const d8 = done(t8, 'prod-3');
  report('2.58.3 (O4): it still refuses when the task\'s own commits touch game code, or when it claimed paths',
    d7.status !== 0 && /aren't committed yet[\s\S]*stray\.test\.ts/.test(out(d7)) && d8.status !== 0 && /aren't committed yet[\s\S]*stray\.test\.ts/.test(out(d8)), `${out(d7).slice(-800)}\n---\n${out(d8).slice(-800)}`);
  run(dir, 'node harness/lock.mjs release path:game/pier --owner prod-3', env);
  g('rm', '-q', '--cached', '--', 'game/pier/src/stray.test.ts');
  fs.rmSync(path.join(dir, 'game/pier/src/stray.test.ts'), { force: true });

  // ---- O5: what is stale ----
  const st = probe('stale', `import fs from 'node:fs';
import { gatesAfter } from ${u('harness/done-check.mjs')};
import { emitEvent } from ${u('harness/event.mjs')};
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const rec = (ms, extra = {}) => JSON.stringify({ at: iso(ms), partial: false, head: null, dirty: false, rows: [{ id: 'protected', ok: true, required: true }], ...extra });
fs.mkdirSync('.studio/gates', { recursive: true });
// 1. my own verify (bot-a) at -10 min; a newer full verify by bot-b at -2 min; my change at -5 min.
fs.writeFileSync('.studio/gates/bot-a-full.json', rec(now - 600000));
fs.writeFileSync('.studio/gates/bot-b-full.json', rec(now - 120000));
fs.writeFileSync('.studio/gates-last-full.json', rec(now - 120000));
process.env.STUDIO_LOCK_OWNER = 'bot-a';
const owner = gatesAfter(now - 300000, null, 'T-019', { last: { at: now - 300000, kind: 'file', file: 'game/x.ts' } });
// 2. main moved: the newest change is a commit not tagged with this task, and T-006 landed after my verify.
fs.writeFileSync('.studio/gates-last-full.json', rec(now - 600000));
fs.writeFileSync('.studio/gates/bot-b-full.json', rec(now - 600000 - 1));
emitEvent({ type: 'task.done', agent: 'bot-c', task: 'T-006', msg: 'Completed T-006' });
const main = gatesAfter(now - 1000, null, 'T-019', { last: { at: now - 1000, kind: 'commit', hash: 'abcdef1234567890', file: 'game/y.ts', tagged: false } });
// 3. my own files changed after it.
const mine = gatesAfter(now - 1000, null, 'T-019', { last: { at: now - 1000, kind: 'file', file: 'game/x.ts' } });
console.log(JSON.stringify({ owner, main, mine }));`, { ...env, AGENT_EVENTS_FILE: path.join(dir, '.studio', 'events-2583o-stale.jsonl') });
  report('2.58.3 (O5): a stale verify says what is stale: "was by bot-b, not you (STUDIO_LOCK_OWNER=bot-a)", "main moved since your last verify (T-006 landed at HH:MM UTC)", "your files changed after it (game/x.ts at …)"',
    /^no full `npm run verify` of yours after your last change: the last full verify \(\d\d:\d\d UTC\) was by bot-b, not you \(STUDIO_LOCK_OWNER=bot-a\)/.test(st.owner || '')
      && /^no full `npm run verify` after main moved: main moved since your last verify \(T-006 landed at \d\d:\d\d UTC\)/.test(st.main || '')
      && /^no full `npm run verify` after your last change: your files changed after it \(game\/x\.ts at \d\d:\d\d UTC; the last full verify was at \d\d:\d\d UTC\)/.test(st.mine || ''),
    JSON.stringify(st).slice(0, 1500));
}
