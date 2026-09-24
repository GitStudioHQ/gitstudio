import { test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, runMergePage } from "./fixtures/mergeViewPage";

/**
 * An OPEN conflict carries a solid bar beside its line numbers (decorations.ts
 * CONFLICT_BAR, diff.css `.jb-conflict-bar`) — in the side panes still to
 * decide and in the Result — so "conflict: you choose" never rests on telling
 * red from green: under deuteranopia a conflict's band and a same-on-both
 * band come close (mergeContrast.test.ts measures how close), a bar and no
 * bar do not. The owner's rule for colour-blind users: words and high-contrast
 * borders, never new glyphs.
 *
 * Asserted on the real MergeView, Monaco and diff.css (fixtures/
 * mergeViewEntry.ts: one block of every category), state first, then what
 * Monaco painted — forced with a synchronous `render(true)`, because headless
 * Chrome under a virtual clock may service no animation frame — and its
 * COMPUTED style and geometry, never a class name alone.
 */

const CHROME = findChrome();
const skip = !CHROME && "no Chrome on this machine";

const MOUNT = `
  const W = gsMerge;
  const view = new W.MergeView(host);
  view.setRenderOptions({ whitespace: "trailing" });
  view.render(W.payload({
    op: W.REBASE_OP,
    oursLabel: W.REBASE_OP.yours.paneTitle,
    theirsLabel: W.REBASE_OP.theirs.paneTitle,
  }));
  const panes = { left: view.left, result: view.result, right: view.right };
  const paneIndex = { left: 0, result: 1, right: 2 };
  /** The lines of a pane whose decorations carry the conflict bar, "2,4,5". */
  const barLines = (pane) => panes[pane].getModel().getAllDecorations()
    .filter((d) => (d.options.linesDecorationsClassName || "").split(" ").includes("jb-conflict-bar"))
    .flatMap((d) => { const o = []; for (let l = d.range.startLineNumber; l <= d.range.endLineNumber; l++) o.push(l); return o; })
    .sort((a, b) => a - b)
    .join(",");
  /** The bars Monaco PAINTED in a pane (a synchronous render first). */
  const painted = (pane) => {
    panes[pane].render(true);
    const body = document.querySelectorAll(".jb-pane-body")[paneIndex[pane]];
    return { body, bars: [...body.querySelectorAll(".margin-view-overlays .jb-conflict-bar")] };
  };
`;

