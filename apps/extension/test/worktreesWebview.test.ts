// The Worktrees view's page, rendered for real (test/worktreesPage.ts): the
// bundle the extension ships, in a windowless Chrome, driven with real keys
// and clicks. Asserted by what a person sees — words, computed colours,
// geometry — never by a class name alone (memory: dead-css-class-names).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { WorktreesPage, type VsCodeTheme } from "./worktreesPage";
import { fixtureDetails, fixtureRows, row } from "./worktreesFixtures";

const skip = WorktreesPage.chrome() ? false : "no windowless Chrome on this machine (set GS_CHROME)";
const LABELS = { reveal: "Reveal in Finder" };
const opened: WorktreesPage[] = [];
after(async () => {
  for (const p of opened) await p.close();
});

async function open(theme: VsCodeTheme = "dark", width = 300, height = 700): Promise<WorktreesPage> {
  const page = await WorktreesPage.open(theme, { width, height });
  opened.push(page);
  await page.send({ type: "rows", rows: fixtureRows(), state: "ok", labels: LABELS });
  // The page tells the host which rows are in view once they are laid out
  // (a debounced post): let that land before a test clears what was posted.
  await page.page.waitFor(`window.__posted.some(function (m) { return m.type === "visible"; })`);
  await page.settle();
  return page;
}

/**
 * What the page asked the host for — without its "rows in view" reports,
 * which follow any layout change (a row opening moves the rest) on a
 * debounce of their own, and are pinned by their own test.
 */
async function asked(page: WorktreesPage): Promise<Record<string, unknown>[]> {
  return (await page.posted()).filter((m) => m.type !== "visible");
}

const LOGIN = "/code/app-login";
const AGENT = "/code/app/.claude/worktrees/agent-a2c9ae27";
const UNLINKED = "/code/app/.claude/worktrees/agent-7f3e";

/** A row's line, by folder, as a person reads it. */
function lineOf(page: WorktreesPage, path: string) {
  return page.eval<{ name: string; head: string; badges: string[]; path: string; expanded: string | null; label: string } | null>(`(function () {
    var l = document.querySelector('.wt-row[data-path="${path}"]');
    if (!l) return null;
    var head = l.querySelector(".wt-head-text");
    return {
      name: l.querySelector(".wt-name").textContent,
      head: head ? head.textContent : "",
      badges: Array.prototype.filter.call(l.querySelectorAll(".wt-badge"), function (b) { return !b.hidden; }).map(function (b) { return b.textContent; }),
      path: l.querySelector(".wt-path").textContent,
      expanded: l.getAttribute("aria-expanded"),
      label: l.getAttribute("aria-label"),
    };
  })()`);
}

test("every row reads: its folder, what it has checked out, its badges in words, where it is", { skip }, async () => {
  const page = await open();
  assert.deepEqual(await lineOf(page, LOGIN), {
    name: "app-login",
    head: "feature/login",
    badges: ["This window", "5 changed", "2 to push"],
    path: "app-login",
    expanded: "false",
    label: "app-login, feature/login, This window, 5 changed, 2 to push, app-login",
  });
  assert.deepEqual((await lineOf(page, "/code/app"))?.badges, ["Main worktree", "3 to pull"]);
  assert.deepEqual((await lineOf(page, "/code/app-merge"))?.badges.slice(0, 1), ["Merge in progress · 1 conflict"]);
  assert.deepEqual((await lineOf(page, "/code/app-v2"))?.head, "detached at 4f2a9c1");
  assert.deepEqual((await lineOf(page, "/code/app-usb"))?.badges, ["Locked: on a USB drive", "Folder missing"]);
  assert.equal((await lineOf(page, "/code/app-usb"))?.expanded, null, "a missing folder does not open");
  assert.deepEqual(await lineOf(page, UNLINKED), {
    name: "agent-7f3e",
    head: "worktree-agent-7f3e",
    badges: ["Not a worktree"],
    path: "app/.claude/worktrees/agent-7f3e",
    expanded: null,
    label: "agent-7f3e, worktree-agent-7f3e, Not a worktree, app/.claude/worktrees/agent-7f3e",
  });
  // This window's first, then the main worktree, the missing last.
  const order = await page.eval<string[]>(`Array.prototype.map.call(document.querySelectorAll(".wt-row"), function (l) { return l.dataset.path; })`);
  assert.deepEqual(order.slice(0, 2), [LOGIN, "/code/app"]);
  assert.deepEqual(order.slice(-2), ["/code/app-old", "/code/app-usb"]);
  assert.deepEqual(page.errors(), []);
});

