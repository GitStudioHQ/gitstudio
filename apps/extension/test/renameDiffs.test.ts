// Every "show me this change" surface reads each side of its diff under the
// name the file had THERE — against a real repository with a rename in its
// history, a staged rename, and a file deleted from the working tree.
//
// Built from today's name, a side at a revision older than the rename reads a
// path that does not exist there, and the content provider answers "" for it:
//   · blame Show Diff on a line older than a rename — both sides empty;
//   · the graph's details for the rename commit — the parent side empty, so
//     the file showed as entirely added;
//   · the Changes view's staged rename — HEAD read at the new name, the whole
//     file shown as added (and the same in the eager window, before vscode.git);
//   · file history Back/Forward, the Timeline and Line History — empty diffs
//     for every commit before the rename.
// And a deleted working-tree file diffed against the file URI of a path that
// is not on disk; it now reads as nothing.
//
// Each side is resolved the way the content provider resolves it (rev +
// the path it reads) and checked with `git cat-file -e`: a side that exists
// in git, or one that is deliberately empty (the empty tree).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { changesHost, scratchRepo } from "./changesHost";

/* eslint-disable @typescript-eslint/no-require-imports -- the stand-in is in place (changesHost) */
const vscode = require("vscode") as Record<string, Record<string, unknown>>;
const rev = require("../src/history/revisionContentProvider") as typeof import("../src/history/revisionContentProvider");
const { openChangeDiff, ChangeFileNode } = require("../src/changes/changesView") as typeof import("../src/changes/changesView");
const { GitContext } = require("@gitstudio/git-service/GitContext") as typeof import("@gitstudio/git-service/GitContext");
/* eslint-enable @typescript-eslint/no-require-imports */

// Enough of vscode.Uri for the URIs these surfaces build, and a recorder for
// the diffs they open.
type U = { scheme: string; path: string; query: string; fsPath: string };
const uri = (c: { scheme: string; path: string; query?: string }): U => ({
  scheme: c.scheme,
  path: c.path,
  query: c.query ?? "",
  fsPath: c.path,
});
Object.assign(vscode.Uri, {
  from: uri,
  file: (p: string) => uri({ scheme: "file", path: p }),
  // (The host's extensionUri is a bare stand-in with no path.)
  joinPath: (base: U, ...segs: string[]) => uri({ scheme: "file", path: join(base.fsPath ?? "/", ...segs) }),
});
const diffs: { left: U; right: U; title: string }[] = [];
vscode.commands.executeCommand = (async (id: string, ...args: unknown[]) => {
  if (id === "vscode.diff") diffs.push({ left: args[0] as U, right: args[1] as U, title: args[2] as string });
}) as never;
Object.assign(vscode.workspace, {
  fs: {
    stat: async (u: U) => {
      if (!existsSync(u.fsPath)) throw new Error("ENOENT");
      return {};
    },
  },
});

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((f) => f()));

/**
 * old.ts, edited, renamed to new.ts, edited again; then `lib.ts` renamed to
 * `lib2.ts` and staged; then gone.txt deleted from the working tree.
 */
function history(): ReturnType<typeof scratchRepo> & { shas: Record<string, string> } {
  const repo = scratchRepo("rename-diffs");
  cleanups.push(repo.done);
  const w = (n: string, t: string) => writeFileSync(join(repo.dir, n), t);
  const lines = (edit: Record<number, string>) =>
    Array.from({ length: 12 }, (_, i) => `${edit[i] ?? `line ${i}`}\n`).join("");
  const shas: Record<string, string> = {};
  const commit = (name: string) => {
    repo.git("add", "-A");
    repo.git("commit", "-qm", name);
    shas[name] = repo.git("rev-parse", "HEAD").trim();
  };
  w("old.ts", lines({}));
  w("lib.ts", lines({ 0: "lib" }));
  w("gone.txt", "doomed\n");
  commit("add");
  w("old.ts", lines({ 2: "EDITED BEFORE THE RENAME" }));
  commit("edit old");
  repo.git("mv", "old.ts", "new.ts");
  w("new.ts", lines({ 2: "EDITED BEFORE THE RENAME", 5: "EDITED IN THE RENAME" }));
  commit("rename");
  w("new.ts", lines({ 2: "EDITED BEFORE THE RENAME", 5: "EDITED IN THE RENAME", 9: "EDITED AFTER" }));
  commit("edit new");
  repo.git("mv", "lib.ts", "lib2.ts");
  unlinkSync(join(repo.dir, "gone.txt"));
  return { ...repo, shas };
}

