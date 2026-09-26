import * as vscode from "vscode";
import { promptConfirm, promptInput, promptPick } from "../ui/dialogs";
import type { GitContext } from "@gitstudio/git-service/index";
import type { RepoManager } from "../git/repoManager";
import type { GitBrain } from "../ai/gitBrain";
import { GitHubApi, GitHubApiError, type CreatePrInput, type PullRequest } from "./githubApi";
import { listGitHubRemotes, resolveGitHubContext } from "./repoContext";
import { PrDescriptionPanel } from "./prDescriptionPanel";

// Create a pull request without leaving the editor. The flow:
//   1. Resolve the GitHub repo + the current branch; ensure it's pushed (offer
//      to push w/ upstream when it isn't tracked / is ahead).
//   2. Pick the base branch (default the repo's default branch).
//   3. Prefill the title as GitHub does — a single commit's subject, else the
//      branch name in words — and the body from the commit list; offer an ✨
//      AI-drafted body when GitBrain is enabled.
//   4. Choose draft vs. ready, POST /pulls, and open the new PR's description.
// "PR already exists" (422) opens the PR that exists.
//
// WHERE THE BRANCH LIVES. It is pushed to the remote git pushes it to
// (branch.<b>.pushRemote, remote.pushDefault, branch.<b>.remote — the target
// repository's remote only when none is set), under ITS OWN NAME, and when
// that remote is another repository on GitHub (your fork), the PR's head is
// `owner:branch`: GitHub reads a bare branch name as one in the TARGET
// repository.
//
// Its own name, not the one it tracks: `git checkout -b feature origin/main`
// makes feature TRACK main, and the push used to follow that into origin's
// main — the PR's commits landed on the base branch, and the PR was sent as
// main into main. git's own push.default=simple refuses that push; a PR's head
// is the branch's own. The push is an explicit refspec to that remote, and
// "already pushed" is read from <remote>/<branch>, not from @{u}.

export async function createPullRequest(
  repos: RepoManager,
  brain: GitBrain,
  api: GitHubApi,
  extensionUri: vscode.Uri,
  onCreated?: (pr: PullRequest) => void,
): Promise<void> {
  const ctx = await resolveGitHubContext(repos);
  if (!ctx) {
    void vscode.window.showInformationMessage(
      "This repository isn't connected to GitHub. Add a github.com remote to create pull requests.",
    );
    return;
  }
  const { entry } = ctx;

  // Current branch.
  const headBranch = await currentBranch(entry.ctx);
  if (!headBranch) {
    void vscode.window.showWarningMessage(
      "Can't create a PR from a detached HEAD. Check out a branch first.",
    );
    return;
  }

  // Ensure the branch is published where the PR will say it is. When it isn't
  // there, or is ahead of it, offer to push it there.
  const where = await headLocation(entry.ctx, ctx.remoteName, headBranch);
  const pushed = await ensurePushed(entry.ctx, where, headBranch);
  if (!pushed) {
    return;
  }
  const remotes = await listGitHubRemotes(entry);
  const headOwner = remotes.find((r) => r.name === where.remote)?.owner;
  const head =
    headOwner && headOwner.toLowerCase() !== ctx.owner.toLowerCase()
      ? `${headOwner}:${where.branch}`
      : where.branch;

  // Base branch: default branch first, then other local heads.
  const base = await pickBase(entry.ctx, api, ctx.owner, ctx.repo, ctx.remoteName, headBranch);
  if (!base) {
    return;
  }

  // Commit list base..head, for the title + body.
  const commits = await commitSubjects(entry.ctx, ctx.remoteName, base, headBranch);
  const defaultTitle = defaultPrTitle(commits, headBranch);

  const title = await promptInput({
    title: "Pull request title",
    hint: `Merging ${headBranch} into ${base}.`,
    value: defaultTitle,
    confirmLabel: "Continue",
    validate: "nonEmpty",
  });
  if (title === undefined || title.trim().length === 0) {
    return;
  }

  // Body: a commit checklist by default; offer an AI draft when enabled.
  let body = commits.length > 0 ? commits.map((c) => `- ${c}`).join("\n") : "";
  if (await brain.isEnabled()) {
    const choice = await promptPick({
      title: "How should we fill the description?",
      choices: [
        { id: "commits", label: "Commit List", icon: "list-unordered", description: "One bullet per commit in the range." },
        { id: "ai", label: "AI Draft", icon: "sparkle", description: "Summarize what the change actually does." },
        { id: "empty", label: "Empty", icon: "circle-slash", description: "Start from a blank body." },
      ],
    });
    if (!choice) {
      return;
    }
    if (choice === "ai") {
      const drafted = await draftWithAi(brain, entry.ctx, ctx.remoteName, base, headBranch, commits);
      if (drafted) {
        body = drafted;
      }
    } else if (choice === "empty") {
      body = "";
    }
  }

  const editedBody = await promptInput({
    title: "Pull request description",
    hint: "Optional. Markdown is fine — Ctrl/Cmd+Enter to continue.",
    value: body,
    multiline: true,
    confirmLabel: "Continue",
  });
  if (editedBody === undefined) {
    return;
  }

  const draftPick = await promptPick({
    title: "Open as a draft?",
    choices: [
      { id: "ready", label: "Ready for Review", icon: "git-pull-request", description: "Open for review; it can be merged once the repository's rules are met." },
      { id: "draft", label: "Draft", icon: "git-pull-request-draft", description: "Signals work in progress; cannot be merged until marked ready." },
    ],
  });
  if (!draftPick) {
    return;
  }

  const input: CreatePrInput = {
    title: title.trim(),
    head,
    base,
    body: editedBody,
    // promptPick answers with the choice's id — "draft", never its label.
    draft: draftPick === "draft",
  };

  const outcome = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Creating pull request…" },
    async (): Promise<
      { kind: "created"; pr: PullRequest } | { kind: "exists"; pr?: PullRequest; message: string } | { kind: "failed"; message: string }
    > => {
      try {
        return { kind: "created", pr: await api.createPull(ctx.owner, ctx.repo, input) };
      } catch (err) {
        if (err instanceof GitHubApiError && err.kind === "validation" && /already exists/i.test(err.message)) {
          // Find the PR that exists, so the answer is that PR — not the list.
          const existing = await api
            .findOpenPullForHead(ctx.owner, ctx.repo, head.includes(":") ? head : `${ctx.owner}:${head}`)
            .catch(() => undefined);
          return { kind: "exists", pr: existing, message: err.message };
        }
        const msg = err instanceof GitHubApiError ? err.message : "Couldn't create the pull request.";
        return { kind: "failed", message: msg };
      }
    },
  );

  if (outcome.kind === "created") {
    onCreated?.(outcome.pr);
    await PrDescriptionPanel.show({ api, ctx, extensionUri }, outcome.pr);
    void vscode.window.showInformationMessage(
      `Created ${input.draft ? "draft " : ""}PR #${outcome.pr.number}.`,
    );
    return;
  }
  if (outcome.kind === "exists" && outcome.pr) {
    void vscode.window.showInformationMessage(
      `${where.branch} already has an open pull request: #${outcome.pr.number}.`,
    );
    await PrDescriptionPanel.show({ api, ctx, extensionUri }, outcome.pr);
    return;
  }
  void vscode.window.showErrorMessage(`GitHub couldn't create the PR: ${outcome.message}`);
}

