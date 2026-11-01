#!/usr/bin/env node
/**
 * harness/learn.mjs — what the studio has learned, whether it stuck, and a safe copy of it all.
 *
 *   npm run learn                       write studio/memory/LEARNED.md and print the summary
 *   npm run learn -- backup [--to <folder>] [--no-media]   back up every learning file (only what changed)
 *   npm run learn -- restore --from <folder> --to <empty folder> [--at <time>]
 *   npm run learn -- prune [--from <folder>] [--keep 30]   keep the newest 30 and the first of each month
 *   npm run learn -- change add|list|eval …                change records (harness/changes.mjs, 2.61.0)
 *
 * A script: no model, no tokens. It joins the studio's memory into one page:
 *   - lessons from fixed bugs (studio/memory/failures.md) and the newest ones,
 *   - what keeps happening: the same failure on two or more days, and the lesson it matches if
 *     one exists (a lesson that didn't stick),
 *   - retro suggestions raised again and again without being handled,
 *   - the overseer's evaluations and the harness notes,
 *   - models by bugs per 10 points.
 * 2.61.0, the learning edge: `npm run learn` (and the HUB's daily pass) also grades the change records that are due
 * (harness/changes.mjs) and files one "Make the lesson a check" task per failure signature that repeated after its
 * lesson (the ladder, studio/changes/ladder.json). `--no-cycle` only writes the page.
 *
 * Backups go to --to, or STUDIO_BACKUP_DIR (point it at a Google Drive, Dropbox or OneDrive folder
 * on your computer and the copy syncs off the machine). The HUB runs both once a day. Backups are
 * deduplicated: each distinct file content is stored once, gzipped, so a daily backup adds only what
 * changed. latest/ holds plain copies and STUDIO-MEMORY.md, one file you can open anywhere or import
 * into a Google Doc. Also kept: the newest 50 playtest reports and 20 screenshots (STUDIO_BACKUP_MEDIA).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, readRecentEvents, emitEvent } from './event.mjs';
import { readNotes } from './notes.mjs';
import { buildScorecard, renderScorecard, renderFollow } from './scorecard.mjs';
import { RETRO_DIR } from './retro.mjs';
import { signature, shape, signatureKey, signatureId, FAILURE_TYPES, readChanges, addChange, evaluateChanges, changeLine, readLadder, writeLadder } from './changes.mjs';
import { parseNextQueue, addTask, HANDOFF_DIR } from './task.mjs';
import { taskType } from './done-check.mjs';

const read = (rel) => {
  try {
    return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return '';
  }
};
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'task', 'tasks', 'after', 'since', 'when', 'not', 'was', 'has', 'have', 'its', 'are', 'but', 'agent']);
const keywords = (s) => [...new Set(String(s).toLowerCase().match(/[a-z][a-z-]{3,}/g) || [])].filter((w) => !STOP.has(w));

// 2.61.0: the signature helpers live in harness/changes.mjs (change records match the same shapes); re-exported here.
export { signature };

export function lessons() {
  const text = read('studio/memory/failures.md');
  return (text.split('## Recorded Distilled Notes')[1] || '')
    .split(/^### /m)
    .slice(1)
    .map((l) => ({ heading: l.split('\n')[0].trim(), body: l, words: keywords(l), at: (l.split('\n')[0].match(/\[(\d{4}-\d{2}-\d{2})\]/) || [])[1] || null, sigs: [...new Set((l.match(/\bsig-[0-9a-f]{8}\b/gi) || []).map((x) => x.toLowerCase()))], norm: shape(l) }));
}

/**
 * The lesson for a failure shape. 2.61.0: exact first: a lesson that names the signature id (`sig-3fa9c2d1`, shown by
 * `npm run learn`), then one that quotes the failure's normalized text; only then two or more shared keywords (as before).
 */
