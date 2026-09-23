import { accessSync, constants, lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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
