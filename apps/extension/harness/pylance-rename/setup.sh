#!/bin/zsh
# Builds two isolated VS Code extension dirs for the issue-#25 A/B:
#   $GSQA_DIR/extdir-on   python + pylance + GitStudio (from the .vsix you pass)
#   $GSQA_DIR/extdir-off  python + pylance only (the control)
# The ms-python extensions are symlinked from your real ~/.vscode/extensions so
# the Pylance under test is the one you actually have installed.
#
# usage: setup.sh <path/to/gitstudio.vsix>
set -e
VSIX=${1:?path to a GitStudio .vsix}
GSQA_DIR=${GSQA_DIR:-/tmp/gsqa-pylance}   # short on purpose — see README
EXT=$HOME/.vscode/extensions
mkdir -p "$GSQA_DIR/extdir-on" "$GSQA_DIR/extdir-off" "$GSQA_DIR/out" "$GSQA_DIR/marks"
for d in on off; do
  for e in ms-python.vscode-pylance ms-python.python ms-python.vscode-python-envs ms-python.debugpy; do
    latest=$(ls -d "$EXT/$e"-* 2>/dev/null | sort -V | tail -1)
    if [ -n "$latest" ]; then
      ln -sfn "$latest" "$GSQA_DIR/extdir-$d/$(basename "$latest")"
    else
      echo "warning: $e not found under $EXT" >&2
    fi
  done
done
GS="$GSQA_DIR/extdir-on/gitstudio.gitstudio-vsix"
rm -rf "$GS" "$GSQA_DIR/vsix-tmp"
mkdir -p "$GS" "$GSQA_DIR/vsix-tmp"
unzip -q -o "$VSIX" -d "$GSQA_DIR/vsix-tmp"
cp -R "$GSQA_DIR/vsix-tmp/extension/." "$GS/"
rm -rf "$GSQA_DIR/vsix-tmp"
echo "extdir-on:";  ls "$GSQA_DIR/extdir-on"
echo "extdir-off:"; ls "$GSQA_DIR/extdir-off"
grep -m1 '"version"' "$GS/package.json"
