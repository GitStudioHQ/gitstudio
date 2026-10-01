// The commit and file rows of every "what is about to leave / what is here"
// list: the push review (the Changes view's Push… dialog), a worktree's
// uncommitted files and its commits not pushed (the Worktrees view) — one
// renderer, so they read the same wherever they are.
//
// Plain DOM, no framework: the push review's page is a hand-written script
// that reaches these through `window.GsChangeRows` (global.ts), and the
// Worktrees page imports them. Styles: changeRows.css (`.cr-*`), inlined into
// the Changes view and bundled into the Worktrees page.
//
// A commit row opens to its own files — what that one commit did, diffed
// against its first parent — asked for the first time it opens
// (`loadFiles`) and filled by setCommitFiles. A file row opens its diff.

import { statusWords, type ChangeCommit, type ChangeFile } from "@gitstudio/host-bridge/changeRows";
import { relTime } from "../graph/format";
import * as l10n from "@vscode/l10n";

export type { ChangeCommit, ChangeFile };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function codicon(name: string): HTMLElement {
  const i = el("i", `codicon codicon-${name}`);
  i.setAttribute("aria-hidden", "true");
  return i;
}

/** The class that colours a status letter. */
export function statusClass(status: string): string {
  const s = (status || "M").charAt(0).toUpperCase();
  if (s === "!") return "st-conflict";
  if (s === "U") return "st-untracked";
  if (s === "C") return "st-R";
  if (s === "T") return "st-M";
  return /^[AMDR]$/.test(s) ? `st-${s}` : "st-M";
}

/** A section's label: small caps, with its count when given. */
export function sectionLabel(text: string, count?: number): HTMLElement {
  const label = el("div", "cr-section-label");
  label.appendChild(el("span", "cr-section-text", text));
  label.dataset.tip = text;
  if (count !== undefined) {
    label.appendChild(el("span", "cr-section-count", String(count)));
  }
  return label;
}

/** A quiet line in place of an empty list ("No uncommitted changes"). */
export function emptyNote(text: string): HTMLElement {
  return el("div", "cr-empty", text);
}

/** "and 12 more" under a capped list. */
export function moreLine(text: string): HTMLElement {
  return el("div", "cr-more", text);
}

export interface FileRowOptions {
  /** Opens the file's diff; without it the row is not a control. */
  onOpen?: (file: ChangeFile) => void;
  /** Left padding, for a file under a commit. */
  indent?: number;
  /** The row's role (default "button" when it opens, none otherwise). */
  role?: string;
  /** Its tabIndex (default 0 when it opens). A tree gives -1 and moves focus itself. */
  tabIndex?: number;
}

/**
 * One file: its status letter (coloured, named in words for a screen reader),
 * its name, a tag for a staged or conflicted change, its folder (clipped from
 * the start, so the part nearest the file stays), and its +/− line counts.
 */
export function fileRow(f: ChangeFile, o: FileRowOptions = {}): HTMLElement {
  const st = (f.status || "M").charAt(0).toUpperCase();
  const row = el("div", `cr-file ${statusClass(st)}`);
  row.dataset.path = f.path;
  if (f.area) row.dataset.area = f.area;
  const letter = el("span", "cr-st", st);
  letter.setAttribute("aria-hidden", "true");
  row.appendChild(letter);
  const slash = f.path.lastIndexOf("/");
  const name = slash === -1 ? f.path : f.path.slice(slash + 1);
  const dir = slash === -1 ? "" : f.path.slice(0, slash);
  row.appendChild(el("span", "cr-name", name));
  if (f.area === "staged" || f.area === "conflicted") {
    row.appendChild(el("span", `cr-tag cr-tag--${f.area}`, f.area === "staged" ? "staged" : "conflict"));
  }
  const d = el("span", "cr-dir");
  // The box clips from the start (direction: rtl) to keep the tail; the
  // path is an isolated left-to-right run inside it.
  d.appendChild(el("bdi", undefined, dir));
  row.appendChild(d);
  const adds = f.additions ?? 0;
  const dels = f.deletions ?? 0;
  if (adds < 0 || dels < 0) {
    row.appendChild(el("span", "cr-nums cr-binary", "binary"));
  } else if (adds > 0 || dels > 0) {
    const nums = el("span", "cr-nums");
    if (adds > 0) nums.appendChild(el("span", "cr-add", `+${adds}`));
    if (dels > 0) nums.appendChild(el("span", "cr-del", `−${dels}`));
    row.appendChild(nums);
  }
  const words = statusWords(st, f.area);
  const was = f.oldPath ? l10n.t(", was {0}", f.oldPath) : "";
  if (o.onOpen) {
    const open = o.onOpen;
    row.classList.add("clickable");
    row.setAttribute("role", o.role ?? "button");
    row.tabIndex = o.tabIndex ?? 0;
    const tip = l10n.t("Open changes — {0}{1}", f.path, f.oldPath ? l10n.t(" (was {0})", f.oldPath) : "");
    row.dataset.tip = tip;
    row.setAttribute("aria-label", l10n.t("{0}, {1}{2}{3}. Open changes", name, words, was, dir ? l10n.t(", in {0}", dir) : ""));
    row.addEventListener("click", () => open(f));
    row.addEventListener("keydown", (e) => {
      if (e.target !== row) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open(f);
      }
    });
  } else {
    if (o.role) row.setAttribute("role", o.role);
    if (o.tabIndex !== undefined) row.tabIndex = o.tabIndex;
    row.dataset.tip = `${f.path}${f.oldPath ? l10n.t(" (was {0})", f.oldPath) : ""}`;
    row.setAttribute("aria-label", `${name}, ${words}${was}${dir ? l10n.t(", in {0}", dir) : ""}`);
  }
  if (o.indent) row.style.paddingLeft = `${o.indent}px`;
  return row;
}

