#!/usr/bin/env bash
# The theme contract has one home: the @tasker-systems/temper-design package, published from the
# temper repository. This repository reads it from there, at the version apps/desktop/package.json
# pins, and carries no copy of it. A copy is refused rather than kept in sync: absence is a property
# a check can hold, and two copies that are meant to agree are not.
#
# Refused, in any tracked file:
#   - anything under themes/ — where the contract lived before it moved
#   - a theme or contract file by name: theme.json, theme.css, theme.schema.json
#   - a declaration of a --tp-* role (`--tp-x: ...`) — components read roles, never define them
#     (not searched: .md prose, and this check's own harness, whose fixtures are refused shapes)
#
# A change to the contract or a theme is made in the package and reaches this repository as a
# version bump. Locally, the desktop can paint from an unreleased package checkout first (see
# apps/desktop/README.md, "Theme roles").
#
#   tools/check-no-design-contract.sh        # exit 1 and name each offender
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

found=0
refuse() {
  echo "  $1" >&2
  found=1
}

while IFS= read -r path; do
  refuse "${path} — themes/ is gone; the contract lives in @tasker-systems/temper-design"
done < <(git ls-files -- 'themes/*')

while IFS= read -r path; do
  refuse "${path} — a theme or contract file; it belongs in @tasker-systems/temper-design"
done < <(git ls-files -- '*theme.json' '*theme.css' '*theme.schema.json' | grep -E '(^|/)theme(\.schema)?\.(json|css)$' || true)

while IFS= read -r hit; do
  refuse "${hit} — declares a --tp-* role; components read roles, the package defines them"
done < <(git grep -n -I -E '(^|[;{"[:space:]])--tp-[a-z0-9-]+[[:space:]]*:' -- ':!*.md' ':!tools/test-check-no-design-contract.sh' || true)

if [ "$found" -ne 0 ]; then
  echo "check-no-design-contract: the theme contract has a copy here (above). Make the change in" >&2
  echo "@tasker-systems/temper-design and take the new version instead." >&2
  exit 1
fi
echo "check-no-design-contract: no copy of the theme contract"
