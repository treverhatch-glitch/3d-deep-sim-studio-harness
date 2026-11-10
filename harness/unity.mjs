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
 *   node harness/unity.mjs accelerator [<folder>]   2.70.0: does STUDIO_UNITY_ACCELERATOR answer (a TCP connect)
 *   gate and build exit 3 when machine:heavy (or free memory) stayed busy and the editor didn't run.
 *   2.73.2 (e, B-73): gate also exits 3, "NOT RUN <kind>", for an infrastructure abort (the editor ran out of memory,
 *   was ended from outside, couldn't start, had no licence, or aborted batch mode before it wrote results; or free RAM
 *   stayed under STUDIO_UNITY_MIN_FREE_GB): nothing was tested, so it is never a FAIL of the game's tests. A compile
 *   error or a failing test is always a FAIL (exit 1).
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
import { JOB_KINDS } from './heavy-budget.mjs';
import { seedLibrary, saveLibrary, cacheLine } from './unity-cache.mjs';
import { runNonce, freshFile, logSignatures, exitAgrees, proofLine, kindsOf, infraAbort, notRunLine } from './engine-proof.mjs';

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const num = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
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

const which = (bin) => fs.existsSync(bin) || spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { windowsHide: true, encoding: 'utf8' }).status === 0;
export const unityBin = () => process.env.STUDIO_UNITY || 'unity';
export const dotnetBin = () => process.env.STUDIO_DOTNET || 'dotnet';

/**
 * 2.60.1 (B-35): run fn under machine:heavy (heavyRoot: the main checkout, which the CLI passes; else this one).
 * { value } or { busy: message } when the lock (or free memory) stayed busy. heavy: false runs fn as it is.
 * Inside a holder (a full verify, the Unity land gate, an outer gate()) it doesn't wait for its own parent.
 */
