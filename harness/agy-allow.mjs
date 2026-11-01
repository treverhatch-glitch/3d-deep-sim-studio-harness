/**
 * harness/agy-allow.mjs — P-067 (crew P-037): an owner-approved step that writes agy's headless allow-rules.
 *
 *   npm run agent -- allow agy --dry-run                       the rules and the file, nothing written
 *   npm run agent -- allow agy --by <owner>                    merge them into the studio's .studio/agy-settings.json
 *   npm run agent -- allow agy --by <owner> --scope user       merge them into agy's own (user-level) settings.json
 *
 * Claude agents get the harness's command list (harness/allowlist.mjs) on their command line (--allowedTools).
 * Antigravity CLI (agy) has no such flag: in headless mode (-p) a shell command is "Ask" by default and is
 * soft-denied (the run goes on, exits 0, and prints "add an allow-rule under permissions.allow in settings.json"),
 * so a launched agy agent couldn't run node, npm or git. This writes the same list as agy rules, once, with the
 * owner's OK. It never adds a skip-all setting (toolPermission, --dangerously-skip-permissions): that stays for a
 * frozen test clone (STUDIO_AGY_BYPASS=1, harness/agent.mjs).
 *
 * What agy reads (checked 2026-11-01 against Google's docs, see docs/AGENT-TOOLS.md):
 *   - the user's settings file: ~/.gemini/antigravity-cli/settings.json (%USERPROFILE%\.gemini\... on Windows).
 *     No workspace-level settings.json is documented (a workspace has .agents/hooks.json, .agents/mcp_config.json and
 *     plugins only).
 *   - M3 (2.58.3, crew P-037 addendum): agy also takes a session settings file, `agy --settings <file>` (the crew ran
 *     it on Windows). So the default target is the studio's own file, .studio/agy-settings.json (written by the
 *     harness, never committed: .studio/ is ignored), and the launcher passes `--settings <it>` to agy when it exists
 *     (harness/agent.mjs toolCommand). The user-level file stays available with --scope user, said out loud.
 *     UNTESTED: whether agy merges --settings with the user file or uses it alone.
 *   - rules: permissions.allow / ask / deny, each an "action(target)" string; deny > ask > allow.
 *     command(<words>) matches a command by its leading words ("word-by-word literally"); regex:<re> instead
 *     matches a regular expression. On Windows (PowerShell, cmd) a line that can't be split into words needs an
 *     exact match, and Google's docs say to use regex: there. So each entry gets both forms (AGY_RULES below).
 *     The crew's finding on Windows (P-037 addendum): agy matched exact commands only. `command(node --version)` was
 *     allowed; `command(node *)`, `command(node*)`, `command(node**)`, `command(node:*)` and `command(node)` were all
 *     denied for `node --version`. So on Windows the word-prefix form does nothing, and the regex form is UNTESTED on
 *     real agy (kept: it is the documented way). UNCONFIRMED too: whether a CLI regex is anchored, and against which
 *     text exactly; ours carry their own ^ and $. If agy's format turns out different, agyRulesFor() is the one place
 *     to change.
 *
 * Safety: the file is backed up first (<file>.bak-<time>, never deleted), written atomically (fsafe.writeAtomic),
 * and only ever gains rules: other keys and the user's own allow, ask and deny rules stay as they were. A file that
 * isn't plain JSON is left alone (the rules are printed to add by hand). An agent can't approve it (an agent-like
 * --by, or a launched session, is refused). That is a speed bump, not a lock: node and npm on the list run any
 * code, as they do for Claude, so these rules spare prompts, they don't sandbox anything.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ALLOWED } from './allowlist.mjs';
import { STUDIO_STATE_DIR, emitEvent, readRecentEvents } from './event.mjs';
import { writeAtomic } from './fsafe.mjs';

/** Where agy's rules are written, per scope (null: agy has no such file). studio: the harness's own file, which the
 * launcher passes with --settings (the default); user: agy's own settings.json. */
