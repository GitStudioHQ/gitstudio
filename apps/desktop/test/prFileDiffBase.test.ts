// A pull request file's left side is the MERGE BASE, not the base branch's tip.
//
// GitHub's patch for a PR is the three-dot diff: its hunks, and a LEFT review
// comment's line number, count lines in the merge base of base and head. The
// PR's `base.sha` is the base branch's tip, which moves on as others merge —
// read there, the left pane showed the base branch's own new work as if the
// PR removed it, and a LEFT comment on pane line N was sent as line N of
// DIFFERENT content. The extension reads the same merge base (reviewDiff.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileDiff } from "../src/main/github/prs";
import type { GitHubClient } from "../src/main/githubClient";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

function client(files: Record<string, string>, compare: (path: string) => unknown): { client: GitHubClient; asked: string[] } {
  const asked: string[] = [];
  const c = {
    request: async (_method: string, path: string) => {
      asked.push(path);
      if (/\/pulls\/7$/.test(path)) return { base: { sha: "basetip" }, head: { sha: "headsha" } };
      if (/\/compare\//.test(path)) return compare(path);
      const m = /\/contents\/(.+)\?ref=(\w+)$/.exec(path);
      const text = m ? files[`${m[2]}:${decodeURIComponent(m[1])}`] : undefined;
      if (text === undefined) throw new Error("Not Found");
      return { content: b64(text), encoding: "base64", size: text.length };
    },
  } as unknown as GitHubClient;
  return { client: c, asked };
}

test("the left side is read at the merge base GitHub counts the patch from", async () => {
  const { client: c, asked } = client(
    {
      // main moved on: two lines prepended since the PR branched.
      "basetip:f.txt": "new1\nnew2\nl1\nl2\nl3\nl4\nl5\n",
      "mergebase:f.txt": "l1\nl2\nl3\nl4\nl5\n",
      "headsha:f.txt": "l1\nl2\nl3\nL4\nl5\n",
    },
    (path) => {
      assert.match(path, /\/compare\/basetip\.\.\.headsha/);
      return { merge_base_commit: { sha: "mergebase" } };
    },
  );
  const d = await fileDiff(c, "acme", "app", { number: 7, path: "f.txt" });
  assert.equal(d?.leftText, "l1\nl2\nl3\nl4\nl5\n", "the file as the PR's diff counts it");
  assert.equal(d?.rightText, "l1\nl2\nl3\nL4\nl5\n");
  assert.ok(asked.some((p) => /contents\/f\.txt\?ref=mergebase$/.test(p)));
  assert.ok(!asked.some((p) => /ref=basetip$/.test(p)), "never the base branch's tip");
});

test("when GitHub can't name the merge base, the base branch's tip is read, as before", async () => {
  const { client: c } = client(
    { "basetip:f.txt": "a\n", "headsha:f.txt": "b\n" },
    () => {
      throw new Error("Server Error");
    },
  );
  const d = await fileDiff(c, "acme", "app", { number: 7, path: "f.txt" });
  assert.equal(d?.leftText, "a\n");
  assert.equal(d?.rightText, "b\n");
});
