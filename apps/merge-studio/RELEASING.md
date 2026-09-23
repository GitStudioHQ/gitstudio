# Releasing Merge Studio

Merge Studio (`gitstudio.merge-studio`) is a thin shell over GitStudio's
shared merge packages. Its source is `apps/merge-studio` plus `packages/*` in
the [gitstudio](https://github.com/GitStudioHQ/gitstudio) repository, and the
[merge-studio](https://github.com/GitStudioHQ/merge-studio) repository is
exported from it: that is where Merge Studio's issues, pull requests and
releases live. Why it is arranged this way, where each part of the code lives
and the whole round trip are in gitstudio's
[`docs/merge-studio.md`](https://github.com/GitStudioHQ/gitstudio/blob/main/docs/merge-studio.md).
This file is the maintainer's steps.

Every command below runs in a gitstudio checkout with merge-studio checked
out beside it as `../merge-studio`, unless it says otherwise.

## Rules

- **A tag publishes.** Pushing a `vX.Y.Z` tag on merge-studio runs its
  `release.yml`, which publishes to the VS Code Marketplace and Open VSX. The
  owner cuts tags; nobody else does.
- **Tag a green commit.** The Marketplace never takes the same version twice,
  so a tag on a commit whose CI then goes red costs a patch release. Merge,
  wait for merge-studio's CI on main, then tag.
- **Change the version in gitstudio, by hand**: the one `"version"` line in
  `apps/merge-studio/package.json`, the `"apps/merge-studio"` entry's
  `"version"` line in gitstudio's `package-lock.json`, and the CHANGELOG
  entry. Do not run `npm version`: it rewrites the file's escapes. The export
  carries the version to merge-studio.
- **Test builds use a plain, fresh, numeric version** (`1.0.9001`,
  `1.0.9002`, …), never `1.0.0-test1`, and `package.json` goes back to the
  release version before anything is committed. A reused test number pins a
  machine to a stale build that the store will never replace.
  `test/manifest.test.ts` fails if a test version is committed.
- **The engine floor is VS Code 1.82** (`engines.vscode: ^1.82.0`): the
  shared CSS uses `color-mix()`, which older Chromium drops.

## Export

From gitstudio's main at a commit whose CI is green:

```bash
git switch main
git pull
git -C ../merge-studio switch main
git -C ../merge-studio pull
git -C ../merge-studio switch -c export/<gitstudio sha>
node scripts/merge-studio/export.mjs --into ../merge-studio
```

`export.mjs` refuses a gitstudio checkout with uncommitted changes in the
paths it exports (`--allow-dirty` overrides that, for a test build only; the
manifest then records the export as dirty). It:

- replaces merge-studio's `src/`, `test/` and `vendor/gitstudio/` (and the
  0.3.4 layout's `webview/` and `test-harness/`) with GitStudio's;
- vendors `packages/{engine,git-service,host-bridge,webview-ui,merge-vscode}`
  (their `src/` and `package.json`) under `vendor/gitstudio/`, with GitStudio's
  LICENSE and NOTICE, and the two GitStudio files the parity test reads
  (`vendor/gitstudio/extension/`);
- copies `apps/merge-studio`'s files to the repository root, and
  `scripts/merge-studio/check-parity.mjs` (and its test) to `scripts/`;
- writes `.github/workflows/ci.yml` from `scripts/merge-studio/merge-studio-ci.yml`
  (see "merge-studio's CI" below);
- writes what differs standalone: `package.json` (no `@gitstudio/*`
  workspace dependencies, and every version pinned to what gitstudio builds
  with), `tsconfig.json` (`@gitstudio/*` resolved into `vendor/gitstudio`),
  a `package-lock.json` cut from gitstudio's own, and
  `vendor/gitstudio/.gitattributes` (`* -text`, so a Windows checkout never
  rewrites the hashed files);
- removes a shell file the previous export wrote that gitstudio no longer
  has (the previous `VENDORED_FROM.json` lists them), and writes the new
  `VENDORED_FROM.json`: the gitstudio sha, and a sha256 for every file.

It never touches merge-studio's own files (`release.yml`, `SECURITY.md`,
`docs/`, `test-fixtures/`, …), and it commits, pushes and publishes nothing.

Then check it in merge-studio, as its CI will:

```bash
cd ../merge-studio
npm ci
npm run check-parity
npm run check-types
npm test
npx @vscode/vsce package --no-dependencies
npx @vscode/vsce ls --no-dependencies
```

`vsce ls` must list no `vendor/`, no `src/` and no `media/screenshots/`.
Commit the export and push the branch:

```bash
git add -A
git commit -m "Export gitstudio <gitstudio sha>"
```

Open a pull request on merge-studio. Its `parity` job must pass: an export is
GitStudio's code exactly.

## Release

1. In gitstudio, on a branch: change the version (the three places in
   "Rules") and date the CHANGELOG entry. Review, CI, merge to main.
2. Export, as above, and merge the export's pull request on merge-studio.
3. When merge-studio's CI on main is green, the owner tags that commit
   `vX.Y.Z` and pushes the tag. merge-studio's `release.yml` checks the tag
   against `package.json`, refuses a manual run from anything but a `v*` tag
   or main, runs check-parity strictly, packages once, attaches the `.vsix` to
   a GitHub Release, and publishes it to both stores.

Keep 0.3.4's `media/screenshots/*` on merge-studio's main until 1.0.0 is live
on both stores: the published 0.3.4 README loads them from `raw/HEAD`.

## Pull requests on merge-studio

Contributors open pull requests on GitStudioHQ/merge-studio and may change
anything there, `vendor/gitstudio/` included. CI tests them (the `build` job)
and says a change to `vendor/gitstudio/` is one a maintainer imports (the
`parity` job, which passes). Their change is kept by importing it into
gitstudio and exporting again:

1. **Get the pull request**, into your merge-studio checkout:

   ```bash
   git -C ../merge-studio fetch origin
   git -C ../merge-studio fetch origin +pull/<n>/head:pr-<n>
   ```

   The first line brings `origin/main` up to date. The import's range starts
   there, and a stale one takes in commits that are not the contributor's,
   such as an export merged since you last fetched, which the import refuses.
   The `+` fetches the pull request again after the contributor pushes to it.

   Or as a file: `gh pr diff <n> --repo GitStudioHQ/merge-studio --patch > pr.patch`
   keeps every commit and its author; plain
   `gh pr diff <n> --repo GitStudioHQ/merge-studio > pr.patch` is one squashed
   diff with no author, so it needs `--author "Name <email>"`.
2. **Import it, on a branch**:

   ```bash
   git switch -c merge-studio/pr-<n>
   node scripts/merge-studio/import.mjs --from ../merge-studio --range origin/main..pr-<n> --pr <n> --dry-run
   node scripts/merge-studio/import.mjs --from ../merge-studio --range origin/main..pr-<n> --pr <n>
   ```

   or, from a file:

   ```bash
   node scripts/merge-studio/import.mjs --patch pr.patch --pr <n>
   node scripts/merge-studio/import.mjs --patch pr.patch --pr <n> --author "Name <email>"
   ```

   (the second for a plain, squashed `gh pr diff`). `--dry-run` shows where
   every file goes and changes nothing. The import makes one gitstudio commit
   for each commit of the pull request, with the contributor as author, their
   date and message, and an `Imported-from: GitStudioHQ/merge-studio#<n> / <sha>`
   trailer. It maps paths by `scripts/merge-studio/layout.mjs`, the same table
   the export writes by: `vendor/gitstudio/<pkg>/src/**` → `packages/<pkg>/src/**`,
   `.github/workflows/ci.yml` → `scripts/merge-studio/merge-studio-ci.yml`,
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
     merge-studio's own `release.yml`, `docs/` or `SECURITY.md`, or a new file
     outside the shell's folders. Merge that part in merge-studio directly
     and run the import again with `--exclude <path>`. Merge commits in the
     range (ask for a rebase, or import the squashed diff), `main`, and
     uncommitted changes are refused too. So is a pull request on an older
     export that changes a file gitstudio has since deleted or moved (the
     message names the gitstudio commit, and where the file went), and a
     commit that is merge-studio's own export, which a pull request picks up
     by merging main: replaying it could bring back what gitstudio reverted
     since. Import the squashed diff instead, or a range that starts after it.
     Most often the export is simply on merge-studio's main and your
     `origin/main` is older than it; the message then says to run
     `git -C ../merge-studio fetch origin` and import the same range again.
   - *Skipped*: a commit that changes only generated files, or whose changes
     gitstudio already has. The rest of the pull request is still imported.
   - *Could not apply, and nothing of it was changed*: the pull request was
     made on files gitstudio does not have in that form, most often one opened
     before the first export, on 0.3.4's layout. Ask the contributor to rebase
     it onto merge-studio's main.
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
4. **Review and test it like any gitstudio branch**, then push it, open a
   pull request on gitstudio, and merge it once its CI is green:

   ```bash
   npm run check-types && npm test
   ```

5. **Export, and close the loop on merge-studio** ("Export" above). If the
   contributor allowed edits by maintainers, push the export commit onto
   their pull request's branch: `parity` passes, and merging the pull request
   keeps their commits in merge-studio's history as well. Otherwise merge the
   export on its own, and close the pull request with a comment naming the
   gitstudio commits ("Imported in GitStudioHQ/gitstudio@1a2b3c4 and exported
   back in #14").

## merge-studio's CI

The export writes merge-studio's `.github/workflows/ci.yml` from
`scripts/merge-studio/merge-studio-ci.yml`; change it there. On a push to main
and on every pull request it runs two jobs side by side:

- `parity` runs `node scripts/check-parity.mjs`, with `--pull-request` on a
  pull request. On a pull request a difference in `vendor/gitstudio/` is
  reported as "a maintainer will import this change into GitStudio" (a notice
  and a step summary) and the job passes; on main any difference fails. A
  missing or broken `VENDORED_FROM.json` fails either way.
- `build` runs `npm ci`, `npm run check-types` and `npm test` on Linux, macOS
  and Windows, and packages the `.vsix` on Linux. It does not wait for
  `parity`, so a pull request that changes `vendor/gitstudio/` still gets its
  type-check and test results.

A contributor's change to the workflow is imported like any shell file.
merge-studio's `release.yml` is its own: the export does not write it, and it
keeps its strict `check-parity` step, since a release must match gitstudio
exactly.

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
   `repo:GitStudioHQ/merge-studio:ref:refs/tags/*` (and the same for
   `GitStudioHQ/gitstudio`, for the GitStudio extension), audience
   `api://AzureADTokenExchange`.
3. In the Marketplace publisher management page for `gitstudio`, add that
   identity as a member with the Contributor role.
4. Store its `AZURE_CLIENT_ID` and `AZURE_TENANT_ID` as repository secrets
   (they are identifiers, not credentials), give the release workflow
   `permissions: id-token: write`, sign in with `azure/login@v2`
   (`client-id`, `tenant-id`, `allow-no-subscriptions: true`), and publish
   with `vsce publish --azure-credential`.

Until then, `vsce publish -p "$VSCE_PAT"` keeps working with a PAT scoped to
"Marketplace > Manage" for the `gitstudio` publisher. Open VSX is unaffected
(`OVSX_PAT`).

## Checklist for 1.0.0

- [ ] The owner's decisions are settled (architecture: GitStudio is the
      parent, chosen 23 Sep 2026; the version, 1.0.0; licence, engine floor,
      auto-apply default, coexistence question).
- [ ] Listing shots captured from the final build per SHOTS.md; the
      walkthrough's placeholder SVGs replaced.
- [ ] gitstudio: `npm run check-types && npm test` green.
- [ ] Exported; in merge-studio `npm ci`, `npm run check-parity`,
      `npm run check-types` and `npm test` green, and `vsce ls` shows no
      `vendor/`, no `src/` and no `media/screenshots/`.
- [ ] A test VSIX (`1.0.9xxx`) installed into isolated VS Code and Cursor
      profiles: the reporter's rebase (merge-studio#12) resolves with Yours on
      the left and Continue Rebase completes it.
- [ ] `package.json` back at `1.0.0`, CHANGELOG dated.
- [ ] merge-studio's `release.yml` publishes with a token that is still
      valid (see "Marketplace credentials").
- [ ] The export's pull request merged, merge-studio's CI green on main, then
      the owner tags `v1.0.0`.

## Not chosen: releasing from the monorepo

The alternative was to publish Merge Studio from gitstudio itself, on
`ms-v*` tags, with no merge-studio export. The owner chose the export
(23 Sep 2026) so that merge-studio stays a complete repository of its own.
That draft workflow is in git history (this file as of commit 482273b), should
it ever be wanted.
