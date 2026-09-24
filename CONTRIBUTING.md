# Contributing to GitStudio

Issues and pull requests are welcome at
[GitStudioHQ/gitstudio](https://github.com/GitStudioHQ/gitstudio). This
repository holds the VS Code / Cursor extension, the desktop app, the MCP
server, the Merge Studio extension, and the packages they share; the
[README](README.md#monorepo-layout) maps them.

## Set up

Requires **Node 22+** and git.

```bash
npm ci
```

## Before you open a pull request

Run the three gates CI runs:

```bash
npm run check-types
npm test
npm run check-purity
```

`npm test` runs every workspace's tests. Some render pages in headless
Chrome: they find Chrome through `GS_CHROME` (a path to a Chrome or
chrome-headless-shell binary), then the usual install location, and skip when
there is none.

CI runs the same on Linux, macOS and Windows, so a test that depends on your
machine (a global git config, a path separator, a locale) will show there.

## The merge code, and Merge Studio

The merge editor, the Conflicts dashboard, Continue / Skip / Abort and the
JetBrains IDE hand-off are shared by GitStudio, the desktop app and the
[Merge Studio](https://github.com/GitStudioHQ/merge-studio) extension, and
they are kept here. Merge Studio's own repository is exported from this one,
and pull requests opened there are imported back. Read
[`docs/merge-studio.md`](docs/merge-studio.md) before changing that code: it
says which package holds what, how the export and the import work, and what
keeps the two repositories the same.

A change to the merge code is tested against the all-cases conflict matrix in
[`scripts/merge-e2e`](scripts/merge-e2e/README.md), every conflict shape in
every git operation that can stop, never one hand-made conflict.

## Releases

Releases are cut by the owner from tags; see [RELEASING.md](RELEASING.md)
for GitStudio and the desktop app, and
[`apps/merge-studio/RELEASING.md`](apps/merge-studio/RELEASING.md) for Merge
Studio. A pull request never needs to change a version.
