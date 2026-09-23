import type { GitProcess, GitRunOptions } from "./GitProcess";

export interface BranchOpResult {
  ok: boolean;
  /**
   * git's stdout.
   *
   * Not decoration: a conflicted `git merge` writes its ENTIRE report there —
   * "CONFLICT (content): Merge conflict in f.txt / Automatic merge failed; fix
   * conflicts and then commit the result." — and leaves stderr empty. Dropping
   * it meant the app answered a conflicted merge with "The operation failed."
   * while the working tree was sitting mid-merge, which describes neither what
   * happened nor what to do about it. Verified against real git.
   */
  stdout?: string;
  /**
   * git's exit code, kept alongside `ok` because the two are not the same
   * question. `ok` says "did it do the thing"; the code says *how* it did not,
   * and git distinguishes "I PAUSED for you" (1) from "I REFUSED" (128, or 2 for
   * a merge onto a dirty tree). Callers that only report a failure ignore this;
   * merge/rebase need it to tell a conflict apart from a refusal without reading
   * git's localised prose. See pausedForUser in the extension.
   */
  code: number;
  stderr: string;
}

export interface CheckoutOptions extends GitRunOptions {
  /** `--detach` — check out the commit without moving onto a branch. */
  detach?: boolean;
}

export interface DeleteBranchOptions extends GitRunOptions {
  /** `-D` instead of `-d` — delete even if not fully merged. */
  force?: boolean;
}

export interface MergeOptions extends GitRunOptions {
  /** `--no-ff` — always create a merge commit. */
  noFf?: boolean;
  /** `--ff-only` — fast-forward or fail. */
  ffOnly?: boolean;
}

/**
 * The name a branch command takes (`git branch -d/-m`, `--set-upstream-to`'s
 * branch, `branch.<name>.*` config) for the local branch `fullName`: the part
 * under refs/heads/. Undefined for anything else.
 *
 * Every branch action derives its name here, from the full name, and never
 * from %(refname:short): beside a tag of the same name that is "heads/x",
 * which `git branch` looks up as a branch literally called "heads/x" and does
 * not find. The name under refs/heads/ is exact for these commands, which only
 * ever look in that one namespace.
 */
export function branchNameOf(fullName: string): string | undefined {
  if (!fullName.startsWith("refs/heads/")) return undefined;
  const name = fullName.slice("refs/heads/".length);
  return name || undefined;
}

/**
 * `refs/remotes/origin/feature/x` → `{ remote: "origin", branch: "feature/x" }`
 * — the pair `git push <remote> --delete <branch>` takes. The first segment is
 * the remote (a branch may contain slashes). Undefined for anything else.
 */
