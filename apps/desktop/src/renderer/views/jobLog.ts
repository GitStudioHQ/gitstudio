// The job log, as a PAGE.
//
// The log used to live in a pane inside the run detail page, which meant two
// nested scroll contexts and a viewport of whatever was left over. Measured:
// 523px of log inside a 913px window, on a page that itself scrolled 1,048px.
//
// The owner reported it twice: "scrolling the logs is still trash ux, its too
// fast and not easy to use and practical at all" and, after the pane was made
// taller, "scrolling is too fast and the log window is too small, pls do it
// properly, you havent even touched that part."
//
// Making the pane bigger was treating the symptom. A CI log is a document you
// read, sometimes tens of thousands of lines of it, and it needs the window —
// not a box inside a page that also scrolls. So: its own route, the jobs in a
// rail beside it, and the log filling everything else. The chunked loader, the
// live tail and the save-to-Downloads action moved here with it; the run page
// no longer hosts logs at all, which also ends the two-entry-points-leave-the
// -card-in-different-states class of bug.

import { host } from "../bridge";
import { el, span, glyph, cleanErr, errorState } from "../ui";
import { toast } from "../dialogs";
import { detailPage, type SectionTarget, type SectionNav } from "./common";
import { createLogPane, type LogPane } from "../logView";
import { setPageLabel } from "../navStack";
import type { WorkflowRunDetail, WorkflowJob } from "../../shared/ipc";

/** A job's state as one glyph, so the rail scans vertically. */
function jobGlyph(j: WorkflowJob): HTMLElement {
  const done = j.conclusion || "";
  if (done === "success") return glyph("pass-filled");
  if (done === "failure" || done === "timed_out") return glyph("error");
  if (done === "cancelled" || done === "skipped") return glyph("circle-slash");
  if (j.status === "in_progress") return glyph("sync");
  return glyph("circle-outline");
}

function jobClass(j: WorkflowJob): string {
  const done = j.conclusion || "";
  if (done === "success") return "is-ok";
  if (done === "failure" || done === "timed_out") return "is-fail";
  if (j.status === "in_progress") return "is-running";
  return "is-idle";
}

