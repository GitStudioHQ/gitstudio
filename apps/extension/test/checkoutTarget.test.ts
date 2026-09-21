import { test } from "node:test";
import assert from "node:assert/strict";
import type { WireRef } from "@gitstudio/host-bridge/graphProtocol";
import { ellipsizeMiddle, resolveCheckoutTarget } from "../src/graph/checkoutTarget";

// Checking out a branch tip by sha detaches HEAD, which is the wrong outcome
// for a click that looks routine. These pin the rule that decides otherwise.

const head = (name: string): WireRef => ({ name, kind: "head" });
const current = (name: string): WireRef => ({ name, kind: "currentHead" });
const remote = (name: string): WireRef => ({ name, kind: "remoteHead" });
const tag = (name: string): WireRef => ({ name, kind: "tag" });

test("the tip of one branch checks out as that branch, not as a sha", () => {
  assert.deepEqual(resolveCheckoutTarget([head("main")]), {
    kind: "branch",
    name: "main",
  });
});

test("a branch that collides with a tag checks out by its refs/heads/ name, not its short one", () => {
  // git names the branch "heads/release" then, and `git checkout
  // heads/release` is a revision, not a branch: it detaches. The full name is
  // where the branch's own name still lives.
  assert.deepEqual(
    resolveCheckoutTarget([{ name: "heads/release", kind: "head", fullName: "refs/heads/release" }]),
    { kind: "branch", name: "release" },
  );
  const t = resolveCheckoutTarget([
    { name: "heads/release", kind: "head", fullName: "refs/heads/release" },
    { name: "main", kind: "head", fullName: "refs/heads/main" },
  ]);
  assert.deepEqual(t.kind === "choose" && t.branches, ["release", "main"]);
  // A caller that knows no full name keeps the name it has.
  assert.deepEqual(resolveCheckoutTarget([head("release")]), { kind: "branch", name: "release" });
});

test("a commit with no refs still detaches — that is what was asked for", () => {
  assert.deepEqual(resolveCheckoutTarget([]), { kind: "detach" });
  assert.deepEqual(resolveCheckoutTarget(undefined), { kind: "detach" });
});

test("the branch already checked out reports 'already', not a no-op checkout", () => {
  assert.deepEqual(resolveCheckoutTarget([current("main")]), {
    kind: "already",
    name: "main",
  });
});

test("several branches on one commit asks which", () => {
  const t = resolveCheckoutTarget([head("main"), head("release")]);
  assert.equal(t.kind, "choose");
  assert.deepEqual(t.kind === "choose" && t.branches, ["main", "release"]);
});

test("a remote-tracking ref alone detaches — it is not somewhere you can sit", () => {
  // "Checkout origin/x" exists as its own menu entry and creates a local
  // branch; silently doing that from "Checkout Commit" would be a surprise.
  assert.deepEqual(resolveCheckoutTarget([remote("origin/main")]), {
    kind: "detach",
  });
});

test("a tag alone detaches", () => {
  assert.deepEqual(resolveCheckoutTarget([tag("v1.9.0")]), { kind: "detach" });
});

test("a local branch wins over the remote twin and tags on the same commit", () => {
  assert.deepEqual(
    resolveCheckoutTarget([remote("origin/main"), tag("v2"), head("main")]),
    { kind: "branch", name: "main" },
  );
});

test("being on the branch outranks everything else on the commit", () => {
  assert.deepEqual(
    resolveCheckoutTarget([head("other"), current("main"), tag("v2")]),
    { kind: "already", name: "main" },
  );
});

test("a long ref name is shortened from the MIDDLE, keeping both ends", () => {
  const long =
    "aksdjlaksjdlkasjdlakjwdlkajdslkajwlkdj-alwkdjlkaw-jdlk-hakjshdkajhdwkjahdkjawhd-asasd-as";
  const out = ellipsizeMiddle(long);
  assert.ok(out.length <= 42, `stayed within budget, got ${out.length}`);
  assert.ok(out.startsWith("aksdjlaksj"), "keeps the head");
  assert.ok(out.endsWith("asasd-as"), "keeps the tail — what tells two apart");
  assert.ok(out.includes("…"), "says it was shortened");
});

test("a name that already fits is left exactly alone", () => {
  assert.equal(ellipsizeMiddle("main"), "main");
  assert.equal(ellipsizeMiddle("feat/diff-tick-staging"), "feat/diff-tick-staging");
});
