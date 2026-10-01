// The Actions section — GitHub Actions runs, jobs/steps, workflows, and the
// manual `workflow_dispatch` flow, on the section-page system
// (docs/desktop-redesign.md): a full-width list page (Runs | Workflows segment)
// whose run rows navigate to a full-page run detail (routed via `target.number`
// = the run id), with the run's facts in the right rail and jobs, steps, and
// artifacts in the content column. Dispatch is a modal; logs stay in the
// in-app viewer overlay; the Secrets & Variables manager stays a modal.
//
// READ invokes go through the SWR cache (peek → instant paint, gget →
// revalidate); MUTATIONS return `{ ok, message }`, toast, bust("actions") and
// re-render.

import * as l10n from "@vscode/l10n";
import { host } from "../bridge";
import { isRemoteHead } from "../branchRequests";
import { peek as cachePeek, gget, bust } from "../cache";
import { perTab } from "../tabState";
import {
  avatar,
  el,
  span,
  subLink,
  glyph,
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
} from "../ui";
import { toast, confirmDialog, promptInline, openModal } from "../dialogs";
import {
  blankable,
  facetBar,
  harvestValues,
  segmented,
  wireToolsWrap,
  type FacetBar,
  type FacetState,
  capNotice,
  comboField,
  detailPage,
  ghGate,
  ghHeader,
  LIST_CAPS,
  personChip,
  propSection,
  searchField,
  secRow,
  sectionList,
  type GhGate,
  type SectionNav,
  type SectionRender,
  type SectionTarget,
  checkIcon,
  pageState,
} from "./common";
import { prime } from "../cache";
import { setPageLabel } from "../navStack";
import type {
  ActionsRunsFilter,
  ArtifactInfo,
  RepoSecretInfo,
  RepoVariableInfo,
  WorkflowRun,
  WorkflowStep,
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

/** "3m 42s" between two ISO stamps. For a LIVE run pass `end` empty — the
 *  duration runs to now (each poll repaint refreshes it). "" when unknown. */
function fmtDuration(startIso: string, endIso: string): string {
  const start = Date.parse(startIso);
  if (!Number.isFinite(start)) return "";
  const end = endIso ? Date.parse(endIso) : Date.now();
  if (!Number.isFinite(end)) return "";
  const s = Math.max(0, Math.round((end - start) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** A run's wall-clock duration: runStartedAt → updatedAt (or now while live). */
function runDuration(r: WorkflowRun): string {
  if (!r.runStartedAt) return "";
  return fmtDuration(r.runStartedAt, isLive(r.status) ? "" : r.updatedAt);
}

/**
 * What the Actions section remembers, for ONE tab (issue #32; see
 * tabState.ts). All of it is about one repository's workflows, and at module
 * scope it was the window's: another tab's Actions reset or replaced the
 * search, the facets and the Runs/Workflows choice under this tab's kept page,
 * and its module-level router sent this page's branch, commit, PR and log links
 * to a tab in the back. The router is not kept here: every control uses the
 * `nav` its own page was built with.
 */
interface ActionsTabState {
  /** Which list the section shows: workflow runs, or the workflow files. */
  actionsTab: "runs" | "workflows";
  /** The list page's live search query — survives list ⇄ detail round trips. */
  query: string;
  /** Server-side run filters, kept across re-renders (like `query`). */
  runFacetState: FacetState;
  /**
   * Job cards the user expanded, per run — preserved across live-poll repaints.
   *
   * The set is SEEDED with every job the first time a run's cards are built, so
   * it only ever means "exactly these are open". It used to be read as
   * `size === 0 || has(id)`, where an empty set also meant "nothing chosen yet,
   * so show everything" — and the first click then silently redefined every
   * OTHER card: collapse the one job you were done with and all its siblings
   * collapsed with it, because the set stopped being empty.
   */
  expandedJobs: Set<number>;
  /** Jobs already given their default. A running workflow gains jobs as it goes,
   *  and one that starts after you collapsed something must still open itself —
   *  so the default is applied per job on first sight, not once per run. */
  seededJobs: Set<number>;
  lastRunDetailId?: number;
  lastRunAttempt: number;
  /** The longest step in the run being rendered — the shared scale for every
   *  step bar on the page. Set by buildRunDetail before the cards are built. */
  runMaxStepSec: number;
}
const actionsTabState = perTab<ActionsTabState>(() => ({
  actionsTab: "runs",
  query: "",
  runFacetState: {},
  expandedJobs: new Set(),
  seededJobs: new Set(),
  lastRunAttempt: 0,
  runMaxStepSec: 0,
}));

export const renderActions: SectionRender = (wrap, nav, target): void => {
  void mount(wrap, nav, target);
};

async function mount(wrap: HTMLElement, nav: SectionNav, target?: SectionTarget): Promise<void> {
  const refresh = (): void => {
    bust("actions");
    renderActions(wrap, nav, target);
  };
  const gate = await ghGate(wrap, nav, true, refresh);
  if (!gate) return;

  if (target?.number != null) {
    // A run asked for WITH a job is a request to read that job's log, and the
    // log has its own route now — a page rather than a pane on this one.
    if (target.jobId != null) {
      nav("joblog", { number: target.number, jobId: target.jobId });
      return;
    }
    showRunDetailPage(wrap, nav, target.number);
    return;
  }
  await listPage(wrap, nav, gate);
}

// ── The list page (Runs | Workflows) ─────────────────────────────────────────

async function listPage(wrap: HTMLElement, nav: SectionNav, gate: GhGate): Promise<void> {
  const S = actionsTabState();
  const refresh = (): void => {
    bust("actions");
    renderActions(wrap, nav);
  };

  const { view, listEl } = sectionList();
  // Every facet here is SERVER-side: GitHub filters runs by workflow, branch,
  // actor, event and status, so narrowing fetches a different (and deeper)
  // slice rather than hiding rows from the 200 already on screen. The filter
  // object IS the cache key, so each combination caches independently.
  const runFilter = (): ActionsRunsFilter | undefined => {
    const v = S.runFacetState;
    const f: ActionsRunsFilter = {};
    if (v.workflowId) f.workflowId = Number(v.workflowId);
    if (v.branch) f.branch = v.branch;
    if (v.actor) f.actor = v.actor;
    if (v.event) f.event = v.event;
    if (v.status) f.status = v.status;
    return Object.keys(f).length ? f : undefined;
  };
  const header = ghHeader(l10n.t("Actions"), gate.login, refresh);

  const tools = el("div", "gh-head-tools");
  const seg = segmented<"runs" | "workflows">({
    options: [
      { value: "runs", label: l10n.t("Runs") },
      { value: "workflows", label: l10n.t("Workflows") },
    ],
    value: S.actionsTab,
    ariaLabel: l10n.t("Actions view"),
    onChange: (v) => {
      S.actionsTab = v;
      renderActions(wrap, nav);
    },
  });

  const secretsBtn = el("button", "mini-btn");
  secretsBtn.append(glyph("lock"), span(l10n.t("Secrets")));
  secretsBtn.title = l10n.t("Manage this repo's Actions secrets and variables");
  secretsBtn.addEventListener("click", () => openSecretsManager());

  const runBtn = el("button", "btn btn-primary gh-run-btn");
  runBtn.append(glyph("play"), span(l10n.t("Run workflow")));
  runBtn.title = l10n.t("Manually trigger a workflow_dispatch");
  runBtn.addEventListener("click", () => void openDispatch(runBtn, refresh));

  // The facet slot is ALWAYS in the row, empty on Workflows. It is what holds
  // the row's slack, so the segment stays at the row's left edge and the verbs
  // stay at its right whichever tab you're on — without it, Workflows (which
  // has no facets) let flex-end shove the segment 620px right.
  const facetSlot = el("div", "gh-facet-slot");
  // This row's control set changes with the tab (Runs has five facets, Workflows
  // none), so it claims its own line and stops moving between them.
  tools.classList.add("gh-tools-own-line");
  const verbs = el("div", "gh-head-verbs");
  verbs.append(secretsBtn, runBtn);
  tools.append(seg, facetSlot, verbs);
  wireToolsWrap(tools);
  header.querySelector(".gh-acct")?.before(tools);
  view.append(header, listEl);
  wrap.replaceChildren(view);

  header.querySelector(".gh-head-titlewrap")?.appendChild(
    searchField({
      placeholder: S.actionsTab === "runs" ? l10n.t("Search runs…") : l10n.t("Search workflows…"),
      initial: S.query,
      onInput: (q) => {
        S.query = q;
        rerenderList();
      },
    }),
  );


  let facets: FacetBar<WorkflowRun> | undefined;

  /** Re-fetch after a server-side facet change (skeleton while it lands). */
  const reloadRuns = async (): Promise<void> => {
    listEl.replaceChildren(skeletonList(6));
    try {
      const fresh = await gget("actions:runs", runFilter(), 10000);
      if (!view.isConnected) return;
      runs = fresh;
      facets?.sync(runs);
      rerenderList();
      scheduleListPoll();
    } catch (e) {
      if (!view.isConnected) return;
      listEl.replaceChildren(
        errorState(
          l10n.t("Couldn't load workflow runs"),
          cleanErr(e) || l10n.t("GitHub request failed."),
          () => void reloadRuns(),
        ),
      );
    }
  };

  // ── data ──
  let runs: WorkflowRun[] | undefined =
    S.actionsTab === "runs" ? cachePeek("actions:runs", runFilter()) : undefined;
  let workflows: WorkflowInfo[] | undefined =
    S.actionsTab === "workflows" ? cachePeek("actions:workflows", undefined) : undefined;
  if ((S.actionsTab === "runs" && !runs) || (S.actionsTab === "workflows" && !workflows)) {
    listEl.replaceChildren(skeletonList(6));
  }

  // Runs only — "filter workflows by branch" means nothing.
  if (S.actionsTab === "runs") {
    facets = facetBar<WorkflowRun>({
      specs: [
        {
          key: "workflowId",
          label: l10n.t("Workflow"),
          icon: "play-circle",
          // The rows carry a workflow NAME but the API wants its id, and a
          // filtered list can't name workflows it excluded — so load them.
          load: async () => {
            const list = await gget("actions:workflows", undefined, 60000);
            return list.map((w) => ({ value: String(w.id), label: w.name }));
          },
        },
        {
          key: "branch",
          label: l10n.t("Branch"),
          icon: "git-branch",
          harvest: harvestValues<WorkflowRun>((r) => r.branch),
        },
        {
          key: "actor",
          label: l10n.t("Actor"),
          icon: "person",
          harvest: harvestValues<WorkflowRun>((r) => r.actor?.login),
        },
        {
          key: "event",
          label: l10n.t("Event"),
          icon: "zap",
          // "pull_request" in the menu beside "pull request" on the row was the
          // same mismatch the Inbox had.
          harvest: harvestValues<WorkflowRun>((r) => r.event, (v) => v.replace(/_/g, " ")),
        },
        {
          key: "status",
          label: l10n.t("Status"),
          icon: "pulse",
          // The five states are drawn with a colour and a glyph on every run
          // row, every job card and every step; in this menu they were plain
          // text, so the one place you PICK a state was the one place it had
          // no shape. Same lead icon the rows use.
          options: [
            { value: "success", label: l10n.t("Success"), iconEl: () => runLead("success") },
            { value: "failure", label: l10n.t("Failure"), iconEl: () => runLead("failure") },
            { value: "in_progress", label: l10n.t("In progress"), iconEl: () => runLead("in_progress") },
            { value: "queued", label: l10n.t("Queued"), iconEl: () => runLead("queued") },
            { value: "cancelled", label: l10n.t("Cancelled"), iconEl: () => runLead("cancelled") },
          ],
        },
      ],
      state: S.runFacetState,
      items: runs ?? [],
      onChange: () => {
        // A server facet changes WHAT WE ASK FOR, so re-fetch rather than
        // re-filter — the point is to reach runs the unfiltered page never had.
        void reloadRuns();
      },
    });
    facetSlot.replaceChildren(facets.el);
  }

  const runMatches = (r: WorkflowRun, q: string): boolean =>
    `${r.name} ${r.displayTitle} ${r.branch} ${r.event} ${r.actor?.login ?? ""} #${r.runNumber}`
      .toLowerCase()
      .includes(q);
  const wfMatches = (w: WorkflowInfo, q: string): boolean =>
    `${w.name} ${w.path}`.toLowerCase().includes(q);

  const buildRunRow = (r: WorkflowRun): HTMLElement => {
    const state = r.conclusion || r.status || "";
    // The workflow's name rides as a muted suffix after the run's own title —
    // GitHub-style "<commit subject> · Desktop CI".
    // A scheduled run's title IS its workflow name, so the suffix printed the
    // same string twice in a row ("Nightly release  Nightly release").
    const suffix: HTMLElement[] = r.name && r.name !== r.displayTitle ? [span(r.name, "sec-run-wf")] : [];
    if (r.runAttempt > 1) {
      const att = el("span", "gh-pill sec-attempt");
      att.textContent = l10n.t("attempt {0}", r.runAttempt);
      att.title = l10n.t("This run was re-run");
      suffix.push(att);
    }
    // Same column contract as the other lists: every optional slot is
    // reserved, so a run without a branch doesn't slide the durations out of
    // line with the row above it.
    const meta: HTMLElement[] = [];
    meta.push(blankable(avatar(r.actor?.login ?? "?", r.actor?.avatarUrl ?? null, 18, "Actor"), !!r.actor));
    // Branch names run from "main" to "redesign/issues-detail"; without a floor
    // the column moved the ACTOR AVATAR to its left by the difference, so the
    // avatars zig-zagged down the list.
    const branchEl = blankable(
      subLink(r.branch || "—", l10n.t("Show {0} in Branches", r.branch), () =>
        nav("branches", { ref: r.branch }),
      ),
      !!r.branch,
    );
    branchEl.classList.add("sec-run-branch");
    meta.push(branchEl);
    meta.push(blankable(span(r.event.replace(/_/g, " "), "sec-run-event"), !!r.event));
    const dur = runDuration(r);
    meta.push(blankable(span(dur || "—", "sec-run-dur"), !!dur));
    // The status word is dropped: the coloured lead icon already says it, and
    // it carried a 72px min-width that pushed everything else out of line. The
    // icon and the row's aria-label keep it available to a screen reader.
    const row = secRow({
      lead: runLead(state, prettyState(state) || l10n.t("unknown")),
      num: `#${r.runNumber || r.id}`,
      title: r.displayTitle,
      titleSuffix: suffix,
      meta,
      time: relTimeISO(r.createdAt),
      timeTitle: r.createdAt ? l10n.t("Created {0}", absTimeISO(r.createdAt)) : undefined,
      ariaLabel: l10n.t(
        "Workflow run {0} #{1}: {2}",
        r.name,
        r.runNumber,
        prettyState(state) || l10n.t("unknown"),
      ),
      onOpen: () => nav("actions", { number: r.id }),
    });
    row.dataset.num = String(r.id);
    return row;
  };

  const buildWfRow = (w: WorkflowInfo): HTMLElement => {
    const disabled = w.state !== "active";
    // A workflow row was a name at the far left and a path at the far right
    // with ~1000px of nothing between them, and carried no state at all — you
    // could not tell from this list whether a workflow had ever run.
    const last = runs?.find((r) => r.workflowId === w.id);
    const meta: HTMLElement[] = [];
    if (last) {
      meta.push(runLead(last.conclusion || last.status || "", prettyState(last.conclusion || last.status || "")));
      meta.push(span(`#${last.runNumber || last.id}`, "sec-run-dur"));
    } else if (runs) {
      meta.push(span(l10n.t("never run")));
    }
    if (disabled) meta.push(span(w.state.replace(/_/g, " "), "gh-pill"));
    return secRow({
      lead: (() => {
        const s = el("span", "gh-lead-icon");
        s.appendChild(glyph("play-circle"));
        if (disabled) s.classList.add("is-muted");
        return s;
      })(),
      title: w.name,
      // The file name identifies a workflow; the ".github/workflows/" prefix
      // is the same on every row and was eating the width.
      titleSuffix: [span(w.path.split("/").pop() ?? w.path, "sec-run-wf")],
      meta,
      time: last ? relTimeISO(last.createdAt) : undefined,
      ariaLabel: disabled ? l10n.t("Workflow {0} (disabled)", w.name) : l10n.t("Workflow {0}", w.name),
      onOpen: () => {
        if (disabled) {
          toast(l10n.t("This workflow is disabled on GitHub."), "info");
          return;
        }
        void showDispatchModal(w, refresh);
      },
    });
  };

  const rerenderList = (): void => {
    if (runs) facets?.sync(runs);
    const q = S.query.toLowerCase();
    listEl.replaceChildren();
    if (S.actionsTab === "runs") {
      if (!runs) return;
      if (runs.length === 0) {
        listEl.appendChild(
          emptyState(
            l10n.t("No workflow runs"),
            l10n.t("No GitHub Actions runs found for this repository."),
            {
              icon: "play",
              action: {
                label: l10n.t("Run workflow"),
                icon: "play",
                onClick: () => void openDispatch(runBtn, refresh),
              },
            },
          ),
        );
        return;
      }
      const items = q ? runs.filter((r) => runMatches(r, q)) : runs;
      // AFTER the filter, and with both numbers: the pill used to advertise
      // the unfiltered total directly above a "No matching …" empty state.
      header.setCount?.(items.length, runs.length);
      if (items.length === 0) {
        listEl.appendChild(
          emptyState(l10n.t("No matching runs"), l10n.t("Nothing matches “{0}”.", S.query), {
            icon: "search",
            anchor: "inline",
          }),
        );
        return;
      }
      for (const r of items) listEl.appendChild(buildRunRow(r));
      // "server": the runs list IS GitHub's answer to the current filter, so
      // telling the user to "search to narrow" would be a lie — the filters
      // above are what reach further back.
      const cap = capNotice(runs.length, LIST_CAPS.runs, "server");
      if (cap) listEl.appendChild(cap);
    } else {
      if (!workflows) return;
      if (workflows.length === 0) {
        listEl.appendChild(
          emptyState(l10n.t("No workflows"), l10n.t("This repo has no .github/workflows files."), {
            icon: "play",
          }),
        );
        return;
      }
      const items = q ? workflows.filter((w) => wfMatches(w, q)) : workflows;
      // AFTER the filter, and with both numbers: the pill used to advertise
      // the unfiltered total directly above a "No matching …" empty state.
      header.setCount?.(items.length, workflows.length);
      if (items.length === 0) {
        listEl.appendChild(
          emptyState(l10n.t("No matching workflows"), l10n.t("Nothing matches “{0}”.", S.query), {
            icon: "search",
            anchor: "inline",
          }),
        );
        return;
      }
      for (const w of items) listEl.appendChild(buildWfRow(w));
    }
  };

  if (runs || workflows) rerenderList();

  // While any run is LIVE, quietly re-fetch the list every 12s and repaint in
  // place — a CI dashboard that only updates on manual refresh isn't one.
  const scheduleListPoll = (): void => {
    if (S.actionsTab !== "runs" || !runs?.some((r) => isLive(r.status))) return;
    window.setTimeout(() => {
      const at = pageState(view);
      if (at === "gone" || S.actionsTab !== "runs") return;
      // Its tab is in the back: ask nothing, and look again (see pageState).
      if (at === "away") {
        scheduleListPoll();
        return;
      }
      // The poll must ask the SAME question the view is showing — polling
      // unfiltered would quietly replace a filtered list with everything.
      const f = runFilter();
      host
        .invoke("actions:runs", f)
        .then((fresh) => {
          if (!view.isConnected) return;
          prime("actions:runs", f, fresh);
          runs = fresh;
          facets?.sync(runs);
          rerenderList();
          scheduleListPoll();
        })
        .catch(() => scheduleListPoll()); // transient failure — keep watching
    }, 12000);
  };

  try {
    if (S.actionsTab === "runs") {
      const fresh = await gget("actions:runs", runFilter(), 10000);
      if (!view.isConnected) return;
      runs = fresh;
      facets?.sync(runs);
    } else {
      const [fresh, recent] = await Promise.all([
        gget("actions:workflows", undefined, 60000),
        // The workflow rows show each workflow's last run. This shares the
        // Runs tab's cache key, so switching tabs is free after the first
        // load — and without it the rows would have to claim "never run"
        // when the truth is only that we had not looked.
        gget("actions:runs", undefined, 10000).catch(() => [] as WorkflowRun[]),
      ]);
      if (!view.isConnected) return;
      workflows = fresh;
      runs = recent;
    }
    rerenderList();
    scheduleListPoll();
  } catch (e) {
    if (!view.isConnected) return;
    if (!runs && !workflows) {
      listEl.replaceChildren(
        errorState(
          S.actionsTab === "runs" ? l10n.t("Couldn't load workflow runs") : l10n.t("Couldn't load workflows"),
          cleanErr(e) || l10n.t("GitHub request failed."),
          refresh,
        ),
      );
    }
  }
}

/** A colored leading status icon for a run, keyed off its conclusion/status. */
function runLead(state: string, label?: string): HTMLElement {
  // The same marks as `checkIcon` in common.ts — a check, a cross, a slash, one
  // weight. These are two copies of one vocabulary, and they must not drift:
  // the run's leading icon and its jobs' icons appearing in different shapes
  // for the same state is how a list stops being scannable.
  let icon = "sync";
  let cls = "is-running"; // in_progress / queued / pending
  if (state === "success") {
    icon = "check";
    cls = "is-success";
  } else if (
    state === "failure" ||
    state === "error" ||
    state === "startup_failure" ||
    state === "timed_out"
  ) {
    // Failure was drawn as a hollow ring next to a SOLID success disc, so at a
    // glance down a list of runs the failures read as the quieter ones. The
    // state that needs you is the state that carries the weight.
    //
    // A timeout belongs here: the run did not finish, and nobody chose that.
    icon = "close";
    cls = "is-failure";
  } else if (state === "action_required") {
    // Not a failure — it is waiting for a person. Drawing it red sent people to
    // read logs for an error that had not happened.
    icon = "warning";
    cls = "is-running";
  } else if (
    state === "cancelled" ||
    state === "stale" ||
    state === "skipped" ||
    state === "neutral"
  ) {
    // A CANCELLED run is not a failed one — somebody stopped it on purpose, and
    // usually that somebody is you. It used to fall into the failure bucket
    // here while the run's own page and the status filter both drew it muted,
    // so the same run was red in the list and a non-event everywhere else.
    icon = "circle-slash";
    cls = "is-muted";
  }
  const s = el("span", `gh-lead-icon run-lead ${cls}`);
  // The icon is now the only place the status is stated, so it has to be
  // readable — by hover and by a screen reader.
  if (label) {
    s.title = label;
    s.setAttribute("aria-label", label);
    s.setAttribute("role", "img");
  }
  s.appendChild(glyph(icon));
  return s;
}

// ── The run detail page ──────────────────────────────────────────────────────

function showRunDetailPage(wrap: HTMLElement, nav: SectionNav, id: number): void {
  const S = actionsTabState();
  if (S.lastRunDetailId !== id) {
    S.lastRunDetailId = id;
    S.lastRunAttempt = 0;
    S.expandedJobs.clear();
    S.seededJobs.clear();
  }
  const back = (): void => nav("actions", { list: true });
  const reload = (): void => {
    bust("actions");
    showRunDetailPage(wrap, nav, id);
  };

  const { view, main, rail, topActions } = detailPage({
    backLabel: l10n.t("Actions"),
    // The run NUMBER is the run's identity — the crumb used to show the
    // internal id ("#9100") while the title showed "#411", giving one run two
    // numbers on one screen. Set once the run loads (see paint()).
    crumb: l10n.t("Run"),
    onBack: back,
  });
  main.appendChild(skeletonList(4, false));
  wrap.replaceChildren(view);

  // A LIVE run keeps its page honest: re-fetch every 8s and repaint only when
  // something actually changed (job/step states), stopping once it concludes.
  let lastSig = "";
  const schedulePoll = (current: WorkflowRunDetail): void => {
    if (!isLive(current.run.status)) return;
    window.setTimeout(() => {
      const at = pageState(view);
      if (at === "gone") return;
      // Its tab is in the back: ask nothing, and look again (see pageState).
      if (at === "away") {
        schedulePoll(current);
        return;
      }
      host
        .invoke("actions:runDetail", id)
        .then((fresh) => {
          if (!view.isConnected || !fresh) return;
          prime("actions:runDetail", id, fresh);
          const sig = JSON.stringify(fresh);
          if (sig !== lastSig) {
            lastSig = sig;
            buildRunDetail({ main, rail, topActions, d: fresh, reload, nav, tab: S });
          }
          schedulePoll(fresh);
        })
        .catch(() => schedulePoll(current)); // transient failure — keep watching
    }, 8000);
  };

  void (async () => {
    let d: WorkflowRunDetail | undefined;
    try {
      d = await gget("actions:runDetail", id, 5000);
    } catch (e) {
      if (!view.isConnected) return;
      main.replaceChildren(
        errorState(l10n.t("Couldn't load the run"), cleanErr(e) || l10n.t("GitHub request failed."), reload),
      );
      return;
    }
    if (!view.isConnected) return;
    if (!d) {
      main.replaceChildren(
        emptyState(l10n.t("Run unavailable"), l10n.t("This workflow run couldn't be loaded.")),
      );
      return;
    }
    lastSig = JSON.stringify(d);
    buildRunDetail({ main, rail, topActions, d, reload, nav, tab: S });
    schedulePoll(d);
  })();
}

interface RunDetailCtx {
  main: HTMLElement;
  rail: HTMLElement;
  topActions: HTMLElement;
  d: WorkflowRunDetail;
  reload: () => void;
  /** The router this page was built with — its own tab's. */
  nav: SectionNav;
  /** This tab's section state. */
  tab: ActionsTabState;
}

function buildRunDetail(ctx: RunDetailCtx): void {
  const { main, rail, topActions, d, reload, nav, tab: S } = ctx;
  const full = d.run;
  S.runMaxStepSec = Math.max(0, ...d.jobs.flatMap((j) => j.steps.map(stepSeconds)));
  // One identity for this run, everywhere on the page: the run NUMBER. The
  // crumb used to carry the internal id ("#9100") while the title showed
  // "#411" — the same run wearing two numbers 40px apart.
  // Every string that names this run to the user reads from this one value —
  // including the re-run/cancel dialogs and toasts, which used to print the
  // internal id and so named a run that appears nowhere in the Actions list.
  const runNum = full.runNumber || full.id;
  const crumbEl = main.closest(".det-view")?.querySelector<HTMLElement>(".det-crumb");
  if (crumbEl) crumbEl.textContent = `#${runNum}`;
  // The run's identity is only known once it loads, so the page names itself
  // here rather than at construction. A page opened FROM this one then says
  // "← Run #411" instead of "← Actions".
  setPageLabel(l10n.t("Run #{0}", runNum));
  const state = full.conclusion || full.status || "";
  const live = isLive(full.status);
  // A re-run attempt REPLACES the logs — every pane restarts from zero.
  S.lastRunAttempt = full.runAttempt;
  main.replaceChildren();
  rail.replaceChildren();

  // ── top-bar actions ──
  const rerunBtn = btn("mini-btn");
  rerunBtn.append(glyph("refresh"), span(l10n.t("Re-run")));
  // A disabled button that still promises what it would do is a button you
  // keep clicking. When it can't act, its tooltip says why instead.
  rerunBtn.disabled = live;
  rerunBtn.title = live
    ? l10n.t("This run is still going — you can't re-run it until it finishes")
    : l10n.t("Re-run all jobs in this run");
  rerunBtn.addEventListener("click", () => void rerunRun(full.id, runNum, rerunBtn, reload));

  const rerunFailedBtn = btn("mini-btn");
  rerunFailedBtn.append(glyph("debug-restart"), span(l10n.t("Re-run failed")));
  // Nothing failed, so there is nothing to re-run: don't show a dead control.
  rerunFailedBtn.hidden = full.conclusion === "success" || live;
  rerunFailedBtn.disabled = rerunFailedBtn.hidden;
  rerunFailedBtn.title = rerunFailedBtn.disabled
    ? l10n.t("Nothing has failed in this run")
    : l10n.t("Re-run only the failed jobs");
  rerunFailedBtn.addEventListener("click", () =>
    void rerunFailed(full.id, runNum, rerunFailedBtn, reload),
  );

  const cancelBtn = btn("mini-btn danger");
  cancelBtn.append(glyph("circle-slash"), span(l10n.t("Cancel")));
  cancelBtn.title = l10n.t("Cancel this in-progress run");
  // A run that finished an hour ago cannot be cancelled; a greyed-out Cancel
  // sitting there permanently is just noise.
  cancelBtn.hidden = !live;
  cancelBtn.disabled = !live;
  cancelBtn.addEventListener("click", () => void cancelRun(full.id, runNum, cancelBtn, reload));

  // The logs are a PAGE, not an accordion on this one. Expanding every job's
  // log inline gave each of them a ~400px slot inside a page that was already
  // scrolling — "the log window is too small" — and left two entry points able
  // to put the same card in different states.
  const logsBtn = btn("btn btn-primary");
  const failedJobs = d.jobs.filter((j) => j.conclusion === "failure" || j.conclusion === "timed_out");
  logsBtn.append(
    glyph("output"),
    span(failedJobs.length ? l10n.t("Read the failing log") : l10n.t("Read the logs")),
  );
  logsBtn.title = failedJobs.length
    ? l10n.t("Open the failing job's log full-window")
    : l10n.t("Open this run's logs full-window");
  logsBtn.disabled = d.jobs.length === 0;
  if (logsBtn.disabled) logsBtn.title = l10n.t("This run has no jobs yet");
  logsBtn.addEventListener("click", () =>
    nav("joblog", { number: full.id, jobId: (failedJobs[0] ?? d.jobs[0])?.id }),
  );

  const openBtn = btn("mini-btn gh-icon-btn");
  openBtn.append(glyph("link-external"));
  openBtn.title = l10n.t("Open this run on GitHub");
  openBtn.disabled = !full.htmlUrl;
  if (openBtn.disabled) openBtn.title = l10n.t("GitHub didn't give this run a link");
  openBtn.setAttribute("aria-label", openBtn.title);
  openBtn.addEventListener("click", () => full.htmlUrl && window.open(full.htmlUrl, "_blank"));

  topActions.replaceChildren(rerunBtn, rerunFailedBtn, cancelBtn, logsBtn, openBtn);

  // ── title block ──
  const titleRow = el("div", "det-title-row");
  titleRow.appendChild(runStatePill(state));
  const h = el("h1", "det-title");
  h.append(span(full.displayTitle), span(`  #${runNum}`, "det-title-num"));
  titleRow.appendChild(h);
  if (full.runAttempt > 1) {
    const att = el("span", "gh-pill sec-attempt det-attempt");
    att.textContent = l10n.t("attempt {0}", full.runAttempt);
    titleRow.appendChild(att);
  }
  main.appendChild(titleRow);

  const sub = el("div", "det-sub");
  if (full.branch) {
    const chip = el("button", "gh-branch-chip");
    chip.append(glyph("git-branch"), span(full.branch));
    chip.title = l10n.t("Show {0} in Branches", full.branch);
    chip.addEventListener("click", () => nav("branches", { ref: full.branch }));
    sub.appendChild(chip);
  }
  // The commit this run built — one click from its row in the graph.
  if (full.headSha) {
    const commit = el("button", "gh-branch-chip det-commit-chip");
    const subject = full.headCommitMessage.split("\n", 1)[0];
    commit.append(glyph("git-commit"), span(full.headSha.slice(0, 7)));
    // The COMMIT, not the graph — the last chip in the app still doing this.
    //
    // "it teleports u to the commit graph which tells u nothing about the
    // changed files" was reported about this exact behaviour, and every other
    // sha in the app was moved to the commit page for it: pull requests,
    // releases, notifications, ref detail. This one was missed, so the
    // complaint was still one click away from the run page. The commit page
    // carries a "View in Commits" item, so that view stays reachable.
    commit.title = subject ? l10n.t("{0} — open this commit", subject) : l10n.t("Open this commit");
    commit.addEventListener("click", () => nav("commit", { sha: full.headSha }));
    sub.appendChild(commit);
  }
  const subText = el("span");
  subText.textContent = full.event
    ? l10n.t("{0} · started {1}", full.event, relTimeISO(full.runStartedAt || full.createdAt))
    : l10n.t("started {0}", relTimeISO(full.runStartedAt || full.createdAt));
  subText.title = absTimeISO(full.runStartedAt || full.createdAt);
  sub.appendChild(subText);
  main.appendChild(sub);

  // ── jobs ──
  const jobs = d.jobs;
  if (jobs.length === 0) {
    main.appendChild(emptyState(l10n.t("No jobs"), l10n.t("This run reported no jobs yet.")));
  } else {
    // Open by default — the steps ARE the page, and a run detail whose cards
    // are all shut is two hollow rows. Seeding says that once, as a fact about
    // this run, instead of leaving `jobCard` to infer it from an empty set.
    for (const j of jobs) {
      if (S.seededJobs.has(j.id)) continue;
      S.seededJobs.add(j.id);
      S.expandedJobs.add(j.id);
    }
    const jobsWrap = el("div", "gh-jobs");
    for (const j of jobs) jobsWrap.appendChild(jobCard(j, full.id, S, nav));
    main.appendChild(jobsWrap);
  }

  // Artifacts produced by this run — below the jobs, lazily loaded.
  void showArtifacts(main, full.id);

  // ── rail ──
  // No Status section: the pill sits beside the title 900px away, and the rail
  // repeating it was the same word twice on one screen.
  //
  // A LIVE run gets a section here, but it must not be the third statement of
  // the same fact — the title pill already reads "in progress", and a second
  // pill saying it again beside the words "running now" made three. What the
  // title cannot say is HOW LONG, and on a run you are watching that is the
  // only number you actually want.
  const elapsed = runDuration(full);
  const statusProp = live ? propSection(l10n.t("Running for")) : undefined;
  if (statusProp) {
    statusProp.body.appendChild(span(elapsed || l10n.t("just started"), "det-prop-value"));
  }

  // WHO: the run's actor — and the re-runner, when someone else re-ran it.
  const whoProp = propSection(
    full.triggeringActor && full.actor && full.triggeringActor.login !== full.actor.login
      ? l10n.t("Actor · re-run by")
      : l10n.t("Actor"),
  );
  if (full.actor) {
    whoProp.body.appendChild(
      personChip(full.actor.login, full.actor.avatarUrl),
    );
  } else {
    whoProp.body.appendChild(span("—", "det-prop-none"));
  }
  if (full.triggeringActor && full.actor && full.triggeringActor.login !== full.actor.login) {
    whoProp.body.appendChild(personChip(full.triggeringActor.login, full.triggeringActor.avatarUrl));
  }

  const aboutProp = propSection(l10n.t("About"));
  aboutProp.body.classList.add("det-prop-facts");
  const fact = (k: string, v: string, title?: string): HTMLElement => {
    const row = el("div", "det-fact");
    const val = el("span", "det-fact-v");
    val.textContent = v;
    if (title) val.title = title;
    row.append(span(k, "det-fact-k"), val);
    return row;
  };
  if (full.name) aboutProp.body.appendChild(fact(l10n.t("Workflow"), full.name, full.workflowPath || undefined));
  // (Branch and Trigger are the chips under the title — printing them again
  //  here made the rail read as an echo of the header.)
  if (full.runAttempt > 1) aboutProp.body.appendChild(fact(l10n.t("Attempt"), String(full.runAttempt)));
  aboutProp.body.appendChild(fact(l10n.t("Jobs"), String(jobs.length)));
  const dur = runDuration(full);
  if (dur) aboutProp.body.appendChild(fact(l10n.t("Duration"), dur));
  aboutProp.body.appendChild(fact(l10n.t("Queued"), relTimeISO(full.createdAt), absTimeISO(full.createdAt)));
  if (full.runStartedAt) {
    aboutProp.body.appendChild(
      fact(l10n.t("Started"), relTimeISO(full.runStartedAt), absTimeISO(full.runStartedAt)),
    );
  }

  // Linked PRs — each one click from its full workspace.
  let prsProp: { root: HTMLElement; body: HTMLElement } | undefined;
  if (full.pullRequests.length) {
    prsProp = propSection(l10n.t("Pull requests"));
    for (const pr of full.pullRequests) {
      const b = btn("det-mono-btn");
      b.append(glyph("git-pull-request"), span(`#${pr.number}`));
      b.title = l10n.t("Open pull request #{0}", pr.number);
      b.addEventListener("click", () => nav("prs", { number: pr.number }));
      prsProp.body.appendChild(b);
    }
  }

  const idProp = propSection(l10n.t("Run ID"));
  const idBtn = btn("det-mono-btn");
  idBtn.append(glyph("copy"), span(String(full.id)));
  idBtn.title = l10n.t("Copy the run id");
  idBtn.addEventListener("click", () => void copyText(String(full.id), l10n.t("Run id copied.")));
  idProp.body.appendChild(idBtn);

  rail.append(...(statusProp ? [statusProp.root] : []), whoProp.root, aboutProp.root, ...(prsProp ? [prsProp.root] : []), idProp.root);
}

/** A run's status as a tinted state pill (success/failure/running/neutral). */
function runStatePill(state: string): HTMLElement {
  const label = prettyState(state) || l10n.t("unknown");
  const p = el("span", `gh-state-pill gh-checks-${state}`);
  p.textContent = label;
  return p;
}

/** One expandable job card: header row (dot + name + state + Logs) + its steps.
 *  Expansion is remembered in the tab's `expandedJobs` so live-poll repaints keep it; the
 *  Logs button leaves for the log's own page (`views/jobLog.ts`), because an
 *  inline pane on this page got 523px of a 913px window. */
/** Seconds a step took, or 0 when it hasn't finished (or never started). */
function stepSeconds(s: WorkflowStep): number {
  const a = Date.parse(s.startedAt);
  if (!Number.isFinite(a)) return 0;
  const b = Date.parse(s.completedAt);
  // A step that has started but not finished has no completedAt, and returning
  // 0 for it drew the ONE step actually running right now as the shortest bar
  // in the job — the opposite of the truth, and it grew shorter the longer it
  // ran. Measure a live step against the clock.
  const end = Number.isFinite(b) ? b : Date.now();
  return Math.max(0, (end - a) / 1000);
}

function jobCard(j: WorkflowJob, runId: number, S: ActionsTabState, nav: SectionNav): HTMLElement {
  const card = el("div", "gh-job");
  const state = j.conclusion || j.status || "";
  // Steps are the content of this page. They used to be collapsed by default,
  // so a run detail was two hollow rows in an empty page — you had to click
  // every job to see what actually ran. `buildRunDetail` seeds the default;
  // this asks one question only.
  const open = S.expandedJobs.has(j.id);
  // A div, not a <button>: this header carries the job's own "Logs" button, and
  // a control inside a control is invalid — the outer button's accessible name
  // swallows the inner one, assistive tech cannot reach it, and Space activates
  // the header rather than the thing you are on. Same shape the branch rows and
  // secRow use for exactly this reason; the role, tab stop and keys are wired
  // below.
  const head = el("div", "gh-job-head" + (open ? " open" : ""));
  const chevron = glyph("chevron-right");
  chevron.classList.add("gh-job-chevron");
  const dot = checkIcon(state);
  const name = el("span", "gh-check-name");
  name.textContent = j.name;
  const st = el("span", "gh-check-state");
  st.textContent = prettyState(state);
  head.append(chevron, dot, name, st);

  const steps = el("div", "gh-job-steps" + (open ? "" : " hidden"));
  // WHERE it ran + how long it waited: runner name (or the requested labels
  // when GitHub omits it) and the queue latency, under the job header.
  const runnerBits: string[] = [];
  if (j.runnerName) runnerBits.push(j.runnerName);
  else if (j.labels.length) runnerBits.push(j.labels.join(", "));
  if (j.runnerGroupName && j.runnerGroupName !== "Default") runnerBits.push(j.runnerGroupName);
  const queue = j.createdAt && j.startedAt ? fmtDuration(j.createdAt, j.startedAt) : "";
  if (runnerBits.length || queue) {
    const metaLine = el("div", "gh-job-meta");
    if (runnerBits.length) {
      const r = el("span", "gh-job-runner");
      r.append(glyph("vm"), span(runnerBits.join(" · ")));
      r.title = j.labels.length ? l10n.t("Requested labels: {0}", j.labels.join(", ")) : l10n.t("Runner");
      metaLine.appendChild(r);
    }
    if (queue) {
      const q = el("span", "gh-job-queue");
      q.textContent = l10n.t("queued {0}", queue);
      q.title = l10n.t("Time between queueing and the runner picking the job up");
      metaLine.appendChild(q);
    }
    steps.appendChild(metaLine);
  }
  if (j.steps.length === 0) {
    const none = el("div", "gh-step-row gh-step-empty");
    none.textContent = l10n.t("No steps reported.");
    steps.appendChild(none);
  }
  // Per-step durations + a proportional timeline bar (widths relative to the
  // longest step, via a --w custom property — layout stays in CSS).
  const stepSecs = j.steps.map(stepSeconds);
  // Normalised across the WHOLE RUN, not per job: per-job scaling drew a 30s
  // step and a 4m step at the same length in adjacent cards, which makes the
  // bars actively misleading — they exist to be compared.
  const maxSec = Math.max(1, S.runMaxStepSec, ...stepSecs);
  j.steps.forEach((s, i) => {
    const row = el("div", "gh-step-row");
    const sState = s.conclusion || s.status || "";
    const sdot = checkIcon(sState);
    const sname = el("span", "gh-check-name");
    sname.textContent = s.name || "(step)";
    const bar = el("span", "gh-step-bar");
    bar.style.setProperty("--w", `${Math.max(2, Math.round((stepSecs[i] / maxSec) * 100))}%`);
    const running = !!s.startedAt && !s.completedAt;
    if (running) bar.classList.add("is-running");
    const sdur = el("span", "gh-step-dur");
    // "1m 12s" while it runs, not a blank column. The suffix marks it as still
    // counting rather than a final number.
    sdur.textContent = s.startedAt ? fmtDuration(s.startedAt, s.completedAt) + (running ? "…" : "") : "";
    const sst = el("span", "gh-check-state");
    sst.textContent = prettyState(sState);
    row.append(sdot, sname, bar, sdur, sst);
    steps.appendChild(row);
  });

  const syncHead = (): void => {
    const open = !steps.classList.contains("hidden");
    head.classList.toggle("open", open);
    head.setAttribute("aria-expanded", String(open));
  };
  head.setAttribute("role", "button");
  if (head.tabIndex < 0) head.tabIndex = 0;
  head.setAttribute("aria-controls", (steps.id ||= `gs-job-steps-${j.id}`));
  syncHead();
  head.addEventListener("click", () => {
    const nowHidden = steps.classList.toggle("hidden");
    syncHead();
    if (nowHidden) S.expandedJobs.delete(j.id);
    else S.expandedJobs.add(j.id);
  });
  head.addEventListener("keydown", (e) => {
    if (e.target !== head) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    head.click();
  });

  const log = el("button", "row-btn gh-job-log") as HTMLButtonElement;
  log.textContent = l10n.t("Logs");
  log.title = l10n.t("Read {0}'s log full-window", j.name);
  log.addEventListener("click", (e) => {
    e.stopPropagation();
    nav("joblog", { number: runId, jobId: j.id });
  });
  head.appendChild(log);
  card.dataset.jobId = String(j.id);
  card.append(head, steps);
  return card;
}

// ── In-app log viewer (overlay; reused for run + job logs, and by prs.ts) ──────



// ── Artifacts (in the run detail, below the jobs) ──────────────────────────────

/** Load + render a run's artifacts as a labelled section under the jobs. Silent
 *  on zero artifacts (the common case) so the detail column isn't cluttered. */
async function showArtifacts(container: HTMLElement, runId: number): Promise<void> {
  let items: ArtifactInfo[];
  try {
    // Through the cache: the run page is re-rendered by its own 12-second poll
    // and by every Back onto it, and each of those re-asked GitHub for a list
    // that almost never changes within a single visit.
    items = await gget("actions:artifacts", runId, 5000);
  } catch {
    return; // best-effort: a failed artifacts read never breaks the run detail
  }
  if (!container.isConnected || items.length === 0) return;

  const section = el("div", "gh-artifacts");
  const label = el("div", "gh-artifacts-head");
  label.append(glyph("package"), span(l10n.t("Artifacts · {0}", items.length)));
  section.appendChild(label);

  for (const a of items) {
    const row = el("div", "gh-artifact-row");
    const info = el("div", "row-meta");
    const t = el("div", "row-meta-title");
    t.textContent = a.name;
    const sub = el("div", "row-meta-sub");
    const size = formatBytes(a.sizeBytes) || "—";
    sub.textContent = a.expired ? l10n.t("{0} · expired", size) : size;
    info.append(t, sub);

    const dl = btn("mini-btn");
    dl.append(glyph("cloud-download"), span(l10n.t("Download")));
    if (a.expired) {
      dl.disabled = true;
      dl.title = l10n.t("This artifact has expired and is no longer downloadable");
    } else {
      dl.title = l10n.t("Download this artifact's .zip to your Downloads folder");
      dl.addEventListener("click", () => void downloadArtifactZip(a, dl));
    }

    row.append(info, dl);
    section.appendChild(row);
  }
  container.appendChild(section);
}

/** Download one artifact zip → toast the saved path (or the error). */
async function downloadArtifactZip(a: ArtifactInfo, btnEl: HTMLButtonElement): Promise<void> {
  btnEl.disabled = true;
  try {
    const r = await host.invoke("actions:downloadArtifact", { id: a.id, name: a.name });
    if (!r.ok) {
      toast(r.message ?? l10n.t("Couldn't download the artifact."), "error");
      btnEl.disabled = false;
      return;
    }
    toast(r.message ?? l10n.t("Downloaded {0}.", a.name), "success");
    btnEl.disabled = false;
  } catch (e) {
    toast(cleanErr(e) || l10n.t("Couldn't download the artifact."), "error");
    btnEl.disabled = false;
  }
}

// ── Secrets & Variables manager (overlay) ──────────────────────────────────────

/**
 * A two-section manager overlay: repo Actions secrets (names only — values are
 * write-only) and variables (name + value). Add/edit via `promptInline`, delete
 * via `confirmDialog` — those stack ABOVE this modal, and the shared scaffold's
 * modal stack keeps Esc scoped to the topmost. Each section reloads itself
 * after a mutation.
 *
 * Secret *creation* may be unsupported by the backend (it needs libsodium, which
 * isn't bundled); when so, the backend returns a clear message and we surface it
 * as a toast — listing + delete still work.
 */
function openSecretsManager(): void {
  let settled = false;

  const card = el("div", "modal-card actions-secrets-card");
  const head = el("div", "actions-secrets-head");
  const h = el("div", "modal-title");
  h.textContent = l10n.t("Secrets & variables");
  const closeBtn = el("button", "icon-btn");
  closeBtn.appendChild(glyph("close"));
  closeBtn.title = l10n.t("Close (Esc)");
  closeBtn.setAttribute("aria-label", l10n.t("Close"));
  head.append(h, closeBtn);

  const secretsSection = el("div", "actions-secrets-section");
  const variablesSection = el("div", "actions-secrets-section");
  card.append(head, secretsSection, variablesSection);

  openModal((close) => {
    closeBtn.addEventListener("click", close);
    return {
      card,
      focusEl: closeBtn,
      label: l10n.t("Secrets and variables"),
      onClose: () => {
        settled = true;
      },
    };
  });

  const alive = (): boolean => !settled && card.isConnected;
  void renderSecretsSection(secretsSection, alive);
  void renderVariablesSection(variablesSection, alive);
}

/** Render the secrets list (name + updated) with an Add button and per-row delete. */
async function renderSecretsSection(section: HTMLElement, alive: () => boolean): Promise<void> {
  const reload = (): void => void renderSecretsSection(section, alive);
  // Creating a secret cannot succeed in this build (see main/github/actions.ts:
  // it needs libsodium to encrypt the value, which isn't bundled). The flow
  // asked for the name, then asked for the SECRET VALUE in a plain visible
  // field, and only then said so — a credential typed onto the screen for an
  // operation that was never going to run. Say it before, on the control.
  section.replaceChildren(
    sectionHeader(
      l10n.t("Secrets"),
      "lock",
      l10n.t("Add secret"),
      () => void addSecret(reload),
      CAN_SET_SECRETS ? undefined : SECRETS_UNAVAILABLE,
    ),
  );
  const listWrap = el("div", "actions-kv-list");
  listWrap.appendChild(loadingState(l10n.t("Loading secrets…")));
  section.appendChild(listWrap);

  let items: RepoSecretInfo[];
  try {
    items = await host.invoke("actions:secrets", undefined);
  } catch (e) {
    if (!alive()) return;
    listWrap.replaceChildren(
      errorState(l10n.t("Couldn't load secrets"), cleanErr(e) || l10n.t("GitHub request failed."), reload),
    );
    return;
  }
  if (!alive()) return;
  listWrap.replaceChildren();
  if (items.length === 0) {
    listWrap.appendChild(kvEmpty(l10n.t("No secrets defined for this repository.")));
    return;
  }
  for (const s of items) {
    const updated = relTimeISO(s.updatedAt);
    const row = kvRow(s.name, updated ? l10n.t("Updated {0}", updated) : "", s.updatedAt);
    const del = btn("row-btn danger");
    del.textContent = l10n.t("Delete");
    del.title = l10n.t("Delete the secret “{0}”", s.name);
    del.addEventListener("click", () => void deleteSecret(s.name, del, reload));
    row.appendChild(del);
    listWrap.appendChild(row);
  }
}

/** Render the variables list (name + value) with Add and per-row edit/delete. */
async function renderVariablesSection(section: HTMLElement, alive: () => boolean): Promise<void> {
  const reload = (): void => void renderVariablesSection(section, alive);
  section.replaceChildren(
    sectionHeader(
      l10n.t("Variables"),
      "symbol-variable",
      l10n.t("Add variable"),
      () => void addVariable(reload),
    ),
  );
  const listWrap = el("div", "actions-kv-list");
  listWrap.appendChild(loadingState(l10n.t("Loading variables…")));
  section.appendChild(listWrap);

  let items: RepoVariableInfo[];
  try {
    items = await host.invoke("actions:variables", undefined);
  } catch (e) {
    if (!alive()) return;
    listWrap.replaceChildren(
      errorState(l10n.t("Couldn't load variables"), cleanErr(e) || l10n.t("GitHub request failed."), reload),
    );
    return;
  }
  if (!alive()) return;
  listWrap.replaceChildren();
  if (items.length === 0) {
    listWrap.appendChild(kvEmpty(l10n.t("No variables defined for this repository.")));
    return;
  }
  for (const v of items) {
    const row = kvRow(v.name, v.value, v.updatedAt);
    const edit = btn("row-btn");
    edit.textContent = l10n.t("Edit");
    edit.title = l10n.t("Edit the variable “{0}”", v.name);
    edit.addEventListener("click", () => void editVariable(v, edit, reload));
    const del = btn("row-btn danger");
    del.textContent = l10n.t("Delete");
    del.title = l10n.t("Delete the variable “{0}”", v.name);
    del.addEventListener("click", () => void deleteVariable(v.name, del, reload));
    row.append(edit, del);
    listWrap.appendChild(row);
  }
}

/** A section header: an icon + title on the left, an Add button on the right. */
function sectionHeader(
  title: string,
  icon: string,
  addLabel: string,
  onAdd: () => void,
  /** Why the add action cannot be used. Given, the button is disabled and says
   *  so — rather than running a flow that always ends in a refusal. */
  unavailable?: string,
): HTMLElement {
  const head = el("div", "actions-kv-head");
  const lead = el("div", "actions-kv-headtitle");
  lead.append(glyph(icon), span(title));
  const add = btn("mini-btn");
  add.append(glyph("add"), span(addLabel));
  if (unavailable) {
    (add as HTMLButtonElement).disabled = true;
    add.title = unavailable;
    add.setAttribute("aria-label", l10n.t("{0} — {1}", addLabel, unavailable));
  } else {
    add.addEventListener("click", onAdd);
  }
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
    return l10n.t("Names may use only letters, digits, and underscores, and can't start with a digit.");
  }
  if (/^github_/i.test(name)) return l10n.t("Names can't start with the reserved “GITHUB_” prefix.");
  return null;
}

/**
 * Whether this build can create a secret.
 *
 * `main/github/actions.ts` `setSecret` refuses unconditionally: encrypting the
 * value needs libsodium, which isn't bundled. Typed as `boolean` deliberately —
 * the flow below is complete and correct, and starts working the moment that
 * changes; narrowing it to `false` would mark it dead.
 */
const CAN_SET_SECRETS: boolean = false;
/** Why, in one sentence — used on the disabled control AND in the guard, so
 *  the button and the flow can never tell different stories. */
const SECRETS_UNAVAILABLE = l10n.t(
  "Adding secrets needs the libsodium encryption library, which isn't bundled in this build. Add one on github.com; deleting works here.",
);

async function addSecret(reload: () => void): Promise<void> {
  // Before the first prompt, not after the second. The flow used to ask for the
  // name, then ask for the SECRET VALUE in a plain visible field, and only then
  // report that it could not save it.
  if (!CAN_SET_SECRETS) {
    toast(SECRETS_UNAVAILABLE, "info");
    return;
  }
  const name = await promptInline(l10n.t("New secret"), "SECRET_NAME", "", l10n.t("Next"));
  if (name == null) return;
  const bad = invalidName(name);
  if (bad) {
    toast(bad, "error");
    return;
  }
  const value = await promptInline(
    l10n.t("Value for {0}", name),
    l10n.t("Secret value"),
    "",
    l10n.t("Save secret"),
    true,
  );
  if (value == null) return;
  try {
    const r = await host.invoke("actions:setSecret", { name, value });
    if (!r.ok) {
      toast(r.message ?? l10n.t("Couldn't save the secret."), "error");
      return;
    }
    toast(l10n.t("Saved secret {0}.", name), "success");
    reload();
  } catch (e) {
    toast(cleanErr(e) || l10n.t("Couldn't save the secret."), "error");
  }
}

async function deleteSecret(
  name: string,
  btnEl: HTMLButtonElement,
  reload: () => void,
): Promise<void> {
  const confirmed = await confirmDialog({
    title: l10n.t("Delete secret {0}?", name),
    message: l10n.t("Workflows that reference this secret will lose access to it."),
    confirmLabel: l10n.t("Delete secret"),
    danger: true,
  });
  if (!confirmed) return;
  btnEl.disabled = true;
  try {
    const r = await host.invoke("actions:deleteSecret", name);
    if (!r.ok) {
      toast(r.message ?? l10n.t("Couldn't delete the secret."), "error");
      btnEl.disabled = false;
      return;
    }
    toast(l10n.t("Deleted secret {0}.", name), "success");
    reload();
  } catch (e) {
    toast(cleanErr(e) || l10n.t("Couldn't delete the secret."), "error");
    btnEl.disabled = false;
  }
}

async function addVariable(reload: () => void): Promise<void> {
  const name = await promptInline(l10n.t("New variable"), "VARIABLE_NAME", "", l10n.t("Next"));
  if (name == null) return;
  const bad = invalidName(name);
  if (bad) {
    toast(bad, "error");
    return;
  }
  const value = await promptInline(
    l10n.t("Value for {0}", name),
    l10n.t("Variable value"),
    "",
    l10n.t("Save variable"),
    true,
  );
  if (value == null) return;
  await saveVariable(name, value, reload);
}

async function editVariable(
  v: RepoVariableInfo,
  btnEl: HTMLButtonElement,
  reload: () => void,
): Promise<void> {
  const value = await promptInline(
    l10n.t("Edit {0}", v.name),
    l10n.t("Variable value"),
    v.value,
    l10n.t("Save"),
    true,
  );
  if (value == null) return;
  btnEl.disabled = true;
  await saveVariable(v.name, value, reload);
  btnEl.disabled = false;
}

async function saveVariable(name: string, value: string, reload: () => void): Promise<void> {
  try {
    const r = await host.invoke("actions:setVariable", { name, value });
    if (!r.ok) {
      toast(r.message ?? l10n.t("Couldn't save the variable."), "error");
      return;
    }
    toast(l10n.t("Saved variable {0}.", name), "success");
    reload();
  } catch (e) {
    toast(cleanErr(e) || l10n.t("Couldn't save the variable."), "error");
  }
}

async function deleteVariable(
  name: string,
  btnEl: HTMLButtonElement,
  reload: () => void,
): Promise<void> {
  const confirmed = await confirmDialog({
    title: l10n.t("Delete variable {0}?", name),
    message: l10n.t("Workflows that reference this variable will lose its value."),
    confirmLabel: l10n.t("Delete variable"),
    danger: true,
  });
  if (!confirmed) return;
  btnEl.disabled = true;
  try {
    const r = await host.invoke("actions:deleteVariable", name);
    if (!r.ok) {
      toast(r.message ?? l10n.t("Couldn't delete the variable."), "error");
      btnEl.disabled = false;
      return;
    }
    toast(l10n.t("Deleted variable {0}.", name), "success");
    reload();
  } catch (e) {
    toast(cleanErr(e) || l10n.t("Couldn't delete the variable."), "error");
    btnEl.disabled = false;
  }
}

// ── Run mutations (disable → invoke → toast → bust + re-render) ────────────────

// `id` is GitHub's internal run id — what the API takes. `num` is the run
// NUMBER the whole page wears (crumb, title, log page). Never print `id`: it
// appears nowhere else in the UI, so a dialog naming it asks about a run the
// user cannot find.
async function rerunRun(
  id: number,
  num: number,
  btn: HTMLButtonElement,
  reload: () => void,
): Promise<void> {
  btn.disabled = true;
  try {
    const r = await host.invoke("actions:rerun", id);
    if (!r.ok) {
      toast(r.message ?? l10n.t("Couldn't re-run."), "error");
      btn.disabled = false;
      return;
    }
    toast(l10n.t("Re-running run #{0}.", num), "success");
    reload();
  } catch (e) {
    toast(cleanErr(e) || l10n.t("Couldn't re-run."), "error");
    btn.disabled = false;
  }
}

async function rerunFailed(
  id: number,
  num: number,
  btn: HTMLButtonElement,
  reload: () => void,
): Promise<void> {
  btn.disabled = true;
  try {
    const r = await host.invoke("actions:rerunFailed", id);
    if (!r.ok) {
      toast(r.message ?? l10n.t("Couldn't re-run failed jobs."), "error");
      btn.disabled = false;
      return;
    }
    toast(l10n.t("Re-running failed jobs for run #{0}.", num), "success");
    reload();
  } catch (e) {
    toast(cleanErr(e) || l10n.t("Couldn't re-run failed jobs."), "error");
    btn.disabled = false;
  }
}

async function cancelRun(
  id: number,
  num: number,
  btn: HTMLButtonElement,
  reload: () => void,
): Promise<void> {
  const confirmed = await confirmDialog({
    title: l10n.t("Cancel run #{0}?", num),
    message: l10n.t("This stops the in-progress run on GitHub."),
    confirmLabel: l10n.t("Cancel run"),
    danger: true,
  });
  if (!confirmed) return;
  btn.disabled = true;
  try {
    const r = await host.invoke("actions:cancel", id);
    if (!r.ok) {
      toast(r.message ?? l10n.t("Couldn't cancel the run."), "error");
      btn.disabled = false;
      return;
    }
    toast(l10n.t("Cancelled run #{0}.", num), "success");
    reload();
  } catch (e) {
    toast(cleanErr(e) || l10n.t("Couldn't cancel the run."), "error");
    btn.disabled = false;
  }
}

// ── Dispatch flow (modal) ─────────────────────────────────────────────────────

/**
 * Open the dispatch flow from the toolbar: pop a picker of active workflows
 * (anchored on the Run button), then open that workflow's dispatch modal.
 */
async function openDispatch(anchor: HTMLElement, refresh: () => void): Promise<void> {
  let wfs: WorkflowInfo[];
  try {
    wfs = await gget("actions:workflows", undefined, 60000);
  } catch (e) {
    toast(cleanErr(e) || l10n.t("Couldn't load workflows."), "error");
    return;
  }
  const active = wfs.filter((w) => w.state === "active");
  if (active.length === 0) {
    toast(l10n.t("No runnable workflows in this repo."), "info");
    return;
  }
  if (active.length === 1) {
    void showDispatchModal(active[0], refresh);
    return;
  }
  openMenu(
    anchor,
    active.map((w) => ({
      label: w.name,
      // The full path truncated exactly where the rows stop being identical,
      // so every one read ".github/workflows/…". The file name is the part
      // that distinguishes them.
      sub: w.path.split("/").pop() ?? w.path,
      icon: "play",
      onClick: () => void showDispatchModal(w, refresh),
    })),
  );
}

/** The dispatch form (ref picker + parsed inputs) as a modal card. */
async function showDispatchModal(w: WorkflowInfo, refresh: () => void): Promise<void> {
  let inputs: WorkflowDispatchInput[];
  try {
    inputs = await host.invoke("actions:dispatchInputs", w.id);
  } catch (e) {
    toast(cleanErr(e) || l10n.t("Couldn't read the workflow's inputs."), "error");
    return;
  }
  const [refOptions, currentRef] = await Promise.all([loadRefOptions(), currentBranchName()]);

  openModal((close) => {
    const card = el("div", "modal-card gh-pr-form actions-dispatch-card");
    const h = el("div", "modal-title");
    h.textContent = l10n.t("Run “{0}”", w.name);
    const sub = el("div", "actions-dispatch-path");
    sub.textContent = w.path;
    card.append(h, sub);

    const refField = comboField({
      label: l10n.t("Branch or tag (ref)"),
      placeholder: l10n.t("Search branches and tags…"),
      value: currentRef,
      options: refOptions,
      rowClass: "gh-form-row",
      labelClass: "gh-form-label",
      inputClass: "modal-input",
    });
    card.appendChild(refField.row);

    const getters: { name: string; get: () => string }[] = [];
    for (const inp of inputs) {
      const label = inp.name + (inp.required ? " *" : "");
      if (inp.options && inp.options.length) {
        const row = el("label", "gh-form-row");
        row.append(span(label, "gh-form-label"));
        const sel = document.createElement("select");
        sel.className = "gh-form-select";
        for (const opt of inp.options) {
          const o = document.createElement("option");
          o.value = opt;
          o.textContent = opt;
          if (opt === inp.default) o.selected = true;
          sel.appendChild(o);
        }
        if (inp.description) sel.title = inp.description;
        row.appendChild(sel);
        card.appendChild(row);
        getters.push({ name: inp.name, get: () => sel.value });
      } else {
        const row = el("label", "gh-form-row");
        row.append(span(label, "gh-form-label"));
        const input = document.createElement("input");
        input.className = "modal-input";
        input.placeholder =
          inp.type === "boolean" ? l10n.t("true / false") : inp.description || inp.name;
        input.value = inp.default ?? "";
        if (inp.description) input.title = inp.description;
        row.appendChild(input);
        card.appendChild(row);
        getters.push({ name: inp.name, get: () => input.value.trim() });
      }
    }
    if (inputs.length === 0) {
      const note = el("div", "gh-dispatch-note");
      note.textContent = l10n.t(
        "This workflow declares no inputs. It will run on the ref you choose above.",
      );
      card.appendChild(note);
    }

    const actions = el("div", "modal-actions");
    const cancel = btn("mini-btn");
    cancel.append(span(l10n.t("Cancel")));
    cancel.addEventListener("click", close);
    const submit = btn("btn btn-primary modal-ok");
    submit.append(glyph("play"), span(l10n.t("Run workflow")));
    submit.addEventListener("click", () => {
      const ref = refField.input.value.trim();
      if (!ref) {
        refField.input.focus();
        toast(l10n.t("A ref (branch or tag) is required."), "error");
        return;
      }
      const map: Record<string, string> = {};
      for (const g of getters) {
        const v = g.get();
        if (v !== "") map[g.name] = v;
      }
      submit.disabled = true;
      void (async () => {
        try {
          const r = await host.invoke("actions:dispatch", { workflowId: w.id, ref, inputs: map });
          if (!r.ok) {
            toast(r.message ?? l10n.t("Couldn't start the workflow."), "error");
            submit.disabled = false;
            return;
          }
          toast(l10n.t("Dispatched “{0}” on {1}.", w.name, ref), "success");
          close();
          bust("actions");
          actionsTabState().actionsTab = "runs";
          refresh();
        } catch (e) {
          toast(cleanErr(e) || l10n.t("Couldn't start the workflow."), "error");
          submit.disabled = false;
        }
      })();
    });
    actions.append(cancel, submit);
    card.appendChild(actions);

    return {
      card,
      focusEl: refField.input,
      label: l10n.t("Run workflow {0}", w.name),
      onClose: () => {},
    };
  });
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
      else if (r.type === "remote" && !isRemoteHead(r)) {
        // Not the remote's HEAD, which git names "origin": it has no slash to
        // strip, and was offered as a branch called "origin".
        const short = r.name.replace(/^[^/]+\//, ""); // "origin/feat" → "feat"
        if (short) branches.add(short);
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
  if (!state) return "";
  const map: Record<string, string> = {
    success: l10n.t("success"),
    failure: l10n.t("failure"),
    in_progress: l10n.t("in progress"),
    queued: l10n.t("queued"),
    cancelled: l10n.t("cancelled"),
    canceled: l10n.t("cancelled"),
    skipped: l10n.t("skipped"),
    timed_out: l10n.t("timed out"),
    action_required: l10n.t("action required"),
    neutral: l10n.t("neutral"),
    startup_failure: l10n.t("startup failure"),
    stale: l10n.t("stale"),
    waiting: l10n.t("waiting"),
    requested: l10n.t("requested"),
    pending: l10n.t("pending"),
    completed: l10n.t("completed"),
  };
  return map[state] ?? state.replace(/_/g, " ");
}