export function lessonFor(g, L = lessons()) {
  const exact = L.find((l) => l.sigs.includes(g.id));
  if (exact) return { lesson: exact, how: 'signature id' };
  const sig = signature(g.sample);
  const quoted = sig.length >= 20 ? L.find((l) => l.norm.includes(sig)) : null;
  if (quoted) return { lesson: quoted, how: 'failure text' };
  const w = keywords(g.sample);
  const kw = L.map((l) => ({ l, hits: w.filter((x) => l.words.includes(x)).length })).filter((x) => x.hits >= 2).sort((a, b) => b.hits - a.hits)[0]?.l || null;
  return kw ? { lesson: kw, how: 'keywords' } : { lesson: null, how: null };
}

/** The same failure on two or more days. */
export function repeats(events = readRecentEvents(50000)) {
  const groups = new Map();
  for (const e of events) {
    if (!FAILURE_TYPES.test(e.type || '') || !e.msg) continue;
    const sig = signatureKey(e);
    const g = groups.get(sig) || { sig, id: signatureId(sig), type: e.type, sample: e.msg, days: new Set(), count: 0 };
    g.days.add(String(e.ts).slice(0, 10));
    g.count += 1;
    groups.set(sig, g);
  }
  const L = lessons();
  return [...groups.values()]
    .filter((g) => g.days.size >= 2)
    .map((g) => {
      const { lesson, how } = lessonFor(g, L);
      const days = [...g.days].sort();
      // 2.61.0: it repeated after the lesson was written (a dated lesson: a day after its date; undated: two days at all).
      const after = lesson ? (lesson.at ? days.filter((d) => d > lesson.at) : days) : [];
      return { id: g.id, signature: g.sig, type: g.type, sample: g.sample, days, count: g.count, lesson: lesson?.heading || null, lessonAt: lesson?.at || null, matchedBy: how, afterLesson: after.length };
    })
    .sort((a, b) => b.days.length - a.days.length || b.count - a.count);
}

/**
 * 2.61.0, the lesson → check ladder: a failure that keeps happening after its lesson exists gets one task, once per
 * signature ever, to turn the lesson into a mechanical check (a test, a lint rule, a done-check item or a gate) proven
 * by the fails-before / passes-after proof. The task asks; it never edits a gate itself (gates stay owner-approved).
 */
export function ladder({ rep = repeats(), by = 'learn' } = {}) {
  const ledger = readLadder();
  const filed = [];
  for (const r of rep) {
    if (!r.lesson || !(r.lessonAt ? r.afterLesson >= 1 : r.days.length >= 2) || ledger[r.id]) continue;
    const title = `Make the lesson a check: ${r.signature}`.replace(/\s+/g, ' ').slice(0, 200);
    const t = addTask({ title, role: 'builder', priority: 'P2', agent: by, meta: { infra: true, promoted: true, origin: 'learn', ladder: true, signature: r.id, lesson: r.lesson, size: 2 } });
    if (!t?.id || t.error) {
      emitEvent({ type: 'learn.ladder', agent: by, status: 'warn', msg: `Couldn't queue the check task for ${r.id}: ${t?.message || 'no id'}`, meta: { signature: r.id } });
      continue;
    }
    try {
      fs.mkdirSync(HANDOFF_DIR, { recursive: true });
      fs.appendFileSync(path.join(HANDOFF_DIR, `${t.id}.md`), `\n## ${new Date().toISOString()} · ${by} (lesson → check)\nThe failure ${r.id} (${r.signature}) happened on ${r.days.length} days (last ${r.days.at(-1)}), ${r.afterLesson} of them after its lesson "${r.lesson}". The lesson didn't stick as prose.\nTurn it into a mechanical check: a test, a lint rule, a done-check item or a gate. Prove it: commit a regression that fails on the old failure and passes on today's main (the fails-before proof, qa/fails-before.mjs; a seeded test is "kind": "test", qa/regressions/README.md). A new or changed gate, protected file or done-check rule goes to the owner for approval: hand it back with a note, never sign or force it.\nThen record the change: npm run learn -- change add --kind rule --target <the check> --signature ${r.id} --expect "…" --risk "…" --revert "…"\n`);
    } catch {
      // the note is a help; the task stands
    }
    ledger[r.id] = { task: t.id, at: new Date().toISOString(), lesson: r.lesson, signature: r.signature };
    writeLadder(ledger);
    emitEvent({ type: 'learn.ladder', agent: by, task: t.id, to: 'producer', msg: `${t.id}: make the lesson "${r.lesson}" a check (${r.id} repeated after it)`, meta: { signature: r.id } });
    filed.push({ signature: r.id, task: t.id });
  }
  return filed;
}

