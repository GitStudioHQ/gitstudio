// The shared git tool catalog — the words and arguments the in-app agent and the
// MCP server both show a model. Each tool is driven against a scripted host that
// records the exact primitive call it received, so these tests pin (a) how a
// model's loose arguments are normalised before they reach git, (b) what the
// model reads back for real-looking repository state, and (c) that bad input is
// refused without touching the host.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GIT_TOOLS,
  selectTools,
  toolByName,
  type GitToolHost,
  type ToolCommit,
  type ToolWriteResult,
} from "../src/gitTools";

type Call = [string, ...unknown[]];

/** A host whose answers are given per method; every call is recorded with its args. */
function scriptedHost(answers: Partial<Record<keyof GitToolHost, unknown>> = {}): { host: GitToolHost; calls: Call[] } {
  const calls: Call[] = [];
  const host = new Proxy({} as GitToolHost, {
    get(_t, prop: string) {
      if (prop === "repoRoot") return () => "/work/repo";
      return async (...args: unknown[]) => {
        calls.push([prop, ...args]);
        const a = answers[prop as keyof GitToolHost];
        return typeof a === "function" ? (a as (...x: unknown[]) => unknown)(...args) : a;
      };
    },
  });
  return { host, calls };
}

async function run(name: string, host: GitToolHost, args: Record<string, unknown> = {}) {
  const tool = toolByName(name);
  assert.ok(tool, `tool ${name} exists`);
  return tool.run(host, args);
}

// 2024-01-02T03:04:05Z
const T = Date.UTC(2024, 0, 2, 3, 4, 5) / 1000;
const commit = (n: number, subject: string): ToolCommit => ({
  sha: `${n}`.repeat(40),
  shortSha: `${n}`.repeat(7),
  subject,
  author: "Ada",
  date: T,
});

// ── catalog shape ────────────────────────────────────────────────────────────

test("every tool has a unique name, a title, a description and an object schema", () => {
  const names = GIT_TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, "names are unique");
  for (const t of GIT_TOOLS) {
    assert.ok(t.title.length > 0 && t.description.length > 20, `${t.name} is described`);
    assert.equal(t.parameters.type, "object", `${t.name} takes an object`);
    // Every required argument is a declared property.
    for (const r of (t.parameters.required as string[] | undefined) ?? []) {
      assert.ok(t.parameters.properties && r in t.parameters.properties, `${t.name}.${r} declared`);
    }
    // Only read tools are advertised as idempotent.
    if (t.idempotent) assert.equal(t.mode, "read", `${t.name} idempotent => read`);
  }
});

test("destructive tools are exactly discard, delete-branch and reset", () => {
  assert.deepEqual(
    GIT_TOOLS.filter((t) => t.mode === "destructive").map((t) => t.name),
    ["git_discard", "git_delete_branch", "git_reset"],
  );
  assert.deepEqual(
    selectTools({ destructive: true }).filter((t) => t.mode !== "read").map((t) => t.name),
    ["git_discard", "git_delete_branch", "git_reset"],
    "destructive opt-in alone does not also expose plain writes",
  );
});

test("toolByName finds a tool and answers undefined for an unknown one", () => {
  assert.equal(toolByName("git_status")?.title, "Working tree status");
  assert.equal(toolByName("rm_rf"), undefined);
});

// ── read tools ───────────────────────────────────────────────────────────────

test("git_status reports a clean tree with the repo root", async () => {
  const { host } = scriptedHost({ status: [] });
  const r = await run("git_status", host);
  assert.equal(r.text, "Working tree clean (/work/repo).");
  assert.deepEqual(r.data, { files: [] });
});

test("git_status lists each file with its staged column and counts the staged ones", async () => {
  const files = [
    { path: "src/a.ts", status: "M", staged: true },
    { path: "b.md", status: "??", staged: false },
    { path: "c.ts", status: "D", staged: false },
  ];
  const { host } = scriptedHost({ status: files });
  const r = await run("git_status", host);
  assert.equal(
    r.text,
    ["3 changed file(s), 1 staged — /work/repo", "staged   M  src/a.ts", "unstaged ?? b.md", "unstaged D  c.ts"].join("\n"),
  );
  assert.deepEqual(r.data, { files });
});

