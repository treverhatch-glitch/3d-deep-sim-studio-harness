/**
 * harness/gamedev-loop.mjs — 2.30o: the studio supervises itself; an attending game dev is optional.
 *
 * In the Marina run the watchdog only ran in away mode and the studio assumed a person (or the attending
 * agent) would notice an empty queue, judge the pictures and feed tasks. Nobody did for hours. Now, while a
 * studio has an active game, every watch pass (a few minutes apart) runs this loop:
 *   stall   running sessions with no progress / a read-only burn / past their wall clock are ended
 *   (a)     fewer than 4 builder tasks open: the Producer refill (harness/producer-refill.mjs)
 *   (b)     a milestone whose exit criteria are all met is closed for the Director and the next one opens
 *   (c)     idle builder slots with ready tasks are filled (fillAgents)
 *   (d)     after landings: the layout gate and visual results; failures become tasks
 *   (e)     spend guards: a tool at its guard is marked out like a quota error, so the next tool in the budget
 *           order takes over (harness/spend-guard.mjs), and a person is told
 *   (g)     the standing Director/Producer development cycle (harness/dev-cycle.mjs)
 *   (f)     every STUDIO_REVIEW_MIN (60) a zero-token game-dev review compares the newest captures with the last
 *           review's and files quality tasks (e.g. "scene unchanged"); with STUDIO_REVIEWER_TOOL set it also
 *           wakes a cheap reviewer session to judge the captures against the charter
 * Away mode (npm run away -- on) means more autonomy, not just review logging: the refill keeps 6 open
 * (STUDIO_AWAY_REFILL_MIN), builders start whatever the pace, and the review runs every 30 min.
 * Without the hub: node harness/watchdog.mjs loop 180 (npm run gamedev) runs the pass on its own.
 * Steps are skipped one by one with STUDIO_GAMEDEV_SKIP=stall,refill,milestones,launch,landing,tiers,review,cycle.
 * State: .studio/gamedev.json. Every action is an event from "watchdog".
 */
import fs from 'node:fs';
import path from 'node:path';
import { STUDIO_STATE_DIR, REPO_ROOT, emitEvent, readRecentEvents } from './event.mjs';

const FILE = () => path.join(STUDIO_STATE_DIR, 'gamedev.json');
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const skip = (k) => String(process.env.STUDIO_GAMEDEV_SKIP || '').split(',').map((s) => s.trim()).includes(k);

/** Is a game active (so the loop runs without anyone turning it on)? */
export async function gameActive() {
  try {
    const { activeGame } = await import('./cartridge.mjs');
    const g = activeGame();
    return Boolean(g?.name && ['STUDIO_GAME', 'studio/game.json game'].includes(g.from));
  } catch { return false; }
}

const newestPngs = () => {
  const root = path.join(STUDIO_STATE_DIR, 'proof');
  const best = {};
  if (!fs.existsSync(root)) return best;
  for (const t of fs.readdirSync(root)) {
    const d = path.join(root, t, 'visual', 'after');
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.png'))) {
      const p = path.join(d, f); const m = fs.statSync(p).mtimeMs;
      if (!best[f] || best[f].m < m) best[f] = { p, m, task: t };
    }
  }
  return best;
};

