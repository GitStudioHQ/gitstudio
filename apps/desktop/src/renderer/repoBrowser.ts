// Browse a REMOTE GitHub repository in-app, without cloning — folders, files,
// and the rendered README, as drillable wide peek cards. This kills the app's
// worst dead-end: an org repo used to show a metadata card whose only real
// continuations were "Clone" or "go to github.com". Now the repo list is a
// place you can actually read code, and Clone is one click away once a repo
// earns it.
//
// Cards stack (repo → folder → file), so ← / Esc walk back out naturally.

import { fileLines } from "./textFit";
import { host } from "./bridge";
import { openPeek, peekChip, peekSection, type PeekCard, type PeekContext } from "./peek";
import { el, span, glyph, fileIcon, formatBytes, cleanErr } from "./ui";
import { renderMarkdown } from "./markdown";
import { openCloneDialog } from "./cloneDialog";
import { resolveRelative, wireProseNav } from "./proseNav";
import { openGhRepoInApp, openGhRepoChooseLocation } from "./ghOpen";
import { highlightCode } from "./highlight";
import type { GhRepoEntry } from "../shared/ipc";

/** Open the browser fresh (root of the repo). */
export function openRemoteRepoBrowser(fullName: string): void {
  openPeek(repoDirCard(fullName, ""));
}

/** Split "owner/repo" into the shape proseNav wants for #123 resolution. */
function ownerRepoOf(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split("/", 2);
  return { owner, repo };
}

/**
 * A directory card — the repo root (with README below the listing) or any
 * subfolder. Exported so the org repo peek can PUSH it onto its own stack.
 */
export function repoDirCard(fullName: string, path: string): PeekCard {
  const atRoot = !path;
  return {
    icon: atRoot ? "repo" : "folder",
    title: atRoot ? fullName : path.split("/").pop()!,
    chips: atRoot ? [peekChip("no clone needed", "accent")] : [],
    subtitle: atRoot ? "Reading straight from GitHub" : `${fullName}/${path}`,
    wide: true,
    actions: [
      {
        label: "Open on GitHub",
        icon: "link-external",
        onClick: () =>
          window.open(
            `https://github.com/${fullName}${path ? `/tree/HEAD/${path}` : ""}`,
            "_blank",
          ),
      },
      {
        label: "Clone…",
        icon: "repo-clone",
        title: "Clone to a folder you choose",
        onClick: (ctx) => {
          ctx.close();
          openCloneDialog((root) => void host.invoke("repo:openPath", root), {
            url: `https://github.com/${fullName}.git`,
          });
        },
      },
      {
        label: "Choose location…",
        icon: "folder-opened",
        title: `Pick the folder ${fullName} is cloned into, then open it`,
        onClick: () => openGhRepoChooseLocation(fullName),
      },
      {
        label: "Open as repo",
        icon: "folder-library",
        primary: true,
        title: `Open ${fullName} in GitStudio as a full repo (clones itself on first open)`,
        onClick: () => openGhRepoInApp(fullName),
      },
    ],
    async render(body, ctx) {
      let entries: GhRepoEntry[];
      try {
        entries = await host.invoke("ghrepo:tree", { fullName, path });
      } catch (e) {
        body.replaceChildren(browseError(fullName, e));
        return;
      }
      body.replaceChildren();
      const { root, body: lbody } = peekSection(atRoot ? "Files" : path, entries.length);
      for (const entry of entries) lbody.appendChild(entryRow(fullName, entry, ctx));
      if (!entries.length) {
        const none = el("div", "peek-row");
        none.appendChild(span("This folder is empty.", "peek-row-sub"));
        lbody.appendChild(none);
      }
      body.appendChild(root);

      // The README belongs on the root listing, rendered with THE prose system
      // — the same reading experience as github.com, not a wall of small text.
      if (atRoot) {
        const readme = await host.invoke("ghrepo:readme", fullName).catch(() => undefined);
        if (!readme || !body.isConnected) return;
        const { root: rroot, body: rbody } = peekSection(readme.name);
        rbody.classList.add("peek-readme");
        const prose = el("div", "gh-body-md");
        try {
          prose.innerHTML = renderMarkdown(readme.text);
          // #123 and github.com links resolve against the BROWSED repo, and
          // RELATIVE links ("./docs/x.md") open right here as more cards.
          wireProseNav(prose, undefined, ownerRepoOf(fullName), (rel) =>
            ctx.push(cardForPath(fullName, resolveRelative("", rel))),
          );
        } catch {
          prose.textContent = readme.text;
        }
        rbody.appendChild(prose);
        body.appendChild(rroot);
      }
    },
  };
}