test("git_log defaults to 20, caps at 200, and forwards ref and path", async () => {
  const { host, calls } = scriptedHost({ log: [commit(1, "feat: one"), commit(2, "fix: two")] });
  const r = await run("git_log", host, { limit: 5000, ref: " main ", path: "src/x.ts" });
  await run("git_log", host, { limit: "ten", ref: "   " });
  assert.deepEqual(calls, [
    ["log", { limit: 200, ref: "main", path: "src/x.ts" }],
    ["log", { limit: 20, ref: undefined, path: undefined }],
  ]);
  assert.equal(
    r.text,
    "1111111  feat: one  — Ada, 2024-01-02 03:04Z\n2222222  fix: two  — Ada, 2024-01-02 03:04Z",
  );
});

test("git_log says so when there is no history", async () => {
  const { host } = scriptedHost({ log: [] });
  const r = await run("git_log", host);
  assert.equal(r.text, "No commits found.");
  assert.deepEqual(r.data, { commits: [] });
});

test("git_show formats a commit with body, parents and files", async () => {
  const detail = {
    ...commit(3, "feat: add parser"),
    body: "\nLonger explanation.\n\n",
    committer: "Bob",
    parents: ["aaaa", "bbbb"],
    files: [
      { path: "src/parser.ts", status: "A", staged: false },
      { path: "README.md", status: "M", staged: false },
    ],
  };
  const { host, calls } = scriptedHost({ show: detail });
  const r = await run("git_show", host, { sha: " HEAD~1 " });
  assert.deepEqual(calls, [["show", "HEAD~1"]]);
  assert.equal(
    r.text,
    [
      "3333333  feat: add parser",
      "Author: Ada   2024-01-02 03:04Z",
      "Parents: aaaa, bbbb",
      "",
      "Longer explanation.",
      "",
      "Files:",
      "  A  src/parser.ts",
      "  M  README.md",
    ].join("\n"),
  );
  assert.equal(r.isError, undefined);
});

test("git_show marks a root commit and leaves out an empty body and file list", async () => {
  const { host } = scriptedHost({ show: { ...commit(4, "init"), date: 0, body: "  ", committer: "", parents: [], files: [] } });
  const r = await run("git_show", host, { sha: "abc" });
  // An unknown (zero) date renders as nothing rather than 1970.
  assert.equal(r.text, "4444444  init\nAuthor: Ada   \nParents: (root)");
});

test("git_show refuses a missing sha and reports an unknown one", async () => {
  const { host, calls } = scriptedHost({ show: undefined });
  const missing = await run("git_show", host, { sha: "  " });
  assert.deepEqual([missing.text, missing.isError], ["A commit SHA or ref is required.", true]);
  assert.equal(calls.length, 0, "the host is not asked");
  const unknown = await run("git_show", host, { sha: "deadbeef" });
  assert.deepEqual([unknown.text, unknown.isError], ["Commit not found: deadbeef", true]);
});

test("git_diff passes only a literal `true` as staged and says when nothing differs", async () => {
  const { host, calls } = scriptedHost({ diff: "diff --git a/x b/x\n+new\n" });
  const r = await run("git_diff", host, { staged: true, path: "x", base: "main", head: " topic " });
  await run("git_diff", host, { staged: "yes" });
  assert.deepEqual(calls, [
    ["diff", { staged: true, path: "x", base: "main", head: "topic" }],
    ["diff", { staged: false, path: undefined, base: undefined, head: undefined }],
  ]);
  assert.equal(r.text, "diff --git a/x b/x\n+new\n", "the diff is returned verbatim");

  const empty = scriptedHost({ diff: "\n" });
  const none = await run("git_diff", empty.host);
  assert.equal(none.text, "(no differences)");
  assert.deepEqual(none.data, { diff: "\n" });
});

