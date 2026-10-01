#!/usr/bin/env bash
# Stages the bundled ACP adapters into apps/desktop/acp-adapter-staging/:
# each adapter package plus the dependencies it actually resolves, cleaned of
# sources, tests, typings and maps. Dependencies land under the tree's own
# node_modules/ so bare specifier resolution works in the bundle layout, not
# only in the dev checkout (where walk-up into apps/desktop/node_modules would
# silently mask a broken staging). The staging tree is what
# tauri.conf.json's bundle.resources ships as acp-adapters/ inside the app,
# and what adapters.rs resolves in dev. Harness binaries are never staged —
# the adapters wrap the person's own claude/codex/agy, resolved at launch.
#
# The integrity chain: the adapter packages land through `bun install
# --frozen-lockfile` (the CI desktop job's install step, and the flow before
# any `tauri build`), which verifies every package's sha512 against bun.lock.
# This script only ever copies from that verified tree; it fetches nothing
# itself.
#
# Run from anywhere; paths are repo-relative. Idempotent: the staging tree is
# deleted and rebuilt each run.
set -euo pipefail

DESKTOP="$(cd "$(dirname "$0")/.." && pwd)"
NM="$DESKTOP/node_modules"
OUT="$DESKTOP/acp-adapter-staging"
OUTNM="$OUT/node_modules"

if [[ ! -d "$NM" ]]; then
    echo "build-adapters: $NM is missing — run bun install first" >&2
    exit 1
fi

if ! command -v node >/dev/null 2>&1; then
    echo "build-adapters: node is required for the resolution gate" >&2
    exit 1
fi

if [[ "$(uname -s)-$(uname -m)" != "Darwin-arm64" ]]; then
    if [[ "${TAURI_BUNDLE:-}" == "1" ]]; then
        echo "build-adapters: shipping bundles are staged on darwin-arm64 only; this machine is $(uname -s)-$(uname -m)" >&2
        exit 1
    fi
    # No bundle being produced (CI's cargo checks, the linux CSP witness's
    # --no-bundle build): stage what this machine has. The adapters' Rust-side
    # tests refuse honestly for missing harness CLIs, and the staged tree here
    # never ships.
    echo "build-adapters: not darwin-arm64 — staging for local build only (no bundle ships from here)" >&2
fi

rm -rf "$OUT"
mkdir -p "$OUTNM"

# prune <dir> — drop everything a runtime never reads.
prune() {
    local dir="$1"
    find "$dir" -type d \( \
        -name "src" -o -name "test" -o -name "tests" -o -name "__tests__" \
        -o -name "third_party" -o -name "typings" -o -name "docs" -o -name "scripts" \
        -o -name "deps" -o -name "obj.target" \
    \) -prune -exec rm -rf {} + 2>/dev/null || true
    find "$dir" -type f \( \
        -name "*.d.ts" -o -name "*.d.ts.map" -o -name "*.js.map" -o -name "*.ts" \
        -o -name "binding.gyp" -o -name "Makefile" \
    \) -delete
    find "$dir" -maxdepth 2 -type f \( \
        -iname "readme*" -o -iname "changelog*" -o -iname "history*" \
    \) -delete
    find "$dir" -type d -empty -delete 2>/dev/null || true
}

# stage <source relative to node_modules>  — lands at node_modules/<name>.
stage() {
    local src="$NM/$1"
    local dest="$OUTNM/$1"
    if [[ ! -d "$src" ]]; then
        echo "build-adapters: missing package $1 (bun install stale?)" >&2
        exit 1
    fi
    mkdir -p "$(dirname "$dest")"
    cp -R "$src" "$dest"
    prune "$dest"
}

# codex-acp's dist/index.js already bundles the SDK, zod, vscode-jsonrpc and
# its other imports; resolve("@openai/codex/...") is only the fallback for a
# missing CODEX_PATH and must fail when the CLI is absent — so only the
# adapter itself is staged.
stage "@agentclientprotocol/codex-acp"

# The claude adapter's runtime imports (esbuild --packages=external over its
# dist, 2026-10-01): the ACP SDK, the Claude Agent SDK, zod, diff, and node
# builtins. The SDK's per-platform binary packages are never staged —
# CLAUDE_CODE_EXECUTABLE points at the person's own CLI.
stage "@agentclientprotocol/claude-agent-acp"
stage "@agentclientprotocol/sdk"
stage "@anthropic-ai/claude-agent-sdk"
stage "zod"
stage "diff"

