// The Actions section view — GitHub Actions runs, jobs/steps, workflows, and a
// manual `workflow_dispatch` flow. Repo-scoped (NEEDS_REPO=true). Renders the
// same two-pane shell as Pull Requests / Issues: a runs list on the left, a
// detail pane on the right (run → jobs → steps, or the workflows list, or the
// dispatch form). Reuses every shared primitive; adds no new modal API — the
// dispatch form renders INTO the detail pane (dialogs.ts's promptInline is
// single-field only).
//
// Re-render contract: the view re-renders itself by calling `renderActions`.
// READ invokes are wrapped in try/catch → errorState + Retry; MUTATION invokes
// return `{ ok, message }` and toast.

import { host } from "../bridge";
import {
  el,
  span,
  glyph,
  pill,
  relTimeISO,
  absTimeISO,
  loadingState,
  skeletonList,
  errorState,
  emptyState,
  cleanErr,
  copyText,
  formatBytes,
  openMenu,
  ghRow,
  statBit,
} from "../ui";
import { toast, confirmDialog, promptInline } from "../dialogs";
import {
  comboField,
  ghGate,
  ghHeader,
  ghListResizer,
  searchField,
  trapTab,
  type SectionRender,
} from "./common";
import type {
  ArtifactInfo,
  RepoSecretInfo,
  RepoVariableInfo,
  WorkflowRun,
  WorkflowRunDetail,
  WorkflowJob,
  WorkflowInfo,
  WorkflowDispatchInput,
} from "../../shared/ipc";

// Statuses for which Cancel is meaningful (the run is still live).
const LIVE_STATUSES = new Set(["in_progress", "queued", "requested", "waiting", "pending"]);
const isLive = (status: string): boolean => LIVE_STATUSES.has(status);

/** `el("button", …)` typed as a button so `.disabled` is available. */
const btn = (className = ""): HTMLButtonElement =>
  el("button", className) as HTMLButtonElement;

const emptyDetail = (detail: HTMLElement): void => {
  detail.replaceChildren(
    emptyState(
      "Workflow runs",
      "Select a run to inspect its jobs, steps, and status — or re-run, cancel, and open it on GitHub.",
      { icon: "play", hint: "Tip: use “Run workflow” to dispatch one manually." },
    ),
  );
};

export const renderActions: SectionRender = (wrap, nav): void => {
  void mount(wrap, nav);
};

async function mount(wrap: HTMLElement, nav: (view: string) => void): Promise<void> {
  const refresh = (): void => renderActions(wrap, nav);

  const gate = await ghGate(wrap, nav, true);
  if (!gate) return;

  const view = el("div", "gh-view");
  const header = ghHeader("Actions", gate.login, refresh);

  // Toolbar: "Workflows" (list) + "Run workflow" (dispatch). Slotted to the left
  // of the account cluster so it reads right-to-left: tools · @login · refresh.
  const tools = el("div", "gh-head-tools");
  const wfBtn = el("button", "mini-btn");
  wfBtn.append(glyph("list-unordered"), span("Workflows"));
  wfBtn.title = "List this repo's workflows";
  const secretsBtn = el("button", "mini-btn");
  secretsBtn.append(glyph("lock"), span("Secrets"));
  secretsBtn.title = "Manage this repo's Actions secrets and variables";
  const runBtn = el("button", "btn btn-primary gh-run-btn");
  runBtn.append(glyph("play"), span("Run workflow"));
  runBtn.title = "Manually trigger a workflow_dispatch";
  tools.append(wfBtn, secretsBtn, runBtn);
  header.insertBefore(tools, header.querySelector(".gh-acct"));

  const body = el("div", "gh-body");
  const listEl = el("div", "gh-list");
  const detail = el("div", "gh-detail");
  body.append(listEl, ghListResizer(listEl), detail);
  view.append(header, body);
  wrap.replaceChildren(view);
  emptyDetail(detail);

  wfBtn.addEventListener("click", () => void showWorkflowsList(detail));
  secretsBtn.addEventListener("click", () => openSecretsManager());
  runBtn.addEventListener("click", () => void openDispatch(view, detail));

  // ── Runs list ──
  listEl.replaceChildren(skeletonList(5));
  let runs: WorkflowRun[];
  try {
    runs = await host.invoke("actions:runs", undefined);
  } catch (e) {
    listEl.replaceChildren(
      errorState("Couldn't load workflow runs", cleanErr(e) || "GitHub request failed.", refresh),
    );
    return;
  }
  header.setCount?.(runs.length);
  listEl.replaceChildren();
  if (runs.length === 0) {
    listEl.appendChild(
      emptyState("No workflow runs", "No GitHub Actions runs found for this repository.", {
        icon: "play",
        action: {
          label: "Run workflow",
          icon: "play",
          onClick: () => void openDispatch(view, detail),
        },
      }),
    );
    return;
  }

  const select = (r: WorkflowRun, row: HTMLElement): void => {
    listEl.querySelectorAll(".gh-row.active").forEach((n) => n.classList.remove("active"));
    row.classList.add("active");
    void showRunDetail(detail, r);
  };

  const buildRow = (r: WorkflowRun): HTMLElement => {
    const row = runRow(r);
    row.addEventListener("click", () => select(r, row));
    return row;
  };

  // Case-insensitive match over the fields a user would search by.
  const matches = (r: WorkflowRun, q: string): boolean => {
    const hay = `${r.name} ${r.branch} ${r.event} #${r.id}`.toLowerCase();
    return hay.includes(q);
  };

  let autoSelected = false;
  const renderList = (items: WorkflowRun[], q = ""): void => {
    listEl.replaceChildren();
    if (items.length === 0) {
      listEl.appendChild(
        emptyState("No matching runs", `Nothing matches “${q}”.`, { icon: "search" }),
      );
      return;
    }
    for (const r of items) listEl.appendChild(buildRow(r));
    // Auto-select the first run once (initial render) so the jobs panel shows;
    // don't hijack the selection on every keystroke while filtering.
    if (!autoSelected) {
      autoSelected = true;
      const first = items[0];
      const firstRow = listEl.firstElementChild as HTMLElement | null;
      if (first && firstRow) select(first, firstRow);
    }
  };

  // A header search/filter — on the LEFT, next to the title (client-side, instant).
  header.querySelector(".gh-head-titlewrap")?.appendChild(
    searchField({
      placeholder: "Search runs…",
      onInput: (q) => renderList(q ? runs.filter((r) => matches(r, q.toLowerCase())) : runs, q),
    }),
  );

  renderList(runs);
}

