/**
 * harness/review-ask.mjs — 2.84 (w, B-133): a review the HARNESS asks for, with no agent session.
 *
 *   npm run review -- ask <TASK_ID> --model <id> [--tool <tool>] [--for <review task>] [--no-commit]
 *
 * A crew's cross-family reviewer was a Vertex model, and a Vertex session (aider) only suggests commands: it cannot run
 * `npm run review -- record`, so no cross-family review happened all day and a task waited about 10 hours. Here the
 * harness does the review call itself:
 *   - it collects what a reviewer session is given: the task's title and spec/contract (harness/review.mjs gather and
 *     prompt), the done-check's summary (`node harness/done-check.mjs <ID>`), and the diff of the task's lane against its
 *     base (`git diff HEAD...<lane branch>`), or for an engine task its engine branch against the engine target, else the
 *     task's tagged commits; capped at STUDIO_REVIEW_DIFF_KB (200) with a note when cut;
 *   - it sends ONE request through the transport the studio has for that tool: Vertex's OpenAI-compatible endpoint with the
 *     key from the main checkout's .env as x-goog-api-key, exactly as the Vertex proxy sends it (harness/vertex.mjs
 *     vertexUpstream; usage logged to .studio/vertex-usage.jsonl as session "review-ask"); for claude, codex or agy their CLI
 *     with the read-only review command line (harness/review.mjs reviewArgv), the prompt on stdin. Only the text answer is used;
 *   - the answer must carry the verdict `review record` reads (VERDICT: APPROVE or VERDICT: CHANGES). It is recorded
 *     exactly as `review record` does (studio/reviews/<date>-<ID>-asked-<model>.md, model-family and implementer-family lines,
 *     a review.recorded event, the same family rules), with `via: harness-asked`, the model and the tool. An answer with no
 *     verdict is saved beside it as <date>-<ID>-asked-<model>.rejected.txt (not .md: the checks never read it) and nothing is
 *     recorded;
 *   - a network, quota or tool failure: exit 1 with one line, nothing recorded, a review.ask_failed event (no key, no token:
 *     every message is scrubbed), and the task is not blocked further than it was.
 * The launcher (harness/agent.mjs) starts this, detached, for a reviewer task whose planned model runs on a tool that cannot
 * run commands (harness/model-tool.mjs TOOL_CAPABILITIES): startReviewAsk.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, emitEvent, readRecentEvents } from './event.mjs';
import { toolForModel } from './model-tool.mjs';
import { modelFamily } from './families.mjs';
import { scrub } from './secrets.mjs';
import { vertexConfigured } from './vertex.mjs';

const HARNESS = path.dirname(fileURLToPath(import.meta.url));
export const REVIEW_DIFF_KB_DEFAULT = 200;
export const reviewDiffKb = (env = process.env) => { const n = Number(String(env.STUDIO_REVIEW_DIFF_KB ?? '').trim()); return String(env.STUDIO_REVIEW_DIFF_KB ?? '').trim() !== '' && Number.isFinite(n) && n > 0 ? n : REVIEW_DIFF_KB_DEFAULT; };
const INFLIGHT_DIR = () => path.join(STUDIO_STATE_DIR, 'review-ask');
const INFLIGHT_MAX_MS = 20 * 60000;
const label = (m) => String(m || 'model').replace(/[^a-z0-9.-]+/gi, '-');
const git = (cwd, ...a) => spawnSync('git', a, { windowsHide: true, cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
/** One line, with the given secrets and anything secrets.mjs knows of removed. */
const clean = (s, secrets = []) => { let t = String(s ?? ''); for (const k of secrets) if (k && k.length >= 6) t = t.split(k).join('<key>'); return scrub(t).text.replace(/\s+/g, ' ').trim(); };

/** Cut a diff at kb KB: { text, cut, note }. */
export function capDiff(diff, kb = REVIEW_DIFF_KB_DEFAULT) {
  const buf = Buffer.from(String(diff || ''), 'utf8');
  const max = Math.round(kb * 1024);
  if (buf.length <= max) return { text: String(diff || ''), cut: false, note: '' };
  const text = buf.subarray(0, max).toString('utf8').replace(/�$/, '');
  const note = `(the diff was cut at ${kb} KB of ${Math.ceil(buf.length / 1024)} KB, STUDIO_REVIEW_DIFF_KB: the rest was not sent; say in WHY if what you saw is not enough to judge)`;
  return { text: `${text}\n${note}`, cut: true, note };
}

/**
 * The diff a reviewer session reads: { diff, from }. An engine task: its engine branch against the engine target, in the
 * engine repo. Else the lane branch (registry, train queue, or a branch holding the Studio-Task commits) against the main
 * checkout's HEAD (three dots: from their merge base). Else the task's tagged commits.
 */