/**
 * The title GitHub itself proposes: the subject of the branch's only commit,
 * or — with several — the branch name in words ("fix-login_page" → "Fix login
 * page"). `commits` is `git log` order, newest first: its first entry, used
 * before, was the LAST commit's subject, standing for the whole branch.
 */
export function defaultPrTitle(commits: readonly string[], branch: string): string {
  if (commits.length === 1) {
    return commits[0];
  }
  const words = branch.replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : branch;
}

/** Where the PR's branch is (or will be) pushed: a remote, and its name there. */
interface HeadLocation {
  remote: string;
  branch: string;
}

/**
 * Where the branch is (or will be) pushed — git's own push-remote rule — and
 * its name there: its own. The name it TRACKS is not a candidate: a branch
 * started from origin/main tracks main, and that is the PR's base, never its
 * head (see the note at the top).
 */
async function headLocation(
  ctx: GitContext,
  fallbackRemote: string,
  branch: string,
): Promise<HeadLocation> {
  // A value that reads as an option is no remote name: it never reaches git's
  // command line (the push takes the remote as an argument).
  const get = async (key: string): Promise<string | undefined> => {
    const r = await ctx.process.run(["config", "--get", key]);
    const v = r.stdout.trim();
    return r.code === 0 && v && !v.startsWith("-") ? v : undefined;
  };
  const tracking = await get(`branch.${branch}.remote`);
  const remote =
    (await get(`branch.${branch}.pushRemote`)) ??
    (await get("remote.pushDefault")) ??
    (tracking && tracking !== "." ? tracking : undefined) ??
    fallbackRemote;
  return { remote, branch };
}

