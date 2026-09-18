// Where a repository sits: which tracked folder holds it, and which directory
// inside that folder.
//
// Pure and host-free, because three places must agree about it and any drift
// between them is visible as a lie on screen. The main process counts with it,
// the renderer draws bands with it, and the tests pin it.
//
// The screen it replaces grouped with `parentOf(root) === folder.path` — only
// DIRECT children. On the machine this was written for that put six
// repositories under "~/Developer", said "6 repositories" above them, and
// dropped the other nineteen into a heading reading "Opened from elsewhere"
// — which was false twice over: they were inside a folder he had tracked on
// purpose, and the app had found them itself.
//
// THE CHOICE THAT DECIDES THE SCREEN — a repository belongs to the SHALLOWEST
// tracked folder that contains it, not the deepest.
//
// He tracks ~/Developer and, because opening a repository quietly tracks its
// parent, ~/Developer/GitStudioHQ as well. Deepest-wins gives the inner one its
// own top-level band: GitStudioHQ is then torn out of the alphabetical run it
// belongs in, and ~/Developer claims 23 while standing over a directory holding
// 27. Shallowest-wins keeps one band per place you actually think about, and
// lets the inner tracked folder render where the disk puts it — as a group,
// carrying its own chip and its own menu. Nothing is listed twice either way;
// the difference is entirely whether the screen matches the disk.

/** Trailing slashes off, so string comparison means what it looks like. */
/**
 * The scan's hard cap — the point past which the local-repository list is a
 * PREFIX, not an inventory. Shared so the surfaces that render the list can
 * say so instead of presenting 300 as everything ("No silent caps").
 */
export const MAX_LOCAL_REPOS = 300;

export function normalizePath(p: string): string {
  return p.replace(/\/+$/, "");
}

/**
 * Is `child` inside `parent` (and not `parent` itself)?
 *
 * Segment-aware. A bare `startsWith` has ~/Dev claiming ~/Developer, which on
 * this machine would put every repository he owns under the wrong heading.
 */
export function isUnder(parent: string, child: string): boolean {
  const p = normalizePath(parent);
  const c = normalizePath(child);
  return c.length > p.length && c.startsWith(p + "/");
}

/** Where one repository renders: under `band`, in sub-directory `group`. */
export interface Claim {
  /** The tracked folder's path, exactly as it was configured — so the
   *  renderer can look the band up in the folders payload by identity. */
  band: string;
  /** The directory below the band, "" when the repository sits directly in it.
   *  May be multi-segment ("GitStudioHQ/archive") when a repository is found
   *  deeper than one level down. */
  group: string;
}

/**
 * Decide, once, where every repository renders.
 *
 * Computed in one place and shipped to the renderer, rather than recomputed
 * there: the renderer has no realpath, so a symlinked folder is a question only
 * the main process can answer, and the count a head prints must come from the
 * same pass that produced the rows under it.
 */
export function claimRepos(
  folders: readonly string[],
  roots: readonly string[],
): Map<string, Claim> {
  // Shallowest first, so the first containing folder found is the answer.
  const ordered = [...folders].sort(
    (a, b) => normalizePath(a).length - normalizePath(b).length,
  );
  const out = new Map<string, Claim>();
  for (const root of roots) {
    const band = ordered.find((f) => isUnder(f, root));
    if (band === undefined) continue; // genuinely outside every tracked folder
    out.set(root, { band, group: relativeDir(band, root) });
  }
  return out;
}

/**
 * The directory of `root` relative to `folder` — "" for a direct child.
 *
 * "" is a real answer, not a missing one: six of this machine's twenty-seven
 * repositories sit loose in the folder he tracked, and they must render at the
 * band's own indent rather than inside an invented group.
 */
export function relativeDir(folder: string, root: string): string {
  if (!isUnder(folder, root)) return "";
  const rest = normalizePath(root).slice(normalizePath(folder).length + 1);
  const cut = rest.lastIndexOf("/");
  return cut < 0 ? "" : rest.slice(0, cut);
}

