import * as vscode from "vscode";
import {
  divergedMessage,
  fetchPrHead,
  movePrBranch,
  planPrHead,
  type PrHeadPlan,
} from "@gitstudio/git-service/prCheckout";
import {
  addRemote,
  commitsWord,
  fetchPrBranch,
  freeBranchName,
  moveLocalBranch,
  newRemoteName,
  planPrBranch,
  prBranchElsewhere,
  remoteUrlLike,
  trackPrBranch,
  type PrBranchPlan,
  type PrBranchTarget,
} from "@gitstudio/git-service/prBranch";
import type { RepoEntry } from "../git/repoManager";
import type { PullRequest } from "./githubApi";
import { listGitHubRemotes, type GitHubRepoContext } from "./repoContext";
import { applyOrAsk, checkoutOp, type Applied } from "../git/inTheWay";
import { promptPick } from "../ui/dialogs";
import { saidCheckedOutElsewhere } from "../views/branchElsewhere";

// Checkout a pull request the way `gh pr checkout` does: onto its REAL head
// branch, tracking it where it lives, so a push from here reaches the pull
// request (git-service/prBranch.ts decides what that means for the branch
// already here). It used to make a `pr/<n>` copy with no upstream, and fixes
// made on it could never be pushed back.
//
// WHERE IT LIVES. A same-repository branch is fetched from the remote that
// names the pull request's repository; a fork's from the remote that names
// the fork — ADDED, named after its owner, when the clone has none (the
// toast says so). A remote added for a checkout that then fails is removed
// again.
//
// A BRANCH OF THAT NAME that isn't the pull request's (your `main` beside a
// fork's `main`, a same-named branch tracking something else) is never taken
// over without asking: Checkout as <owner>/<branch>, Use <branch>, or Cancel.
// One with commits the pull request doesn't have is never moved without
// asking either. A branch whose repository or branch is gone is checked out
// the old way, as pr/<n> at its last commit, and says a push can't reach it.
//
// Every step that touches the working tree goes through the in-the-way door
// (Stash & Retry over uncommitted work). The toast comes after the progress
// has ended: awaited inside it, the spinner ran until it was dismissed.

export interface CheckoutOptions {
  /** Called once the branch is checked out. */
  onCheckedOut?: () => void;
  /** Who is signed in to GitHub — says whether a push to a fork's branch will be taken. */
  viewer?: () => Promise<string | undefined>;
}

