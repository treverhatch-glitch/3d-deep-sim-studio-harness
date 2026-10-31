#!/usr/bin/env node
/**
 * harness/watch.mjs — the studio's watcher. A script, not a model: it costs no tokens.
 *
 *   npm run watch                        one pass: report, requeue abandoned work, ping the Producer if needed
 *   node harness/watch.mjs --loop 300    a pass every 5 minutes
 *   node harness/watch.mjs --dry-run     report only, change nothing
 *
 * Options: --stall <min> (default 30) silence before a working agent counts as stalled,
 *          --wait <min> (default 60) how long handed-back work may sit before the Producer hears.
 *
 * What it does on its own (safe, mechanical):
 *   - A task in progress whose claim expired or was never made goes back to the top of the queue,
 *     with a handoff note naming the last agent and when it was last heard from.
 *   - 2.58.0 (PU-39): a launcher session whose process is alive but whose heartbeat is older than
 *     STUDIO_STALL_RELEASE_MIN (30; 0 = off) hands its task back, frees its claims and its slot. Nothing is killed.
 *   - Starting agents (the Producer check-in, filling idle slots) only with auto-start on
 *     (npm run mode -- autostart on --by <name>; off by default since 2.58.0).
 * What it hands to the Producer (one "Watch:" task at a time, never one per finding):
 *   - agents holding a task but silent past --stall, handed-back work nobody picked up past --wait,
 *     and providers that ran out (route.exhausted) in the last hour.
 */
import fs from 'node:fs';
import { producerWake, producerLaunched } from './producer-wake.mjs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, readRecentEvents, emitEvent } from './event.mjs';
import { parseNextQueue, writeNextQueue, pauseTask, addTask, readTaskHandoff, withBoard } from './task.mjs';
import { holdReason } from './task-hold.mjs';
import { listLocks, release, sweepBrokenLocks } from './lock.mjs';
import { writeAtomic } from './fsafe.mjs';
import { collectIdeas } from './ideas.mjs';
import { trickPass } from './tricks.mjs';
import { listDivisions } from './divisions.mjs';
import { sessions, fillAgents, startAgent, markGone, saveWorkOf, AGENTS_DIR } from './agent.mjs';
import { effectiveMode, AUTOSTART_OFF } from './mode.mjs';
import { expireAsks } from './ask.mjs';
import { expireDesigns } from './art.mjs';

const readGatesLast = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(STUDIO_STATE_DIR, 'gates-last.json'), 'utf8'));
  } catch {
    return null;
  }
};

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? Number(process.argv[i + 1]) : fallback;
};
const ago = (ms) => `${Math.max(0, Math.round((Date.now() - ms) / 60000))} min`;

// A free, mechanical summary for the next agent: what the last one said, and what is uncommitted.
function trail(events, agent) {
  const said = events.filter((e) => e.agent === agent && e.msg).slice(-3).map((e) => `- ${e.ts.slice(11, 16)} ${e.type}: ${e.msg}${e.target ? ` (${e.target})` : ''}`);
  const st = spawnSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
  const dirty = st.status === 0 ? st.stdout.split('\n').filter(Boolean).filter((l) => !/\s(\.studio|studio\/(NEXT\.md|DONE\.md|CURRENT_TASK\.md|handoffs|producer|meetings|game|memory\/retros|balance\/latest|fun\/latest))/.test(l)) : [];
  return [
    said.length ? `Its last words:\n${said.join('\n')}` : 'It left no messages.',
    dirty.length ? `Uncommitted changes in the repo (check before you continue):\n${dirty.slice(0, 8).map((l) => `- ${l.trim()}`).join('\n')}${dirty.length > 8 ? `\n- …and ${dirty.length - 8} more` : ''}` : 'No uncommitted changes.',
  ].join('\n');
}

/** When the watcher's last pass ran (.studio/watch-last.json), or NaN when it never ran here. */
export function lastPassAt() {
  try {
    return Date.parse(JSON.parse(fs.readFileSync(path.join(STUDIO_STATE_DIR, 'watch-last.json'), 'utf8')).at);
  } catch {
    return NaN;
  }
}

