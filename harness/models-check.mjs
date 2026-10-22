#!/usr/bin/env node
/**
 * harness/models-check.mjs — before you spend real tokens, check every configured model still exists.
 *
 *   npm run models:check             ask each provider you have a key for which models it serves
 *   npm run models:check -- --dry-run   only print what would be checked
 *
 * It calls each provider's model-list endpoint (free: no tokens), compares it with the model the
 * router is set to use (harness/models.config.mjs, overridable with *_MODEL in .env), and names
 * close matches when a model is gone. Exits 1 if a configured model is missing.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS } from './models.config.mjs';
import { loadDotEnv, resolveProviderChannels } from './route.mjs';
import { emitEvent } from './event.mjs';
import { modelWarning, acceptModelWarning, TIER_EXAMPLES } from './model-tiers.mjs';

const family = (id) => String(id).replace(/^models\//, '').split(/[-:/.]/).filter((x) => !/^\d/.test(x)).slice(0, 2).join('-');

async function listModels(p, key) {
  const base = p.baseUrl.replace(/\/$/, '');
  const headers = p.protocol === 'anthropic' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : p.protocol === 'ollama' ? {} : { Authorization: `Bearer ${key}`, ...(p.extraHeaders || {}) };
  const res = await fetch(`${base}/models${p.protocol === 'anthropic' ? '?limit=1000' : ''}`, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data.data || data.models || []).map((m) => String(m.id || m.name || '').replace(/^models\//, '')).filter(Boolean);
}

export async function checkModels({ dryRun = false } = {}) {
  loadDotEnv();
  const rows = [];
  for (const p of Object.values(PROVIDERS)) {
    const ch = resolveProviderChannels(p)[0];
    if (!ch) {
      rows.push({ id: p.id, model: p.model, status: 'no-key', note: `no ${p.envKeys.join(' or ')} in .env` });
      continue;
    }
    if (dryRun) {
      rows.push({ id: p.id, model: p.model, status: 'would-check', note: `GET ${p.baseUrl.replace(/\/$/, '')}/models` });
      continue;
    }
    try {
      const ids = await listModels(p, ch.apiKey);
      const want = String(p.model).replace(/^models\//, '');
      const ok = ids.includes(want) || p.id === 'openrouter-free';
      const near = ok ? [] : ids.filter((i) => family(i) === family(want)).sort().reverse().slice(0, 5);
      rows.push({ id: p.id, model: p.model, status: ok ? 'ok' : 'missing', note: ok ? `${ids.length} models served` : `not served. Close matches: ${near.join(', ') || 'none; see the provider docs'}` });
    } catch (err) {
      rows.push({ id: p.id, model: p.model, status: p.protocol === 'ollama' ? 'not-running' : 'error', note: p.protocol === 'ollama' ? 'Ollama is not running on this machine' : err.message });
    }
  }
  return rows;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  if (process.argv.includes('--accept-top-tier')) {
    const by = process.argv[process.argv.indexOf('--accept-top-tier') + 1] || 'human';
    acceptModelWarning(by);
    console.log(`Accepted by ${by}. The War Room's warning stays hidden until the models change.`);
    process.exit(0);
  }
  // Per-role tiers (2.29.2): a strong suggestion, never enforced.
  loadDotEnv();
  const w = modelWarning();
  if (w.roles.length) {
    console.log(`Models per role (${w.source === 'config' ? '.env' : 'sessions in the last day'}):`);
    for (const r of w.roles) console.log(`  ${r.role.padEnd(14)} ${String(r.model).padEnd(28)} ${r.tier.padEnd(7)} suggested: ${r.suggested}`);
    console.log(`  Tiers: top ${TIER_EXAMPLES.top}; mid ${TIER_EXAMPLES.mid}; cheap ${TIER_EXAMPLES.cheap}.`);
  }
  if (w.allTop) console.log(`\nWarning: the top tier on every role. ${w.text}${w.accepted ? ` (accepted by ${w.accepted.by})` : ' Accept it in the War Room, or: npm run models:check -- --accept-top-tier <your name>'}\n`);
  const rows = await checkModels({ dryRun: process.argv.includes('--dry-run') });
  for (const r of rows) console.log(`${r.status.padEnd(12)} ${r.id.padEnd(22)} ${String(r.model).padEnd(42)} ${r.note}`);
  const missing = rows.filter((r) => r.status === 'missing');
  if (!process.argv.includes('--dry-run')) emitEvent({ type: 'models.check', agent: 'watch', status: missing.length ? 'error' : 'ok', msg: missing.length ? `Models not served: ${missing.map((r) => `${r.id}=${r.model}`).join(', ')}` : `Models checked: ${rows.filter((r) => r.status === 'ok').length} ok` });
  if (missing.length) {
    console.log('\nSet the matching *_MODEL in .env (ANTHROPIC_MODEL, OPENAI_MODEL, XAI_MODEL, GEMINI_PRO_MODEL, GEMINI_FLASH_MODEL, GROQ_MODEL, NVIDIA_GLM_MODEL, OPENROUTER_FREE_MODEL, OLLAMA_MODEL).');
    process.exit(1);
  }
}
