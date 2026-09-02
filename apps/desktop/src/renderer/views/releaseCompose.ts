// Writing a release, as a PAGE.
//
// It used to be a modal: a 560px card holding a tag field, a target field, a
// title, a ten-row notes box and two buttons, with the notes — the only part
// anyone spends time on — getting about 180px of it.
//
// The owner's report was blunt: "editing a release is still complete garbage
// compared to github ui ux, look https://github.com/GitStudioHQ/gitstudio/
// releases/new", and "same is for publishing releases."
//
// So this is that page, and then the parts GitHub has that the modal never
// could: the tag is a combobox over the repository's real tags that says
// out loud when it will CREATE one, the target is a real ref picker, the notes
// fill the window with Write/Preview, "Generate release notes" asks GitHub for
// the changelog it would have written, "Set as the latest release" is finally
// askable, and publish-vs-draft is two named buttons rather than a checkbox.

import { host } from "../bridge";
import { el, span, glyph, cleanErr, errorState, skeletonList } from "../ui";
import { toast } from "../dialogs";
import { detailPage, comboField, type SectionTarget, type SectionNav } from "./common";
import { mdEditor } from "../mdEditor";
import { wireDraft } from "../draftStore";
import { setPageLabel } from "../navStack";
import { bust } from "../cache";
import type { ReleaseInfo, ReleaseInput } from "../../shared/ipc";

/** Branch and tag names for the two pickers. */
async function refOptions(): Promise<{ branches: string[]; tags: string[] }> {
  try {
    const refs = await host.invoke("refs:list", undefined);
    const branches = new Set<string>();
    const tags = new Set<string>();
    for (const r of refs) {
      if (r.type === "head") branches.add(r.name);
      else if (r.type === "remote") {
        const short = r.name.replace(/^[^/]+\//, "");
        if (short && short !== "HEAD") branches.add(short);
      } else if (r.type === "tag") tags.add(r.name);
    }
    const cmp = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });
    return { branches: [...branches].sort(cmp), tags: [...tags].sort(cmp).reverse() };
  } catch {
    return { branches: [], tags: [] };
  }
}

async function defaultTarget(): Promise<string> {
  try {
    const head = await host.invoke("head:get", undefined);
    if (head && !head.detached && head.branch) return head.branch;
  } catch {
    /* not a repo yet — the placeholder says "main", GitHub decides */
  }
  return "";
}

/**
 * The composer.
 *
 * `target.number` is a release id to EDIT; without one this composes a new
 * release, and `target.ref` pre-fills the tag (how "Draft a release" from a tag
 * row arrives).
 */
