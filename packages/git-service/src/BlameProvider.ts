import type { BlameResult } from "@gitstudio/host-bridge/blame";
import { parseIncrementalBlame } from "@gitstudio/engine/blame/parse";
import type { GitProcess } from "./GitProcess";
import { sep } from "node:path";
import * as l10n from "@vscode/l10n";

export interface BlameFileOptions {
  /** Blame a specific revision instead of the working tree. */
  rev?: string;
  /**
   * Dirty editor buffer to blame instead of the on-disk file. Fed to git via
   * `--contents -` on stdin; uncommitted lines surface as the zero-sha
   * "Not Committed Yet" commit. Ignored together with `rev` (git rejects both).
   */
  contents?: string;
  signal?: AbortSignal;
}

/**
 * Blame refused because the file is not in HEAD: it is untracked. (A file that
 * is added but not committed git blames from the index.) Nothing is wrong —
 * there is no history to show yet. Thrown so a
 * caller that blames on every edit can stop asking (and stop logging it,
 * #115) until a commit could have changed the answer. The message is the same
 * as any other refusal's.
 */
export class BlameNotCommittedError extends Error {
  readonly notCommitted = true;
}

/**
 * Reads `git blame --incremental` for a single file and parses it into a
 * BlameResult (commits keyed by sha + one entry per source line). Uses the
 * pure engine parser so all the format quirks live in one tested place.
 *
 * A single file's blame is small enough to buffer, so this uses `proc.run`
 * rather than streaming.
 */
export class BlameProvider {
  constructor(private proc: GitProcess) {}

  async blameFile(
    relPath: string,
    opts?: BlameFileOptions,
  ): Promise<BlameResult> {
    const args = ["blame", "--incremental"];

    // Dirty-buffer blame and rev-blame are mutually exclusive: with --contents
    // git blames the supplied bytes, so a rev would be meaningless (and git
    // errors). Prefer contents when both are somehow set.
    if (opts?.contents !== undefined) {
      args.push("--contents", "-");
    } else if (opts?.rev) {
      args.push(opts.rev);
    }

    args.push("--", relPath);

    const result = await this.proc.run(args, {
      signal: opts?.signal,
      input: opts?.contents,
    });

    if (result.code !== 0) {
      const message = l10n.t(
        "git blame failed for {0} (exit {1}): {2}",
        relPath,
        result.code,
        result.stderr.trim(),
      );
      // Asked of git rather than read from its message, which is translated.
      // `HEAD:<path>` is relative to the repository root, as relPath is, and
      // spelled with "/" — a Windows relative path arrives with backslashes.
      if (!opts?.rev && !opts?.signal?.aborted) {
        const treePath = sep === "\\" ? relPath.replace(/\\/g, "/") : relPath;
        const inHead = await this.proc.run(["cat-file", "-e", `HEAD:${treePath}`], { signal: opts?.signal });
        if (inHead.code !== 0) throw new BlameNotCommittedError(message);
      }
      throw new Error(message);
    }

    return parseIncrementalBlame(result.stdout);
  }
}
