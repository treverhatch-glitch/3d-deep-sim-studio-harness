/**
 * harness/gate-subids.mjs — 2.72.0 (a): which part of a gate failed, as sub-ids.
 *
 * 83 of 91 failed gate runs on the owner's PC carried the single id `game`: every red looked the same to the stall
 * watcher, the train and the hand-back. A sub-id names the part: `<check>:<test file>` for a game check that names its
 * failing test files (game-gates' "failing test files in <check>: [...]", from vitest, jest, node --test or plain FAIL
 * lines: the 2.65.3 parsers), `<check>` for one that doesn't, `golden:<file>` for a red golden file
 * (qa/check-golden.mjs "[golden] FAIL <file>: ..."), `<gate>:<file>` for any other gate whose output names failing test
 * files, else the gate id. Examples: `game:test:src/econ/fees.test.ts`, `game:layout`, `golden:example-1337.json`.
 * run-gates puts them in each failed row (`sub`) and in the gates.run event (`meta.subIds`, beside `meta.failed`,
 * unchanged); the hand-back facts list them ("Failing sub-ids"); the train's red event carries them. Read only from the
 * output; never decides red or green.
 */
import { failingTestFiles, focusFromLog, normTestPath } from './train-focus.mjs';

export const SUB_CAP = 20;
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const clean = (t) => String(t || '').replace(ANSI, '').replace(/^\s*\|\s?/gm, ''); // a fenced child line reads "| ..."

/**
 * A test path relative to the checkout when it is under one of `roots` (node --test prints absolute paths; a sub-id
 * must read the same in a lane copy, a train's scratch copy and the main checkout). Windows: case-insensitive.
 */
export function repoRel(p, roots = []) {
  const s = normTestPath(p);
  const win = /^[A-Za-z]:\//.test(s) || process.platform === 'win32';
  for (const r of roots.filter(Boolean)) {
    const base = normTestPath(String(r)).replace(/\/+$/, '');
    if (!base) continue;
    const a = win ? s.toLowerCase() : s;
    const b = win ? base.toLowerCase() : base;
    if (a.startsWith(`${b}/`)) return s.slice(base.length + 1);
  }
  return s;
}

/** The golden files a check-golden output names as red. */
export function goldenFails(text) {
  const out = [];
  for (const l of clean(text).split(/\r?\n/)) {
    const m = l.match(/^\[golden\] FAIL (\S+?\.json):/);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** Sub-ids from the game checks' own lines (game-gates' FAIL and "failing test files in" lines). */
export function gameSubIds(text, roots = []) {
  const f = focusFromLog(clean(text));
  const out = [];
  for (const id of f.failed) {
    const files = f.files[id] || [];
    if (files.length) for (const x of files) out.push(`${id}:${repoRel(x, roots)}`);
    else out.push(id);
  }
  return out;
}

/** The sub-ids of ONE failed gate, from its own output. Never empty: the gate id when nothing finer is named. */
export function subIdsFor(gateId, text, { cap = SUB_CAP, roots = [] } = {}) {
  const id = String(gateId || '');
  let out = [];
  const game = gameSubIds(text, roots);
  if (game.length) out = game;
  const gold = goldenFails(text).map((f) => `golden:${f}`);
  if (gold.length) out = [...out, ...gold];
  if (!out.length) {
    const files = failingTestFiles(clean(text));
    out = files.length ? files.map((f) => `${id}:${repoRel(f, roots)}`) : [];
  }
  out = [...new Set(out)];
  return out.length ? out.slice(0, cap) : [id];
}

/**
 * The sub-ids a whole verify log names: each "[gates] FAIL <id>" gate's part of the log (the lines since the previous
 * gate's verdict) read by subIdsFor; a log with game-gates or golden lines but no run-gates verdict (a game check run
 * on its own) is read whole.
 */
export function subIdsFromLog(text, { cap = SUB_CAP, roots = [] } = {}) {
  const lines = clean(text).split(/\r?\n/);
  const out = [];
  let from = 0;
  let any = false;
  lines.forEach((l, i) => {
    const m = l.match(/^\[gates\] (PASS|FAIL|WARN) (\S+)/);
    if (!m) return;
    any = true;
    if (m[1] === 'FAIL') {
      // A compact run prints the gate's output after its verdict ("[gates] <id> output (...)"): read that too.
      let seg = lines.slice(from, i);
      const hdr = lines.findIndex((x, j) => j > i && x.startsWith(`[gates] ${m[2]} output`));
      if (hdr !== -1) { const end = lines.findIndex((x, j) => j > hdr && /^\[gates\] /.test(x)); seg = seg.concat(lines.slice(hdr + 1, end === -1 ? undefined : end)); }
      for (const s of subIdsFor(m[2], seg.join('\n'), { cap, roots })) if (!out.includes(s)) out.push(s);
    }
    from = i + 1;
  });
  if (!any) { const s = [...gameSubIds(text, roots), ...goldenFails(text).map((f) => `golden:${f}`)]; for (const x of s) if (!out.includes(x)) out.push(x); }
  return out.slice(0, cap);
}

/** The sub-ids of a gates.run event (meta.subIds; before 2.72.0 only meta.failed, the gate ids). */
export const subIdsOf = (event) => (Array.isArray(event?.meta?.subIds) && event.meta.subIds.length ? event.meta.subIds.map(String) : Array.isArray(event?.meta?.failed) ? event.meta.failed.map(String) : []);
