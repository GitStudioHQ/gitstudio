import { test } from "node:test";
import assert from "node:assert/strict";
import type { CommitFileChange } from "@gitstudio/host-bridge/commitDetailsProtocol";
import { folderTally, listRows, treeRows, type FilesRow } from "../src/filesTree";
import { fileTree } from "@gitstudio/engine/fileTree";

// "Files changed" as a folder tree (#81): the rows the commit details pane
// draws, from the one tree builder a pull request's Files tab uses too.

const f = (path: string, additions = 1, deletions = 0, extra: Partial<CommitFileChange> = {}): CommitFileChange => ({
  path,
  status: "M",
  additions,
  deletions,
  ...extra,
});

/** Rows as an outline: two spaces a level, a folder ending in "/", its sums after it. */
const outline = (rows: FilesRow[]): string[] =>
  rows.map((r) =>
    r.kind === "dir"
      ? `${"  ".repeat(r.level - 1)}${r.name}/ ${r.expanded ? "" : "(closed) "}+${r.tally.additions} -${r.tally.deletions} [${r.tally.files}]`
      : `${"  ".repeat(r.level - 1)}${r.file.path.slice(r.file.path.lastIndexOf("/") + 1)}`,
  );

test("folders nest, folders come before files, and each is by name", () => {
  const rows = treeRows([
    f("src/graph/main.ts"),
    f("README.md"),
    f("src/b.ts"),
    f("src/a.ts"),
    f("src/graph/avatar.ts"),
    f("docs/guide.md"),
    f("LICENSE"),
  ]);
  assert.deepEqual(outline(rows), [
    "docs/ +1 -0 [1]",
    "  guide.md",
    "src/ +4 -0 [4]",
    "  graph/ +2 -0 [2]",
    "    avatar.ts",
    "    main.ts",
    "  a.ts",
    "  b.ts",
    "LICENSE",
    "README.md",
  ]);
});

test("a folder holding nothing but one folder is one row, as VS Code compacts it", () => {
  const rows = treeRows([
    f("packages/webview-ui/src/graph/main.ts"),
    f("packages/webview-ui/src/commit-details.ts"),
    f("packages/engine/src/fileTree.ts"),
  ]);
  assert.deepEqual(outline(rows), [
    "packages/ +3 -0 [3]",
    "  engine/src/ +1 -0 [1]",
    "    fileTree.ts",
    "  webview-ui/src/ +2 -0 [2]",
    "    graph/ +1 -0 [1]",
    "      main.ts",
    "    commit-details.ts",
  ]);
  const chain = rows.find((r) => r.kind === "dir" && r.name === "webview-ui/src");
  assert.ok(chain && chain.kind === "dir");
  assert.equal(chain.path, "packages/webview-ui/src", "a compacted folder knows its whole path");
  assert.equal(chain.key, "d:packages/webview-ui/src");
  // A chain all the way down to the only file is one row too.
  assert.deepEqual(outline(treeRows([f("a/b/c/deep.ts")])), ["a/b/c/ +1 -0 [1]", "  deep.ts"]);
});

test("a folder's sums are everything under it; a binary file has no counts and adds nothing", () => {
  const rows = treeRows([
    f("assets/logo.png", -1, -1, { status: "A" }),
    f("assets/icons/x.svg", 12, 3),
    f("assets/icons/y.png", -1, -1),
    f("src/one.ts", 40, 2),
    f("src/deep/two.ts", 5, 7),
  ]);
  assert.deepEqual(outline(rows), [
    "assets/ +12 -3 [3]",
    "  icons/ +12 -3 [2]",
    "    x.svg",
    "    y.png",
    "  logo.png",
    "src/ +45 -9 [2]",
    "  deep/ +5 -7 [1]",
    "    two.ts",
    "  one.ts",
  ]);
  // A folder of nothing but binary files: counted, and nothing to add up.
  const [bin] = fileTree([f("img/a.png", -1, -1), f("img/b.png", -1, -1)]);
  assert.deepEqual(folderTally(bin), { files: 2, additions: 0, deletions: 0 });
});

test("a renamed file sits under its new path and keeps where it came from", () => {
  const moved = f("src/new/name.ts", 1, 1, { status: "R", oldPath: "lib/old/name.ts" });
  const rows = treeRows([moved, f("lib/kept.ts")]);
  assert.deepEqual(outline(rows), ["lib/ +1 -0 [1]", "  kept.ts", "src/new/ +1 -1 [1]", "  name.ts"]);
  const row = rows.find((r) => r.kind === "file" && r.file.path === "src/new/name.ts");
  assert.ok(row && row.kind === "file");
  assert.equal(row.file, moved, "the row carries the file as the host sent it, old path and all");
  assert.equal(row.file.oldPath, "lib/old/name.ts");
});

