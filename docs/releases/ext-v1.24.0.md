# GitStudio 1.24.0 — open the file, and no more freezes on big rewrites

## Open a changed file from the commit details

Each changed file's row in the Commit Graph's details pane has an **Open
working tree file** button beside the diff its click opens: the file as it is
on disk now, in the editor VS Code gives it. It shows on the row's hover.
Thanks to @Albelt (#146).

## Where GitStudio's comparison starts

`gitstudio.diff.whitespace` and `gitstudio.diff.highlight` preset the
comparison's whitespace and highlight choices for every diff it opens; its
toolbar still changes them for one diff (#146).

## Fixed

- **No more freezes on heavily changed files.** With every line of a large
  file changed, each pause in typing and each stage froze VS Code for up to
  five seconds. That work now runs on a background thread (#145).
- A long commit message no longer runs under the Review changes with AI
  button (#147).
- Cherry-picking a merge commit asks which side to keep, as Revert does.
- Continue in the Interactive Rebase panel after the rebase ended elsewhere
  closes the panel instead of failing.
- Creating a tag or branch on a commit that isn't in the repository says so.
- AI: the Test button no longer fails reasoning models, and the OpenRouter and
  Groq defaults moved off retired models.
- Crash reports no longer file the user's own situation (a refused push,
  credentials, the network, a conflict).
