// The local-copies scanner behind Settings → Repositories.
//
// GitStudio clones into a folder the user controls (appSettings.cloneDir), and
// it remembers repos opened from anywhere else. Neither list alone answers
// "what do I actually have on this machine?" — so this module unions them:
//
//   top-level dirs of the clone folder  ∪  the recents list
//
// Each candidate is probed for its `origin` remote (so a row can say WHICH
// GitHub repo it is, not just which folder), deduped by real path, and cached
// for 30s — the settings card re-renders freely without re-shelling out to git
// dozens of times.
//
// Electron-free by design (every path and the clock are injected) so it runs
// under plain node in tests.

import { execFile } from "node:child_process";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { parseGitHubRemote } from "./githubRemote";
import type { LocalCopy } from "../shared/ipc";

/** Don't shell out to git hundreds of times for a huge folder. */
const MAX_ENTRIES = 300;
/** Parallel `git remote get-url` probes. */
const PROBE_CONCURRENCY = 8;
const PROBE_TIMEOUT_MS = 5_000;
export const SCAN_TTL_MS = 30_000;

export interface ScanInput {
  /** The configured clone folder — where clones land, and the only place a
   *  managed clone may be trashed from. Always scanned. */
  cloneDir: string;
  /**
   * Every OTHER folder the user has asked GitStudio to keep track of.
   *
   * One clone folder was never the shape of a real machine: people keep work
   * under ~/work, ~/src, a client folder and whatever the last `git clone`
   * landed in. Each of these is scanned for repos exactly like the clone
   * folder is; none of them can be trashed from, because the app did not put
   * anything there.
   */
  folders?: string[];
  /** Recently-opened repo roots (candidates from anywhere on disk). */
  recents: string[];
  /** The repo the app currently has open, if any. */
  current?: string;
}

/** `git -C root remote get-url origin`, parsed to "owner/repo" — or undefined. */
function originOf(root: string): Promise<string | undefined> {
  return new Promise((res) => {
    execFile(
      "git",
      ["-C", root, "remote", "get-url", "origin"],
      { timeout: PROBE_TIMEOUT_MS },
      (err, stdout) => {
        if (err) return res(undefined);
        const parsed = parseGitHubRemote(stdout.trim());
        res(parsed ? `${parsed.owner}/${parsed.repo}` : undefined);
      },
    );
  });
}

/** Two paths that name the same place, compared the way the rest of this
 *  module does (resolve only — realpath needs I/O and a missing path has none). */
export function samePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

/** True when `child` is `parent` itself or sits underneath it. */
export function isInside(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** realpath, falling back to a plain resolve when the path doesn't exist.
 *  Load-bearing on macOS, where /var is a symlink to /private/var: comparing a
 *  resolved repo path against an UNresolved clone dir marks every managed
 *  clone as unmanaged (and so undeletable). */
async function realOrResolve(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    // The path itself is gone — resolve its PARENT instead, so a missing entry
    // is still judged against the same real prefix as everything else. Without
    // this, a deleted clone inside the clone folder reads as "outside your
    // clone folder", which is a true refusal for a false reason.
    try {
      return join(await realpath(dirname(p)), basename(p));
    } catch {
      return resolve(p);
    }
  }
}

/** A directory that is (or contains) a git repo — `.git` may be a dir or a file
 *  (worktrees/submodules use a gitfile), so a plain existence check is right. */
async function isRepoDir(root: string): Promise<boolean> {
  try {
    await stat(join(root, ".git"));
    return true;
  } catch {
    return false;
  }
}

/** Run `fn` over `items` at most `limit` at a time, preserving order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export class LocalRepoScanner {
  private cache: { at: number; key: string; value: LocalCopy[] } | undefined;

  /** `now` is injectable so the 30s cache is testable without real waiting. */
  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Drop the cache — call after anything that changes what's on disk. */
  invalidate(): void {
    this.cache = undefined;
  }

  async scan(input: ScanInput): Promise<LocalCopy[]> {
    const key = JSON.stringify([input.cloneDir, input.recents, input.current ?? ""]);
    const c = this.cache;
    if (c && c.key === key && this.now() - c.at < SCAN_TTL_MS) return c.value;
    const value = await scanLocalCopies(input);
    this.cache = { at: this.now(), key, value };
    return value;
  }
}

