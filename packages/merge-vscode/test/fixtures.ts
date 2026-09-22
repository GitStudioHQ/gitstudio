// Real git repositories for the tests (hermetic config via test/hermetic.ts).
//
// Operation views are HAND-BUILT here (the contract's instruction for a fake
// OperationSource): a rebase view puts Yours on stage 3. They are never built
// with describeSides, whose S0 stub never swaps.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  OperationKind,
  OperationView,
  SideView,
} from "@gitstudio/host-bridge/conflictsProtocol";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** git, expected to fail (a conflicting merge / rebase stop). */
export function gitFails(cwd: string, ...args: string[]): void {
  try {
    git(cwd, ...args);
  } catch {
    return;
  }
  throw new Error(`expected git ${args.join(" ")} to stop`);
}

export function newRepo(prefix: string): { dir: string; repo: string } {
  const dir = mkdtempSync(join(tmpdir(), `merge-vscode-${prefix}-`));
  const repo = join(dir, "repo");
  execFileSync("git", ["-c", "init.defaultBranch=master", "init", repo], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stdio: "ignore",
  });
  git(repo, "config", "user.email", "dev@example.com");
  git(repo, "config", "user.name", "Dev");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "merge.conflictStyle", "diff3");
  git(repo, "config", "commit.gpgsign", "false");
  return { dir, repo };
}

export function removeTemp(dir: string | undefined): void {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // scratch space; the OS reclaims it
  }
}

/**
 * merge-studio#12's exact steps: master and test each change line 3;
 * `git checkout test; git rebase master` stops on the conflict.
 * Stage 2 = master's "three-master", stage 3 = test's "three-test".
 */
export function reporterRebase(): { dir: string; repo: string } {
  const r = newRepo("reporter");
  writeFileSync(join(r.repo, "a.txt"), "one\ntwo\nthree\nfour\n");
  git(r.repo, "add", "a.txt");
  git(r.repo, "commit", "-m", "base");
  git(r.repo, "checkout", "-b", "test");
  writeFileSync(join(r.repo, "a.txt"), "one\ntwo\nthree-test\nfour\n");
  git(r.repo, "commit", "-am", "test change");
  git(r.repo, "checkout", "master");
  writeFileSync(join(r.repo, "a.txt"), "one\ntwo\nthree-master\nfour\n");
  git(r.repo, "commit", "-am", "master change");
  git(r.repo, "checkout", "test");
  gitFails(r.repo, "rebase", "master");
  return r;
}

/** A plain merge conflict: on master, `git merge feature`. Stage 2 = master, stage 3 = feature. */
export function mergeConflict(): { dir: string; repo: string } {
  const r = newRepo("merge");
  writeFileSync(join(r.repo, "a.txt"), "one\ntwo\nthree\nfour\n");
  git(r.repo, "add", "a.txt");
  git(r.repo, "commit", "-m", "base");
  git(r.repo, "checkout", "-b", "feature");
  writeFileSync(join(r.repo, "a.txt"), "one\ntwo\nthree-feature\nfour\n");
  git(r.repo, "commit", "-am", "feature change");
  git(r.repo, "checkout", "master");
  writeFileSync(join(r.repo, "a.txt"), "one\ntwo\nthree-master\nfour\n");
  git(r.repo, "commit", "-am", "master change");
  gitFails(r.repo, "merge", "feature");
  return r;
}

function side(role: "yours" | "theirs", stage: 2 | 3, name: string, paneTitle: string): SideView {
  return { role, stage, name, paneTitle, description: paneTitle };
}

/** A hand-built OperationView, as P2's OperationProvider would describe the stop. */
export function view(kind: OperationKind, over: Partial<OperationView> = {}): OperationView {
  const swapped = kind === "rebase" || kind === "stash";
  const base: OperationView = {
    kind,
    title: "",
    yours: swapped
      ? side("yours", 3, "test", "Rebasing 1a2b3c4 from test")
      : side("yours", 2, "master", "Changes from master"),
    theirs: swapped
      ? side("theirs", 2, "master", "Already rebased commits and commits from master")
      : side("theirs", 3, "feature", "Changes from feature"),
    verbs:
      kind === "none" || kind === "stash"
        ? { abort: "Cancel" }
        : {
            continue: kind === "rebase" ? "Continue Rebase" : "Continue Merge",
            abort: kind === "rebase" ? "Abort Rebase" : "Abort Merge",
            ...(kind === "rebase" ? { skip: "Skip this commit" } : {}),
          },
    canContinue: false,
    canSkip: false,
    episode: kind === "none" ? "none" : `${kind}:1`,
  };
  return { ...base, ...over };
}
