#!/usr/bin/env node
/**
 * harness/verdict-split.mjs — 2.30o: a task's proof as separate results, with what was never checked.
 *
 * "It built" is not "it plays", and a passing sim is not "it looks right". Each task's proof records
 * five results separately: build, logic (sim/scenarios), runtime (it ran with no errors), visual (fixed-
 * camera captures, harness/visual-proof.mjs) and viewport (desktop and mobile sizes). Any part with no
 * result is listed as **unchecked**, never counted as a pass. A render task (Godot, graphics, visuals, a
 * scene, models, water, lighting, camera, piers ...) can't finish until its visual result passed.
 *
 *   .studio/proof/<TASK>/verdict.json   { parts: { build: {ok, why, at, by, evidence[]}, ... } }
 *
 *   node harness/verdict-split.mjs set <TASK> <part> pass|fail [--why "..."] [--evidence "a|b"]
 *   node harness/verdict-split.mjs show <TASK> [--json]
 *   node harness/verdict-split.mjs gate <TASK> [--title "..."]   exit 1 when the task can't finish
 * STUDIO_VISUAL_GATE=off turns the render-task requirement off.
 *
 * 2.60.1 (B-38): what makes a task a render task, in order (renderDecision):
 *   1. the owner's visual-proof decision (npm run task -- visual <ID> off|on, harness/reclassify.mjs), when valid;
 *   2. the board's own visual flag, the role (only build work renders), a godot track or a visual/art/render type;
 *   3. a valid owner type that isn't render work (change, chore, docs, ...: not art, bug or whole) outranks the title;
 *   4. evidence, once the task has commits: the files it changed (done-check's list) against the game's render paths
 *      ("visualPaths" globs in studio/game.json, else in the game's studio.gates.json). A render-looking title whose
 *      changes touch no render path needs no visual result ("no render files changed: …"); one that does still needs
 *      it. A title that doesn't look like render work but changes render files gets a warning ("a visual result is
 *      recommended"), and needs the result only with "visualStrict": true (studio/game.json) or STUDIO_VISUAL_STRICT=on.
 *      No render paths configured, or no commits yet: the title decides, as before.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, emitEvent } from './event.mjs';
import { captureHint } from './visual-capture.mjs';
import { ownerType, ownerVisual, ownerVisualWords } from './reclassify.mjs';
import { taskChanges, startedAt } from './done-check.mjs';
import { activeGame } from './cartridge.mjs';
import { parseNextQueue } from './task.mjs';

export const PARTS = ['build', 'logic', 'runtime', 'visual', 'viewport'];
const file = (task) => path.join(STUDIO_STATE_DIR, 'proof', task, 'verdict.json');

export function readVerdict(task) {
  try {
    return JSON.parse(fs.readFileSync(file(task), 'utf8'));
  } catch {
    return { task, parts: {} };
  }
}

export function setPart(task, part, { ok, why = '', evidence = [], by = process.env.STUDIO_LOCK_OWNER || 'harness' } = {}) {
  if (!PARTS.includes(part)) throw new Error(`unknown part ${part} (${PARTS.join(', ')})`);
  const v = readVerdict(task);
  v.task = task;
  v.parts = { ...v.parts, [part]: { ok: Boolean(ok), why, evidence, by, at: new Date().toISOString() } };
  fs.mkdirSync(path.dirname(file(task)), { recursive: true });
  fs.writeFileSync(file(task), `${JSON.stringify(v, null, 2)}\n`);
  return v;
}

/** A task whose title/brief/track says it changes what the player sees. */
export const RENDER_RX = /\b(godot|render(ing)?|graphics?|visuals?|scene|shader|mesh(es)?|3d models?|lighting|shadows?|water|foam|terrain|beach|palms?|piers?|docks?|boats? model|camera|sky|bloom|day\/night|hud port|texture)\b/i;
export function isRenderTask(t = {}) {
  return renderDecision(t).render;
}