test("git_branches marks the current branch and shows upstream and ahead/behind", async () => {
  const branches = [
    { name: "main", current: true, upstream: "origin/main", ahead: 1, behind: 2, subject: "tip of main" },
    { name: "topic", current: false, ahead: 0, behind: 0, subject: "wip" },
  ];
  const { host } = scriptedHost({ branches });
  const r = await run("git_branches", host);
  assert.equal(r.text, "* main → origin/main  ↑1 ↓2  tip of main\n  topic  ↑0 ↓0  wip");
  const none = await run("git_branches", scriptedHost({ branches: [] }).host);
  assert.equal(none.text, "No branches.");
});

test("git_current_branch reports a branch, or a detached HEAD by short sha", async () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const onBranch = await run("git_current_branch", scriptedHost({ head: { branch: "main", detached: false, sha } }).host);
  assert.equal(onBranch.text, "HEAD on branch main (01234567).");
  const detached = await run("git_current_branch", scriptedHost({ head: { detached: true, sha } }).host);
  assert.equal(detached.text, "HEAD detached at 01234567 (01234567).");
});

test("git_stashes lists each stash with its time, or says there are none", async () => {
  const stashes = [{ ref: "stash@{0}", message: "WIP on main: abc", time: T }];
  const r = await run("git_stashes", scriptedHost({ stashes }).host);
  assert.equal(r.text, "stash@{0}: WIP on main: abc (2024-01-02 03:04Z)");
  assert.deepEqual(r.data, { stashes });
  assert.equal((await run("git_stashes", scriptedHost({ stashes: [] }).host)).text, "No stashes.");
});

test("git_search_commits needs a query, caps the limit at 100 and formats hits", async () => {
  const { host, calls } = scriptedHost({ searchCommits: [commit(5, "fix: parser crash")] });
  const refused = await run("git_search_commits", host, {});
  assert.deepEqual([refused.text, refused.isError], ["A search query is required.", true]);
  const r = await run("git_search_commits", host, { query: " parser ", limit: 1000 });
  await run("git_search_commits", host, { query: "x" });
  assert.deepEqual(calls, [
    ["searchCommits", "parser", 100],
    ["searchCommits", "x", 20],
  ]);
  assert.equal(r.text, "5555555  fix: parser crash  — Ada, 2024-01-02 03:04Z");
  const none = await run("git_search_commits", scriptedHost({ searchCommits: [] }).host, { query: "zzz" });
  assert.equal(none.text, "No matching commits.");
});

test("read_file returns text, flags truncation, and never dumps a binary", async () => {
  const { host, calls } = scriptedHost({
    readFile: (path: string) =>
      path === "big.log"
        ? { path, text: "first part", truncated: true, binary: false }
        : path === "logo.png"
          ? { path, text: "", truncated: false, binary: true }
          : path === "src/a.ts"
            ? { path, text: "export {};\n", truncated: false, binary: false }
            : undefined,
  });
  assert.equal((await run("read_file", host, { path: "src/a.ts", ref: "v1" })).text, "export {};\n");
  assert.equal((await run("read_file", host, { path: "big.log" })).text, "big.log (truncated — file exceeds the size cap):\n\nfirst part");
  const bin = await run("read_file", host, { path: "logo.png" });
  assert.deepEqual([bin.text, bin.isError], ["logo.png is binary (not shown).", false]);
  const missing = await run("read_file", host, { path: "nope.txt" });
  assert.deepEqual([missing.text, missing.isError], ["File not found: nope.txt", true]);
  const noPath = await run("read_file", host, { path: 42 });
  assert.deepEqual([noPath.text, noPath.isError], ["A file path is required.", true]);
  assert.deepEqual(calls[0], ["readFile", "src/a.ts", "v1"]);
  assert.deepEqual(calls[1], ["readFile", "big.log", undefined]);
  assert.equal(calls.length, 4, "the path-less call never reached the host");
});

