import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { findChrome, runInChrome } from "./headless";

/**
 * The conflicts list as a GRID (the owner, 24 Sep 2026: "the buttons and pills
 * are not aligned well and create a huge mess, everything is everywhere").
 * Each row right-aligned whatever buttons it had, so a binary row's Accept
 * Theirs sat under a text row's Merge…, and a pill floated against the first
 * button. Now every row has the same cells — status | file | pill | three
 * action slots by role — and these checks measure that on screen, over every
 * kind of row the dashboard draws, at a wide, a narrow and a compact width.
 *
 * Slots are read off each button's data-key (accept:<role>, merge, delete,
 * restore), not off a class this change added, so the same measurement runs
 * against the old list too — and fails there.
 *
 * The second half is the owner's other three points about the same list: row
 * hover too dark, button hover with "almost no effect", and Accept Yours /
 * Accept Theirs with a blue edge beside a purple Merge…. Hover, pressed and
 * keyboard focus are forced by copying each :hover / :active / :focus-visible
 * rule of the stylesheet to a class, in place, so the cascade is the real one.
 */
const ENTRY = fileURLToPath(new URL("./fixtures/dashboardEntry.ts", import.meta.url));
const CHROME = findChrome();
const STYLES = ["tokens.css", "conflicts.css"]
  .map((f) => readFileSync(fileURLToPath(new URL(`../src/styles/${f}`, import.meta.url)), "utf8"))
  .join("\n")
  .replace(/@import[^;]+;/g, "");

/** VS Code's Dark Modern / Light Modern values for what the list paints from. */
const THEMES = {
  dark: {
    body: "vscode-dark",
    vars: {
      "--vscode-foreground": "#cccccc",
      "--vscode-descriptionForeground": "#9d9d9d",
      "--vscode-errorForeground": "#f85149",
      "--vscode-focusBorder": "#0078d4",
      "--vscode-editor-background": "#1f1f1f",
      "--vscode-editorWidget-background": "#202020",
      "--vscode-widget-border": "#313131",
      "--vscode-list-hoverBackground": "#2a2d2e",
      "--vscode-button-border": "#ffffff12",
      "--vscode-button-secondaryBackground": "#313131",
      "--vscode-button-secondaryForeground": "#cccccc",
      "--vscode-button-secondaryHoverBackground": "#3c3c3c",
      "--vscode-charts-green": "#89d185",
      "--vscode-charts-red": "#f14c4c",
      "--vscode-charts-blue": "#3794ff",
      "--vscode-gitDecoration-conflictingResourceForeground": "#e4676b",
      "--vscode-sideBar-background": "#181818",
    },
  },
  light: {
    body: "vscode-light",
    vars: {
      "--vscode-foreground": "#3b3b3b",
      "--vscode-descriptionForeground": "#3b3b3b",
      "--vscode-errorForeground": "#f85149",
      "--vscode-focusBorder": "#005fb8",
      "--vscode-editor-background": "#ffffff",
      "--vscode-editorWidget-background": "#f8f8f8",
      "--vscode-widget-border": "#e5e5e5",
      "--vscode-list-hoverBackground": "#f2f2f2",
      "--vscode-button-border": "#0000001a",
      "--vscode-button-secondaryBackground": "#e5e5e5",
      "--vscode-button-secondaryForeground": "#3b3b3b",
      "--vscode-button-secondaryHoverBackground": "#cccccc",
      "--vscode-charts-green": "#388a34",
      "--vscode-charts-red": "#e51400",
      "--vscode-charts-blue": "#1a85ff",
      "--vscode-gitDecoration-conflictingResourceForeground": "#ad0707",
      "--vscode-sideBar-background": "#f8f8f8",
    },
  },
} as const;

