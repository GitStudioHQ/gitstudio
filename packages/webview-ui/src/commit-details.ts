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
import { hostTokens } from "./styles/hostTokens";
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
  /** The one emphasized action in a toolbar (filled accent); at most one. */
  primary?: boolean;
}

/** How long the "copied" acknowledgement stays up. Long enough to notice,
 *  short enough that the sha is back before you need it again. */
const COPIED_MS = 1300;

/** Show containing-branch names outright up to this many; beyond it, collapse
 *  behind the count so the pane does not turn into a list of chips. */
const CONTAINS_AUTO_EXPAND = 8;

/** Settle time before asking the host "which branches contain this commit?".
 *  Long enough that arrowing through the graph asks only once, at the end. */
const CONTAINS_DEBOUNCE_MS = 350;

const COMMIT_ACTIONS: ActionDef[] = [
  { id: "checkout", label: "Checkout", icon: "check", primary: true },
  { id: "branch", label: "Branch", icon: "git-branch" },
  { id: "tag", label: "Tag", icon: "tag" },
  { id: "cherry-pick", label: "Cherry-pick", icon: "git-commit" },
  { id: "revert", label: "Revert", icon: "discard" },
  { id: "interactive-rebase", label: "Rebase", icon: "git-merge" },
  { id: "reset", label: "Reset", icon: "history", danger: true },
];

