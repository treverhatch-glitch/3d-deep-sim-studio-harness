/**
 * harness/secrets.mjs — key-shaped strings, shared by the secret scan and anything that exports data.
 * Length-anchored so provider ids such as "xai-grok-4" or "sk-ant" in docs do not match.
 */
export const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{20,}/, // OpenAI legacy, DeepSeek, many others
  /sk-(proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/, // OpenAI project / service keys
  /sk-ant-[A-Za-z0-9_-]{20,}/, // Anthropic
  /sk-or-v1-[A-Za-z0-9]{20,}/, // OpenRouter
  /sk_live_[A-Za-z0-9]{16,}/, // Stripe
  /rk_live_[A-Za-z0-9]{16,}/,
  /nvapi-[A-Za-z0-9_-]{20,}/, // NVIDIA NIM
  /gsk_[A-Za-z0-9]{20,}/, // Groq
  /xai-[A-Za-z0-9]{20,}/, // xAI
  /AIza[0-9A-Za-z_-]{30,}/, // Google API key
  /ya29\.[0-9A-Za-z_-]{20,}/, // Google OAuth access token
  /AKIA[0-9A-Z]{16}/, // AWS access key id
  /gh[pousr]_[A-Za-z0-9]{30,}/, // GitHub tokens
  /github_pat_[A-Za-z0-9_]{20,}/,
  /glpat-[A-Za-z0-9_-]{16,}/, // GitLab
  /xox[abposr]-[A-Za-z0-9-]{20,}/, // Slack
  /hf_[A-Za-z0-9]{20,}/, // Hugging Face
  /r8_[A-Za-z0-9]{20,}/, // Replicate
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export const hasSecret = (text) => SECRET_PATTERNS.some((re) => re.test(String(text)));

/** Replace every key-shaped string (and private key blocks) with [removed]; returns { text, hits }. */
export function scrub(text) {
  let hits = 0;
  let out = String(text ?? '').replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, () => {
    hits += 1;
    return '[removed]';
  });
  for (const re of SECRET_PATTERNS) {
    out = out.replace(new RegExp(re.source, 'g'), () => {
      hits += 1;
      return '[removed]';
    });
  }
  return { text: out, hits };
}
