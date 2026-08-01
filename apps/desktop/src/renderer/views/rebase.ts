// Interactive Rebase — a full workspace view (not a dialog), mirroring the
// GitStudio extension's rebase panel: a commit rail with node dots, per-commit
// action dropdowns, plain-English consequences, drag-to-reorder, and a dimmed
// "onto" base row. Nothing touches the repository until Start Rebase is pressed,
// and the whole run is a single git invocation driven by the shared
// @gitstudio/git-service/RebaseRunner (the same module the extension uses).

import { host } from "../bridge";
import { el, span, glyph, emptyState } from "../ui";
import { toast, confirmDialog, promptInline } from "../dialogs";
import type { SectionRender } from "./common";
import type {
  RebaseAction,
  RebaseApplyRow,
  RebaseCommitInfo,
  RebasePlanState,
} from "../../shared/ipc";

interface Row extends RebaseCommitInfo {
  action: RebaseAction;
  /** Edited message for a `reword` row (defaults to the subject). */
  message: string;
}

const ACTIONS: ReadonlyArray<{ id: RebaseAction; label: string; hint: string }> = [
  { id: "pick", label: "Pick", hint: "Keep this commit as it is." },
  { id: "reword", label: "Reword", hint: "Keep the commit, rewrite its message." },
  { id: "squash", label: "Squash", hint: "Merge into the commit above — keep both messages." },
  { id: "fixup", label: "Fixup", hint: "Merge into the commit above — drop this message." },
  { id: "edit", label: "Edit", hint: "Pause here so you can amend the commit." },
  { id: "drop", label: "Drop", hint: "Delete this commit." },
];

const EXPLAIN_KEY = "gitstudio.rebase.explainDismissed";

export const renderRebase: SectionRender = (wrap, nav) => {
  void mount(wrap, nav);
};

async function mount(wrap: HTMLElement, nav: (view: string) => void): Promise<void> {
  wrap.classList.add("rb-view");
  wrap.replaceChildren(loadingCard());

  let state: RebasePlanState;
  try {
    state = await host.invoke("rebase:load", {});
  } catch (err) {
    wrap.replaceChildren(
      emptyState("Couldn't load the rebase plan", err instanceof Error ? err.message : String(err), {
        icon: "warning",
      }),
    );
    return;
  }

  if (!state.ok) {
    wrap.replaceChildren(
      emptyState("Interactive rebase unavailable", state.message ?? "Open a repository first.", {
        icon: "repo",
      }),
    );
    return;
  }

  // A rebase already in flight owns the repo — offer continue/abort only.
  if (state.inProgress) {
    wrap.replaceChildren(inProgressCard(() => void mount(wrap, nav)));
    return;
  }

  if (!state.commits.length) {
    wrap.replaceChildren(
      emptyState(
        "Nothing to rebase",
        `No commits between ${short(state.base)} and ${state.branch}. Pick a different base to reach further back.`,
        { icon: "git-commit" },
      ),
      baseBar(state, wrap, nav),
    );
    return;
  }

  build(wrap, nav, state);
}

// ── the workspace ────────────────────────────────────────────────────────────

