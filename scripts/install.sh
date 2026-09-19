#!/usr/bin/env bash
# GitStudio Desktop — one-line installer for macOS and Linux.
#
#   curl -fsSL https://gitstudio.dev/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/GitStudioHQ/gitstudio/main/scripts/install.sh | bash
#
#   GITSTUDIO_VERSION=2.0.0  pin a version instead of taking the latest
#   GITSTUDIO_PREFIX=~/.local  where Linux puts the AppImage (default ~/.local)
#
# It resolves the newest `app-v*` release, picks the asset for this OS and
# architecture, verifies it downloaded whole, and installs it where the platform
# expects. Nothing is installed system-wide on Linux and nothing needs sudo; the
# .deb and .rpm are separate downloads.
set -euo pipefail

REPO="GitStudioHQ/gitstudio"
API="https://api.github.com/repos/${REPO}/releases"
PREFIX="${GITSTUDIO_PREFIX:-$HOME/.local}"

say()  { printf '\033[1;35m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "this installer needs '$1' on your PATH"; }
need curl
need uname

# ── Which build? ─────────────────────────────────────────────────────────────
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin) plat=mac ;;
  Linux)  plat=linux ;;
  *) die "unsupported OS '$os'. Windows: see https://github.com/${REPO}/releases/latest" ;;
esac
case "$arch" in
  arm64|aarch64) cpu=arm64 ;;
  x86_64|amd64)  cpu=x64 ;;
  *) die "unsupported architecture '$arch'" ;;
esac
# Linux ships one universal x86_64 AppImage; there is no arm64 build yet.
if [ "$plat" = linux ] && [ "$cpu" != x64 ]; then
  die "Linux builds are x86_64 only for now. Build from source: https://github.com/${REPO}"
fi

# ── Which release? ───────────────────────────────────────────────────────────
# `releases/latest` is whatever the repo marks Latest, which is the desktop app
# — but the extension also tags here, so filter to `app-v*` explicitly rather
# than trusting the pointer.
if [ -n "${GITSTUDIO_VERSION:-}" ]; then
  # Accept 2.0.0, v2.0.0 or app-v2.0.0 and normalise to one tag.
  want="${GITSTUDIO_VERSION}"
  want="${want#app-v}"
  want="${want#v}"
  tag="app-v${want}"
else
  say "Finding the latest release…"
  tag="$(curl -fsSL "${API}?per_page=30" \
    | grep -o '"tag_name": *"app-v[^"]*"' \
    | head -n 1 | sed 's/.*"app-v/app-v/; s/"$//')"
  [ -n "$tag" ] || die "could not find an app-v* release — is GitHub reachable?"
fi
version="${tag#app-v}"
say "GitStudio ${version} for ${plat}/${cpu}"

case "$plat" in
  mac)   asset="GitStudio-${version}-${cpu}.dmg" ;;
  linux) asset="GitStudio-${version}-x86_64.AppImage" ;;
esac
url="https://github.com/${REPO}/releases/download/${tag}/${asset}"

tmp="$(mktemp -d)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

say "Downloading ${asset}…"
curl -fL --progress-bar -o "${tmp}/${asset}" "$url" \
  || die "download failed — ${url}"
# A truncated download is the failure that looks like a corrupt app later.
[ -s "${tmp}/${asset}" ] || die "downloaded file is empty"

# SHA256SUMS.txt is attached to the release when the workflow produces one; if
# it is there, use it. A missing checksum file is not fatal — an unverified
# install is still better than telling someone to go and click a link — but it
# says so out loud.
if curl -fsSL -o "${tmp}/SHA256SUMS.txt" \
     "https://github.com/${REPO}/releases/download/${tag}/SHA256SUMS.txt" 2>/dev/null; then
  if command -v shasum >/dev/null 2>&1; then sum="shasum -a 256"
  elif command -v sha256sum >/dev/null 2>&1; then sum="sha256sum"
  else sum=""; fi
  if [ -n "$sum" ]; then
    expect="$(grep " ${asset}\$" "${tmp}/SHA256SUMS.txt" | awk '{print $1}' || true)"
    if [ -n "$expect" ]; then
      got="$(cd "$tmp" && $sum "$asset" | awk '{print $1}')"
      [ "$expect" = "$got" ] || die "checksum mismatch for ${asset} — refusing to install"
      say "Checksum verified."
    fi
  fi
