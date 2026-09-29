// What the merge editor writes to the file before Apply (src/conflict/
// documentText.ts) — the cases test/documentText.test.ts leaves: a line typed
// AFTER an open conflict, one-sided changes git wrote outside the markers,
// kept regions the Result overrules, the base label, a result with no line
// break yet, and the cheap "resolved outside" check.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasConflictMarkers,
  markUnsettled,
  prepareMerge,
  resolvedOutsideMerge,
  seedFromWorking,
  type MarkerLabels,
} from "../src/conflict/documentText";
import { parseConflictMarkers } from "../src/conflict/markers";

const lines = (...l: string[]) => l.join("\n") + "\n";
const MERGE: MarkerLabels = { firstIsYours: true, first: "Yours (main)", second: "Theirs (feature)" };
const count = (text: string) => (text.match(/^<{7} /gm) ?? []).length;

// A conflict at b, and a change only Theirs made at g.
const BASE = lines("a", "b", "c", "d", "e", "f", "g");
const YOURS = lines("a", "B-yours", "c", "d", "e", "f", "g");
const THEIRS = lines("a", "B-theirs", "c", "d", "e", "f", "G-theirs");

const CONFLICT = ["<<<<<<< HEAD", "B-yours", "||||||| base", "b", "=======", "B-theirs", ">>>>>>> feature"];

test("a line typed right after a conflict nobody has settled keeps the markers, then the line", () => {
  const base = lines("a", "b1", "c", "d", "e2", "f");
  const p = prepareMerge({ base, ours: lines("a", "B1-yours", "c", "d", "E2-yours", "f"), theirs: lines("a", "B1-theirs", "c", "d", "E2-theirs", "f") });
  const out = markUnsettled(p, lines("a", "B1-yours", "c", "d", "e2", "typed", "f"), MERGE)!;
  assert.equal(out.marked, 1);
  assert.ok(out.changes >= 1, "the typed line is a change to write");
  assert.match(out.text, /\n>>>>>>> Theirs \(feature\)\ntyped\nf\n$/);
  assert.match(out.text, /^d\n<<<<<<< Yours \(main\)\nE2-yours\n/m);
});

test("a one-sided change the Result took is not a change; the open conflict beside it stays marked", () => {
  const p = prepareMerge({ base: BASE, ours: YOURS, theirs: THEIRS });
  assert.deepEqual(p.model.blocks.map((b) => b.kind).sort(), ["conflict", "right-only"]);
  const out = markUnsettled(p, lines("a", "b", "c", "d", "e", "f", "G-theirs"), MERGE)!;
  assert.equal(out.marked, 1);
  assert.equal(out.changes, 0, "the document git left says the same thing");
  const parsed = parseConflictMarkers(out.text);
  assert.equal(parsed.ours, YOURS.replace("g\n", "G-theirs\n"));
  assert.equal(parsed.theirs, THEIRS);
});

test("the base section carries its own label when one is given", () => {
  const p = prepareMerge({ base: BASE, ours: YOURS, theirs: THEIRS });
  const out = markUnsettled(p, BASE, { ...MERGE, base: "merge base (1234abc)" })!;
  assert.match(out.text, /^\|{7} merge base \(1234abc\)\nb\n=======$/m);
  // A one-sided change the Result hasn't taken is written as git merged it.
  assert.match(out.text, /\nG-theirs\n$/);
});

test("seed: a one-sided change git wrote outside the markers is kept by nothing; a hand edit to it is kept", () => {
  const p = prepareMerge({ base: BASE, ours: YOURS, theirs: THEIRS });
  const git = lines("a", ...CONFLICT, "c", "d", "e", "f", "G-theirs");
  assert.deepEqual(seedFromWorking(p, git), { kind: "markers", keep: [] });

  const hand = lines("a", ...CONFLICT, "c", "d", "e", "f", "G by hand");
  const seed = seedFromWorking(p, hand);
  assert.equal(seed.kind, "markers");
  assert.deepEqual(seed.kind === "markers" ? seed.keep.map((k) => [k.lines, k.baseSpan]) : [], [[["G by hand"], { start: 7, endExclusive: 8 }]]);
});

