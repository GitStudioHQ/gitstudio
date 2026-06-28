// GitHub Releases — the section view. A two-pane (list + detail) surface mirroring
// the PR / Issue views: the left pane toggles between Releases and raw git Tags;
// the right pane shows a release's rendered notes, assets, tag/target/dates, and
// Edit / Delete / Open actions. Full CRUD: New release, Edit, Delete (confirmed),
// and "cut a release from a tag" by clicking a tag row.
//
// The module is self-contained per the section contract: it gates first, renders
// into the handed `wrap`, and re-renders by calling itself. The multi-field
// release form is a local modal (dialogs.ts only exports a single-field prompt),
// built on the shared .modal-* CSS so it matches the rest of the app.

import { host } from "../bridge";
import {
  el,
  span,
  glyph,
  pill,
  relTimeISO,
  absTimeISO,
  loadingState,
  skeletonList,
  errorState,
  emptyState,
  cleanErr,
  groupLabel,
  ghRow,
  statBit,
  statePill,
  labelChip,
} from "../ui";
import { toast, confirmDialog } from "../dialogs";
import { renderMarkdown } from "../markdown";
import { ghGate, ghHeader, type SectionRender } from "./common";
import type { ReleaseInfo, ReleaseInput, TagInfo } from "../../shared/ipc";

/** Which sub-list the left pane is showing. Module-scoped so it survives a re-render. */
let releaseTab: "releases" | "tags" = "releases";

/** Human file size for release assets. */
function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
}

export const renderReleases: SectionRender = (wrap, nav) => {
  void mount(wrap, nav);
};

async function mount(wrap: HTMLElement, nav: (view: string) => void): Promise<void> {
  const refresh = (): void => renderReleases(wrap, nav);

  const gate = await ghGate(wrap, nav, true);
  if (!gate) return;

  const view = el("div", "gh-view");

  // Header: title + @login + refresh, with a Releases|Tags segment and a
  // "New release" action injected into its right-hand cluster.
  const header = ghHeader("Releases", gate.login, refresh);
  const acct = header.querySelector(".gh-acct");
  if (acct instanceof HTMLElement) {
    const seg = el("div", "gh-seg");
    const relBtn = el("button", "gh-seg-btn");
    relBtn.textContent = "Releases";
    relBtn.classList.toggle("active", releaseTab === "releases");
    relBtn.addEventListener("click", () => {
      releaseTab = "releases";
      refresh();
    });
    const tagBtn = el("button", "gh-seg-btn");
    tagBtn.textContent = "Tags";
    tagBtn.classList.toggle("active", releaseTab === "tags");
    tagBtn.addEventListener("click", () => {
      releaseTab = "tags";
      refresh();
    });
    seg.append(relBtn, tagBtn);

    const newBtn = el("button", "mini-btn");
    newBtn.append(glyph("plus"), span("New release"));
    newBtn.title = "Draft a new release";
    newBtn.addEventListener("click", () => void createRelease(refresh, ""));

    acct.prepend(seg, newBtn);
  }
  view.appendChild(header);

  const body = el("div", "gh-body");
  const listEl = el("div", "gh-list");
  const detail = el("div", "gh-detail");
  body.append(listEl, detail);
  view.appendChild(body);
  wrap.replaceChildren(view);

  if (releaseTab === "tags") {
    detail.replaceChildren(
      emptyState(
        "Tags",
        "Every git tag in this repository. Cut a release from one with “New release”.",
        { icon: "tag", hint: "Tip: click a tag to draft a release from it." },
      ),
    );
    await loadTags(listEl, header, refresh, nav);
    return;
  }

  await loadReleases(listEl, detail, header, refresh, nav);
}

// ── The Releases list (left pane) ──

