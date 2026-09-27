// The pull request feature past the list, end to end in node: the PR page's
// host, the diff panes and review — registerPrFeature's REAL page, review
// controller and content provider (prTestKit.ts), against a fake
// api.github.com that answers in GitHub's own shapes — REST and GraphQL — and
// counts what each event costs. The list itself is prListView.test.ts; the
// page's own drawing is packages/webview-ui/test/prPage.test.ts.
//
// Each test is one row of the state table, asserted the way the user meets
// it: what the page is sent, what GitHub is sent, what the editor shows.

import {
  acmeRoutes,
  dialogs,
  fakeRepos,
  FILES_37,
  gql,
  github,
  LIST_QUERY,
  memento,
  mount,
  numbers,
  openPage,
  ORIGIN,
  pagePanel,
  pr,
  PULLS,
  rowArg,
  sleep,
  until,
  vscode,
  world,
} from "./prTestKit";
import { test } from "node:test";
import assert from "node:assert/strict";
import { graphqlWorld, linkHeader, rawPull, type FakeRequest } from "./fakeGitHub";

/* eslint-disable @typescript-eslint/no-explicit-any -- the stand-in's objects */
const { GitHubApi } = require("../src/pr/githubApi") as typeof import("../src/pr/githubApi"); // eslint-disable-line @typescript-eslint/no-require-imports
const PENDING_KEY = "gitstudio.pr.pendingReviews";

const isPageQuery = (req: FakeRequest) => req.path === "/graphql" && /pullRequest\(number: \$n\)/.test(String((req.body as any)?.query ?? ""));

// ── The PR page: what it is sent ─────────────────────────────────────────────

test("a page is one tab per pull request, titled with its repository — opened again, the same tab", async () => {
  const gh = github(acmeRoutes());
  const m = mount(fakeRepos(ORIGIN));
  const page = await openPage(m, 37);
  assert.equal(page.title, "acme/app#37", "the repository and the number: a number alone is not a pull request");
  assert.equal(page.viewType, "gitstudio.pullRequest");
  const s = page.state();
  assert.equal(s.pr.title, "Drop Commit");
  assert.equal(s.pr.kind, "open");
  assert.equal(gh.requests.filter(isPageQuery).length, 1, "one question for the page");
  assert.equal(gh.count(/^GET \/repos\/acme\/app\/pulls\/37\/files/), 1, "and its files");
  const panels = pr.panels.length;
  await vscode.commands.executeCommand("gitstudio.pr.openDescription", await rowArg(m, 37));
  assert.equal(pr.panels.length, panels, "no second tab");
  assert.equal(page.reveals, 1, "the tab it has is brought forward");
  assert.equal(gh.requests.filter(isPageQuery).length, 1, "read a moment ago: not asked again");
});

test("the page carries GitHub's answer: kind by merged_at, files with renames, the PR's own counts", async () => {
  const MERGED_AT = "2026-09-20T10:00:00Z";
  github(
    acmeRoutes(
      [["GET", /^\/repos\/acme\/app\/pulls\/37\/files/, () => ({ body: FILES_37 })]],
      world({
        "acme/app": {
          pulls: () => [
            ...PULLS().map((p) => (p.number === 37 ? { ...p, changed_files: 61, additions: 1840, deletions: 212 } : p)),
            rawPull(39, { state: "closed", merged_at: MERGED_AT }),
            rawPull(38, { state: "closed", merged_at: null }),
          ],
        },
      }),
    ),
  );
  const m = mount(fakeRepos(ORIGIN));
  const s = (await openPage(m, 37)).state();
  assert.equal(s.pr.changedFiles, 61, "not the count of the files fetched");
  assert.deepEqual(s.files.items.map((f: any) => [f.path, f.status, f.previousPath ?? ""]), [
    ["src/a.ts", "modified", ""],
    ["docs/gone.md", "removed", ""],
    ["src/new.ts", "renamed", "src/old.ts"],
  ]);
  for (const [n, kind] of [[39, "merged"], [38, "closed"]] as const) {
    await vscode.commands.executeCommand("gitstudio.pr.openDescription", { pr: { ...(await rowArg(m, 37)).pr, number: n }, ctx: (await rowArg(m, 37)).ctx });
    const p = pagePanel(n);
    p.receive({ type: "ready" });
    await until(() => p.state()?.status === "ready", `#${n}`);
    assert.equal(p.state().pr.kind, kind, `#${n} is ${kind}`);
  }
});

