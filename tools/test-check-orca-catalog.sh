#!/usr/bin/env bash
# Harness for check-orca-catalog.sh. A scratch repository publishes one small plugin from a
# subdirectory through its catalog; the faithful catalog must pass, and each seeded violation
# must be refused, naming what is wrong — or a check that refused everything would satisfy
# every case below without ever being right.
#
#   tools/test-check-orca-catalog.sh [orca-binary]
set -euo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-orca-catalog.sh"

orca="${1:-}"
if [ -z "$orca" ]; then
  if command -v orca >/dev/null 2>&1; then
    orca="orca"
  elif command -v orca-ide >/dev/null 2>&1; then
    orca="orca-ide"
  else
    echo "! orca not on PATH — SKIPPING the catalog check's witnesses (CI runs them regardless)." >&2
    exit 0
  fi
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0
FAIL=0
REPO="$TMP/repo"

git_() { git -C "$REPO" -c user.name=witness -c user.email=witness@invalid "$@"; }

fresh() {
  rm -rf "$REPO"
  mkdir -p "$REPO/plugins"
  git -C "$REPO" init -q
  "$orca" plugin create "$REPO/plugins/dusk" --template theme --id dusk --json >/dev/null
  git_ add -A
  git_ commit -q -m "a plugin"
  "$orca" plugin release-entry "$REPO/plugins/dusk" --json |
    jq '{catalogVersion: 2, name: "Witness", owner: "acme",
         plugins: [{id: "acme.dusk",
                    source: {kind: "git", url: "https://github.com/Acme/witness.git", ref: "main",
                             path: .result.sourcePath},
                    releases: [.result.entry]}]}' >"$REPO/orca-catalog.json"
  git_ add -A
  git_ commit -q -m "its catalog"
}

edit_catalog() { # $1 = jq filter
  jq "$1" "$REPO/orca-catalog.json" >"$TMP/c.json"
  mv "$TMP/c.json" "$REPO/orca-catalog.json"
}

edit_manifest() { # $1 = jq filter
  jq "$1" "$REPO/plugins/dusk/orca-plugin.json" >"$TMP/m.json"
  mv "$TMP/m.json" "$REPO/plugins/dusk/orca-plugin.json"
}

run() { bash "$SCRIPT" "$REPO/orca-catalog.json" "$orca" >"$TMP/out" 2>&1; }

expect_pass() {
  if run; then
    PASS=$((PASS + 1)); echo "  PASS: $1"
  else
    FAIL=$((FAIL + 1)); echo "  FAIL: $1"; sed 's/^/      /' "$TMP/out"
  fi
}

expect_refused() { # $1 = case, $2 = text the refusal must carry
  if run; then
    FAIL=$((FAIL + 1)); echo "  FAIL: $1 was accepted"
  elif grep -qF -- "$2" "$TMP/out"; then
    PASS=$((PASS + 1)); echo "  PASS: $1 is refused"
  else
    FAIL=$((FAIL + 1)); echo "  FAIL: $1 was refused without naming '$2'"; sed 's/^/      /' "$TMP/out"
  fi
}

echo "test-check-orca-catalog:"

fresh
expect_pass "a catalog faithful to its manifest and pinned commit"

fresh; edit_catalog '.plugins[0].releases[0].commit = "nope"'
expect_refused "a catalog orca plugin validate refuses" "orca plugin validate refused it"

fresh; edit_catalog '.plugins[0].id = "acme.other"'
expect_refused "an id that is not owner.manifest-id" "must be 'acme.dusk'"

fresh; edit_manifest '.id = "orca-dusk"'; edit_catalog '.plugins[0].id = "acme.orca-dusk"'
expect_refused "a reserved orca- manifest id" "starts 'orca-'"

fresh; edit_catalog '.plugins[0].source.path = "plugins/missing"'
expect_refused "a source.path with no manifest" "no orca-plugin.json at source.path"

fresh; edit_manifest '.version = "0.2.0"'
expect_refused "a version bump with no release for it" "version '0.1.0' is not the manifest's '0.2.0'"

fresh; edit_manifest '.engines.orca = ">=1.4.250"'
expect_refused "a raised engines.orca with no release for it" "minimumOrca '1.4.246'"

fresh; edit_catalog '.plugins[0].releases[0].contentHash = ("0" * 64)'
expect_refused "a content hash that is not the pinned commit's" "what release-entry computes"

fresh
main="$(git_ rev-parse --abbrev-ref HEAD)"
git_ checkout -q -b side
touch "$REPO/elsewhere"
git_ add -A
git_ commit -q -m "a commit off this history"
side="$(git_ rev-parse HEAD)"
git_ checkout -q "$main"
edit_catalog ".plugins[0].releases[0].commit = \"$side\""
expect_refused "a pinned commit rewritten out of HEAD's history" "is not an ancestor of HEAD"

echo ""
echo "test-check-orca-catalog: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
