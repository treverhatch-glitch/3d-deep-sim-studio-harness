#!/usr/bin/env node
/**
 * harness/tricks.mjs — the dev hacker's trick cards: the tricks game developers use, fitted to this game.
 *
 *   npm run trick -- propose "<title>" --problem "…" --trick "…" --fits "…" --avoid-if "…" --proof "<metric before/after>"
 *                       [--source <url>] [--experiment X-003] [--cost 1-5] [--by dev-hacker-1]
 *   npm run trick -- none "<why nothing is worth doing now>"      a hunt that found nothing worth it (also done)
 *   npm run trick -- adopt K-001 --by <producer> [--phase 1 --serves pillar:<p>] [--lane <folder>] [--role builder]
 *   npm run trick -- park K-001 --why "…" --by <producer>
 *   npm run trick -- list
 *
 * The dev hacker works beside the studio, never in its way. It studies what the game is becoming
 * (the Bible, the storyboard, playtest and browser reports, the tick and renderer budgets, recent bugs)
 * and how developers solve the same problems: an elevator ride that hides the next level loading,
 * object pools instead of allocating every frame, a fixed-timestep accumulator, instanced props,
 * baked lighting, LOD and impostors, streaming by trigger volumes. Each find becomes a card that says
 * what problem it solves here, the trick, why it fits this game, when NOT to use it, and how to prove
 * it helped. It may build a throwaway prototype in an experiment (npm run experiment), which the
 * Producer can keep or drop in one command.
 *
 * Cards go to the Producer, batched like ideas: one "Tricks:" task for all new cards. The Producer
 * adopts a card (queues build work that names the trick) or parks it with a reason. Nothing in the
 * studio waits on the dev hacker: its tasks are low priority, it holds no game-file locks outside its
 * own experiment, and when it finds nothing, nothing changes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, actor, emitEvent } from './event.mjs';

export const TRICKS_DIR = path.join(REPO_ROOT, 'studio', 'tricks');
const now = () => new Date().toISOString();

export function readTricks() {
  if (!fs.existsSync(TRICKS_DIR)) return [];
  return fs.readdirSync(TRICKS_DIR).filter((f) => /^K-\d+\.json$/.test(f)).sort().map((f) => JSON.parse(fs.readFileSync(path.join(TRICKS_DIR, f), 'utf8')));
}
const readTrick = (id) => readTricks().find((t) => t.id === id) || null;
function writeTrick(t) {
  fs.mkdirSync(TRICKS_DIR, { recursive: true });
  t.updatedAt = now();
  fs.writeFileSync(path.join(TRICKS_DIR, `${t.id}.json`), `${JSON.stringify(t, null, 2)}\n`);
  const L = [`# ${t.id} ${t.title}`, '', `Status: **${t.status}**${t.decidedBy ? ` (by ${t.decidedBy}${t.why ? `: ${t.why}` : ''})` : ''}. Proposed by ${t.by}, ${t.at.slice(0, 10)}.`, '', `**The problem here.** ${t.problem}`, '', `**The trick.** ${t.trick}`, '', `**Why it fits this game.** ${t.fits}`, '', `**Don't use it if.** ${t.avoidIf}`, '', `**How we'll know it helped.** ${t.proof}`, ''];
  if (t.source) L.push(`Source: ${t.source}`, '');
  if (t.experiment) L.push(`Prototype: experiment ${t.experiment} (npm run experiment -- show ${t.experiment}; keep or drop)`, '');
  if (t.tasks?.length) L.push(`Build work: ${t.tasks.join(', ')}`, '');
  fs.writeFileSync(path.join(TRICKS_DIR, `${t.id}.md`), `${L.join('\n')}\n`);
  return t;
}

export function proposeTrick({ title, problem, trick, fits, avoidIf, proof, source = '', experiment = null, cost = null, by = actor() }) {
  const missing = Object.entries({ title, problem, trick, fits, 'avoid-if': avoidIf, proof }).filter(([, v]) => !String(v || '').trim()).map(([k]) => `--${k === 'title' ? 'title (first argument)' : k}`);
  if (missing.length) return { ok: false, message: `A trick card says all of: ${missing.join(', ')}. "Avoid if" matters most: not every game wants an elevator between levels.` };
  const n = readTricks().reduce((m, t) => Math.max(m, Number(t.id.slice(2))), 0) + 1;
  const t = writeTrick({ id: `K-${String(n).padStart(3, '0')}`, title: String(title).slice(0, 160), problem: String(problem).slice(0, 1500), trick: String(trick).slice(0, 3000), fits: String(fits).slice(0, 1500), avoidIf: String(avoidIf).slice(0, 1500), proof: String(proof).slice(0, 800), source: String(source).slice(0, 400), experiment, cost: cost ? Number(cost) : null, by, at: now(), status: 'proposed', tasks: [] });
  emitEvent({ type: 'trick.proposed', agent: by, to: 'producer', msg: `${t.id} ${t.title}: ${t.problem.slice(0, 120)}` });
  return { ok: true, trick: t };
}

/** A hunt that found nothing worth doing is a result too: say why, and the hunt is done. */
export function noTrick(why, by = actor()) {
  if (!String(why || '').trim()) return { ok: false, message: 'Say why nothing is worth doing now (what you looked at).' };
  fs.mkdirSync(TRICKS_DIR, { recursive: true });
  fs.appendFileSync(path.join(TRICKS_DIR, 'HUNTS.md'), `- ${now().slice(0, 16).replace('T', ' ')} · ${by}: nothing worth doing now: ${String(why).replace(/\s+/g, ' ')}\n`);
  emitEvent({ type: 'trick.none', agent: by, msg: `Trick hunt found nothing worth doing now: ${String(why).slice(0, 200)}` });
  return { ok: true };
}

