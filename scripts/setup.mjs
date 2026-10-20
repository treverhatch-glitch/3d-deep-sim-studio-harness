#!/usr/bin/env node
/**
 * scripts/setup.mjs — One-Command Studio Harness Setup (`npm run setup`)
 *
 * 1. Creates `.studio/`, `.studio/briefs/`, `studio/memory/`, `studio/daily/`,
 *    `studio/done/`, and `qa/reports/`.
 * 2. Initializes `.studio/events.jsonl` and verifies `.studio/usage.json` &
 *    `.studio/war-room.config.json`.
 * 3. Copies `.env.example` to `.env` if `.env` does not exist yet.
 * 4. Prints a clean readiness summary at 0% LLM token cost.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { emitEvent, getEventPaths, REPO_ROOT } from '../harness/event.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const dirs = [
  '.studio',
  '.studio/briefs',
  '.studio/runs',
  'studio/memory',
  'studio/daily',
  'studio/daily/videos',
  'studio/done',
  'qa/reports',
];

for (const rel of dirs) {
  fs.mkdirSync(path.join(rootDir, rel), { recursive: true });
}

// Copy .env.example -> .env if missing
const envFile = path.join(rootDir, '.env');
const envExample = path.join(rootDir, '.env.example');
if (!fs.existsSync(envFile) && fs.existsSync(envExample)) {
  // Fresh .env with a random HUB_TOKEN, so the War Room never runs on the public placeholder.
  const token = crypto.randomBytes(24).toString('hex');
  const text = fs.readFileSync(envExample, 'utf8').replace(/^HUB_TOKEN=.*$/m, `HUB_TOKEN=${token}`);
  fs.writeFileSync(envFile, text, { mode: 0o600 });
  console.log('[setup] wrote .env with a random HUB_TOKEN (gitignored). Open the War Room at http://127.0.0.1:3847/?token=<that value>');
}

// Install the pre-commit hook (secret scan + lock check + sim gates)
try {
  execSync('node scripts/install-hooks.mjs', { cwd: rootDir, stdio: 'inherit' });
} catch {
  console.warn('[setup] could not install git hooks; run npm run hooks:install');
}

// Verify or initialize .studio/events.jsonl
const { primary: eventsFile } = getEventPaths();
if (!fs.existsSync(eventsFile) || fs.statSync(eventsFile).size === 0) {
  emitEvent({
    type: 'setup.init',
    agent: 'producer',
    status: 'IDLE',
    target: 'studio/NEXT.md',
    msg: 'Studio harness initialized via npm run setup (event log verified)',
  });
}

// Install dependencies only if --install flag passed or requested
if (process.argv.includes('--install')) {
  console.log('[setup] Running npm install...');
  execSync('npm install', { cwd: rootDir, stdio: 'inherit' });
}

const lineCount = fs
  .readFileSync(eventsFile, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean).length;

console.log('====================================================================');
console.log(' 3D DEEP-SIM AI STUDIO HARNESS — SETUP COMPLETE');
console.log('====================================================================');
console.log(` Repo Root         : ${rootDir}`);
console.log(` Event Log Path    : ${path.relative(rootDir, eventsFile)} (${lineCount} events verified)`);
console.log(` Usage Quota File  : .studio/usage.json (${fs.existsSync(path.join(rootDir, '.studio/usage.json')) ? 'OK' : 'MISSING'})`);
console.log(` Memory Ledger     : studio/memory/failures.md (${fs.existsSync(path.join(rootDir, 'studio/memory/failures.md')) ? 'OK' : 'READY'})`);
console.log(` Env Configuration : .env (${fs.existsSync(envFile) ? 'Present (gitignored)' : 'Not created'})`);
console.log('--------------------------------------------------------------------');
console.log(' Next Commands:');
console.log('   npm run handoff                    # Producer briefing: plan, queue, health, what needs you');
console.log('   npm run hub                        # War Room on :3847 (Studio view: /v3?skin=tycoon); runs the watcher');
console.log('   npm run onboard -- --path <game> --name "<name>"   # Bring an existing game in');
console.log('   npm run verify                     # Every gate');
console.log('   node harness/prepare-brief.mjs     # Short brief from files to hand a strong model');
console.log('   node qa/playtest.mjs               # Run Stage 1 + Stage 2 QA');
console.log('====================================================================');
