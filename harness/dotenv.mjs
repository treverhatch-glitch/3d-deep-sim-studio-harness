import fs from 'node:fs';
import path from 'node:path';

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

export function loadDotEnv(file, env = process.env) {
  if (!fs.existsSync(file)) return [];
  const loaded = [];
  const text = fs.readFileSync(file, 'utf8');
  if (env === process.env) warnIdentityOnce(file, text);
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = t.match(/^(?:export\s+)?([a-zA-Z_][a-zA-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    const key = m[1];
    if (isSessionIdentity(key)) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (env[key] === undefined) {
      env[key] = val;
      loaded.push(key);
    }
  }
  return loaded;
}
