# Model IDs

`harness/models.config.mjs` is the source of truth. Override with env vars instead of editing IDs by hand.

| Provider | Default model | Override |
|----------|----------------|----------|
| NVIDIA NIM | `nvidia/llama-3.3-nemotron-super-49b-v1` | `NVIDIA_GLM_MODEL` |
| Groq | `llama-3.3-70b-versatile` | `GROQ_MODEL` |
| Anthropic | `claude-sonnet-4-20250514` | `ANTHROPIC_MODEL` |
| OpenAI | `gpt-4.1` | `OPENAI_MODEL` |
| xAI | `grok-3-mini` | `XAI_MODEL` |
| Ollama | `qwen2.5-coder:14b` | `OLLAMA_MODEL` |

Docs that say “GLM 5.3 Flash” mean the NVIDIA free-tier slot. Set `NVIDIA_GLM_MODEL` to the exact id you want.
