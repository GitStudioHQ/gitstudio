// Gists — the user-scoped GitHub section, on the section-page system
// (docs/desktop-redesign.md): a full-width list whose rows navigate to a
// full-page detail (routed via `target.id` — gists are string-keyed), with the
// gist's files as tabs of SYNTAX-HIGHLIGHTED content (same .ghfile renderer as
// the remote repo browser) and its facts in the rail. Full CRUD: New gist,
// Edit, Delete, Copy raw URL. Gists aren't repo-scoped, so the view gates only
// on the GitHub connection (NEEDS_REPO=false).

import { host } from "../bridge";
import { peek as cachePeek, gget, bust } from "../cache";
import {
  cleanErr,
  copyText,
  el,
  emptyState,
  errorState,
  glyph,
  openMenu,
  relTimeISO,
  absTimeISO,
  skeletonList,
  span,
  statBit,
  statePill,
} from "../ui";
import { confirmDialog, openModal, toast } from "../dialogs";
import { highlightCode } from "../highlight";
import {
  detailPage,
  blankable,
  ghGate,
  ghHeader,
  personChip,
  propSection,
  searchField,
  secRow,
  sectionList,
  type GhGate,
  type SectionNav,
  type SectionRender,
  type SectionTarget,
} from "./common";
import type { GistInfo } from "../../shared/ipc";

/** The selected file tab inside a gist detail, per gist id — so re-renders
 *  (after an edit) restore the file the user was reading. */
const fileTabByGist = new Map<string, number>();
/** The list page's live search query — survives list ⇄ detail round trips. */
let query = "";

export const renderGists: SectionRender = (wrap, nav, target) => {
  void mount(wrap, nav, target);
};

async function mount(wrap: HTMLElement, nav: SectionNav, target?: SectionTarget): Promise<void> {
  const refresh = (): void => {
    bust("gist");
    renderGists(wrap, nav, target);
  };
  const gate = await ghGate(wrap, nav, false, refresh);
  if (!gate) return;

  if (target?.id) {
    showGistDetailPage(wrap, nav, target.id);
    return;
  }
  await listPage(wrap, nav, gate);
}

// ── The list page ────────────────────────────────────────────────────────────

async function listPage(wrap: HTMLElement, nav: SectionNav, gate: GhGate): Promise<void> {
  const refresh = (): void => {
    bust("gist");
    renderGists(wrap, nav);
  };

  const { view, listEl } = sectionList();
  const header = ghHeader("Gists", gate.login, refresh);
  const tools = el("div", "gh-head-tools");
  const newBtn = el("button", "btn btn-primary gh-new-btn");
  newBtn.append(glyph("add"), span("New gist"));
  newBtn.addEventListener("click", () => void newGist(nav, refresh));
  tools.append(newBtn);
  header.querySelector(".gh-acct")?.before(tools);
  view.append(header, listEl);
  wrap.replaceChildren(view);

  header.querySelector(".gh-head-titlewrap")?.appendChild(
    searchField({
      placeholder: "Search gists…",
      initial: query,
      onInput: (q) => {
        query = q;
        renderList();
      },
    }),
  );

  let gists: GistInfo[] | undefined = cachePeek("gist:list", undefined);
  if (!gists) listEl.replaceChildren(skeletonList(5));

  const buildRow = (g: GistInfo): HTMLElement => {
    // A gist has no real title — use the description or the first filename.
    const title = g.description || g.files[0]?.filename || "Untitled gist";
    // The comment count keeps its column even at zero: dropping the element
    // slid "1 file" 69px between a gist with comments and one without, so the
    // list had no meta columns at all.
    const meta: HTMLElement[] = [
      span(`${g.fileCount} file${g.fileCount === 1 ? "" : "s"}`, "gist-filecount"),
      blankable(statBit("comment", g.comments ?? 0), (g.comments ?? 0) > 0),
    ];
    const lead = el("span", "gh-lead-icon is-accent");
    lead.appendChild(glyph("code"));
    const row = secRow({
      lead,
      title,
      titleSuffix: [statePill(g.public ? "Public" : "Secret", g.public ? "public" : "private")],
      meta,
      time: relTimeISO(g.updatedAt),
      timeTitle: g.updatedAt ? `Updated ${absTimeISO(g.updatedAt)}` : undefined,
      ariaLabel: `Gist: ${title}`,
      onOpen: () => nav("gists", { id: g.id }),
    });
    row.dataset.num = g.id;
    return row;
  };

  const matches = (g: GistInfo, q: string): boolean =>
    `${g.description} ${g.files.map((f) => f.filename).join(" ")}`.toLowerCase().includes(q);

  const renderList = (): void => {
    if (!gists) return;
    listEl.replaceChildren();
    if (gists.length === 0) {
      header.setCount?.(0);
      listEl.appendChild(
        emptyState("No gists yet", "Create your first snippet with a new gist.", {
          icon: "code",
          action: { label: "New gist", icon: "add", onClick: () => void newGist(nav, refresh) },
        }),
      );
      return;
    }
    const q = query.toLowerCase();
    const items = q ? gists.filter((g) => matches(g, q)) : gists;
    // Same contract as the other lists: the badge counts what is on screen, so
    // it can't read "2" above "No matching gists".
    header.setCount?.(items.length, gists.length);
    if (items.length === 0) {
      listEl.appendChild(emptyState("No matching gists", `Nothing matches “${query}”.`, { icon: "search" }));
      return;
    }
    for (const g of items) listEl.appendChild(buildRow(g));
  };

  if (gists) renderList();

  try {
    const fresh = await gget("gist:list", undefined, 30000);
    if (!view.isConnected) return;
    gists = fresh;
    renderList();
  } catch (e) {
    if (!view.isConnected) return;
    if (!gists) {
      listEl.replaceChildren(
        errorState("Couldn't load gists", cleanErr(e) || "GitHub request failed.", refresh),
      );
    }
  }
}

