// ReviewController (src/pr/reviewMode.ts), driven directly through the
// vscode stand-in's Comments API: threads VS Code would create, replies it
// would hand over, the commenting ranges it would ask for — with the REAL
// GitHubApi against the fake api.github.com, and a GraphQL function per test.
// prFeature.test.ts covers a review end to end from the page; this file
// covers the editor's side of it: Delete, Discard, a single comment, GitHub's
// threads (LEFT side, avatars, gone ones, a refused reply or Resolve), a
// comment GitHub would refuse, and a review kept across a reload.

import { github, memento, pr, vscode } from "./prTestKit";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Route } from "./fakeGitHub";

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports -- the stand-in's objects, loaded after it */
const { ReviewController, PENDING_REVIEWS_KEY } = require("../src/pr/reviewMode") as typeof import("../src/pr/reviewMode");
const { GitHubApi, GitHubApiError } = require("../src/pr/githubApi") as typeof import("../src/pr/githubApi");
const { prBaseUri, prHeadUri } = require("../src/pr/reviewDiff") as typeof import("../src/pr/reviewDiff");
/* eslint-enable @typescript-eslint/no-require-imports */

const REF = { owner: "acme", repo: "app" };
const KEY = "acme/app#37";
const HEAD = "037head";
const BASE = "mergebase";
const FILES = [
  { filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@ -1,3 +1,4 @@\n one\n+new\n two\n three" },
  { filename: "src/new.ts", previousFilename: "src/old.ts", status: "renamed", additions: 1, deletions: 1, changes: 2, patch: "@@ -1,2 +1,2 @@\n-x\n+y\n z" },
];
const KNOWN = { ...REF, number: 37, title: "Drop Commit", headSha: HEAD, baseSha: BASE, files: FILES };

function controller(opts: { routes?: Route[]; graphql?: (q: string, v: any) => Promise<any>; memory?: any } = {}) {
  github(opts.routes ?? []);
  const api = new GitHubApi({ getToken: async () => "tok" });
  const auth: any = { accountLabel: () => "me" };
  const r = new ReviewController(auth, api, (opts.graphql ?? (async () => ({ data: {} }))) as any, opts.memory);
  const c = pr.controllers.at(-1);
  return { r, c };
}

/** A thread VS Code made where the user clicked, lines `from`..`to` (1-based), on the head (or base) pane. */
function newThread(path: string, from: number, to = from, side: "RIGHT" | "LEFT" = "RIGHT") {
  const uri = side === "RIGHT" ? prHeadUri(REF, { number: 37, headSha: HEAD }, path) : prBaseUri(REF, { number: 37 }, path, BASE);
  return vscode.__makeThread(uri, new vscode.Range(from - 1, 0, to - 1, 0), []);
}
const bodies = (t: any) => t.comments.map((c: any) => (typeof c.body === "string" ? c.body : c.body.value));

// ── Which review a thread is ────────────────────────────────────────────────

test("a first comment starts the review; its thread, and any thread on its diffs, name it", () => {
  const { r } = controller();
  r.know(KNOWN);
  assert.equal(r.isReviewing(), false);
  const t = newThread("src/a.ts", 2);
  r.addComment({ thread: t, text: "Why new?" } as any);
  assert.equal(r.isReviewing(), true);
  assert.equal(r.keyOfThread(t), KEY);
  assert.equal(t.label, "Pending review comment");
  assert.deepEqual(bodies(t), ["Why new?"]);
  // A thread VS Code has on the same diff, not (yet) a pending one.
  assert.equal(r.keyOfThread(newThread("src/a.ts", 3)), KEY);
  // A thread on a document that isn't a pull request's.
  assert.equal(r.keyOfThread(vscode.__makeThread(vscode.Uri.file("/tmp/x.ts"), new vscode.Range(0, 0, 0, 0), [])), undefined);
  assert.deepEqual(r.reviewInfo(KEY), { owner: "acme", repo: "app", number: 37, title: "Drop Commit" });
  assert.equal(pr.statusBars.at(-1).text, "$(comment-discussion) Reviewing #37 · 1 pending");
  r.dispose();
});

// ── Delete ──────────────────────────────────────────────────────────────────

test("Delete of the last pending comment beside a posted one: the thread stays, as posted, and leaves the queue", async () => {
  const sent: any[] = [];
  const { r } = controller({ routes: [["POST", /pulls\/37\/reviews$/, (req) => (sent.push(req.body), { body: { id: 1 } })]] });
  r.know(KNOWN);
  const t = newThread("src/a.ts", 2);
  r.addComment({ thread: t, text: "pending one" } as any);
  await r.addSingleComment({ thread: t, text: "sent at once" } as any);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].comments, [{ path: "src/a.ts", line: 2, side: "RIGHT", body: "sent at once" }]);
  assert.equal(sent[0].event, "COMMENT");
  assert.equal(r.pendingCount(KEY), 1, "the posted one is not pending");
  assert.ok(pr.said.some((s: any) => s.message === "Comment posted to GitHub."));

  r.deleteComment(t.comments[0]);
  assert.deepEqual(bodies(t), ["sent at once"]);
  assert.equal(t.label, "Comment posted");
  assert.equal(t.contextValue, undefined);
  assert.equal(t.disposed, false);
  assert.equal(r.pendingCount(), 0);
  assert.equal(r.isReviewing(), false, "a review with nothing left and never started is gone");
  r.dispose();
});

