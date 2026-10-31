#!/usr/bin/env node
/**
 * harness/logs.mjs — U-004 (2.49.0): the studio logs' 2-minute read, from one command.
 *
 *   npm run logs              the latest summary, the open problems, the proposals waiting for the owner
 *   npm run logs -- --brief   three lines (for a chat post): counts and the newest open problem and proposal
 *
 * Reads studio/logs/ (README.md, PROBLEMS.md, PROPOSALS.md, WORK-LOG.md). It only reads: the logs are written by
 * the people and agents doing the work, in the formats at the top of each file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from './event.mjs';

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

/** Blocks that start with "### " in a log file: [{ id, title, status, body }]. */
export function blocks(text) {
  return String(text || '').split(/^### /m).slice(1).map((b) => {
    const head = b.split('\n')[0];
    const m = head.match(/^(\S+)\s+—\s+(.*?)\s+·\s+(.*)$/);
    return { id: m ? m[1] : head.split(' ')[0], title: m ? m[2] : head, status: m ? m[3].trim() : '', body: b.split('\n').slice(1).join('\n').trim() };
  });
}

export function readLogs(dir = path.join(REPO_ROOT, 'studio', 'logs')) {
  if (!fs.existsSync(dir)) return null;
  const readme = read(path.join(dir, 'README.md')) || '';
  const summary = (readme.match(/^## Latest summary[\s\S]*?(?=^## )/m) || [''])[0].trim();
  const problems = blocks(read(path.join(dir, 'PROBLEMS.md')));
  const proposals = blocks(read(path.join(dir, 'PROPOSALS.md')));
  const work = (read(path.join(dir, 'WORK-LOG.md')) || '').split('\n').filter((l) => /^\| \d{4}-\d\d-\d\d /.test(l));
  return {
    summary,
    open: problems.filter((p) => /^open/i.test(p.status)),
    waiting: proposals.filter((p) => /^waiting/i.test(p.status)),
    work,
  };
}

export function brief(l) {
  return [
    `Logs: ${l.work.length} task(s) logged · ${l.open.length} open problem(s) · ${l.waiting.length} proposal(s) waiting for the owner`,
    l.open.length ? `Newest open problem: ${l.open.at(-1).id} ${l.open.at(-1).title}` : 'Open problems: none',
    l.waiting.length ? `Waiting: ${l.waiting.map((p) => p.id).join(', ')}` : 'Waiting: nothing',
  ];
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const l = readLogs();
  if (!l) {
    console.log('[logs] no studio/logs/ folder yet: the logs start with the first task (docs/crew/LOGS.md in the game repo)');
    process.exit(0);
  }
  if (process.argv.includes('--brief')) {
    console.log(brief(l).join('\n'));
    process.exit(0);
  }
  console.log(l.summary || '## Latest summary\n(none yet)');
  console.log(`\n## Open problems (${l.open.length})`);
  for (const p of l.open) console.log(`- ${p.id} ${p.title}`);
  if (!l.open.length) console.log('- none');
  console.log(`\n## Proposals waiting for your OK (${l.waiting.length})`);
  for (const p of l.waiting) console.log(`- ${p.id} ${p.title}`);
  if (!l.waiting.length) console.log('- none');
}