export interface CommitRowOptions {
  /** The row opens to its files (default true). */
  expandable?: boolean;
  /** Asked the first time the row opens; answer with setCommitFiles. */
  loadFiles?: (c: ChangeCommit) => void;
  /** A file under it was clicked: what this commit did to it. */
  onOpenFile?: (c: ChangeCommit, f: ChangeFile) => void;
  /** Left padding, for a commit under a section. */
  indent?: number;
  role?: string;
  tabIndex?: number;
  /** Seconds since the epoch, for the relative time (tests pin it). */
  now?: number;
}

interface CommitItem extends HTMLElement {
  _commit?: ChangeCommit;
  _opts?: CommitRowOptions;
  _asked?: boolean;
}

/**
 * One commit — its short sha, its subject, its author and when — as an item
 * that opens (chevron, click, Enter or Space, → and ←) to the files that
 * commit changed. Returns the item: `.cr-commit` row + `.cr-commit-files`.
 */
export function commitRow(c: ChangeCommit, o: CommitRowOptions = {}): HTMLElement {
  const expandable = o.expandable !== false;
  const item = el("div", "cr-commit-item") as CommitItem;
  item._commit = c;
  item._opts = o;
  item.dataset.sha = c.sha;
  const row = el("div", "cr-commit");
  if (expandable) {
    const chev = el("span", "cr-chevron");
    chev.appendChild(codicon("chevron-right"));
    row.appendChild(chev);
  }
  row.appendChild(el("span", "cr-sha", c.sha.slice(0, 7)));
  row.appendChild(el("span", "cr-subj", c.subject));
  // One way to say a commit's age, as the Commits list says it ("3h"): the
  // host's, when it sent one, else the graph's formatter — the same words.
  const when = c.rel ?? relTime(c.date, o.now);
  // Author, then when; a narrow list keeps only when (the tooltip has both).
  const meta = el("span", "cr-meta");
  meta.append(el("span", "cr-author", c.author), el("span", "cr-when", when));
  row.appendChild(meta);
  row.dataset.tip = `${c.subject} — ${c.sha.slice(0, 10)} · ${c.author} · ${when}`;
  if (o.indent) row.style.paddingLeft = `${o.indent}px`;
  item.appendChild(row);
  if (expandable) {
    row.classList.add("clickable");
    row.setAttribute("role", o.role ?? "button");
    row.tabIndex = o.tabIndex ?? 0;
    row.setAttribute("aria-expanded", "false");
    row.setAttribute("aria-label", l10n.t("{0} — {1} by {2}, {3}. Show its files", c.subject, c.sha.slice(0, 7), c.author, when));
    const files = el("div", "cr-commit-files");
    files.hidden = true;
    files.setAttribute("role", "group");
    item.appendChild(files);
    row.addEventListener("click", () => toggleCommit(item));
    row.addEventListener("keydown", (e) => {
      if (e.target !== row) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleCommit(item);
      } else if (e.key === "ArrowRight" && !isCommitOpen(item)) {
        e.preventDefault();
        e.stopPropagation();
        toggleCommit(item, true);
      } else if (e.key === "ArrowLeft" && isCommitOpen(item)) {
        e.preventDefault();
        e.stopPropagation();
        toggleCommit(item, false);
      }
    });
  } else {
    row.setAttribute("aria-label", `${c.subject} — ${c.sha.slice(0, 7)} by ${c.author}, ${when}`);
  }
  return item;
}

/** Whether a commit item is open. */
export function isCommitOpen(item: HTMLElement): boolean {
  return item.classList.contains("open");
}

/** Open or close a commit item; the first open asks for its files. */
export function toggleCommit(item: HTMLElement, open?: boolean): void {
  const it = item as CommitItem;
  const files = item.querySelector<HTMLElement>(":scope > .cr-commit-files");
  const row = item.querySelector<HTMLElement>(":scope > .cr-commit");
  if (!files || !row) return;
  const next = open ?? !isCommitOpen(item);
  item.classList.toggle("open", next);
  row.setAttribute("aria-expanded", next ? "true" : "false");
  files.hidden = !next;
  if (next && !it._asked) {
    it._asked = true;
    files.replaceChildren(el("div", "cr-loading", l10n.t("Loading files…")));
    if (it._commit) it._opts?.loadFiles?.(it._commit);
  }
}

/** Fill an open commit's files (null: they could not be read). */
export function setCommitFiles(item: HTMLElement, list: ChangeFile[] | null): void {
  const it = item as CommitItem;
  const files = item.querySelector<HTMLElement>(":scope > .cr-commit-files");
  if (!files || !it._commit) return;
  const c = it._commit;
  const o = it._opts ?? {};
  const indent = (o.indent ?? 8) + 18;
  if (list === null) {
    files.replaceChildren(el("div", "cr-loading", l10n.t("Couldn't read this commit's files.")));
    return;
  }
  if (list.length === 0) {
    files.replaceChildren(el("div", "cr-loading", l10n.t("No file changes in this commit.")));
    return;
  }
  files.replaceChildren(
    ...list.map((f) =>
      fileRow(f, {
        indent,
        onOpen: o.onOpenFile ? (file) => o.onOpenFile!(c, file) : undefined,
        role: o.role === "treeitem" ? "treeitem" : undefined,
        tabIndex: o.tabIndex,
      }),
    ),
  );
}
