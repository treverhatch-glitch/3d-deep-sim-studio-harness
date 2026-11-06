/**
 * harness/vertex.mjs — 2.79.1 (a): Vertex AI as a built-in builder tool (`--tool vertex`), on the owner's Google Cloud credit.
 *
 * A `vertex` session is aider (the same aider `--tool aider` and `--tool nim` start: harness/aider-launch.mjs) talking to a
 * harness-owned proxy on this machine (harness/vertex-proxy.mjs, 127.0.0.1:STUDIO_VERTEX_PROXY_PORT, 8787). The proxy holds
 * the key: it re-reads the main checkout's .env on every request (VERTEX_API_KEY, VERTEX_PROJECT_ID), sends the key to
 * Vertex's OpenAI-compatible endpoint as x-goog-api-key (Vertex refuses it as a Bearer token), and logs each answer's usage
 * to .studio/vertex-usage.jsonl. The session never sees the key: its environment has no VERTEX_ name (harness/agent-env.mjs),
 * its lane copy's .env has no VERTEX_API_KEY line (harness/worktree.mjs), and aider gets `--openai-api-key session-<agent>`,
 * which the proxy reads as the session's tag (never forwarded), so every usage line names a session and so a task.
 *
 * Settings (the main checkout's .env; the key and project are read from the file only, so renaming the key pauses Vertex):
 *   VERTEX_API_KEY, VERTEX_PROJECT_ID   the owner's key and project (names only are ever printed)
 *   STUDIO_VERTEX_MODEL                 a normal builder task's model (google/gemini-3-flash-preview)
 *   STUDIO_VERTEX_HARD_MODEL            a hard task's model: size 4-5 or a chain-breaker (google/gemini-3.1-pro-preview)
 *   STUDIO_VERTEX_SHARE                 the share of builder slots Vertex may take while the plan has headroom (0.5)
 *   STUDIO_VERTEX_PROXY_PORT            the proxy's port (8787)
 *   STUDIO_VERTEX_MAX_PROMPT_TOKENS     a request over this many prompt tokens stops its session (150000; 0 = no cap)
 *   STUDIO_VERTEX_BASE_URL              the OpenAI-compatible base (default: the global endpoint of VERTEX_PROJECT_ID); https,
 *                                       or http on 127.0.0.1/localhost only; read from the .env file only
 * Spend is always logged and reported (npm run budget, npm run tokens -- --by task); a cap is a budget someone allowed sets
 * (harness/spend-budget.mjs: npm run budget -- set vertex <usd> --by <who> --why "<the owner's order>"). There is none by default.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { STUDIO_STATE_DIR, readRecentEvents } from './event.mjs';
import { aiderProgram } from './aider-launch.mjs';
import { resolveCommand } from './launch.mjs';

export const VERTEX_DEFAULT_MODEL = 'google/gemini-3-flash-preview';
export const VERTEX_HARD_MODEL = 'google/gemini-3.1-pro-preview';
export const VERTEX_SHARE_DEFAULT = 0.5;
export const VERTEX_PORT_DEFAULT = 8787;
export const VERTEX_KEY_ENV = 'VERTEX_API_KEY';
export const VERTEX_PROJECT_ENV = 'VERTEX_PROJECT_ID';
export const USAGE_REL = '.studio/vertex-usage.jsonl';
export const PROXY_REL = '.studio/vertex-proxy.json';
export const HEALTH_PATH = '/__studio/health';

const HARNESS = path.dirname(fileURLToPath(import.meta.url));
/** The main checkout (a lane copy's .studio is the main checkout's, so its parent is the main checkout). */
export const studioRoot = () => path.dirname(STUDIO_STATE_DIR);
const num = (v, d) => { const n = Number(v); return v !== undefined && v !== null && String(v).trim() !== '' && Number.isFinite(n) ? n : d; };

/** Every NAME=value line of a .env file (all names, unlike dotenv.mjs's settings reader). Values stay in memory only. */
export function readEnvFile(file) {
  const out = {};
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const v = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (v !== '' || !(m[1] in out)) out[m[1]] = v;
  }
  return out;
}
export const mainEnv = (root = studioRoot()) => readEnvFile(path.join(root, '.env'));

/** { ok, why }: the key and the project are set in the main checkout's .env (names only in the reason). */
export function vertexConfigured(root = studioRoot()) {
  const e = mainEnv(root);
  const missing = [VERTEX_KEY_ENV, VERTEX_PROJECT_ENV].filter((k) => !String(e[k] || '').trim());
  return missing.length ? { ok: false, why: `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set in the studio's .env (Vertex is paused or not configured)` } : { ok: true, why: '' };
}