test("seed: a line edited right beside the markers belongs to the conflict, and is not kept on its own", () => {
  const p = prepareMerge({ base: BASE, ours: YOURS, theirs: THEIRS });
  // The first common line was edited and the rest of the file cut: the walk
  // over common lines fails, the diff places the blocks, and the region that
  // touches the markers is the conflict's.
  assert.deepEqual(seedFromWorking(p, lines("zzz", ...CONFLICT)), { kind: "markers", keep: [] });
});

test("a kept region is dropped once the Result settles its block — the Result wins", () => {
  const p = prepareMerge({ base: BASE, ours: YOURS, theirs: THEIRS });
  const conflict = p.model.blocks.find((b) => b.kind === "conflict")!;
  const keep = [{ blockIds: [conflict.id], baseSpan: conflict.baseSpan, lines: ["B by hand"] }];
  // Untouched in the Result: the file's own lines stand, and nothing is marked there.
  const open = markUnsettled(p, BASE, MERGE, keep)!;
  assert.equal(count(open.text), 0);
  assert.equal(open.text, lines("a", "B by hand", "c", "d", "e", "f", "G-theirs"));
  // Taken in the Result: its lines, not the kept ones.
  const taken = markUnsettled(p, lines("a", "B-theirs", "c", "d", "e", "f", "G-theirs"), MERGE, keep)!;
  assert.equal(taken.text, lines("a", "B-theirs", "c", "d", "e", "f", "G-theirs"));
  assert.equal(taken.marked, 0);
});

test("a kept region naming no block of this merge, or only part of a group, changes nothing", () => {
  const p = prepareMerge({ base: BASE, ours: YOURS, theirs: THEIRS });
  const plain = markUnsettled(p, BASE, MERGE)!;
  const none = markUnsettled(p, BASE, MERGE, [{ blockIds: [999], baseSpan: { start: 2, endExclusive: 3 }, lines: ["X"] }])!;
  assert.equal(none.text, plain.text);
  // A kept span narrower than its block's group is not trusted.
  const conflict = p.model.blocks.find((b) => b.kind === "conflict")!;
  const narrow = markUnsettled(p, BASE, MERGE, [{ blockIds: [conflict.id], baseSpan: { start: 3, endExclusive: 3 }, lines: ["X"] }])!;
  assert.equal(narrow.text, plain.text);
  // A kept region that also claims a block of this merge it doesn't cover.
  const both = markUnsettled(p, BASE, MERGE, [{ blockIds: p.model.blocks.map((b) => b.id), baseSpan: conflict.baseSpan, lines: ["X"] }])!;
  assert.equal(both.text, plain.text);
});

test("a result with no line break yet is joined in Yours' line ending", () => {
  const crlf = (s: string) => s.replace(/\n/g, "\r\n");
  const p = prepareMerge({ base: "x", ours: crlf(lines("y1", "y2")), theirs: crlf(lines("z1", "z2")) });
  const out = markUnsettled(p, "x", MERGE)!;
  assert.equal(out.marked, 1);
  assert.ok(out.text.includes("\r\n"), "CRLF, as Yours");
  assert.ok(!/[^\r]\n/.test(out.text), "every break is CRLF");
});

test("a merge with no blocks writes the Result as it is", () => {
  const p = prepareMerge({ base: lines("same"), ours: lines("same"), theirs: lines("same") });
  assert.deepEqual(markUnsettled(p, "anything at all", MERGE), { text: "anything at all", marked: 0, changes: 0 });
});

test("resolved outside the merge: no markers, not empty, not base", () => {
  assert.equal(resolvedOutsideMerge(lines("a", "hand"), lines("a", "b")), true);
  assert.equal(resolvedOutsideMerge("", lines("a")), false, "an empty file adds nothing");
  assert.equal(resolvedOutsideMerge(lines("a", "b").replace(/\n/g, "\r\n"), lines("a", "b")), false, "base in another line ending is base");
  assert.equal(resolvedOutsideMerge(lines("<<<<<<< HEAD", "x", "=======", "y", ">>>>>>> b"), lines("a")), false);
});

test("conflict markers need both an opening and a closing line, each a whole marker", () => {
  assert.equal(hasConflictMarkers("<<<<<<<\r\nx\r\n>>>>>>>\r\n"), true, "bare markers, CRLF");
  assert.equal(hasConflictMarkers("<<<<<<< HEAD\nx\n"), false, "no closing line");
  assert.equal(hasConflictMarkers("<<<<<<<< eight\n>>>>>>>> eight\n"), false, "eight is not seven");
  assert.equal(hasConflictMarkers("x <<<<<<< HEAD\n>>>>>>> b\n"), false, "not at the start of a line");
});

