import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { findChrome, runInChrome } from "./headless";
import { SELECTION_PROBE } from "./selectionProbe";

/**
 * The probe behind both selection sweeps (selectionProbe.js) has to SEE every
 * shape a line can take. A review appended nine shapes to the real surfaces
 * and every sweep passed over all of them: an underline on a tab whose words
 * sit in a child, a full-size ::after carrying a border side or an inset bar,
 * a border or an inset underline on a child, a ::before held at scaleY(0) and
 * switched on, an inset bar blurred 2px, and a drop-shadow filter. Each shape
 * here is a small list of rows, one of them in a state and wearing the shape;
 * the probe must report it. The rows that must NOT be reported (a tint and a
 * glow, a soft lift, a neutral sheen, a divider every row has, an avatar's
 * ring that follows its row's fill, a hover that deepens) stand beside them.
 *
 * A shape that slips past a sweep goes here first.
 */
const CHROME = findChrome();
const skip = CHROME ? false : "no windowless Chrome on this machine (set GS_CHROME)";
const ENTRY = fileURLToPath(new URL("./fixtures/probeShapesEntry.ts", import.meta.url));

const A = "#7c5cf0";
const BASE = `
  body { background: #1e1e1e; color: #cccccc; font: 13px/1.2 sans-serif; margin: 0; }
  .grp { position: relative; width: 320px; margin: 2px 4px; }
  .row { position: relative; height: 22px; display: flex; align-items: center; gap: 6px; padding: 0 8px; }
  .lbl, .word { white-space: nowrap; }
  .row.is-selected, .row.is-open, .row.is-hit, .row[aria-expanded="true"], .row.row--active, .row.jb-toggled { background: rgba(124, 92, 240, 0.22); color: #ffffff; }
`;

