import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { GitProcess } from "./GitProcess";
import {
  abortRebase,
  continueRebase,
  skipRebase,
  type RebaseOutcome,
  type RebaseRunOptions,
} from "./RebaseRunner";
import { describeSides, type OperationFacts } from "@gitstudio/engine/conflict/sides";
import type {
  OperationKind,
  OperationOutcome,
  OperationView,
} from "@gitstudio/host-bridge/conflictsProtocol";

/**
 * What git is in the middle of, named and driven (PLAN §3.2 W1 + §3.3 W3).
 *
 * The rules this follows, each one a bug somebody shipped:
 *
 * - LOCALE-FREE. Everything is decided from the files git writes (MERGE_HEAD,
 *   rebase-merge/, rebase-apply/{rebasing,applying}, CHERRY_PICK_HEAD,
 *   REVERT_HEAD, sequencer/todo, rebase-merge/{done,amend,…}) and from exit
 *   codes — never from git's English. A German git says "Interaktives Rebase
 *   im Gange", and every guard built on git's English status line silently
 *   turned off. The two strings read below are ones git never translates: the
 *   reflog's "(start): checkout " (a machine record) and `diff --check`'s
 *   "leftover conflict marker" — both proven under de_DE in the tests.
 * - Every git-dir path through `gitPath()` (rev-parse --git-path + resolve):
 *   a linked worktree's MERGE_HEAD lives under the main repository's .git.
 * - Display names from `%(refname)` with the prefix stripped by us, never
 *   `name-rev` (it answered "remotes/origin/HEAD") and never a ref built from
 *   a short name (memory: git-refname-short-is-ambiguous).
 * - Continue / Skip / Abort re-read the whole view afterwards; a Continue that
 *   stops on the NEXT commit is a stop, not a failure, and every UI refreshes
 *   from the view it returns.
 * - Capability is decided HERE (canContinue / canSkip / continueBlocked /
 *   willDrop), not re-derived by any UI (memory: state-tables-beat-sweeps).
 */

export interface OperationReadOptions {
  signal?: AbortSignal;
}

/** The cheap answer: which operation, and how many paths are unmerged. No naming. */
export interface OperationDetection {
  kind: OperationKind;
  /** Rebase kinds: "merge" = rebase-merge/, "apply" = rebase-apply/ (+ rebasing). */
  backend?: "merge" | "apply";
  /** `ls-files -u` distinct paths. */
  unmerged: number;
}

export interface OperationControlOptions {
  signal?: AbortSignal;
  /**
   * How the rebase runner spawns git (git path, the host's Output-tab hook,
   * the installer node binary). Rebase verbs go through RebaseRunner so the
   * reword queue survives; defaults to the options given to the constructor.
   */
  runner?: RebaseRunOptions;
}

export interface OperationContinueOptions extends OperationControlOptions {
  /** The user confirmed `view.willDrop`; without it such a Continue is refused. */
  confirmDrop?: boolean;
}

/** Read side — what hosts and tests fake (a fake returns hand-built OperationViews). */
export interface OperationSource {
  view(opts?: OperationReadOptions): Promise<OperationView>;
}

/** Drive side — Continue / Skip / Abort with the gates of PLAN §3.3. */
export interface OperationControl {
  continue(opts?: OperationContinueOptions): Promise<OperationOutcome>;
  skip(opts?: OperationControlOptions): Promise<OperationOutcome>;
  abort(opts?: OperationControlOptions): Promise<OperationOutcome>;
}

/**
 * Which operation files exist, raw — before any precedence is applied. The
 * desktop's legacy GitOpState booleans are exactly these, so its IPC stays
 * byte-compatible while the decision moves here.
 */
export interface OperationMarkers {
  mergeHead: boolean;
  rebaseMerge: boolean;
  rebaseApply: boolean;
  /** `rebase-apply/applying`: the rebase-apply/ directory belongs to `git am`. */
  applying: boolean;
  cherryPickHead: boolean;
  revertHead: boolean;
  /** `sequencer/todo`: a cherry-pick / revert range is still queued. */
  sequencer: boolean;
}

/** Everything one read learned — the view plus the raw facts the desktop adapter needs. */
export interface OperationInspection {
  view: OperationView;
  markers: OperationMarkers;
  /** Unmerged paths, in `ls-files -u` order. */
  unmerged: string[];
  /**
   * The index equals HEAD (`diff --cached --quiet HEAD`). Asked only when an
   * operation is stopped with nothing unmerged; false otherwise.
   */
  indexMatchesHead: boolean;
}

/** The git-dir entries every read asks about, in one `rev-parse` call. */
const GIT_PATHS = [
  "MERGE_HEAD",
  "rebase-merge",
  "rebase-apply",
  "rebase-apply/applying",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "sequencer/todo",
  "MERGE_MSG",
  "FETCH_HEAD",
] as const;
type GitPathName = (typeof GIT_PATHS)[number];

/** A rebase-todo command that replays (or re-creates) a commit — what "commit N of M" counts. */
const PICK_LIKE = /^(p|pick|r|reword|e|edit|s|squash|f|fixup|m|merge)(\s|$)/;

/** The stash markers git writes (stash.c; never translated). */
const STASH_MARKERS = /^(<{7} Updated upstream|>{7} Stashed changes)\r?$/m;

/** Only this much of a working file is read to look for stash markers. */
const STASH_PROBE_BYTES = 1024 * 1024;

export class OperationProvider implements OperationSource, OperationControl {
  constructor(
    private readonly proc: GitProcess,
    /** Absolute repo (worktree) root — `gitPath` resolves against it. */
    private readonly root: string,
    /** Default rebase-runner options (git path, run hook). */
    private readonly runner: RebaseRunOptions = {},
  ) {}

  // ── Read ────────────────────────────────────────────────────────────────────

  /**
   * Which operation git is stopped in + the unmerged count, locale-free.
   * Cheap enough for status bars and hot paths (no naming, no reflog).
   */
  async detect(opts?: OperationReadOptions): Promise<OperationDetection> {
    const paths = await this.gitPaths(opts).catch(() => undefined);
    if (!paths) return { kind: "none", unmerged: 0 };
    const [markers, unmerged] = await Promise.all([
      this.markersAt(paths),
      this.unmergedPaths(opts),
    ]);
    const stash = await this.hasStashMarkers(markers, unmerged);
    const { kind, backend } = kindOf(markers, stash);
    return { kind, ...(backend ? { backend } : {}), unmerged: unmerged.length };
  }

