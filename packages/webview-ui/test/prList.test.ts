import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { findChrome, runInChrome } from "./headless";

/**
 * The Pull Requests list (src/pr/prList.ts), mounted in headless Chrome and
 * fed the states the extension's view sends (fixtures/prListFixtures.ts):
 * each situation of the state table painted and asserted — by what the
 * reader sees (words, computed colours, geometry), never by class names
 * alone — and each control driven the way a user drives it: clicks, and keys
 * dispatched on the element that has focus.
 */
const ENTRY = fileURLToPath(new URL("./fixtures/prListEntry.ts", import.meta.url));
const CHROME = findChrome();
const skip = CHROME ? false : "no windowless Chrome on this machine (set GS_CHROME)";

/** Dark+ as VS Code hands it to a webview: on <html>, through the CSSOM. */
const PROLOGUE = `
  const DARK = {
    "--vscode-font-family": "sans-serif", "--vscode-font-size": "13px",
    "--vscode-foreground": "#cccccc", "--vscode-descriptionForeground": "rgba(204, 204, 204, 0.7)",
    "--vscode-sideBar-background": "#252526", "--vscode-editor-background": "#1e1e1e",
    "--vscode-focusBorder": "#007fd4", "--vscode-errorForeground": "#f48771",
    "--vscode-charts-green": "#89d185", "--vscode-charts-red": "#f14c4c", "--vscode-charts-yellow": "#cca700",
    "--vscode-charts-purple": "#b180d7", "--vscode-charts-blue": "#3794ff",
    "--vscode-input-background": "#3c3c3c", "--vscode-menu-background": "#252526",
  };
  for (const [k, v] of Object.entries(DARK)) document.documentElement.style.setProperty(k, v);
  document.body.className = "vscode-dark";
  const { PullRequestList, FakeClock, listScenes, openRows, row } = window.__prl;
  const S = listScenes();
  const root = document.getElementById("root");
  const posted = [];
  const clock = new FakeClock();
  const list = new PullRequestList(root, { post: (m) => posted.push(JSON.parse(JSON.stringify(m))), timers: clock });
  let seq = 10;
  const show = (s) => list.render({ ...s, seq: ++seq });
  const $ = (sel) => root.querySelector(sel);
  const $$ = (sel) => [...root.querySelectorAll(sel)];
  const rowEl = (n) => $('.prl-row[data-number="' + n + '"]');
  const colour = (el) => getComputedStyle(el).color;
  // Timers, not requestAnimationFrame: rAF never fires under the headless shell's virtual time.
  const frame = () => new Promise((r) => setTimeout(r, 60));
  const key = (name, opts = {}) => {
    const el = document.activeElement;
    el.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...opts }));
  };
  const GREEN = "rgb(137, 209, 133)", RED = "rgb(241, 76, 76)", PURPLE = "rgb(177, 128, 215)", YELLOW = "rgb(204, 167, 0)";
`;

async function check(script: string, opts: { width?: number; height?: number; frame?: { width: number; height: number } } = {}): Promise<void> {
  const v = await runInChrome(CHROME!, ENTRY, PROLOGUE + script, { width: opts.width ?? 320, height: opts.height ?? 900, frame: opts.frame });
  assert.deepEqual(v.fails, [], JSON.stringify(v.notes ?? {}));
}

