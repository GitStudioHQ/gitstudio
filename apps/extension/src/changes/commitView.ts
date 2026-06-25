import * as vscode from "vscode";
import type { RepoManager, RepoEntry } from "../git/repoManager";
import { getNonce } from "../webview/html";

// The commit box: a WebviewView ("Commit") in the gitstudio container. A clean
// auto-growing message textarea, Amend / Sign-off toggles, an optional author
// override, the staged-file count, and Commit / Commit & Push buttons with
// keyboard-commit (Cmd/Ctrl+Enter, or Enter to commit). Theme-native via
// --vscode-* tokens, strict CSP + nonce, no external deps — vanilla JS inlined
// in the HTML (no separate esbuild entry needed for this small view).

interface FromWebview {
  type: "commit" | "requestState" | "amendToggled" | "generateMessage";
  message?: string;
  amend?: boolean;
  signoff?: boolean;
  author?: string;
  push?: boolean;
}

interface ToWebview {
  type: "state";
  stagedCount: number;
  lastMessage?: string;
  signoffDefault: boolean;
  busy?: boolean;
  /** Whether the GitBrain ✨ "Generate message" affordance should be shown. */
  aiEnabled?: boolean;
}

/**
 * The host-side hook the commit box uses to draft a message from the staged
 * diff. Injected (not imported) so this view stays decoupled from GitBrain and
 * the key stays 100% host-side — the webview only ever receives the result text.
 * Returns null when AI is unavailable or nothing is staged.
 */
export interface CommitMessageGenerator {
  isEnabled(): Promise<boolean>;
  draft(entry: RepoEntry): Promise<string | null>;
}

