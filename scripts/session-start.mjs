#!/usr/bin/env node
// Session start (the Claude Code SessionStart hook and `npm run session:start`). Plain Node, so it runs
// in PowerShell and cmd.exe as well as bash: checks the session, prints the current task, runs the
// watcher and a due retro, and shows the next queued task.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (...args) => spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' }).status ?? 1;

console.log('Session start');
run('scripts/verify-session.mjs');
const current = path.join(ROOT, 'studio', 'CURRENT_TASK.md');
console.log(fs.existsSync(current) ? fs.readFileSync(current, 'utf8') : 'No studio/CURRENT_TASK.md yet.');
console.log('');
if (run('harness/watch.mjs') === 0) run('harness/retro.mjs', '--if-due');
console.log('');
console.log('Producer? Run: npm run handoff  (full briefing; key documents are mapped in studio/MASTER.md)');
console.log('');
console.log('--- Next queued task ---');
run('harness/task.mjs', 'next');
