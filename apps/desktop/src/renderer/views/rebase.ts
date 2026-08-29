// Interactive Rebase — a full workspace view (not a dialog), mirroring the
// GitStudio extension's rebase panel: a commit rail with node dots, per-commit
// action dropdowns, plain-English consequences, drag-to-reorder, and a dimmed
// "onto" base row. Nothing touches the repository until Start Rebase is pressed,
// and the whole run is a single git invocation driven by the shared
// @gitstudio/git-service/RebaseRunner (the same module the extension uses).

import { host } from "../bridge";
import { el, span, glyph, emptyState, cleanErr } from "../ui";
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
  { id: "squash", label: "Squash", hint: "Merge into the commit below it — keep both messages." },
  { id: "fixup", label: "Fixup", hint: "Merge into the commit below it — drop this message." },
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
    // The shape check belongs INSIDE the try: reading `state.ok` outside it
    // meant an unexpected response threw past the error path and left the
    // loading spinner on screen forever, with no message and no retry.
    if (!state || typeof state.ok !== "boolean") {
      throw new Error("The rebase plan came back in an unexpected shape.");
    }
  } catch (err) {
    wrap.replaceChildren(
      emptyState("Couldn't load the rebase plan", cleanErr(err), {
        icon: "warning",
        action: { label: "Try again", icon: "refresh", onClick: () => void mount(wrap, nav) },
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
    // The host's note, when it has one, is the REASON the list is empty — most
    // often "a merge commit in this range isn't listed", because a range made
    // only of merges leaves nothing to pick. Printing the hardcoded sentence
    // over it stated a falsehood: there ARE commits between those two refs.
    wrap.replaceChildren(
      emptyState(
        "Nothing to rebase",
        state.message ??
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
  title.append(glyph("list-ordered"), span("Interactive rebase"));
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
  const applyLabel = span("Start rebase");
  applyBtn.append(glyph("play"), applyLabel);

  /**
   * Carry other local branches through the rewrite.
   *
   * Every commit gets a NEW sha, so a branch pointing at an old one is not left
   * alone by the rebase — it is left on a parallel line nothing references. The
   * plan builder emits `update-ref` for these, and the desktop never asked it
   * to, so a stack of branches inside the range was silently orphaned. Defaults
   * to the repo's own `rebase.updateRefs`, which is what the user's git would
   * have done; the control only appears when there is actually something to
   * carry.
   */
  const carried = [...new Set(rows.flatMap((r) => r.branches ?? []))];
  let carryBranches = state.updateRefs ?? false;
  if (carried.length) {
    const wrapEl = el("label", "rb-carry");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = carryBranches;
    box.addEventListener("change", () => {
      carryBranches = box.checked;
    });
    const names = carried.length <= 3 ? carried.join(", ") : `${carried.length} other branches`;
    wrapEl.append(box, span(`Move ${names} with the rewrite`));
    wrapEl.title =
      `These branches point at commits in this range: ${carried.join(", ")}. ` +
      `Rewriting gives those commits new ids, so unless they are moved too they ` +
      `will point at commits that are no longer in ${state.branch}.`;
    foot.appendChild(wrapEl);
  }
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

  /**
   * The commit a squash/fixup folds INTO. git melds into the entry BEFORE it in
   * the todo file, and the list is newest-first (issue #18), so on screen that is
   * the nearest kept commit BELOW. Scanning upward was right only while the list
   * ran oldest-first.
   */
  const foldTargetSubject = (i: number): string | null => {
    for (let j = i + 1; j < rows.length; j++) {
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
    // A squash folds into the nearest kept commit BELOW — the list is
    // newest-first (issue #18), and git melds into the entry before it in the
    // todo file. So the commit that CANNOT be squashed is the last kept one,
    // not the first.
    //
    // The guard checked `i === firstKeptIndex()`, the TOP of the list. That
    // refused the most ordinary interactive rebase there is — fold my latest
    // commit into the one before it — while happily accepting a squash on the
    // oldest commit, which git cannot execute, letting an impossible plan reach
    // the "you'll need to force-push" dialog. `firstKeptIndex` was a leftover
    // from before the ordering flip; `foldTargetSubject` already scans the right
    // way and already skips drop/squash/fixup chains, so ask it.
    if ((action === "squash" || action === "fixup") && foldTargetSubject(i) === null) {
      flashBanner("The oldest commit has nothing below it to fold into.");
      render();
      return;
    }
    rows[i].action = action;
    render();
    // Put the keyboard back on the control that was just used, the way `move`
    // does. Relying on the generic focus rescue alone left it on whichever row
    // happened to match — a different commit's dropdown, one keystroke from
    // setting an action nobody chose.
    (list.children[i] as HTMLElement | undefined)
      ?.querySelector<HTMLSelectElement>(".rb-action")
      ?.focus();
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
    // Which commit this control belongs to. Changing an action rebuilds the
    // list, and the focus rescue then matched on `title` — which is derived
    // from the action, so it changes at exactly the moment the rescue needs it
    // stable, and every other "Pick" row matched instead. Focus landed on a
    // DIFFERENT commit's dropdown, where the next keystroke set an action on a
    // commit the user never selected. `sameThing` checks dataset.num first.
    sel.dataset.num = r.sha;
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
    // The consequence rides the SUBJECT line, not a line of its own. Revealing a
    // second line under the row grew it by 17px the instant you chose an action,
    // which shoved every row below — including the next row's action dropdown,
    // the very control you reach for next. Choosing "squash" moved the thing you
    // were about to click before your hand got there.
    const cons = el("span", "rb-consequence");
    const c = consequence(r.action, foldTargetSubject(i));
    if (c) cons.append(glyph(c.icon), span(c.text));
    line.append(subj, cons, av, span(r.rel, "rb-meta"), sha);
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
    // The anchor row occupies the SAME columns as a commit row — an invisible
    // grip, then the ONTO badge in the action slot — so its subject starts on
    // the same left edge as every subject above it instead of 80px earlier.
    const grip = el("span", "rb-grip is-spacer");
    grip.appendChild(glyph("gripper"));
    row.append(rail, grip, span("onto", "rb-onto"));
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
        confirmLabel: "Start rebase",
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
          // The branches sitting on this commit. Without them the plan builder
          // has nothing to emit `update-ref` for, and every branch inside the
          // rewritten range is left pointing at a commit that is no longer in
          // this branch's history.
          branches: r.branches,
        }));
        const outcome = await host.invoke("rebase:apply", {
          base: state.base,
          rows: payload,
          updateRefs: carryBranches,
        });
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
        flashBanner(cleanErr(err), "error");
      } finally {
        busy = false;
        applyBtn.classList.remove("busy");
        applyBtn.disabled = false;
        applyLabel.textContent = "Start rebase";
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
  h.append(glyph("info"), span("Newest first, as in Commits; git replays them bottom → top. Drag to reorder."));
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
      " Reorder by dragging, or pick what happens to each commit below. Nothing changes until you press Start rebase.",
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

  /**
   * Load a new base.
   *
   * The composed plan — every action, the reordering, any message typed into a
   * reword — lives in the DOM this builds. So it must not be torn down until
   * there is something to replace it WITH. It used to blank the view to a
   * loading card first and, on any failure, "fall back" by rebuilding from the
   * original `state`: same commits, every action reset to pick, every edit
   * gone. Trying a base and finding it empty silently threw away the plan.
   *
   * The in-flight state goes on the control you pressed, not on the workspace.
   */
  const load = (base: string, btn?: HTMLButtonElement): void => {
    void (async () => {
      if (btn) {
        btn.disabled = true;
        btn.classList.add("is-busy");
      }
      try {
        const re = await host.invoke("rebase:load", { base });
        if (re.ok && re.commits.length) {
          build(wrap, nav, re);
          return;
        }
        toast(re.message || `No commits between ${short(base)} and HEAD.`, "error");
      } catch (err) {
        toast(cleanErr(err), "error");
      } finally {
        if (btn?.isConnected) {
          btn.disabled = false;
          btn.classList.remove("is-busy");
        }
      }
      // Nothing to show for the new base — so show what is still on screen.
      // There is no rebuild here on purpose: the live plan is untouched.
      if (!state.commits.length) void mount(wrap, nav);
    })();
  };

  const preset = (label: string, base: string, title: string): void => {
    const b = el("button", "rb-chip") as HTMLButtonElement;
    b.textContent = label;
    b.title = title;
    if (base === state.base) b.classList.add("is-active");
    b.addEventListener("click", () => load(base, b));
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
      if (next && next.trim()) load(next.trim(), btn as HTMLButtonElement);
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
    // Not "resolve any conflicts": a rebase can stop with a perfectly clean tree —
    // git refusing a todo it cannot execute is one way — and telling someone to
    // resolve conflicts that do not exist sends them looking for nothing.
    "Git stopped part-way. If there are conflicts, resolve them in the Changes view first, then continue. Aborting restores the branch to exactly where it started.",
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
  const into = target ? `“${clip(target, 44)}”` : "the commit below it";
  switch (action) {
    case "squash":
      return { icon: "fold-down", text: `Folds down into ${into} — keeps both messages` };
    case "fixup":
      return { icon: "fold-down", text: `Folds down into ${into} — drops this message` };
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