  /** The raw operation files (no precedence). */
  async markers(opts?: OperationReadOptions): Promise<OperationMarkers> {
    return this.markersAt(await this.gitPaths(opts));
  }

  /** The full OperationView: names, step, commit, verbs, gates. */
  async view(opts?: OperationReadOptions): Promise<OperationView> {
    return (await this.inspect(opts)).view;
  }

  /**
   * One read of everything: the view, the raw markers, the unmerged list and
   * whether the index equals HEAD. The desktop's GitOpState adapter uses this
   * so the capability table is computed once, here.
   */
  async inspect(opts?: OperationReadOptions): Promise<OperationInspection> {
    const signal = opts?.signal;
    let paths: Record<GitPathName, string>;
    try {
      paths = await this.gitPaths(opts);
    } catch {
      // Not a repository (or git unusable): nothing can be stopped.
      return {
        view: noneOperationView(""),
        markers: NO_MARKERS,
        unmerged: [],
        indexMatchesHead: false,
      };
    }
    const [markers, unmerged, current, headSha] = await Promise.all([
      this.markersAt(paths),
      this.unmergedPaths(opts),
      this.currentName(signal),
      this.revParse("HEAD", signal),
    ]);
    const stash = await this.hasStashMarkers(markers, unmerged);
    const { kind, backend } = kindOf(markers, stash);

    const facts: OperationFacts = { kind, current, unmerged: unmerged.length };
    if (backend) facts.backend = backend;
    // Which commit / patch / step, and the key of this stop.
    let episode = "none";
    // The commit a cherry-pick / revert stopped on (absent after a manual
    // commit mid-range) — the gates below need it too.
    let pickHead: string | undefined;

    // Is HEAD still where the rebase itself put it (onto, or a commit it has
    // written)? A user who committed their resolution by hand has moved it.
    let headIsRebases = false;

    if (kind === "rebase" || kind === "rebase-merge-step") {
      const dir = backend === "apply" ? paths["rebase-apply"] : paths["rebase-merge"];
      const r = await this.rebaseFacts(dir, backend ?? "merge", kind, unmerged.length, signal);
      Object.assign(facts, r.facts);
      // By prefix: a `done` line may carry an abbreviated id.
      headIsRebases = !!headSha && [...r.written].some((w) => headSha.startsWith(w));
      episode = `${kind}:${r.origHead ?? ""}:${r.position}:${r.rebaseHead ?? "-"}`;
    } else if (kind === "cherry-pick" || kind === "revert") {
      const head = await this.revParse(kind === "cherry-pick" ? "CHERRY_PICK_HEAD" : "REVERT_HEAD", signal);
      pickHead = head;
      const todo = markers.sequencer ? await readText(paths["sequencer/todo"]) : undefined;
      const lines = todoCommands(todo);
      if (head) {
        const c = await this.commitInfo(head, signal);
        if (c) facts.commit = c;
      }
      // sequencer/todo lists the CURRENT pick first, then the rest.
      if (lines.length > 1) facts.queued = lines.length - 1;
      episode = `${kind}:${head ?? `seq:${lines[0] ?? ""}`}`;
    } else if (kind === "am") {
      const dir = paths["rebase-apply"];
      const [next, last, finalCommit, info] = await Promise.all([
        readText(join(dir, "next")),
        readText(join(dir, "last")),
        readText(join(dir, "final-commit")),
        readText(join(dir, "info")),
      ]);
      const n = toInt(next);
      const m = toInt(last);
      if (n && m) facts.step = { n, m, unit: "patch" };
      const subject = firstLine(finalCommit) || infoField(info, "Subject") || "";
      const author = infoField(info, "Author");
      facts.commit = { sha: "", subject, ...(author ? { author } : {}) };
      episode = `am:${n ?? 0}/${m ?? 0}:${subject}:${headSha ?? ""}`;
    } else if (kind === "merge") {
      const mergeHeads = (await readText(paths.MERGE_HEAD) ?? "").split(/\s+/).filter(Boolean);
      facts.incoming = await this.incomingName(mergeHeads, paths, signal);
      episode = `merge:${mergeHeads.join(",")}`;
    } else if (kind === "stash") {
      episode = `stash:${headSha ?? ""}`;
    } else if (unmerged.length > 0) {
      episode = `unmerged:${headSha ?? ""}`;
    }

    // ── Gates (PLAN §3.3) ────────────────────────────────────────────────────
    const inOp = kind !== "none" && kind !== "stash";
    const indexMatchesHead =
      inOp && unmerged.length === 0
        ? (await this.proc.run(["diff", "--cached", "--quiet", "HEAD"], { signal })).code === 0
        : false;
    let canContinue = false;
    let canSkip = false;
    let continueBlocked: string | undefined;
    let willDrop: OperationView["willDrop"];

    if (inOp) {
      const gates: Array<() => Promise<string | undefined>> = [
        async () => (unmerged.length > 0 ? stillConflicted(unmerged) : undefined),
        async () => stagedMarkersMessage(await this.stagedMarkerFiles(signal)),
      ];
      const rebaseKind = kind === "rebase" || kind === "rebase-merge-step";
      if (rebaseKind) {
        // `rebase --continue` refuses ANY unstaged change to a tracked file, on
        // both backends and at a pause, and says "You must edit all merge
        // conflicts and then mark them as resolved using git add" — about a
        // conflict that does not exist (builtin/rebase.c, has_unstaged_changes;
        // naming2.out). Say the real reason instead, naming the file.
        gates.push(async () => unstagedMessage(await this.unstagedFiles(signal)));
      }
      const emptyBlocksContinue =
        (kind === "rebase" && backend === "apply") ||
        ((kind === "cherry-pick" || kind === "revert") && !!pickHead) ||
        kind === "am";
      if (emptyBlocksContinue && !facts.pause) {
        // These refuse to record an empty result and name `--skip` themselves.
        gates.push(async () => (indexMatchesHead ? nothingLeftMessage(kind) : undefined));
      }
      for (const gate of gates) {
        continueBlocked = await gate();
        if (continueBlocked) break;
      }
      canContinue = !continueBlocked;

      if (kind === "rebase") {
        canSkip = backend === "apply" && unmerged.length === 0 && indexMatchesHead;
        // The merge backend DROPS a commit that conflict resolution emptied,
        // silently, on --continue (continue.out: "EMPTY after resolution";
        // verified the same under -i, --empty=stop and --empty=keep). That is
        // the reporter's data loss in its purest form, so it needs a confirm.
        // Not when the user committed the resolution by hand: the index equals
        // HEAD there too, but HEAD has moved past anything the rebase wrote and
        // nothing will be dropped.
        if (
          backend === "merge" &&
          canContinue &&
          !facts.pause &&
          indexMatchesHead &&
          headIsRebases &&
          facts.commit
        ) {
          willDrop = { sha: facts.commit.sha, subject: facts.commit.subject, branch: facts.branch ?? current };
        }
      } else if (kind === "cherry-pick" || kind === "revert") {
        // Skip needs the *_HEAD of the commit being skipped; after a manual
        // commit mid-range only --continue is valid.
        canSkip = !!pickHead;
      } else if (kind === "am") {
        canSkip = true;
      }
      // merge and rebase-merge-step: never Skip (there is no `merge --skip`,
      // and a merge step is ended only by the rebase verbs).
    }

    const sides = describeSides(facts);
    const view: OperationView = {
      kind,
      ...(backend ? { backend } : {}),
      title: sides.title,
      ...(sides.direction ? { direction: sides.direction } : {}),
      ...(facts.step ? { step: facts.step } : {}),
      ...(facts.queued ? { queued: facts.queued } : {}),
      ...(facts.commit ? { commit: facts.commit } : {}),
      yours: sides.yours,
      theirs: sides.theirs,
      verbs: sides.verbs,
      canContinue,
      canSkip,
      ...(inOp && continueBlocked ? { continueBlocked } : {}),
      ...(willDrop ? { willDrop } : {}),
      ...(sides.pause ? { pause: sides.pause } : {}),
      episode,
    };
    return { view, markers, unmerged, indexMatchesHead };
  }

