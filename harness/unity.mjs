#!/usr/bin/env node
/**
 * harness/unity.mjs — 2.46.0: the Unity track's checks.
 *
 *   npm run engine:sim [-- <folder>]     the sim, with no editor and no licence: the purity check, then the
 *                                        sim's tests with plain .NET (dotnet test <folder>/tools/SimTests)
 *   node harness/unity.mjs gate <folder> [--platform EditMode|PlayMode]
 *                                        the editor's own run: purity, the version pin, then Unity's test
 *                                        runner in batch mode for Edit Mode and Play Mode; results read from
 *                                        its NUnit XML (a run where no test ran fails), Play Mode's controls
 *                                        test writes qa/reports/controls-unity.json for the controls check
 *   npm run engine:build [-- <folder>] [--target windows|web]
 *                                        a playable build: a Windows .exe (the default since 2.48.0) or WebGL
 *                                        (any browser; the Arcade's engine tab) (Assets/Editor/StudioBuild.cs)
 *   node harness/unity.mjs purity <folder>
 *   node harness/unity.mjs version <folder>
 *   gate and build exit 3 when machine:heavy (or free memory) stayed busy and the editor didn't run.
 *
 * The folder is a Unity project (ProjectSettings/ProjectVersion.txt): engine/<game> for an engine track, or
 * game/<slug> for an adopted Unity game. The editor: STUDIO_UNITY (its full path) or `unity` on the PATH.
 *
 * Why the sim is checked apart from the editor: the editor needs an install and a licence on every machine
 * that runs it, so an agent's every change can't wait for it. The sim is a pure C# assembly
 * (Assets/Sim, Sim.asmdef with noEngineReferences), so .NET builds and tests it anywhere in seconds, and the
 * purity check keeps it that way: no UnityEngine, no Time, no unseeded Random, no wall clock.
 *
 * 2.60.1 (B-35): the editor's runs here (`gate`'s Edit Mode and Play Mode tests, `build`) take the machine:heavy lock
 * (harness/heavy.mjs; free memory under STUDIO_RAM_FLOOR_GB holds them back too), so an agent's Unity run never
 * overlaps a full verify, a browser playtest or another editor run. Other editor batch work a Unity lane starts
 * goes through `node harness/heavy.mjs run --label <what> -- <command>`. When the lock stays busy (or memory stays
 * low) the run doesn't start and the command exits 3 (busy; not a failure of the work).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent } from './event.mjs';
import { withHeavy } from './heavy.mjs';
import { seedLibrary, saveLibrary, cacheLine } from './unity-cache.mjs';

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const rel = (f) => path.relative(REPO_ROOT, f).split(path.sep).join('/');

export const isUnityProject = (dir) => fs.existsSync(path.join(dir, 'ProjectSettings', 'ProjectVersion.txt'));

/** The editor version a project asks for (ProjectVersion.txt m_EditorVersion), or null. */
export function projectVersion(dir) {
  const m = (read(path.join(dir, 'ProjectSettings', 'ProjectVersion.txt')) || '').match(/m_EditorVersion:\s*(\S+)/);
  return m ? m[1] : null;
}

/** STUDIO_UNITY_PIN (a full version or a prefix such as 6000.3) against the project's version. */
export function checkPin(dir, pin = process.env.STUDIO_UNITY_PIN || '') {
  const v = projectVersion(dir);
  if (!v) return { ok: false, why: `${rel(dir)} has no ProjectSettings/ProjectVersion.txt: not a Unity project` };
  if (!pin) return { ok: true, version: v, note: 'no STUDIO_UNITY_PIN set: any editor version is accepted' };
  const ok = v === pin || v.startsWith(`${pin}.`) || v.startsWith(pin) && /[a-z]$/i.test(pin);
  return ok ? { ok: true, version: v } : { ok: false, version: v, why: `the project asks for Unity ${v}, but STUDIO_UNITY_PIN is ${pin}: an editor upgrade changes the project files, so it is a decision, not a side effect (set the pin, or reopen the project in ${pin})` };
}

