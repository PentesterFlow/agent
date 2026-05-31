#!/bin/sh
# pentesterflow online installer (macOS / Linux).
#
#   curl -fsSL https://raw.githubusercontent.com/PentesterFlow/agent/main/install.sh | sh
#
# Downloads the standalone binary for your OS/arch from the latest GitHub
# release, verifies its SHA-256, and installs it to ~/.local/bin.
#
# Environment overrides:
#   PENTESTERFLOW_VERSION=v0.1.0      pin a release tag (default: latest)
#   PENTESTERFLOW_INSTALL_DIR=/path   install location (default: ~/.local/bin)
set -eu

REPO="${PENTESTERFLOW_REPO:-PentesterFlow/agent}"
BIN="pentesterflow"

info() { printf '%s\n' "$*" >&2; }
err() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

# --- downloader (curl or wget) -------------------------------------------
if command -v curl >/dev/null 2>&1; then
  dl() { curl -fL --proto '=https' --tlsv1.2 -sS "$1" -o "$2"; }
  dl_stdout() { curl -fL --proto '=https' --tlsv1.2 -sS "$1"; }
elif command -v wget >/dev/null 2>&1; then
  dl() { wget -q -O "$2" "$1"; }
  dl_stdout() { wget -q -O- "$1"; }
else
  err "need either curl or wget installed"
fi

# --- detect platform ------------------------------------------------------
os=$(uname -s)
case "$os" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) err "unsupported OS '$os' — on Windows use install.ps1 instead" ;;
esac

arch=$(uname -m)
case "$arch" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) err "unsupported architecture '$arch'" ;;
esac

asset="${BIN}-${os}-${arch}"

ver="${PENTESTERFLOW_VERSION:-latest}"
case "$ver" in
  latest | v*) ;;
  [0-9]*) ver="v${ver}" ;;
esac

if [ "$ver" = "latest" ]; then
  base="https://github.com/${REPO}/releases/latest/download"
else
  base="https://github.com/${REPO}/releases/download/${ver}"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

# --- download -------------------------------------------------------------
info "downloading ${asset} (${ver})..."
dl "${base}/${asset}" "${tmp}/${asset}" || err "download failed: ${base}/${asset}"
[ -s "${tmp}/${asset}" ] || err "downloaded asset is empty: ${base}/${asset}"

# --- verify checksum (best-effort) ---------------------------------------
if dl_stdout "${base}/SHA256SUMS" >"${tmp}/SHA256SUMS" 2>/dev/null && [ -s "${tmp}/SHA256SUMS" ]; then
  want=$(awk -v a="$asset" '$2==a {print $1}' "${tmp}/SHA256SUMS" | head -n1)
  if [ -n "$want" ]; then
    if command -v sha256sum >/dev/null 2>&1; then
      got=$(sha256sum "${tmp}/${asset}" | awk '{print $1}')
    elif command -v shasum >/dev/null 2>&1; then
      got=$(shasum -a 256 "${tmp}/${asset}" | awk '{print $1}')
    else
      got=""
    fi
    if [ -n "$got" ] && [ "$got" != "$want" ]; then
      err "checksum mismatch for ${asset} (expected ${want}, got ${got})"
    fi
    if [ -n "$got" ]; then
      info "checksum ok"
    else
      info "warning: no SHA-256 tool found — skipping checksum verification"
    fi
  else
    info "warning: SHA256SUMS does not contain ${asset} — skipping checksum verification"
  fi
else
  info "warning: SHA256SUMS unavailable — skipping checksum verification"
fi

# --- install --------------------------------------------------------------
if [ -n "${PENTESTERFLOW_INSTALL_DIR:-}" ]; then
  dir="$PENTESTERFLOW_INSTALL_DIR"
else
  [ -n "${HOME:-}" ] || err "HOME is not set; set PENTESTERFLOW_INSTALL_DIR explicitly"
  dir="$HOME/.local/bin"
fi

mkdir -p "$dir"
chmod 0755 "${tmp}/${asset}"
dest="${dir}/${BIN}"
staged="${dir}/.${BIN}.tmp.$$"
rm -f "$staged"
cp "${tmp}/${asset}" "$staged" || err "failed to stage binary in ${dir}"
chmod 0755 "$staged"
mv -f "$staged" "$dest" || err "failed to install binary to ${dest}"

# macOS: drop the quarantine attribute so Gatekeeper doesn't block the
# unsigned binary on first run.
if [ "$os" = darwin ] && command -v xattr >/dev/null 2>&1; then
  xattr -d com.apple.quarantine "$dest" 2>/dev/null || true
fi

info "installed ${BIN} -> ${dest}"

case ":${PATH:-}:" in
  *":${dir}:"*) : ;;
  *) info "note: ${dir} is not on your PATH — add this to your shell profile:
    export PATH=\"${dir}:\$PATH\"" ;;
esac

"$dest" --version 2>/dev/null || info "run '${BIN} --help' to get started"
