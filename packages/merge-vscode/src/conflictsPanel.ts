// The conflicts dashboard as a webview panel (PLAN §3.7 W14). The page is the
// shared webview-ui ConflictsDashboard (dist/webview/conflicts.js); this host
// feeds it `ConflictsState` and performs its `ConflictsAction`s. What to show,
// reveal or close is decided by the vscode-free DashboardController.
//
// Destructive actions (abort, skip, delete) arrive only after the dashboard's
// own inline confirm — nothing here asks again, and never with a modal.

import * as vscode from "vscode";
import type {
  ConflictsAction,
  ConflictsHostMessage,
  OperationOutcome,
  OperationView,
} from "@gitstudio/host-bridge/conflictsProtocol";
import type { ConflictOpResult } from "@gitstudio/git-service/ConflictOps";
import { DashboardController, dashboardTitle } from "./dashboardController";
import { closeMergeEditorTabs, fileUri, type MergeHostCore } from "./host";
import { saveConflictedDocuments } from "./mergeEditorProvider";
import { outcomeLine, type OperationVerb } from "./outcome";
import type { MergeRepo } from "./product";
import { conflictsWebviewHtml } from "./webviewHtml";

export class ConflictsDashboard implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private repo: MergeRepo | undefined;
  private controller: DashboardController | undefined;
  private ready = false;
  private refreshing: Promise<void> | undefined;
  private refreshQueued = false;
  private queuedAuto = false;

  constructor(
    private readonly host: MergeHostCore,
    /** Open one conflicted file in the configured resolver (the row's "Merge…"). */
    private readonly openConflict: (uri: vscode.Uri) => Promise<void>,
  ) {}

  /** The repository the dashboard is showing, if it is open. */
  get openFor(): MergeRepo | undefined {
    return this.panel ? this.repo : undefined;
  }

  /** The user asked for it (command, status item, banner): show it, whatever a close said. */
  async show(repo: MergeRepo): Promise<void> {
    this.bind(repo);
    this.controller!.requested();
    if (this.panel) {
      this.panel.reveal();
    } else {
      this.create(true);
    }
    await this.refresh(false);
  }

  /**
   * Git state may have changed (the watcher). `repo` is where conflicts are,
   * when the dashboard is not already showing a repository.
   */
  async onStateChanged(repo: MergeRepo | undefined): Promise<void> {
    if (!this.panel && repo) {
      this.bind(repo);
    }
    await this.refresh(true);
  }

  private bind(repo: MergeRepo): void {
    if (this.repo === repo && this.controller) {
      return;
    }
    this.repo = repo;
    this.controller = new DashboardController({
      brand: this.host.product.brand,
      supportLinks: this.host.product.supportLinks,
    });
    if (this.panel) {
      this.panel.dispose();
    }
  }

  private create(focus: boolean): void {
    const panel = vscode.window.createWebviewPanel(
      this.host.product.viewTypes.conflicts,
      "Conflicts",
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: !focus },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.host.context.extensionUri, "dist")],
      },
    );
    this.panel = panel;
    this.ready = false;
    panel.webview.html = conflictsWebviewHtml(panel.webview, this.host.context.extensionUri);
    const sub = panel.webview.onDidReceiveMessage((raw: unknown) => {
      void this.onAction(raw as ConflictsAction).catch((error) => {
        void this.host.notify("error", error instanceof Error ? error.message : String(error));
      });
    });
    panel.onDidDispose(() => {
      sub.dispose();
      if (this.panel === panel) {
        this.panel = undefined;
        this.ready = false;
      }
    });
  }

  /** Re-read git and apply the controller's decision. Coalesces overlapping calls. */
  private async refresh(auto: boolean): Promise<void> {
    if (this.refreshing) {
      // Fold into one trailing re-read; an automatic request keeps its right
      // to auto-show even when it lands behind a user action's re-read.
      this.refreshQueued = true;
      this.queuedAuto = this.queuedAuto || auto;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      try {
        let nextAuto = auto;
        do {
          this.refreshQueued = false;
          await this.refreshOnce(nextAuto);
          nextAuto = this.queuedAuto;
          this.queuedAuto = false;
        } while (this.refreshQueued);
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  private async refreshOnce(auto: boolean): Promise<void> {
    const repo = this.repo;
    const controller = this.controller;
    if (!repo || !controller) {
      return;
    }
    let snapshot;
    try {
      snapshot = await repo.ctx.conflictOps.snapshot();
    } catch {
      return; // a transient git failure: the next change re-reads
    }
    if (repo !== this.repo) {
      return; // rebound while reading
    }
    const decision = controller.update(snapshot, {
      open: this.panel !== undefined,
      autoShow: auto && this.host.settings().autoOpen && !this.host.defers(),
    });
    if (decision.close && this.panel) {
      this.panel.dispose();
      return;
    }
    if (decision.show && !this.panel) {
      // Automatic: appear beside the work, never steal the keyboard.
      this.create(false);
    }
    if (decision.reveal && this.panel) {
      this.panel.reveal(undefined, true);
    }
    this.post();
  }

  private post(): void {
    if (!this.panel || !this.controller) {
      return;
    }
    const state = this.controller.state();
    this.panel.title = dashboardTitle(state);
    if (!this.ready) {
      return; // the page asks with "ready" and gets it then
    }
    const message: ConflictsHostMessage = { type: "state", state };
    void this.panel.webview.postMessage(message);
  }

  private async onAction(action: ConflictsAction): Promise<void> {
    const repo = this.repo;
    const controller = this.controller;
    if (!repo || !controller || !action) {
      return;
    }
    switch (action.type) {
      case "ready":
        this.ready = true;
        if (!controller.hasSnapshot()) {
          await this.refresh(false);
        } else {
          this.post();
        }
        return;
      case "close":
        controller.userClosed();
        this.panel?.dispose();
        return;
      case "openExternal":
        // Only the brand's support links, and only ever web pages.
        if (/^https:\/\//i.test(action.url)) {
          void vscode.env.openExternal(vscode.Uri.parse(action.url));
        }
        return;
      case "merge":
        await this.openConflict(fileUri(repo, action.path));
        return;
      case "accept":
        await this.fileAction(repo, action.path, `Accept ${action.role === "yours" ? "Yours" : "Theirs"}`, () =>
          repo.ctx.conflictOps.takeRole(action.path, action.role),
        );
        return;
      case "restore":
        await this.fileAction(repo, action.path, undefined, () => repo.ctx.conflictOps.restore(action.path));
        return;
      case "delete":
        await this.fileAction(repo, action.path, "Delete the conflicted file", () =>
          repo.ctx.conflictOps.deleteFile(action.path),
        );
        return;
      case "continue":
        await this.verb(repo, "continue", () =>
          repo.ctx.operation.continue({ confirmDrop: action.confirmDrop }),
        );
        return;
      case "skip":
        await this.verb(repo, "skip", () => repo.ctx.operation.skip());
        return;
      case "abort":
        await this.verb(repo, "abort", async () => {
          await saveConflictedDocuments(repo);
          return repo.ctx.operation.abort();
        });
        return;
    }
  }

  /** One row's whole-file action, with the row busy while it runs. */
  private async fileAction(
    repo: MergeRepo,
    path: string,
    undoLabel: string | undefined,
    act: () => Promise<ConflictOpResult>,
  ): Promise<void> {
    const controller = this.controller!;
    controller.setBusy(true, path);
    this.post();
    let result: ConflictOpResult;
    try {
      const run = () => act();
      result =
        undoLabel && this.host.product.runWithUndo
          ? await this.host.product.runWithUndo(repo, `${undoLabel}: ${path}`, run)
          : await run();
    } catch (error) {
      result = { ok: false, changed: false, message: error instanceof Error ? error.message : String(error) };
    } finally {
      controller.setBusy(false);
    }
    if (!result.ok && result.message) {
      controller.setNotice({ kind: result.expected ? "warn" : "error", text: result.message });
    }
    if (result.ok) {
      // A merge editor open on this file would now show a stale conflict.
      void closeMergeEditorTabs(this.host.product.viewTypes.mergeEditor, fileUri(repo, path));
    }
    this.host.changed(repo);
    await this.refresh(false);
  }

  /** Continue / Skip / Abort from the dashboard. */
  private async verb(
    repo: MergeRepo,
    verb: OperationVerb,
    act: () => Promise<OperationOutcome>,
  ): Promise<void> {
    const controller = this.controller!;
    controller.setBusy(true);
    this.post();
    let before: OperationView | undefined;
    let outcome: OperationOutcome | undefined;
    let failure: string | undefined;
    try {
      before = await repo.ctx.operation.view();
      outcome = await act();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      controller.setBusy(false);
    }
    if (outcome && before) {
      const line = outcomeLine(outcome, verb, before);
      controller.setOutcome(line, outcome.view.episode);
      if (verb === "abort" && outcome.ok) {
        void closeMergeEditorTabs(this.host.product.viewTypes.mergeEditor);
      }
    } else {
      controller.setOutcome({ kind: "failed", text: failure ?? `Git refused to ${verb}.` });
    }
    this.host.changed(repo);
    await this.refresh(false);
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }
}
