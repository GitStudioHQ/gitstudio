import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasConflictMarkers,
  markUnsettled,
  prepareMerge,
  seedFromWorking,
  type MarkerLabels,
} from "../src/conflict/documentText";
import { parseConflictMarkers } from "../src/conflict/markers";

// POLISH A1.1 / A1.2 — what the merge editor writes to the file before Apply,
// and what it starts from when the file was already resolved.

const lines = (...l: string[]) => l.join("\n") + "\n";
const BASE = lines("a", "b1", "c", "d", "e2", "f");
const YOURS = lines("a", "B1-yours", "c", "d", "E2-yours", "f");
const THEIRS = lines("a", "B1-theirs", "c", "d", "E2-theirs", "f");
const MERGE: MarkerLabels = { firstIsYours: true, first: "Yours (main)", second: "Theirs (feature)" };

const count = (text: string) => (text.match(/^<{7} /gm) ?? []).length;

test("one accept, one conflict still open: the open one is written as diff3 markers, named after the sides", () => {
  const p = prepareMerge({ base: BASE, ours: YOURS, theirs: THEIRS });
  assert.equal(p.model.blocks.length, 2);
  const result = lines("a", "B1-yours", "c", "d", "e2", "f"); // conflict 2 still base
  const out = markUnsettled(p, result, MERGE)!;
  assert.equal(out.marked, 1);
  assert.equal(count(out.text), 1, "exactly one marker block");
  assert.equal(
    out.text,
    lines(
      "a",
      "B1-yours",
      "c",
      "d",
      "<<<<<<< Yours (main)",
      "E2-yours",
      "||||||| Base",
      "e2",
      "=======",
      "E2-theirs",
      ">>>>>>> Theirs (feature)",
      "f",
    ),
  );
  const parsed = parseConflictMarkers(out.text);
  assert.equal(parsed.ours, lines("a", "B1-yours", "c", "d", "E2-yours", "f"));
  assert.equal(parsed.theirs, lines("a", "B1-yours", "c", "d", "E2-theirs", "f"));
});

test("nothing settled yet: every conflict is marked, and the file says what git said (no change to write)", () => {
  const p = prepareMerge({ base: BASE, ours: YOURS, theirs: THEIRS });
  const out = markUnsettled(p, BASE, MERGE)!;
  assert.equal(out.marked, 2);
  assert.equal(out.changes, 0);
  assert.equal(count(out.text), 2);
  const parsed = parseConflictMarkers(out.text);
  assert.equal(parsed.ours, YOURS, "every region is still one side or the other, never bare base");
  assert.equal(parsed.theirs, THEIRS);
  assert.equal(parsed.base, BASE);
});

test("everything settled: the result, byte for byte, and no markers", () => {
  const p = prepareMerge({ base: BASE, ours: YOURS, theirs: THEIRS });
  const result = lines("a", "B1-theirs", "c", "d", "E2-yours", "f");
  const out = markUnsettled(p, result, MERGE)!;
  assert.equal(out.text, result);
  assert.equal(out.marked, 0);
  assert.equal(out.changes, 2);
  assert.equal(hasConflictMarkers(out.text), false);
});

test("a change only one side made, not yet taken, is written as git merged it — never as base", () => {
  const base = lines("a", "b", "c", "d", "e");
  const yours = lines("a", "B-yours", "c", "d", "e");
  const theirs = lines("a", "b", "c", "d", "E-theirs");
  const p = prepareMerge({ base, ours: yours, theirs });
  const out = markUnsettled(p, base, MERGE)!;
  assert.equal(out.text, lines("a", "B-yours", "c", "d", "E-theirs"));
  assert.equal(out.marked, 0);
  assert.equal(out.changes, 0, "that is exactly what git wrote");
});

test("a line typed beside a conflict nobody has settled keeps the line AND the markers", () => {
  const p = prepareMerge({ base: BASE, ours: YOURS, theirs: THEIRS });
  const result = lines("a", "B1-yours", "c", "d", "typed", "e2", "f");
  const out = markUnsettled(p, result, MERGE)!;
  assert.equal(out.marked, 1);
  assert.match(out.text, /^d\ntyped\n<<<<<<< Yours \(main\)\nE2-yours\n/m);
});

