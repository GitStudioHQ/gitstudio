// Gists — the user-scoped GitHub section. Mirrors the PR/Issue two-pane look
// (gh-view → header + gh-body → gh-list + gh-detail) with a read-only content
// viewer and full CRUD: New gist, Edit, Delete, plus Copy raw URL / Open on
// GitHub. Gists aren't repo-scoped, so this view gates only on the GitHub
// connection (NEEDS_REPO=false) and is reachable from any repo.
//
// State (selected gist + selected file index) lives in module scope so a refresh
// re-selects what the user was looking at; it's reset when the gist list reloads
// from a mutation. Every async boundary clears its pane on refresh by rebuilding,
// so there's no stale-paint risk.

import { host } from "../bridge";
import {
  cleanErr,
  copyText,
  el,
  emptyState,
  errorState,
  ghRow,
  glyph,
  loadingState,
  relTimeISO,
  absTimeISO,
  skeletonList,
  span,
  statBit,
  statePill,
} from "../ui";
import { confirmDialog, toast } from "../dialogs";
import { ghGate, ghHeader, searchField, type SectionRender } from "./common";
import type { GistInfo } from "../../shared/ipc";

// Remember the open gist + selected file across refreshes so the view feels
// stateful. Reset on a fresh list load triggered by a mutation.
let openGistId: string | null = null;
let openFileIdx = 0;

export const renderGists: SectionRender = (wrap, nav) => {
  void mount(wrap, nav);
};

async function mount(wrap: HTMLElement, nav: (view: string) => void): Promise<void> {
  const refresh = (): void => renderGists(wrap, nav);

  wrap.replaceChildren(loadingState("Loading gists…"));
  const gate = await ghGate(wrap, nav, false);
  if (!gate) return;

  // Shell: header (with a "New gist" action) + two-pane body.
  const view = el("div", "gh-view");
  const header = ghHeader("Gists", gate.login, refresh);
  const newBtn = el("button", "mini-btn");
  newBtn.append(glyph("add"), span("New gist"));
  newBtn.addEventListener("click", () => void newGist(refresh));
  // Slot the New-gist action into the header's right-side cluster (the .gh-acct
  // group), just left of the refresh button, so it reads as a header action.
  const acct = header.querySelector(".gh-acct");
  if (acct) acct.insertBefore(newBtn, acct.firstChild);
  else header.appendChild(newBtn);
  view.appendChild(header);

  const body = el("div", "gh-body");
  const listEl = el("div", "gh-list");
  const detail = el("div", "gh-detail");
  body.append(listEl, detail);
  view.appendChild(body);
  wrap.replaceChildren(view);

  const idleEmpty = (): void => {
    detail.replaceChildren(
      emptyState("Gists", "Select a gist to read its files and content.", {
        icon: "code",
        hint: "Tip: open one to edit, copy its raw URL, or delete it.",
      }),
    );
  };
  idleEmpty();
  listEl.replaceChildren(skeletonList(5));

  let gists: GistInfo[];
  try {
    gists = await host.invoke("gist:list", undefined);
  } catch (e) {
    listEl.replaceChildren(
      errorState("Couldn't load gists", cleanErr(e) || "GitHub request failed.", refresh),
    );
    return;
  }

  header.setCount?.(gists.length);
  listEl.replaceChildren();
  if (gists.length === 0) {
    openGistId = null;
    listEl.appendChild(
      emptyState("No gists yet", "Create your first snippet with a new gist.", {
        icon: "code",
        action: { label: "New gist", icon: "add", onClick: () => void newGist(refresh) },
      }),
    );
    return;
  }

  // If the previously open gist is gone (deleted elsewhere), drop the selection.
  if (openGistId && !gists.some((g) => g.id === openGistId)) {
    openGistId = null;
    idleEmpty();
  }

  const rows = new Map<string, HTMLElement>();
  const selectRow = (id: string): void => {
    for (const [rid, r] of rows) r.classList.toggle("active", rid === id);
  };

  const buildRow = (g: GistInfo): HTMLElement => {
    // A gist has no real title — use the description or the first filename.
    const title = g.description || g.files[0]?.filename || "Untitled gist";
    const rel = relTimeISO(g.updatedAt);
    const stats: HTMLElement[] = [];
    if (typeof g.comments === "number" && g.comments > 0) stats.push(statBit("comment", g.comments));

    // An accent-tinted code glyph as the leading icon (gists have no state).
    const lead = span("", "gh-lead-icon");
    lead.style.color = "var(--gs-accent-ink, var(--gs-accent))";
    lead.appendChild(glyph("code"));

    const row = ghRow({
      lead,
      title,
      titleSuffix: [statePill(g.public ? "Public" : "Secret", g.public ? "open" : "draft")],
      meta:
        `${g.fileCount} file${g.fileCount === 1 ? "" : "s"}` +
        (rel ? ` · updated ${rel}` : ""),
      metaTitle: g.updatedAt ? `Updated ${absTimeISO(g.updatedAt)}` : undefined,
      stats,
      ariaLabel: `Gist: ${title}`,
    });
    rows.set(g.id, row);

    row.addEventListener("click", () => {
      selectRow(g.id);
      if (openGistId !== g.id) openFileIdx = 0;
      openGistId = g.id;
      void showDetail(detail, g, refresh);
    });
    return row;
  };

  // Case-insensitive match over the fields a user would search by: the gist
  // description and every filename it contains.
  const matches = (g: GistInfo, q: string): boolean => {
    const hay = `${g.description} ${g.files.map((f) => f.filename).join(" ")}`.toLowerCase();
    return hay.includes(q);
  };

  let autoSelected = false;
  const renderList = (items: GistInfo[], q = ""): void => {
    rows.clear();
    listEl.replaceChildren();
    if (items.length === 0) {
      listEl.appendChild(
        emptyState("No matching gists", `Nothing matches “${q}”.`, { icon: "search" }),
      );
      return;
    }
    for (const g of items) listEl.appendChild(buildRow(g));
    // On the initial render only, re-open the previously selected gist (e.g.
    // after an edit), otherwise auto-select the first gist so the detail pane
    // isn't a void. Filtering keystrokes never hijack the current selection.
    if (!autoSelected) {
      autoSelected = true;
      const reopen = openGistId ? items.find((g) => g.id === openGistId) : items[0];
      if (reopen) {
        if (openGistId !== reopen.id) openFileIdx = 0;
        openGistId = reopen.id;
        selectRow(reopen.id);
        void showDetail(detail, reopen, refresh);
      }
    } else {
      // Keep the active highlight in sync with the current selection.
      if (openGistId) selectRow(openGistId);
    }
  };

  // A header search/filter — on the LEFT, next to the title (client-side, instant).
  header.querySelector(".gh-head-titlewrap")?.appendChild(
    searchField({
      placeholder: "Search gists…",
      onInput: (q) => renderList(q ? gists.filter((g) => matches(g, q.toLowerCase())) : gists, q),
    }),
  );

  renderList(gists);
}