async function loadReleases(
  listEl: HTMLElement,
  detail: HTMLElement,
  header: HTMLElement & { setCount?: (n: number) => void },
  refresh: () => void,
  nav: (view: string) => void,
): Promise<void> {
  detail.replaceChildren(
    emptyState("Releases", "Select a release to read its notes, browse assets, and inspect the tag.", {
      icon: "tag",
      hint: "Tip: open one to edit, delete, or download its assets.",
    }),
  );
  listEl.replaceChildren(skeletonList(5));

  let releases: ReleaseInfo[];
  try {
    releases = await host.invoke("release:list", undefined);
  } catch (e) {
    listEl.replaceChildren(
      errorState("Couldn't load releases", cleanErr(e) || "GitHub request failed.", refresh),
    );
    return;
  }

  header.setCount?.(releases.length);
  listEl.replaceChildren();
  if (releases.length === 0) {
    listEl.appendChild(
      emptyState("No releases yet", "Publish your first release to share builds and notes.", {
        icon: "tag",
        action: { label: "New release", icon: "plus", onClick: () => void createRelease(refresh, "") },
      }),
    );
    return;
  }

  const select = (rel: ReleaseInfo, row: HTMLElement): void => {
    listEl.querySelectorAll(".gh-row.active").forEach((n) => n.classList.remove("active"));
    row.classList.add("active");
    void showReleaseDetail(detail, rel, refresh);
  };

  // "Latest" marks the first non-draft (published) release, mirroring github.com.
  let latestMarked = false;
  releases.forEach((rel, i) => {
    const lead = el("span", "gh-lead-icon gh-lead-merged");
    lead.appendChild(glyph("tag"));

    const suffix: HTMLElement[] = [];
    if (rel.prerelease) suffix.push(statePill("Pre-release", "draft"));
    if (!rel.draft && !latestMarked) {
      suffix.push(labelChip("Latest", "1f883d"));
      latestMarked = true;
    }

    const when = rel.publishedAt ? `published ${relTimeISO(rel.publishedAt)}` : "draft";
    const author = rel.author?.login ? ` · ${rel.author.login}` : "";

    const stats: HTMLElement[] = [];
    if (rel.assets.length) stats.push(statBit("file", rel.assets.length));
    const downloads = rel.assets.reduce((sum, a) => sum + (a.downloadCount || 0), 0);
    if (downloads > 0) stats.push(statBit("cloud-download", downloads));

    const row = ghRow({
      lead,
      title: rel.name || rel.tagName,
      titleSuffix: suffix,
      meta: `${rel.tagName} · ${when}${author}`,
      metaTitle: rel.publishedAt ? `Published ${absTimeISO(rel.publishedAt)}` : undefined,
      stats,
      ariaLabel: `Release ${rel.name || rel.tagName}`,
    });
    row.addEventListener("click", () => select(rel, row));
    listEl.appendChild(row);
    if (i === 0) select(rel, row); // auto-select the first release so the detail isn't a void
  });
  void nav; // nav reserved for symmetry with the tags loader
}

// ── The Tags sub-list (left pane) ──

async function loadTags(
  listEl: HTMLElement,
  header: HTMLElement & { setCount?: (n: number) => void },
  refresh: () => void,
  nav: (view: string) => void,
): Promise<void> {
  listEl.replaceChildren(skeletonList(5));

  let tags: TagInfo[];
  try {
    tags = await host.invoke("release:tags", undefined);
  } catch (e) {
    listEl.replaceChildren(
      errorState("Couldn't load tags", cleanErr(e) || "GitHub request failed.", refresh),
    );
    return;
  }

  header.setCount?.(tags.length);
  listEl.replaceChildren();
  if (tags.length === 0) {
    listEl.appendChild(
      emptyState("No tags", "This repository has no git tags yet.", { icon: "tag" }),
    );
    return;
  }

  for (const t of tags) {
    const row = el("button", "gh-row");
    const top = el("div", "gh-row-title");
    top.append(glyph("tag"), span(t.name));
    const sub = el("div", "gh-row-sub");
    sub.textContent = t.sha.slice(0, 7);
    row.append(top, sub);
    row.title = `Draft a release from ${t.name}`;
    // A tag row drafts a release from that tag (prefilled).
    row.addEventListener("click", () => void createRelease(refresh, t.name));
    listEl.appendChild(row);
  }
  void nav;
}

// ── The detail (right pane) ──