/** One rich run row: a colored status lead icon, the run name + #id, then a
 *  muted branch · event · when line. */
function runRow(r: WorkflowRun): HTMLElement {
  const state = r.conclusion || r.status || "";
  const when = relTimeISO(r.createdAt);
  const meta = [r.branch, r.event].filter(Boolean).join(" · ") + (when ? ` · ${when}` : "");
  return ghRow({
    lead: runLead(state),
    title: `${r.name} #${r.id}`,
    stats: [statBit("", prettyState(state) || "—")],
    meta,
    metaTitle: r.createdAt ? `Created ${absTimeISO(r.createdAt)}` : undefined,
    ariaLabel: `Workflow run ${r.name} #${r.id}: ${prettyState(state) || "unknown"}`,
  });
}

/** A colored leading status icon for a run, keyed off its conclusion/status. */
function runLead(state: string): HTMLElement {
  let icon = "sync";
  let color = "var(--status-mod)"; // in_progress / queued / pending → blue/amber
  if (state === "success") {
    icon = "pass-filled";
    color = "var(--status-add)";
  } else if (
    state === "failure" ||
    state === "error" ||
    state === "cancelled" ||
    state === "timed_out" ||
    state === "startup_failure" ||
    state === "action_required" ||
    state === "stale"
  ) {
    icon = "error";
    color = "var(--status-del)";
  } else if (state === "skipped" || state === "neutral") {
    icon = "circle-slash";
    color = "var(--app-muted)";
  }
  const s = el("span", "gh-lead-icon");
  s.style.color = color;
  s.appendChild(glyph(icon));
  return s;
}

// ── Run detail ────────────────────────────────────────────────────────────────

async function showRunDetail(detail: HTMLElement, run: WorkflowRun): Promise<void> {
  detail.replaceChildren(loadingState());
  let d: WorkflowRunDetail | undefined;
  try {
    d = await host.invoke("actions:runDetail", run.id);
  } catch (e) {
    detail.replaceChildren(
      errorState("Couldn't load the run", cleanErr(e) || "GitHub request failed.", () =>
        void showRunDetail(detail, run),
      ),
    );
    return;
  }
  const full = d?.run ?? run;
  const state = full.conclusion || full.status || "";
  const live = isLive(full.status);
  detail.replaceChildren();

  const head = el("div", "gh-detail-head");
  const h = el("div", "gh-detail-title");
  h.textContent = full.name;
  const meta = el("div", "gh-detail-meta");
  const when = relTimeISO(full.createdAt);
  const metaParts = [`#${full.id}`, full.branch, full.event].filter(Boolean);
  if (when) metaParts.push(when);
  const metaText = el("span", "gh-meta-text");
  metaText.textContent = metaParts.join(" · ") + " · ";
  meta.appendChild(metaText);
  const statePill = pill(prettyState(state) || "—");
  statePill.classList.add(`gh-checks-${state}`);
  meta.appendChild(statePill);

  const actions = el("div", "gh-detail-actions");

  const rerunBtn = btn("mini-btn");
  rerunBtn.append(glyph("refresh"), span("Re-run"));
  rerunBtn.title = "Re-run all jobs in this run";
  rerunBtn.disabled = live;
  rerunBtn.addEventListener("click", () => void rerunRun(full.id, rerunBtn, detail, run));

  const rerunFailedBtn = btn("mini-btn");
  rerunFailedBtn.append(glyph("debug-restart"), span("Re-run failed"));
  rerunFailedBtn.title = "Re-run only the failed jobs";
  rerunFailedBtn.disabled = full.conclusion === "success" || live;
  rerunFailedBtn.addEventListener("click", () => void rerunFailed(full.id, rerunFailedBtn, detail, run));

  const cancelBtn = btn("mini-btn danger");
  cancelBtn.append(glyph("circle-slash"), span("Cancel"));
  cancelBtn.title = "Cancel this in-progress run";
  cancelBtn.disabled = !live;
  cancelBtn.addEventListener("click", () => void cancelRun(full.id, cancelBtn, detail, run));

  // In-app logs: stream the whole run's aggregated logs into a viewer overlay —
  // no browser hop. github.com stays reachable as a secondary link in the viewer.
  const logsBtn = btn("mini-btn");
  logsBtn.append(glyph("output"), span("View logs"));
  logsBtn.title = "View this run's logs in-app";
  logsBtn.addEventListener("click", () =>
    openLogViewer({
      title: `Logs · ${full.name} #${full.id}`,
      htmlUrl: full.htmlUrl,
      load: () => host.invoke("actions:runLog", { runId: full.id }),
    }),
  );

  actions.append(rerunBtn, rerunFailedBtn, cancelBtn, logsBtn);
  head.append(h, meta, actions);
  detail.appendChild(head);

  const jobs = d?.jobs ?? [];
  if (jobs.length === 0) {
    detail.appendChild(emptyState("No jobs", "This run reported no jobs yet."));
  } else {
    const jobsWrap = el("div", "gh-jobs");
    for (const j of jobs) jobsWrap.appendChild(jobCard(j));
    detail.appendChild(jobsWrap);
  }

  // Artifacts produced by this run — listed below the jobs, lazily loaded.
  void showArtifacts(detail, full.id);
}

