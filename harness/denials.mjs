#!/usr/bin/env node
/**
 * harness/denials.mjs — 2.66.0 (c): the blocked-command log.
 *
 *   npm run denials [-- --days 7] [--json]    top blocked commands by count, and per task
 *
 * Claude Code's result line (`{"type":"result",…}`, one per result in a stream-json log) carries
 * `permission_denials`: [{ tool_name, tool_use_id, tool_input }], the tool calls the session's permissions refused
 * (checked on the crew's own logs, 2026-11-02: every result line has the field). At session end (harness/agent.mjs
 * cleanUp) each denial is appended to .studio/denials.jsonl: { ts, task, agent, role, tool, command, key, why }.
 * `command` is a redacted summary (harness/secrets.mjs scrub(), then anything that looks like a password, token or
 * key flag/assignment/header, capped at 200 characters); `key` groups it (Bash(npm run x *), Read(dir/**), the tool);
 * `why` says whether the call was off the list or on it but chained, prefixed or using a variable.
 * A result line without the field records nothing.
 *
 * The digest (harness/digest.mjs) shows the top 5 keys that are off the list as allowlist CANDIDATES. Nothing here
 * ever writes a settings or permission file (.claude/settings*.json, harness/allowlist.mjs, --allowedTools): a person
 * reads the candidates and decides.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STUDIO_STATE_DIR } from './event.mjs';
import { scrub } from './secrets.mjs';
import { ALLOWED } from './allowlist.mjs';
import { appendLine } from './fsafe.mjs';

export const DENIALS_FILE = () => path.join(STUDIO_STATE_DIR, 'denials.jsonl');
export const COMMAND_MAX = 200;
export const NEVER_AUTO = 'Candidates only: nothing is ever added to a settings or permission file automatically (.claude/settings*.json, harness/allowlist.mjs); a person decides.';
const DAY = 86400000;

/** Every denial in a session log, once each (by tool_use_id): [{ tool, input, id }]. null when no result line has the field. */
export function parseDenials(log) {
  let seenField = false;
  const out = [];
  const ids = new Set();
  for (const raw of String(log || '').split(/\r?\n/)) {
    const l = raw.trim();
    if (!l.startsWith('{') || !l.includes('"result"')) continue;
    let o;
    try { o = JSON.parse(l); } catch { continue; }
    if (o?.type !== 'result' || !('permission_denials' in o)) continue;
    seenField = true;
    for (const d of Array.isArray(o.permission_denials) ? o.permission_denials : []) {
      if (!d || typeof d !== 'object') continue;
      const id = d.tool_use_id || `${d.tool_name}:${JSON.stringify(d.tool_input || {})}`;
      if (ids.has(id)) continue;
      ids.add(id);
      out.push({ tool: String(d.tool_name || 'unknown'), input: d.tool_input && typeof d.tool_input === 'object' ? d.tool_input : {}, id });
    }
  }
  return seenField ? out : null;
}

