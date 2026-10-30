#!/usr/bin/env node
// 2.30g: PreToolUse hook. Reads of generated folders (node_modules, build, dist, .godot, .import) are
// denied before they cost tokens; the reason names the cheaper lookup. STUDIO_GUARD_PATHS=off disables.
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

export function decide(tool, input) {
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
