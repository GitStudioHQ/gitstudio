import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ChangesPage, stateMessage, type LocalBranch } from "./changesPage";

// The branch menu's search ("Search for branches and actions"): one scorer
// for the actions and every ref, in the real page commitView.ts serves, in a
// windowless Chrome with real keys.
//   · a query matches exactly, as a prefix of the name, as a prefix of its
//     last path segment, as a run that starts a word, as a run anywhere, or
//     as scattered letters that each follow the one before or start a word
//     ("rel21" finds release/2.1; "fe" does not find fix/some-page) — each
//     way outranking the next, so a prefix is never beaten by a scatter;
//   · with a query, the highlight — what Enter runs — is on the best match
//     of all, and on a tie a ref beats an action: "fe" is feature, not
//     Fetch; "fetch" is Fetch;
//   · every matched letter is marked, on the highlighted row too;
//   · a query no ref matches offers New Branch '<query>'… (highlighted, so
//     Enter makes it) and Checkout Revision '<query>'…, each opening its
//     dialog with the query as typed; a revision starting with "-" is
//     refused there, since git would read it as an option;
//   · in Checkout Tag or Revision…, a ref picked from the list goes to the
//     host with its kind, and what was typed goes as typed;
//   · until the arrows or the pointer move it, a repaint from the host puts
//     the highlight back on the best match (branches that arrived after the
//     query was typed); after, it stays where they put it;
//   · on a detached HEAD, Pull and Push are not offered, and one line says
//     why where they would be — read out with the search box — with the box
//     empty, or a query looking for one of them by a start ("pu", "u" for
//     update), never for a letter inside them ("t");
//   · the branch you're on with no upstream, or a gone one, offers no Pull
//     at the top, as its own actions offer none; looked for, a line says why;
//   · Pull is "Pull" everywhere, and still found by "update".

const chrome = ChangesPage.chrome();
const skip = chrome ? false : "no windowless Chrome on this machine (set GS_CHROME)";

// Each query below has a weaker match listed ABOVE its best one — a
// favourite, a branch earlier in the list — so a highlight that went to the
// first match would be on the wrong row.
const LOCAL: LocalBranch[] = [
  { name: "main", current: true, upstream: "origin/main", upstreamOnRemote: true },
  { name: "feature", upstream: "origin/feature", upstreamOnRemote: true, favorite: true },
  { name: "maintenance", favorite: true },
  { name: "dev/v2.1-notes" },
  { name: "fetch-fix" },
  { name: "hotfix/precache-warmup" },
  { name: "prefixes-cleanup" },
  { name: "release/2.1", upstream: "origin/release/2.1", upstreamOnRemote: true },
  { name: "spike/cache" },
  { name: "sync-upstream/fix" },
  { name: "topic" },
];
const REMOTE = ["origin/main", "origin/feature", "origin/release/2.1", "upstream/fixes"];
const STATE = stateMessage({ local: LOCAL, remote: REMOTE, tags: ["v2.1.0", "v2.0.0"] });

let page: ChangesPage;
before(async () => {
  if (chrome) page = await ChangesPage.open("dark", { width: 560, height: 640 });
});
after(async () => {
  if (page) await page.close();
});

async function openMenu(state: unknown = STATE): Promise<void> {
  await page.eval(`(function () { if (document.querySelector(".branch-menu")) document.getElementById("branch-pill").click(); window.__posted.length = 0; })()`);
  await page.send(state);
  await page.send({ type: "openBranchMenu" });
  await page.page.waitFor(`!!document.querySelector(".branch-menu .bm-search input")`);
  await page.eval(`new Promise(function (r) { setTimeout(r, 20); })`);
}
async function query(q: string): Promise<void> {
  await page.eval(`(function () { var i = document.querySelector(".bm-search input"); i.value = ""; i.dispatchEvent(new Event("input")); })()`);
  if (q) await page.type(q);
}
const highlighted = (): Promise<{ key: string | null; described: boolean }> =>
  page.eval(`(function () {
    var a = document.querySelector(".bm-list .is-active");
    var input = document.querySelector(".bm-search input");
    var ad = input.getAttribute("aria-activedescendant");
    return { key: a ? a.dataset.bmkey : null, described: !!a && ad === a.id };
  })()`);

