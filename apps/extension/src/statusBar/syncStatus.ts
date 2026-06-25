import * as vscode from "vscode";
import type { RepoManager, RepoEntry } from "../git/repoManager";

// A compact left status-bar segment for the active repo's sync state:
//   $(git-branch) <branch> $(arrow-down)<behind> $(arrow-up)<ahead>
// Clicking opens a QuickPick of Sync / Push / Pull / Fetch / Publish. Updated
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
      this.item.tooltip = buildTooltip(branch, upstream, counts);
      this.item.show();
    } catch {
      if (token === this.updateToken) {
        this.item.hide();
      }
    }
  }

  private async showMenu(): Promise<void> {
    const active = this.repos.getActive();
    if (!active) {
      return;
    }
    const upstream = await active.ctx.sync.currentUpstream();
    const items: Array<vscode.QuickPickItem & { id: string }> = [];
    if (upstream) {
      items.push(
        { id: "sync", label: "$(sync) Sync", description: "pull, then push" },
        { id: "pull", label: "$(arrow-down) Pull" },
        { id: "push", label: "$(arrow-up) Push" },
      );
    } else {
      items.push({
        id: "publish",
        label: "$(cloud-upload) Publish Branch",
        description: "push --set-upstream",
      });
    }
    items.push({ id: "fetch", label: "$(repo-fetch) Fetch" });

    const picked = await vscode.window.showQuickPick(items, {
      title: "GitStudio Sync",
      placeHolder: upstream ? `Upstream: ${upstream}` : "No upstream set",
    });
    if (!picked) {
      return;
    }
    await this.runAction(active, picked.id);
    this.scheduleUpdate();
  }

  private async runAction(active: RepoEntry, id: string): Promise<void> {
    switch (id) {
      case "sync": {
        const pull = await active.ctx.sync.pull();
        if (!pull.ok) {
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

  private async askRebase(): Promise<boolean | undefined> {
    const choice = await vscode.window.showQuickPick(
      [
        { label: "$(arrow-down) Merge", value: false },
        { label: "$(git-merge) Rebase", value: true },
      ],
      { title: "Pull strategy", placeHolder: "Merge or rebase local commits?" },
    );
    return choice?.value;
  }

  private async askForce(): Promise<boolean | undefined> {
    const forceDefault = vscode.workspace
      .getConfiguration("gitstudio")
      .get<boolean>("push.forceWithLease", true);
    const choice = await vscode.window.showQuickPick(
      [
        { label: "$(arrow-up) Push", description: "normal push", value: false },
        {
          label: "$(warning) Force push (with lease)",
          description: forceDefault ? "--force-with-lease" : "",
          value: true,
        },
      ],
      { title: "Push", placeHolder: "Push or force-push?" },
    );
    return choice?.value;
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
    const picked = await vscode.window.showQuickPick(
      remotes.map((r) => ({ label: `$(cloud) ${r.name}`, name: r.name })),
      { title: "Publish to which remote?" },
    );
    return picked?.name;
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

function buildTooltip(
  branch: string,
  upstream: string | null,
  counts: { ahead: number; behind: number },
): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.supportThemeIcons = true;
  md.appendMarkdown(`$(git-branch) **${branch}**\n\n`);
  if (upstream) {
    md.appendMarkdown(`$(cloud) Upstream: \`${upstream}\`\n\n`);
    md.appendMarkdown(
      `$(arrow-down) ${counts.behind} behind · $(arrow-up) ${counts.ahead} ahead`,
    );
  } else {
    md.appendMarkdown("No upstream — click to publish.");
  }
  return md;
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
