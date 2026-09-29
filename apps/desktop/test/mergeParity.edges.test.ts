// The edges of the desktop's merge mapping (mergeParity.ts) that
// mergeShellMount.test.ts leaves out: the session's merge-settings cache, the
// shared one-verb-at-a-time lock, the "stopped again" words, what the merge
// shell's adapter does when there is no operation or when a call throws, and
// the dashboard controller's detach / outcome / lock-held / failure paths.
//
// Pure logic, driven with a fake `invoke` that records every channel sent.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MERGE_SETTINGS,
  type ConflictsSnapshot,
  type ConflictsState,
  type OperationOutcome,
  type OperationView,
} from "@gitstudio/host-bridge/conflictsProtocol";
import type { HostMessage } from "@gitstudio/host-bridge/protocol";
import {
  DesktopConflicts,
  DesktopMergeAdapter,
  exclusive,
  forgetMergeSettings,
  loadMergeSettings,
  opIndicator,
  outcomeLine,
  saveMergeSettings,
  stripText,
  submoduleCommits,
  verbRunning,
  type Invoke,
} from "../src/renderer/mergeParity";
import type { ConflictModel, GitOpState } from "../src/shared/ipc";

const side = (role: "yours" | "theirs", stage: 2 | 3, name: string) => ({
  role,
  stage,
  name,
  paneTitle: `${role} pane`,
  description: `${role} (${name})`,
});

const REBASE: OperationView = {
  kind: "rebase",
  backend: "merge",
  title: "Rebasing test onto master · commit 1 of 3: 1a2b3c4 test change",
  direction: { from: "yours", verb: "onto", to: "theirs" },
  step: { n: 1, m: 3, unit: "commit" },
  commit: { sha: "1a2b3c4d5e6f", subject: "test change" },
  yours: side("yours", 3, "test"),
  theirs: side("theirs", 2, "master"),
  verbs: { continue: "Continue Rebase", abort: "Abort Rebase" },
  canContinue: false,
  canSkip: false,
  episode: "rebase:1a2b3c4",
};

const model = (over: Partial<ConflictModel> = {}): ConflictModel => ({
  path: "src/app.ts",
  hasBase: true,
  base: "b\n",
  ours: "o\n",
  theirs: "t\n",
  result: "r\n",
  oursLabel: "ours",
  theirsLabel: "theirs",
  ...over,
});

const snapshot = (over: Partial<ConflictsSnapshot> = {}): ConflictsSnapshot => ({
  repoName: "demo",
  op: REBASE,
  files: [{ path: "src/app.ts", status: "pending", shape: "text" }],
  total: 1,
  resolved: 0,
  ...over,
});

type Answer = unknown | ((p: unknown) => unknown);
function fakeHost(answers: Record<string, Answer>) {
  const calls: Array<{ channel: string; payload: unknown }> = [];
  const invoke = (async (channel: string, payload: unknown) => {
    calls.push({ channel, payload });
    const a = answers[channel];
    if (a === undefined) throw new Error(`no answer for ${channel}`);
    return typeof a === "function" ? (a as (p: unknown) => unknown)(payload) : a;
  }) as unknown as Invoke;
  return { invoke, calls, sent: (ch: string) => calls.filter((c) => c.channel === ch) };
}
const OK = { ok: true, changed: true };
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

// ── submodules ───────────────────────────────────────────────────────────────

test("a submodule's commits are read from the snapshot; a read that fails means none, not an error", async () => {
  const sub = model({ shape: "submodule" });
  const ok = fakeHost({
    "conflict:state": snapshot({ files: [{ path: "src/app.ts", status: "pending", shape: "submodule", commits: { yours: "aaa", theirs: "bbb" } }] }),
  });
  assert.deepEqual(await submoduleCommits(ok.invoke, sub), { yours: "aaa", theirs: "bbb" });
  const down = fakeHost({});
  assert.equal(await submoduleCommits(down.invoke, sub), undefined);
  assert.equal(down.calls.length, 1);
  assert.equal(await submoduleCommits(down.invoke, model()), undefined);
  assert.equal(down.calls.length, 1, "a text conflict never asks");
});

