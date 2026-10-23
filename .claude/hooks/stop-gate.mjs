#!/usr/bin/env node
// 2.30g: Stop hook. A launched agent with changed files can't end its turn until the fast (lite) gates pass.
// Fast-only: the whole hook has a hard budget of a few seconds. If the checks don't finish in time they
// are skipped (fail open), so the hook can never hold an agent up; the full gates still run at hand-off.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ALLOWED_CHANGE_PREFIXES = ['studio/', '.studio/'];
const GATES_JSON = 'studio/gates.json';
const RUN_GATES_SCRIPT = 'scripts/run-gates.mjs';
const BUDGET_MS = Number(process.env.STUDIO_STOP_GATE_MS) > 0 ? Math.min(Number(process.env.STUDIO_STOP_GATE_MS), 8000) : 6000;

async function main() {
  try {
    if (process.env.STUDIO_STOP_GATE === 'off' || !process.env.STUDIO_LOCK_OWNER) {
      process.exit(0);
    }

    const input = JSON.parse(await readStdin());
    if (input.stop_hook_active) process.exit(0);

    const gitStatus = await runCommand('git', ['status', '--porcelain'], 1500);
    if (gitStatus.code !== 0) process.exit(0);

    const changedFiles = gitStatus.stdout.trim().split('\n').map(line => line.slice(3).split(' -> ').pop().replace(/^"|"$/g, '')).filter(Boolean);
    const hasUnsafeChanges = changedFiles.some(file => !ALLOWED_CHANGE_PREFIXES.some(prefix => file.startsWith(prefix)));

    if (!hasUnsafeChanges) process.exit(0);

    const liteGates = getLiteGates();
    if (!liteGates.length) process.exit(0);

    const gateResult = await runCommand('node', [RUN_GATES_SCRIPT, '--only', liteGates.join(',')], Math.max(500, BUDGET_MS - (Date.now() - STARTED) - 500));

    // Passed, or ran out of time / was killed: never block on a check that didn't finish.
    if (gateResult.code === 0 || gateResult.timedOut) process.exit(0);

    let failingGates = [...gateResult.stdout.matchAll(/\[gates\] FAIL (\S+)/g)].map((m) => m[1]) ; if (!failingGates.length) failingGates.push('see the last lines');
    const lastLines = (gateResult.stdout + gateResult.stderr).split('\n').slice(-25).join('\n');
    const reason = `Fast checks failed: ${failingGates.join(', ')}. Fix them (or hand the task back with \`node harness/task.mjs pause …\`) before you stop. Last lines:\n${lastLines}`;

    console.log(JSON.stringify({ decision: 'block', reason }));
  } catch (e) {
    process.exit(0);
  }
}

function getLiteGates() {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), GATES_JSON), 'utf8'));
    const lite = config.gates?.filter(g => g.lite).map(g => g.id);
    return (lite?.length) ? lite : ['purity', 'golden', 'regressions'];
  } catch {
    return ['purity', 'golden', 'regressions'];
  }
}

function runCommand(cmd, args, timeout = 30000) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { timeout, killSignal: 'SIGKILL', shell: false, cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd() });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (c) => (stdout += c));
    proc.stderr.on('data', (c) => (stderr += c));
    proc.on('close', (code, signal) => resolve({ code, stdout, stderr, timedOut: code === null || Boolean(signal) }));
    proc.on('error', () => resolve({ code: -1, stdout, stderr }));
  });
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', chunk => (data += chunk));
    process.stdin.on('end', () => resolve(data));
  });
}

const STARTED = Date.now();
const timeout = setTimeout(() => process.exit(0), BUDGET_MS);
main().finally(() => clearTimeout(timeout));
