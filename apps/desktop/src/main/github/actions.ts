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

import { GitHubClient, enc } from "../githubClient";
import type {
  CommitActionResult,
  WorkflowDispatchInput,
  WorkflowInfo,
  WorkflowJob,
  WorkflowRun,
  WorkflowRunDetail,
} from "../../shared/ipc";

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

// ── Mutations (never throw — return CommitActionResult) ──────────────────────

const ok = (): CommitActionResult => ({ ok: true, changed: false });
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