// ── settings for the session ─────────────────────────────────────────────────

test("merge settings are read once per session, over the defaults", async () => {
  forgetMergeSettings();
  const h = fakeHost({ "merge:settings": { autoApplyNonConflicting: true } });
  const a = await loadMergeSettings(h.invoke);
  const b = await loadMergeSettings(h.invoke);
  assert.deepEqual(a, { ...DEFAULT_MERGE_SETTINGS, autoApplyNonConflicting: true });
  assert.equal(b, a);
  assert.equal(h.sent("merge:settings").length, 1, "cached");

  forgetMergeSettings();
  const empty = fakeHost({ "merge:settings": null });
  assert.deepEqual(await loadMergeSettings(empty.invoke), DEFAULT_MERGE_SETTINGS, "no answer yet: the defaults");
});

test("a main process that cannot answer yet means the defaults — and the next session asks again", async () => {
  forgetMergeSettings();
  const down = fakeHost({});
  assert.deepEqual(await loadMergeSettings(down.invoke), DEFAULT_MERGE_SETTINGS);
  forgetMergeSettings();
  const up = fakeHost({ "merge:settings": { autoApplyNonConflicting: true } });
  assert.equal((await loadMergeSettings(up.invoke)).autoApplyNonConflicting, true);
  assert.equal(up.calls.length, 1);
});

test("saving answers what main actually stored, and that is what the next load returns", async () => {
  forgetMergeSettings();
  const h = fakeHost({ "merge:setSettings": (p: unknown) => ({ ...(p as object), stored: "by main" }), "merge:settings": {} });
  const saved = await saveMergeSettings(h.invoke, { autoApplyNonConflicting: true });
  assert.deepEqual(saved, { ...DEFAULT_MERGE_SETTINGS, autoApplyNonConflicting: true, stored: "by main" });
  assert.deepEqual(h.sent("merge:setSettings").map((c) => c.payload), [{ autoApplyNonConflicting: true }]);
  assert.equal(await loadMergeSettings(h.invoke), saved);
  assert.equal(h.sent("merge:settings").length, 0, "no second read after a save");

  const blank = (async () => undefined) as unknown as Invoke;
  assert.deepEqual(await saveMergeSettings(blank, {}), DEFAULT_MERGE_SETTINGS, "an empty answer: the defaults");
  forgetMergeSettings();
});

// ── outcomes ─────────────────────────────────────────────────────────────────

const stopped = (view: OperationView, message?: string): OperationOutcome =>
  ({ ok: false, stopped: true, expected: true, view, remainingConflicts: 1, ...(message ? { message } : {}) }) as OperationOutcome;

test("a Continue that stopped again says where — the pause's own words, the step, or just 'again'", () => {
  assert.deepEqual(outcomeLine(stopped({ ...REBASE, step: { n: 2, m: 3, unit: "commit" } }), REBASE, "continue"), {
    kind: "stopped",
    text: "Stopped at commit 2 of 3: there is more to resolve.",
  });
  assert.equal(
    outcomeLine(stopped({ ...REBASE, pause: { reason: "edit", detail: "Stopped to edit 1a2b3c4 — amend, then Continue." } }), REBASE, "continue").text,
    "Stopped to edit 1a2b3c4 — amend, then Continue.",
  );
  assert.equal(outcomeLine(stopped({ ...REBASE, step: undefined }), REBASE, "continue").text, "Stopped again: there is more to resolve.");
  assert.equal(outcomeLine(stopped(REBASE, "git's own words"), REBASE, "continue").text, "git's own words");
});

// ── the shared lock ──────────────────────────────────────────────────────────

test("one verb at a time: a second press while one runs runs nothing, and the lock always comes off", async () => {
  let release!: () => void;
  let runs = 0;
  const first = exclusive(async () => {
    runs++;
    await new Promise<void>((r) => (release = r));
    return "first";
  });
  assert.equal(verbRunning(), true);
  assert.equal(
    await exclusive(async () => {
      runs++;
      return "second";
    }),
    undefined,
  );
  release();
  assert.equal(await first, "first");
  assert.equal(runs, 1);
  assert.equal(verbRunning(), false);
  await assert.rejects(
    exclusive(async () => {
      throw new Error("git died");
    }),
    /git died/,
  );
  assert.equal(verbRunning(), false, "a throw releases it too");
});