/** One expandable job card: header row (dot + name + state + Logs) + its steps. */
function jobCard(j: WorkflowJob): HTMLElement {
  const card = el("div", "gh-job");
  const state = j.conclusion || j.status || "";
  const head = el("button", "gh-job-head");
  const chevron = glyph("chevron-right");
  chevron.classList.add("gh-job-chevron");
  const dot = el("span", `gh-check-dot gh-checks-${state}`);
  const name = el("span", "gh-check-name");
  name.textContent = j.name;
  const st = el("span", "gh-check-state");
  st.textContent = prettyState(state);
  head.append(chevron, dot, name, st);

  const steps = el("div", "gh-job-steps hidden");
  if (j.steps.length === 0) {
    const none = el("div", "gh-step-row gh-step-empty");
    none.textContent = "No steps reported.";
    steps.appendChild(none);
  }
  for (const s of j.steps) {
    const row = el("div", "gh-step-row");
    const sState = s.conclusion || s.status || "";
    const sdot = el("span", `gh-check-dot gh-checks-${sState}`);
    const sname = el("span", "gh-check-name");
    sname.textContent = s.name || "(step)";
    const sst = el("span", "gh-check-state");
    sst.textContent = prettyState(sState);
    row.append(sdot, sname, sst);
    steps.appendChild(row);
  }

  head.addEventListener("click", () => {
    const nowHidden = steps.classList.toggle("hidden");
    head.classList.toggle("open", !nowHidden);
  });

  const log = el("button", "row-btn gh-job-log");
  log.textContent = "Logs";
  log.title = "View this job's logs in-app";
  log.addEventListener("click", (e) => {
    e.stopPropagation();
    openLogViewer({
      title: `Logs · ${j.name}`,
      htmlUrl: j.htmlUrl,
      load: () => host.invoke("actions:jobLog", { jobId: j.id }),
    });
  });
  head.appendChild(log);
  card.append(head, steps);
  return card;
}

// ── In-app log viewer (overlay; reused for run + job logs) ─────────────────────

/**
 * A scrollable, terminal-styled log overlay. Fetches the text lazily (run or job)
 * with a loading/error state, and offers Copy + Open-on-GitHub. Self-contained on
 * the shared `.modal-overlay` scaffold (ESC / backdrop / focus-trap), matching the
 * people-picker pattern — no new modal API.
 */
