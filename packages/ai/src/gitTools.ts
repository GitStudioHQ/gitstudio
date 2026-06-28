// The shared Git tool catalog — the SINGLE source of truth for the capabilities
// GitStudio exposes to an AI, used by BOTH the in-app agent and the standalone
// MCP server. Each tool carries its name, a model-facing description, a JSON
// Schema for its arguments, safety annotations, and a `run` that drives an
// injected `GitToolHost`. The host (git-service over a real repo, or a desktop
// IPC bridge) supplies the primitives; this module owns the contract, the
// schemas, and the human-readable formatting — so the wording, the safety
// classification, and the argument shapes are written exactly once.
//
// Pure: no node/vscode/electron imports. `run` only calls the injected host.

import type { JsonSchema } from "./types";

/** Safety class. Consumers gate exposure on this (read always; write/destructive opt-in). */
export type ToolMode = "read" | "write" | "destructive";

export interface ToolStatusFile {
  path: string;
  /** Porcelain status letter(s): M, A, D, R, ?, U(nmerged)… */
  status: string;
  staged: boolean;
}
export interface ToolCommit {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  /** Authored time, epoch seconds. */
  date: number;
}
export interface ToolCommitDetail extends ToolCommit {
  body: string;
  committer: string;
  parents: string[];
  files: ToolStatusFile[];
}
export interface ToolBranch {
  name: string;
  current: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  subject: string;
}
export interface ToolStash {
  ref: string;
  message: string;
  time: number;
}
export interface ToolCompare {
  ahead: number;
  behind: number;
  commits: ToolCommit[];
  files: ToolStatusFile[];
}
export interface ToolFile {
  path: string;
  text: string;
  truncated: boolean;
  binary: boolean;
}
export interface ToolWriteResult {
  ok: boolean;
  message?: string;
}

/**
 * The primitive git operations a tool host must provide. Implemented once over a
 * git-service GitContext (see @gitstudio/git-service/GitToolHost) and reused by
 * the MCP server and the desktop agent alike.
 */
export interface GitToolHost {
  /** Absolute repo root (for display + scoping). */
  repoRoot(): string;
  status(): Promise<ToolStatusFile[]>;
  log(opts: { limit?: number; ref?: string; path?: string }): Promise<ToolCommit[]>;
  show(sha: string): Promise<ToolCommitDetail | undefined>;
  diff(opts: { staged?: boolean; path?: string; base?: string; head?: string }): Promise<string>;
  branches(): Promise<ToolBranch[]>;
  head(): Promise<{ branch?: string; detached: boolean; sha: string }>;
  stashes(): Promise<ToolStash[]>;
  searchCommits(query: string, limit?: number): Promise<ToolCommit[]>;
  readFile(path: string, ref?: string): Promise<ToolFile | undefined>;
  compare(base: string, head: string): Promise<ToolCompare | undefined>;
  // ── writes ──
  stage(paths: string[] | "all"): Promise<ToolWriteResult>;
  unstage(paths: string[] | "all"): Promise<ToolWriteResult>;
  commit(message: string, amend?: boolean): Promise<ToolWriteResult>;
  createBranch(name: string, checkout?: boolean): Promise<ToolWriteResult>;
  checkout(ref: string): Promise<ToolWriteResult>;
  stashSave(message?: string, includeUntracked?: boolean): Promise<ToolWriteResult>;
  // ── destructive ──
  discard(paths: string[]): Promise<ToolWriteResult>;
  deleteBranch(name: string, force?: boolean): Promise<ToolWriteResult>;
  reset(mode: "soft" | "mixed" | "hard", ref: string): Promise<ToolWriteResult>;
}

export interface ToolRunResult {
  /** Human/model-readable text (always present). */
  text: string;
  /** Optional machine-readable payload (MCP structuredContent; agent data). */
  data?: unknown;
  isError?: boolean;
}

