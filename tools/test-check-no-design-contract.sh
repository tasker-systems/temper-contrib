#!/usr/bin/env bash
# Harness for check-no-design-contract.sh. Each refused shape is added to a scratch repository on
# its own and must fail the check; the clean repository must pass, or a check that refused
# everything would satisfy every case below without ever being right.
set -euo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-no-design-contract.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0
FAIL=0

fresh() {
  rm -rf "$TMP/repo"
  mkdir -p "$TMP/repo/apps/desktop/src"
  git -C "$TMP/repo" init -q
  # A component that reads roles — what this repository legitimately holds.
  printf '.x { color: var(--tp-text); background: var(--tp-surface); }\n' \
    > "$TMP/repo/apps/desktop/src/app.css"
  git -C "$TMP/repo" add -A
}

run() { (cd "$TMP/repo" && bash "$SCRIPT") > "$TMP/out" 2>&1; }

expect_pass() {
  if run; then
    PASS=$((PASS + 1)); echo "  PASS: $1"
  else
    FAIL=$((FAIL + 1)); echo "  FAIL: $1"; sed 's/^/      /' "$TMP/out"
  fi
}

expect_refused() { # $1 = case, $2 = the path the refusal must name
  if run; then
    FAIL=$((FAIL + 1)); echo "  FAIL: $1 was accepted"
  elif grep -qF "$2" "$TMP/out"; then
    PASS=$((PASS + 1)); echo "  PASS: $1 is refused"
  else
    FAIL=$((FAIL + 1)); echo "  FAIL: $1 was refused without naming $2"; sed 's/^/      /' "$TMP/out"
  fi
}

add() { # $1 = path, $2 = content
  mkdir -p "$TMP/repo/$(dirname "$1")"
  printf '%s\n' "$2" > "$TMP/repo/$1"
  git -C "$TMP/repo" add -A
}

fresh
expect_pass "a repository whose components only read roles"

fresh; add themes/README.md "# themes"
expect_refused "anything under themes/" "themes/README.md"

fresh; add apps/desktop/src/neon/theme.json '{"name": "neon"}'
expect_refused "a theme.json outside themes/" "apps/desktop/src/neon/theme.json"

fresh; add apps/desktop/static/theme.css '[data-theme="neon"] {}'
expect_refused "a theme.css" "apps/desktop/static/theme.css"

fresh; add contract/theme.schema.json '{}'
expect_refused "a theme.schema.json" "contract/theme.schema.json"

fresh; add apps/desktop/src/local.css ':root { --tp-accent: #ff00ff; }'
expect_refused "a stylesheet declaring a --tp-* role" "apps/desktop/src/local.css"

fresh; add apps/desktop/src/Badge.svelte '<span style="--tp-accent: red">x</span>'
expect_refused "an inline style declaring a --tp-* role" "apps/desktop/src/Badge.svelte"

echo ""
echo "test-check-no-design-contract: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
