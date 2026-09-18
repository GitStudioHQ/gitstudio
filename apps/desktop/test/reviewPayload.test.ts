// What a review submission actually SENDS.
//
// The pending-review queue rides `pr:review` as a `comments` array, and the
// renderer's names are not GitHub's names: `startLine` must become
// `start_line`, a single-line comment must NOT send the start fields at all
// (GitHub 422s a start_line equal to line), and `side` defaults to RIGHT —
// the head side, the code as proposed. The harness shim answers this channel
// itself, so the mapping below is exactly the code no check can see.

import { test } from "node:test";
import assert from "node:assert/strict";
import { prReview } from "../src/main/github/prs";
import type { GitHubClient } from "../src/main/githubClient";

interface Sent {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

function stubClient(sent: Sent[]): GitHubClient {
  return {
    requestBody: async (method: string, path: string, body: Record<string, unknown>) => {
      sent.push({ method, path, body });
      return {};
    },
  } as unknown as GitHubClient;
}

test("queued comments ride the one submission under GitHub's field names", async () => {
  const sent: Sent[] = [];
  const r = await prReview(stubClient(sent), "o", "r", {
    number: 106,
    event: "COMMENT",
    body: "A pass over the parser.",
    comments: [
      { path: "src/a.ts", line: 18, startLine: 12, body: "this block re-reads" },
      { path: "src/b.ts", line: 7, body: "typo" },
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(sent.length, 1, "ONE review object — one notification");
  const comments = sent[0].body.comments as Array<Record<string, unknown>>;
  assert.equal(comments.length, 2);

  const ranged = comments[0];
  assert.equal(ranged.start_line, 12, "startLine crosses to snake_case");
  assert.equal(ranged.line, 18);
  assert.equal(ranged.start_side, "RIGHT", "the range's start side is stated");
  assert.equal(ranged.side, "RIGHT", "and defaults to the head side");
  assert.equal("startLine" in ranged, false, "the renderer's name never leaks");

  const single = comments[1];
  assert.equal("start_line" in single, false, "a single line sends NO start fields");
  assert.equal("start_side" in single, false);
});

test("a degenerate range (start equals end) is sent as a single-line comment", async () => {
  // GitHub 422s `start_line == line`; the mapper collapses it.
  const sent: Sent[] = [];
  await prReview(stubClient(sent), "o", "r", {
    number: 1,
    event: "APPROVE",
    comments: [{ path: "x.ts", line: 5, startLine: 5, body: "same line twice" }],
  });
  const c = (sent[0].body.comments as Array<Record<string, unknown>>)[0];
  assert.equal("start_line" in c, false);
});

test("a review with no queue sends no comments key at all", async () => {
  // `comments: []` is not the same statement as absence — don't volunteer it.
  const sent: Sent[] = [];
  await prReview(stubClient(sent), "o", "r", { number: 2, event: "APPROVE" });
  assert.equal("comments" in sent[0].body, false);
});

test("an explicit LEFT side survives, for a remark on the code being replaced", async () => {
  const sent: Sent[] = [];
  await prReview(stubClient(sent), "o", "r", {
    number: 3,
    event: "REQUEST_CHANGES",
    comments: [{ path: "x.ts", line: 9, side: "LEFT", body: "this deletion loses the guard" }],
  });
  const c = (sent[0].body.comments as Array<Record<string, unknown>>)[0];
  assert.equal(c.side, "LEFT");
});

test("the head SHA the reviewer read rides as commit_id; absence stays absent", async () => {
  const sent: Sent[] = [];
  await prReview(stubClient(sent), "o", "r", { number: 4, event: "APPROVE", commitId: "abc123" });
  assert.equal(sent[0].body.commit_id, "abc123");
  await prReview(stubClient(sent), "o", "r", { number: 5, event: "APPROVE" });
  assert.equal("commit_id" in sent[1].body, false, "no sha known → let GitHub use the current head");
});