// What the sim may not touch. Matched on code with comments and strings removed.
export const SIM_BANNED = [
  { re: /\busing\s+UnityEngine\b|\bUnityEngine\./, why: 'UnityEngine (the sim is pure C#: the engine draws it, it never asks the engine)' },
  { re: /\busing\s+UnityEditor\b|\bUnityEditor\./, why: 'UnityEditor' },
  { re: /\bTime\s*\.\s*(?:deltaTime|time|fixedDeltaTime|unscaledDeltaTime|realtimeSinceStartup|frameCount|timeSinceLevelLoad)\b/, why: 'Unity time (the sim counts ticks; FixedUpdate calls Step once per tick)' },
  { re: /\bnew\s+(?:System\s*\.\s*)?Random\s*\(\s*\)/, why: 'an unseeded System.Random (seed it from the state, or use the sim\'s Mulberry32)' },
  { re: /\bRandom\s*\.\s*(?:Shared|value|Range|insideUnitCircle|insideUnitSphere|onUnitSphere|rotation)\b/, why: 'a shared or engine random (seeded RNG in the state only)' },
  { re: /\bDateTime(?:Offset)?\s*\.\s*(?:Now|UtcNow|Today)\b/, why: 'the wall clock' },
  { re: /\bEnvironment\s*\.\s*TickCount|\bStopwatch\b/, why: 'a timer' },
  { re: /\bGuid\s*\.\s*NewGuid\s*\(/, why: 'a random Guid (ids come from the state: tick and a counter)' },
  { re: /\bTask\s*\.\s*(?:Run|Delay)\b|\bnew\s+Thread\s*\(|\bThreadPool\b|\bParallel\s*\./, why: 'threads or tasks (the order of a step must not depend on scheduling)' },
  { re: /\bFile\s*\.|\bDirectory\s*\.|\bHttpClient\b|\bWebRequest\b/, why: 'files or the network' },
];

/** C# with comments, strings and chars blanked (line numbers kept). */
export function stripCs(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; } i += 2; continue; }
    if (c === '@' && d === '"') { i += 2; while (i < n && !(src[i] === '"' && src[i + 1] !== '"')) { if (src[i] === '"') i++; out += src[i] === '\n' ? '\n' : ' '; i++; } i++; out += '""'; continue; }
    if (c === '"' || c === "'") { const q = c; i++; while (i < n && src[i] !== q && src[i] !== '\n') { if (src[i] === '\\') i++; i++; } i++; out += `${q}${q}`; continue; }
    out += c;
    i++;
  }
  return out;
}

function csFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...csFiles(f));
    else if (e.name.endsWith('.cs')) out.push(f);
  }
  return out;
}

/**
 * The sim stays pure: Assets/Sim's asmdef has noEngineReferences and references no engine assembly, and no
 * file there uses what SIM_BANNED lists. Returns { ok, problems, files }.
 */
export function simPurity(dir, simRel = 'Assets/Sim') {
  const simDir = path.join(dir, simRel);
  const problems = [];
  if (!fs.existsSync(simDir)) return { ok: false, problems: [`${rel(simDir)} doesn't exist: keep the game's rules in a pure C# assembly there (see engine/_unity)`], files: 0 };
  const asmdefs = fs.readdirSync(simDir).filter((f) => f.endsWith('.asmdef'));
  if (!asmdefs.length) problems.push(`${rel(simDir)} has no .asmdef: without one its code joins Assembly-CSharp, which can use the whole engine`);
  for (const a of asmdefs) {
    let j = null;
    try { j = JSON.parse(read(path.join(simDir, a))); } catch { problems.push(`${rel(path.join(simDir, a))} is not valid JSON`); continue; }
    if (j.noEngineReferences !== true) problems.push(`${rel(path.join(simDir, a))}: "noEngineReferences" must be true (then the compiler itself refuses UnityEngine in the sim)`);
    const engineRefs = (j.references || []).filter((r) => /^(?:Unity|UnityEngine|UnityEditor)\b|^GUID:/i.test(String(r)));
    if (engineRefs.length) problems.push(`${rel(path.join(simDir, a))} references ${engineRefs.join(', ')}: the sim may reference only other pure assemblies, by name`);
  }
  const files = csFiles(simDir);
  for (const f of files) {
    const code = stripCs(read(f) || '').split('\n');
    code.forEach((line, i) => {
      for (const b of SIM_BANNED) if (b.re.test(line)) problems.push(`${rel(f)}:${i + 1} uses ${b.why}`);
    });
  }
  return { ok: problems.length === 0, problems, files: files.length };
}

