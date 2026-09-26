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
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { parseGitHubRemote } from "./githubRemote";
import { MAX_LOCAL_REPOS } from "../shared/repoGrouping";
import type { LocalCopy, LocalRepoStatus } from "../shared/ipc";

/** Don't shell out to git hundreds of times for a huge folder. Shared, so the
 *  views that render the list can say when it is a prefix rather than all. */
const MAX_ENTRIES = MAX_LOCAL_REPOS;
/** How many directory levels of a tracked folder are searched for repos.
 *  Two: ~/work/acme/website is the ordinary shape of a machine. */
export const SCAN_DEPTH = 2;
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
/**
 * Which tracked folders are worth showing.
 *
 * The DEFAULT clone folder is a promise about where the next clone will land,
 * not a directory that has to exist — the app creates it when it first needs
 * it. Before that it is nothing on disk, and listing it as a band reading
 * "0 repositories · missing" is both noise and, once the folder menu could
 * delete it, the reason deleting it looked like it had not worked.
 *
 * A clone folder somebody CHOSE is kept even when it goes missing: they meant
 * it to be there, and its absence is news.
 */
export function visibleRepoFolders<
  T extends { isDefaultCloneDir: boolean; missing: boolean; containedCount: number },
>(folders: T[]): T[] {
  // `containedCount`, never `repoCount`. A folder whose repositories all sit
  // one level down has repoCount 0 and is emphatically not empty; hiding it on
  // that basis would take a folder full of work off the screen.
  return folders.filter((f) => !(f.isDefaultCloneDir && f.missing && f.containedCount === 0));
}

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
export async function realOrResolve(p: string): Promise<string> {
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

/**
 * The main repository a linked worktree belongs to, from its gitfile.
 *
 * A worktree's `.git` is a FILE reading `gitdir: <main>/.git/worktrees/<name>`.
 * Pure so the parse is testable; returns undefined for anything else a gitfile
 * can say (a submodule's gitdir points into the parent's `.git/modules/`, and
 * that is a different thing — a submodule IS its own repository).
 */
export function worktreeMainRoot(gitfile: string): string | undefined {
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(gitfile);
  if (!m) return undefined;
  // git writes FORWARD slashes into gitfiles on every platform (and Windows
  // tools sometimes rewrite them) — a needle built from path.sep alone is
  // dead on one OS or the other, so both separators are accepted.
  const i = Math.max(
    m[1].lastIndexOf("/.git/worktrees/"),
    m[1].lastIndexOf("\\.git\\worktrees\\"),
  );
  return i > 0 ? m[1].slice(0, i) : undefined;
}

/**
 * One repo's working-tree signals, parsed from `git status --porcelain=v2
 * --branch`. Pure — the shape of porcelain v2 is a contract worth pinning:
 *
 *   # branch.head main            (or "(detached)")
 *   # branch.ab +2 -1             (absent entirely without an upstream)
 *   1 .M ... path                 (changed)     2 R. ... path (renamed)
 *   u UU ... path                 (conflicted)  ? path        (untracked)
 */
export function parsePorcelainV2(out: string): LocalRepoStatus {
  let branch = "";
  let ahead = 0;
  let behind = 0;
  let dirty = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const h = line.slice("# branch.head ".length).trim();
      branch = h === "(detached)" ? "" : h;
    } else if (line.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
    } else if (/^[12u?] /.test(line)) {
      dirty++;
    }
  }
  return { branch, dirty, ahead, behind };
}

/** The signals for one root, or undefined when git can't answer (missing,
 *  not a repo, or slower than the timeout — a Home row must never wait). */
export function statusOf(root: string): Promise<LocalRepoStatus | undefined> {
  return new Promise((res) => {
    execFile(
      "git",
      ["-C", root, "--no-optional-locks", "status", "--porcelain=v2", "--branch"],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout) => res(err ? undefined : parsePorcelainV2(stdout)),
    );
  });
}

/** How many roots one localStatus request will probe — the Home card shows 8,
 *  the Repositories screen asks in batches of this many; anything asking for
 *  more is a bug wearing a loop. */
export const STATUS_ROOTS_CAP = 16;

