#!/usr/bin/env node
/**
 * harness/producer-refill.mjs — 2.30o: the queue never runs dry while the game has unmet goals.
 *
 * In the Marina run the queue emptied after the early game and builders sat idle for hours: nothing told
 * the Producer to plan again, and its last plan re-listed finished work. Now, when fewer than
 * STUDIO_REFILL_MIN (4) builder tasks are open, a refill pass derives tasks from what is computably unmet:
 *   1. the charter's milestone exit criteria (studio/bible/CHARTER.md), next unmet milestone of each ladder;
 *   2. the asset list (studio/bible/ASSETS.md lines "- [ ] <asset> -> <path>") whose file is missing;
 *   3. failed visual results (.studio/proof/<T>/verdict.json) and failed layout checks
 *      (.studio/layout-last.json).
 * Each candidate is refused when an open or done task already covers it (same key, or 60% of its words),
 * so done work is never re-listed. Then the Producer is woken for anything the pass can't derive.
 *
 * Charter format: a milestone line "- M2 Name: ..." (or "### M2 ...") then "Exit: a; b; c" (or "- [ ] a"
 * items under it). A milestone marked DONE, or whose criteria are all ticked "- [x]" or recorded met in
 * .studio/milestones.json, is closed; `milestone close M2 --by director` records it.
 *
 *   node harness/producer-refill.mjs [--dry-run] [--json]       one pass
 *   node harness/producer-refill.mjs milestones                  the ladder and what is unmet
 *   node harness/producer-refill.mjs met M2 <n> --by <who>       record exit criterion n of M2 as met
 *   node harness/producer-refill.mjs close M2 --by director      close a milestone (opens the next)
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, emitEvent } from './event.mjs';

const CHARTER = () => process.env.STUDIO_CHARTER || path.join(REPO_ROOT, 'studio', 'bible', 'CHARTER.md');
const ASSETS = () => path.join(REPO_ROOT, 'studio', 'bible', 'ASSETS.md');
const MS = () => path.join(STUDIO_STATE_DIR, 'milestones.json');
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const write = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`); };

/** Parse the charter into ladders of milestones with exit criteria. */
export function parseCharter(text) {
  const ms = []; let ladder = 'main'; let cur = null;
  for (const raw of String(text || '').replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    const h = line.match(/^##\s+(.+)/);
    if (h && !/^###/.test(line)) { ladder = h[1].trim(); cur = null; continue; }
    const m = line.match(/^(?:[-*]\s+|###\s+)(?:\[[ xX]\]\s+)?\**([A-Z]{1,3}\d+)\**\s*[:.—–-]?\s*(.*)$/);
    if (m) {
      cur = { id: m[1], ladder, title: m[2].replace(/\s*[—–-]\s*DONE.*$/i, '').split(/[:.]/)[0].trim(), done: /\bDONE\b/.test(m[2]), exit: [] };
      ms.push(cur);
      const inline = m[2].match(/\bExit:\s*(.+)$/i);
      if (inline) cur.exit.push(...inline[1].split(/;\s*/).map((t) => ({ text: t.trim(), ticked: false })).filter((x) => x.text));
      continue;
    }
    if (!cur) continue;
    const ex = line.match(/^Exit:\s*(.+)$/i);
    if (ex) { cur.exit.push(...ex[1].split(/;\s*/).map((t) => ({ text: t.replace(/\.$/, '').trim(), ticked: false })).filter((x) => x.text)); continue; }
    const cb = line.match(/^[-*]\s+\[([ xX])\]\s+(.+)$/);
    if (cb) cur.exit.push({ text: cb[2].trim(), ticked: cb[1] !== ' ' });
  }
  return ms;
}

/** The ladder with met/closed state applied. */
export function milestones(text = fs.existsSync(CHARTER()) ? fs.readFileSync(CHARTER(), 'utf8') : '', state = read(MS(), {})) {
  return parseCharter(text).map((m) => {
    const st = state[m.id] || {};
    const exit = m.exit.map((e, i) => ({ ...e, n: i + 1, met: e.ticked || Boolean(st.met?.[i + 1]) }));
    const closed = m.done || Boolean(st.closed) || (exit.length > 0 && exit.every((e) => e.met) && Boolean(st.closed));
    return { ...m, exit, closed, ready: !closed && exit.length > 0 && exit.every((e) => e.met) };
  });
}
/** The next open milestone of each ladder. */
export function nextOpen(list = milestones(), ahead = Number(process.env.STUDIO_REFILL_AHEAD ?? 1)) {
  const seen = new Map(); const out = [];
  for (const m of list) if (!m.closed && (seen.get(m.ladder) || 0) < Math.max(1, ahead)) { seen.set(m.ladder, (seen.get(m.ladder) || 0) + 1); out.push(m); }
  return out;
}
export function setMet(id, n, by) { const s = read(MS(), {}); s[id] = { ...(s[id] || {}), met: { ...(s[id]?.met || {}), [n]: { by, at: new Date().toISOString() } } }; write(MS(), s); }
export function closeMilestone(id, by) {
  const s = read(MS(), {}); s[id] = { ...(s[id] || {}), closed: { by, at: new Date().toISOString() } }; write(MS(), s);
  const next = nextOpen(milestones(), 1).find((m) => m.ladder === milestones().find((x) => x.id === id)?.ladder);
  emitEvent({ type: 'milestone.closed', agent: by, to: 'producer', msg: `${id} closed by ${by}${next ? `; next: ${next.id} ${next.title}` : '; that ladder is complete'}`, meta: { id, next: next?.id || null } });
  return next || null;
}

const words = (s) => new Set(String(s).toLowerCase().replace(/\bt-\d+\b/g, '').match(/[a-z0-9]{3,}/g) || []);
/** File one task unless an open or done task already covers it (key or 60% of its words). */
export async function fileTask(key, title, { role = 'builder', priority = 'P1', by = 'watchdog' } = {}) {
  const task = await import('./task.mjs');
  const q = task.parseNextQueue();
  const all = [...q.inProgress, ...q.backlog, ...q.done];
  const dup = all.find((t) => { const k = (t.title.match(KEY) || [])[1]; return k ? k === key : similar(t.title, title) >= 0.6; });
  if (dup) return { skipped: true, id: dup.id };
  const r = task.addTask({ title: `${title} [ref:${key}]`, role, priority, agent: 'producer', meta: { origin: by, promoted: true } });
  return r?.error ? { skipped: true, why: r.message } : { id: r?.id };
}
export function similar(a, b) {
  const A = words(a); const B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}
const KEY = /\[ref:([^\]]+)\]/;

/** Candidates, unfiltered. */
export function candidates({ list = milestones() } = {}) {
  const out = [];
  // Round-robin across ladders, so the Godot track and the game's milestones both move.
  const per = nextOpen(list).map((m) => m.exit.filter((x) => !x.met).map((e) => ({ key: `${m.id}#${e.n}`, title: `${m.id} ${m.title}: meet exit criterion "${e.text}" (proof: the metric or screenshot it names)` })));
  for (let i = 0; per.some((p) => p[i]); i++) for (const p of per) if (p[i]) out.push(p[i]);
  if (fs.existsSync(ASSETS())) for (const l of fs.readFileSync(ASSETS(), 'utf8').split('\n')) {
    const a = l.match(/^\s*[-*]\s+\[ \]\s+(.+?)\s*(?:->|→)\s*(\S+)/);
    if (a && !fs.existsSync(path.join(REPO_ROOT, a[2]))) out.push({ key: `asset:${a[2]}`, title: `Asset: make ${a[1]} at ${a[2]} and use it in the scene (proof: before/after capture)` });
  }
  const proofRoot = path.join(STUDIO_STATE_DIR, 'proof');
  if (fs.existsSync(proofRoot)) for (const t of fs.readdirSync(proofRoot)) {
    const v = read(path.join(proofRoot, t, 'verdict.json'), null);
    if (v?.parts?.visual && v.parts.visual.ok === false) out.push({ key: `visual:${t}`, title: `Fix the visual check that failed on ${t}: ${String(v.parts.visual.why || '').slice(0, 160)} (proof: npm run visual -- check)` });
  }
  const lay = read(path.join(STUDIO_STATE_DIR, 'layout-last.json'), null);
  for (const f of lay?.failed || []) out.push({ key: `layout:${f.rule}`, title: `Fix layout rule ${f.rule}: ${String(f.why).slice(0, 160)} (proof: layout gate passes)` });
  return out;
}

/** One refill pass. deps for tests: { queue, add, wake }. */
export async function refillPass({ dryRun = false, min = Number(process.env.STUDIO_REFILL_MIN ?? 4), deps = {} } = {}) {
  const task = await import('./task.mjs');
  const q = deps.queue || task.parseNextQueue();
  const open = [...q.inProgress, ...q.backlog].filter((t) => t.role === 'builder');
  if (open.length >= min) return { refilled: [], why: `${open.length} builder tasks open (min ${min})` };
  const known = [...q.inProgress, ...q.backlog, ...q.done];
  const keys = new Set(known.map((t) => (t.title.match(KEY) || [])[1]).filter(Boolean));
  const refused = []; const picked = [];
  for (const c of candidates()) {
    if (picked.length >= min - open.length) break;
    const dup = keys.has(c.key) ? { title: `[ref:${c.key}]` } : known.find((t) => !KEY.test(t.title) && similar(t.title, c.title) >= 0.6);
    if (dup) { refused.push({ ...c, because: dup.title.slice(0, 80) }); continue; }
    picked.push(c); keys.add(c.key);
  }
  const added = [];
  if (!dryRun) for (const c of picked) {
    const add = deps.add || ((x) => task.addTask({ title: x.title, role: 'builder', priority: 'P1', agent: 'producer', meta: { origin: 'refill', promoted: true } }));
    const r = add({ title: `${c.title} [ref:${c.key}]` });
    if (r && !r.error) added.push(r.id || c.key);
  }
  let woke = null;
  if (!dryRun && process.env.STUDIO_REFILL_WAKE !== 'off') {
    const wake = deps.wake || (async (why) => (await import('./agent.mjs')).wake('producer', { why }));
    try { woke = await wake(`the queue is low (${open.length} open): plan forward from the next unmet milestone; never re-list done work`); } catch {}
  }
  const msg = `Queue low (${open.length} builder tasks open): ${dryRun ? 'would add' : 'added'} ${picked.length} from unmet goals${refused.length ? `, refused ${refused.length} already covered` : ''}`;
  // 2.54.0 (P-027): a pass that adds nothing and wakes nobody is logged once an hour, not every minute.
  let quiet = false;
  if (!picked.length && !woke?.started) {
    try {
      const { readRecentEvents } = await import('./event.mjs');
      const last = readRecentEvents(2000).filter((e) => e.type === 'producer.refill' && e.msg === msg).pop();
      quiet = Boolean(last && Date.now() - Date.parse(last.ts) < 3600000);
    } catch {}
  }
  if (!quiet) emitEvent({ type: 'producer.refill', agent: 'watchdog', to: 'producer', msg, meta: { picked: picked.map((p) => p.key), refused: refused.map((r) => r.key) } });
  return { refilled: picked, added, refused, woke, why: `${open.length} open < ${min}` };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const a = process.argv.slice(2);
  const by = a.includes('--by') ? a[a.indexOf('--by') + 1] : null;
  if (a[0] === 'milestones') {
    for (const m of milestones()) console.log(`${m.closed ? '[closed]' : m.ready ? '[ready] ' : '[open]  '} ${m.id} ${m.title} (${m.ladder}): ${m.exit.filter((e) => e.met).length}/${m.exit.length} exit criteria met`);
  } else if (a[0] === 'met' && a[1] && a[2] && by) { setMet(a[1], Number(a[2]), by); console.log(`${a[1]} criterion ${a[2]} met (${by})`); }
  else if (a[0] === 'close' && a[1] && by) { const n = closeMilestone(a[1], by); console.log(`${a[1]} closed${n ? `; next ${n.id}` : ''}`); }
  else {
    const r = await refillPass({ dryRun: a.includes('--dry-run') });
    if (a.includes('--json')) console.log(JSON.stringify(r));
    else console.log(r.refilled.length ? r.refilled.map((c) => `+ ${c.title}`).join('\n') + (r.refused?.length ? `\n(refused ${r.refused.length} already covered)` : '') : `No refill: ${r.why}`);
  }
}
