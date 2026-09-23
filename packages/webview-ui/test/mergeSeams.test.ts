import { test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, runMergePage } from "./fixtures/mergeViewPage";

/**
 * The seam from the engine to what the merge view shows and writes, driven in
 * headless Chrome against the REAL MergeView, Monaco and the legend.
 *
 * 1. Every PLAN Appendix A case: the engine's categories, the view's counts and
 *    the legend must all say what the table says. Three layers each count on
 *    their own, so a category the engine gets right can still reach the legend
 *    wrong (an item wired to the wrong key, a stale update). The legend has one
 *    item per COLOUR — Yours-only and Theirs-only share "on one side", whose
 *    tooltip says how many of each — so a category is read from its item, and
 *    a one-sided one from that tooltip.
 * 2. What an accept or an ignore writes, against an oracle that knows nothing
 *    about Monaco: the result is base with each block's region replaced by the
 *    lines of whatever was chosen (Yours' region, Theirs' region, both in
 *    click order, or base's), joined with Yours' line ending. Blocks are
 *    settled in a random order, so an edit above a block must never move what
 *    a later accept writes. The cases include the file's first and last line,
 *    a missing final newline, CRLF on either side and an empty base.
 *
 * Nothing waits on requestAnimationFrame: every assertion reads state.
 */

const CHROME = findChrome();
const skip = !CHROME && "no Chrome on this machine";

type Mode = "none" | "trailing" | "all";
type Cat = "conflict" | "same" | "yours-only" | "theirs-only";

interface Case {
  n: number;
  base: string;
  ours: string;
  theirs: string;
  mode: Mode;
  /** Appendix A's expected blocks, by category. */
  want: Partial<Record<Cat, number>>;
  resolvable?: number;
  eolMismatch?: boolean;
}

const APPENDIX_A: Case[] = [
  { n: 1, base: "a\nb\nc", ours: "a\nX\nc", theirs: "a\nX\nc", mode: "none", want: { same: 1 } },
  { n: 2, base: "a\nc", ours: "a\nN\nc", theirs: "a\nN\nc", mode: "none", want: { same: 1 } },
  { n: 3, base: "a\nb\nc", ours: "a\nc", theirs: "a\nc", mode: "none", want: { same: 1 } },
  { n: 4, base: "a\nb\nc", ours: "a\nX\nc", theirs: "a\nY\nc", mode: "none", want: { conflict: 1 }, resolvable: 0 },
  { n: 5, base: "a\nb\nc", ours: "a\nx = 1\nc", theirs: "a\nx  =  1\nc", mode: "none", want: { conflict: 1 } },
  { n: 6, base: "a\nb\nc", ours: "a\nx = 1\nc", theirs: "a\nx = 1   \nc", mode: "trailing", want: { same: 1 } },
  { n: 7, base: "a\nb\nc", ours: "a\nx = 1\nc", theirs: "a\nx  =  1\nc", mode: "all", want: { same: 1 } },
  { n: 8, base: "a\nb\nc", ours: "a\nx = 1\nc", theirs: "a\nx  =  1\nc", mode: "trailing", want: { conflict: 1 } },
  { n: 9, base: "a\nb\nc", ours: "a\nc", theirs: "a\nB2\nc", mode: "none", want: { conflict: 1 }, resolvable: 0 },
  { n: 10, base: "a\nb\nc\nd", ours: "a\nQ\nc\nd", theirs: "a\nQ\nd", mode: "none", want: { conflict: 1 } },
  { n: 11, base: "a\nb\n", ours: "a\nX\n", theirs: "a\nX", mode: "none", want: { conflict: 1 } },
  { n: 12, base: "a\nb\nc\nd\ne", ours: "a\nB\nC\nd\ne", theirs: "a\nb\nC2\nD\ne", mode: "none", want: { conflict: 1 }, resolvable: 0 },
  { n: 13, base: "a\nb\nc\nd", ours: "a\nB\nc\nd", theirs: "a\nb\nC\nd", mode: "none", want: { conflict: 1 }, resolvable: 1 },
  { n: 14, base: "a\nb\nc\nd", ours: "a\nB\nc\nd", theirs: "a\nb\nc\nD", mode: "none", want: { "yours-only": 1, "theirs-only": 1 } },
  { n: 15, base: "a\nc", ours: "a\nN1\nc", theirs: "a\nN2\nc", mode: "none", want: { conflict: 1 }, resolvable: 0 },
  { n: 16, base: "a\nb\nc", ours: "a\nN\nb\nc", theirs: "a\nB\nc", mode: "none", want: { conflict: 1 }, resolvable: 1 },
  { n: 17, base: "", ours: "x\ny", theirs: "x\ny", mode: "none", want: { same: 1 } },
  { n: 18, base: "", ours: "def f():\n  return 1", theirs: "def f():\n  return 2", mode: "none", want: { conflict: 1 } },
  { n: 19, base: "a\nb\nc", ours: "a\nX\nc", theirs: "a\r\nX\r\nc", mode: "none", want: { same: 1 }, eolMismatch: true },
  { n: 20, base: "a\nb\nc", ours: "a\r\nb\r\nc", theirs: "a\nB\nc", mode: "none", want: { "theirs-only": 1 }, eolMismatch: true },
  { n: 21, base: "a\nb\nc", ours: "a\n  b  \nc", theirs: "a\nb\nc", mode: "all", want: { "yours-only": 1 } },
  { n: 22, base: "a\nb\nc", ours: "a\nb  \nc", theirs: "a\nb\t\nc", mode: "trailing", want: { same: 1 } },
  { n: 23, base: "a\nb\n", ours: "", theirs: "", mode: "none", want: { same: 1 } },
  { n: 24, base: "a\nb\n", ours: "", theirs: "a\nB\n", mode: "none", want: { conflict: 1 } },
  { n: 25, base: "a\nb\nc", ours: "a\nX\nc", theirs: "a\nX\nZ", mode: "none", want: { conflict: 1 }, resolvable: 0 },
  { n: 26, base: "a\nb\nc\nd", ours: "a\nd", theirs: "a\nC2\nd", mode: "none", want: { conflict: 1 } },
];

