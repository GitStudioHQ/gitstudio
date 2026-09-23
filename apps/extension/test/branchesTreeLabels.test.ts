import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import Module from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "@gitstudio/git-service/GitContext";

// The Branches view's tree (issue #30's follow-up). The chips, menus and the
// status item name a ref by its full name under the namespace; the tree still
// labelled every row with git's %(refname:short) — only shortest-unambiguous,
// so a branch beside a tag of its name read "heads/release", the tag
// "tags/release", and a remote-tracking branch beside a LOCAL "origin/sl" read
// "remotes/origin/sl". And the remote's HEAD pointer sat under Remotes as a
// row called "origin" — a pointer, not a branch, whose Checkout could only
// fail. The tree imports `vscode`, so this loads the REAL branchesView.ts with
// `vscode` swapped for a stand-in and feeds it what real git lists.

const CFG = join(mkdtempSync(join(tmpdir(), "gs-ext-btl-cfg-")), "config");
writeFileSync(CFG, "");
process.env.GIT_CONFIG_GLOBAL = CFG;
process.env.GIT_CONFIG_SYSTEM = CFG;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_OPTIONAL_LOCKS = "0";

class TreeItem {
  constructor(
    public label: string,
    public collapsibleState?: number,
  ) {}
}
class EventEmitter {
  event = () => ({ dispose() {} });
  fire() {}
  dispose() {}
}
class MarkdownString {
  value = "";
  appendMarkdown(s: string) {
    this.value += s;
    return this;
  }
}
const vscodeStub = {
  TreeItem,
  EventEmitter,
  MarkdownString,
  ThemeIcon: class {
    constructor(public id: string) {}
  },
  ThemeColor: class {
    constructor(public id: string) {}
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
};

type Resolve = (request: string, parent: unknown, ...rest: unknown[]) => string;
const M = Module as unknown as { _resolveFilename: Resolve; _cache: Record<string, unknown> };
const STUB = join(tmpdir(), "__gs_btl_vscode_stub__.js");
const origResolve = M._resolveFilename;

let up: string;
let repo: string;
let ctx: GitContext;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let RefsTreeProvider: any;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

before(() => {
  M._cache[STUB] = { id: STUB, filename: STUB, loaded: true, exports: vscodeStub };
  M._resolveFilename = function (request: string, parent: unknown, ...rest: unknown[]) {
    return request === "vscode" ? STUB : origResolve.call(this, request, parent, ...rest);
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ({ RefsTreeProvider } = require("../src/views/branchesView"));

  up = mkdtempSync(join(tmpdir(), "gs-ext-btl-up-"));
  git(up, "init", "-q", "--bare", "-b", "main");
  repo = mkdtempSync(join(tmpdir(), "gs-ext-btl-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t.t");
  git(repo, "config", "user.name", "T");
  git(repo, "remote", "add", "origin", up);
  writeFileSync(join(repo, "f.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  git(repo, "tag", "release");
  git(repo, "branch", "release");
  git(repo, "push", "-q", "origin", "refs/heads/main:refs/heads/main", "refs/heads/main:refs/heads/sl");
  git(repo, "fetch", "-q", "origin");
  git(repo, "remote", "set-head", "origin", "main");
  git(repo, "branch", "origin/sl", "refs/heads/main");
  ctx = new GitContext({ root: repo });
});

after(() => {
  M._resolveFilename = origResolve;
  delete M._cache[STUB];
  ctx?.dispose();
  rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(up, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("the tree names each ref by its full name under the namespace, and lists no HEAD pointer", async () => {
  const listed = await ctx.refs.listRefs();
  const short = (full: string) => listed.find((r) => r.fullName === full)?.name;
  assert.equal(short("refs/heads/release"), "heads/release", "git's short form, beside the tag");
  assert.equal(short("refs/remotes/origin/sl"), "remotes/origin/sl", "…and beside a local origin/sl");

  const tree = new RefsTreeProvider({ getActive: () => ({ root: repo, ctx }), onDidChange: () => ({ dispose() {} }) });
  const cats = await tree.getChildren();
  const labels = async (i: number): Promise<string[]> => (await tree.getChildren(cats[i])).map((n: TreeItem) => n.label);
  const local = await labels(0);
  const remotes = await labels(1);
  const tags = await labels(2);
  assert.ok(local.includes("release"), `Local reads "release": ${JSON.stringify(local)}`);
  assert.ok(local.includes("origin/sl"), "a local branch named like a remote one keeps its name");
  assert.deepEqual(tags, ["release"], "the tag reads \"release\"");
  assert.deepEqual([...remotes].sort(), ["origin/main", "origin/sl"], "the remote branches by their own names, no \"origin\" pointer row");
  for (const l of [...local, ...remotes, ...tags]) {
    assert.doesNotMatch(l, /^(heads|tags|remotes)\//, `no row reads as git's disambiguated short form (${l})`);
  }
  assert.equal(cats[1].description, "2", "and the Remotes count is the branches it lists");
});

test("the Changes view's branch menu leaves the HEAD pointer out of its remotes too", async () => {
  // Its twin, pinned at source level (the view imports vscode throughout):
  // the pointer's short name is the bare remote ("origin"), so the menu's old
  // `!name.endsWith("/HEAD")` never matched it.
  const listed = await ctx.refs.listRefs();
  const pointer = listed.find((r) => r.fullName === "refs/remotes/origin/HEAD");
  assert.equal(pointer?.name, "origin", "what git calls it");
  assert.ok(pointer?.symref, "and what marks it");
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/changes/commitView.ts", import.meta.url), "utf8");
  assert.match(src, /\.filter\(\(r\) => r\.type === "remote" && !r\.symref && !r\.name\.endsWith\("\/HEAD"\)\)/);
});
