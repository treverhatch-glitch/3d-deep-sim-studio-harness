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
  const runtestPath = path.join(projectPath, 'addons/gdUnit4/runtest.sh');
  if (!fs.existsSync(runtestPath)) {
    return { run: false, reason: `addons/gdUnit4/runtest.sh not found. Install gdUnit4 ${cfg.gdunit} from https://github.com/MikeSchulze/gdUnit4` };
  }
  if (changedFiles) {
    const watchDirs = (cfg.watch || []).map(d => `${cfg.project.replace(/\\/g, '/')}/${d}/`);
    const relevantChange = changedFiles.some(f => watchDirs.some(wd => f.startsWith(wd)));
    if (!relevantChange) return { run: false, reason: 'no changes in watched directories' };
  }
  return { run: true };
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
  const gitDiff = spawnSync('git', ['diff', '--name-only', 'HEAD'], { encoding: 'utf8', cwd: REPO_ROOT });
  const gitLs = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { encoding: 'utf8', cwd: REPO_ROOT });
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
  const result = spawnSync('./addons/gdUnit4/runtest.sh', ['--godot_binary', godotBin, '-a', cfg.tests, '-c'], { cwd: projectPath, timeout: 600 * 1000, encoding: 'utf8', shell: true });

  const ok = result.status === 0;
  console.log(`[godot-unit] ${ok ? 'PASS' : 'FAIL'} (exit code ${result.status})`);

  const reportDir = path.join(projectPath, 'reports');
  const reports = fs.existsSync(reportDir) ? fs.readdirSync(reportDir).filter(d => d.startsWith('report_')).sort((x, y) => fs.statSync(path.join(reportDir, y)).mtimeMs - fs.statSync(path.join(reportDir, x)).mtimeMs) : [];
  let reportData = { tests: 0, failures: [] };
  if (reports.length > 0) {
    const resultsXmlPath = path.join(reportDir, reports[0], 'results.xml');
    if (fs.existsSync(resultsXmlPath)) reportData = parseJUnit(fs.readFileSync(resultsXmlPath, 'utf8'));
  }

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