/** Best-guess card for a resolved relative path: an extension means a file,
 *  anything else a folder — a wrong guess still lands on a sensible error. */
function cardForPath(fullName: string, path: string): PeekCard {
  const last = path.split("/").pop() ?? "";
  return /\.[A-Za-z0-9]{1,8}$/.test(last)
    ? repoFileCard(fullName, path)
    : repoDirCard(fullName, path);
}

function entryRow(fullName: string, entry: GhRepoEntry, ctx: PeekContext): HTMLElement {
  const row = el("button", "peek-row");
  row.appendChild(glyph(fileIcon(entry.name, entry.type === "dir")));
  const main = el("div", "peek-row-main");
  const title = el("div", "peek-row-title");
  title.textContent = entry.name;
  main.appendChild(title);
  row.appendChild(main);
  const side = el("div", "peek-row-side");
  if (entry.type === "file" && entry.size) side.appendChild(span(formatBytes(entry.size)));
  const chev = glyph("chevron-right");
  chev.classList.add("peek-row-chev");
  side.appendChild(chev);
  row.appendChild(side);
  row.addEventListener("click", () =>
    ctx.push(
      entry.type === "dir" ? repoDirCard(fullName, entry.path) : repoFileCard(fullName, entry.path),
    ),
  );
  return row;
}

/** A file card: markdown renders as prose; code shows mono with a line gutter;
 *  binary/oversized files get a notice instead of garbage. */
function repoFileCard(fullName: string, path: string): PeekCard {
  const name = path.split("/").pop()!;
  return {
    icon: fileIcon(name),
    title: name,
    subtitle: `${fullName}/${path}`,
    wide: true,
    actions: [
      {
        label: "Open on GitHub",
        icon: "link-external",
        onClick: () => window.open(`https://github.com/${fullName}/blob/HEAD/${path}`, "_blank"),
      },
    ],
    async render(body, ctx) {
      let f;
      try {
        f = await host.invoke("ghrepo:file", { fullName, path });
      } catch (e) {
        body.replaceChildren(browseError(fullName, e));
        return;
      }
      body.replaceChildren();
      if (f.binary || f.truncated) {
        const notice = el("div", "peek-empty");
        notice.append(
          glyph(f.binary ? "file-binary" : "file"),
          span(
            f.binary
              ? `This is a binary file (${formatBytes(f.size)}) — nothing to read inline.`
              : `This file is too large for a quick look (${formatBytes(f.size)}). Open it on GitHub or clone the repo.`,
          ),
        );
        body.appendChild(notice);
        return;
      }
      if (/\.(md|markdown|mdx)$/i.test(name)) {
        const prose = el("div", "gh-body-md");
        try {
          prose.innerHTML = renderMarkdown(f.text);
          const baseDir = path.split("/").slice(0, -1).join("/");
          wireProseNav(prose, undefined, ownerRepoOf(fullName), (rel) =>
            ctx.push(cardForPath(fullName, resolveRelative(baseDir, rel))),
          );
        } catch {
          prose.textContent = f.text;
        }
        body.appendChild(prose);
        return;
      }
      body.appendChild(codeBlock(f.text, name));
    },
  };
}

/** Render code with a line-number gutter. Capped so a giant minified file
 *  can't lock the UI — the cap is announced, never silent. */
const MAX_RENDER_LINES = 5000;
function codeBlock(text: string, fileName: string): HTMLElement {
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
  if (lines.length > shown.length) {
    const more = el("div", "ghfile-more");
    more.textContent = `Showing the first ${MAX_RENDER_LINES.toLocaleString()} of ${lines.length.toLocaleString()} lines.`;
    const outer = el("div", "ghfile-outer");
    outer.append(wrap, more);
    return outer;
  }
  return wrap;
}

/** A browse failure with the WHY spelled out — most importantly the org
 *  OAuth-app restriction that GitHub reports as a bare 404, which used to
 *  read as "the app is broken, use the website". */
function browseError(fullName: string, e: unknown): HTMLElement {
  const msg = cleanErr(e);
  const wrap = el("div", "peek-empty");
  wrap.appendChild(glyph("warning"));
  const t = el("div");
  t.textContent = `Couldn't read ${fullName}: ${msg || "GitHub request failed."}`;
  wrap.appendChild(t);
  if (/not found|404/i.test(msg)) {
    const hint = el("div", "peek-row-sub");
    hint.style.maxWidth = "440px";
    hint.textContent =
      "If this repo belongs to an organization, the org may restrict OAuth-app access. An org owner can approve GitStudio under Settings → Third-party access on github.com — after that, everything here works.";
    wrap.appendChild(hint);
  }
  return wrap;
}
