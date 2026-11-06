#!/usr/bin/env node
/**
 * harness/vertex-proxy.mjs — 2.79.1 (a): the studio's Vertex AI proxy (folded from the crew's local .studio/vertex-proxy.mjs).
 *
 *   node harness/vertex-proxy.mjs --root <main checkout> [--port 8787]    (the launcher starts it: harness/vertex.mjs ensureProxy)
 *
 * Listens on 127.0.0.1 only. For each request:
 *   - GET /__studio/health answers { studio: 'vertex-proxy', pid, root } (how the launcher knows the port is this proxy).
 *   - The client's key must be a session tag, `session-<agent>` (aider's --openai-api-key), naming a running session whose
 *     tool goes through this proxy (its .studio/agents/<agent>.json: tool vertex, or proxy "vertex"); otherwise 401/403. The
 *     tag is never forwarded.
 *   - The main checkout's .env is read again (VERTEX_API_KEY, VERTEX_PROJECT_ID, STUDIO_VERTEX_BASE_URL): no key or no project
 *     is 503 "Vertex is paused or not configured", so renaming the key in .env pauses Vertex at once.
 *   - /v1/<sub> goes to <the Vertex OpenAI-compatible base>/<sub>, with the key as x-goog-api-key (Vertex answers 401 to a
 *     Bearer key); a bare model name in the body gets the google/ prefix; a ?key= from the client is dropped.
 *   - The upstream status and body come back as they are; each answer's usage is appended to .studio/vertex-usage.jsonl as
 *     { ts, session, task, tool, model, in: prompt_tokens, out: total_tokens - prompt_tokens (Gemini's thinking tokens are
 *     billed as output), total, usd (at studio/prices.json) }. The key is never logged, printed or written anywhere.
 *   - 2.79.2 (a): once a session's request was over STUDIO_VERTEX_MAX_PROMPT_TOKENS (150000), its next request is 403 (not
 *     forwarded); the launcher stops the session.
 *   - Anything that goes wrong in the proxy is 502, with the key scrubbed from the message.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { readEnvFile, vertexUpstream, vertexId, overPromptCap, promptCap, HEALTH_PATH, USAGE_REL, VERTEX_KEY_ENV, VERTEX_PROJECT_ENV, VERTEX_PORT_DEFAULT } from './vertex.mjs';
import { priceFor } from './autonomy.mjs';

const TAG = /^session-([A-Za-z0-9][A-Za-z0-9._-]{0,79})$/;

/** The usage numbers of one answer (JSON, or the last usage object of an SSE stream), or null. */
export function usageOf(text) {
  const s = String(text || '');
  const pick = (o) => (o && typeof o === 'object' && o.usage && typeof o.usage === 'object' ? { usage: o.usage, model: o.model || null } : null);
  try { const r = pick(JSON.parse(s)); if (r) return r; } catch {}
  let last = null;
  for (const line of s.split(/\r?\n/)) {
    const m = line.match(/^data:\s*(\{.*\})\s*$/);
    if (!m) continue;
    try { const r = pick(JSON.parse(m[1])); if (r) last = r; } catch {}
  }
  return last;
}
/** in / out / total from a usage object: out = total - prompt when total is given (thinking is billed), else completion. */
export function countsOf(u) {
  const inT = Number(u.prompt_tokens) || 0;
  const total = Number(u.total_tokens) || 0;
  const out = total ? Math.max(0, total - inT) : Number(u.completion_tokens) || 0;
  return { in: inT, out, total: total || inT + out };
}
function priceTable(root) { try { return JSON.parse(fs.readFileSync(path.join(root, 'studio', 'prices.json'), 'utf8')).models || null; } catch { return null; } }
export function usdOf(root, model, c) {
  const p = priceFor(priceTable(root), model, 'vertex');
  if (!p) return null;
  return Math.round(((c.in * (Number(p.in) || 0)) + (c.out * (Number(p.out) || 0))) / 1e6 * 1e6) / 1e6;
}

