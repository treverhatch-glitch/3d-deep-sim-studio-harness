#!/usr/bin/env node
/**
 * harness/layout-gate.mjs — 2.30o: check the presentation layout a game exports, against rules it declares.
 *
 * The sim was tested; where things are drawn was not. In the Marina run piers sat on the sand, boats were
 * tiny and parked on the beach, and every gate passed. A game may export its world layout as JSON (from a
 * test hook in the web build or a Godot tool script) and declare rules; this gate checks them. Generic:
 * it knows nothing about marinas.
 *
 * Layout JSON: { "objects": [ { "id", "kind", "x", "z", "w", "d", "size"?, "berth"?, "at"? } ],
 *                "depth": { "origin": [x0, z0], "cell": n, "rows": [[d, d, ...], ...] } | null,
 *                "shoreline"?: number }     x/z centre, w/d footprint (world units); depth > 0 is water depth
 * Rules JSON (studio.layout.json in the game folder):
 *   { "layout": "<file the hook writes>", "hook": "<command that writes it>",
 *     "rules": [
 *       { "type": "reach-depth",   "kind": "pier", "minDepth": 2 }          the far end of each reaches that depth
 *         ("referencedBy": { "kind": "berth", "field": "pier" } checks only piers some berth names)
 *       { "type": "on-water",      "kind": "boat", "minDepth": 0.5 }        its centre is in water at least that deep
 *       { "type": "at-anchor",     "kind": "boat", "anchor": "berth", "maxDist": 1.5, "when": "moored" }
 *       { "type": "no-overlap",    "kinds": ["pier", "building"], "tolerance": 0.05 }
 *       { "type": "scale",         "kind": "boat", "min": 3, "max": 30 }   size (or max(w,d)) in range
 *       { "type": "spread",        "kind": "boat", "by": "berthOf", "maxShare": 0.4, "when": "waiting" }
 *       { "type": "count",         "kind": "pier", "min": 2 } ] }
 *
 *   node harness/layout-gate.mjs [--game-dir web/x] [--layout f.json] [--rules r.json] [--no-hook] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './event.mjs';

export function depthAt(layout, x, z) {
  const d = layout.depth;
  if (!d?.rows?.length) return null;
  const [x0, z0] = d.origin || [0, 0];
  const c = d.cell || 1;
  const col = Math.floor((x - x0) / c); const row = Math.floor((z - z0) / c);
  if (row < 0 || row >= d.rows.length || col < 0 || col >= d.rows[row].length) return null;
  return Number(d.rows[row][col]);
}
const box = (o) => ({ x0: o.x - (o.w || 0) / 2, x1: o.x + (o.w || 0) / 2, z0: o.z - (o.d || 0) / 2, z1: o.z + (o.d || 0) / 2 });
function overlap(a, b, tol) {
  const A = box(a); const B = box(b);
  const ox = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0); const oz = Math.min(A.z1, B.z1) - Math.max(A.z0, B.z0);
  if (ox <= 0 || oz <= 0) return false;
  const small = Math.min((a.w || 0) * (a.d || 0), (b.w || 0) * (b.d || 0)) || 1;
  return (ox * oz) / small > tol;
}
const of = (L, k, when, ref = null) => (L.objects || []).filter((o) => o.kind === k && (!when || o.state === when)
  && (!ref || (L.objects || []).some((x) => x.kind === ref.kind && x[ref.field] === o.id)));
/** The deepest point of an object's footprint (its far end, for a pier). */
function maxDepthOver(L, o) {
  const b = box(o); let best = -Infinity;
  for (let i = 0; i <= 8; i++) for (let j = 0; j <= 2; j++) {
    const v = depthAt(L, b.x0 + ((b.x1 - b.x0) * i) / 8, b.z0 + ((b.z1 - b.z0) * j) / 2);
    if (v != null && v > best) best = v;
  }
  for (let j = 0; j <= 8; j++) { const v = depthAt(L, o.x, b.z0 + ((b.z1 - b.z0) * j) / 8); if (v != null && v > best) best = v; }
  return best;
}

