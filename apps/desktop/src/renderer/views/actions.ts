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
  openMenu,
  ghRow,
  statBit,
} from "../ui";
import { toast, confirmDialog } from "../dialogs";
import { ghGate, ghHeader, searchField, type SectionRender } from "./common";
import type {
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
  const runBtn = el("button", "btn btn-primary gh-run-btn");
  runBtn.append(glyph("play"), span("Run workflow"));
  runBtn.title = "Manually trigger a workflow_dispatch";
  tools.append(wfBtn, runBtn);
  header.insertBefore(tools, header.querySelector(".gh-acct"));

  const body = el("div", "gh-body");
  const listEl = el("div", "gh-list");
  const detail = el("div", "gh-detail");
  body.append(listEl, detail);
  view.append(header, body);
  wrap.replaceChildren(view);
  emptyDetail(detail);

  wfBtn.addEventListener("click", () => void showWorkflowsList(detail));
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

  const logsBtn = btn("mini-btn");
  logsBtn.append(glyph("output"), span("Logs"));
  logsBtn.title = "Open this run's logs on GitHub";
  logsBtn.disabled = !full.htmlUrl;
  logsBtn.addEventListener("click", () => full.htmlUrl && window.open(full.htmlUrl, "_blank"));

  const openBtn = btn("mini-btn");
  openBtn.append(glyph("link-external"), span("Open on GitHub"));
  openBtn.disabled = !full.htmlUrl;
  openBtn.addEventListener("click", () => full.htmlUrl && window.open(full.htmlUrl, "_blank"));

  actions.append(rerunBtn, rerunFailedBtn, cancelBtn, logsBtn, openBtn);
  head.append(h, meta, actions);
  detail.appendChild(head);

  const jobs = d?.jobs ?? [];
  if (jobs.length === 0) {
    detail.appendChild(emptyState("No jobs", "This run reported no jobs yet."));
    return;
  }
  const jobsWrap = el("div", "gh-jobs");
  for (const j of jobs) jobsWrap.appendChild(jobCard(j));
  detail.appendChild(jobsWrap);
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

  if (j.htmlUrl) {
    const log = el("button", "row-btn gh-job-log");
    log.textContent = "Logs";
    log.title = "Open this job's logs on GitHub";
    log.addEventListener("click", (e) => {
      e.stopPropagation();
      window.open(j.htmlUrl, "_blank");
    });
    head.appendChild(log);
  }
  card.append(head, steps);
  return card;
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

  // Ref field — defaults to the current branch (best-effort), else "main".
  const refField = dispatchField("Branch or tag (ref)", "main", await currentBranchName());
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

// ── helpers ───────────────────────────────────────────────────────────────────

/** Humanize a raw status/conclusion token ("in_progress" → "in progress"). */
function prettyState(state: string): string {
  return state ? state.replace(/_/g, " ") : "";
}
