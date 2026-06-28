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
      .scroll { box-sizing: border-box; height: 100%; overflow-y: auto; padding: 12px 14px 18px; }

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
      .avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
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
      /* tiny add/del proportion bar */
      .bar { display: inline-flex; gap: 1px; }
      .bar i { width: 5px; height: 5px; border-radius: 1px; background: color-mix(in srgb, var(--gs-fg) 18%, transparent); }
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
      ${isWip ? this.wipHeader() : this.commitHeader(d)}
      ${!isWip && d.refs.length ? this.refsHtml(d.refs) : nothing}
      ${!isWip ? this.messageHtml(d) : nothing}
      ${this.actionsHtml(isWip ? WIP_ACTIONS : COMMIT_ACTIONS, d)}
      ${this.filesHtml(d)}
    </div>`;
  }

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
        ${sameCommitter
          ? nothing
          : html`<div class="sub-when">authored by ${d.author} ${relTime(d.authorDate)}</div>`}
        <span class="sha-row" title="Copy full SHA"
          @click=${() => this.emit("gs-copy", { text: d.sha })}>
          <span class="codicon codicon-git-commit"></span>${d.shortSha}
          <span class="codicon codicon-copy"></span>
        </span>
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

/** A 5-cell bar proportioned green(adds)/red(dels) by ratio (GitHub-style). */
function statBar(add: number, del: number) {
  const total = add + del;
  const cells = 5;
  const out = [];
  if (total === 0) {
    for (let i = 0; i < cells; i++) out.push(html`<i></i>`);
    return out;
  }
  let greens = Math.round((add / total) * cells);
  if (add > 0 && greens === 0) greens = 1;
  if (del > 0 && greens === cells) greens = cells - 1;
  for (let i = 0; i < cells; i++) {
    out.push(html`<i class=${i < greens ? "a" : "d"}></i>`);
  }
  return out;
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
