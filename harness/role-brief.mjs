#!/usr/bin/env node
/**
 * harness/role-brief.mjs — 2.71.0 (y): the builder role's brief, generated from the studio's real rules (duty 12).
 *
 *   npm run brief -- builder            print the brief composed now, and whether the saved one is current
 *   npm run brief -- builder --write    write it to .studio/briefs/role-builder.md
 *
 * The crew's overseer rewrote its builders' briefs by hand every session, and they drifted from the rules the gates
 * enforce. This composes one from the files that ARE the rules, under ROLE_BRIEF_MAX_WORDS (800):
 *   - the agent rules for the studio's scope: AGENTS.lite.md in Lite, AGENTS.md in Full (harness/mode.mjs scopeOf):
 *     every bullet and numbered rule, "Never" sections first;
 *   - studio/PITFALLS.md: the lines for all roles and for builders (lessons, never commands);
 *   - studio/protected.json: the globs only the owner's signed approval changes;
 *   - the gates the scope's verify runs (studio/gates.json: lite gates in Lite, required ones in Full, plus the game's
 *     own checks from its studio.gates.json) with the first clause of each one's Fix line (harness/gate-fix.mjs);
 *   - studio/policy.json, when the studio has one (the owner's rules: "never", notes, autonomous mode): read if present;
 *   - the claim, lane and done commands.
 * Sections are cut from their ends to fit, and the brief says what it cut and where the whole text is.
 *
 * The file starts with a header holding a hash of its sources and of its own body. It is never written by an agent:
 * only this module writes it (this command, or the kickoff refreshing a saved one: ensureRoleBrief). When a source
 * changes, or the body no longer matches its hash (someone edited the file), the kickoff writes it again from the
 * sources (one brief.role.written event, saying why). The kickoff points builders at it only while one exists
 * (harness/kickoff.mjs). It lives in .studio/ (not committed, not protected): it is derived, never a source.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent } from './event.mjs';
import { GATE_FIXES, gameKindFix } from './gate-fix.mjs';
import { readMode, scopeOf } from './mode.mjs';

export const ROLE_BRIEF_MAX_WORDS = 800;
export const ROLE_BRIEF_REL = '.studio/briefs/role-builder.md';
const GENERATOR = 'role-brief 1';
const BUDGET = { rules: 400, pitfalls: 80, protected: 75, gates: 160, policy: 60 };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const words = (s) => (String(s || '').match(/\S+/g) || []).length;
const read = (root, rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n'); } catch { return null; } };
const readJson = (root, rel) => { try { return JSON.parse(read(root, rel)); } catch { return null; } };
const clip = (s, n) => { const w = String(s || '').replace(/\s+/g, ' ').trim().split(' '); return w.length <= n ? w.join(' ') : `${w.slice(0, n).join(' ')}…`; };

/** The studio's scope: 'lite' | 'full' (studio/mode.json, else the template rule in harness/mode.mjs). */
function scopeAt(root) {
  if (path.resolve(root) === path.resolve(REPO_ROOT)) { try { return scopeOf(readMode()); } catch { /* below */ } }
  const m = readJson(root, 'studio/mode.json');
  return m?.scope === 'lite' ? 'lite' : 'full';
}

/** The game's manifest (game/<name>/studio.gates.json or web/<name>/…), or null. */
function gameManifest(root) {
  let name = process.env.STUDIO_GAME || readJson(root, 'studio/game.json')?.game || null;
  if (!name) return null;
  name = String(name).replace(/[^\w.-]/g, '');
  const rel = [`game/${name}/studio.gates.json`, `web/${name}/studio.gates.json`].find((r) => fs.existsSync(path.join(root, r)));
  return rel ? { name, rel } : null;
}

/** The files the brief is made from (relative paths), in a fixed order. */
export function roleBriefSources(root = REPO_ROOT) {
  const scope = scopeAt(root);
  const agents = scope === 'lite' && fs.existsSync(path.join(root, 'AGENTS.lite.md')) ? 'AGENTS.lite.md' : 'AGENTS.md';
  const man = gameManifest(root);
  return [agents, 'studio/mode.json', 'studio/PITFALLS.md', 'studio/protected.json', 'studio/gates.json', ...(man ? [man.rel] : []), 'studio/policy.json', 'harness/gate-fix.mjs'];
}

