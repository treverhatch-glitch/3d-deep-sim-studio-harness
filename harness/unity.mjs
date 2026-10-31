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
 *   npm run engine:build [-- <folder>] [--target web|windows]
 *                                        a playable build: WebGL (the Arcade's engine tab, any browser) or a
 *                                        Windows .exe (Assets/Editor/StudioBuild.cs)
 *   node harness/unity.mjs purity <folder>
 *   node harness/unity.mjs version <folder>
 *
 * The folder is a Unity project (ProjectSettings/ProjectVersion.txt): engine/<game> for an engine track, or
 * game/<slug> for an adopted Unity game. The editor: STUDIO_UNITY (its full path) or `unity` on the PATH.
 *
 * Why the sim is checked apart from the editor: the editor needs an install and a licence on every machine
 * that runs it, so an agent's every change can't wait for it. The sim is a pure C# assembly
 * (Assets/Sim, Sim.asmdef with noEngineReferences), so .NET builds and tests it anywhere in seconds, and the
 * purity check keeps it that way: no UnityEngine, no Time, no unseeded Random, no wall clock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from './event.mjs';

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
export function runUnityTests(dir, platform, { controlsOut = null } = {}) {
  const resultsFile = path.join(dir, `TestResults-${platform}.xml`);
  fs.rmSync(resultsFile, { force: true });
  const args = ['-batchmode', '-nographics', '-projectPath', dir, '-runTests', '-testPlatform', platform, '-testResults', resultsFile, '-logFile', '-'];
  const env = { ...process.env, ...(controlsOut ? { STUDIO_CONTROLS_OUT: controlsOut } : {}) };
  const r = spawnSync(unityBin(), args, { cwd: REPO_ROOT, encoding: 'utf8', env, timeout: 30 * 60000, maxBuffer: 256 * 1024 * 1024 });
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
export function build(dir, target = 'web', { out = null } = {}) {
  const t = { web: ['WebGL', 'Build/WebGL'], webgl: ['WebGL', 'Build/WebGL'], windows: ['Windows', 'Build/Windows'] }[String(target).toLowerCase()];
  if (!t) return { ok: false, problems: [`unknown build target "${target}" (web or windows)`] };
  if (!fs.existsSync(path.join(dir, 'Assets', 'Editor', 'StudioBuild.cs'))) return { ok: false, problems: [`${rel(dir)}/Assets/Editor/StudioBuild.cs is missing (copy it from engine/_unity)`] };
  if (!which(unityBin())) return { ok: false, problems: [`the Unity editor isn't found (${unityBin()}): set STUDIO_UNITY to the editor's full path. A ${t[0]} build also needs that platform's module installed in Unity Hub.`] };
  const dest = path.resolve(dir, out || t[1]);
  const r = spawnSync(unityBin(), ['-batchmode', '-nographics', '-projectPath', dir, '-executeMethod', `StudioBuild.${t[0]}`, '-out', dest, '-logFile', '-'], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60 * 60000, maxBuffer: 256 * 1024 * 1024 });
  const log = `${r.stdout || ''}${r.stderr || ''}`;
  const line = (log.match(/\[build\] (?:PASS|FAIL)[^\n]*/) || [])[0];
  const problems = [];
  if (/No valid Unity Editor license|License is not active/i.test(log)) problems.push('the editor has no active licence on this machine');
  if (r.status !== 0 || !/\[build\] PASS/.test(log)) problems.push(`the ${t[0]} build failed (exit ${r.status})${line ? `: ${line}` : ''}${/error CS\d+/.test(log) ? `; compile errors: ${[...new Set(log.match(/[^\s]+\.cs\(\d+,\d+\): error CS\d+:[^\n]*/g) || [])].slice(0, 3).join(' | ')}` : ''}`);
  return { ok: problems.length === 0, target: t[0], out: rel(dest), problems, line };
}

/** The editor's gate: purity, pin, Edit Mode and Play Mode tests. */
export function gate(dir, { platforms = ['EditMode', 'PlayMode'], log = console.log } = {}) {
  const problems = [];
  const p = simPurity(dir);
  if (!p.ok) return { ok: false, problems: p.problems };
  const pin = checkPin(dir);
  if (!pin.ok) return { ok: false, problems: [pin.why] };
  if (pin.note) log(`[unity] note: ${pin.note}`);
  if (!which(unityBin())) return { ok: false, problems: [`the Unity editor isn't found (${unityBin()}): install Unity ${pin.version} with Unity Hub and set STUDIO_UNITY to the editor's full path (Windows: C:\\Program Files\\Unity\\Hub\\Editor\\${pin.version}\\Editor\\Unity.exe). The sim's checks need no editor: npm run engine:sim`] };
  const controlsOut = path.join(REPO_ROOT, 'qa', 'reports', 'controls-unity.json');
  for (const platform of platforms) {
    const r = runUnityTests(dir, platform, { controlsOut: platform === 'PlayMode' ? controlsOut : null });
    log(`[gate] ${r.ok ? 'PASS' : 'FAIL'} ${platform}${r.results ? `: ${r.results.passed}/${r.results.total} passed` : ''}`);
    problems.push(...r.problems);
    if (r.problems.some((x) => /licence/.test(x))) break;
  }
  return { ok: problems.length === 0, problems };
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
  const fail = (problems) => { for (const p of problems) console.error(`[unity] FAIL ${p}`); process.exit(1); };
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
    const r = gate(dir, { platforms: pf ? [pf] : undefined });
    if (!r.ok) fail(r.problems);
    console.log('[unity] PASS the editor\'s tests (Edit Mode and Play Mode)');
  } else if (cmd === 'build') {
    // 2.47.0: the track's buildTarget (npm run engine -- link unity <repo> --build windows) is the default.
    const r = build(dir, flag('target') || track?.buildTarget || 'web', { out: flag('out') });
    if (!r.ok) fail(r.problems);
    console.log(`[unity] PASS ${r.target} build: ${r.out}${r.target === 'WebGL' ? ' (the Arcade\'s engine tab plays it; or serve the folder and open index.html)' : ''}`);
  } else {
    console.error('usage: node harness/unity.mjs sim|gate|build|purity|version [<folder>] [--platform EditMode|PlayMode] [--target web|windows]');
    process.exit(2);
  }
}
