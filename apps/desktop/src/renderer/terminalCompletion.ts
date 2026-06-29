// Terminal autocomplete engine (pure logic — no DOM, no IO).
//
// Given the text the user has typed and the available sources (history, PATH
// executables, shell builtins, directory entries), produce a ranked list of
// suggestions. Ranking follows Warp's blueprint: tier by match quality
// (exact > prefix > fuzzy), then source priority, then recency/frequency for
// history. Kept side-effect-free so it is exhaustively unit-tested; the
// controller (terminalAutocomplete.ts) does the IO and rendering.

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
  /** The command being invoked (first token of the line) — drives arg context. */
  command: string;
  /** True when the token is a flag (starts with "-"). */
  isFlag: boolean;
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
  const command = line.trimStart().split(/\s+/)[0] ?? "";
  const isFlag = token.startsWith("-");
  return { line, token, isCommandPos, command, isFlag, dirPart, basePart };
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

/** Commands whose argument is a directory — complete dirs only. */
const DIR_ONLY_COMMANDS = new Set(["cd", "pushd", "rmdir"]);

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

function startsWithCI(candidate: string, prefix: string): boolean {
  return candidate.toLowerCase().startsWith(prefix.toLowerCase());
}

/**
 * Compute high-signal suggestions for the current input.
 *
 * Deliberately PREFIX-based, not fuzzy — typing "cd" must not surface
 * "config_data" or "cpuwalk.d", and "--" must not surface a file with dashes.
 * Context-aware: PATH commands + builtins in command position; directories only
 * for cd/pushd/rmdir; files & dirs for other arguments; and for flag tokens
 * ("-"/"--") nothing but matching history (we have no flag specs). History always
 * contributes whole-line prefix matches — which is how subcommands like
 * "git status" get completed from what you've run before. `max` caps the list.
 */
export function computeSuggestions(
  parsed: ParsedInput,
  sources: CompletionSources,
  max = 10,
): Suggestion[] {
  const { line, token, isCommandPos, isFlag, command, dirPart, basePart } = parsed;
  if (line.trim() === "") return [];
  const out: Suggestion[] = [];

  // Whole-line history prefix matches — useful in every context.
  for (const h of sources.history) {
    if (h.command === line || !startsWithCI(h.command, line)) continue;
    const recency = Math.min(80, h.lastIndex * 0.6) + Math.min(40, (h.count - 1) * 6);
    out.push({
      type: "history",
      label: h.command,
      replacement: h.command,
      scope: "line",
      detail: h.count > 1 ? `${h.count}×` : undefined,
      score: 1000 + recency,
      indices: range(line.length),
    });
  }

  if (isCommandPos && !looksLikePath(token)) {
    const seen = new Set<string>();
    const addCmd = (name: string, type: "command" | "builtin", base: number): void => {
      if (name === token || seen.has(name) || !startsWithCI(name, token)) return;
      seen.add(name);
      out.push({ type, label: name, replacement: name, scope: "token", score: base, indices: range(token.length) });
    };
    for (const b of sources.builtins) addCmd(b, "builtin", 190);
    for (const c of sources.pathCommands) addCmd(c, "command", 200);
  } else if (!isFlag) {
    // Argument position: complete paths (directories only for cd/pushd/rmdir).
    const dirsOnly = DIR_ONLY_COMMANDS.has(command);
    for (const e of sources.dirEntries) {
      if ((dirsOnly && !e.isDir) || !startsWithCI(e.name, basePart)) continue;
      out.push({
        type: e.isDir ? "dir" : "file",
        label: e.name + (e.isDir ? "/" : ""),
        replacement: dirPart + e.name + (e.isDir ? "/" : ""),
        scope: "token",
        score: e.isDir ? 300 : 250,
        indices: range(basePart.length),
      });
    }
  }
  // (A flag token with no spec falls through to history-only, already added.)

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

/** A small, conventional set of POSIX shell builtins for command completion. */
export const SHELL_BUILTINS = [
  "cd", "ls", "echo", "export", "alias", "unalias", "pwd", "pushd", "popd",
  "source", "exit", "kill", "jobs", "fg", "bg", "history", "which", "type",
  "set", "unset", "read", "test", "true", "false", "clear", "exec", "trap",
];
