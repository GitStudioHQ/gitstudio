// The conflicts dashboard: every conflicted file of the stopped operation, what
// can be done to each, and the way out of the operation itself.
//
// Ported from Merge Studio's conflictsHtml.ts, where it was an inline <script>
// inside a template literal — a string to tsc and esbuild, so neither ever saw
// its code. This is a typed DOM component instead, mounted as-is by the
// extensions' webview panel (conflicts/main.ts) and natively by the desktop's
// Changes view. It keeps everything Merge Studio had — the operation chip, the
// progress bar, the rows with their badges, whole-file Accept Yours / Accept
// Theirs, Merge…, resolution pills, hold-to-undo, the success card, Close —
// and adds what issue #12 asked for: the direction bar ("test → onto →
// master"), the commit being replayed and "commit N of M", and Continue / Skip /
// Abort, each gated the way git gates it and confirmed inline.
//
// The component holds no git state. The host sends a full ConflictsState after
// every change; the component posts ConflictsActions and nothing else. Every
// name it shows — a branch, a path, a subject — is written as a text node.

import type {
  ConflictFileView,
  ConflictsAction,
  ConflictsState,
  OperationView,
  SideRole,
} from "@gitstudio/host-bridge/conflictsProtocol";
import {
  abortConfirm,
  abortLabel,
  appendName,
  choicePill,
  continueBlockedText,
  dashboardHeading,
  directionParts,
  directionText,
  hasText,
  opChipLabel,
  roleWord,
  sha7,
  shapeWord,
  sideOf,
  skipConfirm,
  stepText,
  successCard,
  willDropText,
} from "./opText";

export interface DashboardTimers {
  set(fn: () => void, ms: number): number;
  clear(id: number): void;
}

export interface ConflictsDashboardOptions {
  /** Deliver an action to the host. */
  post(action: ConflictsAction): void;
  /** Timers for hold-to-undo (tests pass a fake clock). */
  timers?: DashboardTimers;
  /**
   * Whether this host can close the dashboard. A webview panel can; the
   * desktop's Changes view hosts it in place and cannot.
   */
  closable?: boolean;
}

const MS_MARK = `<svg class="cd-mark-svg" viewBox="0 0 256 256" aria-hidden="true"><defs><linearGradient id="cd_ms_bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2C3343"/><stop offset="1" stop-color="#181C24"/></linearGradient><linearGradient id="cd_ms_res" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9486F6"/><stop offset="1" stop-color="#6B5BE6"/></linearGradient></defs><rect width="256" height="256" rx="52" fill="url(#cd_ms_bg)"/><rect x="100" y="46" width="56" height="166" rx="11" fill="url(#cd_ms_res)" stroke="#AEA6F8" stroke-width="1.5"/><rect x="108" y="116" width="40" height="22" rx="5" fill="#FFFFFF" opacity="0.96"/><path d="M84 116 L102 127 L84 138" fill="none" stroke="#F4F6FA" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><path d="M172 116 L154 127 L172 138" fill="none" stroke="#F4F6FA" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><rect x="32" y="56" width="52" height="146" rx="9" fill="#454F62" stroke="#5A6679" stroke-width="1.5"/><rect x="40" y="116" width="36" height="22" rx="5" fill="#E06A52"/><rect x="172" y="56" width="52" height="146" rx="9" fill="#454F62" stroke="#5A6679" stroke-width="1.5"/><rect x="180" y="116" width="36" height="22" rx="5" fill="#E06A52"/></svg>`;

