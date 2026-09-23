// The stopped-operation state table, extension column: the REAL extension
// doors — the graph's Revert, Cherry-Pick and Check Out (detached), the
// Branches view's Merge, Rebase onto and Checkout, the Stashes view's Apply
// and Pop, the status bar's Pull and Sync — pressed while git is ALREADY
// stopped: a merge, a rebase, a cherry-pick, a revert or a `git am` waiting
// for the user (conflicted, or resolved and not yet continued), or files left
// unmerged by a stash.
//
// Where the two lines met. git refuses most of these over a stop, and that
// went out as git's text in red ("Merge failed: error: Merging is not possible
// because you have unmerged files…", "Rebase failed: fatal: It seems that
// there is already a rebase-merge directory…"), and the graph's Cherry-Pick
// and Revert over a resolved stop FILED it. Over a stopped `git am` the door
// read the staged resolution as "your uncommitted changes" and Stash & Retry
// stashed it out of the operation. And git does not refuse all of them: a
// checkout ENDED a stopped merge, cherry-pick or revert, and moved HEAD out
// from under a rebase.
//
// Per cell: nothing filed, no red error, never git's words, never the
// Stash & Retry question, the stop exactly as it was — and the user told what
// is stopped (with Resolve Conflicts… while files are left to resolve). A
// stash apply git lets run over a staged resolution simply runs.
// (The engine is pinned in packages/git-service/test/operationInTheWay.test.ts;
// the desktop column is apps/desktop/test/operationInTheWayTable.test.ts.)

import Module from "node:module";
import { join } from "node:path";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

type Resolver = { _resolveFilename: (request: unknown, ...rest: unknown[]) => string };
const resolver = Module as unknown as Resolver;
const resolve = resolver._resolveFilename;
resolver._resolveFilename = function (request: unknown, ...rest: unknown[]) {
  return request === "vscode" ? join(__dirname, "vscodeStub.cjs") : resolve.call(this, request, ...rest);
};

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const vscode = require("vscode") as {
  __said: { kind: string; message: string }[];
  commands: Record<string, unknown>;
};
const { registerDialogHost } = require("../src/ui/dialogs") as typeof import("../src/ui/dialogs");
const { runCommitAction } = require("../src/graph/commitActions") as typeof import("../src/graph/commitActions");
const branchActions = require("../src/views/branchActions") as typeof import("../src/views/branchActions");
const stashesView = require("../src/views/stashesView") as typeof import("../src/views/stashesView");
const { SyncStatusItem } = require("../src/statusBar/syncStatus") as typeof import("../src/statusBar/syncStatus");
const { ErrorReporter } = require("../src/reporting/errorReporter") as typeof import("../src/reporting/errorReporter");
const { GitContext } = require("@gitstudio/git-service/GitContext") as typeof import("@gitstudio/git-service/GitContext");
/* eslint-enable @typescript-eslint/no-require-imports */

// Hermetic git: an empty global config, no system one.
const cfg = join(mkdtempSync(join(tmpdir(), "gs-ext-opway-cfg-")), "config");
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
    // Every door's own confirm is answered yes; the in-the-way question would
    // be answered Stash & Retry — and must never be asked here.
    return { value: spec.title === "Your uncommitted changes are in the way" ? "stash" : "ok" };
  },
});
// The status bar item registers its commands at construction.
vscode.commands.registerCommand = () => ({ dispose() {} });

const scratch = mkdtempSync(join(tmpdir(), "gs-ext-opway-"));
after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

function git(cwd: string, ...a: string[]): string {
  return execFileSync("git", a, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_EDITOR: "true" },
  });
}
function tryGit(cwd: string, ...a: string[]): void {
  try {
    git(cwd, ...a);
  } catch {
    // the stop is the point
  }
}
const LINES = (tag: string, n: number): string =>
  Array.from({ length: 9 }, (_, i) => (i === n ? `${tag}\n` : `line ${i}\n`)).join("");

type Stop = "merge" | "rebase" | "cherry-pick" | "revert" | "am" | "stash";

/**
 * Stopped mid-`stop` on a conflict in a.txt (`resolved`: resolved and staged,
 * not continued). Made first: branch `other` (main + o.txt), a stash of an
 * edit to e.txt, and origin/main one commit ahead (u.txt), not yet fetched.
 */
