/**
 * harness/models.config.mjs — Plug-and-Play Multi-Model Provider Chains
 *
 * Implements the `freecc:auto` pattern from UltraGameStudio adapted into a
 * zero-server Node module:
 *  - Every provider is optional and configured via environment variables.
 *  - Each studio role maps to an ordered failover chain (`freecc:auto`).
 *  - On HTTP 429 / 5xx / quota exhaustion, `harness/route.mjs` cools the channel
 *    down for >= 30 seconds and immediately tries the next channel in the chain.
 *  - The Executive Producer head agent is 100% swappable via `STUDIO_PRODUCER_PRESET`
 *    (`grok`, `claude`, `gemini`, `openai`, `cursor`, `ollama`, or `auto`).
 */

export const COOLDOWN_DEFAULTS = {
  rateLimitMs: 30_000,      // 30s minimum cooldown on HTTP 429
  serverErrorMs: 45_000,    // 45s cooldown on HTTP 5xx / network error
  quotaExhaustedMs: 300_000,// 5m cooldown on hard quota exhaustion
  requestTimeoutMs: 60_000, // Per-channel timeout before failing over
};

/**
 * Provider endpoint registry.
 * Almost all providers expose an OpenAI-compatible `/chat/completions` endpoint;
 * Anthropic uses its native `/v1/messages` format (handled transparently by `route.mjs`).
 */
export const PROVIDERS = {
  'vertex-gemini-pro': {
    id: 'vertex-gemini-pro',
    label: 'Vertex AI Gemini 2.5 Pro',
    tier: 'credit-free',
    protocol: 'gemini-openai',
    model: 'gemini-2.5-pro',
    envKeys: ['GEMINI_API_KEY', 'VERTEX_ACCESS_TOKEN'],
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  },
  'vertex-gemini-flash': {
    id: 'vertex-gemini-flash',
    label: 'Vertex / Gemini 2.5 Flash',
    tier: 'free',
    protocol: 'gemini-openai',
    model: 'gemini-2.5-flash',
    envKeys: ['GEMINI_API_KEY', 'VERTEX_ACCESS_TOKEN'],
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  },
  'nvidia-glm-flash': {
    id: 'nvidia-glm-flash',
    label: 'NVIDIA NIM (free-tier GLM / Nemotron)',
    tier: 'free',
    protocol: 'openai',
    model: process.env.NVIDIA_GLM_MODEL || 'nvidia/llama-3.3-nemotron-super-49b-v1.5',
    envKeys: ['NVIDIA_API_KEY', 'NVIDIA_API_KEY_2'],
    baseUrl: 'https://integrate.api.nvidia.com/v1',
  },
  'nvidia-nemotron-ultra': {
    id: 'nvidia-nemotron-ultra',
    label: 'NVIDIA NIM (Nemotron Ultra 253B)',
    tier: 'free',
    protocol: 'openai',
    model: process.env.NVIDIA_ULTRA_MODEL || 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
    envKeys: ['NVIDIA_API_KEY', 'NVIDIA_API_KEY_2'],
    baseUrl: 'https://integrate.api.nvidia.com/v1',
  },
  'groq-llama-70b': {
    id: 'groq-llama-70b',
    label: 'Groq (Llama 3.3 70B Versatile)',
    tier: 'free',
    protocol: 'openai',
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    envKeys: ['GROQ_API_KEY', 'GROQ_API_KEY_2'],
    baseUrl: 'https://api.groq.com/openai/v1',
  },
  'openrouter-free': {
    id: 'openrouter-free',
    label: 'OpenRouter (Free Router Channel)',
    tier: 'free',
    protocol: 'openai',
    model: process.env.OPENROUTER_FREE_MODEL || 'openrouter/free',
    envKeys: ['OPENROUTER_API_KEY'],
    baseUrl: 'https://openrouter.ai/api/v1',
    extraHeaders: {
      'HTTP-Referer': 'https://github.com/treverhatch-glitch/hatchfield-ai-studio-template',
      'X-Title': '3D Deep-Sim AI Studio Harness',
    },
  },
  'xai-grok': {
    id: 'xai-grok',
    label: 'xAI Grok (Executive Producer Option)',
    tier: 'byok',
    protocol: 'openai',
    model: process.env.XAI_MODEL || 'grok-3-mini',
    envKeys: ['XAI_API_KEY'],
    baseUrl: 'https://api.x.ai/v1',
  },
  'anthropic-claude': {
    id: 'anthropic-claude',
    label: 'Anthropic Claude Sonnet',
    tier: 'byok',
    protocol: 'anthropic',
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
    envKeys: ['ANTHROPIC_API_KEY'],
    baseUrl: 'https://api.anthropic.com/v1',
  },
  'openai-gpt': {
    id: 'openai-gpt',
    label: 'OpenAI GPT-4.1 / o4-mini',
    tier: 'byok',
    protocol: 'openai',
    model: process.env.OPENAI_MODEL || 'gpt-5',
    envKeys: ['OPENAI_API_KEY'],
    baseUrl: 'https://api.openai.com/v1',
  },
  'ollama-local': {
    id: 'ollama-local',
    label: 'Local Ollama Worker (Offline $0)',
    tier: 'local',
    protocol: 'ollama',
    model: process.env.OLLAMA_MODEL || 'qwen2.5-coder:14b',
    envKeys: [],
    baseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1',
  },
};