export const AGY_SETTINGS = {
  studio: (home, stateDir = STUDIO_STATE_DIR) => path.join(stateDir, 'agy-settings.json'),
  user: (home) => path.join(home, '.gemini', 'antigravity-cli', 'settings.json'),
  project: null,
};
export const DEFAULT_SCOPE = 'studio';

const HINT_CMD = 'npm run agent -- allow agy --by <owner> (dry-run first)';
export const NO_RULES_HINT = `agy has no allow-rules: run ${HINT_CMD}`;

// The rest of a command line, for the regex form: anything but a chain or a substitution (; & | newline, a
// backtick, $( ), except the redirect >& (2>&1). Written without a bare parenthesis (\x28 is "("), so the rule's
// own parentheses stay balanced for agy's action(target) parser.
const REST = '(?:[^;&|`$\\r\\n]|>&|\\$[^\\x28\\r\\n])*';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One harness entry (a Claude pattern such as "npm *" or "git status*") as agy rules: the word prefix, and the
 * regex for Windows. An entry that would match everything gives nothing.
 */
export function agyRulesFor(pattern) {
  const prefix = String(pattern || '').replace(/\s*\*$/, '').trim();
  if (!prefix || prefix.includes('*')) return [];
  return [`command(${prefix})`, `command(regex:^${escapeRe(prefix)}(?: ${REST})?$)`];
}

/** Every rule the harness list gives, in list order. */
export const agyRules = (list = ALLOWED) => [...new Set(list.flatMap(([, p]) => agyRulesFor(p)))];

/** The settings file for a scope, or null when agy reads none there. */
export function settingsFile(scope = DEFAULT_SCOPE, { home = os.homedir(), stateDir = STUDIO_STATE_DIR } = {}) {
  const f = AGY_SETTINGS[scope];
  return typeof f === 'function' ? f(home, stateDir) : null;
}

/** M3: the studio's agy settings file when it exists (the launcher passes it as `agy --settings <file>`), else null. */
export function agyStudioSettings({ stateDir = STUDIO_STATE_DIR } = {}) {
  const f = settingsFile('studio', { stateDir });
  try { return fs.statSync(f).isFile() ? f : null; } catch { return null; }
}

const tilde = (file, home = os.homedir()) => (home && file.startsWith(home) ? `~${file.slice(home.length)}` : file);

/** Read a settings file: { exists, raw, data } or { error }. Never throws. */
function readSettings(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (err) { return err.code === 'ENOENT' ? { exists: false, raw: '', data: {} } : { error: `can't read it (${err.code || err.message})` }; }
  const text = raw.replace(/^﻿/, '');
  if (!text.trim()) return { exists: true, raw, data: {} };
  let data;
  try { data = JSON.parse(text); } catch (err) { return { error: `it isn't plain JSON (${String(err.message).replace(/\s+/g, ' ').trim().slice(0, 120)})` }; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'it isn\'t a JSON object' };
  const p = data.permissions;
  if (p !== undefined && (!p || typeof p !== 'object' || Array.isArray(p))) return { error: '"permissions" isn\'t an object' };
  if (p?.allow !== undefined && !Array.isArray(p.allow)) return { error: '"permissions.allow" isn\'t a list' };
  return { exists: true, raw, data };
}

/** How much of the harness list agy's settings hold: { file, want, have, missing, error }. The file a launched agy
 * reads: the studio's (passed with --settings) when it exists, else the user's. */
export function agyAllowState({ home = os.homedir(), stateDir = STUDIO_STATE_DIR, rules = agyRules() } = {}) {
  const file = agyStudioSettings({ stateDir }) || settingsFile('user', { home });
  const s = readSettings(file);
  if (s.error) return { file, want: rules.length, have: 0, missing: rules, error: s.error };
  const allow = new Set((s.data.permissions?.allow || []).map(String));
  // The owner allowed every command already: nothing for the harness to add.
  if (allow.has('command(*)')) return { file, want: rules.length, have: rules.length, missing: [] };
  const missing = rules.filter((r) => !allow.has(r));
  return { file, want: rules.length, have: rules.length - missing.length, missing };
}