// ── The detail page ──────────────────────────────────────────────────────────

function showGistDetailPage(wrap: HTMLElement, nav: SectionNav, id: string): void {
  const back = (): void => nav("gists", { list: true });
  const reload = (): void => {
    bust("gist");
    showGistDetailPage(wrap, nav, id);
  };

  const { view, main, rail, topActions } = detailPage({
    backLabel: "Gists",
    onBack: back,
  });
  main.appendChild(skeletonList(4, false));
  wrap.replaceChildren(view);

  void (async () => {
    let g: GistInfo | undefined;
    try {
      // The list payload omits file CONTENT — the detail fetch carries it.
      g = await gget("gist:detail", id, 15000);
    } catch (e) {
      if (!view.isConnected) return;
      main.replaceChildren(
        errorState("Couldn't load gist", cleanErr(e) || "GitHub request failed.", reload),
      );
      return;
    }
    if (!view.isConnected) return;
    if (!g) {
      main.replaceChildren(emptyState("Gist unavailable", "This gist couldn't be loaded."));
      return;
    }
    buildGistDetail({ main, rail, topActions, g, reload, back });
  })();
}

interface GistDetailCtx {
  main: HTMLElement;
  rail: HTMLElement;
  topActions: HTMLElement;
  g: GistInfo;
  reload: () => void;
  back: () => void;
}

function buildGistDetail(ctx: GistDetailCtx): void {
  const { main, rail, topActions, g, reload, back } = ctx;
  main.replaceChildren();
  rail.replaceChildren();

  const fileIdx = (): number => {
    const saved = fileTabByGist.get(g.id) ?? 0;
    return g.files.length ? Math.min(Math.max(0, saved), g.files.length - 1) : 0;
  };

  // ── top-bar actions ──
  const editBtn = el("button", "mini-btn");
  editBtn.append(glyph("edit"), span("Edit"));
  editBtn.addEventListener("click", () => void editGist(g, fileIdx(), reload));

  const copyBtn = el("button", "mini-btn");
  copyBtn.append(glyph("copy"), span("Copy raw URL"));
  copyBtn.title = "Copy the raw URL of the selected file";
  copyBtn.addEventListener("click", () => {
    const url = g.files[fileIdx()]?.rawUrl;
    if (url) void copyText(url, "Raw URL copied.");
    else toast("This file has no raw URL.", "error");
  });

  const moreBtn = el("button", "mini-btn gh-icon-btn");
  moreBtn.append(glyph("ellipsis"));
  moreBtn.title = "More actions";
  moreBtn.addEventListener("click", () =>
    openMenu(moreBtn, [
      { label: "Copy link", icon: "copy", onClick: () => void copyText(g.htmlUrl, "Copied gist link.") },
      { separator: true },
      { label: "Delete gist", icon: "trash", onClick: () => void deleteGist(g, moreBtn, back) },
    ]),
  );

  const openBtn = el("button", "mini-btn gh-icon-btn");
  openBtn.append(glyph("link-external"));
  openBtn.title = "Open this gist on GitHub";
  openBtn.setAttribute("aria-label", openBtn.title);
  openBtn.addEventListener("click", () => window.open(g.htmlUrl, "_blank", "noopener"));

  topActions.replaceChildren(editBtn, copyBtn, moreBtn, openBtn);

  // ── title block ──
  const titleRow = el("div", "det-title-row");
  const h = el("h1", "det-title");
  h.textContent = g.description || g.files[0]?.filename || "(no description)";
  titleRow.appendChild(h);
  // After the title, not before it: a leading pill pushed the H1 ~110px right
  // of the page's left rule, so the heading no longer started where every
  // other heading starts.
  titleRow.appendChild(statePill(g.public ? "Public" : "Secret", g.public ? "public" : "private"));
  main.appendChild(titleRow);

  const sub = el("div", "det-sub");
  const when = el("span");
  when.textContent = `updated ${relTimeISO(g.updatedAt)}`;
  when.title = absTimeISO(g.updatedAt);
  sub.appendChild(when);
  main.appendChild(sub);

  if (g.files.length === 0) {
    main.appendChild(emptyState("Empty gist", "This gist has no files."));
  } else {
    // ── file tabs + highlighted content ──
    const tabBar = el("div", "gh-subtabs");
    const content = el("div", "gh-subcontent");
    const tabBtns: HTMLElement[] = [];

    const renderFile = (idx: number): void => {
      fileTabByGist.set(g.id, idx);
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
      content.appendChild(codeBlock(f.content, f.filename, f.truncated));
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
      main.appendChild(tabBar);
    }
    main.appendChild(content);
    renderFile(fileIdx());
  }

  // ── rail ──
  const ownerProp = propSection("Owner");
  if (g.owner?.login) ownerProp.body.appendChild(personChip(g.owner.login, g.owner.avatarUrl));
  else ownerProp.body.appendChild(span("—", "det-prop-none"));

  const about = propSection("About");
  about.body.classList.add("det-prop-facts");
  const fact = (k: string, v: string, title?: string): HTMLElement => {
    const row = el("div", "det-fact");
    const val = el("span", "det-fact-v");
    val.textContent = v;
    if (title) val.title = title;
    row.append(span(k, "det-fact-k"), val);
    return row;
  };
  about.body.appendChild(fact("Files", String(g.fileCount)));
  if (typeof g.comments === "number") about.body.appendChild(fact("Comments", String(g.comments)));
  about.body.appendChild(fact("Created", relTimeISO(g.createdAt), absTimeISO(g.createdAt)));
  about.body.appendChild(fact("Updated", relTimeISO(g.updatedAt), absTimeISO(g.updatedAt)));

  rail.append(ownerProp.root, about.root);
}

