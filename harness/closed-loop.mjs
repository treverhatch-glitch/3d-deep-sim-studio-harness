#!/usr/bin/env node
/**
 * harness/closed-loop.mjs — playtest -> record the failing tick -> escalate. It never edits code.
 *
 *   node harness/closed-loop.mjs [--cartridge name] [--scenario start-to-win] [--seed 1337]
 *   node harness/closed-loop.mjs --simulate-fail      (CI proof that the loop records and exits 1)
 *
 * On failure it writes .studio/last-seed-failure.json with the cartridge, seed, the failing tick the
 * cartridge reported, and every action taken, so `node harness/replay.mjs --trace` stops on that tick.
 * After MAX_FIX_ATTEMPTS consecutive failures it marks the bug escalated for a person or stronger model.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPO_ROOT, STUDIO_STATE_DIR, emitEvent } from './event.mjs';
import { addTask } from './task.mjs';
import { cartridgeFromArgv } from './cartridge.mjs';

const STATE_FILE = path.join(STUDIO_STATE_DIR, 'closed-loop-state.json');
const SEED_FAILURE_FILE = path.join(STUDIO_STATE_DIR, 'last-seed-failure.json');
const REPORT_FILE = path.join(STUDIO_STATE_DIR, 'last-playtest.json');
const MAX_RETRIES = Number(process.env.CLOSED_LOOP_MAX_RETRIES || process.env.MAX_FIX_ATTEMPTS || 3);

const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const simulateFail = argv.includes('--simulate-fail');
const cartridge = cartridgeFromArgv(argv);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

let failure = null;
if (simulateFail) {
  failure = {
    cartridge,
    scenario: null,
    seed: 1337,
    tick: 1,
    description: 'Simulated failure (--simulate-fail)',
    actions: [{ tick: 1, action: { type: 'spawn', kind: 'sensor' } }],
    hash: null,
  };
} else {
  const args = [path.join(REPO_ROOT, 'qa', 'playtest.mjs'), '--stage', '1', '--quiet', '--out', REPORT_FILE];
  if (cartridge) args.push('--cartridge', cartridge);
  for (const key of ['--scenario', '--seed', '--ticks']) if (flag(key)) args.push(key, flag(key));
  try {
    fs.rmSync(REPORT_FILE, { force: true });
    execFileSync(process.execPath, args, { cwd: REPO_ROOT, stdio: 'pipe', encoding: 'utf8' });
  } catch (err) {
    const report = readJson(REPORT_FILE, null);
    const s1 = report?.stage1;
    const first = s1?.findings?.[0];
    failure = {
      cartridge: s1?.cartridge ?? cartridge,
      scenario: s1?.scenario ?? null,
      seed: s1?.seed ?? null,
      tick: s1?.failingTick ?? null,
      description: first ? `${first.id}: ${first.summary}` : String(err.stderr || err.message || 'playtest failed').slice(0, 240),
      actions: s1?.actions || [],
      hash: s1?.finalHash ?? null,
    };
  }
}

if (!failure) {
  writeJson(STATE_FILE, { consecutiveFailures: 0, escalated: false });
  emitEvent({ type: 'closedloop.pass', agent: 'playtester', status: 'IDLE', msg: `Closed-loop PASS (${cartridge})` });
  console.log('[closed-loop] PASS');
  process.exit(0);
}

const loopState = readJson(STATE_FILE, { consecutiveFailures: 0 });
const attempt = (loopState.consecutiveFailures || 0) + 1;
const escalated = attempt >= MAX_RETRIES;
writeJson(STATE_FILE, {
  consecutiveFailures: attempt,
  lastSeed: failure.seed,
  lastTick: failure.tick,
  escalated,
  updatedAt: new Date().toISOString(),
});

const description = String(failure.description || '').replace(/\n/g, ' ').slice(0, 240);
// The trace stops at the failing tick: replaying it reproduces the failure, not a longer run.
const trace = {
  cartridge: failure.cartridge,
  seed: failure.seed,
  tick: failure.tick,
  description,
  actions: (failure.actions || []).filter((a) => failure.tick == null || a.tick <= failure.tick),
  severity: 'P0',
  attempt,
  maxAttempts: MAX_RETRIES,
};
writeJson(SEED_FAILURE_FILE, trace);

const bugId = `BUG-${new Date().toISOString().replace(/\D/g, '').slice(2, 14)}-${failure.seed ?? 'x'}`;
const bugReportPath = path.join(REPO_ROOT, 'qa', 'reports', `${bugId}.md`);
const replayCmd = 'node harness/replay.mjs --trace .studio/last-seed-failure.json';
const bugMarkdown = `### [P0] ${bugId} — closed-loop failure (attempt ${attempt}/${MAX_RETRIES})
- **Cartridge**: ${failure.cartridge}${failure.scenario ? ` · scenario ${failure.scenario}` : ''}
- **Seed**: ${failure.seed}
- **Failing tick**: ${failure.tick ?? 'unknown (playtest did not report one)'}
- **Replay**: \`${replayCmd}\`
- **Escalated**: ${escalated ? 'YES — stop retrying, hand to a person or a stronger model' : 'no'}
- **Description**: ${description}
`;
fs.mkdirSync(path.dirname(bugReportPath), { recursive: true });
fs.writeFileSync(bugReportPath, bugMarkdown, 'utf8');

if (attempt === 1 && !simulateFail) {
  addTask({ title: `Fix ${bugId} (${failure.cartridge} seed ${failure.seed} tick ${failure.tick})`, role: 'builder', priority: 'P0' });
}

emitEvent({
  type: escalated ? 'closedloop.escalate' : 'closedloop.retry',
  agent: 'playtester',
  status: 'ERROR',
  task: bugId,
  msg: escalated ? `ESCALATED after ${attempt}/${MAX_RETRIES}` : `Failure ${attempt}/${MAX_RETRIES} at tick ${failure.tick}`,
});

console.log(bugMarkdown);
if (escalated) console.log('ESCALATE: stop auto-retries.');
process.exit(1);
