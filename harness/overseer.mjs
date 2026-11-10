#!/usr/bin/env node
/**
 * harness/overseer.mjs — 2.73.0 (f): the outside overseer's stage, and whether the next one's entry criteria hold.
 *
 *   npm run overseer [-- --json]          the stage the owner set, what it allows, and the next stage's criteria (each
 *                                         with its evidence): a suggestion only. The owner changes the stage.
 *   npm run overseer -- record <kind> <subject> --by <person> [--note "…"] [--permission "…"]
 *       an outcome the harness can't see for itself, into the decision log (action overseer-<kind>): repro-accepted,
 *       repro-rejected, pr-merged, pr-reverted, protected-attempt. A person's (or an agent's on a person's direct
 *       permission, as `upgrade --merge` takes it); never the overseer itself.
 *
 *   npm run overseer -- role [--by <agent>]            2.81: the overseer's official role as this studio stands: what it
 *       does, what it signs as the owner (and under which grant), what stays human-only. docs/OVERSEER.md.
 *   npm run overseer -- can <action> [--by <agent>]    one verdict, by script: yes / ask / human-only, with the rule.
 *       The model proposes an action; this (and the command's own check, which uses the same rules) decides.
 *   npm run overseer -- pass [--hours 24] [--json]     the facts for one pass of the overseer's loop: blockers, tasks
 *       claimed again and again, repeated workarounds, stalls and reds, each with the kind of attention it needs.
 *
 * Stages (studio/overseer.json, PROTECTED: the owner changes it, with a signed approval like any protected file):
 *   0 reporter     logs workarounds (npm run workaround -- log)
 *   1 repro tests  also writes failing reproduction tests as harness PRs (npm run workaround -- repro <H-id>)
 *   2 small fixes  also small non-gate harness fixes, reviewed and merged by someone else
 *   3 own releases also merges its own non-gate releases
 * At every stage gates, protected files and money stay the owner's.
 * The file counts as committed (git's HEAD copy): an uncommitted edit is shown and ignored, so a working-copy edit can't
 * raise a stage. No file, or one that doesn't parse: stage 0 with the default criteria.
 *
 * Evidence, counted since the stage was set (setAt; all history without one), for the overseer named in the file:
 *   workarounds logged   its own `workaround -- log` records (.studio/workarounds.jsonl, not detected ones)
 *   accepted repros      distinct Repro-Of: <H-id> trailers on commits in the studio's history with Overseer-By: <agent>
 *                        (its repro PRs that reached the harness and came in with an update), plus repro-accepted records
 *   merged PRs           commits with Overseer-By: <agent> in the studio's history, plus pr-merged records
 *   revert rate          those commits reverted ("This reverts commit <sha>") plus pr-reverted records, over merged
 *   protected attempts   events by the agent about protected files (type or message), its workaround records naming a
 *                        protected file, and protected-attempt records
 * Code over the logs and git: no model, no network.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, readRecentEvents } from './event.mjs';

export const OVERSEER_REL = 'studio/overseer.json';
const DAY = 86400000;
export const STAGES = [
  { stage: 0, name: 'reporter', allows: 'logs workarounds (npm run workaround -- log)' },
  { stage: 1, name: 'repro tests', allows: 'writes failing reproduction tests as harness PRs (npm run workaround -- repro <H-id> --by <agent> --harness-repo <clone>)' },
  { stage: 2, name: 'small fixes', allows: 'small non-gate harness fixes, reviewed and merged by someone else' },
  { stage: 3, name: 'own releases', allows: 'merges its own non-gate harness releases' },
];
export const ALWAYS_OWNER = 'gates, protected files and money';
const DEFAULT_CRITERIA = Object.freeze({
  1: { minDaysAtStage: 7, minWorkaroundsLogged: 10, maxProtectedAttempts: 0 },
  2: { minDaysAtStage: 7, minAcceptedRepros: 5, maxProtectedAttempts: 0 },
  3: { minDaysAtStage: 14, minMergedPrs: 10, maxRevertRate: 0.1, maxProtectedAttempts: 0 },
});
export const RECORD_KINDS = ['repro-accepted', 'repro-rejected', 'pr-merged', 'pr-reverted', 'protected-attempt'];
const git = (root, args) => spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });

/** The owner's file as committed: { stage, agent, setBy, setAt, criteria, source, note }. */
export function readOverseer(root = REPO_ROOT) {
  const parse = (t) => { try { const j = JSON.parse(t); return j && typeof j === 'object' ? j : null; } catch { return null; } };
  const head = git(root, ['show', `HEAD:${OVERSEER_REL}`]);
  const committed = head.status === 0 ? parse(head.stdout) : null;
  let disk = null; let diskText = null;
  try { diskText = fs.readFileSync(path.join(root, OVERSEER_REL), 'utf8'); disk = parse(diskText); } catch { /* none */ }
  const doc = committed || null;
  const notes = [];
  if (head.status === 0 && !committed) notes.push(`${OVERSEER_REL} as committed doesn't parse: stage 0`);
  if (diskText !== null && (head.status !== 0 || diskText.replace(/\r/g, '') !== String(head.stdout).replace(/\r/g, ''))) notes.push(`${OVERSEER_REL} has an uncommitted edit${disk && Number(disk.stage) !== Number(doc?.stage ?? 0) ? ` (stage ${disk.stage})` : ''}: ignored until the owner commits it with a signed approval`);
  const stage = Number.isInteger(Number(doc?.stage)) && Number(doc.stage) >= 0 && Number(doc.stage) <= 3 ? Number(doc.stage) : 0;
  const criteria = {};
  for (const k of [1, 2, 3]) criteria[k] = { ...DEFAULT_CRITERIA[k], ...(doc?.criteria && typeof doc.criteria[k] === 'object' ? doc.criteria[k] : {}) };
  return { stage, agent: doc?.agent ? String(doc.agent).trim() : null, setBy: doc?.setBy || null, setAt: doc?.setAt || null, criteria, source: committed ? 'committed' : 'default', notes };
}

