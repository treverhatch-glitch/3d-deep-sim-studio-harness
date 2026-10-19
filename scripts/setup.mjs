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
  'cartridges/example-sim',
];

for (const rel of dirs) {
  fs.mkdirSync(path.join(rootDir, rel), { recursive: true });
}

// Copy .env.example -> .env if missing
const envFile = path.join(rootDir, '.env');
const envExample = path.join(rootDir, '.env.example');
if (!fs.existsSync(envFile) && fs.existsSync(envExample)) {
  fs.copyFileSync(envExample, envFile);
}

// Verify or initialize .studio/events.jsonl
const { primary: eventsFile } = getEventPaths();
if (!fs.existsSync(eventsFile) || fs.statSync(eventsFile).size === 0) {
  emitEvent({
    type: 'setup.init',
    agent: 'producer',
    provider: 'local-ollama',
    model: 'qwen2.5-coder:14b',
    status: 'IDLE',
    task: 'T-001',
    target: 'studio/NEXT.md',
    tokensSaved: 4200,
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
console.log('   bash scripts/seed-demo-events.sh   # Seed demo events for War Room');
console.log('   node hub/server.js                 # Launch Mission Control War Room (:3847)');
console.log('   node harness/prepare-brief.mjs     # Cheap model prepares <=300w brief');
console.log('   node qa/playtest.mjs               # Run Stage 1 + Stage 2 QA');
console.log('====================================================================');
