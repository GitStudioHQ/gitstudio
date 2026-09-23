// The concrete peek cards for git objects — branch, remote branch, tag, commit,
// stash. This is what makes every row in the native sections BROWSABLE: click a
// branch and you're reading its history; click a commit inside and you've
// drilled into its files; ← walks back out. Actions that change the repo are
// delegated to the App through GitPeekHost so refresh/toast behavior stays in
// one place; read-only data loads straight over IPC here.

import { host } from "./bridge";
import {
  openPeek,
  peekChip,
  peekMetaGrid,
  peekSection,
  type PeekCard,
  type PeekContext,
} from "./peek";
import { el, span, glyph, relTime, absTime, avatarHue, initials, copyText } from "./ui";
import { toast, confirmDialog } from "./dialogs";
import type {
  BranchInfo,
  CompareCommit,
  RefInfo,
  StashInfo,
  CommitDetailsPayload,
} from "../shared/ipc";
import type { CommitFileChange } from "@gitstudio/host-bridge/commitDetailsProtocol";

/** The App-owned operations a peek card can trigger. Every mutation funnels
 *  through here so cache-busting, toasts, and view refreshes stay centralized. */
export interface GitPeekHost {
  /** Check out a local branch / remote branch / tag by its FULL name
   *  ("refs/heads/x") — the namespace decides what the checkout means, and a
   *  short name beside a tag of the same name would detach. */
  checkout(fullName: string): void;
  /** The existing per-branch ⋯ actions menu, anchored to a peek button. */
  branchMenu(b: BranchInfo, anchor: HTMLElement): void;
  /** Open the Compare view with the current branch as base and `head` as head. */
  compareWith(head: string): void;
  /** Jump to a commit in the Commits view (switching views if needed). */
  revealInGraph(sha: string): void;
  /** Jump to a ref's row in the Branches view (scroll + flash). */
  openBranch(ref: string): void;
  /** Open one commit file's diff in the bottom dock (after a graph reveal). */
  openCommitFile(file: { path: string; status: string }, sha: string): void;
  /** A stash was applied/popped/dropped — refresh whatever shows stashes. */
  stashesChanged(): void;
}

// ── shared row builders ──────────────────────────────────────────────────────

/** A tiny deterministic author dot (same hue rules as the graph avatars). */
function authorDot(name: string): HTMLElement {
  const dot = el("span", "peek-avatar");
  dot.style.background = avatarHue(name);
  dot.textContent = initials(name);
  return dot;
}

/** One commit row inside a peek section; clicking drills into the commit. */
function commitRow(c: CompareCommit): HTMLElement {
  const row = el("button", "peek-row");
  row.append(authorDot(c.author));
  const main = el("div", "peek-row-main");
  const title = el("div", "peek-row-title");
  title.textContent = c.subject || "(no subject)";
  title.title = c.subject;
  const sub = el("div", "peek-row-sub");
  sub.textContent = `${c.author} · ${relTime(c.date)}`;
  sub.title = absTime(c.date);
  main.append(title, sub);
  row.appendChild(main);
  const side = el("div", "peek-row-side");
  side.append(span(c.shortSha), glyph("chevron-right"));
  side.lastElementChild?.classList.add("peek-row-chev");
  row.appendChild(side);
  return row;
}

/** Render a list of commits into a section, wiring each row to drill in. */
function commitsSection(
  gp: GitPeekHost,
  ctx: PeekContext,
  commits: CompareCommit[],
  label = "Recent commits",
): HTMLElement {
  const { root, body } = peekSection(label, commits.length);
  for (const c of commits) {
    const row = commitRow(c);
    row.addEventListener("click", () => ctx.push(commitCard(gp, c.sha, c)));
    body.appendChild(row);
  }
  if (!commits.length) {
    const none = el("div", "peek-row");
    none.appendChild(span("No commits to show.", "peek-row-sub"));
    body.appendChild(none);
  }
  return root;
}

/** One changed-file row. For real commits, clicking lands in Commits with this
 *  diff open; `nav: false` renders a read-only row (stashes aren't graph rows,
 *  so there is nowhere to navigate to). */
function fileRow(
  gp: GitPeekHost,
  ctx: PeekContext,
  f: CommitFileChange,
  sha: string,
  nav = true,
): HTMLElement {
  const row = el(nav ? "button" : "div", "peek-row");
  const st = (f.status || "M").toUpperCase().charAt(0);
  const cls = st === "A" ? "add" : st === "D" ? "del" : st === "R" || st === "C" ? "ren" : "mod";
  const letter = el("span", `peek-fstat ${cls}`);
  letter.textContent = st;
  row.appendChild(letter);
  const main = el("div", "peek-row-main");
  const title = el("div", "peek-row-title");
  title.textContent = f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
  title.title = title.textContent;
  main.appendChild(title);
  row.appendChild(main);
  const side = el("div", "peek-row-side");
  if (f.additions >= 0 || f.deletions >= 0) {
    const stat = el("span", "peek-diffstat");
    if (f.additions > 0) stat.appendChild(span(`+${f.additions}`, "plus"));
    if (f.deletions > 0) stat.appendChild(span(`−${f.deletions}`, "minus"));
    if (stat.childElementCount) side.appendChild(stat);
  }
  if (nav) {
    const chev = glyph("chevron-right");
    chev.classList.add("peek-row-chev");
    side.appendChild(chev);
    row.title = `Open ${f.path} in Commits`;
    row.addEventListener("click", () => {
      ctx.close();
      gp.revealInGraph(sha);
      gp.openCommitFile({ path: f.path, status: f.status }, sha);
    });
  }
  row.appendChild(side);
  return row;
}

