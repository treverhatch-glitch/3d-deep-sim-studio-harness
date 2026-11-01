/**
 * harness/agent-env.mjs — 2.33.0: what a launched agent's process may see of the environment.
 *
 * Before, every agent got the launcher's whole environment, so every key in .env (other providers' API
 * keys, HUB_TOKEN that writes to the War Room, GitHub tokens, the owner key's path) was one `env` away
 * from any agent and from anything a prompt injection made it run. Now an agent gets:
 *   - the system basics (PATH, HOME, locale, temp, proxy and certificate settings, display),
 *   - the studio's own settings (STUDIO_, AGENT_, PLAYTEST_, PLAYWRIGHT_, NODE_, npm_ names), minus
 *     STUDIO_OWNER_KEY,
 *   - the credentials of the tool it runs on and nothing else (claude: ANTHROPIC_ and CLAUDE_
 *     names, codex: OPENAI_ and CODEX_, grok: XAI_ and GROK_, agy: GEMINI_ and GOOGLE_, cursor: CURSOR_, aider: OLLAMA_;
 *     nim (2.58.3, aider on NVIDIA NIM): only OPENAI_API_KEY, set from NVIDIA_API_KEY (the first key of a list, else
 *     NVIDIA_API_KEY_2), never the owner's own OPENAI_ names, which would go to NVIDIA's endpoint; H-8 (2.58.5): also
 *     AIDER_OPENAI_API_KEY, the same key, because aider loads .env files (home, repo, current folder; a lane copy has a
 *     copy of the studio's .env) over the environment, and the template's empty `OPENAI_API_KEY=` blanked the key,
 *     while aider applies AIDER_OPENAI_API_KEY (its --openai-api-key) after those files),
 *     (a custom launcher gets its model family's: a gemini model gets GEMINI_ and GOOGLE_, a grok model XAI_ and GROK_),
 *   - names listed in STUDIO_AGENT_ENV_PASS (comma-separated, for every agent) or STUDIO_<ROLE>_ENV
 *     (for one role; a custom launcher lists what its command needs here).
 * STUDIO_AGENT_ENV=full gives the old behaviour (everything).
 */
const BASICS = /^(PATH|Path|PATHEXT|HOME|USER|USERNAME|LOGNAME|SHELL|TERM|COLORTERM|LANG|LANGUAGE|LC_[A-Z]+|TZ|TMP|TEMP|TMPDIR|PWD|SystemRoot|SystemDrive|ComSpec|WINDIR|windir|OS|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|APPDATA|LOCALAPPDATA|USERPROFILE|HOMEDRIVE|HOMEPATH|ProgramFiles|ProgramFiles\(x86\)|ProgramData|CommonProgramFiles|PUBLIC|XDG_[A-Z_]+|DISPLAY|WAYLAND_DISPLAY|DBUS_SESSION_BUS_ADDRESS|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|ALL_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|REQUESTS_CA_BUNDLE|CI|GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL)|EDITOR|VISUAL)$/;
const STUDIO = /^(STUDIO_|AGENT_|PLAYTEST_|PLAYWRIGHT_|NODE_|npm_|GODOT|BLENDER)/;
const NEVER = /^(STUDIO_OWNER_KEY|HUB_TOKEN)$/;
const TOOL_KEYS = {
  claude: /^(ANTHROPIC_|CLAUDE_)/,
  codex: /^(OPENAI_|CODEX_)/,
  grok: /^(XAI_|GROK_)/,
  agy: /^(GEMINI_|GOOGLE_)/,
  gemini: /^(GEMINI_|GOOGLE_)/,
  cursor: /^CURSOR_/,
  aider: /^OLLAMA_/,
  nim: /(?!)/, // nothing by prefix: nimMapped() below sets OPENAI_API_KEY alone
};
const roleKey = (role) => String(role || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_');

const FAMILY = [[/^(claude|anthropic)/i, 'claude'], [/^(gpt|o\d|codex|openai)/i, 'codex'], [/^(grok|xai)/i, 'grok'], [/^(gemini|google)/i, 'gemini'], [/^(qwen|llama|ollama|deepseek)/i, 'aider']];

/** The environment a launched agent gets. extra: values the launcher sets for this session. A custom
 * launcher's credentials follow its model's family (a gemini-3.1-pro model gets the GEMINI_ and GOOGLE_ names). */
export function agentEnv({ tool = null, role = null, model = null, extra = {}, env = process.env } = {}) {
  if (/^full$/i.test(env.STUDIO_AGENT_ENV || '')) return nimMapped({ ...env, ...extra }, String(tool || '').toLowerCase(), env);
  const pass = new Set([...String(env.STUDIO_AGENT_ENV_PASS || '').split(','), ...String(env[`STUDIO_${roleKey(role)}_ENV`] || '').split(',')].map((s) => s.trim()).filter(Boolean));
  let t = String(tool || '').toLowerCase();
  if (!TOOL_KEYS[t] && model) t = (FAMILY.find(([re]) => re.test(String(model))) || [])[1] || t;
  const toolRe = TOOL_KEYS[t] || null;
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (NEVER.test(k) && !pass.has(k)) continue;
    if (BASICS.test(k) || STUDIO.test(k) || pass.has(k) || (toolRe && toolRe.test(k))) out[k] = v;
  }
  return nimMapped({ ...out, ...extra }, t, env);
}

