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
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { STUDIO_STATE_DIR, emitEvent } from './event.mjs';

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
  if (/^(off|no)$/i.test(String(t.visual ?? ''))) return false;
  // Only build work renders: an art, design or planning task proposing placeholders is not gated here.
  if (t.role && !/^(builder|engine-porter|dev-hacker)$/.test(t.role)) return false;
  if (t.visual === true || /^(on|yes|true)$/i.test(String(t.visual ?? ''))) return true;
  if (/engine:godot/i.test(String(t.track || ''))) return true;
  if (/^(visual|art|render)$/i.test(String(t.type || ''))) return true;
  return RENDER_RX.test(`${t.title || ''}`);
}

/** The summary: passed / failed / unchecked, and whether the task may finish. */
export function summarize(task, t = {}, v = readVerdict(task)) {
  const passed = PARTS.filter((p) => v.parts[p]?.ok === true);
  const failed = PARTS.filter((p) => v.parts[p] && v.parts[p].ok !== true);
  const unchecked = PARTS.filter((p) => !v.parts[p]);
  const render = isRenderTask(t);
  const blocks = [];
  if (failed.length) blocks.push(`failed: ${failed.map((p) => `${p}${v.parts[p].why ? ` (${v.parts[p].why.slice(0, 160)})` : ''}`).join(', ')}`);
  if (render && process.env.STUDIO_VISUAL_GATE !== 'off' && v.parts.visual?.ok !== true) blocks.push(v.parts.visual ? 'the visual result failed' : `a render task needs a visual result: capture before/after (npm run visual -- capture ${task} before|after --godot <project>) and run npm run visual -- check ${task}`);
  return { task, render, passed, failed, unchecked, ok: blocks.length === 0, why: blocks.join('; ') };
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
    const s = summarize(task, { title: opt('--title'), track: opt('--track'), type: opt('--type') });
    if (a.includes('--json')) console.log(JSON.stringify(s));
    else console.log(`[verdict] ${task}: passed ${s.passed.join(', ') || 'none'}; failed ${s.failed.join(', ') || 'none'}; unchecked ${s.unchecked.join(', ') || 'none'}${s.render ? ' (render task)' : ''}${s.ok ? '' : `\n[verdict] can't finish: ${s.why}`}`);
    process.exit(cmd === 'gate' && !s.ok ? 1 : 0);
  }
  console.log('Usage: node harness/verdict-split.mjs set <TASK> <build|logic|runtime|visual|viewport> pass|fail [--why] | show <TASK> | gate <TASK> [--title]');
  process.exit(2);
}
