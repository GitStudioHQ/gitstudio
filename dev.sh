#!/usr/bin/env bash
# GitStudio dev helper — start & test both products.
#   ./dev.sh ext         build + install the extension VSIX into Cursor
#   ./dev.sh ext-watch   rebuild the extension on change (dev loop)
#   ./dev.sh app         run the desktop app from source (esbuild + electron)
#   ./dev.sh app-build   build a runnable GitStudio.app and launch it
#   ./dev.sh app-dmg     build a distributable .dmg
#   ./dev.sh test        run exactly what CI runs (purity + typecheck + tests)
#   ./dev.sh build       rebuild BOTH shippable artifacts (vsix + .app)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

ext_version() { node -e "console.log(require('./apps/extension/package.json').version)"; }
app_dir() {
  # First GitStudio.app under the release dir (arch-specific subfolder).
  find "$ROOT/apps/desktop/release" -maxdepth 2 -name "GitStudio.app" 2>/dev/null | head -1
}

package_ext() {
  local ver; ver="$(ext_version)"
  echo "▸ Building extension bundle…"
  npm run -w apps/extension package
  echo "▸ Packaging gitstudio-${ver}.vsix…"
  ( cd apps/extension && npx @vscode/vsce package -o "gitstudio-${ver}.vsix" --no-dependencies )
  echo "$ROOT/apps/extension/gitstudio-${ver}.vsix"
}

case "${1:-help}" in
  ext)
    vsix="$(package_ext | tail -1)"
    if command -v cursor >/dev/null 2>&1; then
      cursor --install-extension "$vsix" --force
      echo "✓ Installed into Cursor. Now: Cmd+Shift+P → 'Developer: Reload Window'."
    else
      echo "✓ Built: $vsix"
      echo "  (cursor CLI not found — install via Extensions panel → ⋯ → 'Install from VSIX…')"
    fi
    echo "  NOTE: real author photos need GitHub connected in Cursor (Accounts → sign in)."
    ;;

  ext-watch)
    echo "▸ Watching extension (rebuilds on change). Reload the window after a build,"
    echo "  or press F5 in the editor to launch an Extension Development Host."
    npm run -w apps/extension watch
    ;;

  app)
    echo "▸ Starting desktop app from source (esbuild + electron)…"
    npm run -w apps/desktop dev
    ;;

  app-build)
    echo "▸ Building runnable GitStudio.app…"
    npm run -w apps/desktop package
    app="$(app_dir)"
    [ -n "$app" ] || { echo "✗ .app not found under apps/desktop/release"; exit 1; }
    echo "▸ Clearing quarantine + launching (app is unsigned)…"
    xattr -cr "$app" || true
    open "$app"
    echo "✓ Launched: $app"
    ;;

  app-dmg)
    echo "▸ Building distributable .dmg…"
    npm run -w apps/desktop dist
    ls -1 "$ROOT"/apps/desktop/release/*.dmg 2>/dev/null || true
    ;;

  test)
    echo "▸ check-purity"; npm run check-purity
    echo "▸ check-types";  npm run check-types
    echo "▸ tests";        npm test
    echo "✓ All green (matches CI)."
    ;;

  build)
    package_ext
    npm run -w apps/desktop package
    echo "✓ Rebuilt: extension VSIX + desktop .app"
    ;;

  *)
    grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'
    ;;
esac