/** Does this diff side exist in git (or is it deliberately empty)? */
function side(repo: { dir: string; git: (...a: string[]) => string }, u: U): "exists" | "empty" | "missing" {
  if (u.scheme === "file") return existsSync(u.fsPath) ? "exists" : "missing";
  const { rev: r, readPath } = rev.fromRevisionUri(u as never);
  if (r === rev.EMPTY_TREE) return "empty";
  try {
    execFileSync("git", ["cat-file", "-e", `${r}:${readPath}`], { cwd: repo.dir, stdio: "ignore" });
    return "exists";
  } catch {
    return "missing";
  }
}

function lastDiff(): { left: U; right: U; title: string } {
  const d = diffs.at(-1);
  assert.ok(d, "a diff was opened");
  return d;
}

test("blame Show Diff on a line older than the rename reads both sides under the old name", async () => {
  const repo = history();
  const ctx = new GitContext({ root: repo.dir });
  cleanups.push(() => ctx.dispose());
  const blame = await ctx.blame.blameFile("new.ts");
  const line3 = blame.lines.find((l) => l.finalLine === 3);
  const commit = blame.commits.get(line3!.sha)!;
  assert.equal(commit.sha, repo.shas["edit old"], "line 3 is from before the rename");
  diffs.length = 0;
  await rev.openSidesDiff(repo.dir, "new.ts", rev.blameChangeSides(commit, "new.ts"), "t");
  const d = lastDiff();
  assert.deepEqual([side(repo, d.left), side(repo, d.right)], ["exists", "exists"]);
  assert.equal(d.left.path, "/new.ts", "the tab keeps today's name");
});

test("blame on the line the rename commit itself changed diffs old name ↔ new name", async () => {
  const repo = history();
  const ctx = new GitContext({ root: repo.dir });
  cleanups.push(() => ctx.dispose());
  const blame = await ctx.blame.blameFile("new.ts");
  const commit = blame.commits.get(blame.lines.find((l) => l.finalLine === 6)!.sha)!;
  assert.equal(commit.sha, repo.shas["rename"]);
  const sides = rev.blameChangeSides(commit, "new.ts");
  assert.deepEqual([sides.left.path, sides.right.path], ["old.ts", "new.ts"]);
  diffs.length = 0;
  await rev.openSidesDiff(repo.dir, "new.ts", sides, "t");
  assert.deepEqual([side(repo, lastDiff().left), side(repo, lastDiff().right)], ["exists", "exists"]);
});

test("the graph's details for the rename commit read the parent under the old name", async () => {
  const repo = history();
  const ctx = new GitContext({ root: repo.dir });
  cleanups.push(() => ctx.dispose());
  const sha = repo.shas["rename"];
  const parent = repo.git("rev-parse", `${sha}~1`).trim();
  const files = await ctx.commitDetails.getCommitFiles(sha, parent);
  const f = files.find((x) => x.path === "new.ts")!;
  assert.equal(f.oldPath, "old.ts", "the details list knows the old name");
  diffs.length = 0;
  await rev.openSidesDiff(repo.dir, f.path, rev.commitChangeSides({ sha, parent, ...f }), "t");
  assert.deepEqual([side(repo, lastDiff().left), side(repo, lastDiff().right)], ["exists", "exists"]);
});

