# GitStudio Desktop 1.1.0 — no password prompts, push from the branch list

The first update since 1.0.0, and it fixes the two things most likely to have
made the app feel unfinished: an OS password prompt you never asked for, and a
branch list you couldn't push from.

## GitStudio no longer touches your OS keychain

If the app ever made macOS ask for your password on launch, that stops now.

Electron's `safeStorage` keeps its master key in the login keychain, and that
entry's ACL is bound to the app's code signature — so every rebuild or update
invalidated it, and the next read raised *"GitStudio wants to make changes.
Enter your password to allow this."*

Your GitHub token and AI keys now live in GitStudio's own AES-256-GCM store
under `userData/secrets`, owner-only on disk. Every "is this connected?" check
is answered from the filesystem without decrypting anything, so no status probe,
badge refresh or launch can reach a keyring.

Already signed in? Your token is migrated the first time you actually use GitHub
or an AI feature — one prompt at most, ever, and never at startup.

## Push and Publish from the Branches view

Only the top-bar sync widget could push, and only the branch you had checked
out — so an unpublished or ahead branch could not be pushed from the very list
that was displaying it. The branch menu now publishes (creating the remote
branch and setting its upstream) or pushes to the tracked remote, for any
branch.

## The app tells you when there's an update

macOS can't apply an in-app update to an unsigned build, so previously mac users
simply sat on an old version with no hint a newer one existed. GitStudio now
checks GitHub for the latest desktop release and posts a single notification
pointing at the download. Windows and Linux say when an update has been staged,
instead of replacing the app on quit unannounced.

## Fixed

- **Agent Access could erase your MCP configuration.** Installing GitStudio's
  MCP server into a client whose config wasn't strict JSON — Cursor and VS Code
  accept JSONC, which `JSON.parse` rejects — treated "couldn't parse" as "no
  file" and wrote over it, deleting every other MCP server you had configured.
- **Git could hang forever on a credential prompt.** The app has no terminal, so
  git's password question had nowhere to go and the operation blocked
  indefinitely. It now fails fast with a real message; credential helpers
  (macOS Keychain, Git Credential Manager, GUI askpass) are unaffected.
- **A deleted branch could reappear for a minute**, when a request already in
  flight wrote its pre-deletion answer back over the invalidated cache.
- **The bottom dock could open far too tall**, replaying a height dragged out
  for the terminal onto a smaller window.
- **Multi-line git errors were unreadable as toasts** — they now show the one
  actionable line.
- **Crash reports could include repo-relative paths and branch names**; git
  stderr is now scrubbed with the git-aware scrubber.

## Downloads

| Platform | Installer |
|---|---|
| **macOS — Apple Silicon** | `GitStudio-1.1.0-arm64.dmg` |
| **macOS — Intel** | `GitStudio-1.1.0-x64.dmg` |
| **Windows** | `GitStudio-Setup-1.1.0.exe` |
| **Linux** | `GitStudio-1.1.0-x86_64.AppImage` · `GitStudio-1.1.0-amd64.deb` |

Unsigned builds still trigger the OS "unidentified developer" prompt on macOS
and Windows.

Full detail in the [changelog](https://github.com/GitStudioHQ/gitstudio/blob/main/apps/desktop/CHANGELOG.md).