export interface GitTool {
  name: string;
  title: string;
  description: string;
  parameters: JsonSchema;
  mode: ToolMode;
  /** True when calling twice with the same args has the same effect as once. */
  idempotent?: boolean;
  run(host: GitToolHost, args: Record<string, unknown>): Promise<ToolRunResult>;
}

// ── small arg + formatting helpers ───────────────────────────────────────────

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function strArr(v: unknown): string[] | undefined {
  if (Array.isArray(v)) {
    const out = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
    return out.length ? out : undefined;
  }
  const single = str(v);
  return single ? [single] : undefined;
}
function ok(r: ToolWriteResult, success: string): ToolRunResult {
  return r.ok
    ? { text: success + (r.message ? `\n${r.message}` : ""), data: r }
    : { text: r.message ?? "The operation failed.", data: r, isError: true };
}
function fmtDate(epochSec: number): string {
  // Deterministic, locale-free (keeps this module pure + testable).
  if (!epochSec) return "";
  const d = new Date(epochSec * 1000);
  return d.toISOString().replace("T", " ").slice(0, 16) + "Z";
}
function fmtCommit(c: ToolCommit): string {
  return `${c.shortSha}  ${c.subject}  — ${c.author}, ${fmtDate(c.date)}`;
}
function fmtStatusFile(f: ToolStatusFile): string {
  return `${f.staged ? "staged  " : "unstaged"} ${f.status.padEnd(2)} ${f.path}`;
}

const PARAMS_NONE: JsonSchema = { type: "object", properties: {} };

// ── the catalog ──────────────────────────────────────────────────────────────