test("file history (Back/Forward, Timeline): every commit's diff has real sides, the add's parent side is empty", async () => {
  const repo = history();
  const ctx = new GitContext({ root: repo.dir });
  cleanups.push(() => ctx.dispose());
  const entries = await ctx.history.fileHistory("new.ts", { follow: true });
  assert.equal(entries.length, 4);
  const seen: string[][] = [];
  for (const e of entries) {
    diffs.length = 0;
    await rev.openSidesDiff(repo.dir, "new.ts", rev.historyChangeSides(e), "t");
    seen.push([side(repo, lastDiff().left), side(repo, lastDiff().right)]);
  }
  // Newest first: edit new, rename, edit old, add (whose parent does not exist).
  assert.deepEqual(seen, [
    ["exists", "exists"],
    ["exists", "exists"],
    ["exists", "exists"],
    ["missing", "exists"],
  ]);
});

test("the Changes view's staged rename reads HEAD under the old name (vscode.git's Change)", async () => {
  const repo = history();
  diffs.length = 0;
  const at = (p: string) => vscode.Uri.file!.call(null, join(repo.dir, p)) as never;
  await openChangeDiff(
    new ChangeFileNode("staged", repo.dir, { uri: at("lib2.ts"), originalUri: at("lib.ts"), status: 3 } as never),
  );
  assert.deepEqual([side(repo, lastDiff().left), side(repo, lastDiff().right)], ["exists", "exists"]);
});

test("the Changes view's staged rename, before vscode.git is attached, asks git for the old name", async () => {
  const repo = history();
  const host = changesHost(repo.dir);
  cleanups.push(host.dispose);
  diffs.length = 0;
  await host.send({ type: "openDiff", path: "lib2.ts", staged: true });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual([side(repo, lastDiff().left), side(repo, lastDiff().right)], ["exists", "exists"]);
});

test("a file deleted from the working tree diffs against nothing, not a missing file", async () => {
  const repo = history();
  diffs.length = 0;
  const at = (p: string) => vscode.Uri.file!.call(null, join(repo.dir, p)) as never;
  await openChangeDiff(new ChangeFileNode("unstaged", repo.dir, { uri: at("gone.txt"), status: 6 } as never));
  assert.deepEqual([side(repo, lastDiff().left), side(repo, lastDiff().right)], ["exists", "empty"]);
});

test("the content provider reads a side at the path it names, and the tab keeps today's name", () => {
  const u = rev.toRevisionUri("/r", "abc", "new.ts", "old.ts") as unknown as U;
  assert.equal(u.path, "/new.ts");
  assert.deepEqual(rev.fromRevisionUri(u as never), { root: "/r", rev: "abc", relPath: "new.ts", readPath: "old.ts" });
  const same = rev.toRevisionUri("/r", "abc", "new.ts", "new.ts") as unknown as U;
  assert.equal(rev.fromRevisionUri(same as never).readPath, "new.ts");
});

// The call sites, by source: each surface builds its sides through the
// helpers above rather than handing one path to both sides again.
const src = (p: string) => readFileSync(join(__dirname, "..", "src", p), "utf8");
test("every commit-change surface builds its sides through the rename-aware helpers", () => {
  assert.match(src("blame/blameController.ts"), /blameChangeSides\(at\.commit, rel\)/);
  assert.match(src("blame/blameController.ts"), /toRevisionUri\(at\.entry\.root, previous\.sha, rel, previous\.filename\)/);
  assert.match(src("graph/graphPanel.ts"), /commitChangeSides\(\{ sha, parent, path, oldPath, status \}\)/);
  assert.match(src("graph/graphPanel.ts"), /this\.doOpenFile\(msg\.sha, msg\.path, !!msg\.wip, msg\.oldPath, msg\.status\)/);
  assert.equal((src("history/revisionNavigation.ts").match(/historyChangeSides\(/g) ?? []).length, 2);
  assert.match(src("history/fileTimelineProvider.ts"), /historyChangeSides\(e\)/);
  assert.match(src("history/lineHistory.ts"), /commitChangeSides\(\{ sha: picked\.sha/);
  for (const f of ["blame/blameController.ts", "graph/graphPanel.ts", "history/lineHistory.ts", "history/fileTimelineProvider.ts"]) {
    assert.doesNotMatch(src(f), /`\$\{[^}]*sha\}(\^|~1)`,\s*\n?\s*(rel|path|active\.rel)\b/, `${f}: no parent side built from today's name`);
  }
});
