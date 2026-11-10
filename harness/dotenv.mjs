import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * 2.73.1 (B-60): who a shell is comes from the session, never from the studio's shared .env. The launcher sets these for
 * each agent session it starts (harness/agent.mjs); a line in .env would label every shell that loads it, the owner's
 * own terminal included, as that agent (the owner's .env line `STUDIO_LOCK_OWNER=opus-1` refused every owner-only
 * command for 45 minutes). Every .env loader skips them and warns once per process, naming the line.
 */
export const SESSION_IDENTITY_KEYS = Object.freeze(['STUDIO_LOCK_OWNER', 'STUDIO_ROLE', 'STUDIO_AGENT', 'STUDIO_MAIN_ROOT']);
export const isSessionIdentity = (key) => SESSION_IDENTITY_KEYS.includes(String(key || '').trim().toUpperCase());

/** The .env lines that set a session identity to a non-empty value: [{ line (1-based), key }]. */
export function identityLines(text) {
  const out = [];
  String(text || '').split('\n').forEach((raw, i) => {
    const m = raw.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || !isSessionIdentity(m[1])) return;
    if (m[2].trim().replace(/^['"]|['"]$/g, '') === '') return;
    out.push({ line: i + 1, key: m[1].toUpperCase() });
  });
  return out;
}

/** The one-line warning for those lines (names and line numbers only; values are never printed). */
export function identityWarning(hits, file = '.env') {
  if (!hits?.length) return '';
  const lines = hits.map((h) => h.line);
  return `[env] ignored ${[...new Set(hits.map((h) => h.key))].join(', ')} in ${file}: identity settings belong to a session, not the studio's .env: remove line${lines.length === 1 ? '' : 's'} ${lines.join(', ')}`;
}

const WARNED = Symbol.for('studio.envIdentityWarned');
/** Print the warning on stderr, once per process and file (stdout stays clean for --json). */
export function warnIdentityOnce(file, text, { write = (s) => process.stderr.write(`${s}\n`) } = {}) {
  const hits = identityLines(text);
  if (!hits.length) return hits;
  const seen = (globalThis[WARNED] ||= new Set());
  // Keyed by the resolved path: on Windows two loaders spell the same file with \ and / (CI, 2.73.1).
  let key = String(file);
  try { key = path.resolve(key); if (process.platform === 'win32') key = key.toLowerCase(); } catch {}
  if (!seen.has(key)) {
    seen.add(key);
    try { write(identityWarning(hits, file)); } catch {}
  }
  return hits;
}

/*
 * 2.73.2 (B-74): the studio settings in .env (STUDIO_*, HUB_*, AGENT_*, PLAYTEST_*) and which of a process's values
 * came from that file. event.mjs loads them once at start (a value already in the environment wins, as before) and
 * notes the ones it took from the file in STUDIO_ENV_FROM_FILE: { f: the .env's path, sig: its mtime:size, k: { NAME:
 * hash of the value } }. A child started with this environment inherits the note, so it knows that, say, its
 * STUDIO_STALL_MIN came from .env through its parent, not from whoever started it. harness/env-reload.mjs re-reads the
 * file in the long-running loops and updates only those values (syncStudioEnv). Values are never written to the note.
 */
export const ENV_FROM_FILE = 'STUDIO_ENV_FROM_FILE';
const SETTINGS_LINE = /^\s*((?:STUDIO|HUB|AGENT|PLAYTEST)_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/;
/** The studio settings in a .env text: { NAME: value }. The last non-empty line for a name wins; identity keys never. */
export function parseStudioEnv(text) {
  const found = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(SETTINGS_LINE);
    if (!m || isSessionIdentity(m[1]) || m[1] === ENV_FROM_FILE) continue;
    const v = m[2].replace(/^['"]|['"]$/g, '');
    if (v !== '' || !(m[1] in found)) found[m[1]] = v;
  }
  return found;
}
/**
 * Every NAME=value line of a .env text (all names, keys included, unlike the settings reader above): quotes stripped,
 * the last non-empty line for a name wins. Values stay in memory only. 2.81 folded three copies into this one, and the router's loader into loadDotEnv below.
 */
export function parseEnvText(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const v = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (v !== '' || !(m[1] in out)) out[m[1]] = v;
  }
  return out;
}
/** parseEnvText of a file; {} when it can't be read. */
export function readEnvFile(file) {
  try { return parseEnvText(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
export const valueHash = (v) => crypto.createHash('sha1').update(String(v)).digest('hex').slice(0, 10);
/** The file's version for "did it change": mtime and size, or null when there is no file. */
export function envFileSig(file) {
  try { const st = fs.statSync(file); return `${Math.round(st.mtimeMs)}:${st.size}`; } catch { return null; }
}
/** The from-file note in env, or null. */
export function readFromFileNote(env = process.env) {
  try { const o = JSON.parse(env[ENV_FROM_FILE] || ''); return o && typeof o === 'object' && o.k && typeof o.k === 'object' ? o : null; } catch { return null; }
}
export function writeFromFileNote(env, { file, sig, marks }) {
  env[ENV_FROM_FILE] = JSON.stringify({ f: path.resolve(file), sig: sig || null, k: Object.fromEntries([...marks].sort()) });
}
/** A name whose value is never logged (tokens, keys, secrets, passwords, webhooks). */
export const looksSecret = (key) => /(TOKEN|SECRET|PASSWORD|PASSWD|WEBHOOK|CREDENTIAL|PRIVATE|_KEY$|_KEY_|APIKEY)/i.test(String(key || ''));

/**
 * Bring env in line with .env's settings `found`, for the values that came from the file. marks: Map NAME -> hash of
 * the value the file gave (the note). A value someone else set (in the environment the process was started with, or
 * in the process since) is left alone and listed in `kept`. Returns { added, changed: [{ key, from, to }], removed, kept }.
 */
export function syncStudioEnv(found, env, marks) {
  const out = { added: [], changed: [], removed: [], kept: [] };
  for (const [k, v] of Object.entries(found)) {
    const cur = env[k];
    if (cur === undefined) { env[k] = v; marks.set(k, valueHash(v)); out.added.push(k); continue; }
    if (marks.get(k) === valueHash(cur)) {
      if (cur !== v) { env[k] = v; out.changed.push({ key: k, from: cur, to: v }); }
      marks.set(k, valueHash(v));
    } else if (cur !== v) out.kept.push(k);
  }
  for (const [k, hash] of [...marks]) {
    if (k in found) continue;
    if (env[k] !== undefined && valueHash(env[k]) === hash) { delete env[k]; out.removed.push(k); }
    marks.delete(k);
  }
  return out;
}

const ENV_STATE = Symbol.for('studio.envFileState');
/** This process's view of the .env it loaded: { file, sig, marks, reqId }. */
export const envFileState = () => globalThis[ENV_STATE] || null;
/**
 * event.mjs's start-up load: a value already in the environment wins (unchanged since before 2.73.2), the values taken
 * from the file are marked. A note inherited from the parent for the same .env carries over (its marks, and its sig,
 * so a file edited between the parent's start and this one's is synced on the first reload).
 */
export function loadStudioEnvAtStart(file, env = process.env) {
  let text = null;
  try { text = fs.readFileSync(file, 'utf8'); } catch { text = null; }
  const inherited = readFromFileNote(env);
  const same = inherited && inherited.f === path.resolve(file);
  const marks = new Map();
  if (same) for (const [k, h] of Object.entries(inherited.k)) if (env[k] !== undefined && valueHash(env[k]) === h) marks.set(k, h);
  const sig = same && inherited.sig ? inherited.sig : envFileSig(file);
  if (text !== null) {
    warnIdentityOnce(file, text);
    for (const [k, v] of Object.entries(parseStudioEnv(text))) if (env[k] === undefined) { env[k] = v; marks.set(k, valueHash(v)); }
  }
  if (env === process.env) globalThis[ENV_STATE] = { file: path.resolve(file), sig, marks, reqId: null };
  if (text !== null || marks.size) writeFromFileNote(env, { file, sig, marks });
  return marks;
}

/** Load a .env into env: a value already there wins, identity keys never. skipEmpty: a `NAME=` line sets nothing. */
export function loadDotEnv(file, env = process.env, { skipEmpty = false } = {}) {
  if (!fs.existsSync(file)) return [];
  const loaded = [];
  const text = fs.readFileSync(file, 'utf8');
  if (env === process.env) warnIdentityOnce(file, text);
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = t.match(/^(?:export\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*=(.*)$/);
    if (!m) continue;
    const key = m[1];
    if (isSessionIdentity(key)) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (env[key] === undefined && !(skipEmpty && val === '')) {
      env[key] = val;
      loaded.push(key);
    }
  }
  return loaded;
}
