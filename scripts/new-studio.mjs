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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
const name = flag('name');
if (!name) {
  console.error('Name the new game: npm run new-studio -- --name "<game name>" [--dir <folder>] [--port 3848]');
  process.exit(1);
}
const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'new-game';
const dir = path.resolve(flag('dir') || path.join(path.dirname(ROOT), slug));
if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
  console.error(`${dir} already exists and isn't empty. Pick another --dir.`);
  process.exit(1);
}
const sh = (cmd, args, cwd = ROOT, quiet = false) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32', stdio: quiet ? 'pipe' : 'inherit' });
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
const port = Number(flag('port') || Number(process.env.HUB_PORT || 3847) + 1);
const envFile = path.join(ROOT, '.env');
let env = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : fs.existsSync(path.join(dir, '.env.example')) ? fs.readFileSync(path.join(dir, '.env.example'), 'utf8') : '';
env = /^HUB_PORT=.*$/m.test(env) ? env.replace(/^HUB_PORT=.*$/m, `HUB_PORT=${port}`) : `${env.replace(/\s*$/, '\n')}HUB_PORT=${port}\n`;
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
if (!argv.includes('--no-install')) sh(process.execPath, ['scripts/preflight.mjs', '--fix'], dir);

// 4. Where to go next.
const start = `# ${name}: start here

This folder is its own studio (its own Game Bible, board, agents and War Room), made with
\`npm run new-studio\` from ${path.basename(ROOT)}. Work on ${name} happens here, never in the other folder.

1. \`npm run preflight\` until it says READY.
2. \`npm run hub\` and open the link it prints (War Room on port ${port}).
3. \`npm run intake\` with the game dev: the idea, the pace, the play length.
4. The Producer: \`npm run kickoff -- --role producer --agent producer-1 --model <model>\`, and follow it.
5. Start workers with \`npm run agent -- start --role <role> --agent <name>\` (or Start agent in the War Room).
`;
fs.writeFileSync(path.join(dir, 'START-HERE.md'), start);
console.log(`\n[new-studio] Ready: ${dir}\n\n${start}`);
