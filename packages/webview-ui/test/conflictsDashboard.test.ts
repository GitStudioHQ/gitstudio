import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { findChrome, runInChrome } from "./headless";

/**
 * The conflicts dashboard (src/conflicts/dashboard.ts), mounted in headless
 * Chrome and fed one ConflictsState per operation — the state table: merge,
 * rebase at 1/3, a rebase paused at an `edit`, a cherry-pick range, a revert,
 * `git am` and a stash apply. Each is asserted right after render(state), with
 * no frame and no real-time wait; hold-to-undo runs on a FAKE clock so 700 ms
 * and 750 ms are exact.
 *
 * This replaces Merge Studio's conflictsHtml.test.ts, which could only grep the
 * template string for `type: "accept"`: here every action is produced by
 * clicking the control that sends it.
 */
const ENTRY = fileURLToPath(new URL("./fixtures/dashboardEntry.ts", import.meta.url));
const CHROME = findChrome();
const STYLES = ["tokens.css", "conflicts.css"]
  .map((f) => readFileSync(fileURLToPath(new URL(`../src/styles/${f}`, import.meta.url)), "utf8"))
  .join("\n")
  .replace(/@import[^;]+;/g, "");
const CSS = `${STYLES}\n#root{height:760px;width:960px;overflow:auto}`;

const PROLOGUE = `
  const { ConflictsDashboard, FakeClock, HOLD_TO_UNDO_MS } = window.__dash;
  const posted = [];
  const clock = new FakeClock();
  const side = (role, stage, name, description) => ({ role, stage, name, paneTitle: name, description: description || name });
  const base = (over) => ({
    kind: "merge", title: "", yours: side("yours", 2, "main"), theirs: side("theirs", 3, "feature"),
    verbs: { abort: "Abort Merge" }, canContinue: false, canSkip: false, episode: "e1", ...over,
  });
  const OPS = {
    merge: base({
      kind: "merge", title: "Merging feature into main",
      direction: { from: "theirs", verb: "into", to: "yours" },
      verbs: { continue: "Continue Merge", abort: "Abort Merge" }, episode: "merge:aa",
    }),
    rebase: base({
      kind: "rebase", backend: "merge",
      title: "Rebasing test onto master · commit 1 of 3: 1a2b3c4 test change",
      direction: { from: "yours", verb: "onto", to: "theirs" },
      step: { n: 1, m: 3, unit: "commit" },
      commit: { sha: "1a2b3c4d5e6f708192a3b4c5d6e7f80912a3b4c5", subject: "test change", author: "Ann" },
      yours: side("yours", 3, "test", "Your commit 1a2b3c4 from test"), theirs: side("theirs", 2, "master"),
      verbs: { continue: "Continue Rebase", abort: "Abort Rebase" }, episode: "rebase:1a2b3c4",
    }),
    paused: base({
      kind: "rebase", backend: "merge",
      title: "Rebasing test onto master · commit 2 of 3",
      direction: { from: "yours", verb: "onto", to: "theirs" },
      step: { n: 2, m: 3, unit: "commit" },
      yours: side("yours", 3, "test"), theirs: side("theirs", 2, "master"),
      verbs: { continue: "Continue Rebase", abort: "Abort Rebase" }, canContinue: true,
      pause: { reason: "edit", detail: "Paused to edit 2b3c4d5 second change" }, episode: "rebase:pause",
    }),
    cherry: base({
      kind: "cherry-pick", title: "Cherry-picking 3c4d5e6 fix typo onto main · 2 more queued",
      direction: { from: "theirs", verb: "onto", to: "yours" }, queued: 2,
      commit: { sha: "3c4d5e6f708192a3b4c5d6e7f80912a3b4c5d6e7", subject: "fix typo" },
      yours: side("yours", 2, "main"), theirs: side("theirs", 3, "3c4d5e6"),
      verbs: { continue: "Continue Cherry-pick", skip: "Skip", abort: "Abort Cherry-pick" }, canSkip: true, episode: "cp:3c4d5e6",
    }),
    revert: base({
      kind: "revert", title: "Reverting 4d5e6f7 add flag on main",
      direction: { from: "theirs", verb: "on", to: "yours" },
      commit: { sha: "4d5e6f708192a3b4c5d6e7f80912a3b4c5d6e7f8", subject: "add flag" },
      yours: side("yours", 2, "main"), theirs: side("theirs", 3, "undo of 4d5e6f7"),
      verbs: { continue: "Continue Revert", skip: "Skip", abort: "Abort Revert" }, canSkip: true, episode: "rv:4d5e6f7",
    }),
    am: base({
      kind: "am", title: "Applying patch 2 of 5: docs (by Bo) onto main",
      direction: { from: "theirs", verb: "onto", to: "yours" },
      step: { n: 2, m: 5, unit: "patch" }, commit: { sha: "", subject: "docs", author: "Bo" },
      yours: side("yours", 2, "main"), theirs: side("theirs", 3, "patch 2/5"),
      verbs: { continue: "Continue (git am)", skip: "Skip patch", abort: "Abort (git am)" }, canSkip: true, episode: "am:2",
    }),
    stash: base({
      kind: "stash", title: "Applying stashed changes on main",
      direction: { from: "yours", verb: "on", to: "theirs" },
      yours: side("yours", 3, "stash"), theirs: side("theirs", 2, "main"),
      verbs: { abort: "Cancel" }, episode: "stash",
    }),
  };
  const row = (path, over) => ({ path, status: "pending", shape: "text", ...over });
  const state = (op, files, over) => {
    const resolved = files.filter((f) => f.status === "resolved").length;
    return {
      brand: { name: "GitStudio", mark: "gitstudio" }, repoName: "demo", op, files,
      total: files.length, resolved, busy: false, holdToUndoMs: HOLD_TO_UNDO_MS, ...over,
    };
  };
  const mount = (opts) => new ConflictsDashboard(document.getElementById("root"), { post: (a) => posted.push(a), timers: clock, ...opts });
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const text = (s) => ($(s) ? $(s).textContent.replace(/\\s+/g, " ").trim() : null);
  const btn = (label) => $$(".cd-dash button").find((b) => b.textContent.replace(/\\s+/g, " ").trim() === label);
  const last = () => posted[posted.length - 1];
  /** Locked while the host works (aria-disabled), or disabled outright. */
  const locked = (b) => !!b && (b.disabled || b.getAttribute("aria-disabled") === "true");
`;