/** A command or input with anything secret-looking taken out, on one line, at most COMMAND_MAX characters. */
export function redact(text) {
  let s = scrub(String(text ?? '')).text;
  s = s
    // Authorization headers, bearer/basic credentials.
    .replace(/\b(authorization|proxy-authorization)\s*[:=]\s*("?)(bearer|basic|token)?\s*[^\s"']+/gi, (m, h, q, kind) => `${h}: ${q}${kind ? `${kind} ` : ''}[removed]`)
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [removed]')
    // NAME=value where the name says it is a secret.
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|AUTH))\s*=\s*("[^"]*"|'[^']*'|[^\s;&|]+)/gi, '$1=[removed]')
    // --password x, --token=x, -p x (mysql style), --api-key x ...
    .replace(/(--?(?:password|passwd|pass|token|secret|api-?key|access-?key|auth|key|p)\b)(?:\s*=\s*|\s+)("[^"]*"|'[^']*'|[^\s;&|]+)/gi, '$1 [removed]')
    // user:password@host in URLs.
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi, '$1:[removed]@')
    // ?token=… &key=… in URLs.
    .replace(/([?&](?:token|key|api_key|apikey|secret|password|sig|signature|access_token)=)[^\s&#"']+/gi, '$1[removed]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > COMMAND_MAX ? `${s.slice(0, COMMAND_MAX - 1)}…` : s;
}

const globToRe = (g) => new RegExp(`^${g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
const ALLOWED_RES = ALLOWED.map(([, p]) => globToRe(p));
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'shell', 'Shell']);
const TWO_WORDS = new Set(['git', 'node', 'npx', 'python', 'python3', 'py', 'cargo', 'go', 'dotnet', 'godot', 'docker', 'gh', 'pip', 'pip3', 'unity']);

/**
 * One denial as { command, key, why }: the redacted summary, the group it counts under (a pattern a person could
 * allow) and why it was refused, as far as the harness can tell.
 */
export function describe(tool, input = {}) {
  if (SHELL_TOOLS.has(tool)) {
    const cmd = String(input.command ?? input.script ?? '');
    const command = redact(cmd);
    const trimmed = cmd.trim();
    const chained = /;|&&|\|\||\|/.test(trimmed.replace(/'[^']*'|"[^"]*"/g, ''));
    const prefixed = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+\S/.test(trimmed) || /^cd\s/.test(trimmed);
    const variable = /\$[A-Za-z_{(]|\$env:/.test(trimmed.replace(/'[^']*'/g, ''));
    const first = trimmed.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '').split(/;|&&|\|\||\|/)[0].trim();
    const words = first.split(/\s+/).filter(Boolean);
    const prog = path.basename(String(words[0] || '').replace(/^["']|["']$/g, '')).replace(/\.(exe|cmd|bat)$/i, '');
    let head = prog || '(empty)';
    if (['npm', 'pnpm', 'yarn'].includes(prog) && words[1] === 'run' && words[2]) head = `${prog} run ${words[2]}`;
    else if (['npm', 'pnpm', 'yarn'].includes(prog) && words[1]) head = `${prog} ${words[1]}`;
    else if (TWO_WORDS.has(prog) && words[1] && !words[1].startsWith('-')) head = `${prog} ${words[1]}`;
    head = redact(head).slice(0, 60);
    // The launcher's list is Bash patterns only (allowlist.mjs): another shell tool is never on it.
    const onList = tool === 'Bash' && ALLOWED_RES.some((re) => re.test(first));
    const why = chained ? 'chained (one command per call)' : prefixed ? 'prefixed (VAR=x or cd … first)' : variable ? 'uses a variable ($…)' : onList ? 'on the list, refused anyway (a hook or a rule)' : 'not on the list';
    return { command, key: `${tool}(${head} *)`, why, candidate: !chained && !prefixed && !variable && !onList };
  }
  const file = input.file_path ?? input.path ?? input.notebook_path ?? null;
  if (file) {
    const dirOf = path.posix.dirname(String(file).replace(/\\/g, '/'));
    const tail = dirOf.split('/').filter(Boolean).slice(-2).join('/');
    return { command: redact(String(file)), key: `${tool}(${redact(tail || dirOf)}/**)`, why: 'not on the list', candidate: true };
  }
  if (input.url) {
    let host = '';
    try { host = new URL(String(input.url)).hostname; } catch { host = ''; }
    return { command: redact(String(input.url)), key: `${tool}(domain:${host || 'unknown'})`, why: 'not on the list', candidate: true };
  }
  return { command: redact(JSON.stringify(input)), key: tool, why: 'not on the list', candidate: true };
}

/** Harvest a finished session's denials into .studio/denials.jsonl. Returns how many were recorded (0 with no field). */
export function recordDenials({ log, logFile = null, task = null, agent = null, role = null, now = Date.now() } = {}) {
  // The whole log when there is one (the launcher keeps only its last 20k characters; a session can end several results).
  let text = log;
  try { if (logFile && fs.existsSync(logFile)) text = fs.readFileSync(logFile, 'utf8'); } catch { text = log; }
  const found = parseDenials(text);
  if (!found || !found.length) return 0;
  const ts = new Date(now).toISOString();
  fs.mkdirSync(STUDIO_STATE_DIR, { recursive: true });
  for (const d of found) {
    const x = describe(d.tool, d.input);
    appendLine(DENIALS_FILE(), JSON.stringify({ ts, task: task || null, agent: agent || null, role: role || null, tool: d.tool, command: x.command, key: x.key, why: x.why, candidate: x.candidate }));
  }
  return found.length;
}

/** The recorded denials of the last `days` days. */
export function readDenials({ days = 7, now = Date.now() } = {}) {
  let text = '';
  try { text = fs.readFileSync(DENIALS_FILE(), 'utf8'); } catch { return []; }
  const since = now - days * DAY;
  return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((d) => d && (Date.parse(d.ts) || 0) >= since);
}

/** { total, top: [{ key, n, why, candidate, example, tasks }], perTask: [{ task, n }] }, biggest first. */
export function denialSummary({ days = 7, now = Date.now(), top = 10 } = {}) {
  const all = readDenials({ days, now });
  const by = new Map();
  const per = new Map();
  for (const d of all) {
    const k = `${d.key}\u0000${d.why}`;
    const g = by.get(k) || { key: d.key, why: d.why, candidate: Boolean(d.candidate), n: 0, example: d.command, tasks: new Set() };
    g.n += 1;
    if (d.task) g.tasks.add(d.task);
    by.set(k, g);
    const t = d.task || '(no task)';
    per.set(t, (per.get(t) || 0) + 1);
  }
  const groups = [...by.values()].sort((a, b) => b.n - a.n || a.key.localeCompare(b.key)).map((g) => ({ ...g, tasks: [...g.tasks] }));
  return { total: all.length, days, top: groups.slice(0, top), groups, perTask: [...per.entries()].map(([task, n]) => ({ task, n })).sort((a, b) => b.n - a.n) };
}

/** The top `n` allowlist candidates (off the list, a single plain command): [{ key, n, example }]. */
export function allowlistCandidates({ n = 5, days = 7, now = Date.now() } = {}) {
  return denialSummary({ days, now, top: 1000 }).groups.filter((g) => g.candidate).slice(0, n).map((g) => ({ key: g.key, n: g.n, example: g.example }));
}

export function renderSummary(s) {
  const L = [`Blocked commands, last ${s.days} day(s): ${s.total} denial(s) (.studio/denials.jsonl).`];
  if (!s.total) return `${L[0]}\nNothing was blocked.`;
  L.push('', 'Top commands:');
  for (const g of s.top) L.push(`  ${String(g.n).padStart(4)}  ${g.key}  (${g.why}${g.tasks.length ? `; ${g.tasks.slice(0, 3).join(', ')}${g.tasks.length > 3 ? ' …' : ''}` : ''})  e.g. ${g.example}`);
  L.push('', 'Per task:');
  for (const t of s.perTask.slice(0, 15)) L.push(`  ${String(t.n).padStart(4)}  ${t.task}`);
  const c = s.groups.filter((g) => g.candidate).slice(0, 5);
  L.push('', c.length ? `Allowlist candidates: ${c.map((g) => `${g.key} (${g.n})`).join(', ')}.` : 'Allowlist candidates: none (every denial was a chain, a prefix or a variable: the agent splits the command instead).', NEVER_AUTO);
  return L.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--days');
  const days = i >= 0 ? Number(argv[i + 1]) : 7;
  if (!Number.isFinite(days) || days <= 0 || argv.includes('--help')) { console.log('Usage: npm run denials [-- --days 7] [--json]'); process.exit(argv.includes('--help') ? 0 : 2); }
  const s = denialSummary({ days });
  console.log(argv.includes('--json') ? JSON.stringify({ ...s, groups: undefined, candidates: s.groups.filter((g) => g.candidate).slice(0, 5), note: NEVER_AUTO }, null, 2) : renderSummary(s));
}
