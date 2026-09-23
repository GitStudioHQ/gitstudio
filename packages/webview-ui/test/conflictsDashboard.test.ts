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
`;

const run = (script: string) => runInChrome(CHROME!, ENTRY, PROLOGUE + script, { css: CSS, width: 1000, height: 820 });
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
    expect(text(".cd-why") === "b.ts still has conflict markers staged", "git's own gate is said in its words (" + text(".cd-why") + ")");
    // Nothing conflicted and still no Continue — an emptied cherry-pick, a
    // patch git could not apply: the reason is the stop's, not a conflict's.
    d.render(state({ ...OPS.cherry, canContinue: false }, []));
    expect(/Nothing is left to commit at this step/.test(text(".cd-why") || ""), "an emptied stop says there is nothing to commit (" + text(".cd-why") + ")");
    d.render(state({ ...OPS.am, canContinue: false }, []));
    expect(/couldn't apply this patch/.test(text(".cd-why") || ""), "and git am says the patch did not apply (" + text(".cd-why") + ")");
    d.render(state({ ...OPS.rebase, canContinue: true }, [row("a.ts", { status: "resolved", choice: "theirs" })]));
    expect(!btn("Continue Rebase").disabled && !$(".cd-why"), "all resolved and allowed: enabled, no reason");
    expect(text(".cd-done-title") === "All conflicts resolved", "the success card shows");
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
    expect(btn("Skip this commit") && btn("Skip this commit").disabled, "and the footer stays locked until the host answers");
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
    expect(text(".cd-choice") === "✓ kept yours", "the resolved row says how (" + text(".cd-choice") + ")");
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
    expect($$(".cd-dash button").every((b) => b.disabled), "while the host works, every control is locked");
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
