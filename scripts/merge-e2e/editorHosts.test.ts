// What the hosts give the merge editor, and what it writes back to the file
// before Apply, over EVERY conflict in the matrix — every operation, every
// conflict style — not one hand-made case (POLISH A1.1 / A1.2, and the
// verifier's "conflictType differs between the hosts").
//
//   npx tsx --test scripts/merge-e2e/editorHosts.test.ts
//
// The extensions and the desktop describe each file the same way: shape, the
// role with no version of it, whether it has a base, and its conflict type.
//
// For each file, through the extensions' own payload (ConflictOps.readSides →
// buildMergePayload) and the hosts' own rule (documentSync.ResultMirror):
//
// 1. Opening it (a Result that settles nothing) writes nothing.
// 2. One accept: every OTHER conflict is still marked in the text the document
//    gets, and each marked conflict reads back as its own two sides.
// 3. Everything settled: the text is the Result, byte for byte.
// 4. git's own conflicted file is never "already resolved", and the file
//    resolved by hand always is.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMatrix, desktopBridge, extensionPayload, workingText } from "./oracle";
import { mergePayload } from "../../apps/desktop/src/renderer/mergeParity";
import { DEFAULT_MERGE_SETTINGS } from "@gitstudio/host-bridge/conflictsProtocol";
import { GitContext } from "@gitstudio/git-service/GitContext";
import {
  hasConflictMarkers,
  markUnsettled,
  prepareMerge,
  resolvedOutsideMerge,
  seedFromWorking,
  type PreparedMerge,
} from "@gitstudio/engine/conflict/documentText";
import { eolChars, normalizeEol, splitLines } from "@gitstudio/engine/lineDiff";
import { sideBlockSpan, type ChangeBlock } from "@gitstudio/engine/types";
import type { MergeInitPayload } from "@gitstudio/host-bridge/protocol";
import { markerLabelsFor, ResultMirror } from "@gitstudio/merge-vscode/documentSync";

interface Manifest {
  scenarios: Array<{ id: string; dir: string }>;
}

interface FileCase {
  scenario: string;
  path: string;
  payload: MergeInitPayload;
  working: string;
}

let target = "";
const cases: FileCase[] = [];
/** Every conflicted file, any shape: the extensions' payload and the desktop's, side by side. */
const both: Array<{ scenario: string; path: string; ext: MergeInitPayload; desk?: MergeInitPayload }> = [];

test.before(async () => {
  target = mkdtempSync(join(tmpdir(), "gs-doctext-matrix-"));
  buildMatrix(target);
  const manifest = JSON.parse(readFileSync(join(target, "matrix.json"), "utf8")) as Manifest;
  for (const s of manifest.scenarios) {
    const root = join(target, s.dir);
    const ctx = new GitContext({ root });
    const bridge = await desktopBridge(root);
    try {
      const op = await ctx.operation.view();
      for (const f of await ctx.conflictOps.conflictFiles({ op })) {
        const payload = await extensionPayload(ctx, root, f.path, op);
        const model = await bridge.conflictModel(f.path);
        both.push({
          scenario: s.id,
          path: f.path,
          ext: payload,
          desk: model ? mergePayload(model, DEFAULT_MERGE_SETTINGS) : undefined,
        });
        if (f.shape !== "text" && f.shape !== "added-both") continue;
        cases.push({ scenario: s.id, path: f.path, payload, working: workingText(join(root, f.path)) });
      }
    } finally {
      ctx.dispose();
    }
  }
});

test.after(() => {
  if (target) rmSync(target, { recursive: true, force: true });
});

const memo = new Map<string, PreparedMerge>();
function prepared(p: MergeInitPayload): PreparedMerge {
  const key = [p.base, p.ours, p.theirs].map((t) => createHash("sha1").update(t).digest("hex")).join(":");
  let hit = memo.get(key);
  if (!hit) memo.set(key, (hit = prepareMerge(p)));
  return hit;
}