/**
 * { ok, why }: Vertex can take a session here: configured (vertexConfigured) and aider found (the launcher's own lookup,
 * harness/aider-launch.mjs; on Windows PATH x PATHEXT as harness/launch.mjs resolves it). For the supervisor, which can't
 * import the launcher (agent.mjs) when the launcher itself runs it.
 */
export function vertexReady({ root = studioRoot(), env = process.env, platform = process.platform } = {}) {
  const c = vertexConfigured(root);
  if (!c.ok) return c;
  const onPath = (name, e, p) => (p === 'win32' ? resolveCommand(name, { env: e, platform: p }).mode !== 'missing' : null);
  const prog = aiderProgram({ env, platform, onPath: platform === 'win32' ? onPath : null });
  return prog.cmd ? { ok: true, why: '' } : { ok: false, why: prog.why };
}

/** The OpenAI-compatible base to forward to: { base, why } (base null with a reason when it can't be used). */
export function vertexUpstream(vals) {
  const set = String(vals.STUDIO_VERTEX_BASE_URL || '').trim().replace(/\/+$/, '');
  if (set) {
    let u;
    try { u = new URL(set); } catch { return { base: null, why: 'STUDIO_VERTEX_BASE_URL is not a URL' }; }
    const loop = /^(127\.0\.0\.1|localhost|\[::1\])$/i.test(u.hostname);
    if (u.protocol === 'https:' || (u.protocol === 'http:' && loop)) return { base: set, why: '' };
    return { base: null, why: 'STUDIO_VERTEX_BASE_URL must be https (or http on 127.0.0.1): the key goes there' };
  }
  const project = String(vals[VERTEX_PROJECT_ENV] || '').trim();
  if (!project) return { base: null, why: `${VERTEX_PROJECT_ENV} is not set` };
  return { base: `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/global/endpoints/openapi`, why: '' };
}