function openLogViewer(opts: {
  title: string;
  htmlUrl?: string;
  load: () => Promise<string>;
}): void {
  let settled = false;
  const overlay = el("div", "modal-overlay");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", opts.title);

  const card = el("div", "modal-card actions-log-card");
  const head = el("div", "actions-log-head");
  const h = el("div", "modal-title actions-log-title");
  h.textContent = opts.title;
  h.title = opts.title;

  const headActions = el("div", "actions-log-headactions");
  const copyBtn = btn("mini-btn");
  copyBtn.append(glyph("copy"), span("Copy"));
  copyBtn.title = "Copy the full log to the clipboard";
  copyBtn.disabled = true; // enabled once the text loads
  if (opts.htmlUrl) {
    const ghBtn = el("button", "mini-btn");
    ghBtn.append(glyph("link-external"), span("GitHub"));
    ghBtn.title = "Open these logs on github.com";
    ghBtn.addEventListener("click", () => opts.htmlUrl && window.open(opts.htmlUrl, "_blank"));
    headActions.appendChild(ghBtn);
  }
  const closeBtn = el("button", "icon-btn actions-log-close");
  closeBtn.appendChild(glyph("close"));
  closeBtn.title = "Close (Esc)";
  closeBtn.setAttribute("aria-label", "Close logs");
  headActions.append(copyBtn, closeBtn);
  head.append(h, headActions);

  const body = el("div", "actions-log-body");
  body.appendChild(loadingState("Fetching logs…"));
  card.append(head, body);

  const finish = (): void => {
    if (settled) return;
    settled = true;
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      finish();
      return;
    }
    trapTab(e, card);
  };
  closeBtn.addEventListener("click", finish);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) finish();
  });

  overlay.appendChild(card);
  document.body.appendChild(overlay);
  document.addEventListener("keydown", onKey, true);
  closeBtn.focus();

  const fetchLogs = (): void => {
    body.replaceChildren(loadingState("Fetching logs…"));
    copyBtn.disabled = true;
    opts
      .load()
      .then((text) => {
        if (settled) return;
        const content = text && text.trim().length ? text : "(no log output)";
        const pre = el("pre", "actions-log") as HTMLPreElement;
        pre.textContent = content;
        body.replaceChildren(pre);
        if (text && text.trim().length) {
          copyBtn.disabled = false;
          copyBtn.onclick = () => void copyText(content, "Log copied.");
        }
      })
      .catch((e) => {
        if (settled) return;
        body.replaceChildren(
          errorState("Couldn't load logs", cleanErr(e) || "GitHub request failed.", fetchLogs),
        );
      });
  };
  fetchLogs();
}

// ── Artifacts (in the run detail, below the jobs) ──────────────────────────────

/** Load + render a run's artifacts as a labelled section under the jobs. Silent
 *  on zero artifacts (the common case) so the detail pane isn't cluttered. */
async function showArtifacts(detail: HTMLElement, runId: number): Promise<void> {
  let items: ArtifactInfo[];
  try {
    items = await host.invoke("actions:artifacts", runId);
  } catch {
    return; // best-effort: a failed artifacts read never breaks the run detail
  }
  if (!detail.isConnected || items.length === 0) return;

  const section = el("div", "gh-artifacts");
  const label = el("div", "gh-artifacts-head");
  label.append(glyph("package"), span(`Artifacts · ${items.length}`));
  section.appendChild(label);

  for (const a of items) {
    const row = el("div", "gh-artifact-row");
    const info = el("div", "row-meta");
    const t = el("div", "row-meta-title");
    t.textContent = a.name;
    const sub = el("div", "row-meta-sub");
    const size = formatBytes(a.sizeBytes) || "—";
    sub.textContent = a.expired ? `${size} · expired` : size;
    info.append(t, sub);

    const dl = btn("mini-btn");
    dl.append(glyph("cloud-download"), span("Download"));
    if (a.expired) {
      dl.disabled = true;
      dl.title = "This artifact has expired and is no longer downloadable";
    } else {
      dl.title = "Download this artifact's .zip to your Downloads folder";
      dl.addEventListener("click", () => void downloadArtifactZip(a, dl));
    }

    row.append(info, dl);
    section.appendChild(row);
  }
  detail.appendChild(section);
}

/** Download one artifact zip → toast the saved path (or the error). */
async function downloadArtifactZip(a: ArtifactInfo, btnEl: HTMLButtonElement): Promise<void> {
  btnEl.disabled = true;
  try {
    const r = await host.invoke("actions:downloadArtifact", { id: a.id, name: a.name });
    if (!r.ok) {
      toast(r.message ?? "Couldn't download the artifact.", "error");
      btnEl.disabled = false;
      return;
    }
    toast(r.message ?? `Downloaded ${a.name}.`, "success");
    btnEl.disabled = false;
  } catch (e) {
    toast(cleanErr(e) || "Couldn't download the artifact.", "error");
    btnEl.disabled = false;
  }
}

// ── Secrets & Variables manager (overlay) ──────────────────────────────────────

/**
 * A two-section manager overlay: repo Actions secrets (names only — values are
 * write-only) and variables (name + value). Add/edit via `promptInline`, delete
 * via `confirmDialog`. Each section reloads itself after a mutation. Built on the
 * shared `.modal-overlay` scaffold (ESC / backdrop / focus-trap).
 *
 * Secret *creation* may be unsupported by the backend (it needs libsodium, which
 * isn't bundled); when so, the backend returns a clear message and we surface it
 * as a toast — listing + delete still work.
 */
function openSecretsManager(): void {
  let settled = false;
  const overlay = el("div", "modal-overlay");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Secrets and variables");

  const card = el("div", "modal-card actions-secrets-card");
  const head = el("div", "actions-secrets-head");
  const h = el("div", "modal-title");
  h.textContent = "Secrets & variables";
  const closeBtn = el("button", "icon-btn");
  closeBtn.appendChild(glyph("close"));
  closeBtn.title = "Close (Esc)";
  closeBtn.setAttribute("aria-label", "Close");
  head.append(h, closeBtn);

  const finish = (): void => {
    if (settled) return;
    settled = true;
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      finish();
      return;
    }
    trapTab(e, card);
  };
  closeBtn.addEventListener("click", finish);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) finish();
  });

  const secretsSection = el("div", "actions-secrets-section");
  const variablesSection = el("div", "actions-secrets-section");
  card.append(head, secretsSection, variablesSection);

  overlay.appendChild(card);
  document.body.appendChild(overlay);
  document.addEventListener("keydown", onKey, true);
  closeBtn.focus();

  const alive = (): boolean => !settled && overlay.isConnected;
  void renderSecretsSection(secretsSection, alive);
  void renderVariablesSection(variablesSection, alive);
}

