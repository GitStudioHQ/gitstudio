// The commit page.
//
// Until now, every "show me this commit" in the app — a row in a pull request's
// commit list, a row in Compare, a release's tag, a notification's subject, a
// sha in prose — answered by ejecting you into the Commits GRAPH and calling
// `reveal(sha)`. That is wrong three ways, and the owner hit all three:
//
//   · The graph shows a ROW. His words: "it teleports u to the commit graph
//     which tells u nothing about the changed files".
//   · `reveal()` returns silently when the sha is outside the loaded page, so
//     from a long-lived PR the click did nothing at all.
//   · It abandons wherever you were, which on a PR means losing your place in a
//     review.
//
// So: a real page. What GitHub's /owner/repo/commit/<sha> shows — message, both
// identities, parents, refs, and every changed file — plus the thing github.com
// cannot offer, because the repository is right here: the git verbs. Cherry-pick
// this onto the current branch, revert it, branch from it, reset to it.

import { host } from "../bridge";
import {
  el,
  span,
  glyph,
  avatar,
  cleanErr,
  emptyState,
  errorState,
  skeletonList,
  relTime,
  absTime,
  commonDir,
  copyText,
  openMenu,
} from "../ui";
import { detailPage, disposeOnDetach, type SectionTarget } from "./common";
import { confirmDialog, promptInline } from "../dialogs";
import { renderMarkdown } from "../markdown";
import { DiffPanel } from "../diffPanel";
import { setPageTarget } from "../navStack";
import { gget } from "../cache";
import type { CommitActionRequest, CommitDetailsPayload } from "../../shared/ipc";
import type { CommitFileChange } from "@gitstudio/host-bridge/commitDetailsProtocol";

/** Status letter → the word a person reads, and the class that colours it. */
const STATUS: Record<string, { word: string; cls: string }> = {
  A: { word: "added", cls: "is-add" },
  M: { word: "modified", cls: "is-mod" },
  D: { word: "deleted", cls: "is-del" },
  R: { word: "renamed", cls: "is-ren" },
  C: { word: "copied", cls: "is-ren" },
  T: { word: "type changed", cls: "is-mod" },
};

function diffstat(files: CommitFileChange[]): { adds: number; dels: number; binary: number } {
  let adds = 0;
  let dels = 0;
  let binary = 0;
  for (const f of files) {
    // -1 is git's "binary" marker in --numstat; adding it as a number would
    // quietly subtract one from the total.
    if (f.additions < 0 || f.deletions < 0) binary++;
    else {
      adds += f.additions;
      dels += f.deletions;
    }
  }
  return { adds, dels, binary };
}

/**
 * The identity block. The committer row appears ONLY when it differs from the
 * author — which is the case that matters (a rebase, a cherry-pick, a patch
 * applied by a maintainer) and the case a single "author" line hides.
 */
function identity(d: CommitDetailsPayload): HTMLElement {
  const box = el("div", "cmt-identity");
  const authored = el("div", "cmt-who");
  authored.append(
    avatar(d.author, undefined, 20),
    span(d.author, "cmt-who-name"),
    span("authored", "cmt-who-verb"),
  );
  // SECONDS. `relTime` and `absTime` both take epoch seconds — passing
  // milliseconds made every commit on this page read "authored just now"
  // (the clamp swallows the negative delta) with a hover date in the year
  // 57000. The one thing the report asked this line for was *when*.
  const t = span(relTime(d.authorDate), "cmt-who-when");
  t.title = absTime(d.authorDate);
  authored.append(t);
  box.appendChild(authored);

  const sameName = d.committer === d.author;
  const sameTime = Math.abs(d.committerDate - d.authorDate) < 2;
  if (!sameName || !sameTime) {
    const committed = el("div", "cmt-who");
    committed.append(
      avatar(d.committer, undefined, 20),
      span(d.committer, "cmt-who-name"),
      span("committed", "cmt-who-verb"),
    );
    const t2 = span(relTime(d.committerDate), "cmt-who-when");
    t2.title = absTime(d.committerDate);
    committed.append(t2);
    box.appendChild(committed);
  }
  return box;
}

/**
 * Render the commit page into `wrap`.
 *
 * `nav` is the app's router; `target.sha` is the commit. `target.from` is not
 * used — the back button pops the history and names wherever that lands, so a
 * commit opened from a pull request says "← Pull Request #106" without this
 * view knowing a pull request exists.
 */
