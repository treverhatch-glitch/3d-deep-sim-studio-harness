#!/usr/bin/env node
/**
 * harness/pitfalls.mjs — "pitfalls seen here": one-line rules for this game that every agent reads.
 *
 *   npm run pitfall -- "never put the hotel's ceiling texture on the office floors" [--by <name>]
 *   npm run pitfall                 the list
 *   npm run pitfall -- remove 3     drop line 3 (a person, or the Producer, when it no longer holds)
 *
 * The fix for "the AI forgot what I asked": the rule lives in a file every agent's prompt includes
 * (studio/PITFALLS.md), not in a chat. A harness note of kind "bad" that reads as a rule ("don't…",
 * "never…", "always…", "must…", "avoid…") is added here too. SendIt kept the same list in its AGENTS.md,
 * and every mistake there became a line. The list keeps the newest 40; older ones move to the archive.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, actor, emitEvent } from './event.mjs';

export const PITFALLS = path.join(REPO_ROOT, 'studio', 'PITFALLS.md');
const ARCHIVE = path.join(REPO_ROOT, 'studio', 'PITFALLS-ARCHIVE.md');
const KEEP = 40;
const HEAD = '# Pitfalls seen here (`studio/PITFALLS.md`)\n\n> One-line rules for this game, learned the hard way. Every agent reads this list in its prompt. Add one with `npm run pitfall -- "never …"`; drop one that no longer holds with `npm run pitfall -- remove <n>`.\n\n';
export const RULE = /\b(don'?t|do not|never|always|must|avoid|only ever)\b/i;

export function readPitfalls() {
  if (!fs.existsSync(PITFALLS)) return [];
  return fs.readFileSync(PITFALLS, 'utf8').split('\n').filter((l) => /^- /.test(l)).map((l) => l.slice(2));
}
function write(lines) {
  fs.mkdirSync(path.dirname(PITFALLS), { recursive: true });
  const keep = lines.slice(-KEEP);
  const old = lines.slice(0, -KEEP);
  if (old.length) fs.appendFileSync(ARCHIVE, `${old.map((l) => `- ${l}`).join('\n')}\n`);
  fs.writeFileSync(PITFALLS, `${HEAD}${keep.map((l) => `- ${l}`).join('\n')}\n`);
}

export function addPitfall(text, by = actor()) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  if (!t) return { ok: false, message: 'Say the rule in one line: npm run pitfall -- "never …".' };
  const lines = readPitfalls();
  const norm = (x) => x.toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').replace(/[^a-z0-9 ]/g, '').trim();
  if (lines.some((l) => norm(l) === norm(t))) return { ok: true, duplicate: true };
  lines.push(`${t} (${by}, ${new Date().toISOString().slice(0, 10)})`);
  write(lines);
  emitEvent({ type: 'pitfall.added', agent: by, msg: `Pitfall: ${t}` });
  return { ok: true };
}

export function removePitfall(n, by = actor()) {
  const lines = readPitfalls();
  const i = Number(n) - 1;
  if (!(i >= 0 && i < lines.length)) return { ok: false, message: `No pitfall ${n} (there are ${lines.length}).` };
  const [gone] = lines.splice(i, 1);
  write(lines);
  emitEvent({ type: 'pitfall.removed', agent: by, msg: `Pitfall removed: ${gone}` });
  return { ok: true, gone };
}

/** The block every agent's prompt carries (empty when there are none). */
export function pitfallsForPrompt() {
  const lines = readPitfalls();
  return lines.length ? `\nPitfalls seen in this game (studio/PITFALLS.md); follow them:\n${lines.map((l) => `- ${l}`).join('\n')}\n` : '';
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  if (argv[0] === 'remove') {
    const r = removePitfall(argv[1], flag('by') || actor());
    console[r.ok ? 'log' : 'error'](r.ok ? `Removed: ${r.gone}` : r.message);
    process.exit(r.ok ? 0 : 1);
  }
  const text = argv.filter((x, i) => !x.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--'))).join(' ');
  if (text) {
    const r = addPitfall(text, flag('by') || actor());
    console[r.ok ? 'log' : 'error'](r.ok ? (r.duplicate ? 'Already on the list.' : 'Added to studio/PITFALLS.md; every agent reads it from its next session.') : r.message);
    process.exit(r.ok ? 0 : 1);
  }
  const lines = readPitfalls();
  console.log(lines.length ? lines.map((l, i) => `${i + 1}. ${l}`).join('\n') : 'No pitfalls yet. npm run pitfall -- "never …"');
}
