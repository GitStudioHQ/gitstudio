# GitStudio 1.21.1

## Fixed

- **Typing no longer stalls.** After each pause in typing, the staged-changes
  gutter re-diffed the file, and the diff read the clock once per step: about
  640,000 reads for one edit in an 800-line file. Where reading the clock is
  slow (Linux on the hpet clocksource) that froze the editor for up to 800 ms
  per pause; the same edit now takes about 14 ms. Typing also no longer starts
  git processes for the gutter (#115).
- **No more "no such path in HEAD" blame errors for untracked files.** A file
  that was never committed is no longer blamed, and logged as failing, on
  every edit; blame tries again once it is committed or staged (#115).
