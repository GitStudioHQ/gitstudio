// <gitstudio-commit-details> — the shared "inspect a commit" panel.
//
// The GitLens/GitKraken commit-details surface: who/when, the full message, the
// ref chips on this commit, and the changed-files list with per-file +/-
// stat bars — every file openable as a diff — plus a one-click action toolbar
// (checkout, branch, cherry-pick, revert, reset, copy). When `kind === "wip"`
// it renders the working tree instead (staged/unstaged groups + stage/commit
// actions), powering the graph's "uncommitted changes" node.
//
// Host-agnostic: the VS Code extension and the desktop app both mount this and
// listen for the `gs-file-open` / `gs-action` / `gs-copy` CustomEvents.

import { LitElement, html, css, nothing } from "lit";
import { codiconStyles } from "./styles/codicons";
import { gravatarUrl, avatarHue, authorInitials } from "./graph/avatar";
import type {
  CommitDetailsPayload,
  CommitDetailsActionId,
  CommitFileChange,
  WireRef,
} from "@gitstudio/host-bridge/commitDetailsProtocol";

interface ActionDef {
  id: CommitDetailsActionId;
  label: string;
  icon: string;
  /** Destructive actions get a danger tint. */
  danger?: boolean;
}

const COMMIT_ACTIONS: ActionDef[] = [
  { id: "checkout", label: "Checkout", icon: "check" },
  { id: "branch", label: "Branch", icon: "git-branch" },
  { id: "tag", label: "Tag", icon: "tag" },
  { id: "cherry-pick", label: "Cherry-pick", icon: "git-commit" },
  { id: "revert", label: "Revert", icon: "discard" },
  { id: "reset", label: "Reset", icon: "history", danger: true },
];

const WIP_ACTIONS: ActionDef[] = [
  { id: "commit", label: "Commit…", icon: "git-commit" },
  { id: "stage-all", label: "Stage all", icon: "add" },
  { id: "unstage-all", label: "Unstage all", icon: "dash" },
  { id: "stash", label: "Stash", icon: "archive" },
  { id: "discard-all", label: "Discard all", icon: "discard", danger: true },
];

export class CommitDetails extends LitElement {
  static properties = {
    details: { attribute: false },
  };

  declare details: CommitDetailsPayload | null;

  constructor() {
    super();
    this.details = null;
  }

  connectedCallback(): void {
    super.connectedCallback();
    try {
      const raw = Number(localStorage.getItem(CommitDetails.LS_LEFT));
      if (Number.isFinite(raw) && raw > 0) this.setLeftW(raw);
    } catch {
      /* storage unavailable — keep the default width */
    }
  }