// ── An empty base: both sides added the file ─────────────────────────────────

const ADDED = prepareMerge({ base: "", ours: lines("x", "y"), theirs: lines("x", "z") });

test("added on both sides: taking Yours settles it, with or without a line typed after", () => {
  assert.deepEqual(markUnsettled(ADDED, lines("x", "y"), MERGE), { text: lines("x", "y"), marked: 0, changes: 1 });
  const typed = markUnsettled(ADDED, lines("x", "y", "typed"), MERGE)!;
  assert.equal(typed.text, lines("x", "y", "typed"));
  assert.equal(typed.marked, 0);
});

test("added on both sides: a line typed before anything is taken stays, beside the marked conflict", () => {
  const out = markUnsettled(ADDED, lines("typed"), MERGE)!;
  assert.equal(out.marked, 1);
  assert.equal(out.changes, 1);
  assert.ok(out.text.startsWith("typed\n<<<<<<< Yours (main)\nx\ny\n"));
  assert.match(out.text, /\n=======\nx\nz\n/);
  assert.match(out.text, /\n>>>>>>> Theirs \(feature\)\n$/);
});

// With an empty base, each side's section used to carry the side's final line
// break as an empty line too ("x\ny\n\n||||||| Base"), which git's own markers
// don't: resolving by deleting the marker lines left a stray blank line
// ("typed\nx\ny\n\n"), and the untouched file lost its last line break.
// What git writes for this add/add conflict (diff3, git 2.49):
const ADDED_MARKERS = ["<<<<<<< Yours (main)", "x", "y", "||||||| Base", "=======", "x", "z", ">>>>>>> Theirs (feature)"];

test("added on both sides: the marked sections hold each side's lines exactly, as git writes them", () => {
  const out = markUnsettled(ADDED, lines("typed"), MERGE)!;
  assert.equal(parseConflictMarkers(out.text).ours, lines("typed", "x", "y"));
  assert.equal(out.text, lines("typed", ...ADDED_MARKERS));
});

test("added on both sides, untouched: the document is git's own conflicted file", () => {
  assert.deepEqual(markUnsettled(ADDED, "", MERGE), { text: lines(...ADDED_MARKERS), marked: 1, changes: 0 });
  // Stage 2 is Theirs (a rebase): the sections swap, nothing else moves.
  const rebase = markUnsettled(ADDED, "", { firstIsYours: false, first: "Theirs (main)", second: "Yours (topic)" })!;
  assert.equal(rebase.text, lines("<<<<<<< Theirs (main)", "x", "z", "||||||| Base", "=======", "x", "y", ">>>>>>> Yours (topic)"));
});

test("added on both sides with no final line break: the markers still end every section, and the file", () => {
  // git: "<<<<<<< HEAD\nx\ny\n||||||| …\n=======\nx\nz\n>>>>>>> feature\n" whichever side lacks it.
  const p = prepareMerge({ base: "", ours: "x\ny", theirs: lines("x", "z") });
  assert.equal(markUnsettled(p, "", MERGE)!.text, lines(...ADDED_MARKERS));
  assert.equal(markUnsettled(p, "typed", MERGE)!.text, lines("typed", ...ADDED_MARKERS), "a Result with no line break yet");
});

test("added on both sides, CRLF: the same lines, every break CRLF", () => {
  const crlf = (s: string) => s.replace(/\n/g, "\r\n");
  const p = prepareMerge({ base: "", ours: crlf(lines("x", "y")), theirs: crlf(lines("x", "z")) });
  assert.equal(markUnsettled(p, "", MERGE)!.text, crlf(lines(...ADDED_MARKERS)));
  assert.equal(markUnsettled(p, crlf(lines("typed")), MERGE)!.text, crlf(lines("typed", ...ADDED_MARKERS)));
});

test("added on both sides: git's own conflicted file seeds as markers, keeping nothing", () => {
  const git = lines("<<<<<<< HEAD", "x", "y", "||||||| d80c2e5", "=======", "x", "z", ">>>>>>> feature");
  assert.deepEqual(seedFromWorking(ADDED, git), { kind: "markers", keep: [] });
});