test("Delete handed a whole thread throws that thread away, and its comments with it", () => {
  const { r } = controller();
  r.know(KNOWN);
  const a = newThread("src/a.ts", 2);
  const b = newThread("src/a.ts", 3);
  r.addComment({ thread: a, text: "one" } as any);
  r.addComment({ thread: b, text: "two" } as any);
  assert.equal(r.pendingCount(KEY), 2);
  r.deleteComment(a);
  assert.equal(a.disposed, true);
  assert.equal(r.pendingCount(KEY), 1);
  assert.deepEqual(r.pendingFor(KEY)!.comments.map((c) => c.body), ["two"]);
  r.deleteComment({ not: "a thread" });
  assert.equal(r.pendingCount(KEY), 1, "anything else is ignored");
  r.dispose();
});

// ── Submit and Discard ──────────────────────────────────────────────────────

test("a comment outside the diff's hunks fails the submit before GitHub is asked, naming it", async () => {
  const { r } = controller({ routes: [["POST", /reviews$/, () => assert.fail("GitHub must not be asked")]] });
  r.know(KNOWN);
  r.addComment({ thread: newThread("src/a.ts", 30), text: "far away" } as any);
  r.addComment({ thread: newThread("src/a.ts", 2), text: "fine" } as any);
  const out = await r.submit(KEY, "COMMENT", "", { ...REF, number: 37, headSha: HEAD });
  assert.equal(out.ok, false);
  assert.equal(
    (out as any).message,
    "GitHub takes review comments only on lines that are part of the diff, and src/a.ts:30 isn't. Delete that comment or move it onto a changed line.",
  );
  assert.equal(r.pendingCount(KEY), 2, "nothing cleared");
  r.dispose();
});

