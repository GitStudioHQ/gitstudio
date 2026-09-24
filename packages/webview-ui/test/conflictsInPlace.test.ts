import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { findChrome, runInChrome } from "./headless";

/**
 * Resolving a file changes ONE row (the owner, 24 Sep 2026: "the conflicts
 * resolving the whole screen flashes when you resolve a file with say accept
 * left").
 *
 * The dashboard answered every state with a new page: one Accept Yours is
 * three states (the row busy, the host busy, the file resolved), and each
 * threw away every row, button, the progress bar and the footer — and while
 * the host was busy every button on the page went grey. Now each state is
 * patched onto the page in place (src/conflicts/patch.ts), rows by their path
 * and buttons by their key.
 *
 * A MutationObserver watches the dashboard through every way a file gets
 * resolved — Accept Yours / Accept Theirs as each host sends its states (the
 * extension marks the row busy; the desktop locks the whole dashboard), Delete
 * the file, Hold to undo, and a file resolved from a terminal — and fails if
 * the page's sections are replaced, if any row is a new node, or if any row
 * but the one resolved is touched beyond the lock (aria-disabled). Focus and
 * the list's scroll position must survive, and a host that MOVES the
 * dashboard (the desktop rebuilds its Changes view around it) must get both
 * back. Run against the old render (replaceChildren), every check here fails.
 */
const ENTRY = fileURLToPath(new URL("./fixtures/dashboardEntry.ts", import.meta.url));
const CHROME = findChrome();
const STYLES = ["tokens.css", "conflicts.css"]
  .map((f) => readFileSync(fileURLToPath(new URL(`../src/styles/${f}`, import.meta.url)), "utf8"))
  .join("\n")
  .replace(/@import[^;]+;/g, "");

const PROLOGUE = `
  const { ConflictsDashboard, FakeClock, HOLD_TO_UNDO_MS } = window.__dash;
  const posted = [];
  const clock = new FakeClock();
  const side = (role, stage, name, description) => ({ role, stage, name, paneTitle: name, description: description || name });
  const OP = {
    kind: "rebase", backend: "merge", title: "Rebasing test onto master · commit 1 of 1: 9af54ee test: rework the sample",
    direction: { from: "yours", verb: "onto", to: "theirs" }, step: { n: 1, m: 1, unit: "commit" },
    commit: { sha: "9af54ee0d1c2b3a4958677a8b9c0d1e2f3a4b5c6", subject: "test: rework the sample", author: "Playground" },
    yours: side("yours", 3, "test"), theirs: side("theirs", 2, "master"),
    verbs: { continue: "Continue Rebase", abort: "Abort Rebase" }, canContinue: false, canSkip: false, episode: "rebase:9af54ee",
  };
  const row = (path, over) => ({ path, status: "pending", shape: "text", ...over });
  // The owner's quick-rebase: nine files, every kind of row.
  let FILES = [
    row("README.md", { status: "resolved", choice: "yours" }),
    row("app/calculator.py"),
    row("app/greeting.py", { shape: "modify-delete", missingRole: "yours", badge: "deleted in yours (test)" }),
    row("assets/logo.bin", { shape: "binary" }),
    row("cases/same-both.txt"),
    row("cases/whitespace.txt", { status: "resolved", choice: "theirs" }),
    row("f.txt", { status: "resolved", choice: "merged" }),
    row("stress/config.json"),
    row("stress/userService.js"),
  ];
  const S = (files, over) => ({
    brand: { name: "GitStudio", mark: "gitstudio" }, repoName: "quick-rebase", op: OP, files,
    total: files.length, resolved: files.filter((f) => f.status === "resolved").length,
    busy: false, holdToUndoMs: HOLD_TO_UNDO_MS, ...over,
  });
  const set = (path, over) => (FILES = FILES.map((f) => (f.path === path ? { ...f, ...over } : f)));
  const busyRow = (path) => FILES.map((f) => (f.path === path ? { ...f, status: "busy" } : f));
  const root = document.getElementById("root");
  root.classList.add("cd-host-fill");
  const d = new ConflictsDashboard(root, { post: (a) => posted.push(a), timers: clock });
  d.render(S(FILES));
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const dash = $(".cd-dash");
  const list = () => $(".cd-list");
  const rowEl = (p) => $$(".cd-row").find((r) => r.dataset.path === p);
  const key = (k) => $('[data-key="' + k + '"]');

  /** What must not change identity: the page's sections and every row. */
  const snap = () => ({ kids: [...dash.children], rows: new Map($$(".cd-row").map((r) => [r.dataset.path, r])) });
  let before, mo, recs;
  /** Start watching; \`changed\` is the one row allowed to change. */
  const begin = () => {
    before = snap();
    recs = [];
    mo = new MutationObserver((l) => recs.push(...l));
    mo.observe(dash, { subtree: true, childList: true, attributes: true, characterData: true });
  };
  /** Stop watching and judge what was written. */
  const judge = (step, changed) => {
    recs.push(...mo.takeRecords());
    mo.disconnect();
    const after = snap();
    expect(after.kids.length === before.kids.length && after.kids.every((k, i) => k === before.kids[i]),
      step + ": the page's sections are the same nodes (" + before.kids.map((k) => k.className).join(" | ") + " -> " + after.kids.map((k) => k.className).join(" | ") + ")");
    for (const [p, r] of before.rows) expect(after.rows.get(p) === r, step + ": " + p + "'s row is the same node");
    const touched = new Set();
    for (const rec of recs) {
      const t = rec.target.nodeType === 1 ? rec.target : rec.target.parentElement;
      if (rec.type === "childList" && (rec.target === dash || rec.target === list())) {
        expect(false, step + ": " + (rec.target === dash ? "a section of the page" : "a row") + " was added or removed");
      }
      const r = t && t.closest(".cd-row");
      if (r && r.dataset.path !== changed) {
        // Another row may only be LOCKED and unlocked (aria-disabled, and its
        // quiet marker data-lock) while the host works.
        if (!(rec.type === "attributes" && (rec.attributeName === "aria-disabled" || rec.attributeName === "data-lock"))) {
          touched.add(r.dataset.path + " (" + rec.type + (rec.attributeName ? " " + rec.attributeName : "") + ")");
        }
      }
    }
    expect(touched.size === 0, step + ": rows it did not resolve were written to: " + [...touched].join(", "));
    notes[step] = recs.length + " mutations";
  };
  const locked = (b) => !!b && (b.disabled || b.getAttribute("aria-disabled") === "true");
`;

