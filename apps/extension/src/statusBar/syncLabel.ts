import type { RepoHead } from "@gitstudio/host-bridge/git";
import { headBranchName } from "@gitstudio/git-service/RefProvider";
import * as l10n from "@vscode/l10n";

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
  return name ?? l10n.t("{0} (detached)", head.sha.slice(0, 7));
}

const count = (n: number, one: string, many: string): string => l10n.t("{0} {1}", n, n === 1 ? one : many);
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
    parts.push(l10n.t("not published"));
  } else if (!s.detachedAt) {
    if (s.behind > 0) parts.push(s.behind === 1 ? l10n.t("1 commit to pull") : l10n.t("{0} commits to pull", s.behind));
    if (s.ahead > 0) parts.push(s.ahead === 1 ? l10n.t("1 commit to push") : l10n.t("{0} commits to push", s.ahead));
    if (s.behind === 0 && s.ahead === 0) parts.push(l10n.t("nothing to pull or push"));
  }
  if (s.dirty > 0) parts.push(count(s.dirty, l10n.t("changed file"), l10n.t("changed files")));
  const what = s.detachedAt ? l10n.t("Detached HEAD at {0}", s.detachedAt) : l10n.t("Branch {0}", s.branch);
  return l10n.t("{0}{1}. Opens the branch menu.", what, parts.length ? `: ${parts.join(", ")}` : "");
}
