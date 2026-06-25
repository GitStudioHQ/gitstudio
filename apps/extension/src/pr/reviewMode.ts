import * as vscode from "vscode";
import { GitHubApi, GitHubApiError, type PullRequest, type PrFile, type ReviewComment, type ReviewEvent } from "./githubApi";
import type { GitHubAuth } from "./githubAuth";
import type { GitHubRepoContext } from "./repoContext";
import { openPrFileDiff } from "./reviewDiff";
import { PR_SCHEME } from "./prContentProvider";

// Review mode (the VS Code Comments API). One CommentController for the whole
// extension drives inline commenting on a PR's changed files. Because the
// Comments API gives us NO way to enumerate the threads it owns, we keep a
// SELF-MANAGED registry of every CommentThread we create, keyed by
// `${path}:${line}` — that registry is the single source of truth for the
// pending draft review. On submit we collect each thread's pending comments
// into the `comments[]` array of one `POST .../reviews` call, then dispose every
// thread and clear the registry.
//
// A "pending" comment is a draft: the user authors it locally, it never hits
// GitHub until they pick Comment / Approve / Request changes. We mark such
// comments with a distinct context value so the thread's "Add to review" action
// can promote a freshly-typed input into the registry.

/** A pending review comment plus the thread it lives on. */
interface PendingThread {
  thread: vscode.CommentThread;
  path: string;
  /** 1-based line on the RIGHT (head) side. */
  line: number;
}

/** Our Comment implementation (the API only specifies the interface). */
class ReviewComment_ implements vscode.Comment {
  contextValue = "gitstudio.prReviewComment";
  constructor(
    public body: string | vscode.MarkdownString,
    public mode: vscode.CommentMode,
    public author: vscode.CommentAuthorInformation,
  ) {}
}