test("added on one side only: git's version stands until something is typed there", () => {
  const p = prepareMerge({ base: "", ours: lines("x"), theirs: "" });
  assert.deepEqual(markUnsettled(p, "", MERGE), { text: lines("x"), marked: 0, changes: 0 });
  assert.deepEqual(markUnsettled(p, lines("typed"), MERGE), { text: lines("typed"), marked: 0, changes: 1 });
});

// ── A conflict with no base lines, beside edited common lines ────────────────

const INSERTED = prepareMerge({ base: lines("a", "c"), ours: lines("a", "X", "c"), theirs: lines("a", "Y", "c") });
const INSERTED_MARKERS = ["<<<<<<< Yours (main)", "X", "||||||| Base", "=======", "Y", ">>>>>>> Theirs (feature)"];

test("an inserted conflict stays marked right after an edited line before it, and after what was typed", () => {
  assert.deepEqual(markUnsettled(INSERTED, lines("a2", "c"), MERGE), { text: lines("a2", ...INSERTED_MARKERS, "c"), marked: 1, changes: 1 });
  assert.equal(markUnsettled(INSERTED, lines("a2", "t", "c"), MERGE)!.text, lines("a2", "t", ...INSERTED_MARKERS, "c"));
});

test("an inserted conflict taken amid edits on both sides of it is settled", () => {
  assert.deepEqual(markUnsettled(INSERTED, lines("a2", "X", "c2"), MERGE), { text: lines("a2", "X", "c2"), marked: 0, changes: 1 });
});

// byBlock's own rule: "right after the base line before it when only the line
// after it was edited". When the block starts its group, the line before it is
// the group's anchor — intact by definition — but it used to read as edited,
// so the markers landed AFTER the edited line ("a", "c2", markers) instead of
// between "a" and "c2".
test("an inserted conflict stays marked right after the line before it when only the line after it was edited", () => {
  assert.deepEqual(markUnsettled(INSERTED, lines("a", "c2"), MERGE), { text: lines("a", ...INSERTED_MARKERS, "c2"), marked: 1, changes: 1 });
  // At the very top of the file the line before it is the start of the file.
  const top = prepareMerge({ base: lines("c"), ours: lines("X", "c"), theirs: lines("Y", "c") });
  assert.equal(markUnsettled(top, lines("c2"), MERGE)!.text, lines(...INSERTED_MARKERS, "c2"));
});

test("an inserted conflict: typed at the spot, it goes after the typing; both neighbours edited, after both", () => {
  assert.equal(markUnsettled(INSERTED, lines("a", "t", "c"), MERGE)!.text, lines("a", "t", ...INSERTED_MARKERS, "c"));
  assert.equal(markUnsettled(INSERTED, lines("a2", "c2"), MERGE)!.text, lines("a2", "c2", ...INSERTED_MARKERS));
  // Only the line after edited, and a line typed at the spot: the edit can't be
  // told from the typing, so the markers stay right after the intact line.
  assert.equal(markUnsettled(INSERTED, lines("a", "t", "c2"), MERGE)!.text, lines("a", ...INSERTED_MARKERS, "t", "c2"));
});

test("a one-sided insertion beside an edited common line: the edit reads as typed there, and stands alone", () => {
  const p = prepareMerge({ base: lines("a", "c"), ours: lines("a", "X", "c"), theirs: lines("a", "c") });
  assert.deepEqual(markUnsettled(p, lines("a2", "c"), MERGE), { text: lines("a2", "c"), marked: 0, changes: 1 });
});

// ── Two conflicts in one group ───────────────────────────────────────────────

const TWO = prepareMerge({ base: lines("a", "b", "c", "d"), ours: lines("a", "B", "c", "D"), theirs: lines("a", "b2", "c", "d2") });

test("two conflicts around a deleted common line: the one taken is settled, the other stays marked", () => {
  const out = markUnsettled(TWO, lines("a", "B", "d"), MERGE)!;
  assert.equal(out.marked, 1);
  assert.equal(out.text, lines("a", "B", "<<<<<<< Yours (main)", "D", "||||||| Base", "d", "=======", "d2", ">>>>>>> Theirs (feature)"));
});

test("a region where no base line survives is the user's: nothing is marked in it", () => {
  assert.deepEqual(markUnsettled(TWO, lines("q", "r"), MERGE), { text: lines("q", "r"), marked: 0, changes: 1 });
});
