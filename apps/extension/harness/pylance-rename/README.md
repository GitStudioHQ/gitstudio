# Pylance rename A/B (issue #25)

Report: with GitStudio enabled, Pylance's **Rename Symbol** updates the
definition but not the usages elsewhere in the project, with no error shown
(GitStudio 1.12.0, Pylance 2026.3.1, VS Code 1.135, macOS Tahoe).

This harness runs the same rename in an isolated VS Code **with and without
GitStudio** in the extensions dir, against the Pylance you actually have
installed, and compares what lands on disk. It exists because the question
"does GitStudio break this?" has to be answered by running it, and the first
version of this harness lived in a scratch dir and was lost.

## Run

```sh
# once: build the two extension dirs from a GitStudio .vsix (the reporter's build)
zsh apps/extension/harness/pylance-rename/setup.sh path/to/gitstudio.vsix

# one cell, provider path (Pylance's edit applied as a refactoring, like F2):
zsh apps/extension/harness/pylance-rename/run.sh on  busy
zsh apps/extension/harness/pylance-rename/run.sh off plain

# one cell, the REAL rename widget driven over CDP (F2 → type → Enter):
zsh apps/extension/harness/pylance-rename/runui.sh on busy
```

Scenarios: `plain`, `busy`, `open`, `diffeditor`, `autosave` — see the header
of `driver/test.js`. Each run rebuilds the fixture repo (`mkproj.sh`: six files
referencing `MAX_RETRIES` through four import styles), opens a real VS Code
window, waits for Pylance to answer with a stable multi-file edit, performs the
rename, then logs per file how many `MAX_RETRIES` / `MAX_ATTEMPTS` are on disk,
which documents are still dirty, and Pylance's error diagnostics 8 s later.
Logs land in `$GSQA_DIR/out/<on|off>-<scenario>-<mode>.log`; the last line is a
`SUMMARY {...}` JSON. UI runs also save `shot-<on|off>-<scenario>.png`.

Gotchas, learned the expensive way:

- `GSQA_DIR` defaults to `/tmp/gsqa-pylance` and the user-data-dir is
  `/tmp/gsqa-udd-<on|off>`: the extension host's IPC socket path has a ~103
  char limit, and a long path fails with an empty log.
- `--disable-extension` is ignored in `--extensionTestsPath` mode; the only
  valid control is an extensions dir that does not contain GitStudio.
- `workspace.saveAll()` saves *editors*, not the background models a bulk edit
  touched. The F2 path saves those via `files.refactoring.autoSave`, which an
  extension only gets with `applyEdit(edit, { isRefactoring: true })`.
- `gitstudio.openChanges` diffs the *active* editor's file; open the file first.
- Pylance needs a selected interpreter and `python.analysis.indexing` for
  workspace-wide rename (`mkproj.sh` writes both into `.vscode/settings.json`).
- `ELECTRON_RUN_AS_NODE` must be unset when launching `code` from a tool shell.

## Result (2026-09-20, GitStudio 1.12.1 = 1.12.0 + process audit)

Host: VS Code 1.138.0, Pylance 2026.3.1 (the reporter's version), Python
extension 2026.4.0, Python 3.14.3, macOS 27. Every cell: all six files renamed
on disk, no dirty documents left behind, no error diagnostics, no toasts.

| mode     | off/plain | on/plain | on/busy | on/open | on/diffeditor | on/autosave |
|----------|-----------|----------|---------|---------|---------------|-------------|
| provider | 6/6       | 6/6      | 6/6     | —       | 6/6           | —           |
| ui (F2)  | 6/6       | 6/6      | 6/6     | 6/6     | —             | 6/6         |

The `on/busy` screenshot shows GitStudio's blame gutter, inline blame, status
items and Changes badge all live while the rename widget is open — the
extension was doing real work around the rename, not sitting idle.

## What the source audit ruled out (apps/extension/src, packages/git-service)

- No rename / reference / document-highlight / code-action / formatting
  provider is registered; the only language feature is a hover provider on
  `{ scheme: "file" }`, which cannot affect a rename.
- No `onWillSaveTextDocument`. The `onDidChangeTextDocument` /
  `onDidSaveTextDocument` listeners (blameController, stagedGutter,
  commitView) only READ: `git blame --contents -`, `git show HEAD:<rel>`,
  `git show :<rel>`, `git status --porcelain=v2 -- <rel>`, vscode.git's
  `repo.status()`. None writes a document, saves, reverts, or touches the
  working tree, so none can bump a model version or a file's mtime.
- The only two file watchers are on `.git/{HEAD,MERGE_HEAD,…}` and
  `.git/refs/**`; their callbacks schedule a debounced refresh (reads).
- Every `workspace.applyEdit` / `document.save` is scoped to a document the
  user opened in GitStudio's own custom editors or panels (rebase todo, merge
  editor, diff panel) and guarded against its own echo. Every git write
  (`checkout`, `stash`, `reset`, `update-index`, `clean`, `add`) sits behind a
  user command; there is no timer, auto-fetch, auto-pull or auto-stash.
- `git stash create` (undo snapshots, user-triggered) never touches the
  working tree; every spawn carries `GIT_OPTIONAL_LOCKS=0`.
- Nothing mutates `process.env`, `process.chdir`, prototypes or globals in
  the shared extension host; the crash reporter adds `process.on(...)`
  listeners for `unhandledRejection`/`uncaughtException` that only observe.
  The bundle has no third-party runtime dependency besides `vscode-diff`.
- No `configurationDefaults`; the only settings writes are `gitstudio.*` and
  a one-time `git.blame.*` opt-out — nothing under `files.*`, `search.*` or
  `python.*`. No `updateWorkspaceFolders`, no `setTextDocumentLanguage` on a
  file document, no background `openTextDocument` of workspace files.
- The custom editor with `filenamePattern: "*"` is `priority: "option"`
  (never auto-opens); `AutoOpenConflicts` opens only paths that
  `git status --porcelain=v2` lists as unmerged.
- GitStudio's virtual documents (`gitstudio-rev:`, the stash diff, the PR
  blobs) carry `language: python` when they show a `.py` file, but Pylance's
  document selector is scheme-restricted (`file`, `untitled`, the notebook,
  chat and terminal schemes — read off the 2026.3.1 bundle), so the language
  client never sends them to the server: an open old revision cannot become a
  second declaration site.
- The silent-cancel path in VS Code's rename (cursor or model-value change
  while the widget is open) is not reachable from GitStudio: decorations do
  not change model content, and the only automatic cursor move
  (`revealAfterOpen`, after clicking a Changes row) needs a user click.

What would produce the reported symptom without any extension involvement:
Pylance not *finding* the usages — an unresolved import (no interpreter /
non-`src` layout without `python.analysis.extraPaths`), a project over
`python.analysis.userFileIndexingLimit` (2000 files), files under
`python.analysis.exclude`, or usages resolving to an installed copy of the
package rather than the workspace one. In all of those, "Find All References"
on the symbol is missing the same usages the rename misses — which is the
question to ask the reporter.

## Keeping the audit true

Everything the audit above rules out is one line away from being reintroduced
— a rename provider "for tracked files", an `onWillSaveTextDocument` that
stages on save, a background `applyEdit`. `test/renameBystander.test.ts` is a
source census that fails the suite the moment any of them lands: no
rename/reference/highlight/code-action/formatting provider, no will-participant,
`applyEdit` / `document.save` only inside the three surfaces that own their
document, nothing process-wide, no `configurationDefaults`, no F2 binding, and
the `*` custom editor never at `default` priority. Each rule was negative-tested
by injecting its violation and watching the test fail.
