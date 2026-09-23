import { test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, runMergePage } from "./fixtures/mergeViewPage";

/**
 * The merge view's colour categories, driven in headless Chrome against the
 * REAL MergeView, Monaco and diff.css (PLAN §3.6, W8).
 *
 * The fixture (fixtures/mergeViewEntry.ts) holds one block of every category:
 * a conflict, a resolvable conflict, an identical change, an identical-but-
 * whitespace change, a Yours-only change, a Theirs-only insertion and
 * deletion, and a Yours-only whitespace-only re-indent. It is a UNIT fixture:
 * the whole conflict matrix (every operation, every content case, every
 * block) is measured by scripts/merge-e2e/alignment.ts and shot by render.ts.
 *
 * What is asserted, and why that way:
 * - STATE first, synchronously after render(), before any paint: the category
 *   classes in each pane's Monaco decorations, the counts, the controls.
 *   Headless Chrome under a virtual-time budget may service no animation frame
 *   at all, so nothing here waits on requestAnimationFrame.
 * - Then COMPUTED STYLES, never class names alone: a class with no rule fails
 *   silently, and a class-name check passes on that broken build. Each
 *   decoration's own className is put on a probe in the real pane, and the
 *   computed colour / border is what is checked.
 * - The ribbons are asserted after the 32 ms overlay timer — the repaint must
 *   land without a frame.
 */

const CHROME = findChrome();
const skip = !CHROME && "no Chrome on this machine";

/** Shared prologue: a MergeView in "Trim whitespace" mode, rebase names. */
const MOUNT = `
  const W = gsMerge;
  let counts = null;
  const view = new W.MergeView(host);
  view.onCountsChanged = (c) => { counts = c; };
  view.setRenderOptions({ whitespace: "trailing" });
  view.render(W.payload({
    op: W.REBASE_OP,
    oursLabel: W.REBASE_OP.yours.paneTitle,
    theirsLabel: W.REBASE_OP.theirs.paneTitle,
  }));
  const panes = { left: view.left, result: view.result, right: view.right };
  const paneIndex = { left: 0, result: 1, right: 2 };
  /** "line:className" of every block decoration (the ones naming a category). */
  const catDecos = (pane) => panes[pane].getModel().getAllDecorations()
    .filter((d) => (d.options.className || "").includes("jb-cat-"))
    .map((d) => d.range.startLineNumber + (d.range.endLineNumber !== d.range.startLineNumber ? "-" + d.range.endLineNumber : "") + ":" + d.options.className)
    .sort();
  const classesOn = (pane, line) => panes[pane].getModel().getAllDecorations()
    .filter((d) => d.range.startLineNumber <= line && line <= d.range.endLineNumber)
    .map((d) => [d.options.className, d.options.inlineClassName].filter(Boolean).join(" "))
    .join(" ");
  /** Computed style of a probe carrying \`cls\`, inside the real pane (so scoped rules apply). */
  const probe = (pane, cls) => {
    const body = document.querySelectorAll(".jb-pane-body")[paneIndex[pane]];
    const el = document.createElement("div");
    el.className = cls;
    el.style.cssText = "position:absolute;left:0;top:0;width:40px;height:18px";
    body.appendChild(el);
    const cs = getComputedStyle(el);
    const out = {
      bg: cs.backgroundColor,
      bt: cs.borderTopStyle, btw: cs.borderTopWidth, btc: cs.borderTopColor,
      bb: cs.borderBottomStyle, bbw: cs.borderBottomWidth, bbc: cs.borderBottomColor,
      bl: cs.borderLeftStyle, blc: cs.borderLeftColor,
    };
    el.remove();
    return out;
  };
  const layerA = () => document.querySelector(".jb-gutter-a .jb-button-layer");
  const layerB = () => document.querySelector(".jb-gutter-b .jb-button-layer");
  const groupsIn = (layer) => [...layer.querySelectorAll(".jb-change-actions")].map((g) => Number(g.dataset.block)).sort((a, b) => a - b);
  const press = (el) => el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  const TINT = {
    conflict: "rgba(240, 105, 100, 0.24)",
    modified: "rgba(40, 150, 245, 0.28)",
    inserted: "rgba(80, 180, 40, 0.14)",
    deleted: "rgba(139, 148, 158, 0.22)",
  };
  /** A settled change's trace — a taken side, its ribbon, the Result (and a half-done Result). */
  const MUTED = {
    conflict: "rgba(240, 105, 100, 0.12)",
    modified: "rgba(40, 150, 245, 0.13)",
    inserted: "rgba(80, 180, 40, 0.08)",
    deleted: "rgba(139, 148, 158, 0.11)",
  };
  const EDGE = {
    conflict: "rgb(240, 104, 106)",
    modified: "rgb(74, 159, 245)",
    inserted: "rgb(98, 179, 74)",
    deleted: "rgb(139, 148, 158)",
  };
  const DONE = {
    conflict: "rgba(240, 104, 106, 0.5)",
    modified: "rgba(74, 159, 245, 0.5)",
    inserted: "rgba(98, 179, 74, 0.5)",
    deleted: "rgba(139, 148, 158, 0.5)",
  };
  /** An insertion or deletion point's line (and a ribbon's end at it). */
  const POINT = { inserted: "rgba(98, 179, 74, 0.62)", deleted: "rgba(139, 148, 158, 0.62)" };
  /** Monaco's hover words for a decoration on a line (markdown's escapes undone). */
  const hoverOn = (pane, line) => panes[pane].getModel().getAllDecorations()
    .filter((d) => d.options.hoverMessage && d.range.startLineNumber <= line && line <= d.range.endLineNumber)
    .map((d) => d.options.hoverMessage.value.replace(/\\\\(.)/g, "$1"));
  const note = (layer, block) => document.querySelector(".jb-gutter-" + layer + ' .jb-trace-note[data-block="' + block + '"]');
`;