test("a row says what it is: its state's glyph in the state's ink, the checks and the review by glyph AND word, the words in text ink", { skip }, async () => {
  await check(`
    show(S.open);
    expect($$(".prl-row").length === 7, "seven rows");
    const lead = (n) => colour(rowEl(n).querySelector(".prl-lead"));
    expect(lead(482) === GREEN, "an open PR's glyph is green: " + lead(482));
    expect(lead(479) !== GREEN && lead(479) !== RED, "a draft's is muted: " + lead(479));
    const stat = (n, i) => rowEl(n).querySelectorAll(".prl-stat")[i];
    const icon = (n, i) => colour(stat(n, i).querySelector(".prl-stat-icon"));
    const word = (n, i) => stat(n, i).querySelector(".prl-stat-word").textContent;
    expect(word(482, 0) === "Failed" && icon(482, 0) === RED, "failed checks: " + word(482, 0) + " " + icon(482, 0));
    expect(word(482, 1) === "Changes requested" && icon(482, 1) === RED, "changes requested: " + icon(482, 1));
    expect(word(479, 0) === "Running" && icon(479, 0) === YELLOW, "running checks: " + icon(479, 0));
    expect(word(476, 0) === "Passed" && icon(476, 0) === GREEN, "passed");
    expect(word(476, 1) === "Approved" && icon(476, 1) === GREEN, "approved");
    expect(word(471, 1) === "Review required" && icon(471, 1) === YELLOW, "review required: " + icon(471, 1));
    const wordInk = colour(stat(482, 0).querySelector(".prl-stat-word"));
    expect(wordInk !== RED, "the word is text, not the tone: " + wordInk);
    expect(stat(482, 0).querySelector(".codicon-close") && stat(476, 0).querySelector(".codicon-check") && stat(479, 0).querySelector(".codicon-sync"), "a glyph per result, not a colour alone");
    // The branch checked out here: said in words where the eye starts, and
    // lit with a calm brand tint, never an edge (the owner's rule).
    const pill = rowEl(482).querySelector(".prl-pill.is-current");
    expect(pill && pill.textContent === "Checked out", "Checked out, in words");
    expect(!rowEl(482).querySelector(".prl-age"), "…in place of the age");
    const fillOf = (n) => getComputedStyle(rowEl(n).querySelector(".prl-row-main")).backgroundColor;
    expect(fillOf(482) !== fillOf(476) && fillOf(482) !== "rgba(0, 0, 0, 0)", "and a tint of its own: " + fillOf(482) + " beside " + fillOf(476));
    const edge = getComputedStyle(rowEl(482), "::before");
    expect(edge.content === "none" || edge.content === "normal", "no edge down its side: " + edge.content);
    expect(!rowEl(476).querySelector(".prl-pill.is-current"), "only that row");
    // A fork's branch says whose.
    const branch = rowEl(476).querySelector(".prl-branch");
    expect(branch.querySelector(".codicon-repo-forked") && branch.textContent.includes("bobk:main"), "the fork's owner:branch");
    expect(branch.title === "Merges main from bobk/webapp into main", "and says so: " + branch.title);
    // What it all is, for a screen reader.
    const name = rowEl(482).querySelector(".prl-row-main").getAttribute("aria-label");
    expect(/^Pull request #482: Stream large diffs/.test(name) && /checked out here/.test(name) && /1 of 6 checks failed/.test(name) && /changes requested/.test(name) && /7 comments/.test(name) && /updated 12 minutes ago/.test(name), name);
    // A label's colour, set through the CSSOM (the page's CSP drops style attributes).
    const bug = rowEl(476).querySelector(".prl-label");
    expect(bug.style.getPropertyValue("--prl-label") === "#d73a4a", "the label's colour");
    expect(getComputedStyle(bug).backgroundColor !== getComputedStyle(rowEl(476).querySelectorAll(".prl-label")[1]).backgroundColor, "two labels, two colours");
    notes.age = rowEl(479).querySelector(".prl-age").textContent;
    expect(notes.age === "48m", "age by last update: " + notes.age);
  `);
});

test("merged and closed rows: purple and red, and no review decision on a PR that is done", { skip }, async () => {
  await check(`
    show(S.all);
    const lead = (n) => colour(rowEl(n).querySelector(".prl-lead"));
    expect(lead(466) === PURPLE, "merged is purple: " + lead(466));
    expect(lead(458) === RED, "closed without merging is red: " + lead(458));
    expect(lead(466) !== lead(458), "never the same ink");
    expect(rowEl(466).querySelector(".prl-lead .codicon-git-merge") && rowEl(458).querySelector(".prl-lead .codicon-git-pull-request-closed"), "and never the same glyph");
    expect(![...rowEl(466).querySelectorAll(".prl-stat-word")].some((w) => w.textContent === "Approved"), "a merged PR's review is history");
  `);
});

