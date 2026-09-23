import type { RepoHead } from "@gitstudio/host-bridge/git";
import { headBranchName } from "@gitstudio/git-service/RefProvider";

// What the GitStudio status item calls the branch you are on. Free of `vscode`
// so it runs under plain tsx against a real repository (syncLabel.test.ts).
//
// It read RepoHead.branch — `git symbolic-ref --short HEAD` — which is git's
// shortest UNAMBIGUOUS name: beside a tag "release" the branch "release" is
// "heads/release", and the status bar said so (issue #30's follow-up). The
// item names the branch by the part under refs/heads/, like every other
// surface; the short form stays a revision for git, never a label.

/** The status item's branch text: the plain branch name, or a short sha
 *  marked detached. */
export function syncBranchLabel(head: RepoHead): string {
  const name = headBranchName(head);
  return name ?? `${head.sha.slice(0, 7)} (detached)`;
}