/**
 * H-1 (2.58.5): the NIM model a `nim` session runs when neither --model nor STUDIO_NIM_MODEL names one. The 2.58.3
 * default (qwen/qwen3-coder-480b-a35b-instruct) answered 410 Gone (end of life 2026-06-11). UNVERIFIED from here: taken
 * from NIM's public model list as the crew read it on 2026-11-01 (moonshotai/kimi-k2.6, deepseek-ai/deepseek-v4.1-flash,
 * z-ai/glm-5.3-flash); check `npm run models:check` and set STUDIO_NIM_MODEL.
 */
export const NIM_DEFAULT_MODEL = 'moonshotai/kimi-k2.6';
/** A NIM model id is `<org>/<model>` (an `openai/` prefix, aider's provider, is dropped). */
export const isNimModelId = (m) => /^[\w.-]+\/[\w.:+-]+$/.test(String(m || '').trim().replace(/^openai\//, ''));
/**
 * The model a `nim` session runs. H-1: never a role's or Claude's model: without --model the launcher passed the role
 * model (STUDIO_BUILDER_MODEL=claude-sonnet-5-5), and aider asked NIM for openai/claude-sonnet-5-5. So a model that
 * isn't a NIM id (`<org>/<model>`) gives way to STUDIO_NIM_MODEL, else NIM_DEFAULT_MODEL.
 */
export function nimModel(m, env = process.env) {
  const own = String(m || '').trim().replace(/^openai\//, '');
  if (isNimModelId(own)) return own;
  return String(env.STUDIO_NIM_MODEL || '').trim().replace(/^openai\//, '') || NIM_DEFAULT_MODEL;
}

/** M4 (2.58.3): the NIM key a `nim` session uses: NVIDIA_API_KEY (first of a comma-separated list), else NVIDIA_API_KEY_2. */
export function nimKey(env = process.env) {
  for (const k of ['NVIDIA_API_KEY', 'NVIDIA_API_KEY_2']) {
    const v = String(env[k] || '').split(',').map((x) => x.trim()).find(Boolean);
    if (v) return v;
  }
  return null;
}
/**
 * A `nim` child's environment: aider reads OPENAI_API_KEY for an openai/ model, so it is the NIM key or nothing.
 * H-8 (2.58.5): any OPENAI_ or AIDER_OPENAI_ name in any letter case goes first (on Windows `OpenAI_Api_Key` and
 * `OPENAI_API_KEY` are one variable, and which of two the child sees is up to the OS), then the key is set twice:
 * OPENAI_API_KEY, and AIDER_OPENAI_API_KEY, which aider applies after loading .env files that would otherwise blank it.
 */
function nimMapped(out, tool, env) {
  if (tool !== 'nim') return out;
  for (const k of Object.keys(out)) if (/^(AIDER_)?OPENAI_/i.test(k)) delete out[k];
  const key = nimKey(env);
  if (key) {
    out.OPENAI_API_KEY = key;
    out.AIDER_OPENAI_API_KEY = key;
  }
  return out;
}
/** True when a `nim` child's environment (agentEnv's result) has no key to use. */
export const nimKeyMissing = (childEnv = {}) => !childEnv.OPENAI_API_KEY;

/** Names the launcher held back from an agent (for the log; values never printed). */
export function heldBack(args) {
  const kept = agentEnv(args);
  const env = args?.env || process.env;
  return Object.keys(env).filter((k) => !(k in kept));
}
