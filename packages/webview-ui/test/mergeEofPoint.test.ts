import { test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, runMergePage } from "./fixtures/mergeViewPage";

/**
 * An insertion point AFTER an unterminated last line — a side that appends a
 * line to a file whose last line has no break — lives at line lineCount+1 of
 * the result. Monaco clamps that line to the last one, so the marker and the
 * ribbon's end were drawn at the TOP of the last line: the preview said "it
 * goes above `b`" while the accept (correctly, since P1's review) writes it
 * after. They now sit on the last line's BOTTOM rows (the `jb-point-after`
 * variant, and the same rows for the ribbon's end — mergePointPx: 1 CSS px, 2
 * in high contrast), and the ribbon's end is capped in the point line's own
 * colour, so no bright wire meets a dull strip (the critic).
 */

const CHROME = findChrome();
const skip = !CHROME && "no Chrome on this machine";

const EOF_APPEND = `
  const W = gsMerge;
  const view = mountView(W.payload({
    base: "a\\nb", ours: "a\\nb\\nc", theirs: "a\\nb\\nc", result: "a\\nb",
    oursLabel: "Yours", theirsLabel: "Theirs",
  }));
  const r = view.result;
  const lh = r.getOption(W.monaco.editor.EditorOption.lineHeight);
  const bottomOfLast = r.getTopForLineNumber(2) + lh - r.getScrollTop();
  notes.bottomOfLast = bottomOfLast;
`;

test("the result's marker for an insertion after an unterminated last line is on that line's bottom edge", { skip }, async () => {
  const v = await runMergePage(CHROME!, EOF_APPEND + `
    const decos = r.getModel().getAllDecorations().filter((d) => /jb-point/.test(d.options.className || ""));
    notes.decos = decos.map((d) => d.range.startLineNumber + ":" + d.options.className);
    expect(decos.length === 1, "one marker for the one insertion point (" + decos.length + ")");
    const d = decos[0];
    expect(d && d.range.startLineNumber === 2, "it decorates the last line");
    expect(d && /jb-point-after/.test(d.options.className), "…as the AFTER variant: " + (d && d.options.className));
    // Computed, never the class name alone.
    const body = document.querySelectorAll(".jb-pane-body")[1];
    const probe = document.createElement("div");
    probe.className = d ? d.options.className : "";
    probe.style.cssText = "position:absolute;left:0;top:0;width:40px;height:18px";
    body.appendChild(probe);
    const cs = getComputedStyle(probe);
    notes.style = [cs.borderTopWidth, cs.borderBottomStyle, cs.borderBottomWidth, cs.boxSizing];
    expect(cs.borderTopWidth === "0px", "no line on the top edge (" + cs.borderTopWidth + ")");
    expect(cs.borderBottomStyle === "solid" && cs.borderBottomWidth === "1px" && cs.boxSizing === "border-box", "the 1px point line is on the bottom row, inside the line (" + notes.style.join(" ") + ")");
    notes.lineColour = cs.borderBottomColor;
    probe.remove();
    // In high contrast every edge is 2px of the edge colour.
    document.body.className = "vscode-high-contrast";
    body.appendChild(probe);
    const hc = getComputedStyle(probe);
    expect(hc.borderBottomWidth === "2px", "high contrast: 2px (" + hc.borderBottomWidth + ")");
    probe.remove();
  `);
  assert.deepEqual(v.fails, [], JSON.stringify(v.notes));
});

test("the ribbon end sits on the last line's bottom rows, not on top of it", { skip }, async () => {
  const v = await runMergePage(CHROME!, EOF_APPEND + `
    const [top, bottom] = W.spanY(r, { start: 3, endExclusive: 3 }, lh);
    notes.span = [top, bottom];
    expect(Math.abs(top - bottomOfLast) < 0.5 && top === bottom, "the point is the last line's bottom edge");
    await sleep(80);
    // The ribbon's end at the result is the marker's row: [bottom - 1, bottom].
    // (The same change on both sides is painted by what it did: green, added.)
    const ends = (sel) => {
      const path = document.querySelector('.jb-ribbon-stage path' + sel + '[data-side="left"]');
      const pts = path ? path.getAttribute("d").replace(/[MLQZ]/g, " ").trim().split(/\\s+/).map(Number) : [];
      const xy = []; for (let i = 0; i + 1 < pts.length; i += 2) xy.push([pts[i], pts[i + 1]]);
      const xMax = Math.max(...xy.map(([x]) => x));
      return { path, ys: xy.filter(([x]) => x === xMax).map(([, y]) => y) };
    };
    const band = ends(".jb-ribbon-inserted");
    const stageTop = document.querySelector(".jb-ribbon-stage").getBoundingClientRect().top;
    const editorTop = r.getContainerDomNode().getBoundingClientRect().top;
    notes.end = band.ys;
    const want = [editorTop + bottomOfLast - 1 - stageTop, editorTop + bottomOfLast - stageTop];
    const on = (ys) => ys.length === 2 && Math.abs(Math.min(...ys) - want[0]) < 0.01 && Math.abs(Math.max(...ys) - want[1]) < 0.01;
    expect(on(band.ys), "the ribbon ends on the last line's bottom row (" + JSON.stringify(band.ys) + " vs " + JSON.stringify(want) + ")");
    // …capped in the point line's own colour, on the same row.
    const cap = ends(".jb-ribbon-cap");
    notes.cap = cap.ys;
    expect(on(cap.ys), "the cap is on the point's row (" + JSON.stringify(cap.ys) + ")");
    const body = document.querySelectorAll(".jb-pane-body")[1];
    const probe = document.createElement("div");
    probe.className = "jb-point-inserted jb-point jb-point-after";
    body.appendChild(probe);
    const line = getComputedStyle(probe).borderBottomColor;
    probe.remove();
    expect(cap.path && getComputedStyle(cap.path).fill === line, "the ribbon's end and the point line are ONE colour (" + (cap.path && getComputedStyle(cap.path).fill) + " vs " + line + ")");
  `);
  assert.deepEqual(v.fails, [], JSON.stringify(v.notes));
});

test("an insertion point INSIDE the file is unchanged: the top edge of the line it precedes", { skip }, async () => {
  const v = await runMergePage(CHROME!, `
    const W = gsMerge;
    const view = mountView(W.payload({
      base: "a\\nb\\n", ours: "a\\nN\\nb\\n", theirs: "a\\nN\\nb\\n", result: "a\\nb\\n",
      oursLabel: "Yours", theirsLabel: "Theirs",
    }));
    const decos = view.result.getModel().getAllDecorations().filter((d) => /jb-point/.test(d.options.className || ""));
    expect(decos.length === 1 && decos[0].range.startLineNumber === 2, "on line 2");
    expect(decos.length === 1 && !/jb-point-after/.test(decos[0].options.className), "the ordinary top marker");
  `);
  assert.deepEqual(v.fails, []);
});