/** The proxy server (not listening yet). root: the main checkout. fetchImpl: for tests. */
export function createVertexProxy({ root, fetchImpl = globalThis.fetch } = {}) {
  const usageFile = path.join(root, USAGE_REL);
  const send = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      let key = '';
      const scrub = (s) => (key && key.length >= 6 ? String(s).split(key).join('<key>') : String(s));
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (req.method === 'GET' && url.pathname === HEALTH_PATH) return send(res, 200, { studio: 'vertex-proxy', pid: process.pid, root });
        if (!url.pathname.startsWith('/v1/')) return send(res, 404, { error: { message: 'the studio\'s Vertex proxy serves /v1/… only' } });
        const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
        const tag = auth.match(TAG);
        if (!tag) return send(res, 401, { error: { message: 'the studio\'s Vertex proxy takes only a session tag as its key (session-<agent>); a launched vertex session gets one' } });
        const agent = tag[1];
        let rec = null;
        try { rec = JSON.parse(fs.readFileSync(path.join(root, '.studio', 'agents', `${agent}.json`), 'utf8')); } catch {}
        if (!rec || rec.status !== 'running' || !(rec.tool === 'vertex' || rec.proxy === 'vertex')) return send(res, 403, { error: { message: `${agent} is not a running session on the Vertex proxy` } });
        const vals = readEnvFile(path.join(root, '.env'));
        key = String(vals[VERTEX_KEY_ENV] || '').trim();
        const up = vertexUpstream(vals);
        // 2.79.2 (a): a session that already sent a request over STUDIO_VERTEX_MAX_PROMPT_TOKENS gets no more (its launcher
        // stops it and hands its task back): one oversized request is the most it spends.
        const capped = overPromptCap(agent, { root, since: Date.parse(rec.startedAt || '') || 0, cap: promptCap({ ...process.env, ...vals }) });
        if (capped.over) return send(res, 403, { error: { message: `${agent} is stopped by the studio: ${capped.why}` } });
        if (!key || !up.base) return send(res, 503, { error: { message: `Vertex is paused or not configured: ${!key ? `${VERTEX_KEY_ENV} is not set` : up.why} in the studio's .env` } });
        let body = Buffer.concat(chunks);
        let model = null;
        if (body.length && /json/i.test(String(req.headers['content-type'] || 'application/json'))) {
          try {
            const j = JSON.parse(body.toString('utf8'));
            if (j && typeof j.model === 'string') { j.model = vertexId(j.model); model = j.model; body = Buffer.from(JSON.stringify(j)); }
          } catch { /* passed on as it is */ }
        }
        url.searchParams.delete('key');
        const target = `${up.base}/${url.pathname.slice('/v1/'.length)}${url.search}`;
        const headers = { 'x-goog-api-key': key };
        for (const h of ['content-type', 'accept']) if (req.headers[h]) headers[h] = String(req.headers[h]);
        const r = await fetchImpl(target, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
        const text = await r.text();
        const u = r.ok ? usageOf(text) : null;
        if (u) {
          const c = countsOf(u.usage);
          const m = vertexId(u.model || model || '') || null;
          const line = { ts: new Date().toISOString(), session: agent, task: rec.task || null, tool: rec.tool || null, model: m, in: c.in, out: c.out, total: c.total, usd: usdOf(root, m, c) };
          try { fs.mkdirSync(path.dirname(usageFile), { recursive: true }); fs.appendFileSync(usageFile, `${JSON.stringify(line)}\n`); } catch {}
        }
        res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' });
        res.end(scrub(text));
      } catch (e) {
        try { send(res, 502, { error: { message: `the studio's Vertex proxy failed: ${scrub(e?.message || e)}`.slice(0, 400) } }); } catch {}
      }
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  const root = path.resolve(flag('root') || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const port = Number(flag('port') || process.env.STUDIO_VERTEX_PROXY_PORT || VERTEX_PORT_DEFAULT);
  const server = createVertexProxy({ root });
  server.on('error', (e) => { console.error(`[vertex-proxy] ${e.message}`); process.exit(1); });
  server.listen(port, '127.0.0.1', () => console.log(`[vertex-proxy] ${new Date().toISOString()} listening on 127.0.0.1:${port} for ${root} (key from its .env: ${VERTEX_KEY_ENV}, ${VERTEX_PROJECT_ENV})`));
  const bye = () => server.close(() => process.exit(0));
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);
}