/** The Result the view holds: base, with some blocks replaced — in the model's line ending. */
function resultWith(p: PreparedMerge, pick: (b: ChangeBlock) => string[] | undefined): string {
  const out: string[] = [];
  let at = 0;
  for (const b of [...p.model.blocks].sort((x, y) => x.baseSpan.start - y.baseSpan.start)) {
    const lines = pick(b);
    if (!lines) continue;
    out.push(...p.base.slice(at, b.baseSpan.start - 1), ...lines);
    at = b.baseSpan.endExclusive - 1;
  }
  out.push(...p.base.slice(at));
  const text = out.join("\n");
  return p.model.eol === "LF" ? text : text.replace(/\n/g, eolChars(p.model.eol));
}

function side(p: PreparedMerge, b: ChangeBlock, which: "left" | "right"): string[] {
  const change = which === "left" ? b.left : b.right;
  const lines = which === "left" ? p.ours : p.theirs;
  const empty = which === "left" ? p.oursEmpty : p.theirsEmpty;
  if (!change) return p.baseEmpty ? [] : p.base.slice(b.baseSpan.start - 1, b.baseSpan.endExclusive - 1);
  if (empty) return [];
  const span = sideBlockSpan(b, which);
  return lines.slice(span.start - 1, span.endExclusive - 1);
}

const settled = (p: PreparedMerge) => (b: ChangeBlock) =>
  b.kind === "right-only" ? side(p, b, "right") : side(p, b, "left");

const markerCount = (text: string) => (text.match(/^<{7} /gm) ?? []).length;

test("the matrix reaches every text conflict it is meant to", () => {
  assert.ok(cases.length >= 33 * 15, `only ${cases.length} text conflicts were read`);
  const scenarios = new Set(cases.map((c) => c.scenario));
  assert.equal(scenarios.size, 33);
});

test("both hosts describe every conflicted file alike: shape, missing role, base, conflict type", () => {
  const problems: string[] = [];
  const types = new Set<string>();
  for (const f of both) {
    if (!f.desk) {
      problems.push(`${f.scenario} ${f.path}: the desktop has no model`);
      continue;
    }
    types.add(f.ext.conflictType);
    for (const k of ["shape", "missingRole", "hasBase", "conflictType"] as const) {
      if (f.ext[k] !== f.desk[k]) problems.push(`${f.scenario} ${f.path}: ${k} ${String(f.ext[k])} vs ${String(f.desk[k])}`);
    }
  }
  assert.deepEqual(problems.slice(0, 20), []);
  // Every kind of conflict the matrix holds is named for what it is.
  for (const t of ["content", "add-add", "deleted-by-us", "deleted-by-them", "added-by-us", "added-by-them", "deleted-by-both"]) {
    assert.ok(types.has(t), `no file in the matrix is "${t}"`);
  }
});

test("opening a file writes nothing: a Result that settles nothing says what git's file says", () => {
  const problems: string[] = [];
  for (const c of cases) {
    const p = prepared(c.payload);
    const conflicts = p.model.blocks.filter((b) => b.kind === "conflict").length;
    const out = markUnsettled(p, resultWith(p, () => undefined), markerLabelsFor(c.payload));
    if (!out) problems.push(`${c.scenario} ${c.path}: could not be mapped`);
    else if (out.changes !== 0 || out.marked !== conflicts)
      problems.push(`${c.scenario} ${c.path}: ${out.marked}/${conflicts} marked, ${out.changes} changes`);
    const mirror = new ResultMirror();
    mirror.init(c.payload);
    if (mirror.documentText(resultWith(p, () => undefined)) !== undefined) problems.push(`${c.scenario} ${c.path}: wrote on open`);
  }
  assert.deepEqual(problems, []);
});

