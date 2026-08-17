// Watches the open repository for changes made outside GitStudio, so the
// Changes list reflects reality without being asked (issue #17).
//
// Before this, nothing in the app looked at the filesystem at all: edit a file
// in your editor, switch to GitStudio, and you saw whatever was read last. The
// only ways out were the Refresh button or leaving the view and coming back.
//
// Two things make a naive `fs.watch` unusable on a real repository, and both are
// handled here:
//
//   1. VOLUME. A build writes thousands of paths into node_modules/ and dist/,
//      and git itself churns .git/objects and .git/*.lock constantly — several
//      of those per second during a fetch. Every one would be a refresh, and a
//      refresh spawns git. So events are filtered to paths that can actually
//      change what the Changes list shows, then debounced.
//
//   2. RECURSIVE WATCH LIMITS. `recursive: true` maps to FSEvents on macOS and
//      ReadDirectoryChangesW on Windows (both cheap, whole-tree), but on Linux
//      it is inotify with one watch per directory — a big tree can exhaust
//      `max_user_watches` and throw ENOSPC. That must degrade to "no watcher",
//      never to a crash: the window-focus refresh in the renderer still covers
//      the common case of coming back to the app.

import { watch, type FSWatcher } from "node:fs";
import { sep } from "node:path";

/**
 * How long to wait after the last filesystem event before refreshing. Saving a
 * file in most editors produces several events (write, rename, attribute), and a
 * formatter-on-save produces another round; one refresh should cover all of it.
 * Long enough to coalesce a burst, short enough to feel immediate.
 */
const DEBOUNCE_MS = 250;

/**
 * Directories whose contents can never change what the Changes list shows, but
 * which produce the most events by far. `.git` is handled separately below,
 * because SOME of it matters.
 */
const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  "out",
  "build",
  "target",
  ".next",
  ".turbo",
  ".cache",
  ".venv",
  "__pycache__",
  ".gradle",
  ".idea",
  ".vscode-test",
]);

/**
 * The only paths under `.git` worth reacting to. HEAD and refs move on a branch
 * switch or commit; the index moves when anything is staged (including by a
 * command in the integrated terminal); the marker files start and end merges,
 * rebases and cherry-picks. Everything else under `.git` — objects, logs, and
 * the lock files that appear and vanish around every single write — is noise.
 */
const GIT_PATHS_OF_INTEREST = [
  "HEAD",
  "index",
  "packed-refs",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "REBASE_HEAD",
  "refs",
  "rebase-merge",
  "rebase-apply",
];

/**
 * Should a changed path trigger a refresh?
 *
 * Exported for its own tests: this predicate is the whole difference between a
 * watcher that is quiet and one that fires during every `npm install`.
 */
export function shouldRefreshFor(relPath: string): boolean {
  if (!relPath) {
    return false;
  }
  const parts = relPath.split(/[/\\]/).filter(Boolean);
  if (parts.length === 0) {
    return false;
  }

  if (parts[0] === ".git") {
    // A lock file is git mid-write; the real change arrives as the file itself
    // a moment later, so reacting to the lock only doubles the work.
    if (parts.some((p) => p.endsWith(".lock"))) {
      return false;
    }
    return GIT_PATHS_OF_INTEREST.includes(parts[1] ?? "");
  }

  if (parts.some((p) => IGNORED_DIRS.has(p))) {
    return false;
  }

  // Editor scratch files: writing through a temp file would otherwise fire twice
  // per save, once for the temp and once for the rename.
  const name = parts[parts.length - 1];
  if (name.endsWith("~") || name.startsWith(".#") || name === ".DS_Store") {
    return false;
  }
  if (/^\.?[^/\\]*\.(swp|swx|tmp)$/i.test(name)) {
    return false;
  }
  return true;
}

/**
 * Watches one repository root and calls `onChange` (debounced) when something
 * that matters changes. Create one per open repo; `dispose()` on close.
 */
export class RepoWatcher {
  private watcher: FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  private pendingGitDir = false;
  /** True when the recursive watch could not be established (see ENOSPC above). */
  readonly degraded: boolean;

  constructor(
    private readonly root: string,
    private readonly onChange: (info: { gitDir: boolean }) => void,
  ) {
    try {
      this.watcher = watch(
        root,
        { recursive: true, persistent: false },
        (_event, filename) => {
          if (!filename) {
            // Some platforms report a change without naming it. The safe reading
            // is "something happened, and it might have been a commit", so this
            // takes the full-refresh path; the debounce keeps it cheap.
            this.schedule(true);
            return;
          }
          const rel = String(filename).replace(root + sep, "");
          if (shouldRefreshFor(rel)) {
            this.schedule(rel.split(/[/\\]/)[0] === ".git");
          }
        },
      );
      // A watcher that dies later (the directory is renamed or unmounted) must
      // not take the main process with it.
      this.watcher.on("error", () => this.stopWatching());
      this.degraded = false;
    } catch {
      // Most likely ENOSPC from inotify on a large tree, or a path that vanished
      // between opening the repo and getting here. The app stays usable: the
      // renderer still refreshes on window focus.
      this.watcher = undefined;
      this.degraded = true;
    }
  }

  /** Any `.git` change inside the debounce window makes the whole burst count as
   *  one, so a commit is never downgraded to "just some files moved". */
  private schedule(gitDir: boolean): void {
    this.pendingGitDir = this.pendingGitDir || gitDir;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const wasGitDir = this.pendingGitDir;
      this.pendingGitDir = false;
      this.onChange({ gitDir: wasGitDir });
    }, DEBOUNCE_MS);
  }

  private stopWatching(): void {
    try {
      this.watcher?.close();
    } catch {
      /* already gone */
    }
    this.watcher = undefined;
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.stopWatching();
  }
}