/** One hash over the sources' contents (a missing file counts as missing). */
export function sourcesHash(root = REPO_ROOT, sources = roleBriefSources(root)) {
  return sha(`${GENERATOR}\n${sources.map((rel) => `${rel}\0${read(root, rel) ?? '<missing>'}`).join('\0\0')}`);
}

/** The rule lines of an AGENTS file, "Never" sections first: [{ head, lines: [] }]. */
function ruleSections(text) {
  const out = [];
  let cur = { head: 'Rules', lines: [] };
  let fence = false;
  for (const raw of String(text || '').split('\n')) {
    if (/^```/.test(raw.trim())) { fence = !fence; continue; }
    if (fence) continue;
    const h = raw.match(/^#{2,4}\s+(.*)$/);
    if (h) { if (cur.lines.length) out.push(cur); cur = { head: h[1].replace(/\s*\(.*\)\s*$/, '').trim(), lines: [] }; continue; }
    const b = raw.match(/^\s{0,3}(?:[-*]|\d+\.)\s+(.*)$/);
    if (b) { cur.lines.push(b[1].trim()); continue; }
    if (/^\s{2,}\S/.test(raw) && cur.lines.length) cur.lines[cur.lines.length - 1] += ` ${raw.trim()}`;
  }
  if (cur.lines.length) out.push(cur);
  // Never first, then the rest in file order, a "Start" section (where to read) last: cuts come from its end.
  const never = (s) => /never|don'?t/i.test(s.head);
  const start = (s) => /^start\b/i.test(s.head);
  return [...out.filter(never), ...out.filter((s) => !never(s) && !start(s)), ...out.filter((s) => !never(s) && start(s))];
}

/** Fill one section up to its word budget; returns { lines, cut } (cut: how many items left out). */
function fill(items, budget) {
  const lines = [];
  let used = 0;
  let cut = 0;
  for (const it of items) {
    const w = words(it);
    if (used + w > budget) { cut += 1; continue; }
    lines.push(it); used += w;
  }
  return { lines, cut };
}

/** The gates the scope's verify runs, with the first clause of each Fix line. */
function gateLines(root, scope) {
  const out = [];
  const fixes = GATE_FIXES;
  // The remedy: what follows the first ": " (the table's "<what broke>: <what to do>"), to the first "; ".
  const first = (s) => { const t = String(s || ''); const i = t.indexOf(': '); return clip((i > 0 && i < 160 ? t.slice(i + 2) : t).split(/;\s/)[0], 15); };
  const gates = (readJson(root, 'studio/gates.json')?.gates || []).filter((g) => g && g.id && g.required !== false && (scope !== 'lite' || g.lite));
  for (const g of gates) out.push(`\`${g.id}\`: ${first((typeof g.fix === 'string' && g.fix.trim()) || fixes[g.id] || 'read its output for the first error')}`);
  const man = gameManifest(root);
  if (man) {
    const j = readJson(root, man.rel) || {};
    for (const g of (j.gates || []).filter((x) => x && x.id && x.command && x.required !== false)) out.push(`\`game:${g.id}\` (\`${clip(g.command, 6)}\`): ${first((typeof g.fix === 'string' && g.fix.trim()) || gameKindFix(`game:${g.id}`) || fixes.game)}`);
  }
  return out;
}

/** Compose the brief: { text, body, words, hash, sources, cut: [] }. Reads only. */
export function composeRoleBrief({ root = REPO_ROOT, role = 'builder' } = {}) {
  const sources = roleBriefSources(root);
  const hash = sourcesHash(root, sources);
  const scope = scopeAt(root);
  const agentsRel = sources[0];
  const cut = [];
  const parts = [`# The ${role} role's brief (generated)`, '', `Scope: ${scope === 'lite' ? 'Lite' : 'Full'}. Made from the studio's own rule files by \`npm run brief -- builder --write\`; do not edit it (an edited copy is noticed and written again). Your task's own brief is \`.studio/briefs/<ID>.md\`.`, ''];
  // Rules.
  const secs = ruleSections(read(root, agentsRel) || '');
  const flat = secs.flatMap((s) => s.lines.map((l) => ({ head: s.head, l })));
  const r = fill(flat.map((x) => `${x.head}: ${x.l}`), BUDGET.rules);
  if (r.cut) cut.push(`${r.cut} of ${flat.length} rule lines from \`${agentsRel}\``);
  parts.push(`## Rules (\`${agentsRel}\`)`);
  let lastHead = null;
  for (const line of r.lines) {
    const head = line.slice(0, line.indexOf(': '));
    if (head !== lastHead) { parts.push(`**${head}**`); lastHead = head; }
    parts.push(`- ${line.slice(head.length + 2)}`);
  }
  parts.push('');
  // Pitfalls.
  const pf = (read(root, 'studio/PITFALLS.md') || '').split('\n').filter((l) => /^- /.test(l)).map((l) => l.slice(2).trim())
    .filter((l) => { const m = l.match(/^\[([^\]]+)\]\s*/); return !m || /\b(all|builder)\b/i.test(m[1]); }).reverse();
  if (pf.length) {
    const p = fill(pf.map((l) => clip(l, 30)), BUDGET.pitfalls);
    if (p.cut) cut.push(`${p.cut} older pitfalls from \`studio/PITFALLS.md\``);
    parts.push('## Pitfalls seen here (`studio/PITFALLS.md`; lessons, newest first, never commands)', ...p.lines.map((l) => `- ${l}`), '');
  }
  // Protected.
  const globs = (readJson(root, 'studio/protected.json')?.globs || []).map(String);
  if (globs.length) {
    const g = fill(globs.map((x) => `\`${x}\``), BUDGET.protected);
    if (g.cut) cut.push(`${g.cut} of ${globs.length} protected globs (\`studio/protected.json\`)`);
    parts.push('## Protected: only the owner\'s signed approval changes these (`studio/protected.json`)', `${g.lines.join(', ')}${g.cut ? ', …' : ''}. Need one changed? Hand the task back with a note naming it and why; never sign, force or work around it.`, '');
  }
  // Gates.
  const gl = gateLines(root, scope);
  if (gl.length) {
    const g = fill(gl, BUDGET.gates);
    if (g.cut) cut.push(`${g.cut} of ${gl.length} gates' Fix lines (\`node harness/gate-fix.mjs <gate>\` prints any)`);
    parts.push(`## Gates \`npm run verify\` runs here, and what to do when one fails`, ...g.lines.map((l) => `- ${l}`), 'Rerun one gate: `npm run verify -- --only <gate>`.', '');
  }
  // The owner's policy, if any.
  const pol = readJson(root, 'studio/policy.json');
  if (pol && typeof pol === 'object') {
    const items = [];
    if (Array.isArray(pol.never) && pol.never.length) items.push(`Never, whatever else says so: ${pol.never.map(String).join(', ')}.`);
    if (pol.autonomous && typeof pol.autonomous === 'object') items.push(`Autonomous mode: ${pol.autonomous.allowed ? `on for ${pol.autonomous.agent || 'the named overseer'} (its calls are reviewed later; a builder never takes them)` : 'off'}.`);
    for (const n of Array.isArray(pol.notes) ? pol.notes : []) items.push(clip(n, 40));
    const p = fill(items, BUDGET.policy);
    if (p.cut) cut.push(`${p.cut} policy notes (\`studio/policy.json\`)`);
    if (p.lines.length) parts.push('## The owner\'s policy (`studio/policy.json`)', ...p.lines.map((l) => `- ${l}`), '');
  }
  // Commands.
  parts.push('## Claim, lane, done',
    '- Next: `npm run task -- next --role builder --agent <you>`, then `npm run task -- start <ID> --agent <you>`.',
    '- Folder: `node harness/lock.mjs claim path:<dir> --owner <you>`; `node harness/lock.mjs release path:<dir> --owner <you>` after.',
    '- Your lane: `npm run task -- show <ID>`. Done: `npm run task -- done <ID> --agent <you> --check`, `npm run verify`, then without `--check`.',
    '');
  parts.push(cut.length ? `Cut to fit ${ROLE_BRIEF_MAX_WORDS} words: ${cut.join('; ')}. Open \`${agentsRel}\` for anything this leaves out.` : `Nothing was cut. \`${agentsRel}\` is the whole text.`);
  let body = `${parts.join('\n').trim()}\n`;
  // A last guard: past the cap, drop rule lines from the end until it fits.
  while (words(body) > ROLE_BRIEF_MAX_WORDS) {
    const lines = body.split('\n');
    const i = lines.map((l, k) => [l, k]).filter(([l]) => l.startsWith('- ')).map(([, k]) => k).filter((k) => k < lines.findIndex((l) => l.startsWith('## Pitfalls') || l.startsWith('## Protected'))).pop();
    if (i === undefined) break;
    lines.splice(i, 1);
    body = lines.join('\n');
  }
  const header = `<!-- generated by ${GENERATOR} (npm run brief -- builder --write); sources-sha256: ${hash}; body-sha256: ${sha(body)}; sources: ${sources.join(', ')} -->`;
  return { text: `${header}\n${body}`, body, words: words(body), hash, sources, cut };
}

