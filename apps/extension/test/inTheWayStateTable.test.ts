// The in-the-way state table, extension column: the REAL extension doors —
// the graph's Revert and Cherry-Pick, the Branches view's Merge, Rebase onto
// and Checkout, the Stashes view's Apply and Pop, and the pull door every pull
// goes through — against real git, × every shape of the user's work.
//
// Crash report #18 came from here: the graph's Revert over an edit it touches,
// shown as git's text in red and filed as a crash. Per cell: nothing filed, no
// red error, never git's words; when asked, Stash & Retry does the door's work;
// the user's bytes survive — in the file, or in a GitStudio stash the
// warning names — and a staged rename or deletion comes back in the index
// exactly. (The desktop's column, asserted byte for byte, is
// apps/desktop/test/inTheWayStateTable.test.ts; the engine both share is
// pinned in packages/git-service.)
//
// The runner cannot load VS Code: vscodeStub.cjs stands in for it and records
// every message, and the dialog host answers every question — Stash & Retry
// for the one this is about, "yes" to a door's own confirm.

import Module from "node:module";
import { join } from "node:path";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

type Resolver = { _resolveFilename: (request: unknown, ...rest: unknown[]) => string };
const resolver = Module as unknown as Resolver;
const resolve = resolver._resolveFilename;
resolver._resolveFilename = function (request: unknown, ...rest: unknown[]) {
  return request === "vscode" ? join(__dirname, "vscodeStub.cjs") : resolve.call(this, request, ...rest);
};

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const vscode = require("vscode") as { __said: { kind: string; message: string }[] };
const { registerDialogHost } = require("../src/ui/dialogs") as typeof import("../src/ui/dialogs");
const { runCommitAction } = require("../src/graph/commitActions") as typeof import("../src/graph/commitActions");
const branchActions = require("../src/views/branchActions") as typeof import("../src/views/branchActions");
const stashesView = require("../src/views/stashesView") as typeof import("../src/views/stashesView");
const { pullOrAsk } = require("../src/git/inTheWay") as typeof import("../src/git/inTheWay");
const { settlePullStop } = require("../src/git/pullMode") as typeof import("../src/git/pullMode");
const { ErrorReporter } = require("../src/reporting/errorReporter") as typeof import("../src/reporting/errorReporter");
const { GitContext } = require("@gitstudio/git-service/GitContext") as typeof import("@gitstudio/git-service/GitContext");
/* eslint-enable @typescript-eslint/no-require-imports */

// Hermetic git: an empty global config, no system one.
const cfg = join(mkdtempSync(join(tmpdir(), "gs-ext-intheway-cfg-")), "config");
writeFileSync(cfg, "");
process.env.GIT_CONFIG_GLOBAL = cfg;
process.env.GIT_CONFIG_SYSTEM = cfg;
process.env.GIT_CONFIG_NOSYSTEM = "1";

const filed: string[] = [];
(ErrorReporter as unknown as { current: unknown }).current = {
  captureGitError: (label: string, stderr: string) => filed.push(`${label}: ${stderr}`),
  captureError: (where: string, err: unknown) => filed.push(`${where}: ${String(err)}`),
};
let asked: string[] = [];
registerDialogHost({
  show: async (spec) => {
    asked.push(spec.title);
    return { value: spec.title === "Your uncommitted changes are in the way" ? "stash" : "ok" };
  },
});

const scratch = mkdtempSync(join(tmpdir(), "gs-ext-intheway-"));
after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const at =
  (cwd: string) =>
  (...a: string[]): string =>
    execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
function identify(g: (...a: string[]) => string): void {
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) {
    g("config", k, v);
  }
}
const LINES = (tag: string, n: number): string =>
  Array.from({ length: 9 }, (_, i) => (i === n ? `${tag}\n` : `line ${i}\n`)).join("");
const plain = LINES("line 0", 0);

type Door = "revert" | "cherry-pick" | "merge" | "rebase" | "checkout" | "stash apply" | "stash pop" | "stash apply -u" | "stash pop -u" | "pull";
type State =
  | "clean"
  | "edit in the way"
  | "edit on its line"
  | "untracked in the way"
  | "edit elsewhere"
  | "staged rename"
  | "staged deletion";

