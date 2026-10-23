#!/usr/bin/env node
/**
 * harness/fidelity.mjs — the design-fidelity gate (2.30h, item 1): score the build against the reference
 * game's mechanics, one by one, and send missing ones back as work.
 *
 *   npm run fidelity                 score now: a report the Director reads (exit 0; 1 only for a bad checklist)
 *   npm run fidelity -- --strict     exit 1 when a required mechanic is missing (opt-in; it is not a hard gate)
 *   npm run fidelity -- --json
 *   npm run fidelity -- send-back [--by director]   queue a builder task per missing mechanic (once each)
 *   npm run fidelity -- list         the checklist
 *
 * The checklist is the game's own, read from the Game Bible (studio/bible/bible.json, its "fidelity"
 * section, same shape as below); studio/fidelity.json is the fallback:
 *   { "reference": "Youda Marina",
 *     "minScore": 0.8,                          optional: the share of scored mechanics that must pass
 *     "mechanics": [
 *       { "id": "lose-money", "says": "the player can lose money (upkeep and bad contracts drain it)",
 *         "probe": "qa/fidelity/lose-money.mjs", "required": true },
 *       { "id": "varied-paths", "says": "ships take varied paths to their docks" } ] }
 * A probe is `export default async ({ cartridge, loadCartridge, runScenario }) => ({ ok, why })`: it plays
 * the game's pure sim (or reads its content data) and says whether the mechanic is there. The probe for a
 * mechanic defaults to qa/fidelity/<id>.mjs. A mechanic with no probe yet is listed "not scored" (it never
 * fails the gate on its own; the send-back asks for its probe).
 *
 * Mechanics only, never code or art: an entry that asks to copy the reference's code, art, sprites,
 * models, textures, sounds or text is refused.
 *
 * Without studio/fidelity.json the gate passes with a note. Read-only: the gate writes only
 * .studio/fidelity-last.json; sending back is a separate step the Director's flow pass runs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, emitEvent, actor } from './event.mjs';

export const CHECKLIST = () => path.join(REPO_ROOT, 'studio', 'fidelity.json');
export const LAST = () => path.join(STUDIO_STATE_DIR, 'fidelity-last.json');
const COPYING = /\b(copy|copies|copied|reuse|rip|ripped|port|lift|clone|trace|extract)\b[^.]{0,40}\b(code|source|art|sprites?|models?|textures?|meshes|sounds?|music|audio|assets?|text|dialogue|ui art|icons?)\b/i;

/** The Bible's fidelity section, when it has one. */
export function bibleChecklist() {
  try {
    const b = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'studio', 'bible', 'bible.json'), 'utf8'));
    const f = b.fidelity || (Array.isArray(b.mechanics) ? { mechanics: b.mechanics, reference: b.reference } : null);
    return f && Array.isArray(f.mechanics) && f.mechanics.length ? { reference: f.reference || b.reference || b.inspiration, ...f, source: 'bible' } : null;
  } catch {
    return null;
  }
}

export function readChecklist(file = null) {
  let c = file ? null : bibleChecklist();
  if (!c) {
    file = file || CHECKLIST();
    if (!fs.existsSync(file)) return null;
    c = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const problems = [];
  const seen = new Set();
  for (const m of c.mechanics || []) {
    if (!m.id || !/^[a-z0-9][\w-]*$/i.test(m.id)) problems.push(`a mechanic needs an id of letters, digits and dashes (got ${JSON.stringify(m.id)})`);
    if (seen.has(m.id)) problems.push(`${m.id} is listed twice`);
    seen.add(m.id);
    if (!String(m.says || '').trim()) problems.push(`${m.id}: "says" must describe the mechanic`);
    if (COPYING.test(`${m.says || ''} ${m.id}`)) problems.push(`${m.id}: mechanics only, never the reference's code or art ("${m.says}")`);
  }
  return { reference: c.reference || 'the reference game', minScore: Number(c.minScore) || null, mechanics: c.mechanics || [], problems };
}

/** Run every probe. Returns { reference, score, passed, scored, missing, unscored, rows, ok }. */
export async function scoreFidelity({ file = null, timeoutMs = Number(process.env.STUDIO_FIDELITY_TIMEOUT_MS || 60000) } = {}) {
  const c = readChecklist(file);
  if (!c) return { configured: false, ok: true, rows: [] };
  const { activeCartridge, loadCartridge, runScenario } = await import('./cartridge.mjs');
  let cartridge = null;
  try {
    cartridge = await loadCartridge(activeCartridge().name);
  } catch {
    // a probe that needs it will say so
  }
  const rows = [];
  for (const m of c.mechanics) {
    const rel = m.probe || `qa/fidelity/${m.id}.mjs`;
    const probe = path.join(REPO_ROOT, rel);
    const required = m.required !== false;
    if (!fs.existsSync(probe)) {
      rows.push({ id: m.id, says: m.says, required, state: 'not scored', why: `no probe yet (${rel})` });
      continue;
    }
    let state = 'missing';
    let why = '';
    try {
      const mod = await import(`${pathToFileURL(probe).href}?t=${Date.now()}`);
      let timer;
      const r = await Promise.race([Promise.resolve(mod.default({ cartridge, loadCartridge, runScenario })), new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs)))]);
      clearTimeout(timer);
      state = r?.ok ? 'present' : 'missing';
      why = String(r?.why || '');
    } catch (err) {
      why = `probe error: ${err.message}`;
    }
    rows.push({ id: m.id, says: m.says, required, state, why: why.slice(0, 300) });
  }
  const scored = rows.filter((r) => r.state !== 'not scored');
  const passed = scored.filter((r) => r.state === 'present').length;
  const score = scored.length ? passed / scored.length : null;
  const missing = rows.filter((r) => r.state === 'missing');
  const ok = !c.problems.length && !missing.some((r) => r.required) && (c.minScore == null || score == null || score >= c.minScore);
  const out = { configured: true, reference: c.reference, at: new Date().toISOString(), score, passed, scored: scored.length, total: rows.length, missing: missing.map((r) => r.id), unscored: rows.filter((r) => r.state === 'not scored').map((r) => r.id), problems: c.problems, minScore: c.minScore, rows, ok };
  try {
    fs.mkdirSync(path.dirname(LAST()), { recursive: true });
    fs.writeFileSync(LAST(), `${JSON.stringify(out, null, 2)}\n`);
  } catch {}
  return out;
}

