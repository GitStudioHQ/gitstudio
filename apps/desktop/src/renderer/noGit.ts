// The window for a machine without Git.
//
// GitStudio runs the git installed on the machine (it does not bundle one), so
// without it nothing works — and before this screen the app did not say so.
// Every view failed on its own with Node's "spawn git ENOENT", a folder you
// opened was called a repository whose ".git folder may be damaged", and on a
// Mac without Apple's Command Line Tools the only explanation was the system's
// own install prompt. Now the window asks main (app:gitCheck, gitCheck.ts)
// before it builds anything, and when the answer is no it says what is wrong,
// how to fix it on this OS (noGitHelp.ts), and offers Check again — which,
// once Git answers, carries straight on into the app, tabs and all.

import { shellHost } from "./bridge";
import { el, glyph, span, copyText } from "./ui";
import { gitInstallHelp, type GitMissing } from "./noGitHelp";

/**
 * Ask main whether Git works, and when it does not, fill `root` with what to
 * do about it and resolve only once a Check again finds it. Resolves at once,
 * touching nothing, when Git is there — or when the answer is unreadable: a
 * window must never be held hostage by the check that exists to help it.
 *
 * Through `shellHost`, not `host`: the question is the window's, asked before
 * any tab exists, so it belongs to no tab and carries no tab's stamp. Sent the
 * tab way, it went out stamped "no repository", which reads as a call from
 * whichever tab is in front — a gone folder's tab included.
 */
export async function waitForGit(root: HTMLElement, onShown?: () => void): Promise<void> {
  const first = await shellHost.invoke("app:gitCheck", undefined).catch(() => undefined);
  if (!first || first.ok !== false) return;
  await new Promise<void>((done) => {
    render(root, first, done);
    // This screen is the app for now: whatever stood in front of the window
    // until the app was up (the launch screen) makes way for it here, not when
    // the wait for Git ends — which, without Git, it never would.
    onShown?.();
  });
}

function render(root: HTMLElement, git: GitMissing, done: () => void): void {
  const help = gitInstallHelp(git);
  // `.screen.welcome` is the full-window stage (and, on macOS, the window's
  // drag region, since this screen replaces the tab row that normally is).
  const screen = el("div", "screen welcome no-git");
  const card = el("div", "welcome-card no-git-card");
  const badge = el("div", "list-empty-badge");
  badge.appendChild(glyph("source-control"));
  const title = el("h1", "no-git-title");
  title.textContent = help.title;
  const lead = el("p", "no-git-lead");
  lead.textContent = help.lead;
  card.append(badge, title, lead);
  if (help.detail) {
    const said = el("pre", "no-git-detail");
    said.textContent = help.detail;
    card.appendChild(said);
  }
  const ways = el("ol", "no-git-ways");
  for (const way of help.ways) {
    const li = el("li", "no-git-way");
    li.appendChild(span(way.label, "no-git-way-label"));
    const command = way.command;
    if (command) {
      const row = el("div", "no-git-cmd");
      const code = el("code", "no-git-code");
      code.textContent = command;
      const copy = el("button", "mini-btn no-git-copy") as HTMLButtonElement;
      copy.append(glyph("copy"), span("Copy"));
      copy.setAttribute("aria-label", `Copy ${command}`);
      copy.addEventListener("click", () => void copyText(command, "Command copied."));
      row.append(code, copy);
      li.appendChild(row);
    }
    ways.appendChild(li);
  }
  card.appendChild(ways);

  const actions = el("div", "no-git-actions");
  const retry = el("button", "btn btn-primary no-git-retry") as HTMLButtonElement;
  retry.append(glyph("refresh"), span("Check again"));
  const get = el("button", "btn btn-soft no-git-download") as HTMLButtonElement;
  get.append(glyph("link-external"), span(help.download.label));
  get.addEventListener("click", () => window.open(help.download.url, "_blank", "noopener"));
  actions.append(retry, get);
  const status = el("div", "no-git-status");
  status.setAttribute("role", "status");
  card.append(actions, status);

  retry.addEventListener("click", async () => {
    retry.disabled = true;
    status.textContent = "Looking for Git…";
    const again = await shellHost.invoke("app:gitCheck", { recheck: true }).catch(() => undefined);
    retry.disabled = false;
    if (again && again.ok) {
      status.textContent = `Found Git ${again.version}.`;
      done();
      return;
    }
    // A different problem now (Git installed, but it will not run): the
    // screen describes the latest answer, not the first.
    if (again && (again.reason !== git.reason || again.platform !== git.platform)) {
      render(root, again, done);
      return;
    }
    status.textContent =
      "Still no working Git. If you installed it somewhere unusual, add it to your PATH and restart GitStudio.";
  });

  screen.appendChild(card);
  root.replaceChildren(screen);
  // The window opens here, so the keyboard starts on the one thing to do.
  retry.focus();
}
