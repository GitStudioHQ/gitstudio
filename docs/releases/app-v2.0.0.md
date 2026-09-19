# GitStudio 2.0 — a Home that knows what is going on, Issues and PRs that read like a tracker, and reviews that post as one

This is the redesign wave. The split panes are gone; every GitHub section is a
full-width list that opens into a full-page detail with a property rail, the
way Linear reads. Home is a workbench now. And the machine-wide view of your
repositories finally understands folders of folders.

## Home

The first screen says what is going on and what to do about it: the open
repository with Push/Fetch a click away, what is staged and unstaged, commits
waiting to be pushed, merged branches ready to sweep (the door lands on
exactly those branches), stashes, and the last commit. Beside it, your other
repositories — with `●3 ↑1 ↓2` working-tree signals so "which of my repos has
unpushed work" is answered without opening any of them — and a Needs You card
that reaches across every repository: review requests, assignments and
mentions, wherever they are.

Search is one field with a scope: this machine, or GitHub. It left the rail
(the topbar field, ⌘K and Home's box are the ways in); Organizations and Gists
moved into the GitHub group where they belong.

## Repositories

One destination for everything you have and everything you could have. Track
as many folders as you like — the app learns them from what you open — and the
list groups by the folder each repository actually lives in, two levels deep,
so `~/Developer/Client/project` is shown under Client, not dumped in "opened
from elsewhere". Linked worktrees list as what they are (a checkout, not
another repository) and are never counted twice. Clone a URL from the same
screen; a remote repository you already have on disk offers Open instead of
Clone.

## Issues and pull requests

Full-width lists with real columns — author, assignees, comment count, time —
that line up down the page; label chips that fade at the edge instead of
vanishing; state tabs with counts; facets for labels, assignees, milestones,
authors (and for PRs: base branch, review state, origin). Issues can be closed
with a reason, locked, sorted five ways, and referenced from a new issue.

Detail pages carry the whole thread: comments you can edit, delete, quote and
link; reactions; the timeline of what happened (labels, assignments, closes);
linked pull requests; participants. Images load in issues, PRs and markdown —
including attachments in private repositories.

**Reviews post as one.** Line comments queue locally — "Add to your review" —
and one submit publishes them with your verdict, the way GitHub's own "Start a
review" works. Ranges (`12-18`), pending cards in the diff, the queue listed
and removable inside the composer, the review pinned to the head you actually
read. Nothing leaves the app until you press Submit.

The Checks tab and the rail tell one story (a failed run reads Failed, not
Pending), the Commits tab groups by day with verified badges, and the Files tab
gives the diff the room — the review panel folds until there is something to
discuss.

## Branches

A table: name, subject, who created the branch and who has contributed to it,
tracking state, age — and the same for remote branches and tags, which say who
cut them. No more jargon: a tag either carries a message or points at a commit,
and the row says which.

## Open in your editor

The top bar carries **Open in <editor>** right beside Push, and so do Home and
every repository's menu. GitStudio finds the editors on your machine by itself —
VS Code, Cursor, Windsurf, Zed, Sublime, the JetBrains family, and more — by
looking where they actually are (application bundles, the folders their
command-line tools install into, Windows install paths), not by asking the PATH
a Dock-launched app barely has. Each editor shows its own icon, read out of the
application, so you pick Cursor by its mark rather than by reading a list. The
button opens your favourite; the menu beside it lists the rest, plus Reveal in
Finder and Copy path. Settings ▸ Editors sets the favourite, decides which
editors show, and takes a custom command (`hx {path}`) for anything it missed.

## The Assistant

The one AI surface got the attention the rest of the redesign had. The
transcript is a centred reading column with the chat's title in the header.
An empty chat offers six quick actions as cards that say what each does —
draft a commit, summarize or review your changes, explain what the branch adds,
draft release notes, find branches that can go. Enter sends; Shift+Enter is a
new line. Every answer copies as Markdown; a failed turn offers Try again; an
answer streaming below where you are reading shows a Jump to latest; and the
composer says which repository and branch the agent is working in. Streaming
also no longer loses you partway through a long answer.

## The icon

On macOS 26 the Dock icon is now an icon the system renders itself — the same
size and glass as every other app — instead of a legacy icon Tahoe framed
smaller on its own backing. On macOS 11–15 the tile sits on Apple's icon grid
like its neighbours. The mark in the app's top-left corner is the extension's
activity-bar mark, in colour, so the desktop and the VS Code / Cursor extension
read as one product.

## Repositories, read at a glance

Folders and repositories are finally different kinds of object: folder icons
carry the accent and repository icons don't, a repository's name is the largest
thing on the page, and a project folder is a short label with a rail running
down to what it holds instead of a bar the same height as a row. A row reads
left to right — name, then the origin that identifies it, which used to sit
across an empty four hundred pixels. On GitHub, every owner is a section you can
collapse (⌥-click collapses them all), and a pinned section head now looks
pinned instead of floating invisibly over the rows sliding beneath it.

## Everything else

- The Code page header lines up with the file list and README below it, and
  the README fills its card.
- Reacting to an issue or pull request no longer reloads the whole thread.
- A new app icon that still reads at Dock size.

- The extension's rebase list could not fold your latest commit into the one
  below it ("The top commit has nothing above it to fold into") — fixed, with
  the guard corrected for the newest-first order. (#27)
- The extension's Compare view closed every open diff on a timer — it rebuilt
  itself on each repository tick; it now repaints only when the comparison
  changed, and remembers your open diffs across the repaints that must happen.
  (#24)
- List headers are the same two lines at every width; menus hang from the
  control that opened them; completed issues are purple like a merged PR, never
  the red of a failed check.

## Updating

If you are on 1.6.0, the app will offer this release on its own: on macOS it
downloads the right installer to your Downloads folder and opens it; on Windows
and the Linux AppImage it downloads in place and restarts into 2.0.0 when you
say so.

## Installing

Four ways in, all fed by the same release assets:

```bash
# macOS and Linux
curl -fsSL https://raw.githubusercontent.com/GitStudioHQ/gitstudio/main/scripts/install.sh | bash

# Homebrew (macOS)
brew tap gitstudiohq/gitstudio https://github.com/GitStudioHQ/gitstudio
brew install --cask gitstudiohq/gitstudio/gitstudio   # add --force if you already have GitStudio.app
```

```powershell
# Windows
irm https://raw.githubusercontent.com/GitStudioHQ/gitstudio/main/scripts/install.ps1 | iex
```

Or take the `.dmg`, `.exe`, `.AppImage`, `.deb`, `.rpm` or `.tar.gz` from the
assets below. Every release carries a `SHA256SUMS.txt`, and the one-line
installers verify against it and refuse to install on a mismatch.

The builds are not code-signed yet. Homebrew and `install.sh` clear macOS's
quarantine flag for you; if you took the `.dmg` and macOS says the app is
damaged, run `xattr -d -r -s com.apple.quarantine /Applications/GitStudio.app`
once, before the first launch. On Windows, SmartScreen: **More info → Run
anyway**. The AppImage needs `libfuse2` (`sudo apt install libfuse2`; the
`.deb`/`.rpm` do not).

## Why 2.0

The version number is the honest one. Split panes are gone, Home is a
workbench, repositories are understood by the folders they live in, and the app
reads GitHub without cloning. The polish round that closed it out put the file
diff in the bottom panel at full width, freed the Commits layout from a
divider with four pixels of travel, gave every selected control its hover state
back, made the Output log selectable and copyable, and redrew the app icon so
its nodes are part of the mark rather than holes punched through it.
