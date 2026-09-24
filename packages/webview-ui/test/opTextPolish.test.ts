import { test } from "node:test";
import assert from "node:assert/strict";
import type { OperationView } from "@gitstudio/host-bridge/conflictsProtocol";
import {
  choicePill,
  dashboardHeading,
  shortName,
  skipConfirm,
  splitTitle,
  successCard,
} from "../src/conflicts/opText";

// The words the r0923 verification found wrong or missing (POLISH A5.4, A5.6,
// P-53, the Skip confirm, the pane titles), pinned as strings.

const side = (role: "yours" | "theirs", stage: 2 | 3, name: string, description = name) => ({
  role,
  stage,
  name,
  paneTitle: name,
  description,
});
const op = (over: Partial<OperationView>): OperationView => ({
  kind: "merge",
  title: "",
  yours: side("yours", 2, "main"),
  theirs: side("theirs", 3, "feature"),
  verbs: { continue: "Continue Merge", abort: "Abort Merge" },
  canContinue: true,
  canSkip: false,
  episode: "e",
  ...over,
});
const rebase = (n: number, m: number) =>
  op({
    kind: "rebase",
    step: { n, m, unit: "commit" },
    yours: side("yours", 3, "test"),
    theirs: side("theirs", 2, "master"),
    verbs: { continue: "Continue Rebase", abort: "Abort Rebase" },
  });

test("A5.4: the heading names the operation", () => {
  assert.equal(dashboardHeading(op({})), "Merge conflicts");
  assert.equal(dashboardHeading(rebase(1, 3)), "Rebase conflicts");
  assert.equal(dashboardHeading(op({ kind: "rebase-merge-step" })), "Rebase conflicts");
  assert.equal(dashboardHeading(op({ kind: "cherry-pick" })), "Cherry-pick conflicts");
  assert.equal(dashboardHeading(op({ kind: "revert" })), "Revert conflicts");
  assert.equal(dashboardHeading(op({ kind: "am" })), "Patch conflicts");
  assert.equal(dashboardHeading(op({ kind: "stash" })), "Stash conflicts");
  assert.equal(dashboardHeading(op({ kind: "none" })), "Conflicts");
});

test("A5.4: the success card knows where in the sequence it is", () => {
  assert.deepEqual(successCard(op({})), {
    title: "All conflicts resolved",
    note: "Review below, then Continue Merge to commit it.",
  });
  assert.deepEqual(successCard(rebase(2, 3)), {
    title: "Commit 2 of 3 resolved",
    note: "Continue Rebase to replay the next commit. It stops again if that one conflicts.",
  });
  assert.deepEqual(successCard(rebase(3, 3)), { title: "Last commit resolved", note: "Continue Rebase to finish." });
  assert.deepEqual(successCard(rebase(1, 1)), { title: "Last commit resolved", note: "Continue Rebase to finish." }, "the #12 reporter's one commit");
  const am = op({ kind: "am", step: { n: 1, m: 3, unit: "patch" }, verbs: { continue: "Continue (git am)", abort: "Abort (git am)" } });
  assert.deepEqual(successCard(am), {
    title: "Patch 1 of 3 resolved",
    note: "Continue (git am) to apply the next patch. It stops again if that one conflicts.",
  });
  const range = op({ kind: "cherry-pick", queued: 2, verbs: { continue: "Continue Cherry-pick", abort: "Abort Cherry-pick" } });
  assert.deepEqual(successCard(range), {
    title: "This commit resolved",
    note: "Continue Cherry-pick to commit it and go on to the next pick (2 more are queued). It stops again if one conflicts.",
  });
  const one = op({ kind: "revert", verbs: { continue: "Continue Revert", abort: "Abort Revert" } });
  assert.deepEqual(successCard(one), { title: "All conflicts resolved", note: "Review below, then Continue Revert to commit it." });
  assert.deepEqual(successCard(op({ kind: "none", verbs: { abort: "Cancel" } })), { title: "All conflicts resolved", note: "Review below." });
});

