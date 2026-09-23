# Releasing Merge Studio

Merge Studio (`gitstudio.merge-studio`) is a thin shell over GitStudio's shared
merge packages. Its source of truth is `apps/merge-studio` plus `packages/*` in
the gitstudio repository. It can ship from either place, and which one is the
owner's choice (PLAN §1, D6):

- **A — from the gitstudio monorepo**, on `ms-v*` tags, with the workflow
  below. Nothing is copied; one commit builds GitStudio and Merge Studio from
  the same packages.
- **B — from the merge-studio repository**, on its existing `v*` tags, after
  `node scripts/merge-studio/export.mjs --into <merge-studio checkout>` has
  vendored the packages (see "Option B" below). `check-parity.mjs` fails its
  CI if a vendored file is edited there.

The owner chose B (23 Sep 2026): gitstudio is the parent of the merge code,
merge-studio is exported from it and stays a complete repository of its own,
and pull requests opened on merge-studio are imported back into gitstudio (see
"Pull requests on merge-studio" below).

Nothing in this file is active. The workflow is text: no file under
`.github/` in the gitstudio repository was added or changed for it.

## Rules that hold either way

- **A tag publishes.** Pushing `ms-v0.4.0` (A) or `v0.4.0` (B) releases to the
  VS Code Marketplace and Open VSX. The owner cuts tags; nobody else does.
- **Tag a green commit.** The Marketplace never republishes a version, so a
  tag on a commit whose CI later goes red costs a patch release. Push, wait
  for CI, then tag.
