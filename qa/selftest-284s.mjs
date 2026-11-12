/**
 * qa/selftest-284s.mjs — 2.84 (s): one harness-owned engine editor that stays open (harness/editor-service.mjs), used
 * for warm land runs and for the agents' compile + capture queue. UNTESTED on a real editor: every check here runs
 * against a stand-in editor (qa/fixtures/fake-editor.mjs) speaking the same file protocol, pointed at through
 * STUDIO_UNITY, the setting the harness uses for the editor's path.
 *
 * The scaffolding (a studio copy, a made-up engine repo, a stand-in land script) follows qa/selftest-284t.mjs.
 * Every editor the harness starts here is killed in the finally at the end (pids from each project's start log).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest284S({ dir, root, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const write = (b, rel, text) => { fs.mkdirSync(path.dirname(path.join(b, rel)), { recursive: true }); fs.writeFileSync(path.join(b, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3000)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 3000)); } };
  const fwd = (p) => p.split(path.sep).join('/');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // A process that ended after the probe that started it exited may linger as a zombie (Linux): that is not alive.
  const zombie = (pid) => { if (process.platform !== 'linux') return false; try { const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return st.slice(st.lastIndexOf(')') + 2).startsWith('Z'); } catch { return false; } };
  const alive = (pid) => { try { process.kill(pid, 0); return !zombie(pid); } catch (e) { return e.code === 'EPERM'; } };
  const T = path.join(tmpRoot, `s284s-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const harnessRoot = root || dir;
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '0.03', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off',
    STUDIO_HEAVY_SLOTS: '1', STUDIO_UNITY_TRAIN_RETRIES: '0', STUDIO_UNITY_TRAIN_RETRY_MIN: '0', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off',
    STUDIO_ENGINE_FULL_LAND_HOURS: 'off', STUDIO_ENGINE_KILLED_RETRY_SEC: '0', STUDIO_UNITY_EDITMODE_PLAN: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-284s-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };

  // ---- a studio copy ----
  const S = path.join(tmpRoot, `284s-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  try { fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(S, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { /* the checks below need no package */ }
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const setEngines = (engines) => write(S, 'studio/game.json', `${JSON.stringify({ engines }, null, 2)}\n`);
  setEngines({});
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const FAKE = path.join(S, 'qa', 'fixtures', 'fake-editor.mjs');
  const evFile = path.join(S, '.studio', 'events-284s.jsonl');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, STUDIO_UNITY: FAKE, ...extra });
  const events = () => { try { return fs.readFileSync(evFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  let pn = 0;
  const probe = (code, env = {}) => {
    const f = path.join(S, `.probe-284s-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: envOf(env), encoding: 'utf8', timeout: 180000 });
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(l), _out: out(r).slice(-1500) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const cli = (args, env = {}, cwd = S) => {
    const r = spawnSync(process.execPath, [path.join(S, 'harness', 'editor-service.mjs'), ...args], { windowsHide: true, cwd, env: envOf(env), encoding: 'utf8', timeout: 120000 });
    let json = null;
    try { json = JSON.parse(String(r.stdout || '').trim()); } catch { /* text output */ }
    return { status: r.status, json, text: out(r) };
  };
  const ES = u('harness/editor-service.mjs');
  // Fast settings for the stand-in editor: a beat every 0.1 s, a request timeout of 1.8 s, a start timeout of 12 s.
  const fast = (extra = {}) => ({ heartbeatSec: 0.1, requestTimeoutMin: 0.03, startTimeoutMin: 0.2, graceSec: 0.5, recycleAfter: 20, recycleMin: 240, ...extra });
  const projects = [];
  const project = (name) => { const p = path.join(T, name); fs.mkdirSync(path.join(p, 'Assets'), { recursive: true }); projects.push(p); return p; };
  const starts = (p) => { try { return fs.readFileSync(path.join(p, '.fake-editor-starts'), 'utf8').split('\n').filter(Boolean).map(Number); } catch { return []; } };
  const ctl = (p, v) => fs.writeFileSync(path.join(p, '.fake-editor.json'), JSON.stringify(v));
  const decoys = [];

  try {
    // ================= 0. the two sides speak the same protocol =================
    const cs = fs.readFileSync(path.join(S, 'engine', '_unity', 'Assets', 'Editor', 'StudioService', 'StudioEditorService.cs'), 'utf8');
    const asm = JSON.parse(fs.readFileSync(path.join(S, 'engine', '_unity', 'Assets', 'Editor', 'StudioService', 'StudioService.Editor.asmdef'), 'utf8'));
    const esSrc = fs.readFileSync(path.join(S, 'harness', 'editor-service.mjs'), 'utf8');
    const { PROTOCOL_FIELDS, KINDS } = await import(pathToFileURL(path.join(S, 'harness', 'editor-service.mjs')).href);
    const missing = [];
    for (const [grp, names] of Object.entries(PROTOCOL_FIELDS)) for (const n of names) {
      const inCs = grp === 'args' ? cs.includes(`"${n}"`) : n === 'out' ? /\bpublic string @out\b/.test(cs) : new RegExp(`\\b${n}\\b`).test(cs);
      if (!inCs) missing.push(`C#:${grp}.${n}`);
      if (!esSrc.includes(n)) missing.push(`js:${grp}.${n}`);
    }
    for (const k of KINDS) if (!cs.includes(`case "${k}"`)) missing.push(`C# kind ${k}`);
    const csproj = ['SimTests', 'SimCli'].map((n) => fs.readFileSync(path.join(S, 'engine', '_unity', 'tools', n, `${n}.csproj`), 'utf8')).join('\n');
    await guard('2.84 (s) the editor service\'s C# side is in the Unity template, Editor-only (under Assets/Editor/, its own assembly with includePlatforms Editor, the code inside #if UNITY_EDITOR), says it is untested on a real editor, acts only with -studioService, the .NET projects do not compile it, and every protocol field and request kind is spelled the same in the C# and in harness/editor-service.mjs (fails before this change: there was no editor service)', () => [
      missing.length === 0 && /#if UNITY_EDITOR/.test(cs) && /UNTESTED ON A REAL EDITOR/.test(cs) && /\[InitializeOnLoad\]/.test(cs) && /Arg\("-studioService"\)/.test(cs) && /if \(string\.IsNullOrEmpty\(Folder\)\) return;/.test(cs)
        && JSON.stringify(asm.includePlatforms) === '["Editor"]' && !/Assets\/Editor/.test(csproj) && !/Assets\/\*\*/.test(csproj),
      JSON.stringify({ missing, asm })]);

    // The service's assembly references the test runner, but holds no test: the Edit Mode plan must not change.
    const tpl = path.join(T, 'tpl-copy');
    fs.cpSync(path.join(S, 'engine', '_unity'), tpl, { recursive: true });
    const tplBare = path.join(T, 'tpl-bare');
    fs.cpSync(tpl, tplBare, { recursive: true });
    fs.rmSync(path.join(tplBare, 'Assets', 'Editor', 'StudioService'), { recursive: true, force: true });
    const plan = probe(`import { editModePlan, testSources } from ${u('harness/unity.mjs')};
const a = editModePlan(${JSON.stringify(tpl)}), b = editModePlan(${JSON.stringify(tplBare)});
console.log(JSON.stringify({ a: { args: a.args, skip: a.skip, names: a.assemblies.map((x) => x.name) }, b: { args: b.args, skip: b.skip, names: b.assemblies.map((x) => x.name) }, edit: testSources(${JSON.stringify(tpl)}).EditMode.map((f) => f.replace(/\\\\/g, '/')) }));`);
    await guard('2.84 (s) the editor service\'s assembly (StudioService.Editor, which references the test runner to run tests on request) is not taken for a test assembly: the template\'s Edit Mode plan is the same with and without it, and no StudioService source is an Edit Mode test source (fails before this fix: the plan named StudioService.Editor as an Edit Mode assembly to run, so a land script would have run no test at all)', () => [
      plan.a && JSON.stringify(plan.a) === JSON.stringify(plan.b) && !plan.a.names.includes('StudioService.Editor') && !plan.edit.some((f) => /StudioService/.test(f)), JSON.stringify(plan).slice(0, 1500)]);

    // ================= 1. off by default =================
    const P0 = project('proj-off');
    setEngines({ unity: { land: 'node -e "0" {branch}', target: 'port/main', gateWorktree: fwd(P0) } });
    const off = probe(`import { editorServicePass, warmLandEnv, enqueueCheck, ensure } from ${ES};
const pass = await editorServicePass({ root: process.cwd() });
const warm = await warmLandEnv({ root: process.cwd(), engine: 'unity' });
const q = enqueueCheck(process.cwd(), { engine: 'unity', lane: 'builder-a', branch: 'feat/a' });
console.log(JSON.stringify({ pass, warm, q }));`);
    const offCli = cli(['check', '--lane', 'builder-a', '--branch', 'feat/a']);
    await guard('2.84 (s) everything is off by default: with no engines.<x>.service or .warm the queue pass does nothing, no warm editor is offered (no variables, no event), a check request is refused, no editor process is started and no .studio/editor-service folder is made (fails before this change: there was no editor service; the guard is that turning it on stays a choice)', () => [
      off.pass?.off === true && off.warm && Object.keys(off.warm).length === 0 && off.q?.ok === false && /service\.check/.test(off.q.why) && offCli.status === 1
        && starts(P0).length === 0 && !fs.existsSync(path.join(S, '.studio', 'editor-service')) && !events().some((e) => /^engine\.warm|^editor\./.test(e.type)),
      JSON.stringify({ off, offCli: offCli.text.slice(-400) })]);

    // ================= 2. start, first heartbeat, status =================
    const P = project('proj-a');
    setEngines({ unity: { service: { check: true, ...fast({ recycleAfter: 3 }) } } });
    const st = cli(['start', '--project', P]);
    const stat = cli(['status', '--json']);
    const chk = (stat.json?.instances || []).find((i) => i.instance === 'check') || {};
    const hb = (() => { try { return JSON.parse(fs.readFileSync(path.join(P, 'Temp', 'StudioService', 'heartbeat.json'), 'utf8')); } catch { return null; } })();
    await guard('2.84 (s) npm run editor -- start opens the editor detached on the project with -studioService <project>/Temp/StudioService, records its pid in .studio/editor-service/unity.json, returns after the first heartbeat, and status shows it healthy (fails before this change: no editor stayed open between runs)', () => [
      st.status === 0 && st.json?.ok && st.json.pid && starts(P).includes(st.json.pid) && hb?.pid === st.json.pid && chk.healthy === true && chk.pid === st.json.pid
        && fs.existsSync(path.join(S, '.studio', 'editor-service', 'unity.json')) && fwd(st.json.folder || '').endsWith('Temp/StudioService'),
      JSON.stringify({ st, stat: stat.json || stat.text })]);

    // ================= 3. requests: a round trip, errors parsed =================
    ctl(P, { compileErrors: [{ file: path.join(P, 'Assets', 'Ui', 'Menu.cs'), line: 12, code: 'CS0246', message: 'The type or namespace name \'Panel\' could not be found ' }] });
    const comp = cli(['request', 'compile']);
    const resultsXml = path.join(T, 'edit-results.xml');
    const tst = cli(['request', 'test', '--mode', 'EditMode', '--filter', 'Game.Rules', '--results', resultsXml]);
    const png = path.join(T, 'shot.png');
    const cap = cli(['request', 'capture', '--scene', 'Assets/Scenes/Main.unity', '--out', png]);
    const e0 = comp.json?.errors?.[0] || {};
    await guard('2.84 (s) a request round trip: compile answers with the compiler errors made project-relative with forward slashes (Assets/Ui/Menu.cs, line 12, CS0246, the message trimmed) and exits 1 on ok:false; test writes the NUnit file it was given; capture writes the PNG (fails before this change: no request reached an editor)', () => [
      comp.status === 1 && comp.json?.ok === false && e0.file === 'Assets/Ui/Menu.cs' && e0.line === 12 && e0.code === 'CS0246' && e0.message === 'The type or namespace name \'Panel\' could not be found'
        && tst.status === 0 && tst.json?.ok && fs.existsSync(resultsXml) && /<test-run/.test(fs.readFileSync(resultsXml, 'utf8'))
        && cap.status === 0 && fs.existsSync(png) && fs.readFileSync(png).subarray(1, 4).toString() === 'PNG',
      JSON.stringify({ comp: comp.json || comp.text, tst: tst.json || tst.text, cap: cap.json || cap.text })]);
    const rec = probe(`import { ensure } from ${ES};
const r = await ensure('unity', { root: process.cwd(), instance: 'check' });
console.log(JSON.stringify({ ok: r.ok, why: r.why, restarted: r.restarted || false, pid: r.rec?.pid }));`);
    await guard('2.84 (s) recycleAfter: after the set number of requests (3 here) ensure() restarts the editor before the next request, so leaked editor state cannot build up (fails before this change: nothing restarted an editor)', () => [
      rec.ok && rec.restarted && /recycle: 3 request/.test(rec.why) && starts(P).length === 2 && rec.pid === starts(P)[1] && !alive(starts(P)[0]), JSON.stringify({ rec, starts: starts(P) })]);

    // ================= 4. a hung request times out; the editor is recycled; the next request works =================
    ctl(P, { hangOnce: 'compile' });
    const hungPid = starts(P).at(-1);
    const hung = cli(['request', 'compile']);
    const afterHang = probe(`import { request } from ${ES};
const r = await request('unity', 'compile', {}, { root: process.cwd(), instance: 'check' });
console.log(JSON.stringify({ ok: r.ok, errors: r.errors, why: r.why || null }));`);
    await guard('2.84 (s) a hung request times out after requestTimeoutMin (exit 3: fall back), the hung editor (which no longer reads a quit) is killed after the grace period, and the next request starts a fresh editor and is answered (fails before this change: a hung editor would hold the queue and the project for good)', () => [
      hung.status === 3 && hung.json?.timedOut === true && !alive(hungPid) && afterHang.ok === true && starts(P).length === 3 && alive(starts(P)[2]),
      JSON.stringify({ hung: hung.json || hung.text, afterHang, starts: starts(P) })]);

    // ================= 5. a dead editor: one restart; then the fallback =================
    const W = project('land-tree');
    setEngines({ unity: { land: 'node -e "0" {branch}', target: 'port/main', gateWorktree: fwd(W), warm: 'land', service: fast() } });
    const w1 = probe(`import { warmLandEnv } from ${ES};
console.log(JSON.stringify(await warmLandEnv({ root: process.cwd(), engine: 'unity' })));`);
    const firstLand = starts(W)[0];
    try { process.kill(firstLand, 'SIGKILL'); } catch { /* gone */ }
    await sleep(300);
    const leftLock = fs.existsSync(path.join(W, 'Temp', 'UnityLockfile'));
    const w2 = probe(`import { warmLandEnv } from ${ES};
console.log(JSON.stringify(await warmLandEnv({ root: process.cwd(), engine: 'unity' })));`);
    const secondLand = starts(W)[1];
    ctl(W, { dieOnStart: true });
    try { process.kill(secondLand, 'SIGKILL'); } catch { /* gone */ }
    await sleep(300);
    const w3 = probe(`import { warmLandEnv } from ${ES};
console.log(JSON.stringify(await warmLandEnv({ root: process.cwd(), engine: 'unity' })));`);
    const fb = events().filter((e) => e.type === 'engine.warm.fallback');
    ctl(W, {});
    await guard('2.84 (s) a dead warm editor is restarted once (its own leftover Temp/UnityLockfile removed, the variables offered again); when the restart fails too, the land run gets no STUDIO_EDITOR_SERVICE* (the cold path), engine.warm.fallback names the reason and no editor of ours is left on the land tree (fails before this change: there was no warm editor to fall back from)', () => [
      fwd(w1.STUDIO_EDITOR_SERVICE || '') === `${fwd(W)}/Temp/StudioService` && /editor-service\.mjs" request --engine unity --instance land/.test(w1.STUDIO_EDITOR_SERVICE_CLI || '')
        && leftLock && w2.STUDIO_EDITOR_SERVICE && starts(W).length === 3 && !('STUDIO_EDITOR_SERVICE' in w3) && !('STUDIO_EDITOR_SERVICE_CLI' in w3)
        && fb.length === 1 && /restart failed/.test(fb[0].meta?.why || '') && !starts(W).some(alive),
      JSON.stringify({ w1, w2, w3, fb, starts: starts(W) })]);

    // ================= 6. stop kills only its own pid; a project another editor holds is refused =================
    setEngines({ unity: { service: { check: true, ...fast() } } });
    const decoy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', windowsHide: true });
    decoys.push(decoy);
    await sleep(200);
    const sf = path.join(S, '.studio', 'editor-service', 'unity.json');
    const sv = JSON.parse(fs.readFileSync(sf, 'utf8'));
    const realCheck = sv.instances.check;
    // A record whose pid is now another program (the decoy): its recorded start does not match.
    sv.instances.check = { ...realCheck, pid: decoy.pid, identity: { start: 1000, proc: 'not-this-one' } };
    fs.writeFileSync(sf, JSON.stringify(sv));
    const stopOther = cli(['stop']);
    const decoyAlive = alive(decoy.pid);
    // Put the real one back and stop it: it quits on the quit request.
    const sv2 = JSON.parse(fs.readFileSync(sf, 'utf8')); sv2.instances = { ...(sv2.instances || {}), check: realCheck }; fs.writeFileSync(sf, JSON.stringify(sv2));
    const stopOwn = cli(['stop']);
    const ownGone = !alive(realCheck.pid);
    const L = project('locked');
    write(L, 'Temp/UnityLockfile', 'held by a person\'s editor');
    const refused = cli(['start', '--project', L]);
    await guard('2.84 (s) stop kills only the editor this harness started: a recorded pid that is now another program (its start does not match) is left alone, the real editor quits on the quit request; and start refuses a project whose Temp/UnityLockfile shows another editor has it open, starting nothing (fails before this change: no stop and no lock check existed)', () => [
      stopOther.json?.running === false && /nothing killed/.test(stopOther.json?.why || '') && decoyAlive && alive(decoy.pid)
        && stopOwn.json?.running === true && stopOwn.json?.killed === false && ownGone
        && refused.status === 3 && refused.json?.refused === true && /UnityLockfile/.test(refused.json?.why || '') && starts(L).length === 0,
      JSON.stringify({ stopOther: stopOther.json || stopOther.text, decoyAlive, stopOwn: stopOwn.json || stopOwn.text, ownGone, refused: refused.json || refused.text })]);

    // ================= 7. the agents' queue =================
    const R = path.join(T, 'engine-repo');
    const GW = path.join(T, 'engine-gate');
    fs.mkdirSync(R, { recursive: true });
    g(R, 'init', '-q', '-b', 'port/main');
    write(R, 'Assets/Game.cs', 'class Game {}\n');
    write(R, '.gitignore', 'Temp/\n.fake-editor*\n');
    g(R, 'add', '-A'); g(R, 'commit', '-qm', 'start');
    g(R, 'checkout', '-q', '-b', 'dev');
    g(R, 'worktree', 'add', '-q', GW, 'port/main');
    g(R, 'checkout', '-q', '-b', 'feat/a', 'port/main'); write(R, 'Assets/Ui/Menu.cs', 'class Menu {}\n'); g(R, 'add', '-A'); g(R, 'commit', '-qm', 'menu');
    g(R, 'checkout', '-q', '-b', 'feat/b', 'port/main'); write(R, 'compile-error.txt', 'The name \'Hangar\' does not exist in the current context\n'); g(R, 'add', '-A'); g(R, 'commit', '-qm', 'broken');
    g(R, 'checkout', '-q', 'dev');
    const headB = g(R, 'rev-parse', 'feat/b').stdout.trim();
    projects.push(path.join(S, '.studio', 'editor-service', 'unity-tree'));
    setEngines({ unity: { land: 'node -e "0" {branch}', target: 'port/main', cwd: fwd(R), gateWorktree: fwd(GW), service: { check: true, ...fast({ requestTimeoutMin: 0.1 }) } } });
    // A worker session (its own lane name, run from a folder that is not the studio): accepted.
    const worker = { STUDIO_LOCK_OWNER: 'builder-a' };
    const q1 = cli(['check', '--branch', 'feat/a'], worker, T);
    const q2 = cli(['check', '--branch', 'feat/b'], worker, T);
    const q3 = cli(['check', '--lane', 'builder-b', '--branch', 'feat/a', '--capture', 'Assets/Scenes/Main.unity:Main Camera'], {}, T);
    const queue = () => { try { return JSON.parse(fs.readFileSync(path.join(S, '.studio', 'editor-service', 'queue.json'), 'utf8')).requests; } catch { return []; } };
    const q = queue();
    // While the engine's train runs, the pass waits.
    const trainLock = path.join(S, '.studio', 'locks', 'unity-train.lock');
    fs.mkdirSync(path.dirname(trainLock), { recursive: true });
    fs.writeFileSync(trainLock, JSON.stringify({ pid: decoy.pid, id: 'train-x', by: 'producer', at: Date.now() }));
    const skipped = probe(`import { editorServicePass } from ${ES};
console.log(JSON.stringify(await editorServicePass({ root: process.cwd() })));`);
    const qAfterSkip = queue().length;
    fs.rmSync(trainLock, { force: true });
    const pass1 = probe(`import { editorServicePass } from ${ES};
console.log(JSON.stringify(await editorServicePass({ root: process.cwd() })));`);
    const pass2 = probe(`import { editorServicePass } from ${ES};
console.log(JSON.stringify(await editorServicePass({ root: process.cwd() })));`);
    const resA = cli(['result', '--lane', 'builder-a']);
    const resB = cli(['result', '--lane', 'builder-b', '--json']);
    const chkEv = events().filter((e) => e.type === 'editor.check');
    const resFile = path.join(S, '.studio', 'editor-service', 'out', 'builder-a', headB.slice(0, 8), 'result.json');
    await guard('2.84 (s) the agents\' queue: a worker session\'s check is accepted (lane from STUDIO_LOCK_OWNER), one waiting request per lane (a newer one replaces it), the pass skips while the engine\'s train runs, then runs the oldest in the service\'s own checkout (never the lane\'s or the gate\'s folder): builder-a\'s feat/b gets its compiler error as "Assets/Broken.cs(3): CS0103 ..." in out/builder-a/<head8>/result.json and an editor.check event with status error; builder-b\'s feat/a compiles and its capture writes a PNG (fails before this change: builder sessions had no way to compile or look at engine work before the train)', () => [
      q1.status === 0 && q2.status === 0 && /replaced 1 waiting/.test(q2.text) && q3.status === 0 && q.length === 2 && q[0].lane === 'builder-a' && q[0].branch === 'feat/b' && q[1].lane === 'builder-b'
        && skipped.engines?.[0]?.skipped && /train train-x is running/.test(skipped.engines[0].skipped) && qAfterSkip === 2
        && pass1.engines?.[0]?.ran === q[0].id && pass2.engines?.[0]?.ran === q[1].id && queue().length === 0
        && resA.status === 1 && /Assets\/Broken\.cs\(3\): CS0103 The name 'Hangar' does not exist/.test(resA.text) && fs.existsSync(resFile)
        && resB.json?.ok === true && resB.json.images?.length === 1 && fs.existsSync(resB.json.images[0])
        && chkEv.length === 2 && chkEv[0].status === 'error' && chkEv[0].meta?.lane === 'builder-a' && chkEv[0].meta?.errors === 1 && chkEv[0].meta?.head === headB && chkEv[1].status === 'ok' && chkEv[1].meta?.images === 1
        && !fs.existsSync(path.join(GW, 'Temp')) && !fs.existsSync(path.join(R, 'Temp')),
      JSON.stringify({ q1: q1.text.slice(-300), q2: q2.text.slice(-300), q, skipped, pass1, pass2, resA: resA.text, resB: resB.json, chkEv: chkEv.map((e) => ({ s: e.status, m: e.meta })) }).slice(0, 3000)]);
    cli(['stop']);

    // ================= 8. the train's land environment =================
    const landStub = path.join(T, 'land-stub.mjs');
    fs.writeFileSync(landStub, `import fs from 'node:fs'; import { spawnSync } from 'node:child_process';
const [gw, ctl, br] = process.argv.slice(2);
const E = process.env;
let ping = null;
if (E.STUDIO_EDITOR_SERVICE_CLI) ping = spawnSync(E.STUDIO_EDITOR_SERVICE_CLI + ' ping', { shell: true, encoding: 'utf8', windowsHide: true }).status;
fs.appendFileSync(ctl, JSON.stringify({ only: E.STUDIO_LAND_ONLY ?? null, svc: E.STUDIO_EDITOR_SERVICE ?? null, cli: E.STUDIO_EDITOR_SERVICE_CLI ?? null, ping }) + '\\n');
const m = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'merge', '--no-ff', '-m', 'land', 'refs/heads/' + br], { cwd: gw, encoding: 'utf8', windowsHide: true });
process.exit(m.status === 0 ? 0 : 1);
`);
    const runsOf = (f) => { try { return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
    const TRAIN = `import { runUnityTrain } from ${u('harness/unity-train.mjs')};
const handed = [];
const r = await runUnityTrain({ root: process.cwd(), log: () => {}, deps: { handBack: (lane, note) => handed.push({ task: lane.task, note }) } });
console.log(JSON.stringify({ ok: r.ok, runs: r.runs, landed: r.landed, dropped: r.dropped, handed, message: r.message }));`;
    const trainWith = (extra, ctlName, task, branch) => {
      const c = path.join(T, ctlName);
      setEngines({ unity: { land: `node "${fwd(landStub)}" "${fwd(GW)}" "${fwd(c)}" {branch}`, target: 'port/main', cwd: fwd(R), gateWorktree: fwd(GW), timeoutMin: 5, rules: false, ...extra } });
      fs.rmSync(path.join(S, '.studio', 'train'), { recursive: true, force: true });
      fs.mkdirSync(path.join(S, '.studio', 'train'), { recursive: true });
      fs.writeFileSync(path.join(S, '.studio', 'train', 'unity-queue.json'), JSON.stringify([{ task, agent: 'porter-0', branch, head: g(R, 'rev-parse', branch).stdout.trim(), at: new Date().toISOString() }]));
      return { r: probe(TRAIN), runs: runsOf(c) };
    };
    g(R, 'checkout', '-q', '-b', 'feat/c', 'port/main'); write(R, 'Assets/Hangar/Doors.cs', 'class Doors {}\n'); g(R, 'add', '-A'); g(R, 'commit', '-qm', 'doors');
    g(R, 'checkout', '-q', '-b', 'feat/d', 'port/main'); write(R, 'Assets/Hangar/Gates.cs', 'class Gates {}\n'); g(R, 'add', '-A'); g(R, 'commit', '-qm', 'gates');
    g(R, 'checkout', '-q', 'dev');
    const cold = trainWith({}, 'ctl-cold', 'T-801', 'feat/c');
    const gwStartsCold = starts(GW).length;
    projects.push(GW);
    const warm = trainWith({ warm: 'land', service: fast({ requestTimeoutMin: 0.1 }) }, 'ctl-warm', 'T-802', 'feat/d');
    const wr = warm.runs[0] || {};
    await guard('2.84 (s) the train\'s land environment: with no warm setting the land command gets no STUDIO_EDITOR_SERVICE* and no editor starts; with engines.unity.warm "land" the train opens the warm editor on the land tree (the gate worktree) before the land run and the land command gets STUDIO_EDITOR_SERVICE (its service folder) and STUDIO_EDITOR_SERVICE_CLI, through which a ping is answered (fails before this change: every land step had to start the editor cold)', () => [
      cold.r.ok && cold.r.landed?.includes('T-801') && cold.runs.length === 1 && cold.runs[0].svc === null && cold.runs[0].cli === null && gwStartsCold === 0
        && warm.r.ok && warm.r.landed?.includes('T-802') && fwd(wr.svc || '') === `${fwd(GW)}/Temp/StudioService` && /--instance land/.test(wr.cli || '') && wr.ping === 0 && starts(GW).length === 1,
      JSON.stringify({ cold, warm, gw: starts(GW) }).slice(0, 2500)]);
    cli(['stop', '--instance', 'land']);
  } finally {
    // Every editor the harness started here, and the decoy: killed (all were started by this test).
    for (const p of projects) for (const pid of starts(p)) { if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
    for (const d of decoys) { try { d.kill('SIGKILL'); } catch { /* gone */ } }
    try { fs.rmSync(T, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }); } catch { /* the run's tmp sweep */ }
    try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }); } catch { /* the run's tmp sweep */ }
  }
}