test("P-53: a resolved row's pill names the side kept, and a delete says deleted", () => {
  const o = rebase(1, 1);
  assert.equal(choicePill({ choice: "yours", shape: "text" }, o).text, "kept yours · test");
  assert.equal(choicePill({ choice: "theirs", shape: "text" }, o).text, "kept theirs · master");
  assert.equal(choicePill({ choice: "merged", shape: "text" }, o).text, "merged");
  assert.equal(choicePill({ shape: "text" }, o).text, "resolved");
  // "Delete the file" on a file theirs deleted: it took theirs, which has no file.
  const del = choicePill({ choice: "theirs", missingRole: "theirs", shape: "modify-delete" }, o);
  assert.equal(del.text, "deleted", "not 'kept theirs', as if a file had been kept");
  assert.match(del.title, /deleting the file, as theirs \(master\) did/);
  assert.equal(choicePill({ shape: "both-deleted" }, o).text, "deleted");
  // The name is cut, the tooltip keeps the whole description.
  const long = op({ yours: side("yours", 2, "feature/session-hardening", "feature/session-hardening, where you are") });
  assert.equal(choicePill({ choice: "yours", shape: "text" }, long).text, "kept yours · feature/…hardening");
  assert.match(choicePill({ choice: "yours", shape: "text" }, long).title, /where you are/);
});

test("A5.6: names are cut to 18 characters in the middle, keeping both ends", () => {
  assert.equal(shortName("master"), "master");
  assert.equal(shortName("exactly-18-chars-x"), "exactly-18-chars-x");
  assert.equal(shortName("feature/session-hardening"), "feature/…hardening");
  assert.equal([...shortName("feature/session-hardening")].length, 18);
});

test("Skip's confirm promises a rest only when there is one", () => {
  const commit = { sha: "1a2b3c4d5e6f708192a3", subject: "fix" };
  const cp = (queued?: number) =>
    op({ kind: "cherry-pick", commit, queued, verbs: { continue: "Continue Cherry-pick", skip: "Skip", abort: "Abort" }, canSkip: true });
  assert.match(skipConfirm(cp(2)).detail, /^1a2b3c4 “fix” is left out and the rest carries on\./);
  assert.match(skipConfirm(cp()).detail, /^1a2b3c4 “fix” is left out, and that ends the cherry-pick\./);
  assert.doesNotMatch(skipConfirm(cp()).detail, /rest carries on/);
  const rv = op({ kind: "revert", commit, verbs: { skip: "Skip", abort: "Abort" }, canSkip: true });
  assert.match(skipConfirm(rv).detail, /that ends the revert\./);
  const am = (n: number, m: number) => op({ kind: "am", step: { n, m, unit: "patch" }, verbs: { skip: "Skip patch", abort: "Abort (git am)" } });
  assert.match(skipConfirm(am(1, 3)).detail, /rest of the series carries on/);
  assert.match(skipConfirm(am(3, 3)).detail, /that ends the series\./);
  assert.match(skipConfirm({ ...rebase(2, 3), commit }).detail, /the rest carries on/);
  assert.match(skipConfirm({ ...rebase(3, 3), commit }).detail, /the rebase finishes without it\./);
});

test("pane titles split around the side's name, as whole words, whatever the case", () => {
  assert.deepEqual(splitTitle("Already rebased commits and commits from master", "master"), {
    pre: "Already rebased commits and commits from ",
    name: "master",
    post: "",
  });
  assert.deepEqual(splitTitle("Rebasing 1a2b3c4 from test", "test"), { pre: "Rebasing 1a2b3c4 from ", name: "test", post: "" });
  assert.deepEqual(splitTitle("Undo of 23b9549 reset every case", "undo of 23b9549"), {
    pre: "",
    name: "Undo of 23b9549",
    post: " reset every case",
  });
  assert.deepEqual(splitTitle("Changes from cherry-pick 941076f feature: change every case", "941076f"), {
    pre: "Changes from cherry-pick ",
    name: "941076f",
    post: " feature: change every case",
  });
  assert.equal(splitTitle("Your stashed changes", "stash"), undefined, "never inside a word");
  assert.equal(splitTitle("Result", undefined), undefined);
  assert.equal(splitTitle("Changes from main", "trunk"), undefined);
  // A name that is also an earlier word: the last whole-word match (the title ends with its branch).
  assert.deepEqual(splitTitle("Changes from test into test", "test")?.pre, "Changes from test into ");
});