/** Check rules against a layout. Returns [{ rule, ok, why }]. */
export function checkLayout(L, rules = []) {
  const res = [];
  for (const r of rules) {
    const bad = [];
    if (r.type === 'reach-depth') for (const o of of(L, r.kind, r.when, r.referencedBy)) { const m = maxDepthOver(L, o); if (!(m >= r.minDepth)) bad.push(`${o.id} reaches depth ${m === -Infinity ? 'none' : m.toFixed(2)} < ${r.minDepth}`); }
    else if (r.type === 'on-water') for (const o of of(L, r.kind, r.when)) { const d = depthAt(L, o.x, o.z); if (!(d >= (r.minDepth ?? 0.01))) bad.push(`${o.id} sits at depth ${d ?? 'off-map'} (on land or too shallow)`); }
    else if (r.type === 'at-anchor') {
      const anchors = of(L, r.anchor);
      for (const o of of(L, r.kind, r.when)) {
        const near = Math.min(...anchors.map((a) => Math.hypot(a.x - o.x, a.z - o.z)));
        if (!(near <= r.maxDist)) bad.push(`${o.id} is ${Number.isFinite(near) ? near.toFixed(2) : 'far'} from the nearest ${r.anchor} (max ${r.maxDist})`);
      }
    } else if (r.type === 'no-overlap') {
      const objs = (r.kinds || [r.kind]).flatMap((k) => of(L, k));
      for (let i = 0; i < objs.length; i++) for (let j = i + 1; j < objs.length; j++) if (overlap(objs[i], objs[j], r.tolerance ?? 0.05)) bad.push(`${objs[i].id} overlaps ${objs[j].id}`);
    } else if (r.type === 'scale') for (const o of of(L, r.kind, r.when)) { const s = o.size ?? Math.max(o.w || 0, o.d || 0); if (!(s >= r.min && s <= r.max)) bad.push(`${o.id} size ${s} outside ${r.min}..${r.max}`); }
    else if (r.type === 'spread') {
      const objs = of(L, r.kind, r.when); const counts = {};
      for (const o of objs) { const k = o[r.by] ?? 'none'; counts[k] = (counts[k] || 0) + 1; }
      const total = objs.length;
      if (total >= (r.minCount ?? 3)) for (const [k, n] of Object.entries(counts)) if (n / total > r.maxShare) bad.push(`${Math.round((n / total) * 100)}% of ${r.when || ''} ${r.kind}s want ${k} (max ${Math.round(r.maxShare * 100)}%)`);
    } else if (r.type === 'count') { const n = of(L, r.kind, r.when).length; if (n < (r.min ?? 0) || n > (r.max ?? Infinity)) bad.push(`${n} ${r.kind}s, want ${r.min ?? 0}..${r.max ?? '∞'}`); }
    else bad.push(`unknown rule type ${r.type}`);
    res.push({ rule: r.id || `${r.type}:${r.kind || (r.kinds || []).join('+')}`, ok: bad.length === 0, why: bad.slice(0, 6).join('; ') + (bad.length > 6 ? ` (+${bad.length - 6} more)` : '') });
  }
  return res;
}

/** Run a game's layout gate: hook (writes the layout), then the rules. */
export function runLayoutGate({ gameDir, layoutFile, rulesFile, hook = true } = {}) {
  const rf = rulesFile || (gameDir && path.join(REPO_ROOT, gameDir, 'studio.layout.json'));
  if (!rf || !fs.existsSync(rf)) return { ok: true, skipped: true, rows: [], why: 'the game declares no layout rules' };
  const cfg = JSON.parse(fs.readFileSync(rf, 'utf8'));
  if (hook && cfg.hook) {
    const h = spawnSync(cfg.hook, { cwd: REPO_ROOT, shell: true, encoding: 'utf8', timeout: 300000 });
    if (h.status !== 0) return { ok: false, rows: [], why: `the layout hook failed (exit ${h.status}): ${`${h.stdout || ''}${h.stderr || ''}`.trim().slice(-300)}` };
  }
  const lf = layoutFile || path.resolve(REPO_ROOT, cfg.layout || '');
  if (!fs.existsSync(lf)) return { ok: false, rows: [], why: `no layout file at ${path.relative(REPO_ROOT, lf)}` };
  const rows = checkLayout(JSON.parse(fs.readFileSync(lf, 'utf8')), cfg.rules || []);
  const failed = rows.filter((r) => !r.ok);
  return { ok: failed.length === 0, rows, failed, why: failed.map((f) => `${f.rule}: ${f.why}`).join(' | ') };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const a = process.argv.slice(2);
  const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : null);
  let gameDir = opt('--game-dir');
  if (!gameDir && !opt('--rules')) { try { const { studioGame } = await import('./game-gates.mjs'); gameDir = (await studioGame())?.root; } catch {} }
  const res = runLayoutGate({ gameDir, layoutFile: opt('--layout') && path.resolve(opt('--layout')), rulesFile: opt('--rules') && path.resolve(opt('--rules')), hook: !a.includes('--no-hook') });
  if (a.includes('--json')) console.log(JSON.stringify(res));
  else { for (const r of res.rows) console.log(`[layout] ${r.ok ? 'PASS' : 'FAIL'} ${r.rule}${r.why ? `: ${r.why}` : ''}`); if (!res.rows.length) console.log(`[layout] ${res.ok ? 'skip' : 'FAIL'}: ${res.why}`); }
  process.exit(res.ok ? 0 : 1);
}
