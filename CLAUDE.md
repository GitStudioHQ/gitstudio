# GitStudio — notes for coding agents

## Before you push

`npm run verify` runs exactly what CI runs, in CI's order: every workspace's
full type-check (the desktop renderer has its own `tsconfig.renderer.json`,
which `tsc -p apps/desktop` alone misses), the engine purity guard, the
translation gates with drift, then the whole test suite. `npm run verify --
--fast` skips the tests. "It passed locally" should mean this.

## Releasing

Use the scripts, not ad-hoc loops: `scripts/release/land.sh <pr>` merges only
when every check on the PR's current head passed and CodeQL found nothing new;
`scripts/release/tag.sh <sha> ext-vX app-vY` tags only a green main commit with
zero open code-scanning and Dependabot alerts and matching versions. The
release workflows do not re-run the tests — they require the commit's own CI
to have passed (`scripts/release/ci-passed.mjs`).

## Code graph (graphify)

`graphify-out/graph.json` is a local, code-only knowledge graph of the repo
(tree-sitter, no network, no LLM): ~14k symbols, ~44k edges. It is not
committed; git hooks rebuild it in the background after each commit and
checkout. Build or refresh it by hand with `graphify update .` (about 20 s).
Requires `uv tool install graphifyy` once per machine.

Use it for structural questions about named symbols — it answers in one call
what otherwise takes several greps and file reads:

- `graphify affected "rewriteMany()"` — everything that calls, imports or
  re-exports it, across the extension, the desktop app and the tests. Run this
  before changing a shared function: a fix applied to one of two twin call
  sites (extension vs desktop) has shipped half-done before.
- `graphify explain "planMany()"` — a symbol's file, line and every
  connection in and out.
- `graphify path "rewordHere()" "runRebasePlan()"` — how two symbols connect.
- `graphify god-nodes --top 20` — the most connected hubs.

Free-text `graphify query "…"` matches keywords and is noisy here (tests
dominate); prefer the symbol commands above, then grep. Function names take
`()`; methods are `.name()`.
