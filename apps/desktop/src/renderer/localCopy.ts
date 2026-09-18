// "Do I already have this repository?" — one answer, for every screen that asks.
//
// Explore and Repositories each grew their own copy of this join and they
// DISAGREED: Explore dropped copies whose folder is gone, Repositories kept
// them, so the same repository could carry an "on this machine" chip on one
// screen and not on the other. The chip claims a folder you can open, and a
// folder that is gone cannot be opened — `openRemoteRepo` already refused it —
// so a missing copy is not a copy. One join, one answer, everywhere.

import { host } from "./bridge";
import { gget } from "./cache";
import { toast, promptChoice } from "./dialogs";
import { loadEditors } from "./openIn";
import { betterCopy } from "../shared/repoGrouping";
import type { LocalCopy } from "../shared/ipc";
import type { SectionNav } from "./views/common";

/** A copy on disk, plus how much uncommitted work is waiting in it. */
export interface HaveCopy {
  copy: LocalCopy;
  dirty: number;
}

/**
 * A path shortened from the MIDDLE, keeping the home-relative head and the
 * folder itself.
 *
 * Truncating from the right eats the folder name, which is the only part that
 * tells two clones of the same project apart — the exact mistake the branch
 * list made with its upstream column.
 */
export function middlePath(root: string): string {
  const parts = root.split("/").filter(Boolean);
  if (parts.length <= 3) return root;
  return `…/${parts.slice(-2).join("/")}`;
}

/**
 * origin ("owner/repo", lowercased) → the copy worth offering.
 *
 * "Do I already have this?" is answered by ORIGIN, not by folder name — a repo
 * cloned into a differently-named directory is still the same repo, and
 * offering to clone it again is how you end up with two copies.
 *
 * Several copies can share one origin — a worktree, or a folder literally named
 * "trust-globe copy" beside "trust-globe". The last one written used to win,
 * and the list arrives name-sorted, so "Open" on the GitHub row for trust-globe
 * opened the COPY. Pick deliberately instead, via betterCopy: the one that is
 * open, else one that is not missing, else the shallowest path. Worktrees stay
 * in — you DO have the repository, and betterCopy prefers the clone.
 */
export function localCopyIndex(copies: readonly LocalCopy[]): Map<string, LocalCopy> {
  const map = new Map<string, LocalCopy>();
  for (const c of copies) {
    if (!c.origin || c.missing) continue;
    const key = c.origin.toLowerCase();
    const held = map.get(key);
    if (!held || betterCopy(c, held)) map.set(key, c);
  }
  return map;
}

/**
 * The copy of `fullName` on this machine, with its uncommitted count.
 *
 * Best-effort on purpose: undefined on any failure, never throws. A page that
 * cannot answer "do I have it?" must still render the repository.
 */
export async function findLocalCopy(fullName: string): Promise<HaveCopy | undefined> {
  const copies = await gget("repos:local", undefined, 5000).catch(() => [] as LocalCopy[]);
  const copy = localCopyIndex(copies).get(fullName.toLowerCase());
  if (!copy) return undefined;
  const status = await gget("repos:localStatus", [copy.root], 4000).catch(
    () => ({}) as Record<string, undefined>,
  );
  return { copy, dirty: status[copy.root]?.dirty ?? 0 };
}

/** Open a repository by its folder, and land on `land` once it is open. */
export async function openPath(root: string, nav: SectionNav, land: string = "code"): Promise<void> {
  const info = await host.invoke("repo:openPath", root);
  if (info) nav(land);
}

/**
 * Open the copy you have on this machine.
 *
 * Clean tree → there is nothing to choose between, so it just opens. Dirty tree
 * → "open" is ambiguous, so ask what it means: the code, the changes, or your
 * editor. `onBrowse` adds the "Browse it on GitHub" row; the browse page itself
 * omits it, because you are already there.
 */
export async function openLocalCopy(
  fullName: string,
  local: LocalCopy,
  nav: SectionNav,
  opts?: { onBrowse?: () => void },
): Promise<void> {
  const [status, editors] = await Promise.all([
    gget("repos:localStatus", [local.root], 4000).catch(() => ({}) as Record<string, undefined>),
    loadEditors(),
  ]);
  const dirty = status[local.root]?.dirty ?? 0;
  const fav = editors.editors.find((e) => e.isDefault && e.shown);
  // Nothing uncommitted means there is nothing to choose between.
  if (!dirty) {
    await openPath(local.root, nav);
    return;
  }
  const choices = [
    { id: "code", label: "Open the code", sub: "Browse the files at this checkout.", icon: "code" },
    {
      id: "changes",
      label: "Open the changes",
      sub: `${dirty} uncommitted ${dirty === 1 ? "file" : "files"} waiting in this repository.`,
      icon: "request-changes",
    },
    ...(fav
      ? [
          {
            id: "editor",
            label: `Open in ${fav.name}`,
            sub: `Hand the folder to ${fav.name} and stay here.`,
            icon: "link-external",
          },
        ]
      : []),
    ...(opts?.onBrowse
      ? [
          {
            id: "browse",
            label: "Browse it on GitHub",
            sub: "Read the repository without opening it.",
            icon: "globe",
          },
        ]
      : []),
  ];
  const pick = await promptChoice({
    title: fullName,
    hint: `You have this one at ${middlePath(local.root)}.`,
    choices,
    cancelId: "cancel",
  });
  if (pick === "code") await openPath(local.root, nav);
  else if (pick === "changes") await openPath(local.root, nav, "changes");
  else if (pick === "browse") opts?.onBrowse?.();
  else if (pick === "editor" && fav) {
    const res = await host.invoke("editors:open", { id: fav.id, root: local.root });
    if (!res.ok) toast(res.message ?? "Couldn't open the editor.", "error");
  }
}
