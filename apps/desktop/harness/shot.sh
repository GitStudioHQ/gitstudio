#!/bin/sh
# shot.sh <scene> <out.png> [theme] — screenshot one harness scene headlessly.
#
# A scene is "<view>[~step[~step…]]" — steps run after the repo screen mounts:
#   open<N>          click the list row with data-num="<N>" (open a detail)
#   click:<selector> click the first match (URL-encode [ ] = as %5B %5D %3D)
#   esc              dispatch Escape (detail → list)
#   palette          open the ⌘K palette
#   bell             open the notifications popover
#
# A 4th argument is appended to the query string, for the scene switches the
# shim reads directly (e.g. "staging=checkboxes", "many=1", "ask=1").
# Examples:
#   ./shot.sh issues out/issues.png
#   ./shot.sh 'issues~open31' out/detail.png light
#   ./shot.sh 'prs~open106~click:.gh-subtab%5Bdata-sub%3Dfiles%5D' out/files.png
set -e
HARNESS="$(cd "$(dirname "$0")" && pwd)"
SCENE="${1:-issues}"
OUT="${2:-$HARNESS/out/$SCENE.png}"
THEME="${3:-dark}"
EXTRA="${4:-}"
mkdir -p "$(dirname "$OUT")"
# Its own throwaway profile: left to itself headless Chrome leaves a
# .com.google.Chrome.* directory in $TMPDIR behind on every launch.
PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/gs-shot-XXXXXX")"
trap 'rm -rf "$PROFILE"' EXIT
"${GS_CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}" \
  --headless --disable-gpu --hide-scrollbars --user-data-dir="$PROFILE" \
  --window-size=1600,1000 --force-device-scale-factor=2 \
  --virtual-time-budget=9000 \
  --screenshot="$OUT" \
  "file://${GS_HARNESS_PAGE:-$HARNESS/page}/harness.html?scene=$SCENE&theme=$THEME${EXTRA:+&$EXTRA}" 2>&1 | grep -viE 'devtools|gpu|fontations|dawn|install' || true
echo "wrote $OUT"
