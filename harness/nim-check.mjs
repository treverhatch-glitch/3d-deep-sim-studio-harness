/**
 * harness/nim-check.mjs — 2.60.1 (B-19): is a NIM model usable with this key, before a `--tool nim` session starts?
 *
 * NIM's model list shows models a key can't use: the crew's key got 404 "Function … Not found for account" for the
 * default model, and the session died after aider's retries. So the check is one tiny request (a 1-token chat
 * completion) per model, through an injectable fetch, and the answer is cached per model (and key fingerprint) in
 * .studio/nim-models.json for NIM_SESSION.checkHours (24; STUDIO_NIM_CHECK_HOURS, 0 = no cache).
 *
 * Verdicts: ok (2xx), missing (404/410, or a 400/403/422 that says not found / not entitled / end of life: the next
 * model in the list is tried), quota (429 or a quota/rate text: never a fallback here, that is the quota fallback's
 * job), skipped (network error, timeout, 401, 5xx, anything else: launch with the model as configured and say the
 * check was skipped). Only ok and missing are cached. The key is never printed: answers are trimmed and any
 * key-shaped text is replaced.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STUDIO_STATE_DIR } from './event.mjs';
import { NIM_SESSION } from './models.config.mjs';

export const NIM_CHECK_FILE = () => path.join(STUDIO_STATE_DIR, 'nim-models.json');
const strip = (m) => String(m || '').trim().replace(/^openai\//, '');

/** The models to try, in order: the session's model, then STUDIO_NIM_MODELS (or NIM_SESSION.fallbackModels). */
export function nimModelChain(model, env = process.env) {
  const listed = String(env.STUDIO_NIM_MODELS || '').split(',').map(strip).filter(Boolean);
  return [...new Set([strip(model), ...(listed.length ? listed : NIM_SESSION.fallbackModels.map(strip))].filter(Boolean))];
}

export const nimCheckOff = (env = process.env) => /^(off|0|false|no)$/i.test(String(env.STUDIO_NIM_CHECK || '').trim());
const cacheMs = (env) => {
  const h = String(env.STUDIO_NIM_CHECK_HOURS ?? '').trim();
  const n = h === '' ? NIM_SESSION.checkHours : Number(h);
  return Number.isFinite(n) && n > 0 ? n * 3600000 : 0;
};
/** A short fingerprint of the key (a cache entry for one key never answers for another); not the key. */
const fingerprint = (key) => crypto.createHash('sha256').update(String(key || '')).digest('hex').slice(0, 10);

/** A provider answer, safe to log: one line, trimmed, the key and key-shaped text replaced. */
export function safeText(text, key = null) {
  let t = String(text || '').replace(/\s+/g, ' ').trim();
  if (key) t = t.split(String(key)).join('<key>');
  return t.replace(/\b(nvapi-|sk-)[\w-]{8,}/g, '$1<redacted>').replace(/Bearer\s+\S+/gi, 'Bearer <redacted>').slice(0, 200);
}

/** One answer's verdict: 'ok' | 'missing' | 'quota' | 'skipped'. */
export function nimProbeVerdict(status, body = '') {
  const s = Number(status) || 0;
  const b = String(body || '');
  if (s >= 200 && s < 300) return 'ok';
  if (s === 429 || /\bquota\b|rate.?limit|too many requests/i.test(b)) return 'quota';
  if (s === 404 || s === 410) return 'missing';
  if ([400, 403, 422].includes(s) && /not found for account|function\b.*\bnot found|model\b.*\b(not found|does not exist|unknown|not available)|not entitled|entitlement|end of life|has been deprecated/i.test(b)) return 'missing';
  return 'skipped';
}

function readCache(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; }
}
function writeCache(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  } catch {}
}