  static styles = [
    codiconStyles,
    css`
      :host {
        --gs-fg: var(--vscode-foreground);
        --gs-fg-muted: var(--vscode-descriptionForeground);
        --gs-fg-subtle: color-mix(in srgb, var(--gs-fg) 50%, transparent);
        --gs-accent: var(--vscode-focusBorder);
        --gs-accent-text: var(--vscode-textLink-foreground, var(--vscode-focusBorder));
        --gs-bg: var(--vscode-sideBar-background, var(--vscode-editor-background));
        --gs-surface: color-mix(in srgb, var(--gs-fg) 4%, var(--gs-bg));
        --gs-hover: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--gs-fg) 7%, transparent));
        --gs-border: color-mix(in srgb, var(--gs-fg) 13%, transparent);
        --gs-border-soft: color-mix(in srgb, var(--gs-fg) 8%, transparent);
        --gs-added: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-charts-green, #89d185));
        --gs-modified: var(--vscode-gitDecoration-modifiedResourceForeground, var(--vscode-charts-yellow, #e2c08d));
        --gs-deleted: var(--vscode-gitDecoration-deletedResourceForeground, var(--vscode-charts-red, #f14c4c));
        --gs-renamed: var(--vscode-gitDecoration-renamedResourceForeground, var(--vscode-charts-blue, #6fb3d2));
        display: block;
        height: 100%;
        overflow: hidden;
        color: var(--gs-fg);
        font-family: var(--vscode-font-family);
        font-size: 13px;
        background: var(--gs-bg);
      }
      /* border-box so height:100% + padding fits the host (shadow DOM doesn't
         inherit the document's global box-sizing) — otherwise the padding pushes
         the scroller past :host{overflow:hidden} and the bottom can't be reached. */
      .scroll {
        box-sizing: border-box;
        height: 100%;
        overflow-y: auto;
        padding: 12px 14px 18px;
        container-type: inline-size;
      }

      /* ── Git Graph-style split when the panel is WIDE (the desktop bottom
         dock): commit identity + message on the left, the changed files beside
         them on the right, each scrolling independently. Narrow hosts (the
         extension sidebar) keep the stacked flow. ─────────────────────────── */
      /* The identity|files divider only exists in the wide layout. */
      .col-split { display: none; }

      @container (min-width: 720px) {
        .scroll { overflow: hidden; padding-bottom: 0; }
        .layout {
          display: grid;
          grid-template-columns:
            clamp(280px, var(--gs-details-left, 380px), 560px)
            10px
            minmax(0, 1fr);
          height: 100%;
          min-height: 0;
        }
        .col-main,
        .col-files {
          box-sizing: border-box;
          min-height: 0;
          height: 100%;
          overflow-y: auto;
          padding-bottom: 14px;
        }
        /* Short dock: actions must stay reachable — they sit ABOVE the message
           card here, so the card (which can be long) is what scrolls away. */
        .col-main { display: flex; flex-direction: column; align-items: flex-start; padding-right: 6px; }
        .col-main > * { width: 100%; }
        .col-main .message { order: 10; }
        /* Drag divider between the columns: a centered hairline that brightens
           on hover/drag, keyboard-operable (role=separator). */
        .col-split {
          display: block;
          cursor: col-resize;
          background: linear-gradient(to right,
            transparent 4px,
            var(--gs-border-soft) 4px,
            var(--gs-border-soft) 5px,
            transparent 5px);
          transition: background 120ms ease;
          touch-action: none;
        }
        .col-split:hover,
        .col-split.dragging {
          background: linear-gradient(to right,
            transparent 4px,
            var(--gs-accent) 4px,
            var(--gs-accent) 5px,
            transparent 5px);
        }
        .col-split:focus-visible {
          outline: 1px solid var(--gs-accent);
          outline-offset: -1px;
          border-radius: 2px;
        }
        .col-files { padding-left: 12px; }
        .col-files .files-head { margin-top: 0; padding-top: 2px; border-top: none; }
      }

      .empty {
        height: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 8px;
        color: var(--gs-fg-subtle);
        text-align: center;
        padding: 24px;
      }
      .empty .codicon { font-size: 26px; opacity: 0.6; }
      .empty .et { font-size: 12.5px; }

      /* ── Header ─────────────────────────────────────────────────── */
      .head { display: flex; align-items: flex-start; gap: 10px; }
      .avatar {
        width: 36px; height: 36px; border-radius: 50%;
        position: relative; overflow: hidden; flex: 0 0 auto;
        box-shadow: 0 0 0 1px color-mix(in srgb, var(--gs-fg) 14%, transparent);
      }
      /* Positioned so the loaded photo paints ABOVE the absolute fallback
         (positioned siblings always paint over static ones). */
      .avatar img { position: relative; width: 100%; height: 100%; object-fit: cover; display: block; }
      .avatar .fallback {
        position: absolute; inset: 0; display: flex; align-items: center;
        justify-content: center; font-size: 14px; font-weight: 600; color: #fff;
        background: hsl(var(--av-hue, 210) 48% 42%);
      }
      .id { min-width: 0; flex: 1 1 auto; }
      .author { font-weight: 600; font-size: 13.5px; }
      .when { color: var(--gs-fg-muted); font-weight: 400; font-size: 12px; }
      .sub-when { color: var(--gs-fg-subtle); font-size: 11px; margin-top: 1px; }
      .sha-row {
        display: inline-flex; align-items: center; gap: 6px; margin-top: 5px;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 11.5px; color: var(--gs-fg-muted);
        padding: 1px 7px 1px 6px; border-radius: 999px;
        border: 1px solid var(--gs-border); cursor: pointer;
        transition: background 120ms, color 120ms;
      }
      .sha-row:hover { background: var(--gs-hover); color: var(--gs-fg); }
      .sha-row .codicon { font-size: 12px; }
      .email {
        display: block; font-weight: 400; font-size: 11.5px;
        color: var(--gs-fg-subtle); margin-top: 1px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      /* Parents — labeled clickable short-sha chips, Git Graph's "Parents:" row. */
      .parents {
        display: flex; align-items: center; flex-wrap: wrap; gap: 5px; margin-top: 6px;
      }
      .parents .plabel {
        font-size: 10.5px; font-weight: 600; letter-spacing: 0.04em;
        text-transform: uppercase; color: var(--gs-fg-subtle);
      }
      .parent {
        display: inline-flex; align-items: center; gap: 4px;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 11px; color: var(--gs-fg-muted);
        padding: 0 6px; height: 18px; border-radius: 999px;
        border: 1px solid var(--gs-border); background: transparent;
        cursor: pointer; transition: background 120ms, color 120ms;
      }
      .parent:hover { background: var(--gs-hover); color: var(--gs-accent-text); }
      .parent .codicon { font-size: 11px; opacity: 0.7; }
      .head-tools { display: flex; gap: 2px; flex: 0 0 auto; }
      .icon-btn {
        width: 26px; height: 26px; display: inline-flex; align-items: center;
        justify-content: center; border: none; border-radius: 6px;
        background: transparent; color: var(--gs-fg-muted); cursor: pointer;
        transition: background 120ms, color 120ms;
      }
      .icon-btn:hover { background: var(--gs-hover); color: var(--gs-fg); }
      .icon-btn .codicon { font-size: 15px; }

      /* ── Ref chips ──────────────────────────────────────────────── */
      .refs { display: flex; flex-wrap: wrap; gap: 5px; margin: 9px 0 0; }
      .chip {
        display: inline-flex; align-items: center; gap: 4px; height: 18px;
        padding: 0 7px; border-radius: 999px; font-size: 11px; font-weight: 500;
        border: 1px solid transparent; white-space: nowrap;
      }
      .chip .codicon { font-size: 11px; }
      .chip-current {
        color: var(--vscode-button-foreground);
        background: var(--vscode-button-background, var(--gs-accent));
        font-weight: 600;
      }
      .chip-head {
        color: var(--gs-accent-text);
        background: color-mix(in srgb, var(--gs-accent) 14%, transparent);
        border-color: color-mix(in srgb, var(--gs-accent) 32%, transparent);
      }
      .chip-remote {
        color: var(--gs-fg-muted);
        background: color-mix(in srgb, currentColor 10%, transparent);
        border-color: color-mix(in srgb, currentColor 24%, transparent);
      }
      .chip-tag {
        color: var(--vscode-charts-yellow, #e2c08d);
        background: color-mix(in srgb, var(--vscode-charts-yellow, #e2c08d) 14%, transparent);
        border-color: color-mix(in srgb, var(--vscode-charts-yellow, #e2c08d) 32%, transparent);
      }

      /* ── Message ────────────────────────────────────────────────── */
      .message {
        margin: 12px 0 0; padding: 10px 12px; border-radius: 7px;
        background: var(--gs-surface); border: 1px solid var(--gs-border-soft);
      }
      .subject { font-weight: 600; font-size: 13.5px; line-height: 1.35; }
      .body {
        margin-top: 7px; white-space: pre-wrap; word-break: break-word;
        color: var(--gs-fg-muted); font-size: 12.5px; line-height: 1.5;
      }

      /* ── Action toolbar ─────────────────────────────────────────── */
      .actions { display: flex; flex-wrap: wrap; gap: 5px; margin: 12px 0 2px; }
      .act {
        display: inline-flex; align-items: center; gap: 5px; height: 26px;
        padding: 0 9px; border-radius: 6px; border: 1px solid var(--gs-border);
        background: var(--gs-surface); color: var(--gs-fg); cursor: pointer;
        font-size: 12px; font-family: inherit;
        transition: background 120ms, border-color 120ms;
      }
      .act:hover { background: var(--gs-hover); border-color: var(--gs-fg-subtle); }
      .act .codicon { font-size: 13px; color: var(--gs-fg-muted); }
      .act.danger:hover {
        color: var(--gs-deleted);
        border-color: color-mix(in srgb, var(--gs-deleted) 40%, transparent);
        background: color-mix(in srgb, var(--gs-deleted) 10%, transparent);
      }
      .act.danger:hover .codicon { color: var(--gs-deleted); }

      /* ── Files ──────────────────────────────────────────────────── */
      .files-head {
        display: flex; align-items: center; gap: 8px;
        margin: 16px 0 6px; padding-top: 10px;
        border-top: 1px solid var(--gs-border-soft);
      }
      .files-title {
        font-size: 11px; font-weight: 600; letter-spacing: 0.05em;
        text-transform: uppercase; color: var(--gs-fg-muted);
      }
      .files-count {
        min-width: 18px; height: 16px; padding: 0 6px; border-radius: 999px;
        display: inline-flex; align-items: center; justify-content: center;
        font-size: 10.5px; font-weight: 600; font-variant-numeric: tabular-nums;
        background: color-mix(in srgb, var(--gs-fg) 11%, transparent);
        color: var(--gs-fg-muted);
      }
      .files-stat {
        margin-left: auto; display: inline-flex; align-items: center; gap: 7px;
        font-variant-numeric: tabular-nums; font-size: 11.5px;
        font-family: var(--vscode-editor-font-family, monospace);
      }
      .files-stat .add { color: var(--gs-added); }
      .files-stat .del { color: var(--gs-deleted); }
      .group-label {
        font-size: 10.5px; font-weight: 600; letter-spacing: 0.04em;
        text-transform: uppercase; color: var(--gs-fg-subtle);
        margin: 10px 0 3px;
      }

      .file {
        display: flex; align-items: center; gap: 8px; height: 26px;
        padding: 0 6px; border-radius: 5px; cursor: pointer; user-select: none;
      }
      .file:hover { background: var(--gs-hover); }
      .fstatus {
        width: 16px; height: 16px; flex: 0 0 auto; border-radius: 4px;
        display: inline-flex; align-items: center; justify-content: center;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 10px; font-weight: 700;
        color: var(--st, var(--gs-fg-muted));
        background: color-mix(in srgb, var(--st, var(--gs-fg-muted)) 15%, transparent);
      }
      .fname { flex: 0 1 auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .file.deleted .fname { text-decoration: line-through; opacity: 0.8; }
      .fdir {
        flex: 1 1 auto; min-width: 0; font-size: 11.5px; color: var(--gs-fg-subtle);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        direction: rtl; text-align: left;
      }
      .fnums {
        flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 10.5px; font-variant-numeric: tabular-nums;
      }
      .fnums .add { color: var(--gs-added); }
      .fnums .del { color: var(--gs-deleted); }
      .fnums .bin { color: var(--gs-fg-subtle); }
      /* Slim proportional add/del meter — same language as the graph's
         CHANGES column, length scaled to the size of the file's change. */
      .bar {
        display: inline-flex; height: 4px; border-radius: 2px; overflow: hidden;
        background: color-mix(in srgb, var(--gs-fg) 16%, transparent);
      }
      .bar i { height: 100%; }
      .bar i.a { background: var(--gs-added); }
      .bar i.d { background: var(--gs-deleted); }
    `,
  ];