// ── the commit card ──────────────────────────────────────────────────────────

/** A commit's drill-in card. `brief` (when the opener already had the row data)
 *  gives the header its real title synchronously; otherwise the sha stands in
 *  until the details load and retitle the card. */
export function commitCard(gp: GitPeekHost, sha: string, brief?: CompareCommit): PeekCard {
  return {
    icon: "git-commit",
    title: brief?.subject || `Commit ${sha.slice(0, 7)}`,
    subtitle: brief ? `${brief.author} · ${relTime(brief.date)}` : sha.slice(0, 7),
    actions: [
      {
        label: "Copy SHA",
        icon: "copy",
        onClick: () => void copyText(sha, "Commit SHA copied."),
      },
      {
        label: "View in Commits",
        icon: "git-commit",
        primary: true,
        title: "Reveal this commit in the Commits view",
        onClick: (ctx) => {
          ctx.close();
          gp.revealInGraph(sha);
        },
      },
    ],
    async render(body, ctx) {
      const d: CommitDetailsPayload | undefined = await host.invoke("commit:details", sha);
      body.replaceChildren();
      if (!d) {
        const none = el("div", "peek-empty");
        none.append(glyph("git-commit"), span("This commit couldn't be loaded."));
        body.appendChild(none);
        return;
      }
      ctx.retitle(d.subject || `Commit ${d.shortSha}`, `${d.author} · ${relTime(d.authorDate)}`);

      const shaVal = el("span", "peek-mono");
      shaVal.textContent = d.shortSha;
      shaVal.title = d.sha;
      const parents = el("span");
      for (const p of d.parents) {
        const chip = el("button", "peek-parent");
        chip.textContent = p.slice(0, 7);
        chip.title = `Peek parent ${p.slice(0, 7)}`;
        chip.addEventListener("click", () => ctx.push(commitCard(gp, p)));
        parents.appendChild(chip);
      }
      const meta: Array<[string, string | HTMLElement]> = [
        ["Commit", shaVal],
        ["Author", `${d.author} <${d.authorEmail}>`],
        ["Date", absTime(d.authorDate)],
      ];
      if (d.committer && d.committer !== d.author) {
        meta.push(["Committer", `${d.committer} <${d.committerEmail}>`]);
      }
      if (d.parents.length) meta.push([d.parents.length > 1 ? "Parents" : "Parent", parents]);
      if (d.refs.length) {
        const refs = el("span");
        for (const r of d.refs) {
          // Ref chips NAVIGATE: clicking one lands on that ref's row in the
          // Branches view (scrolled + flashed) — every label is a link.
          const chip = el("button", "peek-refchip");
          chip.appendChild(
            peekChip(r.name, r.kind === "tag" ? "warn" : r.kind === "currentHead" ? "accent" : "muted"),
          );
          chip.title = `Show ${r.name} in Branches`;
          chip.addEventListener("click", () => {
            ctx.close();
            gp.openBranch(r.name);
          });
          refs.appendChild(chip);
        }
        meta.push(["Refs", refs]);
      }
      body.appendChild(peekMetaGrid(meta));

      const msg = el("pre", "peek-msg");
      msg.textContent = d.body ? `${d.subject}\n\n${d.body}` : d.subject;
      body.appendChild(msg);

      const { root, body: fbody } = peekSection("Changed files", d.files.length);
      for (const f of d.files) fbody.appendChild(fileRow(gp, ctx, f, d.sha));
      if (!d.files.length) {
        const none = el("div", "peek-row");
        none.appendChild(span("No files changed.", "peek-row-sub"));
        fbody.appendChild(none);
      }
      body.appendChild(root);
    },
  };
}

// ── branch / remote / tag cards ──────────────────────────────────────────────

/*
 * `openBranchPeek`, `openRefPeek` and `openStashPeek` lived here.
 *
 * A ref's history was a modal: no route, no entry in the back stack, no
 * ⌘[ / ⌘], and gone on Escape. Worse, for a remote branch, a tag and a stash
 * that modal was the ONLY door to every action those rows had, because none of
 * them carried any. Each kind has a PAGE now — `views/refDetail.ts`, routed as
 * "refdetail" — and the rows carry their verbs at rest.
 */
