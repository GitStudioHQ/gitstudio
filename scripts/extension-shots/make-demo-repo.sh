#!/usr/bin/env bash
# Builds "lumen", the made-up project the GitStudio extension's README media
# is captured from (apps/extension/SHOTS.md): a small static site generator
# with a real-looking history. Hermetic: no global or system git config, no
# network, fixed identities.
#
#   bash scripts/extension-shots/make-demo-repo.sh [target]    # default /tmp/gs-demo
#
# Under the target directory:
#   lumen/           the repository the shots open, on main
#   lumen-hotfix/    a linked worktree on hotfix/cache-errors
#   remote/lumen.git a bare "origin"
#   teammate/        a second clone that puts commits on origin
#
# What it holds:
#   - main, feature/offline-cache (merged), release/1.0.x (merged back),
#     feature/search-filters (open, pushed), feature/dark-mode (open, local),
#     hotfix/cache-errors (the worktree's branch: 1 commit to push)
#   - tags v0.9.0, v1.0.0, v1.0.1, v1.1.0-beta.1
#   - main 2 ahead / 1 behind origin/main; feature/search-filters 1 behind
#   - two stashes (one with a staged and an untracked file)
#   - staged, unstaged (a file with two separate changes) and untracked work
#
# Dates are days before LUMEN_ANCHOR (a UTC date, default today), so the
# relative ages the UI shows ("2d", "3w") look the same whenever the shots are
# retaken. Pin LUMEN_ANCHOR to get the same shas again.
#
# Keep the target path short and neutral (the default): tooltips and the
# Worktrees view show it, and no image may carry a home directory. Every
# author is invented (example.com addresses) — never a real person.

set -euo pipefail

ROOT="${1:-/tmp/gs-demo}"
ANCHOR="${LUMEN_ANCHOR:-$(date -u +%Y-%m-%d)}"
rm -rf "$ROOT"
mkdir -p "$ROOT"
ROOT="$(cd "$ROOT" && pwd -P)"

export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/dev/null
export HOME="$ROOT/.home"
mkdir -p "$HOME"
export GIT_TERMINAL_PROMPT=0
export TZ=UTC
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE

MAYA="Maya Chen <maya.chen@example.com>"
JONAS="Jonas Weber <jonas.weber@example.com>"
SOFIA="Sofia Marino <sofia.marino@example.com>"
LEO="Leo Okafor <leo.okafor@example.com>"
PRIYA="Priya Raman <priya.raman@example.com>"

# "<days before the anchor> <HH:MM>" -> "YYYY-MM-DD HH:MM:00 +0000"
when() {
  python3 - "$ANCHOR" "$1" "$2" <<'EOF'
import datetime, sys
anchor = datetime.date.fromisoformat(sys.argv[1])
day = anchor - datetime.timedelta(days=int(sys.argv[2]))
print(f"{day.isoformat()} {sys.argv[3]}:00 +0000")
EOF
}

# A repository's own config: the owner's global config (signing, hooks, a
# name) must never reach the demo, even when VS Code later runs git in it.
localcfg() {
  git config user.name "Maya Chen"
  git config user.email "maya.chen@example.com"
  git config commit.gpgsign false
  git config tag.gpgsign false
  git config core.autocrlf false
  git config core.hooksPath /dev/null
  git config pull.rebase false
  git config advice.detachedHead false
  git config credential.helper ""
}

as() { # as "<Name <email>>" <days> <HH:MM> -- git args...
  local who="$1" d
  d="$(when "$2" "$3")"
  shift 4
  local name="${who% <*}" email="${who#*<}"
  email="${email%>}"
  GIT_AUTHOR_NAME="$name" GIT_AUTHOR_EMAIL="$email" GIT_AUTHOR_DATE="$d" \
  GIT_COMMITTER_NAME="$name" GIT_COMMITTER_EMAIL="$email" GIT_COMMITTER_DATE="$d" \
    git "$@"
}

# commit "<who>" <days> <HH:MM> "message" — everything, unless something is staged
commit() {
  if git diff --cached --quiet; then git add -A; fi
  as "$1" "$2" "$3" -- commit -q -m "$4"
}
merge() { as "$1" "$2" "$3" -- merge -q --no-ff "$4" -m "$5"; }
tag() { as "$1" "$2" "$3" -- tag -a "$4" -m "$5"; }

