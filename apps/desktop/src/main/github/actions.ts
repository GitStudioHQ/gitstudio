// GitHub Actions section logic for the desktop app — standalone functions over
// the shared `GitHubClient` primitives (`request` / `requestBody`). Repo-scoped:
// every function takes (client, owner, repo, …); main.ts dispatches via
// `github.withRepo((c, o, r) => …)`.
//
// READ functions throw on failure (the renderer wraps them in try/catch →
// errorState + Retry). MUTATION functions never throw — they return a
// CommitActionResult-shaped `{ ok, changed, message }` and the renderer toasts.
// `changed` is always false here: Actions never touch the local working tree
// (unlike pr:checkout / pr:merge), so the commit graph never needs a refresh.
//
// Everything is REST. GitHub exposes NO GraphQL mutations for re-running /
// cancelling / dispatching Actions, and the read surface (runs/jobs/workflows)
// is REST-only — so this module deliberately never touches `graphql()`.

import { access, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { GitHubClient, enc, type TokenGetter } from "../githubClient";
import type {
  ArtifactInfo,
  CommitActionResult,
  RepoSecretInfo,
  RepoVariableInfo,
  WorkflowDispatchInput,
  WorkflowInfo,
  WorkflowJob,
  WorkflowRun,
  WorkflowRunDetail,
} from "../../shared/ipc";

const API_BASE = "https://api.github.com";

// ── Raw GitHub REST shapes (only the fields we map) ──────────────────────────

interface RawRun {
  id: number;
  name?: string;
  display_title?: string;
  status?: string;
  conclusion?: string;
  head_branch?: string;
  event?: string;
  created_at?: string;
  html_url?: string;
}
interface RawStep {
  name?: string;
  status?: string;
  conclusion?: string;
  number?: number;
}
interface RawJob {
  id: number;
  name?: string;
  status?: string;
  conclusion?: string;
  html_url?: string;
  started_at?: string;
  completed_at?: string;
  steps?: RawStep[];
}
interface RawWorkflow {
  id: number;
  name?: string;
  path?: string;
  state?: string;
  html_url?: string;
}
interface RawArtifact {
  id: number;
  name?: string;
  size_in_bytes?: number;
  expired?: boolean;
  created_at?: string;
}
interface RawSecret {
  name?: string;
  updated_at?: string;
}
interface RawVariable {
  name?: string;
  value?: string;
  updated_at?: string;
}

// ── Mappers (Raw* → public ipc types) ────────────────────────────────────────

function mapRun(r: RawRun): WorkflowRun {
  return {
    id: r.id,
    name: r.name ?? r.display_title ?? "(run)",
    status: r.status ?? "",
    conclusion: r.conclusion ?? "",
    branch: r.head_branch ?? "",
    event: r.event ?? "",
    createdAt: r.created_at ?? "",
    htmlUrl: r.html_url ?? "",
  };
}
function mapJob(j: RawJob): WorkflowJob {
  return {
    id: j.id,
    name: j.name ?? "(job)",
    status: j.status ?? "",
    conclusion: j.conclusion ?? "",
    htmlUrl: j.html_url ?? "",
    startedAt: j.started_at ?? "",
    completedAt: j.completed_at ?? "",
    steps: (j.steps ?? []).map((s) => ({
      name: s.name ?? "",
      status: s.status ?? "",
      conclusion: s.conclusion ?? "",
      number: s.number ?? 0,
    })),
  };
}
function mapWorkflow(w: RawWorkflow): WorkflowInfo {
  return {
    id: w.id,
    name: w.name ?? w.path ?? "(workflow)",
    path: w.path ?? "",
    state: w.state ?? "",
    htmlUrl: w.html_url ?? "",
  };
}
function mapArtifact(a: RawArtifact): ArtifactInfo {
  return {
    id: a.id,
    name: a.name ?? "(artifact)",
    sizeBytes: a.size_in_bytes ?? 0,
    expired: a.expired ?? false,
    createdAt: a.created_at ?? "",
  };
}
function mapSecret(s: RawSecret): RepoSecretInfo {
  return { name: s.name ?? "", updatedAt: s.updated_at ?? "" };
}
function mapVariable(v: RawVariable): RepoVariableInfo {
  return { name: v.name ?? "", value: v.value ?? "", updatedAt: v.updated_at ?? "" };
}

// ── Authed raw fetch (text / binary, following GitHub's signed redirect) ──────
//
// Logs and artifact zips are NOT JSON: GitHub answers `…/logs` and
// `…/artifacts/{id}/zip` with a 302 to a short-lived signed blob URL (S3 / Azure)
// that must be fetched WITHOUT our `Authorization` header — forwarding the Bearer
// to the blob store is rejected. The shared client only does JSON, so this module
// fetches these two endpoints itself. We read the bearer off the client (its
// constructor stores `getToken`), then fetch with `redirect: "manual"` to capture
// the `Location` and GET it bare. (If GitHub answers 200 directly — no redirect —
// we use that body.) Self-contained; the client and bridge are untouched.

/** Read the bearer token the client was constructed with, or throw (mirrors the
 *  client's own "Not connected to GitHub." guard). The token lives in a private
 *  closure field; we reach it through a typed view rather than widening to `any`. */
function bearer(client: GitHubClient): string {
  const token = (client as unknown as { getToken: TokenGetter }).getToken();
  if (!token) throw new Error("Not connected to GitHub.");
  return token;
}

/** Common headers for the authed first hop to api.github.com. */
function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "GitStudio",
  };
}

