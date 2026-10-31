#!/usr/bin/env node
/**
 * scripts/onboard-game.mjs — bring an existing game (finished or mid-development) into the studio.
 *
 *   npm run onboard -- --path ../my-game --name "My Game"            scan, write the fact sheet, queue tasks
 *   npm run onboard -- --path ../my-game --name "My Game" --dry-run  print what it found, write nothing
 *
 * It only reads the game's folder; it never edits the game. It writes, inside this studio:
 *   studio/game/GAME.md         the fact sheet: what it detected, plus sections a person fills in
 *   studio/game/inventory.json  the raw scan (engine, languages, scripts, tests, determinism hints)
 *   studio/NEXT.md              onboarding tasks (skipped if they are already queued)
 *   studio/producer/LOG.md      a note saying what was onboarded and from where
 * Guide: docs/ONBOARDING-A-GAME.md. Pass --force to rewrite an existing GAME.md.
 *
 * 2.43.0: --adopt [--ref <branch>] brings the game under the studio (game/<slug>/, its own checks declared,
 * the studio's game, origin recorded: harness/adopt.mjs); --export turns the studio's changes to it back into a
 * patch for the game's own repo. --sync [--ref <branch>] brings the game repo's new commits in; 2.55.0: with
 * --dry-run it lists them and writes nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};
const flag = (k) => args.includes(`--${k}`);
if (flag('export')) {
  const { exportPatch } = await import('../harness/adopt.mjs');
  const r = exportPatch();
  if (r.error) { console.error(`[onboard] ${r.error}`); process.exit(1); }
  if (r.empty) { console.log(`[onboard] nothing to export: no committed change to ${r.origin.path} since it was adopted or last synced (or exported)`); process.exit(0); }
  console.log(`[onboard] ${r.files.length} file(s) changed in ${r.origin.path} since it was adopted or last synced (${r.commits.length} commit(s)); patch: ${r.file}`);
  for (const c of r.commits.slice(0, 20)) console.log(`  ${c}`);
  console.log(`[onboard] apply it in the game's own repo (its review and CI decide):\n  ${r.apply.join('\n  ')}`);
  process.exit(0);
}
if (flag('sync')) {
  const { syncGame } = await import('../harness/adopt.mjs');
  const r = syncGame({ ref: opt('ref'), force: flag('force'), commit: !flag('no-commit'), dryRun: flag('dry-run') });
  if (r.error) { console.error(`[onboard] ${r.error}`); process.exit(1); }
  if (r.upToDate) { console.log(`[onboard] up to date with ${r.to.slice(0, 8)}`); process.exit(0); }
  if (r.dryRun) {
    console.log(`[onboard] dry run: --sync would bring in ${r.commits.length} commit(s) (${r.files.length} file(s)) from ${r.ref}: ${r.from.slice(0, 8)}..${r.to.slice(0, 8)}. Nothing was written or committed.`);
    for (const c of r.commits.slice(0, 15)) console.log(`  ${c}`);
    for (const f of r.files.slice(0, 30)) console.log(`  file: ${f}`);
    if (r.files.length > 30) console.log(`  … and ${r.files.length - 30} more file(s)`);
    process.exit(0);
  }
  console.log(`[onboard] synced ${r.commits.length} commit(s) (${r.files.length} file(s)) from the game's repo: ${r.from.slice(0, 8)}..${r.to.slice(0, 8)}${r.committed ? ', committed' : ` (not committed${r.commitError ? `: ${r.commitError}` : ''}; the changes are staged: commit the game folder and studio/game/ORIGIN.json together)`}`);
  for (const c of r.commits.slice(0, 15)) console.log(`  ${c}`);
  process.exit(0);
}
const gamePath = opt('path');
if (!gamePath || !fs.existsSync(gamePath) || !fs.statSync(gamePath).isDirectory()) {
  console.error('Usage: npm run onboard -- --path <game folder> --name "<Game name>" [--dry-run] [--force]');
  process.exit(1);
}
let game = path.resolve(gamePath);
const name = opt('name') || path.basename(game);
const dry = flag('dry-run');
// 2.43.0: adopt first (copy the game in at the right branch), then scan the copy.
let adopted = null;
if (flag('adopt')) {
  const ad = await import('../harness/adopt.mjs');
  const hint = ad.trunkHint(game);
  if (dry) {
    const slug = ad.slugOf(name);
    console.log(`[onboard] --adopt would copy ${opt('ref') || 'the checked-out branch'} into game/${slug}/, make it the studio's game and declare these checks:`);
    for (const g of ad.gatesFor(slug, game).gates) console.log(`  - ${g.id}${g.required === false ? ' (optional)' : ''}: ${g.command}`);
    if (hint) console.log(`[onboard] its ${hint.file} says work goes to \`${hint.branch}\`${opt('ref') ? '' : ` (pass --ref ${hint.branch} for that branch)`}`);
  } else {
    adopted = await ad.adoptGame({ src: game, name, ref: opt('ref') });
    if (adopted.error) { console.error(`[onboard] ${adopted.error}`); process.exit(1); }
    console.log(`[onboard] adopted ${name} into ${adopted.dir}/ (${adopted.origin.ref || 'files'}${adopted.origin.sha ? ` @ ${adopted.origin.sha.slice(0, 8)}` : ''}); it is the studio's game now`);
    console.log(`[onboard] its checks (${adopted.dir}/studio.gates.json${adopted.wroteGates ? ', written from its scripts' : ', its own'}): ${adopted.gates.join(', ') || 'none found: add some'}`);
    if (adopted.wroteBrowser) console.log(`[onboard] wrote a starter ${adopted.dir}/studio.browser.json: how npm run play:controls serves the game and reads its state (fill in "ready" and "state")`);
    for (const w of adopted.warnings) console.log(`[onboard] note: ${w}`);
    game = path.join(root, adopted.dir);
  }
}

// ---------- scan (read only) ----------
const SKIP = new Set(['.git', 'node_modules', 'Library', 'Temp', 'obj', 'bin', 'build', 'dist', 'Build', 'Builds', '.godot', '.import', 'target', '.venv', 'venv', '__pycache__', 'DerivedDataCache', 'Intermediate', 'Saved', '.next', 'coverage']);
const LANG = { '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.mjs': 'JavaScript', '.jsx': 'JavaScript', '.gd': 'GDScript', '.cs': 'C#', '.cpp': 'C++', '.h': 'C++', '.hpp': 'C++', '.rs': 'Rust', '.py': 'Python', '.lua': 'Lua', '.go': 'Go', '.java': 'Java', '.kt': 'Kotlin', '.swift': 'Swift' };
const ASSET = { '.png': 'images', '.jpg': 'images', '.webp': 'images', '.glb': '3D models', '.gltf': '3D models', '.fbx': '3D models', '.blend': '3D models', '.obj': '3D models', '.wav': 'audio', '.ogg': 'audio', '.mp3': 'audio', '.json': 'data', '.tscn': 'scenes', '.unity': 'scenes', '.prefab': 'prefabs' };
// Things that make a run unrepeatable: they need a seed or a fixed tick before replays and goldens work.
const NONDET = [
  ['Math.random', /Math\.random\s*\(/g],
  ['Date.now / new Date', /Date\.now\s*\(|new Date\s*\(/g],
  ['performance.now', /performance\.now\s*\(/g],
  ['requestAnimationFrame delta', /requestAnimationFrame/g],
  ['Godot randi/randf', /\brand[if](_range)?\s*\(/g],
  ['Unity Random / Time.deltaTime', /UnityEngine\.Random|Random\.Range|Time\.deltaTime/g],
  ['C# System.Random', /new\s+System\.Random|new\s+Random\s*\(/g],
];
const MAX_FILES = 25000;
const MAX_READ = 400 * 1024;
const inv = { languages: {}, assets: {}, files: 0, truncated: false, nondeterminism: {}, todo: 0, docs: [], tests: [] };

function walk(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (inv.files >= MAX_FILES) { inv.truncated = true; return; }
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(game, full).replace(/\\/g, '/');
    if (e.isDirectory()) {
      if (SKIP.has(e.name)) continue;
      if (/^(test|tests|__tests__|spec|e2e)$/i.test(e.name)) inv.tests.push(rel);
      if (/^(docs?|design|gdd)$/i.test(e.name)) inv.docs.push(rel);
      walk(full);
      continue;
    }
    if (!e.isFile()) continue;
    inv.files += 1;
    const ext = path.extname(e.name).toLowerCase();
    if (/\b(gdd|design|readme|changelog|roadmap)\b/i.test(e.name) && ext === '.md') inv.docs.push(rel);
    if (ASSET[ext]) inv.assets[ASSET[ext]] = (inv.assets[ASSET[ext]] || 0) + 1;
    const lang = LANG[ext];
    if (!lang) continue;
    let text = '';
    try {
      const st = fs.statSync(full);
      if (st.size > MAX_READ) continue;
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    const l = (inv.languages[lang] ||= { files: 0, lines: 0 });
    l.files += 1;
    l.lines += text.split('\n').length;
    inv.todo += (text.match(/\b(TODO|FIXME|HACK)\b/g) || []).length;
    for (const [label, re] of NONDET) {
      const n = (text.match(re) || []).length;
      if (n) inv.nondeterminism[label] = (inv.nondeterminism[label] || 0) + n;
    }
  }
}
walk(game);

const read = (rel) => {
  try {
    return fs.readFileSync(path.join(game, rel), 'utf8');
  } catch {
    return null;
  }
};
const engine = [];
const pkg = (() => {
  try {
    return JSON.parse(read('package.json'));
  } catch {
    return null;
  }
})();
if (pkg) {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const known = { three: 'Three.js', '@babylonjs/core': 'Babylon.js', babylonjs: 'Babylon.js', phaser: 'Phaser', 'pixi.js': 'PixiJS', playcanvas: 'PlayCanvas', '@react-three/fiber': 'React Three Fiber', excalibur: 'Excalibur', kaboom: 'Kaboom', kaplay: 'KAPLAY', electron: 'Electron', '@tauri-apps/api': 'Tauri', vite: 'Vite', vitest: 'Vitest', jest: 'Jest', '@playwright/test': 'Playwright', playwright: 'Playwright' };
  for (const [dep, label] of Object.entries(known)) if (deps[dep]) engine.push(`${label} ${deps[dep]}`);
}
const godot = read('project.godot');
if (godot) engine.push(`Godot${(godot.match(/config\/features=PackedStringArray\("([\d.]+)/) || [, ''])[1] ? ` ${godot.match(/config\/features=PackedStringArray\("([\d.]+)/)[1]}` : ''}`);
const unity = read('ProjectSettings/ProjectVersion.txt');
if (unity) engine.push(`Unity ${(unity.match(/m_EditorVersion:\s*(\S+)/) || [, '?'])[1]}`);
if (fs.readdirSync(game).some((f) => f.endsWith('.uproject'))) engine.push('Unreal Engine');
const cargo = read('Cargo.toml');
if (cargo) engine.push(/bevy/.test(cargo) ? 'Bevy (Rust)' : 'Rust');
if (/pygame/.test(read('requirements.txt') || '') || /pygame/.test(read('pyproject.toml') || '')) engine.push('Pygame');

const git = (...a) => {
  const r = spawnSync('git', ['-C', game, ...a], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};
const repo = { remote: git('remote', 'get-url', 'origin'), branch: git('rev-parse', '--abbrev-ref', 'HEAD'), lastCommit: git('log', '-1', '--format=%ci %s'), commits: git('rev-list', '--count', 'HEAD') };
const readme = read('README.md') || read('readme.md') || '';
const pitch = readme.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#') && !l.startsWith('!') && !l.startsWith('[') && !l.startsWith('<')) || '';
const scripts = pkg?.scripts ? Object.entries(pkg.scripts).filter(([k]) => /^(dev|start|build|test|lint|preview|e2e|typecheck)/.test(k)) : [];
const shown = path.relative(root, game).replace(/\\/g, '/') || '.';
const inventory = { name, path: shown, scannedAt: new Date().toISOString(), engine, repo, scripts: Object.fromEntries(scripts), ...inv };

// ---------- write ----------
const rows = (obj, fmt) => Object.entries(obj).sort((a, b) => (b[1].lines || b[1]) - (a[1].lines || a[1])).map(fmt).join('\n') || '- none found';
const nondetTotal = Object.values(inv.nondeterminism).reduce((a, b) => a + b, 0);
const sheet = `# ${name}: game fact sheet (\`studio/game/GAME.md\`)

> Written by \`npm run onboard\` on ${inventory.scannedAt.slice(0, 10)} from \`${shown}\`. The **Detected** part is
> from a read-only scan; rescan any time. The **Fill in** part is for a person (or the Producer with a person's
> answers). The Producer's briefing (\`npm run handoff\`) shows the top of this file.

## Fill in

- **Pitch** (one or two sentences): ${pitch || '_…_'}
- **State**: _concept / prototype / vertical slice / alpha / beta / live_
- **Pillars** (what must stay true): _…_
- **Core loop** (what the player does every minute): _…_
- **Target platforms**: _web / Steam / mobile / console_
- **Who decides**: _the person who signs off design, balance and releases_
- **Off-limits** for agents (files, systems, art they must not touch): _…_
- **Known bugs** worth importing (with steps or a seed): _…_
- **Where design lives** (GDD, boards, docs): ${inv.docs.slice(0, 5).map((d) => `\`${d}\``).join(', ') || '_…_'}

## Detected

- **Engine and tools**: ${engine.join(', ') || 'not recognised (fill in)'}
- **Repository**: ${repo.remote || 'no git remote'}${repo.branch ? `, branch \`${repo.branch}\`` : ''}${repo.commits ? `, ${repo.commits} commits` : ''}${repo.lastCommit ? `, last: ${repo.lastCommit}` : ''}
- **Run commands**: ${scripts.map(([k, v]) => `\`${k}\`: \`${v}\``).join('; ') || 'none found in package.json (fill in how to build and run)'}
- **Tests**: ${inv.tests.slice(0, 5).map((t) => `\`${t}\``).join(', ') || 'no test folders found'}
- **Size**: ${inv.files} files${inv.truncated ? ' (scan stopped early)' : ''}, ${inv.todo} TODO/FIXME notes

**Code by language**

${rows(inv.languages, ([k, v]) => `- ${k}: ${v.files} files, ${v.lines.toLocaleString()} lines`)}

**Assets**

${rows(inv.assets, ([k, v]) => `- ${k}: ${v}`)}

**Things that make runs unrepeatable** (${nondetTotal} found). Each needs a seed or a fixed tick before replays and goldens can work:

${rows(inv.nondeterminism, ([k, v]) => `- ${k}: ${v}`)}
`;

// 2.43.0: a game with design docs gets its Bible drafted from them (each answer naming its source), then a person
// checks and signs it; only a game without docs starts from a blank intake.
const designDocs = inv.docs.filter((d) => !/(^|\/)(assets|art|media|devlog|public|textures|sounds|audio|vendor|third[_-]?party|node_modules)(\/|$)/i.test(d)).slice(0, 6);
const tasks = [
  ...(designDocs.length
    ? [
      { title: `Docs: draft the Game Bible for ${name} from its own design docs (${designDocs.join(', ')}): answers file for npm run intake -- --answers, each answer naming its source; leave what the docs don't settle for the owner`, role: 'producer', priority: 'P0', meta: { infra: true } },
      { title: `Check and sign the Game Bible for ${name}, drafted from its docs: npm run bible (fix what reads wrong with npm run intake), then npm run bible -- sign --by <you>`, role: 'human', priority: 'P0' },
    ]
    : [{ title: `Answer the game intake for ${name} with its owner: npm run intake (what it is, its play length, its three phases, which layers it has)`, role: 'human', priority: 'P0' }]),
  { title: `Docs: fill in the "Fill in" part of studio/game/GAME.md for ${name}`, role: 'producer', priority: 'P1' },
  { title: `Docs: rewrite studio/PLAN.md for ${name} (goal, phase, milestones)`, role: 'producer', priority: 'P1' },
  { title: `Study: our own build of ${name} (what runs each frame, network calls, dead code)`, role: 'reference-scout', priority: 'P2' },
  { title: `Study: map ${name}'s game state, randomness and time (the sim boundary)`, role: 'reference-scout', priority: 'P1' },
  { title: `Wrap ${name} in a cartridge adapter: seeded RNG, fixed tick, getState, hash (see qa/browser.adapter.mjs)`, role: 'builder', priority: 'P1', meta: { infra: true } },
  { title: `Playtest: first seeded run of ${name}, then record its golden`, role: 'qa-playtester', priority: 'P2' },
  { title: `Docs: import ${name}'s known bugs into qa/reports with steps or a seed`, role: 'qa-playtester', priority: 'P2' },
  ...(adopted ? [{ title: `Docs: write the Game Bible's controls list for ${name} (every key, button and click, each with the sim value it must change: studio/bible/controls.json, the owner signs it) and fill in game/${adopted.slug}/studio.browser.json so npm run play:controls presses them in a real browser`, role: 'producer', priority: 'P1', meta: { infra: true } }] : []),
  adopted
    ? { title: `Review: the checks ${adopted.dir}/studio.gates.json declares for ${name} (keep, mark optional, add what is missing), then npm run verify`, role: 'reviewer', priority: 'P1' }
    : { title: `Review: choose which gates apply to ${name} now and which wait (studio/gates.json)`, role: 'reviewer', priority: 'P2' },
];

console.log(`[onboard] ${name} at ${shown}`);
console.log(`[onboard] engine: ${engine.join(', ') || 'not recognised'}; ${inv.files} files; ${nondetTotal} unrepeatable calls; ${inv.todo} TODOs`);
if (dry) {
  console.log('\n' + sheet);
  console.log('[onboard] dry run: nothing written. Tasks it would queue:');
  for (const t of tasks) console.log(`  - [${t.priority}] (${t.role}) ${t.title}`);
  process.exit(0);
}

const gameDir = path.join(root, 'studio', 'game');
fs.mkdirSync(gameDir, { recursive: true });
const sheetPath = path.join(gameDir, 'GAME.md');
if (fs.existsSync(sheetPath) && !flag('force')) {
  console.log('[onboard] studio/game/GAME.md exists; kept it (pass --force to rewrite). Inventory refreshed.');
} else {
  fs.writeFileSync(sheetPath, sheet);
  console.log('[onboard] wrote studio/game/GAME.md');
}
fs.writeFileSync(path.join(gameDir, 'inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
console.log('[onboard] wrote studio/game/inventory.json');

const { parseNextQueue, addTask } = await import('../harness/task.mjs');
const bibleMod = await import('../harness/bible.mjs');
if (!bibleMod.hasBible()) {
  const b = bibleMod.emptyBible();
  b.answers.title = name;
  b.answers.origin = 'existing'; // 2.43.0: onboarding is by definition a game that already exists
  bibleMod.writeBible(b);
  console.log('[onboard] started an unsigned Game Bible (studio/bible/); build work waits for the intake and a person\'s signature');
}
const { addLogNote } = await import('../harness/producer-log.mjs');
const q = parseNextQueue();
const have = new Set([...q.inProgress, ...q.backlog, ...q.done].map((t) => t.title));
const queued = tasks.filter((t) => !have.has(t.title)).map((t) => addTask(t)).filter((t) => !t.error && !t.duplicate);
console.log(`[onboard] queued ${queued.length} task(s)${queued.length ? `: ${queued.map((t) => t.id).join(', ')}` : ' (already queued)'}`);
addLogNote(`Onboarded ${name} from ${shown} (${engine.join(', ') || 'engine not recognised'}). Fact sheet: studio/game/GAME.md. ${nondetTotal} unrepeatable calls to tame before goldens. Queued ${queued.length} onboarding task(s).`, process.env.STUDIO_LOCK_OWNER || 'producer');
console.log(adopted
  ? `[onboard] next: ${adopted.warnings.some((w) => /npm ci/.test(w)) ? `cd ${adopted.dir} && npm ci, then ` : ''}git add ${adopted.dir} studio && git commit, npm run verify, then npm run handoff. Send work back with npm run onboard -- --export`
  : '[onboard] next: npm run handoff, then fill in studio/game/GAME.md with the person who owns the game');
