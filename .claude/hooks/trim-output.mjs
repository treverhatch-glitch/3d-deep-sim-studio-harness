#!/usr/bin/env node
// 2.30g: PostToolUse hook. Long Bash output is cut to its failures plus the tail before the agent reads it; the full text is kept in .studio/trimmed/.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const MAX_LINES = Number(process.env.STUDIO_TRIM_LINES) || 120;
const MAX_CHARS = 12000;
const CONTEXT_LINES = 1;
const KEEP_MATCHING = 40;
const KEEP_LAST = 40;
const MATCH_RE = /error|fail|✗|FAIL|assert|exception|Traceback|warn/i;

async function main() {
  if (process.env.STUDIO_TRIM === "off") process.exit(0);
  try {
    const input = JSON.parse(await readStdin());
    if (input.tool_name !== 'Bash' || !input.tool_response) process.exit(0);

    const res = input.tool_response;
    const output = (typeof res === 'string') ? res : `${res.stdout || ''}\n${res.stderr || ''}`;
    const lines = output.split('\n');

    if (lines.length <= MAX_LINES && output.length <= MAX_CHARS) process.exit(0);

    const matchingIndices = new Set();
    for (let i = 0; i < lines.length; i++) {
      if (MATCH_RE.test(lines[i])) {
        for (let j = Math.max(0, i - CONTEXT_LINES); j <= Math.min(lines.length - 1, i + CONTEXT_LINES); j++) {
          matchingIndices.add(j);
        }
      }
    }

    const finalIndices = new Set();
    Array.from(matchingIndices).slice(-KEEP_MATCHING).forEach(i => finalIndices.add(i));

    const lastStartIndex = Math.max(0, lines.length - KEEP_LAST);
    for (let i = lastStartIndex; i < lines.length; i++) {
      finalIndices.add(i);
    }

    const sortedIndices = Array.from(finalIndices).sort((a, b) => a - b);
    const trimmedLines = [];
    let lastIndex = -2;
    for (const index of sortedIndices) {
      if (index > lastIndex + 1) trimmedLines.push('...');
      trimmedLines.push(lines[index]);
      lastIndex = index;
    }

    const studioDir = process.env.CLAUDE_PROJECT_DIR || findStudioDir(process.cwd());
    const trimmedDir = path.join(studioDir, '.studio', 'trimmed');
    fs.mkdirSync(trimmedDir, { recursive: true });
    const logId = input.tool_use_id || `${Date.now()}-${randomBytes(4).toString('hex')}`;
    const logPath = path.join(trimmedDir, `${logId}.log`);
    fs.writeFileSync(logPath, output);

    const relLogPath = path.relative(studioDir, logPath).split(path.sep).join('/');
    const prefix = `[trimmed by the harness: ${lines.length} lines → ${trimmedLines.length}; full output: ${relLogPath}]`;
    const trimmedText = `${prefix}\n${trimmedLines.join('\n')}`;

    const updatedToolOutput = (typeof res === 'string')
      ? trimmedText
      : { ...res, stdout: trimmedText, stderr: '' };

    const hookOutput = {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        updatedToolOutput,
      },
    };
    console.log(JSON.stringify(hookOutput));
  } catch (e) {
    process.exit(0);
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', chunk => (data += chunk));
    process.stdin.on('end', () => resolve(data));
  });
}

function findStudioDir(startPath) {
  let current = startPath;
  while (current !== path.parse(current).root) {
    if (fs.existsSync(path.join(current, 'studio'))) return current;
    current = path.dirname(current);
  }
  return startPath;
}

const timeout = setTimeout(() => process.exit(0), 2000);
main().finally(() => clearTimeout(timeout));