/** The uncached scan. Missing paths are REPORTED (dimmed in the UI), never
 *  silently dropped — a recent whose folder was deleted elsewhere is exactly
 *  the thing the manager exists to show. */
export async function scanLocalCopies(input: ScanInput): Promise<LocalCopy[]> {
  const realCloneDir = await realOrResolve(input.cloneDir);
  const realCurrent = input.current ? await realOrResolve(input.current) : undefined;
  // The clone folder first, then every other tracked folder, deduped so a user
  // who adds the clone folder by hand does not get everything in it twice.
  const roots = [input.cloneDir, ...(input.folders ?? [])];
  const scanned = new Set<string>();
  const managedRoots: string[] = [];
  for (const dir of roots) {
    if (!dir || scanned.has(resolve(dir))) continue;
    scanned.add(resolve(dir));
    try {
      const names = await readdir(dir, { withFileTypes: true });
      for (const d of names) {
        if (!d.isDirectory() || d.name.startsWith(".")) continue;
        const root = join(dir, d.name);
        if (await isRepoDir(root)) managedRoots.push(root);
        if (managedRoots.length >= MAX_ENTRIES) break;
      }
    } catch {
      /* folder missing / unreadable — the others, and recents, still list */
    }
    if (managedRoots.length >= MAX_ENTRIES) break;
  }
  managedRoots.sort((a, b) => basename(a).localeCompare(basename(b)));

  // Recents first (they carry the app's own ordering), then managed folders.
  const candidates = [...input.recents, ...managedRoots].slice(0, MAX_ENTRIES);

  // Dedupe by REAL path: a recent entry and a managed folder can be the same
  // repo reached through a symlink, and showing it twice with two different
  // action sets would be a lie about what's on disk.
  const seen = new Map<string, LocalCopy>();
  const resolved = await mapLimit(candidates, PROBE_CONCURRENCY, async (root) => {
    try {
      return { root, real: await realpath(root), missing: false };
    } catch {
      return { root, real: resolve(root), missing: true };
    }
  });

  for (const { root, real, missing } of resolved) {
    const existing = seen.get(real);
    const managed = isInside(realCloneDir, real);
    const recent = input.recents.some((r) => resolve(r) === resolve(root));
    if (existing) {
      existing.managed ||= managed;
      existing.recent ||= recent;
      continue;
    }
    seen.set(real, {
      root: missing ? resolve(root) : real,
      name: basename(root) || real,
      managed,
      recent,
      missing,
      current: !!realCurrent && realCurrent === real,
    });
  }

  const list = [...seen.values()];
  const origins = await mapLimit(list, PROBE_CONCURRENCY, (c) =>
    c.missing ? Promise.resolve(undefined) : originOf(c.root),
  );
  list.forEach((c, i) => {
    if (origins[i]) c.origin = origins[i];
  });

  // Present ones first, then by name — a deleted clone shouldn't head the list.
  return list.sort((a, b) => {
    if (a.missing !== b.missing) return a.missing ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

/** The rule, applied to REAL paths — the form main.ts must use, since a
 *  configured clone dir and a scanned repo root can reach the same place
 *  through different symlinks. */
export async function trashRefusalResolved(
  root: string,
  o: { cloneDir: string; current?: string },
): Promise<string | null> {
  const real = await realOrResolve(root);
  const refusal = trashRefusal(real, {
    cloneDir: await realOrResolve(o.cloneDir),
    current: o.current ? await realOrResolve(o.current) : undefined,
  });
  if (refusal) return refusal;
  // The UI only ever offers rows that came from a scan, so this can't be hit
  // from the app — but the channel is reachable, and "inside the clone folder"
  // must never be enough on its own to delete a folder.
  if (!(await isRepoDir(real))) {
    return "That folder isn't a git repository — GitStudio won't delete it.";
  }
  return null;
}

/** Why this root must not be trashed, or null when it's safe.
 *  Pure so the rule is testable and stated in exactly one place. */
export function trashRefusal(
  root: string,
  o: { cloneDir: string; current?: string },
): string | null {
  const r = resolve(root);
  if (!r || r === resolve(o.cloneDir)) {
    return "That's the clone folder itself, not a repository inside it.";
  }
  if (o.current && resolve(o.current) === r) {
    return "That repository is open right now — switch to another one first.";
  }
  if (!isInside(o.cloneDir, r)) {
    return "GitStudio only deletes clones inside your clone folder. Remove this one from Finder if you meant to.";
  }
  return null;
}