/** Page helpers shared by both tests: the view, its legend, and the oracle. */
const PROLOGUE = `
  const W = gsMerge;
  const slot = document.getElementById("slot");
  const view = new W.MergeView(host);
  view.attachLegend(slot);
  let counts = null;
  view.onCountsChanged = (c) => { counts = c; };
  const show = (s) => JSON.stringify(s);
  const CATS = ["conflict", "same", "yours-only", "theirs-only"];
  const chip = (item) => slot.querySelector('.jb-legend-chip[data-category="' + item + '"]');
  const itemCount = (item) => Number(chip(item).querySelector(".jb-legend-count").textContent);
  /** What the legend says is left of one engine category (NaN when it does not say). */
  const chipCount = (cat) => {
    if (cat === "conflict" || cat === "same") return itemCount(cat);
    if (itemCount("one-sided") === 0) return 0;
    const m = /\\((\\d+) in Yours, (\\d+) in Theirs\\)/.exec(chip("one-sided").title);
    return m ? Number(cat === "yours-only" ? m[1] : m[2]) : NaN;
  };
  /** The conflicts the legend says Resolve simple can settle: "; k|it|all can be resolved automatically". */
  const chipResolvable = () => {
    const m = /; (\\d+|it|all) can be resolved automatically/.exec(chip("conflict").title);
    return !m ? 0 : m[1] === "it" ? 1 : m[1] === "all" ? itemCount("conflict") : Number(m[1]);
  };
  const norm = (t) => t.replace(/\\r\\n?/g, "\\n");
  const EOL = { LF: "\\n", CRLF: "\\r\\n", CR: "\\r" };
  const mount = (c, init) => {
    view.setRenderOptions({ whitespace: c.mode });
    view.render(W.payload({ base: c.base, ours: c.ours, theirs: c.theirs, result: c.base }), init);
  };
  /** A side's full region for a block, in that side's own lines (sideBlockSpan). */
  const region = (block, side) => {
    const change = side === "left" ? block.left : block.right;
    if (!change) return [];
    const lines = norm(side === "left" ? CUR.ours : CUR.theirs).split("\\n");
    const leadIn = change.baseSpan.start - block.baseSpan.start;
    const trailing = block.baseSpan.endExclusive - change.baseSpan.endExclusive;
    return lines.slice(change.sideSpan.start - leadIn - 1, change.sideSpan.endExclusive + trailing - 1);
  };
  const baseRegion = (block) => norm(CUR.base).split("\\n").slice(block.baseSpan.start - 1, block.baseSpan.endExclusive - 1);
  /** base, with each block's region replaced by what was chosen for it. */
  const oracle = (chosen) => {
    const baseLines = norm(CUR.base).split("\\n");
    const out = [];
    let at = 1;
    for (const block of [...view.model.blocks].sort((a, b) => a.baseSpan.start - b.baseSpan.start)) {
      out.push(...baseLines.slice(at - 1, block.baseSpan.start - 1));
      out.push(...(chosen.has(block.id) ? chosen.get(block.id) : baseRegion(block)));
      at = block.baseSpan.endExclusive;
    }
    out.push(...baseLines.slice(at - 1));
    return out.join(EOL[view.model.eol]);
  };
  let CUR = null;
`;