function build(wrap: HTMLElement, nav: (view: string) => void, state: RebasePlanState): void {
  const original: Row[] = state.commits.map((c) => ({ ...c, action: "pick", message: c.subject }));
  let rows: Row[] = original.map((r) => ({ ...r }));
  let busy = false;

  const head = el("div", "rb-head");
  const title = el("div", "rb-title");
  title.append(glyph("list-ordered"), span("Interactive Rebase"));
  const sub = el("div", "rb-sub");
  const branchB = el("b", "rb-branch");
  branchB.textContent = state.branch;
  const baseB = document.createElement("b");
  baseB.textContent = short(state.base);
  const count = span("", "rb-count");
  sub.append(glyph("git-branch"), branchB, span(" onto "), baseB, span(" · "), count);
  head.append(title, sub, el("span", "rb-spacer"), baseBar(state, wrap, nav));

  const explain = buildExplainer();
  const list = el("div", "rb-list");
  list.setAttribute("role", "list");
  const banner = el("div", "rb-banner");
  banner.hidden = true;

  // Footer
  const foot = el("div", "rb-foot");
  const resetBtn = el("button", "rb-btn ghost") as HTMLButtonElement;
  resetBtn.append(glyph("discard"), span("Reset plan"));
  const preview = span("", "rb-preview");
  const applyBtn = el("button", "rb-btn primary") as HTMLButtonElement;
  const applyLabel = span("Start Rebase");
  applyBtn.append(glyph("play"), applyLabel);
  foot.append(resetBtn, el("span", "rb-spacer"), preview, applyBtn);

  wrap.replaceChildren(head, explain, hintBar(), list, banner, foot);

  // A note from the host (base fell back, or the list was capped) is worth
  // showing — otherwise the range silently isn't what the user asked for.
  if (state.message) {
    banner.textContent = state.message;
    banner.className = "rb-banner warn";
    banner.hidden = false;
  }

  // ── model helpers ──
  const firstKeptIndex = (): number => rows.findIndex((r) => r.action !== "drop");

  /** The commit a squash/fixup folds INTO: the nearest kept commit above it. */
  const foldTargetSubject = (i: number): string | null => {
    for (let j = i - 1; j >= 0; j--) {
      const a = rows[j].action;
      if (a === "drop" || a === "squash" || a === "fixup") continue;
      return rows[j].subject;
    }
    return null;
  };

  const flashBanner = (msg: string, kind: "warn" | "error" = "warn"): void => {
    banner.textContent = msg;
    banner.className = `rb-banner ${kind}`;
    banner.hidden = false;
    window.setTimeout(() => {
      banner.hidden = true;
    }, 4200);
  };

  const setAction = (i: number, action: RebaseAction): void => {
    if ((action === "squash" || action === "fixup") && i === firstKeptIndex()) {
      flashBanner("The top commit has nothing above it to fold into.");
      render();
      return;
    }
    rows[i].action = action;
    render();
  };

  const move = (from: number, to: number): void => {
    if (to < 0 || to >= rows.length || from === to) return;
    const [r] = rows.splice(from, 1);
    rows.splice(to, 0, r);
    render();
    // Keep focus on the row the user is dragging with the keyboard.
    (list.children[to] as HTMLElement | undefined)?.focus();
  };

  const updatePreview = (): void => {
    const kept = rows.filter((r) => r.action !== "drop" && r.action !== "squash" && r.action !== "fixup").length;
    const dropped = rows.filter((r) => r.action === "drop").length;
    const folded = rows.filter((r) => r.action === "squash" || r.action === "fixup").length;
    const bits = [`${rows.length} → ${kept} commit${kept === 1 ? "" : "s"}`];
    if (folded) bits.push(`${folded} folded`);
    if (dropped) bits.push(`${dropped} dropped`);
    preview.textContent = bits.join(" · ");
    count.textContent = `${rows.length} commit${rows.length === 1 ? "" : "s"}`;
  };

  // ── rendering ──
  function makeRow(r: Row, i: number): HTMLElement {
    const row = el("div", "rb-row");
    row.dataset.action = r.action;
    row.dataset.sha = r.sha;
    row.setAttribute("role", "listitem");
    row.tabIndex = 0;
    row.draggable = true;
    if (r.action === "drop") row.classList.add("dropped");

    const rail = el("div", "rb-rail");
    rail.appendChild(el("span", "rb-node"));
    row.appendChild(rail);

    const grip = el("span", "rb-grip");
    grip.appendChild(glyph("gripper"));
    grip.title = "Drag to reorder (or focus the row and press Alt+↑ / Alt+↓)";
    row.appendChild(grip);

    const sel = document.createElement("select");
    sel.className = `rb-action a-${r.action}`;
    for (const a of ACTIONS) {
      const o = document.createElement("option");
      o.value = a.id;
      o.textContent = a.label;
      if (a.id === r.action) o.selected = true;
      sel.appendChild(o);
    }
    sel.title = ACTIONS.find((a) => a.id === r.action)?.hint ?? "";
    sel.addEventListener("change", () => setAction(i, sel.value as RebaseAction));
    row.appendChild(sel);

    const main = el("div", "rb-main");
    const line = el("div", "rb-line");
    const subj = span(r.subject, "rb-subj");
    subj.title = r.subject;
    const av = span(initials(r.author), "rb-avatar");
    av.style.setProperty("--h", String(hue(r.author)));
    av.title = r.author;
    const sha = el("span", "rb-sha");
    sha.append(glyph("git-commit"), span(r.shortSha));
    line.append(subj, av, span(r.rel, "rb-meta"), sha);
    main.appendChild(line);

    // Reword editor — only visible for `reword` (CSS-driven off data-action).
    const rw = el("div", "rb-reword");
    const ta = document.createElement("textarea");
    ta.value = r.message || r.subject;
    ta.placeholder = "New commit message…";
    ta.rows = 2;
    ta.addEventListener("input", () => {
      r.message = ta.value;
    });
    rw.appendChild(ta);
    main.appendChild(rw);

    const cons = el("div", "rb-consequence");
    const c = consequence(r.action, foldTargetSubject(i));
    if (c) {
      cons.append(glyph(c.icon), span(c.text));
    }
    main.appendChild(cons);
    row.appendChild(main);

    wireDrag(row, i);
    row.addEventListener("keydown", (e) => {
      if (e.altKey && e.key === "ArrowUp") {
        e.preventDefault();
        move(i, i - 1);
      } else if (e.altKey && e.key === "ArrowDown") {
        e.preventDefault();
        move(i, i + 1);
      }
    });
    return row;
  }

  function wireDrag(row: HTMLElement, i: number): void {
    row.addEventListener("dragstart", (e) => {
      e.dataTransfer?.setData("text/plain", String(i));
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => row.classList.remove("dragging"));
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      row.classList.add("drag-over");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.classList.remove("drag-over");
      const from = Number(e.dataTransfer?.getData("text/plain"));
      if (!Number.isNaN(from)) move(from, i);
    });
  }

  function makeBaseRow(): HTMLElement {
    const row = el("div", "rb-row rb-base");
    const rail = el("div", "rb-rail");
    rail.appendChild(el("span", "rb-node"));
    row.append(rail, span("onto", "rb-onto"));
    const main = el("div", "rb-main");
    const line = el("div", "rb-line");
    const subj = span(state.baseCommit?.subject ?? short(state.base), "rb-subj");
    const sha = el("span", "rb-sha");
    sha.append(glyph("git-commit"), span(state.baseCommit?.shortSha ?? short(state.base)));
    line.append(subj, sha);
    main.appendChild(line);
    row.appendChild(main);
    return row;
  }

  function render(): void {
    list.replaceChildren(...rows.map((r, i) => makeRow(r, i)));
    if (state.baseCommit) list.appendChild(makeBaseRow());
    updatePreview();
  }

  // ── actions ──
  resetBtn.addEventListener("click", () => {
    rows = original.map((r) => ({ ...r }));
    render();
    toast("Plan reset.", "info");
  });

  applyBtn.addEventListener("click", () => {
    void (async () => {
      if (busy) return;
      const dropped = rows.filter((r) => r.action === "drop").length;
      const rewritten = rows.length;
      const ok = await confirmDialog({
        title: "Start interactive rebase?",
        message:
          `This rewrites ${rewritten} commit${rewritten === 1 ? "" : "s"} on ${state.branch}` +
          (dropped ? `, deleting ${dropped}` : "") +
          `. If the branch is already pushed you'll need to force-push afterwards.`,
        confirmLabel: "Start Rebase",
      });
      if (!ok) return;

      busy = true;
      applyBtn.classList.add("busy");
      applyBtn.disabled = true;
      applyLabel.textContent = "Rebasing…";
      try {
        const payload: RebaseApplyRow[] = rows.map((r) => ({
          action: r.action,
          sha: r.sha,
          subject: r.subject,
          message: r.action === "reword" ? r.message : undefined,
        }));
        const outcome = await host.invoke("rebase:apply", { base: state.base, rows: payload });
        if (outcome.status === "done") {
          toast("Rebase complete.", "success");
          void mount(wrap, nav); // reload the (now shorter) plan
        } else if (outcome.status === "stopped") {
          toast(outcome.message || "Rebase paused — resolve, then Continue.", "info", 6000);
          void mount(wrap, nav); // re-enters the in-progress card
        } else {
          flashBanner(outcome.message || "Rebase failed.", "error");
        }
      } catch (err) {
        flashBanner(err instanceof Error ? err.message : String(err), "error");
      } finally {
        busy = false;
        applyBtn.classList.remove("busy");
        applyBtn.disabled = false;
        applyLabel.textContent = "Start Rebase";
      }
    })();
  });

  render();
}

