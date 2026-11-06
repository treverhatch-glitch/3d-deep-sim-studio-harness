/**
 * harness/owner-proxy.mjs — 2.73.1 (B-67, the owner's emergency request): a standing owner-proxy grant.
 *
 * The owner's words (2026-11-03): "give discord opus full permissions to do everything. We can't run the harness if
 * opus discord isn't able to run it", and "just make Opus be able to do everything if I say yes via discord". So the
 * owner can sign ONE standing grant that makes one named outside agent (the crew's orchestrator) their proxy:
 *
 *   npm run delegate -- proxy <agent> --by <owner> [--days N] [--why "…"]     (the owner, once, where the key is)
 *
 * studio/delegation.json then holds { agent, actions: ["*"], proxy: true, until, by, at, why, signature }. While it
 * counts, the proxy agent (its shell sets STUDIO_LOCK_OWNER=<agent>) may do everything the owner can in the harness:
 *   - every delegable action (delegationFor covers any action, with --by <agent> or --by <owner>);
 *   - every command that takes a person's permission (--by <owner>): the grant stands in for --permission;
 *   - signing approvals (protected files, gates and the protected list, weakened tests, hooks, forced dones) without the
 *     owner's private key: `npm run approve -- protected --note "…" --by <owner> --permission "<the owner's yes on
 *     Discord: words or a message link>"` writes an approval that carries the signed grant instead of a signature. The
 *     owner's yes is required for these (10+ characters), and kept in the approval and the decision log.
 * Never: money (the harness spends none), a worker or launched session (STUDIO_ROLE), a lane copy, granting itself
 * another delegation. `npm run delegate -- revoke` (anyone) ends it at once: proxy approvals count only while the grant
 * that made them is still the one on file, so revoking also voids approvals not yet landed.
 *
 * This module has no harness imports beyond hash.mjs, event.mjs and owner-acts.mjs (a list, no imports) on purpose: permission.mjs, approve.mjs and
 * delegation.mjs all use it, and they import each other.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { canonicalBytes } from './hash.mjs';
import { REPO_ROOT } from './event.mjs';
import { OWNER_ONLY_ACTIONS } from './owner-acts.mjs';

export const DELEGATION_REL = 'studio/delegation.json';
export const OWNER_PUB_REL = 'studio/keys/owner-ed25519.pub.pem';
export const PROXY_MAX_DAYS = 366;
export const PROXY_DEFAULT_DAYS = 30;
/**
 * What a proxy never covers, by action name: 2.79 (c), the owner's own acts (harness/owner-acts.mjs, the one list: real
 * money, deleting data, keys and credentials, publishing outside the PC, turning beta mode off).
 */
export const PROXY_NEVER = OWNER_ONLY_ACTIONS;
export const GRANT_FIELDS = ['agent', 'actions', 'until', 'by', 'at', 'why'];
const WORKER = /^(builder|rnd|qa|qa-playtester|playtester|reviewer|art|artist|art-director|designer|designer-calibrator|balancer|fun-tester|scout|reference-scout|engine-porter|dev-hacker|planner|liaison)(-|_|\d|$)/i;

/** The signed part of a delegation: the 2.67 fields, plus `proxy: true` only on a proxy grant (old signatures stay valid). */
export function grantBody(d) {
  const b = Object.fromEntries(GRANT_FIELDS.map((k) => [k, d?.[k]]));
  if (d?.proxy === true) b.proxy = true;
  return b;
}
export function verifyGrant(doc, pubPem) {
  try {
    return Boolean(doc?.signature && pubPem) && crypto.verify(null, Buffer.from(canonicalBytes(grantBody(doc))), crypto.createPublicKey(pubPem), Buffer.from(String(doc.signature), 'base64'));
  } catch { return false; }
}
export const isProxyGrant = (d) => Boolean(d && d.proxy === true && Array.isArray(d.actions) && d.actions.length === 1 && d.actions[0] === '*');

