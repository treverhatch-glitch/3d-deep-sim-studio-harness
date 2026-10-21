#!/usr/bin/env node
/**
 * harness/verdict.mjs — "Is it fun?" A person's answer after playing a real build, and the thing that
 * lets a phase close.
 *
 *   npm run verdict -- yes|not-yet --by <person> [--build <id>] [--note "…"]
 *   npm run verdict                         the verdicts so far
 *
 * Both runs so far went green on every gate while the game was wrong for the person playing it
 * (Next Floor: WASD inverted, no elevator; Solar Outpost: pads that couldn't be clicked, a phase gone in
 * 15 s). So the next phase opens only when:
 *   1. the Director says the phase is ready (as before),
 *   2. every item in studio/bible/PHASE-<n>-EXIT.md is ticked, if the file exists, and
 *   3. a person said "yes, it's fun" in the Arcade (or here) about a build played since the phase opened.
 * `npm run bible -- phase open <n> --force "reason"` still overrides, and the reason is logged.
 * The War Room's Arcade has the two buttons; a "not yet" goes to the Producer's inbox with its note.
 * Agents can't give a verdict: it has to come from someone who played.
 * Verdicts live in studio/playtest/verdicts.json, each with the build it was about.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent } from './event.mjs';

export const VERDICTS = path.join(REPO_ROOT, 'studio', 'playtest', 'verdicts.json');
// The same agent-name shapes the launcher uses for hiring: agents never give a fun verdict.
const AGENTISH = /^(prod|producer|director|builder|rnd|qa|reviewer|planner|art|liaison|agent|watch|supervisor|dev-hacker|codex|claude|gemini|agy|grok|cursor|aider|hermes|sound|composer|artist|ui-|writer|engine)\b/i;
export const isPerson = (by) => Boolean(by) && !AGENTISH.test(String(by)) && by !== process.env.STUDIO_LOCK_OWNER;

export function readVerdicts() {
  try {
    return JSON.parse(fs.readFileSync(VERDICTS, 'utf8')).verdicts || [];
  } catch {
    return [];
  }
}

export async function addVerdict({ by, fun, build = null, note = '' }) {
  if (!isPerson(by)) return { ok: false, message: `${by || 'Nobody'} looks like an agent. A fun verdict comes from a person who played the build (--by <your name>).` };
  if (!['yes', 'not-yet'].includes(fun)) return { ok: false, message: 'Say yes or not-yet.' };
  const { latestBuild, listBuilds } = await import('./builds.mjs');
  const b = build ? listBuilds().find((x) => x.id === build) : latestBuild();
  if (!b) return { ok: false, message: 'There is no saved build to judge yet. One is saved each time the browser check passes (npm run play:browser).' };
  let phase = null;
  try {
    phase = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'studio', 'bible', 'bible.json'), 'utf8')).phase?.open || null;
  } catch {
    // no Bible yet
  }
  const v = { at: new Date().toISOString(), by, fun, build: b.id, commit: b.sha || null, phase, note: String(note || '').replace(/\s+/g, ' ').trim().slice(0, 1000) };
  const all = [...readVerdicts(), v];
  fs.mkdirSync(path.dirname(VERDICTS), { recursive: true });
  fs.writeFileSync(VERDICTS, `${JSON.stringify({ verdicts: all }, null, 2)}\n`);
  if (fun === 'not-yet') {
    const inbox = path.join(REPO_ROOT, 'studio', 'producer', 'INBOX.md');
    fs.mkdirSync(path.dirname(inbox), { recursive: true });
    if (!fs.existsSync(inbox)) fs.writeFileSync(inbox, '# Producer inbox\n\n> Messages from people in the War Room. The Producer reads new ones in its briefing (`npm run handoff`).\n\n');
    fs.appendFileSync(inbox, `- [${v.at.slice(0, 16).replace('T', ' ')}] **${by}** played build ${b.id}: not fun yet${v.note ? `: ${v.note}` : ''}\n`);
  }
  emitEvent({ type: 'playtest.verdict', agent: by, to: 'producer', msg: `${by} played build ${b.id}${phase ? ` (Phase ${phase})` : ''}: ${fun === 'yes' ? 'yes, it\'s fun' : 'not fun yet'}${v.note ? `: ${v.note}` : ''}` });
  return { ok: true, verdict: v };
}

/** The person's latest verdict for a phase since a time, or null. */
export function latestVerdict(phase, sinceIso = null) {
  const since = sinceIso ? Date.parse(sinceIso) : 0;
  return readVerdicts().filter((v) => (phase == null || v.phase === phase) && Date.parse(v.at) >= since).pop() || null;
}

/** What a phase still needs before it can close: [] when ready. */
export function phaseExitGaps(phase, sinceIso = null) {
  const gaps = [];
  const exitFile = path.join(REPO_ROOT, 'studio', 'bible', `PHASE-${phase}-EXIT.md`);
  if (fs.existsSync(exitFile)) {
    const items = fs.readFileSync(exitFile, 'utf8').match(/^\s*[-*] \[[ xX]\] .+$/gm) || [];
    const open = items.filter((l) => !/\[[xX]\]/.test(l));
    if (open.length) gaps.push(`${open.length} of ${items.length} items in PHASE-${phase}-EXIT.md aren't ticked`);
  }
  const v = latestVerdict(phase, sinceIso);
  if (!v) gaps.push(`nobody has played a build and said it's fun since Phase ${phase} opened (the Arcade's "Is it fun?", or npm run verdict -- yes --by <name>)`);
  else if (v.fun !== 'yes') gaps.push(`the last verdict was "not yet" (${v.by}: ${v.note || 'no note'})`);
  return gaps;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  if (['yes', 'not-yet'].includes(argv[0])) {
    const r = await addVerdict({ by: flag('by'), fun: argv[0], build: flag('build'), note: flag('note') || '' });
    if (!r.ok) {
      console.error(r.message);
      process.exit(1);
    }
    console.log(`Recorded: ${r.verdict.by} on build ${r.verdict.build}${r.verdict.phase ? ` (Phase ${r.verdict.phase})` : ''}: ${r.verdict.fun}.`);
    process.exit(0);
  }
  const all = readVerdicts();
  console.log(all.length ? all.map((v) => `${v.at.slice(0, 16).replace('T', ' ')}  ${v.by}  build ${v.build}  Phase ${v.phase ?? '-'}  ${v.fun}${v.note ? `: ${v.note}` : ''}`).join('\n') : 'No verdicts yet. Play the last good build in the Arcade and answer "Is it fun?".');
}
