#!/usr/bin/env node
/**
 * harness/visual-check.mjs — 2.77.0 (u, P5.5): the visual check, a gate for art and engine passes that a person (or a
 * reviewing agent) judges, never code.
 *
 * Why: an engine pass passed every test with a generic library model, and the owner's first look at the screenshots was
 * "toyish ... not based off of a real plane". Tests can't see that. So a pass added with --visual-check (or --refs) closes
 * only when every one of these is on record (`task done` and `node harness/done-check.mjs <ID>` list what is missing):
 *   1. fixed-camera before/after screenshots: the same camera names before and after, in .studio/proof/<T>/visual/
 *      (harness/visual-proof.mjs: its capture, or `shots` below for an engine's own screenshots); its pixel check holds
 *      (not blank, not near-identical);
 *   2. per real-thing asset, a side-by-side of its shot with a reference photo the studio provides (a local file: the
 *      task's --refs, or the assets reference folder, studio/game.json engines.<x>.visual.refs, else assets/reference/).
 *      The harness never downloads a photo: a link is refused. Every --refs photo must be used by an asset;
 *   3. the builder looked at its own shots (`looked`, with what it saw) after the last shot changed;
 *   4. a review by someone who is not the builder (a person or a reviewer agent: never an agent that started the task,
 *      recorded its shots or said it looked), on the current shots: "looks real" or "looks toyish", with notes. Only
 *      "real" passes. Nothing in the harness scores a picture: the score is the reviewer's words, recorded as given.
 * The shots go to the owner as one path line through the Communicator (harness/communicator.mjs queueNotice: posted in
 * its next pass, tagging nobody), on every review and on `send`. The page: .studio/visual-checks/<T>/side-by-side.html.
 *
 *   npm run visual -- shots <T> --before a.png[,b.png] --after a.png[,b.png] [--by <you>]   (camera = file name)
 *   npm run visual -- asset <T> --name "<the real thing>" --shot <png> --ref <photo> [--by <you>]
 *   npm run visual -- looked <T> --by <builder> --note "what I saw in my own shots"
 *   npm run visual -- review <T> --by <reviewer> --score real|toyish --notes "why" [--asset "<name>"]
 *   npm run visual -- send <T>          the path line to the owner now (the Communicator's next pass)
 *   npm run visual -- status <T> [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent, readRecentEvents } from './event.mjs';
import { mainRoot } from './worktree.mjs';
import { spawnSync } from 'node:child_process';
import { STUDIO_STATE_DIR } from './event.mjs';

// Not imported from harness/visual-proof.mjs: its CLI awaits modules that import done-check, which imports this file,
// so a static import here deadlocks `visual-proof.mjs check` (an unsettled top-level await). The same folder, and the
// pixel check through its own CLI (a sub-second child).
const proofDir = (task) => path.join(STUDIO_STATE_DIR, 'proof', task, 'visual');
function checkVisualProof(task, root) {
  const r = spawnSync(process.execPath, [path.join(root, 'harness', 'visual-proof.mjs'), 'check', task, '--json'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  try { return JSON.parse(String(r.stdout || '').trim().split('\n').pop()); } catch { return { ok: false, why: `the visual proof's pixel check didn't report (${String(r.stderr || '').trim().split('\n').pop() || `exit ${r.status}`})` }; }
}
import { engineTask, engineTarget } from './engine-tracks.mjs';

const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, `${JSON.stringify(v, null, 2)}\n`); fs.renameSync(tmp, f); };
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return null; } };
const rel = (root, f) => path.relative(root, f).split(path.sep).join('/');
const IMG = /\.(png|jpe?g|webp)$/i;
const isLink = (s) => /^[a-z][a-z0-9+.-]*:\/\//i.test(String(s || '').trim());
export const SCORES = ['real', 'toyish'];

export const checkDir = (task, root = mainRoot()) => path.join(root, '.studio', 'visual-checks', String(task));
const recFile = (task, root) => path.join(checkDir(task, root), 'record.json');
export function readCheck(task, root = mainRoot()) {
  const r = readJson(recFile(task, root), null);
  return r && typeof r === 'object' ? { assets: [], reviews: [], ...r } : { task, assets: [], reviews: [], shots: null, looked: null };
}
const saveCheck = (task, rec, root) => writeJson(recFile(task, root), { ...rec, task, updatedAt: new Date().toISOString() });

/** Does this task need the visual check? { required, refs, engine } (its engine record, else its task.added meta). */
export function visualRequired(task, { root = mainRoot(), events = null } = {}) {
  let r = null;
  try { r = engineTask(task, { root, events }); } catch {}
  if (r?.visual?.required) return { required: true, refs: r.visual.refs || [], engine: r.engine };
  const added = (events || readRecentEvents(20000)).filter((e) => e.type === 'task.added' && e.task === task).pop();
  if (added?.meta?.visualCheck || added?.meta?.refs?.length) return { required: true, refs: added.meta.refs || [], engine: r?.engine || null };
  return { required: false, refs: [], engine: r?.engine || null };
}