/** STUDIO_STALL_RELEASE_MIN (default 30): minutes of heartbeat silence before a live session's task is freed; 0 turns it off. */
export function stallReleaseMin(env = process.env) {
  const v = env.STUDIO_STALL_RELEASE_MIN;
  if (v === undefined || v === '') return 30;
  if (/^(off|no|false|none)$/i.test(String(v))) return 0;
  return Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 30;
}

/**
 * 2.58.0 (PU-39, P-050): a launcher session whose process is alive but whose heartbeat is older than
 * STUDIO_STALL_RELEASE_MIN held its slot and its task forever: the launcher started no one in its place, nobody
 * else could hand the task back, and the watcher only reported "stalled". Past the threshold the watcher now saves
 * its uncommitted work (as a hand-back does), hands its tasks back with a note, frees its claims, marks the
 * session ended ("stalled") so its slot is free, and says so in an event. It kills NOTHING: the process is left
 * alone (a frozen machine that wakes up, or a pid that now belongs to something else, must not be killed).
 * A machine that slept stops every heartbeat and the watcher alike: when the watcher's own last pass
 * (`prevPassAt`, from .studio/watch-last.json) is older than the threshold, nothing is freed this pass; the
 * next pass, minutes later, sees whether the heartbeats came back.
 */
export function releaseStalled({ now = Date.now(), dryRun = false, events = readRecentEvents(2000), list = sessions(), prevPassAt = lastPassAt() } = {}) {
  const min = stallReleaseMin();
  if (!(min > 0)) return [];
  const away = Number.isFinite(prevPassAt) && now - prevPassAt > min * 60000 ? Math.round((now - prevPassAt) / 60000) : 0;
  const out = [];
  for (const s of list) {
    if (!s.running) continue;
    const beat = Date.parse(s.lastBeat || s.startedAt || '');
    if (!Number.isFinite(beat) || now - beat < min * 60000) continue;
    const age = Math.round((now - beat) / 60000);
    if (away) {
      out.push({ agent: s.agent, tasks: [], age, patches: [], skipped: true, msg: `${s.agent}'s heartbeat is ${age} min old, but the watcher itself last ran ${away} min ago (the machine may have slept): not freed this pass` });
      continue;
    }
    const mine = listLocks().filter((l) => l.owner === s.agent);
    const held = mine.filter((l) => l.key.startsWith('task:')).map((l) => l.key.slice(5));
    const pids = [...new Set([s.pid, s.supervisor].filter(Boolean))].join(', ') || 'unknown';
    if (dryRun) {
      out.push({ agent: s.agent, tasks: held, age, patches: [], msg: `Would free ${s.agent}: silent ${age} min with its process alive (pid ${pids})${held.length ? `; would hand back ${held.join(', ')}` : ''}; nothing would be killed` });
      continue;
    }
    const patches = [];
    for (const t of held) {
      let patch = null;
      try {
        patch = saveWorkOf(s.agent, t, mine, s);
      } catch {
        // saving the work is a help, never a blocker
      }
      if (patch) patches.push(patch);
      const note = `${s.agent} (${s.role}, ${s.tool}/${s.model}) went silent: its process is still alive (pid ${pids}) but its last heartbeat was ${age} min ago (STUDIO_STALL_RELEASE_MIN=${min}). The watcher handed ${t} back and freed its claims; nothing was killed.${patch ? ` Its uncommitted work is saved to ${patch} (git apply it to continue).` : ' No uncommitted work under its claims.'} If it wakes up it may still commit: check git log --grep ${t} before redoing anything.\n${trail(events, s.agent)}`;
      pauseTask(t, s.agent, note, { force: true });
    }
    // Its other claims (folders, files) go too, so its lane is free.
    for (const l of listLocks().filter((x) => x.owner === s.agent)) release(l.key, s.agent);
    const file = path.join(AGENTS_DIR, `${s.agent}.json`);
    const reason = `stalled: no heartbeat for ${age} min while its process was alive; the watcher freed its task and slot and killed nothing`;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      writeAtomic(file, `${JSON.stringify({ ...raw, status: 'ended', endedAt: new Date(now).toISOString(), reason, stalledRelease: { at: new Date(now).toISOString(), beatAgeMin: age, tasks: held, killed: false } }, null, 2)}\n`, { fsync: false });
    } catch {
      // the record is gone already: nothing holds the slot
    }
    const msg = `${s.agent} was silent ${age} min with its process alive (pid ${pids}): ${held.length ? `handed back ${held.join(', ')}, ` : ''}freed its claims and its slot. Nothing was killed: the process is left running; end it by hand if it is stuck.`;
    emitEvent({ type: 'agent.stall_released', agent: 'watch', to: 'producer', status: 'warn', task: held[0], msg, meta: { stalledAgent: s.agent, role: s.role, pid: s.pid || null, supervisor: s.supervisor || null, beatAgeMin: age, thresholdMin: min, tasks: held, patches, killed: false } });
    out.push({ agent: s.agent, tasks: held, age, patches, msg });
  }
  return out;
}

