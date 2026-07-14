# GitStudio Desktop 1.0.0

**The JetBrains-grade Git suite as a standalone app — no editor required.**

GitStudio Desktop is the first public release of the native cross-platform app, built on the same open-source engine as the extension. It puts the whole workflow in one window: repo management and clone, the commit graph with author avatars, hunk-level staging, native diffs and conflict resolution, branches / remotes / tags / stashes, reflog-powered undo, and an integrated terminal. Sign in to GitHub and it becomes your local GitHub client too: pull requests with diffs and inline review, Actions runs with logs, issues, gists, notifications, releases, orgs, and projects. An optional AI assistant (connect any model) with MCP support is built in — off until you enable it.

License: Apache-2.0 · Source: https://github.com/GitStudioHQ/gitstudio · Website: https://gitstudio.dev

## Downloads

| Platform | File |
|---|---|
| macOS — Apple Silicon | `GitStudio-1.0.0-arm64.dmg` |
| macOS — Intel | `GitStudio-1.0.0-x64.dmg` |
| Windows 10/11 (x64) | `GitStudio Setup 1.0.0.exe` |
| Linux — universal | `GitStudio-1.0.0.AppImage` |
| Linux — Debian / Ubuntu | `gitstudio_1.0.0_amd64.deb` |

The macOS `.zip` assets exist for the auto-update feed — download the `.dmg`.

## Unsigned builds (for now)

These builds are not yet code-signed, so the OS will warn on first launch:

- **macOS:** right-click **GitStudio.app → Open** (confirm the dialog), or clear the quarantine flag:
  ```bash
  xattr -dr com.apple.quarantine /Applications/GitStudio.app
  ```
- **Windows:** on the SmartScreen prompt, click **More info → Run anyway**.

Signed and notarized builds are planned; nothing else about the app changes.

## Auto-update

- **Windows and Linux (AppImage):** the app checks GitHub Releases and updates in-app.
- **macOS:** manual for now — auto-update requires a signed build, so download the new `.dmg` when a release ships. (`.deb` installs also update by installing the new package.)
