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
}

async function search(client: GitHubClient, q: string): Promise<RawSearchIssue[]> {
  const res = await client.request<{ items?: RawSearchIssue[] }>(
    "GET",
    `/search/issues?q=${encodeURIComponent(q)}&sort=updated&per_page=50`,
  );
  return res.items ?? [];
}

export async function myWork(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<MyWorkItem[]> {
  const scope = `repo:${owner}/${repo} is:open`;
  const [rev, assigned, mine, mentions] = await Promise.all([
    search(client, `${scope} is:pr review-requested:@me`).catch(() => [] as RawSearchIssue[]),
    search(client, `${scope} assignee:@me`).catch(() => [] as RawSearchIssue[]),
    search(client, `${scope} is:pr author:@me`).catch(() => [] as RawSearchIssue[]),
    search(client, `${scope} mentions:@me -author:@me`).catch(() => [] as RawSearchIssue[]),
  ]);

  const out: MyWorkItem[] = [];
  const seen = new Set<string>();
  const push = (kind: MyWorkItem["kind"], items: RawSearchIssue[]): void => {
    for (const it of items) {
      const type: MyWorkItem["type"] = it.pull_request ? "pr" : "issue";
      const key = `${type}#${it.number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind,
        type,
        number: it.number,
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
