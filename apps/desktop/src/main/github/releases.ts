// GitHub Releases — the section's main-process logic. These are standalone
// async functions called from main.ts via `github.withRepo((c, o, r) => …)`,
// so each repo-scoped function takes (client, owner, repo, …args). Reads THROW
// on API failure (the renderer catches → errorState + Retry); mutations return a
// CommitActionResult-shaped object ({ ok, changed, message? }) so the renderer
// can toast success/error without unwrapping exceptions.
//
// All-REST: the Releases REST API is complete (list/get/create/update/delete +
// assets inline in the payload), so no GraphQL is needed here. Read+write live
// under the `repo` scope the OAuth token already holds; a read-only token
// surfaces a 403 from the mutation calls as a normal error message.

import { GitHubClient, enc, mapUser, type RawUser } from "../githubClient";
import type {
  CommitActionResult,
  ReleaseInfo,
  ReleaseInput,
  TagInfo,
} from "../../shared/ipc";

// ── Raw GitHub payload shapes (snake_case) → mapped to the public camelCase ──

interface RawReleaseAsset {
  id: number;
  name: string;
  label: string | null;
  content_type: string;
  size: number;
  download_count: number;
  browser_download_url: string;
  created_at: string;
  updated_at: string;
}

interface RawRelease {
  id: number;
  tag_name: string;
  target_commitish: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  html_url: string;
  author: RawUser | null;
  created_at: string;
  published_at: string | null;
  assets?: RawReleaseAsset[];
}

interface RawTag {
  name: string;
  commit?: { sha?: string };
}

function mapRelease(r: RawRelease): ReleaseInfo {
  return {
    id: r.id,
    tagName: r.tag_name,
    targetCommitish: r.target_commitish ?? "",
    // Keep the RAW name ("" for tag-only releases); the view applies the
    // tag fallback only for DISPLAY, so editing never overwrites an empty title.
    name: r.name ?? "",
    body: r.body,
    draft: r.draft,
    prerelease: r.prerelease,
    htmlUrl: r.html_url,
    author: mapUser(r.author),
    createdAt: r.created_at,
    publishedAt: r.published_at,
    assets: (r.assets ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      label: a.label,
      contentType: a.content_type,
      size: a.size,
      downloadCount: a.download_count,
      downloadUrl: a.browser_download_url,
      createdAt: a.created_at,
      updatedAt: a.updated_at,
    })),
  };
}

// ── Reads (THROW on error) ──

/** List the latest 50 releases (newest-first, the GitHub default order). */
export async function listReleases(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<ReleaseInfo[]> {
  const raw = await client.request<RawRelease[]>(
    "GET",
    `/repos/${enc(owner)}/${enc(repo)}/releases?per_page=50`,
  );
  return raw.map(mapRelease);
}

/** Fetch a single release fresh, so its body + assets are complete. */
export async function getRelease(
  client: GitHubClient,
  owner: string,
  repo: string,
  id: number,
): Promise<ReleaseInfo> {
  const raw = await client.request<RawRelease>(
    "GET",
    `/repos/${enc(owner)}/${enc(repo)}/releases/${id}`,
  );
  return mapRelease(raw);
}

/** List every git tag in the repo (raw tags, distinct from releases). */
export async function listTags(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<TagInfo[]> {
  const raw = await client.request<RawTag[]>(
    "GET",
    `/repos/${enc(owner)}/${enc(repo)}/tags?per_page=100`,
  );
  return raw.map((t) => ({ name: t.name, sha: t.commit?.sha ?? "" }));
}

// ── Mutations (return CommitActionResult) ──

/**
 * Draft or publish a release. An empty `targetCommitish` is sent as `undefined`
 * so GitHub uses the repo's default branch rather than erroring on "". If the
 * tag doesn't exist yet, GitHub auto-creates it at the target commitish.
 */
export async function createRelease(
  client: GitHubClient,
  owner: string,
  repo: string,
  input: ReleaseInput,
): Promise<CommitActionResult> {
  try {
    await client.requestBody("POST", `/repos/${enc(owner)}/${enc(repo)}/releases`, {
      tag_name: input.tagName,
      target_commitish: input.targetCommitish || undefined,
      // A new release with no title sensibly defaults to the tag.
      name: input.name || input.tagName,
      body: input.body ?? "",
      draft: input.draft ?? false,
      prerelease: input.prerelease ?? false,
    });
    return { ok: true, changed: true };
  } catch (err) {
    return {
      ok: false,
      changed: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Edit a release (also how a draft is published: send draft:false). */
export async function updateRelease(
  client: GitHubClient,
  owner: string,
  repo: string,
  input: ReleaseInput,
): Promise<CommitActionResult> {
  if (input.id === undefined) {
    return { ok: false, changed: false, message: "Missing release id." };
  }
  try {
    await client.requestBody(
      "PATCH",
      `/repos/${enc(owner)}/${enc(repo)}/releases/${input.id}`,
      {
        tag_name: input.tagName,
        target_commitish: input.targetCommitish || undefined,
        // Send the raw name (incl. "") so an emptied title clears it rather than
        // being silently overwritten with the tag.
        name: input.name ?? "",
        body: input.body ?? "",
        draft: input.draft ?? false,
        prerelease: input.prerelease ?? false,
      },
    );
    return { ok: true, changed: true };
  } catch (err) {
    return {
      ok: false,
      changed: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Delete a release (does NOT delete the underlying git tag — GitHub has no REST
 * endpoint for that here; it's a `git push --delete` operation, out of scope).
 * Uses `request` (no body) since DELETE /releases/{id} returns 204 with no body.
 */
export async function deleteRelease(
  client: GitHubClient,
  owner: string,
  repo: string,
  id: number,
): Promise<CommitActionResult> {
  try {
    await client.request<void>(
      "DELETE",
      `/repos/${enc(owner)}/${enc(repo)}/releases/${id}`,
    );
    return { ok: true, changed: true };
  } catch (err) {
    return {
      ok: false,
      changed: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