export class CommitViewProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  static readonly viewId = "gitstudio.commit";

  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private busy = false;

  constructor(
    private readonly repos: RepoManager,
    private readonly onCommitted: () => void,
    /** Optional GitBrain hook for the ✨ "Generate message" button. */
    private readonly generator?: CommitMessageGenerator,
  ) {
    this.disposables.push(this.repos.onDidChange(() => void this.pushState()));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);

    this.disposables.push(
      view.webview.onDidReceiveMessage((msg: FromWebview) =>
        this.onMessage(msg),
      ),
    );
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        void this.pushState();
      }
    });
    void this.pushState();
  }

  /** Re-push state (e.g. staged count) to the webview after an external op. */
  requestState(): void {
    void this.pushState();
  }

  private async onMessage(msg: FromWebview): Promise<void> {
    if (msg.type === "requestState" || msg.type === "amendToggled") {
      await this.pushState(msg.type === "amendToggled" ? msg.amend : false);
      return;
    }
    if (msg.type === "generateMessage") {
      await this.doGenerate();
      return;
    }
    if (msg.type === "commit") {
      await this.doCommit(msg);
    }
  }

  /**
   * Draft a commit message from the staged diff via GitBrain and fill the box.
   * AI is optional: when there's no provider (or nothing staged), we toast a
   * friendly note and clear the button's loading state — never an error, and
   * never anything that touches the commit flow itself.
   */
  private async doGenerate(): Promise<void> {
    const entry = this.repos.getActive();
    if (!entry || !this.generator) {
      this.view?.webview.postMessage({ type: "generateDone" });
      return;
    }
    try {
      const text = await this.generator.draft(entry);
      if (text && text.trim().length > 0) {
        this.view?.webview.postMessage({ type: "setMessage", text });
      } else {
        void vscode.window.setStatusBarMessage(
          "$(sparkle) GitBrain: nothing to draft (stage changes first)",
          3000,
        );
      }
    } catch {
      // Stay silent — AI must never break the commit box.
    } finally {
      this.view?.webview.postMessage({ type: "generateDone" });
    }
  }

  /** Runs the commit (+ optional push), surfacing errors and clearing on success. */
  private async doCommit(msg: FromWebview): Promise<void> {
    const entry = this.repos.getActive();
    if (!entry) {
      void vscode.window.showInformationMessage(
        "GitStudio: no Git repository is active.",
      );
      return;
    }
    const message = (msg.message ?? "").trim();
    if (message === "" && !msg.amend) {
      void vscode.window.showWarningMessage(
        "GitStudio: enter a commit message.",
      );
      return;
    }

    this.busy = true;
    void this.pushState();
    try {
      // An amend rewrites HEAD — wrap it in the Undo envelope so the prior
      // commit is one keystroke from restorable. A plain commit only adds a new
      // commit (already reachable via the normal Undo / reflog), so it runs
      // directly.
      const doCommit = () =>
        entry.ctx.staging.commit(message, {
          amend: msg.amend,
          signoff: msg.signoff,
          author: msg.author?.trim() || undefined,
        });
      const ledger = this.repos.getUndoLedger();
      const result =
        msg.amend && ledger
          ? await ledger.runWithUndo(entry, "Amend commit", doCommit)
          : await doCommit();
      if (!result.ok) {
        void vscode.window.showErrorMessage(
          `GitStudio: commit failed — ${result.stderr.trim() || "unknown error"}`,
        );
        return;
      }

      if (msg.push) {
        const push = await entry.ctx.process.run(["push"]);
        if (push.code !== 0) {
          void vscode.window.showErrorMessage(
            `GitStudio: commit succeeded, but push failed — ${
              push.stderr.trim() || "unknown error"
            }`,
          );
        } else {
          void vscode.window.setStatusBarMessage("$(check) Committed & pushed", 3000);
        }
      } else {
        void vscode.window.setStatusBarMessage("$(check) Committed", 3000);
      }

      // Clear the box and refresh the views.
      this.view?.webview.postMessage({ type: "clear" });
      this.onCommitted();
    } finally {
      this.busy = false;
      void this.pushState();
    }
  }

  /**
   * Pushes the current state to the webview: staged count, and — when `amend`
   * is requested — the last commit's subject+body to prefill the message.
   */
  private async pushState(amend = false): Promise<void> {
    if (!this.view) {
      return;
    }
    const entry = this.repos.getActive();
    const stagedCount = entry ? await this.countStaged(entry) : 0;
    const lastMessage = amend && entry ? await this.lastMessage(entry) : undefined;
    const signoffDefault = vscode.workspace
      .getConfiguration("gitstudio")
      .get<boolean>("commit.signoffByDefault", false);
    const aiEnabled = this.generator
      ? await this.generator.isEnabled().catch(() => false)
      : false;

    const state: ToWebview = {
      type: "state",
      stagedCount,
      lastMessage,
      signoffDefault,
      busy: this.busy,
      aiEnabled,
    };
    void this.view.webview.postMessage(state);
  }

  private async countStaged(entry: RepoEntry): Promise<number> {
    try {
      return await entry.ctx.staging.stagedCount();
    } catch {
      return 0;
    }
  }

  /** The HEAD commit's full message (subject + body) for amend prefill. */
  private async lastMessage(entry: RepoEntry): Promise<string | undefined> {
    try {
      for await (const commit of entry.ctx.log.streamCommits({ maxCount: 1 })) {
        const body = commit.body.trim();
        return body ? `${commit.subject}\n\n${body}` : commit.subject;
      }
    } catch {
      // No commits yet.
    }
    return undefined;
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp = [
      `default-src 'none'`,
      `style-src 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      padding: 8px;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      background: var(--vscode-sideBar-background, transparent);
    }
    .count {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin: 0 2px 6px;
    }
    textarea {
      width: 100%;
      box-sizing: border-box;
      resize: none;
      min-height: 54px;
      max-height: 320px;
      padding: 6px 8px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      line-height: 1.4;
      outline: none;
    }
    textarea:focus { border-color: var(--vscode-focusBorder); }
    textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
    .message-wrap { position: relative; }
    .sparkle {
      position: absolute;
      top: 4px;
      right: 4px;
      display: none;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      padding: 0;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      font-size: 13px;
      line-height: 1;
    }
    .sparkle.visible { display: inline-flex; }
    .sparkle:hover {
      color: var(--vscode-foreground);
      background: var(--vscode-toolbar-hoverBackground, rgba(127, 127, 127, 0.18));
    }
    .sparkle:disabled { cursor: default; opacity: 0.7; }
    .sparkle.loading { animation: spin 0.9s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .toggles {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 12px;
      align-items: center;
      margin: 8px 2px 6px;
      font-size: 12px;
    }
    .toggles label { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
    .author-row { margin: 0 0 8px; }
    .author-row.hidden { display: none; }
    .author-row input {
      width: 100%;
      box-sizing: border-box;
      padding: 4px 8px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px;
      font-size: 12px;
      outline: none;
    }
    .author-row input:focus { border-color: var(--vscode-focusBorder); }
    .link {
      background: none; border: none; padding: 0;
      color: var(--vscode-textLink-foreground);
      cursor: pointer; font-size: 11px;
    }
    .actions { display: flex; gap: 6px; }
    button.primary {
      flex: 1;
      padding: 6px 10px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: none; border-radius: 4px;
      cursor: pointer; font-size: 13px; font-weight: 600;
    }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button.primary:disabled { opacity: 0.5; cursor: default; }
    button.split {
      padding: 6px 10px;
      color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
      background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
      border: none; border-radius: 4px; cursor: pointer; font-size: 13px;
    }
    button.split:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground));
    }
    button.split:disabled { opacity: 0.5; cursor: default; }
    .hint { margin: 6px 2px 0; font-size: 10px; color: var(--vscode-descriptionForeground); }
  </style>
</head>
<body>
  <div class="count" id="count">No staged changes</div>
  <div class="message-wrap">
    <textarea id="message" rows="3"
      placeholder="Message (Enter to commit, summary + description)"
      aria-label="Commit message"></textarea>
    <button class="sparkle" id="generate" type="button"
      title="Generate commit message with GitBrain"
      aria-label="Generate commit message">&#x2728;</button>
  </div>

  <div class="toggles">
    <label><input type="checkbox" id="amend" /> Amend</label>
    <label><input type="checkbox" id="signoff" /> Sign-off</label>
    <button class="link" id="author-toggle" type="button">Author…</button>
  </div>

  <div class="author-row hidden" id="author-row">
    <input id="author" type="text"
      placeholder="Author override — Name &lt;email@example.com&gt;"
      aria-label="Author override" />
  </div>

  <div class="actions">
    <button class="primary" id="commit" type="button">Commit</button>
    <button class="split" id="commit-push" type="button" title="Commit &amp; Push">
      Commit &amp; Push
    </button>
  </div>
  <div class="hint">Cmd/Ctrl+Enter to commit · Enter on the message commits</div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);
    const message = $("message");
    const amend = $("amend");
    const signoff = $("signoff");
    const authorRow = $("author-row");
    const author = $("author");
    const commitBtn = $("commit");
    const pushBtn = $("commit-push");
    const generateBtn = $("generate");
    const count = $("count");
    let stagedCount = 0;
    let generating = false;

    function autoGrow() {
      message.style.height = "auto";
      message.style.height = Math.min(message.scrollHeight, 320) + "px";
    }
    message.addEventListener("input", autoGrow);

    function setBusy(busy) {
      commitBtn.disabled = busy;
      pushBtn.disabled = busy;
    }

    function renderCount() {
      if (amend.checked) {
        count.textContent = stagedCount > 0
          ? "Amend · " + stagedCount + " staged " + (stagedCount === 1 ? "file" : "files")
          : "Amend last commit";
      } else if (stagedCount === 0) {
        count.textContent = "No staged changes";
      } else {
        count.textContent = "Commit " + stagedCount + " staged " + (stagedCount === 1 ? "file" : "files");
      }
      commitBtn.textContent = amend.checked ? "Amend" : "Commit";
    }

    function doCommit(push) {
      vscode.postMessage({
        type: "commit",
        message: message.value,
        amend: amend.checked,
        signoff: signoff.checked,
        author: author.value,
        push: !!push,
      });
    }

    commitBtn.addEventListener("click", () => doCommit(false));
    pushBtn.addEventListener("click", () => doCommit(true));

    function setGenerating(on) {
      generating = on;
      generateBtn.disabled = on;
      generateBtn.classList.toggle("loading", on);
      generateBtn.innerHTML = on ? "&#x21BB;" : "&#x2728;";
    }

    generateBtn.addEventListener("click", () => {
      if (generating) return;
      setGenerating(true);
      vscode.postMessage({ type: "generateMessage" });
    });

    amend.addEventListener("change", () => {
      renderCount();
      // Ask the host for the last message to prefill (or to clear on un-toggle).
      vscode.postMessage({ type: "amendToggled", amend: amend.checked });
    });

    $("author-toggle").addEventListener("click", () => {
      authorRow.classList.toggle("hidden");
      if (!authorRow.classList.contains("hidden")) author.focus();
    });

    message.addEventListener("keydown", (e) => {
      // Enter commits; Shift+Enter inserts a newline. Cmd/Ctrl+Enter also commits.
      const commit = e.key === "Enter" && (!e.shiftKey || e.metaKey || e.ctrlKey);
      if (commit) {
        e.preventDefault();
        doCommit(false);
      }
    });

    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.type === "state") {
        stagedCount = msg.stagedCount || 0;
        setBusy(!!msg.busy);
        generateBtn.classList.toggle("visible", !!msg.aiEnabled);
        if (typeof msg.lastMessage === "string" && amend.checked && message.value.trim() === "") {
          message.value = msg.lastMessage;
          autoGrow();
        }
        if (msg.signoffDefault && !signoff.dataset.touched) {
          signoff.checked = true;
        }
        renderCount();
      } else if (msg.type === "setMessage") {
        if (typeof msg.text === "string") {
          message.value = msg.text;
          autoGrow();
        }
      } else if (msg.type === "generateDone") {
        setGenerating(false);
      } else if (msg.type === "clear") {
        message.value = "";
        amend.checked = false;
        author.value = "";
        autoGrow();
        renderCount();
      }
    });

    signoff.addEventListener("change", () => { signoff.dataset.touched = "1"; });

    vscode.postMessage({ type: "requestState" });
    renderCount();
  </script>
</body>
</html>`;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}
