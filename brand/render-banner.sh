#!/usr/bin/env bash
# Rasterize the store banner: apps/extension/media/banner.svg -> banner.png @2x.
#
# The README has to reference the PNG, not the SVG: the VS Code Marketplace
# strips SVG images from extension READMEs, so a vector banner would silently
# render as a broken image on the store page. The SVG stays the source of truth
# and this script keeps the PNG in step with it.
#
# 2560x720 = 2x the SVG's 1280x360 viewBox, so the banner stays crisp on the
# HiDPI displays most of the store's traffic comes from.
set -euo pipefail

cd "$(dirname "$0")/.."
SVG="apps/extension/media/banner.svg"
PNG="apps/extension/media/banner.png"

if ! command -v rsvg-convert >/dev/null 2>&1; then
  echo "rsvg-convert not found — install it with: brew install librsvg" >&2
  exit 1
fi

rsvg-convert -w 2560 -h 720 "$SVG" -o "$PNG"
echo "wrote $PNG ($(du -h "$PNG" | cut -f1))"
