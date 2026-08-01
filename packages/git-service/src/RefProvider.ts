import type { GitRef, GitRefType, RepoHead } from "@gitstudio/host-bridge/git";
import type { GitProcess } from "./GitProcess";

const FIELD_SEP = "\x1f";

// %(*objectname) peels annotated tags to the COMMIT they tag — %(objectname)
// alone is the tag object's own sha, which matches no graph row, so annotated
// tags would never render a chip anywhere. Empty for everything else.
const REF_FORMAT =
  `--format=%(objectname)${FIELD_SEP}%(refname)${FIELD_SEP}` +
  `%(refname:short)${FIELD_SEP}%(HEAD)${FIELD_SEP}%(upstream:short)` +
  `${FIELD_SEP}%(upstream:track)${FIELD_SEP}%(*objectname)`;

/** Parses `%(upstream:track)` ("[ahead 2, behind 3]", "[gone]", or "") into
 *  ahead/behind counts. Returns undefined counts when not tracked/clean. */
function parseTrack(track: string | undefined): { ahead?: number; behind?: number } {
  if (!track) {
    return {};
  }
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  return {
    ...(ahead ? { ahead: Number(ahead[1]) } : {}),
    ...(behind ? { behind: Number(behind[1]) } : {}),
  };
}

const STASH_FORMAT = `--format=%H${FIELD_SEP}%gd${FIELD_SEP}%gs`;

function refTypeFromFullName(fullName: string): GitRefType | undefined {
  if (fullName.startsWith("refs/heads/")) {
    return "head";
  }
  if (fullName.startsWith("refs/remotes/")) {
    return "remote";
  }
  if (fullName.startsWith("refs/tags/")) {
    return "tag";
  }
  return undefined;
}

/** Lists branches, remote branches, tags, and stashes; reads HEAD. */
export class RefProvider {
  constructor(private proc: GitProcess) {}

  async listRefs(): Promise<GitRef[]> {
    const refs: GitRef[] = [];

    // for-each-ref and stash list are independent — run them concurrently
    // rather than one git spawn after the other.
    const [branchesAndTags, stash] = await Promise.all([
      this.proc.run([
        "for-each-ref",
        REF_FORMAT,
        "refs/heads",
        "refs/remotes",
        "refs/tags",
      ]),
      this.proc.run(["stash", "list", STASH_FORMAT]),
    ]);
    for (const line of splitLines(branchesAndTags.stdout)) {
      const [objectname, refname, short, head, upstream, track, peeled] =
        line.split(FIELD_SEP);
      const type = refTypeFromFullName(refname);
      if (!type) {
        continue;
      }
      const ref: GitRef = {
        type,
        name: short,
        fullName: refname,
        // Annotated tags: use the peeled commit sha so decorations land on a
        // real graph row; lightweight tags/branches have no peel (empty).
        sha: peeled || objectname,
        isCurrent: head === "*",
      };
      if (upstream) {
        ref.upstream = upstream;
        const { ahead, behind } = parseTrack(track);
        if (ahead !== undefined) {
          ref.ahead = ahead;
        }
        if (behind !== undefined) {
          ref.behind = behind;
        }
      }
      refs.push(ref);
    }

    if (stash.code === 0) {
      for (const line of splitLines(stash.stdout)) {
        const [sha, selector] = line.split(FIELD_SEP);
        if (!selector) {
          continue;
        }
        refs.push({
          type: "stash",
          name: selector,
          fullName: "refs/stash",
          sha,
          isCurrent: false,
        });
      }
    }

    return refs;
  }

  async getHead(): Promise<RepoHead> {
    // rev-parse and symbolic-ref are independent — run them concurrently.
    const [shaResult, branchResult] = await Promise.all([
      this.proc.run(["rev-parse", "HEAD"]),
      this.proc.run(["symbolic-ref", "--quiet", "--short", "HEAD"]),
    ]);
    const sha = shaResult.stdout.trim();
    const branch = branchResult.stdout.trim();
    const detached = branchResult.code !== 0 || branch.length === 0;

    return detached ? { detached: true, sha } : { detached: false, branch, sha };
  }

  /**
   * Branches that CONTAIN `sha` — i.e. it is reachable from their tip. This is
   * a different question from "which refs point AT this commit" (that is
   * `listRefs`), and it is the one that answers "where has this change already
   * landed?". JetBrains' "In N branches" is this query.
   *
   * Deliberately lazy: on a repo with many branches this walks history and can
   * take real time, so callers should only ask when the user opts in.
   *
   * Returns local branches first, then remote-tracking ones, each de-duplicated
   * and sorted; `truncated` is true when the result was capped.
   */
  async containingBranches(
    sha: string,
    opts?: { limit?: number; signal?: AbortSignal },
  ): Promise<{ branches: string[]; truncated: boolean }> {
    const limit = opts?.limit ?? CONTAINS_LIMIT;
    // FULL refnames, not %(refname:short). The short form is ambiguous here:
    // a local "feature/x" and a remote "origin/x" are both "a/b", so splitting
    // on the presence of "/" filed every local topic branch under remotes; and
    // refs/remotes/origin/HEAD shortens to a bare "origin", which then looked
    // like a local branch of that name.
    const result = await this.proc.run(
      ["branch", "--all", "--contains", sha, "--format=%(refname)"],
      { signal: opts?.signal },
    );
    if (result.code !== 0) {
      // Unknown sha, or a repo with no branches — report "none" rather than
      // surfacing a git error for what is an optional, informational query.
      return { branches: [], truncated: false };
    }
    const seen = new Set<string>();
    const locals: string[] = [];
    const remotes: string[] = [];
    for (const line of splitLines(result.stdout)) {
      const ref = line.trim();
      if (!ref) {
        continue;
      }
      if (ref.startsWith("refs/heads/")) {
        const name = ref.slice("refs/heads/".length);
        if (name && !seen.has(name)) {
          seen.add(name);
          locals.push(name);
        }
      } else if (ref.startsWith("refs/remotes/")) {
        const name = ref.slice("refs/remotes/".length);
        // refs/remotes/<remote>/HEAD is a symbolic pointer at the remote's
        // default branch, not a branch of its own — listing it duplicates
        // whatever it points at.
        if (!name || name.endsWith("/HEAD") || seen.has(name)) {
          continue;
        }
        seen.add(name);
        remotes.push(name);
      }
      // Anything else (a detached-HEAD pseudo-entry) names nothing actionable.
    }
    locals.sort();
    remotes.sort();
    const all = [...locals, ...remotes];
    return {
      branches: all.slice(0, limit),
      truncated: all.length > limit,
    };
  }
}

/** Cap on reported containing branches — a repo can have thousands. */
const CONTAINS_LIMIT = 100;

function splitLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}
