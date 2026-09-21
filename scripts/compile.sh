#!/usr/bin/env bash
set -euo pipefail

# Compile a collection's current compilation-manifest into an epub: fetch each
# member body per the manifest (the build authority), report word counts as
# build output (counts are a compilation-time determination - never stored),
# and hand the result to pandoc.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

usage() {
  cat <<USAGE
usage:
  compile.sh --collection <ref> [--out <dir>] [--title <t>] [--author <a>] [--meta KEY=VAL]...

Builds <out>/<base>.epub from the collection's current compilation-manifest
data artifact (kind compilation-manifest, intent current). Member order and
pandoc metadata come from the manifest; a missing pandoc on PATH is resolved
through the repo's uv venv (pypandoc-binary), so run 'uv sync' first.

  --collection <ref>   full ref of the collection resource (required)
  --out <dir>          output directory (default: current directory)
  --title <t>          override the manifest/collection title
  --author <a>         override the manifest author
  --meta KEY=VAL       extra pandoc metadata, repeatable
exit: 0 ok, 1 build failure, 2 usage/setup error
USAGE
}

die() { printf 'compile: %s\n' "$1" >&2; exit 2; }

COLLECTION="" OUTDIR="." TITLE_OVR="" AUTHOR_OVR=""
declare -a EXTRA_META=()
while [ $# -gt 0 ]; do
  case "$1" in
    --collection) COLLECTION="${2:?}"; shift 2 ;;
    --out) OUTDIR="${2:?}"; shift 2 ;;
    --title) TITLE_OVR="${2:?}"; shift 2 ;;
    --author) AUTHOR_OVR="${2:?}"; shift 2 ;;
    --meta) EXTRA_META+=("${2:?}"); shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

command -v temper >/dev/null 2>&1 || die "temper CLI not found on PATH"
command -v jq >/dev/null 2>&1 || die "jq not found on PATH"
[ -n "$COLLECTION" ] || { usage >&2; exit 2; }
[ -d "$OUTDIR" ] || die "output directory not found: $OUTDIR"

if command -v pandoc >/dev/null 2>&1; then
  PANDOC="$(command -v pandoc)"
else
  [ -x "$ROOT/.venv/bin/python3" ] || die "no pandoc on PATH and no $ROOT/.venv - run 'uv sync' in the repo root"
  PANDOC="$("$ROOT/.venv/bin/python3" -c 'import pypandoc,sys; sys.stdout.write(pypandoc.get_pandoc_path())')"
  [ -x "$PANDOC" ] || die "pypandoc-binary did not provide a pandoc executable"
fi

# The current manifest artifact for this collection.
artifact_id="$(temper data-artifact list "$COLLECTION" --kind compilation-manifest --format json \
  | jq -r '(.rows // .artifacts // .) | if type == "array" then (map(select(.intent == "current")) | if length > 0 then .[0].id else (.[0].id // empty) end) else .id // empty end')"
[ -n "$artifact_id" ] || die "no compilation-manifest artifact on $COLLECTION - run scripts/manifest.sh --collection $COLLECTION --apply first"

tmpjson="$(mktemp "${TMPDIR:-/tmp}/compile-manifest.XXXXXX")"
builddir="$(mktemp -d "${TMPDIR:-/tmp}/compile-build.XXXXXX")"
trap 'rm -rf "$tmpjson" "$builddir"' EXIT

temper data-artifact show "$COLLECTION" "$artifact_id" --format json \
  | jq '.content // .payload // .' >"$tmpjson"

# Defensive re-check at build time: the manifest is the authority, so it must
# be valid against its shape before anything is fetched.
"$ROOT/scripts/lint.sh" --schema compilation-manifest "$tmpjson" >/dev/null || exit 1

# Defaults: manifest title/output, falling back to the collection's title/slug.
collection_title="$(temper resource show "$COLLECTION" --format json | jq -r '.title')"
title="$(jq -r '.title // empty' "$tmpjson")"
[ -n "$title" ] || title="$collection_title"
[ -n "$TITLE_OVR" ] && title="$TITLE_OVR"
base="$(jq -r '.output // empty' "$tmpjson")"
[ -n "$base" ] || base="$(printf '%s' "$collection_title" | sed -E 's/-[0-9a-f]{36}$//' | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g')"
[ -n "$base" ] || base="compilation"

# pandoc metadata file from the manifest's metadata object.
{
  printf 'title: %s\n' "$title"
  author="$(jq -r '.metadata.author // empty' "$tmpjson")"
  [ -n "$AUTHOR_OVR" ] && author="$AUTHOR_OVR"
  [ -n "$author" ] && printf 'author: %s\n' "$author"
  jq -r '.metadata // {} | to_entries[]
        | select(.key != "author")
        | "\(.key): \(.value | if type == "boolean" or type == "number" then tostring else . end)"' "$tmpjson"
  for kv in "${EXTRA_META[@]:-}"; do
    [ -n "$kv" ] && printf '%s\n' "$kv"
  done
} >"$builddir/meta.yaml"

# Fetch member bodies in manifest order.
mapfile -t refs < <(jq -r '.members[].ref' "$tmpjson")
[ "${#refs[@]}" -gt 0 ] || die "manifest has no members"

files=()
total_words=0
i=0
for ref in "${refs[@]}"; do
  i=$((i + 1))
  member_title="$(temper resource show "$ref" --format json | jq -r '.title')"
  f="$builddir/$(printf '%03d' "$i")-$(printf '%s' "$member_title" | sed -E 's/^[0-9]{4}-[0-9]{2}-[0-9]{2} ?//' | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g').md"
  temper resource show "$ref" --format json | jq -r '.content' >"$f"
  [ -s "$f" ] || die "member $ref has an empty body"
  words="$(wc -w <"$f" | tr -d ' ')"
  total_words=$((total_words + words))
  printf '  %2d. %-60s %6s words\n' "$i" "$member_title" "$words"
  files+=("$f")
done
printf 'word count (compilation-time, not stored): %s words in %d members\n' "$total_words" "${#files[@]}"

outfile="$OUTDIR/$base.epub"
"$PANDOC" --toc --metadata-file "$builddir/meta.yaml" --output "$outfile" "${files[@]}"
printf 'wrote %s\n' "$outfile"
