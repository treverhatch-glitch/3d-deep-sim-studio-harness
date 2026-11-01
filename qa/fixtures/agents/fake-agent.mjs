#!/usr/bin/env node
// A stand-in agent for the self-test: takes a task, edits a file, then finishes, dies, or waits.
//   node qa/fixtures/agents/fake-agent.mjs <agent> <task> ok|quota|wait|chatty|agyquota|quit
// chatty: a normal session whose output mentions rate limits and quota (run #1's false "out of quota").
// agyquota: a session that ran agy itself, whose 429 is the last thing in the log (test #2).
// quit: a session that ends without task done or a hand-back (test #2: its claims sat for an hour).
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const [agent, task, how] = process.argv.slice(2);
const sh = (...a) => spawnSync(process.execPath, a, { encoding: 'utf8', env: process.env });
sh('harness/task.mjs', 'start', task, '--agent', agent, '--model', process.env.STUDIO_AGENT_MODEL || 'fake-1');
sh('harness/lock.mjs', 'claim', 'path:docs/fake', '--owner', agent);
fs.mkdirSync('docs/fake', { recursive: true });
fs.writeFileSync(`docs/fake/${agent}.md`, `# Work by ${agent}\n`);
console.log(JSON.stringify({ usage: { input_tokens: 1200, output_tokens: 300 } }));
if (how === 'chatty') {
  console.log(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' } }));
  console.log('[selftest] quota fallback: a tool out of quota is skipped until its reset');
}
if (how === 'quota') {
  console.error("You've hit your usage limit. Try again at 6:12 AM.");
  process.exit(1);
}
if (how === 'agyquota') {
  console.log('error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 80h54m54s.');
  console.log('AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 80h54m54s.","error_code":429}');
  process.exit(1);
}
if (how === 'quit') process.exit(0);
if (how === 'wait') {
  setTimeout(() => process.exit(0), 60000);
} else {
  // 2.58.5 (H-9): a custom command now runs in its own lane copy like a built-in tool (STUDIO_MAIN_ROOT is the main
  // checkout); there, as a real agent must, it commits its work before task done.
  if (process.env.STUDIO_MAIN_ROOT && fs.existsSync('.git')) {
    const git = (...a) => spawnSync('git', ['-c', `user.name=${agent}`, '-c', `user.email=${agent}@selftest.invalid`, ...a], { encoding: 'utf8', env: process.env });
    git('add', '-A', 'docs/fake');
    git('commit', '-q', '-m', `${task}: fake agent's work`);
  }
  sh('harness/task.mjs', 'done', task, '--agent', agent, '--force', '--reason', 'fake agent', '--accepted-by', 'selftest');
  if (how === 'chatty') console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done. Checked the quota and rate limit handling.', usage: { input_tokens: 10, output_tokens: 5 } }));
  process.exit(0);
}
