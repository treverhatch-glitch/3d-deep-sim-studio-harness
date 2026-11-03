/**
 * studio/logic-library/modules/example-step-toward/step-toward.mjs — the logic library's made-up example module
 * (2.72.0): it is here so the library's own tests have one module to find and check. Not from any game.
 */
export function stepToward(value, target, maxStep) {
  const step = Math.max(0, maxStep);
  if (value < target) return Math.min(target, value + step);
  if (value > target) return Math.max(target, value - step);
  return value;
}
