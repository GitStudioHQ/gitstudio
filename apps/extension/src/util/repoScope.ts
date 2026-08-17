/**
 * "Is this path at or inside that directory?" — and its Changes-view corollary,
 * "is this one of THIS repository's working-tree files?"
 *
 * The one home for a comparison this codebase has already got wrong once. Each
 * part is the kind of thing that looks obviously right and is quietly wrong:
 *
 *   · a bare `startsWith(root)` also matches a sibling directory whose name
 *     merely begins with the root's — an edit in `/code/app-old` would count as
 *     an edit in `/code/app`. The boundary separator is what makes it a
 *     containment test rather than a prefix test.
 *   · separators are mixed. VS Code hands back `fsPath` using "\" on Windows,
 *     and a forward-slash-only boundary once made the active repo fall back to
 *     the wrong root (see repoManager's history).
 *   · case matters only on Linux. macOS and Windows will hand back a path whose
 *     drive letter or folder casing differs from the one git reported, and a
 *     case-sensitive compare silently drops it.
 *   · `.git` has to be excluded from the working-tree question, or git's own
 *     bookkeeping churn counts as an edit. repoManager watches the metadata that
 *     matters (HEAD, MERGE_HEAD, refs) with its own dedicated watchers.
 *
 * Pure string work on absolute paths — no fs access, no vscode import — so it is
 * unit-testable, including the Windows shape while running on a Mac.
 */

/** Accepts both separators: a Windows path can carry either, and VS Code mixes them. */
const GIT_DIR_SEGMENT = /[/\\]\.git(?:[/\\]|$)/;

/**
 * Normalize for comparison: drop trailing separators, and fold case anywhere the
 * filesystem does. Only Linux is treated as case-sensitive, matching the rule
 * repoManager already used.
 */
function norm(p: string, platform: string): string {
  const noTrail = p.replace(/[\\/]+$/, "");
  return platform === "linux" ? noTrail : noTrail.toLowerCase();
}

/**
 * True when `child` IS `parent` or sits underneath it. Separator- and
 * case-tolerant per the rules above.
 *
 * `platform` is a parameter rather than a direct `process.platform` read so the
 * tests can exercise every filesystem's behaviour on whichever one is running
 * them; callers pass `process.platform`.
 */
export function isSamePathOrInside(
  child: string,
  parent: string,
  platform: string = process.platform,
): boolean {
  if (!child || !parent) {
    return false;
  }
  const c = norm(child, platform);
  const p = norm(parent, platform);
  return c === p || c.startsWith(`${p}/`) || c.startsWith(`${p}\\`);
}

/** True when `filePath` is `root` itself or sits underneath it. */
export function isInsideRepo(
  filePath: string,
  root: string,
  platform: string = process.platform,
): boolean {
  return isSamePathOrInside(filePath, root, platform);
}

/** True when `filePath` is inside a `.git` directory (at any depth). */
export function isGitMetadata(filePath: string): boolean {
  return GIT_DIR_SEGMENT.test(filePath);
}

/**
 * The whole question in one call: a working-tree file of this repo, and not
 * git's own metadata.
 */
export function isWorkingTreeFileOf(
  filePath: string,
  root: string,
  platform: string = process.platform,
): boolean {
  return isInsideRepo(filePath, root, platform) && !isGitMetadata(filePath);
}
