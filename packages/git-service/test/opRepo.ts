// Real-git fixtures for the operation / conflict tests (PLAN §4 P2 "Tests").
//
// Hermetic on top of test/hermetic.ts (which pins an empty global/system
// config): every repo sets its own identity, `core.autocrlf=false`,
// `merge.conflictStyle=diff3` and `gc.auto=0`. GIT_EDITOR is set to `false`
// for the whole suite, so any code path that would open an editor FAILS
// instead of silently accepting — the tool shell running these tests exports
// GIT_EDITOR=true, which would hide exactly that.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GitContext } from "../src/GitContext";
import { removeTempRepo } from "./tmpRepo";

process.env.GIT_EDITOR = "false";
delete process.env.GIT_SEQUENCE_EDITOR;
delete process.env.EDITOR;
delete process.env.VISUAL;

export interface Repo {
  root: string;
  /** Run git, throw on failure, return stdout. */
  git(...args: string[]): string;
  /** Run git that may fail (a conflict stop); returns the exit code. */
  tryGit(...args: string[]): number;
  /** Run git with extra environment. */
  gitEnv(env: NodeJS.ProcessEnv, ...args: string[]): { code: number; stdout: string; stderr: string };
  write(rel: string, text: string | Buffer): void;
  read(rel: string): string;
  exists(rel: string): boolean;
  commitAll(msg: string): string;
  sha(rev: string): string;
  ctx(): GitContext;
  cleanup(): void;
}

const created: GitContext[] = [];

export function makeRepo(name: string, opts?: { dir?: string }): Repo {
  const root = opts?.dir ?? mkdtempSync(join(tmpdir(), `gs-op-${name}-`));
  mkdirSync(root, { recursive: true });
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const repo: Repo = {
    root,
    git,
    tryGit: (...args) => spawnSync("git", args, { cwd: root, env, stdio: "ignore" }).status ?? 1,
    gitEnv: (extra, ...args) => {
      const r = spawnSync("git", args, { cwd: root, env: { ...env, ...extra }, encoding: "utf8" });
      return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    write: (rel, text) => {
      const p = join(root, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, text);
    },
    read: (rel) => readFileSync(join(root, rel), "utf8"),
    exists: (rel) => existsSync(join(root, rel)),
    commitAll: (msg) => {
      git("add", "-A");
      git("commit", "-q", "-m", msg);
      return git("rev-parse", "HEAD").trim();
    },
    sha: (rev) => git("rev-parse", "--verify", `${rev}^{commit}`).trim(),
    ctx: () => {
      const c = new GitContext({ root });
      created.push(c);
      return c;
    },
    cleanup: () => {
      for (const c of created.splice(0)) c.dispose();
      removeTempRepo(root);
    },
  };
  if (!opts?.dir) {
    git("init", "-q", "-b", "master", ".");
  }
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  git("config", "core.autocrlf", "false");
  git("config", "merge.conflictStyle", "diff3");
  git("config", "gc.auto", "0");
  git("config", "advice.detachedHead", "false");
  return repo;
}

export const FIVE = "one\ntwo\nthree\nfour\nfive\n";

/** Replace whole lines: `{ three: "three-test" }`. */
export function edit(text: string, lines: Record<string, string>): string {
  return text
    .split("\n")
    .map((l) => (l in lines ? lines[l] : l))
    .join("\n");
}

/**
 * The reporter's exact repository (issue #12): `master` and `test` each change
 * line 3 of f.txt; `test` is checked out. The caller runs `git rebase master`.
 */
export function reporterRepo(): Repo {
  const r = makeRepo("reporter");
  r.write("f.txt", FIVE);
  r.commitAll("base");
  r.git("checkout", "-q", "-b", "test");
  r.write("f.txt", edit(FIVE, { three: "three-test" }));
  r.commitAll("test change");
  r.git("checkout", "-q", "master");
  r.write("f.txt", edit(FIVE, { three: "three-master" }));
  r.commitAll("master change");
  r.git("checkout", "-q", "test");
  return r;
}

/**
 * The three-commit topology of git-semantics/scenarios.sh: base; test: T1 adds
 * g.txt, T2 edits line 3, T3 edits line 5; master: M1 edits lines 3 and 5.
 * Leaves master checked out.
 */
export function topoRepo(name: string): Repo {
  const r = makeRepo(name);
  r.write("f.txt", FIVE);
  r.commitAll("base");
  r.git("checkout", "-q", "-b", "test");
  r.write("g.txt", "g\n");
  r.commitAll("test: add g");
  r.write("f.txt", edit(FIVE, { three: "three-test" }));
  r.commitAll("test: edit line 3");
  r.write("f.txt", edit(FIVE, { three: "three-test", five: "five-test" }));
  r.commitAll("test: edit line 5");
  r.git("checkout", "-q", "master");
  r.write("f.txt", edit(FIVE, { three: "three-master", five: "five-master" }));
  r.commitAll("master: edit lines 3 and 5");
  return r;
}

/** A node sequence editor that rewrites the todo with `fn` (portable: no sed -i, no chmod). */
export function seqEditor(r: Repo, body: string): string {
  const p = join(r.root, `.seq-${Math.random().toString(36).slice(2)}.cjs`);
  writeFileSync(
    p,
    `const fs=require("fs");const p=process.argv[2];let t=fs.readFileSync(p,"utf8");${body};fs.writeFileSync(p,t);\n`,
  );
  // Excluded from the tree so `add -A` never picks it up.
  const exclude = join(r.root, ".git", "info", "exclude");
  try {
    writeFileSync(exclude, `${readFileSafe(exclude)}\n.seq-*.cjs\n`);
  } catch {
    /* a linked worktree — callers there do not use -A */
  }
  return `node "${p.replace(/\\/g, "/")}"`;
}

function readFileSafe(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/** Is a German locale usable for git (the locale-freedom run)? */
export function germanLocale(): NodeJS.ProcessEnv | undefined {
  const env = { ...process.env, LANG: "de_DE.UTF-8", LC_ALL: "de_DE.UTF-8", LANGUAGE: "de" };
  const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: tmpdir(), env, encoding: "utf8" });
  // Outside a repository git answers in the active language: German proves the
  // catalogs are installed (Schwerwiegend: Kein Git-Repository …).
  return /Git-Repository|Schwerwiegend/.test(r.stderr ?? "") ? env : undefined;
}
