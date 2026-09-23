# The merge matrix

Every conflict the merge UI supports, in every git operation that can stop
with one, in every `merge.conflictStyle`. The merge checks use it instead of
a single hand-made one-line conflict.

```sh
bash scripts/merge-e2e/fixtures.sh /tmp/matrix            # build it (~30 s, 33 repositories)
npx tsx scripts/merge-e2e/oracle.ts                        # regenerate oracle.json (builds its own matrix)
npx tsx scripts/merge-e2e/oracle.ts --check                # fail if oracle.json is stale
npx tsx --test scripts/merge-e2e/matrix.test.ts            # completeness + staleness (~80 s)

# see any file of any scenario, in the real merge view
export GS_CHROME=~/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell
npx tsx scripts/merge-e2e/render.ts --scenario rebase.diff3 --file stress/userService.js \
    --host both --theme dark,light --out-dir /tmp/shots
```

## Files

| File | What it is |
|---|---|
| `fixtures.sh` | Builds one repository per operation, stopped with conflicts, each carrying every content case. Hermetic (no global/system config, `core.autocrlf=false`, fixed identities and dates, so every sha and header is the same on every machine). |
| `cases.ts` | The definition: operations, conflict styles, content cases, and what each case must produce. |
| `oracle.ts` → `oracle.json` | What every later check expects of every file, read from git and the products' own code (never typed by hand). |
| `completeness.ts` | Holds an oracle to `cases.ts`, in both directions. |
| `matrix.test.ts` | Builds the matrix, checks it, requires `oracle.json` to match, and proves the checker fails on a shrunken matrix. |
| `render.ts`, `cdp.ts`, `themes.ts` | Headless render of the real merge view: the extension's webview (VS Code Dark+ / Light+ / HC dark / HC light token values) and the desktop renderer (dark / light). |

## One convention

In every operation, git's stage 1 holds BASE, stage 2 holds X, stage 3 holds Y.
Which of X and Y is Yours is up to the operation: in a merge Yours is X
(stage 2), in a rebase or stash pop Yours is Y (stage 3). `oracle.json` records
both, per file (`yours`, `theirs`).

## Scenarios (`<operation>.<style>`, style = merge | diff3 | zdiff3)

| Operation | How it stops | Header |
|---|---|---|
| `merge` | on main, `git merge feature` | Merging feature into main |
| `rebase` | on test (3 commits), `git rebase master`, merge backend | Rebasing test onto master · commit 2 of 3: … |
| `rebase-apply` | the same with `--apply` | Rebasing test onto master · commit 2 of 3: … |
| `rebase-merges` | `git rebase -i -r main` re-creating the merge of side into feat | Re-creating merge of side into feat · step 3 of 3 |
| `cherry-pick` | on main, `git cherry-pick feature` | Cherry-picking … onto main |
| `cherry-pick-range` | on main, `git cherry-pick main..feature`, stops on the 2nd of 3 | … · 1 more queued |
| `revert` | on main, `git revert HEAD~1` | Reverting … on main |
| `am` | on main, `git am -3` of feature's patch | Applying patch 1 of 1: … onto main |
| `stash` | Y stashed, X committed, `git stash pop` | Applying stashed changes on main |
| `issue12` | the #12 reporter's steps (`git checkout test; git rebase master`), every case in the one commit | Rebasing test onto master · commit 1 of 1: … |
| `issue12-exact` | the reporter's exact repository: `f.txt` only | Rebasing test onto master · commit 1 of 1: … |

## Content cases (30 conflicted paths in every operation except `issue12-exact`)

- **The owner's merge-conflict-tests:** `app/version.py` (UU, one line), `app/settings.py` (UU, one dict value), `app/calculator.py` (UU, two regions), `README.md` (UU, multi-line + an auto-mergeable edit), `app/greeting.py` (UD), `app/legacy.py` (DU), `app/new_feature.py` (AA).
- **Merge Studio's stress fixture:** `stress/userService.js` (unequal-height conflicts, delete-vs-modify, an overlapping insertion, one-line values, an identical edit on both sides, one-sided changes, a conflict at end of file) and `stress/config.json`.
- **Merge Studio's load fixture:** `load/bigService.js` (1201 blocks), `load/giantList.js`, `load/config.json`.
- **Everything else:**
  - `cases/whitespace.txt`: a whitespace-only change, and an edit both sides made that differs only in whitespace (≈).
  - `cases/adjacent.txt`: resolvable, meaning the edits are adjacent but don't overlap.
  - `cases/windows.txt`: CRLF.
  - `cases/eol-mixed.txt`: CRLF on one side, LF on the other.
  - `cases/no-eol.txt`: no trailing newline.
  - `cases/added-both.txt`: empty base, AA.
  - `cases/empty-base.txt`: stage 1 is the empty file.
  - `assets/logo.bin`: binary.
  - `data/huge.log`: larger than 512 KiB.
  - `rename/new_name.py`: renamed on one side.
  - `rename2/*`: renamed differently on each side, which gives DD + AU + UA.
  - `layout/panel…`: file/directory.
  - `docs/naïve café/résumé – notes.md`: spaces and unicode in the path.
  - `links/current`: a symlink.
  - `vendor/lib`: a submodule.
  - `f.txt`: the #12 reporter's file.

Between them the cases reach every shape the UI distinguishes: text, added-both, binary, too-large, modify-delete, both-deleted and added-one-side.

## Things git does here that a check must not assume away

- `git am -3` of a patch with a pure rename fails with "could not build fake ancestor" and merges nothing. `fixtures.sh` formats the patch `--no-renames`, the same way rebase's apply backend does.
- `am` and `rebase --apply` strip CRs from the patch unless `am.keepcr` is set. Without it the CRLF case fails the whole patch. `fixtures.sh` sets it.
- A file/directory conflict gets a different path depending on the operation:
  - `layout/panel~HEAD` for merge, rebase, cherry-pick and revert.
  - `layout/panel~Updated upstream` for stash.
  - `layout/panel` (AU, not moved aside) for `am` and `rebase --apply`.
- If a rename/rename also edits the file, git stores a three-way merge, markers included, in both new names' stages. That's why `rename2` only renames.
- git's own conflict count and the engine's don't always agree, and `oracle.json` records both. `git merge-file` also depends on the conflict style. Two examples:
  - `eol-mixed.txt`: git reports 1 conflict and the engine 0, because the engine normalises line endings.
  - `stress/userService.js`: the engine reports 6 conflicts, git reports 5 in diff3 style and 3 in merge style.
