# GitStudio 2.8.0

### Added
- **Editor font size.** Settings → Code and comparisons sets the font size of
  every code, diff, commit-changes and merge editor (6–72 px, default 12.5),
  without zooming the rest of the window the way ⌘/Ctrl + Shift + +/− does. It
  applies at once to the editors already open and is remembered across
  restarts. Thanks to @billdwhite (#140).
- **Merge a branch or tag from the commit graph.** Right-click a branch, remote
  branch or tag label in Commits for **Merge 'x' into y**. It asks first,
  offers Stash & Retry when uncommitted changes are in the way, and writes the
  merge message itself ("Merge branch 'x' into y"), as `git merge --no-edit`
  would. A tag's ⋯ menu in Branches has **Merge into current** too: tags can
  be merged now, recorded as "Merge tag 'v1'" with an annotated tag's message
  (#141).
