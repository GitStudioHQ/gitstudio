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
  /**
   * A rev range / single rev (default "HEAD"), or "--all" for the whole graph.
   *
   * "--all" here means every BRANCH, TAG, REMOTE and HEAD — not git's literal
   * `--all`, which also sweeps in refs/notes/* and refs/stash. See the traversal
   * below for why those must not appear as history.
   */
  revRange?: string;
  /**
   * Narrow the "--all" traversal to these refs (issue #30's branch filter).
   *
   * FULLY-QUALIFIED names — refs/heads/x, refs/remotes/origin/x, refs/tags/t.
   * A short name is ambiguous the moment a tag shares it with a branch, and
   * git resolves the ambiguity by its own precedence, not the user's tick.
   * When non-empty these replace the branches/tags/remotes expansion; HEAD is
   * always added, so a detached head can never filter itself out of the graph.
   * They reach git on stdin, never argv, so their number is unbounded; an
   * entry that is not a plain refs/… name is dropped (see revisionLines).
   * Ignored unless `revRange` is "--all".
   */
  refs?: string[];
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
    /** stdin for `git log --stdin`, when the revisions travel that way. */
    let input: string | undefined;
    if (revRange === "--all") {
      // NOT `--all`, which means every ref under refs/ — including refs/notes/*
      // and refs/stash. Those are not history, and putting them in the graph is
      // not a cosmetic problem:
      //
      //   * Note commits are dated when the note was WRITTEN, so they sort to
      //     the top of a date-ordered log and push real commits down. They carry
      //     no subject, so the graph shows rows that are blank.
      //   * They are numerous. This repository had 163 of them against 202 real
      //     commits — 45% of the graph was notes.
      //   * They break skip-based paging. Page boundaries are positions in that
      //     polluted list, so writing a note between two page reads shifts every
      //     later page, and a real commit falls into the gap and is never shown.
      //     That is the "graph silently omits a commit" report, and why it looked
      //     load-dependent rather than reproducible.
      //
      // Anything that writes notes does this: `git notes`, CI annotators, review
      // tools, AI assistants. HEAD is listed explicitly because --branches does
      // not cover a DETACHED head, and dropping the commit you are sitting on
      // would be a worse bug than the one being fixed.
      if (opts?.refs && opts.refs.length > 0) {
        // The branch filter: exactly the ticked refs, plus HEAD for the same
        // reason as above. `--ignore-missing` because the selection is stored
        // per repository and a branch in it can be deleted between the ref
        // listing and this spawn (or by another tool while the app was closed);
        // git would otherwise refuse the whole log over one gone ref. A missing
        // ref contributes nothing, which is what "gone" should mean here. It
        // must come BEFORE --stdin: git reads stdin the moment it meets that
        // flag, with whatever options it has seen so far.
        //
        // The refs go on STDIN, not argv. Windows caps a command line at
        // 32,767 characters, and "Local only" on a repository with ~800
        // branches (at ~40 characters a name) is already past it — the spawn
        // fails and the graph shows an error instead of history. stdin has no
        // ceiling, and the argv below is the same length for 3 refs or 30,000.
        args.push("--ignore-missing", "--stdin");
        input = revisionLines(opts.refs);
      } else {
        args.push("--branches", "--tags", "--remotes", "HEAD");
      }
    } else {
      args.push(revRange);
    }

    if (opts?.paths && opts.paths.length > 0) {
      args.push("--", ...opts.paths);
    }

    let buffer = "";
    for await (const chunk of this.proc.stream(args, { signal: opts?.signal, input })) {
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

  /**
   * Whether the walk `streamCommits({ revRange: "--all", refs })` makes
   * would reach `sha` at all — reachable from one of the ticked refs or from
   * HEAD — without walking it.
   *
   * A reveal into a filtered graph (a Branches-view click, a PR link, a
   * parent chip) lands on a commit the ticked refs need not reach as a matter
   * of course, and paging toward it walks the whole filtered history to find
   * nothing. One rev-list answers first: `sha` with every ref negated lists
   * sha itself when nothing reaches it, and nothing when something does.
   * A git failure answers true, so the caller falls back to paging — the
   * behaviour it had before it asked.
   */
  async walkReaches(
    sha: string,
    refs: readonly string[],
    opts?: { signal?: AbortSignal },
  ): Promise<boolean> {
    const r = await this.proc.run(
      [
        "rev-list",
        "--max-count=1",
        // A ticked ref can be gone by now (see streamCommits); a gone ref
        // reaches nothing, which is what its absence should mean here.
        "--ignore-missing",
        // The negated refs go on stdin for the reason streamCommits' do: a
        // ticked set is as long as the user made it, and Windows' command line
        // is not. `^` is revision syntax, so it reads the same on stdin.
        "--stdin",
        // The sha stays on argv, past the marker: it comes from a click, and
        // on argv behind --end-of-options it can only ever be a revision.
        "--end-of-options",
        sha,
      ],
      { ...opts, input: revisionLines(refs, "^") },
    );
    if (r.code !== 0) {
      return true;
    }
    return r.stdout.trim() === "";
  }
}

/**
 * A plain, fully-qualified ref name — the only thing the branch filter hands
 * git. Git itself refuses to create anything else under refs/ (no control
 * characters or spaces, none of ~ ^ : ? * [ \, no "..", no "@{"), so a
 * selection entry that fails this names no ref that can exist, and dropping it
 * loses nothing.
 */
const PLAIN_REF = /^refs\/(?!.*\.\.)(?!.*@\{)[^\x00-\x20\x7f~^:?*[\\]+$/;

/**
 * The `--stdin` payload for a set of refs: one revision per line, HEAD last,
 * each optionally negated with `prefix`.
 *
 * The refs are DATA — a selection read back from storage — and on stdin a line
 * is not only a revision. A line starting with "-" is a pseudo-option to git ≥
 * 2.42 (a literal "--all" would silently widen the walk to the notes and stash
 * the "--all" expansion exists to keep out) and a fatal "options not supported
 * in --stdin mode" to anything older; "a..b" is a range; a newline smuggles in
 * a second line. `--end-of-options` cannot be sent to disarm the first, since
 * older git dies on it too. So only a plain fully-qualified ref name gets a
 * line of its own: PLAIN_REF admits exactly the names git allows under refs/.
 * Both hosts prune the selection against the live ref list before it gets
 * here, so in practice nothing is dropped; this is the floor under that.
 */
export function revisionLines(refs: readonly string[], prefix = ""): string {
  const lines = refs.filter((ref) => PLAIN_REF.test(ref)).map((ref) => prefix + ref);
  lines.push(`${prefix}HEAD`);
  return lines.join("\n") + "\n";
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
