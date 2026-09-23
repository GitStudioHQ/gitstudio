#!/usr/bin/env bash
# The ALL-CASES merge-conflict matrix: one repository per git OPERATION, each
# stopped with conflicts, and every one carrying the full CONTENT matrix — in
# each merge.conflictStyle (merge, diff3, zdiff3).
#
#   scripts/merge-e2e/fixtures.sh <target-dir> [--ops merge,rebase,…] [--styles merge,diff3,zdiff3]
#
# Writes:
#   <target>/<op>/<style>/        a repository stopped mid-<op>, conflicted
#   <target>/.content/{base,x,y}/ the three versions of every content case
#   <target>/.sub/                the submodule's own repository (gitlink targets)
#   <target>/matrix.json          every scenario: id, op, style, dir, command
#
# THE ONE CONVENTION every operation below is arranged to keep: git's stage 1
# holds BASE, stage 2 holds X and stage 3 holds Y — for every path, in every
# operation. Which of X / Y is "Yours" is then the operation's business
# (YOURS_STAGE in packages/engine/src/conflict/sides.ts): a merge's Yours is X
# (stage 2, the branch you are on), a rebase's is Y (stage 3, your commit being
# replayed), a stash pop's is Y (your stashed changes). oracle.ts derives it
# from git and the engine; nothing here names a role.
#
# Hermetic: no global or system config, core.autocrlf=false, fixed identities
# and dates — so every commit sha, and every header naming one, is the same on
# every run and every machine. `am.keepcr=true` is set so the CRLF case reaches
# the three-way merge in `git am -3` and `rebase --apply` instead of failing the
# whole patch (mailsplit strips CRs by default — then no file is merged at all).
#
# Sources of the content cases (copied verbatim, then checked byte-for-byte):
#   - the owner's merge-conflict-tests: base d6f1f21, main 76b62c7, feature b7ddc41
#   - merge-studio test-fixtures/make-stress-conflict.sh (userService.js, config.json)
#   - merge-studio test-fixtures/make-load-conflict.sh (bigService.js, giantList.js, config.json)
set -euo pipefail

usage() { sed -n '2,12p' "$0" >&2; exit 2; }

TARGET=""
OPS_ARG=""
STYLES_ARG="merge,diff3,zdiff3"
while [ $# -gt 0 ]; do
  case "$1" in
    --ops) OPS_ARG="$2"; shift 2 ;;
    --ops=*) OPS_ARG="${1#--ops=}"; shift ;;
    --styles) STYLES_ARG="$2"; shift 2 ;;
    --styles=*) STYLES_ARG="${1#--styles=}"; shift ;;
    -h|--help) usage ;;
    -*) echo "unknown option $1" >&2; usage ;;
    *) [ -z "$TARGET" ] || usage; TARGET="$1"; shift ;;
  esac
done
[ -n "$TARGET" ] || usage

ALL_OPS="merge rebase rebase-apply rebase-merges cherry-pick cherry-pick-range revert am stash issue12 issue12-exact"
OPS="${OPS_ARG//,/ }"; OPS="${OPS:-$ALL_OPS}"
STYLES="${STYLES_ARG//,/ }"

# ── Hermetic git ─────────────────────────────────────────────────────────────
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_SYSTEM=/dev/null
export GIT_OPTIONAL_LOCKS=0
export GIT_AUTHOR_NAME="Matrix Bot" GIT_AUTHOR_EMAIL="matrix@example.com"
export GIT_COMMITTER_NAME="Matrix Bot" GIT_COMMITTER_EMAIL="matrix@example.com"
export GIT_AUTHOR_DATE="2026-01-01T12:00:00+0000" GIT_COMMITTER_DATE="2026-01-01T12:00:00+0000"
# Anything that would open an editor fails loudly instead of accepting silently.
export GIT_EDITOR=false
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_SEQUENCE_EDITOR EDITOR VISUAL \
  GIT_TRACE2 GIT_TRACE2_EVENT GIT_TRACE2_PERF GIT_MERGE_AUTOEDIT 2>/dev/null || true

mkdir -p "$TARGET"
TARGET="$(cd "$TARGET" && pwd -P)"
CONTENT="$TARGET/.content"
SUB="$TARGET/.sub"

die() { echo "fixtures.sh: $*" >&2; exit 1; }

