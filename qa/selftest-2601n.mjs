/**
 * qa/selftest-2601n.mjs — 2.60.1 (helper n): the aider launch path (`--tool nim`, `--tool aider`).
 *   B-18: aider is found as STUDIO_AIDER_CMD, then <main>/.studio/aider-venv/{Scripts,bin}/aider(.exe), then PATH, by the
 *         preflight and the launched argv; a custom command for nim keeps nim's environment (the NIM key).
 *   B-19: before a nim session, its model is checked once (a stub fetch here); a not-found answer falls back through
 *         STUDIO_NIM_MODELS, the answer is cached in .studio/nim-models.json; 429 and network errors never change the
 *         model; none usable: not started.
 *   B-20: the session gets --aiderignore (the harness's folders and the protected paths, anchored) and the brief as
 *         --read; the ignore file and aider's .aider* files never show in the lane copy's git status.
 *   B-21: --no-pretty --no-fancy-input (and --no-gitignore) for both aider tools and in the kickoff's launch lines.
 *   B-37: a failed aider session keeps its lane copy and the last 200 lines of its output beside its log; Python
 *         output unbuffered; a bounded repo map (--map-tokens from config).
 * Stand-ins only: the "venv aider" is a node script (POSIX; on Windows a .cmd named by STUDIO_AIDER_CMD, UNTESTED here),
 * the model check uses STUDIO_NIM_CHECK_STUB or an injected fetch. No real aider, key or network.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const FAKE_KEY = 'fake-nim-key-for-selftest-2601n';
const QUIET = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_HEARTBEAT_SEC: '1', STUDIO_ROLE: '', STUDIO_MAIN_ROOT: '', STUDIO_BUILDER_CMD: '', STUDIO_PRODUCER_CMD: '', STUDIO_AGENT_CMD: '', STUDIO_REHEARSAL: '', STUDIO_TOOL_NIM_CMD: '', STUDIO_TOOL_AIDER_CMD: '', STUDIO_NIM_MODEL: '', STUDIO_NIM_MODELS: '', STUDIO_BUILDER_MODEL: '', STUDIO_AGENT_MODEL: '', STUDIO_LANELESS: '', STUDIO_WORKTREES: '', NVIDIA_API_KEY: '', NVIDIA_API_KEY_2: '', OPENAI_API_KEY: '', AIDER_OPENAI_API_KEY: '', STUDIO_AIDER_CMD: '', STUDIO_NIM_CHECK: '', STUDIO_NIM_CHECK_STUB: '', STUDIO_NIM_CHECK_HOURS: '', STUDIO_AIDER_MAP_TOKENS: '', STUDIO_AIDER_MAP_REFRESH: '', STUDIO_KEEP_FAILED_LANE: '', STUDIO_FAILED_TAIL_LINES: '', PYTHONUNBUFFERED: '', PYTHONIOENCODING: '', STUDIO_NIM_FALLBACK: '', STUDIO_TAKEOVER: 'off' };

export async function selftest2601N({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const u = (root, p) => JSON.stringify(pathToFileURL(path.join(root, p)).href);
  const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  const guard = (name, fn) => { try { const [ok, detail] = fn(); report(name, ok, detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  let n = 0;
  const probe = (root, code, env = {}) => {
    const f = path.join(root, `.probe-2601n-${n++}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(root, `node ${path.basename(f)}`, { ...QUIET, ...env });
    fs.rmSync(f, { force: true });
    try { return { ...JSON.parse(String(r.stdout).trim().split('\n').pop()), raw: out(r) }; } catch { return { raw: out(r).slice(-2000) }; }
  };

  // ---------- the stand-in aider: records its argv, script path, cwd, key booleans, git status; may fail loudly ----------
  const rec = path.join(tmpRoot, 'rec-2601n');
  fs.mkdirSync(rec, { recursive: true });
  const fakeJs = path.join(tmpRoot, 'fake-aider-2601n.cjs');
  fs.writeFileSync(fakeJs, `const fs = require('fs'); const path = require('path'); const cp = require('child_process');
const e = process.env;
const st = cp.spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' });
if (e.STUDIO_FAKE_AIDER_HISTORY === '1') fs.writeFileSync('.aider.chat.history.md', 'history');
const st2 = cp.spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' });
fs.writeFileSync(path.join(${JSON.stringify(rec)}, 'aider-' + (e.STUDIO_LOCK_OWNER || 'x') + '.json'), JSON.stringify({ argv: process.argv.slice(2), script: process.env.FAKE_AIDER_SELF || process.argv[1], cwd: process.cwd(),
  keySet: Boolean(e.OPENAI_API_KEY), keyMatches: e.OPENAI_API_KEY === ${JSON.stringify(FAKE_KEY)} && e.AIDER_OPENAI_API_KEY === ${JSON.stringify(FAKE_KEY)},
  unbuffered: e.PYTHONUNBUFFERED === '1', utf8: /utf-?8/i.test(e.PYTHONIOENCODING || ''), status: (st.stdout || '') + (st2.stdout || '') }));
if (e.STUDIO_FAKE_AIDER_FAIL === '1') { for (let i = 1; i <= 300; i++) console.log('aider line ' + i); process.exit(1); }
`);
  const makeAider = (file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (file.endsWith('.cmd')) fs.writeFileSync(file, `@echo off\r\nset FAKE_AIDER_SELF=%~f0\r\n"${process.execPath}" "${fakeJs}" %*\r\n`);
    // import(), not require(): an extensionless script inside a "type": "module" package is loaded as ESM.
    else { fs.writeFileSync(file, `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(fakeJs).href)});\n`); fs.chmodSync(file, 0o755); }
    return file;
  };
  const recOf = (agent) => { try { return JSON.parse(fs.readFileSync(path.join(rec, `aider-${agent}.json`), 'utf8')); } catch { return null; } };
  // node alone on PATH (plus git for the lane copies): no aider anywhere on it.
  const nodeOnly = path.join(tmpRoot, 'bin-2601n-node');
  fs.mkdirSync(nodeOnly, { recursive: true });
  try { fs.symlinkSync(process.execPath, path.join(nodeOnly, process.platform === 'win32' ? 'node.exe' : 'node')); } catch {}
  const sysPath = String(process.env.PATH || '').split(path.delimiter).filter((d) => !fs.existsSync(path.join(d, process.platform === 'win32' ? 'aider.exe' : 'aider')) && !fs.existsSync(path.join(d, 'aider.cmd'))).join(path.delimiter);
  const noAider = { PATH: `${nodeOnly}${path.delimiter}${sysPath}` };

  // ---------- B-18 (pure): preflight finds the venv's aider (POSIX bin/aider; win32 Scripts/aider.exe simulated), STUDIO_AIDER_CMD ----------
  {
    if (process.platform !== 'win32') makeAider(path.join(tmpRoot, 'main-2601n', '.studio', 'aider-venv', 'bin', 'aider'));
    const winExe = path.join(tmpRoot, 'win-2601n', '.studio', 'aider-venv', 'Scripts', 'aider.exe');
    fs.mkdirSync(path.dirname(winExe), { recursive: true });
    fs.writeFileSync(winExe, 'MZ');
    const custom = makeAider(path.join(tmpRoot, 'own-2601n', 'aider'));
    const t = probe(dir, `import { toolPreflight } from ${u(dir, 'harness/agent.mjs')};
const e = (o) => ({ PATH: '', OPENAI_API_KEY: 'x', ...o });
console.log(JSON.stringify({
  venvNim: process.platform === 'win32' ? null : toolPreflight('nim', e({ STUDIO_MAIN_ROOT: ${JSON.stringify(path.join(tmpRoot, 'main-2601n'))} })),
  venvAider: process.platform === 'win32' ? null : toolPreflight('aider', e({ STUDIO_MAIN_ROOT: ${JSON.stringify(path.join(tmpRoot, 'main-2601n'))} })),
  winExe: toolPreflight('nim', e({ STUDIO_MAIN_ROOT: ${JSON.stringify(path.join(tmpRoot, 'win-2601n'))} }), 'win32'),
  own: toolPreflight('nim', e({ STUDIO_AIDER_CMD: ${JSON.stringify(custom)} })),
  bad: toolPreflight('nim', e({ STUDIO_AIDER_CMD: ${JSON.stringify(path.join(tmpRoot, 'nowhere', 'aider'))} })),
  none: toolPreflight('nim', e({})),
  noneAider: toolPreflight('aider', e({})),
}));`);
    report('B-18 (crew: "aider is not installed (not found on PATH)"; it is in .studio/aider-venv/Scripts): with nothing on PATH, the preflight for nim and aider finds the studio venv\'s aider (bin/aider here; Scripts/aider.exe with win32 simulated) and STUDIO_AIDER_CMD; a STUDIO_AIDER_CMD that points nowhere is named, never replaced; nothing anywhere still says "pip install aider-chat"',
      t.winExe === null && t.own === null && /STUDIO_AIDER_CMD is set to/.test(t.bad || '') && /pip install aider-chat\) — needs the owner's OK/.test(t.none || '') && /pip install aider-chat/.test(t.noneAider || '')
        && (process.platform === 'win32' || (t.venvNim === null && t.venvAider === null)),
      JSON.stringify(t).slice(0, 1500));
  }

  // ---------- a git checkout of its own (lane copies need one) ----------
  const repo = path.join(tmpRoot, 'repo-2601n');
  fs.cpSync(dir, repo, { recursive: true, filter: (src) => !/[\\/](node_modules|\.git)$/.test(src) });
  try { fs.symlinkSync(fs.realpathSync(path.join(dir, 'node_modules')), path.join(repo, 'node_modules'), 'junction'); } catch {}
  const g = (cmd) => run(repo, `git -c user.email=t@t -c user.name=t ${cmd}`);
  g('init -q -b main');
  g('add -A');
  g('commit -qm base');
  const support = run(repo, `node -e "import('./harness/worktree.mjs').then(m=>console.log(JSON.stringify(m.worktreeSupport())))"`);
  const lanesOk = /"ok":true/.test(support.stdout);
  const add = (title) => (run(repo, `node harness/task.mjs add "${title}" --role builder --priority P1`, QUIET).stdout.match(/"id": "(T-\d+)"/) || [])[1];
  const tasks = { venv: add('Venv aider'), custom: add('Custom nim'), customNoKey: add('Custom nim no key'), fb: add('Nim fallback'), none: add('Nim none'), lane: add('Nim in a copy'), fail: add('Nim fails') };
  g('add -A');
  g('commit -qm board');
  // POSIX: the venv's bin/aider; Windows: a .cmd stand-in named by STUDIO_AIDER_CMD (a real venv has Scripts/aider.exe).
  const venvAider = process.platform === 'win32' ? makeAider(path.join(tmpRoot, 'win-aider-2601n', 'aider.cmd')) : makeAider(path.join(repo, '.studio', 'aider-venv', 'bin', 'aider'));
  const viaVenv = process.platform === 'win32' ? { STUDIO_AIDER_CMD: venvAider } : {};
  const start = (args, env = {}) => run(repo, `node harness/agent.mjs start ${args}`, { ...QUIET, ...noAider, ...viaVenv, NVIDIA_API_KEY: FAKE_KEY, STUDIO_NIM_CHECK: 'off', ...env });
  const logOf = (agent) => { try { return fs.readFileSync(path.join(repo, '.studio', 'agents', `${agent}.log`), 'utf8'); } catch { return ''; } };
  const eventsOf = (agent, type) => { try { return fs.readFileSync(path.join(repo, '.studio', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.agent === agent && (!type || e.type === type)); } catch { return []; } };
  const leakedFor = (agent, extra = {}) => {
    const places = { ...extra };
    for (const rel of [`.studio/agents/${agent}.log`, `.studio/agents/${agent}.json`, '.studio/events.jsonl', `.studio/kickoff/${agent}.md`, '.studio/nim-models.json']) { try { places[rel] = fs.readFileSync(path.join(repo, rel), 'utf8'); } catch { places[rel] = ''; } }
    for (const f of fs.readdirSync(path.join(repo, '.studio', 'agents')).filter((f) => f.startsWith(`${agent}.failed-`))) places[f] = fs.readFileSync(path.join(repo, '.studio', 'agents', f), 'utf8');
    return Object.entries(places).filter(([, v]) => String(v).includes(FAKE_KEY)).map(([k]) => k);
  };

  // ---------- B-18 (end to end): the launched argv starts the venv's aider ----------
  {
    const s = start(`--role builder --agent n-venv --task ${tasks.venv} --tool nim --model org/model-a`, { STUDIO_WORKTREES: 'off' });
    const r = recOf('n-venv');
    report('B-18: agent start --tool nim with no aider on PATH starts the studio venv\'s aider (the same one the preflight found), with the NIM key and the argv as before',
      s.status === 0 && r && real(r.script) === real(venvAider) && r.argv[1] === 'openai/org/model-a' && r.keyMatches === true && !leakedFor('n-venv', { stdout: out(s) }).length,
      `status ${s.status}; record: ${JSON.stringify(r && { script: r.script, argv: r.argv, keyMatches: r.keyMatches })}\n${out(s).replace(FAKE_KEY, '<key>').slice(-600)}`);
  }

  // ---------- B-18 (audit): a custom command for nim keeps nim's environment; no key: refused ----------
  {
    const cmd = `node ${JSON.stringify(fakeJs)} {model}`;
    const s = start(`--role builder --agent n-custom --task ${tasks.custom} --tool nim --model org/model-a`, { STUDIO_WORKTREES: 'off', STUDIO_TOOL_NIM_CMD: cmd });
    const r = recOf('n-custom');
    const k = start(`--role builder --agent n-custom-nokey --task ${tasks.customNoKey} --tool nim --model org/model-a`, { STUDIO_WORKTREES: 'off', STUDIO_TOOL_NIM_CMD: cmd, NVIDIA_API_KEY: '' });
    report('B-18 (audit surprise: STUDIO_TOOL_NIM_CMD made the session a "custom" tool and silently dropped the NIM key): a custom command for --tool nim gets the NIM key as OPENAI_API_KEY and AIDER_OPENAI_API_KEY (the log says so, never the value); without a NIM key it is refused with "NVIDIA_API_KEY is not set" and nothing runs',
      s.status === 0 && r && r.keyMatches === true && /custom command for --tool nim gets nim's environment/.test(logOf('n-custom')) && !leakedFor('n-custom', { stdout: out(s) }).length
        && k.status !== 0 && /NVIDIA_API_KEY is not set/.test(out(k)) && !recOf('n-custom-nokey'),
      `custom (${s.status}): ${JSON.stringify(r && { keySet: r.keySet, keyMatches: r.keyMatches })}\n${out(s).replace(FAKE_KEY, '<key>').slice(-400)}\nno key (${k.status}): ${out(k).slice(-300)}`);
  }

  // ---------- B-19 (pure): verdicts, fallback order, cache, no fallback on 429 or network ----------
  {
    const t = probe(dir, `import { pickNimModel, nimProbeVerdict, nimModelChain } from ${u(dir, 'harness/nim-check.mjs')};
import fs from 'node:fs';
const file = ${JSON.stringify(path.join(tmpRoot, 'nim-cache-2601n.json'))};
fs.rmSync(file, { force: true });
const calls = [];
const fetchOf = (table) => async (url, init) => { const m = JSON.parse(init.body).model; calls.push(m + ' ' + init.headers.Authorization.length); const a = table[m] || { status: 200 }; if (a === 'net') throw new Error('ECONNRESET'); return { status: a.status, text: async () => a.body || '' }; };
const key = ${JSON.stringify(FAKE_KEY)};
const env = { STUDIO_NIM_MODELS: 'org/b, org/c' };
const notFound = { status: 404, body: "{'detail': \\"Function 'abc': Not found for account 'xyz' (key ${FAKE_KEY})\\"}" };
const fb = await pickNimModel('org/a', { key, base: 'https://nim.invalid/v1', fetchImpl: fetchOf({ 'org/a': notFound }), env, file });
const cached = await pickNimModel('org/a', { key, base: 'https://nim.invalid/v1', fetchImpl: async () => { throw new Error('should not be called'); }, env, file });
const q = await pickNimModel('org/q', { key, base: 'https://nim.invalid/v1', fetchImpl: fetchOf({ 'org/q': { status: 429, body: 'Too Many Requests' } }), env, file });
const net = await pickNimModel('org/n', { key, base: 'https://nim.invalid/v1', fetchImpl: fetchOf({ 'org/n': 'net' }), env, file });
const none = await pickNimModel('org/x', { key, base: 'https://nim.invalid/v1', fetchImpl: fetchOf({ 'org/x': notFound, 'org/b': { status: 410, body: 'gone' }, 'org/c': { status: 403, body: 'model not entitled for this account' } }), env: { ...env, STUDIO_NIM_CHECK_HOURS: '0' }, file: file + '.2' });
const off = await pickNimModel('org/a', { key, fetchImpl: async () => { throw new Error('no'); }, env: { STUDIO_NIM_CHECK: 'off' }, file });
const cache = fs.readFileSync(file, 'utf8');
console.log(JSON.stringify({
  fb: [fb.model, fb.changed, fb.tried.map((x) => x.verdict).join(',')], fbLine: fb.line, cached: [cached.model, cached.tried[0].cached, cached.tried[1].cached],
  q: [q.model, q.changed, q.tried.length, q.tried[0].verdict], net: [net.model, net.skipped, net.tried.length], netLine: net.line,
  none: [none.model, none.tried.length], refused: none.refused, noCache2: !fs.existsSync(file + '.2'), off: [off.model, off.tried.length],
  v: [nimProbeVerdict(200), nimProbeVerdict(403, 'Forbidden'), nimProbeVerdict(401, ''), nimProbeVerdict(500, 'oops'), nimProbeVerdict(422, 'Function x: Not found for account y')],
  chain: nimModelChain('openai/org/a', { STUDIO_NIM_MODELS: 'org/a,org/b' }),
  keyInCache: cache.includes(key), keyInLines: [fb.line, none.refused, JSON.stringify(fb.tried)].join(' ').includes(key), cacheHas: /org\\/a/.test(cache) && /missing/.test(cache) && /"ok"/.test(cache),
}));`);
    report('B-19 (crew: kimi-k2.6 gives 404 "Function … Not found for account" for our key): the model check falls back through STUDIO_NIM_MODELS only on not-found/entitlement answers (404, 410, a 403/422 that says so), caches ok and missing answers (a second launch asks nothing), never falls back on a 429 or a network error (launch with the configured model, "check skipped"), refuses when none works, honours STUDIO_NIM_CHECK=off, and never puts the key in a line or the cache',
      t.fb?.[0] === 'org/b' && t.fb[1] === true && t.fb[2] === 'missing,ok' && /org\/b chosen instead of org\/a/.test(t.fbLine || '') && t.cached?.[0] === 'org/b' && t.cached[1] === true && t.cached[2] === true
        && t.q?.[0] === 'org/q' && t.q[1] === false && t.q[2] === 1 && t.q[3] === 'quota' && t.net?.[0] === 'org/n' && t.net[1] === true && t.net[2] === 1 && /check skipped/.test(t.netLine || '')
        && t.none?.[0] === null && t.none[1] === 3 && /none of the NIM models works/.test(t.refused || '') && t.noCache2 === true && t.off?.[0] === 'org/a' && t.off[1] === 0
        && JSON.stringify(t.v) === '["ok","skipped","skipped","skipped","missing"]' && JSON.stringify(t.chain) === '["org/a","org/b"]'
        && t.keyInCache === false && t.keyInLines === false && t.cacheHas === true,
      JSON.stringify(t).replaceAll(FAKE_KEY, '<key>').slice(0, 2500));
  }

  // ---------- B-19 (end to end): the launcher uses the check (stub answers), logs the choice, refuses when none works ----------
  {
    const stub = path.join(tmpRoot, 'nim-stub-2601n.json');
    fs.writeFileSync(stub, JSON.stringify({ 'org/dead': { status: 404, body: "Function 'f': Not found for account 'a'" }, 'org/dead2': { status: 404, body: 'Not found for account' } }));
    fs.rmSync(path.join(repo, '.studio', 'nim-models.json'), { force: true });
    const s = start(`--role builder --agent n-fb --task ${tasks.fb} --tool nim --model org/dead`, { STUDIO_WORKTREES: 'off', STUDIO_NIM_CHECK: '', STUDIO_NIM_CHECK_STUB: stub, STUDIO_NIM_MODELS: 'org/dead2,org/live' });
    const r = recOf('n-fb');
    let cache = {};
    try { cache = JSON.parse(fs.readFileSync(path.join(repo, '.studio', 'nim-models.json'), 'utf8')); } catch {}
    const ev = eventsOf('n-fb', 'agent.nim_model').pop();
    let sess = {};
    try { sess = JSON.parse(fs.readFileSync(path.join(repo, '.studio', 'agents', 'n-fb.json'), 'utf8')); } catch {}
    const k = start(`--role builder --agent n-none --task ${tasks.none} --tool nim --model org/dead`, { STUDIO_WORKTREES: 'off', STUDIO_NIM_CHECK: '', STUDIO_NIM_CHECK_STUB: stub, STUDIO_NIM_MODELS: 'org/dead2' });
    const verdicts = Object.values(cache).map((c) => `${c.model}=${c.verdict}`).sort().join(',');
    report('B-19: agent start --tool nim --model org/dead (NIM: 404 not found for account) with STUDIO_NIM_MODELS=org/dead2,org/live starts aider on openai/org/live, the session record says org/live, the log has a [launcher] line and an agent.nim_model event names both models, and .studio/nim-models.json holds the answers; when no model works it is not started and says to set STUDIO_NIM_MODEL(S)',
      s.status === 0 && r?.argv?.[1] === 'openai/org/live' && sess.model === 'org/live' && /\[launcher\] NIM model org\/live chosen instead of org\/dead/.test(logOf('n-fb')) && /org\/dead/.test(ev?.msg || '') && ev?.meta?.chosen === 'org/live'
        && verdicts === 'org/dead2=missing,org/dead=missing,org/live=ok' && !leakedFor('n-fb', { stdout: out(s) }).length
        && k.status !== 0 && /none of the NIM models works/.test(out(k)) && /STUDIO_NIM_MODEL/.test(out(k)) && !recOf('n-none'),
      `start (${s.status}): ${JSON.stringify(r?.argv)} session ${sess.model}\ncache: ${verdicts}\nevent: ${JSON.stringify(ev)}\nlog: ${logOf('n-fb').slice(-400)}\n${out(s).replace(FAKE_KEY, '<key>').slice(-400)}\nnone (${k.status}): ${out(k).slice(-300)}`);
  }

  // ---------- B-20, B-21 (pure): argv and the ignore file's patterns (git's matcher, the same wildmatch aider uses) ----------
  {
    const t = probe(dir, `import { toolCommand } from ${u(dir, 'harness/agent.mjs')};
import { aiderIgnoreLines } from ${u(dir, 'harness/aider-launch.mjs')};
import { launchLine } from ${u(dir, 'harness/kickoff.mjs')};
const nim = toolCommand('nim', { model: 'org/m', file: '/k/kick.md', aider: { program: '/venv/bin/aider', ignoreFile: '/s/a.aiderignore', reads: ['/s/briefs/T-1.md'] } }).argv;
const ol = toolCommand('aider', { model: 'qwen', file: '/k/kick.md' }).argv;
const off = toolCommand('nim', { model: 'org/m', file: '/k' }).argv;
console.log(JSON.stringify({ nim, ol, lines: aiderIgnoreLines(), kn: launchLine('nim', { agent: 'a', model: 'org/m' }).line, ka: launchLine('aider', { agent: 'a', model: 'q' }).line }));`);
    const tail = (a, f) => Array.isArray(a) && a.includes(f);
    const at = (a, f) => (Array.isArray(a) ? a[a.indexOf(f) + 1] : null);
    // The patterns, through git's own matcher.
    const ign = path.join(tmpRoot, 'ign-2601n');
    fs.writeFileSync(ign, `${(t.lines || []).join('\n')}\n`);
    const ci = (rel) => run(repo, `git -c core.excludesFile=${JSON.stringify(ign)} check-ignore --no-index -q ${JSON.stringify(rel)}`).status === 0;
    const must = ['harness/task.mjs', 'harness/lock.mjs', 'studio/NEXT.md', 'hub/server.mjs', 'scripts/run-gates.mjs', 'tools/x.mjs', 'qa/selftest.mjs', 'studio/protected.json', 'cartridges/demo/qa.mjs', 'qa/regressions/r1.json', '.github/workflows/ci.yml', 'game/demo/tools/controls.gd'];
    const mustNot = ['game/demo/tools/build-atlas.mjs', 'game/demo/src/main.ts', 'qa/golden/demo.json', 'cartridges/demo/index.mjs', 'web/demo/harness/x.ts'];
    const wrongIn = must.filter((p) => !ci(p));
    const wrongOut = mustNot.filter((p) => ci(p));
    report('B-20 (crew: aider added task.mjs, lock.mjs, NEXT.md to its chat) and B-21 (prompt-toolkit warnings under Git Bash): the nim argv has --aiderignore <file> and --read <brief>, both aider tools have --no-pretty --no-fancy-input --no-gitignore and a bounded --map-tokens; the ignore patterns (checked with git\'s matcher) cover harness/, hub/, scripts/, tools/, studio/, qa/*.mjs and the protected paths, anchored at the root so a game\'s own tools/ and goldens stay editable; the kickoff\'s launch lines carry the flags',
      t.nim?.[0] === '/venv/bin/aider' && at(t.nim, '--aiderignore') === '/s/a.aiderignore' && at(t.nim, '--read') === '/s/briefs/T-1.md'
        && ['--no-pretty', '--no-fancy-input', '--no-gitignore'].every((f) => tail(t.nim, f) && tail(t.ol, f)) && /^\d+$/.test(at(t.ol, '--map-tokens') || '') && !tail(t.off, '--aiderignore')
        && !wrongIn.length && !wrongOut.length && /--no-pretty --no-fancy-input/.test(t.kn || '') && /--no-pretty --no-fancy-input/.test(t.ka || ''),
      `nim: ${JSON.stringify(t.nim)}\nollama: ${JSON.stringify(t.ol)}\nnot ignored but should be: ${wrongIn.join(', ')}\nignored but shouldn't be: ${wrongOut.join(', ')}\nkickoff: ${t.kn}\n${t.raw?.slice(-500)}`);
  }

  // ---------- B-20 (end to end, lane copy): the ignore file and the brief reach aider; nothing new in the copy's status ----------
  if (!lanesOk) report('B-20/B-37: lane copies skipped, this machine can\'t make them (git 2.42+ needed)', true, support.stdout);
  else {
    fs.mkdirSync(path.join(repo, '.studio', 'briefs'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.studio', 'briefs', `${tasks.lane}.md`), `# ${tasks.lane}\nmade-up brief\n`);
    const s = start(`--role builder --agent n-lane --task ${tasks.lane} --tool nim --model org/model-a`, { STUDIO_FAKE_AIDER_HISTORY: '1', STUDIO_AIDER_MAP_TOKENS: '0' });
    const r = recOf('n-lane');
    const argv = r?.argv || [];
    const ignoreFile = argv[argv.indexOf('--aiderignore') + 1];
    let lines = '';
    try { lines = fs.readFileSync(ignoreFile, 'utf8'); } catch {}
    report('B-20: in its lane copy, a nim session gets --aiderignore <.studio/aider/n-lane.aiderignore> (listing /harness/ and /studio/protected.json) and --read <the task\'s brief>; aider\'s .aider* files and the ignore file never show in the copy\'s git status (the lane\'s change); STUDIO_AIDER_MAP_TOKENS=0 turns the repo map off; Python output is unbuffered and UTF-8',
      s.status === 0 && r && real(r.cwd) === real(path.join(repo, '.lanes', 'n-lane')) && argv.includes('--aiderignore') && real(path.dirname(ignoreFile || '.')) === real(path.join(repo, '.studio', 'aider'))
        && /^\/harness\/$/m.test(lines) && /^\/studio\/protected\.json$/m.test(lines) && real(argv[argv.indexOf('--read') + 1] || '.') === real(path.join(repo, '.studio', 'briefs', `${tasks.lane}.md`))
        && !/aider/.test(r.status) && argv[argv.indexOf('--map-tokens') + 1] === '0' && r.unbuffered === true && r.utf8 === true,
      `status ${s.status}; argv ${JSON.stringify(argv)}\ngit status in the copy: ${JSON.stringify(r?.status)}\nignore file: ${lines.slice(0, 300)}\n${out(s).replace(FAKE_KEY, '<key>').slice(-400)}`);

    // ---------- B-37: a failed session keeps its copy and the last 200 lines ----------
    const f = start(`--role builder --agent n-fail --task ${tasks.fail} --tool nim --model org/model-a`, { STUDIO_FAKE_AIDER_FAIL: '1' });
    const copyDir = path.join(repo, '.lanes', 'n-fail');
    const tails = fs.readdirSync(path.join(repo, '.studio', 'agents')).filter((x) => x.startsWith('n-fail.failed-'));
    let tailText = '';
    try { tailText = fs.readFileSync(path.join(repo, '.studio', 'agents', tails[0]), 'utf8'); } catch {}
    const tailLines = tailText.split('\n').filter((l) => /^aider line \d+$/.test(l));
    const ev = eventsOf('n-fail', 'agent.failed_evidence').pop();
    const log = logOf('n-fail');
    guard('B-37 (crew: "--tool nim … exited 1 right after aider\'s repo scan … nothing in the log. The lane copy was then removed"): a nim session that exits non-zero keeps its lane copy (named in the log and an event to a person, with how to remove it), and .studio/agents/<agent>.failed-<time>.log holds its last 200 lines (line 101 to 300 of 300), the exit code, and never the key', () => [
      fs.existsSync(path.join(copyDir, 'harness')) && tails.length === 1 && tailLines.length === 200 && tailLines[0] === 'aider line 101' && tailLines[199] === 'aider line 300' && /exited with code 1/.test(tailText)
        && /\[launcher\] nim exited with code 1.*last 200 lines.*lane copy is kept/.test(log) && /git worktree remove --force \.lanes\/n-fail/.test(log) && ev?.to === 'human' && ev?.meta?.keptCopy === '.lanes/n-fail'
        && !leakedFor('n-fail', { stdout: out(f) }).length,
      `status ${f.status}; copy exists: ${fs.existsSync(copyDir)}; tails: ${tails.join(', ')}; ${tailLines.length} lines (${tailLines[0]} … ${tailLines[tailLines.length - 1]})\nlog end: ${log.slice(-500)}\nevent: ${JSON.stringify(ev)}`,
    ]);
    // The ordinary end still removes the copy (n-lane exited 0).
    report('B-37: a session that ends normally (exit 0) still has its copy removed, as before', !fs.existsSync(path.join(repo, '.lanes', 'n-lane')), `exists: ${fs.existsSync(path.join(repo, '.lanes', 'n-lane'))}`);
    try { run(repo, 'git worktree remove --force .lanes/n-fail'); } catch {}
  }
  try { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch {}
}
