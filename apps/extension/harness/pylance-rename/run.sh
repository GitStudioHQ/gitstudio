#!/bin/zsh
# One A/B cell, provider path: Pylance answers vscode.executeDocumentRenameProvider,
# the driver applies it with { isRefactoring: true } (what F2 does), then checks
# the files on disk and Pylance's diagnostics.
#
# usage: run.sh <on|off> <scenario> [provider|ui] [extra VS Code args]
#   on/off   = with / without GitStudio in the extensions dir
#   scenario = plain | busy | open | diffeditor | autosave   (see driver/test.js)
set -e
HERE=${0:A:h}
GSQA_DIR=${GSQA_DIR:-/tmp/gsqa-pylance}
WHICH=$1; SCEN=$2; MODE=${3:-provider}; shift 3 2>/dev/null || shift $#
UDD=/tmp/gsqa-udd-$WHICH        # MUST stay short: the ext-host IPC socket path limit
mkdir -p "$UDD/User" "$GSQA_DIR/out" "$GSQA_DIR/marks"
rm -f "$GSQA_DIR/marks/ready" "$GSQA_DIR/marks/keys-sent"
cat > "$UDD/User/settings.json" <<EOF
{
  "telemetry.telemetryLevel": "off",
  "update.mode": "none",
  "extensions.autoUpdate": false,
  "extensions.autoCheckUpdates": false,
  "security.workspace.trust.enabled": false,
  "workbench.startupEditor": "none",
  "python.experiments.enabled": false,
  "gitstudio.errorReporting.enabled": false,
  "editor.rename.enablePreview": false
}
EOF
zsh "$HERE/mkproj.sh" >/dev/null
OUT="$GSQA_DIR/out/$WHICH-$SCEN-$MODE.log"
: > "$OUT"
echo "== $WHICH / $SCEN / $MODE -> $OUT"
# The code CLI returns as soon as the window is up; the driver's SUMMARY line
# marks the end of the run. ELECTRON_RUN_AS_NODE must not leak into Electron.
env -u ELECTRON_RUN_AS_NODE -u ELECTRON_NO_ATTACH_CONSOLE \
  GSQA_OUT="$OUT" GSQA_SCENARIO="$SCEN" GSQA_MODE="$MODE" GSQA_MARKS="$GSQA_DIR/marks" \
  code --new-window --disable-gpu --skip-welcome --skip-release-notes --disable-workspace-trust \
    --user-data-dir="$UDD" --extensions-dir="$GSQA_DIR/extdir-$WHICH" \
    --extensionDevelopmentPath="$HERE/driver" --extensionTestsPath="$HERE/driver/test.js" \
    "$@" "$GSQA_DIR/proj" > "$GSQA_DIR/out/$WHICH-$SCEN-$MODE.stdout" 2>&1 || echo "code exited $?"
if [ "$MODE" = provider ]; then
  for i in {1..180}; do
    grep -q '^SUMMARY' "$OUT" 2>/dev/null && break
    sleep 1
  done
  grep -E "extension |cursor placed|provider result|applyEdit|on disk after|diagnostics|dirty" "$OUT" | cut -c1-400
fi
