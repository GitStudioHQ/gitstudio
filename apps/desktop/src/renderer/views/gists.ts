// Gists — the user-scoped GitHub section, on the section-page system
// (docs/desktop-redesign.md): a full-width list whose rows navigate to a
// full-page detail (routed via `target.id` — gists are string-keyed), with the
// gist's files as tabs of SYNTAX-HIGHLIGHTED content (same .ghfile renderer as
// the remote repo browser) and its facts in the rail. Full CRUD: New gist,
// Edit, Delete, Copy raw URL. Gists aren't repo-scoped, so the view gates only
// on the GitHub connection (NEEDS_REPO=false).

import * as l10n from "@vscode/l10n";
import { fileLines } from "../textFit";
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
import { confirmDialog, openModal, toast, formWithRetry } from "../dialogs";
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
  subTabs,
} from "./common";
import type { GistInfo } from "../../shared/ipc";
import { perTab } from "../tabState";

/** The selected file tab inside a gist detail, per gist id — so re-renders
 *  (after an edit) restore the file the user was reading. */
const fileTabByGist = new Map<string, number>();
/** The list page's live search query — survives list ⇄ detail round trips.
 *  One per tab (issue #32; tabState.ts): each tab keeps its own Gists page,
 *  and a shared query was what another tab's page rebuilt with. */