  // ── Drive ───────────────────────────────────────────────────────────────────

  /** Continue whatever is stopped, through every gate of PLAN §3.3. */
  async continue(opts?: OperationContinueOptions): Promise<OperationOutcome> {
    const before = await this.inspect(opts);
    const v = before.view;
    if (v.kind === "none" || v.kind === "stash" || !v.verbs.continue) {
      return this.refused(before, "not-allowed", "There is nothing to continue.");
    }
    if (!v.canContinue) {
      return this.refused(before, "blocked", v.continueBlocked ?? "Continue isn't possible yet.");
    }
    if (v.willDrop && !opts?.confirmDrop) {
      return this.refused(
        before,
        "confirm-drop",
        `Continuing will drop ${v.willDrop.sha.slice(0, 7)} “${v.willDrop.subject}” from ${v.willDrop.branch}: ` +
          `the resolution left it with no changes.`,
      );
    }
    const runner = opts?.runner ?? this.runner;
    let ran: Ran;
    switch (v.kind) {
      case "merge":
        // NOT `merge --continue` (it takes no arguments, and `-c core.editor`
        // loses to an inherited GIT_EDITOR) and NOT a plain `commit --no-edit`,
        // which leaves git's "# Conflicts:" lines in the message
        // (continue.out: "Merge branch 'test'||# Conflicts:|#	f.txt").
        ran = await this.git(["commit", "--no-edit", "--cleanup=strip"], opts);
        break;
      case "rebase-merge-step":
        if (before.indexMatchesHead) {
          // `rebase --continue` on a merge step whose resolution equals HEAD
          // FINISHES WITHOUT RECORDING THE MERGE and leaves MERGE_HEAD behind
          // ("All conflicts fixed but you are still merging"): the merged
          // branch silently falls out of the rewritten history (verified,
          // scratchpad p2/exp4.sh). Record it first, as the original merge
          // commit (its message and author), then let the rebase go on.
          const rec = await this.git(
            v.commit?.sha ? ["commit", "-C", v.commit.sha] : ["commit", "--no-edit", "--cleanup=strip"],
            opts,
          );
          if (rec.code !== 0) {
            ran = rec;
            break;
          }
        }
        ran = fromRunner(await continueRebase(this.root, runner));
        break;
      case "rebase":
        // Through the runner, which keeps the reword queue (RebaseRunner.ts).
        ran = fromRunner(await continueRebase(this.root, runner));
        break;
      case "cherry-pick":
        ran = await this.git(["cherry-pick", "--continue", "--no-edit"], opts);
        break;
      case "revert":
        ran = await this.git(["revert", "--continue", "--no-edit"], opts);
        break;
      case "am":
        // Reuses the patch's own message and author.
        ran = await this.git(["am", "--continue"], opts);
        break;
      default:
        return this.refused(before, "not-allowed", "There is nothing to continue.");
    }
    return this.settle(before, ran, "continue", opts);
  }

  /** Skip the stopped commit / patch — only where git itself names it. */
  async skip(opts?: OperationControlOptions): Promise<OperationOutcome> {
    const before = await this.inspect(opts);
    const v = before.view;
    if (!v.canSkip) {
      return this.refused(before, "not-allowed", "Skip isn't offered here.");
    }
    let ran: Ran;
    switch (v.kind) {
      case "rebase":
        ran = fromRunner(await skipRebase(this.root, opts?.runner ?? this.runner));
        break;
      case "cherry-pick":
        ran = await this.git(["cherry-pick", "--skip"], opts);
        break;
      case "revert":
        ran = await this.git(["revert", "--skip"], opts);
        break;
      case "am":
        ran = await this.git(["am", "--skip"], opts);
        break;
      default:
        return this.refused(before, "not-allowed", "Skip isn't offered here.");
    }
    return this.settle(before, ran, "skip", opts);
  }

