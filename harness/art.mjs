#!/usr/bin/env node
/**
 * harness/art.mjs — the art department's designs, and the game dev's yes or "change this".
 *
 *   npm run art                                              designs and where each one stands
 *   npm run art -- propose <file> --title "…" [--kind style|asset|concept] [--task T-012]
 *                         [--licence "own work | CC0 | …"] [--source "<url or tool>"] [--replaces D-001] --by <agent>
 *   npm run art -- approve D-001 --by <person> [--note "…"]
 *   npm run art -- changes D-001 "<what to change>" --by <person>
 *
 * The art department starts in pre-production: it reads the Game Bible, proposes a style sheet
 * (kind style: palette, shapes, lighting, references it takes from) and a handful of placeholder
 * assets, and the game dev approves them in the War Room's Game plan view or here.
 *
 * - Approving the style sheet makes it the game's art reference, written into the Game Bible.
 * - Approving an asset under assets/ records it in the asset ledger (studio/assets/manifest.json)
 *   with who approved it and the licence and source the proposer gave, so the assets gate passes.
 * - "Changes" gives the art department a task with the dev's words.
 * Only a person approves or asks for changes. Files from references/ are never proposed for the game.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent } from './event.mjs';
import { isAgent } from './ask.mjs';

export const DESIGNS = path.join(REPO_ROOT, 'studio', 'art', 'designs.json');
export const KINDS = ['style', 'asset', 'concept'];
export const IMAGE = /\.(png|jpe?g|webp|gif|svg)$/i;
const now = () => new Date().toISOString();

export function readDesigns() {
  try {
    return JSON.parse(fs.readFileSync(DESIGNS, 'utf8')).designs || [];
  } catch {
    return [];
  }
}
function writeDesigns(list) {
  fs.mkdirSync(path.dirname(DESIGNS), { recursive: true });
  fs.writeFileSync(DESIGNS, `${JSON.stringify({ designs: list }, null, 2)}\n`);
}
export const waitingDesigns = () => readDesigns().filter((d) => d.status === 'proposed');

export function propose({ file, title, kind = 'asset', task = null, licence = '', source = '', replaces = null, by = process.env.STUDIO_LOCK_OWNER || 'art' }) {
  if (!KINDS.includes(kind)) return { ok: false, message: `--kind is one of ${KINDS.join(', ')}` };
  if (!String(title || '').trim()) return { ok: false, message: 'A design needs --title, in words the game dev would use.' };
  const abs = path.resolve(REPO_ROOT, String(file || ''));
  const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
  if (!file || rel.startsWith('..') || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return { ok: false, message: `No file at ${file} inside the project. Save the design first (studio/art/ for sheets and concepts, assets/ for game files).` };
  if (/^references\//.test(rel)) return { ok: false, message: `${rel} is in the reference library: references are to design from, never to ship. Make our own version.` };
  const list = readDesigns();
  if (replaces) {
    const old = list.find((d) => d.id === replaces);
    if (!old) return { ok: false, message: `No design ${replaces}` };
    old.status = 'replaced';
  }
  const n = list.reduce((m, d) => Math.max(m, Number(d.id.slice(2))), 0) + 1;
  const d = { id: `D-${String(n).padStart(3, '0')}`, kind, title: String(title).trim().slice(0, 160), file: rel, image: IMAGE.test(rel), task, licence: String(licence || (kind === 'asset' ? 'own work (made in this studio)' : '')).slice(0, 120), source: String(source).slice(0, 300), by, at: now(), status: 'proposed', replaces, history: [{ status: 'proposed', by, at: now() }] };
  list.push(d);
  writeDesigns(list);
  emitEvent({ type: 'art.proposed', agent: by, to: 'human', task, msg: `${d.id} ${kind === 'style' ? 'style sheet' : kind} for the game dev to approve: ${d.title} (${rel})` });
  return { ok: true, design: d };
}

async function decide(id, status, by, note = '') {
  note = note == null ? '' : String(note);
  const list = readDesigns();
  const d = list.find((x) => x.id === id);
  if (!d) return { ok: false, message: `No design ${id}` };
  if (d.status !== 'proposed') return { ok: false, message: `${id} is ${d.status}; only a proposed design can be decided.` };
  if (!by || isAgent(by)) return { ok: false, message: 'The game dev decides on designs: --by <your name>. Agents propose them.' };
  if (status === 'changes' && !String(note).trim()) return { ok: false, message: 'Say what to change, in your words.' };
  Object.assign(d, { status, decidedBy: by, decidedAt: now(), note: String(note).slice(0, 1000) });
  d.history.push({ status, by, at: now(), note: d.note });
  const out = { ok: true, design: d, next: '' };
  if (status === 'approved' && d.kind === 'style') {
    const { readBible, writeBible } = await import('./bible.mjs');
    const b = readBible();
    if (b) {
      const { sha256 } = await import('./assets.mjs');
      b.artReference = { design: d.id, file: d.file, sha256: sha256(path.join(REPO_ROOT, d.file)), approvedBy: by, at: now() };
      writeBible(b);
      out.next = `${d.file} is now the game's art reference, written into the Game Bible. Art and renderer work is checked against it.`;
    } else out.next = 'Approved. There is no Game Bible yet; it becomes the art reference once intake writes one (approve it again then).';
  }
  if (status === 'approved' && d.kind === 'asset' && d.file.startsWith('assets/')) {
    const { recordApproved } = await import('./assets.mjs');
    const r = recordApproved({ file: d.file, by, licence: d.licence, source: d.source, design: d.id, maker: d.by });
    out.asset = r.ok ? r.asset.id : null;
    out.next = r.ok ? `${d.file} is recorded in the asset ledger as ${r.asset.id} (approved by ${by}, ${d.licence}).` : r.message;
  }
  if (status === 'approved' && !out.next) out.next = `${id} approved. The art department builds on it.`;
  writeDesigns(list);
  if (status === 'changes') {
    const { addTask } = await import('./task.mjs');
    const t = addTask({ title: `Art: change ${d.id} ${d.title}: ${String(note).replace(/\s+/g, ' ')}`.slice(0, 180), role: 'art', priority: 'P1', agent: by, meta: { design: d.id } });
    out.task = t.id;
    out.next = `The art department has ${t.id} with your words; the new version comes back here to approve.`;
  }
  emitEvent({ type: status === 'approved' ? 'art.approved' : 'art.changes', agent: by, to: 'art', task: out.task || d.task, msg: status === 'approved' ? `${by} approved ${d.id}: ${d.title}` : `${by} asked for changes to ${d.id}: ${note}` });
  return out;
}
export const approve = (id, by, note = '') => decide(id, 'approved', by, note);
export const changes = (id, note, by) => decide(id, 'changes', by, note);

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
  const done = (r, line) => {
    if (!r.ok) {
      console.error(r.message);
      process.exit(1);
    }
    console.log(line(r));
    process.exit(0);
  };
  const [cmd = 'list', a1, a2] = pos;
  if (cmd === 'propose') done(propose({ file: a1, title: flag('title'), kind: flag('kind') || 'asset', task: flag('task'), licence: flag('licence') || flag('license') || '', source: flag('source') || '', replaces: flag('replaces'), by: flag('by') || undefined }), (r) => `${r.design.id} proposed; it waits for the game dev (War Room > Game plan, or npm run art -- approve ${r.design.id} --by <name>).`);
  if (cmd === 'approve') done(await approve(a1, flag('by'), flag('note') || ''), (r) => r.next);
  if (cmd === 'changes') done(await changes(a1, a2 || flag('note'), flag('by')), (r) => r.next);
  if (cmd === '--help' || cmd === 'help') {
    console.log('npm run art [-- propose <file> --title "…" --kind style|asset|concept --by <agent> | approve D-001 --by <person> | changes D-001 "<what>" --by <person>]');
    process.exit(0);
  }
  const list = readDesigns();
  console.log(list.length ? list.map((d) => `${d.id} [${d.status}] ${d.kind}: ${d.title} (${d.file})${d.note ? ` - ${d.note}` : ''}`).join('\n') : 'No designs yet. The art department proposes them: npm run art -- propose <file> --title "…" --kind style|asset');
}
