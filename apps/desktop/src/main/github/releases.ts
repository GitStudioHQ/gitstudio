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
import { PAGE_CAPS } from "../githubPaging";
import { errorFields } from "../githubErrors";
import type {
  CommitActionResult,
  GeneratedNotes,
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
  const raw = await client.requestPaged<RawRelease>(
    `/repos/${enc(owner)}/${enc(repo)}/releases?per_page=100`,
    PAGE_CAPS.list,
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
 * The REST body for a release, as one pure function.
 *
 * `make_latest` is the reason this is worth extracting: GitHub takes the
 * string "true"/"false", omitting it means "you decide" (it picks by date), and
 * getting that wrong silently moves the repository's Latest badge onto whatever
 * was published most recently — including a back-ported tag. A caller that
 * never asked the question must not answer it.
 */
export function releaseBody(
  input: ReleaseInput,
  o: { forCreate: boolean },
): Record<string, unknown> {
  return {
    tag_name: input.tagName,
    target_commitish: input.targetCommitish || undefined,
    // A NEW release with no title sensibly defaults to the tag; an EDIT sends
    // the raw name (including "") so an emptied title clears it rather than
    // being silently overwritten with the tag.
    name: o.forCreate ? input.name || input.tagName : (input.name ?? ""),
    body: input.body ?? "",
    draft: input.draft ?? false,
    prerelease: input.prerelease ?? false,
    ...(input.makeLatest === undefined
      ? {}
      : { make_latest: input.makeLatest ? "true" : "false" }),
  };
}


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
): Promise<CommitActionResult & { id?: number }> {
  try {
    // `request`, not `requestBody`: the new release's id is how the composer
    // lands on what you just published instead of on a list of everything.
    const created = await client.request<{ id?: number }>(
      "POST",
      `/repos/${enc(owner)}/${enc(repo)}/releases`,
      releaseBody(input, { forCreate: true }),
    );
    return { ok: true, changed: true, id: created?.id };
  } catch (err) {
    return {
      ok: false,
      changed: false,
      ...errorFields(err),
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
      releaseBody(input, { forCreate: false }),
    );
    return { ok: true, changed: true };
  } catch (err) {
    return {
      ok: false,
      changed: false,
      ...errorFields(err),
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
      ...errorFields(err),
    };
  }
}

/** Upload ONE asset's bytes to a release. Mutation-shaped: never throws. */
export async function uploadAssetData(
  client: GitHubClient,
  owner: string,
  repo: string,
  releaseId: number,
  name: string,
  data: Uint8Array,
  contentType: string,
): Promise<CommitActionResult> {
  try {
    await client.uploadReleaseAsset(owner, repo, releaseId, name, data, contentType);
    return { ok: true, changed: false };
  } catch (err) {
    return { ok: false, changed: false, ...errorFields(err) };
  }
}

/** Delete one release asset by id. Mutation-shaped: never throws. */
export async function deleteAsset(
  client: GitHubClient,
  owner: string,
  repo: string,
  assetId: number,
): Promise<CommitActionResult> {
  try {
    await client.request("DELETE", `/repos/${enc(owner)}/${enc(repo)}/releases/assets/${assetId}`);
    return { ok: true, changed: false };
  } catch (err) {
    return { ok: false, changed: false, ...errorFields(err) };
  }
}

/**
 * GitHub's own release notes for a tag — the website's "Generate release
 * notes" button, which reads the pull requests merged since the previous tag.
 *
 * `previous_tag_name` is omitted rather than guessed: GitHub picks the last
 * release itself, and a wrong guess produces a changelog that silently starts
 * in the wrong place.
 */
export async function generateNotes(
  client: GitHubClient,
  owner: string,
  repo: string,
  req: { tagName: string; targetCommitish?: string; previousTagName?: string },
): Promise<GeneratedNotes> {
  // `request`, not `requestBody`: the generated notes ARE the response, and
  // requestBody throws the body away.
  const raw = await client.request<{ name?: string; body?: string }>(
    "POST",
    `/repos/${enc(owner)}/${enc(repo)}/releases/generate-notes`,
    {
      tag_name: req.tagName,
      target_commitish: req.targetCommitish || undefined,
      previous_tag_name: req.previousTagName || undefined,
    },
  );
  return { name: raw?.name ?? "", body: raw?.body ?? "" };
}
