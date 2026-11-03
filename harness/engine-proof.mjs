/**
 * harness/engine-proof.mjs — 2.72.0 (c): an engine gate (Unity, Godot) passes only when it proves it ran.
 *
 * A test runner that exits 0 is not proof: an editor can exit 0 having compiled nothing, a results file left by an
 * earlier run can stand in for one this run never wrote, and a crash after the results were written leaves a green
 * file behind a red run. So an engine gate's run counts only when all of these hold:
 *
 *   fresh results   the results file was written by THIS run: its name carries this run's nonce (Unity) or it is a
 *                   report folder that didn't exist before the run (gdUnit4 numbers its own), and its mtime is not older
 *                   than the run's start;
 *   tests ran       more than 0 test cases counted, unless the engine's manifest says "allowEmpty" (Unity:
 *                   studio/game.json engines.unity.allowEmpty: true or ["PlayMode"]; Godot: studio/godot-unit.json
 *                   "allowEmpty": true);
 *   a clean log     no compile error, licence or "Aborting batchmode" signature in the editor's log;
 *   one story       the exit code agrees with the results (exit 0 with failing tests, or a non-zero exit, a kill or a
 *                   timeout behind results that say every test passed, is not a pass).
 *
 * Each kind of failure has its own plain-words line ([engine-gate] FAIL <kind>: …) and Fix line (harness/gate-fix.mjs
 * ENGINE_FIXES), so the reader knows whether to fix a test, the compile, the licence, or the run itself.
 * Pure helpers; the gates (harness/unity.mjs judgeRun, harness/godot-unit.mjs) call them.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

/** The failure kinds, each with an entry in harness/gate-fix.mjs ENGINE_FIXES. */
export const PROOF_KINDS = ['stale-results', 'no-results', 'empty-run', 'compile-error', 'licence', 'aborted', 'exit-mismatch', 'test-failed'];
/**
 * 2.73.2 (e, B-73): the kinds of an infrastructure abort: the editor didn't get to test the work, so the run is "NOT RUN
 * <kind>", never a FAIL of the game's tests (each has an ENGINE_FIXES entry too). licence and aborted are both: a licence
 * problem is always not run; "Aborting batchmode" is not run only with no results file and no compile error (with
 * results it stays FAIL aborted, 2.72). A compile error or a failing test is always a FAIL, whatever else the log says.
 */
export const INFRA_KINDS = ['out-of-memory', 'editor-killed', 'launch-failed', 'licence', 'aborted', 'ram-floor', 'busy'];

