import type { GitProcess } from "./GitProcess";

export interface StagingOptions {
  signal?: AbortSignal;
}

export interface CommitOptions {
  signal?: AbortSignal;
  /** Amend the previous commit (`git commit --amend`). */
  amend?: boolean;
  /** Add a `Signed-off-by` trailer (`--signoff`). */
  signoff?: boolean;
  /** Override author, e.g. `"Jane <jane@example.com>"` (`--author=`). */
  author?: string;
  /** Skip pre-commit / commit-msg hooks (`--no-verify`). Off by default so
   *  project hooks run naturally. */
  noVerify?: boolean;
}

export interface CommitResult {
  ok: boolean;
  stderr: string;
}

/**
 * Host-agnostic git staging plumbing: stage/unstage/discard whole files, stage
 * arbitrary reconstructed content (the line/hunk-staging path), read index/HEAD
 * versions, and commit. Pure git CLI — never imports `vscode`, so it works
 * headless (tests), in the VS Code extension, and in the future desktop app.
 *
 * The content path is what makes precise line staging possible: the engine
 * reconstructs the exact text to stage (originalIndex + selected changes), we
 * write it as a blob with `git hash-object -w`, and point the index entry at it
 * with `git update-index --cacheinfo` — leaving the working tree untouched.
 */
export class StagingProvider {
  constructor(private proc: GitProcess) {}

  /** `git add -- <rel>` — stage the whole working-tree version of a file. */
  async stageFile(rel: string, opts?: StagingOptions): Promise<CommitResult> {
    const r = await this.proc.run(["add", "--", rel], { signal: opts?.signal });
    return { ok: r.code === 0, stderr: r.stderr };
  }

  /**
   * Unstage a file. `git reset -q HEAD -- <rel>` on a repo with commits; on an
   * unborn branch (no HEAD yet) `reset` fails, so fall back to
   * `git rm --cached --force` to remove the entry from the index.
   */
  async unstageFile(rel: string, opts?: StagingOptions): Promise<CommitResult> {
    const reset = await this.proc.run(["reset", "-q", "HEAD", "--", rel], {
      signal: opts?.signal,
    });
    if (reset.code === 0) {
      return { ok: true, stderr: reset.stderr };
    }
    // No HEAD (initial commit) — drop the staged entry from the index instead.
    const rm = await this.proc.run(
      ["rm", "--cached", "--force", "--quiet", "--", rel],
      { signal: opts?.signal },
    );
    return { ok: rm.code === 0, stderr: rm.stderr || reset.stderr };
  }

  /** `git checkout -- <rel>` — discard working-tree changes for a file. */
  async discardChanges(
    rel: string,
    opts?: StagingOptions,
  ): Promise<CommitResult> {
    const r = await this.proc.run(["checkout", "--", rel], {
      signal: opts?.signal,
    });
    return { ok: r.code === 0, stderr: r.stderr };
  }

  /**
   * Stage arbitrary reconstructed `content` for `rel` WITHOUT touching the
   * working tree — the core of line/hunk staging.
   *
   * 1. `git hash-object -w --stdin` writes `content` as a loose blob, returns
   *    its sha.
   * 2. Read the file's existing index mode (`git ls-files -s`), defaulting to
   *    100644 for a path not yet tracked.
   * 3. `git update-index --add --cacheinfo <mode>,<sha>,<rel>` repoints the
   *    index entry at the new blob.
   */
  async stageContent(
    rel: string,
    content: string,
    opts?: StagingOptions,
  ): Promise<CommitResult> {
    const signal = opts?.signal;
    const hashed = await this.proc.run(["hash-object", "-w", "--stdin"], {
      signal,
      input: content,
    });
    if (hashed.code !== 0) {
      return { ok: false, stderr: hashed.stderr };
    }
    const blobSha = hashed.stdout.trim();

    const mode = await this.indexMode(rel, signal);
    const updated = await this.proc.run(
      ["update-index", "--add", "--cacheinfo", `${mode},${blobSha},${rel}`],
      { signal },
    );
    return { ok: updated.code === 0, stderr: updated.stderr };
  }

  /**
   * The file mode currently recorded for `rel` in the index (e.g. "100644" or
   * "100755"), or "100644" when the path is not yet tracked. Parsed from
   * `git ls-files -s -- <rel>`, whose first field is the mode.
   */
  private async indexMode(rel: string, signal?: AbortSignal): Promise<string> {
    const r = await this.proc.run(["ls-files", "-s", "--", rel], { signal });
    if (r.code === 0) {
      const match = /^(\d{6})\s/.exec(r.stdout);
      if (match) {
        return match[1];
      }
    }
    return "100644";
  }

  /** The staged (index) version of a file via `git show :<rel>`, or "". */
  async indexContent(rel: string, opts?: StagingOptions): Promise<string> {
    const r = await this.proc.run(["show", `:${rel}`], { signal: opts?.signal });
    return r.code === 0 ? r.stdout : "";
  }

  /** The committed (HEAD) version of a file via `git show HEAD:<rel>`, or "". */
  async headContent(rel: string, opts?: StagingOptions): Promise<string> {
    const r = await this.proc.run(["show", `HEAD:${rel}`], {
      signal: opts?.signal,
    });
    return r.code === 0 ? r.stdout : "";
  }

  /**
   * Create a commit. The message is fed via `-F -` (stdin) so multi-line
   * summaries + bodies and shell-hostile characters survive exactly. Returns the
   * exit status + stderr (so the caller can surface a failing hook). When
   * `amend` and an empty message is given, git reuses the previous message
   * (`--amend` with no `-F`).
   */
  async commit(message: string, opts?: CommitOptions): Promise<CommitResult> {
    const args = ["commit"];
    if (opts?.amend) {
      args.push("--amend");
    }
    if (opts?.signoff) {
      args.push("--signoff");
    }
    if (opts?.noVerify) {
      args.push("--no-verify");
    }
    if (opts?.author) {
      args.push(`--author=${opts.author}`);
    }

    // For an amend with no new message, let git reuse the existing one.
    const reuseMessage = opts?.amend && message.trim() === "";
    if (reuseMessage) {
      args.push("--no-edit");
    } else {
      args.push("-F", "-");
    }

    const r = await this.proc.run(args, {
      signal: opts?.signal,
      input: reuseMessage ? undefined : message,
    });
    return { ok: r.code === 0, stderr: r.stderr };
  }

  /** The number of staged entries that differ from HEAD (`git diff --cached
   *  --name-only`). Cheap input for the commit box's "Commit N files" label. */
  async stagedCount(opts?: StagingOptions): Promise<number> {
    const r = await this.proc.run(
      ["diff", "--cached", "--name-only", "-z"],
      { signal: opts?.signal },
    );
    if (r.code !== 0) {
      return 0;
    }
    const names = r.stdout.split("\0").filter((s) => s.length > 0);
    return names.length;
  }
}