export async function taskDiff(taskId, { root = REPO_ROOT, commits = [] } = {}) {
  try {
    const et = await import('./engine-tracks.mjs');
    const rec = et.engineTask(taskId, { root });
    if (rec?.engine && rec.branch) {
      const repo = et.engineRepo(rec.engine, { root });
      const target = et.engineTarget(rec.engine, { root })?.cfg?.target;
      if (repo && target) {
        const d = git(repo, 'diff', `${target}...${rec.branch}`);
        if (d.status === 0) return { diff: d.stdout, from: `the engine branch ${rec.branch} against ${target}` };
      }
    }
  } catch { /* not an engine task */ }
  let branch = null;
  try { const b = JSON.parse(fs.readFileSync(path.join(STUDIO_STATE_DIR, 'lane-branches.json'), 'utf8'))[taskId]; if (typeof b === 'string') branch = b; } catch {}
  if (!branch) { try { branch = (await import('./review.mjs')).taskBranchCommits(taskId, { root })?.branch || null; } catch { branch = null; } }
  if (branch && git(root, 'rev-parse', '--verify', '-q', branch).status === 0) {
    const d = git(root, 'diff', `HEAD...${branch}`, '--', '.', ':(exclude)studio/reviews', ':(exclude).studio', ':(exclude)package-lock.json');
    if (d.status === 0 && d.stdout.trim()) return { diff: d.stdout, from: `the lane branch ${branch} against its base` };
  }
  const parts = commits.map((c) => git(root, 'show', '--format=%s%n', '--patch', c.hash, '--', '.', ':(exclude)studio/reviews', ':(exclude).studio', ':(exclude)package-lock.json')).filter((r) => r.status === 0).map((r) => r.stdout);
  return { diff: parts.join('\n'), from: `${commits.length} commit${commits.length === 1 ? '' : 's'} tagged with ${taskId}` };
}

