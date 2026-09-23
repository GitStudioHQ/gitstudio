import { settle, stub } from "./support/useVscodeStub";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as vscode from "vscode";
import { buildMergeModel } from "@gitstudio/engine/mergeModel";
import { diffSide, splitLines } from "@gitstudio/engine/lineDiff";
import { parseConflictMarkers } from "@gitstudio/engine/conflict/markers";
import { category, type MergeCategory } from "@gitstudio/engine/types";
import type { HostMessage } from "@gitstudio/host-bridge/protocol";
import {
  DEMO_DIFF,
  DEMO_MERGE,
  SAMPLE_APPLIED,
  SAMPLE_OP,
  sampleAnswer,
  sampleFileText,
  samplePayload,
} from "../src/demoContent";
import { sampleUri } from "../src/demo";
import { ExitGuard } from "../src/exitGuard";
import type { MergeHostCore } from "../src/host";
import type { JetBrainsUi } from "../src/jetbrainsUi";
import { MergeEditorProvider } from "../src/mergeEditorProvider";
import type { MergeProduct } from "../src/product";

// POLISH A6.1 — the sample merge the walkthroughs open. What it holds is read
// from the ENGINE, never typed here: the four categories the legend counts
// (conflict, same on both sides, Yours only, Theirs only) each occur, and the
// counts below are whatever buildMergeModel says.

beforeEach(() => stub.reset());

function counts(whitespace: "none" | "all"): Record<MergeCategory, number> & { resolvable: number } {
  const m = buildMergeModel(DEMO_MERGE.base, DEMO_MERGE.yours, DEMO_MERGE.theirs, { whitespace });
  const c = { conflict: 0, same: 0, "yours-only": 0, "theirs-only": 0, resolvable: 0 };
  for (const b of m.blocks) {
    c[category(b)]++;
    if (b.kind === "conflict" && b.resolvable) c.resolvable++;
  }
  return c;
}

test("the sample shows every category the legend names, and a conflict the wand resolves", () => {
  const c = counts("none");
  for (const k of ["conflict", "same", "yours-only", "theirs-only"] as const) {
    assert.ok(c[k] >= 1, `no ${k} block in the sample (${JSON.stringify(c)})`);
  }
  assert.ok(c.resolvable >= 1, "no conflict the wand can resolve");
  assert.ok(c.conflict > c.resolvable, "and one it cannot");
});

test("ignoring whitespace turns a whitespace-only conflict into a change made alike", () => {
  const none = counts("none");
  const all = counts("all");
  assert.ok(all.conflict < none.conflict, `conflicts ${none.conflict} → ${all.conflict}`);
  assert.ok(all.same > none.same, `same on both sides ${none.same} → ${all.same}`);
});

test("the sample's file is what git leaves at such a stop: every conflict marked, stage 2 (theirs) first", () => {
  const text = sampleFileText();
  const conflicts = counts("none").conflict;
  assert.equal((text.match(/^<{7} /gm) ?? []).length, conflicts, "one marker block per conflict");
  assert.match(text, /^<{7} Theirs \(main\)$/m, "a rebase writes main first, as git does");
  assert.match(text, /^>{7} Yours \(feature\/session-hardening\)$/m);
  const parsed = parseConflictMarkers(text);
  assert.equal(parsed.isDiff3, true);
});

test("it opens as a rebase stop with names, step and commit — and nothing in it can run git", () => {
  const p = samplePayload({ autoApplyNonConflicting: false });
  assert.equal(p.op?.title, "Sample · rebasing feature/session-hardening onto main · commit 2 of 3");
  assert.equal(p.op?.yours.name, "feature/session-hardening");
  assert.equal(p.op?.theirs.name, "main");
  assert.equal(p.op?.commit?.subject, "Bind sessions to the device");
  assert.equal(p.oursLabel, SAMPLE_OP.yours.paneTitle, "Yours on the left, as in a real rebase");
  assert.equal(p.ours, DEMO_MERGE.yours);
  assert.equal(p.op?.kind, "none", "no operation for Cancel to abort");
  assert.equal(p.op?.verbs.continue, undefined, "and no Continue");
  assert.equal(p.jetbrainsName, undefined, "no IDE hand-off of a file that is not on disk");
});

