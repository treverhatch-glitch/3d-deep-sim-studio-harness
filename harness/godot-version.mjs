/**
 * harness/godot-version.mjs — 2.42.0: the Godot pieces that must be the same version, checked together.
 *
 * The research pack's Marina run: "godot451 (4.5.1); export templates on box are 4.7.2 only", and a gdUnit4
 * set up for one Godot while the gate ran another. A Godot binary newer than the project silently upgrades
 * it on import; export templates for another version can't export it; gdUnit4 is built for one version.
 *
 * Checked for each Godot project the engine gate runs:
 *   - the binary's version (`godot --version`, major.minor.patch) against the project's own
 *     (project.godot config/features, major.minor);
 *   - when the project has export presets (export_presets.cfg): export templates installed for the binary's
 *     exact version (the user's Godot data folder, or STUDIO_GODOT_TEMPLATES);
 *   - the version studio/godot-unit.json says gdUnit4 was set up for.
 * STUDIO_GODOT_PIN: "warn" (default: notes in the engine gate's output), "fail" (a mismatch fails the gate:
 * opt in), "off".
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from './event.mjs';

export function pinMode(env = process.env) {
  const v = String(env.STUDIO_GODOT_PIN || 'warn').toLowerCase();
  return ['fail', 'off'].includes(v) ? v : 'warn';
}

/** "4.5.1.stable.official.f62fdbde1" -> { full: '4.5.1', minor: '4.5', label: '4.5.1.stable' } or null. */
export function parseVersion(text) {
  const m = String(text || '').match(/(\d+)\.(\d+)(?:\.(\d+))?(?:\.(\w+))?/);
  if (!m) return null;
  const full = `${m[1]}.${m[2]}.${m[3] || '0'}`;
  return { full, minor: `${m[1]}.${m[2]}`, label: `${m[1]}.${m[2]}${m[3] && m[3] !== '0' ? `.${m[3]}` : ''}.${m[4] || 'stable'}` };
}

/** Is version a ("4.10") newer than b ("4.5")? Numerically, part by part. */
export function newer(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

export function binaryVersion(bin, { run = spawnSync } = {}) {
  try {
    const r = run(bin, ['--version'], { encoding: 'utf8', timeout: 20000, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin) });
    return parseVersion(`${r.stdout || ''}`.trim().split('\n').pop());
  } catch {
    return null;
  }
}

/** The project's version from project.godot config/features ("4.5"), or null. */
export function projectVersion(projectDir) {
  try {
    const text = fs.readFileSync(path.join(projectDir, 'project.godot'), 'utf8');
    const m = text.match(/config\/features\s*=\s*PackedStringArray\(([^)]*)\)/);
    const v = m && (m[1].match(/"(\d+\.\d+)"/) || [])[1];
    return v || null;
  } catch {
    return null;
  }
}

export function templatesDir(env = process.env) {
  if (env.STUDIO_GODOT_TEMPLATES) return env.STUDIO_GODOT_TEMPLATES;
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Godot', 'export_templates');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Godot', 'export_templates');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'godot', 'export_templates');
}

/**
 * Every mismatch for one project: { binary, project, templates, unit, problems: [string] }.
 * `binary` may be passed (a parsed version) so callers and tests don't need a Godot on the PATH.
 */
export function checkGodotVersions(projectRel, { bin = process.env.STUDIO_GODOT || 'godot', binary = undefined, env = process.env, root = REPO_ROOT } = {}) {
  const dir = path.join(root, projectRel);
  const bv = binary === undefined ? binaryVersion(bin) : binary;
  const pv = projectVersion(dir);
  const problems = [];
  if (!bv) return { binary: null, project: pv, problems: [`couldn't read the Godot version (${bin} --version)`] };
  if (pv && pv !== bv.minor) problems.push(`the project is Godot ${pv} but the gate runs Godot ${bv.full}: ${newer(bv.minor, pv) ? 'opening it upgrades the project' : 'an older Godot may not open it'} (set STUDIO_GODOT to a ${pv} binary, or move the project to ${bv.minor} on purpose)`);
  let templates = null;
  if (fs.existsSync(path.join(dir, 'export_presets.cfg'))) {
    const tdir = templatesDir(env);
    const have = fs.existsSync(tdir) ? fs.readdirSync(tdir).filter((d) => /^\d+\.\d+/.test(d)) : [];
    templates = have;
    if (!have.includes(bv.label)) problems.push(`export templates for Godot ${bv.label} aren't installed (${tdir} has ${have.length ? have.join(', ') : 'none'}): exports will fail or use the wrong runtime`);
  }
  let unit = null;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'studio', 'godot-unit.json'), 'utf8'));
    if (cfg.enabled && path.normalize(cfg.project || '') === path.normalize(projectRel)) {
      unit = cfg.godot || null;
      const uv = parseVersion(unit);
      if (uv && uv.minor !== bv.minor) problems.push(`gdUnit4 is set up for Godot ${unit} (studio/godot-unit.json) but the gate runs ${bv.full}`);
    }
  } catch {}
  return { binary: bv.full, project: pv, templates, unit, problems };
}
