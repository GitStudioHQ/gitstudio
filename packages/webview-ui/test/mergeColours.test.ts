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
 * deletion, and a Yours-only whitespace-only re-indent.
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
      bb: cs.borderBottomStyle, bbc: cs.borderBottomColor,
      bl: cs.borderLeftStyle, blc: cs.borderLeftColor,
    };
    el.remove();
    return out;
  };
  const layerA = () => document.querySelector(".jb-gutter-a .jb-button-layer");
  const layerB = () => document.querySelector(".jb-gutter-b .jb-button-layer");
  const layerR = () => document.querySelector(".jb-result-actions");
  const groupsIn = (layer) => [...layer.querySelectorAll(".jb-change-actions")].map((g) => Number(g.dataset.block)).sort((a, b) => a - b);
  const press = (el) => el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  const TINT = {
    conflict: "rgba(255, 123, 58, 0.24)",
    same: "rgba(163, 113, 247, 0.16)",
    modified: "rgba(56, 139, 253, 0.24)",
    inserted: "rgba(63, 185, 80, 0.14)",
    deleted: "rgba(139, 148, 158, 0.24)",
  };
  const EDGE = {
    conflict: "rgba(255, 123, 58, 0.95)",
    same: "rgba(163, 113, 247, 0.95)",
    modified: "rgba(56, 139, 253, 0.9)",
    inserted: "rgba(63, 185, 80, 0.9)",
    deleted: "rgba(139, 148, 158, 0.9)",
  };
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
    expectPane("left", [
      "2:jb-line-conflict jb-cat-conflict",
      "4-5:jb-line-conflict jb-cat-conflict",
      "7:jb-line-same jb-cat-same",
      "9:jb-line-same jb-cat-same",
      "11:jb-line-modified jb-cat-yours-only",
      "16:jb-line-modified jb-cat-yours-only jb-ws",
    ]);
    expectPane("right", [
      "2:jb-line-conflict jb-cat-conflict",
      "4-5:jb-line-conflict jb-cat-conflict",
      "7:jb-line-same jb-cat-same",
      "9:jb-line-same jb-cat-same",
      "13:jb-line-inserted jb-cat-theirs-only",
      "15:jb-marker-deleted jb-cat-theirs-only",
    ]);
    expectPane("result", [
      "2:jb-line-conflict jb-cat-conflict",
      "4-5:jb-line-conflict jb-cat-conflict",
      "7:jb-line-same jb-cat-same",
      "9:jb-line-same jb-cat-same",
      "11:jb-line-modified jb-cat-yours-only",
      "13:jb-marker-inserted jb-cat-theirs-only",
      "14:jb-line-deleted jb-cat-theirs-only",
      "16:jb-line-modified jb-cat-yours-only jb-ws",
    ]);
    // Word tints: a real change has them; a whitespace-only one never does.
    expect(/jb-inner-conflict/.test(classesOn("left", 2)), "the conflict carries word tints (" + classesOn("left", 2) + ")");
    expect(!/jb-inner-/.test(classesOn("left", 16)), "the whitespace-only change has no word tint (" + classesOn("left", 16) + ")");
    expect(/jb-frame-conflict/.test(classesOn("result", 2)), "pending blocks carry the high-contrast frame edges");
    // The error stripe: each pending block marks the result's ruler in its
    // EDGE colour; conflicts take the full width, the rest the centre lane.
    const ruler = view.result.getModel().getAllDecorations()
      .filter((d) => d.options.overviewRuler && (d.options.className || "").includes("jb-cat-"))
      .map((d) => (d.options.className.match(/jb-cat-[a-z-]+/) || [""])[0] + "@" + d.options.overviewRuler.position + "=" + d.options.overviewRuler.color);
    const lane = (cat) => ruler.filter((r) => r.startsWith("jb-cat-" + cat + "@"));
    expect(ruler.length === 8, "every pending block marks the ruler: " + JSON.stringify(ruler));
    expect(lane("conflict").every((r) => r.includes("@7=")) && lane("conflict").length === 2, "conflicts use the full lane: " + JSON.stringify(lane("conflict")));
    expect(lane("same").every((r) => r.includes("@2=")) && lane("yours-only").every((r) => r.includes("@2=")), "the others the centre lane: " + JSON.stringify(ruler));
    expect(lane("same")[0] && lane("same")[0].endsWith("=" + EDGE.same), "in the category's edge colour: " + lane("same")[0]);

    // ── the controls, per category ──
    const A = groupsIn(layerA()), B = groupsIn(layerB());
    expect(JSON.stringify(A) === "[0,1,3,4,7]", "Yours gutter: arrows for conflicts, the ≈ change and Yours-only changes, NOT the identical one: " + JSON.stringify(A));
    expect(JSON.stringify(B) === "[0,1,3,5,6]", "Theirs gutter: " + JSON.stringify(B));
    const markA = layerA().querySelector('.jb-mark[data-block="2"]');
    const markB = layerB().querySelector('.jb-mark[data-block="2"]');
    expect(markA && markA.textContent === "=" && markB && markB.textContent === "=", "the identical change shows a passive = on both sides");
    const same = layerR().querySelector('.jb-identical-control[data-block="2"]');
    expect(same && same.querySelectorAll(".jb-btn-accept").length === 1, "the identical change has exactly ONE accept control, in the result margin");
    expect(same && same.querySelectorAll(".jb-btn-keep-base").length === 1, "…with a secondary keep-base");
    expect(same && getComputedStyle(same.querySelector(".jb-btn-keep-base")).visibility === "hidden", "…hidden until hover or focus");
    expect(layerR().querySelectorAll('.jb-btn-wand').length === 1 && layerR().querySelector('.jb-btn-wand').closest('[data-block="1"]'), "the resolvable conflict — and only it — has the wand");
    const markText = (b) => { const m = layerR().querySelector('.jb-mark[data-block="' + b + '"]'); return m && m.textContent; };
    expect(markText(0) === "≠", "conflict badge ≠ (" + markText(0) + ")");
    expect(markText(3) === "≈", "identical-except-whitespace badge ≈ (" + markText(3) + ")");
    expect(markText(4) === "‹" && markText(7) === "‹", "Yours-only origin badge ‹");
    expect(markText(5) === "›" && markText(6) === "›", "Theirs-only origin badge ›");

    // ── accessible names: category, ordinal, side and its real name ──
    const aria = (sel) => { const e = document.querySelector(sel); return e && e.getAttribute("aria-label"); };
    const want = {
      '.jb-gutter-a .jb-change-actions[data-block="0"] .jb-btn-accept': "Conflict 1 of 2: accept yours (test)",
      '.jb-gutter-b .jb-change-actions[data-block="1"] .jb-btn-accept': "Conflict 2 of 2: accept theirs (master)",
      '.jb-gutter-a .jb-change-actions[data-block="0"] .jb-btn-ignore': "Conflict 1 of 2: ignore yours (test)",
      '.jb-result-actions [data-block="2"] .jb-btn-accept': "Identical change 1 of 2: accept (the same on both sides)",
      '.jb-result-actions .jb-btn-wand': "Conflict 2 of 2: apply both sides (their edits don't overlap)",
      '.jb-gutter-a .jb-change-actions[data-block="4"] .jb-btn-accept': "Change only in yours 1 of 2: accept yours (test)",
      '.jb-gutter-b .jb-change-actions[data-block="6"] .jb-btn-accept': "Change only in theirs 2 of 2: accept theirs (master)",
    };
    for (const [sel, label] of Object.entries(want)) {
      expect(aria(sel) === label, "aria-label of " + sel + " is " + JSON.stringify(aria(sel)) + ", want " + JSON.stringify(label));
    }

    // ── computed styles of the classes the decorations actually carry ──
    const bgOf = (pane, cls) => probe(pane, cls).bg;
    expect(bgOf("left", "jb-line-conflict jb-cat-conflict") === TINT.conflict, "conflict tint: " + bgOf("left", "jb-line-conflict jb-cat-conflict"));
    expect(bgOf("left", "jb-line-same jb-cat-same") === TINT.same, "identical tint (violet): " + bgOf("left", "jb-line-same jb-cat-same"));
    expect(bgOf("left", "jb-line-modified jb-cat-yours-only") === TINT.modified, "Yours-only modified tint (blue)");
    expect(bgOf("right", "jb-line-inserted jb-cat-theirs-only") === TINT.inserted, "Theirs-only insertion tint (green)");
    expect(bgOf("result", "jb-line-deleted jb-cat-theirs-only") === TINT.deleted, "Theirs-only deletion tint (grey)");
    const marker = probe("result", "jb-marker-inserted jb-cat-theirs-only");
    expect(marker.bt === "double" && marker.btw === "3px" && marker.btc === EDGE.inserted, "an insertion point is a double line in the edge colour: " + JSON.stringify(marker));
    const ws = probe("left", "jb-line-modified jb-cat-yours-only jb-ws");
    expect(ws.bl === "dotted" && ws.blc === EDGE.modified && ws.bg === TINT.modified, "whitespace-only: tint + dotted edge: " + JSON.stringify(ws));
    const frame = probe("left", "jb-frame-conflict");
    expect(frame.bt === "none", "outside high contrast, the frame edges draw nothing: " + frame.bt);
    // If Monaco painted (it may not, headless), the real overlay agrees.
    const painted = document.querySelector(".view-overlays .jb-cat-same");
    notes.monacoPainted = !!painted;
    if (painted) expect(getComputedStyle(painted).backgroundColor === TINT.same, "the painted identical line is violet: " + getComputedStyle(painted).backgroundColor);

    // ── the ribbons, after the 32 ms overlay timer (no frame needed) ──
    await sleep(60);
    const stage = document.querySelector(".jb-ribbon-stage");
    const count = (cls) => stage.querySelectorAll("path." + cls).length;
    const ribbons = { conflict: count("jb-ribbon-conflict"), same: count("jb-ribbon-same"), modified: count("jb-ribbon-modified"), inserted: count("jb-ribbon-inserted"), deleted: count("jb-ribbon-deleted"), frame: count("jb-ribbon-edge") };
    expect(JSON.stringify(ribbons) === JSON.stringify({ conflict: 4, same: 4, modified: 2, inserted: 1, deleted: 1, frame: 4 }), "ribbons per category: " + JSON.stringify(ribbons));
    const sameFill = stage.querySelector("path.jb-ribbon-same") && getComputedStyle(stage.querySelector("path.jb-ribbon-same")).fill;
    expect(sameFill === TINT.same, "identical ribbon fill: " + sameFill);
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("applied and ignored changes keep their category as a dashed outline; the append icon and the wand", { skip }, async () => {
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

    // Every pane that showed an applied change still shows it — dashed, no fill.
    const applied = (pane) => catDecos(pane).filter((d) => d.includes("jb-applied-"));
    const hasLine = (pane, line, cls) => catDecos(pane).some((d) => d.startsWith(line + ":") && d.includes(cls));
    expect(hasLine("left", 7, "jb-applied-same") && hasLine("right", 7, "jb-applied-same") && hasLine("result", 7, "jb-applied-same"), "identical: dashed in all three panes: " + JSON.stringify(applied("result")));
    expect(hasLine("left", 11, "jb-applied-modified") && hasLine("result", 11, "jb-applied-modified"), "Yours-only: dashed in Yours and the result");
    expect(hasLine("right", 13, "jb-applied-inserted") && hasLine("result", 13, "jb-applied-inserted"), "Theirs-only insertion: dashed");
    expect(hasLine("right", 15, "jb-applied-deleted jb-edge-top"), "Theirs-only deletion point: a dashed marker line");
    expect(!catDecos("left").some((d) => /jb-line-(same|modified)/.test(d)), "no applied change keeps a fill: " + JSON.stringify(catDecos("left")));
    expect(catDecos("result").filter((d) => d.includes("jb-line-conflict")).length === 2, "the conflicts are still pending");

    const dashed = probe("result", "jb-applied-same jb-cat-same");
    expect(dashed.bt === "dashed" && dashed.bb === "dashed" && dashed.btc === EDGE.same && dashed.bg === "rgba(0, 0, 0, 0)",
      "applied = 1px dashed top and bottom in the category edge colour, no background: " + JSON.stringify(dashed));
    const top = probe("result", "jb-applied-inserted jb-edge-top jb-cat-theirs-only");
    expect(top.bt === "dashed" && top.bb === "none", "the first line of a region keeps only its top edge: " + JSON.stringify(top));

    // Controls: an applied change has none left.
    expect(JSON.stringify(groupsIn(layerA())) === "[0,1]" && JSON.stringify(groupsIn(layerB())) === "[0,1]", "only the conflicts keep arrows: " + JSON.stringify([groupsIn(layerA()), groupsIn(layerB())]));
    expect(!layerR().querySelector(".jb-identical-control"), "the identical control is gone");

    await sleep(60);
    const stage = document.querySelector(".jb-ribbon-stage");
    const dashedBand = stage.querySelector("path.jb-ribbon-applied-same");
    expect(dashedBand, "the applied identical change keeps a dashed band");
    if (dashedBand) {
      const cs = getComputedStyle(dashedBand);
      expect(cs.fill === "none" && cs.strokeDasharray === "3px, 3px" && cs.stroke === EDGE.same, "…outline only, dashed, in its colour: " + [cs.fill, cs.strokeDasharray, cs.stroke].join(" | "));
    }
    expect(stage.querySelectorAll("path.jb-ribbon-same").length === 0, "…and no fill band");

    // Take Yours in the first conflict: Theirs' arrow becomes the append.
    press(document.querySelector('.jb-gutter-a .jb-change-actions[data-block="0"] .jb-btn-accept'));
    const append = document.querySelector('.jb-gutter-b .jb-change-actions[data-block="0"] .jb-btn-accept');
    expect(append && append.classList.contains("jb-btn-append") && append.querySelector(".codicon-insert"), "after Yours is in, Theirs' control is the append icon");
    expect(append && append.getAttribute("aria-label") === "Conflict 1 of 2: append theirs (master)", "…named as an append: " + (append && append.getAttribute("aria-label")));
    expect(!document.querySelector('.jb-gutter-a .jb-change-actions[data-block="0"]'), "Yours' controls for it are gone");

    // The wand writes both sides' edits for the resolvable conflict.
    const expected = view.model.blocks[1].resolvedText;
    press(layerR().querySelector(".jb-btn-wand"));
    const lines = view.getResultText().split("\\n");
    expect(lines.slice(3, 5).join("\\n") === expected && expected === "r1 = yours\\nr2 = theirs", "the wand applied both edits: " + JSON.stringify(lines.slice(3, 5)));
    expect(hasLine("result", 4, "jb-applied-conflict"), "…and the conflict is dashed now");
    expect(counts.byCategory.conflict.pending === 1 && counts.resolvableConflictsPending === 0, "one conflict left, none resolvable: " + JSON.stringify(counts.byCategory.conflict));

    // Undo takes the wand back; resolveSimpleConflicts does the same in bulk.
    view.undo();
    expect(counts.resolvableConflictsPending === 1, "undo brings the resolvable conflict back");
    view.resolveSimpleConflicts();
    expect(view.getResultText().split("\\n").slice(3, 5).join("\\n") === expected, "the toolbar wand resolves it too");
    expect(view.hasSimpleConflicts() === false, "…and then has nothing left to do");
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
    expect(lines[8] === "w1 = new   ", "the ≈ change was taken in THEIRS' whitespace: " + JSON.stringify(lines[8]));
    view.undo();
    view.applyNonConflictingSide("left");
    expect(view.getResultText().split("\\n")[8] === "w1 = new", "…and in Yours' from the Yours button: " + JSON.stringify(view.getResultText().split("\\n")[8]));
    view.undo();

    // Enter / Space on a focused control fire a click with no press first.
    const accept = document.querySelector('.jb-gutter-a .jb-change-actions[data-block="4"] .jb-btn-accept');
    accept.focus();
    accept.click();
    expect(view.getResultText().split("\\n")[10] === "y1 = yours", "a keyboard click accepts: " + view.getResultText().split("\\n")[10]);
    // Tab reaches the identical change's accept first; keep-base appears
    // beside it once focus is inside the control, so Tab reaches it next.
    const same = document.querySelector('.jb-result-actions [data-block="2"]');
    const keep = same.querySelector(".jb-btn-keep-base");
    same.querySelector(".jb-btn-accept").focus();
    expect(getComputedStyle(keep).visibility === "visible", "keep-base shows once focus is inside its control");
    keep.focus();
    expect(document.activeElement === keep, "…and can then take focus itself");
    keep.click();
    expect(counts.byCategory.same.pending === 1 && view.getResultText().split("\\n")[6] === "s1 = base", "keep-base settles the identical change on the base text");
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
    expect(counts.resolvableConflictsPending === 0 && !document.querySelector(".jb-result-actions .jb-btn-wand"),
      "the wand will not overwrite a hand edit: " + counts.resolvableConflictsPending);
    view.resolveSimpleConflicts();
    expect(view.getResultText().split("\\n")[3] === "// r1 = base", "resolveSimpleConflicts leaves the edited region alone: " + view.getResultText().split("\\n")[3]);
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("the legend counts what is left per category and jumps to it", { skip }, async () => {
  const v = await runMergePage(CHROME!, MOUNT + `
    view.attachLegend(document.getElementById("slot"));
    const chip = (cat) => document.querySelector('#slot .jb-legend-chip[data-category="' + cat + '"]');
    const text = (cat) => chip(cat) && chip(cat).textContent.replace(/\\s+/g, " ").trim();
    expect(text("conflict") === "≠Conflicts2( 1 resolvable)", "conflict chip: " + JSON.stringify(text("conflict")));
    expect(text("same") === "=Identical2", "identical chip: " + JSON.stringify(text("same")));
    expect(text("yours-only") === "‹Yours only2" && text("theirs-only") === "›Theirs only2", "one-sided chips: " + JSON.stringify([text("yours-only"), text("theirs-only")]));
    expect(chip("conflict").getAttribute("aria-label") === "Conflicts: 2 conflicts left, 1 the wand can resolve. Go to the next one.", "chip name: " + chip("conflict").getAttribute("aria-label"));

    // A chip jumps to the next pending block of its category.
    chip("theirs-only").click();
    expect(view.result.getPosition().lineNumber === 13, "Theirs only → the insertion at line 13 (" + view.result.getPosition().lineNumber + ")");
    chip("theirs-only").click();
    expect(view.result.getPosition().lineNumber === 14, "…then the deletion at 14 (" + view.result.getPosition().lineNumber + ")");

    view.applyAllNonConflicting();
    expect(text("same") === "=Identical0" && chip("same").disabled, "a category with nothing left reads 0 and cannot be clicked");
    expect(!chip("conflict").querySelector(".jb-legend-extra").hidden, "the resolvable note stays while the wand has work");
    view.resolveSimpleConflicts();
    expect(chip("conflict").querySelector(".jb-legend-extra").hidden, "…and goes when it has none");

    // The key explains every mark.
    const help = document.querySelector("#slot .jb-legend-help");
    help.click();
    const pop = document.querySelector("#slot .jb-legend-pop");
    expect(!pop.hidden && help.getAttribute("aria-expanded") === "true", "the key opens");
    const key = pop.textContent;
    for (const phrase of ["Conflict", "Identical", "whitespace", "Dashed outline", "Added lines", "Removed lines", "Changed lines"]) {
      expect(key.includes(phrase), "the key explains " + phrase);
    }
    help.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(pop.hidden, "Escape closes it");

    // The legend survives a rebuild (a whitespace change) and keeps counting.
    view.setRenderOptions({ whitespace: "none" });
    expect(document.querySelectorAll("#slot .jb-legend").length === 1 && text("conflict").startsWith("≠Conflicts3"), "after a re-diff the same legend shows the new counts: " + text("conflict"));
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
    expect(/jb-applied-modified/.test(classesOn("left", 11)), "the applied change is still marked applied");
    view.setRenderOptions({ showInner: true });
    expect(/jb-inner-conflict/.test(classesOn("left", 2)) && view.getResultText() === before, "and back, still with the work");

    // Whitespace re-diffs (the shell confirms first, from hasProgress).
    view.setRenderOptions({ whitespace: "none" });
    expect(counts.hasProgress === false && !view.canUndo() && view.getResultText() === W.FIXTURE.base, "a whitespace change starts over from the baseline");
    expect(counts.byCategory.conflict.total === 3, "and re-classifies: ≈ is a conflict under 'none' (" + counts.byCategory.conflict.total + ")");
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
