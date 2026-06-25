import * as vscode from "vscode";
import type { RepoManager, RepoEntry } from "../git/repoManager";
import { GitBrain, ANTHROPIC_KEY_SECRET } from "./gitBrain";
import { getNonce } from "../webview/html";

// Command implementations for the GitBrain AI layer (M10): key management
// (SecretStorage — never sent to a webview), and the explain / summarize
// palette commands that render their Markdown result in a webview panel.
// The commit-box ✨ lives in commitView.ts; the staged-diff drafting helper it
// calls is exported here so both share one code path.

/** Store the Anthropic key (password input) in SecretStorage. */
export async function setApiKey(
  context: vscode.ExtensionContext,
  brain: GitBrain,
): Promise<void> {
  const key = await vscode.window.showInputBox({
    title: "GitStudio: Set Anthropic API Key",
    prompt: "Stored securely in your OS keychain (SecretStorage). Never sent to a webview.",
    password: true,
    ignoreFocusOut: true,
    placeHolder: "sk-ant-…",
  });
  if (key === undefined) {
    return; // cancelled
  }
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    void vscode.window.showWarningMessage("GitStudio: no key entered.");
    return;
  }
  await context.secrets.store(ANTHROPIC_KEY_SECRET, trimmed);
  await brain.refreshEnabled();
  void vscode.window.showInformationMessage(
    "GitStudio: Anthropic API key saved. AI features are now available.",
  );
}

/** Clear the stored Anthropic key. */
export async function clearApiKey(
  context: vscode.ExtensionContext,
  brain: GitBrain,
): Promise<void> {
  await context.secrets.delete(ANTHROPIC_KEY_SECRET);
  await brain.refreshEnabled();
  void vscode.window.showInformationMessage(
    "GitStudio: Anthropic API key cleared.",
  );
}

/** Recent commit subjects (≤10) for the cacheable commit-style prefix. */
export async function recentSubjects(entry: RepoEntry): Promise<string[]> {
  const subjects: string[] = [];
  try {
    for await (const commit of entry.ctx.log.streamCommits({ maxCount: 10 })) {
      subjects.push(commit.subject);
    }
  } catch {
    // No commits yet, or log failed — an empty list is fine (prefix just omits examples).
  }
  return subjects;
}

/** The staged diff (`git diff --cached`), or "" on any failure. */
async function stagedDiff(entry: RepoEntry): Promise<string> {
  try {
    const res = await entry.ctx.process.run(["diff", "--cached"]);
    return res.code === 0 ? res.stdout : "";
  } catch {
    return "";
  }
}

/**
 * Draft a commit message from the staged diff. Shared by the palette command
 * and the commit-box ✨. Returns null when AI is unavailable or there's nothing
 * staged (so callers can stay silent / hide the affordance).
 */
export async function draftCommitMessage(
  brain: GitBrain,
  entry: RepoEntry,
  signal?: AbortSignal,
): Promise<string | null> {
  const diff = await stagedDiff(entry);
  if (diff.trim().length === 0) {
    return null;
  }
  const subjects = await recentSubjects(entry);
  return brain.generateCommitMessage(diff, {
    recentSubjects: subjects,
    signal,
  });
}

/** Palette command: generate a commit message and offer to copy it. */
export async function generateCommitMessageCommand(
  brain: GitBrain,
  repos: RepoManager,
): Promise<void> {
  const entry = repos.getActive();
  if (!entry) {
    void vscode.window.showInformationMessage(
      "GitStudio: no Git repository is active.",
    );
    return;
  }
  const message = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "GitBrain: drafting commit message…" },
    () => draftCommitMessage(brain, entry),
  );
  if (!message) {
    void vscode.window.showInformationMessage(
      "GitStudio: nothing staged, or AI is unavailable.",
    );
    return;
  }
  const action = await vscode.window.showInformationMessage(
    message,
    { modal: false },
    "Copy",
  );
  if (action === "Copy") {
    await vscode.env.clipboard.writeText(message);
    void vscode.window.setStatusBarMessage("$(check) Commit message copied", 2000);
  }
}

