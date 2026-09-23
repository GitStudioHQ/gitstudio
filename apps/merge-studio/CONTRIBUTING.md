# Contributing to Merge Studio

Merge Studio is kept in the GitStudio repository,
[GitStudioHQ/gitstudio](https://github.com/GitStudioHQ/gitstudio): the
extension's own files are `apps/merge-studio`, and everything that is not a
brand slot (the merge engine, the git service, the merge editor, the diff, the
Conflicts dashboard and the VS Code host glue) is shared with GitStudio in
`packages/*`, so a fix there reaches both products.

The [merge-studio](https://github.com/GitStudioHQ/merge-studio) repository is
exported from it and stays a complete repository of its own: it builds, tests
and packages without GitStudio, and it is where Merge Studio's issues and
releases live. Its `vendor/gitstudio/` folder is an exact copy of the shared
packages at the GitStudio commit named in `VENDORED_FROM.json`.

## Sending a change

Open a pull request in whichever repository suits you.

**On merge-studio.** Change any file, `vendor/gitstudio/` included. CI's
`check-parity` step then fails, because `vendor/gitstudio/` no longer matches
GitStudio: that is expected, and not a problem with your change. Check the
change itself with `npm run check-types && npm test`. A maintainer brings your
pull request into GitStudio with `scripts/merge-studio/import.mjs`; each of
your commits becomes a GitStudio commit with you as its author, and the next
export brings the change back to merge-studio. Your pull request is then
merged, or closed with a link to where it landed.

A few files are written by the export, so a change to them is not carried
over: `VENDORED_FROM.json`, `package-lock.json`, `tsconfig.json`, and in
`package.json` the dependency lists (`devDependencies`, `dependencies`,
`overrides`) and the `check-types`, `test` and `check-parity` scripts. The
rest of `package.json` (the version, commands, settings) is carried over. If
your change needs a new dependency, say so in the pull request and a
maintainer adds it in GitStudio.

merge-studio's own files, the ones GitStudio does not have (`.github/`,
`docs/`, `SECURITY.md`, `test-fixtures/` and the like), are merged in
merge-studio directly.

**On GitStudio.** Change `apps/merge-studio` or `packages/*` there, and the
next export brings it to merge-studio.

## Layout

| Path | What it is |
| --- | --- |
| `src/extension.ts` | Builds `MS_PRODUCT` (brand, `jbMerge.*` ids, settings section, support links) and calls the shared registrar. The walkthrough lives here too. |
| `src/ids.ts` | Every `jbMerge.*` id. 0.3.4's are kept exactly. |
| `src/msProduct.ts`, `src/shell.ts`, `src/links.ts`, `src/lateLocator.ts` | The shell's few decisions, each vscode-free and unit-tested. |
| `test/parity.test.ts` | Every `jbMerge.*` command, setting and menu has its `gitstudio.*` twin, and the reverse. |
| `test/manifest.test.ts` | The listing: manifest, walkthrough, README and CHANGELOG rules. |
| `packages/merge-vscode` (gitstudio) or `vendor/gitstudio/merge-vscode` (merge-studio) | The shared VS Code host: merge editor, dashboard, routing, JetBrains hand-off, diff panel. |

## Build and test

In the gitstudio repository:

```bash
npm install
npm run check-types --workspace apps/merge-studio
npm test --workspace apps/merge-studio
npm run package --workspace apps/merge-studio   # dist/: the extension and the webviews
```

In an exported merge-studio checkout:

```bash
npm ci
npm run check-parity
npm run check-types
npm test
npx @vscode/vsce package --no-dependencies
```

Press **F5** in VS Code with `apps/merge-studio` open to start an Extension
Development Host.

Test builds use a plain numeric version (`0.4.9001`, then `0.4.9002`, …) and
`package.json` goes back to the release version before you commit. See
RELEASING.md.
