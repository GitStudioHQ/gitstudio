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
import { closeMergeEditorTabs, dismissSidesTip, fileUri, sidesTipFor, type MergeHostCore } from "./host";
import { saveConflictedDocuments, saveDocumentAt } from "./mergeEditorProvider";
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
  /**
   * The page's actions, ONE AT A TIME in the order they came: a press on a
   * second row while git is still at the first waits its turn (two git
   * commands at once fight over index.lock), and is never dropped.
   */
  private work: Promise<void> = Promise.resolve();
  /** The highest action seq finished (ConflictsState.done); the page numbers from 1 again when it loads. */
  private done = 0;
  /** Which load of the page is on screen: an action from an earlier load never counts as done for this one. */
  private page = 0;
  /**
   * The last state message posted, as sent. A state identical to it is not
   * posted again: the page would have nothing to do with it, and every git
   * event (a watcher, the focus refresh) re-reads the same state.
   */
  private lastPosted: string | undefined;
  /**
   * Panels this host is disposing itself (the operation ended, another
   * repository, shutdown). Any other dispose is the user closing the tab,
   * which the controller must hear as a close for this stop.
   */
  private readonly closingOurselves = new WeakSet<vscode.WebviewPanel>();

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
   * Another product just took the automatic behaviour (D4, either way round):
   * it shows its own dashboard now, so this one goes — two "Conflicts (30)"
   * tabs for one repository was the race D4 exists to prevent. Not a close by
   * the user; asking for this dashboard (the command) still shows it.
   */
  standDown(): void {
    this.disposePanel();
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
    this.disposePanel();
  }

  /** Dispose the panel as the HOST (not a close by the user). */
  private disposePanel(): void {
    const panel = this.panel;
    if (panel) {
      this.closingOurselves.add(panel);
      panel.dispose();
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
    this.lastPosted = undefined;
    // The page's HTML is set ONCE, here. Every change after this is a state
    // message the page patches in place: re-setting the HTML (or making a new
    // panel) for a change reloads the whole page — the "server side website"
    // flash.
    panel.webview.html = conflictsWebviewHtml(panel.webview, this.host.context.extensionUri);
    const sub = panel.webview.onDidReceiveMessage((raw: unknown) => {
      void this.onAction(raw as ConflictsAction).catch((error) => {
        void this.host.notify("error", error instanceof Error ? error.message : String(error));
      });
    });
    panel.onDidDispose(() => {
      sub.dispose();
      const ours = this.closingOurselves.has(panel);
      if (this.panel === panel) {
        this.panel = undefined;
        this.ready = false;
        if (!ours) {
          // The tab's ✕ (or any close we did not make): the same as the page's
          // own Close — respected until the next stop.
          this.controller?.userClosed();
        }
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
    // What this read can vouch for: the actions finished BEFORE it began. A
    // read that overlaps an action (a watcher's, while git is still at it)
    // must not tell the page that action is done.
    const doneAtRead = this.done;
    let snapshot;
    try {
      snapshot = await repo.ctx.conflictOps.snapshot();
    } catch {
      return; // a transient git failure: the next change re-reads
    }
    if (repo !== this.repo) {
      return; // rebound while reading
    }
    controller.setTip(sidesTipFor(this.host, snapshot.op));
    const decision = controller.update(
      snapshot,
      {
        open: this.panel !== undefined,
        autoShow: auto && this.host.settings().autoOpen && !this.host.defers(),
      },
      doneAtRead,
    );
    if (decision.close && this.panel) {
      this.disposePanel();
      return;
    }
    if (decision.show && !this.panel) {
      // Automatic: appear beside the work, never steal the keyboard.
      this.create(false);
    }
    if (decision.reveal && this.panel && !this.panel.visible) {
      // Back to the front after a file is finished elsewhere (the merge
      // editor over it). Already on screen, it is left alone: re-opening the
      // visible editor for nothing is work VS Code may lay out again.
      this.panel.reveal(undefined, true);
    }
    this.post();
  }

  private post(): void {
    if (!this.panel || !this.controller) {
      return;
    }
    const state = this.controller.state();
    const title = dashboardTitle(state);
    if (this.panel.title !== title) {
      this.panel.title = title;
    }
    if (!this.ready) {
      return; // the page asks with "ready" and gets it then
    }
    const message: ConflictsHostMessage = { type: "state", state };
    const sent = JSON.stringify(message);
    if (sent === this.lastPosted) {
      return; // exactly what the page already has
    }
    this.lastPosted = sent;
    void this.panel.webview.postMessage(message);
  }

  /** The page finished loading (again): it numbers its actions from 1, and has no state yet. */
  private pageLoaded(): void {
    this.ready = true;
    this.page++;
    this.done = 0;
    this.lastPosted = undefined;
  }

  /** An action of page `page` is finished: states read from now on say so. */
  private finish(seq: number | undefined, page: number): void {
    if (seq !== undefined && page === this.page && seq > this.done) {
      this.done = seq;
    }
  }

  /** Run `job` after every action before it (see `work`). */
  private enqueue(job: () => Promise<void>): Promise<void> {
    const run = this.work.then(job);
    this.work = run.catch(() => undefined);
    return run;
  }

  private async onAction(action: ConflictsAction): Promise<void> {
    const repo = this.repo;
    const controller = this.controller;
    if (!repo || !controller || !action) {
      return;
    }
    switch (action.type) {
      case "ready":
        this.pageLoaded();
        if (!controller.hasSnapshot()) {
          await this.refresh(false);
        } else {
          this.post();
        }
        return;
      case "close":
        controller.userClosed();
        this.disposePanel();
        return;
      case "openExternal":
        // Only the brand's support links (and the tip's Why?), and only ever web pages.
        if (/^https:\/\//i.test(action.url)) {
          void vscode.env.openExternal(vscode.Uri.parse(action.url));
        }
        return;
      case "dismissTip":
        await dismissSidesTip(this.host, action.id);
        controller.setTip(undefined);
        this.post();
        return;
      case "merge":
        await this.openConflict(fileUri(repo, action.path));
        return;
      case "accept":
        await this.fileAction(repo, action.path, action.seq, `Accept ${action.role === "yours" ? "Yours" : "Theirs"}`, () =>
          repo.ctx.conflictOps.takeRole(action.path, action.role),
        );
        return;
      case "restore":
        await this.fileAction(repo, action.path, action.seq, undefined, () => repo.ctx.conflictOps.restore(action.path));
        return;
      case "delete":
        await this.fileAction(repo, action.path, action.seq, "Delete the conflicted file", () =>
          repo.ctx.conflictOps.deleteFile(action.path),
        );
        return;
      case "continue":
        await this.verb(repo, "continue", action.seq, () =>
          repo.ctx.operation.continue({ confirmDrop: action.confirmDrop }),
        );
        return;
      case "skip":
        await this.verb(repo, "skip", action.seq, () => repo.ctx.operation.skip());
        return;
      case "abort":
        await this.verb(repo, "abort", action.seq, async () => {
          await saveConflictedDocuments(repo);
          return repo.ctx.operation.abort();
        });
        return;
    }
  }

  /**
   * One row's whole-file action. Only THAT row changes while it waits and
   * runs (status "busy"); the page is not locked and no other row is touched.
   * Its result reaches the page with the re-read after it, which says the
   * action is `done` — so a state read while git was still at it never shows
   * the row as it was.
   */
  private async fileAction(
    repo: MergeRepo,
    path: string,
    seq: number | undefined,
    undoLabel: string | undefined,
    act: () => Promise<ConflictOpResult>,
  ): Promise<void> {
    const controller = this.controller!;
    const page = this.page;
    controller.setRowBusy(path, true);
    this.post();
    await this.enqueue(async () => {
      let result: ConflictOpResult;
      try {
        // A merge editor on this file may hold unapplied work: save it now, so
        // the document follows what git writes next and closing that editor
        // afterwards has nothing to ask (see saveDocumentAt).
        await saveDocumentAt(fileUri(repo, path));
        const run = () => act();
        result =
          undoLabel && this.host.product.runWithUndo
            ? await this.host.product.runWithUndo(repo, `${undoLabel}: ${path}`, run)
            : await run();
      } catch (error) {
        result = { ok: false, changed: false, message: error instanceof Error ? error.message : String(error) };
      }
      controller.setRowBusy(path, false);
      this.finish(seq, page);
      if (!result.ok && result.message) {
        controller.setNotice({ kind: result.expected ? "warn" : "error", text: result.message });
      }
      if (result.ok) {
        // A merge editor open on this file would now show a stale conflict.
        void closeMergeEditorTabs(this.host.product.viewTypes.mergeEditor, fileUri(repo, path));
      }
      this.host.changed(repo);
      await this.refresh(false);
    });
  }

  /**
   * Continue / Skip / Abort from the dashboard: the whole page waits (`busy`)
   * until the state the verb led to has been read and painted.
   */
  private async verb(
    repo: MergeRepo,
    verb: OperationVerb,
    seq: number | undefined,
    act: () => Promise<OperationOutcome>,
  ): Promise<void> {
    const controller = this.controller!;
    const page = this.page;
    controller.setBusy(true);
    this.post();
    await this.enqueue(async () => {
      let before: OperationView | undefined;
      let outcome: OperationOutcome | undefined;
      let failure: string | undefined;
      try {
        before = await repo.ctx.operation.view();
        outcome = await act();
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
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
      this.finish(seq, page);
      this.host.changed(repo);
      try {
        await this.refresh(false);
      } finally {
        controller.setBusy(false);
        this.post();
      }
    });
  }

  dispose(): void {
    this.disposePanel();
    this.panel = undefined;
  }
}
