// The words for a branch another worktree has checked out — one vocabulary for
// both products, node-free so the desktop's renderer says them too.
//
// git checks a branch out in one worktree at a time, and refuses a second
// checkout or a delete in its own words. The doors ask where the branch is
// first (git-service's checkedOutElsewhere, or the desktop renderer's worktree
// list) and say this instead, before anything runs.

/** The doors a branch checked out elsewhere is refused at. */
export type ElsewhereDoor = "checkout" | "delete";

/**
 * Where the branch is, and what to do instead. `where` as the host shows
 * paths. `folderGone`: that worktree's folder is gone — git still holds the
 * branch for it, and forgetting the worktree is the only way to free it.
 */
export function checkedOutElsewhereMessage(
  branch: string,
  where: string,
  door: ElsewhereDoor,
  folderGone = false,
): string {
  const at = `'${branch}' is checked out in the worktree at ${where}`;
  if (folderGone) {
    return `${at}, whose folder is gone — git still keeps the branch for it. Forget that worktree in Worktrees, then ${door === "checkout" ? "check it out" : "delete it"}.`;
  }
  return door === "checkout"
    ? `${at}, and a branch can be checked out in only one worktree at a time. Work on it there, or create a new branch from it here.`
    : `${at}, so it can't be deleted. Check out another branch in that worktree, or remove the worktree, first.`;
}
