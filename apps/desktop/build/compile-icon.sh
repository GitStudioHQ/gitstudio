#!/bin/sh
# Compiles the macOS app icon. Run on a Mac with Xcode 26+ after changing the
# brand artwork; the outputs are committed so CI needs no Xcode.
#
#   build/AppIcon.icon/           Icon Composer source: icon.json + Assets/cube.svg
#                                 (the cube from brand/gitstudio-icon.svg, without
#                                 the tile — the system paints the tile).
#
# THE TILE IS ONE GREY, IN BOTH APPEARANCES, ON PURPOSE.
#
# macOS 26 icons can carry light / dark / tinted variants, and "automatic" as
# the fill does get you two: the system's own light background in Light and its
# dark one in Dark. We shipped that briefly and it was wrong — the system light
# background is near-white (#EEEEEF), which is glaring in a dock and leaves the
# violet cube with very little to sit against.
#
# A CUSTOM colour per appearance is NOT reachable from a hand-written manifest.
# `fill-specializations` (an array of {appearance, value}, which is the
# documented shape) compiles without complaint and even produces two background
# assets in the compiled catalog, but the colours never reach the renderer:
# with light=red and dark=green the icon still renders the system grey, while a
# plain solid red renders red. Twenty-odd encodings were tried, with and without
# --include-all-app-icons, each read back by decompiling Assets.car. Authoring
# real per-appearance colour needs Icon Composer itself.
#
# So: one deliberate grey, close to a VS Code sidebar, which never glares in
# Light and still reads as "dark app icon" in Dark. The cube's viewBox is
# zoomed (33 33 446 446, not 0 0 512 512) so the art fills the tile the way
# Apple's grid expects — at dock size the old framing read as a small mark
# floating in a large empty square.
#
# NOTE: build/icon.icns comes from brand/gitstudio-dock-1024.png, NOT from this
# SVG, so it does not inherit the zoom. It is only used on macOS 11-15.

set -e
cd "$(dirname "$0")"
OUT=$(mktemp -d)
# ABSOLUTE path: actool fails on a relative .icon input with a misleading
# "couldn't be opened because there is no such file", exits 1, and STILL prints
# a compilation-results plist — so a pipeline that only eyeballs stdout happily
# packages a stale Assets.car.
actool "$PWD/AppIcon.icon" --compile "$OUT" --app-icon AppIcon --platform macosx \
  --minimum-deployment-target 11.0 --output-partial-info-plist "$OUT/partial.plist" \
  --include-all-app-icons >/dev/null
[ -f "$OUT/Assets.car" ] || { echo "actool produced no Assets.car" >&2; exit 1; }
mkdir -p mac
cp "$OUT/Assets.car" mac/Assets.car
ISET="$OUT/icon.iconset"; mkdir -p "$ISET"
python3 - "$ISET" <<'PY'
import sys
from PIL import Image
src = Image.open("../../../brand/gitstudio-dock-1024.png").convert("RGBA")
for n in (16, 32, 128, 256, 512):
    src.resize((n, n), Image.LANCZOS).save(f"{sys.argv[1]}/icon_{n}x{n}.png")
    src.resize((n * 2, n * 2), Image.LANCZOS).save(f"{sys.argv[1]}/icon_{n}x{n}@2x.png")
PY
iconutil -c icns "$ISET" -o icon.icns
rm -rf "$OUT"
echo "compiled mac/Assets.car and icon.icns"
