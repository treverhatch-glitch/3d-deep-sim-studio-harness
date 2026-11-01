/**
 * qa/selftest-2583m.mjs — 2.58.3 launcher fixes from the crew's Windows logs (M1 to M5).
 *   M1: a session in a lane copy is told it may use the main checkout's real studio/ and .studio/ (Claude Code:
 *       --add-dir, each flag and path its own argument); outside a lane copy, nothing is added.
 *   M2: a code-writing role on a task with no lane gets its own copy (.lanes/<agent>) with a built-in tool; a producer,
 *       a custom command and STUDIO_LANELESS=shared stay in the main checkout.
 *   M3: `npm run agent -- allow agy` writes the studio's .studio/agy-settings.json by default (not agy's user file),
 *       --scope user still writes the user file, and toolCommand('agy') passes --settings <file> only when it exists.
 *   M4: a `nim` tool (aider on NVIDIA NIM): its argv, OPENAI_API_KEY set from NVIDIA_API_KEY for the child only (never
 *       in argv, the log, the session record or the events), and a clear refusal without a key or without aider.
 *   M5: the kickoff's allowed-commands note says one command per Bash call and to read files with the file tools.
 * The end-to-end checks start the real launcher with fake `claude`/`aider` programs first on PATH (POSIX: a node
 * script with a shebang; Windows: a .cmd wrapper, UNTESTED here). No real tool, key or network is used.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// A made-up value: the checks look for it where it must not be.
const FAKE_KEY = 'fake-nim-key-for-selftest-2583m';
const QUIET = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_HEARTBEAT_SEC: '1', STUDIO_ROLE: '', STUDIO_MAIN_ROOT: '', STUDIO_BUILDER_CMD: '', STUDIO_PRODUCER_CMD: '', STUDIO_AGENT_CMD: '', STUDIO_REHEARSAL: '' };

export async function selftest2583M({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const u = (root, p) => JSON.stringify(pathToFileURL(path.join(root, p)).href);
  let n = 0;
  const probe = (root, code, env = {}) => {
    const f = path.join(root, `.probe-2583m-${n++}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(root, `node ${path.basename(f)}`, { ...QUIET, ...env });
    try { return { ...JSON.parse(String(r.stdout).trim().split('\n').pop()), raw: out(r) }; } catch { return { raw: out(r) }; }
  };
  const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };

  // ---------- fake tools first on PATH: they record their argv, cwd and the key names they were given ----------
  const bin = path.join(tmpRoot, 'bin-2583m');
  const rec = path.join(tmpRoot, 'rec-2583m');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(rec, { recursive: true });
  const fakeJs = path.join(tmpRoot, 'fake-tool-2583m.cjs');
  fs.writeFileSync(fakeJs, `const fs = require('fs'); const path = require('path');
const tool = process.env.FAKE_TOOL_NAME || path.basename(process.argv[1]).replace(/\\.(cjs|js)$/, '');
const e = process.env;
fs.writeFileSync(path.join(${JSON.stringify(rec)}, tool + '-' + (e.STUDIO_LOCK_OWNER || 'x') + '.json'), JSON.stringify({
  argv: process.argv.slice(2), cwd: process.cwd(),
  keyMatches: e.OPENAI_API_KEY === ${JSON.stringify(FAKE_KEY)},
  keyNames: Object.keys(e).filter((k) => /^(OPENAI_|NVIDIA_)/.test(k)).sort(),
}));
`);
  for (const tool of ['claude', 'aider']) {
    if (process.platform === 'win32') fs.writeFileSync(path.join(bin, `${tool}.cmd`), `@echo off\r\nset FAKE_TOOL_NAME=${tool}\r\n"${process.execPath}" "${fakeJs}" %*\r\n`);
    else {
      fs.writeFileSync(path.join(bin, tool), `#!${process.execPath}\nprocess.env.FAKE_TOOL_NAME = ${JSON.stringify(tool)};\nrequire(${JSON.stringify(fakeJs)});\n`);
      fs.chmodSync(path.join(bin, tool), 0o755);
    }
  }
  const recOf = (tool, agent) => { try { return JSON.parse(fs.readFileSync(path.join(rec, `${tool}-${agent}.json`), 'utf8')); } catch { return null; } };
  const withBin = { PATH: `${bin}${path.delimiter}${process.env.PATH || ''}` };

  // ---------- a git checkout of its own for the lane copies ----------
  const repo = path.join(tmpRoot, 'repo-2583m');
  fs.cpSync(dir, repo, { recursive: true, filter: (src) => !/[\\/](node_modules|\.git)$/.test(src) });
  const g = (cmd) => run(repo, `git -c user.email=t@t -c user.name=t ${cmd}`);
  g('init -q -b main');
  g('add -A');
  g('commit -qm base');
  const support = run(repo, `node -e "import('./harness/worktree.mjs').then(m=>console.log(JSON.stringify(m.worktreeSupport())))"`);
  const lanesOk = /"ok":true/.test(support.stdout);
  const add = (title, role = 'builder') => (run(repo, `node harness/task.mjs add "${title}" --role ${role} --priority P1`, QUIET).stdout.match(/"id": "(T-\d+)"/) || [])[1];
  const tasks = { m1: add('Lane add-dir'), m2: add('Laneless builder'), m2s: add('Laneless shared'), m2p: add('Producer laneless', 'producer'), m2c: add('Laneless custom'), m1p: add('Producer plain', 'producer') };
  g('add -A');
  g('commit -qm board');
  const start = (args, env = {}) => run(repo, `node harness/agent.mjs start ${args}`, { ...QUIET, ...withBin, ...env });
  const mainStudio = [real(path.join(repo, 'studio')), real(path.join(repo, '.studio'))];
  const addDirsOf = (argv = []) => argv.flatMap((a, i) => (a === '--add-dir' ? [argv[i + 1]] : []));
  const inCopy = (r, agent) => Boolean(r) && real(r.cwd) === real(path.join(repo, '.lanes', agent));

  // ---------- M1: Claude in a lane copy gets --add-dir for the main checkout's real studio/ and .studio/ ----------
  if (!lanesOk) report('M1/M2: lane copies skipped, this machine can\'t make them (git 2.42+ needed)', true, support.stdout);
  else {
    const s1 = start(`--role builder --agent m1-lane --task ${tasks.m1} --lane cartridges/example-sim --tool claude --model m-1`);
    const r1 = recOf('claude', 'm1-lane');
    const s2 = start(`--role producer --agent m1-main --task ${tasks.m1p} --tool claude --model m-1`);
    const r2 = recOf('claude', 'm1-main');
    const dirs1 = addDirsOf(r1?.argv);
    const pairs = (r1?.argv || []).filter((a) => a === '--add-dir').length;
    report('M1 (crew: "Claude requested permissions to read from …\\.lanes\\builder-s8\\… to …\\studio\\roles\\builder.md, which is outside the allowed working directories"): a Claude session started in a lane copy gets --add-dir <main>/studio and --add-dir <main>/.studio (each flag and path its own argument, the main checkout\'s real folders); a session in the main checkout gets none',
      s1.status === 0 && inCopy(r1, 'm1-lane') && pairs === 2 && dirs1.length === 2 && dirs1.map(real).join('|') === mainStudio.join('|') && dirs1.every((d) => path.isAbsolute(d) && !/[\\/]\.lanes[\\/]/.test(d))
        && s2.status === 0 && r2 && real(r2.cwd) === real(repo) && !(r2.argv || []).includes('--add-dir'),
      `lane: ${JSON.stringify(r1)}\nwant ${mainStudio.join(', ')}\n${out(s1).slice(-600)}\nmain: ${JSON.stringify(r2)}\n${out(s2).slice(-400)}`);

    // ---------- M2: a builder on a laneless task works in its own copy; a producer doesn't ----------
    const b = start(`--role builder --agent m2-builder --task ${tasks.m2} --tool claude --model m-1`);
    const rb = recOf('claude', 'm2-builder');
    const p = start(`--role producer --agent m2-prod --task ${tasks.m2p} --tool claude --model m-1`);
    const rp = recOf('claude', 'm2-prod');
    const sh = start(`--role builder --agent m2-shared --task ${tasks.m2s} --tool claude --model m-1`, { STUDIO_LANELESS: 'shared' });
    const rs = recOf('claude', 'm2-shared');
    const cu = start(`--role builder --agent m2-custom --task ${tasks.m2c} --tool claude --model m-1`, { STUDIO_BUILDER_CMD: `node "${fakeJs}"` });
    const rc = recOf('fake-tool-2583m', 'm2-custom');
    const stray = g('status --porcelain').stdout.split('\n').filter((l) => /\.lanes/.test(l));
    report('M2 (crew P-039: "builder-s21/s22 on T-051 with lane None … left 3 test files staged on the main checkout"): a builder started on a task with no lane works in its own copy (.lanes/<agent>, with the --add-dir pair), which is removed when it ends; a producer on a laneless task stays in the main checkout, and so does a custom command (STUDIO_BUILDER_CMD: the launcher can\'t give it --add-dir); STUDIO_LANELESS=shared keeps the old shared checkout',
      b.status === 0 && inCopy(rb, 'm2-builder') && addDirsOf(rb?.argv).length === 2 && !fs.existsSync(path.join(repo, '.lanes', 'm2-builder'))
        && p.status === 0 && rp && real(rp.cwd) === real(repo) && sh.status === 0 && rs && real(rs.cwd) === real(repo) && cu.status === 0 && rc && real(rc.cwd) === real(repo) && !stray.length,
      `builder: ${JSON.stringify(rb)}\n${out(b).slice(-500)}\nproducer: ${JSON.stringify(rp)}\nshared: ${JSON.stringify(rs)}\ncustom: ${JSON.stringify(rc)} ${out(cu).slice(-300)}\nstray: ${stray.join(', ')}`);
  }

  // ---------- M3: allow agy writes the studio file by default; --settings only when it exists; --scope user still works ----------
  {
    const studioFile = path.join(dir, '.studio', 'agy-settings.json');
    fs.rmSync(studioFile, { force: true });
    const agyArgv = () => probe(dir, `import { toolCommand } from ${u(dir, 'harness/agent.mjs')};
console.log(JSON.stringify({ argv: toolCommand('agy', { model: 'm', prompt: 'P R' }).argv }));`);
    const before = agyArgv();
    const homeA = path.join(tmpRoot, 'home-2583m-a');
    fs.mkdirSync(homeA, { recursive: true });
    const as = (h) => ({ ...QUIET, HOME: h, USERPROFILE: h });
    const userFileA = path.join(homeA, '.gemini', 'antigravity-cli', 'settings.json');
    const dry = run(dir, 'node harness/agent.mjs allow agy --dry-run', as(homeA));
    const w = run(dir, 'node harness/agent.mjs allow agy --by owner-ana', as(homeA));
    let st = {};
    try { st = JSON.parse(fs.readFileSync(studioFile, 'utf8')); } catch {}
    const after = agyArgv();
    const i = (after.argv || []).indexOf('--settings');
    const homeB = path.join(tmpRoot, 'home-2583m-b');
    fs.mkdirSync(homeB, { recursive: true });
    const studioBytes = fs.existsSync(studioFile) ? fs.readFileSync(studioFile, 'utf8') : null;
    const us = run(dir, 'node harness/agent.mjs allow agy --by owner-ana --scope user', as(homeB));
    let uf = {};
    try { uf = JSON.parse(fs.readFileSync(path.join(homeB, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8')); } catch {}
    const rules = st.permissions?.allow || [];
    report('M3 (crew P-037 addendum: "agy accepts agy --settings <file> (a session settings file)"): npm run agent -- allow agy --by <owner> writes the rules to the studio\'s .studio/agy-settings.json by default (the dry run names it; agy\'s user file is not created); --scope user still writes the user file and leaves the studio file as it was',
      dry.status === 0 && out(dry).includes(studioFile) && w.status === 0 && rules.includes('command(npm)') && rules.some((r) => r.startsWith('command(regex:^npm')) && !fs.existsSync(userFileA)
        && us.status === 0 && (uf.permissions?.allow || []).includes('command(npm)') && fs.readFileSync(studioFile, 'utf8') === studioBytes,
      `dry (${dry.status}): ${out(dry).slice(-500)}\nwrite (${w.status}): ${out(w).slice(-500)}\nstudio rules: ${rules.length}; user file A exists: ${fs.existsSync(userFileA)}\nuser scope (${us.status}): ${out(us).slice(-400)}`);
    report('M3: the launcher passes the studio file to agy (toolCommand: --settings <file>, as separate arguments, after the prompt\'s place) only when it exists',
      Array.isArray(before.argv) && !before.argv.includes('--settings') && i > 2 && real(after.argv[i + 1]) === real(studioFile) && after.argv[2] === 'P R',
      `before: ${JSON.stringify(before.argv)} ${before.raw?.slice(-300)}\nafter: ${JSON.stringify(after.argv)} ${after.raw?.slice(-300)}`);
    fs.rmSync(studioFile, { force: true });
  }

  // ---------- M4: the nim tool ----------
  {
    const t = probe(dir, `import { toolCommand } from ${u(dir, 'harness/agent.mjs')};
import { agentEnv } from ${u(dir, 'harness/agent-env.mjs')};
const env = { PATH: '/bin', NVIDIA_API_KEY: ${JSON.stringify(`${FAKE_KEY},second`)}, OPENAI_API_KEY: 'sk-owner-openai', OPENAI_BASE_URL: 'https://example.invalid', STUDIO_X: '1' };
const e = agentEnv({ tool: 'nim', role: 'builder', model: 'qwen/x', env });
const full = agentEnv({ tool: 'nim', role: 'builder', model: 'qwen/x', env: { ...env, STUDIO_AGENT_ENV: 'full' } });
const none = agentEnv({ tool: 'nim', role: 'builder', model: 'qwen/x', env: { PATH: '/bin', OPENAI_API_KEY: 'sk-owner-openai' } });
console.log(JSON.stringify({
  argv: toolCommand('nim', { model: 'meta/llama-x', file: '/k/kick.md' })?.argv,
  envModel: toolCommand('nim', { model: null, file: '/k/kick.md' })?.argv?.[2],
  keyOk: e.OPENAI_API_KEY === ${JSON.stringify(FAKE_KEY)} && full.OPENAI_API_KEY === ${JSON.stringify(FAKE_KEY)},
  names: Object.keys(e).filter((k) => /^(OPENAI_|NVIDIA_)/.test(k)).sort(),
  noneNames: Object.keys(none).filter((k) => /^(OPENAI_|NVIDIA_)/.test(k)),
}));`, { STUDIO_NIM_MODEL: 'nv/model-from-env' });
    const want = ['aider', '--model', 'openai/meta/llama-x', '--openai-api-base', 'https://integrate.api.nvidia.com/v1', '--message-file', '/k/kick.md', '--yes-always'];
    report('M4 (crew P-040: "2.56.0 uses NIM only in route.mjs … The launcher\'s aider case is hard-coded to Ollama"): toolCommand(\'nim\') runs aider on NIM\'s OpenAI-compatible endpoint (openai/<model>, STUDIO_NIM_MODEL when no --model); the child gets OPENAI_API_KEY from NVIDIA_API_KEY (first of a list, also with STUDIO_AGENT_ENV=full) and none of the owner\'s own OPENAI_ names; no NIM key, no OPENAI_API_KEY',
      JSON.stringify(t.argv) === JSON.stringify(want) && t.envModel === 'openai/nv/model-from-env' && t.keyOk === true && JSON.stringify(t.names) === '["OPENAI_API_KEY"]' && Array.isArray(t.noneNames) && !t.noneNames.length,
      JSON.stringify(t).slice(0, 1500));

    // End to end: the launcher with a fake aider; the key reaches the child's environment and nowhere else.
    const nimTask = (run(dir, 'node harness/task.mjs add "Nim run" --role builder --priority P1', QUIET).stdout.match(/"id": "(T-\d+)"/) || [])[1];
    const s = run(dir, `node harness/agent.mjs start --role builder --agent nim-1 --task ${nimTask} --tool nim --model meta/llama-x`, { ...QUIET, ...withBin, NVIDIA_API_KEY: FAKE_KEY, STUDIO_WORKTREES: 'off' });
    const r = recOf('aider', 'nim-1');
    const places = { argv: JSON.stringify(r?.argv || []), stdout: out(s) };
    for (const rel of ['.studio/agents/nim-1.log', '.studio/agents/nim-1.json', '.studio/events.jsonl', '.studio/kickoff/nim-1.md']) { try { places[rel] = fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { places[rel] = ''; } }
    const leaked = Object.entries(places).filter(([, v]) => v.includes(FAKE_KEY)).map(([k]) => k);
    report('M4: npm run agent -- start --tool nim starts aider with the NIM argv, and the child sees the NIM key as OPENAI_API_KEY while the key appears nowhere in argv, the printed output, the agent log, the session record, the events or the kickoff',
      s.status === 0 && r && r.argv?.[1] === 'openai/meta/llama-x' && r.argv.includes('https://integrate.api.nvidia.com/v1') && r.keyMatches === true && JSON.stringify(r.keyNames) === '["OPENAI_API_KEY"]' && !leaked.length,
      `status ${s.status}; record: ${JSON.stringify(r && { ...r, keyMatches: r.keyMatches })}\nleaked into: ${leaked.join(', ') || 'nothing'}\n${out(s).replace(FAKE_KEY, '<key>').slice(-600)}`);

    // Refusals: no key (aider present), no aider (key present). Nothing starts; the message says what to do.
    const noKeyTask = (run(dir, 'node harness/task.mjs add "Nim no key" --role builder --priority P1', QUIET).stdout.match(/"id": "(T-\d+)"/) || [])[1];
    const k = run(dir, `node harness/agent.mjs start --role builder --agent nim-nokey --task ${noKeyTask} --tool nim --model meta/llama-x`, { ...QUIET, ...withBin, NVIDIA_API_KEY: '', NVIDIA_API_KEY_2: '', STUDIO_WORKTREES: 'off' });
    const nodeOnly = path.join(tmpRoot, 'bin-2583m-node');
    fs.mkdirSync(nodeOnly, { recursive: true });
    try { fs.symlinkSync(process.execPath, path.join(nodeOnly, process.platform === 'win32' ? 'node.exe' : 'node')); } catch {}
    const pre = probe(dir, `import { toolPreflight } from ${u(dir, 'harness/agent.mjs')};
console.log(JSON.stringify({ msg: toolPreflight('nim', { PATH: ${JSON.stringify(nodeOnly)}, OPENAI_API_KEY: 'x' }), ok: toolPreflight('nim', { PATH: ${JSON.stringify(bin)}, OPENAI_API_KEY: 'x' }), other: toolPreflight('claude', { PATH: '' }) }));`);
    const noAiderTask = (run(dir, 'node harness/task.mjs add "Nim no aider" --role builder --priority P1', QUIET).stdout.match(/"id": "(T-\d+)"/) || [])[1];
    const a = run(dir, `node harness/agent.mjs start --role builder --agent nim-noaider --task ${noAiderTask} --tool nim --model meta/llama-x`, { ...QUIET, PATH: `${nodeOnly}${path.delimiter}${process.env.PATH || ''}`, NVIDIA_API_KEY: FAKE_KEY, STUDIO_WORKTREES: 'off' });
    const aiderElsewhere = String(process.env.PATH || '').split(path.delimiter).some((d) => fs.existsSync(path.join(d, process.platform === 'win32' ? 'aider.exe' : 'aider')));
    report('M4: without NVIDIA_API_KEY a nim start is refused with "NVIDIA_API_KEY is not set" and aider never runs; without aider on PATH it says "install aider (pip install aider-chat) — needs the owner\'s OK" (no crash, no stack trace)',
      k.status !== 0 && /NVIDIA_API_KEY is not set/.test(out(k)) && !recOf('aider', 'nim-nokey') && /install aider \(pip install aider-chat\) — needs the owner's OK/.test(pre.msg || '') && pre.ok === null && pre.other === null
        && (aiderElsewhere || (a.status !== 0 && /pip install aider-chat/.test(out(a)) && !/at .*\.mjs:\d+/.test(out(a)))),
      `no key (${k.status}): ${out(k).slice(-400)}\npreflight: ${JSON.stringify(pre)}\nno aider (${a.status}): ${out(a).replace(FAKE_KEY, '<key>').slice(-400)}`);
  }

  // ---------- M5: the kickoff note ----------
  {
    const t = probe(dir, `import { allowedNote } from ${u(dir, 'harness/allowlist.mjs')};
import { kickoff } from ${u(dir, 'harness/kickoff.mjs')};
console.log(JSON.stringify({ note: allowedNote(), inKickoff: kickoff({ role: 'builder', agent: 'b-1', model: 'm' }).includes(allowedNote()) }));`);
    const note = t.note || '';
    report('M5 (crew: "This Bash command contains multiple operations. The following part requires approval: cat AGENTS.lite.md ; cat studio/roles/art.md", 51× "head -5; …", "cd ../.. && …", "STUDIO_LOCK_OWNER=x git …"): the allowed-commands note in every kickoff says one command per Bash call (no ; or && chains, no cd … && first, no VAR=x prefix) and to read files with the Read, Grep and Glob tools rather than cat or head',
      /one command per Bash call/i.test(note) && note.includes('`;`') && note.includes('`&&`') && /`cd … &&`/.test(note) && /`VAR=x`/.test(note) && /Read, Grep and Glob/.test(note) && /`cat`/.test(note) && /`head`/.test(note) && t.inKickoff === true,
      `${note}\n${t.raw?.slice(-300)}`);
  }
}
