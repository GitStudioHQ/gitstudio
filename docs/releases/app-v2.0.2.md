# GitStudio 2.0.2 — filter the graph by branch, and Compare keeps your place

## Filter the Commit Graph by branch

A **Branches** button in the Commits toolbar rebuilds the graph around only
the refs you tick — the history itself, not a highlight. Presets for
**Current branch**, **Current + upstream**, **Local only** and **All**; a
filter box for busy repositories; ref chips follow the selection; right-click
(or ⌥-click) a chip for **Show only this branch**, **Add to filter**,
**Remove from filter**, **Checkout**. Remembered per repository. Revealing a
commit the filter hides says so and offers **Show all branches**. (#30)

## Compare keeps the file you were reading

A change under `.git` (another tool's fetch, or git refreshing its index
under a plain `git status`), ⌘R, or coming back to the window after editing in
your editor rebuilt the Compare view and opened its *first* file. Compare now
re-reads the comparison in place: if nothing changed the page is untouched, if
it changed the file you had open is reopened, and only when that file has left
the comparison does the selection move.

## Also

- The Commits view's CHANGES column cost up to three git processes per row and
  stopped answering past sixty rows; it is one process per visible window now,
  and every row is answered. The Code view's commit count no longer walks the
  whole history on every visit.

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

If you are on 2.0.1, the app will offer this release on its own.

Full changelog: [apps/desktop/CHANGELOG.md](https://github.com/GitStudioHQ/gitstudio/blob/main/apps/desktop/CHANGELOG.md).
