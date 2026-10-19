# Secrets & API Key Hygiene (`docs/SECRETS.md`)

This repository is a **public open-source template**. It must remain **100% free of real API keys, tokens, or credentials** at all times.

---

## 1. Golden Rules

1. **Never Commit `.env`**:
   - Put all real keys in `.env` (which is ignored by [`.gitignore`](../.gitignore)).
   - Keep [`.env.example`](../.env.example) populated with **blank** keys (`KEY=`) and helpful comments only.
2. **Never Hardcode Keys in Scripts or Configs**:
   - Always read keys from `process.env.<KEY_NAME>` inside `harness/models.config.mjs` and `harness/route.mjs`.
3. **Keep `.studio/usage.json` Safe to Share**:
   - `.studio/usage.json` tracks numeric quota usage (`used`, `limit`, `resetAt`) and provider display names—never store API tokens inside `.studio/usage.json` or `.studio/war-room.config.json`.

---

## 2. Pre-Push Secret Scan One-Liner

Before pushing to a public remote, run:

```bash
git grep -E "(ghp_[A-Za-z0-9]{10,}|sk-[A-Za-z0-9]{10,}|AIza[A-Za-z0-9_-]{10,}|nvapi-[A-Za-z0-9_-]{10,}|gsk_[A-Za-z0-9]{10,}|r8_[A-Za-z0-9]{10,}|msy_[A-Za-z0-9]{10,})" -- .
```

If this command returns **no matches** (exit code `1`), the working tree is clean of common API token patterns.