  private emit(name: string, detail: unknown): void {
    this.dispatchEvent(
      new CustomEvent(name, { detail, bubbles: true, composed: true }),
    );
  }

  render() {
    const d = this.details;
    if (!d) {
      return html`<div class="empty">
        <span class="codicon codicon-git-commit"></span>
        <span class="et">Select a commit to see its details</span>
      </div>`;
    }
    const isWip = d.kind === "wip";
    return html`<div class="scroll">
      <div class="layout">
        <div class="col-main">
          ${isWip ? this.wipHeader() : this.commitHeader(d)}
          ${!isWip && d.refs.length ? this.refsHtml(d.refs) : nothing}
          ${!isWip ? this.messageHtml(d) : nothing}
          ${this.actionsHtml(isWip ? WIP_ACTIONS : COMMIT_ACTIONS, d)}
        </div>
        <div
          class="col-split"
          aria-label="Resize the details column"
          aria-valuemin="280"
          aria-valuemax="560"
          aria-valuenow=${this.leftW ?? 380}
          role="separator"
          aria-orientation="vertical"
          tabindex="0"
          title="Drag to resize · double-click to reset"
          @pointerdown=${this.onColSplitPointerDown}
          @keydown=${this.onColSplitKey}
          @dblclick=${this.resetColSplit}
        ></div>
        <div class="col-files">${this.filesHtml(d)}</div>
      </div>
    </div>`;
  }

