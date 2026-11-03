#!/usr/bin/env node
/**
 * harness/godot-unit.mjs — runs headless Godot unit tests with gdUnit4.
 *
 * This module integrates gdUnit4 tests into the harness. It can be run as a gate,
 * checking for changes in specified project directories before running. It finds
 * the Godot binary, runs the tests, parses the JUnit output, and records the
 * results for briefings and reporting.
 *
 *   node harness/godot-unit.mjs [--changed]   --changed: only when a watched folder changed (the gate)
 *
 * Opt-in per game (studio/godot-unit.json, 2.30g). Exit 0 passes; gdUnit4's 100 (test failures) and 105
 * (script or discovery error) block. Versions are pinned there: gdUnit4 v6.2.2, Godot 4.7.2.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, emitEvent } from './event.mjs';
import { parseCheck, formatBroken } from './gdscript-parse.mjs';
import { judgePass } from './silent-green.mjs';
import { freshFile, logSignatures, exitAgrees, proofLine } from './engine-proof.mjs';
import { engineFix } from './gate-fix.mjs';

const CONFIG_FILE = path.join(REPO_ROOT, 'studio', 'godot-unit.json');
const LAST_RUN_FILE = path.join(STUDIO_STATE_DIR, 'godot-unit-last.json');

export function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return { enabled: false };
  }
}

export function shouldRun(cfg, changedFiles) {
  if (!cfg.enabled) return { run: false, reason: 'disabled in studio/godot-unit.json' };
  const projectPath = path.join(REPO_ROOT, cfg.project);
  if (!fs.existsSync(projectPath) || !fs.existsSync(path.join(projectPath, 'project.godot'))) {
    return { run: false, reason: `project path '${cfg.project}' not found` };
  }
  if (!runnerFor(projectPath)) {
    return { run: false, reason: `addons/gdUnit4/runtest.sh not found. Install gdUnit4 ${cfg.gdunit} from https://github.com/MikeSchulze/gdUnit4` };
  }
  if (changedFiles) {
    const watchDirs = (cfg.watch || []).map(d => `${cfg.project.replace(/\\/g, '/')}/${d}/`);
    const relevantChange = changedFiles.some(f => watchDirs.some(wd => f.startsWith(wd)));
    if (!relevantChange) return { run: false, reason: 'no changes in watched directories' };
  }
  return { run: true };
}

/**
 * How to launch gdUnit4's runner. cmd.exe cannot run a .sh, so on Windows use gdUnit4's own runtest.cmd
 * when present, else run runtest.sh through sh (Git for Windows). Elsewhere run runtest.sh directly.
 */
export function runnerFor(projectPath, platform = process.platform) {
  const sh = path.join(projectPath, 'addons', 'gdUnit4', 'runtest.sh');
  const cmd = path.join(projectPath, 'addons', 'gdUnit4', 'runtest.cmd');
  if (platform === 'win32') {
    if (fs.existsSync(cmd)) return { file: cmd, pre: [], shell: true };
    if (fs.existsSync(sh)) return { file: 'sh', pre: ['./addons/gdUnit4/runtest.sh'], shell: false };
    return null;
  }
  return fs.existsSync(sh) ? { file: './addons/gdUnit4/runtest.sh', pre: [], shell: true } : null;
}

/** The report_* folders of a gdUnit4 reports folder (names only). */
export function listReports(reportDir) {
  try { return fs.readdirSync(reportDir).filter((d) => d.startsWith('report_')); } catch { return []; }
}

/**
 * 2.72.0 (c): did this gdUnit4 run prove it ran? (harness/engine-proof.mjs) A report folder that didn't exist before the
 * run (before: the names then) with a results.xml written since startedAt, more than 0 test cases (unless allowEmpty),
 * no parse/compile error in the output, and an exit code that agrees with the results (gdUnit4: 0 all passed, 100 test
 * failures, 105 script or discovery error). { ok, report: { tests, failures }, proof: [{ kind, text }], note, file }.
 */