/** Unity's NUnit XML: { total, passed, failed, skipped, result, failures: [{ name, message }] } or null. */
export function parseNUnit(xml) {
  const run = String(xml || '').match(/<test-run\b([^>]*)>/);
  if (!run) return null;
  const attr = (s, k) => (s.match(new RegExp(`\\b${k}="([^"]*)"`)) || [])[1];
  const num = (k) => Number(attr(run[1], k) || 0);
  const failures = [];
  for (const m of String(xml).matchAll(/<test-case\b([^>]*)>([\s\S]*?)<\/test-case>/g)) {
    if (!/\bresult="Failed"/.test(m[1])) continue;
    const msg = (m[2].match(/<message>\s*<!\[CDATA\[([\s\S]*?)\]\]>/) || [])[1] || '';
    failures.push({ name: attr(m[1], 'fullname') || attr(m[1], 'name') || '?', message: msg.trim().split('\n')[0].slice(0, 300) });
  }
  return { total: num('total') || num('testcasecount'), passed: num('passed'), failed: num('failed'), skipped: num('skipped') + num('inconclusive'), result: attr(run[1], 'result') || '', failures };
}

const which = (bin) => fs.existsSync(bin) || spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' }).status === 0;
export const unityBin = () => process.env.STUDIO_UNITY || 'unity';
export const dotnetBin = () => process.env.STUDIO_DOTNET || 'dotnet';

/**
 * 2.60.1 (B-35): run fn under machine:heavy (heavyRoot: the main checkout, which the CLI passes; else this one).
 * { value } or { busy: message } when the lock (or free memory) stayed busy. heavy: false runs fn as it is.
 * Inside a holder (a full verify, the Unity land gate, an outer gate()) it doesn't wait for its own parent.
 */
export function underHeavy(label, fn, { heavy = true, heavyRoot = REPO_ROOT, log = (m) => console.error(m) } = {}) {
  if (heavy === false) return { value: fn() };
  try {
    return { value: withHeavy(heavyRoot, label, fn, { log }) };
  } catch (err) {
    if (err.code === 'HEAVY_BUSY') return { busy: String(err.message || err).replace(/^\[heavy\]\s*/, '') };
    throw err;
  }
}

