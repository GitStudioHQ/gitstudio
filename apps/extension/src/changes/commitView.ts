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
  /** Whether the GitBrain "Generate message" sparkle affordance should be shown. */
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
    /** Optional GitBrain hook for the "Generate message" sparkle button. */
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
    :root {
      color-scheme: light dark;
      --gs-font-ui: var(--vscode-font-family);
      --gs-fg: var(--vscode-foreground);
      --gs-fg-muted: var(--vscode-descriptionForeground);
      --gs-accent: var(--vscode-focusBorder);
      --gs-radius: 4px;
      --gs-motion: 150ms;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 10px 8px 8px;
      color: var(--gs-fg);
      font-family: var(--gs-font-ui);
      font-size: 13px;
      line-height: 1.4;
      background: var(--vscode-sideBar-background, transparent);
    }

    /* ---- Staged count strip ------------------------------------------- */
    .count {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11.5px;
      color: var(--gs-fg-muted);
      margin: 0 2px 8px;
    }
    .count .dot {
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--gs-fg-muted);
      flex: 0 0 auto;
    }
    .count.is-staged .dot {
      background: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-charts-green));
    }
    .count .num {
      font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
      font-variant-numeric: tabular-nums;
      font-weight: 600;
      color: var(--gs-fg);
    }

    /* ---- Message field ------------------------------------------------- */
    .message-wrap { position: relative; }
    textarea {
      width: 100%;
      resize: none;
      min-height: 56px;
      max-height: 320px;
      padding: 7px 9px;
      padding-right: 34px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: var(--gs-radius);
      font-family: var(--gs-font-ui);
      font-size: 13px;
      line-height: 1.45;
      outline: none;
      transition: border-color var(--gs-motion) ease;
    }
    textarea:focus { border-color: var(--gs-accent); }
    textarea::placeholder { color: var(--vscode-input-placeholderForeground); }

    /* ---- Sparkle / generate button (crisp SVG, never emoji) ----------- */
    .sparkle {
      position: absolute;
      top: 5px;
      right: 5px;
      display: none;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      padding: 0;
      border: none;
      border-radius: var(--gs-radius);
      background: transparent;
      color: var(--gs-fg-muted);
      cursor: pointer;
      transition: color var(--gs-motion) ease, background var(--gs-motion) ease;
    }
    .sparkle.visible { display: inline-flex; }
    .sparkle svg { width: 15px; height: 15px; display: block; }
    .sparkle .spinner { display: none; }
    .sparkle.loading .glyph { display: none; }
    .sparkle.loading .spinner { display: block; }
    .sparkle:hover {
      color: var(--vscode-textLink-foreground, var(--gs-fg));
      background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
    }
    .sparkle:disabled { cursor: default; }
    .sparkle:focus-visible { outline: 1px solid var(--gs-accent); outline-offset: 1px; }
    .sparkle.loading .spinner { animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ---- Toggles row --------------------------------------------------- */
    .toggles {
      display: flex;
      flex-wrap: wrap;
      gap: 6px 14px;
      align-items: center;
      margin: 10px 2px 8px;
      font-size: 12px;
    }
    .toggles label {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      color: var(--gs-fg);
    }
    .toggles input[type="checkbox"] { accent-color: var(--gs-accent); margin: 0; }
    .toggles label:focus-within { outline: none; }

    /* ---- Author override row ------------------------------------------ */
    .author-row { margin: 0 0 8px; }
    .author-row.hidden { display: none; }
    .author-row input {
      width: 100%;
      padding: 5px 9px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: var(--gs-radius);
      font-family: var(--gs-font-ui);
      font-size: 12px;
      outline: none;
      transition: border-color var(--gs-motion) ease;
    }
    .author-row input:focus { border-color: var(--gs-accent); }

    /* ---- Inline link button (Author…) --------------------------------- */
    .link {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: none; border: none; padding: 2px 2px;
      color: var(--vscode-textLink-foreground);
      cursor: pointer; font-size: 11.5px;
      border-radius: var(--gs-radius);
    }
    .link svg { width: 12px; height: 12px; }
    .link[aria-expanded="true"] .chev { transform: rotate(180deg); }
    .link .chev { transition: transform var(--gs-motion) ease; }

    /* ---- Action buttons ------------------------------------------------ */
    .actions { display: flex; gap: 6px; }
    button.gs-commit {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      border: 1px solid transparent;
      border-radius: var(--gs-radius);
      padding: 6px 10px;
      cursor: pointer;
      font-family: var(--gs-font-ui);
      font-size: 13px;
      line-height: 1.2;
      transition: background var(--gs-motion) ease, opacity var(--gs-motion) ease;
    }
    button.gs-commit svg { width: 14px; height: 14px; flex: 0 0 auto; }
    button.primary {
      flex: 1;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      font-weight: 600;
    }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button.split {
      color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
      background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
    }
    button.split:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground));
    }
    button.gs-commit:disabled { opacity: 0.45; cursor: default; }
    button:focus-visible { outline: 1px solid var(--gs-accent); outline-offset: 2px; }
    .link:focus-visible { outline: 1px solid var(--gs-accent); outline-offset: 1px; }

    /* ---- Keyboard hint ------------------------------------------------- */
    .hint {
      margin: 8px 2px 0;
      font-size: 10.5px;
      color: var(--gs-fg-muted);
    }
    .hint kbd {
      font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
      font-size: 10px;
      padding: 0 3px;
      border-radius: 3px;
      background: color-mix(in srgb, var(--gs-fg-muted) 16%, transparent);
      color: var(--gs-fg);
    }

    @media (prefers-reduced-motion: reduce) {
      textarea, .author-row input, .sparkle, button.gs-commit, .link .chev {
        transition: none;
      }
      .sparkle.loading .spinner { animation: none; }
    }
  </style>
