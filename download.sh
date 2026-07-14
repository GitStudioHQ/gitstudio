#!/usr/bin/env bash
# Build the downloadable GitStudio distributions and collect them in ./downloads.
#   ./download.sh            build the extension VSIX + desktop installers (this OS/arch)
#   ./download.sh ext        only the extension VSIX
#   ./download.sh app        only the desktop installers
# Cross-OS builds (Windows/Linux + both mac arches) are produced by CI — see the
# tag hint printed at the end. electron-builder cannot cross-compile these locally.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
OUT="$ROOT/downloads"
what="${1:-all}"

ext_ver() { node -e "console.log(require('./apps/extension/package.json').version)"; }
app_ver() { node -e "console.log(require('./apps/desktop/package.json').version)"; }

build_ext() {
  local v; v="$(ext_ver)"
  echo "▸ Extension bundle + VSIX (v$v)…"
  npm run -w apps/extension package >/dev/null
  ( cd apps/extension && npx @vscode/vsce package -o "gitstudio-${v}.vsix" --no-dependencies >/dev/null )
  echo "  built apps/extension/gitstudio-${v}.vsix"
}

build_app() {
  echo "▸ Desktop installers (v$(app_ver), $(uname -s)/$(uname -m) only)…"
  npm run -w apps/desktop dist
}

mkdir -p "$OUT"
did_ext=0; did_app=0
case "$what" in
  ext) build_ext; did_ext=1 ;;
  app) build_app; did_app=1 ;;
  all) build_ext; did_ext=1; build_app; did_app=1 ;;
  *) echo "usage: ./download.sh [ext|app|all]"; exit 2 ;;
esac

echo "▸ Collecting into downloads/…"
rm -f "$OUT"/*
shopt -s nullglob
# Only the CURRENT version's VSIX (not stale ones left in the tree).
if [ "$did_ext" = 1 ]; then
  cp "apps/extension/gitstudio-$(ext_ver).vsix" "$OUT/"
fi
# Desktop installers + update feed — only when we actually (re)built them.
if [ "$did_app" = 1 ]; then
  for f in \
    apps/desktop/release/*.dmg \
    apps/desktop/release/*.zip \
    apps/desktop/release/*.exe \
    apps/desktop/release/*.AppImage \
    apps/desktop/release/*.deb \
    apps/desktop/release/latest*.yml; do
    cp "$f" "$OUT/"
  done
fi

# Checksums (exclude the sums file itself).
( cd "$OUT" && find . -maxdepth 1 -type f ! -name SHA256SUMS.txt -exec shasum -a 256 {} + \
  | sed 's#\./##' > SHA256SUMS.txt )

echo
echo "✓ Downloads ready → $OUT"
ls -lh "$OUT" | awk 'NR>1{printf "   %-42s %s\n", $9, $5}'
echo
echo "NOTE: the desktop app is UNSIGNED locally — recipients run:"
echo "        xattr -cr /Applications/GitStudio.app   (after dragging from the .dmg)"
echo "NOTE: this built installers for THIS OS/arch only. For Windows + Linux + both"
echo "      mac arches, cut a release via CI:"
echo "        git tag app-v$(app_ver) && git push origin app-v$(app_ver)   # desktop"
echo "        git tag ext-v$(ext_ver) && git push origin ext-v$(ext_ver)   # extension"
