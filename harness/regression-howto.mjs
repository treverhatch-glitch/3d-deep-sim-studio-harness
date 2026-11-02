/**
 * harness/regression-howto.mjs — 2.67.2: exactly what a bug task's regression needs, in the done-check's refusal and in
 * the bug task's focus brief (.studio/briefs/<ID>.md).
 *
 * T-132's builder committed a fix and then stopped at the done-check's "Regression saved" with no idea which file, which
 * fields or which command were missing. The words below name the file path, the fields, the pin command and the
 * fails-before command (with the fix's parent when the fix is committed). No imports.
 */

/** The fields a regression file still lacks ([] when it counts). j: its parsed JSON (null: not valid JSON). */
export function regressionMissing(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return ['valid JSON object'];
  const miss = [];
  if (!Number.isInteger(j.seed)) miss.push('seed (an integer)');
  if (j.kind === 'test') {
    if (!(typeof j.test?.file === 'string' && j.test.file)) miss.push('test.file');
    if (!(typeof j.test?.name === 'string' && j.test.name)) miss.push('test.name');
  } else {
    if (!Number.isInteger(j.tick)) miss.push('tick (an integer)');
    if (!/^[0-9a-f]{64}$/i.test(String(j.sha256 || ''))) miss.push('sha256 (the pinned hash: node qa/check-regressions.mjs --update)');
  }
  return miss;
}

/** The fails-before command for this task's regression; fix: the fix commit (short or long sha) when known. */
export const failsBeforeCommand = (taskId, fix = null) => `node qa/fails-before.mjs qa/regressions/${taskId}.json "${fix ? `${String(fix).slice(0, 12)}^` : '<the fix commit>^'}"`;

/** The steps, one per line, for a bug task's regression. */
export function regressionHowTo(taskId, { fix = null } = {}) {
  return [
    `Add qa/regressions/${taskId}.json after you claim the task (any qa/regressions/*.json written since the claim counts; name it after the task).`,
    `A cartridge replay: { "id": "${taskId}", "seed": <int>, "tick": <int>, "actions": [...], "description": "what broke", "fixed": true }, then pin its hash: node qa/check-regressions.mjs --update (adds "sha256").`,
    `Or, where no cartridge covers the bug, a seeded game unit test: { "id": "${taskId}", "kind": "test", "test": { "file": "<test file>", "name": "<test name>" }, "seed": <int>, "description": "what broke", "fixed": true } (qa/regressions/README.md).`,
    `It must fail on the code before the fix: commit the fix with the task's tag, then check: ${failsBeforeCommand(taskId, fix)}`,
  ];
}
