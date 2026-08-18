import type { ChangeBlock } from "@gitstudio/git-service/blockStaging";

/**
 * The change covering `line` (0-based), preferring an exact hit.
 *
 * Separate from stagedGutter.ts, which imports `vscode` and therefore cannot be
 * loaded by node:test. This is the part worth testing: getting it wrong stages a
 * change the user was not pointing at, and nothing on screen would say so.
 *
 * A zero-width working span — a deletion, which occupies no line on the working
 * side — arrives with `end < start`. Plain range arithmetic can never be true
 * for that, which would make every deletion silently unstageable from the
 * gutter, so it is matched on its anchor line instead.
 */
export function blockAtLine(
  blocks: readonly ChangeBlock[],
  line: number,
): ChangeBlock | undefined {
  return blocks.find((b) => {
    const { start, end } = b.working;
    if (end < start) return line === start;
    return line >= start && line <= end;
  });
}
