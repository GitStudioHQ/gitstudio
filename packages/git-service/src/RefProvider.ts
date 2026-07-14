import type { GitRef, GitRefType, RepoHead } from "@gitstudio/host-bridge/git";
import type { GitProcess } from "./GitProcess";

const FIELD_SEP = "\x1f";

const REF_FORMAT =
  `--format=%(objectname)${FIELD_SEP}%(refname)${FIELD_SEP}` +
  `%(refname:short)${FIELD_SEP}%(HEAD)${FIELD_SEP}%(upstream:short)` +
  `${FIELD_SEP}%(upstream:track)`;

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
      const [objectname, refname, short, head, upstream, track] =
        line.split(FIELD_SEP);
      const type = refTypeFromFullName(refname);
      if (!type) {
        continue;
      }
      const ref: GitRef = {
        type,
        name: short,
        fullName: refname,
        sha: objectname,
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
}

function splitLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}
