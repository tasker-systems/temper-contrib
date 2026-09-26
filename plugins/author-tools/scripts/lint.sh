#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCHEMAS="$ROOT/schemas"
FIXTURES="$ROOT/tests/fixtures"

PRIVATE_DEPENDENCY_PATTERN='(petes?-doc[s]|kb-vaul[t]|petetaylo[r])'

usage() {
  cat <<USAGE
usage:
  lint.sh <doc-type> <payload.json | ->   validate an open_meta payload against schemas/<doc-type>.json
  lint.sh --schema <name> <payload.json | - >   validate a payload against schemas/<name>.json (e.g. compilation-manifest)
  lint.sh --self-check                    schemas valid + fixtures pass both directions + no private dependencies

doc types: journal poem story reflection spec
exit: 0 pass, 1 validation failure, 2 usage/setup error
USAGE
}

die() { printf 'lint: %s\n' "$1" >&2; exit 2; }

# Python that can import jsonschema: the repo's uv venv when present, else PATH.
if [ -x "$ROOT/.venv/bin/python3" ]; then
  PYTHON="$ROOT/.venv/bin/python3"
else
  PYTHON="python3"
fi

require_validator() {
  if ! "$PYTHON" -c 'import jsonschema' >/dev/null 2>&1; then
    die "module 'jsonschema' not importable by $PYTHON - run 'uv sync' in the repo root"
  fi
}

schema_path() {
  local type="$1"
  [ -f "$SCHEMAS/$type.json" ] || die "no schemas/$type.json (known: journal poem story reflection spec compilation-manifest)"
  printf '%s' "$SCHEMAS/$type.json"
}

validate_payload() {
  local type="$1" payload="$2" schema tmp="" rc=0
  schema="$(schema_path "$type")"
  if [ "$payload" != "-" ] && [ ! -f "$payload" ]; then
    die "payload not found: $payload"
  fi
  if [ "$payload" = "-" ]; then
    tmp="$(mktemp "${TMPDIR:-/tmp}/lint-payload.XXXXXX")"
    cat >"$tmp"
    payload="$tmp"
  fi
  "$PYTHON" - "$schema" "$payload" <<'PY' || rc=$?
import json
import sys

from jsonschema import Draft202012Validator, FormatChecker

schema_path, payload_path = sys.argv[1], sys.argv[2]
with open(schema_path) as f:
    schema = json.load(f)
with open(payload_path) as f:
    payload = json.load(f)

validator = Draft202012Validator(schema, format_checker=FormatChecker())
errors = sorted(validator.iter_errors(payload), key=lambda e: list(e.path))
if errors:
    print(f"INVALID: payload against {schema_path}", file=sys.stderr)
    for err in errors:
        location = "/".join(str(p) for p in err.path) or "<root>"
        print(f"  {location}: {err.message}", file=sys.stderr)
    sys.exit(1)
print(f"ok: payload valid against {schema_path}")
PY
  [ -z "$tmp" ] || rm -f "$tmp"
  return "$rc"
}

self_check() {
  require_validator

  local schema failures=0
  for schema in "$SCHEMAS"/*.json; do
    if "$PYTHON" - "$schema" <<'PY'
import json
import sys

from jsonschema.validators import validator_for

with open(sys.argv[1]) as f:
    schema = json.load(f)
validator_for(schema).check_schema(schema)
PY
    then
      printf 'ok: schema valid: %s\n' "$(basename "$schema")"
    else
      printf 'FAIL: schema invalid: %s\n' "$schema" >&2
      failures=$((failures + 1))
    fi
  done

  local payload type
  for payload in "$FIXTURES"/conforming/*.json; do
    type="$(basename "$payload" .json)"
    if validate_payload "$type" "$payload" >/dev/null; then
      printf 'ok: conforming fixture passes: %s\n' "$(basename "$payload")"
    else
      printf 'FAIL: conforming fixture must pass: %s\n' "$payload" >&2
      failures=$((failures + 1))
    fi
  done

  local stem
  for payload in "$FIXTURES"/broken/*.json; do
    stem="$(basename "$payload" .json)"
    type="${stem%%-*}"
    if [ ! -f "$SCHEMAS/$type.json" ]; then
      die "broken fixture '$stem' has no matching schema for derived type '$type'"
    fi
    if validate_payload "$type" "$payload" >/dev/null 2>&1; then
      printf 'FAIL: broken fixture must fail: %s\n' "$payload" >&2
      failures=$((failures + 1))
    else
      printf 'ok: broken fixture fails as required: %s\n' "$stem"
    fi
  done

  local matches="" f
  while IFS= read -r f; do
    if grep -qE "$PRIVATE_DEPENDENCY_PATTERN" -- "$f" 2>/dev/null; then
      matches+="$f"$'\n'
    fi
  done < <(git -C "$ROOT" ls-files --cached --others --exclude-standard)
  if [ -n "$matches" ]; then
    printf 'FAIL: private-dependency references found in:\n%s\n' "$matches" >&2
    failures=$((failures + 1))
  else
    printf 'ok: no private-dependency references in tracked files\n'
  fi

  if [ "$failures" -gt 0 ]; then
    die "self-check failed with $failures failure(s)"
  fi
  printf 'self-check passed\n'
}

case "${1:-}" in
  --self-check) self_check ;;
  --schema)
    if [ -z "${2:-}" ] || [ -z "${3:-}" ]; then usage >&2; exit 2; fi
    require_validator
    validate_payload "$2" "$3"
    ;;
  -h | --help | "") usage; [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] || exit 2 ;;
  *)
    [ -n "${2:-}" ] || { usage >&2; exit 2; }
    require_validator
    validate_payload "$1" "$2"
    ;;
esac
