#!/usr/bin/env node
/**
 * harness/rehearsal.mjs — rehearsal mode: proves orchestration with a fake model and agent.
 *
 * `npm run rehearse -- [--tasks N]` (or STUDIO_REHEARSAL=1 for the launcher and router) runs a loop that takes tasks from the board and runs the
 * rehearsal agent on them. This tests the whole orchestration flow (claim, lock, done, hand-back,
 * events) without using any model tokens.
 *
 * The rehearsal model returns scripted, deterministic replies with zero token cost.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, readRecentEvents } from './event.mjs';
import { nextFor } from './task.mjs';

const SCRIPT_FILE = path.join(REPO_ROOT, 'studio', 'rehearsal', 'script.json');

const DEFAULT_SCRIPT = {
  producer: ['Okay, I will do that.', 'Understood.', 'Acknowledged.'],
  builder: ['Right away.', 'On it.', 'Starting work now.'],
  director: ['Action.', 'Rolling.', 'Lets see.'],
  planner: ['Planning.', 'Thinking.', 'I have a plan.'],
  reviewer: ['I will review this.', 'Checking now.', 'Looks good.'],
  rnd: ['Experimenting.', 'Researching.', 'Let me try something.'],
  liaison: ['I will pass this on.', 'Noted.', 'Forwarding.'],
};

let script = DEFAULT_SCRIPT;
if (fs.existsSync(SCRIPT_FILE)) {
  try {
    script = { ...DEFAULT_SCRIPT, ...JSON.parse(fs.readFileSync(SCRIPT_FILE, 'utf8')) };
  } catch (e) {
    console.error(`[rehearsal] Could not parse ${SCRIPT_FILE}: ${e.message}`);
  }
}

const counters = {}; // role -> index

/** Returns a scripted reply for a given role, cycling through available replies. */
export function getScriptedReply({ role = 'producer' }) {
  const replies = script[role] || script.producer;
  if (!replies || replies.length === 0) return { content: '...' };

  counters[role] = (counters[role] || 0) % replies.length;
  const content = replies[counters[role]];
  counters[role]++;

  return { content };
}

/**
 * Run up to `tasks` builder tasks from the board through the real launcher (harness/agent.mjs start)
 * with the rehearsal agent: claim, lock, work, done, session events. No model is called.
 */
export function rehearse({ tasks = 1, env = process.env, log = console.log } = {}) {
  const before = readRecentEvents(1000000).length;
  const stats = { started: 0, done: 0, handedBack: 0, events: 0, tokens: 0, failed: [] };
  for (let i = 0; i < tasks; i++) {
    const { task } = nextFor({ role: 'builder' });
    if (!task) {
      log('[rehearsal] no more builder tasks on the board');
      break;
    }
    const agent = `builder-rehearsal-${Date.now().toString(36)}-${i + 1}`;
    stats.started++;
    log(`[rehearsal] ${agent} takes ${task.id}: ${task.title}`);
    const r = spawnSync(process.execPath, ['harness/agent.mjs', 'start', '--role', 'builder', '--agent', agent, '--task', task.id, '--model', 'rehearsal'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...env, STUDIO_REHEARSAL: '1', STUDIO_HEARTBEAT_SEC: env.STUDIO_HEARTBEAT_SEC || '1' },
      timeout: 120000,
    });
    if (r.status !== 0) stats.failed.push(`${task.id}: launcher exit ${r.status} ${String(r.stderr || r.stdout || '').trim().split('\n').pop()}`);
  }
  const fresh = readRecentEvents(1000000).slice(before);
  stats.events = fresh.length;
  for (const e of fresh) {
    if (e.type === 'task.done') stats.done++;
    if (e.type === 'task.handback' || e.type === 'task.hand-back' || e.type === 'task.paused') stats.handedBack++;
    if (e.type === 'agent.session.end' || e.type === 'route.success') stats.tokens += Number(e.tokensIn || 0) + Number(e.tokensOut || 0);
  }
  return stats;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
  const st = rehearse({ tasks: Number(opt('tasks', 1)) || 1 });
  console.log(`[rehearsal] summary: ${st.started} started, ${st.done} done, ${st.handedBack} handed back, ${st.events} events, model tokens ${st.tokens}`);
  for (const f of st.failed) console.log(`  failed ${f}`);
  process.exit(st.started && st.done === st.started && !st.failed.length ? 0 : 1);
}
