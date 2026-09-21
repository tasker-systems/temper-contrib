#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILL_SRC="$ROOT/skills/writing-templates"
SKILL_NAME="writing-templates"
MANIFEST_SCHEMA="$ROOT/schemas/compilation-manifest.json"
CONFIG_DIR="${HOME}/.config/temper-contrib"
CONFIG_FILE="$CONFIG_DIR/writing.conf"

skill_dir_for() {
  case "$1" in
    agents) printf '%s' "${HOME}/.agents/skills" ;;
    claude) printf '%s' "${HOME}/.claude/skills" ;;
    opencode) printf '%s' "${HOME}/.config/opencode/skills" ;;
    *) return 1 ;;
  esac
}

usage() {
  cat <<USAGE
usage: install.sh --context <ref> [--author <name>] [--targets agents,claude,opencode]

Installs the writing package:
  1. probes the temper CLI for 'data-artifact schema declare' (the version floor)
  2. declares the compilation-manifest shape (enforcing) on <ref>
  3. copies skills/$SKILL_NAME into the selected agent skill dirs
  4. writes author, context, and repo path to $CONFIG_FILE (personal identity lives here, never in the repo)

<context> is a temper context ref, e.g. @me/writing or +team/slug.
targets: agents | claude | opencode (default: agents)
usage: install.sh --help
USAGE
}

die() { printf 'install: %s\n' "$1" >&2; exit 2; }

CONTEXT="" AUTHOR="" TARGETS="agents"
need_value() { if [ $# -lt 2 ] || [ -z "${2:-}" ]; then die "$1 requires a value"; fi; }
while [ $# -gt 0 ]; do
  case "$1" in
    --context) need_value "$@"; CONTEXT="$2"; shift 2 ;;
    --author) need_value "$@"; AUTHOR="$2"; shift 2 ;;
    --targets) need_value "$@"; TARGETS="$2"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

command -v temper >/dev/null 2>&1 || die "temper CLI not found on PATH - install temper 0.5.2 or newer"
if ! temper data-artifact schema declare --help >/dev/null 2>&1; then
  die "temper CLI is too old: 'data-artifact schema declare' is required (present from 0.5.2)"
fi

[ -n "$CONTEXT" ] || die "--context is required"
[ -f "$MANIFEST_SCHEMA" ] || die "manifest schema missing: $MANIFEST_SCHEMA"
[ -f "$SKILL_SRC/SKILL.md" ] || die "skill missing: $SKILL_SRC/SKILL.md"

if [ -z "$AUTHOR" ]; then
  read -r -p "Author name (stored in $CONFIG_FILE, never shipped): " AUTHOR
  [ -n "$AUTHOR" ] || die "an author name is required"
fi

IFS=',' read -r -a TARGET_LIST <<<"$TARGETS"
for target in "${TARGET_LIST[@]}"; do
  skill_dir_for "$target" >/dev/null || die "unknown target '$target' (agents | claude | opencode)"
done

total="$(temper resource list --context "$CONTEXT" --limit 1 --format json 2>/dev/null \
  | grep -oE '"total": ?[0-9]+' | grep -oE '[0-9]+' || true)"
if [ "$total" = "0" ] || [ -z "$total" ]; then
  printf 'context %s is empty - seeding an install note\n' "$CONTEXT"
  printf '  (shape declare resolves its kind namespace from a resource homed in the\n   context; an empty context refuses - see temper migration 20260822000010)\n'
  printf 'The writing package was installed into this context. Its compilation\nmanifests (kind: compilation-manifest) are governed by the enforcing shape\ndeclared here at install time.\n' \
    | temper resource create --type note --title "Writing package install seed" --context "$CONTEXT"
fi

printf 'declaring compilation-manifest (enforcing) on %s\n' "$CONTEXT"
temper data-artifact schema declare \
  --kind compilation-manifest \
  --enforcement enforcing \
  "$CONTEXT" \
  --content @"$MANIFEST_SCHEMA"

for target in "${TARGET_LIST[@]}"; do
  dest="$(skill_dir_for "$target")/$SKILL_NAME"
  mkdir -p "$dest"
  cp "$SKILL_SRC/SKILL.md" "$dest/SKILL.md"
  printf 'installed skill: %s\n' "$dest"
done

mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"
# Single-quote every value so `source writing.conf` cannot re-expand anything
# the user typed (author names, refs, and clone paths may hold $ or quotes).
conf_escape() { printf '%s' "$1" | sed "s/'/'\\\\''/g"; }
cat >"$CONFIG_FILE" <<CONF
WRITING_AUTHOR='$(conf_escape "$AUTHOR")'
WRITING_CONTEXT='$(conf_escape "$CONTEXT")'
WRITING_REPO='$(conf_escape "$ROOT")'
CONF
chmod 600 "$CONFIG_FILE"
printf 'wrote config: %s\n' "$CONFIG_FILE"

printf '\ndone. verify with: temper data-artifact schema list %s\n' "$CONTEXT"
