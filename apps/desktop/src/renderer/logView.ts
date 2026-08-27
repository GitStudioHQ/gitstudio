// The log pane — a virtualized, ANSI-aware, foldable, searchable, live-tail
// log surface (docs/desktop-redesign.md "Depth guarantees"). One pane per job;
// panes survive the run page's 8s repaints via save/restoreViewport and get
// re-slotted, never rebuilt.
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
  setFollow(on: boolean): void;
  saveViewport(): void;
  restoreViewport(): void;
  destroy(): void;
}

export function createLogPane(o: {
  ariaLabel: string;
  onCopy: () => string | Promise<string>;
  onDownload?: () => void;
}): LogPane {
  let doc: LogDoc = emptyLogDoc();
  const collapsed = new Set<number>(); // group START line indices
  let visible: number[] = [];
  let follow = true;
  let showTs = false;
  let capped = false; // over MAX_RENDER_LINES — oldest dropped
  let truncatedTail = false; // main sent only the 8MB tail window
  let query = "";
  let matches: number[] = []; // doc line indices
  let matchIdx = -1;
  let savedScroll = 0;
  let savedFollow = follow;
  let raf = 0;
  let destroyed = false;

  const root = el("div", "log-pane");
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
      if (matches.length) jumpToMatch(0);
      render();
    },
  });
  search.classList.add("log-search");
  const matchCounter = span("", "log-match-count");
  // These were five identical unlabelled squares, and their titles never
  // changed with their state — "Show timestamps" still read "Show timestamps"
  // while timestamps were showing. The clock-with-arrow icon also universally
  // means "history", not "timestamps".
  const tsBtn = toolBtn("watch", "Show timestamps", () => {
    showTs = !showTs;
    tsBtn.classList.toggle("is-on", showTs);
    tsBtn.title = showTs ? "Hide timestamps" : "Show timestamps";
    tsBtn.setAttribute("aria-label", tsBtn.title);
    render();
  });
  const followBtn = toolBtn("fold-down", "Follow the newest output", () => setFollow(!follow));
  const copyBtn = toolBtn("copy", "Copy the full log", () => {
    void Promise.resolve(o.onCopy()).then((t) => navigator.clipboard.writeText(t).catch(() => {}));
  });
  const dlBtn = o.onDownload ? toolBtn("cloud-download", "Save the full log to Downloads", o.onDownload) : null;
  const expandBtn = toolBtn("screen-full", "Expand the pane", () => {
    // Resizing the pane changes its scroll height, which the scroll listener
    // reads as "the user scrolled away from the bottom" and silently turns
    // follow OFF, dumping you into the middle of the log. Resizing is not
    // scrolling: remember the mode and restore it.
    const wasFollowing = follow;
    const max = root.classList.toggle("log-max");
    expandBtn.title = max ? "Shrink the pane" : "Expand the pane";
    expandBtn.setAttribute("aria-label", expandBtn.title);
    render();
    // Expanding to 78vh while the pane sits ~320px down the page pushed its
    // tail — the error line, the toolbar's own controls — below the fold, so
    // "expand" made the thing you wanted LESS visible. Bring it into view.
    if (max) root.scrollIntoView({ block: "start", behavior: "smooth" });
    if (wasFollowing) setFollow(true);
  });
  bar.append(errChip, search, matchCounter, span("", "log-toolbar-spring"), tsBtn, followBtn, copyBtn);
  if (dlBtn) bar.appendChild(dlBtn);
  bar.appendChild(expandBtn);
  root.appendChild(bar);

  // ── banners + scroller ──
  const banner = el("div", "log-banner");
  banner.hidden = true;
  root.appendChild(banner);
  const scroll = el("div", "log-scroll");
  const top = el("div", "log-spacer");
  const win = el("div", "log-window");
  const bottom = el("div", "log-spacer");
  scroll.append(top, win, bottom);
  root.appendChild(scroll);
  const jumpPill = el("button", "log-jump");
  jumpPill.append(glyph("arrow-down"), span("Jump to latest"));
  jumpPill.hidden = true;
  jumpPill.addEventListener("click", () => setFollow(true));
  root.appendChild(jumpPill);

  function toolBtn(icon: string, title: string, onClick: () => void): HTMLElement {
    const b = el("button", "icon-btn log-tool");
    b.title = title;
    b.setAttribute("aria-label", title);
    b.appendChild(glyph(icon));
    b.addEventListener("click", onClick);
    return b;
  }

  function setFollow(on: boolean): void {
    follow = on;
    followBtn.classList.toggle("is-on", on);
    followBtn.title = on ? "Following the newest output" : "Follow the newest output";
    followBtn.setAttribute("aria-label", followBtn.title);
    jumpPill.hidden = on || visible.length === 0;
    if (on) {
      scroll.scrollTop = scroll.scrollHeight;
      render();
    }
  }

  // A user scroll away from the bottom disables follow; back to bottom re-arms.
  scroll.addEventListener("scroll", () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const atBottom = scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - LINE_H * 2;
      if (follow && !atBottom) {
        follow = false;
        followBtn.classList.remove("is-on");
        jumpPill.hidden = false;
      } else if (!follow && atBottom) {
        follow = true;
        followBtn.classList.add("is-on");
        jumpPill.hidden = true;
      }
      render();
    });
  });

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

  function rebuildMatches(): void {
    matches = [];
    matchIdx = -1;
    const q = query.trim().toLowerCase();
    if (!q) {
      matchCounter.textContent = "";
      return;
    }
    for (let i = 0; i < doc.lines.length; i++) {
      if (stripAnsi(doc.lines[i].text).toLowerCase().includes(q)) matches.push(i);
    }
    matchCounter.textContent = matches.length ? `${matches.length} matches` : "no matches";
  }

  function jumpToLine(docIdx: number): void {
    // Un-collapse any group hiding the target, then center it.
    for (const g of doc.groups) {
      const end = g.end === -1 ? doc.lines.length - 1 : g.end;
      if (docIdx > g.start && docIdx <= end && collapsed.has(g.start)) collapsed.delete(g.start);
    }
    rebuildVisible();
    const pos = visible.indexOf(docIdx);
    if (pos < 0) return;
    // A search or error jump turns following off — so the way BACK to the tail
    // has to appear, or you are stranded mid-log with no affordance.
    follow = false;
    followBtn.classList.remove("is-on");
    followBtn.title = "Follow the newest output";
    jumpPill.hidden = visible.length === 0;
    scroll.scrollTop = Math.max(0, pos * LINE_H - scroll.clientHeight / 2);
    render();
  }

  function jumpToMatch(i: number): void {
    if (!matches.length) return;
    matchIdx = ((i % matches.length) + matches.length) % matches.length;
    matchCounter.textContent = `${matchIdx + 1} of ${matches.length}`;
    jumpToLine(matches[matchIdx]);
  }

  // Enter / Shift+Enter walk matches from the search box.
  search.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    e.stopPropagation();
    jumpToMatch(e.shiftKey ? matchIdx - 1 : matchIdx + 1);
  });

  function errorLines(): number[] {
    const out: number[] = [];
    for (let i = 0; i < doc.lines.length; i++) if (doc.lines[i].kind === "error") out.push(i);
    return out;
  }
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
    num.textContent = String(docIdx + 1);
    row.appendChild(num);
    if (line.kind === "group") {
      const chev = glyph(collapsed.has(docIdx) ? "chevron-right" : "chevron-down");
      chev.classList.add("log-chev");
      row.appendChild(chev);
      row.classList.add("log-groupline");
      row.addEventListener("click", () => {
        if (collapsed.has(docIdx)) collapsed.delete(docIdx);
        else collapsed.add(docIdx);
        rebuildVisible();
        render();
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
    for (let i = first; i < last; i++) win.appendChild(lineRow(visible[i]));
    const errs = errorLines();
    errChip.hidden = errs.length === 0;
    if (errs.length) errChip.textContent = `${errs.length} error${errs.length === 1 ? "" : "s"}`;
    syncBanner();
  }

  function enforceCap(): void {
    if (doc.lines.length <= MAX_RENDER_LINES) return;
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
  }

  const pane: LogPane = {
    el: root,
    reset(text, opts = {}) {
      doc = emptyLogDoc();
      collapsed.clear();
      capped = false;
      truncatedTail = !!opts.truncated;
      appendLog(doc, text);
      enforceCap();
      rebuildVisible();
      rebuildMatches();
      render();
      if (follow) scroll.scrollTop = scroll.scrollHeight;
    },
    append(delta) {
      if (!delta) return;
      appendLog(doc, delta);
      enforceCap();
      rebuildVisible();
      if (query) rebuildMatches();
      render();
      if (follow) scroll.scrollTop = scroll.scrollHeight;
    },
    finish() {
      finishLog(doc);
      rebuildVisible();
      render();
    },
    setFollow,
    saveViewport() {
      savedScroll = scroll.scrollTop;
      savedFollow = follow;
    },
    restoreViewport() {
      scroll.scrollTop = savedScroll;
      follow = savedFollow;
      followBtn.classList.toggle("is-on", follow);
      jumpPill.hidden = follow;
      render();
    },
    destroy() {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      root.remove();
    },
  };
  followBtn.classList.toggle("is-on", follow);
  return pane;
}