const run = (script: string) => runInChrome(CHROME!, ENTRY, PROLOGUE + script, { css: CSS, width: 1000, height: 820 });
// VS Code's Light Modern: errorForeground #F85149 is 3.35:1 on its white
// editor — under AA for the danger buttons' text (the verifier's finding).
const LIGHT_MODERN = `
  document.body.className = "vscode-light";
  document.documentElement.style.cssText +=
    ";--vscode-errorForeground:#F85149;--vscode-foreground:#3B3B3B;--vscode-editor-background:#FFFFFF";
  const rgbOf = (c) => {
    let m = /rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)/.exec(c);
    if (m) return [+m[1], +m[2], +m[3]];
    m = /color\\(srgb ([\\d.]+) ([\\d.]+) ([\\d.]+)/.exec(c);
    return m ? [m[1] * 255, m[2] * 255, m[3] * 255] : null;
  };
  const lum = (rgb) => {
    const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
  };
  const contrastOnWhite = (el) => {
    const rgb = rgbOf(getComputedStyle(el).color);
    return rgb ? 1.05 / (lum(rgb) + 0.05) : 0;
  };
`;

const skip = !CHROME && "no Chrome on this machine";

test("every operation's dashboard names its direction, step and verbs", { skip }, async () => {
  const v = await run(`
    const d = mount();
    const TABLE = [
      ["merge",  "THEIRS feature → into → YOURS main", "",                          "Merge in progress",       "Continue Merge",       "Abort Merge",       null],
      ["rebase", "YOURS test → onto → THEIRS master",  "commit 1 of 3",             "Rebase in progress",      "Continue Rebase",      "Abort Rebase",      null],
      ["paused", "YOURS test → onto → THEIRS master",  "commit 2 of 3",             "Rebase paused",           "Continue Rebase",      "Abort Rebase",      null],
      ["cherry", "THEIRS 3c4d5e6 → onto → YOURS main", "2 more queued",             "Cherry-pick in progress", "Continue Cherry-pick", "Abort Cherry-pick", "Skip"],
      ["revert", "THEIRS undo of 4d5e6f7 → on → YOURS main", "",                    "Revert in progress",      "Continue Revert",      "Abort Revert",      "Skip"],
      ["am",     "THEIRS patch 2/5 → onto → YOURS main", "patch 2 of 5",            "Applying patches",        "Continue (git am)",    "Abort (git am)",    "Skip patch"],
      ["stash",  "YOURS stash → on → THEIRS main",     "",                          "Applying a stash",        null,                   "Cancel the stash apply", null],
    ];
    for (const [key, dir, step, chip, cont, abort, skipLabel] of TABLE) {
      const op = OPS[key];
      const files = op.pause ? [] : [row("src/a.ts"), row("src/b.ts", { status: "resolved", choice: "yours" })];
      d.render(state(op, files));
      const bar = $(".cd-dirbar");
      expect(bar && bar.getAttribute("aria-label") === dir, key + ": direction reads '" + dir + "' (" + (bar && bar.getAttribute("aria-label")) + ")");
      expect(bar && bar.querySelector(".cd-branch").classList.contains("cd-branch-" + op.direction.from), key + ": the pill order follows the direction");
      if (step) expect((text(".cd-step") || "").includes(step), key + ": step '" + step + "' (" + text(".cd-step") + ")");
      expect(text(".cd-chip") === chip, key + ": chip '" + chip + "' (" + text(".cd-chip") + ")");
      expect(cont ? !!btn(cont) : !$$(".cd-foot button").some((b) => /Continue/.test(b.textContent)), key + ": Continue is " + (cont || "absent"));
      expect(!!btn(abort), key + ": the way out reads '" + abort + "'");
      expect(skipLabel ? !!btn(skipLabel) : !btn("Skip") && !btn("Skip patch"), key + ": Skip is " + (skipLabel || "absent"));
      if (op.commit && op.commit.sha) expect((text(".cd-commit") || "").includes(op.commit.sha.slice(0, 7)), key + ": the commit card carries the short sha");
      expect(text(".cd-optitle") === op.title, key + ": the header is the operation's title");
    }
    d.render(state(OPS.paused, []));
    expect(/Paused to edit 2b3c4d5/.test(text(".cd-pause") || ""), "a pause says what it paused on (" + text(".cd-pause") + ")");
    expect(!$(".cd-list"), "and lists no files to resolve");
    expect(btn("Continue Rebase") && !btn("Continue Rebase").disabled, "a pause offers Continue");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("Continue is disabled with the reason in words, and enabled once git would accept it", { skip }, async () => {
  const v = await run(`
    const d = mount();
    d.render(state(OPS.rebase, [row("a.ts"), row("b.ts")]));
    const c = btn("Continue Rebase");
    expect(c && c.disabled, "two files unresolved: Continue is disabled");
    expect(text(".cd-why") === "Resolve the 2 conflicted files first.", "and says why, on screen (" + text(".cd-why") + ")");
    expect(c.getAttribute("aria-describedby") === "cd-why", "the reason is the button's description");
    d.render(state({ ...OPS.rebase, continueBlocked: "b.ts still has conflict markers staged" }, [row("a.ts", { status: "resolved", choice: "merged" })]));
    // Every row resolved: the card, in the success card's place, says git's own gate in its words.
    expect(text(".cd-done-note") === "b.ts still has conflict markers staged", "git's own gate is said in its words (" + text(".cd-done-note") + ")");
    // Nothing conflicted and still no Continue — an emptied cherry-pick, a
    // patch git could not apply: the reason is the stop's, not a conflict's.
    d.render(state({ ...OPS.cherry, canContinue: false }, []));
    expect(/Nothing is left to commit at this step/.test(text(".cd-why") || ""), "an emptied stop says there is nothing to commit (" + text(".cd-why") + ")");
    d.render(state({ ...OPS.am, canContinue: false }, []));
    expect(/couldn't apply this patch/.test(text(".cd-why") || ""), "and git am says the patch did not apply (" + text(".cd-why") + ")");
    d.render(state({ ...OPS.rebase, canContinue: true }, [row("a.ts", { status: "resolved", choice: "theirs" })]));
    expect(!btn("Continue Rebase").disabled && !$(".cd-why"), "all resolved and allowed: enabled, no reason");
    expect(text(".cd-done-title") === "Commit 1 of 3 resolved", "the success card shows, for THIS commit of three (" + text(".cd-done-title") + ")");
    btn("Continue Rebase").click();
    btn("Continue Rebase").click();
    expect(posted.filter((a) => a.type === "continue").length === 1, "a double press posts ONE continue (" + posted.filter((a) => a.type === "continue").length + ")");
    expect(JSON.stringify(last()) === JSON.stringify({ type: "continue" }), "with no drop confirm");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("Skip is offered only where git names it as the way out, and asks first", { skip }, async () => {
  const v = await run(`
    const d = mount();
    d.render(state({ ...OPS.rebase, verbs: { ...OPS.rebase.verbs, skip: "Skip this commit" }, canSkip: false }, [row("a.ts")]));
    expect(!btn("Skip this commit"), "a merge-backend rebase stop has no Skip (it would hard-reset)");
    d.render(state({ ...OPS.rebase, backend: "apply", verbs: { ...OPS.rebase.verbs, skip: "Skip this commit" }, canSkip: true }, []));
    const s = btn("Skip this commit");
    expect(!!s, "the apply backend's emptied patch offers Skip");
    expect(!s.classList.contains("cd-primary"), "and it is never the primary button");
    s.click();
    expect(!posted.some((a) => a.type === "skip"), "pressing it asks first");
    expect(/test change/.test(text(".cd-confirm") || ""), "naming what is dropped (" + text(".cd-confirm") + ")");
    expect(document.activeElement === btn("Keep going"), "the safe answer has the keyboard");
    btn("Keep going").click();
    expect(!$(".cd-confirm") && !posted.some((a) => a.type === "skip"), "Keep going sends nothing");
    btn("Skip this commit").click();
    const go = $(".cd-confirm .cd-danger");
    expect(go && go.textContent.trim() === "Skip this commit", "the confirm's own button repeats the verb");
    go.click();
    go.click();
    expect(posted.filter((a) => a.type === "skip").length === 1, "confirmed twice in a row: exactly one skip");
    expect(locked(btn("Skip this commit")), "and the footer stays locked until the host answers");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("hold-to-undo fires at the hold time, not before — by pointer and by keyboard", { skip }, async () => {
  const v = await run(`
    const d = mount();
    const files = [row("src/a.ts", { status: "resolved", choice: "yours" }), row("src/b.ts")];
    d.render(state(OPS.merge, files));
    expect(HOLD_TO_UNDO_MS === 750, "the contract's hold is 750 ms");
    let hold = $(".cd-undo-hold");
    expect(text(".cd-choice") === "✓ kept yours · main", "the resolved row says how, and which branch (" + text(".cd-choice") + ")");
    hold.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    clock.advance(700);
    expect(!posted.some((a) => a.type === "restore"), "700 ms is not a hold");
    hold.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    clock.advance(1000);
    expect(!posted.some((a) => a.type === "restore"), "letting go early cancels it");
    hold.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    clock.advance(749);
    expect(!posted.some((a) => a.type === "restore"), "749 ms is not a hold either");
    clock.advance(1);
    expect(JSON.stringify(last()) === JSON.stringify({ type: "restore", path: "src/a.ts" }), "750 ms restores the file (" + JSON.stringify(last()) + ")");
    expect($(".cd-row[data-path='src/a.ts'] .cd-spinner"), "and the row shows it is working");

    d.render(state(OPS.merge, files));
    hold = $(".cd-undo-hold");
    hold.focus();
    const key = (type, k, repeat) => document.activeElement.dispatchEvent(new KeyboardEvent(type, { key: k, repeat: !!repeat, bubbles: true, cancelable: true }));
    key("keydown", "Enter");
    clock.advance(300);
    key("keydown", "Enter", true);
    clock.advance(300);
    key("keyup", "Enter");
    clock.advance(500);
    expect(posted.filter((a) => a.type === "restore").length === 1, "a 600 ms key hold does not fire, and auto-repeat does not restart it");
    key("keydown", " ");
    clock.advance(750);
    expect(posted.filter((a) => a.type === "restore").length === 2, "a full Space hold does");
    d.render(state(OPS.merge, files));
    $(".cd-undo-hold").click();
    clock.advance(2000);
    expect(posted.filter((a) => a.type === "restore").length === 2, "a plain click never restores");
    expect(clock.armed() === 0, "and no timer is left armed");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("a host re-sending the same state does not cancel a hold in progress; a changed one still does", { skip }, async () => {
  // Every host re-sends the full state after any repository event — in VS
  // Code a click that focuses the window sets off vscode.git's refresh, and
  // the panel posts again. Each post repainted, and a repaint cancels every
  // hold: the user held, the fill reset, and nothing came back.
  const v = await run(`
    const d = mount();
    const files = [row("src/a.ts", { status: "resolved", choice: "yours" }), row("src/b.ts")];
    d.render(state(OPS.merge, files));
    $(".cd-undo-hold").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    clock.advance(400);
    d.render(state(OPS.merge, files));
    clock.advance(350);
    expect(JSON.stringify(last()) === JSON.stringify({ type: "restore", path: "src/a.ts" }), "the hold survives an identical state (" + JSON.stringify(last()) + ")");

    d.render(state(OPS.merge, files));
    $(".cd-undo-hold").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    clock.advance(400);
    d.render(state(OPS.merge, [row("src/a.ts"), row("src/b.ts")]));
    clock.advance(1000);
    expect(posted.filter((a) => a.type === "restore").length === 1, "a state where the row changed still cancels it");
    expect(clock.armed() === 0, "and leaves no timer armed");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("names are text: markup in a branch, a path or a subject stays a string", { skip }, async () => {
  const v = await run(`
    const d = mount();
    const EVIL = '<img src=x onerror="window.__pwned=1">';
    const op = { ...OPS.rebase,
      title: "Rebasing " + EVIL + " onto master",
      yours: side("yours", 3, "feat/" + EVIL), theirs: side("theirs", 2, "main"),
      commit: { sha: "1a2b3c4d5e6f708192a3b4c5d6e7f80912a3b4c5", subject: EVIL, author: EVIL } };
    d.render(state(op, [row("dir/" + EVIL + ".ts", { badge: EVIL })], { repoName: EVIL, notice: { kind: "info", text: EVIL } }));
    expect(!$(".cd-dash img"), "no element was made from a name");
    expect(window.__pwned === undefined, "and nothing ran");
    expect((text(".cd-branch-yours .cd-bname") || "").includes("<img"), "the branch name is shown literally");
    expect($(".cd-branch-yours .cd-bname wbr"), "with a break opportunity after its slash");
    expect((text(".cd-subject") || "") === EVIL, "the subject is shown literally");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("every action the host handles is sent by a control on the dashboard", { skip }, async () => {
  const v = await run(`
    const d = mount();
    expect(posted[0] && posted[0].type === "ready", "mounting announces itself");
    const DROP = { ...OPS.cherry, canContinue: true, willDrop: { sha: "3c4d5e6f708192a3b4c5d6e7f80912a3b4c5d6e7", subject: "fix typo", branch: "main" } };
    const files = [
      row("a.ts"),
      row("gone.ts", { shape: "both-deleted" }),
      row("half.ts", { shape: "modify-delete", missingRole: "theirs", badge: "deleted in theirs (3c4d5e6)" }),
      row("done.ts", { status: "resolved", choice: "merged" }),
    ];
    const S = () => state(DROP, files, { supportLinks: [{ label: "Report an issue", url: "https://example.com/issues" }] });
    d.render(S());
    $(".cd-row[data-path='a.ts'] button").click();                    // accept
    d.render(S());
    btn("Merge…").click();                                             // merge
    btn("Delete the file").click();                                     // delete (DD row comes first)
    d.render(S());
    const halfBtns = [...$(".cd-row[data-path='half.ts']").querySelectorAll("button")].map((b) => b.textContent.trim());
    expect(halfBtns.join("|") === "Accept Yours|Delete the file", "a modify/delete row names the deleting side, and offers no text merge (" + halfBtns.join("|") + ")");
    const hold = $(".cd-undo-hold");
    hold.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    clock.advance(HOLD_TO_UNDO_MS);                                     // restore
    d.render(S());
    btn("Continue Cherry-pick").click();
    expect(!posted.some((a) => a.type === "continue"), "an emptied commit makes Continue ask first");
    expect(/fix typo/.test(text(".cd-confirm") || ""), "naming it (" + text(".cd-confirm") + ")");
    btn("Drop it and continue").click();                                // continue{confirmDrop}
    d.render(S());
    btn("Skip").click(); $(".cd-confirm .cd-danger").click();          // skip
    d.render(S());
    btn("Abort Cherry-pick").click();
    expect(/Abort the cherry-pick\\?/.test(text(".cd-confirm") || ""), "Abort asks, inline (" + text(".cd-confirm") + ")");
    $(".cd-confirm .cd-danger").click();                               // abort
    d.render(S());
    btn("Report an issue").click();                                    // openExternal
    d.render(state(OPS.merge, [row("x.ts", { status: "resolved", choice: "yours" })]));
    btn("Close").click();                                              // close
    const types = new Set(posted.map((a) => a.type));
    for (const t of ["ready", "accept", "merge", "restore", "delete", "continue", "skip", "abort", "close", "openExternal"]) {
      expect(types.has(t), "some control sends '" + t + "'");
    }
    const accept = posted.find((a) => a.type === "accept");
    expect(accept && accept.path === "a.ts" && accept.role === "yours", "Accept Yours sends the row's path and role (" + JSON.stringify(accept) + ")");
    expect(posted.some((a) => a.type === "continue" && a.confirmDrop === true), "the drop confirm sends confirmDrop");
    expect(posted.find((a) => a.type === "delete").path === "gone.ts", "Delete the file on a DD row deletes that row's file");
    expect(posted.find((a) => a.type === "openExternal").url === "https://example.com/issues", "a support link opens its url");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("a new stop resets a half-answered confirm, and a host that cannot close offers no Close", { skip }, async () => {
  const v = await run(`
    const d = mount({ closable: false });
    d.render(state(OPS.rebase, [row("a.ts")]));
    btn("Abort Rebase").click();
    expect(!!$(".cd-confirm"), "the confirm is open");
    d.render(state(OPS.rebase, [row("a.ts"), row("b.ts")]));
    expect(!!$(".cd-confirm"), "a state push for the SAME stop keeps it open");
    d.render(state({ ...OPS.rebase, episode: "rebase:next" }, [row("a.ts")]));
    expect(!$(".cd-confirm"), "the next commit's stop drops it");
    d.render(state(OPS.merge, [row("x.ts", { status: "resolved", choice: "yours" })]));
    expect(!btn("Close"), "no Close where the host cannot close");
    d.render(state(OPS.rebase, [row("a.ts")], { busy: true }));
    expect($$(".cd-dash button").every(locked), "while the host works, every control is locked");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("once our Continue ends the operation, the header says nothing is in progress — no 'Unmerged files' alarm over 'No conflicted files'", { skip }, async () => {
  // Real VS Code, the reporter's rebase: Continue Rebase on the dashboard, and
  // the dashboard stays to say "Rebase complete" — with the next episode (kind
  // none, no rows) under a red UNMERGED FILES chip.
  const v = await run(`
    const d = mount({ closable: true });
    d.render(state(OPS.rebase, [row("f.txt", { status: "resolved", choice: "yours" })]));
    const none = base({ kind: "none", title: "", yours: side("yours", 2, "test"), theirs: side("theirs", 3, ""), verbs: { abort: "Cancel" }, episode: "none" });
    d.render(state(none, [], { outcome: { kind: "done", text: "Rebase complete" } }));
    expect(!$(".cd-chip"), "no operation chip once nothing is in progress (" + text(".cd-chip") + ")");
    expect(/Rebase complete/.test(text(".cd-dash") || ""), "the outcome is said");
    d.render(state(none, [row("x.txt")]));
    expect(text(".cd-chip") === "Unmerged files", "with nothing in progress but a file still unmerged, the chip still says so (" + text(".cd-chip") + ")");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("after the operation finishes: 'Rebase complete', with no 'Unmerged files' chip and no empty-list line above it", { skip }, async () => {
  // Seen in real VS Code after Continue Rebase: a red UNMERGED FILES chip and
  // "No conflicted files." sat over "Rebase complete".
  const v = await run(`
    const d = mount();
    d.render(state(base({ kind: "none", verbs: {} }), [], { outcome: { kind: "done", text: "Rebase complete" } }));
    expect(!$(".cd-chip"), "no chip: nothing is in progress or unmerged (" + text(".cd-chip") + ")");
    expect(!$(".cd-empty"), "no 'No conflicted files.' over the outcome (" + text(".cd-empty") + ")");
    expect(!$(".cd-list"), "and no empty list box");
    expect(text(".cd-outcome") === "Rebase complete", "the outcome says it (" + text(".cd-outcome") + ")");
    d.render(state(base({ kind: "none", verbs: {} }), [row("x.ts")]));
    expect(text(".cd-chip") === "Unmerged files", "unmerged files with no operation keep their chip (" + text(".cd-chip") + ")");
    d.render(state(OPS.rebase, []));
    expect(text(".cd-empty") === "No conflicted files at this step.", "a stop with nothing to resolve still says so (" + text(".cd-empty") + ")");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("support links: only the problem report mid-operation; rating and sponsoring once the work is done (POLISH A5.10)", { skip }, async () => {
  const v = await run(`
    const d = mount();
    const LINKS = [
      { label: "Report a problem", url: "https://example.com/issues/new" },
      { label: "Rate Merge Studio", url: "https://example.com/rate" },
      { label: "Sponsor", url: "https://example.com/sponsor" },
    ];
    const shown = () => $$(".cd-support button").map((b) => b.textContent.trim()).join("|");
    d.render(state(OPS.rebase, [row("a.ts"), row("b.ts", { status: "resolved", choice: "yours" })], { supportLinks: LINKS }));
    expect(shown() === "Report a problem", "mid-rebase, beside Abort and Continue: only the problem report (" + shown() + ")");
    d.render(state(OPS.rebase, [row("a.ts", { status: "resolved", choice: "theirs" })], { supportLinks: LINKS }));
    expect(shown() === "Report a problem|Rate Merge Studio|Sponsor", "every file resolved: all of them (" + shown() + ")");
    d.render(state(base({ kind: "none", verbs: {} }), [], { supportLinks: LINKS, outcome: { kind: "done", text: "Rebase complete" } }));
    expect(shown() === "Report a problem|Rate Merge Studio|Sponsor", "the operation finished: all of them (" + shown() + ")");
    d.render(state(OPS.rebase, [row("a.ts")], { supportLinks: LINKS, outcome: { kind: "failed", text: "git refused" } }));
    expect(shown() === "Report a problem", "a failure is no time to ask for a rating (" + shown() + ")");
    d.render(state(OPS.rebase, [row("a.ts")]));
    expect(!$(".cd-support"), "no links, no slot (GitStudio)");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("every file resolved: Continue is the one primary button, and Close beside it is secondary", { skip }, async () => {
  // The verifier: the success card showed Close and Continue Rebase as two
  // identical primary buttons (.cd-primary-quiet was styled as .cd-primary).
  const v = await run(`
    const d = mount({ closable: true });
    d.render(state({ ...OPS.rebase, canContinue: true }, [row("a.ts", { status: "resolved", choice: "yours" })]));
    const close = btn("Close");
    const cont = btn("Continue Rebase");
    expect(!!close && !!cont, "both are offered");
    const bg = (b) => getComputedStyle(b).backgroundColor;
    expect(bg(close) !== bg(cont), "Close does not look like Continue (" + bg(close) + " / " + bg(cont) + ")");
    expect(![...close.classList].some((c) => c.startsWith("cd-primary")), "Close is not a primary button: " + close.className);
    const accept = document.createElement("button");
    accept.className = "cd-btn";
    document.querySelector(".cd-dash").appendChild(accept);
    expect(bg(close) === bg(accept), "Close is painted as a secondary button (" + bg(close) + " / " + bg(accept) + ")");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("on a light theme the danger buttons' text clears AA (Light Modern's red does not)", { skip }, async () => {
  const v = await run(LIGHT_MODERN + `
    const d = mount();
    d.render(state(OPS.merge, [row("m.txt", { shape: "modify-delete", missingRole: "yours", badge: "deleted in yours (main)" })]));
    const danger = $$(".cd-btn.cd-danger");
    expect(danger.length >= 2, "the row's Delete the file and the footer's Abort are danger buttons (" + danger.length + ")");
    for (const b of danger) {
      const c = contrastOnWhite(b);
      expect(c >= 4.5, b.textContent.trim() + ": " + c.toFixed(2) + ":1 on white");
    }
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("a submodule row names the two commits, and each Accept says which it records", { skip }, async () => {
  const v = await run(`
    const d = mount();
    d.render(state(OPS.merge, [row("vendor/lib", {
      shape: "submodule",
      badge: "submodule: yours at 1c34b25, theirs at 9d20bed",
      commits: { yours: "1c34b25aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", theirs: "9d20bedbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
    })]));
    expect(text(".cd-badge") === "submodule: yours at 1c34b25, theirs at 9d20bed", "the badge (" + text(".cd-badge") + ")");
    expect(!btn("Merge…"), "no line-by-line merge of a submodule");
    expect(/commit 1c34b25/.test(btn("Accept Yours").title), "Accept Yours: " + btn("Accept Yours").title);
    expect(/commit 9d20bed/.test(btn("Accept Theirs").title), "Accept Theirs: " + btn("Accept Theirs").title);
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("in a narrow pane every row keeps its file name, and its buttons stay in the row", { skip }, async () => {
  // The desktop hosts the dashboard in ONE pane of its window: 443px wide at
  // a 1000px window. The rows wrapped only under a 560px VIEWPORT, which the
  // desktop never has, so a row with a badge and two or three buttons
  // squeezed its file name to nothing — "deleted in yours (master) [Delete
  // the file] [Accept Theirs]", about no file anyone could name — and its last
  // button ran out of the row.
  const v = await run(`
    document.getElementById("root").style.width = "443px";
    const d = mount({ closable: false });
    d.render(state(OPS.merge, [
      row("a.txt"),
      row("logo.bin", { shape: "binary" }),
      row("m.txt", { shape: "modify-delete", missingRole: "yours", badge: "deleted in yours (master)" }),
      row("n.txt", { shape: "added-both", badge: "added in both" }),
      row("renamed-feature.txt", { shape: "added-one-side", missingRole: "yours", badge: "added in theirs (feature/login)" }),
      row("src/app.ts", { badge: "both modified" }),
      // (A path so long that its folders crowd out the name is POLISH A3.4's.)
    ]));
    for (const r of $$(".cd-row")) {
      const box = r.getBoundingClientRect();
      // The name's own box is its full width however little of it shows; what
      // SHOWS is the part inside the clipping .cd-file.
      const name = r.querySelector(".cd-name").getBoundingClientRect();
      const file = r.querySelector(".cd-file").getBoundingClientRect();
      const seen = Math.max(0, Math.min(name.right, file.right) - Math.max(name.left, file.left));
      expect(seen >= Math.min(name.width, 60) - 1, r.dataset.path + ": the file name is on screen (" + Math.round(seen) + " of " + Math.round(name.width) + "px)");
      for (const b of r.querySelectorAll("button")) {
        const bb = b.getBoundingClientRect();
        expect(bb.left >= box.left - 1 && bb.right <= box.right + 1, r.dataset.path + ": " + b.textContent.trim() + " stays in its row (" + Math.round(bb.left) + "–" + Math.round(bb.right) + " in " + Math.round(box.left) + "–" + Math.round(box.right) + ")");
      }
      // …and together: a wrapped row put Accept Yours and Accept Theirs on
      // one line and Merge… alone on the next, flush left.
      const tops = new Set([...r.querySelectorAll("button")].map((b) => Math.round(b.getBoundingClientRect().top)));
      expect(tops.size <= 1, r.dataset.path + ": its buttons share one line (" + [...tops].join(", ") + ")");
    }
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

// ── r0923 verification: the page as the end-to-end run and the critic found it ──

test("the heading and the success card are the operation's and the step's (A5.4), and a blocked Continue is said in the card", { skip }, async () => {
  const v = await run(`
    const d = mount({ closable: true });
    const done = (op) => d.render(state({ ...op, canContinue: true }, [row("a.ts", { status: "resolved", choice: "yours" })]));
    done(OPS.merge);
    expect(text(".cd-title") === "Merge conflicts", "merge heading (" + text(".cd-title") + ")");
    expect(text(".cd-done-title") === "All conflicts resolved" && text(".cd-done-note") === "Review below, then Continue Merge to commit it.", "merge card: " + text(".cd-done"));
    done(OPS.rebase);
    expect(text(".cd-title") === "Rebase conflicts", "rebase heading (" + text(".cd-title") + ")");
    expect(text(".cd-done-title") === "Commit 1 of 3 resolved", "not 'All conflicts resolved' at commit 1 of 3 (" + text(".cd-done-title") + ")");
    expect(/replay the next commit\\. It stops again if that one conflicts\\./.test(text(".cd-done-note") || ""), "(" + text(".cd-done-note") + ")");
    done({ ...OPS.rebase, step: { n: 3, m: 3, unit: "commit" } });
    expect(text(".cd-done-title") === "Last commit resolved" && text(".cd-done-note") === "Continue Rebase to finish.", "the last commit (" + text(".cd-done") + ")");
    expect(text(".cd-chip") === "Rebase in progress", "the chip stays while the rebase waits for Continue (" + text(".cd-chip") + ")");
    done(OPS.am);
    expect(text(".cd-title") === "Patch conflicts" && text(".cd-done-title") === "Patch 2 of 5 resolved", text(".cd-title") + " / " + text(".cd-done-title"));
    // Every file resolved, and git still refuses (markers staged): the card says why, not "resolved".
    d.render(state({ ...OPS.merge, canContinue: false, continueBlocked: "a.ts still has conflict markers staged" }, [row("a.ts", { status: "resolved", choice: "merged" })]));
    expect(text(".cd-done-title") === "Not ready to continue yet", "a blocked Continue is not 'All conflicts resolved' (" + text(".cd-done-title") + ")");
    expect(text(".cd-done-note") === "a.ts still has conflict markers staged", "(" + text(".cd-done-note") + ")");
    expect($(".cd-done").classList.contains("is-blocked"), "in the warning look");
    expect(btn("Continue Merge").disabled && btn("Continue Merge").getAttribute("aria-describedby") === "cd-done-note", "Continue is described by the card");
    expect(!$(".cd-why"), "and the footer does not say it a second time");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("the footer says a count once, a finished stash apply keeps its page, and a tip is dismissed with Got it", { skip }, async () => {
  const v = await run(`
    const d = mount({ closable: true });
    d.render(state({ ...OPS.rebase, canContinue: false, continueBlocked: "2 files still have conflicts" }, [row("a.ts"), row("b.ts")]));
    const foot = text(".cd-foot") || "";
    expect((foot.match(/2 /g) || []).length === 1, "the count is said once (" + foot + ")");
    expect(!$(".cd-counter"), "no separate counter beside Continue's reason");
    // Stash: the last file resolved, git reports nothing in progress; the host sends it finished.
    const none = base({ kind: "none", title: "", verbs: { abort: "Cancel" }, episode: "none" });
    d.render(state(none, [row("app/version.py", { status: "resolved", choice: "yours" }), row("b.py", { status: "resolved" })],
      { finished: { title: "Stash applied", text: "Every conflict is resolved. The stash is still in your stash list." } }));
    expect(text(".cd-title") === "Stash conflicts", "a finished stash apply keeps its heading (" + text(".cd-title") + ")");
    expect(text(".cd-done-title") === "Stash applied" && /still in your stash list/.test(text(".cd-done-note") || ""), "its card: " + text(".cd-done"));
    expect(!$(".cd-undo-hold"), "nothing to hold-to-undo into");
    expect(!btn("Cancel the merge") && !btn("Cancel the stash apply"), "nothing to abort");
    expect(!!btn("Close"), "and a way to close it");
    expect($$(".cd-row").length === 2, "the rows stay");
    // The one-time tip.
    d.render(state(OPS.rebase, [row("a.ts")], { tip: { id: "sides-1.0", text: "New in 1.0: during a rebase, Yours is your commit (test), on the left.", why: "https://example.com/why" } }));
    expect(/Yours is your commit \\(test\\)/.test(text(".cd-tip") || ""), "the tip is on the page (" + text(".cd-tip") + ")");
    btn("Why?").click();
    expect(JSON.stringify(last()) === JSON.stringify({ type: "openExternal", url: "https://example.com/why" }), "Why? opens its page");
    btn("Got it").click();
    expect(JSON.stringify(last()) === JSON.stringify({ type: "dismissTip", id: "sides-1.0" }), "Got it dismisses it (" + JSON.stringify(last()) + ")");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("with thirty files the list scrolls and the footer stays on screen (a host that fills)", { skip }, async () => {
  const v = await run(`
    const root = document.getElementById("root");
    root.style.height = "600px";
    root.style.overflow = "hidden";
    root.classList.add("cd-host-fill");
    const d = mount();
    const files = Array.from({ length: 30 }, (_, i) => row("src/file" + i + ".ts"));
    d.render(state(OPS.rebase, files));
    const box = root.getBoundingClientRect();
    const foot = $(".cd-foot").getBoundingClientRect();
    expect(foot.bottom <= box.bottom + 1 && foot.top >= box.top, "the footer is inside the 600px page (" + Math.round(foot.top) + "–" + Math.round(foot.bottom) + " in " + Math.round(box.top) + "–" + Math.round(box.bottom) + ")");
    const list = $(".cd-list");
    expect(list.scrollHeight > list.clientHeight + 10, "the list scrolls instead of the page (" + list.scrollHeight + " > " + list.clientHeight + ")");
    expect(btn("Abort Rebase") && btn("Continue Rebase"), "Abort and Continue are there to press");
    // Support links are quiet text links under the list, not buttons between Abort and Continue.
    d.render(state(OPS.rebase, files, { supportLinks: [{ label: "Report a problem", url: "https://example.com/issues" }] }));
    const link = $(".cd-support .cd-link");
    expect(!!link && !link.closest(".cd-foot"), "the problem report is a link outside the footer's action row");
    expect(!link.classList.contains("cd-btn"), "and not a button like Abort's");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});
