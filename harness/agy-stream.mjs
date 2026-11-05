/**
 * harness/agy-stream.mjs — 2.77.3 (C1 / B-99): an agy builder's session stays open across turns.
 *
 * `agy -p` (and agy with the prompt on stdin, the 2.58.5 launch) runs ONE turn. A Gemini builder that started a shell
 * command in the background ("I have started task T-165 … and am waiting for the process to complete") ended that turn,
 * went idle and agy exited ~4 min later with the task unfinished. A GEMINI.md "run every command in the foreground"
 * rule was ignored. agy's own help names the way out: `--input-format stream-json` (it requires `--output-format
 * stream-json`) reads one NDJSON message per line from stdin and runs a turn for each, so the session lives while stdin
 * is open. The launcher now:
 *   1. starts agy with AGY_STREAM_FLAGS, writes the kickoff as the first NDJSON user message and keeps stdin open;
 *   2. reads agy's stream-json output from the session's log (agy writes it there, as before) and, at each turn end
 *      (a `result` event, or another turn-end shape: classifyEvent), asks taskStillOpen whether the session's task is
 *      still in progress (it still holds the claim, or its pinned task isn't claimed yet; not done, paused, handed back
 *      or impossible; no stop asked for the studio or the agent);
 *   3. if it is, waits STUDIO_AGY_CONTINUE_WAIT_SEC (15) so a background command can finish, asks again, and sends one
 *      follow-up user message (continueText: check the background command's result in the FOREGROUND, then carry on),
 *      at most STUDIO_AGY_CONTINUE_MAX (8) times a session;
 *   4. otherwise (or at the cap) closes stdin, and agy exits as `-p` did.
 * A session whose output is silent for STUDIO_AGY_STREAM_IDLE_SEC (1800; 0 = never) while no tool call is pending gets
 * its stdin closed too, so an agy that ends turns in a shape not recognised here can't wait for input forever; and one
 * that printed no stream-json event at all in its first STUDIO_AGY_STREAM_FIRST_SEC (180; 0 = never) is taken to run
 * as one turn (its stdin closed: what the one-turn launch did from the start).
 * Event parsing is tolerant: a line that isn't JSON is agy's own text; an event type not known here is noted once in
 * the log ("[launcher] agy stream: …") and ignored, never fatal.
 *
 * OFF BY DEFAULT (the coordinator's call for 2.77.3): STUDIO_AGY_STREAM=1 turns it on; unset or 0 keeps the 2.58.5
 * launch (prompt on stdin, closed at once, one turn), and so does STUDIO_AGY_PROMPT=arg (-p <prompt>). It stays off
 * until one hand-run session on real agy confirms the input shape (docs/AGENT-TOOLS.md has the command). Roles whose session is one turn by design (reviewer, Producer, Director,
 * liaison: ONE_TURN_ROLES) keep that launch as well: the crew's Gemini reviewer worked on it.
 *
 * UNTESTED on real agy: the input message shape (userLine: Claude Code's stream-json user message) and which output
 * event ends a turn. The selftest drives a stand-in agy that speaks this shape.
 */
import fs from 'node:fs';

export const AGY_STREAM_FLAGS = Object.freeze(['--input-format', 'stream-json', '--output-format', 'stream-json']);
/** Roles whose session is one turn by design: they never get a follow-up and keep the one-turn launch. */
export const ONE_TURN_ROLES = /^(reviewer|producer|director|liaison)$/i;

const ON = /^(on|1|true|yes)$/i;
const num = (v, d, { min = 0 } = {}) => (v === undefined || v === null || String(v).trim() === '' || !Number.isFinite(Number(v)) ? d : Math.max(min, Number(v)));

/** Is the stream launch on? (STUDIO_AGY_STREAM=1/on; off by default until a hand-run session on real agy confirms the
 * input shape. STUDIO_AGY_PROMPT=arg keeps the -p launch either way.) */
export const agyStreamOn = (env = process.env) => ON.test(String(env.STUDIO_AGY_STREAM ?? '').trim()) && !/^(arg|argument|p)$/i.test(String(env.STUDIO_AGY_PROMPT || '').trim());
/** Does a session of this role get the stream launch? */
export const agyStreamWanted = ({ role = '', env = process.env } = {}) => agyStreamOn(env) && !ONE_TURN_ROLES.test(String(role || '').trim());