test("two comments outside the hunks are both named, in the plural", async () => {
  const { r } = controller();
  r.know(KNOWN);
  r.addComment({ thread: newThread("src/a.ts", 20, 22), text: "a" } as any);
  r.addComment({ thread: newThread("src/a.ts", 30), text: "b" } as any);
  const out: any = await r.submit(KEY, "APPROVE", "", { ...REF, number: 37, headSha: HEAD });
  assert.match(out.message, /and src\/a\.ts:20-22, src\/a\.ts:30 aren't\. Delete those comments or move them onto a changed line\./);
  r.dispose();
});

test("Discard throws away a thread that has only pending comments, and keeps what GitHub already has", async () => {
  const { r } = controller({ routes: [["POST", /reviews$/, () => ({ body: { id: 1 } })]] });
  r.know(KNOWN);
  const onlyPending = newThread("src/a.ts", 2);
  const mixed = newThread("src/a.ts", 3);
  r.addComment({ thread: onlyPending, text: "pending" } as any);
  r.addComment({ thread: mixed, text: "pending too" } as any);
  await r.addSingleComment({ thread: mixed, text: "posted" } as any);
  const changes: string[] = [];
  r.onDidChange((k: string) => changes.push(k));
  r.discard(KEY);
  assert.equal(onlyPending.disposed, true);
  assert.equal(mixed.disposed, false);
  assert.deepEqual(bodies(mixed), ["posted"]);
  assert.equal(mixed.label, "Comment posted");
  assert.equal(r.isReviewing(), false);
  assert.deepEqual(changes, [KEY]);
  r.discard(KEY); // nothing to discard: nothing happens
  assert.deepEqual(changes, [KEY]);
  r.dispose();
});

test("a single comment GitHub refuses says why, and nothing is added to the thread", async () => {
  const { r } = controller({ routes: [["POST", /reviews$/, () => ({ status: 422, body: { message: "Validation Failed", errors: ["pull_request_review_thread.line must be part of the diff"] } })]] });
  r.know(KNOWN);
  const t = newThread("src/a.ts", 2);
  await r.addSingleComment({ thread: t, text: "hi" } as any);
  assert.deepEqual(bodies(t), []);
  assert.deepEqual(
    pr.said.filter((s: any) => s.kind === "warning").map((s: any) => s.message),
    ["Validation Failed: pull_request_review_thread.line must be part of the diff"],
  );
  // A thread on nothing the controller knows is not sent at all.
  await r.addSingleComment({ thread: vscode.__makeThread(vscode.Uri.file("/x"), new vscode.Range(0, 0, 0, 0), []), text: "x" } as any);
  assert.equal(pr.said.filter((s: any) => s.kind === "warning").length, 1);
  r.dispose();
});

// ── Opening a file ──────────────────────────────────────────────────────────

test("a file no longer in the diff opens as the head has it, at the thread's line — with no line, nothing opens", async () => {
  const { r } = controller();
  r.know(KNOWN);
  assert.equal(await r.openFile(KEY, "src/moved.ts"), false);
  assert.equal(await r.openFile(KEY, "src/moved.ts", { line: 5 }), true);
  const shown = pr.shown.at(-1);
  assert.equal(String(shown.uri), String(prHeadUri(REF, { number: 37, headSha: HEAD }, "src/moved.ts")));
  assert.equal(shown.options.selection.start.line, 4);
  assert.equal(await r.openFile("acme/app#99", "x"), false, "a pull request nobody read");
  r.dispose();
});

// ── GitHub's threads ────────────────────────────────────────────────────────

function ghThread(over: Record<string, unknown> = {}): any {
  return {
    id: "T_1",
    path: "src/a.ts",
    line: 2,
    startLine: null,
    originalLine: 2,
    side: "RIGHT",
    resolved: false,
    outdated: false,
    canResolve: true,
    canUnresolve: false,
    canReply: true,
    comments: [{ id: "C_1", author: { login: "dana", avatarUrl: "https://avatars.githubusercontent.com/u/1" }, body: "Why?", createdAt: "t", url: "u" }],
    totalComments: 1,
    ...over,
  };
}

test("GitHub's threads are drawn where they sit: a LEFT one on the base under a rename's OLD name, avatars only from GitHub", () => {
  const { r, c } = controller();
  r.know(KNOWN);
  r.showThreads(KEY, [
    ghThread(),
    ghThread({ id: "T_L", path: "src/new.ts", side: "LEFT", line: 1, comments: [{ id: "C_2", author: { login: "eve", avatarUrl: "https://evil.example/a.png" }, body: "x", createdAt: "t", url: "u" }] }),
    ghThread({ id: "T_out", outdated: true }),
    ghThread({ id: "T_null", line: null }),
  ]);
  assert.equal(c.threads.length, 2, "outdated and line-less threads have no place on the diff");
  const [right, left] = c.threads;
  assert.equal(String(left.uri), String(prBaseUri(REF, { number: 37 }, "src/old.ts", BASE)));
  assert.equal(String(right.uri), String(prHeadUri(REF, { number: 37, headSha: HEAD }, "src/a.ts")));
  assert.equal(String(right.comments[0].author.iconPath), "https://avatars.githubusercontent.com/u/1");
  assert.equal(left.comments[0].author.iconPath, undefined);
  assert.equal(r.threadIdOf(left), "T_L");

  // Read again without T_L: its thread goes; T_1, resolved now, is repainted in place.
  r.showThreads(KEY, [ghThread({ resolved: true, resolvedBy: "dana" })]);
  assert.equal(left.disposed, true);
  assert.equal(r.threadIdOf(left), undefined);
  assert.equal(right.disposed, false);
  assert.equal(right.label, "Resolved by dana");
  assert.equal(c.threads.length, 2, "no new thread for T_1");
  r.dispose();
});

test("threads of a pull request no page has read are not drawn", () => {
  const { r, c } = controller();
  r.showThreads(KEY, [ghThread()]);
  assert.equal(c.threads.length, 0);
  r.dispose();
});

test("a reply or Resolve from the editor that GitHub refuses says why; the thread is left as it was", async () => {
  const refused = new GitHubApiError("Resource not accessible by integration", "auth", 403);
  const asked: string[] = [];
  const { r, c } = controller({
    graphql: async (q: string) => {
      asked.push(q);
      throw refused;
    },
  });
  r.know(KNOWN);
  r.showThreads(KEY, [ghThread()]);
  const t = c.threads[0];
  await r.replyFromEditor({ thread: t, text: "  " } as any);
  assert.equal(asked.length, 0, "an empty reply isn't sent");
  await r.replyFromEditor({ thread: t, text: "Because." } as any);
  await r.resolveFromEditor(t, true);
  await r.resolveFromEditor(undefined, true);
  assert.equal(asked.length, 2);
  assert.deepEqual(
    pr.said.filter((s: any) => s.kind === "warning").map((s: any) => s.message),
    ["Resource not accessible by integration", "Resource not accessible by integration"],
  );
  assert.deepEqual(bodies(t), ["Why?"]);
  assert.equal(t.contextValue, "gitstudio.prThread.open");
  r.dispose();
});

test("a Resolve from the editor that fails for another reason says so in its own words", async () => {
  const { r, c } = controller({
    graphql: async () => {
      throw new Error("socket hang up");
    },
  });
  r.know(KNOWN);
  r.showThreads(KEY, [ghThread({ resolved: true, canResolve: false, canUnresolve: true })]);
  await r.resolveFromEditor(c.threads[0], false);
  await r.replyFromEditor({ thread: c.threads[0], text: "hm" } as any);
  assert.deepEqual(
    pr.said.filter((s: any) => s.kind === "warning").map((s: any) => s.message),
    ["Couldn't unresolve the conversation.", "Couldn't post the reply."],
  );
  r.dispose();
});

// ── Kept across a reload ────────────────────────────────────────────────────

function stored(over: Record<string, unknown> = {}) {
  return {
    [`${KEY}@${HEAD}`]: {
      owner: "acme",
      repo: "app",
      number: 37,
      title: "Drop Commit",
      headSha: HEAD,
      baseSha: BASE,
      started: true,
      comments: [
        { path: "src/a.ts", line: 3, startLine: 2, side: "RIGHT", body: "range" },
        { path: "src/new.ts", line: 1, side: "LEFT", body: "old x" },
        { path: 7, line: 1, body: "not a comment" },
      ],
      patches: { "src/a.ts": FILES[0].patch, "src/new.ts": FILES[1].patch },
      renames: { "src/new.ts": "src/old.ts" },
      ...over,
    },
    garbage: { owner: 1 },
  };
}

test("a kept review comes back after a reload: each comment on its line, a LEFT one under the rename's old name", () => {
  const memory = memento();
  memory.data.set(PENDING_REVIEWS_KEY, stored());
  const { r, c } = controller({ memory });
  assert.deepEqual(r.reviewKeys(), [KEY]);
  assert.equal(c.threads.length, 2);
  const [range, left] = c.threads;
  assert.equal(String(range.uri), String(prHeadUri(REF, { number: 37, headSha: HEAD }, "src/a.ts")));
  assert.deepEqual([range.range.start.line, range.range.end.line], [1, 2]);
  assert.equal(String(left.uri), String(prBaseUri(REF, { number: 37 }, "src/old.ts", BASE)));
  assert.deepEqual(r.pendingFor(KEY)!.comments, [
    { path: "src/a.ts", line: 3, startLine: 2, side: "RIGHT", body: "range" },
    { path: "src/new.ts", line: 1, side: "LEFT", body: "old x" },
  ]);
  assert.equal(pr.statusBars.at(-1).text, "$(comment-discussion) Reviewing #37 · 2 pending");
  assert.equal(pr.statusBars.at(-1).shown, true);
  assert.equal(pr.contexts["gitstudio.pr.reviewing"], true);
  r.dispose();
});

test("offline after a reload, the kept patches still say where comments may go — a LEFT pane by its old name", async () => {
  const memory = memento();
  memory.data.set(PENDING_REVIEWS_KEY, stored());
  const { r, c } = controller({ memory, routes: [["GET", /./, () => ({ status: 502, body: {} })]] });
  const doc = (uri: any) => ({ uri, lineCount: 10 });
  const left = await c.commentingRangeProvider.provideCommentingRanges(doc(prBaseUri(REF, { number: 37 }, "src/old.ts", BASE)));
  assert.deepEqual(left.map((x: any) => [x.start.line, x.end.line]), [[0, 1]], "the base's hunk: its lines 1-2");
  const right = await c.commentingRangeProvider.provideCommentingRanges(doc(prHeadUri(REF, { number: 37, headSha: HEAD }, "src/a.ts")));
  assert.deepEqual(right.map((x: any) => [x.start.line, x.end.line]), [[0, 3]]);
  // A pane at neither of its shas takes no comment.
  assert.equal(await c.commentingRangeProvider.provideCommentingRanges(doc(prHeadUri(REF, { number: 37, headSha: "other" }, "src/a.ts"))), undefined);
  r.dispose();
});

test("a kept review reads its files from GitHub when first needed — at its head, the PR's files", async () => {
  const memory = memento();
  memory.data.set(PENDING_REVIEWS_KEY, stored({ patches: {}, renames: {} }));
  let filesAsked = 0;
  const { r } = controller({
    memory,
    routes: [
      ["GET", /\/pulls\/37\/files/, () => (filesAsked++, { body: [{ filename: "src/a.ts", status: "modified", patch: FILES[0].patch }] })],
      ["GET", /\/pulls\/37$/, () => ({ body: { number: 37, title: "t", body: "", state: "open", html_url: "u", user: null, created_at: "", updated_at: "", head: { ref: "f", sha: HEAD }, base: { ref: "main", sha: "b" } } })],
    ],
  });
  assert.equal(await r.openFile(KEY, "src/a.ts", { line: 2 }), true);
  assert.equal(filesAsked, 1);
  const diff = pr.executed.find((e: any) => e.id === "vscode.diff");
  assert.equal(String(diff.args[1]), String(prHeadUri(REF, { number: 37, headSha: HEAD }, "src/a.ts")));
  assert.equal(diff.args[3].selection.start.line, 1);
  r.dispose();
});

test("a stored review that is neither started nor has comments is not restored", () => {
  const memory = memento();
  memory.data.set(PENDING_REVIEWS_KEY, stored({ started: false, comments: [] }));
  const { r } = controller({ memory });
  assert.deepEqual(r.reviewKeys(), []);
  assert.equal(r.isReviewing(), false);
  r.dispose();
});
