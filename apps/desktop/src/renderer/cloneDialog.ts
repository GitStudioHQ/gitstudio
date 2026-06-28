// Clone / browse-GitHub-repos dialog — a focus-trapping modal with two paths:
//  1. "URL" tab: paste an HTTPS or SSH git URL.
//  2. "GitHub" tab: search + pick from the signed-in user's repositories
//     (github:repos), with HTTPS/SSH toggle.
// In both, "Choose…" picks the parent directory (clone:pickDir) and "Clone"
// runs clone:start, showing live progress (clone:progress). On success it calls
// `onCloned(root)` so the shell can open the freshly-cloned repo.
//
// CONTRACT (keep this signature — renderer.ts + the welcome screen call it):
//   openCloneDialog(onCloned: (root: string) => void): void
//
// The focus-trap / Escape / backdrop-click / focus-restore scaffold mirrors
// `modal()` in ./dialogs (which isn't exported), so this self-contained module
// matches that a11y behaviour exactly.

import { toast } from "./dialogs";
import { host } from "./bridge";
import {
  el,
  span,
  glyph,
  loadingState,
  emptyState,
  relTimeISO,
  cleanErr,
} from "./ui";
import type { GhRepoBrief } from "../shared/ipc";

type Tab = "url" | "github";
type Scheme = "https" | "ssh";