// ── the merge shell's adapter ────────────────────────────────────────────────

function adapterRig(answers: Record<string, Answer>, m: ConflictModel = model({ op: REBASE }), over: { onExit?: () => void } = {}) {
  const host = fakeHost(answers);
  const delivered: HostMessage[] = [];
  const log: string[] = [];
  const errors: Array<[string, string]> = [];
  const adapter = new DesktopMergeAdapter(m, {
    invoke: host.invoke,
    deliver: (msg) => delivered.push(msg),
    onResolved: () => log.push("resolved"),
    onExit: over.onExit ?? (() => log.push("exit")),
    onOperationChanged: (o) => log.push(`op:${o.kind}`),
    undoable: () => log.push("undoable"),
    notify: (message, kind) => errors.push([kind, message]),
  });
  return { ...host, adapter, delivered, log, errors };
}

test("post() hands the shell's message to the same handler", async () => {
  const r = adapterRig({ "conflict:takeRole": OK, "conflict:state": snapshot() });
  r.adapter.post({ type: "takeRole", role: "theirs" });
  await flush();
  assert.deepEqual(r.sent("conflict:takeRole").map((c) => c.payload), [{ path: "src/app.ts", role: "theirs" }]);
  assert.equal(r.delivered[0].type, "applied");
});

test("a whole-file resolution git refuses is said, never reported as staged", async () => {
  const r = adapterRig({ "conflict:takeRole": { ok: false, message: "not conflicted any more" } });
  await r.adapter.handle({ type: "takeRole", role: "yours" });
  assert.deepEqual(r.delivered, [{ type: "applied", staged: false, message: "not conflicted any more" }]);
  assert.deepEqual(r.log, [], "no undo, no repaint");
  const silent = adapterRig({ "conflict:delete": { ok: false } });
  await silent.adapter.handle({ type: "deleteFile" });
  assert.deepEqual(silent.delivered, [{ type: "applied", staged: false, message: "Couldn't resolve src/app.ts." }]);
});

test("with no operation known there is nothing to continue or abort", async () => {
  const r = adapterRig({}, model());
  await r.adapter.handle({ type: "continueOperation" });
  assert.deepEqual(r.calls, []);
  assert.deepEqual(r.log, []);
  await r.adapter.handle({ type: "cancel", mode: "abort" });
  assert.deepEqual(r.calls, [], "an Abort with nothing to abort sends nothing…");
  assert.deepEqual(r.log, ["exit"], "…and just leaves the merge view");
});

test("messages the desktop has nothing to do for send nothing", async () => {
  const r = adapterRig({});
  await r.adapter.handle({ type: "ready" } as never);
  await r.adapter.handle({ type: "resultChanged", text: "x" } as never);
  assert.deepEqual(r.calls, []);
  assert.deepEqual(r.delivered, []);
});

test("a call that throws becomes the shell's own failure message for that verb", async () => {
  const apply = adapterRig({});
  await apply.adapter.handle({ type: "apply", text: "merged\n" });
  assert.deepEqual(apply.delivered, [{ type: "applied", staged: false, message: "no answer for conflict:resolve" }]);
  const take = adapterRig({});
  await take.adapter.handle({ type: "takeRole", role: "yours" });
  assert.deepEqual(take.delivered, [{ type: "applied", staged: false, message: "no answer for conflict:takeRole" }]);

  const cont = adapterRig({});
  await cont.adapter.handle({ type: "continueOperation" });
  assert.deepEqual(cont.delivered, [{ type: "outcome", kind: "failed", text: "no answer for op:continue" }]);
  assert.deepEqual(cont.log, [], "the operation did not change");

  const exit = adapterRig({}, model({ op: REBASE }), {
    onExit: () => {
      throw "the dashboard is gone";
    },
  });
  await exit.adapter.handle({ type: "showConflicts" });
  assert.deepEqual(exit.errors, [["error", "the dashboard is gone"]], "anything else is an error toast");
});