function stopped(stop: Stop, resolved: boolean): { dir: string; other: string; main: string } {
  const base = mkdtempSync(join(scratch, "cell-"));
  const dir = join(base, "work");
  const remote = join(base, "remote.git");
  git(base, "init", "-q", "--bare", "-b", "main", remote);
  git(base, "init", "-q", "-b", "main", dir);
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) {
    git(dir, "config", k, v);
  }
  writeFileSync(join(dir, "a.txt"), LINES("line 0", 0));
  writeFileSync(join(dir, "e.txt"), LINES("line 0", 0));
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "checkout", "-q", "-b", "feature");
  writeFileSync(join(dir, "a.txt"), LINES("feature", 0));
  git(dir, "commit", "-q", "-am", "feature changes a");
  git(dir, "checkout", "-q", "main");
  writeFileSync(join(dir, "a.txt"), LINES("main", 0));
  git(dir, "commit", "-q", "-am", "main changes a");
  git(dir, "checkout", "-q", "-b", "other");
  writeFileSync(join(dir, "o.txt"), "other\n");
  git(dir, "add", "o.txt");
  git(dir, "commit", "-q", "-m", "other adds o");
  git(dir, "checkout", "-q", "main");
  writeFileSync(join(dir, "e.txt"), LINES("stashed", 4));
  git(dir, "stash", "push", "-q", "-m", "the door's stash");
  git(dir, "remote", "add", "origin", remote);
  git(dir, "push", "-q", "-u", "origin", "main");
  const seed = join(base, "seed");
  git(base, "clone", "-q", remote, seed);
  for (const [k, v] of [["user.email", "u@example.com"], ["user.name", "u"], ["commit.gpgsign", "false"]]) {
    git(seed, "config", k, v);
  }
  writeFileSync(join(seed, "u.txt"), "theirs\n");
  git(seed, "add", "u.txt");
  git(seed, "commit", "-q", "-m", "theirs adds u");
  git(seed, "push", "-q", "origin", "main");
  const main = git(dir, "rev-parse", "main").trim();
  const other = git(dir, "rev-parse", "other").trim();
  switch (stop) {
    case "merge":
      tryGit(dir, "merge", "--no-edit", "feature");
      break;
    case "rebase":
      git(dir, "checkout", "-q", "feature");
      tryGit(dir, "rebase", "main");
      break;
    case "cherry-pick":
      tryGit(dir, "cherry-pick", "feature");
      break;
    case "revert":
      writeFileSync(join(dir, "a.txt"), LINES("main again", 0));
      git(dir, "commit", "-q", "-am", "main changes a again");
      tryGit(dir, "revert", "--no-edit", "HEAD~1");
      break;
    case "am": {
      const patch = join(base, "feature.patch");
      writeFileSync(patch, git(dir, "format-patch", "-1", "--stdout", "feature"));
      tryGit(dir, "am", "-3", patch);
      break;
    }
    case "stash":
      writeFileSync(join(dir, "a.txt"), LINES("stashed a", 0));
      git(dir, "stash", "push", "-q", "-m", "the stop's stash");
      writeFileSync(join(dir, "a.txt"), LINES("main moved", 0));
      git(dir, "commit", "-q", "-am", "main moves a");
      tryGit(dir, "stash", "pop");
      break;
  }
  assert.ok(git(dir, "ls-files", "-u").trim(), `${stop}: stopped on a conflict`);
  if (resolved) {
    writeFileSync(join(dir, "a.txt"), LINES("resolved", 0));
    git(dir, "add", "a.txt");
  }
  return { dir, other, main };
}

/** Everything a refused door must leave as it was. */
function state(dir: string): string {
  const markers = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]
    .filter((m) => existsSync(join(dir, ".git", m)))
    .join(",");
  let sym = "(detached)";
  try {
    sym = git(dir, "symbolic-ref", "-q", "HEAD").trim();
  } catch {
    // detached, mid-rebase
  }
  return JSON.stringify({
    head: git(dir, "rev-parse", "HEAD").trim(),
    sym,
    markers,
    index: git(dir, "ls-files", "-s"),
    status: git(dir, "status", "--porcelain=v1", "--untracked-files=all"),
    stashes: git(dir, "stash", "list", "--format=%H"),
    remotes: git(dir, "for-each-ref", "refs/remotes/"),
  });
}

type Door =
  | "revert"
  | "cherry-pick"
  | "checkout --detach"
  | "merge"
  | "rebase"
  | "checkout"
  | "stash apply"
  | "stash pop"
  | "pull (status bar)"
  | "sync (status bar)";
const DOORS: Door[] = [
  "revert",
  "cherry-pick",
  "checkout --detach",
  "merge",
  "rebase",
  "checkout",
  "stash apply",
  "stash pop",
  "pull (status bar)",
  "sync (status bar)",
];