test("an open conflict — and only an open conflict — carries the bar beside its line numbers, in every pane, until it is settled", { skip }, async () => {
  const v = await runMergePage(CHROME!, MOUNT + `
    const cats = view.model.blocks.map((b) => W.category(b));
    expect(JSON.stringify(cats) === JSON.stringify(["conflict", "conflict", "same", "same", "yours-only", "theirs-only", "theirs-only", "yours-only"]), "the fixture: two conflicts, then same and one-sided changes: " + JSON.stringify(cats));
    // State: the two conflicts (line 2, lines 4-5) in all three panes; the
    // same change on both sides (7, 9) and the one-sided ones (11-16) never.
    for (const p of ["left", "result", "right"]) {
      expect(barLines(p) === "2,4,5", p + ": the bar on the open conflicts' lines and nowhere else: " + barLines(p));
    }
    // Painted: a solid 2px bar in the conflict's own colour (the legend's red
    // dot), one per line, the lines of a block meeting with no gap, inside the
    // column between the line numbers and the text.
    const red = getComputedStyle(Object.assign(document.body.appendChild(document.createElement("span")), { className: "jb-legend-dot jb-dot-conflict" })).backgroundColor;
    const geometry = {};
    for (const p of ["left", "result", "right"]) {
      const { body, bars } = painted(p);
      expect(bars.length === 3, p + ": three painted bars (lines 2, 4, 5): " + bars.length);
      for (const el of bars) {
        const cs = getComputedStyle(el);
        expect(cs.borderLeftStyle === "solid" && cs.borderLeftWidth === "2px" && cs.borderLeftColor === red,
          p + ": the bar is solid, 2px, the conflict red " + red + ": " + [cs.borderLeftStyle, cs.borderLeftWidth, cs.borderLeftColor].join(" "));
        expect(cs.backgroundColor === "rgba(0, 0, 0, 0)", p + ": the bar paints no fill of its own: " + cs.backgroundColor);
      }
      const rects = bars.map((e) => e.getBoundingClientRect()).sort((a, b) => a.top - b.top);
      const numbers = [...body.querySelectorAll(".margin-view-overlays .line-numbers")].map((e) => e.getBoundingClientRect().right);
      const text = body.querySelector(".lines-content").getBoundingClientRect().left;
      geometry[p] = { bars: rects.map((r) => [r.left, r.top, r.width, r.height]), numbersRight: Math.max(...numbers), textLeft: text };
      if (rects.length === 3) {
        expect(Math.abs(rects[1].bottom - rects[2].top) < 0.01, p + ": lines 4 and 5's bars meet: " + rects[1].bottom + " / " + rects[2].top);
        expect(rects.every((r) => r.height > 0 && Math.abs(r.height - rects[0].height) < 0.01), p + ": one bar per line, a line tall");
        expect(rects.every((r) => r.left >= Math.max(...numbers) && r.left + 2 <= text), p + ": the bar sits between the numbers (" + Math.max(...numbers) + ") and the text (" + text + "): " + rects.map((r) => r.left).join(","));
      }
    }
    notes.geometry = geometry;

    // Accept Yours on the first conflict: Yours' side is taken (a trace), the
    // Result holds one side (half done) — no bar on either; Theirs is still
    // to decide and keeps its bar. The other conflict keeps all three.
    view.acceptSide(view.model.blocks[0], "left", "auto");
    expect(barLines("left") === "4,5", "Yours taken: its lines lose the bar: " + barLines("left"));
    expect(barLines("result") === "4,5", "the Result holds one side: no bar there either: " + barLines("result"));
    expect(barLines("right") === "2,4,5", "Theirs is still to decide: its bar stays: " + barLines("right"));
    expect(painted("left").bars.length === 2 && painted("result").bars.length === 2 && painted("right").bars.length === 3, "and what is painted follows");
    // Ignore Theirs: the conflict is settled — no bar anywhere on it.
    view.ignoreSide(view.model.blocks[0], "right");
    expect(barLines("right") === "4,5", "settled: no bar on it anywhere: " + barLines("right"));
    // Undo brings the open conflict — and its bar — back.
    view.undo();
    view.undo();
    for (const p of ["left", "result", "right"]) expect(barLines(p) === "2,4,5", p + ": after undo the bar is back: " + barLines(p));
    // Settle everything: no bar is left.
    view.acceptSide(view.model.blocks[0], "left", "auto");
    view.acceptSide(view.model.blocks[0], "right", "auto");
    view.acceptSide(view.model.blocks[1], "right", "auto");
    view.acceptSide(view.model.blocks[1], "left", "auto");
    for (const p of ["left", "result", "right"]) expect(barLines(p) === "", p + ": every conflict settled, no bar: " + barLines(p));
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n") + "\n" + JSON.stringify(v.notes?.geometry));
});

test("the bar is the conflict's edge colour in every theme, and nothing else draws it", { skip }, async () => {
  for (const theme of ["dark", "light", "hc-dark", "hc-light"] as const) {
    const v = await runMergePage(CHROME!, MOUNT + `
      const probe = (cls) => {
        const el = document.createElement("div");
        el.className = cls;
        document.querySelector(".jb-pane-body").appendChild(el);
        const cs = getComputedStyle(el);
        const out = cs.borderLeftStyle + " " + cs.borderLeftWidth + " " + cs.borderLeftColor;
        el.remove();
        return out;
      };
      const edge = getComputedStyle(Object.assign(document.body.appendChild(document.createElement("span")), { className: "jb-legend-dot jb-dot-conflict" })).backgroundColor;
      const bar = probe("jb-conflict-bar");
      expect(bar === "solid 2px " + edge, "${theme}: the bar is " + bar + ", want solid 2px " + edge);
      // The legend's "?" key shows the same bar, and says what it means.
      expect(probe("jb-legend-sample jb-sample-bar") === bar, "${theme}: the key's sample is the bar: " + probe("jb-legend-sample jb-sample-bar"));
      const slot = document.getElementById("slot");
      view.attachLegend(slot);
      const row = [...slot.querySelectorAll(".jb-legend-row")].find((r) => r.querySelector(".jb-sample-bar"));
      expect(!!row && /beside the line numbers: a conflict still to decide/.test(row.textContent), "${theme}: the key's row for the bar says it in words: " + (row && row.textContent));
      // No other decision's class, and no band, draws a left bar.
      for (const cls of ["jb-line-conflict", "jb-line-same", "jb-line-one-sided", "jb-trace jb-trace-conflict", "jb-line-conflict jb-half"]) {
        expect(probe(cls).startsWith("none"), "${theme}: ." + cls.replace(/ /g, ".") + " draws no left bar: " + probe(cls));
      }
    `, { theme });
    assert.deepEqual(v.fails, [], `${theme}: ${v.fails.join("\n")}`);
  }
});