test("badges are colour AND words: each tone paints, and every one reads at AA on the side bar, in every theme", { skip }, async () => {
  for (const theme of ["dark", "light", "hc-dark", "hc-light"] as VsCodeTheme[]) {
    const page = await open(theme);
    const report = await page.eval<{ text: string; ratio: number; bg: string; border: string }[]>(`(function () {
      // rgb()/rgba() in 0–255, or color(srgb …) — what a color-mix() computes to — in 0–1.
      function rgb(s) {
        var m = s.replace(/^color\\(srgb/, "").match(/[\\d.]+/g).map(Number);
        var k = s.indexOf("color(srgb") === 0 ? 255 : 1;
        return { r: m[0] * k, g: m[1] * k, b: m[2] * k, a: m.length > 3 ? m[3] : 1 };
      }
      function over(top, under) { return { r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 }; }
      function lum(c) { var f = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); }
      var ground = rgb(getComputedStyle(document.body).backgroundColor);
      return Array.prototype.map.call(document.querySelectorAll(".wt-badge"), function (b) {
        var cs = getComputedStyle(b);
        var bg = over(rgb(cs.backgroundColor), ground);
        var fg = over(rgb(cs.color), bg);
        var l1 = lum(fg), l2 = lum(bg);
        return { text: b.textContent, ratio: (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05), bg: cs.backgroundColor, border: cs.borderTopColor };
      });
    })()`);
    assert.ok(report.length >= 15, `${theme}: badges painted (${report.length})`);
    for (const r of report) {
      assert.ok(r.ratio >= 4.5, `${theme}: "${r.text}" reads at ${r.ratio.toFixed(2)}:1`);
      assert.notEqual(r.border, "rgba(0, 0, 0, 0)", `${theme}: "${r.text}" has an edge`);
    }
    if (theme.startsWith("hc")) {
      assert.ok(report.every((r) => r.bg === "rgba(0, 0, 0, 0)"), `${theme}: no tints in high contrast`);
    } else {
      const tones = new Set(report.map((r) => r.bg));
      assert.ok(tones.size >= 4, `${theme}: the tones differ (${[...tones].join(" | ")})`);
    }
  }
});

test("in high contrast a button is its border: Prune, Pull and Push… are drawn as buttons, not bare words", { skip }, async () => {
  for (const theme of ["hc-dark", "hc-light"] as VsCodeTheme[]) {
    const page = await open(theme);
    await page.clickOn(`.wt-row[data-path="${LOGIN}"] .wt-name`);
    await page.send({ type: "details", path: LOGIN, details: fixtureDetails() });
    const borders = await page.eval<{ text: string; width: string; color: string }[]>(`Array.prototype.map.call(
      document.querySelectorAll(".wt-prune, .wt-verb"), function (b) {
        var cs = getComputedStyle(b);
        return { text: b.textContent, width: cs.borderTopWidth, color: cs.borderTopColor };
      })`);
    assert.equal(borders.length, 3);
    for (const b of borders) {
      assert.equal(b.width, "1px", `${theme}: ${b.text}`);
      assert.notEqual(b.color, "rgba(0, 0, 0, 0)", `${theme}: ${b.text} has a visible border`);
    }
  }
});

test("a status landing later does not move the row: its height is the same before and after", { skip }, async () => {
  const page = await WorktreesPage.open("dark", { width: 300, height: 600 });
  opened.push(page);
  const rows = fixtureRows().map((r) => ({ ...r, status: undefined }));
  await page.send({ type: "rows", rows, state: "ok", labels: LABELS });
  await page.settle();
  const heights = () =>
    page.eval<number[]>(`Array.prototype.map.call(document.querySelectorAll(".wt-row"), function (l) { return l.getBoundingClientRect().height; })`);
  const before = await heights();
  for (const r of fixtureRows()) if (r.status) await page.send({ type: "status", path: r.path, status: r.status });
  await page.settle();
  assert.deepEqual(await heights(), before);
  assert.ok(before.every((h) => h === before[0]), `every row one height: ${before.join(",")}`);
});

test("click opens a row: it asks the host for its details, shows Loading…, then its files and commits", { skip }, async () => {
  const page = await open();
  await page.clearPosted();
  await page.clickOn(`.wt-row[data-path="${LOGIN}"] .wt-name`);
  assert.deepEqual(await asked(page), [{ type: "expand", path: LOGIN }]);
  assert.equal((await lineOf(page, LOGIN))?.expanded, "true");
  const loading = await page.eval<string>(`document.querySelector('.wt-item[data-path="${LOGIN}"] .wt-details').textContent`);
  assert.match(loading, /Loading…/);
  await page.send({ type: "details", path: LOGIN, details: fixtureDetails() });
  const shown = await page.eval<{ labels: string[]; files: string[]; tags: string[]; commits: string[]; verbs: string[] }>(`(function () {
    var d = document.querySelector('.wt-item[data-path="${LOGIN}"] .wt-details');
    return {
      labels: Array.prototype.map.call(d.querySelectorAll(".cr-section-label"), function (n) { return n.textContent; }),
      files: Array.prototype.map.call(d.querySelectorAll(":scope > .cr-file"), function (n) { return n.querySelector(".cr-st").textContent + " " + n.querySelector(".cr-name").textContent; }),
      tags: Array.prototype.map.call(d.querySelectorAll(".cr-tag"), function (n) { return n.textContent; }),
      commits: Array.prototype.map.call(d.querySelectorAll(".cr-commit .cr-subj"), function (n) { return n.textContent; }),
      verbs: Array.prototype.map.call(d.querySelectorAll(".wt-verb"), function (n) { return n.textContent + (n.getAttribute("aria-disabled") ? " (unavailable)" : ""); }),
    };
  })()`);
  assert.deepEqual(shown.labels, ["Uncommitted5", "Not pushed to origin/feature/login2"]);
  assert.deepEqual(shown.files, ["M login.ts", "A session.ts", "M form.tsx", "D oldLogin.ts", "U login-flow.md"]);
  assert.deepEqual(shown.tags, ["staged", "staged"]);
  assert.deepEqual(shown.commits, ["Remember the session across restarts", "Validate the login form before sending"]);
  assert.deepEqual(shown.verbs, ["Pull", "Push…"]);

  // A file opens its diff in that worktree: the host is handed the file, side and all.
  await page.clearPosted();
  await page.clickOn(`.wt-item[data-path="${LOGIN}"] .cr-file[data-path="src/auth/login.ts"]`);
  assert.deepEqual(await asked(page), [{ type: "openFile", path: LOGIN, file: { path: "src/auth/login.ts", status: "M", area: "staged" } }]);

  // A commit opens to its files; a file under it opens what that commit did.
  const sha = fixtureDetails().unpushed!.commits[0].sha;
  await page.clearPosted();
  await page.clickOn(`.wt-item[data-path="${LOGIN}"] .cr-commit-item[data-sha="${sha}"] .cr-commit`);
  assert.deepEqual(await asked(page), [{ type: "commitFiles", path: LOGIN, sha }]);
  await page.send({ type: "commitFiles", path: LOGIN, sha, files: [{ path: "src/auth/session.ts", status: "M", additions: 24, deletions: 3 }] });
  await page.clearPosted();
  await page.clickOn(`.cr-commit-item[data-sha="${sha}"] .cr-file`);
  const [msg] = await asked(page);
  assert.deepEqual(msg, {
    type: "openCommitFile",
    path: LOGIN,
    sha,
    parent: "4f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39",
    file: { path: "src/auth/session.ts", status: "M", additions: 24, deletions: 3 },
  });
  const nums = await page.eval<string>(`document.querySelector('.cr-commit-item[data-sha="${sha}"] .cr-nums').textContent`);
  assert.equal(nums, "+24−3");
});

