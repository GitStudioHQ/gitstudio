// Pure, host-agnostic model of git's `git-rebase-todo` file.
//
// A `git rebase -i` todo is a line-oriented script: the six commit verbs
// (`pick`/`reword`/`edit`/`squash`/`fixup`/`drop`, plus their single-letter
// short forms) each name a commit, while everything else — comments, blank
// lines, and the rebase-merges directives (`exec`/`x`, `label`/`l`,
// `reset`/`t`, `merge`/`m`, `break`/`b`, `update-ref`, `noop`) — is content we
// don't reorder and must reproduce verbatim.
//
// The guiding invariant for safety: a UI may reorder rows and retype the six
// commit verbs, but *everything else round-trips byte-for-byte*. We achieve
// that by keeping each line's original `raw` text; a commit entry only
// regenerates its line when its action changed (the order is driven by the
// array order on serialize, so a moved-but-unedited entry still re-emits its
// own `raw`). This package must never import vscode/fs/monaco.

export type RebaseAction =
  | "pick"
  | "reword"
  | "edit"
  | "squash"
  | "fixup"
  | "drop";

export interface RebaseCommitEntry {
  kind: "commit";
  /** The current (possibly retyped) action verb. */
  action: RebaseAction;
  /** The commit object name as it appears in the todo (abbreviated or full). */
  sha: string;
  /**
   * The commit subject: the remainder of the line after the sha, without the
   * `# ` a newer git writes in front of it (see {@link todoSubject}).
   */
  subject: string;
  /**
   * The verbatim original line text (no EOL). Re-emitted unchanged whenever the
   * entry's `action` still matches what was parsed, so untouched lines (even
   * after a reorder) round-trip byte-for-byte.
   */
  raw: string;
}

export interface RebasePassthroughLine {
  kind: "passthrough";
  /**
   * The verbatim original line text (no EOL): comments (`#…`), blank lines, and
   * directives we deliberately don't model (exec/x, label/l, reset/t, merge/m,
   * break/b, update-ref, noop). Always re-emitted exactly.
   */
  raw: string;
}

export type RebaseLine = RebaseCommitEntry | RebasePassthroughLine;

/** The long verb -> action, plus the single-letter short forms git accepts. */
const ACTION_BY_TOKEN: Readonly<Record<string, RebaseAction>> = {
  pick: "pick",
  p: "pick",
  reword: "reword",
  r: "reword",
  edit: "edit",
  e: "edit",
  squash: "squash",
  s: "squash",
  fixup: "fixup",
  f: "fixup",
  drop: "drop",
  d: "drop",
};

/**
 * Matches a commit line: optional leading whitespace, a commit verb (long or
 * short), whitespace, a hex object name, then (optionally) whitespace + the
 * subject. The captured groups are the verb, the sha, and the rest-of-line.
 *
 * We intentionally do NOT match `update-ref`, `exec`, etc. here — those start
 * with their own tokens and fall through to passthrough.
 */
const COMMIT_LINE = /^(\s*)([A-Za-z]+)(\s+)([0-9a-fA-F]{4,40})(.*)$/;

/**
 * Parse a `git-rebase-todo` into a typed line list. Comments, blanks, and any
 * directive we don't model become passthrough lines that preserve their exact
 * `raw`. EOL style and any trailing newline are not stored on the lines; they
 * are recovered/preserved by {@link serializeRebaseTodo} via its `eol` option —
 * the caller detects the document's EOL (see {@link detectEol}).
 */
export function parseRebaseTodo(text: string): RebaseLine[] {
  // Split on either EOL form. A trailing newline yields a final "" element we
  // drop so we don't synthesize a phantom blank line; serialize re-adds the
  // terminator. Lines keep no embedded "\r" because we strip a trailing one.
  const rawLines = splitLines(text);
  const lines: RebaseLine[] = [];

  for (const raw of rawLines) {
    const entry = parseCommitLine(raw);
    lines.push(entry ?? { kind: "passthrough", raw });
  }
  return lines;
}

/** Attempts to read a single line as a commit entry; null if it isn't one. */
function parseCommitLine(raw: string): RebaseCommitEntry | null {
  const m = COMMIT_LINE.exec(raw);
  if (!m) {
    return null;
  }
  const verb = m[2].toLowerCase();
  const action = ACTION_BY_TOKEN[verb];
  if (!action) {
    return null;
  }
  const sha = m[4];
  return { kind: "commit", action, sha, subject: todoSubject(m[5]), raw };
}

