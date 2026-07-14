#!/usr/bin/env bash
# Guards the host-agnostic core: packages/engine and packages/host-bridge must
# never import host-specific modules. This is what keeps the engine unit-testable
# and lets the same core power the VS Code extension AND the native desktop app.
set -euo pipefail

cd "$(dirname "$0")/.."

forbidden='from[[:space:]]*['"'"'"](vscode|monaco-editor|fs|node:fs|child_process|node:child_process|os|node:os|path|node:path)['"'"'"]'
status=0

for pkg in packages/engine/src packages/host-bridge/src; do
  if grep -rnE "$forbidden" "$pkg" 2>/dev/null; then
    echo "ERROR: forbidden host import found under $pkg — the core must stay pure." >&2
    status=1
  fi
done

if [ "$status" -eq 0 ]; then
  echo "engine/host-bridge purity OK"
fi
exit "$status"
