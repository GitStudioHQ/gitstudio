# GitStudio 1.5.1 — a fix to the crash reporter itself

Three fixes, one of which is about GitStudio's own error reporting rather than
GitStudio's features. That one is the reason this release exists.

## GitStudio was filing other extensions' crashes as its own

If you have crash reporting enabled, this is worth reading.

GitStudio's reporter listens for unhandled promise rejections so that failures
which never reach a dialog still get noticed. The problem is that this listener
is **process-wide**, and the extension host is shared by every extension you have
installed — so it sees their failures too, not just ours.

There was a check for exactly this: only report an error whose stack points into
GitStudio's own code. But it ran *after* wrapping non-`Error` values in a new
`Error`, and constructing an error inside the reporter gives it the reporter's
own stack. The check then recognised that as GitStudio's code and accepted
everything.

Three reports had been filed from other tools this way. One of them was a PHP
parse error whose text contained a slice of an unrelated project's source code
and file paths — captured and transmitted because it happened to surface as a
rejection while GitStudio was running.

A failure is now attributed to GitStudio only when it arrives as a real `Error`
whose own **call frames** point into GitStudio's code. Anything without that
provenance is discarded rather than sent — including some of our own failures,
which is the right side of that trade.

Reviewing that fix turned up the same leak through a second door: the check read
the error's *message* as well as its frames, so another extension failing with
something like `ENOENT: ... '/Users/me/code/gitstudio/src/a.ts'` counted as ours
purely because the user keeps a directory by that name. Provenance now comes from
the frames only.

The report containing third-party source has been purged.

Nothing about what GitStudio *deliberately* collects has changed: reports remain
anonymous and scrubbed, and never include repository contents, file names, commit
messages or branch names. Reporting still follows your editor's telemetry setting
and `gitstudio.errorReporting.enabled`.

## Reverting a merge asks which side to keep

Reverting a merge commit used to fail with git's own sentence — *"commit <sha> is
a merge but no -m option was given"* — and stop there.

Git is right to refuse: a merge has two parents, so "undo this commit" genuinely
is ambiguous. The bug was that GitStudio handed you the refusal instead of the
question.

It now asks, showing each parent with its commit subject:

- **Keep the branch this was merged into** — the usual intent, undoing the
  merged-in work
- **Keep the branch that was merged in** — the other direction

Octopus merges with three or more parents list every parent. Ordinary commits are
unaffected.

Reverting something that has already been reverted used to fail with a modal
saying just "Revert failed" and no reason — git reports that case on stdout with
an empty stderr, so there was nothing to show. It now tells you the change is
already undone.

## Closing a panel while it is working no longer errors

Closing the AI result panel while GitBrain was still streaming — because you had
read enough — made every remaining chunk fail against a webview that no longer
existed.

The same applied to closing the AI settings panel while it was detecting models,
and to closing the rebase workspace during a git operation. All three now stop
writing once the panel is gone.

---

**Install:** GitStudio updates itself from the VS Code Marketplace and Open VSX.
The `.vsix` is attached below for manual installs:

```bash
code   --install-extension gitstudio.vsix --force   # or:
cursor --install-extension gitstudio.vsix --force
```
