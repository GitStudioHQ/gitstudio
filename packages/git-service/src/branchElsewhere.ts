import { nativePath, sameFolder } from "./folderPath";
import type { GitProcess, GitRunOptions } from "./GitProcess";

// The words live in host-bridge, node-free, so the desktop's renderer says
// the same ones.
export { checkedOutElsewhereMessage, type ElsewhereDoor } from "@gitstudio/host-bridge/branchElsewhere";

// A branch is checked out in one worktree at a time. git refuses a second
// checkout ("fatal: 'x' is already used by worktree at …") and a delete
// ("error: cannot delete branch 'x' used by worktree at …"), and the doors
// used to run git anyway and show those words — Delete after asking "Delete
// branch x?", the extension's graph chip through the error path that files
// crash reports. So a door asks here first, and says where the branch is in
// its own words before git runs. Read locale-free from %(worktreepath).

/**
 * The folder of ANOTHER worktree that has `fullName` (refs/heads/…) checked
 * out — compared with this one (`proc.cwd`) as a folder, not as text (see
 * folderPath), and spelled the system's way to be shown. Undefined when
 * no worktree has it, only this one does, it is not a local branch, or git
 * cannot say (the door then runs as before, and git decides).
 *
 * Not seen: a branch another worktree is REBASING — its HEAD is detached
 * then, and %(worktreepath) is empty. git's own refusal still covers it.
 */
export async function checkedOutElsewhere(
  proc: GitProcess,
  fullName: string,
  opts?: GitRunOptions,
): Promise<string | undefined> {
  if (!fullName.startsWith("refs/heads/")) {
    return undefined;
  }
  const r = await proc.run(["for-each-ref", "--format=%(refname)%00%(worktreepath)", fullName], {
    signal: opts?.signal,
  });
  if (r.code !== 0) {
    return undefined;
  }
  // for-each-ref matches a pattern up to a slash as well as exactly
  // (refs/heads/x also lists refs/heads/x/y), so the row is picked by name.
  const where = r.stdout
    .split("\n")
    .map((line) => line.split("\0"))
    .find((f) => f[0] === fullName)?.[1];
  if (!where || sameFolder(where, proc.cwd)) {
    return undefined;
  }
  return nativePath(where);
}
