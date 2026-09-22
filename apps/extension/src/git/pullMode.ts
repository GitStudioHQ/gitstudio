import type { PullDivergence, PullMode } from "@gitstudio/git-service/SyncOps";
import { promptPick } from "../ui/dialogs";

/**
 * The choice git itself asks for when a branch and its upstream have both
 * moved — asked as a question instead of printed as `git config` advice.
 *
 * Report #12: a user pressed Pull on a diverged branch and what reached them
 * was git's terminal advice — "You have divergent branches and need to specify
 * how to reconcile them", then three `git config` lines. `SyncOps.pull` now
 * answers that state with a `diverged` fact; this is the question to ask about
 * it, and whatever is picked goes to git as a flag on that one pull. Nothing is
 * written to the user's config: "remember this" is a setting, and a setting is
 * something to ask for.
 *
 * It lives here rather than inside either caller for the reason
 * `askForCommitAction` was lifted out of the context menu. The branch view's
 * "Update (pull)" and the status bar's Sync are two doors onto the same
 * operation, and a question that lives inside one door is a question the other
 * does not ask. A third door cannot be added without finding this.
 *
 * `undefined` means the user backed out — nothing should run.
 */
export async function askPullMode(
  d: PullDivergence,
): Promise<Exclude<PullMode, "ff-only"> | undefined> {
  const n = (c: number): string => `${c} commit${c === 1 ? "" : "s"}`;
  const choice = await promptPick({
    title: `'${d.branch}' and ${d.upstream} have diverged`,
    hint:
      `You have ${n(d.ahead)} ${d.upstream} doesn't, and it has ${n(d.behind)} you don't. ` +
      "Git needs to know how to combine them — this applies to this pull only.",
    choices: [
      {
        id: "merge",
        label: "Merge",
        icon: "git-merge",
        description:
          "Bring their commits in and record a merge commit. Yours keep their shas.",
      },
      {
        id: "rebase",
        label: "Rebase",
        icon: "git-pull-request",
        description:
          "Replay your commits on top of theirs. Linear history, new shas.",
      },
    ],
  });
  return choice === "merge" || choice === "rebase" ? choice : undefined;
}
