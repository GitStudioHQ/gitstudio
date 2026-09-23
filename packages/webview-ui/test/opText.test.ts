import { test } from "node:test";
import assert from "node:assert/strict";
import type { OperationKind, OperationView } from "@gitstudio/host-bridge/conflictsProtocol";
import { abortConfirm, abortLabel } from "../src/conflicts/opText";

// The one phrasing module every surface uses for a stopped operation. These
// pin what a confirm must SAY, because the confirm is the only warning.

function view(kind: OperationKind): OperationView {
  const side = (role: "yours" | "theirs", stage: 2 | 3) => ({ role, stage, name: "main", paneTitle: role, description: role });
  return {
    kind,
    episode: `${kind}:x`,
    title: kind,
    yours: side("yours", 2),
    theirs: side("theirs", 3),
    verbs: { abort: kind === "none" || kind === "stash" ? "Cancel" : "Abort" },
    canContinue: false,
    canSkip: false,
  };
}

test("cancelling unmerged files with no operation warns that STAGED work goes too (reset --merge)", () => {
  // `git reset --merge` resets the index: a `cherry-pick -n` or `checkout -m`
  // conflict leaves the user's own earlier staged changes there, and they are
  // lost with the rest. The confirm used to mention only the conflicts.
  const c = abortConfirm(view("none"));
  assert.match(c.detail, /staged/i);
  assert.match(c.detail, /before the conflict/i);
  assert.match(c.detail, /never staged are kept/i, "and what survives, so the reader can judge");
  assert.equal(c.confirm, abortLabel(view("none")));
});

test("no confirm names an operation with a gerund (\"the applying …\")", () => {
  for (const kind of ["merge", "rebase", "rebase-merge-step", "cherry-pick", "revert", "am", "stash", "none"] as const) {
    const c = abortConfirm(view(kind));
    assert.doesNotMatch(`${c.question} ${c.detail}`, /the applying|the patch series started/i, kind);
  }
});
