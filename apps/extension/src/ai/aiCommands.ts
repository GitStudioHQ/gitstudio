import * as vscode from "vscode";
import type { RepoManager, RepoEntry } from "../git/repoManager";
import {
  GitBrain,
  ANTHROPIC_KEY_SECRET,
  OPENAI_KEY_SECRET,
} from "./gitBrain";
import { getNonce } from "../webview/html";

// Command implementations for the GitBrain AI layer: key management
// (SecretStorage — never sent to a webview), the seamless model picker, and the
// explain / summarize palette commands that render their Markdown result in a
// webview panel. The commit-box ✨ lives in commitView.ts and the native SCM
// input; the staged-diff drafting helper they share is exported here so every
// surface uses one code path.

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

/**
 * Store the OpenAI-compatible key (password input) in SecretStorage. The key is
 * OPTIONAL — local servers (Ollama / LM Studio) need none — so an empty entry
 * clears it rather than warning.
 */
export async function setOpenAIKey(
  context: vscode.ExtensionContext,
  brain: GitBrain,
): Promise<void> {
  const key = await vscode.window.showInputBox({
    title: "GitStudio: Set OpenAI API Key",
    prompt:
      "For OpenAI / Codex / OpenRouter. Leave blank for a local server (Ollama / LM Studio). Stored in your OS keychain; never sent to a webview.",
    password: true,
    ignoreFocusOut: true,
    placeHolder: "sk-… (blank for a local, keyless server)",
  });
  if (key === undefined) {
    return; // cancelled
  }
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    await context.secrets.delete(OPENAI_KEY_SECRET);
    await brain.refreshEnabled();
    void vscode.window.showInformationMessage(
      "GitStudio: OpenAI API key cleared (keyless / local mode).",
    );
    return;
  }
  await context.secrets.store(OPENAI_KEY_SECRET, trimmed);
  await brain.refreshEnabled();
  void vscode.window.showInformationMessage(
    "GitStudio: OpenAI API key saved.",
  );
}