/** The assets reference folder: studio/game.json engines.<engine>.visual.refs, else assets/reference/ (relative to the studio). */
export function refsFolder(engine, root = mainRoot()) {
  const t = engine ? engineTarget(engine, { root }) : null;
  const d = t?.cfg?.visual?.refs;
  return path.resolve(root, typeof d === 'string' && d.trim() ? d : path.join('assets', 'reference'));
}
/** A reference photo's file: { file } or { error }. A link is refused (the harness never downloads); a bare name is looked up in the reference folder. */
export function resolveRef(ref, { engine = null, root = mainRoot() } = {}) {
  if (!ref || typeof ref !== 'string') return { error: 'no reference photo given (--ref <photo>)' };
  if (isLink(ref)) return { error: `"${ref.slice(0, 80)}" is a link: the harness never downloads photos. Save the photo under ${rel(root, refsFolder(engine, root))}/ (or anywhere in the studio) and pass its path` };
  const cands = [path.resolve(root, ref), path.resolve(refsFolder(engine, root), ref)];
  const f = cands.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
  if (!f) return { error: `no reference photo at ${ref} (looked in the studio and ${rel(root, refsFolder(engine, root))}/)` };
  if (!IMG.test(f)) return { error: `${ref} is not a picture (.png, .jpg, .webp)` };
  return { file: f };
}

/** The shots on file now: { before: [{ camera, file, sha }], after: [...] }, and one key for the whole set. */
export function currentShots(task, root = mainRoot()) {
  const dir = proofDir(task);
  const side = (s) => { try { return fs.readdirSync(path.join(dir, s)).filter((n) => /\.png$/i.test(n)).sort().map((n) => ({ camera: n.replace(/\.png$/i, ''), file: rel(root, path.join(dir, s, n)), sha: sha(path.join(dir, s, n)) })); } catch { return []; } };
  const before = side('before');
  const after = side('after');
  const rec = readCheck(task, root);
  const assets = (rec.assets || []).map((a) => `${a.name}:${a.shotSha}:${a.refSha}`);
  const key = crypto.createHash('sha256').update(JSON.stringify([before.map((x) => x.sha), after.map((x) => x.sha), assets])).digest('hex').slice(0, 16);
  return { before, after, key };
}

/** Who built the task: every agent that started it, recorded its shots or assets, or said it looked. */
export function buildersOf(task, { root = mainRoot(), events = null } = {}) {
  const evs = events || readRecentEvents(20000);
  const out = new Set(evs.filter((e) => e.task === task && (e.type === 'task.start' || e.type === 'agent.session.start') && e.agent).map((e) => e.agent));
  const rec = readCheck(task, root);
  for (const x of [rec.shotsBy, rec.looked?.by, ...(rec.assets || []).map((a) => a.by)]) if (x) out.add(x);
  return out;
}

