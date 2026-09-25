// Drop Commit from the graph's menu (issue #32) — the renderer's half: which
// rows the menu shows, and the flow the "Drop commit…" row runs (ask main,
// refuse or ask the user, run, then Undo / conflict flow / refusal). The flow
// takes everything through DropCommitDeps, so this drives it with scripted
// stand-ins and records what the user was shown, in order.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CommitContextMenu, commitMenuRows } from "../src/renderer/contextMenu";
import { dropCommitFlow, type DropCommitDeps } from "../src/renderer/dropCommit";
import type { DropOutcomeWire, DropPlanWire } from "../src/shared/ipc";
import type { Undoable } from "../src/renderer/undo";

// ── The menu ─────────────────────────────────────────────────────────────────

test("'Drop commit…' is offered only when main says the commit can be dropped", () => {
  const without = commitMenuRows([]).map((r) => r.action);
  assert.ok(!without.includes("drop"), "not offered by default — the menu asks first");
  const rows = commitMenuRows([], { drop: true });
  const at = rows.findIndex((r) => r.action === "drop");
  assert.ok(at > 0, "offered when droppable");
  assert.equal(rows[at].label, "Drop commit…", "sentence case with an ellipsis, like the menu's other asking rows");
  assert.equal(rows[at].danger, true, "danger-styled like Reset (hard)");
  assert.equal(rows[at - 1].action, "revert", "right after Revert…");
  assert.equal(rows[at + 1].action, "reset-soft", "…and before the resets");
  assert.deepEqual(rows.filter((r) => r.action !== "drop").map((r) => r.action), without, "nothing else moves");
});

test("choosing the row runs the drop flow — never a commit:action request", async () => {
  const sent: unknown[] = [];
  const dropped: string[] = [];
  const menu = new CommitContextMenu((req) => sent.push(req), (sha) => dropped.push(sha));
  const dispatch = (menu as unknown as { dispatch(item: unknown, sha: string): Promise<void> }).dispatch.bind(menu);
  const row = commitMenuRows([], { drop: true }).find((r) => r.action === "drop");
  await dispatch(row, "abc1234");
  assert.deepEqual(dropped, ["abc1234"]);
  assert.deepEqual(sent, [], "main's commit:action has no 'drop' verb to run");
});

// ── The flow ─────────────────────────────────────────────────────────────────

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const HEAD = "ffffffffffffffffffffffffffffffffffffffff";
const NEW = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

function okPlan(over: Partial<Extract<DropPlanWire, { ok: true }>> = {}): DropPlanWire {
  return {
    ok: true,
    sha: SHA,
    shortSha: SHA.slice(0, 7),
    subject: "fix: typo",
    head: HEAD,
    branch: "main",
    replayed: 2,
    published: false,
    carryable: [],
    ...over,
  };
}

interface Log {
  events: string[];
  confirms: { title: string; message: string; danger: boolean }[];
  choices: { title: string; hint: string; ids: string[] }[];
  drops: unknown[];
  toasts: { message: string; kind: string }[];
  undoables: { message: string; action: Undoable }[];
  undos: unknown[];
}

function deps(
  script: {
    plan?: DropPlanWire;
    confirm?: boolean;
    choose?: string;
    outcome?: DropOutcomeWire;
    undo?: { ok: boolean; changed: boolean; message?: string; expected?: boolean };
  } = {},
): { d: DropCommitDeps; log: Log } {
  const log: Log = { events: [], confirms: [], choices: [], drops: [], toasts: [], undoables: [], undos: [] };
  const d: DropCommitDeps = {
    plan: async (req) => {
      log.events.push(`plan${req.preflight ? "+preflight" : ""}`);
      return script.plan ?? okPlan();
    },
    drop: async (req) => {
      log.events.push("drop");
      log.drops.push(req);
      return script.outcome ?? { status: "done", before: HEAD, after: NEW };
    },
    undo: async (req) => {
      log.events.push("undo");
      log.undos.push(req);
      return script.undo ?? { ok: true, changed: true };
    },
    confirm: async (opts) => {
      log.events.push("confirm");
      log.confirms.push(opts);
      return script.confirm ?? true;
    },
    choose: async (opts) => {
      log.events.push("choose");
      log.choices.push({ title: opts.title, hint: opts.hint, ids: opts.choices.map((c) => c.id) });
      return script.choose ?? opts.cancelId;
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
      log.events.push("landOnConflicts");
    },
  };
  return { d, log };
}