test("every category is classified, painted and given its own controls — before any paint", { skip }, async () => {
  const v = await runMergePage(CHROME!, MOUNT + `
    // ── the model: one block of each category ──
    const cats = view.model.blocks.map((b) => W.category(b) + (b.kind === "both-same" && !b.exact ? "~" : "") + (b.resolvable ? "*" : "") + (b.whitespaceOnly ? " ws" : ""));
    expect(JSON.stringify(cats) === JSON.stringify(["conflict", "conflict*", "same", "same~", "yours-only", "theirs-only", "theirs-only", "yours-only ws"]),
      "blocks are classified by category: " + JSON.stringify(cats));

    // ── the counts, pushed synchronously by render() ──
    expect(counts && counts.total === 8 && counts.pending === 8 && counts.conflictsPending === 2, "counts: " + JSON.stringify(counts));
    const by = counts && counts.byCategory;
    expect(by && JSON.stringify(by) === JSON.stringify({ conflict: { total: 2, pending: 2 }, same: { total: 2, pending: 2 }, "yours-only": { total: 2, pending: 2 }, "theirs-only": { total: 2, pending: 2 } }),
      "byCategory: " + JSON.stringify(by));
    expect(counts && counts.resolvableConflictsPending === 1, "one conflict the wand can resolve: " + (counts && counts.resolvableConflictsPending));
    expect(counts && counts.hasProgress === false, "nothing done yet: hasProgress false");

    // ── the decorations each pane carries, by category ──
    const expectPane = (pane, want) => {
      const got = catDecos(pane);
      const w = [...want].sort();
      expect(JSON.stringify(got) === JSON.stringify(w), pane + " pane decorations\\n   got  " + JSON.stringify(got) + "\\n   want " + JSON.stringify(w));
    };
    // A change made the same on both sides is painted by what it did (here a
    // change: blue) on BOTH sides and in the result — no colour of its own.
    expectPane("left", [
      "2:jb-line-conflict jb-cat-conflict",
      "4-5:jb-line-conflict jb-cat-conflict",
      "7:jb-line-modified jb-cat-same",
      "9:jb-line-modified jb-cat-same",
      "11:jb-line-modified jb-cat-yours-only",
      "16:jb-line-modified jb-cat-yours-only jb-ws",
    ]);
    expectPane("right", [
      "2:jb-line-conflict jb-cat-conflict",
      "4-5:jb-line-conflict jb-cat-conflict",
      "7:jb-line-modified jb-cat-same",
      "9:jb-line-modified jb-cat-same",
      "13:jb-line-inserted jb-cat-theirs-only",
      "15:jb-point-deleted jb-point jb-cat-theirs-only",
    ]);
    expectPane("result", [
      "2:jb-line-conflict jb-cat-conflict",
      "4-5:jb-line-conflict jb-cat-conflict",
      "7:jb-line-modified jb-cat-same",
      "9:jb-line-modified jb-cat-same",
      "11:jb-line-modified jb-cat-yours-only",
      "13:jb-point-inserted jb-point jb-cat-theirs-only",
      "14:jb-line-deleted jb-cat-theirs-only",
      "16:jb-line-modified jb-cat-yours-only jb-ws",
    ]);
    // Word tints: a real change has them; a whitespace-only one never does.
    expect(/jb-inner-conflict/.test(classesOn("left", 2)), "the conflict carries word tints (" + classesOn("left", 2) + ")");
    expect(!/jb-inner-/.test(classesOn("left", 16)), "the whitespace-only change has no word tint (" + classesOn("left", 16) + ")");
    expect(/jb-frame-conflict/.test(classesOn("result", 2)), "pending blocks carry the high-contrast frame edges");
    // The line-number margin carries the band too, so it runs across the pane.
    const margin = view.left.getModel().getAllDecorations().filter((d) => d.range.startLineNumber === 2 && d.options.marginClassName);
    expect(margin.some((d) => /jb-line-conflict/.test(d.options.marginClassName)), "the margin is tinted: " + JSON.stringify(margin.map((d) => d.options.marginClassName)));

    // ── the controls: an arrow toward the result and ×, for every change ──
    const A = groupsIn(layerA()), B = groupsIn(layerB());
    expect(JSON.stringify(A) === "[0,1,2,3,4,7]", "Yours gutter: every change Yours made, the identical ones included (JetBrains: either side accepts it): " + JSON.stringify(A));
    expect(JSON.stringify(B) === "[0,1,2,3,5,6]", "Theirs gutter: " + JSON.stringify(B));
    expect(!document.querySelector(".jb-result-actions, .jb-mark, .jb-btn-wand, .jb-btn-append"), "nothing of our own invention: no result-margin marks, no per-change wand, no append icon");
    expect(view.result.getOption(W.monaco.editor.EditorOption.glyphMargin) === false, "the result has no glyph column to hold such marks");

    // ── words: tooltip and accessible name say the action, the side and its name ──
    const btn = (layer, block, cls) => document.querySelector(".jb-gutter-" + layer + ' .jb-change-actions[data-block="' + block + '"] ' + cls);
    const want = [
      ["a", 0, ".jb-btn-accept", "Accept Yours (test) for this conflict", " (1 of 2)"],
      ["a", 0, ".jb-btn-ignore", "Ignore Yours (test) for this conflict", " (1 of 2)"],
      ["b", 1, ".jb-btn-accept", "Accept Theirs (master) for this conflict", " (2 of 2)"],
      ["a", 2, ".jb-btn-accept", "Same change on both sides — either arrow takes it", " (1 of 2)"],
      ["b", 2, ".jb-btn-accept", "Same change on both sides — either arrow takes it", " (1 of 2)"],
      ["b", 3, ".jb-btn-ignore", "Discard this change on both sides", " (2 of 2)"],
      ["a", 4, ".jb-btn-accept", "Accept Yours (test) for this change", " (1 of 2)"],
      ["b", 6, ".jb-btn-ignore", "Ignore Theirs (master) for this change", " (2 of 2)"],
    ];
    for (const [layer, block, cls, words, ordinal] of want) {
      const b = btn(layer, block, cls);
      const title = b && b.title.split("\\n")[0];
      expect(title === words, "tooltip of " + layer + "/" + block + " " + cls + ": " + JSON.stringify(title) + ", want " + JSON.stringify(words));
      expect(b && b.getAttribute("aria-label") === words + ordinal, "aria-label: " + JSON.stringify(b && b.getAttribute("aria-label")));
    }
    for (const b of document.querySelectorAll(".jb-change-actions button")) {
      const icon = b.querySelector(".codicon");
      const known = icon && /codicon-(arrow-right|arrow-left|close)$/.test(icon.className.trim().split(" ").pop());
      expect(known, "every control is an arrow or ×: " + (icon && icon.className));
      expect(b.textContent.trim() === "", "…and draws no text glyph: " + JSON.stringify(b.textContent));
    }

    // ── computed styles of the classes the decorations actually carry ──
    const bgOf = (pane, cls) => probe(pane, cls).bg;
    expect(bgOf("left", "jb-line-conflict jb-cat-conflict") === TINT.conflict, "conflict tint (red): " + bgOf("left", "jb-line-conflict jb-cat-conflict"));
    expect(bgOf("left", "jb-line-modified jb-cat-same") === TINT.modified && bgOf("right", "jb-line-modified jb-cat-same") === TINT.modified,
      "the same change on both sides: the changed tint (blue), on both sides: " + bgOf("left", "jb-line-modified jb-cat-same"));
    expect(bgOf("left", "jb-line-same") === "rgba(0, 0, 0, 0)" && bgOf("left", "jb-dot-same") === "rgba(0, 0, 0, 0)", "no violet left to paint with: " + bgOf("left", "jb-line-same"));
    expect(bgOf("left", "jb-line-modified jb-cat-yours-only") === TINT.modified, "Yours-only modified tint (blue)");
    expect(bgOf("right", "jb-line-inserted jb-cat-theirs-only") === TINT.inserted, "Theirs-only insertion tint (green)");
    expect(bgOf("result", "jb-line-deleted jb-cat-theirs-only") === TINT.deleted, "Theirs-only deletion tint (grey)");
    const point = probe("result", "jb-point-inserted jb-point jb-cat-theirs-only");
    expect(point.bt === "solid" && point.btw === "1px" && point.btc === POINT.inserted && point.bg === "rgba(0, 0, 0, 0)", "an insertion point is a 1px line in the point colour (the tint, stronger), not a bright wire: " + JSON.stringify(point));
    const ws = probe("left", "jb-line-modified jb-cat-yours-only jb-ws");
    expect(ws.bl === "dotted" && ws.blc === EDGE.modified && ws.bg === TINT.modified, "whitespace-only: tint + dotted edge: " + JSON.stringify(ws));
    const frame = probe("left", "jb-frame jb-frame-conflict jb-edge-top jb-edge-bottom");
    expect(frame.bt === "none" && frame.bb === "none", "outside high contrast, the frame edges draw nothing: " + JSON.stringify(frame));
    // If Monaco painted (it may not, headless), the real overlay agrees.
    const painted = document.querySelector(".view-overlays .jb-cat-same");
    notes.monacoPainted = !!painted;
    if (painted) expect(getComputedStyle(painted).backgroundColor === TINT.modified, "the painted identical line is the changed blue: " + getComputedStyle(painted).backgroundColor);

    // ── no overview ruler and no scrollbar on the Result|gutter seam ──
    const ruler = () => view.result.getModel().getAllDecorations().filter((d) => d.options.overviewRuler);
    const rb = document.querySelectorAll(".jb-pane-body")[1];
    const vbar = rb.querySelector(".scrollbar.vertical");
    const barShown = !!vbar && getComputedStyle(vbar).display !== "none" && getComputedStyle(vbar).visibility !== "hidden" && getComputedStyle(vbar).opacity !== "0";
    expect(ruler().length === 0 && view.result.getOption(W.monaco.editor.EditorOption.overviewRulerLanes) === 0 && !barShown,
      "the Result draws no ruler marks, has no ruler lanes, and no vertical bar on its seam: " + JSON.stringify([ruler().length, barShown, vbar && vbar.className]));

    // ── the ribbons, after the 32 ms overlay timer (no frame needed) ──
    await sleep(60);
    const stage = document.querySelector(".jb-ribbon-stage");
    const count = (cls) => stage.querySelectorAll("path." + cls).length;
    const ribbons = { conflict: count("jb-ribbon-conflict"), same: count("jb-ribbon-same"), modified: count("jb-ribbon-modified"), inserted: count("jb-ribbon-inserted"), deleted: count("jb-ribbon-deleted"), base: count("jb-ribbon-base"), frame: count("jb-ribbon-frame"), trace: count("jb-ribbon-trace"), cap: count("jb-ribbon-cap") };
    expect(JSON.stringify(ribbons) === JSON.stringify({ conflict: 4, same: 0, modified: 6, inserted: 1, deleted: 1, base: 12, frame: 24, trace: 0, cap: 2 }), "ribbons per colour (the same change's in blue, both sides): " + JSON.stringify(ribbons));
    const sameBand = stage.querySelector('path.jb-ribbon-modified[data-block="2"][data-side="left"]');
    expect(sameBand && getComputedStyle(sameBand).fill === TINT.modified, "a band is FILLED with the tint it connects: " + (sameBand && getComputedStyle(sameBand).fill));
    expect(sameBand && sameBand.dataset.state === "pending" && sameBand.dataset.phase === "open" && sameBand.dataset.tone === "modified", "and says what it draws: " + JSON.stringify(sameBand && sameBand.dataset));
    // A band that ends at a point is capped in that point's colour.
    const caps = [...stage.querySelectorAll("path.jb-ribbon-cap")].map((p) => p.dataset.block + ":" + getComputedStyle(p).fill).sort();
    expect(JSON.stringify(caps) === JSON.stringify(["5:" + POINT.inserted, "6:" + POINT.deleted]), "the insertion and the deletion end in their point colour: " + JSON.stringify(caps));
    const base = stage.querySelector('path.jb-ribbon-base[data-block="2"][data-side="left"]');
    expect(base && getComputedStyle(base).fill === "rgb(30, 30, 30)", "…over the editor background, so no gutter border shows through: " + (base && getComputedStyle(base).fill));
    const edge = stage.querySelector("path.jb-ribbon-frame");
    expect(edge && getComputedStyle(edge).stroke === "none", "no frame lines outside high contrast: " + (edge && getComputedStyle(edge).stroke));
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("high contrast draws a solid edge on every pending band, on the band's own first and last rows", { skip }, async () => {
  for (const theme of ["hc-dark", "hc-light"] as const) {
    const v = await runMergePage(CHROME!, MOUNT + `
      const frame = probe("left", "jb-frame jb-frame-conflict jb-edge-top jb-edge-bottom");
      expect(frame.bt === "solid" && frame.btw === "1px" && frame.bb === "solid" && frame.bbw === "1px", "${theme}: a pending band's top and bottom edges: " + JSON.stringify(frame));
      await sleep(60);
      const edge = document.querySelector('.jb-ribbon-stage path.jb-ribbon-frame-conflict[data-edge="bottom"]');
      const cs = edge && getComputedStyle(edge);
      expect(cs && cs.stroke !== "none" && cs.strokeWidth === "1px", "${theme}: the ribbon draws them too: " + (cs && cs.stroke));
      // The bottom edge's centre is half a pixel ABOVE the band's bottom, so it
      // paints the band's last row — the row the pane's border-bottom paints.
      const fill = document.querySelector('.jb-ribbon-stage path.jb-ribbon-conflict[data-block="' + (edge && edge.dataset.block) + '"][data-side="' + (edge && edge.dataset.side) + '"]');
      const lastY = (d) => Number(d.trim().split(/\\s+/).slice(-1)[0]);
      const ringBottom = fill && Math.max(...fill.getAttribute("d").replace(/[MLQZ]/g, " ").trim().split(/\\s+/).map(Number).filter((_, i) => i % 2 === 1));
      expect(edge && fill && Math.abs(lastY(edge.getAttribute("d")) - (ringBottom - 0.5)) < 0.01, "${theme}: bottom edge at the band's bottom − 0.5 (" + (edge && lastY(edge.getAttribute("d"))) + " vs " + ringBottom + ")");
    `, { theme });
    assert.deepEqual(v.fails, [], v.fails.join("\n"));
  }
});

test("a settled change keeps a TRACE: a taken side its muted band and ribbon, a discarded side an outline and no ribbon, the Result muted — each said in words; JetBrains' rules for what is resolved", { skip }, async () => {
  // The owner: "the red conflicts don't show which one you chose and which
  // one got canceled, or if both got merged — some sort of trace with the
  // lines should remain there, not just the gray lines disconnected from the
  // panes". It replaced "resolved = one neutral line in the result".
  const v = await runMergePage(CHROME!, MOUNT + `
    // "Apply non-conflicting changes: All" takes identical AND one-sided changes.
    view.applyAllNonConflicting();
    const by = counts.byCategory;
    expect(by.same.pending === 0 && by["yours-only"].pending === 0 && by["theirs-only"].pending === 0 && by.conflict.pending === 2,
      "every non-conflicting change applied, both conflicts left: " + JSON.stringify(by));
    expect(counts.hasProgress === true, "that is progress");
    const result = view.getResultText().split("\\n");
    expect(result[6] === "s1 = same" && result[8] === "w1 = new" && result[10] === "y1 = yours" && result[12] === "t0 = theirs" && result[14] === "keep7" && result[15] === "    ws1 = base",
      "the result took each change as written: " + JSON.stringify(result));

    // Every side that went in keeps its band, muted, in its pane; the Result
    // keeps a muted band in the colour of what went in; a deletion taken
    // keeps its point line, faint.
    const has = (pane, line, cls) => catDecos(pane).some((d) => (d.startsWith(line + ":") || d.startsWith(line + "-")) && d.includes(cls));
    const want = [
      ["left", 7, "jb-trace jb-trace-modified jb-cat-same"], ["right", 7, "jb-trace jb-trace-modified jb-cat-same"],
      ["left", 9, "jb-trace jb-trace-modified jb-cat-same"], ["right", 9, "jb-trace jb-trace-modified jb-cat-same"],
      ["left", 11, "jb-trace jb-trace-modified jb-cat-yours-only"], ["left", 16, "jb-trace jb-trace-modified jb-cat-yours-only"],
      ["right", 13, "jb-trace jb-trace-inserted jb-cat-theirs-only"], ["right", 15, "jb-done jb-done-deleted jb-point"],
      ["result", 7, "jb-trace jb-trace-modified"], ["result", 9, "jb-trace jb-trace-modified"], ["result", 11, "jb-trace jb-trace-modified"],
      ["result", 13, "jb-trace jb-trace-inserted"], ["result", 15, "jb-done jb-done-deleted jb-point"], ["result", 16, "jb-trace jb-trace-modified"],
    ];
    for (const [pane, line, cls] of want) expect(has(pane, line, cls), pane + " " + line + ": " + cls + " — " + JSON.stringify(catDecos(pane)));
    expect(!["left", "right", "result"].some((p) => catDecos(p).some((d) => /^(7|9|11|13|16):jb-line-/.test(d))), "…and nothing settled still wears an open band");
    expect(!catDecos("result").some((d) => /jb-settled/.test(d)), "no neutral grey lines disconnected from the panes");
    const trace = probe("left", "jb-trace jb-trace-modified jb-cat-yours-only");
    expect(trace.bg === MUTED.modified && trace.bt === "none" && trace.bb === "none", "a trace is the muted tint, no lines: " + JSON.stringify(trace));
    expect(trace.bg !== TINT.modified, "…calmer than the open band (" + TINT.modified + ")");
    expect(probe("left", "jb-frame jb-trace-edge jb-trace-edge-modified jb-edge-top").bt === "none", "its edge draws only in high contrast");

    // In words, where the controls were (a tooltip, an accessible name) and on hover.
    expect(note("a", 4) && note("a", 4).title === "Took Yours (test)" && note("a", 4).getAttribute("aria-label") === "Change 1 of 2: Took Yours (test)",
      "a taken one-sided change says so: " + (note("a", 4) && note("a", 4).getAttribute("aria-label")));
    expect(note("a", 2) && note("b", 2) && note("b", 2).title === "Took the change (the same on both sides)", "the same change: taken on both sides, in words: " + (note("b", 2) && note("b", 2).title));
    expect(hoverOn("result", 11).includes("Took Yours (test)"), "the Result says it on hover: " + JSON.stringify(hoverOn("result", 11)));
    expect(!document.querySelector(".jb-trace-note[data-block='0']"), "an open conflict has controls, not a trace note");

    // Controls: a settled change has none left.
    expect(JSON.stringify(groupsIn(layerA())) === "[0,1]" && JSON.stringify(groupsIn(layerB())) === "[0,1]", "only the conflicts keep controls: " + JSON.stringify([groupsIn(layerA()), groupsIn(layerB())]));

    await sleep(60);
    const stage = document.querySelector(".jb-ribbon-stage");
    const ribbon = (block, side) => stage.querySelector('path.jb-ribbon-trace[data-block="' + block + '"][data-side="' + side + '"]');
    for (const [block, side, tone] of [[2, "left", "modified"], [2, "right", "modified"], [4, "left", "modified"], [5, "right", "inserted"], [6, "right", "deleted"]]) {
      const p = ribbon(block, side);
      expect(p && p.dataset.state === "took" && p.dataset.phase === "resolved" && getComputedStyle(p).fill === MUTED[tone],
        "a taken side's ribbon to the Result stays, muted: " + block + "/" + side + " " + (p && [p.dataset.state, p.dataset.phase, getComputedStyle(p).fill].join(" ")));
    }
    expect(!stage.querySelector('path.jb-ribbon-modified[data-block="2"], path.jb-ribbon-inserted[data-block="5"]'), "…and no open band for them");

    // Take Yours in the first conflict (JetBrains: that side is resolved; the
    // conflict is not until Theirs is dealt with).
    const resultBg = () => probe("result", classesOn("result", 2).split(" ").filter((c) => /^jb-(line|half|trace)/.test(c)).join(" ")).bg;
    const openBg = resultBg();
    expect(openBg === TINT.conflict, "open: the result wears the conflict tint (" + openBg + ")");
    press(document.querySelector('.jb-gutter-a .jb-change-actions[data-block="0"] .jb-btn-accept'));
    expect(has("left", 2, "jb-trace jb-trace-conflict"), "Yours, taken: its band stays, muted");
    expect(has("right", 2, "jb-line-conflict") && !has("right", 2, "jb-half"), "Theirs' half keeps the full tint — it is still to decide");
    expect(has("result", 2, "jb-line-conflict jb-half") && has("result", 2, "jb-done-conflict jb-edge-top"), "the result: the half-done look — the muted tint between two faint lines: " + JSON.stringify(catDecos("result")));
    const halfBg = resultBg();
    expect(halfBg === MUTED.conflict && halfBg !== openBg, "…and it LOOKS different from the open conflict: " + openBg + " → " + halfBg);
    expect(!/jb-inner-/.test(classesOn("result", 2)), "the result holds Yours' text now, so the BASE word ranges are not drawn on it: " + classesOn("result", 2));
    expect(note("a", 0) && note("a", 0).getAttribute("aria-label") === "Conflict 1 of 2: Took Yours (test)", "Yours says it was taken: " + (note("a", 0) && note("a", 0).getAttribute("aria-label")));
    const next = document.querySelector('.jb-gutter-b .jb-change-actions[data-block="0"] .jb-btn-accept');
    expect(next && next.querySelector(".codicon-arrow-left") && !next.querySelector(".codicon-insert"), "Theirs' control stays the same arrow");
    expect(next && next.title === "Add Theirs (master) after Yours (test)", "…and says in words what it now does: " + JSON.stringify(next && next.title));
    expect(next && next.getAttribute("aria-label") === "Add Theirs (master) after Yours (test) (1 of 2)", "…to a screen reader too: " + (next && next.getAttribute("aria-label")));
    const discard = document.querySelector('.jb-gutter-b .jb-change-actions[data-block="0"] .jb-btn-ignore');
    expect(discard && discard.title === "Discard Theirs (master): keep Yours (test) as the result", "its × says what it now does: " + JSON.stringify(discard && discard.title));
    expect(!document.querySelector('.jb-gutter-a .jb-change-actions[data-block="0"]'), "Yours' controls for it are gone");
    await sleep(60);
    const took0 = stage.querySelector('path.jb-ribbon-trace-conflict[data-block="0"][data-side="left"]');
    const open0 = stage.querySelector('path.jb-ribbon-conflict[data-block="0"][data-side="right"]');
    expect(took0 && took0.dataset.phase === "half" && getComputedStyle(took0).fill === MUTED.conflict && open0 && getComputedStyle(open0).fill === TINT.conflict,
      "the taken half's ribbon is muted and meets the muted Result on its own colour; the pending half's is the open band");

    // …then discard Theirs: settled as Yours. Yours keeps its trace, Theirs an outline and no ribbon.
    press(discard);
    expect(has("result", 2, "jb-trace jb-trace-conflict") && !has("result", 2, "jb-half"), "the Result: a muted band in the colour of what went in");
    expect(has("right", 2, "jb-done jb-done-conflict jb-edge-top") && !has("right", 2, "jb-line-conflict") && !has("right", 2, "jb-trace"), "Theirs, discarded: an outline only");
    await sleep(60);
    expect(stage.querySelector('path.jb-ribbon-trace-conflict[data-block="0"][data-side="left"]') && !stage.querySelector('path[data-block="0"][data-side="right"]'),
      "Yours' ribbon stays, Theirs has none");
    expect(note("b", 0) && note("b", 0).getAttribute("aria-label") === "Conflict 1 of 2: Discarded Theirs (master)", "and says so: " + (note("b", 0) && note("b", 0).getAttribute("aria-label")));
    expect(hoverOn("result", 2).includes("Took Yours (test)") && hoverOn("right", 2).includes("Discarded Theirs (master)"), "…on hover too: " + JSON.stringify([hoverOn("result", 2), hoverOn("right", 2)]));

    // Both taken: both keep their bands and ribbons, muted; the Result says "Took both".
    view.undo();
    press(document.querySelector('.jb-gutter-b .jb-change-actions[data-block="0"] .jb-btn-accept'));
    expect(counts.byCategory.conflict.pending === 1 && has("left", 2, "jb-trace-conflict") && has("right", 2, "jb-trace-conflict") && has("result", 2, "jb-trace-conflict"),
      "both sides and the Result keep the muted trace: " + JSON.stringify([catDecos("left"), catDecos("right")].map((d) => d.filter((x) => x.startsWith("2:")))));
    await sleep(60);
    expect(stage.querySelectorAll('path.jb-ribbon-trace-conflict[data-block="0"]').length === 2, "…and both ribbons");
    expect(hoverOn("result", 2).includes("Took both") && note("b", 0).title === "Took Theirs (master)", "Took both, in words: " + JSON.stringify(hoverOn("result", 2)));
    view.undo();
    view.undo();

    // Ignoring Yours instead leaves the result as it was, and says so.
    press(document.querySelector('.jb-gutter-a .jb-change-actions[data-block="0"] .jb-btn-ignore'));
    const discard2 = document.querySelector('.jb-gutter-b .jb-change-actions[data-block="0"] .jb-btn-ignore');
    const accept2 = document.querySelector('.jb-gutter-b .jb-change-actions[data-block="0"] .jb-btn-accept');
    expect(accept2 && accept2.title.startsWith("Accept Theirs (master) for this conflict"), "with Yours ignored, Theirs' arrow still ACCEPTS: " + JSON.stringify(accept2 && accept2.title));
    expect(discard2 && discard2.title === "Discard Theirs (master) too: the result keeps what it has", "…and its × discards it too: " + JSON.stringify(discard2 && discard2.title));
    expect(has("result", 2, "jb-half") && has("left", 2, "jb-done jb-done-conflict"), "…the result has the half-done look, and Yours an outline");
    await sleep(60);
    expect(!stage.querySelector('path[data-block="0"][data-side="left"]'), "an ignored side draws no ribbon");
    view.undo();

    // The toolbar wand writes both sides' edits for the resolvable conflict.
    const expected = view.model.blocks[1].resolvedText;
    view.resolveSimpleConflicts();
    const lines = view.getResultText().split("\\n");
    expect(lines.slice(3, 5).join("\\n") === expected && expected === "r1 = yours\\nr2 = theirs", "the wand applied both edits: " + JSON.stringify(lines.slice(3, 5)));
    expect(has("result", 4, "jb-trace-conflict") && has("left", 4, "jb-trace-conflict") && has("right", 4, "jb-trace-conflict"), "…and the conflict is settled, both sides taken");
    expect(counts.byCategory.conflict.pending === 1 && counts.resolvableConflictsPending === 0, "one conflict left, none resolvable: " + JSON.stringify(counts.byCategory.conflict));
    view.undo();
    expect(counts.resolvableConflictsPending === 1, "undo brings the resolvable conflict back");
    expect(view.hasSimpleConflicts() === true, "…and the toolbar wand has work again");

    // JetBrains (MergeConflictModel.replaceChange): taking one side of a
    // conflict whose other side has NO lines in it resolves the conflict —
    // that side is set aside.
    view.render(W.payload({ base: "a\\nb\\nc", ours: "a\\nB\\nc", theirs: "a\\nc", result: "a\\nb\\nc" }));
    const conflict = view.model.blocks[0];
    expect(W.category(conflict) === "conflict", "modified in Yours, deleted in Theirs: a conflict (" + W.category(conflict) + ")");
    view.acceptSide(conflict, "left", "auto");
    expect(counts.pending === 0 && view.getResultText() === "a\\nB\\nc", "accepting Yours resolves it — there is nothing of Theirs to add after it (" + counts.pending + " pending)");
    expect(view.sideFate(conflict, "right") === "discarded", "Theirs' deletion is the side set aside (" + view.sideFate(conflict, "right") + ")");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("one side's 'Apply non-conflicting' takes the identical changes too, in that side's whitespace; controls work from the keyboard", { skip }, async () => {
  const v = await runMergePage(CHROME!, MOUNT + `
    view.applyNonConflictingSide("right");
    const by = counts.byCategory;
    expect(by.same.pending === 0 && by["theirs-only"].pending === 0 && by["yours-only"].pending === 2 && by.conflict.pending === 2,
      "Theirs: its own changes and both identical ones: " + JSON.stringify(by));
    const lines = view.getResultText().split("\\n");
    expect(lines[8] === "w1 = new   ", "the identical-except-whitespace change was taken in THEIRS' whitespace: " + JSON.stringify(lines[8]));
    view.undo();
    view.applyNonConflictingSide("left");
    expect(view.getResultText().split("\\n")[8] === "w1 = new", "…and in Yours' from the Yours button: " + JSON.stringify(view.getResultText().split("\\n")[8]));
    view.undo();

    // Enter / Space on a focused control fire a click with no press first.
    const accept = document.querySelector('.jb-gutter-a .jb-change-actions[data-block="4"] .jb-btn-accept');
    accept.focus();
    accept.click();
    expect(view.getResultText().split("\\n")[10] === "y1 = yours", "a keyboard click accepts: " + view.getResultText().split("\\n")[10]);
    // The identical change: either side's arrow takes it, either side's ×
    // settles it on what the result has (JetBrains: a non-conflicting change
    // is resolved by one side).
    const theirsSame = document.querySelector('.jb-gutter-b .jb-change-actions[data-block="2"] .jb-btn-accept');
    theirsSame.focus();
    theirsSame.click();
    expect(counts.byCategory.same.pending === 1 && view.getResultText().split("\\n")[6] === "s1 = same", "Theirs' arrow took the identical change: " + view.getResultText().split("\\n")[6]);
    expect(!document.querySelector('.jb-change-actions[data-block="2"]'), "…and both sides' controls for it are gone");
    const ignore = document.querySelector('.jb-gutter-a .jb-change-actions[data-block="3"] .jb-btn-ignore');
    ignore.focus();
    ignore.click();
    expect(counts.byCategory.same.pending === 0 && view.getResultText().split("\\n")[8] === "w1 = base", "× settles the other one on the text the result has");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("typing is progress, and a hand edit takes a conflict out of the wand's reach", { skip }, async () => {
  const v = await runMergePage(CHROME!, MOUNT + `
    expect(counts.hasProgress === false && counts.resolvableConflictsPending === 1, "fresh");
    // Type into the resolvable conflict's region (result line 4).
    view.result.setPosition({ lineNumber: 4, column: 1 });
    view.result.trigger("keyboard", "type", { text: "// " });
    await sleep(200); // the debounced re-align (120 ms) re-counts
    expect(counts.hasProgress === true, "typing counts as progress (the shell asks before a whitespace change drops it)");
    expect(counts.resolvableConflictsPending === 0 && !view.hasSimpleConflicts(),
      "the wand will not overwrite a hand edit: " + counts.resolvableConflictsPending);
    view.resolveSimpleConflicts();
    expect(view.getResultText().split("\\n")[3] === "// r1 = base", "resolveSimpleConflicts leaves the edited region alone: " + view.getResultText().split("\\n")[3]);
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("the legend explains the COLOURS in words — a solid dot, the name, how many are left, what it asks — and jumps to them", { skip }, async () => {
  const v = await runMergePage(CHROME!, MOUNT + `
    view.attachLegend(document.getElementById("slot"));
    const legend = document.querySelector("#slot .jb-legend");
    const chip = (item) => document.querySelector('#slot .jb-legend-chip[data-category="' + item + '"]');
    const text = (item) => chip(item) && chip(item).textContent.replace(/\\s+/g, " ").trim();
    expect(text("conflict") === "Conflicts2you choose", "conflict item: " + JSON.stringify(text("conflict")));
    expect(text("same") === "Same on both sides2either arrow takes it", "identical item: " + JSON.stringify(text("same")));
    // A one-sided change is blue, green or grey by what it did: the item names
    // each colour, so the legend explains what the panes show.
    expect(text("one-sided") === "ChangedAddedRemovedon one side4safe to take", "one-sided item: " + JSON.stringify(text("one-sided")));
    const shown = (el) => getComputedStyle(el).display !== "none";
    const visible = [...legend.children].filter((e) => !e.classList.contains("jb-legend-pop") && shown(e));
    const line = visible.map((e) => e.classList.contains("jb-legend-help") ? "?" : [...e.querySelectorAll(":scope > span, :scope > .jb-legend-kind")].map((s) => s.textContent.trim()).filter(Boolean).join(" ") || e.textContent.trim()).join(" ");
    expect(line === "Conflicts 2 you choose · Changed Added Removed on one side 4 safe to take · Same on both sides 2 either arrow takes it ?", "the legend reads as words: " + JSON.stringify(line));
    expect(!/[≠≈‹›✨✓=]/.test(legend.textContent), "no symbols of our own anywhere in it: " + JSON.stringify(legend.textContent));
    // Solid round dots, one per colour, in the colours the panes use — no box
    // that reads as a checkbox waiting for a tick.
    const dots = (item) => [...chip(item).querySelectorAll(".jb-legend-dot")].map((d) => { const cs = getComputedStyle(d); return cs.backgroundColor + "|" + cs.borderRadius + "|" + cs.borderTopStyle; });
    expect(JSON.stringify(dots("conflict")) === JSON.stringify([EDGE.conflict + "|50%|none"]), "a red dot for conflicts: " + JSON.stringify(dots("conflict")));
    expect(dots("same").length === 0, "the same change on both sides has no colour of its own, so no dot: " + JSON.stringify(dots("same")));
    expect(/Coloured on both sides/.test(chip("same").title) && /either arrow takes it/.test(chip("same").title), "its tooltip says how it looks and what either arrow does: " + chip("same").title);
    expect(JSON.stringify(dots("one-sided")) === JSON.stringify([EDGE.modified, EDGE.inserted, EDGE.deleted].map((c) => c + "|50%|none")), "blue, green, grey dots: " + JSON.stringify(dots("one-sided")));
    expect(!legend.querySelector(".jb-legend-swatch"), "no square swatches");
    expect(chip("conflict").getAttribute("aria-label") === "Conflicts: 2 conflicts left; 1 can be resolved automatically (Resolve simple conflicts). Both sides changed these lines, differently: you choose. Go to the next one.", "item name: " + chip("conflict").getAttribute("aria-label"));
    expect(/2 in Yours, 2 in Theirs/.test(chip("one-sided").title), "the one-sided item says how many per side: " + chip("one-sided").title);

    // An item jumps to the next pending change of its colours — both sides'
    // one-sided changes, in document order.
    const lines = [];
    for (let i = 0; i < 5; i++) { chip("one-sided").click(); lines.push(view.result.getPosition().lineNumber); }
    expect(JSON.stringify(lines) === "[11,13,14,16,11]", "one side only → 11, 13, 14, 16, and round again: " + JSON.stringify(lines));

    // One side of a conflict in: the conflict item says so, in words.
    press(document.querySelector('.jb-gutter-a .jb-change-actions[data-block="0"] .jb-btn-accept'));
    expect(text("conflict") === "Conflicts21 with one side in, the other to decide", "half done, in words: " + JSON.stringify(text("conflict")));
    view.resolveSimpleConflicts();
    expect(text("conflict") === "Conflicts1Yours taken, Theirs to decide", "the one left: " + JSON.stringify(text("conflict")));
    expect(/Yours taken, Theirs to decide/.test(chip("conflict").getAttribute("aria-label")), "…to a screen reader too");
    view.undo();
    view.undo();

    // Never a count of nothing: "(0 resolvable)", "0 can be resolved".
    const words = () => [...legend.querySelectorAll(".jb-legend-chip")].map((c) => c.textContent + " " + c.title + " " + c.getAttribute("aria-label")).join(" | ");
    const zero = () => /\\b0 (can be resolved|resolvable)|\\b0 conflicts? (can|resolv)|no conflicts? can be resolved/i.test(words());
    expect(!zero(), "fresh: no count of nothing: " + words());
    view.applyAllNonConflicting();
    expect(text("same") === "Same on both sides0" && chip("same").disabled, "an item with nothing left reads 0, asks nothing, and cannot be clicked: " + JSON.stringify(text("same")));
    expect(/can be resolved automatically/.test(chip("conflict").title), "the conflict item says the wand has work: " + chip("conflict").title);
    view.resolveSimpleConflicts();
    expect(!/automatically/.test(chip("conflict").title), "…and stops saying so when it has none: " + chip("conflict").title);
    expect(!zero(), "…never saying it has none: " + words());
    press(document.querySelector('.jb-gutter-a .jb-change-actions[data-block="0"] .jb-btn-accept'));
    press(document.querySelector('.jb-gutter-b .jb-change-actions[data-block="0"] .jb-btn-ignore'));
    expect(!zero(), "…not even with every conflict settled: " + words());

    // The key explains every colour and line, in words.
    const help = document.querySelector("#slot .jb-legend-help");
    help.click();
    const pop = document.querySelector("#slot .jb-legend-pop");
    expect(!pop.hidden && help.getAttribute("aria-expanded") === "true", "the key opens");
    const key = pop.textContent;
    for (const phrase of ["Conflict (red)", "you choose", "Changed, Added, Removed (blue, green, grey)", "Coloured on both sides: the same change on both sides — either arrow takes it", "whitespace", "added or removed at that point", "one side in, the other still to decide", "the side you took", "the side you discarded"]) {
      expect(key.includes(phrase), "the key explains " + phrase + ": " + key);
    }
    expect(!/[≠≈‹›✨✓]/.test(key) && !/[Dd]ashed/.test(key), "…with no symbols of our own and no dashed style: " + key);
    expect(!/[Vv]iolet|grey line/.test(key), "…and no violet, no disconnected grey line: " + key);
    expect(getComputedStyle(pop).display !== "none", "…and is on screen, not just un-hidden: " + getComputedStyle(pop).display);
    help.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    // The popover and the chips set their own display, which beats the hidden
    // attribute unless a [hidden] rule says otherwise — so what is checked is
    // what renders.
    expect(pop.hidden && getComputedStyle(pop).display === "none", "Escape closes it (display " + getComputedStyle(pop).display + ")");

    // The legend survives a rebuild (a whitespace change) and keeps counting.
    view.setRenderOptions({ whitespace: "none" });
    expect(document.querySelectorAll("#slot .jb-legend").length === 1 && text("conflict").startsWith("Conflicts3"), "after a re-diff the same legend shows the new counts: " + text("conflict"));
    // A category with no changes at all has no chip on screen, and no dot beside it.
    view.render(W.payload({ base: "a\\nb\\nc", ours: "a\\nX\\nc", theirs: "a\\nY\\nc", result: "a\\nb\\nc" }));
    expect(shown(chip("conflict")) && !shown(chip("same")) && !shown(chip("one-sided")),
      "only the conflict item shows: " + ["conflict", "same", "one-sided"].map((c) => c + "=" + getComputedStyle(chip(c)).display).join(" "));
    expect([...legend.querySelectorAll(".jb-legend-sep")].every((s) => !shown(s)), "…and no separator dot hangs beside it");
    view.dispose();
    expect(!document.querySelector("#slot .jb-legend"), "dispose() takes the legend down");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("granularity only re-decorates and keeps every accept; a whitespace change re-diffs from the baseline (D7)", { skip }, async () => {
  const v = await runMergePage(CHROME!, MOUNT + `
    const yours = view.model.blocks[4];
    view.acceptSide(yours, "left", "auto");
    const before = view.getResultText();
    expect(before.includes("y1 = yours") && counts.hasProgress === true && view.canUndo(), "an accept is progress");

    // Word → line granularity: the SAME work, the same history.
    view.setRenderOptions({ showInner: false });
    expect(view.getResultText() === before, "the result text is kept");
    expect(counts.hasProgress === true && counts.byCategory["yours-only"].pending === 1, "the accept is kept: " + JSON.stringify(counts.byCategory["yours-only"]));
    expect(view.canUndo() && view.getHistory().undo.length === 1, "and so is the history: " + JSON.stringify(view.getHistory()));
    expect(!/jb-inner-/.test(classesOn("left", 2)), "word tints are gone: " + classesOn("left", 2));
    expect(/jb-trace-modified/.test(classesOn("result", 11)) && /jb-trace-modified/.test(classesOn("left", 11)) && !/jb-line-/.test(classesOn("left", 11)), "the accepted change is still settled, its trace kept: " + classesOn("result", 11));
    view.setRenderOptions({ showInner: true });
    expect(/jb-inner-conflict/.test(classesOn("left", 2)) && view.getResultText() === before, "and back, still with the work");

    // Whitespace re-diffs (the shell confirms first, from hasProgress).
    view.setRenderOptions({ whitespace: "none" });
    expect(counts.hasProgress === false && !view.canUndo() && view.getResultText() === W.FIXTURE.base, "a whitespace change starts over from the baseline");
    expect(counts.byCategory.conflict.total === 3, "and re-classifies: the identical-except-whitespace change is a conflict under 'none' (" + counts.byCategory.conflict.total + ")");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("the overview strip: at the view's right edge, never on a seam; opaque marks in the legend's colours; nothing while the Result fits", { skip }, async () => {
  // The critic: the Result's own ruler and scrollbar sat exactly on the
  // Result|Theirs seam and cut every band there — in a dense file one solid
  // bar the height of the pane, in blended colours no legend names.
  const v = await runMergePage(CHROME!, MOUNT + `
    const map = view.overview;
    const strip = document.querySelector(".jb-map");
    const grid = document.querySelector(".jb-merge-grid");
    const bodies = [...grid.querySelectorAll(".jb-pane-body")];
    expect(!!map && !!strip, "the view has one overview strip");
    const s = strip.getBoundingClientRect(), g = grid.getBoundingClientRect(), theirs = bodies[2].getBoundingClientRect();
    expect(Math.abs(s.right - g.right) < 0.5 && s.left >= theirs.right - 0.5, "it is the view's right edge, beyond Theirs: " + JSON.stringify([s.left, s.right, theirs.right, g.right]));
    const gB = grid.querySelector(".jb-gutter-b").getBoundingClientRect();
    expect(Math.abs(bodies[1].getBoundingClientRect().right - gB.left) < 0.5, "nothing between the Result and its gutter");
    expect(map.drawn.length === 0 && strip.classList.contains("is-empty"), "600px of pane, 17 lines: no marks (" + map.drawn.length + ")");
    host.style.height = "140px";
    view.layout();
    await sleep(80);
    map.draw();
    const m = map.drawn;
    expect(m.length === 8 && !strip.classList.contains("is-empty"), "a pane shorter than the document: every pending change has a mark (" + m.length + ")");
    expect(m.every((x) => ["conflict", "modified", "inserted", "deleted"].includes(x.tone)), "…in the paint's colours — no violet: " + JSON.stringify(m.map((x) => x.tone)));
    expect(m.filter((x) => x.block === 2 || x.block === 3).every((x) => x.tone === "modified"), "the same change on both sides is marked by what it did");
    // Opaque: the canvas pixel under a conflict mark is the conflict's edge colour, unblended.
    const canvas = strip.querySelector("canvas");
    const dpr = window.devicePixelRatio || 1;
    const c = m.find((x) => x.tone === "conflict");
    const px = canvas.getContext("2d").getImageData(Math.floor(canvas.width / 2), Math.floor((c.top + c.height / 2) * dpr), 1, 1).data;
    expect(px[3] === 255 && px[0] === 240 && px[1] === 104 && px[2] === 106, "a conflict mark is the legend's own red, opaque: " + [...px].join(","));
    view.applyAllNonConflicting();
    map.draw();
    expect(map.drawn.length === 2, "a settled change leaves the strip: " + map.drawn.length);
    host.style.height = "600px";
    view.layout();
    await sleep(80);
    map.draw();
    expect(map.drawn.length === 0, "and when it fits again, the marks go (" + map.drawn.length + ")");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("auto-apply opens at a baseline: no undo entry, no progress, and Reset comes back to it", { skip }, async () => {
  const v = await runMergePage(CHROME!, `
    const W = gsMerge;
    let counts = null;
    const view = new W.MergeView(host);
    view.onCountsChanged = (c) => { counts = c; };
    view.render(W.payload(), { autoApplyNonConflicting: true });
    expect(counts.pending === 3 && counts.conflictsPending === 3, "only the conflicts are left (" + counts.pending + " pending)");
    expect(counts.hasProgress === false, "the auto-applied state is the baseline, not progress");
    expect(!view.canUndo() && view.getHistory().undo.length === 0, "and no undo entry");
    const baseline = view.getResultText();
    expect(baseline.includes("y1 = yours") && baseline.includes("t0 = theirs"), "the non-conflicting changes are in");

    view.acceptSide(view.model.blocks[0], "left", "auto");
    expect(counts.hasProgress === true, "an accept on top is progress");
    view.undo();
    expect(counts.hasProgress === false && view.getResultText() === baseline, "undoing it is back at the baseline");

    view.acceptSide(view.model.blocks[0], "right", "auto");
    view.reset();
    expect(view.getResultText() === baseline && counts.hasProgress === false && counts.pending === 3, "Reset returns to the AUTO-APPLIED baseline, not to base");
    expect(view.canUndo(), "Reset itself is undoable");

    // The payload's setting is used when render() gets none; render()'s wins.
    view.render(W.payload({ autoApplyNonConflicting: true }));
    expect(counts.pending === 3, "payload.autoApplyNonConflicting is honoured");
    view.render(W.payload({ autoApplyNonConflicting: true }), { autoApplyNonConflicting: false });
    expect(counts.pending === 8 && view.getResultText() === W.FIXTURE.base, "render()'s init overrides it (" + counts.pending + ")");
    view.render(W.payload());
    expect(counts.pending === 8, "and it is off by default");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("line endings: the merge runs on normalised text, writes Yours' ending back, and says when the sides differ", { skip }, async () => {
  const v = await runMergePage(CHROME!, `
    const W = gsMerge;
    const seen = [];
    const view = new W.MergeView(host);
    view.onEolMismatch = (info) => seen.push(info === undefined ? "none" : info);
    const crlf = (s) => s.replace(/\\n/g, "\\r\\n");
    view.render(W.payload({ ours: crlf(W.FIXTURE.ours), base: W.FIXTURE.base }));
    expect(view.model.blocks.length === 8, "Yours' CRLF is not a whole-file conflict: " + view.model.blocks.length + " blocks");
    expect(JSON.stringify(seen[seen.length - 1]) === JSON.stringify({ yours: "CRLF", theirs: "LF", result: "CRLF" }), "the mismatch is reported: " + JSON.stringify(seen));
    view.applyAllNonConflicting();
    const text = view.getResultText();
    expect(text.includes("\\r\\n") && !/[^\\r]\\n/.test(text), "the result is written with Yours' CRLF throughout");
    view.render(W.payload());
    expect(seen[seen.length - 1] === "none", "a later build with agreeing sides clears it: " + JSON.stringify(seen));
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("the ribbons and controls repaint with NO animation frame at all (occluded window, Windows CI)", { skip }, async () => {
  // macOS headless Chrome happens to service frames; the Windows runner and an
  // occluded window serve none. Take frames away outright, so a repaint that
  // waits on requestAnimationFrame alone is caught here, on every machine.
  const v = await runMergePage(CHROME!, `
    window.requestAnimationFrame = () => 0;
    window.cancelAnimationFrame = () => {};
    const view = mountView(gsMerge.payload());
    await sleep(60);
    const stage = document.querySelector(".jb-ribbon-stage");
    const bands = stage.querySelectorAll("path.jb-ribbon").length;
    expect(bands > 0, "the bands drew on the 32 ms timer (" + bands + " paths)");
    // A scroll repositions the gutter controls through the same scheduler.
    const before = document.querySelector('.jb-gutter-a .jb-change-actions[data-block="4"]').style.top;
    view.left.setScrollTop(40);
    view.result.setScrollTop(40);
    view.right.setScrollTop(40);
    await sleep(60);
    const moved = document.querySelector('.jb-gutter-a .jb-change-actions[data-block="4"]');
    expect(view.left.getScrollTop() === 40, "the panes did scroll (" + view.left.getScrollTop() + ")");
    expect(moved && moved.style.top !== before, "the controls followed the scroll without a frame (" + before + " → " + (moved && moved.style.top) + ")");
  `, { css: "#host{height:220px}" });
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("layout() re-measures the editors now — the desktop's resize nudge needs it", { skip }, async () => {
  const v = await runMergePage(CHROME!, `
    const view = mountView(gsMerge.payload());
    const before = view.result.getLayoutInfo().width;
    host.style.width = "1000px";
    view.layout();
    const after = view.result.getLayoutInfo().width;
    expect(after < before - 100, "the result pane was re-measured synchronously (" + before + " → " + after + ")");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("the pane grid is one definition: 28px header, 64px gutters, ribbons on the editors, icons inside their strip", { skip }, async () => {
  const v = await runMergePage(CHROME!, `
    const view = mountView(gsMerge.payload());
    const grid = document.querySelector(".jb-merge-grid");
    const cs = getComputedStyle(grid);
    const cols = cs.gridTemplateColumns.split(" ");
    expect(cols[1] === "64px" && cols[3] === "64px", "64px gutters: " + cs.gridTemplateColumns);
    expect(cs.gridTemplateRows.split(" ")[0] === "28px", "a 28px header row: " + cs.gridTemplateRows);
    const r = (el) => el.getBoundingClientRect();
    const title = r(document.querySelector(".jb-pane-title"));
    const body = r(document.querySelector(".jb-pane-body"));
    const stage = r(document.querySelector(".jb-ribbon-stage"));
    expect(title.height === 28, "the title fills the row exactly: " + title.height);
    expect(Math.abs(body.top - stage.top) < 0.5, "the ribbon stage starts where the editors do (body " + body.top + ", stage " + stage.top + ")");
    const resultTitle = document.querySelector(".jb-title-result");
    expect(getComputedStyle(resultTitle).justifyContent === "center", "the result title is centred");
    const gutterB = r(document.querySelector(".jb-gutter-b"));
    for (const g of document.querySelectorAll(".jb-gutter-b .jb-change-actions")) {
      const a = r(g);
      expect(a.left >= gutterB.left - 0.5 && a.right <= gutterB.right + 0.5, "the action row stays inside its gutter (" + a.left + "–" + a.right + " in " + gutterB.left + "–" + gutterB.right + ")");
    }
    // The 2-way diff grid comes from the same file.
    const diff = document.createElement("div");
    diff.className = "jb-diff-grid";
    diff.style.cssText = "position:absolute;width:900px;height:300px;top:0;left:0";
    document.body.appendChild(diff);
    const dcs = getComputedStyle(diff);
    expect(dcs.gridTemplateColumns.split(" ")[1] === "44px" && dcs.gridTemplateRows.split(" ")[0] === "28px", "diff grid: " + dcs.gridTemplateColumns + " / " + dcs.gridTemplateRows);
    diff.remove();
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

/**
 * What an accept WRITES, at the edges of the file. The result is lines joined
 * by "\n", so the block that owns the end of the document owns the final
 * break, a single blank line is a line, and "after the last line" is a place.
 * Each case here wrote the wrong text before (a kept final newline, a dropped
 * blank line, an insertion above the last line) — silently, into the file the
 * user saves.
 */
test("accepts write exactly the side's lines at the start and end of the file", { skip }, async () => {
  const v = await runMergePage(CHROME!, `
    const W = gsMerge;
    const view = new W.MergeView(host);
    const show = (s) => JSON.stringify(s);
    const accept = (base, ours, theirs, side, want, init) => {
      view.render(W.payload({ base, ours, theirs, result: base }), init);
      if (side === "left") view.acceptAllLeft();
      else if (side === "right") view.acceptAllRight();
      const got = view.getResultText();
      expect(got === want, show({ base, ours, theirs, side }) + ": got " + show(got) + ", want " + show(want));
    };
    // Removing the final newline (Theirs) — the break used to stay behind.
    accept("a\\nb\\n", "a\\nb\\n", "a\\nb", "right", "a\\nb");
    // Deleting the last line of an unterminated file left an empty line.
    accept("a\\nb\\nc", "a\\nb", "a\\nb\\nc", "left", "a\\nb");
    // One blank line inserted at the top was written as nothing.
    accept("a\\nb", "a\\nb", "\\na\\nb", "right", "\\na\\nb");
    // A line added after an unterminated last line landed ABOVE it.
    accept("y\\nc", "y\\nc\\na", "x\\ny\\nc", "left", "y\\nc\\na");
    // A conflict that owns the final empty line: each side, exactly.
    accept("b\\ne\\nc\\n", "b\\ne\\nc\\nb\\n", "b\\ne\\nd", "left", "b\\ne\\nc\\nb\\n");
    accept("b\\ne\\nc\\n", "b\\ne\\nc\\nb\\n", "b\\ne\\nd", "right", "b\\ne\\nd");
    // The auto-applied baseline is written the same way.
    accept("e\\nd\\n", "e\\ny", "e\\nd\\n", "none", "e\\ny", { autoApplyNonConflicting: true });
    // Append at the end: Yours, then Theirs after it, line for line.
    view.render(W.payload({ base: "a\\nb\\n", ours: "a\\nX\\n", theirs: "a\\nY", result: "a\\nb\\n" }));
    const block = view.model.blocks[0];
    view.acceptSide(block, "left", "auto");
    view.acceptSide(block, "right", "auto");
    expect(view.getResultText() === "a\\nX\\n\\nY", "append after an accept that owns the end: " + show(view.getResultText()));
    // A neighbour ending where an insertion lands keeps its own extent.
    view.render(W.payload({ base: "a\\nb\\n", ours: "a\\nB\\n", theirs: "a\\nb\\n\\nx", result: "a\\nb\\n" }));
    view.acceptSide(view.model.blocks[1], "right", "auto");
    view.acceptSide(view.model.blocks[0], "left", "auto");
    expect(view.getResultText() === "a\\nB\\n\\nx", "both changes, neither overwriting the other: " + show(view.getResultText()));

    // And a seeded sweep: Accept Yours / Theirs everywhere reproduces that
    // side byte for byte, in every whitespace mode; undo returns to base.
    let seed = 20260923;
    const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const POOL = ["a", "b", "c", "", "a ", " b", "x"];
    const mutate = (lines) => {
      const out = [];
      for (const l of lines) {
        const r = rnd();
        if (r < 0.15) continue;
        if (r < 0.3) { out.push(pick(POOL)); continue; }
        if (r < 0.4) { out.push(pick(POOL)); out.push(l); continue; }
        out.push(l);
      }
      if (rnd() < 0.25) out.push(pick(POOL));
      if (rnd() < 0.1) out.unshift(pick(POOL));
      return out;
    };
    const doc = (lines) => lines.join("\\n") + (lines.length && rnd() < 0.5 ? "\\n" : "");
    let wrong = 0;
    for (let i = 0; i < 80 && wrong < 3; i++) {
      const baseL = Array.from({ length: Math.floor(rnd() * 6) }, () => pick(POOL));
      const base = doc(baseL), ours = doc(mutate(baseL)), theirs = doc(mutate(baseL));
      for (const mode of ["none", "trailing", "all"]) {
        view.setRenderOptions({ whitespace: mode });
        view.render(W.payload({ base, ours, theirs, result: base }));
        view.acceptAllLeft();
        if (view.getResultText() !== ours) { wrong++; expect(false, mode + " yours " + show({ base, ours, theirs }) + " got " + show(view.getResultText())); }
        view.undo();
        if (view.getResultText() !== base) { wrong++; expect(false, mode + " undo " + show({ base, ours, theirs }) + " got " + show(view.getResultText())); }
        view.acceptAllRight();
        if (view.getResultText() !== theirs) { wrong++; expect(false, mode + " theirs " + show({ base, ours, theirs }) + " got " + show(view.getResultText())); }
      }
    }
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});
