// The log pane — a virtualized, ANSI-aware, foldable, searchable, live-tail
// log surface (docs/desktop-redesign.md "Depth guarantees"). One pane per job;
// The log is a PAGE now (views/jobLog.ts), not a pane re-slotted into a run
// page's job cards on every repaint — so there is no save/restoreViewport
// either; nothing re-slots a pane any more.
//
// Rendering model: every line is a fixed --log-line-h row; a `visible` array
// maps render positions → doc line indices (lines inside collapsed ##[group]
// ranges drop out). Only the scrolled-into-view window (± overscan) exists in
// the DOM — top/bottom spacer divs carry the rest of the height, so a 200k-line
// log costs ~120 nodes.

import {
  appendLog,
  emptyLogDoc,
  finishLog,
  parseAnsi,
  stripAnsi,
  type LogDoc,
  type LogGroup,
  type LogLine,
} from "./logModel";
import { el, glyph, span } from "./ui";
import { searchField } from "./views/common";

const LINE_H = 20;
const OVERSCAN = 30;
/** Render-window guardrail — beyond this we keep the newest lines + a banner. */
export const MAX_RENDER_LINES = 200_000;

export interface LogPane {
  el: HTMLElement;
  /** Replace the whole content (initial load, or a live-tail reset). */
  reset(text: string, o?: { truncated?: boolean }): void;
  /** Append a live-tail delta. */
  append(delta: string): void;
  /** The log's producer finished — flush the last partial line. */
  finish(): void;
  /**
   * The producer STARTED after the pane was built.
   *
   * A job opened while queued is created with `live: false`, so it has nothing
   * to follow and Follow is correctly dead. When the runner picks it up the
   * tail starts — but the pane was never told, so Follow stayed disabled and
   * "Jump to latest" never appeared for the whole rest of the run. Liveness is
   * not decided once; it is a state the job moves through.
   */
  setProducing(on: boolean): void;
  setFollow(on: boolean): void;
  destroy(): void;
}

