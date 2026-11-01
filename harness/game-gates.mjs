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
 * 2.58.0: the game's checks run with CI=true (test runners then never write snapshots during a verify).
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
import { selectGates, scopeOf, withGateSlot, matchAny, ALWAYS_SHARED } from './merge-lane.mjs';
import { normMode } from './det-math.mjs';
import { scaledTimeout } from './heavy.mjs';

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
    const list = (j.gates || []).filter((x) => x && x.id && x.command).map((x) => ({ id: `game:${x.id}`, command: x.command, required: x.required !== false, ...(Array.isArray(x.paths) && x.paths.length ? { paths: x.paths.map(String) } : {}), ...(x.track ? { track: String(x.track) } : {}), ...(typeof x.related === 'string' && x.related.includes('{files}') ? { related: x.related } : {}) }));
    // 2.58.2 (PU-22): a manifest with "detMath" (warn or required) gets the deterministic-math check on its sim
    // paths; the cartridge purity gate is skipped for such a game, so this is where it runs. Required fails.
    if (j.detMath !== undefined && !list.some((x) => /check-sim-purity/.test(x.command))) {
      const { mode } = normMode(j.detMath && typeof j.detMath === 'object' ? j.detMath.mode : j.detMath);
      if (mode !== 'off') list.push({ id: 'game:det-math', command: 'node scripts/check-sim-purity.mjs --det-math-only', required: mode === 'required' });
    }
    return list;
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

/**
 * 2.58.5 (H-3): which of the game's checks a change runs, and the scope a pass covers, without running anything:
 * { game, all, shared, gates, skipped, scope, layout, layoutPaths, engine, why }. runGameGates runs this plan;
 * task done uses it to record the right scope when a verify stands in for the checks.
 *
 * incoming (the landing re-check after a rebase onto a moved main, STUDIO_GATE_INCOMING_FILE): the files main brought
 * in. The lane's own pass on its pre-rebase commit stands for a check whose declared inputs ("paths", layoutPaths, a
 * Godot project's folder) none of them touch; such a check is skipped with that reason. A check with no declared
 * paths, or any incoming file that is shared (harness/, scripts/, the manifest, its "shared" globs), runs again.
 */
export async function planGameGates({ paths = [], changed = null, incoming = null } = {}) {
  const game = await studioGame();
  const all = game ? declaredGates(game) : [];
  const shared = game ? sharedPaths(game) : [];
  const sel = game ? selectGates(all, changed, { shared }) : { run: [], skipped: [], why: '' };
  let gates = sel.run;
  const skipped = [...sel.skipped];
  let scope = game && all.length ? scopeOf(gates, shared) : null;
  // 2.30o: the game's layout rules (studio.layout.json), when it declares them; unscoped unless the manifest names
  // its inputs ("layoutPaths").
  const layout = Boolean(game?.root && fs.existsSync(path.join(REPO_ROOT, game.root, 'studio.layout.json')) && process.env.STUDIO_LAYOUT_GATE !== 'off');
  let layoutPaths = null;
  if (layout) {
    try { const lp = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, game.root, 'studio.gates.json'), 'utf8')).layoutPaths; layoutPaths = Array.isArray(lp) && lp.length ? lp.map(String) : null; } catch {}
    scope = scope && layoutPaths ? [...scope, ...layoutPaths] : null;
  }
  let engine = engineGates(paths);
  if (scope) scope = [...new Set([...scope, ...engine.map((e) => `${e.project}/**`)])];
  let runLayout = layout;
  if (Array.isArray(incoming)) {
    const files = incoming.map((f) => String(f).replace(/\\/g, '/')).filter(Boolean);
    const hitShared = files.find((f) => matchAny(f, [...ALWAYS_SHARED, ...shared]));
    const untouched = (globs) => !hitShared && !files.some((f) => matchAny(f, globs));
    const why = `none of the ${files.length} file(s) the rebase brought in are among its inputs; it passed on this lane's commit before the rebase`;
    const keep = [];
    for (const g of gates) {
      if (g.paths?.length && untouched(g.paths)) skipped.push({ id: g.id, why });
      else keep.push(g);
    }
    gates = keep;
    if (layout && layoutPaths && untouched(layoutPaths)) { runLayout = false; skipped.push({ id: 'game:layout', why }); }
    const keepEngine = [];
    for (const e of engine) {
      if (untouched([`${e.project}/**`])) skipped.push({ id: e.id, why });
      else keepEngine.push(e);
    }
    engine = keepEngine;
  }
  return { game, all, shared, gates, skipped, scope, layout: runLayout, layoutPaths, engine, why: sel.why || '' };
}