test("what couldn't be read says so: a commit's files, a worktree's uncommitted changes — never 'No … changes'", { skip }, async () => {
  const page = await open();
  await page.clickOn(`.wt-row[data-path="${LOGIN}"] .wt-name`);
  await page.send({ type: "details", path: LOGIN, details: { ...fixtureDetails(), files: [], filesTotal: 0, filesUnread: true } });
  await page.clickOn(`.wt-item[data-path="${LOGIN}"] .cr-commit`);
  const sha = fixtureDetails().unpushed!.commits[0].sha;
  await page.send({ type: "commitFiles", path: LOGIN, sha, files: null });
  const said = await page.eval<{ uncommitted: string; label: string; commit: string }>(`(function () {
    var d = document.querySelector('.wt-item[data-path="${LOGIN}"] .wt-details');
    return {
      uncommitted: d.querySelector(".cr-empty").textContent,
      label: d.querySelector(".cr-section-label").textContent,
      commit: d.querySelector('.cr-commit-item[data-sha="${sha}"] .cr-commit-files').textContent,
    };
  })()`);
  assert.deepEqual(said, { uncommitted: "Couldn't read its uncommitted changes.", label: "Uncommitted", commit: "Couldn't read this commit's files." });
});

test("the keyboard walks one tree: ↓ ↑ between rows and into an open one, → opens, ← closes and climbs, Enter toggles", { skip }, async () => {
  const page = await open();
  await page.eval(`document.querySelector('.wt-row').focus()`);
  const focused = () =>
    page.eval<string>(`(function () { var a = document.activeElement; if (!a) return ""; return (a.dataset.path || "") + "|" + (a.classList.contains("wt-row") ? "row" : a.className.split(" ")[0]); })()`);
  assert.equal(await focused(), `${LOGIN}|row`);
  await page.key("ArrowDown");
  assert.equal(await focused(), "/code/app|row");
  await page.key("ArrowUp");
  await page.clearPosted();
  await page.key("ArrowRight");
  assert.deepEqual(await asked(page), [{ type: "expand", path: LOGIN }]);
  await page.send({ type: "details", path: LOGIN, details: fixtureDetails() });
  await page.key("ArrowRight"); // open → into its first item: its upstream, Pull and Push… in it
  assert.equal(await focused(), "|wt-strip");
  assert.equal(await page.eval<string>(`document.activeElement.getAttribute("aria-label")`), "origin/feature/login");
  await page.key("ArrowDown");
  assert.equal(await focused(), "src/auth/login.ts|cr-file");
  await page.key("ArrowDown");
  assert.equal(await focused(), "src/auth/session.ts|cr-file");
  await page.key("ArrowLeft"); // climbs to the row
  assert.equal(await focused(), `${LOGIN}|row`);
  await page.clearPosted();
  await page.key("ArrowLeft"); // closes it
  assert.equal((await lineOf(page, LOGIN))?.expanded, "false");
  assert.deepEqual(await asked(page), [{ type: "collapse", path: LOGIN }]);
  await page.key("Enter");
  assert.equal((await lineOf(page, LOGIN))?.expanded, "true");
  await page.key("End");
  assert.equal(await focused(), "/code/app-usb|row");
  // One tab stop for the tree: every other item is -1.
  const tabStops = await page.eval<number>(`document.querySelectorAll('.wt-list [role=treeitem][tabindex="0"]').length`);
  assert.equal(tabStops, 1);
});

