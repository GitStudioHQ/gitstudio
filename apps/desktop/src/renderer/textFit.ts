// Pure text-fitting helpers — DOM-free so they unit-test under plain node
// (ui.ts touches `window` at import time and cannot be imported from a test).

/**
 * Shorten a filesystem path from the MIDDLE.
 *
 * CSS ellipsis truncates from the right, which on a path removes the only part
 * that distinguishes it: two clones of the same repo under different parents
 * both render as "/Users/anton/Developer/GitStu…". Keeping both ends keeps the
 * answer to "which one is this?".
 */
export function middleTruncate(text: string, max = 44): string {
  if (text.length <= max) return text;
  if (max <= 1) return "…";
  const keep = max - 1;
  const head = Math.ceil(keep * 0.4);
  const tail = keep - head;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/**
 * "1 commit" / "2 commits" — never "commit(s)".
 *
 * That placeholder had shipped into seven visible strings, including a menu
 * subtitle and the sync button's tooltip. It is the kind of thing a reader
 * reads as unfinished software, because it is.
 */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/**
 * Split a file into the lines a reader would count.
 *
 * `"a\nb\n".split("\n")` is `["a", "b", ""]`, and every code viewer in the app
 * numbered that trailing empty string as a real line. A POSIX text file ends in
 * a newline, so this was not an edge case — it was every file: a 5-line file
 * showed 6 numbers, and a line reference was off by one against the editor the
 * reader would go on to open.
 *
 * Only ONE trailing empty is dropped: a file ending in a genuinely blank line
 * ("a\n\n") keeps it, because that blank line is really there.
 */
export function fileLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
