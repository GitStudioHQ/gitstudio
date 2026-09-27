// Several commits at once from the graph (issue #32) — the renderer's half:
// the rows of the menu for a selection, and the flow each row runs (ask main,
// refuse or ask the user, run, then Undo / conflict flow / refusal). The flow
// takes everything through ManyDeps, so this drives it with scripted
// stand-ins and records what the user was shown, in order — one test per
// cell of {action} × {what main answers} × {what the user answers}.

import { test } from "node:test";
import assert from "node:assert/strict";
import { manyMenuRows } from "../src/renderer/contextMenu";
import { runManyAction, type ManyDeps } from "../src/renderer/multiCommit";
import type { CommitActionResult, CommitsPlanWire, DropOutcomeWire } from "../src/shared/ipc";
import type { Undoable } from "../src/renderer/undo";

// ── The menu ─────────────────────────────────────────────────────────────────

test("the menu for a selection: the extension's words in this app's sentence case, only what applies", () => {
  const all = manyMenuRows(3, { apply: true, drop: true, squash: true });
  assert.deepEqual(
    all.map((r) => r.label),
    ["Cherry-pick 3 commits", "Revert 3 commits", "Squash 3 commits…", "Drop 3 commits…", "Copy SHAs"],
  );
  assert.equal(all.find((r) => r.action === "drop-many")?.danger, true);
  assert.deepEqual(
    manyMenuRows(2, { apply: false, drop: false, squash: false }).map((r) => r.action),
    ["compare-two", "copy-shas"],
    "a merge among them, off the branch: compare (two) and copy remain",
  );
  assert.equal(manyMenuRows(2, { apply: true, drop: false, squash: false }).find((r) => r.action === "compare-two")?.label, "Compare these two commits");
  assert.ok(!manyMenuRows(3, { apply: true, drop: true, squash: true }).some((r) => r.action === "compare-two"), "compare only for two");
  for (const r of all) assert.ok(r.icon, `${r.action} has an icon for the summary's button`);
});

// ── The flows ────────────────────────────────────────────────────────────────

const A = "a".repeat(40);
const B = "b".repeat(40);
const HEAD = "f".repeat(40);
const NEW = "e".repeat(40);

function okPlan(verb: "drop" | "squash", over: Partial<Extract<CommitsPlanWire, { ok: true }>> = {}): CommitsPlanWire {
  return {
    ok: true,
    verb,
    shas: [B, A],
    commits: [
      { shortSha: B.slice(0, 7), subject: "second" },
      { shortSha: A.slice(0, 7), subject: "first" },
    ],
    head: HEAD,
    branch: "main",
    replayed: 1,
    published: false,
    carryable: [],
    ...(verb === "squash" ? { message: "first\n\nsecond" } : {}),
    ...over,
  };
}

interface Log {
  events: string[];
  confirms: { title: string; message: string; danger: boolean; confirmLabel: string }[];
  choices: { title: string; hint: string; ids: string[] }[];
  messages: { title: string; hint: string; value: string; okLabel: string }[];
  rewrites: unknown[];
  applies: unknown[];
  toasts: { message: string; kind: string }[];
  undoables: { message: string; action: Undoable }[];
  undos: unknown[];
  copied: string[];
  compared: Array<[string, string]>;
}

