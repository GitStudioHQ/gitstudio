// The 3-pane merge editor as a VS Code custom TEXT editor: backed by the
// conflicted file's TextDocument, so dirty / save / reopen come from VS Code.
// This class owns the VS Code pieces (the webview, the document, tabs); every
// git-facing message goes to a MergeSession (mergeSession.ts), where the S0
// message sequencing is unit-tested.
//
// It is one of the two places in this package that write a document the user
// has open (the other is diffPanel.ts): it owns the document it edits.

import * as vscode from "vscode";
import { detectEol } from "@gitstudio/engine/lineDiff";
import type { HostMessage, WebviewMessage } from "@gitstudio/host-bridge/protocol";
import { locate } from "./args";
import { sampleScheme } from "./demo";
import { DEMO_MERGE, sampleAnswer } from "./demoContent";
import { baseName, ForeignEdits, ResultMirror } from "./documentSync";
import { closeMergeEditorTabs, fileUri, type MergeHostCore } from "./host";
import type { JetBrainsUi } from "./jetbrainsUi";
import { MergeSession } from "./mergeSession";
import type { MergeRepo } from "./product";
import { mergeWebviewHtml } from "./webviewHtml";

export class MergeEditorProvider implements vscode.CustomTextEditorProvider {
  static register(host: MergeHostCore, jetbrains: JetBrainsUi): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      host.product.viewTypes.mergeEditor,
      new MergeEditorProvider(host, jetbrains),
      {
        supportsMultipleEditorsPerDocument: false,
        webviewOptions: { retainContextWhenHidden: true },
      },
    );
  }

  constructor(
    private readonly host: MergeHostCore,
    private readonly jetbrains: JetBrainsUi,
  ) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const { host } = this;
    const webview = panel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(host.context.extensionUri, "dist")],
    };
    webview.html = mergeWebviewHtml(webview, host.context.extensionUri);

    // The walkthrough's sample (demo.ts): answered from demoContent.ts, with
    // no repository, no document writes and no git.
    if (document.uri.scheme === sampleScheme(host.product)) {
      panel.title = DEMO_MERGE.title;
      const sampleSub = webview.onDidReceiveMessage((raw: unknown) => {
        const answer = sampleAnswer(raw as WebviewMessage | undefined, host.settings());
        for (const message of answer.post) {
          void webview.postMessage(message);
        }
        if (answer.close) {
          panel.dispose();
        }
      });
      panel.onDidDispose(() => sampleSub.dispose());
      return;
    }

    let disposed = false;
    // What this editor writes into the document before Apply, and whether
    // something else has written to it since (documentSync.ts).
    const sync: EditorSync = { mirror: new ResultMirror(), edits: new ForeignEdits(document.getText()), post: () => {} };
    const post = (message: HostMessage): void => {
      if (message.type === "init") {
        sync.mirror.init(message);
        // The document and the file git left are where this merge starts.
        sync.edits.reset(document.getText(), message.result);
        if (sync.mirror.preserved) {
          void host.notify(
            "warn",
            `${baseName(document.uri.fsPath)} has no conflict markers left: it was already resolved, by hand or by ` +
              `git rerere. The merge editor starts from the conflict, and the file keeps your resolution unless you Apply.`,
          );
        }
      }
      if (message.type === "applied" && message.staged) {
        sync.mirror.applied();
      }
      if (!disposed) {
        void webview.postMessage(message);
      }
    };
    sync.post = post;
    // The repository is looked up per message, never once here: VS Code
    // restores an open merge editor on reload and resolves it the moment the
    // extension activates, before its repositories have been discovered. A
    // lookup made now would leave this editor "outside any repository" for
    // good — sides read from the markers (no rebase swap) and an Apply that
    // saves without staging.
    const sessionNow = (): MergeSession => {
      const target = locate(host.product.locator, document.uri);
      return this.session(document, target?.repo, target?.rel, { post });
    };

    const sub = webview.onDidReceiveMessage((raw: unknown) => {
      void this.handle(raw as WebviewMessage | undefined, sessionNow(), document, panel, sync).catch((error) => {
        void host.notify("error", error instanceof Error ? error.message : String(error));
      });
    });
    // Rule 3 (documentSync.ts): every text the document takes that this editor
    // did not write — a second tab on the file, a formatter, a checkout that
    // VS Code reloads — is noted, and the next write asks first.
    const changes = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document === document && event.contentChanges.length > 0) {
        sync.edits.observe(document.getText());
      }
    });
    panel.onDidDispose(() => {
      disposed = true;
      sub.dispose();
      changes.dispose();
    });
  }

  /** One message's conversation with git, for the repository the file is in now. */
  private session(
    document: vscode.TextDocument,
    repo: MergeRepo | undefined,
    rel: string | undefined,
    io: { post(message: HostMessage): void },
  ): MergeSession {
    const { host } = this;
    return new MergeSession({
      git: repo?.ctx,
      rel,
      fileName: document.uri.fsPath,
      workingText: () => document.getText(),
      diskText: async () =>
        new TextDecoder("utf-8").decode(await vscode.workspace.fs.readFile(document.uri)),
      save: async (text) => {
        await syncResult(document, text);
        if (!(await document.save())) {
          throw new Error("the editor did not save the file");
        }
      },
      post: io.post,
      settings: () => host.settings(),
      jetbrainsName: () => this.jetbrains.cachedName(),
      withUndo:
        repo && host.product.runWithUndo
          ? <T>(label: string, fn: () => Promise<T>) => host.product.runWithUndo!(repo, label, fn)
          : undefined,
      // No toast after an Apply here: VS Code puts it over the editor's
      // bottom-right corner — Apply and Continue — and the editor already says
      // "Merge applied and staged" in place. The conflict comes back from the
      // Conflicts dashboard, whose row holds Undo for exactly this.
      notify: (kind, text) => void host.notify(kind, text),
      changed: () => {
        if (repo) {
          host.changed(repo);
        }
      },
      beforeAbort: repo ? () => saveConflictedDocuments(repo) : undefined,
      afterAbort: () => closeMergeEditorTabs(host.product.viewTypes.mergeEditor),
    });
  }

  private async handle(
    message: WebviewMessage | undefined,
    session: MergeSession,
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    sync: EditorSync,
  ): Promise<void> {
    switch (message?.type) {
      case "ready":
        await this.jetbrains.detect();
        await session.init();
        break;
      case "resultChanged": {
        // The document follows the Result with every open conflict still
        // marked (rule 1), never over a resolution made before the editor
        // opened (rule 2), and not over another edit without asking (rule 3).
        if (sync.edits.keeping) {
          break;
        }
        const text = sync.mirror.documentText(message.text);
        if (text === undefined) {
          break;
        }
        if (sync.edits.changed && !(await this.replaceOtherEdit(document, sync, "mirror"))) {
          break;
        }
        sync.edits.expect(text);
        await syncResult(document, text);
        break;
      }
      case "apply": {
        const name = baseName(document.uri.fsPath);
        if (sync.mirror.appliedOverResolution()) {
          const go = await this.host.product.ask({
            title: `Replace the resolution already in ${name}?`,
            message:
              `${name} had no conflict markers left when the merge editor opened: it was already resolved, by hand ` +
              `or by git rerere. Apply replaces that with the Result shown here, and stages it.`,
            confirmLabel: "Replace and stage",
            danger: true,
          });
          if (!go) {
            sync.post({ type: "outcome", kind: "failed", text: `Nothing was written. ${name} keeps the resolution it had.` });
            break;
          }
        }
        if (sync.edits.changed && !(await this.replaceOtherEdit(document, sync, "apply"))) {
          sync.post({
            type: "outcome",
            kind: "failed",
            text: `Nothing was written. ${name} keeps the edit made outside the merge editor.`,
          });
          break;
        }
        sync.edits.expect(message.text);
        await session.apply(message.text);
        break;
      }
      case "takeRole":
        await session.takeRole(message.role);
        break;
      case "deleteFile":
        await session.deleteFile();
        break;
      case "continueOperation":
        await session.continueOperation(message.confirmDrop);
        break;
      case "cancel":
        if (message.mode === "abort") {
          await session.abortOperation();
        } else {
          await this.exitViewer(document, panel);
        }
        break;
      case "openInJetBrains": {
        // Hand the conflict to the IDE and close this panel, so the two do
        // not fight over the file. The IDE starts the merge over from the
        // three versions, so progress made here cannot travel with it — and
        // left in a dirty document with no editor, it stopped following the
        // file and VS Code later offered to save it over the IDE's result.
        // So: ask, and on yes put the document back to git's file first —
        // written through this editor's own document (never a "revert", which
        // could take another extension's edits with it), from the bytes on
        // disk, so what is saved is exactly what git left.
        if (document.isDirty) {
          const ide = (await this.jetbrains.detect())?.name ?? this.jetbrains.cachedName() ?? "the JetBrains IDE";
          const name = document.uri.fsPath.split(/[\\/]/).pop() ?? document.uri.fsPath;
          const go = await this.host.product.ask({
            title: `Open ${name} in ${ide}?`,
            message:
              `${ide} starts this merge over from the three versions. What you have resolved here is not ` +
              `carried over, and is discarded.`,
            confirmLabel: `Open in ${ide}`,
            danger: true,
          });
          if (!go) {
            break;
          }
          let onDisk: string;
          try {
            onDisk = new TextDecoder("utf-8", { fatal: true }).decode(await vscode.workspace.fs.readFile(document.uri));
          } catch {
            void this.host.notify("warn", `${name} isn't UTF-8 text, so it can't be handed to ${ide} from here.`);
            break;
          }
          sync.edits.expect(onDisk);
          await syncDocument(document, onDisk);
          await document.save();
        }
        void this.jetbrains.merge(document.uri);
        panel.dispose();
        break;
      }
      default:
        break;
    }
  }

  /**
   * Something other than this editor changed the file since it last wrote it
   * (rule 3): ask before writing over it. Yes replaces it; No keeps it, and
   * the editor stops mirroring the Result until an Apply.
   */
  private async replaceOtherEdit(
    document: vscode.TextDocument,
    sync: EditorSync,
    why: "mirror" | "apply",
  ): Promise<boolean> {
    const name = baseName(document.uri.fsPath);
    const go = await this.host.product.ask({
      title: `${name} changed outside the merge editor`,
      message:
        `It was edited in another editor, by a formatter, or on disk since the merge editor last wrote it. ` +
        (why === "apply"
          ? `Apply replaces that edit with the Result shown here, and stages it.`
          : `Replace that edit with the merge editor's Result? If you keep it, the merge editor stops writing to ` +
            `the file until you Apply.`),
      confirmLabel: why === "apply" ? "Replace and stage" : "Replace with the Result",
      danger: true,
    });
    if (go) {
      sync.edits.replace(document.getText());
    } else {
      sync.edits.keep();
    }
    return go;
  }

  /**
   * "Exit viewer": close the merge editor, keep the conflict in the file, and
   * keep automatic routing from sending it straight back (the exit guard).
   */
  private async exitViewer(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    this.host.exitGuard.suppress(document.uri.toString());
    try {
      await vscode.commands.executeCommand(
        "vscode.openWith",
        document.uri,
        "default",
        panel.viewColumn ?? vscode.ViewColumn.Active,
      );
    } finally {
      panel.dispose();
    }
  }
}