const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
/** The studio's main checkout, found by git from here (never from STUDIO_MAIN_ROOT, which a lane could point anywhere). */
export function mainCheckout(from = REPO_ROOT) {
  const r = git(from, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const common = r.status === 0 ? String(r.stdout).trim() : '';
  if (common && path.basename(common) === '.git') return path.dirname(common);
  const top = git(from, 'rev-parse', '--show-toplevel');
  return top.status === 0 ? String(top.stdout).trim() : from;
}
const same = (a, b) => {
  const n = (p) => { try { p = fs.realpathSync.native(p); } catch { p = path.resolve(p); } return process.platform === 'win32' ? p.toLowerCase() : p; };
  return n(a) === n(b);
};
/** Is this process in a lane copy (a worktree other than the main checkout)? */
export const inLane = (from = REPO_ROOT) => !same(mainCheckout(from), from);

function committed(root, rel) {
  const r = git(root, 'show', `HEAD:${rel}`);
  return r.status === 0 ? String(r.stdout) : null;
}
export function ownerPubAt(root) {
  const pem = committed(root, OWNER_PUB_REL);
  return /BEGIN PUBLIC KEY/.test(pem || '') ? pem : null;
}

/**
 * The proxy grant on file in the main checkout (as committed) and whether it counts now:
 * { ok, doc, signed, why }. With an owner key it must carry the key's valid signature; without one it is a record
 * (like every delegation before the owner key exists). Never throws.
 */
export function readProxyGrant({ root = mainCheckout(), now = Date.now() } = {}) {
  const text = committed(root, DELEGATION_REL);
  if (text == null) return { ok: false, doc: null, why: 'no delegation committed' };
  let doc;
  try { doc = JSON.parse(text); } catch { return { ok: false, doc: null, why: `${DELEGATION_REL} isn't valid JSON` }; }
  if (!isProxyGrant(doc)) return { ok: false, doc: null, why: 'the delegation on file is not an owner proxy' };
  if (!/^[\w.-]{1,60}$/.test(String(doc.agent || '')) || WORKER.test(doc.agent)) return { ok: false, doc, why: 'the proxy names no outside agent' };
  if (!Number.isFinite(Date.parse(doc.at)) || !Number.isFinite(Date.parse(doc.until))) return { ok: false, doc, why: 'the proxy has no valid at/until times' };
  const pub = ownerPubAt(root);
  const signed = pub ? verifyGrant(doc, pub) : false;
  if (pub && !signed) return { ok: false, doc, why: `${DELEGATION_REL} is a proxy grant without a valid owner signature` };
  const t = Number(now);
  if (t > Date.parse(doc.until)) return { ok: false, doc, signed, why: `the owner proxy for ${doc.agent} ended at ${String(doc.until).slice(0, 16)}` };
  if (t < Date.parse(doc.at) - 5 * 60000) return { ok: false, doc, signed, why: `the owner proxy for ${doc.agent} starts at ${String(doc.at).slice(0, 16)}` };
  return { ok: true, doc, signed, pub, why: '' };
}

/**
 * Is this shell the proxy agent's, where the proxy counts? { ok, doc, words, why }. The shell names itself with
 * STUDIO_LOCK_OWNER=<agent>; a launched session (STUDIO_ROLE) or a worker name never counts, nor a lane copy unless
 * allowLane (approvals: the proxy signs a lane's protected change in that lane, and commits the approval there).
 */
export function proxyShell({ env = process.env, from = REPO_ROOT, now = Date.now(), allowLane = false } = {}) {
  const me = String(env.STUDIO_LOCK_OWNER || '').trim();
  if (!me) return { ok: false, why: '' };
  if (String(env.STUDIO_ROLE || '').trim()) return { ok: false, why: 'a launched session is never the owner proxy' };
  if (WORKER.test(me)) return { ok: false, why: `${me} is a worker agent` };
  let lane = false;
  try { lane = !allowLane && inLane(from); } catch { lane = true; }
  if (lane) return { ok: false, why: 'a lane copy is never covered by the owner proxy' };
  const g = readProxyGrant({ root: mainCheckout(from), now });
  if (!g.doc || me.toLowerCase() !== String(g.doc.agent).toLowerCase()) return { ok: false, why: '' };
  if (!g.ok) return { ok: false, doc: g.doc, why: g.why };
  return { ok: true, doc: g.doc, signed: g.signed, words: proxyWords(g.doc), why: '' };
}
export const proxyWords = (doc) => `owner proxy: the standing grant to ${doc.agent} by ${doc.by} at ${String(doc.at).slice(0, 16)} (${DELEGATION_REL}${doc.why ? `: ${String(doc.why).slice(0, 120)}` : ''})`;

/**
 * An approval made by the proxy (no signature, the signed grant embedded): does it count? It needs the grant's valid
 * signature by the owner key, the grant still being the one on file in the main checkout (so a revoke voids it), the
 * approval made inside the grant's window by the grant's agent, and the owner's yes recorded (10+ characters).
 */
export function proxyApprovalOk(doc, pubPem, { root = null, now = Date.now() } = {}) {
  const g = doc?.proxy?.grant;
  const a = doc?.approval;
  if (!a || !isProxyGrant(g) || !pubPem || !verifyGrant(g, pubPem)) return false;
  const t = Date.parse(a.at);
  if (!(t >= Date.parse(g.at) - 5 * 60000 && t <= Date.parse(g.until) && Number(now) <= Date.parse(g.until))) return false;
  if (String(a.recordedBy || '').toLowerCase() !== String(g.agent).toLowerCase()) return false;
  if (String(a.permission || '').trim().length < 10) return false;
  let current = null;
  try { current = readProxyGrant({ root: root || mainCheckout(), now }); } catch { return false; }
  return Boolean(current.ok && current.doc?.signature === g.signature);
}
