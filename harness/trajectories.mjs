#!/usr/bin/env node
/**
 * harness/trajectories.mjs — export the studio's finished work as training and evaluation records.
 * Opt-in: nothing is exported without the game dev's consent and terms.
 *
 *   npm run trajectories -- export --consent "<who agrees>" --licence "<terms>" [--with-briefs] [--with-diffs] [--since 2026-10-01]
 *   npm run trajectories -- preview          how many records, and what an export would hold (writes nothing)
 *
 * One record per finished task: the task (type, role, size, phase, what it served), the model and
 * agent, the commits made for it (files and line counts, from Studio-Task trailers), and how it went:
 * refusals before done, forced, reopened, bugs later traced back to it, review verdicts. Each gets a
 * label: "clean" (done first time, nothing came back), "needed-fixes" (refused, forced or reviewed
 * with changes), or "caused-bug" (reopened, or a bug traced to it). With --with-briefs, the task's
 * focus brief is included as the input.
 *
 * Every text field is scrubbed for key-shaped strings with the same patterns as the secret scan.
 * Output goes to .studio/exports/ (never committed): a .jsonl file and a manifest with the consent,
 * the terms, the counts and the file's SHA-256. Sign the manifest with `npm run sign` tooling if you
 * share it. Uses: comparing and routing models, fine-tuning a local model on your own studio's good
 * work, and, only with consent and terms, datasets for others.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, readRecentEvents, emitEvent } from './event.mjs';
import { parseNextQueue } from './task.mjs';
import { taskType } from './done-check.mjs';
import { taggedCommits, traceBugs, DEFAULT_SIZE } from './scorecard.mjs';
import { scrub } from './secrets.mjs';
import { modelFamily } from './families.mjs';

const OUT_DIR = path.join(STUDIO_STATE_DIR, 'exports');

function numstat(hash) {
  const r = spawnSync('git', ['show', '--numstat', '--format=', hash], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (r.status !== 0) return { insertions: 0, deletions: 0 };
  return r.stdout.split('\n').filter(Boolean).reduce((a, l) => {
    const [ins, del] = l.split('\t');
    return { insertions: a.insertions + (Number(ins) || 0), deletions: a.deletions + (Number(del) || 0) };
  }, { insertions: 0, deletions: 0 });
}

function patch(hash) {
  const r = spawnSync('git', ['show', '--format=', '--patch', hash, '--', '.', ':(exclude)studio', ':(exclude).studio', ':(exclude)package-lock.json'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout.slice(0, 20000) : '';
}

export function buildRecords({ withBriefs = false, withDiffs = false, since = null } = {}) {
  const q = parseNextQueue();
  const events = readRecentEvents(100000);
  const meta = new Map(events.filter((e) => e.type === 'task.added' && e.task).map((e) => [e.task, e.meta || {}]));
  const done = new Map(events.filter((e) => e.type === 'task.done' && e.task).map((e) => [e.task, e]));
  const started = new Map(events.filter((e) => e.type === 'task.start' && e.task).map((e) => [e.task, e]));
  const commits = taggedCommits();
  const bugIds = [...q.inProgress, ...q.backlog, ...q.done].filter((t) => taskType(t) === 'bug').map((t) => t.id);
  const traces = traceBugs(bugIds, commits);
  const causedBy = events.filter((e) => e.type === 'task.added' && e.meta?.causedBy).map((e) => e.meta.causedBy);
  const reviewsDir = path.join(REPO_ROOT, 'studio', 'reviews');
  const reviews = fs.existsSync(reviewsDir) ? fs.readdirSync(reviewsDir).filter((f) => f.endsWith('.md') && f !== 'README.md').map((f) => fs.readFileSync(path.join(reviewsDir, f), 'utf8')) : [];
  let hits = 0;
  const clean = (s) => {
    const r = scrub(s);
    hits += r.hits;
    return r.text;
  };
  const records = [];
  for (const t of q.done) {
    const d = done.get(t.id);
    if (!d) continue;
    if (since && String(d.ts) < since) continue;
    const m = meta.get(t.id) || {};
    const type = taskType(t);
    const own = commits.filter((c) => c.tasks.includes(t.id));
    const refused = events.filter((e) => e.type === 'task.not_done' && e.task === t.id).length;
    const forced = events.some((e) => e.type === 'task.forced' && e.task === t.id);
    const reopened = events.some((e) => e.type === 'task.reopened' && e.task === t.id);
    const traced = traces.filter((x) => x.task === t.id).length + causedBy.filter((x) => x === t.id).length;
    const verdicts = reviews.filter((r) => new RegExp(`\\b${t.id}\\b`).test(r)).map((r) => (r.match(/\b(approve[sd]?|lgtm|request(?:ed)? changes|changes requested|reject(?:ed)?|blocking)\b/i) || [])[1]?.toLowerCase()).filter(Boolean);
    const label = reopened || traced ? 'caused-bug' : refused || forced || verdicts.some((v) => /change|reject|block/.test(v)) ? 'needed-fixes' : 'clean';
    const briefFile = path.join(STUDIO_STATE_DIR, 'briefs', `${t.id}.md`);
    records.push({
      id: t.id,
      title: clean(t.title),
      type,
      role: t.role,
      size: m.size || DEFAULT_SIZE[type] || 2,
      phase: m.phase || null,
      serves: m.serves || null,
      idea: m.idea || null,
      experiment: m.experiment || null,
      model: d.model || started.get(t.id)?.model || null,
      agent: d.agent || null,
      startedAt: started.get(t.id)?.ts || null,
      doneAt: d.ts,
      input: withBriefs && fs.existsSync(briefFile) ? clean(fs.readFileSync(briefFile, 'utf8')) : null,
      commits: own.map((c) => ({ commit: c.hash.slice(0, 12), files: c.files, ...numstat(c.hash), model: c.model || null, ...(withDiffs ? { diff: clean(patch(c.hash)) } : {}) })),
      providers: [...new Set([d.model || started.get(t.id)?.model, ...own.map((c) => c.model)].filter(Boolean).map(modelFamily))],
      outcome: { refusedBeforeDone: refused, forced, reopened, bugsTracedBack: traced, reviews: verdicts },
      label,
    });
  }
  return { records, scrubbed: hits };
}

export function exportTrajectories({ consent, licence, withBriefs = false, withDiffs = false, since = null }) {
  if (!consent || !licence) return { ok: false, message: 'Exports are opt-in. Say who agrees and on what terms: --consent "<who agrees to this export>" --licence "<terms for its use>".' };
  const { records, scrubbed } = buildRecords({ withBriefs, withDiffs, since });
  if (!records.length) return { ok: false, message: 'No finished tasks to export yet.' };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const file = path.join(OUT_DIR, `trajectories-${stamp}.jsonl`);
  fs.writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const labels = records.reduce((a, r) => ({ ...a, [r.label]: (a[r.label] || 0) + 1 }), {});
  const providers = records.flatMap((r) => r.providers).reduce((a, p) => ({ ...a, [p]: (a[p] || 0) + 1 }), {});
  const manifest = {
    kind: 'studio.trajectories',
    harness: pkg.version,
    file: path.basename(file),
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    records: records.length,
    labels,
    providers,
    termsNote: `Records include work by models from: ${Object.keys(providers).join(', ') || 'unknown'}. Several providers' terms limit using their outputs to train other companies' models. Check each provider's current terms before sharing outside your studio.`,
    withBriefs,
    withDiffs,
    consent,
    licence,
    scrubbedSecrets: scrubbed,
    at: new Date().toISOString(),
  };
  const manifestFile = file.replace(/\.jsonl$/, '.manifest.json');
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  emitEvent({ type: 'trajectories.export', agent: 'producer', msg: `Exported ${records.length} task records (${Object.entries(labels).map(([k, v]) => `${v} ${k}`).join(', ')}) with consent from ${consent}` });
  return { ok: true, file: path.relative(REPO_ROOT, file), manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  };
  if (argv[0] === 'export') {
    const r = exportTrajectories({ consent: flag('consent'), licence: flag('licence') || flag('license'), withBriefs: argv.includes('--with-briefs'), withDiffs: argv.includes('--with-diffs'), since: flag('since') });
    if (!r.ok) {
      console.error(r.message);
      process.exit(1);
    }
    console.log(`Exported ${r.manifest.records} records to ${r.file} (${Object.entries(r.manifest.labels).map(([k, v]) => `${v} ${k}`).join(', ')}; ${r.manifest.scrubbedSecrets} key-shaped strings removed). Manifest with consent, terms and SHA-256 next to it.\n${r.manifest.termsNote}`);
  } else {
    const { records, scrubbed } = buildRecords({ withBriefs: argv.includes('--with-briefs') });
    const labels = records.reduce((a, r) => ({ ...a, [r.label]: (a[r.label] || 0) + 1 }), {});
    console.log(`${records.length} finished task(s) could be exported (${Object.entries(labels).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}); ${scrubbed} key-shaped strings would be removed. Nothing written. Export needs --consent and --licence.`);
    if (records[0]) console.log(JSON.stringify(records[0], null, 2));
  }
}