/** One merge editor's document rules (documentSync.ts) and its way to answer the page. */
interface EditorSync {
  mirror: ResultMirror;
  edits: ForeignEdits;
  post(message: HostMessage): void;
}

/** Mirror the webview's result into the backing TextDocument. */
async function syncDocument(document: vscode.TextDocument, text: string): Promise<void> {
  if (document.getText() === text) {
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    document.uri,
    new vscode.Range(new vscode.Position(0, 0), new vscode.Position(document.lineCount, 0)),
    text,
  );
  await vscode.workspace.applyEdit(edit);
}

/**
 * Mirror the merge RESULT, line endings included. The view writes the result
 * in Yours' line ending (and says so when the sides differ), but a text edit
 * takes the DOCUMENT's — and VS Code opened the conflicted file with whichever
 * ending most of git's mixed lines had. So a CRLF Yours merged against an LF
 * Theirs was saved and staged as LF, every line of Yours' file changed. The
 * document takes the result's ending along with its text.
 */
async function syncResult(document: vscode.TextDocument, text: string): Promise<void> {
  const ending = detectEol(text);
  const want =
    ending === "CRLF" ? vscode.EndOfLine.CRLF : ending === "LF" ? vscode.EndOfLine.LF : undefined;
  if (want === undefined || document.eol === want) {
    await syncDocument(document, text);
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.set(document.uri, [
    vscode.TextEdit.replace(
      new vscode.Range(new vscode.Position(0, 0), new vscode.Position(document.lineCount, 0)),
      text,
    ),
    vscode.TextEdit.setEndOfLine(want),
  ]);
  await vscode.workspace.applyEdit(edit);
}

/**
 * Before a whole-file action (Accept Yours / Theirs, delete, hold-to-undo)
 * rewrites one file: save its open, dirty document — a merge editor holding
 * unapplied progress. Left dirty, the document would not follow what git
 * wrote, and closing its merge editor afterwards would ask to save that
 * partial merge over the side just taken. Saved, it reloads from git's result.
 */
export async function saveDocumentAt(uri: vscode.Uri): Promise<void> {
  const target = uri.toString();
  for (const document of vscode.workspace.textDocuments) {
    if (document.isDirty && document.uri.toString() === target) {
      try {
        await document.save();
      } catch {
        // git overwrites the file anyway
      }
    }
  }
}

/**
 * Before an Abort rewrites the conflicted files: save the open, dirty ones.
 * A merge editor's document is dirty whenever it holds unapplied progress; left
 * dirty, closing its tab after the abort would offer to save that partial
 * merge over the file git just restored.
 */
export async function saveConflictedDocuments(repo: MergeRepo): Promise<void> {
  let paths: string[];
  try {
    paths = await repo.ctx.conflict.listConflicts();
  } catch {
    return;
  }
  const wanted = new Set(paths.map((rel) => fileUri(repo, rel).toString()));
  for (const document of vscode.workspace.textDocuments) {
    if (document.isDirty && wanted.has(document.uri.toString())) {
      try {
        await document.save();
      } catch {
        // git overwrites the file anyway
      }
    }
  }
}