/** The done-check's summary of the task, as a reviewer session would read it (`node harness/done-check.mjs <ID>`). */
export function doneSummary(taskId, { root = REPO_ROOT } = {}) {
  const r = spawnSync(process.execPath, [path.join(HARNESS, 'done-check.mjs'), taskId], { windowsHide: true, cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  return out ? scrub(out.slice(-4000)).text : '(the done-check printed nothing)';
}

/**
 * The Vertex transport: one chat completion, sent as the Vertex proxy sends it (the key from the main checkout's .env as
 * x-goog-api-key, never logged). { ok, text } or { ok: false, why } (why scrubbed). fetchImpl for tests.
 */
export async function vertexAsk({ model, messages, task = null, root = null, fetchImpl = globalThis.fetch, maxTokens = 2000 } = {}) {
  const vx = await import('./vertex.mjs');
  const r0 = root || vx.studioRoot();
  const vals = vx.mainEnv(r0);
  const key = String(vals[vx.VERTEX_KEY_ENV] || '').trim();
  const up = vx.vertexUpstream(vals);
  if (!key || !up.base) return { ok: false, why: `Vertex is paused or not configured: ${!key ? `${vx.VERTEX_KEY_ENV} is not set` : up.why} in the studio's .env` };
  const id = vx.vertexId(model);
  let res; let text = '';
  try {
    res = await fetchImpl(`${up.base}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify({ model: id, messages, max_tokens: maxTokens }) });
    text = await res.text();
  } catch (e) { return { ok: false, why: `the request to Vertex failed: ${clean(e?.message || e, [key]).slice(0, 200)}` }; }
  if (!res.ok) {
    let msg = text;
    try { const j = JSON.parse(text); msg = (Array.isArray(j) ? j[0] : j)?.error?.message || text; } catch {}
    return { ok: false, status: res.status, why: `Vertex answered ${res.status}${res.status === 429 ? ' (quota)' : ''}: ${clean(msg, [key]).slice(0, 200)}` };
  }
  let j = null;
  try { j = JSON.parse(text); } catch { return { ok: false, why: 'Vertex answered with something that is not JSON' }; }
  try {
    const px = await import('./vertex-proxy.mjs');
    const u = px.usageOf(text);
    if (u) {
      const c = px.countsOf(u.usage);
      const m = vx.vertexId(u.model || id);
      const line = { ts: new Date().toISOString(), session: 'review-ask', task, tool: 'vertex', model: m, in: c.in, out: c.out, total: c.total, usd: px.usdOf(r0, m, c) };
      fs.mkdirSync(path.dirname(vx.usageFile(r0)), { recursive: true });
      fs.appendFileSync(vx.usageFile(r0), `${JSON.stringify(line)}\n`);
    }
  } catch { /* usage is reported, never a blocker */ }
  const content = j?.choices?.[0]?.message?.content;
  const out = Array.isArray(content) ? content.map((p) => p?.text || '').join('') : String(content || '');
  return out.trim() ? { ok: true, text: out } : { ok: false, why: 'Vertex answered with no text' };
}

/** A CLI transport (claude, codex, agy): the read-only review command, the prompt on stdin. */
export async function cliAsk({ tool, model, messages, root = REPO_ROOT } = {}) {
  const text = messages.map((m) => `${m.role === 'system' ? 'Instructions' : 'Review this'}:\n${m.content}`).join('\n\n');
  let argv;
  if (tool === 'agy') { const { agyOptions } = await import('./agent.mjs'); argv = ['agy', ...agyOptions(model, { ...process.env, STUDIO_AGY_PRINT_TIMEOUT: '900s', STUDIO_AGY_MODE: 'off' })]; }
  else if (tool === 'claude' || tool === 'codex') argv = (await import('./review.mjs')).reviewArgv(tool, model, text);
  else return { ok: false, why: `the harness has no transport to ask ${tool} for a review (vertex, claude, codex, agy)` };
  const { spawnAgentSync } = await import('./launch.mjs');
  const r = spawnAgentSync(argv, { cwd: root, encoding: 'utf8', input: text, timeout: 15 * 60000, maxBuffer: 32 * 1024 * 1024 });
  const out = String(r.stdout || '').trim();
  if (r.status === 0 && out) return { ok: true, text: out };
  return { ok: false, why: `${tool} exited ${r.status ?? 'without a code'}${r.stderr ? `: ${clean(String(r.stderr).trim().split('\n').pop()).slice(0, 160)}` : ''}` };
}

/**
 * Ask one model for a review of taskId and record its answer. { ok, code, line, file?, verdict?, draft? }.
 * deps: { transport({ tool, model, messages, task }) -> { ok, text } | { ok: false, why }, fetchImpl, doneSummary(taskId) }.
 */
export async function askReview(taskId, { model, tool = null, forTask = null, noCommit = false, env = process.env, root = REPO_ROOT, deps = {} } = {}) {
  const fail = (line, extra = {}) => {
    const why = clean(line).slice(0, 400);
    emitEvent({ type: 'review.ask_failed', agent: 'review-ask', to: 'producer', task: taskId, status: 'warn', msg: `${taskId}: the harness-asked review did not happen: ${why}`.slice(0, 600), meta: { model: model || null, tool: tool || null, ...(forTask ? { forTask } : {}), why, ...extra } });
    return { ok: false, code: 1, line: `${taskId}: no review recorded: ${why}` };
  };
  if (!model) return fail('say which model: --model <id>');
  const need = toolForModel(model, { env, root });
  if (!tool) tool = need.tool;
  if (!tool) return fail(need.why);
  if (need.tool && need.tool !== tool) return fail(`${model} runs on the ${need.tool} tool, not ${tool} (${need.why})`);
  if (tool === 'vertex' && !deps.transport) { const c = (await import('./vertex.mjs')).vertexConfigured(); if (!c.ok) return fail(c.why); }
  const rv = await import('./review.mjs');
  const no = rv.recordRefusal('review-ask', env);
  if (no) return fail(no);
  const g = rv.gather(taskId);
  if (g.error) return fail(g.error);
  const d = await taskDiff(taskId, { root, commits: g.commits });
  const capped = capDiff(scrub(d.diff).text, reviewDiffKb(env));
  const summary = (deps.doneSummary || doneSummary)(taskId, { root });
  const messages = rv.prompt({ ...g, diff: capped.text, cut: false });
  messages[1].content += `\n\nThe diff above is ${d.from}${capped.cut ? `; ${capped.note}` : ''}.\n\nThe done-check's summary (node harness/done-check.mjs ${taskId}):\n${summary}\n\nAnswer with the text of the review only, in the shape asked: its first line VERDICT: APPROVE or VERDICT: CHANGES.`;
  let r;
  try {
    r = deps.transport ? await deps.transport({ tool, model, messages, task: taskId })
      : tool === 'vertex' ? await vertexAsk({ model, messages, task: taskId, fetchImpl: deps.fetchImpl || globalThis.fetch })
        : await cliAsk({ tool, model, messages, root });
  } catch (e) { r = { ok: false, why: String(e?.message || e) }; }
  if (!r?.ok) return fail(r?.why || 'the model gave no answer', r?.status ? { status: r.status } : {});
  const answer = String(r.text || '');
  const rec = rv.recordOutsideReview(taskId, { by: model, family: modelFamily(model), text: answer, model, implementer: g.builder, noCommit, env, asked: { tool, forTask, by: 'review-ask' } });
  if (!rec.ok) {
    const date = new Date().toISOString().slice(0, 10);
    const draft = path.join(REPO_ROOT, 'studio', 'reviews', `${date}-${taskId}-asked-${label(model)}.rejected.txt`);
    try { fs.mkdirSync(path.dirname(draft), { recursive: true }); fs.writeFileSync(draft, `Rejected draft: ${clean(rec.error)}\nAsked: ${model} on ${tool} for ${taskId}. Nothing was recorded.\n\n${scrub(answer).text}\n`); } catch {}
    const rel = path.relative(REPO_ROOT, draft).split(path.sep).join('/');
    const out = fail(`${rec.noVerdict ? 'the answer has no VERDICT line' : rec.error}; the answer is saved as ${rel}`, { draft: rel });
    return { ...out, draft: rel };
  }
  return { ok: true, code: 0, file: rec.file, verdict: rec.verdict, line: `${taskId}: ${rec.verdict} from ${model} (${tool}, asked by the harness). Written to ${rec.file}${rec.committed ? ' and committed' : rec.warn ? `; ${rec.warn}` : ''}` };
}

/**
 * For the launcher: start `review ask` (detached) for a reviewer task whose planned tool cannot run commands, unless one is
 * in flight or this review task's harness-asked review is already recorded. { started, message }. Never throws.
 */
export function startReviewAsk({ reviewTask, reviewed, model, tool, by = 'launcher', events = null, spawnImpl = spawn } = {}) {
  try {
    const ev = events || readRecentEvents(20000);
    const done = ev.filter((e) => e.type === 'review.recorded' && e.task === reviewed && e.meta?.via === 'harness-asked' && e.meta?.forTask === reviewTask).pop();
    if (done) return { started: false, message: `Not started: the harness already asked ${done.meta.model || 'a model'} for the review of ${reviewed} (${done.meta.file || 'studio/reviews/'}); ${reviewTask} only needs closing: npm run task -- done ${reviewTask} by a person or the Producer.` };
    if (tool === 'vertex') { const c = vertexConfigured(); if (!c.ok) return { started: false, message: `Not started: ${tool} cannot run commands, so the harness would ask ${model} for the review of ${reviewed} itself, but ${c.why}.` }; }
    const f = path.join(INFLIGHT_DIR(), `${reviewed}.json`);
    let cur = null;
    try { cur = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
    if (cur && Date.now() - Date.parse(cur.at) < INFLIGHT_MAX_MS) return { started: false, message: `Not started: the harness is already asking ${cur.model} for the review of ${reviewed} (since ${String(cur.at).slice(11, 16)} UTC).` };
    const c = spawnImpl(process.execPath, [path.join(HARNESS, 'review.mjs'), 'ask', reviewed, '--model', model, '--tool', tool, '--for', reviewTask], { windowsHide: true, cwd: REPO_ROOT, detached: true, stdio: 'ignore' });
    try { c.unref(); } catch {}
    try { fs.mkdirSync(INFLIGHT_DIR(), { recursive: true }); fs.writeFileSync(f, `${JSON.stringify({ reviewTask, model, tool, pid: c.pid || null, at: new Date().toISOString() })}\n`); } catch {}
    emitEvent({ type: 'review.ask_started', agent: by, to: 'producer', task: reviewTask, msg: `${reviewTask}: ${tool} cannot run commands, so no reviewer session starts: the harness asks ${model} for the review of ${reviewed} itself (npm run review -- ask)`, meta: { reviewed, model, tool } });
    return { started: true, message: `Not started as a session: ${tool} cannot run commands, so the harness asks ${model} for the review of ${reviewed} itself (npm run review -- ask; see the review.ask_* events).` };
  } catch (e) { return { started: false, message: `Not started: the harness could not ask for the review: ${clean(e?.message || e).slice(0, 200)}` }; }
}

/** The command line of `npm run review -- ask` (called from harness/review.mjs). */
export async function askCli(argv) {
  const id = argv.find((a) => /^[A-Z]+-\d+$/.test(a));
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  if (!id || !flag('model')) return { code: 1, line: 'Usage: npm run review -- ask <TASK_ID> --model <id> [--tool <tool>] [--for <review task>] [--no-commit]' };
  try {
    const r = await askReview(id, { model: flag('model'), tool: flag('tool'), forTask: flag('for'), noCommit: argv.includes('--no-commit') });
    return { code: r.code, line: r.line };
  } finally {
    try { const f = path.join(INFLIGHT_DIR(), `${id}.json`); const cur = JSON.parse(fs.readFileSync(f, 'utf8')); if (!cur.pid || cur.pid === process.pid || !flag('for') || cur.reviewTask === flag('for')) fs.rmSync(f, { force: true }); } catch {}
  }
}
