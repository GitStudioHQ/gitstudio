import "./support/useVscodeStub";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OperationOutcome, OperationView } from "@gitstudio/host-bridge/conflictsProtocol";
import { driveVerb } from "../src/register";
import type { MergeHostCore } from "../src/host";
import type { MergeRepo } from "../src/product";
import { view } from "./fixtures";

// Continue / Skip / Abort from a command. The rebase workspace runs Skip
// through gitstudio.operation.skip and shows the outcome in its own stop
// banner — and the command ALSO toasted it, so one Skip was reported twice.
// A caller that reports the outcome itself asks for `quiet`.

function hostRecording(toasts: string[], asked: string[] = []): MergeHostCore {
  return {
    product: {
      ask: async (spec: { title: string }) => {
        asked.push(spec.title);
        return true;
      },
      commands: { showConflicts: "test.showConflicts" },
      viewTypes: { mergeEditor: "test.mergeEditor" },
    },
    notify: async (_kind: string, text: string) => {
      toasts.push(text);
      return undefined;
    },
    changed: () => undefined,
  } as unknown as MergeHostCore;
}

function repoSkipping(): MergeRepo {
  const done: OperationOutcome = { ok: true, view: view("none"), remainingConflicts: 0 };
  return {
    root: "/r",
    ctx: { operation: { skip: async () => done, detect: async () => ({ kind: "rebase", unmerged: 0 }) } },
  } as unknown as MergeRepo;
}

const skippable: OperationView = view("rebase", {
  canSkip: true,
  verbs: { abort: "Abort Rebase", skip: "Skip this commit", continue: "Continue Rebase" },
});

test("a quiet verb asks first, runs, and leaves the reporting to its caller", async () => {
  const toasts: string[] = [];
  const asked: string[] = [];
  const out = await driveVerb(hostRecording(toasts, asked), repoSkipping(), skippable, "skip", { quiet: true });
  assert.equal(out?.ok, true);
  assert.deepEqual(asked, ["Skip this commit?"], "the confirm is still the command's");
  assert.deepEqual(toasts, [], "no toast: the rebase workspace's banner says what happened");
});

test("without quiet, the command reports the outcome once", async () => {
  const toasts: string[] = [];
  await driveVerb(hostRecording(toasts), repoSkipping(), skippable, "skip");
  assert.deepEqual(toasts, ["Last commit skipped — the rebase is complete, without it."]);
});

test("the rebase workspace's Skip asks the command to be quiet", () => {
  const src = readFileSync(join(__dirname, "../../../apps/extension/src/rebase/rebaseWorkspacePanel.ts"), "utf8");
  const at = src.indexOf('"gitstudio.operation.skip"');
  assert.ok(at > 0);
  assert.match(src.slice(at, at + 400), /quiet: true/);
});
