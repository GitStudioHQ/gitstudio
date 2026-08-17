# GitStudio Desktop 1.1.2 — fewer things called crashes

The extension's 1.6.0 graph work, plus a policy decision about what a crash
report is actually for.

## Being offline is not a crash

1.1.1 stopped filing "Not connected to GitHub." as a failure report. It turned out
to have siblings: losing your connection, a token that expired or was revoked, a
permission you never granted, GitHub's rate limiter, GitHub itself having a bad
day. Every one of those was arriving as a report — and anyone on flaky wifi
produced a stream of them.

There is now a single policy for the whole GitHub layer, written down in one
place: our bugs get reported, the network and your sign-in state do not. Along the
way this fixed a subtler leak — the handlers that catch an error and turn it into
a message were dropping the "this is expected" mark, so every mutation in the app
(closing an issue, re-running a workflow, publishing a release) filed a report for
conditions that had already been classified as normal.

Nothing you see changes. The same message reaches the same place; only the
reporter behaves differently.

## Committing with nothing staged showed an empty notification

`git commit` reports that particular refusal on stdout rather than stderr, so
passing stderr straight through produced a toast with no text in it.

It now tells you which situation you are in — changes waiting to be staged, only
new untracked files, or a clean tree — worked out by asking git directly, so it
reads correctly on a translated git too.

## Branch/tag chips

The Branch/Tag column reveals more branches as you widen it, instead of stopping
at four however far you drag: the old limit was a count applied before any width
was measured. And the "+N" badge now opens its own hover card immediately, naming
each hidden ref's kind, rather than waiting out the browser's tooltip delay.

---

**Install:** the app updates itself. Installers are attached below —
`.dmg` for macOS (Apple silicon and Intel), `.exe` for Windows, `.AppImage` and
`.deb` for Linux.