export function createLogPane(o: {
  ariaLabel: string;
  onCopy: () => string | Promise<string>;
  onDownload?: () => void;
  /**
   * The pane IS the page: it fills its container instead of capping itself, and
   * its expand control widens it over the job list rather than growing a box.
   *
   * A log read inside a pane on a scrolling page gets whatever height is left
   * over — measured at 523px of a 913px window — and that is the "the log
   * window is too small" report. On its own route there is nothing to leave
   * over.
   */
  fill?: boolean;
  /**
   * The producer is still running, so start following the tail.
   *
   * "following active logging is one thing, but scrolling super fast or instead
   * of me is pure ragebait." Following a FINISHED log is not following, it is
   * just jumping you to the end of a document you have not read yet.
   */
  live?: boolean;
  /**
   * The job exists but no runner has picked it up. Distinct from `live: false`,
   * which on its own cannot tell "finished" from "not started".
   */
  queued?: boolean;
}): LogPane {
  let doc: LogDoc = emptyLogDoc();
  const collapsed = new Set<number>(); // group START line indices
  let visible: number[] = [];
  // Following is a MODE, and it belongs to the caller: a job that will never
  // produce another byte has nothing to follow, and arming it there is what
  // slammed every log you opened straight to its last line.
  let follow = !!o.live;
  /** The producer is still running, so "the tail moved on without you" is a
   *  thing that can happen. On a finished log it cannot, and a pill offering to
   *  jump to a latest that is not moving is just an unlabelled End key. */
  let producing = !!o.live;
  /**
   * The job has not been picked up by a runner yet.
   *
   * "Not producing" covers two OPPOSITE situations — finished, and not started
   * — and they want opposite words. The pane cannot tell them apart on its own
   * (both are simply `live: false`), and inferring it from "has this pane ever
   * produced" gets a job that was already finished when opened exactly
   * backwards. So the caller, which knows the job's status, says.
   */
  let notStarted = !!o.queued;
  let showTs = false;
  let capped = false; // over MAX_RENDER_LINES — oldest dropped
  /**
   * How many lines have been spliced off the FRONT by the cap.
   *
   * The gutter numbers a row by its index in `doc.lines`, which restarts at 0
   * every time the cap drops lines — so a capped log numbered its first visible
   * row "1" when it was really line 50,001, and every error tick's "Error on
   * line N" named a line 50,000 rows from the one it pointed at. The number in
   * the gutter has to be the line's number in the JOB'S output, not its offset
   * into the window we happen to be holding.
   */
  let droppedLines = 0;
  let truncatedTail = false; // main sent only the 8MB tail window
  let query = "";
  let matches: number[] = []; // doc line indices
  let matchIdx = -1;
  let raf = 0;
  let rafTimer = 0;
  let destroyed = false;

  const root = el("div", "log-pane" + (o.fill ? " log-fill" : ""));
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", o.ariaLabel);

  // ── toolbar ──
  const bar = el("div", "log-toolbar");
  const errChip = el("button", "log-chip log-chip-err");
  errChip.title = "Jump between errors";
  errChip.hidden = true;
  const search = searchField({
    placeholder: "Search log…",
    onInput: (q) => {
      query = q;
      rebuildMatches();
      // HIGHLIGHT, do not travel. This used to jump the viewport to the first
      // match on every keystroke, so typing "err" hard-scrolled to three
      // different places before you had finished the word — the other half of
      // "scrolling instead of me". Enter (and the two step buttons) go; typing
      // only paints and counts.
      matchIdx = -1;
      matchCounter.textContent = matches.length
        ? `${matches.length} match${matches.length === 1 ? "" : "es"}`
        : q.trim()
          ? "no matches"
          : "";
      render();
    },
  });
  search.classList.add("log-search");
  const matchCounter = span("", "log-match-count");
  let matchStepSync: (() => void) | undefined;
  // These were five identical unlabelled squares, and their titles never
  // changed with their state — "Show timestamps" still read "Show timestamps"
  // while timestamps were showing. The clock-with-arrow icon also universally
  // means "history", not "timestamps".
  //
  // The two STATE toggles now carry their names, because a toggle you can't
  // read is a toggle you can't trust — "is this log showing timestamps?" has
  // to be answerable without hovering. The three transient verbs (copy, save,
  // expand) stay icons: they're momentary, universally drawn, and grouped
  // behind a hairline so the bar reads as [state] | [actions].
  const tsBtn = toolBtn("watch", "Show timestamps", () => {
    showTs = !showTs;
    tsBtn.classList.toggle("is-on", showTs);
    tsBtn.title = showTs ? "Hide timestamps" : "Show timestamps";
    tsBtn.setAttribute("aria-label", tsBtn.title);
    tsBtn.setAttribute("aria-pressed", String(showTs));
    render();
  }, "Timestamps");
  tsBtn.setAttribute("aria-pressed", "false");
  const followBtn = toolBtn(
    "fold-down",
    "Follow the newest output",
    () => setFollow(!follow),
    "Follow",
  ) as HTMLButtonElement;
  // NOT a hand-stamped "false": `follow` starts ON, so a literal here made the
  // button open lit while announcing itself off. setFollow is the only writer;
  // it is called once below, after it is defined, to paint the initial state.
  const copyBtn = toolBtn("copy", "Copy the full log", () => {
    void Promise.resolve(o.onCopy()).then((t) => navigator.clipboard.writeText(t).catch(() => {}));
  });
  const dlBtn = o.onDownload ? toolBtn("cloud-download", "Save the full log to Downloads", o.onDownload) : null;
  const expandTitles = o.fill
    ? { on: "Show the job list", off: "Use the full width" }
    : { on: "Shrink the pane", off: "Expand the pane" };
  const expandBtn = toolBtn("screen-full", expandTitles.off, () => {
    // Resizing the pane changes its scroll height, which the scroll listener
    // reads as "the user scrolled away from the bottom" and silently turns
    // follow OFF, dumping you into the middle of the log. Resizing is not
    // scrolling: remember the mode and restore it.
    const wasFollowing = follow;
    const max = root.classList.toggle("log-max");
    expandBtn.title = max ? expandTitles.on : expandTitles.off;
    expandBtn.setAttribute("aria-label", expandBtn.title);
    render();
    // Expanding to 78vh while the pane sits ~320px down the page pushed its
    // tail — the error line, the toolbar's own controls — below the fold, so
    // "expand" made the thing you wanted LESS visible. Bring it into view.
    // On a filled page there is nothing to scroll to: the pane is the page.
    if (max && !o.fill) root.scrollIntoView({ block: "start", behavior: "smooth" });
    if (wasFollowing) setFollow(true);
  });
  // Stepping through matches was Enter-only and unadvertised, so a search that
  // found 40 hits gave you the first one and no way to reach the other 39
  // unless you guessed. Two buttons, disabled until there is something to step.
  const prevMatch = toolBtn("chevron-up", "Previous match (Shift+Enter)", () =>
    jumpToMatch(matchIdx < 0 ? matches.length - 1 : matchIdx - 1),
  );
  const nextMatch = toolBtn("chevron-down", "Next match (Enter)", () =>
    jumpToMatch(matchIdx < 0 ? 0 : matchIdx + 1),
  );
  prevMatch.classList.add("log-match-step");
  nextMatch.classList.add("log-match-step");
  const syncMatchSteps = (): void => {
    // Enabled from ONE match, not two: typing no longer travels to the first
    // hit, so with a single match the step button is the only way to reach it.
    for (const b of [prevMatch, nextMatch]) (b as HTMLButtonElement).disabled = matches.length < 1;
  };
  syncMatchSteps();
  matchStepSync = syncMatchSteps;

  bar.append(
    errChip,
    search,
    matchCounter,
    prevMatch,
    nextMatch,
    span("", "log-toolbar-spring"),
    tsBtn,
    followBtn,
    el("span", "log-toolbar-div"),
    copyBtn,
  );
  if (dlBtn) bar.appendChild(dlBtn);
  bar.appendChild(expandBtn);
  root.appendChild(bar);

  // ── banners + scroller ──
  const banner = el("div", "log-banner");
  banner.hidden = true;
  root.appendChild(banner);
  const scroll = el("div", "log-scroll");
  // A log is a document you READ, so it has to be able to take the keyboard.
  // Without a tabindex the scroller was unreachable by Tab and answered no key
  // at all: the only way through 50,000 lines was a trackpad, against a
  // sixteen-line port. `role="log"` tells assistive tech what it is, and
  // `aria-label` names which job's output this is.
  scroll.tabIndex = 0;
  scroll.setAttribute("role", "log");
  scroll.setAttribute("aria-label", "Job log");
  const top = el("div", "log-spacer");
  const win = el("div", "log-window");
  const bottom = el("div", "log-spacer");
  scroll.append(top, win, bottom);
  // The scroller and the two things that FLOAT over it share a positioned
  // wrapper. Both were briefly children of the scroller itself, where a sticky
  // element that is the last child sticks only once its own place scrolls into
  // view — i.e. at the very end of a 20,000-line log, which is nowhere.
  const body = el("div", "log-body");
  body.appendChild(scroll);
  // Which ##[group] the top of the port is inside. A CI log is mostly group
  // CONTENTS, and scrolling past the header that named them leaves you reading
  // 400 lines of output with no idea which step produced it — the other half of
  // "not easy to use and practical at all". Click it to jump back to its header.
  const groupBar = el("button", "log-groupbar");
  groupBar.hidden = true;
  groupBar.title = "Jump to the start of this step";
  body.appendChild(groupBar);
  // Where the errors ARE, over the whole log rather than the screenful you can
  // see. A 20,000-line log has no shape without it: you scroll and hope. Each
  // tick is a click that lands on that failure.
  const errMap = el("div", "log-errmap");
  errMap.setAttribute("aria-hidden", "true"); // the error chip + `n` are the accessible path
  body.appendChild(errMap);
  root.appendChild(body);
  const jumpPill = el("button", "log-jump");
  jumpPill.append(glyph("arrow-down"), span("Jump to latest"));
  jumpPill.hidden = true;
  jumpPill.addEventListener("click", () => setFollow(true));
  root.appendChild(jumpPill);

  /** An icon button; pass `label` to spell the control out beside its glyph. */
  function toolBtn(
    icon: string,
    title: string,
    onClick: () => void,
    label?: string,
  ): HTMLElement {
    const b = el("button", "icon-btn log-tool" + (label ? " has-label" : ""));
    b.title = title;
    b.setAttribute("aria-label", title);
    b.appendChild(glyph(icon));
    if (label) b.appendChild(span(label, "log-tool-label"));
    b.addEventListener("click", onClick);
    return b;
  }

  /** Is the viewport already at the tail? */
  function atTail(): boolean {
    return scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - LINE_H;
  }

  /**
   * The Follow button's own state, and the pill's.
   *
   * A finished job has nothing to follow, so the button is DISABLED and says
   * why. It used to stay enabled, reporting `aria-pressed="false"` before and
   * after — while a press jumped you to the last line. A control that performs
   * End under a label reading Follow, and then denies having done anything, is
   * worse than one that refuses.
   */
  function syncFollowBtn(): void {
    followBtn.disabled = !producing;
    followBtn.classList.toggle("is-on", follow);
    followBtn.title = !producing
      ? notStarted
        ? "This job hasn't started yet — there is nothing to follow"
        : "This job has finished — there is nothing left to follow"
      : follow
        ? "Following the newest output"
        : "Follow the newest output";
    followBtn.setAttribute("aria-label", followBtn.title);
    followBtn.setAttribute("aria-pressed", String(follow));
    // The pill offers to take you to a tail that has moved on WITHOUT you. It
    // needs a moving tail (producing), the reader to be away from it, and
    // follow to be off — the third alone put a "Jump to latest" over a reader
    // sitting on the last line, pointing at the row under their cursor.
    jumpPill.hidden = follow || !producing || visible.length === 0 || atTail();
  }

  function setFollow(on: boolean): void {
    // You cannot follow a producer that has stopped. The button is disabled
    // there, so this only guards the keyboard and programmatic callers.
    if (on && !producing) {
      syncFollowBtn();
      return;
    }
    follow = on;
    syncFollowBtn();
    if (on) {
      scroll.scrollTop = scroll.scrollHeight;
      render();
      syncFollowBtn();
    }
  }

  // Paint the initial state through the ONE writer, so what the button looks
  // like and what it announces can never start out disagreeing.
  followBtn.classList.toggle("is-on", follow);
  followBtn.title = follow ? "Following the newest output" : "Follow the newest output";
  followBtn.setAttribute("aria-label", followBtn.title);
  followBtn.setAttribute("aria-pressed", String(follow));

  // Scrolling AWAY from the bottom stops following — that is the reader saying
  // "stop moving". Scrolling BACK to the bottom does NOT start it again: it
  // used to, so reading to the end of a live log silently re-armed the tail and
  // the next 4-second poll yanked you away from the line you were on. Following
  // resumes only when the reader asks: the Follow button, or the pill.
  scroll.addEventListener("scroll", () => scheduleScrollFrame());

  /**
   * Damped wheel scrolling.
   *
   * "scrolling super fast ... is pure ragebait." A 20px line against a trackpad
   * flick — which delivers 2,000-4,000px of momentum — is a hundred-plus lines
   * of monospace going past with nothing readable on the way. Native speed is
   * tuned for prose and images, not for a wall of fixed-width text you are
   * SCANNING. Halving it is the difference between skimming and teleporting,
   * and a single event can never move more than one screenful however large a
   * delta the OS synthesises.
   *
   * Pixel-mode, vertical-dominant events only: line/page mode (some mice),
   * horizontal intent, and zoom gestures are left entirely alone.
   */
  const WHEEL_SCALE = 0.45;
  scroll.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return; // zoom / OS gestures
      if (e.deltaMode !== 0) return; // not pixels — leave it native
      if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return; // horizontal intent
      if (!e.deltaY) return;
      e.preventDefault();
      const step = Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY) * WHEEL_SCALE, scroll.clientHeight);
      scroll.scrollTop += step;
      scheduleScrollFrame();
    },
    { passive: false },
  );

  /**
   * Repaint the window after a scroll — on the next frame, or on a short timer
   * if no frame comes.
   *
   * This was rAF alone. A window that is occluded, minimised, or otherwise not
   * being composited is served NO frames, and a virtualized log whose repaint
   * only ever runs inside rAF then shows the lines from wherever it last
   * painted while the scrollbar says something else. The frame is the fast
   * path; it must not be the only one.
   */
  function scheduleScrollFrame(): void {
    if (raf || rafTimer) return;
    const paint = (): void => {
      if (raf) cancelAnimationFrame(raf);
      if (rafTimer) window.clearTimeout(rafTimer);
      raf = 0;
      rafTimer = 0;
      if (destroyed) return;
      const atBottom = scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - LINE_H * 2;
      // Leaving the bottom stops the tail. Returning to it does NOT restart the
      // tail — it only takes the pill away, because there is nothing left to
      // jump to. Route the disarm through setFollow: flipping the class by hand
      // here is how the button came to render as ON while its own tooltip and
      // aria-pressed still said OFF.
      if (follow && !atBottom) setFollow(false);
      if (!follow) syncFollowBtn();
      render();
    };
    raf = requestAnimationFrame(paint);
    rafTimer = window.setTimeout(paint, 80);
  }

  function groupOf(startIdx: number): { start: number; end: number } | undefined {
    for (const g of doc.groups) if (g.start === startIdx) return { start: g.start, end: g.end === -1 ? doc.lines.length - 1 : g.end };
    return undefined;
  }

  function rebuildVisible(): void {
    visible = [];
    let skipUntil = -1;
    for (let i = 0; i < doc.lines.length; i++) {
      if (i <= skipUntil) continue;
      visible.push(i);
      if (doc.lines[i].kind === "group" && collapsed.has(i)) {
        const g = groupOf(i);
        if (g) skipUntil = g.end;
      }
    }
  }

  /**
   * `keep` is the line the reader had walked to, held as the LINE OBJECT rather
   * than its index: a live delta re-scans the whole doc, and enforceCap may have
   * dropped lines off the front, so the old index means nothing afterwards.
   * Identity survives both (appendLog only pushes, the cap only splices).
   *
   * Without this, every 4s tick reset "2 of 11" to "11 matches" and the next
   * Enter — pressed meaning "next match" — took the viewport back to match 1.
   * Only a change of QUERY may throw the reader's place away.
   */
  function rebuildMatches(keep?: LogLine): void {
    matches = [];
    matchIdx = -1;
    const q = query.trim().toLowerCase();
    if (!q) {
      matchCounter.textContent = "";
    matchStepSync?.();
      return;
    }
    for (let i = 0; i < doc.lines.length; i++) {
      if (stripAnsi(doc.lines[i].text).toLowerCase().includes(q)) matches.push(i);
    }
    if (keep) matchIdx = matches.findIndex((i) => doc.lines[i] === keep);
    matchCounter.textContent = matches.length
      ? matchIdx >= 0
        ? `${matchIdx + 1} of ${matches.length}`
        : `${matches.length} match${matches.length === 1 ? "" : "es"}`
      : "no matches";
    matchStepSync?.();
  }

  /** The line a jump landed on, flashed until the next one. */
  let hitLine = -1;

  /**
   * `align` decides where the target lands.
   *
   * "center" is right for a search or error hit: you want to see what is
   * AROUND it. "top" is right for "go to the start of this step" — centring
   * that put the group header in the middle of the port with half a screen of
   * the PREVIOUS step above it, so the strip immediately relabelled itself to
   * the step you had just left and the header you asked for was not at the top
   * of anything.
   */
  function jumpToLine(docIdx: number, align: "center" | "top" = "center"): void {
    // Un-collapse any group hiding the target, then place it.
    for (const g of doc.groups) {
      const end = g.end === -1 ? doc.lines.length - 1 : g.end;
      if (docIdx > g.start && docIdx <= end && collapsed.has(g.start)) collapsed.delete(g.start);
    }
    rebuildVisible();
    const pos = visible.indexOf(docIdx);
    if (pos < 0) return;
    // A search or error jump turns following off — so the way BACK to the tail
    // has to appear, or you are stranded mid-log with no affordance.
    //
    // setFollow already decides this correctly, `!producing` included. The line
    // that used to sit here re-derived it from `visible.length` alone and threw
    // that away, so a FINISHED job grew a "Jump to latest" pill the moment you
    // clicked an error tick or a search hit — offering to follow a tail that
    // stopped moving before you opened the page.
    setFollow(false);
    scroll.scrollTop = Math.max(
      0,
      align === "top" ? pos * LINE_H : pos * LINE_H - scroll.clientHeight / 2,
    );
    // Centring is not enough to FIND it. A CI log is a wall of monospace, and
    // an error line looks like every other line in it once it is on screen —
    // which is most of what "not practical" means here.
    hitLine = docIdx;
    render();
  }

  function jumpToMatch(i: number): void {
    if (!matches.length) return;
    matchIdx = ((i % matches.length) + matches.length) % matches.length;
    matchCounter.textContent = `${matchIdx + 1} of ${matches.length}`;
    jumpToLine(matches[matchIdx]);
  }

  // Enter / Shift+Enter walk matches from the search box. From "no match
  // selected" (which is where typing now leaves you), Enter goes to the FIRST
  // one rather than the second.
  search.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    e.stopPropagation();
    if (matchIdx < 0) jumpToMatch(e.shiftKey ? matches.length - 1 : 0);
    else jumpToMatch(e.shiftKey ? matchIdx - 1 : matchIdx + 1);
  });

  function errorLines(): number[] {
    const out: number[] = [];
    for (let i = 0; i < doc.lines.length; i++) if (doc.lines[i].kind === "error") out.push(i);
    return out;
  }
  /**
   * The keys a person expects in a document, and two this log needs.
   *
   * PageUp/PageDown move by a SCREENFUL rather than a fixed number of lines, so
   * the step matches whatever height the pane happens to have. `n`/`N` walk the
   * failures, which is the actual question being asked of a CI log — the error
   * chip could already do it, but only by mouse, and only forwards.
   */
  scroll.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const page = Math.max(1, Math.floor(scroll.clientHeight / LINE_H) - 1) * LINE_H;
    const by = (dy: number): void => {
      e.preventDefault();
      // ANY deliberate move means the reader has taken over; follow-tail must
      // stand down or it will yank them back. This used to disarm only on the
      // way UP, so paging DOWN through a live log kept the tail armed and every
      // poll snapped you past whatever you were reading. Direction is not the
      // question — who is driving is.
      setFollow(false);
      scroll.scrollTop += dy;
    };
    switch (e.key) {
      case "ArrowDown": return by(LINE_H);
      case "ArrowUp": return by(-LINE_H);
      case "PageDown": return by(page);
      case "PageUp": return by(-page);
      case "Home":
        e.preventDefault();
        setFollow(false);
        scroll.scrollTop = 0;
        return;
      case "End":
        e.preventDefault();
        // End is the one key that ARMS: "take me to the newest" is the whole
        // meaning of it on a log. setFollow already writes the scroll.
        setFollow(true);
        scroll.scrollTop = scroll.scrollHeight;
        return;
      case "n":
      case "N": {
        const errs = errorLines();
        if (!errs.length) return;
        e.preventDefault();
        setFollow(false);
        // Shift-N walks backwards, wrapping at both ends.
        errJump = e.shiftKey
          ? (errJump - 1 + errs.length) % errs.length
          : (errJump + 1) % errs.length;
        jumpToLine(errs[errJump]);
        return;
      }
      default:
        return;
    }
  });

  let errJump = -1;
  errChip.addEventListener("click", () => {
    const errs = errorLines();
    if (!errs.length) return;
    errJump = (errJump + 1) % errs.length;
    jumpToLine(errs[errJump]);
  });

  function syncBanner(): void {
    const bits: string[] = [];
    if (truncatedTail) bits.push("This log is larger than 8 MB — showing the most recent output. Download for the full text.");
    if (capped) bits.push(`Very long log — showing the most recent ${MAX_RENDER_LINES.toLocaleString()} lines.`);
    banner.hidden = bits.length === 0;
    banner.textContent = bits.join(" ");
  }

  function lineRow(docIdx: number): HTMLElement {
    const line = doc.lines[docIdx];
    const row = el("div", `log-line log-k-${line.kind}`);
    const num = el("span", "log-num");
    num.textContent = String(docIdx + 1 + droppedLines);
    row.appendChild(num);
    if (line.kind === "group") {
      const isCollapsed = collapsed.has(docIdx);
      const chev = glyph(isCollapsed ? "chevron-right" : "chevron-down");
      chev.classList.add("log-chev");
      row.appendChild(chev);
      row.classList.add("log-groupline");
      // These fold whole sections of a build log and were mouse-only: a div
      // with a click handler, no role, no tab stop, and no expanded state to
      // read. Enter/Space now fold them like every other disclosure.
      row.setAttribute("role", "button");
      row.tabIndex = 0;
      row.setAttribute("aria-expanded", String(!isCollapsed));
      row.setAttribute("aria-label", `${isCollapsed ? "Expand" : "Collapse"} group: ${line.text}`);
      // Which doc line this row IS, so the rebuild below can find it again.
      // Deliberately `data-doc-idx` and not `data-num`: focusReturn keys its
      // remembered-row identity off `[data-num]`, and a log's line numbers
      // would poison that map for every list in the app.
      row.dataset.docIdx = String(docIdx);
      const toggle = (): void => {
        // `render()` replaces the whole window of rows, so the row this
        // keypress came from is DESTROYED by its own handler — focus fell to
        // <body> and the next Enter went nowhere. Folding a section of a build
        // log by keyboard therefore ended the keyboard's involvement.
        const hadFocus = document.activeElement === row;
        if (collapsed.has(docIdx)) collapsed.delete(docIdx);
        else collapsed.add(docIdx);
        rebuildVisible();
        render();
        if (hadFocus) {
          win.querySelector<HTMLElement>(`[data-doc-idx="${docIdx}"]`)?.focus();
        }
      };
      row.addEventListener("click", toggle);
      row.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        toggle();
      });
    }
    if (showTs && line.ts) {
      const ts = el("span", "log-ts");
      ts.textContent = line.ts.replace(/^\d{4}-\d{2}-\d{2}T/, "").replace(/\.\d+Z$/, "");
      row.appendChild(ts);
    }
    const content = el("span", "log-text");
    const q = query.trim().toLowerCase();
    for (const sp of parseAnsi(line.text)) {
      if (q && sp.text.toLowerCase().includes(q)) {
        // Paint search hits inside this span.
        let rest = sp.text;
        while (rest.length) {
          const at = rest.toLowerCase().indexOf(q);
          if (at < 0) {
            content.appendChild(span(rest, sp.cls));
            break;
          }
          if (at > 0) content.appendChild(span(rest.slice(0, at), sp.cls));
          content.appendChild(span(rest.slice(at, at + q.length), `${sp.cls} log-hit`.trim()));
          rest = rest.slice(at + q.length);
        }
      } else {
        content.appendChild(span(sp.text, sp.cls));
      }
    }
    row.appendChild(content);
    if (docIdx === hitLine) row.classList.add("is-hit");
    return row;
  }

  function render(): void {
    if (destroyed) return;
    const h = scroll.clientHeight || 1;
    const first = Math.max(0, Math.floor(scroll.scrollTop / LINE_H) - OVERSCAN);
    const last = Math.min(visible.length, Math.ceil((scroll.scrollTop + h) / LINE_H) + OVERSCAN);
    top.style.height = `${first * LINE_H}px`;
    bottom.style.height = `${Math.max(0, (visible.length - last) * LINE_H)}px`;
    win.replaceChildren();
    // A log with nothing in it used to be a full-height black rectangle — no
    // rows, no message, no banner — while the toolbar went on offering Copy,
    // Save and a search box. A queued job, a job that died before printing, a
    // step that produced nothing: the reader could not tell an empty log from
    // one that had failed to load.
    if (!visible.length) {
      const note = el("div", "log-empty");
      note.textContent = producing
        ? "Waiting for the first line of output…"
        : notStarted
          ? "This job hasn't started yet."
          : "This job produced no output.";
      win.appendChild(note);
    }
    for (let i = first; i < last; i++) win.appendChild(lineRow(visible[i]));
    const errs = errorLines();
    errChip.hidden = errs.length === 0;
    if (errs.length) errChip.textContent = `${errs.length} error${errs.length === 1 ? "" : "s"}`;
    // The first line actually IN the port, not the first RENDERED one: `first`
    // carries 30 lines of overscan above the fold, so the strip named the group
    // you had already scrolled past.
    // The first line actually IN the port, not the first RENDERED one: `first`
    // carries 30 lines of overscan above the fold, so the strip named the step
    // you had already scrolled past for the first 30 lines of every new one.
    syncGroupBar(Math.min(visible.length - 1, Math.floor(scroll.scrollTop / LINE_H)));
    syncErrMap(errs);
    syncBanner();
  }

  /** Name the group the top of the port sits inside, or hide the strip. */
  function syncGroupBar(firstVisible: number): void {
    const docIdx = visible[firstVisible];
    if (docIdx === undefined) {
      groupBar.hidden = true;
      return;
    }
    // The innermost group whose header is above us and whose end is below.
    let found: LogGroup | undefined;
    for (const g of doc.groups) {
      if (g.start > docIdx) break;
      const end = g.end === -1 ? doc.lines.length - 1 : g.end;
      if (end >= docIdx) found = g;
    }
    // Standing ON the header needs no reminder of it.
    if (!found || found.start === docIdx) {
      groupBar.hidden = true;
      return;
    }
    const label = stripAnsi(doc.lines[found.start]?.text ?? "").trim();
    if (!label) {
      groupBar.hidden = true;
      return;
    }
    groupBar.hidden = false;
    groupBar.replaceChildren(glyph("chevron-up"), span(label, "log-groupbar-name"));
    groupBar.onclick = () => jumpToLine(found.start, "top");
  }

  /** One tick per error, positioned by its place in the whole log. */
  function syncErrMap(errs: number[]): void {
    if (errs.length === 0 || visible.length === 0) {
      errMap.replaceChildren();
      errMap.hidden = true;
      return;
    }
    errMap.hidden = false;
    const pos = new Map<number, number>();
    for (let i = 0; i < visible.length; i++) pos.set(visible[i], i);
    const ticks: HTMLElement[] = [];
    const seen = new Set<number>();
    for (const docIdx of errs) {
      const at = pos.get(docIdx);
      if (at === undefined) continue; // inside a collapsed group
      const pct = Math.round((at / Math.max(1, visible.length - 1)) * 1000) / 10;
      const key = Math.round(pct * 2); // don't stack 40 ticks on one pixel
      if (seen.has(key)) continue;
      seen.add(key);
      const tick = el("button", "log-errtick") as HTMLButtonElement;
      // Scaled by the track MINUS the tick's own height, so 100% puts the
      // tick's bottom on the map's bottom rather than its top — a `top: 100%`
      // on a 3px box sits entirely outside the map, flush on the pane's border,
      // which is exactly where an error on the log's last line landed.
      tick.style.top = `calc(${pct / 100} * (100% - 3px))`;
      tick.title = `Error on line ${docIdx + 1 + droppedLines}`;
      tick.tabIndex = -1;
      tick.addEventListener("click", () => jumpToLine(docIdx));
      ticks.push(tick);
    }
    errMap.replaceChildren(...ticks);
  }

  /** Returns how many lines were dropped off the FRONT, so the caller can put
   *  the reader back where they were. */
  function enforceCap(): number {
    if (doc.lines.length <= MAX_RENDER_LINES) return 0;
    const drop = doc.lines.length - MAX_RENDER_LINES;
    doc.lines.splice(0, drop);
    doc.groups = doc.groups
      .map((g) => ({ start: g.start - drop, end: g.end === -1 ? -1 : g.end - drop }))
      .filter((g) => (g.end === -1 ? g.start >= 0 : g.end >= 0))
      .map((g) => ({ start: Math.max(0, g.start), end: g.end }));
    const shifted = new Set<number>();
    for (const c of collapsed) if (c - drop >= 0) shifted.add(c - drop);
    collapsed.clear();
    for (const c of shifted) collapsed.add(c);
    capped = true;
    droppedLines += drop;
    return drop;
  }

  const pane: LogPane = {
    el: root,
    reset(text, opts = {}) {
      doc = emptyLogDoc();
      collapsed.clear();
      capped = false;
      droppedLines = 0;
      truncatedTail = !!opts.truncated;
      appendLog(doc, text);
      enforceCap();
      rebuildVisible();
      rebuildMatches();
      render();
      // Only when FOLLOWING. On an already-finished log this used to jump you
      // to the last line the moment it loaded, before you had read a word.
      if (follow) scroll.scrollTop = scroll.scrollHeight;
      else syncFollowBtn();
    },
    append(delta) {
      if (!delta) return;
      // Grabbed BEFORE the doc changes underneath it.
      const held = matchIdx >= 0 ? doc.lines[matches[matchIdx]] : undefined;
      // And so is the line under the top of the viewport, as the LINE OBJECT.
      //
      // At the 200,000-line cap `enforceCap` splices lines off the FRONT. Every
      // remaining line then sits `drop` rows higher while `scrollTop` stays
      // where it was, so a reader who has deliberately scrolled away — follow
      // off, reading something — is carried forward by exactly that many rows
      // on every 4s tick. On the biggest logs, which are the ones that reach the
      // cap, that is the "it scrolls instead of me" complaint in its purest
      // form: nothing in the app is scrolling, the document is sliding out from
      // under a fixed offset.
      //
      // Anchored on identity, not on the count: `visible` is doc indices and a
      // collapsed group means the rows dropped and the ROWS SHOWN differ.
      // Taken whenever the reader is not following — NOT only once the doc has
      // already reached the cap. That pre-check read `doc.lines.length` BEFORE
      // the delta was appended, so on the single tick that CROSSES the cap the
      // length was still under it, the anchor was undefined, and the correction
      // below was skipped for exactly the drop that matters: everything the job
      // emitted in that poll window, minus the headroom, in one jerk. Every
      // later tick was anchored, which is what made it look fixed.
      //
      // The cheap part is this lookup; the O(n) `indexOf` below is already
      // gated on `dropped`, so an unconditional anchor costs a modulo per poll.
      const anchor =
        !follow && visible.length
          ? doc.lines[visible[Math.min(visible.length - 1, Math.floor(scroll.scrollTop / LINE_H))]]
          : undefined;
      const anchorOffset = anchor ? scroll.scrollTop % LINE_H : 0;
      appendLog(doc, delta);
      const dropped = enforceCap();
      rebuildVisible();
      if (query) rebuildMatches(held);
      render();
      if (follow) {
        scroll.scrollTop = scroll.scrollHeight;
      } else if (anchor && dropped) {
        const row = visible.indexOf(doc.lines.indexOf(anchor));
        // -1 means the reader's own line was one of the ones dropped. There is
        // nowhere honest to put them then; the top of what survives is the
        // closest thing to where they were.
        scroll.scrollTop = row >= 0 ? row * LINE_H + anchorOffset : 0;
      }
      // The tail just moved, so whether there is anything to jump TO has
      // changed — and nothing else will say so. `atTail()` is only re-read on
      // scroll, and a reader parked at the bottom with follow off does not
      // scroll: the log grew past them in silence, the pill stayed hidden, and
      // the one control that would have caught them up was never offered.
      syncFollowBtn();
    },
    setProducing(on) {
      if (producing === on) return;
      producing = on;
      // Arm the tail the way opening a live job would have. Not `setFollow` on
      // the way DOWN — finish() owns that, and it also flushes the last line.
      if (on) {
        follow = true;
        notStarted = false;
      }
      syncFollowBtn();
      // `notStarted` is read by the empty-log note, which is on screen right
      // now saying "This job hasn't started yet." Without a re-render it keeps
      // saying it for as long as the job runs — until the first chunk happens
      // to arrive, which on a slow step is minutes of a running job insisting
      // it has not begun.
      render();
    },
    finish() {
      finishLog(doc);
      rebuildVisible();
      // Nothing will ever arrive again, so there is nothing to follow — and
      // nothing to be behind. Leaving the mode armed left a finished log
      // claiming to be tailing, with a lit button that could only ever do one
      // more thing: jump you to the end.
      producing = false;
      follow = false;
      // Through the one rule: it disables the button and hides the pill, both
      // of which are now permanently meaningless for this pane.
      syncFollowBtn();
      render();
    },
    setFollow,
    destroy() {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      if (rafTimer) window.clearTimeout(rafTimer);
      sizeWatch?.disconnect();
      window.removeEventListener("resize", onResize);
      root.remove();
    },
  };

  // The virtual window is sized from `scroll.clientHeight`, and the only things
  // that called render() were scroll events, the keyboard, the toolbar and the
  // tail. A height change that produces neither — resizing the Electron window
  // taller, entering fullscreen, dragging the terminal dock down — left the
  // window the size it was, so the log ended mid-pane with a blank band below
  // it until you happened to scroll.
  //
  // A resize is not a scroll, so following must survive it (`expandBtn` learned
  // this the hard way); render() alone touches no scroll position.
  const onResize = (): void => {
    if (!destroyed) render();
  };
  const sizeWatch =
    typeof ResizeObserver === "function" ? new ResizeObserver(onResize) : undefined;
  sizeWatch?.observe(scroll);
  // BOTH. The observer catches a pane that changes size without the window
  // doing so (the dock being dragged, the job rail folding); the window event
  // catches the case a reader actually hits — resizing the app, or going
  // fullscreen — and is the one that can be driven in a test, since a
  // ResizeObserver callback is delivered with the rendering steps and those do
  // not run on an idle headless page.
  window.addEventListener("resize", onResize);

  // Paint the button's initial state through the one rule that owns it, rather
  // than stamping a class — a finished pane must open with Follow disabled.
  syncFollowBtn();
  return pane;
}
