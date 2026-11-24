#!/usr/bin/env bash
# Declares the `orca-work` shape (schemas/orca-work.schema.json) in one temper context, after
# comparing it with the shape already live there. A shape governs only its own home, so each
# context whose tasks carry `orca-work` records needs its own declaration; this script is run
# once per context, by the person, under their own grant.
#
#   scripts/declare-orca-work-shape.sh <context-ref> [--enforcement advisory|enforcing]
#
# Declaring is not idempotent (every declare folds the live version and starts a new one), so
# nothing is declared when the live shape already has the same $id and enforcement.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
schema="$here/schemas/orca-work.schema.json"

usage() {
  echo "usage: $0 <context-ref> [--enforcement advisory|enforcing]" >&2
  exit 2
}

[ $# -ge 1 ] || usage
context="$1"
shift
enforcement="enforcing"
while [ $# -gt 0 ]; do
  case "$1" in
    --enforcement)
      [ $# -ge 2 ] || usage
      enforcement="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done
case "$enforcement" in
  advisory | enforcing) ;;
  *) usage ;;
esac

command -v temper >/dev/null 2>&1 || { echo "temper CLI not on PATH" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "jq not on PATH" >&2; exit 2; }

want_id="$(jq -r '."$id"' "$schema")"
live="$(temper data-artifact schema list --context "$context" --format json)"
live_id="$(jq -r '[.[] | select(.artifact_kind == "orca-work")][0].schema."$id" // ""' <<<"$live")"
live_enforcement="$(jq -r '[.[] | select(.artifact_kind == "orca-work")][0].enforcement // ""' <<<"$live")"

if [ "$live_id" = "$want_id" ] && [ "$live_enforcement" = "$enforcement" ]; then
  echo "orca-work in $context is already $want_id ($enforcement); nothing declared."
  exit 0
fi

temper data-artifact schema declare "$context" --kind orca-work --enforcement "$enforcement" \
  --content "@$schema" --format json >/dev/null

after="$(temper data-artifact schema list --context "$context" --format json)"
after_id="$(jq -r '[.[] | select(.artifact_kind == "orca-work")][0].schema."$id" // ""' <<<"$after")"
if [ "$after_id" != "$want_id" ]; then
  echo "declared, but the live orca-work shape in $context reads '$after_id', not $want_id" >&2
  exit 1
fi
echo "orca-work in $context is now $want_id ($enforcement)."
