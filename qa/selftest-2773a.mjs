/**
 * qa/selftest-2773a.mjs — 2.77.3 (a): B-111, beta-mode owner records were accepted, then ignored.
 *   - In beta mode, with an owner key, the owner's stand-in (the orchestrator named in studio/beta.json) retypes a task
 *     (`task type`) or sets its visual proof (`task visual`): kept as a beta-format approval, it counts in done-check
 *     (whatever base the reader uses) and is logged "as beta"; once beta mode is off it no longer counts.
 *   - It never lets a worker approve for itself: a builder's shell is refused, and a beta-format approval dropped in the
 *     folder, or committed by a worker, counts for nothing.
 *   - Outside beta mode, with an owner key the writer couldn't see (origin/main behind the key commit), an unsigned
 *     record is refused up front (exit 1, "needs the owner's signature") instead of "recorded" and then ignored.
 *   - A beta release of a lane held for a protected config proposal (train release) decides the protected part at
 *     landing, as an owner's would.
 *   - Test files (panel.e2e.test.ts, *.spec.*, tests/) under a render path don't make a task a render task.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest2773A({ dir, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = path.join(harnessRoot, 'node_modules');
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const writeIn = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };
  const readIn = (cwd, rel) => { try { return JSON.parse(fs.readFileSync(path.join(cwd, rel), 'utf8')); } catch { return null; } };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  // No agent markers of the shell running the selftest, no owner private key, no worker session.
  const base = { STUDIO_REFILL_WAKE: 'off', STUDIO_WATCHDOG: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_MAIN_ROOT: '', STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '', STUDIO_TASK_BASE: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '', CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', GITHUB_BASE_REF: '', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-2773a-${process.pid}.pem`) };
  let n = 0;
  const made = [];
  const studio = (name) => {
    const S = path.join(tmpRoot, `2773a-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    fs.rmSync(path.join(S, 'studio', 'approvals'), { recursive: true, force: true });
    fs.rmSync(path.join(S, 'studio', 'task-types.json'), { force: true });
    fs.rmSync(path.join(S, 'studio', 'beta.json'), { force: true });
    const ev = path.join(S, '.studio', 'events-2773a.jsonl');
    writeIn(S, '.studio/events-2773a.jsonl', '');
    g(S, 'init', '-q', '-b', 'main'); g(S, 'config', 'core.autocrlf', 'false'); g(S, 'config', 'core.eol', 'lf');
    g(S, 'config', 'user.name', 't'); g(S, 'config', 'user.email', 't@example.invalid');
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
    made.push(S);
    return { S, env: { ...base, AGENT_EVENTS_FILE: ev } };
  };
  const node = (S, args, env) => spawnSync(process.execPath, args, { windowsHide: true, cwd: S, encoding: 'utf8', env: { ...process.env, ...ident, ...env }, timeout: 120000 });
  const task = (S, line, env) => node(S, ['harness/task.mjs', ...line], env);
  const add = (S, title, env) => { const r = task(S, ['add', title, '--role', 'builder'], env); return (out(r).match(/"id":\s*"([A-Z]+-\d+)"/) || [])[1] || null; };
  const doneCheck = (S, id, env) => out(node(S, ['harness/done-check.mjs', id], env));
  const probe = (S, code, env) => { const f = path.join(S, `.probe-2773a-${++n}.mjs`); fs.writeFileSync(f, code); const r = node(S, [f], env); const l = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop(); let j = null; try { j = JSON.parse(l); } catch {} return { ...r, j }; };
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  const pem = () => crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  const betaOn = (S, agents = ['opus-1']) => { const at = new Date().toISOString(); writeIn(S, 'studio/beta.json', `${JSON.stringify({ on: true, by: 'pat', at, why: 'beta for the selftest', agents, roles: ['producer', 'director'] }, null, 2)}\n`); return at; };
  // The orchestrator's own shell: an outside coding agent named in studio/beta.json.
  const orch = (env) => ({ ...env, STUDIO_LOCK_OWNER: 'opus-1', CLAUDECODE: '1' });

  // ---- beta mode with an owner key: type and visual decisions count ----
  {
    const { S, env } = studio('beta');
    writeIn(S, 'studio/keys/owner-ed25519.pub.pem', pem());
    const betaAt = betaOn(S);
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'owner key, beta on', '--no-verify');
    const t1 = add(S, 'Fix: bug batch 12 - UI panels and copy', env);
    const t2 = add(S, 'Water shader foam pass', env);
    const t3 = add(S, 'Fix: bug batch 13 - timetable', env);
    const before = doneCheck(S, t1, env);
    const ty = task(S, ['type', t1, 'change', '--by', 'opus-1', '--why', 'UI copy fixes; no sim behaviour to replay'], orch(env));
    const appr = readIn(S, `studio/approvals/type-${t1}.json`);
    const committed = g(S, 'log', '-1', '--format=%s', '--', `studio/approvals/type-${t1}.json`).stdout.trim();
    const dc = doneCheck(S, t1, env);
    const dcMain = doneCheck(S, t1, { ...env, STUDIO_PROTECT_BASE: 'main' });
    const shown = out(task(S, ['type', t1], env));
    const log = (() => { try { return fs.readFileSync(path.join(S, '.studio', 'decisions.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } })();
    const logged = log.find((d) => d.action === 'type' && d.subject === t1);
    await guard('2.77.3 (B-111): in beta mode with an owner key, the orchestrator\'s `task type <ID> change --by opus-1` exits 0, is kept as a beta-format approval (studio/approvals/type-<ID>.json: no signature, studio/beta.json\'s by/at, recordedBy opus-1), committed, and done-check (also with the train\'s base, main) then uses "change"; the decisions log says "as beta" (fails on 2.77.2: refused, "a permission line isn\'t a signature", and the title\'s "bug" stood)', () => [
      /is a "bug" task \(from its title\)/.test(before) && ty.status === 0 && /recorded in beta mode by opus-1/.test(out(ty))
        && appr?.signature === null && appr?.beta?.at === betaAt && appr?.beta?.by === 'pat' && appr?.approval?.kind === 'type' && appr.approval.to === 'change' && appr.approval.recordedBy === 'opus-1'
        && /reclassified/.test(committed)
        && /is a "change" task \(set by pat .*\[beta mode, recorded by opus-1, studio\/approvals\/type-/.test(dc) && /is a "change" task/.test(dcMain) && /is a "change" task/.test(shown)
        && logged?.as === 'beta',
      JSON.stringify({ before: before.slice(0, 160), ty: out(ty).slice(0, 500), appr, committed, dc: dc.slice(0, 400), dcMain: dcMain.slice(0, 200), logged })]);

    const vis = task(S, ['visual', t2, 'off', '--by', 'opus-1', '--why', 'only test files change; nothing on screen'], orch(env));
    const vshow = out(task(S, ['visual', t2], env));
    const vdc = doneCheck(S, t2, { ...env, STUDIO_PROTECT_BASE: 'main' });
    const vappr = readIn(S, `studio/approvals/visual-${t2}.json`);
    await guard('2.77.3 (B-111): in beta mode with an owner key, `task visual <ID> off --by opus-1` exits 0, is kept as a beta-format approval (studio/approvals/visual-<ID>.json) and the render-titled task then needs no visual result (task visual and done-check say "visual proof: off ... beta mode") (fails on 2.77.2: refused, so "a render task needs a visual result" stood)', () => [
      vis.status === 0 && vappr?.signature === null && vappr?.approval?.kind === 'visual' && vappr.approval.to === 'off' && /visual proof: off, set by opus-1 for pat in beta mode/.test(vshow) && /visual proof: off, set by opus-1 for pat in beta mode/.test(vdc),
      JSON.stringify({ vis: out(vis).slice(0, 400), vshow: vshow.slice(0, 300), vdc: vdc.slice(0, 400), vappr })]);

    // Never a worker: a builder's shell is refused; a beta-format file dropped in the folder, or committed by a worker,
    // counts for nothing.
    const byBuilder = task(S, ['type', t3, 'change', '--by', 'pat', '--why', 'the builder says this is not a bug'], { ...env, STUDIO_LOCK_OWNER: 'builder-s3' });
    const forged = { approval: { kind: 'type', task: t3, from: 'bug', to: 'docs', title: 'Fix: bug batch 13 - timetable', by: 'pat', why: 'a builder dodging the regression rule', at: new Date().toISOString(), recordedBy: 'opus-1', via: 'beta mode' }, signature: null, beta: { by: 'pat', at: betaAt } };
    writeIn(S, `studio/approvals/type-${t3}.json`, `${JSON.stringify(forged, null, 2)}\n`);
    const dropped = doneCheck(S, t3, env);
    g(S, 'add', `studio/approvals/type-${t3}.json`); g(S, 'commit', '-qm', 'retype', '--no-verify', '--trailer', 'Studio-Agent: builder-s3');
    const byWorker = doneCheck(S, t3, env);
    await guard('2.77.3 (B-111): beta mode never lets a worker approve for itself: a builder\'s shell is refused and writes nothing, and a beta-format type approval dropped in studio/approvals/ (uncommitted), or committed by a worker (Studio-Agent: builder-s3), doesn\'t count (fails on 2.77.2: the dropped file counted, verifyApproval accepted any beta-format file)', () => [
      byBuilder.status !== 0 && !readIn(S, 'studio/task-types.json')?.tasks?.[t3]
        // (the task's type may come from its commits' evidence here; what matters is that the forged record isn't it)
        && !/is a "docs" task/.test(dropped) && /note: .*names T-\d+, but this studio has an owner key/.test(dropped)
        && !/is a "docs" task/.test(byWorker) && /note: .*names T-\d+, but this studio has an owner key/.test(byWorker),
      JSON.stringify({ byBuilder: out(byBuilder).slice(0, 300), dropped: dropped.slice(0, 400), byWorker: byWorker.slice(0, 400) })]);

    // Beta mode off: the beta records stop counting (the owner gates are back).
    writeIn(S, 'studio/beta.json', `${JSON.stringify({ on: false, by: 'pat', at: new Date().toISOString(), why: 'beta over', agents: [], roles: [] }, null, 2)}\n`);
    g(S, 'add', 'studio/beta.json'); g(S, 'commit', '-qm', 'beta off', '--no-verify');
    const offDc = doneCheck(S, t1, env);
    await guard('2.77.3 (B-111): with beta mode off again, the beta-mode reclassification no longer counts and the note says it must be signed or recorded in beta mode; while it was on it did (fails on 2.77.2: nothing was ever recorded, so there was no "change" while beta was on)', () => [
      /\[beta mode, recorded by opus-1/.test(dc) && !/\[beta mode, recorded by/.test(offDc) && /note: .*signed with it .* or recorded in beta mode/.test(offDc),
      offDc.slice(0, 700)]);
  }

  // ---- no beta mode, an owner key the writer's base didn't have: refused up front ----
  {
    const { S, env } = studio('lag');
    g(S, 'update-ref', 'refs/remotes/origin/main', 'HEAD'); // origin/main behind the owner key commit
    writeIn(S, 'studio/keys/owner-ed25519.pub.pem', pem());
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'owner key (not pushed yet)', '--no-verify');
    const t1 = add(S, 'Fix: bug batch 14 - copy', env);
    const t2 = add(S, 'Water shader foam pass two', env);
    const ty = task(S, ['type', t1, 'change', '--by', 'pat', '--permission', 'pat on the crew chat: retype it, UI copy only', '--why', 'UI copy fixes; no sim behaviour to replay'], orch(env));
    const vis = task(S, ['visual', t2, 'off', '--by', 'pat', '--permission', 'pat on the crew chat: no visual for this one', '--why', 'only test files change; nothing on screen'], orch(env));
    const dcMain = doneCheck(S, t1, { ...env, STUDIO_PROTECT_BASE: 'main' });
    await guard('2.77.3 (B-111): outside beta mode, with an owner key on main that origin/main doesn\'t have yet, an outside agent\'s `task type` / `task visual` on permission is refused up front (exit 1, "needs the owner\'s signature", how to get it), nothing is written, and the train\'s reading (base main) agrees: "bug" (fails on 2.77.2: exit 0 "recorded" while the train\'s base saw the key and ignored it)', () => [
      ty.status === 1 && /needs the owner's signature/.test(out(ty)) && /device that holds the key/.test(out(ty)) && /beta -- on/.test(out(ty))
        && vis.status === 1 && /needs the owner's signature/.test(out(vis))
        && !fs.existsSync(path.join(S, 'studio', 'task-types.json')) && /is a "bug" task \(from its title\)/.test(dcMain),
      JSON.stringify({ ty: out(ty).slice(0, 500), vis: out(vis).slice(0, 300), dcMain: dcMain.slice(0, 200) })]);
  }

  // ---- a beta release of a lane held for a protected config proposal decides it ----
  {
    const { S, env } = studio('cfg');
    writeIn(S, 'studio/keys/owner-ed25519.pub.pem', pem());
    writeIn(S, 'studio/protected.json', `${JSON.stringify({ globs: ['studio/locked-2773a.json'] }, null, 2)}\n`);
    writeIn(S, 'studio/locked-2773a.json', `${JSON.stringify({ limit: 1 }, null, 2)}\n`);
    betaOn(S);
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'owner key, protected file, beta on', '--no-verify');
    const r = probe(S, `import fs from 'node:fs'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
import { landConfig, proposalRel } from ${u(S, 'harness/config-proposal.mjs')};
import { releaseLane } from ${u(S, 'harness/train.mjs')};
const root = process.cwd();
const g = (...a) => spawnSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd: root, encoding: 'utf8', windowsHide: true });
const changes = [{ file: 'studio/locked-2773a.json', set: { limit: 9 } }];
fs.mkdirSync(path.join(root, 'studio-proposals'), { recursive: true });
fs.writeFileSync(path.join(root, proposalRel('T-973')), JSON.stringify({ changes, why: 'raise the limit for the test' }, null, 2) + '\\n');
g('add', '-A'); g('commit', '-qm', 'T-973 lands its proposal', '--no-verify');
const head = g('rev-parse', 'HEAD').stdout.trim();
fs.mkdirSync(path.join(root, '.studio', 'train'), { recursive: true });
fs.writeFileSync(path.join(root, '.studio', 'train', 'queue.json'), JSON.stringify([{ task: 'T-973', agent: 'builder-s1', head, branch: 'lane/builder-s1', at: new Date().toISOString(), held: { tier: 'C', why: 'a config proposal for a protected studio file (studio-proposals/): only the owner decides it', at: new Date().toISOString() } }], null, 2));
const rel = releaseLane(root, 'T-973', { by: 'opus-1', env: { ...process.env, STUDIO_LOCK_OWNER: 'opus-1', CLAUDECODE: '1' } });
const released = rel.entry?.released || null;
const ff = (r, main, sha) => { const m = g('merge', '--ff-only', '-q', sha); return { ok: m.status === 0, message: m.stderr }; };
const stale = landConfig(root, { task: 'T-973', main: 'main', ff, by: 'train', released: { ...released, betaAt: '2026-01-01T00:00:00.000Z' } });
const worker = landConfig(root, { task: 'T-973', main: 'main', ff, by: 'train', released: { ...released, recordedBy: 'builder-s1' } });
const after = landConfig(root, { task: 'T-973', main: 'main', ff, by: 'train', released });
const locked = JSON.parse(g('show', 'HEAD:studio/locked-2773a.json').stdout);
console.log(JSON.stringify({ relOk: rel.ok, relMsg: String(rel.message || '').slice(0, 200), released, staleHeld: stale?.held?.length || 0, workerHeld: worker?.held?.length || 0, afterOk: after?.ok, applied: after?.applied, decision: after?.decision, limit: locked.limit }));
`, env);
    await guard('2.77.3 (B-111): in beta mode with an owner key, the orchestrator\'s `train release` of a lane held for a protected config proposal records the beta session (betaAt) and the protected key is applied when it lands (limit 9, decided by "opus-1\'s beta mode release"); a release under an older beta session or recorded by a worker is still held (fails on 2.77.2: released, then the protected part held, "only the owner\'s signed approval")', () => [
      r.j && r.j.relOk === true && r.j.released?.betaAt && r.j.staleHeld > 0 && r.j.workerHeld > 0 && r.j.afterOk === true && r.j.applied?.includes('studio/locked-2773a.json') && /opus-1's beta mode release/.test(r.j.decision || '') && r.j.limit === 9,
      JSON.stringify({ j: r.j, out: out(r).slice(-900) })]);
  }

  // ---- test files are not render files ----
  {
    const { S, env } = studio('render');
    writeIn(S, 'studio/game.json', `${JSON.stringify({ ...(readIn(S, 'studio/game.json') || {}), visualPaths: ['game/toy/src/render/**'] }, null, 2)}\n`);
    const r = probe(S, `import { renderDecision } from ${u(S, 'harness/verdict-split.mjs')};
const t = { id: 'T-974', title: 'Water shader foam pass', role: 'builder' };
const tests = renderDecision({ ...t, changed: ['game/toy/src/render/panel.e2e.test.ts', 'game/toy/src/render/water.spec.mjs', 'game/toy/src/render/tests/foam.mjs', 'game\\\\toy\\\\src\\\\render\\\\sky.e2e.test.ts'] });
const real = renderDecision({ ...t, changed: ['game/toy/src/render/panel.e2e.test.ts', 'game/toy/src/render/water.mjs'] });
const quiet = renderDecision({ ...t, title: 'Port helper for e2e runs', changed: ['game/toy/src/render/panel.e2e.test.ts'] });
console.log(JSON.stringify({ tests: { render: tests.render, why: tests.why, files: tests.renderFiles }, real: { render: real.render, files: real.renderFiles }, quiet: { render: quiet.render, warn: quiet.warn || '' } }));
`, env);
    await guard('2.77.3 (B-111): edits to test files under a render path (panel.e2e.test.ts, *.spec.*, tests/, a Windows path) don\'t make a render-titled task a render task ("no render files changed"), and a non-render title gets no render warning for them; a real render file still does (fails on 2.77.2: panel.e2e.test.ts counted as a render file)', () => [
      r.j && r.j.tests.render === false && /no render files changed/.test(r.j.tests.why || '') && (r.j.tests.files || []).length === 0
        && r.j.real.render === true && JSON.stringify(r.j.real.files) === JSON.stringify(['game/toy/src/render/water.mjs'])
        && r.j.quiet.render === false && r.j.quiet.warn === '',
      JSON.stringify({ j: r.j, out: out(r).slice(-600) })]);
  }

  for (const S of made) { try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch {} }
}
