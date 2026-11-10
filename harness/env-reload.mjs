#!/usr/bin/env node
/**
 * harness/env-reload.mjs — 2.73.2 (B-74): settings changed in .env reach the processes that are already running.
 *
 * event.mjs loads the studio's .env once, when a process starts. The overseer raised STUDIO_STALL_MIN to 40 in .env, and
 * the sessions already running kept 15 (s126 was ended on 15 min). Now the long-running loops call reloadEnvIfChanged()
 * every pass: the supervisor's pass (with the train daemon's pass in it), the launcher's heartbeat (the stall check and
 * the idle exit), the watchdog's pass and the watch pass. When the .env's mtime or size changed since the process last
 * looked (one stat call), or someone ran `npm run studio:reload-env`, the file is read again and the values that came
 * from it are updated in that process.
 *
 * Precedence (unchanged for a fresh process): a variable in the environment a process was started with wins over
 * .env, as before. A value that came from .env, in this process or through its parent (a launcher started by the
 * supervisor inherits the supervisor's .env values; the note STUDIO_ENV_FROM_FILE says which), follows the file. The
 * session identity (STUDIO_LOCK_OWNER, STUDIO_ROLE, STUDIO_AGENT, STUDIO_MAIN_ROOT) is never taken from .env
 * (harness/dotenv.mjs, 2.73.1 B-60). A few numbers are read once when a process starts and still need a restart: the
 * supervisor's loop interval (STUDIO_SUPERVISOR_SEC), the heartbeat interval (STUDIO_HEARTBEAT_SEC) and the hub's port.
 *
 * Each change is logged once (one env.reloaded event per version of the file, whichever process saw it first), naming
 * the keys; the values of keys that look secret (*_TOKEN, *_KEY, *_SECRET, *PASSWORD*, webhooks) are never written.
 *
 *   node harness/env-reload.mjs [--by <name>]     (npm run studio:reload-env) ask every running loop to reload now; a
 *                                                 running supervisor answers within seconds with what changed
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { STUDIO_STATE_DIR, REPO_ROOT, emitEvent, actor } from './event.mjs';
import { parseStudioEnv, envFileSig, envFileState, syncStudioEnv, writeFromFileNote, looksSecret } from './dotenv.mjs';
import { readJson } from './fsafe.mjs';

export const REQUEST_FILE = () => path.join(STUDIO_STATE_DIR, 'env-reload.json');
export const ACK_FILE = () => path.join(STUDIO_STATE_DIR, 'env-reload-ack.json');
const LOGGED_FILE = () => path.join(STUDIO_STATE_DIR, 'env-reloaded.json');

/** A change for the log: the value, or null for a key that looks secret. */
const shown = (key, v) => (looksSecret(key) || v === undefined ? null : String(v).slice(0, 80));
export function describeChanges(r) {
  const parts = [
    ...r.changed.map((c) => (looksSecret(c.key) ? `${c.key} changed` : `${c.key} ${shown(c.key, c.from) || '(empty)'} -> ${shown(c.key, c.to) || '(empty)'}`)),
    ...r.added.map((k) => `${k} added`),
    ...r.removed.map((k) => `${k} removed (its default applies)`),
  ];
  return parts.join(', ');
}

/**
 * Re-read .env if it changed (or a reload was asked) and apply it to env. Returns null when nothing was looked at
 * again, else { keys, added, changed, removed, kept, logged }. by: who reloaded (supervisor, launcher <agent>, watchdog,
 * watch). Never throws: a broken .env leaves the old values.
 */