async function currentBranch(ctx: GitContext): Promise<string | undefined> {
  const r = await ctx.process.run(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (r.code !== 0) {
    return undefined;
  }
  const name = r.stdout.trim();
  return name && name !== "HEAD" ? name : undefined;
}

/**
 * Is `branch` on `where` with nothing unpushed? If not, ask, and push it
 * there — exactly there. Compared with `<remote>/<branch>` as last fetched or
 * pushed, not with @{u}: the upstream may be the base branch it was started
 * from, which it is always ahead of.
 */
async function ensurePushed(
  ctx: GitContext,
  where: HeadLocation,
  branch: string,
): Promise<boolean> {
  const there = `refs/remotes/${where.remote}/${where.branch}`;
  const known = (await ctx.process.run(["rev-parse", "--verify", "--quiet", `${there}^{commit}`])).code === 0;
  let ahead = 0;
  if (known) {
    const r = await ctx.process.run(["rev-list", "--count", `${there}..refs/heads/${branch}`]);
    ahead = r.code === 0 ? Number(r.stdout.trim()) || 0 : 1;
    if (r.code === 0 && ahead === 0) {
      return true; // already there, nothing unpushed.
    }
  }

  const prompt = known
    ? `Your branch is ${ahead} commit(s) ahead of ${where.remote}/${where.branch}. Push before creating the PR?`
    : `Branch "${branch}" hasn't been pushed to ${where.remote} yet. Push it now?`;
  const ok = await promptConfirm({
    title: "Push before creating the pull request?",
    message: prompt,
    confirmLabel: "Push",
  });
  if (!ok) {
    return false;
  }

  // A branch that tracks nothing starts tracking what it is published as; one
  // that tracks something (the base it was started from, in a triangular
  // setup) keeps it — that is the user's pull, not ours to change.
  const tracks = (await ctx.process.run(["config", "--get", `branch.${branch}.merge`])).code === 0;
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Pushing ${branch}…` },
    () =>
      // push-force-reviewed: publishes the PR's branch, or adds commits to it
      // — a fast-forward, which git refuses rather than overwrite anything.
      ctx.sync.push({
        remote: where.remote,
        branch,
        dest: where.branch,
        setUpstream: !tracks,
      }),
  );
  if (!result.ok) {
    void vscode.window.showErrorMessage(
      `Push failed: ${result.stderr.split("\n")[0] ?? "unknown error"}`,
    );
    return false;
  }
  return true;
}

async function pickBase(
  git: GitContext,
  api: GitHubApi,
  owner: string,
  repo: string,
  remote: string,
  headBranch: string,
): Promise<string | undefined> {
  // The repo's default branch is the best base default; fall back to "main".
  const defaultBranch = (await api.defaultBranch(owner, repo)) ?? "main";
  // Offer the default + those of the common names the remote actually has
  // (as last fetched), plus a free-text entry. A name offered because it is
  // common, on a remote without it, was a 422 waiting to happen.
  const common: string[] = [];
  for (const b of ["main", "master", "develop"]) {
    const r = await git.process.run(["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${b}`]);
    if (r.code === 0) {
      common.push(b);
    }
  }
  const candidates = Array.from(
    new Set([defaultBranch, ...common].filter((b) => b !== headBranch)),
  );
  const OTHER = "gitstudio:other";
  const pick = await promptPick({
    title: `Base branch to merge "${headBranch}" into`,
    // Which repository the PR opens on is the Pull Requests view's: said here
    // too, where it is decided.
    hint: `The pull request opens on ${owner}/${repo}.`,
    choices: [
      ...candidates.map((b) => ({
        id: b,
        label: b,
        icon: "git-branch",
        detail: b === defaultBranch ? "default" : undefined,
      })),
      { id: OTHER, label: "Other…", icon: "edit", description: "Type a base branch name." },
    ],
  });
  if (!pick) {
    return undefined;
  }
  if (pick === OTHER) {
    const typed = await promptInput({
      title: "Base branch name",
      value: defaultBranch,
      confirmLabel: "Use This Base",
      validate: "refName",
    });
    return typed?.trim() || undefined;
  }
  return pick;
}

async function commitSubjects(
  ctx: GitContext,
  remote: string,
  base: string,
  head: string,
): Promise<string[]> {
  // base..head, preferring the remote-tracking base so the range matches the PR.
  const range = `${remote}/${base}..${head}`;
  let r = await ctx.process.run(["log", "--format=%s", range]);
  if (r.code !== 0) {
    // Fall back to the local base ref.
    r = await ctx.process.run(["log", "--format=%s", `${base}..${head}`]);
  }
  if (r.code !== 0) {
    return [];
  }
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

async function draftWithAi(
  brain: GitBrain,
  ctx: GitContext,
  remote: string,
  base: string,
  head: string,
  commits: string[],
): Promise<string | undefined> {
  let diff = "";
  let r = await ctx.process.run(["diff", `${remote}/${base}...${head}`]);
  if (r.code !== 0) {
    r = await ctx.process.run(["diff", `${base}...${head}`]);
  }
  if (r.code === 0) {
    diff = r.stdout;
  }
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Drafting description with AI…" },
    async () => {
      const drafted = await brain.generatePrDescription(commits, diff);
      return drafted ?? undefined;
    },
  );
}