/** 2.44.0: related tests only (STUDIO_GATE_RELATED=on, or STUDIO_WHOLE_GAME=on). */
export const relatedTestsOn = (env = process.env) => /^(on|1|true|yes)$/i.test(env.STUDIO_GATE_RELATED || '') || /^(on|1|true|yes)$/i.test(env.STUDIO_WHOLE_GAME || '');

/** The files a landing re-check was told main brought in (STUDIO_GATE_INCOMING_FILE), or null (unknown: no filter). */
export function readIncoming(env = process.env) {
  const f = env.STUDIO_GATE_INCOMING_FILE;
  if (!f) return null;
  try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(j.incoming) ? j.incoming.map(String) : null; } catch { return null; }
}

/** Run the game's checks and the engine gate for these paths. */
export async function runGameGates({ paths = [], changed = null, incoming = null, quiet = false } = {}) {
  const plan = await planGameGates({ paths, changed, incoming });
  const { game, all, gates, scope } = plan;
  const rows = [];
  const skipped = [...plan.skipped];
  const log = (s) => !quiet && console.log(s);
  // 2.31.0: heavy checks take a box-wide gate slot (shared by every lane copy through the main checkout).
  let slotRoot = REPO_ROOT;
  try { slotRoot = (await import('./worktree.mjs')).mainRoot(); } catch {}
  const slot = (label, fn) => withGateSlot(slotRoot, label, fn, { log: (m) => console.error(m) });
  if (game) {
    if (plan.why) log(`[game-gates] ${plan.why}`);
    if (!all.length) rows.push({ id: 'game:none', ok: false, required: true, why: `the game ${game.name} declares no checks: add ${game.root || `web/${game.name}`}/studio.gates.json or ${game.sim || '<game>/sim'}/qa.mjs` });
    // 2.44.0: related tests only. A gate may declare `related` (a command with {files}, such as
    // "cd game/x && npx vitest related --run --passWithNoTests {files}"): when the change is known and is only
    // code files under the game, that runs instead of the whole suite. Only when the whole suite still runs
    // after landing (STUDIO_WHOLE_GAME=on) or STUDIO_GATE_RELATED=on says so. A real 2,244-test game: a leaf
    // module's tests took 2.5 s instead of 5 min 40 s.
    const relatedOn = relatedTestsOn();
    const prefix = `${game.root}/`;
    const changedHere = (changed || []).map((f) => String(f).replace(/\\/g, '/')).filter((f) => f.startsWith(prefix));
    const codeOnly = changedHere.length && changedHere.every((f) => /\.(m?[jt]sx?|cjs|vue|svelte)$/i.test(f)) && !/ is shared/.test(plan.why || '');
    const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
    let cmdLabel = '';
    // 2.58.0 (F2): the game's checks run with CI=true, so test runners (Vitest, Jest, ...) never write or rewrite
    // snapshots during a verify (on Windows each verify rewrote a snapshot's line endings on main). Updating
    // snapshots is a deliberate run with -u. STUDIO_GAME_GATE_CI=off leaves CI as it is.
    const env = /^(off|0|false|no)$/i.test(process.env.STUDIO_GAME_GATE_CI || '') ? process.env : { ...process.env, CI: 'true' };
    // 2.59.0 (#2): the timeout is scaled for load, judged once the check has its slot (harness/heavy.mjs
    // scaledTimeout): other heavy work running (a full verify, the Unity gate, a browser playtest), other game checks,
    // a high load average. Never below STUDIO_GAME_GATE_TIMEOUT_MS (600 s), at most STUDIO_GAME_GATE_TIMEOUT_MAX_FACTOR
    // (3) times it; the value used is printed and kept in the check's row, so a real hang still fails, just later.
    const baseTimeout = Number(process.env.STUDIO_GAME_GATE_TIMEOUT_MS || 600000);
    let timing = { ms: baseTimeout, base: baseTimeout, factor: 1, why: '' };
    const runOnce = (cmd) => slot(cmdLabel, () => {
      timing = scaledTimeout(baseTimeout, slotRoot);
      if (timing.factor > 1) console.error(`[game-gates] ${cmdLabel}: timeout ${Math.round(timing.ms / 1000)} s (${Math.round(baseTimeout / 1000)} s x ${timing.factor}: ${timing.why}; STUDIO_GAME_GATE_TIMEOUT_SCALE=off keeps ${Math.round(baseTimeout / 1000)} s)`);
      if (timing.factor > 1) emitEvent({ type: 'gate.timeout_scaled', agent: process.env.STUDIO_LOCK_OWNER || 'gates', msg: `${cmdLabel}: timeout ${Math.round(timing.ms / 1000)} s (${Math.round(baseTimeout / 1000)} s x ${timing.factor}): ${timing.why}`.slice(0, 400), meta: { gate: cmdLabel, timeoutMs: timing.ms, baseMs: baseTimeout, factor: timing.factor } });
      return spawnSync(cmd, { cwd: REPO_ROOT, shell: true, encoding: 'utf8', env, maxBuffer: 32 * 1024 * 1024, timeout: timing.ms });
    });
    for (const g of gates) {
      cmdLabel = g.id;
      const existing = changedHere.filter((f) => fs.existsSync(path.join(REPO_ROOT, f))).map((f) => f.slice(prefix.length));
      const related = Boolean(g.related && relatedOn && codeOnly && existing.length);
      const cmd = related ? g.related.replace('{files}', existing.map(q).join(' ')) : g.command;
      if (related) log(`[game-gates] ${g.id}: only the tests related to the ${existing.length} changed file(s) (the whole suite runs in the whole-game check after landing)`);
      let r = runOnce(cmd);
      if (r.error?.code === 'ETIMEDOUT' || (r.status === null && r.signal)) r.stderr = `${r.stderr || ''}\nError: timed out after ${Math.round(timing.ms / 1000)} s (STUDIO_GAME_GATE_TIMEOUT_MS${timing.factor > 1 ? ` ${Math.round(baseTimeout / 1000)} s x ${timing.factor} for load` : ''})`;
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
      rows.push({ id: g.id, ok: r.status === 0 && sg.ok, required: g.required, ...(timing.factor > 1 ? { timeoutMs: timing.ms, timeoutBaseMs: baseTimeout, timeoutWhy: timing.why } : {}), ...(failures?.length ? { failures } : {}), why: r.status === 0 ? sg.why : `exit ${r.status}${tail ? `: ${tail.slice(0, 300)}` : ''}`, ...(related ? { related: existing.length } : {}), ...(flaky ? { flaky } : {}) });
    }
  }
  // 2.30o: the game's layout rules (studio.layout.json), when it declares them.
  if (plan.layout) {
    const { runLayoutGate } = await import('./layout-gate.mjs');
    const lay = runLayoutGate({ gameDir: game.root });
    rows.push({ id: 'game:layout', ok: lay.ok, required: true, why: lay.ok ? '' : lay.why.slice(0, 400) });
  }
  for (const e of plan.engine) {
    const r = slot(e.id, () => runGodot(e.project));
    for (const n of r.notes || []) log(`[game-gates] WARN ${e.id}: ${n} (STUDIO_GODOT_PIN=fail makes this fail the gate)`);
    rows.push({ id: e.id, ok: r.ok, required: true, why: r.why });
  }
  // 2.60.0: a failing check's test names, one JSON line, so the merge train can tell a red that is only the game's
  // declared pins (harness/train.mjs pinsOnlyRed) from any other.
  for (const r of rows) {
    log(`[game-gates] ${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.why ? `: ${r.why}` : ''}`);
    if (!r.ok && r.failures?.length) log(`[game-gates] failing tests in ${r.id}: ${JSON.stringify(r.failures)}`);
  }
  for (const s of skipped) log(`[game-gates] SKIP ${s.id}: ${s.why}`);
  if (!rows.length && !skipped.length) log(`[game-gates] no studio game set${game ? '' : ' (or it is a cartridge)'}; the cartridge gates cover it`);
  const failed = rows.filter((r) => !r.ok && r.required);
  return { ok: failed.length === 0, game: game?.name || null, rows, failed, skipped, scope };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const a = process.argv.slice(2);
  const paths = String(a.includes('--paths') ? a[a.indexOf('--paths') + 1] || '' : process.env.STUDIO_GATE_PATHS || '').split(',').filter(Boolean);
  const ch = String(a.includes('--changed') ? a[a.indexOf('--changed') + 1] || '' : process.env.STUDIO_GATE_CHANGED || '').split(',').filter(Boolean);
  // 2.58.5 (H-3): --plan prints which checks would run and the scope a pass covers, running nothing.
  if (a.includes('--plan')) {
    const p = await planGameGates({ paths, changed: ch.length ? ch : null });
    console.log(JSON.stringify({ game: p.game?.name || null, gates: [...p.gates.map((g) => g.id), ...(p.layout ? ['game:layout'] : []), ...p.engine.map((e) => e.id)], skipped: p.skipped, scope: p.scope }));
    process.exit(0);
  }
  const res = await runGameGates({ paths, changed: ch.length ? ch : null, incoming: readIncoming(), quiet: a.includes('--json') });
  if (a.includes('--json')) console.log(JSON.stringify(res));
  process.exit(res.ok ? 0 : 1);
}
