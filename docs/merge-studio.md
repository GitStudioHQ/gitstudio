# Merge Studio and GitStudio

Merge Studio (`gitstudio.merge-studio`) is the merge-only VS Code extension:
the three-pane merge editor, the Conflicts dashboard with Continue / Skip /
Abort, the side-by-side diff and the JetBrains IDE hand-off. GitStudio ships
the same merge experience inside the full Git client. This page says where
that code lives, how it gets to the Merge Studio repository, and how a pull
request opened there comes back here.

Who reads what:

- **This page**: anyone working on the merge code, in either repository.
- [`apps/merge-studio/RELEASING.md`](../apps/merge-studio/RELEASING.md): the
  maintainer's steps for exporting, importing and releasing.
- [`apps/merge-studio/CONTRIBUTING.md`](../apps/merge-studio/CONTRIBUTING.md):
  a contributor's guide. The export writes it to the root of the Merge Studio
  repository, where contributors find it.

## Why GitStudio is the parent

Until September 2026 Merge Studio and GitStudio each carried their own copy of
the merge code, and the copies drifted in both directions: only Merge Studio
had a Conflicts dashboard, the two opened conflicted files differently, and
both put git's own side on the left during a rebase, so **Accept Yours**
followed by Continue could drop the user's only commit (merge-studio#12).

The owner chose one copy, kept here (23 Sep 2026):

- **GitStudio is the parent.** Every change to the merge code is made in this
  repository and reviewed by its CI, which type-checks and tests GitStudio,
  the desktop app and Merge Studio together.
- **Merge Studio stays its own extension**, with its own name, Marketplace
  listing, `jbMerge.*` commands and settings, and its own repository,
  [GitStudioHQ/merge-studio](https://github.com/GitStudioHQ/merge-studio).
  That repository stays complete: it builds, tests and packages without
  GitStudio, so anyone can fork it or contribute there.
- **GitStudio is Merge Studio plus its own extras.** A parity test fails when
  either extension gains a merge command or setting the other lacks. When
  both are installed, GitStudio opens conflicts and Merge Studio stays quiet.

## Where the code lives

| Path | What it is | In Merge Studio |
| --- | --- | --- |
| `packages/engine` | The merge model: blocks and their kinds (conflict, the same on both sides, one side only), the text written back with conflict markers, which side is Yours in each operation, and the words for every operation. No editor, no git process. | `vendor/gitstudio/engine` |
| `packages/git-service` | git itself: reading a stopped operation, Continue / Skip / Abort, taking a side, restoring a conflict, finding and starting a JetBrains IDE. | `vendor/gitstudio/git-service` |
| `packages/host-bridge` | The messages between a host (an extension, the desktop app) and its pages. | `vendor/gitstudio/host-bridge` |
| `packages/webview-ui` | The pages: the merge editor with its legend and colours, the diff, the Conflicts dashboard. | `vendor/gitstudio/webview-ui` |
| `packages/merge-vscode` | The VS Code side, written once for both extensions: the merge editor and diff panels, the dashboard panel, which file opens where, the JetBrains hand-off, the sample merge. Each extension gives it a product description (its ids, brand and settings). | `vendor/gitstudio/merge-vscode` |
| `apps/extension` | GitStudio. `src/merge/` holds its product description (`gitstudio.*` ids); the rest is the Git client. | two files the parity test reads, under `vendor/gitstudio/extension` |
| `apps/merge-studio` | Merge Studio's shell: the manifest, walkthrough, media, README, CHANGELOG, CONTRIBUTING and RELEASING, and `src/` (its `jbMerge.*` ids and the few decisions only it makes). | the repository root |
| `apps/desktop` | The desktop app. It mounts the same merge editor and dashboard natively; it is not part of Merge Studio. | not exported |
| `scripts/merge-studio` | `export.mjs`, `import.mjs`, `layout.mjs` (the one map between the two repositories, which both scripts follow), `check-parity.mjs` and `merge-studio-ci.yml`. | `scripts/check-parity.mjs`, `.github/workflows/ci.yml` |
| `scripts/merge-e2e` | The all-cases conflict matrix every merge change is tested against: every conflict shape, in every git operation that can stop, in every conflict style. | not exported |

The Merge Studio repository holds the export of those, plus files the export
computes (`VENDORED_FROM.json`, a standalone `package.json`, `tsconfig.json`
and `package-lock.json`, and `vendor/gitstudio/.gitattributes`), plus its own
files, which the export never writes or removes: `release.yml`, `SECURITY.md`,
`docs/`, `test-fixtures/`, `brand-assets/` and the like.

## A contributor's pull request, from merge-studio to GitStudio and back

1. **A contributor opens a pull request on merge-studio.** They may change any
   file, `vendor/gitstudio/` included. Its CI has two jobs: `build`
   type-checks, tests and packages the change on Linux, macOS and Windows, and
   `parity` compares `vendor/gitstudio/` with GitStudio. On a pull request a
   difference there is reported as "a maintainer will import this change into
   GitStudio" and the job passes.
2. **A maintainer imports it into GitStudio.** In a gitstudio checkout, with
   merge-studio checked out beside it as `../merge-studio`, on a new branch:

   ```bash
   git -C ../merge-studio fetch origin
   git -C ../merge-studio fetch origin +pull/<n>/head:pr-<n>
   git switch -c merge-studio/pr-<n>
   node scripts/merge-studio/import.mjs --from ../merge-studio --range origin/main..pr-<n> --pr <n> --dry-run
   node scripts/merge-studio/import.mjs --from ../merge-studio --range origin/main..pr-<n> --pr <n>
   ```

   The first fetch brings merge-studio's `origin/main` up to date: the range
   starts there, and a stale one would take in commits that are not the
   contributor's, such as an export merged since you last fetched (which the
   import refuses). The dry run shows where every file goes and changes
   nothing. The import
   makes one GitStudio commit for each commit of the pull request, with the
   contributor as author and an
   `Imported-from: GitStudioHQ/merge-studio#<n> / <sha>` trailer. It maps
   `vendor/gitstudio/<package>/src/**` to `packages/<package>/src/**`,
   `.github/workflows/ci.yml` to `scripts/merge-studio/merge-studio-ci.yml`,
   and the files at merge-studio's root to `apps/merge-studio/**`. It leaves
   out what the export generates, refuses what is merge-studio's own, and
   finishes by exporting the result and comparing it with the contributor's
   files ("identical", or "merged" where GitStudio had changed the same file
   since).
   `RELEASING.md` says what each answer means and how to finish a conflict.
