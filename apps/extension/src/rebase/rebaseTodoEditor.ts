import * as vscode from "vscode";
import {
  parseRebaseTodo,
  serializeRebaseTodo,
  detectEol,
  hasTrailingNewline,
  summarizeRebaseTodo,
  type RebaseCommitEntry,
  type RebaseLine,
} from "@gitstudio/engine/rebase/todo";
import type {
  RebaseHostMessage,
  RebaseWebviewMessage,
  WireRebaseRow,
} from "@gitstudio/host-bridge/rebaseProtocol";
import { getRebaseHtml, getNonce } from "./rebaseHtml";

// A CustomTextEditorProvider that renders any `git-rebase-todo` document as the
// interactive-rebase webview. Registered with priority "default" and the
// filename pattern "**/git-rebase-todo", so it captures the file a terminal
// `git rebase -i` (with GIT_SEQUENCE_EDITOR='code --wait') opens.
//
// On resolve we parse the todo with the (pure) engine and stream the commit
// rows to the webview. "Start" reorders/retypes the parsed lines, serializes
// them back with the engine (so the comment block + unmodeled directives are
// preserved byte-for-byte) and replaces the document text + saves — which lets
// the underlying `git rebase` proceed. "Abort" routes to gitstudio.abortRebase.
//
// Echo-loop guard: we hash the exact text WE write and ignore the resulting
// onDidChangeTextDocument so our own write doesn't re-trigger a parse/render.
export class RebaseTodoEditorProvider
  implements vscode.CustomTextEditorProvider
{
  public static readonly viewType = "gitstudio.rebaseTodoEditor";

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new RebaseTodoEditorProvider(context);
    return vscode.window.registerCustomEditorProvider(
      RebaseTodoEditorProvider.viewType,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      },
    );
  }

  /** Text we wrote ourselves, to skip the echoed change event. */
  private readonly selfWrites = new Set<string>();

  private constructor(private readonly context: vscode.ExtensionContext) {}

  resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): void {
    const webview = webviewPanel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "dist"),
      ],
    };
    const nonce = getNonce();
    webview.html = getRebaseHtml(webview, this.context.extensionUri, nonce);

    const pushInit = () => {
      const text = document.getText();
      const lines = parseRebaseTodo(text);
      const summary = summarizeRebaseTodo(lines);
      const rows = toRows(lines);
      const message: RebaseHostMessage = {
        type: "rebaseInit",
        headerComment: summary.headerComment,
        rows,
      };
      void webview.postMessage(message);
    };

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) {
        return;
      }
      const text = e.document.getText();
      if (this.selfWrites.has(text)) {
        // Our own edit echoing back — ignore it.
        this.selfWrites.delete(text);
        return;
      }
      pushInit();
    });

    const messageSub = webview.onDidReceiveMessage(
      (msg: RebaseWebviewMessage) => {
        switch (msg.type) {
          case "ready":
            pushInit();
            break;
          case "start":
            void this.applyAndSave(document, msg.rows);
            break;
          case "abort":
            void this.abort(document);
            break;
        }
      },
    );

    webviewPanel.onDidDispose(() => {
      changeSub.dispose();
      messageSub.dispose();
    });
  }

  /**
   * Reorder + retype the parsed todo per the webview's row list, serialize via
   * the engine (preserving the comment block + unmodeled lines), write it into
   * the document and save so `git rebase` continues.
   */
  private async applyAndSave(
    document: vscode.TextDocument,
    orderedRows: Array<{ id: number; action: WireRebaseRow["action"] }>,
  ): Promise<void> {
    const original = document.getText();
    const lines = parseRebaseTodo(original);
    const newLines = applyRowOrder(lines, orderedRows);

    const eol = detectEol(original);
    const trailingNewline = hasTrailingNewline(original);
    const newText = serializeRebaseTodo(newLines, { eol, trailingNewline });

    if (newText === original) {
      // Nothing changed — just save so git proceeds with the original plan.
      await document.save();
      return;
    }

    // Mark this exact text as a self-write before applying it.
    this.selfWrites.add(newText);

    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(original.length),
    );
    edit.replace(document.uri, fullRange, newText);
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) {
      this.selfWrites.delete(newText);
      void vscode.window.showErrorMessage(
        "GitStudio could not write the rebase plan.",
      );
      return;
    }
    await document.save();
    flash("Rebase plan applied");
  }

  /**
   * A clean abort: rather than corrupt the todo, we save the file unchanged and
   * point the user at the Abort Rebase command (which runs `git rebase
   * --abort`). This avoids the risk of git interpreting a half-cleared file.
   */
  private async abort(document: vscode.TextDocument): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      "Abort this interactive rebase? No commits will be changed.",
      { modal: true },
      "Abort Rebase",
    );
    if (choice !== "Abort Rebase") {
      return;
    }
    // Clear the todo to a no-op so the in-flight `git rebase -i` exits cleanly
    // without replaying anything, then run --abort to unwind to the start.
    const original = document.getText();
    const eol = detectEol(original);
    const cleared = `noop${eol}`;
    this.selfWrites.add(cleared);
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(original.length),
    );
    edit.replace(document.uri, fullRange, cleared);
    await vscode.workspace.applyEdit(edit);
    await document.save();
    await vscode.commands.executeCommand("gitstudio.abortRebase");
  }
}

// ── Pure-ish helpers (no vscode) ─────────────────────────────────────────────

/** Map parsed commit entries to wire rows (index === the row id). */
function toRows(lines: RebaseLine[]): WireRebaseRow[] {
  const rows: WireRebaseRow[] = [];
  lines.forEach((line, index) => {
    if (line.kind === "commit") {
      rows.push({
        id: index,
        action: line.action,
        sha: line.sha,
        shortSha: line.sha.slice(0, 7),
        subject: line.subject,
      });
    }
  });
  return rows;
}

/**
 * Rebuild the line list so the commit slots are filled in the webview's order,
 * each carrying its (possibly retyped) action. Passthrough lines stay pinned to
 * their positions. Rows the user removed entirely become a `drop` of the
 * original entry (we never silently lose a commit). Order is the array order
 * the webview sent.
 */
function applyRowOrder(
  lines: RebaseLine[],
  orderedRows: Array<{ id: number; action: WireRebaseRow["action"] }>,
): RebaseLine[] {
  // Original commit entries keyed by their line index (the row id).
  const byId = new Map<number, RebaseCommitEntry>();
  const commitSlots: number[] = [];
  lines.forEach((line, index) => {
    if (line.kind === "commit") {
      byId.set(index, line);
      commitSlots.push(index);
    }
  });

  // Build the new ordered commit entries from the webview's list.
  const ordered: RebaseCommitEntry[] = [];
  const seen = new Set<number>();
  for (const row of orderedRows) {
    const original = byId.get(row.id);
    if (!original) {
      continue;
    }
    seen.add(row.id);
    ordered.push({ ...original, action: row.action });
  }
  // Any commit the webview didn't mention (defensive) is preserved as a drop so
  // we never silently lose it — though the UI always sends every row.
  for (const [id, entry] of byId) {
    if (!seen.has(id)) {
      ordered.push({ ...entry, action: "drop" });
    }
  }

  // Refill the commit slots in order; pad with extra drops if needed.
  const result = lines.slice();
  ordered.forEach((entry, i) => {
    if (i < commitSlots.length) {
      result[commitSlots[i]] = entry;
    } else {
      // More entries than slots can't happen (we only ever reorder), but guard.
      result.push(entry);
    }
  });
  return result;
}

function flash(message: string): void {
  void vscode.window.setStatusBarMessage(`$(check) ${message}`, 2500);
}