export async function gamedevPass(now = Date.now(), { events = readRecentEvents(5000) } = {}) {
  const st = read(FILE(), {});
  // 2.30o: away mode means more autonomy: a deeper queue, launches whatever the pace, more frequent reviews.
  let away = false;
  try { away = Boolean((await import('./away.mjs')).readAway().on); } catch {}
  const last = st.lastPass || 0;
  const actions = [];
  const { fileTask, refillPass, milestones, closeMilestone } = await import('./producer-refill.mjs');

  if (!skip('stall')) {
    try {
      const { sessions, stopAgent } = await import('./agent.mjs');
      const { observe, logTokens, logStall, readStall } = await import('./stall.mjs');
      for (const s of sessions().filter((x) => x.running)) {
        let v = readStall(s.agent)?.verdict;
        const fresh = readStall(s.agent)?.startedAt === s.startedAt && (now - Date.parse(s.lastBeat || 0)) < 5 * 60000;
        if (!fresh) {
          let log = ''; try { log = fs.readFileSync(path.join(REPO_ROOT, s.log || ''), 'utf8').slice(-2000000); } catch {}
          v = observe(s, { tokens: logTokens(log), cwd: s.copy?.dir ? path.join(REPO_ROOT, s.copy.dir) : REPO_ROOT, now, events });
        }
        if (v?.stalled && !s.stalled) { logStall(s, v); stopAgent(s.pid); actions.push({ kind: 'stall', msg: `ended ${s.agent}: ${v.why}` }); }
      }
    } catch (e) { actions.push({ kind: 'error', msg: `stall step: ${e.message}` }); }
  }

  if (!skip('milestones')) {
    for (const m of milestones().filter((x) => x.ready)) {
      const next = closeMilestone(m.id, 'director (watchdog)');
      actions.push({ kind: 'milestone', msg: `${m.id} met every exit criterion: closed${next ? `, ${next.id} ${next.title} is next` : ''}` });
      if (process.env.STUDIO_GAMEDEV_WAKE_DIRECTOR !== 'off') { try { (await import('./agent.mjs')).wake('director', { why: `${m.id} closed; confirm and push ${next?.id || 'the next milestone'}` }); } catch {} }
    }
  }

  if (!skip('landing')) {
    const landed = events.filter((e) => e.type === 'task.done' && Date.parse(e.ts) > last).map((e) => e.task).filter(Boolean);
    if (landed.length) {
      try {
        const { runLayoutGate } = await import('./layout-gate.mjs');
        const { studioGame } = await import('./game-gates.mjs');
        const g = await studioGame();
        const lay = runLayoutGate({ gameDir: g?.root });
        if (!lay.skipped) {
          fs.mkdirSync(STUDIO_STATE_DIR, { recursive: true });
          fs.writeFileSync(path.join(STUDIO_STATE_DIR, 'layout-last.json'), `${JSON.stringify({ at: new Date(now).toISOString(), after: landed, ...lay }, null, 2)}\n`);
          for (const f of lay.failed || []) { const r = await fileTask(`layout:${f.rule}`, `Fix layout rule ${f.rule} (after ${landed.join(', ')}): ${String(f.why).slice(0, 160)}`); if (r.id && !r.skipped) actions.push({ kind: 'task', msg: `filed ${r.id}: layout ${f.rule} fails` }); }
        }
      } catch (e) { actions.push({ kind: 'error', msg: `layout step: ${e.message}` }); }
      const { summarize } = await import('./verdict-split.mjs');
      const { parseNextQueue } = await import('./task.mjs');
      const done = parseNextQueue().done;
      for (const id of landed) {
        const t = done.find((x) => x.id === id);
        if (!t) continue;
        const s = summarize(id, t);
        if (s.render && !s.ok) { const r = await fileTask(`visual:${id}`, `Prove ${id} visually: ${s.why.slice(0, 160)}`); if (r.id && !r.skipped) actions.push({ kind: 'task', msg: `filed ${r.id}: ${id} landed without a passing visual result` }); }
      }
    }
  }

  if (!skip('refill')) {
    try { const r = await refillPass(away ? { min: Number(process.env.STUDIO_AWAY_REFILL_MIN ?? 6) } : {}); if (r.refilled.length) actions.push({ kind: 'refill', msg: `queue low: added ${r.refilled.length} task(s) from unmet goals` }); } catch (e) { actions.push({ kind: 'error', msg: `refill step: ${e.message}` }); }
  }

  if (!skip('cycle')) {
    try { const c = await (await import('./dev-cycle.mjs')).cyclePass({ now, events }); if (c.ran) actions.push({ kind: 'cycle', msg: `development cycle (${c.why}): filed ${c.filed.length}` }); } catch (e) { actions.push({ kind: 'error', msg: `cycle step: ${e.message}` }); }
  }

  if (!skip('tiers')) {
    const { spendGuardPass } = await import('./spend-guard.mjs');
    for (const t of spendGuardPass({ now })) actions.push({ kind: 'takeover', msg: t.msg });
  }

  if (!skip('launch') && process.env.STUDIO_WATCHDOG_LAUNCH !== 'off') {
    try { const r = await (await import('./agent.mjs')).fillAgents({ byDirector: true, autonomous: away || process.env.STUDIO_GAMEDEV_AUTOLAUNCH === 'on' }); if (r.started?.length) actions.push({ kind: 'launch', msg: `started ${r.started.join(', ')}` }); } catch (e) { actions.push({ kind: 'error', msg: `launch step: ${e.message}` }); }
  }

  const reviewEvery = Number(away ? process.env.STUDIO_AWAY_REVIEW_MIN ?? 30 : process.env.STUDIO_REVIEW_MIN ?? 60) * 60000;
  if (!skip('review') && reviewEvery > 0 && now - (st.lastReview || 0) >= reviewEvery) {
    const { decodePng } = await import('./png.mjs');
    const { imageDiff, imageStats, visualLimits } = await import('./visual-proof.mjs');
    const shots = newestPngs();
    const baseDir = path.join(STUDIO_STATE_DIR, 'review');
    fs.mkdirSync(baseDir, { recursive: true });
    for (const [cam, s] of Object.entries(shots)) {
      try {
        const img = decodePng(fs.readFileSync(s.p));
        const base = path.join(baseDir, cam);
        const stats = imageStats(img);
        if (stats.blank) { const r = await fileTask(`review:blank:${cam}`, `Game-dev review: the newest ${cam} capture (${s.task}) is ${stats.why}`); if (r.id) actions.push({ kind: 'review', msg: `filed ${r.id}: ${cam} blank` }); }
        else if (fs.existsSync(base) && st.lastReview && imageDiff(decodePng(fs.readFileSync(base)), img) < visualLimits().diffMin) {
          const r = await fileTask(`review:unchanged:${cam}:${Math.floor(now / 86400000)}`, `Game-dev review: the ${cam} view is unchanged since the last review; make a visible improvement from the next unmet charter goal`);
          if (r.id) actions.push({ kind: 'review', msg: `filed ${r.id}: ${cam} unchanged` });
        }
        fs.copyFileSync(s.p, base);
      } catch {}
    }
    if (process.env.STUDIO_REVIEWER_TOOL) { try { (await import('./agent.mjs')).wake('reviewer', { why: 'game-dev review: compare the newest captures in .studio/proof/*/visual/after and .studio/review with studio/bible/CHARTER.md and file quality tasks' }); } catch {} }
    st.lastReview = now;
    actions.push({ kind: 'review-pass', msg: `game-dev review of ${Object.keys(shots).length} camera(s)` });
  }

  fs.mkdirSync(STUDIO_STATE_DIR, { recursive: true });
  fs.writeFileSync(FILE(), `${JSON.stringify({ ...st, lastPass: now }, null, 2)}\n`);
  return actions;
}

