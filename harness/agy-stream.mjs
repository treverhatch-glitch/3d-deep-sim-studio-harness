/**
 * harness/agy-stream.mjs — an agy builder's session stays open across turns.
 *
 * `agy -p` (and agy with the prompt on stdin) runs ONE turn. A Gemini builder that started a background shell command ended
 * that turn, went idle and agy exited minutes later with the task unfinished (a GEMINI.md "run every command in the
 * foreground" rule was ignored). `--input-format stream-json` (needs `--output-format stream-json`) reads one NDJSON
 * message per line from stdin and runs a turn for each, so the session lives while stdin is open. The launcher:
 *   1. starts agy with AGY_STREAM_FLAGS, writes the kickoff as the first NDJSON user message and keeps stdin open;
 *   2. reads agy's stream-json output from the session's log and, at each turn end (a `result` event, or another
 *      turn-end shape: classifyEvent), asks taskStillOpen whether the session's task is still in progress (it still holds
 *      the claim, or its pinned task isn't claimed yet; not done, paused, handed back or impossible; no stop asked);
 *   3. if it is, waits STUDIO_AGY_CONTINUE_WAIT_SEC (15) so a background command can finish, asks again, and sends one
 *      follow-up user message (continueText: check the background command's result in the FOREGROUND, then carry on),
 *      at most STUDIO_AGY_CONTINUE_MAX (8) times a session;
 *   4. otherwise (or at the cap) closes stdin, and agy exits as `-p` did.
 * A session silent for STUDIO_AGY_STREAM_IDLE_SEC (1800; 0 = never) with no tool call pending gets its stdin closed, so an
 * agy that ends turns in an unrecognised shape can't wait forever; one that printed no stream-json event in its first
 * STUDIO_AGY_STREAM_FIRST_SEC (180; 0 = never) is taken to run as one turn (stdin closed).
 * Event parsing is tolerant: a line that isn't JSON is agy's own text; an event type not known here is noted once in the
 * log ("[launcher] agy stream: …") and ignored, never fatal.
 *
 * agy keys its stream input on "event", not "type": userLine sends {"event":"user","message":{"role":"user","content":[…]}},
 * the shape probed on real agy. ON BY DEFAULT: STUDIO_AGY_STREAM=0 keeps the one-turn launch (prompt on stdin, closed
 * at once), and so does STUDIO_AGY_PROMPT=arg (-p <prompt>). Roles whose session is one turn by design (reviewer,
 * Producer, Director: ONE_TURN_ROLES) keep that launch as well.
 * Safety net: an agy session that exits before its first turn ends, with an input-format error in its own output or no
 * stream-json event at all (streamFailure), is recorded once in .studio/agy-stream.json (agy's program, size, time and
 * --version) and relaunched in the one-turn mode; later launches skip the stream mode while that record matches the agy
 * on PATH (delete the file, or a new agy, and stream mode is tried again).
 * Progress nudge: a stream session with no tool-call event and no file write (the stall check's progress) for
 * STUDIO_AGY_NUDGE_MIN (10) minutes while its task is in progress gets the follow-up too (it counts toward
 * STUDIO_AGY_CONTINUE_MAX); kept below STUDIO_STALL_MIN so it comes before the stall end.
 *
 * Turn ends are read tolerantly: a turn-end word in the event's type, event or kind field. UNTESTED on real agy: which
 * output event ends a turn (a full cycle showed the session lived; the selftest drives a stand-in agy that speaks this shape).
 */
import fs from 'node:fs';
import path from 'node:path';

export const AGY_STREAM_FLAGS = Object.freeze(['--input-format', 'stream-json', '--output-format', 'stream-json']);
/** Roles whose session is one turn by design: they never get a follow-up and keep the one-turn launch. */
export const ONE_TURN_ROLES = /^(reviewer|producer|director)$/i;

const num = (v, d, { min = 0 } = {}) => (v === undefined || v === null || String(v).trim() === '' || !Number.isFinite(Number(v)) ? d : Math.max(min, Number(v)));

const OFF = /^(off|0|false|no)$/i;
/** Is the stream launch on? On unless STUDIO_AGY_STREAM=0/off. STUDIO_AGY_PROMPT=arg keeps the -p launch either way. The
 * failure record (.studio/agy-stream.json) is checked by the launcher. */
