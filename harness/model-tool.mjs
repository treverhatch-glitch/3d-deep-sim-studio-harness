/**
 * harness/model-tool.mjs — 2.84 (w): which tool runs a model id, in ONE place.
 *
 * A crew's reviewer route picked a Vertex model (google/gemini-...) for a cross-family review and launched it on the
 * `claude` tool: the supervisor passes its preferred tool to every start, and the reviewer step changed the tool only when
 * none was given, and its own lookup (agent.mjs modelFamilyTool) knew no `google/` id anyway. Claude refused the model
 * (exit 1) four times, and the supervisor halted twice. Now every launch that takes a model from a route asks toolForModel,
 * and a launch whose tool cannot run its model is refused before a process starts (toolMismatch).
 *
 * toolForModel(model) looks, in order:
 *   1. studio/models.json pools (harness/model-pools.mjs readModels/poolOf): a pool names its tool;
 *   2. the studio's own settings (the environment, then the main checkout's .env, model settings only): a `<tool>:<model>`
 *      entry (STUDIO_REVIEW_TOOLS, STUDIO_*_MODELS), STUDIO_TOOL_<TOOL>_MODEL, STUDIO_VERTEX_MODEL / STUDIO_VERTEX_HARD_MODEL;
 *   3. the id's shape: google/... or vertex/... -> vertex; agy-... or a bare gemini-... (models/gemini-...) -> agy;
 *      gpt-..., o1/o3/o4..., codex-... -> codex; claude-..., opus, sonnet, haiku -> claude.
 * Anything else: { tool: null, why } (one line saying no tool is known for it).
 *
 * TOOL_CAPABILITIES: what a tool's session can do. runsCommands false for the aider-driven tools (vertex, aider, nim): such
 * a session only suggests commands, so it cannot act as a reviewer (`npm run review -- record` is a command). A review
 * planned on one of them is asked by the harness itself instead (harness/review-ask.mjs, `npm run review -- ask`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseStudioEnv } from './dotenv.mjs';

export const TOOL_CAPABILITIES = Object.freeze({
  claude: { runsCommands: true },
  codex: { runsCommands: true },
  agy: { runsCommands: true },
  gemini: { runsCommands: true },
  grok: { runsCommands: true },
  cursor: { runsCommands: true },
  hermes: { runsCommands: true },
  custom: { runsCommands: true },
  vertex: { runsCommands: false },
  aider: { runsCommands: false },
  nim: { runsCommands: false },
});
/** A tool's capabilities ({ runsCommands }); a tool not listed (an owner-defined one) is taken to run commands. */
export const toolCapabilities = (tool) => TOOL_CAPABILITIES[String(tool || '').toLowerCase()] || { runsCommands: true };