  /**
   * Abort with the operation's OWN verb. `git am` is aborted by `am --abort`
   * (Merge Studio ran `rebase --abort` there and got exit 128 — products.out);
   * a stash re-apply or bare unmerged files by `reset --merge`, which keeps
   * the stash entry (git-semantics extra.out).
   */
  async abort(opts?: OperationControlOptions): Promise<OperationOutcome> {
    const before = await this.inspect(opts);
    const v = before.view;
    if (v.kind === "none" && before.unmerged.length === 0) {
      return this.refused(before, "not-allowed", "There is nothing to abort.");
    }
    let ran: Ran;
    let warning: string | undefined;
    switch (v.kind) {
      case "merge":
        ran = await this.git(["merge", "--abort"], opts);
        break;
      case "rebase":
      case "rebase-merge-step":
        // The runner also forgets the reword queue.
        ran = fromRunner(await abortRebase(this.root, opts?.runner ?? this.runner));
        break;
      case "cherry-pick":
        ran = await this.git(["cherry-pick", "--abort"], opts);
        break;
      case "revert":
        ran = await this.git(["revert", "--abort"], opts);
        break;
      case "am": {
        // git declines to rewind when HEAD moved since the last am failure,
        // prints "Not rewinding to ORIG_HEAD" and still exits 0. Decided from
        // the file git itself consults (am.c safe_to_abort), not from its
        // English.
        const safety = firstLine(await readText(join((await this.gitPaths(opts))["rebase-apply"], "abort-safety")));
        const head = await this.revParse("HEAD", opts?.signal);
        if (safety && head && safety !== head) {
          warning =
            "The patch series was abandoned, but HEAD had moved since it started, so git left it " +
            "where it is rather than rewinding. Check the log before carrying on.";
        }
        ran = await this.git(["am", "--abort"], opts);
        break;
      }
      default:
        // stash / none with unmerged files.
        ran = await this.git(["reset", "--merge"], opts);
        break;
    }
    const out = await this.settle(before, ran, "abort", opts);
    if (warning && out.ok) out.message = warning;
    return out;
  }

  /**
   * The absolute path of a git-dir entry (`MERGE_HEAD`, `rebase-merge`,
   * `rebase-apply/applying`, `index`, …) for THIS worktree:
   * `git rev-parse --git-path <name>` resolved against the root. resolve(),
   * never join(): inside a linked worktree git answers with an ABSOLUTE path
   * (…/main/.git/worktrees/<wt>/MERGE_HEAD), and a join produces a path that
   * cannot exist — the bug that blinded two operation watchers.
   * Rejects when git cannot answer (not a repository).
   */
  async gitPath(name: string, opts?: OperationReadOptions): Promise<string> {
    const r = await this.proc.run(["rev-parse", "--git-path", name], {
      signal: opts?.signal,
    });
    if (r.code !== 0) {
      throw new Error(r.stderr.trim() || `git rev-parse --git-path ${name} failed (${r.code}).`);
    }
    return resolve(this.root, r.stdout.trim());
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  /** Every GIT_PATHS entry in ONE rev-parse (it answers each --git-path in order). */
  private async gitPaths(opts?: OperationReadOptions): Promise<Record<GitPathName, string>> {
    const args = ["rev-parse"];
    for (const p of GIT_PATHS) args.push("--git-path", p);
    const r = await this.proc.run(args, { signal: opts?.signal });
    const lines = r.stdout.split("\n").map((l) => l.replace(/\r$/, ""));
    if (r.code !== 0 || lines.length < GIT_PATHS.length) {
      throw new Error(r.stderr.trim() || `git rev-parse --git-path failed (${r.code}).`);
    }
    const out = {} as Record<GitPathName, string>;
    GIT_PATHS.forEach((name, i) => {
      out[name] = resolve(this.root, lines[i]);
    });
    return out;
  }

  private async markersAt(paths: Record<GitPathName, string>): Promise<OperationMarkers> {
    const [mergeHead, rebaseMerge, rebaseApply, applying, cherryPickHead, revertHead, sequencer] =
      await Promise.all([
        exists(paths.MERGE_HEAD),
        exists(paths["rebase-merge"]),
        exists(paths["rebase-apply"]),
        exists(paths["rebase-apply/applying"]),
        exists(paths.CHERRY_PICK_HEAD),
        exists(paths.REVERT_HEAD),
        exists(paths["sequencer/todo"]),
      ]);
    return { mergeHead, rebaseMerge, rebaseApply, applying, cherryPickHead, revertHead, sequencer };
  }

  /** Distinct unmerged paths, `-z` so non-ASCII names are never C-quoted. */
  private async unmergedPaths(opts?: OperationReadOptions): Promise<string[]> {
    const r = await this.proc.run(["ls-files", "-u", "-z"], { signal: opts?.signal });
    if (r.code !== 0) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const rec of r.stdout.split("\0")) {
      const m = /^\d{6} [0-9a-f]+ \d\t([\s\S]*)$/.exec(rec);
      if (m && !seen.has(m[1])) {
        seen.add(m[1]);
        out.push(m[1]);
      }
    }
    return out;
  }

  /**
   * A stash re-apply (`stash pop/apply`, or an autostash that conflicted) leaves
   * unmerged files and NO operation file; git's stash markers are the only
   * trace. Heuristic by design: with the markers already removed it falls back
   * to "none", whose labels are neutral and which swaps nothing — safe.
   */
  private async hasStashMarkers(markers: OperationMarkers, unmerged: string[]): Promise<boolean> {
    if (unmerged.length === 0 || anyMarker(markers)) return false;
    for (const rel of unmerged.slice(0, 50)) {
      const text = await readHead(resolve(this.root, rel), STASH_PROBE_BYTES);
      if (text !== undefined && STASH_MARKERS.test(text)) return true;
    }
    return false;
  }

  /** HEAD's branch (refs/heads/ stripped by us), else the short sha; "" when unborn. */
  private async currentName(signal?: AbortSignal): Promise<string> {
    const sym = await this.proc.run(["symbolic-ref", "-q", "HEAD"], { signal });
    const full = sym.code === 0 ? sym.stdout.trim() : "";
    if (full.startsWith("refs/heads/")) return full.slice("refs/heads/".length);
    const short = await this.proc.run(["rev-parse", "--short", "HEAD"], { signal });
    return short.code === 0 ? short.stdout.trim() : "";
  }