w() { mkdir -p "$(dirname "$1")"; cat > "$1"; }
append() { cat >> "$1"; }
# edit <file> <python expression over s> — an in-place edit that must match
edit() {
  python3 - "$1" "$2" <<'EOF'
import sys
p, expr = sys.argv[1], sys.argv[2]
s = open(p).read()
t = eval(expr, {"s": s})
if t == s:
    sys.exit(f"edit of {p} changed nothing: {expr[:80]}")
open(p, "w").write(t)
EOF
}

# ── main: the first release ────────────────────────────────────────────────

git init -q -b main "$ROOT/lumen"
cd "$ROOT/lumen"
localcfg

w package.json <<'EOF'
{
  "name": "lumen",
  "version": "0.1.0",
  "description": "A small, fast static site generator for Markdown docs.",
  "bin": { "lumen": "dist/cli.js" },
  "scripts": {
    "build": "tsc -p .",
    "test": "node --test dist/test"
  },
  "license": "MIT"
}
EOF
w tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "target": "es2022",
    "module": "nodenext",
    "outDir": "dist",
    "strict": true
  },
  "include": ["src", "test"]
}
EOF
w README.md <<'EOF'
# lumen

A small, fast static site generator for Markdown docs.
EOF
w .gitignore <<'EOF'
node_modules/
dist/
site/
.lumen-cache/
EOF
commit "$MAYA" 35 09:12 "chore: scaffold lumen"

w src/markdown.ts <<'EOF'
export interface Page {
  path: string;
  title: string;
  html: string;
}

/** Renders one Markdown document to HTML. */
export function render(path: string, source: string): Page {
  const title = /^#\s+(.+)$/m.exec(source)?.[1] ?? path;
  const html = source
    .split(/\n{2,}/)
    .map((block) => block.startsWith("#") ? heading(block) : `<p>${inline(block)}</p>`)
    .join("\n");
  return { path, title, html };
}

function heading(block: string): string {
  const level = /^#+/.exec(block)![0].length;
  return `<h${level}>${inline(block.slice(level).trim())}</h${level}>`;
}

function inline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}
EOF
w test/markdown.test.ts <<'EOF'
import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "../src/markdown";

test("the first heading is the title", () => {
  assert.equal(render("a.md", "# Hello\n\nWorld").title, "Hello");
});
EOF
commit "$MAYA" 35 14:40 "feat(markdown): headings, paragraphs and inline code"

w src/build.ts <<'EOF'
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { render, type Page } from "./markdown";

export interface BuildOptions {
  input: string;
  out: string;
}

export async function build(opts: BuildOptions): Promise<Page[]> {
  const pages: Page[] = [];
  for (const name of await readdir(opts.input)) {
    if (!name.endsWith(".md")) continue;
    const source = await readFile(join(opts.input, name), "utf8");
    pages.push(render(name, source));
  }
  await mkdir(opts.out, { recursive: true });
  for (const page of pages) {
    await writeFile(join(opts.out, page.path.replace(/\.md$/, ".html")), page.html);
  }
  return pages;
}
EOF
commit "$JONAS" 34 10:05 "feat(build): render a folder of Markdown to HTML"

w src/cli.ts <<'EOF'
#!/usr/bin/env node
import { build } from "./build";

const [command, input = "docs", ...rest] = process.argv.slice(2);
const out = rest[rest.indexOf("--out") + 1] ?? "site";

if (command !== "build") {
  console.error("usage: lumen build <docs> [--out <dir>]");
  process.exit(2);
}
build({ input, out }).then((pages) => console.log(`built ${pages.length} pages`));
EOF
append README.md <<'EOF'

```sh
npx lumen build docs/ --out site/
```
EOF
commit "$JONAS" 34 16:31 "feat(cli): lumen build <docs> --out <dir>"

w src/config.ts <<'EOF'
export interface Config {
  title: string;
  baseUrl: string;
  theme: "light" | "dark" | "auto";
}

export const defaults: Config = {
  title: "Docs",
  baseUrl: "/",
  theme: "auto",
};

export function loadConfig(raw: Partial<Config>): Config {
  return { ...defaults, ...raw };
}
EOF
w docs/configuration.md <<'EOF'
# Configuration

`lumen.config.json`, next to your docs:

| Key | Default | |
| --- | --- | --- |
| `title` | `"Docs"` | The site's name, in every page's `<title>` |
| `baseUrl` | `"/"` | Where the site is served from |
EOF
commit "$SOFIA" 33 11:20 "feat(config): lumen.config.json with sensible defaults"

