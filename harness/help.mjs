#!/usr/bin/env node
/**
 * harness/help.mjs — the commands people and agents use day to day, on one screen.
 *   npm run help [-- --all]
 * On Windows PowerShell, use npm.cmd in place of npm if npm.ps1 is blocked.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './event.mjs';
import { readMode, scopeOf } from './mode.mjs';

const GROUPS = [
  ['Start and stop', [
    ['setup', 'first run: .env, git hooks, Playwright Chromium'],
    ['preflight', 'is this studio ready to run? (--fix repairs what it can)'],
    ['hub', 'the War Room in your browser'],
    ['studio:start -- --until 18:00', 'run agents unattended until a time'],
    ['studio:stop', 'stop the unattended run'],
  ]],
  ['The work', [
    ['task -- next', 'the next task'],
    ['task -- start <ID> --agent <you>', 'claim it'],
    ['task -- done <ID> --agent <you>', 'finish it (after verify)'],
    ['task -- pause <ID> --agent <you> --note "…"', 'hand it back with a note'],
    ['map -- find <name>', 'where a function or constant is, in one call'],
    ['agent -- list', 'agents running now'],
    ['handoff', 'the Producer\'s briefing'],
  ]],
  ['Checks', [
    ['verify', 'the gates for everyday work (--deep adds the harness self-checks)'],
    ['golden -- --update', 'new hashes after a sim change; commit them with it'],
    ['play:browser', 'a bot plays the browser build'],
    ['release', 'everything, before a merge'],
  ]],
  ['Numbers and notes', [
    ['tokens', 'measured token use by role, model or agent (--since 5h)'],
    ['budget', 'quota marks and the last 5 hours'],
    ['run-report', 'a report of the run'],
    ['notes -- add --kind bad "…"', 'record a harness problem'],
    ['pitfall -- "never …" --by <name>', 'a rule every later agent gets'],
    ['mode', 'pace and scope (scope lite|full)'],
  ]],
];

const all = process.argv.includes('--all');
// Lite scope shows the ten commands a Lite studio needs; --all shows every script.
const LITE = ['setup', 'hub', 'map -- find <name>', 'task -- next', 'task -- start <ID> --agent <you>', 'task -- done <ID> --agent <you>', 'task -- pause <ID> --agent <you> --note "…"', 'verify', 'golden -- --update', 'tokens', 'mode'];
const lite = scopeOf(readMode()) === 'lite';
const npm = process.platform === 'win32' ? 'npm.cmd run' : 'npm run';
console.log(`Scope: ${scopeOf(readMode())}. Every command: npm run help -- --all. The full command sheet: studio/llms.txt.\n`);
if (all) {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  for (const [k, v] of Object.entries(pkg.scripts)) console.log(`  ${npm} ${k.padEnd(20)} ${v}`);
} else {
  for (const [title, all] of GROUPS) {
    const rows = lite ? all.filter(([cmd]) => LITE.includes(cmd)) : all;
    if (!rows.length) continue;
    console.log(title);
    for (const [cmd, what] of rows) console.log(`  ${`${npm} ${cmd}`.padEnd(52)} ${what}`);
    console.log('');
  }
  if (process.platform === 'win32') console.log('PowerShell says "running scripts is disabled"? Use npm.cmd as shown, or cmd.exe.');
}
