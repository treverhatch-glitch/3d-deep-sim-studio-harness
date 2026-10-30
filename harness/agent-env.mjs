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
 *     names, codex: OPENAI_ and CODEX_, grok: XAI_ and GROK_, agy: GEMINI_ and GOOGLE_, cursor: CURSOR_, aider: OLLAMA_),
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
};
const roleKey = (role) => String(role || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_');

const FAMILY = [[/^(claude|anthropic)/i, 'claude'], [/^(gpt|o\d|codex|openai)/i, 'codex'], [/^(grok|xai)/i, 'grok'], [/^(gemini|google)/i, 'gemini'], [/^(qwen|llama|ollama|deepseek)/i, 'aider']];

/** The environment a launched agent gets. extra: values the launcher sets for this session. A custom
 * launcher's credentials follow its model's family (a gemini-3.1-pro model gets the GEMINI_ and GOOGLE_ names). */
export function agentEnv({ tool = null, role = null, model = null, extra = {}, env = process.env } = {}) {
  if (/^full$/i.test(env.STUDIO_AGENT_ENV || '')) return { ...env, ...extra };
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
  return { ...out, ...extra };
}

/** Names the launcher held back from an agent (for the log; values never printed). */
export function heldBack(args) {
  const kept = agentEnv(args);
  const env = args?.env || process.env;
  return Object.keys(env).filter((k) => !(k in kept));
}
