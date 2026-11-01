/**
 * qa/selftest-260b.mjs — 2.60.0 (helper b): shared-line hotspots (brief item 2a and 2b).
 *   2a. The size ratchet (files over the limit can't grow) made every lane append to one joined import line of one big
 *       file. A game's protected manifest may now declare "sizeRule": { "exempt": [...], "importLinesFree": true }:
 *       an exempt file may grow up to a hard cap; added import/re-export lines don't count as growth; an exemption
 *       written anywhere else (the task's own edit of the manifest, an unprotected manifest, another file) is ignored.
 *   2b. Lanes in flight (train queue, lane copies with unlanded commits) that change the same lines of the same file
 *       are warned about at task start, task done --train and in the train's start log, and posted to the Producer
 *       once; the third merge-train conflict on one line raises exactly one "hotspot: restructure" ask.
 * A made-up game (game/demo): notes its check reads, and TypeScript files for the size rule.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest260B({ dir, run, report, tmpRoot, root }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8' });
  const write = (base, rel, text) => { fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true }); fs.writeFileSync(path.join(base, rel), text); };
  const read = (rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { return ''; } };
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const events = path.join(dir, '.studio', 'events-260b.jsonl');
  const mark = path.join(tmpRoot, `train-runs-260b-${process.pid}.txt`);
  const env = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', GITHUB_BASE_REF: '', STUDIO_GAME: 'demo', STUDIO_REACHABILITY: 'off', STUDIO_DONE_NOOP: 'allow', STUDIO_DONE_REUSE_VERIFY: '', STUDIO_GATE_INCOMING_FILE: '', STUDIO_GATE_PRIORITY: '', STUDIO_GATE_CHANGED: '', STUDIO_GATE_PATHS: '', STUDIO_TRAIN: '', STUDIO_HOOKS_CHECK: 'on', STUDIO_LANE_LIVE_MIN: '0', STUDIO_COMPACT_OUTPUT: '', STUDIO_HOTSPOT_ASK: '', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-260b-${process.pid}.pem`), AGENT_EVENTS_FILE: events, TRAIN_MARK: mark, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const evs = () => { try { return fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const lines = (n, f) => `${Array.from({ length: n }, (_, i) => f(i)).join('\n')}\n`;
  // The size check reads JavaScript with the harness's typescript; the selftest copy has no node_modules of its own
  // (CI found this), so link the harness's, as qa/selftest-2582k.mjs does.
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!fs.existsSync(path.join(dir, 'node_modules', 'typescript')) && fs.existsSync(path.join(harnessRoot, 'node_modules', 'typescript'))) {
    try { fs.rmSync(path.join(dir, 'node_modules'), { force: true }); } catch {}
    fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  }

  // ---- the studio ----
  write(dir, 'studio/gates.json', `${JSON.stringify({ gates: [
    { id: 'protected', command: 'node qa/protected-check.mjs', required: true, lite: true },
    { id: 'secrets', command: 'node scripts/secret-scan.mjs', required: true, lite: true },
    { id: 'hooks', command: 'node harness/hook-stamp.mjs check', required: true, lite: true, cache: false },
    { id: 'game', command: 'node harness/game-gates.mjs', required: true, lite: true, cache: false },
  ] }, null, 2)}\n`);
  // The owner's sizeRule, committed on main in the protected manifest.
  write(dir, 'game/demo/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'check', command: 'node game/demo/check.mjs' }], sizeRule: { exempt: ['src/modules.ts'], importLinesFree: true } }, null, 2)}\n`);
  write(dir, 'game/demo/check.mjs', [
    "import fs from 'node:fs'; import path from 'node:path';",
    "if (process.env.TRAIN_MARK) fs.appendFileSync(process.env.TRAIN_MARK, `${process.cwd()}\\n`);",
    "const d = 'game/demo/notes';",
    "const bad = fs.existsSync(d) ? fs.readdirSync(d).filter((f) => fs.readFileSync(path.join(d, f), 'utf8').includes('BROKEN')) : [];",
    "if (bad.length) { console.error(`FAIL notes: ${bad.join(', ')} says BROKEN`); process.exit(1); }",
    "console.log('notes ok');", ''].join('\n'));
  write(dir, 'game/demo/notes/reg.md', '# Registry\n\nentries: a\n\nend\n');
  write(dir, 'game/demo/src/modules.ts', lines(25, (i) => `export const m${i} = ${i};`));
  write(dir, 'game/demo/src/big.ts', lines(25, (i) => `export const v${i} = ${i};`));
  write(dir, 'game/demo/src/other.ts', lines(25, (i) => `export const o${i} = ${i};`));
  // Exemptions where they don't count: another file of the game, and a manifest studio/protected.json doesn't cover.
  write(dir, 'game/demo/size-rule.json', `${JSON.stringify({ sizeRule: { exempt: ['src/other.ts'], importLinesFree: true } }, null, 2)}\n`);
  write(dir, 'cartridges/zz/studio.gates.json', `${JSON.stringify({ sizeRule: { exempt: ['src/c.ts'], importLinesFree: true } }, null, 2)}\n`);
  write(dir, 'cartridges/zz/src/c.ts', lines(25, (i) => `export const c${i} = ${i};`));
  g(dir, 'init', '-q', '-b', 'main'); g(dir, 'config', 'core.autocrlf', 'false');
  g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'studio', '--no-verify');

  const addTask = (title) => (out(run(dir, `node harness/task.mjs add "${title}" --role builder --priority P1`, env)).match(/"id": "(T-\d+)"/) || [])[1];
  const szEnv = { ...env, STUDIO_FILE_MAX_LINES: '20', STUDIO_FILE_MAX_KB: '9999', STUDIO_FN_MAX_LINES: '9999' };
  const grewOf = (id, files) => {
    const f = path.join(dir, '.probe-260b-size.mjs');
    fs.writeFileSync(f, `import { sizeGrowth } from ${u('harness/done-check.mjs')};\nconsole.log(JSON.stringify({ grew: sizeGrowth(${JSON.stringify(id)}, ${JSON.stringify(files)}) }));\n`);
    const r = run(dir, `node ${path.basename(f)}`, szEnv);
    fs.rmSync(f, { force: true });
    try { return { ...JSON.parse(String(r.stdout).trim().split('\n').filter((l) => l.startsWith('{')).pop()), _out: out(r) }; } catch { return { grew: null, _out: out(r).slice(-1500) }; }
  };
  /** A task started on its own branch off main (never merged): its size growth is measured from main's tip. */
  const sizeTask = (branch, title) => {
    const id = addTask(title);
    g(dir, 'switch', '-q', '-c', branch, 'main');
    run(dir, `node harness/task.mjs start ${id} --agent ${branch}`, { ...env, STUDIO_LOCK_OWNER: branch });
    return id;
  };
  const commitAll = (id, msg, ...files) => { g(dir, 'add', '--', ...files); return g(dir, 'commit', '-qm', `${msg}\n\nStudio-Task: ${id}`, '--no-verify'); };

  // ---- 2a.1 an exempt barrel may grow, up to its printed hard cap ----
  const t1 = sizeTask('size-exempt', 'Grow the module barrel');
  write(dir, 'game/demo/src/modules.ts', lines(30, (i) => `export const m${i} = ${i};`));
  commitAll(t1, 'barrel +5', 'game/demo/src/modules.ts');
  const ex1 = grewOf(t1, ['game/demo/src/modules.ts']);
  write(dir, 'game/demo/src/modules.ts', lines(45, (i) => `export const m${i} = ${i};`));
  commitAll(t1, 'barrel past the cap', 'game/demo/src/modules.ts');
  const ex2 = grewOf(t1, ['game/demo/src/modules.ts']);
  report('2.60.0 (#2a): a file the game\'s protected manifest exempts ("sizeRule": { "exempt": [...] }) may grow past the file limit (25 → 30 lines, limit 20), but not past its hard cap (twice the limit, printed: 45 lines is refused "over the hard cap of 40") (fails on 2.59.1: the barrel growing at all was refused)',
    Array.isArray(ex1.grew) && ex1.grew.length === 0 && Array.isArray(ex2.grew) && ex2.grew.some((x) => /modules\.ts is 46 lines, over the hard cap of 40.*exempt/.test(x)),
    `${JSON.stringify(ex1).slice(0, 1200)}\n---\n${JSON.stringify(ex2).slice(0, 1200)}`);
  g(dir, 'switch', '-q', 'main');

  // ---- 2a.2 import-only additions are free with importLinesFree; any other line still counts ----
  const t2 = sizeTask('size-imports', 'Register two systems');
  const base = read('game/demo/src/big.ts');
  write(dir, 'game/demo/src/big.ts', `import { a } from './a';\nimport b from "./b"; export * from './c';\nimport {\n  d,\n  e as f,\n} from './d';\n${base}`);
  commitAll(t2, 'imports only', 'game/demo/src/big.ts');
  const im1 = grewOf(t2, ['game/demo/src/big.ts']);
  write(dir, 'game/demo/src/big.ts', `${read('game/demo/src/big.ts')}export const extra = 1;\n`);
  commitAll(t2, 'and a code line', 'game/demo/src/big.ts');
  const im2 = grewOf(t2, ['game/demo/src/big.ts']);
  report('2.60.0 (#2a): with "importLinesFree", a big file that gains only import/re-export lines (single, joined on one line, a multi-line import block) passes the size ratchet; one more ordinary line is still refused (fails on 2.59.1: the import lines alone were refused)',
    Array.isArray(im1.grew) && im1.grew.length === 0 && Array.isArray(im2.grew) && im2.grew.some((x) => /big\.ts is 33 lines \(was 26\), over the limit of 20, 27 without the 6 added import line/.test(x)),
    `${JSON.stringify(im1).slice(0, 1200)}\n---\n${JSON.stringify(im2).slice(0, 1200)}`);
  g(dir, 'switch', '-q', 'main');

  // ---- 2a.3 exemptions anywhere but the protected manifest on main are ignored ----
  const t3 = sizeTask('size-elsewhere', 'Grow three files');
  const man = JSON.parse(read('game/demo/studio.gates.json'));
  man.sizeRule.exempt.push('src/other.ts');
  write(dir, 'game/demo/studio.gates.json', `${JSON.stringify(man, null, 2)}\n`);
  write(dir, 'game/demo/src/other.ts', lines(30, (i) => `export const o${i} = ${i};`));
  write(dir, 'cartridges/zz/src/c.ts', lines(30, (i) => `export const c${i} = ${i};`));
  write(dir, 'game/demo/src/modules.ts', lines(30, (i) => `export const m${i} = ${i};`));
  commitAll(t3, 'grow, and exempt myself', 'game/demo/studio.gates.json', 'game/demo/src/other.ts', 'cartridges/zz/src/c.ts', 'game/demo/src/modules.ts');
  const el = grewOf(t3, ['game/demo/src/other.ts', 'cartridges/zz/src/c.ts', 'game/demo/src/modules.ts']);
  report('2.60.0 (#2a): an exemption the task writes itself (its own commit to the manifest), one in a manifest studio/protected.json doesn\'t cover (cartridges/zz/studio.gates.json) and one in another file (game/demo/size-rule.json) are ignored: both files are refused and the refusal says the copy\'s sizeRule isn\'t used; the owner\'s exemption on main still applies (fails on 2.59.1: no exemption applied at all)',
    Array.isArray(el.grew) && el.grew.some((x) => /other\.ts is 31 lines/.test(x)) && el.grew.some((x) => /cartridges\/zz\/src\/c\.ts is 31 lines/.test(x)) && !el.grew.some((x) => /modules\.ts/.test(x)) && el.grew.some((x) => /sizeRule.*isn't used/.test(x)),
    JSON.stringify(el).slice(0, 2000));
  g(dir, 'switch', '-q', 'main');

  // ---- 2b. hotspots: lanes in flight that change the same line ----
  g(dir, 'config', 'core.hooksPath', 'scripts/hooks');
  const laneProbe = path.join(tmpRoot, `lane-260b-${process.pid}.mjs`);
  fs.writeFileSync(laneProbe, `import { createLaneCopy } from ${u('harness/worktree.mjs')};\nconst r = createLaneCopy(process.argv[2], { task: process.argv[3] });\nconsole.log(JSON.stringify(r));\n`);
  const lane = (agent, title, rel, text, from = null) => {
    const id = addTask(title);
    const made = run(dir, `node "${laneProbe}" ${agent} ${id}`, env);
    const ld = path.join(dir, '.lanes', agent);
    const as = { ...env, STUDIO_MAIN_ROOT: dir, STUDIO_LOCK_OWNER: agent };
    const st = run(ld, `node harness/task.mjs start ${id} --agent ${agent}`, as);
    if (from) g(ld, 'reset', '-q', '--hard', from); // built on an older main, as a lane started earlier is
    write(ld, rel, text);
    g(ld, 'add', rel);
    const c = spawnSync('git', ['commit', '-qm', `${id}: ${title}`], { cwd: ld, encoding: 'utf8', env: { ...process.env, ...as } });
    return { id, agent, dir: ld, as, st, ok: fs.existsSync(ld) && st.status === 0 && c.status === 0, log: `${out(made)}\n${out(st)}\n${out(c)}` };
  };
  const queueIt = (l) => run(l.dir, `node harness/task.mjs done ${l.id} --agent ${l.agent} --train`, l.as);
  const train = () => run(dir, 'node harness/task.mjs train --by tester', env);
  const reg = (who) => `# Registry\n\nentries: a, ${who}\n\nend\n`;
  const REL = 'game/demo/notes/reg.md';
  const hot = (text, ...ids) => new RegExp(`hotspot: game/demo/notes/reg\\.md:3 is changed by ${ids.length} lanes`).test(text) && ids.every((id) => text.includes(id));

  const oldMain = g(dir, 'rev-parse', 'main').stdout.trim();
  const p = lane('hot-p', 'Docs: register p', REL, reg('p'));
  const q = lane('hot-q', 'Docs: register q', REL, reg('q'));
  const qp = queueIt(p);
  const qq = queueIt(q);
  const r = lane('hot-r', 'Docs: note r', 'game/demo/notes/r.md', '# R\n');
  const t1r = train();
  const inboxOverlaps = read('studio/producer/INBOX.md').split('\n').filter((l) => /hotspot: game\/demo\/notes\/reg\.md:3 is changed by/.test(l));
  report('2.60.0 (#2b): two lanes in flight changing the same line of the same file are named (file, line, both lanes) at task done --train, at the next task start and in the merge train\'s start log; the Producer gets it once (a hotspot.overlap event and one inbox line), not at every warning (fails on 2.59.1: no warning anywhere)',
    p.ok && q.ok && r.ok && qp.status === 0 && qq.status === 0 && hot(out(qp), p.id, q.id) && hot(out(qq), p.id, q.id) && hot(out(r.st), p.id, q.id) && hot(out(t1r), p.id, q.id) && /\[train\]/.test(out(t1r))
      && inboxOverlaps.length === 1 && evs().filter((e) => e.type === 'hotspot.overlap' && e.meta?.file === REL).length === 1,
    `${p.log.slice(-300)}\n--- queue p:\n${out(qp).slice(-700)}\n--- start r:\n${out(r.st).slice(-700)}\n--- train:\n${out(t1r).slice(-1200)}\ninbox: ${JSON.stringify(inboxOverlaps)}`);

  // The train: p lands, q waits (conflict 1); next train q conflicts with main (2); then s (3: the ask), then t (4: no second ask).
  const countAfter1 = (() => { try { return JSON.parse(read('.studio/hotspots.json')).conflicts.find((c) => c.file === REL)?.count || 0; } catch { return 0; } })();
  const t2r = train();
  const s = lane('hot-s', 'Docs: register s', REL, reg('s'), oldMain);
  queueIt(s);
  const t3r = train();
  const t = lane('hot-t', 'Docs: register t', REL, reg('t'), oldMain);
  queueIt(t);
  const t4r = train();
  const state = (() => { try { return JSON.parse(read('.studio/hotspots.json')).conflicts.find((c) => c.file === REL) || {}; } catch { return {}; } })();
  const asksInbox = read('studio/producer/INBOX.md').split('\n').filter((l) => /hotspot: restructure game\/demo\/notes\/reg\.md:3 \(registry\/barrel pattern\)/.test(l));
  const askEvents = evs().filter((e) => e.type === 'hotspot.ask' && e.meta?.file === REL);
  report('2.60.0 (#2b): each merge train that meets a conflict on one line counts it once; the third conflict on game/demo/notes/reg.md:3 raises exactly one "hotspot: restructure <file>:<line> (registry/barrel pattern)" ask to the Producer (event + inbox), and the fourth raises none (fails on 2.59.1: no conflict count, no ask)',
    s.ok && t.ok && countAfter1 === 1 && state.count === 4 && state.asked === true && asksInbox.length === 1 && askEvents.length === 1 && askEvents[0].meta?.count === 3,
    `${out(t1r).slice(-900)}\nafter1=${countAfter1} state=${JSON.stringify(state)}\ninbox asks=${JSON.stringify(asksInbox)}\nevents=${JSON.stringify(askEvents)}\n${out(t2r).slice(-600)}\n${out(t3r).slice(-600)}\n${out(t4r).slice(-600)}`);
  fs.rmSync(laneProbe, { force: true });
}