const gistsTab = perTab(() => ({ query: "" }));

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
  const S = gistsTab();
  const refresh = (): void => {
    bust("gist");
    renderGists(wrap, nav);
  };

  const { view, listEl } = sectionList();
  const header = ghHeader(l10n.t("Gists"), gate.login, refresh);
  const tools = el("div", "gh-head-tools");
  const newBtn = el("button", "btn btn-primary gh-new-btn");
  newBtn.append(glyph("add"), span(l10n.t("New gist")));
  newBtn.addEventListener("click", () => void newGist(nav, refresh));
  const verbs = el("div", "gh-head-verbs");
  verbs.appendChild(newBtn);
  tools.append(verbs);
  header.querySelector(".gh-acct")?.before(tools);
  view.append(header, listEl);
  wrap.replaceChildren(view);

  header.querySelector(".gh-head-titlewrap")?.appendChild(
    searchField({
      placeholder: l10n.t("Search gists…"),
      initial: S.query,
      onInput: (q) => {
        S.query = q;
        renderList();
      },
    }),
  );

  let gists: GistInfo[] | undefined = cachePeek("gist:list", undefined);
  if (!gists) listEl.replaceChildren(skeletonList(5));

  const buildRow = (g: GistInfo): HTMLElement => {
    // A gist has no real title — use the description or the first filename.
    const title = g.description || g.files[0]?.filename || l10n.t("Untitled gist");
    // The comment count keeps its column even at zero: dropping the element
    // slid "1 file" 69px between a gist with comments and one without, so the
    // list had no meta columns at all.
    const meta: HTMLElement[] = [
      span(g.fileCount === 1 ? l10n.t("1 file") : l10n.t("{0} files", g.fileCount), "gist-filecount"),
      blankable(statBit("comment", g.comments ?? 0), (g.comments ?? 0) > 0),
    ];
    const lead = el("span", "gh-lead-icon is-accent");
    lead.appendChild(glyph("code"));
    const row = secRow({
      lead,
      title,
      titleSuffix: [
        statePill(g.public ? l10n.t("Public") : l10n.t("Secret"), g.public ? "public" : "private"),
      ],
      meta,
      time: relTimeISO(g.updatedAt),
      timeTitle: g.updatedAt ? l10n.t("Updated {0}", absTimeISO(g.updatedAt)) : undefined,
      ariaLabel: l10n.t("Gist: {0}", title),
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
        emptyState(l10n.t("No gists yet"), l10n.t("Create your first snippet with a new gist."), {
          icon: "code",
          action: { label: l10n.t("New gist"), icon: "add", onClick: () => void newGist(nav, refresh) },
        }),
      );
      return;
    }
    const q = S.query.toLowerCase();
    const items = q ? gists.filter((g) => matches(g, q)) : gists;
    // Same contract as the other lists: the badge counts what is on screen, so
    // it can't read "2" above "No matching gists".
    header.setCount?.(items.length, gists.length);
    if (items.length === 0) {
      listEl.appendChild(
        emptyState(l10n.t("No matching gists"), l10n.t("Nothing matches “{0}”.", S.query), {
          icon: "search",
          anchor: "inline",
        }),
      );
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
        errorState(
          l10n.t("Couldn't load gists"),
          cleanErr(e) || l10n.t("GitHub request failed."),
          refresh,
        ),
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
    backLabel: l10n.t("Gists"),
    pageLabel: l10n.t("Gist"),
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
        errorState(l10n.t("Couldn't load gist"), cleanErr(e) || l10n.t("GitHub request failed."), reload),
      );
      return;
    }
    if (!view.isConnected) return;
    if (!g) {
      main.replaceChildren(
        emptyState(l10n.t("Gist unavailable"), l10n.t("This gist couldn't be loaded.")),
      );
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
  editBtn.append(glyph("edit"), span(l10n.t("Edit")));
  editBtn.addEventListener("click", () => void editGist(g, fileIdx(), reload));
  /** Match the affordance to what Edit will actually do — a live button that
   *  refuses on click is a worse answer than one that says why up front.
   *  Re-run whenever the selected file changes. */
  const syncEditBtn = (): void => {
    const f = g.files[fileIdx()];
    const blocked = !!f?.truncated;
    (editBtn as HTMLButtonElement).disabled = blocked;
    editBtn.title = blocked
      ? l10n.t(
          "GitStudio only received part of {0} — edit it on GitHub",
          f?.filename ?? l10n.t("this file"),
        )
      : l10n.t("Edit this gist");
  };
  syncEditBtn();

  const copyBtn = el("button", "mini-btn");
  copyBtn.append(glyph("copy"), span(l10n.t("Copy raw URL")));
  copyBtn.title = l10n.t("Copy the raw URL of the selected file");
  copyBtn.addEventListener("click", () => {
    const url = g.files[fileIdx()]?.rawUrl;
    if (url) void copyText(url, l10n.t("Raw URL copied."));
    else toast(l10n.t("This file has no raw URL."), "error");
  });

  const moreBtn = el("button", "mini-btn gh-icon-btn");
  moreBtn.append(glyph("ellipsis"));
  moreBtn.title = l10n.t("More actions");
  moreBtn.addEventListener("click", () =>
    openMenu(moreBtn, [
      {
        label: l10n.t("Copy link"),
        icon: "copy",
        onClick: () => void copyText(g.htmlUrl, l10n.t("Copied gist link.")),
      },
      { separator: true },
      { label: l10n.t("Delete gist"), icon: "trash", onClick: () => void deleteGist(g, moreBtn, back) },
    ]),
  );

  const openBtn = el("button", "mini-btn gh-icon-btn");
  openBtn.append(glyph("link-external"));
  openBtn.title = l10n.t("Open this gist on GitHub");
  openBtn.setAttribute("aria-label", openBtn.title);
  openBtn.addEventListener("click", () => window.open(g.htmlUrl, "_blank", "noopener"));

  topActions.replaceChildren(editBtn, copyBtn, moreBtn, openBtn);

  // ── title block ──
  const titleRow = el("div", "det-title-row");
  const h = el("h1", "det-title");
  h.textContent = g.description || g.files[0]?.filename || l10n.t("(no description)");
  titleRow.appendChild(h);
  // After the title, not before it: a leading pill pushed the H1 ~110px right
  // of the page's left rule, so the heading no longer started where every
  // other heading starts.
  titleRow.appendChild(
    statePill(g.public ? l10n.t("Public") : l10n.t("Secret"), g.public ? "public" : "private"),
  );
  main.appendChild(titleRow);

  // No sub-line: it read "updated 2d ago" directly above an About rail whose
  // Updated row says "2d ago". The rail is where a detail page's facts live —
  // repeating one of them under the title is the same fact twice.

  if (g.files.length === 0) {
    main.appendChild(emptyState(l10n.t("Empty gist"), l10n.t("This gist has no files.")));
  } else {
    // ── file tabs + highlighted content ──
    const content = el("div", "gh-subcontent");
    let selectTab: ((i: number) => void) | undefined;

    const renderFile = (idx: number): void => {
      fileTabByGist.set(g.id, idx);
      const f = g.files[idx];
      if (!f) return;
      // Switching tabs changes which file Edit would save, so re-ask.
      syncEditBtn();
      content.replaceChildren();

      const fileHead = el("div", "gist-file-head");
      const name = span(f.filename, "gist-file-name");
      const fileSub = span(
        f.truncated
          ? l10n.t("{0} · {1} · truncated", f.language || f.type || l10n.t("text"), formatBytes(f.size))
          : l10n.t("{0} · {1}", f.language || f.type || l10n.t("text"), formatBytes(f.size)),
        "gist-file-sub",
      );
      fileHead.append(name, fileSub);
      content.appendChild(fileHead);
      content.appendChild(codeBlock(f.content, f.filename, f.truncated));
    };

    if (g.files.length > 1) {
      content.id = "gs-gist-filepanel";
      const tabs = subTabs({
        tabs: g.files.map((f, i) => ({ id: String(i), label: f.filename, icon: "file" })),
        ariaLabel: l10n.t("Files in this gist"),
        panel: content,
        onSelect: (id) => renderFile(Number(id)),
      });
      main.appendChild(tabs.el);
      selectTab = (i: number) => tabs.select(String(i));
    }
    main.appendChild(content);
    if (selectTab) selectTab(fileIdx());
    else renderFile(fileIdx());
  }

  // ── rail ──
  const ownerProp = propSection(l10n.t("Owner"));
  if (g.owner?.login) ownerProp.body.appendChild(personChip(g.owner.login, g.owner.avatarUrl));
  else ownerProp.body.appendChild(span("—", "det-prop-none"));

  const about = propSection(l10n.t("About"));
  about.body.classList.add("det-prop-facts");
  const fact = (k: string, v: string, title?: string): HTMLElement => {
    const row = el("div", "det-fact");
    const val = el("span", "det-fact-v");
    val.textContent = v;
    if (title) val.title = title;
    row.append(span(k, "det-fact-k"), val);
    return row;
  };
  about.body.appendChild(fact(l10n.t("Files"), String(g.fileCount)));
  if (typeof g.comments === "number") about.body.appendChild(fact(l10n.t("Comments"), String(g.comments)));
  about.body.appendChild(fact(l10n.t("Created"), relTimeISO(g.createdAt), absTimeISO(g.createdAt)));
  about.body.appendChild(fact(l10n.t("Updated"), relTimeISO(g.updatedAt), absTimeISO(g.updatedAt)));

  rail.append(ownerProp.root, about.root);
}