function deps(script: {
  plan?: CommitsPlanWire;
  confirm?: boolean;
  choose?: string;
  message?: string | null;
  outcome?: DropOutcomeWire;
  apply?: CommitActionResult;
  undo?: CommitActionResult;
} = {}): { d: ManyDeps; log: Log } {
  const log: Log = {
    events: [], confirms: [], choices: [], messages: [], rewrites: [], applies: [], toasts: [], undoables: [], undos: [], copied: [], compared: [],
  };
  const d: ManyDeps = {
    plan: async (req) => {
      log.events.push(`plan:${req.verb}:${req.preflight ? "preflight" : "menu"}`);
      return script.plan ?? okPlan(req.verb);
    },
    rewrite: async (req) => {
      log.events.push("rewrite");
      log.rewrites.push(req);
      return script.outcome ?? { status: "done", before: HEAD, after: NEW };
    },
    undo: async (req) => {
      log.events.push("undo");
      log.undos.push(req);
      return script.undo ?? { ok: true, changed: true };
    },
    apply: async (req) => {
      log.events.push("apply");
      log.applies.push(req);
      return script.apply ?? { ok: true, changed: true, before: HEAD, after: NEW, branch: "refs/heads/main" };
    },
    confirm: async (o) => {
      log.events.push("confirm");
      log.confirms.push(o);
      return script.confirm ?? true;
    },
    choose: async (o) => {
      log.events.push("choose");
      log.choices.push({ title: o.title, hint: o.hint, ids: o.choices.map((c) => c.id) });
      return script.choose ?? "cancel";
    },
    message: async (o) => {
      log.events.push("message");
      log.messages.push(o);
      return script.message === undefined ? `edited: ${o.value}` : script.message;
    },
    toast: (message, kind) => {
      log.events.push(`toast:${kind}`);
      log.toasts.push({ message, kind });
    },
    undoable: (message, action) => {
      log.events.push("undoable");
      log.undoables.push({ message, action });
    },
    refresh: async () => {
      log.events.push("refresh");
    },
    landOnConflicts: async () => {
      log.events.push("conflicts");
    },
    copy: async (text) => {
      log.events.push("copy");
      log.copied.push(text);
    },
    compare: (base, head) => {
      log.events.push("compare");
      log.compared.push([base, head]);
    },
  };
  return { d, log };
}

// Drop N ────────────────────────────────────────────────────────────────────

test("drop N: preflight, one confirmation listing them, the run with the head asked about, Undo", async () => {
  const { d, log } = deps();
  assert.equal(await runManyAction("drop-many", [B, A], d), "done");
  assert.deepEqual(log.events, ["plan:drop:preflight", "confirm", "rewrite", "undoable", "refresh"]);
  assert.equal(log.confirms[0].title, "Drop 2 commits?");
  assert.match(log.confirms[0].message, /2 commits will be removed from main: bbbbbbb "second" and aaaaaaa "first"\./);
  assert.equal(log.confirms[0].danger, true);
  assert.equal(log.confirms[0].confirmLabel, "Drop commits");
  assert.deepEqual(log.rewrites[0], { verb: "drop", shas: [B, A], head: HEAD, carry: false });
  assert.equal(log.undoables[0].message, "Dropped 2 commits.");
  await log.undoables[0].action.undo();
  assert.deepEqual(log.undos[0], { before: HEAD, after: NEW, what: "drop" });
});

test("drop N: a refusal or a blocker is said instead of the question; No runs nothing", async () => {
  for (const plan of [
    { ok: false as const, expected: true as const, reason: "past-merge", message: "There's a merge between those commits and the tip." },
    okPlan("drop", { blocked: "You have uncommitted changes. Commit or stash them, then drop the commits." }),
  ]) {
    const { d, log } = deps({ plan });
    assert.equal(await runManyAction("drop-many", [B, A], d), "refused");
    assert.deepEqual(log.events, ["plan:drop:preflight", "toast:info"]);
  }
  const { d, log } = deps({ confirm: false });
  assert.equal(await runManyAction("drop-many", [B, A], d), "cancelled");
  assert.ok(!log.events.includes("rewrite"));
});

test("drop N over published history: the force push is said", async () => {
  const { d, log } = deps({ plan: okPlan("drop", { published: true }) });
  await runManyAction("drop-many", [B, A], d);
  assert.match(log.confirms[0].message, /Some of these commits are already pushed\. Dropping them would rewrite history other people have\. The next push will need to be a force push\./);
});

