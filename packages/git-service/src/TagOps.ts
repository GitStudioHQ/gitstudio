import type { GitProcess, GitRunOptions } from "./GitProcess";

export interface TagOpResult {
  ok: boolean;
  stderr: string;
}

export interface CreateTagOptions extends GitRunOptions {
  /** The commit/ref to tag (defaults to HEAD). */
  ref?: string;
  /** Tag message — implies an annotated tag. */
  message?: string;
  /** Force an annotated tag (`-a`) even without a message. */
  annotated?: boolean;
}

/**
 * `git tag` operations: create (lightweight or annotated), delete, push.
 * The message is fed via `-F -` (stdin) so multi-line / shell-hostile text
 * survives. Pure git CLI — never imports `vscode`.
 */
export class TagOps {
  constructor(private proc: GitProcess) {}

  async create(
    name: string,
    opts?: CreateTagOptions,
  ): Promise<TagOpResult> {
    const args = ["tag"];
    const annotated = opts?.annotated || opts?.message !== undefined;
    if (annotated) {
      // Feed the message (possibly empty) via stdin so git never opens an
      // editor and multi-line / shell-hostile text survives intact.
      args.push("-a", "-F", "-");
    }
    args.push(name);
    if (opts?.ref) {
      args.push(opts.ref);
    }
    const r = await this.proc.run(args, {
      signal: opts?.signal,
      input: annotated ? (opts?.message ?? "") : undefined,
    });
    return { ok: r.code === 0, stderr: r.stderr };
  }

  /** `git tag -d <name>`. */
  async delete(name: string, opts?: GitRunOptions): Promise<TagOpResult> {
    const r = await this.proc.run(["tag", "-d", name], {
      signal: opts?.signal,
    });
    return { ok: r.code === 0, stderr: r.stderr };
  }

  /** `git push <remote> <name>` — or `--tags` to push all tags. */
  async push(
    remote: string,
    name?: string,
    opts?: GitRunOptions,
  ): Promise<TagOpResult> {
    const args = ["push", remote];
    args.push(name ? `refs/tags/${name}` : "--tags");
    const r = await this.proc.run(args, { signal: opts?.signal });
    return { ok: r.code === 0, stderr: r.stderr };
  }
}
