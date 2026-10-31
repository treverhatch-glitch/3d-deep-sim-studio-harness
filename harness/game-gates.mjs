#!/usr/bin/env node
/**
 * harness/game-gates.mjs — 2.30n: the gates follow the studio's game, not the bundled cartridge.
 *
 * In the Marina run every `npm run verify` and `task done` checked cartridges/example-sim, so the game
 * actually being built was never gated and builders had to --force. Now, when a game is set
 * (`task game <name>`, studio/game.json "game", STUDIO_GAME) and it is not a cartridge, its own checks run:
 *
 *   <game>/studio.gates.json   { "gates": [{ "id": "playtest", "command": "node tools/x.mjs", "required": true }] }
 *                              commands run from the repo root
 *   else, by convention:       <sim>/qa.mjs (scenarios; exit 1 fails), <sim>/playtest.mjs, <sim>/golden.mjs
 *
 * Engine gate: a task whose files are in a Godot project (a folder with project.godot) also runs Godot
 * headless: --import, then tools/gate.gd when the project has one. A non-zero exit or a SCRIPT ERROR /
 * Parse Error / ERROR: line fails it. Godot binary: STUDIO_GODOT, else godot on PATH.
 *
 *   node harness/game-gates.mjs [--paths a,b] [--changed a,b] [--json]   exit 1 when a required check fails
 *
 * 2.30p: a gate may declare "paths" (globs) and "track"; the manifest may declare "shared" globs. With
 * --changed (or STUDIO_GATE_CHANGED), only gates whose paths the change touches run; skipped gates are
 * logged with the reason. A gate without paths always runs, and no --changed means every gate runs.
 * No game set (or the game is a cartridge): nothing extra runs, the cartridge gates cover it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { judgePass } from './silent-green.mjs';
import { pinMode, checkGodotVersions } from './godot-version.mjs';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, emitEvent } from './event.mjs';
import { selectGates, scopeOf, withGateSlot } from './merge-lane.mjs';

const exists = (rel) => fs.existsSync(path.join(REPO_ROOT, rel));

/** Files Godot writes on import or in the editor; they never block a task or a merge. */
export const isEngineChurn = (f) => /(^|\/)\.godot\//.test(f) || /\.import$/.test(f) || /\.(uid|tmp)$/.test(f) || /(^|\/)\.import\//.test(f);

/** The studio's game when it is not a cartridge: { name, root, sim } or null. */
export async function studioGame() {
  const { activeGame } = await import('./cartridge.mjs');
  const g = activeGame();
  if (!g.name || !['STUDIO_GAME', 'studio/game.json game'].includes(g.from)) return null;
  if (exists(`cartridges/${g.name}/index.mjs`)) return null; // a cartridge: the cartridge gates already check it
  const root = [`game/${g.name}`, `web/${g.name}`].find(exists);
  if (!root) return { name: g.name, root: null, sim: null };
  return { name: g.name, root, sim: exists(`${root}/sim`) ? `${root}/sim` : null };
}

/** The checks the game declares (manifest first, then conventional files). */
export function declaredGates(game) {
  if (!game?.root) return [];
  const man = path.join(REPO_ROOT, game.root, 'studio.gates.json');
  if (fs.existsSync(man)) {
    const j = JSON.parse(fs.readFileSync(man, 'utf8'));
    return (j.gates || []).filter((x) => x && x.id && x.command).map((x) => ({ id: `game:${x.id}`, command: x.command, required: x.required !== false, ...(Array.isArray(x.paths) && x.paths.length ? { paths: x.paths.map(String) } : {}), ...(x.track ? { track: String(x.track) } : {}), ...(typeof x.related === 'string' && x.related.includes('{files}') ? { related: x.related } : {}) }));
  }
  const out = [];
  if (game.sim) {
    for (const [id, f] of [['qa', 'qa.mjs'], ['playtest', 'playtest.mjs'], ['golden', 'golden.mjs']]) {
      if (exists(`${game.sim}/${f}`)) out.push({ id: `game:${id}`, command: `node ${game.sim}/${f}`, required: true });
    }
  }
  return out;
}

