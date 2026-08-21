import type { GitProcess } from "./GitProcess";
import {
  rewritableChain,
  type ChainCommit,
  type RewritableChain,
} from "@gitstudio/engine/rebase/chain";

/**
 * Which commits the Commits list may reorder — asked of git, decided by the
 * engine.
 *
 * The webview cannot work this out for itself: its rows carry `isMerge` but not
 * parents, and it has no idea what is published. So the host answers once and
 * sends the chain down; see engine/rebase/chain.ts for what the answer means.
 *
 * One `rev-list` does it, and it is purely local — `--not --remotes` compares
 * against remote-tracking refs we already have, so no fetch and no network.
 * That matters because this runs on every graph load.
 */
export async function readRewritableChain(
  proc: GitProcess,
  opts?: { signal?: AbortSignal; maxCount?: number },
): Promise<RewritableChain> {
  const args = [
    "rev-list",
    "--first-parent",
    // %H then its parents, one commit per line. No commit header, so each line
    // is exactly one record.
    "--no-commit-header",
    "--format=%H %P",
    "HEAD",
    "--not",
    "--remotes",
  ];
  if (opts?.maxCount && opts.maxCount > 0) {
    // A cap keeps this bounded on a branch with thousands of unpushed commits.
    // Truncating can only make the chain SHORTER, never let something through
    // that should not move, so it is safe in the direction that matters.
    args.splice(1, 0, `--max-count=${opts.maxCount}`);
  }

  const r = await proc.run(args, { signal: opts?.signal });
  if (r.code !== 0) {
    // No upstream, no commits, a fresh repo — all legitimately "nothing to
    // reorder" rather than an error worth surfacing.
    return { shas: [], stop: "root" };
  }

  const commits: ChainCommit[] = [];
  for (const line of r.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [sha, ...parents] = trimmed.split(" ");
    if (!sha) continue;
    commits.push({ sha, parents });
  }
  return rewritableChain(commits);
}
