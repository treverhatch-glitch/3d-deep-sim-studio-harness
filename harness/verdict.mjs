#!/usr/bin/env node
/**
 * harness/verdict.mjs — "Is it fun?" A person's answer after playing a real build, and the thing that
 * lets a phase close.
 *
 *   npm run verdict -- yes|not-yet --by <person> [--build <id>] [--note "…"]
 *   npm run verdict -- yes --by jed --quote "<their words>" --source "<where they said it>" --relayed-by <agent>
 *                                           a person's verdict given in chat, relayed by the lead or Liaison
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
 * Agents can't give a verdict: it has to come from someone who played. Owners often answer in chat, not in
 * the Arcade (test #2: "love the burgers… now might be time to move on to next floors" on Discord), so an
 * agent may relay one: the person's own words, word for word (--quote), where they said it (--source),
 * and who relayed it (--relayed-by). It is marked as relayed, and the person is told so they can undo it.
 * Verdicts live in studio/playtest/verdicts.json, each with the build it was about.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
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

export async function addVerdict({ by, fun, build = null, note = '', quote = '', source = '', relayedBy = null, viaWarRoom = false }) {
  if (!isPerson(by)) return { ok: false, message: `${by || 'Nobody'} looks like an agent. A fun verdict comes from a person who played the build (--by <your name>).` };
  // From inside an agent session, a verdict is always a relay: the person's words and where they said them.
  const inAgent = !viaWarRoom && Boolean(process.env.STUDIO_ROLE || (process.env.STUDIO_LOCK_OWNER && !isPerson(process.env.STUDIO_LOCK_OWNER)));
  const relay = relayedBy || (inAgent ? process.env.STUDIO_LOCK_OWNER || 'an agent' : null);
  if (relay) {
    const q = String(quote || '').replace(/\s+/g, ' ').trim();
    if (q.length < 8 || !String(source || '').trim()) return { ok: false, message: `A relayed verdict needs ${by}'s own words and where they said them: --quote "<their words, word for word>" --source "<Discord #channel, time or link>" --relayed-by <you>.` };
  }
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
  const v = { at: new Date().toISOString(), by, fun, build: b.id, commit: b.sha || null, phase, note: String(note || '').replace(/\s+/g, ' ').trim().slice(0, 1000), ...(relay ? { relayed: { by: relay, quote: String(quote).replace(/\s+/g, ' ').trim().slice(0, 600), source: String(source).trim().slice(0, 300) } } : {}) };
  const all = [...readVerdicts(), v];
  fs.mkdirSync(path.dirname(VERDICTS), { recursive: true });
  fs.writeFileSync(VERDICTS, `${JSON.stringify({ verdicts: all }, null, 2)}\n`);
  if (fun === 'not-yet') {
    const inbox = path.join(REPO_ROOT, 'studio', 'producer', 'INBOX.md');
    fs.mkdirSync(path.dirname(inbox), { recursive: true });
    if (!fs.existsSync(inbox)) fs.writeFileSync(inbox, '# Producer inbox\n\n> Messages from people in the War Room. The Producer reads new ones in its briefing (`npm run handoff`).\n\n');
    fs.appendFileSync(inbox, `- [${v.at.slice(0, 16).replace('T', ' ')}] **${by}** played build ${b.id}: not fun yet${v.note ? `: ${v.note}` : ''}\n`);
  }
  emitEvent({ type: 'playtest.verdict', agent: by, to: relay ? 'human' : 'producer', msg: `${by} played build ${b.id}${phase ? ` (Phase ${phase})` : ''}: ${fun === 'yes' ? 'yes, it\'s fun' : 'not fun yet'}${v.note ? `: ${v.note}` : ''}${relay ? ` (relayed by ${relay} from ${v.relayed.source}: "${v.relayed.quote.slice(0, 120)}"; ${by}, if that's wrong, record not-yet in the Arcade)` : ''}` });
  // 2.30g: the verdict and its words become a note later briefs can show as context (never a rule).
  if (String(v.note || v.relayed?.quote || '').trim()) {
    try {
      const { addVerdictNote } = await import('./verdict-notes.mjs');
      addVerdictNote({ by: v.by, verdict: v.fun, on: v.build || null, tags: ['playtest'], comment: String(v.note || v.relayed?.quote).trim() });
    } catch {}
  }
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
  const floorsConfig = (() => { try { return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'studio/floors.json'), 'utf-8')); } catch { return null; } })();
  const scenarioDir = path.join(REPO_ROOT, 'qa', 'scenarios', `phase-${phase}`);
  if (!fs.existsSync(scenarioDir) && floorsConfig?.requireScenarios) {
    gaps.push(`required scenario folder qa/scenarios/phase-${phase}/ is missing`);
  } else if (fs.existsSync(scenarioDir)) {
    const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'qa', 'check-phase-scenarios.mjs'), '--phase', phase], { encoding: 'utf8', timeout: Number(process.env.STUDIO_SCENARIO_TIMEOUT_MS || 60000) + 5000 });
    if (r.status !== 0) {
      gaps.push(`phase-scenarios gate failed for Phase ${phase}: ${((r.stderr || '').match(/^(FAIL|ERROR).*$/gm) || [(r.stderr || r.stdout || '').trim().split('\n').pop()]).join('; ')}`);
    }
  }

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
    const r = await addVerdict({ by: flag('by'), fun: argv[0], build: flag('build'), note: flag('note') || '', quote: flag('quote') || '', source: flag('source') || '', relayedBy: flag('relayed-by') });
    if (!r.ok) {
      console.error(r.message);
      process.exit(1);
    }
    console.log(`Recorded: ${r.verdict.by} on build ${r.verdict.build}${r.verdict.phase ? ` (Phase ${r.verdict.phase})` : ''}: ${r.verdict.fun}${r.verdict.relayed ? ` (relayed by ${r.verdict.relayed.by})` : ''}.`);
    process.exit(0);
  }
  const all = readVerdicts();
  console.log(all.length ? all.map((v) => `${v.at.slice(0, 16).replace('T', ' ')}  ${v.by}  build ${v.build}  Phase ${v.phase ?? '-'}  ${v.fun}${v.note ? `: ${v.note}` : ''}${v.relayed ? ` [relayed by ${v.relayed.by} from ${v.relayed.source}]` : ''}`).join('\n') : 'No verdicts yet. Play the last good build in the Arcade and answer "Is it fun?".');
}