/**
 * The status TTL lives HERE, not in the renderer's SWR cache — the file
 * watcher's refreshAll() busts that cache on every save, which turned "at
 * most one probe per 10s" into eight git subprocesses per keystroke-save
 * while Home was open. Main's clock is the one the busts can't reach.
 *
 * Kept PER REPOSITORY. It was one entry keyed by the exact list asked for,
 * which was right while Home was the only asker; the Repositories screen asks
 * in batches (and a filter changes what each batch holds), so every batch
 * evicted the one before it and a repaint re-probed every repository on the
 * screen. Entries older than the TTL are dropped on each call, so it holds at
 * most what the screens asked about in the last ten seconds.
 */
const STATUS_TTL_MS = 10_000;
const statusCache = new Map<string, { at: number; value: LocalRepoStatus | undefined }>();

export async function localStatuses(
  roots: string[],
  now: () => number = () => Date.now(),
): Promise<Record<string, LocalRepoStatus | undefined>> {
  const take = roots.slice(0, STATUS_ROOTS_CAP);
  const t = now();
  for (const [root, e] of statusCache) {
    if (t - e.at >= STATUS_TTL_MS) statusCache.delete(root);
  }
  const probe = take.filter((r) => !statusCache.has(r));
  const answers = await mapLimit(probe, 4, statusOf);
  probe.forEach((r, i) => statusCache.set(r, { at: t, value: answers[i] }));
  const out: Record<string, LocalRepoStatus | undefined> = {};
  for (const r of take) out[r] = statusCache.get(r)?.value;
  return out;
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

/** Whether the most recent UNCACHED scan hit the MAX_ENTRIES cap. Module
 *  state on purpose: one main process, one scan shape — and threading a flag
 *  through the array-shaped cache and IPC would cost every caller its type. */
let lastScanTruncated = false;
export function wasLastScanTruncated(): boolean {
  return lastScanTruncated;
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
  /**
   * Walk a tracked folder, two levels deep.
   *
   * One level was wrong for how people actually keep repositories: ~/work/acme,
   * ~/work/personal, ~/src/github.com/owner — a folder of FOLDERS of repos is
   * the normal shape, and scanning only the top level found a fraction of what
   * was there while the folder's own count said that fraction was all of it.
   *
   * Two, not unlimited: a repository is not itself scanned (a nested repo is a
   * submodule or a vendored copy, and listing those as separate repositories is
   * noise), and an unbounded walk of a home directory is how a file listing
   * becomes a minute of disk.
   */
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (managedRoots.length >= MAX_ENTRIES) return;
    let names;
    try {
      names = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // missing / unreadable — the others, and recents, still list
    }
    for (const d of names) {
      if (!d.isDirectory() || d.name.startsWith(".")) continue;
      if (managedRoots.length >= MAX_ENTRIES) return;
      const root = join(dir, d.name);
      if (await isRepoDir(root)) {
        managedRoots.push(root);
        continue; // do not descend INTO a repository
      }
      if (depth > 0) await walk(root, depth - 1);
    }
  };
  for (const dir of roots) {
    if (!dir || scanned.has(resolve(dir))) continue;
    scanned.add(resolve(dir));
    await walk(dir, SCAN_DEPTH - 1);
    if (managedRoots.length >= MAX_ENTRIES) break;
  }
  managedRoots.sort((a, b) => basename(a).localeCompare(basename(b)));

  // Recents first (they carry the app's own ordering), then managed folders.
  const all = [...input.recents, ...managedRoots];
  const candidates = all.slice(0, MAX_ENTRIES);
  // The truth the LIST cannot carry: dedupe and missing-path merging pull the
  // final length back under the cap, so `copies.length >= 300` misses real
  // truncation on exactly the machines the cap note was written for. Recorded
  // here, read over its own channel.
  lastScanTruncated = all.length > MAX_ENTRIES || managedRoots.length >= MAX_ENTRIES;

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
  // A linked worktree is a CHECKOUT of a repository, not another repository —
  // FlexiMeal read "5" while holding three repos and two worktrees of one of
  // them. Mark them so the counts can skip them and the rows can say so.
  const worktrees = await mapLimit(list, PROBE_CONCURRENCY, async (c) => {
    if (c.missing) return undefined;
    try {
      const st = await stat(join(c.root, ".git"));
      if (!st.isFile()) return undefined;
      return worktreeMainRoot(await readFile(join(c.root, ".git"), "utf8"));
    } catch {
      return undefined;
    }
  });
  list.forEach((c, i) => {
    if (origins[i]) c.origin = origins[i];
    if (worktrees[i]) c.worktreeOf = worktrees[i];
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