test("a screen reader hears one tree: an open row OWNS its group, and every item in the group is a treeitem — its upstream (with Pull and Push… in it), its files, its commits", { skip }, async () => {
  const page = await open("dark", 320, 900);
  await page.clickOn(`.wt-row[data-path="${LOGIN}"] .wt-name`);
  await page.send({ type: "details", path: LOGIN, details: fixtureDetails() });
  await page.settle(60);
  await page.page.send("Accessibility.enable", {});
  const { nodes } = (await page.page.send("Accessibility.getFullAXTree", {})) as {
    nodes: { nodeId: string; ignored?: boolean; role?: { value: string }; name?: { value: string }; childIds?: string[]; properties?: { name: string; value: { value: unknown } }[] }[];
  };
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  // The children a screen reader sees: ignored and generic wrappers are looked through.
  const kids = (id: string): typeof nodes => {
    const out: typeof nodes = [];
    for (const c of byId.get(id)?.childIds ?? []) {
      const n = byId.get(c);
      if (!n) continue;
      if (n.ignored || n.role?.value === "generic" || n.role?.value === "none" || n.role?.value === "StaticText" || n.role?.value === "InlineTextBox") out.push(...kids(c));
      else out.push(n);
    }
    return out;
  };
  const level = (n: (typeof nodes)[number]) => n.properties?.find((x) => x.name === "level")?.value.value;
  const tree = nodes.find((n) => n.role?.value === "tree")!;
  const login = kids(tree.nodeId).find((n) => n.role?.value === "treeitem" && (n.name?.value ?? "").startsWith("app-login"))!;
  assert.ok(login, "the row is a treeitem of the tree");
  assert.ok(!kids(tree.nodeId).some((n) => n.role?.value === "group"), "no group hangs off the tree beside its row");
  const group = kids(login.nodeId).find((n) => n.role?.value === "group");
  assert.ok(group, `the open row owns its group: ${kids(login.nodeId).map((n) => n.role?.value).join(", ")}`);
  const items = kids(group!.nodeId);
  assert.deepEqual([...new Set(items.map((n) => n.role?.value))], ["treeitem"], `only treeitems in the group: ${items.map((n) => `${n.role?.value} ${n.name?.value}`).join(" | ")}`);
  assert.equal(items[0].name?.value, "origin/feature/login");
  assert.deepEqual(kids(items[0].nodeId).filter((n) => n.role?.value === "button").map((n) => n.name?.value), [
    "Pull into app-login, in its own folder",
    "Review what app-login would push",
  ]);
  assert.deepEqual(items.map(level), items.map(() => 2), "all at level 2, under the row at level 1");
  assert.equal(level(login), 1);
});

test("⌘⌫ on a row asks to remove it, as Delete does — a Mac's delete key sends Backspace", { skip }, async () => {
  const page = await open();
  await page.eval(`document.querySelector('.wt-row[data-path="/code/app-spike"]').focus()`);
  await page.clearPosted();
  await page.key("Backspace");
  assert.deepEqual(await asked(page), [], "Backspace alone is not a delete");
  await page.key("Backspace", { with: ["meta"] });
  assert.deepEqual(await asked(page), [{ type: "action", path: "/code/app-spike", action: "remove" }]);
  await page.eval(`document.querySelector('.wt-row[data-path="/code/app-old"]').focus()`);
  await page.clearPosted();
  await page.key("Backspace", { with: ["meta"] });
  assert.deepEqual(await asked(page), [{ type: "action", path: "/code/app-old", action: "forget" }]);
});

test("More: every action in words; one it can't take is shown with the reason; Escape gives the row back the keyboard", { skip }, async () => {
  const page = await open();
  await page.clickOn(`.wt-row[data-path="${AGENT}"] .wt-more`);
  const items = await page.eval<{ label: string; why: string; disabled: boolean }[]>(`Array.prototype.map.call(document.querySelectorAll(".wt-menu-item"), function (b) {
    var why = b.querySelector(".wt-menu-why");
    return { label: b.querySelector(".wt-menu-label").textContent, why: why ? why.textContent : "", disabled: b.getAttribute("aria-disabled") === "true" };
  })`);
  assert.deepEqual(items, [
    { label: "Open in This Window", why: "", disabled: false },
    { label: "Open in New Window", why: "", disabled: false },
    { label: "Reveal in Finder", why: "", disabled: false },
    { label: "Open in Terminal", why: "", disabled: false },
    { label: "Copy Path", why: "", disabled: false },
    { label: "Pull", why: "Its branch has no upstream to pull from.", disabled: true },
    { label: "Push…", why: "", disabled: false },
    { label: "Unlock", why: "", disabled: false },
    { label: "Remove Worktree…", why: "", disabled: false },
  ]);
  const focusedLabel = await page.eval<string>(`document.activeElement.querySelector(".wt-menu-label").textContent`);
  assert.equal(focusedLabel, "Open in This Window");
  await page.key("Escape");
  const back = await page.eval<string>(`document.activeElement.dataset.path`);
  assert.equal(back, AGENT);
  assert.equal(await page.eval<number>(`document.querySelectorAll(".wt-menu").length`), 0);

  // This window's worktree: Open says why not, and there is no Remove to take.
  await page.clickOn(`.wt-row[data-path="${LOGIN}"] .wt-more`);
  const mine = await page.eval<Record<string, string>>(`(function () { var o = {}; document.querySelectorAll(".wt-menu-item").forEach(function (b) {
    var why = b.querySelector(".wt-menu-why"); o[b.querySelector(".wt-menu-label").textContent] = why ? why.textContent : ""; }); return o; })()`);
  assert.equal(mine["Open in New Window"], "This window has it open.");
  assert.match(mine["Remove Worktree…"], /deleted from under the window/);
  // A disabled item does nothing.
  await page.clearPosted();
  await page.eval(`Array.prototype.find.call(document.querySelectorAll(".wt-menu-item"), function (b) { return b.textContent.indexOf("Remove Worktree") === 0; }).click()`);
  assert.deepEqual(await asked(page), []);
});

