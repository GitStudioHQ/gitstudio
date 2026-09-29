# GitStudio 1.17.0 — say what it sends, turn off what you don't want, and support it if you like it

## Everything GitStudio sends, in one place

A new [PRIVACY.md](https://github.com/GitStudioHQ/gitstudio/blob/main/apps/extension/PRIVACY.md)
lists every connection the extension makes: crash reports, commit authors'
pictures, GitHub and AI. It says when each one happens, what it carries, and
the setting that turns it off.

## A switch for commit authors' pictures

To show an author's picture, GitStudio asks Gravatar with a hash of the
author's email address, or GitHub for a GitHub noreply address. The new
`gitstudio.avatars.gravatar` setting turns that off: every author is drawn as
coloured initials, and neither request is sent. It's on by default, as before.

## Support GitStudio

GitStudio is free and open source. If it saves you time, **GitStudio: Support
GitStudio…** offers GitHub Sponsors (recurring support) or a one-off tip. It
sits in the command palette, at the bottom of the Changes view's **…** menu,
and on the last step of Get Started. It never opens by itself.

## Fixed

- Push no longer re-creates a branch someone deleted on the remote.
- On Windows, File History, Line History, Open Changes and the Timeline find
  the file's repository again.
- A reword keeps its `#` lines after the rebase pauses.
- The merge editor writes a conflict where it happened, and an add/add
  conflict without stray blank lines.

## Security

- Crash reports no longer carry a commit's subject, or a branch name git
  prints without quotes: the scrubber now takes both out.
- An image in a pull request written as `//host/a.png` means https, as it does
  on GitHub. It used to resolve against the page and show as a broken image.

The full list is in the changelog.