/** Render the secrets list (name + updated) with an Add button and per-row delete. */
async function renderSecretsSection(section: HTMLElement, alive: () => boolean): Promise<void> {
  const reload = (): void => void renderSecretsSection(section, alive);
  section.replaceChildren(sectionHeader("Secrets", "lock", "Add secret", () => void addSecret(reload)));
  const listWrap = el("div", "actions-kv-list");
  listWrap.appendChild(loadingState("Loading secrets…"));
  section.appendChild(listWrap);

  let items: RepoSecretInfo[];
  try {
    items = await host.invoke("actions:secrets", undefined);
  } catch (e) {
    if (!alive()) return;
    listWrap.replaceChildren(
      errorState("Couldn't load secrets", cleanErr(e) || "GitHub request failed.", reload),
    );
    return;
  }
  if (!alive()) return;
  listWrap.replaceChildren();
  if (items.length === 0) {
    listWrap.appendChild(kvEmpty("No secrets defined for this repository."));
    return;
  }
  for (const s of items) {
    const updated = relTimeISO(s.updatedAt);
    const row = kvRow(s.name, updated ? `Updated ${updated}` : "", s.updatedAt);
    const del = btn("row-btn danger");
    del.textContent = "Delete";
    del.title = `Delete the secret “${s.name}”`;
    del.addEventListener("click", () => void deleteSecret(s.name, del, reload));
    row.appendChild(del);
    listWrap.appendChild(row);
  }
}

/** Render the variables list (name + value) with Add and per-row edit/delete. */
async function renderVariablesSection(section: HTMLElement, alive: () => boolean): Promise<void> {
  const reload = (): void => void renderVariablesSection(section, alive);
  section.replaceChildren(
    sectionHeader("Variables", "symbol-variable", "Add variable", () => void addVariable(reload)),
  );
  const listWrap = el("div", "actions-kv-list");
  listWrap.appendChild(loadingState("Loading variables…"));
  section.appendChild(listWrap);

  let items: RepoVariableInfo[];
  try {
    items = await host.invoke("actions:variables", undefined);
  } catch (e) {
    if (!alive()) return;
    listWrap.replaceChildren(
      errorState("Couldn't load variables", cleanErr(e) || "GitHub request failed.", reload),
    );
    return;
  }
  if (!alive()) return;
  listWrap.replaceChildren();
  if (items.length === 0) {
    listWrap.appendChild(kvEmpty("No variables defined for this repository."));
    return;
  }
  for (const v of items) {
    const row = kvRow(v.name, v.value, v.updatedAt);
    const edit = btn("row-btn");
    edit.textContent = "Edit";
    edit.title = `Edit the variable “${v.name}”`;
    edit.addEventListener("click", () => void editVariable(v, edit, reload));
    const del = btn("row-btn danger");
    del.textContent = "Delete";
    del.title = `Delete the variable “${v.name}”`;
    del.addEventListener("click", () => void deleteVariable(v.name, del, reload));
    row.append(edit, del);
    listWrap.appendChild(row);
  }
}

/** A section header: an icon + title on the left, an Add button on the right. */
function sectionHeader(title: string, icon: string, addLabel: string, onAdd: () => void): HTMLElement {
  const head = el("div", "actions-kv-head");
  const lead = el("div", "actions-kv-headtitle");
  lead.append(glyph(icon), span(title));
  const add = btn("mini-btn");
  add.append(glyph("add"), span(addLabel));
  add.addEventListener("click", onAdd);
  head.append(lead, add);
  return head;
}

/** One name/value row (value/sub is truncated + title-tipped for long strings). */
function kvRow(name: string, sub: string, updatedISO: string): HTMLElement {
  const row = el("div", "actions-kv-row");
  const info = el("div", "row-meta");
  const t = el("div", "row-meta-title");
  t.textContent = name;
  const s = el("div", "row-meta-sub");
  s.textContent = sub || "—";
  if (sub) s.title = updatedISO ? `${sub}\n${absTimeISO(updatedISO)}` : sub;
  info.append(t, s);
  row.appendChild(info);
  return row;
}

/** An empty-line note inside a KV list. */
function kvEmpty(text: string): HTMLElement {
  const e = el("div", "actions-kv-empty");
  e.textContent = text;
  return e;
}

// Valid GitHub secret/variable name: letters, digits, underscores; not starting
// with a digit or the reserved GITHUB_ prefix. Validated client-side for a clean
// error before the round-trip.
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
function invalidName(name: string): string | null {
  if (!NAME_RE.test(name)) {
    return "Names may use only letters, digits, and underscores, and can't start with a digit.";
  }
  if (/^github_/i.test(name)) return "Names can't start with the reserved “GITHUB_” prefix.";
  return null;
}

