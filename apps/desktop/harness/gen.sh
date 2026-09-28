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
# The icon fonts are separate files rather than base64 in the stylesheet, so
# they have to travel with it. Without this every codicon in every screenshot
# and probe renders INVISIBLE — `font-display: block` does not fall back — and
# the harness loses its icons silently, which is the worst way to lose them.
cp "$DIST"/*.ttf "$PAGE/" 2>/dev/null || true
cp "$DIST"/brand-*.svg "$DIST"/icon*.png "$PAGE/" 2>/dev/null || true
cp "$HARNESS/shim.js" "$PAGE/shim.js"
cp "$HARNESS/perf.js" "$PAGE/perf.js"
# The sourcemap is what turns a stack frame into a file and a line. It is only
# read by perf.mjs, never by the page, and it is copied rather than read from
# dist/ so it cannot drift out of step with the bundle beside it.
cp "$DIST/renderer.js.map" "$PAGE/renderer.js.map" 2>/dev/null || true
cp "$HARNESS/checks.js" "$PAGE/checks.js"
# The owner's requests, as executable clauses — see validate.mjs.
cp "$HARNESS/requirements.js" "$PAGE/requirements.js"
# The launch screen is the app's own (dist/renderer/index.html, between its
# launch:* markers), so every scene starts the way the app does — covered by
# it — and every check runs after the real hand-off has removed it. Taken
# from the built page rather than copied here, so the two cannot drift.
launch_block() {
  awk -v from="<!-- launch:$1 -->" -v upto="<!-- /launch:$1 -->" \
    'index($0, from) { on = 1 } on { print } index($0, upto) { on = 0 }' "$DIST/index.html"
}
LAUNCH_STYLE="$(launch_block style)"
LAUNCH_SCREEN="$(launch_block screen)"
if [ -z "$LAUNCH_STYLE" ] || [ -z "$LAUNCH_SCREEN" ]; then
  echo "gen.sh: no launch screen in $DIST/index.html (launch:style / launch:screen markers)" >&2
  exit 1
fi
{
  cat <<'HTML'
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="stylesheet" href="./renderer.css" />
    <title>GitStudio harness</title>
HTML
  printf '%s\n' "$LAUNCH_STYLE"
  cat <<'HTML'
  </head>
  <body>
    <script src="./theme-boot.js"></script>
HTML
  printf '%s\n' "$LAUNCH_SCREEN"
  cat <<'HTML'
    <div id="root"><div id="boot">Loading GitStudio…</div></div>
    <script src="./checks.js"></script>
    <script src="./requirements.js"></script>
    <script src="./perf.js"></script>
    <script src="./shim.js"></script>
    <script src="./renderer.js"></script>
  </body>
</html>
HTML
} > "$PAGE/harness.html"
echo "harness page at $PAGE/harness.html"
