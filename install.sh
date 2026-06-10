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
#   PENTESTERFLOW_SKILLS_DIR=/path    shipped skills location (default: ~/.pentesterflow/builtin-skills)
#   PENTESTERFLOW_SKIP_SKILLS=1       install binary only
#   PENTESTERFLOW_SKIP_CHECKSUM=1     install without SHA-256 verification (unsafe)
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

# --- verify checksum (required; fail-closed) -----------------------------
# A self-updating binary must not install an unverified download. Any failure
# to verify is fatal. Set PENTESTERFLOW_SKIP_CHECKSUM=1 to override (e.g. an
# air-gapped mirror you trust by other means).
if [ "${PENTESTERFLOW_SKIP_CHECKSUM:-}" = "1" ]; then
  info "warning: PENTESTERFLOW_SKIP_CHECKSUM=1 set — installing WITHOUT checksum verification"
else
  dl_stdout "${base}/SHA256SUMS" >"${tmp}/SHA256SUMS" 2>/dev/null ||
    err "could not download SHA256SUMS from ${base} — refusing to install an unverified binary (set PENTESTERFLOW_SKIP_CHECKSUM=1 to override)"
  [ -s "${tmp}/SHA256SUMS" ] ||
    err "downloaded SHA256SUMS is empty — refusing to install an unverified binary"
  want=$(awk -v a="$asset" '$2==a {print $1}' "${tmp}/SHA256SUMS" | head -n1)
  [ -n "$want" ] ||
    err "SHA256SUMS does not list ${asset} — refusing to install an unverified binary"
  if command -v sha256sum >/dev/null 2>&1; then
    got=$(sha256sum "${tmp}/${asset}" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    got=$(shasum -a 256 "${tmp}/${asset}" | awk '{print $1}')
  else
    err "no sha256sum/shasum tool found — cannot verify the download (set PENTESTERFLOW_SKIP_CHECKSUM=1 to override)"
  fi
  [ "$got" = "$want" ] ||
    err "checksum mismatch for ${asset} (expected ${want}, got ${got})"
  info "checksum ok"
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

# --- install shipped skills ----------------------------------------------
if [ "${PENTESTERFLOW_SKIP_SKILLS:-}" != "1" ]; then
  if [ -n "${PENTESTERFLOW_SKILLS_DIR:-}" ]; then
    skills_dir="$PENTESTERFLOW_SKILLS_DIR"
  else
    [ -n "${HOME:-}" ] || err "HOME is not set; set PENTESTERFLOW_SKILLS_DIR explicitly"
    skills_dir="$HOME/.pentesterflow/builtin-skills"
  fi

  if command -v tar >/dev/null 2>&1; then
    archive_ref="$ver"
    [ "$archive_ref" = "latest" ] && archive_ref="latest"
    archive_url="https://github.com/${REPO}/archive/refs/tags/${archive_ref}.tar.gz"
    info "installing shipped skills -> ${skills_dir}..."
    if ! dl "$archive_url" "${tmp}/source.tar.gz"; then
      archive_url="https://github.com/${REPO}/archive/refs/heads/main.tar.gz"
      dl "$archive_url" "${tmp}/source.tar.gz" || err "download failed: ${archive_url}"
    fi
    mkdir -p "${tmp}/source"
    tar -xzf "${tmp}/source.tar.gz" -C "${tmp}/source" || err "failed to extract skills archive"
    skills_src=$(find "${tmp}/source" -type d -path "*/skills" | head -n1)
    if [ -n "$skills_src" ] && [ -d "$skills_src" ]; then
      skills_stage="${skills_dir}.tmp.$$"
      rm -rf "$skills_stage"
      mkdir -p "$skills_stage"
      cp -R "$skills_src"/. "$skills_stage"/ || err "failed to stage shipped skills"
      rm -rf "$skills_dir"
      mkdir -p "$(dirname "$skills_dir")"
      mv "$skills_stage" "$skills_dir" || err "failed to install shipped skills"
      info "installed shipped skills -> ${skills_dir}"
    else
      info "warning: skills directory not found in source archive — skipping skills install"
    fi
  else
    info "warning: tar not found — skipping skills install"
  fi
fi

case ":${PATH:-}:" in
  *":${dir}:"*) : ;;
  *) info "note: ${dir} is not on your PATH — add this to your shell profile:
    export PATH=\"${dir}:\$PATH\"" ;;
esac

"$dest" --version 2>/dev/null || info "run '${BIN} --help' to get started"
