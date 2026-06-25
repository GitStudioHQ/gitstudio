import { test } from "node:test";
import assert from "node:assert/strict";
import { nextGraphMessage } from "../src/shared/graphAdapterCore";
import type { GraphPage } from "../src/shared/ipc";
import {
  parseNameStatus,
  parsePorcelainStatus,
} from "../src/main/gitBridge";

function page(over: Partial<GraphPage> = {}): GraphPage {
  return {
    rows: [
      {
        sha: "a".repeat(40),
        shortSha: "aaaaaaa",
        column: 0,
        color: 0,
        isMerge: false,
        segments: [],
        subject: "init",
        author: "Ada",
        authorEmail: "ada@x",
        authorDate: 1,
        refs: [],
      },
    ],
    head: "a".repeat(40),
    totalColumns: 1,
    hasMore: true,
    nextSkip: 1,
    ...over,
  };
}

test("nextGraphMessage produces graphInit for the first page", () => {
  const msg = nextGraphMessage(page(), true);
  assert.equal(msg.type, "graphInit");
  if (msg.type === "graphInit") {
    assert.equal(msg.head, "a".repeat(40));
    assert.equal(msg.rows.length, 1);
    assert.equal(msg.hasMore, true);
  }
});

test("nextGraphMessage produces graphAppend for later pages", () => {
  const msg = nextGraphMessage(page({ hasMore: false }), false);
  assert.equal(msg.type, "graphAppend");
  if (msg.type === "graphAppend") {
    assert.equal(msg.totalColumns, 1);
    assert.equal(msg.hasMore, false);
    // graphAppend carries no `head` field (the element only sets head on init).
    assert.equal("head" in msg, false);
  }
});

test("parseNameStatus handles modifications and renames", () => {
  const out = parseNameStatus("M\tsrc/a.ts\nR100\told.ts\tnew.ts\nA\tb.ts\n");
  assert.deepEqual(out, [
    { path: "src/a.ts", status: "M" },
    { path: "new.ts", status: "R" },
    { path: "b.ts", status: "A" },
  ]);
});

test("parsePorcelainStatus flattens staged/unstaged and skips rename originals", () => {
  // "M  a.ts\0" staged-modified, " M b.ts\0" unstaged-modified,
  // "?? c.ts\0" untracked, "R  new.ts\0old.ts\0" staged rename.
  const z = "M  a.ts\0 M b.ts\0?? c.ts\0R  new.ts\0old.ts\0";
  const out = parsePorcelainStatus(z);
  assert.deepEqual(out, [
    { path: "a.ts", status: "M", staged: true },
    { path: "b.ts", status: "M", staged: false },
    { path: "c.ts", status: "?", staged: false },
    { path: "new.ts", status: "R", staged: true },
  ]);
});