function writePage(task, root) {
  const rec = readCheck(task, root);
  const dir = checkDir(task, root);
  fs.mkdirSync(dir, { recursive: true });
  const src = (f) => { const abs = path.resolve(root, f); const r = path.relative(dir, abs).split(path.sep).join('/'); return r.startsWith('..') && path.isAbsolute(f) && !abs.startsWith(root) ? `file://${abs.split(path.sep).join('/')}` : r; };
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const sh = currentShots(task, root);
  const cams = [...new Set([...sh.before, ...sh.after].map((x) => x.camera))];
  const last = (rec.reviews || []).filter((r) => r.key === sh.key).pop();
  const html = `<!doctype html><meta charset="utf-8"><title>${esc(task)} visual check</title>
<style>body{font:14px system-ui,sans-serif;margin:16px;background:#fff;color:#111}img{max-width:100%;border:1px solid #ccc}.row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:12px 0}h2{margin-top:28px}</style>
<h1>${esc(task)}: visual check</h1>
<p>${last ? `Reviewed by ${esc(last.by)}: <b>looks ${esc(last.score)}</b>. ${esc(last.notes)}` : 'Not reviewed yet.'}${rec.looked ? ` The builder (${esc(rec.looked.by)}) looked: ${esc(rec.looked.note)}` : ''}</p>
<h2>Fixed cameras: before | after</h2>
${cams.map((c) => { const b = sh.before.find((x) => x.camera === c); const a = sh.after.find((x) => x.camera === c); return `<h3>${esc(c)}</h3><div class="row"><div>${b ? `<img src="${esc(src(b.file))}" alt="before ${esc(c)}">` : 'no before'}</div><div>${a ? `<img src="${esc(src(a.file))}" alt="after ${esc(c)}">` : 'no after'}</div></div>`; }).join('\n')}
<h2>Real-thing assets: shot | reference photo</h2>
${(rec.assets || []).map((x) => `<h3>${esc(x.name)}</h3><div class="row"><div><img src="${esc(src(x.shot))}" alt="${esc(x.name)} in the game"></div><div><img src="${esc(src(x.ref))}" alt="${esc(x.name)} reference photo"></div></div>`).join('\n') || '<p>No asset compared yet.</p>'}
`;
  fs.writeFileSync(path.join(dir, 'side-by-side.html'), html);
  return rel(root, path.join(dir, 'side-by-side.html'));
}

/** Record before/after shots (copied into the visual proof's folders; camera = file name). */
export function recordShots(task, { before = [], after = [], by = null, root = mainRoot() } = {}) {
  const dir = proofDir(task);
  const copied = [];
  for (const [side, list] of [['before', before], ['after', after]]) {
    for (const f of list) {
      const abs = path.resolve(root, f);
      if (!fs.existsSync(abs) || !/\.png$/i.test(abs)) return { ok: false, why: `${f} is not a PNG screenshot here` };
      fs.mkdirSync(path.join(dir, side), { recursive: true });
      fs.copyFileSync(abs, path.join(dir, side, path.basename(abs)));
      copied.push(`${side}/${path.basename(abs)}`);
    }
  }
  const rec = readCheck(task, root);
  saveCheck(task, { ...rec, shotsBy: by || rec.shotsBy || null, shotsAt: new Date().toISOString() }, root);
  const page = writePage(task, root);
  return { ok: true, copied, page, why: `${copied.length} shot(s) for ${task} (${copied.join(', ')}); page ${page}` };
}

/** One real-thing asset: its shot beside the studio's reference photo. */
export function recordAsset(task, { name, shot, ref, by = null, root = mainRoot() } = {}) {
  if (!name || !String(name).trim()) return { ok: false, why: 'name the real thing (--name "<what it is>")' };
  const v = visualRequired(task, { root });
  const shotAbs = shot ? path.resolve(root, shot) : null;
  if (!shotAbs || !fs.existsSync(shotAbs) || !IMG.test(shotAbs)) return { ok: false, why: `--shot ${shot || '(none)'} is not a screenshot here` };
  const r = resolveRef(ref, { engine: v.engine, root });
  if (r.error) return { ok: false, why: r.error };
  const rec = readCheck(task, root);
  const keep = path.join(checkDir(task, root), 'assets');
  fs.mkdirSync(keep, { recursive: true });
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'asset';
  const shotCopy = path.join(keep, `${slug}${path.extname(shotAbs).toLowerCase()}`);
  fs.copyFileSync(shotAbs, shotCopy);
  const entry = { name: String(name).trim(), shot: rel(root, shotCopy), shotSha: sha(shotCopy), ref: path.isAbsolute(ref) && !r.file.startsWith(root) ? r.file : rel(root, r.file), refSha: sha(r.file), refGiven: ref, by, at: new Date().toISOString() };
  const assets = (rec.assets || []).filter((a) => a.name !== entry.name);
  assets.push(entry);
  saveCheck(task, { ...rec, assets }, root);
  const page = writePage(task, root);
  return { ok: true, entry, page, why: `${entry.name}: ${entry.shot} beside ${entry.ref}; page ${page}` };
}

/** The builder says it looked at its own shots (on the current set). */
export function recordLooked(task, { by, note = '', root = mainRoot() } = {}) {
  if (!by) return { ok: false, why: '--by <you> (the builder)' };
  if (String(note).trim().length < 15) return { ok: false, why: 'say what you saw in your own shots (--note, 15+ characters): proportions, materials, scale, anything off' };
  const sh = currentShots(task, root);
  if (!sh.after.length) return { ok: false, why: `there are no after shots for ${task} yet: record them first (npm run visual -- shots ${task} ...)` };
  const rec = readCheck(task, root);
  saveCheck(task, { ...rec, looked: { by, note: String(note).trim().slice(0, 600), key: sh.key, at: new Date().toISOString() } }, root);
  writePage(task, root);
  return { ok: true, why: `${by} looked at ${task}'s shots` };
}