test("the header: segments with their counts, All said but not drawn; the counts arriving move no boundary", { skip }, async () => {
  await check(`
    show(S.loading);
    const rects = () => $$(".prl-seg-btn").map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.width)]; });
    const words = () => $$(".prl-seg-word").map((w) => { const r = w.getBoundingClientRect(); return Math.round(r.left); });
    const before = rects(), wordsBefore = words();
    expect($$(".prl-row-skeleton").length === 5 && $(".prl-list").getAttribute("aria-busy") === "true", "loading: rows of the same shape");
    const skH = rowEl === null ? 0 : $(".prl-row-skeleton").getBoundingClientRect().height;
    const skTop = $(".prl-row-skeleton").getBoundingClientRect().top;
    show(S.open);
    expect(JSON.stringify(rects()) === JSON.stringify(before), "no boundary moved: " + JSON.stringify(before) + " → " + JSON.stringify(rects()));
    expect(JSON.stringify(words()) === JSON.stringify(wordsBefore), "no word moved");
    const segs = $$(".prl-seg-btn");
    expect(segs.map((b) => b.textContent).join("|") === "Open23|Merged1.2k|Closed57|All", segs.map((b) => b.textContent).join("|"));
    expect(segs[1].getAttribute("aria-label") === "Merged, 1,204" && segs[3].getAttribute("aria-label") === "All, 1,284", segs.map((b) => b.getAttribute("aria-label")).join("|"));
    expect(segs[0].getAttribute("aria-checked") === "true" && segs[0].getAttribute("role") === "radio", "a radio group");
    for (const w of $$(".prl-seg-word")) expect(w.scrollWidth <= w.clientWidth, "the word is whole: " + w.textContent);
    const real = rowEl(482).getBoundingClientRect();
    expect(Math.abs(real.top - skTop) <= 1, "the first row lands where the first bar was");
    expect(Math.abs(real.height - skH) <= 2, "a row as tall as its bar: " + real.height + " vs " + skH);
  `);
});

test("narrow: the counts give way and every segment's word stays whole", { skip }, async () => {
  await check(
    `
    show(S.open);
    await frame();
    expect(getComputedStyle($(".prl-seg-count")).display === "none", "no counts under 260px");
    for (const w of $$(".prl-seg-word")) expect(w.scrollWidth <= w.clientWidth + 0.5, "the word is whole: " + w.textContent + " " + w.scrollWidth + "/" + w.clientWidth);
    expect(getComputedStyle(rowEl(476).querySelector(".prl-author")).display === "none", "the author's picture stays, the name goes");
    expect(document.documentElement.scrollWidth <= 220, "nothing wider than the sidebar: " + document.documentElement.scrollWidth);
  `,
    { frame: { width: 220, height: 700 } },
  );
});

test("the search box's words are whole at every width — Search pull requests, Search, never a word cut mid-way", { skip }, async () => {
  await check(
    `
    show(S.open);
    await frame();
    const input = () => $(".prl-search-input");
    const ctx = document.createElement("canvas").getContext("2d");
    const fits = () => {
      ctx.font = getComputedStyle(input()).font;
      return ctx.measureText(input().placeholder).width <= input().clientWidth;
    };
    const seen = new Set();
    for (let w = 340; w >= 150; w -= 3) {
      root.style.width = w + "px";
      // What VS Code does when the sidebar is resized: the webview's window
      // resizes. (A ResizeObserver runs in the rendering step, which the
      // headless shell's virtual time never reaches.)
      window.dispatchEvent(new Event("resize"));
      await new Promise((r) => setTimeout(r, 30));
      seen.add(input().placeholder);
      if (!fits()) expect(false, "cut at " + w + "px: " + JSON.stringify(input().placeholder) + " in " + input().clientWidth + "px");
    }
    expect(seen.has("Search pull requests") && seen.has("Search"), "both, each where it fits whole: " + [...seen].join(" | "));
    expect(input().getAttribute("aria-label") === "Search pull requests", "its name keeps every word");
    // Typing, then clearing, in a narrow box: still whole.
    root.style.width = "170px";
    window.dispatchEvent(new Event("resize"));
    await new Promise((r) => setTimeout(r, 30));
    input().focus();
    input().value = "diff";
    input().dispatchEvent(new Event("input", { bubbles: true }));
    input().value = "";
    input().dispatchEvent(new Event("input", { bubbles: true }));
    expect(fits(), "after clearing: " + input().placeholder);
    // A state from the host keeps what was fitted.
    show(S.open);
    expect(fits() && input().placeholder === "Search", "kept across a paint: " + input().placeholder);
  `,
    { frame: { width: 360, height: 700 } },
  );
});

