/**
 * harness/research.mjs — 2.71.0 (y): the research job type (overseer duty 16, the paperwork only).
 *
 *   npm run task -- add "<question>" --type research [--role …]
 *
 * The crew's overseer wrote its research up by hand, with no fixed shape and sometimes no sources. A research task's
 * title starts "Research:" (the --type adds it). Its write-up goes to docs/research/<ID>.md, or to the game's own docs
 * folder (game/<name>/docs/research/<ID>.md) when the game has one. `task start` writes the template there when the
 * file doesn't exist yet: the question, sources with links, findings, what is UNVERIFIED, a recommendation.
 * `task done` refuses the task while the write-up has no Sources section, or no link (http(s)://…) in it; a missing
 * write-up gets the template written and is refused. Nothing else is checked: research is paperwork (no verify).
 * The digest lists research finished in the last 24 h with its file and the first line of its recommendation.
 * The research itself (reading, browsing) stays with whoever does the task; this file never fetches anything.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './event.mjs';

const DAY = 86400000;
export const RESEARCH_TITLE = /^research\b/i;

/** Where a task's write-up lives (relative, forward slashes). */
export function researchRel(id, root = REPO_ROOT) {
  let game = process.env.STUDIO_GAME || null;
  if (!game) { try { game = JSON.parse(fs.readFileSync(path.join(root, 'studio', 'game.json'), 'utf8')).game || null; } catch { game = null; } }
  const safe = String(game || '').replace(/[^\w.-]/g, '');
  if (safe) for (const base of [`game/${safe}/docs`, `web/${safe}/docs`]) if (fs.existsSync(path.join(root, base))) return `${base}/research/${id}.md`;
  return `docs/research/${id}.md`;
}

/** The template a research task starts from. No link in it: a Sources section with only the placeholder fails. */
export function researchTemplate(task) {
  const q = String(task?.title || '').replace(RESEARCH_TITLE, '').replace(/^[\s:—-]+/, '').trim() || '(the one question this answers)';
  return `# ${task?.id || 'T-?'} research: ${q}

## Question
${q}

## Sources
<!-- One line each: what it is, its link (https://…), and when you read it. At least one link; done refuses without. -->
- (source title): (link), read (date)

## Findings
<!-- What the sources say, each finding naming the source it comes from. -->

## Unverified
<!-- What you could not confirm from a source (a guess, one forum post, an untested claim). Write "none" if none. -->

## Recommendation
<!-- What to do next, in one or two lines, and the tasks it leads to. -->
`;
}

/** Write the template when the write-up doesn't exist yet. Returns the relative path, or null when it existed. */
export function ensureResearchTemplate(task, root = REPO_ROOT) {
  const rel = researchRel(task.id, root);
  const file = path.join(root, rel);
  if (fs.existsSync(file)) return null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, researchTemplate(task));
  return rel;
}

/** A section's text (until the next heading of the same or a higher level), or null when there is none. */
export function sectionOf(text, name) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const i = lines.findIndex((l) => new RegExp(`^#{1,4}\\s*${name}\\b`, 'i').test(l.trim()));
  if (i === -1) return null;
  const level = (lines[i].match(/^#+/) || ['##'])[0].length;
  const out = [];
  for (const l of lines.slice(i + 1)) { const h = l.match(/^(#+)\s/); if (h && h[1].length <= level) break; out.push(l); }
  return out.join('\n').replace(/<!--[\s\S]*?-->/g, '');
}

/** The write-up's checks: { file, exists, sources, links, ok, why }. */
export function checkResearch(task, root = REPO_ROOT) {
  const rel = researchRel(task.id, root);
  let text = null;
  try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { text = null; }
  if (text === null) return { file: rel, exists: false, sources: false, links: 0, ok: false, why: `no write-up at ${rel}` };
  const src = sectionOf(text, 'Sources');
  const links = src === null ? 0 : (src.match(/https?:\/\/[^\s)>\]]+/g) || []).length;
  const why = src === null ? `${rel} has no "## Sources" section` : links === 0 ? `the Sources section of ${rel} has no link (https://…)` : null;
  return { file: rel, exists: true, sources: src !== null, links, ok: !why, why };
}

/** Research tasks finished in the last 24 h, for the digest: one line, or ''. */
export function researchDigestLine(ev, { now = Date.now(), root = REPO_ROOT } = {}) {
  const typed = new Set(ev.filter((e) => e.type === 'task.added' && e.task && (e.meta?.type === 'research' || /\):\s*research\b/i.test(String(e.msg || '')))).map((e) => e.task));
  const done = [];
  for (const e of ev) {
    if (e.type !== 'task.done' || !e.task || (Date.parse(e.ts) || 0) < now - DAY) continue;
    if (!typed.has(e.task) && !/\bresearch\b/i.test(String(e.meta?.title || ''))) continue;
    if (!done.includes(e.task)) done.push(e.task);
  }
  if (!done.length) return '';
  const items = done.slice(0, 3).map((id) => {
    const rel = researchRel(id, root);
    let rec = '';
    try { rec = (sectionOf(fs.readFileSync(path.join(root, rel), 'utf8'), 'Recommendation') || '').split('\n').map((l) => l.trim()).find(Boolean) || ''; } catch { rec = ''; }
    const w = rec.split(/\s+/).filter(Boolean);
    return `${id} ${rel}${rec ? ` ("${w.slice(0, 12).join(' ')}${w.length > 12 ? '…' : ''}")` : ''}`;
  });
  return `New research (${done.length} in 24 h): ${items.join('; ')}${done.length > 3 ? ` +${done.length - 3} more` : ''}.`;
}
