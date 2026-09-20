#!/bin/zsh
# One A/B cell, UI path: the real rename widget. The driver opens it with
# editor.action.rename (what F2 runs); uikeys.mjs types the new name and presses
# Enter over CDP, so VS Code's own rename controller, cancellation tokens and
# refactoring auto-save all run exactly as they do for a user.
#
# usage: runui.sh <on|off> <scenario>
set -e
HERE=${0:A:h}
GSQA_DIR=${GSQA_DIR:-/tmp/gsqa-pylance}
WHICH=$1; SCEN=$2
PORT=${GSQA_CDP_PORT:-9333}
zsh "$HERE/run.sh" "$WHICH" "$SCEN" ui --remote-debugging-port=$PORT >/dev/null 2>&1 &
GSQA_TAG="$WHICH-$SCEN" node "$HERE/uikeys.mjs" $PORT "$GSQA_DIR/marks" MAX_ATTEMPTS 2>&1 | tee "$GSQA_DIR/out/$WHICH-$SCEN-ui.keys"
OUT="$GSQA_DIR/out/$WHICH-$SCEN-ui.log"
for i in {1..180}; do
  grep -q '^SUMMARY' "$OUT" 2>/dev/null && break
  sleep 1
done
wait
grep -E "extension |cursor placed|ui:|provider result|on disk after|diagnostics|dirty" "$OUT" | cut -c1-400
