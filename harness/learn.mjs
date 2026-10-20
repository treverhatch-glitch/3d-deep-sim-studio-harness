#!/usr/bin/env node
/**
 * harness/learn.mjs — what the studio has learned, whether it stuck, and a safe copy of it all.
 *
 *   npm run learn                       write studio/memory/LEARNED.md and print the summary
 *   npm run learn -- backup [--to <folder>]   copy every learning file to a dated folder
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
 * on your computer and the copy syncs off the machine). The HUB runs both once a day. Each backup is
 * a dated folder with the original files plus STUDIO-MEMORY.md, one file you can open anywhere or
 * import into a Google Doc.
 */
import fs from 'node:fs';
import path from 'node:path';
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
  const files = ['studio/memory/failures.md', 'studio/memory/LEARNED.md', 'studio/harness-notes/NOTES.md', 'studio/producer/LOG.md', 'studio/producer/INBOX.md', 'studio/PLAN.md', 'studio/VISION_LOCK.md', 'studio/bible/BIBLE.md', 'studio/bible/bible.json', 'studio/bible/NOT-DOING.md', 'studio/bible/STORYBOARD.md'];
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

export function backup(to = process.env.STUDIO_BACKUP_DIR) {
  if (!to) return { ok: false, message: 'Say where: --to <folder>, or set STUDIO_BACKUP_DIR (a Google Drive, Dropbox or OneDrive folder on this computer works).' };
  writeLearned();
  const title = (() => {
    try {
      return JSON.parse(read('studio/bible/bible.json')).answers.title;
    } catch {
      return null;
    }
  })();
  const slug = String(title || path.basename(REPO_ROOT)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'studio';
  const dest = path.join(path.resolve(to), `${slug}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`);
  const files = learningFiles();
  for (const f of files) {
    const target = path.join(dest, f);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, f), target);
  }
  const combined = [`# Studio memory: ${title || slug}`, '', `Backed up ${new Date().toISOString()} from ${files.length} files.`, ''];
  for (const f of files.filter((x) => x.endsWith('.md') && !x.startsWith('.studio/'))) combined.push('', `---`, '', `<!-- ${f} -->`, '', read(f).replace(/^# /m, `# ${f}: `));
  fs.writeFileSync(path.join(dest, 'STUDIO-MEMORY.md'), combined.join('\n'));
  emitEvent({ type: 'learn.backup', agent: 'watch', msg: `Backed up ${files.length} learning files to ${dest}` });
  return { ok: true, dest, files: files.length };
}

/** Once a day from the HUB: rewrite LEARNED.md, and back up if STUDIO_BACKUP_DIR is set. */
export function learnIfDue() {
  const today = new Date().toISOString().slice(0, 10);
  if (readRecentEvents(5000).some((e) => e.type === 'learn.written' && String(e.ts).startsWith(today))) return null;
  const w = writeLearned();
  emitEvent({ type: 'learn.written', agent: 'watch', msg: 'Rewrote studio/memory/LEARNED.md' });
  const b = process.env.STUDIO_BACKUP_DIR ? backup() : null;
  return { file: w.file, backup: b?.dest || null };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  if (argv[0] === 'backup') {
    const i = argv.indexOf('--to');
    const res = backup(i >= 0 ? argv[i + 1] : undefined);
    if (!res.ok) {
      console.error(res.message);
      process.exit(1);
    }
    console.log(`Backed up ${res.files} files to ${res.dest} (one-file copy: STUDIO-MEMORY.md)`);
    process.exit(0);
  }
  const l = buildLearned();
  const w = writeLearned(l);
  if (argv.includes('--json')) console.log(JSON.stringify(l, null, 2));
  else console.log(w.text);
}
