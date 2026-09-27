import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ChangesPage, stateMessage, type VsCodeTheme } from "./changesPage";

// The operation banner in a real browser: how it is laid out at the widths a
// sidebar has, and what colour it is in each state and theme.
//
// At 300px a stopped rebase put its four buttons on three rows, and the
// banner was conflict-red whatever the state — "Every conflict is resolved."
// sat in an error box. Now the buttons sit side by side when they fit, and
// otherwise the lead action takes a row of its own and the rest share one by
// their first word; the tone is amber while something is in the way and the
// accent once nothing is. Measured from layout and computed style, never
// from class names.

const chrome = ChangesPage.chrome();
const skip = chrome ? false : "no windowless Chrome on this machine (set GS_CHROME)";

const opened: ChangesPage[] = [];
after(async () => {
  for (const p of opened) await p.close();
});

const OPS: Record<string, Record<string, unknown>> = {
  "rebase, conflicted": {
    kind: "rebase", title: "Rebasing feature/checkout-flow onto main", step: "Commit 2 of 5: Add the payment step",
    note: "1 file has conflicts to resolve.", conflicts: 1, continueLabel: "Continue Rebase", canContinue: false,
    continueBlocked: "Resolve the conflicted file first.", skipLabel: "Skip This Commit", abortLabel: "Abort Rebase",
    tone: "attention", icon: "warning",
  },
  "merge, resolved": {
    kind: "merge", title: "Merging main into feature/checkout-flow", note: "Every conflict is resolved.",
    conflicts: 0, continueLabel: "Commit Merge", canContinue: true, abortLabel: "Abort Merge", tone: "ready", icon: "pass",
  },
  "rebase, paused": {
    kind: "rebase", title: "Rebasing feature/checkout-flow onto main", step: "Commit 3 of 5: Validate the card",
    note: "Paused to edit 1a2b3c4.", conflicts: 0, continueLabel: "Continue Rebase", canContinue: true,
    abortLabel: "Abort Rebase", tone: "ready", icon: "debug-pause",
  },
  "cherry-pick, emptied": {
    kind: "cherry-pick", title: "Cherry-picking 1a2b3c4 Fix onto main", conflicts: 0,
    continueLabel: "Continue Cherry-pick", canContinue: false, continueBlocked: "Nothing left to commit.",
    skipLabel: "Skip this commit", abortLabel: "Abort Cherry-pick", tone: "attention", icon: "warning",
  },
  "stash, conflicted": {
    kind: "stash", title: "Applying a stash", conflicts: 2, canContinue: false,
    abortLabel: "Cancel the stash apply", tone: "attention", icon: "warning",
  },
};

interface Layout {
  rows: number;
  stacked: boolean;
  leadAlone: boolean;
  clipped: string[];
  outside: string[];
  names: string[];
}

async function layout(page: ChangesPage): Promise<Layout> {
  return page.eval<Layout>(`(function () {
    var banner = document.getElementById("op-banner");
    var acts = banner.querySelector(".op-actions");
    var bb = banner.getBoundingClientRect();
    var buttons = Array.prototype.slice.call(acts.querySelectorAll("button"));
    var tops = {};
    var clipped = [], outside = [];
    buttons.forEach(function (b) {
      var r = b.getBoundingClientRect();
      tops[Math.round(r.top)] = (tops[Math.round(r.top)] || 0) + 1;
      if (r.right > bb.right - 1 + 0.5 || r.left < bb.left) outside.push(b.getAttribute("aria-label"));
      Array.prototype.forEach.call(b.querySelectorAll("span"), function (s) {
        if (getComputedStyle(s).display === "none") return;
        // Fractional widths: scrollWidth rounds a sub-pixel overflow away.
        var range = document.createRange();
        range.selectNodeContents(s);
        var textW = range.getBoundingClientRect().width;
        if (textW > s.getBoundingClientRect().width + 0.5) clipped.push(s.textContent);
      });
    });
    var rows = Object.keys(tops).map(Number).sort(function (a, b) { return a - b; });
    var lead = acts.querySelector(".op-lead");
    var leadAlone = !lead || (tops[Math.round(lead.getBoundingClientRect().top)] === 1);
    return {
      rows: rows.length,
      stacked: acts.classList.contains("stacked"),
      leadAlone: leadAlone,
      clipped: clipped,
      outside: outside,
      names: buttons.map(function (b) { return b.getAttribute("aria-label"); }),
    };
  })()`);
}

