# GitStudio — Agent Handoff

You're picking up GitStudio. This doc is the context you need so you don't relitigate decisions or rediscover landmines. Read [README.md](README.md) first for the vision; this is the operational brief.

## Where things stand (facts, not aspirations)

- **Brand & publishing are DONE.** Publisher `gitstudio` (display "GitStudio") exists on the VS Code Marketplace and Open VSX. Domain `gitstudio.dev` is owned. The first product, **Merge Studio** (`gitstudio.merge-studio`), is live on both registries and getting real installs.
- **The release pipeline is solved.** `../vscode-extension-starter` has a token-free GitHub Actions setup: push a `vX.Y.Z` tag → it builds, tests, and publishes to both registries from repo secrets, then attaches the `.vsix` to the release. Copy that pattern verbatim; don't reinvent it.
- **The merge/diff engine exists and is tested.** In `../merge-studio/src/engine/` (pure model, unit-tested with `tsx --test`) and the webview ribbon/decoration layer in `../merge-studio/webview/`. This is the reusable heart.
- **This repo is intentionally near-empty** — vision + scaffold only. Building it is your job.

## Decisions already made (don't undo without reason)

1. **One flagship extension, not a swarm.** GitStudio is `gitstudio.gitstudio` — a single extension that grows pillar by pillar (the GitLens model). Merge Studio stays a separate, focused product. They **share an engine, not a listing**.
2. **Publisher = brand, extension = product.** The publisher id `gitstudio` is the umbrella; products are extensions under it. (This distinction cost us a day of confusion — see the war-story; don't repeat it.)
3. **Reuse before rebuild.** The merge engine and webview ribbon stack are proven. Extract, don't fork-and-drift.
4. **AI (GitBrain) is optional + BYO-key.** Don't make the core depend on it.

## Suggested first moves (highest leverage first)

1. **Extract the shared engine.** Pull `merge-studio/src/engine/` (and the parts of `webview/` that render ribbons/decorations) into a `@gitstudio/engine` package this repo can consume. Keep Merge Studio building against it too. This is the foundation — do it first and do it cleanly.
2. **Scaffold the extension** from `../vscode-extension-starter` (esbuild bundling, `vscode:prepublish`, `.vscodeignore`, CI + release workflows). You get a publishable shell in minutes.
3. **Ship pillar #1: Blame & history.** It's the highest-value, lowest-risk feature after merge — ambient (decorations + hovers, no custom editor needed), and it makes the extension immediately useful. Resist starting with the commit graph (high effort, easy to get visually wrong).
4. **Then the commit graph / log**, reusing the webview muscle.
5. **GitBrain last**, once there's a surface to attach it to (commit-message gen on the staging view, "explain this diff" on the diff/history view).

## How to work with the codebases

- **Stack:** TypeScript, esbuild bundling (`node esbuild.js`), `tsx --test` for unit tests, Monaco in the webview. Node 22+ (the test runner's `**` glob needs Node 21+ — CI must pin Node 22, this bit us).
- **Conflict detection trick** worth reusing: Merge Studio watches `.git` operation-state files directly (MERGE_HEAD, rebase dirs) for instant reaction instead of polling the git extension. See `merge-studio/src/extension.ts`.
- **Webview security:** Merge Studio already does CSP nonces correctly — copy its patterns.
- **Engine is pure and unit-tested** — keep new git logic the same way (pure model + thin VS Code adapter) so it stays testable.

## Publishing (when ready)

Don't hand-publish. Use the pipeline:
1. Scaffold from `vscode-extension-starter`, set `"publisher": "gitstudio"`, `"name": "gitstudio"` → id `gitstudio.gitstudio`.
2. Add repo secrets `VSCE_PAT` + `OVSX_PAT` (Marketplace PAT for publisher `gitstudio`; Open VSX token).
3. `git tag v0.1.0 && git push origin v0.1.0`.
4. File the Open VSX namespace-ownership claim for `gitstudio` (Option 1 / repo proof — see the guide). It clears the "not a verified publisher" warning. The full how-to is in `vscode-extension-starter/PUBLISHING.md`.

## Landmines (learned the hard way)

- **The Marketplace content filter silently blocks some publisher *names*.** A plain personal name got rejected as "suspicious content" with no explanation. `gitstudio` works. If you ever spin up a new publisher, keep the name brand-like, not personal.
- **Don't delete a published Open VSX listing that has installs — deprecate it.** Removal strands existing users (no redirect). We learned this after pulling one with 164 installs.
- **CI Node version matters** (Node 22, see above).
- **shields.io retired its VS Marketplace badges** — use a static badge or the Open VSX one. (Details in the guide.)

## Open questions for you / the owner

- License for GitStudio (Merge Studio is MIT — match it, or go source-available?).
- Monorepo (merge-studio + gitstudio + shared engine) vs. separate repos with a published `@gitstudio/engine`?
- Free vs. freemium for the suite (GitBrain/AI is the natural paid tier).
- How much of Merge Studio folds *into* GitStudio vs. stays standalone long-term.

Start with the engine extraction and blame pillar. Everything else builds on those.