type Outcome =
  | { kind: "error"; message: string }
  | { kind: "planned"; plan: PrBranchPlan; target: PrBranchTarget; added?: string }
  | { kind: "copy"; plan: PrHeadPlan; why: string };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export async function checkoutPullRequest(ctx: GitHubRepoContext, pr: PullRequest, opts: CheckoutOptions = {}): Promise<void> {
  const { entry } = ctx;
  const n = pr.number;
  const baseRepo = `${ctx.owner}/${ctx.repo}`;
  const headRepo = pr.head.repoFullName;
  const sameRepo = !!headRepo && same(headRepo, baseRepo);

  // Its branch checked out in another worktree: said where, before anything
  // runs — no fetch for a checkout that can't happen here.
  if (headRepo) {
    const found = await remoteFor(entry, headRepo);
    if (found) {
      const t = { n, headRef: pr.head.ref, remote: found.name, remoteAliases: found.aliases, sameRepo, headOwner: headRepo.split("/")[0] ?? "" };
      if (await prBranchElsewhere(entry.ctx.process, t)) {
        await saidCheckedOutElsewhere(entry.ctx, `refs/heads/${pr.head.ref}`, "checkout");
        return;
      }
    }
  }

  const outcome = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Checking out PR #${n}…`, cancellable: true },
    async (_progress, token): Promise<Outcome> => {
      const ac = new AbortController();
      token.onCancellationRequested(() => ac.abort());
      const signal = ac.signal;
      if (!headRepo) return copy(ctx, n, `The repository PR #${n}'s branch came from is gone`, signal);

      // The remote that names the head's repository — added when there is none.
      const found = await remoteFor(entry, headRepo);
      let remote = found?.name;
      let added: string | undefined;
      if (!remote) {
        const made = await addHeadRemote(ctx, headRepo, sameRepo);
        if ("error" in made) return { kind: "error", message: `Couldn't check out PR #${n}: ${made.error}` };
        remote = added = made.name;
      }
      const target: PrBranchTarget = {
        n,
        headRef: pr.head.ref,
        remote,
        remoteAliases: found?.aliases ?? [],
        sameRepo,
        headOwner: headRepo.split("/")[0] ?? "",
      };
      const fetched = await fetchPrBranch(entry.ctx.process, target, { signal });
      if ("error" in fetched) {
        if (added) await entry.ctx.process.run(["remote", "remove", "--", added]).catch(() => undefined);
        if (fetched.gone) return copy(ctx, n, `${pr.head.ref} is gone from ${headRepo}`, signal);
        return { kind: "error", message: `Couldn't fetch PR #${n}'s branch from ${headRepo}: ${fetched.error}` };
      }
      return { kind: "planned", target, plan: await planPrBranch(entry.ctx.process, target, fetched.sha), ...(added ? { added } : {}) };
    },
  );
  if (outcome.kind === "error") {
    void vscode.window.showErrorMessage(outcome.message);
    return;
  }
  let done: string | undefined;
  if (outcome.kind === "copy") {
    done = await applyCopy(entry, pr, outcome.plan);
    if (done) done = `${outcome.why}, so it was checked out as ${outcome.plan.local} at its last commit — a push from there can't reach the pull request. ${done}`;
  } else {
    done = await land(entry, pr, outcome.target, outcome.plan);
    if (!done && outcome.added) await forgetUnused(entry, outcome.added);
    if (done && outcome.added) done += ` (Added the remote ${outcome.added} for ${headRepo}.)`;
    if (done && !sameRepo && !pr.maintainerCanModify) {
      const viewer = await opts.viewer?.().catch(() => undefined);
      if (viewer && headRepo && !same(viewer, outcome.target.headOwner)) {
        done += ` Its author doesn't let maintainers edit it, so a push to it will be refused.`;
      }
    }
  }
  if (!done) return;
  opts.onCheckedOut?.();
  const open = await vscode.window.showInformationMessage(done, "Open Pull Request");
  if (open === "Open Pull Request") {
    // With its repository: the toast waits until clicked, and a number alone
    // is resolved against the repository active THEN — #7 of another one.
    void vscode.commands.executeCommand("gitstudio.pr.openDescription", { pr, ctx });
  }
}

/** The clone's remote for `owner/repo`, and every other name its config may use for it. */
async function remoteFor(entry: RepoEntry, repo: string): Promise<{ name: string; aliases: string[] } | undefined> {
  const github = await listGitHubRemotes(entry);
  const named = github.filter((r) => same(`${r.owner}/${r.repo}`, repo));
  if (named.length === 0) return undefined;
  const all = await entry.ctx.remotes.list().catch(() => []);
  const urls = all.filter((r) => named.some((x) => x.name === r.name)).flatMap((r) => [r.fetchUrl, r.pushUrl]);
  return {
    name: named[0].name,
    aliases: [...named.map((r) => r.name), ...urls, `https://github.com/${repo}.git`, `https://github.com/${repo}`, `git@github.com:${repo}.git`],
  };
}

/**
 * The remote added for a checkout that didn't happen (cancelled, refused):
 * removed again, unless a branch has come to track it meanwhile. "Cancel —
 * nothing changes" stays true.
 */
async function forgetUnused(entry: RepoEntry, remote: string): Promise<void> {
  const cfg = await entry.ctx.process.run(["config", "--get-regexp", "^branch\\..*\\.remote$"]).catch(() => undefined);
  const used = (cfg?.stdout ?? "").split("\n").some((l) => l.trim().split(/\s+/)[1] === remote);
  if (!used) await entry.ctx.process.run(["remote", "remove", "--", remote]).catch(() => undefined);
}

/**
 * A remote for the head's repository: named after its owner (`upstream` for
 * the pull request's own repository), with a URL in the clone's own way of
 * talking to GitHub.
 */
