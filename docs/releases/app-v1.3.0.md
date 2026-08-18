# GitStudio Desktop 1.3.0 — the rebase list reads the right way up, and the wrong repo stops leaking in

## The rebase list matches the Commits list

Both are newest-first now. Git still replays the plan bottom-to-top, and the view
says so.

The consequence worth knowing: **squash** and **fixup** fold into the commit
*below* them — the older one. A squash on the top row is therefore allowed now,
where before the top row was the one thing that could not fold into anything.

*Reported in [#18](https://github.com/GitStudioHQ/gitstudio/issues/18).*

## Three ways the app could show you the wrong thing

All three were the same shape underneath: work that finished after you had already
moved on, writing its answer over the current one.

- **The branch list and the top-bar branch name could describe the repository you
  had just switched away from** — whenever the old repository's lookup happened to
  finish last, which is most likely when it is the larger of the two.
- **Returning to Branches after committing showed the list as it was before the
  commit**, with no refresh. Worse, a fetch or pull afterwards silently refreshed
  nothing at all.
- **Scrolling the graph while it reloaded could produce a jumbled history** —
  duplicated rows, mis-drawn lanes — because a page still being read was appended
  to a history that had already been replaced underneath it.

---

**Install:** the app updates itself. Installers are attached below —
`.dmg` for macOS (Apple silicon and Intel), `.exe` for Windows, `.AppImage` and
`.deb` for Linux.
