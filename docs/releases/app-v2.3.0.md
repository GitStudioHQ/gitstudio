# GitStudio 2.3.0: Electron 41, one merge editor, and harder to fool

## Built on Electron 41

GitStudio moves from Electron 33 to 41 and picks up its security fixes.
**GitStudio now needs macOS 12 Monterey or later**, because Electron no longer
supports macOS 11.

## Conflicts and diffs stay in GitStudio

Handing merges and diffs to a JetBrains IDE is gone. Settings ▸ Merge no
longer offers an IDE, and conflicts always open in GitStudio's own merge
editor. **Open in** no longer lists JetBrains IDEs. VS Code, Cursor and the
other editors are still there, and you can add any editor in
Settings ▸ Editors.

## Security

GitStudio now handles hostile data from GitHub and from files more safely:
- A pull request's avatar image is rebuilt from GitHub's own avatar address.
- Commit-graph rows never treat text as HTML.
- Markdown comments are stripped by a scanner that can't be tricked.
- Parsers that a crafted string could stall now finish at once.

The full list is in the changelog.