/** A row's More menu, opened, as a person reads it: each item's words, why not, and whether it is disabled. */
async function menuOf(page: WorktreesPage, path: string): Promise<{ label: string; why: string; disabled: boolean }[]> {
  await page.clickOn(`.wt-row[data-path="${path}"] .wt-more`);
  const items = await page.eval<{ label: string; why: string; disabled: boolean }[]>(`Array.prototype.map.call(document.querySelectorAll(".wt-menu-item"), function (b) {
    var why = b.querySelector(".wt-menu-why");
    return { label: b.querySelector(".wt-menu-label").textContent, why: why ? why.textContent : "", disabled: b.getAttribute("aria-disabled") === "true" };
  })`);
  await page.key("Escape");
  return items;
}

test("Lock… is on every worktree's menu — disabled with why where git can't lock it; a stopped rebase is the reason Pull and Push give", { skip }, async () => {
  const rebasing = row({ path: "/code/app-rebase", name: "app-rebase", branch: undefined, upstream: undefined, status: { changed: 1, staged: 0, unstaged: 0, untracked: 0, conflicted: 1, operation: "rebase", rebasing: "feature/rebase" } });
  const page = await open("dark", 320, 900);
  await page.send({ type: "rows", rows: [...fixtureRows(), rebasing], state: "ok", labels: LABELS });
  await page.settle();
  const lockOf = async (p: string) => (await menuOf(page, p)).filter((i) => i.label === "Lock…" || i.label === "Unlock");
  assert.deepEqual(await lockOf("/code/app"), [{ label: "Lock…", why: "The main worktree holds the repository itself, so git can't lock it.", disabled: true }]);
  assert.deepEqual(await lockOf("/code/app-old"), [{ label: "Lock…", why: "Its folder is missing.", disabled: true }]);
  assert.deepEqual(await lockOf("/code/app-usb"), [{ label: "Unlock", why: "", disabled: false }]);
  assert.deepEqual(await lockOf("/code/app-checkout"), [{ label: "Lock…", why: "", disabled: false }]);
  assert.deepEqual(await menuOf(page, UNLINKED), [
    { label: "Reveal in Finder", why: "", disabled: false },
    { label: "Copy Path", why: "", disabled: false },
    { label: "Lock…", why: "It isn't a worktree any more — its .git file is gone.", disabled: true },
    { label: "Forget Worktree…", why: "", disabled: false },
  ]);
  const stopped = (await menuOf(page, "/code/app-rebase")).filter((i) => i.label === "Pull" || i.label === "Push…");
  const why = "A rebase is stopped in it — continue or abort it first.";
  assert.deepEqual(stopped, [
    { label: "Pull", why, disabled: true },
    { label: "Push…", why, disabled: true },
  ]);
  // A disabled Lock… does nothing.
  await page.clickOn(`.wt-row[data-path="/code/app"] .wt-more`);
  await page.clearPosted();
  await page.eval(`Array.prototype.find.call(document.querySelectorAll(".wt-menu-item"), function (b) { return b.textContent.indexOf("Lock…") === 0; }).click()`);
  assert.deepEqual(await asked(page), []);
});

test("a menu item asks the host for exactly that action on exactly that worktree", { skip }, async () => {
  const page = await open();
  await page.clickOn(`.wt-row[data-path="/code/app-checkout"] .wt-more`);
  await page.clearPosted();
  await page.eval(`Array.prototype.find.call(document.querySelectorAll(".wt-menu-item"), function (b) { return b.textContent.indexOf("Remove Worktree") === 0; }).click()`);
  assert.deepEqual(await asked(page), [{ type: "action", path: "/code/app-checkout", action: "remove" }]);
  // The row's own button: Open in New Window, at once.
  await page.clearPosted();
  await page.clickOn(`.wt-row[data-path="/code/app-checkout"] [data-action="openNew"]`);
  assert.deepEqual(await asked(page), [{ type: "action", path: "/code/app-checkout", action: "openNew" }]);
  // A missing folder's button is Forget — and so is one that isn't a worktree any more.
  for (const gone of ["/code/app-old", UNLINKED]) {
    await page.clearPosted();
    assert.equal(await page.eval<string>(`document.querySelector('.wt-row[data-path="${gone}"] .wt-actions button').getAttribute("aria-label")`), "Forget Worktree…");
    await page.clickOn(`.wt-row[data-path="${gone}"] [data-action="forget"]`);
    assert.deepEqual(await asked(page), [{ type: "action", path: gone, action: "forget" }]);
  }
  // Delete on a row asks to remove it.
  await page.eval(`document.querySelector('.wt-row[data-path="/code/app-spike"]').focus()`);
  await page.clearPosted();
  await page.key("Delete");
  assert.deepEqual(await asked(page), [{ type: "action", path: "/code/app-spike", action: "remove" }]);
});

