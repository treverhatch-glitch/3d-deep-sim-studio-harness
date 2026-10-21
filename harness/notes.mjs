#!/usr/bin/env node
/**
 * harness/notes.mjs — notes about the harness itself, not the game: what worked, what didn't, the
 * workarounds in use, and upgrade ideas. They survive `npm run studio:reset`, so every new project
 * (and every new Producer) starts with what the last ones learned about running the studio.
 *
 *   npm run notes -- add --kind well|bad|workaround|upgrade|eval "text" [--agent name] [--track web|engine:godot]
 *   (eval: the overseer's evaluation of a session or run: what worked, what didn't, a score, what to change)
 *   npm run notes -- list [--kind bad]
 *   npm run notes -- export          markdown to bring back upstream (harness only: no game code or data)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, actor, emitEvent } from './event.mjs';

export const NOTES_FILE = path.join(REPO_ROOT, 'studio', 'harness-notes', 'NOTES.md');
export const KINDS = { well: 'Worked well', bad: "Didn't work", workaround: 'Workarounds in use', upgrade: 'Upgrade ideas', eval: 'Overseer evaluations' };

const HEADER = `# Harness notes (\`studio/harness-notes/NOTES.md\`)

> About the harness, not the game: what worked, what didn't, workarounds in use, and upgrade ideas.
> The Producer adds to it (\`npm run notes -- add --kind … "…"\`); \`npm run studio:reset\` keeps it, so
> each project starts with what the last one learned. \`npm run notes -- export\` turns it into
> something to bring back to the public harness.
`;

export function readNotes() {
  const text = fs.existsSync(NOTES_FILE) ? fs.readFileSync(NOTES_FILE, 'utf8').replace(/\r\n/g, '\n') : '';
  const out = Object.fromEntries(Object.keys(KINDS).map((k) => [k, []]));
  for (const [kind, title] of Object.entries(KINDS)) {
    const m = text.match(new RegExp(`^## ${title.replace(/'/g, "'")}\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm'));
    if (m) out[kind] = m[1].split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
  }
  return out;
}

function writeNotes(notes) {
  const body = Object.entries(KINDS).map(([k, title]) => `## ${title}\n\n${notes[k].map((l) => `- ${l}`).join('\n') || '_Nothing yet._'}\n`).join('\n');
  fs.mkdirSync(path.dirname(NOTES_FILE), { recursive: true });
  fs.writeFileSync(NOTES_FILE, `${HEADER}\n${body}`);
}

export function addNote(kind, text, agent = actor(), track = process.env.STUDIO_TRACK || null) {
  if (!KINDS[kind]) throw new Error(`--kind must be one of: ${Object.keys(KINDS).join(', ')}`);
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) throw new Error('A note needs text.');
  const notes = readNotes();
  notes[kind].unshift(`[${new Date().toISOString().slice(0, 10)} · ${agent}${track ? ` · ${track}` : ''}] ${t}`);
  writeNotes(notes);
  emitEvent({ type: 'notes.add', agent, track, msg: `${KINDS[kind]}: ${t}`.slice(0, 160) });
  return notes;
}

export function exportNotes() {
  const n = readNotes();
  return [
    '## Harness feedback from a studio run',
    '',
    ...Object.entries(KINDS).flatMap(([k, title]) => (n[k].length ? [`### ${title}`, ...n[k].map((l) => `- ${l.replace(/^\[[^\]]*\]\s*/, '')}`), ''] : [])),
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'list';
  const val = (k) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : null;
  };
  if (cmd === 'add') {
    const skip = new Set(['add', val('kind'), val('agent'), val('track'), '--kind', '--agent', '--track']);
    const text = args.filter((a) => !skip.has(a)).join(' ');
    try {
      addNote(val('kind'), text, val('agent') || undefined, val('track') || undefined);
      console.log(`Added to studio/harness-notes/NOTES.md under "${KINDS[val('kind')]}"`);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  } else if (cmd === 'export') {
    console.log(exportNotes());
  } else {
    const n = readNotes();
    const only = val('kind');
    for (const [k, title] of Object.entries(KINDS)) {
      if (only && only !== k) continue;
      console.log(`${title} (${n[k].length})`);
      for (const l of n[k]) console.log(`  - ${l}`);
    }
  }
}