test("after a resolution, a state read that fails leaves the shell as it was — the resolution still counts", async () => {
  const r = adapterRig({ "conflict:takeRole": OK });
  await r.adapter.handle({ type: "takeRole", role: "yours" });
  assert.deepEqual(r.delivered, [{ type: "applied", staged: true }]);
  assert.deepEqual(r.log, ["undoable", "resolved"]);
});

// ── the dashboard controller ─────────────────────────────────────────────────

function controllerRig(answers: Record<string, Answer>) {
  const host = fakeHost(answers);
  const renders: ConflictsState[] = [];
  const log: string[] = [];
  const undos: Array<{ label: string; undo: () => Promise<unknown>; after?: () => void | Promise<void> }> = [];
  const ctl = new DesktopConflicts({
    invoke: host.invoke,
    openMerge: (path) => log.push(`merge:${path}`),
    onFileChanged: () => log.push("file"),
    onOperationChanged: (o) => log.push(`op:${o.kind}:${o.text}`),
    notify: () => {},
    undoable: (_m, a) => undos.push(a),
  });
  const render = (s: ConflictsState): void => void renders.push(s);
  const post = ctl.attach(render);
  return { ...host, ctl, post, render, renders, log, undos, last: () => renders[renders.length - 1] };
}

test("a detached dashboard is no longer painted; detaching some other one changes nothing", async () => {
  const r = controllerRig({ "conflict:state": snapshot() });
  await r.ctl.refresh();
  assert.equal(r.renders.length, 1);
  r.ctl.detach(() => {});
  await r.ctl.refresh();
  assert.equal(r.renders.length, 2, "still attached");
  r.ctl.detach(r.render);
  await r.ctl.refresh();
  assert.equal(r.renders.length, 2);
  assert.equal(r.ctl.current()?.repoName, "demo", "the last state is still there for the strip and the rail");
});

test("an outcome from the merge editor is carried onto the dashboard, and fades two stops later", async () => {
  let op = REBASE;
  const r = controllerRig({ "conflict:state": () => snapshot({ op }) });
  assert.equal(r.ctl.current(), undefined);
  r.ctl.setOutcome({ kind: "done", text: "nothing painted yet" });
  assert.equal(r.renders.length, 0, "no state read yet: nothing to paint");
  await r.ctl.refresh();
  r.ctl.setOutcome({ kind: "stopped", text: "Stopped at commit 2 of 3" });
  assert.deepEqual(r.last().outcome, { kind: "stopped", text: "Stopped at commit 2 of 3" });
  await r.ctl.refresh();
  assert.ok(r.last().outcome, "the stop it led to still shows it");
  op = { ...REBASE, episode: "rebase:2b3c4d5" };
  await r.ctl.refresh();
  assert.equal(r.last().outcome, undefined, "another stop later it is history");
});

test("close and support links are not the desktop's: those actions run nothing", async () => {
  const r = controllerRig({ "conflict:state": snapshot() });
  await r.ctl.handle({ type: "close" } as never);
  await r.ctl.handle({ type: "openExternal", url: "https://example.com" } as never);
  assert.deepEqual(r.calls, []);
  assert.deepEqual(r.log, []);
});

test("Abort runs op:abort and reports the operation's end", async () => {
  let aborted = false;
  const r = controllerRig({
    "conflict:state": () => (aborted ? snapshot({ op: { ...REBASE, kind: "none", episode: "none" }, files: [], total: 0 }) : snapshot()),
    "op:abort": () => {
      aborted = true;
      return { ok: true, view: { ...REBASE, kind: "none", episode: "none" }, remainingConflicts: 0 };
    },
  });
  await r.ctl.refresh();
  await r.ctl.handle({ type: "abort", seq: 4 });
  assert.equal(r.sent("op:abort").length, 1);
  assert.deepEqual(r.log, ["op:done:Rebase ended. The repository is back where it was before it started."]);
  assert.equal(r.last().done, 4);
  assert.equal(r.last().busy, false);
});

