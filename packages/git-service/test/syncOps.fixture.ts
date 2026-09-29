// Shared fixtures for the syncOps.* / operationProvider.* / rebaseRunner.*
// tests: a clone of a local bare "remote" (never a network URL), a second
// clone standing in for a colleague, and a GitProcess that answers chosen
// commands with a canned result — for the failure branches real git will not
// produce on demand (a `git remote` that fails, a status that cannot be read).

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "../src/GitContext";
import type { GitProcess, GitRunResult } from "../src/GitProcess";
import { makeRepo, type Repo } from "./opRepo";
import { removeTempRepo } from "./tmpRepo";

const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };

/** A bare repository in the temp dir, `main` as its default branch. */
export function bareRepo(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `gs-sync-${name}-bare-`));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", dir], { env: ENV });
  return dir;
}

/** A clone of `bare`, configured like every opRepo fixture. */
export function cloneOf(bare: string, name: string): Repo {
  const dir = mkdtempSync(join(tmpdir(), `gs-sync-${name}-`));
  execFileSync("git", ["clone", "-q", bare, dir], { env: ENV, stdio: "ignore" });
  const r = makeRepo(name, { dir });
  r.git("config", "commit.gpgsign", "false");
  return r;
}

export interface Synced {
  bare: string;
  /** The clone under test, on `main` tracking `origin/main`. */
  me: Repo;
  /** Another clone, for moving the remote on without `me` knowing. */
  other(): Repo;
  /** A GitContext on `me` whose every git invocation lands in `runs`. */
  ctx(): GitContext;
  runs: string[][];
  /** The refs the bare remote has, `refs/heads/x` → sha. */
  remoteRefs(): Map<string, string>;
  cleanup(): void;
}

export function synced(name: string): Synced {
  const bare = bareRepo(name);
  const me = cloneOf(bare, name);
  me.write("f.txt", "base\n");
  me.commitAll("base");
  me.git("push", "-q", "-u", "origin", "main");
  const others: Repo[] = [];
  const contexts: GitContext[] = [];
  const runs: string[][] = [];
  return {
    bare,
    me,
    runs,
    other: () => {
      const o = cloneOf(bare, `${name}-other`);
      others.push(o);
      return o;
    },
    ctx: () => {
      const c = new GitContext({ root: me.root, onRun: (e) => runs.push(e.args) });
      contexts.push(c);
      return c;
    },
    remoteRefs: () => {
      const out = execFileSync("git", ["for-each-ref", "--format=%(refname) %(objectname)"], {
        cwd: bare,
        env: ENV,
        encoding: "utf8",
      });
      const m = new Map<string, string>();
      for (const line of out.split("\n")) {
        const [ref, sha] = line.trim().split(" ");
        if (ref) m.set(ref, sha);
      }
      return m;
    },
    cleanup: () => {
      for (const c of contexts.splice(0)) c.dispose();
      for (const o of others.splice(0)) o.cleanup();
      me.cleanup();
      removeTempRepo(bare);
    },
  };
}

/**
 * A GitProcess that answers the commands `answer` recognises with a canned
 * result and hands everything else to the real one. `answer` returns
 * undefined to pass a command through.
 */
export function routedProc(
  real: GitProcess,
  answer: (args: string[]) => Partial<GitRunResult> | undefined,
): GitProcess {
  return {
    cwd: real.cwd,
    run: async (args: string[], opts?: Parameters<GitProcess["run"]>[1]) => {
      const canned = answer(args);
      if (canned) return { code: 0, stdout: "", stderr: "", ...canned };
      return real.run(args, opts);
    },
  } as unknown as GitProcess;
}

/** Does `args` start with exactly these words? */
export function starts(args: string[], ...words: string[]): boolean {
  return words.every((w, i) => args[i] === w);
}
