#!/usr/bin/env node
// Pre-compaction checkpoint (the Claude Code PreCompact hook and `npm run session:precompact`). Appends
// studio/CURRENT_TASK.md and the changed files to .studio/session-logs/compaction-log.txt and records a
// session.precompact event. It records no "tokens saved": nothing here measures that.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { emitEvent } from '../harness/event.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ts = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const logDir = path.join(ROOT, '.studio', 'session-logs');
fs.mkdirSync(logDir, { recursive: true });
const current = path.join(ROOT, 'studio', 'CURRENT_TASK.md');
const git = spawnSync('git', ['-C', ROOT, 'status', '--short'], { encoding: 'utf8', shell: false });
const entry = [
  '='.repeat(68),
  `COMPACTION SNAPSHOT @ ${ts}`,
  '='.repeat(68),
  fs.existsSync(current) ? fs.readFileSync(current, 'utf8') : 'WARN: studio/CURRENT_TASK.md not found.',
  '',
  '--- Changed files (git status --short) ---',
  git.status === 0 ? git.stdout.trimEnd() : '(not a git worktree)',
  '',
  '',
].join('\n');
fs.appendFileSync(path.join(logDir, 'compaction-log.txt'), entry);
try {
  emitEvent({ type: 'session.precompact', msg: 'Saved a pre-compaction checkpoint to .studio/session-logs/compaction-log.txt' });
} catch {}
console.log(`[pre-compact] Checkpoint saved to .studio/session-logs/compaction-log.txt at ${ts}`);
