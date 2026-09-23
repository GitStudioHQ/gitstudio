import { lstat, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import type { GitProcess } from "./GitProcess";
import type { ConflictProvider } from "./ConflictProvider";
import type { OperationSource } from "./OperationProvider";
import { byRole, roleOfStage, stageOf } from "@gitstudio/engine/conflict/sides";
import type {
  ConflictFileView,
  ConflictShape,
  ConflictsSnapshot,
  OperationView,
  SideRole,
} from "@gitstudio/host-bridge/conflictsProtocol";
import type { VersionsSource } from "@gitstudio/host-bridge/protocol";

/**
 * Whole-file conflict actions and per-file facts, stated in ROLE terms
 * (PLAN §3.4 W4). One instance per repository (GitContext.conflictOps), shared
 * by the desktop main process and the VS Code host package, so the dashboard's
 * rows, badges and resolutions cannot drift between products.
 *
 * The rules, each paid for by a destroyed file somewhere:
 *
 * - `ls-files -u -z` decides which stages exist. A MISSING side is never
 *   inferred from a failed checkout: Merge Studio's "rm on any checkout error"
 *   deleted the working file whenever checkout failed for any reason at all.
 * - `-z` and an exact path comparison, never a C-quoted listing (four of six
 *   non-ASCII files were deleted by that once).
 * - git moves the bytes (`checkout --ours|--theirs -- p`), never a string
 *   round trip: a PNG came back 36,078 → 67,288 bytes of U+FFFD.
 * - Every write goes through ONE guard (a usable path, lexically inside the
 *   repository, and not reached through a symlinked parent), and every
 *   pathspec is literal. The desktop had two writers and each had half of the
 *   guards (memory: fix-both-siblings); both now come through here.
 */

/** The largest file (any stage, or the working copy) a text merge is offered for. */
export const CONFLICT_TEXT_CAP_BYTES = 512 * 1024;

export interface ConflictReadOpts {
  signal?: AbortSignal;
  /** The operation, when the caller already has it (saves a re-read). */
  op?: OperationView;
}

/** What git says about one unmerged path. */
export interface ConflictFileFacts {
  /** Repo-root-relative, exactly as `ls-files -z` reports it. */
  path: string;
  /** porcelain v2 XY in STAGE terms (X = stage 2's side, Y = stage 3's): "UU", "DU", "AA", "DD", … */
  xy: string;
  /** Which stages the index holds for the path. */
  stages: ReadonlyArray<1 | 2 | 3>;
  shape: ConflictShape;
  /** modify-delete / added-one-side: the ROLE with no version of the file. */
  missingRole?: SideRole;
  /** The XY badge in ROLE terms ("deleted in theirs (master)"); "" for both-modified. */
  badge: string;
  /** A common ancestor (stage 1) exists. */
  hasBase: boolean;
}

/**
 * The three texts of one conflicted file, ALREADY mapped to roles through
 * `op` — the one read both the desktop's ConflictModel and the extensions'
 * MergeInitPayload are built from.
 */
export interface MergeSides {
  op: OperationView;
  path: string;
  shape: ConflictShape;
  missingRole?: SideRole;
  hasBase: boolean;
  source: VersionsSource;
  /** Stage 1, or "" when there is no base. */
  base: string;
  /** Stage `op.yours.stage` — the LEFT pane. */
  yours: string;
  /** Stage `op.theirs.stage` — the RIGHT pane. */
  theirs: string;
}

export interface ReadSidesOptions extends ConflictReadOpts {
  /** Live working text, for the marker fallback when no stages exist. */
  workingText?: string;
}

export interface WriteResolutionOptions extends ConflictReadOpts {
  /**
   * How a refusal names the way through, in the host's own button words
   * ("accept one side instead" by default).
   */
  takeSideAdvice?: string;
}

/** Structurally a desktop CommitActionResult. */
export interface ConflictOpResult {
  ok: boolean;
  changed: boolean;
  message?: string;
  /** A refusal the user is allowed to hit (not an error report). */
  expected?: boolean;
}

type Stage = 1 | 2 | 3;
interface StageEntry {
  mode: string;
  sha: string;
}
type StageMap = Map<Stage, StageEntry>;

/** This episode's rows: every path seen unmerged, how each was resolved here. */
interface EpisodeMemory {
  episode?: string;
  order: string[];
  facts: Map<string, ConflictFileFacts>;
  choices: Map<string, SideRole | "merged">;
}

export class ConflictOps {
  private memory: EpisodeMemory = freshMemory(undefined);

  constructor(
    private readonly proc: GitProcess,
    /** Absolute repo (worktree) root. */
    private readonly root: string,
    private readonly conflict: ConflictProvider,
    private readonly operation: OperationSource,
  ) {}

  // ── Read ────────────────────────────────────────────────────────────────────

  /** Every unmerged path with its facts, in `ls-files -u` order. */
  async conflictFiles(opts?: ConflictReadOpts): Promise<ConflictFileFacts[]> {
    const op = opts?.op ?? (await this.operation.view({ signal: opts?.signal }));
    const listing = await this.stageListing(opts?.signal);
    if (!listing) return [];
    return this.factsFor(listing, op, undefined, opts?.signal);
  }

  /** One path's facts; undefined when it is not unmerged. */
  async fileFacts(path: string, opts?: ConflictReadOpts): Promise<ConflictFileFacts | undefined> {
    const listing = await this.stageListing(opts?.signal);
    if (!listing || !listing.has(path)) return undefined;
    const op = opts?.op ?? (await this.operation.view({ signal: opts?.signal }));
    return (await this.factsFor(listing, op, new Set([path]), opts?.signal))[0];
  }

  /**
   * The role-mapped texts for the merge editor: `yours` is stage
   * `op.yours.stage` whatever the operation, so a rebase's own commit is on
   * the left (decision D1). The marker fallback maps the same way — its
   * "ours" section is the HEAD side, i.e. stage 2's.
   */
  async readSides(path: string, opts?: ReadSidesOptions): Promise<MergeSides> {
    const op = opts?.op ?? (await this.operation.view({ signal: opts?.signal }));
    const [facts, v] = await Promise.all([
      this.fileFacts(path, { op, signal: opts?.signal }),
      this.conflict.getConflictVersions(path, {
        signal: opts?.signal,
        workingText: opts?.workingText,
      }),
    ]);
    const sides = byRole(op, v.ours, v.theirs);
    return {
      op,
      path,
      shape: facts?.shape ?? "text",
      ...(facts?.missingRole ? { missingRole: facts.missingRole } : {}),
      hasBase: facts ? facts.hasBase : v.hasBase,
      source: v.source,
      base: v.base,
      yours: sides.yours,
      theirs: sides.theirs,
    };
  }

  /**
   * The dashboard's git half: the operation, every unmerged row, plus rows
   * resolved during this episode (remembered per `op.episode`, with the
   * `choice` recorded by takeRole / noteChoice). A new episode — the next
   * rebase step, another operation — starts an empty list.
   */
  async snapshot(opts?: ConflictReadOpts): Promise<ConflictsSnapshot> {
    const op = opts?.op ?? (await this.operation.view({ signal: opts?.signal }));
    const files = await this.conflictFiles({ op, signal: opts?.signal });
    const mem = this.memoryFor(op.episode);
    const pending = new Set<string>();
    for (const f of files) {
      pending.add(f.path);
      if (!mem.order.includes(f.path)) mem.order.push(f.path);
      mem.facts.set(f.path, f);
      // Unmerged again (hold-to-undo, or a checkout -m elsewhere): no choice stands.
      mem.choices.delete(f.path);
    }
    const rows: ConflictFileView[] = [];
    for (const path of mem.order) {
      const f = mem.facts.get(path);
      const status = pending.has(path) ? "pending" : "resolved";
      const choice = status === "resolved" ? mem.choices.get(path) : undefined;
      rows.push({
        path,
        status,
        ...(choice ? { choice } : {}),
        ...(f?.badge ? { badge: f.badge } : {}),
        shape: f?.shape ?? "text",
        ...(f?.missingRole ? { missingRole: f.missingRole } : {}),
      });
    }
    return {
      repoName: basename(this.root),
      op,
      files: rows,
      total: rows.length,
      resolved: rows.filter((r) => r.status === "resolved").length,
    };
  }

  // ── Write ───────────────────────────────────────────────────────────────────

  /**
   * Resolve the whole file as `role`: its stage exists → checkout that stage +
   * `add`; its stage is ABSENT (known from ls-files -u) → `rm`. A both-deleted
   * path is refused with an explanation (use deleteFile).
   */
  async takeRole(path: string, role: SideRole, opts?: ConflictReadOpts): Promise<ConflictOpResult> {
    const op = opts?.op ?? (await this.operation.view({ signal: opts?.signal }));
    const res = await this.takeStage(path, stageOf(op, role), opts);
    if (res.ok) this.remember(op.episode, path, role);
    return res;
  }

  /**
   * Resolve the whole file as git's stage 2 or 3 — the stage-keyed half of
   * takeRole, kept for callers that still speak stages (the desktop's legacy
   * `conflict:takeSide`). ONE implementation for both, so neither can lose a
   * guard the other has.
   */
  async takeStage(path: string, stage: 2 | 3, opts?: { signal?: AbortSignal }): Promise<ConflictOpResult> {
    const guard = await this.guardPath(path);
    if (!guard.ok) return guard.result;
    const listing = await this.stageListing(opts?.signal);
    if (!listing) {
      return refuse(`Couldn't read the conflict state for ${path}. Nothing was changed.`);
    }
    const stages = listing.get(path);
    // "Not listed" is NOT "the side is missing". Answering it with `git rm`
    // made destruction the default outcome of not understanding the input.
    if (!stages) return refuse(`${path} is no longer conflicted — nothing was changed.`);
    if (!stages.has(2) && !stages.has(3)) {
      return refuse(`Both sides deleted ${path}. There is no side to take — delete the file to settle it.`);
    }
    if (!stages.has(stage)) {
      // That side's answer IS "delete it", and ls-files says so.
      const rm = await this.git(["rm", "-f", "-q", "--", path], opts?.signal);
      return rm.code === 0 ? done() : failed(rm.stderr, `Couldn't delete ${path}.`);
    }
    const co = await this.git(["checkout", stage === 2 ? "--ours" : "--theirs", "--", path], opts?.signal);
    if (co.code !== 0) {
      // A failed checkout says nothing about which side exists. The file stays.
      return failed(co.stderr, `Couldn't take that version of ${path}. Nothing was changed.`);
    }
    const add = await this.git(["add", "--", path], opts?.signal);
    return add.code === 0 ? done() : failed(add.stderr, `Couldn't stage ${path}.`);
  }

  /** Resolve a both-deleted (DD) path by deleting it (`rm --cached -- p`). */
  async deleteFile(path: string, opts?: ConflictReadOpts): Promise<ConflictOpResult> {
    const guard = await this.guardPath(path);
    if (!guard.ok) return guard.result;
    const listing = await this.stageListing(opts?.signal);
    if (!listing) return refuse(`Couldn't read the conflict state for ${path}. Nothing was changed.`);
    const stages = listing.get(path);
    if (!stages) return refuse(`${path} is no longer conflicted — nothing was changed.`);
    if (stages.has(2) || stages.has(3)) {
      return refuse(`${path} still exists on one side. Accept Yours or Accept Theirs instead.`);
    }
    // `--cached`: git already removed the file from the working tree; a file
    // somebody created there since is theirs, and stays (untracked).
    const rm = await this.git(["rm", "--cached", "-q", "--", path], opts?.signal);
    if (rm.code !== 0) return failed(rm.stderr, `Couldn't delete ${path}.`);
    const op = opts?.op ?? (await this.operation.view({ signal: opts?.signal }).catch(() => undefined));
    this.remember(op?.episode, path, undefined);
    return done();
  }

  /**
   * Hold-to-undo: re-create the conflict of a path resolved during this
   * operation. A text conflict comes back through `checkout -m` (git rewrites
   * the markers as ours/theirs — products.out); a conflict with a missing side
   * — which `checkout -m` refuses ("does not have all necessary versions") —
   * through `update-index --unresolve` plus the surviving side put back in the
   * working tree, exactly as git first left it.
   *
   * Refused for a path that is still conflicted (it would discard the edits in
   * progress) and for one git holds no resolve-undo record of: `checkout -m`
   * on such a path exits 0 and quietly overwrites the working copy with the
   * index.
   */
  async restore(path: string, opts?: ConflictReadOpts): Promise<ConflictOpResult> {
    const guard = await this.guardPath(path);
    if (!guard.ok) return guard.result;
    const listing = await this.stageListing(opts?.signal);
    if (!listing) return refuse(`Couldn't read the conflict state for ${path}. Nothing was changed.`);
    if (listing.has(path)) return refuse(`${path} is still conflicted — there is nothing to undo.`);
    const undo = await this.git(["ls-files", "--resolve-undo", "-z"], opts?.signal, false);
    const stages = undo.code === 0 ? parseUnmergedStages(undo.stdout).get(path) : undefined;
    if (!stages) {
      return refuse(`There is no earlier conflict to bring back for ${path}.`);
    }
    if (stages.has(2) && stages.has(3)) {
      const r = await this.git(["checkout", "-m", "--", path], opts?.signal);
      if (r.code !== 0) return failed(r.stderr, `Couldn't bring the conflict in ${path} back.`);
    } else {
      // update-index takes a path, not a pathspec.
      const r = await this.git(["update-index", "--unresolve", "--", path], opts?.signal, false);
      if (r.code !== 0) return failed(r.stderr, `Couldn't bring the conflict in ${path} back.`);
      const kept: 2 | 3 | undefined = stages.has(2) ? 2 : stages.has(3) ? 3 : undefined;
      if (kept) {
        const co = await this.git(["checkout", kept === 2 ? "--ours" : "--theirs", "--", path], opts?.signal);
        if (co.code !== 0) return failed(co.stderr, `The conflict is back, but ${path} couldn't be restored on disk.`);
      }
    }
    this.memory.choices.delete(path);
    return done();
  }

  /**
   * Save a hand-merged result and stage it — the merge editor's Apply (the
   * desktop's `conflict:resolve`). Text only: a symlink would be written
   * THROUGH (overwriting its target, maybe outside the repository) and a
   * non-UTF-8 file would come back as U+FFFD; both are refused with the way
   * through (take a side). A both-deleted path and a path no longer
   * conflicted are refused on the POSITIVE signal only — an unreadable
   * listing must not take away the one way to commit a hand merge.
   */
  async writeResolution(path: string, content: string, opts?: WriteResolutionOptions): Promise<ConflictOpResult> {
    const guard = await this.guardPath(path);
    if (!guard.ok) return guard.result;
    // Named in the host's own button words, so the advice points at a control
    // the reader can actually see from where they are.
    const way = opts?.takeSideAdvice ?? "accept one side instead";
    const safe = await textWriteSafe(guard.abs, (what) =>
      what === "symlink"
        ? `${path} is a symbolic link. Saving text here would overwrite whatever it points at, not the link — ${way}.`
        : `${path} isn't UTF-8 text. Saving it as text would rewrite the bytes it can't represent — ${way}.`,
    );
    if (!safe.ok) return refuse(safe.why);
    const listing = await this.stageListing(opts?.signal);
    if (listing) {
      const stages = listing.get(path);
      if (!stages) {
        return refuse(`${path} is no longer conflicted — nothing was written, so a resolution made elsewhere stays as it is.`);
      }
      if (!stages.has(2) && !stages.has(3)) {
        return refuse(`Both sides deleted ${path}. There is nothing to merge — delete the file to settle it.`);
      }
    }
    try {
      await writeFile(guard.abs, content, "utf8");
    } catch (err) {
      return { ok: false, changed: false, message: err instanceof Error ? err.message : String(err) };
    }
    const add = await this.git(["add", "--", path], opts?.signal);
    if (add.code !== 0) return failed(add.stderr, `Saved ${path}, but couldn't stage it.`);
    const op = opts?.op ?? (await this.operation.view({ signal: opts?.signal }).catch(() => undefined));
    this.remember(op?.episode, path, "merged");
    return done();
  }

  /**
   * Record how a path was resolved outside takeRole (the merge editor's Apply
   * = "merged"), for the snapshot's row pills.
   */
  noteChoice(path: string, choice: SideRole | "merged"): void {
    this.remember(this.memory.episode, path, choice);
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  /** `ls-files -u -z` as path → stages; undefined when git could not answer. */
  private async stageListing(signal?: AbortSignal): Promise<Map<string, StageMap> | undefined> {
    const r = await this.proc.run(["ls-files", "-u", "-z"], { signal });
    return r.code === 0 ? parseUnmergedStages(r.stdout) : undefined;
  }

  private async factsFor(
    listing: Map<string, StageMap>,
    op: OperationView,
    only: Set<string> | undefined,
    signal?: AbortSignal,
  ): Promise<ConflictFileFacts[]> {
    const paths = [...listing.keys()].filter((p) => !only || only.has(p));
    // Sizes of every blob a text merge might read, in one call.
    const shas = new Set<string>();
    for (const p of paths) {
      const st = listing.get(p)!;
      if (textCapable(st)) for (const e of st.values()) shas.add(e.sha);
    }
    const sizes = await this.blobSizes([...shas], signal);
    const out: ConflictFileFacts[] = [];
    for (const path of paths) {
      const stages = listing.get(path)!;
      const present = new Set(stages.keys());
      let { shape, missing } = shapeOfStages(present);
      if (textCapable(stages)) {
        if (await this.tooLarge(path, stages, sizes)) shape = "too-large";
        else if (await this.isBinary(stages, signal)) shape = "binary";
      }
      const xy = xyFromStages(present);
      out.push({
        path,
        xy,
        stages: [...present].sort() as Array<1 | 2 | 3>,
        shape,
        ...(missing ? { missingRole: roleOfStage(op, missing) } : {}),
        badge: badgeFor(xy, op),
        hasBase: present.has(1),
      });
    }
    return out;
  }

  private async blobSizes(shas: string[], signal?: AbortSignal): Promise<Map<string, number>> {
    const sizes = new Map<string, number>();
    if (shas.length === 0) return sizes;
    const r = await this.proc.run(["cat-file", "--batch-check=%(objectname) %(objectsize)"], {
      signal,
      input: shas.join("\n") + "\n",
    });
    if (r.code !== 0) return sizes;
    for (const line of r.stdout.split("\n")) {
      const m = /^([0-9a-f]+) (\d+)$/.exec(line.trim());
      if (m) sizes.set(m[1], Number(m[2]));
    }
    return sizes;
  }

  /** Any side, or the working copy, past the text cap. */
  private async tooLarge(path: string, stages: StageMap, sizes: Map<string, number>): Promise<boolean> {
    for (const e of stages.values()) {
      if ((sizes.get(e.sha) ?? 0) > CONFLICT_TEXT_CAP_BYTES) return true;
    }
    const st = await stat(resolve(this.root, path)).catch(() => undefined);
    return !!st && st.isFile() && st.size > CONFLICT_TEXT_CAP_BYTES;
  }

  /**
   * Binary by git's own classifier: `diff --numstat` between two different
   * sides prints "-\t-" when either is binary. A symlink or a submodule is
   * "take a side only" too — there is no line merge of a link target.
   */
  private async isBinary(stages: StageMap, signal?: AbortSignal): Promise<boolean> {
    for (const e of stages.values()) {
      if (e.mode === "120000" || e.mode === "160000") return true;
    }
    const order: Stage[] = [2, 3, 1];
    const shas = order.map((s) => stages.get(s)?.sha).filter((x): x is string => !!x);
    const distinct = [...new Set(shas)];
    if (distinct.length >= 2) {
      const r = await this.proc.run(["diff", "--numstat", distinct[0], distinct[1]], { signal });
      if (r.code === 0 && r.stdout.trim()) return /^-\t-\t/m.test(r.stdout);
    }
    // One distinct blob (or numstat said nothing): look for a NUL in its first
    // 8000 bytes, which is git's own test (buffer_is_binary).
    if (distinct.length === 0) return false;
    const r = await this.proc.run(["cat-file", "blob", distinct[0]], { signal });
    return r.code === 0 && r.stdout.slice(0, 8000).includes("\0");
  }

  /**
   * The one guard every write passes: a usable path, lexically inside the
   * repository, and not reached through a symlinked directory that leads
   * outside it (a purely lexical check cannot see `dir/x` when `dir` is a
   * link). Both sides are realpath'd — on macOS the repo itself is usually
   * under a symlinked /tmp.
   */
  private async guardPath(
    rel: string,
  ): Promise<{ ok: true; abs: string } | { ok: false; result: ConflictOpResult }> {
    if (typeof rel !== "string" || rel.length === 0 || rel.includes("\0")) {
      return { ok: false, result: { ok: false, changed: false, message: "That isn't a usable file path." } };
    }
    const base = resolve(this.root);
    const abs = resolve(base, rel);
    if (abs === base || !abs.startsWith(base + sep)) {
      return { ok: false, result: { ok: false, changed: false, message: "That path is outside the repository." } };
    }
    const realRoot = await realpath(base).catch(() => base);
    // The nearest directory that exists: a side that deleted a whole folder
    // leaves the file's parent missing, and taking the other side recreates it.
    let dir = dirname(abs);
    let realDir: string | undefined;
    while (dir.length >= base.length) {
      realDir = await realpath(dir).catch(() => undefined);
      if (realDir) break;
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    if (!realDir || (realDir !== realRoot && !realDir.startsWith(realRoot + sep))) {
      return {
        ok: false,
        result: refuse(`${rel} resolves outside the repository — nothing was changed.`),
      };
    }
    return { ok: true, abs };
  }

  /**
   * Run a write with LITERAL pathspecs: a file named `[ab].txt` must not also
   * check out `a.txt` and `b.txt`. (`update-index` takes paths, not pathspecs.)
   */
  private git(args: string[], signal?: AbortSignal, literal = true): Promise<{ code: number; stdout: string; stderr: string }> {
    return this.proc.run(literal ? ["--literal-pathspecs", ...args] : args, { signal });
  }

  private memoryFor(episode: string): EpisodeMemory {
    if (this.memory.episode === undefined && this.memory.order.length > 0) {
      // Choices noted before the first snapshot belong to the current stop.
      this.memory.episode = episode;
    }
    if (this.memory.episode !== episode) this.memory = freshMemory(episode);
    return this.memory;
  }

  private remember(episode: string | undefined, path: string, choice: SideRole | "merged" | undefined): void {
    if (episode !== undefined && this.memory.episode !== undefined && this.memory.episode !== episode) {
      this.memory = freshMemory(episode);
    }
    if (this.memory.episode === undefined && episode !== undefined) this.memory.episode = episode;
    if (!this.memory.order.includes(path)) this.memory.order.push(path);
    if (choice) this.memory.choices.set(path, choice);
    else this.memory.choices.delete(path);
  }
}

// ── Pure helpers (exported for the hosts' tests) ─────────────────────────────

function freshMemory(episode: string | undefined): EpisodeMemory {
  return { episode, order: [], facts: new Map(), choices: new Map() };
}

/** `ls-files -u -z` (or `--resolve-undo -z`) → path → stage → {mode, sha}, in listing order. */
export function parseUnmergedStages(out: string): Map<string, StageMap> {
  const map = new Map<string, StageMap>();
  for (const rec of out.split("\0")) {
    // `[\s\S]` for the path: with -z a name containing a newline arrives raw.
    const m = /^(\d{6}) ([0-9a-f]+) ([123])\t([\s\S]*)$/.exec(rec);
    if (!m) continue;
    const path = m[4];
    let st = map.get(path);
    if (!st) {
      st = new Map();
      map.set(path, st);
    }
    st.set(Number(m[3]) as Stage, { mode: m[1], sha: m[2] });
  }
  return map;
}

/**
 * git's unmerged XY code from the stages present — the same table
 * `wt-status.c` uses for `status --porcelain=v2`: X describes stage 2's side
 * (ours), Y stage 3's (theirs).
 */
export function xyFromStages(stages: Iterable<number>): string {
  const s = new Set(stages);
  const has1 = s.has(1);
  const has2 = s.has(2);
  const has3 = s.has(3);
  if (has1 && has2 && has3) return "UU";
  if (!has1 && has2 && has3) return "AA";
  if (has1 && !has2 && !has3) return "DD";
  if (has1 && has2) return "UD"; // deleted by them
  if (has1 && has3) return "DU"; // deleted by us
  if (has2) return "AU"; // added by us
  if (has3) return "UA"; // added by them
  return "UU";
}

/** The shape the stages alone decide, and which stage is missing when one is. */
export function shapeOfStages(stages: ReadonlySet<number>): { shape: ConflictShape; missing?: 2 | 3 } {
  const has1 = stages.has(1);
  const has2 = stages.has(2);
  const has3 = stages.has(3);
  if (has2 && has3) return { shape: has1 ? "text" : "added-both" };
  if (!has2 && !has3) return { shape: "both-deleted" };
  const missing: 2 | 3 = has2 ? 3 : 2;
  return { shape: has1 ? "modify-delete" : "added-one-side", missing };
}

/** A line-by-line merge is possible in principle (both sides have the file). */
function textCapable(stages: StageMap): boolean {
  return stages.has(2) && stages.has(3);
}

/**
 * The XY badge in ROLE terms. X is stage 2's side, Y stage 3's; which role
 * each is comes from the operation, so a rebase's DU reads "deleted in theirs
 * (master)" and a merge's "deleted in yours (master)".
 */
export function badgeFor(xy: string, op: Pick<OperationView, "yours" | "theirs" | "kind">): string {
  const side = (stage: 2 | 3): string => {
    const role = roleOfStage(op, stage);
    const name = role === "yours" ? op.yours.name : op.theirs.name;
    return op.kind === "none" || !name ? role : `${role} (${name})`;
  };
  switch (xy) {
    case "AA":
      return "added in both";
    case "DD":
      return "deleted in both";
    case "UD":
      return `deleted in ${side(3)}`;
    case "DU":
      return `deleted in ${side(2)}`;
    case "AU":
      return `added in ${side(2)}`;
    case "UA":
      return `added in ${side(3)}`;
    default:
      return "";
  }
}

/**
 * The two kinds of file a text write-back destroys, asked once: a symlink
 * (`writeFile` FOLLOWS it and overwrites the target) and a non-UTF-8 file
 * (the content has been through a JavaScript string, so every byte that is not
 * valid UTF-8 came back as U+FFFD). Shared by every text writer in both hosts.
 */
export async function textWriteSafe(
  abs: string,
  advice: (what: "symlink" | "binary") => string,
): Promise<{ ok: true } | { ok: false; why: string }> {
  const st = await lstat(abs).catch(() => undefined);
  if (st?.isSymbolicLink()) return { ok: false, why: advice("symlink") };
  if (st?.isFile()) {
    const bytes = await readFile(abs).catch(() => undefined);
    if (bytes && Buffer.compare(Buffer.from(bytes.toString("utf8"), "utf8"), bytes) !== 0) {
      return { ok: false, why: advice("binary") };
    }
  }
  return { ok: true };
}

function done(): ConflictOpResult {
  return { ok: true, changed: true };
}

function refuse(message: string): ConflictOpResult {
  return { ok: false, changed: false, expected: true, message };
}

function failed(stderr: string, fallback: string): ConflictOpResult {
  const line = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("hint:"));
  return { ok: false, changed: false, message: line || fallback };
}
