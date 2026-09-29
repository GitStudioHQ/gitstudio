import * as vscode from "vscode";
import { notifyCopied } from "../ui/notify";
import { promptConfirm, promptPick } from "../ui/dialogs";
import type { RepoManager } from "../git/repoManager";
import type { AiFeatures } from "../ai/aiFeatures";
import type { GraphqlFn } from "@gitstudio/engine/forge/prList";
import { GitHubAuth } from "./githubAuth";
import { GitHubApi, GitHubApiError, type PullRequest } from "./githubApi";
import { PullRequestsViewProvider, readLocalHead } from "./pullRequestsView";
import { PrContentProvider, PR_SCHEME } from "./prContentProvider";
import { PrPage, type PrPageOpen } from "./prPage";
import { ReviewController } from "./reviewMode";
import { checkoutPullRequest } from "./checkoutPr";
import { PrCreatePage } from "./prCreatePage";
import { contextFor as targetContext } from "./prTargets";
import { listGitHubRemotes, type GitHubRepoContext } from "./repoContext";

// Wires the pull request feature: GitHub auth + API, the Pull Requests list (a
// webview view: the shared packages/webview-ui list), the pull request's page
// (an editor tab: the shared page), the PR-blob content provider, review (the
// Comments API — reviews of several pull requests side by side, kept across
// a reload), checkout and create. Everything degrades gracefully: not a
// GitHub repo or not signed in → the list says so and offers what helps, and
// no command throws.
//
// A command's PR argument arrives as a { pr, ctx } object (from the list, the
// page) or is absent (from the command palette) — `resolvePr` normalises
// both. The ctx is the repository the list shows: a fork's parent by
// default, never "whichever repository is active when clicked" (a number is
// not an identity).
//
// Merging and submitting a review happen on the page, in its own boxes —
// the list's Merge and the palette's Submit Review open the page there —
// never in a question asked in the sidebar.

interface PrCommandArg {
  pr?: PullRequest;
  ctx?: GitHubRepoContext;
}

