// "My Work" — everything in the CURRENT repo that involves the signed-in user,
// gathered with the search API's `@me` qualifiers (no login round-trip needed):
//   • open PRs where my review is requested
//   • open issues/PRs assigned to me
//   • open PRs I authored
//   • open items that mention me (minus my own)
//
// Four searches run in parallel; each is best-effort (one failing bucket never
// blanks the page). Items are deduped across buckets in priority order —
// review-requested beats assigned beats my-prs beats mentions — so one PR shows
// once, under the most actionable heading.

import { GitHubClient } from "../githubClient";
import { ExpectedError, isExpectedError } from "../expectedError";
import * as l10n from "@vscode/l10n";
import type { MyWorkItem } from "../../shared/ipc";

interface RawSearchIssue {
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  pull_request?: unknown;
  updated_at: string;
  comments?: number;
  user?: { login?: string } | null;
  /** ".../repos/{owner}/{repo}" — the only place a search hit names its repo. */
  repository_url?: string;
}

/** "{owner}/{name}" out of a search hit's repository_url, or undefined. */
function repoOf(it: RawSearchIssue): { owner: string; name: string } | undefined {
  const m = /\/repos\/([^/]+)\/([^/]+)$/.exec(it.repository_url ?? "");
  return m ? { owner: m[1], name: m[2] } : undefined;
}

async function search(client: GitHubClient, q: string): Promise<RawSearchIssue[]> {
  const res = await client.request<{ items?: RawSearchIssue[] }>(
    "GET",
    `/search/issues?q=${encodeURIComponent(q)}&sort=updated&per_page=50`,
  );
  return res.items ?? [];
}

/**
 * The error for "every search failed", carrying the searches' own verdict.
 *
 * All four failing is almost always one cause failing four times — offline, a
 * proxy, an expired token, the search rate limiter — and each of those already
 * arrived here as an ExpectedError. Swallowing them per bucket and throwing a
 * fresh plain Error laundered a network state into a crash report
 * ("ipc:github:myWork"), and told the user less than the first failure did.
 * So: expected when every failure was, and in the first failure's words; when
 * any of them was NOT expected (a query GitHub refused, say), that one is the
 * message and it still reports.
 */
function allSearchesFailed(failures: readonly unknown[]): Error {
  const fallback = l10n.t("GitHub didn't answer any of the work searches.");
  const messageOf = (e: unknown): string => (e instanceof Error && e.message.trim() ? e.message : fallback);
  const defect = failures.find((e) => !isExpectedError(e));
  if (defect !== undefined) return new Error(messageOf(defect), { cause: defect });
  return new ExpectedError(messageOf(failures[0]), { cause: failures[0] });
}

export async function myWork(
  client: GitHubClient,
  owner: string | undefined,
  repo: string | undefined,
): Promise<MyWorkItem[]> {
  // No owner/repo = the CROSS-REPO answer, for Home: everything waiting on
  // you anywhere, not just in the repository that happens to be open. The
  // qualifier simply drops out of the search.
  const scope = owner && repo ? `repo:${owner}/${repo} is:open` : `is:open`;
  // Best-effort per bucket — one failing search must not blank the page. But
  // ALL FOUR failing is not "you have no work": a rate-limited or offline
  // client used to resolve [] here, and Home then said a green "Nothing
  // waiting on you" about a question it never got answered. Total failure
  // throws, and the caller says "couldn't reach GitHub" like it means it.
  const failures: unknown[] = [];
  const soft = (q: string): Promise<RawSearchIssue[]> =>
    search(client, q).catch((err: unknown) => {
      failures.push(err);
      return [] as RawSearchIssue[];
    });
  const [rev, assigned, mine, mentions] = await Promise.all([
    soft(`${scope} is:pr review-requested:@me`),
    soft(`${scope} assignee:@me`),
    soft(`${scope} is:pr author:@me`),
    soft(`${scope} mentions:@me -author:@me`),
  ]);
  if (failures.length === 4) throw allSearchesFailed(failures);

  const out: MyWorkItem[] = [];
  const seen = new Set<string>();
  const push = (kind: MyWorkItem["kind"], items: RawSearchIssue[]): void => {
    for (const it of items) {
      const type: MyWorkItem["type"] = it.pull_request ? "pr" : "issue";
      const where = repoOf(it);
      // The repo is part of the identity. Cross-repo, issue #31 here and
      // issue #31 somewhere else are different items — a number-only key
      // silently dropped one of them.
      const key = `${where ? `${where.owner}/${where.name}` : ""}${type}#${it.number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind,
        type,
        number: it.number,
        ...(where ? { repo: where } : {}),
        title: it.title,
        state: it.state,
        draft: !!it.draft,
        updatedAt: it.updated_at,
        comments: it.comments ?? 0,
        author: it.user?.login ?? null,
      });
    }
  };
  push("review-requested", rev);
  push("assigned", assigned);
  push("my-prs", mine);
  push("mentions", mentions);
  return out;
}