test("Unlock paints at once — the lock goes before the host answers — and comes back if git says no", { skip }, async () => {
  const page = await open();
  await page.clickOn(`.wt-row[data-path="${AGENT}"] .wt-more`);
  await page.clearPosted();
  await page.eval(`Array.prototype.find.call(document.querySelectorAll(".wt-menu-item"), function (b) { return b.textContent.indexOf("Unlock") === 0; }).click()`);
  assert.deepEqual(await asked(page), [{ type: "action", path: AGENT, action: "unlock" }]);
  assert.deepEqual((await lineOf(page, AGENT))?.badges.some((b) => b.startsWith("Locked")), false, "unlocked on screen now");
  const sameNode = await page.eval<boolean>(`(window.__agentRow = document.querySelector('.wt-item[data-path="${AGENT}"]'), true)`);
  assert.ok(sameNode);
  await page.send({ type: "patch", path: AGENT, row: { locked: true, lockReason: "claude agent agent-a2c9ae276dde4d3da (pid 73264)" } });
  assert.ok((await lineOf(page, AGENT))?.badges[0].startsWith("Locked:"), "put back");
  assert.equal(await page.eval<boolean>(`document.querySelector('.wt-item[data-path="${AGENT}"]') === window.__agentRow`), true, "patched in place, not rebuilt");
});

test("a running action: the row says what it is doing and takes no second one; then it goes, and the keyboard moves on", { skip }, async () => {
  const page = await open();
  await page.eval(`document.querySelector('.wt-row[data-path="/code/app-checkout"]').focus()`);
  await page.send({ type: "busy", path: "/code/app-checkout", busy: true, label: "Removing…" });
  const busy = await page.eval<{ text: string; disabled: boolean[]; ariaBusy: string | null }>(`(function () {
    var l = document.querySelector('.wt-row[data-path="/code/app-checkout"]');
    return { text: l.querySelector(".wt-line2").textContent, disabled: Array.prototype.map.call(l.querySelectorAll("button"), function (b) { return b.disabled; }), ariaBusy: l.getAttribute("aria-busy") };
  })()`);
  assert.match(busy.text, /^Removing…/);
  assert.deepEqual(busy.disabled, [true, true]);
  assert.equal(busy.ariaBusy, "true");
  await page.clearPosted();
  await page.key("Delete");
  assert.deepEqual(await asked(page), [], "no second action while one runs");
  const next = await page.eval<string>(`(function () { var ls = document.querySelectorAll(".wt-row"); for (var i = 0; i < ls.length; i++) if (ls[i].dataset.path === "/code/app-checkout") return ls[i + 1].dataset.path; })()`);
  await page.send({ type: "drop", path: "/code/app-checkout" });
  assert.equal(await lineOf(page, "/code/app-checkout"), null);
  assert.equal(await page.eval<string>(`document.activeElement.dataset.path`), next, "the next row has the keyboard");
});

test("the same list again changes nothing on screen: open rows stay open, the focused row keeps the keyboard", { skip }, async () => {
  const page = await open();
  await page.clickOn(`.wt-row[data-path="${LOGIN}"] .wt-name`);
  await page.send({ type: "details", path: LOGIN, details: fixtureDetails() });
  await page.eval(`(window.__row = document.querySelector('.wt-row[data-path="/code/app-spike"]'), window.__row.focus())`);
  await page.send({ type: "rows", rows: fixtureRows(), state: "ok", labels: LABELS });
  assert.equal(await page.eval<boolean>(`document.activeElement === window.__row`), true);
  assert.equal((await lineOf(page, LOGIN))?.expanded, "true");
  assert.equal(await page.eval<number>(`document.querySelectorAll('.wt-item[data-path="${LOGIN}"] .cr-file').length`), 5);
});