/** A review: "looks real" or "looks toyish", with notes, by someone who is not the builder. */
export function recordReview(task, { by, score, notes = '', asset = null, root = mainRoot(), events = null } = {}) {
  if (!by) return { ok: false, why: '--by <reviewer>' };
  if (!SCORES.includes(String(score))) return { ok: false, why: `--score is real or toyish (the reviewer's own judgement; nothing scores it automatically)` };
  if (String(notes).trim().length < 15) return { ok: false, why: 'say why (--notes, 15+ characters): what looks real or toyish, against the reference photos' };
  const builders = buildersOf(task, { root, events });
  if (builders.has(by)) return { ok: false, why: `${by} built ${task} (started it, recorded its shots or said it looked): the builder can't grade its own pass. A person or a reviewer agent reviews it` };
  const sh = currentShots(task, root);
  if (!sh.after.length) return { ok: false, why: `there are no after shots for ${task} to review` };
  const rec = readCheck(task, root);
  const review = { by, score: String(score), notes: String(notes).trim().slice(0, 800), ...(asset ? { asset: String(asset) } : {}), key: sh.key, at: new Date().toISOString() };
  saveCheck(task, { ...rec, reviews: [...(rec.reviews || []), review].slice(-30) }, root);
  const page = writePage(task, root);
  try { emitEvent({ type: 'visual.reviewed', agent: by, task, to: 'producer', status: review.score === 'real' ? 'ok' : 'warn', msg: `${task} visual check: looks ${review.score} (${by}): ${review.notes}`.slice(0, 400), meta: { score: review.score, page } }); } catch {}
  const sent = postShots(task, { root, why: `reviewed by ${by}: looks ${review.score}` });
  return { ok: true, review, page, sent, why: `${task}: looks ${review.score} (by ${by}); the page ${page} goes to the owner${sent.ok ? '' : ` (not queued: ${sent.why})`}` };
}

/** The path line to the owner, through the Communicator (posted in its next pass, tagging nobody). */
export function postShots(task, { root = mainRoot(), why = '' } = {}) {
  const page = writePage(task, root);
  const sh = currentShots(task, root);
  const rec = readCheck(task, root);
  const last = (rec.reviews || []).filter((r) => r.key === sh.key).pop();
  const text = `Shots for ${task}${why ? ` (${why})` : last ? ` (looks ${last.score}, by ${last.by})` : ' (not reviewed yet)'}: ${page}${sh.after.length ? `; after: ${sh.after.map((x) => x.file).join(', ')}` : ''}${rec.assets?.length ? `; ${rec.assets.length} asset(s) beside reference photos` : ''}`;
  try {
    // A small file the Communicator reads (harness/communicator.mjs pendingNotices); no import cycle, nothing secret.
    const f = path.join(root, '.studio', 'comm', 'notices.jsonl');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, `${JSON.stringify({ key: `visual:${task}:${sh.key}:${last?.at || 'unreviewed'}`, kind: 'visual', task, text, at: new Date().toISOString() })}\n`);
    saveCheck(task, { ...rec, posted: { at: new Date().toISOString(), text } }, root);
    try { emitEvent({ type: 'visual.shots_sent', agent: 'visual-check', task, to: 'human', msg: text.slice(0, 400), meta: { page } }); } catch {}
    return { ok: true, text, page };
  } catch (e) { return { ok: false, why: e.message }; }
}

/**
 * The done check's rows for a task that needs the visual check: [{ label, ok, why }] ([] when it doesn't need one).
 */
