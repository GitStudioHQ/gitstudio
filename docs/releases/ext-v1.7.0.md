# GitStudio 1.7.0 — commit without staging first

## You no longer have to stage before committing

Hitting Commit with nothing staged used to be refused. It now asks — *"Commit all
7 changed files?"* — and stages everything on yes.

The confirmation is the whole design: you see what is about to be included before
it happens, so nothing lands that you did not look at. VS Code and JetBrains both
work this way, and requiring a separate step for "commit what I just did" was
friction with nothing to show for it.

*Requested in [#16](https://github.com/GitStudioHQ/gitstudio/issues/16).*

## …and staging can disappear entirely, if you prefer

Set `gitstudio.changes.stagingModel` to `checkboxes` and the Changes view becomes
one list with a tick per file, the way IntelliJ works — no Staged/Unstaged split
to think about.

The tick *is* the index. Ticking a file stages it, unticking unstages it, and the
checked state is read straight back from Git. So the two models are the same
repository seen two ways: nothing can drift out of sync, and a `git add` you run
in a terminal shows up as a tick immediately.

The split stays the default, because the separation is genuinely easier to read
when you are assembling a commit deliberately. Pick whichever suits the moment.

## Fixed

- **Being mid-conflict is no longer reported as a crash.** Git refusing to switch
  branches while you have unresolved conflicts is correct behaviour, not a bug in
  GitStudio. It now reads as a warning naming how many files are still conflicted
  and what to do about them.
- **Stashing with nothing to stash no longer claims success.** `git stash` exits
  cleanly having saved nothing, so GitStudio said "Stashed changes" over an
  untouched working tree — including the case where the only changes are new
  files, which need *Include untracked files* to be stashed at all.
- **"Checkout origin/…" dropped its ellipsis**, which had been promising a dialog
  that 1.6.0 removed.

---

**Install:** GitStudio updates itself from the VS Code Marketplace and Open VSX.
The `.vsix` is attached below for manual installs:

```bash
code   --install-extension gitstudio.vsix --force   # or:
cursor --install-extension gitstudio.vsix --force
```