test("files at the root sit at the top level, after the folders", () => {
  const rows = treeRows([f("package.json"), f("src/x.ts"), f(".gitignore")]);
  assert.deepEqual(outline(rows), ["src/ +1 -0 [1]", "  x.ts", ".gitignore", "package.json"]);
  const root = rows.filter((r) => r.level === 1);
  assert.deepEqual(root.map((r) => [r.posinset, r.setsize]), [[1, 3], [2, 3], [3, 3]], "each top-level row says where it is among the three");
});

test("a closed folder hides what is under it, and only that", () => {
  const files = [f("src/graph/main.ts"), f("src/graph/gutter.ts"), f("src/a.ts"), f("test/a.test.ts")];
  const rows = treeRows(files, new Set(["src/graph"]));
  assert.deepEqual(outline(rows), [
    "src/ +3 -0 [3]",
    "  graph/ (closed) +2 -0 [2]",
    "  a.ts",
    "test/ +1 -0 [1]",
    "  a.test.ts",
  ]);
  const closed = rows.find((r) => r.kind === "dir" && r.path === "src/graph");
  assert.ok(closed && closed.kind === "dir" && !closed.expanded);
  // Closing the outer folder hides the inner one, whatever it was.
  assert.deepEqual(outline(treeRows(files, new Set(["src"]))), ["src/ (closed) +3 -0 [3]", "test/ +1 -0 [1]", "  a.test.ts"]);
});

test("each row says its level and its place among its siblings, and its key is unique", () => {
  const rows = treeRows([f("a/x.ts"), f("a/y.ts"), f("b/z.ts"), f("r.ts")]);
  const places = rows.map((r) => `${r.key} ${r.level} ${r.posinset}/${r.setsize}`);
  assert.deepEqual(places, ["d:a 1 1/3", "f:a/x.ts 2 1/2", "f:a/y.ts 2 2/2", "d:b 1 2/3", "f:b/z.ts 2 1/1", "f:r.ts 1 3/3"]);
  assert.equal(new Set(rows.map((r) => r.key)).size, rows.length);
});

test("the list keeps the host's order, every row a top-level row with the same key the tree gives it", () => {
  const files = [f("z.ts"), f("src/b.ts"), f("src/a.ts")];
  const rows = listRows(files);
  assert.deepEqual(rows.map((r) => r.file.path), ["z.ts", "src/b.ts", "src/a.ts"]);
  assert.ok(rows.every((r) => r.level === 1 && r.setsize === 3));
  assert.deepEqual(rows.map((r) => r.posinset), [1, 2, 3]);
  const treeKeys = new Set(treeRows(files).map((r) => r.key));
  assert.ok(rows.every((r) => treeKeys.has(r.key)), "switching keeps a file's row (and the keyboard's place) by its key");
});

test("the pull request's Files tab gets the tree it always had, from the shared builder", async () => {
  // A fixed tree, not "the same as the commit pane's": both call one builder
  // now, so comparing them proves nothing. This is the shape the PR page's
  // own builder produced before it moved (engine prPage tests pin it too).
  const { fileTree: prTree } = await import("@gitstudio/engine/forge/prPage");
  const prFile = (path: string) => ({ path, status: "modified" as const, additions: 1, deletions: 0, noDiff: false });
  const tree = prTree(["src/pr/b.ts", "src/pr/a.ts", "README.md", "packages/engine/src/forge/prPage.ts", "src/x.ts", "/lead/x.ts"].map(prFile));
  const shape = (nodes: typeof tree): unknown =>
    nodes.map((n) => (n.kind === "dir" ? { [`${n.name} @ ${n.path}`]: shape(n.children) } : n.file.path));
  assert.deepEqual(shape(tree), [
    { "lead @ lead": ["/lead/x.ts"] },
    { "packages/engine/src/forge @ packages/engine/src/forge": ["packages/engine/src/forge/prPage.ts"] },
    { "src @ src": [{ "pr @ src/pr": ["src/pr/a.ts", "src/pr/b.ts"] }, "src/x.ts"] },
    "README.md",
  ]);
});