export const GIT_TOOLS: readonly GitTool[] = [
  {
    name: "git_status",
    title: "Working tree status",
    description:
      "List the working-tree changes in the open repository: staged, unstaged, and untracked files with their status letters. Start here to understand what is uncommitted.",
    parameters: PARAMS_NONE,
    mode: "read",
    idempotent: true,
    async run(host) {
      const files = await host.status();
      if (files.length === 0) {
        return { text: `Working tree clean (${host.repoRoot()}).`, data: { files: [] } };
      }
      const staged = files.filter((f) => f.staged).length;
      const head = `${files.length} changed file(s), ${staged} staged — ${host.repoRoot()}`;
      return { text: head + "\n" + files.map(fmtStatusFile).join("\n"), data: { files } };
    },
  },
  {
    name: "git_log",
    title: "Commit history",
    description:
      "Show recent commits (newest first). Optionally restrict to a ref/branch or a file path. Use this to understand recent project history and commit-message conventions.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "Max commits to return (default 20, max 200).", default: 20 },
        ref: { type: "string", description: "Branch/ref to log (default the current HEAD)." },
        path: { type: "string", description: "Restrict to commits touching this path." },
      },
    },
    mode: "read",
    idempotent: true,
    async run(host, args) {
      const limit = Math.min(num(args.limit) ?? 20, 200);
      const commits = await host.log({ limit, ref: str(args.ref), path: str(args.path) });
      if (commits.length === 0) {
        return { text: "No commits found.", data: { commits: [] } };
      }
      return { text: commits.map(fmtCommit).join("\n"), data: { commits } };
    },
  },
  {
    name: "git_show",
    title: "Commit details",
    description:
      "Show one commit's metadata, full message, and the list of files it changed. Pass a SHA, short SHA, or a ref like HEAD or a branch name.",
    parameters: {
      type: "object",
      properties: { sha: { type: "string", description: "Commit SHA or ref." } },
      required: ["sha"],
    },
    mode: "read",
    idempotent: true,
    async run(host, args) {
      const sha = str(args.sha);
      if (!sha) return { text: "A commit SHA or ref is required.", isError: true };
      const c = await host.show(sha);
      if (!c) return { text: `Commit not found: ${sha}`, isError: true };
      const body = c.body.trim() ? `\n\n${c.body.trim()}` : "";
      const files = c.files.length ? "\n\nFiles:\n" + c.files.map((f) => `  ${f.status.padEnd(2)} ${f.path}`).join("\n") : "";
      return {
        text: `${c.shortSha}  ${c.subject}\nAuthor: ${c.author}   ${fmtDate(c.date)}\nParents: ${c.parents.join(", ") || "(root)"}${body}${files}`,
        data: c,
      };
    },
  },
  {
    name: "git_diff",
    title: "Show a diff",
    description:
      "Return a unified diff. With no arguments: the unstaged working-tree diff. `staged: true`: the staged (index) diff. `path`: limit to one file. `base`+`head`: diff between two refs. Use before writing a commit message or a review.",
    parameters: {
      type: "object",
      properties: {
        staged: { type: "boolean", description: "Diff the staged index instead of the working tree." },
        path: { type: "string", description: "Limit the diff to this path." },
        base: { type: "string", description: "Base ref for a ref-to-ref diff." },
        head: { type: "string", description: "Head ref for a ref-to-ref diff." },
      },
    },
    mode: "read",
    idempotent: true,
    async run(host, args) {
      const diff = await host.diff({
        staged: args.staged === true,
        path: str(args.path),
        base: str(args.base),
        head: str(args.head),
      });
      return { text: diff.trim() ? diff : "(no differences)", data: { diff } };
    },
  },
  {
    name: "git_branches",
    title: "List branches",
    description:
      "List local branches with their upstream, ahead/behind counts, and tip subject. The current branch is flagged.",
    parameters: PARAMS_NONE,
    mode: "read",
    idempotent: true,
    async run(host) {
      const branches = await host.branches();
      const text = branches
        .map((b) => `${b.current ? "* " : "  "}${b.name}${b.upstream ? ` → ${b.upstream}` : ""}  ↑${b.ahead} ↓${b.behind}  ${b.subject}`)
        .join("\n");
      return { text: text || "No branches.", data: { branches } };
    },
  },
  {
    name: "git_current_branch",
    title: "Current branch / HEAD",
    description: "Report the current branch (or detached HEAD) and the HEAD SHA.",
    parameters: PARAMS_NONE,
    mode: "read",
    idempotent: true,
    async run(host) {
      const h = await host.head();
      const where = h.detached ? `detached at ${h.sha.slice(0, 8)}` : `on branch ${h.branch}`;
      return { text: `HEAD ${where} (${h.sha.slice(0, 8)}).`, data: h };
    },
  },
  {
    name: "git_stashes",
    title: "List stashes",
    description: "List the stash stack with messages and times.",
    parameters: PARAMS_NONE,
    mode: "read",
    idempotent: true,
    async run(host) {
      const stashes = await host.stashes();
      const text = stashes.map((s) => `${s.ref}: ${s.message} (${fmtDate(s.time)})`).join("\n");
      return { text: text || "No stashes.", data: { stashes } };
    },
  },
  {
    name: "git_search_commits",
    title: "Search commit messages",
    description:
      "Find commits whose message matches a query (git log --grep). Useful for locating when/why something changed.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to search for in commit messages." },
        limit: { type: "integer", description: "Max results (default 20).", default: 20 },
      },
      required: ["query"],
    },
    mode: "read",
    idempotent: true,
    async run(host, args) {
      const query = str(args.query);
      if (!query) return { text: "A search query is required.", isError: true };
      const commits = await host.searchCommits(query, Math.min(num(args.limit) ?? 20, 100));
      return { text: commits.length ? commits.map(fmtCommit).join("\n") : "No matching commits.", data: { commits } };
    },
  },
  {
    name: "read_file",
    title: "Read a file",
    description:
      "Read a text file from the repository at HEAD (or at a given ref). Returns the file content; large/binary files are reported, not dumped.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo-root-relative path, e.g. src/main.ts." },
        ref: { type: "string", description: "Ref to read at (default HEAD)." },
      },
      required: ["path"],
    },
    mode: "read",
    idempotent: true,
    async run(host, args) {
      const path = str(args.path);
      if (!path) return { text: "A file path is required.", isError: true };
      const f = await host.readFile(path, str(args.ref));
      if (!f) return { text: `File not found: ${path}`, isError: true };
      if (f.binary) return { text: `${path} is binary (not shown).`, data: f, isError: false };
      if (f.truncated) return { text: `${path} (truncated — file exceeds the size cap):\n\n${f.text}`, data: f };
      return { text: f.text, data: f };
    },
  },
  {
    name: "git_compare",
    title: "Compare two refs",
    description:
      "Compare two refs (base…head): the commits in head that aren't in base, the files that differ, and ahead/behind counts. Use to understand what a branch adds vs main.",
    parameters: {
      type: "object",
      properties: {
        base: { type: "string", description: "Base ref (e.g. main)." },
        head: { type: "string", description: "Head ref (e.g. the feature branch). Default: current HEAD." },
      },
      required: ["base"],
    },
    mode: "read",
    idempotent: true,
    async run(host, args) {
      const base = str(args.base);
      if (!base) return { text: "A base ref is required.", isError: true };
      const head = str(args.head) ?? "HEAD";
      const cmp = await host.compare(base, head);
      if (!cmp) return { text: `Couldn't compare ${base}…${head}.`, isError: true };
      const commits = cmp.commits.length ? "\nCommits:\n" + cmp.commits.map((c) => "  " + fmtCommit(c)).join("\n") : "";
      const files = cmp.files.length ? "\nFiles:\n" + cmp.files.map((f) => `  ${f.status.padEnd(2)} ${f.path}`).join("\n") : "";
      return { text: `${base}…${head}: ↑${cmp.ahead} ↓${cmp.behind}${commits}${files}`, data: cmp };
    },
  },
  // ── writes ──
  {
    name: "git_stage",
    title: "Stage changes",
    description:
      "Stage files into the index. Pass `paths` (an array of repo-relative paths) or `all: true` to stage everything. Stage selectively to build focused, logical commits.",
    parameters: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, description: "Paths to stage." },
        all: { type: "boolean", description: "Stage all changes." },
      },
    },
    mode: "write",
    async run(host, args) {
      const target = args.all === true ? ("all" as const) : strArr(args.paths);
      if (!target) return { text: "Provide `paths` or `all: true`.", isError: true };
      return ok(await host.stage(target), target === "all" ? "Staged all changes." : `Staged ${target.length} path(s).`);
    },
  },
  {
    name: "git_unstage",
    title: "Unstage changes",
    description: "Remove files from the index (keep the working-tree changes). Pass `paths` or `all: true`.",
    parameters: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, description: "Paths to unstage." },
        all: { type: "boolean", description: "Unstage everything." },
      },
    },
    mode: "write",
    async run(host, args) {
      const target = args.all === true ? ("all" as const) : strArr(args.paths);
      if (!target) return { text: "Provide `paths` or `all: true`.", isError: true };
      return ok(await host.unstage(target), "Unstaged.");
    },
  },
  {
    name: "git_commit",
    title: "Commit staged changes",
    description:
      "Create a commit from the currently staged changes with the given message. Stage first with git_stage. Set `amend: true` to amend the last commit. Does not push.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "The full commit message (subject, optionally blank line + body)." },
        amend: { type: "boolean", description: "Amend the previous commit instead of creating a new one." },
      },
      required: ["message"],
    },
    mode: "write",
    async run(host, args) {
      const message = str(args.message);
      if (!message) return { text: "A commit message is required.", isError: true };
      return ok(await host.commit(message, args.amend === true), "Committed.");
    },
  },
  {
    name: "git_create_branch",
    title: "Create a branch",
    description: "Create a new branch. Set `checkout: true` to switch to it after creating.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "New branch name." },
        checkout: { type: "boolean", description: "Switch to the new branch." },
      },
      required: ["name"],
    },
    mode: "write",
    async run(host, args) {
      const name = str(args.name);
      if (!name) return { text: "A branch name is required.", isError: true };
      return ok(await host.createBranch(name, args.checkout === true), `Created branch ${name}.`);
    },
  },
  {
    name: "git_checkout",
    title: "Switch branch",
    description:
      "Switch the working tree to a branch or ref. Fails (rather than discarding) when there are conflicting local changes.",
    parameters: {
      type: "object",
      properties: { ref: { type: "string", description: "Branch or ref to check out." } },
      required: ["ref"],
    },
    mode: "write",
    async run(host, args) {
      const ref = str(args.ref);
      if (!ref) return { text: "A ref is required.", isError: true };
      return ok(await host.checkout(ref), `Checked out ${ref}.`);
    },
  },
  {
    name: "git_stash_save",
    title: "Stash changes",
    description: "Save the working-tree changes to a new stash (optionally including untracked files).",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "Optional stash message." },
        includeUntracked: { type: "boolean", description: "Also stash untracked files." },
      },
    },
    mode: "write",
    async run(host, args) {
      return ok(await host.stashSave(str(args.message), args.includeUntracked === true), "Stashed changes.");
    },
  },
  // ── destructive ──
  {
    name: "git_discard",
    title: "Discard changes (destructive)",
    description:
      "Permanently discard uncommitted changes to the given paths — the working-tree edits are lost and cannot be recovered. Use only with explicit user intent.",
    parameters: {
      type: "object",
      properties: { paths: { type: "array", items: { type: "string" }, description: "Paths to discard." } },
      required: ["paths"],
    },
    mode: "destructive",
    async run(host, args) {
      const paths = strArr(args.paths);
      if (!paths) return { text: "At least one path is required.", isError: true };
      return ok(await host.discard(paths), `Discarded changes to ${paths.length} path(s).`);
    },
  },
  {
    name: "git_delete_branch",
    title: "Delete a branch (destructive)",
    description: "Delete a local branch. Set `force: true` to delete an unmerged branch (loses its unique commits).",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Branch to delete." },
        force: { type: "boolean", description: "Force-delete even if unmerged." },
      },
      required: ["name"],
    },
    mode: "destructive",
    async run(host, args) {
      const name = str(args.name);
      if (!name) return { text: "A branch name is required.", isError: true };
      return ok(await host.deleteBranch(name, args.force === true), `Deleted branch ${name}.`);
    },
  },
  {
    name: "git_reset",
    title: "Reset HEAD (destructive)",
    description:
      "Move HEAD to a ref. mode=soft keeps changes staged; mixed unstages them; HARD discards all working-tree and index changes (irreversible). Use hard only with explicit user intent.",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["soft", "mixed", "hard"], description: "Reset mode." },
        ref: { type: "string", description: "Target ref (e.g. HEAD~1)." },
      },
      required: ["mode", "ref"],
    },
    mode: "destructive",
    async run(host, args) {
      const mode = str(args.mode);
      const ref = str(args.ref);
      if (mode !== "soft" && mode !== "mixed" && mode !== "hard") {
        return { text: "mode must be soft, mixed, or hard.", isError: true };
      }
      if (!ref) return { text: "A target ref is required.", isError: true };
      return ok(await host.reset(mode, ref), `Reset (${mode}) to ${ref}.`);
    },
  },
];

/** Tools filtered by which write level the consumer permits. */
export function selectTools(opts: { write?: boolean; destructive?: boolean }): GitTool[] {
  return GIT_TOOLS.filter((t) => {
    if (t.mode === "read") return true;
    if (t.mode === "write") return opts.write === true;
    return opts.destructive === true; // destructive implies write-allowed by the caller
  });
}

export function toolByName(name: string): GitTool | undefined {
  return GIT_TOOLS.find((t) => t.name === name);
}
