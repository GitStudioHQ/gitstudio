import * as vscode from "vscode";
import type { RepoManager, RepoEntry } from "../git/repoManager";

// A compact left status-bar segment for the active repo's sync state:
//   $(git-branch) <branch> $(arrow-down)<behind> $(arrow-up)<ahead>
// Clicking SYNCS immediately (pull, then push) — no command-palette prompt.
// Fetch / Pull / Push live as command links in the item's hover tooltip, which
// keeps every action one click away without hijacking the search bar. Updated
// (debounced) on RepoManager.onDidChange; hidden when no repo is open. Coexists
// with built-in git's own item by staying terse and in its own segment.

const UPDATE_DEBOUNCE_MS = 500;
const COMMAND_ID = "gitstudio.syncStatus.menu";

export class SyncStatusItem implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private updateToken = 0;

  constructor(private readonly repos: RepoManager) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      // A small negative priority keeps us just to the right of vscode.git's
      // own SCM segment rather than fighting it for the leftmost slot.
      -5,
    );
    this.item.command = COMMAND_ID;

    this.disposables.push(
      this.item,
      vscode.commands.registerCommand(COMMAND_ID, () => this.showMenu()),
      // One command per verb so the tooltip can link to them directly.
      ...(["sync", "fetch", "pull", "push", "publish"] as const).map((id) =>
        vscode.commands.registerCommand(`gitstudio.sync.${id}`, async () => {
          const active = this.repos.getActive();
          if (active) {
            await this.runAction(active, id);
            this.scheduleUpdate();
          }
        }),
      ),
      this.repos.onDidChange(() => this.scheduleUpdate()),
    );

    this.scheduleUpdate();
  }

  private scheduleUpdate(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.update();
    }, UPDATE_DEBOUNCE_MS);
  }

  private async update(): Promise<void> {
    const token = ++this.updateToken;
    const active = this.repos.getActive();
    if (!active) {
      this.item.hide();
      return;
    }
    try {
      const head = await active.ctx.refs.getHead();
      const branch = head.detached
        ? `${head.sha.slice(0, 7)} (detached)`
        : head.branch ?? `${head.sha.slice(0, 7)} (detached)`;
      const upstream = await active.ctx.sync.currentUpstream();
      const counts = await active.ctx.sync.aheadBehind();

      if (token !== this.updateToken) {
        return; // a newer update superseded this one
      }

      const parts = [`$(git-branch) ${branch}`];
      if (upstream) {
        if (counts.behind > 0) {
          parts.push(`$(arrow-down)${counts.behind}`);
        }
        if (counts.ahead > 0) {
          parts.push(`$(arrow-up)${counts.ahead}`);
        }
      } else {
        parts.push("$(cloud-upload)");
      }
      this.item.text = parts.join(" ");
      this.setTooltip(branch, upstream, counts.ahead, counts.behind);
      this.item.show();
    } catch {
      if (token === this.updateToken) {
        this.item.hide();
      }
    }
  }

  /**
   * Clicking the item performs the DEFAULT action directly: sync when there is
   * an upstream, publish when there isn't. Deliberately not a QuickPick — the
   * palette is a search box, not a menu, and a one-click control should just
   * act. The other verbs are command links in the tooltip (see setTooltip).
   */
  private async showMenu(): Promise<void> {
    const active = this.repos.getActive();
    if (!active) {
      return;
    }
    const upstream = await active.ctx.sync.currentUpstream();
    await this.runAction(active, upstream ? "sync" : "publish");
    this.scheduleUpdate();
  }

  /** A hover menu of real, clickable commands — the alternative to a QuickPick. */
  private setTooltip(
    branch: string,
    upstream: string | null | undefined,
    ahead: number,
    behind: number,
  ): void {
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = {
      enabledCommands: [
        "gitstudio.sync.sync",
        "gitstudio.sync.fetch",
        "gitstudio.sync.pull",
        "gitstudio.sync.push",
        "gitstudio.sync.publish",
      ],
    };
    md.supportThemeIcons = true;
    md.appendMarkdown(`**${branch}**\n\n`);
    md.appendMarkdown(
      upstream
        ? `$(git-branch) tracking \`${upstream}\` · ${behind} in, ${ahead} out\n\n`
        : "No upstream set\n\n",
    );
    md.appendMarkdown("---\n\n");
    if (upstream) {
      md.appendMarkdown("[$(sync) Sync](command:gitstudio.sync.sync) &nbsp; ");
      md.appendMarkdown("[$(repo-fetch) Fetch](command:gitstudio.sync.fetch) &nbsp; ");
      md.appendMarkdown("[$(arrow-down) Pull](command:gitstudio.sync.pull) &nbsp; ");
      md.appendMarkdown("[$(arrow-up) Push](command:gitstudio.sync.push)");
    } else {
      md.appendMarkdown("[$(cloud-upload) Publish Branch](command:gitstudio.sync.publish) &nbsp; ");
      md.appendMarkdown("[$(repo-fetch) Fetch](command:gitstudio.sync.fetch)");
    }
    this.item.tooltip = md;
  }

  private async runAction(active: RepoEntry, id: string): Promise<void> {
    switch (id) {
      case "sync": {
        // Fetch explicitly FIRST. `git pull` does its own fetch, but when that
        // fetch fails (no SSH agent in the host's environment, auth, network)
        // git reports the useless "your configuration specifies to merge with
        // the ref 'refs/heads/X' ... but no such ref was fetched" instead of the
        // actual failure. Doing it in two steps surfaces the real error.
        const fetched = await active.ctx.sync.fetch({ prune: true });
        if (!fetched.ok) {
          reportSync(fetched, "Fetch");
          return;
        }
        const pull = await active.ctx.sync.pull();
        if (!pull.ok) {
          if (await this.offerUpstreamRepair(active, pull.stderr)) {
            return;
          }
          reportSync(pull, "Pull");
          return;
        }
        reportSync(await active.ctx.sync.push(), "Push", "Synced");
        break;
      }
      case "pull": {
        const rebase = await this.askRebase();
        if (rebase === undefined) {
          return;
        }
        reportSync(await active.ctx.sync.pull({ rebase }), "Pull", "Pulled");
        break;
      }
      case "push": {
        const force = await this.askForce();
        if (force === undefined) {
          return;
        }
        reportSync(await active.ctx.sync.push({ force }), "Push", "Pushed");
        break;
      }
      case "publish": {
        const branch = await this.currentBranch(active);
        const remote = await this.pickRemote(active);
        if (!branch || !remote) {
          return;
        }
        reportSync(
          await active.ctx.sync.push({ remote, branch, setUpstream: true }),
          "Publish",
          `Published ${branch}`,
        );
        break;
      }
      case "fetch":
        reportSync(
          await active.ctx.sync.fetch({ prune: true }),
          "Fetch",
          "Fetched",
        );
        break;
      default:
        break;
    }
  }

  /**
   * Git's worst sync error, made actionable.
   *
   * When a branch tracks a remote branch that has since been deleted, `git pull`
   * says "your configuration specifies to merge with the ref 'refs/heads/X' from
   * the remote, but no such ref was fetched" — which describes git's internals,
   * not the user's problem, and offers no way out. The actual situation is
   * simply "the branch you were tracking is gone", and there are exactly two
   * sane answers: republish this branch, or stop tracking.
   *
   * Returns true when it handled the failure (so the caller suppresses the raw
   * git error), false to fall through to normal reporting.
   */
  private async offerUpstreamRepair(
    active: RepoEntry,
    stderr: string,
  ): Promise<boolean> {
    if (!/no such ref was fetched/i.test(stderr)) {
      return false;
    }
    const head = await active.ctx.refs.getHead();
    if (head.detached || !head.branch) {
      return false;
    }
    const branch = head.branch;
    const upstream = (await active.ctx.sync.currentUpstream()) ?? "its upstream";
    const choice = await vscode.window.showWarningMessage(
      `"${branch}" tracks ${upstream}, which no longer exists on the remote.`,
      {
        modal: true,
        detail:
          "Someone deleted or renamed that remote branch. Republish to recreate " +
          "it from your local commits, or stop tracking it and set a new " +
          "upstream later.",
      },
      "Republish Branch",
      "Stop Tracking",
    );
    if (choice === "Republish Branch") {
      const remote = await this.pickRemote(active);
      if (!remote) {
        return true;
      }
      reportSync(
        await active.ctx.sync.push({ remote, branch, setUpstream: true }),
        "Publish",
        `Published ${branch}`,
      );
      return true;
    }
    if (choice === "Stop Tracking") {
      const r = await active.ctx.process.run([
        "branch",
        "--unset-upstream",
        branch,
      ]);
      reportSync(
        { ok: r.code === 0, stderr: r.stderr },
        "Unset upstream",
        `"${branch}" no longer tracks a remote branch`,
      );
      return true;
    }
    // Dismissed — the user has been told what is wrong; don't also throw git's
    // version of the same thing at them.
    return true;
  }

  private async askRebase(): Promise<boolean | undefined> {
    // A real dialog, not the command palette: this is a decision with
    // consequences, and the palette is a search box.
    const choice = await vscode.window.showInformationMessage(
      "Pull: how should your local commits be integrated?",
      { modal: true, detail: "Merge keeps history as-is. Rebase replays your commits on top." },
      "Merge",
      "Rebase",
    );
    return choice === undefined ? undefined : choice === "Rebase";
  }

  private async askForce(): Promise<boolean | undefined> {
    const forceDefault = vscode.workspace
      .getConfiguration("gitstudio")
      .get<boolean>("push.forceWithLease", true);
    const choice = await vscode.window.showWarningMessage(
      "Push to the upstream branch?",
      {
        modal: true,
        detail: forceDefault
          ? "Force push uses --force-with-lease, which refuses to overwrite remote work you haven't seen."
          : "Force push overwrites the remote branch.",
      },
      "Push",
      "Force push",
    );
    return choice === undefined ? undefined : choice === "Force push";
  }

  private async currentBranch(active: RepoEntry): Promise<string | undefined> {
    const head = await active.ctx.refs.getHead();
    if (head.detached) {
      void vscode.window.showInformationMessage(
        "GitStudio: cannot publish a detached HEAD — check out a branch first.",
      );
      return undefined;
    }
    return head.branch;
  }

  private async pickRemote(active: RepoEntry): Promise<string | undefined> {
    const remotes = await active.ctx.remotes.list();
    if (remotes.length === 0) {
      void vscode.window.showInformationMessage(
        "GitStudio: no remotes configured.",
      );
      return undefined;
    }
    if (remotes.length === 1) {
      return remotes[0].name;
    }
    const names = remotes.map((r) => r.name);
    const picked = await vscode.window.showInformationMessage(
      "Publish this branch to which remote?",
      { modal: true },
      ...names,
    );
    return picked;
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}


function reportSync(
  result: { ok: boolean; stderr: string },
  verb: string,
  success?: string,
): void {
  if (result.ok) {
    void vscode.window.setStatusBarMessage(
      `$(check) ${success ?? `${verb} done`}`,
      2500,
    );
    return;
  }
  const stderr = result.stderr.trim();
  if (/conflict/i.test(stderr)) {
    void vscode.window.showWarningMessage(
      `${verb} hit conflicts. Resolve them, then continue.`,
    );
  } else {
    void vscode.window.showErrorMessage(
      stderr ? `${verb} failed: ${stderr}` : `${verb} failed`,
    );
  }
}
