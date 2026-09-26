// The Changes view's twisties point the way everything else in VS Code does:
// › when closed, ˅ when open.
//
// All three (the group headers, the folder rows of the tree layout, and the
// per-file changes toggle of the checkbox model) share one glyph, and their
// CSS was written for a DOWN chevron — turned -90° when closed, left alone
// when open — while the glyph was chevron-right. So a closed group showed ˄
// and an open one ›, since 1.0.0. Checked here by what the user sees: the
// glyph's direction after the transform the page really applies, in both
// states, in Dark+ and Light+.

import { test } from "node:test";
import assert from "node:assert/strict";
import { changesViewPage, findChrome, runChangesView, statePayload, type ThemeName } from "./changesViewPage";

const CHROME = findChrome();
const skip = !CHROME && "no headless Chrome on this machine (set GS_CHROME)";

/** Where an element's chevron points, from its glyph and its computed transform. */
const DIRECTION = `
  // No transitions: a computed transform read mid-transition is neither state.
  const still = document.createElement("style");
  still.textContent = "* { transition: none !important; animation: none !important; }";
  document.head.appendChild(still);
  const pointing = (twisty) => {
    const glyph = twisty.querySelector(".codicon");
    const cls = glyph ? glyph.className : "";
    let v = /chevron-down/.test(cls) ? [0, 1] : /chevron-right/.test(cls) ? [1, 0]
      : /chevron-up/.test(cls) ? [0, -1] : /chevron-left/.test(cls) ? [-1, 0] : null;
    if (!v) return "no chevron (" + cls + ")";
    const t = getComputedStyle(twisty).transform;
    const m = /matrix\\(([^)]+)\\)/.exec(t);
    if (m) {
      const [a, b, c, d] = m[1].split(",").map(Number);
      v = [a * v[0] + c * v[1], b * v[0] + d * v[1]];
    }
    const [x, y] = v.map((n) => Math.round(n));
    return x === 1 ? "right" : x === -1 ? "left" : y === 1 ? "down" : "up";
  };
`;

for (const theme of ["dark", "light"] as ThemeName[]) {
  test(`${theme}: group and folder twisties point right when closed and down when open`, { skip }, async () => {
    const state = statePayload({
      staged: [{ path: "src/util.ts", status: "M" }],
      unstaged: [{ path: "src/app.ts", status: "M" }, { path: "lib/deep/x.ts", status: "M" }],
      stagedCount: 1,
      layout: "tree",
    });
    const r = await runChangesView(
      CHROME!,
      changesViewPage({
        theme,
        width: 300,
        harness: `${DIRECTION}
        post(${JSON.stringify(state)});
        await tick(); await tick();
        const header = (g) => document.querySelector(".group--" + g + " .group-header");
        expect(!!header("staged") && !!header("unstaged"), "both groups render");
        header("staged").click();
        await tick();
        const closed = pointing(header("staged").querySelector(".twisty"));
        const open = pointing(header("unstaged").querySelector(".twisty"));
        notes.groups = { closed, open };
        expect(closed === "right", "a closed group points right: " + closed);
        expect(open === "down", "an open group points down: " + open);

        const folder = () => Array.from(document.querySelectorAll(".group--unstaged .row")).find((r) => r.querySelector(".twisty"));
        expect(!!folder(), "the tree layout has a folder row");
        if (folder()) {
          const f = folder();
          expect(pointing(f.querySelector(".twisty")) === "down", "an open folder points down: " + pointing(f.querySelector(".twisty")));
          f.click();
          await tick();
          const again = folder();
          expect(again && again.classList.contains("collapsed"), "clicking the folder closes it");
          expect(again && pointing(again.querySelector(".twisty")) === "right", "a closed folder points right: " + (again && pointing(again.querySelector(".twisty"))));
        }
      `,
      }),
    );
    assert.deepEqual(r.fails, [], JSON.stringify(r.notes));
  });

  test(`${theme}: a file's changes toggle (checkbox model) points right when closed and down when open`, { skip }, async () => {
    const state = statePayload({ stagingModel: "checkboxes" });
    const r = await runChangesView(
      CHROME!,
      changesViewPage({
        theme,
        width: 300,
        harness: `${DIRECTION}
        post(${JSON.stringify(state)});
        await tick(); await tick();
        const tw = () => document.querySelector(".hunk-twisty");
        expect(!!tw(), "a file with unstaged work has the toggle");
        if (tw()) {
          const closed = pointing(tw());
          expect(closed === "right", "closed points right: " + closed);
          tw().click();
          await tick(); await tick();
          const open = tw() && pointing(tw());
          expect(tw() && tw().classList.contains("open"), "clicking it opens it");
          expect(open === "down", "open points down: " + open);
        }
      `,
      }),
    );
    assert.deepEqual(r.fails, [], JSON.stringify(r.notes));
  });
}
