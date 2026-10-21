#!/usr/bin/env node
/**
 * scripts/studio-setup.mjs — a studio setup: the reusable parts of a studio, in one folder you can keep,
 * share, or hand to a new game.
 *
 *   npm run new-studio -- --name "<game>" --setup <folder>|this     start a new game from a setup
 *   npm run new-studio -- --save-setup <folder>                       save this studio's setup to a folder
 *   node scripts/studio-setup.mjs apply <folder> [--into <studio>]    apply a setup to a studio
 *
 * A setup folder mirrors the studio. Only these paths are used; anything else is skipped and named:
 *   studio/roles/**, studio/skills/**, studio/presets/**, studio/rules/**   your own roles, skills, presets, rules
 *   studio/divisions.json, studio/budget.json, studio/mode.json           departments, plan limits, pace
 *   cartridges/<id>/**, web/<id>/**                                        a game template to start from
 *   intake-answers.json                                                    answers for `npm run intake --answers`
 *   settings.env                                                           STUDIO_*, HUB_*, AGENT_*, PLAYTEST_* lines
 * Never in a setup: keys, tokens or passwords (lines that look like one are dropped and named), the
 * harness itself (harness/, hub/, qa/, scripts/), or a game's progress (the board, events, locks).
 * `this` (or --save-setup) takes the current studio's roles, skills, presets, rules, departments,
 * budget and pace, and never its game, its Bible or its .env.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED = [/^studio\/(roles|skills|presets|rules)\//, /^studio\/(divisions|budget|mode)\.json$/, /^cartridges\/[^/]+\//, /^web\/[^/]+\//, /^intake-answers\.json$/, /^settings\.env$/];
const SECRET = /(KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|AUTH)/i;
const SETTING = /^\s*((?:STUDIO|HUB|AGENT|PLAYTEST)_[A-Z0-9_]+)\s*=/;

function walk(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) return [];
    return e.isDirectory() ? walk(p, base) : [path.relative(base, p).split(path.sep).join('/')];
  });
}

/** The lines of settings.env a setup may carry: studio settings only, never anything that looks like a key. */
export function safeSettings(text) {
  const keep = [];
  const dropped = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(SETTING);
    if (!m) continue;
    if (SECRET.test(m[1]) || /^HUB_PORT$|^STUDIO_PLAY_PORT$/.test(m[1])) dropped.push(m[1]);
    else keep.push(line.trim());
  }
  return { keep, dropped };
}

/** Copy a setup into a studio. Returns what was copied, skipped and dropped; never touches the harness. */
export function applySetup(src, into = ROOT) {
  const from = path.resolve(src);
  if (!fs.existsSync(from) || !fs.statSync(from).isDirectory()) return { ok: false, message: `No setup folder at ${src}` };
  const copied = [];
  const skipped = [];
  let dropped = [];
  for (const rel of walk(from)) {
    if (!ALLOWED.some((r) => r.test(rel))) {
      skipped.push(rel);
      continue;
    }
    if (rel === 'settings.env') {
      const s = safeSettings(fs.readFileSync(path.join(from, rel), 'utf8'));
      dropped = s.dropped;
      if (s.keep.length) fs.appendFileSync(path.join(into, '.env'), `\n# From the setup ${path.basename(from)}\n${s.keep.join('\n')}\n`);
      copied.push(`settings.env (${s.keep.length} setting(s))`);
      continue;
    }
    const dest = rel === 'intake-answers.json' ? path.join(into, 'studio', 'intake-answers.json') : path.join(into, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(from, rel), dest);
    copied.push(rel);
  }
  return { ok: true, copied, skipped, dropped, intake: fs.existsSync(path.join(into, 'studio', 'intake-answers.json')) && copied.includes('intake-answers.json') };
}

/** Save this studio's reusable parts (not its game) as a setup folder. */
export function saveSetup(out, from = ROOT) {
  const dest = path.resolve(out);
  if (fs.existsSync(dest) && fs.readdirSync(dest).length) return { ok: false, message: `${out} already exists and isn't empty.` };
  const saved = [];
  const parts = [...['roles', 'skills', 'presets', 'rules'].flatMap((d) => walk(path.join(from, 'studio', d)).map((r) => `studio/${d}/${r}`)), ...['divisions', 'budget', 'mode'].map((f) => `studio/${f}.json`).filter((r) => fs.existsSync(path.join(from, r)))];
  for (const rel of parts) {
    fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
    fs.copyFileSync(path.join(from, rel), path.join(dest, rel));
    saved.push(rel);
  }
  const env = fs.existsSync(path.join(from, '.env')) ? safeSettings(fs.readFileSync(path.join(from, '.env'), 'utf8')).keep.filter((l) => !/^\s*(STUDIO_RESULTS_DIR|STUDIO_BACKUP_DIR)\s*=/.test(l)) : [];
  fs.mkdirSync(dest, { recursive: true });
  if (env.length) fs.writeFileSync(path.join(dest, 'settings.env'), `${env.join('\n')}\n`);
  fs.writeFileSync(path.join(dest, 'README.md'), `# Studio setup from ${path.basename(from)}\n\nStart a game with it: \`npm run new-studio -- --name "<game>" --setup ${path.basename(dest)}\`.\nAdd \`intake-answers.json\` (shape: \`npm run intake -- --questions\`) to fill the intake, or a game template under \`cartridges/<id>/\` and \`web/<id>/\`.\nNo keys are saved here: settings.env has studio settings only.\n`);
  return { ok: true, saved: saved.length, settings: env.length, dir: dest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  if (argv[0] === 'apply' && argv[1]) {
    const r = applySetup(argv[1], path.resolve(flag('into') || ROOT));
    if (!r.ok) {
      console.error(r.message);
      process.exit(1);
    }
    console.log(`Copied ${r.copied.length}: ${r.copied.join(', ') || 'nothing'}`);
    if (r.skipped.length) console.log(`Skipped (not part of a setup): ${r.skipped.join(', ')}`);
    if (r.dropped.length) console.log(`Dropped from settings.env (keys and ports never travel): ${r.dropped.join(', ')}`);
    process.exit(0);
  }
  if (argv[0] === 'save' && argv[1]) {
    const r = saveSetup(argv[1]);
    if (!r.ok) {
      console.error(r.message);
      process.exit(1);
    }
    console.log(`Saved ${r.saved} file(s) and ${r.settings} setting(s) to ${r.dir}. No keys.`);
    process.exit(0);
  }
  console.log('Usage: node scripts/studio-setup.mjs apply <folder> [--into <studio>] | save <folder>');
}
