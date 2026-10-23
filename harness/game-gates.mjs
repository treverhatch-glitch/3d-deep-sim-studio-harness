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
 *   node harness/game-gates.mjs [--paths a,b] [--json]     exit 1 when a required check fails
 * No game set (or the game is a cartridge): nothing extra runs, the cartridge gates cover it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './event.mjs';

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
    return (j.gates || []).filter((x) => x && x.id && x.command).map((x) => ({ id: `game:${x.id}`, command: x.command, required: x.required !== false }));
  }
  const out = [];
  if (game.sim) {
    for (const [id, f] of [['qa', 'qa.mjs'], ['playtest', 'playtest.mjs'], ['golden', 'golden.mjs']]) {
      if (exists(`${game.sim}/${f}`)) out.push({ id: `game:${id}`, command: `node ${game.sim}/${f}`, required: true });
    }
  }
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
  const opts = { cwd: REPO_ROOT, encoding: 'utf8', timeout: Number(process.env.STUDIO_GODOT_TIMEOUT_MS || 300000), maxBuffer: 32 * 1024 * 1024, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin) };
  const steps = [['--headless', '--path', project, '--import']];
  if (fs.existsSync(path.join(REPO_ROOT, project, 'tools', 'gate.gd'))) steps.push(['--headless', '--path', project, '--script', 'res://tools/gate.gd']);
  for (const args of steps) {
    const r = spawnSync(opts.shell ? `"${bin}"` : bin, args, opts);
    const text = `${r.stdout || ''}\n${r.stderr || ''}`;
    if (r.error) return { ok: false, why: `could not run Godot (${bin}): ${r.error.code || r.error.message}` };
    const bad = text.split('\n').find((l) => ERR.test(l));
    if (r.status !== 0 || bad) return { ok: false, why: `${args.includes('--import') ? 'import' : 'gate.gd'} ${r.status !== 0 ? `exited ${r.status}` : 'printed an error'}${bad ? `: ${bad.trim().slice(0, 200)}` : ''}` };
  }
  return { ok: true, why: '' };
}

/** Run the game's checks and the engine gate for these paths. */
export async function runGameGates({ paths = [], quiet = false } = {}) {
  const game = await studioGame();
  const rows = [];
  const log = (s) => !quiet && console.log(s);
  if (game) {
    const gates = declaredGates(game);
    if (!gates.length) rows.push({ id: 'game:none', ok: false, required: true, why: `the game ${game.name} declares no checks: add ${game.root || `web/${game.name}`}/studio.gates.json or ${game.sim || '<game>/sim'}/qa.mjs` });
    for (const g of gates) {
      const r = spawnSync(g.command, { cwd: REPO_ROOT, shell: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: Number(process.env.STUDIO_GAME_GATE_TIMEOUT_MS || 600000) });
      const tail = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').filter((l) => /FAIL|Error|error/.test(l)).slice(0, 3).join(' | ');
      rows.push({ id: g.id, ok: r.status === 0, required: g.required, why: r.status === 0 ? '' : `exit ${r.status}${tail ? `: ${tail.slice(0, 300)}` : ''}` });
    }
  }
  // 2.30o: the game's layout rules (studio.layout.json), when it declares them.
  if (game?.root && fs.existsSync(path.join(REPO_ROOT, game.root, 'studio.layout.json')) && process.env.STUDIO_LAYOUT_GATE !== 'off') {
    const { runLayoutGate } = await import('./layout-gate.mjs');
    const lay = runLayoutGate({ gameDir: game.root });
    rows.push({ id: 'game:layout', ok: lay.ok, required: true, why: lay.ok ? '' : lay.why.slice(0, 400) });
  }
  for (const e of engineGates(paths)) {
    const r = runGodot(e.project);
    rows.push({ id: e.id, ok: r.ok, required: true, why: r.why });
  }
  for (const r of rows) log(`[game-gates] ${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.why ? `: ${r.why}` : ''}`);
  if (!rows.length) log(`[game-gates] no studio game set${game ? '' : ' (or it is a cartridge)'}; the cartridge gates cover it`);
  const failed = rows.filter((r) => !r.ok && r.required);
  return { ok: failed.length === 0, game: game?.name || null, rows, failed };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const a = process.argv.slice(2);
  const paths = String(a.includes('--paths') ? a[a.indexOf('--paths') + 1] || '' : process.env.STUDIO_GATE_PATHS || '').split(',').filter(Boolean);
  const res = await runGameGates({ paths, quiet: a.includes('--json') });
  if (a.includes('--json')) console.log(JSON.stringify(res));
  process.exit(res.ok ? 0 : 1);
}
