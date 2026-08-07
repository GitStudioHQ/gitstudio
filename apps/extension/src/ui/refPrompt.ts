import type { RepoEntry } from "../git/repoManager";
import { promptInput, type DialogCandidate } from "./dialogs";

// "Which commit or branch?" — the one question GitStudio asks most, and the one
// the quick input was worst at: it could not complete over the repo's own refs,
// so you had to remember and retype a branch name the app already knew.

/**
 * Ask for a revision, completing over every branch, remote branch and tag in the
 * repo while still accepting any free-text revision expression git understands
 * (`HEAD~5`, `origin/main^`, a bare sha).
 */
export async function promptRevision(
  active: RepoEntry,
  opts: {
    title: string;
    hint?: string;
    placeholder?: string;
    confirmLabel?: string;
    value?: string;
  },
): Promise<string | undefined> {
  const value = await promptInput({
    ...opts,
    candidates: await refCandidates(active),
    // Free text is the point: a revision expression is not in any list.
    strict: false,
  });
  return value?.trim() || undefined;
}

/** Every ref in the repo, as dialog completion candidates. */
export async function refCandidates(
  active: RepoEntry,
): Promise<DialogCandidate[]> {
  try {
    const refs = await active.ctx.refs.listRefs();
    return refs.map((r) => ({
      name: r.name,
      kind: r.type === "head" ? "branch" : r.type === "remote" ? "remote" : r.type,
      icon:
        r.type === "tag" ? "tag" : r.type === "remote" ? "cloud" : "git-branch",
    }));
  } catch {
    // A repo we can't list refs for still deserves a working prompt — the field
    // just loses its completions.
    return [];
  }
}