const PROLOGUE = `
  const { ConflictsDashboard, FakeClock, HOLD_TO_UNDO_MS } = window.__dash;
  const side = (role, stage, name) => ({ role, stage, name, paneTitle: name, description: name });
  const OP = {
    kind: "merge", title: "Merging feature/login into main",
    direction: { from: "theirs", verb: "into", to: "yours" },
    yours: side("yours", 2, "main"), theirs: side("theirs", 3, "feature/login"),
    verbs: { continue: "Continue Merge", abort: "Abort Merge" }, canContinue: false, canSkip: false, episode: "merge:1",
  };
  const row = (path, over) => ({ path, status: "pending", shape: "text", ...over });
  // Every kind of row the list draws.
  const ROWS = [
    row("src/app.ts"),
    row("packages/webview-ui/src/conflicts/dashboard.ts"),
    row("assets/logo.png", { shape: "binary" }),
    row("docs/notes.md", { shape: "modify-delete", missingRole: "theirs", badge: "deleted in theirs (feature/login)" }),
    row("legacy.py", { shape: "modify-delete", missingRole: "yours", badge: "deleted in yours (main)" }),
    row("gone.txt", { shape: "both-deleted" }),
    row("new.txt", { shape: "added-both", badge: "added in both" }),
    row("README.md", { status: "resolved", choice: "yours" }),
    row("cases/whitespace.txt", { status: "resolved", choice: "theirs" }),
    row("f.txt", { status: "resolved", choice: "merged" }),
    row("src/busy.ts", { status: "busy" }),
  ];
  const state = (files, over) => ({
    brand: { name: "GitStudio", mark: "gitstudio" }, repoName: "demo", op: OP, files,
    total: files.length, resolved: files.filter((f) => f.status === "resolved").length,
    busy: false, holdToUndoMs: HOLD_TO_UNDO_MS, ...over,
  });
  const theme = (t) => {
    document.body.className = t.body;
    for (const [k, v] of Object.entries(t.vars)) document.documentElement.style.setProperty(k, v);
  };
  const mount = () => new ConflictsDashboard(document.getElementById("root"), { post: () => {}, timers: new FakeClock() });
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const box = (e) => e.getBoundingClientRect();
  const same = (xs, tol = 0.6) => xs.length === 0 || Math.max(...xs) - Math.min(...xs) <= tol;
  const px = (xs) => xs.map((x) => Math.round(x * 10) / 10).join(", ");
  /** Which of the three action slots a button belongs in, from what it sends. */
  const slotOf = (b) => {
    const k = b.dataset.key || "";
    if (k.startsWith("accept:yours:") || k.startsWith("delete:") || k.startsWith("restore:")) return "yours";
    if (k.startsWith("accept:theirs:")) return "theirs";
    if (k.startsWith("merge:")) return "merge";
    return "?";
  };
  // ── colour arithmetic (the computed value may be rgb() or color(srgb …)) ──
  const rgba = (c) => {
    let m = /rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?/.exec(c);
    if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
    m = /color\\(srgb ([\\d.]+) ([\\d.]+) ([\\d.]+)(?: \\/ ([\\d.]+))?/.exec(c);
    if (m) return [m[1] * 255, m[2] * 255, m[3] * 255, m[4] === undefined ? 1 : +m[4]];
    return [0, 0, 0, 0];
  };
  const over = (top, under) => {
    const a = top[3];
    return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1);
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const hue = (c) => {
    const [r, g, b] = c.slice(0, 3).map((v) => v / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (d < 1e-6) return NaN;
    const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };
  const sat = (c) => { const mx = Math.max(...c.slice(0, 3)), mn = Math.min(...c.slice(0, 3)); return mx === 0 ? 0 : (mx - mn) / mx; };
  /** The opaque colour an element actually shows: its background over every ancestor's, down to the page. */
  const ground = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.backgroundImage && s.backgroundImage !== "none") {
        const g = /linear-gradient\\((rgba?\\([^)]*\\)|color\\([^)]*\\))/.exec(s.backgroundImage);
        if (g) layers.push(rgba(g[1]));
      }
      layers.push(rgba(s.backgroundColor));
    }
    let c = [255, 255, 255, 1];
    for (const l of layers.reverse()) c = over(l, c);
    return c;
  };
  /**
   * Copy every :hover / :active / :focus-visible rule to a .force-hover /
   * .force-active / .force-focus twin, right after the original, so adding the
   * class paints exactly what the pointer or the keyboard would.
   */
  const forceable = () => {
    // End states, not the first frame of a transition (headless time stands
    // still, and a computed colour mid-transition is the one it started from).
    const still = document.createElement("style");
    still.textContent = "*,*::before,*::after{transition:none!important;animation:none!important}";
    document.head.appendChild(still);
    const walk = (list) => {
      for (let i = list.cssRules.length - 1; i >= 0; i--) {
        const r = list.cssRules[i];
        if (r.cssRules && !(r instanceof CSSStyleRule)) { walk(r); continue; }
        if (!(r instanceof CSSStyleRule) || !/:(hover|active|focus-visible)/.test(r.selectorText)) continue;
        const sel = r.selectorText.replace(/:hover/g, ".force-hover").replace(/:active/g, ".force-active").replace(/:focus-visible/g, ".force-focus");
        list.insertRule(sel + "{" + r.style.cssText + "}", i + 1);
      }
    };
    for (const sh of document.styleSheets) walk(sh);
  };
`;

