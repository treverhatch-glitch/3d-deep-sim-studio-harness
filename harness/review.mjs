#!/usr/bin/env node
/**
 * harness/review.mjs — a second opinion from a model made by another company, in one command.
 *
 *   npm run review -- <TASK_ID> [--local] [--implementer <model>] [--dry-run]
 *
 * Gathers the task, its spec (for system tasks) and the diff of every commit tagged with it, sends
 * them to the reviewer chain through the router (--local: only your Ollama model, free and offline),
 * and writes studio/reviews/<date>-<ID>-<model>.md with `model-family:` and `implementer-family:`
 * lines and one verdict. The done-check for system tasks and the reviewer gate read that file.
 * It refuses when the reviewer would be the same family as the builder.
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
import { routeChatCompletion } from './route.mjs';
import { scrub } from './secrets.mjs';

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
  return { task, type: taskType(task), builder, commits, specs, diff, cut };
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
      content: `Task ${g.task.id} (${g.type}): ${g.task.title}\nBuilt by: ${g.builder}\n\n${spec ? `Spec:\n${spec}\n\n` : ''}Changes (${g.commits.length} commit${g.commits.length === 1 ? '' : 's'}${g.cut ? `, first ${DIFF_CAP} characters` : ''}):\n${g.diff}`,
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
  const r = await routeChatCompletion({ role: 'reviewer', customChain: chain, messages: prompt(g), task: id, maxTokens: 1200 });
  if (!r.ok) {
    console.error(`No reviewer answered: ${r.error || r.attempts?.map((a) => `${a.providerId}: ${a.reason || a.status}`).join('; ')}${chain ? '\nIs Ollama running (ollama serve) with the model in OLLAMA_MODEL pulled?' : ''}`);
    process.exit(1);
  }
  if (modelFamily(r.model) === modelFamily(g.builder)) {
    console.error(`The reviewer (${r.model}) is the same family as the builder (${g.builder}). Nothing written; use --local or another provider.`);
    process.exit(1);
  }
  const w = writeReview(g, r);
  console.log(`${id}: ${w.verdict} from ${r.model}. Written to ${w.file}`);
  process.exit(0);
}
