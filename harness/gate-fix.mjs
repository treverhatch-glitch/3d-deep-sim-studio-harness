#!/usr/bin/env node
/**
 * harness/gate-fix.mjs — 2.66.0 (d): one "Fix:" line under every gate failure.
 *
 * A red gate printed its id and its log, and the agent (or person) reading it had to guess the next step: rerun all of
 * verify, read the gate's script, or work around it. scripts/run-gates.mjs now prints one line after each failing
 * gate's FAIL (or WARN) line:
 *
 *   [gates] FAIL golden
 *   [gates] Fix: a replay hash changed: … then rerun only this gate: npm run verify -- --only golden
 *
 * Where the text comes from, first match wins:
 *   1. the gate's own "fix" in studio/gates.json (a studio's own gate says its own next step);
 *   2. a failing check of the game gate: the first `[game-gates] FAIL <id>` line in its output picks that kind's entry
 *      (game:qa, game:layout, engine:<project>, a manifest check …);
 *   3. a timeout in the output (the gate was killed, not wrong): the load advice;
 *   4. the table below, by gate id;
 *   5. the fallback: read the log (named) and rerun only this gate.
 * Safety gates (protected, weakened-tests, hooks, secrets) never tell an agent to approve: they say to put it back or
 * hand the task back; only the owner approves.
 *
 *   node harness/gate-fix.mjs <gate-id>   print the Fix line for that gate
 *   node harness/gate-fix.mjs --check     exit 1 when a gate in studio/gates.json or a game gate kind (read from
 *                                         harness/game-gates.mjs) has no entry of its own (it would get the fallback)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Gate id (studio/gates.json) → the next step when it fails. The rerun hint is added by gateFix. */
export const GATE_FIXES = {
  session: 'a read-order file is missing (the [session] MISSING line names it) or AGENTS.md lost its lock.mjs rule: restore it from the base branch (git checkout <base> -- <file>)',
  purity: 'the sim calls something impure at the file:line above (DOM, Math.random, Date.now, timers, eval, inexact Math): use the seeded RNG, the tick counter or harness/det-math.mjs instead',
  isolation: 'presentation code (a rendering or UI import, DOM access, Math.random) is in the sim layer at the file:line above: move it out to the view and pass data in',
  golden: 'a replay hash changed: if the sim change was intended, npm run golden -- --update and commit the hashes with the change (Golden-Reason trailer); if not, the change broke determinism (node harness/replay.mjs --trace finds the tick)',
  'golden-py': 'the Python replay disagrees with qa/golden (or Python 3 is not on PATH): run node qa/run-python.mjs qa/test-golden.py to see which golden; hashes change only with npm run golden -- --update after an intended sim change',
  regressions: 'a fixed bug\'s replay in qa/regressions/ no longer matches or its test fails: the change brought the bug back, so fix the code; the regression file is protected and only the owner changes it',
  'vertical-slice': 'start-to-win no longer reaches its outcome, breaks an invariant or is not deterministic: npm run playtest names the first bad tick; fix the sim (an intended change of the final hash: npm run golden -- --update)',
  playtest: 'stage 1 stopped at a tick that throws, freezes or breaks an invariant: replay the tick and actions it printed with node harness/replay.mjs --trace and fix the sim there',
  'browser-play': 'the browser build is blank, frozen, has script errors or shows numbers that differ from the sim: npm run play:browser and read its report in qa/reports/; fix the view or the cartridge\'s browser wiring',
  soak: 'a long seeded run broke an invariant or replayed differently: node qa/soak.mjs --seeds 3 --ticks 300 names the seed; replay that seed and fix the sim',
  'tick-budget': 'the sim is slower than its budget (tickBudgetMs in cartridges/<name>/cartridge.json): make the tick cheaper; raising the budget is a design call to hand back, not a fix',
  approvals: 'a file uses an unapproved or unlisted URL (the [approvals] FAIL line): remove it, or ask a person to list and approve it in studio/references/APPROVALS.md',
  'hub-smoke': 'a HUB security rule failed (token, Host header, WebSocket origin, bind): npm run hub:smoke and fix hub/server.mjs; never loosen the rule to pass',
  assets: 'a shipped file has no record (or a stale one) in studio/assets/manifest.json, or game code points at references/ or assets/staging/: npm run asset -- add <file> with its source and licence, or stop using it',
  docs: 'a doc names an npm script or file that does not exist (fix the doc line shown), or a STUDIO_* setting is used but undocumented (describe it in a docs/ page, then node scripts/settings-map.mjs)',
  fidelity: 'the Bible\'s fidelity checklist is malformed or a required mechanic is missing: npm run fidelity -- list shows it; fix the checklist, or queue the missing mechanic with npm run fidelity -- send-back',
  game: 'one of the game\'s own checks failed (the [game-gates] FAIL line names it): run node harness/game-gates.mjs to see it alone and fix the game code it names',
  'godot-unit': 'a gdUnit4 test failed (exit 100) or a script did not load (exit 105): npm run godot-unit and fix the test or script its report names',
  controls: 'a Game Bible control has no passing real-input result on a track: npm run play:controls and make that control work; the controls list itself (studio/bible/controls.json) changes only with the owner',
  protected: 'a protected file (studio/protected.json) changed without the owner\'s signed approval: put it back (git checkout <base> -- <file>) or hand the task back with a note naming the file and why; only the owner approves',
  secrets: 'a key-shaped string is in a file or in a commit not on the base branch: remove it, have the key rotated, and ask a person to rewrite the commit that holds it; never paste the key anywhere',
  hooks: 'a commit since the base has no valid Studio-Hooks stamp (made with --no-verify, or the hooks are not installed): npm run hooks:install, then re-commit it with the hooks (in a lane copy: npm run hooks -- restamp); exceptions are the owner\'s call',
  'weakened-tests': 'a test was weakened since the base (removed assert, skip/only, raised timeout, wider tolerance): put the test back and make the code pass it; a golden change needs a Golden-Reason trailer; anything else, hand the task back for the owner',
  'content-schema': 'a content file in cartridges/<game>/content/ is invalid (no id, no integer phase, a schema error, or a layer not "yes" in the Bible): fix the item on the FAIL line (npm run check:content)',
  selftest: 'a harness self-check failed (the FAIL line names it): fix the harness code it checks; never edit the check to make it pass',
  balance: 'the tuned knob\'s current value is outside its target band (win rate or median tick): npm run balance -- --cartridge <game> --knob <key> --values a,b,c shows which value lands inside; set it in the cartridge\'s TUNING table',
  fun: 'the slice cannot be won, or doing nothing wins as fast as playing: make the player\'s choices change the outcome in the sim (npm run fun shows the proxies)',
  'renderer-budget': 'draw calls, triangles, lights or frame time are over budget (studio/rules/renderer-budget.md): batch or instance meshes and cut lights, then measure again with node scripts/check-renderer-budget.mjs',
  'module-size': 'a game module is over the line limit (node scripts/check-module-size.mjs lists it): split it so lanes can work on it in parallel (studio/rules/lanes.md)',
  'function-size': 'a game function or file is over its limit (STUDIO_FN_MAX_LINES, STUDIO_FILE_MAX_LINES, STUDIO_FILE_MAX_KB): split the function or file it names',
  hud: 'the War Room failed a browser check (console error, sideways scroll, a view that did not update): npm run hud:check and fix the hub view it names',
  engine: 'the engine track\'s headless tests or smoke run failed (engine/<game>/engine.json "gate"): npm run engine:gate and fix the SCRIPT ERROR or test it logs',
  parity: 'the web game and its engine port disagree on a seed\'s outcome or tick: npm run parity names the seed; replay it on both and fix the side that drifted',
  vision: 'a screenshot scored below the art reference: compare the task\'s proof shots with the reference and fix the look (opt-in check, STUDIO_VISION=1)',
  reviewer: 'a code review in studio/reviews/ lacks model-family and implementer-family, or the reviewer\'s model family matches the implementer\'s: get a cross-family review with npm run review -- <TASK_ID>',
};