export async function adoptTrick(id, { by, phase = null, serves = null, lane = null, role = 'builder' }) {
  const t = readTrick(id);
  if (!t) return { ok: false, message: `No trick ${id}` };
  if (!['proposed', 'parked'].includes(t.status)) return { ok: false, message: `${id} is ${t.status}.` };
  if (!by) return { ok: false, message: 'Say who adopts it: --by <producer or person>.' };
  const { addTask } = await import('./task.mjs');
  const meta = { trick: id, part: 'renderer', ...(phase ? { phase: Number(phase) } : {}), ...(serves ? { serves } : {}), ...(lane ? { lane } : {}), ...(!phase ? { infra: true } : {}) };
  const task = addTask({ title: `Build trick ${id}: ${t.title} (prove it: ${t.proof})`.slice(0, 180), role, priority: 'P2', agent: by, meta });
  if (task.error) return { ok: false, message: task.message };
  t.status = 'adopted';
  t.decidedBy = by;
  t.tasks = [...(t.tasks || []), task.id];
  writeTrick(t);
  emitEvent({ type: 'trick.adopted', agent: by, to: role, task: task.id, msg: `${by} adopted ${id} ${t.title}: ${task.id}` });
  return { ok: true, trick: t, task: task.id };
}

export function parkTrick(id, { by, why }) {
  const t = readTrick(id);
  if (!t) return { ok: false, message: `No trick ${id}` };
  if (!by || !String(why || '').trim()) return { ok: false, message: 'Park it with a reason: --why "…" --by <name>.' };
  Object.assign(t, { status: 'parked', decidedBy: by, why: String(why).slice(0, 500) });
  writeTrick(t);
  emitEvent({ type: 'trick.parked', agent: by, msg: `${by} parked ${id} ${t.title}: ${why}` });
  return { ok: true, trick: t };
}