/** Render gist code with a line-number gutter + syntax highlighting — the same
 *  .ghfile renderer the remote repo browser uses (the old view was a plain
 *  un-highlighted <pre>). Capped so a giant file can't lock the UI. */
const MAX_RENDER_LINES = 5000;
function codeBlock(text: string, fileName: string, truncated: boolean): HTMLElement {
  const lines = text.split("\n");
  const shown = lines.slice(0, MAX_RENDER_LINES);
  const wrap = el("div", "ghfile");
  const gutter = el("pre", "ghfile-gutter");
  gutter.textContent = shown.map((_, i) => String(i + 1)).join("\n");
  gutter.setAttribute("aria-hidden", "true");
  const code = el("pre", "ghfile-code");
  code.textContent = shown.join("\n");
  void highlightCode(code, shown.join("\n"), fileName);
  wrap.append(gutter, code);
  const capped = lines.length > shown.length;
  if (capped || truncated) {
    const more = el("div", "ghfile-more");
    more.textContent = truncated
      ? "GitHub truncated this file — open it on GitHub for the full content."
      : `Showing the first ${MAX_RENDER_LINES.toLocaleString()} of ${lines.length.toLocaleString()} lines.`;
    const outer = el("div", "ghfile-outer");
    outer.append(wrap, more);
    return outer;
  }
  return wrap;
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 bytes";
  if (n < 1024) return `${n} byte${n === 1 ? "" : "s"}`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Mutations ────────────────────────────────────────────────────────────────

async function newGist(nav: SectionNav, refresh: () => void): Promise<void> {
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
    toast("Gist created.", "success");
    bust("gist");
    // The created id comes back in `message` — open the new gist directly.
    if (r.message) nav("gists", { id: r.message });
    else refresh();
  } catch (e) {
    toast(cleanErr(e) || "Couldn't create the gist.", "error");
  }
}

async function editGist(g: GistInfo, fileIdx: number, reload: () => void): Promise<void> {
  const file = g.files[fileIdx] ?? g.files[0];
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
    toast("Gist saved.", "success");
    reload();
  } catch (e) {
    toast(cleanErr(e) || "Couldn't save the gist.", "error");
  }
}

async function deleteGist(g: GistInfo, btn: HTMLElement, back: () => void): Promise<void> {
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
    toast("Gist deleted.", "success");
    bust("gist");
    back(); // the detail's subject no longer exists — land on the list
  } catch (e) {
    (btn as HTMLButtonElement).disabled = false;
    toast(cleanErr(e) || "Couldn't delete the gist.", "error");
  }
}

// ── Create / edit modal ──────────────────────────────────────────────────────
//
// promptInline is single-line only, so this section ships a dedicated modal that
// reuses the shared .modal-* scaffold (overlay, focus-trap, Esc-to-close) plus
// the gist-specific .gist-* classes.

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
    openModal((close) => {
      const finish = (v: GistDialogResult | null): void => {
        if (settled) return;
        settled = true;
        resolve(v);
        close();
      };

      const card = el("div", "modal-card gist-modal");

      const heading = el("div", "modal-title");
      heading.textContent = opts.title;
      heading.id = "gist-modal-title";

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

      // Cmd/Ctrl+Enter submits from the textarea (Enter alone inserts newlines).
      // On the card, not document — openModal owns Escape and the Tab trap.
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          submit();
        }
      });

      return {
        card,
        // On edit, the filename is known → focus the content; on create, the filename.
        focusEl: opts.filename ? contentIn : fileIn,
        label: opts.title,
        onClose: () => {
          if (!settled) resolve(null);
        },
      };
    });
  });
}
