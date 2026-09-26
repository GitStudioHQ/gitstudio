import * as vscode from "vscode";
import { promptConfirm, promptInput, promptPick } from "../ui/dialogs";
import { GitHubApi, GitHubApiError, type PullRequest, type PrFile, type ReviewEvent } from "./githubApi";
import type { GitHubAuth } from "./githubAuth";
import type { GitHubRepoContext } from "./repoContext";
import { diffBase, openPrFileDiff } from "./reviewDiff";
import { fromPrContentUri, PR_SCHEME } from "./prContentProvider";
import {
  commentsOutsideHunks,
  hunkSpans,
  prKey,
  reviewPayload,
  type QueuedComment,
  type ReviewSide,
} from "./prModel";

// Review mode (the VS Code Comments API). One CommentController for the whole
// extension drives inline commenting on a PR's changed files. Because the
// Comments API gives us NO way to enumerate the threads it owns, we keep a
// SELF-MANAGED registry of every CommentThread we create — that registry is
// the pending review. On submit we collect each thread's pending comments
// into the `comments[]` array of one `POST .../reviews` call, then dispose every
// thread and clear the registry.
//
// A "pending" comment is a draft: the user authors it locally, it never hits
// GitHub until they pick Comment / Approve / Request changes.
//
// WHERE A COMMENT CAN GO. GitHub takes a review comment only on a line inside
// a diff hunk, and one comment anywhere else fails the WHOLE review. So the
// commentable lines are each file's hunks (from its patch): the head pane's
// for the code as proposed (RIGHT), the base pane's for the lines being
// removed (LEFT) — the only side a deleted file has.
//
// THE QUEUE IS ONE PR's, keyed owner/repo#n — a number alone is not a PR.
// Starting a review of another PR, or cancelling, asks before a non-empty
// queue is thrown away, and nothing is cleared before the new PR has loaded.

/** A pending review thread: where on the diff it sits. */
interface PendingThread {
  path: string;
  side: ReviewSide;
  /** 1-based last line. */
  line: number;
  /** 1-based first line of a multi-line comment. */
  startLine?: number;
}

const PENDING = "gitstudio.prReviewComment";
const POSTED = "gitstudio.prPostedComment";

/**
 * Our Comment implementation (the API only specifies the interface). It keeps
 * its `parent` thread: VS Code hands a comment/title action the COMMENT, and
 * without the thread it lives on, Delete had nothing to delete.
 */
class ReviewComment_ implements vscode.Comment {
  constructor(
    public body: string | vscode.MarkdownString,
    public mode: vscode.CommentMode,
    public author: vscode.CommentAuthorInformation,
    public parent: vscode.CommentThread,
    public contextValue: string = PENDING,
  ) {}
}

interface ActiveReview {
  key: string;
  pr: PullRequest;
  ctx: GitHubRepoContext;
  files: PrFile[];
  /** The diffs' left side: the merge base GitHub counts the patch from (reviewDiff.ts). */
  baseSha: string;
}

