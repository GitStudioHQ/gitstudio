import { runRebasePlan, isRebaseInProgress } from "@gitstudio/git-service/RebaseRunner";
import { buildRebasePlan } from "@gitstudio/git-service/rebasePlan";
import type { RepoStore } from "./repoStore";
import type {
  RebaseApplyRequest,
  RebaseCommitInfo,
  RebaseOutcomeWire,
  RebasePlanState,
} from "../shared/ipc";

/**
 * Main-process endpoints for the Rebase view. All the git driving lives in the
 * shared, host-agnostic @gitstudio/git-service/RebaseRunner — the same module
 * the VS Code extension uses — so both hosts behave identically. This file only
 * loads the plan's data and validates a composed plan before running it.
 */
/** Most commits a single rebase plan will show (and therefore rewrite). */
const MAX_PLAN_COMMITS = 200;

/** Todo verbs we will ever emit. NOT "exec" — that runs an arbitrary shell
 *  command, and nothing in the UI offers it. */
const TODO_ACTIONS = new Set(["pick", "reword", "edit", "squash", "fixup", "drop"]);

/** A todo entry is one line; a newline in the subject would start a new
 *  instruction. Collapse all control characters to spaces. */
function oneLineSubject(subject: string): string {
  // eslint-disable-next-line no-control-regex
  return (subject ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

export class RebaseBridge {
  constructor(private readonly repos: RepoStore) {}

  private root(): string | undefined {
    return this.repos.current()?.root;
  }

  /**
   * Load the commits that would be replayed. `base` is the exclusive base ref;
   * when only a `sha` is given, its parent becomes the base (so that commit is
   * the first row) — matching "rebase from here" in the graph.
   */
  async load(req: { base?: string; sha?: string }): Promise<RebasePlanState> {
    const empty: RebasePlanState = {
      ok: false,
      base: "",
      branch: "",
      commits: [],
      inProgress: false,
    };
    const root = this.root();
    const ctx = this.repos.getContext();
    if (!root || !ctx) {
      return { ...empty, message: "Open a repository first." };
    }

    const inProgress = await isRebaseInProgress(root).catch(() => false);

    let base = (req.base ?? "").trim();
    if (!base && req.sha) {
      const parent = await ctx.process.run(["rev-parse", "--verify", "--quiet", `${req.sha}^`]);
      base = parent.code === 0 ? `${req.sha}^` : "--root";
    }
    if (!base) {
      // Default: the commits ahead of the upstream, else the last 10.
      const up = await ctx.process.run([
        "rev-parse", "--abbrev-ref", "--verify", "--quiet", "@{upstream}",
      ]);
      base = up.code === 0 && up.stdout.trim() ? up.stdout.trim() : "HEAD~10";
    }

    // A base that doesn't resolve (e.g. HEAD~10 in a 3-commit repo, or
    // @{upstream} with no upstream) falls back to the root so the view still
    // shows something useful — the whole branch is a legitimate range, and the
    // commit list is capped below.
    let fellBack = false;
    if (base !== "--root") {
      const ok = await ctx.process.run(["rev-parse", "--verify", "--quiet", base]);
      if (ok.code !== 0) {
        base = "--root";
        fellBack = true;
      }
    }

    const branchRes = await ctx.process.run(["rev-parse", "--abbrev-ref", "HEAD"]);
    const b = branchRes.stdout.trim();
    const branch = b && b !== "HEAD" ? b : "detached HEAD";

    const commits = await this.loadCommits(base);
    const baseCommit = base === "--root" ? undefined : await this.loadBaseCommit(base);

    const notes: string[] = [];
    if (fellBack) {
      notes.push(`“${req.base ?? "that base"}” doesn't resolve here — showing the whole branch instead.`);
    }
    if (commits.length >= MAX_PLAN_COMMITS) {
      notes.push(`Showing the first ${MAX_PLAN_COMMITS} commits; pick a nearer base to narrow it.`);
    }
    return {
      ok: true,
      base,
      branch,
      commits,
      baseCommit,
      inProgress,
      message: notes.join(" ") || undefined,
    };
  }

  private async loadCommits(base: string): Promise<RebaseCommitInfo[]> {
    const ctx = this.repos.getContext();
    if (!ctx) {
      return [];
    }
    const range = base === "--root" ? "HEAD" : `${base}..HEAD`;
    const sep = "\x1f";
    const r = await ctx.process.run([
      "log",
      // NEWEST FIRST, matching the Commits list (issue #18). git's todo file is
      // the other way round; apply() does that reversal in exactly one place.
      // Hard cap: rebasing onto --root in a large repo would otherwise try to
      // render thousands of rows (and be a terrible idea to execute).
      `--max-count=${MAX_PLAN_COMMITS}`,
      `--format=%H${sep}%h${sep}%an${sep}%at${sep}%s`,
      range,
    ]);
    if (r.code !== 0) {
      return [];
    }
    const out: RebaseCommitInfo[] = [];
    for (const line of r.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [sha, shortSha, author, at, subject] = line.split(sep);
      out.push({ sha, shortSha, author, subject: subject ?? "", rel: relTime(Number(at) || 0) });
    }
    return out;
  }

  private async loadBaseCommit(base: string): Promise<{ shortSha: string; subject: string } | undefined> {
    const ctx = this.repos.getContext();
    if (!ctx) {
      return undefined;
    }
    const sep = "\x1f";
    const r = await ctx.process.run(["log", "-1", `--format=%h${sep}%s`, base]);
    if (r.code !== 0 || !r.stdout.trim()) {
      return undefined;
    }
    const [shortSha, subject] = r.stdout.trim().split(sep);
    return { shortSha, subject: subject ?? "" };
  }

  /** Validate the composed plan, then run it non-interactively. */
  async apply(req: RebaseApplyRequest): Promise<RebaseOutcomeWire> {
    const root = this.root();
    if (!root) {
      return { status: "failed", message: "Open a repository first." };
    }
    const rows = req.rows ?? [];
    if (!rows.length) {
      return { status: "failed", message: "Nothing to rebase." };
    }
    // Display order (newest first) becomes git's todo order in buildRebasePlan,
    // shared with the extension because every way to get this wrong is silent.
    const built = buildRebasePlan(rows);
    if (!built.ok) {
      return { status: "failed", message: built.message };
    }
    const { todo, rewordMessages } = built;

    try {
      return await runRebasePlan(root, { base: req.base, todo, rewordMessages });
    } catch (err) {
      return { status: "failed", message: err instanceof Error ? err.message : String(err) };
    }
  }

}

/** Compact humanized age, matching the graph's relative times. */
function relTime(epochSeconds: number): string {
  if (!epochSeconds) {
    return "";
  }
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds);
  const mins = Math.floor(secs / 60);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}
