# Contributing to Merge Studio

Merge Studio's source lives in the GitStudio repository:
[GitStudioHQ/gitstudio](https://github.com/GitStudioHQ/gitstudio), under
`apps/merge-studio`. Everything that is not a brand slot — the merge engine,
the git service, the merge editor, the diff, the Conflicts dashboard and the VS
Code host glue — is shared with GitStudio in `packages/*`, so a fix there
reaches both products.

The merge-studio repository stays the product's front door: issues, stars and
releases. If it holds a `vendor/gitstudio/` folder, that folder is an exact copy
of the shared packages at the commit named in `VENDORED_FROM.json`; CI's
`check-parity` fails on any edit to it. Change the shared code in GitStudio and
export again (`node scripts/merge-studio/export.mjs --into <merge-studio>`).

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
