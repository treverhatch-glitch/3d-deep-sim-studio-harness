#!/usr/bin/env node
// 2.64.0: PostToolUse hook. When something was routed to the task this session holds (harness/threads.mjs writes
// .studio/inbox-notice/<agent>.json), the session is told once, after its next tool call: how many follow-ups and
// the command to read them. Never the text itself (that stays in the task's inbox, read with the command). One file
// read when there is nothing new; any trouble exits quietly, so the hook can never hold a session up.
import fs from 'node:fs';
import path from 'node:path';

function main() {
  const owner = String(process.env.STUDIO_LOCK_OWNER || '').trim();
  if (!owner || process.env.STUDIO_INBOX_NOTICE === 'off') return;
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const file = path.join(root, '.studio', 'inbox-notice', `${owner.replace(/[^\w.-]/g, '_')}.json`);
  let n;
  try { n = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
  try { fs.rmSync(file, { force: true }); } catch { return; }
  const task = /^[A-Z]+-\d+$/.test(String(n.task || '')) ? n.task : null;
  if (!task) return;
  const count = Math.max(1, Math.min(999, Number(n.n) || 1));
  const additionalContext = `New in ${task}'s inbox: ${count} follow-up(s) routed to your task (a CI or merge-train result, or a message tied to it). Read them: npm run thread -- inbox ${task}`;
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } })}\n`);
}

try { main(); } catch { /* never block a tool call */ }
