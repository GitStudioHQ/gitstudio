# GitStudio 2.4.0 — a launch screen, your tabs after a quit, and Git or not

## A launch screen

The window now opens straight onto the whole GitStudio mark, in your chosen
theme from the very first frame, and fades into the app the moment it's ready.
The window also appears sooner than before. With **Reduce motion** on, nothing
on it moves.

## Your tabs come back after you quit

Quitting saved an empty list of open tabs, so the next launch opened on Home.
The tabs are now saved before anything shuts down.

## No Git? The app says so, and how to get it

GitStudio uses the Git on your computer. Without one, every view used to fail
with "spawn git ENOENT". Now one screen says what's missing, shows the command
that installs Git on your system, and carries on, tabs and all, when you click
**Check again**. Git installed by Homebrew or the Windows installer is found
even when the app didn't start with it on its PATH.

## Say what it sends, turn off what you don't want

[PRIVACY.md](https://github.com/GitStudioHQ/gitstudio/blob/main/apps/desktop/PRIVACY.md)
now lists every connection the app makes: crash reports, update checks,
authors' pictures, GitHub while you're signed in, images inside Markdown, and
AI once you connect a provider. **Settings ▸ Appearance ▸ Load author pictures
from Gravatar** turns the Gravatar lookups off.

## Support GitStudio

**Help ▸ Sponsor GitStudio on GitHub…** and **Help ▸ Buy Me a Coffee…**, two
buttons in **Settings ▸ About**, two entries in **⌘K**, and one quiet line at
the foot of Home. Nothing pops up.

## Fixed

- Push no longer re-creates a branch someone deleted on the remote.
- A repository with no commits yet shows "No commits yet" instead of an error.
- A failed clone says why, not a fragment of git's last line.
- On Windows, repositories are grouped inside the folders they sit in.
- Release tags show their date.
- The merge editor writes a conflict where it happened, and an add/add
  conflict without stray blank lines.
- Cancelling an Assistant chat just as it was sent could crash the app.

## Security

- Crash reports no longer carry a commit's subject, or a branch name git
  prints without quotes.
- The Assistant's replies no longer load images from the web: text hidden in
  something it read could have sent data out through an image address.
- An image written as `//server/share/a.png` in a pull request, issue or
  README could make Windows connect to that server and offer your sign-in
  credentials. Such an address now means https.

## Installing

GitStudio 2.3.0 and later need macOS 12 Monterey or later. The Homebrew cask
now says so, and the one-line installer stops on macOS 11 and points to
2.2.1. The Windows release no longer carries a stray `builder-debug.yml`.

The full list is in the changelog.