function codicon(name: string, extra = ""): HTMLElement {
  const s = document.createElement("span");
  s.className = `codicon codicon-${name}${extra ? ` ${extra}` : ""}`;
  s.setAttribute("aria-hidden", "true");
  return s;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/**
 * A row's file: its name, then its folder, muted (the way the Changes lists
 * show a path). The folder is cut in the MIDDLE: the leading folders give way
 * first, behind an ellipsis, and the folder the file sits in stays as long as
 * it can — "packages/web…conflicts". The whole path is the cell's title.
 */
function fileCell(path: string): HTMLElement {
  const cell = el("span", "cd-file");
  cell.title = path;
  const slash = path.lastIndexOf("/");
  cell.appendChild(el("span", "cd-name", slash >= 0 ? path.slice(slash + 1) : path));
  if (slash > 0) {
    const dir = path.slice(0, slash);
    const cut = dir.lastIndexOf("/");
    const d = el("span", "cd-dir");
    if (cut >= 0) d.appendChild(el("span", "cd-dir-head", dir.slice(0, cut + 1)));
    d.appendChild(el("span", "cd-dir-tail", cut >= 0 ? dir.slice(cut + 1) : dir));
    cell.appendChild(d);
  }
  return cell;
}

/**
 * A button's words, in their own span: a slot narrower than a label cuts it
 * with an ellipsis instead of overflowing the button. The words a compact
 * dashboard can do without ("Accept" of Accept Yours, "the file" of Delete
 * the file) are a .cd-trim span, which a narrow pane hides from SIGHT only:
 * the button's text and its accessible name stay whole.
 */
function buttonLabel(label: string): HTMLElement {
  const span = el("span", "cd-btn-label");
  const trim = /^(Accept )(.+)$/.exec(label) ?? /^(Delete)( the file)$/.exec(label);
  if (!trim) {
    span.textContent = label;
  } else if (trim[1] === "Accept ") {
    span.append(el("span", "cd-trim", trim[1]), document.createTextNode(trim[2]));
  } else {
    span.append(document.createTextNode(trim[1]), el("span", "cd-trim", trim[2]));
  }
  return span;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** A resolved row's choice in one or two words (the pill adds the side's name: choicePill). */
export function choiceText(choice: ConflictFileView["choice"]): string {
  return choice === "yours"
    ? "kept yours"
    : choice === "theirs"
      ? "kept theirs"
      : choice === "merged"
        ? "merged"
        : "resolved";
}

/** The commit card's verb, by operation. */
function commitVerb(op: OperationView): string {
  switch (op.kind) {
    case "rebase":
    case "rebase-merge-step":
      return "Replaying";
    case "cherry-pick":
      return "Picking";
    case "revert":
      return "Reverting";
    case "am":
      return "Applying";
    default:
      return "Commit";
  }
}

export class ConflictsDashboard {
  readonly element: HTMLElement;
  private readonly post: (action: ConflictsAction) => void;
  private readonly timers: DashboardTimers;
  private readonly closable: boolean;
  private state?: ConflictsState;
  /** The inline confirm open in the footer, if any. Survives a state push of the same episode. */
  private confirming?: "abort" | "skip" | "drop";
  private episode?: string;
  /** Rows the reader just acted on, drawn busy until the host's next state. */
  private localBusy = new Set<string>();
  /** Cancels for holds in progress, so a re-render or dispose never leaves a timer armed. */
  private holds = new Set<() => void>();
  /**
   * A Continue / Skip / Abort was posted and the host has not answered yet.
   * The footer stays locked until the next state: two presses must never
   * become two commands (the desktop's main process QUEUES a second call).
   */
  private sent = false;

  constructor(root: HTMLElement, opts: ConflictsDashboardOptions) {
    this.post = opts.post;
    this.timers = opts.timers ?? {
      set: (fn, ms) => window.setTimeout(fn, ms),
      clear: (id) => window.clearTimeout(id),
    };
    this.closable = opts.closable ?? true;
    this.element = el("div", "cd-dash");
    // A label on a plain div is ignored; as a region it is a landmark.
    this.element.setAttribute("role", "region");
    this.element.setAttribute("aria-label", "Conflicts");
    root.replaceChildren(this.element);
    this.element.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.confirming) {
        e.stopPropagation();
        const trigger = triggerKey(this.confirming);
        this.confirming = undefined;
        this.rerender(trigger);
      }
    });
    // The host answers with the first full state.
    this.post({ type: "ready" });
  }

  /** Paint a full state. Every host re-sends one after each change. */
  render(state: ConflictsState): void {
    // Hosts re-send the whole state after any repository event (in VS Code a
    // click that focuses the window sets off vscode.git's refresh). A repaint
    // cancels every hold, so while one is in progress a re-send of exactly
    // what is on screen is not painted — the hold would never complete.
    if (this.holds.size > 0 && this.state && JSON.stringify(state) === JSON.stringify(this.state)) {
      return;
    }
    if (state.op.episode !== this.episode) {
      // A new stop — a rebase's next commit, or a different operation: the
      // file list, a half-answered confirm and any row spinner belong to the
      // one before it.
      this.episode = state.op.episode;
      this.confirming = undefined;
    }
    this.localBusy.clear();
    this.sent = false;
    if (state.busy) this.confirming = undefined;
    this.state = state;
    this.paint();
  }

  dispose(): void {
    for (const cancel of [...this.holds]) cancel();
    this.holds.clear();
    this.element.remove();
  }

  /**
   * Put the keyboard on a file's row — its Merge… while it is pending, its
   * Hold to undo once resolved, else its first live button. For a host that
   * brings the dashboard back after the merge editor closed: the editor took
   * the focused button with it, and the keyboard should land where it left
   * from, not on <body>. False when the row, or a live control in it, is not
   * there (yet).
   */
  focusFile(path: string): boolean {
    const row = [...this.element.querySelectorAll<HTMLElement>(".cd-row")].find((r) => r.dataset.path === path);
    if (!row) return false;
    const live = (b: HTMLButtonElement | null | undefined): b is HTMLButtonElement => !!b && !b.disabled;
    const byKey = [`merge:${path}`, `restore:${path}`]
      .map((k) => row.querySelector<HTMLButtonElement>(`[data-key="${cssEscape(k)}"]`))
      .find(live);
    const pick = byKey ?? [...row.querySelectorAll<HTMLButtonElement>("button")].find(live);
    if (!pick) return false;
    pick.focus();
    return document.activeElement === pick;
  }

  // ── painting ──

  private rerender(focusKey?: string): void {
    if (!this.state) return;
    this.paint(focusKey);
  }

  private paint(focusKeyOverride?: string): void {
    const state = this.state;
    if (!state) return;
    // Keep the keyboard where it was across a repaint — only when it was IN
    // the dashboard: a host page has its own `data-key`s (the desktop's file
    // rows), and a repaint must never pull focus in from outside.
    const active = document.activeElement as HTMLElement | null;
    const focusKey =
      focusKeyOverride ??
      (active && this.element.contains(active)
        ? active.closest("[data-key]")?.getAttribute("data-key") ?? undefined
        : undefined);
    for (const cancel of [...this.holds]) cancel();
    this.holds.clear();

    const op = state.op;
    const files = state.files;
    const pending = files.filter((f) => f.status !== "resolved").length;
    const allDone = files.length > 0 && pending === 0;
    const root = this.element;
    root.className = "cd-dash" + (state.busy ? " is-busy" : "") + (allDone ? " is-done" : "");
    root.dataset.kind = op.kind;
    root.replaceChildren();

    // Header: brand, title, which repository (secondary: "in <repo>"), what
    // is in progress. The words wrap as one line beside the mark.
    const head = el("header", "cd-head");
    const mark = el("span", "cd-mark");
    if (state.brand.mark === "merge-studio") mark.innerHTML = MS_MARK;
    else mark.appendChild(codicon("git-merge"));
    mark.title = state.brand.name;
    // Which operation's conflicts (POLISH A5.4). A finished stash apply keeps
    // its own heading: git reports nothing in progress by then.
    const heading = state.finished ? "Stash conflicts" : dashboardHeading(op);
    const title = el("h1", "cd-title", heading);
    root.setAttribute("aria-label", heading);
    const headline = el("div", "cd-headline");
    headline.appendChild(title);
    if (state.repoName) {
      const repo = el("span", "cd-repo", `in ${state.repoName}`);
      repo.title = state.repoName;
      headline.appendChild(repo);
    }
    // Nothing in progress and nothing unmerged (our own Continue just ended the
    // operation, and the page stays to say "Rebase complete"): no chip. It used
    // to read a red "UNMERGED FILES" over that, contradicting it. With every
    // file resolved and the operation still waiting for Continue, the chip
    // stays: the rebase IS still in progress (it used to vanish there).
    const nothingLeft = op.kind === "none" && pending === 0;
    if (!nothingLeft && !state.finished) headline.appendChild(el("span", "cd-chip", opChipLabel(op)));
    head.append(mark, headline);
    root.appendChild(head);

    if (op.title) root.appendChild(el("div", "cd-optitle", op.title));

    const dir = directionParts(op);
    if (dir) {
      const bar = el("div", "cd-dirbar");
      bar.setAttribute("role", "group");
      bar.setAttribute("aria-label", directionText(op));
      bar.append(this.branchPill(dir.from.role, dir.from.name, dir.from.description));
      bar.append(el("span", "cd-dir-verb", `→ ${dir.verb} →`));
      bar.append(this.branchPill(dir.to.role, dir.to.name, dir.to.description));
      root.appendChild(bar);
    }

    const step = stepText(op);
    if (op.commit && (op.commit.sha || op.commit.subject)) {
      const card = el("div", "cd-commit");
      card.appendChild(codicon("git-commit"));
      card.appendChild(el("span", "cd-commit-verb", commitVerb(op)));
      if (op.commit.sha) card.appendChild(el("code", "cd-sha", sha7(op.commit.sha)));
      const subject = el("span", "cd-subject", op.commit.subject);
      subject.title = op.commit.subject;
      card.appendChild(subject);
      // Who and where in the sequence, as one group at the line's end: in a
      // narrow pane it moves under the subject whole.
      const meta = el("span", "cd-commit-meta");
      if (op.commit.author) meta.appendChild(el("span", "cd-author", `by ${op.commit.author}`));
      if (step) meta.appendChild(el("span", "cd-step", step));
      if (meta.childElementCount) card.appendChild(meta);
      root.appendChild(card);
    } else if (step) {
      root.appendChild(el("div", "cd-step cd-step-alone", step));
    }

    if (op.pause) {
      const p = el("div", "cd-pause");
      p.append(codicon("debug-pause"), el("span", "cd-pause-text", op.pause.detail || "Paused"));
      p.appendChild(
        el(
          "span",
          "cd-pause-sub",
          op.pause.reason === "exec-failed"
            ? "A command in the plan failed. Fix what it needs, then continue."
            : "Nothing to resolve here. Continue when you are ready.",
        ),
      );
      root.appendChild(p);
    }

    if (op.willDrop) {
      const w = el("div", "cd-willdrop");
      w.setAttribute("role", "alert");
      w.append(codicon("warning"), el("span", "", willDropText(op)));
      root.appendChild(w);
    }

    if (state.tip) {
      root.appendChild(this.tipCard(state.tip));
    }

    if (state.notice) {
      const n = el("div", `cd-notice is-${state.notice.kind}`);
      n.append(
        codicon(state.notice.kind === "error" ? "error" : state.notice.kind === "warn" ? "warning" : "info"),
        el("span", "", state.notice.text),
      );
      root.appendChild(n);
    }

    if (state.total > 0) {
      const row = el("div", "cd-progress");
      const bar = el("div", "cd-bar");
      const fill = el("div", "cd-bar-fill");
      fill.style.width = `${Math.round((state.resolved / state.total) * 100)}%`;
      bar.appendChild(fill);
      bar.setAttribute("role", "progressbar");
      bar.setAttribute("aria-valuemin", "0");
      bar.setAttribute("aria-valuemax", String(state.total));
      bar.setAttribute("aria-valuenow", String(state.resolved));
      bar.setAttribute("aria-label", "Files resolved");
      row.append(bar, el("span", "cd-progress-label", `${state.resolved} of ${state.total} resolved`));
      root.appendChild(row);
    }

    if (allDone) {
      // Every file of THIS stop resolved — but git may still refuse Continue
      // (conflict markers staged, say): then the card says that, not "All
      // conflicts resolved" over a disabled Continue.
      const blocked = !state.finished && !!op.verbs.continue && !op.canContinue && !!op.continueBlocked;
      const card = state.finished
        ? { title: state.finished.title, note: state.finished.text }
        : blocked
          ? { title: "Not ready to continue yet", note: op.continueBlocked! }
          : successCard(op);
      const done = el("div", `cd-done${blocked ? " is-blocked" : ""}`);
      const note = el("span", "cd-done-note", card.note);
      note.id = "cd-done-note";
      done.append(codicon(blocked ? "warning" : "pass-filled", "cd-done-icon"), el("h2", "cd-done-title", card.title), note);
      if (!state.finished && !blocked) {
        done.appendChild(el("span", "cd-done-hint", "Hold Undo on a file to bring its conflict back."));
      }
      root.appendChild(done);
    }

    const list = el("div", "cd-list");
    list.setAttribute("role", "list");
    // An empty list says so — unless an outcome ("Rebase complete") already says more.
    if (files.length === 0 && !op.pause && state.outcome?.kind !== "done") {
      list.appendChild(
        el(
          "div",
          "cd-empty",
          op.kind === "none" ? "No conflicted files." : "No conflicted files at this step.",
        ),
      );
    }
    for (const f of files) list.appendChild(this.row(f, state));
    if (list.childElementCount > 0) root.appendChild(list);

    // POLISH A5.10: in the middle of an operation only the FIRST link (the
    // product's problem report); the rest (a rating, sponsoring) wait until
    // the work is done — every file resolved, or the operation finished. Small
    // text links under the list: as buttons in the footer they sat between
    // Abort and Continue with the same weight as both.
    const finishedWork = allDone || !!state.finished || state.outcome?.kind === "done";
    const links = finishedWork ? (state.supportLinks ?? []) : (state.supportLinks ?? []).slice(0, 1);
    if (links.length) {
      const support = el("div", "cd-support");
      for (const link of links) {
        const a = el("button", "cd-link", link.label);
        a.type = "button";
        a.title = link.url;
        a.dataset.key = `link:${link.url}`;
        a.addEventListener("click", () => this.post({ type: "openExternal", url: link.url }));
        support.appendChild(a);
      }
      root.appendChild(support);
    }

    if (state.outcome) {
      const o = el("div", `cd-outcome is-${state.outcome.kind}`);
      o.setAttribute("role", "status");
      o.append(
        codicon(state.outcome.kind === "done" ? "pass-filled" : state.outcome.kind === "failed" ? "error" : "info"),
        el("span", "", state.outcome.text),
      );
      root.appendChild(o);
    }

    root.appendChild(this.footer(state, pending, allDone));

    if (focusKey) {
      const again = root.querySelector<HTMLElement>(`[data-key="${cssEscape(focusKey)}"]`);
      if (again && !(again as HTMLButtonElement).disabled) again.focus({ preventScroll: true });
    }
  }

  /** The one-time tip (POLISH A5.9): its words, "Got it", and "Why?" when there is a page for it. */
  private tipCard(tip: NonNullable<ConflictsState["tip"]>): HTMLElement {
    const t = el("div", "cd-tip");
    t.setAttribute("role", "note");
    t.append(codicon("info"), el("span", "cd-tip-text", tip.text));
    const actions = el("span", "cd-tip-actions");
    if (tip.why) {
      const why = tip.why;
      const b = el("button", "cd-link", "Why?");
      b.type = "button";
      b.dataset.key = "tip-why";
      b.title = why;
      b.addEventListener("click", () => this.post({ type: "openExternal", url: why }));
      actions.appendChild(b);
    }
    actions.appendChild(
      this.button("Got it", "Don't show this again", "tip-dismiss", false, () => this.post({ type: "dismissTip", id: tip.id })),
    );
    t.appendChild(actions);
    return t;
  }

  private branchPill(role: SideRole, name: string, description: string): HTMLElement {
    const p = el("span", `cd-branch cd-branch-${role}`);
    p.appendChild(codicon("git-branch", "cd-branch-ico"));
    p.appendChild(el("span", "cd-role", role === "yours" ? "YOURS" : "THEIRS"));
    const n = el("span", "cd-bname");
    appendName(n, name || roleWord(role));
    p.appendChild(n);
    p.title = description || name;
    return p;
  }

  /**
   * One file, on the list's grid: status | file | pill | actions. Every row
   * has all four cells, empty or not, so the pill column and the three action
   * slots line up down the whole list ("everything is everywhere" was rows
   * that right-aligned whatever buttons they had). The actions are three
   * fixed-width SLOTS, by role: Accept Yours (or the deleting yours) always in
   * the first, Accept Theirs in the second, Merge… in the third; a resolved
   * row's Hold to undo takes the first.
   */
  private row(f: ConflictFileView, state: ConflictsState): HTMLElement {
    const busy = f.status === "busy" || this.localBusy.has(f.path);
    const resolved = f.status === "resolved" && !busy;
    const row = el("div", "cd-row" + (resolved ? " is-resolved" : busy ? " is-busy" : ""));
    row.setAttribute("role", "listitem");
    row.dataset.path = f.path;

    const status = el("span", "cd-status");
    if (busy) {
      const s = el("span", "cd-spinner");
      s.setAttribute("aria-label", "Working");
      status.appendChild(s);
    } else if (resolved) {
      const ring = el("span", "cd-check");
      ring.appendChild(codicon("check"));
      status.appendChild(ring);
    } else {
      status.appendChild(el("span", "cd-dot"));
    }
    row.appendChild(status);

    row.appendChild(fileCell(f.path));

    const pillCell = el("span", "cd-pillcell");
    if (resolved) {
      // "kept yours · test" (P-53), "deleted" for a take of the side with no file.
      const said = choicePill(f, state.op);
      const pill = el("span", "cd-choice", `✓ ${said.text}`);
      pill.title = said.title;
      pillCell.appendChild(pill);
    } else if (!busy) {
      const word = f.badge || shapeWord(f.shape);
      if (word) {
        const badge = el("span", "cd-badge", word);
        badge.title = word;
        pillCell.appendChild(badge);
      }
    }
    row.appendChild(pillCell);

    const actions = el("span", "cd-actions");
    if (resolved) {
      // A finished stash apply has nothing left to undo INTO (git keeps no
      // operation for it), so no hold-to-undo there.
      if (!state.finished) actions.appendChild(this.holdButton(f, state));
    } else if (!busy) {
      const disabled = state.busy;
      if (f.shape === "both-deleted") {
        actions.appendChild(
          this.button(
            "Delete the file",
            "Neither side has this file — delete it and stage the deletion",
            `delete:${f.path}`,
            disabled,
            () => {
              this.markBusy(f.path);
              this.post({ type: "delete", path: f.path });
            },
            "cd-danger cd-slot-yours",
          ),
        );
      } else {
        for (const role of ["yours", "theirs"] as const) {
          const side = sideOf(state.op, role);
          const missing = f.missingRole === role;
          const commit = f.shape === "submodule" ? f.commits?.[role] : undefined;
          actions.appendChild(
            this.button(
              missing ? "Delete the file" : `Accept ${roleWord(role)}`,
              missing
                ? `${roleWord(role)}${side.name ? ` (${side.name})` : ""} has no version of this file — accepting it deletes the file`
                : f.shape === "submodule"
                  ? `Point the submodule at ${role}'s commit${commit ? ` ${commit.slice(0, 7)}` : ""}${side.name ? ` (${side.name})` : ""} and stage it`
                  : `Resolve the whole file with ${role}${side.description ? ` — ${side.description}` : side.name ? ` (${side.name})` : ""}`,
              `accept:${role}:${f.path}`,
              disabled,
              () => {
                this.markBusy(f.path);
                this.post({ type: "accept", path: f.path, role });
              },
              `${missing ? "cd-danger" : "cd-accept"} cd-slot-${role}`,
            ),
          );
        }
        if (hasText(f.shape)) {
          actions.appendChild(
            this.button(
              "Merge…",
              "Resolve it change by change in the merge editor",
              `merge:${f.path}`,
              disabled,
              () => this.post({ type: "merge", path: f.path }),
              "cd-primary cd-slot-merge",
            ),
          );
        }
      }
    }
    row.appendChild(actions);
    return row;
  }

  /** Post an operation verb once, and lock the footer until the host answers. */
  private send(action: ConflictsAction): void {
    if (this.sent) return;
    this.sent = true;
    this.post(action);
    this.rerender();
  }

  private markBusy(path: string): void {
    this.localBusy.add(path);
    this.rerender();
  }

  private button(
    label: string,
    title: string,
    key: string,
    disabled: boolean,
    onClick: () => void,
    cls = "",
    icon = "",
  ): HTMLButtonElement {
    const b = el("button", `cd-btn${cls ? ` ${cls}` : ""}`);
    b.type = "button";
    if (icon) b.appendChild(codicon(icon));
    b.appendChild(buttonLabel(label));
    b.title = title;
    b.dataset.key = key;
    b.disabled = disabled;
    b.addEventListener("click", () => {
      if (b.disabled) return;
      onClick();
    });
    return b;
  }

  /**
   * Undo a resolved row by HOLDING the button for `holdToUndoMs` — a pointer
   * press, or Enter / Space held down. A plain click does nothing: bringing a
   * conflict back is one gesture too many to be an accident.
   */
  private holdButton(f: ConflictFileView, state: ConflictsState): HTMLButtonElement {
    const ms = state.holdToUndoMs;
    const btn = el("button", "cd-undo-hold cd-slot-yours");
    btn.type = "button";
    btn.dataset.key = `restore:${f.path}`;
    btn.title = "Hold to bring the conflict back (hold Enter or Space from the keyboard)";
    btn.setAttribute("aria-label", `Hold to undo the resolution of ${f.path}`);
    btn.disabled = state.busy;
    const fill = el("span", "cd-undo-fill");
    const label = el("span", "cd-undo-label", "Hold to undo");
    btn.append(fill, label);

    let timer = 0;
    const reset = (): void => {
      btn.classList.remove("arming");
      fill.style.transitionDuration = "180ms";
      fill.style.width = "0%";
    };
    const cancel = (): void => {
      if (!timer) return;
      this.timers.clear(timer);
      timer = 0;
      this.holds.delete(cancel);
      reset();
    };
    const start = (): void => {
      if (timer || btn.disabled) return;
      btn.classList.add("arming");
      fill.style.transitionDuration = `${ms}ms`;
      // Force a layout so the sweep starts from 0 even mid-cancel.
      void fill.offsetWidth;
      fill.style.width = "100%";
      this.holds.add(cancel);
      timer = this.timers.set(() => {
        timer = 0;
        this.holds.delete(cancel);
        this.markBusy(f.path);
        this.post({ type: "restore", path: f.path });
      }, ms);
    };
    btn.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      start();
    });
    for (const type of ["pointerup", "pointerleave", "pointercancel"] as const) {
      btn.addEventListener(type, cancel);
    }
    btn.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      if (!e.repeat) start();
    });
    btn.addEventListener("keyup", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      cancel();
    });
    btn.addEventListener("blur", cancel);
    // The synthetic click a key press produces is not a hold.
    btn.addEventListener("click", (e) => e.preventDefault());
    return btn;
  }

  private footer(state: ConflictsState, pending: number, allDone: boolean): HTMLElement {
    const op = state.op;
    const foot = el("footer", "cd-foot");

    if (this.confirming) {
      foot.appendChild(this.confirmRow(state));
      return foot;
    }

    const busy = state.busy || this.sent;
    const abort = this.button(
      abortLabel(op),
      abortConfirm(op).detail,
      "abort",
      busy,
      () => {
        this.confirming = "abort";
        this.rerender("confirm-keep");
      },
      "cd-danger",
      "circle-slash",
    );
    // Something to end: an operation, or unmerged files to reset. A finished
    // stash apply, or unmerged files all resolved with no operation, has
    // nothing left to abort.
    if (!state.finished && (op.kind !== "none" || pending > 0)) foot.appendChild(abort);

    foot.appendChild(el("span", "cd-spacer"));

    // The count, unless Continue's reason below already says it ("Resolve
    // the 3 conflicted files first", "3 files still have conflicts"): the
    // footer read "30 conflicting files  30 files still have conflicts".
    const why = op.verbs.continue && !op.canContinue ? continueBlockedText(op, pending) : "";
    if (pending > 0 && !why) foot.appendChild(el("span", "cd-counter", plural(pending, "conflicting file")));

    if (op.canSkip && op.verbs.skip) {
      foot.appendChild(
        this.button(
          op.verbs.skip,
          skipConfirm(op).detail,
          "skip",
          busy,
          () => {
            this.confirming = "skip";
            this.rerender("confirm-keep");
          },
          "",
          "debug-step-over",
        ),
      );
    }

    if (op.verbs.continue && !state.finished) {
      const cont = this.button(
        op.verbs.continue,
        why || op.title || op.verbs.continue,
        "continue",
        busy || !op.canContinue,
        () => {
          if (op.willDrop) {
            this.confirming = "drop";
            this.rerender("confirm-keep");
            return;
          }
          this.send({ type: "continue" });
        },
        "cd-primary",
        "debug-continue",
      );
      if (why && allDone && op.continueBlocked) {
        // The success card's place already says it, in full (is-blocked).
        cont.setAttribute("aria-describedby", "cd-done-note");
      } else if (why) {
        const reason = el("span", "cd-why", why);
        reason.id = "cd-why";
        cont.setAttribute("aria-describedby", reason.id);
        foot.appendChild(reason);
      }
      foot.appendChild(cont);
    }

    if (this.closable && (allDone || state.finished)) {
      foot.appendChild(
        // Secondary: beside Continue there is ONE primary action (the verifier
        // found two identical primary buttons on the finished card).
        this.button("Close", "Close this dashboard", "close", false, () => this.post({ type: "close" })),
      );
    }
    return foot;
  }

  private confirmRow(state: ConflictsState): HTMLElement {
    const op = state.op;
    const which = this.confirming;
    const ask =
      which === "abort"
        ? abortConfirm(op)
        : which === "skip"
          ? skipConfirm(op)
          : { question: "Drop the empty commit?", detail: willDropText(op), confirm: "Drop it and continue" };
    const row = el("div", "cd-confirm");
    row.setAttribute("role", "alertdialog");
    row.setAttribute("aria-label", ask.question);
    const text = el("div", "cd-confirm-text");
    text.append(el("strong", "cd-confirm-q", ask.question), el("span", "cd-confirm-d", ask.detail));
    const keep = this.button("Keep going", "Leave everything as it is", "confirm-keep", false, () => {
      this.confirming = undefined;
      this.rerender(which ? triggerKey(which) : undefined);
    });
    const go = this.button(ask.confirm, ask.detail, "confirm-go", state.busy || this.sent, () => {
      this.confirming = undefined;
      if (which === "abort") this.send({ type: "abort" });
      else if (which === "skip") this.send({ type: "skip" });
      else this.send({ type: "continue", confirmDrop: true });
    }, which === "drop" ? "cd-primary" : "cd-danger");
    row.append(text, keep, go);
    return row;
  }
}

/** The footer control a confirm returns the keyboard to. */
function triggerKey(which: "abort" | "skip" | "drop"): string {
  return which === "drop" ? "continue" : which;
}

/** CSS.escape where it exists (every browser), a conservative fallback elsewhere. */
function cssEscape(s: string): string {
  const css = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS;
  return css?.escape ? css.escape(s) : s.replace(/["\\]/g, "\\$&");
}
