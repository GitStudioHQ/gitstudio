import type { GitRef, GitRefType, RepoHead } from "@gitstudio/host-bridge/git";
import type { GitProcess } from "./GitProcess";

const FIELD_SEP = "\x1f";

const REF_FORMAT =
  `--format=%(objectname)${FIELD_SEP}%(refname)${FIELD_SEP}` +
  `%(refname:short)${FIELD_SEP}%(HEAD)${FIELD_SEP}%(upstream:short)`;

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

    const branchesAndTags = await this.proc.run([
      "for-each-ref",
      REF_FORMAT,
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ]);
    for (const line of splitLines(branchesAndTags.stdout)) {
      const [objectname, refname, short, head, upstream] =
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
      }
      refs.push(ref);
    }

    const stash = await this.proc.run(["stash", "list", STASH_FORMAT]);
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
    const shaResult = await this.proc.run(["rev-parse", "HEAD"]);
    const sha = shaResult.stdout.trim();

    const branchResult = await this.proc.run([
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]);
    const branch = branchResult.stdout.trim();
    const detached = branchResult.code !== 0 || branch.length === 0;

    return detached ? { detached: true, sha } : { detached: false, branch, sha };
  }
}

function splitLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}
