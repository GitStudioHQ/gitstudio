# GitStudio 1.5.2 — git speaks your language, so we stopped reading its prose

One fix, from a crash report that should never have been one.

## A paused cherry-pick is not a failed cherry-pick

Git stops and asks you something in two situations: a conflict, or a cherry-pick
that turns out to be **empty** because the change is already on your branch.
Both stop the operation, and both need a decision from you — continue, skip, or
abort.

GitStudio told those apart by reading git's wording. That works until git is
translated. A user running a Russian git hit the empty case, git explained the
situation perfectly clearly *in Russian*, our English pattern did not match, and
a routine "this change is already applied" was presented as **"Cherry-pick
failed"** — and quietly filed as a crash report.

GitStudio now asks git whether the operation is actually paused, rather than
reading what it said about it. That answer is the same in every language. A
genuine failure — a bad revision, say — still surfaces as an error, because git
leaves no paused state behind.

The same change applies to revert — both the commit-graph action and the Undo
flow that turns into a revert when history has already been pushed.

---

**Install:** GitStudio updates itself from the VS Code Marketplace and Open VSX.
The `.vsix` is attached below for manual installs:

```bash
code   --install-extension gitstudio.vsix --force   # or:
cursor --install-extension gitstudio.vsix --force
```