  // ── Identity|files column divider (wide layout) ─────────────────────────────

  /** Persisted left-column width (px), or undefined for the 380px default. */
  private leftW: number | undefined;
  private static readonly LS_LEFT = "gitstudio.details.leftw";

  private applyLeftW(): void {
    if (this.leftW !== undefined) {
      this.style.setProperty("--gs-details-left", `${this.leftW}px`);
    } else {
      this.style.removeProperty("--gs-details-left");
    }
  }

  private setLeftW(px: number): void {
    this.leftW = Math.round(Math.min(560, Math.max(280, px)));
    this.applyLeftW();
  }

  private persistLeftW(): void {
    try {
      if (this.leftW === undefined) localStorage.removeItem(CommitDetails.LS_LEFT);
      else localStorage.setItem(CommitDetails.LS_LEFT, String(this.leftW));
    } catch {
      /* storage unavailable — non-fatal */
    }
  }

  private onColSplitPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    const startX = e.clientX;
    const startW = this.leftW ?? 380;
    handle.classList.add("dragging");
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    const move = (ev: PointerEvent): void => this.setLeftW(startW + (ev.clientX - startX));
    const up = (): void => {
      handle.classList.remove("dragging");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      handle.setAttribute("aria-valuenow", String(this.leftW ?? 380));
      this.persistLeftW();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  private onColSplitKey = (e: KeyboardEvent): void => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const step = (e.shiftKey ? 24 : 8) * (e.key === "ArrowRight" ? 1 : -1);
      this.setLeftW((this.leftW ?? 380) + step);
      (e.currentTarget as HTMLElement).setAttribute(
        "aria-valuenow",
        String(this.leftW ?? 380),
      );
      this.persistLeftW();
    } else if (e.key === "Home") {
      e.preventDefault();
      this.resetColSplit();
    }
  };

  private resetColSplit = (): void => {
    this.leftW = undefined;
    this.applyLeftW();
    this.persistLeftW();
  };

  private commitHeader(d: CommitDetailsPayload) {
    const hue = avatarHue(d.authorEmail);
    const initials = authorInitials(d.author, d.authorEmail);
    const url = gravatarUrl(d.authorEmail, 72);
    const sameCommitter =
      d.committer === d.author && d.committerEmail === d.authorEmail;
    return html`<div class="head">
      <span class="avatar" style="--av-hue:${hue}">
        <span class="fallback">${initials}</span>
        <img src=${url} alt="" loading="lazy" decoding="async"
          @error=${(e: Event) => ((e.target as HTMLElement).style.display = "none")} />
      </span>
      <div class="id">
        <div class="author">${d.author}
          <span class="when" title=${absTime(d.committerDate)}>committed ${relTime(d.committerDate)}</span>
        </div>
        <span class="email" title=${d.authorEmail}>${d.authorEmail}</span>
        ${sameCommitter
          ? nothing
          : html`<div class="sub-when">committed by ${d.committer}; authored ${relTime(d.authorDate)}</div>`}
        <span class="sha-row" title="Copy full SHA"
          @click=${() => this.emit("gs-copy", { text: d.sha })}>
          <span class="codicon codicon-git-commit"></span>${d.shortSha}
          <span class="codicon codicon-copy"></span>
        </span>
        ${d.parents.length
          ? html`<div class="parents">
              <span class="plabel">${d.parents.length === 1 ? "Parent" : "Parents"}</span>
              ${d.parents.map(
                (p) => html`<button class="parent" title=${`Reveal ${p} in the graph`}
                  @click=${() => this.emit("gs-reveal", { sha: p })}>
                  <span class="codicon codicon-git-commit"></span>${p.slice(0, 7)}</button>`,
              )}
            </div>`
          : nothing}
      </div>
      <div class="head-tools">
        ${d.hasRemote
          ? html`<button class="icon-btn" title="Open on remote"
              @click=${() => this.emit("gs-action", { id: "open-remote", sha: d.sha })}>
              <span class="codicon codicon-link-external"></span></button>`
          : nothing}
      </div>
    </div>`;
  }

  private wipHeader() {
    return html`<div class="head">
      <span class="avatar" style="--av-hue:35">
        <span class="fallback"><span class="codicon codicon-edit"></span></span>
      </span>
      <div class="id">
        <div class="author">Uncommitted changes
          <span class="when">in your working tree</span>
        </div>
        <div class="sub-when">Stage, commit, stash, or discard below</div>
      </div>
    </div>`;
  }

  private refsHtml(refs: WireRef[]) {
    return html`<div class="refs">
      ${refs.map((r) => {
        const cls =
          r.kind === "currentHead" ? "chip-current"
          : r.kind === "tag" ? "chip-tag"
          : r.kind === "remoteHead" ? "chip-remote"
          : "chip-head";
        const icon =
          r.kind === "tag" ? "tag" : r.kind === "remoteHead" ? "cloud" : "git-branch";
        return html`<span class="chip ${cls}">
          <span class="codicon codicon-${icon}"></span>${r.name}</span>`;
      })}
    </div>`;
  }

  private messageHtml(d: CommitDetailsPayload) {
    const body = d.body.trim();
    return html`<div class="message">
      <div class="subject">${d.subject}</div>
      ${body ? html`<div class="body">${body}</div>` : nothing}
    </div>`;
  }

  private actionsHtml(actions: ActionDef[], d: CommitDetailsPayload) {
    return html`<div class="actions">
      ${actions.map(
        (a) => html`<button class="act ${a.danger ? "danger" : ""}"
          title=${a.label}
          @click=${() => this.emit("gs-action", { id: a.id, sha: d.sha })}>
          <span class="codicon codicon-${a.icon}"></span>${a.label}</button>`,
      )}
    </div>`;
  }

  private filesHtml(d: CommitDetailsPayload) {
    const files = d.files;
    let add = 0, del = 0;
    for (const f of files) {
      if (f.additions > 0) add += f.additions;
      if (f.deletions > 0) del += f.deletions;
    }
    const header = html`<div class="files-head">
      <span class="files-title">${d.kind === "wip" ? "Changes" : "Files changed"}</span>
      <span class="files-count">${files.length}</span>
      ${add || del
        ? html`<span class="files-stat"><span class="add">+${add}</span><span class="del">−${del}</span></span>`
        : nothing}
    </div>`;

    if (files.length === 0) {
      return html`${header}<div class="group-label" style="text-transform:none;letter-spacing:0">No file changes.</div>`;
    }

    // WIP splits into staged / unstaged groups.
    if (d.kind === "wip" && d.stagedCount !== undefined) {
      const staged = files.slice(0, d.stagedCount);
      const unstaged = files.slice(d.stagedCount);
      return html`${header}
        ${staged.length ? html`<div class="group-label">Staged</div>${staged.map((f) => this.fileRow(f, true))}` : nothing}
        ${unstaged.length ? html`<div class="group-label">Unstaged</div>${unstaged.map((f) => this.fileRow(f, true))}` : nothing}`;
    }
    return html`${header}${files.map((f) => this.fileRow(f, false))}`;
  }

  private fileRow(f: CommitFileChange, wip: boolean) {
    const st = statusColor(f.status);
    const slash = f.path.lastIndexOf("/");
    const name = slash === -1 ? f.path : f.path.slice(slash + 1);
    const dir = slash === -1 ? "" : f.path.slice(0, slash);
    const binary = f.additions < 0 || f.deletions < 0;
    return html`<div
      class="file ${f.status === "D" ? "deleted" : ""}"
      style="--st:${st}"
      title=${f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
      @click=${() => this.emit("gs-file-open", { path: f.path, status: f.status, wip })}>
      <span class="fstatus">${f.status}</span>
      <span class="fname">${name}</span>
      ${dir ? html`<span class="fdir" dir="ltr">${dir}</span>` : html`<span class="fdir"></span>`}
      <span class="fnums">
        ${binary
          ? html`<span class="bin">bin</span>`
          : html`<span class="bar">${statBar(f.additions, f.deletions)}</span>
              ${f.additions ? html`<span class="add">+${f.additions}</span>` : nothing}
              ${f.deletions ? html`<span class="del">−${f.deletions}</span>` : nothing}`}
      </span>
    </div>`;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function statusColor(status: string): string {
  switch (status) {
    case "A": return "var(--gs-added)";
    case "D": return "var(--gs-deleted)";
    case "R":
    case "C": return "var(--gs-renamed)";
    default: return "var(--gs-modified)";
  }
}

/** Proportional add/del meter: length log-scales with the change size, the
 *  green/red split is the true ratio (floored so a tiny side stays visible) —
 *  the same visual language as the graph's CHANGES column. */
function statBar(add: number, del: number) {
  const total = add + del;
  if (total === 0) {
    return html`<i style="width:14px"></i>`;
  }
  const barW = Math.round(Math.min(40, 12 + 9 * Math.log10(1 + total)));
  let a = Math.round((add / total) * 100);
  if (add > 0 && del > 0) a = Math.min(90, Math.max(10, a));
  return html`${add > 0
    ? html`<i class="a" style="width:${(a / 100) * barW}px"></i>`
    : nothing}${del > 0
    ? html`<i class="d" style="width:${((100 - a) / 100) * barW}px"></i>`
    : nothing}`;
}

const MIN = 60, HOUR = 3600, DAY = 86400, MONTH = 2592000, YEAR = 31536000;
function relTime(epoch: number, now = Date.now() / 1000): string {
  const d = Math.max(0, Math.floor(now - epoch));
  if (d < MIN) return "just now";
  if (d < HOUR) return `${Math.floor(d / MIN)}m ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)}h ago`;
  if (d < MONTH) return `${Math.floor(d / DAY)}d ago`;
  if (d < YEAR) return `${Math.floor(d / MONTH)}mo ago`;
  return `${Math.floor(d / YEAR)}y ago`;
}
function absTime(epoch: number): string {
  try { return new Date(epoch * 1000).toLocaleString(); } catch { return ""; }
}

if (!customElements.get("gitstudio-commit-details")) {
  customElements.define("gitstudio-commit-details", CommitDetails);
}

declare global {
  interface HTMLElementTagNameMap {
    "gitstudio-commit-details": CommitDetails;
  }
}