export function watchPass({ stallMin = 30, waitMin = 60, dryRun = false } = {}) {
  const now = Date.now();
  const findings = [];
  // 2.57.0 (PU-16, P-037): lock files nobody can read (an agent killed while writing one) are set aside to
  // .studio/locks/broken/ once they are older than STUDIO_BROKEN_LOCK_GRACE_SEC (10), so no claim trips on them.
  for (const f of sweepBrokenLocks({ dryRun })) findings.push({ kind: 'lock', msg: `${dryRun ? 'Would set aside' : 'Set aside'} the unreadable lock file .studio/locks/${f} (in .studio/locks/broken/)`, producer: false });
  // 2.58.0 (PU-39): a live but long-silent session gives its task and its slot back (nothing is killed).
  for (const r of releaseStalled({ now, dryRun })) findings.push({ kind: r.skipped ? 'stalled' : 'released', agent: r.agent, task: r.tasks[0], msg: r.msg, producer: false });
  const q = parseNextQueue();
  const locks = listLocks();
  const events = readRecentEvents(2000);
  const heard = new Map(); // agent -> last event time
  const lastOnTask = new Map(); // task -> { agent, at }
  for (const e of events) {
    const at = Date.parse(e.ts) || 0;
    if (e.agent) heard.set(e.agent, Math.max(heard.get(e.agent) || 0, at));
    if (e.task) lastOnTask.set(e.task, { agent: e.agent, at, type: e.type });
  }
  const holder = new Map(locks.filter((l) => l.key.startsWith('task:')).map((l) => [l.key.slice(5), l]));
  if (!dryRun) for (const a of markGone()) findings.push({ kind: 'gone', agent: a, msg: `${a}'s process is gone; its session is marked ended`, producer: false });
  const agentSessions = sessions();
  for (const s of agentSessions.filter((x) => x.stalled)) findings.push({ kind: 'stalled', agent: s.agent, msg: `${s.agent} (${s.role}) is running but its heartbeat stopped ${s.beatAgeMin} min ago`, producer: true });

  for (const t of q.inProgress) {
    const lock = holder.get(t.id);
    const last = lastOnTask.get(t.id);
    if (!lock) {
      // Nobody holds it any more: put it back where any agent can take it.
      if (/^Check forced done|^Watch:/i.test(t.title) || t.role === 'producer' || t.role === 'human') continue;
      const note = last ? `The claim ran out. Last heard from ${last.agent} ${ago(last.at)} ago (${last.type}).\n${trail(events, last.agent)}` : 'In progress with no claim and no activity on record.';
      if (!dryRun) pauseTask(t.id, 'watch', note, { force: true });
      findings.push({ kind: 'requeued', task: t.id, msg: `${t.id} requeued: ${note}`, producer: false });
      continue;
    }
    // A launcher session that has ended but still holds the task: hand it back now (test #2: the
    // watcher called agents "silent 34 min" that agent list already showed as ended).
    const session = agentSessions.find((s) => s.agent === lock.owner);
    // 2.55.0 (P-028): a session that ended before this claim was made isn't its holder (a chat bot claiming under
    // the same name later); the claim stays, and the silence check below still applies.
    const staleRecord = session && !session.running && session.endedAt && Date.parse(lock.claimedAt || '') > Date.parse(session.endedAt);
    if (session && !session.running && !staleRecord) {
      const note = `${lock.owner}'s session ended (${session.reason || 'no reason recorded'}) while it held ${t.id}.\n${trail(events, lock.owner)}`;
      if (!dryRun) pauseTask(t.id, 'watch', note, { force: true });
      findings.push({ kind: 'requeued', task: t.id, msg: `${t.id} requeued: ${lock.owner} ended without handing it back`, producer: false });
      continue;
    }
    // A launcher heartbeat counts as being heard from, even if the agent is quiet in the log.
    const lastHeard = Math.max(heard.get(lock.owner) || 0, session?.running && session.lastBeat ? Date.parse(session.lastBeat) : 0);
    if (now - lastHeard > stallMin * 60000) {
      findings.push({ kind: 'stalled', task: t.id, agent: lock.owner, msg: `${lock.owner} holds ${t.id} but has been silent ${lastHeard ? `for ${ago(lastHeard)}` : 'since it claimed it'}`, producer: true });
    }
  }

  // Path claims left behind by a launcher session that has ended (crashed, killed, out of usage) block
  // every other agent from that folder until they expire. Release them now (Jed's run).
  for (const l of locks) {
    if (l.key.startsWith('task:')) continue;
    const s = agentSessions.find((x) => x.agent === l.owner);
    if (!s || s.running) continue;
    // Only claims from that session: a person reusing the name later keeps theirs.
    if (s.endedAt && Date.parse(l.claimedAt) > Date.parse(s.endedAt)) continue;
    if (!dryRun) release(l.key, l.owner);
    findings.push({ kind: 'released', agent: l.owner, msg: `Released ${l.key}: ${l.owner}'s session has ended`, producer: false });
  }

  for (const t of q.backlog) {
    const last = lastOnTask.get(t.id);
    // Held on purpose (after another task, blocked, parked, cooling down): not waiting for an agent.
    const held = holdReason(t.id, q, now);
    if (held) {
      if (last && now - last.at >= waitMin * 60000 && readTaskHandoff(t.id)) findings.push({ kind: 'held', task: t.id, msg: `${t.id} is held: ${held}`, producer: false });
      continue;
    }
    if (last?.type === 'task.paused' && now - last.at > waitMin * 60000 && readTaskHandoff(t.id)) {
      const wip = fs.existsSync(path.join(STUDIO_STATE_DIR, 'wip')) ? fs.readdirSync(path.join(STUDIO_STATE_DIR, 'wip')).find((f) => f.startsWith(`${t.id}-`)) : null;
      findings.push({ kind: 'waiting', task: t.id, msg: `${t.id} was handed back ${ago(last.at)} ago and is waiting for a ${t.role || 'free'} agent (npm run agent -- start --role ${t.role || 'builder'} --agent <name>)${wip ? `; saved work in .studio/wip/${wip}` : ''}`, producer: true });
    }
  }

  const capped = events.filter((e) => e.type === 'route.capped' && now - Date.parse(e.ts) < 3600000);
  if (capped.length) findings.push({ kind: 'exhausted', msg: `The daily spend cap stopped ${capped.length} model call(s) in the last hour (STUDIO_DAILY_TOKEN_CAP)`, producer: true });
  // An outage the Producer already closed never pages again, and one failed call isn't an outage
  // (test #2: two reviewer 503s on a done task opened four Watch tasks, about 12 Producer sessions).
  const closedWatch = events.filter((e) => e.type === 'task.done' && /Watch:/.test(e.msg || '')).map((e) => Date.parse(e.ts)).pop() || 0;
  const exhausted = events.filter((e) => e.type === 'route.exhausted' && now - Date.parse(e.ts) < 3600000 && Date.parse(e.ts) > closedWatch);
  if (exhausted.length >= 2) findings.push({ kind: 'exhausted', msg: `Every provider was busy or out ${exhausted.length} time(s) in the last hour (${[...new Set(exhausted.map((e) => e.agent))].join(', ')})`, producer: true });

  // One ping for the Producer, only when something needs a decision and no Watch task is open yet.
  const forProducer = findings.filter((f) => f.producer);
  const open = [...q.inProgress, ...q.backlog].find((t) => /^Watch:/.test(t.title));
  let pinged = null;
  if (forProducer.length && !open && !dryRun) {
    const counts = ['stalled', 'waiting', 'exhausted'].map((k) => [k, forProducer.filter((f) => f.kind === k).length]).filter(([, n]) => n);
    const words = { stalled: 'stalled', waiting: 'waiting for an agent', exhausted: 'provider outage' };
    pinged = addTask({ agent: 'watch', title: `Watch: ${counts.map(([k, n]) => `${n} ${words[k]}`).join(', ')} (run npm run watch for details)`, role: 'producer', priority: 'P1' });
    emitEvent({ type: 'watch.alert', agent: 'watch', to: 'producer', task: pinged.id, msg: forProducer.map((f) => f.msg).join('; ').slice(0, 300) });
  } else if (findings.length && !dryRun) {
    emitEvent({ type: 'watch.report', agent: 'watch', msg: findings.map((f) => f.msg).join('; ').slice(0, 300) });
  }
  // A Watch task nobody has started, whose findings have all cleared: close it, so no Producer session
  // is spent confirming "all quiet" (test #2, T-197).
  if (open && !forProducer.length && !dryRun && q.backlog.some((t) => t.id === open.id)) {
    const closed = withBoard(() => {
      const q2 = parseNextQueue();
      const i = q2.backlog.findIndex((t) => t.id === open.id);
      if (i < 0) return null;
      const [t] = q2.backlog.splice(i, 1);
      t.status = 'done';
      q2.done.unshift(t);
      writeNextQueue(q2);
      return t;
    });
    if (closed) emitEvent({ type: 'task.done', agent: 'watch', task: closed.id, msg: `${closed.id} closed by the watcher: what it reported (Watch:) has cleared` });
  }
  // New ideas from the Idea Board: one "Ideas:" task for the Producer, never one per idea.
  const ideas = dryRun ? null : collectIdeas();
  // A game made before 2.25 gets its ID here, without anyone asking.
  if (!dryRun) import('./game-id.mjs').then(({ ensureGameId }) => import('./cartridge.mjs').then(({ activeCartridge }) => ensureGameId(activeCartridge().name, { by: 'watch' }))).catch(() => {});
  // The dev hacker's cards reach the Producer in one batch; hunts are queued only while its lab is open.
  if (!dryRun) trickPass({ queue: parseNextQueue(), divisions: listDivisions(), gates: readGatesLast() }).catch(() => {});
  // The mode decides whether agents start on their own, and how often the Producer checks in.
  const decided = dryRun ? [] : expireAsks(now);
  // Designs left waiting past the pace's limit: the Producer approves them provisionally (logged).
  if (!dryRun) expireDesigns(now).catch(() => {});
  // Owed reviews (no reviewer of another family answered): try each again once its reviewer resets.
  if (!dryRun) {
    import('./review.mjs')
      .then(({ dueOwed, markTried }) => {
        for (const o of dueOwed(now)) {
          markTried(o.task);
          const c = spawn(process.execPath, [path.join(REPO_ROOT, 'harness', 'review.mjs'), o.task], { cwd: REPO_ROOT, detached: true, stdio: 'ignore' });
          c.unref();
          emitEvent({ type: 'review.retry', agent: 'watch', task: o.task, msg: `Trying the owed review of ${o.task} again` });
        }
      })
      .catch(() => {});
  }
  // The launcher answers asynchronously; its result lands in watch-last.json and the event log.
  if (!dryRun) {
    fillAgents()
      .then((r) => {
        if (r.started.length) console.log(`[watch] started ${r.started.join(', ')}`);
        try {
          const f = path.join(STUDIO_STATE_DIR, 'watch-last.json');
          writeAtomic(f, `${JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), launched: r.started, launchWhy: r.why || null }, null, 2)}\n`, { fsync: false });
        } catch {
          // the pass hasn't written yet
        }
      })
      .catch(() => {});
  }
  const launched = null;
  // 2.30 (G1): the opt-in watchdog (off unless the dev turned it on).
  if (!dryRun) import('./watchdog.mjs').then(({ watchdogPass }) => watchdogPass(now)).catch(() => {});
  if (!dryRun) import('./alerts.mjs').then(({ alertPass }) => alertPass()).catch(() => {});
  const checkin = dryRun ? null : producerCheckinIfDue(now, events);
  const report = { at: new Date(now).toISOString(), findings, pinged: pinged?.id || null, openWatchTask: open?.id || null, ideas, launched: launched?.started || [], checkin, decided };
  if (!dryRun) {
    writeAtomic(path.join(STUDIO_STATE_DIR, 'watch-last.json'), JSON.stringify(report, null, 2) + '\n', { fsync: false });
  }
  return report;
}