  /** The object name `rev` resolves to, or undefined. `rev` is always one of OUR literals or a full sha. */
  private async revParse(rev: string, signal?: AbortSignal): Promise<string | undefined> {
    const r = await this.proc.run(["rev-parse", "-q", "--verify", `${rev}^{commit}`], { signal });
    const out = r.stdout.trim();
    return r.code === 0 && out ? out : undefined;
  }

  private async commitInfo(
    sha: string,
    signal?: AbortSignal,
  ): Promise<{ sha: string; subject: string; author?: string } | undefined> {
    const r = await this.proc.run(["log", "-1", "--no-walk", "--format=%H%x00%s%x00%an", sha], { signal });
    if (r.code !== 0) return undefined;
    const [full, subject, author] = r.stdout.replace(/\n$/, "").split("\0");
    if (!full) return undefined;
    return { sha: full, subject: subject ?? "", ...(author ? { author } : {}) };
  }

  /** Everything a rebase stop needs named: branch, onto, commit, step, pause. */
  private async rebaseFacts(
    dir: string,
    backend: "merge" | "apply",
    kind: "rebase" | "rebase-merge-step",
    unmerged: number,
    signal?: AbortSignal,
  ): Promise<{
    facts: Partial<OperationFacts>;
    rebaseHead?: string;
    origHead?: string;
    position: string;
    /** Commits the rebase itself has put HEAD on: onto, every rewritten commit, every label. */
    written: Set<string>;
  }> {
    const [headName, ontoRaw, origRaw, done, todo, amend, squashOnto, next, last, stoppedSha, rewritten, labels] =
      await Promise.all([
        readText(join(dir, "head-name")),
        readText(join(dir, "onto")),
        readText(join(dir, "orig-head")),
        backend === "merge" ? readText(join(dir, "done")) : Promise.resolve(undefined),
        backend === "merge" ? readText(join(dir, "git-rebase-todo")) : Promise.resolve(undefined),
        backend === "merge" ? exists(join(dir, "amend")) : Promise.resolve(false),
        backend === "merge" ? readText(join(dir, "squash-onto")) : Promise.resolve(undefined),
        backend === "apply" ? readText(join(dir, "next")) : Promise.resolve(undefined),
        backend === "apply" ? readText(join(dir, "last")) : Promise.resolve(undefined),
        backend === "merge" ? readText(join(dir, "stopped-sha")) : Promise.resolve(undefined),
        readText(join(dir, backend === "merge" ? "rewritten-list" : "rewritten")),
        backend === "merge"
          ? this.proc.run(["for-each-ref", "--format=%(objectname)", "refs/rewritten/"], { signal })
          : Promise.resolve(undefined),
      ]);
    const onto = firstLine(ontoRaw);
    const origHead = firstLine(origRaw);
    const rebaseHead = await this.revParse("REBASE_HEAD", signal);
    const facts: Partial<OperationFacts> = {};
    // "<old> <new>" per rewritten commit; `reset <label>` moves HEAD to a
    // refs/rewritten/<label> commit.
    const written = new Set<string>(onto ? [onto] : []);
    for (const l of (rewritten ?? "").split("\n")) {
      const n = l.trim().split(/\s+/)[1];
      if (n) written.add(n);
    }
    if (labels && labels.code === 0) {
      for (const l of labels.stdout.split("\n")) if (l.trim()) written.add(l.trim());
    }

    // The branch being rebased: head-name, or the short orig-head when the
    // rebase started detached ("detached HEAD" is literally what git writes).
    const hn = firstLine(headName);
    let branchRef: string | undefined;
    if (hn && hn.startsWith("refs/")) {
      branchRef = hn;
      facts.branch = shortName(hn);
    } else if (origHead) {
      facts.branch = origHead.slice(0, 7);
    }

    // Where it is going.
    if (onto) {
      const sq = firstLine(squashOnto);
      if (sq && sq === onto) {
        facts.ontoIsRoot = true;
      } else {
        const name = await this.ontoName(onto, branchRef, signal);
        if (name) facts.onto = name;
        else {
          const c = await this.commitInfo(onto, signal);
          if (c) facts.ontoCommit = { sha: c.sha, subject: c.subject };
        }
      }
    }

    // Progress.
    let position = "";
    if (backend === "merge") {
      const doneLines = todoCommands(done);
      const todoLines = todoCommands(todo);
      // A pick the sequencer FAST-FORWARDED keeps its own sha and is recorded
      // nowhere else: `rebase -i` / `--keep-base` skips every leading pick
      // whose parent is already where it is going (skip_unnecessary_picks),
      // moves HEAD onto the last of them, and writes those lines straight to
      // `done` — not to rewritten-list, and `onto` still names the old base.
      // Without these, HEAD at the first real stop looked like a hand commit,
      // and an emptied pick there was dropped with no warning at all.
      for (const l of doneLines) {
        const sha = pickedCommit(l);
        if (sha) written.add(sha);
      }
      // Counted from the commands themselves, never msgnum/end: those count
      // exec, label and update-ref lines too (extra.out read 3/4 for 2/3).
      const n = doneLines.filter((l) => PICK_LIKE.test(l)).length;
      const m = n + todoLines.filter((l) => PICK_LIKE.test(l)).length;
      // n includes the current one; a pause before the first pick has none.
      if (n > 0) facts.step = { n, m, unit: kind === "rebase-merge-step" ? "step" : "commit" };
      position = String(doneLines.length);
      const lastDone = doneLines[doneLines.length - 1] ?? "";
      if (kind === "rebase-merge-step") {
        const label = mergeLabel(lastDone);
        if (label) facts.label = label;
      }
      // Deliberate pauses: nothing to resolve.
      if (unmerged === 0 && kind === "rebase") {
        if (amend) {
          facts.pause = { reason: "edit" };
        } else if (/^(b|break)(\s|$)/.test(lastDone)) {
          facts.pause = { reason: "break" };
        } else if (/^(x|exec)\s/.test(lastDone) && !rebaseHead && !firstLine(stoppedSha)) {
          facts.pause = { reason: "exec-failed", command: lastDone.replace(/^(x|exec)\s+/, "") };
        }
      }
    } else {
      const n = toInt(next);
      const m = toInt(last);
      if (n && m) facts.step = { n, m, unit: "commit" };
      position = String(n ?? 0);
    }

    // The commit being replayed (the merge being re-created, for a merge step).
    if (rebaseHead) {
      const c = await this.commitInfo(rebaseHead, signal);
      if (c) facts.commit = c;
    }
    return { facts, rebaseHead, origHead, position, written };
  }

