#!/usr/bin/env bash
# =============================================================================
# temper-contrib — Claude Code on the web environment setup
# =============================================================================
#
# SessionStart hook (.claude/settings.json). Runs on every cloud session start and resume, so it
# must stay fast and idempotent: each step checks before it installs.
#
#   default   git hooks, the lint toolchain (cargo-make, gitleaks, actionlint, shellcheck, ruff),
#             the desktop's node_modules and the Python venvs. Seconds on a warm container.
#   --full    also the Tauri Linux packages `cargo check/clippy/test` in src-tauri need
#             (webkit2gtk and friends, the list CI installs). About a minute; run it on demand.
#
# Outside a cloud session it does nothing unless FORCE_SETUP=1. Every step that fails warns and
# carries on: a missing tool means a skipped local gate, and CI runs every gate regardless.
set -uo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ] && [ "${FORCE_SETUP:-}" != "1" ]; then
  exit 0
fi

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT" || exit 0

# Pinned tool versions: bump deliberately, in one place.
CARGO_MAKE_VERSION="0.37.24"
GITLEAKS_VERSION="8.30.1"
ACTIONLINT_VERSION="1.7.7"

BIN="$HOME/.local/bin"
mkdir -p "$BIN"
export PATH="$BIN:$HOME/.cargo/bin:$PATH"
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  # shellcheck disable=SC2016
  echo 'export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"' >>"$CLAUDE_ENV_FILE"
fi

ok() { echo "  ✓ $1"; }
warn() { echo "  ! $1" >&2; }
has() { command -v "$1" >/dev/null 2>&1; }
SUDO=""
if [ "$(id -u)" != "0" ] && has sudo; then SUDO="sudo"; fi

echo "==> temper-contrib: preparing the cloud session"

git config core.hooksPath githooks && chmod +x githooks/* && ok "git hooks: githooks/"

apt_install() {
  has apt-get || { warn "no apt-get; install $* by hand"; return 1; }
  $SUDO apt-get install -y -qq "$@" >/dev/null 2>&1 \
    || { $SUDO apt-get update -qq >/dev/null 2>&1 && $SUDO apt-get install -y -qq "$@" >/dev/null 2>&1; }
}

if has shellcheck; then
  ok "shellcheck"
elif apt_install shellcheck; then
  ok "shellcheck installed"
else
  warn "shellcheck install failed"
fi

if has cargo-make; then
  ok "cargo-make"
else
  tmp="$(mktemp -d)"
  name="cargo-make-v${CARGO_MAKE_VERSION}-x86_64-unknown-linux-gnu"
  if curl -fsSL -o "$tmp/cm.zip" "https://github.com/sagiegurari/cargo-make/releases/download/${CARGO_MAKE_VERSION}/${name}.zip" \
    && unzip -oq "$tmp/cm.zip" -d "$tmp" && install -m 0755 "$tmp/$name/cargo-make" "$BIN/cargo-make"; then
    ok "cargo-make ${CARGO_MAKE_VERSION} installed"
  else
    warn "cargo-make install failed (cargo install cargo-make)"
  fi
  rm -rf "$tmp"
fi

if has gitleaks; then
  ok "gitleaks"
else
  tmp="$(mktemp -d)"
  tarball="gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
  base="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}"
  if (cd "$tmp" && curl -fsSLO "$base/$tarball" && curl -fsSLO "$base/gitleaks_${GITLEAKS_VERSION}_checksums.txt" \
    && grep " $tarball\$" "gitleaks_${GITLEAKS_VERSION}_checksums.txt" | sha256sum -c - >/dev/null \
    && tar -xzf "$tarball" gitleaks) && install -m 0755 "$tmp/gitleaks" "$BIN/gitleaks"; then
    ok "gitleaks ${GITLEAKS_VERSION} installed (checksum-verified)"
  else
    warn "gitleaks install failed"
  fi
  rm -rf "$tmp"
fi

if has actionlint; then
  ok "actionlint"
else
  tmp="$(mktemp -d)"
  tarball="actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz"
  base="https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}"
  if (cd "$tmp" && curl -fsSLO "$base/$tarball" && curl -fsSLO "$base/actionlint_${ACTIONLINT_VERSION}_checksums.txt" \
    && grep " $tarball\$" "actionlint_${ACTIONLINT_VERSION}_checksums.txt" | sha256sum -c - >/dev/null \
    && tar -xzf "$tarball" actionlint) && install -m 0755 "$tmp/actionlint" "$BIN/actionlint"; then
    ok "actionlint ${ACTIONLINT_VERSION} installed (checksum-verified)"
  else
    warn "actionlint install failed"
  fi
  rm -rf "$tmp"
fi

if has ruff; then
  ok "ruff"
elif has uv; then
  if uv tool install -q ruff >/dev/null 2>&1; then ok "ruff installed"; else warn "ruff install failed"; fi
else
  warn "uv not on PATH; ruff and the Python venvs are unavailable"
fi

if has uv; then
  for dir in plugins/author-tools themes; do
    if (cd "$dir" && uv sync -q >/dev/null 2>&1); then ok "uv sync: $dir"; else warn "uv sync failed: $dir"; fi
  done
fi

if [ -d apps/desktop/node_modules ]; then
  ok "apps/desktop/node_modules"
elif has npm; then
  if (cd apps/desktop && npm ci --silent >/dev/null 2>&1); then ok "npm ci: apps/desktop"; else warn "npm ci failed: apps/desktop"; fi
fi

if [ "${1:-}" = "--full" ]; then
  if dpkg -s libwebkit2gtk-4.1-dev >/dev/null 2>&1; then
    ok "Tauri Linux packages"
  elif apt_install libwebkit2gtk-4.1-dev build-essential file libxdo-dev libssl-dev \
    libayatana-appindicator3-dev librsvg2-dev; then
    ok "Tauri Linux packages installed"
  else
    warn "Tauri Linux packages failed to install"
  fi
elif ! dpkg -s libwebkit2gtk-4.1-dev >/dev/null 2>&1; then
  echo "  · Rust gates (cargo make check/test) need the Tauri Linux packages: tools/setup-claude-web.sh --full"
fi

echo "==> ready: cargo make check · cargo make test"
exit 0
