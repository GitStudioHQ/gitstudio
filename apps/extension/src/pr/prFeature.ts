import * as vscode from "vscode";
import type { RepoManager } from "../git/repoManager";
import type { GitBrain } from "../ai/gitBrain";
import { GitHubAuth } from "./githubAuth";
import { GitHubApi, GitHubApiError, type MergeMethod, type PullRequest } from "./githubApi";
import { PullRequestsTreeProvider, PrNode } from "./pullRequestsView";
import { PrContentProvider, PR_SCHEME } from "./prContentProvider";
import { PrDescriptionPanel } from "./prDescriptionPanel";
import { ReviewController } from "./reviewMode";
import { checkoutPullRequest } from "./checkoutPr";
import { createPullRequest } from "./createPr";
import { resolveGitHubContext, type GitHubRepoContext } from "./repoContext";

// Wires the whole M11 PR feature: GitHub auth + API, the Pull Requests tree, the
// PR-blob content provider, the description panel, review mode (Comments API),
// checkout, merge, and create. Everything degrades gracefully: not a GitHub
// repo or not signed in → the view is empty + the connect-prompt shows, and no
// command throws.
//
// A command's PR argument may arrive as a PrNode (from the tree), as a
// { pr, ctx } object (from the description panel / review), or be absent (from
// the command palette) — `resolvePr` normalises all three.

interface PrCommandArg {
  pr?: PullRequest;
  ctx?: GitHubRepoContext;
}

export function registerPrFeature(
  context: vscode.ExtensionContext,
  repos: RepoManager,
  brain: GitBrain,
): void {
  const auth = new GitHubAuth();
  const api = new GitHubApi({ getToken: (o) => auth.getToken(o) });
  context.subscriptions.push(auth);
  void auth.refreshConnected();

  const tree = new PullRequestsTreeProvider(repos, auth);
  context.subscriptions.push(tree);
  const view = vscode.window.createTreeView("gitstudio.pullRequests", {
    treeDataProvider: tree,
    showCollapseAll: true,
  });
  context.subscriptions.push(view);

  // PR-blob content provider (base/head file contents for diffs).
  const contentProvider = new PrContentProvider(auth);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      PR_SCHEME,
      contentProvider,
    ),
  );

  // Review mode (one CommentController + the pending-thread registry).
  const review = new ReviewController(auth, api);
  context.subscriptions.push(review);

  /** Resolve a PR + its GitHub context from any command argument shape. */
  const resolvePr = async (
    arg: PrNode | PrCommandArg | undefined,
  ): Promise<{ pr: PullRequest; ctx: GitHubRepoContext } | undefined> => {
    if (arg instanceof PrNode) {
      return { pr: arg.pr, ctx: arg.ctx };
    }
    if (arg && arg.pr) {
      const ctx = arg.ctx ?? (await resolveGitHubContext(repos)) ?? undefined;
      if (ctx) {
        return { pr: arg.pr, ctx };
      }
    }
    // From the palette with no argument: ask the user to pick an open PR.
    const ctx = await resolveGitHubContext(repos);
    if (!ctx) {
      void vscode.window.showInformationMessage(
        "This repository isn't connected to GitHub.",
      );
      return undefined;
    }
    if (!(await auth.getToken({ interactive: true }))) {
      return undefined;
    }
    try {
      const pulls = await api.listOpenPulls(ctx.owner, ctx.repo, {
        interactiveAuth: true,
      });
      if (pulls.length === 0) {
        void vscode.window.showInformationMessage("No open pull requests.");
        return undefined;
      }
      const pick = await vscode.window.showQuickPick(
        pulls.map((p) => ({
          label: `#${p.number} ${p.title}`,
          description: p.user?.login ?? "",
          pr: p,
        })),
        { placeHolder: "Select a pull request" },
      );
      return pick ? { pr: pick.pr, ctx } : undefined;
    } catch (err) {
      void warn(err, "Couldn't list pull requests.");
      return undefined;
    }
  };

  const openDescription = async (pr: PullRequest, ctx: GitHubRepoContext) => {
    await PrDescriptionPanel.show(
      { api, ctx, extensionUri: context.extensionUri },
      pr,
    );
  };

  context.subscriptions.push(
    // ── Title actions ──────────────────────────────────────────────────────────
    vscode.commands.registerCommand("gitstudio.pr.refresh", () => {
      tree.refresh();
    }),
    vscode.commands.registerCommand("gitstudio.pr.signIn", async () => {
      const token = await auth.getToken({ interactive: true });
      if (token) {
        tree.refresh();
      }
    }),
    vscode.commands.registerCommand("gitstudio.pr.create", () =>
      createPullRequest(repos, brain, api, context.extensionUri, () =>
        tree.refresh(),
      ),
    ),

    // ── Item actions ─────────────────────────────────────────────────────────────
    vscode.commands.registerCommand(
      "gitstudio.pr.openDescription",
      async (arg?: PrNode | PrCommandArg) => {
        const resolved = await resolvePr(arg);
        if (resolved) {
          await openDescription(resolved.pr, resolved.ctx);
        }
      },
    ),
    vscode.commands.registerCommand(
      "gitstudio.pr.checkout",
      async (arg?: PrNode | PrCommandArg) => {
        const resolved = await resolvePr(arg);
        if (!resolved) {
          return;
        }
        await checkoutPullRequest(
          resolved.ctx.entry,
          resolved.ctx.remoteName,
          resolved.pr,
          () => tree.refresh(),
        );
      },
    ),
    vscode.commands.registerCommand(
      "gitstudio.pr.startReview",
      async (arg?: PrNode | PrCommandArg) => {
        const resolved = await resolvePr(arg);
        if (!resolved) {
          return;
        }
        if (!(await auth.getToken({ interactive: true }))) {
          return;
        }
        await review.startReview(resolved.ctx, resolved.pr);
      },
    ),
    vscode.commands.registerCommand("gitstudio.pr.submitReview", () =>
      review.submitReview(),
    ),
    vscode.commands.registerCommand("gitstudio.pr.cancelReview", () =>
      review.cancelReview(),
    ),
    vscode.commands.registerCommand(
      "gitstudio.pr.addReviewComment",
      (reply: vscode.CommentReply) => review.addComment(reply),
    ),
    vscode.commands.registerCommand(
      "gitstudio.pr.addSingleComment",
      (reply: vscode.CommentReply) => void review.addSingleComment(reply),
    ),
    vscode.commands.registerCommand(
      "gitstudio.pr.deleteReviewComment",
      (arg: vscode.CommentThread | { thread?: vscode.CommentThread }) => {
        // From comments/comment/title VS Code passes the comment node (which
        // carries `.thread`); from elsewhere a thread directly.
        const thread =
          arg && "thread" in arg && arg.thread
            ? arg.thread
            : (arg as vscode.CommentThread);
        if (thread) {
          review.removeThread(thread);
        }
      },
    ),
    vscode.commands.registerCommand(
      "gitstudio.pr.openOnGitHub",
      async (arg?: PrNode | PrCommandArg) => {
        const resolved = await resolvePr(arg);
        if (resolved) {
          void vscode.env.openExternal(vscode.Uri.parse(resolved.pr.htmlUrl));
        }
      },
    ),
    vscode.commands.registerCommand(
      "gitstudio.pr.copyUrl",
      async (arg?: PrNode | PrCommandArg) => {
        const resolved = await resolvePr(arg);
        if (resolved) {
          await vscode.env.clipboard.writeText(resolved.pr.htmlUrl);
          void vscode.window.showInformationMessage("PR URL copied.");
        }
      },
    ),
    vscode.commands.registerCommand(
      "gitstudio.pr.merge",
      async (arg?: PrNode | PrCommandArg) => {
        const resolved = await resolvePr(arg);
        if (resolved) {
          await mergePr(api, resolved.ctx, resolved.pr, () => tree.refresh());
        }
      },
    ),
  );
}