/** The sim with plain .NET: purity, then `dotnet test tools/SimTests`. */
export function runSim(dir, { log = console.log } = {}) {
  const p = simPurity(dir);
  if (!p.ok) return { ok: false, step: 'purity', problems: p.problems };
  log(`[unity] sim purity: ${p.files} file(s) in ${rel(path.join(dir, 'Assets/Sim'))}, nothing banned`);
  const proj = path.join(dir, 'tools', 'SimTests');
  if (!fs.existsSync(proj)) return { ok: false, step: 'tests', problems: [`${rel(proj)} is missing: the sim's .NET test project (copy it from engine/_unity/tools/SimTests)`] };
  if (!which(dotnetBin())) return { ok: false, step: 'tests', problems: [`.NET isn't installed (dotnet not on the PATH; or set STUDIO_DOTNET): the sim's tests need the .NET 8 SDK, not Unity`] };
  const results = path.join(proj, 'TestResults');
  fs.rmSync(results, { recursive: true, force: true });
  const r = spawnSync(dotnetBin(), ['test', proj, '--logger', 'trx;LogFileName=sim.trx', '--results-directory', results], { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' }, timeout: 10 * 60000, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  // Counted from the run's own results file, so "nothing ran" can't pass.
  const trx = read(path.join(results, 'sim.trx')) || '';
  const c = trx.match(/<Counters\b([^>]*)>/);
  const n = (k) => Number(((c?.[1] || '').match(new RegExp(`\\b${k}="(\\d+)"`)) || [])[1] || 0);
  const total = n('total');
  const failed = n('failed') + n('error') + n('timeout') + n('aborted');
  const problems = [];
  if (r.status !== 0 && !failed) problems.push(`dotnet test failed (exit ${r.status}): ${out.trim().split('\n').filter((l) => /error|Error/.test(l)).slice(0, 4).join(' | ') || out.trim().split('\n').slice(-3).join(' | ')}`);
  if (failed) problems.push(`${failed} of ${total} sim test(s) failed: ${out.split('\n').filter((l) => /^\s*Failed\s/.test(l)).map((l) => l.trim()).slice(0, 5).join('; ')}`);
  if (!total && !problems.length) problems.push('no sim test ran: an empty run is not a check (add tests in Assets/Tests/EditMode)');
  return { ok: problems.length === 0, step: 'tests', total, failed, problems, out };
}

/** Unity's test runner in batch mode, one platform: { ok, platform, results, problems, log }. */
export function runUnityTests(dir, platform, { controlsOut = null, ...heavyOpts } = {}) {
  const resultsFile = path.join(dir, `TestResults-${platform}.xml`);
  fs.rmSync(resultsFile, { force: true });
  const args = ['-batchmode', '-nographics', '-projectPath', dir, '-runTests', '-testPlatform', platform, '-testResults', resultsFile, '-logFile', '-'];
  // Under machine:heavy (2.60.1, B-35); STUDIO_HEAVY_HELD (set while held) reaches the editor's own children.
  const h = underHeavy(`unity ${platform} tests (${rel(dir) || '.'})`, () => spawnSync(unityBin(), args, { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, ...(controlsOut ? { STUDIO_CONTROLS_OUT: controlsOut } : {}) }, timeout: 30 * 60000, maxBuffer: 256 * 1024 * 1024 }), heavyOpts);
  if (h.busy) return { ok: false, busy: true, platform, results: null, problems: [`${platform}: did not run: ${h.busy}`], log: '' };
  const r = h.value;
  const log = `${r.stdout || ''}${r.stderr || ''}`;
  const problems = [];
  if (/No valid Unity Editor license|License is not active|Failed to activate|com\.unity\.editor\.headless/i.test(log)) problems.push('the editor has no active licence on this machine (activate one in Unity Hub; CI needs the UNITY_LICENSE secret)');
  const res = parseNUnit(read(resultsFile));
  if (!res) problems.push(`${platform}: no test results written (exit ${r.status})${/error CS\d+/.test(log) ? `; compile errors: ${[...new Set(log.match(/[^\s]+\.cs\(\d+,\d+\): error CS\d+:[^\n]*/g) || [])].slice(0, 4).join(' | ')}` : ''}`);
  else {
    if (!res.total) problems.push(`${platform}: no test ran: an empty run is not a check`);
    for (const f of res.failures) problems.push(`${platform}: ${f.name} failed: ${f.message}`);
    if (res.failed && !res.failures.length) problems.push(`${platform}: ${res.failed} test(s) failed`);
  }
  const unhandled = (log.match(/Unhandled exception|NullReferenceException|MissingReferenceException/g) || []).length;
  if (unhandled && res && !res.failed) problems.push(`${platform}: ${unhandled} unhandled exception(s) in the log while the tests passed`);
  return { ok: problems.length === 0, platform, results: res, problems, log };
}

/**
 * A playable build (Assets/Editor/StudioBuild.cs): web (WebGL, played in a browser and on the Arcade's engine
 * tab) or windows (Build/Windows/Game.exe). Returns { ok, target, out, problems }.
 */
export function build(dir, target = 'windows', { out = null, ...heavyOpts } = {}) {
  const t = { web: ['WebGL', 'Build/WebGL'], webgl: ['WebGL', 'Build/WebGL'], windows: ['Windows', 'Build/Windows'] }[String(target).toLowerCase()];
  if (!t) return { ok: false, problems: [`unknown build target "${target}" (web or windows)`] };
  if (!fs.existsSync(path.join(dir, 'Assets', 'Editor', 'StudioBuild.cs'))) return { ok: false, problems: [`${rel(dir)}/Assets/Editor/StudioBuild.cs is missing (copy it from engine/_unity)`] };
  if (!which(unityBin())) return { ok: false, problems: [`the Unity editor isn't found (${unityBin()}): set STUDIO_UNITY to the editor's full path. A ${t[0]} build also needs that platform's module installed in Unity Hub.`] };
  const dest = path.resolve(dir, out || t[1]);
  // 2.67.1 (k): the warm Library is seeded before the editor and saved after a passing build (harness/unity-cache.mjs).
  const mainRoot = heavyOpts.heavyRoot || REPO_ROOT;
  const say = heavyOpts.log || ((m) => console.error(m));
  const h = underHeavy(`unity ${t[0]} build (${rel(dir) || '.'})`, () => {
    const seed = seedLibrary(dir, { mainRoot });
    if (seed.status !== 'off' && seed.status !== 'skipped') say(cacheLine(seed, 'before the editor'));
    const r = spawnSync(unityBin(), ['-batchmode', '-nographics', '-projectPath', dir, '-executeMethod', `StudioBuild.${t[0]}`, '-out', dest, '-logFile', '-'], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60 * 60000, maxBuffer: 256 * 1024 * 1024 });
    if (r.status === 0 && /\[build\] PASS/.test(`${r.stdout || ''}${r.stderr || ''}`)) {
      const saved = saveLibrary(dir, { mainRoot });
      if (saved.status !== 'off' && saved.status !== 'skipped') say(cacheLine(saved, 'after the passing build'));
    }
    return r;
  }, heavyOpts);
  if (h.busy) return { ok: false, busy: true, target: t[0], out: rel(dest), problems: [`the ${t[0]} build did not start: ${h.busy}`] };
  const r = h.value;
  const log = `${r.stdout || ''}${r.stderr || ''}`;
  const line = (log.match(/\[build\] (?:PASS|FAIL)[^\n]*/) || [])[0];
  const problems = [];
  if (/No valid Unity Editor license|License is not active/i.test(log)) problems.push('the editor has no active licence on this machine');
  if (r.status !== 0 || !/\[build\] PASS/.test(log)) problems.push(`the ${t[0]} build failed (exit ${r.status})${line ? `: ${line}` : ''}${/error CS\d+/.test(log) ? `; compile errors: ${[...new Set(log.match(/[^\s]+\.cs\(\d+,\d+\): error CS\d+:[^\n]*/g) || [])].slice(0, 3).join(' | ')}` : ''}`);
  return { ok: problems.length === 0, target: t[0], out: rel(dest), problems, line };
}