/** The board's type for a task id (the change records compare rates per type). */
export function boardTypes(events = []) {
  const q = parseNextQueue();
  const byId = new Map([...q.inProgress, ...q.backlog, ...q.done].map((t) => [t.id, t]));
  const added = new Map();
  for (const e of events) if (e.type === 'task.added' && e.task && e.meta?.type) added.set(e.task, e.meta.type);
  return (id) => (byId.get(id) ? taskType(byId.get(id)) : added.get(id) || 'unknown');
}

/** What `npm run learn` and the HUB's daily pass do besides writing LEARNED.md: grade due changes, climb the ladder. */
export function learnCycle({ events = readRecentEvents(50000) } = {}) {
  const changes = evaluateChanges({ events, typeOf: boardTypes(events) });
  const filed = ladder({ rep: repeats(events) });
  return { changes, ladder: filed };
}

/** Retro suggestions raised in two or more retros and never ticked off. */
export function staleSuggestions() {
  if (!fs.existsSync(RETRO_DIR)) return [];
  const seen = new Map();
  for (const f of fs.readdirSync(RETRO_DIR).filter((n) => n.endsWith('.md')).sort()) {
    const text = fs.readFileSync(path.join(RETRO_DIR, f), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^- \[( |x)\] (.+)$/i);
      if (!m) continue;
      const sig = signature(m[2]);
      const s = seen.get(sig) || { text: m[2], retros: [], handled: false };
      s.retros.push(f.slice(0, 10));
      if (m[1].toLowerCase() === 'x') s.handled = true;
      seen.set(sig, s);
    }
  }
  return [...seen.values()].filter((s) => !s.handled && s.retros.length >= 2 && !/Nothing repeated/.test(s.text));
}

export function buildLearned() {
  const L = lessons();
  const rep = repeats();
  const stale = staleSuggestions();
  const notes = readNotes();
  const sc = buildScorecard();
  const changes = readChanges();
  const ladderLog = readLadder();
  return { at: new Date().toISOString(), changes, ladder: ladderLog, lessons: L.length, newest: L.slice(-5).map((l) => l.heading).reverse(), repeats: rep, stale, evals: (notes.eval || []).slice(0, 5), notes: Object.fromEntries(Object.entries(notes).map(([k, v]) => [k, v.length])), scorecard: sc };
}