/** A model id as Vertex names it: `google/<model>` (aider's `openai/` dropped, a bare name prefixed). */
export const vertexId = (m) => { const s = String(m || '').trim().replace(/^openai\//, ''); return s && !s.includes('/') ? `google/${s}` : s; };
const isVertexModel = (m) => /^(google\/)?gemini[-_.]/i.test(String(m || '').trim().replace(/^openai\//, ''));
/** The model a vertex session runs: a Gemini id it was given, else STUDIO_VERTEX_MODEL, else the default (never a role's Claude model). */
export function vertexModel(m, env = process.env) {
  if (isVertexModel(m)) return vertexId(m);
  return vertexId(String(env.STUDIO_VERTEX_MODEL || '').trim() || VERTEX_DEFAULT_MODEL);
}
/** The model for a size class (model-pools.mjs sizeClass: small | normal | hard). */
export const vertexModelFor = (size, env = process.env) => (size === 'hard' ? vertexId(String(env.STUDIO_VERTEX_HARD_MODEL || '').trim() || VERTEX_HARD_MODEL) : vertexModel(null, env));
export const vertexPort = (env = process.env) => { const p = Math.round(num(env.STUDIO_VERTEX_PROXY_PORT, VERTEX_PORT_DEFAULT)); return p > 0 && p < 65536 ? p : VERTEX_PORT_DEFAULT; };
export const proxyBase = (env = process.env) => `http://127.0.0.1:${vertexPort(env)}/v1`;
export const sessionKey = (agent) => `session-${String(agent || 'unknown')}`;
export const vertexShare = (env = process.env) => Math.max(0, Math.min(1, num(env.STUDIO_VERTEX_SHARE, VERTEX_SHARE_DEFAULT)));

// ---- usage ----
export const usageFile = (root = studioRoot()) => path.join(root, USAGE_REL);
/** The usage lines (parsed), oldest first; since: ms, only lines at or after it. */
export function readUsage({ root = studioRoot(), since = 0 } = {}) {
  let text = '';
  try { text = fs.readFileSync(usageFile(root), 'utf8'); } catch { return []; }
  const out = [];
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try { const j = JSON.parse(l); if (!since || (Date.parse(j.ts) || 0) >= since) out.push(j); } catch {}
  }
  return out;
}
/**
 * 2.79.2 (a): STUDIO_VERTEX_MAX_PROMPT_TOKENS (150000): a vertex request over this many prompt tokens means the session's
 * context is out of hand (the crew's sessions sent 438k-520k per request, $0.22-0.40 each). The proxy answers that
 * session's next request with 403, and the launcher stops it and hands its task back (cause prompt-cap). 0 = no cap.
 */
export const VERTEX_MAX_PROMPT_DEFAULT = 150000;
export const promptCap = (env = process.env) => { const n = Math.round(num(env.STUDIO_VERTEX_MAX_PROMPT_TOKENS, VERTEX_MAX_PROMPT_DEFAULT)); return n >= 0 ? n : VERTEX_MAX_PROMPT_DEFAULT; };
/** The session's first proxy request over the cap since it started: { over: true, in, cap, why } or { over: false }. */
export function overPromptCap(agent, { root = studioRoot(), since = 0, cap = promptCap() } = {}) {
  if (!(cap > 0)) return { over: false };
  const hit = readUsage({ root, since }).find((u) => u.session === String(agent || '') && (Number(u.in) || 0) > cap);
  return hit ? { over: true, in: Number(hit.in), cap, why: `a request sent ${Number(hit.in).toLocaleString('en-US')} prompt tokens, over STUDIO_VERTEX_MAX_PROMPT_TOKENS=${cap.toLocaleString('en-US')} (its context is too big: repo map or large files)` } : { over: false };
}

/** What one session used through the proxy since its start: { requests, tokensIn, tokensOut, costUsd, models }. */
export function sessionUsage(agent, { root = studioRoot(), since = 0 } = {}) {
  const tag = String(agent || '');
  const mine = readUsage({ root, since }).filter((u) => u.session === tag);
  const r = { requests: mine.length, tokensIn: 0, tokensOut: 0, costUsd: 0, models: [] };
  for (const u of mine) { r.tokensIn += Number(u.in) || 0; r.tokensOut += Number(u.out) || 0; r.costUsd += Number(u.usd) || 0; if (u.model && !r.models.includes(u.model)) r.models.push(u.model); }
  r.costUsd = Math.round(r.costUsd * 10000) / 10000;
  return r;
}

// ---- the proxy process ----
/** GET the health path: { ours, pid, root } or { ours: false, listening } (never throws). */
export function proxyHealth(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: HEALTH_PATH, timeout: timeoutMs }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { const j = JSON.parse(b); resolve(j?.studio === 'vertex-proxy' ? { ours: true, listening: true, pid: j.pid, root: j.root } : { ours: false, listening: true }); } catch { resolve({ ours: false, listening: true }); } });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ours: false, listening: true, timeout: true }); });
    req.on('error', () => resolve({ ours: false, listening: false }));
  });
}
const sameRoot = (a, b) => { const n = (p) => { try { p = fs.realpathSync.native(p); } catch { p = path.resolve(String(p)); } return process.platform === 'win32' ? p.toLowerCase() : p; }; return n(a) === n(b); };

/**
 * The proxy for this studio, started when it isn't listening: { ok, started, why }. Detached (it outlives the launcher),
 * with no window, its pid in .studio/vertex-proxy.json; `npm run studio:stop` stops it (stopProxy). Its environment holds no
 * key: it reads the main checkout's .env on each request.
 */
export async function ensureProxy({ root = studioRoot(), env = process.env, waitMs = 6000 } = {}) {
  const port = vertexPort(env);
  const h = await proxyHealth(port);
  if (h.ours) return sameRoot(h.root, root) ? { ok: true, started: false, port, why: '' } : { ok: false, port, why: `port ${port} is the Vertex proxy of another studio (${h.root}): set STUDIO_VERTEX_PROXY_PORT to a free port` };
  if (h.listening) return { ok: false, port, why: `port ${port} is in use by another program (not the studio's Vertex proxy; an older local proxy?): stop it, or set STUDIO_VERTEX_PROXY_PORT to a free port` };
  fs.mkdirSync(path.join(root, '.studio'), { recursive: true });
  const log = fs.openSync(path.join(root, '.studio', 'vertex-proxy.log'), 'a');
  const keep = Object.fromEntries(Object.entries(env).filter(([k]) => /^(PATH|Path|PATHEXT|SystemRoot|SYSTEMROOT|TEMP|TMP|TMPDIR|HOME|USERPROFILE|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|AGENT_EVENTS_FILE)$/.test(k)));
  const child = spawn(process.execPath, [path.join(HARNESS, 'vertex-proxy.mjs'), '--root', root, '--port', String(port)], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', log, log], env: { ...keep, STUDIO_VERTEX_PROXY_PORT: String(port) } });
  child.unref();
  try { fs.closeSync(log); } catch {}
  try { fs.writeFileSync(path.join(root, PROXY_REL), `${JSON.stringify({ pid: child.pid, port, startedAt: new Date().toISOString() }, null, 2)}\n`); } catch {}
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 150));
    const x = await proxyHealth(port, 800);
    if (x.ours) return { ok: true, started: true, port, pid: child.pid, why: '' };
  }
  return { ok: false, port, why: `the Vertex proxy didn't answer on 127.0.0.1:${port} within ${Math.round(waitMs / 1000)} s (see .studio/vertex-proxy.log)` };
}