test("each situation says what it is and what to do — and each button asks the host for exactly that", { skip }, async () => {
  await check(`
    const say = (s) => { posted.length = 0; show(s); };
    say(S.signedOut);
    expect($(".prl-message-title").textContent === "Sign in to GitHub to see pull requests", "signed out");
    expect(!$(".prl-seg"), "nothing to operate");
    $(".prl-message .gs-btn").click();
    expect(JSON.stringify(posted.at(-1)) === JSON.stringify({ type: "action", action: { kind: "signIn" } }), JSON.stringify(posted));
    say(S.expired);
    $(".prl-message .gs-btn").click();
    expect(posted.at(-1).action.again === true, "an expired sign-in signs in AGAIN");
    say(S.offline);
    expect($(".prl-message").getAttribute("role") === "alert", "a failure is announced");
    $(".prl-message .gs-btn").click();
    expect(posted.at(-1).action.kind === "retry", "Retry");
    say(S.notGitHub);
    expect($(".prl-message-detail").textContent.includes("gitlab.com") && !$(".prl-message .gs-btn"), "why, and nothing to press");
    say(S.refreshFailed);
    expect($(".prl-notice") && $$(".prl-row").length === 7, "the notice over the rows it kept");
    $(".prl-notice .gs-btn").click();
    expect(posted.at(-1).action.kind === "retry", "the notice's Retry");
    say(S.refreshing);
    expect($(".prl-progress").classList.contains("is-on") && getComputedStyle($(".prl-progress-bar")).visibility === "visible", "a bar while the rows stay");
    say(S.emptyMerged);
    expect($(".prl-empty-title").textContent === "No merged pull requests" && !$(".prl-empty .gs-btn"), "an empty segment says which, and offers no Create where it isn't the next step");
    say(S.emptyOpen);
    const make = $(".prl-empty .gs-btn");
    expect(make.textContent.trim() === "New pull request" && make.querySelector(".codicon-git-pull-request"), "the desktop's words and glyph: " + make.textContent);
    make.click();
    expect(posted.at(-1).action.kind === "createPr", "New pull request");
    say(S.emptyFiltered);
    expect(/match/.test($(".prl-empty-title").textContent), "filtered to nothing: " + $(".prl-empty-title").textContent);
    $(".prl-empty .gs-btn").click();
    expect(JSON.stringify(posted.at(-1)) === JSON.stringify({ type: "filters", filters: {} }), "Clear filters: " + JSON.stringify(posted.at(-1)));
  `);
});

test("keys: Down from the search into the rows, Up and Down through them, Enter opens, Shift+F10 the row's menu — only what applies", { skip }, async () => {
  await check(`
    show(S.open);
    $(".prl-search-input").focus();
    key("ArrowDown");
    expect(document.activeElement === rowEl(482).querySelector(".prl-row-main"), "the first row");
    key("ArrowDown");
    expect(document.activeElement === rowEl(479).querySelector(".prl-row-main"), "the next");
    expect(rowEl(479).querySelector(".prl-row-main").tabIndex === 0 && rowEl(482).querySelector(".prl-row-main").tabIndex === -1, "one tab stop: the row with the keyboard");
    posted.length = 0;
    document.activeElement.click();
    expect(JSON.stringify(posted) === JSON.stringify([{ type: "open", number: 479 }]), "opens it: " + JSON.stringify(posted));
    key("F10", { shiftKey: true });
    const items = () => [...document.querySelectorAll(".prl-menu .prl-menu-label")].map((e) => e.textContent);
    expect(items().join("|") === "Open|Checkout|Review|Open on GitHub|Copy link", "a draft's menu: no Merge " + items().join("|"));
    expect(document.activeElement.classList.contains("prl-menu-item"), "the menu has the keyboard");
    key("Escape");
    expect(!document.querySelector(".prl-menu") && document.activeElement === rowEl(479).querySelector(".prl-row-main"), "Escape closes it and gives the keyboard back");
    key("ArrowUp");
    key("ContextMenu");
    expect(items().join("|") === "Open|Checkout|Review|Merge|Open on GitHub|Copy link", "an open PR's, in the desktop's words: " + items().join("|"));
    key("ArrowDown");
    posted.length = 0;
    document.activeElement.click();
    expect(JSON.stringify(posted) === JSON.stringify([{ type: "checkout", number: 482 }]), "Checkout: " + JSON.stringify(posted));
    key("ArrowUp");
    expect(document.activeElement === $(".prl-search-input"), "Up from the first row: the search");
    $$(".prl-seg-btn")[0].focus();
    posted.length = 0;
    key("ArrowRight");
    expect(JSON.stringify(posted) === JSON.stringify([{ type: "segment", segment: "merged" }]), "Right: the next segment");
  `);
});

