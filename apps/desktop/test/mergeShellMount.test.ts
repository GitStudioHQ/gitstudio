import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MERGE_SETTINGS,
  HOLD_TO_UNDO_MS,
  type ConflictsSnapshot,
  type ConflictsState,
  type OperationOutcome,
  type OperationView,
} from "@gitstudio/host-bridge/conflictsProtocol";
import type { HostMessage } from "@gitstudio/host-bridge/protocol";
import {
  DesktopConflicts,
  DesktopMergeAdapter,
  conflictShape,
  conflictSignature,
  conflictStop,
  mergePayload,
  missingRoleOf,
  opIndicator,
  outcomeLine,
  type Invoke,
} from "../src/renderer/mergeParity";
import type { ConflictModel, GitOpState } from "../src/shared/ipc";

/**
 * How the desktop mounts the SHARED merge shell and conflicts dashboard: the
 * mapping from their host-agnostic messages onto the desktop's IPC channels,
 * and back. Pure logic (mergeParity.ts), driven here with a fake `invoke` that
 * records every channel the renderer would have sent.
 */

const side = (role: "yours" | "theirs", stage: 2 | 3, name: string) => ({
  role,
  stage,
  name,
  paneTitle: `${role} pane`,
  description: `${role} (${name})`,
});

/** A rebase: Yours is stage 3 (D1). */
const REBASE: OperationView = {
  kind: "rebase",
  backend: "merge",
  title: "Rebasing test onto master · commit 1 of 1: 1a2b3c4 test change",
  direction: { from: "yours", verb: "onto", to: "theirs" },
  step: { n: 1, m: 1, unit: "commit" },
  commit: { sha: "1a2b3c4d5e6f", subject: "test change" },
  yours: side("yours", 3, "test"),
  theirs: side("theirs", 2, "master"),
  verbs: { continue: "Continue Rebase", abort: "Abort Rebase" },
  canContinue: false,
  canSkip: false,
  episode: "rebase:1a2b3c4",
};

const NONE: OperationView = {
  ...REBASE,
  kind: "none",
  title: "",
  direction: undefined,
  step: undefined,
  commit: undefined,
  verbs: { abort: "Cancel" },
  episode: "none",
};

