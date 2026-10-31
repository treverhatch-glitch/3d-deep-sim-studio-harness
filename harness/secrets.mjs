/**
 * harness/secrets.mjs — what counts as a secret, shared by the secret scan (scripts/secret-scan.mjs) and by
 * scrub(), which cleans trajectory exports and review diffs. PU-33: one list for both, so they can't drift.
 *
 *   - provider key shapes (OpenAI, Anthropic, xAI, GitHub, AWS key ids, ...), length-anchored so provider ids
 *     such as "xai-grok-4" or "sk-ant" in docs do not match;
 *   - PU-18 (P-040): Discord bot tokens and webhook URLs, Slack webhooks and app/refresh tokens, Telegram bot
 *     tokens, AWS secret access keys and session tokens next to their names;
 *   - a long random-looking value given to a name ending in TOKEN, SECRET, SECRET_KEY, API_KEY, APIKEY,
 *     PRIVATE_KEY, PASSWORD or WEBHOOK(_URL). Placeholders and word-built values never count;
 *   - any of the token shapes above hidden in base64 (a whole quoted or assigned value of 40-400 characters).
 */

// Provider shapes: [pattern, kind]. SECRET_PATTERNS (below) is the same list without the kinds.
const PROVIDERS = [
  [/sk-[A-Za-z0-9]{20,}/, 'openai-style-key'], // OpenAI legacy, DeepSeek, many others
  [/sk-(proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/, 'openai-key'], // OpenAI project / service keys
  [/sk-ant-[A-Za-z0-9_-]{20,}/, 'anthropic-key'],
  [/sk-or-v1-[A-Za-z0-9]{20,}/, 'openrouter-key'],
  [/sk_live_[A-Za-z0-9]{16,}/, 'stripe-key'],
  [/rk_live_[A-Za-z0-9]{16,}/, 'stripe-key'],
  [/nvapi-[A-Za-z0-9_-]{20,}/, 'nvidia-key'],
  [/gsk_[A-Za-z0-9]{20,}/, 'groq-key'],
  [/xai-[A-Za-z0-9]{20,}/, 'xai-key'],
  [/AIza[0-9A-Za-z_-]{30,}/, 'google-api-key'],
  [/ya29\.[0-9A-Za-z_-]{20,}/, 'google-oauth-token'],
  [/AKIA[0-9A-Z]{16}/, 'aws-access-key-id'],
  [/gh[pousr]_[A-Za-z0-9]{30,}/, 'github-token'],
  [/github_pat_[A-Za-z0-9_]{20,}/, 'github-token'],
  [/glpat-[A-Za-z0-9_-]{16,}/, 'gitlab-token'],
  [/xox[abposr]-[A-Za-z0-9-]{20,}/, 'slack-token'],
  [/hf_[A-Za-z0-9]{20,}/, 'huggingface-token'],
  [/r8_[A-Za-z0-9]{20,}/, 'replicate-token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private-key'],
];
export const SECRET_PATTERNS = PROVIDERS.map(([re]) => re);
const SHARED = PROVIDERS.map(([re, kind]) => ({ re: new RegExp(re.source, 'g'), kind }));

// 2.43.0: a key-shaped match glued inside a longer run of base64 characters is a piece of encoded data (an
// image pack, a font), not a key: "AKIA" plus 16 capitals turns up by chance in a few hundred KB of base64.
// A real key stands on its own (quotes, =, space or a line edge around it).
const B64 = /[A-Za-z0-9+/]/;
function gluedInBase64(text, at, len) {
  const before = text[at - 1] || '';
  const after = text[at + len] || '';
  return B64.test(before) && (B64.test(after) || after === '=');
}

// Filler: one character over and over, or a provider's docs sample ("XXXX…", "0000…", "your-…").
const FILLER = /(.)\1{7,}|x{4,}|\*{3,}|your|example|sample|dummy|fake|placeholder|redacted|changeme|change[-_]me/i;
const filler = (s) => FILLER.test(s);
const mixed = (s) => /[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s);
// A Discord bot token's first part is the bot's numeric id in base64.
const discordId = (s) => /^\d{17,21}$/.test(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('latin1'));

// PU-18 (P-040): shapes the provider list doesn't know. Each stands on its own (lookarounds), so a lookalike
// piece of a long base64 run never counts; `ok` throws out docs samples and filler. `value` (when set) is the
// capture group that holds the secret, so scrub() keeps the name in front of it.
const SHAPES = [
  {
    kind: 'discord-bot-token',
    re: /(?<![A-Za-z0-9_.-])([MNO][A-Za-z0-9_-]{22,27})\.([A-Za-z0-9_-]{6,7})\.([A-Za-z0-9_-]{27,40})(?![A-Za-z0-9_-]|\.[A-Za-z0-9_-])/g,
    ok: (m) => (discordId(m[1]) || mixed(m[0])) && !filler(m[3]),
  },
  {
    kind: 'discord-webhook-url',
    re: /https?:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api(?:\/v\d{1,2})?\/webhooks\/\d{15,22}\/([A-Za-z0-9_-]{50,100})/g,
    ok: (m) => !filler(m[1]),
  },
  {
    kind: 'slack-webhook-url',
    re: /https?:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/(T[A-Za-z0-9]{6,14})\/([A-Za-z0-9]{6,14})\/([A-Za-z0-9_-]{16,}(?:\/[A-Za-z0-9_-]+)*)/g,
    ok: (m) => !filler(m[3]) && !(/^T0+$/.test(m[1]) && /^[A-Z]0+$/.test(m[2])),
  },
  { kind: 'slack-app-token', re: /(?<![A-Za-z0-9])xapp-\d-[A-Za-z0-9-]{20,}/g, ok: (m) => !filler(m[0]) },
  { kind: 'slack-token', re: /(?<![A-Za-z0-9])xoxe(?:\.xox[bp])?-\d-[A-Za-z0-9-]{20,}/g, ok: (m) => !filler(m[0]) },
  {
    kind: 'telegram-bot-token',
    // On its own, or in the Bot API address (…/bot<token>/sendMessage).
    re: /(?:(?<=\/bot)|(?<![A-Za-z0-9_:-]))\d{8,10}:(AA[A-Za-z0-9_-]{33})(?![A-Za-z0-9_-])/g,
    ok: (m) => !filler(m[1]),
  },
  {
    kind: 'aws-secret-access-key',
    re: /(?<![A-Za-z0-9])(?:aws[_-]?secret[_-]?(?:access[_-]?)?key|secret[_-]?access[_-]?key)["']?[ \t]*(?::=|=>|[:=])[ \t]*["']?([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+=])/gi,
    ok: (m) => !filler(m[1]) && /[A-Za-z]/.test(m[1]) && /[0-9/+]/.test(m[1]),
    value: 1,
  },
  {
    kind: 'aws-session-token',
    re: /(?<![A-Za-z0-9])(?:aws[_-]?session[_-]?token|aws[_-]?security[_-]?token|session[_-]?token)["']?[ \t]*(?::=|=>|[:=])[ \t]*["']?([A-Za-z0-9/+=]{100,})/gi,
    ok: (m) => !filler(m[1]) && mixed(m[1]),
    value: 1,
  },
];

// --- Named secrets: KEY=value, "key": "value", key: value, key = "value" -----------------------------------
const NAMED = /(token|secret|secret[_.-]?key|api[_.-]?key|private[_.-]?key|password|passwd|webhook(?:[_.-]?url)?)(["'`]?)[ \t]*(:=|=>|=(?!=)|:(?!:))[ \t]*/gi;
const NAME_CHAR = /[A-Za-z0-9_.$-]/;
// Where an unquoted value may stand: an env/YAML/TOML/INI line that starts with the name (commented out too, a
// YAML list item, a Dockerfile ENV/ARG), or a --flag=value.
const LINE_LEAD = /^[ \t]*(?:(?:#+|\/\/|;)[ \t]*)?(?:export[ \t]+|set[ \t]+|env[ \t]+|arg[ \t]+|-[ \t]+|\$env:)?$/i;
// In source code a literal secret is quoted; a bare value there is an identifier (x = module.SomeClass768Key).
const CODE = /\.(?:py|pyi|js|mjs|cjs|jsx|ts|tsx|mts|cts|rb|go|java|kt|kts|cs|php|rs|swift|c|cc|h|hh|cpp|hpp|m|scala|lua|gd|dart|vue|svelte)$/i;
const PLACEHOLDER = /^$|<[^>]*>|^\[.*\]$|^\{.*\}$|\$\{|\$\(|^\$|^%[^%]+%$|\{\{|process\.env|import\.meta|os\.environ|getenv|^env[.:(]|secrets\.|^vars\.|your|example|sample|dummy|fake|test|placeholder|changeme|change[-_]me|replace|insert|here|redacted|x{4,}|\*{3,}|todo|^(?:tbd|none|null|undefined)\b/i;

function entropy(s) {
  const n = {};
  for (const ch of s) n[ch] = (n[ch] || 0) + 1;
  let h = 0;
  for (const k in n) {
    const p = n[k] / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** How much of `v` is made of words: kebab/snake/path segments that are words, or lowercase runs. */
function wordy(v) {
  const segs = v.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const total = segs.join('').length || 1;
  let inWords = 0;
  if (segs.length > 1) for (const s of segs) if (/^(?:[a-z]{3,}|[A-Z]{3,}|[A-Z][a-z]{2,}|\d{1,4})$/.test(s)) inWords += s.length;
  let lower = 0;
  for (const m of v.matchAll(/[a-z]{4,}/g)) lower += m[0].length;
  return Math.max(inWords / total, lower / v.length);
}

/** A value a person or a key generator made, not a name, a path, a sentence or a sequence. */
function looksRandom(v) {
  if (v.length < 24 || v.length > 1000 || /\s/.test(v)) return false;
  if (!/[A-Za-z]/.test(v)) return false;
  if (/^(.{1,8})\1+.{0,8}$/.test(v)) return false; // a short unit repeated
  let steps = 0;
  for (let i = 1; i < v.length; i += 1) if (v.charCodeAt(i) - v.charCodeAt(i - 1) === 1) steps += 1;
  if (steps / v.length > 0.4) return false; // abcdef…, 123456…
  const h = entropy(v);
  const w = wordy(v);
  if (h < 2.8 || w >= 0.6) return false;
  if (/\d/.test(v)) return true;
  return /[a-z]/.test(v) && /[A-Z]/.test(v) && h >= 3.8 && w < 0.35;
}

function namedSecrets(text, add, code) {
  NAMED.lastIndex = 0;
  for (let m; (m = NAMED.exec(text)); ) {
    let start = m.index;
    while (start > 0 && m.index - start < 120 && NAME_CHAR.test(text[start - 1])) start -= 1;
    const name = text.slice(start, m.index + m[1].length);
    const at = m.index + m[0].length;
    const q = text[at];
    let value;
    let from = at;
    if (q === '"' || q === "'" || q === '`') {
      const close = text.indexOf(q, at + 1);
      const nl = text.indexOf('\n', at + 1);
      if (close < 0 || (nl >= 0 && nl < close)) continue;
      value = text.slice(at + 1, close);
      from = at + 1;
    } else {
      if (code || m[3] === '=>') continue;
      const lead = text.slice(text.lastIndexOf('\n', start - 1) + 1, start);
      if (!LINE_LEAD.test(lead) && !name.startsWith('-')) continue;
      const v = /^[^\s"'`,;#(){}[\]<>]+/.exec(text.slice(at, at + 1001));
      if (!v) continue;
      const next = text[at + v[0].length];
      if (next !== undefined && !/[\s#,;]/.test(next)) continue; // an expression (a call, an index), not a value
      value = v[0];
    }
    if (PLACEHOLDER.test(value)) continue;
    let secret;
    if (/:\/\//.test(value)) {
      // A webhook address carries its secret in the path or query; any other address is just an address.
      if (!/webhook/i.test(m[1])) continue;
      secret = value.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '').split(/[/?&=#]/).some(looksRandom);
    } else secret = looksRandom(value);
    if (secret) add(from, value.length, `named-secret (${name.replace(/^[-$]+/, '').split('.').pop().slice(0, 40)})`);
  }
}

// --- Tokens wrapped in base64 -------------------------------------------------------------------------------
// A whole quoted value, or a whole assigned value, of 40-400 base64 characters. A run inside a longer run never
// matches (the lookarounds), so image packs and fonts are not decoded.
const WRAPPED = [
  /(["'`])([A-Za-z0-9+/_-]{40,400}={0,2})\1/g,
  /[:=][ \t]*()([A-Za-z0-9+/_-]{40,400}={0,2})(?![A-Za-z0-9+/_=-])/g,
];
function wrappedSecrets(text, add) {
  for (const re of WRAPPED) {
    re.lastIndex = 0;
    for (let m; (m = re.exec(text)); ) {
      const at = m.index + m[0].indexOf(m[2]);
      if (/base64,$/i.test(text.slice(Math.max(0, at - 7), at))) continue; // a data: URI
      const bytes = Buffer.from(m[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      if (bytes.length < 20) continue;
      let printable = 0;
      for (const b of bytes) if ((b >= 0x20 && b < 0x7f) || b === 9 || b === 10 || b === 13) printable += 1;
      if (printable / bytes.length < 0.95) continue;
      const inner = new Set();
      tokens(bytes.toString('latin1'), (_i, _n, kind) => inner.add(kind), false);
      for (const kind of inner) add(at, m[2].length, `${kind} (base64)`);
    }
  }
}

/** Every token-shaped string in `text`: the provider shapes, then the PU-18 ones. Calls add(index, length, kind). */
function tokens(text, add, glued) {
  for (const { re, kind } of SHARED) {
    re.lastIndex = 0;
    for (let m; (m = re.exec(text)); ) {
      if (!m[0]) { re.lastIndex += 1; continue; }
      if (glued || !gluedInBase64(text, m.index, m[0].length)) add(m.index, m[0].length, kind);
    }
  }
  for (const { re, kind, ok, value } of SHAPES) {
    re.lastIndex = 0;
    for (let m; (m = re.exec(text)); ) {
      if (!ok(m)) continue;
      // The value group ends the match (the AWS shapes), so it sits at the end of m[0].
      if (value) add(m.index + m[0].length - m[value].length, m[value].length, kind);
      else add(m.index, m[0].length, kind);
    }
  }
}

/**
 * Every secret in `text`: [{ index, length, kind }], in the order found (overlaps possible).
 * `path` (a file's name) tells source code apart: there an unquoted value is an identifier, never a secret.
 * `glued: true` also returns provider shapes glued inside a longer base64 run (scrub() removes those too).
 */
export function findSecrets(text, { path = '', glued = false } = {}) {
  const s = String(text ?? '');
  const out = [];
  const add = (index, length, kind) => out.push({ index, length, kind });
  tokens(s, add, glued);
  namedSecrets(s, add, CODE.test(path));
  wrappedSecrets(s, add);
  return out;
}

export const hasSecret = (text) => findSecrets(text).length > 0;

/**
 * Replace every secret the scan would report (and private key blocks, and provider shapes inside base64 runs)
 * with [removed]; returns { text, hits }. A named secret keeps its name: `JWT_SECRET=[removed]`.
 */
export function scrub(text) {
  let hits = 0;
  const s = String(text ?? '').replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, () => {
    hits += 1;
    return '[removed]';
  });
  const spans = findSecrets(s, { glued: true }).map((f) => [f.index, f.index + f.length]).sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [];
  for (const [a, b] of spans) {
    const last = merged[merged.length - 1];
    if (last && a < last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  if (!merged.length) return { text: s, hits };
  let out = '';
  let at = 0;
  for (const [a, b] of merged) {
    out += `${s.slice(at, a)}[removed]`;
    at = b;
  }
  return { text: out + s.slice(at), hits: hits + merged.length };
}