append test/markdown.test.ts <<'EOF'

test("inline code survives", () => {
  assert.match(render("a.md", "use `lumen build`").html, /<code>lumen build<\/code>/);
});
EOF
w test/build.test.ts <<'EOF'
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../src/build";

test("one page per document", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lumen-"));
  await writeFile(join(dir, "a.md"), "# A");
  const pages = await build({ input: dir, out: join(dir, "site") });
  assert.equal(pages.length, 1);
});
EOF
commit "$PRIYA" 32 09:48 "test: cover titles, inline code and the build"
tag "$MAYA" 32 12:00 v0.9.0 "lumen 0.9.0"

# feature/offline-cache: a lane of its own, merged back
git switch -q -c feature/offline-cache
w src/cache.ts <<'EOF'
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const DIR = ".lumen-cache";

/** A content hash: a page whose source did not change is not rendered again. */
export function key(source: string): string {
  return createHash("sha256").update(source).digest("hex").slice(0, 16);
}

export async function get(k: string): Promise<string | undefined> {
  try {
    return await readFile(join(DIR, k), "utf8");
  } catch {
    return undefined;
  }
}

export async function put(k: string, html: string): Promise<void> {
  await mkdir(DIR, { recursive: true });
  await writeFile(join(DIR, k), html);
}
EOF
commit "$LEO" 31 10:15 "feat(cache): content-hashed render cache"

git switch -q main
append docs/configuration.md <<'EOF'

Unknown keys are ignored, and every key is optional.
EOF
append README.md <<'EOF'

See [Configuration](docs/configuration.md) for `lumen.config.json`.
EOF
commit "$SOFIA" 31 15:02 "docs: document lumen.config.json"

git switch -q feature/offline-cache
edit src/build.ts 's.replace("import { render, type Page } from \"./markdown\";", "import { render, type Page } from \"./markdown\";\nimport * as cache from \"./cache\";").replace("    pages.push(render(name, source));", "    const k = cache.key(source);\n    const hit = await cache.get(k);\n    const page = hit ? { path: name, title: name, html: hit } : render(name, source);\n    if (!hit) await cache.put(k, page.html);\n    pages.push(page);")'
w docs/caching.md <<'EOF'
# Caching

Unchanged pages are served from `.lumen-cache/` instead of being rendered
again. Delete the folder to rebuild everything.
EOF
commit "$LEO" 30 11:40 "feat(build): skip pages whose source did not change"

w test/cache.test.ts <<'EOF'
import { test } from "node:test";
import assert from "node:assert/strict";
import { key } from "../src/cache";

test("the same source has the same key", () => {
  assert.equal(key("# a"), key("# a"));
  assert.notEqual(key("# a"), key("# b"));
});
EOF
commit "$LEO" 29 09:22 "test(cache): stable keys"

git switch -q main
w src/theme.ts <<'EOF'
import type { Config } from "./config";

export function stylesheet(config: Config): string {
  const dark = "body { background: #16161a; color: #e8e6f0; }";
  const light = "body { background: #ffffff; color: #1d1b24; }";
  if (config.theme === "dark") return dark;
  if (config.theme === "light") return light;
  return `${light}\n@media (prefers-color-scheme: dark) { ${dark} }`;
}
EOF
append docs/configuration.md <<'EOF'