test("git_compare defaults head to HEAD and lists commits and files", async () => {
  const { host, calls } = scriptedHost({
    compare: {
      ahead: 2,
      behind: 1,
      commits: [commit(6, "feat: a"), commit(7, "feat: b")],
      files: [{ path: "a.ts", status: "M", staged: false }],
    },
  });
  const r = await run("git_compare", host, { base: "main" });
  assert.deepEqual(calls, [["compare", "main", "HEAD"]]);
  assert.equal(
    r.text,
    [
      "main…HEAD: ↑2 ↓1",
      "Commits:",
      "  6666666  feat: a  — Ada, 2024-01-02 03:04Z",
      "  7777777  feat: b  — Ada, 2024-01-02 03:04Z",
      "Files:",
      "  M  a.ts",
    ].join("\n"),
  );
});

test("git_compare with nothing between the refs prints just the counts", async () => {
  const r = await run("git_compare", scriptedHost({ compare: { ahead: 0, behind: 0, commits: [], files: [] } }).host, {
    base: "main",
    head: "topic",
  });
  assert.equal(r.text, "main…topic: ↑0 ↓0");
});

test("git_compare needs a base and reports refs it cannot compare", async () => {
  const { host, calls } = scriptedHost({ compare: undefined });
  const noBase = await run("git_compare", host, { head: "x" });
  assert.deepEqual([noBase.text, noBase.isError], ["A base ref is required.", true]);
  assert.equal(calls.length, 0);
  const bad = await run("git_compare", host, { base: "nope", head: "topic" });
  assert.deepEqual([bad.text, bad.isError], ["Couldn't compare nope…topic.", true]);
});

// ── write tools ──────────────────────────────────────────────────────────────

const OK: ToolWriteResult = { ok: true };

test("git_stage stages everything, a list, or a single string path", async () => {
  const { host, calls } = scriptedHost({ stage: OK });
  assert.equal((await run("git_stage", host, { all: true, paths: ["ignored"] })).text, "Staged all changes.");
  assert.equal((await run("git_stage", host, { paths: ["a.ts", "", 7, "   ", "b.ts"] })).text, "Staged 2 path(s).");
  assert.equal((await run("git_stage", host, { paths: "only.ts" })).text, "Staged 1 path(s).");
  assert.deepEqual(calls, [
    ["stage", "all"],
    // Blank and non-string entries are dropped.
    ["stage", ["a.ts", "b.ts"]],
    ["stage", ["only.ts"]],
  ]);
});

test("git_stage and git_unstage refuse when no usable path is given", async () => {
  const { host, calls } = scriptedHost({ stage: OK, unstage: OK });
  for (const name of ["git_stage", "git_unstage"]) {
    for (const args of [{}, { paths: [] }, { paths: ["", "  "] }, { all: "true" }]) {
      const r = await run(name, host, args);
      assert.deepEqual([r.text, r.isError], ["Provide `paths` or `all: true`.", true], `${name} ${JSON.stringify(args)}`);
    }
  }
  assert.equal(calls.length, 0);
});

test("git_unstage forwards all or the paths", async () => {
  const { host, calls } = scriptedHost({ unstage: OK });
  assert.equal((await run("git_unstage", host, { all: true })).text, "Unstaged.");
  await run("git_unstage", host, { paths: ["x"] });
  assert.deepEqual(calls, [
    ["unstage", "all"],
    ["unstage", ["x"]],
  ]);
});

test("git_commit sends the trimmed message and amends only on a literal true", async () => {
  const { host, calls } = scriptedHost({ commit: OK });
  const r = await run("git_commit", host, { message: "  feat: x\n\nbody  " });
  await run("git_commit", host, { message: "fix", amend: true });
  await run("git_commit", host, { message: "fix", amend: "true" });
  assert.equal(r.text, "Committed.");
  assert.deepEqual(r.data, OK);
  assert.deepEqual(calls, [
    ["commit", "feat: x\n\nbody", false],
    ["commit", "fix", true],
    ["commit", "fix", false],
  ]);
  const refused = await run("git_commit", scriptedHost().host, { message: "   " });
  assert.deepEqual([refused.text, refused.isError], ["A commit message is required.", true]);
});

