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
} from "../ui";
import { detailPage, propSection, type SectionTarget } from "./common";
import { renderMarkdown } from "../markdown";
import { DiffPanel } from "../diffPanel";
import { gget } from "../cache";
import type { CommitDetailsPayload } from "../../shared/ipc";
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

/**
 * The longest directory prefix every path shares.
 *
 * A commit usually touches one area, so without this every row reads
 * `apps/desktop/src/renderer/views/…` and the only distinguishing part — the
 * filename — is the part that gets truncated away. Shown ONCE above the list
 * instead, which is better than GitHub, where every row carries the full path.
 *
 * Directory boundaries only: two files named `logView.ts` and `logModel.ts`
 * share the characters "log" and share no directory, and folding on characters
 * would leave rows reading "View.ts" and "Model.ts".
 */
function commonDir(paths: string[]): string {
  if (paths.length < 2) return "";
  const split = paths.map((p) => p.split("/"));
  const first = split[0];
  let n = 0;
  while (n < first.length - 1 && split.every((s) => s.length > n + 1 && s[n] === first[n])) n++;
  return n ? `${first.slice(0, n).join("/")}/` : "";
}

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
  const t = span(relTime(d.authorDate * 1000), "cmt-who-when");
  t.title = absTime(d.authorDate * 1000);
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
    const t2 = span(relTime(d.committerDate * 1000), "cmt-who-when");
    t2.title = absTime(d.committerDate * 1000);
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
        void renderCommit(wrap, nav, target),
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
  const head = el("div", "cmt-head");
  const title = el("h1", "cmt-subject");
  title.textContent = d.subject;
  head.appendChild(title);

  if (d.body.trim()) {
    const body = el("div", "gh-body-md cmt-body");
    body.innerHTML = renderMarkdown(d.body);
    head.appendChild(body);
  }
  head.appendChild(identity(d));

  // Ref chips: which branches and tags sit on this commit.
  if (d.refs.length) {
    const refs = el("div", "cmt-refs");
    for (const r of d.refs) {
      const chip = span(r.name, `cmt-ref is-${r.kind}`);
      chip.title = `${r.kind === "tag" ? "tag" : "branch"} ${r.name}`;
      refs.appendChild(chip);
    }
    head.appendChild(refs);
  }
  main.replaceChildren(head);

  // ── the changed files — the whole point ───────────────────────────────────
  const { adds, dels, binary } = diffstat(d.files);
  const statBar = el("div", "cmt-statbar");
  const n = d.files.length;
  statBar.append(
    span(`${n} file${n === 1 ? "" : "s"} changed`, "cmt-stat-files"),
    span(`+${adds.toLocaleString()}`, "cmt-stat-add"),
    span(`−${dels.toLocaleString()}`, "cmt-stat-del"),
  );
  if (binary) statBar.appendChild(span(`${binary} binary`, "cmt-stat-bin"));
  main.appendChild(statBar);

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
    const list = el("div", "cmt-files");
    const pane = el("div", "cmt-diff");
    split.append(list, pane);
    main.appendChild(split);

    const diff = new DiffPanel(pane);
    diff.showEmpty("Select a file to see what changed.");
    // The parent this commit is diffed against. A root commit has none, and
    // git's empty-tree hash is the standard stand-in.
    const base = d.parents[0] ?? "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

    let selected: HTMLElement | undefined;
    let gen = 0;
    const openFile = async (f: CommitFileChange, row: HTMLElement): Promise<void> => {
      selected?.classList.remove("is-current");
      selected = row;
      row.classList.add("is-current");
      // Click a large file then a small one and the large response can land
      // last, painting over the selection — the same staleness guard every
      // other diff surface here uses.
      const mine = ++gen;
      const fd = await host
        .invoke("compare:fileDiff", { base, head: d!.sha, path: f.path })
        .catch(() => undefined);
      if (mine !== gen) return;
      if (fd) diff.showDiff(fd);
      else diff.showEmpty(`Couldn't read the diff for ${f.path}.`);
    };

    d.files.forEach((f, i) => {
      const row = el("button", "cmt-file") as HTMLButtonElement;
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
      if (i === 0) void openFile(f, row);
    });
  }

  // ── rail ──────────────────────────────────────────────────────────────────
  const shaRow = el("div", "cmt-sha-row");
  const shaBtn = el("button", "cmt-sha") as HTMLButtonElement;
  shaBtn.textContent = d.shortSha;
  shaBtn.title = `${d.sha}\nCopy the full SHA`;
  shaBtn.setAttribute("aria-label", `Copy the full SHA ${d.sha}`);
  shaBtn.addEventListener("click", () => void host.invoke("clipboard:write", d!.sha));
  shaRow.appendChild(shaBtn);
  const shaProp = propSection("Commit");
  shaProp.body.appendChild(shaRow);
  rail.appendChild(shaProp.root);

  if (d.parents.length) {
    const box = el("div", "cmt-parents");
    for (const p of d.parents) {
      const b = el("button", "cmt-parent") as HTMLButtonElement;
      b.textContent = p.slice(0, 7);
      b.title = `Open parent ${p}`;
      b.addEventListener("click", () => nav("commit", { sha: p }));
      box.appendChild(b);
    }
    const pProp = propSection(d.parents.length > 1 ? `Parents (${d.parents.length})` : "Parent");
    pProp.body.appendChild(box);
    rail.appendChild(pProp.root);
  }

  // The reason to read a commit HERE rather than on github.com: the repository
  // is in hand, so these are real operations rather than links. Reachable today
  // only by right-clicking inside the graph's shadow DOM.
  const verbs: Array<{ id: string; label: string; danger?: boolean }> = [
    { id: "checkout", label: "Check out this commit" },
    { id: "branch", label: "Branch from here…" },
    { id: "tag", label: "Tag this commit…" },
    { id: "cherry-pick", label: "Cherry-pick onto current branch" },
    { id: "revert", label: "Revert this commit" },
  ];
  const acts = el("div", "cmt-verbs");
  for (const v of verbs) {
    const b = el("button", `mini-btn${v.danger ? " danger" : ""}`) as HTMLButtonElement;
    b.textContent = v.label;
    b.addEventListener("click", () => {
      void host.invoke("commit:action", { action: v.id, sha: d!.sha } as never);
    });
    acts.appendChild(b);
  }
  const aProp = propSection("Actions");
  aProp.body.appendChild(acts);
  rail.appendChild(aProp.root);

  // Kept as an explicit action rather than the destination: the graph is a good
  // place to see a commit's SHAPE, just not a good answer to "what changed".
  const inGraph = el("button", "mini-btn") as HTMLButtonElement;
  inGraph.append(glyph("git-commit"), span("Show in the graph"));
  inGraph.addEventListener("click", () => nav("graph", { sha: d!.sha }));
  topActions.appendChild(inGraph);
}
