/**
 * qa/selftest-2771b.mjs — 2.77.1 (helper b): two small bugs from the crew's Windows PC.
 *   H5  a hand-started builder reused an agent name whose lane folder (.lanes/<name>) was still in use; createLaneCopy
 *       refused, but the session started anyway in the shared checkout and sat idle for an hour. A session that needs a
 *       lane copy and can't get one is now refused at once (ok:false, the folder named, no tool process, no claim,
 *       an agent.start_refused event).
 *   M2  `npm run upgrade -- --smoke` ran `task add` without --phase; with a signed Game Bible a build task is refused
 *       without it, so the smoke's "train" step failed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest2771B({ dir, run, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!fs.existsSync(path.join(dir, 'node_modules')) && fs.existsSync(path.join(harnessRoot, 'node_modules'))) {
    try { fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(dir, 'node_modules'), 'junction'); } catch {}
  }
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const gitIn = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const writeIn = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const base = {
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '',
    STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '', STUDIO_COMPACT_OUTPUT: '', STUDIO_VERIFY_DETACH: 'off', STUDIO_VERIFY_RUN: '', STUDIO_HEAVY_SLOTS: '0', STUDIO_GATE_CHANGED: '', STUDIO_GATE_PATHS: '',
    STUDIO_HOOKS_CHECK: 'off', STUDIO_GAME: '', CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', npm_lifecycle_event: '', NODE_OPTIONS: '', npm_config_node_options: '', CI: '', GITHUB_ACTIONS: '', GITHUB_BASE_REF: '',
    STUDIO_TRAIN_MAX_HANDBACKS: '', STUDIO_TRAIN: '', STUDIO_TRAIN_AUTO: '', STUDIO_REHEARSAL: '', STUDIO_WORKTREES: '', STUDIO_LANELESS: '', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-2771b-${process.pid}.pem`), ...ident,
  };
  const nm = path.join(dir, 'node_modules');
  let n = 0;
  const studio = (name, setup = () => {}) => {
    const S = path.join(tmpRoot, `2771b-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    const ev = path.join(S, '.studio', 'events-2771b.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
    setup(S);
    gitIn(S, 'init', '-q', '-b', 'main');
    gitIn(S, 'config', 'core.autocrlf', 'false'); gitIn(S, 'config', 'core.eol', 'lf');
    gitIn(S, 'add', '-A'); gitIn(S, 'commit', '-qm', 'studio', '--no-verify');
    return { S, ev, env: { ...base, AGENT_EVENTS_FILE: ev } };
  };
  const events = (ev) => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const lastJson = (r) => { const t = String(r.stdout || '').trim(); const l = t.split('\n').filter((x) => x.startsWith('{')).pop(); try { return JSON.parse(l); } catch { return { _raw: out(r).slice(-2000) }; } };
  const probe = (S, env, name, code) => {
    const f = path.join(tmpRoot, `probe-2771b-${name}-${process.pid}-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(S, `node "${f}"`, env);
    fs.rmSync(f, { force: true });
    return { ...lastJson(r), _out: out(r).slice(-2500) };
  };
  const u = (S, p) => JSON.stringify(pathToFileURL(path.join(S, p)).href);
  const want = (k) => !process.env.ONLY_2771B || process.env.ONLY_2771B.split(',').includes(k);

  // ---- H5: a leftover lane folder in use refuses the start ----
  if (want('h5')) await guard('2.77.1 (H5): a session whose lane copy can\'t be made (.lanes/<name> still in use) is refused at once: ok:false naming the folder, no tool process, task not claimed, agent.start_refused (fails on 2.77.0: the tool starts in the shared checkout anyway)', async () => {
    const marker = path.join(tmpRoot, `tool-ran-2771b-${process.pid}.txt`);
    const toolJs = path.join(tmpRoot, `fake-tool-2771b-${process.pid}.mjs`);
    fs.writeFileSync(toolJs, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
    const st = studio('h5', (S) => {
      writeIn(S, 'studio/NEXT.md', '# Studio Task Queue\n\n## IN_PROGRESS\n\n## BACKLOG\n- [ ] **T-941** [P1] (`builder`) — made-up task T-941\n\n## DONE\n');
    });
    const { S } = st;
    // The leftover: a git worktree at .lanes/builder-p89a with an uncommitted change (fresh, so it counts as in use).
    const d = path.join(S, '.lanes', 'builder-p89a');
    const w = gitIn(S, 'worktree', 'add', '-q', '-b', 'lane/builder-p89a-old', d, 'main');
    if (w.status !== 0) return [false, `fixture: git worktree add failed: ${out(w)}`];
    writeIn(d, 'half-done.txt', 'uncommitted work\n');
    const nextBefore = fs.readFileSync(path.join(S, 'studio', 'NEXT.md'), 'utf8');
    const env = { ...st.env, STUDIO_AGENT_CMD: `node "${toolJs}"`, STUDIO_LANE_LIVE_MIN: '20' };
    const r = probe(S, env, 'h5', `import fs from 'node:fs';
import { runAgent } from ${u(S, 'harness/agent.mjs')};
import { listLocks } from ${u(S, 'harness/lock.mjs')};
const r = await runAgent({ role: 'builder', agent: 'builder-p89a', tool: 'custom', model: 'test-model', task: 'T-941' });
await new Promise((res) => setTimeout(res, 300));
console.log(JSON.stringify({ ok: r.ok, message: r.message || '', locks: listLocks().map((l) => l.key) }));
`);
    await new Promise((res) => setTimeout(res, 500));
    const ran = fs.existsSync(marker);
    const ev = events(st.ev);
    const refused = ev.filter((e) => e.type === 'agent.start_refused');
    const started = ev.filter((e) => e.type === 'agent.session.start');
    const nextAfter = fs.readFileSync(path.join(S, 'studio', 'NEXT.md'), 'utf8');
    const leftoverKept = fs.existsSync(path.join(d, 'half-done.txt'));
    fs.rmSync(marker, { force: true }); fs.rmSync(toolJs, { force: true });
    const ok = r.ok === false && /\.lanes[\\/]builder-p89a/.test(String(r.message)) && /another agent name/i.test(String(r.message)) && !ran
      && !(r.locks || []).some((k) => /^task:/.test(k)) && nextAfter === nextBefore && refused.length === 1 && started.length === 0 && leftoverKept;
    return [ok, JSON.stringify({ r: { ok: r.ok, message: r.message, locks: r.locks }, ran, refused: refused.length, started: started.length, nextSame: nextAfter === nextBefore, leftoverKept, out: r._out })];
  });

  // ---- M2: the upgrade smoke's task add passes the Bible's rules ----
  if (want('m2')) await guard('2.77.1 (M2): the upgrade smoke\'s train step adds its made-up task in a studio with a signed Game Bible (task add says --phase) (fails on 2.77.0: task add is refused, "Build tasks say which part of the game they are for")', async () => {
    const st = studio('m2', (S) => {
      writeIn(S, 'studio/bible/bible.json', `${JSON.stringify({ signed: { by: 'tester', at: '2026-10-01T00:00:00.000Z' }, phase: { open: 1 }, pillars: [{ name: 'Smoke' }] }, null, 2)}\n`);
    });
    const { S } = st;
    const env = { ...st.env };
    const r = probe(S, env, 'm2', `import { smoke } from ${u(S, 'harness/upgrade-smoke.mjs')};
const r = await smoke({ root: process.cwd(), env: process.env });
console.log(JSON.stringify({ ok: r.ok, items: r.items.map((i) => ({ id: i.id, status: i.status, detail: String(i.detail).slice(0, 400) })) }));
`);
    const train = (r.items || []).find((i) => i.id === 'train');
    // The train step may still fail later for reasons of the machine (e.g. no typescript package for the size check);
    // this check is about the task add: the step got a task id (PASS, or a failure that names one).
    const added = Boolean(train) && !/task add gave no task id/.test(train.detail) && (train.status === 'PASS' || /\bT-\d+\b/.test(train.detail));
    return [added, JSON.stringify({ train, items: r.items, out: r._out })];
  });
}
