#!/usr/bin/env node
/**
 * scripts/studio-reset.mjs — start a fresh studio in your own (private) copy for a new game.
 *
 *   npm run studio:reset -- --name "Mini Farm"          show what would change
 *   npm run studio:reset -- --name "Mini Farm" --yes    do it
 *
 * Rewrites studio/PLAN.md, the Producer log, the queue and the checkpoint for the new game, and
 * clears the previous project's meetings, handoffs, game sheet, studies, reviews, retros and
 * sign-offs. Everything it removes is copied first to .studio/archive/<time>/ (gitignored), and the
 * event log moves there too. It keeps the harness itself: rules, skills, roles, gates, decisions
 * and the lessons in studio/memory/failures.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};
const name = opt('name');
if (!name) {
  console.error('Usage: npm run studio:reset -- --name "<game name>" [--yes]');
  process.exit(1);
}
const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'game';
const yes = args.includes('--yes');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const archive = path.join(root, '.studio', 'archive', stamp);
const rel = (p) => path.relative(root, p).replace(/\\/g, '/');

// Folders whose files belong to the previous project (README.md files stay).
const CLEAR = ['studio/meetings', 'studio/handoffs', 'studio/game', 'studio/research', 'studio/reviews', 'studio/memory/retros', 'studio/bible'];
const SIGNOFFS = [['studio/balance', /^decision-.*\.md$/], ['studio/fun', /^review-.*\.md$/], ['studio', /^PITFALLS(-ARCHIVE)?\.md$/]];
const REWRITE = ['studio/PLAN.md', 'studio/producer/LOG.md', 'studio/NEXT.md', 'studio/DONE.md', 'studio/CURRENT_TASK.md'];

const toRemove = [];
const walk = (dir) => {
  const full = path.join(root, dir);
  if (!fs.existsSync(full)) return;
  for (const e of fs.readdirSync(full, { withFileTypes: true })) {
    const p = path.join(full, e.name);
    if (e.isDirectory()) walk(rel(p));
    else if (e.name !== 'README.md') toRemove.push(p);
  }
};
for (const d of CLEAR) walk(d);
for (const [d, re] of SIGNOFFS) {
  const full = path.join(root, d);
  if (fs.existsSync(full)) for (const f of fs.readdirSync(full)) if (re.test(f)) toRemove.push(path.join(full, f));
}
const events = path.join(root, '.studio', 'events.jsonl');
// 2.58.0 (PU-41): the files the log rolled over into go to the archive too. Readers go on into them when the log is
// short, so left behind they would show the last project's tasks in the new one.
const rolledEvents = (() => {
  try {
    return fs.readdirSync(path.join(root, '.studio')).filter((f) => /^events-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.jsonl$/.test(f)).map((f) => path.join(root, '.studio', f));
  } catch {
    return [];
  }
})();

console.log(`[reset] fresh studio for "${name}"`);
console.log(`[reset] rewrite: ${REWRITE.join(', ')}`);
console.log(`[reset] clear ${toRemove.length} file(s) from the last project: ${toRemove.slice(0, 8).map(rel).join(', ')}${toRemove.length > 8 ? ', …' : ''}`);
console.log(`[reset] keep: rules, skills, roles, gates, decisions, studio/memory/failures.md, cartridges`);
if (!yes) {
  console.log('[reset] nothing changed. Add --yes to do it (everything removed is archived to .studio/archive/ first).');
  process.exit(0);
}

// Archive, then clear.
for (const f of [...toRemove, ...REWRITE.map((r) => path.join(root, r)), events]) {
  if (!fs.existsSync(f)) continue;
  const dest = path.join(archive, rel(f));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(f, dest);
}
for (const f of toRemove) fs.rmSync(f, { force: true });
if (fs.existsSync(events)) fs.rmSync(events);
for (const f of rolledEvents) {
  const dest = path.join(archive, rel(f));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(f, dest); // moved, not copied: these can be 25 MB each
  } catch {
    try {
      fs.copyFileSync(f, dest);
      fs.rmSync(f, { force: true });
    } catch (err) {
      console.warn(`[reset] could not move ${rel(f)} to the archive (${err.code || err.message}); delete it by hand`);
    }
  }
}
fs.rmSync(path.join(root, '.studio', 'locks'), { recursive: true, force: true });
for (const f of ['meeting.json', 'watch-last.json', 'gates-last.json', 'gates-last-full.json', 'last-seed-failure.json', 'closed-loop-state.json']) fs.rmSync(path.join(root, '.studio', f), { force: true });

const date = new Date();
const p = (n) => String(n).padStart(2, '0');
const when = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
const write = (r, text) => {
  fs.mkdirSync(path.dirname(path.join(root, r)), { recursive: true });
  fs.writeFileSync(path.join(root, r), text);
};

write('studio/PLAN.md', `# Master plan (\`studio/PLAN.md\`)

> Owned by the Producer. Keep it to a page: the long reasoning goes in \`studio/decisions/\` and
> \`studio/producer/LOG.md\`.

## Goal

_${name}: what the finished game is, in one or two sentences._

## Now

- **Phase**: 0, set up.
- **Focus**: scaffold the cartridge, fill in the fact sheet, first seeded playtest.
- **Blocked on**: nothing.

## Milestones

| # | Milestone | Done means | Status |
| --- | --- | --- | --- |
| M0 | Pre-production | Intake answered, Game Bible signed by a person (studio/bible/) | next |
| M1 | Playable core loop | The vertical slice wins and loses on purpose, goldens recorded | later |
| M2 | First content pass | _…_ | later |
| M3 | Release candidate | Every required gate green, a person signed off balance and fun | later |

## Risks and open questions

- _…_

## Not doing yet

- _…_
`);
write('studio/producer/LOG.md', `# Producer log (\`studio/producer/LOG.md\`)

> The Producer's notebook, newest first. One entry per session or decision: what changed, why,
> and what the next Producer should do. Add one with \`node harness/handoff.mjs note "…"\`.
> This is how a new Producer (another model, another tool) learns the reasons behind the plan.

## ${when} · studio-reset
Fresh studio for ${name}. The previous project's notes are archived in ${rel(archive)}. Next: the
game intake with a person (npm run intake), which writes the Game Bible and queues pre-production;
build tasks wait until a person signs it. Meanwhile scaffold the cartridge (npm run new-game ${slug}).
`);
write('studio/NEXT.md', `# Studio Task Queue (\`studio/NEXT.md\`)

> Managed by \`node harness/task.mjs\`. One line per task so agents and the Zero-Token HUB can parse it without context bloat.

## IN_PROGRESS
_No task currently in progress. Run \`node harness/task.mjs next\`._

## BACKLOG
- [ ] **T-001** [P0] (\`human\`) — Answer the game intake for ${name}: \`npm run intake\` (play length first; a 15 to 30 minute demo is the easiest start)
- [ ] **T-002** [P0] (\`producer\`) — Docs: write the goal and milestones for ${name} in \`studio/PLAN.md\` with a person
- [ ] **T-003** [P1] (\`builder\`) — Prototype: scaffold the ${name} cartridge (\`npm run new-game ${slug}\`) and get \`npm run verify\` green
- [ ] **T-004** [P1] (\`qa-playtester\`) — Playtest: first seeded run of ${name} and read the report
- [ ] **T-005** [P2] (\`reviewer\`) — Review: read the first merge and write a note in \`studio/reviews/\`

## DONE
_Finished tasks are in \`studio/DONE.md\` (newest first). This file keeps only open work._
`);
write('studio/DONE.md', `# Finished tasks (\`studio/DONE.md\`)

> Managed by \`node harness/task.mjs\`. Newest first. Open work is in \`studio/NEXT.md\`; agents don't need to read this file.

## DONE
- [x] **T-000** [P0] (\`producer\`) — Fresh studio for ${name}
`);
write('studio/CURRENT_TASK.md', `# Active Session State (\`studio/CURRENT_TASK.md\`)

## CHECKPOINT
- **Timestamp**: ${date.toISOString()}
- **Active Task ID**: NONE
- **Assigned Role**: \`producer\`
- **Priority**: N/A
- **Summary**: Idle — waiting for next task from studio/NEXT.md

## STATUS
- **Phase**: READY
- **Last Note**: Fresh studio for ${name}. Producers: run \`npm run handoff\`.
`);
// A fresh, unsigned Game Bible: build tasks wait for the intake and a person's signature.
const { emptyBible, writeBible } = await import('../harness/bible.mjs');
const bible = emptyBible();
bible.answers.title = name;
writeBible(bible);
console.log(`[reset] done. Archived to ${rel(archive)}. Next: npm run intake with the person who owns the game, then npm run handoff`);