/** Combined diff for explain/summarize: prefer staged, fall back to working tree. */
async function activeDiff(entry: RepoEntry): Promise<string> {
  try {
    const cached = await entry.ctx.process.run(["diff", "--cached"]);
    if (cached.code === 0 && cached.stdout.trim().length > 0) {
      return cached.stdout;
    }
    const wt = await entry.ctx.process.run(["diff"]);
    return wt.code === 0 ? wt.stdout : "";
  } catch {
    return "";
  }
}

/** Palette command: explain the active diff, streaming Markdown into a panel. */
export async function explainDiffCommand(
  brain: GitBrain,
  repos: RepoManager,
): Promise<void> {
  const entry = repos.getActive();
  if (!entry) {
    void vscode.window.showInformationMessage(
      "GitStudio: no Git repository is active.",
    );
    return;
  }
  const diff = await activeDiff(entry);
  if (diff.trim().length === 0) {
    void vscode.window.showInformationMessage("GitStudio: no diff to explain.");
    return;
  }

  const panel = createResultPanel("GitBrain: Explain Diff");
  const source = new vscode.CancellationTokenSource();
  panel.onDidDispose(() => source.cancel());
  const controller = new AbortController();
  source.token.onCancellationRequested(() => controller.abort());

  let acc = "";
  const result = await brain.explainDiff(
    diff,
    (delta) => {
      acc += delta;
      panel.postMarkdown(acc);
    },
    controller.signal,
  );
  if (result === null && acc.trim().length === 0) {
    panel.postMarkdown("_GitBrain is unavailable or the request was declined._");
  } else if (result !== null) {
    panel.postMarkdown(result);
  }
}

/** Palette command: summarize the active changes into a panel. */
export async function summarizeChangesCommand(
  brain: GitBrain,
  repos: RepoManager,
): Promise<void> {
  const entry = repos.getActive();
  if (!entry) {
    void vscode.window.showInformationMessage(
      "GitStudio: no Git repository is active.",
    );
    return;
  }
  const diff = await activeDiff(entry);
  if (diff.trim().length === 0) {
    void vscode.window.showInformationMessage("GitStudio: no changes to summarize.");
    return;
  }

  const panel = createResultPanel("GitBrain: Summarize Changes");
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "GitBrain: summarizing…" },
    () => brain.summarizeChanges(diff),
  );
  panel.postMarkdown(
    result ?? "_GitBrain is unavailable or the request was declined._",
  );
}

// ── A tiny Markdown result panel ─────────────────────────────────────────────

interface ResultPanel {
  postMarkdown(markdown: string): void;
  onDidDispose(cb: () => void): void;
}

/**
 * A minimal webview panel that renders Markdown via VS Code's built-in
 * markdown-to-HTML (vscode.commands `markdown.api.render` is unavailable to
 * extensions, so we ship the text as a <pre>-safe payload and let a strict-CSP
 * inline script set textContent). We keep it dependency-free: the host renders
 * Markdown source as monospace-styled text — readable, safe, and bundle-light.
 */
function createResultPanel(title: string): ResultPanel {
  const panel = vscode.window.createWebviewPanel(
    "gitstudio.ai.result",
    title,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  const nonce = getNonce();
  panel.webview.html = resultHtml(nonce, title);

  return {
    postMarkdown(markdown: string): void {
      // Pass the raw Markdown text; the webview sets it as textContent (no HTML
      // injection — the key never goes here and neither does untrusted HTML).
      void panel.webview.postMessage({ type: "content", text: markdown });
    },
    onDidDispose(cb: () => void): void {
      panel.onDidDispose(cb);
    },
  };
}

function resultHtml(nonce: string, title: string): string {
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
  <title>${title}</title>
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    body {
      margin: 0; padding: 16px;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      background: var(--vscode-editor-background);
    }
    pre {
      white-space: pre-wrap;
      word-wrap: break-word;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: var(--vscode-editor-font-size, 13px);
      line-height: 1.5;
      margin: 0;
    }
    .empty { opacity: 0.6; font-style: italic; }
  </style>
</head>
<body>
  <pre id="out" class="empty">Waiting for GitBrain…</pre>
  <script nonce="${nonce}">
    const out = document.getElementById("out");
    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg && msg.type === "content") {
        out.classList.remove("empty");
        out.textContent = msg.text;
      }
    });
  </script>
</body>
</html>`;
}