async function showReleaseDetail(
  detail: HTMLElement,
  rel: ReleaseInfo,
  refresh: () => void,
): Promise<void> {
  detail.replaceChildren(loadingState());

  // Refetch the single release so body/assets are guaranteed complete; fall back
  // to the list-row data if the detail fetch fails so the pane never blanks.
  let full: ReleaseInfo;
  try {
    full = (await host.invoke("release:detail", rel.id)) ?? rel;
  } catch {
    full = rel;
  }
  detail.replaceChildren();

  const head = el("div", "gh-detail-head");
  const h = el("div", "gh-detail-title");
  h.textContent = full.name || full.tagName;

  const meta = el("div", "gh-detail-meta");
  const when = full.publishedAt
    ? `published ${relTimeISO(full.publishedAt)}`
    : "unpublished draft";
  const target = full.targetCommitish ? ` ← ${full.targetCommitish}` : "";
  const author = full.author?.login ? ` · ${full.author.login}` : "";
  meta.textContent = `${full.tagName}${target}${author} · ${when}`;
  if (full.draft) {
    meta.appendChild(document.createTextNode("  "));
    meta.appendChild(pill("Draft"));
  }
  if (full.prerelease) {
    meta.appendChild(document.createTextNode("  "));
    meta.appendChild(pill("Pre-release"));
  }

  const actions = el("div", "gh-detail-actions");
  const editBtn = el("button", "mini-btn");
  editBtn.append(glyph("pencil"), span("Edit"));
  editBtn.title = "Edit this release";
  editBtn.addEventListener("click", () => void editRelease(full, detail, refresh));

  const delBtn = el("button", "mini-btn danger");
  delBtn.append(glyph("trash"), span("Delete"));
  delBtn.title = "Delete this release";
  delBtn.addEventListener("click", () => void deleteRelease(full, delBtn, refresh));

  const openBtn = el("button", "mini-btn");
  openBtn.append(glyph("link-external"), span("Open on GitHub"));
  openBtn.title = "Open this release on github.com";
  openBtn.addEventListener("click", () => window.open(full.htmlUrl, "_blank"));

  actions.append(editBtn, delBtn, openBtn);
  head.append(h, meta, actions);
  detail.appendChild(head);

  // Notes — rendered markdown (renderMarkdown sanitizes/escapes, so innerHTML is
  // the intended path here, matching the commit-body renderer).
  if (full.body && full.body.trim()) {
    const notes = el("div", "gh-body-md");
    notes.innerHTML = renderMarkdown(full.body);
    detail.appendChild(notes);
  } else {
    detail.appendChild(emptyState("No release notes", "This release has no description."));
  }

  // Assets table.
  if (full.assets.length) {
    detail.appendChild(groupLabel(`Assets (${full.assets.length})`));
    const list = el("div", "rel-assets");
    for (const a of full.assets) {
      const row = el("button", "list-row");
      row.appendChild(glyph("package"));
      const m = el("div", "row-meta");
      const t = el("div", "row-meta-title");
      t.textContent = a.label || a.name;
      const sub = el("div", "row-meta-sub");
      sub.textContent = `${fmtBytes(a.size)} · ${a.downloadCount} download${a.downloadCount === 1 ? "" : "s"}`;
      m.append(t, sub);
      const dl = el("span", "gh-adds");
      dl.appendChild(glyph("cloud-download"));
      row.append(m, dl);
      row.title = `Download ${a.name}`;
      row.addEventListener("click", () => window.open(a.downloadUrl, "_blank"));
      list.appendChild(row);
    }
    detail.appendChild(list);
  }
}

// ── CRUD actions ──

/** Draft a new release; `prefillTag` comes from a Tags-row click. */
async function createRelease(refresh: () => void, prefillTag: string): Promise<void> {
  const input = await releaseFormDialog("New release", {
    tagName: prefillTag,
    targetCommitish: "",
    name: "",
    body: "",
    draft: false,
    prerelease: false,
  });
  if (!input) return;
  try {
    const r = await host.invoke("release:create", input);
    if (!r.ok) {
      toast(r.message ?? "Couldn't create the release.", "error");
      return;
    }
    toast(`Created release ${input.tagName}.`, "success");
    releaseTab = "releases";
    refresh();
  } catch (e) {
    toast(cleanErr(e) || "Couldn't create the release.", "error");
  }
}

async function editRelease(
  rel: ReleaseInfo,
  detail: HTMLElement,
  refresh: () => void,
): Promise<void> {
  const input = await releaseFormDialog("Edit release", {
    id: rel.id,
    tagName: rel.tagName,
    targetCommitish: rel.targetCommitish,
    name: rel.name,
    body: rel.body ?? "",
    draft: rel.draft,
    prerelease: rel.prerelease,
  });
  if (!input) return;
  try {
    const r = await host.invoke("release:update", input);
    if (!r.ok) {
      toast(r.message ?? "Couldn't update the release.", "error");
      return;
    }
    toast(`Updated release ${input.tagName}.`, "success");
    refresh();
    void showReleaseDetail(detail, rel, refresh); // keep the detail open with fresh data
  } catch (e) {
    toast(cleanErr(e) || "Couldn't update the release.", "error");
  }
}

