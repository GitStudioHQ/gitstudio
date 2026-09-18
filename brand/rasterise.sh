#!/bin/sh
# SVG -> PNG at an exact size, via headless Chrome.
#
# NOT cairosvg: it mis-renders `stroke-linecap` on the lane ends and drops the
# gradient stops on the cube faces, which is why the committed PNGs and the SVGs
# drifted apart in the first place. Chrome is the renderer the app itself uses.
#
#   ./rasterise.sh <in.svg> <out.png> <size>
set -e
SRC="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
OUT="$2"; SIZE="$3"
TMP=$(mktemp -d)
cat > "$TMP/p.html" <<EOF
<!doctype html><html><head><style>
html,body{margin:0;padding:0;background:transparent}
img{width:${SIZE}px;height:${SIZE}px;display:block}
</style></head><body><img src="file://$SRC"></body></html>
EOF
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu \
  --user-data-dir="$TMP/prof" --default-background-color=00000000 \
  --force-device-scale-factor=1 --window-size="$SIZE,$SIZE" \
  --virtual-time-budget=4000 --screenshot="$OUT" "file://$TMP/p.html" >/dev/null 2>&1
rm -rf "$TMP"
echo "wrote $OUT (${SIZE}px)"
