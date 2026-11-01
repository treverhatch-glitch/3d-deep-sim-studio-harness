/**
 * harness/launch.mjs — P-066 (crew P-036): how an agent tool is started, with its arguments intact on every OS.
 *
 * Before, the launcher started each tool with `shell: true` on Windows, so npm's .cmd shims would start at all (since
 * the 2024 fix for CVE-2024-27980 Node refuses to spawn a .cmd or .bat without a shell). Node then joins the
 * arguments with spaces, unquoted, and cmd.exe splits them again and acts on ( ) & | < > ^ %: Claude Code lost its
 * --allowedTools list (every command waited for a yes) and agy got its prompt word by word ("unexpected argument").
 *
 * Now no built-in tool goes through a shell:
 *   - macOS, Linux: the program is started directly (Node looks it up on the agent's PATH).
 *   - Windows: the program is looked up on the agent's PATH x PATHEXT (never in the current folder), then
 *       .exe / .com          started directly;
 *       an npm .cmd shim     (it runs node on a .js file) node is started on that .js file: the shim's own
 *                            node.exe when it has one, else the node running the harness;
 *       any other .cmd/.bat  cmd.exe /d /s /c, with every argument quoted for cmd.exe by quoteCmdArg.
 *   - A prompt given as an argument that can't travel on the command line (longer than Windows takes, or a line
 *     break through cmd.exe) is replaced by a one-line instruction to read the kickoff file; the log says so.
 * A custom command (STUDIO_<ROLE>_CMD, STUDIO_AGENT_CMD) is the user's own command line and still runs in the shell;
 * the values filled into its {kickoff} {agent} {model} {role} {task} {mainRoot} {addDirs} are quoted for that shell
 * (fillCommand).
 *
 * The quoting follows the documented rules: a Windows program splits its command line by the MSVCRT /
 * CommandLineToArgvW rules (quoteWinArg); cmd.exe expands %VAR% first (even inside quotes), then removes a ^ before
 * any character outside quotes, and reads a batch file's %* into a line it parses once more (quoteCmdArg).
 * Delayed expansion (!VAR!) is assumed off, as it is unless the registry turns it on.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

/** CreateProcess takes a command line of at most 32,767 UTF-16 units, the final NUL included. */
export const WIN_CMDLINE_MAX = 32767;
/** cmd.exe reads a command line of at most 8,191 characters. */
export const CMD_EXE_MAX = 8191;
/** One argument on macOS or Linux: Linux takes 128 KiB per argument; stay under it. */
export const POSIX_ARG_MAX = 120000;

export class LaunchError extends Error {}

/** An environment variable as the child will see it: on Windows names are case-insensitive, and as in Node the
 * first of the sorted names that matches wins (Path and PATH both set: PATH). */
export function envValue(env, name, platform = process.platform) {
  if (!env) return undefined;
  if (platform !== 'win32') return env[name];
  const up = name.toUpperCase();
  const key = Object.keys(env).filter((k) => k.toUpperCase() === up && env[k] !== undefined).sort()[0];
  return key === undefined ? undefined : env[key];
}

/**
 * One argument written so a Windows program reads it back unchanged (the MSVCRT / CommandLineToArgvW rules): in
 * double quotes; a quote as \"; backslashes doubled only where they come right before a quote (or the closing one).
 */
export function quoteWinArg(arg) {
  let out = '"';
  let bs = 0;
  for (const ch of String(arg)) {
    if (ch === '\\') {
      bs++;
      continue;
    }
    out += ch === '"' ? `${'\\'.repeat(bs * 2 + 1)}"` : `${'\\'.repeat(bs)}${ch}`;
    bs = 0;
  }
  return `${out}${'\\'.repeat(bs * 2)}"`;
}

/** The length of the command line Node builds on Windows for this program and these arguments (an upper bound). */
export function winCommandLineLength(file, args) {
  return [file, ...args].reduce((n, a) => n + quoteWinArg(a).length + 1, 0);
}

