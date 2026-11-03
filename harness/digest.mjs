#!/usr/bin/env node
/**
 * harness/digest.mjs — 2.65.0 (hands-off by default): one daily digest instead of approval pings.
 *
 *   npm run digest [-- --print] [--date YYYY-MM-DD]   write studio/digest/<date>.md now (--print: also show it)
 *
 * The watchdog writes it once a day by itself, on its first pass at or after STUDIO_DIGEST_HOUR (9) local time
 * (STUDIO_DIGEST=off: never automatically). It lists only what still needs a person, in under 200 words:
 *   - safety-gate and protected-file changes waiting: lanes the merge train holds for a person's release (tier C:
 *     protected files, harness code, deleted tests ...), and protected files changed on main without the owner's
 *     approval;
 *   - Bible and phase decisions: an unsigned Bible, open questions for the game dev (npm run ask);
 *   - spend: a tool over its weekly target (npm run budget);
 *   - stops: a halted supervisor whose cause isn't on the self-triage list, and causes self-triage left for a person;
 *   - 2.66.0: fuzz findings suggested in the last 24 h (npm run fuzz's shadow week); filed ones get a count line;
 *   - 2.67.1: Unity Play Mode flakes (a test that failed, then passed on its one retry) in the last 24 h, as a line;
 *   - 2.70.0: the latest playable build and clip made after a landing in the last 24 h, as a line;
 *   - 2.68.0: roles the crew watchdog paused (harness/crew-watch.mjs), and the latest harness upgrade's verdict once
 *     both sides have enough data (npm run autonomy -- impact), as a line;
 *   - 2.70.0 (v): assets waiting for a review of their previews, oldest first (harness/asset-review.mjs);
 *   - 2.71.0 (y): research tasks finished in the last 24 h, each with its write-up and recommendation, as a line;
 * then (2.66.0) the top 5 blocked commands as allowlist candidates (harness/denials.mjs; never added to any settings or
 * permission file: a person decides), the autonomy scorecard's line and what self-triage fixed in the last 24 h. Nothing needing a person: one line
 * says so. One digest.written event. A script: no model, no tokens. Every source is read-only and optional (a source
 * that fails to read is skipped, never a crash).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, emitEvent, readRecentEvents } from './event.mjs';

export const DIGEST_DIR_REL = 'studio/digest';
export const MAX_WORDS = 200;
const DAY = 86400000;
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const words = (s) => (String(s).match(/\S+/g) || []).length;
/** The local date, YYYY-MM-DD. */
export const localDate = (now = Date.now()) => { const d = new Date(now); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const digestFile = (date, root = REPO_ROOT) => path.join(root, DIGEST_DIR_REL, `${date}.md`);

/** What needs a person now: [{ kind, line }]. Each source is optional. */
export async function needsPerson({ now = Date.now(), root = REPO_ROOT, events = null } = {}) {
  const out = [];
  const ev = events || readRecentEvents(20000);
  const tryAdd = async (fn) => { try { await fn(); } catch { /* a source that can't be read is skipped */ } };
  // Safety gates: lanes held for a person's release (the train queue, in the main checkout).
  await tryAdd(async () => {
    let qroot = root;
    try { qroot = (await import('./worktree.mjs')).mainRoot(); } catch {}
    const q = readJson(path.join(qroot, '.studio', 'train', 'queue.json'));
    for (const e of Array.isArray(q) ? q : []) {
      if (!e?.held || (e.released && e.released.head === e.head)) continue;
      out.push({ kind: 'gate', line: `${e.task} waits for your release (tier ${e.held.tier || 'C'}: ${String(e.held.why || '').slice(0, 80)}): npm run task -- train release ${e.task} --by <you>` });
    }
  });
  await tryAdd(async () => {
    const { checkProtected } = await import('./approve.mjs');
    const p = checkProtected();
    if (p.enforced && !p.ok) out.push({ kind: 'gate', line: `protected files changed on main without your approval: ${p.changes.slice(0, 3).map((c) => c.path).join(', ')}${p.changes.length > 3 ? ' …' : ''} (npm run approve -- protected)` });
  });
  // Bible and phase decisions.
  await tryAdd(async () => {
    const b = await import('./bible.mjs');
    if (b.hasBible() && !b.readBible().signed) out.push({ kind: 'bible', line: 'the Game Bible is waiting for your signature (npm run bible)' });
  });
  await tryAdd(async () => {
    const { openAsks } = await import('./ask.mjs');
    const open = openAsks();
    if (open.length) out.push({ kind: 'bible', line: `${open.length} open question${open.length === 1 ? '' : 's'} for you${open[0]?.question ? `, first: "${String(open[0].question).slice(0, 80)}"` : ''} (npm run ask)` });
  });
  // Money: a tool over its weekly target.
  await tryAdd(async () => {
    const { budgetStatus } = await import('./budget.mjs');
    const over = budgetStatus(now).filter((t) => t.verdict === 'over');
    if (over.length) out.push({ kind: 'spend', line: `spend over budget: ${over.map((t) => `${t.tool} ${Math.round(t.pct * 100)}% of its week (target ${Math.round(t.targetPct * 100)}%)`).join(', ')} (npm run budget)` });
  });
  // Stops self-triage didn't (or may not) fix.
  await tryAdd(async () => {
    const { readStatus } = await import('./supervisor.mjs');
    const s = readStatus();
    const pending = fs.existsSync(path.join(STUDIO_STATE_DIR, 'supervisor-resume'));
    if (s?.status === 'running' && s.halted && !pending) out.push({ kind: 'halt', line: `the supervisor is halted: ${String(s.halted.why || 'no reason recorded').slice(0, 120)} (npm run studio:resume -- --by <you>)` });
  });
  // 2.68.0: roles the crew watchdog paused (harness/crew-watch.mjs): new work or a landing clears it, else a person.
  await tryAdd(async () => {
    const { pausedLines } = await import('./crew-watch.mjs');
    for (const p of pausedLines()) out.push({ kind: 'crew', line: `crew: ${p.line}` });
  });
  // 2.70.0 (v): assets whose previews passed the checks and wait for a look, oldest first (harness/asset-review.mjs).
  await tryAdd(async () => {
    const line = (await import('./asset-review.mjs')).pendingReviewsLine(root);
    if (line) out.push({ kind: 'review', line });
  });
  out.push(...fuzzSuggestions(ev, now));
  const declined = ev.filter((e) => e.type === 'selftriage.declined' && (Date.parse(e.ts) || 0) >= now - DAY);
  for (const e of declined.slice(-3)) { const why = String(e.meta?.why || e.msg || ''); out.push({ kind: 'halt', line: `self-triage left for you (${e.meta?.fix || 'a fix'}, ${e.meta?.cause || 'a cause'}): ${why.length > 110 ? `${why.slice(0, 109)}…` : why}` }); }
  return out;
}

/**
 * 2.66.0 (npm run fuzz): fuzz findings of the last 24 h. Suggested ones (the shadow week) need a person to file or
 * ignore them: [{ kind: 'fuzz', line }]. Filed ones are only counted (fuzzFiledLine).
 */
export function fuzzSuggestions(ev, now = Date.now()) {
  const recent = ev.filter((e) => e.type === 'fuzz.finding' && e.meta?.mode === 'suggest' && (Date.parse(e.ts) || 0) >= now - DAY);
  if (!recent.length) return [];
  const ids = [...new Set(recent.map((e) => e.meta?.id).filter(Boolean))];
  const until = recent.map((e) => e.meta?.until).filter(Boolean).pop();
  return [{ kind: 'fuzz', line: `fuzz found ${ids.length} new bug${ids.length === 1 ? '' : 's'} (${ids.slice(0, 3).join(', ')}${ids.length > 3 ? ' …' : ''}), suggested, not filed${until ? ` until ${String(until).slice(0, 10)}` : ''}: .studio/fuzz/suggestions.md (npm run fuzz -- file <id> --by <you>, or ignore it with a why in studio/fuzz.ignore.json)` }];
}
export function fuzzFiledLine(ev, now = Date.now()) {
  const filed = ev.filter((e) => e.type === 'fuzz.finding' && e.meta?.mode === 'file' && (Date.parse(e.ts) || 0) >= now - DAY);
  return filed.length ? `Fuzz filed ${filed.length} bug task${filed.length === 1 ? '' : 's'} in 24 h: ${filed.map((e) => e.meta?.task).filter(Boolean).slice(0, 4).join(', ')}.` : '';
}

/** 2.67.1 (k): Unity Play Mode tests that failed once and passed on retry in the last 24 h (harness/unity.mjs gate). */
export function unityFlakeLine(ev, now = Date.now()) {
  const fl = ev.filter((e) => e.type === 'unity.flake' && (Date.parse(e.ts) || 0) >= now - DAY);
  if (!fl.length) return '';
  const tests = [...new Set(fl.flatMap((e) => e.meta?.tests || []))];
  return `Unity Play Mode flaked ${fl.length} time${fl.length === 1 ? '' : 's'} in 24 h (failed, then passed on retry; counted green): ${tests.slice(0, 3).join(', ') || '?'}${tests.length > 3 ? ' …' : ''} (.studio/unity-flakes.jsonl).`;
}

/** The digest's text (markdown) and its parts. */
export async function buildDigest({ now = Date.now(), root = REPO_ROOT, events = null, date = null } = {}) {
  const ev = events || readRecentEvents(20000);
  const need = await needsPerson({ now, root, events: ev });
  let line = '';
  try { line = (await (await import('./autonomy.mjs')).autonomyReport({ now, events: ev, withAttempts: false })).line; } catch { line = ''; }
  const fixes = ev.filter((e) => /^selftriage\./.test(e.type || '') && e.type !== 'selftriage.declined' && (Date.parse(e.ts) || 0) >= now - DAY);
  const byFix = {};
  for (const e of fixes) { const k = e.type.slice('selftriage.'.length); byFix[k] = (byFix[k] || 0) + 1; }
  const d = date || localDate(now);
  const head = `# Studio digest ${d}`;
  const tri = fixes.length ? `Self-triage fixed ${fixes.length} routine stop${fixes.length === 1 ? '' : 's'} in 24 h: ${Object.entries(byFix).map(([k, v]) => `${k} ${v}`).join(', ')}.` : 'Self-triage: nothing to fix in 24 h.';
  const fuzzLine = fuzzFiledLine(ev, now);
  const flakeLine = unityFlakeLine(ev, now); // 2.67.1 (k)
  let diskLine = ''; // 2.68.0 (m): the studio's disk under STUDIO_DISK_MIN_FREE_GB in the last 24 h
  try { diskLine = (await import('./machine.mjs')).diskDigestLine(ev, now); } catch { diskLine = ''; }
  // 2.68.0: the latest harness upgrade's verdict, once enough data exists on both sides (harness/impact.mjs).
  let lanesLine = ''; // 2.70.0 (w): stale lane copies the janitor proposed (harness/lane-disk.mjs), never deleted here
  try { const l = (await import('./lane-disk.mjs')).staleLanesLine({ root, now }); lanesLine = l ? `${l[0].toUpperCase()}${l.slice(1)}.` : ''; } catch { lanesLine = ''; }
  let impactLine = '';
  try { impactLine = (await import('./impact.mjs')).impactDigestLine({ events: ev, now, root }); } catch { impactLine = ''; }
  // 2.67.0: owner actions an outside agent ran under the owner's standing delegation (harness/delegation.mjs).
  let delegLine = '';
  try { delegLine = (await import('./delegation.mjs')).delegationDigestLine({ events: ev, now }); } catch { delegLine = ''; }
  // 2.66.0 (c): the top blocked commands (harness/denials.mjs) as allowlist candidates; a person decides, nothing is added.
  let cands = [];
  try { cands = (await import('./denials.mjs')).allowlistCandidates({ n: 5, now }); } catch { cands = []; }
  let candLine = cands.length ? `Allowlist candidates (blocked commands, 7 days; suggestions only, never added to any settings or permission file automatically): ${cands.map((c) => `\`${c.key.length > 48 ? `${c.key.slice(0, 47)}…` : c.key}\` ${c.n}`).join(', ')} (npm run denials).` : '';
  let quarLine = ''; // 2.69.0 (r): tests the flake triager quarantined (harness/flakes.mjs), with their evidence
  try { quarLine = (await import('./flakes.mjs')).quarantineDigestLine(ev, { now, root }); } catch { quarLine = ''; }
  let researchLine = ''; // 2.71.0 (y): research tasks finished in the last 24 h, with their write-ups (harness/research.mjs)
  try { researchLine = (await import('./research.mjs')).researchDigestLine(ev, { now, root }); } catch { researchLine = ''; }
  let buildLine = ''; // 2.70.0 (t): the latest playable build and clip after a landing in the last 24 h
  try { const l = (await import('./landing-build.mjs')).landingLine(ev, { since: now - DAY }); buildLine = l ? `${l} (npm run play).` : ''; } catch { buildLine = ''; }
  const compose = (items) => [head, '', items.length ? `Needs you (${need.length}):` : 'Nothing needs you today.', ...items.map((x) => `- ${x.line}`), '', ...(candLine ? [candLine] : []), line, tri, ...(fuzzLine ? [fuzzLine] : []), ...(flakeLine ? [flakeLine] : []), ...(quarLine ? [quarLine] : []), ...(diskLine ? [diskLine] : []), ...(buildLine ? [buildLine] : []), ...(researchLine ? [researchLine] : []), ...(lanesLine ? [lanesLine] : []), ...(impactLine ? [impactLine] : []), ...(delegLine ? [delegLine] : []), ''].filter((x, i, a) => !(x === '' && a[i - 1] === '')).join('\n');
  // Under MAX_WORDS: drop list items from the end, then shorten the scorecard line.
  let items = [...need];
  let text = compose(items);
  if (words(text) >= MAX_WORDS && candLine) { candLine = `Allowlist candidates: ${cands.length} (npm run denials; never added automatically).`; text = compose(items); }
  while (words(text) >= MAX_WORDS && items.length > 1) { items = items.slice(0, -1); text = compose(items).replace(/Needs you \((\d+)\):/, `Needs you ($1; ${need.length - items.length} more: npm run digest -- --all):`); }
  if (words(text) >= MAX_WORDS) { line = line.split(' · ').slice(0, 3).join(' · '); text = compose(items); }
  return { text, need, fixes: byFix, line, candidates: cands, date: d, words: words(text) };
}

/** Write studio/digest/<date>.md and one digest.written event. */
export async function writeDigest({ now = Date.now(), root = REPO_ROOT, date = null } = {}) {
  const d = await buildDigest({ now, root, date });
  const file = digestFile(d.date, root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, d.text);
  const rel = path.relative(root, file).replace(/\\/g, '/');
  emitEvent({ type: 'digest.written', agent: 'digest', to: 'human', status: d.need.length ? 'warn' : 'ok', msg: `Daily digest ${d.date}: ${d.need.length ? `${d.need.length} thing${d.need.length === 1 ? '' : 's'} need${d.need.length === 1 ? 's' : ''} you` : 'nothing needs you'} (${rel})`, meta: { file: rel, needs: d.need.length, kinds: [...new Set(d.need.map((x) => x.kind))], selfTriage: d.fixes, words: d.words } });
  return { ...d, file: rel };
}

/** The watchdog's daily run: at or after STUDIO_DIGEST_HOUR (9) local, once per local date. Returns the digest or null. */
export async function digestIfDue({ now = Date.now(), env = process.env, root = REPO_ROOT } = {}) {
  if (/^(off|0|false|no)$/i.test(String(env.STUDIO_DIGEST || ''))) return null;
  const hour = Math.min(23, Math.max(0, Number.isFinite(Number(env.STUDIO_DIGEST_HOUR)) && env.STUDIO_DIGEST_HOUR !== '' && env.STUDIO_DIGEST_HOUR !== undefined ? Number(env.STUDIO_DIGEST_HOUR) : 9));
  if (new Date(now).getHours() < hour) return null;
  if (fs.existsSync(digestFile(localDate(now), root))) return null;
  return writeDigest({ now, root });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const date = argv.includes('--date') ? argv[argv.indexOf('--date') + 1] : null;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) { console.error('Usage: npm run digest [-- --print] [--date YYYY-MM-DD]'); process.exit(2); }
  if (argv.includes('--all')) {
    const need = await needsPerson();
    console.log(need.length ? need.map((x) => `- ${x.line}`).join('\n') : 'Nothing needs you.');
    process.exit(0);
  }
  const d = await writeDigest({ date });
  console.log(argv.includes('--print') ? d.text : `Wrote ${d.file} (${d.words} words): ${d.need.length ? `${d.need.length} thing(s) need you` : 'nothing needs you'}.`);
}
