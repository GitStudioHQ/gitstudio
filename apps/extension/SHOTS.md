# README media for the GitStudio extension

The README's hero and screenshots (`media/shots/`). Every one is captured
from a build of the extension in real VS Code, on a made-up project, by the
scripts in [`scripts/extension-shots/`](../../scripts/extension-shots). Retake
a shot whenever the surface it shows changes, and never hand-edit one.

## How they are made

An isolated VS Code (its own `--user-data-dir` and `--extensions-dir`, the
test VSIX installed into them) driven over CDP, launched with
`open -g -j -n` (in the background, never focused or raised; nothing in the
owner's profile or windows is touched), quit and its profile deleted when the
run ends. Git in that VS Code reads no global or system config
(`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`): no one's name,
signing or hooks reach the demo. Nothing needs the network or a credential.

- **2× device pixels** from `--force-device-scale-factor=2`: a window
  launched hidden has no screen to take 2× from.
- **The window opens at the capture size** (1440×900 for the PNGs, 1280×800
  for the hero), from the `windowsState` seeded into the profile's
  `storage.json`. `Page.captureScreenshot` hangs when the viewport is
  overridden to another size than the window's.
- **Dark shots in Default Dark Modern, light in Default Light Modern.** The
  profile is signed in to nothing; Copilot and chat are off, and so are VS
  Code's own blame decorations.
- **Every capture is checked by DOM, not by eye**, before and after the
  screenshot: the text the shot is about must be on screen (webviews and
  shadow roots included, and the blame text VS Code draws with CSS), and
  nothing matching `FORBIDDEN` in `vscode.ts` may be anywhere on screen (the
  owner's name or account, a real mail domain, a home directory, another
  GitHub account).
- Side-bar shots keep the activity bar and are cropped at the bottom of the
  view's content, not at the window's.
- PNGs are optimised with `oxipng -o 4 --strip safe`.

## The demo repository

`scripts/extension-shots/make-demo-repo.sh [dir]` (default `/tmp/gs-demo`)
builds **lumen**, a small static site generator in TypeScript, with five
invented authors (`@example.com`): `main`, a merged `feature/offline-cache`,
`release/1.0.x` merged back, an open `feature/search-filters` (pushed; one
commit behind origin), an unmerged local `feature/dark-mode`, tags `v0.9.0`,
`v1.0.0`, `v1.0.1`, `v1.1.0-beta.1`, a bare `origin` with `main` 2 ahead and 1
behind, a linked worktree `lumen-hotfix` on `hotfix/cache-errors` (one commit
to push, one changed file), two stashes (one holding a staged and an untracked
file), and staged, unstaged and untracked work — `src/sitemap.ts` has two
separate changes, so one can be staged alone.

Commit dates are days before `LUMEN_ANCHOR` (a UTC date, default today), so
the ages on screen read the same whenever the shots are retaken; pin it to get
the same SHAs. Keep the target a short path outside any home directory:
tooltips and the Worktrees view show it.

## Retaking them

macOS, `/Applications/Visual Studio Code.app` (or `GS_VSCODE_APP`), `ffmpeg`,
`gifski` and `oxipng`. Build the VSIX first; the extension's version is not
touched.

```sh
(cd apps/extension && npm run package && npx @vscode/vsce package --no-dependencies -o /tmp/gs-vsix/)

npx tsx scripts/extension-shots/shots.ts --vsix /tmp/gs-vsix                  # every PNG, dark then light (~5 min)
npx tsx scripts/extension-shots/shots.ts --vsix /tmp/gs-vsix --only blame,line-history --themes dark
npx tsx scripts/extension-shots/hero.ts --vsix /tmp/gs-vsix                   # hero.gif (~2 min)
```

Each run builds a fresh demo repository and a fresh VS Code, and writes into
`apps/extension/media/shots/` (`--out` elsewhere). A failed shot writes the
screen it saw to `.debug-<theme>-<name>.png` there: delete it, never commit it.
`shots.ts` uses DevTools port 9891 and `hero.ts` 9892; never run two runs on
one port at once (the second one's cleanup quits the first one's VS Code).
The window is a real one: pointer or keys reaching it mid-run spoil the run.

## The hero

`hero.gif`: 1200×750, 20 fps, about 9 s, about 1.5 MB. One take, driven with
real clicks and keys:

1. In the Commit Graph (the panel, under GitStudio's diff of `src/sitemap.ts`),
   click `feat(build): write sitemap.xml next to the pages`, then Cmd-click two
   more: the details pane becomes *3 commits selected*, with Cherry-Pick,
   Revert, Squash, Drop and Copy SHAs for all three.
2. In the Changes view, open the stash *WIP: retry cache writes with backoff*
   to its two files.
3. In the diff, tick the first of `sitemap.ts`'s two changes: the file is now
   under both Staged and Unstaged, and the button reads *Commit 3*.
4. Type `feat(sitemap): escape URLs` and press *Commit*: the new commit lands
   at the top of the graph and the Commits rail, and *Push 3* waits.

Recorded with `Page.startScreencast` (every frame the page paints, with its
timestamp), then resampled to a steady 20 fps at 1.25× speed (ffmpeg's concat
demuxer, each frame held until the next one's timestamp), scaled to 1200 px
(lanczos) and encoded with gifski at quality 90. CDP input draws no pointer,
so the page gets a drawn one and a ring at each click (`showCursor` in
`vscode.ts`; it takes no events). The screen's text is checked every 0.7 s
during the take as well as before and after it. Flags: `--fps`, `--speed`,
`--width`, `--quality`, `--keep-frames`.

## The files

Window shots are 2880×1800 (1440×900 at 2×); side-bar shots are 876 px wide
(the activity bar and a 390 px side bar) and as tall as their view's content.

| File | Theme | What it shows |
| --- | --- | --- |
| `hero.gif` | dark | The take above. |
| `graph-panel.png` | dark | The Commit Graph panel maximized, side bar closed: *Uncommitted changes*, then 20-odd commits in lanes — `main`, the merged `release/1.0.x` and `feature/offline-cache`, the open `feature/search-filters` and `feature/dark-mode`, the worktree's `hotfix/cache-errors` — with branch, remote (`origin/main`, `origin/feature/search-filters`, `origin/hotfix/cache-errors`) and tag chips (`v1.0.0`, `v1.0.1`, `v1.1.0-beta.1`), initials on the nodes, and the Changes, Author and Date columns. |
| `graph-panel-light.png` | light | The same in Default Light Modern. |
| `graph-multi-select.png` | dark | Three commits Cmd-clicked in the maximized graph; the details pane reads *3 commits selected, by Maya Chen and Sofia Marino · 7d ago to 2d ago*, lists them, and offers Cherry-Pick 3 Commits, Revert 3 Commits, Squash 3 Commits…, Drop 3 Commits… and Copy SHAs. |
| `commits-rail.png` | dark | The Commits view alone in the side bar: search, *Uncommitted changes*, and two-line rows (subject; chip, short author, age) along the lane rail, full height. |
| `changes-view.png` | dark | The Changes view: `main` with Push 2 and Pull 1, the commit box (Amend, Sign-off, Author, Commit 2, Commit & Push), Staged (2), Unstaged (3), and Stashes with *WIP: retry cache writes with backoff* opened to `cache.ts` (staged) and `retry.ts` (untracked), Apply and Pop on its row. |
| `branch-dialog.png` | dark | The branch menu from the `main` chip: search, Fetch, Pull, Push…, New Branch…, Checkout Tag or Revision…; Local branches with their ↑/↓ badges and upstream (`main` ↑2 ↓1, `feature/search-filters` ↓1, `hotfix/cache-errors` ↑1); Remote `origin`; Tags. |
| `worktrees-view.png` | dark | The Worktrees view with both worktrees open: `lumen` on `main` (staged changes, changes, 2 not pushed to `origin/main`, 1 to pull, Pull and Push…) and `lumen-hotfix` on `hotfix/cache-errors` (1 changed file, its commit to push opened to `cache.ts` +2 −1, Push…). |
| `diff-ticks.png` | dark | *Stage Changes with Ticks* on `src/sitemap.ts`: GitStudio's side-by-side diff (HEAD / Working Tree, 2 differences) with a tick per change, the first ticked; the Changes view beside it lists `sitemap.ts` under Staged and Unstaged and reads Commit 3. |
| `changes-checkboxes.png` | dark | The Changes view switched to checkboxes: one Changes list with a tick per file; `sitemap.ts` opened to its two changes, L2–3 ticked and L6–7 not, so its own tick is partial; Commit 3. |
| `blame.png` | dark | *Annotate with Git Blame* on `src/build.ts`: date and author per line in an age-tinted gutter; line 21's inline blame (*Priya Raman, 9d • fix(cache): cached pages keep their titles*) and the same in the status bar. Side bar closed. |
| `line-history.png` | dark | Lines 19–23 of `src/build.ts` selected and Cmd+Alt+G H: *Line History — build.ts · lines 19–23* over the Changes view, listing the four commits that shaped them. |
| `interactive-rebase.png` | dark | *Start Interactive Rebase…* onto `HEAD~6`: six commits, the top one Squash (*Folds down into …, keeps both messages*), `feat: sitemap.xml` Reword with its new message typed, `fix(build): build pages in a stable order` Edit (*the rebase pauses here*), the rest Pick; the legend, and 6 → 5 commits with Cancel and Start Rebase. Nothing is started. |
| `merge-editor.png` | dark | *Open Sample Merge*: the three-pane merge editor on the built-in sample, `feature/session-hardening` onto `main`, commit 2 of 3, fresh (nothing resolved), toolbar, legend and bottom bar in frame. |

Not shot: the Pull Requests view and the pull-request pages. They need a
GitHub sign-in and GitHub's API, and these captures never reach the network
or a credential.

## The README and the Marketplace

`media/shots/**` is not shipped in the VSIX (`.vscodeignore`). The release
workflow packages with
`--baseImagesUrl https://github.com/GitStudioHQ/gitstudio/raw/HEAD/apps/extension`,
so vsce rewrites every relative image in the README (Markdown images and
`<img src>`, not `<picture>`/`<source>`) to that URL on the default branch. A
new or renamed file shows on the Marketplace only once it is on `main`; keep
the old names until then. Keep `>` out of alt text: vsce's `<img>` rewrite
stops at the first one.