/** Turn a non-2xx GitHub response into a clean Error (parallels the client). */
async function rawError(res: Response): Promise<Error> {
  let detail = "";
  try {
    detail = ((await res.json()) as { message?: string })?.message ?? "";
  } catch {
    /* non-JSON body */
  }
  if (res.status === 401) return new Error("Your GitHub token is invalid or expired.");
  if (res.status === 403) return new Error(detail || "GitHub denied the request (permissions or rate limit).");
  if (res.status === 404) return new Error(detail || "Not found on GitHub.");
  return new Error(detail || `GitHub request failed (HTTP ${res.status}).`);
}

/**
 * GET a redirecting GitHub endpoint and return the final `Response`. Hits the API
 * with `redirect: "manual"`; on a 3xx, re-GETs the `Location` with NO auth header
 * (the signed URL needs none, and GitHub rejects a forwarded Bearer). A direct 2xx
 * is returned as-is. Throws a clean Error on any non-OK status.
 */
async function fetchSignedRedirect(token: string, path: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { headers: ghHeaders(token), redirect: "manual" });
  } catch {
    throw new Error("Couldn't reach GitHub. Check your network connection.");
  }
  // undici surfaces the real 3xx (not an opaque response) with a readable Location.
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location");
    if (!loc) throw new Error("GitHub returned a redirect with no location.");
    try {
      res = await fetch(loc);
    } catch {
      throw new Error("Couldn't download from GitHub's storage. Check your network connection.");
    }
  }
  if (!res.ok) throw await rawError(res);
  return res;
}

// ── Reads (throw on API error) ───────────────────────────────────────────────

/** Recent workflow runs for the repo (capped at 30, newest first). */
export async function listRuns(client: GitHubClient, owner: string, repo: string): Promise<WorkflowRun[]> {
  const raw = await client.request<{ workflow_runs?: RawRun[] }>(
    "GET",
    `/repos/${enc(owner)}/${enc(repo)}/actions/runs?per_page=30`,
  );
  return (raw.workflow_runs ?? []).map(mapRun);
}

/** A single run plus its jobs (GET /actions/runs/{id} + /jobs), for the detail pane. */
export async function getRunDetail(
  client: GitHubClient,
  owner: string,
  repo: string,
  id: number,
): Promise<WorkflowRunDetail> {
  const run = await client.request<RawRun>(
    "GET",
    `/repos/${enc(owner)}/${enc(repo)}/actions/runs/${id}`,
  );
  const jobsRaw = await client.request<{ jobs?: RawJob[] }>(
    "GET",
    `/repos/${enc(owner)}/${enc(repo)}/actions/runs/${id}/jobs?per_page=100`,
  );
  return { run: mapRun(run), jobs: (jobsRaw.jobs ?? []).map(mapJob) };
}