test("Appendix A: the engine, the view's counts and the legend chips agree with the table", { skip }, async () => {
  const v = await runMergePage(CHROME!, PROLOGUE + `
    const CASES = ${JSON.stringify(APPENDIX_A)};
    for (const c of CASES) {
      CUR = c;
      const tag = "case " + c.n;
      const engine = W.buildMergeModel(c.base, c.ours, c.theirs, { whitespace: c.mode });
      const engineCats = { conflict: 0, same: 0, "yours-only": 0, "theirs-only": 0 };
      for (const b of engine.blocks) engineCats[W.category(b)]++;
      mount(c);
      for (const cat of CATS) {
        const want = c.want[cat] || 0;
        expect(engineCats[cat] === want, tag + ": engine " + cat + " = " + engineCats[cat] + ", Appendix A says " + want);
        expect(counts && counts.byCategory[cat].total === engineCats[cat] && counts.byCategory[cat].pending === engineCats[cat],
          tag + ": the view's " + cat + " counts " + show(counts && counts.byCategory[cat]) + " vs engine " + engineCats[cat]);
        expect(chipCount(cat) === engineCats[cat], tag + ": the legend says " + chipCount(cat) + " " + cat + ", engine " + engineCats[cat]);
      }
      expect(itemCount("one-sided") === engineCats["yours-only"] + engineCats["theirs-only"],
        tag + ": the one-sided item counts both sides: " + itemCount("one-sided") + " vs engine " + (engineCats["yours-only"] + engineCats["theirs-only"]));
      expect(chipResolvable() === engine.counts.resolvableConflicts,
        tag + ": the conflict item's tooltip says " + chipResolvable() + " resolvable, engine " + engine.counts.resolvableConflicts);
      if (c.resolvable !== undefined) {
        expect(engine.counts.resolvableConflicts === c.resolvable, tag + ": resolvable " + engine.counts.resolvableConflicts + ", Appendix A says " + c.resolvable);
      }
      expect(!!engine.eolMismatch === !!c.eolMismatch, tag + ": eolMismatch " + show(engine.eolMismatch));
      // The whole-merge buttons reproduce each side exactly (in Yours' EOL),
      // and every chip then reads 0.
      const eol = EOL[view.model.eol];
      view.acceptAllLeft();
      expect(view.getResultText() === norm(c.ours).split("\\n").join(eol), tag + ": Accept Yours wrote " + show(view.getResultText()) + ", Yours is " + show(c.ours));
      expect(CATS.every((cat) => chipCount(cat) === 0), tag + ": after Accept Yours every chip reads 0: " + CATS.map(chipCount));
      view.undo();
      expect(view.getResultText() === norm(c.base).split("\\n").join(eol), tag + ": undo returns to base: " + show(view.getResultText()));
      expect(CATS.every((cat) => chipCount(cat) === engineCats[cat]), tag + ": …and the chips count again: " + CATS.map(chipCount));
      view.acceptAllRight();
      expect(view.getResultText() === norm(c.theirs).split("\\n").join(eol), tag + ": Accept Theirs wrote " + show(view.getResultText()) + ", Theirs is " + show(c.theirs));
      // Ignoring every side leaves base, and settles everything.
      mount(c);
      for (const b of view.model.blocks) { view.ignoreSide(b, "left"); view.ignoreSide(b, "right"); }
      expect(view.getResultText() === norm(c.base).split("\\n").join(eol), tag + ": ignoring everything keeps base: " + show(view.getResultText()));
      expect(CATS.every((cat) => chipCount(cat) === 0), tag + ": …and settles every chip: " + CATS.map(chipCount));
    }
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("accept and ignore write exactly the chosen lines, in any order, at the file's edges, with CRLF and an empty base", { skip }, async () => {
  const v = await runMergePage(CHROME!, PROLOGUE + `
    const CASES = ${JSON.stringify(APPENDIX_A)};
    let seed = 923;
    const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const POOL = ["a", "b", "c", "", "a ", " b", "x", "y"];
    const mutate = (lines) => {
      const out = [];
      for (const l of lines) {
        const r = rnd();
        if (r < 0.15) continue;
        if (r < 0.3) { out.push(pick(POOL)); continue; }
        if (r < 0.4) { out.push(pick(POOL)); out.push(l); continue; }
        out.push(l);
      }
      if (rnd() < 0.3) out.push(pick(POOL));
      if (rnd() < 0.2) out.unshift(pick(POOL));
      return out;
    };
    const doc = (lines, crlf) => {
      const text = lines.join("\\n") + (lines.length && rnd() < 0.5 ? "\\n" : "");
      return crlf ? text.replace(/\\n/g, "\\r\\n") : text;
    };
    const cases = CASES.map((c) => ({ ...c, tag: "case " + c.n }));
    for (let i = 0; i < 70; i++) {
      const baseL = Array.from({ length: Math.floor(rnd() * 6) }, () => pick(POOL));
      const crlf = rnd();
      cases.push({
        tag: "random " + i,
        mode: pick(["none", "trailing", "all"]),
        base: doc(baseL, false),
        ours: doc(mutate(baseL), crlf < 0.2),
        theirs: doc(mutate(baseL), crlf > 0.8),
      });
    }
    let wrong = 0;
    for (const c of cases) {
      if (wrong >= 4) break;
      CUR = c;
      for (let round = 0; round < 3; round++) {
        mount(c);
        const blocks = [...view.model.blocks];
        // A random settling order, and a random choice per block.
        for (let k = blocks.length - 1; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)); [blocks[k], blocks[j]] = [blocks[j], blocks[k]]; }
        const chosen = new Map();
        const log = [];
        for (const b of blocks) {
          const sides = ["left", "right"].filter((s) => (s === "left" ? b.left : b.right));
          const choice = pick(["first", "second", "both", "ignore"]);
          const order = rnd() < 0.5 ? sides : [...sides].reverse();
          if (choice === "ignore" || sides.length === 0) {
            for (const s of order) view.ignoreSide(b, s);
            log.push(b.id + ":ignore");
            continue;
          }
          const first = choice === "second" && order.length > 1 ? order[1] : order[0];
          view.acceptSide(b, first, "auto");
          let lines = region(b, first);
          const other = order.find((s) => s !== first);
          if (other) {
            const done = view.isSideDone(b, other);
            if (choice === "both" && !done) {
              view.acceptSide(b, other, "auto");
              lines = [...lines, ...region(b, other)];
            } else if (!done) {
              view.ignoreSide(b, other);
            }
          }
          chosen.set(b.id, lines);
          log.push(b.id + ":" + first + (choice === "both" ? "+" + other : ""));
        }
        const want = oracle(chosen);
        const got = view.getResultText();
        if (got !== want) {
          wrong++;
          expect(false, c.tag + " (" + c.mode + ") " + show({ base: c.base, ours: c.ours, theirs: c.theirs }) + " choices " + log.join(",") + ": got " + show(got) + ", want " + show(want));
          break;
        }
        const pending = CATS.map(chipCount);
        if (pending.some((p) => p !== 0)) {
          wrong++;
          expect(false, c.tag + ": every block settled but the chips read " + pending);
          break;
        }
        // Undo walks back to base, exactly.
        while (view.canUndo()) view.undo();
        const baseText = norm(c.base).split("\\n").join(EOL[view.model.eol]);
        if (view.getResultText() !== baseText) {
          wrong++;
          expect(false, c.tag + ": undo to the start gave " + show(view.getResultText()) + ", base is " + show(baseText));
          break;
        }
      }
    }
    notes.cases = cases.length;
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("a conflict with one side taken is still pending, and the counts say its Result no longer holds the original text", { skip }, async () => {
  const v = await runMergePage(CHROME!, PROLOGUE + `
    CUR = { base: "one\\ntwo\\nthree\\nfour\\n", ours: "one\\ntwo\\nthree-test\\nfour\\n", theirs: "one\\ntwo\\nthree-master\\nfour\\n", mode: "none" };
    mount(CUR);
    const block = view.model.blocks[0];
    expect(counts.pending === 1 && counts.pendingChanged === 0, "fresh: pending and untouched " + show(counts));
    view.ignoreSide(block, "left");
    expect(counts.pending === 1 && counts.pendingChanged === 0, "ignoring Yours leaves the original text " + show(counts));
    view.undo();
    view.acceptSide(block, "left", "auto");
    expect(counts.pending === 1 && counts.pendingChanged === 1 && view.getResultText().includes("three-test"),
      "Yours taken, Theirs still open: pending, and changed " + show(counts));
    view.undo();
    view.result.getModel().applyEdits([{ range: new W.monaco.Range(3, 1, 3, 6), text: "by hand" }]);
    await sleep(200);
    expect(counts.pending === 1 && counts.pendingChanged === 1, "a hand edit in a pending block counts as changed " + show(counts));
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});