export function writeLearned(l = buildLearned()) {
  const out = [
    '# What the studio has learned (`studio/memory/LEARNED.md`)',
    '',
    `> Written by \`npm run learn\` at ${l.at.slice(0, 16).replace('T', ' ')} UTC from the studio's own files. No model wrote this. The HUB rewrites it daily.`,
    '',
    '## Keeps happening',
    ...(l.repeats.length ? l.repeats.slice(0, 10).map((r) => `- ${r.type} on ${r.days.length} days (${r.days.at(-1)} last, ${r.count} times) [${r.id}]: ${r.sample}${r.lesson ? `\n  - There is a lesson for this (matched by ${r.matchedBy}), and it didn't stick: "${r.lesson}".${l.ladder?.[r.id] ? ` ${l.ladder[r.id].task} turns it into a check.` : ' Make it a check, or put it earlier in the skill.'}` : `\n  - No lesson covers it yet. The next fix should write one (name ${r.id} in it so it matches exactly).`}`) : ['- Nothing has repeated on two different days.']),
    '',
    '## Change records (studio/changes/)',
    ...(l.changes?.length ? l.changes.slice(-15).map((c) => `- ${changeLine(c)}`) : ['- None yet. Record a harness, skill, pitfall or rule change with `npm run learn -- change add …` (docs/CLOSED-LOOP.md).']),
    '',
    '## Suggestions raised again and again',
    ...(l.stale.length ? l.stale.map((s) => `- Raised in ${s.retros.length} retros (${s.retros.join(', ')}), never handled: ${s.text}`) : ['- None.']),
    '',
    `## Lessons from fixed bugs (${l.lessons} in studio/memory/failures.md)`,
    ...(l.newest.length ? l.newest.map((h) => `- ${h}`) : ['- None yet.']),
    '',
    '## The overseer\'s latest evaluations',
    ...(l.evals.length ? l.evals.map((e) => `- ${e}`) : ['- None yet. The Producer adds one each session: `npm run notes -- add --kind eval "…"`.']),
    '',
    '## Harness notes',
    `- ${l.notes.well || 0} worked well, ${l.notes.bad || 0} didn't, ${l.notes.workaround || 0} workarounds, ${l.notes.upgrade || 0} upgrade ideas, ${l.notes.eval || 0} evaluations (studio/harness-notes/NOTES.md)`,
    '',
    '## Models',
    ...renderScorecard(l.scorecard).split('\n').map((x) => `    ${x}`),
    '',
    ...(l.scorecard.follow?.length ? ['## Skills given, loaded and followed (per model)', ...renderFollow(l.scorecard.follow).split('\n').map((x) => `    ${x}`), ''] : []),
  ].join('\n');
  fs.mkdirSync(path.join(REPO_ROOT, 'studio', 'memory'), { recursive: true });
  fs.writeFileSync(path.join(REPO_ROOT, 'studio', 'memory', 'LEARNED.md'), out);
  return { file: 'studio/memory/LEARNED.md', text: out };
}

/** Every file that holds what the studio learned or decided. */
export function learningFiles() {
  const files = ['studio/memory/failures.md', 'studio/memory/LEARNED.md', 'studio/data-consent.json', 'studio/harness-notes/NOTES.md', 'studio/producer/LOG.md', 'studio/producer/INBOX.md', 'studio/PLAN.md', 'studio/VISION_LOCK.md', 'studio/bible/BIBLE.md', 'studio/bible/bible.json', 'studio/bible/NOT-DOING.md', 'studio/bible/STORYBOARD.md'];
  for (const dir of ['studio/memory/retros', 'studio/decisions', 'studio/bible/reviews', 'studio/bible/ideas', 'studio/meetings', 'studio/reviews', 'studio/references', 'studio/experiments']) {
    const full = path.join(REPO_ROOT, dir);
    if (fs.existsSync(full)) for (const f of fs.readdirSync(full)) if (/\.(md|json)$/.test(f)) files.push(`${dir}/${f}`);
  }
  // The raw material for any later export or study: the event log, task briefs and the last gate run.
  // They live in .studio/ (never committed), so the backup is their only copy off this machine.
  files.push('.studio/events.jsonl', '.studio/gates-last.json');
  const briefs = path.join(REPO_ROOT, '.studio', 'briefs');
  if (fs.existsSync(briefs)) for (const f of fs.readdirSync(briefs)) if (f.endsWith('.md')) files.push(`.studio/briefs/${f}`);
  return files.filter((f) => fs.existsSync(path.join(REPO_ROOT, f)));
}

const MEDIA = /\.(png|jpe?g|webp|gif)$/i;
const MEDIA_KEEP = Number(process.env.STUDIO_BACKUP_MEDIA || 20);
const MEDIA_MAX_BYTES = 5 * 1024 * 1024;
const REPORTS_KEEP = 50;
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const stampNow = () => new Date().toISOString().replace(/[:.]/g, '-');

/** Playtest reports and screenshots: the newest ones only, so a long project doesn't fill the drive. */
export function mediaFiles() {
  const dir = path.join(REPO_ROOT, 'qa', 'reports');
  if (!fs.existsSync(dir)) return [];
  const all = fs.readdirSync(dir).map((f) => ({ f: `qa/reports/${f}`, m: fs.statSync(path.join(dir, f)).mtimeMs, size: fs.statSync(path.join(dir, f)).size })).sort((a, b) => b.m - a.m);
  const reports = all.filter((x) => /\.(md|json)$/.test(x.f)).slice(0, REPORTS_KEEP);
  const shots = all.filter((x) => MEDIA.test(x.f) && x.size <= MEDIA_MAX_BYTES).slice(0, MEDIA_KEEP);
  return [...reports, ...shots].map((x) => x.f);
}

function studioSlug() {
  let title = null;
  try {
    title = JSON.parse(read('studio/bible/bible.json')).answers.title;
  } catch {
    title = null;
  }
  return { title, slug: String(title || path.basename(REPO_ROOT)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'studio' };
}

const dirBytes = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? dirBytes(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0) : 0);

/**
 * Back up into one folder per studio that only grows by what changed:
 *   <dest>/latest/          plain copies of today's files plus STUDIO-MEMORY.md (open anywhere)
 *   <dest>/history/<at>.json   which file had which content at each backup (a few KB each)
 *   <dest>/objects/ab/<sha>    each distinct file content once, gzipped when that helps
 * A file that didn't change since the last backup costs nothing. Restore any point with `restore`.
 */
export function backup(to = process.env.STUDIO_BACKUP_DIR, { media = true } = {}) {
  if (!to) return { ok: false, message: 'Say where: --to <folder>, or set STUDIO_BACKUP_DIR (a Google Drive, Dropbox or OneDrive folder on this computer works).' };
  writeLearned();
  const { title, slug } = studioSlug();
  const dest = path.join(path.resolve(to), slug);
  const files = [...learningFiles(), ...(media ? mediaFiles() : [])];
  const manifest = { kind: 'studio.backup', studio: title || slug, at: new Date().toISOString(), files: {} };
  let added = 0;
  let addedBytes = 0;
  for (const f of files) {
    const buf = fs.readFileSync(path.join(REPO_ROOT, f));
    const h = sha(buf);
    manifest.files[f] = { sha256: h, bytes: buf.length };
    const objDir = path.join(dest, 'objects', h.slice(0, 2));
    const exists = ['.gz', ''].some((ext) => fs.existsSync(path.join(objDir, h + ext)));
    if (!exists) {
      const gz = zlib.gzipSync(buf, { level: 9 });
      const [body, ext] = gz.length < buf.length * 0.9 ? [gz, '.gz'] : [buf, ''];
      fs.mkdirSync(objDir, { recursive: true });
      fs.writeFileSync(path.join(objDir, h + ext), body);
      added += 1;
      addedBytes += body.length;
    }
    const latest = path.join(dest, 'latest', f);
    if (!fs.existsSync(latest) || sha(fs.readFileSync(latest)) !== h) {
      fs.mkdirSync(path.dirname(latest), { recursive: true });
      fs.writeFileSync(latest, buf);
    }
  }
  // latest/ mirrors today: files that are gone are removed from it (history still has them).
  const keep = new Set(Object.keys(manifest.files).map((f) => path.join(dest, 'latest', f)));
  const prune = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) prune(full);
      else if (!keep.has(full) && e.name !== 'STUDIO-MEMORY.md') fs.rmSync(full);
    }
  };
  prune(path.join(dest, 'latest'));
  const combined = [`# Studio memory: ${title || slug}`, '', `Backed up ${manifest.at} from ${files.length} files.`, ''];
  for (const f of files.filter((x) => x.endsWith('.md') && !x.startsWith('.studio/') && !x.startsWith('qa/reports/'))) combined.push('', '---', '', `<!-- ${f} -->`, '', read(f).replace(/^# /m, `# ${f}: `));
  fs.mkdirSync(path.join(dest, 'latest'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'latest', 'STUDIO-MEMORY.md'), combined.join('\n'));
  fs.mkdirSync(path.join(dest, 'history'), { recursive: true });
  const historyFile = path.join(dest, 'history', `${stampNow()}.json`);
  fs.writeFileSync(historyFile, JSON.stringify(manifest));
  const total = dirBytes(dest);
  emitEvent({ type: 'learn.backup', agent: 'watch', msg: `Backed up ${files.length} files to ${dest} (${added} new, +${Math.round(addedBytes / 1024)} KB; store ${Math.round(total / 1024)} KB)` });
  return { ok: true, dest, files: files.length, added, addedBytes, totalBytes: total, history: path.basename(historyFile, '.json') };
}

/** Put the studio's learning files back as they were at one backup (or the newest). */
export function restore({ from = process.env.STUDIO_BACKUP_DIR, at = 'latest', to } = {}) {
  if (!from || !to) return { ok: false, message: 'Say where from and where to: restore --from <backup folder> --to <empty folder> [--at <time>]' };
  const { slug } = studioSlug();
  const base = fs.existsSync(path.join(from, 'history')) ? path.resolve(from) : path.join(path.resolve(from), slug);
  const hist = fs.existsSync(path.join(base, 'history')) ? fs.readdirSync(path.join(base, 'history')).filter((f) => f.endsWith('.json')).sort() : [];
  if (!hist.length) return { ok: false, message: `No backups in ${base}` };
  const pick = at === 'latest' ? hist.at(-1) : hist.find((f) => f.startsWith(at));
  if (!pick) return { ok: false, message: `No backup at ${at}. There are: ${hist.map((h) => h.replace('.json', '')).join(', ')}` };
  const m = JSON.parse(fs.readFileSync(path.join(base, 'history', pick), 'utf8'));
  for (const [f, { sha256: h }] of Object.entries(m.files)) {
    const gz = path.join(base, 'objects', h.slice(0, 2), `${h}.gz`);
    const raw = path.join(base, 'objects', h.slice(0, 2), h);
    const buf = fs.existsSync(gz) ? zlib.gunzipSync(fs.readFileSync(gz)) : fs.readFileSync(raw);
    if (sha(buf) !== h) return { ok: false, message: `${f}: the stored copy is damaged (SHA-256 mismatch)` };
    fs.mkdirSync(path.dirname(path.join(to, f)), { recursive: true });
    fs.writeFileSync(path.join(to, f), buf);
  }
  return { ok: true, at: pick.replace('.json', ''), files: Object.keys(m.files).length, to: path.resolve(to) };
}

/** Keep the newest `keep` backups plus the first of each month; delete content nothing points to. */
export function pruneBackups({ from = process.env.STUDIO_BACKUP_DIR, keep = 30 } = {}) {
  if (!from) return { ok: false, message: 'Say where: --from <backup folder>, or set STUDIO_BACKUP_DIR.' };
  const { slug } = studioSlug();
  const base = fs.existsSync(path.join(from, 'history')) ? path.resolve(from) : path.join(path.resolve(from), slug);
  const hdir = path.join(base, 'history');
  if (!fs.existsSync(hdir)) return { ok: false, message: `No backups in ${base}` };
  const hist = fs.readdirSync(hdir).filter((f) => f.endsWith('.json')).sort();
  const monthly = new Set();
  const kept = hist.filter((f, i) => {
    const month = f.slice(0, 7);
    const firstOfMonth = !monthly.has(month);
    monthly.add(month);
    return i >= hist.length - keep || firstOfMonth;
  });
  for (const f of hist.filter((x) => !kept.includes(x))) fs.rmSync(path.join(hdir, f));
  const live = new Set(kept.flatMap((f) => Object.values(JSON.parse(fs.readFileSync(path.join(hdir, f), 'utf8')).files).map((x) => x.sha256)));
  let freed = 0;
  const odir = path.join(base, 'objects');
  for (const sub of fs.existsSync(odir) ? fs.readdirSync(odir) : []) {
    for (const o of fs.readdirSync(path.join(odir, sub))) {
      if (!live.has(o.replace(/\.gz$/, ''))) {
        freed += fs.statSync(path.join(odir, sub, o)).size;
        fs.rmSync(path.join(odir, sub, o));
      }
    }
  }
  return { ok: true, removed: hist.length - kept.length, kept: kept.length, freedBytes: freed, totalBytes: dirBytes(base) };
}

/** Once a day from the HUB: rewrite LEARNED.md, and back up if STUDIO_BACKUP_DIR is set. */
export function learnIfDue() {
  const today = new Date().toISOString().slice(0, 10);
  if (readRecentEvents(5000).some((e) => e.type === 'learn.written' && String(e.ts).startsWith(today))) return null;
  let cycle = null;
  try {
    cycle = learnCycle();
  } catch {
    // grading and the ladder are a help, never a blocker for the daily page
  }
  const w = writeLearned();
  emitEvent({ type: 'learn.written', agent: 'watch', msg: 'Rewrote studio/memory/LEARNED.md' });
  const b = process.env.STUDIO_BACKUP_DIR ? backup() : null;
  // Daily backups for a year would be 365 small manifests; keep 60 plus one a month, and drop content nothing uses.
  if (b?.ok) pruneBackups({ keep: Number(process.env.STUDIO_BACKUP_KEEP || 60) });
  return { file: w.file, backup: b?.dest || null, cycle };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const done = (res, line) => {
    if (!res.ok) {
      console.error(res.message);
      process.exit(1);
    }
    console.log(line(res));
    process.exit(0);
  };
  if (argv[0] === 'backup') done(backup(flag('to'), { media: !argv.includes('--no-media') }), (r) => `Backed up ${r.files} files to ${r.dest}: ${r.added} changed (+${kb(r.addedBytes)}), whole backup ${kb(r.totalBytes)}. Open latest/STUDIO-MEMORY.md for everything in one file.`);
  if (argv[0] === 'restore') done(restore({ from: flag('from'), at: flag('at') || 'latest', to: flag('to') }), (r) => `Restored ${r.files} files from the backup at ${r.at} into ${r.to}`);
  if (argv[0] === 'prune') done(pruneBackups({ from: flag('from'), keep: Number(flag('keep') || 30) }), (r) => `Kept ${r.kept} backups (the newest and the first of each month), removed ${r.removed}, freed ${kb(r.freedBytes)}; backup is now ${kb(r.totalBytes)}.`);
  if (argv[0] === 'change') {
    const sub = argv[1] || 'list';
    const all = (k) => argv.flatMap((a, i) => (a === `--${k}` && argv[i + 1] !== undefined ? [argv[i + 1]] : []));
    if (sub === 'add') {
      const r = addChange({ kind: flag('kind'), target: flag('target'), signatures: all('signature'), expect: flag('expect'), risk: flag('risk'), revert: flag('revert'), commit: flag('commit') || null, title: flag('title') || null, by: flag('by') || undefined });
      if (!r.ok) {
        console.error(r.message);
        process.exit(1);
      }
      console.log(argv.includes('--json') ? JSON.stringify(r.change, null, 2) : `Recorded ${r.change.id} in studio/changes/${r.change.id}.json (commit it with the change). npm run learn grades it after the next tasks.`);
      process.exit(0);
    }
    if (sub === 'eval') {
      const events = readRecentEvents(50000);
      const res = evaluateChanges({ events, typeOf: boardTypes(events) });
      console.log(argv.includes('--json') ? JSON.stringify(res, null, 2) : res.length ? res.map((x) => `${x.id}: ${x.verdict}${x.proposal ? ` (revert asked in ${x.proposal})` : ''}`).join('\n') : 'No change record is due.');
      process.exit(0);
    }
    const cs = readChanges();
    console.log(argv.includes('--json') ? JSON.stringify(cs, null, 2) : cs.length ? cs.map(changeLine).join('\n') : 'No change records yet.');
    process.exit(0);
  }
  const cycle = argv.includes('--no-cycle') ? null : learnCycle();
  const l = buildLearned();
  const w = writeLearned(l);
  if (cycle && !argv.includes('--json')) for (const x of [...cycle.changes.map((c) => `change ${c.id}: ${c.verdict}${c.proposal ? `, revert asked in ${c.proposal}` : ''}`), ...cycle.ladder.map((f) => `ladder: ${f.task} makes ${f.signature}'s lesson a check`)]) console.error(`[learn] ${x}`);
  if (argv.includes('--json')) console.log(JSON.stringify(l, null, 2));
  else console.log(w.text);
}