async function addHeadRemote(ctx: GitHubRepoContext, repo: string, sameRepo: boolean): Promise<{ name: string } | { error: string }> {
  const [owner, name] = repo.split("/");
  const remotes = await ctx.entry.ctx.remotes.list().catch(() => []);
  const like = (remotes.find((r) => r.name === ctx.remoteName) ?? remotes.find((r) => r.name === "origin") ?? remotes[0])?.fetchUrl;
  const url = owner && name ? remoteUrlLike(like, owner, name) : undefined;
  const remote = newRemoteName(sameRepo ? "upstream" : (owner ?? ""), remotes.map((r) => r.name));
  if (!url || !remote) return { error: `"${repo}" isn't a repository GitStudio can add as a remote.` };
  const r = await addRemote(ctx.entry.ctx.process, remote, url);
  return r.code === 0 ? { name: remote } : { error: `git couldn't add the remote ${remote}: ${firstLine(r.stderr)}` };
}

/** The head is gone: its last commit, as pr/<n>, from the pull request's repository. */
async function copy(ctx: GitHubRepoContext, n: number, why: string, signal: AbortSignal): Promise<Outcome> {
  const fetched = await fetchPrHead(ctx.entry.ctx.process, ctx.remoteName, n, { signal });
  if ("error" in fetched) return { kind: "error", message: `${why}, and PR #${n}'s last commit couldn't be fetched: ${fetched.error}` };
  return { kind: "copy", why, plan: await planPrHead(ctx.entry.ctx.process, n, fetched.sha) };
}

/**
 * Bring the local branch to the plan and check it out. Returns the sentence
 * to tell the user, or undefined when there is nothing more to say
 * (cancelled, or already said).
 */
