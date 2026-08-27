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