async function addSecret(reload: () => void): Promise<void> {
  const name = await promptInline("New secret", "SECRET_NAME", "", "Next");
  if (name == null) return;
  const bad = invalidName(name);
  if (bad) {
    toast(bad, "error");
    return;
  }
  const value = await promptInline(`Value for ${name}`, "Secret value", "", "Save secret", true);
  if (value == null) return;
  try {
    const r = await host.invoke("actions:setSecret", { name, value });
    if (!r.ok) {
      toast(r.message ?? "Couldn't save the secret.", "error");
      return;
    }
    toast(`Saved secret ${name}.`, "success");
    reload();
  } catch (e) {
    toast(cleanErr(e) || "Couldn't save the secret.", "error");
  }
}

async function deleteSecret(
  name: string,
  btnEl: HTMLButtonElement,
  reload: () => void,
): Promise<void> {
  const confirmed = await confirmDialog({
    title: `Delete secret ${name}?`,
    message: "Workflows that reference this secret will lose access to it.",
    confirmLabel: "Delete secret",
    danger: true,
  });
  if (!confirmed) return;
  btnEl.disabled = true;
  try {
    const r = await host.invoke("actions:deleteSecret", name);
    if (!r.ok) {
      toast(r.message ?? "Couldn't delete the secret.", "error");
      btnEl.disabled = false;
      return;
    }
    toast(`Deleted secret ${name}.`, "success");
    reload();
  } catch (e) {
    toast(cleanErr(e) || "Couldn't delete the secret.", "error");
    btnEl.disabled = false;
  }
}

async function addVariable(reload: () => void): Promise<void> {
  const name = await promptInline("New variable", "VARIABLE_NAME", "", "Next");
  if (name == null) return;
  const bad = invalidName(name);
  if (bad) {
    toast(bad, "error");
    return;
  }
  const value = await promptInline(`Value for ${name}`, "Variable value", "", "Save variable", true);
  if (value == null) return;
  await saveVariable(name, value, reload);
}

async function editVariable(
  v: RepoVariableInfo,
  btnEl: HTMLButtonElement,
  reload: () => void,
): Promise<void> {
  const value = await promptInline(`Edit ${v.name}`, "Variable value", v.value, "Save", true);
  if (value == null) return;
  btnEl.disabled = true;
  await saveVariable(v.name, value, reload);
  btnEl.disabled = false;
}

async function saveVariable(name: string, value: string, reload: () => void): Promise<void> {
  try {
    const r = await host.invoke("actions:setVariable", { name, value });
    if (!r.ok) {
      toast(r.message ?? "Couldn't save the variable.", "error");
      return;
    }
    toast(`Saved variable ${name}.`, "success");
    reload();
  } catch (e) {
    toast(cleanErr(e) || "Couldn't save the variable.", "error");
  }
}

async function deleteVariable(
  name: string,
  btnEl: HTMLButtonElement,
  reload: () => void,
): Promise<void> {
  const confirmed = await confirmDialog({
    title: `Delete variable ${name}?`,
    message: "Workflows that reference this variable will lose its value.",
    confirmLabel: "Delete variable",
    danger: true,
  });
  if (!confirmed) return;
  btnEl.disabled = true;
  try {
    const r = await host.invoke("actions:deleteVariable", name);
    if (!r.ok) {
      toast(r.message ?? "Couldn't delete the variable.", "error");
      btnEl.disabled = false;
      return;
    }
    toast(`Deleted variable ${name}.`, "success");
    reload();
  } catch (e) {
    toast(cleanErr(e) || "Couldn't delete the variable.", "error");
    btnEl.disabled = false;
  }
}

// ── Run mutations (disable → invoke → toast → re-render detail) ────────────────

async function rerunRun(
  id: number,
  btn: HTMLButtonElement,
  detail: HTMLElement,
  run: WorkflowRun,
): Promise<void> {
  btn.disabled = true;
  try {
    const r = await host.invoke("actions:rerun", id);
    if (!r.ok) {
      toast(r.message ?? "Couldn't re-run.", "error");
      btn.disabled = false;
      return;
    }
    toast(`Re-running run #${id}.`, "success");
    void showRunDetail(detail, run);
  } catch (e) {
    toast(cleanErr(e) || "Couldn't re-run.", "error");
    btn.disabled = false;
  }
}

async function rerunFailed(
  id: number,
  btn: HTMLButtonElement,
  detail: HTMLElement,
  run: WorkflowRun,
): Promise<void> {
  btn.disabled = true;
  try {
    const r = await host.invoke("actions:rerunFailed", id);
    if (!r.ok) {
      toast(r.message ?? "Couldn't re-run failed jobs.", "error");
      btn.disabled = false;
      return;
    }
    toast(`Re-running failed jobs for run #${id}.`, "success");
    void showRunDetail(detail, run);
  } catch (e) {
    toast(cleanErr(e) || "Couldn't re-run failed jobs.", "error");
    btn.disabled = false;
  }
}

