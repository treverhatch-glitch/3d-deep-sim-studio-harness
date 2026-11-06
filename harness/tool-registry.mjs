#!/usr/bin/env node
/**
 * harness/tool-registry.mjs — 2.79.1 (a): tools the owner defines (studio/tools.json), treated like the built-in ones.
 *
 * The owner's ask: "let me define as I see fit": other providers and keys as harness tools, even ones the harness doesn't
 * list. An entry in studio/tools.json makes one a first-class tool: `npm run agent -- start --tool <name>` (the orchestrator
 * may launch it), the supervisor and the Line Producer (through the budget order, STUDIO_<ROLE>_TOOL, quota marks and
 * takeovers, as for STUDIO_TOOL_<NAME>_CMD), the same lane copy and checks, an environment with only its own key names, and
 * spend through the same budget code (harness/spend-budget.mjs).
 *
 *   { "tools": [ { "name": "deepseek",                 lower case; not a built-in tool's name
 *                  "command": "<launch line>",          the placeholders of STUDIO_TOOL_<NAME>_CMD: {kickoff} {agent} {model}
 *                                                       {role} {task} {mainRoot} {addDirs}; with proxy "vertex" also
 *                                                       {proxyBase} (the proxy's /v1 URL) and {sessionKey} (session-<agent>)
 *                  "provider": "DeepSeek",              a label
 *                  "keyEnv": ["DEEPSEEK_API_KEY"],      the only key names its sessions see (never STUDIO_/HUB_ names,
 *                                                       the owner key, or a key a harness proxy holds)
 *                  "models": ["deepseek-chat"],         the first is its default model
 *                  "prices": { "deepseek-chat": { "in": 0.27, "out": 1.1 } } | "studio/prices.json",   USD per 1M tokens
 *                  "roles": ["builder"],                the roles that may run on it (default builder)
 *                  "proxy": "vertex" } ] }              optional: its traffic goes through the studio's Vertex proxy
 *
 * Defining or changing a tool (its command, keys, models, prices, roles) is the OWNER's own act (harness/owner-acts.mjs
 * "tools"): the file is protected (studio/protected.json) and an approval of it made by beta mode, the owner proxy or an
 * outside signer is refused (harness/approve.mjs). What counts is the file as committed in the main checkout (HEAD):
 *   - with an owner key (studio/keys/owner-ed25519.pub.pem at HEAD): only when an approval signed with that key (an
 *     approval file in studio/approvals/ with a signature, kind protected or tools) records exactly its contents;
 *   - with no owner key yet: only when the commit that last set it is a person's (no Studio-Agent trailer), as for the
 *     owner's delegation (harness/delegation.mjs): a speed bump until the owner key exists.
 * An entry that doesn't count is not launched, and `npm run tools` says why. STUDIO_TOOL_<NAME>_CMD in .env works as before
 * and wins over an entry of the same name. Budgets are not in this file: npm run budget -- set <name> <usd> (not owner-only).
 *
 *   npm run tools [-- list | check | --json]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { STUDIO_STATE_DIR } from './event.mjs';
import { canonicalBytes } from './hash.mjs';

export const TOOLS_REL = 'studio/tools.json';
export const BUILTIN_TOOLS = Object.freeze(['claude', 'codex', 'agy', 'cursor', 'grok', 'aider', 'nim', 'vertex', 'custom', 'gemini', 'outside']);
const OWNER_PUB_REL = 'studio/keys/owner-ed25519.pub.pem';
const KEY_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
const KEY_NEVER = /^(STUDIO_|HUB_|AGENT_|NODE_|npm_|PLAYWRIGHT_|PATH$|HOME$)/;
const HELD = ['VERTEX_API_KEY', 'STUDIO_OWNER_KEY', 'HUB_TOKEN'];
const root0 = () => path.dirname(STUDIO_STATE_DIR);
const git = (root, ...args) => spawnSync('git', args, { windowsHide: true, cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const lf = (t) => String(t).replace(/\r\n/g, '\n');
export const contentHash = (text) => crypto.createHash('sha256').update(Buffer.from(lf(text), 'utf8')).digest('hex');

/** Entries from the file's text: { tools: [entry], errors: [line] }. Invalid entries are left out, with the reason. */
export function parseRegistry(text) {
  let j;
  try { j = JSON.parse(text); } catch { return { tools: [], errors: [`${TOOLS_REL} isn't valid JSON`] }; }
  const list = Array.isArray(j?.tools) ? j.tools : j?.tools && typeof j.tools === 'object' ? Object.entries(j.tools).map(([name, v]) => ({ name, ...v })) : [];
  const tools = [];
  const errors = [];
  const seen = new Set();
  for (const e of list) {
    const name = String(e?.name || '').trim();
    const bad = [];
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(name)) bad.push('a name of 2-31 lower-case letters, digits or -');
    else if (BUILTIN_TOOLS.includes(name)) bad.push(`"${name}" is a built-in tool's name`);
    else if (seen.has(name)) bad.push('named twice');
    if (typeof e?.command !== 'string' || !e.command.trim()) bad.push('a command');
    const keys = Array.isArray(e?.keyEnv) ? e.keyEnv.map(String) : [];
    for (const k of keys) if (!KEY_NAME.test(k) || KEY_NEVER.test(k) || HELD.includes(k)) bad.push(`keyEnv "${KEY_NAME.test(k) ? k : '(not a name)'}" isn't a key name a session may see`);
    const roles = Array.isArray(e?.roles) && e.roles.length ? e.roles.map((r) => String(r).toLowerCase()) : ['builder'];
    if (e?.proxy !== undefined && e.proxy !== null && e.proxy !== 'vertex') bad.push('proxy is "vertex" or nothing');
    if (e?.prices !== undefined && !(typeof e.prices === 'string' || (e.prices && typeof e.prices === 'object'))) bad.push('prices is a table or "studio/prices.json"');
    if (bad.length) { errors.push(`${name || '(no name)'}: left out: ${bad.join('; ')}`); continue; }
    seen.add(name);
    tools.push({ name, command: e.command.trim(), provider: String(e.provider || name).slice(0, 60), keyEnv: keys, models: Array.isArray(e.models) ? e.models.map(String) : [], prices: e.prices ?? null, roles, proxy: e.proxy || null });
  }
  return { tools, errors };
}

