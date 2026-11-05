/**
 * harness/beta-mode.mjs — 2.76.0 (the owner's request, 2026-11-04): beta mode, the owner gates off while the harness is
 * built.
 *
 * The owner's words: "i kinda want us to drop these permission things for now actually. we are still in beta for the
 * harness build and these things really slow us down ... if we are patching things every 10 minutes and we need keys for
 * everything this becomes a full time job for me" and "allow [the orchestrator] to have the same permissions to get tasks
 * done as i would have". So one switch, set once:
 *
 *   npm run beta -- on --by <owner> [--agents opus-1,patch] [--why "…"] [--permission "<the owner's words or a link>"]
 *   npm run beta -- off --by <name>            anyone may: it only takes power away
 *   npm run beta -- status [--json]
 *
 * studio/beta.json { on, by, at, why, agents, roles, signature? | recordedBy+permission? } as committed in the main
 * checkout. While it is on, the named outside agents (the crew's orchestrator) and the planning roles' launched sessions
 * (Producer, Director) act as the owner without the owner key or the owner's words for each step: every owner action
 * (harness/delegation.mjs delegationFor), approvals of protected files, gates, tests, hooks and forced dones
 * (harness/approve.mjs, an approval that carries this file instead of a signature), answering owner asks, releasing a
 * golden re-record. Every use is logged (who, why) and shown in the daily digest and the War Room, so the owner reviews
 * afterwards instead of approving before. What stays on: the game's tests, the train's full verify, no deletes, no money,
 * worker sessions never act as the owner.
 *
 * Who may turn it on: the owner in their own terminal (signed with the owner key when the private key is here), or the
 * owner proxy's own shell recording the owner's yes (--permission), like any proxy approval. A commit that set it from
 * a worker's session (Studio-Agent trailer naming a worker) doesn't count. No harness imports beyond owner-proxy.mjs,
 * hash.mjs, event.mjs and permission.mjs (its name lists and mayDecide; it imports this file back, used only inside
 * functions): approve.mjs, delegation.mjs and permission.mjs use it.
 *
 * 2.78.2 (h), the owner's rule (2026-11-05): which beta actor makes which decision is permission.mjs mayDecide. Board
 * decisions: the owner, the outside orchestrator, a Producer/Director session. Protected decisions (protected files,
 * weakened tests, hooks, task done --force, a protected config change): the owner and outside agents only, unless the
 * owner's switch STUDIO_PRODUCER_APPROVES=protected is on. Every beta record is judged by one predicate, betaRecordVerdict.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalBytes } from './hash.mjs';
import { REPO_ROOT, emitEvent, readRecentEvents } from './event.mjs';
import { mainCheckout, ownerPubAt, proxyShell, inLane } from './owner-proxy.mjs';
import { WORKER_NAME as WORKER, AGENT_SHELL, mayDecide, actorOf, recordTier, decisionClass } from './permission.mjs';

export const BETA_REL = 'studio/beta.json';
export const BETA_ROLES = ['producer', 'director'];
export const BETA_NEVER = ['money', 'spend', 'payment', 'delete'];
const FIELDS = ['on', 'by', 'at', 'why', 'agents', 'roles'];
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
const body = (d) => Object.fromEntries(FIELDS.map((k) => [k, d?.[k]]));
const short = (iso) => String(iso || '').slice(0, 16).replace('T', ' ');
const keyPath = (env) => env.STUDIO_OWNER_KEY || path.join(os.homedir(), '.studio-owner', 'owner-ed25519.pem');

function verifyBeta(doc, pub) {
  try { return Boolean(doc?.signature && pub) && crypto.verify(null, Buffer.from(canonicalBytes(body(doc))), crypto.createPublicKey(pub), Buffer.from(String(doc.signature), 'base64')); } catch { return false; }
}

/**
 * Beta mode as committed in the main checkout: { on, doc, why, signed, setBy }. Never throws. `on` needs the file
 * committed with on: true and one of: the owner key's valid signature; the owner proxy's recorded yes (recordedBy is the
 * proxy agent, a permission line); or a commit that is a person's or an outside agent's (no worker's Studio-Agent).
 */
