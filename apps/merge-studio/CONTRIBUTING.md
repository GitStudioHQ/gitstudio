# Contributing to Merge Studio

Thank you for helping. Pull requests are welcome here, on
[GitStudioHQ/merge-studio](https://github.com/GitStudioHQ/merge-studio), and
you can change any file in them.

## How this repository is made

Merge Studio's merge editor, diff, Conflicts dashboard and VS Code glue are
shared with [GitStudio](https://github.com/GitStudioHQ/gitstudio), and are kept
there: this repository is **exported** from GitStudio, and stays a complete
repository of its own that builds, tests and packages without it.

- `vendor/gitstudio/` is an exact copy of GitStudio's shared packages, at the
  GitStudio commit named in `VENDORED_FROM.json`: the merge engine, the git
  service, the merge editor and dashboard pages, and the VS Code host they run
  in.
- `src/`, `test/`, `media/`, the README, CHANGELOG and this file are Merge
  Studio's own shell (`apps/merge-studio` in GitStudio).
- A few files are written by the export: `VENDORED_FROM.json`,
  `package-lock.json`, `tsconfig.json`, `.github/workflows/ci.yml`,
  `scripts/check-parity.mjs`, and in `package.json` the dependency lists and
  the `check-types`, `test` and `check-parity` scripts.
- Everything else (`release.yml`, `SECURITY.md`, `docs/`, `test-fixtures/`,
  `brand-assets/`) belongs to this repository alone.

GitStudio's [`docs/merge-studio.md`](https://github.com/GitStudioHQ/gitstudio/blob/main/docs/merge-studio.md)
explains why, and where every part of the code lives.

## Sending a change

Fork this repository, make your change on a branch, and check it:

```bash
npm ci
npm run check-types
npm test
```

Then open a pull request. Its CI runs two jobs:

- **build** type-checks, tests and packages your change on Linux, macOS and
  Windows.
- **parity** compares `vendor/gitstudio/` with GitStudio. If your pull request
  changes a file there, it says *a maintainer will import this change into
  GitStudio*, and passes: that is expected, and nothing is wrong with your
  change. You can see the same message before you push:

  ```bash
  npm run check-parity -- --pull-request
  ```

What happens next: a maintainer brings your pull request into GitStudio with
its import script. Each of your commits becomes a GitStudio commit with you as
its author, reviewed and tested by GitStudio's CI, and the next export brings
the change back here. Your pull request is then merged, or closed with a
comment naming the GitStudio commits it became.

A change to a file the export writes is still welcome, with two exceptions it
cannot carry over: the generated files (`VENDORED_FROM.json`,
`package-lock.json`, `tsconfig.json`) and `package.json`'s dependency lists
and generated scripts. The rest of `package.json` (the version, commands,
settings) is carried over. If your change needs a new dependency, say so in
the pull request and a maintainer adds it in GitStudio.

A change to this repository's own files (`release.yml`, `SECURITY.md`,
`docs/`, `test-fixtures/`, …) is merged here directly.

You can also send a change to GitStudio itself: change `apps/merge-studio` or
`packages/*` there, and the next export brings it here.

## Layout

| Path | What it is |
| --- | --- |
| `src/extension.ts` | Builds Merge Studio's product description (brand, `jbMerge.*` ids, settings section, support links) and calls the shared registrar. The walkthrough is here too. |
| `src/ids.ts` | Every `jbMerge.*` id. 0.3.4's are kept exactly. |
| `src/msProduct.ts`, `src/shell.ts`, `src/links.ts`, `src/lateLocator.ts` | The shell's few decisions, each testable without VS Code. |
| `test/parity.test.ts` | Every `jbMerge.*` command, setting and menu has its `gitstudio.*` twin, and the reverse. |
| `test/manifest.test.ts` | The listing: manifest, walkthrough, README and CHANGELOG rules. |
| `vendor/gitstudio/merge-vscode` (`packages/merge-vscode` in GitStudio) | The shared VS Code host: merge editor, dashboard, routing, JetBrains hand-off, diff panel. |
| `vendor/gitstudio/webview-ui` (`packages/webview-ui`) | The pages: merge editor, legend, diff, Conflicts dashboard. |
| `vendor/gitstudio/engine`, `vendor/gitstudio/git-service` (`packages/…`) | The merge model and git. |

## Build and test

Here:

```bash
npm ci
npm run check-types
npm test
npx @vscode/vsce package --no-dependencies
```

Press **F5** in VS Code with this folder open to start an Extension
Development Host with your build.

In a GitStudio checkout, Merge Studio is the `apps/merge-studio` workspace:

```bash
npm ci
npm run check-types --workspace apps/merge-studio
npm test --workspace apps/merge-studio
npm run package --workspace apps/merge-studio
```

Test builds use a plain numeric version (`1.0.9001`, then `1.0.9002`, …), and
`package.json` goes back to the release version before you commit.
[RELEASING.md](RELEASING.md) has the maintainer's side: exporting, importing a
pull request, and releasing.