  /**
   * onto's display name (PLAN §3.2), the first of these that RESOLVES to onto:
   * 1. the reflog's "(start): checkout <X>" — what the user typed;
   * 2. the rebased branch's configured upstream;
   * 3. the single local branch at onto, else the single remote-tracking branch
   *    (never a remote's HEAD alias), else a tag.
   * undefined when nothing names it (the caller falls back to "{sha7} ({subject})").
   */
  private async ontoName(onto: string, branchRef: string | undefined, signal?: AbortSignal): Promise<string | undefined> {
    // 1. The start entry. `-F`: the pattern is a literal. The reflog message is
    // a machine record git never translates.
    const log = await this.proc.run(
      ["log", "-g", "-F", "--grep-reflog=(start): checkout ", "-n", "1", "--format=%gs", "HEAD"],
      { signal },
    );
    if (log.code === 0) {
      const m = /\(start\): checkout (.+)$/.exec(log.stdout.trim());
      const x = m?.[1]?.trim();
      // `pull --rebase` records a raw sha there — that is not a name.
      if (x && !x.startsWith("-") && !/^[0-9a-f]{7,64}$/.test(x)) {
        if ((await this.revParse(x, signal)) === onto) return shortName(x);
      }
    }
    // 2. The upstream of the rebased branch.
    if (branchRef) {
      const up = await this.proc.run(
        ["for-each-ref", "--format=%(refname)%00%(upstream)", branchRef],
        { signal },
      );
      if (up.code === 0) {
        for (const line of up.stdout.split("\n")) {
          const [ref, upstream] = line.split("\0");
          if (ref === branchRef && upstream && (await this.revParse(upstream, signal)) === onto) {
            return shortName(upstream);
          }
        }
      }
    }
    // 3. What points at it.
    return this.nameOf(onto, [], signal);
  }

  /**
   * A display name for `sha` from the refs that point at it: the single local
   * branch, else the single remote-tracking branch (never a remote's HEAD
   * alias), else a tag.
   * `prefer` breaks a tie between several candidates of the same class.
   */
  private async nameOf(sha: string, prefer: string[], signal?: AbortSignal): Promise<string | undefined> {
    const r = await this.proc.run(["for-each-ref", `--points-at=${sha}`, "--format=%(refname)"], { signal });
    if (r.code !== 0) return undefined;
    const refs = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    const heads = refs.filter((x) => x.startsWith("refs/heads/"));
    const remotes = refs.filter((x) => x.startsWith("refs/remotes/") && !x.endsWith("/HEAD"));
    const tags = refs.filter((x) => x.startsWith("refs/tags/"));
    for (const group of [heads, remotes, tags]) {
      if (group.length === 0) continue;
      const hit = group.length === 1 ? group[0] : group.find((x) => prefer.includes(shortName(x)));
      return shortName(hit ?? group[0]);
    }
    return undefined;
  }