type Match = { s: number; pos: number[] } | null;
const score = (q: string, text: string): Promise<Match> =>
  page.eval<Match>(`bmScore(${JSON.stringify(q)}, ${JSON.stringify(text)})`);

test("the scorer: each way of matching, best first, and the letters it marks", { skip }, async () => {
  // [query, text, the way it matches (or null), the letters marked]
  const table: [string, string, string | null, number[] | null][] = [
    ["main", "main", "exact", [0, 1, 2, 3]],
    ["fe", "feature", "prefix", [0, 1]],
    ["fe", "FEATURE", "prefix", [0, 1]],
    ["login", "feature/login", "segment", [8, 9, 10, 11, 12]],
    ["cache", "spike/the-cache", "word", [10, 11, 12, 13, 14]],
    ["bar", "fooBar", "word", [3, 4, 5]],
    ["ach", "spike/cache", "run", [7, 8, 9]],
    ["rel21", "release/2.1", "scattered", [0, 1, 2, 8, 10]],
    ["fl", "feature/login", "scattered", [0, 8]],
    ["fb", "fooBar", "scattered", [0, 3]],
    ["v21", "v2.1.0", "scattered", [0, 1, 3]],
    // Scattered letters must follow one another or start a word.
    ["fe", "fix/some-page", null, null],
    ["rl", "parallel", null, null],
    ["zzzq", "main", null, null],
  ];
  const tiers = await page.eval<Record<string, number>>(`BM_TIER`);
  const tierOf = (s: number): string =>
    Object.entries(tiers).sort((a, b) => b[1] - a[1]).find(([, v]) => s >= v)![0];
  for (const [q, text, way, pos] of table) {
    const m = await score(q, text);
    if (way === null) {
      assert.equal(m, null, `'${q}' does not match '${text}'`);
      continue;
    }
    assert.ok(m, `'${q}' matches '${text}'`);
    assert.equal(tierOf(m.s), way, `'${q}' matches '${text}' as ${way} (score ${m.s})`);
    assert.deepEqual(m.pos, pos, `'${q}' in '${text}' marks ${JSON.stringify(pos)}`);
  }
  // Each way outranks every one after it, whatever the position.
  const ranked = [
    await score("feature", "feature"),
    await score("feat", "feature-with-a-long-tail"),
    await score("log", "a/very/deep/path/login"),
    await score("cache", "spike/the-cache"),
    await score("ach", "spike/cache"),
    await score("fl", "feature/login"),
  ].map((m) => m!.s);
  for (let i = 1; i < ranked.length; i++) assert.ok(ranked[i - 1] > ranked[i], `rank ${i - 1} > rank ${i}: ${ranked.join(" > ")}`);
  // Of two scattered matches, the one in fewer pieces wins.
  const two = (await score("fel", "fe/lib"))!;
  const three = (await score("fel", "f/e/lib"))!;
  assert.deepEqual([two.pos, three.pos], [[0, 1, 3], [0, 2, 4]]);
  assert.ok(two.s > three.s, `two pieces (${two.s}) over three (${three.s})`);
});

