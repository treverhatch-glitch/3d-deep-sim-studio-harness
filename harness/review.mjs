#!/usr/bin/env node
/**
 * harness/review.mjs — a second opinion from a model made by another company, in one command.
 *
 *   npm run review -- <TASK_ID> [--local] [--implementer <model>] [--dry-run] [--router-only]
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
import { REPO_ROOT, readRecentEvents, emitEvent } from './event.mjs';
import { parseNextQueue } from './task.mjs';
import { taskType } from './done-check.mjs';
import { taggedCommits } from './scorecard.mjs';
import { modelFamily } from './families.mjs';
import { routeChatCompletion, getRouterMatrix } from './route.mjs';
import { scrub } from './secrets.mjs';
import { spawnAgentSync } from './launch.mjs';
import { contractForReview } from './contracts.mjs';

const DIFF_CAP = 24000;
const VERDICT_WORDS = /\b(approve[sd]?|lgtm|request(ed)? changes|changes requested|reject(ed)?|blocking)\b/gi;

function diffOf(hash) {
  const r = spawnSync('git', ['show', '--format=%s%n', '--patch', hash, '--', '.', ':(exclude)studio/reviews', ':(exclude).studio', ':(exclude)package-lock.json'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : '';
}

export function gather(taskId, { implementer = null } = {}) {
  const q = parseNextQueue();
  const task = [...q.inProgress, ...q.backlog, ...q.done].find((t) => t.id === taskId);
  if (!task) return { error: `No task ${taskId} in studio/NEXT.md` };
  const commits = taggedCommits().filter((c) => c.tasks.includes(taskId));
  if (!commits.length) return { error: `No commits tagged Studio-Task: ${taskId} yet. Commit the work first (the commit-msg hook adds the tag when STUDIO_LOCK_OWNER is set).` };
  const started = readRecentEvents(50000).filter((e) => e.task === taskId && e.type === 'task.start' && e.model).at(-1);
  const builder = implementer || started?.model || commits.map((c) => c.model).filter(Boolean).at(-1) || null;
  if (!builder) return { error: `Can't tell which model built ${taskId}. Pass --implementer <model> (for example claude-opus-5-5).` };
  const specs = [...new Set(commits.flatMap((c) => c.files).filter((f) => /^studio\/bible\/systems\/.+\.md$/.test(f)))].filter((f) => fs.existsSync(path.join(REPO_ROOT, f)));
  let diff = commits.map((c) => diffOf(c.hash)).join('\n');
  const cut = diff.length > DIFF_CAP;
  diff = scrub(diff.slice(0, DIFF_CAP)).text;
  // 2.62.0 (H): the task's agreed acceptance contract, if any, so the review grades against what done means.
  return { task, type: taskType(task), builder, commits, specs, diff, cut, contract: contractForReview(taskId) };
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
  const { exhaustedUntil } = await import('./budget.mjs');
  const text = messages.map((m) => `${m.role === 'system' ? 'Instructions' : 'Review this'}:\n${m.content}`).join('\n\n');
  const tried = [];
  for (const { tool, model } of reviewerTools(g.builder)) {
    const which = run(process.platform === 'win32' ? 'where' : 'which', [tool], { encoding: 'utf8' });
    if (which.status !== 0) {
      tried.push(`${tool}: not installed`);
      continue;
    }
    if (exhaustedUntil(tool)) {
      tried.push(`${tool}: out of quota`);
      continue;
    }
    // Read-only: the reviewer looks and writes a verdict, it never edits the game.
    const argv = tool === 'claude' ? ['claude', '-p', '--output-format', 'text', '--disallowedTools', 'Bash,Edit,Write,MultiEdit,NotebookEdit', ...(model ? ['--model', model] : [])]
      : tool === 'codex' ? ['codex', 'exec', '--sandbox', 'read-only', ...(model ? ['-m', model] : []), '-']
      : tool === 'agy' || tool === 'gemini' ? [tool, '-p', text, '--print-timeout', '900s']
      : ['grok', '-p', text, ...(model ? ['-m', model] : [])];
    // P-066: no shell for the tool (harness/launch.mjs), so agy's and grok's review text arrives as one argument on
    // Windows too; text too long for the command line goes by file.
    const promptAt = argv.indexOf(text);
    const promptFile = promptAt > 0 ? path.join(REPO_ROOT, '.studio', 'review-prompt.md') : null;
    if (promptFile) {
      fs.mkdirSync(path.dirname(promptFile), { recursive: true });
      fs.writeFileSync(promptFile, text);
    }
    const opts = { cwd: REPO_ROOT, encoding: 'utf8', input: ['claude', 'codex'].includes(tool) ? text : undefined, timeout: 15 * 60000, maxBuffer: 32 * 1024 * 1024 };
    const r = run === spawnSync ? spawnAgentSync(argv, { ...opts, promptAt, promptFile }) : run(argv[0], argv.slice(1), opts);
    const out = String(r.stdout || '').trim();
    if (r.status === 0 && out) return { ok: true, model: model || TOOL_MODEL_NAME[tool], content: out, tool };
    // A reviewer that says it hit its limit is marked out until it resets, so the owed review knows when to retry.
    // 2.30 (J12): the provider's limit line on a failed run, never the review text (a review of budget code
    // that said "quota" marked the reviewer out for an hour).
    const { limitLine } = await import('./budget.mjs');
    const said = limitLine(r.stderr, r.status === 0 ? '' : r.stdout, r.status ?? 1);
    if (said && run === spawnSync) {
      const { markExhausted } = await import('./budget.mjs');
      markExhausted(tool, said);
    }
    tried.push(`${tool}: exit ${r.status}${r.stderr ? ` (${String(r.stderr).trim().split('\n').pop().slice(0, 120)})` : ''}`);
  }
  return { ok: false, error: tried.length ? tried.join('; ') : `no reviewer tool of another family than ${modelFamily(g.builder)} (set STUDIO_REVIEWER_TOOL)` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const id = argv.find((a) => /^T-\d+$/.test(a));
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
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
