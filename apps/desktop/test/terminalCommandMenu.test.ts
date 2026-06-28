import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMenuRows, type MenuAction } from "../src/renderer/terminalCommandMenu";
import type { HistoryItem } from "../src/renderer/terminalCompletion";

const actions: MenuAction[] = [
  { id: "agent", label: "Ask the AI agent", icon: "sparkle" },
  { id: "clear", label: "Clear terminal", icon: "clear-all" },
];

const history: HistoryItem[] = [
  { command: "git status", count: 2, lastIndex: 3 },
  { command: "npm test", count: 5, lastIndex: 2 },
  { command: "ls -la", count: 1, lastIndex: 1 },
];

test("empty query at a prompt shows actions then recents", () => {
  const rows = buildMenuRows("", actions, history, true);
  assert.equal(rows[0].kind, "action");
  assert.ok(rows.some((r) => r.kind === "command" && r.command === "git status"));
});

test("recents are suppressed when not at a prompt (can't rewrite the line)", () => {
  const rows = buildMenuRows("", actions, history, false);
  assert.ok(rows.every((r) => r.kind === "action"));
});

test("query fuzzy-filters actions and history together", () => {
  const rows = buildMenuRows("test", actions, history, true);
  // "test" matches "npm test" but not "Clear terminal"/"git status".
  assert.ok(rows.some((r) => r.kind === "command" && r.command === "npm test"));
  assert.ok(!rows.some((r) => r.kind === "command" && r.command === "git status"));
});

test("a command with multiple runs is annotated with its count", () => {
  const rows = buildMenuRows("npm", actions, history, true);
  const cmd = rows.find((r) => r.kind === "command") as { detail?: string };
  assert.equal(cmd.detail, "5×");
});

test("recent list is capped by the recent limit", () => {
  const many: HistoryItem[] = Array.from({ length: 20 }, (_, i) => ({
    command: `cmd-${i}`,
    count: 1,
    lastIndex: i,
  }));
  const rows = buildMenuRows("", [], many, true, 5);
  assert.equal(rows.filter((r) => r.kind === "command").length, 5);
});