test("a drop asks main with preflight, confirms in words, runs, and offers Undo", async () => {
  const { d, log } = deps();
  assert.equal(await dropCommitFlow(SHA, d), "done");
  assert.deepEqual(log.events, ["plan+preflight", "confirm", "drop", "undoable", "refresh"]);
  assert.equal(log.confirms[0].title, "Drop a1b2c3d?");
  assert.match(log.confirms[0].message, /a1b2c3d "fix: typo" will be removed from main\./);
  assert.match(log.confirms[0].message, /The 2 commits after it will be replayed/);
  assert.equal(log.confirms[0].danger, true);
  assert.deepEqual(log.drops, [{ sha: SHA, head: HEAD, carry: false }], "the head the question was about travels with the run");
  assert.equal(log.undoables[0].message, "Dropped a1b2c3d.");
  assert.equal(log.undoables[0].action.label, "Put a1b2c3d back");
});

test("Undo sends back the two tips the drop answered with", async () => {
  const { d, log } = deps();
  await dropCommitFlow(SHA, d);
  assert.equal(await log.undoables[0].action.undo(), undefined, "a successful undo reports nothing");
  assert.deepEqual(log.undos, [{ before: HEAD, after: NEW }]);
});

test("an undo refused for an expected reason is said plainly, not as an error", async () => {
  const { d, log } = deps({ undo: { ok: false, changed: false, expected: true, message: "The branch has moved since the drop" } });
  await dropCommitFlow(SHA, d);
  assert.deepEqual(await log.undoables[0].action.undo(), { info: "The branch has moved since the drop" });
});

test("a published commit's question warns about pushed history and the force push", async () => {
  const { d, log } = deps({ plan: okPlan({ published: true }) });
  await dropCommitFlow(SHA, d);
  assert.match(log.confirms[0].message, /Already pushed\. Dropping it would rewrite history other people have\./);
  assert.match(log.confirms[0].message, /force push/);
});

test("uncommitted changes or an operation in progress are said BEFORE any question, and nothing runs", async () => {
  for (const blocked of [
    "You have uncommitted changes. Commit or stash them, then drop the commit.",
    "A merge is still in progress. Commit it — or abort it — before dropping a commit.",
  ]) {
    const { d, log } = deps({ plan: okPlan({ blocked }) });
    assert.equal(await dropCommitFlow(SHA, d), "refused");
    assert.deepEqual(log.events, ["plan+preflight", "toast:info"]);
    assert.equal(log.toasts[0].message, blocked);
  }
});

test("a commit that cannot be dropped any more (the menu went stale) is refused in words", async () => {
  const { d, log } = deps({
    plan: { ok: false, expected: true, reason: "merge", message: "That's a merge commit — dropping it would flatten the history it joined. Revert it instead." },
  });
  assert.equal(await dropCommitFlow(SHA, d), "refused");
  assert.deepEqual(log.events, ["plan+preflight", "toast:info"]);
});

test("Cancel runs nothing", async () => {
  const { d, log } = deps({ confirm: false });
  assert.equal(await dropCommitFlow(SHA, d), "cancelled");
  assert.ok(!log.events.includes("drop"));
});

test("a stop on a conflict hands over to the conflict flow in Changes, neutrally, with no Undo", async () => {
  const { d, log } = deps({
    outcome: { status: "stopped", reason: "conflict", message: "could not apply", before: HEAD },
  });
  assert.equal(await dropCommitFlow(SHA, d), "stopped");
  assert.deepEqual(log.events, ["plan+preflight", "confirm", "drop", "toast:info", "landOnConflicts"]);
  assert.match(log.toasts[0].message, /hit a conflict while replaying a later commit.*abort to put the branch back as it was/);
});

test("a failure is said in the tone main judged it", async () => {
  const moved = "The branch has moved since you chose Drop, so nothing was dropped.";
  const expected = deps({ outcome: { status: "failed", ok: false, expected: true, message: moved } });
  assert.equal(await dropCommitFlow(SHA, expected.d), "failed");
  assert.deepEqual(expected.log.toasts, [{ message: moved, kind: "info" }], "the user's state, in its own words");
  const broken = deps({ outcome: { status: "failed", ok: false, message: "Rebase failed." } });
  await dropCommitFlow(SHA, broken.d);
  assert.deepEqual(broken.log.toasts, [{ message: "Couldn't drop a1b2c3d: Rebase failed.", kind: "error" }]);
});

test("branches on replayed commits get the either/or; 'move' carries them", async () => {
  const { d, log } = deps({ plan: okPlan({ carryable: ["feature"] }), choose: "carry" });
  assert.equal(await dropCommitFlow(SHA, d), "done");
  assert.deepEqual(log.events.slice(0, 3), ["plan+preflight", "choose", "drop"], "the choice IS the confirmation");
  assert.deepEqual(log.choices[0].ids, ["carry", "only"]);
  assert.match(log.choices[0].hint, /feature points at a commit that will be replayed/);
  assert.deepEqual(log.drops, [{ sha: SHA, head: HEAD, carry: true }]);
  const cancelled = deps({ plan: okPlan({ carryable: ["feature"] }) });
  assert.equal(await dropCommitFlow(SHA, cancelled.d), "cancelled");
});