`theme` is `"light"`, `"dark"` or `"auto"` (the reader's system setting, the default).
EOF
commit "$SOFIA" 28 13:10 "feat(theme): light, dark and auto stylesheets"

merge "$MAYA" 27 10:00 feature/offline-cache "Merge branch 'feature/offline-cache'"
edit package.json 's.replace("\"version\": \"0.1.0\"", "\"version\": \"1.0.0\"")'
w CHANGELOG.md <<'EOF'
# Changelog

## 1.0.0

- Markdown to HTML, one page per document
- A content-hashed render cache: unchanged pages are not rendered again
- Light, dark and auto themes
EOF
commit "$MAYA" 27 16:45 "release: lumen 1.0.0"
tag "$MAYA" 27 16:50 v1.0.0 "lumen 1.0.0"

# release/1.0.x: fixes for the 1.0 line, merged back into main
git switch -q -c release/1.0.x
edit src/cli.ts 's.replace("const out = rest[rest.indexOf(\"--out\") + 1] ?? \"site\";", "const at = rest.indexOf(\"--out\");\nconst out = at >= 0 && rest[at + 1] ? rest[at + 1] : \"site\";")'
w test/cli.test.ts <<'EOF'
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

test("--out without a value builds into site/", () => {
  const out = execFileSync("node", ["dist/src/cli.js", "build", "docs", "--out"], { encoding: "utf8" });
  assert.match(out, /built \d+ pages/);
});
EOF
commit "$JONAS" 25 09:30 "fix(cli): --out without a value no longer writes to 'undefined'"
append CHANGELOG.md <<'EOF'

## 1.0.1

- `--out` without a value falls back to `site/`
EOF
edit package.json 's.replace("\"version\": \"1.0.0\"", "\"version\": \"1.0.1\"")'
commit "$JONAS" 25 11:05 "release: lumen 1.0.1"
tag "$JONAS" 25 11:10 v1.0.1 "lumen 1.0.1"

git switch -q main
w src/search.ts <<'EOF'
import type { Page } from "./markdown";

export interface Entry {
  path: string;
  title: string;
  words: string[];
}

/** A tiny client-side search index: every distinct word of every page. */
export function index(pages: Page[]): Entry[] {
  return pages.map((p) => ({
    path: p.path,
    title: p.title,
    words: [...new Set(p.html.replace(/<[^>]+>/g, " ").toLowerCase().split(/\W+/).filter(Boolean))],
  }));
}
EOF
w test/search.test.ts <<'EOF'
import { test } from "node:test";
import assert from "node:assert/strict";
import { index } from "../src/search";

test("words are lower-cased and unique", () => {
  const [e] = index([{ path: "a.md", title: "A", html: "<p>Lumen lumen docs</p>" }]);
  assert.deepEqual(e.words, ["lumen", "docs"]);
});
EOF
commit "$PRIYA" 24 10:20 "feat(search): build a client-side search index"
merge "$JONAS" 24 15:00 release/1.0.x "Merge branch 'release/1.0.x'"

edit src/build.ts 's.replace("    const k = cache.key(source);", "    const k = cache.key(`${name}\\0${source}`);")'
edit src/cache.ts 's.replace("/** A content hash: a page whose source did not change is not rendered again. */", "/** A hash of path and content: an unchanged page is not rendered again. */")'
commit "$LEO" 23 11:12 "fix(cache): key entries by path and content"

# feature/search-filters: a teammate's open branch, pushed
git switch -q -c feature/search-filters
append src/search.ts <<'EOF'

export function search(entries: Entry[], query: string): Entry[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter((e) => terms.every((t) => e.words.some((w) => w.startsWith(t))));
}
EOF
append test/search.test.ts <<'EOF'

test("every term must match the start of a word", () => {
  const entries = index([{ path: "a.md", title: "A", html: "<p>static sites</p>" }]);
  assert.equal(search(entries, "stat si").length, 1);
  assert.equal(search(entries, "tic").length, 0);
});
EOF
edit test/search.test.ts 's.replace("import { index } from \"../src/search\";", "import { index, search } from \"../src/search\";")'
commit "$PRIYA" 20 09:40 "feat(search): prefix matching across every term"
append src/search.ts <<'EOF'

export function byTitle(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => a.title.localeCompare(b.title));
}
EOF
commit "$PRIYA" 19 14:12 "feat(search): sort results by title"

git switch -q main
edit src/markdown.ts 's.replace("    .replace(/`([^`]+)`/g, \"<code>$1</code>\");", "    .replace(/`([^`]+)`/g, \"<code>$1</code>\")\n    .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, `<a href=\"$2\">$1</a>`);")'
append test/markdown.test.ts <<'EOF'

test("inline links", () => {
  assert.match(render("a.md", "see [the docs](docs/)").html, /<a href="docs\/">the docs<\/a>/);
});
EOF
commit "$SOFIA" 18 11:30 "feat(markdown): inline links"

w docs/getting-started.md <<'EOF'
# Getting started

Install lumen, point it at a folder of Markdown, and build.

```sh
npm install --save-dev lumen
npx lumen build docs/ --out site/
```

Every `.md` file becomes one page. The first heading is the page's title.
EOF
append README.md <<'EOF'

New here? Start with [Getting started](docs/getting-started.md).
EOF
commit "$MAYA" 17 09:05 "docs: getting started"