else
  warn "No SHA256SUMS.txt on this release; skipping checksum verification."
fi

# ── Install ──────────────────────────────────────────────────────────────────
if [ "$plat" = mac ]; then
  need hdiutil
  say "Mounting the disk image…"
  mnt="$(hdiutil attach -nobrowse -readonly "${tmp}/${asset}" | awk '/\/Volumes\//{ $1=$2=""; sub(/^  */,""); print; exit }')"
  [ -n "$mnt" ] || die "could not mount ${asset}"
  detach() { hdiutil detach "$mnt" -quiet >/dev/null 2>&1 || true; cleanup; }
  trap detach EXIT
  app="$(find "$mnt" -maxdepth 1 -name '*.app' -print -quit)"
  [ -n "$app" ] || die "no .app inside ${asset}"
  dest="/Applications/$(basename "$app")"
  # Quit a running copy first: replacing the bundle under a live process leaves
  # it half-updated and the next launch reads a mix of two versions.
  if pgrep -f "${dest}/Contents/MacOS/" >/dev/null 2>&1; then
    say "Quitting the running GitStudio…"
    osascript -e 'tell application "GitStudio" to quit' >/dev/null 2>&1 || true
    sleep 2
  fi
  say "Installing to ${dest}…"
  rm -rf "$dest"
  cp -R "$app" "/Applications/" || die "could not write to /Applications — try: sudo -v, then re-run"
  # Gatekeeper quarantines anything downloaded; on macOS 15+ an unsigned build
  # is then refused as "damaged", and right-click ▸ Open no longer helps.
  # Stripping the attribute is the only way through. -s: act on symlinks
  # themselves, not their targets — Electron's frameworks are full of them and
  # a tagged link is enough for Gatekeeper to refuse.
  xattr -d -r -s com.apple.quarantine "$dest" >/dev/null 2>&1 || true
  say "Installed. Open it from Launchpad, or: open -a GitStudio"
else
  mkdir -p "${PREFIX}/bin" "${PREFIX}/share/applications" "${PREFIX}/share/icons/hicolor/512x512/apps"
  bin="${PREFIX}/bin/gitstudio"
  say "Installing to ${bin}…"
  install -m 0755 "${tmp}/${asset}" "$bin"
  # The launcher icon is inside the AppImage; --appimage-extract needs no FUSE.
  icon="$(cd "$tmp" && "$bin" --appimage-extract '*.png' >/dev/null 2>&1 && ls squashfs-root/*.png 2>/dev/null | head -n 1 || true)"
  if [ -n "$icon" ]; then
    install -m 0644 "${tmp}/${icon}" "${PREFIX}/share/icons/hicolor/512x512/apps/gitstudio.png"
  fi
  # A .desktop entry so it appears in the launcher like a real application,
  # not only as something you can type.
  cat > "${PREFIX}/share/applications/gitstudio.desktop" <<EOF
[Desktop Entry]
Name=GitStudio
Comment=A JetBrains-grade Git suite for your desktop
Exec=${bin} %U
Icon=gitstudio
Terminal=false
Type=Application
Categories=Development;RevisionControl;
StartupWMClass=GitStudio
EOF
  say "Installed. Run: gitstudio"
  # The AppImage runtime mounts itself with FUSE 2, which Ubuntu 22.04+ and
  # Debian 12 no longer install by default. Say so now, not at first launch.
  if ! { ldconfig -p 2>/dev/null || /sbin/ldconfig -p 2>/dev/null; } | grep -q 'libfuse\.so\.2'; then
    warn "AppImages need libfuse2 and this machine has none:"
    warn "  Debian/Ubuntu: sudo apt install libfuse2   (libfuse2t64 on Ubuntu 24.04)"
    warn "  Fedora/RHEL:   sudo dnf install fuse-libs"
    warn "Or take the .deb/.rpm from https://github.com/${REPO}/releases/latest instead."
  fi
  case ":${PATH}:" in
    *":${PREFIX}/bin:"*) ;;
    *) warn "${PREFIX}/bin is not on your PATH — add it to your shell profile." ;;
  esac
fi
