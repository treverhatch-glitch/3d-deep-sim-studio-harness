#!/usr/bin/env node
/**
 * harness/dev-cycle.mjs — 2.30o: the Director and Producer develop the game continuously, not in one-shot plans.
 *
 * In the Marina run the early game landed, the plan ran out, and nobody knew where to go next. The game-dev
 * loop now runs a standing cycle:
 *   when    every STUDIO_DEV_CYCLE_MIN (45) minutes, when the builder queue drops below 4, or when a
 *           milestone closed since the last cycle
 *   what    writes .studio/briefs/dev-cycle.md (recent landings, newest captures, playtest reports, unmet
 *           exit criteria, bible gaps, the ladder's end) and wakes the Director, then the Producer, to
 *           review it against the bible and charter and turn it into new ideas and content tasks
 *   thin    a bible missing a core loop, feel, progression or late game gets a Director task to write it
 *   brief   from the reference game's mechanics and the genre, marked "Status: ASSUMPTION (dev to approve)";
 *           the studio proceeds on it without waiting
 *   ladder  when a ladder's last milestone is half met (or it has no open milestone left), the Director gets a
 *           task to propose the next one (content, depth, polish, port) and append it to the charter
 * Tasks go through fileTask (deduplicated). STUDIO_DEV_CYCLE=off turns it off.
 *
 *   node harness/dev-cycle.mjs [--force] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, emitEvent, readRecentEvents } from './event.mjs';

const FILE = () => path.join(STUDIO_STATE_DIR, 'dev-cycle.json');
const BRIEF = () => path.join(STUDIO_STATE_DIR, 'briefs', 'dev-cycle.md');
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

/** Core design docs a bible should have: name -> what counts (file names or headings). */
export const CORE_DOCS = {
  'core loop': /core[- _]?loop/i,
  feel: /\bfeel\b|game[- _]?feel/i,
  progression: /progression/i,
  'late game': /late[- _]?game|end[- _]?game/i,
};

