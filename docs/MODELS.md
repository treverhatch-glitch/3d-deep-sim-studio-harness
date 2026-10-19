# Model IDs

`harness/models.config.mjs` is the source of truth. Override with env vars when a provider changes names.

| Provider | Default model | Override |
|----------|----------------|----------|
| NVIDIA NIM | `nvidia/llama-3.3-nemotron-super-49b-v1.5` | `NVIDIA_GLM_MODEL` |
| Groq | `llama-3.3-70b-versatile` | `GROQ_MODEL` |
| Anthropic | `claude-sonnet-4-5` | `ANTHROPIC_MODEL` |
| OpenAI | `gpt-5` | `OPENAI_MODEL` |
| xAI | `grok-3-mini` | `XAI_MODEL` |
| Ollama | `qwen2.5-coder:14b` | `OLLAMA_MODEL` |

If a default id 404s, set the env override. Do not hardcode secrets.
