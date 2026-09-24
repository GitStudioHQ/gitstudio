import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { findChrome, runInChrome } from "./headless";
import { JUDGE } from "./conflictsJudge";

/**
 * Resolving a file changes ONE row.
 *
 * The owner, 24 Sep 2026, twice. First: "the conflicts resolving the whole
 * screen flashes when you resolve a file with say accept left" — the page was
 * rebuilt for every state (replaceChildren). Then, on the in-place build:
 * "clicking accept left on the first row flashes and refreshes all other rows,
 * and buttons like merge disappear and reappear again … it looks like a server
 * side website". Nothing was rebuilt any more, but a press still wrote to every
 * row: the host locked the whole page for one file (`busy`), so every button
 * on it was locked and unlocked (aria-disabled + a "quiet" marker) around each
 * press, and a state read while git was still at it could paint the pressed
 * row as it was.
 *
 * The rule these checks hold, with a MutationObserver over the whole page: a
 * press on a row writes to THAT row (its working state, then its result), the
 * progress bar and the footer's count — and to nothing else. Not one
 * attribute, class or text node of any other row; no section replaced; no
 * button anywhere disabled, locked or re-enabled; an identical state writes
 * nothing at all. Only an operation verb (Continue / Skip / Abort) locks the
 * page, with one class on the dashboard.
 *
 * conflictsReplay.test.ts replays the messages real VS Code sent (recorded
 * over CDP by scripts/merge-e2e/dashboardClicks.ts) through the same judge.
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
  const busyRows = (...paths) => FILES.map((f) => (paths.includes(f.path) ? { ...f, status: "busy" } : f));
  const root = document.getElementById("root");
  root.classList.add("cd-host-fill");
  const d = new ConflictsDashboard(root, { post: (a) => posted.push(a), timers: clock });
  d.render(S(FILES, { done: 0 }));
  const lastPost = () => posted[posted.length - 1];
  ${JUDGE}
`;

const run = (script: string) =>
  runInChrome(CHROME!, ENTRY, PROLOGUE + script, {
    // A short page, so the list scrolls (its position must survive).
    css: `${STYLES}\n#root{height:560px;width:960px;overflow:hidden}`,
    width: 1000,
    height: 600,
  });

const skip = !CHROME && "no Chrome on this machine";

test("Accept Yours: the row works, then resolves — and not one other node on the page is written", { skip }, async () => {
  const v = await run(`
    list().scrollTop = 60;
    const y0 = list().scrollTop;
    expect(y0 > 0, "precondition: the list scrolls (" + list().scrollHeight + " in " + list().clientHeight + ")");
    // The scroll is noted (its event: the fades). Headless Chrome serves no
    // frame to an idle page, so the event is sent by hand, not waited for.
    list().dispatchEvent(new Event("scroll"));
    const P = "app/calculator.py";
    const accept = key("accept:yours:" + P);
    const other = key("merge:stress/config.json");
    const look0 = looks([P]);
    accept.focus();

    begin();
    accept.click();                                                   // the press
    const seq = lastPost().seq;
    expect(lastPost().type === "accept" && lastPost().path === P && lastPost().role === "yours" && typeof seq === "number", "it posts the accept, numbered (" + JSON.stringify(lastPost()) + ")");
    expect(rowEl(P).querySelector(".cd-spinner") && rowEl(P).getAttribute("aria-busy") === "true", "the row says it is working");
    expect(key("accept:yours:" + P) === accept && locked(accept), "its own buttons stay, waiting");
    expect(!locked(other), "another row's buttons are not locked");
    expect(!dashEl().classList.contains("is-busy") && !dashEl().hasAttribute("aria-busy"), "the page is not locked");
    expect(document.activeElement === accept, "the keyboard stays on the button that was pressed");
    judge("pressed", P);

    begin();
    d.render(S(FILES, { done: 0 }));                                   // a watcher's state, sent before the host had the press
    expect(rowEl(P).querySelector(".cd-spinner"), "a state from before the press does not end its working state");
    judge("stale state", P);

    begin();
    d.render(S(busyRows(P), { done: 0 }));                              // the host: this row busy — and only it
    judge("host has it", P);

    begin();
    set(P, { status: "resolved", choice: "yours" });
    d.render(S(FILES, { done: seq - 1 }));                             // read while git was still at it
    expect(rowEl(P).querySelector(".cd-spinner") && !rowEl(P).classList.contains("is-resolved"), "a read that overlapped the press does not paint it yet");
    expect($(".cd-progress-label").textContent === "3 of 9 resolved", "nor count it (" + $(".cd-progress-label").textContent + ")");
    judge("overlapping read", P);

    begin();
    d.render(S(FILES, { done: seq }));                                 // the host: done
    expect(rowEl(P).classList.contains("is-resolved") && /kept yours/.test(rowEl(P).querySelector(".cd-choice").textContent), "the row is resolved");
    expect($(".cd-progress-label").textContent === "4 of 9 resolved", "the progress says so (" + $(".cd-progress-label").textContent + ")");
    expect($(".cd-bar-fill").style.width === "44%", "and its bar grows (" + $(".cd-bar-fill").style.width + ")");
    expect(document.activeElement === key("restore:" + P), "the keyboard is on the row's Hold to undo (" + (document.activeElement && document.activeElement.dataset.key) + ")");
    expect(list().scrollTop === y0, "the list kept its place (" + list().scrollTop + " vs " + y0 + ")");
    judge("resolved", P);
    const look1 = looks([P]);
    expect(look1.every((l, i) => l === look0[i]), "no other row looks any different: " + look1.filter((l, i) => l !== look0[i]).slice(0, 2).join(" | "));

    begin();
    d.render(S(FILES, { done: seq }));                                 // a watcher re-sends the same state
    d.render(JSON.parse(JSON.stringify(S(FILES, { done: seq }))));
    expect(recs.length + mo.takeRecords().length === 0, "an identical state writes nothing");
    judge("re-sent", []);
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("a press on a second row while git is at the first waits its turn, and a third row is never written", { skip }, async () => {
  const v = await run(`
    const A = "app/calculator.py", B = "stress/config.json";
    begin();
    key("accept:yours:" + A).click();
    const sa = lastPost().seq;
    d.render(S(busyRows(A), { done: 0 }));
    key("accept:theirs:" + B).click();                                // not refused: queued by the host
    const sb = lastPost().seq;
    expect(sb > sa && lastPost().type === "accept" && lastPost().path === B, "the second press is posted too, numbered after the first");
    expect(rowEl(B).querySelector(".cd-spinner"), "and shows its own working state");
    d.render(S(busyRows(A, B), { done: 0 }));
    set(A, { status: "resolved", choice: "yours" });
    d.render(S(busyRows(B), { done: sa }));
    expect(rowEl(A).classList.contains("is-resolved") && rowEl(B).querySelector(".cd-spinner"), "the first resolves while the second still works");
    set(B, { status: "resolved", choice: "theirs" });
    d.render(S(FILES, { done: sb }));
    expect(rowEl(B).classList.contains("is-resolved"), "then the second");
    judge("two rows", [A, B]);
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("Delete the file, Hold to undo and a file resolved from a terminal each write to their own row only", { skip }, async () => {
  const v = await run(`
    // Delete the file (the side that deleted it is yours).
    let P = "app/greeting.py";
    begin();
    key("accept:yours:" + P).click();
    let seq = lastPost().seq;
    expect(lastPost().type === "accept" && lastPost().role === "yours", "Delete the file accepts the deleting side");
    d.render(S(busyRows(P), { done: seq - 1 }));
    set(P, { status: "resolved", choice: "yours" });
    d.render(S(FILES, { done: seq }));
    expect(/deleted/.test(rowEl(P).querySelector(".cd-choice").textContent), "the row says the file was deleted (" + rowEl(P).querySelector(".cd-choice").textContent + ")");
    judge("delete", P);

    // Hold to undo.
    P = "README.md";
    begin();
    const hold = key("restore:" + P);
    hold.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    clock.advance(HOLD_TO_UNDO_MS);
    seq = lastPost().seq;
    expect(lastPost().type === "restore" && lastPost().path === P, "a full hold restores");
    expect(key("restore:" + P) === hold && rowEl(P).querySelector(".cd-spinner"), "the row waits, busy, with its Hold to undo in place");
    d.render(S(busyRows(P), { done: seq - 1 }));
    set(P, { status: "pending", choice: undefined });
    d.render(S(FILES, { done: seq }));
    expect(key("accept:yours:" + P) && !key("restore:" + P), "the conflict is back");
    judge("hold to undo", P);

    // Resolved from a terminal: no press, one state.
    P = "cases/same-both.txt";
    begin();
    set(P, { status: "resolved", choice: "merged" });
    d.render(S(FILES, { done: seq }));
    expect(rowEl(P).classList.contains("is-resolved"), "the row is resolved");
    judge("terminal", P);
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("a host that does not number presses, or locks the whole page for one file, still never writes to another row", { skip }, async () => {
  // The extension before this change (busy + the row busy) and the desktop's
  // controller as it was (busy, no row marked): what they send may lock the
  // PAGE — one class — but every row other than the pressed one stays as it was.
  const v = await run(`
    let P = "app/calculator.py";
    d.render(S(FILES));                                                // no \`done\` from here on
    begin();
    key("accept:yours:" + P).click();
    d.render(S(busyRows(P), { busy: true }));
    set(P, { status: "resolved", choice: "yours" });
    d.render(S(FILES));
    expect(rowEl(P).classList.contains("is-resolved"), "the row resolves");
    judge("old extension", P, true);

    P = "stress/config.json";
    begin();
    key("accept:theirs:" + P).click();
    d.render(S(FILES, { busy: true }));                               // the old desktop: busy, no row marked
    expect(rowEl(P).querySelector(".cd-spinner"), "the pressed row stays busy while it works");
    set(P, { status: "resolved", choice: "theirs" });
    d.render(S(FILES, { busy: true }));
    expect(rowEl(P).classList.contains("is-resolved") && !rowEl(P).querySelector(".cd-spinner"), "resolved as soon as it is");
    d.render(S(FILES));
    judge("old desktop", P, true);
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

test("a hold in progress survives another file being resolved; an operation verb still ends it", { skip }, async () => {
  const v = await run(`
    const hold = key("restore:cases/whitespace.txt");
    hold.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    clock.advance(400);
    set("stress/userService.js", { status: "resolved", choice: "theirs" });
    d.render(S(FILES, { done: 0 }));                                   // resolved elsewhere, mid-hold
    expect(hold.classList.contains("arming"), "the sweep carries on");
    clock.advance(350);
    expect(posted.some((a) => a.type === "restore" && a.path === "cases/whitespace.txt"), "and the hold completes");

    const h2 = key("restore:f.txt");
    h2.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    clock.advance(400);
    d.render(S(FILES, { busy: true, done: 0 }));                       // a Continue / Abort starts
    clock.advance(1000);
    expect(!posted.some((a) => a.type === "restore" && a.path === "f.txt"), "an operation verb ends a hold");
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
    const dash = dashEl();
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

test("a row at work leaves every other row's look alone however long git takes; an operation verb greys after a moment; a disabled control is grey at once", { skip }, async () => {
  const v = await run(`
    const m = key("merge:stress/config.json");
    const cs = () => getComputedStyle(m);
    const look = () => [cs().backgroundColor, cs().color, cs().borderTopColor, cs().cursor].join(" ");
    const live = look();
    // One file's work: the rest keep their look — past the lock's delay too.
    key("accept:yours:app/calculator.py").click();
    d.render(S(busyRows("app/calculator.py"), { done: 0 }));
    await new Promise((r) => setTimeout(r, 1200));
    expect(!m.hasAttribute("aria-disabled") && !m.disabled, "another row's button is not locked");
    expect(look() === live, "and its look is the live one after 1.2 s (" + look() + " vs " + live + ")");
    // An operation verb (a Continue): the page's one lock, grey after a wait.
    d.render(S(FILES, { busy: true, done: 1 }));
    expect(!m.hasAttribute("aria-disabled") && !m.disabled, "a row's button carries no lock of its own (the page has it)");
    expect(dashEl().classList.contains("is-busy") && dashEl().getAttribute("aria-busy") === "true", "the page is locked");
    expect(cs().cursor === "progress", "the pointer says the host is working");
    const delays = cs().transitionDelay.split(",").map((s) => parseFloat(s));
    expect(delays.length > 0 && delays.every((x) => x >= 0.5), "its grey look waits (" + cs().transitionDelay + ")");
    d.render(S(FILES, { done: 1 }));
    expect(cs().transitionDelay.split(",").every((s) => parseFloat(s) === 0), "unlocked, it comes back at once (" + cs().transitionDelay + ")");
    const c = $$(".cd-foot button").find((b) => /Continue/.test(b.textContent));
    expect(c.disabled && getComputedStyle(c).transitionDelay.split(",").every((s) => parseFloat(s) === 0), "Continue that git refuses is disabled, grey at once");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("under the webview's CSP (no inline style attributes) a patched style still applies: the bar fills as files resolve", { skip }, async () => {
  // Real VS Code, the recording of this lane: "3 of 9 resolved" over an EMPTY
  // progress bar. The extensions' page allows no inline styles (webviewHtml.ts:
  // style-src without 'unsafe-inline'), and the patch wrote the fill's new
  // width with setAttribute("style") — which CSP blocks. The first paint
  // inserts nodes styled through the CSSOM (allowed), so it showed; every
  // later width was dropped. Headless pages have no CSP, so nothing here saw it.
  const v = await run(`
    const meta = document.createElement("meta");
    meta.httpEquiv = "Content-Security-Policy";
    meta.content = "style-src-attr 'none'";
    document.head.appendChild(meta);
    const canary = document.createElement("div");
    canary.setAttribute("style", "position:absolute;width:7px;height:7px");
    document.body.appendChild(canary);
    expect(canary.getBoundingClientRect().width !== 7, "precondition: this page, like the webview, applies no style attribute");
    canary.remove();
    const still = document.createElement("style"); // the bar's width, not its glide
    still.textContent = ".cd-bar-fill { transition: none !important; }";
    document.head.appendChild(still);
    const fillW = () => Math.round(parseFloat(getComputedStyle($(".cd-bar-fill")).width) / $(".cd-bar").getBoundingClientRect().width * 100);
    expect(Math.abs(fillW() - 33) <= 1, "the first paint's bar: 3 of 9 (" + fillW() + "%)");
    set("app/calculator.py", { status: "resolved", choice: "yours" });
    d.render(S(FILES, { done: 0 }));
    expect($(".cd-progress-label").textContent === "4 of 9 resolved", "the label moves (" + $(".cd-progress-label").textContent + ")");
    expect(Math.abs(fillW() - 44) <= 1, "and so does the bar (" + fillW() + "%, its style says " + $(".cd-bar-fill").getAttribute("style") + ")");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});
