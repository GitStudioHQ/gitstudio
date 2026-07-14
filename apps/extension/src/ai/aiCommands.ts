import * as vscode from "vscode";
import type { RepoManager, RepoEntry } from "../git/repoManager";
import {
  GitBrain,
  ANTHROPIC_KEY_SECRET,
  OPENAI_KEY_SECRET,
} from "./gitBrain";
import { getNonce } from "../webview/html";

/** Shown in a result panel when no model is connected / the request was declined. */
const UNAVAILABLE_MESSAGE =
  "No AI model is connected. Connect one from the ✨ button in the Changes view, then try again.";

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

  const panel = createResultPanel("Explain Diff", "What this change does, in plain language");
  panel.postStatus("Reading the diff…");
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
    panel.postStatus(UNAVAILABLE_MESSAGE, "error");
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

  const panel = createResultPanel("Summarize Changes", "A high-level summary of your current changes");
  panel.postStatus("Summarizing your changes…");
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "GitBrain: summarizing…" },
    () => brain.summarizeChanges(diff),
  );
  if (result) {
    panel.postMarkdown(result);
  } else {
    panel.postStatus(UNAVAILABLE_MESSAGE, "error");
  }
}

/** Palette / button command: AI code review of the active changes, streamed
 *  into a Markdown panel. Reviews the staged diff (falling back to the working
 *  tree) with the built-in review prompt or the user's `reviewPrompt` override. */
export async function reviewChangesCommand(
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
    void vscode.window.showInformationMessage(
      "GitStudio: no changes to review — stage or edit some files first.",
    );
    return;
  }

  const panel = createResultPanel("Code Review", "AI review of your current changes");
  panel.postStatus("Reviewing your changes…");
  const source = new vscode.CancellationTokenSource();
  panel.onDidDispose(() => source.cancel());
  const controller = new AbortController();
  source.token.onCancellationRequested(() => controller.abort());

  let acc = "";
  const result = await brain.reviewChanges(
    diff,
    (delta) => {
      acc += delta;
      panel.postMarkdown(acc);
    },
    controller.signal,
  );
  if (result === null && acc.trim().length === 0) {
    panel.postStatus(
      "No AI model is connected. Connect one from the ✨ button in the Changes view, then run the review again.",
      "error",
    );
  } else if (result !== null) {
    panel.postMarkdown(result);
  }
}

// ── The GitBrain result panel ────────────────────────────────────────────────

interface ResultPanel {
  /** Render accumulated Markdown (safe: the webview escapes then renders it). */
  postMarkdown(markdown: string): void;
  /** Show a loading (or error) status block instead of content. */
  postStatus(text: string, kind?: "loading" | "error"): void;
  onDidDispose(cb: () => void): void;
}

/**
 * A polished webview panel that renders GitBrain's Markdown output as a real,
 * designed report — headings, lists, code blocks, links, plus severity badges
 * and file chips for code reviews. Dependency-free and strict-CSP: the inline
 * script HTML-escapes the text FIRST, then applies a small Markdown transform,
 * so untrusted model output can never inject markup. Streaming re-renders the
 * accumulated text on each delta.
 */