export const agyStreamOn = (env = process.env) => !OFF.test(String(env.STUDIO_AGY_STREAM ?? '').trim()) && !/^(arg|argument|p)$/i.test(String(env.STUDIO_AGY_PROMPT || '').trim());
/** Does a session of this role get the stream launch? */
export const agyStreamWanted = ({ role = '', env = process.env } = {}) => agyStreamOn(env) && !ONE_TURN_ROLES.test(String(role || '').trim());

/** The follow-up settings, read when they are used (the launcher reloads .env on each beat). */
export function agyContinueSettings(env = process.env) {
  return {
    max: Math.floor(num(env.STUDIO_AGY_CONTINUE_MAX, 8)),
    waitSec: num(env.STUDIO_AGY_CONTINUE_WAIT_SEC, 15),
    idleSec: num(env.STUDIO_AGY_STREAM_IDLE_SEC, 1800),
    firstSec: num(env.STUDIO_AGY_STREAM_FIRST_SEC, 180),
    nudgeMin: num(env.STUDIO_AGY_NUDGE_MIN, 10),
  };
}

/**
 * The minutes of no tool progress before a nudge: STUDIO_AGY_NUDGE_MIN (10; 0 = no nudge), kept below the stall check's
 * no-progress limit (stallMin, STUDIO_STALL_MIN: 15 for a builder) so the nudge comes first: at most two thirds of it.
 */
export function nudgeMinutes(nudgeMin, stallMin) {
  const n = Number(nudgeMin);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const s = Number(stallMin);
  return Number.isFinite(s) && s > 0 && n > s * 2 / 3 ? s * 2 / 3 : n;
}

/** One NDJSON user message for agy's stdin, with its newline: {"event":"user","message":{"role":"user","content":[{"type":"text","text":…}]}}.
 * Claude Code's "type":"user" shape is refused by agy ("stream input message is missing the "event" field"). */
export const userLine = (text) => `${JSON.stringify({ event: 'user', message: { role: 'user', content: [{ type: 'text', text: String(text) }] } })}\n`;

const TURN_END = /^(result|turn[._-]?(end|ended|complete|completed|done|finished|stop|stopped)|response[._-]?(complete|completed|done|end|ended|finished)|(agent|run)[._-]?(end|ended|complete|completed|done|finished)|done|final|finished)$/i;
const KNOWN = /^(system|init|assistant|user|message|text|delta|thinking|reasoning|tool|tool[._-]?(use|call|result|output|start|end)|function[._-]?(call|result)|stream[._-]?event|content[._-]?block[._-]?\w+|message[._-]?(start|delta|stop)|usage|stats|status|progress|log|error|warning|ping|heartbeat|session|conversation)$/i;

/**
 * What one stream-json event is: { kind: 'turn-end'|'event'|'unknown', type, subtype, toolPending, tool }.
 * toolPending: true for an assistant message that calls a tool, false for a message after it (the tool's result, the
 * next text), undefined when the event says nothing about it.
 */
