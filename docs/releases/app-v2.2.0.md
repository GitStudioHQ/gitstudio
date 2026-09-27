# GitStudio 2.2.0 — repositories as tabs, several commits at once, and nothing selected wears a line

Most of this release is the ideas in GitStudioHQ/gitstudio#32 (from
@glazrtom), for people who switch between repositories all day.

## Repositories open as tabs

The top row of the window holds a tab for each repository you open, and
each keeps its own place — its view, its selection, its search, a log you
were following. **Ctrl+Tab** and **Ctrl+Shift+Tab** move between them,
**⌃1–⌃9** jump to one, and **⌘W** closes the tab in front. Drag tabs to
reorder them; the ones you had open come back next time. The tab in front
glows instead of wearing a rule.

## Repositories, faster

Each row has an **Open in** button for your editor beside **Open**, and
shows how many changes that repository has.

## Several commits at once

Select several commits in the graph with Ctrl/Cmd-click or Shift-click and
act on them together: cherry-pick, revert, squash or drop them in one go,
compare two of them, or copy their SHAs — each undoable. In an interactive rebase, set the action of
every selected commit at once. **Drop commit…** is in the graph's menu.

## Reset a branch to its remote

When a branch has gone wrong, **Reset to origin/…** makes it match its
remote again — it asks first, and says what it will throw away.

## The branch switcher from the keyboard

Type to find a branch, move with ↑/↓, open its actions with →, and run one
with Enter.

## Lit, never lined

Whatever you pick — a row, a tab, a commit, a menu item — is lit with a soft
tint and glow instead of a bar, underline or outline, everywhere in the app.

## Fixed

A repository opened in a new tab shows its branch at once; stashes apply
and pop with what they had staged; a worktree is one folder however its
path is spelled; rebasing works in SHA-256 repositories; and more — the full
list is in the changelog.
