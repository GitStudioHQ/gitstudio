# GitStudio Desktop 1.2.0 — it notices your work now

Three reports from @wkornewald, all of them right.

## The Changes list keeps up with you

Edit a file in your editor, switch to GitStudio, and the list showed you the
past — you had to press Refresh, or leave the view and come back.

The app watches the repository now. Changes appear on their own, whether they came
from your editor, a script, or a `git` command in another terminal, and the list
refreshes again whenever the window comes back to the front. Bursts collapse into
a single update, so a build or a *Save All* across fifty files costs one refresh
rather than fifty.

*Reported in [#17](https://github.com/GitStudioHQ/gitstudio/issues/17).*

## Check out a branch straight from the graph

Right-clicking a commit offered one "Checkout", and it detached HEAD — even when
the row you clicked was the tip of a branch, with the branch sitting right there
on it.

The refs on a row now head the menu: *Checkout main*, *Checkout origin/main*,
*Checkout v1.2.0…*. Picking a remote branch puts you on a local branch tracking
it, never a detached HEAD. Tags still detach, because there is nothing else they
could do, and they say so before they act.

*Reported in [#19](https://github.com/GitStudioHQ/gitstudio/issues/19).*

## Commit without staging first

Committing with nothing staged now offers to commit everything after asking,
rather than refusing. And the Changes view can drop the Staged/Unstaged split
entirely for one list with a tick per file — toggled from its toolbar, remembered
between launches.

*From [#16](https://github.com/GitStudioHQ/gitstudio/issues/16).*

## Fixed

- **Stashing with nothing to stash no longer reports success.**
- **Operations git declines now explain themselves** instead of showing an empty
  notification — reverting something already reverted, or continuing a rebase
  with conflicts still unresolved.
- **Being mid-conflict is no longer filed as a crash report.**

---

**Install:** the app updates itself. Installers are attached below —
`.dmg` for macOS (Apple silicon and Intel), `.exe` for Windows, `.AppImage` and
`.deb` for Linux.