export function readLastFidelity() {
  try {
    return JSON.parse(fs.readFileSync(LAST(), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Send back: one builder task per missing mechanic (and one per mechanic still without a probe), unless an
 * open task already names it. Uses the latest score; returns the tasks added.
 */
export async function sendBack({ by = actor(), result = readLastFidelity() } = {}) {
  if (!result?.configured) return { added: [], why: 'no fidelity score yet (npm run fidelity)' };
  const { parseNextQueue, addTask } = await import('./task.mjs');
  const q = parseNextQueue();
  const open = [...q.inProgress, ...q.backlog].map((t) => t.title);
  const added = [];
  for (const r of result.rows.filter((x) => x.state !== 'present')) {
    const tag = `[fidelity:${r.id}]`;
    if (open.some((t) => t.includes(tag))) continue;
    const title = r.state === 'missing' ? `${tag} Make it so ${r.says} (missing vs ${result.reference}: ${r.why || 'probe failed'})` : `${tag} Write the fidelity probe for: ${r.says}`;
    const t = addTask({ title: title.slice(0, 200), role: 'builder', priority: r.required && r.state === 'missing' ? 'P0' : 'P1', agent: by, meta: { serves: `fidelity:${r.id}`, origin: 'fidelity' } });
    if (!t.error) added.push(t.id);
  }
  if (added.length) emitEvent({ type: 'fidelity.sent_back', agent: by, to: 'producer', msg: `Design fidelity vs ${result.reference}: ${result.passed}/${result.scored} mechanics present; sent back ${added.join(', ')}`, meta: { missing: result.missing, unscored: result.unscored } });
  return { added };
}

export function formatScore(r) {
  if (!r.configured) return '[fidelity] no checklist (the Bible\'s fidelity section or studio/fidelity.json): nothing to score';
  const L = [`[fidelity] REPORT (${r.ok ? 'all required present' : 'required missing'}) ${r.passed}/${r.scored} mechanics of ${r.reference} present${r.score != null ? ` (${Math.round(r.score * 100)}%)` : ''}${r.unscored.length ? `, ${r.unscored.length} not scored yet` : ''}`];
  for (const p of r.problems) L.push(`  checklist: ${p}`);
  for (const x of r.rows) L.push(`  ${x.state === 'present' ? 'ok     ' : x.state === 'missing' ? 'MISSING' : 'unscored'} ${x.id}${x.required ? '' : ' (optional)'}: ${x.says}${x.why ? ` — ${x.why}` : ''}`);
  if (!r.ok && r.missing.length) L.push(`  Send back: npm run fidelity -- send-back (the Director's flow pass does this on its own)`);
  return L.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'check';
  if (cmd === 'list') {
    const c = readChecklist();
    console.log(c ? c.mechanics.map((m) => `- ${m.id}${m.required === false ? ' (optional)' : ''}: ${m.says}`).join('\n') || '(empty)' : 'No checklist (Bible fidelity section or studio/fidelity.json)');
    process.exit(0);
  }
  if (cmd === 'send-back') {
    const by = argv.includes('--by') ? argv[argv.indexOf('--by') + 1] : 'director';
    const r = await sendBack({ by, result: await scoreFidelity() });
    console.log(r.added.length ? `[fidelity] sent back ${r.added.join(', ')}` : `[fidelity] nothing to send back${r.why ? `: ${r.why}` : ''}`);
    process.exit(0);
  }
  const r = await scoreFidelity();
  console.log(argv.includes('--json') ? JSON.stringify(r, null, 2) : formatScore(r));
  if (r.configured) emitEvent({ type: r.ok ? 'qa.fidelity.pass' : 'qa.fidelity.fail', agent: process.env.STUDIO_LOCK_OWNER || 'qa', msg: `Design fidelity vs ${r.reference}: ${r.passed}/${r.scored} present${r.missing.length ? `; missing ${r.missing.join(', ')}` : ''}` });
  // 2.30h: a scored report the Director reads, not a hard gate. A bad checklist (e.g. asks to copy art) still fails.
  process.exit(r.problems?.length || (argv.includes('--strict') && !r.ok) ? 1 : 0);
}
