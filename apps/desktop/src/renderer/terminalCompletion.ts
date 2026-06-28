// Terminal autocomplete engine (pure logic — no DOM, no IO).
//
// Given the text the user has typed and the available sources (history, PATH
// executables, shell builtins, directory entries), produce a ranked list of
// suggestions. Ranking follows Warp's blueprint: tier by match quality
// (exact > prefix > fuzzy), then source priority, then recency/frequency for
// history. Kept side-effect-free so it is exhaustively unit-tested; the
// controller (terminalAutocomplete.ts) does the IO and rendering.

import { fuzzyMatch, matchKind } from "./fuzzyMatch";

export type SuggestionType = "history" | "command" | "builtin" | "dir" | "file";

export interface Suggestion {
  type: SuggestionType;
  /** Text shown in the dropdown row. */
  label: string;
  /** Text that replaces `scope` when accepted. */
  replacement: string;
  /** Whether accepting replaces just the current token or the whole line. */
  scope: "token" | "line";
  /** Optional right-aligned detail (e.g. run count, "dir"). */
  detail?: string;
  score: number;
  /** Indices into `label` to highlight (the matched characters). */
  indices: number[];
}

export interface HistoryItem {
  command: string;
  count: number;
  /** Position in history; higher = more recent. */
  lastIndex: number;
}

export interface DirEntry {
  name: string;
  isDir: boolean;
}

export interface ParsedInput {
  /** The whole typed line, up to the cursor. */
  line: string;
  /** The current whitespace-delimited token under the cursor. */
  token: string;
  /** True when the token is in command position (line start or after | && ; etc). */
  isCommandPos: boolean;
  /** For path tokens: the dir portion ("src/") and the basename ("comp"). */
  dirPart: string;
  basePart: string;
}

const CMD_SEPARATORS = /[|;&(]\s*$|\b(?:&&|\|\|)\s*$/;

/** Parse the typed line (up to the cursor) into the token being completed. */
export function parseInput(line: string): ParsedInput {
  // Current token = text after the last unescaped whitespace.
  const m = /[^\s]*$/.exec(line);
  const token = m ? m[0] : "";
  const before = line.slice(0, line.length - token.length);
  const isCommandPos = before.trim() === "" || CMD_SEPARATORS.test(before);
  const slash = token.lastIndexOf("/");
  const dirPart = slash >= 0 ? token.slice(0, slash + 1) : "";
  const basePart = slash >= 0 ? token.slice(slash + 1) : token;
  return { line, token, isCommandPos, dirPart, basePart };
}

/** True when the token clearly refers to a filesystem path. */
export function looksLikePath(token: string): boolean {
  return token.includes("/") || token.startsWith(".") || token.startsWith("~");
}

export interface CompletionSources {
  history: HistoryItem[];
  pathCommands: string[];
  builtins: string[];
  /** Entries of the directory implied by the token's dirPart (already listed). */
  dirEntries: DirEntry[];
}

const TIER = { exact: 1000, prefix: 500, fuzzy: 0 } as const;
const SOURCE_PRIORITY: Record<SuggestionType, number> = {
  history: 120,
  command: 80,
  builtin: 70,
  dir: 45,
  file: 30,
};

/** Score one candidate against a query; null if it does not match. */
function scoreCandidate(query: string, candidate: string): { score: number; indices: number[] } | null {
  const kind = matchKind(query, candidate);
  if (kind === "none") return null;
  if (kind === "exact") return { score: TIER.exact, indices: range(query.length) };
  if (kind === "prefix") return { score: TIER.prefix, indices: range(query.length) };
  const fm = fuzzyMatch(query, candidate);
  return fm ? { score: TIER.fuzzy + fm.score, indices: fm.indices } : null;
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

/**
 * Compute ranked suggestions for the current input. `max` caps the result count.
 */
export function computeSuggestions(
  parsed: ParsedInput,
  sources: CompletionSources,
  max = 50,
): Suggestion[] {
  const out: Suggestion[] = [];
  const { token, line, isCommandPos, dirPart, basePart } = parsed;

  // History matches the whole line (you recall a past command), unless the line
  // is empty (then the dropdown stays closed — the command menu shows recents).
  if (line.trim() !== "") {
    for (const h of sources.history) {
      if (h.command === line) continue; // don't suggest exactly what's typed
      const sc = scoreCandidate(line, h.command);
      if (!sc) continue;
      const recency = Math.min(60, h.lastIndex * 0.5) + Math.min(40, (h.count - 1) * 6);
      out.push({
        type: "history",
        label: h.command,
        replacement: h.command,
        scope: "line",
        detail: h.count > 1 ? `${h.count}×` : undefined,
        score: sc.score + SOURCE_PRIORITY.history + recency,
        indices: sc.indices,
      });
    }
  }

  // Commands (PATH + builtins) when at command position.
  if (isCommandPos && !looksLikePath(token)) {
    for (const cmd of sources.builtins) pushCmd(out, "builtin", token, cmd);
    for (const cmd of sources.pathCommands) pushCmd(out, "command", token, cmd);
  }

  // Files/dirs: when the token looks like a path, or as plain arguments.
  if (!isCommandPos || looksLikePath(token)) {
    for (const e of sources.dirEntries) {
      const sc = scoreCandidate(basePart, e.name);
      if (!sc) continue;
      const replacement = dirPart + e.name + (e.isDir ? "/" : "");
      out.push({
        type: e.isDir ? "dir" : "file",
        label: e.name + (e.isDir ? "/" : ""),
        replacement,
        scope: "token",
        detail: e.isDir ? undefined : undefined,
        score: sc.score + (e.isDir ? SOURCE_PRIORITY.dir : SOURCE_PRIORITY.file),
        indices: sc.indices,
      });
    }
  }

  // Dedup by replacement (keep the highest-scoring), then sort.
  const best = new Map<string, Suggestion>();
  for (const s of out) {
    const key = s.scope + "\0" + s.replacement;
    const prev = best.get(key);
    if (!prev || s.score > prev.score) best.set(key, s);
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score || a.label.length - b.label.length || a.label.localeCompare(b.label))
    .slice(0, max);
}

function pushCmd(out: Suggestion[], type: "command" | "builtin", token: string, cmd: string): void {
  const sc = scoreCandidate(token, cmd);
  if (!sc) return;
  out.push({
    type,
    label: cmd,
    replacement: cmd,
    scope: "token",
    score: sc.score + SOURCE_PRIORITY[type],
    indices: sc.indices,
  });
}

/** A small, conventional set of POSIX shell builtins for command completion. */
export const SHELL_BUILTINS = [
  "cd", "ls", "echo", "export", "alias", "unalias", "pwd", "pushd", "popd",
  "source", "exit", "kill", "jobs", "fg", "bg", "history", "which", "type",
  "set", "unset", "read", "test", "true", "false", "clear", "exec", "trap",
];
