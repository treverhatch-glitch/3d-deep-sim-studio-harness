#!/usr/bin/env node
/**
 * harness/engine.mjs — the engine track: a port of a proven web game to Godot, Unity or Unreal, run as
 * its own team beside the web game, linked to it only by a parity test. Never started on its own.
 *
 *   npm run engine                                   the options, and the track if there is one
 *   npm run engine -- propose godot|unity|unreal --by <producer> [--why "…"]
 *                                                    a "Needs you" question for the game dev (Phase 1 must be proven)
 *   npm run engine -- start godot --by <person>      what a yes does (the War Room's yes calls it)
 *   npm run engine -- capture [--frames 120]         frames of the engine build to engine/<game>/captures/
 *   npm run engine -- port --from <sha> [--by <name>] pin the web rules the port follows to one commit: copies
 *                                                    cartridges/<game>/ at that commit to engine/<game>/port-src/
 *                                                    and records it in engine.json (portFrom), so a moving web game
 *                                                    doesn't block the port. `port` alone shows the pin.
 *
 * The engine's program: STUDIO_GODOT, STUDIO_UNITY or STUDIO_UNREAL (a full path), else godot, unity,
 * UnrealEditor-Cmd on the PATH. A Godot track starts from engine/_godot/: a worked port of the template
 * game with its gate (tests + a smoke run), its parity script and a capture command, all headless.
 *
 * The web version stays the design lab: a mechanic is proven there first (fast), then ported. The
 * engine track gets its own folder (engine/<game>/), department (Engine Transfer), tasks tagged
 * `engine:<name>` with that folder as their lane, its own gate (npm run engine:gate, the engine's own
 * headless test run), and its own recordings. The two versions share the Bible, the phase exits and
 * the sim's numbers, and `npm run parity` plays the same seeds in both and compares the results.
 *
 * Why a gate on Phase 1: a port doubles the agents, and every bug still open doubles with it. From
 * Jed's run: keep it in web until playtests show it plays the way the dev imagined.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, actor, emitEvent } from './event.mjs';
import { activeCartridge, isTemplateCartridge } from './cartridge.mjs';

// Estimates from run #1's SendIt experiment (Godot: a playable game in 3 hours; Unreal: 7 slow hours).
export const ENGINES = {
  godot: {
    label: 'Godot 4',
    cost: 'lowest (the baseline)',
    why: 'Text scenes and GDScript that agents can read and diff, a free headless command line for tests and smoke runs, small installs. Agents can do everything without the editor; SendIt went from nothing to a playable game in about 3 hours. Best for stylised and mid-fidelity 3D.',
    watch: 'Fewer ready-made high-end effects than Unreal.',
    gate: '{bin} --headless --path {folder} --script res://tools/gate.gd',
    parity: '{bin} --headless --path {folder} --script res://tools/parity.gd -- {seeds}',
    // Real frames need a display: xvfb-run is added on a Linux server without one.
    capture: '{bin} --path {folder} --rendering-driver opengl3 --write-movie {folder}/captures/frame.png --fixed-fps 30 --quit-after {frames}',
    webExport: '{folder}/export/web',
    bin: 'godot',
    env: 'STUDIO_GODOT',
    template: 'engine/_godot',
  },
  unity: {
    label: 'Unity',
    cost: 'about 1.5 to 2 times Godot',
    why: 'C# is easy for agents and batch-mode tests work. 2.46.0: the sim is a pure C# assembly that .NET tests and compares with the web game without the editor or a licence (npm run engine:sim, npm run parity), so most changes never wait for Unity.',
    watch: 'Scenes and prefabs are YAML with GUIDs that agents break easily (the template builds its scene in code); the editor gate needs an install and an active licence on each machine that runs it; check the licence and seat terms.',
    // The editor's run: purity, version pin, Edit Mode and Play Mode tests with their NUnit results read (harness/unity.mjs).
    gate: 'node harness/unity.mjs gate {folder}',
    // Parity needs no editor: the same sim source, built with .NET (engine/_unity/tools/SimCli).
    parity: 'dotnet run --project {folder}/tools/SimCli -- parity {seeds}',
    capture: null,
    webExport: '{folder}/Build/WebGL',
    bin: 'unity',
    env: 'STUDIO_UNITY',
    template: 'engine/_unity',
  },
  unreal: {
    label: 'Unreal 5',
    cost: 'about 3 to 5 times Godot',
    why: 'The best visuals.',
    watch: 'Blueprints and .uasset files are binary (agents can\'t read or diff them), C++ builds take minutes, installs and projects are huge. SendIt\'s Unreal attempt made slow progress for about 7 hours. Pick it only when the visuals are the product.',
    gate: '{bin} {folder}/{game}.uproject -ExecCmds="Automation RunTests Project" -unattended -nullrhi -testexit="Automation Test Queue Empty"',
    parity: '{bin} {folder}/{game}.uproject -run=Parity -seeds={seeds} -unattended -nullrhi',
    capture: null,
    webExport: null,
    bin: 'UnrealEditor-Cmd',
    env: 'STUDIO_UNREAL',
    template: null,
  },
};

export const trackFile = (game) => path.join(REPO_ROOT, 'engine', game, 'engine.json');
export function readTrack(game = activeCartridge().name) {
  try {
    return JSON.parse(fs.readFileSync(trackFile(game), 'utf8'));
  } catch {
    return null;
  }
}

/** The engine program for a track: its STUDIO_<ENGINE> path, else the name on the PATH. */
export const engineBin = (engine) => process.env[ENGINES[engine]?.env || ''] || ENGINES[engine]?.bin || engine;
/**
 * A track command ready to run: {bin}, {seeds}, {frames} filled in. The track file keeps {bin}, so the
 * same engine.json works on every machine.
 */
