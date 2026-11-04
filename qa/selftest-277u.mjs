/**
 * qa/selftest-277u.mjs — 2.77.0 (helper u, P5.1-P5.6 + P9.7): engine passes inside the harness, end to end, with a
 * made-up engine repo and a stand-in editor command (no real engine).
 *   P5.1 feed     an engine pass titled like real work, in the engine's own repo, queues for its train (2.76: refused
 *                 "no changes found" in the studio repo); its engine record survives the event log; a launched pass gets
 *                 a worktree of the engine repo on its branch; the Line Producer holds engine passes on a full rig
 *   P5.2/P9.7     the Line Producer starts the engine train itself: queue -> merge-tree check -> ONE land run (the
 *                 studio's land script, which runs the stand-in editor) -> the task closes; it waits while the web train
 *                 holds its lock and starts after; separate queue, lock and events
 *   P5.3          the land run is a machine:heavy "unity" job; its length is recorded and becomes the expected minutes;
 *                 the quiet-window rules (web train, same kind, RAM floor, CPU, web lanes first unless the engine queue
 *                 waited past the limit); an infrastructure abort stays NOT RUN (nobody handed back)
 *   P5.4          the lane tunes its listed settings itself (logged in the decisions log, undo given); a key outside the
 *                 list is refused as the owner's; its tuned ram-floor and batch flags reach the land run; the owner's
 *                 environment floor wins
 *   P5.5          the visual check: fixed-camera before/after shots, each real thing beside a reference photo (a link is
 *                 refused), the builder looked, a review by someone else (the builder can't grade itself; "toyish"
 *                 blocks), the path line queued for and posted by the Communicator
 *   P5.6          a second engine (made-up "godot") lands on its own train with its own files while the Unity train's
 *                 lock is held
 * Each check fails on 2.76.1.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest277U({ dir, run, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  void harnessRoot;
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const until = (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms && !fn()) nap(100); return fn(); };
  const SLOW = Number(process.env.STUDIO_SELFTEST_SLOW) || (process.platform === 'win32' ? 3 : 1);
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const head = (cwd, ref) => g(cwd, 'rev-parse', ref).stdout.trim();
  const anc = (cwd, a, b) => g(cwd, 'merge-base', '--is-ancestor', a, b).status === 0;
  const write = (b, rel, text) => { fs.mkdirSync(path.dirname(path.join(b, rel)), { recursive: true }); fs.writeFileSync(path.join(b, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const fwd = (p) => p.split(path.sep).join('/');
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = { ...clean, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_HEAVY_SLOTS: '1', STUDIO_HEAVY_POLL_MS: '100', STUDIO_UNITY_TRAIN_RETRIES: '0', STUDIO_UNITY_TRAIN_RETRY_MIN: '0', STUDIO_HOOKS_CHECK: 'off', STUDIO_WEAKENED_TESTS: 'off', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_MACHINE_SCAN: 'off', STUDIO_COMM: '', STUDIO_LINE_PRODUCER: 'on', npm_lifecycle_event: '', NODE_OPTIONS: '', npm_config_node_options: '', ...ident };

  // ---- a PNG of one colour with a stripe (the visual proof decodes real PNGs) ----
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcT[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const png = (file, [r, gg, b], stripe = 0) => {
    const w = 32; const h = 32; const raw = Buffer.alloc((w * 3 + 1) * h);
    for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; const s2 = x < stripe ? 255 : 0; raw[o] = (r + (y * 4)) % 256; raw[o + 1] = (gg + s2) % 256; raw[o + 2] = (b + x * 3) % 256; } }
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
    return file;
  };

  // ---- a studio copy with its own git repo, events file and engine settings ----
  let n = 0;
  const studio = (name, engines) => {
    const S = path.join(tmpRoot, `277u-${name}-${process.pid}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    for (const x of ['.studio/gates', '.studio/locks', '.studio/train', '.studio/agents', '.studio/engine', '.studio/line', '.studio/comm', '.studio/visual-checks', '.studio/proof', '.studio/verify-running', '.studio/supervisor.json', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
    try { fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(S, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'); } catch {}
    const gj = readJson(path.join(S, 'studio', 'game.json')) || {};
    write(S, 'studio/game.json', `${JSON.stringify({ ...gj, engines }, null, 2)}\n`);
    g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
    return S;
  };
  // ---- a made-up engine repo: porters' checkout, the land script's gate worktree on the target ----
  const engineRepo = (name) => {
    const R = path.join(tmpRoot, `277u-${name}-repo-${process.pid}`);
    const GW = path.join(tmpRoot, `277u-${name}-gate-${process.pid}`);
    fs.mkdirSync(R, { recursive: true });
    g(R, 'init', '-q', '-b', 'port/main');
    write(R, 'ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 0000.0.0\n');
    write(R, 'Assets/Rules.cs', 'one\n');
    g(R, 'add', '-A'); g(R, 'commit', '-qm', 'start');
    g(R, 'checkout', '-q', '-b', 'dev');
    g(R, 'worktree', 'add', '-q', GW, 'port/main');
    const branch = (br, file, text) => { g(R, 'checkout', '-q', '-B', br, 'port/main'); write(R, file, text); g(R, 'add', '-A'); g(R, 'commit', '-qm', `${br} work`); g(R, 'checkout', '-q', 'dev'); return head(R, br); };
    return { R, GW, branch };
  };
  // The studio's land script: runs the stand-in editor (a node script) with {flags}, then merges the branches in the
  // gate worktree. Control files: <ctl>-abort (an infrastructure abort), <ctl>-runs.jsonl (what each run saw).
  const landScript = (S, ctl) => {
    const editor = path.join(tmpRoot, `277u-editor-${process.pid}.mjs`);
    fs.writeFileSync(editor, "console.log('[stand-in editor] batchmode run: ' + process.argv.slice(2).join(' ')); console.log('Tests: 3 passed');\n");
    const f = path.join(S, 'tools', 'land', 'land.mjs');
    write(S, 'tools/land/land.mjs', `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const gw = args[0]; const flags = []; const srcs = [];
for (const a of args.slice(1)) (a.startsWith('-') ? flags : srcs).push(a);
const ctl = ${JSON.stringify(ctl)};
const locks = ${JSON.stringify(path.join(S, '.studio', 'locks'))};
let heavy = [];
try { heavy = fs.readdirSync(locks).filter((x) => /^machine-heavy-\\d+\\.lock$/.test(x)).map((x) => { try { const j = JSON.parse(fs.readFileSync(locks + '/' + x, 'utf8')); return { label: j.label, kind: j.claim?.kind || null }; } catch { return {}; } }); } catch {}
fs.appendFileSync(ctl + '-runs.jsonl', JSON.stringify({ srcs, flags, heavy, tune: process.env.STUDIO_ENGINE_TUNE || '', engine: process.env.STUDIO_ENGINE || '' }) + '\\n');
const ed = spawnSync(process.execPath, [${JSON.stringify(editor)}, '-batchmode', ...flags], { encoding: 'utf8', windowsHide: true });
process.stdout.write(ed.stdout || '');
if (fs.existsSync(ctl + '-abort')) { console.log('Out of memory: Aborting batchmode'); process.exit(1); }
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd: gw, encoding: 'utf8', windowsHide: true });
for (const s of srcs) { const m = git('merge', '--no-ff', '-m', 'land ' + s, s); if (m.status !== 0) { git('merge', '--abort'); console.log('conflict ' + s); process.exit(2); } }
console.log('landed ' + srcs.join(' '));
process.exit(0);
`);
    return f;
  };
  const engineCfg = (E, S, ctl) => ({ land: `node "${fwd(landScript(S, ctl))}" "${fwd(E.GW)}" {flags} {branch}`, landMany: `node "${fwd(path.join(S, 'tools', 'land', 'land.mjs'))}" "${fwd(E.GW)}" {flags} {branches}`, target: 'port/main', cwd: fwd(E.R), gateWorktree: fwd(E.GW), timeoutMin: 5 });
  const envOf = (S, extra = {}) => ({ ...base, AGENT_EVENTS_FILE: path.join(S, '.studio', 'events-277u.jsonl'), ...extra });
  const task = (S, cmd, env = {}) => run(S, `node harness/task.mjs ${cmd}`, envOf(S, env));
  const idOf = (r) => (String(r.stdout).match(/"id":\s*"(T-\d+)"/) || [])[1];
  const isDone = (S, id) => { try { return new RegExp(`\\*\\*${id}\\*\\*`).test(fs.readFileSync(path.join(S, 'studio', 'DONE.md'), 'utf8')); } catch { return false; } };
  const probe = (S, name, code, env = {}) => {
    const f = path.join(S, `.probe-277u-${name}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(S, `node ${path.basename(f)}`, envOf(S, env));
    try { fs.rmSync(f, { force: true }); } catch {}
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return JSON.parse(line); } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const mod = (S, m) => JSON.stringify(pathToFileURL(path.join(S, 'harness', m)).href);
  const runs = (ctl) => { try { return fs.readFileSync(`${ctl}-runs.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

  // ================= P5.1 feed + P5.2/P5.3 the Line Producer starts the train beside the web train ==================
  {
    const E = engineRepo('u');
    const ctl = path.join(tmpRoot, `277u-u-${process.pid}`);
    const S = studio('feed', {});
    const cfg = engineCfg(E, S, ctl);
    write(S, 'studio/game.json', `${JSON.stringify({ ...(readJson(path.join(S, 'studio', 'game.json')) || {}), engines: { unity: cfg } }, null, 2)}\n`);
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'engine settings', '--no-verify');
    const add = task(S, 'add "Pass 2: hangar doors open on the stand" --role engine-porter --track engine:unity --branch unity/pass-2 --scope "Assets/Hangar" --size 2');
    const id = idOf(add);
    task(S, `start ${id} --agent porter-277u`);
    const h2 = E.branch('unity/pass-2', 'Assets/Hangar/Doors.cs', 'doors\n');
    const done = task(S, `done ${id} --agent porter-277u --train`);
    const q = readJson(path.join(S, '.studio', 'train', 'unity-queue.json')) || [];
    const rec = readJson(path.join(S, '.studio', 'engine', 'tasks.json')) || {};
    await guard('277u P5.1 feed: an engine pass titled like real work ("Pass 2: …", a change task) whose work is on unity/pass-2 in the engine\'s own repo passes task done --train and is queued for the Unity train; its engine record (.studio/engine/tasks.json) keeps the engine, branch and scope (fails on 2.76.1: refused "Changes exist for this task: no changes found" in the studio repo, no record)', () => [
      done.status === 0 && q.length === 1 && q[0].task === id && q[0].branch === 'unity/pass-2' && q[0].head === h2 && rec[id]?.engine === 'unity' && rec[id]?.branch === 'unity/pass-2' && rec[id]?.scope === 'Assets/Hangar',
      JSON.stringify({ add: out(add).slice(-300), done: out(done).slice(-1500), q, rec }).slice(0, 3000)]);

    // The record outlives the event log: a fresh events file, and the task is still on the Unity track with its branch.
    const tr = probe(S, 'track', `const g = await import(${mod(S, 'unity-gate.mjs')}); console.log(JSON.stringify({ track: g.taskTrack(${JSON.stringify(id)}), branch: g.taskBranch(${JSON.stringify(id)}) }));`, { AGENT_EVENTS_FILE: path.join(S, '.studio', 'events-277u-empty.jsonl') });
    await guard('277u P5.1 record: with the task.added event gone from the event log, the task keeps its track (engine:unity) and its branch from its engine record (fails on 2.76.1: the track came only from the last 20000 events: null, so it closed as a web task)', () => [tr.track === 'engine:unity' && tr.branch === 'unity/pass-2', JSON.stringify(tr)]);

    // The web train runs (its lock is held by a live process: this test's): the Line Producer leaves the engine train waiting.
    write(S, '.studio/locks/train.lock', JSON.stringify({ pid: process.pid, at: Date.now(), id: 'web-277u', by: 'train' }));
    const lp = (env = {}) => probe(S, 'lp', `const lp = await import(${mod(S, 'line-producer.mjs')});
const rows = await lp.enginePass({ deps: { rigBudget: async () => ({ running: [], freeGb: 20 }), machine: { cpu: { busy: 0.1 } } } });
console.log(JSON.stringify({ rows }));`, env);
    const waiting = lp();
    const stillQueued = (readJson(path.join(S, '.studio', 'train', 'unity-queue.json')) || []).length === 1 && !fs.existsSync(path.join(S, '.studio', 'locks', 'unity-train.lock'));
    fs.rmSync(path.join(S, '.studio', 'locks', 'train.lock'), { force: true });
    const started = lp();
    const landed = until(() => isDone(S, id) && (readJson(path.join(S, '.studio', 'train', 'unity-queue.json')) || []).length === 0 && /task\.train\.unity\.done/.test((() => { try { return fs.readFileSync(path.join(S, '.studio', 'events-277u.jsonl'), 'utf8'); } catch { return ''; } })()) && !fs.existsSync(path.join(S, '.studio', 'locks', 'unity-train.lock')), 60000 * SLOW);
    const rs = runs(ctl);
    const tip = head(E.R, 'port/main');
    const dur = readJson(path.join(S, '.studio', 'engine', 'durations.json')) || {};
    const actions = (() => { try { return fs.readFileSync(path.join(S, '.studio', 'line', 'actions.jsonl'), 'utf8'); } catch { return ''; } })();
    const evs = (() => { try { return fs.readFileSync(path.join(S, '.studio', 'events-277u.jsonl'), 'utf8'); } catch { return ''; } })();
    await guard('277u P5.2/P9.7 train: while the web train holds .studio/locks/train.lock the Line Producer leaves the queued Unity branch waiting ("the web train is running"); once it is free it starts the Unity train itself (a detached task train --engine unity): ONE land run of the studio\'s land script (which ran the stand-in editor), port/main contains the branch, the task closes, the queue empties; the start is logged (.studio/line/actions.jsonl) (fails on 2.76.1: no enginePass; the queue waited for a person)', () => [
      waiting.rows?.[0]?.start === false && /web train is running/.test(waiting.rows?.[0]?.why || '') && stillQueued && started.rows?.[0]?.started === true && landed && rs.length === 1 && rs[0].srcs.join() === 'unity/pass-2'
        && anc(E.R, h2, tip) && (readJson(path.join(S, '.studio', 'train', 'unity-queue.json')) || []).length === 0 && /engine-train/.test(actions) && /task\.train\.unity\.landed/.test(evs),
      JSON.stringify({ waiting, started, landed, rs, log: (() => { try { return fs.readFileSync(path.join(S, '.studio', 'line', 'unity-train.log'), 'utf8').slice(-1500); } catch { return ''; } })() }).slice(0, 3000)]);
    await guard('277u P5.3 heavy: the land run held machine:heavy as a "unity" job (the land script saw its holder), and its length was recorded (.studio/engine/durations.json, status pass), so the expected minutes now come from the recorded runs (fails on 2.76.1: no durations)', () => {
      const e = probe(S, 'exp', `const et = await import(${mod(S, 'engine-tracks.mjs')}); console.log(JSON.stringify(et.expectedMinutes('unity')));`);
      return [rs[0]?.heavy?.some((x) => x.kind === 'unity') && dur.unity?.length === 1 && dur.unity[0].status === 'pass' && dur.unity[0].ms > 0 && e.n === 1 && /median/.test(e.from || ''), JSON.stringify({ heavy: rs[0]?.heavy, dur, e })];
    });

    // P5.1 launch: a second pass gets its own worktree of the engine repo on its (new) branch.
    const add3 = task(S, 'add "Pass 3: apron lights" --role engine-porter --track engine:unity --branch unity/pass-3');
    const id3 = idOf(add3);
    const la = probe(S, 'launch', `const et = await import(${mod(S, 'engine-tracks.mjs')}); const r = et.engineLaunch({ task: ${JSON.stringify(id3)}, agent: 'porter-b' }); console.log(JSON.stringify(r));`);
    const wtBranch = la.dir ? spawnSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: la.dir, encoding: 'utf8', windowsHide: true }).stdout.trim() : '';
    const sup = probe(S, 'hold', `import fs from 'node:fs';
fs.mkdirSync(${JSON.stringify(path.join(S, '.studio', 'line'))}, { recursive: true });
fs.writeFileSync(${JSON.stringify(path.join(S, '.studio', 'line', 'status.json'))}, JSON.stringify({ at: new Date().toISOString(), mode: 'on', order: [], builders: { rigCap: 2, why: 'test' }, chainBreakers: [] }));
const lp = await import(${mod(S, 'line-producer.mjs')});
console.log(JSON.stringify({ rigCap: lp.supervisorPlan({})?.rigCap ?? null }));`);
    const supText = fs.readFileSync(path.join(S, 'harness', 'supervisor.mjs'), 'utf8');
    await guard('277u P5.1 launch: a launched engine pass gets a worktree of the engine repo on its branch (made from the target: .lanes/engine/<T>, the note for its prompt names it and task done --train), and the supervisor holds new engine-porter sessions at the Line Producer\'s rig cap with the builders (fails on 2.76.1: no engine worktree; porters not counted)', () => [
      la.dir && fs.existsSync(la.dir) && wtBranch === 'unity/pass-3' && la.created === true && /done .* --train/.test(la.note || '') && /\.lanes\/engine\//.test(fwd(la.dir)) && anc(E.R, 'port/main', 'unity/pass-3') && sup.rigCap === 2 && /engine-porter: the Line Producer holds new engine passes/.test(supText),
      JSON.stringify({ la, wtBranch, sup }).slice(0, 2000)]);
    try { g(E.R, 'worktree', 'remove', '--force', la.dir); } catch {}

    // NOT RUN: an infrastructure abort is not red: nobody is handed back, the branch stays queued.
    const add4 = task(S, 'add "Pass 4: taxiway signs" --role engine-porter --track engine:unity --branch unity/pass-4');
    const id4 = idOf(add4);
    task(S, `start ${id4} --agent porter-277u-4`);
    E.branch('unity/pass-4', 'Assets/Signs.cs', 'signs\n');
    const d4 = task(S, `done ${id4} --agent porter-277u-4 --train`);
    fs.writeFileSync(`${ctl}-abort`, '1');
    const tr4 = task(S, 'train --engine unity --by producer-277u');
    fs.rmSync(`${ctl}-abort`, { force: true });
    const q4 = readJson(path.join(S, '.studio', 'train', 'unity-queue.json')) || [];
    await guard('277u P5.3 not run: a land run that aborted for memory ("Out of memory: Aborting batchmode", no failing test) is NOT RUN: the task is not handed back, its branch stays queued (2.73.2 B-73 kept on the engine train)', () => [
      d4.status === 0 && /not.run|notRun|did not run/i.test(out(tr4)) && q4.some((e) => e.task === id4) && !isDone(S, id4) && !/task\.train\.unity\.dropped/.test((() => { try { return fs.readFileSync(path.join(S, '.studio', 'events-277u.jsonl'), 'utf8'); } catch { return ''; } })()),
      out(tr4).slice(-1500)]);
    fs.rmSync(S, { recursive: true, force: true });
  }

  // ================= P5.3 the quiet window (pure) ======================================================================
  {
    const S = studio('window', {});
    const r = probe(S, 'win', `const lp = await import(${mod(S, 'line-producer.mjs')});
const now = Date.now();
const f = { engine: 'unity', label: 'Unity', heavyKind: 'unity', queued: 1, oldestAt: new Date(now - 10 * 60000).toISOString(), running: false, startedRecently: 0, auto: true, webTrain: false, webQueued: 0, heavy: [], freeGb: 20, floorGb: 12, floorFrom: 'x', cpuBusy: 0.2, expectedMin: 26, now };
const w = (patch, env = {}) => lp.engineWindow({ ...f, ...patch }, env);
console.log(JSON.stringify({
  open: w({}), web: w({ webTrain: true }), kind: w({ heavy: [{ kind: 'unity', label: 'unity land (T-9)' }] }), ram: w({ freeGb: 9 }), cpu: w({ cpuBusy: 0.9 }),
  lanes: w({ webQueued: 2 }), starved: w({ webQueued: 2, oldestAt: new Date(now - 200 * 60000).toISOString() }), off: w({ auto: false }), none: w({ queued: 0 }),
}));`);
    await guard('277u P5.3 window: the engine train starts only in a quiet window (one land run ~26 min): not while the web train runs, nor beside another Unity job, nor under the RAM floor (9 < 12 GB), nor at 90% CPU, nor while web lanes wait (the web train goes first) unless the engine queue waited past STUDIO_ENGINE_TRAIN_MAX_WAIT_MIN; trainAuto off leaves it to a person (fails on 2.76.1: no engineWindow)', () => [
      r.open?.start === true && /~26 min/.test(r.open.why) && r.web?.start === false && /web train/.test(r.web.why) && r.kind?.start === false && /unity land/.test(r.kind.why) && r.ram?.start === false && /under the Unity floor/.test(r.ram.why) && r.cpu?.start === false && /CPU 90%/.test(r.cpu.why)
        && r.lanes?.start === false && /goes first/.test(r.lanes.why) && r.starved?.start === true && r.off?.start === false && r.off.wait === false && r.none?.start === false,
      JSON.stringify(r).slice(0, 2500)]);
    fs.rmSync(S, { recursive: true, force: true });
  }

  // ================= P5.4 self-tuning ==================================================================================
  {
    const E = engineRepo('t');
    const ctl = path.join(tmpRoot, `277u-t-${process.pid}`);
    const S = studio('tune', {});
    write(S, 'studio/game.json', `${JSON.stringify({ ...(readJson(path.join(S, 'studio', 'game.json')) || {}), engines: { unity: engineCfg(E, S, ctl) } }, null, 2)}\n`);
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'engine settings', '--no-verify');
    const eng = (cmd, env = {}) => run(S, `node harness/engine.mjs ${cmd}`, envOf(S, env));
    const t1 = eng('tune unity lod-bias 1.5 --by porter-t --why "less pop-in on the apron"');
    const t2 = eng('tune unity batch-flags "-nographics -stripEngineCode" --by porter-t --why "faster land runs"');
    const t3 = eng('tune unity ram-floor 3 --by porter-t --why "the slice needs less"');
    const bad = eng('tune unity target main --by porter-t --why "try the owner key"');
    const badVal = eng('tune unity batch-flags "-x;rm" --by porter-t --why "shell chars"');
    const dec = (() => { try { return fs.readFileSync(path.join(S, '.studio', 'decisions.jsonl'), 'utf8'); } catch { return ''; } })();
    const tuneFile = readJson(path.join(S, 'studio', 'engine', 'unity-tune.json')) || {};
    const prot = readJson(path.join(S, 'studio', 'protected.json'))?.globs || [];
    // The tuned floor (3 GB) holds a land run back on a machine with 1 GB free: NOT RUN (ram-floor); the owner's env floor (0) wins.
    const add = task(S, 'add "Pass 5: fog volume" --role engine-porter --track engine:unity --branch unity/pass-5');
    const id = idOf(add);
    E.branch('unity/pass-5', 'Assets/Fog.cs', 'fog\n');
    const tunedEnv = { STUDIO_UNITY_MIN_FREE_GB: '', STUDIO_TEST_FREEMEM_MB: '1000', STUDIO_HEAVY_WAIT_MIN: '0', STUDIO_RAM_FLOOR_GB: '0' };
    const gate1 = run(S, `node harness/unity-gate.mjs --json --task ${id}`, envOf(S, tunedEnv));
    const gate2 = run(S, `node harness/unity-gate.mjs --json --task ${id}`, envOf(S, { ...tunedEnv, STUDIO_UNITY_MIN_FREE_GB: '0' }));
    const j1 = (() => { try { return JSON.parse(String(gate1.stdout).trim().split('\n').pop()); } catch { return {}; } })();
    const j2 = (() => { try { return JSON.parse(String(gate2.stdout).trim().split('\n').pop()); } catch { return {}; } })();
    const rs = runs(ctl);
    await guard('277u P5.4 tune: the Unity lane sets lod-bias, batch-flags and ram-floor itself (studio/engine/unity-tune.json, not a protected file), each logged in the decisions log (action engine-tune, with an undo); a key outside the list (target) is refused as the owner\'s and bad flags are refused; the tuned 3 GB floor holds a land run back on 1 GB free (NOT RUN ram-floor, the land script never ran) while the owner\'s STUDIO_UNITY_MIN_FREE_GB=0 wins; the run that ran got {flags} and STUDIO_ENGINE_TUNE (fails on 2.76.1: no tune command)', () => [
      t1.status === 0 && t2.status === 0 && t3.status === 0 && bad.status !== 0 && /only the owner/.test(out(bad)) && badVal.status !== 0
        && (dec.match(/"action":"engine-tune"/g) || []).length === 3 && /"undo":\{"kind":"engine-tune"/.test(dec) && tuneFile.values?.['lod-bias'] === 1.5 && !prot.some((p) => /studio\/engine/.test(p))
        && j1.status === 'not-run' && j1.infra?.kind === 'ram-floor' && j2.status === 'pass' && rs.length === 1 && rs[0].flags.join(' ') === '-nographics -stripEngineCode' && JSON.parse(rs[0].tune || '{}')['lod-bias'] === 1.5,
      JSON.stringify({ t: [out(t1), out(t2), out(t3)].map((x) => x.slice(-200)), bad: out(bad).slice(-300), j1, j2, rs }).slice(0, 3000)]);
    fs.rmSync(S, { recursive: true, force: true });
  }

  // ================= P5.5 the visual check ============================================================================
  {
    const E = engineRepo('v');
    const ctl = path.join(tmpRoot, `277u-v-${process.pid}`);
    const S = studio('visual', {});
    write(S, 'studio/game.json', `${JSON.stringify({ ...(readJson(path.join(S, 'studio', 'game.json')) || {}), engines: { unity: engineCfg(E, S, ctl) } }, null, 2)}\n`);
    png(path.join(S, 'assets', 'reference', 'hangar.png'), [90, 90, 90], 4);
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'engine settings', '--no-verify');
    const add = task(S, 'add "Pass 6: realism pass on the hangar" --role engine-porter --track engine:unity --branch unity/pass-6 --visual-check --refs hangar.png');
    const id = idOf(add);
    task(S, `start ${id} --agent porter-v`);
    E.branch('unity/pass-6', 'Assets/Hangar.cs', 'hangar\n');
    const vis = (cmd, env = {}) => run(S, `node harness/visual-proof.mjs ${cmd}`, envOf(S, env));
    const dc = () => run(S, `node harness/done-check.mjs ${id}`, envOf(S));
    const d0 = task(S, `done ${id} --agent porter-v --train`);
    const shotsDir = path.join(tmpRoot, `277u-shots-${process.pid}`);
    png(path.join(shotsDir, 'before', 'apron.png'), [10, 40, 80], 0);
    png(path.join(shotsDir, 'after', 'apron.png'), [120, 40, 80], 20);
    png(path.join(shotsDir, 'hangar-in-game.png'), [80, 80, 80], 8);
    const s1 = vis(`shots ${id} --before "${fwd(path.join(shotsDir, 'before', 'apron.png'))}" --after "${fwd(path.join(shotsDir, 'after', 'apron.png'))}" --by porter-v`);
    const link = vis(`asset ${id} --name "hangar" --shot "${fwd(path.join(shotsDir, 'hangar-in-game.png'))}" --ref https://example.invalid/hangar.jpg --by porter-v`);
    const a1 = vis(`asset ${id} --name "hangar" --shot "${fwd(path.join(shotsDir, 'hangar-in-game.png'))}" --ref hangar.png --by porter-v`);
    const self = vis(`review ${id} --by porter-v --score real --notes "looks right to me, I built it"`);
    const toy = vis(`review ${id} --by reviewer-v --score toyish --notes "roof trusses are cartoon-thick next to the photo"`);
    const dToy = dc();
    const looked = vis(`looked ${id} --by porter-v --note "trusses look heavy against the reference; doors fine"`);
    const real = vis(`review ${id} --by reviewer-v --score real --notes "after the rework it matches the photo's proportions"`);
    const dReal = dc();
    const d1 = task(S, `done ${id} --agent porter-v --train`);
    const notices = (() => { try { return fs.readFileSync(path.join(S, '.studio', 'comm', 'notices.jsonl'), 'utf8'); } catch { return ''; } })();
    const comm = probe(S, 'comm', `const c = await import(${mod(S, 'communicator.mjs')}); const r = await c.communicatorPass({ dryRun: true, deps: { events: [], needs: [], beta: { on: false }, machine: null, delegated: false } }); console.log(JSON.stringify({ kind: r.kind, text: r.text }));`);
    const page = path.join(S, '.studio', 'visual-checks', id, 'side-by-side.html');
    const pageText = fs.existsSync(page) ? fs.readFileSync(page, 'utf8') : '';
    await guard('277u P5.5 visual: a pass added with --visual-check --refs is refused at done --train until the visual check is on record (fails on 2.76.1: refused for "no changes found" instead, no visual rows)', () => [d0.status !== 0 && /Fixed-camera before\/after screenshots/.test(out(d0)) && !/no changes found/.test(out(d0)), out(d0).slice(-1500)]);
    await guard('277u P5.5 review: fixed-camera shots recorded, a link as the reference photo refused (the harness never downloads), the asset beside the studio\'s photo, the builder can\'t grade its own pass, a reviewer\'s "toyish" blocks done with its notes, the builder must say it looked, then "real" from the reviewer passes every visual row and done --train queues it; the side-by-side page shows both pictures; the path line is queued and the Communicator posts it (untagged) (fails on 2.76.1: no visual check)', () => [
      s1.status === 0 && link.status !== 0 && /never downloads/.test(out(link)) && a1.status === 0 && self.status !== 0 && /can't grade its own/.test(out(self)) && toy.status === 0
        && dToy.status !== 0 && /looks toyish: roof trusses/.test(out(dToy)) && /hasn't said it looked/.test(out(dToy)) && looked.status === 0 && real.status === 0 && dReal.status === 0 && d1.status === 0
        && /hangar-in-game|hangar\.png/.test(pageText) && /assets\/reference\/hangar\.png/.test(pageText) && /Shots for T-\d+/.test(notices) && /side-by-side\.html/.test(notices) && /notices|status/.test(comm.kind || '') && /Studio notice/.test(comm.text || '') && /side-by-side\.html/.test(comm.text || '') && !/<@/.test(comm.text || ''),
      JSON.stringify({ s1: out(s1).slice(-200), link: out(link).slice(-200), a1: out(a1).slice(-200), self: out(self).slice(-200), dToy: out(dToy).slice(-900), dReal: out(dReal).slice(-600), d1: out(d1).slice(-500), comm }).slice(0, 3000)]);
    fs.rmSync(S, { recursive: true, force: true });
  }

  // ================= P5.6 a second engine, its own train =============================================================
  {
    const E = engineRepo('gd');
    const ctl = path.join(tmpRoot, `277u-gd-${process.pid}`);
    const S = studio('generic', {});
    write(S, 'studio/game.json', `${JSON.stringify({ ...(readJson(path.join(S, 'studio', 'game.json')) || {}), engines: { godot: engineCfg(E, S, ctl) } }, null, 2)}\n`);
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'engine settings', '--no-verify');
    const add = task(S, 'add "Pass 1: port the dock rules" --role engine-porter --track engine:godot --branch godot/dock');
    const id = idOf(add);
    task(S, `start ${id} --agent porter-gd`);
    const h = E.branch('godot/dock', 'sim/dock.gd', 'dock\n');
    const done = task(S, `done ${id} --agent porter-gd --train`);
    const q = readJson(path.join(S, '.studio', 'train', 'godot-queue.json')) || [];
    // The Unity train's lock is held by a live process: the godot train still runs (separate locks).
    write(S, '.studio/locks/unity-train.lock', JSON.stringify({ pid: process.pid, at: Date.now(), id: 'unity-277u', by: 'x', lanes: [] }));
    const tr = task(S, 'train --engine godot --by producer-277u');
    const rs = runs(ctl);
    const evs = (() => { try { return fs.readFileSync(path.join(S, '.studio', 'events-277u.jsonl'), 'utf8'); } catch { return ''; } })();
    const list = run(S, 'node harness/engine.mjs targets --json', envOf(S));
    let targets = [];
    try { targets = JSON.parse(list.stdout); } catch {}
    await guard('277u P5.6 generic: a made-up second engine ("godot", studio/game.json engines.godot) gets the same pattern from the engine table: --track engine:godot queues on godot-queue.json, train --engine godot lands it on ONE land run with STUDIO_ENGINE=godot while the Unity train\'s lock is held, task.train.godot.* events, the task closes; engine targets lists its rig cost (heavy kind, RAM, minutes) (fails on 2.76.1: an engine:godot task took the studio path and there was no godot train)', () => [
      done.status === 0 && q.length === 1 && q[0].branch === 'godot/dock' && tr.status === 0 && rs.length === 1 && rs[0].engine === 'godot' && anc(E.R, h, head(E.R, 'port/main')) && isDone(S, id)
        && /task\.train\.godot\.landed/.test(evs) && fs.existsSync(path.join(S, '.studio', 'locks', 'unity-train.lock')) && targets.some((t) => t.name === 'godot' && t.land && t.heavyKind === 'heavy' && t.rig?.ramGb === 3 && t.expected?.minutes > 0),
      JSON.stringify({ done: out(done).slice(-800), q, tr: out(tr).slice(-800), rs, targets }).slice(0, 3000)]);
    fs.rmSync(S, { recursive: true, force: true });
  }
}
