# GitStudio 1.8.0 — worktrees from any ref, and a rebase list that reads the right way up

## Worktrees from remote branches and tags

**New Worktree** used to offer local branches only. It now lists remote branches
and tags too, and asks what you want: check the ref out directly, or start a new
named branch from it.

There is a new setting, `gitstudio.worktrees.prefixWithProjectName`, that names
the folder `<project>-<branch>` instead of `<branch>` — worth turning on if you
keep worktrees from several repositories side by side.

Both from [#14](https://github.com/GitStudioHQ/gitstudio/pull/14) by
[@wanzirong](https://github.com/wanzirong). Thank you.

One thing that came out of reviewing it, worth stating plainly because it could
have cost someone real work: git's default is to give a new branch the upstream of
whatever it started from, *even when the names differ*. GitStudio pushes to a
differently-named upstream explicitly — so a worktree branch called
`my-experiment` started from `origin/feature` would have pushed your commits onto
`origin/feature`. A new branch now only tracks when the names match.

## The rebase list reads newest-first

The Commits list is newest-first; the rebase list was oldest-first. Moving between
them meant flipping your mental model each time, which is exactly the sort of
thing that makes you mis-click on the one screen where a mis-click rewrites
history.

They match now. Git still replays the plan bottom-to-top, and the view says so.

The consequence worth knowing: **squash** and **fixup** fold into the commit
*below* them — the older one. So a squash on the very top row is now allowed,
where before the top row was the one thing that could not fold into anything.

The `git-rebase-todo` editor — the one that opens when you run `git rebase -i`
yourself — deliberately keeps git's own oldest-first order, because its rows *are*
that file's lines. Its hint says which order you are looking at.

*Reported in [#18](https://github.com/GitStudioHQ/gitstudio/issues/18).*

## Fixed

- **The branch menu no longer shows the previous repository's branches** for a
  moment after switching repositories.
- **A branch you just created or deleted no longer keeps showing its old state.**
  A ref listing already in flight when the change landed could write its
  pre-change answer back over the refresh, and hold it for over a second.

---

**Install:** GitStudio updates itself from the VS Code Marketplace and Open VSX.
The `.vsix` is attached below for manual installs:

```bash
code   --install-extension gitstudio.vsix --force   # or:
cursor --install-extension gitstudio.vsix --force
```
