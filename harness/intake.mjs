#!/usr/bin/env node
/**
 * harness/intake.mjs — pre-production starts here: questions about the game that write the Game Bible.
 *
 *   npm run intake                          ask in the terminal (only what is still unanswered; --all for everything)
 *   npm run intake -- --answers game.json   apply answers from a file (an agent, a script or a future UI)
 *   npm run intake -- --questions           print the questions and the layer catalog as JSON
 *   npm run intake -- --ask < answers.txt   ask without a terminal (one answer per line; for scripts and tests)
 *
 * Answers file: { "answers": { "title": "…", "playLength": "demo", "pillars": ["name: rules out"],
 * "phase1": "…", … }, "layers": { "tech-tree": "no", "levels-xp": { "answer": "yes", "phase": 1 } } }
 *
 * Shorter games are much easier to finish: a demo (15 to 30 minutes) is the recommended start.
 * Longer games need more of the game dev's own time, and the intake says so.
 * When the Bible is complete enough, it queues the pre-production work once: reference studies,
 * storyboards, an R&D task per "explore" layer, and a sign-off task for the person.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent } from './event.mjs';
import { addTask } from './task.mjs';
import { QUESTIONS, LAYERS, PLAY_LENGTHS, emptyBible, readBible, writeBible, applyAnswers, checkBible, suggestedLayers, setLayer, catalog } from './bible.mjs';

/** Queue pre-production work once, when the Bible has a title and its layers are answered. */
export function queuePreproduction(b) {
  if (b.preproQueued || !b.answers.title) return [];
  const added = [];
  const t = b.answers.title;
  added.push(addTask({ title: `Study: the reference games for ${t} (what to take, what to avoid)`, role: 'reference-scout', priority: 'P1', meta: { size: 2, preproduction: true } }));
  added.push(addTask({ title: `Docs: storyboard ${t} Phase 1, 2 and 3 as beat sheets in studio/bible/STORYBOARD.md`, role: 'director', priority: 'P1', meta: { size: 2, preproduction: true } }));
  // One study per explore layer, up to what the play length can carry; the rest share one task.
  const explore = LAYERS.filter((x) => b.layers[x.id]?.answer === 'explore');
  const each = PLAY_LENGTHS[b.answers.playLength]?.layers || 3;
  for (const l of explore.slice(0, each)) {
    added.push(addTask({ title: `Study: explore the ${l.label.toLowerCase()} layer for ${t} (two light versions, then yes or no)`, role: 'rnd', priority: 'P2', meta: { size: 2, preproduction: true, layer: l.id } }));
  }
  if (explore.length > each) added.push(addTask({ title: `Study: decide yes or no for the other explore layers of ${t} (${explore.slice(each).map((l) => l.id).join(', ')})`, role: 'rnd', priority: 'P2', meta: { size: 2, preproduction: true } }));
  added.push(addTask({ title: `Sign the Game Bible for ${t} when it reads right (npm run bible -- check, then sign)`, role: 'human', priority: 'P1', meta: { preproduction: true } }));
  b.preproQueued = new Date().toISOString();
  writeBible(b);
  emitEvent({ type: 'bible.preproduction', agent: 'producer', to: 'producer', msg: `Pre-production queued for ${t}: ${added.map((x) => x.id).join(', ')}` });
  return added;
}

export function runIntake(input) {
  const b = applyAnswers(readBible() || emptyBible(), input);
  const skipped = b.skipped || [];
  delete b.skipped;
  writeBible(b);
  emitEvent({ type: 'bible.intake', agent: 'producer', to: 'producer', msg: `Intake updated the Game Bible for ${b.answers.title || '(untitled)'}` });
  const c = checkBible(b);
  const queued = LAYERS.every((l) => b.layers[l.id]) ? queuePreproduction(b) : [];
  return { bible: b, check: { ...c, warnings: [...skipped.map((s) => `not changed: ${s}`), ...c.warnings] }, queued };
}

async function ask(rl, q, current) {
  const hint = q.options ? ` [${q.options.join(' / ')}]` : '';
  if (q.kind === 'list') {
    console.log(`\n${q.ask}${current ? `\n(now: ${[].concat(current).map((x) => (typeof x === 'object' ? `${x.name}: ${x.rulesOut}` : x)).join(' | ')})` : ''}\nOne per line; an empty line ends.`);
    const lines = [];
    for (;;) {
      const l = (await rl.question('  > ')).trim();
      if (!l) break;
      lines.push(l);
    }
    return lines.length ? lines : undefined;
  }
  if (q.id === 'playLength') {
    console.log('\nHow long is the whole game to play? Shorter games are much easier to finish; start with a demo, then grow it.');
    for (const [k, v] of Object.entries(PLAY_LENGTHS)) console.log(`  ${k.padEnd(8)} ${v.label}. ${v.involvement}`);
  }
  const a = (await rl.question(`\n${q.ask}${hint}${current ? ` (now: ${[].concat(current).join(', ')})` : ''}\n> `)).trim();
  if (!a) return undefined;
  if (q.kind === 'multi') return a.split(/[,\s]+/).filter((x) => q.options.includes(x));
  if (q.kind === 'choice' && !q.options.includes(a)) {
    console.log(`  Pick one of: ${q.options.join(', ')}`);
    return ask(rl, q, current);
  }
  return a;
}