// The tools whose model space is known, so a model of another of them is a mismatch they cannot run.
const STRICT = new Set(['claude', 'codex', 'agy', 'vertex']);
const TOOL_WORD = /^(claude|codex|agy|gemini|grok|custom|nim|vertex|aider|cursor|hermes)$/i;
const norm = (m) => String(m || '').trim().replace(/^models\//i, '').toLowerCase();
const vx = (m) => { const s = norm(m).replace(/^openai\//, ''); return s && !s.includes('/') ? `google/${s}` : s; };

/** The tool an id's shape names, or null. */
export function toolByShape(model) {
  const s = norm(model).replace(/^openai\/(?=google\/)/, '');
  if (!s || s === 'unknown') return null;
  if (/^(google|vertex|vertex_ai)\//.test(s)) return 'vertex';
  if (/^agy[-_]/.test(s) || /^gemini[-_.]/.test(s)) return 'agy';
  if (/^(gpt[-_.]|codex[-_]|o[134](?:$|[-_]))/.test(s)) return 'codex';
  if (/^(claude[-_]|claude$|opus\b|sonnet\b|haiku\b|anthropic\/)/.test(s)) return 'claude';
  return null;
}

/** The model settings (names and values only) of the main checkout's .env; nothing else in that file is kept. */
function envFileSettings(root) {
  if (!root) return {};
  let text = '';
  try { text = fs.readFileSync(path.join(root, '.env'), 'utf8'); } catch { return {}; }
  const all = parseStudioEnv(text);
  const keep = {};
  for (const k of Object.keys(all)) if (/^STUDIO_[A-Z0-9_]*MODELS?$/.test(k) || k === 'STUDIO_REVIEW_TOOLS' || k === 'STUDIO_REVIEWER_TOOL') keep[k] = all[k];
  return keep;
}

/** The tool a studio setting pins this model to, with the setting's name, or null. */
function toolBySetting(model, settings) {
  const want = norm(model);
  if (!want) return null;
  for (const k of Object.keys(settings).sort()) {
    const v = String(settings[k] ?? '');
    if (k === 'STUDIO_VERTEX_MODEL' || k === 'STUDIO_VERTEX_HARD_MODEL') { if (v.trim() && vx(v) === vx(want)) return { tool: 'vertex', where: k }; continue; }
    const tm = k.match(/^STUDIO_TOOL_([A-Z0-9]+)_MODEL$/);
    if (tm && TOOL_WORD.test(tm[1]) && norm(v) === want) return { tool: tm[1].toLowerCase(), where: k };
    if (!/^STUDIO_[A-Z0-9_]*MODELS?$/.test(k) && k !== 'STUDIO_REVIEW_TOOLS') continue;
    for (const raw of v.split(',')) {
      const i = raw.indexOf(':');
      if (i <= 0) continue;
      const tool = raw.slice(0, i).trim();
      if (TOOL_WORD.test(tool) && norm(raw.slice(i + 1)) === want) return { tool: tool.toLowerCase(), where: k };
    }
  }
  return null;
}

/**
 * Which tool runs this model id: { tool, from: 'pool'|'setting'|'shape', why } or { tool: null, why }.
 * opts.models: a readModels() result (else read from root when given); opts.env: the environment; opts.root: the main
 * checkout (its .env and studio/models.json).
 */
export function toolForModel(model, { env = process.env, root = null, models = null } = {}) {
  const m = String(model || '').trim();
  if (!m || m === 'unknown') return { tool: null, from: null, why: 'no model was named, so no tool can be chosen for it' };
  let cfg = models;
  if (!cfg && root) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(root, 'studio', 'models.json'), 'utf8'));
      cfg = j && typeof j === 'object' ? j : null;
    } catch { cfg = null; }
  }
  for (const [name, p] of Object.entries(cfg?.pools || {})) {
    if (!p || !p.tool || !p.model || p.off === true) continue;
    if (norm(p.model) === norm(m) || (String(p.tool).toLowerCase() === 'vertex' && vx(p.model) === vx(m) && /\//.test(m))) return { tool: String(p.tool).toLowerCase(), from: 'pool', why: `the pool ${name} in studio/models.json runs ${p.model} on ${p.tool}` };
  }
  const s = toolBySetting(m, env || {}) || toolBySetting(m, envFileSettings(root));
  if (s) return { tool: s.tool, from: 'setting', why: `${s.where} names ${m} for ${s.tool}` };
  const shape = toolByShape(m);
  if (shape) return { tool: shape, from: 'shape', why: `${m} is a ${shape === 'vertex' ? 'Vertex (google/...)' : shape === 'agy' ? 'Gemini CLI (agy)' : shape === 'codex' ? 'OpenAI (codex)' : 'Claude'} model id` };
  return { tool: null, from: null, why: `no tool is known to run ${m}: name it in a studio/models.json pool (with its tool), or as <tool>:${m} in the studio's settings` };
}

/**
 * The one line that refuses a launch whose tool cannot run its model, or ''. Only for the tools whose model space is known
 * (claude, codex, agy, vertex) and a model whose tool is known and is another of them. agy's own override (forced: its
 * --force-model, STUDIO_AGY_ANY_MODEL, an agy:<model> budget entry) lets agy run any model, as before.
 */
export function toolMismatch({ tool, model, forced = false, env = process.env, root = null, models = null } = {}) {
  const t = String(tool || '').toLowerCase();
  if (!STRICT.has(t)) return '';
  if (t === 'agy' && forced) return '';
  const need = toolForModel(model, { env, root, models });
  if (!need.tool || need.tool === t || !STRICT.has(need.tool)) return '';
  return `Not started: ${model} runs on the ${need.tool} tool, not ${t} (${need.why}): start it with --tool ${need.tool}.`;
}
