/**
 * harness/control-effects.mjs — 2.39.0: what a control must change in the game, said in the Game Bible.
 *
 * Until 2.38 a control's "did it work" test was the game's own: the `expect` function an agent writes in
 * the cartridge's qa.mjs. A weak or wrong one (`expect: () => true`, or one that only checks the screen)
 * passes a buy button that buys nothing. The research pack's Hatchfield timeline has them: "Fire bell does
 * nothing", "Extra jet bridges ... buy nothing". The Game Bible is protected (only the owner signs changes),
 * so an effect written there is a check the builder can't weaken.
 *
 * In studio/bible/controls.json a control may carry `effect` (one or a list):
 *   { "path": "resources.credits", "change": "down" }
 *   { "path": "entities[kind=unit].length", "change": "up" }
 *   change: "up" | "down" | "changes" | "same" | a number (the exact difference after - before)
 * `path` reads the sim state: dotted keys, `.length` of a list, and `list[field=value]` to keep the items
 * whose field equals value. The web track checks it on the sim state before and after the real press.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './event.mjs';

export const BIBLE_CONTROLS = path.join(REPO_ROOT, 'studio', 'bible', 'controls.json');

/** The value at `p` in `obj`, or undefined. */
export function readPath(obj, p) {
  let cur = obj;
  for (const seg of String(p || '').split('.').filter(Boolean)) {
    if (cur === undefined || cur === null) return undefined;
    const m = seg.match(/^([^[\]]+)(?:\[([^=\]]+)=([^\]]*)\])?$/);
    if (!m) return undefined;
    cur = m[1] === 'length' && Array.isArray(cur) ? cur.length : cur[m[1]];
    if (m[2] !== undefined) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur.filter((x) => x && String(x[m[2]]) === m[3]);
    }
  }
  return cur;
}

/** One effect on before/after states: { path, change, before, after, ok, why }. */
export function checkEffect(effect, before, after) {
  const p = effect?.path;
  const change = effect?.change ?? 'changes';
  const a = readPath(before, p);
  const b = readPath(after, p);
  const res = { path: p, change, before: a, after: b, ok: false, why: null };
  if (!p) return { ...res, why: 'the effect names no path' };
  if (a === undefined || b === undefined) return { ...res, why: `the sim state has no ${p}` };
  const num = typeof a === 'number' && typeof b === 'number';
  if (change === 'changes') res.ok = JSON.stringify(a) !== JSON.stringify(b);
  else if (change === 'same') res.ok = JSON.stringify(a) === JSON.stringify(b);
  else if (change === 'up' || change === 'down') {
    if (!num) return { ...res, why: `${p} is not a number` };
    res.ok = change === 'up' ? b > a : b < a;
  } else if (typeof change === 'number') {
    if (!num) return { ...res, why: `${p} is not a number` };
    res.ok = Math.abs(b - a - change) < 1e-9;
  } else return { ...res, why: `unknown change "${change}" (up, down, changes, same or a number)` };
  if (!res.ok) res.why = `${p} should ${typeof change === 'number' ? `change by ${change}` : change === 'changes' ? 'change' : change === 'same' ? 'stay the same' : `go ${change}`} (was ${JSON.stringify(a)}, now ${JSON.stringify(b)})`;
  return res;
}

/** The Bible's controls by id: Map(id -> entry). */
export function bibleControls(file = BIBLE_CONTROLS) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return new Map((Array.isArray(j.controls) ? j.controls : []).filter((c) => c && c.id).map((c) => [String(c.id), c]));
  } catch {
    return new Map();
  }
}

export const effectsOf = (entry) => (entry?.effect ? (Array.isArray(entry.effect) ? entry.effect : [entry.effect]) : []);

/** Every Bible effect for control `id` on before/after: [] when the Bible names none. */
export function checkEffects(id, before, after, bible = bibleControls()) {
  return effectsOf(bible.get(String(id))).map((e) => checkEffect(e, before, after));
}
