#!/bin/sh
# Assemble the headless-render harness page from the built renderer bundles +
# the fixtures shim. Run `npm run build` (or `node esbuild.js`) first.
#
#   gen.sh [outDir]
#
# The optional outDir lets a second page exist alongside the default one, so a
# verification run can use a freshly built bundle while something else is still
# reading the old one. shot.sh and probe.mjs both honour $GS_HARNESS_PAGE.
set -e
HARNESS="$(cd "$(dirname "$0")" && pwd)"
# BUILD FIRST. This script only COPIES the bundle, and forgetting the build
# before it is the single most expensive mistake in this harness: a check runs
# against the previous bundle, and reports a fix as not working (or, worse, a
# reverted fix as still working, which is a negative test that lies). Set
# GS_NO_BUILD=1 to skip it when you have just built by hand.
if [ -z "$GS_NO_BUILD" ]; then
  (cd "$HARNESS/.." && node esbuild.js >/dev/null)
fi
DIST="$(cd "$HARNESS/../dist/renderer" && pwd)"
PAGE="${1:-$HARNESS/page}"
rm -rf "$PAGE"
mkdir -p "$PAGE"
cp "$DIST/renderer.js" "$DIST/renderer.css" "$DIST/theme-boot.js" "$PAGE/"
cp "$DIST"/brand-*.svg "$DIST"/icon*.png "$PAGE/" 2>/dev/null || true
cp "$HARNESS/shim.js" "$PAGE/shim.js"
cp "$HARNESS/perf.js" "$PAGE/perf.js"
# The sourcemap is what turns a stack frame into a file and a line. It is only
# read by perf.mjs, never by the page, and it is copied rather than read from
# dist/ so it cannot drift out of step with the bundle beside it.
cp "$DIST/renderer.js.map" "$PAGE/renderer.js.map" 2>/dev/null || true
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
    <script src="./perf.js"></script>
    <script src="./shim.js"></script>
    <script src="./renderer.js"></script>
  </body>
</html>
HTML
echo "harness page at $PAGE/harness.html"