# Every path any version of the content matrix has (vendor/lib, the gitlink, is
# set through the index). A variant writes the paths it has and REMOVES the
# ones it does not — that is how a delete, a rename and an add are expressed.
MATRIX_PATHS=(
  README.md app/calculator.py app/greeting.py app/legacy.py app/new_feature.py app/settings.py app/version.py
  stress/userService.js stress/config.json
  load/bigService.js load/giantList.js load/config.json
  cases/whitespace.txt cases/adjacent.txt cases/windows.txt cases/eol-mixed.txt cases/no-eol.txt
  cases/added-both.txt cases/empty-base.txt
  assets/logo.bin data/huge.log
  rename/old_name.py rename/new_name.py
  rename2/orig.txt rename2/by-x.txt rename2/by-y.txt
  "docs/naïve café/résumé – notes.md"
  links/current
  layout/panel layout/panel/index.txt
  f.txt
  .gitmodules
)

# ── Content: the owner's matrix (merge-conflict-tests, HOW-TO-TEST.md) ───────
#   app/version.py     UU one line          app/greeting.py     UD (X edits, Y deletes)
#   app/settings.py    UU one dict value    app/legacy.py       DU (X deletes, Y edits)
#   app/calculator.py  UU two regions       app/new_feature.py  AA (added on both)
#   README.md          UU multi-line + an auto-mergeable edit
owner_base() { local d="$1"
  mkdir -p "$d/."
  cat > "$d/README.md" <<'__EOF__'
# Sample Service

A tiny sample project used to battle-test merge tooling.

## Status

Version 1.0.0 — stable.

## Notes

- Nothing special here yet.
__EOF__
  mkdir -p "$d/app"
  cat > "$d/app/calculator.py" <<'__EOF__'
def add(a, b):
    # NOTE: integers only for now
    return a + b


def divide(a, b):
    return a / b
__EOF__
  mkdir -p "$d/app"
  cat > "$d/app/greeting.py" <<'__EOF__'
def greet(name):
    return f"Hello, {name}!"
__EOF__
  mkdir -p "$d/app"
  cat > "$d/app/legacy.py" <<'__EOF__'
def old_handler(payload):
    # legacy code path, scheduled for removal
    return payload
__EOF__
  mkdir -p "$d/app"
  cat > "$d/app/settings.py" <<'__EOF__'
SETTINGS = {
    "request_timeout_seconds": 30,
    "max_retries": 3,
    "feature_beta_ui": False,
}
__EOF__
  mkdir -p "$d/app"
  cat > "$d/app/version.py" <<'__EOF__'
"""Single source of truth for the package version."""

__version__ = "1.0.0"
__EOF__
}
owner_x() { local d="$1"
  mkdir -p "$d/."
  cat > "$d/README.md" <<'__EOF__'
# Sample Service

A tiny sample project used to battle-test merge tooling.

## Status

Version 2.0.0 — current release line.

## Notes

- Nothing special here yet.
- Maintained on the main branch.
__EOF__
  mkdir -p "$d/app"
  cat > "$d/app/calculator.py" <<'__EOF__'
def add(a, b):
    # NOTE: supports ints and floats
    return a + b


def divide(a, b):
    if b == 0:
        raise ZeroDivisionError("nope")
    return a / b
__EOF__
  mkdir -p "$d/app"
  cat > "$d/app/greeting.py" <<'__EOF__'
def greet(name):
    return f"Hello there, {name}!"
__EOF__
  mkdir -p "$d/app"
  cat > "$d/app/new_feature.py" <<'__EOF__'
def feature_flag():
    return "main-implementation test"
__EOF__
  mkdir -p "$d/app"
  cat > "$d/app/settings.py" <<'__EOF__'
SETTINGS = {
    "request_timeout_seconds": 60,
    "max_retries": 3,
    "feature_beta_ui": False,
}
__EOF__
  mkdir -p "$d/app"
  cat > "$d/app/version.py" <<'__EOF__'
"""Single source of truth for the package version."""

__version__ = "2.0.0"
__EOF__
}
owner_y() { local d="$1"
  mkdir -p "$d/."
  cat > "$d/README.md" <<'__EOF__'
# Sample Service

A tiny sample project used to battle-test merge tooling.

## Status

Version 1.5.0 — long-term support branch.

## Notes

- Nothing special here yet.
- Backports land on the feature branch.
__EOF__
  mkdir -p "$d/app"
  cat > "$d/app/calculator.py" <<'__EOF__'
def add(a, b):
    # NOTE: now accepts Decimal too
    return a + b


def divide(a, b):
    assert b != 0, "divide by zero"
    return a / b
__EOF__
  mkdir -p "$d/app"
  cat > "$d/app/legacy.py" <<'__EOF__'
def old_handler(payload):
    # still used by one caller; keep for the 1.5 line
    return {"data": payload}
__EOF__
  mkdir -p "$d/app"
  cat > "$d/app/new_feature.py" <<'__EOF__'
def feature_flag():
    return "feature-branch-implementation"
__EOF__
  mkdir -p "$d/app"
  cat > "$d/app/settings.py" <<'__EOF__'
SETTINGS = {
    "request_timeout_seconds": 45,
    "max_retries": 3,
    "feature_beta_ui": True,
}
__EOF__
  mkdir -p "$d/app"
  cat > "$d/app/version.py" <<'__EOF__'
"""Single source of truth for the package version."""

__version__ = "1.5.0"
__EOF__
}

