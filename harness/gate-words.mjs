/**
 * harness/gate-words.mjs — gate results in plain words, failing first (2.30c, G3).
 *
 * Every run report, release report and verify summary uses this: what failed comes first, each with
 * one plain sentence of what it means; then what was NOT run (skipped, deep, optional off, or never
 * recorded), kept apart so "not run" is never read as "pass"; then what passed.
 */
export const PLAIN = {
  session: 'the session files (task, plan, notes) are missing or malformed',
  purity: 'the sim uses something non-deterministic (clock, random, I/O)',
  isolation: 'the sim reaches into renderer or browser code',
  golden: 'the recorded results (golden hashes) no longer match the sim',
  'golden-py': 'the Python check of the recorded results disagrees',
  regressions: 'a bug that was fixed came back',
  'vertical-slice': 'the game no longer plays from start to finish',
  playtest: 'the scripted playtest fails',
  'browser-play': 'the browser build does not load or play',
  soak: 'a long run with many seeds breaks or drifts',
  'tick-budget': 'a sim tick takes longer than its budget',
  approvals: 'something needs a sign-off that it does not have',
  'hub-smoke': 'the War Room server does not start or answer',
  assets: 'an asset has no licence, a bad licence, or stale credits',
  docs: 'a doc points at something that does not exist',
  secrets: 'a key or secret-shaped string is in the repo',
  selftest: 'the harness self-test found a check that no longer bites',
  balance: 'the balance sweep is out of range',
  fun: 'the fun check is below its bar',
  'renderer-budget': 'the renderer is over its draw or memory budget',
  'module-size': 'a game module is too big for parallel lanes',
  'function-size': 'a function is too long',
  hud: 'the War Room fails in a real browser',
  engine: 'the engine build fails',
  parity: 'the engine port and the sim disagree',
  reviewer: 'a system task lacks a review from another model family',
};
const plain = (id) => PLAIN[id] || `the ${id} gate failed`;

/**
 * rec: a gates-last.json record ({ rows, skipped, partial, at }) or null. allGates: studio/gates.json gates.
 * Returns { failing, notRun, passing, warn, lines } — lines are ready to print or put in a report.
 */
export function gateWords(rec, allGates = []) {
  const rows = rec?.rows || [];
  const ran = new Set(rows.map((r) => r.id));
  const failing = rows.filter((r) => !r.ok && r.required !== false);
  const warn = rows.filter((r) => !r.ok && r.required === false);
  const passing = rows.filter((r) => r.ok);
  const notRun = allGates.filter((g) => !ran.has(g.id)).map((g) => ({ id: g.id, why: (rec?.skipped || []).find((x) => x.startsWith(g.id)) ? (/\(deep\)/.test((rec.skipped || []).find((x) => x.startsWith(g.id))) ? 'deep check, not in everyday verify' : 'not in this scope') : rec?.partial ? 'not in this partial run' : !rec ? 'no verify recorded' : g.required === false ? 'optional' : 'not run' }));
  const lines = [];
  if (!rec) lines.push('NOT RUN: no verify has been recorded yet, so nothing below is a pass.');
  if (failing.length) lines.push(`FAILING (${failing.length}):`, ...failing.map((r) => `  - ${r.id}: ${plain(r.id)}`));
  else if (rec) lines.push('FAILING: none of the gates that ran.');
  if (warn.length) lines.push(`WARN, optional (${warn.length}):`, ...warn.map((r) => `  - ${r.id}: ${plain(r.id)}`));
  if (notRun.length) lines.push(`NOT RUN (${notRun.length}, not a pass):`, ...notRun.map((g) => `  - ${g.id}: ${g.why}`));
  lines.push(`PASSING (${passing.length}): ${passing.map((r) => r.id).join(', ') || 'none'}`);
  return { failing, warn, notRun, passing, lines };
}
