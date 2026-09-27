// Rows for the Worktrees page — one per cell of the state table a person can
// see at once: this window's worktree, the main one, locked (an agent's lock
// names itself), missing, not a worktree any more, dirty, ahead / behind /
// diverged, no upstream, stopped in a merge, detached. Used by the page tests and the screenshots.

import type { WorktreeDetails, WorktreeRow } from "@gitstudio/host-bridge/worktreesProtocol";

const HEAD = "4f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39";

export function row(over: Partial<WorktreeRow> & Pick<WorktreeRow, "path" | "name">): WorktreeRow {
  return {
    relPath: over.relPath ?? over.name,
    shownPath: `~/code/${over.relPath ?? over.name}`,
    kind: "linked",
    branch: over.name,
    head: HEAD,
    current: false,
    locked: false,
    missing: false,
    unlinked: false,
    upstream: `origin/${over.branch ?? over.name}`,
    upstreamGone: false,
    ahead: 0,
    behind: 0,
    hasRemotes: true,
    defaultBranch: "origin/main",
    onDefaultBranch: false,
    status: { changed: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    ...over,
  };
}

/** A repository with a worktree in every state worth seeing. */
export function fixtureRows(): WorktreeRow[] {
  return [
    row({
      path: "/code/app",
      name: "app",
      relPath: "app",
      kind: "main",
      branch: "main",
      upstream: "origin/main",
      onDefaultBranch: true,
      behind: 3,
    }),
    row({
      path: "/code/app-login",
      name: "app-login",
      relPath: "app-login",
      branch: "feature/login",
      upstream: "origin/feature/login",
      current: true,
      ahead: 2,
      status: { changed: 5, staged: 2, unstaged: 2, untracked: 1, conflicted: 0 },
    }),
    row({
      path: "/code/app-checkout",
      name: "app-checkout",
      branch: "feature/checkout",
      upstream: "origin/feature/checkout",
      ahead: 1,
      behind: 4,
    }),
    row({
      path: "/code/app/.claude/worktrees/agent-a2c9ae27",
      name: "agent-a2c9ae27",
      relPath: "app/.claude/worktrees/agent-a2c9ae27",
      branch: "worktree-agent-a2c9ae27",
      upstream: undefined,
      locked: true,
      lockReason: "claude agent agent-a2c9ae276dde4d3da (pid 73264)",
      status: { changed: 3, staged: 0, unstaged: 3, untracked: 0, conflicted: 0, unpublished: 4 },
    }),
    row({
      path: "/code/app-merge",
      name: "app-merge",
      branch: "fix/merge-main",
      upstream: "origin/fix/merge-main",
      status: { changed: 2, staged: 1, unstaged: 0, untracked: 0, conflicted: 1, operation: "merge" },
    }),
    row({
      path: "/code/app-spike",
      name: "app-spike",
      branch: "spike/cache",
      upstream: undefined,
      status: { changed: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, unpublished: 3 },
    }),
    row({
      path: "/code/app-v2",
      name: "app-v2",
      branch: undefined,
      upstream: undefined,
    }),
    row({
      path: "/code/app-hotfix",
      name: "app-hotfix",
      branch: "hotfix/1.2",
      upstream: "origin/hotfix/1.2",
      upstreamGone: true,
    }),
    row({
      path: "/code/app-usb",
      name: "app-usb",
      branch: "release/2.0",
      upstream: "origin/release/2.0",
      locked: true,
      lockReason: "on a USB drive",
      missing: true,
      status: undefined,
    }),
    // An agent's worktree whose .git is gone: its folder is there, but it is
    // not a worktree any more.
    row({
      path: "/code/app/.claude/worktrees/agent-7f3e",
      name: "agent-7f3e",
      relPath: "app/.claude/worktrees/agent-7f3e",
      branch: "worktree-agent-7f3e",
      upstream: undefined,
      unlinked: true,
      unlinkedWhy: "gitdir file points to non-existent location",
      status: undefined,
    }),
    row({
      path: "/code/app-old",
      name: "app-old",
      branch: "old/experiment",
      upstream: undefined,
      missing: true,
      status: undefined,
    }),
  ];
}

/** What an open row shows: uncommitted files, commits not pushed. */
export function fixtureDetails(): WorktreeDetails {
  const now = Math.floor(Date.now() / 1000);
  return {
    files: [
      { path: "src/auth/login.ts", status: "M", area: "staged" },
      { path: "src/auth/session.ts", status: "A", area: "staged" },
      { path: "src/auth/form.tsx", status: "M", area: "unstaged" },
      { path: "src/legacy/oldLogin.ts", status: "D", area: "unstaged" },
      { path: "docs/login-flow.md", status: "U", area: "untracked" },
    ],
    filesTotal: 5,
    unpushed: {
      title: "Not pushed to origin/feature/login",
      more: false,
      commits: [
        { sha: "9b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c", parents: [HEAD], subject: "Remember the session across restarts", author: "Ada", date: now - 1800 },
        { sha: "8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b", parents: [HEAD], subject: "Validate the login form before sending", author: "Ada", date: now - 3 * 3600 },
      ],
    },
  };
}

/**
 * This repository's own worktrees on a day of agents at work, as `git
 * worktree list` showed them: long folder names that share their start
 * (agent-a…, deliver…, fb-…, wf_4b651e91-cc2-…), so only their END tells
 * them apart — and the last of them stopped mid-rebase.
 */
export function agentRows(): WorktreeRow[] {
  const clean = { changed: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
  const nested = (name: string, over: Partial<WorktreeRow>): WorktreeRow =>
    row({ path: `/g/gitstudio/.claude/worktrees/${name}`, name, relPath: `gitstudio/.claude/worktrees/${name}`, ...over });
  return [
    row({ path: "/g/gitstudio", name: "gitstudio", relPath: "gitstudio", kind: "main", branch: "fix/tab-glow", upstream: undefined, current: true, status: { ...clean, changed: 2, untracked: 2, unpublished: 3 } }),
    nested("agent-a2c9ae276dde4d3da", { branch: "worktree-agent-a2c9ae276dde4d3da", upstream: undefined, locked: true, lockReason: "claude agent agent-a2c9ae276dde4d3da (pid 73264)", status: { ...clean, unpublished: 2 } }),
    nested("agent-a7ae3852b3e3f6430", { branch: "worktree-agent-a7ae3852b3e3f6430", upstream: undefined, locked: true, lockReason: "claude agent agent-a7ae3852b3e3f6430 (pid 1234)", status: { ...clean } }),
    nested("deliver", { branch: undefined, upstream: undefined, head: HEAD }),
    nested("deliver-all", { branch: "deliver/all-r0927", upstream: undefined, status: { ...clean, unpublished: 41 } }),
    nested("fb-changes", { branch: "fix/stash-dnd-and-branch-hover", upstream: undefined, status: { ...clean, changed: 4, staged: 1, unstaged: 3, unpublished: 2 } }),
    nested("fb-worktrees", { branch: "fix/worktrees-minimal", upstream: undefined, status: { ...clean, unpublished: 2 } }),
    nested("wf_4b651e91-cc2-1", { branch: "feat/stashes-in-changes", upstream: "origin/feat/stashes-in-changes" }),
    nested("wf_4b651e91-cc2-2", { branch: "feat/worktrees-webview", upstream: "origin/feat/worktrees-webview", ahead: 3 }),
    nested("wf_4b651e91-cc2-3", { branch: "feat/pull-requests-rebuild", upstream: "origin/feat/pull-requests-rebuild", behind: 2, status: { ...clean, operation: "rebase", rebasing: "feat/pull-requests-rebuild" } }),
  ];
}
