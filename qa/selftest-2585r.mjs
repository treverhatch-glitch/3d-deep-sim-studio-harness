/**
 * qa/selftest-2585r.mjs — 2.58.5 launcher fixes from the crew's 2026-11-01 report (H-9, H-2, H-2b, H-1, H-8).
 *   H-9:  a custom tool command (STUDIO_TOOL_CLAUDE_CMD) on a laneless code task runs in its own lane copy, like the
 *         built-in claude argv, and its line can use {mainRoot} and {addDirs}; {addDirs} fills one argument per item.
 *   H-2:  agy gets its kickoff on stdin, not as a `-p <prompt>` argument that agy.exe split at its spaces
 *         ("unexpected argument "are""); STUDIO_AGY_PROMPT=arg brings -p back.
 *   H-2b: `npm run agent -- allow agy` writes exactly the owner's approved set (node, npm, npx, git status, diff, add,
 *         commit, log); --all writes the whole harness list; --prune takes extra harness rules back out.
 *   H-1:  a nim session never runs the role's model; the default is no longer the end-of-life model; a 410/404 for the
 *         model gives one clear launcher line and an event.
 *   H-8:  the NIM key reaches aider even when a .env (the template's empty OPENAI_API_KEY=) is loaded over the
 *         environment, as aider does; any other-cased OPENAI_ name is dropped (one variable on Windows); aider runs with
 *         --no-auto-commits.
 * Stand-in programs first on PATH (POSIX: a node script with a shebang; Windows: a .cmd wrapper, UNTESTED here). The
 * stand-in agy re-splits its arguments at whitespace, as agy.exe did on the crew's Windows PC; the stand-in aider loads
 * .env from its folder over its environment and then applies AIDER_OPENAI_API_KEY, as aider's docs describe. No real
 * tool, key or network is used; the stand-ins record booleans about the key, never a value.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const spawnSyncSleep = (ms) => spawnSync(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`]);

// A made-up value: the checks look for it where it must not be.
const FAKE_KEY = 'fake-nim-key-for-selftest-2585r';
const QUIET = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_HEARTBEAT_SEC: '1', STUDIO_ROLE: '', STUDIO_MAIN_ROOT: '', STUDIO_BUILDER_CMD: '', STUDIO_PRODUCER_CMD: '', STUDIO_AGENT_CMD: '', STUDIO_REHEARSAL: '', STUDIO_TOOL_CLAUDE_CMD: '', STUDIO_TOOL_AGY_CMD: '', STUDIO_TOOL_NIM_CMD: '', STUDIO_AGY_PROMPT: '', STUDIO_NIM_MODEL: '', STUDIO_BUILDER_MODEL: '', STUDIO_AGENT_MODEL: '', STUDIO_LANELESS: '', STUDIO_WORKTREES: '', NVIDIA_API_KEY: '', NVIDIA_API_KEY_2: '', OPENAI_API_KEY: '', AIDER_OPENAI_API_KEY: '' };

export async function selftest2585R({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const u = (root, p) => JSON.stringify(pathToFileURL(path.join(root, p)).href);
  let n = 0;
  const probe = (root, code, env = {}) => {
    const f = path.join(root, `.probe-2585r-${n++}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(root, `node ${path.basename(f)}`, { ...QUIET, ...env });
    try { return { ...JSON.parse(String(r.stdout).trim().split('\n').pop()), raw: out(r) }; } catch { return { raw: out(r) }; }
  };
  const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // ---------- stand-ins first on PATH ----------
  const bin = path.join(tmpRoot, 'bin-2585r');
  const rec = path.join(tmpRoot, 'rec-2585r');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(rec, { recursive: true });
  const fakeJs = path.join(tmpRoot, 'fake-tool-2585r.cjs');
  fs.writeFileSync(fakeJs, `const fs = require('fs'); const path = require('path');
const tool = process.env.FAKE_TOOL_NAME || path.basename(process.argv[1]).replace(/\\.(cjs|js)$/, '');
const e = { ...process.env };
const save = (o) => fs.writeFileSync(path.join(${JSON.stringify(rec)}, tool + '-' + (e.STUDIO_LOCK_OWNER || 'x') + '.json'), JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), mainRoot: e.STUDIO_MAIN_ROOT || null, ...o }));
if (tool === 'agy') {
  // As agy.exe did on Windows: the arguments are split again at whitespace, then -p takes one value.
  const a = process.argv.slice(2).join(' ').split(/\\s+/).filter(Boolean);
  let prompt = null;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '-p' || a[i] === '--print') { prompt = a[++i]; continue; }
    if (a[i] === '--print-timeout' || a[i] === '--settings') { i++; continue; }
    if (a[i].startsWith('--')) continue;
    console.log('Error: unexpected argument "' + a[i] + '".');
    save({ error: 'unexpected argument "' + a[i] + '"', prompt });
    process.exit(0);
  }
  if (prompt !== null) { save({ prompt, via: 'p' }); process.exit(0); }
  const chunks = [];
  process.stdin.on('data', (d) => chunks.push(d));
  process.stdin.on('end', () => { save({ prompt: Buffer.concat(chunks).toString('utf8'), via: 'stdin' }); process.exit(0); });
  setTimeout(() => { save({ prompt: null, via: 'none' }); process.exit(0); }, 15000);
} else if (tool === 'aider') {
  // As aider does: .env files are loaded over the environment (here: the current folder's), then --openai-api-key
  // (AIDER_OPENAI_API_KEY) is applied after them.
  try {
    for (const line of fs.readFileSync('.env', 'utf8').split(/\\r?\\n/)) {
      const m = line.match(/^\\s*([A-Za-z_][\\w]*)\\s*=\\s*(.*)$/);
      if (m) e[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch {}
  if (e.AIDER_OPENAI_API_KEY) e.OPENAI_API_KEY = e.AIDER_OPENAI_API_KEY;
  save({ keySet: Boolean(e.OPENAI_API_KEY), keyMatches: e.OPENAI_API_KEY === ${JSON.stringify(FAKE_KEY)} });
  if (e.STUDIO_FAKE_AIDER_410 === '1') {
    for (let i = 0; i < 3; i++) console.log("litellm.APIError: APIError: OpenAIException - Error code: 410 - {'type': \\n'about:blank', 'title': 'Gone', 'status': 410, 'detail': \\"The model \\n'old/eol-model' has reached its end of life on \\n2026-06-11T00:00:00Z and is no longer available.\\"}\\nRetrying in 0.5 seconds...");
    process.exit(1);
  }
} else {
  save({});
}
`);
  for (const tool of ['agy', 'aider']) {
    if (process.platform === 'win32') fs.writeFileSync(path.join(bin, `${tool}.cmd`), `@echo off\r\nset FAKE_TOOL_NAME=${tool}\r\n"${process.execPath}" "${fakeJs}" %*\r\n`);
    else {
      fs.writeFileSync(path.join(bin, tool), `#!${process.execPath}\nprocess.env.FAKE_TOOL_NAME = ${JSON.stringify(tool)};\nrequire(${JSON.stringify(fakeJs)});\n`);
      fs.chmodSync(path.join(bin, tool), 0o755);
    }
  }
  const recOf = (tool, agent) => { try { return JSON.parse(fs.readFileSync(path.join(rec, `${tool}-${agent}.json`), 'utf8')); } catch { return null; } };
  const withBin = { PATH: `${bin}${path.delimiter}${process.env.PATH || ''}` };

  // ---------- a git checkout of its own for the lane copies ----------
  const repo = path.join(tmpRoot, 'repo-2585r');
  fs.cpSync(dir, repo, { recursive: true, filter: (src) => !/[\\/](node_modules|\.git)$/.test(src) });
  try { fs.symlinkSync(fs.realpathSync(path.join(dir, 'node_modules')), path.join(repo, 'node_modules'), 'junction'); } catch {}
  const g = (cmd) => run(repo, `git -c user.email=t@t -c user.name=t ${cmd}`);
  g('init -q -b main');
  g('add -A');
  g('commit -qm base');
  const support = run(repo, `node -e "import('./harness/worktree.mjs').then(m=>console.log(JSON.stringify(m.worktreeSupport())))"`);
  const lanesOk = /"ok":true/.test(support.stdout);
  const add = (root, title, role = 'builder') => (run(root, `node harness/task.mjs add "${title}" --role ${role} --priority P1`, QUIET).stdout.match(/"id": "(T-\d+)"/) || [])[1];
  const tasks = { h9: add(repo, 'Custom laneless'), h8: add(repo, 'Nim in a copy') };
  g('add -A');
  g('commit -qm board');
  // The studio's .env as the template leaves it: an empty OPENAI_API_KEY= line (a lane copy gets a copy of it).
  fs.writeFileSync(path.join(repo, '.env'), '# from .env.example\nOPENAI_API_KEY=\n');
  const start = (root, args, env = {}) => run(root, `node harness/agent.mjs start ${args}`, { ...QUIET, ...withBin, ...env });
  const mainStudio = [real(path.join(repo, 'studio')), real(path.join(repo, '.studio'))];
  const inCopy = (r, agent) => Boolean(r) && real(r.cwd) === real(path.join(repo, '.lanes', agent));

  // ---------- H-9: a custom tool command gets the lane copy and {mainRoot} / {addDirs} ----------
  if (!lanesOk) report('H-9/H-8: lane copies skipped, this machine can\'t make them (git 2.42+ needed)', true, support.stdout);
  else {
    // The wrapper is named relative to the main checkout and isn't committed (as a person's own script often isn't).
    fs.copyFileSync(fakeJs, path.join(repo, '.wrapper-2585r.cjs'));
    const cmd = 'node .wrapper-2585r.cjs {kickoff} {model} {addDirs} --main {mainRoot}';
    const s = start(repo, `--role builder --agent h9-api --task ${tasks.h9} --tool claude --model m-1`, { STUDIO_TOOL_CLAUDE_CMD: cmd });
    const r = recOf('.wrapper-2585r', 'h9-api');
    let log9 = '';
    try { log9 = fs.readFileSync(path.join(repo, '.studio', 'agents', 'h9-api.log'), 'utf8'); } catch {}
    const argv = r?.argv || [];
    const dirs = argv.flatMap((a, i) => (a === '--add-dir' ? [argv[i + 1]] : []));
    const main = argv[argv.indexOf('--main') + 1];
    const stray = g('status --porcelain').stdout.split('\n').filter((l) => /\.lanes/.test(l));
    report('H-9 (crew: "api-1 started with --tool claude and STUDIO_TOOL_CLAUDE_CMD … The session ran in the main checkout, not .lanes/api-1"): a custom tool command on a laneless code task runs in its own copy (cwd .lanes/<agent>, STUDIO_MAIN_ROOT set, removed at the end); {addDirs} fills the --add-dir pair for the main checkout\'s real studio/ and .studio/ and {mainRoot} the main checkout; a script the line names that isn\'t committed runs from the main checkout (the log says so)',
      s.status === 0 && inCopy(r, 'h9-api') && /run from the main checkout: \.wrapper-2585r\.cjs/.test(log9) && real(r.mainRoot || '') === real(repo) && dirs.length === 2 && dirs.map(real).join('|') === mainStudio.join('|') && argv.filter((a) => a === '--add-dir').length === 2 && real(main || '') === real(repo) && !fs.existsSync(path.join(repo, '.lanes', 'h9-api')) && !stray.length,
      `record: ${JSON.stringify(r)}\n${out(s).slice(-600)}`);
  }
  {
    const t = probe(dir, `import { fillCommand, LaunchError } from ${u(dir, 'harness/launch.mjs')};
const v = { kickoff: '/k/a b.md', addDirs: ['--add-dir', '/m/st dio', '--add-dir', '/m/.studio'], mainRoot: 'C:\\\\Main Root' };
let refused = false;
try { fillCommand('x "{addDirs}"', v, { platform: 'linux' }); } catch (e) { refused = e instanceof LaunchError; }
console.log(JSON.stringify({
  sh: fillCommand('w {kickoff} {addDirs} --root {mainRoot}', v, { platform: 'linux' }),
  win: fillCommand('w {kickoff} {addDirs} --root {mainRoot}\\\\x.mjs', v, { platform: 'win32' }),
  empty: fillCommand('w {addDirs} {kickoff}', { ...v, addDirs: [] }, { platform: 'linux' }),
  refused,
}));`);
    report('H-9: fillCommand fills a list placeholder ({addDirs}) as one quoted argument per item for sh and for cmd.exe, an empty list as nothing, and refuses it inside the line\'s own quotes; {mainRoot} fills like any value',
      t.sh === "w '/k/a b.md' --add-dir '/m/st dio' --add-dir /m/.studio --root 'C:\\Main Root'" && t.win === 'w "/k/a b.md" --add-dir "/m/st dio" --add-dir /m/.studio --root "C:\\Main Root"\\x.mjs' && t.empty === "w  '/k/a b.md'" && t.refused === true,
      JSON.stringify(t).slice(0, 1200));
  }

  // ---------- 2.58.5: a session counts as running while its lane copy is made ----------
  // A post-checkout hook that sleeps makes the copy slow (as on Windows or in a big repo), with no harness change.
  // Before, the detached launcher cleared its placeholder at once and wrote its record only after the copy, so a
  // supervisor pass in between saw the role under its cap (PU-19 failed on Windows CI: a second session started
  // before the first hit its usage limit).
  if (lanesOk) {
    const hooks = path.join(repo, '.git', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    const hook = path.join(hooks, 'post-checkout');
    fs.writeFileSync(hook, '#!/bin/sh\nnode -e "setTimeout(() => {}, 3000)"\n');
    try { fs.chmodSync(hook, 0o755); } catch {}
    const ts = add(repo, 'Slow copy');
    g('add -A');
    g('commit -qm slow-copy');
    const d = start(repo, `--role builder --agent h9-slow --task ${ts} --tool claude --model m-1 --detach`, { STUDIO_TOOL_CLAUDE_CMD: 'node .wrapper-2585r.cjs {kickoff}' });
    const samples = [];
    const t0 = Date.now();
    let seen = null;
    while (Date.now() - t0 < 25000) {
      seen = probe(repo, `import fs from 'node:fs';
import { sessions } from ${u(repo, 'harness/agent.mjs')};
import { readRecentEvents } from ${u(repo, 'harness/event.mjs')};
const ev = readRecentEvents(5000).filter((e) => e.agent === 'h9-slow');
console.log(JSON.stringify({ running: sessions().some((x) => x.agent === 'h9-slow' && x.running), copying: fs.existsSync('.lanes/h9-slow') && !ev.some((e) => e.type === 'lane.copy'), started: ev.some((e) => e.type === 'agent.session.start'), ended: ev.some((e) => e.type === 'agent.session.end') }));`);
      if (seen.copying) samples.push(seen.running);
      if (seen.ended) break;
      spawnSyncSleep(250);
    }
    fs.rmSync(hook, { force: true });
    report('2.58.5: a session counts as running for the whole time its lane copy is being made (a slow copy, here a post-checkout hook that sleeps 3 s), so a supervisor pass can\'t start a second session under the role\'s cap in that gap',
      d.status === 0 && samples.length > 0 && samples.every(Boolean) && seen?.started === true,
      `detach (${d.status}): ${out(d).slice(-300)}\nsamples while copying (running?): ${JSON.stringify(samples)}\nlast: ${JSON.stringify(seen)}`);
  }

  // ---------- H-2: agy's prompt on stdin ----------
  {
    const task = add(dir, 'Agy run');
    const s = start(dir, `--role builder --agent h2-agy --task ${task} --tool agy --model m-1`, { STUDIO_WORKTREES: 'off' });
    const r = recOf('agy', 'h2-agy');
    const kick = path.join(dir, '.studio', 'kickoff', 'h2-agy.md');
    const kickText = fs.existsSync(kick) ? fs.readFileSync(kick, 'utf8') : null;
    report('H-2 (crew agy-1.log: "Error: unexpected argument "are". Prompts are read only from -p/--print, -i/--prompt-interactive, or stdin"): agent start --tool agy with an agy that splits its arguments again at whitespace (as agy.exe did): the whole kickoff arrives (on stdin), no "unexpected argument", and no argument carries the prompt',
      s.status === 0 && r && !r.error && r.via === 'stdin' && kickText && r.prompt === kickText && /^You are /.test(r.prompt) && same(r.argv, ['--print-timeout', '900s']),
      `record: ${JSON.stringify(r && { ...r, prompt: r.prompt?.slice(0, 120) })}\n${out(s).slice(-600)}`);
  }
  {
    const t = probe(dir, `import { toolCommand } from ${u(dir, 'harness/agent.mjs')};
import { launchPlan } from ${u(dir, 'harness/launch.mjs')};
const prompt = 'You are agy-1, a builder.\\nRead "AGENTS.lite.md" (all of it) & go.';
const c = toolCommand('agy', { model: 'm', prompt });
const files = new Set(['C:\\\\tools\\\\agy.exe']);
const fsx = { statSync: (f) => ({ isFile: () => files.has(f), size: 10 }), readFileSync: () => '' };
const plan = launchPlan(c.argv, { platform: 'win32', env: { PATH: 'C:\\\\tools', PATHEXT: '.EXE;.CMD' }, fs: fsx, promptAt: c.promptAt ?? -1, promptFile: 'C:\\\\s\\\\k.md' });
process.env.STUDIO_AGY_PROMPT = 'arg';
const back = toolCommand('agy', { model: 'm', prompt });
console.log(JSON.stringify({ stdin: c.stdin === prompt, mode: plan.mode, file: plan.file, args: plan.args, spaced: plan.args.filter((a) => /\\s/.test(a)), back: back.argv.slice(0, 3), backAt: back.promptAt, backStdin: back.stdin ?? null }));`);
    report('H-2: on Windows (simulated: agy.exe on PATH) the agy launch plan starts agy.exe directly with no argument holding a space (nothing for agy to split) and the prompt on stdin; STUDIO_AGY_PROMPT=arg brings back agy -p <prompt>',
      t.stdin === true && t.mode === 'direct' && t.file === 'C:\\tools\\agy.exe' && same(t.args, ['--print-timeout', '900s']) && same(t.spaced, []) && t.back?.[1] === '-p' && /^You are agy-1/.test(t.back?.[2] || '') && t.backAt === 2 && t.backStdin === null,
      JSON.stringify(t).slice(0, 1500));
  }

  {
    // The quota probe (harness/budget.mjs probeTool) asks agy too: its prompt goes on stdin as well (r's note, 2.58.5).
    const t = probe(dir, `import { probeTool } from ${u(dir, 'harness/budget.mjs')};
console.log(JSON.stringify(probeTool('agy', { timeoutMs: 30000 })));`, { ...withBin, STUDIO_LOCK_OWNER: 'h2-probe' });
    const r = recOf('agy', 'h2-probe');
    report('H-2: the quota probe asks agy with its prompt on stdin too (an agy that splits its arguments gets no stray word; the probe answers ok)',
      t.ok === true && r && !r.error && r.via === 'stdin' && r.prompt === 'Reply with the word OK.' && same(r.argv, ['--print-timeout', '60s']),
      `probe: ${JSON.stringify(t).slice(0, 600)}\nrecord: ${JSON.stringify(r)}`);
  }
  // ---------- H-2b: the approved agy rule set ----------
  {
    const studioFile = path.join(dir, '.studio', 'agy-settings.json');
    const homeA = path.join(tmpRoot, 'home-2585r-a');
    fs.mkdirSync(homeA, { recursive: true });
    const as = { ...QUIET, HOME: homeA, USERPROFILE: homeA };
    fs.rmSync(studioFile, { force: true });
    const approvedWords = ['node', 'npm', 'npx', 'git status', 'git diff', 'git add', 'git commit', 'git log'];
    const extraWords = ['ffmpeg', 'blender', 'git show', 'ls', 'mkdir', 'cp', 'mv'];
    const words = (rules) => [...new Set(rules.filter((r) => /^command\([^r]|^command\(r(?!egex:)/.test(r)).map((r) => r.slice(8, -1)))].sort();
    const w = run(dir, 'node harness/agent.mjs allow agy --by owner-ana', as);
    let st = {};
    try { st = JSON.parse(fs.readFileSync(studioFile, 'utf8')); } catch {}
    const rules = st.permissions?.allow || [];
    report('H-2b (crew: "allow agy wrote 30 rules (node, npm, npx, ffmpeg, blender, git status/diff/add/commit/log/show, ls, mkdir, cp, mv) but the owner\'s approval was node, npm, npx and git status/diff/add/commit/log only"): allow agy --by <owner> writes exactly the approved set, a word rule and a regex rule each (16 rules), and none of ffmpeg, blender, git show, ls, mkdir, cp, mv',
      w.status === 0 && rules.length === 16 && same(words(rules), [...approvedWords].sort()) && approvedWords.every((p) => rules.some((r) => r.startsWith(`command(regex:^${p}(`))) && !extraWords.some((p) => rules.some((r) => r === `command(${p})` || r.startsWith(`command(regex:^${p}(`))),
      `${out(w).slice(-600)}\nrules (${rules.length}): ${JSON.stringify(rules).slice(0, 600)}`);

    // The crew's file: the 30 rules 2.58.3 wrote, plus one of the owner's own. --all, plain, --prune.
    fs.rmSync(studioFile, { force: true });
    const all = run(dir, 'node harness/agent.mjs allow agy --by owner-ana --all', as);
    let st2 = {};
    try { st2 = JSON.parse(fs.readFileSync(studioFile, 'utf8')); } catch {}
    const thirty = st2.permissions?.allow || [];
    fs.writeFileSync(studioFile, `${JSON.stringify({ permissions: { allow: [...thirty, 'command(npm run verify)'] } }, null, 2)}\n`);
    const plain = run(dir, 'node harness/agent.mjs allow agy --by owner-ana', as);
    const dry = run(dir, 'node harness/agent.mjs allow agy --dry-run --prune', as);
    const afterDry = fs.readFileSync(studioFile, 'utf8');
    const pr = run(dir, 'node harness/agent.mjs allow agy --by owner-ana --prune', as);
    let st3 = {};
    try { st3 = JSON.parse(fs.readFileSync(studioFile, 'utf8')); } catch {}
    const left = st3.permissions?.allow || [];
    const baks = fs.readdirSync(path.dirname(studioFile)).filter((f) => f.startsWith('agy-settings.json.bak-'));
    report('H-2b: more than the approved set needs --all (it writes the whole harness list, 30 rules); a plain run on such a file adds nothing and names the 7 extra entries with the --prune hint; --prune (after a dry run that writes nothing) takes out only the harness rules beyond the approved set, keeps the owner\'s own rule, and backs the file up first',
      all.status === 0 && thirty.length === 30 && plain.status === 0 && /nothing added/i.test(out(plain)) && /--prune/.test(out(plain)) && same(((out(plain).match(/are in the file \(([^)]*)\)/) || [])[1] || '').split(', ').sort(), [...extraWords].sort())
        && dry.status === 0 && /Would remove 14/.test(out(dry)) && afterDry.includes('command(ffmpeg)')
        && pr.status === 0 && left.length === 17 && left.includes('command(npm run verify)') && same(words(left.filter((r) => r !== 'command(npm run verify)')), [...approvedWords].sort()) && baks.length >= 1,
      `all (${all.status}): ${thirty.length} rules ${out(all).slice(-300)}\nplain: ${out(plain).slice(-500)}\ndry: ${out(dry).slice(-400)}\nprune (${pr.status}): ${out(pr).slice(-400)}\nleft (${left.length}): ${JSON.stringify(left).slice(0, 500)}\nbackups: ${baks.join(', ')}`);
    fs.rmSync(studioFile, { force: true });
    for (const b of baks) fs.rmSync(path.join(path.dirname(studioFile), b), { force: true });
  }

  // ---------- H-1: the nim model ----------
  {
    const t = probe(dir, `import { toolCommand, NIM_DEFAULT_MODEL, nimModelTrouble } from ${u(dir, 'harness/agent.mjs')};
const m = (model, env) => { const old = process.env.STUDIO_NIM_MODEL; if (env) process.env.STUDIO_NIM_MODEL = env; else delete process.env.STUDIO_NIM_MODEL; const a = toolCommand('nim', { model, file: '/k' }).argv[2]; if (old === undefined) delete process.env.STUDIO_NIM_MODEL; else process.env.STUDIO_NIM_MODEL = old; return a; };
console.log(JSON.stringify({
  def: NIM_DEFAULT_MODEL,
  role: m('claude-sonnet-5-5'), roleEnv: m('claude-sonnet-5-5', 'z-ai/glm-5.3-flash'), unknown: m('unknown'), own: m('deepseek-ai/deepseek-v4.1-flash', 'z-ai/glm-5.3-flash'), prefixed: m('openai/moonshotai/kimi-k2.6'),
  t404: nimModelTrouble("litellm.NotFoundError: Error code: 404 - {'detail': \\"Function not found for account: model 'org/nope'\\"}", 'org/nope'),
  none: nimModelTrouble('Applied edit to src/a.ts', 'x/y'),
}));`);
    report('H-1 (crew: "Without --model, --tool nim passed the role model (aider showed openai/claude-sonnet-5-5)"; "qwen/qwen3-coder-480b-a35b-instruct returns 410"): a nim session never takes a non-NIM model (a role\'s Claude model or "unknown" gives way to STUDIO_NIM_MODEL, else the default); a NIM id is kept; the default is no longer the end-of-life qwen model; a 404 reads as "was not found"',
      t.def && t.def !== 'qwen/qwen3-coder-480b-a35b-instruct' && /^[\w.-]+\/[\w.:+-]+$/.test(t.def) && t.role === `openai/${t.def}` && t.roleEnv === 'openai/z-ai/glm-5.3-flash' && t.unknown === `openai/${t.def}` && t.own === 'openai/deepseek-ai/deepseek-v4.1-flash' && t.prefixed === 'openai/moonshotai/kimi-k2.6'
        && /org\/nope was not found \(404\)/.test(t.t404 || '') && /STUDIO_NIM_MODEL/.test(t.t404 || '') && t.none === null,
      JSON.stringify(t).slice(0, 1500));

    const task = add(dir, 'Nim role model');
    const s = start(dir, `--role builder --agent h1-nim --task ${task} --tool nim`, { STUDIO_WORKTREES: 'off', STUDIO_BUILDER_MODEL: 'claude-sonnet-5-5', NVIDIA_API_KEY: FAKE_KEY });
    const r = recOf('aider', 'h1-nim');
    let sess = {};
    try { sess = JSON.parse(fs.readFileSync(path.join(dir, '.studio', 'agents', 'h1-nim.json'), 'utf8')); } catch {}
    report('H-1: agent start --tool nim with STUDIO_BUILDER_MODEL=claude-sonnet-5-5 and no --model starts aider on openai/<the NIM default>, and the session record says that model, not the role\'s',
      s.status === 0 && r && r.argv?.[1] === `openai/${t.def}` && sess.model === t.def,
      `record: ${JSON.stringify(r?.argv)} session model: ${sess.model}\n${out(s).replace(FAKE_KEY, '<key>').slice(-500)}`);

    const task2 = add(dir, 'Nim gone model');
    const s2 = start(dir, `--role builder --agent h1-gone --task ${task2} --tool nim --model old/eol-model`, { STUDIO_WORKTREES: 'off', NVIDIA_API_KEY: FAKE_KEY, STUDIO_FAKE_AIDER_410: '1' });
    let log = '';
    try { log = fs.readFileSync(path.join(dir, '.studio', 'agents', 'h1-gone.log'), 'utf8'); } catch {}
    let ev = null;
    try { ev = fs.readFileSync(path.join(dir, '.studio', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'agent.model_gone' && e.agent === 'h1-gone').pop(); } catch {}
    const last = log.trim().split('\n').pop();
    report('H-1: when NIM answers 410 for the model (aider\'s "Error code: 410 … has reached its end of life"), the agent\'s log ends with one [launcher] line naming the model and what to set, and an agent.model_gone event goes to a person',
      /^\[launcher\] NIM says old\/eol-model is gone \(410/.test(last || '') && /STUDIO_NIM_MODEL/.test(last || '') && ev?.to === 'human' && /old\/eol-model/.test(ev?.msg || ''),
      `last line: ${last}\nevent: ${JSON.stringify(ev)}\n${out(s2).replace(FAKE_KEY, '<key>').slice(-400)}`);
  }

  // ---------- H-8: the key reaches aider through a .env loaded over the environment ----------
  if (lanesOk) {
    const s = start(repo, `--role builder --agent h8-nim --task ${tasks.h8} --tool nim --model moonshotai/kimi-k2.6`, { NVIDIA_API_KEY: FAKE_KEY });
    const r = recOf('aider', 'h8-nim');
    const places = { argv: JSON.stringify(r?.argv || []), stdout: out(s) };
    for (const rel of ['.studio/agents/h8-nim.log', '.studio/agents/h8-nim.json', '.studio/events.jsonl', '.studio/kickoff/h8-nim.md']) { try { places[rel] = fs.readFileSync(path.join(repo, rel), 'utf8'); } catch { places[rel] = ''; } }
    const leaked = Object.entries(places).filter(([, v]) => v.includes(FAKE_KEY)).map(([k]) => k);
    report('H-8 (crew nim-4: "litellm.AuthenticationError … Header of type authorization was missing"): a nim session in its lane copy, whose .env is the template\'s (an empty OPENAI_API_KEY=), loaded over the environment as aider does, still ends up with the NIM key (AIDER_OPENAI_API_KEY is applied after the .env files); the key appears nowhere in argv, output, log, record, events or kickoff',
      s.status === 0 && inCopy(r, 'h8-nim') && r.keySet === true && r.keyMatches === true && !leaked.length,
      `record: ${JSON.stringify(r && { argv: r.argv, cwd: r.cwd, keySet: r.keySet, keyMatches: r.keyMatches })}\nleaked into: ${leaked.join(', ') || 'nothing'}\n${out(s).replace(FAKE_KEY, '<key>').slice(-500)}`);
    report('H-8 (owner condition: "The nim argv has no --no-auto-commits; please add it"): aider is started with --no-auto-commits',
      Boolean(r) && (r.argv || []).includes('--no-auto-commits') && (r.argv || []).includes('--yes-always'),
      JSON.stringify(r?.argv || null));
  }
  {
    const t = probe(dir, `import { agentEnv } from ${u(dir, 'harness/agent-env.mjs')};
import { envValue } from ${u(dir, 'harness/launch.mjs')};
const base = { Path: 'C:\\\\Windows', NVIDIA_API_KEY: ${JSON.stringify(FAKE_KEY)}, OpenAI_Api_Key: 'sk-owner-own', openai_base_url: 'https://example.invalid', AIDER_OPENAI_API_BASE: 'https://example.invalid' };
const names = (e) => Object.keys(e).filter((k) => /openai/i.test(k)).sort();
const full = agentEnv({ tool: 'nim', role: 'builder', model: 'a/b', env: { ...base, STUDIO_AGENT_ENV: 'full' } });
const pass = agentEnv({ tool: 'nim', role: 'builder', model: 'a/b', env: { ...base, STUDIO_AGENT_ENV_PASS: 'OpenAI_Api_Key' } });
console.log(JSON.stringify({ full: names(full), pass: names(pass), winSees: envValue(full, 'OPENAI_API_KEY', 'win32') === ${JSON.stringify(FAKE_KEY)} && envValue(pass, 'openai_api_key', 'win32') === ${JSON.stringify(FAKE_KEY)}, aider: full.AIDER_OPENAI_API_KEY === ${JSON.stringify(FAKE_KEY)} }));`);
    report('H-8: a nim child\'s environment, with Windows-style names (simulated win32 lookup): an OPENAI_ name in another letter case (OpenAI_Api_Key, openai_base_url; one variable each on Windows) or AIDER_OPENAI_API_BASE is dropped, also with STUDIO_AGENT_ENV=full or a pass list, so the child sees only the NIM key as OPENAI_API_KEY and AIDER_OPENAI_API_KEY',
      same(t.full, ['AIDER_OPENAI_API_KEY', 'OPENAI_API_KEY']) && same(t.pass, ['AIDER_OPENAI_API_KEY', 'OPENAI_API_KEY']) && t.winSees === true && t.aider === true,
      JSON.stringify(t).slice(0, 1200));
  }
}