// Owner types that say the work is not a render change (bug, whole and art keep the detection).
export const NOT_RENDER_TYPES = ['change', 'chore', 'docs', 'system', 'balance', 'fun', 'playtest', 'study', 'review', 'direction', 'idea', 'trick'];
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
/** The game's render paths (globs) and the strict switch: studio/game.json, else the game's studio.gates.json. */
export function renderPaths(root = REPO_ROOT, env = process.env) {
  const g = readJson(path.join(root, 'studio', 'game.json')) || {};
  let globs = Array.isArray(g.visualPaths) ? g.visualPaths : null;
  let from = globs ? 'studio/game.json visualPaths' : '';
  if (!globs) {
    let name = null;
    try { name = activeGame().name; } catch { name = null; }
    for (const top of name ? ['game', 'web'] : []) {
      const j = readJson(path.join(root, top, name, 'studio.gates.json'));
      if (Array.isArray(j?.visualPaths)) { globs = j.visualPaths.map((p) => `${top}/${name}/${String(p).replace(/^\.\//, '')}`); from = `${top}/${name}/studio.gates.json visualPaths`; break; }
    }
  }
  const strict = g.visualStrict === true || /^(on|1|true|yes)$/i.test(String(env.STUDIO_VISUAL_STRICT || ''));
  return { globs: (globs || []).map(String).filter(Boolean), from, strict };
}
/** A glob as a regexp: ** any depth, * one name, a folder (no wildcard, or a trailing /) everything under it. */
export function globRx(glob) {
  const g = String(glob).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!/[*?]/.test(g)) return new RegExp(`^${g.replace(/\/+$/, '').replace(/[.+^${}()|[\]\\]/g, '\\$&')}(/|$)`);
  const body = g.split(/(\*\*\/?|\*|\?)/).map((p) => (p === '**/' ? '(?:.*/)?' : p === '**' ? '.*' : p === '*' ? '[^/]*' : p === '?' ? '[^/]' : p.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('');
  return new RegExp(`^${body}$`);
}

/**
 * Whether a task needs a visual result, and why: { render, why, warn, renderFiles, by }.
 * t: the board task ({ id, title, role, track, type, visual }); t.changed (optional): the files it changed, else
 * done-check's list for t.id since it started (only when it has commits).
 */
export function renderDecision(t = {}, { env = process.env } = {}) {
  const id = t.id || null;
  let ov = null;
  try { ov = id ? ownerVisual(id) : null; } catch { ov = null; }
  if (ov?.visual === 'off') return { render: false, by: 'owner', why: ownerVisualWords(ov), owner: ov };
  if (ov?.visual === 'on') return { render: true, by: 'owner', why: ownerVisualWords(ov), owner: ov };
  const ignored = ov?.ignored ? `a visual-proof decision is on file but doesn't count: ${ov.ignored}` : '';
  const out = (render, by, why, extra = {}) => ({ render, by, why, ...(ignored ? { ignored } : {}), ...extra });
  if (/^(off|no)$/i.test(String(t.visual ?? ''))) return out(false, 'board', 'the board says visual: off');
  // Only build work renders: an art, design or planning task proposing placeholders is not gated here.
  if (t.role && !/^(builder|engine-porter|dev-hacker)$/.test(t.role)) return out(false, 'role', `a ${t.role} task`);
  if (t.visual === true || /^(on|yes|true)$/i.test(String(t.visual ?? ''))) return out(true, 'board', 'the board says visual: on');
  if (/engine:godot/i.test(String(t.track || ''))) return out(true, 'track', 'a godot engine task');
  if (/^(visual|art|render)$/i.test(String(t.type || ''))) return out(true, 'type', `a ${t.type} task`);
  let ot = null;
  try { ot = id ? ownerType(id) : null; } catch { ot = null; }
  if (ot?.type && NOT_RENDER_TYPES.includes(ot.type)) return out(false, 'owner type', `the owner made it a "${ot.type}" task (set by ${ot.by}${ot.permission ? `, recorded by ${ot.recordedBy || 'an agent'} on their permission` : ''}), which outranks the title`);
  const titled = RENDER_RX.test(`${t.title || ''}`);
  const cfg = renderPaths(REPO_ROOT, env);
  let changed = Array.isArray(t.changed) ? t.changed : null;
  if (!changed && id && cfg.globs.length) {
    try { const ch = taskChanges(id, startedAt(id)); changed = ch.commits?.length ? ch.files : null; } catch { changed = null; }
  }
  if (!cfg.globs.length || !changed?.length) return out(titled, 'title', titled ? 'its title looks like render work' : '');
  const rxs = cfg.globs.map(globRx);
  const renderFiles = changed.filter((f) => rxs.some((rx) => rx.test(String(f).replace(/\\/g, '/'))));
  const list = (a) => `${a.slice(0, 5).join(', ')}${a.length > 5 ? ` (+${a.length - 5} more)` : ''}`;
  if (titled && !renderFiles.length) return out(false, 'evidence', `no render files changed: ${changed.length} file${changed.length === 1 ? '' : 's'} (${list(changed)}), none under ${cfg.from}`, { renderFiles });
  if (titled) return out(true, 'evidence', `it changes render files: ${list(renderFiles)}`, { renderFiles });
  if (renderFiles.length) {
    const words = `changes render files: ${list(renderFiles)}; a visual result is recommended`;
    return cfg.strict ? out(true, 'evidence', `${words.replace('; a visual result is recommended', '')} (visualStrict)`, { renderFiles }) : out(false, 'evidence', '', { renderFiles, warn: words });
  }
  return out(false, 'evidence', '', { renderFiles });
}

/** The summary: passed / failed / unchecked, and whether the task may finish. */
export function summarize(task, t = {}, v = readVerdict(task)) {
  const passed = PARTS.filter((p) => v.parts[p]?.ok === true);
  const failed = PARTS.filter((p) => v.parts[p] && v.parts[p].ok !== true);
  const unchecked = PARTS.filter((p) => !v.parts[p]);
  const d = renderDecision({ ...t, id: t.id || task });
  const render = d.render;
  const blocks = [];
  if (failed.length) blocks.push(`failed: ${failed.map((p) => `${p}${v.parts[p].why ? ` (${v.parts[p].why.slice(0, 160)})` : ''}`).join(', ')}`);
  if (render && process.env.STUDIO_VISUAL_GATE !== 'off' && v.parts.visual?.ok !== true) blocks.push(v.parts.visual ? 'the visual result failed' : `a render task needs a visual result: ${captureHint(task, t)}`);
  return { task, render, renderWhy: d.why, renderBy: d.by, ...(d.warn ? { warn: d.warn } : {}), ...(d.ignored ? { ignored: d.ignored } : {}), passed, failed, unchecked, ok: blocks.length === 0, why: blocks.join('; ') };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const a = process.argv.slice(2);
  const opt = (k, d = '') => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  const [cmd, task, part, res] = a;
  if (cmd === 'set' && task && part && /^(pass|fail)$/.test(res || '')) {
    setPart(task, part, { ok: res === 'pass', why: opt('--why'), evidence: opt('--evidence').split('|').filter(Boolean) });
    emitEvent({ type: 'verdict.part', agent: process.env.STUDIO_LOCK_OWNER || 'harness', task, msg: `${task} ${part}: ${res}${opt('--why') ? ` (${opt('--why')})` : ''}` });
    console.log(`[verdict] ${task} ${part}: ${res}`);
    process.exit(0);
  }
  if ((cmd === 'show' || cmd === 'gate') && task) {
    let t = { title: opt('--title'), track: opt('--track'), type: opt('--type') };
    try { const q = parseNextQueue(); const b = [...q.inProgress, ...q.backlog, ...q.done].find((x) => x.id === task); if (b) t = { ...b, ...Object.fromEntries(Object.entries(t).filter(([, v]) => v)) }; } catch { /* no board */ }
    const s = summarize(task, t);
    if (a.includes('--json')) console.log(JSON.stringify(s));
    else console.log(`[verdict] ${task}: passed ${s.passed.join(', ') || 'none'}; failed ${s.failed.join(', ') || 'none'}; unchecked ${s.unchecked.join(', ') || 'none'}${s.render ? ' (render task)' : ''}${s.renderWhy ? `\n[verdict] ${s.renderBy === 'owner' ? s.renderWhy : `${s.render ? 'render task' : 'not a render task'}: ${s.renderWhy}`}` : ''}${s.warn ? `\n[verdict] WARN ${s.warn}` : ''}${s.ok ? '' : `\n[verdict] can't finish: ${s.why}`}`);
    process.exit(cmd === 'gate' && !s.ok ? 1 : 0);
  }
  console.log('Usage: node harness/verdict-split.mjs set <TASK> <build|logic|runtime|visual|viewport> pass|fail [--why] | show <TASK> | gate <TASK> [--title]');
  process.exit(2);
}
