import { test } from "node:test";
import assert from "node:assert/strict";
import { operationNoun, outcomeLine } from "../src/outcome";
import { buildMergePayload, readMergePayload } from "../src/payload";
import { view } from "./fixtures";

// payload.ts's edges (a side that does not exist, a submodule whose commits
// git will not name) and outcome.ts's sentence-start nouns.

const input = { fileName: "/r/a.txt", workingText: "", autoApplyNonConflicting: false };

test("a file deleted on one side names the missing role, and the result starts from the base", () => {
  const p = buildMergePayload(
    {
      op: view("merge"),
      path: "a.txt",
      shape: "text",
      hasBase: true,
      source: "git-stages",
      base: "base\n",
      yours: "mine\n",
      theirs: "",
      missingRole: "theirs",
    } as Parameters<typeof buildMergePayload>[0],
    input,
  );
  assert.equal(p.missingRole, "theirs");
  assert.equal(p.result, "base\n", "an empty working file starts from the base");
  assert.equal(p.ours, "mine\n");
});

test("a submodule whose commits git cannot list still opens, without the shas", async () => {
  const p = await readMergePayload(
    {
      readSides: async (path: string) => ({
        op: view("merge"),
        path,
        shape: "submodule" as const,
        hasBase: true,
        source: "git-stages" as const,
        base: "",
        yours: "",
        theirs: "",
      }),
      conflictFiles: async () => {
        throw new Error("git ls-files failed");
      },
    },
    "vendor/lib",
    input,
  );
  assert.equal(p.shape, "submodule");
  assert.equal(p.commits, undefined);
  assert.equal(p.op?.kind, "merge");
});

test("each operation's name, at the start of a sentence", () => {
  assert.deepEqual(
    (["merge", "rebase", "rebase-merge-step", "cherry-pick", "revert", "am", "stash", "none"] as const).map(operationNoun),
    ["Merge", "Rebase", "Rebase", "Cherry-pick", "Revert", "Applying patches", "Applying the stash", "The operation"],
  );
});

test("refusals without git's own words are said plainly", () => {
  const before = view("rebase");
  const failed = (o: object, verb: "continue" | "skip" | "abort") =>
    outcomeLine({ ok: false, view: view("rebase"), remainingConflicts: 0, ...o }, verb, before);
  assert.deepEqual(failed({ refused: "blocked" }, "continue"), { kind: "failed", text: "Git can't continue yet." });
  assert.deepEqual(failed({ refused: "confirm-drop" }, "continue"), {
    kind: "failed",
    text: "Continuing would drop an emptied commit — confirm to go ahead.",
  });
  assert.deepEqual(failed({ refused: "not-allowed" }, "abort"), { kind: "failed", text: "Nothing is in progress." });
  assert.deepEqual(failed({}, "abort"), { kind: "failed", text: "Git refused to abort." });
});