/** [what, the state, css (".X" is the group's row class), what must be reported: "line" | "hover" | "hc"] */
const SHAPES: [string, string, string, "line" | "hover" | "hc"][] = [
  ["a hard inset bar", "is-selected", `.X.is-selected { box-shadow: inset 3px 0 0 ${A}; }`, "line"],
  ["an inset bar blurred 2px", "is-selected", `.X.is-selected { box-shadow: inset 3px 0 2px ${A}; }`, "line"],
  ["an inset bar blurred 4px", "is-selected", `.X.is-selected { box-shadow: inset 2px 0 4px ${A}; }`, "line"],
  ["a hard outer underline", "is-selected", `.X.is-selected { box-shadow: 0 2px 0 ${A}; }`, "line"],
  ["an outer ring", "is-selected", `.X.is-selected { box-shadow: 0 0 0 1px ${A}; }`, "line"],
  ["a drop-shadow filter underline", "is-selected", `.X.is-selected { filter: drop-shadow(0 2px 0 ${A}); }`, "line"],
  ["a full-size ::after carrying a border side", "is-selected", `.X::after { content: ""; position: absolute; inset: 0; pointer-events: none; } .X.is-selected::after { border-left: 2px solid ${A}; }`, "line"],
  ["a full-size ::after carrying an inset bar", "is-selected", `.X.is-selected::after { content: ""; position: absolute; inset: 0; box-shadow: inset 2px 0 0 ${A}; }`, "line"],
  ["a full-size ::after carrying a ring", "is-selected", `.X.is-selected::after { content: ""; position: absolute; inset: 0; box-shadow: inset 0 0 0 1px ${A}; }`, "line"],
  ["a ::before held at scaleY(0) and switched on", "is-selected", `.X::before { content: ""; position: absolute; left: 0; top: 3px; bottom: 3px; width: 3px; background: ${A}; transform: scaleY(0); } .X.is-selected::before { transform: none; }`, "line"],
  ["a ::before grown from width 0", "is-selected", `.X::before { content: ""; position: absolute; left: 0; top: 3px; bottom: 3px; width: 0; background: ${A}; } .X.is-selected::before { width: 3px; }`, "line"],
  ["an ::after grown from height 0", "is-selected", `.X::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 0; background: ${A}; } .X.is-selected::after { height: 2px; }`, "line"],
  ["a ::before at opacity 0 switched on", "is-selected", `.X::before { content: ""; position: absolute; left: 0; top: 3px; bottom: 3px; width: 3px; background: ${A}; opacity: 0; } .X.is-selected::before { opacity: 1; }`, "line"],
  ["an underline whose words sit in children", "is-selected", `.X.is-selected { text-decoration: underline; }`, "line"],
  ["a border under a child's word", "is-selected", `.X.is-selected .word { border-bottom: 2px solid ${A}; }`, "line"],
  ["an inset underline on a child", "is-selected", `.X.is-selected .lbl { box-shadow: inset 0 -2px 0 ${A}; }`, "line"],
  ["an outline on a child", "is-selected", `.X.is-selected .lbl { outline: 1px solid ${A}; }`, "line"],
  ["an outer rule on a child", "is-selected", `.X.is-selected .lbl { box-shadow: 0 2px 0 ${A}; }`, "line"],
  ["a blurred inset bar on a child", "is-selected", `.X.is-selected .word { box-shadow: inset 3px 0 2px ${A}; }`, "line"],
  ["a child made into a bar", "is-selected", `.X.is-selected .lbl { display: inline-block; width: 3px; height: 16px; background: ${A}; overflow: hidden; }`, "line"],
  ["a child bar grown from width 0", "is-selected", `.X .lbl { display: inline-block; width: 0; height: 16px; background: ${A}; overflow: hidden; } .X.is-selected .lbl { width: 3px; }`, "line"],
  ["a child's ::after strip", "is-selected", `.X.is-selected .word::after { content: ""; display: block; height: 2px; background: ${A}; }`, "line"],
  ["a gradient with a hard stop", "is-selected", `.X.is-selected { background: linear-gradient(90deg, ${A} 0 3px, rgba(124, 92, 240, 0.22) 3px); }`, "line"],
  ["an open row's side border", "is-open", `.X.is-open { border-left: 2px solid ${A}; }`, "line"],
  ["an open menu trigger's underline", "aria-expanded", `.X[aria-expanded="true"] { text-decoration: underline; }`, "line"],
  ["a hit's inset bar", "is-hit", `.X.is-hit { box-shadow: inset 3px 0 0 ${A}; }`, "line"],
  ["a bar only under the pointer", "is-selected", `.X.is-selected:hover { box-shadow: inset 3px 0 0 ${A}; }`, "hover"],
  ["words that stop reading under the pointer", "is-selected", `.X.is-selected:hover { background: #e8e8e8; }`, "hover"],
  ["one side in High Contrast", "is-selected", `.X.is-selected { border-left: 2px solid #f38518; }`, "hc"],
  ["a BEM modifier's underline", "row--active", `.X.row--active { border-bottom: 2px solid ${A}; }`, "line"],
  ["a pressed toggle's ring", "jb-toggled", `.X.jb-toggled { box-shadow: 0 0 0 1px ${A}; }`, "line"],
];

const FINE: [string, string][] = [
  ["a tint and a glow", `.X.is-selected { box-shadow: 0 0 16px -4px rgba(124, 92, 240, 0.7); }`],
  ["the neutral sheen", `.X.is-selected { box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06); }`],
  ["soft lifts", `.X.is-selected { box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4), 0 4px 12px -2px rgba(124, 92, 240, 0.5); }`],
  ["a soft inset glow", `.X.is-selected { box-shadow: inset 0 0 12px -4px rgba(124, 92, 240, 0.6); }`],
  ["a soft drop-shadow filter", `.X.is-selected { filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.5)); }`],
  ["a divider every row has", `.X { border-bottom: 1px solid #444444; }`],
  ["a ::before held at opacity 0 on every row", `.X::before { content: ""; position: absolute; left: 0; top: 3px; bottom: 3px; width: 3px; background: ${A}; opacity: 0; }`],
  ["an avatar's ring that follows its row's fill", `.X .lbl { box-shadow: 0 0 0 2px #1e1e1e; } .X.is-selected .lbl { box-shadow: 0 0 0 2px #3a2f6b; }`],
  ["a hover that deepens the tint", `.X.is-selected:hover { background: rgba(124, 92, 240, 0.32); }`],
  ["a link underline every row has", `.X .word { text-decoration: underline; }`],
  ["a hover mark every row wears", `.X:hover { box-shadow: inset 2px 0 0 #555555; }`],
];
/** Allowed in High Contrast only: VS Code's whole ring. */
const HC_FINE = `.X.is-selected { outline: 1px dashed #f38518; outline-offset: -1px; }`;

