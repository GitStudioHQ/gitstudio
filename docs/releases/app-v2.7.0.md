# GitStudio 2.7.0

## Fixed

- **A column you turn on shows when there is room.** Below a fixed width the
  Commit Graph dropped Date and SHA even when they fit, so ticking them in the
  Columns menu could do nothing. The commit message now gives way first, and a
  column that truly can't fit is named in the Columns menu ("SHA hidden — panel
  too narrow") (#124).
