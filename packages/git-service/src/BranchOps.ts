import type { GitProcess, GitRunOptions } from "./GitProcess";

export interface BranchOpResult {
  ok: boolean;
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
    return { ok: r.code === 0, stderr: r.stderr };
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
    return { ok: r.code === 0, stderr: r.stderr };
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
    return { ok: r.code === 0, stderr: r.stderr };
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
    const r = await this.proc.run(["branch", "-m", old, neu], {
      signal: opts?.signal,
    });
    return { ok: r.code === 0, stderr: r.stderr };
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
    const r = await this.proc.run(["branch", flag, name], {
      signal: opts?.signal,
    });
    return { ok: r.code === 0, stderr: r.stderr };
  }

  /** `git merge [--no-ff|--ff-only] <ref>` into the current branch. */
  async merge(ref: string, opts?: MergeOptions): Promise<BranchOpResult> {
    const args = ["merge"];
    if (opts?.noFf) {
      args.push("--no-ff");
    }
    if (opts?.ffOnly) {
      args.push("--ff-only");
    }
    args.push(ref);
    const r = await this.proc.run(args, { signal: opts?.signal });
    return { ok: r.code === 0, stderr: r.stderr };
  }

  /** `git rebase <upstream>` — rebase the current branch onto `upstream`. */
  async rebaseOnto(
    upstream: string,
    opts?: GitRunOptions,
  ): Promise<BranchOpResult> {
    const r = await this.proc.run(["rebase", upstream], {
      signal: opts?.signal,
    });
    return { ok: r.code === 0, stderr: r.stderr };
  }

  /** `git branch --set-upstream-to=<upstream> <branch>`. */
  async setUpstream(
    branch: string,
    upstream: string,
    opts?: GitRunOptions,
  ): Promise<BranchOpResult> {
    const r = await this.proc.run(
      ["branch", `--set-upstream-to=${upstream}`, branch],
      { signal: opts?.signal },
    );
    return { ok: r.code === 0, stderr: r.stderr };
  }

  /** `git push <remote> --delete <name>` — delete a branch on the remote. */
  async deleteRemoteBranch(
    remote: string,
    name: string,
    opts?: GitRunOptions,
  ): Promise<BranchOpResult> {
    const r = await this.proc.run(["push", remote, "--delete", name], {
      signal: opts?.signal,
    });
    return { ok: r.code === 0, stderr: r.stderr };
  }
}