const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Commits in history with Overseer-By: <agent>: [{ sha, at, reproOf }] and the shas reverted by later commits. */
export function overseerCommits(root, agent, { since = 0 } = {}) {
  if (!agent) return { commits: [], reverted: new Set() };
  const r = git(root, ['log', '--format=%H%x1f%ct%x1f%B%x1e', 'HEAD']);
  if (r.status !== 0) return { commits: [], reverted: new Set() };
  const commits = []; const reverts = [];
  for (const rec of String(r.stdout).split('\x1e')) {
    const [sha, ct, body] = rec.replace(/^\s+/, '').split('\x1f');
    if (!sha || body === undefined) continue;
    const at = Number(ct) * 1000;
    for (const m of body.matchAll(/This reverts commit ([0-9a-f]{7,40})/g)) reverts.push(m[1]);
    if (!new RegExp(`^Overseer-By:\\s*${reEsc(agent)}\\s*$`, 'mi').test(body) || at < since) continue;
    commits.push({ sha, at, reproOf: (body.match(/^Repro-Of:\s*(H-\d+)\s*$/mi) || [])[1] || null });
  }
  const reverted = new Set(commits.filter((c) => reverts.some((x) => c.sha.startsWith(x))).map((c) => c.sha));
  return { commits, reverted };
}

