/**
 * harness/visual-capture.mjs — 2.59.0: where a studio's game captures its pictures for a render task's visual proof
 * (harness/visual-proof.mjs), and what `task done` tells a render task to run (harness/verdict-split.mjs). A game that
 * isn't a Godot project names its own capture command in its check manifest: <root>/studio.gates.json
 * "visual": { "capture": "..." } (a protected file). Kept apart so the two modules don't import each other.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './event.mjs';
import { activeGame } from './cartridge.mjs';

/** 2.59.0: the studio game's root and its manifest's visual capture command (null when none). */
export function gameCapture() {
  let g = null;
  try { g = activeGame(); } catch { g = null; }
  const name = g?.name;
  if (!name) return { root: null, capture: null, manifest: null };
  const root = [`game/${name}`, `web/${name}`].find((r) => fs.existsSync(path.join(REPO_ROOT, r))) || null;
  if (!root) return { root: null, capture: null, manifest: null };
  const manifest = `${root}/studio.gates.json`;
  let capture = null;
  try { capture = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, manifest), 'utf8'))?.visual?.capture || null; } catch { capture = null; }
  return { root, capture: typeof capture === 'string' && capture.trim() ? capture.trim() : null, manifest, godot: fs.existsSync(path.join(REPO_ROOT, root, 'project.godot')) };
}

/** 2.59.0: what a render task without a visual result is told to run, for this studio's game (not always Godot). */
export function captureHint(task, t = {}) {
  const g = gameCapture();
  // A task on the Godot engine track captures its Godot project whatever the main game does.
  const godotTrack = /engine:godot/i.test(String(t.track || ''));
  if (godotTrack || (!g.capture && (g.godot || !g.root))) return `capture before/after (npm run visual -- capture ${task} before|after --godot <project>) and run npm run visual -- check ${task}`;
  if (g.capture) return `capture before/after (npm run visual -- capture ${task} before|after, the game's own capture command) and run npm run visual -- check ${task}`;
  return `this game has no capture command: the owner adds "visual": { "capture": "<a command that writes <camera>.png into {out}>" } to ${g.manifest} (a protected file), or the owner turns it off for this task (npm run task -- visual ${task} off --by <name> --why "…"); then npm run visual -- capture ${task} before|after and npm run visual -- check ${task}`;
}


/**
 * 2.79.1 (d): is the render-task visual gate on? STUDIO_VISUAL_GATE=off turns it off and =on keeps it on whatever the game has.
 * Unset (the default): on, unless the studio's game is a web or engine game with its own folder that has no capture command
 * (no "visual": { "capture" } in its studio.gates.json and no Godot project): there a render task could never get its
 * result, so the gate is off, with `note` saying so (task done prints it once). { on, auto, note }. A task on the Godot
 * engine track captures its Godot project, so it keeps the gate.
 */
export function visualGate(t = {}, env = process.env) {
  const v = String(env.STUDIO_VISUAL_GATE || '').trim().toLowerCase();
  if (v === 'off') return { on: false, auto: false, note: '' };
  if (v === 'on') return { on: true, auto: false, note: '' };
  const g = gameCapture();
  if (/engine:godot/i.test(String(t.track || '')) || g.capture || g.godot || !g.root) return { on: true, auto: true, note: '' };
  return { on: false, auto: true, note: `visual gate off: ${g.root} has no capture command (add "visual": { "capture": "..." } to ${g.manifest}, or set STUDIO_VISUAL_GATE=on to require one)` };
}
