/**
 * harness/aider-launch.mjs — 2.60.1: how the launcher starts aider (`--tool nim`, `--tool aider`).
 *
 * B-18: which aider. STUDIO_AIDER_CMD (a path to the program), else the studio's own venv
 * (<main checkout>/.studio/aider-venv/Scripts/aider.exe on Windows, bin/aider elsewhere), else aider on PATH. The same
 * answer serves the preflight and the launched argv, so "installed in the venv" never reads as "not installed".
 *
 * B-20: what aider may see. aider offers to add every repo file a message names ("Add file to the chat?"), and
 * --yes-always says yes, so the kickoff's `node harness/task.mjs …` lines pulled harness files into its chat. A
 * per-agent ignore file (.studio/aider/<agent>.aiderignore, passed with --aiderignore) leaves out the harness's folders
 * (harness/, hub/, scripts/, tools/, studio/, qa/*.mjs) and every protected path in studio/protected.json: aider neither
 * offers nor edits a file that matches. It lives in .studio/ (git-ignored, and excluded in a lane copy), so it never
 * becomes part of a lane's change. Patterns are anchored at the repo root (`/tools/`, not `tools/`), so a game's own
 * game/<name>/tools/ stays editable.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, STUDIO_STATE_DIR } from './event.mjs';
import { envValue } from './launch.mjs';

/** The harness's own folders and files, which an aider session never adds to its chat or edits (AGENTS.lite.md "Never"). */
export const AIDER_IGNORE_BASE = ['/harness/', '/hub/', '/scripts/', '/tools/', '/studio/', '/qa/*.mjs', '/.env', '/.env.*', '/.lanes/'];

const mainRootOf = (env) => (String(env.STUDIO_MAIN_ROOT || '').trim() ? path.resolve(env.STUDIO_MAIN_ROOT) : REPO_ROOT);
const stateDirOf = (env) => (String(env.STUDIO_MAIN_ROOT || '').trim() ? path.join(path.resolve(env.STUDIO_MAIN_ROOT), '.studio') : STUDIO_STATE_DIR);

function runnable(f, platform) {
  try {
    if (!fs.statSync(f).isFile()) return false;
    if (platform !== 'win32') fs.accessSync(f, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function onPathPosix(name, env) {
  return String(envValue(env, 'PATH', 'linux') || '').split(':').filter(Boolean).some((d) => runnable(path.join(d, name), 'linux'));
}

/** The venv's aider for this platform, in the order looked at. */
export function venvAiderPaths(stateDir, platform = process.platform) {
  const v = path.join(stateDir, 'aider-venv');
  return platform === 'win32'
    ? [path.join(v, 'Scripts', 'aider.exe'), path.join(v, 'bin', 'aider.exe')]
    : [path.join(v, 'bin', 'aider'), path.join(v, 'Scripts', 'aider')];
}

/**
 * Which aider to start: { cmd, via: 'STUDIO_AIDER_CMD' | 'venv' | 'PATH', looked } or { cmd: null, why, looked }.
 * env: the agent's environment (STUDIO_ names pass through to it). onPath: how a bare name is looked up (agent.mjs's,
 * which on Windows is the launcher's PATH x PATHEXT lookup).
 */
export function aiderProgram({ env = process.env, platform = process.platform, onPath = null } = {}) {
  const looked = [];
  const set = String(env.STUDIO_AIDER_CMD || '').trim().replace(/^"(.*)"$/, '$1');
  if (set) {
    const f = path.isAbsolute(set) ? set : path.resolve(mainRootOf(env), set);
    looked.push(f);
    if (runnable(f, platform)) return { cmd: f, via: 'STUDIO_AIDER_CMD', looked };
    // A setting that points nowhere is said, never quietly replaced by another aider.
    return { cmd: null, looked, why: `STUDIO_AIDER_CMD is set to ${f}, which is not ${platform === 'win32' ? 'a file' : 'a runnable file'}: point it at aider${platform === 'win32' ? '.exe' : ''} (a path, no arguments), or unset it to use .studio/aider-venv or PATH` };
  }
  for (const f of venvAiderPaths(stateDirOf(env), platform)) {
    looked.push(f);
    if (runnable(f, platform)) return { cmd: f, via: 'venv', looked };
  }
  looked.push('aider on PATH');
  const found = onPath ? onPath('aider', env, platform) : platform !== 'win32' && onPathPosix('aider', env);
  if (found) return { cmd: 'aider', via: 'PATH', looked };
  return { cmd: null, looked, why: `aider is not installed (not found at STUDIO_AIDER_CMD, in .studio/aider-venv/${platform === 'win32' ? 'Scripts' : 'bin'}/ or on PATH): install aider (pip install aider-chat) — needs the owner's OK` };
}

/** The ignore lines: the harness's folders, then studio/protected.json's globs (anchored at the repo root). */
export function aiderIgnoreLines(root = REPO_ROOT) {
  let globs = [];
  try {
    const p = JSON.parse(fs.readFileSync(path.join(root, 'studio', 'protected.json'), 'utf8'));
    globs = [...(p.globs || []), ...(p.addOnly || [])].map(String);
  } catch {}
  const anchored = globs.map((g) => g.trim()).filter(Boolean).map((g) => (g.startsWith('/') || g.startsWith('**') ? g : `/${g}`));
  return [...new Set([...AIDER_IGNORE_BASE, ...anchored])];
}

/** Write .studio/aider/<agent>.aiderignore (the main checkout's .studio/) and return its path. */
export function writeAiderIgnore(agent, { env = process.env } = {}) {
  const dir = path.join(stateDirOf(env), 'aider');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${String(agent).replace(/[^\w.-]/g, '_')}.aiderignore`);
  const lines = aiderIgnoreLines(mainRootOf(env));
  fs.writeFileSync(file, `# Written by the launcher for ${agent} (harness/aider-launch.mjs): aider never adds or edits these.\n${lines.join('\n')}\n`);
  return file;
}

/**
 * aider writes .aider.chat.history.md, .aider.input.history and .aider.tags.cache* at the repo root. In a lane copy,
 * keep them out of the lane's change: add `/.aider*` to the copy's exclude file (.studio/lanes/<agent>.exclude, the
 * core.excludesFile harness/worktree.mjs sets for the copy). Returns true when the line is there.
 */
export function excludeAiderFiles(agent, { env = process.env } = {}) {
  const f = path.join(stateDirOf(env), 'lanes', `${agent}.exclude`);
  try {
    const now = fs.readFileSync(f, 'utf8');
    if (/^\/\.aider\*$/m.test(now)) return true;
    fs.appendFileSync(f, `${now && !now.endsWith('\n') ? '\n' : ''}/.aider*\n`);
    return true;
  } catch {
    return false;
  }
}