/** The evidence for one agent since `since`: counts and where each came from. */
export async function overseerEvidence({ root = REPO_ROOT, agent, since = 0, events = null } = {}) {
  const ev = (events || readRecentEvents(200000)).filter((e) => (Date.parse(e.ts) || 0) >= since);
  let records = [];
  try { records = (await import('./workaround.mjs')).readRecords({ since }); } catch { records = []; }
  let decisions = [];
  try { decisions = (await import('./decisions-log.mjs')).readLog(root).decisions.filter((d) => (Date.parse(d.at) || 0) >= since); } catch { decisions = []; }
  const rec = (kind) => decisions.filter((d) => d.action === `overseer-${kind}`);
  const mine = (x) => agent && (x.by === agent || x.agent === agent || x.meta?.by === agent);
  const { commits, reverted } = overseerCommits(root, agent, { since });
  const reproIds = new Set([...commits.map((c) => c.reproOf).filter(Boolean), ...rec('repro-accepted').map((d) => d.subject).filter(Boolean)]);
  const merged = commits.length + rec('pr-merged').length;
  const revertedN = reverted.size + rec('pr-reverted').length;
  const protectedEv = ev.filter((e) => mine(e) && (/protect/i.test(e.type || '') || /protected file/i.test(String(e.msg || ''))));
  const protectedWk = records.filter((r) => mine(r) && /protected/i.test(`${r.what} ${r.why}`));
  return {
    agent, since: since ? new Date(since).toISOString() : null,
    workaroundsLogged: records.filter((r) => mine(r) && !r.detected).length,
    reproScaffolds: ev.filter((e) => e.type === 'harness.repro_scaffolded' && mine(e)).length,
    acceptedRepros: reproIds.size,
    rejectedRepros: rec('repro-rejected').length,
    mergedPrs: merged,
    reverted: revertedN,
    revertRate: merged ? Math.round((revertedN / merged) * 1000) / 1000 : null,
    protectedAttempts: protectedEv.length + protectedWk.length + rec('protected-attempt').length,
    sources: { commits: commits.length, records: decisions.filter((d) => /^overseer-/.test(d.action)).length, protectedEvents: protectedEv.length, protectedWorkarounds: protectedWk.length },
  };
}

/** Each criterion of a stage against the evidence: [{ key, want, have, ok }]. */
export function judgeCriteria(c, e, { daysAtStage = null } = {}) {
  const rows = [];
  const add = (key, want, have, ok, words) => rows.push({ key, want, have, ok, words });
  if (c.minDaysAtStage !== undefined) add('minDaysAtStage', c.minDaysAtStage, daysAtStage, daysAtStage !== null && daysAtStage >= c.minDaysAtStage, `days at this stage >= ${c.minDaysAtStage}`);
  if (c.minWorkaroundsLogged !== undefined) add('minWorkaroundsLogged', c.minWorkaroundsLogged, e.workaroundsLogged, e.workaroundsLogged >= c.minWorkaroundsLogged, `workarounds it logged >= ${c.minWorkaroundsLogged}`);
  if (c.minAcceptedRepros !== undefined) add('minAcceptedRepros', c.minAcceptedRepros, e.acceptedRepros, e.acceptedRepros >= c.minAcceptedRepros, `accepted repro PRs >= ${c.minAcceptedRepros}`);
  if (c.minMergedPrs !== undefined) add('minMergedPrs', c.minMergedPrs, e.mergedPrs, e.mergedPrs >= c.minMergedPrs, `merged PRs >= ${c.minMergedPrs}`);
  if (c.maxRevertRate !== undefined) add('maxRevertRate', c.maxRevertRate, e.revertRate, e.revertRate !== null && e.revertRate <= c.maxRevertRate, `revert rate <= ${c.maxRevertRate} (needs merged PRs)`);
  if (c.maxProtectedAttempts !== undefined) add('maxProtectedAttempts', c.maxProtectedAttempts, e.protectedAttempts, e.protectedAttempts <= c.maxProtectedAttempts, `protected-file attempts <= ${c.maxProtectedAttempts}`);
  return rows;
}

export async function overseerStatus({ root = REPO_ROOT, now = Date.now(), events = null } = {}) {
  const o = readOverseer(root);
  const since = Date.parse(o.setAt || '') || 0;
  const evidence = await overseerEvidence({ root, agent: o.agent, since, events });
  const next = o.stage < 3 ? o.stage + 1 : null;
  const daysAtStage = since ? Math.floor(((now - since) / DAY) * 10) / 10 : null;
  const rows = next === null ? [] : judgeCriteria(o.criteria[next], evidence, { daysAtStage });
  const holds = next !== null && Boolean(o.agent) && rows.length > 0 && rows.every((r) => r.ok);
  return { ...o, stageName: STAGES[o.stage].name, allows: STAGES.slice(0, o.stage + 1).map((s) => s.allows), next, nextName: next === null ? null : STAGES[next].name, daysAtStage, evidence, criteria: rows, holds, suggestion: next === null ? 'stage 3 is the last' : !o.agent ? `no overseer is named in ${OVERSEER_REL} ("agent"): the owner names it` : holds ? `the criteria for stage ${next} hold: the owner may set "stage": ${next} in ${OVERSEER_REL} (a protected file: commit it with npm run approve -- protected)` : `stage ${next} not yet: ${rows.filter((r) => !r.ok).map((r) => `${r.words} (has ${r.have ?? 'none'})`).join('; ')}` };
}

