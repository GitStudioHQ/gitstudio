// A throwaway repository with a GitBridge over it, for the gitBridge.*.test.ts
// files. Same recipe as the neighbouring bridge tests (stashRestore.test.ts):
// a hermetic git (the test script's hermetic-git.mjs), gc off, autocrlf off,
// and removal through removeTempRepo.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GitContext } from "@gitstudio/git-service/index";
import { GitBridge } from "../src/main/gitBridge";
import type { RepoStore } from "../src/main/repoStore";
import { removeTempRepo } from "./tmpRepo";

export interface BridgeRepo {
  repo: string;
  ctx: GitContext;
  bridge: GitBridge;
  git: (...args: string[]) => string;
  /** git, answering the exit code instead of throwing. */
  gitTry: (...args: string[]) => { code: number; stdout: string; stderr: string };
  write: (rel: string, content: string | Buffer) => void;
  commitAll: (message: string) => string;
  cleanup: () => void;
  /** Extra folders (bare remotes, worktrees) to remove with the repo. */
  alsoRemove: string[];
}

const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };

export function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: ENV, stdio: ["ignore", "pipe", "pipe"] });
}

export function initRepo(prefix: string, opts: { tabs?: () => string[] } = {}): BridgeRepo {
  const repo = mkdtempSync(join(tmpdir(), `gitstudio-${prefix}-`));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", repo], { env: ENV });
  const git = (...a: string[]): string => gitIn(repo, ...a);
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  git("config", "gc.auto", "0");
  git("config", "core.autocrlf", "false");
  git("config", "commit.gpgsign", "false");
  const ctx = new GitContext({ root: repo });
  const store = {
    getContext: () => ctx,
    current: () => ({ root: repo }),
    state: () => ({ tabs: (opts.tabs?.() ?? [repo]).map((root) => ({ root })) }),
    runnerOptions: () => ({ gitPath: "git", onRun: () => undefined }),
  } as unknown as RepoStore;
  const bridge = new GitBridge(store);
  const alsoRemove: string[] = [];
  const write = (rel: string, content: string | Buffer): void => {
    const abs = join(repo, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  const gitTry = (...a: string[]): { code: number; stdout: string; stderr: string } => {
    try {
      return { code: 0, stdout: git(...a), stderr: "" };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? 1, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? "") };
    }
  };
  const commitAll = (message: string): string => {
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD").trim();
  };
  return {
    repo,
    ctx,
    bridge,
    git,
    gitTry,
    write,
    commitAll,
    alsoRemove,
    cleanup: () => {
      removeTempRepo(repo);
      for (const d of alsoRemove) removeTempRepo(d);
    },
  };
}

/** A bare repository to push to — a local path, so nothing leaves the machine. */
export function bareRemote(r: BridgeRepo, name = "origin"): string {
  const bare = mkdtempSync(join(tmpdir(), "gitstudio-bare-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", "--bare", bare], { env: ENV });
  r.alsoRemove.push(bare);
  r.git("remote", "add", name, bare);
  return bare;
}

/** A conflicted merge of `topic` into main on `file`: returns after git stopped. */
export function conflictOn(r: BridgeRepo, file: string, base: string, ours: string, theirs: string): void {
  r.write(file, base);
  r.commitAll(`base ${file}`);
  r.git("checkout", "-q", "-b", "topic");
  r.write(file, theirs);
  r.commitAll(`theirs ${file}`);
  r.git("checkout", "-q", "main");
  r.write(file, ours);
  r.commitAll(`ours ${file}`);
  r.gitTry("merge", "topic");
}
