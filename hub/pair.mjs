/**
 * hub/pair.mjs — 2.74.0 (B-70, the owner's "Fixed it: try again" didn't work): pair a person's browser with the War Room
 * once, instead of hand-copying HUB_TOKEN into the Ops view.
 *
 *   npm run hub -- pair --by <your name>     prints a one-time code (and a link) that pairs one browser on this machine
 *   npm run hub -- pairs                     the paired browsers (name, when, last used); never a token
 *   npm run hub -- unpair <id> | --by <name> | --all   forget paired browsers (anyone may: it only takes power away)
 *
 * The browser opens http://127.0.0.1:<port>/pair?code=XXXX-XXXX (or types the code into the Ops view); the hub swaps the
 * code for a long-lived browser token in an HttpOnly, SameSite=Strict cookie. Only the token's sha256 is kept, in
 * .studio/hub-pairs.json (never in the repo; .studio/ is ignored), and the token is never printed. A code works once,
 * for STUDIO_HUB_PAIR_CODE_MIN (10) minutes; ten wrong codes in ten minutes void every open code. A pairing lapses after
 * STUDIO_HUB_PAIR_DAYS (30) days without use.
 *
 * Who may pair: a person in their own terminal. `pair` is refused in a launched session, a lane copy, a coding agent's
 * shell or under an agent's name (the same checks `npm run delegate -- grant` makes, harness/delegation.mjs). The
 * pairing records that person's name: what the browser does is done `--by <that name>`.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STUDIO_STATE_DIR } from '../harness/event.mjs';
import { writeAtomic } from '../harness/fsafe.mjs';

export const PAIRS_FILE = (stateDir = STUDIO_STATE_DIR) => path.join(stateDir, 'hub-pairs.json');
export const COOKIE = 'hub_pair';
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'; // no 0/O, 1/I/L, U
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
export const codeMinutes = (env = process.env) => num(env.STUDIO_HUB_PAIR_CODE_MIN, 10);
export const pairDays = (env = process.env) => num(env.STUDIO_HUB_PAIR_DAYS, 30);
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function readStore(stateDir) {
  try {
    const j = JSON.parse(fs.readFileSync(PAIRS_FILE(stateDir), 'utf8'));
    return { codes: Array.isArray(j.codes) ? j.codes : [], pairs: Array.isArray(j.pairs) ? j.pairs : [], fails: Array.isArray(j.fails) ? j.fails : [] };
  } catch {
    return { codes: [], pairs: [], fails: [] };
  }
}
function writeStore(stateDir, s) {
  fs.mkdirSync(stateDir, { recursive: true });
  writeAtomic(PAIRS_FILE(stateDir), `${JSON.stringify(s, null, 2)}\n`);
  try { fs.chmodSync(PAIRS_FILE(stateDir), 0o600); } catch { /* Windows: the user's profile ACLs apply */ }
}
/** Drop lapsed codes, pairings and old failures. */
function prune(s, now, env) {
  const idle = pairDays(env) * 86400000;
  return {
    codes: s.codes.filter((c) => Date.parse(c.expiresAt) > now),
    pairs: s.pairs.filter((p) => now - (Date.parse(p.lastUsedAt || p.at) || 0) < idle),
    fails: s.fails.filter((t) => now - t < 600000),
  };
}

/** Why this shell may not pair a browser for `by`, or ''. */
export async function pairRefusal({ by, env = process.env, stateDir = STUDIO_STATE_DIR } = {}) {
  const who = String(by || '').trim();
  if (!who) return 'say who you are: npm run hub -- pair --by <your name>';
  const { ownerShellRefusal } = await import('../harness/delegation.mjs');
  const { agentLikeName } = await import('../harness/agent-env.mjs');
  const shell = ownerShellRefusal({ env });
  if (shell) return `${shell}. A person pairs their own browser, from their own terminal`;
  if (agentLikeName(who, { stateDir })) return `"${who}" is an agent's name; --by names the person whose browser this is`;
  if (!/^[\w.@-]{1,40}$/.test(who)) return '--by takes a plain name (letters, digits, . _ - @; up to 40)';
  return '';
}

