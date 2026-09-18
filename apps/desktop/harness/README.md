# Headless render harness

Runs the WHOLE desktop renderer in plain headless Chrome against realistic
fixtures — no Electron, no GitHub, no repo. This is how UI work on the desktop
app gets **seen** before it ships: every view, both themes, list and detail
states, driven by scripted scenes.

```sh
cd apps/desktop
node esbuild.js          # build the renderer bundles
harness/gen.sh           # assemble harness/page from dist + shim.js
harness/shot.sh issues out/issues.png            # screenshot a scene
harness/shot.sh 'issues~open31' out/detail.png   # …with driver steps
harness/shot.sh 'prs~open106~click:.gh-subtab%5Bdata-sub%3Dfiles%5D' out/files.png
harness/shot.sh issues out/light.png light       # light theme
```

## Functional checks

Screenshots prove a surface renders. They do not prove the count badge tracks
the filter, that a disabled button is disabled, that a menu is dismissed on
navigation, or that two columns share an x — those are assertions.

```sh
node harness/check.mjs                 # every case
node harness/check.mjs count palette   # only cases matching these substrings
```

Each case names a scene and an assertion from `checks.js`, which runs INSIDE
the page after the scene driver finishes and returns a list of failures. The
runner exits non-zero if anything fails, so it can gate a commit. Add a case by
writing the assertion in `checks.js` and listing `[id, scene]` in `check.mjs`.

## Measuring, rather than asserting

A check pins one named invariant. These three sweep every scene and report what
is wrong, which is how you find the defects nobody thought to write a check for
— and all three report things a screenshot review cannot see.

```sh
node harness/contrast.mjs --sweep --theme=light   # WCAG ratio for every text node
node harness/affordance.mjs --sweep               # cursor, name, hit size, hover, focus
node harness/fit.mjs --sweep                      # overflow, clipping, overlap, stranded space
node harness/contrast.mjs issues --theme=light    # one scene
```

Each exits non-zero when it finds anything, so they gate a run too. Two traps
worth knowing before trusting a result: headless Chrome's virtual clock leaves
views mid-entrance-animation, so all three kill animations before measuring;
and `document.styleSheets[].cssRules` throws on a `file://` page, which is why
`affordance.mjs` reads the built stylesheet in node and passes the selectors in
rather than scanning it from inside the page.

Each gives Chrome a throwaway `--user-data-dir` so runs cannot share state, and
removes it on the way out — on a clean finish, on Ctrl-C, and on the `pkill` a
stalled sweep gets. Without that they accumulate: one night of sweeps left 380
profiles and 2.2GB in the temp folder.

`shim.js` fakes the preload's `window.gitstudio` bridge (see `shared/ipc.ts`)
with fixtures for the GitStudio repo itself. Unstubbed channels log
`[shim missing] <channel>` to the console and resolve safely — add a fixture
when a view needs one. `harness/page/` and `harness/out/` are generated.
