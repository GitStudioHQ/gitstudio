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
import { el, span, glyph, cleanErr, errorState, skeletonList } from "../ui";
import { toast } from "../dialogs";
import { detailPage, type SectionTarget, type SectionNav } from "./common";
import { createLogPane, type LogPane } from "../logView";
import { setPageLabel, setPageTarget } from "../navStack";
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
  /** A tail loop is running for this session. A job opened while QUEUED has
   *  none, and needs one started the moment the runner picks it up. */
  tailing: boolean;
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
  main.appendChild(skeletonList(3, false));

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
  /** Watches for this page leaving the document — see `watchPageDetach`. */
  let detachObs: MutationObserver | undefined;

  /** Status as of the freshest poll — the tail asks before every delta. */
  const statusOf = (id: number): string => jobs.find((j) => j.id === id)?.status ?? "";

  /** Poll deltas while the job runs; back off to 8s after two quiet polls. */
  const tail = (s: Session): void => {
    if (s.tailing) return;
    s.tailing = true;
    // The pane may have been built for a QUEUED job — `live: false`, Follow
    // disabled, no pill — and only now has the runner picked it up. Tell it,
    // or it spends the rest of the run unable to follow the output it is
    // receiving.
    s.pane.setProducing(true);
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
          else {
            s.tailing = false;
            s.pane.finish();
          }
        })();
      }, s.unchangedPolls >= 2 ? 8000 : 4000);
    };
    step();
  };

  /**
   * Tear the pane down when this PAGE goes away, not only when the job changes.
   *
   * `destroy()` was called on a job SWITCH, so leaving the page — Back, the
   * rail, a deep link, ⌘[ — left the last session's pane alive: its window
   * resize listener still attached, and its whole parsed document (up to
   * 200,000 lines, plus the ANSI spans for the window it had rendered) still
   * reachable from that listener's closure. Open six runs' logs in a session
   * and six of them are held for the life of the window.
   *
   * A mutation observer, the same shape the PR diff panel uses for the same
   * reason: nothing else fires on the way out of a section view.
   */
  const watchPageDetach = (): void => {
    detachObs?.disconnect();
    const obs = new MutationObserver(() => {
      if (view.isConnected) return;
      obs.disconnect();
      detachObs = undefined;
      if (session) {
        session.alive = false;
        session.pane.destroy();
        session = undefined;
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    detachObs = obs;
  };

  const openJob = async (j: WorkflowJob): Promise<void> => {
    currentId = j.id;
    // Tell the history WHICH job, or a refresh re-routes with the job this page
    // was entered on and swaps the reader's output out from under them.
    setPageTarget({ jobId: j.id });
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
    watchPageDetach();
    const pane = createLogPane({
      fill: true,
      // Follow only a job that is still producing. A completed log opens at the
      // TOP, where a document starts — it used to slam to the last line before
      // you had read a word of it.
      live: statusOf(j.id) === "in_progress",
      queued: statusOf(j.id) === "queued",
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
    const s: Session = { jobId: j.id, pane, offset: 0, unchangedPolls: 0, alive: true, tailing: false };
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
        // "Already reading it" — unless it has since started producing and this
        // session never got a tail, in which case re-clicking is the only thing
        // the reader can do and it used to do nothing at all.
        const stuck = !!session && !session.tailing && statusOf(j.id) === "in_progress";
        if (j.id === currentId && session && !stuck) return;
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
          // A job you opened while it was QUEUED has no tail: openJob decides
          // liveness once, and a queued job takes the "finished document"
          // branch. The runner then picks it up, the rail visibly flips to
          // in_progress — and the log stays frozen for the rest of the run,
          // with a re-click blocked by the "already reading it" guard. The
          // poll already knows the moment it changes, so it starts the tail.
          if (session?.alive && !session.tailing && statusOf(session.jobId) === "in_progress") {
            tail(session);
          }
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
    // ⌘K is the command palette, everywhere in this app. Unmodified j/k only —
    // otherwise opening the palette from the log page ALSO stepped the rail to
    // the previous job, so you came back from the palette looking at a
    // different job's output than the one you left.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
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
