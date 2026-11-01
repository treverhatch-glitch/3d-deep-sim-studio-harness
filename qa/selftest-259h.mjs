/**
 * qa/selftest-259h.mjs — P-066 (crew P-036): agents start with their arguments intact on Windows.
 *
 * The launcher used to start each tool with `shell: true` on Windows: Node joined the arguments unquoted and cmd.exe
 * split them again, so Claude Code lost its --allowedTools list and agy got its prompt word by word. Now every tool
 * starts through harness/launch.mjs with no shell. Checked here:
 *   - end to end, through `node harness/agent.mjs start` with stand-in programs first on PATH (an executable script
 *     on macOS and Linux; on Windows an npm-style .cmd shim for claude and agy and a plain .cmd for cursor's `agent`):
 *     Claude Code's allowed-tools patterns arrive one per argument, each with its spaces and parentheses; agy's
 *     prompt arrives as one argument with quotes, parentheses, &, %PATH%, ^ and non-ASCII text unchanged; the plain
 *     .cmd gets its arguments through cmd.exe intact (a prompt with line breaks goes by file there);
 *   - a custom command's {kickoff} (in a folder with a space) and {model} (quotes, parentheses, &, %, ^) arrive whole;
 *   - pure functions, everywhere: the Windows lookup (PATH x PATHEXT, npm shims of both cmd-shim forms, never the
 *     current folder), the prompt-by-file rule, cmd.exe quoting (a table, and a round trip through a model of cmd.exe),
 *     the custom-command filling;
 *   - on Windows only: the cmd.exe quoting round trip through the real cmd.exe, into a .cmd and straight to node.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const WIN = process.platform === 'win32';
// The text that broke on Windows: spaces, quotes, parentheses, &, a variable, a caret, < > |, non-ASCII.
const NOTE = `Fix the "pause menu" (P0) & check 100% of %PATH% ^ it's café <yes|no> done`;
// Arguments for the cmd.exe quoting round trip (no line breaks: cmd.exe can't carry them, launch.mjs never asks it to).
const TABLE = ['plain', 'two words', '', 'say "hi"', '(parens) [brackets] {braces}', 'a & b | c < d > e', '%PATH% and 100%', '%%', 'caret ^ and ^^', '!bang! ;semi, comma= *?', 'café ✓ 日本', 'C:\\dir with space\\', 'back\\"slash', '\\\\server\\share', 'tab\there', '^%PATH^%', '"', 'end\\'];

// A model of cmd.exe, for the round trip that runs everywhere (the real cmd.exe runs it on Windows):
// phase 1, %NAME% of a defined variable is replaced (on the command line an undefined one stays as written);
// phase 2, " toggles quoting; outside quotes a ^ makes the next character plain, and & | < > ( ) are operators.
const cmdPhase1 = (s, vars) => {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '%') {
      const j = s.indexOf('%', i + 1);
      const name = j > i + 1 ? s.slice(i + 1, j) : '';
      const k = name && Object.keys(vars).find((x) => x.toUpperCase() === name.toUpperCase());
      if (k) {
        out += vars[k];
        i = j;
        continue;
      }
    }
    out += s[i];
  }
  return out;
};
const cmdPhase2 = (s) => {
  let out = '';
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') q = !q;
    else if (!q && ch === '^') {
      if (i + 1 < s.length) out += s[++i];
      continue;
    } else if (!q && '&|<>()'.includes(ch)) throw new Error(`cmd.exe would act on an unescaped ${ch} at ${i}`);
    out += ch;
  }
  return out;
};
// How a Windows program splits its command line (the MSVCRT rules, 2008 and later).
const winSplit = (s) => {
  const out = [];
  let cur = '';
  let q = false;
  let any = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') {
      let n = 0;
      while (s[i + n] === '\\') n++;
      if (s[i + n] === '"') {
        cur += '\\'.repeat(Math.floor(n / 2));
        if (n % 2) {
          cur += '"';
          i += n;
        } else i += n - 1;
      } else {
        cur += '\\'.repeat(n);
        i += n - 1;
      }
      any = true;
    } else if (ch === '"') {
      if (q && s[i + 1] === '"') {
        cur += '"';
        i++;
      } else q = !q;
      any = true;
    } else if (!q && (ch === ' ' || ch === '\t')) {
      if (any) out.push(cur);
      cur = '';
      any = false;
    } else {
      cur += ch;
      any = true;
    }
  }
  if (any) out.push(cur);
  return out;
};

export async function selftest259H({ dir, run, report, tmpRoot }) {
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const out = (r) => `${r?.stdout || ''}${r?.stderr || ''}`;
  const probe = (name, code, env = {}) => {
    const f = path.join(dir, `.probe-259h-${name}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node ${path.basename(f)}`, env);
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try {
      return { ...JSON.parse(line), _err: r.stderr };
    } catch {
      return { _raw: out(r).slice(-1500) };
    }
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  let L = null;
  try {
    L = await import(pathToFileURL(path.join(dir, 'harness', 'launch.mjs')).href);
  } catch (err) {
    L = { _missing: String(err.message || err).slice(0, 200) };
  }
  const need = (fn) => {
    if (L._missing) return { ok: false, detail: `harness/launch.mjs: ${L._missing}` };
    try {
      return fn();
    } catch (err) {
      return { ok: false, detail: String(err.stack || err).slice(0, 1500) };
    }
  };

  // ---------- pure: the Windows lookup (PATH x PATHEXT, npm shims, never the current folder) ----------
  {
    const SHIM = (target) => `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*\r\n`;
    const LEGACY = (target) => `@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\${target}" %*\r\n) ELSE (\r\n  @SETLOCAL\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node  "%~dp0\\${target}" %*\r\n)`;
    const files = {
      'C:\\npm\\claude': '#!/bin/sh\nexec node "$basedir/node_modules/@anthropic-ai/claude-code/cli.js" "$@"\n',
      'C:\\npm\\claude.ps1': '# powershell shim',
      'C:\\npm\\claude.cmd': SHIM('node_modules\\@anthropic-ai\\claude-code\\cli.js'),
      'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js': '// entry',
      'C:\\old\\bin\\agy.cmd': LEGACY('..\\lib\\node_modules\\agy\\bin\\agy.js'),
      'C:\\old\\lib\\node_modules\\agy\\bin\\agy.js': '// entry',
      'C:\\tools\\agent.cmd': '@echo off\r\nnode "%~dp0agent.js" %*\r\n',
      'C:\\tools\\grok.exe': 'MZ',
      'C:\\npm\\grok.cmd': SHIM('node_modules\\grok\\cli.js'),
      'C:\\npm\\broken.cmd': SHIM('node_modules\\gone\\cli.js'),
      'C:\\npm\\codex': '#!/bin/sh\n',
      'C:\\repo\\aider.cmd': '@echo planted\r\n',
      'C:\\own\\withnode.cmd': SHIM('node_modules\\w\\cli.js'),
      'C:\\own\\node.exe': 'MZ',
      'C:\\own\\node_modules\\w\\cli.js': '// entry',
      // pnpm's form sets NODE_PATH first: its lines must run, so cmd.exe runs it.
      'C:\\npm\\pn.cmd': `@SETLOCAL\r\n@IF NOT DEFINED NODE_PATH (\r\n  @SET "NODE_PATH=%~dp0\\node_modules"\r\n)\r\n${LEGACY('node_modules\\pn\\cli.js')}`,
      'C:\\npm\\node_modules\\pn\\cli.js': '// entry',
    };
    const fake = {
      statSync: (f) => {
        const k = Object.keys(files).find((x) => x.toLowerCase() === String(f).toLowerCase());
        if (!k) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return { isFile: () => true, size: files[k].length };
      },
      readFileSync: (f) => files[Object.keys(files).find((x) => x.toLowerCase() === String(f).toLowerCase())],
    };
    const env = { Path: 'C:\\tools;"C:\\npm";C:\\old\\bin;C:\\own', ComSpec: 'C:\\Windows\\system32\\cmd.exe' };
    const o = { platform: 'win32', env, fs: fake, cwd: 'C:\\repo', execPath: 'C:\\harness-node\\node.exe' };
    const r = need(() => {
      const got = Object.fromEntries(['claude', 'agy', 'agent', 'grok', 'broken', 'codex', 'aider', 'withnode', 'claude.cmd', 'pn'].map((n) => [n, L.resolveCommand(n, o)]));
      const ok = got.claude.mode === 'node' && got.claude.file === 'C:\\harness-node\\node.exe' && same(got.claude.prefix, ['C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'])
        && got.agy.mode === 'node' && same(got.agy.prefix, ['C:\\old\\lib\\node_modules\\agy\\bin\\agy.js'])
        && got.agent.mode === 'cmd' && got.agent.script === 'C:\\tools\\agent.cmd' && got.agent.file === env.ComSpec && got.agent.passes === 2
        && got.grok.mode === 'direct' && got.grok.file === 'C:\\tools\\grok.exe'
        && got.broken.mode === 'cmd' && got.codex.mode === 'missing' && got.aider.mode === 'missing'
        && got.withnode.mode === 'node' && got.withnode.file === 'C:\\own\\node.exe'
        && got['claude.cmd'].mode === 'node' && got.pn.mode === 'cmd'
        && L.resolveCommand('claude', { ...o, platform: 'linux' }).mode === 'direct';
      return { ok, detail: JSON.stringify(got, null, 1).slice(0, 2500) };
    });
    report('P-066 (crew P-036): on Windows a tool is found on PATH x PATHEXT (Path in any case, quoted entries); an npm .cmd shim (cmd-shim 3+ and the legacy form) runs as node on its .js entry (its own node.exe if it has one), an .exe directly, any other .cmd (one that sets more first, as pnpm\'s does) through cmd.exe; never the extensionless sh script or the current folder', r.ok, r.detail);
  }

  // ---------- pure: what is started, and a prompt that can't travel on the command line goes by file ----------
  {
    const files = {
      'C:\\npm\\agy.cmd': `@ECHO off\r\nSETLOCAL\r\nCALL :find_dp0\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n"%_prog%"  "%dp0%\\node_modules\\agy\\cli.js" %*\r\nENDLOCAL\r\nEXIT /b %errorlevel%\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n`,
      'C:\\npm\\node_modules\\agy\\cli.js': '//',
      'C:\\tools\\agent.cmd': '@echo off\r\nnode "%~dp0agent.js" %*\r\n',
    };
    const fake = { statSync: (f) => { if (!(f in files)) throw new Error('ENOENT'); return { isFile: () => true, size: files[f].length }; }, readFileSync: (f) => files[f] };
    const o = { platform: 'win32', env: { PATH: 'C:\\tools;C:\\npm', COMSPEC: 'C:\\Windows\\system32\\cmd.exe' }, fs: fake, execPath: 'C:\\node\\node.exe', promptFile: 'C:\\repo\\.studio\\kickoff\\a-1.md' };
    const prompt = `Line one with "quotes" & (parens)\nline two %PATH% ^ café`;
    const r = need(() => {
      const agy = L.launchPlan(['agy', '-p', prompt, '--print-timeout', '900s'], { ...o, promptAt: 2 });
      const big = L.launchPlan(['agy', '-p', 'x'.repeat(40000), '--print-timeout', '900s'], { ...o, promptAt: 2 });
      const cur = L.launchPlan(['agent', '-p', '--force', '--output-format', 'text', prompt], { ...o, promptAt: 5 });
      const curOne = L.launchPlan(['agent', '-p', '--force', '--output-format', 'text', 'one line & (x) %PATH%'], { ...o, promptAt: 5 });
      const lin = L.launchPlan(['agy', '-p', prompt, '--print-timeout', '900s'], { ...o, platform: 'linux', promptAt: 2 });
      let refused = false;
      try {
        L.launchPlan(['agent', 'a\nb'], o);
      } catch (err) {
        refused = err instanceof L.LaunchError;
      }
      const ok = agy.mode === 'node' && agy.file === 'C:\\node\\node.exe' && same(agy.args, ['C:\\npm\\node_modules\\agy\\cli.js', '-p', prompt, '--print-timeout', '900s']) && !agy.windowsVerbatimArguments && agy.promptVia === 'argument'
        && big.promptVia === 'file' && big.args[2] === L.promptInstruction(o.promptFile) && /longer than Windows takes/.test(big.why)
        && cur.mode === 'cmd' && cur.windowsVerbatimArguments && same(cur.args.slice(0, 3), ['/d', '/s', '/c']) && cur.promptVia === 'file' && !/[\r\n]/.test(cur.line) && /line breaks/.test(cur.why) && cur.line.includes('kickoff')
        && curOne.promptVia === 'argument' && same(winSplit(cmdPhase2(cmdPhase2(cmdPhase1(curOne.line, { PATH: 'C:\\X' })).replace(/^"[^"]*" /, ''))), ['-p', '--force', '--output-format', 'text', 'one line & (x) %PATH%'])
        && lin.mode === 'direct' && lin.file === 'agy' && same(lin.args, ['-p', prompt, '--print-timeout', '900s'])
        && refused && /npm shim/.test(L.describePlan(agy)) && /one-line instruction/.test(L.describePlan(cur));
      return { ok, detail: JSON.stringify({ agy, big: { ...big, args: big.args.map((a) => a.slice(0, 80)) }, cur, curOne, lin, refused }, null, 1).slice(0, 3000) };
    });
    report('P-066: launchPlan starts the tool with no shell: an npm shim as node + .js with the prompt as one argument; a prompt over the Windows command-line length, or with line breaks for a plain .cmd (cmd.exe), becomes a one-line instruction to read the kickoff file; a one-line prompt goes through cmd.exe intact; another argument with a line break is refused', r.ok, r.detail);
  }

  // ---------- pure: cmd.exe quoting, a table and a round trip through a model of cmd.exe ----------
  {
    const r = need(() => {
      const table = {
        twice: L.quoteCmdArg('a & "b" %PATH% ^'),
        once: L.quoteCmdArg('a & "b" %PATH% ^', { passes: 1 }),
        win: [L.quoteWinArg('two words'), L.quoteWinArg('C:\\dir\\'), L.quoteWinArg('x\\"y'), L.quoteWinArg('')],
        prog: L.cmdCommandLine('C:\\100%\\my tools\\x.cmd', []),
      };
      const expect = {
        twice: '^^^"a ^^^& \\^^^"b\\^^^" ^^^%PATH^^^% ^^^^^^^"',
        once: '^"a ^& \\^"b\\^" ^%PATH^% ^^^"',
        win: ['"two words"', '"C:\\dir\\\\"', '"x\\\\\\"y"', '""'],
        prog: '"C:\\100"^%"\\my tools\\x.cmd"',
      };
      // Into a .cmd: cmd.exe reads the /c line (phase 1 and 2), then the batch file's line that %* expands into
      // (phase 2 again: %* is not expanded twice); straight to a program: the /c line only.
      const vars = { PATH: 'C:\\Windows', USERNAME: 'runner' };
      const batch = cmdPhase2(cmdPhase2(cmdPhase1(L.cmdCommandLine('C:\\bin\\rt.cmd', TABLE), vars)).replace(/^"[^"]*" ?/, ''));
      const direct = cmdPhase2(cmdPhase1(L.cmdCommandLine('C:\\node\\node.exe', TABLE, { passes: 1 }), vars));
      let refused = false;
      try {
        L.quoteCmdArg('two\nlines');
      } catch (err) {
        refused = err instanceof L.LaunchError;
      }
      const ok = same(table, expect) && same(winSplit(batch), TABLE) && same(winSplit(direct).slice(1), TABLE) && refused && same(TABLE.map((a) => winSplit(L.quoteWinArg(a))[0]), TABLE);
      return { ok, detail: JSON.stringify({ table, expect, batch: winSplit(batch), direct: winSplit(direct).slice(1), refused }, null, 1).slice(0, 3000) };
    });
    report('P-066: cmd.exe quoting (one function): each argument in quotes by the Windows program rules, every " & | < > ( ) % ! ^ behind a ^ once per cmd.exe pass (twice into a .cmd), the program path in real quotes with % outside them; 18 tricky arguments survive a model of cmd.exe both ways; a line break is refused', r.ok, r.detail);
  }

  // ---------- pure: custom commands, the filled values quoted for the shell ----------
  {
    const r = need(() => {
      const vals = { kickoff: '/t/h259 two words/repo/.studio/kickoff/c-1.md', agent: 'c-1', model: "m'1 (x) & 50% ^ é", role: 'builder', task: '' };
      const sh = L.fillCommand('mytool --file {kickoff} --name {agent} -m {model} --role {role} {task} end', vals, { platform: 'linux' });
      const shQ = L.fillCommand(`mytool "{kickoff}" '{model}'`, vals, { platform: 'linux' });
      const wv = { ...vals, kickoff: 'C:\\t\\h259 two words\\repo\\.studio\\kickoff\\c-1.md' };
      const cmd = L.fillCommand('mytool --file {kickoff} --name {agent} -m {model} --role {role} {task} end', wv, { platform: 'win32' });
      const cmdQ = L.fillCommand('mytool --file "{kickoff}" -m "{model}"', wv, { platform: 'win32' });
      const plain = L.fillCommand('node harness/rehearsal-agent.mjs {agent} {task} ok', vals, { platform: 'win32' });
      let refused = false;
      try {
        L.fillCommand('x {model}', { model: 'a"b' }, { platform: 'win32' });
      } catch (err) {
        refused = err instanceof L.LaunchError;
      }
      const split = (s) => winSplit(cmdPhase2(cmdPhase1(s, { PATH: 'C:\\W' }))).slice(1);
      const ok = sh === `mytool --file '/t/h259 two words/repo/.studio/kickoff/c-1.md' --name c-1 -m 'm'\\''1 (x) & 50% ^ é' --role builder  end`
        && shQ === `mytool "/t/h259 two words/repo/.studio/kickoff/c-1.md" 'm'\\''1 (x) & 50% ^ é'`
        && same(split(cmd), ['--file', wv.kickoff, '--name', 'c-1', '-m', vals.model, '--role', 'builder', 'end'])
        && same(split(cmdQ), ['--file', wv.kickoff, '-m', vals.model])
        && plain === 'node harness/rehearsal-agent.mjs c-1  ok' && refused;
      return { ok, detail: JSON.stringify({ sh, shQ, cmd, cmdQ, split: split(cmd), plain, refused }, null, 1) };
    });
    report('P-066: a custom command\'s {kickoff} {agent} {model} {role} {task} are quoted for the shell that runs it (sh, or cmd.exe with % outside the quotes), bare or inside the line\'s own quotes; plain values and an empty {task} fill as before; a double quote is refused on Windows', r.ok, r.detail);
  }

  // ---------- toolCommand: the allowlist one pattern per argument, the prompt's place known ----------
  {
    const t = probe('argv', `import { toolCommand } from ${u('harness/agent.mjs')};
import { ALLOWED } from ${u('harness/allowlist.mjs')};
const c = toolCommand('claude', { model: 'm-1', prompt: 'x' });
const i = c.argv.indexOf('--allowedTools');
const tail = c.argv.slice(i + 1);
const list = tail.slice(0, tail.findIndex((a) => a.startsWith('--')));
const p = { agy: toolCommand('agy', { model: 'm', prompt: 'P R' }), cursor: toolCommand('cursor', { model: 'm', prompt: 'P R' }), grok: toolCommand('grok', { model: 'm', prompt: 'P R' }) };
console.log(JSON.stringify({ list, want: ALLOWED.map(([, q]) => 'Bash(' + q + ')'), stdin: c.stdin, bypass: c.argv.includes('--dangerously-skip-permissions'), at: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.promptAt === undefined ? 'stdin:' + v.stdin : v.argv[v.promptAt]])) }));`);
    report('P-066: toolCommand gives Claude Code each allowed-tools pattern as its own argument (no permission bypass), its prompt on stdin, and says where cursor\'s and grok\'s one-argument prompt is (agy\'s goes on stdin since 2.58.5, H-2)', same(t.list, t.want) && t.list?.length === 15 && t.stdin === 'x' && t.bypass === false && t.at?.agy === 'stdin:P R' && t.at?.cursor === 'P R' && t.at?.grok === 'P R', JSON.stringify(t).slice(0, 1500));
  }

  // ---------- end to end: `agent start` with stand-in programs first on PATH ----------
  const bin = path.join(tmpRoot, 'h259-bin');
  const rec = path.join(tmpRoot, 'h259-argv');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(rec, { recursive: true });
  const dummy = (name) => `#!/usr/bin/env node
// A stand-in for ${name} (qa/selftest-259h.mjs): writes the arguments and stdin it got, then exits 0.
const fs = require('fs');
const path = require('path');
const chunks = [];
let done = false;
const write = () => {
  if (done) return;
  done = true;
  fs.writeFileSync(path.join(process.env.STUDIO_ARGV_OUT, ${JSON.stringify(name)} + '.json'), JSON.stringify({ argv: process.argv.slice(2), stdin: Buffer.concat(chunks).toString('utf8') }));
  process.exit(0);
};
process.stdin.on('data', (d) => chunks.push(d));
process.stdin.on('end', write);
process.stdin.on('error', write);
setTimeout(write, 15000);
`;
  // npm's cmd-shim text (3 and later), as `npm install -g` writes it next to a package's bin.
  const npmShim = (pkg) => `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\${pkg}\\cli.js" %*\r\n`;
  if (WIN) {
    for (const name of ['claude', 'agy']) {
      fs.mkdirSync(path.join(bin, 'node_modules', `fake-${name}`), { recursive: true });
      fs.writeFileSync(path.join(bin, 'node_modules', `fake-${name}`, 'cli.js'), dummy(name));
      fs.writeFileSync(path.join(bin, `${name}.cmd`), npmShim(`fake-${name}`));
    }
    // A plain .cmd, not npm's: it goes through cmd.exe with each argument quoted for it.
    fs.writeFileSync(path.join(bin, 'fake-agent.js'), dummy('agent'));
    fs.writeFileSync(path.join(bin, 'agent.cmd'), '@echo off\r\nnode "%~dp0fake-agent.js" %*\r\n');
  } else {
    for (const name of ['claude', 'agy', 'agent']) {
      fs.writeFileSync(path.join(bin, name), dummy(name));
      fs.chmodSync(path.join(bin, name), 0o755);
    }
  }
  fs.writeFileSync(path.join(bin, 'fake-custom.js'), dummy('custom'));
  // The environment: nothing from the shell's studio settings or keys; the stand-ins first on PATH.
  const envWith = (extra = {}) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(STUDIO_|HUB_|AGENT_|PLAYTEST_|OLLAMA_|NVIDIA_|ANTHROPIC_|OPENAI_|XAI_|GEMINI_|VERTEX_|GROQ_|OPENROUTER_|CODEX_|CURSOR_)|_API_KEY|_TOKEN$/.test(k)));
    const old = Object.keys(env).filter((k) => k.toUpperCase() === 'PATH');
    const was = old.map((k) => env[k]).find(Boolean) || '';
    for (const k of old) delete env[k];
    return { ...env, PATH: `${bin}${path.delimiter}${was}`, STUDIO_CARTRIDGE: '', AGENT_EVENTS_FILE: '', STUDIO_ARGV_OUT: rec, STUDIO_HEARTBEAT_SEC: '1', ...extra };
  };
  // Straight to node, no shell, so the note reaches the harness exactly as written on every OS.
  const start = (cwd, args, extra) => spawnSync(process.execPath, ['harness/agent.mjs', 'start', ...args], { cwd, encoding: 'utf8', env: envWith(extra), timeout: 180000 });
  const got = (name) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(rec, `${name}.json`), 'utf8'));
    } catch {
      return null;
    }
  };
  const logOf = (cwd, agent) => {
    try {
      return fs.readFileSync(path.join(cwd, '.studio', 'agents', `${agent}.log`), 'utf8');
    } catch {
      return '';
    }
  };
  const allowed = probe('allowed', `import { ALLOWED } from ${u('harness/allowlist.mjs')};
console.log(JSON.stringify({ want: ALLOWED.map(([, q]) => 'Bash(' + q + ')') }));`).want || [];

  {
    const s = start(dir, ['--role', 'builder', '--agent', 'h259-claude', '--tool', 'claude', '--model', 'm-1', '--note', NOTE, '--by', 'h259']);
    const g = got('claude');
    const i = g?.argv ? g.argv.indexOf('--allowedTools') : -1;
    const tail = i >= 0 ? g.argv.slice(i + 1) : [];
    const list = tail.slice(0, Math.max(0, tail.findIndex((a) => a.startsWith('--'))));
    report('P-066 (crew P-036) end to end: `agent start --tool claude` with claude first on PATH (an npm .cmd shim on Windows): every allowed-tools pattern arrives as its own argument with its spaces and parentheses intact ("Bash(git log *)"), no permission bypass, and the prompt with the note arrives on stdin unchanged',
      allowed.length === 15 && same(list, allowed) && list.includes('Bash(git log *)') && !g.argv.includes('--dangerously-skip-permissions') && g.argv[0] === '-p' && g.stdin.includes(NOTE),
      `${JSON.stringify(g?.argv || null)}\n${out(s).slice(-800)}\n${logOf(dir, 'h259-claude').slice(-800)}`);
  }
  {
    const s = start(dir, ['--role', 'builder', '--agent', 'h259-agy', '--tool', 'agy', '--model', 'm-1', '--note', NOTE, '--by', 'h259']);
    const g = got('agy');
    report('P-066 (crew P-036) end to end: `agent start --tool agy` (an npm .cmd shim on Windows): the prompt arrives whole, with the note\'s quotes, parentheses, &, %PATH%, ^, < | > and non-ASCII text and its line breaks unchanged (on stdin since 2.58.5, H-2), and the arguments are just --print-timeout 900s; no "unexpected argument"',
      same(g?.argv, ['--print-timeout', '900s']) && g.stdin.includes(NOTE) && g.stdin.includes('\n'),
      `${JSON.stringify(g?.argv?.map((a) => a.slice(0, 200)) || null)}\n${out(s).slice(-800)}\n${logOf(dir, 'h259-agy').slice(-800)}`);
  }
  {
    const s = start(dir, ['--role', 'builder', '--agent', 'h259-cursor', '--tool', 'cursor', '--model', 'm-1', '--note', NOTE, '--by', 'h259']);
    const g = got('agent');
    const kick = path.join(dir, '.studio', 'kickoff', 'h259-cursor.md');
    const kickText = fs.existsSync(kick) ? fs.readFileSync(kick, 'utf8') : '';
    const last = g?.argv?.[4] || '';
    // Windows: a plain .cmd runs through cmd.exe, which can't carry the prompt's line breaks: it gets the one-line
    // instruction (with the kickoff's path, quoted through cmd.exe) and the log says so. Elsewhere: the prompt itself.
    const viaFile = WIN ? last.includes(kick) && /Read that whole file/.test(last) && kickText.includes(NOTE) && /through cmd\.exe/.test(logOf(dir, 'h259-cursor')) && /one-line instruction/.test(logOf(dir, 'h259-cursor')) : last.includes(NOTE);
    report(`P-066 (crew P-036) end to end: \`agent start --tool cursor\` (${WIN ? 'a plain, non-npm agent.cmd through cmd.exe' : 'an executable script'}): -p --force --output-format text and the prompt arrive as five arguments${WIN ? ', the prompt as a one-line instruction naming the kickoff file (cmd.exe can\'t carry line breaks), which holds the note intact' : ', the note intact'}`,
      g?.argv?.length === 5 && same(g.argv.slice(0, 4), ['-p', '--force', '--output-format', 'text']) && viaFile,
      `${JSON.stringify(g?.argv?.map((a) => a.slice(0, 300)) || null)}\n${out(s).slice(-800)}\n${logOf(dir, 'h259-cursor').slice(-800)}`);
  }
  {
    // A custom command in a checkout whose path has a space; a model name with quotes, parentheses, &, % and ^.
    const spaced = path.join(tmpRoot, 'h259 two words', 'repo');
    fs.cpSync(dir, spaced, { recursive: true, filter: (src) => !/[\\/]\.studio[\\/](agents|kickoff|locks)([\\/]|$)/.test(src) });
    const model = "m'1 (x) & 50% ^ é";
    const s = start(spaced, ['--role', 'builder', '--agent', 'h259-custom', '--tool', 'custom', '--model', model], { STUDIO_BUILDER_CMD: `node "${path.join(bin, 'fake-custom.js')}" {kickoff} {agent} {model} {role} {task}` });
    const g = got('custom');
    const k = g?.argv?.[0] || '';
    report('P-066: a custom command (STUDIO_BUILDER_CMD) gets {kickoff} in a folder with a space as one argument and {model} with quotes, parentheses, &, % and ^ unchanged; an empty {task} adds nothing',
      g?.argv?.length === 4 && k.includes('h259 two words') && k.endsWith(path.join('.studio', 'kickoff', 'h259-custom.md')) && g.argv[1] === 'h259-custom' && g.argv[2] === model && g.argv[3] === 'builder',
      `${JSON.stringify(g?.argv || null)}\n${out(s).slice(-800)}\n${logOf(spaced, 'h259-custom').slice(-800)}`);
  }

  // ---------- Windows only: the quoting through the real cmd.exe ----------
  if (WIN && !L._missing) {
    const rt = path.join(tmpRoot, 'h259-rt');
    fs.mkdirSync(rt, { recursive: true });
    fs.writeFileSync(path.join(rt, 'rt.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
    fs.writeFileSync(path.join(rt, 'rt.cmd'), '@echo off\r\nnode "%~dp0rt.js" %*\r\n');
    const env = envWith();
    env.PATH = `${rt}${path.delimiter}${env.PATH}`;
    const viaCmd = L.spawnAgentSync(['rt', ...TABLE], { env, encoding: 'utf8', timeout: 60000 });
    const line = L.cmdCommandLine(process.execPath, [path.join(rt, 'rt.js'), ...TABLE], { passes: 1 });
    const direct = spawnSync(env.ComSpec || process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { env, encoding: 'utf8', windowsVerbatimArguments: true, timeout: 60000 });
    const parse = (r) => {
      try {
        return JSON.parse(r.stdout);
      } catch {
        return null;
      }
    };
    report('P-066 (Windows): 18 tricky arguments (quotes, & | < >, %PATH%, ^, !, non-ASCII, trailing backslashes, empty) arrive unchanged through the real cmd.exe /d /s /c, into a plain .cmd (launch helper) and straight to node',
      viaCmd.plan?.mode === 'cmd' && same(parse(viaCmd), TABLE) && same(parse(direct), TABLE),
      JSON.stringify({ plan: viaCmd.plan && { mode: viaCmd.plan.mode, line: viaCmd.plan.line }, viaCmd: parse(viaCmd) || out(viaCmd), direct: parse(direct) || out(direct) }).slice(0, 3000));
  } else if (!WIN) {
    console.log('[selftest] note: P-066\'s real cmd.exe round trip runs on Windows only (the Windows CI job); here the model of cmd.exe above stands in');
  }
}