export function registerPrFeature(
  context: vscode.ExtensionContext,
  repos: RepoManager,
  brain: AiFeatures,
): { list: PullRequestsViewProvider; review: ReviewController } {
  const auth = new GitHubAuth();
  const api = new GitHubApi({ getToken: (o) => auth.getToken(o) });
  const graphql: GraphqlFn = (query, variables) => api.graphqlRaw(query, variables);
  context.subscriptions.push(auth);
  void auth.refreshConnected();

  const list = new PullRequestsViewProvider(repos, auth, context.extensionUri, context.workspaceState);
  context.subscriptions.push(list, vscode.window.registerWebviewViewProvider(PullRequestsViewProvider.viewId, list));

  // PR-blob content provider (base/head file contents for diffs).
  const contentProvider = new PrContentProvider(api);
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(PR_SCHEME, contentProvider));

  // Review (one CommentController; the pending reviews kept in the workspace's state).
  const review = new ReviewController(auth, api, graphql, context.workspaceState);
  context.subscriptions.push(review);

  /**
   * The repository the list shows — a fork's parent unless another was
   * chosen — resolved the list's way even while the view has never been
   * opened (it is collapsed until it is).
   */
  const contextNow = (): Promise<GitHubRepoContext | undefined> => list.contextResolved().catch(() => undefined);

  /**
   * The context the commands act in for owner/repo: one of the clone's
   * repositories as the list offers them (a fork's parent is fetched by its
   * URL when no remote names it), else the active clone's remote for it.
   * None when the clone has neither — its pull requests can't be checked out
   * here.
   */
  const contextFor = async (owner: string, repo: string): Promise<GitHubRepoContext | undefined> => {
    const same = (c: { owner: string; repo: string }) => `${c.owner}/${c.repo}`.toLowerCase() === `${owner}/${repo}`.toLowerCase();
    const resolved = await list.resolveTargets().catch(() => undefined);
    const t = resolved?.targets.find(same);
    if (resolved && t) return targetContext(t, resolved.entry);
    const entry = repos.getActive();
    if (!entry) return undefined;
    const remote = (await listGitHubRemotes(entry)).find(same);
    return remote ? { owner: remote.owner, repo: remote.repo, remoteName: remote.name, entry } : undefined;
  };

  const pageDeps = {
    api,
    graphql,
    review,
    extensionUri: context.extensionUri,
    list,
    localHead: async (ctx: GitHubRepoContext) => readLocalHead(ctx.entry, await listGitHubRemotes(ctx.entry)),
    contextFor,
    mergeMethod: () => vscode.workspace.getConfiguration("gitstudio.pr").get<string>("defaultMergeMethod", "squash"),
  };

  const openPage = (pr: PullRequest, ctx: GitHubRepoContext | undefined, open: PrPageOpen = {}, ref?: { owner: string; repo: string }) =>
    PrPage.show(pageDeps, ref ?? { owner: ctx!.owner, repo: ctx!.repo }, pr.number, ctx, { preview: pr, ...open });

  const createDeps = {
    api,
    graphql,
    brain,
    // A commit, pull or push made while the form is open: read (git only).
    onDidChangeRepo: repos.onDidChange,
    extensionUri: context.extensionUri,
    // The new pull request joins the list: a row patch, not a reload.
    list,
    openPr: (pr: PullRequest, ctx: GitHubRepoContext) => openPage(pr, ctx),
  };

  const resolvePr = async (arg: PrCommandArg | undefined): Promise<{ pr: PullRequest; ctx: GitHubRepoContext } | undefined> => {
    if (arg && arg.pr) {
      const ctx = arg.ctx ?? (await contextNow());
      if (ctx) {
        return { pr: arg.pr, ctx };
      }
    }
    // From the palette with no argument: ask the user to pick an open PR —
    // signed in first, so a fork's parent can be asked for.
    const entry = repos.getActive();
    if (!entry || (await listGitHubRemotes(entry)).length === 0) {
      void vscode.window.showInformationMessage("This repository isn't connected to GitHub.");
      return undefined;
    }
    if (!(await auth.getToken({ interactive: true }))) {
      return undefined;
    }
    const ctx = await contextNow();
    if (!ctx) {
      void vscode.window.showInformationMessage("This repository isn't connected to GitHub.");
      return undefined;
    }
    try {
      const pulls = (await api.listOpenPulls(ctx.owner, ctx.repo, { interactiveAuth: true })).items;
      if (pulls.length === 0) {
        void vscode.window.showInformationMessage("No open pull requests.");
        return undefined;
      }
      const picked = await promptPick({
        title: "Open pull requests",
        choices: pulls.map((p) => ({
          id: String(p.number),
          label: p.title,
          icon: p.draft ? "git-pull-request-draft" : "git-pull-request",
          detail: `#${p.number}`,
          description: p.user?.login ?? "",
        })),
      });
      const pr = pulls.find((p) => String(p.number) === picked);
      return pr ? { pr, ctx } : undefined;
    } catch (err) {
      void warn(err, "Couldn't list pull requests.");
      return undefined;
    }
  };

  /**
   * Which review a palette (or status bar, or thread title) command means:
   * the thread's, the active editor's, the only one — or the one picked.
   */
  const reviewKeyFor = async (thread: unknown, verb: string): Promise<string | undefined> => {
    const keys = review.reviewKeys();
    if (keys.length === 0) {
      void vscode.window.showInformationMessage("No review is under way. Start one from a pull request's page.");
      return undefined;
    }
    const fromThread = thread && typeof thread === "object" && "comments" in (thread as object) ? review.keyOfThread(thread as vscode.CommentThread) : undefined;
    const direct = fromThread ?? review.reviewOfActiveEditor() ?? (keys.length === 1 ? keys[0] : undefined);
    if (direct) return direct;
    return promptPick({
      title: `${verb} which review?`,
      choices: keys.map((k) => {
        const r = review.reviewInfo(k)!;
        const n = review.pendingCount(k);
        return { id: k, label: `${r.owner}/${r.repo}#${r.number}`, icon: "comment-discussion", description: r.title, detail: `${n} pending` };
      }),
    });
  };

  /** A review's page, opened on its review box. */
  const openReviewPage = async (key: string, open: PrPageOpen): Promise<void> => {
    const r = review.reviewInfo(key);
    if (!r) return;
    const ctx = await contextFor(r.owner, r.repo);
    await PrPage.show(pageDeps, { owner: r.owner, repo: r.repo }, r.number, ctx, open);
  };

  context.subscriptions.push(
    // ── Title actions ──────────────────────────────────────────────────────────
    vscode.commands.registerCommand("gitstudio.pr.refresh", () => {
      void list.refresh();
    }),
    vscode.commands.registerCommand("gitstudio.pr.signIn", async (arg?: { again?: boolean }) => {
      // `again`: GitHub refused the session there is (the list's 401 row).
      // Asked plainly, VS Code would hand that same session back.
      const token = arg?.again
        ? await auth.signInAgain("GitHub no longer accepts this sign-in. Sign in again to see pull requests.")
        : await auth.getToken({ interactive: true });
      if (token) {
        void list.refresh();
      }
    }),
    vscode.commands.registerCommand("gitstudio.pr.create", (arg?: { head?: string }) => {
      // One form, in an editor tab: where it goes, from which branch, what it
      // says and who looks at it — and what it will have.
      const entry = repos.getActive();
      if (!entry) {
        void vscode.window.showInformationMessage("Open a Git repository to open a pull request from it.");
        return;
      }
      PrCreatePage.show(createDeps, entry, typeof arg?.head === "string" ? { head: arg.head } : {});
    }),

    // ── Item actions ─────────────────────────────────────────────────────────────
    vscode.commands.registerCommand("gitstudio.pr.openDescription", async (arg?: PrCommandArg) => {
      const resolved = await resolvePr(arg);
      if (resolved) {
        await openPage(resolved.pr, resolved.ctx);
      }
    }),
    vscode.commands.registerCommand("gitstudio.pr.checkout", async (arg?: PrCommandArg) => {
      const resolved = await resolvePr(arg);
      if (!resolved) {
        return;
      }
      // The open-PR list doesn't change with a checkout: nothing to reload.
      await checkoutPullRequest(resolved.ctx, resolved.pr, { viewer: () => review.viewerLogin() });
    }),
    vscode.commands.registerCommand("gitstudio.pr.startReview", async (arg?: PrCommandArg) => {
      const resolved = await resolvePr(arg);
      if (!resolved) {
        return;
      }
      if (!(await auth.getToken({ interactive: true }))) {
        return;
      }
      await review.signedInLogin();
      const page = await openPage(resolved.pr, resolved.ctx, { tab: "files" });
      await page.startReview();
    }),
    vscode.commands.registerCommand("gitstudio.pr.submitReview", async (thread?: unknown) => {
      const key = await reviewKeyFor(thread, "Submit");
      if (key) await openReviewPage(key, { open: "review" });
    }),
    vscode.commands.registerCommand("gitstudio.pr.cancelReview", async () => {
      const key = await reviewKeyFor(undefined, "Discard");
      if (!key) return;
      const r = review.reviewInfo(key)!;
      const n = review.pendingCount(key);
      if (n > 0) {
        const ok = await promptConfirm({
          title: `Discard ${n} pending comment${n === 1 ? "" : "s"} on #${r.number}?`,
          message: "They haven't been sent to GitHub, and discarding them can't be undone.",
          confirmLabel: "Discard",
          danger: true,
        });
        if (!ok) return;
      }
      review.discard(key);
    }),
    // The comment is signed with the account's login, read once.
    vscode.commands.registerCommand("gitstudio.pr.addReviewComment", (reply: vscode.CommentReply) =>
      review.signedInLogin().then(
        () => review.addComment(reply),
        () => review.addComment(reply),
      ),
    ),
    vscode.commands.registerCommand("gitstudio.pr.addSingleComment", (reply: vscode.CommentReply) => void review.addSingleComment(reply)),
    vscode.commands.registerCommand(
      "gitstudio.pr.deleteReviewComment",
      // From comments/comment/title VS Code passes OUR comment object — which
      // keeps its parent thread; from elsewhere, a thread.
      (arg: unknown) => review.deleteComment(arg),
    ),
    vscode.commands.registerCommand("gitstudio.pr.replyThread", (reply: vscode.CommentReply) => void review.replyFromEditor(reply)),
    vscode.commands.registerCommand("gitstudio.pr.resolveThread", (thread?: vscode.CommentThread) => void review.resolveFromEditor(thread, true)),
    vscode.commands.registerCommand("gitstudio.pr.unresolveThread", (thread?: vscode.CommentThread) => void review.resolveFromEditor(thread, false)),
    vscode.commands.registerCommand("gitstudio.pr.openOnGitHub", async (arg?: PrCommandArg) => {
      const resolved = await resolvePr(arg);
      if (resolved) {
        void vscode.env.openExternal(vscode.Uri.parse(resolved.pr.htmlUrl));
      }
    }),
    vscode.commands.registerCommand("gitstudio.pr.copyUrl", async (arg?: PrCommandArg) => {
      const resolved = await resolvePr(arg);
      if (resolved) {
        await vscode.env.clipboard.writeText(resolved.pr.htmlUrl);
        notifyCopied(`the link to pull request #${resolved.pr.number}`);
      }
    }),
    vscode.commands.registerCommand("gitstudio.pr.merge", async (arg?: PrCommandArg) => {
      // The merge box is the page's: which methods the repository allows,
      // what each does, the commit title, the branch — then Confirm.
      const resolved = await resolvePr(arg);
      if (resolved) {
        await openPage(resolved.pr, resolved.ctx, { open: "merge" });
      }
    }),
  );
  return { list, review };
}

async function warn(err: unknown, fallback: string): Promise<void> {
  const msg = err instanceof GitHubApiError ? err.message : fallback;
  void vscode.window.showWarningMessage(msg);
}