test("the filter menu drills into a facet; picking one asks for it, its chip says it, and the chip's x takes it away", { skip }, async () => {
  await check(`
    show(S.open);
    posted.length = 0;
    $(".prl-filter-btn").click();
    const labels = () => [...document.querySelectorAll(".prl-menu .prl-menu-items .prl-menu-label")].map((e) => e.textContent);
    expect(labels().join("|") === "Author|Review requested|Assignee|Label", labels().join("|"));
    [...document.querySelectorAll(".prl-menu-item")].find((b) => b.dataset.label === "Author").click();
    expect(document.querySelector(".prl-menu-heading").textContent === "Author", "the submenu names itself");
    expect(posted.some((p) => p.type === "facetOptions"), "asks for the repository's people");
    expect(labels().includes("You (@sam-rivera)") && labels().includes("@alice-chen"), labels().join("|"));
    const filter = document.querySelector(".prl-menu-filter");
    filter.value = "ali";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    expect(labels().join("|") === "@alice-chen|@ali", "the list narrows as you type — and what you typed is a login too: " + labels().join("|"));
    expect([...document.querySelectorAll(".prl-menu-item")].at(-1).textContent.includes("Someone not listed"), "said to be one not listed");
    filter.value = "zoe";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    expect(labels().includes("@zoe"), "a login not listed can be used");
    filter.value = "";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    posted.length = 0;
    [...document.querySelectorAll(".prl-menu-item")].find((b) => b.dataset.label.startsWith("You")).click();
    expect(JSON.stringify(posted) === JSON.stringify([{ type: "filters", filters: { author: "@me" } }]), JSON.stringify(posted));
    expect(!document.querySelector(".prl-menu") && document.activeElement === $(".prl-filter-btn"), "closed, the keyboard back on Filter");
    show({ ...S.open, filters: { author: "@me", label: "bug" } });
    expect($$(".prl-chip-text").map((c) => c.textContent).join("|") === "Author: you|Label: bug", $$(".prl-chip-text").map((c) => c.textContent).join("|"));
    expect($(".prl-filter-btn").getAttribute("aria-label") === "Filter, 2 on", "the button counts them");
    posted.length = 0;
    $('.prl-chip[data-key="chip-author"] .prl-chip-x').click();
    expect(JSON.stringify(posted) === JSON.stringify([{ type: "filters", filters: { label: "bug" } }]), JSON.stringify(posted));
  `);
});

test("the search box: asks once typing pauses, and keeps your words while an older answer paints", { skip }, async () => {
  await check(`
    show(S.open);
    const input = $(".prl-search-input");
    input.focus();
    posted.length = 0;
    for (const v of ["c", "cr", "cra"]) { input.value = v; input.dispatchEvent(new Event("input", { bubbles: true })); clock.advance(100); }
    expect(posted.length === 0, "not while typing: " + JSON.stringify(posted));
    clock.advance(300);
    expect(JSON.stringify(posted) === JSON.stringify([{ type: "filters", filters: { text: "cra" } }]), JSON.stringify(posted));
    input.value = "cras";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    show({ ...S.open, filters: { text: "cra" } });
    expect(input.value === "cras", "an older answer never takes your words: " + input.value);
    expect(!$(".prl-search-clear").hidden, "and there is a way to clear them");
    posted.length = 0;
    key("Escape");
    expect(input.value === "" && JSON.stringify(posted.at(-1)) === JSON.stringify({ type: "filters", filters: {} }), "Escape clears the search: " + JSON.stringify(posted.at(-1)));
  `);
});

