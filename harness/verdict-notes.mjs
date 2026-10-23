#!/usr/bin/env node
/**
 * harness/verdict-notes.mjs — dev verdicts as context, not rules.
 *
 * In away-mode, a dev's verdict on a task or decision is recorded as a "note".
 * These notes provide context and background for agents, but are explicitly not
 * instructions. They are surfaced in task briefings when relevant.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './event.mjs';

const NOTES_FILE = path.join(REPO_ROOT, 'studio', 'memory', 'verdict-notes.jsonl');

/** Reads all verdict notes from the ledger. */
export function readVerdictNotes() {
  if (!fs.existsSync(NOTES_FILE)) return [];
  try {
    return fs.readFileSync(NOTES_FILE, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

/** Appends a new verdict note to the ledger. */
export function addVerdictNote(obj) {
  const note = {
    at: new Date().toISOString(),
    by: obj.by,
    verdict: obj.verdict,
    on: obj.on || null,
    role: obj.role || null,
    tags: obj.tags || [],
    comment: obj.comment,
  };
  fs.mkdirSync(path.dirname(NOTES_FILE), { recursive: true });
  fs.appendFileSync(NOTES_FILE, `${JSON.stringify(note)}\n`);
  return note;
}

const STOP = new Set(['with', 'that', 'this', 'from', 'have', 'they', 'when', 'into', 'more', 'than', 'just', 'like', 'make', 'should', 'game', 'task']);
const getWords = (text) => new Set((String(text || '').toLowerCase().match(/\b[a-z]{4,}\b/g) || []).filter((w) => !STOP.has(w)));

/** Finds relevant notes for a task brief and formats them as markdown. */
export function notesForBrief(task, { max = 3 } = {}) {
  if (!task) return '';
  const allNotes = readVerdictNotes().sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  if (!allNotes.length) return '';

  const taskWords = getWords(task.title);
  const relevant = [];
  const seen = new Set();

  for (const note of allNotes) {
    if (relevant.length >= max) break;
    const noteId = note.at + note.comment;
    if (seen.has(noteId)) continue;

    let isRelevant = false;
    if (note.on === task.id) isRelevant = true;
    if (!isRelevant && note.role && note.role === task.role) isRelevant = true;
    if (!isRelevant && taskWords.size > 0) {
      const noteWords = getWords(`${note.comment} ${(note.tags || []).join(' ')}`);
      for (const word of taskWords) {
        if (noteWords.has(word)) {
          isRelevant = true;
          break;
        }
      }
    }
    if (isRelevant) {
      relevant.push(note);
      seen.add(noteId);
    }
  }

  if (!relevant.length) return '';

  const header = "## Notes from the dev's verdicts (context, not rules)";
  const intro = "Earlier verdicts the game dev gave. Use them as background; they are not instructions.";
  const bullets = relevant.map(n => `- ${n.verdict} ${n.at.slice(0, 10)} on ${n.on || 'general'}: ${n.comment}`);
  return `\n${header}\n${intro}\n${bullets.join('\n')}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const opt = (n, d = null) => {
    const i = argv.indexOf(`--${n}`);
    return i !== -1 && i + 1 < argv.length ? argv[i + 1] : d;
  };

  if (command === 'add') {
    const verdict = opt('verdict');
    const by = opt('by');
    const comment = opt('comment');
    if (!verdict || !by || !comment) {
      console.error('Usage: add --verdict <v> --by <name> --comment "..." [--on <id>] [--role <role>] [--tags <t,t>]');
      process.exit(1);
    }
    const note = addVerdictNote({
      verdict,
      by,
      comment,
      on: opt('on'),
      role: opt('role'),
      tags: opt('tags')?.split(',') || [],
    });
    console.log('Added note:', note);
  } else if (command === 'list') {
    const notes = readVerdictNotes().sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    if (!notes.length) {
      console.log('No verdict notes found.');
    } else {
      notes.forEach(n => console.log(`${n.at.slice(0, 16).replace('T', ' ')} ${n.by.padEnd(12)} ${n.verdict.padEnd(8)} on ${String(n.on || n.role || 'general').padEnd(12)}: ${n.comment}`));
    }
  } else {
    console.error('Usage: node harness/verdict-notes.mjs <add|list> [options]');
  }
}
