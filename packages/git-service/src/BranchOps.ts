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

  /** `git branch -m <old> <neu>`. */
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
