import { test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, runMergePage, type PageTheme } from "./fixtures/mergeViewPage";

/**
 * The owner's colours, painted the way JetBrains paints them (24 Sep 2026:
 * "#C2D7F2 highlights the diffs in text and uses this colour in the columns,
 * #E6EFFA is used in the lines"):
 *
 * - an open change's line-number column, and its ribbon across the gutter:
 *   the FULL colour;
 * - its lines: the LIGHTER colour, with the changed words in the full one
 *   where the change has words to compare (JetBrains' rule, decorations.ts
 *   comparedByWords) — an insertion's and a deletion's lines too, with no
 *   word marked (the owner: the solid full-colour blocks were the part that
 *   was not pale enough);
 * - a settled side's trace: the lighter colour, line numbers too, and a
 *   lighter ribbon;
 * - nothing drawn between the line numbers and the code.
 *
 * Measured as the eye gets it: every overlay Monaco painted at a point of a
 * line, composited in paint order over the editor background — so two
 * decorations tinting one line show up as the wrong colour, not as a pass.
 * Asserted on the real MergeView, Monaco and diff.css (fixtures/
 * mergeViewEntry.ts: one block of every kind).
 */

const CHROME = findChrome();
const skip = !CHROME && "no Chrome on this machine";

const MOUNT = `
  const W = gsMerge;
  const view = new W.MergeView(host);
  view.setRenderOptions({ whitespace: "trailing" });
  view.render(W.payload());
  const panes = { left: view.left, result: view.result, right: view.right };
  const parse = (c) => { const m = c.match(/[\\d.]+/g).map(Number); return m.length === 3 ? [...m, 1] : m; };
  const over = (c, bg) => [0, 1, 2].map((i) => c[i] * c[3] + bg[i] * (1 - c[3]));
  const hex = (rgb) => "#" + rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  const BG = parse(getComputedStyle(document.body).getPropertyValue("--vscode-editor-background").trim().replace(/^#(..)(..)(..)$/, (_, r, g, b) => "rgb(" + [r, g, b].map((h) => parseInt(h, 16)).join(",") + ")"));
  /** A token as the eye gets it over the editor (or over another colour). */
  const token = (name, under) => {
    const el = document.createElement("div");
    el.style.cssText = "position:absolute;width:4px;height:4px;background-color:var(" + name + ")";
    document.body.appendChild(el);
    const c = parse(getComputedStyle(el).backgroundColor);
    el.remove();
    return hex(over(c, under || BG));
  };
  const lighter = (tone) => token("--jb-line-" + tone);
  const full = (tone) => token("--jb-full-" + tone);
  /** The page point at the middle of a line: in the line-number column, past the text, or on an element. */
  const at = (pane, line, where) => {
    const ed = panes[pane];
    ed.render(true);
    const dom = ed.getDomNode();
    const r = dom.getBoundingClientRect();
    const lh = ed.getOption(W.monaco.editor.EditorOption.lineHeight);
    const y = r.top + ed.getTopForLineNumber(line) - ed.getScrollTop() + lh / 2;
    if (where === "margin") return { dom, layer: ".margin-view-overlays", x: dom.querySelector(".margin").getBoundingClientRect().left + 6, y };
    // The content: the overlays (whole-line tints) under the text, then the
    // text's own spans (word tints are inline spans of the text).
    if (where === "line") return { dom, layer: ".lines-content", x: r.right - 30, y };
    const e = where.getBoundingClientRect();
    return { dom, layer: ".lines-content", x: e.left + e.width / 2, y };
  };
  /** Everything painted at that point, in paint order, over the editor background. */
  const seen = (pane, line, where) => {
    const { dom, layer, x, y } = at(pane, line, where);
    let rgb = BG;
    for (const el of dom.querySelectorAll(layer + " *")) {
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height || x < b.left || x >= b.right || y < b.top || y >= b.bottom) continue;
      const c = parse(getComputedStyle(el).backgroundColor);
      if (c[3] > 0) rgb = over(c, rgb);
    }
    return hex(rgb);
  };
  /** The word tints Monaco painted on a line of a pane. */
  const wordsOn = (pane, line, tone) => {
    const { dom, y } = at(pane, line, "line");
    return [...dom.querySelectorAll(".view-lines .jb-inner-" + tone)].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && y >= b.top && y < b.bottom; });
  };
  /** A ribbon's fill, over the editor background it is drawn on. */
  const ribbon = (cls) => {
    const p = document.querySelector(".jb-ribbon-stage path." + cls);
    return p ? hex(over(parse(getComputedStyle(p).fill), BG)) : "none";
  };
  /** Two colours the same to within a rounding step per channel. */
  const same = (a, b) => a.length === 7 && b.length === 7 && [1, 3, 5].every((i) => Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)) <= 1);
`;