export function underHeavy(label, fn, { heavy = true, heavyRoot = REPO_ROOT, log = (m) => console.error(m), vramGb } = {}) {
  if (heavy === false) return { value: fn() };
  try {
    // 2.70.0 (u): vramGb (the Graphics split's device run) claims the GPU area; unset: the unity kind's own claim.
    return { value: withHeavy(heavyRoot, label, fn, { log, kind: 'unity', ...(vramGb !== undefined ? { vramGb } : {}) }) };
  } catch (err) {
    // 2.73.2 (e, B-73): floor: free RAM stayed under STUDIO_UNITY_MIN_FREE_GB (else the lock stayed busy).
    if (err.code === 'HEAVY_BUSY') return { busy: String(err.message || err).replace(/^\[heavy\]\s*(NOT RUN\s*)?/, ''), floor: Boolean(err.floor) };
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
  const r = spawnSync(dotnetBin(), ['test', proj, '--logger', 'trx;LogFileName=sim.trx', '--results-directory', results], { windowsHide: true, cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' }, timeout: 10 * 60000, maxBuffer: 64 * 1024 * 1024 });
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

/**
 * Unity's test runner in batch mode, one platform: { ok, platform, results, problems, log }.
 * 2.70.0 (u): extraArgs (the Accelerator's), category (-testCategory, e.g. "!Graphics"), graphics: true starts the
 * editor with a graphics device (no -nographics), suffix names the results file (TestResults-<platform><suffix>.xml).
 */
export function runUnityTests(dir, platform, { controlsOut = null, extraArgs = [], category = null, graphics = false, suffix = '', allowEmpty = false, ...heavyOpts } = {}) {
  // 2.72.0 (c): this run's nonce is in the results file's name, and older results files for this platform are removed
  // first: no file another run wrote can stand in for this one (harness/engine-proof.mjs).
  const nonce = runNonce();
  const resultsFile = path.join(dir, `TestResults-${platform}${suffix}-${nonce}.xml`);
  removeOldResults(dir, `${platform}${suffix}`);
  let startedAt = null;
  const args = (file) => ['-batchmode', ...(graphics ? [] : ['-nographics']), '-projectPath', dir, '-runTests', '-testPlatform', platform, ...(category ? ['-testCategory', category] : []), '-testResults', file, '-logFile', '-', ...extraArgs];
  // Under machine:heavy (2.60.1, B-35); STUDIO_HEAVY_HELD (set while held) reaches the editor's own children.
  const h = underHeavy(`unity ${platform} tests (${rel(dir) || '.'})`, () => { startedAt = Date.now(); return spawnSync(unityBin(), args(resultsFile), { windowsHide: true, cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, ...(controlsOut ? { STUDIO_CONTROLS_OUT: controlsOut } : {}) }, timeout: 30 * 60000, maxBuffer: 256 * 1024 * 1024 }); }, heavyOpts);
  if (h.busy) return { ok: false, busy: true, platform, results: null, problems: [`${platform}: did not run: ${h.busy}`], log: '', notRun: { kind: h.floor ? 'ram-floor' : 'busy', text: `${platform}: ${h.busy}` } };
  const r = h.value;
  return { ...judgeRun(platform, resultsFile, `${r.stdout || ''}${r.stderr || ''}`, r.status, { startedAt, allowEmpty, signal: r.signal || (r.error?.code === 'ETIMEDOUT' ? 'timeout' : null), spawnError: r.error || null }), resultsFile: rel(resultsFile) };
}

/** 2.72.0 (c): remove the results files earlier runs left for one platform (TestResults-<platform>[-<nonce>].xml). */
function removeOldResults(dir, stem) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  const re = new RegExp(`^TestResults-${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:-[0-9a-z]+-[0-9a-f]{8})?\\.xml$`);
  for (const n of names) if (re.test(n)) { try { fs.rmSync(path.join(dir, n), { force: true }); } catch {} }
}

/**
 * 2.72.0 (c): may a platform's run count 0 tests? studio/game.json engines.unity "allowEmpty": true (every platform) or a
 * list of platforms (["PlayMode"]). Default: no (an empty run is not a check).
 */
export function unityAllowEmpty(platform, { root = REPO_ROOT } = {}) {
  let v = null;
  try { v = JSON.parse(read(path.join(root, 'studio', 'game.json')) || '{}')?.engines?.unity?.allowEmpty; } catch { v = null; }
  return v === true || (Array.isArray(v) && v.map(String).includes(platform));
}

/**
 * A run's NUnit results and log, judged: { ok, platform, results, problems, proof, log }. unhandled: count exceptions in
 * the log. 2.72.0 (c), harness/engine-proof.mjs: startedAt (the run's start; a results file older than it was not
 * written by this run), allowEmpty (0 tests may pass), signal (the run was killed). `proof` lists each failure's kind.
 */
export function judgeRun(platform, resultsFile, log, status, { unhandled: countUnhandled = true, startedAt = null, allowEmpty = false, signal = null, spawnError = null } = {}) {
  const problems = [];
  const proof = [];
  const add = (kind, text, shown = text) => { proof.push({ kind, text: `${platform}: ${text}` }); if (shown) problems.push(shown); };
  const sigs = logSignatures(log, 'unity');
  if (sigs.some((x) => x.kind === 'licence')) add('licence', sigs.find((x) => x.kind === 'licence').text, 'the editor has no active licence on this machine (activate one in Unity Hub; CI needs the UNITY_LICENSE secret)');
  let noFile = false;
  const fresh = startedAt ? freshFile(resultsFile, startedAt) : { ok: true };
  let res = parseNUnit(read(resultsFile));
  if (res && !fresh.ok) {
    add('stale-results', `the results file ${path.basename(resultsFile)} was not written by this run (${fresh.why}): an earlier run's results don't stand for this one`);
    res = null;
  } else if (!res) {
    noFile = true;
    const ce = /error CS\d+/.test(log) ? `; compile errors: ${[...new Set(log.match(/[^\s]+\.cs\(\d+,\d+\): error CS\d+:[^\n]*/g) || [])].slice(0, 4).join(' | ')}` : '';
    add('no-results', `no test results written (exit ${status})`, `${platform}: no test results written (exit ${status})${ce}`);
    if (ce) proof.push({ kind: 'compile-error', text: `${platform}: ${sigs.find((x) => x.kind === 'compile-error')?.text || 'compile errors'}` });
  }
  if (res) {
    if (!res.total && !allowEmpty) add('empty-run', 'no test ran: an empty run is not a check', `${platform}: no test ran: an empty run is not a check`);
    for (const f of res.failures) add('test-failed', `${f.name} failed: ${f.message}`, `${platform}: ${f.name} failed: ${f.message}`);
    if (res.failed && !res.failures.length) add('test-failed', `${res.failed} test(s) failed`, `${platform}: ${res.failed} test(s) failed`);
    // A results file next to compile errors or a batch-mode abort: the log says the run is not what the file says.
    const ce = sigs.find((x) => x.kind === 'compile-error');
    if (ce) add('compile-error', `${ce.text} (while a results file was written: the tests may have run against an older build)`, `${platform}: ${ce.text} (while a results file was written: the tests may have run against an older build)`);
    if (res.total || res.failed) {
      const ex = exitAgrees(status, res, { signal });
      if (!ex.ok) add('exit-mismatch', ex.why, `${platform}: ${ex.why}`);
    }
  }
  const ab = sigs.find((x) => x.kind === 'aborted');
  if (ab) add('aborted', ab.text, `${platform}: ${ab.text}`);
  // 2.73.2 (e, B-73): an infrastructure abort (out of memory, killed, no licence, couldn't start, aborted before any
  // results) is NOT RUN: nothing was tested. Never when the log shows a compile error or a test failed (those stay FAIL).
  // 2.80 (f, patch #28): no results file at all (the editor died under RAM pressure) is the environment's, never the lane's
  // (a compile error in the log or our own timeout stays a FAIL: infraAbort returns null for those only when they show).
  const infra = infraAbort({ log, status, signal, spawnError, results: res, timedOut: signal === 'timeout', engine: 'unity' })
    || (noFile && signal !== 'timeout' && !/error CS\d+/.test(log) ? { kind: 'no-results', text: `the editor wrote no test results (exit ${status ?? signal ?? '?'}): it died or was killed before the tests finished` } : null);
  if (infra) {
    const text = `${platform}: ${infra.text}`;
    return { ok: false, notRun: { kind: infra.kind, text }, platform, results: res, problems: [`${platform}: not run (${infra.kind}): ${infra.text}`], proof: [{ kind: infra.kind, text, notRun: true }], log };
  }
  const unhandled = countUnhandled ? (log.match(/Unhandled exception|NullReferenceException|MissingReferenceException/g) || []).length : 0;
  if (unhandled && res && !res.failed) problems.push(`${platform}: ${unhandled} unhandled exception(s) in the log while the tests passed`);
  return { ok: problems.length === 0, platform, results: res, problems, proof, log, ...(res && !res.total && allowEmpty ? { note: `${platform}: 0 tests ran, allowed by studio/game.json engines.unity.allowEmpty` } : {}) };
}

/**
 * A playable build (Assets/Editor/StudioBuild.cs): web (WebGL, played in a browser and on the Arcade's engine
 * tab) or windows (Build/Windows/Game.exe). Returns { ok, target, out, problems }.
 */
export function build(dir, target = 'windows', { out = null, release = false, env = process.env, ...heavyOpts } = {}) {
  const t = { web: ['WebGL', 'Build/WebGL'], webgl: ['WebGL', 'Build/WebGL'], windows: ['Windows', 'Build/Windows'] }[String(target).toLowerCase()];
  if (!t) return { ok: false, problems: [`unknown build target "${target}" (web or windows)`] };
  if (!fs.existsSync(path.join(dir, 'Assets', 'Editor', 'StudioBuild.cs'))) return { ok: false, problems: [`${rel(dir)}/Assets/Editor/StudioBuild.cs is missing (copy it from engine/_unity)`] };
  if (!which(unityBin())) return { ok: false, problems: [`the Unity editor isn't found (${unityBin()}): set STUDIO_UNITY to the editor's full path. A ${t[0]} build also needs that platform's module installed in Unity Hub.`] };
  const dest = path.resolve(dir, out || t[1]);
  // 2.67.1 (k): the warm Library is seeded before the editor and saved after a passing build (harness/unity-cache.mjs).
  const mainRoot = heavyOpts.heavyRoot || REPO_ROOT;
  const say = heavyOpts.log || ((m) => console.error(m));
  // 2.70.0 (u): the Accelerator (probed once, before the wait) and the landing build options.
  const acc = accelerator(dir, { env });
  say(`[unity] ${acc.line}`);
  const speed = buildSpeedArgs(env, { release });
  for (const n of speed.notes) say(`[unity] ${n}`);
  const h = underHeavy(`unity ${t[0]} build (${rel(dir) || '.'})`, () => {
    const seed = seedLibrary(dir, { mainRoot });
    if (seed.status !== 'off' && seed.status !== 'skipped') say(cacheLine(seed, 'before the editor'));
    const r = spawnSync(unityBin(), ['-batchmode', '-nographics', '-projectPath', dir, '-executeMethod', `StudioBuild.${t[0]}`, '-out', dest, ...speed.args, '-logFile', '-', ...acc.args], { windowsHide: true, cwd: REPO_ROOT, encoding: 'utf8', timeout: 60 * 60000, maxBuffer: 256 * 1024 * 1024 });
    if (r.status === 0 && /\[build\] PASS/.test(`${r.stdout || ''}${r.stderr || ''}`)) {
      const saved = saveLibrary(dir, { mainRoot });
      if (saved.status !== 'off' && saved.status !== 'skipped') say(cacheLine(saved, 'after the passing build'));
    }
    return r;
  }, heavyOpts);
  if (h.busy) return { ok: false, busy: true, target: t[0], out: rel(dest), accelerator: acc, problems: [`the ${t[0]} build did not start: ${h.busy}`] };
  const r = h.value;
  const log = `${r.stdout || ''}${r.stderr || ''}`;
  const line = (log.match(/\[build\] (?:PASS|FAIL)[^\n]*/) || [])[0];
  const problems = [];
  if (/No valid Unity Editor license|License is not active/i.test(log)) problems.push('the editor has no active licence on this machine');
  if (r.status !== 0 || !/\[build\] PASS/.test(log)) problems.push(`the ${t[0]} build failed (exit ${r.status})${line ? `: ${line}` : ''}${/error CS\d+/.test(log) ? `; compile errors: ${[...new Set(log.match(/[^\s]+\.cs\(\d+,\d+\): error CS\d+:[^\n]*/g) || [])].slice(0, 3).join(' | ')}` : ''}`);
  return { ok: problems.length === 0, target: t[0], out: rel(dest), problems, line, accelerator: acc, speed: speed.args };
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
  let dotnet = null; // 2.70.0 (u): the dotnet step's result, so the editor's Edit Mode run can be skipped when it covered it
  for (const st of steps) {
    if (st.kind === 'dotnet') {
      if (!which(dotnetBin())) { log('[unity] note: the sim\'s .NET tests (tools/SimTests) need the .NET 8 SDK (dotnet, or STUDIO_DOTNET), which isn\'t here: skipped; the editor\'s Edit Mode tests still run'); continue; }
      const r = runSim(dir, { log: () => {} });
      ran.push('dotnet test tools/SimTests');
      dotnet = { ok: r.ok, total: r.total || 0, failed: r.failed || 0 };
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
  return { ok: true, ran, problems: [], dotnet };
}

// 2.67.1 (k): a failed Play Mode run is retried once when its tests ran and failed (never a compile error, a missing
// results file, a licence problem or Edit Mode).
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

// ---- 2.70.0 (u): Unity speed ---------------------------------------------------------------------------------------

const isOn = (v) => /^(on|1|true|yes)$/i.test(String(v || '').trim());
const isOff = (v) => /^(off|0|false|no)$/i.test(String(v || '').trim());

/**
 * The Unity Accelerator (a local cache server for import results, shader variants and texture compression):
 * STUDIO_UNITY_ACCELERATOR=<host:port> (default unset: off). { endpoint, namespace } or null. The namespace is the
 * project's Unity version, so a result made by another editor version is never reused (Unity warns cache hits can be
 * non-hermetic).
 */
export function acceleratorConfig(dir, env = process.env) {
  const v = String(env.STUDIO_UNITY_ACCELERATOR || '').trim();
  if (!v || isOff(v)) return null;
  const version = projectVersion(dir) || 'unknown';
  return { endpoint: v, namespace: `${version.replace(/[^A-Za-z0-9._-]+/g, '_')}` };
}

/** The editor arguments for an Accelerator config (every editor start: tests, build, any batch work). */
export const acceleratorArgs = (acc) => (acc ? ['-EnableCacheServer', '-cacheServerEndpoint', acc.endpoint, '-cacheServerEnableDownload', 'true', '-cacheServerEnableUpload', 'true', '-cacheServerNamespacePrefix', acc.namespace] : []);

/**
 * Does host:port answer a TCP connect within timeoutMs (STUDIO_UNITY_ACCELERATOR_TIMEOUT_MS, 1500)? Synchronous (a
 * short child node process), like the gate. { ok, ms, why }. Never throws.
 */
export function probeEndpoint(endpoint, { timeoutMs = num(process.env.STUDIO_UNITY_ACCELERATOR_TIMEOUT_MS, 1500) } = {}) {
  const m = String(endpoint || '').trim().match(/^\[?([^\]]+?)\]?:(\d{1,5})$/);
  if (!m) return { ok: false, ms: 0, why: `"${endpoint}" is not host:port` };
  const code = 'const net=require("net");const t0=Date.now();const s=net.connect({host:process.argv[1],port:Number(process.argv[2])});const done=(ok,why)=>{console.log(JSON.stringify({ok,ms:Date.now()-t0,why}));s.destroy();process.exit(0)};s.setTimeout(Number(process.argv[3]),()=>done(false,"no answer in "+process.argv[3]+" ms"));s.on("connect",()=>done(true,"answered"));s.on("error",(e)=>done(false,e.code||e.message));';
  const r = spawnSync(process.execPath, ['-e', code, m[1], m[2], String(timeoutMs)], { encoding: 'utf8', timeout: timeoutMs + 5000, windowsHide: true });
  try { return JSON.parse(String(r.stdout || '').trim().split('\n').pop()); } catch { return { ok: false, ms: 0, why: `the probe did not run (${r.error?.code || `exit ${r.status}`})` }; }
}

/**
 * The Accelerator for this run: probed once. { on, args, line }: unset or unreachable means off (the run goes on
 * without it and says so once); it never fails a gate or a build.
 */
export function accelerator(dir, { env = process.env, probe = probeEndpoint } = {}) {
  const acc = acceleratorConfig(dir, env);
  if (!acc) return { on: false, args: [], line: 'cache server off (STUDIO_UNITY_ACCELERATOR is not set)' };
  const p = probe(acc.endpoint);
  if (!p.ok) return { on: false, args: [], endpoint: acc.endpoint, line: `cache server off: the Accelerator at ${acc.endpoint} did not answer (${p.why}): running without it` };
  return { on: true, args: acceleratorArgs(acc), endpoint: acc.endpoint, line: `cache server on (Unity Accelerator ${acc.endpoint}, namespace ${acc.namespace}, answered in ${p.ms} ms)` };
}

const walkFiles = (root, ext, out = []) => {
  let ents = [];
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const f = path.join(root, e.name);
    if (e.isDirectory()) { if (!/~$|^\./.test(e.name)) walkFiles(f, ext, out); } else if (e.name.endsWith(ext)) out.push(f);
  }
  return out;
};
const readAsmdef = (f) => { try { return JSON.parse(read(f)); } catch { return null; } };
/** The asmdef that owns a file (the nearest one in its folder or above, up to Assets/), or null. */
function owningAsmdef(file, assets, cache = new Map()) {
  for (let d = path.dirname(file); d.length >= assets.length; d = path.dirname(d)) {
    if (!cache.has(d)) { let a = null; try { const n = fs.readdirSync(d).find((x) => x.endsWith('.asmdef')); if (n) a = { file: path.join(d, n), json: readAsmdef(path.join(d, n)) }; } catch {} cache.set(d, a); }
    if (cache.get(d)) return cache.get(d);
    if (d === path.dirname(d)) break;
  }
  return null;
}
const isTestAsmdef = (j) => Boolean(j && ((j.defineConstraints || []).includes('UNITY_INCLUDE_TESTS') || (j.references || []).some((r) => /TestRunner/.test(String(r))) || (j.optionalUnityReferences || []).includes('TestAssemblies')));
const isEditorOnly = (j) => Boolean(j && Array.isArray(j.includePlatforms) && j.includePlatforms.length === 1 && j.includePlatforms[0] === 'Editor');

/**
 * The project's test sources by platform: { EditMode: [files], PlayMode: [files] } (test assemblies: an asmdef with
 * UNITY_INCLUDE_TESTS or a TestRunner reference; Editor-only ones are Edit Mode). Tests outside any asmdef are left
 * out (Unity's default test assemblies need one).
 */
export function testSources(dir) {
  const assets = path.join(dir, 'Assets');
  const out = { EditMode: [], PlayMode: [] };
  const cache = new Map();
  for (const f of walkFiles(assets, '.cs')) {
    const a = owningAsmdef(f, assets, cache);
    if (!a || !isTestAsmdef(a.json)) continue;
    out[isEditorOnly(a.json) ? 'EditMode' : 'PlayMode'].push(f);
  }
  return out;
}

/** Test sources tagged [Category("Graphics")] (a grep of the test sources), by platform. */
export function graphicsTests(dir, sources = testSources(dir)) {
  const re = /\bCategory\s*\(\s*"Graphics"\s*\)/;
  // Comments removed (strings kept: the category is one).
  const pick = (files) => files.filter((f) => re.test((read(f) || '').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:"])\/\/[^\n]*/g, '$1')));
  return { EditMode: pick(sources.EditMode), PlayMode: pick(sources.PlayMode) };
}

/**
 * The Graphics split: STUDIO_UNITY_GRAPHICS_SPLIT=on|off (default: on when any test is tagged Graphics). On: each
 * platform with Graphics tests runs `-nographics -testCategory "!Graphics"`, then the Graphics tests in a second start
 * with a graphics device. { on, platforms: [platforms with Graphics tests], why }.
 */
export function graphicsSplit(dir, env = process.env) {
  const v = String(env.STUDIO_UNITY_GRAPHICS_SPLIT || '').trim();
  if (isOff(v)) return { on: false, platforms: [], why: 'STUDIO_UNITY_GRAPHICS_SPLIT=off' };
  const g = graphicsTests(dir);
  const platforms = ['EditMode', 'PlayMode'].filter((p) => g[p].length);
  if (!platforms.length) return { on: false, platforms: [], why: 'no test is tagged [Category("Graphics")]: every test runs with -nographics' };
  return { on: true, platforms, files: [...g.EditMode, ...g.PlayMode].map(rel), why: `${g.EditMode.length + g.PlayMode.length} test file(s) tagged Graphics (${platforms.join(', ')})` };
}

/** The VRAM claim for the gate's hold: a Graphics pass needs a device in the GPU area; -nographics runs need none. */
export function graphicsVramGb() {
  const k = JOB_KINDS['unity-visual'] || JOB_KINDS['unity-graphics'] || JOB_KINDS.unity;
  return Number(k?.vramGb) > 0 ? Number(k.vramGb) : 2;
}

const sumResults = (rs) => {
  const ok = rs.filter(Boolean);
  if (!ok.length) return null;
  return { total: ok.reduce((n, r) => n + r.total, 0), passed: ok.reduce((n, r) => n + r.passed, 0), failed: ok.reduce((n, r) => n + r.failed, 0), skipped: ok.reduce((n, r) => n + r.skipped, 0), result: ok.some((r) => r.failed) ? 'Failed' : 'Passed', failures: ok.flatMap((r) => r.failures) };
};

/**
 * One platform's editor tests, split when the platform has Graphics tests: the headless start ("!Graphics",
 * -nographics), then the Graphics start (a device). `headless` is a result already in hand (the one-editor run).
 */
export function runPlatform(dir, platform, opts = {}, { split = null, headless = null, log = () => {} } = {}) {
  const splitHere = Boolean(split?.on && split.platforms.includes(platform));
  if (!splitHere) return headless || runUnityTests(dir, platform, opts);
  const a = headless || runUnityTests(dir, platform, { ...opts, category: '!Graphics' });
  if (a.busy || a.notRun || a.problems.some((x) => /licence/.test(x)) || (!a.results && compileErrors(a.log))) return a;
  log(`[gate] ${platform}: the Graphics tests run in their own start with a graphics device (the rest ran with -nographics)`);
  const b = runUnityTests(dir, platform, { ...opts, category: 'Graphics', graphics: true, suffix: '-Graphics' });
  // 2.73.2 (e): the device half not run: a red headless half still stands as the FAIL; else the platform is not run.
  if (b.busy || b.notRun) return a.ok ? b : a;
  const results = sumResults([a.results, b.results]);
  const problems = [...a.problems, ...b.problems].filter((x) => !/: no test ran: /.test(x));
  // 2.72.0 (c): each half's failure kinds, the empty-run one judged over both halves.
  const proof = [...(a.proof || []), ...(b.proof || [])].filter((x) => x.kind !== 'empty-run');
  if (results && !results.total && !opts.allowEmpty) { problems.push(`${platform}: no test ran: an empty run is not a check`); proof.push({ kind: 'empty-run', text: `${platform}: no test ran in either start: an empty run is not a check` }); }
  if (!a.results && !b.results) problems.push(`${platform}: no test results written`);
  return { ok: problems.length === 0, platform, results, problems: [...new Set(problems)], proof, log: `${a.log}\n${b.log}`, graphics: { headless: a.results, device: b.results } };
}

// -- no duplicate Edit Mode --

/** The .NET test project's Compile globs (tools/SimTests/*.csproj), as absolute regexes. [] when there is none. */
function dotnetCompileGlobs(dir) {
  const proj = path.join(dir, 'tools', 'SimTests');
  let csproj = null;
  try { csproj = fs.readdirSync(proj).find((f) => f.endsWith('.csproj')); } catch { return { include: [], remove: [] }; }
  const xml = read(path.join(proj, csproj || '')) || '';
  const toRe = (g) => {
    const abs = path.resolve(proj, g.replace(/\\/g, '/')).split(path.sep).join('/');
    const esc = abs.replace(/[.+^${}()|[\]]/g, '\\$&').replace(/\*\*\//g, '\u0001').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0001/g, '(?:.*/)?');
    return new RegExp(`^${esc}$`, process.platform === 'win32' ? 'i' : '');
  };
  const grab = (attr) => [...xml.matchAll(new RegExp(`<Compile\\b[^>]*\\b${attr}="([^"]+)"`, 'g'))].flatMap((m) => m[1].split(';')).map((x) => x.trim()).filter(Boolean).map(toRe);
  return { include: grab('Include'), remove: [...grab('Remove'), ...grab('Exclude')] };
}

/**
 * Does the code-only `dotnet test tools/SimTests` run every Edit Mode test the editor would? { ok, files, why }: ok only
 * when the project has Edit Mode test sources and the .NET project compiles each of them (so they also passed there).
 */
export function dotnetCoversEditMode(dir, sources = testSources(dir)) {
  const files = sources.EditMode;
  if (!files.length) return { ok: false, files: 0, why: 'no Edit Mode test assembly found under Assets/' };
  const g = dotnetCompileGlobs(dir);
  if (!g.include.length) return { ok: false, files: files.length, why: 'tools/SimTests has no Compile Include list' };
  const fwd = (f) => path.resolve(f).split(path.sep).join('/');
  const missing = files.filter((f) => !g.include.some((re) => re.test(fwd(f))) || g.remove.some((re) => re.test(fwd(f))));
  if (missing.length) return { ok: false, files: files.length, why: `the .NET test project doesn't compile ${missing.length} Edit Mode test file(s) (${missing.slice(0, 2).map(rel).join(', ')})` };
  return { ok: true, files: files.length, why: `tools/SimTests compiles all ${files.length} Edit Mode test file(s)` };
}

// What the editor and the gate write inside a project: never a change to its tree.
const OUTPUT_PATHS = /^(?:Library|Temp|Logs|obj|UserSettings|Build|Builds|MemoryCaptures|StudioHarnessTemp)(?:\/|$)|^TestResults-[^/]*\.xml$|^Assets\/StudioHarnessTemp(?:\.meta|\/|$)|^Library\.(?:seed|tmp|old)-/;

/**
 * The project's committed tree and whether it is clean: { tree, clean, why }. Tree: git's tree id of the project
 * folder at HEAD; clean: no tracked change and no untracked file in it (the editor's own outputs aside). No git: no tree.
 */
export function projectTree(dir) {
  const g = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  const top = g('rev-parse', '--show-toplevel');
  if (top.status !== 0) return { tree: null, clean: false, why: 'the project is not in a git checkout' };
  const prefix = path.relative(fs.realpathSync(top.stdout.trim()), fs.realpathSync(dir)).split(path.sep).join('/');
  const t = g('rev-parse', prefix ? `HEAD:${prefix}` : 'HEAD^{tree}');
  if (t.status !== 0) return { tree: null, clean: false, why: 'the project folder is not committed yet' };
  const st = g('status', '--porcelain', '--untracked-files=normal', '--', '.');
  if (st.status !== 0) return { tree: t.stdout.trim(), clean: false, why: 'git status failed' };
  const changed = st.stdout.split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, '').split(' -> ').pop()).map((f) => (prefix && f.startsWith(`${prefix}/`) ? f.slice(prefix.length + 1) : f)).filter((f) => !OUTPUT_PATHS.test(f));
  return { tree: t.stdout.trim(), clean: changed.length === 0, why: changed.length ? `uncommitted change(s) in the project (${changed.slice(0, 3).join(', ')})` : 'clean' };
}

const editModeFile = () => path.join(REPO_ROOT, '.studio', 'gates', 'unity-editmode.json');
const editorId = (dir) => ({ version: projectVersion(dir), editor: unityBin() });

/** After the editor's Edit Mode tests passed on a clean tree: remember it for this checkout (by project, tree, version). */
export function recordEditModePass(dir, results, { tree = projectTree(dir), now = Date.now() } = {}) {
  if (!tree.tree || !tree.clean || !results?.total || results.failed) return null;
  const f = editModeFile();
  let all = {};
  try { all = JSON.parse(read(f) || '{}') || {}; } catch { all = {}; }
  all[rel(dir) || '.'] = { tree: tree.tree, ...editorId(dir), at: new Date(now).toISOString(), passed: results.passed, total: results.total };
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, `${JSON.stringify(all, null, 2)}\n`); } catch {}
  return all[rel(dir) || '.'];
}

/**
 * May this gate skip the editor's Edit Mode run? Pure judgement over gathered facts, the 2.69 verify-reuse rules: the
 * same clean tree and the same Unity version and editor, never a changed tree, at most maxAgeH old.
 *   coRan: the code-only step ran `dotnet test tools/SimTests` and passed in THIS gate; covers: dotnetCoversEditMode;
 *   playMode: Play Mode's editor run follows in this gate (the editor still compiles the whole project);
 *   rec: the recorded editor pass for this project; tree: projectTree now.
 * { ok, how: 'dotnet'|'record'|null, why }.
 */
export function judgeEditModeReuse({ env = process.env, coRan = null, covers = null, playMode = false, rec = null, tree = null, version = null, editor = null, now = Date.now(), maxAgeH = 24 } = {}) {
  if (isOff(env.STUDIO_UNITY_EDITMODE_REUSE)) return { ok: false, how: null, why: 'STUDIO_UNITY_EDITMODE_REUSE=off' };
  if (coRan?.ok && coRan.total > 0 && covers?.ok && playMode) return { ok: true, how: 'dotnet', why: `the same Edit Mode tests passed with .NET in this gate's code-only step (${coRan.total - (coRan.failed || 0)}/${coRan.total}; ${covers.why}); the editor still starts for Play Mode` };
  if (!rec) return { ok: false, how: null, why: coRan?.ok && covers && !covers.ok ? covers.why : 'no earlier Edit Mode pass recorded for this project in this checkout' };
  if (!tree?.tree) return { ok: false, how: null, why: tree?.why || 'the project tree is unknown' };
  if (!tree.clean) return { ok: false, how: null, why: tree.why };
  if (rec.tree !== tree.tree) return { ok: false, how: null, why: `the last Edit Mode pass was on tree ${String(rec.tree).slice(0, 8)}, not this one (${tree.tree.slice(0, 8)})` };
  if (rec.version !== version || rec.editor !== editor) return { ok: false, how: null, why: `the last Edit Mode pass used Unity ${rec.version} (${rec.editor}), not ${version} (${editor})` };
  const age = now - (Date.parse(rec.at) || 0);
  if (!(age >= -5 * 60000 && age <= maxAgeH * 3600000)) return { ok: false, how: null, why: `the last Edit Mode pass is more than ${maxAgeH} h old (or its time is wrong)` };
  return { ok: true, how: 'record', why: `Edit Mode passed (${rec.passed}/${rec.total}) at ${String(rec.at).slice(11, 19)} UTC on this same tree (${tree.tree.slice(0, 8)}, clean) with Unity ${version}` };
}

/** The recorded editor Edit Mode pass for dir in this checkout, or null. */
export function editModeRecord(dir) {
  try { return (JSON.parse(read(editModeFile()) || '{}') || {})[rel(dir) || '.'] || null; } catch { return null; }
}

// -- one editor start (opt-in, UNVERIFIED) --

export const ONE_EDITOR_DIR = 'Assets/StudioHarnessTemp';
/**
 * The editor script the harness writes for STUDIO_UNITY_ONE_EDITOR=on (and removes after the run): Edit Mode, then
 * Play Mode, through TestRunnerApi, each result saved to the file its argument names. UNVERIFIED on a real editor:
 * that both modes run in one Execute chain, and that the callbacks come back after Play Mode's domain reload
 * ([InitializeOnLoad] registers them again while the phase file exists). The harness falls back to two starts when
 * the run doesn't write both result files.
 */
export const ONE_EDITOR_SCRIPT = `// Written by the studio harness (harness/unity.mjs, STUDIO_UNITY_ONE_EDITOR=on) for one gate run and removed after it.
// Never commit it; never edit it in the game.
using System;
using System.IO;
using UnityEditor;
using UnityEditor.TestTools.TestRunner.Api;
using UnityEngine;

[InitializeOnLoad]
public static class StudioHarnessRunAll
{
    const string PhaseFile = "Temp/studio-harness-run-all.txt";
    static TestRunnerApi api;

    static StudioHarnessRunAll()
    {
        // Play Mode reloads the domain: register the callbacks again while a run is in progress.
        if (File.Exists(PhaseFile)) Register();
    }

    static string Arg(string name)
    {
        var a = Environment.GetCommandLineArgs();
        for (int i = 0; i < a.Length - 1; i++) if (a[i] == name) return a[i + 1];
        return null;
    }

    static void Register()
    {
        if (api != null) return;
        api = ScriptableObject.CreateInstance<TestRunnerApi>();
        api.RegisterCallbacks(new Callbacks());
    }

    public static void Run()
    {
        Directory.CreateDirectory("Temp");
        File.WriteAllText(PhaseFile, "EditMode");
        Register();
        Start(TestMode.EditMode);
    }

    static void Start(TestMode mode)
    {
        var filter = new Filter { testMode = mode };
        var cat = Arg("-studioTestCategory");
        if (!string.IsNullOrEmpty(cat)) filter.categoryNames = cat.Split(';');
        api.Execute(new ExecutionSettings(filter));
    }

    class Callbacks : ICallbacks
    {
        public void RunStarted(ITestAdaptor tests) { }
        public void TestStarted(ITestAdaptor test) { }
        public void TestFinished(ITestResultAdaptor result) { }
        public void RunFinished(ITestResultAdaptor result)
        {
            var phase = File.Exists(PhaseFile) ? File.ReadAllText(PhaseFile).Trim() : "";
            if (phase == "EditMode")
            {
                TestRunnerApi.SaveResultToFile(result, Arg("-studioEditModeResults"));
                File.WriteAllText(PhaseFile, "PlayMode");
                Start(TestMode.PlayMode);
            }
            else if (phase == "PlayMode")
            {
                TestRunnerApi.SaveResultToFile(result, Arg("-studioPlayModeResults"));
                File.Delete(PhaseFile);
                EditorApplication.Exit(0);
            }
        }
    }
}
`;
const ONE_EDITOR_ASMDEF = `${JSON.stringify({ name: 'StudioHarnessTemp', references: ['UnityEditor.TestRunner', 'UnityEngine.TestRunner'], includePlatforms: ['Editor'], autoReferenced: false }, null, 2)}\n`;

const removeOneEditorFiles = (dir) => {
  for (const f of [ONE_EDITOR_DIR, `${ONE_EDITOR_DIR}.meta`]) { try { fs.rmSync(path.join(dir, f), { recursive: true, force: true }); } catch {} }
};

/**
 * Edit Mode and Play Mode in one editor start (-executeMethod StudioHarnessRunAll.Run). The script is written into
 * Assets/StudioHarnessTemp (with a .gitignore of *, so a killed run can't get it committed) and removed after, whatever
 * happens. { ok: both result files written, results: { EditMode, PlayMode } (judged runs), why, log }.
 */
export function runOneEditor(dir, { controlsOut = null, extraArgs = [], category = null, timeoutMin = 60, allowEmpty = {} } = {}) {
  // 2.72.0 (c): this run's nonce in both results files' names (harness/engine-proof.mjs).
  const nonce = runNonce();
  const files = { EditMode: path.join(dir, `TestResults-EditMode-${nonce}.xml`), PlayMode: path.join(dir, `TestResults-PlayMode-${nonce}.xml`) };
  for (const p of Object.keys(files)) removeOldResults(dir, p);
  let startedAt = null;
  removeOneEditorFiles(dir);
  const sdir = path.join(dir, ONE_EDITOR_DIR);
  let r = null;
  try {
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(path.join(sdir, '.gitignore'), '*\n');
    fs.writeFileSync(path.join(sdir, 'StudioHarnessRunAll.cs'), ONE_EDITOR_SCRIPT);
    fs.writeFileSync(path.join(sdir, 'StudioHarnessTemp.asmdef'), ONE_EDITOR_ASMDEF);
    const args = ['-batchmode', '-nographics', '-projectPath', dir, '-executeMethod', 'StudioHarnessRunAll.Run', '-studioEditModeResults', files.EditMode, '-studioPlayModeResults', files.PlayMode, ...(category ? ['-studioTestCategory', category] : []), '-logFile', '-', ...extraArgs];
    startedAt = Date.now();
    r = spawnSync(unityBin(), args, { windowsHide: true, cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, ...(controlsOut ? { STUDIO_CONTROLS_OUT: controlsOut } : {}) }, timeout: timeoutMin * 60000, maxBuffer: 256 * 1024 * 1024 });
  } finally {
    removeOneEditorFiles(dir);
  }
  const log = `${r?.stdout || ''}${r?.stderr || ''}`;
  const missing = Object.keys(files).filter((p) => !parseNUnit(read(files[p])));
  if (missing.length) return { ok: false, why: `${missing.join(' and ')} results not written (exit ${r?.status ?? '?'}${r?.error ? `, ${r.error.code}` : ''})`, log };
  const sig = r.signal || (r.error?.code === 'ETIMEDOUT' ? 'timeout' : null);
  return { ok: true, why: 'both results written', log, results: { EditMode: judgeRun('EditMode', files.EditMode, log, r.status, { unhandled: false, startedAt, allowEmpty: Boolean(allowEmpty.EditMode), signal: sig }), PlayMode: judgeRun('PlayMode', files.PlayMode, log, r.status, { startedAt, allowEmpty: Boolean(allowEmpty.PlayMode), signal: sig }) } };
}

