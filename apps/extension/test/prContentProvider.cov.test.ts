// The `gitstudio-pr` documents (src/pr/prContentProvider.ts) and the merge
// base the review's diffs are drawn from (src/pr/reviewDiff.ts diffBase):
// what each URI names, what each kind of file content becomes in the pane,
// and what a failure does — throw, never an empty pane that reads as
// "added" or "deleted".

import { vscode } from "./prTestKit";
import { test } from "node:test";
import assert from "node:assert/strict";

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports -- the stand-in's objects, loaded after it */
const { PrContentProvider, toPrContentUri, fromPrContentUri, PR_SCHEME } = require("../src/pr/prContentProvider") as typeof import("../src/pr/prContentProvider");
const { diffBase } = require("../src/pr/reviewDiff") as typeof import("../src/pr/reviewDiff");
const { GitHubApiError } = require("../src/pr/githubApi") as typeof import("../src/pr/githubApi");
/* eslint-enable @typescript-eslint/no-require-imports */

const token = () => new vscode.CancellationTokenSource().token;

function provider(answer: (...a: any[]) => Promise<any>) {
  const asked: any[][] = [];
  const api: any = { fileAt: async (...a: any[]) => (asked.push(a), answer(...a)) };
  return { p: new PrContentProvider(api), asked };
}

test("a URI names owner, repo, sha, path and its pull request — and reads back the same, backslashes and leading slashes gone", () => {
  const uri = toPrContentUri({ owner: "ac me", repo: "app", sha: "abc", path: "\\src\\a b.ts", pr: 37 });
  assert.equal(uri.scheme, PR_SCHEME);
  assert.equal(uri.path, "/src/a b.ts");
  assert.deepEqual(fromPrContentUri(uri), { owner: "ac me", repo: "app", sha: "abc", path: "src/a b.ts", pr: 37 });
  const commit = toPrContentUri({ owner: "acme", repo: "app", sha: "abc", path: "x" });
  assert.equal(fromPrContentUri(commit).pr, undefined, "a commit's file names no pull request");
});

test("a text file is its text; a path missing at that commit is an empty pane", async () => {
  const { p, asked } = provider(async (_o, _r, path) => (path === "gone.ts" ? { kind: "missing" } : { kind: "text", text: "hello\n" }));
  assert.equal(await p.provideTextDocumentContent(toPrContentUri({ owner: "acme", repo: "app", sha: "abc1234567", path: "a.ts" }), token()), "hello\n");
  assert.equal(await p.provideTextDocumentContent(toPrContentUri({ owner: "acme", repo: "app", sha: "abc1234567", path: "gone.ts" }), token()), "");
  assert.deepEqual(asked[0].slice(0, 4), ["acme", "app", "a.ts", "abc1234567"]);
  assert.ok(asked[0][4].signal instanceof AbortSignal);
});

test("a binary or too-large file is one line naming its size and commit, in bytes, KB or MB", async () => {
  const cases: [any, string][] = [
    [{ kind: "binary", bytes: 512 }, "Binary file (512 bytes) at abc1234 — its content isn't shown."],
    [{ kind: "binary", bytes: 4096 }, "Binary file (4 KB) at abc1234 — its content isn't shown."],
    [{ kind: "too-large", bytes: 6 * 1024 * 1024 }, "File too large to show (6.0 MB) at abc1234."],
  ];
  for (const [content, said] of cases) {
    const { p } = provider(async () => content);
    assert.equal(await p.provideTextDocumentContent(toPrContentUri({ owner: "acme", repo: "app", sha: "abc1234567", path: "img.png" }), token()), said);
  }
});

test("a URI missing any part is an empty document, and GitHub is asked nothing", async () => {
  const { p, asked } = provider(async () => assert.fail("never asked"));
  const bare = vscode.Uri.from({ scheme: PR_SCHEME, path: "/a.ts", query: "owner=acme&repo=app" });
  assert.equal(await p.provideTextDocumentContent(bare, token()), "");
  assert.equal(asked.length, 0);
});

test("any other failure throws GitHub's sentence, and a cancelled read aborts its request", async () => {
  const { p } = provider(async () => {
    throw new GitHubApiError("Your GitHub session expired. Sign in again to continue.", "auth", 401);
  });
  await assert.rejects(p.provideTextDocumentContent(toPrContentUri({ owner: "acme", repo: "app", sha: "s", path: "a" }), token()), /session expired/);

  let signal: AbortSignal | undefined;
  const slow = provider(async (...a: any[]) => {
    signal = a[4].signal;
    return { kind: "text", text: "" };
  });
  const src = new vscode.CancellationTokenSource();
  await slow.p.provideTextDocumentContent(toPrContentUri({ owner: "acme", repo: "app", sha: "s", path: "a" }), src.token);
  assert.equal(signal!.aborted, false);
  src.cancel();
  assert.equal(signal!.aborted, true);
});

test("the diff's left side is the merge base GitHub counts from — the base's tip only when GitHub can't say", async () => {
  const asked: any[][] = [];
  const pull = { base: { sha: "tip" }, head: { sha: "head" } };
  assert.equal(await diffBase({ mergeBase: async (...a: any[]) => (asked.push(a), "mb") } as any, { owner: "acme", repo: "app" }, pull), "mb");
  assert.deepEqual(asked[0], ["acme", "app", "tip", "head"]);
  assert.equal(await diffBase({ mergeBase: async () => undefined } as any, { owner: "acme", repo: "app" }, pull), "tip");
  assert.equal(
    await diffBase({ mergeBase: async () => Promise.reject(new Error("offline")) } as any, { owner: "acme", repo: "app" }, pull),
    "tip",
  );
});