// Where the highlight lands with each query — the row Enter runs. One row
// per case; the keys are the rows' data-bmkey.
const BEST: [string, string, string][] = [
  ["fe", "b:local:feature", "a branch ties Fetch's prefix match, and wins"],
  ["fetch", "a:fetch", "the action's exact name beats a branch's prefix (fetch-fix)"],
  ["pull", "a:pull", "an action nothing else matches"],
  ["update", "a:pull", "Pull's old name still finds it"],
  ["new", "a:new", "New Branch…"],
  ["re", "b:local:release/2.1", "a prefix beats 'Revision' (a word inside an action)"],
  ["rel21", "b:local:release/2.1", "scattered letters"],
  ["cache", "b:local:spike/cache", "the last path segment, over a run inside hotfix/precache-warmup above it"],
  ["main", "b:local:main", "an exact name, over the favourite 'maintenance' above it and the remote 'main' below"],
  ["v2.1", "b:tag:v2.1.0", "a tag's prefix, far down the list, over dev/v2.1-notes' last segment"],
  ["fixes", "b:remote:upstream/fixes", "a remote branch by the name its row shows, over prefixes-cleanup"],
  ["upstream/fi", "b:remote:upstream/fixes", "and by its whole name, over sync-upstream/fix"],
  ["zzzq", "a:newNamed", "nothing matches: New Branch 'zzzq'…"],
];

for (const [q, key, why] of BEST) {
  test(`typing '${q}' highlights ${key} — ${why}`, { skip }, async () => {
    await openMenu();
    await query(q);
    const h = await highlighted();
    assert.equal(h.key, key);
    assert.ok(h.described, "the box's aria-activedescendant names it");
    // And it is on screen.
    assert.ok(await page.eval(`(function () {
      var l = document.querySelector(".bm-list").getBoundingClientRect(), r = document.querySelector(".bm-list .is-active").getBoundingClientRect();
      return r.top >= l.top - 1 && r.bottom <= l.bottom + 1;
    })()`), "and in view");
  });
}

test("'fe' + Enter opens feature's actions; it never runs Fetch", { skip }, async () => {
  await openMenu();
  await query("fe");
  await page.key("Enter");
  const s = await page.eval<{ sub: string | null; head: string | null }>(`({
    sub: document.querySelector(".branch-submenu .is-active") ? document.querySelector(".branch-submenu .is-active").textContent.trim() : null,
    head: document.querySelector(".branch-submenu .bm-subhead-name") ? document.querySelector(".branch-submenu .bm-subhead-name").textContent : null,
  })`);
  assert.equal(s.head, "feature");
  assert.equal(s.sub, "Checkout");
  assert.deepEqual((await page.posted()).filter((m) => m.type === "branchAction"), [], "nothing ran");
  // "fetch" + Enter does fetch.
  await page.key("Escape");
  await query("fetch");
  await page.key("Enter");
  assert.deepEqual((await page.posted()).filter((m) => m.type === "branchAction"), [{ type: "branchAction", action: "fetch" }]);
  await page.send({ type: "branchActionDone", action: "fetch" }); // the host's answer: it finished
});

test("every matched letter is marked — on a plain row and on the highlighted one", { skip }, async () => {
  await openMenu();
  await query("rel21");
  const marks = await page.eval<Record<string, string[]>>(`(function () {
    var out = {};
    document.querySelectorAll(".bm-list .bm-branch").forEach(function (r) {
      out[r.dataset.bmkey + (r.classList.contains("is-active") ? " (highlighted)" : "")] =
        Array.prototype.map.call(r.querySelectorAll(".bm-bname .bm-hl"), function (m) { return m.textContent; });
    });
    return out;
  })()`);
  assert.deepEqual(marks, {
    "b:local:release/2.1 (highlighted)": ["rel", "2", "1"],
    "b:remote:origin/release/2.1": ["rel", "2", "1"],
  });
  // An action's label is marked too.
  await query("fe");
  assert.deepEqual(await page.eval(`Array.prototype.map.call(document.querySelectorAll('.bm-action[data-bmkey="a:fetch"] .bm-hl'), function (m) { return m.textContent; })`), ["Fe"]);
});

