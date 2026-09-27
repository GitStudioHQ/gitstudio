// The pull request feature past the list, end to end in node: the PR page,
// the diff panes and review — registerPrFeature's REAL panel, review
// controller and content provider (prTestKit.ts), against a fake
// api.github.com that answers in GitHub's own shapes and counts what each
// event costs. The list itself is prListView.test.ts.
//
// Each test is one defect from the Pull Requests audit, asserted the way the
// user meets it: what the page shows, what GitHub is sent.

import {
  acmeRoutes,
  dialogs,
  fakeRepos,
  gql,
  github,
  LIST_QUERY,
  mount,
  numbers,
  ORIGIN,
  pr,
  PULLS,
  rowArg,
  sleep,
  until,
  vscode,
} from "./prTestKit";
import { test } from "node:test";
import assert from "node:assert/strict";
import { linkHeader, rawPull } from "./fakeGitHub";

/* eslint-disable @typescript-eslint/no-explicit-any -- the stand-in's objects */
const { GitHubApi } = require("../src/pr/githubApi") as typeof import("../src/pr/githubApi"); // eslint-disable-line @typescript-eslint/no-require-imports

// ── The PR page ────────────────────────────────────────────────────────────

async function openPage(m: any, n: number, over: Record<string, unknown> = {}): Promise<any> {
  const row = await rowArg(m, 37);
  const prObj = { ...row.pr, number: n, ...over };
  await vscode.commands.executeCommand("gitstudio.pr.openDescription", { pr: prObj, ctx: row.ctx });
  return pr.panels.find((p: any) => p.title === `PR #${n}`);
}

test("a merged PR reads Merged, and one closed without merging reads Closed — never the same badge", async () => {
  const MERGED_AT = "2026-09-20T10:00:00Z";
  github([
    ["GET", /^\/repos\/acme\/app\/pulls\/39$/, () => ({ body: rawPull(39, { state: "closed", merged_at: MERGED_AT }) })],
    ["GET", /^\/repos\/acme\/app\/pulls\/38$/, () => ({ body: rawPull(38, { state: "closed", merged_at: null }) })],
    ...acmeRoutes(),
  ]);
  const m = mount(fakeRepos(ORIGIN));
  const merged = await openPage(m, 39, { state: "closed" });
  const closed = await openPage(m, 38, { state: "closed" });
  const badge = (html: string) => /<span id="badge" class="badge badge-(\w+)">[\s\S]*?<span class="badge-word">(\w+)<\/span>/.exec(html)?.slice(1);
  assert.deepEqual(badge(merged.webview.html), ["merged", "Merged"]);
  assert.deepEqual(badge(closed.webview.html), ["closed", "Closed"]);
});

test("the page's label colours survive its own CSP: classes in the nonce'd <style>, no style attributes", async () => {
  github([
    [
      "GET",
      /^\/repos\/acme\/app\/pulls\/37$/,
      () => ({ body: { ...PULLS()[0], labels: [{ name: "bug", color: "d73a4a" }, { name: "enhancement", color: "a2eeef" }] } }),
    ],
    ...acmeRoutes(),
  ]);
  const m = mount(fakeRepos(ORIGIN));
  const page = await openPage(m, 37);
  const html: string = page.webview.html;
  const body = html.slice(html.indexOf("<body>"));
  assert.doesNotMatch(body, /\sstyle="/, "a style attribute can't carry the nonce; the CSP drops it");
  const nonce = /<script nonce="([^"]+)"/.exec(html)![1];
  const styles = [...html.matchAll(/<style nonce="([^"]+)">([\s\S]*?)<\/style>/g)];
  assert.ok(styles.every((s) => s[1] === nonce));
  const css = styles.map((s) => s[2]).join("\n");
  for (const [name, hex] of [["bug", "d73a4a"], ["enhancement", "a2eeef"]]) {
    const cls = new RegExp(`<span class="gs-chip label (label-\\d+)">${name}</span>`).exec(body)?.[1];
    assert.ok(cls, `${name} carries a label class`);
    assert.match(css, new RegExp(`\\.${cls} \\{ --label: #${hex}; \\}`), `${name}'s colour is in the nonce'd style`);
  }
});