async function land(entry: RepoEntry, pr: PullRequest, target: PrBranchTarget, plan: PrBranchPlan, asked = false): Promise<string | undefined> {
  const n = pr.number;
  const { local, trackingName } = plan;
  const tracking = `tracking ${trackingName}`;
  // A branch named unlike the one it tracks (alice-main for alice's main):
  // git's default push (push.default=simple) refuses it, so say how it goes.
  const how = local === target.headRef ? "" : ` ${pushHint(target)}`;
  switch (plan.kind) {
    case "elsewhere":
      if (!(await saidCheckedOutElsewhere(entry.ctx, plan.ref, "checkout"))) {
        void vscode.window.showWarningMessage(
          `${local} is checked out in another worktree (${plan.worktree}). Switch to it there, or check out a different branch in that worktree first.`,
        );
      }
      return undefined;

    case "create": {
      const applied = await applyOrAsk(entry.ctx, checkoutOp(["checkout", "-b", local, plan.sha]));
      if (settled(applied, n)) return undefined;
      return (await tracked(entry, target, plan)) ?? `Checked out PR #${n} as ${local}, ${tracking}.${how}`;
    }

    case "current": {
      if (!plan.checkedOut) {
        const applied = await applyOrAsk(entry.ctx, checkoutOp(["checkout", local]));
        if (settled(applied, n)) return undefined;
      }
      const failed = await tracked(entry, target, plan);
      if (failed) return failed;
      if (plan.checkedOut) return `You're already on ${local}, the branch of PR #${n}${plan.setUpstream ? `; it now tracks ${trackingName}` : ""}.${how}`;
      return `Checked out PR #${n} as ${local}, ${tracking}.${how}`;
    }

    case "fast-forward": {
      if (plan.checkedOut) {
        // The branch is HEAD: its working tree moves with it, so this is a
        // fast-forward merge, through the door like any other.
        const applied = await applyOrAsk(entry.ctx, { kind: "merge", target: plan.sha, args: ["merge", "--ff-only", plan.sha] });
        if (settled(applied, n)) return undefined;
        return (await tracked(entry, target, plan)) ?? `Updated ${local} to the latest of PR #${n} (${commitsWord(plan.behind)} brought in).${how}`;
      }
      const moved = await moveLocalBranch(entry.ctx.process, plan, `update ${local} to pull request #${n}`);
      if (moved.code !== 0) {
        void vscode.window.showErrorMessage(`Couldn't update ${local}: ${firstLine(moved.stderr)}`);
        return undefined;
      }
      const applied = await applyOrAsk(entry.ctx, checkoutOp(["checkout", local]));
      if (settled(applied, n)) return undefined;
      return (await tracked(entry, target, plan)) ?? `Checked out PR #${n} as ${local}, updated to its latest and ${tracking}.${how}`;
    }

    case "ahead": {
      if (!plan.checkedOut) {
        const applied = await applyOrAsk(entry.ctx, checkoutOp(["checkout", local]));
        if (settled(applied, n)) return undefined;
      }
      const failed = await tracked(entry, target, plan);
      if (failed) return failed;
      const yours = `${commitsWord(plan.ahead)} of yours ${plan.ahead === 1 ? "isn't" : "aren't"} pushed to it yet`;
      return plan.checkedOut ? `You're on ${local}, the branch of PR #${n}: ${yours}.${how}` : `Checked out PR #${n} as ${local}, ${tracking}: ${yours}.${how}`;
    }

    case "diverged": {
      const choice = await promptPick({
        title: `${local} has commits that PR #${n} doesn't`,
        hint:
          `${local} has ${commitsWord(plan.ahead)} that ${trackingName} doesn't, and ${trackingName} has ${commitsWord(plan.behind)} that ${local} doesn't — ` +
          `made here, or from before the pull request was force-pushed.`,
        choices: [
          {
            id: "keep",
            label: plan.checkedOut ? `Stay on ${local} as it is` : `Checkout ${local} as it is`,
            icon: "git-branch",
            description: "Your commits stay. The pull request's newer commits aren't brought in: pull to merge them.",
          },
          ...(plan.checkedOut
            ? []
            : [
                {
                  id: "replace",
                  label: `Reset ${local} to the pull request's version`,
                  icon: "warning",
                  danger: true,
                  description: `${local}'s own commits stay only in the reflog.`,
                },
              ]),
          { id: "cancel", label: "Cancel", icon: "close", description: "Nothing changes." },
        ],
      });
      if (choice === "keep") {
        if (plan.checkedOut) return undefined;
        const applied = await applyOrAsk(entry.ctx, checkoutOp(["checkout", local]));
        if (settled(applied, n)) return undefined;
        return (await tracked(entry, target, plan)) ?? `Checked out ${local} as it was (not updated to PR #${n}).`;
      }
      if (choice === "replace") {
        const moved = await moveLocalBranch(entry.ctx.process, plan, `reset ${local} to pull request #${n}`);
        if (moved.code !== 0) {
          void vscode.window.showErrorMessage(`Couldn't move ${local}: ${firstLine(moved.stderr)}`);
          return undefined;
        }
        const applied = await applyOrAsk(entry.ctx, checkoutOp(["checkout", local]));
        if (settled(applied, n)) return undefined;
        return (await tracked(entry, target, plan)) ?? `Checked out PR #${n} as ${local}, ${tracking}.`;
      }
      return undefined;
    }

    case "taken": {
      if (asked) return undefined;
      const alt = await freeBranchName(entry.ctx.process, target);
      const useWords: Record<string, string> = {
        same: `It is at the pull request's latest. It will track ${trackingName}.`,
        behind: `Brings in the pull request's ${commitsWord(plan.behind)} (a fast-forward). It will track ${trackingName}.`,
        ahead: `It has ${commitsWord(plan.ahead)} the pull request doesn't. It will track ${trackingName}, so a push adds them to it.`,
      };
      const choice = await promptPick({
        title: `There's already a branch named ${local}`,
        hint:
          `${local} tracks ${plan.tracksName ?? "no remote branch"} — it isn't ${trackingName}, the branch of PR #${n}.` +
          (plan.worktree ? ` It is checked out in the worktree at ${plan.worktree}.` : ""),
        choices: [
          ...(alt
            ? [{ id: "alt", label: `Checkout as ${alt}`, icon: "git-branch", description: `A new branch, ${tracking}. ${pushHint(target)}` }]
            : []),
          ...(plan.relation && plan.relation !== "diverged" && !plan.worktree
            ? [{ id: "use", label: `Use ${local}`, icon: "arrow-swap", description: useWords[plan.relation] }]
            : []),
          { id: "cancel", label: "Cancel", icon: "close", description: "Nothing changes." },
        ],
      });
      if (choice === "alt" && alt) {
        return land(entry, pr, target, await planPrBranch(entry.ctx.process, target, plan.sha, alt), true);
      }
      if (choice === "use" && plan.relation && plan.relation !== "diverged" && !plan.worktree) {
        const kind = plan.relation === "same" ? "current" : plan.relation === "behind" ? "fast-forward" : "ahead";
        return land(entry, pr, target, { ...plan, kind, tracks: "pr", setUpstream: true }, true);
      }
      return undefined;
    }
  }
}