test("the banner's buttons at every sidebar width: never more than two rows, never a clipped label", { skip }, async () => {
  const page = await ChangesPage.open("dark", { width: 520, height: 700 });
  opened.push(page);
  const failures: string[] = [];
  let cells = 0;
  for (const width of [240, 260, 300, 340, 380, 420, 520]) {
    await page.resize(width, 700);
    for (const [name, op] of Object.entries(OPS)) {
      await page.send({ ...stateMessage({ local: [{ name: "main", current: true }] }), operation: op });
      const l = await layout(page);
      cells++;
      const at = `${name} @ ${width}px`;
      if (l.rows > 2) failures.push(`${at}: ${l.rows} rows`);
      if (l.clipped.length) failures.push(`${at}: clipped ${JSON.stringify(l.clipped)}`);
      if (l.outside.length) failures.push(`${at}: outside the banner ${JSON.stringify(l.outside)}`);
      if (!l.stacked && l.rows !== 1) failures.push(`${at}: side by side but on ${l.rows} rows`);
      if (l.stacked && !l.leadAlone) failures.push(`${at}: stacked but the lead shares its row`);
      if (l.names.some((n) => !n)) failures.push(`${at}: a button with no name`);
    }
  }
  assert.equal(cells, 35);
  assert.deepEqual(failures, []);
});

test("wide enough, every button is side by side with its whole verb; narrow, the rest go by their first word", { skip }, async () => {
  const page = await ChangesPage.open("dark", { width: 620, height: 700 });
  opened.push(page);
  const op = OPS["rebase, conflicted"];
  await page.send({ ...stateMessage({ local: [{ name: "main", current: true }] }), operation: op });
  const faces = () =>
    page.eval<string[]>(`Array.prototype.map.call(document.querySelectorAll("#op-banner .op-actions button"), function (b) {
      return Array.prototype.filter.call(b.querySelectorAll("span"), function (s) { return getComputedStyle(s).display !== "none"; })
        .map(function (s) { return s.textContent; }).join("");
    })`);
  assert.equal((await layout(page)).rows, 1);
  assert.deepEqual(await faces(), ["Resolve Conflicts…", "Continue Rebase", "Skip This Commit", "Abort Rebase"]);
  await page.resize(300, 700);
  assert.equal((await layout(page)).stacked, true);
  assert.deepEqual(await faces(), ["Resolve Conflicts…", "Continue", "Skip", "Abort"]);
  // The names never shorten.
  assert.deepEqual((await layout(page)).names, ["Resolve Conflicts…", "Continue Rebase", "Skip This Commit", "Abort Rebase"]);
});

/** A colour the page resolves for a var(), for comparing against computed styles. */
function probe(page: ChangesPage, prop: string, value: string): Promise<string> {
  return page.eval<string>(`(function () {
    var d = document.createElement("div");
    d.style.${prop} = ${JSON.stringify(value)};
    document.body.appendChild(d);
    var c = getComputedStyle(d).${prop};
    d.remove();
    return c;
  })()`);
}

for (const theme of ["dark", "light", "hc-dark", "hc-light"] as VsCodeTheme[]) {
  test(`the banner's tone in ${theme}: amber while something is in the way, the accent once nothing is — never conflict red`, { skip }, async () => {
    const page = await ChangesPage.open(theme, { width: 420, height: 700 });
    opened.push(page);
    const amber = await probe(page, "color", "var(--gs-amber)");
    const accentText = await probe(page, "color", "var(--gs-accent-text)");
    const red = await probe(page, "color", "var(--gs-status-conflict)");
    const hc = theme.startsWith("hc");
    const contrastBorder = await probe(page, "borderTopColor", "var(--vscode-contrastBorder)");
    for (const [name, op] of Object.entries(OPS)) {
      await page.send({ ...stateMessage({ local: [{ name: "main", current: true }] }), operation: op });
      const got = await page.eval<{ icon: string; border: string; glyph: string }>(`(function () {
        var b = document.getElementById("op-banner");
        var i = b.querySelector(".op-title .codicon");
        return { icon: getComputedStyle(i).color, border: getComputedStyle(b).borderTopColor, glyph: i.className };
      })()`);
      const ready = op.tone === "ready";
      assert.equal(got.icon, ready ? accentText : amber, `${name}: the icon's colour`);
      if (!(ready ? accentText === red : amber === red)) assert.notEqual(got.icon, red, `${name}: not conflict red`);
      assert.match(got.glyph, new RegExp(`codicon-${op.icon}\\b`), `${name}: the ${op.icon} codicon`);
      if (hc) assert.equal(got.border, contrastBorder, `${name}: a high-contrast theme's border`);
    }
  });
}
