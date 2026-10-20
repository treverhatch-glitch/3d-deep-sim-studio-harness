#!/usr/bin/env node
/**
 * harness/handoff.mjs — the Producer's briefing, built from files only (no model, no tokens).
 *
 *   npm run handoff                              print the briefing and save .studio/briefs/producer.md
 *   node harness/handoff.mjs --json              the same data as JSON
 *   node harness/handoff.mjs note "<text>"       add an entry to studio/producer/LOG.md
 *
 * Whoever the Producer is (Grok, Claude, Hermes, Cursor, a person), this is what it reads before it
 * assigns work: the plan, why things were decided, the queue, who holds what, what passed or
 * failed, open bugs, sign-offs, lessons and meetings. studio/MASTER.md maps the documents behind it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, readRecentEvents } from './event.mjs';
import { parseNextQueue } from './task.mjs';
import { listLocks } from './lock.mjs';
import { readLog, addLogNote } from './producer-log.mjs';
import { activeMeeting, MEETINGS_DIR } from './meeting.mjs';
import { watchPass } from './watch.mjs';
import { buildScorecard, renderScorecard } from './scorecard.mjs';
import { latestRetro } from './retro.mjs';
import { readNotes } from './notes.mjs';
import { readBible, checkBible, latestReview, readIdeas, PLAY_LENGTHS } from './bible.mjs';
import { driftReport } from './director.mjs';
import { repeats, staleSuggestions } from './learn.mjs';

const read = (rel) => {
  try {
    return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return null;
  }
};
const readJson = (rel) => {
  try {
    return JSON.parse(read(rel));
  } catch {
    return null;
  }
};
const mtime = (rel) => {
  try {
    return fs.statSync(path.join(REPO_ROOT, rel)).mtimeMs;
  } catch {
    return null;
  }
};
// When a document last changed: its last commit if it has no local edits (a fresh clone resets
// file times), otherwise the file's own time.
const changed = (rel) => {
  const m = mtime(rel);
  if (m == null) return null;
  const dirty = spawnSync('git', ['status', '--porcelain', '--', rel], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (dirty.status !== 0 || dirty.stdout.trim()) return m;
  const log = spawnSync('git', ['log', '-1', '--format=%ct', '--', rel], { cwd: REPO_ROOT, encoding: 'utf8' });
  const t = Number(log.stdout.trim()) * 1000;
  return log.status === 0 && t ? t : m;
};
const age = (ms) => {
  if (ms == null) return 'missing';
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};
const section = (text, heading) => {
  if (!text) return '';
  const m = text.match(new RegExp(`^## ${heading}[^\\n]*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm'));
  return m ? m[1].trim() : '';
};
const git = (...a) => {
  const r = spawnSync('git', a, { cwd: REPO_ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};

export function buildHandoff() {
  const q = parseNextQueue();
  const locks = listLocks();
  const owner = new Map(locks.filter((l) => l.key.startsWith('task:')).map((l) => [l.key.slice(5), l.owner]));
  const plan = read('studio/PLAN.md');
  const gates = readJson('.studio/gates-last.json');
  const trace = readJson('.studio/last-seed-failure.json');
  const events = readRecentEvents(600);
  const dayAgo = Date.now() - 24 * 3600 * 1000;

  // Latest playtest report.
  let playtest = null;
  const rep = path.join(REPO_ROOT, 'qa', 'reports');
  if (fs.existsSync(rep)) {
    const f = fs.readdirSync(rep).filter((n) => /^qa_.*\.json$/.test(n)).sort().pop();
    const r = f && readJson(`qa/reports/${f}`);
    if (r) playtest = { file: `qa/reports/${f}`, passed: r.passed, at: r.timestamp, seed: r.stage1?.seed, ticks: r.stage1?.ticksRun, failingTick: r.stage1?.failingTick, finding: r.stage1?.findings?.[0]?.summary };
  }

  // Escalations since the last clean closed-loop pass.
  const escalations = [];
  for (const e of events.slice().reverse()) {
    if (e.type === 'closedloop.pass') break;
    if (e.type === 'closedloop.escalate') escalations.push({ ts: e.ts, task: e.task, msg: e.msg });
  }

  // Who did what in the last 24 hours.
  const activity = new Map();
  for (const e of events) {
    if (!e.agent || Date.parse(e.ts) < dayAgo) continue;
    const a = activity.get(e.agent) || { agent: e.agent, events: 0 };
    a.events += 1;
    a.last = e.msg;
    a.at = e.ts;
    activity.set(e.agent, a);
  }

  // Decision records, newest first.
  const decDir = path.join(REPO_ROOT, 'studio', 'decisions');
  const decisions = fs.existsSync(decDir)
    ? fs.readdirSync(decDir).filter((f) => f.endsWith('.md')).sort().reverse().slice(0, 5).map((f) => {
        const t = read(`studio/decisions/${f}`) || '';
        return { file: `studio/decisions/${f}`, title: (t.match(/^#\s+(.+)$/m) || [, f])[1], status: (t.match(/\*\*Status\*\*:\s*(.+)/) || [, ''])[1].trim() };
      })
    : [];

  // Meetings, newest first.
  const meetings = fs.existsSync(MEETINGS_DIR)
    ? fs.readdirSync(MEETINGS_DIR).filter((f) => f.endsWith('.md') && f !== 'README.md').sort().reverse().slice(0, 3).map((f) => {
        const t = read(`studio/meetings/${f}`) || '';
        return { file: `studio/meetings/${f}`, topic: (t.match(/^# Meeting:\s*(.+)$/m) || [, f])[1], decisions: section(t, 'Decisions').split('\n').filter((l) => l.startsWith('- ')).slice(0, 3) };
      })
    : [];

  // Lessons: the newest three headings.
  const lessons = ((read('studio/memory/failures.md') || '').split('## Recorded Distilled Notes')[1] || '').match(/^### .+$/gm)?.slice(-3).reverse().map((l) => l.slice(4)) || [];

  // Key documents from the master index, with how fresh each is.
  const master = read('studio/MASTER.md') || '';
  const docs = [...new Set([...master.matchAll(/^\| `([^`]+)`/gm)].map((m) => m[1]))].map((rel) => ({ rel, updated: changed(rel.replace(/\/$/, '')) }));

  const firstLine = (rel) => (read(rel) || '').split('\n').find((l) => l.trim()) || null;
  const signoff = (rel) => {
    const t = read(rel);
    if (t == null) return null;
    // Signed off: a person's decision file (War Room "Sign off", or written by hand) newer than the report.
    const dir = path.dirname(rel);
    const pattern = rel.includes('/fun/') ? /^review-.*\.md$/ : /^decision-.*\.md$/;
    const updated = changed(rel);
    const decisions = fs.existsSync(path.join(REPO_ROOT, dir)) ? fs.readdirSync(path.join(REPO_ROOT, dir)).filter((f) => pattern.test(f)).map((f) => mtime(`${dir}/${f}`) || 0) : [];
    const signed = decisions.some((m) => m >= (updated || 0)) || /signed off|approved by|human-review:\s*(done|approved)/i.test(t);
    return { file: rel, title: firstLine(rel).replace(/^#\s*/, ''), updated, signed };
  };

  const divisions = readJson('studio/divisions.json')?.divisions?.filter((d) => d.active || d.core).map((d) => d.name) || null;
  const plugins = readJson('studio/plugins.json')?.plugins?.filter((p) => p.enabled).map((p) => p.name) || [];
  const forced = [...q.inProgress, ...q.backlog].filter((t) => /^(Check forced done|Watch:)/i.test(t.title));
  const paused = q.backlog.filter((t) => fs.existsSync(path.join(REPO_ROOT, 'studio', 'handoffs', `${t.id}.md`)));
  // Fresh, read-only watcher pass: what it would flag right now.
  const watch = watchPass({ dryRun: true });
  const sheet = read('studio/game/GAME.md');
  const field = (label) => (sheet?.match(new RegExp(`\\*\\*${label}\\*\\*[^:]*:\\s*(.+)`)) || [, null])[1];
  const gameInfo = sheet ? { name: (sheet.match(/^# (.+?):/m) || [, '?'])[1], pitch: field('Pitch'), state: field('State'), engine: field('Engine and tools'), offLimits: field('Off-limits'), updated: mtime('studio/game/GAME.md') } : null;
  const bugs = [...q.inProgress, ...q.backlog].filter((t) => /^(bug|fix)\b/i.test(t.title));

  return {
    generatedAt: new Date().toISOString(),
    git: { branch: git('rev-parse', '--abbrev-ref', 'HEAD'), head: git('log', '-1', '--format=%h %s') },
    plan: { goal: section(plan, 'Goal'), now: section(plan, 'Now'), milestones: section(plan, 'Milestones'), updated: mtime('studio/PLAN.md') },
    log: readLog().slice(0, 3),
    decisions,
    meeting: activeMeeting(),
    meetings,
    queue: { inProgress: q.inProgress.map((t) => ({ ...t, owner: owner.get(t.id) || null })), next: q.backlog.slice().sort((a, b) => a.priority.localeCompare(b.priority)).slice(0, 6), backlogSize: q.backlog.length, done: q.done.length },
    forced,
    paused,
    watch,
    game: gameInfo,
    scorecard: buildScorecard({ queue: q }),
    retro: latestRetro(),
    harnessNotes: readNotes(),
    repeats: repeats().slice(0, 5),
    staleSuggestions: staleSuggestions().slice(0, 3),
    bible: (() => {
      const b = readBible();
      if (!b) return null;
      const c = checkBible(b);
      const r = latestReview();
      const ideas = readIdeas();
      return { title: b.answers.title, playLength: b.answers.playLength, signed: b.signed, open: b.phase?.open || 0, missing: c.missing, kept: c.kept, crossed: c.crossed, review: r ? { file: r.file, verdict: r.verdict, phase: r.phase, at: r.at } : null, drift: driftReport().items, ideas: { captured: ideas.filter((i) => i.stage === 'captured'), placed: ideas.filter((i) => i.stage === 'placed'), approved: ideas.filter((i) => i.stage === 'approved') } };
    })(),
    inbox: (read('studio/producer/INBOX.md') || '').split('\n').filter((l) => /^- \[\d{4}-\d\d-\d\d/.test(l)).filter((l) => Date.now() - Date.parse(l.slice(3, 19).replace(' ', 'T')) < 7 * 86400000).slice(-6),
    bugs,
    locks,
    gates,
    playtest,
    lastFailure: trace ? { seed: trace.seed, tick: trace.tick, cartridge: trace.cartridge, description: trace.description, attempt: trace.attempt, replay: 'node harness/replay.mjs --trace .studio/last-seed-failure.json', updated: mtime('.studio/last-seed-failure.json') } : null,
    escalations,
    signoffs: [signoff('studio/balance/latest.md'), signoff('studio/fun/latest.md')].filter(Boolean),
    lessons,
    activity: [...activity.values()].sort((a, b) => String(b.at).localeCompare(String(a.at))),
    divisions,
    plugins,
    docs,
  };
}

export function renderHandoff(h) {
  const L = [];
  const add = (...lines) => L.push(...lines);
  const head = (t) => add('', `## ${t}`);
  add(`# Producer briefing`, '', `Built ${h.generatedAt} from studio files${h.git.head ? ` at ${h.git.branch} ${h.git.head}` : ''}. Nothing here is estimated.`);

  head('The plan (studio/PLAN.md)');
  if (h.plan.goal || h.plan.now) add(h.plan.goal ? `Goal: ${h.plan.goal.replace(/\n+/g, ' ')}` : '', h.plan.now, '', h.plan.milestones);
  else add('No studio/PLAN.md yet. Write one before assigning work (template in studio/MASTER.md).');

  head('The game plan (studio/bible/BIBLE.md)');
  if (!h.bible) add('No Game Bible yet. Before any build work, run `npm run intake` with the person who owns the game: play length first (a 15 to 30 minute demo is the easiest start), then the three phases and the layers.');
  else {
    const g = h.bible;
    add(`${g.title || '(untitled)'}, ${PLAY_LENGTHS[g.playLength]?.label || 'play length not set'}: ${g.signed ? `signed by ${g.signed.by}; Phase ${g.open} of 3 is open` : `pre-production (${g.missing.length ? `${g.missing.length} thing(s) before it can be signed` : 'ready for a person to sign'})`}.`);
    add(`- Layers kept: ${g.kept.join(', ') || 'none'}. Crossed out (never build): ${g.crossed.join(', ') || 'none'}.`);
    add(g.review ? `- Director's last review: ${g.review.verdict || 'no verdict'} on Phase ${g.review.phase || '?'}, ${age(g.review.at)} (${g.review.file})` : '- No Director review yet.');
    add(...g.drift.filter((d) => d.kind !== 'review-stale').slice(0, 5).map((d) => `- Drift: ${d.msg}`));
    add('- Before you generate new tasks: `npm run director -- ping --reason "…"`, then build tasks from its answer with `--phase` and `--serves`.');
  }

  head('The game (studio/game/GAME.md)');
  if (h.game) {
    const blank = (v) => !v || /^_.*_$/.test(v.trim());
    add(`${h.game.name}: ${blank(h.game.pitch) ? 'no pitch yet' : h.game.pitch}`, `- State: ${blank(h.game.state) ? 'not filled in' : h.game.state}`, `- Engine: ${h.game.engine || '?'}`, `- Off-limits: ${blank(h.game.offLimits) ? 'not filled in' : h.game.offLimits}`);
  } else add('No game onboarded yet (the example cartridge only). Bring one in with npm run onboard -- --path <folder> --name "<name>".');

  head('Last notes from the Producer (studio/producer/LOG.md)');
  if (h.log.length) for (const e of h.log) add(`- ${e.heading}: ${e.body.replace(/\n+/g, ' ')}`);
  else add('- No log entries. The previous Producer left no reasons; check decisions and meetings.');

  head('Decisions on record (studio/decisions/)');
  add(...(h.decisions.length ? h.decisions.map((d) => `- ${d.title}${d.status ? ` (${d.status})` : ''}: ${d.file}`) : ['- None yet.']));

  head('Needs you first');
  const first = [
    ...h.forced.map((t) => `- ${t.id} ${t.title}`),
    ...h.escalations.slice(0, 3).map((e) => `- Escalated ${e.task || ''}: ${e.msg}`),
    ...(h.escalations.length > 3 ? [`- …and ${h.escalations.length - 3} older escalations since the last clean closed-loop pass`] : []),
    ...(h.gates && (h.gates.rows || []).some((r) => r.required && !r.ok) ? [`- Last verify failed: ${h.gates.rows.filter((r) => r.required && !r.ok).map((r) => r.id).join(', ')}`] : []),
    ...(h.meeting ? [`- Meeting still open: "${h.meeting.topic}" (end it with node harness/meeting.mjs end)`] : []),
    ...(h.inbox || []).map((l) => `- Message ${l.slice(2)}`),
    ...(h.bible?.ideas.captured.filter((i) => !i.routed).map((i) => `- New idea ${i.id}: ${i.title} (route it: npm run idea -- route ${i.id})`) || []),
    ...(h.bible?.ideas.approved.map((i) => `- Approved idea ${i.id} isn't scheduled: task add "…" --idea ${i.id} --phase ${i.place?.phase}`) || []),
    ...(h.bible?.ideas.placed.length ? [`- ${h.bible.ideas.placed.length} idea(s) wait for the Director's decision`] : []),
  ];
  add(...(first.length ? first : ['- Nothing urgent.']));

  head('Queue (studio/NEXT.md)');
  add(`${h.queue.inProgress.length} in progress, ${h.queue.backlogSize} waiting, ${h.queue.done} done.`);
  for (const t of h.queue.inProgress) add(`- Doing ${t.id} [${t.priority}] (${t.role}) ${t.title}${t.owner ? `, held by ${t.owner}` : ', nobody holds it'}`);
  for (const t of h.queue.next) add(`- Next ${t.id} [${t.priority}] (${t.role}) ${t.title}`);

  if (h.paused.length) add(...h.paused.map((t) => `- Handed back ${t.id} (${t.role}) ${t.title}: notes in studio/handoffs/${t.id}.md`));

  head('Who holds what');
  add(...(h.locks.length ? h.locks.map((l) => `- ${l.owner}: ${l.key} until ${l.expiresAt}`) : ['- No claims.']));

  head('Health');
  if (h.gates) {
    const req = (h.gates.rows || []).filter((r) => r.required);
    add(`- Last verify: ${req.filter((r) => r.ok).length} of ${req.length} required gates green, ${h.gates.at}${h.gates.partial ? ' (partial run)' : ''}`);
  } else add('- No verify recorded. Run npm run verify.');
  add(h.playtest ? `- Latest playtest: ${h.playtest.passed ? 'passed' : `FAILED at tick ${h.playtest.failingTick}: ${h.playtest.finding}`} (seed ${h.playtest.seed}, ${h.playtest.ticks} ticks, ${h.playtest.file})` : '- No playtest yet.');
  if (h.lastFailure) add(`- Last recorded failure: ${h.lastFailure.cartridge} seed ${h.lastFailure.seed} tick ${h.lastFailure.tick}, ${age(h.lastFailure.updated)}. Replay: ${h.lastFailure.replay}`);
  add(...(h.bugs.length ? h.bugs.map((t) => `- Open bug ${t.id} [${t.priority}]: ${t.title}`) : ['- No open bug tasks.']));

  add(h.watch.findings.length ? `- Watcher right now: ${h.watch.findings.map((f) => f.msg).join('; ')}` : '- Watcher right now: all quiet');

  head('Models (npm run scorecard)');
  add(...renderScorecard(h.scorecard).split('\n').map((l) => `    ${l}`));

  head('Waiting on a person');
  add(...(h.signoffs.length ? h.signoffs.map((s) => `- ${s.title} (${s.file}, ${age(s.updated)}): ${s.signed ? 'signed off' : 'not signed off yet'}`) : ['- Nothing.']));

  head('What the studio learned (latest retro)');
  if (h.retro) {
    const open = h.retro.text.split('\n').filter((l) => l.startsWith('- [ ] '));
    add(`From ${h.retro.file}. Accept or reject each in your log; tick the box when it's handled.`, ...(open.length ? open.map((l) => l.replace('- [ ] ', '- ')) : ['- Nothing open.']));
  } else add('- No retro yet. The HUB writes one a day; npm run retro writes one now.');

  head('What keeps happening (npm run learn)');
  add(...(h.repeats.length ? h.repeats.map((r) => `- ${r.type} on ${r.days.length} days: ${r.sample}${r.lesson ? ` (lesson "${r.lesson}" didn't stick)` : ' (no lesson yet)'}`) : ['- Nothing has repeated on two different days.']));
  add(...h.staleSuggestions.map((s) => `- Retros keep suggesting (${s.retros.length}x, never handled): ${s.text}`));

  head('Known harness issues and workarounds (studio/harness-notes/NOTES.md)');
  const hn = h.harnessNotes;
  add(...hn.bad.slice(0, 4).map((l) => `- Doesn't work: ${l.replace(/^\[[^\]]*\]\s*/, '')}`), ...hn.workaround.slice(0, 4).map((l) => `- Workaround: ${l.replace(/^\[[^\]]*\]\s*/, '')}`));
  if (!hn.bad.length && !hn.workaround.length) add('- None recorded.');
  add(...(hn.eval || []).slice(0, 2).map((l) => `- Last evaluation: ${l}`));
  add(`- ${hn.well.length} things that worked and ${hn.upgrade.length} upgrade ideas on file. Add yours: npm run notes -- add --kind well|bad|workaround|upgrade|eval "…"`);

  head('Lessons (studio/memory/failures.md)');
  add(...(h.lessons.length ? h.lessons.map((l) => `- ${l}`) : ['- None recorded.']));

  head('Meetings (studio/meetings/)');
  if (h.meeting) add(`- In progress: "${h.meeting.topic}" with ${h.meeting.attendees.join(', ')}`);
  add(...(h.meetings.length ? h.meetings.map((m) => `- ${m.topic} (${m.file})${m.decisions.length ? `: ${m.decisions.map((d) => d.slice(2)).join('; ')}` : ''}`) : ['- No meetings yet.']));

  head('Last 24 hours');
  add(...(h.activity.length ? h.activity.slice(0, 10).map((a) => `- ${a.agent} (${a.events} events): ${String(a.last || '').slice(0, 100)}`) : ['- Quiet.']));

  head('Switched on');
  add(`- Divisions: ${h.divisions ? h.divisions.join(', ') : 'the five core divisions (no studio/divisions.json)'}`, `- Plugins: ${h.plugins.join(', ') || 'none'}`);

  head('Key documents (studio/MASTER.md)');
  add(...h.docs.map((d) => `- ${d.rel}: ${age(d.updated)}`));

  head('Before you assign work');
  add('1. Clear "Needs you first".', '2. Check nobody already holds the files a task touches.', '3. Write a log entry when you decide something: node harness/handoff.mjs note "what, why, next".');
  return L.filter((l, i) => !(l === '' && L[i - 1] === '')).join('\n') + '\n';
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'note') {
    const agentAt = rest.indexOf('--agent');
    const agent = agentAt >= 0 ? rest.splice(agentAt, 2)[1] : undefined;
    const text = rest.join(' ');
    if (!text.trim()) {
      console.error('Usage: node harness/handoff.mjs note "what changed, why, what next" [--agent <name>]');
      process.exit(1);
    }
    addLogNote(text, agent);
    console.log('Added to studio/producer/LOG.md');
  } else {
    const h = buildHandoff();
    if (cmd === '--json') console.log(JSON.stringify(h, null, 2));
    else {
      const md = renderHandoff(h);
      fs.mkdirSync(path.join(STUDIO_STATE_DIR, 'briefs'), { recursive: true });
      fs.writeFileSync(path.join(STUDIO_STATE_DIR, 'briefs', 'producer.md'), md);
      console.log(md);
      console.log('Saved to .studio/briefs/producer.md');
    }
  }
}
