#!/usr/bin/env bash
# scripts/secret-scan.sh [root] [--staged] — fail if a key-shaped string would be committed.
#
# In a git checkout it scans exactly what git would publish: tracked files plus untracked files
# that are not ignored. Your own .env (ignored) never trips it, so private clones stay green.
# --staged scans only staged files (used by the pre-commit hook). Outside git it scans the folder.
set -euo pipefail
ROOT="."
STAGED=0
for arg in "$@"; do
  case "$arg" in
    --staged) STAGED=1 ;;
    *) ROOT="$arg" ;;
  esac
done
cd "$ROOT"

# Length-anchored so provider ids such as "xai-grok-4" or "sk-ant" in docs do not match.
PATTERNS=(
  'sk-[A-Za-z0-9]{20,}'                       # OpenAI legacy, DeepSeek, many others
  'sk-(proj|svcacct|admin)-[A-Za-z0-9_-]{20,}' # OpenAI project / service keys
  'sk-ant-[A-Za-z0-9_-]{20,}'                 # Anthropic
  'sk-or-v1-[A-Za-z0-9]{20,}'                 # OpenRouter
  'sk_live_[A-Za-z0-9]{16,}'                  # Stripe
  'rk_live_[A-Za-z0-9]{16,}'
  'nvapi-[A-Za-z0-9_-]{20,}'                  # NVIDIA NIM
  'gsk_[A-Za-z0-9]{20,}'                      # Groq
  'xai-[A-Za-z0-9]{20,}'                      # xAI
  'AIza[0-9A-Za-z_-]{30,}'                    # Google API key
  'ya29\.[0-9A-Za-z_-]{20,}'                  # Google OAuth access token
  'AKIA[0-9A-Z]{16}'                          # AWS access key id
  'gh[pousr]_[A-Za-z0-9]{30,}'                # GitHub tokens
  'github_pat_[A-Za-z0-9_]{20,}'
  'glpat-[A-Za-z0-9_-]{16,}'                  # GitLab
  'xox[abposr]-[A-Za-z0-9-]{20,}'             # Slack
  'hf_[A-Za-z0-9]{20,}'                       # Hugging Face
  'r8_[A-Za-z0-9]{20,}'                       # Replicate
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
)
JOINED=$(printf '%s|' "${PATTERNS[@]}" | sed 's/[[:space:]]*#[^|]*//g; s/|$//')

list_files() {
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if [ "$STAGED" -eq 1 ]; then
      git diff --cached --name-only --diff-filter=ACMR -z
    else
      git ls-files -z --cached --others --exclude-standard
    fi
  else
    find . -type f -not -path './.git/*' -not -path '*/node_modules/*' -print0
  fi
}

OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT
count=0
while IFS= read -r -d '' file; do
  [ -f "$file" ] || continue
  case "$file" in
    */secret-scan.sh|secret-scan.sh|*.lock|package-lock.json) continue ;;
  esac
  count=$((count + 1))
  grep -HnIE -e "$JOINED" -- "$file" >>"$OUT" 2>/dev/null || true
done < <(list_files)

if [ -s "$OUT" ]; then
  echo "[secrets] FAIL key-shaped string(s) found (values hidden):"
  sed -E 's/^([^:]+:[0-9]+):.*/  \1/' "$OUT" | sort -u
  echo "[secrets] Move real keys to .env (gitignored). If one was ever committed, rotate it."
  exit 1
fi
echo "[secrets] PASS — ${count} file(s) scanned"