export function overseerText(s) {
  const L = [`Overseer: ${s.agent || '(none named)'} at stage ${s.stage} (${s.stageName})${s.setBy ? `, set by ${s.setBy}${s.setAt ? ` ${String(s.setAt).slice(0, 10)}` : ''}` : ''}${s.source === 'default' ? ` (no committed ${OVERSEER_REL}: the default)` : ''}.`];
  L.push(`  It may: ${s.allows.join('; ')}.`);
  L.push(`  Always the owner's: ${ALWAYS_OWNER}.`);
  for (const n of s.notes) L.push(`  Note: ${n}.`);
  const e = s.evidence;
  L.push(`  Evidence${e.since ? ` since ${e.since.slice(0, 10)}` : ''}: ${e.workaroundsLogged} workaround(s) logged, ${e.reproScaffolds} repro scaffold(s), ${e.acceptedRepros} accepted repro(s), ${e.rejectedRepros} rejected, ${e.mergedPrs} merged PR(s), ${e.reverted} reverted${e.revertRate !== null ? ` (rate ${e.revertRate})` : ''}, ${e.protectedAttempts} protected-file attempt(s).`);
  if (s.next !== null) {
    L.push(`  Stage ${s.next} (${s.nextName}) criteria:`);
    for (const r of s.criteria) L.push(`    ${r.ok ? 'met' : 'not met'}: ${r.words} (has ${r.have ?? 'none'})`);
  }
  L.push(`  Suggestion only: ${s.suggestion}.`);
  return L.join('\n');
}

/** `npm run overseer -- record <kind> <subject> --by <person>`: one decision-log record. */
export async function recordOutcome({ kind, subject, by, note = '', permission = '', env = process.env, root = REPO_ROOT } = {}) {
  if (!RECORD_KINDS.includes(kind)) return { ok: false, code: 2, text: `Usage: npm run overseer -- record ${RECORD_KINDS.join('|')} <H-id, PR or commit> --by <person> [--note "…"]` };
  if (!String(subject || '').trim()) return { ok: false, code: 2, text: 'Say what it is about: the harness task (H-…), the PR or the commit.' };
  const o = readOverseer(root);
  const shell = String(env.STUDIO_LOCK_OWNER || env.STUDIO_AGENT || '').trim();
  if (o.agent && [String(by || '').trim(), shell].some((x) => x && x.toLowerCase() === o.agent.toLowerCase())) return { ok: false, code: 1, text: `Not recorded: ${o.agent} is the overseer; its outcomes are recorded by a person.` };
  const guard = await import('./upgrade-guard.mjs');
  const who = await guard.whoActs({ by, permission, env, root });
  if (!who.ok) return { ok: false, code: 1, text: `Not recorded: ${who.why}` };
  const dm = await import('./decisions-log.mjs');
  const r = dm.logDecision({ action: `overseer-${kind}`, subject: String(subject).trim().slice(0, 120), by: String(by).trim(), as: who.permission ? `permission "${who.permission.slice(0, 200)}"` : who.via === 'person' ? 'person' : 'agent', why: String(note || '').slice(0, 300) || `${kind} for ${o.agent || 'the overseer'}`, evidence: o.agent ? `overseer ${o.agent}, stage ${o.stage}` : '', undo: null, root });
  return r ? { ok: true, code: 0, text: `Recorded ${r.id}: overseer-${kind} ${r.subject} by ${r.by}.` } : { ok: false, code: 1, text: 'Not recorded: the decision log could not be written.' };
}

// ---- 2.81: the outside overseer's official role (docs/OVERSEER.md). One table; the verdicts come from the rules the
// commands themselves use (owner-acts.mjs, delegation.mjs delegationFor: delegation, owner proxy, beta mode, policy). ----

