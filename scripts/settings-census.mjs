#!/usr/bin/env node
/**
 * scripts/settings-census.mjs — 2.79 (a), PU-64: a read-only census of every STUDIO_* setting, to decide what to cut.
 * Measurement only: it changes nothing and gates nothing.
 *
 *   node scripts/settings-census.mjs [--json] [--env <studio .env>] [--events <events.jsonl>]
 *
 * Per setting: its default and its files (scripts/settings-map.mjs's scan, reused, not re-parsed), the modules that
 * read it (harness/, scripts/, hub/, qa/*.mjs, not qa/selftest*), how many, whether docs/settings-baseline.json
 * freezes it (undocumented since 2.66.0), the first release whose CHANGELOG.md section or docs/RELEASE-<v>.md mentions
 * it, and with --env / --events whether that studio sets it (a key in the .env, or any mention in the events file).
 * Candidates: (a) off switches for a fix, added two or more releases ago (name or its docs line says off / restores
 * the old behaviour); (b) families by suffix (_WAIT_MIN, _HOLD_MIN, _TIMEOUT_MS ...) with their docs one-liners side
 * by side; (c) dead: no module outside the selftests reads it. A name that only sits in a comment counts as read.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { settingsMap, readBaseline } from './settings-map.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME = /STUDIO_[A-Z0-9_]+/g;
const isTest = (f) => /^qa\/selftest/.test(f);
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const OFF_NAME = /_(OFF|DISABLE|DISABLED|LEGACY|OLD|CLASSIC|SKIP)(_|$)/;
const OFF_DOC = /\b(restores?|reverts?|brings? back|old behaviou?r|previous behaviou?r|behaves? as before|as before|escape hatch|kill switch|back to (?:the )?(?:old|previous|2\.\d+)|=\s*`?off`?|`off`|\boff\b[^.]{0,60}(?:old|before|previous|back))/i;
const FAMILY_WORDS = new Set(['WAIT', 'HOLD', 'TIMEOUT', 'GRACE', 'COOLDOWN', 'INTERVAL', 'LIMIT', 'TTL', 'DELAY', 'STALE', 'RETRIES', 'RETRY', 'AGE', 'IDLE', 'STALL', 'STUCK', 'QUIET', 'SCAN', 'EVERY', 'REPEAT']);
const UNITS = new Set(['MIN', 'MS', 'SEC', 'S', 'H', 'HOURS', 'DAYS', 'LINES', 'KB', 'MB']);

/** CHANGELOG.md sections newest first: [{ version, text }], plus docs/RELEASE-<v>.md texts keyed by version. */
export function releaseTexts(root = ROOT) {
  const sections = [];
  const lines = read(path.join(root, 'CHANGELOG.md')).split(/\r?\n/);
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^## \[([^\]]+)\]/);
    if (m) { cur = { version: m[1], text: '' }; sections.push(cur); } else if (cur) cur.text += `${line}\n`;
  }
  const extra = new Map();
  try {
    for (const n of fs.readdirSync(path.join(root, 'docs'))) {
      const m = n.match(/^RELEASE-(.+)\.md$/);
      if (m) extra.set(m[1], read(path.join(root, 'docs', n)));
    }
  } catch {}
  return { sections, extra };
}

/** The oldest release that mentions `needle`: { version, ago } (ago = releases newer than it) or null. */
export function addedIn(needle, rel) {
  const { sections, extra } = rel;
  let best = null;
  sections.forEach((s, i) => {
    if (s.text.includes(needle) || (extra.get(s.version) || '').includes(needle)) best = { version: s.version, ago: i };
  });
  return best;
}

const clean = (s) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();
/** The docs line a setting is explained on (docs/X.md:line → text around the name), trimmed. */
function docLine(root, ref, name, cache) {
  if (!ref) return '';
  const [file, ln] = ref.split(':');
  if (!cache.has(file)) cache.set(file, read(path.join(root, file)).split(/\r?\n/));
  const line = cache.get(file)[Number(ln) - 1] || '';
  const at = Math.max(0, line.indexOf(name.replace(/_$/, '')));
  // From the name on, up to the next other STUDIO_ name (a docs line often explains several in a row).
  let tail = line.slice(at + name.length, at + name.length + 220);
  const next = tail.search(/STUDIO_[A-Z0-9_]+/);
  if (next >= 0) tail = tail.slice(0, next);
  return clean(`${name}${tail}`);
}

/** What a studio sets: names as keys of a .env, plus every name mentioned in an events file. */
export function studioSets({ env, events }) {
  const sets = new Map();
  if (env) for (const l of read(env).split(/\r?\n/)) { const m = l.match(/^\s*(?:export\s+)?(STUDIO_[A-Z0-9_]+)\s*=/); if (m) sets.set(m[1], 'env'); }
  if (events) for (const m of read(events).matchAll(NAME)) if (!sets.has(m[0])) sets.set(m[0], 'events');
  return sets;
}