test("the sample answers the page: stages, nothing left to resolve, an explanation for Apply, a close for Cancel", () => {
  const ready = sampleAnswer({ type: "ready" }, { autoApplyNonConflicting: true });
  assert.deepEqual(ready.post.map((m) => m.type), ["init", "opChanged"]);
  const init = ready.post[0] as Extract<HostMessage, { type: "init" }>;
  assert.equal(init.autoApplyNonConflicting, true, "the product's setting travels");
  assert.deepEqual(ready.post[1], { type: "opChanged", op: SAMPLE_OP, remainingConflicts: 0 });
  assert.deepEqual(sampleAnswer({ type: "apply", text: "x" }, { autoApplyNonConflicting: false }).post, [
    { type: "outcome", kind: "done", text: SAMPLE_APPLIED },
  ]);
  assert.match(SAMPLE_APPLIED, /In a real conflict, Apply saves and stages the file, then Continue Rebase appears/);
  assert.equal(sampleAnswer({ type: "cancel", mode: "exit" }, { autoApplyNonConflicting: false }).close, true);
  assert.equal(sampleAnswer({ type: "cancel", mode: "abort" }, { autoApplyNonConflicting: false }).close, true);
  assert.deepEqual(sampleAnswer({ type: "resultChanged", text: "x" }, { autoApplyNonConflicting: false }).post, []);
});

test("no invented symbols in anything the sample says", () => {
  const words = [
    DEMO_MERGE.title,
    SAMPLE_OP.title,
    SAMPLE_OP.yours.paneTitle,
    SAMPLE_OP.theirs.paneTitle,
    SAMPLE_OP.yours.description,
    SAMPLE_OP.theirs.description,
    SAMPLE_OP.verbs.abort,
    SAMPLE_APPLIED,
    DEMO_DIFF.leftLabel,
    DEMO_DIFF.rightLabel,
  ].join("\n");
  assert.doesNotMatch(words, /[≠=‹›≈✨]/u);
});

test("the sample diff shows a deleted line and a whitespace-only change, labelled as a sample", () => {
  assert.equal(DEMO_DIFF.leftLabel, "Sample · before");
  assert.equal(DEMO_DIFF.rightLabel, "Sample · after");
  const left = splitLines(DEMO_DIFF.leftText);
  const right = splitLines(DEMO_DIFF.rightText);
  const exact = diffSide(left, right, "right");
  assert.ok(exact.some((c) => c.role === "deleted"), "a deleted line");
  const blind = diffSide(left, right, "right", { whitespace: "all" });
  assert.ok(blind.length < exact.length, "a change that is whitespace only");
});

function sampleHost(): MergeHostCore {
  return {
    context: { extensionUri: vscode.Uri.file("/ext") } as unknown as vscode.ExtensionContext,
    product: {
      key: "merge-studio",
      displayName: "Merge Studio",
      settingsSection: "test.merge",
      viewTypes: { mergeEditor: "test.mergeEditor", diffView: "test.diff", conflicts: "test.conflicts" },
      locator: { all: () => [], forPath: () => undefined, active: () => undefined, onDidChange: () => new vscode.Disposable(() => {}) },
    } as unknown as MergeProduct,
    exitGuard: new ExitGuard(),
    settings: () => ({
      autoOpen: true,
      autoApplyNonConflicting: false,
      conflictResolver: "embedded",
      diffTool: "embedded",
      preferredIde: "auto",
      jetbrainsPath: "",
    }),
    defers: () => false,
    notify: async () => undefined,
    changed: () => {},
  };
}

test("the sample is served from its own scheme, titled as a sample, and its editor writes nothing", async () => {
  const host = sampleHost();
  const uri = sampleUri(host.product);
  assert.equal(uri.scheme, "merge-studio-sample");
  assert.doesNotMatch(uri.toString(), /globalStorage/);
  const provider = new MergeEditorProvider(host, { detect: async () => undefined, cachedName: () => undefined } as unknown as JetBrainsUi);
  const document = { uri, getText: () => sampleFileText(), lineCount: 40, isDirty: false } as unknown as vscode.TextDocument;
  const panel = vscode.window.createWebviewPanel("test.mergeEditor", "x", vscode.ViewColumn.Active, {});
  await provider.resolveCustomTextEditor(document, panel, {} as vscode.CancellationToken);
  assert.equal(panel.title, "Sample: authorizeRequest.ts");
  stub.panels[0].receive({ type: "ready" });
  stub.panels[0].receive({ type: "resultChanged", text: "anything" });
  stub.panels[0].receive({ type: "apply", text: "anything" });
  await settle();
  assert.deepEqual(stub.panels[0].posted.map((m) => (m as HostMessage).type), ["init", "opChanged", "outcome"]);
  assert.equal(stub.applied.length, 0, "no document edit, so nothing to save or to be asked about");
  stub.panels[0].receive({ type: "cancel", mode: "exit" });
  await settle();
  assert.equal(stub.panels[0].disposed, true, "Cancel closes the sample");
});
