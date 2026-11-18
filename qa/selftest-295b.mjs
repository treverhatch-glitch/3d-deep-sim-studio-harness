/**
 * qa/selftest-295b.mjs — 2.95 (b): "Systems ON: n of m" (engines.<x>.switches) and the playtest build in one command
 * (engines.<x>.playtest, npm run engine -- playtest). Switches are read from the engine target with git; the line is on
 * the score, the brief and studio:status. A green land run's build (gates.build.output) is promoted with its notes,
 * shortcut and record; --if-moved does nothing twice; a moved target is built (train lock and heavy slot held), or not
 * while a train runs; an older promoted folder is never overwritten.
 *
 * The scaffolding (a studio copy, a made-up engine repo with a gate worktree) is qa/selftest-294a.mjs's. Paths with spaces.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { eventsOf as eventsFileOf, eventTypesOf, fileUrlOf as fileUrlRelSOf, fwd, gEnvOf, gitUserCrlfOf, guardCap3000Of, out, readJsonFile as readJson, writeIn as write } from './kit.mjs';

export async function selftest295B({ dir, report, tmpRoot }) {
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = gitUserCrlfOf(gEnvOf(ident));
  const guard = guardCap3000Of(report);
  const T = path.join(tmpRoot, `s295b ${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const clean = {};
  // Windows: PowerShell (the process list a train cancel reads) needs Windows' own system variables, which any real shell
  // has; from this cut-down environment it ran into its time limit (P-370). Passed through as they are, as in 284u.
  if (process.platform === 'win32') for (const k of Object.keys(process.env)) if (/^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|COMPUTERNAME|HOMEDRIVE|HOMEPATH|USERNAME)$/i.test(k)) clean[k] = process.env[k];
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '0.5', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off',
    STUDIO_HEAVY_SLOTS: '1', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off', STUDIO_UNITY_EDITMODE_PLAN: 'off', STUDIO_USAGE_FUNCTIONS: 'off', STUDIO_TEST_FREEMEM_MB: '64000',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-295b-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };

  const S = path.join(tmpRoot, `295b-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json', 'studio/DONE.md']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  write(S, 'studio/NEXT.md', '# Studio Task Queue (`studio/NEXT.md`)\n\n## IN_PROGRESS\n\n## BACKLOG\n- [ ] **T-201** [P2] (`engine-porter`) — Port and switch fees, loans, maps ON together\n- [ ] **T-202** [P2] (`builder`) — Tidy the maps folder\n- [ ] **T-302** [P2] (`engine-porter`) — Move the fees panel\n');
  const setEngines = (engines) => write(S, 'studio/game.json', `${JSON.stringify({ engines }, null, 2)}\n`);
  setEngines({});
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-295b.jsonl');
  fs.writeFileSync(evFile, '');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, ...extra });
  const evs = eventTypesOf(eventsFileOf(evFile));
  const u = fileUrlRelSOf(S);
  let pn = 0;
  const probe = (code, env = {}) => {
    const f = path.join(S, `.probe-295b-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: { ...envOf(), ...env }, encoding: 'utf8', timeout: 300000 });
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(l), _out: out(r).slice(-1500) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const run = (args) => spawnSync(process.execPath, args, { windowsHide: true, cwd: S, env: envOf(), encoding: 'utf8', timeout: 120000 });
  const J = (x) => JSON.stringify(x).slice(0, 2800);

  // The engine repo: target port/main checked out in a gate worktree; the repo itself is on dev, which has one more switch on.
  const R = path.join(T, 'engine repo');
  const GW = path.join(T, 'gate wt');
  fs.mkdirSync(R, { recursive: true });
  g(R, 'init', '-q', '-b', 'port/main');
  const sw = (name, on) => `class ${name}Switch {\n  Name => "${name}";\n  On => ${on ? 'true' : 'false'};\n}\n`;
  for (const [f, t] of Object.entries({ 'Game/Sim/Systems/Fees.switch.cs': sw('fees', true), 'Game/Sim/Systems/Loans.switch.cs': sw('loans', false), 'Game/Sim/Systems/Maps.switch.cs': sw('maps', false), 'Game/Sim/Systems/Move.switch.cs': sw('move', true), 'Game/Sim/Fees.cs': 'class Fees { }\n' })) write(R, f, t);
  g(R, 'add', '-A'); g(R, 'commit', '-qm', 'start');
  g(R, 'checkout', '-q', '-b', 'dev');
  write(R, 'Game/Sim/Systems/Loans.switch.cs', sw('loans', true));
  g(R, 'commit', '-qam', 'loans on, not landed');
  g(R, 'worktree', 'add', '-q', GW, 'port/main');
  const tip = () => g(GW, 'rev-parse', 'HEAD').stdout.trim();
  const SW = { files: 'Game/Sim/Systems/**/*.switch.cs', name: 'Name\\s*=>\\s*"(\\w+)"', on: 'On\\s*=>\\s*true', total: 6 };

  const ctl = path.join(T, 'ctl');
  const buildsDir = path.join(T, 'builds dir');
  const playDir = path.join(T, 'play test');
  const deskDir = path.join(T, 'my desktop');
  fs.mkdirSync(deskDir, { recursive: true });
  // The land script's stand-in: a commit on the target, a player build in a new folder, the land result with
  // gates.build.output, then a record commit in an ignored path (the target's tip is one past the built commit).
  const landStub = path.join(T, 'land-stub.mjs');
  fs.writeFileSync(landStub, `import fs from 'node:fs'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
const [gw, builds, n] = process.argv.slice(2);
const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd: gw, encoding: 'utf8', windowsHide: true });
fs.writeFileSync(path.join(gw, 'Game/Sim/Fees.cs'), 'class Fees { int v' + n + '; }\\n'); git('commit', '-qam', 'land ' + n);
const commit = git('rev-parse', 'HEAD').stdout.trim();
const bd = path.join(builds, 'gate-' + n); fs.mkdirSync(path.join(bd, 'Game Sim_Data'), { recursive: true });
fs.writeFileSync(path.join(bd, 'Game Sim.exe'), 'player ' + n); fs.writeFileSync(path.join(bd, 'Game Sim_Data', 'level.txt'), 'level ' + n);
fs.writeFileSync(process.env.STUDIO_LAND_RESULT, JSON.stringify({ status: 'pass', commit, gates: { build: { status: 'pass', output: path.join(bd, 'Game Sim.exe') } } }));
fs.mkdirSync(path.join(gw, 'Records'), { recursive: true }); fs.writeFileSync(path.join(gw, 'Records', 'land-' + n + '.json'), '{}'); git('add', '-A'); git('commit', '-qm', 'record ' + n);
console.log('landed ' + n);
`);
  // playtest.build's stand-in: says what it saw (the heavy slot, the train lock) and writes the player into {out}.
  const buildStub = path.join(T, 'build-stub.mjs');
  fs.writeFileSync(buildStub, `import fs from 'node:fs'; import path from 'node:path';
const [outDir, ctl, lock] = process.argv.slice(2);
fs.appendFileSync(ctl + '-builds.jsonl', JSON.stringify({ held: process.env.STUDIO_HEAVY_HELD || '', lock: fs.existsSync(lock) ? JSON.parse(fs.readFileSync(lock, 'utf8')).id : null, commit: process.env.STUDIO_PLAYTEST_COMMIT || '', cwd: process.cwd() }) + '\\n');
fs.writeFileSync(path.join(outDir, 'Game Sim.exe'), 'player built');
`);
  const trainLock = path.join(S, '.studio', 'locks', 'unity-train.lock');
  const builds = () => { try { return fs.readFileSync(`${ctl}-builds.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  let landN = 0;
  const cfgOf = (extra = {}) => ({ unity: { land: `node "${fwd(landStub)}" "${fwd(GW)}" "${fwd(buildsDir)}" {task}`, target: 'port/main', cwd: fwd(R), gateWorktree: fwd(GW), timeoutMin: 5, rules: { ignore: ['Records'] }, switches: SW, ...extra } });
  const PT = { dir: fwd(playDir), exe: 'Game Sim.exe', shortcut: fwd(deskDir), feedback: 'Say what you found in the studio chat.', keep: 3 };
  const land = () => probe(`import { runUnityGate } from ${u('harness/unity-gate.mjs')};
const r = await runUnityGate({ engine: 'unity', task: 'T-${300 + ++landN}', branch: 'feat/a' });
console.log(JSON.stringify({ status: r.status, why: r.why }));`);
  const PLAY = (o = {}) => `import { playtest } from ${u('harness/playtest.mjs')};
const r = await playtest(${JSON.stringify({ engine: 'unity', ...o })});
console.log(JSON.stringify(r));`;
  const SWITCHES = `import { readSwitches, switchesLines } from ${u('harness/switches.mjs')};
console.log(JSON.stringify({ r: await readSwitches('unity'), lines: await switchesLines() }));`;
  const folders = () => { try { return fs.readdirSync(playDir).filter((f) => /^\d{4}-\d{2}-\d{2}-[0-9a-f]{7}/.test(f)).sort(); } catch { return []; } };
  const shortcutName = process.platform === 'win32' ? 'Playtest Unity.cmd' : 'playtest-unity.sh';

  // ================= (a) switches =================
  setEngines(cfgOf());
  {
    const r = probe(SWITCHES);
    const s = r.r || {};
    await guard('2.95 (b1) switches are read from the engine target with git: fees and move ON, loans and maps off, total 6 (the planned number, 4 files found, 2 not in the engine yet); loans stays off although the checked-out dev branch has it on; T-201 ("switch fees, loans, maps ON together") is the task of loans and maps (fails before this fix: no switches were read)', () => [
      s.on?.join() === 'fees,move' && s.off?.map((o) => `${o.name}:${o.task?.id || '-'}`).join() === 'loans:T-201,maps:T-201' && s.total === 6 && s.missing === 2 && r.lines?.join() === 'Systems ON: 2 of 6', J(r)]);
  }
  {
    setEngines(cfgOf({ switches: { ...SW, total: 2, task: 'tidy the {name}' } }));
    const r1 = probe(SWITCHES);
    setEngines(cfgOf({ switches: undefined }));
    const r2 = probe(SWITCHES);
    setEngines(cfgOf({ switches: { ...SW, on: 'On => (true' } }));
    const r3 = probe(SWITCHES);
    setEngines(cfgOf());
    await guard('2.95 (b2) a studio\'s own task regex finds T-202 for maps and none for loans; total is the larger of the planned number and the files (4 > 2); unset: no line and nothing read; a bad "on" regex is one plain line naming it, not a throw (fails before this fix: there was no switches setting)', () => [
      r1.r?.total === 4 && r1.r?.off?.map((o) => `${o.name}:${o.task?.id || '-'}`).join() === 'loans:-,maps:T-202' && r2.r === null && Array.isArray(r2.lines) && !r2.lines.length
        && r3.r?.bad && /engines\.unity\.switches\.on is not a valid regex/.test(r3.lines?.[0] || '') && /^Systems ON: not read/.test(r3.lines?.[0] || ''), J({ r1, r2, r3 })]);
  }
  {
    const sc = probe(`import { roundScore, scoreText } from ${u('harness/score.mjs')};
const s = await roundScore({ events: [], machine: [], days: 1, progressTimeoutMs: 1000 });
console.log(JSON.stringify({ text: scoreText(s) }));`);
    const br = run(['harness/brief-status.mjs', '--peek']);
    const st = run(['harness/supervisor.mjs', 'status']);
    const ev = run(['harness/engine.mjs', 'switches']);
    await guard('2.95 (b3) "Systems ON: 2 of 6" is on npm run score, npm run status (the brief) and npm run studio:status; npm run engine -- switches lists the systems still off with their task (fails before this fix: no such line or verb)', () => [
      /Systems ON: 2 of 6/.test(sc.text || '') && /Systems ON: 2 of 6\./.test(out(br)) && /Systems ON: 2 of 6/.test(out(st)) && ev.status === 0 && /off: loans \(T-201: Port and switch fees, loans, maps ON together\)/.test(out(ev)) && /Not in the engine yet: 2/.test(out(ev)), J({ sc: sc.text?.slice(-600) || sc, br: out(br).slice(-500), st: out(st).slice(-400), ev: out(ev) })]);
  }

  // ================= (b) the first promote =================
  setEngines(cfgOf({ playtest: PT }));
  const l1 = land();
  const built1 = readJson(path.join(S, '.studio', 'engine', 'unity-land-builds.json')) || [];
  const p1 = probe(PLAY());
  const f1 = folders();
  const notes = (() => { try { return fs.readFileSync(path.join(playDir, 'PLAYTEST.md'), 'utf8'); } catch { return ''; } })();
  const rec1 = readJson(path.join(S, '.studio', 'engine', 'unity-playtest.json')) || {};
  const sc1 = (() => { try { return fs.readFileSync(path.join(deskDir, shortcutName), 'utf8'); } catch { return ''; } })();
  await guard('2.95 (b4) a green land run that writes gates.build.output is kept with its commit, and playtest promotes it while the tip differs only in rules.ignore paths: a copy in <dir>/<date>-<short>/ (paths with spaces), PLAYTEST.md there and in <dir> (systems on and off, first build, the feedback line), the shortcut in <dir> and the folder given, the record and one engine.playtest event (fails before this fix: no build was kept and there was no playtest command)', () => [
      l1.status === 'pass' && built1.length === 1 && built1[0].commit === g(GW, 'rev-parse', 'HEAD~1').stdout.trim() && p1.action === 'promoted' && p1.source === 'land' && f1.length === 1
        && fs.readFileSync(path.join(playDir, f1[0], 'Game Sim.exe'), 'utf8') === 'player T-301' && fs.existsSync(path.join(playDir, f1[0], 'Game Sim_Data', 'level.txt')) && fs.existsSync(path.join(playDir, f1[0], 'PLAYTEST.md'))
        && /## Systems ON: 2 of 6/.test(notes) && /Still off: loans \(T-201\), maps \(T-201\)\./.test(notes) && /This is the first playtest build\./.test(notes) && /Say what you found in the studio chat\./.test(notes) && /It is the newest there is/.test(notes)
        && fs.existsSync(path.join(playDir, shortcutName)) && sc1.includes(f1[0]) && (process.platform === 'win32' ? /cd \/d ".*"\r\nstart "" "Game Sim\.exe"/.test(sc1) : /^#!\/bin\/sh\n/.test(sc1) && /exec \.\/'Game Sim\.exe'/.test(sc1))
        && rec1.last?.folder === f1[0] && evs(/^engine\.playtest$/).length === 1, J({ p1: p1.action || p1, f1, ev: evs(/^engine\.playtest$/).length, rec: rec1.last?.folder, l1, tipM1: g(GW, 'rev-parse', 'HEAD~1').stdout.trim(), built1 })]);
  {
    const p2 = probe(PLAY({ ifMoved: true }));
    await guard('2.95 (b5) a second run with --if-moved does nothing: one line, exit 0, no new folder or event (fails before this fix: there was no playtest command)', () => [
      p2.ok === true && p2.action === 'unchanged' && p2.lines?.length === 1 && /already the newest there is/.test(p2.lines[0]) && folders().length === 1 && evs(/^engine\.playtest$/).length === 1, J(p2)]);
  }

  // ================= (c) the target moved, no build command =================
  fs.writeFileSync(path.join(playDir, folders()[0], 'owner-save.txt'), 'playing');
  write(GW, 'Game/Sim/Fees.cs', 'class Fees { int moved; }\n');
  g(GW, 'commit', '-qam', 'T-302 lands');
  fs.appendFileSync(evFile, `${JSON.stringify({ ts: new Date().toISOString(), type: 'task.train.unity.landed', agent: 'unity-train', meta: { head: tip(), lanes: ['T-302'] } })}\n`);
  {
    const p3 = probe(PLAY());
    const f3 = folders();
    const n3 = fs.readFileSync(path.join(playDir, 'PLAYTEST.md'), 'utf8');
    await guard('2.95 (b6) the target moved with no build command: the newest build is promoted and the output and notes say it is 1 landing behind (T-302, with its title); the earlier promoted folder is not overwritten (the owner\'s file in it stays) (fails before this fix: there was no playtest command)', () => [
      p3.action === 'promoted' && p3.source === 'land' && p3.lines?.some((l) => /is 1 landing\(s\) behind port\/main: T-302 \(Move the fees panel\)/.test(l)) && /It is 1 landing\(s\) behind port\/main: T-302/.test(n3)
        && f3.length === 2 && fs.readFileSync(path.join(playDir, f3[0], 'owner-save.txt'), 'utf8') === 'playing' && !fs.existsSync(path.join(playDir, f3[1], 'owner-save.txt')), J({ p3, f3, n3: n3.slice(0, 600) })]);
  }

  // ================= (d) with a build command =================
  const buildCmd = `node "${fwd(buildStub)}" {out} "${fwd(ctl)}" "${fwd(trainLock)}"`;
  setEngines(cfgOf({ playtest: { ...PT, build: buildCmd } }));
  {
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { windowsHide: true, stdio: 'ignore' });
    fs.mkdirSync(path.dirname(trainLock), { recursive: true });
    fs.writeFileSync(trainLock, JSON.stringify({ pid: sleeper.pid, at: Date.now(), id: 'U-9', by: 'unity-train' }));
    const p4 = probe(PLAY());
    try { sleeper.kill(); } catch { /* started by this test */ }
    fs.rmSync(trainLock, { force: true });
    await guard('2.95 (b7) with a build command while an engine train holds the engine: nothing is built (the build command never ran), the output says a train is running, and the newest land build is promoted (fails before this fix: there was no playtest command)', () => [
      p4.action === 'promoted' && p4.source === 'land' && !builds().length && p4.lines?.some((l) => /an engine train is running \(U-9\)/.test(l)), J(p4)]);
  }
  {
    const p5 = probe(PLAY({ ifMoved: true }));
    const b = builds();
    const f5 = folders();
    const rec5 = readJson(path.join(S, '.studio', 'engine', 'unity-playtest.json')) || {};
    await guard('2.95 (b8) with a build command and no train, --if-moved builds the moved tip: the command runs once in the engine\'s cwd with the machine:heavy slot held and the train lock taken, writes into {out} (a path with spaces), and that build is promoted for the tip; keep 3: the oldest promoted folder is removed (fails before this fix: there was no playtest command)', () => [
      p5.action === 'promoted' && p5.source === 'build' && p5.commit === tip() && b.length === 1 && /machine-heavy-\d+\.lock:\d+/.test(b[0].held) && b[0].lock === 'playtest-build' && b[0].commit === tip()
        && path.resolve(b[0].cwd) === path.resolve(R) && fs.readFileSync(path.join(p5.folder, 'Game Sim.exe'), 'utf8') === 'player built' && f5.length === 3 && p5.removed?.length === 1 && rec5.promoted?.length === 3
        && !fs.existsSync(trainLock) && !fs.readdirSync(playDir).some((x) => x.startsWith('.building-')), J({ p5, b, f5 })]);
  }
  {
    const p6 = probe(PLAY({ ifMoved: true }));
    await guard('2.95 (b9) after the tip was built, --if-moved does nothing and builds nothing more (fails before this fix: there was no playtest command)', () => [p6.action === 'unchanged' && builds().length === 1, J(p6)]);
  }

  // ================= (e) pure parts: the record, the shortcut on both systems =================
  {
    const r = probe(`import fs from 'node:fs'; import path from 'node:path';
import { recordLandBuild, readLandBuilds, shortcutOf } from ${u('harness/playtest.mjs')};
const f = path.join(process.cwd(), '.studio', 'probe-result.json');
fs.writeFileSync(f, JSON.stringify({ commit: 'abcdef1', gates: { build: { status: 'failed', output: 'x/Game.exe' } } }));
const red = recordLandBuild('godot', f, { cwd: process.cwd() });
fs.writeFileSync(f, JSON.stringify({ commit: 'abcdef1', gates: { compile: { status: 'pass' } } }));
const none = recordLandBuild('godot', f, { cwd: process.cwd() });
const win = shortcutOf({ label: 'Unity', engine: 'unity', exe: 'C:\\\\Play Test\\\\2026-01-01-abcdef1\\\\Game Sim.exe', platform: 'win32' });
const sh = shortcutOf({ label: 'Unity', engine: 'unity', exe: '/home/o/play test/2026-01-01-abcdef1/Game Sim.exe', platform: 'linux' });
console.log(JSON.stringify({ red, none, kept: readLandBuilds(process.cwd(), 'godot').length, win, sh }));`);
    await guard('2.95 (b10) a land result whose build is not green, or has no build output, keeps nothing; the shortcut is a .cmd on Windows (cd /d to the build, start the exe) and a .sh elsewhere, with the same name every time (fails before this fix: there was no playtest record or shortcut)', () => [
      r.red === null && r.none === null && r.kept === 0 && r.win?.name === 'Playtest Unity.cmd' && /\r\ncd \/d "C:\\Play Test\\2026-01-01-abcdef1"\r\nstart "" "Game Sim\.exe"\r\n$/.test(r.win?.text || '')
        && r.sh?.name === 'playtest-unity.sh' && /cd '\/home\/o\/play test\/2026-01-01-abcdef1' && exec \.\/'Game Sim\.exe'/.test(r.sh?.text || ''), J(r)]);
  }
  {
    setEngines(cfgOf({ playtest: { ...PT, build: buildCmd, nightly: true } }));
    const r = probe(`import { nightlyPlaytests } from ${u('harness/playtest.mjs')};
console.log(JSON.stringify({ started: nightlyPlaytests() }));`);
    const pid = r.started?.[0]?.pid;
    const alive = (p) => { try { process.kill(Number(p), 0); return true; } catch { return false; } };
    for (let i = 0; i < 300 && pid && alive(pid); i++) await new Promise((res) => { setTimeout(res, 200); });
    try { if (pid && alive(pid)) process.kill(pid); } catch { /* started by this test */ }
    const log = (() => { try { return fs.readFileSync(path.join(S, '.studio', 'engine', 'unity-playtest.log'), 'utf8'); } catch { return ''; } })();
    await guard('2.95 (b11) playtest.nightly: the daily tick\'s hook starts `playtest --if-moved` for that engine on its own (detached, its output in .studio/engine/unity-playtest.log), which finds the newest already promoted and builds nothing (fails before this fix: nothing ran it)', () => [
      r.started?.length === 1 && r.started[0].engine === 'unity' && /already the newest there is/.test(log) && builds().length === 1, J({ r, log })]);
  }
  try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); fs.rmSync(T, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the sweep takes it */ }
}