/** The follow-up settings, read when they are used (the launcher reloads .env on each beat). */
export function agyContinueSettings(env = process.env) {
  return {
    max: Math.floor(num(env.STUDIO_AGY_CONTINUE_MAX, 8)),
    waitSec: num(env.STUDIO_AGY_CONTINUE_WAIT_SEC, 15),
    idleSec: num(env.STUDIO_AGY_STREAM_IDLE_SEC, 1800),
    firstSec: num(env.STUDIO_AGY_STREAM_FIRST_SEC, 180),
  };
}

/** One NDJSON user message for agy's stdin (Claude Code's stream-json input shape), with its newline. */
export const userLine = (text) => `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: String(text) }] } })}\n`;

const TURN_END = /^(result|turn[._-]?(end|ended|complete|completed|done|finished)|response[._-]?(complete|completed|done)|done|final|finished)$/i;
const KNOWN = /^(system|init|assistant|user|message|text|delta|thinking|reasoning|tool|tool[._-]?(use|call|result|output|start|end)|function[._-]?(call|result)|stream[._-]?event|content[._-]?block[._-]?\w+|message[._-]?(start|delta|stop)|usage|stats|status|progress|log|error|warning|ping|heartbeat|session|conversation)$/i;

/**
 * What one stream-json event is: { kind: 'turn-end'|'event'|'unknown', type, subtype, toolPending }.
 * toolPending: true for an assistant message that calls a tool, false for a message after it (the tool's result, the
 * next text), undefined when the event says nothing about it.
 */
export function classifyEvent(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { kind: 'unknown', type: null };
  const type = typeof o.type === 'string' ? o.type : typeof o.event === 'string' ? o.event : typeof o.kind === 'string' ? o.kind : null;
  const subtype = typeof o.subtype === 'string' ? o.subtype : null;
  if (!type) return { kind: 'unknown', type: null };
  if (TURN_END.test(type) || (/^(system|status|session)$/i.test(type) && subtype && TURN_END.test(subtype.replace(/^turn[._-]?/i, 'turn_')))) return { kind: 'turn-end', type, subtype };
  if (!KNOWN.test(type)) return { kind: 'unknown', type, subtype };
  let toolPending;
  const content = o.message?.content ?? o.content;
  if (/^assistant$/i.test(type) && Array.isArray(content)) toolPending = content.some((c) => /tool[._-]?use|function[._-]?call/i.test(String(c?.type || '')));
  else if (/^(user|tool[._-]?result|function[._-]?result)$/i.test(type)) toolPending = false;
  else if (/^tool[._-]?(use|call|start)$/i.test(type)) toolPending = true;
  return { kind: 'event', type, subtype, toolPending };
}

/**
 * Is the session's task still in progress, so its turn ending isn't the end of its work? { open, task, why }.
 *   locks     the lock list (harness/lock.mjs listLocks); the claim is the truth: done, pause, hand-back and
 *             impossible all release it
 *   events    recent events (task.start by this agent since the session started: it claimed the task, then let go)
 *   doneIds   ids on the board's done list
 *   studioStop / agentStop   the studio's stop (task.mjs readStop) and this agent's (agent.mjs stopMark)
 */
