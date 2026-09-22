import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  ConflictFileView,
  ConflictsSnapshot,
  OperationView,
} from "@gitstudio/host-bridge/conflictsProtocol";
import { DashboardController, dashboardTitle } from "../src/dashboardController";
import { view } from "./fixtures";

// The dashboard's state machine, as sequences of git snapshots and user events.

const brand = { name: "GitStudio", mark: "gitstudio" as const };

function snap(op: OperationView, files: [string, ConflictFileView["status"]][]): ConflictsSnapshot {
  const rows: ConflictFileView[] = files.map(([path, status]) => ({ path, status, shape: "text" }));
  return {
    repoName: "repo",
    op,
    files: rows,
    total: rows.length,
    resolved: rows.filter((r) => r.status === "resolved").length,
  };
}

const step1 = view("rebase", { episode: "rebase:A", step: { n: 1, m: 3, unit: "commit" } });
const step2 = view("rebase", { episode: "rebase:B", step: { n: 2, m: 3, unit: "commit" } });
const none = view("none");
const auto = { open: false, autoShow: true };

test("auto-show: conflicts appear with autoOpen on → show; with it off (or deferring) → nothing", () => {
  const c = new DashboardController({ brand });
  assert.equal(c.update(snap(step1, [["a.txt", "pending"]]), auto).show, true);
  const off = new DashboardController({ brand });
  assert.equal(off.update(snap(step1, [["a.txt", "pending"]]), { open: false, autoShow: false }).show, false);
});

test("close is respected for the episode: the next git event does not bring it back", () => {
  const c = new DashboardController({ brand });
  c.update(snap(step1, [["a.txt", "pending"], ["b.txt", "pending"]]), auto);
  c.userClosed();
  const again = c.update(snap(step1, [["a.txt", "pending"], ["b.txt", "pending"]]), auto);
  assert.equal(again.show, false, "Merge Studio re-opened here; a close must stick");
  const later = c.update(snap(step1, [["a.txt", "resolved"], ["b.txt", "pending"]]), auto);
  assert.equal(later.show, false, "still the same stop");
});

test("per-step reset: the next rebase step is a new episode, so the dashboard shows again", () => {
  const c = new DashboardController({ brand });
  c.update(snap(step1, [["a.txt", "pending"]]), auto);
  c.userClosed();
  const next = c.update(snap(step2, [["a.txt", "pending"]]), auto);
  assert.equal(next.show, true);
  assert.deepEqual(
    next.state.files.map((f) => [f.path, f.status]),
    [["a.txt", "pending"]],
    "the list is the new stop's, not an accumulation of every step",
  );
});

test("asking for it always shows it, whatever the close said", () => {
  const c = new DashboardController({ brand });
  c.update(snap(step1, [["a.txt", "pending"]]), auto);
  c.userClosed();
  c.requested();
  assert.equal(c.update(snap(step1, [["a.txt", "pending"]]), auto).show, true);
});

test("reveal on a pending drop: finishing a file brings the open dashboard to the front", () => {
  const c = new DashboardController({ brand });
  const open = { open: true, autoShow: true };
  assert.equal(c.update(snap(step1, [["a.txt", "pending"], ["b.txt", "pending"]]), open).reveal, false);
  assert.equal(c.update(snap(step1, [["a.txt", "pending"], ["b.txt", "pending"]]), open).reveal, false, "no change, no reveal");
  assert.equal(c.update(snap(step1, [["a.txt", "resolved"], ["b.txt", "pending"]]), open).reveal, true);
  assert.equal(
    c.update(snap(step1, [["a.txt", "pending"], ["b.txt", "pending"]]), open).reveal,
    false,
    "a conflict coming back (hold-to-undo) is not a drop",
  );
});

test("the operation ending elsewhere closes it; ending by our own Continue keeps the outcome on screen", () => {
  const elsewhere = new DashboardController({ brand });
  const open = { open: true, autoShow: true };
  elsewhere.update(snap(step1, [["a.txt", "pending"]]), open);
  assert.equal(elsewhere.update(snap(none, []), open).close, true);

  const ours = new DashboardController({ brand });
  ours.update(snap(step1, [["a.txt", "resolved"]]), open);
  ours.update(snap(step1, [["a.txt", "pending"]]), open);
  ours.setOutcome({ kind: "done", text: "Rebase complete." }, "none");
  const after = ours.update(snap(none, []), open);
  assert.equal(after.close, false);
  assert.deepEqual(after.state.outcome, { kind: "done", text: "Rebase complete." });
});

test("an outcome belongs to the stop it produced: kept at that stop, cleared once git moves on", () => {
  const c = new DashboardController({ brand });
  const open = { open: true, autoShow: true };
  c.update(snap(step1, [["a.txt", "resolved"]]), open);
  c.setOutcome({ kind: "stopped", text: "Stopped at commit 2 of 3" }, "rebase:B");
  const atStep2 = c.update(snap(step2, [["a.txt", "pending"]]), open);
  assert.equal(atStep2.state.outcome?.kind, "stopped");
  const step3 = view("rebase", { episode: "rebase:C" });
  assert.equal(c.update(snap(step3, [["a.txt", "pending"]]), open).state.outcome, undefined);
});

test("nothing left to resolve lifts a close even when git keeps the same episode key", () => {
  const c = new DashboardController({ brand });
  c.update(snap(none, [["a.txt", "pending"]]), auto);
  c.userClosed();
  assert.equal(c.update(snap(none, [["a.txt", "pending"]]), auto).show, false);
  c.update(snap(none, []), auto);
  assert.equal(c.update(snap(none, [["b.txt", "pending"]]), auto).show, true);
});

test("busy: the row in flight shows busy and every control is disabled; a new action clears the old outcome", () => {
  const c = new DashboardController({ brand });
  c.update(snap(step1, [["a.txt", "pending"], ["b.txt", "pending"]]), auto);
  c.setOutcome({ kind: "failed", text: "no" });
  const s = c.setBusy(true, "b.txt");
  assert.equal(s.busy, true);
  assert.deepEqual(s.files.map((f) => f.status), ["pending", "busy"]);
  assert.equal(s.outcome, undefined);
  assert.deepEqual(c.setBusy(false).files.map((f) => f.status), ["pending", "pending"]);
});

test("state carries the brand, hold-to-undo and support links; the title counts pending rows", () => {
  const c = new DashboardController({
    brand: { name: "Merge Studio", mark: "merge-studio" },
    supportLinks: [{ label: "Report an issue", url: "https://example.com" }],
  });
  const d = c.update(snap(step1, [["a.txt", "pending"], ["b.txt", "resolved"]]), auto);
  assert.equal(d.state.brand.mark, "merge-studio");
  assert.equal(d.state.holdToUndoMs, 750);
  assert.equal(d.state.supportLinks?.length, 1);
  assert.equal(d.state.total, 2);
  assert.equal(d.state.resolved, 1);
  assert.equal(dashboardTitle(d.state), "Conflicts (1)");
  assert.equal(dashboardTitle({ files: [] }), "Conflicts");
});