function createResultPanel(title: string, subtitle = ""): ResultPanel {
  const panel = vscode.window.createWebviewPanel(
    "gitstudio.ai.result",
    title,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  const nonce = getNonce();
  panel.webview.html = resultHtml(nonce, title, subtitle);

  return {
    postMarkdown(markdown: string): void {
      void panel.webview.postMessage({ type: "content", text: markdown });
    },
    postStatus(text: string, kind: "loading" | "error" = "loading"): void {
      void panel.webview.postMessage({ type: "status", text, kind });
    },
    onDidDispose(cb: () => void): void {
      panel.onDidDispose(cb);
    },
  };
}

function resultHtml(nonce: string, title: string, subtitle: string): string {
  const csp = [
    `default-src 'none'`,
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  // String.raw so the inline script's regex backslashes (\s, \d, \1, \n) survive
  // verbatim instead of being processed as template-literal escapes. ${...}
  // interpolation still works. The script avoids literal backticks via TICK.
  return String.raw`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: light dark;
      /* Brand + severity hues — pure hue only on rails, dots, fills */
      --accent: #7c5cf0;
      --high: #e5484d; --med: #f5a524; --low: #5b93ff; --ok: #2ea043;
      /* Severity TEXT — mixed toward foreground for light/dark legibility */
      --high-fg: color-mix(in srgb, var(--high) 84%, var(--vscode-foreground));
      --med-fg:  color-mix(in srgb, var(--med) 66%, var(--vscode-foreground));
      --low-fg:  color-mix(in srgb, var(--low) 82%, var(--vscode-foreground));
      --focus: color-mix(in srgb, var(--accent) 55%, transparent);
      /* Neutrals + material */
      --fg: var(--vscode-foreground);
      --muted: color-mix(in srgb, var(--vscode-foreground) 58%, transparent);
      --faint: color-mix(in srgb, var(--vscode-foreground) 40%, transparent);
      --sep: color-mix(in srgb, var(--vscode-foreground) 13%, transparent);
      --hairline: color-mix(in srgb, var(--vscode-foreground) 11%, transparent);
      --hairline-2: color-mix(in srgb, var(--vscode-foreground) 20%, transparent);
      --surface: var(--vscode-editorWidget-background, color-mix(in srgb, var(--vscode-foreground) 3.5%, var(--vscode-editor-background)));
      --code-bg: var(--vscode-textCodeBlock-background, color-mix(in srgb, var(--vscode-foreground) 6%, transparent));
      --shadow-2: 0 1px 2px color-mix(in srgb, #000 7%, transparent), 0 6px 16px color-mix(in srgb, #000 9%, transparent);
      /* 4px spacing scale */
      --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-5: 20px; --sp-6: 24px; --sp-7: 28px;
      /* Type scale */
      --fs-h1: 19px; --fs-h2: 15px; --fs-h3: 13.5px; --fs-eyebrow: 11px; --fs-body: 13px; --fs-code: 12px;
      --fs-count: 11.5px; --fs-badge: 10.5px;
      --lh-tight: 1.3; --lh-body: 1.62; --lh-dense: 1.5; --strong: 650;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; background: var(--vscode-editor-background); color: var(--fg);
      font-family: var(--vscode-font-family);
      font-size: var(--fs-body); line-height: var(--lh-body);
      -webkit-font-smoothing: antialiased;
    }
    .wrap { max-width: 820px; margin: 0 auto; padding: 0 30px 72px; }
    .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

    /* Header */
    header.hd {
      position: sticky; top: 0; z-index: 5;
      display: flex; align-items: center; gap: 12px;
      padding: var(--sp-5) 0 var(--sp-3); margin-bottom: var(--sp-1);
      background: linear-gradient(var(--vscode-editor-background) 72%, transparent);
      border-bottom: 1px solid var(--sep);
    }
    .hd .mark {
      width: 28px; height: 28px; border-radius: 8px; flex: 0 0 auto;
      display: grid; place-items: center;
      background: color-mix(in srgb, var(--accent) 16%, transparent);
      color: var(--accent);
    }
    .hd .mark svg { width: 16px; height: 16px; display: block; }
    .hd .titles { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    .hd .t { font-size: 13.5px; font-weight: var(--strong); letter-spacing: -0.01em; }
    .hd .s { font-size: 11.5px; color: var(--muted); }
    .hd .summary { margin-left: auto; display: flex; gap: var(--sp-2); align-items: center; flex-wrap: wrap; justify-content: flex-end; }
    .hd .counts { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }

    /* Copy-report pill (header, in the stable #act slot) */
    .copy-all { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; font-family: inherit; font-size: var(--fs-count); font-weight: 600; color: var(--muted); background: transparent; border: 1px solid var(--hairline); border-radius: 7px; cursor: pointer; transition: color .12s ease, border-color .12s ease, background .12s ease; }
    .copy-all[hidden] { display: none; }
    .copy-all .ci { display: grid; place-items: center; }
    .copy-all .ci svg { width: 13px; height: 13px; display: block; }
    .copy-all:hover { color: var(--fg); border-color: var(--hairline-2); background: color-mix(in srgb, var(--vscode-foreground) 5%, transparent); }
    .copy-all:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
    .copy-all.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, transparent); }
    .copy-all.err { color: var(--high-fg); border-color: color-mix(in srgb, var(--high) 40%, transparent); }

    /* Count pills */
    .count { display: inline-flex; align-items: center; gap: 5px; font-size: var(--fs-count); font-weight: 600; letter-spacing: .01em; font-variant-numeric: tabular-nums; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--sep); color: var(--muted); }
    .count .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--faint); }
    .count.high { color: var(--high-fg); border-color: color-mix(in srgb, var(--high) 30%, transparent); } .count.high .dot { background: var(--high); }
    .count.med  { color: var(--med-fg);  border-color: color-mix(in srgb, var(--med) 30%, transparent); } .count.med .dot { background: var(--med); }
    .count.low  { color: var(--low-fg);  border-color: color-mix(in srgb, var(--low) 30%, transparent); } .count.low .dot { background: var(--low); }
    .count.clean { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 32%, transparent); } .count.clean .dot { background: var(--ok); }

    /* States */
    .status { display: flex; align-items: center; gap: var(--sp-3); color: var(--muted); padding: var(--sp-6) 0 var(--sp-2); font-size: 13px; }
    .status.error { align-items: flex-start; gap: 10px; padding: var(--sp-3) var(--sp-4); border: 1px solid color-mix(in srgb, var(--high) 30%, transparent); background: color-mix(in srgb, var(--high) 6%, transparent); border-radius: 10px; color: var(--fg); margin-top: var(--sp-4); }
    .status.error .ico { color: var(--high-fg); flex: 0 0 auto; margin-top: 1px; }
    .status.error .ico svg { width: 16px; height: 16px; display: block; }
    .spinner { width: 15px; height: 15px; border-radius: 50%; border: 2px solid var(--sep); border-top-color: var(--accent); animation: spin .8s linear infinite; flex: 0 0 auto; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .skel { display: flex; flex-direction: column; gap: var(--sp-3); margin-top: var(--sp-4); }
    .skel .card { height: 62px; border: 1px solid var(--hairline); border-radius: 10px; background: var(--surface); animation: pulse 1.5s ease-in-out infinite; }
    .skel .card:nth-child(2) { animation-delay: .18s; opacity: .7; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .5; } }

    /* Rendered Markdown */
    .doc { max-width: 72ch; }
    .doc > :first-child { margin-top: var(--sp-1); }
    .doc > p:first-of-type { font-size: 13.5px; line-height: 1.6; color: color-mix(in srgb, var(--vscode-foreground) 88%, transparent); margin-bottom: var(--sp-5); }
    .doc h1, .doc h2, .doc h3, .doc h4 { line-height: var(--lh-tight); font-weight: var(--strong); margin: var(--sp-7) 0 var(--sp-3); }
    .doc h1 { font-size: var(--fs-h1); font-weight: 660; letter-spacing: -0.02em; }
    .doc h2 { font-size: var(--fs-h2); letter-spacing: -0.012em; padding-bottom: var(--sp-2); border-bottom: 1px solid var(--sep); }
    .doc h3 { font-size: var(--fs-h3); letter-spacing: -0.008em; margin-top: var(--sp-6); }
    .doc h4 { font-size: var(--fs-eyebrow); font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin-top: var(--sp-5); }
    .doc p { margin: var(--sp-3) 0; }
    .doc ul, .doc ol { margin: var(--sp-3) 0; padding-left: 2px; list-style: none; }
    .doc ol { counter-reset: li; }
    .doc li { position: relative; margin: var(--sp-2) 0; padding-left: 22px; }
    .doc ul > li::before { content: ""; position: absolute; left: 6px; top: 9px; width: 5px; height: 5px; border-radius: 50%; background: var(--faint); }
    .doc ol > li { counter-increment: li; }
    .doc ol > li::before { content: counter(li); position: absolute; left: 0; top: 0; color: var(--faint); font-variant-numeric: tabular-nums; font-weight: 600; font-size: 11.5px; }
    .doc a { color: var(--vscode-textLink-foreground); text-decoration: none; }
    .doc a:hover { text-decoration: underline; }
    .doc code {
      font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, monospace);
      font-size: var(--fs-code); background: var(--code-bg);
      border: 1px solid var(--sep); border-radius: 5px; padding: 1px 5px;
    }
    .doc code.path { color: var(--vscode-textLink-foreground); background: color-mix(in srgb, var(--vscode-textLink-foreground) 9%, transparent); border-color: color-mix(in srgb, var(--vscode-textLink-foreground) 22%, transparent); font-weight: 500; }
    .doc pre { background: var(--code-bg); border: 1px solid var(--sep); border-radius: 10px; padding: var(--sp-3) var(--sp-4); overflow-x: auto; margin: var(--sp-4) 0; }
    .doc pre code { background: none; border: none; padding: 0; font-size: 12.5px; line-height: 1.55; display: block; }
    .doc blockquote { margin: var(--sp-4) 0; padding: var(--sp-2) var(--sp-4); border-left: 3px solid var(--accent); background: color-mix(in srgb, var(--accent) 7%, transparent); border-radius: 0 8px 8px 0; color: var(--muted); }
    .doc blockquote p { margin: var(--sp-1) 0; }
    .doc hr { border: none; border-top: 1px solid var(--sep); margin: var(--sp-6) 0; }
    .doc strong { font-weight: var(--strong); color: var(--fg); }
    .doc table { border-collapse: collapse; margin: var(--sp-4) 0; font-size: 12.5px; width: 100%; }
    .doc th, .doc td { border: 1px solid var(--sep); padding: 7px 11px; text-align: left; }
    .doc th { background: var(--code-bg); font-weight: var(--strong); }

    /* Severity badges — text uses -fg variants + hue hairline; dot stays pure hue */
    .sev { display: inline-flex; align-items: center; gap: 5px; font-size: var(--fs-badge); font-weight: 700; letter-spacing: .04em; text-transform: uppercase; padding: 2px 8px; border-radius: 6px; border: 1px solid transparent; vertical-align: middle; margin-right: 6px; }
    .sev::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
    .sev-high { color: var(--high-fg); background: color-mix(in srgb, var(--high) 14%, transparent); border-color: color-mix(in srgb, var(--high) 28%, transparent); }
    .sev-med  { color: var(--med-fg);  background: color-mix(in srgb, var(--med) 15%, transparent);  border-color: color-mix(in srgb, var(--med) 28%, transparent); }
    .sev-low  { color: var(--low-fg);  background: color-mix(in srgb, var(--low) 15%, transparent);  border-color: color-mix(in srgb, var(--low) 26%, transparent); }
    .sev-nit, .sev-info { color: var(--muted); background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent); border-color: var(--sep); }
    .sev-high::before { background: var(--high); }
    .sev-med::before  { background: var(--med); }
    .sev-low::before  { background: var(--low); }

    /* Finding cards — raised material with a clipped severity rail */
    .doc li.finding {
      --sev-rail: var(--sep);
      position: relative; margin: var(--sp-3) 0; padding: var(--sp-3) 44px 14px var(--sp-4);
      border: 1px solid var(--hairline); border-radius: 10px; background: var(--surface);
      line-height: var(--lh-dense);
      transition: border-color .12s ease, box-shadow .12s ease, transform .12s ease;
    }
    .doc li.finding::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; height: auto; width: 2px; background: var(--sev-rail); border-radius: 10px 0 0 10px; }
    .doc li.finding + li.finding { margin-top: var(--sp-3); }
    .doc li.finding.high { --sev-rail: var(--high); }
    .doc li.finding.med  { --sev-rail: var(--med); }
    .doc li.finding.low  { --sev-rail: var(--low); }
    .doc li.finding:hover { border-color: var(--hairline-2); box-shadow: var(--shadow-2); transform: translateY(-1px); }
    .doc li.finding strong { font-weight: var(--strong); }

    /* Per-finding copy button (hover/focus reveal) */
    .copy-btn { position: absolute; top: 8px; right: 8px; width: 26px; height: 26px; display: grid; place-items: center; border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--muted); opacity: 0; cursor: pointer; transition: opacity .12s ease, color .12s ease, background .12s ease, border-color .12s ease; }
    .copy-btn svg { width: 14px; height: 14px; display: block; }
    .doc li.finding:hover .copy-btn, .doc li.finding:focus-within .copy-btn, .copy-btn:focus-visible { opacity: 1; }
    .copy-btn:hover { color: var(--fg); background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent); border-color: var(--hairline); }
    .copy-btn:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
    .copy-btn.ok { opacity: 1; color: var(--ok); }
    .copy-btn.err { opacity: 1; color: var(--high-fg); }

    /* Clean state */
    .clean-hero { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-6) 0; }
    .clean-hero .ring { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; background: color-mix(in srgb, var(--ok) 16%, transparent); color: var(--ok); flex: 0 0 auto; box-shadow: 0 0 0 6px color-mix(in srgb, var(--ok) 8%, transparent); }
    .clean-hero .ring svg { width: 19px; height: 19px; }
    .clean-hero .ct { font-size: 14px; font-weight: 600; letter-spacing: -0.01em; }
    .clean-hero .cs { font-size: 12.5px; color: var(--muted); line-height: 1.5; margin-top: 2px; }

    @media (prefers-reduced-motion: reduce) {
      .doc li.finding, .spinner, .skel .card { transition: none; animation: none; }
      .doc li.finding:hover { transform: none; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header class="hd">
      <div class="mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 1.6l1.9 6 6 1.9-6 1.9-1.9 6-1.9-6-6-1.9 6-1.9zM19.5 2l.8 2.4L22.7 5l-2.4.8-.8 2.4-.8-2.4L16.3 5l2.4-.8zM5 15.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/></svg></div>
      <div class="titles">
        <div class="t">${title}</div>
        <div class="s">${subtitle}</div>
      </div>
      <div class="summary">
        <div class="acts" id="act">
          <button class="copy-all" id="copyAll" data-copy="all" hidden aria-label="Copy full review">
            <span class="ci"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></span>
            <span class="cl">Copy report</span>
          </button>
        </div>
        <div class="counts" id="sum"></div>
      </div>
    </header>
    <div id="out" class="doc"></div>
  </div>
  <div class="sr" id="sr" aria-live="polite"></div>
  <script nonce="${nonce}">
    (function () {
      var TICK = String.fromCharCode(96); // backtick (avoid a literal one here)
      var out = document.getElementById("out");
      var sum = document.getElementById("sum");
      var copyAll = document.getElementById("copyAll");
      var sr = document.getElementById("sr");
      var lastText = "";

      // Inline glyphs (single-quoted — never a literal backtick).
      var COPY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
      var CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
      var ALERT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>';

      function announce(m) { if (sr) { sr.textContent = ""; sr.textContent = m; } }
      function legacyCopy(str) {
        try {
          var ta = document.createElement("textarea");
          ta.value = str; ta.setAttribute("readonly", "");
          ta.style.position = "fixed"; ta.style.top = "0"; ta.style.left = "0"; ta.style.opacity = "0";
          document.body.appendChild(ta); ta.select();
          var ok = document.execCommand("copy"); document.body.removeChild(ta); return ok;
        } catch (_) { return false; }
      }
      function copyText(str) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          return navigator.clipboard.writeText(str).then(function () { return true; }, function () { return legacyCopy(str); });
        }
        return Promise.resolve(legacyCopy(str));
      }
      // Serialize a live finding card back to a clean PR-comment bullet.
      function walk(node) {
        var s = "";
        node.childNodes.forEach(function (n) {
          if (n.nodeType === 3) { s += n.nodeValue; return; }
          if (n.nodeType !== 1) return;
          if (n.classList && n.classList.contains("copy-btn")) return;
          if (n.classList && n.classList.contains("sev")) { s += "**" + n.textContent.trim() + ":** "; return; }
          var t = n.nodeName.toLowerCase();
          if (t === "code") { s += TICK + n.textContent + TICK; return; }
          if (t === "strong" || t === "b") { s += "**" + walk(n) + "**"; return; }
          if (t === "em" || t === "i") { s += "*" + walk(n) + "*"; return; }
          if (t === "del") { s += "~~" + walk(n) + "~~"; return; }
          if (t === "a") { s += "[" + walk(n) + "](" + (n.getAttribute("href") || "") + ")"; return; }
          if (t === "br") { s += " "; return; }
          s += walk(n);
        });
        return s;
      }
      function findingToMd(li) { if (!li) return ""; return ("- " + walk(li)).replace(/\s+/g, " ").trim(); }
      function flash(b, ok, kind) {
        clearTimeout(b._t); b.classList.remove("ok", "err"); b.classList.add(ok ? "ok" : "err");
        var icon = b.querySelector(".ci") || b; var label = b.querySelector(".cl");
        icon.innerHTML = ok ? CHECK_SVG : ALERT_SVG; if (label) label.textContent = ok ? "Copied" : "Failed";
        announce(ok ? (kind === "all" ? "Review copied" : "Finding copied") : "Copy failed");
        b._t = setTimeout(function () { b.classList.remove("ok", "err"); icon.innerHTML = COPY_SVG; if (label) label.textContent = "Copy report"; }, 1600);
      }
      // ONE delegated listener on the stable document — immune to re-render.
      document.addEventListener("click", function (e) {
        var b = e.target.closest ? e.target.closest("[data-copy]") : null; if (!b) return;
        var kind = b.getAttribute("data-copy");
        var text = kind === "all" ? lastText : findingToMd(b.closest("li.finding"));
        if (!text) { flash(b, false, kind); return; }
        copyText(text).then(function (ok) { flash(b, ok, kind); });
      });

      function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
      function safeUrl(u) { return /^(https?:|mailto:)/i.test(u) ? u : "#"; }

      function inline(s) {
        var codes = [];
        // protect inline code spans from other transforms
        s = s.replace(new RegExp(TICK + "([^" + TICK + "]+)" + TICK, "g"), function (m, c) { codes.push(c); return " " + (codes.length - 1) + " "; });
        s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
        s = s.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
        s = s.replace(/(^|[^*])\*([^*\n]+?)\*/g, "$1<em>$2</em>");
        s = s.replace(/(^|[^_])_([^_\n]+?)_/g, "$1<em>$2</em>");
        s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, t, u) { return '<a href="' + safeUrl(u) + '" target="_blank" rel="noopener noreferrer">' + t + "</a>"; });
        s = s.replace(/ (\d+) /g, function (m, i) {
          var c = codes[+i];
          var isPath = /[\\\/]/.test(c) || /\.[a-z0-9]+(:\d+)?$/i.test(c);
          return "<code" + (isPath ? ' class="path"' : "") + ">" + c + "</code>";
        });
        return s;
      }

      function renderMarkdown(src) {
        src = esc(src);
        var lines = src.split(/\r?\n/), html = "", i = 0, listType = null;
        function closeList() { if (listType) { html += "</" + listType + ">"; listType = null; } }
        var fenceRe = new RegExp("^\\s*" + TICK + TICK + TICK + "(\\w+)?\\s*$");
        var fenceEnd = new RegExp("^\\s*" + TICK + TICK + TICK + "\\s*$");
        while (i < lines.length) {
          var line = lines[i];
          var fence = line.match(fenceRe);
          if (fence) {
            closeList(); i++; var code = "";
            while (i < lines.length && !fenceEnd.test(lines[i])) { code += lines[i] + "\n"; i++; }
            i++;
            html += "<pre><code>" + code.replace(/\n$/, "") + "</code></pre>";
            continue;
          }
          var h = line.match(/^(#{1,6})\s+(.*)$/);
          if (h) { closeList(); var lv = h[1].length; html += "<h" + lv + ">" + inline(h[2]) + "</h" + lv + ">"; i++; continue; }
          if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { closeList(); html += "<hr>"; i++; continue; }
          if (/^\s*>\s?/.test(line)) {
            closeList(); var q = "";
            while (i < lines.length && /^\s*>\s?/.test(lines[i])) { q += lines[i].replace(/^\s*>\s?/, "") + "\n"; i++; }
            html += "<blockquote>" + renderMarkdown(q) + "</blockquote>"; continue;
          }
          var ul = line.match(/^\s*[-*+]\s+(.*)$/);
          var ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
          if (ul || ol) {
            var want = ul ? "ul" : "ol";
            if (listType && listType !== want) closeList();
            if (!listType) { listType = want; html += "<" + want + ">"; }
            html += "<li>" + inline(ul ? ul[1] : ol[1]) + "</li>"; i++; continue;
          }
          if (/^\s*$/.test(line)) { closeList(); i++; continue; }
          closeList(); var para = line; i++;
          while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^\s*(#{1,6}\s|>|[-*+]\s|\d+[.)]\s)/.test(lines[i]) && !fenceRe.test(lines[i])) { para += " " + lines[i]; i++; }
          html += "<p>" + inline(para) + "</p>";
        }
        closeList();
        return html;
      }

      var SEV = { high: "high", critical: "high", severe: "high", blocker: "high", medium: "med", moderate: "med", low: "low", minor: "low", nit: "nit", nitpick: "nit", info: "info", note: "info" };

      function enhance() {
        // Turn a leading **High/Medium/Low** into a colored badge + card the row.
        var strongs = out.querySelectorAll("li > strong:first-child, p > strong:first-child, strong");
        strongs.forEach(function (elx) {
          var raw = elx.textContent.trim();
          var w = raw.replace(/[:\-–—\s]+$/, "").toLowerCase();
          if (!SEV[w]) return;
          var badge = document.createElement("span");
          badge.className = "sev sev-" + SEV[w];
          badge.textContent = raw.replace(/[:\-–—\s]+$/, "");
          var li = elx.closest("li");
          var leads = li && li.querySelector("strong:first-child") === elx;
          elx.replaceWith(badge);
          if (leads) { li.classList.add("finding", SEV[w]); }
        });
        // Idempotently inject a copy button into each finding card (survives re-render).
        out.querySelectorAll("li.finding").forEach(function (li) {
          if (li.querySelector(":scope > .copy-btn")) return;
          var b = document.createElement("button");
          b.className = "copy-btn"; b.type = "button";
          b.setAttribute("data-copy", "finding"); b.setAttribute("aria-label", "Copy finding");
          b.innerHTML = COPY_SVG; li.appendChild(b);
        });
        renderSummary();
      }

      function renderSummary() {
        var c = { high: 0, med: 0, low: 0 };
        out.querySelectorAll(".sev").forEach(function (s) {
          var m = s.className.match(/sev-(high|med|low)/);
          if (m) c[m[1]]++;
        });
        var total = c.high + c.med + c.low;
        var txt = out.textContent || "";
        var clean = total === 0 && /no substantive issues|looks clean/i.test(txt);
        sum.innerHTML = "";
        function pill(cls, label) { var e = document.createElement("span"); e.className = "count " + cls; e.innerHTML = '<span class="dot"></span>' + label; sum.appendChild(e); }
        if (clean) { pill("clean", "No issues"); return; }
        if (total) pill("total", total + (total === 1 ? " finding" : " findings"));
        if (c.high) pill("high", c.high + " High");
        if (c.med) pill("med", c.med + " Medium");
        if (c.low) pill("low", c.low + " Low");
      }

      function showClean(text) {
        out.innerHTML = '<div class="clean-hero"><div class="ring"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg></div><div><div class="ct">No substantive issues found</div><div class="cs">' + esc(text.replace(/^✅\s*/, "").replace(/no substantive issues[^—-]*[—-]\s*/i, "")) + "</div></div></div>";
        if (copyAll) copyAll.hidden = true;
        renderSummary();
      }

      function update(text) {
        if (!text || !text.trim()) return;
        lastText = text;
        var t = text.trim();
        if (/^✅?\s*no substantive issues/i.test(t) && t.length < 120) { showClean(t); return; }
        out.className = "doc";
        out.innerHTML = renderMarkdown(text);
        enhance();
        if (copyAll) copyAll.hidden = false;
      }

      function status(text, kind) {
        sum.innerHTML = ""; if (copyAll) copyAll.hidden = true;
        if (kind === "error") {
          out.innerHTML = '<div class="status error"><span class="ico">' + ALERT_SVG + '</span><span>' + esc(text) + "</span></div>";
        } else {
          out.innerHTML = '<div class="status"><span class="spinner"></span><span>' + esc(text) + '</span></div><div class="skel"><div class="card"></div><div class="card"></div></div>';
        }
      }

      status("Waiting for GitBrain…", "loading");
      window.addEventListener("message", function (event) {
        var msg = event.data;
        if (!msg) return;
        if (msg.type === "content") update(msg.text);
        else if (msg.type === "status") status(msg.text, msg.kind);
      });
    })();
  </script>
</body>
</html>`;
}