async function mergePr(
  api: GitHubApi,
  ctx: GitHubRepoContext,
  pr: PullRequest,
  onMerged: () => void,
): Promise<void> {
  const configured = vscode.workspace
    .getConfiguration("gitstudio.pr")
    .get<MergeMethod>("defaultMergeMethod", "squash");

  const methods: { label: string; method: MergeMethod }[] = [
    { label: "$(git-merge) Create a merge commit", method: "merge" },
    { label: "$(git-commit) Squash and merge", method: "squash" },
    { label: "$(git-pull-request) Rebase and merge", method: "rebase" },
  ];
  // Surface the configured default first.
  methods.sort((a, b) =>
    a.method === configured ? -1 : b.method === configured ? 1 : 0,
  );

  const pick = await vscode.window.showQuickPick(methods, {
    placeHolder: `Merge PR #${pr.number} "${pr.title}"`,
  });
  if (!pick) {
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Merge PR #${pr.number} into ${pr.base.ref} (${pick.method})?`,
    { modal: true },
    "Merge",
  );
  if (confirm !== "Merge") {
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Merging PR #${pr.number}…` },
    async () => {
      try {
        await api.mergePull(ctx.owner, ctx.repo, pr.number, pick.method);
        onMerged();
        void vscode.window.showInformationMessage(
          `Merged PR #${pr.number}.`,
        );
      } catch (err) {
        await warn(err, "Couldn't merge the pull request.");
      }
    },
  );
}

async function warn(err: unknown, fallback: string): Promise<void> {
  const msg = err instanceof GitHubApiError ? err.message : fallback;
  void vscode.window.showWarningMessage(msg);
}
