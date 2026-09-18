/**
 * Finding issue and pull-request references in prose.
 *
 * GitHub links `#123` and `owner/repo#123` server-side; the app receives raw
 * markdown and has to do it at wire time. Only the first form was recognised,
 * so a repo-qualified reference — the one that actually needs saying, because
 * it points at a different project — rendered as plain grey text while the
 * bare number beside it was a link.
 *
 * Pure and node-free on purpose: the interesting part is the pattern, and a
 * pattern is worth testing without a DOM.
 */

/** One reference found in a run of text. */
export interface IssueRef {
  /** `owner/repo` when the reference names one, otherwise undefined. */
  repo?: string;
  number: number;
}

/**
 * A reference is a `#` and digits, optionally preceded by `owner/repo`, at a
 * word boundary.
 *
 * The leading boundary is `^` or whitespace and NOT a general `\b`: `\b` would
 * match inside `abc#12` and inside a URL fragment, and an anchor is not an
 * issue. The owner and repo halves allow what GitHub allows in a name — letters,
 * digits, `.`, `_` and `-` — and must start with an alphanumeric so a path
 * fragment like `../x#1` is not read as a repository.
 */
const REF = /((?:^|(?<=\s))(?:[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*)?#\d+\b)/;

/** The same pattern as a cheap pre-test, for skipping text that has none. */
export const HAS_ISSUE_REF = /(^|\s)(?:[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*)?#\d+/;

/** `#12` or `owner/repo#12` — exactly, with nothing around it. */
export function parseIssueRef(part: string): IssueRef | undefined {
  const m = /^(?:([A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*))?#(\d+)$/.exec(part);
  if (!m) return undefined;
  const number = Number(m[2]);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  return m[1] ? { repo: m[1], number } : { number };
}

/**
 * Split a run of text into alternating plain and reference pieces.
 *
 * Returns the pieces in order; a piece with `ref` set is a reference and its
 * `text` is exactly what was written, so the link can render the author's own
 * words rather than a normalised form.
 */
export function splitIssueRefs(text: string): Array<{ text: string; ref?: IssueRef }> {
  const out: Array<{ text: string; ref?: IssueRef }> = [];
  for (const part of text.split(REF)) {
    if (!part) continue;
    const ref = parseIssueRef(part);
    out.push(ref ? { text: part, ref } : { text: part });
  }
  return out;
}