/** A run's nonce: in the results file name, so no file from another run can be mistaken for this run's. */
export const runNonce = () => `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;

// A filesystem with coarse times (FAT: 2 s) and a clock a little ahead of the disk's: this much older still counts.
const SLACK_MS = 2000;

/** Was `file` written at or after startedAt? { ok, mtimeMs, why }. */
export function freshFile(file, startedAt, { slackMs = SLACK_MS } = {}) {
  let st = null;
  try { st = fs.statSync(file); } catch { return { ok: false, mtimeMs: 0, why: 'not written' }; }
  if (!Number.isFinite(Number(startedAt))) return { ok: true, mtimeMs: st.mtimeMs, why: '' };
  if (st.mtimeMs + slackMs < startedAt) return { ok: false, mtimeMs: st.mtimeMs, why: `last written ${Math.round((startedAt - st.mtimeMs) / 1000)} s before this run started` };
  return { ok: true, mtimeMs: st.mtimeMs, why: '' };
}

const COMPILE = { unity: /error CS\d+|Scripts have compiler errors|compilation errors? (?:found|occurred)/i, godot: /Parse Error|Failed to load script|Compile Error|Script compilation failed/i };
const LICENCE = /No valid Unity Editor license|License is not active|Failed to activate|com\.unity\.editor\.headless|licen[cs]e (?:check|activation) failed|no valid licen[cs]e/i;
const ABORTED = /Aborting batchmode/i;

/** The first matching lines of a log for a pattern (at most n, deduplicated, each at most 200 characters). */
const firstLines = (log, re, n = 3) => [...new Set(String(log || '').replace(/\r/g, '').split('\n').filter((l) => re.test(l)).map((l) => l.trim().slice(0, 200)))].slice(0, n);

/** The log's signatures: [{ kind, text }] for compile errors, licence and aborted batch mode. */
export function logSignatures(log, engine = 'unity') {
  const out = [];
  const c = firstLines(log, COMPILE[engine] || COMPILE.unity);
  if (c.length) out.push({ kind: 'compile-error', text: `the ${engine === 'godot' ? 'Godot' : 'editor'} log shows compile errors: ${c.join(' | ')}` });
  if (engine === 'unity') {
    const l = firstLines(log, LICENCE, 1);
    if (l.length) out.push({ kind: 'licence', text: `the editor log shows a licence problem: ${l[0]}` });
  }
  const a = firstLines(log, ABORTED, 1);
  if (a.length) out.push({ kind: 'aborted', text: `the editor aborted batch mode: ${a[0]}` });
  return out;
}

// 2.73.2 (e, B-73): the editor ran out of memory (Unity's native allocator, .NET, Windows STATUS_NO_MEMORY, Node).
const OOM = /\bOut of memory\b|Could not allocate memory|Failed to allocate memory|System\.OutOfMemoryException|0xC0000017|JavaScript heap out of memory/i;
const OOM_CODES = new Set([3221225495, -1073741801]);
// Windows STATUS_CONTROL_C_EXIT (the console closed or Ctrl+C: the editor was ended from outside).
const KILL_CODES = new Set([3221225786, -1073741510]);

/**
 * 2.73.2 (e, B-73): was this run an infrastructure abort rather than a result? { kind, text } or null. log: the editor's
 * output; status: its exit code (null: killed); signal; spawnError (the child_process error, e.g. ENOENT); results: the
 * parsed results this run wrote (null: none); timedOut (our own timeout: never infra here, a hang can be the work's).
 * Never infra when the log shows a compile error or the results show a failing test: those are the work's FAILs.
 */
export function infraAbort({ log = '', status = null, signal = null, spawnError = null, results = null, timedOut = false, engine = 'unity' } = {}) {
  if (spawnError && spawnError.code !== 'ETIMEDOUT') return { kind: 'launch-failed', text: `the editor could not be started (${spawnError.code || spawnError.message || 'spawn failed'}): check STUDIO_${engine === 'godot' ? 'GODOT' : 'UNITY'} points at the editor and that it opens on this machine` };
  if (COMPILE[engine] && COMPILE[engine].test(String(log || ''))) return null;
  if (results && Number(results.failed) > 0) return null;
  const l = firstLines(log, LICENCE, 1);
  if (engine === 'unity' && l.length) return { kind: 'licence', text: `the editor has no usable licence on this machine: ${l[0]}` };
  const m = firstLines(log, OOM, 1);
  if (OOM_CODES.has(Number(status)) || m.length) return { kind: 'out-of-memory', text: `the editor ran out of memory${m.length ? `: ${m[0]}` : ` (exit ${status}, 0xC0000017)`}` };
  if (!results && !timedOut && ((status === null && signal && signal !== 'timeout') || KILL_CODES.has(Number(status)))) return { kind: 'editor-killed', text: `the editor was ended from outside (${signal || `exit ${status}`}) before it wrote any results` };
  const a = firstLines(log, ABORTED, 1);
  if (!results && a.length) return { kind: 'aborted', text: `the editor aborted batch mode before it wrote any results: ${a[0]}` };
  return null;
}

/** 2.73.2 (e): the line printed for a run that did not run: "[engine-gate] NOT RUN <kind> (<engine>): <text>". */
export const notRunLine = (p, engine = '') => `[engine-gate] NOT RUN ${p.kind}${engine ? ` (${engine})` : ''}: ${p.text}`;

/**
 * Does the exit code agree with the results? results: { total, failed } (or null). status: the exit code (null:
 * killed). signal: the signal that killed it. { ok, why }.
 */
export function exitAgrees(status, results, { signal = null, failCodes = [] } = {}) {
  if (!results) return { ok: true, why: '' };
  if (status === null || status === undefined) return { ok: false, why: `the run was killed${signal ? ` (${signal})` : ''} or timed out, yet a results file says ${results.failed ? `${results.failed} failed` : 'every test passed'}: a run that didn't finish proves nothing` };
  if (!results.failed && status !== 0) return { ok: false, why: `the run exited ${status} but its results say every test passed: something after the tests failed (a crash on exit, a script error, a batch-mode abort), so the results don't stand for the run` };
  if (results.failed && status === 0 && failCodes.length) return { ok: false, why: `the results say ${results.failed} test(s) failed but the run exited 0 (a runner that reports failures with exit ${failCodes.join(' or ')})` };
  return { ok: true, why: '' };
}

/** One failure, as the gate records it: { kind, text }; and the plain-words line printed for it. */
export const proofLine = (p, engine = '') => `[engine-gate] FAIL ${p.kind}${engine ? ` (${engine})` : ''}: ${p.text}`;

/** The distinct kinds of a list of { kind } (first seen first). */
export const kindsOf = (list) => [...new Set((list || []).map((p) => p.kind).filter(Boolean))];
