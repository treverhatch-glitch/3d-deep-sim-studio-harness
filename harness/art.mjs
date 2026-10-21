#!/usr/bin/env node
/**
 * harness/art.mjs — the Asset studio: the art department makes assets in rounds, the game dev
 * approves them or says what to change, and the Producer steps in when the dev is away.
 *
 *   npm run art                                     every asset: number, round, status
 *   npm run art -- propose <file> --title "…" [--kind asset|style|concept] [--task T-012] [--pack props]
 *                  [--licence "own work | CC0 | CC-BY 4.0"] [--source "<url or tool>"] [--author "…"]
 *                  [--generated "<tool>:<model>" --prompt <file> --terms "…"] [--thumb <png>]
 *                  [--round-of 4 | --replaces D-007] --by <agent>
 *   npm run art -- approve 4 --by <person>           thumbs up: it moves to assets/approved/
 *   npm run art -- changes 4 "<what to change>" --by <person>
 *   (Asset numbers go without the # on a command line, where # starts a comment; in quoted text #4 is fine.)
 *   npm run art -- say "yellow gun #4 is still clunky, #7 is great" --by <person>
 *   npm run art -- ref <file> --label "…" --kind look|use --by <person>   a reference for the art department
 *
 * How it works:
 * - Every asset has a number (#4) that stays the same through its rounds. A new round of #4 is a new
 *   file proposed with --round-of 4. The art department runs as many rounds as it likes without
 *   waiting for anyone; the Asset studio (War Room view 4) always shows the latest round.
 * - Work in progress lives in assets/staging/. A thumbs up moves the file to assets/approved/ (the same
 *   path below it), records it in the asset ledger with who approved it, and queues a renderer task
 *   to wire it in. Game code may load assets/approved/ only; the assets gate fails on staging paths.
 * - The dev can type feedback naming assets by number ("#4 is still clunky"): each named asset gets
 *   an art task with the dev's words. Feedback without a number goes to the art department as a note.
 * - When a design waits longer than the pace allows (precise 24 h, fast 8 h, extreme 4 h, half that
 *   with MAX SPEED), the Producer approves it provisionally. It is logged under "Decided without you",
 *   marked provisional in the Asset studio, and the dev can still ask for changes. The style sheet
 *   (the game's art reference, signed with the Bible) always waits for the dev.
 * - References from the dev: "look" (look like this, kept in the reference library, never shipped) or
 *   "use" (the dev's own asset, recorded for the game). Both are listed in studio/art/references.json
 *   with the dev's label, for the art department to read.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent } from './event.mjs';
import { isAgent } from './ask.mjs';

export const DESIGNS = path.join(REPO_ROOT, 'studio', 'art', 'designs.json');
export const ART_REFS = path.join(REPO_ROOT, 'studio', 'art', 'references.json');
const THUMBS = path.join(REPO_ROOT, 'studio', 'art', 'thumbs');
const LOG = path.join(REPO_ROOT, 'studio', 'decisions', 'decided-without-you.md');
export const KINDS = ['style', 'asset', 'concept'];
export const IMAGE = /\.(png|jpe?g|webp|gif|svg)$/i;
export const MODEL = /\.(glb|gltf)$/i;
const now = () => new Date().toISOString();
const rel = (abs) => path.relative(REPO_ROOT, abs).split(path.sep).join('/');
export const numberOf = (d) => Number(String(d.asset || d.id).slice(2));

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
/** The latest round of every asset: what the Asset studio shows. */
export const latestRounds = (list = readDesigns()) => list.filter((d) => d.status !== 'replaced');
/** "#4", "4", "D-004" or a design id of any round: the latest round of that asset. */
export function findDesign(ref, list = readDesigns()) {
  const s = String(ref || '').trim();
  const m = s.match(/^#?(\d+)$/);
  const asset = m ? `D-${m[1].padStart(3, '0')}` : list.find((d) => d.id === s)?.asset || s;
  return list.filter((d) => (d.asset || d.id) === asset && d.status !== 'replaced').pop() || null;
}

export function readArtRefs() {
  try {
    return JSON.parse(fs.readFileSync(ART_REFS, 'utf8')).references || [];
  } catch {
    return [];
  }
}

export function propose({ file, title, kind = 'asset', task = null, licence = '', source = '', author = '', generated = null, thumb = null, pack = '', roundOf = null, replaces = null, by = process.env.STUDIO_LOCK_OWNER || 'art' }) {
  if (!KINDS.includes(kind)) return { ok: false, message: `--kind is one of ${KINDS.join(', ')}` };
  const list = readDesigns();
  const prev = roundOf || replaces ? findDesign(roundOf || replaces, list) : null;
  if ((roundOf || replaces) && !prev) return { ok: false, message: `No asset ${roundOf || replaces}` };
  const t = String(title || prev?.title || '').trim();
  if (!t) return { ok: false, message: 'A design needs --title, in words the game dev would use ("Yellow gun").' };
  let abs = path.resolve(REPO_ROOT, String(file || ''));
  let r = rel(abs);
  if (!file || r.startsWith('..') || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return { ok: false, message: `No file at ${file} inside the project. Save it first: assets/staging/<pack>/ for game files, studio/art/ for sheets and concepts.` };
  if (/^references\//.test(r)) return { ok: false, message: `${r} is in the reference library: references are to design from, never to ship. Make our own version.` };
  // Game files are work in progress until approved: they live in assets/staging/.
  if (kind === 'asset' && !/^assets\/(staging|approved)\//.test(r)) {
    const sub = r.startsWith('assets/') ? r.slice('assets/'.length) : `${String(pack || prev?.pack || 'art').replace(/[^a-z0-9/_-]/gi, '-')}/${path.basename(abs)}`;
    const dest = path.join(REPO_ROOT, 'assets', 'staging', sub);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (r.startsWith('assets/')) fs.renameSync(abs, dest);
    else fs.copyFileSync(abs, dest);
    abs = dest;
    r = rel(dest);
  }
  if (prev) Object.assign(prev, { status: 'replaced', replacedAt: now() });
  // A new round keeps what the last one said about where it came from, unless told otherwise.
  if (prev) {
    generated = generated || prev.generated || null;
    licence = licence || (prev.generated ? '' : prev.licence);
    source = source || prev.source || '';
    author = author || prev.author || '';
  }
  const n = list.reduce((m, d) => Math.max(m, Number(d.id.slice(2))), 0) + 1;
  const id = `D-${String(n).padStart(3, '0')}`;
  let thumbRel = null;
  if (thumb && fs.existsSync(path.resolve(REPO_ROOT, thumb))) {
    fs.mkdirSync(THUMBS, { recursive: true });
    const tdest = path.join(THUMBS, `${id}${path.extname(thumb).toLowerCase() || '.png'}`);
    fs.copyFileSync(path.resolve(REPO_ROOT, thumb), tdest);
    thumbRel = rel(tdest);
  }
  const d = {
    id,
    asset: prev ? prev.asset || prev.id : id,
    round: prev ? (prev.round || 1) + 1 : 1,
    kind,
    title: t.slice(0, 160),
    file: r,
    pack: r.startsWith('assets/staging/') ? r.split('/').slice(2, -1).join('/') || null : null,
    image: IMAGE.test(r),
    model: MODEL.test(r),
    thumb: thumbRel,
    task,
    licence: String(generated ? `generated (${generated.tool})` : licence || (kind === 'asset' ? 'own work (made in this studio)' : '')).slice(0, 120),
    source: String(source).slice(0, 300),
    author: String(author).slice(0, 120) || null,
    generated,
    by,
    at: now(),
    status: 'proposed',
    feedback: prev?.feedback || [],
    history: [{ status: 'proposed', by, at: now() }],
  };
  list.push(d);
  writeDesigns(list);
  emitEvent({ type: 'art.proposed', agent: by, to: 'human', task, msg: `#${numberOf(d)} ${d.title}${d.round > 1 ? ` round ${d.round}` : ''} is in the Asset studio (${r})` });
  return { ok: true, design: d };
}

async function decide(ref, status, by, note = '', { provisional = false, why = '' } = {}) {
  note = note == null ? '' : String(note);
  const list = readDesigns();
  const d = findDesign(ref, list);
  if (!d) return { ok: false, message: `No asset ${ref}` };
  const reopen = status === 'changes' && d.status === 'approved';
  if (d.status !== 'proposed' && !reopen) return { ok: false, message: `#${numberOf(d)} is ${d.status}; the art department's next round comes back here.` };
  if (!provisional && (!by || isAgent(by))) return { ok: false, message: 'The game dev decides on designs: --by <your name>. Agents propose them.' };
  if (status === 'changes' && !note.trim()) return { ok: false, message: 'Say what to change, in your words.' };
  Object.assign(d, { status, decidedBy: by, decidedAt: now(), provisional: status === 'approved' ? provisional : d.provisional && reopen ? false : d.provisional });
  if (note.trim()) d.feedback = [...(d.feedback || []), { by, at: now(), text: note.slice(0, 1000), round: d.round }];
  d.history.push({ status, by, at: now(), note: note.slice(0, 1000), provisional });
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
  if (status === 'approved' && d.kind === 'asset' && /^assets\//.test(d.file)) {
    // Thumbs up: staging -> approved, recorded, and a renderer task to wire it in.
    const target = d.file.replace(/^assets\/staging\//, 'assets/approved/');
    if (target !== d.file) {
      fs.mkdirSync(path.dirname(path.join(REPO_ROOT, target)), { recursive: true });
      fs.renameSync(path.join(REPO_ROOT, d.file), path.join(REPO_ROOT, target));
      d.stagedAs = d.file;
      d.file = target;
    }
    const { recordApproved } = await import('./assets.mjs');
    const r = recordApproved({ file: d.file, by, licence: d.licence, source: d.source, design: d.id, maker: d.by, author: d.author, generated: d.generated, provisional });
    out.asset = r.ok ? r.asset.id : null;
    const { parseNextQueue, addTask } = await import('./task.mjs');
    const q = parseNextQueue();
    const tag = `asset #${numberOf(d)}`;
    if (![...q.inProgress, ...q.backlog].some((t) => t.title.includes(tag))) {
      const t = addTask({ title: `Import: wire ${tag} ${d.title} (${d.file}) into the game`.slice(0, 180), role: 'builder', priority: 'P2', agent: by, meta: { part: 'renderer', design: d.id, infra: true } });
      out.importTask = t.id || null;
    }
    out.next = r.ok ? `#${numberOf(d)} is in ${d.file} and the asset ledger (${r.asset.id})${provisional ? ', approved provisionally' : ''}.${out.importTask ? ` A builder has ${out.importTask} to wire it in.` : ''}` : r.message;
  }
  if (status === 'approved' && !out.next) out.next = `#${numberOf(d)} approved. The art department builds on it.`;
  writeDesigns(list);
  if (status === 'changes') {
    const { addTask } = await import('./task.mjs');
    const t = addTask({ title: `Art: round ${(d.round || 1) + 1} of #${numberOf(d)} ${d.title}: ${note.replace(/\s+/g, ' ')}`.slice(0, 180), role: 'art', priority: 'P1', agent: by, meta: { design: d.id } });
    out.task = t.id;
    out.next = `The art department has ${t.id} with your words; round ${(d.round || 1) + 1} of #${numberOf(d)} comes back to the Asset studio.`;
  }
  emitEvent({ type: status === 'approved' ? (provisional ? 'decision.timeout' : 'art.approved') : 'art.changes', agent: by, to: status === 'approved' && provisional ? 'human' : 'art', task: out.task || d.task, msg: status === 'approved' ? `${provisional ? `${by} approved #${numberOf(d)} ${d.title} provisionally (${why})` : `${by} approved #${numberOf(d)} ${d.title}`}` : `${by} asked for changes to #${numberOf(d)} ${d.title}: ${note}` });
  return out;
}
export const approve = (ref, by, note = '') => decide(ref, 'approved', by, note);
export const changes = (ref, note, by) => decide(ref, 'changes', by, note);

/** Free text from the dev: "#4 is still clunky, #7 is great". Each named asset gets the words; no number, a note to art. */
export async function feedback(text, by) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, message: 'Say something about the art.' };
  if (!by || isAgent(by)) return { ok: false, message: 'Feedback comes from the game dev: --by <your name>.' };
  const nums = [...new Set((t.match(/#(\d+)/g) || []).map((x) => x.slice(1)))];
  const done = [];
  for (const n of nums) {
    const list = readDesigns();
    const d = findDesign(`#${n}`, list);
    if (d && d.status === 'changes') {
      // Already being redone: the words join that round's notes and its open task, not a new task.
      d.feedback = [...(d.feedback || []), { by, at: now(), text: t.slice(0, 1000), round: d.round }];
      writeDesigns(list);
      const { parseNextQueue, addTask } = await import('./task.mjs');
      const q = parseNextQueue();
      const open = [...q.inProgress, ...q.backlog].find((x) => x.title.includes(` of #${n} `));
      const task = open?.id || addTask({ title: `Art: round ${(d.round || 1) + 1} of #${n} ${d.title}: ${t.replace(/\s+/g, ' ')}`.slice(0, 180), role: 'art', priority: 'P1', agent: by, meta: { design: d.id } }).id;
      emitEvent({ type: 'art.changes', agent: by, to: 'art', task, msg: `${by} on #${n} ${d.title}: ${t.slice(0, 200)}` });
      done.push({ asset: `#${n}`, task, added: Boolean(open) });
      continue;
    }
    const r = await changes(`#${n}`, t, by);
    done.push(r.ok ? { asset: `#${n}`, task: r.task } : { asset: `#${n}`, error: r.message });
  }
  if (!nums.length) {
    const { addTask } = await import('./task.mjs');
    const task = addTask({ title: `Art: note from ${by}: ${t.replace(/\s+/g, ' ')}`.slice(0, 180), role: 'art', priority: 'P1', agent: by });
    emitEvent({ type: 'art.note', agent: by, to: 'art', task: task.id, msg: t.slice(0, 300) });
    return { ok: true, done: [], task: task.id, next: `No asset number in it, so the art department has it as a note (${task.id}). Name an asset with #4 to send words to that one.` };
  }
  return { ok: true, done, next: `Sent: ${done.map((x) => (x.task ? `${x.asset} → ${x.task}${x.added ? ' (added to its open round)' : ''}` : `${x.asset}: ${x.error}`)).join('; ')}.` };
}

/** How long the Producer waits for the dev before approving provisionally, from the pace. */
export async function artWaitHours() {
  const { effectiveMode } = await import('./mode.mjs');
  const m = effectiveMode();
  const base = { precise: 24, budget: 24, fast: 8, extreme: 4 }[m.id] || 24;
  return m.boost ? Math.max(2, base / 2) : base;
}

/** The watcher's pass: designs waiting past the pace's limit are approved provisionally by the Producer. */
export async function expireDesigns(nowMs = Date.now()) {
  const hours = await artWaitHours();
  const producer = process.env.STUDIO_PRODUCER_NAME || 'producer';
  const decided = [];
  for (const d of waitingDesigns().filter((x) => x.kind !== 'style' && Date.parse(x.at) <= nowMs - hours * 3600000)) {
    const why = `waited ${hours} h for the game dev (pace limit)`;
    const r = await decide(d.id, 'approved', producer, '', { provisional: true, why });
    if (!r.ok) continue;
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    const head = fs.existsSync(LOG) ? '' : '# Decided without you\n\nThings that waited past their deadline. Reverse any of them from the War Room.\n';
    fs.appendFileSync(LOG, `${head}\n## Asset #${numberOf(d)} · ${new Date(nowMs).toISOString().slice(0, 16).replace('T', ' ')} UTC\n- ${d.title} (round ${d.round || 1}, ${r.design.file})\n- Approved provisionally by ${producer}: it ${why}. Ask for changes in the Asset studio to send it back.\n`);
    decided.push(`#${numberOf(d)}`);
  }
  return decided;
}

/** A reference from the dev, labelled: "look" (never shipped) or "use" (their own asset, for the game). */
export async function addArtReference({ file, label, kind = 'look', by }) {
  if (!by || isAgent(by)) return { ok: false, message: 'References come from the game dev: --by <your name>.' };
  if (!String(label || '').trim()) return { ok: false, message: 'Label it, so the art department knows what it is ("the hotel lobby mood", "my yellow gun model").' };
  if (!['look', 'use'].includes(kind)) return { ok: false, message: '--kind look (look like this, never shipped) or use (my own asset, put it in the game).' };
  const abs = path.resolve(String(file || ''));
  if (!file || !fs.existsSync(abs)) return { ok: false, message: `No file at ${file}` };
  const list = readArtRefs();
  const id = `AR-${String(list.length + 1).padStart(3, '0')}`;
  let entry;
  if (kind === 'look') {
    const { addRef } = await import('./refs.mjs');
    const r = await addRef({ source: abs, game: 'Art reference', feature: label, by });
    if (!r.ok) return r;
    const { libraryDir } = await import('./refs.mjs');
    const kept = r.ref.files[0] ? path.join(libraryDir(), r.ref.folder, r.ref.files[0]) : null;
    entry = { id, kind, label: String(label).slice(0, 160), ref: r.ref.id, file: kept ? path.relative(REPO_ROOT, kept).split(path.sep).join('/') : null, image: IMAGE.test(abs), by, at: now() };
  } else {
    const { addAsset } = await import('./assets.mjs');
    const r = await addAsset({ source: abs, use: 'game', owner: by, licence: `own work (${by}'s)`, by, pack: 'own' });
    if (!r.ok) return r;
    entry = { id, kind, label: String(label).slice(0, 160), asset: r.asset.id, file: r.asset.file, image: IMAGE.test(abs), model: MODEL.test(abs), by, at: now() };
  }
  fs.mkdirSync(path.dirname(ART_REFS), { recursive: true });
  fs.writeFileSync(ART_REFS, `${JSON.stringify({ references: [...list, entry] }, null, 2)}\n`);
  emitEvent({ type: 'art.reference', agent: by, to: 'art', msg: `${by} added ${kind === 'look' ? 'a look reference' : 'their own asset'}: ${entry.label} (${entry.file || entry.ref})` });
  return { ok: true, reference: entry, next: kind === 'look' ? `"${entry.label}" is in the art references (never shipped). The art department reads studio/art/references.json.` : `"${entry.label}" is recorded as your own asset (${entry.file}) and listed for the art department.` };
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
  const done = (r, line) => {
    if (!r.ok) {
      console.error(r.message);
      process.exit(1);
    }
    console.log(line(r));
    process.exit(0);
  };
  const [cmd = 'list', a1, a2] = pos;
  const gen = flag('generated') ? { tool: flag('generated').split(':')[0], model: flag('generated').split(':').slice(1).join(':') || null, prompt: flag('prompt') || null, terms: flag('terms') || null, at: now().slice(0, 10) } : null;
  if (cmd === 'propose') done(propose({ file: a1, title: flag('title'), kind: flag('kind') || 'asset', task: flag('task'), licence: flag('licence') || flag('license') || '', source: flag('source') || '', author: flag('author') || '', generated: gen, thumb: flag('thumb'), pack: flag('pack') || '', roundOf: flag('round-of'), replaces: flag('replaces'), by: flag('by') || undefined }), (r) => `#${numberOf(r.design)} ${r.design.title}${r.design.round > 1 ? ` round ${r.design.round}` : ''} (${r.design.id}) is in the Asset studio. Keep going: more rounds don't need the dev's answer.`);
  if (cmd === 'approve') done(await approve(a1, flag('by'), flag('note') || ''), (r) => r.next);
  if (cmd === 'changes') done(await changes(a1, a2 || flag('note'), flag('by')), (r) => r.next);
  if (cmd === 'say') done(await feedback(a1, flag('by')), (r) => r.next);
  if (cmd === 'ref') done(await addArtReference({ file: a1, label: flag('label'), kind: flag('kind') || 'look', by: flag('by') }), (r) => r.next);
  if (cmd === 'expire') {
    console.log(`Approved provisionally: ${(await expireDesigns()).join(', ') || 'nothing'}`);
    process.exit(0);
  }
  if (cmd === '--help' || cmd === 'help') {
    console.log('npm run art [-- propose <file> --title "…" [--round-of 4] --by <agent> | approve 4 --by <person> | changes 4 "<what>" --by <person> | say "<feedback with #numbers>" --by <person> | ref <file> --label "…" --kind look|use --by <person>]');
    process.exit(0);
  }
  const list = latestRounds();
  console.log(list.length ? list.map((d) => `#${numberOf(d)} ${d.title} · round ${d.round || 1} · ${d.status}${d.provisional ? ' (provisional)' : ''} · ${d.file}${d.feedback?.length ? ` · last word: ${d.feedback[d.feedback.length - 1].text}` : ''}`).join('\n') : 'No designs yet. The art department proposes them: npm run art -- propose <file> --title "…" --kind style|asset');
}