const cls = (prefix: string, i: number) => `${prefix}-${String(i).padStart(2, "0")}`;

test("the selection probe reports every shape a line can take, and nothing that is not one", { skip }, async () => {
  const css = [
    BASE,
    ...SHAPES.map(([, , c], i) => c.replace(/\.X\b/g, "." + cls("shape", i))),
    ...FINE.map(([, c], i) => c.replace(/\.X\b/g, "." + cls("fine", i))),
    HC_FINE.replace(/\.X\b/g, ".hcfine"),
  ].join("\n");
  const groups = [
    ...SHAPES.map(([, state], i) => [cls("shape", i), state]),
    ...FINE.map((_, i) => [cls("fine", i), "is-selected"]),
    ["hcfine", "is-selected"],
  ];
  const script = `
    ${SELECTION_PROBE}
    const style = document.createElement("style");
    style.textContent = ${JSON.stringify(css)};
    document.head.appendChild(style);
    const root = document.getElementById("root");
    for (const [c, state] of ${JSON.stringify(groups)}) {
      const g = document.createElement("div");
      g.className = "grp";
      for (let i = 0; i < 3; i++) {
        const r = document.createElement("div");
        r.className = "row " + c;
        r.innerHTML = '<span class="lbl">Row ' + i + '</span><span class="word">feature/checkout</span>';
        if (i === 1) {
          if (state === "aria-expanded") r.setAttribute("aria-expanded", "true");
          else r.classList.add(state);
        }
        g.appendChild(r);
      }
      root.appendChild(g);
    }
    const plain = window.gsSelectionProbe({ hc: false });
    const hc = window.gsSelectionProbe({ hc: true });
    notes.plain = [...plain.lines, ...plain.contrast];
    notes.hc = [...hc.lines, ...hc.contrast];
  `;
  const v = await runInChrome(CHROME!, ENTRY, script, { width: 400, height: 2400, css: "html,body{overflow:visible!important;height:auto!important}" });
  assert.deepEqual(v.fails, []);
  const notes = (v as unknown as { notes: { plain: string[]; hc: string[] } }).notes;
  const about = (list: string[], c: string) => list.filter((m) => m.includes("." + c + ".") || m.includes("." + c + " ") || m.includes("." + c + ":") || m.includes("." + c + '"'));
  const missed: string[] = [];
  SHAPES.forEach(([what, , c, must], i) => {
    const found = about(must === "hc" ? notes.hc : notes.plain, cls("shape", i));
    const ok = must === "hover" ? found.some((m) => m.startsWith("on hover: ")) : found.length > 0;
    if (!ok) missed.push(`not seen: ${what} (${c.trim()})`);
  });
  const cried: string[] = [];
  FINE.forEach(([what], i) => {
    for (const list of [notes.plain, notes.hc]) {
      for (const m of about(list, cls("fine", i))) cried.push(`flagged, but ${what} is not a line: ${m}`);
    }
  });
  for (const m of about(notes.hc, "hcfine")) cried.push(`flagged in High Contrast, but a whole ring is its selection mark: ${m}`);
  assert.deepEqual([...missed, ...cried], []);
});