async function deleteRelease(
  rel: ReleaseInfo,
  btn: HTMLElement,
  refresh: () => void,
): Promise<void> {
  const ok = await confirmDialog({
    title: `Delete release ${rel.name || rel.tagName}?`,
    message: `This permanently deletes the release on GitHub. The git tag ${rel.tagName} is not removed. This can't be undone.`,
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  (btn as HTMLButtonElement).disabled = true;
  try {
    const r = await host.invoke("release:delete", rel.id);
    if (!r.ok) {
      toast(r.message ?? "Couldn't delete the release.", "error");
      return;
    }
    toast(`Deleted release ${rel.name || rel.tagName}.`, "success");
    refresh();
  } catch (e) {
    toast(cleanErr(e) || "Couldn't delete the release.", "error");
  } finally {
    (btn as HTMLButtonElement).disabled = false;
  }
}

// ── The multi-field release form dialog ──
//
// dialogs.ts keeps its `modal()` scaffold private and only exports the
// single-field promptInline, so this section ships its own modal. It reuses the
// shared .modal-overlay / .modal-* CSS, traps focus, closes on Esc / backdrop /
// Cancel, and submits on the primary button or ⌘/Ctrl+Enter.

function mkDialogEl(tag: string, cls = ""): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
}

function releaseFormDialog(title: string, init: ReleaseInput): Promise<ReleaseInput | null> {
  return new Promise((resolve) => {
    let settled = false;
    const prevFocus = document.activeElement as HTMLElement | null;
    const overlay = mkDialogEl("div", "modal-overlay");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");

    const finish = (value: ReleaseInput | null): void => {
      if (settled) return;
      settled = true;
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
      prevFocus?.focus?.();
      resolve(value);
    };

    const card = mkDialogEl("div", "modal-card modal-form");
    const h = mkDialogEl("div", "modal-title");
    h.textContent = title;

    const field = (label: string, ctrl: HTMLElement): HTMLElement => {
      const f = mkDialogEl("label", "modal-field");
      const l = mkDialogEl("span", "modal-field-label");
      l.textContent = label;
      f.append(l, ctrl);
      return f;
    };

    const tag = document.createElement("input");
    tag.className = "modal-input";
    tag.placeholder = "v1.0.0";
    tag.value = init.tagName ?? "";

    const target = document.createElement("input");
    target.className = "modal-input";
    target.placeholder = "main (target branch or commit)";
    target.value = init.targetCommitish ?? "";

    const name = document.createElement("input");
    name.className = "modal-input";
    name.placeholder = "Release title";
    name.value = init.name ?? "";

    const bodyInput = document.createElement("textarea");
    bodyInput.className = "modal-input modal-textarea";
    bodyInput.rows = 6;
    bodyInput.placeholder = "Release notes (Markdown supported)…";
    bodyInput.value = init.body ?? "";

    const draft = document.createElement("input");
    draft.type = "checkbox";
    draft.checked = !!init.draft;
    const pre = document.createElement("input");
    pre.type = "checkbox";
    pre.checked = !!init.prerelease;

    const checks = mkDialogEl("div", "modal-checks");
    const checkWrap = (cb: HTMLInputElement, text: string): HTMLElement => {
      const w = mkDialogEl("label", "modal-check");
      const t = mkDialogEl("span");
      t.textContent = text;
      w.append(cb, t);
      return w;
    };
    checks.append(
      checkWrap(draft, "Draft (don't publish yet)"),
      checkWrap(pre, "Pre-release"),
    );

    const actions = mkDialogEl("div", "modal-actions");
    const cancel = mkDialogEl("button", "mini-btn");
    cancel.textContent = "Cancel";
    const ok = mkDialogEl("button", "btn btn-primary modal-ok");
    const okSpan = mkDialogEl("span");
    okSpan.textContent = init.id === undefined ? "Create" : "Save";
    ok.appendChild(okSpan);
    actions.append(cancel, ok);

    card.append(
      h,
      field("Tag", tag),
      field("Target", target),
      field("Title", name),
      field("Notes", bodyInput),
      checks,
      actions,
    );

    const submit = (): void => {
      const tagName = tag.value.trim();
      if (!tagName) {
        tag.focus();
        return;
      }
      finish({
        id: init.id,
        tagName,
        targetCommitish: target.value.trim() || undefined,
        name: name.value.trim(),
        body: bodyInput.value,
        draft: draft.checked,
        prerelease: pre.checked,
      });
    };

    cancel.addEventListener("click", () => finish(null));
    ok.addEventListener("click", submit);
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) finish(null);
    });
    // ⌘/Ctrl+Enter submits from anywhere in the form (textarea included).
    card.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(null);
        return;
      }
      if (e.key !== "Tab") return;
      const focusables = Array.from(
        card.querySelectorAll<HTMLElement>(
          "button, input, textarea, [tabindex]:not([tabindex='-1'])",
        ),
      ).filter((n) => !n.hasAttribute("disabled"));
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
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
    document.addEventListener("keydown", onKey, true);
    setTimeout(() => tag.focus(), 0);
  });
}
