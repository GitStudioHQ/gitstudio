// Writing an issue, as a PAGE.
//
// It used to be `editForm` — a shared modal with a title input and a body box.
// The owner's report: "Same goes for issues creating and editing, the
// create/edit window is utter garbage, look at real github page to see how its
// done."
//
// github.com/…/issues/new is a full page: the title, a Write/Preview body that
// takes the window, and a sidebar for the things you decide ABOUT the issue —
// assignees, labels, milestone. The modal could offer none of that, so every
// one of those was a second trip through the issue's detail page after the
// issue already existed (and had already notified everyone watching).
//
// This is that page. Labels and assignees ride along with the create request
// rather than being patched on afterwards, because a follow-up request can
// fail on its own and leave an announced issue missing what its author chose.

import * as l10n from "@vscode/l10n";
import { host } from "../bridge";
import { el, span, glyph, avatar, labelChip, cleanErr, errorState, skeletonList, openMenu } from "../ui";
import { toast } from "../dialogs";
import { detailPage, propSection, type SectionTarget, type SectionNav } from "./common";
import { mdEditor } from "../mdEditor";
import { wireDraft } from "../draftStore";
import { setPageLabel } from "../navStack";
import { bust, gget } from "../cache";
import type { IssueDetail, PullRequest, RepoLabel, RepoCollaborator, MilestoneInfo } from "../../shared/ipc";

/**
 * Which thing is being written.
 *
 * A pull request's title and body are the same two fields in the same shape,
 * and editing one was the last surface still doing it in `editForm` — a modal
 * with no draft at all, so Escape took everything. It gets this page too; it
 * just has no sidebar, because a pull request's labels and reviewers already
 * live on its own page.
 */
export type ComposeKind = "issue" | "pr";

/** Everything the sidebar can offer, fetched once and never blocking the form. */
interface Choices {
  labels: RepoLabel[];
  people: RepoCollaborator[];
  milestones: MilestoneInfo[];
}

async function loadChoices(): Promise<Choices> {
  const [labels, people, milestones] = await Promise.all([
    gget("issue:labels", undefined, 60000).catch(() => [] as RepoLabel[]),
    gget("pr:reviewers", undefined, 60000).catch(() => [] as RepoCollaborator[]),
    gget("issue:milestones", undefined, 60000).catch(() => [] as MilestoneInfo[]),
  ]);
  return { labels, people, milestones };
}

/**
 * The composer. `target.number` edits that issue; without one it opens a new
 * one.
 */