test("an open commit and the file row with the keyboard survive a status for that row, a list where another row changed, and details that did not change", { skip }, async () => {
  const page = await open("dark", 320, 900);
  const SHA = fixtureDetails().unpushed!.commits[0].sha;
  const files = [
    { path: "src/auth/session.ts", status: "M", additions: 24, deletions: 3 },
    { path: "src/auth/store.ts", status: "A", additions: 41, deletions: 0 },
  ];
  await page.clickOn(`.wt-row[data-path="${LOGIN}"] .wt-name`);
  await page.send({ type: "details", path: LOGIN, details: fixtureDetails() });
  await page.clickOn(`.wt-item[data-path="${LOGIN}"] .cr-commit`);
  await page.send({ type: "commitFiles", path: LOGIN, sha: SHA, files });
  // The second file under the open commit has the keyboard.
  await page.eval(`(window.__file = document.querySelectorAll('.wt-item[data-path="${LOGIN}"] .cr-commit-files .cr-file')[1], window.__file.focus())`);
  const state = () =>
    page.eval<{ sameFocus: boolean; focusText: string; filesUnder: string; open: boolean; height: number; top: number }>(`(function () {
      var item = document.querySelector('.wt-item[data-path="${LOGIN}"]');
      var commit = item.querySelector('.cr-commit-item[data-sha="${SHA}"]');
      return {
        sameFocus: document.activeElement === window.__file,
        focusText: document.activeElement ? document.activeElement.tagName + "." + document.activeElement.className : "",
        filesUnder: commit.querySelector(".cr-commit-files").textContent,
        open: commit.classList.contains("open"),
        height: item.querySelector(".wt-details").getBoundingClientRect().height,
        top: window.__file.getBoundingClientRect().top,
      };
    })()`);
  const before = await state();
  assert.equal(before.sameFocus, true);
  assert.match(before.filesUnder, /session\.ts.*store\.ts/);

  const settled = async (what: string) => {
    const now = await state();
    assert.equal(now.sameFocus, true, `${what}: the file row keeps the keyboard (on ${JSON.stringify(now.focusText)})`);
    assert.equal(now.open, true, `${what}: the commit stays open`);
    assert.equal(now.filesUnder, before.filesUnder, `${what}: its files stay — never "Loading files…" again`);
    assert.equal(now.height, before.height, `${what}: the open row keeps its height`);
    assert.equal(now.top, before.top, `${what}: nothing moves`);
    assert.deepEqual((await asked(page)).filter((m) => m.type === "commitFiles"), [], `${what}: the files are not asked for again`);
  };

  // 1. A status for THIS row (one more change).
  await page.clearPosted();
  await page.send({ type: "status", path: LOGIN, status: { changed: 6, staged: 2, unstaged: 3, untracked: 1, conflicted: 0 } });
  await page.settle();
  await settled("a status for the row");
  assert.deepEqual((await lineOf(page, LOGIN))?.badges, ["This window", "6 changed", "2 to push"], "the row itself says the new count");

  // 2. A list in which only ANOTHER row changed.
  const rows = fixtureRows().map((r) =>
    r.path === "/code/app-checkout" ? { ...r, ahead: 2 } : r.path === LOGIN ? { ...r, status: { changed: 6, staged: 2, unstaged: 3, untracked: 1, conflicted: 0 } } : r,
  );
  await page.send({ type: "rows", rows, state: "ok", labels: LABELS });
  await page.settle();
  await settled("a list where another row changed");

  // 3. Its details sent again, the same commits: the open one is kept, with its files.
  await page.send({ type: "details", path: LOGIN, details: fixtureDetails() });
  await page.settle();
  await settled("the same details again");

  // 3b. Details that did change — one more uncommitted file — above the open commit: it keeps its files and the keyboard.
  const more = fixtureDetails();
  more.files.push({ path: "src/auth/new.ts", status: "U", area: "untracked" });
  more.filesTotal += 1;
  await page.send({ type: "details", path: LOGIN, details: more });
  await page.settle();
  const moved = await state();
  assert.deepEqual([moved.sameFocus, moved.open, moved.filesUnder], [true, true, before.filesUnder], "new details: the open commit is the same, with its files");
  assert.deepEqual((await asked(page)).filter((m) => m.type === "commitFiles"), []);
  await page.send({ type: "details", path: LOGIN, details: fixtureDetails() });
  await page.settle();
  await settled("the details as they were");

  // 4. A list that changes THIS row's upstream: the strip says so, the commits are untouched.
  await page.send({ type: "rows", rows: rows.map((r) => (r.path === LOGIN ? { ...r, ahead: 3 } : r)), state: "ok", labels: LABELS });
  await page.settle();
  await settled("a list that changes this row");
  assert.deepEqual(page.errors(), []);
});

test("past eight worktrees a filter appears; it narrows by folder, branch or path, and says when nothing matches", { skip }, async () => {
  const page = await open();
  const shown = () => page.eval<boolean>(`!document.querySelector(".wt-filter").hidden`);
  assert.equal(await shown(), true);
  assert.equal(await page.eval<string>(`document.querySelector(".wt-filter-input").placeholder`), "Filter 11 worktrees");
  await page.clickOn(".wt-filter-input");
  await page.type("login");
  const visible = () => page.eval<string[]>(`Array.prototype.filter.call(document.querySelectorAll(".wt-item"), function (i) { return !i.hidden; }).map(function (i) { return i.dataset.path; })`);
  assert.deepEqual(await visible(), [LOGIN]);
  await page.type("zzz");
  assert.deepEqual(await visible(), []);
  assert.match(await page.eval<string>(`document.querySelector(".wt-note").textContent`), /No worktree matches “loginzzz”/);
  await page.key("Escape");
  assert.equal((await visible()).length, 11);
  // Eight or fewer: no filter.
  await page.send({ type: "rows", rows: fixtureRows().slice(0, 8), state: "ok", labels: LABELS });
  assert.equal(await shown(), false);
});

test("Prune N: shown only when git would prune something — unlocked, missing or not a worktree any more — and says which", { skip }, async () => {
  const page = await open();
  const prune = () => page.eval<{ hidden: boolean; text: string; tip: string }>(`(function () { var b = document.querySelector(".wt-prune"); return { hidden: b.hidden, text: b.textContent, tip: b.getAttribute("aria-label") }; })()`);
  assert.deepEqual(await prune(), {
    hidden: false,
    text: "Prune 2 stale",
    tip: "Forget the 2 worktrees git can prune: their folders are gone, or aren't worktrees any more",
  });
  await page.clearPosted();
  await page.clickOn(".wt-prune");
  assert.deepEqual(await asked(page), [{ type: "prune" }]);
  await page.send({ type: "rows", rows: fixtureRows().filter((r) => r.path !== UNLINKED), state: "ok", labels: LABELS });
  assert.deepEqual(await prune(), { hidden: false, text: "Prune 1 missing", tip: "Forget the worktree whose folder is gone" });
  await page.send({ type: "rows", rows: fixtureRows().filter((r) => r.path !== "/code/app-old" && r.path !== UNLINKED), state: "ok", labels: LABELS });
  assert.equal((await prune()).hidden, true, "only a locked one is missing: git keeps it");
});

