import { accessSync, constants, existsSync, lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ExpectedError } from "./expectedError";
import type { GitAvailability } from "../shared/ipc";

/** An in-app notice (`app:notice`) — never a native alert. */
export interface RepoNotice {
  kind: "info" | "warn" | "error";
  message: string;
}

/** The filesystem questions the notice asks — injectable for its test. */
export interface RepoNoticeProbe {
  /** The `.git` (folder or worktree file) at or above `path`, or undefined. */
  dotGitAbove(path: string): string | undefined;
  /** False only when this account is DENIED reading `path` (and, for a
   *  folder, looking inside it) — a path that does not exist is not denied. */
  canRead(path: string): boolean;
  /** Is `path` a folder (a repository's .git), rather than a worktree's file? */
  isFolder(path: string): boolean;
  /** Does `path` belong to another user account? */
  ownedByOtherUser(path: string): boolean;
}

const DENIED = new Set(["EACCES", "EPERM"]);

const FS_PROBE: RepoNoticeProbe = {
  dotGitAbove(path) {
    // lstat, not access: it answers for a .git the user cannot read, which is
    // exactly the one this exists to find.
    let dir = resolve(path);
    for (;;) {
      const candidate = join(dir, ".git");
      try {
        lstatSync(candidate);
        return candidate;
      } catch {
        /* not here */
      }
      const up = dirname(dir);
      if (up === dir) return undefined;
      dir = up;
    }
  },
  canRead(path) {
    try {
      const folder = lstatSync(path).isDirectory();
      accessSync(path, folder ? constants.R_OK | constants.X_OK : constants.R_OK);
      return true;
    } catch (err) {
      return !DENIED.has((err as NodeJS.ErrnoException).code ?? "");
    }
  },
  isFolder(path) {
    try {
      return lstatSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  ownedByOtherUser(path) {
    const me = process.getuid?.();
    if (me === undefined) return false;
    try {
      return lstatSync(path).uid !== me;
    } catch {
      return false;
    }
  },
};

/**
 * What to tell the user when a folder they opened does not open as a
 * repository — decided from the filesystem, because git's own answer is the
 * same sentence for every case.
 *
 * `git rev-parse` says "not a git repository (or any of the parent
 * directories)" for a folder with no repository at all AND for a repository
 * whose .git this account cannot read (a .git at mode 000, or its objects or
 * refs locked away — checked against real git). The app repeated it as
 * "<path> is not inside a Git repository." in an error toast, about a
 * repository, sending the user to look in the wrong place. Neither is a
 * failure of the app, so neither is error-toned, and nothing here is
 * crash-reported: an unreadable repository is a state of the user's disk.
 */
export function cannotOpenNotice(path: string, probe: Partial<RepoNoticeProbe> = {}): RepoNotice {
  const p = { ...FS_PROBE, ...probe };
  const dotGit = p.dotGitAbove(path);
  if (!dotGit) {
    return { kind: "warn", message: `${path} is not inside a Git repository.` };
  }
  const root = dirname(dotGit);
  // The .git itself, and — for a repository's own .git folder — the three
  // things git's discovery reads inside it. A linked worktree's .git is a file.
  const inside = p.isFolder(dotGit) ? ["objects", "refs", "HEAD"].map((name) => join(dotGit, name)) : [];
  const denied = [dotGit, ...inside].some((q) => !p.canRead(q));
  if (denied) {
    return {
      kind: "warn",
      message:
        `${root} is a Git repository, but you don't have permission to read it. ` +
        "Check the permissions on its .git folder, then open it again.",
    };
  }
  if (p.ownedByOtherUser(dotGit)) {
    return {
      kind: "warn",
      message: `${root} is a Git repository that belongs to another user account, so Git won't open it.`,
    };
  }
  return {
    kind: "warn",
    message: `${root} is a Git repository, but Git can't read it — its .git folder may be damaged.`,
  };
}

/**
 * A folder did not open because GIT would not run (gitCheck.ts), not because
 * of anything about the folder — so say that, and nothing about the folder.
 */
export function gitMissingNotice(git: Extract<GitAvailability, { ok: false }>): RepoNotice {
  const why =
    git.reason === "xcode"
      ? "Git on this Mac needs Apple's Command Line Tools. Install them (run xcode-select --install in Terminal)"
      : git.reason === "broken"
        ? `Git didn't run${git.detail ? ` ("${git.detail}")` : ""}. Reinstall it`
        : "Git isn't installed. Install it";
  return { kind: "warn", message: `GitStudio can't open repositories without Git. ${why}, then open the folder again.` };
}

/**
 * Every tab is taken (issue #32). An open is refused rather than closing a tab
 * the user did not choose — a limit you can see beats state that vanishes.
 */
export function tabsFullNotice(max: number): RepoNotice {
  return {
    kind: "info",
    message: `GitStudio keeps up to ${max} repositories open. Close a tab to open another.`,
  };
}

/**
 * Tabs the last session had open whose folders are gone now — deleted, moved,
 * or on a drive that is not mounted. Said ONCE, naming them, and quietly: the
 * user's disk changed, the app did not fail.
 */
export function droppedTabsNotice(roots: readonly string[]): RepoNotice {
  const names = roots.map((r) => r.split(/[\\/]/).filter(Boolean).pop() || r);
  const list =
    names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
  return {
    kind: "info",
    message:
      names.length === 1
        ? `${list} was not reopened: ${roots[0]} is gone or no longer a Git repository.`
        : `${names.length} tabs were not reopened because their folders are gone or no longer Git repositories: ${list}.`,
  };
}

/** What a git command in a tab whose folder is gone says instead (row 14). */
export function missingFolderMessage(root: string): string {
  return `The folder ${root} is not there any more — it was moved or deleted.`;
}

/** Node's error for a child it could not start: `spawn <git> ENOENT`. */
function isSpawnEnoent(err: unknown): boolean {
  const e = err as { code?: unknown; syscall?: unknown; message?: unknown } | undefined;
  if (!e || typeof e !== "object") return false;
  if (e.code === "ENOENT" && String(e.syscall ?? "").startsWith("spawn")) return true;
  return typeof e.message === "string" && /\bspawn\b\S*.*\bENOENT\b/.test(e.message);
}

/**
 * A git command run in a repository whose folder is gone fails at SPAWN:
 * GitProcess starts git with the folder as its working directory, and Node
 * answers `spawn <git> ENOENT` — the very words it uses when git itself is not
 * installed. That is what a tab whose folder was moved or deleted showed in
 * every view that read it (row 14 of docs/desktop-repo-tabs.md). Said as what
 * it is, and as a condition rather than a crash: only when the folder really is
 * missing — with the folder there, ENOENT means git is.
 *
 * Returns the error to throw instead, or undefined to leave `err` alone.
 */
export function missingFolderError(
  err: unknown,
  root: string | undefined,
  exists: (path: string) => boolean = existsSync,
): ExpectedError | undefined {
  if (!root || !isSpawnEnoent(err) || exists(root)) return undefined;
  return new ExpectedError(missingFolderMessage(root));
}

/**
 * The same, for a handler that RETURNS its failure (`{ ok: false, message }`)
 * rather than throwing it: the result with its message said plainly and marked
 * expected, or undefined to leave it alone.
 */
export function missingFolderResult<T>(
  result: T,
  root: string | undefined,
  exists: (path: string) => boolean = existsSync,
): T | undefined {
  if (!root || !result || typeof result !== "object") return undefined;
  const r = result as { ok?: unknown; message?: unknown };
  if (r.ok !== false || typeof r.message !== "string" || !isSpawnEnoent({ message: r.message })) return undefined;
  if (exists(root)) return undefined;
  return { ...result, message: missingFolderMessage(root), expected: true };
}