/** A terminal asks one line at a time; piped answers are read up front (readline drops lines that arrive before a question). */
async function lineSource() {
  if (process.stdin.isTTY) return readline.createInterface({ input: process.stdin, output: process.stdout });
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  const lines = text.replace(/\r/g, '').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return {
    question: async (prompt) => {
      process.stdout.write(prompt);
      if (!lines.length) throw Object.assign(new Error('end of answers'), { code: 'ABORT_ERR' });
      const l = lines.shift();
      process.stdout.write(`${l}\n`);
      return l;
    },
    close: () => {},
  };
}

async function interactive(all) {
  const rl = await lineSource();
  const b = readBible() || emptyBible();
  console.log('Game intake. Press Enter to skip a question; run it again any time to fill in the rest.');
  for (const q of QUESTIONS) {
    const current = q.id === 'pillars' ? (b.pillars.length ? b.pillars : null) : /^phase[123]$/.test(q.id) ? b.phases[q.id.slice(5)]?.player : b.answers[q.id];
    if (current && !all) continue;
    const v = await ask(rl, q, current);
    if (v !== undefined) applyAnswers(b, { [q.id]: v });
    writeBible(b);
    if (q.id === 'playLength' && b.answers.playLength) console.log(`  ${PLAY_LENGTHS[b.answers.playLength].involvement}`);
  }
  const suggested = new Set(suggestedLayers(b.answers));
  console.log('\nLayers: kinds of progression and systems. Answer y (yes), e (explore: R&D tries it first) or n (no: crossed out, never built).');
  console.log('Players never see a checklist; this is so the studio builds what the game needs and nothing else.');
  const left = LAYERS.filter((l) => !b.layers[l.id] || all);
  let only = null;
  if (left.length > 8 && suggested.size) {
    const m = (await rl.question(`\n${left.length} layers to answer. Answer all of them (a), or only the ${left.filter((l) => suggested.has(l.id)).length} that games like yours usually have, crossing out the rest (s)? a/s > `)).trim().toLowerCase();
    if (m.startsWith('s')) {
      only = suggested;
      for (const l of left.filter((x) => !suggested.has(x.id))) setLayer(b, l.id, { answer: 'no', why: 'not usual for this kind of game (crossed out at intake; a person can bring it back)', by: 'intake' }, { emit: false });
      writeBible(b);
      console.log(`Crossed out: ${left.filter((x) => !suggested.has(x.id)).map((x) => x.label).join(', ')}.`);
    }
  }
  for (const l of LAYERS) {
    if (b.layers[l.id] && !all && !(only && only.has(l.id) && !b.layers[l.id])) continue;
    if (only && !only.has(l.id)) continue;
    const tip = suggested.has(l.id) ? ' (games like yours usually have this)' : '';
    const a = (await rl.question(`\n[${l.group}] ${l.ask}${tip} y/e/n > `)).trim().toLowerCase();
    if (!a) continue;
    const answer = a.startsWith('y') ? 'yes' : a.startsWith('e') ? 'explore' : a.startsWith('n') ? 'no' : null;
    if (!answer) continue;
    let phase = null;
    if (answer === 'yes') phase = Number((await rl.question('  Which phase does it enter? 1 early, 2 mid, 3 endgame > ')).trim()) || 1;
    const why = answer === 'no' ? (await rl.question('  Why not? (one line, optional) > ')).trim() : '';
    setLayer(b, l.id, { answer, phase, why, by: 'intake' }, { emit: false });
    writeBible(b);
  }
  rl.close();
  return runIntake({});
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  if (argv.includes('--questions')) {
    console.log(JSON.stringify(catalog(), null, 2));
    process.exit(0);
  }
  const i = argv.indexOf('--answers');
  let res;
  if (i >= 0) {
    const file = path.resolve(argv[i + 1] || '');
    if (!fs.existsSync(file)) {
      console.error(`No answers file at ${argv[i + 1]}`);
      process.exit(1);
    }
    res = runIntake(JSON.parse(fs.readFileSync(file, 'utf8')));
  } else if (process.stdin.isTTY || argv.includes('--ask')) {
    try {
      res = await interactive(argv.includes('--all'));
    } catch (err) {
      if (err?.code !== 'ABORT_ERR' && err?.code !== 'ERR_USE_AFTER_CLOSE') throw err;
      // Ctrl+D or the end of piped answers: everything answered so far is already saved.
      console.log('\nStopped. Everything you answered is saved; run `npm run intake` again to carry on.');
      res = runIntake({});
    }
  } else {
    console.error('No terminal to ask in. Pass --answers <file.json> (see `npm run intake -- --questions` for the shape).');
    process.exit(1);
  }
  const { bible, check, queued } = res;
  console.log(`\nGame Bible: studio/bible/BIBLE.md (data: studio/bible/bible.json)`);
  if (bible.answers.playLength) console.log(`Play length: ${PLAY_LENGTHS[bible.answers.playLength].label}. ${PLAY_LENGTHS[bible.answers.playLength].involvement}`);
  for (const m of check.missing) console.log(`  [ ] ${m}`);
  for (const w of check.warnings) console.log(`  note: ${w}`);
  if (queued.length) console.log(`Queued pre-production: ${queued.map((t) => `${t.id} ${t.title}`).join('\n  ')}`);
  console.log(check.ok ? 'Complete. A person signs it with: npm run bible -- sign --by <name>' : 'Run `npm run intake` again to fill in the rest.');
}
