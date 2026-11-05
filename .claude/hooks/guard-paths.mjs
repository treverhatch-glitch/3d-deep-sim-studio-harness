#!/usr/bin/env node
// 2.30g: PreToolUse hook. Reads of generated folders (node_modules, build, dist, .godot, .import) are
// denied before they cost tokens; the reason names the cheaper lookup. STUDIO_GUARD_PATHS=off disables.
import path from 'node:path';
import { holdoutDir, isBuilderSession } from '../../harness/holdout-dir.mjs';
const DENIED = /(^|[\/\\])(node_modules|build|dist|\.godot|\.import)([\/\\]|$)/;
const READERS = /^(cat|head|tail|less|more|grep|rg|find|ls|tree|wc|sed|awk|cp|mv|base64|xxd|od|strings|source|\.)$/;

/** The paths a tool call would read; for Bash only the arguments of read commands. */
export function targets(tool, input = {}) {
  if (tool === 'Bash') {
    const out = [];
    for (const part of String(input.command || '').split(/&&|\|\||;|\|/)) {
      const words = part.trim().split(/\s+/).map((w) => w.replace(/^['"]|['"]$/g, ''));
      if (!READERS.test(words[0] || '')) continue;
      out.push(...words.slice(1).filter((w) => w && !w.startsWith('-')));
    }
    return out;
  }
  return [input.file_path, input.path, input.pattern, input.notebook_path].filter(Boolean).map(String);
}

// 2.33.0: secrets. .env (not .env.example), the owner's approval key and the studio's signing keys are never read
// by an agent: a key in a transcript is a leaked key, and the owner key would let an agent approve itself.
const SECRET = /(^|[\/\\])(\.env(\.(?!example$)[\w.-]+)?|\.studio-owner|owner-ed25519\.pem|studio-ed25519\.pem)([\/\\]|$)|(^|[\/\\])\.studio[\/\\]keys([\/\\]|$)/;

// 2.78.0 (PU-54): the held-out cases (STUDIO_HOLDOUT_DIR, harness/holdout-dir.mjs) are never read by a builder or a lane
// session; the reviewer, Producer, Director and owner may. This is a path deny: a Bash one-liner in another language can
// still read the folder, so the real protection is that it lies outside every lane's files (docs/HOLDOUT.md).
function holdoutHit(tool, input, env, start) {
  if (!isBuilderSession(start, env)) return null;
  const dir = holdoutDir(start, env).replace(/\\/g, '/').replace(/\/+$/, '');
  const low = (x) => String(x).replace(/\\/g, '/').toLowerCase();
  const d = low(dir);
  const base = low(path.basename(dir));
  const named = (t) => { const v = low(t); return v.includes(d) || v.includes(`${base}/`) || v.endsWith(base) || v.includes('studio_holdout_dir'); };
  if (tool === 'Bash') return named(String(input?.command || '')) ? dir : null;
  return targets(tool, input).find(named) ? dir : null;
}

export function decide(tool, input, env = process.env, start = env.CLAUDE_PROJECT_DIR || process.cwd()) {
  const ho = holdoutHit(tool, input, env, start);
  if (ho) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'The held-out check cases are hidden from builders on purpose; they run at the merge train and a failure there names only the case id and note. Do not read, list or guess them (docs/HOLDOUT.md).' } };
  const secret = targets(tool, input).find((p) => SECRET.test(p));
  if (secret) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `${secret} holds keys or tokens; agents never read it. If a command needs a setting from it, the launcher passes that setting in the environment (STUDIO_<ROLE>_ENV).` } };
  const hit = targets(tool, input).find((p) => DENIED.test(p));
  if (!hit) return null;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `${hit} is a generated folder (node_modules, build, dist, .godot or .import); reading it wastes tokens. Find code with \`npm run map -- find <name>\`, or read the source file it came from.` } };
}

if (process.env.STUDIO_GUARD_PATHS !== 'off' && process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\/\\]/).pop())) {
  let data = '';
  const quit = setTimeout(() => process.exit(0), 3000);
  process.stdin.on('data', (c) => (data += c));
  process.stdin.on('end', () => {
    clearTimeout(quit);
    try {
      const i = JSON.parse(data);
      const d = decide(i.tool_name, i.tool_input);
      if (d) process.stdout.write(JSON.stringify(d));
    } catch {}
    process.exit(0);
  });
}