export async function renderReleaseCompose(
  wrap: HTMLElement,
  nav: SectionNav,
  target: SectionTarget | undefined,
): Promise<void> {
  const editId = target?.number;
  const { view, main, rail, topActions } = detailPage({
    backLabel: "Releases",
    crumb: editId ? "Edit release" : "New release",
    pageLabel: editId ? "Edit release" : "New release",
    onBack: () => nav("releases", { list: true }),
  });
  view.classList.add("relc-view");
  rail.remove();
  topActions.remove();
  wrap.replaceChildren(view);
  main.appendChild(skeletonList(4, false));

  let existing: ReleaseInfo | undefined;
  if (editId != null) {
    try {
      existing = await host.invoke("release:detail", editId);
    } catch (e) {
      if (!view.isConnected) return;
      main.replaceChildren(
        errorState("Couldn't load this release", cleanErr(e) || "GitHub request failed.", () =>
          void renderReleaseCompose(wrap, nav, target),
        ),
      );
      return;
    }
    if (!view.isConnected) return;
    if (!existing) {
      main.replaceChildren(
        errorState("Release unavailable", "This release couldn't be read from GitHub."),
      );
      return;
    }
  }

  const [{ branches, tags }, headBranch, remoteTags] = await Promise.all([
    refOptions(),
    defaultTarget(),
    // The LOCAL refs are not the whole truth: a tag pushed from CI, or one made
    // on github.com, exists on the remote and not in this clone — and calling
    // it "new" would promise to create a tag that is already there.
    host.invoke("release:tags", undefined).catch(() => []),
  ]);
  if (!view.isConnected) return;

  // Which release holds the "Latest" badge right now — the newest published,
  // non-pre-release one, exactly as the list computes it. Read here so editing
  // a release can leave the badge alone by default; a failed read is treated as
  // "not this one", which is the safe direction (the badge does not move).
  let isCurrentlyLatest = false;
  if (existing) {
    try {
      const all = await host.invoke("release:list", undefined);
      isCurrentlyLatest = all.find((r) => !r.draft && !r.prerelease)?.id === existing.id;
    } catch {
      isCurrentlyLatest = false;
    }
    if (!view.isConnected) return;
  }

  const knownTags = new Set([...tags, ...remoteTags.map((t) => t.name)]);
  const tagOptions = [...knownTags].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const init: ReleaseInput = existing
    ? {
        id: existing.id,
        tagName: existing.tagName,
        targetCommitish: existing.targetCommitish,
        name: existing.name,
        body: existing.body ?? "",
        draft: existing.draft,
        prerelease: existing.prerelease,
      }
    : {
        tagName: target?.ref ?? "",
        targetCommitish: "",
        name: "",
        body: "",
        draft: false,
        prerelease: false,
      };

  const form = el("div", "relc-form");
  main.replaceChildren(form);

  // ── the two refs ──────────────────────────────────────────────────────────
  const refRow = el("div", "relc-refs");
  const tagField = comboField({
    label: "Tag",
    placeholder: "v1.0.0",
    value: init.tagName,
    options: tagOptions,
    rowClass: "relc-field",
    labelClass: "relc-label",
    inputClass: "relc-input",
  });
  const targetField = comboField({
    label: "Target",
    placeholder: headBranch || "main",
    value: init.targetCommitish ?? "",
    options: branches,
    rowClass: "relc-field",
    labelClass: "relc-label",
    inputClass: "relc-input",
  });
  refRow.append(tagField.row, targetField.row);
  form.appendChild(refRow);

  // Saying which of the two things a tag name means. GitHub's composer does,
  // and it is the difference between "I am releasing the tag I cut" and "I am
  // about to create a tag on whatever Target says" — which nothing else on the
  // form tells you, and which is not undoable from here.
  const tagNote = el("div", "relc-note");
  form.appendChild(tagNote);
  const syncTagNote = (): void => {
    const t = tagField.input.value.trim();
    if (!t) {
      tagNote.textContent = "";
      tagNote.className = "relc-note";
      return;
    }
    if (existing && t === existing.tagName) {
      tagNote.className = "relc-note is-known";
      tagNote.textContent = `This release points at ${t}.`;
    } else if (knownTags.has(t)) {
      tagNote.className = "relc-note is-known";
      tagNote.textContent = `Existing tag — this release will point at ${t}.`;
    } else {
      tagNote.className = "relc-note is-new";
      const at = targetField.input.value.trim() || headBranch || "the default branch";
      tagNote.textContent = `New tag — GitHub will create ${t} from ${at} when you publish.`;
    }
  };
  tagField.input.addEventListener("input", syncTagNote);
  targetField.input.addEventListener("input", syncTagNote);
  syncTagNote();

  // ── title ─────────────────────────────────────────────────────────────────
  const titleField = el("div", "relc-field relc-field-wide");
  const titleLabel = el("label", "relc-label");
  titleLabel.textContent = "Title";
  const title = document.createElement("input");
  title.className = "relc-input relc-title";
  title.placeholder = "Release title";
  title.value = init.name ?? "";
  title.id = "relc-title";
  (titleLabel as HTMLLabelElement).htmlFor = title.id;
  titleField.append(titleLabel, title);
  form.appendChild(titleField);

  // ── notes ─────────────────────────────────────────────────────────────────
  const notesHead = el("div", "relc-notes-head");
  const notesLabel = el("span", "relc-label");
  notesLabel.textContent = "Notes";
  const genBtn = el("button", "mini-btn relc-gen") as HTMLButtonElement;
  genBtn.append(glyph("sparkle"), span("Generate release notes"));
  genBtn.title = "Ask GitHub for the changelog it would write from the merged pull requests";
  notesHead.append(notesLabel, genBtn);
  form.appendChild(notesHead);

  const draftId = init.id === undefined ? "new" : String(init.id);
  // The tag and the title are drafted alongside the notes. Leaving used to keep
  // the paragraph and lose the two lines above it, which is the half of a
  // half-written release you cannot reconstruct from memory.
  const headDraft = wireDraft("release-head", draftId, (t) => {
    try {
      const saved = JSON.parse(t) as { tag?: string; title?: string };
      if (!init.tagName && !tagField.input.value && saved.tag) tagField.input.value = saved.tag;
      if (!init.name && !title.value && saved.title) title.value = saved.title;
      syncTagNote();
    } catch {
      /* a draft we cannot read is a draft we ignore */
    }
  });
  const saveHead = (): void =>
    headDraft.save(JSON.stringify({ tag: tagField.input.value, title: title.value }));
  tagField.input.addEventListener("input", saveHead);
  title.addEventListener("input", saveHead);

  const notes = mdEditor({
    value: init.body ?? "",
    placeholder: "Describe this release. Markdown is supported — and “Generate release notes” writes a first draft from the merged pull requests.",
    fill: true,
    label: "Release notes",
    onInput: (v) => notesDraft.save(v),
    onSubmit: () => publishBtn.click(),
  });
  // Only over an EMPTY field: a local draft must never silently replace notes
  // GitHub already has, which would read as the app rewriting a published
  // release behind your back.
  const notesDraft = wireDraft("release", draftId, (text) => {
    if (!init.body) notes.set(text);
  });
  form.appendChild(notes.root);

  genBtn.addEventListener("click", () => {
    const tagName = tagField.input.value.trim();
    if (!tagName) {
      showError("A tag is needed first — the notes are the changes since the previous one.");
      tagField.input.focus();
      return;
    }
    const had = notes.get().trim();
    genBtn.disabled = true;
    const label = genBtn.querySelector("span");
    if (label) label.textContent = "Asking GitHub…";
    void host
      .invoke("release:generateNotes", {
        tagName,
        targetCommitish: targetField.input.value.trim() || undefined,
      })
      .then((g) => {
        // Never over the top of writing someone already did: append below it,
        // and let them delete what they don't want.
        notes.set(had ? `${had}\n\n${g.body}` : g.body);
        if (!title.value.trim() && g.name) title.value = g.name;
        notesDraft.save(notes.get());
        toast("Release notes generated from GitHub.", "success");
      })
      .catch((e) => {
        showError(cleanErr(e) || "GitHub couldn't generate notes for this tag.");
      })
      .finally(() => {
        genBtn.disabled = false;
        if (label) label.textContent = "Generate release notes";
      });
  });

  // ── attributes ────────────────────────────────────────────────────────────
  const attrs = el("div", "relc-attrs");
  const check = (labelText: string, hint: string, on: boolean): { row: HTMLElement; input: HTMLInputElement } => {
    const row = el("label", "relc-check");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = on;
    const txt = el("span", "relc-check-text");
    txt.appendChild(span(labelText, "relc-check-label"));
    txt.appendChild(span(hint, "relc-check-hint"));
    row.append(input, txt);
    return { row, input };
  };
  const pre = check(
    "Set as a pre-release",
    "Marked as not production-ready. It never becomes the latest release.",
    !!init.prerelease,
  );
  // NOT `!init.prerelease`. That pre-ticked the box for every published
  // non-pre-release, so opening an OLD release to fix a typo in its notes and
  // pressing Save moved the repository's "Latest" badge onto it — silently,
  // outward, and visible to everyone reading the repo. Editing a release must
  // default to leaving that badge exactly where it is.
  //
  // The rule is github.com's own, and the same one the list uses: the newest
  // published, non-pre-release release holds it.
  const latest = check(
    "Set as the latest release",
    "Moves the repository's “Latest” badge onto this release.",
    init.id === undefined ? !init.prerelease : isCurrentlyLatest,
  );
  attrs.append(pre.row, latest.row);
  form.appendChild(attrs);
  // A pre-release cannot also be the latest release — GitHub refuses it, and a
  // form that lets you ask for both just turns into an error after the fact.
  const syncLatest = (): void => {
    latest.input.disabled = pre.input.checked;
    if (pre.input.checked) latest.input.checked = false;
    latest.row.classList.toggle("is-off", pre.input.checked);
    latest.row.title = pre.input.checked ? "A pre-release is never the latest release" : "";
  };
  pre.input.addEventListener("change", syncLatest);
  syncLatest();

  // ── errors + actions ──────────────────────────────────────────────────────
  const note = el("div", "relc-error");
  note.setAttribute("role", "alert");
  note.hidden = true;
  form.appendChild(note);
  function showError(msg: string): void {
    note.hidden = false;
    note.textContent = msg;
    note.scrollIntoView({ block: "nearest" });
  }

  const bar = el("div", "relc-actions");
  const cancel = el("button", "mini-btn") as HTMLButtonElement;
  cancel.textContent = "Cancel";
  // Back to the release you were editing, not to the list — which is where the
  // ← button and Escape both go, and where Save lands you. Three exits from one
  // page were doing two different things, and the visible one was the odd one
  // out: it threw away your place in a list you may have scrolled a long way
  // down. Creating a NEW release has no release to return to, so that keeps the
  // list. Same rule the issue composer already follows.
  cancel.addEventListener("click", () =>
    nav("releases", editId != null ? { number: editId } : { list: true }),
  );

  // On an already-published release "Save draft" would silently UNPUBLISH it —
  // a destructive act behind an innocuous label. That release gets one button.
  const alreadyPublished = init.id !== undefined && !init.draft;
  const draftBtn = el("button", "mini-btn") as HTMLButtonElement;
  draftBtn.append(glyph("save"), span("Save draft"));
  draftBtn.title = "Keep this private — nobody is notified and it stays off the releases page";
  const publishBtn = el("button", "btn btn-primary") as HTMLButtonElement;
  const publishLabel = span(alreadyPublished ? "Save changes" : "Publish release");
  publishBtn.append(glyph(alreadyPublished ? "save" : "rocket"), publishLabel);
  publishBtn.title = alreadyPublished
    ? "Save your changes to this published release"
    : "Publish now — everyone watching this repository is notified";
  bar.append(cancel, el("span", "relc-spring"));
  if (!alreadyPublished) bar.appendChild(draftBtn);
  bar.appendChild(publishBtn);
  form.appendChild(bar);

  let busy = false;
  const submit = async (asDraft: boolean): Promise<void> => {
    if (busy) return;
    const tagName = tagField.input.value.trim();
    if (!tagName) {
      showError("A tag is required — it is what the release points at.");
      tagField.input.setAttribute("aria-invalid", "true");
      tagField.input.focus();
      return;
    }
    note.hidden = true;
    busy = true;
    for (const b of [publishBtn, draftBtn, cancel]) b.disabled = true;
    publishLabel.textContent = asDraft ? "Saving…" : alreadyPublished ? "Saving…" : "Publishing…";
    const input: ReleaseInput = {
      id: init.id,
      tagName,
      targetCommitish: targetField.input.value.trim() || undefined,
      name: title.value.trim(),
      body: notes.get(),
      draft: asDraft,
      prerelease: pre.input.checked,
      // Only sent when the answer is meaningful: a pre-release is never latest,
      // and on a draft the question does not arise until it is published.
      makeLatest: pre.input.checked || asDraft ? undefined : latest.input.checked,
    };
    try {
      const r = await host.invoke(init.id === undefined ? "release:create" : "release:update", input);
      if (!r.ok) {
        showError(r.message ?? "GitHub rejected the release.");
        return;
      }
      // The text is on its way to GitHub, so the local draft has done its job.
      // Left behind, re-opening the composer would restore a copy of what was
      // just published over the top of it.
      notesDraft.clear();
      headDraft.clear();
      bust("release");
      toast(
        init.id === undefined
          ? asDraft
            ? `Saved ${tagName} as a draft.`
            : `Published ${tagName}.`
          : `Updated ${tagName}.`,
        "success",
      );
      // Land ON the release, not on a list of every release with the new one
      // somewhere in it. A draft has no page of its own yet, so that one goes
      // to the list — where a draft is exactly what you are looking for.
      const landOn = init.id ?? ("id" in r ? r.id : undefined);
      nav("releases", landOn !== undefined && !asDraft ? { number: landOn } : { list: true });
    } catch (e) {
      showError(cleanErr(e) || "Couldn't reach GitHub.");
    } finally {
      busy = false;
      for (const b of [publishBtn, draftBtn, cancel]) b.disabled = false;
      publishLabel.textContent = alreadyPublished ? "Save changes" : "Publish release";
    }
  };
  publishBtn.addEventListener("click", () => void submit(false));
  draftBtn.addEventListener("click", () => void submit(alreadyPublished ? false : true));
  tagField.input.addEventListener("input", () => {
    if (!tagField.input.value.trim()) return;
    tagField.input.removeAttribute("aria-invalid");
    note.hidden = true;
  });
  // ⌘/Ctrl+Enter submits from anywhere on the form, matching every other
  // composer in the app (and the editor's own shortcut).
  form.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void submit(false);
    }
  });

  setPageLabel(editId ? `Edit ${init.tagName || "release"}` : "New release");
  (init.tagName ? title : tagField.input).focus();
}
