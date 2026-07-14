import type { BlameResult } from "@gitstudio/host-bridge/blame";
import { parseIncrementalBlame } from "@gitstudio/engine/blame/parse";
import type { GitProcess } from "./GitProcess";

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
      throw new Error(
        `git blame failed for ${relPath} (exit ${result.code}): ${result.stderr.trim()}`,
      );
    }

    return parseIncrementalBlame(result.stdout);
  }
}
