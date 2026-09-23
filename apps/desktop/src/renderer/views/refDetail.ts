// A ref, as a PAGE.
//
// A branch's history used to be a modal peek: no route, no entry in the back
// stack, no ⌘[ / ⌘], and it evaporated on Escape. For a remote branch, a tag or
// a stash that modal was worse than inconvenient — it was the ONLY door to
// every action those rows had, because none of them carried any.
//
// So each kind of ref gets a page: what it points at, what is on it, and its
// verbs in the top bar where a page's verbs live.

import { host } from "../bridge";
import { el, span, glyph, cleanErr, errorState, skeletonList, relTime, absTime, copyText } from "../ui";
import { toast, confirmDialog } from "../dialogs";
import { detailPage, commitList, type SectionTarget, type SectionNav } from "./common";
import { setPageLabel } from "../navStack";
import type { CompareCommit, RefInfo, StashInfo } from "../../shared/ipc";
import { refCheckoutRequest } from "../refMenuItems";
import { tagName } from "../branchRequests";
import { explainRefusedCheckout } from "../optionLikeRename";

/** Which kind of ref this page is showing — it arrives on `target.id`. */
type RefKind = "head" | "remote" | "tag" | "stash";

function kindLabel(kind: RefKind): string {
  return kind === "head" ? "branch" : kind === "remote" ? "remote branch" : kind;
}

/**
 * Render one ref's page.
 *
 * `target.ref` is the ref's name (or a stash selector); `target.id` is the kind.
 */