/**
 * 2.67.1 (k): the editor-free steps of a Unity-track check, from studio/game.json engines.unity "codeOnly" (a command
 * or a list; {folder} is the project; "codeOnly": [] or false: none), else `dotnet test tools/SimTests` when the
 * project has that .NET test project. [{ kind: 'command', cmd } | { kind: 'dotnet' }].
 */
export function codeOnlySteps(dir, { root = REPO_ROOT, env = process.env } = {}) {
  if (/^(off|0|false|no)$/i.test(String(env.STUDIO_UNITY_CODE_ONLY || ''))) return [];
  let cfg = {};
  try { cfg = JSON.parse(read(path.join(root, 'studio', 'game.json')) || '{}')?.engines?.unity || {}; } catch { cfg = {}; }
  const c = cfg.codeOnly;
  if (c === false || (Array.isArray(c) && !c.length)) return [];
  const cmds = (typeof c === 'string' ? [c] : Array.isArray(c) ? c : []).filter((x) => typeof x === 'string' && x.trim());
  if (cmds.length) return cmds.map((cmd) => ({ kind: 'command', cmd: cmd.trim(), timeoutMin: Number(cfg.codeOnlyTimeoutMin || 20) }));
  return fs.existsSync(path.join(dir, 'tools', 'SimTests')) ? [{ kind: 'dotnet' }] : [];
}

/**
 * 2.67.1 (k): run the editor-free steps WITHOUT machine:heavy, before the editor waits for it: a lane gets its code
 * checks while another lane's editor run holds the machine, and a failure here stops before any wait for the editor.
 * { ok, ran, problems }.
 */