export function taskStillOpen({ agent, role = '', task = null, startedAt = null, locks = [], events = [], doneIds = [], studioStop = null, agentStop = null, refresh = null } = {}) {
  if (studioStop) return { open: false, task, why: `the studio is stopped${studioStop.by ? ` (by ${studioStop.by})` : ''}` };
  if (agentStop) return { open: false, task, why: `${agent} was ${agentStop.kind === 'pause' ? 'paused' : 'stopped'}${agentStop.by ? ` by ${agentStop.by}` : ''}` };
  if (refresh?.endedBy) return { open: false, task, why: 'its session is being refreshed (a fresh session continues)' };
  if (ONE_TURN_ROLES.test(String(role || ''))) return { open: false, task, why: `a ${role} session is one turn` };
  const held = (locks || []).filter((l) => l?.owner === agent && String(l.key || '').startsWith('task:')).map((l) => l.key.slice(5));
  if (held.length) return { open: true, task: held[0], why: `it still holds ${held.join(', ')}` };
  if (!task) return { open: false, task: null, why: 'it holds no task' };
  if ((doneIds || []).includes(task)) return { open: false, task, why: `${task} is done` };
  const other = (locks || []).find((l) => l?.key === `task:${task}` && l.owner !== agent);
  if (other) return { open: false, task, why: `${task} is held by ${other.owner}` };
  const from = Date.parse(startedAt || '') || 0;
  const claimed = (events || []).some((e) => e?.type === 'task.start' && e.task === task && e.agent === agent && (Date.parse(e.ts || '') || 0) >= from - 1000);
  if (claimed) return { open: false, task, why: `it claimed ${task} and let it go (done, paused or handed back)` };
  return { open: true, task, why: `its task ${task} isn't claimed yet (a \`task start\` still running in the background?)` };
}

/** The follow-up message. */
export function continueText({ agent = '', task = null, n = 1, max = 8, why = '' } = {}) {
  const t = task || 'your task';
  return [
    `[launcher] Your last turn ended, but ${t} is still in progress (${why || 'not done, paused or handed back'}). This is follow-up ${n} of at most ${max}.`,
    'If you started a command in the background, it may still be running or have finished unseen: check its result now in the FOREGROUND (run the command again in the foreground if you cannot read its output) and wait for it to finish.',
    `Then continue ${t} until it is done (\`npm run task -- done ${task || '<ID>'} --agent ${agent || '<you>'}\`), or pause it with a note (\`npm run task -- pause ${task || '<ID>'} --agent ${agent || '<you>'} --note "where you stopped"\`) if you cannot finish.`,
    'Run every shell command in the foreground: a background command does not keep this session alive.',
  ].join('\n');
}

/**
 * Drive one agy stream session for `agent`. child: the spawned agy (stdin a pipe). logFile/from: where its output lands (the
 * session's log from that byte). decide(): taskStillOpen's answer now. note(line): one line for the log (written at a
 * line boundary of agy's output). onContinue({ n, task, why }) / onClose(why): for events. Returns { state, stop }.
 * Options for tests: settings (agyContinueSettings), pollMs, now, timers { setTimeout, clearTimeout, setInterval,
 * clearInterval }.
 */