  /**
   * What a merge is bringing in (PLAN §3.2 "Merge incoming"). MERGE_MSG is read
   * only here, only as a tie-break or for a `git pull`, and its quoted name is
   * trusted only when it resolves to MERGE_HEAD (`git merge -m` can write any
   * first line). MERGE_MSG's "Merge branch 'x' of <url>" is fmt-merge-msg's,
   * which git does not translate.
   */
  private async incomingName(
    mergeHeads: string[],
    paths: Record<GitPathName, string>,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (mergeHeads.length === 0) return undefined;
    const msg = firstLine(await readText(paths.MERGE_MSG)) ?? "";
    const quoted = [...msg.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    const names: string[] = [];
    for (const sha of mergeHeads) {
      // `git pull`: a branch fetched from a URL. Trusted only when FETCH_HEAD
      // really fetched this commit.
      const pull = /^Merge (?:remote-tracking )?branch '([^']+)' of (\S.*?)(?: into .*)?$/.exec(msg);
      if (pull && (await this.fetchedFor(sha, paths))) {
        names.push(`${pull[1]} (from ${await this.remoteNameFor(pull[2], signal)})`);
        continue;
      }
      const prefer: string[] = [];
      for (const q of quoted) {
        if ((await this.revParse(q, signal)) === sha) prefer.push(q);
      }
      const named = await this.nameOf(sha, prefer, signal);
      if (named) {
        names.push(named);
        continue;
      }
      const c = await this.commitInfo(sha, signal);
      names.push(c ? `${c.sha.slice(0, 7)} ${c.subject}`.trimEnd() : sha.slice(0, 7));
    }
    return names.join(", ");
  }

  /** Did the last fetch bring in `sha` (a pull's merge)? */
  private async fetchedFor(sha: string, paths: Record<GitPathName, string>): Promise<boolean> {
    const fetched = await readText(paths.FETCH_HEAD);
    if (!fetched) return false;
    return fetched.split("\n").some((l) => l.startsWith(sha) && !/\tnot-for-merge\t/.test(l));
  }

  /** The configured remote whose URL is `url`, else the URL's last path part. */
  private async remoteNameFor(url: string, signal?: AbortSignal): Promise<string> {
    const norm = (u: string): string => u.trim().replace(/\/+$/, "").replace(/\.git$/, "");
    const r = await this.proc.run(["config", "--get-regexp", "^remote\\..*\\.url$"], { signal });
    if (r.code === 0) {
      for (const line of r.stdout.split("\n")) {
        const m = /^remote\.(.+)\.url (.+)$/.exec(line.trim());
        if (m && norm(m[2]) === norm(url)) return m[1];
      }
    }
    const tail = norm(url).split(/[/:\\]/).filter(Boolean).pop();
    return tail || url;
  }

  /**
   * Files whose STAGED content still carries conflict markers, among the files
   * resolved during this stop (the index's resolve-undo list). Scoped that way
   * on purpose: a commit that adds a merge tool's test fixture legitimately
   * contains marker-shaped lines, and checking every staged file would block
   * Continue forever with no way out (the desktop's stage() draws the same line).
   */
  async stagedMarkerFiles(signal?: AbortSignal): Promise<string[]> {
    const ru = await this.proc.run(["ls-files", "--resolve-undo", "-z"], { signal });
    if (ru.code !== 0) return [];
    const resolved = new Set<string>();
    for (const rec of ru.stdout.split("\0")) {
      const m = /^\d{6} [0-9a-f]+ \d\t([\s\S]*)$/.exec(rec);
      if (m) resolved.add(m[1]);
    }
    if (resolved.size === 0) return [];
    const r = await this.proc.run(
      ["-c", "core.quotePath=false", "--literal-pathspecs", "diff", "--cached", "--check", "--", ...resolved],
      { signal },
    );
    // Exit 0 = clean. Exit 2 also covers whitespace errors, so keep only the
    // marker lines — "leftover conflict marker" is a diagnostic git never
    // translates (verified under de_DE).
    if (r.code === 0) return [];
    const files: string[] = [];
    for (const line of r.stdout.split("\n")) {
      const m = /^(.*):\d+: leftover conflict marker$/.exec(line.trim());
      if (m && !files.includes(m[1])) files.push(m[1]);
    }
    return files;
  }

  /** Tracked files with unstaged changes (what `rebase --continue` refuses on). */
  private async unstagedFiles(signal?: AbortSignal): Promise<string[]> {
    const r = await this.proc.run(["diff", "--name-only", "-z", "--ignore-submodules"], { signal });
    if (r.code !== 0) return [];
    return r.stdout.split("\0").filter(Boolean);
  }

  private async git(args: string[], opts?: OperationControlOptions): Promise<Ran> {
    const r = await this.proc.run(args, { signal: opts?.signal });
    return { code: r.code, stdout: r.stdout, stderr: r.stderr };
  }

  private refused(
    before: OperationInspection,
    refused: NonNullable<OperationOutcome["refused"]>,
    message: string,
  ): OperationOutcome {
    return {
      ok: false,
      refused,
      message,
      expected: true,
      view: before.view,
      remainingConflicts: before.unmerged.length,
    };
  }

  /**
   * What the verb did, decided from the repository AFTER it — never from git's
   * words: the operation ended (done), moved to a new stop (stopped), or is
   * where it was (failed, with git's own first line of explanation).
   */
  private async settle(
    before: OperationInspection,
    ran: Ran,
    verb: "continue" | "skip" | "abort",
    opts?: OperationReadOptions,
  ): Promise<OperationOutcome> {
    const after = await this.inspect(opts);
    const v = after.view;
    const remainingConflicts = after.unmerged.length;
    const kindBefore = before.view.kind;
    const ended = v.kind === "none" && remainingConflicts === 0;
    if (ended && ran.code === 0) {
      return { ok: true, message: doneMessage(kindBefore, verb), view: v, remainingConflicts };
    }
    const moved = v.kind !== "none" && v.episode !== before.view.episode;
    if (verb !== "abort" && (moved || (ran.code === 0 && v.kind !== "none"))) {
      // A DIFFERENT kind now (a rebase finished, then its autostash conflicted
      // on the way back) is the old operation done and a new stop.
      const message =
        v.kind !== kindBefore && !(kindBefore === "rebase" && v.kind === "rebase-merge-step") &&
        !(kindBefore === "rebase-merge-step" && v.kind === "rebase")
          ? `${doneMessage(kindBefore, verb)}. Then: ${v.title}`
          : stoppedMessage(v, remainingConflicts);
      return { ok: false, stopped: true, expected: true, message, view: v, remainingConflicts };
    }
    const why = explain(ran) || `git exited with code ${ran.code ?? "unknown"}.`;
    return {
      ok: false,
      message: why,
      // A sequencer verb that did not move is a state the user is in (an empty
      // pick, a patch that will not apply) — the desktop marked these
      // `alwaysExpected` for the same reason. A failed merge commit or abort
      // is reported.
      ...(verb !== "abort" && kindBefore !== "merge" ? { expected: true } : {}),
      view: v,
      remainingConflicts,
    };
  }
}

/**
 * The view for "no operation" (and the stub's only answer): kind
 * "none", no verbs but Cancel, nothing allowed. `current` is HEAD's display
 * name when the caller knows it.
 */
export function noneOperationView(current: string): OperationView {
  const sides = describeSides({ kind: "none", current });
  return {
    kind: "none",
    title: sides.title,
    yours: sides.yours,
    theirs: sides.theirs,
    verbs: sides.verbs,
    canContinue: false,
    canSkip: false,
    episode: "none",
  };
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

const NO_MARKERS: OperationMarkers = {
  mergeHead: false,
  rebaseMerge: false,
  rebaseApply: false,
  applying: false,
  cherryPickHead: false,
  revertHead: false,
  sequencer: false,
};

function anyMarker(m: OperationMarkers): boolean {
  return m.mergeHead || m.rebaseMerge || m.rebaseApply || m.cherryPickHead || m.revertHead || m.sequencer;
}

/**
 * THE precedence (design P2 W1): rebase (a merge step first), am, cherry-pick,
 * revert, merge; then stash; then none. A `--rebase-merges` stop inside a merge
 * step leaves MERGE_HEAD *and* rebase-merge/ — calling it a merge pointed Abort
 * at `git merge --abort`, which throws away a hand resolution and leaves the
 * rebase running (opMatrix.test.ts).
 */
export function kindOf(
  m: OperationMarkers,
  stash: boolean,
): { kind: OperationKind; backend?: "merge" | "apply" } {
  if (m.rebaseMerge) {
    return m.mergeHead ? { kind: "rebase-merge-step", backend: "merge" } : { kind: "rebase", backend: "merge" };
  }
  if (m.rebaseApply) {
    // `git am` shares rebase-apply/; git marks it `applying` (a rebase on the
    // apply backend writes `rebasing`).
    return m.applying ? { kind: "am" } : { kind: "rebase", backend: "apply" };
  }
  if (m.cherryPickHead) return { kind: "cherry-pick" };
  if (m.revertHead) return { kind: "revert" };
  if (m.mergeHead) return { kind: "merge" };
  if (m.sequencer) {
    // A range whose current pick was committed by hand: CHERRY_PICK_HEAD is
    // gone, the queue is not, and `--continue` is the way on. git status reads
    // the same file to report it.
    return { kind: "cherry-pick" };
  }
  if (stash) return { kind: "stash" };
  return { kind: "none" };
}

/** Todo / done lines that are commands (no blanks, no comments). */
function todoCommands(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

/**
 * The label a `merge` todo line re-creates: `merge -C <sha> side # Merge branch
 * 'side' into feat` → "side". Octopus labels are joined.
 */
export function mergeLabel(line: string): string | undefined {
  const m = /^(?:m|merge)\s+(.*)$/.exec(line.trim());
  if (!m) return undefined;
  const words = m[1].split("#")[0].trim().split(/\s+/).filter(Boolean);
  const labels: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === "-C" || w === "-c") {
      i++; // its commit
      continue;
    }
    if (w.startsWith("-")) continue;
    labels.push(w);
  }
  return labels.length ? labels.join(", ") : undefined;
}

