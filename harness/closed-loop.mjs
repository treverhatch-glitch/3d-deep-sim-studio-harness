#!/usr/bin/env node
/**
 * harness/closed-loop.mjs — fail -> record real seed/tick -> escalate
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { REPO_ROOT, STUDIO_STATE_DIR, emitEvent } from './event.mjs';
import { addTask } from './task.mjs';

const STATE_FILE = path.join(STUDIO_STATE_DIR, 'closed-loop-state.json');
const SEED_FAILURE_FILE = path.join(STUDIO_STATE_DIR, 'last-seed-failure.json');
const MAX_RETRIES = Number(process.env.CLOSED_LOOP_MAX_RETRIES || process.env.MAX_FIX_ATTEMPTS || 3);

function readLoopState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {}
  return { consecutiveFailures: 0, escalated: false };
}

function writeLoopState(next) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), 'utf8');
}

function writeSeedFailure(payload) {
  fs.mkdirSync(path.dirname(SEED_FAILURE_FILE), { recursive: true });
  fs.writeFileSync(SEED_FAILURE_FILE, JSON.stringify(payload, null, 2), 'utf8');
}

function extractFailure(stdout) {
  const fallback = { seed: null, tick: null, description: 'Playtest failed', actions: [] };
  try {
    const parsed = JSON.parse(stdout);
    const stage1 = parsed.stage1 || parsed;
    return {
      seed: stage1.seed ?? parsed.seed ?? null,
      tick: stage1.ticksRun ?? stage1.tick ?? parsed.tick ?? null,
      description: (stage1.findings?.[0]?.summary) || parsed.message || 'Playtest failed',
      actions: stage1.actions || [],
      hash: stage1.finalHash || null,
    };
  } catch {
    const seedMatch = stdout.match(/seed[=:]\s*(\d+)/i);
    const tickMatch = stdout.match(/tick[s]?[=:]\s*(\d+)/i);
    return {
      ...fallback,
      seed: seedMatch ? Number(seedMatch[1]) : null,
      tick: tickMatch ? Number(tickMatch[1]) : null,
      description: stdout.slice(0, 200),
    };
  }
}

const simulateFail = process.argv.includes('--simulate-fail');
const loopState = readLoopState();

let passed = !simulateFail;
let failure = { seed: 1337, tick: 0, description: 'Simulated failure', actions: [] };

if (!simulateFail) {
  try {
    const out = execSync('node qa/playtest.mjs --stage 1', {
      cwd: REPO_ROOT,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    passed = true;
  } catch (err) {
    passed = false;
    const stdout = String(err.stdout || '');
    const stderr = String(err.stderr || err.message || '');
    failure = extractFailure(stdout || stderr);
  }
}

if (passed) {
  writeLoopState({ consecutiveFailures: 0, escalated: false });
  emitEvent({ type: 'closedloop.pass', agent: 'playtester', status: 'IDLE', msg: 'Closed-loop PASS' });
  console.log('[closed-loop] PASS');
  process.exit(0);
}

const attempt = (loopState.consecutiveFailures || 0) + 1;
const escalated = attempt >= MAX_RETRIES;

writeLoopState({
  consecutiveFailures: attempt,
  lastSeed: failure.seed,
  lastTick: failure.tick,
  escalated,
  updatedAt: new Date().toISOString(),
});

const seedPayload = {
  seed: failure.seed,
  tick: failure.tick,
  description: String(failure.description || '').replace(/\n/g, ' ').slice(0, 240),
  actions: failure.actions || [],
  severity: 'P0',
  attempt,
  maxAttempts: MAX_RETRIES,
};
writeSeedFailure(seedPayload);

const bugId = `BUG-${Date.now().toString().slice(-4)}`;
const bugReportPath = path.join(REPO_ROOT, 'qa', 'reports', `${bugId}.md`);
fs.mkdirSync(path.dirname(bugReportPath), { recursive: true });
const replayCmd = failure.seed != null
  ? `node harness/replay.mjs --seed ${failure.seed} --tick ${failure.tick || 0}`
  : 'node harness/replay.mjs';

const bugMarkdown = `### [P0] ${bugId} — Closed-Loop Failure (Attempt ${attempt}/${MAX_RETRIES})
- **Replay**: \`${replayCmd}\`
- **Seed file**: \`.studio/last-seed-failure.json\`
- **Seed**: ${failure.seed}
- **Tick**: ${failure.tick}
- **Escalated**: ${escalated ? 'YES' : 'no'}
- **Description**: ${seedPayload.description}
`;
fs.writeFileSync(bugReportPath, bugMarkdown, 'utf8');

if (attempt === 1) {
  addTask({
    title: `Fix ${bugId} (seed ${failure.seed} tick ${failure.tick})`,
    role: 'builder',
    priority: 'P0',
  });
}

emitEvent({
  type: escalated ? 'closedloop.escalate' : 'closedloop.retry',
  agent: 'playtester',
  status: 'ERROR',
  task: bugId,
  msg: escalated ? `ESCALATED after ${attempt}/${MAX_RETRIES}` : `Failure ${attempt}/${MAX_RETRIES}`,
});

console.log(bugMarkdown);
if (escalated) console.log('ESCALATE: stop auto-retries.');
process.exit(1);