/** Check one model: { model, verdict, status, why, cached, at }. */
export async function checkNimModel(model, { key, base, fetchImpl = globalThis.fetch, env = process.env, now = Date.now(), file = NIM_CHECK_FILE(), timeoutMs = NIM_SESSION.checkTimeoutMs } = {}) {
  const m = strip(model);
  const ttl = cacheMs(env);
  const ck = `${fingerprint(key)}|${m}`;
  const cache = readCache(file);
  const hit = cache[ck];
  if (ttl && hit && (hit.verdict === 'ok' || hit.verdict === 'missing') && now - Date.parse(hit.at || 0) < ttl) return { model: m, verdict: hit.verdict, status: hit.status, why: hit.why, cached: true, at: hit.at };
  let status = 0;
  let body = '';
  try {
    const res = await fetchImpl(`${String(base).replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ model: m, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 1, temperature: 0, stream: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status;
    try { body = await res.text(); } catch {}
  } catch (err) {
    return { model: m, verdict: 'skipped', status: 0, why: `the check could not reach NIM (${safeText(err?.name === 'TimeoutError' ? `no answer in ${Math.round(timeoutMs / 1000)} s` : err?.message || err, key)})`, cached: false };
  }
  const verdict = nimProbeVerdict(status, body);
  const said = safeText(body, key);
  const why = verdict === 'ok' ? `NIM answered ${status}` : `NIM answered ${status}${said ? `: ${said}` : ''}`;
  const at = new Date(now).toISOString();
  if (ttl && (verdict === 'ok' || verdict === 'missing')) writeCache(file, { ...readCache(file), [ck]: { model: m, verdict, status, why, at } });
  return { model: m, verdict, status, why, cached: false, at };
}

/**
 * Pick the model a nim session runs: { model, configured, changed, skipped, tried: [checks], line, refused }.
 * Walk the chain: missing → the next model; ok → that one; quota or skipped → that one, unconfirmed (no fallback on
 * a quota or network answer). None usable: model null and `refused` says why.
 */
export async function pickNimModel(model, { key, base, fetchImpl, env = process.env, now = Date.now(), file } = {}) {
  const configured = strip(model);
  if (nimCheckOff(env)) return { model: configured, configured, changed: false, skipped: true, tried: [], line: `NIM model ${configured}: not checked (STUDIO_NIM_CHECK=off)` };
  if (!key) return { model: configured, configured, changed: false, skipped: true, tried: [], line: `NIM model ${configured}: not checked (no NIM key)` };
  const tried = [];
  for (const m of nimModelChain(configured, env)) {
    const c = await checkNimModel(m, { key, base, fetchImpl, env, now, file });
    tried.push(c);
    if (c.verdict === 'missing') continue;
    const from = c.cached ? ` (checked ${c.at}, cached)` : '';
    const before = tried.slice(0, -1).map((t) => `${t.model} not usable with this key (${t.why}${t.cached ? ', cached' : ''})`).join('; ');
    const what = c.verdict === 'ok' ? `available${from}` : c.verdict === 'quota' ? `not confirmed: ${c.why} (a quota answer; the quota fallback handles it, not a model change)` : `check skipped: ${c.why}; launching with it as configured`;
    const line = m === configured ? `NIM model ${m}: ${what}` : `NIM model ${m} chosen instead of ${configured}: ${before}; ${m} ${what}`;
    return { model: m, configured, changed: m !== configured, skipped: c.verdict === 'skipped', tried, line };
  }
  const refused = `none of the NIM models works with this key: ${tried.map((t) => `${t.model} (${t.why}${t.cached ? ', cached' : ''})`).join('; ')}. Set STUDIO_NIM_MODEL or STUDIO_NIM_MODELS to models your key can use (npm run models:check checks them; a cached answer lasts ${Math.round(cacheMs(env) / 3600000)} h, delete .studio/nim-models.json to check again now)`;
  return { model: null, configured, changed: false, skipped: false, tried, refused, line: refused };
}

/** A fetch that answers from a JSON file instead of the network (tests): { "<model>": { "status": 404, "body": "…" } | "network" }; others answer 200. */
export function stubFetchFrom(file) {
  let table = {};
  try { table = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch {}
  return async (url, init) => {
    let model = '';
    try { model = JSON.parse(init?.body || '{}').model; } catch {}
    try { fs.appendFileSync(`${file}.calls`, `${model}\n`); } catch {}
    const a = table[model];
    if (a === 'network') throw new Error('stub: network down');
    const status = a?.status ?? 200;
    const text = a?.body ?? (status === 200 ? '{"choices":[{"message":{"content":"OK"}}]}' : '');
    return { status, ok: status >= 200 && status < 300, text: async () => text };
  };
}
