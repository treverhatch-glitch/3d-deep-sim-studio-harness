/**
 * harness/token-weight.mjs — 2.65.2: the weighted token count every meter uses (cache reads at a weight), in a module
 * with no harness imports but event.mjs, so a module that must stay sync and cycle-free (autonomy.mjs's buildAutonomy)
 * gets the same numbers as budget.mjs, which re-exports these. Before, buildAutonomy called without `weigh` counted
 * cache reads at full weight (research 2026-11-01, finding 3: 11.65M against 1.79M tokens per landed task).
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './event.mjs';

/**
 * Cache reads count (2.29.2). Test #4's overnight run: 97% of all tokens were cache reads, and a meter
 * that saw only input + output read 4.66M against 100M+ real, so --budget could never trip. They are
 * cheaper than fresh input, so they count at a weight: STUDIO_CACHE_READ_WEIGHT, or cacheReadWeight in
 * studio/budget.json, default 0.1. Cache writes are already in tokensIn.
 */
export function cacheReadWeight() {
  let fromFile;
  try { fromFile = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'studio', 'budget.json'), 'utf8'))?.cacheReadWeight; } catch {}
  const v = process.env.STUDIO_CACHE_READ_WEIGHT ?? fromFile;
  return v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? 0.1 : Math.max(0, Number(v));
}
/** One event's tokens for the meters: input (with cache writes) + output + weighted cache reads. */
export function weightedTokens(e, w = cacheReadWeight()) {
  return (Number(e.tokensIn) || 0) + (Number(e.tokensOut) || 0) + (Number(e.meta?.cacheRead ?? e.cacheRead) || 0) * w;
}