/**
 * Swappable Executive Producer presets.
 * Users can set `STUDIO_PRODUCER_PRESET=grok|claude|gemini|openai|ollama|auto`.
 */
export const PRODUCER_PRESET_CHAINS = {
  auto: [
    'vertex-gemini-pro',
    'xai-grok',
    'nvidia-nemotron-ultra',
    'groq-llama-70b',
    'openrouter-free',
    'anthropic-claude',
    'openai-gpt',
    'ollama-local',
  ],
  grok: [
    'xai-grok',
    'vertex-gemini-pro',
    'nvidia-nemotron-ultra',
    'groq-llama-70b',
    'openrouter-free',
    'ollama-local',
  ],
  gemini: [
    'vertex-gemini-pro',
    'vertex-gemini-flash',
    'nvidia-nemotron-ultra',
    'groq-llama-70b',
    'ollama-local',
  ],
  claude: [
    'anthropic-claude',
    'vertex-gemini-pro',
    'nvidia-nemotron-ultra',
    'groq-llama-70b',
    'ollama-local',
  ],
  openai: [
    'openai-gpt',
    'vertex-gemini-pro',
    'nvidia-nemotron-ultra',
    'groq-llama-70b',
    'ollama-local',
  ],
  ollama: [
    'ollama-local',
    'vertex-gemini-flash',
    'nvidia-glm-flash',
    'groq-llama-70b',
  ],
};

/**
 * Default role chains (`freecc:auto`).
 * Any custom role created in `studio/roles/<slug>.md` can either specify its
 * own `modelChain` in YAML frontmatter or inherit `ROLE_CHAINS.default`.
 */
export const ROLE_CHAINS = {
  producer: PRODUCER_PRESET_CHAINS[process.env.STUDIO_PRODUCER_PRESET || 'auto'] || PRODUCER_PRESET_CHAINS.auto,
  'designer-calibrator': [
    'vertex-gemini-pro',
    'nvidia-nemotron-ultra',
    'groq-llama-70b',
    'openrouter-free',
    'xai-grok',
    'anthropic-claude',
    'ollama-local',
  ],
  builder: [
    'vertex-gemini-pro',
    'nvidia-nemotron-ultra',
    'nvidia-glm-flash',
    'groq-llama-70b',
    'openrouter-free',
    'anthropic-claude',
    'openai-gpt',
    'ollama-local',
  ],
  'qa-playtester': [
    'vertex-gemini-flash',
    'nvidia-glm-flash',
    'groq-llama-70b',
    'openrouter-free',
    'ollama-local',
  ],
  reviewer: [
    'vertex-gemini-pro',
    'nvidia-nemotron-ultra',
    'xai-grok',
    'anthropic-claude',
    'groq-llama-70b',
    'openrouter-free',
    'ollama-local',
  ],
  default: [
    'vertex-gemini-flash',
    'nvidia-glm-flash',
    'groq-llama-70b',
    'openrouter-free',
    'ollama-local',
  ],
};

export function getChainForRole(role = 'default', customChain = null) {
  if (Array.isArray(customChain) && customChain.length > 0) {
    return customChain;
  }
  if (role === 'producer') {
    const preset = (process.env.STUDIO_PRODUCER_PRESET || 'auto').toLowerCase();
    return PRODUCER_PRESET_CHAINS[preset] || PRODUCER_PRESET_CHAINS.auto;
  }
  return ROLE_CHAINS[role] || ROLE_CHAINS.default;
}
