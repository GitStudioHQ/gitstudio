// Make rendered markdown NAVIGATE instead of eject. Every prose surface
// (README cards, PR/issue bodies, comments, release notes) is full of GitHub
// links and bare #123 references; they all used to bounce to the browser —
// the single biggest "features acting separated" seam. Wired through here:
//
//   • a link to an issue/PR in the OPEN repo  → the in-app section, deep-linked
//   • a link to an issue/PR in ANY OTHER repo → the in-app read-only viewer
//   • bare `#123` text                        → clickable, same rules
//   • anything else                           → the browser, as before
//
// One delegated listener per container; re-rendered bodies need no re-wiring.

import { host } from "./bridge";
import { highlightProse } from "./highlight";
import { parseGitHubItemUrl } from "./ui";
import { openExternalItem } from "./views/notifications";
import type { SectionNav } from "./views/common";

/** Wire a rendered-markdown container — ONCE, on a stable pane. A
 *  MutationObserver keeps re-rendered bodies linkified, so callers never
 *  re-wire. `nav` routes same-repo items to their section; without it
 *  (surfaces outside the section system) everything opens in the read-only
 *  viewer. `refRepo` overrides which repo a bare `#123` belongs to (a browsed
 *  remote repo's README means ITS issues, not the open repo's). */
export function wireProseNav(
  container: HTMLElement,
  nav?: SectionNav,
  refRepo?: { owner: string; repo: string },
  /** Handle RELATIVE links (README "./docs/x.md") — without this they were
   *  silently dead (blocked navigation, no browser, nothing). The handler
   *  receives the raw relative path; resolve it with resolveRelative(). */
  onRelative?: (path: string) => void,
): void {
  // Bare-#N linkification only when there's a repo to resolve them against —
  // otherwise the "link" was a styled dead click. Absolute-URL handling below
  // never needs this gate.
  let refsEnabled = !!refRepo;
  if (refsEnabled) linkifyIssueRefs(container);
  else {
    void host
      .invoke("github:status", undefined)
      .then((s) => {
        if (s.repo && container.isConnected) {
          refsEnabled = true;
          linkifyIssueRefs(container);
        }
      })
      .catch(() => {});
  }
  highlightProse(container);
  // Coalesce mutation work: N async colorize completions used to trigger N
  // full TreeWalker passes; one rAF batches them all.
  let scheduled = false;
  let mutating = false;
  const obs = new MutationObserver(() => {
    if (mutating || scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      mutating = true;
      try {
        if (refsEnabled) linkifyIssueRefs(container);
        highlightProse(container);
      } finally {
        mutating = false;
      }
    });
  });
  obs.observe(container, { childList: true, subtree: true });
  container.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest?.("a[href]");
    if (!(a instanceof HTMLAnchorElement) || !container.contains(a)) return;
    const href = a.getAttribute("href") ?? "";

    // Relative links first: they belong to the document's own repo.
    if (
      onRelative &&
      href &&
      !href.startsWith("#") &&
      !/^[a-z][a-z0-9+.-]*:/i.test(href) &&
      !href.startsWith("//")
    ) {
      e.preventDefault();
      e.stopPropagation();
      onRelative(href.split("#")[0].split("?")[0]);
      return;
    }

    // Bare #123 spans linkified below carry just the number.
    const refNum = a.dataset.ghref ? Number(a.dataset.ghref) : undefined;
    const hit = refNum ? undefined : parseGitHubItemUrl(href);
    // Commit links land in the Commits view when they're the open repo's.
    const commit = hit || refNum
      ? undefined
      : /github\.com\/([^/]+\/[^/]+?)\/commit\/([0-9a-f]{7,40})\b/i.exec(href);
    if (!hit && !refNum && !commit) return; // a normal link — default flow (browser)

    e.preventDefault();
    e.stopPropagation();
    void (async () => {
      let status: { connected: boolean; repo?: { owner: string; repo: string } };
      try {
        status = await host.invoke("github:status", undefined);
      } catch {
        status = { connected: false };
      }
      const open = status.repo ? `${status.repo.owner}/${status.repo.repo}`.toLowerCase() : "";

      if (refNum) {
        // #123 means "the repo this prose belongs to" — the browsed remote
        // repo when refRepo is set, otherwise the open repo. GitHub's issues
        // namespace covers PRs too, so Issues is always a safe landing.
        const home = refRepo ?? status.repo;
        if (!refRepo && nav && open) {
          nav("issues", { number: refNum });
        } else if (home && status.connected) {
          openExternalItem({
            owner: home.owner,
            repo: home.repo,
            number: refNum,
            kind: "issue",
            htmlUrl: `https://github.com/${home.owner}/${home.repo}/issues/${refNum}`,
          });
        }
        return;
      }
      if (commit) {
        if (nav && commit[1].toLowerCase() === open) nav("commit", { sha: commit[2] });
        else window.open(href, "_blank");
        return;
      }
      if (!hit) return;
      if (nav && hit.repo.toLowerCase() === open) {
        nav(hit.kind, { number: hit.number });
        return;
      }
      if (status.connected) {
        const [owner, repo] = hit.repo.split("/");
        openExternalItem({
          owner,
          repo,
          number: hit.number,
          kind: hit.kind === "prs" ? "pull" : "issue",
          htmlUrl: href,
        });
        return;
      }
      window.open(href, "_blank"); // signed out — the browser is all we have
    })();
  });
}

/** Resolve "./x", "../y", "docs/z" against a base DIRECTORY ("" = root). */
export function resolveRelative(baseDir: string, rel: string): string {
  const parts = baseDir ? baseDir.split("/").filter(Boolean) : [];
  for (const seg of rel.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

/** Turn bare `#123` text into clickable references — outside code, pre, and
 *  existing links. GitHub does this server-side; we do it at wire time. */
function linkifyIssueRefs(container: HTMLElement): void {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!/(^|\s)#\d+/.test(node.textContent ?? "")) return NodeFilter.FILTER_REJECT;
      for (let p = node.parentElement; p && p !== container; p = p.parentElement) {
        const tag = p.tagName;
        if (tag === "A" || tag === "CODE" || tag === "PRE" || tag === "KBD") {
          return NodeFilter.FILTER_REJECT;
        }
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) targets.push(n as Text);
  for (const text of targets) {
    const parts = (text.textContent ?? "").split(/(^#\d+\b|(?<=\s)#\d+\b)/);
    if (parts.length < 2) continue;
    const frag = document.createDocumentFragment();
    for (const part of parts) {
      const m = /^#(\d+)$/.exec(part);
      if (m) {
        const a = document.createElement("a");
        a.href = "#";
        a.dataset.ghref = m[1];
        a.textContent = part;
        a.title = `Open ${part} in GitStudio`;
        frag.appendChild(a);
      } else if (part) {
        frag.appendChild(document.createTextNode(part));
      }
    }
    text.replaceWith(frag);
  }
}
