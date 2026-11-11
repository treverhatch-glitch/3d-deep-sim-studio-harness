#!/usr/bin/env node
/**
 * harness/review.mjs — a second opinion from a model made by another company, in one command.
 *
 *   npm run review -- <TASK_ID> [--local] [--implementer <model>] [--dry-run] [--router-only]
 *   npm run review -- same-family [on|off|auto] --by <who> [--why "..."]   2.84 (g): whether a same-family review counts
 *   npm run review -- record <TASK_ID> --by <reviewer name> --family <xai|deepseek|openai|google|anthropic|…>
 *                     --file <review.md> [--model <m>] [--implementer <model>] [--no-commit]
 *
 * Gathers the task, its spec (for system tasks) and the diff of every commit tagged with it, sends
 * them to the reviewer chain through the router (--local: only your Ollama model, free and offline),
 * and writes studio/reviews/<date>-<ID>-<model>.md with `model-family:` and `implementer-family:`
 * lines and one verdict. The done-check for system tasks and the reviewer gate read that file.
 * It refuses when the reviewer would be the same family as the builder.
 * 2.62.0 (H): a task with an agreed acceptance contract (studio/contracts/<ID>.json) sends it too, and the reviewer
 * grades the work against each criterion (a criterion not met means CHANGES).
 *
 * Small local models miss things: treat an approval as a second look, not proof. A person can always
 * write a review by hand instead (studio/skills/review.md).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, readRecentEvents, emitEvent } from './event.mjs';
import { readQueue } from './train.mjs';
import { parseNextQueue } from './task.mjs';
import { taskType } from './done-check.mjs';
import { taggedCommits } from './scorecard.mjs';
import { modelFamily } from './families.mjs';
import { sameFamilyDecision, sameFamilyRefusal, readSameFamily, studioRoot, configuredFamilies, SAME_FAMILY_FILE_REL, SAME_FAMILY_COMMAND } from './review-family.mjs';
import { routeChatCompletion, getRouterMatrix } from './route.mjs';
import { scrub } from './secrets.mjs';
import { spawnAgentSync } from './launch.mjs';
import { contractForReview } from './contracts.mjs';
import { WORKER_NAME, DECIDER_ROLES, AGENT_SHELL, permittedSetter, mayDecide, actorOf } from './permission.mjs';

const DIFF_CAP = 24000;
const VERDICT_WORDS = /\b(approve[sd]?|lgtm|request(ed)? changes|changes requested|reject(ed)?|blocking)\b/gi;

function diffOf(hash) {
  const r = spawnSync('git', ['show', '--format=%s%n', '--patch', hash, '--', '.', ':(exclude)studio/reviews', ':(exclude).studio', ':(exclude)package-lock.json'], { windowsHide: true, cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : '';
}

/**
 * 2.79 (d): where a task's commits live when the current branch has none (review run from main): the lane branch the
 * registry (.studio/lane-branches.json) or the train queue names for it, else a branch whose commits carry
 * "Studio-Task: <ID>". [{ branch, commits }] for the first that has tagged commits, or null.
 */