/** Which core docs the bible lacks (file names under studio/bible or headings in its markdown). */
export function bibleGaps(root = path.join(REPO_ROOT, 'studio', 'bible')) {
  const texts = [];
  const walk = (d, depth = 0) => {
    if (!fs.existsSync(d) || depth > 3) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.md$/i.test(e.name)) {
        texts.push(e.name);
        try { texts.push(...fs.readFileSync(p, 'utf8').split('\n').filter((l) => /^#{1,4}\s/.test(l))); } catch {}
      }
    }
  };
  walk(root);
  return Object.entries(CORE_DOCS).filter(([, rx]) => !texts.some((t) => rx.test(t))).map(([k]) => k);
}

/** Ladders that need a next milestone proposed. */
export async function ladderEnds() {
  const { milestones } = await import('./producer-refill.mjs');
  const list = milestones();
  const by = new Map();
  for (const m of list) by.set(m.ladder, [...(by.get(m.ladder) || []), m]);
  const out = [];
  for (const [ladder, ms] of by) {
    const open = ms.filter((m) => !m.closed);
    const last = ms[ms.length - 1];
    const lastShare = last.exit.length ? last.exit.filter((e) => e.met).length / last.exit.length : 0;
    if (!open.length || last.closed || (open[open.length - 1] === last && lastShare >= 0.5)) out.push({ ladder, last: last.id, next: last.id.replace(/\d+$/, (n) => String(Number(n) + 1)) });
  }
  return out;
}

export async function cyclePass({ now = Date.now(), force = false, events = readRecentEvents(5000), wake = true } = {}) {
  if (/^off$/i.test(process.env.STUDIO_DEV_CYCLE || '')) return { ran: false, why: 'STUDIO_DEV_CYCLE=off' };
  const st = read(FILE(), {});
  const last = st.last || 0;
  const every = Number(process.env.STUDIO_DEV_CYCLE_MIN ?? 45) * 60000;
  const { parseNextQueue } = await import('./task.mjs');
  const q = parseNextQueue();
  const open = [...q.inProgress, ...q.backlog].filter((t) => t.role === 'builder').length;
  const closed = events.some((e) => e.type === 'milestone.closed' && Date.parse(e.ts) > last);
  const why = force ? 'asked' : closed ? 'a milestone closed' : open < Number(process.env.STUDIO_REFILL_MIN ?? 4) && now - last >= 10 * 60000 ? `the queue is low (${open} open)` : now - last >= every ? 'its regular cycle' : null;
  if (!why) return { ran: false, why: `next cycle in ${Math.round((every - (now - last)) / 60000)} min` };

  const { fileTask, milestones, nextOpen } = await import('./producer-refill.mjs');
  const filed = [];
  for (const gap of bibleGaps()) {
    const r = await fileTask(`bible:${gap}`, `Write the ${gap} doc in studio/bible from the reference game's mechanics and the genre; head it "Status: ASSUMPTION (dev to approve)" and proceed on it without waiting`, { role: 'director', priority: 'P0', by: 'dev-cycle' });
    if (r.id && !r.skipped) filed.push(r.id);
  }
  for (const l of await ladderEnds()) {
    const r = await fileTask(`ladder:${l.ladder}:${l.next}`, `Propose ${l.next} for "${l.ladder}" (more content, depth, polish or a port) with measurable exit criteria and append it to studio/bible/CHARTER.md; ${l.last} is nearly done`, { role: 'director', priority: 'P1', by: 'dev-cycle' });
    if (r.id && !r.skipped) filed.push(r.id);
  }
  const landed = events.filter((e) => e.type === 'task.done' && Date.parse(e.ts) > last).map((e) => `- ${e.task}: ${String(e.msg || '').slice(0, 140)}`);
  const caps = [];
  const proof = path.join(STUDIO_STATE_DIR, 'proof');
  if (fs.existsSync(proof)) for (const t of fs.readdirSync(proof)) { const d = path.join(proof, t, 'visual', 'after'); if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) caps.push(`- ${path.relative(REPO_ROOT, path.join(d, f))}`); }
  const reports = fs.existsSync(path.join(REPO_ROOT, 'qa', 'reports')) ? fs.readdirSync(path.join(REPO_ROOT, 'qa', 'reports')).sort().slice(-5).map((f) => `- qa/reports/${f}`) : [];
  const unmet = nextOpen(milestones(), 2).flatMap((m) => m.exit.filter((e) => !e.met).map((e) => `- ${m.id} ${m.title}: ${e.text}`));
  const brief = `# Development cycle (${new Date(now).toISOString()}): ${why}\n\nYou own where the game goes next. Review what landed and what it looks like against studio/bible and the charter, then add new ideas and content tasks (each with a measurable proof). Never re-list done work. Don't wait for the dev: assumptions are fine when marked.\n\n## Landed since the last cycle\n${landed.join('\n') || '- nothing'}\n\n## Newest captures\n${caps.slice(-12).join('\n') || '- none yet: ask for before/after captures'}\n\n## Playtest reports\n${reports.join('\n') || '- none'}\n\n## Unmet exit criteria (next milestones)\n${unmet.join('\n') || '- none: propose the next milestone'}\n\n## Filed by this cycle\n${filed.map((f) => `- ${f}`).join('\n') || '- nothing new'}\n`;
  fs.mkdirSync(path.dirname(BRIEF()), { recursive: true });
  fs.writeFileSync(BRIEF(), brief);
  fs.writeFileSync(FILE(), `${JSON.stringify({ last: now, why }, null, 2)}\n`);
  const woke = [];
  if (wake && process.env.STUDIO_DEV_CYCLE_WAKE !== 'off') {
    try {
      const { wake: w } = await import('./agent.mjs');
      for (const role of ['director', 'producer']) { const r = w(role, { why: `development cycle (${why}): read .studio/briefs/dev-cycle.md`, auto: true }); if (r.started) woke.push(r.agent); }
    } catch {}
  }
  emitEvent({ type: 'dev.cycle', agent: 'watchdog', to: 'director', msg: `Development cycle (${why}): ${landed.length} landing(s), ${unmet.length} unmet criteria, filed ${filed.length}${woke.length ? `, woke ${woke.join(', ')}` : ''}`, meta: { filed, why } });
  return { ran: true, why, filed, woke, brief: path.relative(REPO_ROOT, BRIEF()) };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const r = await cyclePass({ force: process.argv.includes('--force') });
  console.log(process.argv.includes('--json') ? JSON.stringify(r) : r.ran ? `Cycle ran (${r.why}); brief ${r.brief}; filed ${r.filed.join(', ') || 'nothing'}` : `No cycle: ${r.why}`);
}
