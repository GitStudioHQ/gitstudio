import { test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, runMergePage } from "./fixtures/mergeViewPage";

/**
 * Where the Result starts, and what the host is told is still open — in the
 * REAL merge view, headless.
 *
 * POLISH A1.2: a file already resolved outside the editor seeds the Result
 * with what it has — every change still pending, holding the file's text —
 * so "Apply with N unresolved" saves that, never base over a resolution.
 * POLISH A1.1: a conflict with one side taken (or ignored) and the other
 * still to decide is NOT settled; the text the host marks up for the file
 * (getUnsettledText) holds base there, so it is written with its markers.
 */

const CHROME = findChrome();
const skip = !CHROME && "no Chrome on this machine";

const PROLOGUE = `
  const W = gsMerge;
  const host = document.getElementById("host");
  const L = (...l) => l.join("\\n") + "\\n";
  let seeded = "none";
  let counts = null;
  const make = (p) => {
    const view = new W.MergeView(host);
    view.onSeeded = (info) => { seeded = info; };
    view.onCountsChanged = (c) => { counts = c; };
    view.render(p);
    return view;
  };
  const conflicts = (view) => view.model.blocks.filter((b) => W.category(b) === "conflict");
  const show = (v) => JSON.stringify(v);
`;

test("A1.2: a file resolved by hand seeds the Result; every change stays pending, holding the file's text", { skip }, async () => {
  const v = await runMergePage(CHROME!, PROLOGUE + `
    const F = W.FIXTURE;
    const base = F.base.split("\\n");
    // Resolved in a text editor: the conflict by hand, Yours' change taken, Theirs' deletion taken.
    const hand = base.map((l) => l === "c1 = base" ? "c1 = by hand" : l === "y1 = base" ? "y1 = yours" : l)
      .filter((l) => l !== "d1 = base").join("\\n");
    const view = make(W.payload({ result: hand }));
    expect(seeded && seeded.kind === "working" && seeded.changes === view.model.blocks.length, "the view says it started from the file: " + show(seeded));
    expect(view.getResultText() === hand, "the Result IS the file: " + show(view.getResultText()));
    expect(counts.pending === view.model.blocks.length, "every change is still pending (" + counts.pending + " of " + view.model.blocks.length + ")");
    expect(!counts.hasProgress, "and the seed is where the merge starts, not progress");
    const c = conflicts(view)[0];
    const lines = view.result.getModel().getValue().split("\\n");
    const span = view.currentResultSpan(c);
    expect(lines.slice(span.start - 1, span.endExclusive - 1).join("|") === "c1 = by hand", "the conflict sits on the hand-resolved line (" + show(span) + ")");
    // Apply as it is saves the file's resolution, never base.
    expect(!/c1 = base/.test(view.getResultText()), "no base over the resolution");
    // Taking a side replaces the file's text there, like any hand edit.
    view.acceptSide(c, "left", "auto");
    expect(/c1 = yours/.test(view.getResultText()) && !/c1 = by hand/.test(view.getResultText()), "Accept Yours replaces it");
    view.reset();
    expect(view.getResultText() === hand, "Reset goes back to the file, not to base");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("A1.2: a region settled outside the markers is seeded; git's own file seeds nothing; base or empty seeds nothing", { skip }, async () => {
  const v = await runMergePage(CHROME!, PROLOGUE + `
    const BASE = L("a", "b1", "c", "d", "e2", "f");
    const YOURS = L("a", "B1-yours", "c", "d", "E2-yours", "f");
    const THEIRS = L("a", "B1-theirs", "c", "d", "E2-theirs", "f");
    const GIT = L("a", "<<<<<<< HEAD", "B1-yours", "||||||| base", "b1", "=======", "B1-theirs", ">>>>>>> feature",
      "c", "d", "<<<<<<< HEAD", "E2-yours", "||||||| base", "e2", "=======", "E2-theirs", ">>>>>>> feature", "f");
    const P = (result) => W.payload({ base: BASE, ours: YOURS, theirs: THEIRS, result });
    let view = make(P(GIT));
    expect(seeded === undefined, "git's own conflicted file seeds nothing: " + show(seeded));
    expect(view.getResultText() === BASE, "the Result starts from base");
    view.dispose();
    const partly = L("a", "B1 by hand", "c", "d", "<<<<<<< HEAD", "E2-yours", "||||||| base", "e2", "=======", "E2-theirs", ">>>>>>> feature", "f");
    view = make(P(partly));
    expect(seeded && seeded.kind === "markers" && seeded.changes === 1, "one change settled outside the markers: " + show(seeded));
    expect(view.getResultText() === L("a", "B1 by hand", "c", "d", "e2", "f"), "the Result holds it, and base for the one still marked: " + show(view.getResultText()));
    expect(counts.pending === 2 && counts.pendingChanged === 1, "both still pending, one holding the file's text: " + show(counts));
    // What the host writes from: the untouched seeded region back to base (it keeps the file's own lines there).
    expect(view.getUnsettledText() === BASE, "the unsettled text puts the untouched seeded region back to base: " + show(view.getUnsettledText()));
    // The critic, r0923: the change merged outside the markers looked exactly
    // like the open conflict below it. Its Result is painted settled-looking
    // (the muted tint between faint lines), with a hover that says why.
    const decos = (line) => view.result.getModel().getLineDecorations(line).map((d) => d.options);
    const seededBand = decos(2).find((o) => /jb-line-conflict/.test(o.className || ""));
    const openBand = decos(5).find((o) => /jb-line-conflict/.test(o.className || ""));
    expect(!!seededBand && /jb-half/.test(seededBand.className), "the seeded conflict's Result is not painted as an open one: " + show(seededBand && seededBand.className));
    expect(!!seededBand && /outside the conflict markers/.test((seededBand.hoverMessage || {}).value || ""), "and says, on hover, that it was merged there: " + show(seededBand && seededBand.hoverMessage));
    expect(!!openBand && !/jb-half/.test(openBand.className), "the conflict still marked stays open: " + show(openBand && openBand.className));
    // Its bands meet that Result as they meet a half-done one's (the matrix's
    // seam check: an OPEN band must meet the Result on its own tint).
    await sleep(80);
    const phases = (id) => [...document.querySelectorAll('.jb-ribbon-stage path.jb-ribbon[data-block="' + id + '"]')].map((p) => p.dataset.phase);
    const [s0, o0] = conflicts(view);
    expect(phases(s0.id).length === 2 && phases(s0.id).every((p) => p === "half"), "the seeded conflict's bands say its Result is half settled: " + show(phases(s0.id)));
    expect(phases(o0.id).length === 2 && phases(o0.id).every((p) => p === "open"), "the marked one's stay open: " + show(phases(o0.id)));
    // Touched, it is an ordinary pending change again (or settled).
    const [seededBlock] = conflicts(view);
    view.acceptSide(seededBlock, "right", "auto");
    const after = decos(view.currentResultSpan(seededBlock).start).find((o) => /jb-line-conflict/.test(o.className || ""));
    expect(!after || !/outside the conflict markers/.test((after.hoverMessage || {}).value || ""), "once a side is taken, the note goes");
    view.dispose();
    view = make(P(BASE));
    expect(seeded === undefined, "a file that is base seeds nothing");
    view.dispose();
    view = make(P(""));
    expect(seeded === undefined, "an empty file seeds nothing");
    view.dispose();
    view = make({ ...P(L("a", "B1 by hand", "c", "d", "e2", "f")), source: "markers" });
    expect(seeded === undefined, "sides read from markers seed nothing (no stages to trust)");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("A1.1: a conflict with one side taken, or one ignored, is unsettled until the other side is decided", { skip }, async () => {
  const v = await runMergePage(CHROME!, PROLOGUE + `
    const view = make(W.payload());
    const [c] = conflicts(view);
    const base = W.FIXTURE.base;
    expect(view.getUnsettledText() === base, "fresh: the unsettled text is base");
    view.acceptSide(c, "left", "auto");
    expect(/c1 = yours/.test(view.getResultText()), "the Result shows Yours taken");
    expect(view.getUnsettledText() === base, "…but Theirs is still to decide: unsettled, base there: " + show(view.getUnsettledText()));
    view.ignoreSide(c, "right");
    expect(/c1 = yours/.test(view.getUnsettledText()), "Theirs ignored: settled as Yours");
    view.undo();
    view.undo();
    view.ignoreSide(c, "left");
    expect(view.getUnsettledText() === base, "Yours ignored, Theirs still open: unsettled");
    view.acceptSide(c, "right", "auto");
    expect(/c1 = theirs/.test(view.getUnsettledText()), "then Theirs taken: settled as Theirs");
    // A one-sided change taken is settled at once.
    const y = view.model.blocks.find((b) => W.category(b) === "yours-only");
    view.acceptSide(y, "left", "auto");
    expect(view.getUnsettledText().includes("y1 = yours"), "a one-sided change is settled by its one side");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});
