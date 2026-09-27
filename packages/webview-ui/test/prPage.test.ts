import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { findChrome, runInChrome } from "./headless";

/**
 * A pull request's page (src/pr/prPage.ts), mounted in headless Chrome and
 * fed the states the extension's page host sends (fixtures/prPageFixtures.ts):
 * each situation of the state table painted and asserted — by what the
 * reader sees (words, computed colours, geometry), never by class names
 * alone — and each control driven the way a user drives it: clicks, and keys
 * dispatched on the element that has focus.
 */
const ENTRY = fileURLToPath(new URL("./fixtures/prPageEntry.ts", import.meta.url));
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
    "--vscode-input-background": "#3c3c3c", "--vscode-menu-background": "#252526", "--vscode-textLink-foreground": "#3794ff",
    "--vscode-button-secondaryBackground": "#3a3d41", "--vscode-button-secondaryForeground": "#ffffff",
  };
  for (const [k, v] of Object.entries(DARK)) document.documentElement.style.setProperty(k, v);
  document.body.className = "vscode-dark";
  const { PullRequestPage, pageScenes, detail, FILES } = window.__prp;
  const S = pageScenes();
  const root = document.getElementById("root");
  const posted = [];
  const page = new PullRequestPage(root, { post: (m) => posted.push(JSON.parse(JSON.stringify(m))), preferredMethod: "squash" });
  let seq = 10;
  const show = (s) => page.render({ ...s, seq: ++seq });
  const $ = (sel) => root.querySelector(sel) || document.querySelector(".prp-layer " + sel);
  const $$ = (sel) => [...root.querySelectorAll(sel)];
  const text = (el) => (el ? el.textContent.replace(/\\s+/g, " ").trim() : "");
  /** What a reader hears: the text, without what is hidden from them (an avatar's initial). */
  const said = (el) => {
    if (!el) return "";
    const c = el.cloneNode(true);
    c.querySelectorAll("[aria-hidden=true]").forEach((x) => x.remove());
    return c.textContent.replace(/\\s+/g, " ").trim();
  };
  const colour = (el) => getComputedStyle(el).color;
  const frame = () => new Promise((r) => setTimeout(r, 60));
  const last = (type) => [...posted].reverse().find((m) => m.type === type);
  const key = (name, opts = {}) => {
    const el = document.activeElement;
    el.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...opts }));
  };
  const type = (el, value) => {
    el.focus();
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const GREEN = "rgb(137, 209, 133)", RED = "rgb(241, 76, 76)", PURPLE = "rgb(177, 128, 215)", YELLOW = "rgb(204, 167, 0)";
  const primary = () => $(".prp-actions .gs-btn--primary");
`;

async function check(script: string, opts: { width?: number; height?: number } = {}): Promise<void> {
  const v = await runInChrome(CHROME!, ENTRY, PROLOGUE + script, { width: opts.width ?? 1000, height: opts.height ?? 900 });
  assert.deepEqual(v.fails, [], JSON.stringify(v.notes ?? {}));
}

test("the header, per state: the pill's word and glyph, one primary action, and the status of reviews, checks and merging", { skip }, async () => {
  await check(`
    // Open, blocked: Merge is there, and says why it can't be pressed.
    show(S.open);
    expect(text($(".prp-state")) === "Open" && colour($(".prp-state .codicon")) === GREEN, "Open, green glyph: " + colour($(".prp-state .codicon")));
    expect(colour($(".prp-state-word")) !== GREEN, "the word stays in text ink");
    expect(text(primary()) === "Merge" && primary().disabled, "Merge, off while blocked: " + text(primary()));
    expect(primary().querySelector(".codicon-chevron-down"), "a chevron: it opens a box, as the desktop's Merge opens a menu");
    // The desktop's words, in the desktop's order: Checkout, Approve, Review, and More actions as an icon.
    const acts = $$(".prp-actions > .prp-btn").map((b) => text(b) || b.getAttribute("aria-label"));
    expect(JSON.stringify(acts) === JSON.stringify(["Merge", "Checkout", "Approve", "Review", "More actions"]), "the header: " + acts.join(" | "));
    expect($('[data-act="checkout"] .codicon-git-branch') && $('[data-act="review"] .codicon-comment') && $('[data-act="approve"] .codicon-check'), "the desktop's glyphs");
    // Approve opens the review box with Approve chosen — never a one-click public verdict.
    $('[data-act="approve"]').click();
    expect($(".prp-review") && $('.prp-verdict-input[value="APPROVE"]').checked, "Approve: the review box, Approve chosen");
    expect(!last("submitReview"), "…and nothing sent yet");
    expect($('[data-act="review"] .codicon-chevron-up') && $('[data-act="review"]').getAttribute("aria-expanded") === "true", "Review says its box is open");
    $('[data-act="review"]').click();
    expect(!$(".prp-review"), "and closes it");
    show(S.reviewOwn);
    expect(!$('[data-act="approve"]'), "no Approve on your own pull request");
    expect(/^Merging is blocked\\. Changes were requested, and required checks failed\\.$/.test(primary().title), "…saying why: " + primary().title);
    const rows = $$(".prp-status-row").map((r) => text(r));
    expect(rows[0] === "Changes requested By dana-okafor.", "reviews: " + rows[0]);
    expect(rows[1] === "1 of 7 checks failed Show checks", "checks: " + rows[1]);
    expect(rows[2] === "Merging is blocked Changes were requested, and required checks failed.", "merge: " + rows[2]);
    expect(colour($('[data-key="status-checks"] .prp-status-glyph')) === RED, "a failed check's glyph is red");
    expect(said($(".prp-sub")).startsWith("sam-rivera wants to merge 4 commits into main from stream-diffs"), "who, and from where into where: " + said($(".prp-sub")));
    // Ready: Merge is on.
    show(S.ready);
    expect(!primary().disabled, "ready: Merge on");
    expect(text($('[data-key="status-merge"]')) === "Ready to merge Nothing is blocking it.", "ready: " + text($('[data-key="status-merge"]')));
    expect(text($(".prp-here")) === "Checked out", "the branch checked out here is said in words");
    // Behind and conflicts: the one thing that helps.
    show(S.behind);
    $('[data-act="updateBranch"]').click();
    expect(last("updateBranch"), "Update branch");
    show(S.conflicts);
    expect(text($(".prp-status-fix")) === "Checkout to resolve", "conflicts: " + text($(".prp-status-fix")));
    // Draft: Mark ready is the primary — and not said twice.
    show(S.draft);
    expect(text($(".prp-state")) === "Draft", "Draft");
    expect(text(primary()) === "Mark ready", "draft's primary: " + text(primary()));
    expect(!$(".prp-status-fix"), "the merge box doesn't repeat the header's own button");
    primary().click();
    expect(last("markReady"), "Mark ready posts");
    // Closed: Reopen. Merged: no primary; how it ended, in words.
    show(S.closed);
    expect(text(primary()) === "Reopen pull request" && colour($(".prp-state .codicon")) === RED, "closed: Reopen pull request, red: " + text(primary()));
    expect(text($(".prp-status")).startsWith("Closed without merging"), "closed: " + text($(".prp-status")));
    show(S.merged);
    expect(!primary(), "merged: nothing left to do first");
    expect(colour($(".prp-state .codicon")) === PURPLE, "merged is purple");
    expect(text($(".prp-status")) === "Merged by bobk into main 2 hours ago", "merged: " + text($(".prp-status")));
    expect(!$('[data-act="review"]'), "no review of a merged pull request");
    // A reader sees the state, and no Merge.
    show(S.reader);
    expect(!$('[data-act="merge"]'), "a reader has no Merge");
    expect(/Only people with write access to acme\\/webapp can merge it\\.$/.test(text($('[data-key="status-merge"]'))), "…and is told why");
  `);
});

test("the merge box: only the repository's methods, the preferred first, each saying what it does; Confirm sends the choice", { skip }, async () => {
  await check(`
    show({ ...S.ready, pr: detail({ ...S.ready.pr, repo: { id: "acme/webapp", mergeMethods: ["merge", "squash"], deleteBranchOnMerge: false } }) });
    primary().click();
    await frame();
    const methods = $$(".prp-method-label").map(text);
    expect(JSON.stringify(methods) === JSON.stringify(["Squash and merge", "Create a merge commit"]), "allowed only, preferred first: " + methods);
    expect(text($(".prp-method.is-on .prp-method-what")) === "The 4 commits become one commit on main.", "what squash does: " + text($(".prp-method.is-on .prp-method-what")));
    expect(document.activeElement === $(".prp-method.is-on input"), "the choice has the keyboard");
    const title = $(".prp-merge-title");
    expect(title.value === "Stream large diffs instead of loading them whole (#482)", "squash's title: " + title.value);
    // Another method: its own title and its own button.
    const mergeInput = $('.prp-method-input[value="merge"]');
    mergeInput.click();
    await frame();
    expect($(".prp-merge-title").value === "Merge pull request #482 from acme/stream-diffs", "merge's title: " + $(".prp-merge-title").value);
    expect(text($('[data-act="mergeConfirm"]')) === "Confirm merge", "the button says which, in sentence case as github.com does: " + text($('[data-act="mergeConfirm"]')));
    type($(".prp-merge-title"), "Merge the streaming diffs");
    const del = $(".prp-delete-branch");
    del.click();
    $('[data-act="mergeConfirm"]').click();
    const m = last("merge");
    expect(m && m.method === "merge" && m.title === "Merge the streaming diffs" && m.deleteBranch === true, "sent: " + JSON.stringify(m));
    // A title typed survives a state from the host.
    show({ ...S.ready, pr: detail({ ...S.ready.pr, repo: { id: "acme/webapp", mergeMethods: ["merge", "squash"], deleteBranchOnMerge: false } }) });
    expect($(".prp-merge-title").value === "Merge the streaming diffs", "kept across a paint");
    // Merging…: the box says so; merged: it closes.
    show({ ...S.merging, focus: undefined });
    expect(text($('[data-act="mergeConfirm"]')) === "Merging…" && $('[data-act="mergeConfirm"]').disabled, "Merging…");
    show(S.merged);
    expect(!$(".prp-merge"), "merged: nothing left to merge");
  `);
});

test("the review box: a verdict, a summary and the pending comments; your own pull request takes no approval; Discard asks in the box", { skip }, async () => {
  await check(`
    show(S.reviewBox);
    await frame();
    expect(document.activeElement === $(".prp-review-body"), "the summary has the keyboard");
    expect(text($(".prp-pending-title")) === "3 pending comments will be sent with this review", "pending: " + text($(".prp-pending-title")));
    expect(text($$(".prp-pending-where")[1]) === "src/diff/view.ts:84–88", "a range: " + text($$(".prp-pending-where")[1]));
    expect(text($$(".prp-pending-where")[2]) === "src/diff/legacyLoader.ts:12 (removed lines)", "a removed line says so");
    expect(text($('[data-act="review"]')) === "Review (3 pending)", "the header counts them: " + text($('[data-act="review"]')));
    $$(".prp-pending-row")[1].click();
    const opened = last("openFile");
    expect(opened && opened.path === "src/diff/view.ts" && opened.line === 88 && opened.side === "RIGHT", "a pending comment opens where it is: " + JSON.stringify(opened));
    $('.prp-verdict-input[value="APPROVE"]').click();
    type($(".prp-review-body"), "Ship it");
    key("Enter", { ctrlKey: true });
    const sent = last("submitReview");
    expect(sent && sent.event === "APPROVE" && sent.body === "Ship it", "Ctrl+Enter submits: " + JSON.stringify(sent));
    // Discard: asked in the box, not in the sidebar; Keep Them keeps them.
    $('[data-act="discard"]').click();
    await frame();
    expect(text($(".prp-confirm-text")) === "Discard 3 pending comments? They haven't been sent to GitHub, and this can't be undone.", "asked: " + text($(".prp-confirm-text")));
    expect(document.activeElement === $('[data-act="discardNo"]'), "the safe answer has the keyboard");
    $('[data-act="discardNo"]').click();
    expect(!last("discardReview") && !$(".prp-confirm"), "kept");
    $('[data-act="discard"]').click();
    $('[data-act="discardYes"]').click();
    expect(last("discardReview"), "discarded when asked twice");
    // Sent: the box closes and empties.
    show({ ...S.reviewBox, focus: undefined, sent: { seq: 7, key: "review" }, review: undefined });
    expect(!$(".prp-review"), "closed once sent");
    // Your own pull request: Comment only, and why.
    show({ ...S.reviewOwn, focus: { seq: 50, open: "review" } });
    const approve = $('.prp-verdict-input[value="APPROVE"]');
    expect(approve.disabled, "Approve is off on your own pull request");
    expect(text(approve.closest(".prp-verdict").querySelector(".prp-verdict-hint")) === "GitHub takes no approval of your own pull request", "…and says why");
    expect($('.prp-verdict-input[value="COMMENT"]').checked, "Comment is chosen");
    // Written on an older head: said.
    show({ ...S.reviewStale, focus: { seq: 51, open: "review" } });
    expect(/^Written on 1a2b3c4 — the pull request has moved on to 5d6e7f8\\./.test(text($(".prp-pending .prp-note"))), "stale: " + text($(".prp-pending .prp-note")));
  `);
});

/**
 * A box asked for by the host (the list's Merge…, the palette's Merge and
 * Submit Review) arrives with the page's FIRST state — while the pull
 * request is still loading — and the same focus comes again with the
 * loaded one. The state table, one row each:
 *
 *   asked      | then the pull request is       | the page
 *   merge      | mergeable                      | the merge box, its method has the keyboard
 *   merge      | a draft / blocked / read-only  | no box; the keyboard on the status line that says why
 *   merge      | merged                         | no box; the keyboard on how it ended
 *   merge      | unreadable (a message)         | no box — nor later, once it is read
 *   review     | open                           | the review box, its summary has the keyboard
 *
 * And a box that closes hands the keyboard back: to the button that opened
 * it, or — when that button is off (Merge, while blocked) — the first header
 * control that can be pressed. Never to <body>.
 */
test("a box asked for before the pull request has loaded opens once it has — or the keyboard lands on why not; a closed box hands the keyboard back", { skip }, async () => {
  await check(`
    const asked = (open, seq) => ({ seq, open });
    const where = () => {
      const a = document.activeElement;
      return a === document.body || !a ? "BODY" : a.getAttribute("data-key") || a.getAttribute("data-act") || a.className;
    };
    // Mergeable: the box opens once the pull request is here.
    show({ ...S.loading, focus: asked("merge", 5) });
    await frame();
    expect(!document.querySelector(".prp-method"), "no box over a skeleton");
    show({ ...S.mergeBox, focus: asked("merge", 5) });
    await frame();
    expect(!!document.querySelector(".prp-method"), "loaded: the merge box is open, with its methods");
    expect($('[data-act="merge"]').getAttribute("aria-expanded") === "true", "Merge says its box is open");
    expect(document.activeElement === $(".prp-method.is-on input"), "the chosen method has the keyboard: " + where());
    // …and Escape hands the keyboard to Merge, which opened it.
    key("Escape");
    await frame();
    expect(!$(".prp-merge") && document.activeElement === $('[data-act="merge"]'), "Escape: closed, Merge has the keyboard: " + where());

    // A draft: no box — the keyboard on the line that says why, ringed.
    show({ ...S.loading, focus: asked("merge", 6) });
    show({ ...S.draft, focus: asked("merge", 6) });
    await frame();
    expect(!$(".prp-merge"), "a draft: no merge box");
    const whyDraft = $('[data-key="status-merge"]');
    expect(document.activeElement === whyDraft, "the keyboard is on why: " + where());
    expect(text(whyDraft) === "This pull request is still a draft Mark it ready for review to merge it.", "why, in words: " + text(whyDraft));
    const ring = getComputedStyle(whyDraft);
    expect(ring.outlineStyle === "solid" && ring.outlineColor === "rgb(0, 127, 212)", "ringed in the focus colour: " + ring.outlineStyle + " " + ring.outlineColor);
    // A paint from the host keeps it; the keyboard moving on takes the ring away.
    show({ ...S.draft, focus: asked("merge", 6) });
    await frame();
    expect(document.activeElement === whyDraft && getComputedStyle(whyDraft).outlineStyle === "solid", "kept across a paint");
    $('[data-act="checkout"]').focus();
    expect(getComputedStyle(whyDraft).outlineStyle === "none", "gone once the keyboard moves on: " + getComputedStyle(whyDraft).outlineStyle);

    // Blocked (changes requested, checks failed): the same.
    show({ ...S.loading, focus: asked("merge", 7) });
    show({ ...S.open, focus: asked("merge", 7) });
    await frame();
    expect(!$(".prp-merge") && document.activeElement === $('[data-key="status-merge"]'), "blocked: the keyboard on why: " + where());
    expect(text($('[data-key="status-merge"]')).startsWith("Merging is blocked"), "…which says so");

    // Read-only: no Merge at all, and why.
    show({ ...S.loading, focus: asked("merge", 8) });
    show({ ...S.reader, focus: asked("merge", 8) });
    await frame();
    expect(document.activeElement === $('[data-key="status-merge"]'), "a reader: the keyboard on why: " + where());

    // Merged meanwhile: the keyboard on how it ended.
    show({ ...S.loading, focus: asked("merge", 9) });
    show({ ...S.merged, focus: asked("merge", 9) });
    await frame();
    expect(!$(".prp-merge") && document.activeElement === $('[data-key="status-done"]'), "merged: the keyboard on how it ended: " + where());

    // Unreadable: no box, not even once it is read later.
    show({ ...S.loading, focus: asked("merge", 10) });
    show({ ...S.failed, focus: asked("merge", 10) });
    await frame();
    show({ ...S.mergeBox, focus: asked("merge", 10) });
    await frame();
    expect(!$(".prp-merge"), "a pull request that couldn't be read opens no box when a Retry reads it");

    // Review asked of one that has been merged meanwhile: no box — the keyboard on how it ended.
    show({ ...S.loading, focus: asked("review", 12) });
    show({ ...S.merged, focus: asked("review", 12) });
    await frame();
    expect(!$(".prp-review") && document.activeElement === $('[data-key="status-done"]'), "merged: no review box, the keyboard on how it ended: " + where());
    // Review, asked while loading: the box and its summary.
    show({ ...S.loading, focus: asked("review", 11) });
    show({ ...S.open, focus: asked("review", 11) });
    await frame();
    expect(!!$(".prp-review") && document.activeElement === $(".prp-review-body"), "the review box, its summary has the keyboard: " + where());
  `);
});

test("closing a box hands the keyboard back to the button that opened it — or the first one on, never <body>", { skip }, async () => {
  await check(`
    const where = () => {
      const a = document.activeElement;
      return a === document.body || !a ? "BODY" : a.getAttribute("data-key") || a.getAttribute("data-act") || a.className;
    };
    // Blocked: Merge is off. Review, then Escape from the summary: back on Review.
    show(S.open);
    expect(primary().disabled, "Merge is off (blocked)");
    const review = $('[data-act="review"]');
    review.focus();
    review.click();
    await frame();
    expect(document.activeElement === $(".prp-review-body"), "the summary has the keyboard");
    key("Escape");
    await frame();
    expect(!$(".prp-review"), "closed");
    expect(document.activeElement === $('[data-act="review"]'), "Escape: back on Review, which opened it: " + where());
    // Approve, then Escape: back on Approve.
    $('[data-act="approve"]').click();
    await frame();
    key("Escape");
    await frame();
    expect(document.activeElement === $('[data-act="approve"]'), "back on Approve: " + where());
    // Asked by the host: back on the button that would have opened it.
    show({ ...S.open, focus: { seq: 20, open: "review" } });
    await frame();
    key("Escape");
    await frame();
    expect(document.activeElement === $('[data-act="review"]'), "asked by the host: back on Review: " + where());
    // The merge box open, then merging is blocked from elsewhere: the box
    // closes, and Merge — which opened it — is off: the first control that is on.
    show(S.ready);
    primary().click();
    await frame();
    expect(document.activeElement === $(".prp-method.is-on input"), "the method has the keyboard");
    show(S.open);
    await frame();
    const firstOn = $$(".prp-actions button").find((b) => !b.disabled);
    expect(!$(".prp-merge") && document.activeElement === firstOn, "blocked meanwhile: on " + (firstOn && firstOn.getAttribute("data-act")) + ", got " + where());
    // Discard's question: Escape answers No, and keeps the box — Discard has the keyboard.
    show({ ...S.reviewBox, focus: { seq: 21, open: "review" } });
    await frame();
    $('[data-act="discard"]').click();
    await frame();
    key("Escape");
    await frame();
    expect(!!$(".prp-review") && document.activeElement === $('[data-act="discard"]'), "Escape on the question: back on Discard: " + where());
    // The merge box's Cancel: back on Merge.
    show(S.ready);
    primary().click();
    await frame();
    $('[data-act="closePanel"]').click();
    await frame();
    expect(!$(".prp-merge") && document.activeElement === primary(), "Cancel: back on Merge: " + where());
    // Sent from the host while the summary has the keyboard: back on Review.
    show({ ...S.reviewBox, focus: { seq: 22, open: "review" } });
    await frame();
    expect(document.activeElement === $(".prp-review-body"), "the summary has the keyboard again");
    show({ ...S.reviewBox, focus: { seq: 22, open: "review" }, sent: { seq: 30, key: "review" }, review: undefined });
    await frame();
    expect(!$(".prp-review") && document.activeElement === $('[data-act="review"]'), "sent: back on Review: " + where());
  `);
});

test("the conversation: the body as GitHub draws it, references and people as links, threads under their review — reply and resolve in place", { skip }, async () => {
  await check(`
    show(S.open);
    const md = $(".prp-entry-desc .prp-md");
    expect(md.querySelectorAll("table tr").length === 3, "a table");
    expect(md.querySelectorAll(".md-task-done").length === 2, "a task list");
    expect(!md.querySelector("script, [onclick], [style]"), "nothing that runs or restyles");
    const ref = [...md.querySelectorAll("a.prp-ref")].map((a) => a.textContent + "→" + a.dataset.refRepo);
    expect(JSON.stringify(ref) === JSON.stringify(["#455→acme/webapp", "acme/infra#12→acme/infra"]), "references name their repository: " + ref);
    md.querySelector("a.prp-ref").click();
    const r = last("openRef");
    expect(r && r.repo === "acme/webapp" && r.number === 455, "#455 is THIS repository's: " + JSON.stringify(r));
    md.querySelector("a.prp-mention").click();
    expect(last("openUrl").url === "https://github.com/dana-okafor", "a person's link");
    expect(!md.querySelector("code a"), "nothing is linked inside code");
    // Threads sit under the review they were written in.
    const review = $('[data-key="review-R_1"]');
    expect(review && review.querySelectorAll(".prp-thread").length === 2, "R_1's two threads under it");
    const resolved = $('[data-key="thread-T_2"]');
    expect(!resolved.querySelector(".prp-thread-comment"), "a resolved thread starts folded");
    expect(text(resolved.querySelector(".prp-thread-head")).includes("Outdated") && text(resolved.querySelector(".prp-thread-head")).includes("Resolved by sam-rivera"), "…saying so in words");
    resolved.querySelector('[data-act="toggleThread"]').click();
    expect($('[data-key="thread-T_2"] .prp-thread-comment'), "shown when asked");
    // Reply: the button follows the box; sent, the box empties.
    const box = $('[data-key="reply-T_1"]');
    const send = () => $('[data-key="reply-send-T_1"]');
    expect(send().disabled, "nothing to send yet");
    type(box, "Good catch");
    expect(!send().disabled, "something to send");
    send().click();
    const rep = last("reply");
    expect(rep && rep.threadId === "T_1" && rep.body === "Good catch", "reply sent: " + JSON.stringify(rep));
    expect($('[data-key="reply-T_1"]').value === "", "the box empties");
    // Refused: the host puts it back.
    show({ ...S.open, restore: { seq: 3, key: "reply:T_1", body: "Good catch" } });
    expect($('[data-key="reply-T_1"]').value === "Good catch", "back in its box");
    $('[data-key="resolve-T_1"]').click();
    const res = last("resolve");
    expect(res && res.threadId === "T_1" && res.resolved === true, "Resolve Conversation");
    // A thread's place opens its file there.
    $('[data-key="thread-open-T_1"]').click();
    const of = last("openFile");
    expect(of && of.path === "src/diff/stream.ts" && of.line === 48 && of.side === "RIGHT", "the thread's line: " + JSON.stringify(of));
    // The composer.
    type($(".prp-comment"), "Thanks all");
    key("Enter", { metaKey: true });
    expect(last("comment").body === "Thanks all", "Cmd/Ctrl+Enter posts a comment");
    // The rail: each reviewer and what they said, in words.
    const reviewers = $$(".prp-rail .prp-person.is-reviewer").map((p) => p.getAttribute("aria-label"));
    expect(JSON.stringify(reviewers) === JSON.stringify(["dana-okafor: changes requested", "bobk: approved", "@diff-owners: asked to review"]), "reviewers: " + reviewers);
    expect(colour($(".prp-rail .prp-verdict-tag.tone-failure .codicon")) === RED, "a change request's glyph is red");
  `);
});

test("painted in place: a state from the host touches neither what is typed, where the keyboard is, nor an opened <details>", { skip }, async () => {
  await check(`
    show(S.open);
    const box = $('[data-key="reply-T_1"]');
    type(box, "half a thought");
    const details = $(".prp-entry-desc details");
    details.open = true;
    window.scrollTo(0, 400);
    const y = window.scrollY;
    // A poll's answer: a new comment on the timeline.
    const more = { ...S.open.pr, timeline: [...S.open.pr.timeline, { kind: "comment", id: "IC_new", author: null, body: "New!", createdAt: S.open.pr.updatedAt, url: "" }] };
    show({ ...S.open, pr: more });
    expect($('[data-key="reply-T_1"]') === box, "the same box");
    expect(box.value === "half a thought", "what was typed");
    expect(document.activeElement === box, "the keyboard stays");
    expect($(".prp-entry-desc details") === details && details.open, "the opened <details> stays open");
    expect(window.scrollY === y, "the scroll stays");
    expect(text($('[data-key="entry-IC_new"]')).includes("New!"), "the new comment is there");
    // An older state never paints over a newer one.
    page.render({ ...S.closed, seq: 1 });
    expect(text($(".prp-state")) === "Open", "an older state is ignored");
  `, { height: 700 });
});

test("tabs: a tablist the keyboard moves through; commits expand to their files, checks line up, the files are a tree", { skip }, async () => {
  await check(`
    show(S.open);
    const tabs = $$(".prp-tab").map((t) => t.getAttribute("aria-label"));
    expect(JSON.stringify(tabs) === JSON.stringify(["Conversation, 4", "Commits, 4", "Checks, 7, 1 of 7 checks failed", "Files, 7"]), "tabs: " + tabs);
    expect($('.prp-tab[data-value="files"] .codicon-code') && $('.prp-tab[data-value="commits"] .codicon-git-commit'), "the desktop's tab glyphs");
    $("#prp-tab-conversation").focus();
    key("ArrowRight");
    expect(document.activeElement === $("#prp-tab-commits") && $("#prp-tab-commits").getAttribute("aria-selected") === "true", "ArrowRight: Commits");
    expect(last("tab").tab === "commits", "the host is told");
    // Commits.
    const row = $$(".prp-commit-row")[0];
    row.click();
    expect(last("expandCommit").sha === "1".repeat(40), "a commit's files asked for");
    const asked = posted.filter((m) => m.type === "expandCommit").length;
    show({ ...S.open, commitFiles: { ["1".repeat(40)]: { status: "loaded", files: FILES.slice(0, 3) } } });
    const files = $$(".prp-commit-detail .prp-file-row");
    expect(files.length === 3, "its three files");
    expect(text(files[2].querySelector(".prp-file-name")) === "src/diff/chunks/split.ts ← src/diff/split.ts", "a rename says from where: " + text(files[2].querySelector(".prp-file-name")));
    files[1].click();
    const oc = last("openCommitFile");
    expect(oc && oc.sha === "1".repeat(40) && oc.path === "src/diff/view.ts", "opens as the commit's diff");
    $$(".prp-commit-row")[0].click();
    $$(".prp-commit-row")[0].click();
    expect(posted.filter((m) => m.type === "expandCommit").length === asked, "loaded once: not asked again");
    // A commit whose files couldn't be read: why, and Retry — the word every failed read uses.
    show({ ...S.open, commitFiles: { ["1".repeat(40)]: { status: "failed", error: "GitHub didn't answer." } } });
    const again = $('[data-act="commitRetry"]');
    expect(text(again) === "Retry" && again.title === "Read its files again", "a failed commit's files: " + text(again));
    again.click();
    expect(last("expandCommit").sha === "1".repeat(40) && posted.filter((m) => m.type === "expandCommit").length === asked + 1, "Retry asks again");
    show({ ...S.open, commitFiles: { ["1".repeat(40)]: { status: "loaded", files: FILES.slice(0, 3) } } });
    const shas = $$(".prp-sha").map((s) => Math.round(s.getBoundingClientRect().right));
    expect(new Set(shas).size === 1, "every sha lines up, with or without checks: " + shas);
    // Checks.
    $("#prp-tab-checks").click();
    const names = $$(".prp-check-name").map(text);
    expect(names[0] === "CI / test (windows-latest)" && names[1] === "CI / test (ubuntu-latest)", "failed first, then running: " + names.slice(0, 2));
    expect(text($$(".prp-check-words")[0]) === "Timed out after 30m", "what it says of itself: " + text($$(".prp-check-words")[0]));
    const details = $$(".prp-check-link .prp-ghost").map((b) => Math.round(b.getBoundingClientRect().left));
    expect(new Set(details).size === 1, "Details line up, Required or not: " + details);
    $$(".prp-check-link .prp-ghost")[0].click();
    expect(last("openUrl").url === "https://github.com/acme/webapp/actions/runs/1/job/2", "Details opens its page");
    expect(colour($$(".prp-check-glyph")[0]) === RED && colour($$(".prp-check-glyph")[1]) === YELLOW, "a glyph per result, in its tone");
    // Files.
    $("#prp-tab-files").click();
    const tree = $$(".prp-tree .prp-dir-name, .prp-tree .prp-file-base").map(text);
    expect(JSON.stringify(tree.slice(0, 4)) === JSON.stringify(["src/diff", "chunks", "split.ts", "legacyLoader.ts"]), "folders first, one-child folders as one row: " + tree);
    $('[data-key="f-row-src/diff/view.ts"]').click();
    expect(last("openFile").path === "src/diff/view.ts", "a file opens its diff");
    $('[data-dir="src/diff"]').click();
    expect(!$('[data-key="f-src/diff/view.ts"]'), "a folded folder hides its files");
    expect(text($('[data-key="f-row-test/fixtures/large.bin"] .prp-file-counts')) === "Binary", "a binary says so");
  `);
});

test("pending comments show on their files and on the tab; More Actions offers what applies, from the keyboard", { skip }, async () => {
  await check(`
    show(S.files);
    expect(text($$(".prp-tab")[3]).endsWith("3 pending"), "the tab counts them: " + text($$(".prp-tab")[3]));
    expect(text($('[data-key="f-row-src/diff/view.ts"] .prp-file-badge.is-pending')) === "1 pending", "the file too");
    expect(!$('[data-act="startReview"]'), "a review under way needs no Start");
    show({ ...S.files, review: undefined });
    $('[data-act="startReview"]').click();
    expect(last("startReview"), "Start review");
    // More actions.
    show(S.open);
    $('[data-act="more"]').focus();
    $('[data-act="more"]').click();
    const items = [...document.querySelectorAll(".prp-layer .prp-menu-item")].map(text);
    expect(JSON.stringify(items) === JSON.stringify(["Update branch", "Close pull request", "Copy link"]), "open, as the desktop's: " + items);
    expect(document.querySelectorAll(".prp-layer .prp-menu-sep").length === 2, "a line between the groups");
    expect(document.activeElement.classList.contains("prp-menu-item"), "the first item has the keyboard");
    key("ArrowDown");
    expect(text(document.activeElement) === "Close pull request", "ArrowDown moves");
    key("Escape");
    expect(!document.querySelector(".prp-layer .prp-menu") && document.activeElement === $('[data-act="more"]'), "Escape closes, back to the button");
    $('[data-act="more"]').click();
    document.querySelector('.prp-layer [data-act="close"]').click();
    expect(last("close") && !document.querySelector(".prp-layer .prp-menu"), "Close pull request posts, and the menu closes");
    show(S.merged);
    $('[data-act="more"]').click();
    const done = [...document.querySelectorAll(".prp-layer .prp-menu-item")].map(text);
    expect(JSON.stringify(done) === JSON.stringify(["Copy link"]), "merged: nothing to close, nothing to update: " + done);
  `);
});

test("loading, and a page that failed: what the list knew, a skeleton the same shape, why and the one action — and a narrow tab keeps its words", { skip }, async () => {
  await check(`
    show(S.loading);
    expect(text($(".prp-title-text")) === "Stream large diffs instead of loading them whole", "the list's title while it loads");
    expect($(".prp-skeleton[aria-busy=true]"), "a skeleton");
    expect(getComputedStyle($(".prp-progress-bar")).visibility === "visible", "the progress bar runs");
    show(S.failed);
    expect(text($(".prp-title-text")) === "Stream large diffs instead of loading them whole", "which one failed");
    expect(text($(".prp-message-title")) === "Couldn't reach GitHub", "why");
    $(".prp-message [data-act=action]").click();
    expect(last("action").action.kind === "retry", "Retry");
    show(S.refreshFailed);
    expect(text($(".prp-notice-title")).startsWith("Couldn't close #482"), "a notice above the page");
    // A narrow editor: tabs keep their words (their glyphs go), nothing cut.
    show(S.open);
    const tabs = $$(".prp-tab");
    expect(tabs.every((t) => getComputedStyle(t.querySelector(".codicon")).display === "none"), "no tab glyphs at 480px");
    expect(tabs.every((t) => t.scrollWidth <= t.clientWidth + 1), "no tab word cut");
    show(S.files);
    const bar = $(".prp-tabs");
    expect(bar.scrollWidth <= bar.clientWidth + 1, "the tabs fit, a pending count and all: " + bar.scrollWidth + " > " + bar.clientWidth);
    const pend = $('[data-act="review"]');
    expect(colour(pend) === "rgb(204, 204, 204)", "Review (3 pending) in text ink on its wash: " + colour(pend));
    show(S.open);
    const end = $(".prp-actions-end").getBoundingClientRect();
    const btns = [...$(".prp-actions-end").children].map((b) => Math.round(b.getBoundingClientRect().top));
    expect(new Set(btns).size === 1 && end.width > 50, "Refresh and Open on GitHub stay together");
  `, { width: 480 });
});
