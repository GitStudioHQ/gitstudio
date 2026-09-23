import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { findChrome, runInChrome } from "./headless";

/**
 * The merge shell — the toolbar, operation strip, confirms and bottom bar every
 * host mounts around the merge view — driven in headless Chrome over a FAKE
 * MergeViewApi (test/fixtures/shellEntry.ts). The fake records what the shell
 * asked of the view; the page records what the shell posted to the host.
 *
 * Everything is asserted synchronously after the action that causes it, or
 * after a plain timer: nothing here waits on a frame (headless Chrome under a
 * virtual-time budget may never paint one).
 */
const ENTRY = fileURLToPath(new URL("./fixtures/shellEntry.ts", import.meta.url));
const CHROME = findChrome();
const STYLES = ["tokens.css", "diff.css", "shell.css"]
  .map((f) => readFileSync(fileURLToPath(new URL(`../src/styles/${f}`, import.meta.url)), "utf8"))
  .join("\n")
  // Inline <style> cannot follow a relative @import; the files are all here.
  .replace(/@import[^;]+;/g, "");
const CSS = `${STYLES}\n#root{height:640px;width:1280px;display:flex;flex-direction:column}`;

/** A rebase stopped on commit 1 of 3 — Yours is stage 3, drawn on the left (D1). */
const PROLOGUE = `
  const { MergeShell, FakeMergeView } = window.__shell;
  const posted = [];
  let fake;
  let views = 0;
  const side = (role, stage, name, paneTitle, description) => ({ role, stage, name, paneTitle, description });
  const OP = {
    kind: "rebase", backend: "merge",
    title: "Rebasing test onto master · commit 1 of 3: 1a2b3c4 test change",
    direction: { from: "yours", verb: "onto", to: "theirs" },
    step: { n: 1, m: 3, unit: "commit" },
    commit: { sha: "1a2b3c4d5e6f708192a3b4c5d6e7f80912a3b4c5", subject: "test change", author: "Ann" },
    yours: side("yours", 3, "test", "Rebasing 1a2b3c4 from test", "Your commit 1a2b3c4 “test change” from test"),
    theirs: side("theirs", 2, "master", "Already rebased commits and commits from master", "master, plus the commits already rebased onto it"),
    verbs: { continue: "Continue Rebase", abort: "Abort Rebase" },
    canContinue: false, canSkip: false,
    episode: "rebase:1a2b3c4",
  };
  const payload = (over = {}) => ({
    fileName: "src/app.ts", conflictType: "content", source: "git-stages", hasBase: true,
    oursLabel: OP.yours.paneTitle, theirsLabel: OP.theirs.paneTitle,
    base: "b\\n", ours: "o\\n", theirs: "t\\n", result: "r\\n", op: OP, ...over,
  });
  const mount = (p) => new MergeShell(document.getElementById("root"), p, {
    adapter: { post: (m) => posted.push(m) },
    createView: (c) => { views++; fake = new FakeMergeView(c); return fake; },
    isMac: true,
    armMs: 60000,
  });
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const text = (s) => ($(s) ? $(s).textContent.replace(/\\s+/g, " ").trim() : null);
  const shown = (s) => { const n = $(s); return !!n && !n.hidden && !n.closest("[hidden]"); };
  const click = (s) => { const n = typeof s === "string" ? $(s) : s; if (!n) throw new Error("no " + s); n.click(); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const last = () => posted[posted.length - 1];
`;

const run = (script: string) =>
  runInChrome(CHROME!, ENTRY, PROLOGUE + script, { css: CSS, width: 1280, height: 700 });
const skip = !CHROME && "no Chrome on this machine";

