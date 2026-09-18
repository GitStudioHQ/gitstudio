// Browse ANY GitHub repository in-app WITHOUT cloning it — the read side of
// "the native GitHub app". Three read-only REST calls over the contents API:
// a directory listing, a file's text, and the repo README. This is what turns
// an org's repo list from a launcher for github.com into a place you can
// actually LOOK AT code (and then clone, one action later, if it earns it).
//
// All three THROW on API error (clean Error via the client), so the renderer
// paints an errorState + Retry. Notably, a 404 on an ORG repo frequently means
// the org restricts OAuth-app access — the renderer explains that instead of
// showing a bare "Not Found" (the exact "scuffed info" that pushed users back
// to the website).

import { GitHubClient, enc } from "../githubClient";
import { PAGE_CAPS } from "../githubPaging";
import type { GhRepoBranch, GhRepoCommit, GhRepoEntry, GhRepoFile, GhRepoPaths } from "../../shared/ipc";

/** Encode a repo-relative path segment-by-segment (slashes must survive). */
function encPath(path: string): string {
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

/** `?ref=` for a non-default branch/tag/sha, or "" for the default branch. */
function refParam(ref: string | undefined, sep: "?" | "&" = "?"): string {
  return ref ? `${sep}ref=${encodeURIComponent(ref)}` : "";
}

/** Split "owner/repo" for the API path. */
function ownerRepo(fullName: string): string {
  const [owner, repo] = fullName.split("/", 2);
  return `${enc(owner)}/${enc(repo)}`;
}

interface RawContent {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "submodule";
  size?: number;
  content?: string;
  encoding?: string;
}

/** One directory of a remote repo, dirs first then files, both name-sorted. */
export async function listRepoDir(
  client: GitHubClient,
  fullName: string,
  path: string,
  ref?: string,
): Promise<GhRepoEntry[]> {
  const p = encPath(path);
  const raw = await client.request<RawContent[] | RawContent>(
    "GET",
    `/repos/${ownerRepo(fullName)}/contents${p ? `/${p}` : ""}?per_page=1000${refParam(ref, "&")}`,
  );
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .map((e): GhRepoEntry => ({
      name: e.name,
      path: e.path,
      type: e.type === "dir" ? "dir" : "file",
      size: e.size,
    }))
    .sort((a, b) =>
      a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name),
    );
}

/** Cap remote file reads — the contents API base64-inlines up to 1MB anyway,
 *  and a quick look never needs more. */
const MAX_FILE_BYTES = 1024 * 1024;

/** One file's text from a remote repo. Binary and oversized files are flagged
 *  rather than dumped — the viewer shows a notice instead of garbage. */
export async function readRepoFile(
  client: GitHubClient,
  fullName: string,
  path: string,
  ref?: string,
): Promise<GhRepoFile> {
  const raw = await client.request<RawContent>(
    "GET",
    `/repos/${ownerRepo(fullName)}/contents/${encPath(path)}${refParam(ref)}`,
  );
  const size = raw.size ?? 0;
  if (size > MAX_FILE_BYTES || raw.encoding === "none" || !raw.content) {
    return { path, text: "", truncated: true, binary: false, size };
  }
  const buf = Buffer.from(raw.content, "base64");
  // The classic binary sniff: a NUL byte in the first 8KB.
  if (buf.subarray(0, 8192).includes(0)) {
    return { path, text: "", truncated: false, binary: true, size };
  }
  return { path, text: buf.toString("utf8"), truncated: false, binary: false, size };
}

/** The repo's README markdown (GitHub resolves the preferred one), or
 *  undefined when the repo simply has none — that's a state, not an error. */
export async function readRepoReadme(
  client: GitHubClient,
  fullName: string,
  ref?: string,
): Promise<{ name: string; text: string } | undefined> {
  let raw: RawContent;
  try {
    raw = await client.request<RawContent>(
      "GET",
      `/repos/${ownerRepo(fullName)}/readme${refParam(ref)}`,
    );
  } catch {
    return undefined;
  }
  if (!raw.content) {
    return undefined;
  }
  return { name: raw.name, text: Buffer.from(raw.content, "base64").toString("utf8") };
}

// ── Refs + the whole-tree path index ─────────────────────────────────────────

interface RawBranchRef {
  name: string;
  commit?: { sha?: string };
  protected?: boolean;
}

/** The repo's branches — the ref switcher's options. Paged, because a busy
 *  repo has hundreds and a single page would silently show the first 100. */
export async function listRepoBranches(
  client: GitHubClient,
  fullName: string,
): Promise<GhRepoBranch[]> {
  const raw = await client.requestPaged<RawBranchRef>(
    `/repos/${ownerRepo(fullName)}/branches?per_page=100`,
    PAGE_CAPS.detail,
  );
  return raw.map((b) => ({
    name: b.name,
    sha: b.commit?.sha ?? "",
    protected: b.protected ?? false,
  }));
}

interface RawCommit {
  sha?: string;
  commit?: { message?: string; author?: { name?: string; date?: string } };
  author?: { login?: string; avatar_url?: string } | null;
}

/**
 * The commits on a ref, for a repository nobody has cloned.
 *
 * `?sha=<ref>` is the API's spelling of "starting at this ref" — NOT `?ref=`,
 * which this file's other calls use and which the commits endpoint ignores.
 * Only the first page: a browse page is for reading the recent history, and
 * paging the whole log of a large repository over the API is a different
 * feature with a different cost.
 */
export async function listRepoCommits(
  client: GitHubClient,
  fullName: string,
  ref?: string,
): Promise<GhRepoCommit[]> {
  const at = ref ? `&sha=${encodeURIComponent(ref)}` : "";
  const raw = await client.request<RawCommit[]>(
    "GET",
    `/repos/${ownerRepo(fullName)}/commits?per_page=50${at}`,
  );
  return (raw ?? []).map((c) => {
    const sha = c.sha ?? "";
    return {
      sha,
      shortSha: sha.slice(0, 7),
      // The API returns the whole message; a list wants its first line.
      subject: (c.commit?.message ?? "").split("\n", 1)[0] || "(no commit message)",
      author: c.commit?.author?.name ?? c.author?.login ?? "Unknown",
      login: c.author?.login,
      avatarUrl: c.author?.avatar_url,
      date: c.commit?.author?.date,
    };
  });
}

interface RawTree {
  tree?: { path?: string; type?: string; size?: number }[];
  truncated?: boolean;
}

/** Every blob path in the repo, in one request — what makes "go to file"
 *  possible without walking directories.
 *
 *  GitHub itself truncates enormous trees, and we cap on top of that: 25k
 *  paths is far past the point where fuzzy search stays useful, and holding
 *  more in the renderer buys nothing. BOTH truncations are reported, because
 *  a file search that silently can't see a file is worse than one that says so.
 */
export async function listRepoPaths(
  client: GitHubClient,
  fullName: string,
  ref?: string,
): Promise<GhRepoPaths> {
  const target = ref || "HEAD";
  const raw = await client.request<RawTree>(
    "GET",
    `/repos/${ownerRepo(fullName)}/git/trees/${encodeURIComponent(target)}?recursive=1`,
  );
  const all = (raw.tree ?? []).filter((t) => t.type === "blob" && t.path);
  const capped = all.slice(0, MAX_PATHS);
  return {
    paths: capped.map((t) => t.path as string),
    truncated: (raw.truncated ?? false) || all.length > MAX_PATHS,
    total: all.length,
  };
}

/** Past this, fuzzy search is noise and the payload is a liability. */
const MAX_PATHS = 25_000;