/**
 * The watcher's pass: one Producer task for new cards (never one per card), and a trick hunt for the
 * dev hacker when its lab is open and none is waiting: daily, or at once when a budget check is red.
 * Returns what it queued. Never blocks anything: hunts are P3 and nothing depends on them.
 */
export async function trickPass({ queue, divisions, gates, nowMs = Date.now() }) {
  const { addTask } = await import('./task.mjs');
  const out = {};
  const open = [...queue.inProgress, ...queue.backlog];
  const fresh = readTricks().filter((t) => t.status === 'proposed' && !t.announced);
  if (fresh.length && !open.some((t) => /^Tricks:/.test(t.title))) {
    const t = addTask({ agent: 'watch', title: `Tricks: ${fresh.length} new from the dev hacker (${fresh.map((x) => x.id).join(', ')}): adopt or park each (npm run trick -- adopt|park)`, role: 'producer', priority: 'P2' });
    for (const k of fresh) writeTrick({ ...k, announced: now() });
    out.producer = t.id;
  }
  const lab = (divisions || []).find((d) => d.id === 'hacks');
  if (!lab?.active || open.some((t) => /^Trick hunt\b/.test(t.title))) return out;
  const red = ((gates?.rows) || []).filter((r) => !r.ok && /tick-budget|renderer-budget|module-size|browser-play|soak/.test(r.id)).map((r) => r.id);
  const lastHunt = [...queue.done].filter((t) => /^Trick hunt\b/.test(t.title)).length;
  const marker = path.join(TRICKS_DIR, '.last-hunt');
  const last = fs.existsSync(marker) ? Date.parse(fs.readFileSync(marker, 'utf8')) : 0;
  if (red.length || !last || nowMs - last > 24 * 3600000) {
    const t = addTask({ agent: 'watch', title: red.length ? `Trick hunt: ${red.join(', ')} ${red.length > 1 ? 'are' : 'is'} red; find how developers solve that, fitted to this game` : `Trick hunt: what would make the game run or feel smoother right now? (${lastHunt} hunts so far)`, role: 'dev-hacker', priority: 'P3' });
    fs.mkdirSync(TRICKS_DIR, { recursive: true });
    fs.writeFileSync(marker, new Date(nowMs).toISOString());
    out.hunt = t.id;
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  const pos = argv.filter((x, i) => !x.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
  const done = (r, line) => {
    if (!r.ok) {
      console.error(r.message);
      process.exit(1);
    }
    console.log(line(r));
    process.exit(0);
  };
  if (pos[0] === 'propose') done(proposeTrick({ title: pos[1], problem: flag('problem'), trick: flag('trick'), fits: flag('fits'), avoidIf: flag('avoid-if'), proof: flag('proof'), source: flag('source') || '', experiment: flag('experiment'), cost: flag('cost'), by: flag('by') || undefined }), (r) => `${r.trick.id} written (studio/tricks/${r.trick.id}.md). The Producer gets it with the next batch.`);
  if (pos[0] === 'none') done(noTrick(pos[1], flag('by') || undefined), () => 'Noted in studio/tricks/HUNTS.md. Nothing changes; that is fine.');
  if (pos[0] === 'adopt') done(await adoptTrick(pos[1], { by: flag('by') || actor(), phase: flag('phase'), serves: flag('serves'), lane: flag('lane'), role: flag('role') || 'builder' }), (r) => `${r.trick.id} adopted: ${r.task} queued.`);
  if (pos[0] === 'park') done(parkTrick(pos[1], { by: flag('by') || actor(), why: flag('why') }), (r) => `${r.trick.id} parked.`);
  const list = readTricks();
  console.log(list.length ? list.map((t) => `${t.id} [${t.status}] ${t.title}${t.tasks?.length ? ` -> ${t.tasks.join(', ')}` : ''}`).join('\n') : 'No trick cards yet. The dev hacker writes them: npm run trick -- propose "<title>" --problem … --trick … --fits … --avoid-if … --proof …');
}
