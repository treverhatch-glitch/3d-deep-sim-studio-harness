/**
 * qa/selftest-2791a.mjs — 2.79.1 (a): Vertex AI as a built-in tool, spend budgets per tool or key, owner-defined tools.
 *   1  the studio's Vertex proxy (harness/vertex-proxy.mjs): /v1/<sub> to the Vertex endpoint, x-goog-api-key, the session
 *      tag never forwarded, usage per session (out = total - prompt), 503 with the key renamed, the key written nowhere.
 *   2  `agent start --tool vertex` (the orchestrator's shell): aider on the proxy with the session tag; the session's
 *      environment and lane .env have no VERTEX_API_KEY; the proxy is started on demand; the session's tokens and dollars
 *      land on its agent.session.end and in `npm run tokens -- --by task`.
 *   3  the supervisor: Vertex before the paid API pool, its share of builder slots, the hard model, and a cut budget.
 *   4  spend budgets: none by default; set by the orchestrator on the owner's order; 75% pages once; 100% cuts (refused
 *      start, next tool) once; resume; workers and Producers refused; a key-name budget.
 *   5  the router's vertex-openai protocol (x-goog-api-key) and models:check's 404 as "listed: n/a".
 *   6  studio/tools.json: a person's entry launches like a built-in tool with only its key names; an agent's doesn't count;
 *      a change approved in beta mode by the orchestrator is refused (owner-only); the owner's signed approval counts.
 * A fake "Vertex" on 127.0.0.1 (no network). Each check names what 2.79.0 did.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const FAKE_KEY = 'fake-vertex-key-for-selftest-2791a';

export async function selftest2791A({ dir, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = path.join(harnessRoot, 'node_modules');
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const writeIn = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };
  const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), String(detail).split(FAKE_KEY).join('<KEY>')); } catch (e) { report(name, false, e.stack || String(e)); } };
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI|VERTEX|NVIDIA|XAI|GROQ|OPENROUTER|DEEPSEEK|GOOGLE)/i.test(k) || /_API_KEY|_TOKEN$/.test(k)) clean[k] = '';
  const base = {
    ...clean, STUDIO_REFILL_WAKE: 'off', STUDIO_WATCHDOG: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_HEALTH_CI: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_HEARTBEAT_SEC: '1',
    STUDIO_TEST_FREEMEM_MB: '32000', STUDIO_LINE_PRODUCER: 'off', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-2791a-${process.pid}.pem`), STUDIO_TAKEOVER: 'off', STUDIO_NIM_CHECK: 'off',
    CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', GITHUB_BASE_REF: '', CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '', STUDIO_MAIN_ROOT: '', STUDIO_ROLE: '', STUDIO_LOCK_OWNER: '', STUDIO_HOOKS_CHECK: 'off', PYTHONUNBUFFERED: '', PYTHONIOENCODING: '',
  };
  let n = 0;
  const studio = (name, { git = false } = {}) => {
    const S = path.join(tmpRoot, `2791a-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    for (const rel of ['.studio', '.env', 'studio/task-holds.json', 'studio/approvals', 'studio/keys', 'studio/beta.json', 'studio/tools.json']) fs.rmSync(path.join(S, rel), { recursive: true, force: true });
    writeIn(S, '.studio/events.jsonl', '');
    if (git) {
      writeIn(S, '.gitignore', `${readText(path.join(dir, '.gitignore'))}\n/.lanes/\n/.studio/\n.env\n`);
      g(S, 'init', '-q', '-b', 'main'); g(S, 'config', 'core.autocrlf', 'false'); g(S, 'config', 'core.eol', 'lf');
      g(S, 'config', 'user.name', 't'); g(S, 'config', 'user.email', 't@example.invalid');
      g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
    }
    return { S, env: { ...base, AGENT_EVENTS_FILE: path.join(S, '.studio', 'events.jsonl') } };
  };
  const node = (S, args, env, timeout = 180000) => spawnSync(process.execPath, args, { windowsHide: true, cwd: S, encoding: 'utf8', env: { ...process.env, ...ident, ...env }, timeout });
  const probe = (S, code, env) => { const f = path.join(S, `.probe-2791a-${++n}.mjs`); fs.writeFileSync(f, code); const r = node(S, [f], env); fs.rmSync(f, { force: true }); const l = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop(); let j = null; try { j = JSON.parse(l); } catch {} return { ...r, j }; };
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  const events = (S) => readText(path.join(S, '.studio', 'events.jsonl')).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const add = (S, title, env, extra = []) => (out(node(S, ['harness/task.mjs', 'add', title, '--role', 'builder', '--priority', 'P1', ...extra], env)).match(/"id":\s*"([A-Z]+-\d+)"/) || [])[1] || null;
  // Every file under a folder whose text holds the fake key (the key must be written nowhere).
  const leaks = (folder) => {
    const hits = [];
    const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const f = path.join(d, e.name); if (e.isSymbolicLink()) continue; if (e.isDirectory()) { if (!/^(node_modules|\.git)$/.test(e.name)) walk(f); } else if (e.name !== '.env' && e.name !== 'selftest-2791a.mjs') { try { if (fs.statSync(f).size < 8e6 && fs.readFileSync(f, 'latin1').includes(FAKE_KEY)) hits.push(path.relative(folder, f)); } catch {} } } };
    walk(folder);
    return hits;
  };
  // The fake Vertex, as its own process (a check's spawnSync blocks this one): records each request, answers with usage.
  const fakeJs = path.join(tmpRoot, `fake-vertex-2791a-${process.pid}.cjs`);
  fs.writeFileSync(fakeJs, `const http = require('http'); const fs = require('fs');
const [port, log] = process.argv.slice(2);
http.createServer((req, res) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
  fs.appendFileSync(log, JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: b }) + '\\n');
  if (/\\/models$/.test(req.url)) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":{"code":404}}'); }
  let model = null; try { model = JSON.parse(b).model; } catch {}
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'x', model, choices: [{ index: 0, message: { role: 'assistant', content: 'OK' } }], usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1300 } }));
}); }).listen(Number(port), '127.0.0.1');
setTimeout(() => process.exit(0), 240000);
`);
  const fakeVertex = async () => {
    const port = await freePort();
    const log = path.join(tmpRoot, `fake-vertex-2791a-${process.pid}-${port}.jsonl`);
    const child = spawn(process.execPath, [fakeJs, String(port), log], { windowsHide: true, stdio: 'ignore' });
    for (let i = 0; i < 50; i++) { await new Promise((r) => setTimeout(r, 100)); if (await new Promise((res) => { const s = net.connect(port, '127.0.0.1'); s.on('connect', () => { s.destroy(); res(true); }); s.on('error', () => res(false)); })) break; }
    return { port, log, base: `http://127.0.0.1:${port}/v1/projects/proj-2791a/locations/global/endpoints/openapi`, reqs: () => readText(log).split('\n').filter(Boolean).map((l) => JSON.parse(l)), stop: () => { try { child.kill(); } catch {} } };
  };

  // ---- 1: the proxy ----
  {
    const { S, env } = studio('proxy');
    const r = probe(S, `import { createVertexProxy } from ${u(S, 'harness/vertex-proxy.mjs')};
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const seen = [];
const up = http.createServer((req, res) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => { seen.push({ url: req.url, headers: req.headers, body: b }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: JSON.parse(b || '{}').model, choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1300 } })); }); });
await new Promise((r) => up.listen(0, '127.0.0.1', r));
const upBase = 'http://127.0.0.1:' + up.address().port + '/v1/projects/proj-2791a/locations/global/endpoints/openapi';
const envText = (k) => k + '=' + ${JSON.stringify(FAKE_KEY)} + '\\nVERTEX_PROJECT_ID=proj-2791a\\nSTUDIO_VERTEX_BASE_URL=' + upBase + '\\n';
fs.writeFileSync('.env', envText('VERTEX_API_KEY'));
fs.mkdirSync('.studio/agents', { recursive: true });
fs.writeFileSync('.studio/agents/vx-a.json', JSON.stringify({ agent: 'vx-a', role: 'builder', tool: 'vertex', task: 'T-7', status: 'running' }));
fs.writeFileSync('.studio/agents/claude-b.json', JSON.stringify({ agent: 'claude-b', role: 'builder', tool: 'claude', task: 'T-8', status: 'running' }));
const px = createVertexProxy({ root: process.cwd() });
await new Promise((r) => px.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + px.address().port;
const post = async (bearer, body) => { const r = await fetch(base + '/v1/chat/completions?key=leak', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + bearer }, body: JSON.stringify(body) }); return { status: r.status, text: await r.text() }; };
const ok = await post('session-vx-a', { model: 'gemini-3-flash-preview', messages: [{ role: 'user', content: 'hi' }] });
const notTag = await post(${JSON.stringify(FAKE_KEY)}, { model: 'x' });
const notVertex = await post('session-claude-b', { model: 'x' });
const nobody = await post('session-ghost', { model: 'x' });
const upCalls = seen.length;
fs.writeFileSync('.env', envText('VERTEX_API_KEY_PAUSED'));
const paused = await post('session-vx-a', { model: 'gemini-3-flash-preview' });
const health = await (await fetch(base + '/__studio/health')).json();
const usage = fs.readFileSync('.studio/vertex-usage.jsonl', 'utf8').trim().split('\\n').map((l) => JSON.parse(l));
px.close(); up.close();
const s0 = seen[0] || {};
console.log(JSON.stringify({ ok: ok.status, notTag: notTag.status, notVertex: notVertex.status, nobody: nobody.status, paused: [paused.status, JSON.parse(paused.text).error?.message], upCalls, afterPause: seen.length,
  url: s0.url, goog: s0.headers?.['x-goog-api-key'] === ${JSON.stringify(FAKE_KEY)}, auth: s0.headers?.authorization || null, tagSent: JSON.stringify(seen).includes('session-'), model: JSON.parse(s0.body || '{}').model, usage, health: health.studio,
  outputs: [ok.text, notTag.text, notVertex.text, nobody.text, paused.text].join(' ').includes(${JSON.stringify(FAKE_KEY)}) }));
`, env);
    const j = r.j || {};
    const line = j.usage?.[0] || {};
    const leaked = leaks(S);
    await guard('2.79.1 (a, 1): the studio\'s Vertex proxy maps /v1/chat/completions to <the Vertex openapi endpoint>/chat/completions (a client ?key= dropped), sends the key as x-goog-api-key and no Authorization (the session tag is never forwarded), prefixes a bare model with google/, and logs one usage line for the session with its task (in 1000 = prompt, out 300 = total - prompt: thinking is billed; usd 0.0014 at 0.50/3 per 1M); a non-tag key is 401, a session not on the proxy or not running 403; with the key renamed in .env it is 503 "paused or not configured" and Vertex is not called; the key is in no file under the studio but .env, and in no answer (fails on 2.79.0: harness/vertex-proxy.mjs does not exist)', () => [
      r.status === 0 && j.ok === 200 && j.url === '/v1/projects/proj-2791a/locations/global/endpoints/openapi/chat/completions' && j.goog === true && j.auth === null && j.tagSent === false && j.model === 'google/gemini-3-flash-preview'
        && j.usage?.length === 1 && line.session === 'vx-a' && line.task === 'T-7' && line.tool === 'vertex' && line.in === 1000 && line.out === 300 && line.total === 1300 && Math.abs(line.usd - 0.0014) < 1e-9
        && j.notTag === 401 && j.notVertex === 403 && j.nobody === 403 && j.upCalls === 1 && j.paused[0] === 503 && /paused or not configured/.test(j.paused[1] || '') && j.afterPause === 1 && j.health === 'vertex-proxy'
        && j.outputs === false && leaked.length === 0,
      JSON.stringify({ status: r.status, j, leaked, err: out(r).slice(-600) })]);
  }

  // ---- 2: agent start --tool vertex, end to end ----
  const up = await fakeVertex();
  const proxyPort = await freePort();
  let S2 = null;
  try {
    const { S, env } = studio('start', { git: true });
    S2 = S;
    const id = add(S, 'Vertex probe task', env, ['--lane', 'cartridges/vertexprobe']);
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'board', '--no-verify');
    // Nothing in .env but the key and the project (and, for this test only, where "Vertex" is and the proxy's port).
    writeIn(S, '.env', `VERTEX_API_KEY=${FAKE_KEY}\nVERTEX_PROJECT_ID=proj-2791a\nSTUDIO_VERTEX_BASE_URL=${up.base}\nSTUDIO_VERTEX_PROXY_PORT=${proxyPort}\n`);
    const rec = path.join(tmpRoot, `rec-2791a-${process.pid}`);
    fs.mkdirSync(rec, { recursive: true });
    const aiderJs = path.join(tmpRoot, `fake-aider-2791a-${process.pid}.cjs`);
    fs.writeFileSync(aiderJs, `const fs = require('fs'); const path = require('path');
const a = process.argv.slice(2); const at = (k) => a[a.indexOf(k) + 1];
(async () => {
  await new Promise((r) => setTimeout(r, 400));
  let answer = null;
  try { const r = await fetch(at('--openai-api-base') + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + at('--openai-api-key') }, body: JSON.stringify({ model: at('--model').replace(/^openai\\//, ''), messages: [{ role: 'user', content: 'hi' }] }) }); answer = r.status; } catch (e) { answer = String(e.message); }
  let laneEnv = ''; try { laneEnv = fs.readFileSync('.env', 'utf8'); } catch {}
  fs.writeFileSync(path.join(${JSON.stringify(rec)}, (process.env.STUDIO_LOCK_OWNER || 'x') + '.json'), JSON.stringify({ argv: a, cwd: process.cwd(), envHasVertexKey: Object.keys(process.env).some((k) => /^VERTEX_API_KEY$/i.test(k)), envHasValue: Object.values(process.env).some((v) => String(v).includes(${JSON.stringify(FAKE_KEY)})), openai: process.env.OPENAI_API_KEY, laneEnvHasKey: /VERTEX_API_KEY/.test(laneEnv), laneEnvHasProject: /VERTEX_PROJECT_ID/.test(laneEnv), answer }));
})();
`);
    const aider = process.platform === 'win32' ? path.join(tmpRoot, `win-aider-2791a-${process.pid}`, 'aider.cmd') : path.join(S, '.studio', 'aider-venv', 'bin', 'aider');
    fs.mkdirSync(path.dirname(aider), { recursive: true });
    if (aider.endsWith('.cmd')) fs.writeFileSync(aider, `@echo off\r\n"${process.execPath}" "${aiderJs}" %*\r\n`);
    // import(), not require(): an extensionless script inside a "type": "module" package is loaded as ESM.
    else { fs.writeFileSync(aider, `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(aiderJs).href)});\n`); fs.chmodSync(aider, 0o755); }
    // The orchestrator's chat shell: a coding agent's marker; it even asks for the key to be passed (it never is).
    const st = node(S, ['harness/agent.mjs', 'start', '--attach', '--role', 'builder', '--agent', 'vx-start', '--task', id || 'T-1', '--tool', 'vertex'], { ...env, CLAUDECODE: '1', STUDIO_AGENT_ENV_PASS: 'VERTEX_API_KEY', STUDIO_VERTEX_PROXY_PORT: String(proxyPort), ...(aider.endsWith('.cmd') ? { STUDIO_AIDER_CMD: aider } : {}) });
    let rr = null; try { rr = JSON.parse(readText(path.join(rec, 'vx-start.json'))); } catch {}
    const end = events(S).filter((e) => e.type === 'agent.session.end' && e.agent === 'vx-start').pop();
    const reqs = up.reqs();
    const tok = node(S, ['harness/tokens.mjs', '--by', 'task', '--json'], env);
    let tj = null; try { tj = JSON.parse(tok.stdout); } catch {}
    const row = tj?.byTask?.find((x) => x.name === id);
    const tokText = out(node(S, ['harness/tokens.mjs', '--by', 'task'], env));
    const budget = out(node(S, ['harness/budget.mjs'], env));
    const arg = (k) => rr?.argv?.[rr.argv.indexOf(k) + 1];
    await guard('2.79.1 (a, 2): `npm run agent -- start --tool vertex` from the orchestrator\'s shell, with only VERTEX_API_KEY and VERTEX_PROJECT_ID in .env, starts the studio\'s aider on the proxy it started on demand (--model openai/google/gemini-3-flash-preview, --openai-api-base http://127.0.0.1:<port>/v1, --openai-api-key session-vx-start); its environment has no VERTEX_API_KEY even with STUDIO_AGENT_ENV_PASS naming it (OPENAI_API_KEY is the session tag), its lane copy\'s .env has no VERTEX_API_KEY line; its request reached "Vertex" with the key as x-goog-api-key and no tag (fails on 2.79.0: "No launch command for tool vertex")', () => [
      st.status === 0 && rr && arg('--model') === 'openai/google/gemini-3-flash-preview' && arg('--openai-api-base') === `http://127.0.0.1:${proxyPort}/v1` && arg('--openai-api-key') === 'session-vx-start' && rr.argv.includes('--no-stream')
        && rr.envHasVertexKey === false && rr.envHasValue === false && rr.openai === 'session-vx-start' && rr.laneEnvHasKey === false && rr.laneEnvHasProject === true && /[\\/]\.lanes[\\/]vx-start$/.test(rr.cwd) && rr.answer === 200
        && reqs.length === 1 && reqs[0].headers['x-goog-api-key'] === FAKE_KEY && !reqs[0].headers.authorization && /\/openapi\/chat\/completions$/.test(reqs[0].url),
      JSON.stringify({ status: st.status, rr, reqs: reqs.map((x) => ({ url: x.url, auth: x.headers.authorization || null, goog: Boolean(x.headers['x-goog-api-key']) })), out: out(st).slice(-900), log: readText(path.join(S, '.studio', 'agents', 'vx-start.log')).slice(-900) })]);
    await guard('2.79.1 (a, 2): the vertex session\'s spend is recorded like the Claude API lane\'s: its agent.session.end has tokensIn 1000, tokensOut 300 (total - prompt), costUsd 0.0014 (estimated from the proxy\'s usage log), its task and key name VERTEX_API_KEY; `npm run tokens -- --by task` shows the task\'s tokens and dollars; `npm run budget` shows Vertex spend with no budget set ("measured only") (fails on 2.79.0: no vertex session, no usage log)', () => [
      end && end.task === id && end.tokensIn === 1000 && end.tokensOut === 300 && Math.abs(end.meta?.costUsd - 0.0014) < 1e-9 && end.meta?.usageFrom === 'vertex-proxy' && end.meta?.keys?.includes('VERTEX_API_KEY') && end.meta?.tool === 'vertex'
        && row && row.tokensIn === 1000 && row.tokensOut === 300 && Math.abs(row.costUsd - 0.0014) < 1e-9 && new RegExp(`${id}.*\\$0\\.0014`).test(tokText)
        && /Vertex \(all time[^)]*\): \$0\.00 over 1 request/.test(budget) && /Spend budgets: none \(spend is measured only\)/.test(budget),
      JSON.stringify({ end, row, tokText: tokText.slice(-500), budget: budget.slice(-600) })]);
    await guard('2.79.1 (a, 2): the key is written nowhere: no file under the studio (events, session log and record, kickoff, usage log, proxy log, the lane copy) but the owner\'s .env holds it, and the start command printed none of it (fails on 2.79.0: no vertex tool to start)', () => {
      const leaked = leaks(S);
      return [st.status === 0 && rr && leaked.length === 0 && !out(st).includes(FAKE_KEY) && fs.existsSync(path.join(S, '.studio', 'vertex-usage.jsonl')), JSON.stringify({ leaked })];
    });
  } finally {
    if (S2) { try { const vx = await import(pathToFileURL(path.join(S2, 'harness', 'vertex.mjs')).href); await vx.stopProxy({ root: S2, env: { STUDIO_VERTEX_PROXY_PORT: String(proxyPort) } }); } catch {} }
    up.stop();
  }

  // ---- 3: the supervisor's choice ----
  {
    const { S, env } = studio('sup', { git: true });
    const now = Date.now();
    writeIn(S, 'studio/budget.json', `${JSON.stringify({ order: ['claude'], tools: { claude: { weeklyTokens: 1000, target: 1, resetDay: 'monday' } } })}\n`);
    node(S, ['harness/task.mjs', 'drop', 'T-003', '--why', 'the template\'s seeded builder task (no lane) is not this check\'s', '--by', 'hatch'], env);
    const normal = add(S, 'Normal vertex probe', env, ['--size', '3']);
    node(S, ['harness/task.mjs', 'lane', normal || 'T-6', 'cartridges/one', '--by', 'hatch'], env); // its own lane (kept in the holds file: each pass below rewrites the events)
    writeIn(S, '.env', `VERTEX_API_KEY=${FAKE_KEY}\nVERTEX_PROJECT_ID=proj-2791a\n`);
    const aider = process.platform === 'win32' ? path.join(tmpRoot, `win-aider-sup-${process.pid}.cmd`) : path.join(S, '.studio', 'aider-venv', 'bin', 'aider');
    fs.mkdirSync(path.dirname(aider), { recursive: true });
    fs.writeFileSync(aider, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\nexit 0\n');
    if (process.platform !== 'win32') fs.chmodSync(aider, 0o755);
    const sup = (extra = {}, { over = true, running = [], pre = '' } = {}) => {
      fs.rmSync(path.join(S, '.studio', 'locks'), { recursive: true, force: true }); // each pass starts fresh (no launch lock from the last)
      fs.writeFileSync(path.join(S, '.studio', 'events.jsonl'), over ? `${JSON.stringify({ ts: new Date(now).toISOString(), type: 'agent.session.end', agent: 'builder-s1', tokensIn: 900000, tokensOut: 0, meta: { tool: 'claude' } })}\n` : '');
      return probe(S, `import { supervise } from ${u(S, 'harness/supervisor.mjs')};
${pre}
const starts = [];
const running = ${JSON.stringify(running)};
const deps = { sessions: () => running.map((a) => ({ agent: a, role: 'builder', running: true, task: 'T-0', lane: 'cartridges/elsewhere-' + a, tool: 'vertex' })), startAgent: (o) => { starts.push({ agent: o.agent, tool: o.tool, model: o.model || null }); return { ok: true }; }, launchableRoles: (r) => r.filter((x) => x === 'builder'), nextAgentName: (role, p) => p + role + '-' + (starts.length + 1) };
const r = await supervise({ watcher: true, dryRun: true, prefix: 'plan', deps }, { startedAt: Date.now(), names: [] });
console.log(JSON.stringify({ why: r.why, starts }));
`, { ...env, STUDIO_AGENT_TOOL: 'claude', ...(process.platform === 'win32' ? { STUDIO_AIDER_CMD: aider } : {}), ...extra });
    };
    const pool = { STUDIO_API_POOL: 'builder-api2', STUDIO_KEYMAP_AGENT_BUILDER_API2: 'ANTHROPIC_API_KEY:ANTHROPIC_API_KEY_LANE' };
    const high = sup(pool);
    const room = sup({}, { over: false });
    const full = sup({ STUDIO_VERTEX_SHARE: '0.01' }, { over: false, running: ['vx-1'] });
    const none = sup({ STUDIO_VERTEX_SHARE: '0' }, { over: false });
    const cut = sup(pool, { pre: `import { readUsage } from ${u(S, 'harness/vertex.mjs')}; import fs from 'node:fs';
fs.writeFileSync('.studio/spend-budgets.json', JSON.stringify({ budgets: { vertex: { usd: 1, since: null } }, history: [] }));
fs.writeFileSync('.studio/vertex-usage.jsonl', JSON.stringify({ ts: new Date().toISOString(), session: 'vx-1', tool: 'vertex', model: 'google/gemini-3-flash-preview', in: 1, out: 1, total: 2, usd: 1.5 }) + '\\n');
(await import(${u(S, 'harness/spend-budget.mjs')})).spendPass();` });
    fs.rmSync(path.join(S, '.studio', 'spend-budgets.json'), { force: true });
    // A hard task (size 4-5, or the Line Producer's hard/top tier) runs 3.1 Pro; a task handed back on Vertex goes to the plan's route.
    const hard = probe(S, `import { vertexPick } from ${u(S, 'harness/vertex.mjs')};
const ready = { ok: true };
const ev = [{ type: 'task.added', task: 'T-50', meta: { size: 5 } }, { type: 'task.added', task: 'T-51', meta: { size: 3 } }, { type: 'agent.session.end', task: 'T-52', meta: { tool: 'vertex', handed: [{ task: 'T-52' }] } }];
const p = (o) => vertexPick({ role: 'builder', cap: 4, ready, events: ev, env: {}, ...o });
console.log(JSON.stringify({ size5: p({ taskId: 'T-50' }), size3: p({ taskId: 'T-51' }), top: p({ taskId: 'T-51', tier: 'top' }), handed: p({ taskId: 'T-52' }), reviewer: p({ role: 'reviewer', taskId: 'T-51' }), own: p({ taskId: 'T-50', env: { STUDIO_VERTEX_HARD_MODEL: 'gemini-2.5-pro' } }) }));`, env);
    await guard('2.79.1 (a, 3): the supervisor starts a builder on Vertex before the paid API pool when the plan is over its target (vertex, google/gemini-3-flash-preview, a plan name, not builder-api2), and on Vertex within STUDIO_VERTEX_SHARE when the plan has headroom (default 0.5 of the slots); with Vertex at its share (one vertex builder running, 0.01) or a share of 0 the builder starts on claude; a size-5 task (or the hard tier) gets google/gemini-3.1-pro-preview (STUDIO_VERTEX_HARD_MODEL to change it), a task handed back on Vertex goes to the plan\'s route, only builders; with Vertex\'s spend budget cut the pool takes it (builder-api2) (fails on 2.79.0: the pool builder (claude) started, no vertex)', () => {
      const s = (x) => x.j?.starts || [];
      return [
        s(high).length === 1 && s(high)[0].tool === 'vertex' && s(high)[0].model === 'google/gemini-3-flash-preview' && s(high)[0].agent !== 'builder-api2'
          && s(room).length >= 1 && s(room)[0].tool === 'vertex'
          && s(full).length === 1 && s(full)[0].tool === 'claude' && s(none).length === 1 && s(none)[0].tool === 'claude'
          && hard.j?.size5?.model === 'google/gemini-3.1-pro-preview' && hard.j.size3.model === 'google/gemini-3-flash-preview' && hard.j.top.model === 'google/gemini-3.1-pro-preview' && /handed back on Vertex/.test(hard.j.handed.skip || '') && hard.j.reviewer.skip && hard.j.own.model === 'google/gemini-2.5-pro'
          && s(cut).length === 1 && s(cut)[0].agent === 'builder-api2' && s(cut)[0].tool !== 'vertex',
        JSON.stringify({ high: high.j, room: room.j, full: full.j, none: none.j, hard: hard.j, cut: cut.j, err: out(high).slice(-500) })];
    });
    void normal;
  }

  // ---- 4: spend budgets ----
  {
    const { S, env } = studio('budget', { git: true });
    const id = add(S, 'Budget probe task', env, ['--lane', 'cartridges/budget']);
    writeIn(S, '.env', `VERTEX_API_KEY=${FAKE_KEY}\nVERTEX_PROJECT_ID=proj-2791a\n`);
    const orch = { ...env, CLAUDECODE: '1' };
    const budget = (args, e = orch) => node(S, ['harness/budget.mjs', ...args], e);
    const before = budget([], env);
    const set = budget(['set', 'vertex', '10', '--by', 'opus-1', '--why', 'Hatch: cap Vertex at $10 for the test']);
    const usage = (usd) => fs.appendFileSync(path.join(S, '.studio', 'vertex-usage.jsonl'), `${JSON.stringify({ ts: new Date(Date.now() + 1000).toISOString(), session: 'vx-1', task: id, tool: 'vertex', model: 'google/gemini-3-flash-preview', in: 1, out: 1, total: 2, usd })}\n`);
    usage(8);
    budget([], env); budget([], env);
    const warns = () => events(S).filter((e) => e.type === 'budget.warn');
    const cuts = () => events(S).filter((e) => e.type === 'budget.cut');
    const notices = () => readText(path.join(S, '.studio', 'comm', 'notices.jsonl')).split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.kind === 'budget');
    const w1 = warns().length; const n1 = notices().length;
    usage(2.5);
    budget([], env); budget([], env);
    const start = node(S, ['harness/agent.mjs', 'start', '--attach', '--role', 'builder', '--agent', 'vx-cut', '--task', id || 'T-1', '--tool', 'vertex'], orch);
    const status = out(budget([], env));
    const worker = budget(['resume', 'vertex', '--by', 'builder-s3', '--why', 'Hatch said so, honest'], { ...env, STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-s3' });
    const producer = budget(['resume', 'vertex', '--by', 'producer-s1', '--why', 'Hatch said so, honest'], { ...env, STUDIO_ROLE: 'producer', STUDIO_LOCK_OWNER: 'producer-s1' });
    const noWhy = budget(['resume', 'vertex', '--by', 'opus-1']);
    const resume = budget(['resume', 'vertex', '--by', 'opus-1', '--why', 'Hatch: carry on with Vertex for today']);
    const cutAfter = probe(S, `import { cutFor } from ${u(S, 'harness/spend-budget.mjs')}; console.log(JSON.stringify({ cut: cutFor(['vertex']) }));`, env);
    const file = JSON.parse(readText(path.join(S, '.studio', 'spend-budgets.json')) || '{}');
    await guard('2.79.1 (a, 4): no spend budget by default (spend measured only); the orchestrator sets one on the owner\'s order (`budget -- set vertex 10 --by opus-1 --why "<order>"`, kept in .studio/spend-budgets.json with its history); at 75% one budget.warn to the orchestrator and one Studio Status line however many passes; at 100% one budget.cut and one line, `agent start --tool vertex` is refused with a clear line naming the budget and how to raise or resume it; a worker session, a Producer session (no STUDIO_PRODUCER_APPROVES) and a resume without the order are refused; the orchestrator\'s resume lifts the cut (fails on 2.79.0: budget -- set took no dollars; nothing paged or cut)', () => [
      /Spend budgets: none/.test(out(before)) && set.status === 0 && /vertex: spend budget \$10\.00/.test(out(set))
        && w1 === 1 && warns()[0].to === 'orchestrator' && n1 === 1 && cuts().length === 1 && cuts()[0].to === 'orchestrator' && notices().length === 2
        && start.status !== 0 && /budget stop \(vertex reached its spend budget \(\$10\.50 of \$10\.00/.test(out(start)) && /npm run budget -- set vertex <usd>/.test(out(start)) && !fs.existsSync(path.join(S, '.studio', 'agents', 'vx-cut.log'))
        && /CUT at/.test(status)
        && worker.status !== 0 && /worker/.test(out(worker)) && producer.status !== 0 && /STUDIO_PRODUCER_APPROVES/.test(out(producer)) && noWhy.status !== 0 && /--why/.test(out(noWhy))
        && resume.status === 0 && cutAfter.j?.cut === '' && file.history?.map((h) => h.action).join(',') === 'set,resume' && file.history[0].by === 'opus-1' && /cap Vertex/.test(file.history[0].why),
      JSON.stringify({ before: out(before).slice(-300), set: out(set), w1, n1, warns: warns().length, cuts: cuts().length, notices: notices().length, start: out(start).slice(-500), status: status.slice(-300), worker: out(worker), producer: out(producer), noWhy: out(noWhy), resume: out(resume), cutAfter: cutAfter.j, history: file.history })]);
    // A budget on a key name counts every session that billed it; a cut tool is passed over for the next in the order.
    const k = probe(S, `import fs from 'node:fs';
const ev = (cost) => JSON.stringify({ ts: new Date(Date.now() + 2000).toISOString(), type: 'agent.session.end', agent: 'builder-api2', task: 'T-9', tokensIn: 10, tokensOut: 10, meta: { tool: 'claude', costUsd: cost, keys: ['ANTHROPIC_API_KEY_LANE'] } }) + '\\n';
fs.appendFileSync(process.env.AGENT_EVENTS_FILE, ev(3) + ev(3));
fs.writeFileSync('studio/budget.json', JSON.stringify({ order: ['claude', 'codex'] }));
const sb = await import(${u(S, 'harness/spend-budget.mjs')});
const b = await import(${u(S, 'harness/budget.mjs')});
const r1 = await sb.budgetCommand('set', { name: 'ANTHROPIC_API_KEY_LANE', usd: '5', by: 'opus-1', why: 'Hatch: the lane key gets $5', since: 'all', env: { CLAUDECODE: '1' } });
const stopKey = b.budgetStopFor({ tool: 'claude', keys: ['ANTHROPIC_API_KEY_LANE'] });
const r2 = await sb.budgetCommand('set', { name: 'claude', usd: '1', by: 'opus-1', why: 'Hatch: the claude tool gets $1', since: 'all', env: { CLAUDECODE: '1' } });
console.log(JSON.stringify({ r1, r2, stopKey, stopOther: b.budgetStopFor({ tool: 'agy', keys: ['GEMINI_API_KEY'] }), pick: b.pickTool('claude') }));`, env);
    await guard('2.79.1 (a, 4): a budget on a key name (ANTHROPIC_API_KEY_LANE, $5) counts the dollars of every session that billed that key ($6) and cuts a session on it; a session on another key starts; a tool whose budget is cut (claude) is passed over for the next in the order (codex) (fails on 2.79.0: no spend budgets)', () => [
      k.j && k.j.r1.ok && k.j.stopKey.stopped === true && /ANTHROPIC_API_KEY_LANE reached its spend budget/.test(k.j.stopKey.why) && k.j.stopOther.stopped === false && k.j.pick === 'codex',
      JSON.stringify({ j: k.j, err: out(k).slice(-500) })]);
  }

  // ---- 5: the router and models:check ----
  {
    const { S, env } = studio('route');
    const r = probe(S, `import http from 'node:http'; import fs from 'node:fs';
const seen = [];
const up = http.createServer((req, res) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => { seen.push({ url: req.url, headers: req.headers, body: b }); if (/\\/models$/.test(req.url)) { res.writeHead(404); return res.end('{}'); } res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: 'google/gemini-3-flash-preview', choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 140 } })); }); });
await new Promise((r) => up.listen(0, '127.0.0.1', r));
process.env.VERTEX_API_KEY = ${JSON.stringify(FAKE_KEY)};
process.env.VERTEX_PROJECT_ID = 'proj-2791a';
process.env.STUDIO_VERTEX_BASE_URL = 'http://127.0.0.1:' + up.address().port + '/v1/projects/proj-2791a/locations/global/endpoints/openapi';
const route = await import(${u(S, 'harness/route.mjs')});
const cfg = await import(${u(S, 'harness/models.config.mjs')});
let res = null; try { res = await route.routeChatCompletion({ role: 'builder', customChain: ['vertex-ai-flash'], messages: [{ role: 'user', content: 'hi' }] }); } catch (e) { res = { error: e.message }; }
const chat = seen.find((x) => /chat\\/completions$/.test(x.url)) || {};
const { checkModels } = await import(${u(S, 'harness/models-check.mjs')});
const rows = await checkModels();
up.close();
const usage = fs.existsSync('.studio/vertex-usage.jsonl') ? fs.readFileSync('.studio/vertex-usage.jsonl', 'utf8').trim().split('\\n').map((l) => JSON.parse(l)) : [];
console.log(JSON.stringify({ content: res?.content ?? res?.error ?? null, goog: chat.headers?.['x-goog-api-key'] === ${JSON.stringify(FAKE_KEY)}, auth: chat.headers?.authorization || null, model: JSON.parse(chat.body || '{}').model, url: chat.url,
  chains: { builder: cfg.ROLE_CHAINS.builder.slice(0, 2), def: cfg.ROLE_CHAINS.default.slice(0, 2), auto: cfg.PRODUCER_PRESET_CHAINS.auto.slice(0, 2) },
  rows: rows.filter((x) => /^vertex-ai-/.test(x.id)), modelsAuth: seen.filter((x) => /\\/models$/.test(x.url)).map((x) => [Boolean(x.headers['x-goog-api-key']), x.headers.authorization || null]), usage }));
`, { ...env, STUDIO_DAILY_TOKEN_CAP: 'off' });
    const j = r.j || {};
    await guard('2.79.1 (a, 5): the router\'s vertex-ai-flash provider (first in the default chain, before vertex-gemini-flash; vertex-ai-pro before vertex-gemini-pro in the builder and auto chains) sends the key as x-goog-api-key with no Authorization to <base>/chat/completions with google/gemini-3-flash-preview, and its usage goes in the Vertex usage log (session router, out 40 = total - prompt) (fails on 2.79.0: no vertex-ai-* providers; the key went as a Bearer token)', () => [
      r.status === 0 && j.content === 'OK' && j.goog === true && j.auth === null && j.model === 'google/gemini-3-flash-preview' && /\/openapi\/chat\/completions$/.test(j.url || '')
        && j.chains?.builder?.join() === 'vertex-ai-pro,vertex-gemini-pro' && j.chains.def.join() === 'vertex-ai-flash,vertex-gemini-flash' && j.chains.auto.join() === 'vertex-ai-pro,vertex-gemini-pro'
        && j.usage?.length === 1 && j.usage[0].session === 'router' && j.usage[0].out === 40,
      JSON.stringify({ j, err: out(r).slice(-500) })]);
    await guard('2.79.1 (a, 5): `npm run models:check` on the Vertex endpoint: GET /models answers 404 there, which is "listed: n/a" (status n/a), not an error, asked with x-goog-api-key, never a Bearer key (fails on 2.79.0: no vertex-ai-* rows; the generativelanguage rows showed HTTP 404 as an error)', () => [
      j.rows?.length === 2 && j.rows.every((x) => x.status === 'n/a' && /listed: n\/a/.test(x.note)) && j.modelsAuth?.length === 2 && j.modelsAuth.every(([gk, a]) => gk === true && a === null),
      JSON.stringify({ rows: j.rows, modelsAuth: j.modelsAuth })]);
  }

  // ---- 6: owner-defined tools (studio/tools.json) ----
  {
    const { S, env } = studio('tools', { git: true });
    const rec = path.join(tmpRoot, `rec-tools-2791a-${process.pid}`);
    fs.mkdirSync(rec, { recursive: true });
    const toolJs = path.join(tmpRoot, `fake-tool-2791a-${process.pid}.cjs`);
    fs.writeFileSync(toolJs, `const fs = require('fs'); const path = require('path');
fs.writeFileSync(path.join(${JSON.stringify(rec)}, (process.env.STUDIO_LOCK_OWNER || 'x') + '.json'), JSON.stringify({ argv: process.argv.slice(2), keys: Object.keys(process.env).filter((k) => /_API_KEY$/.test(k)).sort() }));
`);
    const entry = { name: 'deepseek', command: `node ${JSON.stringify(toolJs)} {model} {agent}`, provider: 'DeepSeek', keyEnv: ['DEEPSEEK_API_KEY'], models: ['deepseek-chat'], prices: { 'deepseek-chat': { in: 0.27, out: 1.1 } }, roles: ['builder'] };
    const id = add(S, 'Registry probe task', env, ['--lane', 'cartridges/reg']);
    writeIn(S, 'studio/tools.json', `${JSON.stringify({ tools: [entry] }, null, 2)}\n`);
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'the owner adds deepseek', '--no-verify');
    const keys = { DEEPSEEK_API_KEY: 'ds-fake', OTHER_API_KEY: 'o-fake', ANTHROPIC_API_KEY: 'a-fake', OPENAI_API_KEY: 'op-fake', VERTEX_API_KEY: FAKE_KEY };
    const orch = { ...env, ...keys, CLAUDECODE: '1', STUDIO_WORKTREES: 'off' };
    const st = node(S, ['harness/agent.mjs', 'start', '--attach', '--role', 'builder', '--agent', 'ds-1', '--task', id || 'T-1', '--tool', 'deepseek'], orch);
    let rr = null; try { rr = JSON.parse(readText(path.join(rec, 'ds-1.json'))); } catch {}
    const startEv = events(S).filter((e) => e.type === 'agent.session.start' && e.agent === 'ds-1').pop();
    const reviewer = node(S, ['harness/agent.mjs', 'start', '--attach', '--role', 'reviewer', '--agent', 'ds-2', '--tool', 'deepseek'], orch);
    const list = out(node(S, ['harness/tool-registry.mjs', 'list'], env));
    await guard('2.79.1 (a, 6): a tool the owner committed in studio/tools.json launches for the orchestrator like a built-in tool (`agent start --tool deepseek`: its command with {model} = its first model and {agent}), its session sees only DEEPSEEK_API_KEY of the keys (not OTHER_, ANTHROPIC_, OPENAI_ or VERTEX_API_KEY), its record is tool deepseek; a role its entry doesn\'t allow is refused; `npm run tools` lists it (fails on 2.79.0: "No launch command for tool deepseek")', () => [
      st.status === 0 && rr && rr.argv[0] === 'deepseek-chat' && rr.argv[1] === 'ds-1' && JSON.stringify(rr.keys) === '["DEEPSEEK_API_KEY"]' && startEv?.meta?.tool === 'deepseek'
        && reviewer.status !== 0 && /runs builder sessions, not reviewer/.test(out(reviewer)) && /deepseek: DeepSeek; roles builder; keys DEEPSEEK_API_KEY/.test(list),
      JSON.stringify({ status: st.status, rr, startEv: startEv?.meta, out: out(st).slice(-600), reviewer: out(reviewer).slice(-300), list })]);
    // An agent's commit of the file doesn't count.
    writeIn(S, 'studio/tools.json', `${JSON.stringify({ tools: [{ ...entry, keyEnv: ['DEEPSEEK_API_KEY', 'OTHER_API_KEY'] }] }, null, 2)}\n`);
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'opus-1 widens deepseek', '-m', 'Studio-Agent: opus-1', '--no-verify');
    const agentMade = node(S, ['harness/agent.mjs', 'start', '--attach', '--role', 'builder', '--agent', 'ds-3', '--task', id || 'T-1', '--tool', 'deepseek'], orch);
    await guard('2.79.1 (a, 6): studio/tools.json committed by an agent (a Studio-Agent trailer) doesn\'t count: the tool isn\'t launched, and the refusal says why (only the owner defines tools) (fails on 2.79.0: no registry; nothing said why)', () => [
      agentMade.status !== 0 && /doesn't count: commit [0-9a-f]{8} that set studio\/tools\.json is the agent opus-1's/.test(out(agentMade)) && !fs.existsSync(path.join(rec, 'ds-3.json')),
      out(agentMade).slice(-600)]);
  }
  {
    // Owner key + beta mode with the orchestrator (opus-1) named: the orchestrator's approval of a tools.json change is refused.
    const { S, env } = studio('tools-own', { git: true });
    const keyFile = path.join(tmpRoot, `2791a-owner-${process.pid}.pem`);
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    writeIn(S, 'studio/keys/owner-ed25519.pub.pem', publicKey.export({ type: 'spki', format: 'pem' }));
    writeIn(S, 'studio/beta.json', `${JSON.stringify({ on: true, by: 'pat', at: '2026-11-05T01:00:00.000Z', why: 'beta for the selftest', agents: ['opus-1'], roles: ['producer', 'director'] }, null, 2)}\n`);
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'owner key, beta on', '--no-verify');
    writeIn(S, 'studio/tools.json', `${JSON.stringify({ tools: [{ name: 'deepseek', command: 'node x.js {model}', provider: 'DeepSeek', keyEnv: ['DEEPSEEK_API_KEY'], models: ['deepseek-chat'], roles: ['builder'] }] }, null, 2)}\n`);
    const apprDir = path.join(S, 'studio', 'approvals');
    const count = () => (fs.existsSync(apprDir) ? fs.readdirSync(apprDir).length : 0);
    const orchAppr = node(S, ['harness/approve.mjs', 'protected', '--note', 'opus-1 adds deepseek for the owner', '--by', 'opus-1'], { ...env, CLAUDECODE: '1' });
    const afterOrch = count();
    g(S, 'add', 'studio/tools.json'); g(S, 'commit', '-qm', 'the owner adds deepseek', '--no-verify');
    const reg = (S0) => probe(S0, `import { readRegistry } from ${u(S0, 'harness/tool-registry.mjs')}; const r = readRegistry({ fresh: true }); console.log(JSON.stringify({ trusted: r.trusted, tools: Object.keys(r.tools), why: r.why }));`, env);
    const unsigned = reg(S);
    const ownerAppr = node(S, ['harness/approve.mjs', 'protected', '--note', 'the owner adds deepseek', '--by', 'pat'], { ...env, STUDIO_OWNER_KEY: keyFile });
    const signed = reg(S);
    await guard('2.79.1 (a, 6): defining a tool is the owner\'s own: in beta mode the orchestrator\'s `approve -- protected` of a studio/tools.json change is refused, naming the owner-only act, and writes no approval; with the file committed and no owner-signed approval it doesn\'t count; the owner\'s own signed approval (owner key) makes it count (fails on 2.79.0: studio/tools.json was neither protected nor owner-only, so `approve -- protected` saw no protected change, and no registry judged it)', () => [
      orchAppr.status !== 0 && /defining or changing an owner tool/.test(out(orchAppr)) && afterOrch === 0
        && unsigned.j?.trusted === false && /no approval signed with it/.test(unsigned.j.why) && ownerAppr.status === 0 && signed.j?.trusted === true && signed.j.tools.join() === 'deepseek',
      JSON.stringify({ orch: out(orchAppr).slice(-500), afterOrch, unsigned: unsigned.j, owner: out(ownerAppr).slice(-400), signed: signed.j || out(signed).slice(-400) })]);
    try { fs.rmSync(keyFile, { force: true }); } catch {}
  }
}