export function classifyEvent(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { kind: 'unknown', type: null };
  // agy keys its input on "event"; its output may carry the turn end there, beside a "type" (or alone).
  const names = [o.type, o.event, o.kind].filter((x) => typeof x === 'string' && x);
  const type = names[0] || null;
  const subtype = typeof o.subtype === 'string' ? o.subtype : null;
  if (!type) return { kind: 'unknown', type: null };
  const ender = names.find((t) => TURN_END.test(t) || (/^(system|status|session)$/i.test(t) && subtype && TURN_END.test(subtype.replace(/^turn[._-]?/i, 'turn_'))));
  if (ender) return { kind: 'turn-end', type: ender, subtype };
  const known = names.find((t) => KNOWN.test(t));
  if (!known) return { kind: 'unknown', type, subtype };
  let toolPending;
  const content = o.message?.content ?? o.content;
  const parts = Array.isArray(content) ? content.map((c) => String(c?.type || '')) : [];
  if (/^assistant$/i.test(known) && parts.length) toolPending = parts.some((c) => /tool[._-]?use|function[._-]?call/i.test(c));
  else if (/^(user|tool[._-]?result|function[._-]?result)$/i.test(known)) toolPending = false;
  else if (/^tool[._-]?(use|call|start)$/i.test(known)) toolPending = true;
  // A tool call or its result, for the progress nudge (no tool event and no file write for STUDIO_AGY_NUDGE_MIN).
  const tool = /^(tool|function)/i.test(known) || parts.some((c) => /tool|function/i.test(c));
  return { kind: 'event', type: known, subtype, toolPending, tool };
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
export function continueText({ agent = '', task = null, n = 1, max = 8, why = '', quietMin = null } = {}) {
  const t = task || 'your task';
  return [
    quietMin !== null
      ? `[launcher] No tool call and no file write from you for ${Math.round(quietMin * 10) / 10} min, and ${t} is still in progress (${why || 'not done, paused or handed back'}). This is follow-up ${n} of at most ${max}.`
      : `[launcher] Your last turn ended, but ${t} is still in progress (${why || 'not done, paused or handed back'}). This is follow-up ${n} of at most ${max}.`,
    'If you started a command in the background, it may still be running or have finished unseen: check its result now in the FOREGROUND (run the command again in the foreground if you cannot read its output) and wait for it to finish.',
    `Then continue ${t} until it is done (\`npm run task -- done ${task || '<ID>'} --agent ${agent || '<you>'}\`), or pause it with a note (\`npm run task -- pause ${task || '<ID>'} --agent ${agent || '<you>'} --note "where you stopped"\`) if you cannot finish.`,
    'Run every shell command in the foreground: a background command does not keep this session alive.',
  ].join('\n');
}

/**
 * Drive one agy stream session for `agent`. child: the spawned agy (stdin a pipe). logFile/from: where its output lands (the
 * session's log from that byte). decide(): taskStillOpen's answer now. note(line): one line for the log (written at a
 * line boundary of agy's output). onContinue({ n, task, why, nudge }) / onClose(why): for events. Returns { state, stop }.
 * progressAt(): the stall check's last progress (a file write, commit or task change; its own verify running counts), in
 * ms; stallMin(): the stall check's no-progress limit (STUDIO_STALL_MIN) the nudge stays below.
 * Options for tests: settings (agyContinueSettings), pollMs, now, timers { setTimeout, clearTimeout, setInterval,
 * clearInterval }.
 */
export function driveAgyStream({ agent = '', child, logFile, from = 0, firstMessage, decide, note = () => {}, onContinue = () => {}, onClose = () => {}, progressAt = () => 0, stallMin = () => 15, settings = null, pollMs = 250, now = () => Date.now(), timers = globalThis } = {}) {
  const cfg = () => settings || agyContinueSettings();
  const state = { turns: 0, continues: 0, nudges: 0, closed: false, closedWhy: null, unknown: [], waiting: false, startedAt: now(), lastOutputAt: now(), lastToolAt: 0, lastSentAt: now(), toolPending: false, sawJson: 0, nudgeCapNoted: false };
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
      state.lastSentAt = now();
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
    if (ev.tool) state.lastToolAt = now();
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
    if (!state.closed && !state.waiting && state.sawJson) nudge(c);
  };
  // No tool-call event and no file write for STUDIO_AGY_NUDGE_MIN while the task is in progress: the follow-up is sent
  // without waiting for a turn end.
  const nudge = (c) => {
    let sm = 15;
    try { sm = stallMin(); } catch { /* the default */ }
    const min = nudgeMinutes(c.nudgeMin, sm);
    if (!min) return;
    let prog = 0;
    try { prog = Number(progressAt()) || 0; } catch { /* none known */ }
    const quiet = now() - Math.max(state.startedAt, state.lastToolAt, state.lastSentAt, prog);
    if (quiet < min * 60000) return;
    if (state.continues >= c.max) {
      if (!state.nudgeCapNoted) { state.nudgeCapNoted = true; say(`agy stream: no tool progress for ${Math.round(quiet / 6000) / 10} min, but ${state.continues} follow-up(s) were sent, the most a session gets (STUDIO_AGY_CONTINUE_MAX=${c.max}); the stall check decides`); }
      return;
    }
    let d;
    try { d = decide(); } catch (e) { d = { open: false, why: `couldn't tell: ${String(e?.message || e).slice(0, 120)}` }; }
    state.lastSentAt = now();
    if (!d?.open) return;
    state.continues++;
    state.nudges++;
    const text = continueText({ agent, task: d.task, n: state.continues, max: c.max, why: d.why, quietMin: quiet / 60000 });
    if (!write(userLine(text))) return close('its input is gone');
    say(`agy stream: no tool call or file write for ${Math.round(quiet / 6000) / 10} min (STUDIO_AGY_NUDGE_MIN=${Math.round(min * 100) / 100}); follow-up ${state.continues}/${c.max} sent as a nudge (${d.task || 'its task'}: ${d.why})`);
    try { onContinue({ n: state.continues, task: d.task, why: d.why, nudge: true }); } catch { /* events are a help */ }
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

/**
 * Did this stream session fail on the stream mode itself? { failed, why, line }. A session that ended a
 * turn worked; one the launcher (or a person) ended didn't fail on the format. Otherwise: an input-format error in agy's
 * own output (a plain line, or an error event: "stream input message is missing the "event" field", an unknown or
 * unexpected --input-format argument), or no stream-json event at all before it exited.
 * state: driveAgyStream's state; log: the session's own part of its log; ended: the launcher's or a person's end.
 */
export const STREAM_FORMAT_ERROR = /missing the "?\w*"? field|stream input|input[ _-]?format|unknown (flag|option|argument)|unexpected (argument|flag|option)|unrecognized (flag|option|argument)|invalid (stream|input) message/i;
export function streamFailure({ state = null, log = '', ended = null } = {}) {
  if (!state || ended) return { failed: false, why: ended ? 'the launcher or a person ended it' : 'no stream session' };
  if (state.turns > 0) return { failed: false, why: `it ended ${state.turns} turn(s) in stream mode` };
  let line = null;
  for (const raw of String(log || '').split(/\r?\n/)) {
    const t = raw.trim();
    if (!t || t.startsWith('[launcher]')) continue;
    let text = t;
    if (t.startsWith('{')) {
      let o = null;
      try { o = JSON.parse(t); } catch { o = null; }
      if (o && typeof o === 'object') {
        const name = [o.type, o.event, o.kind, o.level].filter((x) => typeof x === 'string').join(' ');
        if (!/error|fatal|warn/i.test(name) && o.error === undefined && o.is_error !== true) continue;
        text = JSON.stringify(o.error ?? o.message ?? o);
      }
    }
    if (STREAM_FORMAT_ERROR.test(text)) { line = t.slice(0, 300); break; }
  }
  if (line) return { failed: true, why: `agy refused the stream input before its first turn ended: ${line}`, line };
  if (!state.sawJson) return { failed: true, why: 'agy printed no stream-json event before it exited (it may not take --input-format stream-json)', line: null };
  return { failed: false, why: 'it printed stream-json and no input-format error' };
}

/** The failure record (.studio/agy-stream.json): { at, why, line, agy: { program, size, mtimeMs, version }, flags }. */
export const STREAM_RECORD = 'agy-stream.json';
export function readStreamRecord(dir) {
  try { const r = JSON.parse(fs.readFileSync(path.join(dir, STREAM_RECORD), 'utf8')); return r && typeof r === 'object' ? r : null; } catch { return null; }
}
export function writeStreamRecord(dir, rec) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, STREAM_RECORD), `${JSON.stringify(rec, null, 2)}\n`);
}
/**
 * Does the record still hold for the agy on PATH? ident(): { program, size, mtimeMs } of agy's program file (cheap);
 * version(): its --version line or null (a spawn: only asked when the file changed). Same file: it holds. Another file:
 * it holds when the versions match (both read, or both unreadable), else agy changed and stream mode is tried again.
 * Returns { holds, why, refreshed } (refreshed: the record with the new file times when the version was the same).
 */
export function streamRecordHolds(rec, { ident = () => null, version = () => null } = {}) {
  if (!rec) return { holds: false, why: 'no record' };
  let now = null;
  try { now = ident(); } catch { now = null; }
  const was = rec.agy || {};
  if (now && was.program && now.program === was.program && now.size === was.size && now.mtimeMs === was.mtimeMs) return { holds: true, why: `agy is unchanged since ${String(rec.at || '').slice(0, 16)}` };
  let v = null;
  try { v = version(); } catch { v = null; }
  if ((v || null) === (was.version || null)) return { holds: true, why: `agy's version is the same (${v || 'not readable'})`, refreshed: now ? { ...rec, agy: { ...was, ...now, version: v || null } } : null };
  return { holds: false, why: `agy changed (${was.version || 'unknown'} -> ${v || 'unknown'})`, changed: true };
}