test("a page that can't be read says why, with the one thing that helps — and Retry reads it again", async () => {
  let down = true;
  const answer = graphqlWorld(world());
  github([["POST", /^\/graphql$/, (req) => (down && isPageQuery(req) ? { status: 502, body: { message: "Server Error" } } : answer(req))], ...acmeRoutes()]);
  const m = mount(fakeRepos(ORIGIN));
  const page = await openPage(m, 37);
  const s = page.state();
  assert.equal(s.status, "message");
  assert.match(s.message.title, /^Couldn't load acme\/app#37$/);
  assert.deepEqual(s.message.buttons.map((b: any) => b.label), ["Retry"]);
  assert.equal(s.preview.title, "Drop Commit", "which one, from what the list knew");
  down = false;
  page.receive({ type: "action", action: { kind: "retry" } });
  await until(() => page.state().status === "ready", "the page after Retry");
  // A refresh that fails keeps the page, and says so above it.
  down = true;
  page.receive({ type: "refresh" });
  await until(() => !!page.state().notice, "the notice");
  assert.equal(page.state().status, "ready");
  assert.match(page.state().notice.title, /^Couldn't refresh: Server Error/);
});

test("an expired sign-in, a pull request that doesn't exist: each says so in its own words", async () => {
  github([["POST", /^\/graphql$/, (req) => (isPageQuery(req) ? { status: 401, body: { message: "Bad credentials" } } : graphqlWorld(world())(req))], ...acmeRoutes()]);
  const m = mount(fakeRepos(ORIGIN));
  const s = (await openPage(m, 37)).state();
  assert.equal(s.message.title, "Your GitHub session expired");
  assert.deepEqual(s.message.buttons[0].action, { kind: "signIn", again: true });
  pr.panels.splice(0).forEach((p: any) => p.dispose());
  const row = await rowArg(m, 37);
  github(acmeRoutes());
  await vscode.commands.executeCommand("gitstudio.pr.openDescription", { pr: { ...row.pr, number: 99 }, ctx: row.ctx });
  const p = pagePanel(99);
  p.receive({ type: "ready" });
  await until(() => p.state()?.status === "message", "#99's message");
  assert.equal(p.state().message.title, "GitHub has no pull request acme/app#99");
});

// ── The PR page: one-click changes, optimistic ──────────────────────────────

test("Close is on the page at once, then sent; a refusal puts it back and says why — the list's row moves, never reloads", async () => {
  let refuse = false;
  let closed = false;
  const sent: any[] = [];
  const pulls = () => PULLS().map((p) => (closed && p.number === 37 ? { ...p, state: "closed" } : p));
  const gh = github([
    [
      "PATCH",
      /^\/repos\/acme\/app\/pulls\/37$/,
      (req) => {
        sent.push(req.body);
        if (refuse) return { status: 403, body: { message: "Resource not accessible by integration" } };
        closed = (req.body as any).state === "closed";
        return { body: {} };
      },
    ],
    ...acmeRoutes([], world({ "acme/app": { pulls } })),
  ]);
  const m = mount(fakeRepos(ORIGIN));
  const page = await openPage(m, 37);
  const loads = gql(gh, LIST_QUERY).length;
  const hold = gh.hold(/^\/repos\/acme\/app\/pulls\/37$/);
  page.receive({ type: "close" });
  await until(() => hold.held() > 0, "the close to be sent");
  assert.equal(page.state().pr.kind, "closed", "closed on the page before GitHub answers");
  assert.ok(page.state().busy.includes("close"));
  hold.release();
  await until(() => !page.state().busy.includes("close"), "the close to finish");
  assert.deepEqual(sent, [{ state: "closed" }]);
  assert.deepEqual(numbers(m), [36, 3], "the row left Open");
  assert.equal(gql(gh, LIST_QUERY).length, loads, "…without reading the list again");
  assert.equal(page.htmlWrites, 1, "the page is patched, never reloaded");

  // Reopen, refused: it goes back to closed, and the notice says what happened.
  refuse = true;
  page.receive({ type: "reopen" });
  await until(() => !!page.state().notice, "the refusal");
  // The very state that says so is back to closed — not left for the next read to fix.
  const said = page.posted.find((m: any) => m.type === "state" && m.state.notice);
  assert.equal(said.state.pr.kind, "closed", "put back as it was");
  assert.equal(page.state().pr.kind, "closed");
  assert.equal(page.state().notice.title, "Couldn't reopen #37: Resource not accessible by integration");
  assert.equal(page.state().notice.detail, "It is still closed.");
  assert.deepEqual(page.state().notice.buttons.map((b: any) => b.label), ["Open on GitHub"]);
});

test("Mark Ready sends GitHub's mutation for THIS pull request's node, and a draft reads Open at once", async () => {
  let asked: any;
  const answer = graphqlWorld(world({ "acme/app": { pulls: () => PULLS().map((p) => (asked && p.number === 36 ? { ...p, draft: false } : p)) } }));
  github([
    [
      "POST",
      /^\/graphql$/,
      (req) => {
        if (/markPullRequestReadyForReview/.test((req.body as any).query)) {
          asked = (req.body as any).variables;
          return { body: { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } } };
        }
        return answer(req);
      },
    ],
    ...acmeRoutes(),
  ]);
  const m = mount(fakeRepos(ORIGIN));
  const page = await openPage(m, 36);
  assert.equal(page.state().pr.kind, "draft");
  page.receive({ type: "markReady" });
  await until(() => page.state().pr.kind === "open", "Open");
  await until(() => !!asked, "the mutation");
  assert.deepEqual(asked, { id: "PR_node_36" });
});

test("Merge sends the method, the title and the head the page showed; the page reads Merged and the row leaves Open — and a method the repository turned off is never sent", async () => {
  let merged = false;
  let sentMerge: any;
  const deleted: string[] = [];
  const pulls = () => PULLS().map((p) => (merged && p.number === 37 ? { ...p, state: "closed", merged_at: "2026-09-25T10:00:00Z" } : p));
  const gh = github([
    [
      "PUT",
      /^\/repos\/acme\/app\/pulls\/37\/merge$/,
      (req) => {
        sentMerge = req.body;
        merged = true;
        return { body: { merged: true } };
      },
    ],
    ["DELETE", /^\/repos\/acme\/app\/git\/refs\/heads\/(.+)$/, (req, mm) => (deleted.push(decodeURIComponent(mm[1])), { status: 204 })],
    ...acmeRoutes([], world({ "acme/app": { pulls, ci: { 37: "SUCCESS" }, methods: ["squash", "rebase"] } })),
  ]);
  const m = mount(fakeRepos(ORIGIN));
  const page = await openPage(m, 37, { merge: true });
  assert.equal(page.state().focus.open, "merge", "the list's Merge… opens the page's merge box");
  assert.deepEqual(page.state().pr.repo.mergeMethods, ["squash", "rebase"]);
  const loads = gql(gh, LIST_QUERY).length;
  page.receive({ type: "merge", method: "merge", deleteBranch: false });
  await sleep(30);
  assert.equal(gh.count(/\/merge$/), 0, "merge commits are off in acme/app: nothing is sent");
  page.receive({ type: "merge", method: "squash", title: "Drop Commit (#37)", deleteBranch: true });
  await until(() => page.state().pr.kind === "merged", "Merged");
  assert.deepEqual(sentMerge, { merge_method: "squash", commit_title: "Drop Commit (#37)", sha: "037head" });
  await until(() => deleted.length > 0, "the branch deleted");
  assert.deepEqual(deleted, ["feature-37"]);
  assert.deepEqual(numbers(m), [36, 3], "the merged PR left the open list");
  assert.equal(gql(gh, LIST_QUERY).length, loads, "…without reading it again");
  assert.equal(page.htmlWrites, 1);
});

test("a merge GitHub refuses because the branch moved says so, and the page stays open", async () => {
  github([["PUT", /\/merge$/, () => ({ status: 409, body: { message: "Head branch was modified. Review and try the merge again." } })], ...acmeRoutes([], world({ "acme/app": { pulls: PULLS, ci: { 37: "SUCCESS" } } }))]);
  const m = mount(fakeRepos(ORIGIN));
  const page = await openPage(m, 37);
  page.receive({ type: "merge", method: "squash", deleteBranch: false });
  await until(() => !!page.state().notice, "the notice");
  assert.equal(page.state().pr.kind, "open");
  assert.match(page.state().notice.title, /^Couldn't merge #37: Head branch was modified/);
  assert.match(page.state().notice.detail, /moved on since this page read it/);
});

test("a read still in flight when the merge lands never paints Open over Merged", async () => {
  let merged = false;
  const pulls = () => PULLS().map((p) => (merged && p.number === 37 ? { ...p, state: "closed", merged_at: "2026-09-25T10:00:00Z" } : p));
  const gh = github([
    ["PUT", /^\/repos\/acme\/app\/pulls\/37\/merge$/, () => ((merged = true), { body: { merged: true } })],
    ...acmeRoutes([], world({ "acme/app": { pulls, ci: { 37: "SUCCESS" } } })),
  ]);
  const m = mount(fakeRepos(ORIGIN));
  const page = await openPage(m, 37);
  // Refresh; GitHub is slow to answer it — and its answer is the pull
  // request as it was, open.
  let holdNext = true;
  const slow = gh.hold((req) => isPageQuery(req) && holdNext && !(holdNext = false));
  page.receive({ type: "refresh" });
  await until(() => slow.held() > 0, "the refresh in flight");
  page.receive({ type: "merge", method: "squash", deleteBranch: false });
  await until(() => page.state().pr.kind === "merged", "Merged");
  await until(() => !page.state().refreshing, "the read after the merge");
  merged = false; // the held read answers as GitHub would have, when it was asked
  slow.release();
  await sleep(80);
  merged = true;
  await until(() => !page.state().refreshing, "the reads to settle");
  assert.equal(page.state().pr.kind, "merged", "the page still reads Merged");
});

test("a comment shows at once, as sending; GitHub's copy replaces it — and a refused one comes back to its box", async () => {
  let refuse = false;
  github([
    [
      "POST",
      /^\/repos\/acme\/app\/issues\/37\/comments$/,
      (req) =>
        refuse
          ? { status: 422, body: { message: "Validation Failed", errors: [{ message: "Body is too long" }] } }
          : { status: 201, body: { id: 5, node_id: "IC_5", html_url: "https://github.com/acme/app/pull/37#issuecomment-5", created_at: "2026-09-27T10:00:00Z", user: { login: "me" }, body: (req.body as any).body } },
    ],
    ...acmeRoutes(),
  ]);
  const m = mount(fakeRepos(ORIGIN));
  const page = await openPage(m, 37);
  page.receive({ type: "comment", body: "Looks good" });
  await until(() => page.state().pr.timeline.some((t: any) => t.id === "IC_5"), "GitHub's copy");
  const c = page.state().pr.timeline.find((t: any) => t.id === "IC_5");
  assert.deepEqual([c.kind, c.body, c.sending ?? false], ["comment", "Looks good", false]);
  refuse = true;
  page.receive({ type: "comment", body: "Too long" });
  await until(() => !!page.state().notice, "the refusal");
  assert.ok(!page.state().pr.timeline.some((t: any) => t.body === "Too long"), "not left on the page as if sent");
  assert.equal(page.state().restore.key, "comment");
  assert.equal(page.state().restore.body, "Too long", "back in its box");
  assert.match(page.state().notice.title, /Body is too long/);
});

test("a read that answers while a comment and a Resolve are on their way keeps both on the page", async () => {
  const answer = graphqlWorld(
    world({
      "acme/app": {
        pulls: PULLS,
        page: { 37: { threads: [{ id: "T_1", path: "src/a.ts", line: 41, startLine: null, originalLine: 41, diffSide: "RIGHT", isResolved: false, isOutdated: false, viewerCanResolve: true, viewerCanUnresolve: false, viewerCanReply: true, resolvedBy: null, comments: { totalCount: 1, nodes: [{ id: "C_1", author: { login: "dana" }, body: "Why?", createdAt: "2026-09-26T10:00:00Z", url: "u" }] } }] } },
      },
    }),
  );
  const gh = github([
    ["POST", /^\/repos\/acme\/app\/issues\/37\/comments$/, () => ({ status: 201, body: { node_id: "IC_7", html_url: "u7", created_at: "2026-09-27T10:00:00Z", user: { login: "me" } } })],
    ["POST", /^\/graphql$/, (req) => (/resolveReviewThread/.test(String((req.body as any).query)) ? { body: { data: { resolveReviewThread: { thread: { id: "T_1", isResolved: true } } } } } : answer(req))],
    ...acmeRoutes(),
  ]);
  const m = mount(fakeRepos(ORIGIN));
  const page = await openPage(m, 37);
  const slowComment = gh.hold(/\/issues\/37\/comments$/);
  const slowResolve = gh.hold((req) => /resolveReviewThread/.test(String((req.body as any)?.query ?? "")));
  page.receive({ type: "comment", body: "On its way" });
  page.receive({ type: "resolve", threadId: "T_1", resolved: true });
  await until(() => slowComment.held() > 0 && slowResolve.held() > 0, "both on their way");
  // A read that knows of neither.
  page.receive({ type: "refresh" });
  await until(() => gh.requests.filter(isPageQuery).length === 2 && !page.state().refreshing, "the read");
  const s = page.state();
  assert.ok(s.pr.timeline.some((t: any) => t.body === "On its way" && t.sending), "the comment being sent stays");
  assert.equal(s.pr.threads[0].resolved, true, "so does the Resolve");
  slowComment.release();
  slowResolve.release();
  await until(() => page.state().pr.timeline.some((t: any) => t.id === "IC_7"), "GitHub's copy");
});

test("a commit expands to its files, and a file opens as that commit's diff — from its first parent, under the old name for a rename", async () => {
  github([
    [
      "GET",
      /^\/repos\/acme\/app\/commits\/037head$/,
      () => ({ body: { sha: "037head", parents: [{ sha: "parent1" }], files: [{ filename: "src/new.ts", previous_filename: "src/old.ts", status: "renamed", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-x\n+y" }] } }),
    ],
    ...acmeRoutes(),
  ]);
  const m = mount(fakeRepos(ORIGIN));
  const page = await openPage(m, 37);
  page.receive({ type: "expandCommit", sha: "037head" });
  await until(() => page.state().commitFiles["037head"]?.status === "loaded", "its files");
  assert.deepEqual(page.state().commitFiles["037head"].files.map((f: any) => [f.path, f.previousPath]), [["src/new.ts", "src/old.ts"]]);
  page.receive({ type: "openCommitFile", sha: "037head", path: "src/new.ts" });
  await until(() => pr.executed.some((e: any) => e.id === "vscode.diff"), "the diff");
  const [left, right] = pr.executed.find((e: any) => e.id === "vscode.diff").args;
  assert.equal(left.path, "/src/old.ts");
  assert.match(left.query, /sha=parent1/);
  assert.match(right.query, /sha=037head/);
  assert.doesNotMatch(right.query, /pr=/, "a commit's diff is not the review's: it names no pull request");
  // …so neither side takes a comment — though 037head is the pull request's
  // head, and its page has been read (the review would take the PR's hunks).
  const provide = (uri: any) => m.controller.commentingRangeProvider.provideCommentingRanges({ uri, lineCount: 120 });
  assert.equal(await provide(right), undefined, "the head commit's diff takes no comment");
  assert.equal(await provide(left), undefined, "…nor its parent's side");
});

test("a reference in a body opens its page when it is this repository's pull request — anything else, GitHub's page", async () => {
  github([["GET", /^\/repos\/acme\/app\/pulls\/404$/, () => ({ status: 404, body: { message: "Not Found" } })], ...acmeRoutes()]);
  const m = mount(fakeRepos(ORIGIN));
  const page = await openPage(m, 37);
  page.receive({ type: "openRef", repo: "acme/app", number: 36 });
  await until(() => !!pagePanel(36), "#36's page");
  page.receive({ type: "openRef", repo: "acme/infra", number: 12 });
  page.receive({ type: "openRef", repo: "acme/app", number: 404 });
  page.receive({ type: "openUrl", url: "javascript:alert(1)" });
  await until(() => pr.opened.length === 2, "two links opened");
  assert.deepEqual(pr.opened, ["https://github.com/acme/infra/issues/12", "https://github.com/acme/app/issues/404"]);
});

test("while checks run the page reads the pull request again, only in sight — and stops once they are done", async () => {
  let ci = "PENDING";
  const gh = github(acmeRoutes([], world({ "acme/app": { pulls: PULLS, get ci() { return { 37: ci }; } } as any })));
  const m = mount(fakeRepos(ORIGIN));
  // A short poll for the test: the page's deps are the feature's.
  const page = await openPage(m, 37);
  const reads = () => gh.requests.filter(isPageQuery).length;
  const first = reads();
  const poll = (pagePanel(37) as any);
  poll.visible = false;
  const inner = (require("../src/pr/prPage") as typeof import("../src/pr/prPage")).PrPage.get("acme", "app", 37) as any; // eslint-disable-line @typescript-eslint/no-require-imports
  await inner.loaded();
  inner.poll();
  await sleep(60);
  assert.equal(reads(), first, "a tab out of sight asks nothing");
  poll.visible = true;
  inner.poll();
  await until(() => reads() === first + 1, "a read while checks run");
  await inner.loaded();
  ci = "SUCCESS";
  inner.poll();
  await until(() => reads() === first + 2 && page.state().pr.ci.state === "success", "the read that finds them done");
  await inner.loaded();
  inner.poll();
  await sleep(30);
  assert.equal(reads(), first + 2, "done: no more reads");
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
const prUri = (path: string, sha: string, n?: number) =>
  vscode.Uri.from({ scheme: "gitstudio-pr", path: `/${path}`, query: `owner=acme&repo=app&sha=${sha}${n ? `&pr=${n}` : ""}` });
const ranges = async (m: any, path: string, sha: string, lineCount: number, n?: number) =>
  ((await m.controller.commentingRangeProvider.provideCommentingRanges({ uri: prUri(path, sha, n), lineCount })) ?? undefined)?.map(
    (r: any) => [r.start.line, r.end.line],
  );

async function startReview(m: any, n: number): Promise<any> {
  await vscode.commands.executeCommand("gitstudio.pr.startReview", await rowArg(m, n));
  const page = pagePanel(n);
  if (!page.ready) {
    page.receive({ type: "ready" });
    page.ready = true;
  }
  await until(() => !!page.state()?.review, `#${n}'s review`);
  return page;
}

async function submit(page: any, event: string, body = ""): Promise<void> {
  const before = page.state().seq;
  page.receive({ type: "submitReview", event, body });
  await until(() => page.state().seq > before && !page.state().busy.includes("review"), "the review to be sent");
}

test("review: only lines inside the diff's hunks take a comment — the head's, and the base's for removed lines", async () => {
  github(acmeRoutes());
  const m = mount(fakeRepos(ORIGIN));
  await startReview(m, 37);
  assert.deepEqual(await ranges(m, "src/a.ts", HEAD_37, 120, 37), [[0, 3], [40, 41]], "the head side: its two hunks, not every line");
  assert.deepEqual(await ranges(m, "src/a.ts", "basesha", 120, 37), [[0, 2], [39, 43]], "the base side: the lines being removed");
  assert.deepEqual(await ranges(m, "docs/gone.md", "basesha", 3, 37), [[0, 2]], "a deleted file is commented on its LEFT side");
  assert.deepEqual(await ranges(m, "docs/gone.md", HEAD_37, 0, 37), [], "…and has no right side to comment on");
  assert.deepEqual(await ranges(m, "src/old.ts", "basesha", 2, 37), [[0, 1]], "a rename's base side is its old path");
  // A document that names no pull request — a commit's diff, even of the
  // head commit — is not the review's: no line of it takes a comment.
  assert.equal(await ranges(m, "src/a.ts", HEAD_37, 120), undefined, "no pr=: no commenting ranges, even at the head's sha");
  assert.equal(await ranges(m, "src/a.ts", "basesha", 120), undefined, "…nor at the base's");
  const opened = pr.executed.filter((e: any) => e.id === "vscode.diff");
  assert.equal(opened.length, 1, "one diff opens: a preview replaced by the next left only the last of five");
  assert.match(opened[0].args[1].query, /pr=37/, "the diff names its pull request");
});

test("review: a page's diffs take comments without Start Review — the first comment starts the review, and the page lists it", async () => {
  github(acmeRoutes());
  const m = mount(fakeRepos(ORIGIN));
  const page = await openPage(m, 37);
  assert.equal(page.state().review, undefined, "no review yet");
  assert.deepEqual(await ranges(m, "src/a.ts", HEAD_37, 120, 37), [[0, 3], [40, 41]], "commentable as soon as the page has read it");
  const thread = vscode.__makeThread(prUri("src/a.ts", HEAD_37, 37), new vscode.Range(40, 0, 40, 0));
  await vscode.commands.executeCommand("gitstudio.pr.addReviewComment", { thread, text: "why 41?" });
  await until(() => page.state().review?.comments.length === 1, "the page to list it");
  assert.deepEqual(page.state().review.comments, [{ path: "src/a.ts", line: 41, side: "RIGHT", body: "why 41?" }]);
  assert.equal(page.state().review.stale, false);
  const bar = pr.statusBars.at(-1);
  assert.equal(bar.shown, true);
  assert.equal(bar.text, "$(comment-discussion) Reviewing #37 · 1 pending");
  assert.equal(pr.contexts["gitstudio.pr.reviewing"], true);
});

test("review: submitted from the page — verdict, summary and every comment in one request, pinned to the head; nothing asked in the sidebar", async () => {
  let sent: any;
  const gh = github([["POST", /^\/repos\/acme\/app\/pulls\/37\/reviews$/, (req) => ((sent = req.body), { body: { id: 1, node_id: "PRR_1", html_url: "https://github.com/acme/app/pull/37#pullrequestreview-1", submitted_at: "2026-09-27T10:00:00Z" } })], ...acmeRoutes()]);
  const m = mount(fakeRepos(ORIGIN));
  const page = await startReview(m, 37);
  const multi = vscode.__makeThread(prUri("src/a.ts", HEAD_37, 37), new vscode.Range(1, 0, 3, 0));
  const removed = vscode.__makeThread(prUri("docs/gone.md", "basesha", 37), new vscode.Range(1, 0, 1, 0));
  await vscode.commands.executeCommand("gitstudio.pr.addReviewComment", { thread: multi, text: "these lines" });
  await vscode.commands.executeCommand("gitstudio.pr.addReviewComment", { thread: removed, text: "why remove this?" });
  await until(() => page.state().review?.comments.length === 2, "two pending");
  // GitHub's copy of the threads comes with the read after the submit: held here.
  const after = gh.hold(isPageQuery);
  await submit(page, "REQUEST_CHANGES", "Looks close.");
  assert.deepEqual(dialogs.asked, [], "the page's own box: no question in the sidebar");
  assert.equal(sent.event, "REQUEST_CHANGES");
  assert.equal(sent.body, "Looks close.");
  assert.equal(sent.commit_id, HEAD_37, "a push during the review must not move the comments");
  assert.deepEqual(sent.comments, [
    { path: "docs/gone.md", line: 2, side: "LEFT", body: "why remove this?" },
    { path: "src/a.ts", line: 4, side: "RIGHT", start_line: 2, start_side: "RIGHT", body: "these lines" },
  ]);
  await until(() => page.state().review === undefined, "the review gone");
  assert.equal(page.state().sent.key, "review", "the page empties its box");
  assert.ok(page.state().pr.timeline.some((t: any) => t.kind === "review" && t.state === "CHANGES_REQUESTED"), "the review is on the timeline");
  assert.equal(multi.disposed, false, "the comments stay in the editor, as posted, until GitHub's threads replace them");
  assert.equal(multi.label, "Comment posted");
  assert.equal(pr.statusBars.at(-1).shown, false);
  assert.equal(pr.contexts["gitstudio.pr.reviewing"], false);
  after.release();
});

test("review: a review GitHub refuses keeps every comment and says why; a Comment review with nothing to say is not sent", async () => {
  github([["POST", /\/reviews$/, () => ({ status: 422, body: { message: "Unprocessable Entity", errors: ["Pull request review thread line must be part of the diff"] } })], ...acmeRoutes()]);
  const m = mount(fakeRepos(ORIGIN));
  const page = await startReview(m, 37);
  await submit(page, "COMMENT", "");
  assert.match(page.state().notice.detail, /^A Comment review needs something to say/);
  const thread = vscode.__makeThread(prUri("src/a.ts", HEAD_37, 37), new vscode.Range(1, 0, 1, 0));
  await vscode.commands.executeCommand("gitstudio.pr.addReviewComment", { thread, text: "hm" });
  await submit(page, "APPROVE", "");
  assert.equal(page.state().notice.title, "Couldn't submit your review");
  assert.match(page.state().notice.detail, /line must be part of the diff\. Your comments are kept\.$/);
  assert.equal(page.state().review.comments.length, 1);
  assert.equal(thread.disposed, false);
});

test("review: Discard from the page throws the pending comments away — ones already on GitHub stay", async () => {
  github([["POST", /\/reviews$/, () => ({ body: { id: 1 } })], ...acmeRoutes()]);
  const m = mount(fakeRepos(ORIGIN));
  const page = await startReview(m, 37);
  const thread = vscode.__makeThread(prUri("src/a.ts", HEAD_37, 37), new vscode.Range(1, 0, 1, 0));
  await vscode.commands.executeCommand("gitstudio.pr.addSingleComment", { thread, text: "posted now" });
  await until(() => thread.comments.length === 1, "the single comment to post");
  await vscode.commands.executeCommand("gitstudio.pr.addReviewComment", { thread, text: "pending" });
  page.receive({ type: "discardReview" });
  await until(() => page.state().review === undefined, "discarded");
  assert.equal(thread.disposed, false, "the posted comment stays in the editor");
  assert.deepEqual(thread.comments.map((c: any) => c.body.value), ["posted now"]);
});

test("review: reviews of two pull requests stand side by side — starting one never asks to throw the other away", async () => {
  github(acmeRoutes());
  const m = mount(fakeRepos(ORIGIN));
  const p37 = await startReview(m, 37);
  const thread = vscode.__makeThread(prUri("src/a.ts", HEAD_37, 37), new vscode.Range(1, 0, 1, 0));
  await vscode.commands.executeCommand("gitstudio.pr.addReviewComment", { thread, text: "keep me" });
  const p3 = await startReview(m, 3);
  assert.deepEqual(dialogs.asked, [], "nothing asked");
  assert.equal(thread.disposed, false);
  assert.equal(p37.state().review.comments.length, 1, "#37's review stands");
  assert.deepEqual(p3.state().review, { comments: [], started: true, headSha: "003head", stale: false });
  assert.equal(pr.statusBars.at(-1).text, "$(comment-discussion) 2 reviews · 1 pending");
  // The palette's Discard asks — which review, then whether.
  dialogs.answer = (spec) => (spec.kind === "pick" ? "acme/app#37" : undefined);
  await vscode.commands.executeCommand("gitstudio.pr.cancelReview");
  assert.equal(dialogs.asked[0].title, "Discard which review?");
  assert.match(dialogs.asked[1].title, /^Discard 1 pending comment on #37\?$/);
  assert.equal(thread.disposed, false, "dismissed: kept");
});

test("review: kept across a window reload, keyed owner/repo#n@head — the comments come back on their lines, and the page lists them", async () => {
  github(acmeRoutes());
  const state = memento();
  const m = mount(fakeRepos(ORIGIN), state);
  await startReview(m, 37);
  const thread = vscode.__makeThread(prUri("src/a.ts", HEAD_37, 37), new vscode.Range(1, 0, 3, 0));
  await vscode.commands.executeCommand("gitstudio.pr.addReviewComment", { thread, text: "these lines" });
  const kept = state.data.get(PENDING_KEY);
  assert.deepEqual(Object.keys(kept), ["acme/app#37@037head"]);
  assert.deepEqual(kept["acme/app#37@037head"].comments, [{ path: "src/a.ts", side: "RIGHT", line: 4, startLine: 2, body: "these lines" }]);

  // The window reloads: everything is made again from the workspace's state.
  m.dispose();
  pr.panels.splice(0).forEach((p: any) => p.dispose());
  const again = mount(fakeRepos(ORIGIN), state);
  const restored = again.controller.threads.at(-1);
  assert.equal(restored.uri.path, "/src/a.ts");
  assert.match(restored.uri.query, /sha=037head&pr=37/);
  assert.deepEqual([restored.range.start.line, restored.range.end.line], [1, 3]);
  assert.deepEqual(restored.comments.map((c: any) => c.body.value), ["these lines"]);
  assert.equal(restored.label, "Pending review comment");
  assert.equal(pr.statusBars.at(-1).text, "$(comment-discussion) Reviewing #37 · 1 pending");
  const page = await openPage(again, 37);
  assert.deepEqual(page.state().review.comments, [{ path: "src/a.ts", line: 4, startLine: 2, side: "RIGHT", body: "these lines" }]);
  assert.deepEqual(await ranges(again, "src/a.ts", HEAD_37, 120, 37), [[0, 3], [40, 41]], "and more can be added");
});

test("review: written on a head the pull request has moved past — said on the page, and sent on the commit it was written on", async () => {
  let sent: any;
  github([["POST", /\/reviews$/, (req) => ((sent = req.body), { body: { id: 1 } })], ...acmeRoutes()]);
  const state = memento();
  state.data.set(PENDING_KEY, {
    "acme/app#37@0ldhead": {
      owner: "acme",
      repo: "app",
      number: 37,
      title: "Drop Commit",
      headSha: "0ldhead",
      baseSha: "basesha",
      started: true,
      comments: [{ path: "src/a.ts", side: "RIGHT", line: 2, body: "old code" }],
      patches: { "src/a.ts": FILES_37[0].patch },
    },
  });
  const m = mount(fakeRepos(ORIGIN), state);
  const page = await openPage(m, 37);
  assert.equal(page.state().review.stale, true, "the page says the pull request moved on");
  assert.equal(page.state().review.headSha, "0ldhead");
  assert.equal(await ranges(m, "src/a.ts", HEAD_37, 120, 37), undefined, "the new head takes no comment until this review is sent or discarded");
  await submit(page, "COMMENT", "");
  assert.equal(sent.commit_id, "0ldhead");
  assert.deepEqual(sent.comments, [{ path: "src/a.ts", line: 2, side: "RIGHT", body: "old code" }]);
});

test("review: GitHub's threads are drawn on the diff where they sit now — a reply and Resolve in the editor reach the page", async () => {
  const replies: any[] = [];
  const answer = graphqlWorld(
    world({
      "acme/app": {
        pulls: PULLS,
        page: {
          37: {
            threads: [
              { id: "T_1", path: "src/a.ts", line: 41, startLine: null, originalLine: 41, diffSide: "RIGHT", isResolved: false, isOutdated: false, viewerCanResolve: true, viewerCanUnresolve: false, viewerCanReply: true, resolvedBy: null, comments: { totalCount: 1, nodes: [{ id: "C_1", author: { login: "dana", avatarUrl: null }, body: "Why?", createdAt: "2026-09-26T10:00:00Z", url: "u", pullRequestReview: { id: "R_1" } }] } },
              { id: "T_2", path: "src/a.ts", line: null, startLine: null, originalLine: 9, diffSide: "RIGHT", isResolved: true, isOutdated: true, viewerCanResolve: false, viewerCanUnresolve: true, viewerCanReply: true, resolvedBy: { login: "me" }, comments: { totalCount: 1, nodes: [{ id: "C_2", author: null, body: "Old", createdAt: "2026-09-25T10:00:00Z", url: "u2", pullRequestReview: null }] } },
            ],
          },
        },
      },
    }),
  );
  github([
    [
      "POST",
      /^\/graphql$/,
      (req) => {
        const q = String((req.body as any).query);
        if (/addPullRequestReviewThreadReply/.test(q)) {
          replies.push((req.body as any).variables);
          return { body: { data: { addPullRequestReviewThreadReply: { comment: { id: "C_9", url: "u9", createdAt: "2026-09-27T10:00:00Z", body: (req.body as any).variables.body, author: { login: "me", avatarUrl: null } } } } } };
        }
        if (/resolveReviewThread/.test(q)) return { body: { data: { resolveReviewThread: { thread: { id: "T_1", isResolved: true, resolvedBy: { login: "me" } } } } } };
        return answer(req);
      },
    ],
    ...acmeRoutes(),
  ]);
  const m = mount(fakeRepos(ORIGIN));
  const page = await openPage(m, 37);
  await until(() => m.controller.threads.length === 1, "the thread drawn");
  const drawn = m.controller.threads[0];
  assert.match(drawn.uri.query, /sha=037head&pr=37/);
  assert.deepEqual([drawn.range.start.line, drawn.range.end.line], [40, 40]);
  assert.equal(drawn.contextValue, "gitstudio.prThread.open");
  assert.deepEqual(drawn.comments.map((c: any) => [c.author.name, c.body.value]), [["dana", "Why?"]]);
  // Reply from the editor: GitHub is sent it, and the page shows it.
  await vscode.commands.executeCommand("gitstudio.pr.replyThread", { thread: drawn, text: "Because." });
  await until(() => page.state().pr.threads[0].comments.length === 2, "the page's copy");
  assert.deepEqual(replies, [{ thread: "T_1", body: "Because." }]);
  assert.deepEqual(drawn.comments.map((c: any) => c.body.value), ["Why?", "Because."]);
  // Resolve from the editor.
  await vscode.commands.executeCommand("gitstudio.pr.resolveThread", drawn);
  await until(() => page.state().pr.threads[0].resolved === true, "resolved on the page");
  assert.equal(drawn.contextValue, "gitstudio.prThread.resolved");
  assert.equal(drawn.label, "Resolved by me");
});

test("review: a reply from the page that GitHub refuses comes off the thread and back into its box", async () => {
  const answer = graphqlWorld(
    world({
      "acme/app": {
        pulls: PULLS,
        page: { 37: { threads: [{ id: "T_1", path: "src/a.ts", line: 41, startLine: null, originalLine: 41, diffSide: "RIGHT", isResolved: false, isOutdated: false, viewerCanResolve: true, viewerCanUnresolve: false, viewerCanReply: true, resolvedBy: null, comments: { totalCount: 1, nodes: [{ id: "C_1", author: { login: "dana" }, body: "Why?", createdAt: "2026-09-26T10:00:00Z", url: "u" }] } }] } },
      },
    }),
  );
  github([
    ["POST", /^\/graphql$/, (req) => (/addPullRequestReviewThreadReply/.test(String((req.body as any).query)) ? { body: { data: null, errors: [{ type: "FORBIDDEN", message: "You can't reply to this thread." }] } } : answer(req))],
    ...acmeRoutes(),
  ]);
  const m = mount(fakeRepos(ORIGIN));
  const page = await openPage(m, 37);
  page.receive({ type: "reply", threadId: "T_1", body: "Because." });
  await until(() => !!page.state().notice, "the refusal");
  assert.equal(page.state().pr.threads[0].comments.length, 1, "the sending copy is gone");
  assert.deepEqual([page.state().restore.key, page.state().restore.body], ["reply:T_1", "Because."]);
  assert.equal(page.state().notice.title, "Couldn't post your reply: You can't reply to this thread.");
});

test("review: Delete on a pending comment deletes that comment", async () => {
  github(acmeRoutes());
  const m = mount(fakeRepos(ORIGIN));
  await startReview(m, 37);
  const thread = vscode.__makeThread(prUri("src/a.ts", HEAD_37, 37), new vscode.Range(40, 0, 40, 0));
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
  const two = vscode.__makeThread(prUri("src/a.ts", HEAD_37, 37), new vscode.Range(2, 0, 2, 0));
  await vscode.commands.executeCommand("gitstudio.pr.addReviewComment", { thread: two, text: "one" });
  await vscode.commands.executeCommand("gitstudio.pr.addReviewComment", { thread: two, text: "two" });
  await vscode.commands.executeCommand("gitstudio.pr.cancelReview");
  assert.match(dialogs.asked.at(-1)?.title ?? "", /^Discard 2 pending comments on #37\?$/);
  await vscode.commands.executeCommand("gitstudio.pr.addSingleComment", { thread: two, text: "posted too" });
  await until(() => two.comments.length === 3, "the single comment to post");
  dialogs.answer = (spec) => (spec.kind === "confirm" ? "ok" : undefined);
  await vscode.commands.executeCommand("gitstudio.pr.cancelReview");
  assert.equal(two.disposed, false);
  assert.deepEqual(two.comments.map((c: any) => c.body.value), ["posted too"], "the pending ones go, the posted one stays");
});

test("review: the left side is the MERGE BASE — the file GitHub's hunks count its lines in — not the base branch's tip", async () => {
  let sent: any;
  const gh = github([
    ["GET", /^\/repos\/acme\/app\/compare\/basesha\.\.\.037head/, () => ({ body: { merge_base_commit: { sha: "mergebase" } } })],
    ["POST", /^\/repos\/acme\/app\/pulls\/37\/reviews$/, (req) => ((sent = req.body), { body: { id: 1 } })],
    ...acmeRoutes(),
  ]);
  const m = mount(fakeRepos(ORIGIN));
  const page = await openPage(m, 37);
  page.receive({ type: "openFile", path: "src/new.ts" });
  await until(() => pr.executed.some((e: any) => e.id === "vscode.diff"), "the page's diff to open");
  const [pageLeft, pageRight] = pr.executed.find((e: any) => e.id === "vscode.diff").args;
  assert.match(pageLeft.query, /sha=mergebase/, "the page's diff: base side at the merge base");
  assert.equal(pageLeft.path, "/src/old.ts", "under a rename's old name");
  assert.equal(pageRight.path, "/src/new.ts");
  assert.deepEqual(await ranges(m, "src/a.ts", "mergebase", 120, 37), [[0, 2], [39, 43]], "the removed lines, where they are in that file");
  assert.equal(await ranges(m, "src/a.ts", "basesha", 120, 37), undefined, "the base branch's tip is not the diff's left side");
  const removed = vscode.__makeThread(prUri("docs/gone.md", "mergebase", 37), new vscode.Range(1, 0, 1, 0));
  await vscode.commands.executeCommand("gitstudio.pr.addReviewComment", { thread: removed, text: "why?" });
  await submit(page, "COMMENT", "");
  assert.deepEqual(sent?.comments, [{ path: "docs/gone.md", line: 2, side: "LEFT", body: "why?" }], JSON.stringify(page.state().notice));
  assert.equal(gh.count(/\/compare\//), 1, "asked once for the head the page shows");
});

test("review: a page loaded before a push reviews the pull request's head NOW — its files open there, and take comments", async () => {
  const NEW_HEAD = "037new";
  let pushed = false;
  const pulls = () => PULLS().map((p) => (pushed && p.number === 37 ? { ...p, head: { ...(p.head as object), sha: NEW_HEAD } } : p));
  let sent: any;
  github([["POST", /\/reviews$/, (req) => ((sent = req.body), { body: { id: 1 } })], ...acmeRoutes([], world({ "acme/app": { pulls } }))]);
  const m = mount(fakeRepos(ORIGIN));
  const page = await openPage(m, 37);
  pushed = true; // the contributor pushes; the page still shows 037head
  page.receive({ type: "startReview" });
  await until(() => page.state().review?.headSha === NEW_HEAD, "the review at the new head");
  for (const path of ["src/a.ts", "src/new.ts"]) {
    pr.executed.length = 0;
    page.receive({ type: "openFile", path });
    await until(() => pr.executed.some((e: any) => e.id === "vscode.diff"), `${path} to open`);
    const [, right] = pr.executed.find((e: any) => e.id === "vscode.diff").args;
    assert.match(right.query, /sha=037new/, `${path} opens at the head under review`);
    const r = await m.controller.commentingRangeProvider.provideCommentingRanges({ uri: right, lineCount: 120 });
    assert.ok(r && r.length > 0, `${path} takes comments`);
  }
  const thread = vscode.__makeThread(prUri("src/a.ts", NEW_HEAD, 37), new vscode.Range(1, 0, 1, 0));
  await vscode.commands.executeCommand("gitstudio.pr.addReviewComment", { thread, text: "hm" });
  await submit(page, "COMMENT", "");
  assert.equal(sent?.commit_id, NEW_HEAD, "pinned to the commit the diffs showed");
});

test("review: all 130 of a big pull request's files are listed, and the 130th takes a comment", async () => {
  const many = Array.from({ length: 130 }, (_, i) => ({ filename: `src/f${i}.ts`, status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@ -1,1 +1,2 @@\n a\n+b" }));
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
    ...acmeRoutes(),
  ]);
  const m = mount(fakeRepos(ORIGIN));
  const page = await startReview(m, 37);
  assert.equal(page.state().files.items.length, 130);
  assert.equal(page.state().files.truncated, false);
  assert.deepEqual(await ranges(m, "src/f129.ts", HEAD_37, 5, 37), [[0, 1]], "a file past the first 100 is commentable");
});

test("review: the palette's Submit Review opens the review's page on its box — the only review, no question", async () => {
  github(acmeRoutes());
  const m = mount(fakeRepos(ORIGIN));
  const page = await startReview(m, 37);
  pr.panels.splice(0).forEach((p: any) => p.dispose());
  await vscode.commands.executeCommand("gitstudio.pr.submitReview");
  const again = pagePanel(37);
  assert.ok(again && again !== page, "the page, opened again");
  again.receive({ type: "ready" });
  await until(() => again.state()?.focus?.open === "review", "on its review box");
  assert.deepEqual(dialogs.asked, []);
});

test("a 422 says what GitHub refused, not just \"Unprocessable Entity\"", async () => {
  github([["POST", /\/reviews$/, () => ({ status: 422, body: { message: "Unprocessable Entity", errors: ["Pull request review thread line must be part of the diff"] } })]]);
  const api = new GitHubApi({ getToken: async () => "tok" });
  await assert.rejects(
    api.submitReview("acme", "app", 37, { event: "COMMENT", body: "", comments: [{ path: "a.ts", line: 9, side: "RIGHT", body: "x" }] } as never),
    /line must be part of the diff/,
  );
});