export function taskBranchCommits(taskId, { root = REPO_ROOT } = {}) {
  const g = (...a) => spawnSync('git', a, { windowsHide: true, cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const names = [];
  try { const b = JSON.parse(fs.readFileSync(path.join(STUDIO_STATE_DIR, 'lane-branches.json'), 'utf8'))[taskId]; if (typeof b === 'string') names.push(b); } catch {}
  try { for (const e of readQueue(root)) if (e?.task === taskId && e.branch) names.push(e.branch); } catch {}
  const hit = g('log', '--all', '-n1', '--format=%H', `--grep=Studio-Task: ${taskId}`);
  if (hit.status === 0 && hit.stdout.trim()) {
    const own = g('for-each-ref', '--contains', hit.stdout.trim(), '--format=%(refname:short)', 'refs/heads');
    if (own.status === 0) names.push(...own.stdout.split(/\r?\n/).filter(Boolean));
  }
  for (const branch of [...new Set(names)]) {
    const commits = taggedCommits(3000, branch).filter((c) => c.tasks.includes(taskId));
    if (commits.length) return { branch, commits };
  }
  return null;
}

export function gather(taskId, { implementer = null } = {}) {
  const q = parseNextQueue();
  const task = [...q.inProgress, ...q.backlog, ...q.done].find((t) => t.id === taskId);
  if (!task) return { error: `No task ${taskId} in studio/NEXT.md` };
  let commits = taggedCommits().filter((c) => c.tasks.includes(taskId));
  let onBranch = null;
  if (!commits.length) { const found = taskBranchCommits(taskId); if (found) { commits = found.commits; onBranch = found.branch; } }
  if (!commits.length) return { error: `No commits tagged Studio-Task: ${taskId} yet. Commit the work first (the commit-msg hook adds the tag when STUDIO_LOCK_OWNER is set).` };
  const started = readRecentEvents(50000).filter((e) => e.task === taskId && e.type === 'task.start' && e.model).at(-1);
  const builder = implementer || started?.model || commits.map((c) => c.model).filter(Boolean).at(-1) || null;
  if (!builder) return { error: `Can't tell which model built ${taskId}. Pass --implementer <model> (for example claude-opus-5-5).` };
  const specs = [...new Set(commits.flatMap((c) => c.files).filter((f) => /^studio\/bible\/systems\/.+\.md$/.test(f)))].filter((f) => fs.existsSync(path.join(REPO_ROOT, f)));
  let diff = commits.map((c) => diffOf(c.hash)).join('\n');
  const cut = diff.length > DIFF_CAP;
  diff = scrub(diff.slice(0, DIFF_CAP)).text;
  // 2.62.0 (H): the task's agreed acceptance contract, if any, so the review grades against what done means.
  return { task, type: taskType(task), builder, commits, onBranch, specs, diff, cut, contract: contractForReview(taskId) };
}

export function prompt(g) {
  const spec = g.specs.map((f) => `### ${f}\n${fs.readFileSync(path.join(REPO_ROOT, f), 'utf8').slice(0, 6000)}`).join('\n\n');
  return [
    {
      role: 'system',
      content: 'You review work for a small game studio. The game logic must be deterministic: seeded random numbers only, no clock, no browser objects inside the simulation, a fixed tick. Be strict about bugs, determinism, missing tests and unclear hand-offs; don\'t nitpick style. Answer in this exact shape:\nVERDICT: APPROVE or VERDICT: CHANGES\nWHY: two or three sentences.\nISSUES:\n- file and line or area: the problem, and the fix (or "- none")',
    },
    {
      role: 'user',
      content: `Task ${g.task.id} (${g.type}): ${g.task.title}\nBuilt by: ${g.builder}\n\n${spec ? `Spec:\n${spec}\n\n` : ''}${g.contract ? `${g.contract}\nIn ISSUES, add one line per criterion: CONTRACT <id>: met or not met, and why.\n\n` : ''}Changes (${g.commits.length} commit${g.commits.length === 1 ? '' : 's'}${g.cut ? `, first ${DIFF_CAP} characters` : ''}):\n${g.diff}`,
    },
  ];
}

export function writeReview(g, { model, content }) {
  const text = String(content || '').trim();
  const first = (text.match(/VERDICT\s*:\s*(APPROVE|CHANGES)/i) || [])[1]?.toUpperCase() || null;
  const verdict = first === 'APPROVE' ? 'approve' : 'request changes';
  // Only the verdict line carries verdict words, so the done-check reads one answer.
  const body = text.replace(/VERDICT\s*:\s*(APPROVE|CHANGES)\s*/i, '').replace(VERDICT_WORDS, (w) => (/^appro|^lgtm/i.test(w) ? 'OK' : 'asks for changes'));
  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(REPO_ROOT, 'studio', 'reviews', `${date}-${g.task.id}-${String(model).replace(/[^a-z0-9.-]+/gi, '-')}.md`);
  const out = [
    `model-family: ${modelFamily(model)}`,
    `implementer-family: ${modelFamily(g.builder)}`,
    '',
    `# Review of ${g.task.id}: ${g.task.title}`,
    '',
    `Reviewer: ${model} (by \`npm run review\`). Builder: ${g.builder}. Commits: ${g.commits.map((c) => c.hash.slice(0, 7)).join(', ')}${g.cut ? ' (long diff, cut)' : ''}.`,
    '',
    `Verdict: ${verdict}${first ? '' : ' (the reviewer gave no clear verdict, so this counts as changes)'}`,
    '',
    '## Reviewer notes',
    '',
    body || '(none)',
    '',
  ].join('\n');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out);
  emitEvent({ type: 'review.written', agent: `reviewer:${model}`, task: g.task.id, to: 'producer', msg: `${g.task.id} reviewed by ${model}: ${verdict}` });
  return { file: path.relative(REPO_ROOT, file).split(path.sep).join('/'), verdict };
}

/**
 * No router keys (or the router failed): ask an agent CLI made by another company instead, read-only.
 * Run #1 showed "503: All channels exhausted for role reviewer" on a studio that reviews through agent
 * CLIs and never set router keys. Order: STUDIO_REVIEWER_TOOL (+ _MODEL), then STUDIO_REVIEW_TOOLS
 * ("codex:gpt-6-sol,agy"), then codex, agy, claude; tools of the builder's family, missing from the
 * PATH or out of quota are skipped.
 */
const TOOL_FAMILY = { claude: 'anthropic', codex: 'openai', agy: 'google', gemini: 'google', grok: 'xai' };
const TOOL_MODEL_NAME = { claude: 'claude', codex: 'gpt', agy: 'gemini', gemini: 'gemini', grok: 'grok' };
export function reviewerTools(builder, env = process.env) {
  const listed = [env.STUDIO_REVIEWER_TOOL ? `${env.STUDIO_REVIEWER_TOOL}${env.STUDIO_REVIEWER_MODEL ? `:${env.STUDIO_REVIEWER_MODEL}` : ''}` : null, ...String(env.STUDIO_REVIEW_TOOLS || '').split(','), 'codex', 'agy', 'claude'].filter(Boolean).map((x) => x.trim());
  const seen = new Set();
  const bfam = modelFamily(builder);
  return listed.map((x) => {
    const [tool, ...m] = x.split(':');
    return { tool, model: m.join(':') || null };
  }).filter(({ tool, model }) => {
    if (seen.has(tool) || !TOOL_FAMILY[tool]) return false;
    seen.add(tool);
    const fam = model ? modelFamily(model) : TOOL_FAMILY[tool];
    return bfam === 'unknown' || (fam !== bfam && TOOL_FAMILY[tool] !== bfam);
  });
}
/**
 * Reviews that couldn't happen because every reviewer of another family was out (test #2: Codex and agy
 * were both out all afternoon, and reviews just stopped). Kept in studio/reviews/OWED.json with when to
 * try again; the watcher retries each one once that time has passed.
 */
export const OWED = path.join(REPO_ROOT, 'studio', 'reviews', 'OWED.json');
export function readOwed() {
  try {
    return JSON.parse(fs.readFileSync(OWED, 'utf8')).owed || [];
  } catch {
    return [];
  }
}
function writeOwed(list) {
  fs.mkdirSync(path.dirname(OWED), { recursive: true });
  fs.writeFileSync(OWED, `${JSON.stringify({ owed: list }, null, 2)}\n`);
}
export async function oweReview(taskId, why, builder) {
  const { exhaustedUntil } = await import('./budget.mjs');
  const resets = reviewerTools(builder).map(({ tool }) => exhaustedUntil(tool)).filter(Boolean).sort();
  const nextTry = resets[0] || new Date(Date.now() + 3600000).toISOString();
  const list = readOwed().filter((o) => o.task !== taskId);
  list.push({ task: taskId, at: new Date().toISOString(), why: String(why).slice(0, 300), nextTry });
  writeOwed(list);
  emitEvent({ type: 'review.owed', agent: 'reviewer', to: 'producer', task: taskId, msg: `${taskId}: no reviewer of another family answered; the review is owed and will be tried again at ${nextTry.slice(11, 16)} UTC` });
  return nextTry;
}
export function settleOwed(taskId) {
  const list = readOwed();
  if (list.some((o) => o.task === taskId)) writeOwed(list.filter((o) => o.task !== taskId));
}
/** Owed reviews whose retry time has passed (the watcher starts them). */
export const dueOwed = (now = Date.now()) => readOwed().filter((o) => Date.parse(o.nextTry) <= now && !(o.tries >= 3));
export function markTried(taskId) {
  writeOwed(readOwed().map((o) => (o.task === taskId ? { ...o, tries: (o.tries || 0) + 1, nextTry: new Date(Date.now() + 3600000).toISOString() } : o)));
}

export async function cliReview(g, messages, { run = spawnSync } = {}) {
  const { exhaustedUntil, exhaustedFor } = await import('./budget.mjs');
  const text = messages.map((m) => `${m.role === 'system' ? 'Instructions' : 'Review this'}:\n${m.content}`).join('\n\n');
  const tried = [];
  for (const { tool, model } of reviewerTools(g.builder)) {
    const which = run(process.platform === 'win32' ? 'where' : 'which', [tool], { encoding: 'utf8' });
    if (which.status !== 0) {
      tried.push(`${tool}: not installed`);
      continue;
    }
    // 2.78.2 (d): the tool:model mark first, then the tool's: Argon's 429 no longer skips agy's Flash. A tool-wide mark
    // (the tool is out for every model) still does.
    if (exhaustedUntil(tool) || (tool !== 'agy' && model && exhaustedFor(tool, model))) {
      tried.push(`${tool}: out of quota`);
      continue;
    }
    // Read-only: the reviewer looks and writes a verdict, it never edits the game.
    // 2.78.1: agy runs a Gemini model by name (with none it ran its own default, a Claude model: a "Gemini" review of a
    // Claude builder's work would have been the same family) and reads the review from stdin (H-2: on Windows agy split
    // a `-p <text>` argument at its spaces); no --mode, so it can't edit. agyReview below.
    const agyRun = tool === 'agy' ? await agyReview(model) : null;
    if (agyRun?.allOut) {
      tried.push(`agy: out of quota for ${agyRun.allOut.join(', ')}`);
      continue;
    }
    const argv = tool === 'claude' ? ['claude', '-p', '--output-format', 'text', '--disallowedTools', 'Bash,Edit,Write,MultiEdit,NotebookEdit', ...(model ? ['--model', model] : [])]
      : tool === 'codex' ? ['codex', 'exec', '--sandbox', 'read-only', ...(model ? ['-m', model] : []), '-']
      : agyRun ? agyRun.argv
      : tool === 'gemini' ? [tool, '-p', text, '--print-timeout', '900s']
      : ['grok', '-p', text, ...(model ? ['-m', model] : [])];
    // P-066: no shell for the tool (harness/launch.mjs), so agy's and grok's review text arrives as one argument on
    // Windows too; text too long for the command line goes by file.
    const promptAt = argv.indexOf(text);
    const promptFile = promptAt > 0 ? path.join(REPO_ROOT, '.studio', 'review-prompt.md') : null;
    if (promptFile) {
      fs.mkdirSync(path.dirname(promptFile), { recursive: true });
      fs.writeFileSync(promptFile, text);
    }
    const opts = { cwd: REPO_ROOT, encoding: 'utf8', input: ['claude', 'codex', 'agy'].includes(tool) ? text : undefined, timeout: 15 * 60000, maxBuffer: 32 * 1024 * 1024 };
    const r = run === spawnSync ? spawnAgentSync(argv, { ...opts, promptAt, promptFile }) : run(argv[0], argv.slice(1), opts);
    const out = String(r.stdout || '').trim();
    if (r.status === 0 && out) return { ok: true, model: agyRun?.model || model || TOOL_MODEL_NAME[tool], content: out, tool };
    // A reviewer that says it hit its limit is marked out until it resets, so the owed review knows when to retry.
    // 2.30 (J12): the provider's limit line on a failed run, never the review text (a review of budget code
    // that said "quota" marked the reviewer out for an hour).
    const { limitLine } = await import('./budget.mjs');
    const said = limitLine(r.stderr, r.status === 0 ? '' : r.stdout, r.status ?? 1);
    if (said && run === spawnSync) {
      const { markExhausted, quotaKeyFor } = await import('./budget.mjs');
      markExhausted(quotaKeyFor(tool, agyRun?.model || model), said);
    }
    tried.push(`${tool}: exit ${r.status}${r.stderr ? ` (${String(r.stderr).trim().split('\n').pop().slice(0, 120)})` : ''}`);
  }
  return { ok: false, error: tried.length ? tried.join('; ') : `no reviewer tool of another family than ${modelFamily(g.builder)} (set STUDIO_REVIEWER_TOOL)` };
}

/**
 * 2.78.1: how the agy reviewer starts: { argv, model }. The model is Gemini: the one asked for (STUDIO_REVIEWER_MODEL with
 * STUDIO_REVIEWER_TOOL=agy, or agy:<model> in STUDIO_REVIEW_TOOLS) when it is a Gemini model, else STUDIO_TOOL_AGY_MODEL,
 * else the agy default (harness/agent.mjs AGY_DEFAULT_MODEL). agy's print timeout 900 s and its model flag
 * (STUDIO_AGY_MODEL_FLAG) as for a builder (agyOptions), without --mode; the review goes on stdin.
 */
export async function agyReview(asked = null, env = process.env) {
  const { agyOptions, isGeminiModel, AGY_DEFAULT_MODEL } = await import('./agent.mjs');
  const { exhaustedFor } = await import('./budget.mjs');
  // 2.78.2 (d): the first Gemini model not out of quota: the one asked for, STUDIO_TOOL_AGY_MODEL, the agy default, then
  // STUDIO_REVIEW_AGY_FALLBACK (comma list, default the Flash model in harness/model-pools.mjs). A model marked out
  // (agy:<model>) is skipped, not the whole tool; allOut names the models when every one is out.
  const fallback = String(env.STUDIO_REVIEW_AGY_FALLBACK || 'gemini-3.8-flash-high').split(',');
  const cands = [...new Set([asked, env.STUDIO_TOOL_AGY_MODEL, AGY_DEFAULT_MODEL, ...fallback].map((m) => String(m || '').trim()).filter((m) => isGeminiModel(m)))];
  const model = cands.find((m) => !exhaustedFor('agy', m)) || null;
  if (!model) return { argv: null, model: cands[0] || AGY_DEFAULT_MODEL, allOut: cands };
  return { argv: ['agy', ...agyOptions(model, { ...env, STUDIO_AGY_PRINT_TIMEOUT: '900s', STUDIO_AGY_MODE: 'off' })], model };
}

/**
 * 2.78.2 (d): who may record a review done outside the harness (a person, grokbot through xAI, a DeepSeek chat): a person,
 * the orchestrator (an agent outside the harness) or a Producer/Director session; never a worker (a launched builder,
 * qa, reviewer … session, or a worker's name in --by or STUDIO_LOCK_OWNER): a worker recording its own review would
 * approve its own work. Returns the refusal, or null.
 */
export function recordRefusal(by, env = process.env, { workerName = WORKER_NAME, deciders = DECIDER_ROLES } = {}) {
  const role = String(env.STUDIO_ROLE || '').trim();
  const owner = String(env.STUDIO_LOCK_OWNER || '').trim();
  if (role && !deciders.test(role)) return `Refused: a launched ${role} session can't record a review; a person, the orchestrator, or a Producer or Director session can.`;
  const worker = [owner].find((n) => n && workerName.test(n));
  if (worker) return `Refused: ${worker} is a worker agent; a person, the orchestrator, or a Producer or Director session records an outside review.`;
  return null;
}

/**
 * 2.78.2 (d): record a review somebody else did outside the harness (the cross-family reviewer tools were all out: grokbot via
 * xAI reviewed T-174). The family must differ from the implementer's; the file must carry a verdict (the last
 * `VERDICT: APPROVE|CHANGES` or `Verdict: approve|request changes` line). Written to studio/reviews/ with the same
 * header as `npm run review` plus a line naming the outside reviewer, logged, and committed unless noCommit.
 * Returns { ok, file, verdict } or { ok: false, error }.
 */
export function recordOutsideReview(id, { by, family, file, model = null, implementer = null, noCommit = false, env = process.env } = {}) {
  const no = recordRefusal(by, env);
  if (no) return { ok: false, error: no };
  if (!String(by || '').trim()) return { ok: false, error: 'Say who reviewed it: --by <reviewer name>.' };
  if (!/^[a-z0-9][a-z0-9._-]{1,30}$/i.test(String(family || ''))) return { ok: false, error: 'Say the reviewer\'s model family: --family <xai|deepseek|openai|google|anthropic|…>.' };
  if (!file) return { ok: false, error: 'Give the review text: --file <review.md>.' };
  let text;
  try { text = fs.readFileSync(path.resolve(file), 'utf8').replace(/\r\n/g, '\n'); } catch (e) { return { ok: false, error: `Can't read ${file}: ${e.code || e.message}` }; }
  const g = gather(id, { implementer });
  if (g.error) return { ok: false, error: g.error };
  const fam = modelFamily(String(family).toLowerCase());
  const impl = modelFamily(g.builder);
  if (fam === 'unknown') return { ok: false, error: `Unknown family "${family}".` };
  // 2.83: a same-family review is taken when its text says no other family is available AND none is configured.
  // 2.84 (g): the studio's switch (studio/review.json): auto is the rule above, on counts it with either header, off never.
  const dec = impl !== 'unknown' && fam === impl ? sameFamilyDecision(text, g.builder, env) : null;
  const sameOk = Boolean(dec?.ok);
  if (dec && !sameOk) { const w = sameFamilyRefusal(g.builder, env, { text }); return { ok: false, error: `Refused: ${by} (${fam}) is the same family as the builder (${g.builder}, ${impl}); a review from another family is what counts.${w ? ` (${w})` : ''}` }; }
  const verdicts = [...text.matchAll(/^[ \t>*_#-]*verdict\**\s*:\**\s*(approve[sd]?|lgtm|changes|request(?:ed)? changes|changes requested|reject(?:ed)?)\b/gim)].map((m) => m[1].toLowerCase());
  if (!verdicts.length) return { ok: false, error: `${file} has no verdict line: end it with "VERDICT: APPROVE" or "VERDICT: CHANGES".` };
  const verdict = /^(approve|lgtm)/.test(verdicts.at(-1)) ? 'approve' : 'request changes';
  // Only the header's verdict line carries verdict words, so the done-check reads one answer.
  const body = scrub(text.replace(/^[ \t>*_#-]*verdict\**\s*:.*$/gim, '').trim()).text.replace(VERDICT_WORDS, (w) => (/^appro|^lgtm/i.test(w) ? 'OK' : 'asks for changes'));
  const date = new Date().toISOString().slice(0, 10);
  const label = String(model || by).replace(/[^a-z0-9.-]+/gi, '-');
  const abs = path.join(REPO_ROOT, 'studio', 'reviews', `${date}-${id}-outside-${label}.md`);
  const out = [
    `model-family: ${fam}`,
    `implementer-family: ${impl}`,
    ...(sameOk ? [dec.header] : []),
    '',
    `# Review of ${id}: ${g.task.title}`,
    '',
    `Outside reviewer: ${by} (${fam}${model ? `, ${model}` : ''}), done outside the harness; recorded by ${String(env.STUDIO_LOCK_OWNER || env.USER || env.USERNAME || 'a person').trim()} with npm run review -- record. Builder: ${g.builder}. Commits: ${g.commits.map((c) => c.hash.slice(0, 7)).join(', ')}.`,
    '',
    `Verdict: ${verdict}`,
    '',
    '## Reviewer notes',
    '',
    body || '(none)',
    '',
  ].join('\n');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, out);
  const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
  emitEvent({ type: 'review.recorded', agent: String(env.STUDIO_LOCK_OWNER || 'person'), task: id, to: 'producer', msg: `${id}: a review by ${by} (${fam}, outside the harness) was recorded: ${verdict}`, meta: { by, family: fam, model, verdict, file: rel } });
  settleOwed(id);
  let committed = null;
  if (!noCommit) {
    const git = (...a) => spawnSync('git', a, { windowsHide: true, cwd: REPO_ROOT, encoding: 'utf8' });
    const add = git('add', '--', rel);
    const c = add.status === 0 ? git('commit', '-m', `Review: ${id} by ${by} (${fam}, outside the harness): ${verdict}`, '--', rel) : add;
    committed = c.status === 0;
    if (!committed) return { ok: true, file: rel, verdict, committed: false, sameFamilyNote: sameOk ? dec.note : '', warn: `written but not committed: ${String(c.stderr || c.stdout).trim().split('\n').slice(-3).join(' | ')}` };
  }
  return { ok: true, file: rel, verdict, committed, sameFamilyNote: sameOk ? dec.note : '' };
}

/**
 * 2.84 (g): who may flip the same-family switch, and how the change is recorded. It loosens a check, so it is judged as a protected decision ('tests'), and the verdict is
 * the harness's one (permission.mjs mayDecide, as for an engine push): a person's terminal, the owner's proxy, a beta-mode
 * agent or outside signer, an outside agent, and a Producer/Director session only where the owner lets them make protected decisions; never a worker
 * session or a worker's name, under any --by. Returns { ok, by, via } or { ok: false, why }.
 */
export async function sameFamilyActor(by, { env = process.env, root = REPO_ROOT } = {}) {
  const who = String(by || '').trim();
  const me = String(env.STUDIO_LOCK_OWNER || '').trim();
  const actor = actorOf({ env, root });
  const no = (why) => ({ ok: false, why: `Refused: ${why}. The same-family switch loosens a check: ${SAME_FAMILY_COMMAND.split(' --by')[0]} is for the owner, the overseer or an outside signer; a worker session hands the task back (npm run task -- pause <ID> --note "...") and asks one of them.` });
  if (actor.tier === 'worker') return no(`${me || (env.STUDIO_ROLE ? `a launched ${env.STUDIO_ROLE} session` : 'this session')} is a worker`);
  if ((who && !permittedSetter(who)) || (me && !permittedSetter(me))) return no(`${who || me} is a worker name`);
  // It loosens a check, so it is judged as a protected decision ('tests'): the owner, the owner's stand-ins and outside
  // agents; a Producer or Director session only with the owner's STUDIO_PRODUCER_APPROVES=protected.
  const d = mayDecide('tests', actor, { root });
  if (!d.ok) return no(d.why);
  // Recorded as the stand-in's own (the proxy, a beta-mode agent, an outside signer), the same way ask.mjs records an answer.
  let s = null;
  try { s = (await import('./ask.mjs')).ownerStandIn(env, { by: who, kind: 'board' }); } catch { /* not a stand-in */ }
  if (s?.refused) return no(s.refused);
  if (s?.agent) return { ok: true, by: s.agent, via: s.via };
  const role = String(env.STUDIO_ROLE || '').trim().toLowerCase();
  const marker = AGENT_SHELL.find((k) => String(env[k] || '').trim());
  return { ok: true, by: me || who || (role ? `a ${role} session` : marker ? `a coding agent (${marker})` : 'a person'), via: role || (marker || me ? 'outside agent' : 'person') };
}

/** Print form: the setting, who set it and when, and the families configured. */
export function sameFamilyText({ root = studioRoot(), env = process.env } = {}) {
  const sw = readSameFamily({ root });
  const c = configuredFamilies({ root, env });
  const fams = c.families.length ? c.families.map((f) => `${f} (${c.sources[f].join(', ')})`).join('; ') : 'none found';
  const meaning = { auto: 'a same-family review counts only with the header and no other family configured', on: 'a same-family review counts (the reviewer still writes the header)', off: 'a same-family review never counts' }[sw.value];
  return [`Same-family review: ${sw.value}${sw.set ? ` (set by ${sw.by}${sw.at ? ` on ${sw.at.slice(0, 16).replace('T', ' ')} UTC` : ''}${sw.why ? `: ${sw.why}` : ''})` : ' (no studio/review.json: the default)'}: ${meaning}.`, `Families configured: ${fams}.`, `Change it: ${SAME_FAMILY_COMMAND} (${'the owner, the overseer, an outside signer, or a Producer or Director session; never a worker'}).`].join('\n');
}

/** Set the switch: checks who, writes studio/review.json in the main checkout, one decisions-log line, one review.same_family event. */
export async function setSameFamily(value, { by, why = '', env = process.env, root = studioRoot() } = {}) {
  const v = String(value || '').trim().toLowerCase();
  if (!['on', 'off', 'auto'].includes(v)) return { ok: false, message: 'Say on, off or auto: npm run review -- same-family on|off|auto --by <who> [--why "..."]' };
  const a = await sameFamilyActor(by, { env, root });
  if (!a.ok) return { ok: false, message: a.why };
  if (!String(by || '').trim() && a.via === 'person') return { ok: false, message: 'Say who changed it: --by <name>.' };
  const was = readSameFamily({ root }).value;
  const at = new Date().toISOString();
  const rec = { sameFamily: v, by: a.by, at, why: String(why || '').replace(/\s+/g, ' ').trim().slice(0, 300), ...(a.via !== 'person' ? { via: a.via } : {}) };
  const f = path.join(root, 'studio', 'review.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `${JSON.stringify(rec, null, 2)}\n`);
  const line = `Same-family reviews ${v === 'auto' ? 'back to auto' : v} (was ${was}), set by ${a.by}${a.via !== 'person' ? ` (${a.via})` : ''}${rec.why ? `: ${rec.why}` : ''}`;
  try { const { logDecision } = await import('./decisions-log.mjs'); logDecision({ action: 'same-family-review', subject: SAME_FAMILY_FILE_REL, by: a.by, as: a.via === 'person' ? 'person' : `agent (${a.via})`, why: `${was} -> ${v}${rec.why ? `: ${rec.why}` : ''}`, undo: { kind: 'text', text: `npm run review -- same-family ${was} --by <name>` }, root }); } catch { /* the file is written; the log is best effort */ }
  emitEvent({ type: 'review.same_family', agent: a.by, to: 'producer', msg: line, meta: { to: v, was, by: a.by, via: a.via } });
  return { ok: true, value: v, was, by: a.by, via: a.via, line };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const id = argv.find((a) => /^T-\d+$/.test(a));
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  if (argv[0] === 'same-family') {
    const word = argv[1] && !argv[1].startsWith('--') ? argv[1] : null;
    if (!word) { console.log(sameFamilyText()); process.exit(0); }
    // (This file's command line already awaits further down, so awaiting here adds no top-level-await risk.)
    const r = await setSameFamily(word, { by: flag('by'), why: flag('why') || '' }).catch((e) => ({ ok: false, message: `same-family failed: ${e?.message || e}` }));
    (r.ok ? console.log : console.error)(r.ok ? r.line : r.message);
    process.exit(r.ok ? 0 : 1);
  } else if (argv[0] === 'record') {
    const rid = argv.find((a) => /^[A-Z]+-\d+$/.test(a));
    if (!rid) {
      console.error('Usage: npm run review -- record <TASK_ID> --by <reviewer name> --family <xai|deepseek|openai|google|anthropic|…> --file <review.md> [--model <m>] [--no-commit]');
      process.exit(1);
    }
    const r = recordOutsideReview(rid, { by: flag('by'), family: flag('family'), file: flag('file'), model: flag('model'), implementer: flag('implementer'), noCommit: argv.includes('--no-commit') });
    if (!r.ok) { console.error(r.error); process.exit(1); }
    console.log(`${rid}: ${r.verdict}, recorded from ${flag('by')} (outside the harness). Written to ${r.file}${r.committed ? ' and committed' : r.warn ? `; ${r.warn}` : ''}`);
    if (r.sameFamilyNote) console.log(`Same-family review ${r.sameFamilyNote}.`);
    process.exit(r.warn ? 1 : 0);
  }
  if (!id) {
    console.error('Usage: npm run review -- <TASK_ID> [--local] [--implementer <model>] [--dry-run]');
    process.exit(1);
  }
  const g = gather(id, { implementer: flag('implementer') });
  if (g.error) {
    console.error(g.error);
    process.exit(1);
  }
  const chain = argv.includes('--local') ? ['ollama-local'] : null;
  if (argv.includes('--dry-run')) {
    console.log(`Would send ${id} (${g.commits.length} commits, ${g.diff.length} characters of diff, ${g.specs.length} spec) to ${chain ? 'your local Ollama model' : 'the reviewer chain'}; builder ${g.builder} (${modelFamily(g.builder)}).`);
    process.exit(0);
  }
  // With no router keys at all, go straight to an agent CLI (no 503 card); if the router fails, try one too.
  const routerReady = chain || getRouterMatrix('reviewer').some((p) => (p.channels || []).length);
  let r = routerReady ? await routeChatCompletion({ role: 'reviewer', customChain: chain, messages: prompt(g), task: id, maxTokens: 1200 }) : { ok: false, error: 'no router keys for the reviewer' };
  if (!r.ok && !chain && !argv.includes('--router-only')) {
    const c = await cliReview(g, prompt(g));
    if (c.ok) {
      emitEvent({ type: 'review.cli', agent: `reviewer:${c.tool}`, task: id, msg: `${id} reviewed through ${c.tool} (${r.error ? `router: ${String(r.error).slice(0, 80)}` : 'no router'})` });
      r = c;
    } else r = { ...r, error: `${r.error || 'router failed'}; agent CLIs: ${c.error}` };
  }
  if (!r.ok) {
    const why = r.error || r.attempts?.map((a) => `${a.providerId}: ${a.reason || a.status}`).join('; ');
    const next = chain ? null : await oweReview(id, why, g.builder);
    console.error(`No reviewer answered: ${why}${chain ? '\nIs Ollama running (ollama serve) with the model in OLLAMA_MODEL pulled?' : `\nThe review is owed (studio/reviews/OWED.json): the watcher tries again at ${next.slice(11, 16)} UTC.`}`);
    process.exit(1);
  }
  if (modelFamily(r.model) === modelFamily(g.builder)) {
    console.error(`The reviewer (${r.model}) is the same family as the builder (${g.builder}). Nothing written; use --local or another provider.`);
    process.exit(1);
  }
  const w = writeReview(g, r);
  settleOwed(id);
  console.log(`${id}: ${w.verdict} from ${r.model}. Written to ${w.file}`);
  process.exit(0);
}
