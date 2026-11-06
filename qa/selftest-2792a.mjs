/**
 * qa/selftest-2792a.mjs — 2.79.2 (a): the launcher runs the builder protocol around aider (harness/aider-protocol.mjs), and
 * a Vertex request over STUDIO_VERTEX_MAX_PROMPT_TOKENS stops its session.
 *   1  the edit brief has the task and lane and no harness command; the ignore lines keep the map to the lane and leave
 *      out a tracked file over STUDIO_AIDER_MAX_FILE_KB unless the lane names it (pure).
 *   2  `agent start --tool aider` (a stand-in aider that edits the lane's file): the task is claimed before aider starts,
 *      aider gets the edit brief, --file <lane file>, --map-tokens and the lane's ignore file; the launcher commits the
 *      change with the Studio-Task / Studio-Agent trailers, runs the check and queues the lane; the session end says so.
 *   3  a stand-in that changes nothing: handed back (handBackCause no-change) with aider's last line, said on the session end.
 *   4  a change whose check fails (a bug task with no recorded verify): committed, then handed back (red) with the unmet item.
 *   5  --tool vertex with a fake "Vertex" answering 400,000 prompt tokens: the proxy refuses the session's next request, the
 *      launcher hands the task back (prompt-cap), the session end says so and vertexFailures counts it.
 * Stand-ins only (a node script as aider, a fake Vertex on 127.0.0.1): no real aider, key or network.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const FAKE_KEY = 'fake-vertex-key-for-selftest-2792a';

export async function selftest2792A({ dir, report, tmpRoot, root }) {
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
    STUDIO_TEST_FREEMEM_MB: '32000', STUDIO_LINE_PRODUCER: 'off', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-2792a-${process.pid}.pem`), STUDIO_TAKEOVER: 'off', STUDIO_NIM_CHECK: 'off', STUDIO_TRAIN_AUTO: 'off',
    CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', GITHUB_BASE_REF: '', CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '', STUDIO_MAIN_ROOT: '', STUDIO_ROLE: '', STUDIO_LOCK_OWNER: '', STUDIO_HOOKS_CHECK: 'off', PYTHONUNBUFFERED: '', PYTHONIOENCODING: '',
  };
  let n = 0;
  const studio = (name) => {
    const S = path.join(tmpRoot, `2792a-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    for (const rel of ['.studio', '.env', 'studio/task-holds.json', 'studio/approvals', 'studio/keys', 'studio/beta.json', 'studio/tools.json']) fs.rmSync(path.join(S, rel), { recursive: true, force: true });
    writeIn(S, '.studio/events.jsonl', '');
    writeIn(S, '.gitignore', `${readText(path.join(dir, '.gitignore'))}\n/.lanes/\n/.studio/\n.env\n`);
    g(S, 'init', '-q', '-b', 'main'); g(S, 'config', 'core.autocrlf', 'false'); g(S, 'config', 'core.eol', 'lf');
    g(S, 'config', 'user.name', 't'); g(S, 'config', 'user.email', 't@example.invalid');
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
    return { S, env: { ...base, AGENT_EVENTS_FILE: path.join(S, '.studio', 'events.jsonl') } };
  };
  const node = (S, args, env, timeout = 300000) => spawnSync(process.execPath, args, { windowsHide: true, cwd: S, encoding: 'utf8', env: { ...process.env, ...ident, ...env }, timeout });
  const probe = (S, code, env) => { const f = path.join(S, `.probe-2792a-${++n}.mjs`); fs.writeFileSync(f, code); const r = node(S, [f], env); fs.rmSync(f, { force: true }); const l = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop(); let j = null; try { j = JSON.parse(l); } catch {} return { ...r, j }; };
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  const events = (S) => readText(path.join(S, '.studio', 'events.jsonl')).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const add = (S, title, env, extra = []) => (out(node(S, ['harness/task.mjs', 'add', title, '--role', 'builder', '--priority', 'P1', ...extra], env)).match(/"id":\s*"([A-Z]+-\d+)"/) || [])[1] || null;

  // ---- the stand-in aider: records its argv, whether its task was claimed before it ran, its message and ignore file;
  // by its agent's name: edit-* writes the lane file, none-* changes nothing, cap-* makes two requests to its API base.
  const rec = path.join(tmpRoot, `rec-2792a-${process.pid}`);
  fs.mkdirSync(rec, { recursive: true });
  const aiderJs = path.join(tmpRoot, `fake-aider-2792a-${process.pid}.cjs`);
  fs.writeFileSync(aiderJs, `const fs = require('fs'); const path = require('path');
const a = process.argv.slice(2); const at = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : null);
const me = process.env.STUDIO_LOCK_OWNER || 'x';
const main = process.env.STUDIO_MAIN_ROOT || process.cwd();
const ev = (() => { try { return fs.readFileSync(path.join(main, '.studio', 'events.jsonl'), 'utf8'); } catch { return ''; } })();
const claimed = ev.split('\\n').filter(Boolean).some((l) => { try { const e = JSON.parse(l); return e.type === 'task.start' && e.agent === me; } catch { return false; } });
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
(async () => {
  const mode = me.split('-')[0];
  const answers = [];
  if (mode === 'edit' || mode === 'red') { fs.mkdirSync('cartridges/example-sim', { recursive: true }); fs.writeFileSync('cartridges/example-sim/notes.mjs', 'export const NOTE = 1;\\n'); console.log('Applied edit to cartridges/example-sim/notes.mjs'); }
  if (mode === 'none') console.log('Nothing in these files needs a change.');
  if (mode === 'cap') {
    for (let i = 0; i < 2; i++) {
      try { const r = await fetch(at('--openai-api-base') + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + at('--openai-api-key') }, body: JSON.stringify({ model: 'gemini-3-flash-preview', messages: [{ role: 'user', content: 'hi' }] }) }); answers.push(r.status); } catch (e) { answers.push(String(e.message)); }
    }
    console.log('litellm.PermissionDeniedError: the second request was refused');
  }
  fs.writeFileSync(path.join(${JSON.stringify(rec)}, me + '.json'), JSON.stringify({ argv: a, cwd: process.cwd(), claimed, msg: read(at('--message-file')), ign: read(at('--aiderignore')), answers }));
})();
`);
  const makeAider = (S) => {
    const f = process.platform === 'win32' ? path.join(tmpRoot, `win-aider-2792a-${process.pid}-${++n}`, 'aider.cmd') : path.join(S, '.studio', 'aider-venv', 'bin', 'aider');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (f.endsWith('.cmd')) fs.writeFileSync(f, `@echo off\r\n"${process.execPath}" "${aiderJs}" %*\r\n`);
    // import(), not require(): an extensionless script inside a "type": "module" package is loaded as ESM.
    else { fs.writeFileSync(f, `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(aiderJs).href)});\n`); fs.chmodSync(f, 0o755); }
    return f.endsWith('.cmd') ? { STUDIO_AIDER_CMD: f } : {};
  };
  const recOf = (agent) => { try { return JSON.parse(readText(path.join(rec, `${agent}.json`))); } catch { return null; } };
  const endOf = (S, agent) => events(S).filter((e) => e.type === 'agent.session.end' && e.agent === agent).pop() || null;
  const pausedOf = (S, id) => events(S).filter((e) => e.type === 'task.paused' && e.task === id).pop() || null;
  const HARNESS_CMD = /npm run|node harness\/|harness\/task\.mjs|task (start|done|pause) T-/;

  // ---- 1: the edit brief and the ignore lines (pure) ----
  {
    const { S, env } = studio('pure');
    writeIn(S, 'cartridges/example-sim/big.json', `${'x'.repeat(300 * 1024)}\n`);
    writeIn(S, 'cartridges/example-sim/named-big.json', `${'y'.repeat(300 * 1024)}\n`);
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'big files', '--no-verify');
    const r = probe(S, `import { editBrief, laneIgnoreLines, laneFiles } from ${u(S, 'harness/aider-protocol.mjs')};
const brief = '# Focus: T-9\\n\\n## What this task is, and what others left on it\\n~~~~text\\nTask title (T-9):\\n| Add a note\\n~~~~\\n\\n## Done means\\nA build change.\\n\\n## Steps (studio/skills/builder.md)\\n1. Run npm run verify first.\\n2. Make the smallest edit that could work.\\n\\n## Finish or hand back\\n\\x60\\x60\\x60bash\\nnode harness/task.mjs done T-9 --agent a\\n\\x60\\x60\\x60\\n';
const msg = editBrief({ task: 'T-9', title: 'Add a note', brief, lanePaths: ['cartridges/example-sim/notes.mjs'], files: ['cartridges/example-sim/notes.mjs'] });
const folder = laneIgnoreLines({ cwd: process.cwd(), lanePaths: ['cartridges/example-sim', 'cartridges/example-sim/named-big.json'] });
const none = laneIgnoreLines({ cwd: process.cwd(), lanePaths: [] });
console.log(JSON.stringify({ msg, folder, none, files: laneFiles({ cwd: process.cwd(), lanePaths: ['cartridges/example-sim', 'cartridges/example-sim/new.mjs#part'] }) }));`, env);
    const j = r.j || {};
    await guard('2.79.2 (a, 1): the edit brief aider gets names the task and its lane, says not to run commands, keeps the brief\'s "done means" and edit steps, and has no harness command (no npm run, node harness/…, task done); the ignore lines keep the repo map to the lane (/* then the lane re-included) and leave out a tracked file over STUDIO_AIDER_MAX_FILE_KB (200) unless the lane names it, with or without a lane; a lane\'s files (not its folders) go to --file (fails on 2.79.1: harness/aider-protocol.mjs does not exist: aider got the full kickoff with the harness\'s commands and the whole repo)', () => [
      r.status === 0 && /T-9/.test(j.msg) && /cartridges\/example-sim\/notes\.mjs/.test(j.msg) && /Do not run commands/.test(j.msg) && /A build change/.test(j.msg) && /smallest edit/.test(j.msg) && !HARNESS_CMD.test(j.msg)
        && j.folder?.[0] === '/*' && j.folder.includes('!/cartridges/') && j.folder.includes('/cartridges/*') && j.folder.includes('!/cartridges/example-sim/') && j.folder.includes('/cartridges/example-sim/big.json') && !j.folder.includes('/cartridges/example-sim/named-big.json')
        && !j.none?.includes('/*') && j.none?.includes('/cartridges/example-sim/big.json')
        && JSON.stringify(j.files) === JSON.stringify(['cartridges/example-sim/new.mjs']),
      JSON.stringify({ status: r.status, j, err: out(r).slice(-800) })]);
  }

  // ---- 2-4: `agent start --tool aider` end to end ----
  {
    const { S, env } = studio('drive');
    const lane = ['--lane', 'cartridges/example-sim/notes.mjs'];
    const ids = { edit: add(S, 'Add a note constant to example-sim', env, lane), none: add(S, 'Tidy the note constant in example-sim', env, lane), red: add(S, 'Fix the note value bug in example-sim', env, [...lane, '--type', 'bug']) };
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'board', '--no-verify');
    const viaCmd = makeAider(S);
    const start = (agent, id) => node(S, ['harness/agent.mjs', 'start', '--attach', '--role', 'builder', '--agent', agent, '--task', id || 'T-1', '--tool', 'aider'], { ...env, ...viaCmd });
    const se = start('edit-1', ids.edit);
    const sn = start('none-1', ids.none);
    const sr = start('red-1', ids.red);
    const re = recOf('edit-1');
    const arg = (r, k) => r?.argv?.[r.argv.indexOf(k) + 1];
    const ee = endOf(S, 'edit-1');
    const body = g(S, 'log', '--all', '-1', '--format=%B', `--grep=^Studio-Task: ${ids.edit}`).stdout || '';
    let queue = [];
    try { queue = JSON.parse(readText(path.join(S, '.studio', 'train', 'queue.json'))); } catch {}
    await guard('2.79.2 (a, 2): `agent start --tool aider` on a builder task in its lane copy: the launcher claims the task before aider starts (task.start by the agent is in the events when aider runs), aider\'s --message-file is the short edit brief (no harness command), with --file <the lane file>, --map-tokens and an ignore file that whitelists the lane; after aider edits the file the launcher commits it on the lane branch with Studio-Task and Studio-Agent trailers, the check passes and the lane is queued for the merge train; agent.session.end (status ok) says "queued" in its message and meta.aider (fails on 2.79.1: aider got the kickoff, nothing claimed it, nothing was committed: "no work on T-…: it never claimed")', () => [
      se.status === 0 && re && re.claimed === true && /Edit task/.test(re.msg) && !HARNESS_CMD.test(re.msg) && arg(re, '--file') === 'cartridges/example-sim/notes.mjs' && /^\d+$/.test(arg(re, '--map-tokens') || '') && /^\/\*$/m.test(re.ign) && /^!\/cartridges\/example-sim\/notes\.mjs$/m.test(re.ign)
        && new RegExp(`Studio-Task: ${ids.edit}`).test(body) && /Studio-Agent: edit-1/.test(body)
        && Array.isArray(queue) && queue.some((q) => q.task === ids.edit)
        && ee && ee.status === 'ok' && ee.meta?.aider?.result === 'queued' && ee.meta.aider.committed && /queued for the merge train/.test(ee.msg) && !/never claimed/.test(ee.msg),
      JSON.stringify({ status: se.status, rec: re && { argv: re.argv, claimed: re.claimed, msg: re.msg.slice(0, 300) }, body, queue, end: ee && { status: ee.status, msg: ee.msg, aider: ee.meta?.aider }, out: out(se).slice(-600), log: readText(path.join(S, '.studio', 'agents', 'edit-1.log')).slice(-900) })]);
    const en = endOf(S, 'none-1');
    const pn = pausedOf(S, ids.none);
    const hn = readText(path.join(S, 'studio', 'handoffs', `${ids.none}.md`));
    await guard('2.79.2 (a, 3): a stand-in aider that changes nothing: the launcher had claimed the task, then hands it back (task.paused with handBackCause no-change) with a note quoting aider\'s last line; agent.session.end lists it in meta.handed, meta.aider.cause no-change, and its message says the launcher claimed it and aider changed no file (never "it never claimed") (fails on 2.79.1: nothing claimed, the end said "no work on T-…: it never claimed T-… (no task start ran in the session)")', () => [
      sn.status === 0 && recOf('none-1')?.claimed === true && pn && pn.agent === 'none-1' && pn.meta?.handBackCause === 'no-change' && /Nothing in these files needs a change/.test(hn) && /aider changed no file/.test(hn)
        && en && en.meta?.aider?.cause === 'no-change' && (en.meta.handed || []).some((h) => h.task === ids.none) && /claimed .* for aider/.test(en.msg) && /changed no file/.test(en.msg) && !/never claimed/.test(en.msg),
      JSON.stringify({ status: sn.status, paused: pn && { agent: pn.agent, meta: pn.meta }, handoff: hn.slice(-700), end: en && { msg: en.msg, aider: en.meta?.aider, handed: en.meta?.handed }, out: out(sn).slice(-500) })]);
    const er = endOf(S, 'red-1');
    const pr = pausedOf(S, ids.red);
    const hr = readText(path.join(S, 'studio', 'handoffs', `${ids.red}.md`));
    const redCommit = g(S, 'log', '--all', '-1', '--format=%H', `--grep=^Studio-Task: ${ids.red}`).stdout.trim();
    await guard('2.79.2 (a, 4): a change whose check fails (a bug task: no verify recorded): the launcher commits it (Studio-Task trailer), runs the check, and hands the task back (handBackCause red) with the check\'s unmet item in the note; nothing is queued; agent.session.end says "handed back (red)" and the check failed (fails on 2.79.1: nothing claimed or committed, no check ran)', () => {
      let queue2 = [];
      try { queue2 = JSON.parse(readText(path.join(S, '.studio', 'train', 'queue.json'))); } catch {}
      return [sr.status === 0 && redCommit && pr && pr.meta?.handBackCause === 'red' && /check failed: \[ \]/.test(hr) && !queue2.some((q) => q.task === ids.red)
        && er && er.meta?.aider?.cause === 'red' && er.meta.aider.check === 'fail' && /handed back \(red\)/.test(er.msg) && (er.meta.handed || []).some((h) => h.task === ids.red),
      JSON.stringify({ status: sr.status, redCommit, paused: pr && pr.meta, handoff: hr.slice(-900), end: er && { msg: er.msg, aider: er.meta?.aider }, out: out(sr).slice(-500) })];
    });
  }

  // ---- 5: the prompt-token cap on the Vertex proxy ----
  const fakeJs = path.join(tmpRoot, `fake-vertex-2792a-${process.pid}.cjs`);
  fs.writeFileSync(fakeJs, `const http = require('http'); const fs = require('fs');
const [port, log] = process.argv.slice(2);
http.createServer((req, res) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
  fs.appendFileSync(log, JSON.stringify({ method: req.method, url: req.url }) + '\\n');
  let model = null; try { model = JSON.parse(b).model; } catch {}
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'x', model, choices: [{ index: 0, message: { role: 'assistant', content: 'OK' } }], usage: { prompt_tokens: 400000, completion_tokens: 50, total_tokens: 400100 } }));
}); }).listen(Number(port), '127.0.0.1');
setTimeout(() => process.exit(0), 240000);
`);
  const upPort = await freePort();
  const upLog = path.join(tmpRoot, `fake-vertex-2792a-${process.pid}.jsonl`);
  const up = spawn(process.execPath, [fakeJs, String(upPort), upLog], { windowsHide: true, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { await new Promise((r) => setTimeout(r, 100)); if (await new Promise((res) => { const s = net.connect(upPort, '127.0.0.1'); s.on('connect', () => { s.destroy(); res(true); }); s.on('error', () => res(false)); })) break; }
  const proxyPort = await freePort();
  let S5 = null;
  try {
    const { S, env } = studio('cap');
    S5 = S;
    const id = add(S, 'Add a note constant to example-sim', env, ['--lane', 'cartridges/example-sim/notes.mjs']);
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'board', '--no-verify');
    writeIn(S, '.env', `VERTEX_API_KEY=${FAKE_KEY}\nVERTEX_PROJECT_ID=proj-2792a\nSTUDIO_VERTEX_BASE_URL=http://127.0.0.1:${upPort}/v1/projects/proj-2792a/locations/global/endpoints/openapi\nSTUDIO_VERTEX_PROXY_PORT=${proxyPort}\n`);
    const viaCmd = makeAider(S);
    const st = node(S, ['harness/agent.mjs', 'start', '--attach', '--role', 'builder', '--agent', 'cap-1', '--task', id || 'T-1', '--tool', 'vertex'], { ...env, ...viaCmd, STUDIO_VERTEX_PROXY_PORT: String(proxyPort) });
    const rr = recOf('cap-1');
    const upCalls = readText(upLog).split('\n').filter(Boolean).length;
    const end = endOf(S, 'cap-1');
    const pc = pausedOf(S, id);
    const vf = probe(S, `import { vertexFailures } from ${u(S, 'harness/vertex.mjs')}; import { readRecentEvents } from ${u(S, 'harness/event.mjs')};
console.log(JSON.stringify({ n: vertexFailures(${JSON.stringify(id)}, readRecentEvents(20000)) }));`, env);
    await guard('2.79.2 (a, 5): a vertex session whose request carried 400,000 prompt tokens (over STUDIO_VERTEX_MAX_PROMPT_TOKENS, 150,000): the proxy forwards that one request and answers the session\'s next one 403 without calling Vertex; the launcher hands the task back (handBackCause prompt-cap) without committing, agent.session.end says prompt-cap (reason and meta.aider), and vertexFailures counts the hand-back, so the plan\'s route takes the task next (fails on 2.79.1: both requests reached Vertex, nothing stopped the session or handed the task back)', () => [
      st.status === 0 && rr && rr.claimed === true && JSON.stringify(rr.answers) === '[200,403]' && upCalls === 1
        && pc && pc.meta?.handBackCause === 'prompt-cap' && end && /prompt-cap/.test(end.meta?.reason || '') && end.meta?.aider?.cause === 'prompt-cap' && /STUDIO_VERTEX_MAX_PROMPT_TOKENS/.test(end.msg) && end.tokensIn === 400000
        && vf.j?.n === 1,
      JSON.stringify({ status: st.status, answers: rr?.answers, claimed: rr?.claimed, upCalls, paused: pc?.meta, end: end && { msg: end.msg, reason: end.meta?.reason, aider: end.meta?.aider, tokensIn: end.tokensIn }, vf: vf.j, out: out(st).slice(-600), log: readText(path.join(S, '.studio', 'agents', 'cap-1.log')).slice(-900) })]);
  } finally {
    if (S5) { try { const vx = await import(pathToFileURL(path.join(S5, 'harness', 'vertex.mjs')).href); await vx.stopProxy({ root: S5, env: { STUDIO_VERTEX_PROXY_PORT: String(proxyPort) } }); } catch {} }
    try { up.kill(); } catch {}
  }
}