/** All workflows declared in this repo (GET /actions/workflows). */
export async function listWorkflows(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<WorkflowInfo[]> {
  const raw = await client.request<{ workflows?: RawWorkflow[] }>(
    "GET",
    `/repos/${enc(owner)}/${enc(repo)}/actions/workflows?per_page=100`,
  );
  return (raw.workflows ?? []).map(mapWorkflow);
}

/**
 * Parse a workflow's `on.workflow_dispatch.inputs` so the renderer can build a
 * real dispatch form. GitHub's REST API exposes inputs NOWHERE, so we read the
 * workflow YAML: GET the workflow (to learn its `path`) → GET `/contents/{path}`
 * (base64 YAML) → `parseDispatchInputs`. Best-effort and dependency-free (the
 * repo bundles no YAML lib); returns [] when there are no inputs — which is
 * still valid, the form just shows the ref field.
 */
export async function getDispatchInputs(
  client: GitHubClient,
  owner: string,
  repo: string,
  id: number,
): Promise<WorkflowDispatchInput[]> {
  const wf = await client.request<RawWorkflow>(
    "GET",
    `/repos/${enc(owner)}/${enc(repo)}/actions/workflows/${id}`,
  );
  if (!wf.path) return [];
  const file = await client.request<{ content?: string; encoding?: string }>(
    "GET",
    `/repos/${enc(owner)}/${enc(repo)}/contents/${wf.path.split("/").map(enc).join("/")}`,
  );
  if (!file.content) return [];
  const encoding: BufferEncoding = file.encoding === "base64" || !file.encoding ? "base64" : "utf8";
  const yaml = Buffer.from(file.content, encoding).toString("utf8");
  return parseDispatchInputs(yaml);
}

/**
 * Plain-text logs for ONE job (GET /actions/jobs/{jobId}/logs). GitHub 302s to a
 * signed text URL; `fetchSignedRedirect` follows it and we return the body. The
 * renderer drops the text into an in-app `<pre>` viewer (no more github.com).
 */
export async function jobLog(
  client: GitHubClient,
  owner: string,
  repo: string,
  req: { jobId: number },
): Promise<string> {
  const res = await fetchSignedRedirect(
    bearer(client),
    `/repos/${enc(owner)}/${enc(repo)}/actions/jobs/${req.jobId}/logs`,
  );
  return res.text();
}

/**
 * Plain-text logs for a WHOLE run, assembled from its jobs. The native
 * `…/runs/{id}/logs` endpoint returns a ZIP (heavy + needs unzip in-process);
 * instead we fetch the run's jobs and concatenate each job's `jobLog` under a
 * `=== job name ===` banner — the same text, streamable straight into the viewer.
 * One job's failure is annotated inline rather than failing the whole aggregate.
 */
export async function runLog(
  client: GitHubClient,
  owner: string,
  repo: string,
  req: { runId: number },
): Promise<string> {
  const jobsRaw = await client.request<{ jobs?: RawJob[] }>(
    "GET",
    `/repos/${enc(owner)}/${enc(repo)}/actions/runs/${req.runId}/jobs?per_page=100`,
  );
  const jobs = jobsRaw.jobs ?? [];
  if (jobs.length === 0) return "This run reported no jobs.";
  const parts: string[] = [];
  for (const j of jobs) {
    const name = j.name ?? `job ${j.id}`;
    parts.push(`=== ${name} ===`);
    try {
      parts.push((await jobLog(client, owner, repo, { jobId: j.id })).trimEnd());
    } catch (err) {
      parts.push(`[logs unavailable: ${err instanceof Error ? err.message : String(err)}]`);
    }
    parts.push(""); // blank line between jobs
  }
  return parts.join("\n");
}

/** Artifacts produced by a run (GET /actions/runs/{id}/artifacts). */
export async function artifacts(
  client: GitHubClient,
  owner: string,
  repo: string,
  runId: number,
): Promise<ArtifactInfo[]> {
  const raw = await client.request<{ artifacts?: RawArtifact[] }>(
    "GET",
    `/repos/${enc(owner)}/${enc(repo)}/actions/runs/${runId}/artifacts?per_page=100`,
  );
  return (raw.artifacts ?? []).map(mapArtifact);
}

/** All repo Actions secrets — names + updatedAt only (values are write-only). */
export async function secrets(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<RepoSecretInfo[]> {
  const raw = await client.request<{ secrets?: RawSecret[] }>(
    "GET",
    `/repos/${enc(owner)}/${enc(repo)}/actions/secrets?per_page=100`,
  );
  return (raw.secrets ?? []).map(mapSecret);
}

/** All repo Actions variables — name, value, updatedAt (values ARE readable). */
export async function variables(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<RepoVariableInfo[]> {
  const raw = await client.request<{ variables?: RawVariable[] }>(
    "GET",
    `/repos/${enc(owner)}/${enc(repo)}/actions/variables?per_page=100`,
  );
  return (raw.variables ?? []).map(mapVariable);
}

// ── Mutations (never throw — return CommitActionResult) ──────────────────────

const ok = (msg?: string): CommitActionResult => ({ ok: true, changed: false, message: msg });
const fail = (err: unknown): CommitActionResult => ({
  ok: false,
  changed: false,
  message: err instanceof Error ? err.message : String(err),
});

/** Re-run every job in a run (POST /actions/runs/{id}/rerun). */
export async function rerunRun(
  client: GitHubClient,
  owner: string,
  repo: string,
  id: number,
): Promise<CommitActionResult> {
  try {
    await client.requestBody("POST", `/repos/${enc(owner)}/${enc(repo)}/actions/runs/${id}/rerun`, {});
    return ok();
  } catch (err) {
    return fail(err);
  }
}

/** Re-run only the failed jobs (POST /actions/runs/{id}/rerun-failed-jobs). */
export async function rerunFailedJobs(
  client: GitHubClient,
  owner: string,
  repo: string,
  id: number,
): Promise<CommitActionResult> {
  try {
    await client.requestBody(
      "POST",
      `/repos/${enc(owner)}/${enc(repo)}/actions/runs/${id}/rerun-failed-jobs`,
      {},
    );
    return ok();
  } catch (err) {
    return fail(err);
  }
}

/** Cancel an in-progress run (POST /actions/runs/{id}/cancel). */
export async function cancelRun(
  client: GitHubClient,
  owner: string,
  repo: string,
  id: number,
): Promise<CommitActionResult> {
  try {
    await client.requestBody("POST", `/repos/${enc(owner)}/${enc(repo)}/actions/runs/${id}/cancel`, {});
    return ok();
  } catch (err) {
    return fail(err);
  }
}

/**
 * Manually trigger a `workflow_dispatch` (POST /actions/workflows/{id}/dispatches).
 * GitHub requires every input value to be a STRING in the payload (even
 * booleans/numbers); the renderer already collects strings and omits empties so
 * the workflow's declared defaults apply server-side. Returns 204 No Content on
 * success — `requestBody` treats any 2xx as success.
 */
export async function dispatchWorkflow(
  client: GitHubClient,
  owner: string,
  repo: string,
  req: { workflowId: number; ref: string; inputs: Record<string, string> },
): Promise<CommitActionResult> {
  try {
    const body: { ref: string; inputs?: Record<string, string> } = { ref: req.ref };
    if (req.inputs && Object.keys(req.inputs).length) body.inputs = req.inputs;
    await client.requestBody(
      "POST",
      `/repos/${enc(owner)}/${enc(repo)}/actions/workflows/${req.workflowId}/dispatches`,
      body,
    );
    return ok();
  } catch (err) {
    return fail(err);
  }
}

/**
 * Download a run artifact's ZIP to the user's Downloads folder
 * (GET /actions/artifacts/{id}/zip → signed redirect → bytes → ~/Downloads).
 * Returns ok with the saved absolute path so the renderer can toast it. The
 * filename is sanitized and `.zip`-suffixed; we never overwrite blindly — a
 * collision gets a `(1)`, `(2)`… suffix. Expired artifacts 410 → clean message.
 */
export async function downloadArtifact(
  client: GitHubClient,
  owner: string,
  repo: string,
  req: { id: number; name: string },
): Promise<CommitActionResult> {
  try {
    const res = await fetchSignedRedirect(
      bearer(client),
      `/repos/${enc(owner)}/${enc(repo)}/actions/artifacts/${req.id}/zip`,
    );
    const bytes = Buffer.from(await res.arrayBuffer());
    const dest = await uniqueDownloadPath(safeFileName(req.name) + ".zip");
    await writeFile(dest, bytes);
    return ok(`Saved to ${dest}`);
  } catch (err) {
    return fail(err);
  }
}

/**
 * Create or update a repo Actions secret. Encrypting the value needs a libsodium
 * sealed box against the repo's public key — and this app bundles NO crypto
 * dependency (no libsodium-wrappers / tweetnacl), so we cannot encrypt safely.
 * Rather than ship a broken write, we return a clear, actionable message. Listing
 * + delete (and ALL of variables) work without crypto and are fully implemented.
 */
export async function setSecret(
  _client: GitHubClient,
  _owner: string,
  _repo: string,
  _req: { name: string; value: string },
): Promise<CommitActionResult> {
  return {
    ok: false,
    changed: false,
    message:
      "Creating or updating secrets needs the libsodium encryption library, which isn't bundled in this build. You can still delete secrets here; to add one, use github.com for now.",
  };
}

/** Delete a repo Actions secret (DELETE /actions/secrets/{name}). */
export async function deleteSecret(
  client: GitHubClient,
  owner: string,
  repo: string,
  name: string,
): Promise<CommitActionResult> {
  try {
    await client.requestBody(
      "DELETE",
      `/repos/${enc(owner)}/${enc(repo)}/actions/secrets/${enc(name)}`,
      {},
    );
    return ok();
  } catch (err) {
    return fail(err);
  }
}

/**
 * Create or update a repo Actions variable. Variables are plaintext (no crypto),
 * so this works fully. GitHub has no upsert: PATCH the existing variable, and on
 * a 404 (it doesn't exist yet) fall back to POST to create it.
 */
export async function setVariable(
  client: GitHubClient,
  owner: string,
  repo: string,
  req: { name: string; value: string },
): Promise<CommitActionResult> {
  const base = `/repos/${enc(owner)}/${enc(repo)}/actions/variables`;
  try {
    await client.requestBody("PATCH", `${base}/${enc(req.name)}`, {
      name: req.name,
      value: req.value,
    });
    return ok();
  } catch (err) {
    if (!isNotFound(err)) return fail(err);
    // Doesn't exist yet → create it.
    try {
      await client.requestBody("POST", base, { name: req.name, value: req.value });
      return ok();
    } catch (createErr) {
      return fail(createErr);
    }
  }
}

/** Delete a repo Actions variable (DELETE /actions/variables/{name}). */
export async function deleteVariable(
  client: GitHubClient,
  owner: string,
  repo: string,
  name: string,
): Promise<CommitActionResult> {
  try {
    await client.requestBody(
      "DELETE",
      `/repos/${enc(owner)}/${enc(repo)}/actions/variables/${enc(name)}`,
      {},
    );
    return ok();
  } catch (err) {
    return fail(err);
  }
}

// ── Download helpers ─────────────────────────────────────────────────────────

/** The client's 404 maps to "Not found on GitHub." — detect it to drive the
 *  variable PATCH→POST upsert without a second HEAD round-trip. */
function isNotFound(err: unknown): boolean {
  return err instanceof Error && /not found on github/i.test(err.message);
}

/** Sanitize an artifact name into a single safe path segment (no separators,
 *  control chars, or leading dots), so the save path can't escape Downloads. */
function safeFileName(name: string): string {
  const cleaned = (name || "artifact")
    .replace(/[/\\:*?"<>| -]+/g, "_")
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "")
    .slice(0, 200)
    .trim();
  return cleaned || "artifact";
}

/** A non-clobbering path in ~/Downloads: "name.zip", then "name (1).zip", … */
async function uniqueDownloadPath(fileName: string): Promise<string> {
  const dir = join(homedir(), "Downloads");
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : "";
  for (let i = 0; i < 1000; i++) {
    const candidate = join(dir, i === 0 ? fileName : `${stem} (${i})${ext}`);
    if (!(await pathExists(candidate))) return candidate;
  }
  // Astronomically unlikely; fall back to a timestamped name.
  return join(dir, `${stem}-${Date.now()}${ext}`);
}

/** True when a file/dir exists at `p` (no throw). */
async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// ── Minimal YAML reader for `on.workflow_dispatch.inputs:` ────────────────────

/**
 * A deliberately small indent-walking parser — enough to drive the dispatch
 * form, no external YAML dependency. Handles scalar inputs plus `required`,
 * `default`, `description`, `type`, and `type: choice` with an `options:` list.
 * Returns [] for the list form `on: [workflow_dispatch]` and when there are no
 * inputs. Best-effort: if it yields nothing the form still shows the ref field,
 * which is a valid dispatch (POST accepts `{ ref }` with no inputs).
 */
function parseDispatchInputs(yaml: string): WorkflowDispatchInput[] {
  const lines = yaml.split(/\r?\n/);
  const indentOf = (s: string): number => s.length - s.replace(/^\s+/, "").length;

  // Find `workflow_dispatch:` then its `inputs:` child.
  let i = lines.findIndex((l) => /^\s*workflow_dispatch\s*:/.test(l));
  if (i < 0) return [];
  const wdIndent = indentOf(lines[i]);
  let inputsIndent = -1;
  i += 1;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "" || l.trim().startsWith("#")) continue;
    const ind = indentOf(l);
    if (ind <= wdIndent) return []; // left the workflow_dispatch block — no inputs
    if (/^\s*inputs\s*:/.test(l)) {
      inputsIndent = ind;
      i += 1;
      break;
    }
  }
  if (inputsIndent < 0) return [];

  const out: WorkflowDispatchInput[] = [];
  let cur: WorkflowDispatchInput | undefined;
  let inOptions = false;
  // The column of the first real input key; once locked, only keys at exactly
  // this indent start a new input — so child props (options:, description:, …)
  // at a deeper indent are never misread as inputs.
  let keyIndent = -1;
  for (; i < lines.length; i++) {
    const rawLine = lines[i];
    if (rawLine.trim() === "" || rawLine.trim().startsWith("#")) continue;
    const ind = indentOf(rawLine);
    if (ind <= inputsIndent) break; // dedented out of `inputs:`
    const line = rawLine.trim();

    // A new input key sits one level under `inputs:`.
    const keyM = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*$/);
    const isNewKey =
      !!keyM &&
      !line.startsWith("-") &&
      (keyIndent < 0 ? ind <= inputsIndent + 4 : ind === keyIndent);
    if (isNewKey && keyM) {
      if (keyIndent < 0) keyIndent = ind;
      cur = { name: keyM[1], description: "", required: false, default: "", type: "string" };
      out.push(cur);
      inOptions = false;
      continue;
    }
    if (!cur) continue;

    if (inOptions) {
      const optM = line.match(/^-\s*(.+)$/);
      if (optM) {
        (cur.options ??= []).push(stripYamlScalar(optM[1]));
        continue;
      }
      inOptions = false;
    }

    const kv = line.match(/^(description|required|default|type|options)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2].trim();
    if (key === "options") {
      inOptions = true;
      cur.options = [];
    } else if (key === "required") {
      cur.required = /^true$/i.test(stripYamlScalar(value));
    } else if (key === "type") {
      cur.type = stripYamlScalar(value) || "string";
    } else if (key === "default") {
      cur.default = stripYamlScalar(value);
    } else if (key === "description") {
      cur.description = stripYamlScalar(value);
    }
  }
  return out;
}

/** Strip surrounding single/double quotes from a YAML scalar. */
function stripYamlScalar(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}
