#!/usr/bin/env node
/**
 * harness/closed-loop.mjs — Tight Closed-Loop Test -> Auto-Bug -> Escalate Gate
 *
 * Flow:
 *   1. Run purity + stage-1 playtest.
 *   2. On PASS: reset counter.
 *   3. On FAIL:
 *        - Write studio/templates-compatible seed failure to .studio/last-seed-failure.json
 *        - Open bug report
 *        - After MAX_FIX_ATTEMPTS (default 3) escalate instead of looping
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
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch {
    // ignore
  }
  return { consecutiveFailures: 0, lastSeed: 42069, lastTick: 120, escalated: false };
}

function writeLoopState(next) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), 'utf8');
}

function writeSeedFailure(payload) {
  fs.mkdirSync(path.dirname(SEED_FAILURE_FILE), { recursive: true });
  fs.writeFileSync(SEED_FAILURE_FILE, JSON.stringify(payload, null, 2), 'utf8');
}

const simulateFail = process.argv.includes('--simulate-fail');
const loopState = readLoopState();

let passed = !simulateFail;
let failureReason = simulateFail ? 'Simulated invariant drift at tick 120' : '';

if (!simulateFail) {
  try {
    execSync('node scripts/check-sim-purity.mjs && node qa/playtest.mjs --stage 1', {
      cwd: REPO_ROOT,
      stdio: 'pipe',
    });
    passed = true;
  } catch (err) {
    passed = false;
    failureReason = String(err.stderr || err.stdout || err.message).slice(0, 300);
  }
}

if (passed) {
  writeLoopState({ consecutiveFailures: 0, lastSeed: 42069, lastTick: 120, escalated: false });
  emitEvent({
    type: 'closedloop.pass',
    agent: 'playtester',
    status: 'IDLE',
    msg: 'Closed-loop verification PASSED.',
  });
  console.log('[closed-loop] PASS');
  process.exit(0);
}

const attempt = loopState.consecutiveFailures + 1;
const escalated = attempt >= MAX_RETRIES;
const seed = 42069;
const tick = 120;

writeLoopState({
  consecutiveFailures: attempt,
  lastSeed: seed,
  lastTick: tick,
  escalated,
  updatedAt: new Date().toISOString(),
});

const seedPayload = {
  seed,
  tick,
  description: failureReason.replace(/\n/g, ' ').slice(0, 200),
  severity: 'P0',
  attempt,
  maxAttempts: MAX_RETRIES,
};
writeSeedFailure(seedPayload);

const bugId = `BUG-${Date.now().toString().slice(-4)}`;
const bugReportPath = path.join(REPO_ROOT, 'qa', 'reports', `${bugId}.md`);
fs.mkdirSync(path.dirname(bugReportPath), { recursive: true });

const bugMarkdown = `### [P0] ${bugId} — Closed-Loop Failure (Attempt ${attempt}/${MAX_RETRIES})
- **Replay**: \`node harness/replay.mjs --seed ${seed} --tick ${tick}\`
- **Seed file**: \`.studio/last-seed-failure.json\`
- **Escalated**: ${escalated ? 'YES — stop auto-retries, use stronger model or human' : 'no'}
- **Description**: ${seedPayload.description}

After fix, run \`scripts/distill-bug.sh\` or append to \`studio/memory/failures.md\`.
`;

fs.writeFileSync(bugReportPath, bugMarkdown, 'utf8');

if (attempt === 1) {
  addTask({
    title: `Fix ${bugId} (replay seed ${seed} tick ${tick})`,
    role: 'builder',
    priority: 'P0',
  });
}

emitEvent({
  type: escalated ? 'closedloop.escalate' : 'closedloop.retry',
  agent: 'playtester',
  status: 'ERROR',
  task: bugId,
  msg: escalated
    ? `ESCALATED after ${attempt}/${MAX_RETRIES}`
    : `Failure ${attempt}/${MAX_RETRIES} recorded`,
});

console.log(bugMarkdown);
console.log('\nSeed failure written to .studio/last-seed-failure.json');
if (escalated) {
  console.log('ESCALATE: do not keep auto-retrying. Run prepare-brief or hand to human.');
}
process.exit(1);