// ── pieces ───────────────────────────────────────────────────────────────────

function loadingCard(): HTMLElement {
  const w = el("div", "rb-loading");
  w.append(glyph("loading"), span("Loading commits…"));
  return w;
}

function hintBar(): HTMLElement {
  const h = el("div", "rb-hint");
  h.append(glyph("info"), span("Commits replay top → bottom (oldest first). Drag to reorder."));
  return h;
}

/** The dismissible explainer + glossary — the same wording as the extension. */
function buildExplainer(): HTMLElement {
  const box = el("div", "rb-explain");
  if (localStorage.getItem(EXPLAIN_KEY) === "1") {
    box.hidden = true;
  }
  const x = el("button", "rb-explain-x") as HTMLButtonElement;
  x.textContent = "×";
  x.title = "Dismiss";
  x.addEventListener("click", () => {
    box.hidden = true;
    localStorage.setItem(EXPLAIN_KEY, "1");
  });
  const lead = el("div", "rb-explain-lead");
  const strong = document.createElement("b");
  strong.textContent = "Tidy up your recent commits before you push.";
  lead.append(
    glyph("lightbulb"),
    strong,
    span(
      " Reorder by dragging, or pick what happens to each commit below. Nothing changes until you press Start Rebase.",
    ),
  );
  const gloss = el("div", "rb-gloss");
  for (const a of ACTIONS) {
    const item = document.createElement("span");
    const b = document.createElement("b");
    b.className = `g-${a.id}`;
    b.textContent = a.label;
    item.append(b, span(" " + a.hint.replace(/\.$/, "")));
    gloss.appendChild(item);
  }
  box.append(x, lead, gloss);
  return box;
}