/** The game gate's own checks (harness/game-gates.mjs), by kind. "game:*" is any check a game's studio.gates.json declares. */
export const GAME_GATE_FIXES = {
  'game:qa': 'the game\'s scenarios (<game>/sim/qa.mjs) failed: run that file with node from the repo root and fix the sim behaviour it names',
  'game:playtest': 'the game\'s playtest (<game>/sim/playtest.mjs) failed: run it alone, find the first tick that breaks, and fix the sim there',
  'game:golden': 'the game\'s golden replays (<game>/sim/golden.mjs) changed: if the sim change was intended, update the hashes the game\'s way and commit them with a Golden-Reason trailer; if not, find the change that broke determinism',
  'game:det-math': 'the game\'s sim calls inexact Math (sin, cos, atan2, pow, **, …): use the harness/det-math.mjs functions instead (the mode is "detMath" in the game\'s studio.gates.json)',
  'game:layout': 'the game\'s exported layout breaks one of its own rules in studio.layout.json (the line names the object and the rule): fix where the view places it, not the rule',
  'game:none': 'the game declares no checks: add <game>/studio.gates.json with at least one gate (or <game>/sim/qa.mjs)',
  'game:*': 'a check from the game\'s studio.gates.json failed: run its "command" from the repo root, fix the failing tests it names (the [game-gates] failing tests line lists them)',
  'engine:*': 'Godot\'s headless import or tools/gate.gd failed in this project: fix the script on the SCRIPT ERROR / Parse Error line above (STUDIO_GODOT names the Godot binary)',
};

const TIMEOUT = /\btimed out\b|\bETIMEDOUT\b|\bSIGTERM\b.*\btimeout\b/i;

const safeId = (id) => String(id).replace(/[^\w.-]/g, '_');

