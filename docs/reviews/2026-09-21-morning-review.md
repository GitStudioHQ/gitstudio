# Morning review — 21 Sep 2026

Everything below is on `main` and pushed. Nothing is tagged, nothing is posted
to GitHub, nothing is merged from outside. Those four decisions are yours; each
has a one-line action.

## What you're deciding

| # | Decision | Action |
|---|---|---|
| 1 | Release **extension 1.13.0** | `git tag ext-v1.13.0 && git push origin ext-v1.13.0` |
| 2 | Release **desktop 2.0.2** | `git tag app-v2.0.2 && git push origin app-v2.0.2` |
| 3 | Merge the community PR **#28** (Show in Graph in the blame hover) | `gh pr merge 28 --admin --squash` — before tagging 1.13.0 if you want it in |
| 4 | Post the **issue replies** (drafted, below) | paste; then close #24, #27, #29 |

Try before you decide:

- **Extension 1.13.0** is already installed in **VS Code and Cursor** (both were
  on old dev builds). Reload the window (⌘⇧P → *Reload Window*), open the
  Commit Graph, click **All branches** next to the search box. Compare
  Branches/Tags, expand two files, alt-tab away and back. In the rebase
  workspace, fixup the newest commit into the previous one.
- **Desktop 2.0.2** is packaged at `apps/desktop/release/mac-arm64/GitStudio.app`
  (ad-hoc signed; just open it). Commits → **All branches**. Compare two refs,
  click the second file, press ⌘R — it stays.
- Screenshots of the picker in the real 2.0.2 build:
  `docs/reviews/2026-09-21-graph-filter-{1,2,3}.png` (closed / open / *Current branch* →
  "500+ commits" became "366 commits", only the `main` chip left).

## The issues, one line each

| Issue | Product | What was true | State now |
|---|---|---|---|
| #24 Compare collapses diffs | **extension** (not the app — the words are the sidebar's) | Core fix has been on main since Sept 18, **never shipped**; *Collapse all* didn't persist | Fixed; ships in 1.13.0. Desktop had a sibling bug (⌘R / `.git` tick reopened the *first* file) — fixed for 2.0.2 |
| #25 Pylance rename | extension | Not reproducible: A/B harness with the reporter's exact versions, six files, four import styles, every mode 6/6 with GitStudio on and off; no mechanism in our code | A census test now guards it. Reply asks the one question that settles it |
| #27 fixup HEAD | extension | Fixed Sept 18, **never shipped** | Ships in 1.13.0 |
| #29 Homebrew | app | Works: `brew install --cask gitstudiohq/gitstudio/gitstudio` | Reply + close |
| #30 branch filter | both | Feature request | **Built**, in both products, three adversarial rounds |
| #2 your 28-finding backlog | both | 9 already fixed, **15 fixed now**, 2 obsolete by design, 2 deferred refactors | Close after release; the two deferrals are listed below |
| PR #28 Show in Graph | extension | 6-line community PR, correct, merges clean | Your call — the 1.13.0 notes credit them if merged |
| PR #3 1.0.1 repair | — | Your own stale branch from July | Close without merging |

## Numbers

- 30 commits, 84 files, +7,492 / −628 since yesterday's `9540ef1`.
- Gates on the final tree: 7 typechecks, **1,323 tests** (engine 131, host-bridge 41, webview-ui 61, git-service 250, extension 161, desktop 679), both bundles, desktop harness **506/506 in dark and in light**, contrast audit 0 failures light and dark.
- Three adversarial rounds on the branch filter found and fixed: the picker opening off-pane; the ambiguous-name trap (branch + tag named alike → `heads/x`) in the chip shortcut **and** in Checkout, which would have detached HEAD; "reveal" under a filter walking 12,500 rows and then saying nothing; a transient ref-read failure erasing the saved selection; the picker hiding under the app's terminal dock; a light-theme contrast miss the ruler itself couldn't see (it could not parse `color(srgb …)`).
- CI: the Windows runner failed twice overnight on three new headless-Chrome tests (their wait used an animation frame; Chrome under a virtual-time budget serviced none there). Fixed on `5508fe6`; the run was in progress when this was written — check `gh run list --branch main --limit 1`.

## Standout changes worth knowing about

- **Graph CHANGES column**: was up to three git processes *per row*, capped at 60 rows (rows past that stayed blank for the session). Now one `git log --numstat` over stdin per visible window, both products, every row answered; a failed batch is re-asked next repaint instead of frozen at zeros.
- **Changes view (extension)**: no longer re-probes AI availability on every state push, and no longer re-sends its whole state a second time; a CLI installed after activation is noticed within five minutes.
- **Checkout by full ref name** (both menus, both products): `git checkout heads/release` detaches; we now plan the checkout from `refs/heads/…`. A tag confirms and detaches on purpose.
- **Ad-hoc signing** (2.0.1, already live): a downloaded `.dmg` gets *Done → Open Anyway* instead of "damaged".

## Known follow-ups (not blocking either release)

1. **Branches view checkout doors** (both products) still pass `%(refname:short)` to git — same ambiguous-name latency as the menus, pre-existing in every released version; needs a branch and a tag with the same name to bite. Its own pass.
2. Two light-theme contrast misses inside the *open* picker (preset ink is a brand-accent choice) — not in a gated scene; restyle deliberately, not at 4 a.m.
3. `graphInit` ships the full ref list on every refresh (~1 MB on a 10k-tag repo). Fine today; send-on-change is the cheap fix when a large-repo report arrives.
4. #2 deferrals: `parsePorcelainStatus` triplication (the desktop parser emits fields the shared one doesn't — a real refactor) and `fetchLiveInMenu`'s DOM-spelunking (works; data-driven repaint is the right shape).
5. winget: **#437547 passed all of Microsoft's checks**, waiting on a volunteer moderator. Once merged, one command submits 2.0.1/2.0.2; every release after that is automatic (`WINGET_TOKEN` is set).
6. Org setting so CI can open the cask PR itself (Actions → *Allow GitHub Actions to create and approve pull requests*).

