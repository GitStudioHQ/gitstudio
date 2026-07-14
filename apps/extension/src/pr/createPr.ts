import * as vscode from "vscode";
import type { GitContext } from "@gitstudio/git-service/index";
import type { RepoManager } from "../git/repoManager";
import type { GitBrain } from "../ai/gitBrain";
import { GitHubApi, GitHubApiError, type CreatePrInput } from "./githubApi";
import { resolveGitHubContext } from "./repoContext";
import { PrDescriptionPanel } from "./prDescriptionPanel";

// Create a pull request without leaving the editor. The flow:
//   1. Resolve the GitHub repo + the current branch; ensure it's pushed (offer
//      to push w/ upstream when it isn't tracked / is ahead).
//   2. Pick the base branch (default the repo's default branch).
//   3. Prefill title from the last commit subject, body from the commit list;
//      offer an ✨ AI-drafted body when GitBrain is enabled.
//   4. Choose draft vs. ready, POST /pulls, and open the new PR's description.
// "PR already exists" (422) is surfaced gracefully.

export async function createPullRequest(
  repos: RepoManager,
  brain: GitBrain,
  api: GitHubApi,
  extensionUri: vscode.Uri,
  onCreated?: () => void,
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

  // Ensure the branch is published. If it has no upstream or is ahead, offer
  // to push with --set-upstream.
  const pushed = await ensurePushed(entry.ctx, ctx.remoteName, headBranch);
  if (!pushed) {
    return;
  }

  // Base branch: default branch first, then other local heads.
  const base = await pickBase(api, ctx.owner, ctx.repo, headBranch);
  if (!base) {
    return;
  }

  // Commit list base..head, for the title + body.
  const commits = await commitSubjects(entry.ctx, ctx.remoteName, base, headBranch);
  const defaultTitle = commits[0] ?? headBranch;

  const title = await vscode.window.showInputBox({
    prompt: "Pull request title",
    value: defaultTitle,
  });
  if (title === undefined || title.trim().length === 0) {
    return;
  }

  // Body: a commit checklist by default; offer an AI draft when enabled.
  let body = commits.length > 0 ? commits.map((c) => `- ${c}`).join("\n") : "";
  if (await brain.isEnabled()) {
    const choice = await vscode.window.showQuickPick(
      [
        { label: "$(list-unordered) Use commit list", value: "commits" },
        { label: "$(sparkle) AI draft", value: "ai" },
        { label: "$(edit) Empty / write my own", value: "empty" },
      ],
      { placeHolder: "How should we fill the description?" },
    );
    if (!choice) {
      return;
    }
    if (choice.value === "ai") {
      const drafted = await draftWithAi(brain, entry.ctx, ctx.remoteName, base, headBranch, commits);
      if (drafted) {
        body = drafted;
      }
    } else if (choice.value === "empty") {
      body = "";
    }
  }

  const editedBody = await vscode.window.showInputBox({
    prompt: "Pull request description (optional)",
    value: body,
  });
  if (editedBody === undefined) {
    return;
  }

  const draftPick = await vscode.window.showQuickPick(
    [
      { label: "$(git-pull-request) Ready for review", value: false },
      { label: "$(git-pull-request-draft) Draft", value: true },
    ],
    { placeHolder: "Open as a draft?" },
  );
  if (!draftPick) {
    return;
  }

  const input: CreatePrInput = {
    title: title.trim(),
    head: headBranch,
    base,
    body: editedBody,
    draft: draftPick.value,
  };

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Creating pull request…" },
    async () => {
      try {
        const pr = await api.createPull(ctx.owner, ctx.repo, input);
        onCreated?.();
        const panel = await PrDescriptionPanel.show(
          { api, ctx, extensionUri },
          pr,
        );
        void panel;
        void vscode.window.showInformationMessage(
          `Created PR #${pr.number}.`,
        );
      } catch (err) {
        if (err instanceof GitHubApiError && err.kind === "validation") {
          // The most common 422 is "a pull request already exists".
          const open = await vscode.window.showWarningMessage(
            `GitHub couldn't create the PR: ${err.message}`,
            "Open on GitHub",
          );
          if (open === "Open on GitHub") {
            void vscode.env.openExternal(
              vscode.Uri.parse(
                `https://github.com/${ctx.owner}/${ctx.repo}/pulls`,
              ),
            );
          }
          return;
        }
        const msg = err instanceof GitHubApiError ? err.message : "Couldn't create the pull request.";
        void vscode.window.showErrorMessage(msg);
      }
    },
  );
}

async function currentBranch(ctx: GitContext): Promise<string | undefined> {
  const r = await ctx.process.run(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (r.code !== 0) {
    return undefined;
  }
  const name = r.stdout.trim();
  return name && name !== "HEAD" ? name : undefined;
}

async function ensurePushed(
  ctx: GitContext,
  remote: string,
  branch: string,
): Promise<boolean> {
  const upstream = await ctx.sync.currentUpstream();
  const { ahead } = await ctx.sync.aheadBehind();
  if (upstream && ahead === 0) {
    return true; // already published and up to date.
  }

  const prompt = upstream
    ? `Your branch is ${ahead} commit(s) ahead of ${upstream}. Push before creating the PR?`
    : `Branch "${branch}" hasn't been pushed to ${remote} yet. Push it now?`;
  const choice = await vscode.window.showInformationMessage(
    prompt,
    { modal: true },
    "Push",
  );
  if (choice !== "Push") {
    return false;
  }

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Pushing ${branch}…` },
    () =>
      ctx.sync.push({
        remote,
        branch,
        setUpstream: !upstream,
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
  api: GitHubApi,
  owner: string,
  repo: string,
  headBranch: string,
): Promise<string | undefined> {
  // The repo's default branch is the best base default; fall back to "main".
  const defaultBranch = (await api.defaultBranch(owner, repo)) ?? "main";
  // Offer the default + common names, plus a free-text entry.
  const candidates = Array.from(
    new Set([defaultBranch, "main", "master", "develop"].filter((b) => b !== headBranch)),
  );
  const items: vscode.QuickPickItem[] = candidates.map((b) => ({ label: b }));
  items.push({ label: "$(edit) Other…", description: "Type a base branch name" });

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: `Base branch to merge "${headBranch}" into`,
  });
  if (!pick) {
    return undefined;
  }
  if (pick.label.startsWith("$(edit)")) {
    const typed = await vscode.window.showInputBox({
      prompt: "Base branch name",
      value: defaultBranch,
    });
    return typed?.trim() || undefined;
  }
  return pick.label;
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
