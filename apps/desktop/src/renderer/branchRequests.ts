// How the Branches view names a branch to git and to a person (issue #30's
// follow-up). Pure, so the rules are testable without a DOM.
//
// A BranchInfo carries two names. `name` is %(refname:short) — git's SHORTEST
// UNAMBIGUOUS form, which beside a tag "release" is "heads/release". `fullName`
// is "refs/heads/release". Every branch op (merge, rebase, rename, delete,
// push, pull, set-upstream) now goes to the main process by `fullName`, which
// refuses a request without one; what a person reads, and what a NEW branch
// is called when a delete is undone, is the part under refs/heads/ — never
// the short form, which restored as a branch literally named "heads/release".

/** "release" for refs/heads/release — the branch as a person reads it, and
 *  the name `git branch` itself takes. Falls back to the short name only
 *  for something that is not a local branch's full name. */
export function branchName(b: { fullName: string; name: string }): string {
  return b.fullName.startsWith("refs/heads/") ? b.fullName.slice("refs/heads/".length) || b.name : b.name;
}

/** "v1.2" for refs/tags/v1.2 — the name `git tag -d` and a refs/tags/ refspec
 *  take. Beside a branch "v1.2" the short name is "tags/v1.2", which names
 *  no tag at all. */
export function tagName(r: { fullName: string; name: string }): string {
  return r.fullName.startsWith("refs/tags/") ? r.fullName.slice("refs/tags/".length) || r.name : r.name;
}

/** A remote-tracking ref's remote and branch, from its FULL name:
 *  refs/remotes/<remote>/<branch>, the remote the first segment (a branch may
 *  contain slashes). Not from the short name, which is "remotes/origin/x"
 *  beside a local branch called "origin/x" and split at its first slash named
 *  a remote called "remotes". Falls back to the short name without a full one. */
export function remoteRefParts(r: { fullName?: string; name: string }): { remote: string; branch: string } {
  const path = r.fullName?.startsWith("refs/remotes/") ? r.fullName.slice("refs/remotes/".length) : r.name;
  const slash = path.indexOf("/");
  return slash > 0 ? { remote: path.slice(0, slash), branch: path.slice(slash + 1) } : { remote: path, branch: path };
}

/** A local branch's upstream as the remote and the branch on it — from
 *  `upstreamRef` (%(upstream), full), else the short `upstream` for a payload
 *  without one. Undefined when it tracks nothing, or a local branch. */
export function upstreamParts(b: { upstreamRef?: string; upstream?: string }): { remote: string; branch: string } | undefined {
  if (b.upstreamRef) {
    if (!b.upstreamRef.startsWith("refs/remotes/")) return undefined;
    const p = remoteRefParts({ fullName: b.upstreamRef, name: "" });
    return p.branch && p.branch !== p.remote ? p : undefined;
  }
  const slash = b.upstream?.indexOf("/") ?? -1;
  return b.upstream && slash > 0 ? { remote: b.upstream.slice(0, slash), branch: b.upstream.slice(slash + 1) } : undefined;
}

/** How an upstream is NAMED to a person: "origin/x", never git's
 *  "remotes/origin/x" (see upstreamParts). */
export function upstreamLabel(b: { upstreamRef?: string; upstream?: string }): string | undefined {
  const p = upstreamParts(b);
  return p ? `${p.remote}/${p.branch}` : b.upstream;
}

/** A name that starts with "-" — git would read it as an option (and
 *  refuses to create one; update-ref does not). The rename box offers it
 *  without its leading dashes. */
export function renameSuggestion(name: string): string {
  return name.replace(/^-+/, "") || "renamed";
}