test("a hand edit inside a conflict settles it: the Result's lines are written", () => {
  const p = prepareMerge({ base: BASE, ours: YOURS, theirs: THEIRS });
  const result = lines("a", "b1 by hand", "c", "d", "e2", "f");
  const out = markUnsettled(p, result, MERGE)!;
  assert.equal(out.marked, 1);
  assert.match(out.text, /^b1 by hand$/m);
});

test("during a rebase the first section is stage 2 — Theirs — as git writes it", () => {
  const p = prepareMerge({ base: BASE, ours: YOURS, theirs: THEIRS });
  const rebase: MarkerLabels = { firstIsYours: false, first: "Theirs (master)", second: "Yours (test)" };
  const out = markUnsettled(p, lines("a", "B1-yours", "c", "d", "e2", "f"), rebase)!;
  assert.match(out.text, /<<<<<<< Theirs \(master\)\nE2-theirs\n\|{7} Base\ne2\n=======\nE2-yours\n>>>>>>> Yours \(test\)/);
});

test("a CRLF result is written CRLF", () => {
  const crlf = (s: string) => s.replace(/\n/g, "\r\n");
  const p = prepareMerge({ base: crlf(BASE), ours: crlf(YOURS), theirs: crlf(THEIRS) });
  const out = markUnsettled(p, crlf(lines("a", "B1-yours", "c", "d", "e2", "f")), MERGE)!;
  assert.equal(out.text.includes("\n") && !/[^\r]\n/.test(out.text), true, "every break is CRLF");
  assert.equal(count(out.text), 1);
});

test("added on both sides with no base: the whole file is one marked conflict until settled", () => {
  const p = prepareMerge({ base: "", ours: lines("x", "y"), theirs: lines("x", "z") });
  const out = markUnsettled(p, "", MERGE)!;
  assert.equal(out.marked, p.model.blocks.filter((b) => b.kind === "conflict").length);
  assert.equal(hasConflictMarkers(out.text), true);
  const parsed = parseConflictMarkers(out.text);
  assert.equal(parsed.ours, lines("x", "y"));
  assert.equal(parsed.theirs, lines("x", "z"));
});

test("seed: no markers left and not base — the file was resolved by hand or by rerere", () => {
  const p = prepareMerge({ base: BASE, ours: YOURS, theirs: THEIRS });
  const hand = lines("a", "B1-yours", "c", "d", "E2 by hand", "f");
  assert.deepEqual(seedFromWorking(p, hand), { kind: "working", text: hand });
  assert.deepEqual(seedFromWorking(p, BASE), { kind: "base" });
  assert.deepEqual(seedFromWorking(p, ""), { kind: "base" });
});

test("seed: git's own conflicted file keeps nothing; a conflict settled by hand outside the markers is kept", () => {
  const p = prepareMerge({ base: BASE, ours: YOURS, theirs: THEIRS });
  const git = lines(
    "a",
    "<<<<<<< HEAD", "B1-yours", "||||||| base", "b1", "=======", "B1-theirs", ">>>>>>> feature",
    "c",
    "d",
    "<<<<<<< HEAD", "E2-yours", "||||||| base", "e2", "=======", "E2-theirs", ">>>>>>> feature",
    "f",
  );
  assert.deepEqual(seedFromWorking(p, git), { kind: "markers", keep: [] });
  const partly = lines(
    "a",
    "B1 by hand",
    "c",
    "d",
    "<<<<<<< HEAD", "E2-yours", "||||||| base", "e2", "=======", "E2-theirs", ">>>>>>> feature",
    "f",
  );
  const seed = seedFromWorking(p, partly);
  assert.equal(seed.kind, "markers");
  assert.deepEqual(seed.kind === "markers" ? seed.keep.map((k) => k.lines) : [], [["B1 by hand"]]);
});
