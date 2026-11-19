#!/usr/bin/env bash
# The orca-temper package gates, wired into cargo make:
#
#   scripts/gates.sh --check   vendor build, Orca typings, tsc type-check
#   scripts/gates.sh --test    the plugin's tests (`orca plugin test`)
#
# Both start from a frozen bun install. Steps that need the orca CLI skip loudly when it is
# absent (CI has no Orca yet); everything else fails the gate.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"

mode="${1:-}"
case "$mode" in
  --check | --test) ;;
  *)
    echo "usage: $0 --check|--test" >&2
    exit 2
    ;;
esac

if ! command -v bun >/dev/null 2>&1; then
  echo "! bun not on PATH — SKIPPING the orca-temper gates (install bun; CI runs them regardless)." >&2
  exit 0
fi

bun install --frozen-lockfile
bun run build
# The committed bundle is the one this pinned toolchain builds — no drift, no hand edit.
git diff --exit-code -- vendor/

if command -v orca >/dev/null 2>&1; then
  orca plugin types .
  bun run typecheck
else
  echo "! orca not on PATH — SKIPPING typings + type-check (the tsconfig extends .orca/types)." >&2
fi

if [ "$mode" = "--test" ]; then
  if command -v orca >/dev/null 2>&1; then
    orca plugin test . --json
  else
    echo "! orca not on PATH — SKIPPING orca plugin test (runs locally and wherever Orca is installed)." >&2
  fi
fi