/**
 * Base picker. One-click presets cover the common cases so a rebase can be
 * started without typing anything; "Change base…" takes an arbitrary ref.
 *
 * NOTE: this must never use window.prompt — Electron renderers don't implement
 * it, so the old prompt silently did nothing and the view looked dead.
 */
function baseBar(state: RebasePlanState, wrap: HTMLElement, nav: (v: string) => void): HTMLElement {
  const bar = el("div", "rb-basebar");

  const load = (base: string): void => {
    void (async () => {
      wrap.replaceChildren(loadingCard());
      try {
        const re = await host.invoke("rebase:load", { base });
        if (re.ok && re.commits.length) {
          build(wrap, nav, re);
          return;
        }
        toast(re.message || `No commits between ${short(base)} and HEAD.`, "error");
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), "error");
      }
      // Fall back to whatever was on screen before.
      if (state.commits.length) build(wrap, nav, state);
      else void mount(wrap, nav);
    })();
  };

  const preset = (label: string, base: string, title: string): void => {
    const b = el("button", "rb-chip") as HTMLButtonElement;
    b.textContent = label;
    b.title = title;
    if (base === state.base) b.classList.add("is-active");
    b.addEventListener("click", () => load(base));
    bar.appendChild(b);
  };

  preset("Last 5", "HEAD~5", "Rebase the last 5 commits");
  preset("Last 10", "HEAD~10", "Rebase the last 10 commits");
  preset("Last 20", "HEAD~20", "Rebase the last 20 commits");
  preset("Upstream", "@{upstream}", "Rebase everything not yet pushed");

  const btn = el("button", "rb-btn ghost") as HTMLButtonElement;
  btn.append(glyph("edit"), span("Change base…"));
  btn.title = "Rebase onto a specific commit or branch";
  btn.addEventListener("click", () => {
    void (async () => {
      const next = await promptInline(
        "Rebase onto…",
        "e.g. HEAD~5, main, origin/main, or a commit SHA",
        state.base === "--root" ? "" : state.base,
        "Load commits",
      );
      if (next && next.trim()) load(next.trim());
    })();
  });
  bar.appendChild(btn);
  return bar;
}

