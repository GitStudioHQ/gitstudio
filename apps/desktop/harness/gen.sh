#!/bin/sh
# Assemble the headless-render harness page from the built renderer bundles +
# the fixtures shim. Run `npm run build` (or `node esbuild.js`) first.
set -e
HARNESS="$(cd "$(dirname "$0")" && pwd)"
DIST="$(cd "$HARNESS/../dist/renderer" && pwd)"
PAGE="$HARNESS/page"
rm -rf "$PAGE"
mkdir -p "$PAGE"
cp "$DIST/renderer.js" "$DIST/renderer.css" "$DIST/theme-boot.js" "$PAGE/"
cp "$DIST"/brand-*.svg "$DIST"/icon*.png "$PAGE/" 2>/dev/null || true
cp "$HARNESS/shim.js" "$PAGE/shim.js"
cp "$HARNESS/checks.js" "$PAGE/checks.js"
cat > "$PAGE/harness.html" <<'HTML'
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="stylesheet" href="./renderer.css" />
    <title>GitStudio harness</title>
  </head>
  <body>
    <script src="./theme-boot.js"></script>
    <div id="root"><div id="boot">Loading GitStudio…</div></div>
    <script src="./checks.js"></script>
    <script src="./shim.js"></script>
    <script src="./renderer.js"></script>
  </body>
</html>
HTML
echo "harness page at $PAGE/harness.html"