test("light: the owner's exact colours — the columns full, every line lighter, the words full where there are words to compare", { skip }, async () => {
  const v = await runMergePage(CHROME!, MOUNT + `
    const OWNER = {
      conflict: { full: "#fed5cc", lighter: "#ffeeeb" },
      same: { full: "#9edcaa", lighter: "#d8f1dd" },
      "one-sided": { full: "#c2d7f2", lighter: "#e6effa" },
      removed: { full: "#d6d6d6", lighter: "#efefef" },
    };
    for (const [tone, want] of Object.entries(OWNER)) {
      expect(same(full(tone), want.full) && same(lighter(tone), want.lighter), tone + ": the tokens land on the owner's " + want.full + " / " + want.lighter + ": " + full(tone) + " / " + lighter(tone));
    }
    // [pane, line, tone, lines: "lighter" | "full", words expected]
    const CASES = [
      ["left", 2, "conflict", "lighter", true],     // #0: three texts to compare
      ["result", 2, "conflict", "lighter", true],
      ["right", 2, "conflict", "lighter", true],
      ["left", 7, "same", "lighter", true],         // #2: the same change on both sides
      ["right", 7, "same", "lighter", true],
      ["left", 11, "one-sided", "lighter", true],   // #4: a line changed in Yours
      ["result", 11, "one-sided", "lighter", true],
      ["right", 13, "one-sided", "lighter", false], // #5: an insertion in Theirs — text on one pane only
      ["result", 14, "removed", "lighter", false],  // #6: a deletion in Theirs — text on one pane only
      ["left", 16, "one-sided", "lighter", false],  // #7: whitespace only — lighter, no word tint
    ];
    const rows = [];
    for (const [pane, line, tone, lines, words] of CASES) {
      const want = OWNER[tone];
      const margin = seen(pane, line, "margin");
      const body = seen(pane, line, "line");
      const tints = wordsOn(pane, line, tone);
      const word = tints.length ? seen(pane, line, tints[0]) : "none";
      rows.push(pane + ":" + line + " " + tone + " column " + margin + " line " + body + " word " + word);
      expect(same(margin, want.full), pane + " " + line + ": the " + tone + " line-number column is the full " + want.full + ": " + margin);
      expect(same(body, want[lines]), pane + " " + line + ": the " + tone + " line is the " + lines + " " + want[lines] + ": " + body);
      if (words) {
        expect(tints.length > 0 && same(word, want.full), pane + " " + line + ": a changed word is the full " + want.full + ": " + word + " (" + tints.length + " word tints)");
      } else {
        expect(tints.length === 0, pane + " " + line + ": no word tints — " + (line === 16 ? "only whitespace changed" : "nothing to compare") + " (" + tints.length + ")");
      }
    }
    notes.rows = rows;
    // The ribbons across the gutters (painted on the 32 ms overlay timer): the
    // full colour, one strong column with the line numbers they run into.
    await sleep(80);
    for (const [tone, want] of Object.entries(OWNER)) {
      expect(same(ribbon("jb-ribbon-" + tone), want.full), "the " + tone + " ribbon is the full " + want.full + ": " + ribbon("jb-ribbon-" + tone));
    }
    // Nothing between the numbers and the code: no decoration draws in the
    // lines-decorations column, and no bar is painted there.
    for (const p of ["left", "result", "right"]) {
      const odd = panes[p].getModel().getAllDecorations().filter((d) => d.options.linesDecorationsClassName || d.options.glyphMarginClassName);
      expect(odd.length === 0, p + ": nothing in the column between the numbers and the code: " + JSON.stringify(odd.map((d) => d.options.linesDecorationsClassName || d.options.glyphMarginClassName)));
      const barred = [...panes[p].getDomNode().querySelectorAll(".margin-view-overlays *")].filter((e) => parseFloat(getComputedStyle(e).borderLeftWidth) > 0);
      expect(barred.length === 0, p + ": no bar beside the line numbers (" + barred.length + ")");
    }
  `, { theme: "light" });
  assert.deepEqual(v.fails, [], v.fails.join("\n") + "\n" + JSON.stringify(v.notes?.rows, null, 1));
});