/** Shown when git is mid-rebase: the only useful actions are continue/abort. */
function inProgressCard(reload: () => void): HTMLElement {
  const card = el("div", "rb-inprogress");
  const head = el("div", "rb-inprogress-head");
  head.append(glyph("debug-pause"), span("A rebase is in progress"));
  const body = span(
    "Git stopped part-way — resolve any conflicts in the Changes view, then continue. Aborting restores the branch to where it started.",
    "rb-inprogress-body",
  );
  const btns = el("div", "rb-inprogress-btns");
  const cont = el("button", "rb-btn primary") as HTMLButtonElement;
  cont.append(glyph("debug-continue"), span("Continue"));
  cont.addEventListener("click", () => {
    void (async () => {
      cont.disabled = true;
      const r = await host.invoke("rebase:continue", undefined);
      if (r.ok) {
        toast("Rebase continued.", "success");
      } else {
        toast(r.message || "Couldn't continue — unresolved conflicts?", "error", 6000);
      }
      cont.disabled = false;
      reload();
    })();
  });
  const abort = el("button", "rb-btn danger") as HTMLButtonElement;
  abort.append(glyph("circle-slash"), span("Abort"));
  abort.addEventListener("click", () => {
    void (async () => {
      const ok = await confirmDialog({
        title: "Abort the rebase?",
        message: "The branch returns to exactly where it was before the rebase started.",
        confirmLabel: "Abort rebase",
        danger: true,
      });
      if (!ok) return;
      const r = await host.invoke("rebase:abort", undefined);
      toast(r.ok ? "Rebase aborted." : r.message || "Couldn't abort.", r.ok ? "success" : "error");
      reload();
    })();
  });
  btns.append(cont, abort);
  card.append(head, body, btns);
  return card;
}

function consequence(action: RebaseAction, target: string | null): { icon: string; text: string } | null {
  const into = target ? `“${clip(target, 44)}”` : "the commit above";
  switch (action) {
    case "squash":
      return { icon: "fold-up", text: `Folds up into ${into} — keeps both messages` };
    case "fixup":
      return { icon: "fold-up", text: `Folds up into ${into} — drops this message` };
    case "edit":
      return { icon: "debug-pause", text: "The rebase pauses here so you can amend this commit, then Continue" };
    case "drop":
      return { icon: "trash", text: "This commit will be deleted" };
    default:
      return null;
  }
}

function initials(name: string): string {
  const p = (name || "?").trim().split(/\s+/);
  return ((p[0] || "?")[0] + (p[1] ? p[1][0] : "")).toUpperCase();
}

function hue(name: string): number {
  let h = 7;
  for (const c of name || "") h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function short(ref: string): string {
  if (ref === "--root") return "the root commit";
  return /^[0-9a-f]{40}$/i.test(ref) ? ref.slice(0, 7) : ref;
}