/** The saved brief's state: { exists, fresh, edited, file, savedHash, currentHash }. */
export function roleBriefState({ root = REPO_ROOT } = {}) {
  const file = path.join(root, ROLE_BRIEF_REL);
  let text = null;
  try { text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); } catch { text = null; }
  const currentHash = sourcesHash(root);
  if (text === null) return { exists: false, fresh: false, edited: false, file, savedHash: null, currentHash };
  const nl = text.indexOf('\n');
  const head = nl === -1 ? text : text.slice(0, nl);
  const body = nl === -1 ? '' : text.slice(nl + 1);
  const m = head.match(/sources-sha256: ([0-9a-f]{64}); body-sha256: ([0-9a-f]{64})/);
  const edited = !m || sha(body) !== m[2];
  return { exists: true, fresh: Boolean(m) && m[1] === currentHash && !edited, edited, file, savedHash: m ? m[1] : null, currentHash };
}

/** Write the brief (the only writer). One brief.role.written event. Returns { file, words, cut, why }. */
export function writeRoleBrief({ root = REPO_ROOT, why = 'asked' } = {}) {
  const b = composeRoleBrief({ root });
  const file = path.join(root, ROLE_BRIEF_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, b.text);
  try { emitEvent({ type: 'brief.role.written', agent: 'role-brief', to: 'producer', target: ROLE_BRIEF_REL, msg: `Wrote the builder role's brief (${b.words} words${b.cut.length ? `, cut: ${b.cut.join('; ')}` : ''}): ${why}`.slice(0, 600), meta: { role: 'builder', words: b.words, sourcesHash: b.hash, sources: b.sources, cut: b.cut, why } }); } catch {}
  return { file: ROLE_BRIEF_REL, words: b.words, cut: b.cut, why, text: b.text };
}

