import * as vscode from "vscode";
import {
  pullDetachedMessage,
  pullPauseMessage,
  type PullBlock,
  type PullDivergence,
  type PullMode,
  type PullStop,
} from "@gitstudio/git-service/SyncOps";
import { promptPick } from "../ui/dialogs";

/**
 * A pull whose merge or rebase STOPPED on conflicts — said plainly, with the
 * count, and the user taken to the Changes view, where the conflicted files
 * sit in their own group and open in the merge editor.
 *
 * Returns true when the result WAS a stop, and the caller must then not report
 * it as a failure: git's "Resolve all conflicts manually… git rebase
 * --continue" in an error toast — or, for a merge, which says CONFLICT on
 * stdout and nothing on stderr, a bare "pull failed" — is report #12's symptom
 * reached through the door built to close it. A warning, not an error, the
 * same tone the branch view's merge and rebase use when they hit conflicts:
 * nothing failed, a person has to choose.
 *
 * Shared by every pull door (the branch view's Update / Pull using Merge /
 * Pull using Rebase and the status bar's Sync and Pull), for the reason
 * `askPullMode` is: an answer settled inside one door is an answer the next
 * door gets wrong.
 */
export function settlePullStop(result: { stopped?: PullStop; blocked?: PullBlock }): boolean {
  // `blocked` is the same place reached the other way round: Pull pressed
  // AGAIN over the merge or rebase a stop left paused (the branch is still
  // ahead and behind, so every door still offers it). git refuses before doing
  // anything, and that refusal used to come back as git's "git add/rm" hint in
  // an error toast — or, from Update, as the divergence question all over again.
  const message = pullPauseMessage(result);
  if (!message) {
    return false;
  }
  void vscode.window.showWarningMessage(`GitStudio: ${message}`);
  void vscode.commands.executeCommand("gitstudio.commit.focus");
  return true;
}

const CHECK_OUT_BRANCH = "Check Out a Branch…";

/**
 * A pull on a DETACHED HEAD — a commit or a tag checked out — has no branch to
 * pull into. git fetches and then prints advice for a terminal ("You are not
 * currently on a branch… git pull <remote> <branch>"), which the status bar's
 * Sync and Pull used to show verbatim as an error. Nothing failed: say so
 * plainly, and offer the way on — the branch UI, where a branch is checked out.
 *
 * Returns true when the result WAS detached, and the caller must then not
 * report it as a failure. Shared by every extension pull door, as
 * `settlePullStop` is.
 */
export function settlePullDetached(
  result: { detached?: boolean },
  checkOut: () => unknown,
): boolean {
  if (!result.detached) {
    return false;
  }
  void vscode.window
    .showWarningMessage(`GitStudio: ${pullDetachedMessage()}`, CHECK_OUT_BRANCH)
    .then((pick) => {
      if (pick === CHECK_OUT_BRANCH) void checkOut();
    });
  return true;
}

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
