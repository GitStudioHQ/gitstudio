# GitStudio Desktop 1.1.1 — commit graph fixes

The commit-graph fixes from the extension's 1.5.0, now in the desktop app, plus
one crash report that was not a crash.

## The details pane comes back when you click a commit

Close the details pane, then click the commit you want to inspect: nothing
happened. Clicking the row that was *already selected* emitted no intent at all,
so the pane stayed shut.

Clicking a commit is a request to see it, so it now reopens the pane — without
re-fetching the commit, and without disturbing a diff you have open.

## Branch/tag chips reflow while you drag the column

Dragging the Branch/Tag column did not reflow anything until you let go. Chips
that do not fit are *removed from the row*, not clipped, so the column would
visibly widen while the chips stayed folded behind a "+1" — and everything
snapped into place only on release.

The "+N" chip also read as decoration. Clicking it already opened the commit
details, which lists every ref in full — so the way to see a hidden branch
*without* resizing was there all along, just unadvertised under a default cursor.
It now shows a pointer and a hover state, and its tooltip names each hidden ref
**and its kind**, so `1.1.0` no longer leaves you guessing whether it is a tag or
a branch.

## Also

- **Not being signed in to GitHub is no longer treated as a crash.** Opening
  notifications without a connected account raised an error that GitStudio filed
  as a failure report — three times, for someone who had simply not signed in.
  It is a state you are allowed to be in, and is handled as one now.

---

**Install:** the app updates itself. Installers are attached below —
`.dmg` for macOS (Apple silicon and Intel), `.exe` for Windows, `.AppImage` and
`.deb` for Linux.