## Drafted replies

Pasted at the end of this file. Short,
plain, no internals, per your rule. Post after the tags — three of them say
"on the Marketplace now".

## Where things are

- Release notes: `docs/releases/ext-v1.13.0.md`, `docs/releases/app-v2.0.2.md`
- Changelogs: `apps/extension/CHANGELOG.md` (1.12.1's section restored too), `apps/desktop/CHANGELOG.md`
- VSIX: `apps/extension/gitstudio-1.13.0.vsix` (2.48 MB, 116 commands)
- App build: `apps/desktop/release/mac-arm64/GitStudio.app`
- Your installed app is untouched: `/Applications/GitStudio.app` 2.0.1 via Homebrew, running.

---

# Drafted replies — post only after your OK

Each one is written to be pasted as-is. Nothing here has been posted.

---

## #24 — Compare view closes all open file diffs on a timer (brofield)

> Post after ext-v1.13.0 is on the Marketplace. Note: your earlier reply pointed
> them at the desktop app, but their report is about the VS Code extension
> (the sidebar Changes tab + "Compare Branches/Tags…"). This reply corrects that
> without making a thing of it.

Hi @brofield — this is fixed in the extension, version 1.13.0, on the Marketplace now.

The Compare panel was rebuilding itself on every repository event, including
VS Code's own periodic status refresh, which is where the 30-second-to-2-minute
timer came from. It now only repaints when the comparison itself changes, and
the files you have open stay open across the refreshes that do happen
(including the Changes refresh and switching apps and back).

If you still see it after updating, a note here with the extension version
and what you were comparing would help. Thanks for the clear report.

*Then close the issue.*

---

## #27 — Unable to fixup/squash last commit (HEAD) to previous (glazrtom)

> Post after ext-v1.13.0 is on the Marketplace.

Hi @glazrtom — fixed in 1.13.0, on the Marketplace now.

The check was looking at the wrong end of the list: the newest commit is at
the top of the rebase list but folds *downward* into the one before it, and
the guard refused exactly that. Squash and fixup of the latest commit into the
previous one work now, and a fold whose target commit gets dropped later is
flagged on its row instead of failing at the end.

Ideas are welcome any time — a ticket each is easiest to track.

*Then close the issue.*

---

## #25 — GitStudio conflicts with pylance (darkdkl)

> No reply since Sept 4. We could not reproduce it and found nothing in the
> extension that could affect a rename. Ask once more, briefly; if no answer
> in a couple of weeks, close as not reproducible.

Hi @darkdkl — I've tried to reproduce this with your versions (GitStudio
1.12.x, Pylance 2026.3.1) on a project that references a renamed symbol from
six files through different import styles, with GitStudio enabled and
disabled, with files open and closed, with auto save on and off — and the
rename updates every file every time. I also went through everything the extension does
around open files and can't find anything that would touch a rename.

One thing would settle it: with GitStudio **disabled** (Extensions → GitStudio
→ Disable, then reload the window), does the same Rename Symbol update all the
references? If it does, please share a small project that shows it and the
values of `files.autoSave` and `python.analysis.*` in your settings, and I'll
dig in. If it doesn't, the cause is elsewhere and I'll point you at what to
check next.

---

## #29 — Will it still support Homebrew? (FlynnWan)

> You already replied. Close with this after they've had a chance to try it, or
> now — the command works.

@FlynnWan it's one line now, no tap step:

```
brew install --cask gitstudiohq/gitstudio/gitstudio
```

The cask clears macOS's quarantine flag after installing, so the app opens
without the "unidentified developer" dance. Closing this — reopen if it gives
you any trouble.

*Then close the issue.*

---

## #30 — feat: filter the Commit Graph by selected branches (PanAndy)

> Post after ext-v1.13.0 is on the Marketplace. They offered to test — take
> them up on it.

Hi @PanAndy — this is in 1.13.0, on the Marketplace now.

There's a **Branches** button next to the graph's search box (and in the
Commits sidebar). Tick the branches you want and the graph rebuilds around
those refs — not a highlight, the history itself. Presets for Current branch,
Current + upstream, Local only and All; a filter box for busy repos; the ref
chips follow the selection; and right-click (or ⌥-click) a chip for "Show
only this branch" / "Add to filter" / "Remove from filter". The selection is
remembered per repository. If you reveal a commit the filter hides, it says
so and offers to show all branches.

Two things I'd like your read on, since you asked for exactly this: whether
the presets are the right four, and whether tags belong in the picker by
default (they're offered under their own group; "Local only" and the Current
presets leave them out). Thanks for the write-up — it was a spec.

*Leave open until they've tried it, then close.*

---

## PR #28 — Extension: Show in Graph (XEGARE)

> Merge with `gh pr merge 28 --admin --squash` (the repo's ruleset blocks a
> normal merge for fork PRs; --admin uses your bypass). The changelog entry
> for 1.13.0 already credits them. Comment:

Thanks @XEGARE — merged, and it ships in 1.13.0.

---

## PR #3 — GitStudio 1.0.1 repair release (yours, July)

> Stale: the 1.0.1 work shipped through other commits long ago and the branch
> is far behind main. Close it without merging; no comment needed.
