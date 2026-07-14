// Gists — the user-scoped GitHub section (NOT repo-scoped). These standalone
// functions are invoked from main.ts via `github.withClient((c) => gistX(c, …))`,
// so they take only the client (no owner/repo). They hit `/gists` and
// `/gists/{id}` directly, authed as the current user via the Bearer token.
//
// Convention (post-2026-06-27): read functions THROW on API error so the
// renderer can show a real errorState + Retry; mutation functions never throw —
// they return a CommitActionResult ({ ok, changed, message? }) so the view can
// toast the message. `changed` is always false for gist ops (gists touch no
// local git state); on create, `message` carries the new gist id so the caller
// can select it after a refresh.

import { GitHubClient, enc, mapUser, RawUser } from "../githubClient";
import type {
  CommitActionResult,
  GistCreate,
  GistFile,
  GistInfo,
  GistUpdate,
} from "../../shared/ipc";

// ── Raw API shapes (the JSON GitHub returns) ─────────────────────────────────

interface RawGistFile {
  filename?: string;
  language?: string | null;
  type?: string;
  size?: number;
  raw_url?: string;
  content?: string;
  truncated?: boolean;
}

interface RawGist {
  id: string;
  description: string | null;
  public: boolean;
  html_url: string;
  owner?: RawUser | null;
  created_at: string;
  updated_at: string;
  comments?: number;
  files: Record<string, RawGistFile | null>;
}

// ── Mappers (raw → the typed ipc shapes the renderer consumes) ───────────────

function mapGistFile(key: string, f: RawGistFile): GistFile {
  return {
    filename: f.filename ?? key,
    language: f.language ?? "",
    type: f.type ?? "",
    size: f.size ?? 0,
    rawUrl: f.raw_url ?? "",
    content: f.content ?? "",
    truncated: f.truncated ?? false,
  };
}

function mapGist(g: RawGist): GistInfo {
  const files: GistFile[] = Object.entries(g.files ?? {})
    .filter((entry): entry is [string, RawGistFile] => entry[1] != null)
    .map(([key, f]) => mapGistFile(key, f));
  return {
    id: g.id,
    description: g.description ?? "",
    public: g.public,
    htmlUrl: g.html_url,
    owner: mapUser(g.owner ?? null),
    createdAt: g.created_at,
    updatedAt: g.updated_at,
    fileCount: files.length,
    files,
    comments: g.comments ?? 0,
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Reads (throw on error) ───────────────────────────────────────────────────

/** The authenticated user's own gists, newest first (GitHub default: updated desc).
 *  The list payload carries file METADATA only — file `content` is null here, so
 *  the detail view re-fetches the full gist via `getGist`. */
export async function listGists(client: GitHubClient): Promise<GistInfo[]> {
  const raw = await client.request<RawGist[]>("GET", "/gists?per_page=100");
  return raw.map(mapGist);
}

/** A single gist with full file `content` (and `truncated` flags for big files). */
export async function getGist(client: GitHubClient, id: string): Promise<GistInfo> {
  const raw = await client.request<RawGist>("GET", `/gists/${enc(id)}`);
  return mapGist(raw);
}

// ── Mutations (return CommitActionResult; never throw) ───────────────────────

/** Create a single-file gist. On success, `message` carries the new gist id. */
export async function createGist(
  client: GitHubClient,
  input: GistCreate,
): Promise<CommitActionResult> {
  try {
    const created = await client.request<RawGist>("POST", "/gists", {
      description: input.description,
      public: input.public,
      files: { [input.filename]: { content: input.content } },
    });
    return { ok: true, changed: false, message: created.id };
  } catch (err) {
    return { ok: false, changed: false, message: errMessage(err) };
  }
}

/** Edit a gist's description and its (single) file. GitHub keys files by their
 *  CURRENT name; to rename, set `filename` on the value to the new name; to
 *  change content, set `content`. Keep the key = the existing filename. */
export async function updateGist(
  client: GitHubClient,
  input: GistUpdate,
): Promise<CommitActionResult> {
  try {
    const file: { content: string; filename?: string } = { content: input.content };
    if (input.newFilename && input.newFilename !== input.filename) {
      file.filename = input.newFilename;
    }
    await client.request<RawGist>("PATCH", `/gists/${enc(input.id)}`, {
      description: input.description,
      files: { [input.filename]: file },
    });
    return { ok: true, changed: false };
  } catch (err) {
    return { ok: false, changed: false, message: errMessage(err) };
  }
}

/** Permanently delete a gist (204 on success). */
export async function deleteGist(
  client: GitHubClient,
  id: string,
): Promise<CommitActionResult> {
  try {
    await client.request<void>("DELETE", `/gists/${enc(id)}`);
    return { ok: true, changed: false };
  } catch (err) {
    return { ok: false, changed: false, message: errMessage(err) };
  }
}