/** The launcher's one line when agy lacks the rules (null when they are all there). */
export function agyAllowHint({ home = os.homedir() } = {}) {
  const st = agyAllowState({ home });
  if (!st.missing.length) return null;
  if (st.error) return `agy has no allow-rules it can read (${tilde(st.file, home)}: ${st.error}): run ${HINT_CMD}`;
  return st.have ? `agy has ${st.have} of the harness's ${st.want} allow-rules: run ${HINT_CMD}` : NO_RULES_HINT;
}

/** The hint as an event too, at most once an hour, for launches nobody watches (the HUB, the watcher). */
export function noteAgyHint(hint, { agent = null } = {}) {
  if (!hint) return;
  try {
    const last = readRecentEvents(2000).filter((e) => e.type === 'agy.allow_missing').pop();
    if (last && Date.now() - Date.parse(last.ts) < 3600000) return;
    emitEvent({ type: 'agy.allow_missing', agent: 'launcher', to: 'human', status: 'warn', msg: `${agent ? `${agent} runs on agy, and ` : ''}${hint}` });
  } catch {
    // a reminder, never a blocker
  }
}

// Names agents go by (as in harness/ask.mjs), so an agent can't put its own name to the owner's approval.
const AGENTISH = /^(prod|producer|director|builder|rnd|qa|qa-playtester|playtester|reviewer|planner|art|artist|liaison|scout|designer|balancer|agent|watch|supervisor|launcher|unknown|codex|claude|gemini|agy|gpt|grok|opus|sonnet|haiku|cursor|aider|hermes|dev-hacker)\b/i;

/**
 * Merge the harness's rules into agy's settings. Returns { ok, code, lines, file, added, backup }.
 * dryRun: print the target and the rules, write nothing. A real run needs `by` (the owner) and scope 'user'.
 */