export function remoteBranchOf(fullName: string): { remote: string; branch: string } | undefined {
  if (!fullName.startsWith("refs/remotes/")) return undefined;
  const rest = fullName.slice("refs/remotes/".length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return undefined;
  return { remote: rest.slice(0, slash), branch: rest.slice(slash + 1) };
}

/**
 * Branch-level operations, distinct from the read-only RefProvider listing:
 * create/checkout/rename/delete/merge/rebase/upstream. Pure git CLI — never
 * imports `vscode`.
 */
export class BranchOps {
  constructor(private proc: GitProcess) {}

  /** `git branch <name> [<startPoint>]`. */
  async create(
    name: string,
    startPoint?: string,
    opts?: GitRunOptions,
  ): Promise<BranchOpResult> {
    const args = ["branch", name];
    if (startPoint) {
      args.push(startPoint);
    }
    const r = await this.proc.run(args, { signal: opts?.signal });
    return { ok: r.code === 0, code: r.code, stderr: r.stderr, stdout: r.stdout };
  }

  /** `git checkout [--detach] <ref>`. */
  async checkout(
    ref: string,
    opts?: CheckoutOptions,
  ): Promise<BranchOpResult> {
    const args = ["checkout"];
    if (opts?.detach) {
      args.push("--detach");
    }
    args.push(ref);
    const r = await this.proc.run(args, { signal: opts?.signal });
    return { ok: r.code === 0, code: r.code, stderr: r.stderr, stdout: r.stdout };
  }

  /**
   * `git checkout -b <name> [<startPoint>]` — create and switch to a new branch.
   * When `startPoint` is a remote-tracking ref this sets up tracking, the path
   * used to "check out a remote branch locally".
   */
  async checkoutNew(
    name: string,
    startPoint?: string,
    opts?: GitRunOptions,
  ): Promise<BranchOpResult> {
    const args = ["checkout", "-b", name];
    if (startPoint) {
      args.push(startPoint);
    }
    const r = await this.proc.run(args, { signal: opts?.signal });
    return { ok: r.code === 0, code: r.code, stderr: r.stderr, stdout: r.stdout };
  }

  /**
   * `git branch -m <old> <neu>`.
   *
   * NOTE: git deliberately carries the tracking config across a rename — the
   * branch on the server did not get renamed, so `branch.<neu>.merge` still
   * names `refs/heads/<old>`. That is correct as far as git is concerned but is
   * almost never what someone means right after renaming, so callers should ask;
   * `upstreamOf` is how they detect it. See renameBranch in the extension.
   */
  async rename(
    old: string,
    neu: string,
    opts?: GitRunOptions,
  ): Promise<BranchOpResult> {
    // `--`: the old name is a NAME, even one that starts with "-" (update-ref
    // makes such a branch, porcelain never would, and `branch -m` renames it
    // "away"). Callers hand the name under refs/heads/ — branchNameOf — and
    // never %(refname:short), which is "heads/x" beside a tag "x" and names
    // no branch at all here ("fatal: no branch named 'heads/x'").
    const r = await this.proc.run(["branch", "-m", "--", old, neu], {
      signal: opts?.signal,
    });
    return { ok: r.code === 0, code: r.code, stderr: r.stderr, stdout: r.stdout };
  }

  /**
   * The configured upstream of `branch`, split into its remote and the branch
   * name ON that remote — which is NOT always the local name.
   *
   * Read from config rather than `@{upstream}` because config survives the
   * remote-tracking ref going missing (a deleted or not-yet-pushed remote
   * branch), and it is the only way to see the mismatch a rename leaves behind.
   */
  async upstreamOf(
    branch: string,
    opts?: GitRunOptions,
  ): Promise<{ remote: string; branch: string } | null> {
    const [remoteR, mergeR] = await Promise.all([
      this.proc.run(["config", "--get", `branch.${branch}.remote`], {
        signal: opts?.signal,
      }),
      this.proc.run(["config", "--get", `branch.${branch}.merge`], {
        signal: opts?.signal,
      }),
    ]);
    const remote = remoteR.stdout.trim();
    const merge = mergeR.stdout.trim();
    if (!remote || !merge) {
      return null;
    }
    // `merge` is a full ref on the remote: refs/heads/<name>.
    return {
      remote,
      branch: merge.startsWith("refs/heads/")
        ? merge.slice("refs/heads/".length)
        : merge,
    };
  }

  /** `git branch -d|-D <name>`. */
  async delete(
    name: string,
    opts?: DeleteBranchOptions,
  ): Promise<BranchOpResult> {
    const flag = opts?.force ? "-D" : "-d";
    // The name under refs/heads/ (branchNameOf), after `--` — see rename.
    const r = await this.proc.run(["branch", flag, "--", name], {
      signal: opts?.signal,
    });
    return { ok: r.code === 0, code: r.code, stderr: r.stderr, stdout: r.stdout };
  }

  /**
   * `git merge [--no-ff|--ff-only] <ref>` into the current branch.
   *
   * Hand it a FULL name (refs/heads/…, refs/remotes/…). A short one is
   * ambiguous the moment a tag shares it: plain "release" merges the TAG
   * ("warning: refname 'release' is ambiguous"), and git's disambiguated
   * "heads/release" merges the branch but records "Merge branch
   * 'heads/release'". The full name merges the right ref — and git would
   * record THAT verbatim too ("Merge branch 'refs/heads/release'"), because a
   * merge message names the ref exactly as it was typed. So for a full name
   * the message is made the way git makes its own (fmt-merge-msg, which
   * honours merge.log and merge.suppressDest) from the name under the
   * namespace, and handed over with `--no-log` so a merge.log shortlog is
   * written once, by fmt-merge-msg, under the right name.
   */
  async merge(ref: string, opts?: MergeOptions): Promise<BranchOpResult> {
    const args = await this.mergeArgs(ref, opts);
    const r = await this.proc.run(args, { signal: opts?.signal });
    return { ok: r.code === 0, code: r.code, stderr: r.stderr, stdout: r.stdout };
  }

  /**
   * The argv `merge` runs, message included — for a caller that runs it
   * through a door of its own (the desktop's changes-in-the-way door) and
   * must still record the merge under the name a person would use.
   */
  async mergeArgs(ref: string, opts?: MergeOptions): Promise<string[]> {
    const args = ["merge"];
    if (opts?.noFf) {
      args.push("--no-ff");
    }
    if (opts?.ffOnly) {
      args.push("--ff-only");
    }
    const message = await this.mergeMessage(ref, opts?.signal);
    if (message) {
      args.push("--no-log", "-m", message);
    }
    args.push(ref);
    return args;
  }

  /**
   * git's own merge message for merging the full name `ref`, named the way a
   * person would name it ("Merge branch 'release'", "Merge remote-tracking
   * branch 'origin/release'", "… into feature" off the default branch). Undefined for anything
   * else — a short name, a tag, a sha — which git names well enough itself,
   * and when git cannot say (the merge then reports the real error).
   */
  private async mergeMessage(ref: string, signal?: AbortSignal): Promise<string | undefined> {
    const kind = ref.startsWith("refs/heads/")
      ? { prefix: "refs/heads/", what: "branch" }
      : ref.startsWith("refs/remotes/")
        ? { prefix: "refs/remotes/", what: "remote-tracking branch" }
        : undefined;
    if (!kind) return undefined;
    const name = ref.slice(kind.prefix.length);
    if (!name) return undefined;
    const tip = await this.proc.run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { signal });
    const sha = tip.stdout.trim();
    if (tip.code !== 0 || !sha) return undefined;
    // The line `git merge` itself feeds fmt-merge-msg (builtin/merge.c,
    // merge_name): "<sha>\t\t<what> '<name>' of .".
    const msg = await this.proc.run(["fmt-merge-msg"], {
      signal,
      input: `${sha}\t\t${kind.what} '${name}' of .\n`,
    });
    const text = msg.stdout.replace(/\s+$/, "");
    return msg.code === 0 && text ? text : undefined;
  }

  /** `git rebase <upstream>` — rebase the current branch onto `upstream`. */
  async rebaseOnto(
    upstream: string,
    opts?: GitRunOptions,
  ): Promise<BranchOpResult> {
    const r = await this.proc.run(["rebase", upstream], {
      signal: opts?.signal,
    });
    return { ok: r.code === 0, code: r.code, stderr: r.stderr, stdout: r.stdout };
  }

  /** `git branch --set-upstream-to=<upstream> <branch>`. */
  async setUpstream(
    branch: string,
    upstream: string,
    opts?: GitRunOptions,
  ): Promise<BranchOpResult> {
    // `upstream` may be a full refs/remotes/ name (git maps it to its remote);
    // `branch` is the name under refs/heads/, after `--` — see rename.
    const r = await this.proc.run(
      ["branch", `--set-upstream-to=${upstream}`, "--", branch],
      { signal: opts?.signal },
    );
    return { ok: r.code === 0, code: r.code, stderr: r.stderr, stdout: r.stdout };
  }

  /**
   * `git push <remote> --delete refs/heads/<name>` — delete a branch on the
   * remote. Qualified: a bare name is matched against the remote's tags too,
   * and beside a tag of that name git refuses ("dst refspec release matches
   * more than one") — or, with only the tag there, deletes the TAG.
   */
  async deleteRemoteBranch(
    remote: string,
    name: string,
    opts?: GitRunOptions,
  ): Promise<BranchOpResult> {
    const r = await this.proc.run(["push", remote, "--delete", `refs/heads/${name}`], {
      signal: opts?.signal,
    });
    return { ok: r.code === 0, code: r.code, stderr: r.stderr, stdout: r.stdout };
  }
}
