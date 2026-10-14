# GitStudio 2.6.2

## Fixed

- **A pull request with no CI says "No checks".** GitHub reports a commit with
  no status checks as pending, so a merged PR with no CI at all read "Pending"
  beside "Checks (0)" and the page kept re-checking it. The Checks state now
  combines the status checks with the check runs (GitHub Actions): blank when
  there are neither, and the page keeps refreshing only while something is
  actually running.
