// The pull request page's host (src/pr/prPage.ts), driven directly: PrPage
// with the REAL GitHubApi against the fake api.github.com (GitHub's own
// shapes, REST and GraphQL) and a recording review controller — so every
// message the page sends GitHub, every state it is sent, and every command
// it runs in the editor can be read back. prFeature.test.ts drives the same
// page through the list; this file covers the rows of its state table that
// one does not: refusals and their way out, Checkout, Update branch, Delete
// branch, a stale read, and the smaller page messages.

import { acmeRoutes, github, pr, PULLS, until, vscode, world } from "./prTestKit";
import { test } from "node:test";
import assert from "node:assert/strict";
import { graphqlWorld, rawPull, type FakeRequest, type Route } from "./fakeGitHub";

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports -- the stand-in's objects, loaded after it */
const { PrPage, pageFailure, restPullOf } = require("../src/pr/prPage") as typeof import("../src/pr/prPage");
const { GitHubApi } = require("../src/pr/githubApi") as typeof import("../src/pr/githubApi");
/* eslint-enable @typescript-eslint/no-require-imports */

const isPageQuery = (req: FakeRequest) => req.path === "/graphql" && /pullRequest\(number: \$n\)/.test(String((req.body as any)?.query ?? ""));

// ── A recording review controller ───────────────────────────────────────────

function fakeReview(over: Record<string, unknown> = {}) {
  const changed = new vscode.EventEmitter();
  const threadChanged = new vscode.EventEmitter();
  const calls: Record<string, unknown[][]> = { know: [], showThreads: [], discard: [], reply: [], resolve: [], openFile: [], start: [], submit: [] };
  const review: any = {
    calls,
    fireThread: (e: unknown) => threadChanged.fire(e),
    onDidChange: changed.event,
    onDidChangeThread: threadChanged.event,
    pendingFor: () => undefined,
    know: (...a: unknown[]) => void calls.know.push(a),
    showThreads: (...a: unknown[]) => void calls.showThreads.push(a),
    discard: (...a: unknown[]) => void calls.discard.push(a),
    replyToThread: async (...a: unknown[]) => void calls.reply.push(a),
    resolveThread: async (...a: unknown[]) => void calls.resolve.push(a),
    openFile: async (...a: unknown[]) => (calls.openFile.push(a), true),
    start: async (...a: unknown[]) => (calls.start.push(a), true),
    submit: async (...a: unknown[]) => (calls.submit.push(a), { ok: true, id: "PRR_1", url: "https://github.com/acme/app/pull/37#pullrequestreview-1", submittedAt: "2026-09-27T00:00:00Z" }),
    ...over,
  };
  return review;
}

const ctxOf = (root = "/work/app") => ({ owner: "acme", repo: "app", remoteName: "origin", entry: { root, ctx: { root } } }) as any;

interface Opened {
  page: any;
  panel: any;
  review: any;
  marks: unknown[][];
  gh: any;
}

/** acme/app#n's page, shown with the given deps, loaded and in sight. */
async function openDirect(n: number, opts: { routes?: Route[]; ctx?: any; review?: any; deps?: Record<string, unknown>; open?: any } = {}): Promise<Opened> {
  const gh = github(opts.routes ?? acmeRoutes());
  const api = new GitHubApi({ getToken: async () => "tok" });
  const review = opts.review ?? fakeReview();
  const marks: unknown[][] = [];
  const deps = {
    api,
    graphql: (q: string, v: Record<string, unknown>) => api.graphqlRaw(q, v),
    review,
    extensionUri: vscode.Uri.file("/ext"),
    list: { markKind: (...a: unknown[]) => void marks.push(a) },
    ...(opts.deps ?? {}),
  };
  const page = await PrPage.show(deps as any, { owner: "acme", repo: "app" }, n, opts.ctx, opts.open ?? {});
  const panel = pr.panels.find((p: any) => p.title === `acme/app#${n}`);
  panel.receive({ type: "ready" });
  await page.loaded();
  await until(() => ["ready", "message"].includes(panel.state()?.status) && !panel.state()?.refreshing, `#${n}'s page`);
  return { page, panel, review, marks, gh };
}