/** Render gist code with a line-number gutter + syntax highlighting — the same
 *  .ghfile renderer the remote repo browser uses (the old view was a plain
 *  un-highlighted <pre>). Capped so a giant file can't lock the UI. */
const MAX_RENDER_LINES = 5000;
function codeBlock(text: string, fileName: string, truncated: boolean): HTMLElement {
  const lines = fileLines(text);
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
      ? l10n.t("GitHub truncated this file — open it on GitHub for the full content.")
      : l10n.t(
          "Showing the first {0} of {1} lines.",
          MAX_RENDER_LINES.toLocaleString(),
          lines.length.toLocaleString(),
        );
    const outer = el("div", "ghfile-outer");
    outer.append(wrap, more);
    return outer;
  }
  return wrap;
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return l10n.t("0 bytes");
  if (n === 1) return l10n.t("1 byte");
  if (n < 1024) return l10n.t("{0} bytes", n);
  if (n < 1024 * 1024) return l10n.t("{0} KB", (n / 1024).toFixed(1));
  return l10n.t("{0} MB", (n / (1024 * 1024)).toFixed(1));
}

// ── Mutations ────────────────────────────────────────────────────────────────

async function newGist(nav: SectionNav, refresh: () => void): Promise<void> {
  // The form closed before the request was even sent, so a rejected create
  // answered a whole file of typing with a toast over an empty screen.
  await formWithRetry<GistDialogResult>(
    (seed, error) =>
      gistDialog({
        title: l10n.t("New gist"),
        okLabel: l10n.t("Create gist"),
        description: seed?.description,
        filename: seed?.filename,
        content: seed?.content,
        public: seed?.public,
        error,
      }),
    async (v) => {
      try {
        const r = await host.invoke("gist:create", {
          description: v.description,
          filename: v.filename,
          content: v.content,
          public: v.public,
        });
        if (!r.ok) return r.message || l10n.t("Couldn't create the gist.");
        toast(l10n.t("Gist created."), "success");
        bust("gist");
        // The created id comes back in `message` — open the new gist directly.
        if (r.message) nav("gists", { id: r.message });
        else refresh();
        return undefined;
      } catch (e) {
        return cleanErr(e) || l10n.t("Couldn't create the gist.");
      }
    },
  );
}

async function editGist(g: GistInfo, fileIdx: number, reload: () => void): Promise<void> {
  const file = g.files[fileIdx] ?? g.files[0];
  if (!file) return;
  // GitHub only sends the first megabyte of a large gist file, and the view
  // already SAYS so ("GitHub truncated this file"). Editing loaded that partial
  // text into the box and saved it back as the whole file, so opening a big
  // gist and pressing Save — changing nothing — silently deleted everything
  // past the truncation point. The one place that knows is here.
  if (file.truncated) {
    toast(
      l10n.t(
        "GitStudio only received part of {0}. Edit it on GitHub so the rest isn't overwritten.",
        file.filename,
      ),
      "error",
    );
    return;
  }
  await formWithRetry<GistDialogResult>(
    (seed, error) =>
      gistDialog({
        title: l10n.t("Edit gist"),
        okLabel: l10n.t("Save changes"),
        description: seed?.description ?? g.description,
        filename: seed?.filename ?? file.filename,
        content: seed?.content ?? file.content,
        public: g.public,
        lockVisibility: true, // GitHub can't flip public↔secret on an existing gist
        error,
      }),
    async (v) => {
      try {
        const r = await host.invoke("gist:update", {
          id: g.id,
          description: v.description,
          filename: file.filename, // current name = the API key
          content: v.content,
          newFilename: v.filename, // rename when changed
        });
        if (!r.ok) return r.message || l10n.t("Couldn't save the gist.");
        toast(l10n.t("Gist saved."), "success");
        reload();
        return undefined;
      } catch (e) {
        return cleanErr(e) || l10n.t("Couldn't save the gist.");
      }
    },
  );
}

