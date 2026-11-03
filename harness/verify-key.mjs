/**
 * harness/verify-key.mjs — 2.73.0 (g): the studio's local verify key, and the HMAC-SHA256 signatures made with it.
 *
 * A verify record (and its run log) and a golden's first-divergence report are reused only when the harness signed
 * them. The key is made on first use (a full verify, a red golden) and kept OUTSIDE every checkout and lane:
 *   ~/.studio-verify/<studio-id>.key   (STUDIO_VERIFY_KEY_DIR names another folder; mode 600 where the OS has modes)
 * <studio-id> is a hash of the repository's git common dir, which the main checkout, its lanes (.lanes/<agent>) and the
 * train's scratch copies share, so one key serves the whole studio; a folder that is not a git checkout uses its own
 * path. A key folder inside the studio's main checkout or any of its worktrees is refused (a lane could commit or read
 * it as a file): nothing is signed then, and nothing is reused. The key is never printed, logged or committed; only a
 * short key id (a hash of the key) appears in run logs and reports.
 *
 * What it stops: a record, run log or report written by hand (an agent's file write, a copy from another studio).
 * What it does not stop: a process running as the same user can read the key file and sign anything; lanes run
 * run-gates as that user. Records from before 2.73.0 carry no signature: they are simply not reused (no migration).
 *
 * Node built-ins only: harness/gate-trust.mjs imports it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const gitEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|PREFIX|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM)$/.test(k)));
const git = (cwd, args) => {
  try {
    const r = spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', env: gitEnv(), windowsHide: true });
    return r.status === 0 ? String(r.stdout) : null;
  } catch { return null; }
};
const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
// A folder that isn't there yet (a key folder before its first key) resolves through its nearest existing parent:
// on Windows the temp folder can be a short 8.3 name (RUNNER~1) that only the real path spells out (2.73.0, CI).
const real = (p) => {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try { return norm(path.join(fs.realpathSync.native(cur), ...rest)); } catch { /* not there: try its parent */ }
    const up = path.dirname(cur);
    if (up === cur) return norm(path.resolve(p));
    rest.unshift(path.basename(cur));
    cur = up;
  }
};
const under = (p, dir) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export const SIG_ALG = 'hmac-sha256';
const DOMAIN = 'studio-verify-v1';

const places = new Map();
/**
 * Where this studio's key lives: { id, dir, file, ok, why }. ok is false (with why in plain words) when the key folder
 * is inside the studio's main checkout or one of its worktrees. Cached per checkout and key folder.
 */
export function keyPlace(root, env = process.env) {
  const dir = path.resolve(String(env.STUDIO_VERIFY_KEY_DIR || '').trim() || path.join(os.homedir(), '.studio-verify'));
  const cacheKey = `${real(root)}\n${dir}`;
  if (places.has(cacheKey)) return places.get(cacheKey);
  const cd = (git(root, ['rev-parse', '--git-common-dir']) || '').trim();
  const base = cd ? real(path.resolve(root, cd)) : real(root);
  const id = sha(`studio-id:${base}`).slice(0, 16);
  const checkouts = [real(root)];
  const top = (git(root, ['rev-parse', '--show-toplevel']) || '').trim();
  if (top) checkouts.push(real(top));
  for (const l of (git(root, ['worktree', 'list', '--porcelain']) || '').split('\n')) if (l.startsWith('worktree ')) checkouts.push(real(l.slice(9).trim()));
  if (cd && path.basename(base) === '.git') checkouts.push(path.dirname(base)); // the main checkout holds <main>/.git
  const rd = real(dir);
  const inside = checkouts.find((c) => under(rd, c));
  const res = { id, dir, file: path.join(dir, `${id}.key`), ok: !inside, why: inside ? `the verify key folder (${dir}) is inside a checkout of this studio (${inside}): keep it outside every checkout and lane (STUDIO_VERIFY_KEY_DIR, default ~/.studio-verify)` : '' };
  places.set(cacheKey, res);
  return res;
}

/** The key (a Buffer) or { error }. With create, makes it on first use (mode 600; a folder of mode 700). Never prints it. */
export function verifyKey(root, { create = false, env = process.env } = {}) {
  const p = keyPlace(root, env);
  if (!p.ok) return { error: p.why };
  const read = () => { try { const t = fs.readFileSync(p.file, 'utf8').trim(); return /^[0-9a-f]{64}$/.test(t) ? Buffer.from(t, 'hex') : null; } catch { return null; } };
  const have = read();
  if (have) return { key: have, id: keyId(have) };
  if (fs.existsSync(p.file)) return { error: `the verify key file ${p.file} can't be read or isn't a key` };
  if (!create) return { error: `this studio has no verify key yet (${p.file})` };
  try {
    fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(p.file, `${crypto.randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e?.code !== 'EEXIST') return { error: `couldn't make the verify key in ${p.dir} (${e?.code || 'error'})` };
  }
  const made = read();
  return made ? { key: made, id: keyId(made), made: true } : { error: `couldn't read the verify key ${p.file} back` };
}

/** A short id of a key (a hash: says which key signed, never the key). */
export const keyId = (key) => sha(Buffer.concat([Buffer.from('studio-verify-key-id:'), key])).slice(0, 12);

const mac = (key, payload) => crypto.createHmac('sha256', key).update(`${DOMAIN}\n${payload}`).digest('hex');

/** Sign a payload string: { alg, keyId, value } or { error }. */
export function signPayload(root, payload, { create = true, env = process.env } = {}) {
  const k = verifyKey(root, { create, env });
  if (k.error) return { error: k.error };
  return { alg: SIG_ALG, keyId: k.id, value: mac(k.key, String(payload)) };
}

/**
 * Check a signature: { ok, why }. why is one of 'unsigned' (no signature), 'nokey' (this studio has no key to check
 * with: the message says so), 'bad' (made with another key, or the payload changed), each with a message in `text`.
 */
export function checkSignature(root, payload, sig, { env = process.env } = {}) {
  if (!sig || typeof sig !== 'object' || typeof sig.value !== 'string' || !sig.value) return { ok: false, why: 'unsigned', text: 'unsigned (hand-written or from an older harness)' };
  if (sig.alg !== SIG_ALG || !/^[0-9a-f]{64}$/.test(sig.value)) return { ok: false, why: 'bad', text: 'bad signature (not one the harness makes)' };
  const k = verifyKey(root, { create: false, env });
  if (k.error) return { ok: false, why: 'nokey', text: `its signature can't be checked: ${k.error}` };
  const want = Buffer.from(mac(k.key, String(payload)), 'hex');
  const got = Buffer.from(sig.value, 'hex');
  if (want.length === got.length && crypto.timingSafeEqual(want, got)) return { ok: true, why: '', text: 'signed by this studio\'s harness' };
  return { ok: false, why: 'bad', text: sig.keyId && sig.keyId !== k.id ? 'bad signature (made with another studio\'s key, or hand-written)' : 'bad signature (edited after the harness signed it, or hand-written)' };
}