# ── Content: Merge Studio's stress fixture (make-stress-conflict.sh, verbatim) ──
# userService.js: unequal-height conflicts, delete-vs-modify, an overlapping
# insertion, one-line values, an IDENTICAL both-side edit (isAdmin), one-sided
# inserts / modifications / deletions, and a conflict at end of file.
# X is its master, Y its feature.
stress_base() { local d="$1"; mkdir -p "$d/stress"
  cat > "$d/stress/userService.js" <<'__EOF__'
/**
 * User service module.
 * Handles fetching, caching, and formatting of user records.
 */

const RETRY_LIMIT = 3;
const CACHE_TTL = 600;
const API_ROOT = "/api/v1";

const cache = new Map();

function formatName(user) {
  return user.firstName + " " + user.lastName;
}

function validateEmail(email) {
  return email.includes("@");
}

function legacyTransform(record) {
  const copy = Object.assign({}, record);
  copy.legacy = true;
  return copy;
}

async function fetchUser(id) {
  const cached = cache.get(id);
  if (cached) {
    return cached;
  }
  const response = await fetch(`${API_ROOT}/users/${id}`);
  const user = await response.json();
  cache.set(id, user);
  return user;
}

async function updateUser(id, patch) {
  const response = await fetch(`${API_ROOT}/users/${id}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
  return response.json();
}

function isAdmin(user) {
  return user.role === "admin";
}

function clearCache() {
  cache.clear();
}

export { fetchUser, updateUser, clearCache };
__EOF__
  cat > "$d/stress/config.json" <<'__EOF__'
{
  "name": "demo-app",
  "version": "1.0.0",
  "api": {
    "root": "/api/v1",
    "timeoutMs": 5000
  },
  "features": {
    "newDashboard": false,
    "betaSearch": false
  }
}
__EOF__
}
stress_y() { local d="$1"; mkdir -p "$d/stress"
  cat > "$d/stress/userService.js" <<'__EOF__'
/**
 * User service module (v2 API surface).
 * Fetches, caches, validates, and formats user records.
 * @since 2.0
 * @author feature-team
 */

const RETRY_LIMIT = 10;
const CACHE_TTL = 900;
const API_ROOT = "/api/v1";

const userCache = new Map();

function formatName(user) {
  return user.firstName + " " + user.lastName;
}

function sanitizeInput(value) {
  return String(value).replace(/[<>]/g, "").trim();
}

function validateEmail(email) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

function legacyTransform(record) {
  const copy = Object.assign({}, record);
  copy.legacy = true;
  copy.migratedAt = Date.now();
  return copy;
}

async function fetchUser(id) {
  const cached = userCache.get(id);
  if (cached) {
    return cached;
  }
  for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
    try {
      const response = await fetch(`${API_ROOT}/users/${id}`);
      const user = await response.json();
      userCache.set(id, user);
      return user;
    } catch (error) {
      if (attempt === RETRY_LIMIT) {
        throw error;
      }
    }
  }
}

async function updateUser(id, patch) {
  const response = await fetch(`${API_ROOT}/users/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return response.json();
}

function isAdmin(user) {
  return user.role === "admin" || user.role === "owner";
}

function clearCache() {
  userCache.clear();
}

export { fetchUser, updateUser, clearCache, validateEmail, sanitizeInput };
__EOF__
  cat > "$d/stress/config.json" <<'__EOF__'
{
  "name": "demo-app",
  "version": "2.0.0",
  "api": {
    "root": "/api/v1",
    "timeoutMs": 5000
  },
  "features": {
    "newDashboard": true,
    "betaSearch": false
  }
}
__EOF__
}
stress_x() { local d="$1"; mkdir -p "$d/stress"
  cat > "$d/stress/userService.js" <<'__EOF__'
/**
 * User service module — maintained by the platform team.
 * Handles fetching, caching, and formatting of user records.
 * @owner platform-core
 */

const RETRY_LIMIT = 5;
const CACHE_TTL = 900;
const API_ROOT = "/api/v1";

const cache = new Map();

function buildCacheKey(id) {
  return `user:${id}`;
}

function formatName(user) {
  const first = (user.firstName ?? "").trim();
  const last = (user.lastName ?? "").trim();
  return `${first} ${last}`.trim();
}

function validateEmail(email) {
  return email.includes("@");
}

async function fetchUser(userId) {
  const cached = cache.get(buildCacheKey(userId));
  if (cached) {
    return cached;
  }
  console.debug("fetchUser", userId);
  const response = await fetch(`${API_ROOT}/users/${userId}`);
  const user = await response.json();
  cache.set(buildCacheKey(userId), user);
  return user;
}

async function updateUser(id, patch) {
  const response = await fetch(`${API_ROOT}/users/${id}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
  return response.json();
}

function isAdmin(user) {
  return user.role === "admin" || user.role === "owner";
}

function clearCache() {
  cache.clear();
}

export { fetchUser, updateUser, clearCache, formatName, buildCacheKey };
__EOF__
  cat > "$d/stress/config.json" <<'__EOF__'
{
  "name": "demo-app",
  "version": "1.1.0",
  "api": {
    "root": "/api/v1",
    "timeoutMs": 8000
  },
  "features": {
    "newDashboard": false,
    "betaSearch": false
  }
}
__EOF__
}

# ── Content: Merge Studio's load fixture (make-load-conflict.sh, verbatim) ───
# bigService.js cycles six block kinds (value conflict, unequal-height
# conflict, delete-vs-modify, both-same, feature-only, master-only);
# giantList.js is a tall file of one-line conflicts and one-sided edits.
LOAD_BLOCKS=1200

gen_service() {
  local variant="$1" n="$2" i kind limit mode body extra
  printf '/**\n * Generated service surface (%s variant).\n * %d blocks, cycled across every conflict kind.\n */\n\n' "$variant" "$n"
  printf 'const API_ROOT = "/api/v1";\n\n'
  for ((i = 0; i < n; i++)); do
    kind=$((i % 6))
    limit=100; mode="base"; body=1; extra=""
    if [ "$variant" = feature ]; then
      case $kind in
        0) limit=200 ;;
        1) mode="feature"; extra=$'  validate(input);\n  log("feature path");\n  audit(input, id);\n' ;;
        2) body=0 ;;
        3) limit=999; mode="shared" ;;
        4) limit=444; mode="featureOnly" ;;
        5) : ;;
      esac
    elif [ "$variant" = master ]; then
      case $kind in
        0) limit=300 ;;
        1) mode="master" ;;
        2) limit=777; mode="masterEdit" ;;
        3) limit=999; mode="shared" ;;
        4) : ;;
        5) limit=555; mode="masterOnly" ;;
      esac
    fi
    printf '// ---- block %04d (kind=%d) ----\n' "$i" "$kind"
    printf 'function handler%04d(input, id) {\n' "$i"
    if [ "$body" -eq 1 ]; then
      printf '  const limit = %d;\n' "$limit"
      printf '  const mode = "%s";\n' "$mode"
      [ -n "$extra" ] && printf '%s' "$extra"
      printf '  let result = process(input, limit, mode);\n'
      printf '  return result;\n'
    fi
    printf '}\n\n'
  done
  printf 'export const BLOCK_COUNT = %d;\n' "$n"
}

gen_list() {
  local variant="$1" n="$2" i v
  printf '// Generated constant table (%s variant) — %d entries.\n' "$variant" "$n"
  printf 'export const TABLE = {\n'
  for ((i = 0; i < n; i++)); do
    v=$i
    if [ $((i % 2)) -eq 0 ]; then
      [ "$variant" = feature ] && v=$((i + 100000))
      [ "$variant" = master ] && v=$((i + 200000))
    else
      [ "$variant" = feature ] && v=$((i + 500000))
    fi
    printf '  KEY_%05d: %d,\n' "$i" "$v"
  done
  printf '};\n'
}

load_content() { # variant(base|x|y) dir — X is make-load-conflict's master, Y its feature
  local v="$1" d="$2/load" name
  case "$v" in base) name=base ;; x) name=master ;; y) name=feature ;; esac
  mkdir -p "$d"
  gen_service "$name" "$LOAD_BLOCKS" > "$d/bigService.js"
  gen_list "$name" $((LOAD_BLOCKS * 3)) > "$d/giantList.js"
  case "$v" in
    base) printf '{\n  "name": "load-app",\n  "version": "1.0.0",\n  "features": { "newDashboard": false, "betaSearch": false }\n}\n' ;;
    y) printf '{\n  "name": "load-app",\n  "version": "2.0.0",\n  "features": { "newDashboard": true, "betaSearch": false }\n}\n' ;;
    x) printf '{\n  "name": "load-app",\n  "version": "3.0.0",\n  "features": { "newDashboard": false, "betaSearch": true }\n}\n' ;;
  esac > "$d/config.json"
}

# ── Content: every other case the merge UI supports ──────────────────────────
cases_content() { # variant dir
  local v="$1" d="$2"
  mkdir -p "$d/cases" "$d/assets" "$d/data" "$d/rename" "$d/rename2" "$d/docs/naïve café" "$d/links"

  # whitespace-only: X re-indents a block (whitespace only) where Y edits a
  # value; and both make the same edit, Y with trailing spaces (≈ identical).
  case "$v" in
    base) printf 'config:\n  name: demo\n  retries: 3\n  timeout: 30\nfooter\nmode: fast\ntail\n' ;;
    x)    printf 'config:\n    name: demo\n    retries: 3\n    timeout: 30\nfooter\nmode: slow\ntail\n' ;;
    y)    printf 'config:\n  name: demo\n  retries: 5\n  timeout: 30\nfooter\nmode: slow   \ntail\n' ;;
  esac > "$d/cases/whitespace.txt"

  # resolvable: adjacent, non-overlapping edits — one conflict to git, one the
  # wand can apply both sides of.
  case "$v" in
    base) printf 'alpha\nbeta\ngamma\ndelta\nepsilon\n' ;;
    x)    printf 'alpha\nbeta (x)\ngamma\ndelta\nepsilon\n' ;;
    y)    printf 'alpha\nbeta\ngamma (y)\ndelta\nepsilon\n' ;;
  esac > "$d/cases/adjacent.txt"

  # CRLF line endings, on every side.
  case "$v" in
    base) printf 'first\r\nsecond\r\nthird\r\nfourth\r\n' ;;
    x)    printf 'first\r\nsecond (x)\r\nthird\r\nfourth\r\n' ;;
    y)    printf 'first\r\nsecond (y)\r\nthird\r\nfourth\r\n' ;;
  esac > "$d/cases/windows.txt"

  # Line endings disagree: X converts to CRLF (and edits line 2), Y stays LF
  # (and edits line 5). Every line differs to git; the engine normalises.
  case "$v" in
    base) printf 'one\ntwo\nthree\nfour\nfive\n' ;;
    x)    printf 'one\r\ntwo (x)\r\nthree\r\nfour\r\nfive\r\n' ;;
    y)    printf 'one\ntwo\nthree\nfour\nfive (y)\n' ;;
  esac > "$d/cases/eol-mixed.txt"

  # No trailing newline on any side, the conflict on the last line.
  case "$v" in
    base) printf 'a\nb\nc' ;;
    x)    printf 'a\nb\nc (x)' ;;
    y)    printf 'a\nb\nc (y)' ;;
  esac > "$d/cases/no-eol.txt"

  # An empty base, two ways: added on both sides (no stage 1 at all) …
  case "$v" in
    base) ;;
    x) printf 'shared header\nx: only in x\nshared footer\n' > "$d/cases/added-both.txt" ;;
    y) printf 'shared header\ny: only in y\nshared footer\n' > "$d/cases/added-both.txt" ;;
  esac
  # … and a base that exists but is an EMPTY file (stage 1 is the empty blob).
  case "$v" in
    base) : ;;
    x)    printf 'filled by x\n' ;;
    y)    printf 'filled by y\n' ;;
  esac > "$d/cases/empty-base.txt"

  # A binary conflict (NUL bytes: git's own test).
  case "$v" in
    base) printf '\211PNG\r\n\032\n\000\000\000\rIHDR base\000\001\002\003' ;;
    x)    printf '\211PNG\r\n\032\n\000\000\000\rIHDR x-side\000\004\005\006' ;;
    y)    printf '\211PNG\r\n\032\n\000\000\000\rIHDR y-side\000\007\010\011' ;;
  esac > "$d/assets/logo.bin"

  # Too large for a text merge (> 512 KiB, CONFLICT_TEXT_CAP_BYTES), one
  # contested line in the middle.
  awk -v tag="$v" 'BEGIN {
    for (i = 1; i <= 14000; i++) {
      if (i == 7000) printf "line %05d: the contested line, as %s has it\n", i, tag
      else printf "line %05d: lorem ipsum dolor sit amet, consectetur adipiscing elit\n", i
    }
  }' > "$d/data/huge.log"

  # A rename on one side: X renames old_name.py → new_name.py AND edits a line
  # that Y edits too, in the old name.
  local body='def handler(event):\n    kind = event["kind"]\n    if kind == "create":\n        return "%s"\n    if kind == "delete":\n        return "deleted"\n    return "ignored"\n'
  case "$v" in
    base) printf "$body" created > "$d/rename/old_name.py" ;;
    x)    printf "$body" made > "$d/rename/new_name.py" ;;
    y)    printf "$body" built > "$d/rename/old_name.py" ;;
  esac

  # Renamed differently on both sides (rename/rename 1-to-2): git leaves the
  # original both-deleted (DD) and each new name added on one side only
  # (AU / UA). Pure renames, on purpose: had either side also edited the
  # file, git would store a three-way merge of the two (markers and all) in
  # BOTH new names' stages, and no stage would hold either side's content.
  local six='shared line one\nshared line two\nshared line three\nshared line four\nshared line five\nshared line six\n'
  case "$v" in
    base) printf "$six" > "$d/rename2/orig.txt" ;;
    x)    printf "$six" > "$d/rename2/by-x.txt" ;;
    y)    printf "$six" > "$d/rename2/by-y.txt" ;;
  esac

  # A path with spaces and non-ASCII characters (NFC).
  case "$v" in
    base) printf '# Résumé\n\nStatus: draft\nOwner: Zoë\n' ;;
    x)    printf '# Résumé\n\nStatus: final (x)\nOwner: Zoë\n' ;;
    y)    printf '# Résumé\n\nStatus: in review (y) — ünïcödé\nOwner: Zoë\n' ;;
  esac > "$d/docs/naïve café/résumé – notes.md"

  # A symlink whose target both sides changed.
  case "$v" in
    base) ln -s "releases/v1" "$d/links/current" ;;
    x)    ln -s "releases/v2-x" "$d/links/current" ;;
    y)    ln -s "releases/v2-y" "$d/links/current" ;;
  esac

  # A file/directory conflict: X adds a FILE where Y adds a DIRECTORY. git
  # moves X's file aside (layout/panel~<label>, added on one side only).
  case "$v" in
    base) ;;
    x) mkdir -p "$d/layout"; printf 'panel as a file (x)\n' > "$d/layout/panel" ;;
    y) mkdir -p "$d/layout/panel"; printf 'panel as a directory (y)\n' > "$d/layout/panel/index.txt" ;;
  esac

  # The issue-#12 reporter's file: line 3 changed on both branches.
  case "$v" in
    base) printf 'one\ntwo\nthree\nfour\nfive\n' ;;
    x)    printf 'one\ntwo\nthree-master\nfour\nfive\n' ;;
    y)    printf 'one\ntwo\nthree-test\nfour\nfive\n' ;;
  esac > "$d/f.txt"

  # The submodule's declaration (the same on every side; the gitlink is not).
  printf '[submodule "vendor/lib"]\n\tpath = vendor/lib\n\turl = ../.sub\n' > "$d/.gitmodules"
}

make_content() { # variant
  local v="$1" d="$CONTENT/$1"
  rm -rf "$d"; mkdir -p "$d"
  owner_"$v" "$d"
  stress_"$v" "$d"
  load_content "$v" "$d"
  cases_content "$v" "$d"
}

# The submodule: a real repository with one commit per side, so every gitlink
# names a commit that exists.
make_sub() {
  rm -rf "$SUB"; mkdir -p "$SUB"
  git -C "$SUB" init -q -b main .
  local v
  for v in base x y; do
    printf 'library at %s\n' "$v" > "$SUB/lib.txt"
    git -C "$SUB" add lib.txt
    git -C "$SUB" commit -q -m "lib: $v"
    git -C "$SUB" tag "$v"
  done
}
sub_sha() { git -C "$SUB" rev-parse "$1^{commit}"; }

# ── Repository helpers ───────────────────────────────────────────────────────
init_repo() { # dir style initial-branch
  rm -rf "$1"; mkdir -p "$1"; cd "$1"
  git init -q -b "$3" .
  git config core.autocrlf false
  git config core.safecrlf false
  git config core.precomposeunicode true
  git config merge.conflictStyle "$2"
  git config am.keepcr true
  git config gc.auto 0
  git config rerere.enabled false
  git config commit.gpgsign false
  git config tag.gpgsign false
  git config advice.detachedHead false
}

# Make the worktree AND the index hold `variant` for every matrix path.
apply_variant() {
  local v="$1" src="$CONTENT/$1" p
  # Removals first (a file becoming a directory needs the file gone, and the
  # reverse), then the variant's own paths.
  for p in "${MATRIX_PATHS[@]}"; do
    if [ -e "$p" ] || [ -L "$p" ]; then
      if [ -d "$p" ] && [ ! -L "$p" ]; then
        [ -d "$src/$p" ] || rm -rf -- "$p"
      elif ! { [ -e "$src/$p" ] || [ -L "$src/$p" ]; } || [ -d "$src/$p" ]; then
        rm -f -- "$p"
      fi
    fi
  done
  for p in "${MATRIX_PATHS[@]}"; do
    if [ -L "$src/$p" ]; then
      mkdir -p "$(dirname "$p")"; rm -f -- "$p"; ln -s "$(readlink "$src/$p")" "$p"
    elif [ -f "$src/$p" ]; then
      mkdir -p "$(dirname "$p")"; cp -- "$src/$p" "$p"
    fi
  done
  git add -A .
  git update-index --add --cacheinfo "160000,$(sub_sha "$v"),vendor/lib"
  mkdir -p vendor/lib
}

commit() { git add -A .; git commit -q -m "$1"; }

note() { mkdir -p notes; printf '%s\n' "$1" > "notes/$2"; commit "$3"; }

# Run the step that must STOP on conflicts: it must fail, and leave paths unmerged.
expect_stop() {
  local log; log="$(mktemp)"
  if "$@" >"$log" 2>&1; then
    cat "$log" >&2; rm -f "$log"; die "$* did not stop (in $PWD)"
  fi
  if [ -z "$(git ls-files -u)" ]; then
    cat "$log" >&2; rm -f "$log"; die "$* stopped with nothing unmerged (in $PWD)"
  fi
  rm -f "$log"
}

# ── One builder per operation ────────────────────────────────────────────────
# Each runs inside a fresh repository and leaves it stopped. `$CMD` records the
# command that stopped it, for matrix.json.

# On main, `git merge feature`.
op_merge() {
  apply_variant base; commit "base: every case's common ancestor"
  git checkout -q -b feature; apply_variant y; commit "feature: change every case"
  git checkout -q main; apply_variant x; commit "main: change every case"
  CMD="git merge feature"; expect_stop git merge feature
}

# On test (3 commits), `git rebase master` — the merge backend; stops on commit 2 of 3.
op_rebase() {
  local backend="$1"
  apply_variant base; commit "base: every case's common ancestor"
  git checkout -q -b test
  note "first" t1.txt "test: add the first note"
  apply_variant y; commit "test: change every case"
  note "third" t3.txt "test: add the third note"
  git checkout -q master; apply_variant x; commit "master: change every case"
  git checkout -q test
  if [ "$backend" = apply ]; then
    CMD="git rebase --apply master"; expect_stop git rebase --apply master
  else
    CMD="git rebase master"; expect_stop git rebase master
  fi
}

# On feat, which merged side with `-s ours`: `git rebase -i -r main` (the todo
# accepted as written) replays both branches onto main's new commit, then
# re-creates the merge — and that merge conflicts.
op_rebase_merges() {
  apply_variant base; commit "base: every case's common ancestor"
  git checkout -q -b feat; apply_variant x; commit "feat: change every case"
  git checkout -q -b side main; apply_variant y; commit "side: change every case"
  git checkout -q feat
  git merge -q -s ours --no-edit side
  git checkout -q main; note "main moved on" main.txt "main: an unrelated note"
  git checkout -q feat
  CMD="git rebase -i -r main"; expect_stop env GIT_SEQUENCE_EDITOR=true git rebase -i -r main
}

# On main, `git cherry-pick feature`.
op_cherry_pick() {
  apply_variant base; commit "base: every case's common ancestor"
  git checkout -q -b feature; apply_variant y; commit "feature: change every case"
  git checkout -q main; apply_variant x; commit "main: change every case"
  CMD="git cherry-pick feature"; expect_stop git cherry-pick feature
}

# On main, `git cherry-pick main..feature` — the first applies, the second
# stops, the third is queued.
op_cherry_pick_range() {
  apply_variant base; commit "base: every case's common ancestor"
  git checkout -q -b feature
  note "first" p1.txt "feature: add the first note"
  apply_variant y; commit "feature: change every case"
  note "third" p3.txt "feature: add the third note"
  git checkout -q main; apply_variant x; commit "main: change every case"
  CMD="git cherry-pick main..feature"; expect_stop git cherry-pick main..feature
}

# On main: Y, then the commit that turned it into BASE, then X. Reverting the
# middle one merges BASE (the reverted commit) → X (HEAD) and → Y (its parent).
op_revert() {
  apply_variant y; commit "every case as it was before"
  apply_variant base; commit "reset every case to the base"
  apply_variant x; commit "main: change every case"
  CMD="git revert --no-edit HEAD~1"; expect_stop git revert --no-edit HEAD~1
}

# On main, `git am -3` of feature's commit as a patch. `--no-renames`, as
# rebase's own apply backend formats it: a pure rename carries no index line,
# so `am -3` cannot build the fake ancestor ("could not build fake ancestor")
# and the whole patch fails with nothing merged. As delete + add, git's
# three-way fallback finds the rename itself.
op_am() {
  apply_variant base; commit "base: every case's common ancestor"
  git checkout -q -b feature; apply_variant y; commit "feature: change every case"
  local dir; dir="$(git rev-parse --absolute-git-dir)/matrix-patches"
  git format-patch -q --no-renames --binary -1 -o "$dir" feature
  git checkout -q main; apply_variant x; commit "main: change every case"
  CMD="git am -3 <feature's patch>"; expect_stop git am -3 "$dir"/0001-*.patch
}

# On main: Y stashed, X committed, `git stash pop`.
op_stash() {
  apply_variant base; commit "base: every case's common ancestor"
  apply_variant y
  git stash push -q -m "every case as Y"
  apply_variant x; commit "main: change every case"
  CMD="git stash pop"; expect_stop git stash pop
}

# The issue-#12 reporter's steps — master and test each change the file, then
# `git checkout test; git rebase master` — with every case in the one commit.
op_issue12() {
  apply_variant base; commit "base"
  git checkout -q -b test; apply_variant y; commit "test change"
  git checkout -q master; apply_variant x; commit "master change"
  git checkout -q test
  CMD="git checkout test; git rebase master"; expect_stop git rebase master
}

# The reporter's EXACT repository: one file, line 3, nothing else.
op_issue12_exact() {
  printf 'one\ntwo\nthree\nfour\nfive\n' > f.txt; commit "base"
  git checkout -q -b test; printf 'one\ntwo\nthree-test\nfour\nfive\n' > f.txt; commit "test change"
  git checkout -q master; printf 'one\ntwo\nthree-master\nfour\nfive\n' > f.txt; commit "master change"
  git checkout -q test
  CMD="git checkout test; git rebase master"; expect_stop git rebase master
}

build_one() { # op style
  local op="$1" style="$2" dir="$TARGET/$1/$2" branch=main
  case "$op" in rebase|rebase-apply|issue12|issue12-exact) branch=master ;; esac
  init_repo "$dir" "$style" "$branch"
  case "$op" in
    merge) op_merge ;;
    rebase) op_rebase merge ;;
    rebase-apply) op_rebase apply ;;
    rebase-merges) op_rebase_merges ;;
    cherry-pick) op_cherry_pick ;;
    cherry-pick-range) op_cherry_pick_range ;;
    revert) op_revert ;;
    am) op_am ;;
    stash) op_stash ;;
    issue12) op_issue12 ;;
    issue12-exact) op_issue12_exact ;;
    *) die "unknown operation $op" ;;
  esac
  cd "$TARGET"
}

json_str() { local s="${1//\\/\\\\}"; s="${s//\"/\\\"}"; printf '"%s"' "$s"; }

# ── Main ─────────────────────────────────────────────────────────────────────
make_sub
for v in base x y; do make_content "$v"; done

SCENARIOS=()
for op in $OPS; do
  for style in $STYLES; do
    CMD=""
    build_one "$op" "$style"
    SCENARIOS+=("{\"id\":$(json_str "$op.$style"),\"op\":$(json_str "$op"),\"style\":$(json_str "$style"),\"dir\":$(json_str "$op/$style"),\"command\":$(json_str "$CMD")}")
    echo "built $op.$style" >&2
  done
done

{
  printf '{\n  "git": %s,\n  "loadBlocks": %d,\n  "scenarios": [\n' "$(json_str "$(git --version)")" "$LOAD_BLOCKS"
  for i in "${!SCENARIOS[@]}"; do
    printf '    %s%s\n' "${SCENARIOS[$i]}" "$([ "$i" -lt $((${#SCENARIOS[@]} - 1)) ] && echo ,)"
  done
  printf '  ]\n}\n'
} > "$TARGET/matrix.json"
echo "$TARGET"
