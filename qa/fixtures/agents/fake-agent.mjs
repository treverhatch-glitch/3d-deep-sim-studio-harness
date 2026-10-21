#!/usr/bin/env node
// A stand-in agent for the self-test: takes a task, edits a file, then finishes, dies, or waits.
//   node qa/fixtures/agents/fake-agent.mjs <agent> <task> ok|quota|wait|chatty
// chatty: a normal session whose output mentions rate limits and quota (run #1's false "out of quota").
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
if (how === 'wait') {
  setTimeout(() => process.exit(0), 60000);
} else {
  sh('harness/task.mjs', 'done', task, '--agent', agent, '--force', '--reason', 'fake agent', '--accepted-by', 'selftest');
  if (how === 'chatty') console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done. Checked the quota and rate limit handling.', usage: { input_tokens: 10, output_tokens: 5 } }));
  process.exit(0);
}
