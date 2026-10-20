#!/usr/bin/env node
/**
 * harness/learn.mjs — what the studio has learned, whether it stuck, and a safe copy of it all.
 *
 *   npm run learn                       write studio/memory/LEARNED.md and print the summary
 *   npm run learn -- backup [--to <folder>] [--no-media]   back up every learning file (only what changed)
 *   npm run learn -- restore --from <folder> --to <empty folder> [--at <time>]
 *   npm run learn -- prune [--from <folder>] [--keep 30]   keep the newest 30 and the first of each month
 *
 * A script: no model, no tokens. It joins the studio's memory into one page:
 *   - lessons from fixed bugs (studio/memory/failures.md) and the newest ones,
 *   - what keeps happening: the same failure on two or more days, and the lesson it matches if
 *     one exists (a lesson that didn't stick),
 *   - retro suggestions raised again and again without being handled,
 *   - the overseer's evaluations and the harness notes,
 *   - models by bugs per 10 points.
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
import { buildScorecard, renderScorecard } from './scorecard.mjs';
import { RETRO_DIR } from './retro.mjs';

const read = (rel) => {
  try {
    return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return '';
  }
};
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'task', 'tasks', 'after', 'since', 'when', 'not', 'was', 'has', 'have', 'its', 'are', 'but', 'agent']);
const keywords = (s) => [...new Set(String(s).toLowerCase().match(/[a-z][a-z-]{3,}/g) || [])].filter((w) => !STOP.has(w));

/** A failure's shape without the parts that change every time (ids, numbers, hashes, names in quotes). */
export function signature(msg) {
  return String(msg || '')
    .toLowerCase()
    .replace(/\b[0-9a-f]{12,}\b/g, '#')
    .replace(/\b(t|bug|reg|i|x)-[\w-]+/g, '#')
    .replace(/\d+(\.\d+)?/g, '#')
    .replace(/"[^"]*"|`[^`]*`/g, '"…"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

export function lessons() {
  const text = read('studio/memory/failures.md');
  return (text.split('## Recorded Distilled Notes')[1] || '')
    .split(/^### /m)
    .slice(1)
    .map((l) => ({ heading: l.split('\n')[0].trim(), body: l, words: keywords(l) }));
}

/** The same failure on two or more days. */
export function repeats(events = readRecentEvents(50000)) {
  const KINDS = /^(closedloop\.(retry|escalate)|task\.not_done|task\.forced|task\.reopened|route\.exhausted|watch\.alert|task\.refused)$/;
  const groups = new Map();
  for (const e of events) {
    if (!KINDS.test(e.type || '') || !e.msg) continue;
    const sig = `${e.type}: ${signature(e.msg)}`;
    const g = groups.get(sig) || { sig, type: e.type, sample: e.msg, days: new Set(), count: 0 };
    g.days.add(String(e.ts).slice(0, 10));
    g.count += 1;
    groups.set(sig, g);
  }
  const L = lessons();
  return [...groups.values()]
    .filter((g) => g.days.size >= 2)
    .map((g) => {
      const w = keywords(g.sample);
      const lesson = L.map((l) => ({ l, hits: w.filter((x) => l.words.includes(x)).length })).filter((x) => x.hits >= 2).sort((a, b) => b.hits - a.hits)[0]?.l || null;
      return { type: g.type, sample: g.sample, days: [...g.days].sort(), count: g.count, lesson: lesson?.heading || null };
    })
    .sort((a, b) => b.days.length - a.days.length || b.count - a.count);
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
  return { at: new Date().toISOString(), lessons: L.length, newest: L.slice(-5).map((l) => l.heading).reverse(), repeats: rep, stale, evals: (notes.eval || []).slice(0, 5), notes: Object.fromEntries(Object.entries(notes).map(([k, v]) => [k, v.length])), scorecard: sc };
}

export function writeLearned(l = buildLearned()) {
  const out = [
    '# What the studio has learned (`studio/memory/LEARNED.md`)',
    '',
    `> Written by \`npm run learn\` at ${l.at.slice(0, 16).replace('T', ' ')} UTC from the studio's own files. No model wrote this. The HUB rewrites it daily.`,
    '',
    '## Keeps happening',
    ...(l.repeats.length ? l.repeats.slice(0, 10).map((r) => `- ${r.type} on ${r.days.length} days (${r.days.at(-1)} last, ${r.count} times): ${r.sample}${r.lesson ? `\n  - There is a lesson for this, and it didn't stick: "${r.lesson}". Make it a check, or put it earlier in the skill.` : '\n  - No lesson covers it yet. The next fix should write one.'}`) : ['- Nothing has repeated on two different days.']),
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
  const w = writeLearned();
  emitEvent({ type: 'learn.written', agent: 'watch', msg: 'Rewrote studio/memory/LEARNED.md' });
  const b = process.env.STUDIO_BACKUP_DIR ? backup() : null;
  // Daily backups for a year would be 365 small manifests; keep 60 plus one a month, and drop content nothing uses.
  if (b?.ok) pruneBackups({ keep: Number(process.env.STUDIO_BACKUP_KEEP || 60) });
  return { file: w.file, backup: b?.dest || null };
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
  const l = buildLearned();
  const w = writeLearned(l);
  if (argv.includes('--json')) console.log(JSON.stringify(l, null, 2));
  else console.log(w.text);
}