const WIP_ACTIONS: ActionDef[] = [
  { id: "commit", label: "Commit…", icon: "git-commit", primary: true },
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

  /** Containment ("in N branches") is per-commit and lazily fetched. */
  private containsState: "idle" | "loading" | "done" = "idle";
  private containsList: string[] = [];
  private containsTruncated = false;
  private containsOpen = false;
  /** Sha the cached containment belongs to — guards a late reply landing on a
   * different commit after the user moved on. */
  private containsSha: string | undefined;
  /** Short-lived "copied" acknowledgement, keyed by what was copied. */
  private copiedKey: string | undefined;
  private copiedTimer: ReturnType<typeof setTimeout> | undefined;
  /** Pending containment request, so fast navigation coalesces into one. */
  private containsTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    super();
    this.details = null;
  }

  /** Selecting a different commit invalidates the containment answer. */
  willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("details") && this.details?.sha !== this.containsSha) {
      this.containsState = "idle";
      this.containsList = [];
      this.containsTruncated = false;
      this.containsOpen = false;
      this.containsSha = undefined;
      // A "copied" acknowledgement belongs to the commit it was clicked on.
      if (this.copiedTimer !== undefined) {
        clearTimeout(this.copiedTimer);
        this.copiedTimer = undefined;
      }
      this.copiedKey = undefined;
    }
  }

  /** Host reply to `requestContains`. Ignored when it is for another commit. */
  setContains(sha: string, branches: string[], truncated: boolean): void {
    if (!this.details || this.details.sha !== sha) {
      return;
    }
    this.containsSha = sha;
    this.containsList = branches;
    this.containsTruncated = truncated;
    this.containsState = "done";
    // Show the names outright when there are few enough to scan; past that the
    // count is the useful part and a wall of chips is just noise.
    this.containsOpen = branches.length <= CONTAINS_AUTO_EXPAND;
    this.requestUpdate();
  }

  /**
   * Containment loads on its own. It used to require clicking "which
   * branches?" first — a click that asked a question the pane should simply
   * answer. It is still a real history walk, so it stays async and off the
   * render path: the row appears when the answer does, and nothing waits on it.
   */
  updated(): void {
    const d = this.details;
    if (
      d &&
      d.kind !== "wip" &&
      this.containsState === "idle" &&
      this.containsSha !== d.sha
    ) {
      // DEBOUNCED. This is a history walk (git branch --all --contains), and
      // arrowing through the graph re-renders this pane per row — firing it
      // immediately spawned one git process per commit passed over, which on a
      // repo with many refs saturates the process pool and stalls the UI.
      // Only the commit you actually settle on gets queried.
      if (this.containsTimer !== undefined) {
        clearTimeout(this.containsTimer);
      }
      const sha = d.sha;
      this.containsTimer = setTimeout(() => {
        this.containsTimer = undefined;
        // Still on the same commit, and still nothing fetched for it?
        if (this.details?.sha === sha && this.containsState === "idle") {
          this.requestContains();
        }
      }, CONTAINS_DEBOUNCE_MS);
    }
  }

  private requestContains = (): void => {
    const sha = this.details?.sha;
    if (!sha) return;
    this.containsState = "loading";
    this.requestUpdate();
    this.emit("gs-contains", { sha });
  };

  private toggleContains = (): void => {
    this.containsOpen = !this.containsOpen;
    this.requestUpdate();
  };

  /**
   * Copy, and SAY SO. A copy with no acknowledgement leaves you re-clicking to
   * find out whether it worked. Flashes for ~1.3s, keyed so two copyable
   * identifiers on the same line acknowledge independently.
   */
  private copyWithFeedback(text: string, key: string): void {
    this.emit("gs-copy", { text });
    this.copiedKey = key;
    if (this.copiedTimer !== undefined) clearTimeout(this.copiedTimer);
    this.copiedTimer = setTimeout(() => {
      this.copiedKey = undefined;
      this.copiedTimer = undefined;
      this.requestUpdate();
    }, COPIED_MS);
    this.requestUpdate();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.copiedTimer !== undefined) {
      clearTimeout(this.copiedTimer);
      this.copiedTimer = undefined;
    }
    if (this.containsTimer !== undefined) {
      clearTimeout(this.containsTimer);
      this.containsTimer = undefined;
    }
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
    hostTokens,
    codiconStyles,
    css`
      :host {
        /* The --gs-* scale is inherited from the document (graph.css @imports
           tokens.css). Only this panel's short status aliases are declared here,
           sourced from the shared scale — one source of truth, no drift. */
        /* Everything in this pane sizes off the HOST's font size, so it grows
           when the editor's font size / zoom does. Hardcoded px meant the block
           stayed the same size no matter how the app was scaled — small and
           tidy, but not readable if you need it bigger. */
        --gs-fs: var(--vscode-font-size, 13px);
        --gs-added: var(--gs-status-added);
        --gs-modified: var(--gs-status-modified);
        --gs-deleted: var(--gs-status-deleted);
        --gs-renamed: var(--gs-status-renamed);
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
        /* Message reads in natural order — directly under identity/refs, since
           it's what you opened the panel for. The action row instead docks to
           the bottom as a sticky footer, so it stays reachable even when a long
           message scrolls behind it (the old fix put actions ABOVE the message,
           which buried the thing you came to read). */
        .col-main { display: flex; flex-direction: column; align-items: flex-start; padding-right: 6px; }
        .col-main > * { width: 100%; }
        .col-main .actions {
          position: sticky;
          bottom: 0;
          margin: auto 0 0;
          padding: 10px 0 2px;
          background: var(--gs-bg);
          box-shadow: 0 -1px 0 var(--gs-border-soft), 0 -10px 12px -10px var(--gs-bg);
        }
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

      /* ── Compact mode (bottom panel) ─────────────────────────────
         A short pane: shrink the decorative chrome (avatar, button height,
         section gaps) so the message, refs and file list — the things you
         actually came to read — stay above the fold. */
      :host([compact]) .avatar { width: 26px; height: 26px; }
      :host([compact]) .actions { gap: 4px; margin: 8px 0 2px; }
      :host([compact]) .act { height: 22px; padding: 0 7px; font-size: 11px; gap: 4px; }
      :host([compact]) .act .codicon { font-size: 12px; }
      :host([compact]) .act .codicon { font-size: 12px; }
      :host([compact]) .refs { margin-top: 7px; }
      :host([compact]) .head { gap: 8px; }

      /* ── Header ─────────────────────────────────────────────────── */
      .head { display: flex; align-items: center; gap: 10px; }
      .avatar {
        width: 36px; height: 36px; border-radius: 50%;
        position: relative; overflow: hidden; flex: 0 0 auto;
        box-shadow: 0 0 0 1px color-mix(in srgb, var(--gs-fg) 14%, transparent);
      }
      /* Positioned so the loaded photo paints ABOVE the absolute fallback
         (positioned siblings always paint over static ones). The photo starts
         hidden and is revealed only once it confirms a load (.is-loaded), so a
         404 / blocked host / offline fetch can never obscure the initials disc. */
      .avatar img { position: relative; width: 100%; height: 100%; object-fit: cover; display: block; opacity: 0; }
      .avatar img.is-loaded { opacity: 1; }
      .avatar .fallback {
        position: absolute; inset: 0; display: flex; align-items: center;
        justify-content: center; font-size: 14px; font-weight: 600;
        color: var(--vscode-foreground);
        /* Soft, near-neutral disc — matches the graph's calmed avatar (a whisper
           of the author's hue, not a saturated color). */
        background: color-mix(in srgb, hsl(var(--av-hue, 210) 45% 50%) 30%, var(--gs-bg, var(--vscode-editor-background, #24262c)));
      }
      .id { min-width: 0; flex: 1 1 auto; }
      /* Identity is supporting text; the subject below is the headline. */
      .author { font-weight: 600; font-size: 12.5px; }
      .when { color: var(--gs-fg-muted); font-weight: 400; font-size: 11.5px; }
      .sub-when { color: var(--gs-fg-subtle); font-size: 11px; margin-top: 1px; }
      /* One compact metadata line: the sha chip + parent chip(s) together. */
      .meta-row {
        display: flex; align-items: center; flex-wrap: wrap; gap: 6px;
        margin-top: 8px; font-size: 11px;
      }
      /* Metadata, not chrome: no border/pill until you hover it. */
      /* This is a <button> for keyboard/AT reasons, so the UA chrome has to go
         explicitly — without the reset it paints as a default OS button. */
      .sha-row {
        appearance: none; background: transparent;
        font-family: var(--vscode-editor-font-family, monospace);
        display: inline-flex; align-items: center; gap: 5px;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: calc(var(--gs-fs) * 0.9); color: var(--gs-fg-muted);
        padding: 1px 5px; border-radius: 5px;
        border: 1px solid transparent; cursor: pointer;
        transition: background 120ms, color 120ms;
      }
      /* "+N" is a footnote on the ref list, not a peer of it — no box, so the
         eye lands on the ref names rather than counting containers. */
      .chip-more {
        color: var(--gs-fg-subtle);
        background: transparent;
        padding: 0 3px;
        cursor: default;
        font-variant-numeric: tabular-nums;
      }
      .sha-row:hover { background: var(--gs-hover); color: var(--gs-fg); }
      .sha-row .codicon { font-size: 12px; }
      /* Parents — labeled clickable short-sha chips. */
      .parents {
        display: inline-flex; align-items: center; flex-wrap: wrap; gap: 5px;
      }
      .mlabel {
        font-size: calc(var(--gs-fs) * 0.85); letter-spacing: 0.02em;
        color: var(--gs-fg-muted); white-space: nowrap;
      }
      /* The copy acknowledgement. Swapping the sha for "copied" (rather than
         flashing a colour) is legible at a glance and survives colour-blindness
         and reduced-motion settings alike. */
      .sha-row.is-copied { color: var(--gs-added, var(--gs-accent-text)); }
      .copied-text { font-family: var(--vscode-font-family); font-size: calc(var(--gs-fs) * 0.88); }
      .parent .pnum {
        font-family: var(--vscode-font-family);
        font-size: 9px; opacity: 0.7; margin-right: 1px;
      }
      .parent .codicon-arrow-right { font-size: 10px; opacity: 0.55; }
      .parent:hover .codicon-arrow-right { opacity: 1; }
      /* The parent sha is metadata, like the commit's own sha directly to its
         left — so it gets the same treatment: no border at rest, a quiet wash
         only on hover to show it is clickable. A permanent box around it made
         it look like a fourth ref chip. */
      .parent {
        box-sizing: border-box;
        display: inline-flex; align-items: center; gap: 4px;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: calc(var(--gs-fs) * 0.9); color: var(--gs-fg-muted);
        padding: 0 5px; height: calc(var(--gs-fs) * 1.5); border-radius: 4px;
        border: 0; background: transparent;
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
      /* Grouped, labelled ref rows. A narrow label column carries the meaning
         so the chips do not have to be decoded; values wrap freely, and NOTHING
         is capped or hidden behind a "+N". */
      .refs { display: flex; flex-direction: column; gap: 3px; margin: 10px 0 0; }
      .rrow { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
      .rlabel {
        flex: 0 0 auto; width: calc(var(--gs-fs) * 4.8); text-align: right;
        font-size: calc(var(--gs-fs) * 0.85); letter-spacing: 0.02em;
        color: var(--gs-fg-muted); white-space: nowrap;
      }
      .rvals {
        flex: 1 1 auto; min-width: 0;
        display: flex; flex-wrap: wrap; align-items: center; gap: 4px;
      }
      /* Absence made visible: no remote ref is a STATE, not a missing chip. */
      .chip-unpushed {
        color: var(--gs-amber);
        background: color-mix(in srgb, var(--gs-amber) 13%, var(--gs-bg));
      }
      .quiet { font-size: calc(var(--gs-fs) * 0.88); color: var(--gs-fg-muted); }
      .linkish {
        border: 0; background: transparent; padding: 0;
        font: inherit; font-size: calc(var(--gs-fs) * 0.88);
        color: var(--gs-accent-text); cursor: pointer;
      }
      .linkish:hover { text-decoration: underline; }
      /* Containment chips are deliberately NOT coloured like the ref chips
         above. "this branch contains the commit" is a different claim from
         "this branch's tip IS the commit", and reusing the accent/grey palette
         made the two rows read as the same kind of thing. */
      .chip-contains {
        color: var(--gs-fg-muted);
        background: transparent;
        box-shadow: inset 0 0 0 1px var(--gs-border-soft);
      }
      .contains-list {
        display: flex; flex-wrap: wrap; gap: 4px;
        flex: 1 1 100%; margin-top: 2px;
      }
      /* Flat and borderless, matching <commit-graph> and <commit-rail>. Was a
         999px capsule with a visible border on top of a tinted fill — three
         encodings of one fact, and the capsule shape made every ref read as a
         separate button. box-sizing is NOT inherited into shadow DOM, so
         without it the 18px height rendered as 20px and the 190px cap as 206px,
         which is how one long branch name came to span half the pane. */
      .chip {
        box-sizing: border-box;
        display: inline-flex; align-items: center; gap: 4px;
        /* Names WRAP rather than truncate. This is the inspect surface — there
           is vertical room here, and a branch called
           "feature/foo-v2" vs "feature/foo-v3" is unidentifiable when the tail
           is the thing replaced by an ellipsis. The dense graph rows still
           truncate (fixed row height); this pane does not have to. */
        min-height: calc(var(--gs-fs) * 1.5);
        padding: calc(var(--gs-fs) * 0.08) calc(var(--gs-fs) * 0.46);
        border-radius: 4px;
        font-size: calc(var(--gs-fs) * 0.88); font-weight: 550;
        border: 0; white-space: normal;
        /* Branch names can be absurdly long; cap so one ref can never span the
           pane (or push it sideways). Full name lives on the chip's title. */
        max-width: 100%; min-width: 0;
      }
      /* Long refs break anywhere rather than overflow — a branch name has no
         spaces to wrap at, so without this it would simply spill. */
      .chip-name { min-width: 0; overflow-wrap: anywhere; word-break: break-word; }
      .chip .codicon {
        font-size: calc(var(--gs-fs) * 0.82); flex: 0 0 auto;
        align-self: flex-start; margin-top: calc(var(--gs-fs) * 0.22);
      }
      /* Single-line chips (the overwhelming majority) keep the glyph centred. */
      .chip { align-items: center; }
      .chip:has(.chip-name) .codicon { align-self: center; margin-top: 0; }
      .chip-current {
        color: var(--gs-brand-fg);
        background: var(--gs-brand);
        font-weight: 650;
      }
      .chip-head {
        color: var(--gs-accent-text);
        background: color-mix(in srgb, var(--gs-accent) 13%, var(--gs-bg));
      }
      /* A remote ref is context, not something you act on — no hue of its own,
         so it stops competing with the branch you are actually on. */
      .chip-remote {
        color: var(--gs-fg-muted);
        background: color-mix(in srgb, var(--gs-fg) 8%, var(--gs-bg));
      }
      .chip-tag {
        color: var(--gs-amber);
        background: color-mix(in srgb, var(--gs-amber) 13%, var(--gs-bg));
      }

      /* ── Message ────────────────────────────────────────────────── */
      /* Plain prose, no boxed card — less chrome, reads like a message. */
      .message { margin: 12px 0 0; }
      /* The one thing that should catch the eye. */
      .subject { font-weight: 650; font-size: 15px; line-height: 1.35; letter-spacing: -0.005em; }
      .body {
        margin-top: 7px; white-space: pre-wrap; word-break: break-word;
        color: var(--gs-fg-muted); font-size: 12.5px; line-height: 1.5;
      }

      /* ── Action toolbar ─────────────────────────────────────────── */
      .actions {
        display: flex; flex-wrap: wrap; gap: 4px;
        margin: 12px 0 2px; padding-top: 10px;
        border-top: 1px solid var(--gs-border-soft);
      }
      .act {
        display: inline-flex; align-items: center; gap: 5px; height: 24px;
        padding: 0 8px; border-radius: 6px; border: 1px solid var(--gs-border);
        /* Secondary actions are ghost (transparent) so the one primary action
           carries the emphasis — a flat wall of equally-filled buttons reads
           busy and hides which one you usually want. */
        background: transparent; color: var(--gs-fg); cursor: pointer;
        font-size: 12px; font-family: inherit;
        transition: filter var(--gs-motion), background var(--gs-motion),
          border-color var(--gs-motion), box-shadow var(--gs-motion),
          transform var(--gs-motion-fast);
      }
      /* Secondaries collapse to quiet glyphs in the TWO-column layout, where the
         identity column is capped (~380-560px) and seven labelled buttons wrap
         into a wall. In the single-column layout there is width to spare, so the
         labels come back — see the container query below. */
      .act:hover { background: var(--gs-hover); border-color: var(--gs-fg-subtle); }
      /* Clear press feedback — the old 1px nudge was invisible in practice. */
      .act:active {
        transform: translateY(1px);
        background: var(--gs-active, var(--gs-hover));
        border-color: var(--gs-accent, var(--gs-fg-subtle));
        filter: brightness(0.94);
      }
      .act:focus-visible {
        outline: 1px solid var(--gs-accent);
        outline-offset: 1px;
      }
      /* While an action is running the button reads as busy, not dead. */
      .act[disabled] { opacity: 0.55; cursor: default; }
      .act .codicon { font-size: 13px; color: var(--gs-fg-muted); }
      /* Primary = the expected default (Checkout / Commit) — filled accent.
         Matches the shared .gs-btn--primary: brighten-on-hover via filter (a
         gradient fill can't be interpolated) + a shadow lift. */
      .act.primary {
        color: var(--gs-brand-fg);
        background: linear-gradient(180deg,
          color-mix(in srgb, var(--gs-brand) 86%, white 14%),
          var(--gs-brand));
        border-color: var(--gs-brand);
        font-weight: 600;
        box-shadow: var(--gs-shadow-1),
          inset 0 1px 0 color-mix(in srgb, white 18%, transparent);
      }
      .act.primary:hover {
        filter: brightness(1.1);
        border-color: var(--gs-brand-hover);
        box-shadow: var(--gs-shadow-2),
          inset 0 1px 0 color-mix(in srgb, white 24%, transparent);
      }
      .act.primary:active { filter: brightness(0.95); }
      .act.primary .codicon { color: var(--gs-brand-fg); }
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
        font-size: 11.5px; font-weight: 600; letter-spacing: 0;
        text-transform: none; color: var(--gs-fg-muted);
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

  /** Close (X) affordance for the docked details panel — the host collapses the
   * dock so the graph reclaims the space. */
  private closeButton() {
    return html`<button class="icon-btn close-details" title="Close details (Esc)"
      aria-label="Close details"
      @click=${() => this.emit("gs-close", {})}>
      <span class="codicon codicon-close"></span></button>`;
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
          ${!isWip ? this.messageHtml(d) : nothing}
          ${!isWip && d.refs.length ? this.refsHtml(d.refs) : nothing}
          ${!isWip ? this.metaHtml(d) : nothing}
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

  /** email -> avatar URL, pushed by the host (same source as the graph rows). */
  private _authorAvatars: Record<string, string> = {};
  set authorAvatars(map: Record<string, string> | undefined) {
    this._authorAvatars = map ?? {};
    this.requestUpdate();
  }
  get authorAvatars(): Record<string, string> {
    return this._authorAvatars;
  }

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
    // Prefer the host-resolved photo (GitHub et al) — the same map the graph
    // rows use — and fall back to Gravatar only when there isn't one.
    const url =
      this._authorAvatars[(d.authorEmail || "").toLowerCase()] ??
      gravatarUrl(d.authorEmail, 72);
    const sameCommitter =
      d.committer === d.author && d.committerEmail === d.authorEmail;
    return html`<div class="head">
      <span class="avatar" style="--av-hue:${hue}">
        <span class="fallback">${initials}</span>
        <img class="av-img" src=${url} alt="" loading="lazy" decoding="async"
          @load=${(e: Event) => (e.target as HTMLElement).classList.add("is-loaded")}
          @error=${(e: Event) => ((e.target as HTMLElement).style.display = "none")} />
      </span>
      <div class="id">
        <div class="author" title=${d.authorEmail}>${d.author}
          <span class="when" title=${absTime(d.committerDate)}>· ${relTime(d.committerDate)}</span>
        </div>
        ${sameCommitter
          ? nothing
          : html`<div class="sub-when">committed by ${d.committer}</div>`}
      </div>
      <div class="head-tools">
        ${d.hasRemote
          ? html`<button class="icon-btn" title="Open on remote"
              @click=${() => this.emit("gs-action", { id: "open-remote", sha: d.sha })}>
              <span class="codicon codicon-link-external"></span></button>`
          : nothing}
        ${this.closeButton()}
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
      <div class="head-tools">${this.closeButton()}</div>
    </div>`;
  }

  /**
   * Refs, grouped by the QUESTION each one answers, with every ref visible.
   *
   * The old design was a single undifferentiated row of pills capped at three
   * with a "+N" — so `main`, `origin/main` and a random local branch looked
   * like peers, and whatever got cut was unknowable without hovering. But they
   * are not peers: one says where you are, one says whether the work is
   * published, one says what it is tagged as. Labelling the groups does the
   * explaining, so nothing has to be decoded from colour alone.
   *
   * "pushed to" matters most: it answers by PRESENCE what the old row could
   * only answer by absence. A commit with no remote ref now says "not pushed"
   * in amber, instead of silently showing one chip fewer.
   */
  private refsHtml(allRefs: WireRef[]) {
    const locals = allRefs.filter(
      (r) => r.kind === "currentHead" || r.kind === "head",
    );
    // A bare remote HEAD pointer ("origin") names no branch — it is noise here,
    // and it was the thing most often hiding inside the old "+1".
    const remotes = allRefs.filter(
      (r) => r.kind === "remoteHead" && r.name.includes("/"),
    );
    const tags = allRefs.filter((r) => r.kind === "tag");

    const chip = (r: WireRef) => {
      const cls =
        r.kind === "currentHead" ? "chip-current"
        : r.kind === "tag" ? "chip-tag"
        : r.kind === "remoteHead" ? "chip-remote"
        : "chip-head";
      const icon =
        r.kind === "tag" ? "tag" : r.kind === "remoteHead" ? "cloud" : "git-branch";
      return html`<span class="chip ${cls}" title=${r.name}>
        <span class="codicon codicon-${icon}"></span
        ><span class="chip-name">${r.name}</span></span>`;
    };

    const row = (label: string, body: unknown) =>
      html`<div class="rrow"><span class="rlabel">${label}</span
        ><span class="rvals">${body}</span></div>`;

    return html`<div class="refs">
      ${locals.length ? row("tip of", locals.map(chip)) : nothing}
      ${remotes.length
        ? row("pushed to", remotes.map(chip))
        : row("", html`<span class="chip chip-unpushed"
            title="This commit exists only in your local repository."
            ><span class="codicon codicon-cloud-upload"></span
            ><span class="chip-name">not pushed</span></span>`)}
      ${tags.length ? row("tagged", tags.map(chip)) : nothing}
      ${this.containsHtml()}
    </div>`;
  }

  /**
   * The "in N branches" row — which branches CONTAIN this commit, as opposed to
   * which refs point AT it. Different question, and the one that answers "where
   * has this already landed?". It costs a history walk, so it is requested only
   * when the user expands it, and the answer is cached per sha.
   */
  private containsHtml() {
    const sha = this.details?.sha;
    if (!sha) {
      return nothing;
    }
    const state = this.containsState;
    if (state === "idle") {
      // Nothing to show yet — the request fires automatically in updated().
      // Rendering a placeholder row here would just flash on every selection.
      return nothing;
    }
    if (state === "loading") {
      return html`<div class="rrow"><span class="rlabel">in</span
        ><span class="rvals"><span class="quiet">checking\u2026</span></span></div>`;
    }
    const list = this.containsList;
    if (list.length === 0) {
      return html`<div class="rrow"><span class="rlabel">in</span
        ><span class="rvals"><span class="quiet">no branches</span></span></div>`;
    }
    const n = `${list.length}${this.containsTruncated ? "+" : ""}`;
    return html`<div class="rrow"><span class="rlabel">in</span
      ><span class="rvals">
        <button class="linkish" @click=${this.toggleContains}
          >${n} ${list.length === 1 ? "branch" : "branches"}</button>
        ${this.containsOpen
          ? html`<span class="contains-list">${list.map(
              (b) => html`<span class="chip chip-contains" title=${b}
                ><span class="codicon codicon-${b.includes("/") ? "cloud" : "git-branch"}"
                ></span><span class="chip-name">${b}</span></span>`,
            )}</span>`
          : nothing}
      </span></div>`;
  }

  /** sha ← parent, as one quiet monospace line. Identifiers are reference
   *  material: available, never competing with the message. */
  private metaHtml(d: CommitDetailsPayload) {
    const copied = this.copiedKey === "sha";
    // Two monospace identifiers used to sit side by side looking identical
    // while doing different things — one copies, one navigates. They are now
    // labelled and shaped differently: the sha is a copy target, each parent is
    // a link with a "go there" arrow.
    return html`<div class="meta-row">
      <span class="mlabel">commit</span>
      <button
        class="sha-row ${copied ? "is-copied" : ""}"
        title="Copy the full 40-character SHA"
        aria-live="polite"
        @click=${() => this.copyWithFeedback(d.sha, "sha")}>
        ${copied
          ? html`<span class="codicon codicon-check"></span><span class="copied-text">copied</span>`
          : html`${d.shortSha}<span class="codicon codicon-copy"></span>`}
      </button>
      ${d.parents.length
        ? html`<span class="parents">
            <span class="mlabel">${d.parents.length === 1 ? "parent" : "parents"}</span>
            ${d.parents.map(
              (p, i) => html`<button class="parent"
                title=${`Reveal ${p} in the graph`}
                @click=${() => this.emit("gs-reveal", { sha: p })}
                >${d.parents.length > 1
                  ? html`<span class="pnum">${i + 1}</span>`
                  : nothing}${p.slice(0, 7)}<span
                  class="codicon codicon-arrow-right"></span></button>`,
            )}
          </span>`
        : nothing}
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
        (a) => html`<button
          class="act ${a.primary ? "primary" : ""} ${a.danger ? "danger" : ""}"
          title=${a.label}
          aria-label=${a.label}
          @click=${() => this.emit("gs-action", { id: a.id, sha: d.sha })}>
          <span class="codicon codicon-${a.icon}"></span
          ><span class="act-label">${a.label}</span></button>`,
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