// ── Detail pane ──────────────────────────────────────────────────────────────

async function showDetail(
  detail: HTMLElement,
  summary: GistInfo,
  refresh: () => void,
): Promise<void> {
  detail.replaceChildren(loadingState("Loading gist…"));

  let g: GistInfo;
  try {
    // The list payload omits file CONTENT — fetch the full gist for the body.
    const full = await host.invoke("gist:detail", summary.id);
    if (!full) {
      detail.replaceChildren(emptyState("Not connected", "Sign in to view this gist."));
      return;
    }
    g = full;
  } catch (e) {
    detail.replaceChildren(
      errorState("Couldn't load gist", cleanErr(e) || "GitHub request failed.", () =>
        void showDetail(detail, summary, refresh),
      ),
    );
    return;
  }

  // Guard: a different gist may have been selected while this one was loading.
  if (openGistId !== g.id) return;

  detail.replaceChildren();

  const head = el("div", "gh-detail-head");
  const title = el("div", "gh-detail-title");
  title.textContent = g.description || g.files[0]?.filename || "(no description)";

  const meta = el("div", "gh-detail-meta");
  const rel = relTimeISO(g.updatedAt);
  const owner = g.owner?.login ?? "";
  meta.textContent =
    `${g.public ? "public" : "secret"} · ${g.fileCount} file${g.fileCount === 1 ? "" : "s"}` +
    (owner ? ` · ${owner}` : "") +
    (rel ? ` · updated ${rel}` : "");

  const actions = el("div", "gh-detail-actions");

  const editBtn = el("button", "mini-btn");
  editBtn.append(glyph("edit"), span("Edit"));
  editBtn.addEventListener("click", () => void editGist(g, refresh));

  const copyBtn = el("button", "mini-btn");
  copyBtn.append(glyph("copy"), span("Copy raw URL"));
  copyBtn.title = "Copy the raw URL of the selected file";
  copyBtn.addEventListener("click", () => {
    const url = g.files[clampIdx(g)]?.rawUrl;
    if (url) void copyText(url, "Raw URL copied.");
    else toast("This file has no raw URL.", "error");
  });

  const openBtn = el("button", "mini-btn");
  openBtn.append(glyph("link-external"), span("Open on GitHub"));
  openBtn.addEventListener("click", () => window.open(g.htmlUrl, "_blank", "noopener"));

  const delBtn = el("button", "mini-btn danger");
  delBtn.append(glyph("trash"), span("Delete"));
  delBtn.addEventListener("click", () => void deleteGist(g, delBtn, refresh));

  actions.append(editBtn, copyBtn, openBtn, delBtn);
  head.append(title, meta, actions);
  detail.appendChild(head);

  if (g.files.length === 0) {
    detail.appendChild(emptyState("Empty gist", "This gist has no files."));
    return;
  }

  // File tabs (when >1 file) + the selected file's content in a read-only <pre>.
  const tabBar = el("div", "gh-subtabs");
  const content = el("div", "gh-subcontent");
  const tabBtns: HTMLElement[] = [];

  const renderFile = (idx: number): void => {
    openFileIdx = idx;
    for (const b of tabBtns) b.classList.toggle("active", Number(b.dataset.fileIdx) === idx);
    const f = g.files[idx];
    if (!f) return;
    content.replaceChildren();

    const fileHead = el("div", "gist-file-head");
    const name = span(f.filename, "gist-file-name");
    const fileSub = span(
      `${f.language || f.type || "text"} · ${formatBytes(f.size)}` +
        (f.truncated ? " · truncated" : ""),
      "gist-file-sub",
    );
    fileHead.append(name, fileSub);
    content.appendChild(fileHead);

    const pre = el("pre", "gist-content");
    const code = el("code");
    code.textContent = f.truncated
      ? `${f.content}\n\n… (truncated — open on GitHub for the full file)`
      : f.content;
    pre.appendChild(code);
    content.appendChild(pre);
  };

  if (g.files.length > 1) {
    g.files.forEach((f, i) => {
      const b = el("button", "gh-subtab");
      b.dataset.fileIdx = String(i);
      b.append(glyph("file"), span(f.filename));
      b.addEventListener("click", () => renderFile(i));
      tabBtns.push(b);
      tabBar.appendChild(b);
    });
    detail.appendChild(tabBar);
  }
  detail.appendChild(content);
  renderFile(clampIdx(g));
}

