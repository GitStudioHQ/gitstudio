import { test } from "node:test";
import assert from "node:assert/strict";
import { fuzzyMatch, matchKind } from "../src/renderer/fuzzyMatch";
import {
  parseInput,
  computeSuggestions,
  type CompletionSources,
} from "../src/renderer/terminalCompletion";

// ── fuzzy matcher (used by the command menu, not the inline dropdown) ──────────

test("fuzzy: subsequence match returns ascending indices", () => {
  const m = fuzzyMatch("gst", "git-status");
  assert.ok(m);
  assert.deepEqual(m!.indices.map((i) => "git-status"[i]), ["g", "s", "t"]);
});

test("fuzzy: non-subsequence returns null", () => {
  assert.equal(fuzzyMatch("zzz", "git-status"), null);
});

test("matchKind tiers", () => {
  assert.equal(matchKind("git", "git"), "exact");
  assert.equal(matchKind("gi", "git"), "prefix");
  assert.equal(matchKind("gt", "git"), "fuzzy");
});

// ── input parsing ─────────────────────────────────────────────────────────────

test("parseInput: command position, command name, and flag detection", () => {
  const a = parseInput("gi");
  assert.equal(a.token, "gi");
  assert.equal(a.isCommandPos, true);
  assert.equal(a.command, "gi");
  assert.equal(a.isFlag, false);

  const b = parseInput("git commit --a");
  assert.equal(b.token, "--a");
  assert.equal(b.isCommandPos, false);
  assert.equal(b.command, "git");
  assert.equal(b.isFlag, true);
});

test("parseInput: path token splits into dir + base", () => {
  const p = parseInput("cat src/comp");
  assert.equal(p.dirPart, "src/");
  assert.equal(p.basePart, "comp");
});

// ── suggestions: prefix-based + context-aware (the screenshot fixes) ───────────

function sources(over: Partial<CompletionSources> = {}): CompletionSources {
  return { history: [], pathCommands: [], builtins: [], dirEntries: [], ...over };
}

test("commands are prefix-matched — NO fuzzy noise (the 'cd' bug)", () => {
  const s = computeSuggestions(
    parseInput("cd"),
    sources({ pathCommands: ["cddafs", "cdrecord", "config_data", "copilot-debug", "cpuwalk.d"] }),
  );
  const reps = s.map((x) => x.replacement);
  assert.ok(reps.includes("cddafs")); // real prefix match
  assert.ok(reps.includes("cdrecord"));
  assert.ok(!reps.includes("config_data")); // was a bogus fuzzy hit before
  assert.ok(!reps.includes("copilot-debug"));
  assert.ok(!reps.includes("cpuwalk.d"));
});

test("a flag token does NOT complete files (the 'git commit --' bug)", () => {
  const s = computeSuggestions(
    parseInput("git commit --"),
    sources({ dirEntries: [{ name: "HANDOFF-AI-MCP.md", isDir: false }] }),
  );
  assert.equal(s.length, 0); // no files, no history → nothing (not garbage)
});

test("cd completes directories only", () => {
  const s = computeSuggestions(
    parseInput("cd "),
    sources({ dirEntries: [
      { name: "src", isDir: true },
      { name: "readme.md", isDir: false },
    ] }),
  );
  const reps = s.map((x) => x.replacement);
  assert.deepEqual(reps, ["src/"]);
});

test("non-cd argument completes files and dirs by prefix", () => {
  const s = computeSuggestions(
    parseInput("cat R"),
    sources({ dirEntries: [
      { name: "README.md", isDir: false },
      { name: "src", isDir: true },
    ] }),
  );
  assert.deepEqual(s.map((x) => x.replacement), ["README.md"]);
});

test("subcommands complete from whole-line history prefix", () => {
  const s = computeSuggestions(
    parseInput("git st"),
    sources({ history: [{ command: "git status", count: 3, lastIndex: 5 }] }),
  );
  const h = s.find((x) => x.type === "history")!;
  assert.equal(h.replacement, "git status");
  assert.equal(h.scope, "line");
  assert.equal(h.detail, "3×");
});

test("path completion builds dir-prefixed replacements", () => {
  const s = computeSuggestions(
    parseInput("cat src/comp"),
    sources({ dirEntries: [
      { name: "components", isDir: true },
      { name: "compat.ts", isDir: false },
      { name: "main.ts", isDir: false },
    ] }),
  );
  const reps = s.map((x) => x.replacement);
  assert.ok(reps.includes("src/components/"));
  assert.ok(reps.includes("src/compat.ts"));
  assert.ok(!reps.includes("src/main.ts"));
});

test("empty line yields nothing", () => {
  assert.equal(computeSuggestions(parseInput(""), sources({ pathCommands: ["git"] })).length, 0);
});

test("history ranks above commands, and exact echo is suppressed", () => {
  const s = computeSuggestions(
    parseInput("git"),
    sources({
      history: [{ command: "git push", count: 2, lastIndex: 4 }],
      pathCommands: ["git", "github", "gitk"],
    }),
  );
  assert.equal(s[0].replacement, "git push"); // history first
  assert.ok(!s.some((x) => x.replacement === "git")); // typed exactly → not echoed
  assert.ok(s.some((x) => x.replacement === "gitk"));
});
