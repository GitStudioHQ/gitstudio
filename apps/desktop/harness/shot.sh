#!/bin/sh
# shot.sh <scene> <out.png> [theme] — screenshot one harness scene headlessly.
#
# A scene is "<view>[~step[~step…]]" — steps run after the repo screen mounts:
#   open<N>          click the list row with data-num="<N>" (open a detail)
#   click:<selector> click the first match (URL-encode [ ] = as %5B %5D %3D)
#   rclick:<selector> right-click it (the graph row's commit menu)
#   mclick:<selector> Cmd-click it; sclick:<selector> Shift-click it (select several)
#   shiftclick:<selector> / modclick:<selector>  click with Shift, or with
#                    ⌘ (Mac) / Ctrl — how a list is multi-selected
#   key:<key>        a key on the focused element; modifiers go first, each
#                    followed by "+" (URL-encode it: key:Shift%2BArrowDown)
#   wait:<ms>        hold the scene; the shot is taken when the time budget
#                    (9 s) runs out, so wait BEFORE the step that raises a
#                    state lasting only a few seconds (a banner's flash)
#   esc              dispatch Escape (detail → list)
#   palette          open the ⌘K palette
#   bell             open the notifications popover
#
# GS_SHOT_SIZE=880,700 shoots a narrower (or smaller) window than 1600x1000.
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
# GS_CHROME, else Playwright's windowless chrome-headless-shell, and only then a
# system Chrome — the one order, in packages/webview-ui/test/findChrome.mjs.
CHROME="$(node "$HARNESS/../../../packages/webview-ui/test/findChrome.mjs")"
# Its own throwaway profile: left to itself headless Chrome leaves a
# .com.google.Chrome.* directory in $TMPDIR behind on every launch.
PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/gs-shot-XXXXXX")"
trap 'rm -rf "$PROFILE"' EXIT
# --headless and no network but this machine's: the switches every test's
# Chrome starts from, one per line (scripts/test/no-network-chrome.mjs). The
# resolver rule has spaces and a `*` — split on newlines only, no globbing.
GUARD="$(node "$HARNESS/../../../scripts/test/no-network-chrome.mjs")"
set -f; IFS='
'
set -- $GUARD
unset IFS; set +f
"$CHROME" "$@" \
  --disable-gpu --hide-scrollbars --user-data-dir="$PROFILE" \
  --window-size="${GS_SHOT_SIZE:-1600,1000}" --force-device-scale-factor=2 \
  --virtual-time-budget=9000 \
  --screenshot="$OUT" \
  "file://${GS_HARNESS_PAGE:-$HARNESS/page}/harness.html?scene=$SCENE&theme=$THEME${EXTRA:+&$EXTRA}" 2>&1 | grep -viE 'devtools|gpu|fontations|dawn|install' || true
echo "wrote $OUT"