/** The entry for one game check id (game:qa, engine:web/x, game:unit …), or null. */
export function gameKindFix(id) {
  const s = String(id || '');
  if (GAME_GATE_FIXES[s]) return GAME_GATE_FIXES[s];
  if (s.startsWith('engine:')) return GAME_GATE_FIXES['engine:*'];
  if (s.startsWith('game:')) return GAME_GATE_FIXES['game:*'];
  return null;
}

/**
 * The next step for a failed gate: { text, source } where source is gates.json | game-check | timeout | table |
 * fallback. `gate` is the studio/gates.json entry (or an id); `output` its captured log when there is one.
 */
export function gateFix(gate, { output = '', compact = false } = {}) {
  const g = typeof gate === 'string' ? { id: gate } : gate || {};
  const id = String(g.id || 'unknown');
  const log = compact ? `.studio/gates/out/${safeId(id)}.log` : 'its output above';
  const rerun = `then rerun only this gate: npm run verify -- --only ${id}`;
  const text = String(output || '');
  if (typeof g.fix === 'string' && g.fix.trim()) return { text: `${g.fix.trim()}; ${rerun}`, source: 'gates.json' };
  const sub = text.match(/\[game-gates\] FAIL (\S+?)(?::\s|:?$|\s)/m);
  if (sub && gameKindFix(sub[1])) return { text: `${sub[1]}: ${gameKindFix(sub[1])}; ${rerun}`, source: 'game-check' };
  if (TIMEOUT.test(text)) return { text: `it timed out, which is often load rather than a wrong result: check what else is running (npm run status), wait for heavy work to finish, ${rerun}; a timeout on a quiet machine is a slow check to fix (${log})`, source: 'timeout' };
  if (GATE_FIXES[id]) return { text: `${GATE_FIXES[id]}; ${rerun}${compact ? ` (full log: ${log})` : ''}`, source: 'table' };
  const kind = gameKindFix(id);
  if (kind) return { text: `${kind}; then rerun: npm run verify -- --only game`, source: 'table' };
  return { text: `read ${log} for the first error and fix that, ${rerun}`, source: 'fallback' };
}

/** The line run-gates prints: "Fix: <next step>". Never throws. */
export function gateFixLine(gate, opts = {}) {
  try {
    return `Fix: ${gateFix(gate, opts).text}`;
  } catch {
    const id = typeof gate === 'string' ? gate : gate?.id;
    return `Fix: read the gate's output above for the first error and fix that, then rerun only this gate: npm run verify -- --only ${id}`;
  }
}

/**
 * The game gate's check kinds, read from harness/game-gates.mjs itself (so a new kind added there without an entry
 * here is caught): literal 'game:<x>' ids, the conventional <sim>/<x>.mjs files, and the templated game:/engine: ids.
 */
export function gameGateKinds(root = ROOT) {
  let src = '';
  try { src = fs.readFileSync(path.join(root, 'harness', 'game-gates.mjs'), 'utf8'); } catch { return []; }
  const kinds = new Set();
  for (const m of src.matchAll(/id: '(game:[\w-]+)'/g)) kinds.add(m[1]);
  for (const m of src.matchAll(/\[\s*'([\w-]+)',\s*'[\w-]+\.mjs'\s*\]/g)) kinds.add(`game:${m[1]}`);
  if (/id: `game:\$\{/.test(src)) kinds.add('game:*');
  if (/id: `engine:\$\{/.test(src)) kinds.add('engine:*');
  return [...kinds].sort();
}

/** Gates (studio/gates.json) and game check kinds with no entry of their own: they would get the fallback. */
export function fixCoverage(root = ROOT) {
  const gates = JSON.parse(fs.readFileSync(path.join(root, 'studio', 'gates.json'), 'utf8')).gates || [];
  const missing = [];
  for (const g of gates) if (!(typeof g.fix === 'string' && g.fix.trim()) && !GATE_FIXES[g.id]) missing.push(g.id);
  const kinds = gameGateKinds(root);
  for (const k of kinds) if (!GAME_GATE_FIXES[k]) missing.push(k);
  return { ok: missing.length === 0, missing, gates: gates.length, kinds };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const a = process.argv.slice(2);
  if (a[0] === '--check') {
    const c = fixCoverage();
    if (!c.ok) {
      console.error(`[gate-fix] FAIL ${c.missing.length} gate(s) or game check kind(s) have no Fix entry: ${c.missing.join(', ')}`);
      console.error('[gate-fix] Fix: add a "fix" to the gate in studio/gates.json (one concrete next step), or an entry in GATE_FIXES / GAME_GATE_FIXES in harness/gate-fix.mjs');
      process.exit(1);
    }
    console.log(`[gate-fix] PASS every gate (${c.gates}) and game check kind (${c.kinds.length}) has its own Fix line`);
  } else if (a[0] && !a[0].startsWith('-')) {
    let gate = { id: a[0] };
    try { gate = (JSON.parse(fs.readFileSync(path.join(ROOT, 'studio', 'gates.json'), 'utf8')).gates || []).find((g) => g.id === a[0]) || gate; } catch {}
    console.log(gateFixLine(gate));
  } else {
    console.log('Usage: node harness/gate-fix.mjs <gate-id> | --check');
  }
}
