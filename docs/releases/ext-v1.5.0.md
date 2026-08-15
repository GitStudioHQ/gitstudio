# GitStudio 1.5.0 — your first community release

Every fix in this release came from someone opening an issue. Thank you.

## You can name a branch "styles" again

This is the one to upgrade for. If you ever tried to create or rename a branch
and GitStudio told you it *"cannot contain spaces"* when there was obviously no
space in it, you were not imagining it.

The Changes view is built as one large template literal, and a template literal
eats backslashes before the browser ever sees them. `/\s/` — match whitespace —
arrived in the webview as `/s/`, which matches the letter **s**. Every dialog
that validates a ref name shares those validators, so the blast radius was wide:

- no branch named `styles`, `master`, or `feature/save-user`
- no remote named `upstream`
- **no `https://` URL** — the "s" in "https" was reported as a space

Meanwhile a name with a real space in it sailed through.

The same corruption quietly wrecked the check next to it. The list of characters
git forbids in a ref — `~ ^ : ? * [ \` — collapsed into a pattern that only
matched at the very end of a name, and stopped rejecting backslashes entirely.
So the validator was simultaneously too strict about the letter "s" and too
lenient about characters git will actually refuse.

Both are fixed at the source: the literal is now `String.raw`, so the regexes
mean what they say. Two tests guard it, because neither failure mode is visible
to the compiler, the bundler, or a grep — the literal was always *valid* code,
it just meant something else.

Found and diagnosed by [@wanzirong](https://github.com/wanzirong) in #8, which
is the hard part — it was buried in a 3,500-line string.

## Check out a branch from the commit graph

Right-clicking a commit whose tip is `main` used to offer exactly one checkout:
*Checkout Commit*, which detaches HEAD. Landing on a detached HEAD when you
meant "switch to main" is the wrong outcome, and the branch name was sitting
right there on the row.

The refs on the commit now head the menu:

- **Checkout main** — switches, straightforwardly
- **Checkout origin/main…** — offers a local name to track it with
- **Checkout v1.4.0…** — confirms the detached HEAD first, since a tag is a fixed point

The branch you are already on is left out. Each one asks exactly what the
Branches view asks, so the same operation behaves the same wherever you start
it — including for refs that have no chip of their own, like a remote twin
folded into its local branch, or anything hidden behind a "+N".

Reported by [@gaganyadav80](https://github.com/gaganyadav80) in #6.

## The commit details dock comes back when you click a commit

Close the details dock, then click the commit you want to inspect: nothing
happened. Clicking the row that was *already selected* emitted no intent at all,
so the dock stayed shut and there was no way back short of reloading the window.

Clicking a commit is a request to see it, so it now reopens the dock — without
re-fetching the commit or disturbing a diff you have open.

Reported by [@gaganyadav80](https://github.com/gaganyadav80) in #4.

## Branch/tag chips reflow while you drag the column

Two things were wrong with the "+N" pill that collapses refs a row cannot fit.

Dragging the Branch/Tag column did not reflow anything until you let go. Chips
that do not fit are *removed from the row*, not clipped, so the column would
visibly widen while the chips stayed folded behind a "+1" — and everything
snapped into place only on release. Resizing with the keyboard had always
re-rendered on every nudge; the mouse now agrees.

The pill itself read as decoration. Clicking it already opened the commit
details, which lists every ref in full — so the way to see a hidden branch
*without* resizing was there all along, just unadvertised under a default
cursor. It now shows a pointer and a hover state, and its tooltip names each
hidden ref **and its kind**, so `1.1.0` no longer leaves you guessing whether it
is a tag or a branch.

Reported by [@gaganyadav80](https://github.com/gaganyadav80) in #5.

## The activity-bar badge clears after you commit

Commit and push everything, and the GitStudio icon still showed a blue **1**
next to a panel that said *"Working tree clean"*.

Both numbers come from the same update, so the extension was never confused —
the badge just never cleared. Clearing a *webview* view's badge does not work in
VS Code: the pane applies a badge only when there is one, and has no path to
remove the old one. The count is now published as zero, which the activity bar
renders as nothing at all.

Turning the badge off in settings also takes effect immediately now, instead of
waiting for the next window reload.

Reported by [@darkdkl](https://github.com/darkdkl) in #7.

## Also

- **"Cherry-Pick Commit" has an icon again** in the commit-graph context menu,
  where every other item had one. Its glyph was missing from the icon subset the
  graph's shadow DOM carries.

---

**Install:** GitStudio updates itself from the VS Code Marketplace and Open VSX.
The `.vsix` is attached below for manual installs:

```bash
code   --install-extension gitstudio.vsix --force   # or:
cursor --install-extension gitstudio.vsix --force
```