/**
 * base: a b d e · feature: a line 0, + n · main (HEAD): b line 0, − d ·
 * origin/main (unfetched): main + a line 0, + n · stash@{0}: a line 2 (and,
 * made with -u, an untracked n). Every door writes a.txt and creates n.txt —
 * the revert writes b.txt and recreates d.txt. Nothing touches e.txt.
 */
function fixture(door: Door): { dir: string; git: (...a: string[]) => string } {
  const base = mkdtempSync(join(scratch, "cell-"));
  const dir = join(base, "work");
  const remote = join(base, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  const git = at(dir);
  identify(git);
  for (const f of ["a.txt", "b.txt", "e.txt"]) writeFileSync(join(dir, f), plain);
  writeFileSync(join(dir, "d.txt"), "d\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(dir, "a.txt"), LINES("feature", 0));
  writeFileSync(join(dir, "n.txt"), "from feature\n");
  git("add", ".");
  git("commit", "-q", "-m", "feature changes a, adds n");
  git("checkout", "-q", "main");
  writeFileSync(join(dir, "b.txt"), LINES("main", 0));
  git("rm", "-q", "d.txt");
  git("commit", "-q", "-am", "main changes b, removes d");
  if (door === "pull") {
    git("remote", "add", "origin", remote);
    git("push", "-q", "-u", "origin", "main");
    const seed = join(base, "seed");
    execFileSync("git", ["clone", "-q", remote, seed], { stdio: "ignore" });
    const s = at(seed);
    identify(s);
    writeFileSync(join(seed, "a.txt"), LINES("theirs", 0));
    writeFileSync(join(seed, "n.txt"), "from theirs\n");
    s("add", ".");
    s("commit", "-q", "-m", "theirs");
    s("push", "-q", "origin", "main");
  }
  if (door.startsWith("stash")) {
    writeFileSync(join(dir, "a.txt"), LINES("stashed", 2));
    if (door.endsWith("-u")) writeFileSync(join(dir, "n.txt"), "from the stash\n");
    git("stash", "push", "-q", ...(door.endsWith("-u") ? ["-u"] : []), "-m", "the one asked for");
  }
  return { dir, git };
}

/** Put the user's work in place; what they wrote, by path. */
function arrange(dir: string, git: (...a: string[]) => string, door: Door, state: State): Record<string, string> {
  const file = door === "revert" ? "b.txt" : "a.txt";
  const line = door.startsWith("stash") ? 2 : 0;
  const creates = door === "revert" ? "d.txt" : "n.txt";
  const start = door === "revert" ? LINES("main", 0) : plain;
  const mine: Record<string, string> = {};
  const put = (f: string, s: string): void => {
    writeFileSync(join(dir, f), s);
    mine[f] = s;
  };
  if (state === "edit in the way") put(file, start.replace("line 6\n", "mine\n"));
  if (state === "edit on its line") put(file, LINES("mine", line));
  if (state === "untracked in the way") put(creates, "my own untracked file\n");
  if (state === "edit elsewhere") put("e.txt", plain.replace("line 6\n", "mine\n"));
  if (state === "staged rename") git("mv", "e.txt", "e2.txt");
  if (state === "staged deletion") git("rm", "-q", "e.txt");
  return mine;
}

/** The door, as the user reaches it. */
async function press(door: Door, dir: string, git: (...a: string[]) => string): Promise<void> {
  const ctx = new GitContext({ root: dir });
  const repos = { getActive: () => ({ ctx, root: dir }), getUndoLedger: () => undefined } as never;
  const node = { ref: { name: "feature", type: "head" } };
  const refresh = (): void => {};
  try {
    switch (door) {
      case "revert":
        await runCommitAction("revert", ctx, { sha: git("rev-parse", "main").trim(), subject: "x" } as never);
        break;
      case "cherry-pick":
        await runCommitAction("cherryPick", ctx, { sha: git("rev-parse", "feature").trim(), subject: "x" } as never);
        break;
      case "merge":
        await branchActions.mergeBranchIntoCurrent(repos, node, refresh);
        break;
      case "rebase":
        await branchActions.rebaseCurrentOnto(repos, node, refresh);
        break;
      case "checkout":
        await branchActions.checkoutBranch(repos, node, refresh);
        break;
      case "stash apply":
      case "stash apply -u":
        await stashesView.applyStash(repos, "stash@{0}", refresh);
        break;
      case "stash pop":
      case "stash pop -u":
        await stashesView.popStash(repos, "stash@{0}", refresh);
        break;
      case "pull": {
        // Every extension pull door runs its pull through pullOrAsk and hands
        // what comes back to settlePullStop (inTheWayCallSites.test.ts and
        // pullDivergedCallSites.test.ts hold the doors to that).
        const pulled = await pullOrAsk(ctx);
        if (pulled && !settlePullStop(pulled) && !pulled.ok) {
          vscode.__said.push({ kind: "error", message: `Pull failed: ${pulled.stderr}` });
        }
        break;
      }
    }
  } finally {
    ctx.dispose();
  }
}

/** Did the door's work happen? */
function didIt(door: Door, dir: string, git: (...a: string[]) => string): boolean {
  const subject = git("log", "-1", "--format=%s").trim();
  if (door === "revert") return subject.startsWith("Revert ");
  if (door === "cherry-pick") return subject === "feature changes a, adds n";
  if (door === "merge") return git("rev-list", "--parents", "-n", "1", "HEAD").trim().split(" ").length === 3;
  if (door === "rebase") return subject === "main changes b, removes d" && git("rev-parse", "HEAD~1").trim() === git("rev-parse", "feature").trim();
  if (door === "checkout") return git("symbolic-ref", "--short", "HEAD").trim() === "feature";
  if (door === "pull") return subject === "theirs";
  return readFileSync(join(dir, "a.txt"), "utf8").includes("stashed\n");
}

/** Where the user's bytes are now: in the file, or in one of our stashes. */
function survives(git: (...a: string[]) => string, dir: string, f: string, s: string): boolean {
  const mineLine = s.split("\n").find((l) => l.startsWith("mine") || l.startsWith("my own"))!;
  if (existsSync(join(dir, f)) && readFileSync(join(dir, f), "utf8").includes(mineLine)) return true;
  const ours = git("stash", "list", "--format=%H %s").split("\n").filter((l) => /GitStudio: before/.test(l));
  return ours.some((o) => {
    const sha = o.split(" ")[0];
    for (const at of [`${sha}:${f}`, `${sha}^3:${f}`]) {
      try {
        if (git("show", at) === s) return true;
      } catch {
        // not at this address
      }
    }
    return false;
  });
}

const DOORS: Door[] = ["revert", "cherry-pick", "merge", "rebase", "checkout", "stash apply", "stash pop", "stash apply -u", "stash pop -u", "pull"];
const STATES: State[] = ["clean", "edit in the way", "edit on its line", "untracked in the way", "edit elsewhere", "staged rename", "staged deletion"];

for (const door of DOORS) {
  for (const state of STATES) {
    test(`${door} × ${state}`, async () => {
      const { dir, git } = fixture(door);
      const mine = arrange(dir, git, door, state);
      vscode.__said.length = 0;
      filed.length = 0;
      asked = [];
      const index = git("diff", "--cached", "--name-status", "--no-renames");
      await press(door, dir, git);
      const said = vscode.__said.map((s) => `${s.kind}: ${s.message}`).join("\n");
      assert.deepEqual(filed, [], `nothing filed:\n${said}`);
      assert.doesNotMatch(said, /^error:/m, `no red error:\n${said}`);
      assert.doesNotMatch(said, /overwritten by|fatal:|pathspec|Aborting/, `never git's words:\n${said}`);
      assert.ok(didIt(door, dir, git), `the door's work was done — at once, or after Stash & Retry:\n${said}`);
      for (const [f, s] of Object.entries(mine)) {
        assert.ok(survives(git, dir, f, s), `${f}: the user's bytes survive:\n${said}`);
      }
      if (state === "staged rename" || state === "staged deletion") {
        assert.equal(git("diff", "--cached", "--name-status", "--no-renames"), index, `the index given back exactly:\n${said}`);
      }
      if (git("stash", "list").includes("GitStudio: before")) {
        assert.match(said, /^warning: GitStudio: Your changes to .* stash "GitStudio: before/m, `a stash of ours left behind is named:\n${said}`);
      }
    });
  }
}