function jobWhen(j: WorkflowJob): string {
  if (!j.startedAt) return j.status === "queued" ? "queued" : "";
  if (!j.completedAt) return "running";
  const s = Math.max(0, Math.round((Date.parse(j.completedAt) - Date.parse(j.startedAt)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Everything one open job needs; torn down when another job is picked. */
interface Session {
  jobId: number;
  pane: LogPane;
  offset: number;
  unchangedPolls: number;
  alive: boolean;
}

export async function renderJobLog(
  wrap: HTMLElement,
  nav: SectionNav,
  target: SectionTarget | undefined,
): Promise<void> {
  const runId = target?.number;
  const { view, main, rail, topActions } = detailPage({
    backLabel: "Actions",
    crumb: runId ? `Run ${runId}` : "Log",
    onBack: () => nav("actions", { number: runId }),
  });
  view.classList.add("joblog-view");
  rail.remove();
  wrap.replaceChildren(view);

  if (!runId) {
    main.replaceChildren(errorState("No run", "Nothing was asked for."));
    return;
  }

  let d: WorkflowRunDetail | undefined;
  try {
    d = await host.invoke("actions:runDetail", runId);
  } catch (e) {
    if (!view.isConnected) return;
    main.replaceChildren(
      errorState("Couldn't load this run", cleanErr(e) || "GitHub request failed.", () =>
        void renderJobLog(wrap, nav, target),
      ),
    );
    return;
  }
  if (!view.isConnected) return;
  if (!d) {
    main.replaceChildren(errorState("Couldn't load this run", "The run could not be read."));
    return;
  }

  const run = d.run;
  const runNo = run.runNumber || run.id;
  setPageLabel(`Run #${runNo} log`);
  // The crumb names the log you are READING, not just the run — on a matrix
  // build "#411" alone leaves the page unable to say which of nine jobs is on
  // screen. Updated as jobs are switched, below.
  const crumb = view.querySelector(".det-crumb");
  const setCrumb = (jobName?: string): void => {
    if (crumb) crumb.textContent = jobName ? `#${runNo} · ${jobName}` : `#${runNo}`;
  };
  setCrumb();

  const split = el("div", "joblog-split");
  const jobsCol = el("div", "joblog-jobs");
  jobsCol.setAttribute("role", "list");
  jobsCol.setAttribute("aria-label", "Jobs in this run");
  const logCol = el("div", "joblog-log");
  split.append(jobsCol, logCol);
  main.replaceChildren(split);

  // The failing job first when nothing was asked for: on a failed run that is
  // the reason you opened it, and making someone pick it out of a list is a
  // step with no decision in it.
  let jobs = d.jobs;
  const failing = jobs.find((j) => j.conclusion === "failure" || j.conclusion === "timed_out");
  let currentId = target?.jobId ?? failing?.id ?? jobs[0]?.id;

  const rows = new Map<number, HTMLElement>();
  let session: Session | undefined;

  /** Status as of the freshest poll — the tail asks before every delta. */
  const statusOf = (id: number): string => jobs.find((j) => j.id === id)?.status ?? "";

  /** Poll deltas while the job runs; back off to 8s after two quiet polls. */
  const tail = (s: Session): void => {
    const step = (): void => {
      window.setTimeout(() => {
        void (async () => {
          if (!s.alive || !view.isConnected) return;
          const live = statusOf(s.jobId) === "in_progress";
          try {
            const chunk = await host.invoke("actions:jobLogChunk", {
              jobId: s.jobId,
              offset: s.offset,
            });
            if (!s.alive) return;
            if (chunk.reset) s.pane.reset(chunk.text, { truncated: chunk.truncated });
            else if (chunk.text) s.pane.append(chunk.text);
            s.unchangedPolls = chunk.text ? 0 : s.unchangedPolls + 1;
            s.offset = chunk.totalLength;
          } catch {
            s.unchangedPolls++;
          }
          if (live) step();
          else s.pane.finish();
        })();
      }, s.unchangedPolls >= 2 ? 8000 : 4000);
    };
    step();
  };

  const openJob = async (j: WorkflowJob): Promise<void> => {
    currentId = j.id;
    setCrumb(j.name);
    for (const [id, row] of rows) {
      const on = id === j.id;
      row.classList.toggle("is-current", on);
      row.setAttribute("aria-current", on ? "true" : "false");
    }

    // One session at a time: the previous pane's tail stops on `alive`, so a
    // delta that was already in flight can't paint into the log you replaced.
    if (session) {
      session.alive = false;
      session.pane.destroy();
    }
    const pane = createLogPane({
      fill: true,
      ariaLabel: `Log for ${j.name}`,
      onCopy: () => host.invoke("actions:jobLog", { jobId: j.id }),
      onDownload: () => {
        void host.invoke("actions:saveLog", { jobId: j.id, name: j.name }).then((r) => {
          toast(
            r.ok ? (r.message ?? "Log saved.") : (r.message ?? "Couldn't save the log."),
            r.ok ? "success" : "error",
          );
        });
      },
    });
    const s: Session = { jobId: j.id, pane, offset: 0, unchangedPolls: 0, alive: true };
    session = s;
    logCol.replaceChildren(pane.el);

    try {
      const chunk = await host.invoke("actions:jobLogChunk", { jobId: j.id, offset: 0 });
      if (!s.alive) return;
      pane.reset(chunk.text, { truncated: chunk.truncated });
      s.offset = chunk.totalLength;
      if (statusOf(j.id) === "in_progress") tail(s);
      else pane.finish();
    } catch (e) {
      if (!s.alive) return;
      logCol.replaceChildren(
        errorState("Couldn't load this log", cleanErr(e) || "GitHub request failed.", () =>
          void openJob(j),
        ),
      );
    }
  };

  const paintRows = (): void => {
    rows.clear();
    jobsCol.replaceChildren();
    for (const j of jobs) {
      const row = el("button", `joblog-job ${jobClass(j)}`) as HTMLButtonElement;
      row.setAttribute("role", "listitem");
      row.append(jobGlyph(j));
      const meta = el("span", "joblog-job-meta");
      meta.appendChild(span(j.name, "joblog-job-name"));
      const when = jobWhen(j);
      if (when) meta.appendChild(span(when, "joblog-job-when"));
      row.appendChild(meta);
      row.title = `${j.name} — ${j.conclusion || j.status}`;
      row.setAttribute("aria-label", row.title);
      row.classList.toggle("is-current", j.id === currentId);
      row.setAttribute("aria-current", j.id === currentId ? "true" : "false");
      row.addEventListener("click", () => {
        if (j.id === currentId && session) return; // already reading it
        void openJob(j);
      });
      rows.set(j.id, row);
      jobsCol.appendChild(row);
    }
  };
  paintRows();

  // A live run keeps the rail honest — job states change under you — but the
  // LOG is never rebuilt by the poll: it has its own tail, and a repaint that
  // reset the reader's scroll position is exactly what a tail must not do.
  const pollJobs = (): void => {
    if (!jobs.some((j) => j.status === "in_progress" || j.status === "queued")) return;
    window.setTimeout(() => {
      if (!view.isConnected) return;
      host
        .invoke("actions:runDetail", runId)
        .then((fresh) => {
          if (!view.isConnected || !fresh) return;
          const sig = JSON.stringify(fresh.jobs.map((j) => [j.id, j.status, j.conclusion]));
          const was = JSON.stringify(jobs.map((j) => [j.id, j.status, j.conclusion]));
          jobs = fresh.jobs;
          if (sig !== was) paintRows();
          pollJobs();
        })
        .catch(() => pollJobs());
    }, 8000);
  };
  pollJobs();

  const open = jobs.find((j) => j.id === currentId) ?? jobs[0];
  if (open) void openJob(open);
  else logCol.replaceChildren(errorState("No jobs", "This run has no jobs to show."));

  // `j` and `k` walk the rail without leaving the log's keyboard: reading one
  // job's failure and then the next is the whole reason a matrix run is open.
  view.addEventListener("keydown", (e) => {
    if (e.key !== "j" && e.key !== "k") return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    const i = jobs.findIndex((x) => x.id === currentId);
    const next = jobs[i + (e.key === "j" ? 1 : -1)];
    if (!next) return;
    e.preventDefault();
    void openJob(next);
    rows.get(next.id)?.scrollIntoView({ block: "nearest" });
  });

  // The run page is one click away, for the parts of a run that are not the log.
  const toRun = el("button", "mini-btn") as HTMLButtonElement;
  toRun.append(glyph("list-unordered"), span("Run details"));
  toRun.title = "Steps, artifacts and re-run controls for this run";
  toRun.addEventListener("click", () => nav("actions", { number: runId }));
  topActions.appendChild(toRun);
}