const run = (script: string, width = 960) =>
  runInChrome(CHROME!, ENTRY, PROLOGUE + script, {
    css: `${STYLES}\n#root{height:1100px;width:${width}px;overflow:auto}`,
    width: 1000,
    height: 1200,
  });

const skip = !CHROME && "no Chrome on this machine";

/** The alignment measurement, shared by every width. `mode` is what the width should produce. */
const ALIGN = (mode: "wide" | "narrow" | "compact", t: (typeof THEMES)[keyof typeof THEMES] = THEMES.dark) => `
  theme(${JSON.stringify(t)});
  const d = mount();
  d.render(state(ROWS));
  const rows = $$(".cd-row");
  expect(rows.length === ROWS.length, "every file has a row (" + rows.length + ")");

  // Every row the same height: one line when wide, the name and its actions when
  // not. (Inside its borders: the last row has no rule under it.)
  const heights = rows.map((r) => box(r).height - parseFloat(getComputedStyle(r).borderBottomWidth));
  expect(same(heights), "rows are one height (" + px(heights) + ")");

  // The three action slots: each button's left edge and width the same down the list.
  const bySlot = { yours: [], theirs: [], merge: [] };
  for (const r of rows) for (const b of $$("button", r)) {
    const s = slotOf(b);
    expect(s !== "?", r.dataset.path + ": a row button with no slot (" + b.dataset.key + ")");
    if (bySlot[s]) bySlot[s].push(b);
  }
  for (const [s, bs] of Object.entries(bySlot)) {
    expect(bs.length >= 2, "precondition: several rows have a " + s + " button (" + bs.length + ")");
    const lefts = bs.map((b) => box(b).left);
    // (Hold to undo takes two slots where the labels are cut short.)
    const widths = bs.filter((b) => !b.classList.contains("cd-undo-hold")).map((b) => box(b).width);
    expect(same(lefts), "the " + s + " slot starts at one x on every row (" + px(lefts) + ")");
    expect(same(widths), "the " + s + " slot is one width on every row (" + px(widths) + ")");
  }
  expect(box(bySlot.yours[0]).right < box(bySlot.theirs[0]).left && box(bySlot.theirs[0]).right < box(bySlot.merge[0]).left,
    "the slots read yours | theirs | merge, left to right");
  // Hold to undo sits in the resolved row's action column, where Accept Yours is on the others.
  const hold = $(".cd-undo-hold");
  const acceptYours = bySlot.yours.find((b) => /^accept:yours:/.test(b.dataset.key));
  expect(hold && acceptYours && Math.abs(box(hold).left - box(acceptYours).left) < 0.6,
    "Hold to undo starts where Accept Yours does (" + (hold && px([box(hold).left])) + " vs " + (acceptYours && px([box(acceptYours).left])) + ")");

  // The pills: one column, left-aligned in it, one line each.
  const pills = $$(".cd-badge, .cd-choice");
  expect(pills.length >= 6, "precondition: the badges and the resolved rows' pills (" + pills.length + ")");
  const pl = pills.map((p) => box(p).left);
  expect(same(pl), "every pill starts at one x (" + px(pl) + ")");
  for (const p of pills) expect(box(p).height <= 20, p.textContent + ": the pill is one line (" + Math.round(box(p).height) + "px)");

  // Buttons: hit targets, and every label whole (never cut off by its slot).
  for (const b of $$(".cd-row button")) {
    expect(box(b).height >= 24, b.dataset.key + ": " + Math.round(box(b).height) + "px high");
    const label = $(".cd-btn-label, .cd-undo-label", b) || b;
    expect(label.scrollWidth <= label.clientWidth + 0.5, b.dataset.key + ": its label is whole (" + label.scrollWidth + " > " + label.clientWidth + ")");
  }
  // Nothing runs out of its row, and the name is always on screen.
  for (const r of rows) {
    const rb = box(r);
    for (const e of $$("button, .cd-badge, .cd-choice", r)) {
      const eb = box(e);
      expect(eb.left >= rb.left - 0.5 && eb.right <= rb.right + 0.5, r.dataset.path + ": " + (e.dataset.key || e.textContent) + " stays in its row");
    }
    const name = $(".cd-name", r);
    expect(name.scrollWidth <= name.clientWidth + 0.5, r.dataset.path + ": the file name is whole");
  }

  const nameRow = rows[0];
  const firstBtn = $$("button", nameRow)[0];
  if (${JSON.stringify(mode)} === "wide") {
    // One line: the buttons beside the name, not under it.
    expect(box(firstBtn).top < box($(".cd-name", nameRow)).bottom, "wide: the actions are on the name's line");
    // The footer on the same edges: Abort under the status column, Continue under Merge….
    const cont = $$(".cd-foot button").find((b) => /Continue/.test(b.textContent));
    const abort = $$(".cd-foot button").find((b) => /Abort/.test(b.textContent));
    expect(Math.abs(box(cont).right - box(bySlot.merge[0]).right) < 1, "Continue ends where Merge… ends (" + px([box(cont).right, box(bySlot.merge[0]).right]) + ")");
    expect(Math.abs(box(abort).left - box($(".cd-status", nameRow) || nameRow.firstElementChild).left) < 1, "Abort starts at the status column");
    // The header block, the direction bar and the commit line each hold one line here.
    expect(box($(".cd-head")).height <= 34, "the header is one line (" + Math.round(box($(".cd-head")).height) + "px)");
  } else {
    // Under the name, starting where the name starts, as one group on one line.
    expect(box(firstBtn).top >= box($(".cd-name", nameRow)).bottom, "narrow: the actions drop under the name");
    const file = box($(".cd-file", nameRow));
    expect(Math.abs(box(bySlot.yours[0]).left - file.left) < 1, "and start where the name starts (" + px([box(bySlot.yours[0]).left, file.left]) + ")");
    for (const r of rows) {
      const tops = new Set($$("button", r).map((b) => Math.round(box(b).top)));
      expect(tops.size <= 1, r.dataset.path + ": its buttons share one line");
    }
  }
  if (${JSON.stringify(mode)} === "compact") {
    // The words the slot already says are gone from sight, never from the text.
    const ay = acceptYours;
    expect(ay.textContent.trim() === "Accept Yours", "Accept Yours keeps its text (" + ay.textContent + ")");
    expect(box($(".cd-btn-label", ay)).width < 60, "and shows only 'Yours' (" + Math.round(box($(".cd-btn-label", ay)).width) + "px)");
  }
  // The folder of a deep path is cut in the MIDDLE, never the name.
  const deep = rows.find((r) => r.dataset.path.startsWith("packages/"));
  const head = $(".cd-dir-head", deep), tail = $(".cd-dir-tail", deep);
  if (head && tail && head.scrollWidth > head.clientWidth + 0.5) {
    expect(tail.clientWidth > 0, "a cut folder path keeps the folder the file is in (" + tail.textContent + ")");
  }
`;

