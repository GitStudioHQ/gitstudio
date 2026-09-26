import { test } from "node:test";
import assert from "node:assert/strict";
import { isCommitSha, menuTarget, selectedCommits } from "../src/graphSelection";
import type { GraphHostMessage, GraphWebviewMessage } from "../src/graphProtocol";

// The graph protocol's several-commit variant (issue #32): `contextMenu` and
// `commitMenuAction` keep their one `sha` and gain an optional `shas`. Every
// host reads them through menuTarget, so the single-sha messages must mean
// exactly what they always meant, and only a real selection of two or more
// becomes a several-commit action.

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(64); // sha-256
const WIP = "0".repeat(40);

// [what, message, expected]
const TABLE: Array<[string, { sha: string; shas?: unknown[] }, ReturnType<typeof menuTarget>]> = [
  ["a single-sha message, as before", { sha: A }, { kind: "one", sha: A }],
  ["an empty shas", { sha: A, shas: [] }, { kind: "one", sha: A }],
  ["shas of one", { sha: A, shas: [A] }, { kind: "one", sha: A }],
  ["two commits", { sha: A, shas: [A, B] }, { kind: "many", shas: [A, B] }],
  ["the order sent is kept (newest first)", { sha: B, shas: [B, A] }, { kind: "many", shas: [B, A] }],
  ["sha-256 names count", { sha: A, shas: [A, C] }, { kind: "many", shas: [A, C] }],
  ["a duplicate is one commit", { sha: A, shas: [A, A] }, { kind: "one", sha: A }],
  ["the uncommitted-changes row never joins", { sha: A, shas: [WIP, A] }, { kind: "one", sha: A }],
  ["an option-shaped entry never joins", { sha: A, shas: ["--all", A, B] }, { kind: "many", shas: [A, B] }],
  ["an abbreviated sha joins — git resolves it", { sha: A, shas: [A.slice(0, 7), B] }, { kind: "many", shas: [A.slice(0, 7), B] }],
  ["a ref name never joins", { sha: A, shas: ["main", "HEAD", B] }, { kind: "one", sha: A }],
  ["too short to be a sha never joins", { sha: A, shas: ["abc", B] }, { kind: "one", sha: A }],
  ["non-strings are dropped", { sha: A, shas: [42, null, A, { sha: B }] }, { kind: "one", sha: A }],
];

for (const [what, msg, want] of TABLE) {
  test(`menuTarget: ${what}`, () => {
    assert.deepEqual(menuTarget(msg), want);
  });
}

test("shas that are not an array are ignored, not trusted", () => {
  assert.deepEqual(menuTarget({ sha: A, shas: "aaaa" as unknown as string[] }), { kind: "one", sha: A });
});

test("selectCommits payloads are cleaned the same way", () => {
  assert.deepEqual(selectedCommits([B, A, B, WIP, "HEAD"]), [B, A]);
  assert.deepEqual(selectedCommits(undefined), []);
  assert.equal(isCommitSha(A), true);
  assert.equal(isCommitSha(WIP), false);
  assert.equal(isCommitSha("HEAD"), false);
});

test("the wire types carry both shapes (a compile-time check that runs)", () => {
  // Type-only module: these literals fail to compile if the variant is lost.
  const one: GraphWebviewMessage = { type: "contextMenu", sha: A, x: 1, y: 2 };
  const many: GraphWebviewMessage = { type: "contextMenu", sha: A, shas: [A, B], x: 1, y: 2 };
  const pickOne: GraphWebviewMessage = { type: "commitMenuAction", sha: A, id: "revert" };
  const pickMany: GraphWebviewMessage = { type: "commitMenuAction", sha: A, shas: [A, B], id: "revert" };
  const sel: GraphWebviewMessage = { type: "selectCommits", shas: [A, B] };
  const menu: GraphHostMessage = { type: "commitMenu", sha: A, shas: [A, B], x: 0, y: 0, title: "2 commits", items: [] };
  const summary: GraphHostMessage = { type: "commitsSummary", shas: [A, B], items: [] };
  for (const m of [one, many, pickOne, pickMany]) {
    const t = menuTarget(m as { sha: string; shas?: string[] });
    assert.equal(t.kind, "shas" in m ? "many" : "one");
  }
  assert.ok(sel && menu && summary);
});