export async function renderIssueCompose(
  wrap: HTMLElement,
  nav: SectionNav,
  target: SectionTarget | undefined,
  kind: ComposeKind = "issue",
): Promise<void> {
  const editNo = target?.number;
  const isPr = kind === "pr";
  // There is no "compose a pull request" here — a PR is opened from a branch,
  // not written from nothing — so a `predit` with no number is a routing bug,
  // and it must not quietly turn into the NEW-ISSUE form (which would file an
  // issue when you asked to edit a pull request).
  const section = isPr ? "prs" : "issues";
  const { view, main, rail, topActions } = detailPage({
    backLabel: isPr ? l10n.t("Pull requests") : l10n.t("Issues"),
    crumb: editNo ? l10n.t("Edit #{0}", editNo) : l10n.t("New issue"),
    pageLabel: editNo
      ? isPr
        ? l10n.t("Edit pull request #{0}", editNo)
        : l10n.t("Edit issue #{0}", editNo)
      : l10n.t("New issue"),
    onBack: () => nav(section, editNo ? { number: editNo } : { list: true }),
  });
  view.classList.add("isc-view");
  topActions.remove();
  wrap.replaceChildren(view);
  main.appendChild(skeletonList(3, false));

  if (isPr && editNo == null) {
    // No Retry here — retrying a routing bug does nothing. The top bar's
    // "← Pull requests" is the way out, and it is already on screen.
    main.replaceChildren(errorState(l10n.t("No pull request"), l10n.t("Nothing was named to edit.")));
    return;
  }

  let existing: IssueDetail | undefined;
  let existingPr: PullRequest | undefined;
  if (editNo != null) {
    try {
      if (isPr) existingPr = (await host.invoke("pr:detail", editNo))?.pr;
      else existing = await host.invoke("issue:detail", editNo);
    } catch (e) {
      if (!view.isConnected) return;
      main.replaceChildren(
        errorState(
          isPr ? l10n.t("Couldn't load this pull request") : l10n.t("Couldn't load this issue"),
          cleanErr(e) || l10n.t("GitHub request failed."),
          () => void renderIssueCompose(wrap, nav, target, kind),
        ),
      );
      return;
    }
    if (!view.isConnected) return;
    if (!existing && !existingPr) {
      main.replaceChildren(
        errorState(
          isPr ? l10n.t("Pull request unavailable") : l10n.t("Issue unavailable"),
          isPr
            ? l10n.t("This pull request couldn't be read from GitHub.")
            : l10n.t("This issue couldn't be read from GitHub."),
        ),
      );
      return;
    }
  }

  const initTitle = existingPr?.title ?? existing?.issue.title ?? "";
  // A seed only fills a NEW composer: an edit's initial text is the issue's
  // own, and overwriting it with a reference line would eat the description.
  const initBody = existingPr?.body ?? existing?.issue.body ?? target?.seedBody ?? "";
  // Editing an issue changes its TEXT. Labels, assignees and the milestone are
  // separate GitHub requests and the issue's own page already owns them — so
  // the sidebar is offered while composing (where it saves a round trip and a
  // premature notification) and not while editing (where it would duplicate,
  // and disagree with, controls that already exist).
  const composing = editNo == null;

  const form = el("div", "isc-form");
  main.replaceChildren(form);

  const draftId = `${kind}:${editNo == null ? "new" : String(editNo)}`;

  const titleField = el("div", "isc-field");
  const titleLabel = el("label", "isc-label");
  titleLabel.textContent = l10n.t("Title");
  const title = document.createElement("input");
  title.className = "isc-input isc-title";
  title.placeholder = isPr
    ? l10n.t("What does this change do?")
    : l10n.t("Say what happened, in one line");
  title.value = initTitle;
  title.id = "isc-title";
  (titleLabel as HTMLLabelElement).htmlFor = title.id;
  titleField.append(titleLabel, title);
  form.appendChild(titleField);
  // The title survives leaving too. It used to be the one field a draft did not
  // cover, so "never mind" (Escape) kept the paragraph you wrote and threw away
  // the line you wrote first.
  const titleDraft = wireDraft(`${kind}-title`, draftId, (t) => {
    if (!title.value || title.value === initTitle) title.value = t;
    if (initTitle && t !== initTitle) queueMicrotask(() => showRestored());
  });
  title.addEventListener("input", () => titleDraft.save(title.value));

  const bodyLabel = el("div", "isc-label isc-body-label");
  bodyLabel.textContent = l10n.t("Description");
  form.appendChild(bodyLabel);

  const body = mdEditor({
    value: initBody,
    placeholder: isPr
      ? l10n.t("What changed, why, and anything a reviewer should look at first. Markdown is supported.")
      : l10n.t(
          "What happened, what you expected, and how to reproduce it. Markdown is supported — drop in a code block with ```.",
        ),
    fill: true,
    label: isPr ? l10n.t("Pull request description") : l10n.t("Issue description"),
    onInput: (v) => bodyDraft.save(v),
    onSubmit: () => submitBtn.click(),
  });
  // A draft is restored over an EMPTY field silently, and over text GitHub
  // already has only WITH A NOTICE. The first version refused the second case
  // outright — "never rewrite the server's text behind your back" — which is
  // right about the silence and wrong about the outcome: an unsaved edit to
  // this very object is the reader's own work, and losing it to a stray Escape
  // is the thing they were promised would not happen.
  const restored = el("div", "isc-restored");
  restored.hidden = true;
  const bodyDraft = wireDraft(kind, draftId, (text) => {
    if (!initBody) {
      body.set(text);
      return;
    }
    if (text === initBody) return;
    body.set(text);
    showRestored();
  });
  form.append(restored, body.root);

  function showRestored(): void {
    if (!restored.hidden) return;
    restored.hidden = false;
    restored.replaceChildren(
      glyph("history"),
      span(l10n.t("Restored unsaved changes from this device."), "isc-restored-text"),
    );
    const discard = el("button", "mini-btn") as HTMLButtonElement;
    discard.textContent = l10n.t("Use the version on GitHub");
    discard.addEventListener("click", () => {
      body.set(initBody);
      title.value = initTitle;
      bodyDraft.clear();
      titleDraft.clear();
      restored.hidden = true;
    });
    restored.appendChild(discard);
  }

  const note = el("div", "isc-error");
  note.setAttribute("role", "alert");
  note.hidden = true;
  form.appendChild(note);
  const showError = (msg: string): void => {
    note.hidden = false;
    note.textContent = msg;
  };

  const bar = el("div", "isc-actions");
  const cancel = el("button", "btn") as HTMLButtonElement;
  cancel.textContent = l10n.t("Cancel");
  cancel.addEventListener("click", () => nav(section, editNo ? { number: editNo } : { list: true }));
  const submitBtn = el("button", "btn btn-primary") as HTMLButtonElement;
  const submitLabel = span(composing ? l10n.t("Create issue") : l10n.t("Save changes"));
  submitBtn.append(glyph(composing ? "issues" : "save"), submitLabel);
  submitBtn.title = composing
    ? l10n.t("Open this issue on GitHub — everyone watching the repository is notified")
    : l10n.t("Save the title and description");
  bar.append(cancel, el("span", "isc-spring"), submitBtn);
  form.appendChild(bar);

  // ── the sidebar ───────────────────────────────────────────────────────────
  const pickedLabels = new Set<string>();
  const pickedPeople = new Set<string>();
  let pickedMilestone: number | undefined;

  if (!composing) {
    // Editing changes the TEXT. A pull request's labels and reviewers, and an
    // issue's labels, assignees and milestone, already live on its own page —
    // a second set of controls here would duplicate and then disagree with them.
    rail.remove();
  } else {
    const labelProp = propSection(l10n.t("Labels"));
    const labelBody = labelProp.body;
    const assignProp = propSection(l10n.t("Assignees"));
    const assignBody = assignProp.body;
    const mileProp = propSection(l10n.t("Milestone"));
    const mileBody = mileProp.body;
    rail.append(labelProp.root, assignProp.root, mileProp.root);

    const empty = (parent: HTMLElement, text: string): void => {
      parent.appendChild(span(text, "isc-none"));
    };
    const addBtn = (text: string, onClick: (anchor: HTMLElement) => void): HTMLElement => {
      const b = el("button", "mini-btn isc-add") as HTMLButtonElement;
      b.append(glyph("add"), span(text));
      b.addEventListener("click", () => onClick(b));
      return b;
    };

    const choices = await loadChoices();
    if (!view.isConnected) return;

    const paintLabels = (): void => {
      labelBody.replaceChildren();
      if (pickedLabels.size) {
        const chips = el("div", "isc-chips");
        // The SAME chip the lists and the issue page draw, so a label cannot
        // look like one thing while you pick it and another once it is on.
        for (const name of pickedLabels) {
          const l = choices.labels.find((x) => x.name === name);
          chips.appendChild(labelChip(name, l?.color ?? ""));
        }
        labelBody.appendChild(chips);
      } else empty(labelBody, l10n.t("None yet"));
      labelBody.appendChild(
        addBtn(pickedLabels.size ? l10n.t("Edit labels") : l10n.t("Add labels"), (anchor) => {
          if (!choices.labels.length) {
            toast(l10n.t("This repository has no labels defined."), "info");
            return;
          }
          openMenu(
            anchor,
            choices.labels.map((l) => ({
              label: l.name,
              checkable: true,
              current: pickedLabels.has(l.name),
              onClick: () => {
                if (pickedLabels.has(l.name)) pickedLabels.delete(l.name);
                else pickedLabels.add(l.name);
                paintLabels();
              },
            })),
          );
        }),
      );
    };
    paintLabels();

    const paintPeople = (): void => {
      assignBody.replaceChildren();
      if (pickedPeople.size) {
        const row = el("div", "isc-people");
        for (const login of pickedPeople) {
          const p = choices.people.find((x) => x.login === login);
          const one = el("span", "isc-person");
          one.append(avatar(login, p?.avatarUrl, 18, l10n.t("Assignee")), span(login));
          row.appendChild(one);
        }
        assignBody.appendChild(row);
      } else empty(assignBody, l10n.t("No one — leave it unassigned"));
      assignBody.appendChild(
        addBtn(pickedPeople.size ? l10n.t("Edit assignees") : l10n.t("Assign people"), (anchor) => {
          if (!choices.people.length) {
            toast(l10n.t("Couldn't read this repository's collaborators."), "info");
            return;
          }
          openMenu(
            anchor,
            choices.people.map((p) => ({
              label: p.login,
              iconEl: avatar(p.login, p.avatarUrl, 18),
              checkable: true,
              current: pickedPeople.has(p.login),
              onClick: () => {
                if (pickedPeople.has(p.login)) pickedPeople.delete(p.login);
                else pickedPeople.add(p.login);
                paintPeople();
              },
            })),
          );
        }),
      );
    };
    paintPeople();

    const paintMilestone = (): void => {
      mileBody.replaceChildren();
      const m = choices.milestones.find((x) => x.number === pickedMilestone);
      if (m) mileBody.appendChild(span(m.title, "isc-milestone"));
      else empty(mileBody, l10n.t("No milestone"));
      mileBody.appendChild(
        addBtn(m ? l10n.t("Change milestone") : l10n.t("Set milestone"), (anchor) => {
          const open = choices.milestones.filter((x) => x.state === "open");
          if (!open.length) {
            toast(l10n.t("This repository has no open milestones."), "info");
            return;
          }
          openMenu(anchor, [
            {
              label: l10n.t("No milestone"),
              icon: "circle-slash",
              current: pickedMilestone === undefined,
              onClick: () => {
                pickedMilestone = undefined;
                paintMilestone();
              },
            },
            { separator: true },
            ...open.map((x) => ({
              label: l10n.t("{0} — {1} open", x.title, x.openIssues),
              icon: "milestone",
              current: pickedMilestone === x.number,
              onClick: () => {
                pickedMilestone = x.number;
                paintMilestone();
              },
            })),
          ]);
        }),
      );
    };
    paintMilestone();
  }

  // ── submit ────────────────────────────────────────────────────────────────
  let busy = false;
  const submit = async (): Promise<void> => {
    if (busy) return;
    const t = title.value.trim();
    if (!t) {
      showError(l10n.t("An issue needs a title — it is what everyone reads first."));
      title.setAttribute("aria-invalid", "true");
      title.focus();
      return;
    }
    note.hidden = true;
    busy = true;
    submitBtn.disabled = cancel.disabled = true;
    submitLabel.textContent = composing ? l10n.t("Creating…") : l10n.t("Saving…");
    try {
      if (composing) {
        const r = await host.invoke("issue:create", {
          title: t,
          body: body.get(),
          labels: [...pickedLabels],
          assignees: [...pickedPeople],
          milestone: pickedMilestone,
        });
        if (!r.ok) {
          showError(r.message ?? l10n.t("GitHub rejected the issue."));
          return;
        }
        bodyDraft.clear();
        titleDraft.clear();
        bust("issue");
        toast(r.number ? l10n.t("Opened issue #{0}.", r.number) : l10n.t("Issue created."), "success");
        nav("issues", r.number ? { number: r.number } : { list: true });
      } else {
        if (t === initTitle && body.get() === initBody) {
          nav(section, { number: editNo });
          return;
        }
        const r = isPr
          ? await host.invoke("pr:edit", { number: editNo!, title: t, body: body.get() })
          : await host.invoke("issue:edit", { number: editNo!, title: t, body: body.get() });
        if (!r.ok) {
          showError(r.message ?? l10n.t("GitHub rejected the change."));
          return;
        }
        bodyDraft.clear();
        titleDraft.clear();
        bust(isPr ? "pr" : "issue");
        toast(
          isPr ? l10n.t("Updated pull request #{0}.", editNo) : l10n.t("Updated issue #{0}.", editNo),
          "success",
        );
        nav(section, { number: editNo });
      }
    } catch (e) {
      showError(cleanErr(e) || l10n.t("Couldn't reach GitHub."));
    } finally {
      busy = false;
      submitBtn.disabled = cancel.disabled = false;
      submitLabel.textContent = composing ? l10n.t("Create issue") : l10n.t("Save changes");
    }
  };
  submitBtn.addEventListener("click", () => void submit());
  title.addEventListener("input", () => {
    if (!title.value.trim()) return;
    title.removeAttribute("aria-invalid");
    note.hidden = true;
  });
  form.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void submit();
    }
  });

  setPageLabel(
    editNo
      ? isPr
        ? l10n.t("Edit pull request #{0}", editNo)
        : l10n.t("Edit issue #{0}", editNo)
      : l10n.t("New issue"),
  );
  (initTitle ? body.textarea : title).focus();
}