export async function renderRefDetail(
  wrap: HTMLElement,
  nav: SectionNav,
  target: SectionTarget | undefined,
): Promise<void> {
  const name = target?.ref;
  const kind = (target?.id as RefKind) || "head";
  const { view, main, rail, topActions } = detailPage({
    backLabel: "Branches",
    crumb: name ?? "Ref",
    pageLabel: name,
    onBack: () => nav("branches", { list: true }),
  });
  view.classList.add("refdetail-view");
  wrap.replaceChildren(view);
  main.appendChild(skeletonList(4, false));

  if (!name) {
    main.replaceChildren(errorState("No ref", "Nothing was named to open."));
    return;
  }
  setPageLabel(name);

  // What git knows about it, from the read the list already ran.
  let refs: RefInfo[] = [];
  let stashes: StashInfo[] = [];
  try {
    [refs, stashes] = await Promise.all([
      host.invoke("refs:list", undefined),
      kind === "stash" ? host.invoke("stash:list", undefined) : Promise.resolve([] as StashInfo[]),
    ]);
  } catch (e) {
    if (!view.isConnected) return;
    main.replaceChildren(
      errorState("Couldn't read this ref", cleanErr(e) || "Git did not answer.", () =>
        void renderRefDetail(wrap, nav, target),
      ),
    );
    return;
  }
  if (!view.isConnected) return;

  const stash = kind === "stash" ? stashes.find((s) => s.ref === name) : undefined;
  const ref = kind === "stash" ? undefined : refs.find((r) => r.name === name && r.type === kind);
  if (!ref && !stash) {
    main.replaceChildren(
      errorState(
        `That ${kindLabel(kind)} is not here`,
        `${name} was not found in this repository. It may have been deleted, or the list you came from is stale.`,
        () => nav("branches", { list: true }),
      ),
    );
    return;
  }

  const sha = stash?.sha ?? ref?.sha ?? "";
  const when = stash?.time ?? ref?.date;

  // ── the head ──────────────────────────────────────────────────────────────
  const head = el("div", "rd-head");
  const title = el("h1", "rd-title");
  title.textContent = stash?.message || name;
  head.appendChild(title);

  const facts = el("div", "rd-facts");
  facts.appendChild(span(kindLabel(kind), "rd-kind"));
  if (ref?.objectType === "tag") {
    // Said in words, not git's own jargon — "annotated" answered nothing on
    // the list rows and answers nothing here either.
    const a = span("has its own message", "ab-pill annotated");
    a.title = "An annotated tag: it records who tagged, when, and why";
    facts.appendChild(a);
  }
  if (ref?.isCurrent) facts.appendChild(span("checked out", "ab-pill current"));
  if (ref?.gone) {
    const g = span("upstream gone", "ab-pill gone");
    g.title = `${ref.upstream ?? "Its upstream"} no longer exists.`;
    facts.appendChild(g);
  }
  if (ref?.upstream) facts.appendChild(span(`tracks ${ref.upstream}`, "rd-fact"));
  if (stash) facts.appendChild(span(stash.ref, "rd-fact sec-mono"));
  if (when) {
    const t = span(relTime(when), "rd-fact");
    t.title = absTime(when);
    facts.appendChild(t);
  }
  head.appendChild(facts);
  if (ref?.subject) {
    const s = el("div", "rd-subject");
    s.textContent = ref.subject;
    head.appendChild(s);
  }
  main.replaceChildren(head);

  // ── the top bar's verbs ───────────────────────────────────────────────────
  const shaBtn = el("button", "mini-btn") as HTMLButtonElement;
  shaBtn.append(glyph("copy"), span(sha.slice(0, 7) || "no sha"));
  shaBtn.title = `${sha}\nCopy the full SHA`;
  shaBtn.setAttribute("aria-label", `Copy the full SHA ${sha}`);
  shaBtn.disabled = !sha;
  shaBtn.addEventListener("click", () => void copyText(sha, "Copied the full SHA."));
  topActions.appendChild(shaBtn);

  const act = (label: string, icon: string, title: string, run: () => void, primary = false): void => {
    const b = el("button", primary ? "btn btn-primary" : "mini-btn") as HTMLButtonElement;
    b.append(glyph(icon), span(label));
    b.title = title;
    b.addEventListener("click", run);
    topActions.appendChild(b);
  };

  // By the ref's FULL name (the one this page looked it up by, name AND
  // kind): the short name is "heads/release" beside a tag of that name, and
  // checking THAT out detaches.
  if (kind === "head" && ref && !ref.isCurrent) {
    act("Check out", "git-branch", `Check out ${name}`, () =>
      void checkout(ref.fullName, `Checked out ${name}.`), true);
  }
  if (kind === "remote" && ref) {
    const local = name.split("/").slice(1).join("/") || name;
    act("Check out here", "git-branch", `Create ${local} from ${name} and check it out`, () =>
      void checkout(ref.fullName, `Checked out ${local}.`), true);
  }
  if (kind === "tag") {
    act("Push", "cloud-upload", `Publish ${name} to the remote`, () => void pushTag());
    act("Delete…", "trash", `Delete ${name} from this clone`, () => void deleteTag());
  }
  if (kind === "stash") {
    act("Apply", "arrow-down", `Apply ${name}, keeping it in the list`, () => void stashAct("apply"), true);
    act("Pop", "arrow-up", `Apply ${name} and remove it`, () => void stashAct("pop"));
    act("Drop…", "trash", `Delete ${name} permanently`, () => void stashAct("drop"));
  }
  if (sha) {
    act("View in Commits", "git-commit", "Reveal this commit in the Commits view", () =>
      nav("graph", { sha }));
  }

  // ── the rail ──────────────────────────────────────────────────────────────
  const prop = (label: string, value: string, title?: string): void => {
    const row = el("div", "rd-prop");
    row.appendChild(span(label, "rd-prop-label"));
    const v = span(value, "rd-prop-value");
    if (title) v.title = title;
    row.appendChild(v);
    rail.appendChild(row);
  };
  prop("Kind", kindLabel(kind));
  if (sha) prop("Commit", sha.slice(0, 7), sha);
  if (ref?.upstream) prop("Upstream", ref.upstream);
  // RefInfo carries no ahead/behind: `%(upstream:track)` is only ever populated
  // on LOCAL heads, so the field would be empty on every remote and tag row —
  // the branch list is where that pair lives.
  if (when) prop("Updated", relTime(when), absTime(when));
  prop("Full name", ref?.fullName ?? name, ref?.fullName ?? name);

  // ── what is on it ─────────────────────────────────────────────────────────
  const historyHead = el("div", "rd-section-head");
  historyHead.append(glyph("git-commit"), span(kind === "stash" ? "The commit it holds" : "Recent commits"));
  main.appendChild(historyHead);
  const historyBody = el("div", "rd-history");
  historyBody.appendChild(skeletonList(4, false));
  main.appendChild(historyBody);

  let log: CompareCommit[] = [];
  try {
    // A STASH IS ONE COMMIT. `git log stash@{0}` walks its ancestry, so this
    // section — headed "The commit it holds", singular — filled with thirty
    // rows: the WIP commit, then git's internal "index on <branch>: …" commit
    // (the stash's second parent, an implementation detail no UI should show),
    // then the branch history it was taken from. Asking for one gets one.
    log = await host.invoke("ref:log", { ref: name, maxCount: kind === "stash" ? 1 : 30 });
  } catch (e) {
    if (!view.isConnected) return;
    historyBody.replaceChildren(
      errorState("Couldn't read this ref's history", cleanErr(e) || "Git did not answer."),
    );
    return;
  }
  if (!view.isConnected) return;
  historyBody.replaceChildren(
    log.length
      ? commitList(
          log.map((c) => ({
            sha: c.sha,
            shortSha: c.shortSha,
            subject: c.subject,
            body: c.body,
            author: c.author,
            date: c.date,
            isMerge: c.isMerge,
          })),
          {
            onOpen: (s) => nav("commit", { sha: s }),
            onCopy: (s) => void copyText(s, "Copied the full SHA."),
            // NEWEST first: this is a capped window on an ongoing history, not
            // a complete set. Oldest-first opened on the 30th-newest commit and
            // put the branch tip — the commit every reader is here for — at the
            // bottom, below a fold on any branch with real history.
            order: "newest",
          },
        )
      : errorState("No history", "Git returned no commits for this ref."),
  );

  // ── the verbs' plumbing ───────────────────────────────────────────────────
  /**
   * Check out a ref, by its FULL name.
   *
   * `checkout-ref`, not `checkout` — the plain action detaches HEAD at whatever
   * `sha` names, so handing it "origin/foo" leaves you on a detached
   * remote-tracking ref with no branch and no upstream, while the toast claims
   * the branch was checked out. The namespace is what turns a remote into a
   * real local tracking branch (issues #12/#19) — and the full name is what
   * keeps "heads/release" (a branch beside a tag of that name) a branch.
   */
  async function checkout(fullName: string, ok: string): Promise<void> {
    let r;
    try {
      // The one builder every checkout door uses: the kind comes from the
      // namespace, and the main process plans from the full name.
      r = await host.invoke("commit:action", refCheckoutRequest(fullName));
    } catch (e) {
      toast(cleanErr(e) || "Couldn't check out.", "error");
      return;
    }
    // Uncommitted changes in the switch's way were asked about (Stash & Retry
    // or Cancel — bridge.ts), and the user cancelled: nothing ran.
    if (r?.cancelled) return;
    // Arrives over IPC: a channel that failed to register hands back undefined,
    // and reading `.ok` off it throws inside an async handler — no toast, no
    // error, the click simply doing nothing. A refusal that is the user's state
    // (`expected`) is said in the neutral tone.
    if (!r?.ok) {
      // A branch named like an option says so, and offers the rename.
      if (explainRefusedCheckout(r, () => nav("branches", { list: true }))) return;
      toast(r?.message || "Couldn't check out.", r?.expected ? "info" : "error");
      return;
    }
    toast(ok, "success");
    nav("branches", { list: true });
  }

  // The name under refs/tags/ — beside a branch of the same name the page's
  // own name is git's short "tags/v1", which names no tag to push or delete.
  const tag = ref ? tagName(ref) : name!;

  async function pushTag(): Promise<void> {
    const r = await host.invoke("tag:push", { name: tag });
    toast(r.ok ? `Pushed ${name}.` : (r.message ?? "Couldn't push the tag."), r.ok ? "success" : "error");
  }

  async function deleteTag(): Promise<void> {
    const ok = await confirmDialog({
      title: `Delete tag ${name}?`,
      message:
        "This removes the tag from this clone only. If it has already been pushed, the copy " +
        "on the remote is untouched and a fetch brings it straight back.",
      confirmLabel: "Delete locally",
      danger: true,
    });
    if (!ok) return;
    const r = await host.invoke("tag:delete", tag);
    if (!r.ok) {
      toast(r.message ?? "Couldn't delete the tag.", r.expected ? "info" : "error");
      return;
    }
    toast(`Deleted tag ${name} locally.`, "success");
    nav("branches", { list: true });
  }

  /**
   * `stash@{n}` is a POSITION, not an identity — dropping one renumbers every
   * stash below it. Re-read and compare the commit before acting, or this page
   * can name one stash and destroy another.
   */
  async function stashAct(action: "apply" | "pop" | "drop"): Promise<void> {
    if (action === "drop") {
      const ok = await confirmDialog({
        title: `Drop ${name}?`,
        message: `“${stash?.message || name}” is deleted permanently. This cannot be undone.`,
        confirmLabel: "Drop",
        danger: true,
      });
      if (!ok) return;
    }
    let fresh: StashInfo[];
    try {
      fresh = await host.invoke("stash:list", undefined);
    } catch {
      toast("Couldn't re-read the stash list — nothing was changed.", "error");
      return;
    }
    const still = fresh.find((x) => x.ref === name);
    if (!still || (stash?.sha && still.sha !== stash.sha)) {
      toast(`${name} is not the stash it was — the list changed underneath.`, "info");
      nav("branches", { list: true });
      return;
    }
    const r = await host.invoke(
      action === "apply" ? "stash:apply" : action === "pop" ? "stash:pop" : "stash:drop",
      name!,
    );
    // Uncommitted changes in the stash's way were asked about (Stash & Retry
    // or Cancel — bridge.ts), and the user cancelled: nothing ran.
    if (r.cancelled) return;
    if (!r.ok) {
      toast(r.message ?? `Couldn't ${action} ${name}.`, r.expected ? "info" : "error");
      return;
    }
    toast(
      action === "apply" ? `Applied ${name}.` : action === "pop" ? `Popped ${name}.` : `Dropped ${name}.`,
      "success",
    );
    if (action !== "apply") nav("branches", { list: true });
  }
}