export function reloadEnvIfChanged({ by = actor(), env = process.env, force = false, emit = emitEvent, ack = false } = {}) {
  try {
    const st = envFileState();
    if (!st || env !== process.env) return null;
    const req = readJson(REQUEST_FILE());
    const asked = req?.id && req.id !== st.reqId ? req : null;
    const sig = envFileSig(st.file);
    if (!force && !asked && sig === st.sig) return null;
    if (asked) st.reqId = asked.id;
    let text = '';
    try { text = fs.readFileSync(st.file, 'utf8'); } catch { text = ''; }
    const r = syncStudioEnv(parseStudioEnv(text), env, st.marks);
    st.sig = sig;
    writeFromFileNote(env, st);
    const keys = [...r.changed.map((c) => c.key), ...r.added, ...r.removed];
    let logged = false;
    if (keys.length) {
      // One event per version of the file (and per reload request), whichever process saw it first; the others apply it quietly.
      const key = `${sig || 'none'}|${asked?.id || ''}`;
      const prev = readJson(LOGGED_FILE());
      if (prev?.key !== key) {
        try { fs.mkdirSync(STUDIO_STATE_DIR, { recursive: true }); fs.writeFileSync(LOGGED_FILE(), JSON.stringify({ key, at: new Date().toISOString(), by, pid: process.pid })); } catch {}
        emit({ type: 'env.reloaded', agent: String(by || 'harness').slice(0, 60), msg: `Reloaded .env (${by}, pid ${process.pid}): ${describeChanges(r)}${r.kept.length ? `; kept the value this process was started with for ${r.kept.join(', ')}` : ''}`.slice(0, 600), meta: { by, pid: process.pid, keys, changes: r.changed.map((c) => ({ key: c.key, from: shown(c.key, c.from), to: shown(c.key, c.to), ...(looksSecret(c.key) ? { secret: true } : {}) })), added: r.added, removed: r.removed, kept: r.kept, asked: asked ? { by: asked.by || null, id: asked.id } : null } });
        logged = true;
      }
    }
    if (ack && asked) {
      try { fs.writeFileSync(ACK_FILE(), `${JSON.stringify({ id: asked.id, by, pid: process.pid, at: new Date().toISOString(), keys, kept: r.kept, line: keys.length ? describeChanges(r) : 'no setting changed' })}\n`); } catch {}
    }
    return { keys, ...r, logged };
  } catch {
    return null;
  }
}

/** The supervisor: answer a reload request within seconds, not at its next pass (a stat poll, as on every OS). */
export function watchReloadRequests({ by = 'supervisor', intervalMs = 1000 } = {}) {
  const f = REQUEST_FILE();
  const w = fs.watchFile(f, { interval: intervalMs, persistent: false }, () => reloadEnvIfChanged({ by, ack: true }));
  return () => { try { fs.unwatchFile(f); } catch {} void w; };
}

/** `npm run studio:reload-env`: write the request; wait for a running supervisor's answer. */
export async function reloadCli({ by = null, waitMs = null, env = process.env } = {}) {
  // 2.77.3 (M5): wait for one supervisor pass (STUDIO_SUPERVISOR_SEC, 60) plus a 10 s margin, not a fixed 15 s.
  const passMs = (Number(env.STUDIO_SUPERVISOR_SEC) > 0 ? Number(env.STUDIO_SUPERVISOR_SEC) : 60) * 1000;
  if (waitMs == null) waitMs = passMs + 10000;
  const who = String(by || actor() || 'someone').slice(0, 60);
  const id = `${Date.now().toString(36)}-${process.pid}`;
  fs.mkdirSync(STUDIO_STATE_DIR, { recursive: true });
  fs.writeFileSync(REQUEST_FILE(), `${JSON.stringify({ id, by: who, at: new Date().toISOString() })}\n`);
  const sup = readJson(path.join(STUDIO_STATE_DIR, 'supervisor.json'));
  let running = false;
  try { running = Boolean(sup?.pid) && sup.status === 'running' && (await import('./proc-identity.mjs')).pidAlive(sup.pid, sup.identity, { eperm: false }); } catch { running = false; }
  const tail = 'Launchers, the watchdog and the watch pass reload on their next pass (a heartbeat or a watch pass apart).';
  if (!running) return { code: 0, text: `Asked for a reload (${who}). The supervisor isn't running here, so the new settings apply when it starts (npm run studio:start). ${tail}` };
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    const a = readJson(ACK_FILE());
    if (a?.id === id) return { code: 0, text: `The supervisor (pid ${a.pid}) reloaded .env: ${a.line}${a.kept?.length ? `; it kept the value it was started with for ${a.kept.join(', ')} (set in its environment, which wins over .env)` : ''}. ${tail}` };
    await new Promise((r) => setTimeout(r, 250));
  }
  return { code: 0, text: `Queued: the supervisor reloads on its next pass (pid ${sup.pid}, asked by ${who}; no answer within one pass, ${Math.round(waitMs / 1000)} s). ${tail}` };
}

