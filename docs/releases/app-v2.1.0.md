# GitStudio 2.1.0 — the full merge editor, a conflicts dashboard, and pull that asks instead of failing

## Resolve conflicts from start to Continue

While a merge, rebase, cherry-pick, revert, `git am` or stash apply is
stopped, the Changes view shows every conflicted file with **Accept Yours**,
**Accept Theirs** and **Merge…**, hold-to-undo, and **Continue**, **Skip**
and **Abort** named for the operation and your branches ("Rebasing test onto
master · commit 2 of 3"), with the reason when git can't go on yet. A
stopped operation shows from every view, and the top bar says *Ready to
continue* once every file is resolved.

**Merge…** opens the full merge editor: undo and history, previous / next
change, **Apply non-conflicting changes: Yours · All · Theirs**, **Resolve
simple**, whitespace and word highlighting, and the branch names on every
pane. During a rebase, Yours is your own commit, on the left — git calls it
"theirs", and *Accept Yours* used to keep the wrong side.

## Colours that say whether your choice matters

Each change is coloured by the decision it needs, in JetBrains' merge
colours, and the legend says them in words with how many are left:
**Conflict — you choose** (orange), **Same on both sides — either arrow
takes it** (green), **One side only — safe to take** (blue) and **Removed
lines** (grey). Once you decide, a trace stays: the side you took keeps its
link to the result, a side you left out keeps only its outline.

**Settings ▸ Merge** chooses GitStudio or your JetBrains IDE for conflicts
and diffs, and whether merges open with the non-conflicting changes already
applied.

## Pull, push and stash stop handing you git's advice

- **Diverged branch:** Pull asks **Merge**, **Rebase** or cancel — for that
  pull only; your git config is never written. Also with `pull.ff only`.
- **A pull that stops on conflicts** takes you to the conflicts, not to an
  error.
- **Stash & Retry:** revert, cherry-pick, checkout, merge, rebase, stash
  apply and pull, when your uncommitted changes are in the way, name the
  files and offer to stash them, run, and put them back as they were.
- **"Commit & Push" could offer to force push over someone else's commits.**
  Every force push is now leased on the remote you last saw, and refused
  when the remote holds work you never had.
- **A branch called `-f`** could discard your uncommitted changes on
  checkout; **a branch and a tag with the same name** confused checkout,
  merge, rename and delete. Both are fixed everywhere.

## Also

- **Agent Access works in a downloaded build.** The MCP server was missing
  from the app, so *Add* in Settings ▸ Agent Access could not work; it ships
  with the app now and runs on GitStudio's own runtime — no Node install
  needed. The Assistant and Agent Access no longer end a stopped merge by
  checking out or creating a branch over it.
- The Commit Graph branch filter (#30), after its first release: many
  branches, *Show only*, *Current branch* after a checkout, detached HEAD.
- Crash reports no longer carry a repository's name, and no longer file
  "you're in a state" messages as crashes.

## Installing

```bash
curl -fsSL https://gitstudio.dev/install.sh | bash          # macOS, Linux
brew install --cask gitstudiohq/gitstudio/gitstudio          # Homebrew
```

```powershell
irm https://gitstudio.dev/install.ps1 | iex                  # Windows
```

Or take the `.dmg`, `.exe`, `.AppImage`, `.deb`, `.rpm` or `.tar.gz` from the
assets below; `SHA256SUMS.txt` covers every one of them. The builds are not
code-signed yet: Homebrew and `install.sh` clear macOS's quarantine flag for
you; a downloaded `.dmg` gets the "Apple could not verify…" prompt — click
*Done*, then **Open Anyway** in System Settings ▸ Privacy & Security.

## Updating

If you are on 2.0.x, the app will offer this release on its own.

Full changelog: [apps/desktop/CHANGELOG.md](https://github.com/GitStudioHQ/gitstudio/blob/main/apps/desktop/CHANGELOG.md).