const model = (over: Partial<ConflictModel> = {}): ConflictModel => ({
  path: "src/app.ts",
  hasBase: true,
  base: "b\n",
  ours: "o\n",
  theirs: "t\n",
  result: "r\n",
  oursLabel: "Rebasing 1a2b3c4 from test",
  theirsLabel: "Already rebased commits and commits from master",
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

interface Call {
  channel: string;
  payload: unknown;
}

/** A fake main process: records calls, answers from a table, optionally slowly. */
function fakeHost(answers: Record<string, unknown | ((p: unknown) => unknown)>, delayMs = 0) {
  const calls: Call[] = [];
  const invoke = (async (channel: string, payload: unknown) => {
    calls.push({ channel, payload });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const a = answers[channel];
    if (a === undefined) throw new Error(`no answer for ${channel}`);
    return typeof a === "function" ? (a as (p: unknown) => unknown)(payload) : a;
  }) as unknown as Invoke;
  return { invoke, calls, sent: (ch: string) => calls.filter((c) => c.channel === ch) };
}

const OK = { ok: true, changed: true };

// ── the model → payload mapping ─────────────────────────────────────────────

test("a model's shape is read from the main process, else from the legacy flags", () => {
  assert.equal(conflictShape(model({ shape: "binary" })), "binary");
  assert.equal(conflictShape(model({ binary: true })), "binary");
  assert.equal(conflictShape(model({ truncated: true })), "too-large");
  assert.equal(conflictShape(model({ bothDeleted: true })), "both-deleted");
  assert.equal(conflictShape(model({ missingSide: "theirs" })), "modify-delete");
  assert.equal(conflictShape(model({ missingSide: "theirs", hasBase: false })), "added-one-side");
  assert.equal(conflictShape(model({ hasBase: false })), "added-both", "no base, both present: add/add, still text");
  assert.equal(conflictShape(model()), "text");
});

test("a write to the file from outside is the SAME conflict stop, so the open merge editor keeps its work", () => {
  // DiffPanel.showConflict keeps the live editor for an equal signature, and
  // for an equal STOP says "changed on disk" instead of rebuilding — which
  // threw away every accept not applied yet on the watcher's next tick.
  const open = model({ op: REBASE });
  const written = model({ op: REBASE, result: "r\nfive\n" });
  assert.equal(conflictStop(written), conflictStop(open), "the same stop: the editor and its work stay");
  assert.notEqual(conflictSignature(written), conflictSignature(open), "but other text: the merge bar says so");
  assert.equal(conflictSignature(model({ op: REBASE })), conflictSignature(open), "a repaint with nothing new is nothing new");
  const next = model({ op: { ...REBASE, episode: "rebase:2b3c4d5" }, ours: "o2\n" });
  assert.notEqual(conflictStop(next), conflictStop(open), "a Continue that stopped again is another conflict");
  assert.notEqual(conflictStop(model({ op: REBASE, theirs: "t2\n" })), conflictStop(open), "so is one whose sides git changed");
  assert.notEqual(conflictStop(model({ op: REBASE, shape: "binary" })), conflictStop(open), "and one of another shape");
});

test("the side with no file is a ROLE, mapped through the operation — during a rebase stage 2 is Theirs", () => {
  assert.equal(missingRoleOf(model({ missingSide: "ours", op: REBASE })), "theirs");
  assert.equal(missingRoleOf(model({ missingSide: "theirs", op: REBASE })), "yours");
  assert.equal(missingRoleOf(model({ missingSide: "ours" })), "yours", "with no operation, stage 2 is the left side");
  assert.equal(missingRoleOf(model({ missingSide: "ours", missingRole: "yours", op: REBASE })), "yours", "the main process's own answer wins");
});

test("the payload carries the operation, the shape, and auto-apply OFF unless Settings turned it on", () => {
  const p = mergePayload(model({ op: REBASE, missingSide: "ours" }), DEFAULT_MERGE_SETTINGS);
  assert.equal(p.op, REBASE);
  assert.equal(p.autoApplyNonConflicting, false, "the default is OFF (JetBrains' own default)");
  assert.equal(p.shape, "modify-delete");
  assert.equal(p.missingRole, "theirs");
  assert.equal(p.oursLabel, "Rebasing 1a2b3c4 from test");
  const on = mergePayload(model(), { ...DEFAULT_MERGE_SETTINGS, autoApplyNonConflicting: true }, {
    id: "webstorm",
    name: "WebStorm",
    command: "/Applications/WebStorm.app",
  });
  assert.equal(on.autoApplyNonConflicting, true);
  assert.equal(on.jetbrainsName, "WebStorm");
  assert.equal(mergePayload(model({ hasBase: false }), DEFAULT_MERGE_SETTINGS).conflictType, "add-add");
});

test("the desktop no longer auto-applies non-conflicting changes behind the setting's back", async () => {
  // It used to call applyAllNonConflicting() on every open, unconditionally.
  // The setting (default OFF) now travels in the payload to render().
  const src = await readFile(fileURLToPath(new URL("../src/renderer/diffPanel.ts", import.meta.url)), "utf8");
  const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(code, /applyAllNonConflicting\s*\(/, "diffPanel must not apply non-conflicting changes itself");
  assert.match(code, /mergePayload\(/, "the payload (with the setting) is built by mergePayload");
  assert.doesNotMatch(code, /showMerge\(/, "the three-button merge bar is gone");
});

// ── the merge shell's adapter ───────────────────────────────────────────────

function adapterRig(answers: Record<string, unknown | ((p: unknown) => unknown)>, m = model({ op: REBASE }), delay = 0) {
  const host = fakeHost(answers, delay);
  const delivered: HostMessage[] = [];
  const log: string[] = [];
  const undos: Array<{ message: string; undo: () => Promise<string | void> }> = [];
  const notices: Array<{ message: string; action?: { label: string; onClick: () => void } }> = [];
  const adapter = new DesktopMergeAdapter(m, {
    invoke: host.invoke,
    deliver: (msg) => delivered.push(msg),
    onResolved: () => log.push("resolved"),
    onExit: () => log.push("exit"),
    onOperationChanged: (o) => log.push(`op:${o.kind}`),
    undoable: (message, action) => undos.push({ message, undo: action.undo }),
    notify: (message, _kind, action) => notices.push({ message, action }),
  });
  return { ...host, adapter, delivered, log, undos, notices };
}

test("Apply writes and stages through conflict:resolve, offers an undo, and reports the operation", async () => {
  const r = adapterRig({
    "conflict:resolve": OK,
    "conflict:restore": OK,
    "conflict:state": snapshot({ files: [{ path: "src/app.ts", status: "resolved", choice: "merged", shape: "text" }], resolved: 1, op: { ...REBASE, canContinue: true } }),
  });
  await r.adapter.handle({ type: "apply", text: "merged\n" });
  assert.deepEqual(r.sent("conflict:resolve").map((c) => c.payload), [{ path: "src/app.ts", content: "merged\n" }]);
  assert.deepEqual(r.delivered[0], { type: "applied", staged: true });
  assert.deepEqual(r.delivered[1], { type: "opChanged", op: { ...REBASE, canContinue: true }, remainingConflicts: 0 });
  assert.deepEqual(r.log, ["resolved"]);
  assert.equal(r.undos.length, 1, "the resolution is one ⌘Z away");
  await r.undos[0].undo();
  assert.deepEqual(r.sent("conflict:restore").map((c) => c.payload), [{ path: "src/app.ts" }], "undo brings the conflict back");
});

test("an undo git REFUSES as expected (the operation already finished) is news, not an error", async () => {
  // conflict:restore answers {ok:false, expected:true} once the operation the
  // file was resolved in is over (P2's review: checkout -m would otherwise put
  // markers back into a finished merge). That is a plain fact to tell the
  // user, not a failure to paint red — and a real failure still is one.
  const finished = "The operation src/app.ts was resolved in has finished — its conflict can't be brought back.";
  const r = adapterRig({
    "conflict:resolve": OK,
    "conflict:restore": { ok: false, changed: false, expected: true, message: finished },
    "conflict:state": snapshot(),
  });
  await r.adapter.handle({ type: "apply", text: "merged\n" });
  assert.deepEqual(await r.undos[0].undo(), { info: finished }, "an expected refusal is reported as info");
  const broken = adapterRig({
    "conflict:resolve": OK,
    "conflict:restore": { ok: false, changed: false, message: "index.lock exists" },
    "conflict:state": snapshot(),
  });
  await broken.adapter.handle({ type: "apply", text: "merged\n" });
  assert.equal(await broken.undos[0].undo(), "index.lock exists", "a real failure stays an error");
});

// POLISH A1.2 / A1.3: Apply writes the Result over the file, so it asks first
// when the file holds something the merge editor did not make.
const GIT_FILE = "<<<<<<< HEAD\no\n||||||| base\nb\n=======\nt\n>>>>>>> 1a2b3c4 (test)\n";

function askingRig(m: ConflictModel, onDisk: string, answer: boolean) {
  const asked: string[] = [];
  const host = fakeHost({
    "conflict:resolve": OK,
    "conflict:model": { ...m, result: onDisk },
    "conflict:state": snapshot(),
  });
  const delivered: HostMessage[] = [];
  const adapter = new DesktopMergeAdapter(m, {
    invoke: host.invoke,
    deliver: (msg) => delivered.push(msg),
    onResolved: () => {},
    onExit: () => {},
    onOperationChanged: () => {},
    undoable: () => {},
    notify: () => {},
    confirm: async (spec) => {
      asked.push(spec.title);
      return answer;
    },
  });
  return { ...host, adapter, delivered, asked };
}

test("A1.2: Apply over a file already resolved (no markers left) asks — and No writes nothing", async () => {
  const hand = "resolved by hand\n";
  const no = askingRig(model({ op: REBASE, result: hand }), hand, false);
  await no.adapter.handle({ type: "apply", text: "merged\n" });
  assert.deepEqual(no.asked, ["Replace the resolution already in app.ts?"]);
  assert.equal(no.sent("conflict:resolve").length, 0, "nothing written");
  assert.deepEqual(no.delivered, [{ type: "outcome", kind: "failed", text: "Nothing was written. app.ts keeps the resolution it had." }]);
  const yes = askingRig(model({ op: REBASE, result: hand }), hand, true);
  await yes.adapter.handle({ type: "apply", text: "merged\n" });
  assert.equal(yes.sent("conflict:resolve").length, 1, "a yes writes");
});

test("A1.3: Apply over a file edited since the editor opened asks — and No writes nothing", async () => {
  const no = askingRig(model({ op: REBASE, result: GIT_FILE }), GIT_FILE + "typed elsewhere\n", false);
  await no.adapter.handle({ type: "apply", text: "merged\n" });
  assert.deepEqual(no.asked, ["app.ts changed outside the merge editor"]);
  assert.equal(no.sent("conflict:resolve").length, 0);
  assert.match((no.delivered[0] as { text: string }).text, /keeps the edit made outside/);
  // The file as git left it: nothing to ask.
  const same = askingRig(model({ op: REBASE, result: GIT_FILE }), GIT_FILE, false);
  await same.adapter.handle({ type: "apply", text: "merged\n" });
  assert.deepEqual(same.asked, []);
  assert.equal(same.sent("conflict:resolve").length, 1);
});

test("a failed write is said, never reported as staged", async () => {
  const r = adapterRig({ "conflict:resolve": { ok: false, changed: false, message: "index.lock exists" } });
  await r.adapter.handle({ type: "apply", text: "x" });
  assert.deepEqual(r.delivered, [{ type: "applied", staged: false, message: "index.lock exists" }]);
  assert.deepEqual(r.log, [], "nothing to repaint");
  assert.equal(r.undos.length, 0, "and no undo for a change that did not happen");
});

test("an Apply the main process refuses before writing anything is a failure, not an Apply", async () => {
  // `applied` means "the result was written" (protocol.ts). A refusal — the
  // file is no longer conflicted, isn't UTF-8 text, was deleted on both sides
  // — writes nothing, and delivered as `applied{staged:false}` the shell
  // said "Merge applied" above a note saying nothing was written, and spent
  // its Apply button.
  const why = "src/app.ts is no longer conflicted — nothing was written, so a resolution made elsewhere stays as it is.";
  const r = adapterRig({ "conflict:resolve": { ok: false, changed: false, expected: true, message: why } });
  await r.adapter.handle({ type: "apply", text: "x" });
  assert.deepEqual(r.delivered, [{ type: "outcome", kind: "failed", text: why }]);
  assert.deepEqual(r.log, [], "nothing to repaint");
  assert.equal(r.undos.length, 0, "and no undo for a change that did not happen");
});

test("whole-file resolutions go by ROLE when the operation is known, by stage only when it is not", async () => {
  const withOp = adapterRig({ "conflict:takeRole": OK, "conflict:state": snapshot() });
  await withOp.adapter.handle({ type: "takeRole", role: "yours" });
  assert.deepEqual(withOp.sent("conflict:takeRole").map((c) => c.payload), [{ path: "src/app.ts", role: "yours" }]);
  assert.equal(withOp.sent("conflict:takeSide").length, 0, "never the stage-based channel, which cannot know a rebase swaps");

  const noOp = adapterRig({ "conflict:takeSide": OK }, model());
  await noOp.adapter.handle({ type: "takeRole", role: "yours" });
  assert.deepEqual(noOp.sent("conflict:takeSide").map((c) => c.payload), [{ path: "src/app.ts", side: "ours" }]);

  const dd = adapterRig({ "conflict:delete": OK, "conflict:state": snapshot() });
  await dd.adapter.handle({ type: "deleteFile" });
  assert.deepEqual(dd.sent("conflict:delete").map((c) => c.payload), [{ path: "src/app.ts" }]);
  assert.deepEqual(dd.delivered[0], { type: "applied", staged: true });
});

test("Continue and Abort run the operation's verb once, and answer with an outcome and the new operation", async () => {
  const stopped: OperationOutcome = {
    ok: false,
    stopped: true,
    expected: true,
    view: { ...REBASE, step: { n: 2, m: 3, unit: "commit" }, episode: "rebase:next" },
    remainingConflicts: 1,
  };
  const r = adapterRig({ "op:continue": stopped, "op:abort": { ok: true, view: NONE, remainingConflicts: 0 } }, model({ op: REBASE }), 20);
  const first = r.adapter.handle({ type: "continueOperation", confirmDrop: true });
  const second = r.adapter.handle({ type: "continueOperation", confirmDrop: true });
  await Promise.all([first, second]);
  assert.deepEqual(r.sent("op:continue").map((c) => c.payload), [{ confirmDrop: true }], "two presses, ONE continue");
  assert.deepEqual(r.delivered[0], { type: "outcome", kind: "stopped", text: "Stopped at commit 2 of 3: there is more to resolve." });
  assert.deepEqual(r.delivered[1], { type: "opChanged", op: stopped.view, remainingConflicts: 1 });
  assert.deepEqual(r.log, ["op:stopped"]);

  await r.adapter.handle({ type: "cancel", mode: "abort" });
  assert.equal(r.sent("op:abort").length, 1);
  assert.equal((r.delivered[2] as { kind: string }).kind, "done");

  await r.adapter.handle({ type: "cancel" });
  await r.adapter.handle({ type: "cancel", mode: "exit" });
  assert.equal(r.calls.length, 2, "Exit viewer runs nothing in git");
  assert.deepEqual(r.log.slice(-2), ["exit", "exit"]);
});

test("a Continue with no confirm sends an empty request, not a drop confirmation", async () => {
  const r = adapterRig({ "op:continue": { ok: true, view: NONE, remainingConflicts: 0 } });
  await r.adapter.handle({ type: "continueOperation" });
  assert.deepEqual(r.sent("op:continue").map((c) => c.payload), [{}]);
});

test("Open in the IDE hands the file over and offers Mark resolved, which stages it", async () => {
  const r = adapterRig({ "jetbrains:merge": OK, "jetbrains:markResolved": OK });
  await r.adapter.handle({ type: "openInJetBrains" });
  assert.deepEqual(r.sent("jetbrains:merge").map((c) => c.payload), [{ path: "src/app.ts" }]);
  assert.equal(r.notices[0].action?.label, "Mark resolved");
  r.notices[0].action?.onClick();
  await new Promise((res) => setTimeout(res, 5));
  assert.deepEqual(r.sent("jetbrains:markResolved").map((c) => c.payload), [{ path: "src/app.ts" }]);
  assert.ok(r.log.includes("resolved"));
});

test("a host that can show the hand-off gets it, instead of a toast that disappears", async () => {
  // The Changes view replaces the merge editor with the same "Resolving in
  // <IDE>" pane the Settings route shows, whose Mark resolved stays on
  // screen; only a host with nowhere to put it falls back to the toast.
  const handed: string[] = [];
  const host = fakeHost({ "jetbrains:merge": OK });
  const notices: string[] = [];
  const adapter = new DesktopMergeAdapter(model({ op: REBASE }), {
    invoke: host.invoke,
    deliver: () => {},
    onResolved: () => {},
    onExit: () => {},
    onOperationChanged: () => {},
    onHandedToIde: () => {
      handed.push("pane");
      return true;
    },
    undoable: () => {},
    notify: (message) => notices.push(message),
  });
  await adapter.handle({ type: "openInJetBrains" });
  assert.deepEqual(handed, ["pane"], "the host shows the hand-off");
  assert.deepEqual(notices, [], "and no toast is needed");
  const refused = fakeHost({ "jetbrains:merge": { ok: false, changed: false, message: "no IDE" } });
  const handed2: string[] = [];
  const failing = new DesktopMergeAdapter(model({ op: REBASE }), {
    invoke: refused.invoke,
    deliver: () => {},
    onResolved: () => {},
    onExit: () => {},
    onOperationChanged: () => {},
    onHandedToIde: () => {
      handed2.push("pane");
      return true;
    },
    undoable: () => {},
    notify: () => {},
  });
  await failing.handle({ type: "openInJetBrains" });
  assert.deepEqual(handed2, [], "nothing was handed over when the IDE did not open");
});

test("outcomes: done, stopped, and the reasons a refusal gives", () => {
  assert.deepEqual(outcomeLine({ ok: true, view: NONE, remainingConflicts: 0 }, REBASE, "continue"), {
    kind: "done",
    text: "Rebase complete.",
  });
  assert.equal(
    outcomeLine({ ok: false, refused: "blocked", view: { ...REBASE, continueBlocked: "app.ts still has conflict markers staged" }, remainingConflicts: 0 }, REBASE, "continue").text,
    "app.ts still has conflict markers staged",
  );
  const drop = outcomeLine(
    { ok: false, refused: "confirm-drop", view: { ...REBASE, willDrop: { sha: "1a2b3c4d", subject: "test change", branch: "test" } }, remainingConflicts: 0 },
    REBASE,
    "continue",
  );
  assert.equal(drop.kind, "failed");
  assert.match(drop.text, /1a2b3c4 “test change”.*drops it from test/);
  assert.equal(outcomeLine({ ok: false, message: "fatal: could not lock", view: REBASE, remainingConflicts: 1 }, REBASE, "abort").text, "fatal: could not lock");
});

// ── the dashboard's controller ──────────────────────────────────────────────

function controllerRig(answers: Record<string, unknown | ((p: unknown) => unknown)>, delay = 0) {
  const host = fakeHost(answers, delay);
  const renders: ConflictsState[] = [];
  const log: string[] = [];
  const ctl = new DesktopConflicts({
    invoke: host.invoke,
    openMerge: (path) => log.push(`merge:${path}`),
    onFileChanged: () => log.push("file"),
    onOperationChanged: (o) => log.push(`op:${o.kind}:${o.text}`),
    notify: () => {},
    undoable: () => log.push("undoable"),
  });
  const post = ctl.attach((s) => renders.push(s));
  return { ...host, ctl, post, renders, log, last: () => renders[renders.length - 1] };
}

test("the dashboard is fed conflict:state, dressed with the desktop's brand and the hold time", async () => {
  const r = controllerRig({ "conflict:state": snapshot() });
  r.post({ type: "ready" });
  await new Promise((res) => setTimeout(res, 5));
  const s = r.last();
  assert.equal(s.op, REBASE);
  assert.deepEqual(s.brand, { name: "GitStudio", mark: "gitstudio" });
  assert.equal(s.holdToUndoMs, HOLD_TO_UNDO_MS);
  assert.equal(s.busy, false);
  assert.equal(s.supportLinks, undefined, "the desktop's brand slot carries no support links");
});

test("Accept Yours on a row resolves by role, locks the dashboard while it runs, and repaints the list", async () => {
  const r = controllerRig({ "conflict:state": snapshot(), "conflict:takeRole": OK }, 15);
  await r.ctl.refresh();
  const run = r.ctl.handle({ type: "accept", path: "src/app.ts", role: "yours" });
  await new Promise((res) => setTimeout(res, 3));
  assert.equal(r.last().busy, true, "busy while the host works");
  await run;
  assert.deepEqual(r.sent("conflict:takeRole").map((c) => c.payload), [{ path: "src/app.ts", role: "yours" }]);
  assert.equal(r.last().busy, false);
  assert.deepEqual(r.log, ["undoable", "file"]);
});

test("Continue, Skip and Abort each run once, even pressed twice, and the outcome stays on the dashboard", async () => {
  const done: OperationOutcome = { ok: true, view: { ...REBASE, episode: "rebase:done" }, remainingConflicts: 0 };
  // Like the real host: once a verb has run, the state read reports the stop it led to.
  let ran = false;
  const verb = () => {
    ran = true;
    return done;
  };
  const r = controllerRig(
    {
      "conflict:state": () => (ran ? snapshot({ op: done.view, files: [], total: 0 }) : snapshot()),
      "op:continue": verb,
      "op:skip": verb,
      "op:abort": verb,
    },
    15,
  );
  await r.ctl.refresh();
  await Promise.all([r.ctl.handle({ type: "continue" }), r.ctl.handle({ type: "continue" })]);
  assert.deepEqual(r.sent("op:continue").map((c) => c.payload), [{}], "one continue");
  assert.deepEqual(r.last().outcome, { kind: "done", text: "Rebase complete." });
  assert.ok(r.log.includes("op:done:Rebase complete."));
  await r.ctl.handle({ type: "continue", confirmDrop: true });
  assert.deepEqual(r.sent("op:continue")[1].payload, { confirmDrop: true });
  await Promise.all([r.ctl.handle({ type: "skip" }), r.ctl.handle({ type: "abort" })]);
  assert.equal(r.sent("op:skip").length + r.sent("op:abort").length, 1, "a Skip in flight blocks an Abort pressed on top of it");
});

/**
 * A fake host whose `conflict:state` read AFTER a verb is held open until the
 * test releases it — the moment between "git finished the verb" and "the
 * dashboard knows what git did now".
 */
function gatedHost(verbAnswer: (channel: string) => unknown, before: ConflictsSnapshot, after: ConflictsSnapshot) {
  const calls: Call[] = [];
  let ran = false;
  let release: (() => void) | undefined;
  let markPending: () => void = () => {};
  const readPending = new Promise<void>((r) => (markPending = r));
  const invoke = (async (channel: string, payload: unknown) => {
    calls.push({ channel, payload });
    if (channel === "conflict:state") {
      if (!ran) return before;
      const held = new Promise<void>((r) => (release = r));
      markPending();
      await held;
      return after;
    }
    ran = true;
    return verbAnswer(channel);
  }) as unknown as Invoke;
  return {
    invoke,
    calls,
    readPending,
    release: () => release?.(),
    sent: (ch: string) => calls.filter((c) => c.channel === ch),
  };
}

test("the dashboard stays locked until it has read what the verb did — a second press never lands on the old buttons", async () => {
  // The banner this replaced kept its buttons dead through the repaint for
  // exactly this reason: the verb returns in ~10 ms, and a lock released then
  // hands a double-click's second press a LIVE Continue drawn from the state
  // BEFORE the verb. At an edit pause that second Continue walks straight past
  // the stop the user asked for; after a finished merge it reports a failure
  // over "Merge complete".
  const ready = snapshot({ op: { ...REBASE, canContinue: true }, files: [], total: 0 });
  const g = gatedHost(
    () => ({ ok: true, view: { ...NONE, episode: "none" }, remainingConflicts: 0 }),
    ready,
    snapshot({ op: NONE, files: [], total: 0 }),
  );
  const renders: ConflictsState[] = [];
  const ctl = new DesktopConflicts({
    invoke: g.invoke,
    openMerge: () => {},
    onFileChanged: () => {},
    onOperationChanged: () => {},
    notify: () => {},
    undoable: () => {},
  });
  ctl.attach((s) => renders.push(s));
  await ctl.refresh();
  const first = ctl.handle({ type: "continue" });
  await g.readPending;
  const painted = renders[renders.length - 1];
  assert.ok(
    painted.busy || !painted.op.canContinue,
    "while the new state is read, the dashboard must not offer the OLD Continue as live",
  );
  const second = ctl.handle({ type: "continue" });
  g.release();
  await Promise.all([first, second]);
  assert.equal(g.sent("op:continue").length, 1, "a press that lands before the state is read back runs nothing");
  assert.equal(renders[renders.length - 1].busy, false, "and once it is read, the dashboard unlocks");

  // The same window after a whole-file Accept: the row is still drawn pending
  // with live buttons, and a second press asks git to take a side of a file
  // that is no longer conflicted.
  const rowBefore = snapshot();
  const h = gatedHost(
    () => OK,
    rowBefore,
    snapshot({ files: [{ path: "src/app.ts", status: "resolved", choice: "yours", shape: "text" }], resolved: 1 }),
  );
  const rows: ConflictsState[] = [];
  const ctl2 = new DesktopConflicts({
    invoke: h.invoke,
    openMerge: () => {},
    onFileChanged: () => {},
    onOperationChanged: () => {},
    notify: () => {},
    undoable: () => {},
  });
  ctl2.attach((s) => rows.push(s));
  await ctl2.refresh();
  const a = ctl2.handle({ type: "accept", path: "src/app.ts", role: "yours" });
  await h.readPending;
  assert.equal(rows[rows.length - 1].busy, true, "the list stays locked until the resolved row is read back");
  const b = ctl2.handle({ type: "accept", path: "src/app.ts", role: "theirs" });
  h.release();
  await Promise.all([a, b]);
  assert.deepEqual(h.sent("conflict:takeRole").map((c) => c.payload), [{ path: "src/app.ts", role: "yours" }]);
});

test("Merge… opens the file in the merge editor and runs nothing; restore and delete use their own channels", async () => {
  const r = controllerRig({ "conflict:state": snapshot(), "conflict:restore": OK, "conflict:delete": OK });
  await r.ctl.refresh();
  await r.ctl.handle({ type: "merge", path: "src/app.ts" });
  assert.deepEqual(r.log, ["merge:src/app.ts"]);
  assert.equal(r.calls.length, 1, "only the first state read");
  await r.ctl.handle({ type: "restore", path: "src/app.ts" });
  await r.ctl.handle({ type: "delete", path: "gone.ts" });
  assert.deepEqual(r.sent("conflict:restore").map((c) => c.payload), [{ path: "src/app.ts" }]);
  assert.deepEqual(r.sent("conflict:delete").map((c) => c.payload), [{ path: "gone.ts" }]);
});

test("a state read that fails says so on the dashboard instead of showing an empty list", async () => {
  const r = controllerRig({ "conflict:state": snapshot() });
  await r.ctl.refresh();
  const broken = controllerRig({});
  (broken.ctl as unknown as { snapshot: ConflictsSnapshot }).snapshot = snapshot();
  await broken.ctl.refresh();
  assert.equal(broken.last().notice?.kind, "error");
  assert.match(broken.last().notice?.text ?? "", /Couldn't read the conflicts/);

  // A read that works again clears it — but never an action's own error.
  let fail = true;
  const flaky = controllerRig({
    "conflict:state": () => {
      if (fail) throw new Error("index.lock");
      return snapshot();
    },
    "conflict:takeRole": { ok: false, changed: false, message: "src/app.ts is locked" },
  });
  (flaky.ctl as unknown as { snapshot: ConflictsSnapshot }).snapshot = snapshot();
  await flaky.ctl.refresh();
  assert.match(flaky.last().notice?.text ?? "", /index\.lock/);
  fail = false;
  await flaky.ctl.refresh();
  assert.equal(flaky.last().notice, undefined, "the read works again: the read error is gone");
  await flaky.ctl.handle({ type: "accept", path: "src/app.ts", role: "yours" });
  assert.equal(flaky.last().notice?.text, "src/app.ts is locked", "and an action's error survives the refresh after it");
});

// ── the rail badge / top-bar chip ───────────────────────────────────────────

test("the rail badge and chip name a stopped operation, and nothing otherwise", () => {
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
  assert.equal(opIndicator(op({})), undefined);
  assert.equal(opIndicator(undefined), undefined);
  assert.deepEqual(
    [opIndicator(op({ kind: "rebase", rebasing: true, conflicts: 2 }))?.badge, opIndicator(op({ kind: "rebase", rebasing: true, conflicts: 2 }))?.label],
    ["2", "Rebasing · 2 conflicts"],
  );
  assert.equal(opIndicator(op({ kind: "cherry-pick", cherryPicking: true }))?.label, "Cherry-picking · paused");
  // Every conflict resolved and git ready to go on: not "paused" — the verifier
  // found "Merging · paused" on the chip over a merge waiting only for Continue.
  const ready = opIndicator(op({ kind: "merge", merging: true, conflicts: 0, canContinue: true }));
  assert.equal(ready?.label, "Ready to continue");
  assert.equal(ready?.title, "Merging: every conflict is resolved — open Changes to continue");
  assert.equal(opIndicator(op({ conflicts: 1 }))?.label, "1 conflict", "unmerged files with no operation still show");
});

// ── the guard census for the new verbs ─────────────────────────────────────

const RENDERER = fileURLToPath(new URL("../src/renderer", import.meta.url));
async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await tsFiles(p)));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/**
 * The census destructiveGuards.test.ts keeps for the old channels, for the
 * merge-parity verbs: every op:* and whole-file conflict:* request the renderer
 * sends must run under `exclusive(...)`, the one in-flight lock the dashboard
 * and the merge editor share. The main process queues a second call rather
 * than dropping it, so an unguarded Continue pressed twice walks past the next
 * conflicting commit.
 */
test("every operation verb and whole-file resolution the renderer sends runs under the shared lock", async () => {
  const VERB = /invoke\("(op:continue|op:skip|op:abort|conflict:takeRole|conflict:delete|conflict:resolve)"/;
  const unguarded: string[] = [];
  let seen = 0;
  for (const file of await tsFiles(RENDERER)) {
    const lines = (await readFile(file, "utf8")).split("\n");
    lines.forEach((line, i) => {
      if (!VERB.test(line)) return;
      seen++;
      const near = lines.slice(Math.max(0, i - 6), i + 1).join("\n");
      if (/exclusive\(|this\.run\(/.test(near)) return;
      unguarded.push(`${relative(RENDERER, file)}:${i + 1}  ${line.trim().slice(0, 90)}`);
    });
  }
  assert.ok(seen >= 6, `the census found the verbs it checks (${seen})`);
  assert.deepEqual(unguarded, [], `these can run twice:\n${unguarded.join("\n")}`);
});
