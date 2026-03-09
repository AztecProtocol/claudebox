#!/usr/bin/env bash
# Ensures raw token env var access only occurs in libcreds and libcreds-host packages.
# Run: ./scripts/check-token-isolation.sh
# Exits 0 if clean, 1 with violations listed.
#
# Lines with "libcreds-exempt" comment are allowed (e.g., sync git clone needing raw token).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Only credential tokens — NOT app-internal secrets (API_SECRET, SESSION_PASS).
PATTERNS=(
  GH_TOKEN
  SLACK_BOT_TOKEN
  LINEAR_API_KEY
)

# Build a single grep pattern: process\.env\.(GH_TOKEN|SLACK_BOT_TOKEN|...)
JOINED=$(IFS='|'; echo "${PATTERNS[*]}")
GREP_PATTERN="process\.env\.(${JOINED})"

violations=0

while IFS= read -r file; do
  # Get path relative to repo root
  relpath="${file#"$REPO_ROOT"/}"

  # Allow: packages/libcreds/ and packages/libcreds-host/
  case "$relpath" in
    packages/libcreds/*|packages/libcreds-host/*) continue ;;
  esac

  # Skip node_modules, .git, and test files
  case "$relpath" in
    node_modules/*|.git/*|tests/*) continue ;;
  esac

  # Search for violations in this file (excluding libcreds-exempt lines)
  if grep -nE "$GREP_PATTERN" "$file" | grep -v "libcreds-exempt" > /dev/null 2>&1; then
    if [ "$violations" -eq 0 ]; then
      echo "Token isolation violations found:"
      echo ""
    fi
    grep -nE "$GREP_PATTERN" "$file" | grep -v "libcreds-exempt" | while IFS= read -r match; do
      echo "  $relpath:$match"
    done
    violations=1
  fi
done < <(find "$REPO_ROOT" -name '*.ts' -not -path '*/node_modules/*' -not -path '*/.git/*')

if [ "$violations" -ne 0 ]; then
  echo ""
  echo "Raw token env var access must be confined to packages/libcreds/ and packages/libcreds-host/."
  echo "Use the credential abstractions from those packages instead."
  echo "Add '// libcreds-exempt' comment for justified exceptions (e.g., sync git clone)."
  exit 1
fi

echo "Token isolation: OK"
exit 0