test("a query no ref matches offers a new branch by that name, and a revision to check out", { skip }, async () => {
  await openMenu();
  await query("Fix/Login-Page");
  const rows = await page.eval<{ key: string; label: string }[]>(`Array.prototype.map.call(document.querySelectorAll(".bm-list [data-bmkey]"), function (r) {
    return { key: r.dataset.bmkey, label: r.textContent.trim() };
  })`);
  assert.deepEqual(rows, [
    { key: "a:newNamed", label: "New Branch 'Fix/Login-Page'…" },
    { key: "a:checkoutNamed", label: "Checkout Revision 'Fix/Login-Page'…" },
  ], "the query as typed, its case kept");
  assert.equal(await page.eval(`document.querySelector(".bm-list .bm-none").textContent`), "No branch or tag matches 'Fix/Login-Page'");
  assert.equal((await highlighted()).key, "a:newNamed");
  // Enter: the New Branch dialog, its name filled in.
  await page.key("Enter");
  await page.page.waitFor(`!!document.querySelector(".rp-panel input")`);
  assert.equal(await page.eval(`document.querySelector(".rp-panel input").value`), "Fix/Login-Page");
  assert.ok(!(await page.eval<boolean>(`!!document.querySelector(".branch-menu")`)), "the menu gave way to the dialog");
  await page.key("Enter");
  assert.deepEqual((await page.posted()).filter((m) => m.type === "branchAction"), [
    { type: "branchAction", action: "new", ref: "Fix/Login-Page" },
  ]);

  // The revision: its own dialog, filled in.
  await openMenu();
  await query("a1b2c3d4");
  await page.key("ArrowDown");
  assert.equal((await highlighted()).key, "a:checkoutNamed");
  await page.key("Enter");
  await page.page.waitFor(`!!document.querySelector(".rp-panel input")`);
  assert.equal(await page.eval(`document.querySelector(".rp-panel input").value`), "a1b2c3d4");
  await page.key("Enter");
  assert.deepEqual((await page.posted()).filter((m) => m.type === "branchAction"), [
    { type: "branchAction", action: "checkoutRef", ref: "a1b2c3d4" },
  ]);

  // Something git would read as one of its options never reaches it.
  await openMenu();
  await query("-x9");
  const offered = await page.eval<string[]>(`Array.prototype.map.call(document.querySelectorAll(".bm-list [data-bmkey]"), function (r) { return r.dataset.bmkey; })`);
  assert.ok(offered.includes("a:checkoutNamed"), offered.join(" | "));
  await page.eval(`document.querySelector('.bm-list [data-bmkey="a:checkoutNamed"]').click()`);
  await page.page.waitFor(`!!document.querySelector(".rp-panel input")`);
  const refused = await page.eval<{ err: string; ok: boolean }>(`({
    err: document.querySelector(".rp-panel .rp-err").textContent,
    ok: !document.querySelector(".rp-panel .rp-foot button:last-child").disabled,
  })`);
  assert.equal(refused.err, "A revision can't start with '-'.");
  assert.equal(refused.ok, false, "and Checkout cannot be pressed");
  await page.key("Enter");
  assert.deepEqual((await page.posted()).filter((m) => m.type === "branchAction"), [], "Enter does not send it either");
  await page.key("Escape");
});