/** Open the clone modal. On a successful clone, `onCloned(root)` is called. */
export function openCloneDialog(onCloned: (root: string) => void): void {
  // ── modal scaffold (mirrors ./dialogs modal(): focus-trap, Esc, backdrop) ──
  const prevFocus = document.activeElement as HTMLElement | null;
  const overlay = el("div", "modal-overlay");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Clone a repository");

  const card = el("div", "modal-card clone-card");

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (offProgress) offProgress();
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
    prevFocus?.focus?.();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      // While a clone is in flight, dismissing would orphan the clone and still
      // fire onCloned() on completion — match the busy-guarded backdrop click.
      if (busy) return;
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    const f = Array.from(
      card.querySelectorAll<HTMLElement>(
        "button, input, [tabindex]:not([tabindex='-1'])",
      ),
    ).filter((n) => !n.hasAttribute("disabled") && n.offsetParent !== null);
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // ── state ────────────────────────────────────────────────────────────────
  let tab: Tab = "url";
  let scheme: Scheme = "https";
  let parentDir = "";
  let busy = false;
  let offProgress: (() => void) | null = null;
  /** The repo selected on the GitHub tab (drives the SSH/HTTPS toggle). */
  let selectedRepo: GhRepoBrief | null = null;
  let searchSeq = 0;

  // ── header: title + segmented tab switch ───────────────────────────────────
  const h = el("div", "modal-title");
  h.textContent = "Clone a repository";

  const tabs = el("div", "gh-seg clone-tabs");
  tabs.setAttribute("role", "tablist");
  const urlTabBtn = el("button", "gh-seg-btn");
  urlTabBtn.setAttribute("role", "tab");
  urlTabBtn.append(glyph("link"), span("URL"));
  const ghTabBtn = el("button", "gh-seg-btn");
  ghTabBtn.setAttribute("role", "tab");
  ghTabBtn.append(glyph("github"), span("GitHub"));
  tabs.append(urlTabBtn, ghTabBtn);

  // ── URL panel ──────────────────────────────────────────────────────────────
  const urlPanel = el("div", "clone-panel");
  urlPanel.setAttribute("role", "tabpanel");
  const urlInput = document.createElement("input");
  urlInput.className = "modal-input clone-url-input";
  urlInput.placeholder =
    "https://github.com/owner/repo.git  or  git@github.com:owner/repo.git";
  urlInput.setAttribute("aria-label", "Git repository URL");
  urlInput.spellcheck = false;
  urlInput.autocapitalize = "off";
  urlInput.addEventListener("input", refreshClone);
  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !primary.hasAttribute("disabled")) {
      e.preventDefault();
      void runClone();
    }
  });
  urlPanel.append(urlInput);

  // ── GitHub panel ───────────────────────────────────────────────────────────
  const ghPanel = el("div", "clone-panel clone-gh");
  ghPanel.setAttribute("role", "tabpanel");
  ghPanel.hidden = true;

  const ghSearch = document.createElement("input");
  ghSearch.className = "modal-input clone-search";
  ghSearch.placeholder = "Search your repositories…";
  ghSearch.setAttribute("aria-label", "Search your GitHub repositories");
  ghSearch.spellcheck = false;
  ghSearch.autocapitalize = "off";

  const ghList = el("div", "clone-repo-list");
  ghList.setAttribute("role", "listbox");
  ghList.setAttribute("aria-label", "Your repositories");

  // HTTPS / SSH toggle for the chosen repo.
  const schemeSeg = el("div", "gh-seg clone-scheme");
  schemeSeg.setAttribute("role", "group");
  schemeSeg.setAttribute("aria-label", "Clone protocol");
  const httpsBtn = el("button", "gh-seg-btn");
  httpsBtn.textContent = "HTTPS";
  const sshBtn = el("button", "gh-seg-btn");
  sshBtn.textContent = "SSH";
  schemeSeg.append(httpsBtn, sshBtn);
  schemeSeg.hidden = true;

  ghPanel.append(ghSearch, ghList, schemeSeg);

  // ── footer: destination + progress + actions ───────────────────────────────
  const destRow = el("div", "clone-dest");
  const destLabel = el("div", "clone-dest-label");
  destLabel.textContent = "Destination";
  const destValue = el("div", "clone-dest-path");
  destValue.textContent = "No folder chosen";
  const chooseBtn = el("button", "mini-btn clone-choose");
  chooseBtn.append(glyph("folder-opened"), span("Choose…"));
  chooseBtn.addEventListener("click", () => void pickDir());
  const destText = el("div", "clone-dest-text");
  destText.append(destLabel, destValue);
  destRow.append(destText, chooseBtn);

  const progress = el("div", "clone-progress");
  progress.hidden = true;
  const progBar = el("div", "clone-progress-bar");
  const progFill = el("div", "clone-progress-fill");
  progBar.appendChild(progFill);
  const progPhase = el("div", "clone-progress-phase");
  progress.setAttribute("role", "status");
  progress.setAttribute("aria-live", "polite");
  progress.append(progPhase, progBar);

  const actions = el("div", "modal-actions clone-actions");
  const cancel = el("button", "mini-btn");
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", close);
  const primary = el("button", "btn btn-primary modal-ok clone-go");
  const primaryLabel = span("Clone");
  primary.append(primaryLabel);
  primary.setAttribute("disabled", "true");
  primary.addEventListener("click", () => void runClone());
  actions.append(cancel, primary);

  card.append(h, tabs, urlPanel, ghPanel, destRow, progress, actions);
  overlay.appendChild(card);

  // ── tab switching ──────────────────────────────────────────────────────────
  function setTab(next: Tab): void {
    if (busy) return;
    tab = next;
    urlTabBtn.classList.toggle("active", next === "url");
    ghTabBtn.classList.toggle("active", next === "github");
    urlTabBtn.setAttribute("aria-selected", String(next === "url"));
    ghTabBtn.setAttribute("aria-selected", String(next === "github"));
    urlPanel.hidden = next !== "url";
    ghPanel.hidden = next !== "github";
    refreshClone();
    if (next === "github") {
      if (!loadedOnce) void loadRepos(ghSearch.value.trim());
      setTimeout(() => ghSearch.focus(), 0);
    } else {
      setTimeout(() => urlInput.focus(), 0);
    }
  }
  urlTabBtn.addEventListener("click", () => setTab("url"));
  ghTabBtn.addEventListener("click", () => setTab("github"));

  // ── GitHub repo loading + rendering ────────────────────────────────────────
  let loadedOnce = false;
  let searchTimer = 0;
  ghSearch.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(
      () => void loadRepos(ghSearch.value.trim()),
      220,
    );
  });

  async function loadRepos(search: string): Promise<void> {
    loadedOnce = true;
    const seq = ++searchSeq;
    ghList.replaceChildren(loadingState("Loading your repositories…"));
    // Don't call github:repos while signed out (it throws + spams the log) —
    // check the connection first and prompt the user to sign in instead.
    try {
      const status = await host.invoke("github:status", undefined);
      if (seq !== searchSeq) return;
      if (!status.connected) {
        ghList.replaceChildren(
          emptyState(
            "Connect GitHub",
            "Sign in from the account button at the top of the window to browse and clone your repositories.",
            { icon: "github" },
          ),
        );
        return;
      }
    } catch {
      /* status check failed — fall through and let the repos call surface it */
    }
    let repos: GhRepoBrief[];
    try {
      repos = await host.invoke("github:repos", search ? { search } : undefined);
    } catch (e) {
      if (seq !== searchSeq) return;
      ghList.replaceChildren(
        emptyState(
          "Couldn't load repositories",
          cleanErr(e) ||
            "Connect your GitHub account in Settings, then try again.",
        ),
      );
      return;
    }
    if (seq !== searchSeq) return;
    if (!repos.length) {
      ghList.replaceChildren(
        emptyState(
          search ? "No matching repositories" : "No repositories found",
          search
            ? "Try a different search term."
            : "Sign in to GitHub in Settings to browse your repositories.",
        ),
      );
      return;
    }
    ghList.replaceChildren(...repos.map(repoRow));
  }

  function repoRow(repo: GhRepoBrief): HTMLElement {
    const row = el("button", "list-row clone-repo");
    row.setAttribute("role", "option");

    const main = el("div", "clone-repo-main");
    const name = el("div", "clone-repo-name");
    name.textContent = repo.fullName;
    if (repo.private) name.append(badge("Private"));
    if (repo.fork) name.append(badge("Fork"));
    main.appendChild(name);
    if (repo.description) {
      const desc = el("div", "clone-repo-desc");
      desc.textContent = repo.description;
      main.appendChild(desc);
    }

    const meta = el("div", "clone-repo-meta");
    if (repo.stars > 0) meta.append(metaBit("★ " + repo.stars));
    if (repo.language) meta.append(metaBit(repo.language));
    const rel = relTimeISO(repo.updatedAt);
    if (rel) meta.append(metaBit("Updated " + rel));
    if (meta.childElementCount) main.appendChild(meta);

    row.appendChild(main);
    row.addEventListener("click", () => selectRepo(repo, row));
    return row;
  }

  function selectRepo(repo: GhRepoBrief, row: HTMLElement): void {
    selectedRepo = repo;
    for (const n of ghList.querySelectorAll(".clone-repo.is-current")) {
      n.classList.remove("is-current");
      n.removeAttribute("aria-selected");
    }
    row.classList.add("is-current");
    row.setAttribute("aria-selected", "true");
    schemeSeg.hidden = false;
    syncSchemeButtons();
    refreshClone();
  }

  function syncSchemeButtons(): void {
    httpsBtn.classList.toggle("active", scheme === "https");
    sshBtn.classList.toggle("active", scheme === "ssh");
    httpsBtn.setAttribute("aria-pressed", String(scheme === "https"));
    sshBtn.setAttribute("aria-pressed", String(scheme === "ssh"));
  }
  httpsBtn.addEventListener("click", () => {
    scheme = "https";
    syncSchemeButtons();
    refreshClone();
  });
  sshBtn.addEventListener("click", () => {
    scheme = "ssh";
    syncSchemeButtons();
    refreshClone();
  });
  syncSchemeButtons();

  // ── chosen clone target + folder name ──────────────────────────────────────
  function chosenUrl(): string {
    if (tab === "url") return urlInput.value.trim();
    if (!selectedRepo) return "";
    return scheme === "ssh" ? selectedRepo.sshUrl : selectedRepo.cloneUrl;
  }

  /** Derive the target folder name from the URL (so it's stable + predictable). */
  function targetName(url: string): string | undefined {
    const m = url.match(/([^/:]+?)(?:\.git)?\/?\s*$/);
    return m ? m[1] : undefined;
  }

  async function pickDir(): Promise<void> {
    if (busy) return;
    try {
      const dir = await host.invoke("clone:pickDir", undefined);
      if (dir) {
        parentDir = dir;
        destValue.textContent = dir;
        destValue.title = dir;
        refreshClone();
      }
    } catch (e) {
      toast(cleanErr(e) || "Couldn't choose a folder.", "error");
    }
  }

  function refreshClone(): void {
    const ready = !busy && !!chosenUrl() && !!parentDir;
    if (ready) primary.removeAttribute("disabled");
    else primary.setAttribute("disabled", "true");
  }

  // ── progress + run ─────────────────────────────────────────────────────────
  function updateBar(percent: number | undefined, label: string): void {
    progress.hidden = false;
    if (typeof percent === "number" && Number.isFinite(percent)) {
      progFill.classList.remove("indeterminate");
      progFill.style.width = Math.max(0, Math.min(100, percent)) + "%";
    } else {
      progFill.classList.add("indeterminate");
      progFill.style.width = "100%";
    }
    progPhase.textContent = label || "Cloning…";
  }

  function setBusy(on: boolean): void {
    busy = on;
    card.classList.toggle("is-busy", on);
    for (const ctl of [
      urlInput,
      ghSearch,
      urlTabBtn,
      ghTabBtn,
      httpsBtn,
      sshBtn,
      chooseBtn,
      cancel,
    ]) {
      if (on) ctl.setAttribute("disabled", "true");
      else ctl.removeAttribute("disabled");
    }
    ghList.classList.toggle("is-disabled", on);
    if (on) {
      primary.setAttribute("disabled", "true");
      primary.classList.add("is-loading");
      primaryLabel.textContent = "Cloning…";
    } else {
      primary.classList.remove("is-loading");
      primaryLabel.textContent = "Clone";
      refreshClone();
    }
  }

  async function runClone(): Promise<void> {
    if (busy) return;
    const url = chosenUrl();
    if (!url || !parentDir) return;
    const name = targetName(url);

    setBusy(true);
    updateBar(undefined, "Preparing…");
    offProgress = host.on("clone:progress", (p) =>
      updateBar(p.percent, p.phase || p.raw),
    );

    let res;
    try {
      res = await host.invoke("clone:start", { url, parentDir, name });
    } catch (e) {
      offProgress?.();
      offProgress = null;
      toast(cleanErr(e) || "Clone failed.", "error");
      progress.hidden = true;
      setBusy(false);
      return;
    }
    offProgress?.();
    offProgress = null;

    if (res.ok && res.root) {
      const root = res.root;
      toast("Cloned " + (name || "repository"), "success");
      close();
      onCloned(root);
    } else {
      toast(res.message || "Clone failed.", "error");
      progress.hidden = true;
      setBusy(false);
    }
  }

  // ── mount ──────────────────────────────────────────────────────────────────
  document.body.appendChild(overlay);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay && !busy) close();
  });
  document.addEventListener("keydown", onKey, true);
  setTab("url");
}

/** A tiny inline badge appended to a repo's name (Private / Fork). */
function badge(text: string): HTMLElement {
  const b = span(text, "clone-repo-badge");
  return b;
}

/** One dot-separated meta fragment (★ stars · language · updated …). */
function metaBit(text: string): HTMLElement {
  return span(text, "clone-meta-bit");
}