export function driveAgyStream({ agent = '', child, logFile, from = 0, firstMessage, decide, note = () => {}, onContinue = () => {}, onClose = () => {}, settings = null, pollMs = 250, now = () => Date.now(), timers = globalThis } = {}) {
  const cfg = () => settings || agyContinueSettings();
  const state = { turns: 0, continues: 0, closed: false, closedWhy: null, unknown: [], waiting: false, startedAt: now(), lastOutputAt: now(), toolPending: false, sawJson: 0 };
  let pos = from;
  let partial = '';
  let pending = [];
  let waitTimer = null;
  const say = (line) => { pending.push(line); if (!partial) flush(); };
  const flush = () => { const out = pending; pending = []; for (const l of out) { try { note(l); } catch { /* the log line is a help */ } } };
  const write = (s) => { try { if (child.stdin && !child.stdin.destroyed && child.stdin.writable) { child.stdin.write(s); return true; } } catch { /* the pipe went away */ } return false; };
  const close = (why) => {
    if (state.closed) return;
    state.closed = true;
    state.closedWhy = why;
    if (waitTimer) { timers.clearTimeout(waitTimer); waitTimer = null; }
    say(`agy stream: closing its input (${why}); agy ends after this turn`);
    try { child.stdin?.end(); } catch { /* already closed */ }
    try { onClose(why); } catch { /* events are a help */ }
  };
  child.stdin?.on?.('error', () => { state.closed = true; });
  if (!write(typeof firstMessage === 'string' ? firstMessage : '')) close('agy took no input');

  const turnEnded = (ev) => {
    state.turns++;
    if (state.closed || state.waiting) return;
    if (/max[._-]?turns/i.test(String(ev.subtype || ''))) return close(`turn ${state.turns} hit its turn ceiling`);
    const c = cfg();
    if (state.continues >= c.max) return close(`turn ${state.turns} ended; ${state.continues} follow-up(s) sent, the most a session gets (STUDIO_AGY_CONTINUE_MAX=${c.max})`);
    let d;
    try { d = decide(); } catch (e) { d = { open: false, why: `couldn't tell: ${String(e?.message || e).slice(0, 120)}` }; }
    if (!d?.open) return close(`turn ${state.turns} ended and ${d?.why || 'its task is not in progress'}`);
    state.waiting = true;
    say(`agy stream: turn ${state.turns} ended while ${d.task || 'its task'} is in progress (${d.why}); a follow-up in ${c.waitSec}s`);
    waitTimer = timers.setTimeout(() => {
      waitTimer = null;
      state.waiting = false;
      if (state.closed) return;
      let again;
      try { again = decide(); } catch (e) { again = { open: false, why: `couldn't tell: ${String(e?.message || e).slice(0, 120)}` }; }
      if (!again?.open) return close(`${again?.why || 'its task is no longer in progress'} (after the wait)`);
      state.continues++;
      const text = continueText({ agent, task: again.task, n: state.continues, max: c.max, why: again.why });
      if (!write(userLine(text))) return close('its input is gone');
      say(`agy stream: follow-up ${state.continues}/${c.max} sent (${again.task || 'its task'}: ${again.why})`);
      try { onContinue({ n: state.continues, task: again.task, why: again.why }); } catch { /* events are a help */ }
    }, Math.round(c.waitSec * 1000));
  };

  const line = (raw) => {
    const t = raw.trim();
    if (!t || t.startsWith('[launcher]')) return;
    if (!t.startsWith('{')) return; // agy's own text
    let o;
    try { o = JSON.parse(t); } catch { return; }
    state.sawJson++;
    const ev = classifyEvent(o);
    if (typeof ev.toolPending === 'boolean') state.toolPending = ev.toolPending;
    if (ev.kind === 'turn-end') { state.toolPending = false; turnEnded(ev); return; }
    if (ev.kind === 'unknown') {
      const key = ev.type || '(no type)';
      if (!state.unknown.includes(key) && state.unknown.length < 20) { state.unknown.push(key); say(`agy stream: event type ${JSON.stringify(key).slice(0, 60)} not known here; ignored`); }
    }
  };

  const poll = () => {
    let fd = null;
    try {
      fd = fs.openSync(logFile, 'r');
      const size = fs.fstatSync(fd).size;
      if (size < pos) pos = size;
      if (size > pos) {
        const buf = Buffer.alloc(Math.min(size - pos, 4 * 1024 * 1024));
        const got = fs.readSync(fd, buf, 0, buf.length, pos);
        pos += got;
        const text = partial + buf.subarray(0, got).toString('utf8');
        const parts = text.split(/\n/);
        partial = parts.pop();
        const own = parts.every((p) => p.trim().startsWith('[launcher]') || !p.trim());
        if (!own || partial) state.lastOutputAt = now();
        for (const p of parts) line(p);
      }
    } catch { /* the log is read again next time */ } finally { if (fd !== null) { try { fs.closeSync(fd); } catch {} } }
    if (!partial && pending.length) flush();
    const c = cfg();
    if (!state.closed && !state.sawJson && c.firstSec > 0 && now() - state.startedAt > c.firstSec * 1000) close(`agy printed no stream-json event in ${Math.round(c.firstSec)}s (STUDIO_AGY_STREAM_FIRST_SEC): it may not take --input-format stream-json; it runs as one turn`);
    if (!state.closed && !state.waiting && !state.toolPending && c.idleSec > 0 && now() - state.lastOutputAt > c.idleSec * 1000) close(`no output for ${Math.round(c.idleSec)}s and no tool call pending (STUDIO_AGY_STREAM_IDLE_SEC)`);
  };
  const iv = timers.setInterval(poll, pollMs);
  iv?.unref?.();
  const stop = () => {
    timers.clearInterval(iv);
    if (waitTimer) { timers.clearTimeout(waitTimer); waitTimer = null; }
    poll();
    timers.clearInterval(iv);
    if (pending.length) { partial = ''; flush(); }
  };
  return { state, stop, poll };
}