export function runCodeOnly(dir, { log = console.log, root = REPO_ROOT, env = process.env } = {}) {
  const steps = codeOnlySteps(dir, { root, env });
  const ran = [];
  for (const st of steps) {
    if (st.kind === 'dotnet') {
      if (!which(dotnetBin())) { log('[unity] note: the sim\'s .NET tests (tools/SimTests) need the .NET 8 SDK (dotnet, or STUDIO_DOTNET), which isn\'t here: skipped; the editor\'s Edit Mode tests still run'); continue; }
      const r = runSim(dir, { log: () => {} });
      ran.push('dotnet test tools/SimTests');
      log(`[gate] ${r.ok ? 'PASS' : 'FAIL'} code-only: dotnet test tools/SimTests${r.total ? ` (${r.total - (r.failed || 0)}/${r.total} passed)` : ''} (no editor, no machine:heavy)`);
      if (!r.ok) return { ok: false, ran, problems: r.problems.map((x) => `code-only (dotnet test): ${x}`) };
      continue;
    }
    const q = (s) => (/[\s"]/.test(s) ? `"${String(s).replace(/"/g, '\\"')}"` : s);
    const cmd = st.cmd.replaceAll('{folder}', q(dir));
    const t0 = Date.now();
    const r = spawnSync(cmd, { cwd: dir, shell: true, encoding: 'utf8', env: { ...env }, timeout: st.timeoutMin * 60000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    ran.push(st.cmd);
    const ok = r.status === 0 && !r.error;
    log(`[gate] ${ok ? 'PASS' : 'FAIL'} code-only: ${st.cmd} (${Math.round((Date.now() - t0) / 1000)} s; no editor, no machine:heavy)`);
    if (!ok) {
      const tail = `${r.stdout || ''}${r.stderr || ''}`.trimEnd().split('\n').slice(-8).join(' | ');
      return { ok: false, ran, problems: [`code-only step "${st.cmd}" failed (${r.error?.code === 'ETIMEDOUT' ? `timed out after ${st.timeoutMin} min` : `exit ${r.status}`}): ${tail || 'no output'}. The editor's tests did not run (they wait for machine:heavy only after the code-only steps pass)`] };
    }
  }
  return { ok: true, ran, problems: [] };
}

// 2.67.1 (k): a failed Play Mode run is retried once when its tests ran and failed (never a compile error, a missing
// results file, a licence problem or Edit Mode).
const retryOn = (env = process.env) => !/^(off|0|false|no)$/i.test(String(env.STUDIO_UNITY_PLAYMODE_RETRY || ''));
const compileErrors = (log) => /error CS\d+/.test(String(log || ''));
export const retryablePlayMode = (r) => Boolean(r && !r.ok && !r.busy && r.platform === 'PlayMode' && r.results && r.results.failed > 0 && !compileErrors(r.log) && !r.problems.some((x) => /licence/.test(x)));
const saveLog = (name, text) => {
  const f = path.join(REPO_ROOT, '.studio', 'gates', 'out', name);
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text || ''); } catch {}
  return rel(f);
};

/** 2.67.1 (k): record a Play Mode flake: <main checkout>/.studio/unity-flakes.jsonl and a unity.flake event. */
export function recordFlake(mainRoot, rec) {
  const f = path.join(mainRoot, '.studio', 'unity-flakes.jsonl');
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, `${JSON.stringify(rec)}\n`); } catch {}
  try { emitEvent({ type: 'unity.flake', agent: process.env.STUDIO_LOCK_OWNER || 'unity', status: 'warn', msg: `Unity Play Mode flaked in ${rec.project}: ${rec.tests.join(', ') || 'a test'} failed, then passed on retry`.slice(0, 400), meta: { project: rec.project, tests: rec.tests.slice(0, 20), logs: rec.logs } }); } catch {}
  return rel(f);
}

/**
 * The editor's gate: purity, pin, the code-only steps (no machine:heavy; 2.67.1), then Edit Mode and Play Mode tests
 * under one machine:heavy hold, with the warm Library seeded first and saved after a green run (harness/unity-cache.mjs)
 * and one retry for a Play Mode test failure (a pass on retry is green with a flake record). { ok, problems, flakes }.
 */
export function gate(dir, { platforms = ['EditMode', 'PlayMode'], log = console.log, env = process.env, ...heavyOpts } = {}) {
  const problems = [];
  const flakes = [];
  const p = simPurity(dir);
  if (!p.ok) return { ok: false, problems: p.problems };
  const pin = checkPin(dir);
  if (!pin.ok) return { ok: false, problems: [pin.why] };
  if (pin.note) log(`[unity] note: ${pin.note}`);
  // 2.67.1 (k): code-only first, without the lock; a failure stops here, before any wait for the editor.
  const co = runCodeOnly(dir, { log, env });
  if (!co.ok) return { ok: false, codeOnly: co, problems: co.problems };
  if (!which(unityBin())) return { ok: false, problems: [`the Unity editor isn't found (${unityBin()}): install Unity ${pin.version} with Unity Hub and set STUDIO_UNITY to the editor's full path (Windows: C:\\Program Files\\Unity\\Hub\\Editor\\${pin.version}\\Editor\\Unity.exe). The sim's checks need no editor: npm run engine:sim`] };
  const controlsOut = path.join(REPO_ROOT, 'qa', 'reports', 'controls-unity.json');
  const mainRoot = heavyOpts.heavyRoot || REPO_ROOT;
  let cache = null;
  // One machine:heavy hold for every platform (no other heavy job slips in between Edit Mode and Play Mode).
  const h = underHeavy(`unity gate ${platforms.join('+')} (${rel(dir) || '.'})`, () => {
    const seed = seedLibrary(dir, { mainRoot, env });
    if (seed.status !== 'off' && seed.status !== 'skipped') log(cacheLine(seed, 'before the editor'));
    for (const platform of platforms) {
      const opts = { controlsOut: platform === 'PlayMode' ? controlsOut : null, ...heavyOpts };
      let r = runUnityTests(dir, platform, opts);
      if (retryablePlayMode(r) && retryOn(env)) {
        const first = r;
        const logs = [saveLog(`unity-${platform}-try1.log`, first.log)];
        log(`[gate] FAIL ${platform}: ${first.results.failed}/${first.results.total} failed; retrying once (a Play Mode failure gets one retry; STUDIO_UNITY_PLAYMODE_RETRY=off turns it off)`);
        r = runUnityTests(dir, platform, opts);
        logs.push(saveLog(`unity-${platform}-try2.log`, r.log));
        const tests = first.results.failures.map((f) => f.name);
        if (r.ok) {
          const rec = { at: new Date().toISOString(), project: rel(dir) || '.', platform, tests, first: { result: 'failed', failed: first.results.failed, total: first.results.total, failures: first.results.failures }, second: { result: 'passed', passed: r.results?.passed ?? null, total: r.results?.total ?? null }, logs };
          const where = recordFlake(mainRoot, rec);
          flakes.push(rec);
          log(`[gate] WARN ${platform} flaked: ${tests.join(', ') || `${first.results.failed} test(s)`} failed, then passed on retry: counted green, recorded in ${where} (logs: ${logs.join(', ')})`);
        } else {
          log(`[gate] FAIL ${platform} again on retry: red (logs: ${logs.join(', ')})`);
        }
      }
      log(`[gate] ${r.ok ? 'PASS' : 'FAIL'} ${platform}${r.results ? `: ${r.results.passed}/${r.results.total} passed` : ''}${r.ok && flakes.some((f) => f.platform === platform) ? ' (on retry)' : ''}`);
      problems.push(...r.problems);
      if (r.problems.some((x) => /licence/.test(x))) break;
    }
    if (!problems.length) {
      const saved = saveLibrary(dir, { mainRoot, env });
      if (saved.status !== 'off' && saved.status !== 'skipped') log(cacheLine(saved, 'after the green run'));
      cache = { seed, saved };
    } else cache = { seed };
  }, heavyOpts);
  if (h.busy) return { ok: false, busy: true, codeOnly: co, problems: [`the editor's tests did not run: ${h.busy}`] };
  return { ok: problems.length === 0, problems, flakes, codeOnly: co, cache };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const [cmd, folderArg] = process.argv.slice(2);
  const flag = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
  let folder = folderArg && !folderArg.startsWith('--') ? folderArg : null;
  let track = null;
  try { const { readTrack } = await import('./engine.mjs'); track = readTrack(); } catch {}
  if (!folder) folder = track?.engine === 'unity' ? track.folder : null;
  if (!folder) {
    console.log('[unity] no Unity project given and no Unity engine track: nothing to check');
    process.exit(0);
  }
  const dir = path.resolve(REPO_ROOT, folder);
  if (!isUnityProject(dir)) { console.error(`[unity] FAIL ${folder} is not a Unity project (no ProjectSettings/ProjectVersion.txt)`); process.exit(1); }
  const fail = (problems, code = 1) => { for (const p of problems) console.error(`[unity] ${code === 3 ? 'BUSY' : 'FAIL'} ${p}`); process.exit(code); };
  // 2.60.1 (B-35): the editor's runs take machine:heavy in the main checkout (lane copies share its lock).
  let heavyRoot = REPO_ROOT;
  try { heavyRoot = await (await import('./heavy.mjs')).heavyRoot(); } catch {}
  if (cmd === 'purity') {
    const r = simPurity(dir);
    if (!r.ok) fail(r.problems);
    console.log(`[unity] PASS sim purity: ${r.files} file(s), nothing banned`);
  } else if (cmd === 'version') {
    const r = checkPin(dir);
    if (!r.ok) fail([r.why]);
    console.log(`[unity] PASS the project asks for Unity ${r.version}${r.note ? ` (${r.note})` : ''}`);
  } else if (cmd === 'sim') {
    const r = runSim(dir);
    if (!r.ok) fail(r.problems);
    console.log(`[unity] PASS sim: ${r.total} test(s) passed with .NET (no editor needed)`);
  } else if (cmd === 'gate') {
    const pf = flag('platform');
    const t0 = Date.now();
    const r = gate(dir, { platforms: pf ? [pf] : undefined, heavyRoot });
    // 2.65.0: the uniform job.done (harness/jobs.mjs) for the editor's tests.
    try { (await import('./jobs.mjs')).jobDone({ kind: 'unity-test', id: folder, code: r.ok ? 0 : r.busy ? 3 : 1, result: r.ok ? 'pass' : r.busy ? 'busy' : 'fail', ms: Date.now() - t0, tail: (r.problems || []).join(' | ') }); } catch {}
    if (!r.ok) fail(r.problems, r.busy ? 3 : 1);
    // 2.67.1 (k): a pass on retry is green, with a warning naming the flaky tests.
    for (const f of r.flakes || []) console.log(`[unity] WARN flaky ${f.platform} test(s): ${f.tests.join(', ') || '?'} failed once, passed on retry (.studio/unity-flakes.jsonl)`);
    console.log(`[unity] PASS the editor's tests (Edit Mode and Play Mode)${r.flakes?.length ? ' (with a flake: see the warning)' : ''}`);
  } else if (cmd === 'build') {
    // 2.47.0: the track's buildTarget (npm run engine -- link unity <repo> --build windows) is the default.
    const t0 = Date.now();
    const r = build(dir, flag('target') || track?.buildTarget || 'windows', { out: flag('out'), heavyRoot });
    // 2.65.0: the uniform job.done (harness/jobs.mjs) for a build.
    try { (await import('./jobs.mjs')).jobDone({ kind: 'unity-build', id: `${r.target || flag('target') || 'build'} ${folder}`, code: r.ok ? 0 : r.busy ? 3 : 1, result: r.ok ? 'pass' : r.busy ? 'busy' : 'fail', ms: Date.now() - t0, tail: (r.problems || []).join(' | '), log: r.out || null }); } catch {}
    if (!r.ok) fail(r.problems, r.busy ? 3 : 1);
    console.log(`[unity] PASS ${r.target} build: ${r.out}${r.target === 'WebGL' ? ' (the Arcade\'s engine tab plays it; or serve the folder and open index.html)' : ''}`);
  } else {
    console.error('usage: node harness/unity.mjs sim|gate|build|purity|version [<folder>] [--platform EditMode|PlayMode] [--target web|windows]');
    process.exit(2);
  }
}
