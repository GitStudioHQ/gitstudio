#!/bin/bash
# What CI checks, run here, in CI's order — so "it passed locally" means it
# passes in CI. Every workspace's full check-types (the desktop's renderer has
# its own tsconfig, which `tsc -p apps/desktop` alone never sees), the engine
# purity guard, the translation gates with drift, then the whole suite.
#
#   npm run verify            # everything
#   npm run verify -- --fast  # skip the test suite
set -euo pipefail
cd "$(dirname "$0")/.."
step() { printf '\n── %s ──\n' "$1"; }
step "type-check (every workspace, every tsconfig)"; npm run -s check-types
step "engine purity"; npm run -s check-purity
step "translations"
node scripts/i18n/bundle-nls.mjs --write >/dev/null
git diff --exit-code --stat -- apps/extension/l10n apps/merge-studio/l10n apps/desktop/l10n \
  || { echo "verify: the source bundles were out of date — the diff above is now in your tree; commit it"; exit 1; }
npm run -s i18n
[ "${1:-}" = "--fast" ] && { echo; echo "verify: OK (tests skipped)"; exit 0; }
step "tests"; npm test
echo; echo "verify: OK"
