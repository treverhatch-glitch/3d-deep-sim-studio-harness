/**
 * qa/selftest-284w.mjs — 2.84 (w, B-133): the reviewer's route.
 *
 * A crew's cross-family review was planned on a Vertex model (google/gemini-...) and launched on the claude tool: exit 1,
 * four times, and the supervisor halted twice. A Vertex session (aider) cannot run `review record` anyway, so no
 * cross-family review happened all day. Now one function says which tool runs a model id (harness/model-tool.mjs), a launch
 * whose tool cannot run its model is refused before a process starts, a non-builder role's launch crashes back that role
 * off instead of halting the supervisor, and the harness can ask a model for a review itself (`npm run review -- ask`,
 * harness/review-ask.mjs). Every model call here goes to a stand-in (an injected function or fetch); none to the network.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest284W({ dir, report, tmpRoot }) {
  const guard = async (name, fn) => { try { const [ok, d] = await fn(); report(name, Boolean(ok), ok ? '' : String(d || '').slice(0, 3000)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 3000)); } };
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const win = process.platform === 'win32';
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, args) => spawnSync('git', args, { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI|VERTEX)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_VERIFY_DETACH: 'off',
    STUDIO_HEAVY_SLOTS: '0', STUDIO_HOOKS_CHECK: 'off', STUDIO_DRIFT: 'off', STUDIO_MACHINE_SCAN: 'off', STUDIO_LANELESS: 'shared', STUDIO_UPGRADE_WATCH_MIN: 'off', STUDIO_RAM_FLOOR_GB: '0',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-284w-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '', npm_config_node_options: '',
  };
  let n = 0;
  const now0 = new Date().toISOString();
  const studio = (name, { dotenv = '' } = {}) => {
    const S = path.join(tmpRoot, `284w-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    fs.rmSync(path.join(S, 'studio', 'models.json'), { force: true });
    fs.rmSync(path.join(S, 'studio', 'review.json'), { force: true });
    fs.writeFileSync(path.join(S, '.env'), dotenv);
    const ev = path.join(S, '.studio', 'events-284w.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true });
    fs.writeFileSync(ev, `${JSON.stringify({ id: 'evt_284w_1', ts: now0, type: 'task.start', agent: 'builder-w1', task: 'T-101', model: 'claude-opus-5-5' })}\n`);
    fs.writeFileSync(path.join(S, 'studio', 'NEXT.md'), ['# Studio Task Queue (`studio/NEXT.md`)', '', '## IN_PROGRESS', '- [ ] **T-101** [P1] (`builder`) — Add a rules toggle to the sim', '', '## BACKLOG', '- [ ] **T-102** [P1] (`reviewer`) — Review T-101: read its change and write the review', '- [ ] **T-103** [P1] (`builder`) — Add a second rules toggle', '', '## DONE', ''].join('\n'));
    g(S, ['init', '-q', '-b', 'main']); g(S, ['config', 'core.autocrlf', 'false']);
    g(S, ['add', '-A']); g(S, ['commit', '-qm', 'studio', '--no-verify']);
    fs.mkdirSync(path.join(S, 'game', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(S, 'game', 'rules', 'toggle.mjs'), 'export const toggle = (s) => ({ ...s, on: !s.on });\n');
    g(S, ['add', '-A']); g(S, ['commit', '-qm', 'Add a rules toggle\n\nStudio-Task: T-101\nStudio-Model: claude-opus-5-5', '--no-verify']);
    return { S, ev, env: { ...base, AGENT_EVENTS_FILE: ev } };
  };
  const events = (ev) => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  const probe = (S, env, code) => {
    const f = path.join(tmpRoot, `probe-284w-${process.pid}-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 240000 });
    const t = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(t), _err: String(r.stderr || '').slice(-1500) }; } catch { return { _err: out(r).slice(-2500) }; }
  };
  const has = (f) => fs.existsSync(f);
  // A PATH with git and without the agent tools: a launch that wrongly started claude would find nothing to run.
  const gitDir = path.dirname(String(spawnSync(win ? 'where' : 'which', ['git'], { windowsHide: true, encoding: 'utf8' }).stdout || '').split(/\r?\n/)[0].trim() || (win ? 'C:\\Windows' : '/usr/bin'));
  const modelTool = path.join(dir, 'harness', 'model-tool.mjs');

  // ---- 1. which tool runs a model id ----
  await guard('2.84 (w): one function says which tool runs a model id: a studio/models.json pool first (it may pin a bare Gemini id to vertex), then the shape of the id (google/... -> vertex, agy-/gemini- -> agy, gpt-/o3 -> codex, claude-/opus -> claude); an id no tool is known for gets one line saying so (fails before this fix: there was no such function, and agent.mjs modelFamilyTool gave a google/... id no tool, so the default claude ran it)', async () => {
    if (!has(modelTool)) return [false, 'harness/model-tool.mjs is missing'];
    const { toolForModel } = await import(pathToFileURL(modelTool).href);
    const pools = { pools: { house: { tool: 'vertex', model: 'gemini-2.5-pro' }, odd: { tool: 'codex', model: 'house-model-x' } } };
    const r = {
      pool: toolForModel('gemini-2.5-pro', { env: {}, models: pools }), poolOdd: toolForModel('house-model-x', { env: {}, models: pools }),
      vertex: toolForModel('google/gemini-3.1-pro-preview', { env: {} }).tool, agy: toolForModel('gemini-4-argon-high', { env: {} }).tool, agy2: toolForModel('agy-flash', { env: {} }).tool,
      codex: toolForModel('gpt-5', { env: {} }).tool, o3: toolForModel('o3-mini', { env: {} }).tool, claude: toolForModel('claude-opus-5-5', { env: {} }).tool, opus: toolForModel('opus', { env: {} }).tool,
      setting: toolForModel('gemini-3-flash-preview', { env: { STUDIO_REVIEW_TOOLS: 'vertex:gemini-3-flash-preview' } }), unknown: toolForModel('deepseek-chat', { env: {} }),
    };
    const ok = r.pool.tool === 'vertex' && r.pool.from === 'pool' && r.poolOdd.tool === 'codex' && r.vertex === 'vertex' && r.agy === 'agy' && r.agy2 === 'agy' && r.codex === 'codex' && r.o3 === 'codex'
      && r.claude === 'claude' && r.opus === 'claude' && r.setting.tool === 'vertex' && r.setting.from === 'setting' && r.unknown.tool === null && /no tool is known to run deepseek-chat/.test(r.unknown.why);
    return [ok, JSON.stringify(r)];
  });

  // ---- 2. a reviewer plan on a Gemini-shaped id never launches claude ----
  await guard('2.84 (w, B-133): a reviewer task whose plan picks a Vertex model (google/gemini-..., another family than the Claude builder) is never launched on claude, even when the supervisor passes its default tool claude: the model\'s tool is vertex, which cannot run commands, so no session starts and the launcher says the harness asks instead (fails before this fix: the reviewer started as claude/google/gemini-..., exit 1 at launch)', async () => {
    const { S, env } = studio('route');
    const r = probe(S, { ...env, STUDIO_VERTEX_HARD_MODEL: 'google/gemini-3.1-pro-preview', STUDIO_REVIEWER_TOOL: 'claude', PATH: gitDir }, `
import fs from 'node:fs'; import path from 'node:path';
import { startAgent, reviewerRoute } from ${u(S, 'harness/agent.mjs')};
const r = {};
try { r.route = reviewerRoute({ plan: { model: 'google/gemini-3.1-pro-preview' }, tool: 'claude', env: {} }); } catch (e) { r.route = { err: e.message }; }
const res = startAgent({ role: 'reviewer', agent: 'reviewer-w1', task: 'T-102', tool: 'claude', toolDefault: true }, { detach: true });
r.res = { ok: res.ok, tool: res.tool || null, model: res.model || null, message: res.message || '', asked: res.asked ?? null };
r.session = fs.existsSync(path.join('.studio', 'agents', 'reviewer-w1.json'));
console.log(JSON.stringify(r));`);
    const ok = r.route?.tool === 'vertex' && r.route.ask === true && r.res?.ok === false && r.res.tool !== 'claude' && /vertex cannot run commands/.test(r.res.message) && /google\/gemini-3\.1-pro-preview/.test(r.res.message) && r.session === false;
    return [ok, JSON.stringify(r)];
  });

  // ---- 3. a mismatched --tool/--model by hand is refused before any process starts ----
  await guard('2.84 (w): `agent start --tool claude --model google/gemini-...` given by hand is refused before any process starts, with one line naming the tool that model needs (vertex); no session record and no agent.session.start (fails before this fix: the launcher started claude with the Gemini id and it exited 1)', async () => {
    const { S, env, ev } = studio('hand');
    const r = spawnSync(process.execPath, ['harness/agent.mjs', 'start', '--attach', '--role', 'builder', '--agent', 'builder-w9', '--tool', 'claude', '--model', 'google/gemini-3.1-pro-preview', '--task', 'T-103'], { windowsHide: true, cwd: S, encoding: 'utf8', env: { ...process.env, ...env, PATH: gitDir }, timeout: 120000 });
    const evs = events(ev);
    const started = evs.some((e) => e.type === 'agent.session.start' && e.agent === 'builder-w9');
    const line = out(r).split('\n').find((l) => /runs on the vertex tool, not claude/.test(l)) || '';
    const ok = r.status !== 0 && line && /--tool vertex/.test(line) && !started && !has(path.join(S, '.studio', 'agents', 'builder-w9.json'));
    return [ok, `exit ${r.status}; started ${started}; ${out(r).slice(-1500)}`];
  });

  // ---- 4. a failing launch of one role does not halt the supervisor ----
  await guard('2.84 (w, B-133): two reviewer sessions in a row that crash at launch with exit 1 (a stand-in reviewer command) do not halt the supervisor pass: the reviewer role is backed off (a supervisor.role_backoff event, a "backed off" reason for reviewer starts) and the pass goes on for the other roles (fails before this fix: "two sessions in a row ended with exit 1" halted the whole supervisor)', async () => {
    const { S, env, ev } = studio('halt');
    // The role's own command (STUDIO_<ROLE>_CMD) is a stand-in that exits 1 at once.
    const role = 'REVIEWER';
    const renv = { ...env, [`STUDIO_${role}_CMD`]: 'exit 1' };
    const runs = ['reviewer-h1', 'reviewer-h2'].map((a) => spawnSync(process.execPath, ['harness/agent.mjs', 'start', '--attach', '--role', 'reviewer', '--agent', a, '--tool', 'claude', '--model', 'claude-opus-5-5'], { windowsHide: true, cwd: S, encoding: 'utf8', env: { ...process.env, ...renv }, timeout: 120000 }));
    const ends = events(ev).filter((e) => e.type === 'agent.session.end' && /^reviewer-h/.test(e.agent));
    const r = probe(S, env, `
import { supervise } from ${u(S, 'harness/supervisor.mjs')};
const now = Date.now();
const deps = { sessions: () => [], startAgent: () => ({ ok: false, message: 'test' }), launchableRoles: () => ['reviewer', 'builder'], nextAgentName: (role) => role + '-x1' };
const st = { startedAt: now - 10 * 60000, names: ['reviewer-h1', 'reviewer-h2'] };
let res = null; const r = {};
try { res = await supervise({ watcher: true, dryRun: true, deps }, st, now); } catch (e) { r.err = e.message; }
r.halted = st.halted || null; r.backoff = st.roleBackoff || null; r.why = res?.why || null;
console.log(JSON.stringify(r));`);
    const bo = events(ev).filter((e) => e.type === 'supervisor.role_backoff' && e.meta?.role === 'reviewer');
    const ok = ends.length === 2 && ends.every((e) => e.meta?.code === 1) && r.halted === null && !r.err && r.backoff?.reviewer?.count === 2 && bo.length >= 1 && !events(ev).some((e) => e.type === 'supervisor.halted');
    return [ok, JSON.stringify({ ends: ends.map((e) => ({ a: e.agent, code: e.meta?.code, ran: e.meta?.exitCause?.ranSec })), r, bo: bo.length, runs: runs.map((x) => out(x).slice(-300)) })];
  });

  // ---- 5. review ask ----
  const ask = (S, env, body) => probe(S, env, `
import fs from 'node:fs'; import path from 'node:path';
import { askReview } from ${u(S, 'harness/review-ask.mjs')};
const r = {}; const seen = [];
const say = (text) => async ({ messages }) => { seen.push(messages.map((m) => m.content).join('\\n')); return { ok: true, text }; };
${body}
r.seenLen = seen.map((s) => s.length);
console.log(JSON.stringify(r));`);
  await guard('2.84 (w): `review ask` with a stand-in transport records a parsed approval and a parsed rejection exactly as `review record` does (studio/reviews/<date>-<ID>-asked-<model>.md with model-family google, implementer-family anthropic, one Verdict line, "via: harness-asked", a review.recorded event with via, model and tool) (fails before this fix: there was no review ask)', async () => {
    const { S, env, ev } = studio('ask');
    if (!has(path.join(S, 'harness', 'review-ask.mjs'))) return [false, 'harness/review-ask.mjs is missing'];
    const r = ask(S, env, `
r.a = await askReview('T-101', { model: 'google/gemini-3.1-pro-preview', noCommit: true, deps: { transport: say('VERDICT: APPROVE\\nWHY: the toggle is pure.\\nISSUES:\\n- none'), doneSummary: () => 'all checks listed' } });
r.aText = r.a.file ? fs.readFileSync(r.a.file, 'utf8') : '';
r.c = await askReview('T-101', { model: 'gpt-5', tool: 'codex', noCommit: true, deps: { transport: say('VERDICT: CHANGES\\nWHY: no test.\\nISSUES:\\n- game/rules/toggle.mjs: add a test'), doneSummary: () => 'x' } });
r.cText = r.c.file ? fs.readFileSync(r.c.file, 'utf8') : '';`);
    const rec = events(ev).filter((e) => e.type === 'review.recorded' && e.meta?.via === 'harness-asked');
    const ok = r.a?.ok && r.a.verdict === 'approve' && /-T-101-asked-google-gemini-3\.1-pro-preview\.md$/.test(r.a.file) && /^model-family: google$/m.test(r.aText) && /^implementer-family: anthropic$/m.test(r.aText) && /^via: harness-asked$/m.test(r.aText) && /^Verdict: approve$/m.test(r.aText)
      && r.c?.ok && r.c.verdict === 'request changes' && /^model-family: openai$/m.test(r.cText) && /^Verdict: request changes$/m.test(r.cText)
      && rec.length === 2 && rec[0].meta.tool === 'vertex' && rec[0].meta.model === 'google/gemini-3.1-pro-preview' && rec[1].meta.tool === 'codex' && r.seenLen?.[0] > 0;
    return [ok, JSON.stringify({ r, rec: rec.map((e) => e.meta) })];
  });

  await guard('2.84 (w): an answer `review ask` cannot parse (no VERDICT line) is saved beside the reviews as a .rejected.txt draft and nothing is recorded (no review .md, no review.recorded; a review.ask_failed event, exit non-zero); a large diff is cut at STUDIO_REVIEW_DIFF_KB with a note in what is sent, and the done-check summary is sent', async () => {
    const { S, env, ev } = studio('draft');
    fs.writeFileSync(path.join(S, 'game', 'rules', 'big.txt'), 'x'.repeat(300 * 1024));
    g(S, ['add', '-A']); g(S, ['commit', '-qm', 'Big data\n\nStudio-Task: T-101\nStudio-Model: claude-opus-5-5', '--no-verify']);
    const r = ask(S, { ...env, STUDIO_REVIEW_DIFF_KB: '50' }, `
r.d = await askReview('T-101', { model: 'google/gemini-3.1-pro-preview', noCommit: true, deps: { transport: say('Looks fine to me, I approve of it.'), doneSummary: () => 'SUMMARY-MARK-284w' } });
r.files = fs.readdirSync(path.join('studio', 'reviews')).filter((f) => /T-101/.test(f));
r.sentHasNote = seen.some((s) => /the diff was cut at 50 KB/.test(s)); r.sentHasSummary = seen.some((s) => /SUMMARY-MARK-284w/.test(s)); r.sentMax = Math.max(...seen.map((s) => s.length));`);
    const evs = events(ev);
    const ok = r.d?.ok === false && r.d.code === 1 && /\.rejected\.txt$/.test(r.d.draft || '') && r.files?.length === 1 && /\.rejected\.txt$/.test(r.files[0])
      && !evs.some((e) => e.type === 'review.recorded') && evs.some((e) => e.type === 'review.ask_failed' && e.task === 'T-101')
      && r.sentHasNote && r.sentHasSummary && r.sentMax < 80 * 1024;
    return [ok, JSON.stringify(r)];
  });

  await guard('2.84 (w): the Vertex transport of `review ask` sends the key only as the x-goog-api-key header: a fake key planted in the studio .env and the environment is in no file of the studio and in no event after a failed call (the stand-in fetch echoes the key in its error) and after a recorded one; a failure exits non-zero with one line and records nothing', async () => {
    const TOKEN = `fakeTok284w${process.pid}ZZqq`;
    const { S, env, ev } = studio('token', { dotenv: `VERTEX_API_KEY=${TOKEN}\nVERTEX_PROJECT_ID=p-284w\nSTUDIO_VERTEX_BASE_URL=http://127.0.0.1:9/v1\n` });
    const r = ask(S, { ...env, VERTEX_API_KEY: TOKEN }, `
const heads = [];
const fail = async (url, init) => { heads.push(init.headers); return new Response(JSON.stringify({ error: { message: 'quota exceeded for key ' + init.headers['x-goog-api-key'] } }), { status: 429 }); };
const good = async (url, init) => { heads.push(init.headers); return new Response(JSON.stringify({ model: 'google/gemini-3.1-pro-preview', choices: [{ message: { content: 'VERDICT: APPROVE\\nWHY: fine.\\nISSUES:\\n- none' } }], usage: { prompt_tokens: 10, total_tokens: 20 } }), { status: 200 }); };
r.f = await askReview('T-101', { model: 'google/gemini-3.1-pro-preview', noCommit: true, deps: { fetchImpl: fail, doneSummary: () => 's' } });
r.g = await askReview('T-101', { model: 'google/gemini-3.1-pro-preview', noCommit: true, deps: { fetchImpl: good, doneSummary: () => 's' } });
r.keyInHeader = heads.length === 2 && heads.every((h) => h['x-goog-api-key'] === process.env.VERTEX_API_KEY && !h.authorization);`);
    const hits = [];
    const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { if (!['node_modules', '.git'].includes(f.name)) walk(p); } else if (p !== path.join(S, '.env')) { try { if (fs.readFileSync(p, 'utf8').includes(TOKEN)) hits.push(path.relative(S, p)); } catch {} } } };
    walk(S);
    const failEv = events(ev).find((e) => e.type === 'review.ask_failed');
    const ok = r.f?.ok === false && r.f.code === 1 && !/\n/.test(r.f.line) && /429/.test(r.f.line) && r.g?.ok === true && r.keyInHeader && hits.length === 0 && failEv && !JSON.stringify(failEv).includes(TOKEN)
      && events(ev).filter((e) => e.type === 'review.recorded').length === 1;
    return [ok, JSON.stringify({ r, hits, failEv: failEv ? failEv.msg : null }).split(TOKEN).join('<TOKEN>')];
  });

  // ---- 6. an owed review with a command-less tool goes through review ask ----
  await guard('2.84 (w): a reviewer task owed a cross-family review whose planned model runs on vertex (a tool that cannot run commands) goes through `review ask`: the launcher starts no session, a review.ask_started event names vertex and the model, and the detached ask runs (here it fails on the unreachable stand-in endpoint: review.ask_failed, nothing recorded) (fails before this fix: a claude session was launched for it)', async () => {
    const TOKEN = `fakeTok284wB${process.pid}`;
    const { S, env, ev } = studio('owed', { dotenv: `VERTEX_API_KEY=${TOKEN}\nVERTEX_PROJECT_ID=p-284w\nSTUDIO_VERTEX_BASE_URL=http://127.0.0.1:9/v1\n` });
    const r = probe(S, { ...env, STUDIO_VERTEX_HARD_MODEL: 'google/gemini-3.1-pro-preview', STUDIO_REVIEWER_TOOL: 'claude', PATH: gitDir }, `
import { startAgent } from ${u(S, 'harness/agent.mjs')};
const res = startAgent({ role: 'reviewer', agent: 'reviewer-w2', task: 'T-102', tool: 'claude', toolDefault: true }, { detach: true });
console.log(JSON.stringify({ ok: res.ok, asked: res.asked ?? null, tool: res.tool || null, message: res.message || '' }));`);
    const until = Date.now() + 150000;
    let done = null;
    while (Date.now() < until) { done = events(ev).find((e) => (e.type === 'review.ask_failed' || e.type === 'review.recorded') && e.task === 'T-101'); if (done) break; spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},500)'], { windowsHide: true }); }
    const started = events(ev).find((e) => e.type === 'review.ask_started' && e.task === 'T-102');
    const ok = r.ok === false && r.asked === true && r.tool !== 'claude' && started && started.meta?.tool === 'vertex' && started.meta?.model === 'google/gemini-3.1-pro-preview'
      && done?.type === 'review.ask_failed' && !JSON.stringify(events(ev)).includes(TOKEN) && !events(ev).some((e) => e.type === 'agent.session.start');
    return [ok, JSON.stringify({ r, started: started?.msg || null, done: done?.msg || null })];
  });
}
