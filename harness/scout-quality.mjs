/**
 * harness/scout-quality.mjs — 2.30e: judge scouted art on quality, not just volume.
 *
 * qualityScore(result) gives 0-10 from what the source tells us:
 *   resolution      longest side: 4k+ full marks, 2k good, 1k some, below that none
 *   maps            textures: albedo/diffuse, normal, roughness present (each a third)
 *   poly count      models: 500 to 200k triangles is sane for a game; over 500k or under 50 is not
 *   source rating   a rating (0-5) when the source has one, else downloads on a log scale (1M = full)
 *   tags            up to six descriptive tags
 * Only the parts the source reports count, so a missing field neither helps nor hurts; with nothing
 * known the score is 5 and says "unknown". An optional vision judge (STUDIO_VISION_URL, an
 * OpenAI-compatible endpoint, STUDIO_VISION_MODEL, STUDIO_VISION_KEY) looks at the thumbnail and its
 * 0-10 is averaged in; its tokens go to studio/ledger/scout-vision.jsonl, which the token ledger reads.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './event.mjs';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export function qualityScore(r) {
  const parts = [];
  const add = (name, got, why) => parts.push({ name, got: clamp(got, 0, 1), why });
  const res = Array.isArray(r.resolution) ? Math.max(...r.resolution.map(Number).filter(Number.isFinite)) : Number(r.resolution);
  if (Number.isFinite(res) && res > 0) add('resolution', res >= 4096 ? 1 : res >= 2048 ? 0.75 : res >= 1024 ? 0.4 : 0, `${res}px`);
  if (Array.isArray(r.maps) && r.kind !== 'model' && r.kind !== 'hdri') {
    const has = (re) => r.maps.some((m) => re.test(String(m)));
    const found = [['albedo', /albedo|diff|color|colour|base/i], ['normal', /nor/i], ['roughness', /rough/i]].filter(([, re]) => has(re)).map(([n]) => n);
    add('maps', found.length / 3, found.length ? found.join('+') : 'no albedo/normal/roughness');
  }
  const poly = Number(r.polycount);
  if (r.kind === 'model' && Number.isFinite(poly) && poly > 0) add('poly', poly >= 500 && poly <= 200000 ? 1 : poly > 500000 || poly < 50 ? 0 : 0.5, `${poly} tris`);
  if (Number.isFinite(Number(r.rating)) && r.rating != null) add('rating', Number(r.rating) / 5, `rated ${r.rating}/5`);
  else if (Number.isFinite(Number(r.downloads)) && r.downloads != null) add('popularity', Math.log10(Number(r.downloads) + 1) / 6, `${r.downloads} downloads`);
  if (Array.isArray(r.tags)) add('tags', Math.min(r.tags.length, 6) / 6, `${r.tags.length} tags`);
  if (!parts.length) return { score: 5, why: 'unknown (source gives no quality data)', parts };
  const score = Math.round((parts.reduce((x, p) => x + p.got, 0) / parts.length) * 100) / 10;
  return { score, why: parts.map((p) => `${p.name} ${p.why}`).join(', '), parts };
}

/** Ask a vision model for 0-10 on a thumbnail. Off unless STUDIO_VISION_URL and a model are set. */
export async function visionJudge(r, { fetch: f = globalThis.fetch, env = process.env, query = '' } = {}) {
  const url = env.STUDIO_VISION_URL;
  const model = env.STUDIO_VISION_MODEL;
  if (!url || !model || !r.thumb) return null;
  const body = {
    model,
    max_tokens: 200,
    messages: [{ role: 'user', content: [
      { type: 'text', text: `Rate this ${r.kind || 'asset'} for a stylised 3D game${query ? ` (wanted: ${query})` : ''} from 0 to 10 for visual quality and fit. Reply with JSON only: {"score": n, "why": "..."}` },
      { type: 'image_url', image_url: { url: r.thumb } },
    ] }],
  };
  const headers = { 'content-type': 'application/json' };
  if (env.STUDIO_VISION_KEY) headers.authorization = `Bearer ${env.STUDIO_VISION_KEY}`;
  const resp = await f(`${url.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
  const j = await resp.json();
  const text = j?.choices?.[0]?.message?.content || '';
  const m = String(text).match(/\{[\s\S]*\}/);
  const parsed = m ? JSON.parse(m[0]) : {};
  const score = clamp(Number(parsed.score), 0, 10);
  const u = j?.usage || {};
  const dir = path.join(REPO_ROOT, 'studio', 'ledger');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'scout-vision.jsonl'), JSON.stringify({ at: new Date().toISOString(), agent: 'scout', role: 'art-scout', model, task: `scout:${r.source}/${r.id}`, tokensIn: u.prompt_tokens || 0, tokensOut: u.completion_tokens || 0 }) + '\n');
  return Number.isFinite(score) ? { score, why: String(parsed.why || '').slice(0, 120), model } : null;
}

/** Score every result (and ask the vision judge when asked), drop those under minQuality, best first. */
export async function judgeResults(results, { minQuality = 0, vision = false, fetch: f, env = process.env, query = '' } = {}) {
  for (const r of results) {
    const q = qualityScore(r);
    r.quality = q.score;
    r.qualityWhy = q.why;
    if (vision) {
      try {
        const v = await visionJudge(r, { fetch: f, env, query });
        if (v) { r.quality = Math.round(((q.score + v.score) / 2) * 10) / 10; r.qualityWhy += `, vision ${v.score}/10 (${v.model})`; }
      } catch (err) { r.qualityWhy += `, vision skipped (${String(err?.message || err).slice(0, 60)})`; }
    }
  }
  return results.filter((r) => r.quality >= minQuality).sort((a, b) => b.quality - a.quality);
}