export async function renderCommit(
  wrap: HTMLElement,
  nav: (view: string, target?: SectionTarget) => void,
  target: SectionTarget | undefined,
  /** The app's action handler — toasts the outcome and refreshes what changed. */
  run: (req: CommitActionRequest) => Promise<void>,
): Promise<void> {
  const sha = target?.sha ?? "";
  const short = sha.slice(0, 7);

  const { view, main, rail, topActions } = detailPage({
    backLabel: "Commits",
    crumb: short,
    pageLabel: `Commit ${short}`,
    onBack: () => nav("graph", { sha }),
  });
  // The message wants a reading measure; a diff wants the window. `.cmt-view`
  // lifts `.det-main`'s cap and the header re-caps itself — see app.css.
  view.classList.add("cmt-view");
  main.appendChild(skeletonList(3, false));
  wrap.replaceChildren(view);

  if (!sha) {
    main.replaceChildren(emptyState("No commit", "Nothing was asked for.", { icon: "git-commit" }));
    return;
  }

  let d: CommitDetailsPayload | undefined;
  try {
    d = await gget("commit:details", sha, 30_000);
  } catch (e) {
    main.replaceChildren(
      errorState("Couldn't read this commit", cleanErr(e) || "git failed.", () =>
        void renderCommit(wrap, nav, target, run),
      ),
    );
    return;
  }

  if (!d) {
    // The object is not in this clone. That is an ordinary situation — a pull
    // request from a fork, a commit on a branch never fetched — and it is
    // exactly where the old graph jump dead-ended without saying why.
    main.replaceChildren(
      emptyState(
        "This commit isn't in your clone",
        `${short} isn't an object this repository has. It may be on a fork, or on a branch you ` +
          `haven't fetched. Fetching the remote will bring it in.`,
        { icon: "cloud-download" },
      ),
    );
    return;
  }

  // ── header ────────────────────────────────────────────────────────────────
  //
  // TWO LINES. The diff is what this page is for, and the first version spent
  // 251px of a 913px window on a message and a stat bar before the diff
  // started, then gave the diff 504px of ~1100px because a file list and a
  // properties rail were beside it. The most important thing on the page had
  // less than half the room.
  //
  // So: subject, one identity line, one facts line. A long message hides behind
  // a disclosure rather than pushing the diff off the screen — most commit
  // bodies are two lines and the ones that are not are exactly the problem.
  const head = el("div", "cmt-head");
  const title = el("h1", "cmt-subject");
  title.textContent = d.subject;
  head.appendChild(title);
  head.appendChild(identity(d));

  const facts = el("div", "cmt-facts");
  // Where it lives: "on redesign/wave-2", or "merged into main" — the first
  // question a reader has, and the page could not answer it at all.
  const where = span("", "cmt-where");
  facts.appendChild(where);
  void host
    .invoke("commit:branches", d.sha)
    .then((b) => {
      if (!b || !b.branches.length) {
        where.textContent = d.parents.length > 1 ? "a merge commit" : "not on any local branch";
        where.title = "No local branch contains this commit — it may only exist on a remote.";
        return;
      }
      const others = b.branches.filter((x) => x !== b.current);
      if (b.onCurrent && others.length) {
        where.textContent = `on ${b.current}, and ${others.length} other branch${others.length === 1 ? "" : "es"}`;
      } else if (b.onCurrent) {
        where.textContent = `only on ${b.current}`;
      } else {
        where.textContent = `not on ${b.current ?? "this branch"} — on ${b.branches[0]}`;
      }
      where.title = `Contained by: ${b.branches.join(", ")}`;
    })
    .catch(() => {
      where.remove();
    });

  if (d.parents.length > 1) {
    const m = span(`merge of ${d.parents.length} parents`, "cmt-fact-merge");
    m.title = "A merge commit — its diff is against the first parent.";
    facts.appendChild(m);
  }

  // Ref chips: branch tips and tags sitting exactly here.
  for (const r of d.refs) {
    const chip = span(r.name, `cmt-ref is-${r.kind}`);
    chip.title = `${r.kind === "tag" ? "tag" : "branch"} ${r.name}`;
    facts.appendChild(chip);
  }

  if (d.body.trim()) {
    const toggle = el("button", "cmt-body-toggle") as HTMLButtonElement;
    toggle.append(glyph("chevron-down"), span("Description"));
    toggle.setAttribute("aria-expanded", "false");
    const body = el("div", "gh-body-md cmt-body");
    body.innerHTML = renderMarkdown(d.body);
    body.hidden = true;
    toggle.addEventListener("click", () => {
      body.hidden = !body.hidden;
      toggle.setAttribute("aria-expanded", String(!body.hidden));
      toggle.replaceChildren(glyph(body.hidden ? "chevron-down" : "chevron-up"), span("Description"));
    });
    facts.appendChild(toggle);
    head.appendChild(facts);
    head.appendChild(body);
  } else {
    head.appendChild(facts);
  }
  main.replaceChildren(head);

  // ── the changed files — the whole point ───────────────────────────────────
  const { adds, dels, binary } = diffstat(d.files);
  const n = d.files.length;
  const statBar = el("div", "cmt-statbar");
  statBar.append(
    span(`${n} file${n === 1 ? "" : "s"}`, "cmt-stat-files"),
    span(`+${adds.toLocaleString()}`, "cmt-stat-add"),
    span(`−${dels.toLocaleString()}`, "cmt-stat-del"),
  );
  if (binary) statBar.appendChild(span(`${binary} binary`, "cmt-stat-bin"));

  if (!n) {
    main.appendChild(
      emptyState(
        "No file changes",
        "This commit records no change to any file — an empty commit, or a merge whose result " +
          "matched its first parent.",
        { icon: "git-commit" },
      ),
    );
  } else {
    const prefix = commonDir(d.files.map((f) => f.path));
    if (prefix) {
      const p = el("div", "cmt-prefix");
      p.append(glyph("folder"), span(prefix));
      p.title = `Every file in this commit is under ${prefix}`;
      main.appendChild(p);
    }
    const split = el("div", "cmt-split");
    const listCol = el("div", "cmt-listcol");
    const list = el("div", "cmt-files");
    const pane = el("div", "cmt-diff");

    // A filter, because at any real size scrolling is not finding.
    //
    // Measured on a 420-file merge — an ordinary size for a codemod or a
    // lockfile bump: 13,027px of file list in a 566px column. Rendering all of
    // it costs 25ms, so virtualisation is not the problem and building it would
    // have been the wrong work; having no way to ASK for a file is the problem.
    const filter = document.createElement("input");
    filter.className = "cmt-filter";
    filter.type = "search";
    filter.placeholder = `Filter ${n} file${n === 1 ? "" : "s"}…`;
    filter.setAttribute("aria-label", "Filter the changed files");
    const count = el("div", "cmt-filter-count");
    count.hidden = true;

    const filterHead = el("div", "cmt-filterhead");
    filterHead.append(filter, count);
    listCol.append(statBar, filterHead, list);
    split.append(listCol, pane);
    main.appendChild(split);

    const diff = new DiffPanel(pane);
    // `routeView` disposes only `activeMonacoView`, and this panel was never
    // registered there — so every visit to a commit page left a Monaco diff
    // editor behind, with its two models and their tokenizers, for the life of
    // the window. Read ten commits and ten of them are still resident.
    //
    // No check guards this: the leak is in the editor OBJECTS, and `monaco` is
    // not exposed to the page, so a probe can only count `.monaco-editor` DOM
    // nodes — which go away when the host's children are replaced whether
    // anything was disposed or not. Counting them reports success on the
    // broken build, which is worse than not checking at all.
    disposeOnDetach(view, () => diff.dispose());
    diff.showEmpty("Select a file to see what changed.");
    // The parent this commit is diffed against. A root commit has none, and
    // git's empty-tree hash is the standard stand-in.
    const base = d.parents[0] ?? "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

    let selected: HTMLElement | undefined;
    let gen = 0;
    /** Which file to open on build — carried in the route target so a rebuild
     *  lands where the reader was, not at the top of the list. */
    const wantFile = d.files.some((x) => x.path === target?.file) ? target?.file : undefined;
    const openFile = async (f: CommitFileChange, row: HTMLElement): Promise<void> => {
      // NOT once this page has gone. `setPageTarget` writes into whatever
      // history entry is CURRENT, and the auto-open below fires from a render
      // that may already have been abandoned — so a commit page you left while
      // it was still loading stamped its file path onto the entry of the view
      // you had moved to, and the next refresh re-routed that view with it.
      //
      // The job log's `openJob` carries this exact guard, written an hour
      // before this line and then not written here.
      if (!view.isConnected) return;
      // Remember it, without navigating — a refresh re-routes with this target.
      setPageTarget({ file: f.path });
      selected?.classList.remove("is-current");
      selected = row;
      row.classList.add("is-current");
      // Click a large file then a small one and the large response can land
      // last, painting over the selection — the same staleness guard every
      // other diff surface here uses.
      const mine = ++gen;
      const fd = await host
        // A rename's left side is the OLD name — without it the base is asked
        // for a path it never had, and a small edit renders as a whole new file.
        .invoke("compare:fileDiff", { base, head: d!.sha, path: f.path, leftPath: f.oldPath })
        .catch(() => undefined);
      if (mine !== gen) return;
      if (fd) {
        // The path already sits above the diff, so repeating it inside each
        // pane behind a 40-character sha only crowds the one thing this page
        // exists for. Name the SIDES instead — which is what a reader of a
        // commit diff actually needs to know, and what the pane labels never
        // said.
        diff.showDiff({
          ...fd,
          leftLabel: d!.parents.length ? `${base.slice(0, 7)} · before` : "(new file)",
          rightLabel: `${d!.shortSha} · this commit`,
        });
      }
      // With no `kind` this defaulted to "waiting" — the reader got the
      // "Nothing selected" heading and the pick-a-file icon over a row that was
      // still highlighted, so a FAILURE read as an instruction to do the thing
      // they had just done. Both sibling callers (Compare, Changes) were given
      // this treatment; this one was missed.
      else
        diff.showEmpty(
          `${f.path} is listed as changed in this commit, so this is a failure to read it — not a file with nothing in it.`,
          { title: "Couldn't read this file", kind: "error" },
        );
    };

    const rowFor = new Map<HTMLElement, string>();
    d.files.forEach((f, i) => {
      const row = el("button", "cmt-file") as HTMLButtonElement;
      rowFor.set(row, f.path.toLowerCase());
      const st = STATUS[f.status] ?? { word: "changed", cls: "is-mod" };
      const letter = span(f.status, `cmt-file-status ${st.cls}`);
      letter.title = st.word;
      const path = span(f.path.slice(prefix.length), "cmt-file-path");
      path.title = f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
      row.append(letter, path);
      if (f.additions >= 0 || f.deletions >= 0) {
        const counts = el("span", "cmt-file-counts");
        if (f.additions > 0) counts.appendChild(span(`+${f.additions}`, "cmt-file-add"));
        if (f.deletions > 0) counts.appendChild(span(`−${f.deletions}`, "cmt-file-del"));
        row.appendChild(counts);
      } else {
        row.appendChild(span("binary", "cmt-file-bin"));
      }
      row.setAttribute(
        "aria-label",
        `${st.word} ${f.path}${f.additions >= 0 ? `, ${f.additions} added, ${f.deletions} removed` : ""}`,
      );
      row.addEventListener("click", () => void openFile(f, row));
      list.appendChild(row);
      // The file the reader was ON, if this page is being rebuilt — falling
      // back to the first one, which is what it always did.
      //
      // `refreshAll` re-routes the current view with its history target, and
      // the file watcher fires it on ANY save anywhere in the repository. So a
      // build touching a file swapped the diff you were reading for file #1,
      // silently, while you were reading it. `SectionTarget.file` exists for
      // exactly this and the Code browser already uses it.
      if (f.path === wantFile || (!wantFile && i === 0)) void openFile(f, row);
    });

    // Every space-separated term must appear somewhere in the path, so
    // "render css" finds `src/renderer/styles/app.css` — the way a person
    // narrows by remembering two fragments rather than one exact prefix.
    const applyFilter = (): void => {
      const terms = filter.value.toLowerCase().split(/\s+/).filter(Boolean);
      let shown = 0;
      for (const [row, path] of rowFor) {
        const hit = terms.every((t) => path.includes(t));
        row.hidden = !hit;
        if (hit) shown++;
      }
      count.hidden = terms.length === 0;
      count.textContent = shown === 0 ? "No file matches" : `${shown} of ${n}`;
      count.classList.toggle("is-empty", shown === 0);
    };
    filter.addEventListener("input", applyFilter);
    filter.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && filter.value) {
        // Clear before dismissing: Escape in a filter means "undo the filter",
        // and only means "leave" once there is nothing to undo.
        e.stopPropagation();
        filter.value = "";
        applyFilter();
      }
    });
    // "/" jumps to the filter from anywhere on the page, as it does in the
    // Code browser — the same key for the same job.
    view.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "/" || (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA"))) return;
      e.preventDefault();
      filter.focus();
    });
  }

  // ── actions ───────────────────────────────────────────────────────────────
  //
  // In the TOP BAR, not a rail. A 264px properties column beside the diff was
  // 264px the diff did not get, to hold five buttons and two chips — and the
  // diff is the page. The verbs are one menu; the parents are chips on the
  // facts line; the sha is in the crumb, where it already was.
  rail.remove();

  const shaBtn = el("button", "mini-btn cmt-sha") as HTMLButtonElement;
  shaBtn.append(glyph("copy"), span(d.shortSha));
  shaBtn.title = `${d.sha}\nCopy the full SHA`;
  shaBtn.setAttribute("aria-label", `Copy the full SHA ${d.sha}`);
  // `copyText`, like the other 28 copy buttons in the app — not a raw
  // `clipboard:write`. Two things came free with it and were missing here: the
  // navigator.clipboard path (the IPC channel is only its FALLBACK, for the
  // contexts where the permission is refused), and the confirmation. This was
  // the one sha button in the app that copied in silence, so the only way to
  // know it had worked was to paste.
  shaBtn.addEventListener("click", () => void copyText(d!.sha, "Copied the full SHA."));
  topActions.appendChild(shaBtn);

  // The reason to read a commit HERE rather than on github.com: the repository
  // is in hand, so these are real operations rather than links.
  const more = el("button", "mini-btn") as HTMLButtonElement;
  more.append(glyph("kebab-vertical"));
  more.title = "Actions for this commit";
  more.setAttribute("aria-label", more.title);
  more.addEventListener("click", () => {
    const items = [
      { label: "Check out this commit", icon: "git-branch", onClick: () => act("checkout") },
      { label: "Branch from here…", icon: "git-branch", onClick: () => act("branch") },
      { label: "Tag this commit…", icon: "tag", onClick: () => act("tag") },
      { separator: true },
      { label: "Cherry-pick onto current branch", icon: "git-commit", onClick: () => act("cherry-pick") },
      { label: "Revert this commit", icon: "discard", onClick: () => act("revert") },
      { separator: true },
      ...d!.parents.map((p, i) => ({
        label: d!.parents.length > 1 ? `Open parent ${i + 1} — ${p.slice(0, 7)}` : `Open parent ${p.slice(0, 7)}`,
        icon: "git-commit",
        onClick: () => nav("commit", { sha: p }),
      })),
      { separator: true },
      // The graph is a good way to see a commit's SHAPE — just not an answer to
      // "what changed", which is why it stopped being the destination.
      { label: "Show in the graph", icon: "git-commit", onClick: () => nav("graph", { sha: d!.sha }) },
    ];
    openMenu(more, items);
  });
  topActions.appendChild(more);

  /**
   * Run one of the page's git verbs.
   *
   * This used to be `void host.invoke("commit:action", {action, sha})` and
   * nothing else, which was wrong in three ways at once:
   *
   *   · "Branch from here…" and "Tag this commit…" need a NAME. Without one the
   *     main process finds no argv to run and answers `{ok: true}` — so both
   *     items reported success, having done nothing, and the ellipsis in each
   *     label promised a prompt that never opened.
   *   · The result was discarded. A cherry-pick or revert that hit conflicts —
   *     the common case, and the reason you'd look at the result — said nothing
   *     whatsoever.
   *   · Nothing refreshed. A revert writes a commit; the graph and the branch
   *     list went on showing the repository as it was before the click.
   *
   * `run` is the app's own action handler: the same toasts, cache busting and
   * refresh the graph's context menu has always gone through.
   */
  const act = async (action: CommitActionRequest["action"]): Promise<void> => {
    let name: string | undefined;
    if (action === "branch" || action === "tag") {
      const asked = await promptInline(
        action === "branch" ? "Create branch here" : "Create tag here",
        action === "branch" ? "feature/my-branch" : "v1.0.0",
      );
      name = asked?.trim();
      if (!name) return;
    }
    const confirms: Partial<Record<CommitActionRequest["action"], string>> = {
      checkout: "Check out this commit directly? HEAD will be detached — not on any branch.",
      revert: "Create a commit that undoes this one, on the current branch?",
    };
    const message = confirms[action];
    if (message && !(await confirmDialog({ title: `${short} — ${action.replace(/-/g, " ")}`, message }))) {
      return;
    }
    await run({ action, sha: d!.sha, name });
  };
}