const noticeOf = (panel: any) => panel.state().notice;
/** Some state the page was ever sent matches. */
const everPosted = (panel: any, pred: (s: any) => boolean) => panel.posted.some((m: any) => m?.type === "state" && pred(m.state));

// ── pageFailure: what a first read that failed says ────────────────────────

test("a first read GitHub refused offers the one way out: SSO's authorize page, else the PR on GitHub", () => {
  const sso = pageFailure({ kind: "auth", status: 403, message: "Resource protected by SAML", helpUrl: "https://github.com/orgs/acme/sso" }, "acme/app", 5);
  assert.equal(sso.title, "GitHub refused to show acme/app#5");
  assert.equal(sso.detail, "Resource protected by SAML");
  assert.deepEqual(
    sso.buttons!.map((b: any) => [b.label, b.action]),
    [
      ["Authorize on GitHub", { kind: "openUrl", url: "https://github.com/orgs/acme/sso" }],
      ["Retry", { kind: "retry" }],
    ],
  );
  const plain = pageFailure({ kind: "forbidden", message: "Forbidden" }, "acme/app", 5);
  assert.deepEqual(plain.buttons![0].action, { kind: "openUrl", url: "https://github.com/acme/app/pull/5" });
  assert.equal(plain.buttons![0].label, "Open on GitHub");
});

test("each other failure of a first read is said in its own words", () => {
  const expired = pageFailure({ kind: "auth", status: 401, message: "x" }, "acme/app", 5);
  assert.equal(expired.title, "Your GitHub session expired");
  assert.equal(expired.detail, "Sign in again to see acme/app#5.");
  const missing = pageFailure({ kind: "not-found", message: "Not Found." }, "acme/app", 5);
  assert.equal(missing.title, "GitHub has no pull request acme/app#5");
  assert.match(missing.detail!, /^Not Found\. A private repository needs a sign-in/);
  const limited = pageFailure({ kind: "rate-limit", message: "Try later." }, "acme/app", 5);
  assert.deepEqual([limited.icon, limited.title], ["clock", "GitHub's rate limit was reached"]);
  const offline = pageFailure({ kind: "network", message: "x" }, "acme/app", 5);
  assert.deepEqual([offline.title, offline.buttons![0].primary], ["Couldn't reach GitHub", true]);
  const other = pageFailure({ kind: "server", message: "Boom" }, "acme/app", 5);
  assert.deepEqual([other.title, other.detail], ["Couldn't load acme/app#5", "Boom"]);
});

// ── restPullOf: the page's pull request, as the PR commands take it ─────────

test("restPullOf hands the commands a fork's head by its owner, and only the reviewers still requested", () => {
  const d: any = {
    number: 9,
    title: "Fix",
    body: "b",
    state: "open",
    draft: false,
    url: "https://github.com/acme/app/pull/9",
    author: { login: "alice", avatarUrl: "https://a/alice.png" },
    createdAt: "c",
    updatedAt: "u",
    mergedAt: null,
    headRef: "main",
    headSha: "hsha",
    headOwner: "alice",
    headRepo: "alice/app",
    baseRef: "main",
    baseSha: "bsha",
    labels: [{ name: "bug", color: "red" }],
    reviewers: [
      { login: "bob", avatarUrl: null, requested: true },
      { login: "carol", avatarUrl: "https://a/c.png", requested: false, verdict: "APPROVED" },
      { login: null, requested: true },
    ],
    maintainerCanModify: true,
    additions: 1,
    deletions: 2,
    changedFiles: 3,
  };
  const p = restPullOf(d, "acme/app");
  assert.deepEqual(p.head, { ref: "main", sha: "hsha", label: "alice:main", repoFullName: "alice/app", cloneUrl: "https://github.com/alice/app.git" });
  assert.deepEqual(p.base, { ref: "main", sha: "bsha", label: "acme:main", repoFullName: "acme/app", cloneUrl: "https://github.com/acme/app.git" });
  assert.deepEqual(p.user, { login: "alice", avatarUrl: "https://a/alice.png", htmlUrl: "https://github.com/alice" });
  assert.deepEqual(p.requestedReviewers, [{ login: "bob", avatarUrl: null, htmlUrl: "https://github.com/bob" }]);
  assert.equal(p.htmlUrl, d.url);
  assert.deepEqual([p.maintainerCanModify, p.additions, p.deletions, p.changedFiles], [true, 1, 2, 3]);

  const own = restPullOf({ ...d, author: null, headOwner: null, headRepo: null }, "acme/app");
  assert.equal(own.user, null);
  assert.equal(own.head.label, "acme:main", "a head with no owner of its own is the base repository's");
  assert.equal(own.head.cloneUrl, null);
});

