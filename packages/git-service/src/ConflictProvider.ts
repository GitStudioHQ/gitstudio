import type { GitProcess } from "./GitProcess";
import { parseConflictMarkers } from "@gitstudio/engine/conflict/markers";
import type { VersionsSource } from "@gitstudio/host-bridge/protocol";

export interface ConflictVersions {
  /** Common ancestor (stage :1:), or "" when there is none. */
  base: string;
  /** Our side (stage :2: / HEAD), or "" when absent. */
  ours: string;
  /** Their side (stage :3: / incoming), or "" when absent. */
  theirs: string;
  /** Whether a real common ancestor is available (drives 3-way diffing). */
  hasBase: boolean;
  /** How the three sides were derived. */
  source: VersionsSource;
}

export interface GetConflictVersionsOptions {
  signal?: AbortSignal;
  /**
   * Working-tree text of the conflicted file. Used for the marker fallback when
   * the git index stages are unavailable. The extension passes the live
   * document text so unsaved edits to the markers are honored.
   */
  workingText?: string;
}

export interface ConflictReadOptions {
  signal?: AbortSignal;
}

/**
 * Reads merge-conflict versions and unmerged status via the git CLI, so it
 * works headless (tests), in the VS Code extension, and in the future desktop
 * app — never tied to vscode.git. This package must never import `vscode`.
 *
 * Stages are read with `git show :1:<path>` / `:2:` / `:3:`; any stage may be
 * absent for a non-content conflict (e.g. add/add has no :1:, delete/modify is
 * missing one side), in which case it reads as "". When no stages exist it
 * falls back to reconstructing the sides from the working-tree conflict markers.
 */
export class ConflictProvider {
  constructor(private proc: GitProcess) {}

  /**
   * Resolves the three sides of a conflicted file. Prefers git index stages;
   * falls back to the working-tree markers (`opts.workingText`) when none are
   * present.
   */
  async getConflictVersions(
    relPath: string,
    opts?: GetConflictVersionsOptions,
  ): Promise<ConflictVersions> {
    const signal = opts?.signal;
    const [base, ours, theirs] = await Promise.all([
      this.showStage(1, relPath, signal),
      this.showStage(2, relPath, signal),
      this.showStage(3, relPath, signal),
    ]);

    // At least one of ours/theirs present means we have usable stage data.
    if (ours !== undefined || theirs !== undefined) {
      return {
        base: base ?? "",
        ours: ours ?? "",
        theirs: theirs ?? "",
        hasBase: base !== undefined,
        source: "git-stages",
      };
    }

    // Fallback: reconstruct the sides from conflict markers in the working file.
    const workingText = opts?.workingText;
    if (workingText !== undefined) {
      const parsed = parseConflictMarkers(workingText);
      if (parsed.hasConflicts) {
        return {
          base: parsed.isDiff3 ? parsed.base : "",
          ours: parsed.ours,
          theirs: parsed.theirs,
          hasBase: parsed.isDiff3,
          source: "markers",
        };
      }
    }

    return { base: "", ours: "", theirs: "", hasBase: false, source: "none" };
  }

  /**
   * Reads a single conflict stage (1 base, 2 ours, 3 theirs) via
   * `git show :<n>:<path>`. Returns undefined when the stage is absent (git
   * exits non-zero) so the caller can distinguish "missing" from "empty".
   */
  private async showStage(
    stage: 1 | 2 | 3,
    relPath: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const result = await this.proc.run(["show", `:${stage}:${relPath}`], {
      signal,
    });
    return result.code === 0 ? result.stdout : undefined;
  }

  /**
   * Returns the contents of `relPath` at git HEAD (`git show HEAD:<path>`).
   * Returns "" when the file did not exist at HEAD (git exits non-zero).
   */
  async getHeadVersion(
    relPath: string,
    opts?: ConflictReadOptions,
  ): Promise<string> {
    const result = await this.proc.run(["show", `HEAD:${relPath}`], {
      signal: opts?.signal,
    });
    return result.code === 0 ? result.stdout : "";
  }

  /** Whether `relPath` is currently an unresolved merge conflict (unmerged). */
  async isConflicted(
    relPath: string,
    opts?: ConflictReadOptions,
  ): Promise<boolean> {
    const result = await this.proc.run(
      ["status", "--porcelain=v2", "-z", "--", relPath],
      { signal: opts?.signal },
    );
    if (result.code !== 0) {
      return false;
    }
    return parseUnmergedPaths(result.stdout).length > 0;
  }

  /** Repo-relative paths of all unmerged (conflicted) files. */
  async listConflicts(opts?: ConflictReadOptions): Promise<string[]> {
    const result = await this.proc.run(["status", "--porcelain=v2", "-z"], {
      signal: opts?.signal,
    });
    if (result.code !== 0) {
      return [];
    }
    return parseUnmergedPaths(result.stdout);
  }
}

/**
 * Parses `git status --porcelain=v2 -z` output and returns the repo-root-
 * relative paths of unmerged (`u`) records. An unmerged record is
 * `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>` (NUL-terminated);
 * the path is everything after the nine fixed fields.
 */
export function parseUnmergedPaths(porcelain: string): string[] {
  const paths: string[] = [];
  for (const record of porcelain.split("\0")) {
    const match = /^u (?:\S\S) (?:\S+ ){8}(.+)$/.exec(record);
    if (match) {
      paths.push(match[1]);
    }
  }
  return paths;
}
