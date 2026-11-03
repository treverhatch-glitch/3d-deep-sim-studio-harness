#!/usr/bin/env node
/**
 * harness/decisions.mjs — 2.71.0 (x): `npm run decisions`, the decision log's CLI (list, review, approve, revert, edit,
 * stats). The log itself: harness/decisions-log.mjs (import that one from other modules, never this CLI).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DECISIONS_REL, listDecisions, pendingReview, reviewSummary, reviewDecision, revertDecision, autonomyStats, sinceMs } from './decisions-log.mjs';

const row = (d) => `${d.id}  ${String(d.at).slice(0, 16).replace('T', ' ')}  ${d.action}${d.subject ? ` ${d.subject}` : ''}  by ${d.by} (${d.as})${d.why ? `: ${d.why}` : ''}${d.evidence ? ` [${d.evidence}]` : ''}${d.review ? `  -> ${d.review.verdict} by ${d.review.by}` : d.as === 'autonomous' ? '  -> waiting for review' : ''}`;

export const USAGE = `Usage: npm run decisions [-- --since 24h|7d|<ISO>] [--by <name>] [--action <a>] [--json]
       npm run decisions -- review                      autonomous decisions waiting for review, oldest first
       npm run decisions -- approve <id> --by <name> [--permission "…"]
       npm run decisions -- revert <id> --by <name> [--why "…"] [--permission "…"]
       npm run decisions -- edit <id> --note "…" --by <name> [--permission "…"]
       npm run decisions -- stats [--days 14] [--json]`;

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); process.exit(0); }
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--') ? argv[i + 1] : null; };
  const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'list';
  const done = (r) => { (r.ok ? console.log : console.error)(r.message); process.exit(r.ok ? 0 : 1); };
  if (cmd === 'list') {
    const since = opt('--since');
    if (since && !Number.isFinite(sinceMs(since))) { console.error(USAGE); process.exit(2); }
    const rows = listDecisions({ since, by: opt('--by'), action: opt('--action') });
    if (argv.includes('--json')) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }
    console.log(rows.length ? rows.slice(-200).map(row).join('\n') : `No decisions${since ? ` since ${since}` : ''} in ${DECISIONS_REL}.`);
    process.exit(0);
  }
  if (cmd === 'review') {
    const p = pendingReview();
    const s = await reviewSummary();
    if (argv.includes('--json')) { console.log(JSON.stringify({ ...s, list: p }, null, 2)); process.exit(0); }
    console.log(`Autonomous mode: ${s.mode}. ${p.length ? `${p.length} decision(s) waiting for review (due within ${s.reviewWithinH} h; ${s.overdue} past it). Work never waits for them.` : 'Nothing waits for review.'}`);
    for (const d of p) console.log(`  ${row(d)}${d.undo?.text ? `\n      undo: ${d.undo.text}` : ''}`);
    if (p.length) console.log('Approve, revert or edit: npm run decisions -- approve|revert <id> --by <you>, edit <id> --note "…" --by <you>.');
    process.exit(0);
  }
  if (cmd === 'approve') done(await reviewDecision(argv[1], { verdict: 'approved', by: opt('--by'), permission: opt('--permission') || '', note: opt('--note') || '' }));
  if (cmd === 'edit') done(await reviewDecision(argv[1], { verdict: 'edited', by: opt('--by'), permission: opt('--permission') || '', note: opt('--note') || '' }));
  if (cmd === 'revert') done(await revertDecision(argv[1], { by: opt('--by'), permission: opt('--permission') || '', why: opt('--why') || '' }));
  if (cmd === 'stats') {
    const s = autonomyStats({ days: Number(opt('--days')) > 0 ? Number(opt('--days')) : 14 });
    if (argv.includes('--json')) { console.log(JSON.stringify(s, null, 2)); process.exit(0); }
    console.log(`Autonomous decisions, ${s.days} days: ${s.total} (approved ${s.approved}, reverted ${s.reverted}, edited ${s.edited}, waiting ${s.pending}); revert rate ${s.revertRate === null ? 'n/a (none reviewed)' : `${Math.round(s.revertRate * 1000) / 10}%`}.`);
    for (const [d, n] of Object.entries(s.perDay).sort()) console.log(`  ${d}: ${n}`);
    for (const [a, v] of Object.entries(s.saved)) console.log(`  time saved, ${a} (${v.decisions}): ${v.text}`);
    process.exit(0);
  }
  console.error(USAGE);
  process.exit(1);
}