/** Clear the stored OpenAI-compatible key. */
export async function clearOpenAIKey(
  context: vscode.ExtensionContext,
  brain: GitBrain,
): Promise<void> {
  await context.secrets.delete(OPENAI_KEY_SECRET);
  await brain.refreshEnabled();
  void vscode.window.showInformationMessage(
    "GitStudio: OpenAI API key cleared.",
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

/**
 * Draft from the staged diff, falling back to the full working-tree diff when
 * nothing is staged. Returns the message plus whether the source was unstaged
 * (so the SCM ✨ can tell the user). Null when AI is unavailable or there's no
 * diff at all.
 */
async function draftCommitMessageWithFallback(
  brain: GitBrain,
  entry: RepoEntry,
  signal?: AbortSignal,
): Promise<{ message: string; unstaged: boolean } | null> {
  let diff = await stagedDiff(entry);
  let unstaged = false;
  if (diff.trim().length === 0) {
    diff = await workingDiff(entry);
    unstaged = true;
  }
  if (diff.trim().length === 0) {
    return null;
  }
  const subjects = await recentSubjects(entry);
  const message = await brain.generateCommitMessage(diff, {
    recentSubjects: subjects,
    signal,
  });
  return message ? { message, unstaged } : null;
}

/** The working-tree diff (`git diff`), or "" on any failure. */
async function workingDiff(entry: RepoEntry): Promise<string> {
  try {
    const res = await entry.ctx.process.run(["diff"]);
    return res.code === 0 ? res.stdout : "";
  } catch {
    return "";
  }
}

/**
 * Generate a commit message.
 *
 * Two surfaces, one handler:
 *  - From the NATIVE Source Control input box, VS Code passes a
 *    `vscode.SourceControl` (with `.inputBox.value` and `.rootUri`). We resolve
 *    that repo, draft from its staged diff (falling back to the working diff,
 *    noting it's unstaged), and set the input box value directly.
 *  - From the command palette (no arg), we draft for the active repo and offer
 *    to copy the result.
 *
 * If no provider is set up, we offer a one-click "Select AI Model…" path.
 */
export async function generateCommitMessageCommand(
  brain: GitBrain,
  repos: RepoManager,
  arg?: unknown,
): Promise<void> {
  const sourceControl = asSourceControl(arg);
  if (sourceControl) {
    await generateForSourceControl(brain, repos, sourceControl);
    return;
  }

  const entry = repos.getActive();
  if (!entry) {
    void vscode.window.showInformationMessage(
      "GitStudio: no Git repository is active.",
    );
    return;
  }
  if (!(await brain.isEnabled())) {
    await offerAiSetup();
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

/** Draft into the native SCM input box for the given SourceControl. */
async function generateForSourceControl(
  brain: GitBrain,
  repos: RepoManager,
  sourceControl: SourceControlLike,
): Promise<void> {
  const entry = resolveRepoForSourceControl(repos, sourceControl);
  if (!entry) {
    void vscode.window.showInformationMessage(
      "GitStudio: couldn't match this Source Control repository.",
    );
    return;
  }
  if (!(await brain.isEnabled())) {
    await offerAiSetup();
    return;
  }
  const drafted = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.SourceControl, title: "GitBrain: drafting commit message…" },
    () => draftCommitMessageWithFallback(brain, entry),
  );
  if (!drafted) {
    void vscode.window.showInformationMessage(
      "GitStudio: nothing to draft (stage changes first), or AI is unavailable.",
    );
    return;
  }
  if (sourceControl.inputBox) {
    sourceControl.inputBox.value = drafted.message;
  }
  if (drafted.unstaged) {
    void vscode.window.setStatusBarMessage(
      "$(sparkle) GitBrain drafted from unstaged changes (nothing was staged)",
      4000,
    );
  }
}

/** Resolve the repo for a SourceControl by its rootUri, else the active repo. */
function resolveRepoForSourceControl(
  repos: RepoManager,
  sourceControl: SourceControlLike,
): RepoEntry | undefined {
  const rootFsPath = sourceControl.rootUri?.fsPath;
  if (rootFsPath) {
    const match = repos
      .getAll()
      .find((e) => e.root === rootFsPath);
    if (match) {
      return match;
    }
  }
  return repos.getActive();
}

/** The minimal SourceControl surface we touch (declared for the 1.74 baseline). */
interface SourceControlLike {
  inputBox?: { value: string };
  rootUri?: vscode.Uri;
}

/** True when the command arg is a vscode.SourceControl (from the SCM input box). */
function asSourceControl(arg: unknown): SourceControlLike | undefined {
  if (
    arg &&
    typeof arg === "object" &&
    "inputBox" in arg &&
    (arg as SourceControlLike).inputBox !== undefined
  ) {
    return arg as SourceControlLike;
  }
  return undefined;
}

/** Offer a one-click path into the model picker when no provider is set up. */
async function offerAiSetup(): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    "Set up GitStudio AI to draft commit messages.",
    "Select AI Model…",
  );
  if (choice === "Select AI Model…") {
    await vscode.commands.executeCommand("gitstudio.ai.selectModel");
  }
}

/**
 * The seamless model picker (gitstudio.ai.selectModel). Lists what's actually
 * available — every vscode.lm chat model (Copilot's AND Cursor's, no vendor
 * filter), plus Anthropic and an OpenAI-compatible/local entry — and wires the
 * pick straight into `gitstudio.ai.provider` (+ the remembered model id / keys).
 */