test("one accept: every other conflict stays marked, and each reads back as its two sides", () => {
  const problems: string[] = [];
  let checked = 0;
  for (const c of cases) {
    const p = prepared(c.payload);
    const conflicts = p.model.blocks.filter((b) => b.kind === "conflict");
    if (conflicts.length === 0) continue;
    const first = conflicts[0];
    const result = resultWith(p, (b) => (b === first ? side(p, b, "left") : undefined));
    const mirror = new ResultMirror();
    mirror.init(c.payload);
    const text = mirror.documentText(result);
    if (text === undefined) {
      problems.push(`${c.scenario} ${c.path}: the accept was not written`);
      continue;
    }
    checked++;
    if (markerCount(text) !== conflicts.length - 1) {
      problems.push(`${c.scenario} ${c.path}: ${markerCount(text)} marked, ${conflicts.length - 1} still open`);
      continue;
    }
    // Reading the markers back gives every open conflict's own sides, in git's
    // order (stage 2 first): nothing was flattened to base.
    const labels = markerLabelsFor(c.payload);
    const blocks = normalizeEol(text).split(/^<{7} .*\n/m).slice(1);
    conflicts.slice(1).forEach((b, i) => {
      const m = /^([\s\S]*?)\|{7} .*\n([\s\S]*?)={7}\n([\s\S]*?)>{7} /m.exec(blocks[i] ?? "");
      const yours = side(p, b, "left").join("\n");
      const theirs = side(p, b, "right").join("\n");
      const [firstWant, secondWant] = labels.firstIsYours ? [yours, theirs] : [theirs, yours];
      const got = (s: string | undefined) => (s ?? "").replace(/\n$/, "");
      if (!m || got(m[1]) !== firstWant || got(m[3]) !== secondWant) {
        problems.push(`${c.scenario} ${c.path}: conflict ${i + 2} does not read back as its sides`);
      }
    });
  }
  assert.ok(checked > 300, `only ${checked} files had a conflict to accept`);
  assert.deepEqual(problems.slice(0, 20), []);
});

test("everything settled: the document gets the Result byte for byte, with no markers", () => {
  const problems: string[] = [];
  for (const c of cases) {
    const p = prepared(c.payload);
    const result = resultWith(p, settled(p));
    const out = markUnsettled(p, result, markerLabelsFor(c.payload));
    if (!out || out.text !== result || out.marked !== 0 || hasConflictMarkers(out.text)) {
      problems.push(`${c.scenario} ${c.path}`);
    }
  }
  assert.deepEqual(problems, []);
});

test("git's conflicted file is never 'already resolved'; the same file resolved by hand always is", () => {
  const problems: string[] = [];
  for (const c of cases) {
    const p = prepared(c.payload);
    const git = c.working;
    if (hasConflictMarkers(git)) {
      if (resolvedOutsideMerge(git, c.payload.base)) problems.push(`${c.scenario} ${c.path}: git's file called resolved`);
      const seed = seedFromWorking(p, git);
      if (seed.kind !== "markers") problems.push(`${c.scenario} ${c.path}: seed ${seed.kind}`);
    }
    const hand = resultWith(p, settled(p));
    if (normalizeEol(hand) !== normalizeEol(c.payload.base) && hand !== "") {
      if (!resolvedOutsideMerge(hand, c.payload.base)) problems.push(`${c.scenario} ${c.path}: hand resolution not seen`);
      const seed = seedFromWorking(p, hand);
      if (seed.kind !== "working") problems.push(`${c.scenario} ${c.path}: hand seed ${seed.kind}`);
    }
  }
  assert.deepEqual(problems, []);
});

test("git's conflicted file seeds nothing but what git merged itself", () => {
  // Outside its markers, git's file holds what git merged. The seed keeps a
  // region only when it differs from both base and what the engine would
  // merge — which for git's own file means a conflict git resolved on its
  // own (its merge coalesces and trims hunks differently). Each such region
  // must be one git wrote without markers, never a lost edit.
  const kept: string[] = [];
  for (const c of cases) {
    if (!hasConflictMarkers(c.working)) continue;
    const p = prepared(c.payload);
    const seed = seedFromWorking(p, c.working);
    if (seed.kind !== "markers") continue;
    for (const k of seed.keep) {
      const blocks = p.model.blocks.filter((b) => k.blockIds.includes(b.id));
      if (blocks.some((b) => b.kind !== "conflict")) kept.push(`${c.scenario} ${c.path}: a non-conflict kept`);
      if (k.lines.some((l) => /^(<{7}|={7}|>{7}|\|{7})( |$)/.test(l))) kept.push(`${c.scenario} ${c.path}: kept a marker`);
    }
  }
  assert.deepEqual(kept, []);
});

// Line splitting is the engine's own; pinned so the helpers above agree with it.
test("the helpers split lines the way the view does", () => {
  assert.deepEqual(splitLines("a\nb\n"), ["a", "b", ""]);
});