/** Point the branch at the pull request's, when the plan says to; the sentence when that failed. */
async function tracked(entry: RepoEntry, target: PrBranchTarget, plan: PrBranchPlan): Promise<string | undefined> {
  if (!plan.setUpstream) return undefined;
  const r = await trackPrBranch(entry.ctx.process, target, plan.local);
  if (r.code === 0) return undefined;
  return `Checked out ${plan.local}, but couldn't make it track ${plan.trackingName}: ${firstLine(r.stderr)}`;
}

/**
 * The old way, for a head that is gone: pr/<n> at the pull request's last
 * commit (refs/pull/<n>/head). Returns the sentence, or undefined.
 */
async function applyCopy(entry: RepoEntry, pr: PullRequest, plan: PrHeadPlan): Promise<string | undefined> {
  const n = pr.number;
  const { local } = plan;
  switch (plan.kind) {
    case "elsewhere":
      if (!(await saidCheckedOutElsewhere(entry.ctx, `refs/heads/${local}`, "checkout"))) {
        void vscode.window.showWarningMessage(`${local} is checked out in another worktree (${plan.worktree}).`);
      }
      return undefined;
    case "create": {
      const applied = await applyOrAsk(entry.ctx, checkoutOp(["checkout", "-b", local, plan.sha]));
      return settled(applied, n) ? undefined : `Checked out PR #${n} as ${local}.`;
    }
    case "current": {
      if (plan.checkedOut) return `${local} is checked out and already matches PR #${n}.`;
      const applied = await applyOrAsk(entry.ctx, checkoutOp(["checkout", local]));
      return settled(applied, n) ? undefined : `Checked out PR #${n} as ${local}.`;
    }
    case "fast-forward": {
      if (plan.checkedOut) {
        const applied = await applyOrAsk(entry.ctx, { kind: "merge", target: plan.sha, args: ["merge", "--ff-only", plan.sha] });
        return settled(applied, n) ? undefined : `Updated ${local} to the latest of PR #${n}.`;
      }
      const moved = await movePrBranch(entry.ctx.process, plan);
      if (moved.code !== 0) {
        void vscode.window.showErrorMessage(`Couldn't update ${local}: ${firstLine(moved.stderr)}`);
        return undefined;
      }
      const applied = await applyOrAsk(entry.ctx, checkoutOp(["checkout", local]));
      return settled(applied, n) ? undefined : `Checked out PR #${n} as ${local}, updated to its latest.`;
    }
    case "diverged": {
      const choice = await promptPick({
        title: `${local} has commits that PR #${n} doesn't`,
        hint: divergedMessage(n, plan),
        choices: [
          { id: "keep", label: `Checkout ${local} as it is`, icon: "git-branch", description: "Your commits stay. The PR's newer commits aren't brought in." },
          { id: "cancel", label: "Cancel", icon: "close", description: "Nothing changes." },
        ],
      });
      if (choice !== "keep" || plan.checkedOut) return undefined;
      const applied = await applyOrAsk(entry.ctx, checkoutOp(["checkout", local]));
      return settled(applied, n) ? undefined : `Checked out ${local} as it was (not updated to PR #${n}).`;
    }
  }
}

/**
 * How a branch named unlike the one it tracks reaches the pull request:
 * GitStudio's Push sends it to the branch it tracks; git's own `git push`
 * (push.default=simple) refuses a branch whose name differs, and takes the
 * destination spelled out.
 */
function pushHint(t: Pick<PrBranchTarget, "remote" | "headRef">): string {
  return `GitStudio's Push reaches the pull request; from a terminal, git push ${t.remote} HEAD:${t.headRef}.`;
}

/** True when the door already said everything (cancelled, refused, failed). */
function settled(applied: Applied, n: number): boolean {
  if (applied.cancelled || applied.settled) {
    return true;
  }
  if (applied.result.code !== 0) {
    void vscode.window.showErrorMessage(`Couldn't check out PR #${n}: ${firstLine(applied.result.stderr)}`);
    return true;
  }
  return false;
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? text;
  return line.trim();
}
