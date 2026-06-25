import type { GitProcess } from "./GitProcess";

/** US (unit separator) — field separator inside one record. */
const FIELD_SEP = "\x1f";
/** RS (record separator) — separates records. */
const RECORD_SEP = "\x1e";

// Seven %x1f-joined fields, terminated by %x1e. Same framing as LogProvider so
// the parse is robust to subjects/bodies containing arbitrary text. We carry a
// trailing %x1e so records are delimited even when the patch output of `-L`
// interleaves diff hunks between them.
const HISTORY_FORMAT =
  `--pretty=format:%H${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%at` +
  `${FIELD_SEP}%s${FIELD_SEP}%b${RECORD_SEP}`;

export interface FileHistoryEntry {
  sha: string;
  shortSha: string;
  author: string;
  authorEmail: string;
  /** Authored timestamp, epoch seconds. */
  authorDate: number;
  subject: string;
  body: string;
  /**
   * The file's path at that commit. With rename-following this can differ from
   * the queried path when derivable; otherwise it is the queried path.
   */
  path: string;
}

export interface LineHistoryEntry {
  sha: string;
  shortSha: string;
  author: string;
  authorEmail: string;
  /** Authored timestamp, epoch seconds. */
  authorDate: number;
  subject: string;
}

export interface FileHistoryOptions {
  maxCount?: number;
  /** Start rev for the history walk; defaults to HEAD. */
  rev?: string;
  /** Follow renames (default true). Pass false to disable. */
  follow?: boolean;
  signal?: AbortSignal;
}

export interface LineHistoryOptions {
  maxCount?: number;
  signal?: AbortSignal;
}

export interface FileAtRevisionOptions {
  signal?: AbortSignal;
}

/**
 * Reads a single file's commit history, the history of a line range within it,
 * and the file's content at any revision — all via `git log` / `git show`.
 * This package must never import `vscode`.
 */
export class HistoryProvider {
  constructor(private proc: GitProcess) {}

  /**
   * Lists the commits that touched `relPath`, newest-first, optionally
   * following renames. Returns the path at each commit when --follow makes it
   * derivable, else `relPath`.
   */
  async fileHistory(
    relPath: string,
    opts?: FileHistoryOptions,
  ): Promise<FileHistoryEntry[]> {
    const args = ["log", "--date-order"];
    if (opts?.follow !== false) {
      args.push("--follow");
    }
    if (opts?.maxCount !== undefined) {
      args.push(`--max-count=${opts.maxCount}`);
    }
    args.push(HISTORY_FORMAT);
    args.push(opts?.rev ?? "HEAD");
    args.push("--", relPath);

    const result = await this.proc.run(args, { signal: opts?.signal });
    if (result.code !== 0) {
      throw new Error(
        `git log --follow failed for ${relPath} (exit ${result.code}): ` +
          `${result.stderr.trim()}`,
      );
    }

    const entries: FileHistoryEntry[] = [];
    for (const raw of splitRecords(result.stdout)) {
      const rec = parseRecord(raw);
      if (rec) {
        entries.push({ ...rec, path: relPath });
      }
    }
    return entries;
  }

  /**
   * Lists the commits that changed lines `startLine..endLine` of `relPath`,
   * newest-first. Uses `git log -L<start>,<end>:<path>`. We prefer
   * `--no-patch`, but some git builds reject `-L` without a patch; in that case
   * we re-run WITH the patch and parse only the commit-header records by their
   * %x1e framing, ignoring the diff hunks that fall between records.
   */
  async lineHistory(
    relPath: string,
    startLine: number,
    endLine: number,
    opts?: LineHistoryOptions,
  ): Promise<LineHistoryEntry[]> {
    const lineArg = `-L${startLine},${endLine}:${relPath}`;
    const countArgs = maxCountArgs(opts);

    // First try without the diff payload — cleaner and cheaper.
    let result = await this.proc.run(
      ["log", "--no-patch", lineArg, HISTORY_FORMAT, ...countArgs],
      { signal: opts?.signal },
    );

    // Fall back to a patch-bearing run when --no-patch+-L is rejected.
    if (result.code !== 0 && /--no-patch|no.?patch|usage/i.test(result.stderr)) {
      result = await this.proc.run(
        ["log", lineArg, HISTORY_FORMAT, ...countArgs],
        { signal: opts?.signal },
      );
    }

    if (result.code !== 0) {
      throw new Error(
        `git log -L failed for ${relPath} (exit ${result.code}): ` +
          `${result.stderr.trim()}`,
      );
    }

    const entries: LineHistoryEntry[] = [];
    for (const raw of splitRecords(result.stdout)) {
      const rec = parseRecord(raw);
      if (rec) {
        entries.push({
          sha: rec.sha,
          shortSha: rec.shortSha,
          author: rec.author,
          authorEmail: rec.authorEmail,
          authorDate: rec.authorDate,
          subject: rec.subject,
        });
      }
    }
    return entries;
  }

  /**
   * Returns the contents of `relPath` at `rev` (`git show <rev>:<path>`). When
   * the file did not exist at that revision (git exits non-zero), returns "".
   */
  async fileAtRevision(
    rev: string,
    relPath: string,
    opts?: FileAtRevisionOptions,
  ): Promise<string> {
    const result = await this.proc.run(["show", `${rev}:${relPath}`], {
      signal: opts?.signal,
    });
    if (result.code !== 0) {
      return "";
    }
    return result.stdout;
  }
}

function maxCountArgs(opts?: LineHistoryOptions): string[] {
  return opts?.maxCount !== undefined ? [`--max-count=${opts.maxCount}`] : [];
}

interface ParsedRecord {
  sha: string;
  shortSha: string;
  author: string;
  authorEmail: string;
  authorDate: number;
  subject: string;
  body: string;
}

/**
 * Splits raw `git log` output on the %x1e record separator. With `-L` patches,
 * arbitrary diff text (including potential stray bytes) sits between a record's
 * terminator and the next record's %H; the slices that don't begin with a valid
 * record are discarded by parseRecord.
 */
function splitRecords(stdout: string): string[] {
  const out: string[] = [];
  let rest = stdout;
  let sep = rest.indexOf(RECORD_SEP);
  while (sep !== -1) {
    out.push(rest.slice(0, sep));
    rest = rest.slice(sep + 1);
    sep = rest.indexOf(RECORD_SEP);
  }
  return out;
}

function parseRecord(raw: string): ParsedRecord | undefined {
  // The bytes after the previous record's %x1e (a leading newline plus, under
  // `-L`, the previous record's diff hunks) precede the next %H. Locate the
  // 40-hex sha that starts a real record and parse from there.
  const shaMatch = raw.match(/[0-9a-f]{40}/);
  if (!shaMatch || shaMatch.index === undefined) {
    return undefined;
  }
  const trimmed = raw.slice(shaMatch.index);

  const fields = trimmed.split(FIELD_SEP);
  if (fields.length < 6 || fields[0].length < 7) {
    return undefined;
  }

  const sha = fields[0];
  return {
    sha,
    shortSha: sha.slice(0, 7),
    author: fields[1],
    authorEmail: fields[2],
    authorDate: Number(fields[3]),
    subject: fields[4],
    // The body may have trailing diff lines appended under `-L`; keep only up
    // to the record boundary, which splitRecords already stripped.
    body: fields[5],
  };
}
