import { test } from "node:test";
import assert from "node:assert/strict";
import { fuzzyMatch, matchKind } from "../src/renderer/fuzzyMatch";
import {
  parseInput,
  computeSuggestions,
  type CompletionSources,
} from "../src/renderer/terminalCompletion";

// ── fuzzy matcher ─────────────────────────────────────────────────────────────

test("fuzzy: subsequence match returns ascending indices", () => {
  const m = fuzzyMatch("gst", "git-status");
  assert.ok(m);
  assert.deepEqual(
    m!.indices.map((i) => "git-status"[i]),
    ["g", "s", "t"],
  );
});

test("fuzzy: non-subsequence returns null", () => {
  assert.equal(fuzzyMatch("zzz", "git-status"), null);
});

test("fuzzy: boundary/start matches outscore mid-word matches", () => {
  const atStart = fuzzyMatch("gs", "git-status")!.score; // g(start) s(after '-')
  const midWord = fuzzyMatch("at", "git-status")!.score; // inside words
  assert.ok(atStart > midWord, `${atStart} > ${midWord}`);
});

test("fuzzy: smart case — lowercase query is case-insensitive, mixed is strict", () => {
  assert.ok(fuzzyMatch("read", "README"));
  assert.equal(fuzzyMatch("READ", "readme"), null);
});

test("matchKind tiers", () => {
  assert.equal(matchKind("git", "git"), "exact");
  assert.equal(matchKind("gi", "git"), "prefix");
  assert.equal(matchKind("gt", "git"), "fuzzy");
  assert.equal(matchKind("xyz", "git"), "none");
});

// ── input parsing ─────────────────────────────────────────────────────────────

test("parseInput: first token is command position", () => {
  const p = parseInput("gi");
  assert.equal(p.token, "gi");
  assert.equal(p.isCommandPos, true);
});

test("parseInput: argument after a command is not command position", () => {
  const p = parseInput("git ch");
  assert.equal(p.token, "ch");
  assert.equal(p.isCommandPos, false);
});

test("parseInput: token after a pipe is command position again", () => {
  const p = parseInput("cat x | gre");
  assert.equal(p.token, "gre");
  assert.equal(p.isCommandPos, true);
});

test("parseInput: path token splits into dir + base", () => {
  const p = parseInput("cat src/comp");
  assert.equal(p.token, "src/comp");
  assert.equal(p.dirPart, "src/");
  assert.equal(p.basePart, "comp");
});

// ── suggestion ranking ────────────────────────────────────────────────────────

function sources(over: Partial<CompletionSources> = {}): CompletionSources {
  return {
    history: [],
    pathCommands: [],
    builtins: [],
    dirEntries: [],
    ...over,
  };
}

test("commands: exact beats prefix beats fuzzy", () => {
  const s = computeSuggestions(
    parseInput("gi"),
    sources({ pathCommands: ["gi", "git", "gimp", "imagine"] }),
  );
  // "gi" exact, "git"/"gimp" prefix, "imagine" fuzzy (g..i.. no — 'gi' subseq of imagine? i-m-a-g-i-n-e: g then i → yes)
  assert.equal(s[0].replacement, "gi");
  const order = s.map((x) => x.replacement);
  assert.ok(order.indexOf("git") < order.indexOf("imagine"));
});

test("commands only appear in command position", () => {
  const cmd = computeSuggestions(parseInput("gi"), sources({ pathCommands: ["git"] }));
  assert.ok(cmd.some((x) => x.replacement === "git"));
  const arg = computeSuggestions(parseInput("echo gi"), sources({ pathCommands: ["git"] }));
  assert.ok(!arg.some((x) => x.replacement === "git"));
});

test("path completion builds dir-prefixed replacements and marks dirs", () => {
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
  assert.ok(!reps.includes("src/main.ts")); // doesn't match "comp"
  const dir = s.find((x) => x.replacement === "src/components/")!;
  assert.equal(dir.type, "dir");
  assert.equal(dir.scope, "token");
});

test("history matches the whole line and replaces the whole line", () => {
  const s = computeSuggestions(
    parseInput("git st"),
    sources({ history: [{ command: "git status", count: 3, lastIndex: 5 }] }),
  );
  const h = s.find((x) => x.type === "history")!;
  assert.equal(h.replacement, "git status");
  assert.equal(h.scope, "line");
  assert.equal(h.detail, "3×");
});

test("empty line yields no history suggestions (menu shows recents instead)", () => {
  const s = computeSuggestions(
    parseInput(""),
    sources({ history: [{ command: "git status", count: 1, lastIndex: 0 }] }),
  );
  assert.equal(s.length, 0);
});

test("more recent + more frequent history ranks higher", () => {
  const s = computeSuggestions(
    parseInput("g"),
    sources({ history: [
      { command: "git status", count: 1, lastIndex: 1 },
      { command: "git push", count: 9, lastIndex: 9 },
    ] }),
  );
  const hist = s.filter((x) => x.type === "history").map((x) => x.replacement);
  assert.equal(hist[0], "git push");
});

test("results are deduped by replacement and capped by max", () => {
  const s = computeSuggestions(
    parseInput("a"),
    sources({ pathCommands: ["a", "a", "ab", "ac", "ad"] }),
    2,
  );
  assert.equal(s.length, 2);
});