function clampIdx(g: GistInfo): number {
  if (g.files.length === 0) return 0;
  return Math.min(Math.max(0, openFileIdx), g.files.length - 1);
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 bytes";
  if (n < 1024) return `${n} byte${n === 1 ? "" : "s"}`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Mutations ────────────────────────────────────────────────────────────────

async function newGist(refresh: () => void): Promise<void> {
  const v = await gistDialog({ title: "New gist", okLabel: "Create gist" });
  if (!v) return;
  try {
    const r = await host.invoke("gist:create", {
      description: v.description,
      filename: v.filename,
      content: v.content,
      public: v.public,
    });
    if (!r.ok) {
      toast(r.message || "Couldn't create the gist.", "error");
      return;
    }
    // The created id comes back in `message` — select it on the next render.
    openGistId = r.message ?? null;
    openFileIdx = 0;
    toast("Gist created.", "success");
    refresh();
  } catch (e) {
    toast(cleanErr(e) || "Couldn't create the gist.", "error");
  }
}

async function editGist(g: GistInfo, refresh: () => void): Promise<void> {
  const file = g.files[clampIdx(g)] ?? g.files[0];
  if (!file) return;
  const v = await gistDialog({
    title: "Edit gist",
    okLabel: "Save changes",
    description: g.description,
    filename: file.filename,
    content: file.content,
    public: g.public,
    lockVisibility: true, // GitHub can't flip public↔secret on an existing gist
  });
  if (!v) return;
  try {
    const r = await host.invoke("gist:update", {
      id: g.id,
      description: v.description,
      filename: file.filename, // current name = the API key
      content: v.content,
      newFilename: v.filename, // rename when changed
    });
    if (!r.ok) {
      toast(r.message || "Couldn't save the gist.", "error");
      return;
    }
    openGistId = g.id;
    toast("Gist saved.", "success");
    refresh();
  } catch (e) {
    toast(cleanErr(e) || "Couldn't save the gist.", "error");
  }
}

async function deleteGist(
  g: GistInfo,
  btn: HTMLElement,
  refresh: () => void,
): Promise<void> {
  const ok = await confirmDialog({
    title: "Delete this gist?",
    message: `“${g.description || g.files[0]?.filename || g.id}” will be permanently deleted on GitHub. This can't be undone.`,
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  (btn as HTMLButtonElement).disabled = true;
  try {
    const r = await host.invoke("gist:delete", g.id);
    if (!r.ok) {
      toast(r.message || "Couldn't delete the gist.", "error");
      (btn as HTMLButtonElement).disabled = false;
      return;
    }
    if (openGistId === g.id) openGistId = null;
    toast("Gist deleted.", "success");
    refresh();
  } catch (e) {
    (btn as HTMLButtonElement).disabled = false;
    toast(cleanErr(e) || "Couldn't delete the gist.", "error");
  }
}

// ── Create / edit modal ──────────────────────────────────────────────────────
//
// promptInline is single-line only, so this section ships a dedicated modal that
// reuses the shared .modal-* scaffold (overlay, focus-trap, Esc-to-close) plus
// the gist-specific .gist-* classes. Self-contained so the view stays in its own
// two files (no edit to dialogs.ts).

interface GistDialogResult {
  description: string;
  filename: string;
  content: string;
  public: boolean;
}

function gistDialog(opts: {
  title: string;
  okLabel: string;
  description?: string;
  filename?: string;
  content?: string;
  public?: boolean;
  /** When true, the public/secret toggle is shown disabled (edit can't flip it). */
  lockVisibility?: boolean;
}): Promise<GistDialogResult | null> {
  return new Promise((resolve) => {
    let settled = false;
    const prevFocus = document.activeElement as HTMLElement | null;
    const overlay = el("div", "modal-overlay");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");

    const finish = (v: GistDialogResult | null): void => {
      if (settled) return;
      settled = true;
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
      prevFocus?.focus?.();
      resolve(v);
    };

    const card = el("div", "modal-card gist-modal");

    const heading = el("div", "modal-title");
    heading.textContent = opts.title;
    heading.id = "gist-modal-title";
    overlay.setAttribute("aria-labelledby", heading.id);

    const descIn = document.createElement("input");
    descIn.className = "modal-input";
    descIn.placeholder = "Description (optional)";
    descIn.value = opts.description ?? "";

    const fileIn = document.createElement("input");
    fileIn.className = "modal-input";
    fileIn.placeholder = "Filename including extension…";
    fileIn.value = opts.filename ?? "";
    fileIn.spellcheck = false;
    fileIn.autocapitalize = "off";

    const contentIn = document.createElement("textarea");
    contentIn.className = "modal-input gist-textarea";
    contentIn.placeholder = "Gist content…";
    contentIn.value = opts.content ?? "";
    contentIn.spellcheck = false;

    const visRow = el("label", "gist-visibility");
    const vis = document.createElement("input");
    vis.type = "checkbox";
    vis.checked = opts.public ?? false;
    if (opts.lockVisibility) {
      vis.disabled = true;
      visRow.title = "A gist's visibility can't be changed after it's created.";
    }
    const visLabel = span(`${vis.checked ? "Public" : "Secret"} gist`);
    visRow.append(vis, visLabel);
    if (!opts.lockVisibility) {
      vis.addEventListener("change", () => {
        visLabel.textContent = vis.checked ? "Public gist" : "Secret gist";
      });
    }

    const actions = el("div", "modal-actions");
    const cancel = el("button", "mini-btn");
    cancel.textContent = "Cancel";
    const ok = el("button", "btn btn-primary modal-ok");
    ok.appendChild(span(opts.okLabel));
    actions.append(cancel, ok);

    card.append(heading, descIn, fileIn, contentIn, visRow, actions);

    const submit = (): void => {
      const filename = fileIn.value.trim();
      if (!filename) {
        fileIn.focus(); // filename is required (GitHub rejects an empty key)
        return;
      }
      finish({
        description: descIn.value.trim(),
        filename,
        content: contentIn.value,
        public: vis.checked,
      });
    };

    cancel.addEventListener("click", () => finish(null));
    ok.addEventListener("click", submit);

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(null);
        return;
      }
      // Cmd/Ctrl+Enter submits from the textarea (Enter alone inserts newlines).
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit();
        return;
      }
      if (e.key !== "Tab") return;
      const f = Array.from(
        card.querySelectorAll<HTMLElement>(
          "button, input, textarea, [tabindex]:not([tabindex='-1'])",
        ),
      ).filter((n) => !n.hasAttribute("disabled"));
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) finish(null);
    });
    document.addEventListener("keydown", onKey, true);
    // On edit, the filename is known → focus the content; on create, focus the filename.
    setTimeout(() => (opts.filename ? contentIn : fileIn).focus(), 0);
  });
}
