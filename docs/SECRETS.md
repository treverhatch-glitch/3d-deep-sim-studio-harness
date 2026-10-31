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

## 2. Pre-Push Secret Scan

The real check is `node scripts/secret-scan.mjs`: the `secrets` gate runs it in verify over the files and every commit not on
the base branch yet (lines added and messages), and the pre-commit hook runs it with `--staged` on what is staged (the index,
not the file on disk). Besides the provider key shapes it catches Discord bot tokens and webhooks, Slack webhooks and tokens,
Telegram bot tokens, AWS secret keys and session tokens, long random values under names ending in TOKEN, SECRET, API_KEY,
PASSWORD or WEBHOOK, and those token shapes wrapped in base64, in UTF-8 and UTF-16 (BOM) files. It prints file, line, kind
and, for history, the commit, never the value; placeholders pass. A key that reached a commit must be rotated and taken out
of the commit before pushing: cleaning the file is not enough.

### A false alarm: the owner's allowlist (`studio/secrets-allow.json`)

Each finding prints the sha256 of its value (`sha256:<64 hex>`), never the value. When a finding is **not a key** (a test
fixture, an id that only looks like a token) and it is in a commit that can't be rewritten (pushed, and there is no
force-push), the owner can allow that one finding:

```json
{ "allow": [
  { "commit": "abc1234", "path": "game/z/fixture.txt", "line": 1, "kind": "github-token",
    "fingerprint": "<the sha256 the scan printed>", "reason": "a fixture id that only looks like a token", "by": "owner" }
] }
```

- A finding is allowed when path, kind and fingerprint match, and the commit when the entry names one (a short or full
  sha; `"*"` for the files, not history; left out, anywhere). `line` is for people; lines move. The scan reports it as
  `allowed (reason)` and doesn't fail. The failing scan prints a ready entry for its first finding.
- The file is protected (`studio/protected.json`): an entry lands only with the owner's signed approval
  (`npm run approve -- protected`), so an agent can't allow its own secret.
- **Only for a true false alarm.** A real token is rotated at the provider, never allowed: allowing it leaves a live
  key in a public repo.
What it catches and what it doesn't: [`docs/SECURITY.md`](SECURITY.md#secrets).

A quick manual check for the most common provider prefixes, before pushing to a public remote:

```bash
git grep -E "(ghp_[A-Za-z0-9]{10,}|sk-[A-Za-z0-9]{10,}|AIza[A-Za-z0-9_-]{10,}|nvapi-[A-Za-z0-9_-]{10,}|gsk_[A-Za-z0-9]{10,}|r8_[A-Za-z0-9]{10,}|msy_[A-Za-z0-9]{10,})" -- .
```

If this command returns **no matches** (exit code `1`), the working tree is clean of common API token patterns.
