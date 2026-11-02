# GitStudio 1.23.0 — merge from the graph

## Merge a branch or tag from the Commit Graph

Right-click a branch, remote branch or tag label in the Commit Graph, the
sidebar's commit list or a commit's details, and choose **Merge 'x' into y**.
It asks first, offers Stash & Retry when uncommitted changes are in the way,
reports conflicts, can be undone, and writes the merge message itself
("Merge branch 'x' into y"), as `git merge --no-edit` would. The branch you are
on doesn't offer it (#141).

## Fixed

- **Merging a tag names it the way git does.** Merging a tag recorded
  "Merge tag 'refs/tags/v1'"; it now reads "Merge tag 'v1'", with an annotated
  tag's message under it.
