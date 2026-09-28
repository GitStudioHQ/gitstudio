# GitStudio 1.16.0: one merge editor, and harder to fool

## Conflicts and diffs stay in GitStudio

Handing merges and diffs to a JetBrains IDE is gone. The **Merge with
JetBrains IDE** and **Diff with JetBrains IDE** commands are removed, along
with the settings that chose an IDE. Conflicts always open in GitStudio's own
three-pane merge editor, and diffs in its own diff. If you had set GitStudio to
use a JetBrains IDE, that setting is simply ignored.

## Security

GitStudio now handles hostile data from GitHub and from files more safely:
- A pull request's avatar image is rebuilt from GitHub's own avatar address
  instead of being used as given.
- Commit-graph rows never treat text or counts as HTML.
- Markdown comments are stripped by a scanner that can't be tricked into
  leaving one behind.
- A few path and label parsers that a crafted string could stall for seconds
  now finish at once.

The full list is in the changelog.
