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

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--') ? argv[i + 1] : null; };
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(['Usage: npm run overseer [-- --json]   the stage the owner set and whether the next stage\'s criteria hold (a suggestion)',
      `       npm run overseer -- record ${RECORD_KINDS.join('|')} <subject> --by <person> [--note "…"] [--permission "…"]`].join('\n'));
    process.exit(0);
  }
  if (argv[0] === 'record') {
    const r = await recordOutcome({ kind: argv[1], subject: argv[2] && !argv[2].startsWith('--') ? argv[2] : '', by: flag('by'), note: flag('note') || '', permission: flag('permission') || '' });
    (r.ok ? console.log : console.error)(r.text);
    process.exit(r.code);
  }
  const s = await overseerStatus({});
  console.log(argv.includes('--json') ? JSON.stringify(s, null, 2) : overseerText(s));
  process.exit(0);
}
