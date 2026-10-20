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
 * What it hands to the Producer (one "Watch:" task at a time, never one per finding):
 *   - agents holding a task but silent past --stall, handed-back work nobody picked up past --wait,
 *     and providers that ran out (route.exhausted) in the last hour.
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, readRecentEvents, emitEvent } from './event.mjs';
import { parseNextQueue, pauseTask, addTask, readTaskHandoff } from './task.mjs';
import { listLocks } from './lock.mjs';
import { collectIdeas } from './ideas.mjs';
import { sessions, fillAgents, startAgent } from './agent.mjs';
import { effectiveMode } from './mode.mjs';
import { expireAsks } from './ask.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? Number(process.argv[i + 1]) : fallback;
};
const ago = (ms) => `${Math.max(0, Math.round((Date.now() - ms) / 60000))} min`;

// A free, mechanical summary for the next agent: what the last one said, and what is uncommitted.
function trail(events, agent) {
  const said = events.filter((e) => e.agent === agent && e.msg).slice(-3).map((e) => `- ${e.ts.slice(11, 16)} ${e.type}: ${e.msg}${e.target ? ` (${e.target})` : ''}`);
  const st = spawnSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
  const dirty = st.status === 0 ? st.stdout.split('\n').filter(Boolean).filter((l) => !/\s(\.studio|studio\/(NEXT\.md|CURRENT_TASK\.md|handoffs|producer|meetings|game|memory\/retros|balance\/latest|fun\/latest))/.test(l)) : [];
  return [
    said.length ? `Its last words:\n${said.join('\n')}` : 'It left no messages.',
    dirty.length ? `Uncommitted changes in the repo (check before you continue):\n${dirty.slice(0, 8).map((l) => `- ${l.trim()}`).join('\n')}${dirty.length > 8 ? `\n- …and ${dirty.length - 8} more` : ''}` : 'No uncommitted changes.',
  ].join('\n');
}

export function watchPass({ stallMin = 30, waitMin = 60, dryRun = false } = {}) {
  const now = Date.now();
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
  const findings = [];
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
    // A launcher heartbeat counts as being heard from, even if the agent is quiet in the log.
    const session = agentSessions.find((s) => s.agent === lock.owner);
    const lastHeard = Math.max(heard.get(lock.owner) || 0, session?.running && session.lastBeat ? Date.parse(session.lastBeat) : 0);
    if (now - lastHeard > stallMin * 60000) {
      findings.push({ kind: 'stalled', task: t.id, agent: lock.owner, msg: `${lock.owner} holds ${t.id} but has been silent ${lastHeard ? `for ${ago(lastHeard)}` : 'since it claimed it'}`, producer: true });
    }
  }

  for (const t of q.backlog) {
    const last = lastOnTask.get(t.id);
    if (last?.type === 'task.paused' && now - last.at > waitMin * 60000 && readTaskHandoff(t.id)) {
      const wip = fs.existsSync(path.join(STUDIO_STATE_DIR, 'wip')) ? fs.readdirSync(path.join(STUDIO_STATE_DIR, 'wip')).find((f) => f.startsWith(`${t.id}-`)) : null;
      findings.push({ kind: 'waiting', task: t.id, msg: `${t.id} was handed back ${ago(last.at)} ago and is waiting for a ${t.role || 'free'} agent (npm run agent -- start --role ${t.role || 'builder'} --agent <name>)${wip ? `; saved work in .studio/wip/${wip}` : ''}`, producer: true });
    }
  }

  const capped = events.filter((e) => e.type === 'route.capped' && now - Date.parse(e.ts) < 3600000);
  if (capped.length) findings.push({ kind: 'exhausted', msg: `The daily spend cap stopped ${capped.length} model call(s) in the last hour (STUDIO_DAILY_TOKEN_CAP)`, producer: true });
  const exhausted = events.filter((e) => e.type === 'route.exhausted' && now - Date.parse(e.ts) < 3600000);
  if (exhausted.length) findings.push({ kind: 'exhausted', msg: `Every provider was busy or out ${exhausted.length} time(s) in the last hour (${[...new Set(exhausted.map((e) => e.agent))].join(', ')})`, producer: true });

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
  // New ideas from the Idea Board: one "Ideas:" task for the Producer, never one per idea.
  const ideas = dryRun ? null : collectIdeas();
  // The mode decides whether agents start on their own, and how often the Producer checks in.
  const decided = dryRun ? [] : expireAsks(now);
  const launched = dryRun ? null : fillAgents();
  const checkin = dryRun ? null : producerCheckinIfDue(now, events);
  const report = { at: new Date(now).toISOString(), findings, pinged: pinged?.id || null, openWatchTask: open?.id || null, ideas, launched: launched?.started || [], checkin, decided };
  if (!dryRun) {
    fs.mkdirSync(STUDIO_STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(STUDIO_STATE_DIR, 'watch-last.json'), JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}

/** Every mode.producerEveryHours: tell the Producer to check in, and start a Producer agent if one can start on its own. */
export function producerCheckinIfDue(now = Date.now(), events = readRecentEvents(3000)) {
  const mode = effectiveMode();
  const last = events.filter((e) => e.type === 'producer.checkin').at(-1);
  if (last && now - Date.parse(last.ts) < mode.producerEveryHours * 3600000) return null;
  emitEvent({ type: 'producer.checkin', agent: 'watch', to: 'producer', msg: `Producer check-in (${mode.label}${mode.boost ? ' + MAX SPEED' : ''}, every ${mode.producerEveryHours} h): read the handoff, accept or reopen forced work, unblock stalled agents, keep the queue fed` });
  const running = sessions().some((s) => s.running && s.role === 'producer');
  if (!running && (process.env.STUDIO_PRODUCER_CMD || process.env.STUDIO_PRODUCER_TOOL || (mode.autoLaunch && process.env.STUDIO_AGENT_TOOL))) {
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
  if (r.checkin) console.log(`[watch] Producer check-in${r.checkin.started ? `: started ${r.checkin.started}` : ''}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const opts = { stallMin: arg('stall', 30), waitMin: arg('wait', 60), dryRun: process.argv.includes('--dry-run') };
  const loop = arg('loop', 0);
  print(watchPass(opts));
  if (loop > 0) setInterval(() => print(watchPass(opts)), loop * 1000);
}