async function deleteGist(g: GistInfo, btn: HTMLElement, back: () => void): Promise<void> {
  const ok = await confirmDialog({
    title: l10n.t("Delete this gist?"),
    message: l10n.t(
      "“{0}” will be permanently deleted on GitHub. This can't be undone.",
      g.description || g.files[0]?.filename || g.id,
    ),
    confirmLabel: l10n.t("Delete"),
    danger: true,
  });
  if (!ok) return;
  (btn as HTMLButtonElement).disabled = true;
  try {
    const r = await host.invoke("gist:delete", g.id);
    if (!r.ok) {
      toast(r.message || l10n.t("Couldn't delete the gist."), "error");
      (btn as HTMLButtonElement).disabled = false;
      return;
    }
    toast(l10n.t("Gist deleted."), "success");
    bust("gist");
    back(); // the detail's subject no longer exists — land on the list
  } catch (e) {
    (btn as HTMLButtonElement).disabled = false;
    toast(cleanErr(e) || l10n.t("Couldn't delete the gist."), "error");
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
  /** Why the previous attempt failed, shown inside the form that still holds
   *  the text. See `formWithRetry`. */
  error?: string;
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
      descIn.placeholder = l10n.t("Description (optional)");
      descIn.value = opts.description ?? "";

      const fileIn = document.createElement("input");
      fileIn.className = "modal-input";
      fileIn.placeholder = l10n.t("Filename including extension…");
      fileIn.value = opts.filename ?? "";
      fileIn.spellcheck = false;
      fileIn.autocapitalize = "off";

      const contentIn = document.createElement("textarea");
      contentIn.className = "modal-input gist-textarea";
      contentIn.placeholder = l10n.t("Gist content…");
      contentIn.value = opts.content ?? "";
      contentIn.spellcheck = false;

      const visRow = el("label", "gist-visibility");
      const vis = document.createElement("input");
      vis.type = "checkbox";
      vis.checked = opts.public ?? false;
      if (opts.lockVisibility) {
        vis.disabled = true;
        visRow.title = l10n.t("A gist's visibility can't be changed after it's created.");
      }
      const visLabel = span(vis.checked ? l10n.t("Public gist") : l10n.t("Secret gist"));
      visRow.append(vis, visLabel);
      if (!opts.lockVisibility) {
        vis.addEventListener("change", () => {
          visLabel.textContent = vis.checked ? l10n.t("Public gist") : l10n.t("Secret gist");
        });
      }

      const actions = el("div", "modal-actions");
      const cancel = el("button", "mini-btn");
      cancel.textContent = l10n.t("Cancel");
      const ok = el("button", "btn btn-primary modal-ok");
      ok.appendChild(span(opts.okLabel));
      actions.append(cancel, ok);

      card.append(heading, descIn, fileIn, contentIn, visRow);
      if (opts.error) {
        const note = el("div", "modal-note-error");
        note.textContent = opts.error;
        card.appendChild(note);
      }
      card.appendChild(actions);

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
        // A BACKGROUND teardown — a route change, and a window focus routes —
        // must not take a file someone is typing. Esc, the backdrop and Cancel
        // are unaffected: those are the user asking. `formWithRetry` gives the
        // text back after a failed SUBMIT; this is the other half.
        // On a RETRY the opts ARE the failed values (formWithRetry seeds
        // them back), so comparing against them says "nothing unsaved" and a
        // background refocus eats the file — same hole as the review modal:
        // after a failed submit, any content at all is unsaved.
        hasUnsavedWork: () =>
          (opts.error !== undefined && (contentIn.value.trim() !== "" || fileIn.value.trim() !== "")) ||
          descIn.value !== (opts.description ?? "") ||
          fileIn.value !== (opts.filename ?? "") ||
          contentIn.value !== (opts.content ?? ""),
        onClose: () => {
          if (!settled) resolve(null);
        },
      };
    });
  });
}