test("the strip, the pills and the buttons are named from the operation", { skip }, async () => {
  const v = await run(`
    const shell = mount(payload());
    expect(shown(".ms-opstrip"), "an operation gets a strip");
    expect(text(".ms-pill-yours .ms-pill-name") === "test", "YOURS names the branch being rebased (" + text(".ms-pill-yours .ms-pill-name") + ")");
    expect(text(".ms-pill-theirs .ms-pill-name") === "master", "THEIRS names the branch it is rebased onto (" + text(".ms-pill-theirs .ms-pill-name") + ")");
    const pills = $$(".ms-opstrip .ms-pill");
    expect(pills[0] && pills[0].classList.contains("ms-pill-yours"), "the direction reads from yours: test → onto → master");
    expect(/onto/.test(text(".ms-op-verb") || ""), "the verb between them is the operation's (" + text(".ms-op-verb") + ")");
    expect(text(".ms-op-title") === OP.title, "the header is the operation's title (" + text(".ms-op-title") + ")");
    const strip = text(".ms-opstrip");
    expect(strip.includes("commit 1 of 3"), "the step is on screen (" + strip + ")");
    expect(strip.includes("1a2b3c4"), "the commit being replayed is on screen");
    expect((strip.match(/commit 1 of 3/g) || []).length === 1, "and said once, not twice (" + strip + ")");
    expect(text(".ms-accept-yours") === "Accept Yours" && text(".ms-accept-theirs") === "Accept Theirs", "the bottom bar says Accept Yours / Accept Theirs");
    expect($(".ms-accept-yours").title.includes(OP.yours.description), "Accept Yours' tooltip names the side (" + $(".ms-accept-yours").title + ")");
    expect(text(".ms-apply-yours") === "Yours" && text(".ms-apply-all") === "All" && text(".ms-apply-theirs") === "Theirs", "Apply non-conflicting reads Yours · All · Theirs");
    expect($(".ms-apply-yours").title.includes("yours (test)"), "and names the branch behind Yours (" + $(".ms-apply-yours").title + ")");
    expect(/don't overlap/.test($(".ms-wand").title), "the wand says what it does (" + $(".ms-wand").title + ")");
    expect(fake.renders.length === 1 && fake.renders[0].payload.op === OP, "the view got the payload");
    shell.dispose();
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("with no operation there is no strip, no Continue and no Cancel <operation>", { skip }, async () => {
  const v = await run(`
    mount(payload({ op: undefined, oursLabel: "Current change", theirsLabel: "Incoming change" }));
    expect(!shown(".ms-opstrip"), "no strip without an operation");
    expect(!shown(".ms-continue"), "no Continue");
    click(".ms-cancel");
    expect(!shown(".ms-pop"), "Cancel does not offer to cancel an operation it does not know");
    expect(JSON.stringify(last()) === JSON.stringify({ type: "cancel", mode: "exit" }), "it exits the viewer (" + JSON.stringify(last()) + ")");
    expect($(".ms-accept-yours").title.includes("Current change"), "tooltips fall back to the pane labels");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("Accept Yours takes the left side, Accept Theirs the right", { skip }, async () => {
  const v = await run(`
    mount(payload());
    fake.setCounts({ total: 3, pending: 3, conflictsPending: 1 });
    click(".ms-accept-yours");
    expect(fake.count("acceptAllLeft") === 1 && fake.count("acceptAllRight") === 0, "Accept Yours → acceptAllLeft");
    click(".ms-accept-theirs");
    expect(fake.count("acceptAllRight") === 1, "Accept Theirs → acceptAllRight");
    click(".ms-apply-yours");
    click(".ms-apply-theirs");
    const sides = fake.calls.filter((c) => c.name === "applyNonConflictingSide").map((c) => c.args[0]);
    expect(sides.join() === "left,right", "Apply non-conflicting Yours/Theirs → left/right (" + sides.join() + ")");
    expect(posted.length === 0, "none of this reaches the host");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("Cancel asks which: exit the viewer, or cancel the operation after an inline confirm", { skip }, async () => {
  const v = await run(`
    mount(payload());
    click(".ms-cancel");
    expect(shown(".ms-pop"), "Cancel opens its choices");
    expect(text(".ms-exit") === "Exit viewer", "one is Exit viewer (" + text(".ms-exit") + ")");
    expect(text(".ms-abort") === "Abort Rebase…", "the other names the operation (" + text(".ms-abort") + ")");
    expect(posted.length === 0, "opening it posts nothing");
    click(".ms-exit");
    expect(JSON.stringify(last()) === JSON.stringify({ type: "cancel", mode: "exit" }), "Exit viewer posts cancel{exit}");
    expect(!shown(".ms-pop"), "and closes");

    click(".ms-cancel");
    click(".ms-abort");
    expect(posted.length === 1, "choosing to abort ASKS first — nothing posted yet");
    expect(/discarded/.test(text(".ms-pop-detail") || ""), "and says what is lost (" + text(".ms-pop-detail") + ")");
    expect(document.activeElement === $(".ms-abort-keep"), "the safe answer has the keyboard");
    click(".ms-abort-keep");
    expect(posted.length === 1 && !shown(".ms-pop"), "Keep resolving posts nothing");
    click(".ms-cancel");
    click(".ms-abort");
    click(".ms-abort-go");
    expect(JSON.stringify(last()) === JSON.stringify({ type: "cancel", mode: "abort" }), "confirmed, it posts cancel{abort} (" + JSON.stringify(last()) + ")");
    expect(posted.length === 2, "exactly once");
    click(".ms-cancel");
    expect(!shown(".ms-pop"), "and the shell is locked until the host answers");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("Apply with unresolved changes asks once, with the count, then applies", { skip }, async () => {
  const v = await run(`
    mount(payload());
    fake.setCounts({ total: 5, pending: 3, conflictsPending: 1 });
    click(".ms-apply");
    expect(posted.length === 0, "the first click does not apply");
    expect(text(".ms-apply") === "Apply with 3 unresolved", "it says how many are unresolved (" + text(".ms-apply") + ")");
    expect(/3 unresolved changes will keep the original text/.test(text(".ms-bottom-note") || ""), "and what they will contain (" + text(".ms-bottom-note") + ")");
    click(".ms-apply");
    expect(JSON.stringify(last()) === JSON.stringify({ type: "apply", text: "RESULT TEXT" }), "the second click applies the view's result (" + JSON.stringify(last()) + ")");
    expect($(".ms-apply").disabled, "Apply locks while the host writes");
    window.__shellHandle = null;
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));

  const w = await run(`
    const shell = mount(payload());
    fake.setCounts({ total: 2, pending: 0, conflictsPending: 0 });
    click(".ms-apply");
    expect(last() && last().type === "apply", "with nothing unresolved one click applies");
    shell.handle({ type: "applied", staged: true });
    expect(text(".jb-counter") === "Merge applied and staged", "the counter says it was staged (" + text(".jb-counter") + ")");
    expect($(".ms-apply").disabled, "and Apply is spent");
    fake.setCounts({ total: 2, pending: 1, conflictsPending: 0 });
    expect(!$(".ms-apply").disabled, "a new change re-arms it");
    shell.handle({ type: "applied", staged: false, message: "git add failed: index.lock exists" });
    expect(/index\\.lock/.test(text(".ms-bottom-note") || ""), "a failed stage is said, not hidden (" + text(".ms-bottom-note") + ")");
  `);
  assert.deepEqual(w.fails, [], w.fails.join("\n"));
});

test("Continue appears only once the host reports no conflicts left and git would accept it", { skip }, async () => {
  const v = await run(`
    const shell = mount(payload());
    expect(!shown(".ms-continue"), "not before the host has said anything");
    shell.handle({ type: "opChanged", op: { ...OP, canContinue: false }, remainingConflicts: 1 });
    expect(!shown(".ms-continue"), "not while a file is still conflicted");
    shell.handle({ type: "applied", staged: true });
    shell.handle({ type: "opChanged", op: { ...OP, canContinue: false }, remainingConflicts: 2 });
    expect(/2 files still have conflicts/.test(text(".ms-bottom-note") || ""), "it says how many are left (" + text(".ms-bottom-note") + ")");
    shell.handle({ type: "opChanged", op: { ...OP, canContinue: false, continueBlocked: "app.ts still has conflict markers staged" }, remainingConflicts: 0 });
    expect(!shown(".ms-continue"), "not while git would refuse");
    expect(/conflict markers staged/.test(text(".ms-bottom-note") || ""), "and says why (" + text(".ms-bottom-note") + ")");
    shell.handle({ type: "opChanged", op: { ...OP, canContinue: true }, remainingConflicts: 0 });
    expect(shown(".ms-continue"), "Continue appears at 0 remaining with canContinue");
    expect(text(".ms-continue") === "Continue Rebase", "named for the operation (" + text(".ms-continue") + ")");
    expect($(".ms-continue").classList.contains("jb-primary") && !$(".ms-apply").classList.contains("jb-primary"), "and it is now THE primary action");
    click(".ms-continue");
    expect(JSON.stringify(last()) === JSON.stringify({ type: "continueOperation" }), "it posts continueOperation with no drop confirm (" + JSON.stringify(last()) + ")");
    click(".ms-continue");
    expect(posted.filter((m) => m.type === "continueOperation").length === 1, "a second press while it runs posts nothing");
    shell.handle({ type: "outcome", kind: "done", text: "Rebase complete" });
    expect(text(".ms-outcome") === "Rebase complete" && $(".ms-outcome").classList.contains("is-done"), "the outcome is said (" + text(".ms-outcome") + ")");
    expect(!shown(".ms-continue"), "and a finished operation offers no Continue");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));

  const w = await run(`
    const STASH = { ...OP, kind: "stash", direction: undefined, verbs: { abort: "Cancel" }, canContinue: false, episode: "stash" };
    const shell = mount(payload({ op: STASH }));
    shell.handle({ type: "opChanged", op: STASH, remainingConflicts: 0 });
    expect(!shown(".ms-continue"), "a kind with no Continue verb never shows one");
    click(".ms-cancel");
    expect(text(".ms-abort") === "Cancel the stash apply…", "and its cancel says what it cancels (" + text(".ms-abort") + ")");
  `);
  assert.deepEqual(w.fails, [], w.fails.join("\n"));
});

test("an emptied commit is not dropped without a confirm", { skip }, async () => {
  const v = await run(`
    const shell = mount(payload());
    const DROP = { ...OP, canContinue: true, willDrop: { sha: OP.commit.sha, subject: "test change", branch: "test" } };
    shell.handle({ type: "applied", staged: true });
    shell.handle({ type: "opChanged", op: DROP, remainingConflicts: 0 });
    click(".ms-continue");
    expect(!posted.some((m) => m.type === "continueOperation"), "the first press does not continue");
    expect(shown(".ms-drop-confirm"), "it asks");
    expect(/1a2b3c4/.test(text(".ms-drop-confirm") || "") && /drops it/.test(text(".ms-drop-confirm") || ""), "naming the commit it would drop (" + text(".ms-drop-confirm") + ")");
    click(".ms-drop-keep");
    expect(!shown(".ms-drop-confirm") && !posted.some((m) => m.type === "continueOperation"), "Keep editing posts nothing");
    click(".ms-continue");
    click(".ms-drop-go");
    expect(JSON.stringify(last()) === JSON.stringify({ type: "continueOperation", confirmDrop: true }), "confirmed, it continues WITH confirmDrop (" + JSON.stringify(last()) + ")");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("a whitespace change asks first when it would throw away resolutions; granularity never does", { skip }, async () => {
  const v = await run(`
    mount(payload());
    const ws = $(".ms-ws");
    const wsCalls = () => fake.calls.filter((c) => c.name === "setRenderOptions" && "whitespace" in c.args[0]).map((c) => c.args[0].whitespace);
    fake.setCounts({ total: 2, pending: 2, conflictsPending: 1, hasProgress: false });
    ws.value = "trailing"; ws.dispatchEvent(new Event("change"));
    expect(wsCalls().join() === "trailing", "with no progress it just changes (" + wsCalls().join() + ")");
    fake.setCounts({ total: 2, pending: 1, conflictsPending: 1, hasProgress: true });
    ws.value = "all"; ws.dispatchEvent(new Event("change"));
    expect(wsCalls().join() === "trailing", "with progress it does NOT rebuild yet");
    expect(ws.value === "trailing", "the select goes back until the answer is yes (" + ws.value + ")");
    expect(shown(".ms-ws-confirm"), "and asks");
    click(".ms-ws-keep");
    expect(!shown(".ms-ws-confirm") && wsCalls().join() === "trailing", "Keep my changes changes nothing");
    ws.value = "all"; ws.dispatchEvent(new Event("change"));
    click(".ms-ws-go");
    expect(wsCalls().join() === "trailing,all" && ws.value === "all", "Change anyway rebuilds (" + wsCalls().join() + ")");
    const gran = $$(".jb-toolbar-select")[1];
    gran.value = "lines"; gran.dispatchEvent(new Event("change"));
    const granCalls = fake.calls.filter((c) => c.name === "setRenderOptions" && "showInner" in c.args[0]);
    expect(granCalls.length === 1 && granCalls[0].args[0].showInner === false, "granularity only re-decorates, no question asked");
    expect(!shown(".ms-ws-confirm"), "and raises no confirm");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("a conflict with no text gets the panel, not the editor, and resolves by role", { skip }, async () => {
  const v = await run(`
    const shell = mount(payload({ shape: "binary" }));
    expect(views === 0, "no merge view is created for a binary (" + views + ")");
    expect(shown(".ms-notext") && /binary/i.test(text(".ms-notext-title") || ""), "the panel says what it is (" + text(".ms-notext-title") + ")");
    expect(!shown(".jb-toolbar") && !shown(".ms-apply") && !shown(".ms-accept-yours"), "no toolbar, no Apply, no bulk accept over nothing to merge");
    const btns = $$(".ms-notext-btn").map((b) => b.textContent.trim());
    expect(btns.join("|") === "Accept Yours|Accept Theirs", "both sides are offered (" + btns.join("|") + ")");
    click($$(".ms-notext-btn")[1]);
    expect(JSON.stringify(last()) === JSON.stringify({ type: "takeRole", role: "theirs" }), "Accept Theirs posts takeRole{theirs}");
    expect($$(".ms-notext-btn").every((b) => b.disabled), "and locks while it runs");
    shell.handle({ type: "applied", staged: true });
    expect(/Kept theirs \\(master\\)/.test(text(".ms-notext-done") || ""), "then says what it did (" + text(".ms-notext-done") + ")");
    shell.handle({ type: "opChanged", op: { ...OP, canContinue: true }, remainingConflicts: 0 });
    expect(shown(".ms-continue"), "and Continue follows, as after an Apply");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));

  const w = await run(`
    const shell = mount(payload({ shape: "modify-delete", missingRole: "theirs" }));
    const btns = $$(".ms-notext-btn").map((b) => b.textContent.trim());
    expect(btns.join("|") === "Accept Yours|Delete the file", "the side with no file reads Delete the file (" + btns.join("|") + ")");
    expect(/deleted in theirs \\(master\\)/.test(text(".ms-notext-desc") || ""), "the note names who deleted it (" + text(".ms-notext-desc") + ")");
    click($$(".ms-notext-btn")[1]);
    expect(JSON.stringify(last()) === JSON.stringify({ type: "takeRole", role: "theirs" }), "and it takes that role (" + JSON.stringify(last()) + ")");
    shell.handle({ type: "init", ...payload({ shape: "both-deleted" }) });
    const dd = $$(".ms-notext-btn").map((b) => b.textContent.trim());
    expect(dd.join("|") === "Delete the file", "a file deleted on both sides offers only the deletion (" + dd.join("|") + ")");
    click(".ms-notext-btn");
    expect(JSON.stringify(last()) === JSON.stringify({ type: "deleteFile" }), "which posts deleteFile");
    shell.handle({ type: "init", ...payload() });
    expect(views === 1 && !shown(".ms-notext") && shown(".jb-toolbar"), "a re-init with text brings the editor back");
    shell.handle({ type: "init", ...payload({ shape: "too-large" }) });
    expect(fake.disposed, "and one without text disposes it");
  `);
  assert.deepEqual(w.fails, [], w.fails.join("\n"));
});

test("render gets the host's auto-apply setting, the legend its slot, and a line-ending mismatch its notice", { skip }, async () => {
  const v = await run(`
    const shell = mount(payload());
    expect(fake.renders[0].init && fake.renders[0].init.autoApplyNonConflicting === false, "auto-apply is OFF unless the host turns it on");
    shell.handle({ type: "init", ...payload({ autoApplyNonConflicting: true }) });
    expect(fake.renders[1].init.autoApplyNonConflicting === true, "and ON when it does");
    expect(views === 1, "a re-init reuses the view");
    expect(fake.legendSlot === $(".ms-legend-slot"), "the legend is handed the shell's slot");
    fake.emitEol({ yours: "CRLF", theirs: "LF", result: "CRLF" });
    expect(text(".ms-note-eol") === "Yours uses CRLF, theirs LF: the result keeps CRLF.", "the EOL notice says it (" + text(".ms-note-eol") + ")");
    fake.emitEol(undefined);
    expect(!$(".ms-note-eol"), "and clears when the sides agree");
    shell.handle({ type: "init", ...payload({ hasBase: false, conflictType: "add-add" }) });
    expect(/Added on both sides/.test(text(".ms-op-note") || ""), "a conflict with no ancestor says so (" + text(".ms-op-note") + ")");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("⌘Z inside the shell drives the merge history once, whichever way it arrives", { skip }, async () => {
  const v = await run(`
    const shell = mount(payload());
    let appUndo = 0;
    // The host's own app-wide undo, listening the way the desktop's does.
    window.addEventListener("keydown", (e) => { if ((e.key === "z" || e.key === "Z") && e.metaKey) appUndo++; });
    const target = $(".fake-view");
    target.focus();
    expect(document.activeElement === target, "focus is inside the merge surface");
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true }));
    expect(fake.count("undo") === 1, "⌘Z undid one merge action (" + fake.count("undo") + ")");
    expect(appUndo === 0, "and never reached the app's own undo");
    shell.undo();
    expect(fake.count("undo") === 1, "the menu's copy of the SAME keypress does not undo a second time");
    await sleep(500);
    shell.undo();
    expect(fake.count("undo") === 2, "a later menu undo is its own (" + fake.count("undo") + ")");
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    expect(fake.count("redo") === 0, "a key right after a menu undo is the same press");
    await sleep(500);
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    expect(fake.count("redo") === 1, "⇧⌘Z redoes (" + fake.count("redo") + ")");
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});
