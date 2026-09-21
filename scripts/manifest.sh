#!/usr/bin/env bash
set -euo pipefail

# Reconcile a collection's compilation-manifest data artifact from a temper
# query: members are the documents whose open_meta.collection matches, sorted
# by open_meta.order where present (ties broken by list position), else by
# open_meta.date. The payload is validated against the compilation-manifest
# schema BEFORE the commit: after a passing validation, a commit failure is a
# temper-side fault, not a payload error.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DOC_TYPES=(journal poem story reflection spec)

usage() {
  cat <<USAGE
usage:
  manifest.sh --collection <ref> [--status <status>] [--apply]

Builds the compilation-manifest payload for <ref> from the query alone and
prints it. With --apply, validates the payload against
schemas/compilation-manifest.json and commits it to the collection as the
current artifact of kind compilation-manifest.

  --collection <ref>     full ref of the collection resource (required)
  --status <status>      keep only members whose open_meta.status matches
  --apply                validate + commit (default: build + validate + print)

member selection: any document type in ${DOC_TYPES[*]} whose open_meta.collection
equals <ref>; ordered by open_meta.order (ties broken by list position) with
order-carrying members ahead of date-only members, else by open_meta.date.
exit: 0 ok, 1 validation failure, 2 usage/setup error
USAGE
}

die() { printf 'manifest: %s\n' "$1" >&2; exit 2; }

COLLECTION="" STATUS="" APPLY=0
need_value() { [ $# -ge 2 ] && [ -n "${2:-}" ] || die "$1 requires a value"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --collection) need_value "$@"; COLLECTION="$2"; shift 2 ;;
    --status) need_value "$@"; STATUS="$2"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

command -v temper >/dev/null 2>&1 || die "temper CLI not found on PATH"
command -v jq >/dev/null 2>&1 || die "jq not found on PATH"
[ -n "$COLLECTION" ] || { usage >&2; exit 2; }

# Members live in the collection's own context.
context="$(temper resource show "$COLLECTION" --format json | jq -r '.context_ref // empty')"
[ -n "$context" ] || die "cannot resolve the context of collection $COLLECTION"

# One filtered, sorted JSON array of members across all doc types. A temper
# failure here must abort: an empty fallback would reconcile a manifest that
# silently omits members.
members_json='{"rows":[]}'
for type in "${DOC_TYPES[@]}"; do
  page="$(temper resource list --type "$type" --context "$context" --with open-meta --format json --all)"
  members_json="$(printf '%s\n%s\n' "$members_json" "$page" | jq -cs --arg collection "$COLLECTION" --arg status "$STATUS" '
    ([.[1].rows // []
      | map(select(.open_meta.collection == $collection))
      | (if $status == "" then . else map(select(.open_meta.status == $status)) end)]
     | .[0]) as $new
    | .[0] + {rows: ((.[0].rows // []) + $new)}')"
done

# Only numeric order values drive ordering (the manifest schema requires
# integer); string orders fall back to the member's date.
manifest="$(printf '%s' "$members_json" | jq -c --arg collection "$COLLECTION" '
  {collection: $collection,
   members: (.rows
     | sort_by(if (.open_meta.order | type) == "number" then .open_meta.order else .open_meta.date end)
     | map({ref: .ref}
         + (if (.open_meta.order | type) == "number" then {order: .open_meta.order} else {} end))
   )}')"

if [ "$(printf '%s' "$manifest" | jq '.members | length')" -eq 0 ]; then
  die "no members found for collection $COLLECTION (documents must carry open_meta.collection = <this ref>)"
fi

tmp="$(mktemp "${TMPDIR:-/tmp}/manifest-payload.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
printf '%s' "$manifest" | jq . >"$tmp"

printf 'manifest for %s: %d member(s)\n' "$COLLECTION" "$(jq '.members | length' "$tmp")"
jq -r '.members[] | "  \(.ref)" + (if .order then "  (order \(.order))" else "" end)' "$tmp"

"$ROOT/scripts/lint.sh" --schema compilation-manifest "$tmp" || exit 1

if [ "$APPLY" -eq 0 ]; then
  printf 'dry run - payload validated, not committed (pass --apply to commit)\n'
  printf 'payload: %s\n' "$tmp"
  trap - EXIT
  exit 0
fi

if ! temper data-artifact commit \
  --kind compilation-manifest \
  --intent current \
  "$COLLECTION" \
  --content @"$tmp"; then
  die "commit failed after passing local validation against the repo schema. The enforcing shape declared on your context may have drifted from schemas/compilation-manifest.json (rerun install.sh), or temper errored server-side."
fi
printf 'committed compilation-manifest (intent current) on %s\n' "$COLLECTION"