test("the page counts the PR's files from GitHub's total, names a rename's old path, and diffs it from there", async () => {
  github([
    ["GET", /^\/repos\/acme\/app\/pulls\/37$/, () => ({ body: { ...PULLS()[0], changed_files: 61, additions: 1840, deletions: 212 } })],
    ...acmeRoutes(),
  ]);
  const m = mount(fakeRepos(ORIGIN));
  const page = await openPage(m, 37);
  const html: string = page.webview.html;
  assert.match(html, /Changed files \(61\)/, "not the count of the files fetched");
  assert.match(html, /Showing 3 of 61 files/);
  assert.match(html, /<span class="ffrom">src\/old\.ts → <\/span>/);
  // A side with no lines isn't drawn: a deleted file's "+0", a new line's red "−0".
  assert.doesNotMatch(html, /[+−]0</, "no zero counts");
  assert.match(html, /data-path="docs\/gone\.md"[\s\S]*?<span class="fstat gs-mono"><span class="del">−3<\/span><\/span>/);
  // A same-repository head reads as its branch, without the owner.
  assert.match(html, /branch--head">[^<]*<i class="codicon codicon-git-branch"[^>]*><\/i>feature-37</);
  page.receive({ type: "openFile", path: "src/new.ts" });
  await until(() => pr.executed.some((e: any) => e.id === "vscode.diff"), "the diff to open");
  const [left, right] = pr.executed.find((e: any) => e.id === "vscode.diff").args;
  assert.equal(left.path, "/src/old.ts", "the base side is the file as it was — under its old name");
  assert.equal(right.path, "/src/new.ts");
});

test("Merge from the page flips it to Merged in place, drops the row, and offers only the methods the repo allows", async () => {
  let merged = false;
  const gh = github([
    ["GET", /^\/repos\/acme\/app$/, () => ({ body: { default_branch: "main", allow_merge_commit: false, allow_squash_merge: true, allow_rebase_merge: true } })],
    [
      "PUT",
      /^\/repos\/acme\/app\/pulls\/37\/merge$/,
      () => {
        merged = true;
        return { body: { merged: true } };
      },
    ],
    [
      "GET",
      /^\/repos\/acme\/app\/pulls\/37$/,
      () => ({ body: merged ? { ...PULLS()[0], state: "closed", merged_at: "2026-09-25T10:00:00Z" } : PULLS()[0] }),
    ],
    ...acmeRoutes(),
  ]);
  const m = mount(fakeRepos(ORIGIN));
  const page = await openPage(m, 37);
  const writes = page.htmlWrites;
  const listLoads = gql(gh, LIST_QUERY).length;
  dialogs.answer = (spec) => (spec.kind === "pick" && /^Merge PR #37/.test(spec.title) ? "squash" : undefined);
  page.receive({ type: "merge" });
  await until(() => page.posted.some((p: any) => p.type === "state"), "the page to be told");
  assert.deepEqual(page.posted[0], { type: "state", kind: "merged" });
  const offered = dialogs.asked.find((s) => /^Merge PR #37/.test(s.title)).choices.map((c: any) => c.id);
  assert.deepEqual(offered.sort(), ["rebase", "squash"], "the repository turned merge commits off");
  await sleep(50);
  assert.equal(page.htmlWrites, writes, "patched, not reloaded");
  assert.deepEqual(numbers(m), [36, 3], "the merged PR left the open list");
  assert.equal(gql(gh, LIST_QUERY).length, listLoads, "…without reloading it");
});

test("a page update still in flight when the merge lands never paints Open over Merged", async () => {
  let merged = false;
  const gh = github([
    ["GET", /^\/repos\/acme\/app$/, () => ({ body: { default_branch: "main" } })],
    [
      "PUT",
      /^\/repos\/acme\/app\/pulls\/37\/merge$/,
      () => {
        merged = true;
        return { body: { merged: true } };
      },
    ],
    [
      "GET",
      /^\/repos\/acme\/app\/pulls\/37$/,
      () => ({ body: merged ? { ...PULLS()[0], state: "closed", merged_at: "2026-09-25T10:00:00Z" } : PULLS()[0] }),
    ],
    ...acmeRoutes(),
  ]);
  const m = mount(fakeRepos(ORIGIN));
  const page = await openPage(m, 37);
  // Refresh; its files (a big PR: page after page) are slow to come.
  const slow = gh.hold(/^\/repos\/acme\/app\/pulls\/37\/files/);
  page.receive({ type: "refresh" });
  await until(() => slow.held() > 0, "the refresh to be in flight");
  dialogs.answer = (spec) => (spec.kind === "pick" && /^Merge PR #37/.test(spec.title) ? "squash" : undefined);
  page.receive({ type: "merge" });
  await until(() => page.posted.some((p: any) => p.type === "state" && p.kind === "merged"), "the page to be told Merged");
  await sleep(50);
  slow.release();
  await sleep(100);
  const html: string = page.webview.html;
  assert.equal(/id="badge" class="badge badge-(\w+)"/.exec(html)?.[1], "merged", "the page still reads Merged");
  assert.match(html, /id="btn-merge"[^>]*disabled/, "and Merge… stays off");
});

test("a PR's files follow GitHub's pages: all 130 are listed, and the 130th takes a review comment", async () => {
  const many = Array.from({ length: 130 }, (_, i) => ({
    filename: `src/f${i}.ts`,
    status: "modified",
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: "@@ -1,1 +1,2 @@\n a\n+b",
  }));
  const path = "/repos/acme/app/pulls/37/files?per_page=100";
  github([
    [
      "GET",
      /^\/repos\/acme\/app\/pulls\/37\/files/,
      (req) => {
        const page = Number(/[?&]page=(\d+)/.exec(req.path)?.[1] ?? 1);
        return { body: many.slice((page - 1) * 100, page * 100), headers: linkHeader(path, page, 2) };
      },
    ],
    ["GET", /^\/repos\/acme\/app\/pulls\/37$/, () => ({ body: { ...PULLS()[0], changed_files: 130 } })],
    ...acmeRoutes(),
  ]);
  const m = mount(fakeRepos(ORIGIN));
  const page = await openPage(m, 37);
  const html: string = page.webview.html;
  assert.match(html, /Changed files \(130\)/);
  assert.doesNotMatch(html, /Showing \d+ of/, "nothing is missing, so nothing says so");
  assert.equal((html.match(/class="filerow"/g) ?? []).length, 130);
  await startReview(m, 37);
  assert.deepEqual(ranges(m, "src/f129.ts", HEAD_37, 5), [[0, 1]], "a file past the first 100 is commentable");
});

test("files that couldn't be loaded are said to be so — not \"Showing 0 of 61\"", async () => {
  github([
    ["GET", /^\/repos\/acme\/app\/pulls\/41\/files/, () => ({ status: 502, body: { message: "Server Error" } })],
    ["GET", /^\/repos\/acme\/app\/pulls\/41$/, () => ({ body: rawPull(41, { changed_files: 61 }) })],
    ...acmeRoutes(),
  ]);
  const m = mount(fakeRepos(ORIGIN));
  const html: string = (await openPage(m, 41)).webview.html;
  assert.match(html, /Couldn't load the changed files\. Server Error/);
  assert.doesNotMatch(html, /Showing 0 of|at most 3,000/, "no limit was hit");
});

// ── The diff panes ─────────────────────────────────────────────────────────

test("a diff pane that can't be loaded says why — only a missing path is an empty pane", async () => {
  github([
    ["GET", /\/contents\/limited\.ts/, () => ({ status: 403, body: { message: "API rate limit exceeded" }, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1900000000" } })],
    ["GET", /\/contents\/gone\.ts/, () => ({ status: 404, body: { message: "Not Found" } })],
    ["GET", /\/contents\/logo\.png/, () => ({ bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]) })],
    ["GET", /\/contents\/ok\.ts/, () => ({ bytes: new TextEncoder().encode("export const ok = 1;\n") })],
    ...acmeRoutes(),
  ]);
  mount(fakeRepos(ORIGIN));
  const provider = pr.providers.get("gitstudio-pr");
  const uri = (p: string) => vscode.Uri.from({ scheme: "gitstudio-pr", path: `/${p}`, query: "owner=acme&repo=app&sha=abc1234" });
  const token = new vscode.CancellationTokenSource().token;
  await assert.rejects(provider.provideTextDocumentContent(uri("limited.ts"), token), /rate limit/i);
  assert.equal(await provider.provideTextDocumentContent(uri("gone.ts"), token), "");
  assert.match(await provider.provideTextDocumentContent(uri("logo.png"), token), /^Binary file \(8 bytes\) at abc1234/);
  assert.equal(await provider.provideTextDocumentContent(uri("ok.ts"), token), "export const ok = 1;\n");
});

// ── Review ─────────────────────────────────────────────────────────────────

const HEAD_37 = "037head";
const prUri = (path: string, sha: string) =>
  vscode.Uri.from({ scheme: "gitstudio-pr", path: `/${path}`, query: `owner=acme&repo=app&sha=${sha}` });
const ranges = (m: any, path: string, sha: string, lineCount: number) =>
  (m.controller.commentingRangeProvider.provideCommentingRanges({ uri: prUri(path, sha), lineCount }) ?? undefined)?.map(
    (r: any) => [r.start.line, r.end.line],
  );

async function startReview(m: any, n: number): Promise<void> {
  await vscode.commands.executeCommand("gitstudio.pr.startReview", await rowArg(m, n));
}

test("review: only lines inside the diff's hunks take a comment — the head's, and the base's for removed lines", async () => {
  github(acmeRoutes());
  const m = mount(fakeRepos(ORIGIN));
  await startReview(m, 37);
  assert.deepEqual(ranges(m, "src/a.ts", HEAD_37, 120), [[0, 3], [40, 41]], "the head side: its two hunks, not every line");
  assert.deepEqual(ranges(m, "src/a.ts", "basesha", 120), [[0, 2], [39, 43]], "the base side: the lines being removed");
  assert.deepEqual(ranges(m, "docs/gone.md", "basesha", 3), [[0, 2]], "a deleted file is commented on its LEFT side");
  assert.deepEqual(ranges(m, "docs/gone.md", HEAD_37, 0), [], "…and has no right side to comment on");
  assert.deepEqual(ranges(m, "src/old.ts", "basesha", 2), [[0, 1]], "a rename's base side is its old path");
  const opened = pr.executed.filter((e: any) => e.id === "vscode.diff");
  assert.equal(opened.length, 1, "one diff opens: a preview replaced by the next left only the last of five");
});

test("review: Delete on a pending comment deletes that comment", async () => {
  github(acmeRoutes());
  const m = mount(fakeRepos(ORIGIN));
  await startReview(m, 37);
  const thread = vscode.__makeThread(prUri("src/a.ts", HEAD_37), new vscode.Range(40, 0, 40, 0));
  await vscode.commands.executeCommand("gitstudio.pr.addReviewComment", { thread, text: "first" });
  await vscode.commands.executeCommand("gitstudio.pr.addReviewComment", { thread, text: "second" });
  assert.equal(thread.comments.length, 2);
  // VS Code hands a comment/title action the COMMENT itself.
  await vscode.commands.executeCommand("gitstudio.pr.deleteReviewComment", thread.comments[0]);
  assert.deepEqual(thread.comments.map((c: any) => c.body.value), ["second"], "that comment, not its thread");
  assert.equal(thread.disposed, false);
  await vscode.commands.executeCommand("gitstudio.pr.deleteReviewComment", thread.comments[0]);
  assert.equal(thread.disposed, true, "the thread goes with its last comment");
});

test("review: \"pending\" counts pending comments — a posted one is neither counted nor discarded", async () => {
  github([["POST", /\/reviews$/, () => ({ body: { id: 1 } })], ...acmeRoutes()]);
  const m = mount(fakeRepos(ORIGIN));
  await startReview(m, 37);
  const thread = vscode.__makeThread(prUri("src/a.ts", HEAD_37), new vscode.Range(1, 0, 1, 0));
  await vscode.commands.executeCommand("gitstudio.pr.addSingleComment", { thread, text: "posted now" });
  await until(() => thread.comments.length === 1, "the single comment to post");
  await vscode.commands.executeCommand("gitstudio.pr.addReviewComment", { thread, text: "pending" });
  await vscode.commands.executeCommand("gitstudio.pr.deleteReviewComment", thread.comments.find((c: any) => c.body.value === "pending"));
  await vscode.commands.executeCommand("gitstudio.pr.cancelReview");
  assert.deepEqual(dialogs.asked.map((a) => a.title), [], "nothing is pending, so nothing to discard");
  assert.equal(thread.disposed, false, "the posted comment stays in the editor");
  assert.deepEqual(thread.comments.map((c: any) => c.body.value), ["posted now"]);

  // Two pending replies on one line are two pending comments.
  await startReview(m, 37);
  const two = vscode.__makeThread(prUri("src/a.ts", HEAD_37), new vscode.Range(2, 0, 2, 0));
  await vscode.commands.executeCommand("gitstudio.pr.addReviewComment", { thread: two, text: "one" });
  await vscode.commands.executeCommand("gitstudio.pr.addReviewComment", { thread: two, text: "two" });
  await vscode.commands.executeCommand("gitstudio.pr.cancelReview");
  assert.match(dialogs.asked.at(-1)?.title ?? "", /^Discard 2 pending comments on #37\?$/);

  // Discarding keeps what is already on GitHub.
  await vscode.commands.executeCommand("gitstudio.pr.addSingleComment", { thread: two, text: "posted too" });
  await until(() => two.comments.length === 3, "the single comment to post");
  dialogs.answer = (spec) => (spec.kind === "confirm" ? "ok" : undefined);
  await vscode.commands.executeCommand("gitstudio.pr.cancelReview");
  assert.equal(two.disposed, false);
  assert.deepEqual(two.comments.map((c: any) => c.body.value), ["posted too"], "the pending ones go, the posted one stays");
});

test("review: the submitted review is pinned to the head the diffs showed, with multi-line and LEFT comments as GitHub names them", async () => {
  let sent: any;
  github([
    [
      "POST",
      /^\/repos\/acme\/app\/pulls\/37\/reviews$/,
      (req) => {
        sent = req.body;
        return { body: { id: 1 } };
      },
    ],
    ...acmeRoutes(),
  ]);
  const m = mount(fakeRepos(ORIGIN));
  await startReview(m, 37);
  const multi = vscode.__makeThread(prUri("src/a.ts", HEAD_37), new vscode.Range(1, 0, 3, 0));
  const removed = vscode.__makeThread(prUri("docs/gone.md", "basesha"), new vscode.Range(1, 0, 1, 0));
  await vscode.commands.executeCommand("gitstudio.pr.addReviewComment", { thread: multi, text: "these lines" });
  await vscode.commands.executeCommand("gitstudio.pr.addReviewComment", { thread: removed, text: "why remove this?" });
  dialogs.answer = (spec) => (spec.kind === "pick" ? "COMMENT" : spec.kind === "input" ? "Looks close." : undefined);
  await vscode.commands.executeCommand("gitstudio.pr.submitReview");
  assert.ok(sent, "the review was posted");
  assert.equal(sent.commit_id, HEAD_37, "a push during the review must not move the comments");
  assert.deepEqual(sent.comments, [
    { path: "src/a.ts", line: 4, side: "RIGHT", start_line: 2, start_side: "RIGHT", body: "these lines" },
    { path: "docs/gone.md", line: 2, side: "LEFT", body: "why remove this?" },
  ]);
  assert.equal(sent.body, "Looks close.");
});

test("review: the left side is the MERGE BASE — the file GitHub's hunks count its lines in — not the base branch's tip", async () => {
  // main moved on since #37 branched: GitHub's patch (a three-dot diff) counts
  // its left lines in the merge base, which is not base.sha any more.
  let sent: any;
  const gh = github([
    ["GET", /^\/repos\/acme\/app\/compare\/basesha\.\.\.037head/, () => ({ body: { merge_base_commit: { sha: "mergebase" } } })],
    [
      "POST",
      /^\/repos\/acme\/app\/pulls\/37\/reviews$/,
      (req) => {
        sent = req.body;
        return { body: { id: 1 } };
      },
    ],
    ...acmeRoutes(),
  ]);
  const m = mount(fakeRepos(ORIGIN));

  // The page, outside a review: its diffs are drawn from the merge base too.
  const page = await openPage(m, 37);
  page.receive({ type: "openFile", path: "src/new.ts" });
  await until(() => pr.executed.some((e: any) => e.id === "vscode.diff"), "the page's diff to open");
  const [pageLeft] = pr.executed.find((e: any) => e.id === "vscode.diff").args;
  assert.match(pageLeft.query, /sha=mergebase/, "the page's diff: base side at the merge base");
  assert.equal(pageLeft.path, "/src/old.ts");

  pr.executed.length = 0;
  await startReview(m, 37);
  const [left] = pr.executed.find((e: any) => e.id === "vscode.diff").args;
  assert.match(left.query, /sha=mergebase/, "the review's diff: base side at the merge base");
  assert.deepEqual(ranges(m, "src/a.ts", "mergebase", 120), [[0, 2], [39, 43]], "the removed lines, where they are in that file");
  assert.equal(ranges(m, "src/a.ts", "basesha", 120), undefined, "the base branch's tip is not the diff's left side");
  const removed = vscode.__makeThread(prUri("docs/gone.md", "mergebase"), new vscode.Range(1, 0, 1, 0));
  await vscode.commands.executeCommand("gitstudio.pr.addReviewComment", { thread: removed, text: "why?" });
  dialogs.answer = (spec) => (spec.kind === "pick" ? "COMMENT" : spec.kind === "input" ? "" : undefined);
  await vscode.commands.executeCommand("gitstudio.pr.submitReview");
  assert.deepEqual(sent?.comments, [{ path: "docs/gone.md", line: 2, side: "LEFT", body: "why?" }]);
  assert.equal(gh.count(/\/compare\//), 2, "dialogs.asked once for the page, once for the review");
});

test("review: a row loaded before a push reviews the PR's head NOW — the diffs, the hunks and commit_id agree", async () => {
  // The list was read at 037head; the contributor has pushed since. The files
  // GitHub lists (and their hunks) are the new head's.
  const NEW_HEAD = "037new";
  let sent: any;
  github([
    ["GET", /^\/repos\/acme\/app\/pulls\/37$/, () => ({ body: { ...PULLS()[0], head: { ...(PULLS()[0].head as object), sha: NEW_HEAD } } })],
    [
      "POST",
      /^\/repos\/acme\/app\/pulls\/37\/reviews$/,
      (req) => {
        sent = req.body;
        return { body: { id: 1 } };
      },
    ],
    ...acmeRoutes(),
  ]);
  const m = mount(fakeRepos(ORIGIN));
  assert.equal((await rowArg(m, 37)).pr.head.sha, HEAD_37, "the row is the old head");
  await startReview(m, 37);
  const [, right] = pr.executed.find((e: any) => e.id === "vscode.diff").args;
  assert.match(right.query, /sha=037new/, "the diff shows the code the hunks describe");
  assert.deepEqual(ranges(m, "src/a.ts", NEW_HEAD, 120), [[0, 3], [40, 41]]);
  assert.equal(ranges(m, "src/a.ts", HEAD_37, 120), undefined, "the old head isn't this review's");
  const thread = vscode.__makeThread(prUri("src/a.ts", NEW_HEAD), new vscode.Range(1, 0, 1, 0));
  await vscode.commands.executeCommand("gitstudio.pr.addReviewComment", { thread, text: "hm" });
  dialogs.answer = (spec) => (spec.kind === "pick" ? "COMMENT" : spec.kind === "input" ? "" : undefined);
  await vscode.commands.executeCommand("gitstudio.pr.submitReview");
  assert.equal(sent?.commit_id, NEW_HEAD, "pinned to the commit the diffs showed");
});

test("review: a page loaded before a push opens its files as the review sees them — each one takes comments", async () => {
  const NEW_HEAD = "037new";
  let pushed = false;
  github([
    [
      "GET",
      /^\/repos\/acme\/app\/pulls\/37$/,
      () => ({ body: pushed ? { ...PULLS()[0], head: { ...(PULLS()[0].head as object), sha: NEW_HEAD } } : PULLS()[0] }),
    ],
    ...acmeRoutes(),
  ]);
  const m = mount(fakeRepos(ORIGIN));
  const page = await openPage(m, 37);
  assert.match(page.webview.html, /src\/new\.ts/, "the page has its files");
  pushed = true; // the contributor pushes; the page still shows 037head
  page.receive({ type: "startReview" });
  await until(() => pr.contexts["gitstudio.pr.reviewing"] === true, "the review to start");
  pr.executed.length = 0;
  // As the review's own toast says: "Open other files from the PR's page."
  for (const path of ["src/a.ts", "src/new.ts"]) {
    pr.executed.length = 0;
    page.receive({ type: "openFile", path });
    await until(() => pr.executed.some((e: any) => e.id === "vscode.diff"), `${path} to open`);
    const [, right] = pr.executed.find((e: any) => e.id === "vscode.diff").args;
    assert.match(right.query, /sha=037new/, `${path} opens at the head under review`);
    const r = m.controller.commentingRangeProvider.provideCommentingRanges({ uri: right, lineCount: 120 });
    assert.ok(r && r.length > 0, `${path}, opened from the page during the review, takes comments`);
  }
});

test("review: queued comments are never thrown away without asking — keyed to their PR", async () => {
  github([["GET", /^\/repos\/acme\/app\/pulls\/36\/files/, () => ({ status: 502, body: { message: "Bad Gateway" } })], ...acmeRoutes()]);
  const m = mount(fakeRepos(ORIGIN));
  await startReview(m, 37);
  const thread = vscode.__makeThread(prUri("src/a.ts", HEAD_37), new vscode.Range(1, 0, 1, 0));
  await vscode.commands.executeCommand("gitstudio.pr.addReviewComment", { thread, text: "keep me" });

  // Another PR whose files can't load: nothing of #37's review is touched.
  await startReview(m, 36);
  assert.equal(thread.disposed, false, "a failed load leaves the queue alone");

  // Another PR: dialogs.asked — and "keep" keeps #37's review.
  dialogs.answer = (spec) => (spec.kind === "pick" && /^Discard 1 pending comment on #37\?$/.test(spec.title) ? "keep" : undefined);
  await startReview(m, 3);
  assert.equal(dialogs.asked.length, 1, "dialogs.asked before discarding");
  assert.equal(thread.disposed, false);
  assert.deepEqual(ranges(m, "src/a.ts", HEAD_37, 120), [[0, 3], [40, 41]], "still reviewing #37");

  // The same PR again: its queue stays, nothing dialogs.asked.
  dialogs.asked = [];
  await startReview(m, 37);
  assert.equal(dialogs.asked.length, 0);
  assert.equal(thread.disposed, false);

  // Cancel Review asks too; dismissing it keeps them.
  await vscode.commands.executeCommand("gitstudio.pr.cancelReview");
  assert.match(dialogs.asked.at(-1).title, /^Discard 1 pending comment on #37\?$/);
  assert.equal(thread.disposed, false);

  // Discard is an answer, not a default.
  dialogs.answer = (spec) => (spec.kind === "pick" ? "discard" : undefined);
  await startReview(m, 3);
  assert.equal(thread.disposed, true);
});

test("a 422 says what GitHub refused, not just \"Unprocessable Entity\"", async () => {
  github([
    [
      "POST",
      /\/reviews$/,
      () => ({
        status: 422,
        body: { message: "Unprocessable Entity", errors: ["Pull request review thread line must be part of the diff"] },
      }),
    ],
  ]);
  const api = new GitHubApi({ getToken: async () => "tok" });
  await assert.rejects(
    api.submitReview("acme", "app", 37, { event: "COMMENT", body: "", comments: [{ path: "a.ts", line: 9, side: "RIGHT", body: "x" }] } as never),
    /line must be part of the diff/,
  );
});
