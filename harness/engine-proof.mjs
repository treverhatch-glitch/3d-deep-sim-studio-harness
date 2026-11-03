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