test("a new state patches the rows in place: the rows that did not change keep their nodes, the keyboard stays", { skip }, async () => {
  await check(`
    show(S.open);
    const keep = rowEl(476), keepMain = rowEl(476).querySelector(".prl-row-main");
    keepMain.focus();
    const rows = openRows();
    rows[0] = { ...rows[0], title: "Stream large diffs (renamed)" };
    show({ ...S.open, rows });
    expect(rowEl(476) === keep && rowEl(476).querySelector(".prl-row-main") === keepMain, "the same nodes");
    expect(document.activeElement === keepMain, "the keyboard where it was");
    expect(rowEl(482).querySelector(".prl-title").textContent === "Stream large diffs (renamed)", "the changed row changed");
    show({ ...S.open, rows: rows.filter((r) => r.number !== 476) });
    expect(!rowEl(476) && $$(".prl-row").length === 6, "a row that left is gone");
  `);
});

test("the end of the list: Load More asks for the next page — and by itself only once per length", { skip }, async () => {
  await check(`
    // The end in sight as the state is painted asks for the next page at
    // once — not on a frame an observer waits for, which a loaded machine
    // (or a throttled webview) paints late or not at all.
    show({ ...S.open, rows: openRows().slice(0, 3) });
    expect(posted.filter((p) => p.type === "loadMore").length === 1, "asked as it is painted, not a frame later");
    for (let i = 0; i < 50 && !posted.some((p) => p.type === "loadMore"); i++) await frame();
    await frame();
    const auto = posted.filter((p) => p.type === "loadMore").length;
    expect(auto === 1, "the end in sight asks once: " + auto);
    // Then an observer that reports the end in sight the moment it is
    // watched, as a live webview's next frame does (the headless shell paints
    // no frame for a state that changes nothing on screen): a page that
    // didn't come must not be asked for again, and again, by itself.
    const Real = window.IntersectionObserver;
    window.IntersectionObserver = class {
      constructor(cb) { this.cb = cb; this.on = true; }
      observe(t) { queueMicrotask(() => this.on && this.cb([{ isIntersecting: true, target: t }])); }
      disconnect() { this.on = false; }
    };
    for (let i = 0; i < 3; i++) {
      show({ ...S.open, rows: openRows().slice(0, 3) });
      await frame();
    }
    window.IntersectionObserver = Real;
    expect(posted.filter((p) => p.type === "loadMore").length === 1, "a page that didn't come isn't asked for again by itself: " + posted.filter((p) => p.type === "loadMore").length);
    $(".prl-more-btn").click();
    expect(posted.filter((p) => p.type === "loadMore").length === 2, "the button always asks");
    show({ ...S.open, loadingMore: true });
    expect($(".prl-more-btn").disabled && $(".prl-more-btn").textContent === "Loading…", "and says it is loading");
    expect($(".prl-more-count").textContent === "7 of 23", $(".prl-more-count").textContent);
  `);
});

test("a fork: the switcher names the repository and why, and offers the other one", { skip }, async () => {
  await check(`
    show(S.fork);
    const b = $(".prl-target");
    expect(b.textContent.includes("acme/webapp") && b.textContent.includes("origin was forked from it"), b.textContent);
    b.click();
    const items = [...document.querySelectorAll(".prl-menu-item")];
    expect(items.length === 2 && items[0].getAttribute("aria-checked") === "true", "two repositories, the shown one checked");
    posted.length = 0;
    items[1].click();
    expect(JSON.stringify(posted) === JSON.stringify([{ type: "target", id: "sam-rivera/webapp" }]), JSON.stringify(posted));
  `);
});

test("an avatar only from GitHub's avatar host; anything else is the person's initial", { skip }, async () => {
  await check(`
    const rows = [row(1, { author: { login: "zed", avatarUrl: "http://evil.example/x.png" } }), row(2, { author: { login: "amy", avatarUrl: "https://avatars.githubusercontent.com/u/1?s=40" } })];
    show({ ...S.open, rows });
    expect(!rowEl(1).querySelector("img") && rowEl(1).querySelector(".prl-avatar-initial").textContent === "Z", "not another host");
    expect(rowEl(2).querySelector("img").getAttribute("src").startsWith("https://avatars.githubusercontent.com/"), "GitHub's");
  `);
});