export class ReviewController implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private readonly disposables: vscode.Disposable[] = [];

  /** The PR currently under review, if any. */
  private active: ActiveReview | undefined;

  /** Self-managed pending-thread registry for the active review. */
  private readonly threads = new Map<vscode.CommentThread, PendingThread>();

  private login: string | undefined;

  constructor(
    private readonly auth: GitHubAuth,
    private readonly api: GitHubApi,
  ) {
    this.controller = vscode.comments.createCommentController(
      "gitstudio.prReview",
      "GitStudio PR Review",
    );
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document) => this.commentingRanges(document),
    };
    this.disposables.push(this.controller);
  }

  /** Which PR file, and which side of it, a `gitstudio-pr` document is. */
  private locate(uri: vscode.Uri): { file: PrFile; side: ReviewSide } | undefined {
    const a = this.active;
    if (!a || uri.scheme !== PR_SCHEME) {
      return undefined;
    }
    const { owner, repo, sha, path } = fromPrContentUri(uri);
    if (owner !== a.ctx.owner || repo !== a.ctx.repo) {
      return undefined;
    }
    if (sha === a.pr.head.sha) {
      const file = a.files.find((f) => f.filename === path);
      return file ? { file, side: "RIGHT" } : undefined;
    }
    if (sha === a.baseSha) {
      const file = a.files.find((f) => (f.previousFilename ?? f.filename) === path);
      return file ? { file, side: "LEFT" } : undefined;
    }
    return undefined;
  }

  private commentingRanges(
    document: vscode.TextDocument,
  ): vscode.Range[] | undefined {
    const at = this.locate(document.uri);
    if (!at) {
      return undefined;
    }
    const spans = hunkSpans(at.file.patch);
    const last = Math.max(document.lineCount - 1, 0);
    return (at.side === "LEFT" ? spans.left : spans.right).map(
      ([a, b]) => new vscode.Range(Math.min(a - 1, last), 0, Math.min(b - 1, last), 0),
    );
  }

  /** True when a review is in progress. */
  isReviewing(): boolean {
    return this.active !== undefined;
  }

  activePr(): PullRequest | undefined {
    return this.active?.pr;
  }

  /**
   * Open a changed file of the PR under review AS THE REVIEW SEES IT — at its
   * head, with its files. The PR's page keeps the head it loaded: after a push
   * it opened the OLD commit, where the review (pinned to the new one) offers
   * no line to comment on — and the review's toast sends you to that page for
   * every file after the first. False when `owner/repo#n` isn't under review,
   * or the review has no such file; the caller opens it its own way.
   */
  async openReviewedFile(owner: string, repo: string, n: number, path: string): Promise<boolean> {
    const a = this.active;
    if (!a || a.key !== prKey(owner, repo, n)) {
      return false;
    }
    const file = a.files.find((f) => f.filename === path);
    if (!file) {
      return false;
    }
    await openPrFileDiff(a.ctx, a.pr, file, a.baseSha);
    return true;
  }

  /**
   * Enter review mode for a PR: fetch its current head and changed files, open
   * the first as a diff, enable commenting, and flip the
   * `gitstudio.pr.reviewing` context key. The same PR again just reopens it —
   * its queue stays.
   */
  async startReview(
    ctx: GitHubRepoContext,
    requested: PullRequest,
  ): Promise<void> {
    const key = prKey(ctx.owner, ctx.repo, requested.number);
    if (this.active?.key === key) {
      const first = this.active.files[0];
      if (first) {
        await openPrFileDiff(this.active.ctx, this.active.pr, first, this.active.baseSha).catch(() => undefined);
      }
      void vscode.window.showInformationMessage(
        `Still reviewing PR #${requested.number} — ${this.pendingWords()} waiting to be submitted.`,
      );
      return;
    }

    // Load the new PR BEFORE anything of the current review is touched: a
    // failed load must leave the queue exactly as it was.
    //
    // Its head is read again with its files. The PR handed in may be a list
    // row loaded long ago; its head, pushed past since, would open diffs of
    // the OLD code while the files' hunks — which decide where a comment can
    // go — are the new code's, and pin the review to a commit that is no
    // longer the PR's.
    let pr: PullRequest;
    let files: PrFile[];
    try {
      const [detail, listed] = await Promise.all([
        this.api.getPull(ctx.owner, ctx.repo, requested.number),
        this.api.getPullFiles(ctx.owner, ctx.repo, requested.number),
      ]);
      pr = detail;
      files = listed.items;
    } catch (err) {
      void this.warn(err, "Couldn't load the PR's changed files.");
      return;
    }
    const baseSha = await diffBase(this.api, ctx, pr);

    if (this.active && this.pendingCount() > 0) {
      const old = this.active.pr.number;
      const choice = await promptPick({
        title: `Discard ${this.pendingWords()} on #${old}?`,
        hint: `You're starting a review of #${pr.number}. The comments you queued on #${old} haven't been sent to GitHub.`,
        choices: [
          { id: "submit", label: `Submit the Review of #${old} First`, icon: "check", description: "Send them with a verdict, then start this review." },
          { id: "discard", label: "Discard Them", icon: "trash", danger: true, description: "They are deleted. Nothing is sent." },
          { id: "keep", label: `Keep Reviewing #${old}`, icon: "close", description: "Nothing changes." },
        ],
      });
      if (choice === "submit") {
        if (!(await this.submitReview())) {
          return;
        }
      } else if (choice === "discard") {
        this.clearThreads();
      } else {
        return;
      }
    } else {
      this.clearThreads();
    }

    this.login ??= (await this.api.currentLogin())?.login ?? this.auth.accountLabel();
    this.active = { key, pr, ctx, files, baseSha };
    await this.setReviewing(true);

    // One file: every diff opens as a preview, so opening five replaced each
    // with the next and left only the last.
    const first = files[0];
    if (first) {
      await openPrFileDiff(ctx, pr, first, baseSha).catch(() => undefined);
    }
    if (files.length === 0) {
      void vscode.window.showInformationMessage(
        `PR #${pr.number} has no changed files to review.`,
      );
    } else {
      void vscode.window.showInformationMessage(
        `Reviewing PR #${pr.number}. Click the + beside a changed line to leave a comment, then Submit Review. Open other files from the PR's page.`,
      );
    }
  }

  /** Where a new thread sits, or why it can't be commented on. */
  private anchor(thread: vscode.CommentThread): PendingThread | undefined {
    const at = this.locate(thread.uri);
    if (!at || !thread.range) {
      return undefined;
    }
    const start = thread.range.start.line + 1; // 1-based for GitHub.
    const end = thread.range.end.line + 1;
    return {
      path: at.file.filename,
      side: at.side,
      line: end,
      ...(end !== start ? { startLine: start } : {}),
    };
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
    const where = this.threads.get(thread) ?? this.anchor(thread);
    if (!where) {
      return;
    }
    const comment = new ReviewComment_(
      new vscode.MarkdownString(reply.text),
      vscode.CommentMode.Preview,
      { name: this.login ? `@${this.login}` : "You" },
      thread,
    );
    thread.comments = [...thread.comments, comment];
    thread.label = "Pending review comment";
    thread.contextValue = "gitstudio.prPendingThread";
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.threads.set(thread, where);
  }

  /**
   * The Delete action. VS Code hands a comment/title action the COMMENT; a
   * thread may come from elsewhere. One pending comment goes — the thread
   * goes with its last one, and leaves the queue with its last PENDING one:
   * a thread that also holds a comment already posted stayed queued, so
   * Cancel asked to "Discard 1 pending comment" when none was, and discarding
   * took the posted comment off the editor too.
   */
  deleteComment(arg: unknown): void {
    if (arg instanceof ReviewComment_) {
      const thread = arg.parent;
      thread.comments = thread.comments.filter((c) => c !== arg);
      if (thread.comments.length === 0) {
        this.threads.delete(thread);
        thread.dispose();
      } else if (pendingIn(thread) === 0) {
        this.unqueue(thread);
      }
      return;
    }
    const thread = arg as vscode.CommentThread | undefined;
    if (thread && typeof thread.dispose === "function" && "comments" in thread) {
      this.threads.delete(thread);
      thread.dispose();
    }
  }

  /** A thread left with only comments already on GitHub: out of the queue, as posted. */
  private unqueue(thread: vscode.CommentThread): void {
    this.threads.delete(thread);
    thread.label = "Comment posted";
    thread.contextValue = undefined;
  }

  /** Count of pending draft comments — comments, not the lines they are on. */
  pendingCount(): number {
    let n = 0;
    for (const thread of this.threads.keys()) {
      n += pendingIn(thread);
    }
    return n;
  }

  private pendingWords(): string {
    const n = this.pendingCount();
    return `${n} pending comment${n === 1 ? "" : "s"}`;
  }

  /** The queue, as GitHub will be sent it. */
  private queued(): QueuedComment[] {
    const out: QueuedComment[] = [];
    for (const [thread, where] of this.threads) {
      const body = thread.comments
        .filter((c) => c.contextValue !== POSTED)
        .map((c) => mdToString(c.body))
        .filter((t) => t.length > 0)
        .join("\n\n");
      if (body.length > 0) {
        out.push({ ...where, body });
      }
    }
    return out;
  }

  /**
   * Submit the pending review: Comment / Approve / Request changes, an
   * optional summary, then one `POST .../reviews` with every queued comment,
   * pinned to the head the diffs showed. True when it was sent.
   */
  async submitReview(): Promise<boolean> {
    if (!this.active) {
      void vscode.window.showInformationMessage(
        "Start a review first (open a PR and choose Start Review).",
      );
      return false;
    }
    const { pr, ctx, files } = this.active;
    const comments = this.queued();

    // Anything GitHub would refuse fails every comment with it: say which,
    // before a verdict is even asked for.
    const outside = commentsOutsideHunks(
      comments,
      (path) => files.find((f) => f.filename === path)?.patch,
    );
    if (outside.length > 0) {
      void vscode.window.showWarningMessage(
        `GitHub takes review comments only on lines that are part of the diff, and ${outside.join(", ")} ${
          outside.length === 1 ? "isn't" : "aren't"
        }. Delete ${outside.length === 1 ? "that comment" : "those comments"} or move ${
          outside.length === 1 ? "it" : "them"
        } onto a changed line, then submit again.`,
      );
      return false;
    }

    // Submitting a review is a three-way verdict, not a search.
    const pick = await promptPick({
      title: `Submit review for PR #${pr.number}`,
      hint: `${comments.length} inline comment${comments.length === 1 ? "" : "s"} will be submitted with it.`,
      choices: [
        { id: "COMMENT", label: "Comment", icon: "comment", description: "General feedback, no explicit approval." },
        { id: "APPROVE", label: "Approve", icon: "check", description: "Approve these changes." },
        { id: "REQUEST_CHANGES", label: "Request Changes", icon: "request-changes", danger: true, description: "Block the PR until the feedback is addressed." },
      ],
    });
    if (!pick) {
      return false;
    }
    const event = pick as ReviewEvent;

    const summary = await promptInput({
      title: "Review summary",
      hint: "Optional — Ctrl/Cmd+Enter to submit.",
      placeholder: "Leave a summary comment…",
      multiline: true,
      confirmLabel: "Submit Review",
    });
    // Escape (undefined) cancels; an empty string is a valid no-summary submit.
    if (summary === undefined) {
      return false;
    }

    // A COMMENT review with neither a body nor comments is rejected by GitHub.
    if (event === "COMMENT" && comments.length === 0 && summary.trim().length === 0) {
      void vscode.window.showWarningMessage(
        "Add a comment or a summary before submitting a Comment review.",
      );
      return false;
    }

    try {
      await this.api.submitReview(
        ctx.owner,
        ctx.repo,
        pr.number,
        reviewPayload({ event, body: summary, commitId: pr.head.sha, comments }),
      );
    } catch (err) {
      // The queue stays: nothing was sent.
      void this.warn(err, "Couldn't submit the review.");
      return false;
    }

    this.clearThreads({ keepPosted: false });
    await this.setReviewing(false);
    this.active = undefined;
    void vscode.window.showInformationMessage(
      `Review submitted for PR #${pr.number} (${pick}).`,
    );
    return true;
  }

  /**
   * A one-off comment, independent of the pending review: POST a one-comment
   * COMMENT review at once. Used by gitstudio.pr.addSingleComment.
   */
  async addSingleComment(reply: vscode.CommentReply): Promise<void> {
    if (!this.active) {
      return;
    }
    const { pr, ctx } = this.active;
    const where = this.threads.get(reply.thread) ?? this.anchor(reply.thread);
    if (!where) {
      return;
    }
    try {
      await this.api.submitReview(
        ctx.owner,
        ctx.repo,
        pr.number,
        reviewPayload({
          event: "COMMENT",
          commitId: pr.head.sha,
          comments: [{ ...where, body: reply.text }],
        }),
      );
    } catch (err) {
      void this.warn(err, "Couldn't post the comment.");
      return;
    }
    // Reflect it as a posted comment on the thread. It is on GitHub now, so
    // it carries no Delete — removing it here would not remove it there.
    const comment = new ReviewComment_(
      new vscode.MarkdownString(reply.text),
      vscode.CommentMode.Preview,
      { name: this.login ? `@${this.login}` : "You" },
      reply.thread,
      POSTED,
    );
    reply.thread.comments = [...reply.thread.comments, comment];
    if (!this.threads.has(reply.thread)) {
      reply.thread.label = "Comment posted";
    }
    void vscode.window.showInformationMessage("Comment posted to GitHub.");
  }

  /** Abandon the in-progress review — asking first when comments are queued. */
  async cancelReview(): Promise<void> {
    if (this.active && this.pendingCount() > 0) {
      const ok = await promptConfirm({
        title: `Discard ${this.pendingWords()} on #${this.active.pr.number}?`,
        message: "They haven't been sent to GitHub, and discarding them can't be undone.",
        confirmLabel: "Discard",
        danger: true,
      });
      if (!ok) {
        return;
      }
    }
    this.clearThreads();
    await this.setReviewing(false);
    this.active = undefined;
  }

  /**
   * Drop the queue: every pending comment goes. Discarded, a thread that also
   * holds a comment already on GitHub keeps that one — removing it here would
   * not remove it there. Sent (or shutting down), every thread goes, as ever.
   */
  private clearThreads(opts: { keepPosted: boolean } = { keepPosted: true }): void {
    for (const thread of this.threads.keys()) {
      const posted = opts.keepPosted ? thread.comments.filter((c) => c.contextValue === POSTED) : [];
      if (posted.length > 0) {
        thread.comments = posted;
        thread.label = "Comment posted";
        thread.contextValue = undefined;
      } else {
        thread.dispose();
      }
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
    this.clearThreads({ keepPosted: false });
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}

/** How many of a thread's comments are pending (not yet on GitHub). */
function pendingIn(thread: vscode.CommentThread): number {
  return thread.comments.filter((c) => c.contextValue !== POSTED).length;
}

/** Render a Comment body (string | MarkdownString) to plain text. */
function mdToString(body: string | vscode.MarkdownString): string {
  return typeof body === "string" ? body : body.value;
}