// ── Reading ────────────────────────────────────────────────────────────────

test("files GitHub couldn't list are said on the Files tab; the conversation still shows", async () => {
  const { panel } = await openDirect(37, { routes: [["GET", /\/pulls\/37\/files/, () => ({ status: 500, body: { message: "Files are on fire" } })], ...acmeRoutes()] });
  const s = panel.state();
  assert.equal(s.status, "ready");
  assert.equal(s.pr.title, "Drop Commit");
  assert.deepEqual(s.files, { items: [], truncated: false, error: "Files are on fire" });
});

test("a refresh refused with 401 keeps the page and offers Sign in again — which signs in and reads again", async () => {
  let expired = false;
  const answer = graphqlWorld(world());
  const { panel, gh } = await openDirect(37, {
    routes: [["POST", /^\/graphql$/, (req) => (expired && isPageQuery(req) ? { status: 401, body: { message: "Bad credentials" } } : answer(req))], ...acmeRoutes()],
  });
  expired = true;
  panel.receive({ type: "refresh" });
  await until(() => !!noticeOf(panel), "the notice");
  assert.equal(panel.state().status, "ready", "the page stays");
  assert.match(noticeOf(panel).title, /^Couldn't refresh: Your GitHub session expired/);
  assert.deepEqual(noticeOf(panel).buttons, [{ label: "Sign in again", icon: "sign-in", action: { kind: "signIn", again: true } }]);

  expired = false;
  const reads = gh.requests.filter(isPageQuery).length;
  panel.receive({ type: "action", action: { kind: "signIn", again: true } });
  await until(() => pr.executed.some((e: any) => e.id === "gitstudio.pr.signIn"), "the sign-in");
  assert.deepEqual(pr.executed.find((e: any) => e.id === "gitstudio.pr.signIn").args, [{ again: true }]);
  await until(() => gh.requests.filter(isPageQuery).length > reads, "the read after signing in");
});

test("a read asked before the page closed the PR is thrown away and asked again — never painted over Closed", async () => {
  // GitHub's answer is decided when it is ASKED: closed once the close has reached it.
  let patchSeen = false;
  const answerAt = (req: any) =>
    graphqlWorld(world({ "acme/app": { pulls: () => PULLS().map((p) => (req.closedAtAsk && p.number === 37 ? { ...p, state: "closed" } : p)) } }))(req);
  const { panel, gh } = await openDirect(37, { routes: [["PATCH", /\/pulls\/37$/, () => ({ body: {} })], ["POST", /^\/graphql$/, answerAt], ...acmeRoutes()] });
  const before = gh.requests.filter(isPageQuery).length;

  const holdPatch = gh.hold((r: any) => {
    if (isPageQuery(r)) r.closedAtAsk = patchSeen;
    if (r.method !== "PATCH") return false;
    patchSeen = true;
    return true;
  });
  const holdRead = gh.hold(isPageQuery);
  panel.receive({ type: "refresh" });
  await until(() => holdRead.held() === 1, "the read in flight");
  panel.receive({ type: "close" });
  await until(() => holdPatch.held() === 1, "the close in flight");
  assert.equal(panel.state().pr.kind, "closed");
  const from = panel.posted.length;
  holdRead.release(); // answers Open: it was asked before the close
  await until(() => gh.requests.filter(isPageQuery).length >= before + 2, "the read asked again");
  await until(() => !panel.state().refreshing, "the second read to land");
  assert.equal(panel.state().pr.kind, "closed");
  assert.equal(
    panel.posted.slice(from).some((m: any) => m?.type === "state" && m.state.pr?.kind === "open"),
    false,
    "the stale answer was never painted",
  );
  holdPatch.release();
  await until(() => !panel.state().busy.includes("close"), "the close to finish");
});

// ── Small messages ─────────────────────────────────────────────────────────

test("tab, Open on GitHub, Copy link and links: each does what it says, and nothing off github.com is opened", async () => {
  const { panel } = await openDirect(37);
  panel.receive({ type: "tab", tab: "files" });
  panel.receive({ type: "tab", tab: "nonsense" });
  panel.receive({ type: "refresh" });
  await until(() => !panel.state().refreshing && panel.state().tab === "files", "the tab kept");

  panel.receive({ type: "openOnGitHub" });
  await until(() => pr.opened.length === 1, "GitHub's page");
  assert.equal(pr.opened[0], "https://github.com/acme/app/pull/37");

  panel.receive({ type: "copyLink" });
  await until(() => pr.clipboard === "https://github.com/acme/app/pull/37", "the link on the clipboard");
  assert.ok(pr.said.some((s: any) => s.kind === "status" && /pull request #37/.test(s.message)), "confirmed in the status bar");

  panel.receive({ type: "openUrl", url: "javascript:alert(1)" });
  panel.receive({ type: "openUrl", url: "https://example.com/docs" });
  panel.receive({ type: "action", action: { kind: "openUrl", url: "https://evil.example/x" } });
  panel.receive({ type: "action", action: { kind: "openUrl", url: "https://github.com/acme/app/settings" } });
  await until(() => pr.opened.length === 3, "the two links that may open");
  assert.deepEqual(pr.opened.slice(1), ["https://example.com/docs", "https://github.com/acme/app/settings"]);
});

test("Open on GitHub and Copy link work for a page that never loaded", async () => {
  const { panel } = await openDirect(37, { routes: [["POST", /^\/graphql$/, () => ({ status: 500, body: { message: "down" } })], ...acmeRoutes()] });
  assert.equal(panel.state().status, "message");
  panel.receive({ type: "openOnGitHub" });
  panel.receive({ type: "copyLink" });
  await until(() => pr.opened.length === 1 && pr.clipboard === "https://github.com/acme/app/pull/37", "the constructed URL");
  assert.equal(pr.opened[0], "https://github.com/acme/app/pull/37");
});

test("Discard review from the page discards THIS pull request's review", async () => {
  const { panel, review } = await openDirect(37);
  panel.receive({ type: "discardReview" });
  await until(() => review.calls.discard.length === 1, "the discard");
  assert.deepEqual(review.calls.discard[0], ["acme/app#37"]);
});

test("a file no longer in the PR says so; a review that can't start says so", async () => {
  const { panel } = await openDirect(37, { review: fakeReview({ openFile: async () => false, start: async () => false }) });
  panel.receive({ type: "openFile", path: "src/zzz.ts", line: 3, side: "LEFT" });
  await until(() => pr.said.some((s: any) => s.kind === "info"), "the message");
  assert.equal(pr.said.find((s: any) => s.kind === "info").message, "src/zzz.ts isn't among #37's changed files any more.");
  panel.receive({ type: "startReview" });
  await until(() => pr.said.some((s: any) => s.kind === "warning"), "the warning");
  assert.match(pr.said.find((s: any) => s.kind === "warning").message, /^#37's changed files couldn't be read/);
  assert.equal(panel.state().tab, "files", "the Files tab shows all the same");
});

// ── Checkout ───────────────────────────────────────────────────────────────

test("Checkout with no remote for the repository says so and runs nothing", async () => {
  const { panel } = await openDirect(37, { deps: { contextFor: async () => undefined } });
  panel.receive({ type: "checkout" });
  await until(() => pr.said.some((s: any) => s.kind === "warning"), "the warning");
  assert.equal(pr.said.find((s: any) => s.kind === "warning").message, "This repository has no remote for acme/app, so its pull requests can't be checked out here.");
  assert.equal(pr.executed.filter((e: any) => e.id === "gitstudio.pr.checkout").length, 0);
});

test("Checkout runs the checkout command on the page's PR, busy while it runs — then the page reads Checked out", async () => {
  let branch = "main";
  const ctx = ctxOf();
  const heads: unknown[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const original = pr.commands.get("gitstudio.pr.checkout");
  let got: any;
  pr.commands.set("gitstudio.pr.checkout", async (arg: any) => {
    got = arg;
    await gate;
    branch = "feature-37";
  });
  try {
    const { panel } = await openDirect(37, {
      ctx: undefined,
      deps: {
        contextFor: async (o: string, r: string) => (heads.push([o, r]), ctx),
        localHead: async (c: any) => {
          assert.equal(c, ctx);
          return { branch };
        },
      },
    });
    await until(() => heads.length > 0, "the context looked up");
    assert.equal(panel.state().checkedOut, false);
    panel.receive({ type: "checkout" });
    await until(() => !!got, "the command");
    assert.ok(panel.state().busy.includes("checkout"), "busy while it runs");
    panel.receive({ type: "checkout" }); // a second press while busy: ignored
    assert.equal(got.ctx, ctx);
    assert.equal(got.pr.number, 37);
    assert.equal(got.pr.head.ref, "feature-37");
    assert.equal(got.pr.head.sha, "037head");
    assert.equal(got.pr.base.repoFullName, "acme/app");
    release();
    await until(() => panel.state().checkedOut === true, "Checked out");
    assert.equal(panel.state().busy.includes("checkout"), false);
    assert.deepEqual(heads[0], ["acme", "app"]);
  } finally {
    if (original) pr.commands.set("gitstudio.pr.checkout", original);
    else pr.commands.delete("gitstudio.pr.checkout");
  }
});

// ── Update branch ──────────────────────────────────────────────────────────

test("Update branch asks GitHub to merge the base in at the head the page showed, and says it is under way", async () => {
  const sent: any[] = [];
  const { panel } = await openDirect(37, {
    routes: [["PUT", /\/pulls\/37\/update-branch$/, (req) => (sent.push(req.body), { status: 202, body: {} })], ...acmeRoutes()],
  });
  panel.receive({ type: "updateBranch" });
  await until(() => !!noticeOf(panel), "the notice");
  assert.deepEqual(sent, [{ expected_head_sha: "037head" }]);
  assert.equal(noticeOf(panel).title, "GitHub is merging main into feature-37");
  assert.equal(panel.state().pr.mergeState, "UNKNOWN", "mergeability is being worked out again");
  assert.equal(panel.state().busy.includes("updateBranch"), false);
});

test("Update branch refused says why, with GitHub's page as the way out", async () => {
  const { panel } = await openDirect(37, {
    routes: [["PUT", /\/pulls\/37\/update-branch$/, () => ({ status: 422, body: { message: "expected head sha didn't match current head ref" } })], ...acmeRoutes()],
  });
  panel.receive({ type: "updateBranch" });
  await until(() => !!noticeOf(panel), "the notice");
  assert.equal(noticeOf(panel).title, "Couldn't update the branch: expected head sha didn't match current head ref.");
  assert.deepEqual(noticeOf(panel).buttons, [{ label: "Open on GitHub", icon: "link-external", action: { kind: "openUrl", url: "https://github.com/acme/app/pull/37" } }]);
  assert.notEqual(panel.state().pr.mergeState, "UNKNOWN");
});

// ── Merge, and its branch ──────────────────────────────────────────────────

test("Merge with Delete branch deletes the head on GitHub; a refused delete says the PR is merged and the branch stays", async () => {
  let refuseDelete = false;
  const deleted: string[] = [];
  const { panel, marks } = await openDirect(37, {
    routes: [
      ["PUT", /\/pulls\/37\/merge$/, () => ({ body: { merged: true } })],
      ["DELETE", /\/git\/refs\/heads\//, (req) => (deleted.push(req.path), refuseDelete ? { status: 422, body: { message: "Reference does not exist" } } : { status: 204 })],
      ...acmeRoutes(),
    ],
  });
  panel.receive({ type: "merge", method: "squash", title: "Drop Commit (#37)", deleteBranch: true });
  await until(() => deleted.length === 1, "the delete");
  assert.equal(deleted[0], "/repos/acme/app/git/refs/heads/feature-37");
  assert.deepEqual(marks[0], ["acme", "app", 37, "merged"]);
  await until(() => !panel.state().busy.includes("merge"), "the merge to finish");

  // Again, on a fresh page, with GitHub refusing the delete.
  for (const p of pr.panels.splice(0)) p.dispose();
  refuseDelete = true;
  const again = await openDirect(37, {
    routes: [
      ["PUT", /\/pulls\/37\/merge$/, () => ({ body: { merged: true } })],
      ["DELETE", /\/git\/refs\/heads\//, (req) => (deleted.push(req.path), { status: 422, body: { message: "Reference does not exist" } })],
      ...acmeRoutes(),
    ],
  });
  again.panel.receive({ type: "merge", method: "squash", title: "", deleteBranch: true });
  await until(() => !!noticeOf(again.panel), "the notice");
  assert.equal(noticeOf(again.panel).title, "Couldn't delete feature-37: Reference does not exist.");
  assert.equal(noticeOf(again.panel).detail, "#37 is merged; its branch is still on GitHub.");
  assert.equal(everPosted(again.panel, (s) => s.notice?.title?.startsWith("Couldn't delete") && s.pr.kind === "merged"), true, "said on a page that reads Merged");
});

test("a fork's pull request, merged with Delete branch, never deletes a branch in the base repository", async () => {
  const fork = rawPull(40, { head: { ref: "main", sha: "040head", label: "alice:main", repo: { full_name: "alice/app", clone_url: "https://github.com/alice/app.git" } } });
  const deleted: string[] = [];
  const { panel } = await openDirect(40, {
    routes: [
      ["PUT", /\/pulls\/40\/merge$/, () => ({ body: { merged: true } })],
      ["DELETE", /./, (req) => (deleted.push(req.path), { status: 204 })],
      ...acmeRoutes([], world({ "acme/app": { pulls: () => [...PULLS(), fork] } })),
    ],
  });
  panel.receive({ type: "merge", method: "merge", title: "", deleteBranch: true });
  await until(() => everPosted(panel, (s) => s.pr?.kind === "merged"), "merged");
  await until(() => !panel.state().busy.includes("merge") && !panel.state().refreshing, "the merge to settle");
  assert.deepEqual(deleted, []);
});

// ── Refusals ───────────────────────────────────────────────────────────────

test("a Close refused with 401 goes back to open and offers Sign in again", async () => {
  const { panel, marks } = await openDirect(37, { routes: [["PATCH", /\/pulls\/37$/, () => ({ status: 401, body: {} })], ...acmeRoutes()] });
  panel.receive({ type: "close" });
  await until(() => !!noticeOf(panel), "the notice");
  assert.equal(panel.state().pr.kind, "open");
  assert.equal(noticeOf(panel).detail, "It is still open.");
  assert.deepEqual(noticeOf(panel).buttons.map((b: any) => b.label), ["Sign in again"]);
  assert.deepEqual(marks, [], "the list is told nothing of a close that didn't happen");
});

test("Mark ready refused puts the draft back and says it is still a draft", async () => {
  const answer = graphqlWorld(world());
  const { panel, marks } = await openDirect(36, {
    routes: [
      ["POST", /^\/graphql$/, (req) => (/markPullRequestReadyForReview/.test((req.body as any).query) ? { status: 403, body: { message: "Must have admin rights" } } : answer(req))],
      ...acmeRoutes(),
    ],
  });
  assert.equal(panel.state().pr.kind, "draft");
  panel.receive({ type: "markReady" });
  await until(() => !!noticeOf(panel), "the notice");
  assert.equal(panel.state().pr.kind, "draft");
  assert.equal(noticeOf(panel).title, "Couldn't mark #36 ready for review: Must have admin rights");
  assert.equal(noticeOf(panel).detail, "It is still a draft.");
  assert.deepEqual(marks, []);
});

test("a comment GitHub answers without an author is drawn as the viewer's", async () => {
  const { panel } = await openDirect(37, { routes: [["POST", /issues\/37\/comments$/, () => ({ status: 201, body: { id: 5, html_url: "https://github.com/c/5", created_at: "2026-09-27T00:00:00Z" } })], ...acmeRoutes()] });
  panel.receive({ type: "comment", body: "  Looks good  " });
  await until(() => panel.state().pr.timeline.some((t: any) => t.id === "5"), "the posted comment");
  const c = panel.state().pr.timeline.find((t: any) => t.id === "5");
  assert.equal(c.body, "Looks good");
  assert.equal(c.author.login, "me");
  assert.equal(c.sending, undefined);
});

// ── Threads ────────────────────────────────────────────────────────────────

const THREAD = {
  id: "T_1",
  path: "src/a.ts",
  line: 2,
  startLine: null,
  originalLine: 2,
  diffSide: "RIGHT",
  isResolved: false,
  isOutdated: false,
  viewerCanResolve: true,
  viewerCanUnresolve: false,
  viewerCanReply: true,
  resolvedBy: null,
  comments: { totalCount: 1, nodes: [{ id: "C_1", author: { login: "dana" }, body: "Why?", createdAt: "2026-09-26T10:00:00Z", url: "u" }] },
};
const threadRoutes = () => acmeRoutes([], world({ "acme/app": { pulls: PULLS, page: { 37: { threads: [THREAD] } } } }));

test("a Resolve GitHub refuses comes back unresolved and says so", async () => {
  const review = fakeReview({
    resolveThread: async () => {
      throw new Error("socket hang up");
    },
  });
  const { panel } = await openDirect(37, { routes: threadRoutes(), review });
  assert.equal(panel.state().pr.threads[0].resolved, false);
  panel.receive({ type: "resolve", threadId: "T_1", resolved: true });
  await until(() => !!noticeOf(panel), "the notice");
  assert.equal(panel.state().pr.threads[0].resolved, false);
  assert.equal(noticeOf(panel).title, "Couldn't resolve the conversation: GitHub didn't answer.");
  assert.equal(panel.state().busy.includes("resolve:T_1"), false);
});

test("a thread the editor changes is patched on the page; one the page doesn't have is ignored", async () => {
  const { panel, review } = await openDirect(37, { routes: threadRoutes() });
  const t = panel.state().pr.threads[0];
  const posts = panel.posted.length;
  review.fireThread({ key: "acme/app#37", thread: { ...t, id: "T_other", resolved: true } });
  review.fireThread({ key: "acme/app#99", thread: { ...t, resolved: true } });
  assert.equal(panel.posted.length, posts, "nothing to patch");
  review.fireThread({ key: "acme/app#37", thread: { ...t, resolved: true, resolvedBy: "me" } });
  assert.equal(panel.state().pr.threads[0].resolved, true);
  assert.equal(panel.state().pr.threads[0].resolvedBy, "me");
});

test("the page tells the review what it read: the files, the merge base, the threads", async () => {
  const { review } = await openDirect(37, { routes: [["GET", /\/compare\/basesha\.\.\.037head/, () => ({ body: { merge_base_commit: { sha: "mb37" } } })], ...threadRoutes()] });
  await until(() => review.calls.know.length > 0, "the review told");
  const k: any = review.calls.know[0][0];
  assert.deepEqual([k.owner, k.repo, k.number, k.headSha, k.baseSha], ["acme", "app", 37, "037head", "mb37"]);
  assert.deepEqual(k.files.map((f: any) => f.filename), ["src/a.ts", "docs/gone.md", "src/new.ts"]);
  assert.equal(review.calls.showThreads[0][0], "acme/app#37");
  assert.deepEqual((review.calls.showThreads[0][1] as any[]).map((t) => t.id), ["T_1"]);
});

// ── Commits ────────────────────────────────────────────────────────────────

test("a commit whose files GitHub won't list says why; a sha not in the PR asks nothing", async () => {
  let asked = 0;
  const { panel } = await openDirect(37, {
    routes: [["GET", /\/commits\/037head$/, () => (asked++, { status: 500, body: { message: "Commit too big" } })], ...acmeRoutes()],
  });
  panel.receive({ type: "expandCommit", sha: "deadbeef" });
  panel.receive({ type: "expandCommit", sha: "037head" });
  await until(() => panel.state().commitFiles["037head"]?.status === "failed", "the failure");
  assert.deepEqual(panel.state().commitFiles["037head"], { status: "failed", error: "Commit too big" });
  assert.equal(panel.state().commitFiles.deadbeef, undefined);
  assert.equal(asked, 1);
  // A file of a commit never expanded opens nothing.
  panel.receive({ type: "openCommitFile", sha: "deadbeef", path: "x" });
  assert.equal(pr.shown.length, 0);
});

// ── Review, submitted ──────────────────────────────────────────────────────

test("a review submitted from the page is drawn at once, the viewer's verdict replaces their old one", async () => {
  const review = fakeReview();
  const { panel } = await openDirect(37, {
    review,
    routes: acmeRoutes([], world({ "acme/app": { pulls: PULLS, page: { 37: { reviews: [{ author: { login: "me" }, state: "COMMENTED", submittedAt: "2026-09-25T00:00:00Z" }] } } } })),
  });
  panel.receive({ type: "submitReview", event: "REQUEST_CHANGES", body: " Please fix " });
  await until(() => everPosted(panel, (x) => x.sent?.key === "review"), "the review sent");
  const s = panel.posted.find((m: any) => m?.type === "state" && m.state.sent?.key === "review").state;
  const r = s.pr.timeline.find((t: any) => t.kind === "review");
  assert.deepEqual([r.id, r.state, r.body, r.url], ["PRR_1", "CHANGES_REQUESTED", "Please fix", "https://github.com/acme/app/pull/37#pullrequestreview-1"]);
  const mine = s.pr.reviewers.filter((x: any) => x.login === "me");
  assert.equal(mine.length, 1);
  assert.equal(mine[0].verdict, "CHANGES_REQUESTED");
  assert.deepEqual((review.calls.submit[0] as any[]).slice(0, 3), ["acme/app#37", "REQUEST_CHANGES", " Please fix "]);
  assert.ok(pr.said.some((x: any) => x.message === "Review submitted on #37: changes requested."));
});

test("a review GitHub refuses keeps its comments and says why, ending the sentence once", async () => {
  const { panel } = await openDirect(37, { review: fakeReview({ submit: async () => ({ ok: false, message: "Review body is required" }) }) });
  panel.receive({ type: "submitReview", event: "COMMENT", body: "" });
  await until(() => !!noticeOf(panel), "the notice");
  assert.equal(noticeOf(panel).title, "Couldn't submit your review");
  assert.equal(noticeOf(panel).detail, "Review body is required. Your comments are kept.");
  assert.equal(panel.state().busy.includes("review"), false);
});

// ── One tab per PR ─────────────────────────────────────────────────────────

test("showing an open page again reveals it, adopts the context it is given, and opens where it is told", async () => {
  const { page, panel } = await openDirect(37);
  const ctx = ctxOf("/work/other");
  const api = new GitHubApi({ getToken: async () => "tok" });
  const again = await PrPage.show({ api } as any, { owner: "ACME", repo: "App" }, 37, ctx, { tab: "checks" });
  assert.equal(again, page, "the same page, whatever the case of its name");
  assert.equal(panel.reveals, 1);
  assert.equal(panel.state().tab, "checks");
  assert.equal(panel.state().focus.tab, "checks");
  assert.equal(PrPage.get("acme", "app", 37), page);
  panel.dispose();
  assert.equal(PrPage.get("acme", "app", 37), undefined, "a closed page is forgotten");
});
