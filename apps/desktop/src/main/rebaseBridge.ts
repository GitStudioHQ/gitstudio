import { runRebasePlan, isRebaseInProgress } from "@gitstudio/git-service/RebaseRunner";
import { buildRebasePlan } from "@gitstudio/git-service/rebasePlan";
import type { RepoStore } from "./repoStore";
import type {
  RebaseApplyRequest,
  RebaseApplyRow,
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

    // Concurrently: the walk for the plan and the walk for the merge count are
    // independent, and on a large repo with no commit-graph each is ~115ms.
    // Run in series that is a quarter-second before the view paints; run
    // together it is the cost of one.
    const [commits, baseCommit, merges] = await Promise.all([
      this.loadCommits(base),
      base === "--root" ? Promise.resolve(undefined) : this.loadBaseCommit(base),
      this.countMerges(base),
    ]);

    const notes: string[] = [];
    // The plan now deliberately omits commits that ARE in the range. Say so —
    // silently dropping rows is how the previous version of this got away with
    // being wrong.
    if (merges > 0) {
      notes.push(
        merges === 1
          ? "A merge commit in this range isn't listed — a rebase replays the merged-in commits one by one and the merge itself disappears."
          : `${merges} merge commits in this range aren't listed — a rebase replays the merged-in commits one by one and the merges themselves disappear.`,
      );
    }
    if (fellBack) {
      notes.push(`“${req.base ?? "that base"}” doesn't resolve here — showing the whole branch instead.`);
    }
    if (commits.length >= MAX_PLAN_COMMITS) {
      // Say what happens to the rest, not just that they are not shown. They
      // ride along as plain picks (see apply → commitsBelowCap); before that
      // they were silently deleted, so this note was worse than incomplete.
      notes.push(
        `Showing the newest ${MAX_PLAN_COMMITS} commits — the older ones in this range are kept as-is. Pick a nearer base to narrow it.`,
      );
    }
    return {
      ok: true,
      base,
      branch,
      commits,
      baseCommit,
      inProgress,
      updateRefs: await this.repoUpdateRefs(),
      message: notes.join(" ") || undefined,
    };
  }

  private async loadCommits(base: string): Promise<RebaseCommitInfo[]> {
    const ctx = this.repos.getContext();
    if (!ctx) {
      return [];
    }
    // THREE dots, and --cherry-pick --right-only, for anything but --root.
    //
    // git's sequencer selects the todo with `--cherry-mark --right-only` over
    // `upstream...HEAD`, which DROPS commits whose patch is already on the base
    // — a backport, a cherry-pick that went both ways, a commit merged upstream
    // by someone else. `<base>..HEAD` keeps them, so the plan listed a commit
    // git's own todo omits; running it made git skip that commit and PAUSE:
    //
    //   warning: skipped previously applied commit 4b20fb3
    //
    // leaving the repo mid-rebase with a clean tree and an in-progress card
    // telling the user to resolve conflicts that do not exist — the same wedge
    // a merge commit in the range used to produce, for the same reason.
    const threeDot = base !== "--root";
    const range = threeDot ? `${base}...HEAD` : "HEAD";
    const sep = "\x1f";
    const r = await ctx.process.run([
      "log",
      ...(threeDot ? ["--cherry-pick", "--right-only"] : []),
      // A rebase FLATTENS merges: it replays the merged-in commits one by one
      // and the merge itself disappears. `git log` lists merges; `git rebase -i`
      // does not — its sequencer builds the todo from
      // `rev-list --reverse --topo-order --no-merges`, and its parser REFUSES
      // `pick <merge>` outright ("error: 'pick' does not accept merge commits").
      // So a feature branch with main merged into it — the ordinary shape —
      // produced a plan git would never accept, and running it left the repo
      // detached at the base, mid-rebase, with a clean tree and no conflict to
      // resolve. Continue re-ran the same failing todo; only Abort escaped.
      "--no-merges",
      // The other half, and load-bearing beyond merges: reversed, this
      // reproduces git's own todo, and the default ordering does not. Measured
      // on a range whose two lines interleave by date — base, then
      // B(Jan 9) → C(Jan 2) on one line and A(Jan 3) on the other:
      //
      //   git log --no-merges          A, C, B  → todo: pick B, pick C, pick A
      //   git log --no-merges --topo   C, B, A  → todo: pick A, pick B, pick C
      //   git rebase -i's OWN todo              → pick A, pick B, pick C
      //
      // Both todos are legal; only one replays the branch the way git would,
      // and the plan is a promise about what running it will do.
      //
      // (It does mean the plan can order differently from the Commits list,
      // which is --date-order. The plan has to match the todo git executes.)
      "--topo-order",
      // Newest first on screen (issue #18); git's todo is the other way round,
      // and apply() does that reversal in exactly one place.
      // Hard cap: rebasing onto --root in a large repo would otherwise try to
      // render thousands of rows (and be a terrible idea to execute).
      `--max-count=${MAX_PLAN_COMMITS}`,
      `--format=%H${sep}%h${sep}%an${sep}%at${sep}%s`,
      range,
    ]);
    if (r.code !== 0) {
      return [];
    }
    // Which local branches sit ON each commit in the range. A rewrite gives
    // every commit a new sha, so a branch pointing at an old one is stranded on
    // a line nothing references — `update-ref` in the todo moves it across.
    const tips = new Map<string, string[]>();
    // FULL refnames, not `%(refname:short)`. The short form is the shortest
    // UNAMBIGUOUS name, so a branch that collides with a tag — v1.2, release,
    // stable, all routine — comes back as `heads/stacked-a`. That string went
    // straight into `update-ref refs/heads/heads/stacked-a`: the rebase created
    // a junk branch under that name, reported success, and left the user's real
    // branch on a parallel line no longer in the rebased history — exactly the
    // orphaning this feature exists to prevent. Verified on a real repo.
    // `RefProvider.ts` already says this in a comment; this code did not follow it.
    //
    // `%(worktreepath)` too: git's own --update-refs REFUSES to move a branch
    // checked out in another worktree, writing a comment into the todo instead
    // ("# Ref refs/heads/x checked out at ..."). Moving it anyway leaves that
    // worktree's HEAD on a rewritten commit while its index and working tree
    // stay behind — `git status` there then shows staged changes nobody made.
    // The app ships a Worktrees feature, so this is a normal setup for its users.
    const headRef = (
      await ctx.process.run(["symbolic-ref", "--quiet", "HEAD"])
    ).stdout.trim();
    const SEP = "\x1e";
    const refs = await ctx.process.run([
      "for-each-ref",
      `--format=%(objectname)${SEP}%(refname)${SEP}%(worktreepath)`,
      "refs/heads",
    ]);
    if (refs.code === 0) {
      for (const line of refs.stdout.split("\n")) {
        if (!line.trim()) continue;
        const [sha, ref, worktree] = line.split(SEP);
        if (!sha || !ref?.startsWith("refs/heads/")) continue;
        // Never the branch being rebased: git moves that one itself, and
        // naming it in an update-ref would fight the rebase for it.
        if (ref === headRef) continue;
        // Nor one checked out anywhere else — see above.
        if (worktree?.trim()) continue;
        const name = ref.slice("refs/heads/".length);
        tips.set(sha, [...(tips.get(sha) ?? []), name]);
      }
    }

    const out: RebaseCommitInfo[] = [];
    for (const line of r.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [sha, shortSha, author, at, subject] = line.split(sep);
      const branches = tips.get(sha);
      out.push({
        sha,
        shortSha,
        author,
        subject: subject ?? "",
        rel: relTime(Number(at) || 0),
        ...(branches?.length ? { branches } : {}),
      });
    }
    return out;
  }

  /**
   * Commits in `base..HEAD` that the plan does not mention — the tail the
   * display cap hid. Returned as plain picks so applying the plan cannot
   * delete history the user never saw. `null` means we could not read the
   * range, which must block the apply rather than silently truncate it.
   */
  private async commitsBelowCap(
    base: string,
    rows: RebaseApplyRow[],
  ): Promise<RebaseApplyRow[] | null> {
    const ctx = this.repos.getContext();
    if (!ctx) return null;
    // The SAME selection as loadCommits, for the same reasons — a merge, or a
    // patch already on the base, re-injected as a `pick` below the display cap
    // wedges the repo just as surely — and so this tail is the same
    // linearization the shown page came from, which is what makes appending it
    // correct.
    const threeDot = base !== "--root";
    const range = threeDot ? `${base}...HEAD` : "HEAD";
    const sep = "\x1f";
    const r = await ctx.process.run([
      "log",
      ...(threeDot ? ["--cherry-pick", "--right-only"] : []),
      "--no-merges",
      "--topo-order",
      `--format=%H${sep}%s`,
      range,
    ]);
    if (r.code !== 0) return null;
    const known = new Set(rows.map((x) => x.sha));
    const out: RebaseApplyRow[] = [];
    for (const line of r.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [sha, subject] = line.split(sep);
      if (!sha || known.has(sha)) continue;
      out.push({ action: "pick", sha, subject: subject ?? "" });
    }
    // git lists newest-first, and so does the plan; appending keeps that order.
    return out;
  }

  /** How many merge commits the range contains. They are NOT in the plan — a
   *  rebase flattens them away — so the view has to say they were left out. */
  private async countMerges(base: string): Promise<number> {
    const ctx = this.repos.getContext();
    if (!ctx) return 0;
    const range = base === "--root" ? "HEAD" : `${base}..HEAD`;
    const r = await ctx.process.run(["rev-list", "--count", "--merges", range]);
    return r.code === 0 ? Number(r.stdout.trim()) || 0 : 0;
  }

  /** The repo's own `rebase.updateRefs`. Following it means the app does what
   *  the user's git already does; ignoring it was how branches got orphaned by
   *  a rebase that their own config said should carry them. */
  private async repoUpdateRefs(): Promise<boolean> {
    const ctx = this.repos.getContext();
    if (!ctx) return false;
    const r = await ctx.process.run(["config", "--get", "--type=bool", "rebase.updateRefs"]);
    return r.code === 0 && r.stdout.trim() === "true";
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

    // The todo IS the plan: a commit in the range but NOT in the todo is
    // dropped. `loadCommits` caps the list at MAX_PLAN_COMMITS so a huge range
    // does not render thousands of rows — a DISPLAY limit — and the note said
    // exactly that ("Showing the first 200 commits"). But apply() then built
    // the todo from those 200 rows and ran it over the whole range, so
    // rebasing 205 commits DELETED the 5 oldest and reported "done".
    // Measured, on a real repo, before this: BEFORE=205 AFTER=200 LOST=5.
    //
    // The commits below the cap are ones the user was never shown and never
    // made a decision about, so they ride along untouched: appended in display
    // order (which is newest-first, so appending puts them oldest-last), which
    // `buildRebasePlan`'s reversal turns into the first picks of the todo.
    const carried = await this.commitsBelowCap(req.base, rows);
    if (carried === null) {
      return {
        status: "failed",
        message:
          "Couldn't read the full commit range, so the plan can't be applied safely. Pick a nearer base and try again.",
      };
    }
    const fullRows = [...rows, ...carried];
    // Display order (newest first) becomes git's todo order in buildRebasePlan,
    // shared with the extension because every way to get this wrong is silent.
    const updateRefs = req.updateRefs ?? (await this.repoUpdateRefs());
    const built = buildRebasePlan(fullRows, { updateRefs });
    if (!built.ok) {
      return { status: "failed", message: built.message };
    }
    const { todo, rewords } = built;

    try {
      // Same options as every other git command here: the app's git, and the
      // observer that feeds the Output tab.
      return await runRebasePlan(root, { base: req.base, todo, rewords }, this.repos.runnerOptions());
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
