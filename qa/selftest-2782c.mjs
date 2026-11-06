/**
 * qa/selftest-2782c.mjs — 2.78.2 (c): five items from the crew's 2.78.1 run (items 3, 5, 10, 11, 12 of the patch request).
 *   - Item 3: a commit on main that only touches agent logs (studio/producer/**), reviews (studio/reviews/**) or grows the
 *     test quarantine doesn't restart a verified train (boardOnlyMove: ok, no check to re-run); a quarantine release, or
 *     any code file, still does. No gating docs check reads studio/producer, reviews, handoffs or notes.
 *   - Item 5: a review file is judged by its last "Verdict:" line, not by "blocking" or "changes requested" anywhere.
 *   - Item 10: the crew breaker resumes a paused role by itself after STUDIO_CREW_BREAKER_RESUME_MIN.
 *   - Item 11: a relaunched builder's copy starts from the task's earlier lane branch (a conflict with main no longer
 *     drops its commits); `lanes carry` skips commits already on the target instead of stopping.
 *   - Item 12: a direction/review/docs task whose lane changes no game code doesn't run the game's checks at done.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest2782C({ dir, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = path.join(harnessRoot, 'node_modules');
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const writeIn = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };
  const textIn = (cwd, rel) => { try { return fs.readFileSync(path.join(cwd, rel), 'utf8'); } catch { return ''; } };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, STUDIO_REFILL_WAKE: 'off', STUDIO_WATCHDOG: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', GITHUB_BASE_REF: '', CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };
  let n = 0;
  const made = [];
  const studio = (name) => {
    const S = path.join(tmpRoot, `2782c-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    fs.rmSync(path.join(S, '.env'), { force: true });
    const ev = path.join(S, '.studio', 'events-2782c.jsonl');
    writeIn(S, '.studio/events-2782c.jsonl', '');
    g(S, 'init', '-q', '-b', 'main'); g(S, 'config', 'core.autocrlf', 'false'); g(S, 'config', 'core.eol', 'lf');
    g(S, 'config', 'user.name', 't'); g(S, 'config', 'user.email', 't@example.invalid');
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
    made.push(S);
    return { S, env: { ...base, AGENT_EVENTS_FILE: ev, STUDIO_MAIN_ROOT: S } };
  };
  const node = (S, args, env) => spawnSync(process.execPath, args, { windowsHide: true, cwd: S, encoding: 'utf8', env: { ...process.env, ...ident, ...env }, timeout: 180000 });
  const task = (S, line, env) => node(S, ['harness/task.mjs', ...line], env);
  const probe = (S, code, env) => { const f = path.join(S, `.probe-2782c-${++n}.mjs`); fs.writeFileSync(f, code); const r = node(S, [f], env); const l = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop(); let j = null; try { j = JSON.parse(l); } catch {} return { ...r, j }; };
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  const commit = (cwd, rel, text, msg) => { writeIn(cwd, rel, text); g(cwd, 'add', '--', rel); return g(cwd, 'commit', '-qm', msg, '--no-verify'); };
  const head = (cwd, rev = 'HEAD') => g(cwd, 'rev-parse', rev).stdout.trim();

  // ---- item 3: board moves ----
  {
    const { S, env } = studio('board');
    const tip = head(S);
    commit(S, 'studio/producer/LOG.md', '# log\n- a note\n', 'producer note');
    commit(S, 'studio/reviews/2026-11-05-T-1-reviewer-x.md', 'model-family: x\n', 'a review');
    const logMove = head(S);
    commit(S, 'studio/quarantine.json', JSON.stringify([{ test: 'a.e2e.test.ts', status: 'active' }]), 'quarantine adds a test');
    const grows = head(S);
    commit(S, 'studio/quarantine.json', JSON.stringify([{ test: 'a.e2e.test.ts', status: 'proposed' }]), 'quarantine releases it');
    const releases = head(S);
    commit(S, 'harness/some-code.mjs', 'export const x = 1;\n', 'code');
    const code = head(S);
    const p = probe(S, `import { boardOnlyMove } from ${u(S, 'harness/train.mjs')};
const root = ${JSON.stringify(S)};
const m = (a, b) => { const r = boardOnlyMove(root, a, b); return { ok: r.ok, recheck: r.recheck || [], why: r.why || '' }; };
console.log(JSON.stringify({ log: m(${JSON.stringify(tip)}, ${JSON.stringify(logMove)}), grows: m(${JSON.stringify(logMove)}, ${JSON.stringify(grows)}), releases: m(${JSON.stringify(grows)}, ${JSON.stringify(releases)}), code: m(${JSON.stringify(releases)}, ${JSON.stringify(code)}) }));`, env);
    const j = p.j || {};
    await guard('2.78.2 (c, item 3): main moved by producer-log and review files alone is a board move with nothing to re-run (boardOnlyMove ok, recheck empty); a quarantine that only adds a skipped test is too; releasing a test, or a code file, still means a new verify (fails on 2.78.1: the log move re-ran the docs check and the reviews move the reviewer check, so a load flake there restarted a green train; a quarantine change always restarted it)', () => [
      j.log?.ok === true && j.log.recheck.length === 0 && j.grows?.ok === true && j.grows.recheck.length === 0 && j.releases?.ok === false && j.code?.ok === false,
      p.j ? JSON.stringify(j) : out(p).slice(-600)]);

    // the docs check never reads agent logs, notes, handoffs or reviews
    writeIn(S, 'studio/producer/NOTES-2.md', 'run `npm run no-such-script-2782` now\n');
    writeIn(S, 'studio/notes/WATCH.md', 'run `node harness/no-such-file-2782.mjs` now\n');
    writeIn(S, 'studio/reviews/R.md', 'run `npm run no-such-script-2782b`\n');
    const d = node(S, ['scripts/check-docs.mjs'], env);
    writeIn(S, 'docs/NOT-AN-AGENT-LOG.md', 'run `npm run no-such-script-2782c`\n');
    const d2 = node(S, ['scripts/check-docs.mjs'], env);
    await guard('2.78.2 (c, item 3): the docs check skips studio/producer, studio/notes and studio/reviews (a bad command in an agent-written file there doesn\'t fail it) and still fails on one in docs/ (fails on 2.78.1: it read studio/producer/*.md other than LOG.md and INBOX.md, and studio/notes)', () => [
      d.status === 0 && /\[docs\] PASS/.test(out(d)) && d2.status !== 0 && /no-such-script-2782c/.test(out(d2)),
      `plain: ${out(d).slice(-300)} | with a bad doc: ${out(d2).slice(-200)}`]);
  }

  // ---- item 5: the last Verdict line decides ----
  {
    const { S, env } = studio('verdict');
    const p = probe(S, `import { reviewApproves } from ${u(S, 'harness/done-check.mjs')};
const first = 'model-family: grok\\nimplementer-family: anthropic\\nReview of T-174.\\nVerdict: changes requested\\n- the golden has no reason\\n';
const both = first + '\\n## Re-review\\nFixed. Non-blocking note: rename x later.\\nVerdict: approve\\n';
const nonBlocking = 'Review of T-9.\\nApprove. One non-blocking note: rename x.\\nVerdict: Approve\\n';
const crlf = both.replace(/\\n/g, '\\r\\n');
const lastRejects = 'Verdict: approve\\n\\n## Second look\\nVerdict: CHANGES REQUESTED\\n';
const noLine = 'I approve this.';
const noLineBlocking = 'I approve this, but one blocking point remains.';
const md = '**Verdict:** approve';
console.log(JSON.stringify({ first: reviewApproves(first), both: reviewApproves(both), nonBlocking: reviewApproves(nonBlocking), crlf: reviewApproves(crlf), lastRejects: reviewApproves(lastRejects), noLine: reviewApproves(noLine), noLineBlocking: reviewApproves(noLineBlocking), md: reviewApproves(md) }));`, env); // 2.79.1 (e): the REVIEW_VERDICT_LINE=off result (removed switch) is gone with the switch
    const j = p.j || {};
    await guard('2.78.2 (c, item 5): a review file is judged by its last "Verdict:" line: an appended re-review that approves counts, so does "non-blocking" in the text, CRLF and "**Verdict:** approve"; a last line of "changes requested" doesn\'t; no Verdict line keeps the old rule (fails on 2.78.1: the whole file was dropped when it said "changes requested", "reject" or "blocking" anywhere; no reviewApproves)', () => [
      j.first === false && j.both === true && j.nonBlocking === true && j.crlf === true && j.lastRejects === false && j.noLine === true && j.noLineBlocking === false && j.md === true,
      p.j ? JSON.stringify(j) : out(p).slice(-500)]);
  }

  // ---- item 10: crew breaker auto-resume ----
  {
    const { S, env } = studio('crew');
    const min = 60000;
    const p = probe(S, `import fs from 'node:fs';
import { crewPass, readPaused, PAUSED_FILE } from ${u(S, 'harness/crew-watch.mjs')};
const now0 = Date.parse('2026-11-05T12:00:00Z');
const emitted = [];
const emit = (e) => emitted.push(e);
const sess = (agent, at, task) => [{ type: 'agent.session.start', agent, ts: new Date(at).toISOString(), task, meta: { role: 'builder' } }, { type: 'agent.session.end', agent, ts: new Date(at + 60000).toISOString(), meta: { role: 'builder', outcome: { done: false, commits: 0, why: 'no commit' } } }];
const many = (from, count) => Array.from({ length: count }, (_, i) => sess('builder-' + i, from + i * 2 * ${min}, 'T-7')).flat();
const writePause = (at) => fs.writeFileSync(PAUSED_FILE(), JSON.stringify({ roles: { builder: { at: new Date(at).toISOString(), why: '7 sessions in 60 min and 0 landed', tasks: ['T-7'], waiting: ['T-7'], evidence: { sessions: 7 } } }, since: {} }));
const res = {};
// A. paused 2 h ago, nothing since (the supervisor was down): resumes by itself, logged.
fs.mkdirSync(PAUSED_FILE().replace(/[\\\\/][^\\\\/]*$/, ''), { recursive: true });
writePause(now0 - 120 * ${min});
let r = crewPass({ events: many(now0 - 200 * ${min}, 7), now: now0, env: { STUDIO_CREW_WATCH: 'on' }, waitingByRole: { builder: ['T-7'] }, emit });
res.a = { paused: Object.keys(r.paused), event: emitted.map((e) => e.type + ':' + (e.meta?.auto ? 'auto' : 'manual')) };
// B. paused 10 min ago: not yet.
emitted.length = 0;
writePause(now0 - 10 * ${min});
r = crewPass({ events: many(now0 - 30 * ${min}, 7), now: now0, env: { STUDIO_CREW_WATCH: 'on' }, waitingByRole: { builder: ['T-7'] }, emit });
res.b = { paused: Object.keys(r.paused), events: emitted.length };
// C. paused 40 min ago, still tripping (7 sessions in the last hour, none landed): resumes ONCE; trips again on the same
// cause: stays paused the second time.
emitted.length = 0;
writePause(now0 - 40 * ${min});
const evs = many(now0 - 55 * ${min}, 7);
r = crewPass({ events: evs, now: now0, env: { STUDIO_CREW_WATCH: 'on' }, waitingByRole: { builder: ['T-7'] }, emit });
res.c1 = { paused: Object.keys(r.paused), event: emitted.map((e) => e.type + ':' + (e.meta?.auto ? 'auto' : 'manual')) };
const t1 = now0 + 5 * ${min};
const evs2 = [...evs, ...many(now0 + ${min}, 7)];
emitted.length = 0;
r = crewPass({ events: evs2, now: t1 + 12 * 2 * ${min}, env: { STUDIO_CREW_WATCH: 'on' }, waitingByRole: { builder: ['T-7'] }, emit });
res.c2 = { paused: Object.keys(r.paused), event: emitted.map((e) => e.type) };
const t2 = t1 + 12 * 2 * ${min} + 31 * ${min}; // 31 min after the second pause; the second burst is still inside the hour
emitted.length = 0;
r = crewPass({ events: evs2, now: t2, env: { STUDIO_CREW_WATCH: 'on' }, waitingByRole: { builder: ['T-7'] }, emit });
res.c3 = { paused: Object.keys(r.paused), event: emitted.map((e) => e.type) };
// D. off: STUDIO_CREW_BREAKER_RESUME_MIN=0 never resumes.
emitted.length = 0;
writePause(now0 - 500 * ${min});
r = crewPass({ events: [], now: now0, env: { STUDIO_CREW_WATCH: 'on', STUDIO_CREW_BREAKER_RESUME_MIN: '0' }, waitingByRole: {}, emit });
res.d = { paused: Object.keys(r.paused) };
console.log(JSON.stringify(res));`, env);
    const j = p.j || {};
    await guard('2.78.2 (c, item 10): a crew-breaker pause older than STUDIO_CREW_BREAKER_RESUME_MIN (30) resumes by itself, logged as crew.resumed (meta.auto), when its evidence has aged out; not before 30 min; when it still trips it resumes once, and a second trip on the same tasks stays paused; STUDIO_CREW_BREAKER_RESUME_MIN=0 never resumes (fails on 2.78.1: only a landing, new work or a person resumed it, so it sat paused for 2 h)', () => [
      j.a && j.a.paused.length === 0 && j.a.event.join() === 'crew.resumed:auto'
        && j.b && j.b.paused.join() === 'builder' && j.b.events === 0
        && j.c1 && j.c1.paused.length === 0 && j.c1.event.join() === 'crew.resumed:auto'
        && j.c2 && j.c2.paused.join() === 'builder' && j.c2.event.join() === 'crew.unhealthy'
        && j.c3 && j.c3.paused.join() === 'builder' && j.c3.event.length === 0
        && j.d && j.d.paused.join() === 'builder',
      p.j ? JSON.stringify(j) : out(p).slice(-600)]);
  }

  // ---- item 11 (a): a relaunch starts from the task's earlier lane branch ----
  {
    const { S, env } = studio('relaunch');
    const a = task(S, ['add', 'Dock crane queue', '--role', 'builder'], env);
    const id = (out(a).match(/"id":\s*"([A-Z]+-\d+)"/) || [])[1];
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'board', '--no-verify');
    commit(S, 'game/toy/crane.txt', 'base\n', 'crane base');
    g(S, 'branch', 'lane/builder-old-20261105-1000');
    g(S, 'checkout', '-q', 'lane/builder-old-20261105-1000');
    commit(S, 'game/toy/crane.txt', 'old builder change\n', `${id}: the earlier builder's work`);
    const oldSha = head(S);
    g(S, 'checkout', '-q', 'main');
    commit(S, 'game/toy/crane.txt', 'main moved the same line\n', 'main changes the same line');
    const p = probe(S, `import { rememberTaskBranch, createLaneCopy } from ${u(S, 'harness/worktree.mjs')};
rememberTaskBranch(${JSON.stringify(id)}, 'lane/builder-old-20261105-1000');
const c = createLaneCopy('builder-new', { task: ${JSON.stringify(id)} });
console.log(JSON.stringify({ error: c.error || null, dir: c.dir || null, branch: c.branch || null, carried: c.carried || null }));`, env);
    const dirN = p.j?.dir;
    const has = dirN ? g(dirN, 'merge-base', '--is-ancestor', oldSha, 'HEAD').status === 0 : false;
    const body = dirN ? textIn(dirN, 'game/toy/crane.txt') : '';
    await guard('2.78.2 (c, item 11a): a builder relaunched on a task under a new name gets a copy that starts from the task\'s earlier lane branch (its commit is in the new copy\'s history, its file content there) even when main changed the same line and the two don\'t merge (fails on 2.78.1: the copy started from main and the merge of the old branch conflicted and was aborted, so the earlier builder\'s commit was lost)', () => [
      Boolean(dirN) && has && /old builder change/.test(body),
      `${JSON.stringify(p.j)} ancestor=${has} file=${JSON.stringify(body)} ${p.j ? '' : out(p).slice(-400)}`]);
  }

  // ---- item 11 (b): lanes carry skips commits already on the target ----
  {
    const { S, env } = studio('carry');
    const a = task(S, ['add', 'Dock crane queue', '--role', 'builder'], env);
    const id = (out(a).match(/"id":\s*"([A-Z]+-\d+)"/) || [])[1];
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'board', '--no-verify');
    commit(S, 'game/toy/a.txt', 'one\n', 'base');
    g(S, 'checkout', '-q', '-b', 'lane/builder-x-20261105-1000');
    commit(S, 'game/toy/a.txt', 'two\n', `${id}: first change`);
    commit(S, 'game/toy/b.txt', 'b\n', `${id}: second change`);
    g(S, 'checkout', '-q', 'main');
    // main got the same result of the first change, as a different patch (it also adds another file)
    writeIn(S, 'game/toy/a.txt', 'two\n'); writeIn(S, 'game/toy/other.txt', 'o\n'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'someone landed the same line plus another file', '--no-verify');
    const r = node(S, ['harness/lanes.mjs', 'carry', id, '--from', 'lane/builder-x-20261105-1000', '--by', 'producer-1', '--json'], { ...env, STUDIO_LOCK_OWNER: 'producer-1', STUDIO_ROLE: 'producer' });
    let j = null; try { j = JSON.parse(String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop()); } catch {}
    await guard('2.78.2 (c, item 11b): `lanes carry` skips a commit whose change is already on the target, lists it as skipped, and carries the rest (fails on 2.78.1: the empty cherry-pick stopped it: status "conflict", nothing carried)', () => [
      j?.status === 'carried' && j.carried?.length === 1 && j.skipped?.length === 1 && /second change/.test(j.carried[0].subject) && /first change/.test(j.skipped[0].subject),
      j ? JSON.stringify({ status: j.status, carried: j.carried?.length, skipped: j.skipped?.length, why: String(j.why).slice(0, 200) }) : out(r).slice(-500)]);
  }

  // ---- item 12: a non-code task's done skips the game's checks ----
  {
    const { S, env } = studio('skip');
    const p = probe(S, `import { skipGameChecks } from ${u(S, 'harness/done-check.mjs')};
const s = (t, f, e) => skipGameChecks(t, f, e).skip;
console.log(JSON.stringify({
  direction: s('direction', ['studio/bible/reviews/2026-11-05-x.md', 'studio/NEXT.md']),
  review: s('review', ['studio/reviews/r.md']),
  docs: s('docs', ['docs/A.md', 'README.md']),
  directionCode: s('direction', ['studio/bible/reviews/x.md', 'game/toy/src/sim.ts']),
  change: s('change', ['docs/A.md']),
  docsWithScript: s('docs', ['docs/A.md', 'scripts/x.mjs']),
}));`, env);
    const j = p.j || {};
    await guard('2.78.2 (c, item 12): done skips the game checks for a direction, review or docs task whose changed files are all notes, docs or studio records; any other file, a code type, runs them (fails on 2.78.1: no skipGameChecks, task done always ran the game suite)', () => [
      j.direction === true && j.review === true && j.docs === true && j.directionCode === false && j.change === false && j.docsWithScript === false,
      p.j ? JSON.stringify(j) : out(p).slice(-500)]);

    // the real thing: task done on a direction task in a studio whose game suite would fail, with only a review file changed
    writeIn(S, 'studio/game.json', `${JSON.stringify({ name: 'toy', root: 'game/toy' })}\n`);
    writeIn(S, 'game/toy/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'unit', command: 'node -e "process.exit(1)"', required: true }] })}\n`);
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'a game whose suite fails', '--no-verify');
    const a = task(S, ['add', 'Director review: phase 1', '--role', 'director'], env);
    const id = (out(a).match(/"id":\s*"([A-Z]+-\d+)"/) || [])[1];
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'board', '--no-verify');
    const who = { ...env, STUDIO_LOCK_OWNER: 'director-1', STUDIO_ROLE: 'director' };
    task(S, ['start', id, '--agent', 'director-1'], who);
    writeIn(S, 'studio/bible/reviews/2026-11-05-phase-1.md', `# Director review\n\nPhase: 1\nVerdict: on course\nChecked: pillar: p1 layer: l1\n\n## Next\n- keep going\n`);
    g(S, 'add', '-A'); g(S, 'commit', '-qm', `${id}: director review`, '--no-verify');
    const d = task(S, ['done', id, '--agent', 'director-1'], who);
    await guard('2.78.2 (c, item 12): `task done` of a direction task that changed only a review file doesn\'t run the game\'s (failing) suite: no "game checks fail", and it says the game checks are not run (fails on 2.78.1: "the game\'s checks fail")', () => [
      !/the game's checks fail/.test(out(d)) && /the game's checks are not run/.test(out(d)),
      out(d).slice(-500)]);
  }

  for (const S of made) { try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 3 }); } catch { /* a later run cleans it */ } }
}