</head>
<body>
  <div class="count" id="count">
    <span class="dot" aria-hidden="true"></span>
    <span id="count-text">No staged changes</span>
  </div>
  <div class="message-wrap">
    <textarea id="message" rows="3"
      placeholder="Message (Enter to commit, summary + description)"
      aria-label="Commit message"></textarea>
    <button class="sparkle" id="generate" type="button"
      title="Generate commit message with GitBrain"
      aria-label="Generate commit message">
      <svg class="glyph" viewBox="0 0 16 16" fill="none" stroke="currentColor"
        stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M8 1.6l1.5 3.9 3.9 1.5-3.9 1.5L8 12.4 6.5 8.5 2.6 7l3.9-1.5z"/>
        <path d="M12.8 11.2l.7 1.7 1.7.7-1.7.7-.7 1.7-.7-1.7-1.7-.7 1.7-.7z"/>
      </svg>
      <svg class="spinner" viewBox="0 0 16 16" fill="none" stroke="currentColor"
        stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
        <path d="M8 1.8a6.2 6.2 0 1 1-4.4 1.8" opacity="0.9"/>
      </svg>
    </button>
  </div>

  <div class="toggles">
    <label><input type="checkbox" id="amend" /> Amend</label>
    <label><input type="checkbox" id="signoff" /> Sign-off</label>
    <button class="link" id="author-toggle" type="button" aria-expanded="false"
      aria-controls="author-row">
      Author
      <svg class="chev" viewBox="0 0 16 16" fill="none" stroke="currentColor"
        stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M4 6l4 4 4-4"/>
      </svg>
    </button>
  </div>

  <div class="author-row hidden" id="author-row">
    <input id="author" type="text"
      placeholder="Author override — Name &lt;email@example.com&gt;"
      aria-label="Author override" />
  </div>

  <div class="actions">
    <button class="gs-commit primary" id="commit" type="button">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="8" cy="8" r="2.4"/>
        <path d="M8 1.4v4.2M8 10.4v4.2"/>
      </svg>
      <span id="commit-label">Commit</span>
    </button>
    <button class="gs-commit split" id="commit-push" type="button"
      title="Commit &amp; Push" aria-label="Commit and Push">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M8 13.5V4.5M4.5 8L8 4.5 11.5 8"/>
      </svg>
      <span>Push</span>
    </button>
  </div>
  <div class="hint">
    <kbd>Enter</kbd> to commit · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
  </div>

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
    const countText = $("count-text");
    const commitLabel = $("commit-label");
    const authorToggle = $("author-toggle");
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
      const files = (n) => n + " staged " + (n === 1 ? "file" : "files");
      if (amend.checked) {
        countText.textContent = stagedCount > 0
          ? "Amend · " + files(stagedCount)
          : "Amend last commit";
        count.classList.toggle("is-staged", stagedCount > 0);
      } else if (stagedCount === 0) {
        countText.textContent = "No staged changes";
        count.classList.remove("is-staged");
      } else {
        countText.textContent = "Commit " + files(stagedCount);
        count.classList.add("is-staged");
      }
      commitLabel.textContent = amend.checked ? "Amend" : "Commit";
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
      generateBtn.setAttribute(
        "aria-label",
        on ? "Generating commit message…" : "Generate commit message",
      );
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

    authorToggle.addEventListener("click", () => {
      authorRow.classList.toggle("hidden");
      const open = !authorRow.classList.contains("hidden");
      authorToggle.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) author.focus();
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
        authorRow.classList.add("hidden");
        authorToggle.setAttribute("aria-expanded", "false");
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
