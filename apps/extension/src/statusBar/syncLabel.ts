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

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** What the status item's icons and numbers say, in words, for a screen reader. */
export function syncAccessibleLabel(s: {
  branch: string;
  /**
   * HEAD is detached, at this short sha. There is no branch then, so nothing
   * is "not published": it reads "Detached HEAD at abc1234".
   */
  detachedAt?: string;
  /** Whether the branch tracks an upstream (else it is not published). */
  upstream: boolean;
  ahead: number;
  behind: number;
  /** Files changed since HEAD, staged or not. */
  dirty: number;
}): string {
  const parts: string[] = [];
  // A detached HEAD has no branch: nothing to publish, pull or push.
  if (!s.detachedAt && !s.upstream) {
    parts.push("not published");
  } else if (!s.detachedAt) {
    if (s.behind > 0) parts.push(`${count(s.behind, "commit", "commits")} to pull`);
    if (s.ahead > 0) parts.push(`${count(s.ahead, "commit", "commits")} to push`);
    if (s.behind === 0 && s.ahead === 0) parts.push("nothing to pull or push");
  }
  if (s.dirty > 0) parts.push(count(s.dirty, "changed file", "changed files"));
  const what = s.detachedAt ? `Detached HEAD at ${s.detachedAt}` : `Branch ${s.branch}`;
  return `${what}${parts.length ? `: ${parts.join(", ")}` : ""}. Opens the branch menu.`;
}