# feature/dark-mode: in progress, never merged
git switch -q -c feature/dark-mode
edit src/theme.ts 's.replace("const dark = \"body { background: #16161a; color: #e8e6f0; }\";", "const dark = \"body { background: #16161a; color: #e8e6f0; } a { color: #b4a7ff; }\";")'
commit "$LEO" 14 10:45 "feat(theme): readable links in dark mode"
w src/toggle.ts <<'EOF'
/** A theme toggle for the page header: remembers the choice per site. */
export const toggleScript = `
  const saved = localStorage.getItem("lumen-theme");
  if (saved) document.documentElement.dataset.theme = saved;
`;
EOF
edit src/theme.ts 's.replace("import type { Config } from \"./config\";", "import type { Config } from \"./config\";\nexport { toggleScript } from \"./toggle\";")'
commit "$LEO" 13 16:20 "wip: header theme toggle"

git switch -q main
edit src/build.ts 's.replace("  for (const name of await readdir(opts.input)) {", "  const names = (await readdir(opts.input)).sort();\n  for (const name of names) {")'
commit "$JONAS" 12 13:15 "fix(build): build pages in a stable order"
tag "$MAYA" 11 09:00 v1.1.0-beta.1 "lumen 1.1.0 beta 1"

edit src/build.ts 's.replace("    const page = hit ? { path: name, title: name, html: hit } : render(name, source);", "    const title = /<h1>(.*?)<\\/h1>/.exec(hit ?? \"\")?.[1] ?? name;\n    const page = hit ? { path: name, title, html: hit } : render(name, source);")'
append test/build.test.ts <<'EOF'

test("a cached page keeps its title", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lumen-"));
  await writeFile(join(dir, "a.md"), "# Hello");
  await build({ input: dir, out: join(dir, "site") });
  const [page] = await build({ input: dir, out: join(dir, "site") });
  assert.equal(page.title, "Hello");
});
EOF
commit "$PRIYA" 9 10:40 "fix(cache): cached pages keep their titles"

w src/sitemap.ts <<'EOF'
import type { Page } from "./markdown";