test("drop N with branches on replayed commits: the either/or IS the confirmation", async () => {
  const { d, log } = deps({ plan: okPlan("drop", { carryable: ["feature"] }), choose: "carry" });
  assert.equal(await runManyAction("drop-many", [B, A], d), "done");
  assert.deepEqual(log.events.slice(0, 3), ["plan:drop:preflight", "choose", "rewrite"]);
  assert.deepEqual(log.choices[0].ids, ["carry", "only"]);
  assert.equal((log.rewrites[0] as { carry: boolean }).carry, true);
});

test("a rewrite that carried branches hands them to its Undo, so they go back too", async () => {
  const carried = [{ branch: "feature", before: "c".repeat(40), after: "d".repeat(40) }];
  for (const verb of ["drop-many", "squash-many"] as const) {
    const v = verb === "drop-many" ? "drop" : "squash";
    const { d, log } = deps({ plan: okPlan(v, { carryable: ["feature"] }), choose: "carry", outcome: { status: "done", before: HEAD, after: NEW, carried } });
    assert.equal(await runManyAction(verb, [B, A], d), "done");
    await log.undoables[0].action.undo();
    assert.deepEqual(log.undos[0], { before: HEAD, after: NEW, what: v, carried }, verb);
  }
});

test("a rewrite that stops on a conflict goes to the conflict flow, neutrally", async () => {
  const { d, log } = deps({ outcome: { status: "stopped", reason: "conflict", message: "could not apply" } });
  assert.equal(await runManyAction("drop-many", [B, A], d), "stopped");
  assert.deepEqual(log.events.slice(-2), ["toast:info", "conflicts"]);
  assert.match(log.toasts[0].message, /Dropping 2 commits hit a conflict/);
});

test("a rewrite that failed is said — info when it is the user's state, error when it is not", async () => {
  for (const [expected, kind] of [[true, "info"], [false, "error"]] as const) {
    const { d, log } = deps({ outcome: { status: "failed", ok: false, message: "boom", ...(expected ? { expected: true as const } : {}) } });
    assert.equal(await runManyAction("drop-many", [B, A], d), "failed");
    assert.equal(log.toasts.at(-1)?.kind, kind);
    assert.ok(!log.events.includes("undoable"));
  }
});

// Squash N ──────────────────────────────────────────────────────────────────

test("squash N: the message editor opens pre-filled, the edited message is what runs, Undo", async () => {
  const { d, log } = deps();
  assert.equal(await runManyAction("squash-many", [B, A], d), "done");
  assert.deepEqual(log.events, ["plan:squash:preflight", "message", "rewrite", "undoable", "refresh"]);
  assert.equal(log.messages[0].title, "Squash 2 commits");
  assert.equal(log.messages[0].value, "first\n\nsecond");
  assert.equal(log.messages[0].okLabel, "Squash commits");
  assert.match(log.messages[0].hint, /will become one commit with the message below/);
  assert.deepEqual(log.rewrites[0], { verb: "squash", shas: [B, A], head: HEAD, carry: false, message: "edited: first\n\nsecond" });
  assert.equal(log.undoables[0].message, "Squashed 2 commits into one.");
  await log.undoables[0].action.undo();
  assert.deepEqual(log.undos[0], { before: HEAD, after: NEW, what: "squash" });
});

test("squash N: dismissing or emptying the editor squashes nothing", async () => {
  for (const message of [null, "   "]) {
    const { d, log } = deps({ message });
    assert.equal(await runManyAction("squash-many", [B, A], d), "cancelled");
    assert.ok(!log.events.includes("rewrite"));
  }
});

test("squash N with a branch on a squashed commit asks whether it comes along, after the message", async () => {
  const { d, log } = deps({ plan: okPlan("squash", { carryable: ["feature"] }), choose: "only" });
  assert.equal(await runManyAction("squash-many", [B, A], d), "done");
  assert.deepEqual(log.events.slice(0, 4), ["plan:squash:preflight", "message", "choose", "rewrite"]);
  assert.equal(log.choices[0].title, "Squash 2 commits — move the branches too?");
  // Its choices are below it, not a message: the editor's words are the editor's.
  assert.doesNotMatch(log.choices[0].hint, /message below/);
  assert.match(log.choices[0].hint, /^bbbbbbb and aaaaaaa on main will become one commit\. .*feature points at a commit that will be rewritten\./);
});