/**
 * 2.79 (f): the STUDIO_* names a .env sets (names only, never values) and which of them the harness no longer reads.
 * "Read" = the settings map (docs/SETTINGS.md, generated from the code: a name ending in _ or * is a family), else a
 * scan of the code when the map is missing. { names, unknown, known: false when no map or code could be found }.
 */
/**
 * 2.79.1 (e): switches removed from the harness, as the part after STUDIO_ (written so the settings map doesn't read them
 * as settings). A .env that still sets one is flagged unknown even when a family wildcard in the map would cover it.
 */
export const REMOVED_SETTINGS = ['LANE_LOCKS', 'TYPE_EVIDENCE', 'UNITY_PLAYMODE_RETRY', 'TRAIN_GREEN_FIRST', 'STAGE1_PLAYTEST', 'REVIEW_VERDICT_LINE', 'DONE_SKIP_GAME_NONCODE', 'TRAIN_LAND_OVER_NONCODE', 'OWNER_ONLY_PARK',
  // 2.80 (b2): read only by the hub and the War Room modules, which are gone.
  'HUB_HANG_MIN', 'HUB_PAIR_CODE_MIN', 'HUB_PAIR_DAYS', 'PHONE_SECURE_COOKIE', 'AWAY_REFILL_MIN', 'AWAY_REVIEW_MIN', 'FLOOR_IDLE_MIN', 'PLANNING_ROOM', 'FLOW_INTERVAL',
  // 2.81: the Liaison role is gone, and with it the settings that started it.
  'LIAISON_TOOL', 'LIAISON_CMD', 'LIAISON_MODEL'].map((k) => `STUDIO_${k}`);
export function envNameReport({ root = REPO_ROOT, file = path.join(root, '.env') } = {}) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { text = ''; }
  const names = [...new Set([...text.replace(/\r/g, '').matchAll(/^\s*(?:export\s+)?(STUDIO_[A-Za-z0-9_]+)\s*=/gm)].map((m) => m[1].toUpperCase()))].sort();
  let mapText = '';
  try { mapText = fs.readFileSync(path.join(root, 'docs', 'SETTINGS.md'), 'utf8'); } catch { mapText = ''; }
  const known = new Set([...mapText.matchAll(/^- `(STUDIO_[A-Z0-9_*]+)`/gm)].map((m) => m[1]));
  const families = [...known].filter((k) => k.endsWith('*')).map((k) => k.slice(0, -1));
  const readable = known.size > 0;
  const unknown = readable ? names.filter((n) => REMOVED_SETTINGS.includes(n) || (!known.has(n) && !families.some((f) => n.startsWith(f)))) : [];
  return { names, unknown, known: readable };
}
/** The text `npm run studio:reload-env` prints after the reload line. */
export function envNameText(r) {
  if (!r.names.length) return 'The .env sets no STUDIO_* names.';
  const lines = [`The .env sets ${r.names.length} STUDIO_* names (names only, no values):`, ...r.names.map((n) => `  ${n}${r.unknown.includes(n) ? '   unknown (removed or misspelled)' : ''}`)];
  if (!r.known) lines.push('(docs/SETTINGS.md not found: could not check which names the harness still reads.)');
  else if (r.unknown.length) lines.push(`${r.unknown.length} name${r.unknown.length === 1 ? '' : 's'} the harness no longer reads: remove or fix ${r.unknown.length === 1 ? 'it' : 'them'} in .env.`);
  return lines.join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--by');
  const r = await reloadCli({ by: i >= 0 ? argv[i + 1] : null });
  console.log(r.text);
  try { console.log(envNameText(envNameReport())); } catch {}
  process.exit(r.code);
}
