import * as vscode from "vscode";
import { GitHubApi, GitHubApiError, type PrFile } from "./githubApi";
import type { GitHubAuth } from "./githubAuth";
import { openPrFileDiff, prBaseUri, prHeadUri, type PrRepoRef } from "./reviewDiff";
import { fromPrContentUri, PR_SCHEME } from "./prContentProvider";
import {
  commentsOutsideHunks,
  hunkSpans,
  prKey,
  reviewPayload,
  type QueuedComment,
  type ReviewEvent,
  type ReviewSide,
} from "@gitstudio/engine/forge/pullRequests";
import { replyToThread, setThreadResolved } from "@gitstudio/engine/forge/prPage";
import { PrListError, type GraphqlFn } from "@gitstudio/engine/forge/prList";
import type { PrPendingReview, PrThread } from "@gitstudio/host-bridge/prProtocol";

// Reviews of pull requests, in the editor (the VS Code Comments API). One
// CommentController for the extension draws three kinds of thread on a pull
// request's diffs:
//
// - PENDING: your comments, queued for a review you haven't sent. A review is
//   one pull request's, keyed owner/repo#n, and pinned to the head its diffs
//   showed — reviews of several pull requests stand side by side, so starting
//   one never throws another away. Each is kept in the workspace's state as
//   it changes, keyed owner/repo#n@head, so a window reload keeps them.
// - GITHUB'S: the threads already on the pull request, with Reply and
//   Resolve, drawn where they sit in the diff as it is now.
// - POSTED: a comment of yours GitHub has just taken, shown as posted until
//   GitHub's own copy of its thread replaces it.
//
// WHERE A COMMENT CAN GO. GitHub takes a review comment only on a line inside
// a diff hunk, and one comment anywhere else fails the WHOLE review. So the
// commentable lines are each file's hunks (from its patch): the head pane's
// for the code as proposed (RIGHT), the base pane's for the lines being
// removed (LEFT) — the only side a deleted file has. Any pull request whose
// page has been read can be commented on; the first comment starts its
// review.
//
// Submitting is the PR page's (its review box): a verdict, a summary, and
// the queue — never a question asked in the sidebar.

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
const THREAD_OPEN = "gitstudio.prThread.open";
const THREAD_RESOLVED = "gitstudio.prThread.resolved";
const PENDING_THREAD = "gitstudio.prPendingThread";
/** The workspace-state key the pending reviews are kept under. */
export const PENDING_REVIEWS_KEY = "gitstudio.pr.pendingReviews";

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

/** A pull request whose page has read it: enough to draw and comment on its diffs. */
export interface KnownPr {
  owner: string;
  repo: string;
  number: number;
  title: string;
  headSha: string;
  /** The diffs' left side: the merge base GitHub counts the patch from (reviewDiff.ts). */
  baseSha: string;
  files: PrFile[];
}

interface Review {
  key: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  headSha: string;
  baseSha: string;
  /** Its files at its head, for the hunks and for opening them; read when first needed. */
  files?: PrFile[];
  filesLoading?: Promise<void>;
  /** The patches of the files it comments on, kept with it (a reload has no files yet). */
  patches: Record<string, string>;
  /** A renamed file's old path, by its new one: where its LEFT comments sit. */
  renames: Record<string, string>;
  /** Start Review was pressed: the review exists before its first comment. */
  started: boolean;
  threads: Map<vscode.CommentThread, PendingThread>;
}

/** A review as it is kept across a reload. */
interface StoredReview {
  owner: string;
  repo: string;
  number: number;
  title: string;
  headSha: string;
  baseSha: string;
  started: boolean;
  comments: QueuedComment[];
  patches: Record<string, string>;
  renames?: Record<string, string>;
}

/** A store for the pending reviews (the workspace's state). */
export interface ReviewMemory {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void> | void;
}

export type SubmitOutcome = { ok: true; id?: string; url?: string; submittedAt?: string } | { ok: false; message: string };