async function cancelRun(
  id: number,
  btn: HTMLButtonElement,
  detail: HTMLElement,
  run: WorkflowRun,
): Promise<void> {
  const confirmed = await confirmDialog({
    title: `Cancel run #${id}?`,
    message: "This stops the in-progress run on GitHub.",
    confirmLabel: "Cancel run",
    danger: true,
  });
  if (!confirmed) return;
  btn.disabled = true;
  try {
    const r = await host.invoke("actions:cancel", id);
    if (!r.ok) {
      toast(r.message ?? "Couldn't cancel the run.", "error");
      btn.disabled = false;
      return;
    }
    toast(`Cancelled run #${id}.`, "success");
    void showRunDetail(detail, run);
  } catch (e) {
    toast(cleanErr(e) || "Couldn't cancel the run.", "error");
    btn.disabled = false;
  }
}

// ── Workflows list (in the detail pane via the toolbar) ───────────────────────

async function showWorkflowsList(detail: HTMLElement): Promise<void> {
  detail.replaceChildren(loadingState());
  let wfs: WorkflowInfo[];
  try {
    wfs = await host.invoke("actions:workflows", undefined);
  } catch (e) {
    detail.replaceChildren(
      errorState("Couldn't load workflows", cleanErr(e) || "GitHub request failed.", () =>
        void showWorkflowsList(detail),
      ),
    );
    return;
  }
  detail.replaceChildren();
  const head = el("div", "gh-detail-head");
  const h = el("div", "gh-detail-title");
  h.textContent = "Workflows";
  const meta = el("div", "gh-detail-meta");
  meta.textContent = `${wfs.length} workflow${wfs.length === 1 ? "" : "s"}`;
  head.append(h, meta);
  detail.appendChild(head);

  if (wfs.length === 0) {
    detail.appendChild(emptyState("No workflows", "This repo has no .github/workflows files."));
    return;
  }
  const list = el("div", "gh-wf-list");
  for (const w of wfs) {
    const row = el("div", "gh-wf-row");
    const info = el("div", "row-meta");
    const t = el("div", "row-meta-title");
    t.textContent = w.name;
    const sub = el("div", "row-meta-sub");
    const stateSuffix = w.state && w.state !== "active" ? " · " + w.state.replace(/_/g, " ") : "";
    sub.textContent = `${w.path}${stateSuffix}`;
    info.append(t, sub);

    const runW = btn("mini-btn");
    runW.append(glyph("play"), span("Run"));
    runW.title = "Trigger this workflow (workflow_dispatch)";
    runW.disabled = w.state !== "active";
    runW.addEventListener("click", () => void showDispatchForm(detail, w));

    const openW = btn("row-btn");
    openW.textContent = "Open";
    openW.disabled = !w.htmlUrl;
    openW.addEventListener("click", () => w.htmlUrl && window.open(w.htmlUrl, "_blank"));

    row.append(info, runW, openW);
    list.appendChild(row);
  }
  detail.appendChild(list);
}

// ── Dispatch flow ─────────────────────────────────────────────────────────────

/**
 * Open the dispatch flow from the toolbar: pop a picker of active workflows
 * (anchored on the Run button), then render that workflow's form into `detail`.
 */
async function openDispatch(view: HTMLElement, detail: HTMLElement): Promise<void> {
  let wfs: WorkflowInfo[];
  try {
    wfs = await host.invoke("actions:workflows", undefined);
  } catch (e) {
    toast(cleanErr(e) || "Couldn't load workflows.", "error");
    return;
  }
  const active = wfs.filter((w) => w.state === "active");
  if (active.length === 0) {
    toast("No runnable workflows in this repo.", "info");
    return;
  }
  if (active.length === 1) {
    void showDispatchForm(detail, active[0]);
    return;
  }
  const anchor = view.querySelector<HTMLElement>(".gh-run-btn");
  if (!anchor) return;
  openMenu(
    anchor,
    active.map((w) => ({
      label: w.name,
      sub: w.path,
      icon: "play",
      onClick: () => void showDispatchForm(detail, w),
    })),
  );
}