/** Stop this studio's proxy (studio:stop): only the process its health answer names, and only if it is this studio's. */
export async function stopProxy({ root = studioRoot(), env = process.env } = {}) {
  let rec = null;
  try { rec = JSON.parse(fs.readFileSync(path.join(root, PROXY_REL), 'utf8')); } catch {}
  const port = rec?.port || vertexPort(env);
  const h = await proxyHealth(port);
  if (!h.ours || !sameRoot(h.root, root)) { try { fs.rmSync(path.join(root, PROXY_REL), { force: true }); } catch {} return { stopped: false, why: h.listening ? 'not this studio\'s proxy' : 'not running' }; }
  try { process.kill(Number(h.pid), 'SIGTERM'); } catch (e) { return { stopped: false, why: e.message }; }
  try { fs.rmSync(path.join(root, PROXY_REL), { force: true }); } catch {}
  return { stopped: true, pid: h.pid, why: '' };
}

// ---- the supervisor's choice ----
/** small | normal | hard for a task (the Line Producer's tier when it has one, else the task's size). */
export function sizeOfTask(taskId, { tier = null, events = null } = {}) {
  if (tier === 'hard' || tier === 'top') return 'hard';
  if (tier === 'small' || tier === 'cheap') return 'small';
  if (tier === 'normal' || tier === 'mid') return 'normal';
  const added = (events || readRecentEvents(20000)).filter((e) => e.type === 'task.added' && e.task === taskId).pop();
  const s = Number(added?.meta?.size);
  if (Number.isFinite(s) && s > 0) return s <= 2 ? 'small' : s >= 4 ? 'hard' : 'normal';
  return 'normal';
}
/** Vertex sessions on this task handed back (ended without the task landing) since it last landed. */
export function vertexFailures(taskId, events) {
  let n = 0;
  for (const e of events) {
    if (e.task !== taskId) continue;
    if (e.type === 'task.done' || e.type === 'lane.merged' || e.type === 'task.train.landed') n = 0;
    else if (e.type === 'agent.session.end' && (e.meta?.tool === 'vertex') && (e.meta?.handed || []).some((h) => h?.task === taskId)) n += 1;
  }
  return n;
}

/**
 * Should the supervisor start this builder on Vertex? { tool: 'vertex', model, why } or { skip: why }.
 *   role: only builders; high: the plan's budget is high (every tool over its target, or the wind-down): Vertex goes before
 *   the paid API pool and takes any free slot; otherwise it takes at most STUDIO_VERTEX_SHARE of the builder slots (cap).
 *   cut: the spend budget's cut for vertex (harness/spend-budget.mjs), a reason or ''. ready: { ok, why } (configured, aider).
 */
export function vertexPick({ role, taskId, tier = null, live = [], cap = 0, high = false, env = process.env, events = null, ready = null, cut = '' } = {}) {
  if (role !== 'builder') return { skip: 'only builders run on Vertex' };
  const r = ready || vertexConfigured();
  if (!r.ok) return { skip: `vertex: ${r.why}` };
  if (cut) return { skip: `vertex: ${cut}` };
  const ev = events || readRecentEvents(20000);
  if (taskId && vertexFailures(taskId, ev) > 0) return { skip: `vertex: ${taskId} was handed back on Vertex since it last landed: the plan's route takes it` };
  const size = sizeOfTask(taskId, { tier, events: ev });
  const model = vertexModelFor(size, env);
  const running = live.filter((s) => s && s.running !== false && s.tool === 'vertex').length;
  if (high) return { tool: 'vertex', model, size, why: `the plan's budget is high: Vertex (${model}, ${size} task) before the paid API pool` };
  const share = vertexShare(env);
  const allowed = share > 0 ? Math.max(1, Math.floor(share * Math.max(0, cap))) : 0;
  if (running >= allowed) return { skip: `vertex has its share (${running} of ${allowed} builder slot${allowed === 1 ? '' : 's'}, STUDIO_VERTEX_SHARE=${share})` };
  return { tool: 'vertex', model, size, why: `Vertex's share of builder slots (${running + 1} of ${allowed}, STUDIO_VERTEX_SHARE=${share}): ${model} for a ${size} task` };
}