test("a failed write reports the host's reason, or a generic one, as an error", async () => {
  const withReason = await run("git_commit", scriptedHost({ commit: { ok: false, message: "nothing to commit" } }).host, {
    message: "x",
  });
  assert.deepEqual([withReason.text, withReason.isError], ["nothing to commit", true]);
  assert.deepEqual(withReason.data, { ok: false, message: "nothing to commit" });
  const bare = await run("git_commit", scriptedHost({ commit: { ok: false } }).host, { message: "x" });
  assert.deepEqual([bare.text, bare.isError], ["The operation failed.", true]);
});

test("a successful write appends the host's extra message", async () => {
  const r = await run("git_checkout", scriptedHost({ checkout: { ok: true, message: "Your branch is up to date." } }).host, {
    ref: "main",
  });
  assert.equal(r.text, "Checked out main.\nYour branch is up to date.");
  assert.equal(r.isError, undefined);
});

test("git_create_branch and git_checkout validate their names", async () => {
  const { host, calls } = scriptedHost({ createBranch: OK, checkout: OK });
  assert.equal((await run("git_create_branch", host, { name: "feat/x", checkout: true })).text, "Created branch feat/x.");
  await run("git_create_branch", host, { name: "feat/y" });
  assert.deepEqual((await run("git_create_branch", host, {})).text, "A branch name is required.");
  assert.equal((await run("git_checkout", host, { ref: " topic " })).text, "Checked out topic.");
  const noRef = await run("git_checkout", host, { ref: "" });
  assert.deepEqual([noRef.text, noRef.isError], ["A ref is required.", true]);
  assert.deepEqual(calls, [
    ["createBranch", "feat/x", true],
    ["createBranch", "feat/y", false],
    ["checkout", "topic"],
  ]);
});

test("git_stash_save passes an optional message and the untracked flag", async () => {
  const { host, calls } = scriptedHost({ stashSave: OK });
  assert.equal((await run("git_stash_save", host, { message: "wip", includeUntracked: true })).text, "Stashed changes.");
  await run("git_stash_save", host, {});
  assert.deepEqual(calls, [
    ["stashSave", "wip", true],
    ["stashSave", undefined, false],
  ]);
});

// ── destructive tools ────────────────────────────────────────────────────────

test("git_discard needs at least one path and counts what it discarded", async () => {
  const { host, calls } = scriptedHost({ discard: OK });
  assert.equal((await run("git_discard", host, { paths: ["a", "b"] })).text, "Discarded changes to 2 path(s).");
  const none = await run("git_discard", host, { paths: [] });
  assert.deepEqual([none.text, none.isError], ["At least one path is required.", true]);
  assert.deepEqual(calls, [["discard", ["a", "b"]]]);
});

test("git_delete_branch force-deletes only on a literal true", async () => {
  const { host, calls } = scriptedHost({ deleteBranch: OK });
  assert.equal((await run("git_delete_branch", host, { name: "old", force: true })).text, "Deleted branch old.");
  await run("git_delete_branch", host, { name: "old2", force: 1 });
  const noName = await run("git_delete_branch", host, {});
  assert.deepEqual([noName.text, noName.isError], ["A branch name is required.", true]);
  assert.deepEqual(calls, [
    ["deleteBranch", "old", true],
    ["deleteBranch", "old2", false],
  ]);
});

test("git_reset accepts only soft, mixed or hard, and needs a ref", async () => {
  const { host, calls } = scriptedHost({ reset: OK });
  assert.equal((await run("git_reset", host, { mode: "hard", ref: "HEAD~1" })).text, "Reset (hard) to HEAD~1.");
  const badMode = await run("git_reset", host, { mode: "keep", ref: "HEAD" });
  assert.deepEqual([badMode.text, badMode.isError], ["mode must be soft, mixed, or hard.", true]);
  const noRef = await run("git_reset", host, { mode: "soft" });
  assert.deepEqual([noRef.text, noRef.isError], ["A target ref is required.", true]);
  assert.deepEqual(calls, [["reset", "hard", "HEAD~1"]]);
});