const run = (script: string) =>
  runInChrome(CHROME!, ENTRY, PROLOGUE + script, {
    // A short page, so the list scrolls (its position must survive).
    css: `${STYLES}\n#root{height:560px;width:960px;overflow:hidden}`,
    width: 1000,
    height: 600,
  });

const skip = !CHROME && "no Chrome on this machine";

test("Accept Yours, as the extension sends it: one row changes, nothing is rebuilt, the keyboard lands on its Hold to undo", { skip }, async () => {
  const v = await run(`
    list().scrollTop = 60;
    const y0 = list().scrollTop;
    expect(y0 > 0, "precondition: the list scrolls (" + list().scrollHeight + " in " + list().clientHeight + ")");
    const P = "app/calculator.py";
    const accept = key("accept:yours:" + P);
    const other = key("merge:stress/config.json");
    accept.focus();

    begin();
    accept.click();                                           // the dashboard marks the row busy
    expect(JSON.stringify(posted[posted.length - 1]) === JSON.stringify({ type: "accept", path: P, role: "yours" }), "it posts the accept");
    expect(rowEl(P).querySelector(".cd-spinner") && rowEl(P).getAttribute("aria-busy") === "true", "the row says it is working");
    expect(key("accept:yours:" + P) === accept && locked(accept), "its buttons stay, locked");
    expect(document.activeElement === accept, "and the keyboard stays on the button that was pressed");
    judge("pressed", P);

    begin();
    d.render(S(busyRow(P), { busy: true }));                    // the host: busy, the row busy
    expect(locked(other) && other === key("merge:stress/config.json"), "the host's lock reaches every row, on the same nodes");
    expect(document.activeElement === accept, "the lock does not take the keyboard");
    judge("host busy", P);

    begin();
    set(P, { status: "resolved", choice: "yours" });
    d.render(S(FILES));                                        // the host: done
    expect(rowEl(P).classList.contains("is-resolved") && /kept yours/.test(rowEl(P).querySelector(".cd-choice").textContent), "the row is resolved");
    expect(!locked(other), "every other row is live again");
    expect($(".cd-progress-label").textContent === "4 of 9 resolved", "the progress says so (" + $(".cd-progress-label").textContent + ")");
    expect($(".cd-bar-fill").style.width === "44%", "and its bar grows (" + $(".cd-bar-fill").style.width + ")");
    expect(document.activeElement === key("restore:" + P), "the keyboard is on the row's Hold to undo (" + (document.activeElement && document.activeElement.dataset.key) + ")");
    expect(list().scrollTop === y0, "the list kept its place (" + list().scrollTop + " vs " + y0 + ")");
    judge("resolved", P);

    begin();
    d.render(S(FILES));                                        // a watcher re-sends the same state
    expect(recs.length === 0, "an identical state writes nothing (" + recs.length + ")");
    judge("re-sent", "(none)");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("Accept Theirs, as the desktop sends it (the whole dashboard busy, then the row resolved while still busy)", { skip }, async () => {
  const v = await run(`
    const P = "stress/config.json";
    const theirs = key("accept:theirs:" + P);
    const other = key("accept:yours:app/calculator.py");
    other.focus();                                              // the keyboard is on ANOTHER row
    begin();
    theirs.click();
    d.render(S(FILES, { busy: true }));                          // the desktop: busy, no row marked
    expect(rowEl(P).querySelector(".cd-spinner"), "the pressed row stays busy while the desktop works");
    set(P, { status: "resolved", choice: "theirs" });
    d.render(S(FILES, { busy: true }));                          // resolved, the read-back still locked
    expect(rowEl(P).classList.contains("is-resolved") && !rowEl(P).querySelector(".cd-spinner"), "resolved as soon as it is");
    d.render(S(FILES));                                         // unlocked
    expect(document.activeElement === other, "the keyboard never left the row it was on");
    expect(!locked(other), "which is live again");
    judge("desktop accept", P);
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("Delete the file, Hold to undo and a file resolved from a terminal each change their own row only", { skip }, async () => {
  const v = await run(`
    // Delete the file (the side that deleted it is yours).
    let P = "app/greeting.py";
    begin();
    key("accept:yours:" + P).click();
    expect(posted[posted.length - 1].type === "accept" && posted[posted.length - 1].role === "yours", "Delete the file accepts the deleting side");
    d.render(S(busyRow(P), { busy: true }));
    set(P, { status: "resolved", choice: "yours" });
    d.render(S(FILES));
    expect(/deleted/.test(rowEl(P).querySelector(".cd-choice").textContent), "the row says the file was deleted (" + rowEl(P).querySelector(".cd-choice").textContent + ")");
    judge("delete", P);

    // Hold to undo.
    P = "README.md";
    begin();
    const hold = key("restore:" + P);
    hold.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    clock.advance(HOLD_TO_UNDO_MS);
    expect(posted[posted.length - 1].type === "restore", "a full hold restores");
    expect(key("restore:" + P) === hold && rowEl(P).querySelector(".cd-spinner"), "the row waits, busy, with its Hold to undo in place");
    d.render(S(busyRow(P), { busy: true }));
    set(P, { status: "pending", choice: undefined });
    d.render(S(FILES));
    expect(key("accept:yours:" + P) && !key("restore:" + P), "the conflict is back");
    judge("hold to undo", P);

    // Resolved from a terminal: no press, one state.
    P = "cases/same-both.txt";
    begin();
    set(P, { status: "resolved", choice: "merged" });
    d.render(S(FILES));
    expect(rowEl(P).classList.contains("is-resolved"), "the row is resolved");
    judge("terminal", P);
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("nothing on another row MOVES either: resolving the row with the widest pill keeps the pill column's width", { skip }, async () => {
  // The frame capture found what a MutationObserver cannot: nothing was
  // written to the other rows, but "deleted in yours (test)" becoming
  // "✓ deleted" narrowed the pill column, and the next row's "binary" jumped
  // 61px to the right. Measured at the wide, the narrow and the compact width,
  // there and back (Hold to undo).
  const v = await run(`
    const geometry = (skip) => $$(".cd-row").filter((r) => r.dataset.path !== skip)
      .flatMap((r) => [...r.querySelectorAll(".cd-badge, .cd-choice, button, .cd-name")]
        .map((e) => { const b = e.getBoundingClientRect(); return r.dataset.path + " " + (e.dataset.key || e.className) + " " + Math.round(b.left * 2) / 2 + "," + Math.round(b.width * 2) / 2; }));
    const P = "app/greeting.py";
    // Every other row pending, as the desktop's capture had it: the widest
    // pill on screen is the one about to go.
    for (const p of ["README.md", "cases/whitespace.txt", "f.txt"]) set(p, { status: "pending", choice: undefined });
    for (const w of [960, 640, 343]) {
      root.style.width = w + "px";
      set(P, { status: "pending", choice: undefined });
      d.render(S(FILES));
      const before = geometry(P);
      set(P, { status: "resolved", choice: "yours" });
      d.render(S(FILES));
      expect(/deleted/.test(rowEl(P).querySelector(".cd-choice").textContent), w + "px: resolved (" + rowEl(P).querySelector(".cd-choice").textContent + ")");
      const after = geometry(P);
      const moved = before.filter((g, i) => g !== after[i]);
      expect(moved.length === 0, w + "px: resolving it moved " + moved.length + " things on other rows: " + moved.slice(0, 3).join(" | ") + " -> " + after.filter((g, i) => g !== before[i]).slice(0, 3).join(" | "));
      set(P, { status: "pending", choice: undefined });
      d.render(S(FILES));
      const back = geometry(P);
      expect(back.every((g, i) => g === before[i]), w + "px: and undoing it moves nothing back");
    }
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("a hold in progress survives another file being resolved; the host locking it still ends it", { skip }, async () => {
  const v = await run(`
    const hold = key("restore:cases/whitespace.txt");
    hold.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    clock.advance(400);
    set("stress/userService.js", { status: "resolved", choice: "theirs" });
    d.render(S(FILES));                                          // resolved elsewhere, mid-hold
    expect(hold.classList.contains("arming"), "the sweep carries on");
    clock.advance(350);
    expect(posted.some((a) => a.type === "restore" && a.path === "cases/whitespace.txt"), "and the hold completes");

    const h2 = key("restore:f.txt");
    h2.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    clock.advance(400);
    d.render(S(FILES, { busy: true }));                          // the host starts other work
    clock.advance(1000);
    expect(!posted.some((a) => a.type === "restore" && a.path === "f.txt"), "a lock ends a hold");
    expect(clock.armed() === 0, "and leaves no timer armed");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("a host that MOVES the dashboard (the desktop's Changes rebuild) gives back its scroll and its keyboard", { skip }, async () => {
  const v = await run(`
    list().scrollTop = 60;
    const y0 = list().scrollTop;
    await new Promise((r) => setTimeout(r, 50));             // the scroll is noted (its event)
    const b = key("merge:stress/config.json");
    b.focus();
    // What the desktop does after a file action: a new view, the old pane moved into it.
    const again = document.createElement("div");
    again.className = "cd-host-fill";
    again.style.height = "560px";
    document.body.appendChild(again);
    again.appendChild(dash);
    expect(list().scrollTop === y0, "the list is where it was (" + list().scrollTop + " vs " + y0 + ")");
    expect(document.activeElement === b, "the keyboard is where it was (" + (document.activeElement && document.activeElement.tagName) + ")");
    // A click elsewhere on the page is not taken back.
    b.blur();
    await Promise.resolve();
    root.appendChild(dash);
    expect(document.activeElement === document.body, "a keyboard the reader moved away stays away");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("while one file is resolved no other row changes its look; a longer lock greys after a moment; a disabled control is grey at once", { skip }, async () => {
  const v = await run(`
    const m = key("merge:stress/config.json");
    const cs = () => getComputedStyle(m);
    const look = () => [cs().backgroundColor, cs().color, cs().borderTopColor].join(" ");
    const live = look();
    // One file's work (the host marks its row busy): the rest keep their look however long it takes.
    d.render(S(busyRow("app/calculator.py"), { busy: true }));
    expect(m.getAttribute("aria-disabled") === "true" && m.dataset.lock === "quiet", "locked, quietly (" + m.getAttribute("aria-disabled") + " " + m.dataset.lock + ")");
    expect(look() === live, "and its look is the live one (" + look() + " vs " + live + ")");
    // Work that is not one file's (a Continue): the lock greys, after a wait.
    d.render(S(FILES, { busy: true }));
    expect(m.getAttribute("aria-disabled") === "true" && !m.disabled && !m.dataset.lock, "a lock is aria-disabled, never disabled (it would take the keyboard)");
    expect(cs().cursor === "progress", "the pointer says the host is working");
    const delays = cs().transitionDelay.split(",").map((s) => parseFloat(s));
    expect(delays.length > 0 && delays.every((x) => x >= 0.5), "its grey look waits (" + cs().transitionDelay + ")");
    d.render(S(FILES));
    expect(!m.hasAttribute("aria-disabled") && cs().transitionDelay.split(",").every((s) => parseFloat(s) === 0), "unlocked, it comes back at once (" + cs().transitionDelay + ")");
    const c = $$(".cd-foot button").find((b) => /Continue/.test(b.textContent));
    expect(c.disabled && getComputedStyle(c).transitionDelay.split(",").every((s) => parseFloat(s) === 0), "Continue that git refuses is disabled, grey at once");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});