export async function selectModelCommand(
  context: vscode.ExtensionContext,
  brain: GitBrain,
): Promise<void> {
  interface ModelItem extends vscode.QuickPickItem {
    target: "lm" | "anthropic" | "openai";
    modelId?: string;
  }

  const items: ModelItem[] = [];

  const lmModels = await brain.listLmModels();
  for (const m of lmModels) {
    const vendor = m.vendor || "Language Model";
    const family = m.family || m.name || m.id;
    items.push({
      target: "lm",
      modelId: m.id,
      label: `$(sparkle) ${vendor} · ${family}`,
      description: m.name && m.name !== family ? m.name : undefined,
      detail: "VS Code Language Model (zero-key) — Copilot / Cursor",
    });
  }

  items.push({
    target: "anthropic",
    label: "$(key) Claude (Anthropic) — set key…",
    detail: "Use Anthropic directly with your API key.",
  });

  const baseUrl = vscode.workspace
    .getConfiguration("gitstudio.ai")
    .get<string>("openai.baseUrl", "https://api.openai.com/v1");
  items.push({
    target: "openai",
    label: `$(server) OpenAI / local (OpenAI-compatible) — ${baseUrl}`,
    detail:
      "OpenAI, Codex, OpenRouter, or a local server (Ollama / LM Studio). Base URL / model / key.",
  });

  const pick = await vscode.window.showQuickPick(items, {
    title: "GitStudio: Select AI Model",
    placeHolder: "Pick the model GitBrain should use",
    ignoreFocusOut: true,
  });
  if (!pick) {
    return;
  }

  const cfg = vscode.workspace.getConfiguration("gitstudio.ai");
  if (pick.target === "lm") {
    await brain.setPreferredLmModelId(pick.modelId);
    await cfg.update("provider", "copilot", vscode.ConfigurationTarget.Global);
    await brain.refreshEnabled();
    void vscode.window.showInformationMessage(
      `GitStudio: using ${pick.label.replace(/^\$\([^)]*\)\s*/, "")}.`,
    );
    return;
  }

  if (pick.target === "anthropic") {
    await cfg.update("provider", "anthropic", vscode.ConfigurationTarget.Global);
    const hasKey = await context.secrets.get(ANTHROPIC_KEY_SECRET);
    if (!hasKey) {
      await setApiKey(context, brain);
    } else {
      await brain.refreshEnabled();
      void vscode.window.showInformationMessage(
        "GitStudio: using Claude (Anthropic).",
      );
    }
    return;
  }

  // OpenAI-compatible: offer to set base URL, model, and (optional) key.
  await cfg.update("provider", "openai", vscode.ConfigurationTarget.Global);
  await configureOpenAi(context, brain, cfg);
}

/** Prompt through the OpenAI-compatible base URL, model, and optional key. */
async function configureOpenAi(
  context: vscode.ExtensionContext,
  brain: GitBrain,
  cfg: vscode.WorkspaceConfiguration,
): Promise<void> {
  const baseUrl = await vscode.window.showInputBox({
    title: "GitStudio: OpenAI-compatible Base URL",
    prompt:
      "e.g. https://api.openai.com/v1 · http://localhost:11434/v1 (Ollama) · http://localhost:1234/v1 (LM Studio)",
    value: cfg.get<string>("openai.baseUrl", "https://api.openai.com/v1"),
    ignoreFocusOut: true,
  });
  if (baseUrl === undefined) {
    return; // cancelled
  }
  if (baseUrl.trim().length > 0) {
    await cfg.update(
      "openai.baseUrl",
      baseUrl.trim(),
      vscode.ConfigurationTarget.Global,
    );
  }

  const model = await vscode.window.showInputBox({
    title: "GitStudio: OpenAI-compatible Model",
    prompt:
      "Model ID for commit messages / explain (e.g. gpt-4o-mini, llama3.1, qwen2.5-coder).",
    value: cfg.get<string>("openai.modelFast", ""),
    ignoreFocusOut: true,
  });
  if (model === undefined) {
    return; // cancelled
  }
  if (model.trim().length > 0) {
    // Set the fast tier (used for commit messages) at minimum; mirror to mid so
    // explain/summaries also work out of the box if the user only sets one.
    await cfg.update(
      "openai.modelFast",
      model.trim(),
      vscode.ConfigurationTarget.Global,
    );
    if (!cfg.get<string>("openai.modelMid", "")) {
      await cfg.update(
        "openai.modelMid",
        model.trim(),
        vscode.ConfigurationTarget.Global,
      );
    }
  }

  await setOpenAIKey(context, brain);
  await brain.refreshEnabled();
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
