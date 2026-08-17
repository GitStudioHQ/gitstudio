# GitStudio 1.6.0 — the Changes list keeps up, and nothing fails silently

Three of these came from @wkornewald and @wanzirong opening issues in the first
week. Thank you — every one of them was a real thing.

## The Changes list refreshes itself

Edit a file, switch back to GitStudio, and the list showed you the past. The only
reliable fix was to leave the view and come back.

That workaround was a clue: switching away and back was the *one* thing that
re-read the repository. Nothing in GitStudio watched the working tree at all — its
two file watchers only ever looked at git's own metadata, so saving a file
produced no signal, and the list's underlying data was a cache we read but never
asked to refresh.

It now updates after you save, and again whenever the window regains focus — so
changes made by something else entirely, a CLI or a formatter or another editor,
show up too. Rapid bursts collapse into one refresh, so *Save All* across fifty
files costs the same as saving one.

If you work in a very large repository and would rather refresh on demand, set
`gitstudio.changes.autoRefresh` to `false`.

*Reported in [#17](https://github.com/GitStudioHQ/gitstudio/issues/17).*

## Committing with nothing staged told you nothing

An empty error dialog. No text, no reason.

`git commit` turns out to be the one git command that reports this particular
refusal on **stdout** instead of stderr — so reading stderr, which is the right
thing to do everywhere else, produced a failure with nothing in it.

GitStudio now tells you which situation you are actually in: changes waiting to
be staged, only new files git has not been told about yet, or a genuinely clean
tree. It works that out by asking git three yes/no questions rather than reading
its wording, so it is still correct on a translated git. And it arrives as
information rather than as an error, because not having staged anything yet is
not a mistake.

*Reported in [#16](https://github.com/GitStudioHQ/gitstudio/issues/16), which
also asks for JetBrains-style checkboxes instead of staging. That one is a change
to how the Changes view works and is being designed properly — it will be an
option, not a replacement.*

## Widening the Branch/Tag column finally reveals more

The column stopped at four chips no matter how far you dragged it. The limit was
a **count**, applied before any width was measured — so the obvious thing to try
silently did nothing, on the one row where you needed it.

Width is the only limit now. Drag it wider and the column shows as many branches
and tags as genuinely fit.

The "+N" badge that holds the rest got the bigger fix. Hovering it used to mean
holding the pointer still for several seconds and hoping, because it leaned on
the browser's own tooltip — whose delay restarts every time the pointer moves a
pixel. In the Commits sidebar it never appeared at all: the row's tooltip won over
it. It is GitStudio's own hover card now, appears straight away on both surfaces,
and names each hidden ref's kind, so `1.1.0` no longer leaves you guessing whether
it is a tag or a branch.

*[#11](https://github.com/GitStudioHQ/gitstudio/issues/11), closing out the last
of [#5](https://github.com/GitStudioHQ/gitstudio/issues/5).*

## Checking out a remote branch just checks it out

It used to ask you to name the local branch first, in a dialog pre-filled with the
name it had already worked out — so the answer was almost always "yes, that one".

Picking `origin/fix/login` now puts you on `fix/login`, tracking it, in one step.
If you already have a local branch by that name, you switch to it. To land on a
*different* name, use **New Branch From Here…**, or rename once you are on it.

## A paused merge or rebase is not a failed one

The defect 1.5.2 fixed for cherry-pick, in the last place it was still hiding.
Merge and rebase told a conflict apart from a failure by matching git's English
output, so on a translated git a merge that had merely stopped for conflicts was
presented as an outright failure with raw stderr — instead of "resolve, then
continue or abort".

This case needed more care than cherry-pick did. For merge and rebase a real
failure and a pause can exit with the *same code*: an unknown branch name and a
rebase over unstaged changes both exit the way a conflict does. So GitStudio asks
two questions, not one — and the tests pin all of it against real git.

*[#9](https://github.com/GitStudioHQ/gitstudio/issues/9).*

---

**Install:** GitStudio updates itself from the VS Code Marketplace and Open VSX.
The `.vsix` is attached below for manual installs:

```bash
code   --install-extension gitstudio.vsix --force   # or:
cursor --install-extension gitstudio.vsix --force
```
