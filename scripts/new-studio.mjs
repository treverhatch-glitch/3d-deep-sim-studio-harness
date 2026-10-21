#!/usr/bin/env node
/**
 * scripts/new-studio.mjs — start another game next to this one, inside the harness.
 *
 *   npm run new-studio -- --name "Moss Garden" [--dir ../moss-garden] [--port 3848] [--from origin|local] [--no-install]
 *
 * One studio is one clone: its Game Bible, task board, locks, agents and War Room belong to one game.
 * A second game started in a new folder by hand runs without any of that (run #1: a side-by-side game
 * "started" and never used the harness). This makes the second studio properly:
 *   1. clones the harness next to this folder (from GitHub, or from this clone with --from local);
 *   2. copies this studio's .env (keys and settings stay on this machine) with its own War Room port;
 *   3. installs, runs setup, makes it safe (preflight --fix), and starts a fresh studio with the name;
 *   4. writes START-HERE.md in it with the exact next commands (intake, the Producer's kickoff, the hub).
 * Nothing in this studio changes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applySetup, saveSetup } from './studio-setup.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
if (flag('save-setup')) {
  const r = saveSetup(flag('save-setup'), ROOT);
  console.log(r.ok ? `[new-studio] Saved this studio's setup (${r.saved} file(s), ${r.settings} setting(s), no keys) to ${r.dir}.\nStart a game with it: npm run new-studio -- --name "<game>" --setup ${r.dir}` : r.message);
  process.exit(r.ok ? 0 : 1);
}
const name = flag('name');
if (!name) {
  console.error('Name the new game: npm run new-studio -- --name "<game name>" [--dir <folder>] [--port 3848] [--setup <folder>|this]');
  process.exit(1);
}
const setupFrom = flag('setup');
if (setupFrom && setupFrom !== 'this' && !fs.existsSync(path.resolve(setupFrom))) {
  console.error(`No setup folder at ${setupFrom}. Make one with: npm run new-studio -- --save-setup <folder>`);
  process.exit(1);
}
const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'new-game';
const dir = path.resolve(flag('dir') || path.join(path.dirname(ROOT), slug));
if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
  console.error(`${dir} already exists and isn't empty. Pick another --dir.`);
  process.exit(1);
}
const sh = (cmd, args, cwd = ROOT, quiet = false) => {
  // Only npm needs a shell on Windows (npm.cmd); with a shell, arguments with spaces would split.
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' && cmd === 'npm', stdio: quiet ? 'pipe' : 'inherit' });
  return r;
};
const step = (msg) => console.log(`\n[new-studio] ${msg}`);

// 1. Clone. From GitHub by default, so the new studio gets the harness without this game's files.
const origin = (sh('git', ['remote', 'get-url', 'origin'], ROOT, true).stdout || '').trim();
const from = flag('from') || (origin ? 'origin' : 'local');
step(`Cloning the harness ${from === 'origin' ? `from ${origin}` : 'from this clone'} into ${dir}`);
let cloned = from === 'origin' && origin ? sh('git', ['clone', '--quiet', origin, dir]) : { status: 1 };
if (cloned.status !== 0) {
  if (from === 'origin') console.log('[new-studio] Cloning from GitHub failed; using this clone instead.');
  cloned = sh('git', ['clone', '--quiet', ROOT, dir]);
  if (cloned.status === 0 && origin) sh('git', ['remote', 'set-url', 'origin', origin], dir, true);
}
if (cloned.status !== 0) {
  console.error('[new-studio] git clone failed; nothing else was done.');
  process.exit(1);
}

// 2. Settings: this studio's .env with its own War Room port and the game's own results folder note.
const envFile = path.join(ROOT, '.env');
// The first War Room port no studio next to this one uses, so a third and fourth game don't clash.
const portOf = (folder) => {
  try {
    return Number((fs.readFileSync(path.join(folder, '.env'), 'utf8').match(/^HUB_PORT=(\d+)/m) || [])[1]) || null;
  } catch {
    return null;
  }
};
const used = new Set([portOf(ROOT) || Number(process.env.HUB_PORT || 3847), ...fs.readdirSync(path.dirname(ROOT)).map((d) => portOf(path.join(path.dirname(ROOT), d))).filter(Boolean)]);
let port = Number(flag('port') || 0);
if (!port) for (port = Math.max(...used, 3847) + 1; used.has(port); port += 1);
let env = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : fs.existsSync(path.join(dir, '.env.example')) ? fs.readFileSync(path.join(dir, '.env.example'), 'utf8') : '';
env = /^HUB_PORT=.*$/m.test(env) ? env.replace(/^HUB_PORT=.*$/m, `HUB_PORT=${port}`) : `${env.replace(/\s*$/, '\n')}HUB_PORT=${port}\n`;
// Its own port for npm run play too, so both games can be played at once.
const playPort = 4610 + (port - 3847);
env = /^STUDIO_PLAY_PORT=.*$/m.test(env) ? env.replace(/^STUDIO_PLAY_PORT=.*$/m, `STUDIO_PLAY_PORT=${playPort}`) : `${env}STUDIO_PLAY_PORT=${playPort}\n`;
env += `# ${name}: a separate studio. Point STUDIO_RESULTS_DIR and STUDIO_BACKUP_DIR at this game's own folders.\n`;
fs.writeFileSync(path.join(dir, '.env'), env);
step(`.env copied${fs.existsSync(envFile) ? ' from this studio' : ' from .env.example'}; War Room port ${port}`);

// 3. Install, set up, make safe, fresh studio.
if (!argv.includes('--no-install')) {
  step('npm install');
  if (sh('npm', ['install', '--no-audit', '--no-fund'], dir).status !== 0) console.log('[new-studio] npm install failed; run it yourself in the new folder.');
}
step('Setup, a fresh studio, and preflight');
sh(process.execPath, ['scripts/setup.mjs'], dir, true);
const reset = sh(process.execPath, ['scripts/studio-reset.mjs', '--name', name, '--yes'], dir, true);
if (reset.status !== 0) console.log(`[new-studio] studio:reset said:\n${reset.stdout}${reset.stderr}`);
// A setup (yours, your agent's, or this studio's with --setup this): roles, skills, departments, budget,
// pace, a game template, intake answers. Never keys, never the harness.
let intakeDone = false;
if (setupFrom) {
  let src = setupFrom;
  if (setupFrom === 'this') {
    src = path.join(dir, '.studio', 'setup-from-parent');
    saveSetup(src, ROOT);
  }
  const r = applySetup(src, dir);
  step(`Setup ${setupFrom === 'this' ? `from ${path.basename(ROOT)}` : path.basename(path.resolve(src))}: ${r.ok ? `${r.copied.length} part(s) copied` : r.message}`);
  if (r.skipped?.length) console.log(`[new-studio] Skipped (not part of a setup): ${r.skipped.slice(0, 10).join(', ')}${r.skipped.length > 10 ? ', …' : ''}`);
  if (r.dropped?.length) console.log(`[new-studio] Not copied from settings.env (keys and ports never travel): ${r.dropped.join(', ')}`);
  if (r.intake) {
    const ir = sh(process.execPath, ['harness/intake.mjs', '--answers', 'studio/intake-answers.json'], dir, true);
    intakeDone = ir.status === 0;
    step(intakeDone ? 'Intake filled from the setup\'s answers (a person still signs the Bible)' : `Intake answers didn't apply:\n${ir.stdout}${ir.stderr}`);
  }
}
if (!argv.includes('--no-install')) sh(process.execPath, ['scripts/preflight.mjs', '--fix'], dir);

// 4. Where to go next.
const start = `# ${name}: start here

This folder is its own studio (its own Game Bible, board, agents and War Room), made with
\`npm run new-studio\` from ${path.basename(ROOT)}. Work on ${name} happens here, never in the other folder.

1. \`npm run preflight\` until it says READY.
2. \`npm run hub\` and open the link it prints (War Room on port ${port}).
3. ${intakeDone ? 'The intake was filled from the setup: read studio/bible/BIBLE.md with the game dev, finish it with `npm run intake`, and sign it.' : '`npm run intake` with the game dev: the idea, the pace, the play length.'}
4. The Producer: \`npm run kickoff -- --role producer --agent producer-1 --model <model>\`, and follow it. It opens departments and hires (\`npm run agent -- hire …\`).
5. Or hire from the War Room: "+ Hire" in any open room.
6. Unattended: \`npm run studio:start -- --until 23:00\`. Each studio runs its own supervisor; \`--install\` registers this folder separately.

Both studios run at once: this one's War Room is on port ${port} and its Arcade build server (\`npm run play\`) on ${playPort}.
`;
fs.writeFileSync(path.join(dir, 'START-HERE.md'), start);
console.log(`\n[new-studio] Ready: ${dir}\n\n${start}`);