/** `pair --by <name>`: a one-time code. { ok, code, expiresAt } or { ok: false, message }. */
export async function createPairCode({ by, env = process.env, stateDir = STUDIO_STATE_DIR, now = Date.now() } = {}) {
  const refused = await pairRefusal({ by, env, stateDir });
  if (refused) return { ok: false, message: `Not paired: ${refused}.` };
  const raw = Array.from(crypto.randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join('');
  const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
  const s = prune(readStore(stateDir), now, env);
  const expiresAt = new Date(now + codeMinutes(env) * 60000).toISOString();
  s.codes = [...s.codes.slice(-4), { hash: sha(raw), by: String(by).trim(), at: new Date(now).toISOString(), expiresAt }];
  writeStore(stateDir, s);
  return { ok: true, code, by: String(by).trim(), expiresAt };
}

/**
 * The browser's half: swap a code for a token. { ok, token, pair: { id, by } } or { ok: false, message, retryAfterSec? }.
 * The token is returned once, for the Set-Cookie header, and only its hash is stored.
 */
export function claimPairCode(code, { ua = '', stateDir = STUDIO_STATE_DIR, env = process.env, now = Date.now() } = {}) {
  const s = prune(readStore(stateDir), now, env);
  if (s.fails.length >= 10) {
    s.codes = [];
    writeStore(stateDir, s);
    return { ok: false, message: 'Too many wrong codes: every open code is void. Run npm run hub -- pair --by <your name> again in a few minutes.', retryAfterSec: 600 };
  }
  const h = sha(normCode(code));
  const hit = s.codes.find((c) => typeof c.hash === 'string' && c.hash.length === h.length && crypto.timingSafeEqual(Buffer.from(c.hash, 'hex'), Buffer.from(h, 'hex')));
  if (!hit) {
    s.fails.push(now);
    writeStore(stateDir, s);
    return { ok: false, message: 'That code is wrong, used or expired. Run npm run hub -- pair --by <your name> in a terminal for a new one.' };
  }
  const token = crypto.randomBytes(32).toString('base64url');
  const pair = { id: `P-${crypto.randomBytes(3).toString('hex')}`, hash: sha(token), by: hit.by, at: new Date(now).toISOString(), lastUsedAt: new Date(now).toISOString(), ua: String(ua).slice(0, 120) };
  s.codes = s.codes.filter((c) => c !== hit);
  s.pairs.push(pair);
  writeStore(stateDir, s);
  return { ok: true, token, pair: { id: pair.id, by: pair.by, at: pair.at } };
}

let touchAt = new Map();
/** The pairing a browser token belongs to ({ id, by, at }), or null. Marks it used (at most once a minute). */
export function pairFor(token, { stateDir = STUDIO_STATE_DIR, env = process.env, now = Date.now() } = {}) {
  if (!token || String(token).length < 20) return null;
  const h = sha(token);
  const s = readStore(stateDir);
  const p = prune(s, now, env).pairs.find((x) => typeof x.hash === 'string' && x.hash.length === h.length && crypto.timingSafeEqual(Buffer.from(x.hash, 'hex'), Buffer.from(h, 'hex')));
  if (!p) return null;
  if (now - (touchAt.get(p.id) || 0) > 60000) {
    touchAt.set(p.id, now);
    try { const all = readStore(stateDir); const q = all.pairs.find((x) => x.id === p.id); if (q) { q.lastUsedAt = new Date(now).toISOString(); writeStore(stateDir, all); } } catch { /* a missed touch only shortens the idle window */ }
  }
  return { id: p.id, by: p.by, at: p.at };
}

/** The paired browsers, without hashes. */
export function listPairs({ stateDir = STUDIO_STATE_DIR, env = process.env, now = Date.now() } = {}) {
  return prune(readStore(stateDir), now, env).pairs.map((p) => ({ id: p.id, by: p.by, at: p.at, lastUsedAt: p.lastUsedAt || p.at, ua: p.ua || '' }));
}

/** Forget pairings: by id, by name, all, or the one a token belongs to. { ok, removed: [ids], message }. */
export function unpair({ id = null, by = null, all = false, token = null, stateDir = STUDIO_STATE_DIR } = {}) {
  const s = readStore(stateDir);
  const h = token ? sha(token) : null;
  const gone = s.pairs.filter((p) => all || (id && p.id === id) || (by && String(p.by).toLowerCase() === String(by).toLowerCase()) || (h && p.hash === h));
  if (!gone.length) return { ok: true, removed: [], message: 'No paired browser matched: nothing changed.' };
  s.pairs = s.pairs.filter((p) => !gone.includes(p));
  if (all) s.codes = [];
  writeStore(stateDir, s);
  return { ok: true, removed: gone.map((p) => p.id), message: `Forgot ${gone.length} paired browser${gone.length === 1 ? '' : 's'} (${gone.map((p) => `${p.id} ${p.by}`).join(', ')}). They are read-only again until paired anew.` };
}

/** The cookie that carries a browser token: HttpOnly, SameSite=Strict, the whole site, for the idle window. */
export const pairCookie = (token, env = process.env) => `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.round(pairDays(env) * 86400)}`;
export const clearCookie = () => `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
export const cookieToken = (header) => {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(String(header || ''));
  return m ? m[1] : '';
};

/**
 * The environment a paired person's action runs with. The hub's own process may have been started by an agent's shell
 * (the supervisor restarts it; B-60's inherited STUDIO_LOCK_OWNER): those markers say who started the hub, not who
 * pressed the button. The person was checked when they paired (pairRefusal), so the agent markers are left out here and
 * every other setting (STUDIO_RESUME_BY and the rest) is kept.
 */
export const AGENT_MARKERS = ['STUDIO_ROLE', 'STUDIO_LOCK_OWNER', 'STUDIO_AGENT', 'STUDIO_TRACK', 'CLAUDECODE', 'AI_AGENT', 'CODEX_SANDBOX', 'GEMINI_CLI'];
export function personEnv(env = process.env) {
  const out = { ...env };
  for (const k of AGENT_MARKERS) delete out[k];
  return out;
}

/** `npm run hub -- pair|pairs|unpair …`. Returns { code, text }. */
export async function pairCli(argv, { env = process.env, stateDir = STUDIO_STATE_DIR, port = Number(env.HUB_PORT || 3847) } = {}) {
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--') ? argv[i + 1] : null; };
  const cmd = argv[0];
  if (cmd === 'pair') {
    const r = await createPairCode({ by: opt('--by'), env, stateDir });
    if (!r.ok) return { code: 1, text: r.message };
    return { code: 0, text: [
      `Pair your browser as ${r.by} (one use, until ${r.expiresAt.slice(11, 16)} UTC):`,
      `  open  http://127.0.0.1:${port}/pair?code=${r.code}`,
      `  or type ${r.code} into "Pair this browser" in the War Room's Ops view.`,
      'The code is the only thing printed: the browser gets its own token (an HttpOnly cookie, this machine only). npm run hub -- unpair --by <name> forgets it.',
    ].join('\n') };
  }
  if (cmd === 'pairs') {
    const list = listPairs({ stateDir, env });
    return { code: 0, text: list.length ? list.map((p) => `${p.id}  ${p.by}  paired ${p.at.slice(0, 16)}  last used ${String(p.lastUsedAt).slice(0, 16)}${p.ua ? `  (${p.ua.slice(0, 60)})` : ''}`).join('\n') : 'No paired browser (npm run hub -- pair --by <your name>).' };
  }
  if (cmd === 'unpair') {
    const id = argv[1] && !argv[1].startsWith('--') ? argv[1] : null;
    if (!id && !opt('--by') && !argv.includes('--all')) return { code: 1, text: 'Usage: npm run hub -- unpair <P-id> | --by <name> | --all' };
    const r = unpair({ id, by: opt('--by'), all: argv.includes('--all'), stateDir });
    return { code: 0, text: r.message };
  }
  return { code: 1, text: 'Usage: npm run hub -- pair --by <your name> | pairs | unpair <P-id> | --by <name> | --all' };
}
