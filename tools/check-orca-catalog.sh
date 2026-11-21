#!/usr/bin/env bash
# Checks an Orca plugin catalog (orca-catalog.json) against the repository it publishes from.
#
#   tools/check-orca-catalog.sh <orca-catalog.json> [orca-binary]
#
# `orca plugin validate` checks the catalog's shape, and is tolerant by design: it accepts an
# entry id Orca would refuse to install (a reserved `orca-` id) and keys it does not know. On
# top of it, for every entry, this check refuses:
#   - an id that is not `<repository owner>.<manifest id>`, or a manifest id starting `orca-`;
#   - a newest release whose version, execution or minimum Orca is not the manifest's;
#   - a release commit missing from this checkout or not an ancestor of HEAD (a rebase or
#     squash rewrote it);
#   - a newest release whose content hash is not what `orca plugin release-entry` computes for
#     the plugin folder at that commit.
# The orca binary defaults to `orca`, then `orca-ide`; without either it skips loudly.
set -euo pipefail

catalog="${1:-}"
if [ -z "$catalog" ] || [ ! -f "$catalog" ]; then
  echo "usage: $0 <orca-catalog.json> [orca-binary]" >&2
  exit 2
fi

orca="${2:-}"
if [ -z "$orca" ]; then
  if command -v orca >/dev/null 2>&1; then
    orca="orca"
  elif command -v orca-ide >/dev/null 2>&1; then
    orca="orca-ide"
  else
    echo "! orca not on PATH — SKIPPING the catalog check (CI runs it regardless)." >&2
    exit 0
  fi
fi

catalog="$(cd "$(dirname "$catalog")" && pwd)/$(basename "$catalog")"
root="$(git -C "$(dirname "$catalog")" rev-parse --show-toplevel)"

fail=0
refuse() {
  echo "✗ $catalog: $*" >&2
  fail=1
}

if ! "$orca" plugin validate "$catalog" --json >/dev/null; then
  "$orca" plugin validate "$catalog" --json | jq -r '.error.data.errors[]? // .error.message' >&2 || true
  refuse "orca plugin validate refused it"
  exit 1
fi

scratch="$(mktemp -d)"
worktrees=()
cleanup() {
  for wt in "${worktrees[@]+"${worktrees[@]}"}"; do
    git -C "$root" worktree remove --force "$wt" >/dev/null 2>&1 || true
  done
  rm -rf "$scratch"
}
trap cleanup EXIT

count="$(jq '.plugins | length' "$catalog")"
for ((i = 0; i < count; i++)); do
  entry="$(jq -c ".plugins[$i]" "$catalog")"
  id="$(jq -r .id <<<"$entry")"
  url="$(jq -r .source.url <<<"$entry")"
  path="$(jq -r '.source.path // "."' <<<"$entry")"
  manifest="$root/$path/orca-plugin.json"

  if [ ! -f "$manifest" ]; then
    refuse "$id: no orca-plugin.json at source.path '$path'"
    continue
  fi

  # The publisher is the repository owner, lowercased (https://host/owner/repo or git@host:owner/repo).
  owner="$(sed -E 's#^(https://[^/]+/|ssh://[^/]+/|[^@]+@[^:]+:)##; s#/.*##' <<<"$url" | tr '[:upper:]' '[:lower:]')"
  manifest_id="$(jq -r .id "$manifest")"
  if [ "$id" != "$owner.$manifest_id" ]; then
    refuse "$id: the id must be '$owner.$manifest_id' (repository owner . manifest id)"
  fi
  case "$manifest_id" in
    orca-*) refuse "$id: manifest id '$manifest_id' starts 'orca-', which installs only from Orca's official catalog" ;;
  esac

  newest="$(jq -c '.releases[0]' <<<"$entry")"
  for field in version execution; do
    want="$(jq -r ".$field" "$manifest")"
    have="$(jq -r ".$field" <<<"$newest")"
    [ "$want" = "$have" ] || refuse "$id: newest release $field '$have' is not the manifest's '$want'"
  done
  want="$(jq -r '.engines.orca | sub("^>="; "")' "$manifest")"
  have="$(jq -r .minimumOrca <<<"$newest")"
  [ "$want" = "$have" ] || refuse "$id: newest release minimumOrca '$have' is not the manifest's engines.orca '$want'"

  while read -r commit; do
    if ! git -C "$root" cat-file -e "$commit^{commit}" 2>/dev/null; then
      refuse "$id: release commit $commit is not in this checkout (fetch full history)"
    elif ! git -C "$root" merge-base --is-ancestor "$commit" HEAD; then
      refuse "$id: release commit $commit is not an ancestor of HEAD (rewritten by a rebase or squash?)"
    fi
  done < <(jq -r '.releases[].commit' <<<"$entry")

  commit="$(jq -r .commit <<<"$newest")"
  if git -C "$root" cat-file -e "$commit^{commit}" 2>/dev/null; then
    wt="$scratch/release-$i"
    git -C "$root" worktree add --detach --quiet "$wt" "$commit"
    worktrees+=("$wt")
    computed="$("$orca" plugin release-entry "$wt/$path" --json | jq -r .result.entry.contentHash)"
    have="$(jq -r .contentHash <<<"$newest")"
    [ "$computed" = "$have" ] ||
      refuse "$id: newest release contentHash $have is not $computed, what release-entry computes at $commit"
  fi
done

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "✓ $catalog: valid, and every entry matches its manifest and its pinned commit"