export function engineCommand(track, which, { seeds = [], frames = 120 } = {}) {
  const raw = which === 'parity' ? track.parity?.command : track[which];
  if (!raw) return null;
  let cmd = raw.replaceAll('{bin}', /\s/.test(engineBin(track.engine)) ? `"${engineBin(track.engine)}"` : engineBin(track.engine)).replaceAll('{seeds}', seeds.join(',')).replaceAll('{frames}', String(frames));
  // 2.30h: Godot resolves a relative --write-movie path against the project folder (--path), not the repo, so
  // "engine/<game>/captures/frame.png" landed in engine/<game>/engine/<game>/captures/ (or failed). Make it absolute.
  if (which === 'capture') cmd = cmd.replace(/--write-movie\s+("?)([^"\s]+)\1/, (_, _q, p) => `--write-movie "${path.isAbsolute(p) ? p : path.join(REPO_ROOT, p)}"`);
  // Frames need a display; a Linux server without one gets a virtual one when xvfb-run is installed.
  if (which === 'capture' && process.platform === 'linux' && !process.env.DISPLAY && spawnSync('which', ['xvfb-run']).status === 0) cmd = `xvfb-run -a -s "-screen 0 1280x720x24" ${cmd}`;
  return cmd;
}

/**
 * The engine track's own history (studio/engine/LOG.md): every gate, parity and capture run, with who
 * ran it and on which commit, so how the port was made can be followed run by run.
 */
export function logEngine(line, agent = actor()) {
  const f = path.join(REPO_ROOT, 'studio', 'engine', 'LOG.md');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (!fs.existsSync(f)) fs.writeFileSync(f, '# Engine track log (`studio/engine/LOG.md`)\n\n> Every gate, parity and capture run, newest last: when, who, on which commit, and the result.\n\n');
  const sha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim();
  fs.appendFileSync(f, `- ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${agent}${sha ? ` · ${sha}` : ''} · ${line}\n`);
}

