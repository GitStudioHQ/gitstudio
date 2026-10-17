import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { GitProcess } from "./GitProcess";

/**
 * Changelists (issue #122): named groups a working-tree file can be parked
 * in, IntelliJ-style, so the "everything" actions (Stage All, Commit all,
 * Discard All) leave it alone — a local config file that is always modified
 * and never meant to be committed.
 *
 * They are GitStudio's own bookkeeping: git never sees them, and nothing
 * about the index or a commit changes unless the user stages a parked file by
 * hand. The default changelist is implicit — every file not assigned to a
 * named one — so a repository with no changelists behaves exactly as before.
 *
 * Kept in `<git-dir>/gitstudio-changelists.json` (`rev-parse
 * --absolute-git-dir`): never in the tracked tree; per repository and per
 * worktree (a linked worktree has its own git-dir and its own working tree);
 * the same for every editor and app on the machine that opens the folder.
 */

/** One named changelist. `id` is stable across renames ([A-Za-z0-9_-]). */
export interface Changelist {
  id: string;
  name: string;
}

/** Every named changelist, and which one each parked path is in. */
export interface ChangelistState {
  lists: Changelist[];
  /** Repo-relative path (forward slashes) → changelist id. */
  files: Record<string, string>;
}

/** The file's name inside the git-dir. */
export const CHANGELISTS_FILE = "gitstudio-changelists.json";

const ID = /^[A-Za-z0-9_-]{1,40}$/;

export function emptyChangelists(): ChangelistState {
  return { lists: [], files: {} };
}

/**
 * Read the file's text. Never throws: anything unreadable, foreign or from a
 * newer version reads as no changelists, and a path pointing at a list that
 * is not there is dropped — so a hand-edited or half-written file can never
 * break the Changes view.
 */
export function parseChangelists(text: string | undefined): ChangelistState {
  if (!text) return emptyChangelists();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyChangelists();
  }
  if (!raw || typeof raw !== "object") return emptyChangelists();
  const r = raw as { version?: unknown; lists?: unknown; files?: unknown };
  if (r.version !== 1 || !Array.isArray(r.lists)) return emptyChangelists();
  const lists: Changelist[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const l of r.lists) {
    if (!l || typeof l !== "object") continue;
    const { id, name } = l as { id?: unknown; name?: unknown };
    if (typeof id !== "string" || !ID.test(id) || ids.has(id)) continue;
    if (typeof name !== "string") continue;
    const clean = cleanName(name);
    if (!clean || names.has(clean.toLowerCase())) continue;
    ids.add(id);
    names.add(clean.toLowerCase());
    lists.push({ id, name: clean });
  }
  const files: Record<string, string> = {};
  if (r.files && typeof r.files === "object") {
    for (const [path, id] of Object.entries(r.files as Record<string, unknown>)) {
      if (typeof id === "string" && ids.has(id) && path) files[path] = id;
    }
  }
  return { lists, files };
}

export function serializeChangelists(state: ChangelistState): string {
  // Paths sorted, so the file diffs sensibly if anyone ever looks at it.
  const files: Record<string, string> = {};
  for (const path of Object.keys(state.files).sort()) files[path] = state.files[path];
  return JSON.stringify({ version: 1, lists: state.lists, files }, null, 2) + "\n";
}

/** A name as it is kept: trimmed, inner whitespace runs as one space. */
export function cleanName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

/**
 * What is wrong with `name` for a changelist, or undefined when it can be
 * used. `exceptId` is the list being renamed (its own name is not "taken").
 * "Changes" is the default changelist's name, so it is taken too.
 */
export function changelistNameProblem(
  state: ChangelistState,
  name: string,
  exceptId?: string,
): "empty" | "taken" | "tooLong" | undefined {
  const clean = cleanName(name);
  if (!clean) return "empty";
  if (clean.length > 80) return "tooLong";
  const lower = clean.toLowerCase();
  if (RESERVED.has(lower)) return "taken";
  if (state.lists.some((l) => l.id !== exceptId && l.name.toLowerCase() === lower)) return "taken";
  return undefined;
}

/**
 * The names the Changes view's own groups already have — the default
 * changelist is "Changes" (Unstaged in the split model) — so a changelist
 * can never be mistaken for one of them.
 */
const RESERVED = new Set(["changes", "staged", "unstaged", "merge conflicts", "stashes"]);