test("only the main worktree: it says what a worktree is for, with New Worktree…", { skip }, async () => {
  const page = await open();
  await page.send({ type: "rows", rows: [fixtureRows()[0]], state: "ok", labels: LABELS });
  const note = await page.eval<string>(`document.querySelector(".wt-note").textContent`);
  assert.match(note, /Work on another branch, side by side/);
  assert.match(note, /New Worktree…/);
  await page.clearPosted();
  await page.clickOn(".wt-add");
  assert.deepEqual(await asked(page), [{ type: "add" }]);
  await page.send({ type: "rows", rows: [], state: "noRepo", labels: LABELS });
  assert.match(await page.eval<string>(`document.querySelector(".wt-note").textContent`), /No repository open/);
  await page.send({ type: "rows", rows: [], state: "discovering", labels: LABELS });
  assert.match(await page.eval<string>(`document.querySelector(".wt-note").textContent`), /Looking for a repository…/);
});

test("badges that don't fit become '+N more' naming them — never a word cut at the edge", { skip }, async () => {
  const page = await WorktreesPage.open("dark", { width: 250, height: 500 });
  opened.push(page);
  const crowded = row({
    path: "/code/app-x",
    name: "app-x",
    current: true,
    ahead: 3,
    behind: 2,
    status: { changed: 4, staged: 1, unstaged: 3, untracked: 0, conflicted: 1, operation: "merge" },
  });
  await page.send({ type: "rows", rows: [crowded], state: "ok", labels: LABELS });
  await page.settle();
  const fit = await page.eval<{ shown: string[]; more: string; tip: string; overflow: boolean }>(`(function () {
    var l2 = document.querySelector(".wt-line2");
    var shown = Array.prototype.filter.call(l2.querySelectorAll(".wt-badge"), function (b) { return !b.hidden && !b.classList.contains("wt-badge--more"); }).map(function (b) { return b.textContent; });
    var more = l2.querySelector(".wt-badge--more");
    var right = l2.getBoundingClientRect().right;
    var overflow = Array.prototype.some.call(l2.querySelectorAll(".wt-badge"), function (b) { return !b.hidden && b.getBoundingClientRect().right > right + 0.5; });
    return { shown: shown, more: more ? more.textContent : "", tip: more ? more.dataset.tip : "", overflow: overflow };
  })()`);
  assert.equal(fit.overflow, false, "nothing past the edge");
  assert.ok(fit.shown.length >= 1 && fit.shown[0] === "This window");
  assert.match(fit.more, /^\+\d more$/);
  assert.ok(fit.tip.includes("to push"), fit.tip);
  // At a sidebar's narrowest, on every row: nothing past the edge, and a
  // "+N more" is never the badge that is cut.
  await page.page.send("Emulation.setDeviceMetricsOverride", { width: 240, height: 800, deviceScaleFactor: 1, mobile: false });
  await page.send({ type: "rows", rows: [...fixtureRows(), crowded], state: "ok", labels: LABELS });
  await page.settle(80);
  const cut = await page.eval<string[]>(`(function () {
    var out = [];
    document.querySelectorAll(".wt-line2").forEach(function (l2) {
      var right = l2.getBoundingClientRect().right;
      l2.querySelectorAll(".wt-badge").forEach(function (b) {
        if (b.hidden) return;
        var r = b.getBoundingClientRect();
        if (r.right > right + 0.5) out.push(b.textContent + " past the edge");
        if (b.classList.contains("wt-badge--more") && b.scrollWidth > b.clientWidth + 1) out.push(b.textContent + " cut");
      });
    });
    return out;
  })()`);
  assert.deepEqual(cut, []);
  // Wider: they all fit, and the "+N more" goes.
  await page.page.send("Emulation.setDeviceMetricsOverride", { width: 700, height: 500, deviceScaleFactor: 1, mobile: false });
  await page.settle(80);
  assert.equal(await page.eval<number>(`document.querySelectorAll(".wt-badge--more").length`), 0);
});

test("the page tells the host which rows are in view — and again as they scroll into it", { skip }, async () => {
  const page = await WorktreesPage.open("dark", { width: 300, height: 200 });
  opened.push(page);
  const many = Array.from({ length: 20 }, (_, i) => row({ path: `/code/wt-${i}`, name: `wt-${String(i).padStart(2, "0")}` }));
  await page.send({ type: "rows", rows: many, state: "ok", labels: LABELS });
  await page.settle(120);
  const lastVisible = async () => {
    const posted = await page.posted();
    const v = posted.filter((m) => m.type === "visible").pop();
    return (v?.paths as string[] | undefined) ?? [];
  };
  const first = await lastVisible();
  assert.ok(first.includes("/code/wt-0"));
  assert.ok(!first.includes("/code/wt-19"), "not the rows out of view");
  await page.eval(`document.querySelector('.wt-row[data-path="/code/wt-19"]').scrollIntoView()`);
  await page.settle(120);
  const second = await lastVisible();
  assert.ok(second.includes("/code/wt-19"));
  assert.ok(!second.includes("/code/wt-0"));
});