// What cmd.exe acts on outside quotes. The quotes of a quoted argument are escaped too, so cmd.exe never enters its
// quoted mode and one rule, a ^ before each of these, covers the whole argument.
const CMD_META = /[\^"&|<>()%!]/g;

/**
 * One argument for a `cmd.exe /d /s /c "<line>"` line: quoted by the program's rules (quoteWinArg), then a ^ before
 * every character cmd.exe acts on, once per time cmd.exe reads the text: twice for a .cmd/.bat (the /c line, then the
 * batch file's own line that %* expands into), once for anything else. A % behind a ^ never names a variable (the
 * name would end in ^), so %PATH% stays as written. A line break can't travel through cmd.exe at all: refused.
 */
export function quoteCmdArg(arg, { passes = 2 } = {}) {
  const s = String(arg);
  if (/[\r\n\0]/.test(s)) throw new LaunchError(`an argument has a line break, which cmd.exe can't pass on: ${JSON.stringify(s.slice(0, 60))}`);
  let q = quoteWinArg(s);
  for (let i = 0; i < passes; i++) q = q.replace(CMD_META, '^$&');
  return q;
}

/** The program at the start of a cmd.exe line: in real quotes (a space doesn't split it); a %, expanded even in
 * quotes, stands outside them behind a ^ ("C:\100"^%"\x.cmd"). */
function cmdProgram(file) {
  const s = String(file);
  if (/["\r\n\0]/.test(s)) throw new LaunchError(`the program path can't be passed to cmd.exe: ${JSON.stringify(s.slice(0, 80))}`);
  return `"${s.replaceAll('%', '"^%"')}"`;
}

/** The line cmd.exe runs (without the outer quotes /s strips): the program, then each argument quoted for it. */
export function cmdCommandLine(file, args, { passes = 2 } = {}) {
  return [cmdProgram(file), ...args.map((a) => quoteCmdArg(a, { passes }))].join(' ');
}

const splitArgs = (s) => String(s || '').trim().split(/[ \t]+/).filter(Boolean);

/**
 * The .js entry of an npm cmd-shim (what npm, pnpm and cmd-shim write next to a package's bin on Windows), or null
 * for any other .cmd/.bat. Two forms, as cmd-shim writes them:
 *   3 and later:  SET "_prog=%dp0%\node.exe" ... "%_prog%" [node args] "%dp0%\<path to the .js>" %*
 *   1 and 2:      @IF EXIST "%~dp0\node.exe" ( "%~dp0\node.exe" [node args] "%~dp0\<path to the .js>" %* ) ELSE (...)
 * Returns { form, nodeArgs, target } with target relative to the shim's folder (backslashes, maybe ..\).
 */
export function parseNpmShim(text) {
  const t = String(text || '');
  if (!t || t.length > 16384) return null;
  // A shim that sets anything else first (pnpm's sets NODE_PATH) needs its own lines run: not bypassed, cmd.exe runs it.
  const sets = t.match(/^[ \t]*@?SET[ \t]+"?([A-Za-z_][\w]*)=/gim) || [];
  if (sets.some((l) => !/^[ \t]*@?SET[ \t]+"?(dp0|_prog|PATHEXT)=/i.test(l))) return null;
  if (/^[ \t]*SET[ \t]+"_prog=%dp0%\\node\.exe"[ \t]*\r?$/im.test(t)) {
    const m = t.match(/"%_prog%"[ \t]+([^"\r\n%&|<>^]*?)[ \t]*"%dp0%\\([^"\r\n%]+)"[ \t]+%\*/i);
    if (m) return { form: 'cmd-shim', nodeArgs: splitArgs(m[1]), target: m[2] };
  }
  if (/^[ \t]*@?IF[ \t]+EXIST[ \t]+"%~dp0\\node\.exe"[ \t]*\(/im.test(t)) {
    const m = t.match(/"%~dp0\\node\.exe"[ \t]+([^"\r\n%&|<>^]*?)[ \t]*"%~dp0\\([^"\r\n%]+)"[ \t]+%\*/i);
    if (m) return { form: 'cmd-shim (legacy)', nodeArgs: splitArgs(m[1]), target: m[2] };
  }
  return null;
}

const comspecOf = (env) => envValue(env, 'ComSpec', 'win32') || (envValue(env, 'SystemRoot', 'win32') ? path.win32.join(envValue(env, 'SystemRoot', 'win32'), 'System32', 'cmd.exe') : 'cmd.exe');

/**
 * How to start `name`:
 *   { mode: 'direct', file, prefix: [] }                   start file with the arguments
 *   { mode: 'node', file: node, prefix: [..nodeArgs, js], shim }  an npm shim: node on its .js entry
 *   { mode: 'cmd', file: cmd.exe, script, passes }        another .cmd/.bat (or a PATHEXT type such as .js) via cmd.exe
 *   { mode: 'missing', file: name, prefix: [], looked }   not found on PATH (Windows); starting it reports ENOENT
 * Off Windows always 'direct': Node looks the name up on env.PATH itself.
 */
export function resolveCommand(name, { platform = process.platform, env = process.env, fs: fsx = fs, cwd = process.cwd(), execPath = process.execPath } = {}) {
  if (platform !== 'win32') return { mode: 'direct', file: name, prefix: [] };
  const P = path.win32;
  const isFile = (f) => {
    try {
      return fsx.statSync(f).isFile();
    } catch {
      return false;
    }
  };
  const exts = String(envValue(env, 'PATHEXT', platform) || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim().toLowerCase()).filter((e) => e.startsWith('.'));
  const names = exts.includes(P.extname(name).toLowerCase()) ? [name] : exts.map((e) => `${name}${e}`);
  // A name with a folder in it is used as given; a bare name is looked up on PATH only. Never the current folder
  // (cmd.exe looks there first): a .cmd planted in the repo must not stand in for the tool.
  const dirs = /[\\/]/.test(name) ? [P.isAbsolute(name) ? '' : String(cwd)] : String(envValue(env, 'PATH', platform) || '').split(';').map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  const looked = [];
  let found = null;
  for (const d of dirs) {
    for (const n of names) {
      const f = d ? P.join(d, n) : n;
      looked.push(f);
      if (isFile(f)) {
        found = f;
        break;
      }
    }
    if (found) break;
  }
  if (!found) return { mode: 'missing', file: name, prefix: [], looked };
  const ext = P.extname(found).toLowerCase();
  if (ext === '.exe' || ext === '.com') return { mode: 'direct', file: found, prefix: [] };
  const batch = ext === '.cmd' || ext === '.bat';
  if (batch) {
    let shim = null;
    try {
      if (fsx.statSync(found).size <= 16384) shim = parseNpmShim(fsx.readFileSync(found, 'utf8'));
    } catch {
      shim = null;
    }
    if (shim) {
      const dir = P.dirname(found);
      const js = P.resolve(dir, shim.target);
      if (isFile(js)) {
        const own = P.join(dir, 'node.exe');
        return { mode: 'node', file: isFile(own) ? own : execPath, prefix: [...shim.nodeArgs, js], shim: found, form: shim.form };
      }
    }
  }
  return { mode: 'cmd', file: comspecOf(env), script: found, prefix: [], passes: batch ? 2 : 1 };
}

/** The one line a tool gets instead of a prompt that can't travel as an argument. */
export const promptInstruction = (file) => `Your full instructions for this session are in the file ${file}. Read that whole file first and follow it exactly.`;

/**
 * Everything needed to start argv[0] with argv[1..] intact, no shell: { file, args, windowsVerbatimArguments, mode,
 * program, resolved, promptVia, why }. promptAt: the index in argv of a prompt passed as an argument; with promptFile
 * (the same prompt in a file), a prompt that can't travel on this command line becomes promptInstruction(promptFile).
 * Throws LaunchError when the command can't be passed at all (a line break in another argument through cmd.exe).
 */
export function launchPlan(argv, { platform = process.platform, env = process.env, fs: fsx = fs, cwd = process.cwd(), execPath = process.execPath, promptAt = -1, promptFile = null } = {}) {
  if (!Array.isArray(argv) || !argv.length) throw new LaunchError('no program to start');
  const r = resolveCommand(argv[0], { platform, env, fs: fsx, cwd, execPath });
  let args = argv.slice(1).map(String);
  const at = Number.isInteger(promptAt) && promptAt >= 1 && promptAt < argv.length ? promptAt - 1 : -1;
  const plan = { mode: r.mode, program: argv[0], resolved: r.script || r.shim || r.file, looked: r.looked, form: r.form, promptVia: at >= 0 ? 'argument' : null, why: null };
  const swap = (why) => {
    if (at < 0 || !promptFile || plan.promptVia === 'file') return false;
    plan.why = `the prompt (${args[at].length} characters) ${why}`;
    args = args.slice();
    args[at] = promptInstruction(promptFile);
    plan.promptVia = 'file';
    return true;
  };
  if (r.mode === 'cmd') {
    if (at >= 0 && /[\r\n\0]/.test(args[at])) swap('has line breaks, which cmd.exe cannot pass to a .cmd program');
    let line = cmdCommandLine(r.script, args, { passes: r.passes });
    if (line.length + 2 > CMD_EXE_MAX && swap(`would make the command line longer than cmd.exe takes (${CMD_EXE_MAX})`)) line = cmdCommandLine(r.script, args, { passes: r.passes });
    if (line.length + 2 > CMD_EXE_MAX) throw new LaunchError(`the command line for ${argv[0]} is ${line.length} characters, more than cmd.exe takes (${CMD_EXE_MAX})`);
    return { ...plan, file: r.file, args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true, line };
  }
  if (platform === 'win32') {
    const len = () => winCommandLineLength(r.file, [...r.prefix, ...args]);
    if (len() >= WIN_CMDLINE_MAX) swap(`would make the command line longer than Windows takes (${WIN_CMDLINE_MAX})`);
    if (len() >= WIN_CMDLINE_MAX) throw new LaunchError(`the command line for ${argv[0]} is ${len()} characters, more than Windows takes (${WIN_CMDLINE_MAX})`);
  } else if (at >= 0 && Buffer.byteLength(args[at]) > POSIX_ARG_MAX) {
    swap(`is longer than one argument may be (${POSIX_ARG_MAX} bytes)`);
  }
  return { ...plan, file: r.file, args: [...r.prefix, ...args], windowsVerbatimArguments: false };
}

/** One line for the agent's log when the launch is worth a word (Windows resolution, a prompt sent by file). */
export function describePlan(plan) {
  if (!plan) return '';
  const how = {
    node: `${plan.program} is an npm shim (${plan.resolved}): started as ${plan.file} on its .js entry, no shell`,
    cmd: `${plan.program} is ${plan.resolved}: started through cmd.exe with each argument quoted for it`,
    missing: `${plan.program} was not found on PATH (looked for ${(plan.looked || []).slice(0, 4).join(', ')}${(plan.looked || []).length > 4 ? ', …' : ''})`,
  }[plan.mode] || '';
  const via = plan.promptVia === 'file' ? `${plan.why}: it gets a one-line instruction to read its kickoff file instead` : '';
  return [how, via].filter(Boolean).join('; ');
}

const spawnOpts = (plan, options) => {
  const { promptAt, promptFile, platform, fs: _fs, execPath, shell, ...rest } = options || {};
  return { ...rest, shell: false, windowsVerbatimArguments: Boolean(plan.windowsVerbatimArguments) };
};

/** Start a planned launch (launchPlan) with Node's spawn, never through a shell. */
export const spawnPlan = (plan, options = {}) => spawn(plan.file, plan.args, spawnOpts(plan, options));

/** The launch helper: start argv as planned by launchPlan. options: spawn's, plus promptAt / promptFile.
 * Returns { child, plan }. Throws LaunchError when the command can't be passed (see launchPlan). */
export function spawnAgent(argv, options = {}) {
  const plan = launchPlan(argv, { ...options, cwd: options.cwd || process.cwd() });
  return { child: spawnPlan(plan, options), plan };
}

/** spawnAgent, synchronously (spawnSync's result, with .plan). A command that can't be passed returns status null
 * and the error, as spawnSync does for a program that won't start. */
export function spawnAgentSync(argv, options = {}) {
  let plan;
  try {
    plan = launchPlan(argv, { ...options, cwd: options.cwd || process.cwd() });
  } catch (error) {
    return { status: null, signal: null, stdout: '', stderr: '', error, plan: null };
  }
  return { ...spawnSync(plan.file, plan.args, spawnOpts(plan, options)), plan };
}

// Values that need no quoting: sh, and cmd.exe (where , ; = and spaces split a batch file's arguments).
const SAFE_SH = /^[A-Za-z0-9_@%+=:,./-]+$/;
const SAFE_CMD = /^[A-Za-z0-9_@+:./\\-]+$/;

function shValue(v, quote) {
  if (quote === "'") return v.replaceAll("'", `'\\''`);
  if (quote === '"') return v.replace(/[\\"$`]/g, '\\$&');
  return v === '' || SAFE_SH.test(v) ? v : `'${v.replaceAll("'", `'\\''`)}'`;
}

function cmdValue(v, quote, next) {
  if (/["\r\n\0]/.test(v)) throw new LaunchError(`a value for the custom command has a double quote or a line break, which cmd.exe can't pass safely: ${JSON.stringify(v.slice(0, 60))}`);
  if (!quote && (v === '' || SAFE_CMD.test(v))) return v;
  // Inside quotes cmd.exe leaves & | < > ( ) ^ alone, here and again in a batch file's %*; a % is expanded even
  // inside quotes, so it stands outside them behind a ^ ("…"^%"…"). Backslashes before a closing quote are doubled.
  let inner = v.replaceAll('%', '"^%"');
  if (!quote || next === '"') inner = inner.replace(/(\\+)$/, '$1$1');
  return quote ? inner : `"${inner}"`;
}

/**
 * H-9 (2.58.5): a custom command started in a lane copy names its scripts relative to the main checkout
 * (`node tools/my-wrapper.mjs {kickoff}`); one that isn't committed isn't in the copy. Each bare word of the line that
 * is a relative path to a file in the main checkout but not in the copy becomes a placeholder for that file's absolute
 * path, quoted by fillCommand like any value. Returns { template, values, moved } (moved: the words changed).
 */
export function localizeCommand(template, { from, to, fs: fsx = fs } = {}) {
  const t = String(template || '');
  const values = {};
  const moved = [];
  if (!from || !to || path.resolve(from) === path.resolve(to)) return { template: t, values, moved };
  const isFile = (f) => { try { return fsx.statSync(f).isFile(); } catch { return false; } };
  let k = 0;
  // Bare words only: no quotes, no placeholders, no shell characters, not absolute, not an option or VAR=x.
  const out = t.replace(/(^|[ \t])([A-Za-z0-9_.@+][A-Za-z0-9_.@+\/\\-]*)(?=$|[ \t])/g, (all, sp, word) => {
    if (!/[\/\\]|\.[A-Za-z0-9]+$/.test(word) || path.isAbsolute(word) || path.win32.isAbsolute(word)) return all;
    const rel = word.split(/[\/\\]/).join(path.sep);
    if (rel.split(path.sep).includes('..') || !isFile(path.join(from, rel)) || isFile(path.join(to, rel))) return all;
    const key = `__main${k++}`;
    values[key] = path.join(from, rel);
    moved.push(word);
    return `${sp}{${key}}`;
  });
  return { template: out, values, moved };
}

/**
 * A custom command line with its placeholders filled, each value quoted for the shell that runs it (cmd.exe on
 * Windows, sh elsewhere) and for where it stands in the line: bare, or inside the line's own '…' or "…". Values that
 * need no quoting are filled as they are, and an empty value as nothing, as before.
 * values: { kickoff, agent, model, role, task, mainRoot, addDirs }; a list (addDirs: ['--add-dir', <dir>, …], empty
 * outside a lane copy) fills as one quoted argument per item.
 */
export function fillCommand(template, values, { platform = process.platform } = {}) {
  const win = platform === 'win32';
  const t = String(template || '');
  const keys = Object.keys(values || {});
  let out = '';
  let quote = null;
  for (let i = 0; i < t.length; ) {
    const key = t[i] === '{' ? keys.find((k) => t.startsWith(`{${k}}`, i)) : null;
    if (key) {
      const end = i + key.length + 2;
      const raw = values[key];
      if (Array.isArray(raw)) {
        // H-9 (2.58.5): a list ({addDirs}) fills as several arguments, each quoted on its own; it can't stand inside
        // the line's own quotes, where it would become one argument.
        if (quote) throw new LaunchError(`{${key}} fills in several arguments: write it outside quotes in the custom command`);
        out += raw.map((x) => (win ? cmdValue(String(x), null, ' ') : shValue(String(x), null))).join(' ');
      } else {
        const v = String(raw ?? '');
        out += win ? cmdValue(v, quote, t[end]) : shValue(v, quote);
      }
      i = end;
      continue;
    }
    const ch = t[i];
    if (win) {
      if (ch === '"') quote = quote ? null : '"';
      else if (ch === '^' && !quote) {
        out += t.slice(i, i + 2);
        i += 2;
        continue;
      }
    } else if (ch === '\\' && quote !== "'") {
      out += t.slice(i, i + 2);
      i += 2;
      continue;
    } else if (ch === "'" && quote !== '"') quote = quote ? null : "'";
    else if (ch === '"' && quote !== "'") quote = quote ? null : '"';
    out += ch;
    i++;
  }
  return out;
}
