# GitStudio 2.0.1 — every way to install now works, including the one that did not

A fix release for how the app reaches your machine. 2.0 shipped with a Home,
full-page issues and pull requests, and a repository browser for GitHub; 2.0.1
makes sure you can actually get it installed on any platform, any way you like.

## Installing

Five ways in, all fed by the same release assets:

```bash
# macOS and Linux — verifies the checksum, and on macOS clears the Gatekeeper flag
curl -fsSL https://gitstudio.dev/install.sh | bash

# Homebrew (macOS) — one line; taps GitStudioHQ/homebrew-gitstudio by itself
brew install --cask gitstudiohq/gitstudio/gitstudio
```

```powershell
# Windows
irm https://gitstudio.dev/install.ps1 | iex

# winget, once microsoft/winget-pkgs#437547 lands
winget install GitStudioHQ.GitStudio
```

Or take the `.dmg`, `.exe`, `.AppImage`, `.deb`, `.rpm` or `.tar.gz` from the
assets below; `SHA256SUMS.txt` covers every one of them.

## What is fixed

- **A downloaded `.dmg` opened to "GitStudio is damaged"** on macOS 15 and
  later, with no way through. The bundle had no signature at all. It is ad-hoc
  signed now, so a quarantined copy gets the ordinary "Apple could not verify…"
  prompt and an **Open Anyway** in System Settings ▸ Privacy & Security. (The
  builds are still not notarized — that needs an Apple Developer ID, and it is
  on the list.)
- **Homebrew** is one command with no `brew tap` and no `brew trust`, through
  the new tap, and the cask clears the quarantine flag for you.
- **The Windows one-liner never ran the installer** on Windows PowerShell 5.1
  — it downloaded, verified, then tripped over an empty argument list. Fixed.
- **`install.sh` on Linux** warns when `libfuse2` is missing (the AppImage
  needs it; Ubuntu 22.04+ and Debian 12 do not ship it) and installs the
  launcher icon.
- **Numbered lists with blank lines between items** rendered as "1. 1. 1." in
  the Assistant, issue and PR threads and READMEs.

## Updating

If you are on 2.0.0, the app will offer this release on its own: on macOS it
downloads the right installer to your Downloads folder and opens it; on Windows
and the Linux AppImage it downloads in place and restarts into 2.0.1 when you
say so.

Full changelog: [apps/desktop/CHANGELOG.md](https://github.com/GitStudioHQ/gitstudio/blob/main/apps/desktop/CHANGELOG.md).