/**
 * The whole path of `inner` relative to `outer` — its own last segment kept.
 *
 * The twin of `relativeDir`, and the distinction is easy to get wrong: for a
 * REPOSITORY the group is the directory holding it, so its own name comes off;
 * for a FOLDER the group IS that folder, so its name stays on. Using the repo
 * form for a folder gave ~/Developer/GitStudioHQ the group key "" — the key
 * meaning "loose in the band" — so it matched no group head and its tracked
 * chip and menu never appeared.
 */
export function relativePath(outer: string, inner: string): string {
  if (!isUnder(outer, inner)) return "";
  return normalizePath(inner).slice(normalizePath(outer).length + 1);
}

/** Both numbers a folder head needs, and they are not the same number. */
export interface FolderCounts {
  /**
   * Repositories that render DIRECTLY under this head — what the head prints.
   * For a band that is the loose ones; for a group, the ones in it.
   */
  direct: number;
  /**
   * Every repository at or below this folder, at any depth. What decides
   * whether "Delete this folder" may be offered, and whether a folder that has
   * gone missing is still worth showing. A clone folder whose repositories all
   * sit one level down reports `direct: 0` — offering to delete it on that
   * basis is how a menu comes to say "It's empty — nothing is lost" over a
   * directory full of work.
   */
  contained: number;
}

/** Count a folder's repositories both ways, from the claims and the roots. */
export function countFolder(
  folderPath: string,
  roots: readonly string[],
  claims: ReadonlyMap<string, Claim>,
): FolderCounts {
  let direct = 0;
  let contained = 0;
  for (const root of roots) {
    if (!isUnder(folderPath, root)) continue;
    contained++;
    const claim = claims.get(root);
    // Direct means "renders under this head": for the band that claimed it,
    // with no group between them.
    if (claim && claim.band === folderPath && claim.group === "") direct++;
  }
  return { direct, contained };
}

export interface Group<T> {
  /** What the head shows: the sub-directory's name, or its path below the band
   *  when it is more than one level down. */
  label: string;
  /** Its absolute path — for reveal, copy, and tracking it in its own right. */
  path: string;
  items: T[];
}

/**
 * Split one band's repositories into the loose ones and the groups.
 *
 * Groups are keyed by the WHOLE relative directory, not by its first segment:
 * a repository three levels down is a different place from one two levels down,
 * and folding them together would put a row under a head that does not contain
 * it. In practice almost every group is one segment.
 *
 * Sorted case-insensitively, because "FlexiMeal" and "coding" ordered by code
 * point exiles every lowercase project below every capitalised one for no
 * reason a reader could name.
 */
export function splitBand<T>(
  bandPath: string,
  items: readonly T[],
  groupOf: (item: T) => string,
): { loose: T[]; groups: Array<Group<T>> } {
  const loose: T[] = [];
  const byKey = new Map<string, Group<T>>();
  for (const item of items) {
    const key = groupOf(item);
    if (!key) {
      loose.push(item);
      continue;
    }
    let g = byKey.get(key);
    if (!g) {
      g = { label: key, path: `${normalizePath(bandPath)}/${key}`, items: [] };
      byKey.set(key, g);
    }
    g.items.push(item);
  }
  const groups = [...byKey.values()].sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
  );
  return { loose, groups };
}

/**
 * Which of two clones of the same repository should "Open" mean?
 *
 * The one you are already in, then one that is actually on disk, then the one
 * nearer the top of the tree — a stated order, so the answer does not depend
 * on the order a scan happened to return. Shared because two screens join
 * GitHub results against local copies, and they must agree.
 */
export function betterCopy(
  a: { root: string; current: boolean; missing: boolean; worktreeOf?: string },
  b: { root: string; current: boolean; missing: boolean; worktreeOf?: string },
): boolean {
  if (a.current !== b.current) return a.current;
  if (a.missing !== b.missing) return b.missing;
  // The CLONE over one of its worktrees — "Open your copy" on a GitHub row
  // must land in the repository, not in whichever checkout sorted first.
  if (!a.worktreeOf !== !b.worktreeOf) return !a.worktreeOf;
  return a.root.length < b.root.length;
}