test("every theme: the same structure — full columns and words, lighter lines, and a lighter trace once a side is settled", { skip }, async () => {
  for (const theme of ["dark", "light", "hc-dark", "hc-light"] as PageTheme[]) {
    const v = await runMergePage(CHROME!, MOUNT + `
      const t = "${theme}";
      const check = (pane, line, tone, lines, words) => {
        const margin = seen(pane, line, "margin");
        const body = seen(pane, line, "line");
        expect(same(margin, full(tone)), t + " " + pane + " " + line + ": the " + tone + " column is full " + full(tone) + ": " + margin);
        expect(same(body, lines === "full" ? full(tone) : lighter(tone)), t + " " + pane + " " + line + ": the " + tone + " line is " + lines + ": " + body + " (full " + full(tone) + ", lighter " + lighter(tone) + ")");
        const tints = wordsOn(pane, line, tone);
        if (words) {
          const w = tints.length ? seen(pane, line, tints[0]) : "none";
          expect(same(w, full(tone)), t + " " + pane + " " + line + ": a " + tone + " word lands on the full colour " + full(tone) + ": " + w);
        }
        // The lighter colour is a real step from the full one, and both show.
        expect(lighter(tone) !== full(tone) && lighter(tone) !== hex(BG), t + ": " + tone + " has two strengths over the editor: " + full(tone) + " / " + lighter(tone));
      };
      check("left", 2, "conflict", "lighter", true);
      check("right", 7, "same", "lighter", true);
      check("left", 11, "one-sided", "lighter", true);
      check("right", 13, "one-sided", "lighter", false);
      check("result", 14, "removed", "lighter", false);
      await sleep(80);
      expect(same(ribbon("jb-ribbon-conflict"), full("conflict")), t + ": an open ribbon is the full colour: " + ribbon("jb-ribbon-conflict"));

      // Take Yours on the first conflict: Yours keeps a TRACE — the lighter
      // colour, line numbers too, no word tint — and a lighter ribbon to the
      // Result, which is the lighter colour too; Theirs, still to decide,
      // keeps its full column.
      view.acceptSide(view.model.blocks[0], "left", "auto");
      await sleep(80);
      const trace = lighter("conflict");
      expect(same(seen("left", 2, "margin"), trace) && same(seen("left", 2, "line"), trace), t + ": the taken side's trace is the lighter colour, numbers too: " + seen("left", 2, "margin") + " / " + seen("left", 2, "line"));
      expect(wordsOn("left", 2, "conflict").length === 0, t + ": the trace has no word tints");
      expect(same(ribbon("jb-ribbon-trace-conflict"), trace), t + ": its ribbon to the Result is the lighter colour: " + ribbon("jb-ribbon-trace-conflict"));
      expect(same(seen("result", 2, "margin"), trace) && same(seen("result", 2, "line"), trace), t + ": the half-decided Result is the lighter colour: " + seen("result", 2, "margin") + " / " + seen("result", 2, "line"));
      expect(same(seen("right", 2, "margin"), full("conflict")), t + ": Theirs, still to decide, keeps its full column: " + seen("right", 2, "margin"));
    `, { theme });
    assert.deepEqual(v.fails, [], `${theme}:\n${v.fails.join("\n")}`);
  }
});

test("with word highlighting off, every open change is its lighter lines and full column, no word marked", { skip }, async () => {
  const v = await runMergePage(CHROME!, MOUNT + `
    view.setRenderOptions({ showInner: false });
    for (const [pane, line, tone] of [["left", 2, "conflict"], ["right", 7, "same"], ["left", 11, "one-sided"], ["result", 14, "removed"]]) {
      expect(same(seen(pane, line, "line"), lighter(tone)) && same(seen(pane, line, "margin"), full(tone)), pane + " " + line + ": " + tone + " lines lighter, numbers full: " + seen(pane, line, "line") + " / " + seen(pane, line, "margin"));
      expect(wordsOn(pane, line, tone).length === 0, pane + " " + line + ": no word tints");
    }
  `, { theme: "light" });
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});