// -- landing build options --

/**
 * The build method's speed arguments (the contract a game's StudioBuild.cs may read; docs/UNITY-TRACK.md):
 * STUDIO_UNITY_LANDING_BUILD=fast adds `-studioBuildSpeed fast` to landing/dev builds (never with release: true);
 * STUDIO_UNITY_CODE_OPT=release adds `-studioCodeOptimization release`. The harness never edits ProjectSettings, and
 * adds no editor-wide code optimization flag: its name is unverified (TODO in docs/UNITY-TRACK.md).
 * { args, notes }.
 */
export function buildSpeedArgs(env = process.env, { release = false } = {}) {
  const args = [];
  const notes = [];
  if (/^fast$/i.test(String(env.STUDIO_UNITY_LANDING_BUILD || '').trim())) {
    if (release) notes.push('landing build options: off for a --release build');
    else { args.push('-studioBuildSpeed', 'fast'); notes.push('landing build: fast (-studioBuildSpeed fast: the game\'s build script picks Mono or IL2CPP "faster (smaller) builds" for this build; docs/UNITY-TRACK.md)'); }
  }
  if (/^release$/i.test(String(env.STUDIO_UNITY_CODE_OPT || '').trim())) {
    args.push('-studioCodeOptimization', 'release');
    notes.push('code optimization: release asked (-studioCodeOptimization release for the build script; no editor flag is added: its name is unverified, see the TODO in docs/UNITY-TRACK.md)');
  }
  return { args, notes };
}