function newId(state: ChangelistState): string {
  for (;;) {
    const id = "l" + Date.now().toString(36) + Math.floor(Math.random() * 36 ** 4).toString(36);
    if (!state.lists.some((l) => l.id === id)) return id;
  }
}

/** A new, empty changelist. The name must already have passed changelistNameProblem. */
export function addChangelist(state: ChangelistState, name: string): { state: ChangelistState; id: string } {
  const id = newId(state);
  return { state: { lists: [...state.lists, { id, name: cleanName(name) }], files: { ...state.files } }, id };
}

export function renameChangelist(state: ChangelistState, id: string, name: string): ChangelistState {
  return {
    lists: state.lists.map((l) => (l.id === id ? { id, name: cleanName(name) } : l)),
    files: { ...state.files },
  };
}

/** Delete a changelist. Its files go back to the default one; no file is touched. */
export function deleteChangelist(
  state: ChangelistState,
  id: string,
): { state: ChangelistState; freed: string[] } {
  const files: Record<string, string> = {};
  const freed: string[] = [];
  for (const [path, list] of Object.entries(state.files)) {
    if (list === id) freed.push(path);
    else files[path] = list;
  }
  return { state: { lists: state.lists.filter((l) => l.id !== id), files }, freed };
}

/**
 * Put `paths` in changelist `id`, or back in the default one (`undefined`).
 * An id that is not a list is the default one: a move can never invent a list.
 */
export function moveToChangelist(
  state: ChangelistState,
  paths: readonly string[],
  id: string | undefined,
): ChangelistState {
  const target = id && state.lists.some((l) => l.id === id) ? id : undefined;
  const files = { ...state.files };
  for (const path of paths) {
    if (!path) continue;
    if (target) files[path] = target;
    else delete files[path];
  }
  return { lists: state.lists, files };
}

/** Forget `paths` (they are clean now): they no longer belong to any changelist. */
export function forgetPaths(state: ChangelistState, paths: Iterable<string>): ChangelistState {
  return moveToChangelist(state, [...paths], undefined);
}

/** The changelist each of `paths` is parked in, for the ones that are. */
export function parkedAmong(state: ChangelistState, paths: Iterable<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const path of paths) {
    const id = state.files[path];
    if (id) out[path] = id;
  }
  return out;
}

/** Is `path` in a named changelist (not the default one)? */
export function isParked(state: ChangelistState, path: string): boolean {
  return !!state.files[path];
}

/**
 * The changelists of one repository (one working tree), on disk.
 *
 * Every update is a read-modify-write of the whole file, run one at a time,
 * so two quick moves never lose one another. A read never throws.
 */
export class ChangelistStore {
  private gitDir: Promise<string | undefined> | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly process: GitProcess) {}

  /** Where the file is, or undefined when git cannot say (not a repository). */
  async path(): Promise<string | undefined> {
    if (!this.gitDir) {
      this.gitDir = this.process
        .run(["rev-parse", "--absolute-git-dir"])
        .then((r) => (r.code === 0 && r.stdout.trim() ? r.stdout.trim() : undefined))
        .catch(() => undefined);
      // A failed answer is not kept: the next read asks again.
      void this.gitDir.then((dir) => {
        if (!dir) this.gitDir = undefined;
      });
    }
    const dir = await this.gitDir;
    return dir ? join(dir, CHANGELISTS_FILE) : undefined;
  }

  async read(): Promise<ChangelistState> {
    const file = await this.path();
    if (!file) return emptyChangelists();
    try {
      return parseChangelists(await readFile(file, "utf8"));
    } catch {
      return emptyChangelists();
    }
  }

  /**
   * Change the changelists: `change` gets what is on disk now and returns
   * what to keep. Resolves with what was kept. Rejects when the file cannot be
   * written (the caller says so).
   */
  update(change: (state: ChangelistState) => ChangelistState): Promise<ChangelistState> {
    const run = this.queue.then(async () => {
      const file = await this.path();
      if (!file) throw new Error("not a git repository");
      const before = await this.read();
      const after = change(before);
      const text = serializeChangelists(after);
      if (text !== serializeChangelists(before)) {
        await mkdir(dirname(file), { recursive: true });
        // Written whole, then renamed over: a reader never sees half a file.
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, text, "utf8");
        try {
          await rename(tmp, file);
        } catch {
          // Windows refuses to rename over a file another process has open;
          // then it is written in place.
          await writeFile(file, text, "utf8");
          await rm(tmp, { force: true });
        }
      }
      return after;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