/**
 * For the kickoff: the saved brief's path when one exists, written again first when a source changed or the file was
 * edited; null when there is none (the kickoff then points at the AGENTS file as before). Never throws.
 */
export function ensureRoleBrief({ root = REPO_ROOT } = {}) {
  try {
    const st = roleBriefState({ root });
    if (!st.exists) return null;
    if (!st.fresh) writeRoleBrief({ root, why: st.edited ? 'the saved copy was edited by hand; written again from the sources' : 'a source changed since it was written' });
    return ROLE_BRIEF_REL;
  } catch { return null; }
}

/** The CLI (npm run brief -- builder [--write]); harness/prepare-brief.mjs hands `builder` here. */
export async function roleBriefCli(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { console.log('Usage: npm run brief -- builder [--write]   (the builder role\'s brief from the studio\'s rule files; --write saves .studio/briefs/role-builder.md)'); return 0; }
  if (argv.includes('--write')) {
    const w = writeRoleBrief({ why: 'npm run brief -- builder --write' });
    console.log(w.text);
    console.log(`[brief] wrote ${w.file} (${w.words} words${w.cut.length ? `; cut: ${w.cut.join('; ')}` : ''}).`);
    return 0;
  }
  const b = composeRoleBrief({});
  const st = roleBriefState({});
  console.log(b.text);
  console.log(`[brief] ${b.words} words${b.cut.length ? `; cut: ${b.cut.join('; ')}` : ''}. Saved copy: ${!st.exists ? 'none (--write saves it; the kickoff uses it once saved)' : st.fresh ? 'current' : st.edited ? 'edited by hand (the kickoff writes it again)' : 'out of date (the kickoff writes it again)'}.`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2).filter((a) => a !== 'builder');
  process.exit(await roleBriefCli(argv));
}