/**
 * The editor's gate: purity, pin, the code-only steps (no machine:heavy; 2.67.1), then Edit Mode and Play Mode tests
 * under one machine:heavy hold, with the warm Library seeded first and saved after a green run (harness/unity-cache.mjs)
 * and one retry for a Play Mode test failure (a pass on retry is green with a flake record). { ok, problems, flakes }.
 */
export function gate(dir, { platforms = ['EditMode', 'PlayMode'], log = console.log, env = process.env, ...heavyOpts } = {}) {
  const problems = [];
  const flakes = [];
  const proof = []; // 2.72.0 (c): each failure's kind (harness/engine-proof.mjs), for its own plain-words and Fix line
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
  // 2.70.0 (u): the Accelerator (probed once, before any wait), the Graphics split and Edit Mode reuse.
  const acc = accelerator(dir, { env });
  log(`[unity] ${acc.line}`);
  const split = graphicsSplit(dir, env);
  if (split.on) log(`[unity] Graphics split: ${split.why}: those run with a graphics device (in the GPU area), the rest with -nographics -testCategory "!Graphics" (STUDIO_UNITY_GRAPHICS_SPLIT=off: one headless run)`);
  let todo = [...platforms];
  let reused = null;
  let tree = null;
  if (platforms.includes('EditMode')) {
    tree = projectTree(dir);
    const rec = editModeRecord(dir);
    const j = judgeEditModeReuse({ env, coRan: co.dotnet, covers: co.dotnet?.ok ? dotnetCoversEditMode(dir) : null, playMode: platforms.includes('PlayMode'), rec, tree, version: projectVersion(dir), editor: unityBin() });
    if (j.ok) {
      reused = j;
      todo = todo.filter((x) => x !== 'EditMode');
      log(`[gate] PASS EditMode: reused, not run again: ${j.why} (STUDIO_UNITY_EDITMODE_REUSE=off runs it anyway)`);
    } else if (co.dotnet?.ok || rec) log(`[unity] note: the editor runs Edit Mode: ${j.why}`);
  }
  if (!todo.length) return { ok: true, problems, flakes, codeOnly: co, cache: null, editMode: reused, accelerator: acc, split };
  // A one-editor script left by a killed run never stays in the project (it would compile into every later start).
  if (fs.existsSync(path.join(dir, ONE_EDITOR_DIR))) { removeOneEditorFiles(dir); log(`[unity] removed ${ONE_EDITOR_DIR}/ left by an earlier one-editor run`); }
  const oneEditor = isOn(env.STUDIO_UNITY_ONE_EDITOR) && todo.includes('EditMode') && todo.includes('PlayMode');
  let oneEditorUsed = false;
  let cache = null;
  const notRuns = []; // 2.73.2 (e, B-73): platforms an infrastructure abort stopped (NOT RUN, apart from problems)
  // One machine:heavy hold for every platform (no other heavy job slips in between Edit Mode and Play Mode).
  const h = underHeavy(`unity gate ${todo.join('+')} (${rel(dir) || '.'})`, () => {
    const seed = seedLibrary(dir, { mainRoot, env });
    if (seed.status !== 'off' && seed.status !== 'skipped') log(cacheLine(seed, 'before the editor'));
    // 2.70.0 (u): STUDIO_UNITY_ONE_EDITOR=on: both modes in one start; anything short of both results: two starts.
    let pre = null;
    if (oneEditor) {
      const o = runOneEditor(dir, { controlsOut, extraArgs: acc.args, category: split.on ? '!Graphics' : null, allowEmpty: { EditMode: unityAllowEmpty('EditMode'), PlayMode: unityAllowEmpty('PlayMode') } });
      if (o.ok) { pre = o.results; oneEditorUsed = true; log('[gate] one editor start: Edit Mode and Play Mode ran in one editor (STUDIO_UNITY_ONE_EDITOR=on)'); }
      else log(`[gate] note: the one editor start (STUDIO_UNITY_ONE_EDITOR=on) didn't write both results (${o.why}): falling back to one start per mode (its log: ${saveLog('unity-one-editor.log', o.log)})`);
    }
    for (const platform of todo) {
      const opts = { controlsOut: platform === 'PlayMode' ? controlsOut : null, extraArgs: acc.args, allowEmpty: unityAllowEmpty(platform), ...heavyOpts };
      let r = runPlatform(dir, platform, opts, { split, headless: pre?.[platform] || null, log });
      if (r.notRun) {
        // 2.73.2 (e, B-73): not run is not red: no retry, no FAIL line, no Edit Mode record; the next platform isn't started.
        notRuns.push({ ...r.notRun, platform, proof: r.proof || [] });
        log(`[gate] NOT RUN ${platform}: ${r.notRun.text.replace(`${platform}: `, '')} (not a failure of the work)`);
        break;
      }
      if (retryablePlayMode(r)) {
        const first = r;
        const logs = [saveLog(`unity-${platform}-try1.log`, first.log)];
        log(`[gate] FAIL ${platform}: ${first.results.failed}/${first.results.total} failed; retrying once (a Play Mode failure gets one retry)`);
        r = runPlatform(dir, platform, opts, { split, log });
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
      // 2.70.0 (u): a passing Edit Mode run on a clean tree is remembered, so the next gate on that tree skips it.
      if (platform === 'EditMode' && r.ok) recordEditModePass(dir, r.results, { tree });
      problems.push(...r.problems);
      if (!r.ok) proof.push(...(r.proof || []));
      if (r.note) log(`[unity] note: ${r.note}`);
      if (r.problems.some((x) => /licence/.test(x))) break;
    }
    if (!problems.length && !notRuns.length) {
      const saved = saveLibrary(dir, { mainRoot, env });
      if (saved.status !== 'off' && saved.status !== 'skipped') log(cacheLine(saved, 'after the green run'));
      cache = { seed, saved };
    } else cache = { seed };
  }, { ...heavyOpts, ...(split.on ? { vramGb: graphicsVramGb() } : {}) });
  if (h.busy) return { ok: false, busy: true, notRun: { kind: h.floor ? 'ram-floor' : 'busy', text: h.busy }, codeOnly: co, accelerator: acc, problems: [`the editor's tests did not run: ${h.busy}`] };
  // 2.73.2 (e, B-73): a real FAIL on one platform wins over a later platform that didn't run; else not run, not red.
  const notRun = !problems.length && notRuns.length ? { kind: notRuns[0].kind, text: notRuns.map((x) => x.text).join('; '), platforms: notRuns.map((x) => x.platform) } : null;
  if (notRun) return { ok: false, notRun, problems: notRuns.map((x) => `not run (${x.kind}): ${x.text}`), proof: notRuns.flatMap((x) => x.proof), flakes, codeOnly: co, cache, editMode: reused, accelerator: acc, split };
  return { ok: problems.length === 0, problems, proof, flakes, codeOnly: co, cache, editMode: reused, accelerator: acc, split, oneEditor: oneEditor ? (oneEditorUsed ? 'used' : 'fell back') : 'off' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const [cmd, folderArg] = process.argv.slice(2);
  const flag = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
  let folder = folderArg && !folderArg.startsWith('--') ? folderArg : null;
  let track = null;
  try { const { readTrack } = await import('./engine.mjs'); track = readTrack(); } catch {}
  if (!folder) folder = track?.engine === 'unity' ? track.folder : null;
  if (!folder && cmd === 'accelerator') {
    // 2.70.0 (u): no project: probe the endpoint only (the namespace needs a project's Unity version).
    const v = String(process.env.STUDIO_UNITY_ACCELERATOR || '').trim();
    const pr = v ? probeEndpoint(v) : null;
    console.log(`[unity] ${!v ? 'cache server off (STUDIO_UNITY_ACCELERATOR is not set)' : pr.ok ? `cache server on: the Unity Accelerator at ${v} answered in ${pr.ms} ms` : `cache server off: the Accelerator at ${v} did not answer (${pr.why}): runs go on without it`}`);
    process.exit(0);
  }
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
    try { (await import('./jobs.mjs')).jobDone({ kind: 'unity-test', id: folder, code: r.ok ? 0 : r.busy || r.notRun ? 3 : 1, result: r.ok ? 'pass' : r.notRun ? 'not-run' : r.busy ? 'busy' : 'fail', ms: Date.now() - t0, tail: (r.problems || []).join(' | ') }); } catch {}
    // 2.70.0 (u): the summary line says whether the cache server was on and whether Edit Mode was reused.
    const tail = `${r.accelerator ? `; ${r.accelerator.on ? 'cache server on' : 'cache server off'}` : ''}${r.editMode ? `; Edit Mode reused (${r.editMode.how === 'dotnet' ? 'passed with .NET in this gate' : 'passed earlier on this tree'})` : ''}${r.oneEditor === 'used' ? '; one editor start' : r.oneEditor === 'fell back' ? '; one editor start fell back to two' : ''}`;
    if (!r.ok && r.notRun) {
      // 2.73.2 (e, B-73): not run (exit 3): one NOT RUN line per kind and its Fix line; never "[engine-gate] FAIL".
      const { engineFix } = await import('./gate-fix.mjs');
      const shown = r.proof?.length ? r.proof : [{ kind: r.notRun.kind, text: r.notRun.text }];
      for (const k of kindsOf(shown)) { console.error(notRunLine(shown.find((x) => x.kind === k), 'unity')); console.error(`[engine-gate] Fix: ${engineFix(k, 'unity')}`); }
      console.error(`[unity] NOT RUN the editor's tests: not run: ${r.notRun.text} (exit 3: not a failure of the work; run the gate again later)`);
      process.exit(3);
    }
    if (!r.ok) {
      if (tail) console.error(`[unity] FAIL summary${tail}`);
      // 2.72.0 (c): one plain-words line and one Fix line per kind of failure (harness/engine-proof.mjs, gate-fix.mjs).
      if (r.proof?.length) {
        const { engineFix } = await import('./gate-fix.mjs');
        for (const k of kindsOf(r.proof)) { console.error(proofLine(r.proof.find((x) => x.kind === k), 'unity')); console.error(`[engine-gate] Fix: ${engineFix(k, 'unity')}`); }
      }
      fail(r.problems, r.busy ? 3 : 1);
    }
    // 2.67.1 (k): a pass on retry is green, with a warning naming the flaky tests.
    for (const f of r.flakes || []) console.log(`[unity] WARN flaky ${f.platform} test(s): ${f.tests.join(', ') || '?'} failed once, passed on retry (.studio/unity-flakes.jsonl)`);
    const which2 = pf ? `${pf === 'EditMode' ? 'Edit Mode' : 'Play Mode'}` : 'Edit Mode and Play Mode';
    console.log(`[unity] PASS the editor's tests (${which2})${r.flakes?.length ? ' (with a flake: see the warning)' : ''}${tail}`);
  } else if (cmd === 'build') {
    // 2.47.0: the track's buildTarget (npm run engine -- link unity <repo> --build windows) is the default.
    const t0 = Date.now();
    const r = build(dir, flag('target') || track?.buildTarget || 'windows', { out: flag('out'), heavyRoot, release: process.argv.includes('--release') });
    // 2.65.0: the uniform job.done (harness/jobs.mjs) for a build.
    try { (await import('./jobs.mjs')).jobDone({ kind: 'unity-build', id: `${r.target || flag('target') || 'build'} ${folder}`, code: r.ok ? 0 : r.busy ? 3 : 1, result: r.ok ? 'pass' : r.busy ? 'busy' : 'fail', ms: Date.now() - t0, tail: (r.problems || []).join(' | '), log: r.out || null }); } catch {}
    if (!r.ok) fail(r.problems, r.busy ? 3 : 1);
    console.log(`[unity] PASS ${r.target} build: ${r.out}${r.target === 'WebGL' ? ' (the Arcade\'s engine tab plays it; or serve the folder and open index.html)' : ''}`);
  } else if (cmd === 'accelerator') {
    // 2.70.0 (u): is the Unity Accelerator (STUDIO_UNITY_ACCELERATOR) answering, and the editor arguments it adds.
    const a = accelerator(dir);
    console.log(`[unity] ${a.line}`);
    if (a.on) console.log(`[unity] editor arguments: ${a.args.join(' ')}`);
  } else {
    console.error('usage: node harness/unity.mjs sim|gate|build|purity|version|accelerator [<folder>] [--platform EditMode|PlayMode] [--target web|windows] [--release]');
    process.exit(2);
  }
}