async function press(door: Door, c: { dir: string; other: string; main: string }): Promise<void> {
  const ctx = new GitContext({ root: c.dir });
  const entry = { ctx, root: c.dir };
  const repos = {
    getActive: () => entry,
    getAll: () => [entry],
    getUndoLedger: () => undefined,
    onDidChange: () => ({ dispose() {} }),
  } as never;
  const refs = await ctx.refs.listRefs();
  const node = { ref: refs.find((r) => r.fullName === "refs/heads/other")! };
  const refresh = (): void => {};
  try {
    switch (door) {
      case "revert":
        await runCommitAction("revert", ctx, { sha: c.main, subject: "x" } as never);
        break;
      case "cherry-pick":
        await runCommitAction("cherryPick", ctx, { sha: c.other, subject: "x" } as never);
        break;
      case "checkout --detach":
        await runCommitAction("detach", ctx, { sha: c.other, subject: "x" } as never);
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
        // The door's own stash — below the stop's, when the stop is a stash.
        await stashesView.applyStash(repos, git(c.dir, "stash", "list", "--format=%gd %s").split("\n").find((l) => l.endsWith("the door's stash"))!.split(" ")[0], refresh);
        break;
      case "stash pop":
        await stashesView.popStash(repos, git(c.dir, "stash", "list", "--format=%gd %s").split("\n").find((l) => l.endsWith("the door's stash"))!.split(" ")[0], refresh);
        break;
      case "pull (status bar)":
      case "sync (status bar)": {
        const item = new SyncStatusItem(repos);
        try {
          await (item as unknown as { runAction(a: unknown, id: string): Promise<void> }).runAction(
            entry,
            door.startsWith("pull") ? "pull" : "sync",
          );
        } finally {
          item.dispose();
        }
        break;
      }
    }
  } finally {
    ctx.dispose();
  }
}

const OPERATION: Record<Stop, RegExp> = {
  merge: /A merge is still in progress/,
  rebase: /A rebase is still in progress/,
  "cherry-pick": /A cherry-pick is still in progress/,
  revert: /A revert is still in progress/,
  am: /Applying patches \(git am\) is still in progress/,
  stash: /1 file is still conflicted/,
};

for (const stop of ["merge", "rebase", "cherry-pick", "revert", "am", "stash"] as Stop[]) {
  for (const resolved of [false, true]) {
    // A conflicted stash pop, resolved, is no stop: no operation, nothing
    // unmerged — the user's changes, which is inTheWayStateTable's business.
    if (stop === "stash" && resolved) continue;
    for (const door of DOORS) {
      test(`${stop}${resolved ? ", resolved" : ", conflicted"} × ${door}`, async () => {
        const c = stopped(stop, resolved);
        vscode.__said.length = 0;
        filed.length = 0;
        asked = [];
        const before = state(c.dir);
        await press(door, c);
        await new Promise((r) => setTimeout(r, 10)); // fire-and-forget toasts land
        const said = vscode.__said.map((s) => `${s.kind}: ${s.message}`).join("\n");
        assert.deepEqual(filed, [], `nothing filed:\n${said}`);
        assert.doesNotMatch(said, /^error:/m, `no red error:\n${said}`);
        assert.doesNotMatch(
          said,
          /fatal:|error:|hint:|overwritten by|not possible|not concluded|rebase-merge directory|'git am' is in progress/,
          `never git's words:\n${said}`,
        );
        assert.ok(!asked.includes("Your uncommitted changes are in the way"), `the stop's files are never offered to a stash:\n${said}`);
        const ran = /^status: \$\(check\)/m.test(said);
        if (ran) {
          // git let it run: only a stash applied over a staged resolution may.
          assert.ok(door.startsWith("stash") && resolved, `${door} never runs over a stopped operation:\n${said}`);
          assert.ok(state(c.dir).includes(JSON.parse(before).markers), "the operation still stopped");
          return;
        }
        // Sync fetches before it pulls (to surface a transport failure as
        // itself); a fetch moves remote-tracking refs and nothing of the stop.
        const now = state(c.dir);
        const fetchedOnly = (s: string): string => JSON.stringify({ ...JSON.parse(s), remotes: undefined });
        assert.equal(
          door === "sync (status bar)" ? fetchedOnly(now) : now,
          door === "sync (status bar)" ? fetchedOnly(before) : before,
          `the stop exactly as it was — HEAD, markers, index, files, stashes${door === "sync (status bar)" ? "" : ", nothing fetched"}:\n${said}`,
        );
        assert.match(said, OPERATION[stop], `says what is stopped:\n${said}`);
      });
    }
  }
}
