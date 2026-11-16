/**
 * harness/gate-output.mjs — a gate's own output, fenced and capped, as scripts/run-gates.mjs shows it. Every gate's
 * output goes through a fence:
 * - the full output is kept on disk (.studio/gates/out/<gate>.log, written by harness/gate-spawn.mjs);
 * - at most the first and last STUDIO_GATE_OUTPUT_LINES lines (200) are shown, with a line saying how many were left
 *   out and where the log is; a line over 2,000 characters is cut, with the count;
 * - a line that starts like run-gates' own (`[gates] `, `[verify] `, after spaces, control characters or colour
 *   codes) is shown with `| ` in front, so a check can't print a verdict or Fix line that reads as the harness's.
 * createFence({ show, logName, lines, pick }) -> { push(chunk), end() -> { lines, omitted, text, picked, log } }:
 * `text` is what the Fix line and advisory lines are read from; `pick` keeps the first lines matching a pattern from
 * anywhere.
 */
export const DEFAULT_OUTPUT_LINES = 200;
export const MAX_LINE_CHARS = 2000;
/** A line still open after this many characters is shown as a line of its own (output with no newline at all). */
const MAX_PARTIAL = 1024 * 1024;

/** First and last lines shown per gate (STUDIO_GATE_OUTPUT_LINES; a positive whole number, else 200). */
export function outputLines(env = process.env) {
  const n = Number(env.STUDIO_GATE_OUTPUT_LINES);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_OUTPUT_LINES;
}

// Spaces, control characters and ANSI escape sequences before the tag; the tags run-gates (and the verify host) print.
const LEAD = '(?:[\\s\\x00-\\x1f\\x7f]|\\x1b\\[[0-9;?]*[ -/]*[@-~]|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\))*';
const OWN_TAG = new RegExp(`^${LEAD}\\[(?:gates|verify)\\]`, 'i');

/** Does this line (or any part of it a carriage return would bring to the start of the screen) look like run-gates' own? */
export function looksLikeOurs(line) {
  return String(line).split('\r').some((seg) => OWN_TAG.test(seg));
}

/** The line as shown: harness-like lines get `| ` (carriage returns made visible), long lines are cut. */
export function fenceLine(line) {
  let s = String(line);
  if (s.endsWith('\r')) s = s.slice(0, -1); // CRLF output
  if (looksLikeOurs(s)) s = `| ${s.replace(/\r/g, '\\r')}`;
  if (s.length > MAX_LINE_CHARS) s = `${s.slice(0, MAX_LINE_CHARS)} ... (${s.length - MAX_LINE_CHARS} more characters)`;
  return s;
}

export function createFence({ show = (s) => process.stdout.write(s), logName = null, lines = outputLines(), pick = null, pickMax = 5 } = {}) {
  const head = [];
  const tail = [];
  let count = 0;
  let partial = '';
  const picked = [];
  const line = (raw) => {
    count += 1;
    if (pick && picked.length < pickMax && pick.test(raw)) picked.push(raw.length > MAX_LINE_CHARS ? raw.slice(0, MAX_LINE_CHARS) : raw);
    const kept = raw.length > MAX_LINE_CHARS * 2 ? raw.slice(0, MAX_LINE_CHARS * 2) : raw;
    if (head.length < lines) {
      head.push(kept);
      if (show) show(`${fenceLine(kept)}\n`);
      return;
    }
    tail.push(kept);
    if (tail.length > lines) tail.shift();
  };
  return {
    push(chunk) {
      const s = String(chunk);
      partial += s;
      let i;
      while ((i = partial.indexOf('\n')) >= 0) {
        line(partial.slice(0, i));
        partial = partial.slice(i + 1);
      }
      while (partial.length > MAX_PARTIAL) { line(partial.slice(0, MAX_PARTIAL)); partial = partial.slice(MAX_PARTIAL); }
    },
    end() {
      if (partial) { line(partial); partial = ''; }
      const log = logName;
      const omitted = Math.max(0, count - head.length - tail.length);
      if (show && tail.length) {
        if (omitted) show(`[gates] ... ${omitted} line(s) of this gate's output not shown (the first and last ${lines}: STUDIO_GATE_OUTPUT_LINES)${log ? `; all ${count}: ${log}` : ''}\n`);
        for (const l of tail) show(`${fenceLine(l)}\n`);
      }
      return { lines: count, omitted, picked, log, head, tail, text: [...head, ...(omitted ? ['...'] : []), ...tail].join('\n') };
    },
  };
}