export function judgeGodotRun({ reportDir, before = new Set(), startedAt = null, status, signal = null, output = '', allowEmpty = false }) {
  const proof = [];
  const all = listReports(reportDir);
  const fresh = all.filter((d) => !before.has(d)).map((d) => ({ d, f: path.join(reportDir, d, 'results.xml') })).filter((x) => freshFile(x.f, startedAt).ok).sort((a, b) => fs.statSync(b.f).mtimeMs - fs.statSync(a.f).mtimeMs);
  let report = { tests: 0, failures: [] };
  let file = null;
  if (fresh.length) { file = fresh[0].f; report = parseJUnit(fs.readFileSync(file, 'utf8')); }
  else {
    const old = all.filter((d) => fs.existsSync(path.join(reportDir, d, 'results.xml')));
    if (old.length) proof.push({ kind: 'stale-results', text: `this run wrote no new report folder; ${old.length} older one(s) in ${path.basename(reportDir)}/ (newest ${old.sort().pop()}) were left by earlier runs and don't count` });
    else proof.push({ kind: 'no-results', text: `this run wrote no report (no ${path.basename(reportDir)}/report_*/results.xml; exit ${status})` });
  }
  for (const sg of logSignatures(output, 'godot')) proof.push(sg);
  if (file && !report.tests && !allowEmpty) proof.push({ kind: 'empty-run', text: 'the report counts 0 test cases: an empty run is not a check' });
  if (report.failures.length) proof.push({ kind: 'test-failed', text: `${report.failures.length} test(s) failed: ${report.failures.slice(0, 3).map((f) => `${f.suite}::${f.name}`).join(', ')}` });
  if (file && (report.tests || report.failures.length)) {
    const ex = exitAgrees(status, { total: report.tests, failed: report.failures.length }, { signal, failCodes: [100] });
    if (!ex.ok) proof.push({ kind: 'exit-mismatch', text: ex.why });
  } else if (status !== 0 && file) proof.push({ kind: 'exit-mismatch', text: `gdUnit4 exited ${status} (100: test failures, 105: a script or discovery error) and its report counts no test` });
  const note = file && !report.tests && allowEmpty ? '0 tests ran, allowed by studio/godot-unit.json "allowEmpty"' : '';
  return { ok: proof.length === 0 && status === 0, report, proof, note, file };
}

const unxml = (t) => String(t || '').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attr = (tag, k) => unxml((tag.match(new RegExp(`\\b${k}="([^"]*)"`)) || [])[1] || '');
/** Each <testcase> on its own, so a failure is never pinned on the test before it. */
export function parseJUnit(xmlText) {
  const failures = [];
  let tests = 0;
  for (const m of String(xmlText || '').matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    tests += 1;
    const body = m[3] || '';
    const bad = body.match(/<(failure|error)\b([^>]*)>?/);
    if (bad) failures.push({ suite: attr(m[1], 'classname'), name: attr(m[1], 'name'), message: (attr(bad[2], 'message') || (bad[1] === 'error' ? 'Test errored' : 'Test failed')).replace(/\s+/g, ' ').slice(0, 300) });
  }
  return { tests, failures };
}