// Checkout Tag or Revision…: a branch, a remote branch and a tag can share a
// short name — git names such twins heads/v1 and tags/v1 when it lists
// them, but a list drawn before the tag was made still says v1 — and
// `git checkout --detach v1` takes the branch whichever was picked. A ref
// picked from the list goes with its kind (the host checks out that ref by
// its full name); what was typed goes as typed.
test("Checkout Tag or Revision…: a ref picked from the list goes with its kind, what was typed as typed", { skip }, async () => {
  const twins = stateMessage({ local: [{ name: "main", current: true }, { name: "v1" }], remote: ["origin/v1"], tags: ["v1"] });
  const dialog = async (typed: string): Promise<void> => {
    await openMenu(twins);
    await page.eval(`document.querySelector('.bm-list [data-bmkey="a:checkoutRef"]').click()`);
    await page.page.waitFor(`!!document.querySelector(".rp-panel input")`);
    await page.type(typed);
  };
  const rows = (): Promise<string[]> => page.eval<string[]>(`Array.prototype.map.call(document.querySelectorAll(".rp-panel .rp-row"), function (r) {
    return r.querySelector(".rp-name").textContent + " " + r.querySelector(".rp-kind").textContent;
  })`);
  const sent = async (): Promise<Record<string, unknown>[]> => (await page.posted()).filter((m) => m.type === "branchAction");

  // Picked by the pointer: the tag.
  await dialog("v1");
  assert.deepEqual(await rows(), ["v1 branch", "origin/v1 remote", "v1 tag"]);
  const tag = await page.eval<{ x: number; y: number }>(`(function () {
    var r = Array.prototype.find.call(document.querySelectorAll(".rp-panel .rp-row"), function (n) { return n.querySelector(".rp-kind").textContent === "tag"; }).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await page.click(tag.x, tag.y);
  assert.deepEqual(await sent(), [{ type: "branchAction", action: "checkoutRef", ref: "v1", refType: "tag" }]);

  // Picked by the keys: the branch, then the remote branch.
  await dialog("v1");
  await page.key("ArrowDown");
  await page.key("Enter");
  assert.deepEqual(await sent(), [{ type: "branchAction", action: "checkoutRef", ref: "v1", refType: "head" }]);
  await dialog("v1");
  await page.key("ArrowDown");
  await page.key("ArrowDown");
  await page.key("Enter");
  assert.deepEqual(await sent(), [{ type: "branchAction", action: "checkoutRef", ref: "origin/v1", refType: "remote" }]);

  // Typed: as typed, with no kind — a revision git reads for itself, even
  // when it is also a listed name.
  for (const typed of ["v1~1", "v1"]) {
    await dialog(typed);
    await page.key("Enter");
    assert.deepEqual(await sent(), [{ type: "branchAction", action: "checkoutRef", ref: typed }], `typed '${typed}'`);
  }
  // A pick undone by typing: typed again.
  await dialog("v1");
  await page.key("ArrowDown");
  await page.key("ArrowUp");
  await page.key("Enter");
  assert.deepEqual(await sent(), [{ type: "branchAction", action: "checkoutRef", ref: "v1" }], "the highlight taken back off the list");
});

test("the highlight follows the best match through a repaint — until the arrows or the pointer move it", { skip }, async () => {
  // Typed while the branches were still loading: they arrive, and the
  // highlight goes to the branch Enter should now run.
  const first = stateMessage({ local: LOCAL });
  delete first.branches;
  await openMenu(first);
  await query("rel21");
  assert.equal((await highlighted()).key, null, "nothing to run while loading");
  await page.send(STATE);
  assert.equal((await highlighted()).key, "b:local:release/2.1", "the branch that arrived");

  // Moved by the arrows: a repaint leaves it there.
  await query("fe");
  assert.equal((await highlighted()).key, "b:local:feature");
  await page.key("ArrowUp");
  assert.equal((await highlighted()).key, "a:fetch");
  await page.send(stateMessage({ local: LOCAL.map((b) => (b.name === "feature" ? { ...b, ahead: 3 } : b)), remote: REMOTE, tags: ["v2.1.0", "v2.0.0"] }));
  assert.equal((await highlighted()).key, "a:fetch", "the arrows put it there; the repaint keeps it");

  // A new query is a fresh start.
  await query("topic");
  assert.equal((await highlighted()).key, "b:local:topic");
});

// A branch and a tag may share a short name. The actions a repaint re-opens
// belong to the ref they were opened on — found by kind and name, never by
// the name alone, which is the branch's row first.
test("a repaint re-opens a ref's actions on its own row when a branch and a tag share its name", { skip }, async () => {
  const twins = stateMessage({ local: [...LOCAL, { name: "v1" }], remote: REMOTE, tags: ["v1"] });
  await openMenu(twins);
  await query("v1");
  for (let i = 0; i < 10 && (await highlighted()).key !== "b:tag:v1"; i++) await page.key("ArrowDown");
  assert.equal((await highlighted()).key, "b:tag:v1");
  await page.key("ArrowRight");
  assert.equal(await page.eval(`document.querySelector(".branch-submenu .bm-subaction").textContent.trim()`), "Checkout Tag (detached)");
  await page.send(stateMessage({ local: [...LOCAL.map((b) => (b.name === "feature" ? { ...b, ahead: 9 } : b)), { name: "v1" }], remote: REMOTE, tags: ["v1"] }));
  assert.equal(await page.eval(`document.querySelector(".branch-submenu .bm-subaction").textContent.trim()`), "Checkout Tag (detached)", "still the tag's actions");
  await page.key("ArrowLeft");
  assert.equal((await highlighted()).key, "b:tag:v1", "and Left goes back to the tag, not the branch of the same name");
});

test("typing leaves an open submenu for good: a host repaint does not bring it back", { skip }, async () => {
  await openMenu();
  await query("featur");
  await page.key("ArrowRight");
  assert.ok(await page.eval(`!!document.querySelector(".branch-submenu")`));
  // A letter that keeps the branch in the list.
  await page.type("e");
  assert.ok(await page.eval(`!!document.querySelector('.bm-list .bm-branch[data-bname="feature"]')`), "feature still listed");
  assert.ok(!(await page.eval(`!!document.querySelector(".branch-submenu")`)), "typing closed it");
  await page.send(stateMessage({ local: LOCAL.map((b) => (b.name === "feature" ? { ...b, ahead: 4 } : b)), remote: REMOTE }));
  assert.ok(!(await page.eval(`!!document.querySelector(".branch-submenu")`)), "and a repaint did not reopen it");
});

test("on a detached HEAD, Pull and Push are not offered, and one line says why", { skip }, async () => {
  const detached = {
    ...stateMessage({ local: LOCAL.map((b) => ({ ...b, current: false })), remote: REMOTE }),
    branch: "a1b2c3d",
    detached: true,
    upstream: undefined,
  };
  const look = (): Promise<{ actions: string[]; why: string | null; describedBy: string | null }> =>
    page.eval(`(function () {
      var w = document.querySelector(".bm-list .bm-why");
      return {
        actions: Array.prototype.map.call(document.querySelectorAll(".bm-list .bm-action"), function (b) { return b.dataset.bmkey; }),
        why: w ? w.textContent.trim() : null,
        describedBy: document.querySelector(".bm-search input").getAttribute("aria-describedby"),
      };
    })()`);
  await openMenu(detached);
  let l = await look();
  assert.deepEqual(l.actions, ["a:fetch", "a:new", "a:checkoutRef"]);
  assert.equal(l.why, "Detached at a1b2c3d — check out a branch to pull or push");
  assert.equal(l.describedBy, "bm-why", "read out with the search box");
  // Where Pull was: right under Fetch.
  assert.equal(await page.eval(`document.querySelector(".bm-list .bm-why").previousElementSibling.dataset.bmkey`), "a:fetch");
  assert.equal(await page.eval(`document.querySelector(".bm-list .bm-why").hasAttribute("data-bmkey")`), false, "not a row the arrows visit");

  // Looking for one of them: its name or "update" by a start, or a word's.
  for (const q of ["p", "pu", "pull", "push", "u", "update"]) {
    await query(q);
    l = await look();
    assert.ok(!l.actions.includes("a:pull") && !l.actions.includes("a:push"), `${q}: ${l.actions.join(" | ")}`);
    assert.ok(l.why, `${q}: the query looks for one of them, so the line says why it is not here`);
    assert.equal(l.describedBy, "bm-why", `${q}: read out with the box`);
  }
  // Not: a letter somewhere inside "Pull", "Push" or "update" — 't' is
  // looking for topic.
  for (const q of ["t", "d", "e", "a", "s", "h", "l", "ul", "feature"]) {
    await query(q);
    l = await look();
    assert.equal(l.why, null, `'${q}' is not looking for Pull or Push`);
    assert.equal(l.describedBy, null, `'${q}': nothing read out with the box`);
  }

  // Back on a branch (checked out from elsewhere, with the menu open): both return.
  await query("");
  await page.send(STATE);
  l = await look();
  assert.deepEqual(l.actions, ["a:fetch", "a:pull", "a:push", "a:new", "a:checkoutRef"]);
  assert.equal(l.why, null);
});

// The branch HEAD is on tracks nothing, or tracks a branch deleted from its
// remote: a pull could only fail, and its own actions offer none. The top
// Pull follows the same rule — gone, and said why when looked for.
test("with no upstream, or a gone one, the branch you're on offers no Pull — at the top as in its own actions", { skip }, async () => {
  const on = (b: LocalBranch): Record<string, unknown> =>
    stateMessage({ local: [b, ...LOCAL.filter((x) => x.name !== "main")], remote: REMOTE });
  const look = (): Promise<{ actions: string[]; why: string | null; describedBy: string | null }> =>
    page.eval(`(function () {
      var w = document.querySelector(".bm-list .bm-why");
      return {
        actions: Array.prototype.map.call(document.querySelectorAll(".bm-list .bm-action"), function (b) { return b.dataset.bmkey; }),
        why: w ? w.textContent.trim() : null,
        describedBy: document.querySelector(".bm-search input").getAttribute("aria-describedby"),
      };
    })()`);
  /** Whether the branch's own actions offer a pull. */
  const ownPull = async (): Promise<boolean> => {
    await query("main");
    await page.key("ArrowRight");
    const labels = await page.eval<string[]>(`Array.prototype.map.call(document.querySelectorAll(".branch-submenu .bm-subaction"), function (b) { return b.textContent.trim(); })`);
    await page.key("ArrowLeft");
    return labels.some((x) => /^Pull/.test(x));
  };
  const cells: [string, LocalBranch, string | null][] = [
    ["tracks origin/main", { name: "main", current: true, upstream: "origin/main", upstreamOnRemote: true }, null],
    ["tracks nothing", { name: "main", current: true }, "'main' has no upstream to pull from"],
    ["tracks a gone branch", { name: "main", current: true, upstream: "origin/main", gone: true }, "'main' tracks origin/main, which no longer exists on the remote"],
  ];
  for (const [what, b, line] of cells) {
    await openMenu(on(b));
    let l = await look();
    const pull = line === null;
    assert.equal(l.actions.includes("a:pull"), pull, `${what}: Pull at the top ${pull ? "offered" : "not offered"}: ${l.actions.join(" | ")}`);
    assert.ok(l.actions.includes("a:push"), `${what}: Push still offered (it publishes)`);
    assert.equal(l.why, null, `${what}: no line with the box empty`);
    assert.equal(await ownPull(), pull, `${what}: its own actions agree`);
    for (const q of ["pull", "pu", "update"]) {
      await query(q);
      l = await look();
      assert.equal(l.why, line, `${what}, '${q}': ${line ? "the line says why" : "no line"}`);
      assert.equal(l.describedBy, line ? "bm-why" : null);
    }
    await query("t");
    assert.equal((await look()).why, null, `${what}, 't': not looking for Pull`);
  }
});

test("Pull is called Pull", { skip }, async () => {
  await openMenu();
  const labels = await page.eval<string[]>(`Array.prototype.map.call(document.querySelectorAll(".bm-list .bm-action"), function (b) { return b.textContent.trim(); })`);
  assert.deepEqual(labels, ["Fetch", "Pull", "Push…", "New Branch…", "Checkout Tag or Revision…"]);
});
