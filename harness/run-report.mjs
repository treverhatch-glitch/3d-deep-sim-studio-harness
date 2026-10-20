#!/usr/bin/env node
/**
 * harness/run-report.mjs — the results of a test run, in one folder anyone can open.
 *
 *   npm run run-report [-- --to <folder>] [--final]
 *
 * Writes to --to, or STUDIO_RESULTS_DIR (a synced Google Drive folder works):
 *   <folder>/<game>/REPORT.md              the run so far: progress, checks, models, harness notes,
 *                                          the overseer's evaluations, what repeated, what needs a person
 *   <folder>/<game>/snapshots/<time>.md    one short line-set per run of this command (the HUB adds one an hour)
 *   <folder>/<game>/files/                 the Bible, plan, queue, lessons, notes, latest playtest and gate
 *                                          run, retros, reviews, signed results, and the event log (gzipped)
 * A script: no model, no tokens. --final marks the report as the end of the run.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, readRecentEvents, emitEvent } from './event.mjs';
import { parseNextQueue, readStop } from './task.mjs';
import { taskType } from './done-check.mjs';
import { buildLearned, writeLearned } from './learn.mjs';
import { renderScorecard } from './scorecard.mjs';
import { readNotes } from './notes.mjs';
import { describeConsent } from './data-consent.mjs';
import { describeMode } from './mode.mjs';
import { sessions as agentSessions } from './agent.mjs';
import { allAsks } from './ask.mjs';

const read = (rel) => {
  try {
    return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
  } catch {
    return '';
  }
};
const json = (rel) => {
  try {
    return JSON.parse(read(rel));
  } catch {
    return null;
  }
};
const hours = (ms) => (ms / 3600000).toFixed(1);

function slug() {
  const title = json('studio/bible/bible.json')?.answers?.title;
  return { title, slug: String(title || path.basename(REPO_ROOT)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'studio' };
}

export function buildRunReport({ final = false } = {}) {
  const events = readRecentEvents(200000);
  const q = parseNextQueue();
  const all = [...q.inProgress, ...q.backlog, ...q.done];
  const count = (type) => events.filter((e) => e.type === type).length;
  const first = events.find((e) => e.ts)?.ts || null;
  const pkg = json('package.json') || {};
  const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim() || null;
  const commits = Number(spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim() || 0);
  const bible = json('studio/bible/bible.json');
  const gates = json('.studio/gates-last.json');
  const reports = fs.existsSync(path.join(REPO_ROOT, 'qa/reports')) ? fs.readdirSync(path.join(REPO_ROOT, 'qa/reports')).filter((f) => /^qa_.*\.json$/.test(f)).sort() : [];
  const playtest = reports.length ? json(`qa/reports/${reports.at(-1)}`) : null;
  const ideas = fs.existsSync(path.join(REPO_ROOT, 'studio/bible/ideas')) ? fs.readdirSync(path.join(REPO_ROOT, 'studio/bible/ideas')).filter((f) => f.endsWith('.json')).map((f) => json(`studio/bible/ideas/${f}`)).filter(Boolean) : [];
  const byType = all.reduce((a, t) => {
    const k = taskType(t);
    a[k] = a[k] || { open: 0, done: 0 };
    a[k][q.done.includes(t) ? 'done' : 'open'] += 1;
    return a;
  }, {});
  const learned = buildLearned();
  const notes = readNotes();
  const now = Date.now();
  return {
    at: new Date(now).toISOString(),
    final,
    game: slug().title || '(no Bible yet)',
    harness: pkg.version,
    commit,
    commits,
    startedAt: first,
    hoursSoFar: first ? hours(now - Date.parse(first)) : '0',
    frozen: fs.existsSync(path.join(STUDIO_STATE_DIR, 'harness-frozen')),
    stopped: readStop(),
    bible: bible ? { signed: bible.signed?.by || null, phaseOpen: bible.phase?.open || 0, playLength: bible.answers?.playLength || null, kept: Object.values(bible.layers || {}).filter((l) => l.answer !== 'no').length, crossed: Object.values(bible.layers || {}).filter((l) => l.answer === 'no').length } : null,
    tasks: { done: q.done.length, inProgress: q.inProgress.length, waiting: q.backlog.length, byType },
    checks: { refused: count('task.not_done'), forced: count('task.forced'), reopened: count('task.reopened'), handedBack: count('task.paused'), lockDenied: count('task.lock_denied'), escalations: count('closedloop.escalate') },
    gates: gates ? { at: gates.at, partial: Boolean(gates.partial), green: (gates.rows || []).filter((r) => r.required && r.ok).length, required: (gates.rows || []).filter((r) => r.required).length, failed: (gates.rows || []).filter((r) => r.required && !r.ok).map((r) => r.id) } : null,
    playtest: playtest ? { file: reports.at(-1), passed: playtest.passed, outcome: playtest.stage1?.outcome || null, ticks: playtest.stage1?.ticksRun ?? null, failingTick: playtest.stage1?.failingTick ?? null } : null,
    ideas: ideas.reduce((a, i) => ({ ...a, [i.stage]: (a[i.stage] || 0) + 1 }), {}),
    directorReviews: fs.existsSync(path.join(REPO_ROOT, 'studio/bible/reviews')) ? fs.readdirSync(path.join(REPO_ROOT, 'studio/bible/reviews')).filter((f) => f.endsWith('.md')).length : 0,
    needsPerson: events.filter((e) => /^(task\.forced|bible\.sign_needed|idea\.approval_needed|route\.capped|director\.off_course)$/.test(e.type || '') || e.status === 'blocked').slice(-8).map((e) => `${String(e.ts).slice(0, 16)} ${e.agent}: ${e.msg}`),
    learned,
    notes,
    consent: describeConsent(),
    pace: describeMode(),
    launched: agentSessions(),
    decided: allAsks().filter((a) => a.status === 'decided' || a.status === 'reversed'),
  };
}

export function renderRunReport(r) {
  const L = [];
  const t = r.tasks;
  L.push(`# Test run: ${r.game}`, '');
  L.push(`> ${r.final ? 'Final report' : 'Report so far'}, written ${r.at.slice(0, 16).replace('T', ' ')} UTC by \`npm run run-report\` from the studio's files. No model wrote this.`, '');
  L.push(`- Harness ${r.harness}, commit ${r.commit || '?'} (${r.commits} commits), ${r.frozen ? 'harness frozen for the run' : '**harness NOT frozen** (npm run preflight -- --fix)'}`);
  L.push(`- Running ${r.hoursSoFar} hours since the first event (${r.startedAt ? r.startedAt.slice(0, 16).replace('T', ' ') : 'none yet'} UTC)${r.stopped ? `; **stopped** by ${r.stopped.by}` : ''}`);
  L.push(`- Game Bible: ${r.bible ? `${r.bible.signed ? `signed by ${r.bible.signed}, Phase ${r.bible.phaseOpen} open` : 'not signed yet'}; ${r.bible.playLength || 'no play length'}; ${r.bible.kept} layers kept, ${r.bible.crossed} crossed out` : 'none yet'}`);
  L.push(`- Data sharing: ${r.consent}`);
  L.push(`- Pace: ${r.pace}`, '');
  L.push('## Progress', '');
  L.push(`${t.done} tasks done, ${t.inProgress} in progress, ${t.waiting} waiting.`, '');
  L.push('| Type | Done | Open |', '| --- | --- | --- |', ...Object.entries(t.byType).sort().map(([k, v]) => `| ${k} | ${v.done} | ${v.open} |`), '');
  L.push('## Did the checks hold?', '');
  const c = r.checks;
  L.push(`- "Done" refused by a check: ${c.refused}. Forced past a check: ${c.forced}. Reopened: ${c.reopened}. Handed back: ${c.handedBack}. Lock clashes: ${c.lockDenied}. Closed-loop escalations: ${c.escalations}.`);
  L.push(`- Last full verify: ${r.gates ? `${r.gates.green} of ${r.gates.required} required gates green at ${String(r.gates.at).slice(0, 16).replace('T', ' ')}${r.gates.partial ? ' (partial run)' : ''}${r.gates.failed.length ? `; failing: ${r.gates.failed.join(', ')}` : ''}` : 'never run'}`);
  L.push(`- Latest playtest: ${r.playtest ? `${r.playtest.passed ? 'passed' : '**failed**'}${r.playtest.outcome ? `, ${r.playtest.outcome}` : ''} at tick ${r.playtest.ticks}${r.playtest.failingTick ? `, failing tick ${r.playtest.failingTick}` : ''} (${r.playtest.file})` : 'none yet'}`);
  L.push(`- Ideas: ${Object.entries(r.ideas).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}. Director reviews: ${r.directorReviews}.`, '');
  L.push('## Models', '', ...renderScorecard(r.learned.scorecard).split('\n').map((x) => `    ${x}`), '');
  L.push('## What kept happening', '');
  L.push(...(r.learned.repeats.length ? r.learned.repeats.slice(0, 8).map((x) => `- ${x.type} on ${x.days.length} days (${x.count} times): ${x.sample}${x.lesson ? ` (lesson "${x.lesson}" didn't stick)` : ''}`) : ['- Nothing repeated on two different days.']), '');
  L.push('## The harness, as the agents found it', '');
  const n = r.notes;
  for (const [k, label] of [['bad', "Didn't work"], ['workaround', 'Workarounds'], ['upgrade', 'Upgrade ideas'], ['well', 'Worked well']]) {
    L.push(`**${label}** (${(n[k] || []).length})`, '', ...((n[k] || []).slice(0, 15).map((x) => `- ${x}`)), ...((n[k] || []).length ? [] : ['- None yet.']), '');
  }
  L.push("## The overseer's evaluations", '', ...((n.eval || []).length ? n.eval.slice(0, 10).map((x) => `- ${x}`) : ['- None yet. The overseer adds one at least every few hours: `npm run notes -- add --kind eval "..."`.']), '');
  L.push('## Agents the launcher ran', '', ...(r.launched.length ? r.launched.map((s) => `- ${s.agent} (${s.role}, ${s.tool}/${s.model}): ${s.running ? 'running' : s.reason || 'ended'}${s.handed?.length ? `; handed back ${s.handed.map((h) => h.task).join(', ')}` : ''}`) : ['- None (agents were started by hand).']), '');
  L.push('## Decided without you', '', ...(r.decided.length ? r.decided.map((a) => `- ${a.id}: ${a.question} → "${a.answer}" by ${a.by} (${a.why})${a.status === 'reversed' ? ` — reversed by ${a.answeredBy}` : ''}`) : ['- Nothing; every question was answered or is still open.']), '');
  L.push('## Needed a person', '', ...(r.needsPerson.length ? r.needsPerson.map((x) => `- ${x}`) : ['- Nothing.']), '');
  L.push('## Files', '', 'In `files/`: the Bible, plan, queue, lessons, harness notes, the latest playtest and gate run, retros, reviews, signed results, and `events.jsonl.gz` (every event of the run).', '');
  return L.join('\n');
}

const COPY = ['studio/mode.json', 'studio/decisions/decided-without-you.md', 'studio/bible/BIBLE.md', 'studio/bible/NOT-DOING.md', 'studio/bible/STORYBOARD.md', 'studio/PLAN.md', 'studio/NEXT.md', 'studio/CURRENT_TASK.md', 'studio/memory/failures.md', 'studio/memory/LEARNED.md', 'studio/harness-notes/NOTES.md', 'studio/producer/LOG.md', 'studio/data-consent.json', '.studio/gates-last.json'];
const COPY_DIRS = ['studio/memory/retros', 'studio/reviews', 'studio/bible/reviews', 'studio/bible/ideas', 'studio/signed', 'studio/meetings', 'studio/experiments'];

export function writeRunReport({ to = process.env.STUDIO_RESULTS_DIR, final = false } = {}) {
  if (!to) return { ok: false, message: 'Say where: --to <folder>, or set STUDIO_RESULTS_DIR (a synced Google Drive folder works).' };
  writeLearned();
  const r = buildRunReport({ final });
  const dest = path.join(path.resolve(to), slug().slug);
  fs.mkdirSync(path.join(dest, 'snapshots'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'REPORT.md'), renderRunReport(r));
  const snap = `# ${r.at.slice(0, 16).replace('T', ' ')} UTC\n\n- ${r.tasks.done} done, ${r.tasks.inProgress} in progress, ${r.tasks.waiting} waiting\n- refused ${r.checks.refused}, forced ${r.checks.forced}, reopened ${r.checks.reopened}, escalations ${r.checks.escalations}\n- gates ${r.gates ? `${r.gates.green}/${r.gates.required}` : 'not run'}; playtest ${r.playtest ? (r.playtest.passed ? 'passed' : 'failed') : 'none'}\n- notes: ${(r.notes.bad || []).length} bad, ${(r.notes.eval || []).length} evaluations${r.stopped ? '\n- STOPPED' : ''}\n`;
  fs.writeFileSync(path.join(dest, 'snapshots', `${r.at.replace(/[:.]/g, '-')}${final ? '-final' : ''}.md`), snap);
  const files = path.join(dest, 'files');
  for (const f of COPY.filter((x) => fs.existsSync(path.join(REPO_ROOT, x)))) {
    fs.mkdirSync(path.dirname(path.join(files, f)), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, f), path.join(files, f));
  }
  for (const d of COPY_DIRS.filter((x) => fs.existsSync(path.join(REPO_ROOT, x)))) {
    for (const f of fs.readdirSync(path.join(REPO_ROOT, d)).filter((x) => /\.(md|json)$/.test(x))) {
      fs.mkdirSync(path.join(files, d), { recursive: true });
      fs.copyFileSync(path.join(REPO_ROOT, d, f), path.join(files, d, f));
    }
  }
  if (r.playtest) {
    for (const ext of ['json', 'md']) {
      const f = `qa/reports/${r.playtest.file.replace(/\.json$/, `.${ext}`)}`;
      if (fs.existsSync(path.join(REPO_ROOT, f))) {
        fs.mkdirSync(path.join(files, 'qa/reports'), { recursive: true });
        fs.copyFileSync(path.join(REPO_ROOT, f), path.join(files, f));
      }
    }
  }
  const ev = path.join(STUDIO_STATE_DIR, 'events.jsonl');
  if (fs.existsSync(ev)) fs.writeFileSync(path.join(files, 'events.jsonl.gz'), zlib.gzipSync(fs.readFileSync(ev), { level: 9 }));
  emitEvent({ type: 'run.report', agent: 'watch', msg: `Run report written to ${dest}${final ? ' (final)' : ''}: ${r.tasks.done} tasks done, ${r.checks.forced} forced` });
  return { ok: true, dest, report: r };
}

/** From the HUB: a fresh report and a snapshot once an hour, when STUDIO_RESULTS_DIR is set. */
export function runReportIfDue(minMinutes = 60) {
  if (!process.env.STUDIO_RESULTS_DIR) return null;
  const last = readRecentEvents(3000).filter((e) => e.type === 'run.report').at(-1);
  if (last && Date.now() - Date.parse(last.ts) < minMinutes * 60000) return null;
  return writeRunReport();
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--to');
  const res = writeRunReport({ to: i >= 0 ? argv[i + 1] : undefined, final: argv.includes('--final') });
  if (!res.ok) {
    console.error(res.message);
    process.exit(1);
  }
  console.log(`Wrote ${path.join(res.dest, 'REPORT.md')} (${res.report.tasks.done} tasks done, ${res.report.checks.forced} forced, ${(res.report.notes.bad || []).length} harness problems noted)${res.report.final ? '. Marked final.' : ''}`);
}