export function readBeta({ root = mainCheckout(), now = Date.now() } = {}) {
  const shown = git(root, 'show', `HEAD:${BETA_REL}`);
  if (shown.status !== 0) return { on: false, doc: null, why: 'beta mode is off (no studio/beta.json committed)' };
  let doc;
  try { doc = JSON.parse(shown.stdout); } catch { return { on: false, doc: null, why: `${BETA_REL} isn't valid JSON` }; }
  if (doc?.on !== true) return { on: false, doc, why: `beta mode is off (${BETA_REL} by ${doc?.by || '?'} at ${short(doc?.at)})` };
  if (!String(doc.by || '').trim() || !Number.isFinite(Date.parse(doc.at))) return { on: false, doc, why: `${BETA_REL} doesn't say who set it and when` };
  const pub = ownerPubAt(root);
  const signed = pub ? verifyBeta(doc, pub) : false;
  const log = git(root, 'log', '-1', '--format=%H%x09%(trailers:key=Studio-Agent,valueonly,separator=%x2C)', 'HEAD', '--', BETA_REL);
  const [sha = '', agent = ''] = String(log.stdout || '').trim().split('\t');
  const committer = agent.trim();
  if (committer && WORKER.test(committer)) return { on: false, doc, why: `${BETA_REL} was set in a worker's commit (${committer}); only the owner or the owner's proxy turns beta mode on` };
  if (doc.recordedBy && String(doc.permission || '').trim().length < 10) return { on: false, doc, why: `${BETA_REL} was recorded by ${doc.recordedBy} without the owner's yes (--permission)` };
  void now;
  return { on: true, doc, signed, commit: sha.slice(0, 8), setBy: committer || 'a person', why: '' };
}
export const betaOn = (opts) => readBeta(opts).on;
export const betaWords = (doc) => `beta mode: set by ${doc.by} at ${short(doc.at)} (${BETA_REL}${doc.why ? `: ${String(doc.why).slice(0, 120)}` : ''})`;

/**
 * Is this caller one beta mode lets act as the owner? { ok, who, via, doc, words, why }. A named outside agent
 * (STUDIO_LOCK_OWNER in agents, or the owner proxy's agent), or a launched Producer/Director session (STUDIO_ROLE);
 * never a worker's name or a worker session. A lane copy counts only with allowLane (approving that lane's own change).
 * 2.78.2 (h): `kind` is the decision (permission.mjs decisionClass; default a board decision): a protected one is refused
 * to a Producer/Director session unless the owner's switch is on (mayDecide), with { refused: true } and who to ask.
 */
export function betaActor({ env = process.env, from = REPO_ROOT, allowLane = false, kind = 'board' } = {}) {
  let root = from;
  try { root = mainCheckout(from); } catch {}
  const b = readBeta({ root });
  if (!b.on) return { ok: false, why: '' };
  const role = String(env.STUDIO_ROLE || '').trim().toLowerCase();
  const me = String(env.STUDIO_LOCK_OWNER || '').trim();
  if (me && WORKER.test(me)) return { ok: false, why: `${me} is a worker agent; beta mode never lets a worker act as the owner` };
  if (role && !(b.doc.roles || BETA_ROLES).includes(role)) return { ok: false, why: `a launched ${role} session doesn't act as the owner in beta mode` };
  let lane = false;
  try { lane = !allowLane && inLane(from); } catch { lane = true; }
  if (lane) return { ok: false, why: 'a lane copy doesn\'t act as the owner in beta mode' };
  const agents = (b.doc.agents || []).map((a) => String(a).toLowerCase());
  let proxyAgent = '';
  try { const p = proxyShell({ env, from, allowLane: true }); if (p.ok) proxyAgent = String(p.doc.agent); } catch {}
  const named = me && (agents.includes(me.toLowerCase()) || me.toLowerCase() === proxyAgent.toLowerCase());
  const decide = () => mayDecide(kind, actorOf({ env, root: from }), { root, agents: b.doc.agents || [] });
  if (role && (b.doc.roles || BETA_ROLES).includes(role)) {
    const d = decide();
    if (!d.ok) return { ok: false, refused: true, why: `Refused: ${d.why}.` };
    return { ok: true, who: me || `a ${role} session`, via: `beta ${role}`, doc: b.doc, words: betaWords(b.doc), why: '', decides: d.cls };
  }
  if (named) {
    const d = decide();
    if (!d.ok) return { ok: false, refused: true, why: `Refused: ${d.why}.` };
    return { ok: true, who: me, via: 'beta agent', doc: b.doc, words: betaWords(b.doc), why: '', decides: d.cls };
  }
  return { ok: false, why: '' };
}