// Cherry-pick N / Revert N ──────────────────────────────────────────────────

test("cherry-pick N: one commit:action with every sha, no question, Undo with the two tips and the branch it ran on", async () => {
  const { d, log } = deps();
  assert.equal(await runManyAction("cherry-pick-many", [B, A], d), "done");
  assert.deepEqual(log.events, ["apply", "undoable", "refresh"]);
  assert.deepEqual(log.applies[0], { action: "cherry-pick", sha: B, shas: [B, A] });
  assert.equal(log.undoables[0].message, "Cherry-picked 2 commits.");
  await log.undoables[0].action.undo();
  // THAT branch goes back, not whichever HEAD is on by the time of the Undo.
  assert.deepEqual(log.undos[0], { before: HEAD, after: NEW, what: "cherry-pick", branch: "refs/heads/main" });
  // Run on a detached HEAD: null says so, and main refuses the Undo once HEAD is on a branch.
  const detached = deps({ apply: { ok: true, changed: true, before: HEAD, after: NEW, branch: null } });
  assert.equal(await runManyAction("revert-many", [B, A], detached.d), "done");
  await detached.log.undoables[0].action.undo();
  assert.deepEqual(detached.log.undos[0], { before: HEAD, after: NEW, what: "revert", branch: null });
});

test("revert N asks first, as one-commit Revert does in this app", async () => {
  const { d, log } = deps({ confirm: false });
  assert.equal(await runManyAction("revert-many", [B, A], d), "cancelled");
  assert.deepEqual(log.events, ["confirm"]);
  assert.equal(log.confirms[0].title, "Revert 2 commits?");
  const ok = deps();
  assert.equal(await runManyAction("revert-many", [B, A], ok.d), "done");
  assert.deepEqual((ok.log.applies[0] as { action: string }).action, "revert");
});

test("cherry-pick N: Cancel at 'changes in the way' says nothing; a pause goes to the conflict flow; a failure is said", async () => {
  const cancelled = deps({ apply: { ok: false, changed: false, expected: true, cancelled: true } });
  assert.equal(await runManyAction("cherry-pick-many", [B, A], cancelled.d), "cancelled");
  assert.deepEqual(cancelled.log.events, ["apply"]);
  const paused = deps({ apply: { ok: false, changed: true, expected: true, paused: true, message: "Cherry-picking 2 commits stopped…" } });
  assert.equal(await runManyAction("cherry-pick-many", [B, A], paused.d), "stopped");
  assert.deepEqual(paused.log.events, ["apply", "toast:info", "conflicts"]);
  const failed = deps({ apply: { ok: false, changed: false, message: "fatal: bad object" } });
  assert.equal(await runManyAction("cherry-pick-many", [B, A], failed.d), "failed");
  assert.deepEqual(failed.log.events, ["apply", "toast:error"]);
  const noTips = deps({ apply: { ok: true, changed: true } });
  await runManyAction("cherry-pick-many", [B, A], noTips.d);
  assert.deepEqual(noTips.log.events, ["apply", "toast:success", "refresh"], "no tips, no Undo offered");
});

// Compare, Copy ─────────────────────────────────────────────────────────────

test("compare these two: older as the base; copy SHAs: every one, a line each", async () => {
  const { d, log } = deps();
  await runManyAction("compare-two", [B, A], d);
  assert.deepEqual(log.compared, [[A, B]]);
  assert.equal(await runManyAction("compare-two", [B, A, HEAD], d), "refused");
  await runManyAction("copy-shas", [B, A], d);
  assert.deepEqual(log.copied, [`${B}\n${A}`]);
});