export function sitemap(baseUrl: string, pages: Page[]): string {
  const urls = pages.map((p) => `  <url><loc>${baseUrl}${p.path.replace(/\.md$/, ".html")}</loc></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset>\n${urls.join("\n")}\n</urlset>\n`;
}
EOF
commit "$SOFIA" 7 10:30 "feat: sitemap.xml"

# ── origin ─────────────────────────────────────────────────────────────────

git init -q --bare -b main "$ROOT/remote/lumen.git"
git remote add origin "$ROOT/remote/lumen.git"
git push -q origin main feature/search-filters release/1.0.x feature/offline-cache --tags
git branch -q -u origin/main main
git branch -q -u origin/feature/search-filters feature/search-filters
git branch -q -u origin/release/1.0.x release/1.0.x

# A teammate lands a commit on main and one on feature/search-filters:
# both are 1 behind their upstream here.
git clone -q "$ROOT/remote/lumen.git" "$ROOT/teammate"
(
  cd "$ROOT/teammate"
  localcfg
  append CHANGELOG.md <<'EOF'

## Unreleased

- Inline links in Markdown
- Pages build in a stable order
EOF
  commit "$PRIYA" 4 15:40 "docs(changelog): note inline links and stable builds"
  git push -q origin main
  git switch -q feature/search-filters
  append src/search.ts <<'EOF'

export const MAX_RESULTS = 20;
EOF
  commit "$PRIYA" 3 11:02 "feat(search): cap results at 20"
  git push -q origin feature/search-filters
)
git fetch -q origin

# main: 2 commits not pushed yet
edit src/config.ts 's.replace("  theme: \"light\" | \"dark\" | \"auto\";", "  theme: \"light\" | \"dark\" | \"auto\";\n  sitemap: boolean;").replace("  theme: \"auto\",", "  theme: \"auto\",\n  sitemap: true,")'
append docs/configuration.md <<'EOF'

`sitemap` (default `true`) writes `sitemap.xml` next to the pages.
EOF
commit "$MAYA" 3 17:20 "feat(config): turn the sitemap off with sitemap: false"
edit src/build.ts 's.replace("import * as cache from \"./cache\";", "import * as cache from \"./cache\";\nimport { sitemap } from \"./sitemap\";").replace("  out: string;\n}", "  out: string;\n  baseUrl?: string;\n}").replace("  return pages;\n}", "  await writeFile(join(opts.out, \"sitemap.xml\"), sitemap(opts.baseUrl ?? \"/\", pages));\n  return pages;\n}")'
commit "$MAYA" 2 10:05 "feat(build): write sitemap.xml next to the pages"

# ── a linked worktree: 1 commit to push, 1 file changed ─────────────────────

git worktree add -q -b hotfix/cache-errors "$ROOT/lumen-hotfix" v1.0.1
(
  cd "$ROOT/lumen-hotfix"
  git push -q -u origin hotfix/cache-errors
  edit src/cache.ts 's.replace("  } catch {\n    return undefined;\n  }", "  } catch (err) {\n    if ((err as NodeJS.ErrnoException).code !== \"ENOENT\") throw err;\n    return undefined;\n  }")'
  commit "$JONAS" 2 14:30 "fix(cache): only a missing entry counts as a miss"
  append CHANGELOG.md <<'EOF'

## 1.0.2

- A cache read that fails for any reason but a missing file is reported,
  not silently rebuilt
EOF
)

# ── stashes (oldest first) ──────────────────────────────────────────────────

edit src/markdown.ts 's.replace(".map((block) => block.startsWith(\"#\") ? heading(block) : `<p>${inline(block)}</p>`)", ".map((block) => block.startsWith(\"|\") ? table(block) : block.startsWith(\"#\") ? heading(block) : `<p>${inline(block)}</p>`)") + "\nfunction table(block: string): string {\n  const rows = block.split(\"\\n\").filter((r) => !/^\\|[\\s:|-]+\\|$/.test(r));\n  const cells = (r: string) => r.split(\"|\").slice(1, -1).map((c) => inline(c.trim()));\n  return `<table>${rows.map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join(\"\")}</tr>`).join(\"\")}</table>`;\n}\n"'
w docs/tables.md <<'EOF'
# Tables

| Option | Default |
| --- | --- |
| `theme` | `auto` |
| `sitemap` | `true` |
EOF
git add -A
as "$MAYA" 6 16:00 -- stash push -q -m "spike: Markdown tables"

edit src/cache.ts 's.replace("const DIR = \".lumen-cache\";", "const DIR = \".lumen-cache\";\nconst RETRIES = 3;")'
git add src/cache.ts
w src/retry.ts <<'EOF'
export async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= retries) throw err;
      await new Promise((r) => setTimeout(r, 50 * 2 ** i));
    }
  }
}
EOF
as "$MAYA" 3 12:00 -- stash push -q -u -m "WIP: retry cache writes with backoff"

# ── the working tree ────────────────────────────────────────────────────────

# staged: the README's new section, and a new test
append README.md <<'EOF'

## Sitemap

`lumen build` writes `sitemap.xml` next to the pages. Set `"sitemap": false`
in `lumen.config.json` to turn it off.
EOF
w test/sitemap.test.ts <<'EOF'
import { test } from "node:test";
import assert from "node:assert/strict";
import { sitemap } from "../src/sitemap";

test("one url per page", () => {
  const xml = sitemap("https://docs.example.com/", [{ path: "a.md", title: "A", html: "" }]);
  assert.match(xml, /<loc>https:\/\/docs\.example\.com\/a\.html<\/loc>/);
});
EOF
git add README.md test/sitemap.test.ts

# unstaged: two separate changes in sitemap.ts, an edit to the CLI, and a
# new, untracked file
edit src/sitemap.ts 's.replace("import type { Page } from \"./markdown\";", "import type { Page } from \"./markdown\";\n\nconst escape = (s: string) => s.replace(/&/g, \"&amp;\").replace(/</g, \"&lt;\");").replace("<url><loc>${baseUrl}${p.path.replace(/\\.md$/, \".html\")}</loc></url>", "<url><loc>${escape(baseUrl + p.path.replace(/\\.md$/, \".html\"))}</loc></url>").replace("<urlset>", "<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">")'
edit src/cli.ts 's.replace("build({ input, out })", "const baseUrl = process.env.LUMEN_BASE_URL ?? \"/\";\nbuild({ input, out, baseUrl })")'
w docs/deploying.md <<'EOF'
# Deploying

`site/` is plain HTML: copy it to any static host.

Set `LUMEN_BASE_URL` when the docs live under a sub-path, so the sitemap's
links are absolute.
EOF

echo "built $ROOT/lumen (anchor $ANCHOR)"
git status -sb | head -1
git status --short
git stash list
git worktree list