/**
 * Every mode.producerEveryHours: tell the Producer to check in, and start a Producer agent if one can start on its own
 * and auto-start is on (npm run mode -- autostart on --by <name>; off by default since 2.58.0).
 */
export function producerCheckinIfDue(now = Date.now(), events = readRecentEvents(3000)) {
  const mode = effectiveMode();
  const last = events.filter((e) => e.type === 'producer.checkin').at(-1);
  if (last && now - Date.parse(last.ts) < mode.producerEveryHours * 3600000) return null;
  const running = sessions().some((s) => s.running && s.role === 'producer');
  const could = !running && (process.env.STUDIO_PRODUCER_CMD || process.env.STUDIO_PRODUCER_TOOL || (mode.autoLaunch && process.env.STUDIO_AGENT_TOOL));
  // 2.58.0 (crew report): with auto-start off (the default) the check-in still pings and logs, and starts nothing.
  const off = could && !mode.autostart;
  emitEvent({ type: 'producer.checkin', agent: 'watch', to: 'producer', msg: `Producer check-in (${mode.label}${mode.boost ? ' + MAX SPEED' : ''}, every ${mode.producerEveryHours} h): read the handoff, accept or reopen forced work, unblock stalled agents, keep the queue fed${off ? `. No Producer session was started: ${AUTOSTART_OFF}` : ''}`, ...(off ? { meta: { autostart: false } } : {}) });
  if (off) return { pinged: true, started: null, autostartOff: true, why: `not started: ${AUTOSTART_OFF}` };
  // 2.30c (#11): the check-in is logged on its clock, but a Producer session starts only when something happened.
  const wake = !running ? producerWake({ now, events: readRecentEvents(5000), queue: parseNextQueue(), commit: true }) : null;
  if (wake && !wake.wake) return { pinged: true, started: null, why: `not started: ${wake.why}` };
  if (could) {
    producerLaunched(now);
    const r = startAgent({ role: 'producer', agent: process.env.STUDIO_PRODUCER_NAME || 'producer-1' }, { detach: true });
    return { pinged: true, started: r.ok ? r.agent : null, why: r.ok ? null : r.message };
  }
  return { pinged: true, started: null };
}

function print(r) {
  if (!r.findings.length) console.log(`[watch] ${r.at} all quiet`);
  for (const f of r.findings) console.log(`[watch] ${f.kind.padEnd(9)} ${f.msg}`);
  if (r.pinged) console.log(`[watch] Producer pinged: ${r.pinged}`);
  else if (r.openWatchTask && r.findings.some((f) => f.producer)) console.log(`[watch] Producer already has ${r.openWatchTask} open; not pinging again`);
  if (r.launched?.length) console.log(`[watch] started ${r.launched.join(', ')}`);
  if (r.checkin) console.log(`[watch] Producer check-in${r.checkin.started ? `: started ${r.checkin.started}` : r.checkin.autostartOff ? ` (${r.checkin.why})` : ''}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const opts = { stallMin: arg('stall', 30), waitMin: arg('wait', 60), dryRun: process.argv.includes('--dry-run') };
  const loop = arg('loop', 0);
  print(watchPass(opts));
  if (loop > 0) setInterval(() => print(watchPass(opts)), loop * 1000);
}