/**
 * The commit subject from what follows the object name on a todo line.
 *
 * git writes that part two ways, and both are in the wild:
 *
 *   pick 0151064 c3          ← git up to 2.54
 *   pick 0151064 # c3        ← git 2.55: the subject is written as a comment
 *
 * so a newer git's subject starts with a `# ` that is not part of it — shown
 * as-is, every commit title read "# c3". The separator is always a literal
 * `#` whatever `core.commentChar` says (verified against git 2.55 with
 * `core.commentChar=;`), and an empty subject is `pick <sha> # ` — or `#`
 * alone once an editor trims the line. Only ONE separator comes off: a
 * subject that itself starts with `#` is written `pick <sha> # # hashtag`
 * and is kept as `# hashtag`.
 *
 * Under an older git a subject that begins `# ` reads the same as the
 * separator and loses it here. That is display only: a line is written back
 * from its own `raw`, never from this.
 */
export function todoSubject(rest: string): string {
  return rest.replace(/^\s+/, "").replace(/^#(?: |$)/, "");
}

export interface SerializeOptions {
  /** End-of-line marker; defaults to "\n". */
  eol?: "\n" | "\r\n";
  /**
   * Whether to terminate the file with a trailing EOL. Real todos end with one;
   * defaults to true so round-trips of typical files are exact.
   */
  trailingNewline?: boolean;
}

/**
 * Serialize a line list back to `git-rebase-todo` text. Passthrough lines and
 * unchanged commit entries re-emit their `raw` verbatim; a commit entry whose
 * `action` no longer matches its `raw` is regenerated as `<action> <sha> <subject>`.
 *
 * Round-trip guarantee: for any real todo,
 *   `serializeRebaseTodo(parseRebaseTodo(x)) === x`
 * when no edits were made — because every line re-emits its stored `raw`.
 */
export function serializeRebaseTodo(
  lines: RebaseLine[],
  opts?: SerializeOptions,
): string {
  const eol = opts?.eol ?? "\n";
  const trailingNewline = opts?.trailingNewline ?? true;
  const out: string[] = [];

  for (const line of lines) {
    out.push(line.kind === "commit" ? renderCommit(line) : line.raw);
  }

  let text = out.join(eol);
  if (trailingNewline && lines.length > 0) {
    text += eol;
  }
  return text;
}

/**
 * Render a commit entry. If its current `action` matches the verb its `raw`
 * began with, re-emit `raw` unchanged (preserving exact original spacing and
 * any short-form verb). Otherwise regenerate `<action> <sha>` followed by the
 * rest of `raw` as git wrote it — so a newer git's `# <subject>` keeps its
 * separator, and git's own trailing `# empty` stays — or by ` <subject>` for
 * an entry with no line of its own.
 */
function renderCommit(entry: RebaseCommitEntry): string {
  if (rawMatchesAction(entry)) {
    return entry.raw;
  }
  const m = COMMIT_LINE.exec(entry.raw);
  if (m && m[4] === entry.sha) {
    return `${entry.action} ${entry.sha}${m[5]}`;
  }
  const subject = entry.subject ? ` ${entry.subject}` : "";
  return `${entry.action} ${entry.sha}${subject}`;
}

/** True when `entry.raw`'s leading verb still denotes `entry.action`. */
function rawMatchesAction(entry: RebaseCommitEntry): boolean {
  const m = COMMIT_LINE.exec(entry.raw);
  if (!m) {
    return false;
  }
  const action = ACTION_BY_TOKEN[m[2].toLowerCase()];
  return action === entry.action && m[4] === entry.sha;
}

/**
 * Detect the dominant EOL in a todo's text: "\r\n" if any CRLF is present, else
 * "\n". Callers pass this to {@link serializeRebaseTodo} so writes preserve the
 * file's line-ending style.
 */
export function detectEol(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** True when the text ends with a newline (so serialize keeps the terminator). */
export function hasTrailingNewline(text: string): boolean {
  return /\r?\n$/.test(text);
}

/**
 * Split text into lines without embedded EOLs, dropping the single empty
 * element a trailing newline would produce. Handles mixed/CRLF endings.
 */
function splitLines(text: string): string[] {
  if (text === "") {
    return [];
  }
  const parts = text.split(/\r?\n/);
  // A trailing newline leaves a final "" — drop exactly that one.
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}

/** Human-friendly summary parsed from the standard todo comment block. */
export interface RebaseSummary {
  /** e.g. "Rebase a1b2c3d..f4e5d6c onto a1b2c3d (3 commands)" if present. */
  headerComment: string | null;
  /** Count of commit entries (rows the UI shows). */
  commitCount: number;
}

/**
 * Extract a header summary from a parsed todo: the first "# Rebase …" comment
 * git writes, plus the number of commit rows. Pure string scanning; safe on any
 * input (returns nulls when the comment block is absent).
 */
export function summarizeRebaseTodo(lines: RebaseLine[]): RebaseSummary {
  let headerComment: string | null = null;
  let commitCount = 0;
  for (const line of lines) {
    if (line.kind === "commit") {
      commitCount++;
      continue;
    }
    if (headerComment === null) {
      const m = /^#\s*(Rebase\b.*)$/.exec(line.raw.trim());
      if (m) {
        headerComment = m[1];
      }
    }
  }
  return { headerComment, commitCount };
}
