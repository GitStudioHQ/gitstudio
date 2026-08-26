#!/bin/sh
# shot.sh <scene> <out.png> [theme] — screenshot one harness scene headlessly.
#
# A scene is "<view>[~step[~step…]]" — steps run after the repo screen mounts:
#   open<N>          click the list row with data-num="<N>" (open a detail)
#   click:<selector> click the first match (URL-encode [ ] = as %5B %5D %3D)
#   esc              dispatch Escape (detail → list)
#   palette          open the ⌘K palette
#   bell             open the notifications popover
# Examples:
#   ./shot.sh issues out/issues.png
#   ./shot.sh 'issues~open31' out/detail.png light
#   ./shot.sh 'prs~open106~click:.gh-subtab%5Bdata-sub%3Dfiles%5D' out/files.png
set -e
HARNESS="$(cd "$(dirname "$0")" && pwd)"
SCENE="${1:-issues}"
OUT="${2:-$HARNESS/out/$SCENE.png}"
THEME="${3:-dark}"
mkdir -p "$(dirname "$OUT")"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --hide-scrollbars \
  --window-size=1600,1000 --force-device-scale-factor=2 \
  --virtual-time-budget=9000 \
  --screenshot="$OUT" \
  "file://$HARNESS/page/harness.html?scene=$SCENE&theme=$THEME" 2>&1 | grep -viE 'devtools|gpu|fontations|dawn|install' || true
echo "wrote $OUT"