function suffixOf(name) {
  const t = name.replace(/_$/, '').split('_');
  if (t.length < 3) return null;
  const last = t[t.length - 1];
  const prev = t[t.length - 2];
  if (UNITS.has(last) && FAMILY_WORDS.has(prev)) return `_${prev}_${last}`;
  if (FAMILY_WORDS.has(last)) return `_${last}`;
  return null;
}

export function census(root = ROOT, { env, events } = {}) {
  const rows = settingsMap(root);
  const baseline = new Set(readBaseline(root) || []);
  const rel = releaseTexts(root);
  const cache = new Map();
  const sets = env || events ? studioSets({ env, events }) : null;
  const items = rows.map((r) => {
    const readers = r.files.filter((f) => !isTest(f));
    const add = addedIn(r.name, rel);
    const doc = docLine(root, r.doc, r.name, cache);
    const reasons = [];
    if (OFF_NAME.test(r.name)) reasons.push('name');
    if (doc && OFF_DOC.test(doc)) reasons.push('docs');
    const setBy = sets ? ([...sets].find(([k]) => k === r.name || (r.name.endsWith('_') && k.startsWith(r.name)))?.[1] || null) : undefined;
    return { name: r.display, default: r.default, readers, modules: readers.length, testFiles: r.files.length - readers.length, frozen: baseline.has(r.name), added: add?.version || null, releasesAgo: add ? add.ago : null, doc: r.doc, docLine: doc, setBy, offReasons: reasons };
  });
  const offSwitches = items.filter((i) => i.offReasons.length && i.releasesAgo !== null && i.releasesAgo >= 2 && i.modules > 0);
  const dead = items.filter((i) => i.modules === 0);
  const fam = new Map();
  for (const i of items) { const s = suffixOf(i.name); if (s) { if (!fam.has(s)) fam.set(s, []); fam.get(s).push(i); } }
  const families = [...fam].filter(([, v]) => v.length >= 3).map(([suffix, v]) => ({ suffix, members: v.map((i) => ({ name: i.name, default: i.default, doc: i.docLine })) })).sort((a, b) => b.members.length - a.members.length);
  return { total: items.length, items, offSwitches, dead, families, studio: sets ? { set: items.filter((i) => i.setBy).length, never: items.filter((i) => !i.setBy).length } : null, newest: rel.sections[0]?.version || null };
}

const pad = (s, n) => String(s).padEnd(n).slice(0, n);
export function renderCensus(c) {
  const out = [`Settings census (newest release in CHANGELOG: ${c.newest}). Readers = modules outside qa/selftest*; a name in a comment counts.`, ''];
  const hdr = `${pad('setting', 44)} ${pad('default', 14)} ${pad('mods', 4)} ${pad('frozen', 6)} ${pad('added', 9)} ${c.studio ? pad('set', 6) : ''}reader`;
  out.push(hdr);
  for (const i of c.items) out.push(`${pad(i.name, 44)} ${pad(i.default ?? '-', 14)} ${pad(i.modules, 4)} ${pad(i.frozen ? 'yes' : '', 6)} ${pad(i.added || '?', 9)} ${c.studio ? pad(i.setBy || 'no', 6) : ''}${i.readers[0] || '(none)'}${i.readers.length > 1 ? ` +${i.readers.length - 1}` : ''}`);
  out.push('', `== (a) off switches for a fix, added 2+ releases ago (${c.offSwitches.length}) ==`);
  for (const i of c.offSwitches) out.push(`${pad(i.name, 44)} added ${pad(i.added, 8)} (${i.releasesAgo} ago) via ${i.offReasons.join('+')}${c.studio ? `, set: ${i.setBy || 'no'}` : ''}${i.docLine ? `\n    ${i.docLine.slice(0, 150)}` : ''}`);
  out.push('', `== (b) families by suffix, 3+ members (${c.families.length}) ==`);
  for (const f of c.families) { out.push(`${f.suffix} (${f.members.length})`); for (const m of f.members) out.push(`  ${pad(m.name, 42)} ${pad(m.default ?? '-', 10)} ${m.doc.slice(0, 110)}`); }
  out.push('', `== (c) dead: read by no module (${c.dead.length}) ==`);
  for (const i of c.dead) out.push(`${pad(i.name, 44)} added ${i.added || '?'}${i.testFiles ? `, only in ${i.testFiles} selftest file(s)` : ''}`);
  out.push('', `SUMMARY: ${c.total} settings, ${c.dead.length} dead, ${c.offSwitches.length} off-switch candidates, ${c.families.length} duplicate families${c.studio ? `, ${c.studio.set} set by the given studio, ${c.studio.never} never` : ''}, ${c.items.filter((i) => i.frozen).length} frozen undocumented`);
  return out.join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const a = process.argv.slice(2);
  const val = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : undefined; };
  const c = census(ROOT, { env: val('--env'), events: val('--events') });
  console.log(a.includes('--json') ? JSON.stringify(c) : renderCensus(c));
}
