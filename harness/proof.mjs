#!/usr/bin/env node
/**
 * harness/proof.mjs — screenshot proof for work players see (tasks with --part renderer or both).
 *
 *   npm run proof -- add T-012 <screenshot> "<what it shows, in one line>" [--by <agent>]
 *   npm run proof -- check T-012 --by <name> --verdict matches|wrong [--note "…"]
 *   npm run proof -- show T-012
 *
 * A renderer task isn't done on "the code changed and verify is green": the builder adds the
 * screenshots that show the change (the browser play gate saves start, middle and end shots in
 * qa/reports/) with one line each saying what the image shows. Then someone other than the builder
 * (a person, or a reviewer agent from the studio) opens the images next to the description and the
 * approved art reference and records whether they match. A description that doesn't match the image
 * is how "green but broken" gets caught.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent, readRecentEvents } from './event.mjs';

export const PROOF_DIR = path.join(REPO_ROOT, 'studio', 'proof');
const now = () => new Date().toISOString();
const file = (id) => path.join(PROOF_DIR, `${id}.json`);

export function readProof(id) {
  try {
    return JSON.parse(fs.readFileSync(file(id), 'utf8'));
  } catch {
    return { task: id, shots: [], checks: [] };
  }
}
export const implementerOf = (id) => (readRecentEvents(20000).filter((e) => e.type === 'task.start' && e.task === id).pop() || {}).agent || null;

function save(p) {
  fs.mkdirSync(PROOF_DIR, { recursive: true });
  fs.writeFileSync(file(p.task), `${JSON.stringify(p, null, 2)}\n`);
  let ref = null;
  try {
    ref = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'studio', 'bible', 'bible.json'), 'utf8')).artReference || null;
  } catch {
    // no Bible
  }
  const L = [`# Proof for ${p.task}`, '', '> Written by `npm run proof`. Open each image and check the line under it says what it shows.', ''];
  if (ref) L.push(`Art reference: \`${ref.file}\` (approved by ${ref.approvedBy}).`, '');
  for (const s of p.shots) L.push(`- \`${s.file}\`: ${s.says} _(by ${s.by})_`);
  if (p.checks.length) L.push('', '## Checked', ...p.checks.map((c) => `- ${c.by}, ${c.at.slice(0, 16).replace('T', ' ')}: **${c.verdict}**${c.note ? `: ${c.note}` : ''}`));
  fs.writeFileSync(path.join(PROOF_DIR, `${p.task}.md`), `${L.join('\n')}\n`);
  return p;
}

export function addShot(id, shot, says, by = process.env.STUDIO_LOCK_OWNER || 'builder') {
  if (!/^T-\d+$/.test(id || '')) return { ok: false, message: 'Name the task: npm run proof -- add T-012 <screenshot> "<what it shows>"' };
  const rel = path.relative(REPO_ROOT, path.resolve(REPO_ROOT, String(shot || ''))).split(path.sep).join('/');
  if (!shot || rel.startsWith('..') || !fs.existsSync(path.join(REPO_ROOT, rel))) return { ok: false, message: `No screenshot at ${shot}. The browser play gate saves them in qa/reports/ (npm run play:browser).` };
  if (!/\.(png|jpe?g|webp)$/i.test(rel)) return { ok: false, message: 'A screenshot is a .png, .jpg or .webp.' };
  const words = (String(says || '').match(/[A-Za-z0-9]{2,}/g) || []).length;
  if (words < 6) return { ok: false, message: 'Say what the image shows in one line of at least six words, specific enough that someone could tell if it didn\'t ("three green units drive right; the HUD reads 5839 credits").' };
  // Keep a copy with the proof, so it travels with the commit (qa/reports/ isn't committed).
  const kept = `studio/proof/${id}/${path.basename(rel)}`;
  if (rel !== kept) {
    fs.mkdirSync(path.join(PROOF_DIR, id), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, rel), path.join(REPO_ROOT, kept));
  }
  const p = readProof(id);
  p.shots = [...p.shots.filter((s) => s.file !== kept), { file: kept, from: rel, says: String(says).replace(/\s+/g, ' ').slice(0, 300), by, at: now() }];
  save(p);
  emitEvent({ type: 'proof.shot', agent: by, task: id, msg: `${rel}: ${says}` });
  return { ok: true, proof: p };
}

export function checkProof(id, { by, verdict, note = '' }) {
  if (!['matches', 'wrong'].includes(verdict)) return { ok: false, message: '--verdict matches (every line says what its image shows) or wrong (say which with --note).' };
  if (verdict === 'wrong' && !String(note).trim()) return { ok: false, message: 'Say what is wrong: --note "…".' };
  const p = readProof(id);
  if (!p.shots.length) return { ok: false, message: `${id} has no screenshots to check yet.` };
  const impl = implementerOf(id);
  if (!by || by === impl || p.shots.every((s) => s.by === by)) return { ok: false, message: `Someone other than the builder${impl ? ` (${impl})` : ''} checks the proof: --by <your name>.` };
  p.checks.push({ by, verdict, note: String(note).slice(0, 500), at: now() });
  save(p);
  emitEvent({ type: verdict === 'matches' ? 'proof.checked' : 'proof.wrong', agent: by, task: id, to: impl || 'producer', msg: verdict === 'matches' ? `${by} checked the screenshots for ${id}: they show what they say` : `${by}: the screenshots for ${id} don't show what they say: ${note}` });
  return { ok: true, proof: p };
}

/** For the done-check: { shots, described, checked, why } */
export function proofStatus(id, since = 0) {
  const p = readProof(id);
  const shots = p.shots.filter((s) => fs.existsSync(path.join(REPO_ROOT, s.file)));
  const last = p.checks[p.checks.length - 1] || null;
  const newestShot = Math.max(0, ...shots.map((s) => Date.parse(s.at) || 0));
  return {
    shots: shots.length,
    fresh: shots.some((s) => (Date.parse(s.at) || 0) >= since),
    checked: Boolean(last && last.verdict === 'matches' && Date.parse(last.at) >= newestShot),
    wrong: last?.verdict === 'wrong' ? last.note : null,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) i++;
    } else pos.push(argv[i]);
  }
  const [cmd, id, a, b] = pos;
  const out = (r, line) => {
    if (!r.ok) {
      console.error(r.message);
      process.exit(1);
    }
    console.log(line(r));
    process.exit(0);
  };
  if (cmd === 'add') out(addShot(id, a, b, flag('by') || undefined), (r) => `${id}: ${r.proof.shots.length} screenshot(s). Someone other than the builder checks them: npm run proof -- check ${id} --by <name> --verdict matches|wrong`);
  if (cmd === 'check') out(checkProof(id, { by: flag('by'), verdict: flag('verdict'), note: flag('note') || '' }), (r) => `${id}: ${r.proof.checks[r.proof.checks.length - 1].verdict}. See studio/proof/${id}.md`);
  if (cmd === 'show' && id) {
    const p = readProof(id);
    console.log(fs.existsSync(path.join(PROOF_DIR, `${id}.md`)) ? fs.readFileSync(path.join(PROOF_DIR, `${id}.md`), 'utf8') : `${id} has no proof yet.`);
    process.exit(p.shots.length ? 0 : 1);
  }
  console.log('npm run proof -- add T-012 <screenshot> "<what it shows>" | check T-012 --by <name> --verdict matches|wrong [--note "…"] | show T-012');
}
