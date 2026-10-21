#!/usr/bin/env node
// A one-line status event for the War Room, for tools that can't call harness/event.mjs with flags.
//   node scripts/append-event.mjs STATUS [file] [taskId] [worker]
// AGENT and WORKER can come from the environment. It records no "tokens saved".
import { emitEvent } from '../harness/event.mjs';

const [status = 'RUNNING', file = '', task = '', workerArg] = process.argv.slice(2);
const worker = workerArg || process.env.WORKER || null;
const agent = process.env.AGENT || process.env.STUDIO_AGENT || 'producer';
emitEvent({
  type: status.toLowerCase(),
  agent,
  provider: worker,
  status,
  file: file || null,
  task: task || null,
  msg: `${status}${file ? ` (${file})` : ''}${task ? ` [${task}]` : ''}`,
});
console.log(`Event logged to .studio/events.jsonl: ${status} (agent=${agent}${worker ? `, worker=${worker}` : ''})`);
