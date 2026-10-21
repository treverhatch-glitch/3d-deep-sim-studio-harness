#!/usr/bin/env node
/**
 * harness/division.mjs — the studio's departments, opened and closed by the Producer or the game dev.
 *
 *   npm run division                                      every division: on or off, its roles, who's in it
 *   npm run division -- open sound --reason "the game needs music for Phase 1" --by producer-1
 *   npm run division -- close sound --reason "…" --by <name>
 *
 * A division is a room in the Studio view with its roles (Sound: sound-designer, composer). Hiring
 * into one (npm run agent -- hire --division sound, or "+ Hire" in its room) opens it if it's off, and
 * it opens by itself when one of its agents works. Opening and closing are logged with the reason in
 * studio/decisions/divisions.md. Core divisions (Producer, Engineering, QA, Design, Review) stay on.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, actor } from './event.mjs';
import { listDivisions, setDivision } from './divisions.mjs';

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  const [cmd, id] = argv;
  if (cmd === 'open' || cmd === 'close') {
    const reason = flag('reason');
    if (!reason) {
      console.error(`Say why: npm run division -- ${cmd} ${id || '<id>'} --reason "…" --by <name>`);
      process.exit(1);
    }
    const by = flag('by') || actor();
    const r = setDivision(id, cmd === 'open', by);
    if (!r.ok) {
      console.error(r.message);
      process.exit(1);
    }
    const log = path.join(REPO_ROOT, 'studio', 'decisions', 'divisions.md');
    fs.mkdirSync(path.dirname(log), { recursive: true });
    if (!fs.existsSync(log)) fs.writeFileSync(log, '# Divisions opened and closed\n');
    fs.appendFileSync(log, `\n- ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${by} ${cmd === 'open' ? 'opened' : 'closed'} ${r.division.name}: ${reason}\n`);
    console.log(`${r.division.name} is ${cmd === 'open' ? 'open' : 'closed'}. Hire into it: npm run agent -- hire --division ${id} --role ${(r.division.roles || ['<role>'])[0]}`);
    process.exit(0);
  }
  for (const d of listDivisions()) console.log(`${d.active ? 'on ' : 'off'}  ${d.id.padEnd(13)} ${d.name.padEnd(20)} ${(d.roles || []).join(', ')}${d.core ? '  (core)' : ''}`);
}