# agy-acp (esbuild, 2026-10-01): the ACP SDK (root and experimental/v2),
# @bufbuild/protobuf/wire, better-sqlite3 and node-pty, and node builtins.
stage "agy-acp"
stage "@bufbuild/protobuf"
stage "node-pty"
stage "better-sqlite3"

# Native modules ship this platform's build only, in both prebuild shapes the
# packages carry: node-pty holds per-variant directories, better-sqlite3
# holds flat <platform>-<arch>.node files.
nodepty="$OUTNM/node-pty/prebuilds"
if [[ -d "$nodepty" ]]; then
    for variant in "$nodepty"/*/; do
        [[ -d "$variant" ]] || continue
        case "$(basename "$variant")" in
            darwin-arm64) ;;
            *) rm -rf "$variant" ;;
        esac
    done
fi
sqlite="$OUTNM/better-sqlite3/prebuilds"
if [[ -d "$sqlite" ]]; then
    for variant in "$sqlite"/*; do
        [[ -e "$variant" ]] || continue
        case "$(basename "$variant")" in
            darwin-arm64 | darwin-arm64.node) ;;
            *) rm -rf "$variant" ;;
        esac
    done
fi

# ─── Gates ──────────────────────────────────────────────────────────────────
# Witness, stated as this script's own gates: every adapter entry exists, and
# each adapter's dependency closure resolves from the staged tree laid out the
# way the bundle carries it — an isolated copy with no repo walk-up to rescue
# a broken stage.

for entry in \
    "@agentclientprotocol/codex-acp/dist/index.js" \
    "@agentclientprotocol/claude-agent-acp/dist/index.js" \
    "agy-acp/dist/main.js"; do
    if [[ ! -f "$OUTNM/$entry" ]]; then
        echo "build-adapters: staged tree is missing $entry" >&2
        exit 1
    fi
done

ISOLATED="$(mktemp -d)"
trap 'rm -rf "$ISOLATED"' EXIT
mkdir -p "$ISOLATED/Resources"
cp -R "$OUTNM" "$ISOLATED/Resources/node_modules"

# require.resolve against package.json-declared deps, from the staged copy.
resolve_check() {
    local pkg_dir="$1"
    (cd "$ISOLATED" && node -e "
        const { createRequire } = require('node:module');
        const req = createRequire('$ISOLATED/Resources/node_modules/$pkg_dir/package.json');
        const p = JSON.parse(require('node:fs').readFileSync('$ISOLATED/Resources/node_modules/$pkg_dir/package.json', 'utf8'));
        const deps = Object.keys(p.dependencies || {});
        const missing = deps.filter(d => { try { req.resolve(d); return false } catch { return true } });
        if (missing.length) { console.error('unresolved: ' + missing.join(', ')); process.exit(1) }
    ")
}
resolve_check "@agentclientprotocol/claude-agent-acp"
resolve_check "agy-acp"
# codex-acp is omitted from resolve_check on purpose: its package.json names
# deps its dist bundle inlines, so a require.resolve gate would demand copies
# nothing imports. Its runtime import set is asserted by the esbuild gate
# below instead.

# Static import gate: esbuild walks each adapter's real import graph
# (--packages=external) over the staged copy in the bundle layout and fails
# if any external specifier does not resolve — the graph as the code draws
# it, not as package.json claims it.
for pkg in "@agentclientprotocol/claude-agent-acp/dist/index.js" \
           "@agentclientprotocol/codex-acp/dist/index.js" \
           "agy-acp/dist/main.js"; do
    if ! failures=$(cd "$ISOLATED/Resources/node_modules" && \
        bunx esbuild --bundle "$pkg" --platform=node --format=esm \
        --packages=external --outfile=/dev/null 2>&1 | \
        grep -E 'Could not resolve|ERROR'); then
        failures=
    fi
    if [[ -n "$failures" ]]; then
        echo "build-adapters: $pkg's imports do not all resolve from the staged tree:" >&2
        echo "$failures" >&2
        exit 1
    fi
done

echo "build-adapters: staged $(du -sh "$OUT" | cut -f1) into $OUT (resolution-witnessed)"