/** Is Phase 1 proven (opened Phase 2, or every exit item ticked and a person said it's fun)? */
export async function phaseOneProven() {
  try {
    const b = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'studio', 'bible', 'bible.json'), 'utf8'));
    if ((b.phase?.open || 0) >= 2) return { ok: true };
    const since = (b.phase?.history || []).find((h) => h.phase === 1)?.at || null;
    const { phaseExitGaps } = await import('./verdict.mjs');
    const gaps = phaseExitGaps(1, since);
    return gaps.length ? { ok: false, why: gaps.join('; ') } : { ok: true };
  } catch {
    return { ok: false, why: 'there is no signed Game Bible yet' };
  }
}

export async function proposeEngine(engine, { by = actor(), why = '' } = {}) {
  const e = ENGINES[engine];
  if (!e) return { ok: false, message: `Pick godot, unity or unreal (npm run engine shows the trade-offs).` };
  const game = activeCartridge().name;
  if (!game || isTemplateCartridge(game)) return { ok: false, message: 'There is no game yet to port (npm run new-game).' };
  if (readTrack(game)) return { ok: false, message: `${game} already has an engine track (${readTrack(game).engine}).` };
  const p = await phaseOneProven();
  if (!p.ok) return { ok: false, message: `Not yet: Phase 1 isn't proven (${p.why}). Keep it in web until a person plays it and says it's fun.` };
  const { ask } = await import('./ask.mjs');
  const q = ask({ question: `Port ${game} to ${e.label}? Expected usage: ${e.cost}. ${e.why} Watch: ${e.watch}`, options: ['yes', 'no'], why: why || `${by} proposes an engine track now that Phase 1 is proven.`, by, action: { type: 'engine', engine, game } });
  if (!q.ok) return q;
  emitEvent({ type: 'engine.proposed', agent: by, to: 'human', msg: `${by} proposes porting ${game} to ${e.label} (${e.cost})` });
  return { ok: true, ask: q.ask };
}

/**
 * 2.46.0: how far the web rules have moved past what the port follows. The web game keeps growing while it is
 * ported; the port follows a pinned commit (npm run engine -- port --from <sha>), and every web commit since
 * that touches the rules (`portSource`, default cartridges/<game>) is work for the port. Returns
 * { pinned, base, commits: ['sha subject'], files } or { pinned: false }.
 */