/**
 * The original commit a replaying todo line names — `pick <sha> …`,
 * `fixup -C <sha> …`, `merge -C <sha> <label> …` — or undefined for any
 * other line (exec, label, reset, update-ref, a merge with no -C). At least 7
 * hex digits, so a prefix match can never be a coincidence of two characters.
 */
export function pickedCommit(line: string): string | undefined {
  const m = /^(?:p|pick|r|reword|e|edit|s|squash|f|fixup|m|merge)\s+(?:-[cC]\s+)?([0-9a-f]{7,64})(?:\s|$)/.exec(
    line.trim(),
  );
  return m?.[1];
}

/** refs/heads/x → x, refs/remotes/origin/x → origin/x, refs/tags/v1 → v1. Display only. */
export function shortName(ref: string): string {
  for (const p of ["refs/heads/", "refs/remotes/", "refs/tags/"]) {
    if (ref.startsWith(p)) return ref.slice(p.length);
  }
  return ref;
}

function firstLine(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const line = text.split("\n")[0]?.replace(/\r$/, "").trim();
  return line || undefined;
}

function toInt(text: string | undefined): number | undefined {
  const n = Number.parseInt(firstLine(text) ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** A field of `rebase-apply/info` ("Author: …", "Subject: …"). */
function infoField(info: string | undefined, field: string): string | undefined {
  if (!info) return undefined;
  for (const line of info.split("\n")) {
    if (line.startsWith(`${field}: `)) return line.slice(field.length + 2).trim() || undefined;
  }
  return undefined;
}

function list(paths: string[]): string {
  return paths.length === 1 ? paths[0] : `${paths[0]} and ${paths.length - 1} more`;
}

function stillConflicted(paths: string[]): string {
  return paths.length === 1
    ? `${paths[0]} still has conflicts`
    : `${paths.length} files still have conflicts`;
}

function stagedMarkersMessage(files: string[]): string | undefined {
  if (files.length === 0) return undefined;
  return files.length === 1
    ? `${files[0]} still has conflict markers staged`
    : `${list(files)} still have conflict markers staged`;
}

function unstagedMessage(files: string[]): string | undefined {
  if (files.length === 0) return undefined;
  return (
    `${list(files)} ${files.length === 1 ? "has" : "have"} changes that aren't staged. ` +
    `Stage or stash them first — git won't continue a rebase with unstaged changes.`
  );
}

function nothingLeftMessage(kind: OperationKind): string {
  if (kind === "am") {
    return "Nothing is staged for this patch. Apply it by hand and stage the result, or skip the patch.";
  }
  return "The resolution leaves nothing to commit for this commit. Skip it instead.";
}

const OP_NOUN: Record<OperationKind, string> = {
  merge: "Merge",
  rebase: "Rebase",
  "rebase-merge-step": "Rebase",
  "cherry-pick": "Cherry-pick",
  revert: "Revert",
  am: "Patch series",
  stash: "Stash",
  none: "Operation",
};

function doneMessage(kind: OperationKind, verb: "continue" | "skip" | "abort"): string {
  if (verb === "abort") {
    if (kind === "stash") return "Cancelled. Your stashed changes are still in the stash.";
    if (kind === "none") return "Cancelled. The conflicted files are back to their last commit.";
    if (kind === "am") return "Patch series abandoned";
    return `${OP_NOUN[kind]} aborted`;
  }
  if (kind === "am") return "All patches applied";
  return `${OP_NOUN[kind]} complete`;
}

function stoppedMessage(v: OperationView, remaining: number): string {
  if (v.pause) return v.pause.detail;
  const where = v.step
    ? `Stopped at ${v.step.unit} ${v.step.n} of ${v.step.m}`
    : "Stopped";
  const what = v.commit && v.commit.sha ? `: ${v.commit.sha.slice(0, 7)} ${v.commit.subject}`.trimEnd() : "";
  const left = remaining > 0 ? ` — ${remaining} ${remaining === 1 ? "file" : "files"} to resolve` : "";
  return `${where}${what}${left}`;
}

/** git's own first line of explanation, minus its `hint:` advice. Display only. */
function explain(ran: Ran): string {
  const lines = `${ran.stderr}\n${ran.stdout}`
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("hint:"));
  return lines[0] ?? "";
}

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

function fromRunner(out: RebaseOutcome): Ran {
  if (out.status === "done") return { code: 0, stdout: "", stderr: "" };
  return { code: 1, stdout: "", stderr: out.message };
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readText(p: string): Promise<string | undefined> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return undefined;
  }
}

/** The first `max` bytes of a file as text, or undefined when unreadable. */
async function readHead(p: string, max: number): Promise<string | undefined> {
  try {
    const buf = await readFile(p);
    return buf.subarray(0, max).toString("utf8");
  } catch {
    return undefined;
  }
}