/** 2.30p: the manifest's shared globs (a change there runs every gate), plus the manifest itself. */
export function sharedPaths(game) {
  if (!game?.root) return [];
  const out = [`${game.root}/studio.gates.json`];
  const man = path.join(REPO_ROOT, game.root, 'studio.gates.json');
  try { const j = JSON.parse(fs.readFileSync(man, 'utf8')); if (Array.isArray(j.shared)) out.push(...j.shared.map(String)); } catch {}
  return out;
}

/** Godot projects that hold any of these paths (nearest folder with project.godot). */
export function godotProjects(paths = []) {
  const found = new Set();
  for (const p of paths) {
    let d = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
    while (d && d !== '.') {
      if (fs.existsSync(path.join(REPO_ROOT, d, 'project.godot'))) { found.add(d); break; }
      const up = path.posix.dirname(d);
      if (up === d) break;
      d = up;
    }
  }
  return [...found].sort();
}

const ERR = /SCRIPT ERROR|Parse Error|^\s*ERROR:|Failed to load script|Failed loading resource/m;
export const godotBin = () => process.env.STUDIO_GODOT || 'godot';

export function engineGates(paths) {
  return godotProjects(paths).map((p) => ({ id: `engine:${p}`, project: p, required: true }));
}

function runGodot(project) {
  const bin = godotBin();
  // 2.42.0: the binary, the project, the export templates and gdUnit4 must agree on the version
  // (harness/godot-version.mjs). Notes by default; STUDIO_GODOT_PIN=fail makes a mismatch fail the gate.
  let notes = [];
  if (pinMode() !== 'off') {
    const v = checkGodotVersions(project, { bin });
    notes = v.problems.map((p) => `Godot version: ${p}`);
    if (pinMode() === 'fail' && v.problems.length) return { ok: false, why: notes.join('; '), notes: [] };
  }
  // 2.32.0: tools/gate.gd presses every control in tools/controls.gd and writes one result per id here,
  // for the controls check (qa/controls-check.mjs).
  const reports = path.join(REPO_ROOT, 'qa', 'reports');
  fs.mkdirSync(reports, { recursive: true });
  const env = { ...process.env, STUDIO_CONTROLS_OUT: path.join(reports, `controls-godot-${project.replace(/[^\w.-]+/g, '_')}.json`) };
  const opts = { cwd: REPO_ROOT, encoding: 'utf8', env, timeout: Number(process.env.STUDIO_GODOT_TIMEOUT_MS || 300000), maxBuffer: 32 * 1024 * 1024, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin) };
  const steps = [['--headless', '--path', project, '--import']];
  if (fs.existsSync(path.join(REPO_ROOT, project, 'tools', 'gate.gd'))) steps.push(['--headless', '--path', project, '--script', 'res://tools/gate.gd']);
  for (const args of steps) {
    const r = spawnSync(opts.shell ? `"${bin}"` : bin, args, opts);
    const text = `${r.stdout || ''}\n${r.stderr || ''}`;
    if (r.error) return { ok: false, why: `could not run Godot (${bin}): ${r.error.code || r.error.message}`, notes };
    const bad = text.split('\n').find((l) => ERR.test(l));
    if (r.status !== 0 || bad) return { ok: false, why: `${args.includes('--import') ? 'import' : 'gate.gd'} ${r.status !== 0 ? `exited ${r.status}` : 'printed an error'}${bad ? `: ${bad.trim().slice(0, 200)}` : ''}`, notes };
  }
  return { ok: true, why: '', notes };
}

