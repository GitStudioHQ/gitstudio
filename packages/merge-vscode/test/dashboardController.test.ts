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

test("a row's action marks THAT row busy and nothing else: not the page, not the outcome, not a notice", () => {
  // The owner (24 Sep 2026): "clicking accept left on the first row flashes
  // and refreshes all other rows". A row's action used to set the page's
  // `busy` (every control on the page locked) and clear the notice above the
  // list (every row moved up).
  const c = new DashboardController({ brand });
  c.update(snap(step1, [["a.txt", "pending"], ["b.txt", "pending"], ["c.txt", "pending"]]), auto);
  c.setOutcome({ kind: "stopped", text: "Stopped at commit 2 of 3" });
  c.setNotice({ kind: "warn", text: "an earlier refusal" });
  const before = c.state();
  const s = c.setRowBusy("b.txt", true);
  assert.equal(s.busy, false, "the page is not locked for one row");
  assert.deepEqual(s.files.map((f) => f.status), ["pending", "busy", "pending"]);
  assert.deepEqual(s.outcome, before.outcome, "the outcome stays");
  assert.deepEqual(s.notice, before.notice, "the notice stays (removing it would move every row)");
  // A second row pressed while the first is at work: both are busy, nothing else.
  assert.deepEqual(c.setRowBusy("c.txt", true).files.map((f) => f.status), ["pending", "busy", "busy"]);
  assert.deepEqual(c.setRowBusy("b.txt", false).files.map((f) => f.status), ["pending", "pending", "busy"]);
  assert.deepEqual(c.setRowBusy("c.txt", false), before);
});

test("an operation verb locks the page and makes the old outcome and notice stale", () => {
  const c = new DashboardController({ brand });
  c.update(snap(step1, [["a.txt", "pending"], ["b.txt", "pending"]]), auto);
  c.setOutcome({ kind: "failed", text: "no" });
  const s = c.setBusy(true);
  assert.equal(s.busy, true);
  assert.deepEqual(s.files.map((f) => f.status), ["pending", "pending"], "no row is marked: the page is");
  assert.equal(s.outcome, undefined);
  assert.equal(c.setBusy(false).busy, false);
});

test("`done` is what the host had finished when the files were READ, and a busy row is not counted resolved", () => {
  const c = new DashboardController({ brand });
  assert.equal(c.update(snap(step1, [["a.txt", "pending"]]), auto).state.done, undefined, "no number, no claim");
  // Read while action 3 was still running: it says 2.
  const read = c.update(snap(step1, [["a.txt", "resolved"], ["b.txt", "pending"]]), auto, 2);
  assert.equal(read.state.done, 2);
  const s = c.setRowBusy("a.txt", true);
  assert.equal(s.done, 2, "marking a row does not advance it");
  assert.equal(s.resolved, 0, "the row at work is not in the progress count yet");
  assert.equal(c.setRowBusy("a.txt", false).resolved, 1);
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

test("a stash pop's last conflict resolved: the page stays, finished, instead of closing (r0923)", () => {
  const stash = view("stash", { episode: "stash:h" });
  const c = new DashboardController({ brand });
  c.update(snap(stash, [["app/version.py", "pending"], ["b.py", "resolved"]]), auto);
  // The last file staged: no markers, nothing unmerged — git says "none", and
  // the page used to close within half a second.
  const end = c.update(snap(none, []), { open: true, autoShow: true });
  assert.equal(end.close, false, "the page stays");
  assert.ok(end.state.finished, "it says the stash apply is done");
  assert.match(end.state.finished!.text, /stash list/);
  assert.deepEqual(
    end.state.files.map((f) => [f.path, f.status]),
    [
      ["app/version.py", "resolved"],
      ["b.py", "resolved"],
    ],
  );
  assert.equal(end.state.total, 2);
  assert.equal(end.state.resolved, 2);
  // A re-read changes nothing; the user's close ends it.
  assert.equal(c.update(snap(none, []), { open: true, autoShow: true }).close, false);
  c.userClosed();
  const after = c.update(snap(none, []), { open: false, autoShow: true });
  assert.equal(after.state.finished, undefined);
  assert.equal(after.show, false);
});

test("any other operation that ends elsewhere still closes the page (no finished card)", () => {
  const c = new DashboardController({ brand });
  c.update(snap(view("merge", { episode: "merge:x" }), [["a.txt", "pending"]]), auto);
  const end = c.update(snap(none, []), { open: true, autoShow: true });
  assert.equal(end.close, true);
  assert.equal(end.state.finished, undefined);
});

test("the tip rides on the state until it is dismissed", () => {
  const c = new DashboardController({ brand });
  c.update(snap(step1, [["a.txt", "pending"]]), auto);
  const tip = { id: "t", text: "New in 1.0: during a rebase, Yours is your commit (test), on the left." };
  assert.deepEqual(c.setTip(tip).tip, tip);
  assert.equal(c.setTip(undefined).tip, undefined);
});