/** What only a person does, beyond the owner's own list (harness/owner-acts.mjs): { act, what, where }. */
export const HUMAN_ONLY = Object.freeze([
  { act: 'merge-main', names: ['merge-main', 'harness-merge'], what: 'merging a harness release into its main branch', where: "the owner's rule: nothing merges to main without the owner's OK" },
  { act: 'grant', names: ['grant', 'delegate', 'proxy', 'beta-on', 'outside-signer'], what: 'granting, widening or extending a delegation, the owner proxy, beta mode or an outside signer', where: 'harness/delegation.mjs ownerShellRefusal; STUDIO_OUTSIDE_SIGNERS is read from the owner\'s .env only' },
  { act: 'stage', names: ['stage', 'overseer-stage', 'self-record'], what: 'raising the overseer\'s own stage, or recording an outcome about its own work', where: 'studio/overseer.json is protected and read as committed; recordOutcome refuses the overseer' },
  { act: 'tier-c', names: ['tier-c', 'tier-c-release'], what: 'releasing a tier-C lane in a studio with an owner key', where: 'harness/train.mjs releaseRefusal: a permission line is not a signature' },
  { act: 'main-commit', names: ['main-commit', 'main-commit-override'], what: 'committing in the main checkout past the pre-commit guard (STUDIO_MAIN_COMMIT=allow)', where: 'scripts/hooks/pre-commit' },
  { act: 'no-verify', names: ['no-verify', 'skip-hooks'], what: 'committing with --no-verify, or weakening a test to pass', where: 'the hooks and weakened-tests gates; only an approval of the intended change passes them' },
  { act: 'winddown-off', names: ['winddown-off'], what: 'ending a wind-down early (an agent\'s own wind-down ends at the time it named)', where: 'harness/winddown.mjs' },
  { act: 'policy', names: ['policy', 'autonomous-mode'], what: 'confirming autonomous mode or changing the studio policy and its Never list', where: 'harness/policy.mjs: the owner confirms (npm run policy -- confirm)' },
]);

/** What the overseer does without signing anything, and what it signs as the owner (each by the command's own check). */
export const OVERSEER_DOES = Object.freeze(['queue order and priority', 'adding, splitting, parking and unparking tasks', 'briefs, pitfalls and notes', 'a task\'s lane, type and visual check', 'starting and stopping agents', 'a wind-down with an end time', 'spend budgets on the owner\'s order', 'engine push mode and boost', 'releasing a held lane (tier A or B)', 'answering an ask that is not about money, deletes, keys, publishing or tools', 'logging workarounds']);
export const OVERSEER_SIGNS = Object.freeze(['protected', 'tests', 'hooks', 'force', 'proposal', 'train-config']);
const HARNESS_STAGE = Object.freeze({ 'workaround-log': 0, 'repro-test': 1, 'harness-fix': 2, 'harness-release': 3 });

/**
 * May `by` do `action` now? { verdict: 'yes' | 'ask' | 'human-only', why, via }. A script's answer from the studio's
 * files: the owner's own list, the human-only list above, the overseer's stage for harness work, else whatever grant
 * covers the action today (a delegation, the owner proxy, beta mode, autonomous mode; the studio policy's Never).
 */
export async function overseerCan(action, { by = null, root = REPO_ROOT, env = process.env } = {}) {
  const a = String(action || '').trim().toLowerCase();
  const o = readOverseer(root);
  const who = String(by || o.agent || env.STUDIO_LOCK_OWNER || '').trim();
  if (!a) return { verdict: 'ask', why: 'say which action', via: null };
  const { ownerOnlyAction, ownerOnlyWhy } = await import('./owner-acts.mjs');
  const own = ownerOnlyAction(a);
  if (own) return { verdict: 'human-only', why: ownerOnlyWhy(own, who), via: 'harness/owner-acts.mjs' };
  const h = HUMAN_ONLY.find((x) => x.names.includes(a));
  if (h) return { verdict: 'human-only', why: `${h.what} stays with a person (${h.where})`, via: h.act };
  if (a in HARNESS_STAGE) {
    const need = HARNESS_STAGE[a];
    return o.stage >= need ? { verdict: 'yes', why: `stage ${o.stage} (${STAGES[o.stage].name}) allows it; gates, protected files and money stay the owner's`, via: `stage ${o.stage}` }
      : { verdict: 'ask', why: `it needs stage ${need} (${STAGES[need].name}); the studio's overseer is at stage ${o.stage}. The owner sets the stage (${OVERSEER_REL})`, via: `stage ${o.stage}` };
  }
  if (!who) return { verdict: 'ask', why: 'say who acts: --by <agent>', via: null };
  const { delegationFor } = await import('./delegation.mjs');
  const d = delegationFor({ action: a, by: who, env: { ...env, STUDIO_LOCK_OWNER: who, STUDIO_ROLE: '' }, root, lane: false });
  if (d.ok) return { verdict: 'yes', why: `${who} acts as the owner here: ${d.words || d.via || 'a standing grant'}; it is recorded for the owner's review`, via: d.autonomous ? 'autonomous mode' : d.via || 'grant' };
  return { verdict: 'ask', why: `no standing grant lets ${who} do "${a}"${d.why ? ` (${d.why})` : ''}: the owner's direct permission (--permission "<their words>") or a grant covers it`, via: null };
}

