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
    refFilter: null,
    refList: [],
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

test("graphInit carries the branch filter and the picker's ref list", () => {
  // The picker lists EVERY ref, filtered-out ones included — otherwise a ref
  // could never be ticked back in. Both ride the first page only.
  const refList = [{ fullName: "refs/heads/main", name: "main", kind: "head" as const, isCurrent: true }];
  const msg = nextGraphMessage(page({ refFilter: ["refs/heads/main"], refList }), true);
  if (msg.type === "graphInit") {
    assert.deepEqual(msg.refFilter, ["refs/heads/main"]);
    assert.deepEqual(msg.refList, refList);
  } else {
    assert.fail("expected graphInit");
  }
  const more = nextGraphMessage(page({ refFilter: ["refs/heads/main"], refList }), false);
  assert.equal("refFilter" in more, false);
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
  // -z form: NUL-separated records, a status then its path, and for R/C the
  // source path then the destination. Every caller passes -z now, because
  // without it git C-quotes any non-ASCII path into an octal escape string
  // that is neither displayable nor usable as a pathspec. See nameStatus.test.
  const out = parseNameStatus("M\0src/a.ts\0R100\0old.ts\0new.ts\0A\0b.ts\0");
  assert.deepEqual(out, [
    { path: "src/a.ts", status: "M" },
    // The SOURCE path is kept, not just consumed. The base side of a rename
    // holds the file under its old name, so a diff asked for `new.ts` on both
    // sides comes back empty on the left and renders a twelve-line edit as a
    // brand-new file with no history — "the diff doesn't show" over a rename.
    { path: "new.ts", status: "R", oldPath: "old.ts" },
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
