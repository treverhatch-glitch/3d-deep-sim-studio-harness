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
 * 2.59.0 (#14): an owner-set key mapping per role or agent (STUDIO_KEYMAP_<ROLE>, STUDIO_KEYMAP_AGENT_<NAME>): see keyMapped().
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HARNESS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
export function agentEnv({ tool = null, role = null, model = null, agent = null, extra = {}, env = process.env, notes = null } = {}) {
  if (/^full$/i.test(env.STUDIO_AGENT_ENV || '')) return keyMapped(nimMapped({ ...env, ...extra }, String(tool || '').toLowerCase(), env), { role, agent, tool: String(tool || '').toLowerCase(), env, notes });
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
  return keyMapped(nimMapped({ ...out, ...extra }, t, env), { role, agent, tool: t, env, notes });
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

/**
 * 2.59.0: a name that is an agent's, not a person's: the harness's role, tool and model words (builder-s3, claude-a,
 * opus-bot), a name a launched session used (.studio/agents/<name>.json), or one the launcher hands out
 * (.studio/agent-names.json counters: builder-s<n>). Empty counts as an agent's (nobody said who).
 */
export const AGENTISH = /^(prod|producer|director|builder|rnd|qa|qa-playtester|playtester|reviewer|planner|art|artist|liaison|scout|designer|balancer|agent|watch|supervisor|launcher|unknown|codex|claude|gemini|agy|gpt|grok|opus|sonnet|haiku|cursor|aider|hermes|nim|dev-hacker|sound|composer|writer)\b/i;
export function agentLikeName(name, { stateDir = path.join(HARNESS_ROOT, '.studio') } = {}) {
  const who = String(name || '').trim();
  if (!who || AGENTISH.test(who)) return true;
  if (/^[\w.-]+$/.test(who) && fs.existsSync(path.join(stateDir, 'agents', `${who}.json`))) return true;
  let counters = {};
  try { counters = JSON.parse(fs.readFileSync(path.join(stateDir, 'agent-names.json'), 'utf8')) || {}; } catch {}
  return Object.keys(counters).some((k) => new RegExp(`^${k.replace(/[^\w-]/g, '').replace(/-/g, '\\-')}\\d+$`, 'i').test(who));
}
/**
 * 2.59.0: why this process runs on an agent's behalf, or null: inside a session the launcher started (it sets
 * STUDIO_ROLE), or in a shell whose STUDIO_LOCK_OWNER is an agent's name (an agent working by hand, AGENTS.md).
 */
export function launchedSession(env = process.env) {
  const role = String(env.STUDIO_ROLE || '').trim();
  if (role) return `this runs inside a launched ${role} session (STUDIO_ROLE is set)`;
  const owner = String(env.STUDIO_LOCK_OWNER || '').trim();
  if (owner && AGENTISH.test(owner)) return `this runs in an agent's shell (STUDIO_LOCK_OWNER=${owner})`;
  return null;
}

/**
 * 2.59.0 (#14, planned in 2.58.5 P-092): the owner's per-agent key mapping. STUDIO_KEYMAP_<ROLE> and
 * STUDIO_KEYMAP_AGENT_<NAME> (NAME as the agent's name in capitals, `-` as `_`: STUDIO_KEYMAP_AGENT_BUILDER_S3) hold
 * `TARGET:SOURCE[,TARGET:SOURCE]`: that one child gets SOURCE's value under the name TARGET (for example
 * `ANTHROPIC_API_KEY:ANTHROPIC_API_KEY_LANE`, so one lane bills to its own key). For the same TARGET the agent's
 * mapping beats the role's. Both names must be key names (…_API_KEY or …_TOKEN, capitals, an optional suffix such as
 * _LANE or _2), never STUDIO_, HUB_ (HUB_TOKEN writes to the War Room) or the owner key. SOURCE unset or empty: TARGET
 * is left unset for that child (never quietly the shared key). Inside a launched session (an agent hiring an agent) a
 * mapping counts only as written in the studio's .env: one set in the session's shell is refused. Names go to `notes`
 * (the launcher's log); values never do, and text that isn't a name is never echoed (a pasted key stays unprinted).
 * The STUDIO_KEYMAP_ settings themselves are not passed to the child.
 */
export const KEY_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:API_KEY|TOKEN)(?:_[A-Z0-9]+)*$/;
const KEY_NEVER = /^(STUDIO_|HUB_|AGENT_|NODE_|npm_)/;
export const keyNameOk = (n) => KEY_NAME.test(String(n || '')) && !KEY_NEVER.test(n) && !NEVER.test(n);
// A refused entry is echoed only when it is plainly a variable's name: key-shaped (…_API_KEY, …_TOKEN), a system or
// studio setting (PATH, STUDIO_…, HUB_…), or a variable that exists. A key pasted by mistake is never printed.
const shownIn = (env) => (x) => {
  const t = String(x || '');
  const named = t.length <= 64 && (KEY_NAME.test(t) || BASICS.test(t) || /^(STUDIO|HUB|AGENT)_[A-Z0-9_]+$/.test(t) || (/^[A-Za-z_]\w*$/.test(t) && Object.prototype.hasOwnProperty.call(env, t)));
  return named ? t : '(not a name; not shown)';
};

/** The STUDIO_KEYMAP_ lines of the studio's .env (the main checkout's): the last non-empty one for a name wins. */
function keymapsInDotEnv(env) {
  const root = String(env.STUDIO_MAIN_ROOT || '').trim() ? path.resolve(env.STUDIO_MAIN_ROOT) : HARNESS_ROOT;
  const found = {};
  let text = '';
  try { text = fs.readFileSync(path.join(root, '.env'), 'utf8'); } catch { return found; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?(STUDIO_KEYMAP_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const v = m[2].replace(/^['"]|['"]$/g, '');
    if (v !== '' || !(m[1] in found)) found[m[1]] = v;
  }
  return found;
}

/** The mapping for one child: { pairs: [{ target, source, from }], refused: [line] } (names only). */
export function keymapFor({ role = null, agent = null, env = process.env } = {}) {
  const vars = [role ? `STUDIO_KEYMAP_${roleKey(role)}` : null, agent ? `STUDIO_KEYMAP_AGENT_${roleKey(agent)}` : null].filter(Boolean);
  const inSession = launchedSession(env);
  const fromFile = inSession ? keymapsInDotEnv(env) : null;
  const byTarget = new Map();
  const refused = [];
  const shown = shownIn(env);
  for (const v of vars) {
    const raw = String(env[v] ?? '').trim();
    if (!raw) continue;
    if (inSession && String(fromFile[v] ?? '').trim() !== raw) {
      refused.push(`${v}: refused, ${inSession}, and the studio's .env doesn't set it so; the owner sets key mappings in .env or the shell that starts the supervisor`);
      continue;
    }
    for (const part of raw.split(',').map((x) => x.trim()).filter(Boolean)) {
      const m = part.match(/^([^:\s]+)\s*:\s*([^:\s]+)$/);
      if (!m) { refused.push(`${v}: refused an entry that isn't TARGET:SOURCE (${shown(part)})`); continue; }
      const [, target, source] = m;
      const bad = [target, source].filter((n) => !keyNameOk(n));
      if (bad.length) { refused.push(`${v}: refused ${shown(target)}:${shown(source)}: ${bad.map(shown).join(' and ')} ${bad.length > 1 ? "aren't key names" : "isn't a key name"} (…_API_KEY or …_TOKEN, not STUDIO_/HUB_ or the owner key)`); continue; }
      byTarget.set(target, { target, source, from: v });
    }
  }
  return { pairs: [...byTarget.values()], refused };
}

function keyMapped(out, { role, agent, tool, env, notes }) {
  for (const k of Object.keys(out)) if (/^STUDIO_KEYMAP_/i.test(k)) delete out[k];
  const { pairs, refused } = keymapFor({ role, agent, env });
  const say = (line) => { if (Array.isArray(notes)) notes.push(line); };
  for (const r of refused) say(`key map ${r}`);
  for (const { target, source, from } of pairs) {
    const value = String(env[source] ?? '');
    // nim: aider applies AIDER_OPENAI_API_KEY after the .env files it loads (H-8), so the mapped key goes there too.
    const names = tool === 'nim' && target === 'OPENAI_API_KEY' ? [target, 'AIDER_OPENAI_API_KEY'] : [target];
    if (!value.trim()) {
      for (const n of names) delete out[n];
      say(`key map ${from}: ${source} is not set, so ${names.join(' and ')} ${names.length > 1 ? 'are' : 'is'} left unset for this session (not the shared key)`);
      continue;
    }
    for (const n of names) out[n] = value;
    say(`key map ${from}: ${names.join(' and ')} ${names.length > 1 ? 'get' : 'gets'} the value of ${source} (value not shown)`);
  }
  return out;
}
