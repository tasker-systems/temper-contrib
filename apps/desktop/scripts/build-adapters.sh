#!/usr/bin/env bash
# Stages the bundled ACP adapters into apps/desktop/acp-adapter-staging/:
# each adapter package plus the dependencies it actually resolves, cleaned of
# sources, tests, typings and maps. The staging tree is what tauri.conf.json's
# bundle.resources ships as acp-adapters/ inside the app, and what
# adapters.rs resolves in dev. Harness binaries are never staged — the
# adapters wrap the person's own claude/codex/agy, resolved at launch.
#
# Run from anywhere; paths are repo-relative. Idempotent: the staging tree is
# deleted and rebuilt each run.
set -euo pipefail

DESKTOP="$(cd "$(dirname "$0")/.." && pwd)"
NM="$DESKTOP/node_modules"
OUT="$DESKTOP/acp-adapter-staging"

if [[ ! -d "$NM" ]]; then
    echo "build-adapters: $NM is missing — run bun install first" >&2
    exit 1
fi

rm -rf "$OUT"
mkdir -p "$OUT"

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

# stage <source relative to node_modules> <staging name> [extra prune args]
stage() {
    local src="$NM/$1"
    local dest="$OUT/$2"
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
stage "@agentclientprotocol/codex-acp" "codex-acp"

stage "@agentclientprotocol/claude-agent-acp" "claude-agent-acp"
stage "@agentclientprotocol/sdk" "@agentclientprotocol/sdk"
stage "@anthropic-ai/claude-agent-sdk" "@anthropic-ai/claude-agent-sdk"
stage "diff" "diff"

stage "agy-acp" "agy-acp"
stage "@bufbuild/protobuf" "@bufbuild/protobuf"
stage "node-pty" "node-pty"
stage "better-sqlite3" "better-sqlite3"
# Native modules: keep only this platform's prebuilds. The build/Release tree
# is bun install's compiled output for this machine and stays whole.
keep="Prebuilds/darwin-arm64"
for pkg in node-pty better-sqlite3; do
    prebuilds="$OUT/$pkg/prebuilds"
    if [[ -d "$prebuilds" ]]; then
        for variant in "$prebuilds"/*/; do
            case "$(basename "$variant")" in
                darwin-arm64) ;;
                *) rm -rf "$variant" ;;
            esac
        done
    fi
done

# zod: the claude adapter imports it at runtime (the codex bundle has its own
# copy inlined). Keep the pin aligned with the adapters' package.json ranges.
stage "zod" "zod"

# Witness, stated as this script's own gate: every adapter entry file exists.
for entry in \
    "codex-acp/dist/index.js" \
    "claude-agent-acp/dist/index.js" \
    "agy-acp/dist/main.js"; do
    if [[ ! -f "$OUT/$entry" ]]; then
        echo "build-adapters: staged tree is missing $entry" >&2
        exit 1
    fi
done

echo "build-adapters: staged $(du -sh "$OUT" | cut -f1) into $OUT"