test("the list is a grid: every row's actions in three aligned slots, the pills in one column (wide)", { skip }, async () => {
  const v = await run(ALIGN("wide"), 960);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("…still one line at a 720px dashboard (a 900 px editor panel, the desktop's 1280 px window)", { skip }, async () => {
  const v = await run(ALIGN("wide", THEMES.light), 720);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("below ~700px the actions drop under the name, still in their slots (narrow)", { skip }, async () => {
  for (const w of [640, 443]) {
    const v = await run(ALIGN("narrow"), w);
    assert.deepEqual(v.fails, [], `at ${w}px:\n` + v.fails.join("\n"));
  }
});

test("in the desktop's 340px pane the slots keep their labels by dropping the words they imply (compact)", { skip }, async () => {
  const v = await run(ALIGN("compact"), 343);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

for (const [name, t] of Object.entries(THEMES)) {
  test(`${name === "dark" ? "Dark" : "Light"} Modern: one purple family, a hover you can see, a subtle row hover, a keyboard ring, a grey disabled`, { skip }, async () => {
    const v = await run(`
      theme(${JSON.stringify(t)});
      forceable();
      const d = mount();
      d.render(state(ROWS));
      const r = $('.cd-row[data-path="src/app.ts"]');
      const yours = $('[data-key="accept:yours:src/app.ts"]');
      const theirs = $('[data-key="accept:theirs:src/app.ts"]');
      const merge = $('[data-key="merge:src/app.ts"]');
      const brand = rgba(getComputedStyle(merge).backgroundColor);
      expect(Math.round(brand[0]) === 116 && Math.round(brand[1]) === 88 && Math.round(brand[2]) === 232, "Merge… is the brand fill #7458e8 (" + brand.map(Math.round) + ")");

      for (const b of [yours, theirs]) {
        const s = getComputedStyle(b);
        const edge = rgba(s.borderTopColor), ink = rgba(s.color), fill = rgba(s.backgroundColor);
        expect(Math.abs(hue(edge) - hue(brand)) < 12, b.textContent + ": its edge is Merge…'s purple, not blue (hue " + Math.round(hue(edge)) + " vs " + Math.round(hue(brand)) + ")");
        expect(Math.abs(hue(ink) - hue(brand)) < 12, b.textContent + ": its text is the same purple (hue " + Math.round(hue(ink)) + ")");
        expect(fill[3] === 0, b.textContent + ": no fill at rest (" + s.backgroundColor + ")");
        expect(s.outlineStyle === "none", b.textContent + ": no ring at rest (" + s.outlineStyle + ")");
        const c = ratio(ink, ground(b));
        expect(c >= 4.5, b.textContent + ": its text reads at " + c.toFixed(2) + ":1");
      }

      // Hover: a fill you can see, on all three. Pressed: a step past hover.
      const rest = { yours: ground(yours), merge: ground(merge) };
      yours.classList.add("force-hover"); merge.classList.add("force-hover"); r.classList.add("force-hover");
      const hover = { yours: ground(yours), merge: ground(merge) };
      expect(ratio(hover.yours, rest.yours) >= 1.18, "Accept Yours' hover shows (" + ratio(hover.yours, rest.yours).toFixed(2) + ":1 against rest)");
      expect(Math.abs(hue(hover.yours) - hue(brand)) < 15, "and it is a purple tint (hue " + Math.round(hue(hover.yours)) + ")");
      expect(ratio(hover.merge, rest.merge) >= 1.25, "Merge…'s hover shows (" + ratio(hover.merge, rest.merge).toFixed(2) + ":1 against rest)");
      expect(lum(hover.merge) < lum(rest.merge), "and it is a DARKER purple");
      const hc = ratio(rgba(getComputedStyle(yours).color), hover.yours);
      expect(hc >= 4.5, "Accept Yours' text still reads on its hover (" + hc.toFixed(2) + ":1)");
      yours.classList.add("force-active"); merge.classList.add("force-active");
      expect(ratio(ground(yours), hover.yours) >= 1.1, "pressing Accept Yours goes past its hover (" + ratio(ground(yours), hover.yours).toFixed(2) + ")");
      expect(ratio(ground(merge), hover.merge) >= 1.1, "pressing Merge… goes past its hover (" + ratio(ground(merge), hover.merge).toFixed(2) + ")");
      for (const b of [yours, merge]) b.classList.remove("force-hover", "force-active");

      // The row hover: a wash, not a block — visible, and gentle, on a dark and a light ground.
      r.classList.remove("force-hover");
      const rowRest = ground(r);
      r.classList.add("force-hover");
      const rowHover = ground(r);
      const rh = ratio(rowRest, rowHover);
      expect(rh >= 1.04 && rh <= 1.16, "the row hover is a light wash (" + rh.toFixed(3) + ":1 against the row)");
      const done = $('.cd-row[data-path="README.md"]');
      const doneRest = ground(done);
      done.classList.add("force-hover");
      expect(ratio(doneRest, ground(done)) >= 1.04, "a resolved row keeps its green and still shows the hover");
      expect(ground(done)[1] >= ground(done)[0], "(its green stays under the wash)");

      // Keyboard focus: a visible ring, in the family.
      for (const b of [yours, merge, $(".cd-undo-hold")]) {
        b.classList.add("force-focus");
        const s = getComputedStyle(b);
        expect(s.outlineStyle === "solid" && parseFloat(s.outlineWidth) >= 2, (b.dataset.key) + ": a 2px ring on keyboard focus (" + s.outlineStyle + " " + s.outlineWidth + ")");
        const ring = rgba(s.outlineColor);
        expect(Math.abs(hue(ring) - hue(brand)) < 12, b.dataset.key + ": the ring is the family's purple (hue " + Math.round(hue(ring)) + ")");
        expect(ratio(ring, ground(r)) >= 3, b.dataset.key + ": and stands off the row at " + ratio(ring, ground(r)).toFixed(2) + ":1");
      }

      // Disabled: grey, not a faded purple.
      d.render(state(ROWS, { busy: true }));
      const dy = $('[data-key="accept:yours:src/app.ts"]'), dm = $('[data-key="merge:src/app.ts"]');
      expect(dy.disabled && dm.disabled, "precondition: the host is working");
      expect(sat(rgba(getComputedStyle(dy).color)) < 0.12, "a disabled Accept Yours is grey (" + getComputedStyle(dy).color + ")");
      expect(sat(ground(dm)) < 0.12, "a disabled Merge… is not a purple fill (" + ground(dm).map(Math.round) + ")");
    `);
    assert.deepEqual(v.fails, [], v.fails.join("\n"));
  });
}

test("the header names the repository as secondary: 'in <repo>', after the title, quieter than it", { skip }, async () => {
  const v = await run(`
    theme(${JSON.stringify(THEMES.dark)});
    const d = mount();
    d.render(state(ROWS));
    const repo = $(".cd-repo"), title = $(".cd-title");
    expect(repo && repo.textContent === "in demo", "the repository reads 'in demo' (" + (repo && repo.textContent) + ")");
    expect(box(repo).left > box(title).right, "after the title");
    const rs = getComputedStyle(repo), ts = getComputedStyle(title);
    expect(parseFloat(rs.fontSize) < parseFloat(ts.fontSize) && +rs.fontWeight < +ts.fontWeight, "smaller and lighter than the title");
    expect(lum(rgba(rs.color)) < lum(rgba(ts.color)), "and muted on a dark theme");
    // Each block of the header on its own line, the same space apart.
    const blocks = [".cd-head", ".cd-optitle", ".cd-dirbar", ".cd-progress", ".cd-list"].map((s) => box($(s)));
    const gaps = blocks.slice(1).map((b, i) => b.top - blocks[i].bottom);
    expect(gaps.every((g) => g > 4), "no block overlaps the one above (" + px(gaps) + ")");
    expect(same(gaps, 1), "one rhythm between them (" + px(gaps) + ")");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});
