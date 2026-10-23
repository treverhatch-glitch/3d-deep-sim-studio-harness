#!/usr/bin/env node
/**
 * harness/gdscript-parse.mjs — every GDScript in a Godot project must parse (2.30h, item 7).
 *
 *   node harness/gdscript-parse.mjs <project-folder> [--godot <bin>]
 *
 * A Godot gate can look green while a script that the smoke run never loads is broken. This asks Godot
 * to parse each .gd file on its own (`godot --headless --path <project> --check-only --script res://<file>`)
 * and fails, naming the file and Godot's error, when any one does not parse. Folders Godot or a package
 * manager owns (.godot, addons, export, build) are skipped. Used by the engine gate (check-engine.mjs),
 * the Godot template check (check-engine-template.mjs) and the godot-unit gate.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SKIP_DIRS = new Set(['.godot', '.import', 'addons', 'export', 'build', 'captures', 'reports', 'node_modules', '.git']);
const PARSE_FAIL = /Parse Error|SCRIPT ERROR|Failed to load script|Compile Error/i;

/** Every .gd file under the project, as res:// paths, sorted. */
export function gdFiles(project) {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name));
      } else if (e.name.endsWith('.gd')) out.push(path.relative(project, path.join(dir, e.name)).split(path.sep).join('/'));
    }
  };
  walk(project);
  return out.sort();
}

/**
 * Parse every script. Returns { checked, broken: [{ file, error }] }. A Godot that can't be started is
 * reported as `error` (the caller decides; the gates already fail when Godot is missing).
 */
export function parseCheck(project, { godot, timeoutMs = 60000, files = gdFiles(project) } = {}) {
  const broken = [];
  // Class names (class_name, addons such as gdUnit4) resolve from the import cache: build it once if missing.
  if (files.length && !fs.existsSync(path.join(project, '.godot'))) spawnSync(godot, ['--headless', '--path', project, '--import'], { encoding: 'utf8', timeout: 300000 });
  for (const f of files) {
    const r = spawnSync(godot, ['--headless', '--path', project, '--check-only', '--script', `res://${f}`], { encoding: 'utf8', timeout: timeoutMs, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(godot) });
    if (r.error) return { checked: files.length, broken, error: `could not run ${godot}: ${r.error.message}` };
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    if (r.status !== 0 || PARSE_FAIL.test(out)) {
      const line = out.split(/\r?\n/).find((l) => PARSE_FAIL.test(l)) || `exit ${r.status}`;
      const at = (out.match(/\(res:\/\/[^)]*:\d+\)/) || [''])[0];
      broken.push({ file: f, error: `${line.trim()}${at ? ` ${at}` : ''}`.slice(0, 300) });
    }
  }
  return { checked: files.length, broken };
}

export function formatBroken(r) {
  return r.broken.map((b) => `  ${b.file}: ${b.error}`).join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const project = path.resolve(argv.find((a) => !a.startsWith('--')) || '.');
  const godot = argv.includes('--godot') ? argv[argv.indexOf('--godot') + 1] : process.env.STUDIO_GODOT || process.env.GODOT_BIN || 'godot';
  const r = parseCheck(project, { godot });
  if (r.error) {
    console.error(`[gdscript] FAIL ${r.error}`);
    process.exit(1);
  }
  if (r.broken.length) {
    console.error(`[gdscript] FAIL ${r.broken.length} of ${r.checked} script(s) don't parse:\n${formatBroken(r)}`);
    process.exit(1);
  }
  console.log(`[gdscript] PASS all ${r.checked} script(s) parse`);
}