export class ReviewController implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly status: vscode.StatusBarItem;
  private readonly changed = new vscode.EventEmitter<string>();
  /** A review of `key` changed: its queue, or whether there is one. */
  readonly onDidChange = this.changed.event;
  private readonly threadChanged = new vscode.EventEmitter<{ key: string; thread: PrThread }>();
  /** A GitHub thread changed from the editor (a reply, a resolve): the page redraws it. */
  readonly onDidChangeThread = this.threadChanged.event;

  private readonly known = new Map<string, KnownPr>();
  private readonly reviews = new Map<string, Review>();
  /** GitHub's own threads in the editor, by thread id. */
  private readonly github = new Map<string, { key: string; thread: vscode.CommentThread; data: PrThread }>();
  /** Comments GitHub took, shown as posted until its copy of the thread arrives. */
  private readonly posted = new Map<string, vscode.CommentThread[]>();

  private login: string | undefined;

  constructor(
    private readonly auth: GitHubAuth,
    private readonly api: GitHubApi,
    private readonly graphql: GraphqlFn,
    private readonly memory?: ReviewMemory,
  ) {
    this.controller = vscode.comments.createCommentController("gitstudio.prReview", "GitStudio Pull Request Review");
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document) => this.commentingRanges(document),
    };
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 40);
    this.status.command = "gitstudio.pr.submitReview";
    this.disposables.push(this.controller, this.status, this.changed, this.threadChanged);
    this.restore();
  }

  // ── Which pull request a document is ───────────────────────────────────────

  /** A page read this pull request: its diffs take comments. */
  know(k: KnownPr): void {
    const key = prKey(k.owner, k.repo, k.number);
    this.known.set(key, k);
    const r = this.reviews.get(key);
    if (r && !r.files && r.headSha === k.headSha) r.files = k.files;
  }

  /**
   * Which PR file, and which side of it, a `gitstudio-pr` document is. Only
   * a document that names its pull request (`pr=`) is one: a commit's diff
   * names none — its lines are that commit's change, not the pull request's
   * hunks, and a head commit two pull requests share would be either's.
   */
  private locate(uri: vscode.Uri): { entry: Review | KnownPr; key: string; side: ReviewSide; path: string } | undefined {
    if (uri.scheme !== PR_SCHEME) return undefined;
    const { owner, repo, sha, path, pr } = fromPrContentUri(uri);
    if (!pr) return undefined;
    const key = prKey(owner, repo, pr);
    // A review pins its pull request to the head it was written on: the
    // newer head's diffs take no comment until it is sent or discarded.
    const e: Review | KnownPr | undefined = this.reviews.get(key) ?? this.known.get(key);
    if (!e) return undefined;
    const side: ReviewSide | undefined = sha === e.headSha ? "RIGHT" : sha === e.baseSha ? "LEFT" : undefined;
    return side ? { entry: e, key, side, path } : undefined;
  }

  private fileOf(entry: Review | KnownPr, side: ReviewSide, path: string): PrFile | undefined {
    const files = entry.files ?? [];
    return side === "RIGHT" ? files.find((f) => f.filename === path) : files.find((f) => (f.previousFilename ?? f.filename) === path);
  }

  private patchOf(entry: Review | KnownPr, side: ReviewSide, path: string): string | undefined {
    const f = this.fileOf(entry, side, path);
    if (f) return f.patch;
    if ("patches" in entry) {
      // A LEFT path is a rename's old name: its patch is kept under the new one.
      const renamed = side === "LEFT" ? Object.entries(entry.renames).find(([, old]) => old === path)?.[0] : undefined;
      return entry.patches[renamed ?? path];
    }
    return undefined;
  }

  private async commentingRanges(document: vscode.TextDocument): Promise<vscode.Range[] | undefined> {
    const at = this.locate(document.uri);
    if (!at) return undefined;
    if ("threads" in at.entry && !at.entry.files) await this.ensureFiles(at.entry);
    const spans = hunkSpans(this.patchOf(at.entry, at.side, at.path));
    const last = Math.max(document.lineCount - 1, 0);
    return (at.side === "LEFT" ? spans.left : spans.right).map(
      ([a, b]) => new vscode.Range(Math.min(a - 1, last), 0, Math.min(b - 1, last), 0),
    );
  }

  /** A restored review's files: its pull request's, at the head it was written on. */
  private ensureFiles(r: Review): Promise<void> {
    if (r.files) return Promise.resolve();
    r.filesLoading ??= (async () => {
      try {
        const k = this.known.get(r.key);
        if (k && k.headSha === r.headSha) {
          r.files = k.files;
          return;
        }
        const pull = await this.api.getPull(r.owner, r.repo, r.number);
        r.files =
          pull.head.sha === r.headSha
            ? (await this.api.getPullFiles(r.owner, r.repo, r.number)).items
            : await this.api.compareFiles(r.owner, r.repo, r.baseSha, r.headSha);
      } catch {
        // Offline: the kept patches still place the comments already written.
      } finally {
        r.filesLoading = undefined;
      }
    })();
    return r.filesLoading;
  }

  // ── What a page shows of a review ──────────────────────────────────────────

  /** Every PR with a review under way. */
  reviewKeys(): string[] {
    return [...this.reviews.keys()];
  }

  isReviewing(): boolean {
    return this.reviews.size > 0;
  }

  /** The review of `key`, as the page lists it — undefined when there is none. */
  pendingFor(key: string, prHead?: string): PrPendingReview | undefined {
    const r = this.reviews.get(key);
    if (!r) return undefined;
    return {
      comments: this.queued(r).map((c) => ({ path: c.path, line: c.line, ...(c.startLine !== undefined ? { startLine: c.startLine } : {}), side: c.side, body: c.body })),
      started: r.started,
      headSha: r.headSha,
      stale: !!prHead && prHead !== r.headSha,
    };
  }

  /** Count of pending comments of one review, or of all of them. */
  pendingCount(key?: string): number {
    let n = 0;
    for (const [k, r] of this.reviews) {
      if (key && k !== key) continue;
      for (const thread of r.threads.keys()) n += pendingIn(thread);
    }
    return n;
  }

  // ── Opening files ──────────────────────────────────────────────────────────

  /**
   * Open a changed file of `key`, as its review sees it when there is one (at
   * its head, with its files) — else as its page read it. At `line`, when
   * given (a thread's, a pending comment's). False when neither knows the file.
   */
  async openFile(key: string, path: string, at?: { line?: number; side?: ReviewSide }): Promise<boolean> {
    const r = this.reviews.get(key);
    if (r) await this.ensureFiles(r);
    const entry: Review | KnownPr | undefined = r ?? this.known.get(key);
    if (!entry) return false;
    const file = (entry.files ?? []).find((f) => f.filename === path);
    const ref: PrRepoRef = { owner: entry.owner, repo: entry.repo };
    const pr = { number: entry.number, headSha: entry.headSha };
    if (!file) {
      // No longer part of the diff (a thread on code that has moved): the
      // file as the pull request has it now.
      if (!at?.line) return false;
      const uri = prHeadUri(ref, pr, path);
      await vscode.window.showTextDocument(uri, { preview: true, selection: new vscode.Range(at.line - 1, 0, at.line - 1, 0) });
      return true;
    }
    await openPrFileDiff(ref, pr, file, entry.baseSha, at?.line && at.side !== "LEFT" ? at.line : undefined);
    return true;
  }

  /**
   * Start Review: the review exists (the page says "Reviewing"), and the
   * first file opens, ready for comments. The same PR again reopens it — its
   * queue stays.
   */
  async start(key: string): Promise<boolean> {
    let r = this.reviews.get(key);
    if (!r) {
      const k = this.known.get(key);
      if (!k) return false;
      r = this.newReview(key, k);
    }
    r.started = true;
    this.touched(key);
    await this.ensureFiles(r);
    const first = r.files?.[0];
    if (first) await this.openFile(key, first.filename).catch(() => false);
    return true;
  }

  private newReview(key: string, k: KnownPr): Review {
    const r: Review = {
      key,
      owner: k.owner,
      repo: k.repo,
      number: k.number,
      title: k.title,
      headSha: k.headSha,
      baseSha: k.baseSha,
      files: k.files,
      patches: {},
      renames: {},
      started: false,
      threads: new Map(),
    };
    this.reviews.set(key, r);
    return r;
  }

  // ── Comments ───────────────────────────────────────────────────────────────

  /** Where a new thread sits, or why it can't be commented on. */
  private anchor(thread: vscode.CommentThread): { key: string; where: PendingThread; entry: Review | KnownPr } | undefined {
    const at = this.locate(thread.uri);
    if (!at || !thread.range) return undefined;
    const f = this.fileOf(at.entry, at.side, at.path);
    const start = thread.range.start.line + 1; // 1-based for GitHub.
    const end = thread.range.end.line + 1;
    return {
      key: at.key,
      entry: at.entry,
      where: { path: f?.filename ?? at.path, side: at.side, line: end, ...(end !== start ? { startLine: start } : {}) },
    };
  }

  private me(): vscode.CommentAuthorInformation {
    return { name: this.login ? `@${this.login}` : "You" };
  }

  /**
   * Add to Review: a pending comment on a new thread, or another on a pending
   * one. The first comment on a pull request starts its review.
   */
  addComment(reply: vscode.CommentReply): void {
    const thread = reply.thread;
    let review: Review | undefined;
    let where: PendingThread | undefined;
    for (const r of this.reviews.values()) {
      const w = r.threads.get(thread);
      if (w) {
        review = r;
        where = w;
      }
    }
    if (!review) {
      const a = this.anchor(thread);
      if (!a) return;
      review = this.reviews.get(a.key) ?? ("threads" in a.entry ? a.entry : this.newReview(a.key, a.entry));
      where = a.where;
    }
    const comment = new ReviewComment_(new vscode.MarkdownString(reply.text), vscode.CommentMode.Preview, this.me(), thread);
    thread.comments = [...thread.comments, comment];
    thread.label = "Pending review comment";
    thread.contextValue = PENDING_THREAD;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    review.threads.set(thread, where!);
    // Kept with the review: a reload has its comments before it has its files.
    const f = review.files?.find((x) => x.filename === where!.path);
    if (f?.patch) review.patches[where!.path] = f.patch;
    if (f?.previousFilename) review.renames[where!.path] = f.previousFilename;
    this.touched(review.key);
  }

  /**
   * The Delete action. VS Code hands a comment/title action the COMMENT; a
   * thread may come from elsewhere. One pending comment goes — the thread
   * goes with its last one, and leaves the queue with its last PENDING one.
   */
  deleteComment(arg: unknown): void {
    if (arg instanceof ReviewComment_) {
      const thread = arg.parent;
      thread.comments = thread.comments.filter((c) => c !== arg);
      const r = this.reviewOf(thread);
      if (thread.comments.length === 0) {
        r?.threads.delete(thread);
        thread.dispose();
      } else if (pendingIn(thread) === 0) {
        r?.threads.delete(thread);
        thread.label = "Comment posted";
        thread.contextValue = undefined;
      }
      if (r) this.touched(r.key);
      return;
    }
    const thread = arg as vscode.CommentThread | undefined;
    if (thread && typeof thread.dispose === "function" && "comments" in thread) {
      const r = this.reviewOf(thread);
      r?.threads.delete(thread);
      thread.dispose();
      if (r) this.touched(r.key);
    }
  }

  private reviewOf(thread: vscode.CommentThread): Review | undefined {
    for (const r of this.reviews.values()) if (r.threads.has(thread)) return r;
    return undefined;
  }

  /** The queue of one review, as GitHub will be sent it. */
  private queued(r: Review): QueuedComment[] {
    const out: QueuedComment[] = [];
    for (const [thread, where] of r.threads) {
      const body = thread.comments
        .filter((c) => c.contextValue !== POSTED)
        .map((c) => mdToString(c.body))
        .filter((t) => t.length > 0)
        .join("\n\n");
      if (body.length > 0) out.push({ ...where, body });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  }

  /**
   * Send the review of `key`: the verdict, the summary, and every queued
   * comment in one request, pinned to the head its diffs showed. `head` is
   * the head the page shows, for a review with no comments. Nothing is
   * cleared unless GitHub took it.
   */
  async submit(key: string, event: ReviewEvent, body: string, head: { owner: string; repo: string; number: number; headSha: string }): Promise<SubmitOutcome> {
    const r = this.reviews.get(key);
    const comments = r ? this.queued(r) : [];
    if (r) {
      // Anything GitHub would refuse fails every comment with it: say which.
      await this.ensureFiles(r);
      const outside = commentsOutsideHunks(comments, (path) => r.files?.find((f) => f.filename === path)?.patch ?? r.patches[path]);
      if (outside.length > 0) {
        return {
          ok: false,
          message: `GitHub takes review comments only on lines that are part of the diff, and ${outside.join(", ")} ${outside.length === 1 ? "isn't" : "aren't"}. Delete ${outside.length === 1 ? "that comment" : "those comments"} or move ${outside.length === 1 ? "it" : "them"} onto a changed line.`,
        };
      }
    }
    if (event === "COMMENT" && comments.length === 0 && body.trim().length === 0) {
      return { ok: false, message: "A Comment review needs something to say: write a summary, or add a comment on a changed line." };
    }
    let sent: Awaited<ReturnType<GitHubApi["submitReview"]>>;
    try {
      sent = await this.api.submitReview(
        head.owner,
        head.repo,
        head.number,
        reviewPayload({ event, body, commitId: r?.headSha ?? head.headSha, comments }),
      );
    } catch (err) {
      return { ok: false, message: messageOf(err, "Couldn't submit the review.") };
    }
    if (r) {
      // Posted: shown so until GitHub's copy of each thread arrives.
      const threads = [...r.threads.keys()];
      for (const t of threads) {
        t.comments = t.comments.map((c) => (c instanceof ReviewComment_ ? Object.assign(c, { contextValue: POSTED }) : c));
        t.label = "Comment posted";
        t.contextValue = undefined;
      }
      this.posted.set(key, [...(this.posted.get(key) ?? []), ...threads]);
      this.reviews.delete(key);
      this.touched(key);
    }
    return { ok: true, ...(sent ? { id: sent.id, url: sent.url, submittedAt: sent.submittedAt } : {}) };
  }

  /** Throw a review's pending comments away. Comments already on GitHub stay. */
  discard(key: string): void {
    const r = this.reviews.get(key);
    if (!r) return;
    for (const thread of r.threads.keys()) {
      const posted = thread.comments.filter((c) => c.contextValue === POSTED);
      if (posted.length > 0) {
        thread.comments = posted;
        thread.label = "Comment posted";
        thread.contextValue = undefined;
      } else {
        thread.dispose();
      }
    }
    this.reviews.delete(key);
    this.touched(key);
  }

  /**
   * A one-off comment, independent of the pending review: a one-comment
   * COMMENT review, sent at once. Used by gitstudio.pr.addSingleComment.
   */
  async addSingleComment(reply: vscode.CommentReply): Promise<void> {
    let key: string | undefined;
    let where: PendingThread | undefined;
    let entry: Review | KnownPr | undefined;
    for (const r of this.reviews.values()) {
      const w = r.threads.get(reply.thread);
      if (w) [key, where, entry] = [r.key, w, r];
    }
    if (!where) {
      const a = this.anchor(reply.thread);
      if (!a) return;
      [key, where, entry] = [a.key, a.where, a.entry];
    }
    try {
      await this.api.submitReview(
        entry!.owner,
        entry!.repo,
        entry!.number,
        reviewPayload({ event: "COMMENT", commitId: entry!.headSha, comments: [{ ...where, body: reply.text }] }),
      );
    } catch (err) {
      void vscode.window.showWarningMessage(messageOf(err, "Couldn't post the comment."));
      return;
    }
    // On GitHub now, so it carries no Delete — removing it here would not
    // remove it there.
    const comment = new ReviewComment_(new vscode.MarkdownString(reply.text), vscode.CommentMode.Preview, this.me(), reply.thread, POSTED);
    reply.thread.comments = [...reply.thread.comments, comment];
    if (!this.reviewOf(reply.thread)) {
      reply.thread.label = "Comment posted";
      this.posted.set(key!, [...(this.posted.get(key!) ?? []), reply.thread]);
    }
    void vscode.window.showInformationMessage("Comment posted to GitHub.");
  }

  // ── GitHub's threads ───────────────────────────────────────────────────────

  /**
   * Draw a pull request's review threads on its diffs, where they sit now —
   * an outdated one has no place there (the page lists it). Threads already
   * drawn are brought up to date in place; comments shown as just posted
   * give way to GitHub's copy.
   */
  showThreads(key: string, threads: readonly PrThread[]): void {
    const k = this.known.get(key);
    if (!k) return;
    for (const t of this.posted.get(key) ?? []) t.dispose();
    this.posted.delete(key);
    const keep = new Set<string>();
    for (const t of threads) {
      if (t.outdated || t.line === null) continue;
      keep.add(t.id);
      const had = this.github.get(t.id);
      if (had) {
        had.data = t;
        this.paintThread(had.thread, t);
        continue;
      }
      const ref: PrRepoRef = { owner: k.owner, repo: k.repo };
      const file = k.files.find((f) => f.filename === t.path);
      const uri =
        t.side === "LEFT"
          ? prBaseUri(ref, { number: k.number }, file?.previousFilename ?? t.path, k.baseSha)
          : prHeadUri(ref, { number: k.number, headSha: k.headSha }, t.path);
      const from = (t.startLine ?? t.line) - 1;
      const thread = this.controller.createCommentThread(uri, new vscode.Range(Math.max(0, from), 0, t.line - 1, 0), []);
      this.paintThread(thread, t);
      this.github.set(t.id, { key, thread, data: t });
    }
    for (const [id, g] of this.github) {
      if (g.key === key && !keep.has(id)) {
        g.thread.dispose();
        this.github.delete(id);
      }
    }
  }

  private paintThread(thread: vscode.CommentThread, t: PrThread): void {
    thread.comments = t.comments.map(
      (c) =>
        new ReviewComment_(
          new vscode.MarkdownString(c.body),
          vscode.CommentMode.Preview,
          {
            name: c.author?.login ?? "ghost",
            ...(c.author?.avatarUrl && /^https:\/\/avatars\.githubusercontent\.com\//.test(c.author.avatarUrl)
              ? { iconPath: vscode.Uri.parse(c.author.avatarUrl) }
              : {}),
          },
          thread,
          POSTED,
        ),
    );
    thread.contextValue = t.resolved ? THREAD_RESOLVED : THREAD_OPEN;
    thread.label = t.resolved ? (t.resolvedBy ? `Resolved by ${t.resolvedBy}` : "Resolved") : undefined;
    thread.canReply = t.canReply;
    thread.collapsibleState = t.resolved ? vscode.CommentThreadCollapsibleState.Collapsed : vscode.CommentThreadCollapsibleState.Expanded;
  }

  /** The id of the GitHub thread an editor thread shows. */
  threadIdOf(thread: vscode.CommentThread): string | undefined {
    for (const [id, g] of this.github) if (g.thread === thread) return id;
    return undefined;
  }

  /** Reply to a GitHub thread; the editor's copy follows, and the page is told. */
  async replyToThread(key: string, thread: PrThread, body: string): Promise<PrThread> {
    const c = await replyToThread(this.graphql, thread.id, body);
    const next: PrThread = {
      ...thread,
      comments: [...thread.comments.filter((x) => !x.sending), { id: c.id, url: c.url, createdAt: c.createdAt, body: c.body, author: c.author }],
      totalComments: thread.totalComments + 1,
    };
    this.threadUpdated(key, next);
    return next;
  }

  /** Resolve a GitHub thread, or open it again. */
  async resolveThread(key: string, thread: PrThread, resolved: boolean): Promise<PrThread> {
    const r = await setThreadResolved(this.graphql, thread.id, resolved);
    const next: PrThread = { ...thread, resolved: r.resolved, ...(r.resolvedBy ? { resolvedBy: r.resolvedBy } : {}), canResolve: !r.resolved, canUnresolve: r.resolved };
    if (!r.resolved) delete next.resolvedBy;
    this.threadUpdated(key, next);
    return next;
  }

  private threadUpdated(key: string, t: PrThread): void {
    const g = this.github.get(t.id);
    if (g) {
      g.data = t;
      this.paintThread(g.thread, t);
    }
    this.threadChanged.fire({ key, thread: t });
  }

  /** From the editor: a reply typed into a GitHub thread. */
  async replyFromEditor(reply: vscode.CommentReply): Promise<void> {
    const id = this.threadIdOf(reply.thread);
    const g = id ? this.github.get(id) : undefined;
    if (!g || !reply.text.trim()) return;
    try {
      await this.replyToThread(g.key, g.data, reply.text);
    } catch (err) {
      void vscode.window.showWarningMessage(messageOf(err, "Couldn't post the reply."));
    }
  }

  /** From the editor: a thread's Resolve / Unresolve. */
  async resolveFromEditor(thread: vscode.CommentThread | undefined, resolved: boolean): Promise<void> {
    const id = thread ? this.threadIdOf(thread) : undefined;
    const g = id ? this.github.get(id) : undefined;
    if (!g) return;
    try {
      await this.resolveThread(g.key, g.data, resolved);
    } catch (err) {
      void vscode.window.showWarningMessage(messageOf(err, resolved ? "Couldn't resolve the conversation." : "Couldn't unresolve the conversation."));
    }
  }

  // ── Keeping it ─────────────────────────────────────────────────────────────

  /** A review changed: kept, counted in the status bar, and the page told. */
  private touched(key: string): void {
    const r = this.reviews.get(key);
    if (r && !r.started && r.threads.size === 0) this.reviews.delete(key);
    this.save();
    this.paintStatus();
    void vscode.commands.executeCommand("setContext", "gitstudio.pr.reviewing", this.reviews.size > 0);
    this.changed.fire(key);
  }

  private save(): void {
    if (!this.memory) return;
    const out: Record<string, StoredReview> = {};
    for (const r of this.reviews.values()) {
      out[`${r.key}@${r.headSha}`] = {
        owner: r.owner,
        repo: r.repo,
        number: r.number,
        title: r.title,
        headSha: r.headSha,
        baseSha: r.baseSha,
        started: r.started,
        comments: this.queued(r),
        patches: r.patches,
        renames: r.renames,
      };
    }
    void this.memory.update(PENDING_REVIEWS_KEY, Object.keys(out).length > 0 ? out : undefined);
  }

  /** The reviews a window reload left: each comment back on its line, as pending. */
  private restore(): void {
    const stored = this.memory?.get<Record<string, StoredReview>>(PENDING_REVIEWS_KEY);
    if (!stored || typeof stored !== "object") return;
    for (const s of Object.values(stored)) {
      if (!s || typeof s.owner !== "string" || typeof s.repo !== "string" || !Number.isSafeInteger(s.number) || typeof s.headSha !== "string") continue;
      const key = prKey(s.owner, s.repo, s.number);
      const r: Review = {
        key,
        owner: s.owner,
        repo: s.repo,
        number: s.number,
        title: typeof s.title === "string" ? s.title : "",
        headSha: s.headSha,
        baseSha: typeof s.baseSha === "string" ? s.baseSha : s.headSha,
        patches: s.patches && typeof s.patches === "object" ? { ...s.patches } : {},
        renames: s.renames && typeof s.renames === "object" ? { ...s.renames } : {},
        started: s.started !== false,
        threads: new Map(),
      };
      const ref: PrRepoRef = { owner: r.owner, repo: r.repo };
      for (const c of Array.isArray(s.comments) ? s.comments : []) {
        if (!c || typeof c.path !== "string" || !Number.isSafeInteger(c.line) || typeof c.body !== "string") continue;
        const side: ReviewSide = c.side === "LEFT" ? "LEFT" : "RIGHT";
        const uri =
          side === "LEFT"
            ? prBaseUri(ref, { number: r.number }, r.renames[c.path] ?? c.path, r.baseSha)
            : prHeadUri(ref, { number: r.number, headSha: r.headSha }, c.path);
        const from = (c.startLine ?? c.line) - 1;
        const thread = this.controller.createCommentThread(uri, new vscode.Range(Math.max(0, from), 0, c.line - 1, 0), []);
        thread.comments = [new ReviewComment_(new vscode.MarkdownString(c.body), vscode.CommentMode.Preview, this.me(), thread)];
        thread.label = "Pending review comment";
        thread.contextValue = PENDING_THREAD;
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        r.threads.set(thread, { path: c.path, side, line: c.line, ...(c.startLine !== undefined && c.startLine !== c.line ? { startLine: c.startLine } : {}) });
      }
      if (r.threads.size > 0 || r.started) this.reviews.set(key, r);
    }
    this.paintStatus();
    void vscode.commands.executeCommand("setContext", "gitstudio.pr.reviewing", this.reviews.size > 0);
  }

  /** "Reviewing #37 · 3 pending" in the status bar while a review is under way. */
  private paintStatus(): void {
    if (this.reviews.size === 0) {
      this.status.hide();
      return;
    }
    const n = this.pendingCount();
    const pending = `${n} pending comment${n === 1 ? "" : "s"}`;
    if (this.reviews.size === 1) {
      const r = [...this.reviews.values()][0];
      this.status.text = `$(comment-discussion) Reviewing #${r.number} · ${n} pending`;
      this.status.tooltip = `Your review of ${r.owner}/${r.repo}#${r.number}${r.title ? ` (${r.title})` : ""}: ${pending}. Click to submit it.`;
    } else {
      this.status.text = `$(comment-discussion) ${this.reviews.size} reviews · ${n} pending`;
      this.status.tooltip = `Your reviews of ${[...this.reviews.values()].map((r) => `${r.owner}/${r.repo}#${r.number}`).join(", ")}: ${pending}. Click to submit one.`;
    }
    this.status.accessibilityInformation = { label: this.status.tooltip };
    this.status.show();
  }

  /** Whose review a `gitstudio.pr.*` palette command means, when there is one. */
  reviewOfActiveEditor(): string | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const at = uri ? this.locate(uri) : undefined;
    return at && this.reviews.has(at.key) ? at.key : undefined;
  }

  /** The review a thread (pending, or on one of its diffs) belongs to. */
  keyOfThread(thread: vscode.CommentThread): string | undefined {
    for (const r of this.reviews.values()) if (r.threads.has(thread)) return r.key;
    const at = thread.uri ? this.locate(thread.uri) : undefined;
    return at && this.reviews.has(at.key) ? at.key : undefined;
  }

  /** A review's pull request, by key. */
  reviewInfo(key: string): { owner: string; repo: string; number: number; title: string } | undefined {
    const r = this.reviews.get(key);
    return r ? { owner: r.owner, repo: r.repo, number: r.number, title: r.title } : undefined;
  }

  async signedInLogin(): Promise<void> {
    this.login ??= (await this.api.currentLogin())?.login ?? this.auth.accountLabel();
  }

  /** Who is signed in to GitHub, read once. */
  async viewerLogin(): Promise<string | undefined> {
    await this.signedInLogin().catch(() => undefined);
    return this.login;
  }

  dispose(): void {
    for (const r of this.reviews.values()) for (const t of r.threads.keys()) t.dispose();
    for (const g of this.github.values()) g.thread.dispose();
    for (const list of this.posted.values()) for (const t of list) t.dispose();
    this.reviews.clear();
    this.github.clear();
    this.posted.clear();
    for (const d of this.disposables) d.dispose();
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

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof GitHubApiError || err instanceof PrListError) return err.message;
  return fallback;
}
