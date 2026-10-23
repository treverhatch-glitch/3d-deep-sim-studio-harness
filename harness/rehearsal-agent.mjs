#!/usr/bin/env node
/**
 * harness/rehearsal-agent.mjs — a stand-in agent for rehearsal mode.
 *
 * Takes a task, writes a doc to prove it ran, then marks the task done.
 * Reports zero token usage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [agent, task, status] = process.argv.slice(2);

if (!agent || !task || status !== 'ok') {
  console.error('Usage: node harness/rehearsal-agent.mjs <agent> <task> ok');
  process.exit(1);
}

const sh = (...a) => spawnSync(process.execPath, a, { encoding: 'utf8', env: process.env });

// It claims the task like a real agent.
const st = sh('harness/task.mjs', 'start', task, '--agent', agent, '--model', 'rehearsal');
if (st.status !== 0) {
  console.error(`[rehearsal-agent] could not start ${task}: ${st.stdout}${st.stderr}`);
  process.exit(1);
}

// The agent does some "work" to prove it ran.
const docDir = 'docs/rehearsal';
fs.mkdirSync(docDir, { recursive: true });
fs.writeFileSync(path.join(docDir, `${agent}.md`), `# Rehearsal work by ${agent} for ${task}\n\nFinished at ${new Date().toISOString()}.\n`);

// It reports zero token usage.
console.log(JSON.stringify({ usage: { input_tokens: 0, output_tokens: 0 } }));

// It marks the task as done.
const res = sh('harness/task.mjs', 'done', task, '--agent', agent, '--force', '--reason', 'rehearsal run (no model)', '--accepted-by', 'rehearsal');
if (res.status !== 0) {
  console.error(`[rehearsal-agent] Failed to mark task ${task} as done.`);
  console.error(res.stderr);
  process.exit(1);
}

process.exit(0);
