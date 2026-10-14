# GitStudio 1.21.0 — from a file's history to the graph

## Find a file's commit in the Commit Graph

Every commit in **Show File History** and **Show Line History** has a
**Show in Commit Graph** button. It selects that commit in the Commit Graph,
opening the graph if it is closed and scrolling back as far as it takes. A
revision opened from either list has the same action in its title bar and in
the editor's GitStudio menu (#111).

## Changed

- **Open File at Revision… is now Show File History.** Same list of the
  file's commits, under the name that says what it is. The command id is
  unchanged, so keybindings keep working (#111).

## Fixed

- **"Reopen Editor With…" on a diff offers GitStudio Diff, not an empty
  3-pane merge.** The 3-pane merge is now offered only where it belongs, and
  GitStudio Diff opens the diff you picked in GitStudio's comparison — a
  single file is compared with HEAD. A community contribution — thank you,
  [@billdwhite](https://github.com/billdwhite) (#110).