/** The role card: stage, grants in force, what it does, signs and never does. */
export async function overseerRole({ by = null, root = REPO_ROOT, env = process.env } = {}) {
  const o = readOverseer(root);
  const who = String(by || o.agent || '').trim() || null;
  const signs = [];
  for (const k of OVERSEER_SIGNS) signs.push({ action: k, ...(await overseerCan(k, { by: who, root, env })) });
  const { OWNER_ONLY } = await import('./owner-acts.mjs');
  return { agent: who, stage: o.stage, stageName: STAGES[o.stage].name, harness: STAGES.slice(0, o.stage + 1).map((s) => s.allows), does: [...OVERSEER_DOES], signs, humanOnly: [...OWNER_ONLY.map((x) => x.what), ...HUMAN_ONLY.map((x) => x.what)] };
}
export function roleText(r) {
  const L = [`Overseer role: ${r.agent || '(no overseer named in studio/overseer.json; pass --by <agent>)'}, stage ${r.stage} (${r.stageName}).`];
  L.push(`  Does, as itself: ${r.does.join('; ')}.`);
  L.push(`  On the harness: ${r.harness.join('; ')}.`);
  L.push('  Signs as the owner (recorded, reviewed by the owner afterwards):');
  for (const s of r.signs) L.push(`    ${s.verdict === 'yes' ? 'yes' : 'ask'}  ${s.action}: ${s.why}`);
  L.push(`  Human-only, whatever the grant: ${r.humanOnly.join('; ')}.`);
  return L.join('\n');
}

/**
 * The facts for one pass of the overseer's loop, over the last `hours`: what needs it, each with the kind of attention
 * (routine: a board step; planning: rewrite or split the work; review: read evidence before deciding). No model.
 */