export function portDrift(t = readTrack()) {
  if (!t?.portFrom?.sha) return { pinned: false, commits: [], files: [] };
  const src = portSources(t);
  const g = (...a) => spawnSync('git', a, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout || '';
  const commits = g('log', '--reverse', '--format=%h %s', `${t.portFrom.sha}..HEAD`, '--', ...src).split('\n').filter(Boolean);
  const files = g('diff', '--name-only', t.portFrom.sha, 'HEAD', '--', ...src).split('\n').filter(Boolean);
  return { pinned: true, base: t.portFrom.sha, sources: src, commits, files };
}

/** The web paths the port follows: engine.json portSource, else cartridges/<game>. */
export const portSources = (t) => (Array.isArray(t?.portSource) && t.portSource.length ? t.portSource : [`cartridges/${t?.game || activeCartridge().name}`]);

/** One port task per web commit not yet ported (duplicates are skipped by the queue). */
export async function queueDrift({ by = actor() } = {}) {
  const t = readTrack();
  const d = portDrift(t);
  if (!d.pinned) return { ok: false, message: 'The port is not pinned yet: npm run engine -- port --from <sha> (the web commit the port matches now).' };
  const { addTask } = await import('./task.mjs');
  const meta = { track: t.track, lane: t.folder, infra: true };
  const ids = [];
  for (const c of d.commits) {
    const [sha, ...subj] = c.split(' ');
    const r = addTask({ title: `Port web change ${sha} (${subj.join(' ').slice(0, 80)}) into ${t.folder}: match it, add a parity field if it adds a number, npm run parity, then npm run engine -- port --from ${sha}`, role: 'engine-porter', priority: 'P2', agent: by, meta });
    if (r?.id && !r.duplicate) ids.push(r.id);
  }
  return { ok: true, drift: d, tasks: ids };
}

/** A yes: the folder, the track file, the department, the first tasks and the parity board. */
export async function startEngine(engine, { by = actor() } = {}) {
  const e = ENGINES[engine];
  const game = activeCartridge().name;
  if (!e || !game || isTemplateCartridge(game)) return { ok: false, message: 'No engine or no game.' };
  if (readTrack(game)) return { ok: true, already: true, track: readTrack(game) };
  const folder = `engine/${game}`;
  const fill = (s) => (s ? s.replaceAll('{folder}', folder).replaceAll('{game}', game) : s);
  let gameId = null;
  try {
    gameId = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'cartridges', game, 'cartridge.json'), 'utf8')).id || null;
  } catch {
    // no ID yet
  }
  // The template game also compares its credits, which proves the RNG port is exact.
  const compare = game === 'example-sim' ? ['outcome', 'tick', 'resources.credits'] : ['outcome', 'tick'];
  const track = { engine, label: e.label, game, gameId, folder, track: `engine:${engine}`, gate: fill(e.gate), parity: { command: fill(e.parity), compare }, capture: fill(e.capture), webExport: fill(e.webExport), started: new Date().toISOString(), by };
  fs.mkdirSync(path.join(REPO_ROOT, folder), { recursive: true });
  // Start from the worked template: project, sim port, gate, parity, capture, a scene built in code.
  if (e.template && fs.existsSync(path.join(REPO_ROOT, e.template))) {
    fs.cpSync(path.join(REPO_ROOT, e.template), path.join(REPO_ROOT, folder), { recursive: true, filter: (src) => !/[\\/]\.godot([\\/]|$)|[\\/](captures|export|Library|Temp|Logs|UserSettings|bin|obj|TestResults)([\\/]|$)/.test(src) });
    fs.rmSync(path.join(REPO_ROOT, folder, 'README.md'), { force: true });
  }
  fs.writeFileSync(trackFile(game), `${JSON.stringify(track, null, 2)}\n`);
  fs.writeFileSync(path.join(REPO_ROOT, folder, 'README.md'), `# ${game}: the ${e.label} version\n\nThe engine track (docs/ENGINE-TRACK.md). Its own folder, team and gate; linked to the web version only by \`npm run parity\`.\n\n- Gate: \`npm run engine:gate\` runs \`${track.gate}\`. It must import the project, run the tests, and play a headless smoke run that fails on any script error.\n- Parity: \`npm run parity\` runs \`${track.parity.command}\` and compares ${track.parity.compare.join(' and ')} with the web cartridge for the same seeds. The command prints one JSON line per seed: {"seed":1,"outcome":"won","tick":300}.\n${track.capture ? `- Frames: \`npm run engine -- capture\` writes engine/${game}/captures/frame*.png (a display is needed; xvfb-run on a Linux server).\n` : ''}${e.template && engine === 'unity' ? `- Started from ${e.template}/, a worked port of the template game: replace Assets/Sim/Sim.cs with ${game}'s rules (cartridges/${game}/index.mjs), keep uint maths for 32-bit values and JsRound for Math.round, and port qa.mjs's start-to-win policy into RunScenario. \`npm run engine:sim\` runs the sim's purity check and tests with .NET (no editor); \`npm run engine:gate\` runs the editor's Edit Mode and Play Mode tests.\n` : e.template ? `- Started from ${e.template}/, a worked port of the template game: replace sim/sim.gd with ${game}'s rules (cartridges/${game}/index.mjs), keep the u32/i32/imul helpers for 32-bit maths, and port qa.mjs's start-to-win policy into run_scenario.\n` : ''}${track.webExport ? `- Web export for the Arcade's engine tab: \`${track.webExport}/index.html\`.\n` : '- Native builds only: the Arcade lists them; there is no web export.\n'}- Scenes built in code where the engine allows it, so every change is a readable diff.\n`);
  const parity = path.join(REPO_ROOT, 'studio', 'engine', 'PARITY.md');
  fs.mkdirSync(path.dirname(parity), { recursive: true });
  if (!fs.existsSync(parity)) fs.writeFileSync(parity, `# Feature parity: web and ${e.label}\n\n> One row per mechanic. A mechanic is proven in web first, then ported. Mark each: web only, ported, engine only.\n\n| Mechanic | Web | ${e.label} | Notes |\n| --- | --- | --- | --- |\n| Start to win (the vertical slice) | yes | not yet | parity: npm run parity |\n`);
  const { setDivision, listDivisions } = await import('./divisions.mjs');
  if (!listDivisions().find((d) => d.id === 'engine')?.active) setDivision('engine', true, by);
  const { addTask } = await import('./task.mjs');
  const meta = { track: track.track, lane: folder, infra: true };
  const tasks = [
    `Set up the ${e.label} project in ${folder} and its headless gate (import, tests, a smoke run that fails on any script error); npm run engine:gate must pass`,
    `Port the sim rules 1:1 from cartridges/${game} into ${folder}/${engine === 'unity' ? 'Assets/Sim/ (pure C#: npm run engine:sim must pass)' : 'sim/'} and make npm run parity pass for seeds 1-5`,
    ...(track.webExport ? [`Web export of the ${e.label} build to ${track.webExport} for the Arcade's engine tab`] : []),
  ].map((title) => addTask({ title, role: 'engine-porter', priority: 'P2', agent: by, meta }).id).filter(Boolean);
  logEngine(`track started: ${e.label} in ${folder}; ${tasks.join(', ')} queued`, by);
  emitEvent({ type: 'engine.started', agent: by, to: 'producer', track: track.track, msg: `Engine track: ${game} to ${e.label} in ${folder}; ${tasks.join(', ')} queued for Engine Transfer` });
  return { ok: true, track, tasks };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  if (argv[0] === 'propose') {
    const r = await proposeEngine(argv[1], { by: flag('by') || actor(), why: flag('why') || '' });
    console[r.ok ? 'log' : 'error'](r.ok ? `Asked the game dev (${r.ask.id}); the track starts when they say yes.` : r.message);
    process.exit(r.ok ? 0 : 1);
  }
  if (argv[0] === 'start') {
    const r = await startEngine(argv[1], { by: flag('by') || actor() });
    console[r.ok ? 'log' : 'error'](r.ok ? (r.already ? 'The engine track already exists.' : `Started: ${r.track.folder} (${r.track.label}); ${r.tasks.join(', ')} queued.`) : r.message);
    process.exit(r.ok ? 0 : 1);
  }
  if (argv[0] === 'port') {
    const t = readTrack();
    if (!t) {
      console.error('No engine track.');
      process.exit(1);
    }
    const from = flag('from');
    if (!from) {
      console.log(t.portFrom ? `The port follows the web rules at ${t.portFrom.sha} (pinned by ${t.portFrom.by}, ${t.portFrom.at.slice(0, 10)}): ${t.folder}/port-src/` : 'Not pinned: the port follows the live web rules. Pin with npm run engine -- port --from <sha>.');
      process.exit(0);
    }
    const sha = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${from}^{commit}`], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim();
    if (!sha) {
      console.error(`${from} isn't a commit in this repo.`);
      process.exit(1);
    }
    const game = t.game || activeCartridge().name;
    // 2.46.0: --source a,b sets the web paths the port follows (an adopted game's rules, e.g. game/hatchfield/src/game).
    if (flag('source')) t.portSource = flag('source').split(',').map((x) => x.trim()).filter(Boolean);
    const srcs = portSources(t);
    const src = srcs[0];
    const ls = spawnSync('git', ['ls-tree', '-r', '--name-only', sha, '--', ...srcs], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const files = String(ls.stdout).split('\n').filter(Boolean);
    if (!files.length) {
      console.error(`${srcs.join(', ')} doesn't exist at ${sha.slice(0, 7)}.`);
      process.exit(1);
    }
    const out = path.join(REPO_ROOT, t.folder, 'port-src');
    fs.rmSync(out, { recursive: true, force: true }); // the harness's own previous pin copy
    for (const f of files) {
      const b = spawnSync('git', ['show', `${sha}:${f}`], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 });
      const dest = path.join(out, srcs.length > 1 ? f : path.relative(src, f));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, b.stdout);
    }
    const by = flag('by') || actor();
    t.portFrom = { sha, by, at: new Date().toISOString(), files: files.length };
    fs.writeFileSync(trackFile(game), `${JSON.stringify(t, null, 2)}\n`);
    logEngine(`port pinned to ${sha.slice(0, 7)} (${files.length} files)`, by);
    emitEvent({ type: 'engine.port_pinned', agent: by, track: t.track, msg: `${t.label} port pinned to the web rules at ${sha.slice(0, 7)} (${files.length} files in ${t.folder}/port-src/)`, meta: { sha } });
    console.log(`Pinned: the port follows ${srcs.join(', ')} at ${sha.slice(0, 7)}; ${files.length} file(s) in ${t.folder}/port-src/.`);
    process.exit(0);
  }
  if (argv[0] === 'drift') {
    const t = readTrack();
    if (!t) { console.error('No engine track.'); process.exit(1); }
    if (argv.includes('--queue')) {
      const r = await queueDrift({ by: flag('by') || actor() });
      if (!r.ok) { console.error(r.message); process.exit(1); }
      console.log(r.drift.commits.length ? `${r.drift.commits.length} web change(s) to port since ${r.drift.base.slice(0, 7)}; ${r.tasks.length ? `queued ${r.tasks.join(', ')}` : 'already queued'}.` : `The port is up to date with the web rules (${r.drift.base.slice(0, 7)}).`);
      process.exit(0);
    }
    const d = portDrift(t);
    if (!d.pinned) { console.log('The port is not pinned yet: npm run engine -- port --from <sha> (the web commit the port matches now).'); process.exit(0); }
    console.log(d.commits.length ? `${d.commits.length} web change(s) to ${d.sources.join(', ')} since the port's pin ${d.base.slice(0, 7)} (${d.files.length} file(s)):\n${d.commits.map((c) => `  ${c}`).join('\n')}\nQueue them for the porters: npm run engine -- drift --queue` : `The port is up to date with the web rules (${d.base.slice(0, 7)}).`);
    process.exit(0);
  }
  if (argv[0] === 'capture') {
    const t = readTrack();
    if (!t?.capture) {
      console.error(t ? `${t.label} has no capture command in engine.json.` : 'No engine track.');
      process.exit(1);
    }
    fs.mkdirSync(path.join(REPO_ROOT, t.folder, 'captures'), { recursive: true });
    const cmd = engineCommand(t, 'capture', { frames: Number(flag('frames')) || 120 });
    const r = spawnSync(cmd, { cwd: REPO_ROOT, shell: true, encoding: 'utf8', timeout: 10 * 60000 });
    const shots = fs.readdirSync(path.join(REPO_ROOT, t.folder, 'captures')).filter((f) => /\.png$/.test(f)).sort();
    if (r.status !== 0 || !shots.length) {
      console.error(`No frames (exit ${r.status}): ${String(r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ')}. Frames need a display: on a Linux server install xvfb (xvfb-run).`);
      process.exit(1);
    }
    logEngine(`capture: ${shots.length} frames`);
    console.log(`${shots.length} frames in ${t.folder}/captures/ (last: ${shots[shots.length - 1]}). Keep one with a task: npm run proof -- add <task> ${t.folder}/captures/${shots[shots.length - 1]} "<what it shows>"`);
    process.exit(0);
  }
  const t = readTrack();
  console.log(t ? `Engine track: ${t.label} in ${t.folder} since ${t.started.slice(0, 10)} (gate: ${t.gate})` : 'No engine track. The web version stays the design lab until Phase 1 is proven fun; then:');
  for (const [id, e] of Object.entries(ENGINES)) console.log(`\n${id}${id === 'godot' ? ' (recommended)' : ''}: ${e.label}, usage ${e.cost}\n  ${e.why}\n  Watch: ${e.watch}`);
}
