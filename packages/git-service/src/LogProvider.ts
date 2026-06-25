import type { CommitRecord } from "@gitstudio/host-bridge/git";
import type { GitProcess } from "./GitProcess";

/** US (unit separator) — field separator inside one commit record. */
const FIELD_SEP = "\x1f";
/** RS (record separator) — separates commit records. */
const RECORD_SEP = "\x1e";

// Ten %x1f-joined fields, terminated by %x1e. These separators near-never occur
// in commit messages, so the parse is robust to subjects/bodies containing
// spaces, pipes, quotes, tabs, and newlines.
const PRETTY_FORMAT =
  `--pretty=format:%H${FIELD_SEP}%P${FIELD_SEP}%an${FIELD_SEP}%ae` +
  `${FIELD_SEP}%at${FIELD_SEP}%cn${FIELD_SEP}%ce${FIELD_SEP}%ct` +
  `${FIELD_SEP}%s${FIELD_SEP}%b${RECORD_SEP}`;

export interface StreamCommitsOptions {
  /** A rev range / single rev (default "HEAD"), or "--all" for every ref. */
  revRange?: string;
  maxCount?: number;
  skip?: number;
  paths?: string[];
  signal?: AbortSignal;
}

/** Streams parsed commit records out of `git log`. */
export class LogProvider {
  constructor(private proc: GitProcess) {}

  async *streamCommits(
    opts?: StreamCommitsOptions,
  ): AsyncGenerator<CommitRecord> {
    const args = ["log", "--parents", "--date-order", PRETTY_FORMAT];

    if (opts?.maxCount !== undefined) {
      args.push(`--max-count=${opts.maxCount}`);
    }
    if (opts?.skip !== undefined) {
      args.push(`--skip=${opts.skip}`);
    }

    const revRange = opts?.revRange ?? "HEAD";
    if (revRange === "--all") {
      args.push("--all");
    } else {
      args.push(revRange);
    }

    if (opts?.paths && opts.paths.length > 0) {
      args.push("--", ...opts.paths);
    }

    let buffer = "";
    for await (const chunk of this.proc.stream(args, { signal: opts?.signal })) {
      buffer += chunk;
      let sep = buffer.indexOf(RECORD_SEP);
      while (sep !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 1);
        const record = parseRecord(raw);
        if (record) {
          yield record;
        }
        sep = buffer.indexOf(RECORD_SEP);
      }
    }

    // The final record carries no trailing %x1e once the stream ends.
    const record = parseRecord(buffer);
    if (record) {
      yield record;
    }
  }
}

function parseRecord(raw: string): CommitRecord | undefined {
  // git inserts a newline between the %x1e of one record and the %H of the next.
  const trimmed = raw.startsWith("\n") ? raw.slice(1) : raw;
  if (trimmed.length === 0) {
    return undefined;
  }

  const fields = trimmed.split(FIELD_SEP);
  if (fields.length < 10 || fields[0] === "") {
    return undefined;
  }

  return {
    sha: fields[0],
    parents: fields[1].split(" ").filter((p) => p.length > 0),
    author: fields[2],
    authorEmail: fields[3],
    authorDate: Number(fields[4]),
    committer: fields[5],
    committerEmail: fields[6],
    committerDate: Number(fields[7]),
    subject: fields[8],
    body: fields[9],
  };
}
