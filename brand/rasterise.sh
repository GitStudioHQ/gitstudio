#!/bin/sh
# SVG -> PNG at an exact size, via headless Chrome.
#
# NOT cairosvg: it mis-renders `stroke-linecap` on the lane ends and drops the
# gradient stops on the cube faces, which is why the committed PNGs and the SVGs
# drifted apart in the first place. Chrome is the renderer the app itself uses.
#
# The browser is the one every headless check drives, from the shared
# discovery (packages/webview-ui/test/findChrome.mjs): GS_CHROME, then
# Playwright's windowless chrome-headless-shell, then its Chrome for Testing.
# Never the desktop /Applications/Google Chrome.app outside CI — runs that
# fell back to it opened the owner's own Chrome on screen a thousand times.
#
#   ./rasterise.sh <in.svg> <out.png> <size>
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
OUT="$2"; SIZE="$3"
CHROME="$(node "$HERE/../packages/webview-ui/test/findChrome.mjs")"
case "$CHROME" in
  *"Google Chrome.app"*)
    if [ -z "$CI" ]; then
      echo "rasterise.sh: refusing the desktop Chrome ($CHROME); set GS_CHROME to Playwright's chrome-headless-shell" >&2
      exit 1
    fi
    ;;
esac
TMP=$(mktemp -d)
cat > "$TMP/p.html" <<EOF
<!doctype html><html><head><style>
html,body{margin:0;padding:0;background:transparent}
img{width:${SIZE}px;height:${SIZE}px;display:block}
</style></head><body><img src="file://$SRC"></body></html>
EOF
"$CHROME" --headless --disable-gpu \
  --user-data-dir="$TMP/prof" --default-background-color=00000000 \
  --force-device-scale-factor=1 --window-size="$SIZE,$SIZE" \
  --virtual-time-budget=4000 --screenshot="$OUT" "file://$TMP/p.html" >/dev/null 2>&1
rm -rf "$TMP"
echo "wrote $OUT (${SIZE}px)"