test("a verb pressed before any state was read runs nothing, but the press is still answered", async () => {
  const r = controllerRig({ "conflict:state": snapshot() });
  await r.ctl.handle({ type: "continue", seq: 7 });
  assert.deepEqual(r.sent("op:continue"), [], "no operation known, no verb sent");
  assert.equal(r.last().done, 7, "the page hears that press 7 is over");
  assert.deepEqual(r.log, []);
});

test("a row's undo brings the conflict back, then re-reads and repaints Changes", async () => {
  const r = controllerRig({ "conflict:state": snapshot(), "conflict:takeRole": OK, "conflict:restore": { ok: false, expected: true, message: "The rebase already finished." } });
  await r.ctl.refresh();
  await r.ctl.handle({ type: "accept", path: "src/app.ts", role: "yours", seq: 1 });
  assert.equal(r.undos.length, 1);
  assert.equal(r.undos[0].label, "Bring back the conflict in src/app.ts");
  assert.deepEqual(await r.undos[0].undo(), { info: "The rebase already finished." });
  const readsBefore = r.sent("conflict:state").length;
  r.log.length = 0;
  await r.undos[0].after?.();
  await flush();
  assert.deepEqual(r.log, ["file"]);
  assert.equal(r.sent("conflict:state").length, readsBefore + 1);
});

test("a row press while the merge editor holds the lock runs nothing, and the row is freed", async () => {
  const r = controllerRig({ "conflict:state": snapshot(), "conflict:takeRole": OK });
  await r.ctl.refresh();
  let release!: () => void;
  const editorVerb = exclusive(() => new Promise<void>((res) => (release = res)));
  await r.ctl.handle({ type: "accept", path: "src/app.ts", role: "theirs", seq: 3 });
  assert.deepEqual(r.sent("conflict:takeRole"), [], "the editor's Continue is running");
  assert.equal(r.last().done, 3);
  assert.equal(r.last().files[0].status, "pending", "the row is not left busy");
  assert.deepEqual(r.log, [], "nothing changed, so Changes is not repainted");
  release();
  await editorVerb;
});

test("a row action that throws puts the reason above the list", async () => {
  const r = controllerRig({ "conflict:state": snapshot() });
  await r.ctl.refresh();
  await r.ctl.handle({ type: "delete", path: "src/app.ts", seq: 2 });
  assert.deepEqual(r.last().notice, { kind: "error", text: "no answer for conflict:delete" });
  assert.equal(r.last().done, 2);
  assert.equal(r.last().files[0].status, "pending");
});

// ── the rail and the strip ───────────────────────────────────────────────────

test("a revert and a patch series are named in the rail's words", () => {
  const op = (over: Partial<GitOpState>): GitOpState => ({
    merging: false,
    rebasing: false,
    cherryPicking: false,
    reverting: false,
    amApplying: false,
    conflicts: 0,
    nothingToCommit: false,
    kind: null,
    canContinue: false,
    canSkip: false,
    ...over,
  });
  assert.deepEqual(opIndicator(op({ kind: "revert", reverting: true, conflicts: 1 })), {
    badge: "1",
    label: "Reverting · 1 conflict",
    title: "Reverting: 1 file has conflicts — open Changes to resolve",
  });
  assert.deepEqual(opIndicator(op({ kind: "am", amApplying: true })), {
    badge: "•",
    label: "Applying patches · paused",
    title: "Applying patches is paused — open Changes to continue or abort",
  });
  assert.equal(opIndicator(op({ conflicts: 3 }))?.title, "3 files have conflicts — open Changes to resolve");
});

test("the Changes strip names the operation and counts what is left", () => {
  const s = snapshot({
    files: [
      { path: "a", status: "pending", shape: "text" },
      { path: "b", status: "resolved", shape: "text" },
      { path: "c", status: "pending", shape: "binary" },
    ],
  });
  assert.deepEqual(stripText(s), { chip: "Rebase in progress", title: REBASE.title, pending: 2 });
});