/** Run the game's checks and the engine gate for these paths. */
export async function runGameGates({ paths = [], changed = null, quiet = false } = {}) {
  const game = await studioGame();
  const rows = [];
  const skipped = [];
  let scope = null;
  const log = (s) => !quiet && console.log(s);
  // 2.31.0: heavy checks take a box-wide gate slot (shared by every lane copy through the main checkout).
  let slotRoot = REPO_ROOT;
  try { slotRoot = (await import('./worktree.mjs')).mainRoot(); } catch {}
  const slot = (label, fn) => withGateSlot(slotRoot, label, fn, { log: (m) => console.error(m) });
  if (game) {
    const all = declaredGates(game);
    const shared = sharedPaths(game);
    const sel = selectGates(all, changed, { shared });
    const gates = sel.run;
    skipped.push(...sel.skipped);
    scope = all.length ? scopeOf(gates, shared) : null;
    if (sel.why) log(`[game-gates] ${sel.why}`);
    if (!all.length) rows.push({ id: 'game:none', ok: false, required: true, why: `the game ${game.name} declares no checks: add ${game.root || `web/${game.name}`}/studio.gates.json or ${game.sim || '<game>/sim'}/qa.mjs` });
    // 2.44.0: related tests only. A gate may declare `related` (a command with {files}, such as
    // "cd game/x && npx vitest related --run --passWithNoTests {files}"): when the change is known and is only
    // code files under the game, that runs instead of the whole suite. Only when the whole suite still runs
    // after landing (STUDIO_WHOLE_GAME=on) or STUDIO_GATE_RELATED=on says so. A real 2,244-test game: a leaf
    // module's tests took 2.5 s instead of 5 min 40 s.
    const relatedOn = /^(on|1|true|yes)$/i.test(process.env.STUDIO_GATE_RELATED || '') || /^(on|1|true|yes)$/i.test(process.env.STUDIO_WHOLE_GAME || '');
    const prefix = `${game.root}/`;
    const changedHere = (changed || []).map((f) => String(f).replace(/\\/g, '/')).filter((f) => f.startsWith(prefix));
    const codeOnly = changedHere.length && changedHere.every((f) => /\.(m?[jt]sx?|cjs|vue|svelte)$/i.test(f)) && !/ is shared/.test(sel.why || '');
    const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
    let cmdLabel = '';
    const runOnce = (cmd) => slot(cmdLabel, () => spawnSync(cmd, { cwd: REPO_ROOT, shell: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: Number(process.env.STUDIO_GAME_GATE_TIMEOUT_MS || 600000) }));
    for (const g of gates) {
      cmdLabel = g.id;
      const existing = changedHere.filter((f) => fs.existsSync(path.join(REPO_ROOT, f))).map((f) => f.slice(prefix.length));
      const related = Boolean(g.related && relatedOn && codeOnly && existing.length);
      const cmd = related ? g.related.replace('{files}', existing.map(q).join(' ')) : g.command;
      if (related) log(`[game-gates] ${g.id}: only the tests related to the ${existing.length} changed file(s) (the whole suite runs in the whole-game check after landing)`);
      let r = runOnce(cmd);
      if (r.error?.code === 'ETIMEDOUT' || (r.status === null && r.signal)) r.stderr = `${r.stderr || ''}\nError: timed out after ${Math.round(Number(process.env.STUDIO_GAME_GATE_TIMEOUT_MS || 600000) / 1000)} s (STUDIO_GAME_GATE_TIMEOUT_MS)`;
      // 2.44.0: STUDIO_GAME_GATE_RETRY=on (opt-in): a failed check runs once more before it counts. Passing the
      // second time is logged as flaky (gate.flaky), a real game's 30-day test failed on a busy box only.
      let flaky = null;
      if (r.status !== 0 && /^(on|1|true|yes)$/i.test(process.env.STUDIO_GAME_GATE_RETRY || '')) {
        const first = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').filter((l) => /FAIL|Error|error/.test(l)).slice(0, 2).join(' | ');
        const again = runOnce(cmd);
        if (again.status === 0) {
          flaky = first.slice(0, 200) || `exit ${r.status}`;
          emitEvent({ type: 'gate.flaky', agent: 'gates', to: 'producer', status: 'warn', msg: `${g.id} failed, then passed when run again: ${flaky}`, meta: { gate: g.id } });
          log(`[game-gates] WARN ${g.id} failed, then passed when run again (flaky: ${flaky})`);
          r = again;
        } else r = again;
      }
      const tail = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').filter((l) => /FAIL|Error|error/.test(l)).slice(0, 3).join(' | ');
      // 2.36.0: exit 0 with "nothing was run" is a silent green (harness/silent-green.mjs; warn by default).
      // A related run with no related tests is fine: the whole suite runs after landing.
      const sg = r.status === 0 ? (related ? { ok: true, why: '', note: '' } : judgePass(g.id, { output: `${r.stdout || ''}${r.stderr || ''}` })) : null;
      if (sg?.note) log(`[game-gates] WARN ${sg.note}`);
      // 2.54.0 (PU-06): the failing test names, so a task is judged only on failures that are new since it was claimed.
      const failures = r.status === 0 ? null : (await import('./baseline.mjs')).failingTests(`${r.stdout || ''}${r.stderr || ''}`);
      rows.push({ id: g.id, ok: r.status === 0 && sg.ok, required: g.required, ...(failures?.length ? { failures } : {}), why: r.status === 0 ? sg.why : `exit ${r.status}${tail ? `: ${tail.slice(0, 300)}` : ''}`, ...(related ? { related: existing.length } : {}), ...(flaky ? { flaky } : {}) });
    }
  }
  // 2.30o: the game's layout rules (studio.layout.json), when it declares them.
  if (game?.root && fs.existsSync(path.join(REPO_ROOT, game.root, 'studio.layout.json')) && process.env.STUDIO_LAYOUT_GATE !== 'off') {
    const { runLayoutGate } = await import('./layout-gate.mjs');
    const lay = runLayoutGate({ gameDir: game.root });
    rows.push({ id: 'game:layout', ok: lay.ok, required: true, why: lay.ok ? '' : lay.why.slice(0, 400) });
    // 2.30p: the layout gate is unscoped unless the manifest names its inputs ("layoutPaths").
    let lp = null;
    try { lp = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, game.root, 'studio.gates.json'), 'utf8')).layoutPaths; } catch {}
    scope = scope && Array.isArray(lp) && lp.length ? [...scope, ...lp.map(String)] : null;
  }
  const eg = engineGates(paths);
  if (scope) scope = [...new Set([...scope, ...eg.map((e) => `${e.project}/**`)])];
  for (const e of eg) {
    const r = slot(e.id, () => runGodot(e.project));
    for (const n of r.notes || []) log(`[game-gates] WARN ${e.id}: ${n} (STUDIO_GODOT_PIN=fail makes this fail the gate)`);
    rows.push({ id: e.id, ok: r.ok, required: true, why: r.why });
  }
  for (const r of rows) log(`[game-gates] ${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.why ? `: ${r.why}` : ''}`);
  for (const s of skipped) log(`[game-gates] SKIP ${s.id}: ${s.why}`);
  if (!rows.length) log(`[game-gates] no studio game set${game ? '' : ' (or it is a cartridge)'}; the cartridge gates cover it`);
  const failed = rows.filter((r) => !r.ok && r.required);
  return { ok: failed.length === 0, game: game?.name || null, rows, failed, skipped, scope };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const a = process.argv.slice(2);
  const paths = String(a.includes('--paths') ? a[a.indexOf('--paths') + 1] || '' : process.env.STUDIO_GATE_PATHS || '').split(',').filter(Boolean);
  const ch = String(a.includes('--changed') ? a[a.indexOf('--changed') + 1] || '' : process.env.STUDIO_GATE_CHANGED || '').split(',').filter(Boolean);
  const res = await runGameGates({ paths, changed: ch.length ? ch : null, quiet: a.includes('--json') });
  if (a.includes('--json')) console.log(JSON.stringify(res));
  process.exit(res.ok ? 0 : 1);
}
