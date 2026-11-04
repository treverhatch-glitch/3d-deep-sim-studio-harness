#!/usr/bin/env node
/**
 * harness/engine-tune.mjs — 2.77.0 (u, P5.4): an engine lane tunes its own engine settings without an owner gate.
 *
 * The owner (2026-11-04): the Unity lane "may adjust its own settings (quality level, HDRP volume, LOD bias, batch flags,
 * its RAM floor) without an owner gate, logged". So these keys (harness/engine-tracks.mjs TUNE_KEYS; the owner narrows
 * the list with studio/game.json engines.<x>.tune.allow) live in studio/engine/<engine>-tune.json, which is NOT a
 * protected file, and every change is logged: the decisions log (.studio/decisions.jsonl, action engine-tune, with its
 * undo), an engine.tuned event and a line in studio/engine/LOG.md. Anything else (the land command, the target, its
 * exits, the rig cost, a key not in the list) stays in studio/game.json, which only the owner changes: a tune of such a
 * key is refused and says so.
 *
 * Where they take effect: ram-floor is the free RAM the engine's land runs wait for (harness/unity-gate.mjs; the owner's
 * environment setting, e.g. STUDIO_UNITY_MIN_FREE_GB, still wins); batch-flags go to the land command as {flags} and
 * STUDIO_ENGINE_FLAGS; every value goes to it as STUDIO_ENGINE_TUNE (JSON) and STUDIO_ENGINE_TUNE_FILE, so the project's
 * own land or build script applies quality level, volume and LOD bias. The harness never edits the project's settings
 * files itself.
 *
 *   npm run engine -- tune <engine>                                  the values and what may be tuned
 *   npm run engine -- tune <engine> <key> <value> --by <you> --why "…"
 *   npm run engine -- tune <engine> <key> --unset --by <you> --why "…"
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitEvent } from './event.mjs';
import { mainRoot } from './worktree.mjs';
import { TUNE_KEYS, engineTarget, readTune, tunePath, ENGINE_NAME_RE } from './engine-tracks.mjs';

/** Set (or unset) one tunable value. { ok, why, from, to } — never touches a protected file. */
export async function tuneEngine(engine, key, value, { by, why = '', unset = false, root = mainRoot() } = {}) {
  if (!ENGINE_NAME_RE.test(String(engine || ''))) return { ok: false, why: `"${engine}" is not an engine name` };
  const t = engineTarget(engine, { root });
  if (!by || !String(by).trim()) return { ok: false, why: '--by <you>: every change is logged with who made it' };
  if (String(why).trim().length < 8) return { ok: false, why: '--why "…": say why (8+ characters); it goes in the decisions log' };
  if (!TUNE_KEYS[key]) return { ok: false, why: `${key} is not a setting an engine lane tunes itself (${Object.keys(TUNE_KEYS).join(', ')}). Anything else about the ${t.label} track (its land command, target, exits, rig cost) is in studio/game.json, which only the owner changes (npm run approve -- protected)` };
  if (!t.tune.includes(key)) return { ok: false, why: `the owner took ${key} off the ${t.label} lane's list (studio/game.json engines.${engine}.tune.allow: ${t.tune.join(', ') || 'nothing'}): it stays the owner's` };
  let next;
  if (!unset) { const c = TUNE_KEYS[key].check(value); if (!c.ok) return { ok: false, why: `${key}: ${c.why}` }; next = c.value; }
  const file = tunePath(root, engine);
  const cur = readTune(engine, root);
  const from = Object.prototype.hasOwnProperty.call(cur.values, key) ? cur.values[key] : null;
  const values = { ...cur.values };
  if (unset) delete values[key]; else values[key] = next;
  const at = new Date().toISOString();
  const log = [...cur.log, { at, by, key, from, to: unset ? null : next, why: String(why).trim().slice(0, 300) }].slice(-100);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ note: `The ${t.label} lane's own settings (harness/engine-tune.mjs). Not protected: the lane changes them itself, each change logged in .studio/decisions.jsonl.`, values, log }, null, 2)}\n`);
  const show = (v) => (v === null || v === undefined ? '(unset)' : Array.isArray(v) ? v.join(' ') : String(v));
  const undo = { kind: 'engine-tune', text: from === null ? `npm run engine -- tune ${engine} ${key} --unset --by <name> --why "undo"` : `npm run engine -- tune ${engine} ${key} ${JSON.stringify(show(from))} --by <name> --why "undo"`, engine, key, value: from };
  try { (await import('./decisions-log.mjs')).logDecision({ action: 'engine-tune', subject: `${engine}:${key}`, by, as: 'agent', why: `${key} ${show(from)} -> ${show(unset ? null : next)}: ${String(why).trim()}`, evidence: path.relative(root, file).split(path.sep).join('/'), undo, root }); } catch {}
  try { emitEvent({ type: 'engine.tuned', agent: by, track: `engine:${engine}`, msg: `${t.label} lane tuned ${key}: ${show(from)} -> ${show(unset ? null : next)} (${String(why).trim()})`.slice(0, 400), meta: { engine, key, from, to: unset ? null : next } }); } catch {}
  try { (await import('./engine.mjs')).logEngine(`${engine} tune ${key}: ${show(from)} -> ${show(unset ? null : next)} (${String(why).trim().slice(0, 120)})`, by); } catch {}
  return { ok: true, from, to: unset ? null : next, file, why: `${t.label} ${key}: ${show(from)} -> ${show(unset ? null : next)}; logged (npm run decisions -- --action engine-tune)` };
}

export function tuneText(engine, root = mainRoot()) {
  const t = engineTarget(engine, { root });
  if (!t) return `"${engine}" is not an engine name.`;
  const cur = readTune(engine, root).values;
  return [`${t.label} lane settings (studio/engine/${engine}-tune.json; the lane tunes these itself, each change logged):`, ...t.tune.map((k) => `  ${k.padEnd(14)} ${Object.prototype.hasOwnProperty.call(cur, k) ? (Array.isArray(cur[k]) ? cur[k].join(' ') : cur[k]) : '(unset)'}  — ${TUNE_KEYS[k].what}`), `Everything else is the owner's (studio/game.json engines.${engine}).`].join('\n');
}

export async function tuneCli(argv) {
  const opt = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  const pos = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && !['--unset'].includes(argv[i - 1])));
  const [engine, key, value] = pos;
  if (!engine) { console.error('Usage: npm run engine -- tune <engine> [<key> <value>|--unset] --by <you> --why "…"'); return 2; }
  if (!key) { console.log(tuneText(engine)); return 0; }
  const r = await tuneEngine(engine, key, value, { by: opt('by') || process.env.STUDIO_LOCK_OWNER || '', why: opt('why') || '', unset: argv.includes('--unset') });
  (r.ok ? console.log : console.error)(`[engine] ${r.ok ? '' : 'not changed: '}${r.why}`);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) process.exit(await tuneCli(process.argv.slice(2)));
