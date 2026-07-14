import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildWireRows,
  wireRefs,
  type CommitMetaLike,
  type LayoutRowLike,
  type RefLike,
} from "../src/graphWire";

function meta(over: Partial<CommitMetaLike> = {}): CommitMetaLike {
  return {
    subject: "subject",
    author: "Ada",
    authorEmail: "ada@example.com",
    authorDate: 1700000000,
    ...over,
  };
}

test("buildWireRows denormalizes commit metadata and lane geometry", () => {
  const rows: LayoutRowLike[] = [
    {
      sha: "abcdef1234567890",
      column: 1,
      color: 3,
      isMerge: true,
      segments: [{ fromColumn: 0, toColumn: 1, color: 3 }],
    },
  ];
  const records = new Map<string, CommitMetaLike>([
    ["abcdef1234567890", meta({ subject: "Merge feature", author: "Lin" })],
  ]);
  const refsBySha = new Map<string, RefLike[]>();

  const [wire] = buildWireRows({ rows, records, refsBySha });
  assert.equal(wire.sha, "abcdef1234567890");
  assert.equal(wire.shortSha, "abcdef1");
  assert.equal(wire.column, 1);
  assert.equal(wire.color, 3);
  assert.equal(wire.isMerge, true);
  assert.deepEqual(wire.segments, [{ fromColumn: 0, toColumn: 1, color: 3 }]);
  assert.equal(wire.subject, "Merge feature");
  assert.equal(wire.author, "Lin");
  assert.deepEqual(wire.refs, []);
});

test("buildWireRows tolerates a missing commit record", () => {
  const rows: LayoutRowLike[] = [
    { sha: "deadbeef", column: 0, color: 0, isMerge: false, segments: [] },
  ];
  const [wire] = buildWireRows({
    rows,
    records: new Map(),
    refsBySha: new Map(),
  });
  assert.equal(wire.subject, "");
  assert.equal(wire.author, "");
  assert.equal(wire.authorDate, 0);
});

test("wireRefs orders chips currentHead, head, remoteHead, tag", () => {
  const refs: RefLike[] = [
    { type: "tag", name: "v1.0", isCurrent: false },
    { type: "remote", name: "origin/main", isCurrent: false },
    { type: "head", name: "feature", isCurrent: false },
    { type: "head", name: "main", isCurrent: true },
  ];
  const chips = wireRefs(refs);
  assert.deepEqual(
    chips.map((c) => `${c.kind}:${c.name}`),
    ["currentHead:main", "head:feature", "remoteHead:origin/main", "tag:v1.0"],
  );
});

test("wireRefs drops stash refs and handles empty input", () => {
  assert.deepEqual(wireRefs(undefined), []);
  assert.deepEqual(
    wireRefs([{ type: "stash", name: "stash@{0}", isCurrent: false }]),
    [],
  );
});
