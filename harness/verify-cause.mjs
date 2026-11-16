/**
 * harness/verify-cause.mjs — one structured verdict per train verify.
 *
 * Every train verify records `exitCause` in the task.train.verify event's meta and in the verify result, next to the
 * gate list. A classification, not a saving: it is the input to the next step.
 *
 * exitCause: green | fail (red, gate ids known) | exit (red, no gate id: a crash or a non-zero exit before a FAIL line)
 * | signal (killed) | timeout | busy (ran no check: the machine was busy) | no-check (stopped before any gate)
 * | no-record (the run passed, no record written) | tree-mismatch (the record is of another tree) | not-clean (the
 * record
 * is not a clean full verify).
 */

export const EXIT_CAUSES = ['green', 'fail', 'exit', 'signal', 'timeout', 'busy', 'no-check', 'no-record', 'tree-mismatch', 'not-clean'];

/**
 * Classify a verify run from what the train already knows: its spawn result `r`, the record `rec`, the tree it was
 * asked to test, the failing gate ids (`gates`, from failLines), `busy`/`noCheck` (runGatesWaiting) and the run's text.
 * The order follows the train's own `why`: a run that judged nothing first, then a red, then what the record says.
 */
export function exitCause({ ok = false, r = {}, rec = null, tree = '', gates = [], busy = '', noCheck = false, text = '' } = {}) {
  if (ok) return 'green';
  if (busy) return 'busy';
  if (noCheck) return 'no-check';
  if (r?.error?.code === 'ETIMEDOUT') return 'timeout';
  // A run that says it timed out in its last lines, with no failing gate named (a red with gate ids is a `fail`).
  if (!gates.length && /\b(timed out|timeout)\b.*\b(verify|gates?)\b/i.test(String(text).split('\n').slice(-5).join('\n'))) return 'timeout';
  if (r?.signal || (r?.status === null && !r?.error)) return 'signal';
  if (r?.status !== 0) return gates.length ? 'fail' : 'exit';
  if (!rec) return 'no-record';
  if (rec.tree !== tree) return 'tree-mismatch';
  return 'not-clean';
}