export function enrolAgy({ by = null, scope = null, dryRun = false, home = os.homedir(), stateDir = STUDIO_STATE_DIR, env = process.env, now = new Date() } = {}) {
  const rules = agyRules();
  const lines = [];
  const fail = (msg) => ({ ok: false, code: 1, lines: [...lines, msg] });
  if (scope && !Object.hasOwn(AGY_SETTINGS, scope)) return fail(`--scope is studio (the default) or user, not "${scope}".`);
  const userFile = settingsFile('user', { home });
  const want = scope || DEFAULT_SCOPE;
  if (!settingsFile(want, { home, stateDir })) {
    return fail(`Nothing written: agy has no ${want}-level settings file (Google documents none). The default writes the studio's own file, ${settingsFile('studio', { stateDir })}, which the launcher passes to agy with --settings; --scope user writes agy's user-level ${userFile} (try --dry-run first).`);
  }
  const file = settingsFile(want, { home, stateDir });
  const again = `npm run agent -- allow agy --by <owner>${want === 'user' ? ' --scope user' : ''}`;
  const s = readSettings(file);
  if (s.error) {
    return fail(`Nothing written: ${file} is left as it is because ${s.error}. Add these under "permissions": { "allow": [ … ] } by hand:\n${rules.map((r) => `  ${JSON.stringify(r)}`).join(',\n')}`);
  }
  const allow = (s.data.permissions?.allow || []).map(String);
  const toAdd = rules.filter((r) => !allow.includes(r));
  const kept = rules.length - toAdd.length;
  if (dryRun) {
    lines.push(`Dry run: nothing written. Target: ${file}${s.exists ? '' : ' (doesn\'t exist yet; a real run creates it)'}.`);
    if (want === 'studio') lines.push(`That is the studio's own file: the launcher passes it to agy as --settings <file>. agy's user-level ${userFile} is left alone (write it with --scope user instead).`);
    lines.push(toAdd.length ? `Would add ${toAdd.length} rule(s) under permissions.allow${kept ? ` (${kept} already there)` : ''}, from harness/allowlist.mjs:` : `All ${rules.length} rules are already there: nothing to add.`);
    for (const r of toAdd) lines.push(`  ${r}`);
    if (toAdd.length) lines.push(`Then: ${again}. Other settings and rules in the file stay; it is backed up first.`);
    return { ok: true, code: 0, lines, file, added: [], rules: toAdd };
  }
  const who = String(by || '').trim();
  if (!who) return fail('Nothing written: --by <owner> is required. The owner approves what agy may run without asking.');
  if (env.STUDIO_ROLE || AGENTISH.test(who)) return fail(`Nothing written: ${env.STUDIO_ROLE ? `this runs inside a launched ${env.STUDIO_ROLE} session` : `"${who}" is an agent's name`}. The owner runs this in their own terminal, after reading the --dry-run.`);
  if (!toAdd.length) {
    lines.push(`agy already has all ${rules.length} of the harness's allow-rules in ${file}: nothing added, nothing written.`);
    return { ok: true, code: 0, lines, file, added: [], backup: null };
  }
  let backup = null;
  if (s.exists) {
    backup = `${file}.bak-${now.toISOString().replace(/[:.]/g, '-')}`;
    try { fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL); } catch (err) { return fail(`Nothing written: couldn't back up ${file} to ${backup} (${err.code || err.message}).`); }
  }
  const data = s.data;
  data.permissions = data.permissions || {};
  data.permissions.allow = [...(Array.isArray(data.permissions.allow) ? data.permissions.allow : []), ...toAdd];
  // Keep the file's own indent, line ends and BOM.
  const indent = (s.raw.match(/^([ \t]+)"/m) || [null, '  '])[1];
  const eol = /\r\n/.test(s.raw) ? '\r\n' : '\n';
  const text = `${s.raw.startsWith('﻿') ? '﻿' : ''}${JSON.stringify(data, null, indent).replace(/\n/g, eol)}${eol}`;
  try { writeAtomic(file, text); } catch (err) { return fail(`Couldn't write ${file} (${err.code || err.message}).${backup ? ` The backup is ${backup}.` : ''}`); }
  lines.push(`Added ${toAdd.length} allow-rule(s) to ${file}${kept ? ` (${kept} were already there)` : ''}, approved by ${who}.${backup ? ` Backup: ${backup}.` : ''}`);
  lines.push(`agy agents can now run the harness list (node, npm, npx, read-only git plus add and commit, …) headless${want === 'studio' ? ' (the launcher passes this file with --settings)' : ''}. Nothing else changed.`);
  if (want === 'studio') lines.push('On Windows agy matched exact commands only in the crew\'s test (command(node --version) yes, command(node) no); the regex rules are untested on real agy: check one launched agy agent runs node.');
  try {
    emitEvent({ type: 'agy.allow_enrolled', agent: who, to: 'producer', msg: `${who} approved agy's allow-rules: ${toAdd.length} added to ${tilde(file, home)} (the harness list, harness/allowlist.mjs)${backup ? `; backup ${tilde(backup, home)}` : ''}`, meta: { by: who, scope: want, file: tilde(file, home), added: toAdd.length, backup: backup ? tilde(backup, home) : null } });
  } catch {
    // the file is written; the log line is a record, not a step
  }
  return { ok: true, code: 0, lines, file, added: toAdd, backup };
}

/** `npm run agent -- allow <tool> …` (argv after "allow"). Returns the exit code. */
export function allowCli(argv, { log = console.log, err = console.error } = {}) {
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] ?? '' : null);
  const tool = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
  const usage = 'Usage: npm run agent -- allow agy [--dry-run] | npm run agent -- allow agy --by <owner> [--scope user]';
  if (!tool) { err(usage); return 1; }
  if (tool !== 'agy') {
    err(tool === 'claude' ? 'Claude Code needs no enrolment: the launcher gives it the list on its command line (--allowedTools).' : `Only agy reads its allow-rules from a settings file; "${tool}" isn't enrolled this way. ${usage}`);
    return 1;
  }
  const r = enrolAgy({ by: flag('by'), scope: flag('scope') || null, dryRun: argv.includes('--dry-run') });
  for (const l of r.lines) (r.ok ? log : err)(l);
  return r.code;
}