/** An approval made in beta mode (no signature, beta.json embedded): counts while beta mode is still on with that file. */
export function betaApprovalOk(doc, { root = null } = {}) {
  const e = doc?.beta;
  if (!e || doc?.signature) return false;
  const cur = readBeta({ root: root || mainCheckout() });
  if (!cur.on) return false;
  return String(cur.doc.at) === String(e.at) && String(cur.doc.by) === String(e.by) && String(doc.approval?.recordedBy || '').trim() !== '' && !WORKER.test(String(doc.approval.recordedBy));
}

/**
 * 2.78.2 (h): the repository that holds a studio/ record: a lane copy's studio/ is a link to the main checkout's
 * (harness/worktree.mjs), so a record there is committed (or not) in the main checkout, never in the lane's own history.
 */
export function recordRepo(root, rel) {
  try {
    const top = String(rel || '').replace(/\\/g, '/').split('/')[0];
    const real = (p) => { const r = fs.realpathSync.native(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
    if (top && fs.existsSync(path.join(root, top)) && real(path.join(root, top)) !== path.join(real(root), top)) return mainCheckout(root);
  } catch { /* root as given */ }
  return root;
}

/**
 * 2.77.3 (B-111), 2.78.2 (h): the one predicate for every beta-format record (an approval with no signature and
 * studio/beta.json's by/at): task types and visual decisions (harness/reclassify.mjs), config proposal approvals
 * (harness/config-proposal.mjs signedProposal), and since 2.78.2 protected files, weakened tests, hooks and forced dones
 * (harness/approve.mjs verifyApproval, which before accepted one nobody committed). { ok, why, grandfathered }. It counts
 * when it is:
 *   - an approval betaApprovalOk accepts: the current beta session, recordedBy set and not a worker;
 *   - committed with exactly this content (git show HEAD:<rel> equals doc, the reader's `file` key aside) in the
 *     repository that holds it (recordRepo: the main checkout for a lane copy's linked studio/);
 *   - made by someone who may make that kind of decision (permission.mjs mayDecide, judged by recordTier: the role it
 *     was recorded under, who recorded it, the commit's Studio-Agent trailers): never a worker; a protected decision by a
 *     Producer/Director session only with STUDIO_PRODUCER_APPROVES=protected, or (grandfathered) one recorded before
 *     2.78.2 (no `decides` field) under the beta session still on: it stops counting when beta mode's session changes.
 * A file dropped in the folder, edited after its commit, or carried in by a worker proves nothing. The owner's switch is
 * read from the main checkout's .env (permission.mjs producerApprovesProtected). Never throws.
 */
export function betaRecordVerdict(root, rel, doc) {
  const no = (why) => ({ ok: false, why, grandfathered: false });
  try {
    if (!doc || doc.signature || !doc.beta) return no('not a beta record');
    const { file: _file, ...rec } = doc; // readApprovals adds the file name; it isn't part of what was committed
    if (!betaApprovalOk(rec, { root: mainCheckout(root) })) return no('not made under the beta session that is on now, or recorded by no one or by a worker');
    const r = String(rel || '').replace(/\\/g, '/');
    if (!r) return no('no file to find its commit');
    const repo = recordRepo(root, r);
    const log = git(repo, 'log', '-1', '--format=%H%x09%(trailers:key=Studio-Agent,valueonly,separator=%x2C)', 'HEAD', '--', r);
    const [sha = '', agent = ''] = String(log.stdout || '').trim().split('\t');
    if (log.status !== 0 || !/^[0-9a-f]{40}$/.test(sha)) return no(`${r} isn't committed (a beta record counts only once committed)`);
    const committers = agent.split(',').map((a) => a.trim()).filter(Boolean);
    const shown = git(repo, 'show', `HEAD:${r}`);
    if (shown.status !== 0) return no(`${r} isn't committed`);
    if (!Buffer.from(canonicalBytes(JSON.parse(shown.stdout))).equals(Buffer.from(canonicalBytes(rec)))) return no(`${r} was changed after its commit`);
    const a = rec.approval || {};
    const tier = recordTier({ via: a.via, recordedBy: a.recordedBy, committers }, repo);
    const d = mayDecide(a.kind, { tier }, { root: repo });
    if (d.ok) return { ok: true, why: '', grandfathered: false };
    if (tier === 'decider' && decisionClass(a.kind) === 'protected' && !a.decides) return { ok: true, why: `recorded by a Producer/Director session before 2.78.2; counts until beta mode's session changes`, grandfathered: true };
    return no(d.why);
  } catch (e) { return no(`unreadable (${e.message})`); }
}
export const betaRecordCommitted = (root, rel, doc) => betaRecordVerdict(root, rel, doc).ok;

/** `beta on|off`. Returns { ok, message, doc? }. */
export function setBeta({ on, by, agents = '', why = '', permission = '', env = process.env, root = mainCheckout(), commit = true, now = Date.now() } = {}) {
  const who = String(by || '').trim();
  const refuse = (m) => ({ ok: false, message: `Beta mode not changed: ${m}.` });
  if (!who) return refuse('say who: --by <your name>');
  const role = String(env.STUDIO_ROLE || '').trim();
  const me = String(env.STUDIO_LOCK_OWNER || '').trim();
  if (on) {
    if (role) return refuse(`a launched ${role} session can't turn beta mode on; the owner does, or the owner's proxy with the owner's yes`);
    if (me && WORKER.test(me)) return refuse(`${me} is a worker agent`);
    const marker = AGENT_SHELL.find((k) => String(env[k] || '').trim());
    const p = proxyShell({ env, from: root });
    const yes = String(permission || '').trim();
    const viaProxy = p.ok;
    if ((marker || me) && !viaProxy) return refuse(`this shell is an agent's (${marker || `STUDIO_LOCK_OWNER=${me}`}) and not the owner proxy's; the owner turns beta mode on in their own terminal, or the proxy records the owner's yes`);
    if (viaProxy && yes.length < 10) return refuse(`the owner proxy (${p.doc.agent}) turns beta mode on only with the owner's yes recorded: --permission "<their words or a link to the message>"`);
    const list = [...new Set([...(String(agents || '').split(/[,\s]+/).map((x) => x.trim()).filter(Boolean)), ...(viaProxy ? [String(p.doc.agent)] : [])])];
    const bad = list.find((a) => !/^[\w.-]{1,60}$/.test(a) || WORKER.test(a));
    if (bad) return refuse(`${bad} isn't an outside agent's name (workers never act as the owner)`);
    const doc = { on: true, by: viaProxy ? String(p.doc.by) : who.slice(0, 60), at: new Date(now).toISOString(), why: String(why || '').trim().slice(0, 300) || 'beta: the harness is still being built; the owner reviews afterwards', agents: list, roles: BETA_ROLES };
    if (viaProxy) Object.assign(doc, { recordedBy: String(p.doc.agent), permission: yes.slice(0, 500) });
    const pub = ownerPubAt(root);
    const kf = keyPath(env);
    if (pub && !viaProxy && fs.existsSync(kf)) {
      try { doc.signature = crypto.sign(null, Buffer.from(canonicalBytes(body(doc))), crypto.createPrivateKey(fs.readFileSync(kf, 'utf8'))).toString('base64'); } catch (e) { return refuse(`signing failed (${e.message})`); }
      if (!verifyBeta(doc, pub)) return refuse(`the private key at ${kf} doesn't match the studio's owner key`);
    }
    fs.mkdirSync(path.join(root, 'studio'), { recursive: true });
    fs.writeFileSync(path.join(root, BETA_REL), `${JSON.stringify(doc, null, 2)}\n`);
    const c = commit ? commitBeta(root, `beta: on (by ${doc.by}${viaProxy ? `, recorded by ${doc.recordedBy}` : ''})`, doc.why) : { committed: false, note: ' Not committed (--no-commit).' };
    emitEvent({ type: 'beta.on', agent: viaProxy ? doc.recordedBy : doc.by, msg: `beta mode on: ${list.length ? `${list.join(', ')} and ` : ''}Producer/Director sessions act as the owner (${doc.why})`.slice(0, 400), meta: { agents: list, roles: BETA_ROLES, by: doc.by, recordedBy: doc.recordedBy || null, signed: Boolean(doc.signature) } });
    logBeta({ action: 'beta-on', by: doc.by, why: doc.why, evidence: `${list.join(', ') || 'Producer/Director sessions'}${viaProxy ? `; recorded by ${doc.recordedBy}: ${yes.slice(0, 160)}` : ''}`, root });
    return { ok: true, doc, committed: c.committed, message: `Beta mode is on${c.committed ? ` (committed ${BETA_REL})` : ''}.${c.note || ''} ${list.length ? `${list.join(', ')} and ` : ''}Producer/Director sessions now act as the owner, with --by <their name>, no owner key and no --permission: every owner action, owner asks and golden releases; approvals of protected files, weakened tests, hooks, forced dones and protected config changes are the outside agents' only (Producer/Director sessions too with STUDIO_PRODUCER_APPROVES=protected), and count once committed. Every use is logged (npm run decisions; the digest; the War Room). Tests, the train's full verify, no deletes and no money stay on. npm run beta -- off ends it.`.replace(/\s+/g, ' ').trim() };
  }
  if (!fs.existsSync(path.join(root, BETA_REL))) return { ok: true, message: 'Beta mode is already off.' };
  let old = {};
  try { old = JSON.parse(fs.readFileSync(path.join(root, BETA_REL), 'utf8')); } catch {}
  const doc = { on: false, by: who.slice(0, 60), at: new Date(now).toISOString(), why: String(why || '').trim().slice(0, 300) || 'beta mode off', agents: [], roles: [] };
  fs.writeFileSync(path.join(root, BETA_REL), `${JSON.stringify(doc, null, 2)}\n`);
  const c = commit ? commitBeta(root, `beta: off (by ${who})`, doc.why) : { committed: false, note: ' Not committed (--no-commit).' };
  emitEvent({ type: 'beta.off', agent: who.slice(0, 60), msg: `beta mode off by ${who}${old.on ? ` (it was on since ${short(old.at)})` : ''}`, meta: { by: who } });
  logBeta({ action: 'beta-off', by: who, why: doc.why, evidence: 'off', root });
  return { ok: true, doc, committed: c.committed, message: `Beta mode is off${c.committed ? ` (committed ${BETA_REL})` : ''}.${c.note || ''} The owner gates are back: protected files, gates and approvals need the owner key (or the owner proxy with the owner's yes).`.replace(/\s+/g, ' ').trim() };
}
function commitBeta(root, msg, why) {
  if (git(root, 'rev-parse', '--verify', 'HEAD').status !== 0) return { committed: false, note: ' Not a git checkout: nothing committed.' };
  git(root, 'add', '--', BETA_REL);
  const r = git(root, 'commit', '--only', '-m', msg, '-m', `Why: ${why}`, '--', BETA_REL);
  return r.status === 0 ? { committed: true, note: '' } : { committed: false, note: ` Committing it failed (${String(r.stderr || r.stdout).trim().split('\n').pop() || `exit ${r.status}`}): commit ${BETA_REL} yourself.` };
}
function logBeta({ action, by, why, evidence, root }) {
  import('./decisions-log.mjs').then((dm) => dm.logDecision({ action, subject: BETA_REL, by: String(by).slice(0, 60), as: 'person', why: String(why).slice(0, 300), evidence: String(evidence).slice(0, 300), undo: action === 'beta-on' ? { kind: 'text', text: 'npm run beta -- off --by <name>' } : null, root })).catch(() => {});
}

/** One beta-mode use, for the digest and the War Room (a delegation.used event with meta.beta). */
export function recordBetaUse(actor, { action, subject = '', why = '' } = {}) {
  try { emitEvent({ type: 'delegation.used', agent: String(actor.who || 'beta').slice(0, 60), msg: `${actor.who} ${action}${subject ? ` ${subject}` : ''} in beta mode${why ? `: ${String(why).slice(0, 160)}` : ''}`.slice(0, 400), meta: { beta: true, action, via: actor.via, subject: String(subject || '').slice(0, 120), why: String(why || '').slice(0, 160) } }); } catch {}
}

export const BETA_DIGEST_LINES = 30;
const DAYMS = 86400000;
/**
 * 2.77.0 (f, P1.1): the daily digest's "Beta mode" section, as an array of lines for the digest's period (24 h):
 * whether beta was on, who turned it on or off and when (the beta.on / beta.off events and the decisions log), and each
 * use (who, action, subject, why; the delegation.used events with meta.beta), at most `max` lines with a count of the
 * rest. [] when there were no uses, no switch and beta is off. Never throws.
 */
export async function betaDigestLines({ events = null, now = Date.now(), root = mainCheckout(), max = BETA_DIGEST_LINES, since = now - DAYMS } = {}) {
  try {
    let ev = events;
    if (!ev) { try { ev = readRecentEvents(20000); } catch { ev = []; } }
    const inP = (t) => { const ms = Date.parse(t); return Number.isFinite(ms) && ms >= since && ms <= now + 60000; };
    const uses = (ev || []).filter((e) => e?.type === 'delegation.used' && e.meta?.beta && inP(e.ts));
    const sw = (ev || []).filter((e) => (e?.type === 'beta.on' || e?.type === 'beta.off') && inP(e.ts))
      .map((e) => ({ on: e.type === 'beta.on', at: e.ts, by: e.meta?.by || e.agent, rec: e.meta?.recordedBy || '', why: '' }));
    try {
      const { decisions } = (await import('./decisions-log.mjs')).readLog(root);
      for (const d of decisions) {
        if ((d.action !== 'beta-on' && d.action !== 'beta-off') || !inP(d.at)) continue;
        const on = d.action === 'beta-on';
        const hit = sw.find((x) => x.on === on && Math.abs(Date.parse(x.at) - Date.parse(d.at)) < 120000);
        if (hit) hit.why = d.why || ''; else sw.push({ on, at: d.at, by: d.by, rec: '', why: d.why || '' });
      }
    } catch {}
    sw.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const cur = readBeta({ root });
    if (!uses.length && !sw.length && !cur.on) return [];
    const L = [];
    L.push(cur.on ? `Beta mode: ON now (set by ${cur.doc.by} at ${short(cur.doc.at)}${cur.doc.why ? `: ${String(cur.doc.why).slice(0, 100)}` : ''}).` : `Beta mode: off now${sw.length ? '' : ' (it was on while these uses ran)'}.`);
    for (const x of sw) L.push(`  ${short(x.at)} turned ${x.on ? 'ON' : 'OFF'} by ${x.by}${x.rec ? ` (recorded by ${x.rec})` : ''}${x.why ? `: ${String(x.why).slice(0, 100)}` : ''}`);
    L.push(`${uses.length} beta use${uses.length === 1 ? '' : 's'} in 24 h${uses.length ? ' (who, action, subject, why)' : ''}:`);
    const room = Math.max(0, max - L.length);
    const shown = uses.length > room ? Math.max(0, room - 1) : uses.length;
    for (const e of uses.slice(0, shown)) {
      const m = e.meta || {};
      const subject = m.subject || '';
      const why = m.why || (String(e.msg || '').match(/in beta mode: (.*)$/) || [])[1] || '';
      L.push(`  ${short(e.ts)} ${e.agent}: ${m.action || 'action'}${subject ? ` ${subject}` : ''}${why ? ` (${String(why).slice(0, 100)})` : ' (no reason given)'}`);
    }
    if (uses.length > shown) L.push(`  ... and ${uses.length - shown} more (npm run events -- --type delegation.used)`);
    return L.slice(0, Math.max(max, 1));
  } catch { return []; }
}


if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--') ? argv[i + 1] : null; };
  const cmd = argv[0] || 'status';
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: npm run beta -- on --by <owner> [--agents a,b] [--why "…"] [--permission "<the owner\'s yes>"] [--no-commit]\n       npm run beta -- off --by <name> [--why "…"] [--no-commit]\n       npm run beta -- status [--json]');
    process.exit(0);
  }
  if (cmd === 'on' || cmd === 'off') {
    const r = setBeta({ on: cmd === 'on', by: opt('--by'), agents: opt('--agents') || '', why: opt('--why') || '', permission: opt('--permission') || '', commit: !argv.includes('--no-commit') });
    (r.ok ? console.log : console.error)(r.message);
    process.exit(r.ok ? 0 : 1);
  }
  const b = readBeta();
  if (argv.includes('--json')) { console.log(JSON.stringify(b, null, 2)); process.exit(0); }
  console.log(b.on ? `Beta mode is ON: ${betaWords(b.doc)}; acting as the owner: ${[...(b.doc.agents || []), 'Producer/Director sessions'].join(', ')}${b.signed ? ' (signed)' : b.doc.recordedBy ? ` (recorded by ${b.doc.recordedBy} on the owner's yes)` : ''}.` : `Beta mode is off. ${b.why}`);
  process.exit(0);
}