export async function overseerPass({ root = REPO_ROOT, now = Date.now(), hours = 24, events = null, records = null } = {}) {
  const from = now - hours * 3600000;
  const ev = (events || readRecentEvents(200000)).filter((e) => { const t = Date.parse(e.ts) || 0; return t >= from && t <= now; });
  const T = (type) => ev.filter((e) => e.type === type);
  const items = [];
  const claims = {};
  for (const e of T('task.start')) claims[e.task] = (claims[e.task] || 0) + 1;
  const done = new Set(T('task.done').map((e) => e.task));
  const again = Object.entries(claims).filter(([id, n]) => n >= 3 && !done.has(id)).sort((x, y) => y[1] - x[1]);
  if (again.length) items.push({ kind: 'planning', what: `${again.length} task(s) claimed 3 or more times and not done`, detail: again.slice(0, 8).map(([id, n]) => `${id} (${n})`).join(', '), next: 'read each task\'s last hand-back note; split it, rewrite its brief or park it with the blocker named' });
  let recs = records;
  if (!recs) { try { recs = (await import('./workaround.mjs')).readRecords({ since: now - 7 * DAY }); } catch { recs = []; } }
  const bySig = {};
  for (const r of recs) { const k = r.sig || r.signature || r.what; (bySig[k] ||= { n: 0, what: r.signature || r.what }).n += 1; }
  const repeated = Object.values(bySig).filter((x) => x.n >= 3).sort((x, y) => y.n - x.n);
  if (repeated.length) items.push({ kind: 'review', what: `${repeated.length} workaround(s) repeated 3 or more times in 7 days`, detail: repeated.slice(0, 6).map((x) => `${x.n}x ${String(x.what).slice(0, 80)}`).join(' | '), next: 'each is a harness gap: npm run workaround -- tasks lists them; write the failing repro (stage 1) instead of working around it again' });
  const stalls = T('session.stall').length + T('task.train.died').length;
  if (stalls) items.push({ kind: 'routine', what: `${stalls} stall(s) or dead train(s)`, detail: `${T('session.stall').length} session(s) ended for a stall, ${T('task.train.died').length} train(s) died`, next: 'npm run studio:status; a task that stalls twice goes to planning' });
  const reds = T('task.train.red').length + T('task.train.red_main').length;
  if (reds) items.push({ kind: T('task.train.red_main').length ? 'review' : 'routine', what: `${reds} red train verify(s)${T('task.train.red_main').length ? `, ${T('task.train.red_main').length} with main itself red` : ''}`, detail: '', next: 'a red main is fixed before anything else lands: a fix task with its lane, queued alone' });
  const halts = T('supervisor.halted').length;
  if (halts) items.push({ kind: 'review', what: `${halts} supervisor halt(s)`, detail: T('supervisor.halted').map((e) => String(e.msg || '').slice(0, 120)).slice(-2).join(' | '), next: 'npm run studio:resume once the cause in the halt message is dealt with' });
  const asks = T('ask.open').length - T('ask.answered').length - T('ask.closed').length;
  if (asks > 0) items.push({ kind: 'routine', what: `${asks} ask(s) opened and not answered in the window`, detail: '', next: 'npm run ask -- list --open; answer what the role allows, leave the owner-only ones to the owner' });
  return { window: { from: new Date(from).toISOString(), to: new Date(now).toISOString(), hours }, landed: done.size, items };
}
export const passText = (p) => [`Overseer pass, last ${p.window.hours} h: ${p.landed} task(s) done; ${p.items.length ? `${p.items.length} thing(s) need the overseer` : 'nothing needs the overseer'}.`, ...p.items.map((i) => `  [${i.kind}] ${i.what}${i.detail ? `: ${i.detail}` : ''}. Next: ${i.next}.`)].join('\n');

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--') ? argv[i + 1] : null; };
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(['Usage: npm run overseer [-- --json]   the stage the owner set and whether the next stage\'s criteria hold (a suggestion)',
      '       npm run overseer -- role [--by <agent>] | can <action> [--by <agent>] | pass [--hours 24]   (docs/OVERSEER.md)',
      `       npm run overseer -- record ${RECORD_KINDS.join('|')} <subject> --by <person> [--note "…"] [--permission "…"]`].join('\n'));
    process.exit(0);
  }
  if (argv[0] === 'role') { const r = await overseerRole({ by: flag('by') }); console.log(argv.includes('--json') ? JSON.stringify(r, null, 2) : roleText(r)); process.exit(0); }
  if (argv[0] === 'can') {
    const r = await overseerCan(argv[1] && !argv[1].startsWith('--') ? argv[1] : '', { by: flag('by') });
    console.log(argv.includes('--json') ? JSON.stringify(r) : `${r.verdict}: ${r.why}`);
    process.exit(r.verdict === 'yes' ? 0 : r.verdict === 'human-only' ? 3 : 1);
  }
  if (argv[0] === 'pass') { const p = await overseerPass({ hours: Number(flag('hours')) > 0 ? Number(flag('hours')) : 24 }); console.log(argv.includes('--json') ? JSON.stringify(p, null, 2) : passText(p)); process.exit(0); }
  if (argv[0] === 'record') {
    const r = await recordOutcome({ kind: argv[1], subject: argv[2] && !argv[2].startsWith('--') ? argv[2] : '', by: flag('by'), note: flag('note') || '', permission: flag('permission') || '' });
    (r.ok ? console.log : console.error)(r.text);
    process.exit(r.code);
  }
  const s = await overseerStatus({});
  console.log(argv.includes('--json') ? JSON.stringify(s, null, 2) : overseerText(s));
  process.exit(0);
}