export class ReviewController implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private readonly disposables: vscode.Disposable[] = [];

  /** The PR currently under review, if any. */
  private active:
    | { pr: PullRequest; ctx: GitHubRepoContext; files: PrFile[] }
    | undefined;

  /** Self-managed thread registry, keyed by `${path}:${line}`. */
  private readonly threads = new Map<string, PendingThread>();

  private login: string | undefined;

  constructor(
    private readonly auth: GitHubAuth,
    private readonly api: GitHubApi,
  ) {
    this.controller = vscode.comments.createCommentController(
      "gitstudio.prReview",
      "GitStudio PR Review",
    );
    // Allow commenting on any line of a head-side PR file once review is active.
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document) => this.commentingRanges(document),
    };
    this.disposables.push(this.controller);
  }

  private commentingRanges(
    document: vscode.TextDocument,
  ): vscode.Range[] | undefined {
    if (!this.active || document.uri.scheme !== PR_SCHEME) {
      return undefined;
    }
    // Only the head-side blob of a file in this PR is commentable.
    const path = headPathOf(document.uri, this.active.pr.head.sha);
    if (!path) {
      return undefined;
    }
    const isChanged = this.active.files.some((f) => f.filename === path);
    if (!isChanged) {
      return undefined;
    }
    const last = Math.max(document.lineCount - 1, 0);
    return [new vscode.Range(0, 0, last, 0)];
  }

  /** True when a review is in progress. */
  isReviewing(): boolean {
    return this.active !== undefined;
  }

  activePr(): PullRequest | undefined {
    return this.active?.pr;
  }

  /**
   * Enter review mode for a PR: fetch its changed files, open them as diffs,
   * enable commenting, and flip the `gitstudio.pr.reviewing` context key.
   */
  async startReview(
    ctx: GitHubRepoContext,
    pr: PullRequest,
  ): Promise<void> {
    // Re-entering: clear any prior review first.
    this.clearThreads();

    let files: PrFile[];
    try {
      files = await this.api.getPullFiles(ctx.owner, ctx.repo, pr.number);
    } catch (err) {
      void this.warn(err, "Couldn't load the PR's changed files.");
      return;
    }
    this.login = (await this.api.currentLogin())?.login ?? this.auth.accountLabel();
    this.active = { pr, ctx, files };
    await this.setReviewing(true);

    // Open the first few files as diffs so the user lands in the code.
    const toOpen = files.slice(0, 5);
    for (const f of toOpen) {
      try {
        await openPrFileDiff(ctx, pr, f);
      } catch {
        // best-effort
      }
    }
    if (files.length === 0) {
      void vscode.window.showInformationMessage(
        `PR #${pr.number} has no changed files to review.`,
      );
    } else {
      void vscode.window.showInformationMessage(
        `Reviewing PR #${pr.number}. Click the + in the gutter of a changed file to leave a comment, then Submit Review.`,
      );
    }
  }

  /**
   * Create a pending thread from a brand-new comment input. Called by the
   * `gitstudio.pr.addReviewComment` command, wired to the comment-thread input.
   */
  addComment(reply: vscode.CommentReply): void {
    if (!this.active) {
      return;
    }
    const thread = reply.thread;
    const path = headPathOf(thread.uri, this.active.pr.head.sha);
    if (!path) {
      return;
    }
    const line = thread.range.start.line + 1; // 1-based for GitHub.
    const comment = new ReviewComment_(
      new vscode.MarkdownString(reply.text),
      vscode.CommentMode.Preview,
      { name: this.login ? `@${this.login}` : "You" },
    );
    thread.comments = [...thread.comments, comment];
    thread.label = "Pending review comment";
    thread.contextValue = "gitstudio.prPendingThread";
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;

    this.threads.set(`${path}:${line}`, { thread, path, line });
  }

  /** Drop a single pending thread (the "Delete comment" action). */
  removeThread(thread: vscode.CommentThread): void {
    for (const [key, pending] of this.threads) {
      if (pending.thread === thread) {
        this.threads.delete(key);
        break;
      }
    }
    thread.dispose();
  }

  /** Count of pending draft comments. */
  pendingCount(): number {
    return this.threads.size;
  }

  /**
   * Submit the pending review: QuickPick Comment / Approve / Request changes,
   * optional summary, then one `POST .../reviews` with all collected comments.
   */
  async submitReview(): Promise<void> {
    if (!this.active) {
      void vscode.window.showInformationMessage(
        "Start a review first (open a PR and choose Start Review).",
      );
      return;
    }
    const { pr, ctx } = this.active;

    const pick = await vscode.window.showQuickPick(
      [
        { label: "$(comment) Comment", event: "COMMENT" as ReviewEvent, detail: "Submit general feedback without explicit approval." },
        { label: "$(check) Approve", event: "APPROVE" as ReviewEvent, detail: "Approve these changes." },
        { label: "$(request-changes) Request changes", event: "REQUEST_CHANGES" as ReviewEvent, detail: "Request changes before merging." },
      ],
      { placeHolder: `Submit review for PR #${pr.number} (${this.threads.size} inline comment(s))` },
    );
    if (!pick) {
      return;
    }

    const summary = await vscode.window.showInputBox({
      prompt: "Review summary (optional)",
      placeHolder: "Leave a summary comment…",
    });
    // Escape (undefined) cancels; an empty string is a valid no-summary submit.
    if (summary === undefined) {
      return;
    }

    const comments: ReviewComment[] = [];
    for (const pending of this.threads.values()) {
      const body = pending.thread.comments
        .map((c) => mdToString(c.body))
        .filter((t) => t.length > 0)
        .join("\n\n");
      if (body.length > 0) {
        comments.push({
          path: pending.path,
          line: pending.line,
          side: "RIGHT",
          body,
        });
      }
    }

    // A COMMENT review with neither a body nor comments is rejected by GitHub.
    if (pick.event === "COMMENT" && comments.length === 0 && summary.trim().length === 0) {
      void vscode.window.showWarningMessage(
        "Add a comment or a summary before submitting a Comment review.",
      );
      return;
    }

    try {
      await this.api.submitReview(ctx.owner, ctx.repo, pr.number, {
        event: pick.event,
        body: summary,
        comments,
      });
    } catch (err) {
      void this.warn(err, "Couldn't submit the review.");
      return;
    }

    this.clearThreads();
    await this.setReviewing(false);
    this.active = undefined;
    void vscode.window.showInformationMessage(
      `Review submitted for PR #${pr.number} (${pick.label.replace(/\$\([^)]*\)\s*/, "")}).`,
    );
  }

  /**
   * A one-off single comment, independent of a draft review: prompt for line +
   * body and POST a one-comment COMMENT review. Used by gitstudio.pr.addSingleComment.
   */
  async addSingleComment(reply: vscode.CommentReply): Promise<void> {
    if (!this.active) {
      return;
    }
    const { pr, ctx } = this.active;
    const path = headPathOf(reply.thread.uri, pr.head.sha);
    if (!path) {
      return;
    }
    const line = reply.thread.range.start.line + 1;
    try {
      await this.api.submitReview(ctx.owner, ctx.repo, pr.number, {
        event: "COMMENT",
        body: "",
        comments: [{ path, line, side: "RIGHT", body: reply.text }],
      });
    } catch (err) {
      void this.warn(err, "Couldn't post the comment.");
      return;
    }
    // Reflect it as a submitted (non-pending) comment on the thread.
    const comment = new ReviewComment_(
      new vscode.MarkdownString(reply.text),
      vscode.CommentMode.Preview,
      { name: this.login ? `@${this.login}` : "You" },
    );
    reply.thread.comments = [...reply.thread.comments, comment];
    reply.thread.label = "Comment posted";
    void vscode.window.showInformationMessage("Comment posted to GitHub.");
  }

  /** Abandon the in-progress review and clear all pending threads. */
  async cancelReview(): Promise<void> {
    this.clearThreads();
    await this.setReviewing(false);
    this.active = undefined;
  }

  private clearThreads(): void {
    for (const pending of this.threads.values()) {
      pending.thread.dispose();
    }
    this.threads.clear();
  }

  private async setReviewing(value: boolean): Promise<void> {
    await vscode.commands.executeCommand(
      "setContext",
      "gitstudio.pr.reviewing",
      value,
    );
  }

  private async warn(err: unknown, fallback: string): Promise<void> {
    const msg = err instanceof GitHubApiError ? err.message : fallback;
    void vscode.window.showWarningMessage(msg);
  }

  dispose(): void {
    this.clearThreads();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}

/**
 * Given a `gitstudio-pr` URI, returns its file path iff it is the HEAD-side blob
 * for `headSha` (so we never treat the base/left pane as commentable).
 */
function headPathOf(uri: vscode.Uri, headSha: string): string | undefined {
  if (uri.scheme !== PR_SCHEME) {
    return undefined;
  }
  const params = new URLSearchParams(uri.query);
  if (params.get("sha") !== headSha) {
    return undefined;
  }
  return uri.path.replace(/^\/+/, "");
}

/** Render a Comment body (string | MarkdownString) to plain text. */
function mdToString(body: string | vscode.MarkdownString): string {
  return typeof body === "string" ? body : body.value;
}