export function visualCheckRows(task, { root = mainRoot(), events = null } = {}) {
  const v = visualRequired(task, { root, events });
  if (!v.required) return [];
  const rows = [];
  const row = (label, ok, why) => rows.push({ label, ok: Boolean(ok), why: ok ? null : why });
  const sh = currentShots(task, root);
  const px = sh.before.length && sh.after.length ? checkVisualProof(task, REPO_ROOT) : { ok: false, why: '' };
  row('Fixed-camera before/after screenshots (the same cameras, not blank, not near-identical)', sh.before.length && sh.after.length && px.ok, !sh.after.length || !sh.before.length ? `no ${!sh.before.length ? 'before' : 'after'} shots: npm run visual -- capture ${task} before|after, or npm run visual -- shots ${task} --before <png> --after <png> (one PNG per fixed camera, same names)` : px.why);
  const rec = readCheck(task, root);
  const used = new Set((rec.assets || []).map((a) => a.refGiven).concat((rec.assets || []).map((a) => a.ref)));
  const missing = (v.refs || []).filter((r) => !used.has(r) && !(rec.assets || []).some((a) => path.basename(a.ref) === path.basename(r)));
  row('Each real-thing asset beside its reference photo', (rec.assets || []).length > 0 && !missing.length, (rec.assets || []).length ? `no asset compared with ${missing.join(', ')}: npm run visual -- asset ${task} --name "<the real thing>" --shot <png> --ref <photo>` : `no real-thing asset compared with a reference photo: npm run visual -- asset ${task} --name "<the real thing>" --shot <png> --ref <photo> (a photo the studio provides${v.refs?.length ? `: ${v.refs.join(', ')}` : ''})`);
  const looked = rec.looked && rec.looked.key === sh.key;
  row('The builder looked at its own shots (after the last one changed)', looked, rec.looked ? `the shots changed since ${rec.looked.by} looked: look again (npm run visual -- looked ${task} --by <you> --note "what you saw")` : `the builder hasn't said it looked: npm run visual -- looked ${task} --by <you> --note "what you saw in your own shots"`);
  const reviews = (rec.reviews || []).filter((r) => r.key === sh.key);
  const last = reviews.pop();
  row('Reviewed by someone else: looks real', last && last.score === 'real', last ? `${last.by} says it looks ${last.score}: ${last.notes}. Rework it, take new shots, and ask for a new review` : `no review on the current shots: a person or a reviewer agent (not the builder) runs npm run visual -- review ${task} --by <name> --score real|toyish --notes "…" (page: ${rel(root, path.join(checkDir(task, root), 'side-by-side.html'))})`);
  return rows;
}

export function statusLines(task, root = mainRoot()) {
  const v = visualRequired(task, { root });
  const rows = visualCheckRows(task, { root });
  const rec = readCheck(task, root);
  return [`${task}: visual check ${v.required ? 'required' : 'not required (add --visual-check or --refs to the task)'}${v.refs?.length ? `; reference photos: ${v.refs.join(', ')}` : ''}`, ...rows.map((r) => `  [${r.ok ? 'x' : ' '}] ${r.label}${r.ok ? '' : `: ${r.why}`}`), ...(rec.posted ? [`  sent to the owner ${String(rec.posted.at).slice(0, 16)}: ${rec.posted.text}`] : [])];
}

/** The CLI (npm run visual -- shots|asset|looked|review|send|status; harness/visual-proof.mjs forwards these). */
export async function cli(argv) {
  const [cmd, task] = argv;
  const opt = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  const list = (k) => String(opt(k) || '').split(',').map((x) => x.trim()).filter(Boolean);
  const by = opt('by') || process.env.STUDIO_LOCK_OWNER || null;
  if (!task || !/^[A-Z]+-\d+$/.test(task)) { console.error('Usage: npm run visual -- shots|asset|looked|review|send|status <T-ID> …'); return 2; }
  let r;
  if (cmd === 'shots') r = recordShots(task, { before: list('before'), after: list('after'), by });
  else if (cmd === 'asset') r = recordAsset(task, { name: opt('name'), shot: opt('shot'), ref: opt('ref'), by });
  else if (cmd === 'looked') r = recordLooked(task, { by, note: opt('note') || '' });
  else if (cmd === 'review') r = recordReview(task, { by, score: opt('score'), notes: opt('notes') || '', asset: opt('asset') });
  else if (cmd === 'send') r = postShots(task, {});
  else if (cmd === 'status') {
    if (argv.includes('--json')) console.log(JSON.stringify({ task, required: visualRequired(task), rows: visualCheckRows(task), record: readCheck(task) }, null, 2));
    else console.log(statusLines(task).join('\n'));
    return 0;
  } else { console.error('Usage: npm run visual -- shots|asset|looked|review|send|status <T-ID> …'); return 2; }
  (r.ok ? console.log : console.error)(`[visual] ${r.ok ? '' : 'not recorded: '}${r.why || r.text}`);
  return r.ok ? 0 : 1;
}
export const VISUAL_CHECK_COMMANDS = new Set(['shots', 'asset', 'looked', 'review', 'send', 'status']);
void REPO_ROOT;

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) process.exit(await cli(process.argv.slice(2)));