3. **GitStudio's CI checks it.** Push the branch and open a pull request on
   gitstudio. Its CI type-checks and tests every workspace on Linux, macOS
   and Windows. Before pushing, the same check locally:

   ```bash
   npm run check-types && npm test
   ```

4. **It is merged to GitStudio's main.**
5. **The next export brings it back to merge-studio.** From gitstudio's main,
   into a branch of merge-studio:

   ```bash
   git switch main
   git pull
   git -C ../merge-studio switch main
   git -C ../merge-studio pull
   git -C ../merge-studio switch -c export/<gitstudio sha>
   node scripts/merge-studio/export.mjs --into ../merge-studio
   git -C ../merge-studio add -A
   git -C ../merge-studio commit -m "Export gitstudio <gitstudio sha>"
   ```

   Push that branch and open a pull request on merge-studio. Its `parity` job
   passes: `vendor/gitstudio/` is GitStudio's again, now with the change in it.
6. **The contributor's pull request is closed as imported.** Once the export
   is merged, close it with a comment naming the GitStudio commits and the
   export's pull request, for example *"Imported in GitStudioHQ/gitstudio@1a2b3c4
   and exported back in #14. Thank you!"* Their commits, with them as author,
   are in GitStudio's history. If they allowed edits by maintainers, the
   export commit can be pushed onto their branch instead, and merging their
   pull request keeps their commits in merge-studio's history too.

## Exporting and releasing Merge Studio

An export is step 5 above: `export.mjs` replaces merge-studio's `src/`,
`test/` and `vendor/gitstudio/` with GitStudio's, copies the shell files,
`scripts/check-parity.mjs` and `.github/workflows/ci.yml`, and writes the
generated files. It refuses to run from a gitstudio checkout with uncommitted
changes in the exported paths, and it never commits, pushes or publishes:
what it wrote is a working-tree change for a person to review.

A release is an export with a version: the version and the CHANGELOG entry
are changed in `apps/merge-studio` here, exported, merged on merge-studio, and
the owner tags `vX.Y.Z` on merge-studio's main once its CI is green; the tag
runs merge-studio's `release.yml`, which publishes to the VS Code Marketplace
and Open VSX. The steps, the version rules and the release checklist are in
[`apps/merge-studio/RELEASING.md`](../apps/merge-studio/RELEASING.md).

## What check-parity guards

`VENDORED_FROM.json` records the GitStudio commit an export came from and a
sha256 of every file it vendored. `scripts/check-parity.mjs` (run in
merge-studio as `npm run check-parity`) hashes `vendor/gitstudio/**` again and
reports every file that was **modified**, is **missing**, or was **added**:

- on a push to merge-studio's main, and in `release.yml`, any difference
  fails. What merge-studio builds and publishes is exactly GitStudio's code;
- on a pull request (`--pull-request`, which the exported CI passes) a
  difference is reported for a maintainer to import, and the check passes.

It also warns (and with `--strict`, fails) when a file the export wrote at
merge-studio's root, such as `src/`, the README or the CI workflow, differs
from what the export wrote, since that change should come back here too. And
given a gitstudio checkout it warns when the export is behind:

```bash
node scripts/check-parity.mjs --gitstudio ../gitstudio
```

(run in merge-studio, with gitstudio checked out beside it). A missing or
unreadable `VENDORED_FROM.json` always fails. `vendor/gitstudio/.gitattributes`
keeps git from changing the line endings of the hashed files on Windows.

check-parity does not look at merge-studio's own files, and it does not judge
whether code is right: that is the tests' job, in both repositories.

## Later: letting a workflow open the GitStudio pull request

Step 2 is done by hand today. It could be a GitHub Action in merge-studio
that, when a maintainer asks (a label, or a manual run), checks out gitstudio,
runs `import.mjs` on the pull request, and opens the GitStudio pull request
itself. It is not set up, and it needs the owner:

- merge-studio's own workflow token cannot push to or open pull requests on
  another repository, so the owner would create a token for it (a
  fine-grained token or a GitHub App with contents and pull-request write
  access to GitStudioHQ/gitstudio only) and store it as a merge-studio
  secret;
- a pull request from a fork gets no secrets, so the workflow must run on the
  maintainer's request, from trusted code, and never install or run the
  contributor's code while it holds that token. `import.mjs` only reads the
  pull request's commits and runs git; GitStudio's own CI runs the tests on
  the pull request it opens.

The export direction could be automated the same way (on a push to GitStudio's
main, export and open the merge-studio pull request), with the same kind of
token for merge-studio.