export function runGodotUnit({ changedOnly = false } = {}) {
  const cfg = readConfig();
  const gitDiff = spawnSync('git', ['diff', '--name-only', 'HEAD'], { windowsHide: true, encoding: 'utf8', cwd: REPO_ROOT });
  const gitLs = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { windowsHide: true, encoding: 'utf8', cwd: REPO_ROOT });
  const inGit = gitDiff.status === 0;
  // Outside git (a copied tree) or with STUDIO_GODOT_UNIT_ALL=1, every run is a full run.
  const changedFiles = changedOnly && inGit && process.env.STUDIO_GODOT_UNIT_ALL !== '1' ? [...gitDiff.stdout.split('\n'), ...gitLs.stdout.split('\n')].filter(Boolean).map(f => f.replace(/\\/g, '/')) : null;

  const check = shouldRun(cfg, changedFiles);
  if (!check.run) {
    console.log(`[godot-unit] skipped: ${check.reason}`);
    return { ok: true, skipped: true, reason: check.reason };
  }

  const godotBin = process.env.GODOT_BIN || cfg.godotBin;
  if (!godotBin || !fs.existsSync(godotBin)) {
    console.error(`[godot-unit] FAIL: Godot binary not found at '${godotBin}'. Set GODOT_BIN env var or 'godotBin' in config. Required version: ${cfg.godot}`);
    process.exit(1);
  }

  const projectPath = path.join(REPO_ROOT, cfg.project);
  // 2.30h (7): a script that doesn't parse fails the gate by name, before gdUnit4 runs (it may never load it).
  const parsed = parseCheck(projectPath, { godot: godotBin });
  if (parsed.broken.length) {
    console.error(`[godot-unit] FAIL ${parsed.broken.length} GDScript file(s) don't parse:\n${formatBroken(parsed)}`);
    emitEvent({ type: 'gate.godot-unit', ok: false, meta: { parse: parsed.broken } });
    process.exit(1);
  }
  const runner = runnerFor(projectPath);
  const reportDir = path.join(projectPath, 'reports');
  // 2.72.0 (c): the report folders that exist before the run; only a new one (gdUnit4 numbers them) counts.
  const before = new Set(listReports(reportDir));
  const startedAt = Date.now();
  const result = spawnSync(runner.file, [...runner.pre, '--godot_binary', godotBin, '-a', cfg.tests, '-c'], { windowsHide: true, cwd: projectPath, timeout: 600 * 1000, encoding: 'utf8', shell: runner.shell });

  // 2.36.0: only a report this run wrote counts (an older one made a run that tested nothing look green).
  // 2.72.0 (c): and the run has to prove it ran (harness/engine-proof.mjs judgeGodotRun).
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const j = judgeGodotRun({ reportDir, before, startedAt, status: result.status, signal: result.signal || (result.error?.code === 'ETIMEDOUT' ? 'timeout' : null), output, allowEmpty: cfg.allowEmpty === true });
  const reportData = j.report;
  if (j.note) console.log(`[godot-unit] note: ${j.note}`);
  for (const p of j.proof) { console.error(proofLine(p, 'godot')); console.error(`[engine-gate] Fix: ${engineFix(p.kind, 'godot')}`); }
  // The silent-green guard (2.36.0) still logs its gate.silent_green event for the morning report.
  if (result.status === 0 && !reportData.tests) judgePass('godot-unit', { output, count: reportData.tests });
  const ok = j.ok;
  if (!ok && !reportData.tests && result.status === 0) console.error('[godot-unit] FAIL godot-unit passed but ran no tests (it counted 0 tests): an empty run is not a check (studio/godot-unit.json "allowEmpty": true allows it)');
  console.log(`[godot-unit] ${ok ? 'PASS' : 'FAIL'} (exit code ${result.status}, ${reportData.tests} test(s))`);

  const lastRun = { at: new Date().toISOString(), ok, code: result.status, ...reportData, version: { gdunit: cfg.gdunit, godot: cfg.godot } };
  fs.mkdirSync(path.dirname(LAST_RUN_FILE), { recursive: true });
  fs.writeFileSync(LAST_RUN_FILE, JSON.stringify(lastRun, null, 2));
  emitEvent({ type: 'gate.godot-unit', ok, meta: lastRun });

  if (!ok && reportData.failures.length > 0) {
    console.log('Failing tests:');
    reportData.failures.slice(0, 20).forEach(f => console.log(`- ${f.suite}::${f.name}: ${f.message}`));
  }
  return { ok, ...lastRun };
}

export function failuresForBrief() {
  try {
    const lastRun = JSON.parse(fs.readFileSync(LAST_RUN_FILE, 'utf8'));
    if (lastRun.ok || !lastRun.failures.length) return '';
    const header = '## Failing Godot unit tests (last run)';
    const bullets = lastRun.failures.map(f => `- **${f.suite}::${f.name}**: ${f.message}`);
    return `\n${header}\n${bullets.join('\n')}\n`;
  } catch {
    return '';
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const argv = process.argv.slice(2);
  const result = runGodotUnit({ changedOnly: argv.includes('--changed') });
  process.exit(result.ok ? 0 : 1);
}