- **Bump the version by hand.** Change the one `"version"` line in
  `package.json` (and the lockfile's workspace entry under A) and add the
  CHANGELOG entry. Do not run `npm version`: it rewrites the file's escapes.
- **Test builds use a plain, fresh, numeric version** (`0.4.9001`,
  `0.4.9002`, …), never `0.4.0-test1`, and `package.json` goes back to the
  release version before anything is committed. A reused test number pins a
  machine to a stale build that the store will never replace.
  `test/manifest.test.ts` fails if a test version is committed.
- **The engine floor is VS Code 1.82** (`engines.vscode: ^1.82.0`): the
  shared CSS uses `color-mix()`, which older Chromium drops.

## Option A: the `ms-v*` workflow

Save as `.github/workflows/release-merge-studio.yml` in the gitstudio
repository when the owner chooses A. It is modelled on `release.yml` (the
GitStudio extension's `ext-v*` channel).

```yaml
name: Release Merge Studio

# Publishes Merge Studio to the VS Code Marketplace and Open VSX when an
# `ms-vX.Y.Z` tag is pushed, and attaches the .vsix to a GitHub Release.
# Channels in this repository: ext-v* (GitStudio extension, release.yml),
# app-v* (desktop app, release-desktop.yml), ms-v* (this file).
#
# Before the FIRST ms-v* release: disable the merge-studio repository's own
# release.yml (v* tags), or one release can be published twice.

on:
  push:
    tags:
      - 'ms-v*.*.*'
  workflow_dispatch:

permissions:
  contents: write
  id-token: write        # Entra ID (OIDC) Marketplace publishing, below
  attestations: write

concurrency:
  group: release-merge-studio-${{ github.ref }}
  cancel-in-progress: false

jobs:
  release:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: apps/merge-studio
    env:
      OVSX_PAT: ${{ secrets.OVSX_PAT }}
    steps:
      - uses: actions/checkout@v7

      - uses: actions/setup-node@v7
        with:
          node-version: '22'
          cache: npm

      # workflow_dispatch re-runs only from a tag or main, never a branch.
      - name: "Guard: dispatched from a tag or main"
        if: github.event_name == 'workflow_dispatch'
        run: |
          case "$GITHUB_REF" in
            refs/tags/ms-v*|refs/heads/main) ;;
            *) echo "::error::Run this from an ms-v* tag or main, not $GITHUB_REF"; exit 1 ;;
          esac

      # The tag names the release, but vsce ships whatever package.json says.
      - name: "Guard: tag matches package.json version"
        if: startsWith(github.ref, 'refs/tags/')
        run: |
          node -e '
            const v = require("./package.json").version;
            const tag = process.env.GITHUB_REF_NAME.replace(/^ms-v/, "");
            if (v !== tag) {
              console.error(`Tag ms-v${tag} != apps/merge-studio/package.json version ${v}`);
              process.exit(1);
            }'

      - name: Install (workspace root)
        run: npm ci
        working-directory: .

      - name: Type-check and test (the shared packages and both products)
        run: |
          npm run check-types
          npm test
        working-directory: .
        env:
          REQUIRE_CHROME: '1'

      # --baseImagesUrl / --baseContentUrl: README images live under
      # apps/merge-studio, and are pinned to THIS tag so a later change on main
      # can never alter a published listing.
      - name: Package
        run: |
          npm run package
          npx --no-install vsce package -o merge-studio.vsix --no-dependencies \
            --baseImagesUrl "https://github.com/GitStudioHQ/gitstudio/raw/${GITHUB_REF_NAME}/apps/merge-studio/" \
            --baseContentUrl "https://github.com/GitStudioHQ/gitstudio/blob/${GITHUB_REF_NAME}/apps/merge-studio/"
          npx --no-install vsce ls --no-dependencies | sort > vsce-files.txt
          diff -u test/vsce-files.snapshot vsce-files.txt

      - uses: actions/attest-build-provenance@v4
        with:
          subject-path: apps/merge-studio/merge-studio.vsix

      # `--latest=false` is load-bearing: the desktop app's auto-updater reads
      # /releases/latest. A Merge Studio release marked "latest" would point it
      # at a tag with no latest.yml feed, and every update check would 404.
      # The .vsix is attached BEFORE publishing, so a failed publish still
      # leaves a downloadable artifact.
      - name: Attach .vsix to the GitHub Release
        if: startsWith(github.ref, 'refs/tags/')
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          gh release create "${GITHUB_REF_NAME}" merge-studio.vsix --latest=false \
            --title "Merge Studio ${GITHUB_REF_NAME#ms-v}" --generate-notes \
            || gh release upload "${GITHUB_REF_NAME}" merge-studio.vsix --clobber

      # Marketplace: Entra ID workload identity (OIDC), no stored PAT. See
      # "Marketplace credentials" below for the one-time setup.
      - uses: azure/login@v2
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          allow-no-subscriptions: true

      - name: Publish to VS Code Marketplace
        run: npx --no-install vsce publish --azure-credential --skip-duplicate --packagePath merge-studio.vsix

      - name: Publish to Open VSX
        run: |
          if [ -z "$OVSX_PAT" ]; then
            echo "::error::OVSX_PAT is missing, so Open VSX was NOT published. Add the secret, then re-run this workflow from the tag."
            exit 1
          fi
          npx --no-install ovsx publish merge-studio.vsix --skip-duplicate -p "$OVSX_PAT"
```

For `npx --no-install` to find them, `@vscode/vsce` and `ovsx` are pinned
devDependencies of the workspace root (a lockfile change, made with the
workflow). `test/vsce-files.snapshot` is the sorted `vsce ls` output of a good
build, committed with the workflow.

Add a Merge Studio smoke job to `ci.yml` beside the extension's VSIX job:
`npm run package --workspace apps/merge-studio`, `vsce package`, and an
`@vscode/test-electron` run on `['1.82.0', 'stable']` that activates the
extension, runs `jbMerge.openDemo` and asserts the custom editor resolved.

## Option B: releasing from the merge-studio repository

1. In a gitstudio checkout at a green commit:
   `node scripts/merge-studio/export.mjs --into ../merge-studio`
   (refuses a dirty gitstudio tree unless `--allow-dirty`). It replaces the
   repository's `src/`, `webview/` and `test/` with the shell, vendors
   `packages/{engine,git-service,host-bridge,webview-ui,merge-vscode}/src`
   under `vendor/gitstudio/`, writes `VENDORED_FROM.json` (the gitstudio sha
   and a sha256 per vendored file), a standalone `tsconfig.json` and
   `package.json`, and a `package-lock.json` pinned to the exact versions
   gitstudio builds with. A shell file the previous export wrote (its
   `VENDORED_FROM.json` lists them) that `apps/merge-studio` no longer has
   is removed; merge-studio's own files are never touched.
2. In merge-studio: `npm ci && npm run check-parity && npm run check-types && npm test`,
   then open a PR. Its CI runs the same, and `check-parity` fails on any edit
   to `vendor/**`: make the change in gitstudio and export again. When the
   edit is a contributor's pull request, import it (next section).
3. Tag `vX.Y.Z` on merge-studio's `main` as before. Its `release.yml` guards
   the tag against `package.json`, refuses a manual run from anything but a
   `v*` tag or `main`, and runs `check-parity` before packaging.
   The merge-studio repository has no desktop app, so `--latest` does not
   matter there.

Keep `media/screenshots/*` of 0.3.4 on merge-studio's `main` until 0.4.0 is
live on both stores: the published 0.3.4 README loads them from `raw/HEAD`.

## Pull requests on merge-studio

Contributors open pull requests on GitStudioHQ/merge-studio and may change
anything there, `vendor/gitstudio/` included. The `check-parity` step fails on
a vendored edit, and its message tells them that is expected. Their change is
kept by importing it into gitstudio and exporting again. In a gitstudio
checkout:

1. **Get the pull request.** Into a merge-studio checkout:
   `git -C ../merge-studio fetch origin pull/<n>/head:pr-<n>`. Or as a file:
   `gh pr diff <n> --repo GitStudioHQ/merge-studio --patch > pr.patch` keeps
   every commit and its author; plain
   `gh pr diff <n> --repo GitStudioHQ/merge-studio > pr.patch` is one
   squashed diff with no author, so it needs `--author "Name <email>"`.
2. **Import it, on a branch.**

   ```bash
   git switch -c merge-studio/pr-<n>
   node scripts/merge-studio/import.mjs --from ../merge-studio --range origin/main..pr-<n> --pr <n> --dry-run
   node scripts/merge-studio/import.mjs --from ../merge-studio --range origin/main..pr-<n> --pr <n>
   # or, from a file:
   node scripts/merge-studio/import.mjs --patch pr.patch --pr <n>
   ```

   `--dry-run` shows where every file goes and changes nothing. The import
   makes one gitstudio commit for each commit of the pull request, with the
   contributor as author, their date and message, and an
   `Imported-from: GitStudioHQ/merge-studio#<n> / <sha>` trailer. It maps
   paths by `scripts/merge-studio/layout.mjs`, the same table the export
   writes by: `vendor/gitstudio/<pkg>/src/**` → `packages/<pkg>/src/**`,
   the shell's files at the root → `apps/merge-studio/**`.
3. **Read what it says.**
   - *Not imported*: the files the export writes itself (`VENDORED_FROM.json`,
     `package-lock.json`, `tsconfig.json`, and in `package.json` the
     dependency block and the `check-types`, `test` and `check-parity`
     scripts). The rest of a `package.json` change, a version bump for one,
     goes into `apps/merge-studio/package.json`, and gitstudio's lockfile
     entry follows the version. A dependency change is made by hand in
     gitstudio (`npm install` in the workspace that needs it). Each commit
     lists what was left out in `Import-note:` trailers.
   - *Refused*, with nothing changed: a path that is not gitstudio's, such as
     merge-studio's own `.github/`, `docs/` or `SECURITY.md`, or a new file
     outside the shell's folders. Merge that part in merge-studio directly
     and run the import again with `--exclude <path>`. Merge commits in the
     range (ask for a rebase, or import the squashed diff), `main`, and
     uncommitted changes are refused too. So is a pull request on an older
     export that changes a file gitstudio has since deleted or moved (the
     message names the gitstudio commit, and where the file went), and a
     commit that is merge-studio's own export, which a pull request picks up
     by merging main: replaying it could bring back what gitstudio reverted
     since. Import the squashed diff instead, or a range that starts after it.
   - *Skipped*: a commit that changes only generated files, or whose changes
     gitstudio already has. The rest of the pull request is still imported.
   - *Stopped on a conflict*: gitstudio changed the same lines since the
     export. The conflict markers are in the files, and the message gives the
     `git add` and `git commit --author=…` lines that finish that commit, and
     the `--range` for the rest. A binary file (an image) has no markers: the
     message gives the `git checkout --theirs` line that takes the
     contributor's version.
   - *Round trip*: the import exports the result over the export it started
     from, as the next export will go over merge-studio, and compares every
     file the contributor changed, deleted or moved with their branch.
     "identical" is the usual answer. "merged" means gitstudio had changed
     that file too since the export, so the next export carries both. A
     "DIFFERENT" fails the import (exit 1): the next export would not write
     what the contributor wrote, so check those commits before keeping them.
     A pull request that adds a dependency to a vendored `package.json` is
     imported, but the export cannot run until that dependency is installed
     in gitstudio; the import says so after making the commits.
4. **Review and test it like any gitstudio branch**
   (`npm run check-types && npm test`), then merge it.
5. **Export, and close the loop on merge-studio** (Option B, step 1). If the
   contributor allowed edits by maintainers, push the export commit onto
   their pull request's branch: `check-parity` passes, and merging the pull
   request keeps their commits in merge-studio's history as well. Otherwise
   merge the export on its own, and close the pull request with a link to the
   gitstudio commits.

merge-studio's `ci.yml` runs `check-parity` before `npm ci`, so a pull request
that edits `vendor/gitstudio/` stops there and never gets type-check or test
results. That workflow is merge-studio's own (the export does not write it).
Giving the check its own job lets the build job run anyway:

```yaml
  parity:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      # A contributor's edit to vendor/gitstudio fails here by design; the
      # build job still type-checks and tests it.
      - run: node scripts/check-parity.mjs
```

and the "Vendored GitStudio code is unedited" step comes out of the build job.
`release.yml` keeps its own `check-parity` step: a release must match
gitstudio exactly.

## Marketplace credentials: act before 2026-12-01

Azure DevOps stops accepting **global personal access tokens on
2026-12-01**. Both `gitstudio.gitstudio` and `gitstudio.merge-studio` publish
with one (`VSCE_PAT`), so both break that day. Check whether the current
token has already expired.

The replacement needs no stored secret: **Microsoft Entra ID workload
identity federation (GitHub OIDC)**. One-time setup, owner only:

1. In Azure, create a user-assigned managed identity (or an app
   registration).
2. Add a federated credential for GitHub Actions: issuer
   `https://token.actions.githubusercontent.com`, subject
   `repo:GitStudioHQ/gitstudio:ref:refs/tags/*` (and the same for
   `GitStudioHQ/merge-studio` under option B), audience
   `api://AzureADTokenExchange`.
3. In the Marketplace publisher management page for `gitstudio`, add that
   identity as a member with the Contributor role.
4. Store its `AZURE_CLIENT_ID` and `AZURE_TENANT_ID` as repository secrets
   (they are identifiers, not credentials), grant the workflow
   `id-token: write`, and publish with `azure/login@v2` then
   `vsce publish --azure-credential`, as above.

Until then, `vsce publish -p "$VSCE_PAT"` keeps working with a PAT scoped to
"Marketplace > Manage" for the `gitstudio` publisher. Open VSX is unaffected
(`OVSX_PAT`).

## Checklist for 0.4.0

- [ ] The owner's decisions are settled (architecture: B, chosen 23 Sep 2026;
      licence, engine floor, auto-apply default, coexistence question).
- [ ] Listing shots captured from the final build per SHOTS.md; the
      walkthrough's placeholder SVGs replaced.
- [ ] `npm run check-types && npm test` green; `vsce ls` shows no
      `media/screenshots/` and no `vendor/`.
- [ ] A test VSIX (`0.4.9xxx`) installed into isolated VS Code and Cursor
      profiles: the reporter's rebase (merge-studio#12) resolves with Yours on
      the left and Continue Rebase completes it.
- [ ] `package.json` back at `0.4.0`, CHANGELOG dated.
- [ ] Push, wait for green CI, then the owner tags.
