#!/usr/bin/env node
/**
 * qa/controls-check.mjs — 2.32.0: every control in the Game Bible works, by real input, on every track
 * the game ships.
 *
 * The Bible owns the list: studio/bible/controls.json { tracks: ["web", "godot", ...], controls: [{ id,
 * name, input, expect, tracks? }] }. Each track's own input test presses the controls the way a player
 * does and reports one result per id:
 *   web    qa/browser-play.mjs (the cartridge's browser.controls, each with the Bible's id) → qa/reports/browser_*.json
 *   godot  tools/gate.gd + tools/controls.gd in the Godot project (harness/game-gates.mjs passes
 *          STUDIO_CONTROLS_OUT) → qa/reports/controls-godot-*.json
 *   other  any test that writes qa/reports/controls-<track>*.json as { controls: [{ id, ok }] }
 * This check fails when the list is missing for a real game, when a shipped track has no results, when
 * a listed control has no result on a track (never pressed), or when its result isn't a pass. A result
 * without a check (ok: null) is not a pass. Controls a test pressed that the Bible doesn't list are
 * reported so the Bible can catch up.
 *
 * Why: in the Marina run the Godot build passed every gate while its build buttons, dock placement and
 * world clicks did nothing, because no gate pressed them and no task listed them.
 *
 *   node qa/controls-check.mjs [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../harness/event.mjs';

const REPORTS = path.join(REPO_ROOT, 'qa', 'reports');
const BIBLE = path.join(REPO_ROOT, 'studio', 'bible', 'controls.json');

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/** The newest result file for a track: { file, results: Map(id -> { ok, why }) } or null. */
export function trackResults(track, dir = REPORTS) {
  if (!fs.existsSync(dir)) return null;
  const re = track === 'web' ? /^browser_\d+\.json$/ : new RegExp(`^controls-${track.replace(/[^\w-]/g, '')}(-[\\w.-]+)?\\.json$`);
  const files = fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => path.join(dir, f))
    .map((f) => ({ f, j: readJson(f), m: fs.statSync(f).mtimeMs }))
    .filter((x) => Array.isArray(x.j?.controls))
    .sort((a, b) => b.m - a.m);
  if (!files.length) return null;
  const results = new Map();
  for (const c of files[0].j.controls) results.set(String(c.id || c.name), { ok: c.ok, why: c.why || null });
  return { file: path.relative(REPO_ROOT, files[0].f).split(path.sep).join('/'), results };
}

export async function controlsCheck({ bibleFile = BIBLE, reportsDir = REPORTS, template = null } = {}) {
  const problems = [];
  const notes = [];
  if (template === null) {
    const { activeCartridge, isTemplateCartridge } = await import('../harness/cartridge.mjs');
    const { studioGame } = await import('../harness/game-gates.mjs');
    template = isTemplateCartridge(activeCartridge().name) && !(await studioGame());
  }
  const bible = readJson(bibleFile);
  const list = Array.isArray(bible?.controls) ? bible.controls.filter((c) => c && c.id) : [];
  if (!list.length) {
    if (template) return { ok: true, problems, notes: ['no controls list (template studio)'], checked: 0 };
    problems.push(`the Game Bible lists no controls (${path.relative(REPO_ROOT, bibleFile)}): write every button, key and click a player has, with what it must do, so the build can be checked by real input`);
    return { ok: false, problems, notes, checked: 0 };
  }
  const tracks = Array.isArray(bible.tracks) && bible.tracks.length ? bible.tracks.map(String) : ['web'];
  let checked = 0;
  for (const track of tracks) {
    const r = trackResults(track, reportsDir);
    const want = list.filter((c) => !Array.isArray(c.tracks) || c.tracks.includes(track));
    if (!r) {
      if (template && track === 'web') { notes.push('web: no browser play report yet (the template passes without Chromium)'); continue; }
      problems.push(`${track}: no real-input results yet (${track === 'web' ? 'npm run play:browser' : track === 'godot' ? 'the Godot gate with tools/controls.gd: node harness/game-gates.mjs --paths <the Godot project>' : `a test that writes qa/reports/controls-${track}.json`})`);
      continue;
    }
    for (const c of want) {
      const got = r.results.get(c.id);
      checked += 1;
      if (!got) problems.push(`${track}: "${c.id}" (${c.name || c.input || 'listed in the Bible'}) was never pressed by the ${track} input test (${r.file})`);
      else if (got.ok !== true) problems.push(`${track}: "${c.id}" ${got.ok === false ? `did nothing${got.why ? ` (${got.why})` : ''}` : 'has no check of what it should do (not a pass)'}; expected: ${c.expect || 'see the Bible'}`);
    }
    const listed = new Set(list.map((c) => c.id));
    const extra = [...r.results.keys()].filter((id) => !listed.has(id));
    if (extra.length) notes.push(`${track}: pressed but not in the Bible yet: ${extra.join(', ')}`);
  }
  return { ok: problems.length === 0, problems, notes, checked };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const res = await controlsCheck();
  if (process.argv.includes('--json')) console.log(JSON.stringify(res));
  for (const n of res.notes) console.log(`[controls] note: ${n}`);
  for (const p of res.problems) console.error(`[controls] FAIL ${p}`);
  console.log(res.ok ? `[controls] PASS ${res.checked} control result(s) match the Game Bible` : `[controls] ${res.problems.length} problem(s)`);
  process.exit(res.ok ? 0 : 1);
}