/** Is this committed content the owner's? { ok, by, why }. */
function trusted(root, text) {
  const pubShow = git(root, 'show', `HEAD:${OWNER_PUB_REL}`);
  const pub = pubShow.status === 0 && /BEGIN PUBLIC KEY/.test(pubShow.stdout) ? pubShow.stdout : null;
  if (pub) {
    const want = contentHash(text);
    const dir = path.join(root, 'studio', 'approvals');
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch {}
    for (const f of files) {
      let doc;
      try { doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      // Only a signature by the owner key counts: never a beta-mode or owner-proxy record (no signature).
      if (!doc?.signature || doc.beta || doc.proxy || !['protected', 'tools'].includes(doc.approval?.kind)) continue;
      if (!(doc.approval.files || []).some((x) => x?.path === TOOLS_REL && x.sha256 === want)) continue;
      try { if (crypto.verify(null, Buffer.from(canonicalBytes(doc.approval)), crypto.createPublicKey(pub), Buffer.from(String(doc.signature), 'base64'))) return { ok: true, by: `the owner's signed approval (studio/approvals/${f})`, why: '' }; } catch {}
    }
    return { ok: false, why: `this studio has an owner key and no approval signed with it records ${TOOLS_REL} as committed (the owner signs it: npm run approve -- protected, on the owner's own device)` };
  }
  const log = git(root, 'log', '-1', '--format=%H%x09%(trailers:key=Studio-Agent,valueonly,separator=%x2C)', 'HEAD', '--', TOOLS_REL);
  const [sha = '', agent = ''] = String(log.stdout || '').trim().split('\t');
  if (!sha) return { ok: false, why: `the commit that set ${TOOLS_REL} wasn't found` };
  if (agent.trim()) return { ok: false, why: `commit ${sha.slice(0, 8)} that set ${TOOLS_REL} is the agent ${agent.trim()}'s (Studio-Agent trailer): only the owner defines tools, from their own terminal` };
  return { ok: true, by: `a person's commit ${sha.slice(0, 8)} (no owner key yet)`, why: '' };
}

let cache = null;
/** The registry as it counts now: { tools: { name: entry }, trusted, why, errors, note }. Cached 15 s per root. */
export function readRegistry({ root = root0(), fresh = false } = {}) {
  if (!fresh && cache && cache.root === root && Date.now() - cache.at < 15000) return cache.r;
  const r = readRegistryNow(root);
  cache = { root, at: Date.now(), r };
  return r;
}
function readRegistryNow(root) {
  const workFile = path.join(root, TOOLS_REL);
  const work = fs.existsSync(workFile) ? fs.readFileSync(workFile, 'utf8') : null;
  const isGit = git(root, 'rev-parse', '--verify', 'HEAD').status === 0;
  const shown = isGit ? git(root, 'show', `HEAD:${TOOLS_REL}`) : null;
  const text = shown && shown.status === 0 ? shown.stdout : null;
  if (text === null) return { tools: {}, trusted: false, errors: [], why: work !== null ? `${TOOLS_REL} isn't committed in the main checkout: it counts once the owner commits it` : `no ${TOOLS_REL}`, note: '' };
  const p = parseRegistry(text);
  const t = trusted(root, text);
  const note = work !== null && lf(work) !== lf(text) ? `the working copy of ${TOOLS_REL} differs from the committed one, which is what counts` : '';
  return { tools: t.ok ? Object.fromEntries(p.tools.map((x) => [x.name, x])) : {}, listed: p.tools.map((x) => x.name), trusted: t.ok, by: t.by || null, errors: p.errors, why: t.why, note };
}
/** The entry for a tool name when the registry counts, else null. */
export const registeredTool = (name, opts) => (name && !BUILTIN_TOOLS.includes(String(name).toLowerCase()) && /^[a-z][a-z0-9-]{1,30}$/i.test(String(name)) ? readRegistry(opts).tools[String(name).toLowerCase()] || null : null);

/** The price row for a session on a registered tool (its own table; "studio/prices.json" or none: null, the studio's table). */
export function registryPrice(entry, model) {
  if (!entry || !entry.prices || typeof entry.prices !== 'object') return null;
  return entry.prices[model] || entry.prices[String(model || '').replace(/^[^/]+\//, '')] || entry.prices[entry.models[0]] || null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'list';
  if (cmd === 'pause' || cmd === 'resume' || cmd === 'budget') {
    console.log('Budgets are set with npm run budget: npm run budget -- set <tool or key> <usd> | resume <name> | clear <name> --by <who> --why "<the owner\'s order>".');
    process.exit(cmd === 'budget' ? 0 : 1);
  }
  if (!['list', 'check', 'status'].includes(cmd) && !argv.includes('--json')) { console.log('Usage: npm run tools [-- list | check] [--json]   (owner-defined tools: studio/tools.json, docs/AGENT-TOOLS.md)'); process.exit(1); }
  const r = readRegistry({ fresh: true });
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }
  const vx = await import('./vertex.mjs');
  const c = vx.vertexConfigured();
  console.log(`Built-in: claude, codex, agy, cursor, grok, aider, nim, vertex (${c.ok ? `configured; proxy ${vx.proxyBase()}` : c.why}).`);
  console.log(`${TOOLS_REL}: ${r.trusted ? `counts (${r.by})` : `doesn't count: ${r.why}`}.${r.note ? ` Note: ${r.note}.` : ''}`);
  for (const t of Object.values(r.tools)) console.log(`  ${t.name}: ${t.provider}; roles ${t.roles.join(', ')}; keys ${t.keyEnv.join(', ') || 'none'}; models ${t.models.join(', ') || '(the role\'s)'}${t.proxy ? `; through the ${t.proxy} proxy` : ''}`);
  if (!r.trusted && r.listed?.length) console.log(`  listed but not launched: ${r.listed.join(', ')}`);
  for (const e of r.errors) console.log(`  problem: ${e}`);
  process.exit(cmd === 'check' && (r.errors.length || (r.listed?.length && !r.trusted)) ? 1 : 0);
}
