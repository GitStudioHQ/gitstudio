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
 * variant, and the same two rows for the ribbon's end — POINT_PX).
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
    expect(cs.borderBottomStyle === "solid" && cs.borderBottomWidth === "2px" && cs.boxSizing === "border-box", "the 2px point line is on the bottom rows, inside the line (" + notes.style.join(" ") + ")");
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
    // The ribbon's end at the result is the marker's two rows: [bottom - 2, bottom].
    const path = document.querySelector('.jb-ribbon-stage path.jb-ribbon-same[data-side="left"]');
    const pts = path ? path.getAttribute("d").replace(/[MLQZ]/g, " ").trim().split(/\\s+/).map(Number) : [];
    const xy = []; for (let i = 0; i + 1 < pts.length; i += 2) xy.push([pts[i], pts[i + 1]]);
    const xMax = Math.max(...xy.map(([x]) => x));
    const ys = xy.filter(([x]) => x === xMax).map(([, y]) => y);
    const stageTop = document.querySelector(".jb-ribbon-stage").getBoundingClientRect().top;
    const editorTop = r.getContainerDomNode().getBoundingClientRect().top;
    notes.end = ys;
    const want = [editorTop + bottomOfLast - 2 - stageTop, editorTop + bottomOfLast - stageTop];
    expect(ys.length === 2 && Math.abs(Math.min(...ys) - want[0]) < 0.01 && Math.abs(Math.max(...ys) - want[1]) < 0.01,
      "the ribbon ends on the last line's bottom two rows (" + JSON.stringify(ys) + " vs " + JSON.stringify(want) + ")");
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