/** Render a dispatch form (ref + parsed inputs) into the detail pane. */
async function showDispatchForm(detail: HTMLElement, w: WorkflowInfo): Promise<void> {
  detail.replaceChildren(loadingState("Loading inputs…"));
  let inputs: WorkflowDispatchInput[];
  try {
    inputs = await host.invoke("actions:dispatchInputs", w.id);
  } catch (e) {
    detail.replaceChildren(
      errorState("Couldn't read workflow inputs", cleanErr(e) || "GitHub request failed.", () =>
        void showDispatchForm(detail, w),
      ),
    );
    return;
  }

  detail.replaceChildren();
  const head = el("div", "gh-detail-head");
  const h = el("div", "gh-detail-title");
  h.textContent = `Run “${w.name}”`;
  const meta = el("div", "gh-detail-meta");
  meta.textContent = w.path;
  head.append(h, meta);
  detail.appendChild(head);

  const form = el("div", "gh-dispatch-form");

  // Ref field — a searchable picker over the repo's branches + tags, defaulting
  // to the current branch (best-effort). The user can still type any ref.
  const [refOptions, currentRef] = await Promise.all([loadRefOptions(), currentBranchName()]);
  const refField = comboField({
    label: "Branch or tag (ref)",
    placeholder: "Search branches and tags…",
    value: currentRef,
    options: refOptions,
  });
  form.appendChild(refField.row);

  const getters: { name: string; get: () => string }[] = [];
  for (const inp of inputs) {
    const label = inp.name + (inp.required ? " *" : "");
    if (inp.options && inp.options.length) {
      const row = el("div", "gh-dispatch-row");
      const lab = el("label", "gh-dispatch-label");
      lab.textContent = label;
      const sel = document.createElement("select");
      sel.className = "gh-dispatch-input";
      for (const opt of inp.options) {
        const o = document.createElement("option");
        o.value = opt;
        o.textContent = opt;
        if (opt === inp.default) o.selected = true;
        sel.appendChild(o);
      }
      if (inp.description) sel.title = inp.description;
      row.append(lab, sel);
      form.appendChild(row);
      getters.push({ name: inp.name, get: () => sel.value });
    } else if (inp.type === "boolean") {
      const f = dispatchField(label, "true / false", inp.default || "false");
      if (inp.description) f.input.title = inp.description;
      form.appendChild(f.row);
      getters.push({ name: inp.name, get: () => f.input.value.trim() });
    } else {
      const f = dispatchField(label, inp.description || inp.name, inp.default);
      form.appendChild(f.row);
      getters.push({ name: inp.name, get: () => f.input.value.trim() });
    }
  }

  if (inputs.length === 0) {
    const note = el("div", "gh-dispatch-note");
    note.textContent =
      "This workflow declares no inputs. It will run on the ref you choose above.";
    form.appendChild(note);
  }

  const actions = el("div", "gh-detail-actions");
  const submit = btn("btn btn-primary");
  submit.append(glyph("play"), span("Run workflow"));
  const cancel = btn("mini-btn");
  cancel.append(span("Cancel"));
  cancel.addEventListener("click", () => emptyDetail(detail));

  submit.addEventListener("click", async () => {
    const ref = refField.input.value.trim();
    if (!ref) {
      refField.input.focus();
      toast("A ref (branch or tag) is required.", "error");
      return;
    }
    const map: Record<string, string> = {};
    for (const g of getters) {
      const v = g.get();
      if (v !== "") map[g.name] = v;
    }
    submit.disabled = true;
    try {
      const r = await host.invoke("actions:dispatch", { workflowId: w.id, ref, inputs: map });
      if (!r.ok) {
        toast(r.message ?? "Couldn't start the workflow.", "error");
        submit.disabled = false;
        return;
      }
      toast(`Dispatched “${w.name}” on ${ref}. Refresh to see the new run.`, "success");
      emptyDetail(detail);
    } catch (e) {
      toast(cleanErr(e) || "Couldn't start the workflow.", "error");
      submit.disabled = false;
    }
  });

  actions.append(submit, cancel);
  form.appendChild(actions);
  detail.appendChild(form);
  refField.input.focus();
}

/** A labeled text input for the dispatch form. */
function dispatchField(
  label: string,
  placeholder: string,
  value: string,
): { row: HTMLElement; input: HTMLInputElement } {
  const row = el("div", "gh-dispatch-row");
  const lab = el("label", "gh-dispatch-label");
  lab.textContent = label;
  const input = document.createElement("input");
  input.className = "gh-dispatch-input";
  input.placeholder = placeholder;
  input.value = value ?? "";
  row.append(lab, input);
  return { row, input };
}

/** Best-effort current branch name from the open repo's HEAD; "main" fallback. */
async function currentBranchName(): Promise<string> {
  try {
    const head = await host.invoke("head:get", undefined);
    if (head && !head.detached && head.branch) return head.branch;
  } catch {
    /* not a repo / not loaded — fall through */
  }
  return "main";
}

/** Branch + tag names for the dispatch ref picker — local branches, remote
 *  branches (stripped of their "origin/" prefix), then tags, each deduped and
 *  sorted, branches before tags. Empty on failure (the field still accepts free text). */
async function loadRefOptions(): Promise<string[]> {
  try {
    const refs = await host.invoke("refs:list", undefined);
    const branches = new Set<string>();
    const tags = new Set<string>();
    for (const r of refs) {
      if (r.type === "head") branches.add(r.name);
      else if (r.type === "remote") {
        const short = r.name.replace(/^[^/]+\//, ""); // "origin/feat" → "feat"
        if (short && short !== "HEAD") branches.add(short);
      } else if (r.type === "tag") tags.add(r.name);
    }
    const cmp = (a: string, b: string): number => a.localeCompare(b);
    return [...[...branches].sort(cmp), ...[...tags].sort(cmp)];
  } catch {
    return [];
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** Humanize a raw status/conclusion token ("in_progress" → "in progress"). */
function prettyState(state: string): string {
  return state ? state.replace(/_/g, " ") : "";
}
