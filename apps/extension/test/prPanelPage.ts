// The PR description page, rendered for real: the html prDescriptionPanel.ts
// writes to its webview — WITH its own Content-Security-Policy — produced by
// the real panel code (through prVscodeStub.cjs and a fake api.github.com),
// and made loadable in a windowless Chrome. Not a test itself: the panel's
// render test (prPanelRender.test.ts) and its screenshot harness
// (harness/pr/shots.ts) both mount it.
//
// Only what a webview supplies is swapped in: the CSP's `webview.cspSource`
// becomes file:, the codicon stylesheet is the real one, VS Code's theme
// arrives as --vscode-* variables on <html> and a theme class on <body>, and
// acquireVsCodeApi is a stub — in a <script> carrying the page's own nonce, so
// the policy the page ships is the policy it is tested under.

import Module from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installFakeGitHub, rawPull } from "./fakeGitHub";
import { BODY_CLASS, VSCODE_THEMES, type VsCodeTheme } from "../../../scripts/merge-e2e/themes";

type Resolver = { _resolveFilename: (request: unknown, ...rest: unknown[]) => string; __prStub?: true };
const resolver = Module as unknown as Resolver;
if (!resolver.__prStub) {
  const resolve = resolver._resolveFilename;
  const STUB = fileURLToPath(new URL("./prVscodeStub.cjs", import.meta.url));
  resolver._resolveFilename = function (request: unknown, ...rest: unknown[]) {
    return request === "vscode" ? STUB : resolve.call(this, request, ...rest);
  };
  (Module as unknown as { _extensions: Record<string, (m: { exports: unknown }, f: string) => void> })._extensions[".css"] = (
    m,
    f,
  ) => {
    m.exports = readFileSync(f, "utf8");
  };
  resolver.__prStub = true;
}

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any -- loaded after the stand-in */
const vscode = require("vscode") as any;
const { PrDescriptionPanel } = require("../src/pr/prDescriptionPanel") as typeof import("../src/pr/prDescriptionPanel");
const { GitHubApi } = require("../src/pr/githubApi") as typeof import("../src/pr/githubApi");
/* eslint-enable @typescript-eslint/no-require-imports */

const CODICONS = fileURLToPath(new URL("../../../node_modules/@vscode/codicons/dist/codicon.css", import.meta.url));

export type { VsCodeTheme };

export interface PanelScene {
  name: string;
  /** GitHub's raw pull (snake_case), as GET /pulls/{n} answers. */
  pull: Record<string, unknown>;
  files: Record<string, unknown>[];
  checkRuns: { status: string; conclusion: string | null }[];
  statuses: { state: string }[];
}

const BODY = "## Summary\n\nAdds **Drop Commit** and *Reset to upstream* to the branch menu.\n\n- extension\n- desktop";

/** The four states a PR can be in, as the audit rendered them. */
export function scenes(): PanelScene[] {
  const labels = [
    { name: "enhancement", color: "a2eeef" },
    { name: "extension", color: "5319e7" },
    { name: "bug", color: "d73a4a" },
  ];
  const files = [
    { filename: "apps/extension/src/views/branchActions.ts", status: "modified", additions: 120, deletions: 14, changes: 134, patch: "@@ -1 +1 @@\n-a\n+b" },
    { filename: "packages/git-service/src/dropCommit.ts", status: "added", additions: 310, deletions: 0, changes: 310, patch: "@@ -0,0 +1 @@\n+a" },
    { filename: "apps/extension/src/git/resetToUpstream.ts", previous_filename: "apps/extension/src/git/reset.ts", status: "renamed", additions: 4, deletions: 2, changes: 6, patch: "@@ -1 +1 @@\n-a\n+b" },
    { filename: "docs/old-notes.md", status: "removed", additions: 0, deletions: 40, changes: 40, patch: "@@ -1 +0,0 @@\n-a" },
  ];
  const base = (n: number, over: Record<string, unknown>) =>
    rawPull(n, {
      title: "feat: Drop Commit, Reset to upstream, the branch menu from the keyboard",
      body: BODY,
      user: { login: "antonarnaudov", avatar_url: null, html_url: null },
      created_at: new Date(Date.now() - 5 * 3600e3).toISOString(),
      head: { ref: "feat/issue-32-batch", sha: "ef200d7", label: "acme:feat/issue-32-batch", repo: { full_name: "acme/app" } },
      base: { ref: "main", sha: "0d160a8", label: "acme:main", repo: { full_name: "acme/app" } },
      labels,
      requested_reviewers: [{ login: "octocat" }],
      additions: 1840,
      deletions: 212,
      changed_files: 61,
      ...over,
    });
  const failedRun = [
    { status: "completed", conclusion: "success" },
    { status: "completed", conclusion: "failure" },
  ];
  const passed = [
    { status: "completed", conclusion: "success" },
    { status: "completed", conclusion: "success" },
    { status: "completed", conclusion: "skipped" },
  ];
  return [
    { name: "open", pull: base(37, {}), files, checkRuns: failedRun, statuses: [] },
    { name: "closed-unmerged", pull: base(38, { state: "closed" }), files, checkRuns: failedRun, statuses: [] },
    { name: "merged", pull: base(39, { state: "closed", merged_at: new Date().toISOString() }), files, checkRuns: passed, statuses: [] },
    { name: "draft", pull: base(40, { draft: true }), files, checkRuns: [{ status: "in_progress", conclusion: null }], statuses: [] },
  ];
}

/** The html the real panel writes for `scene`, as its webview receives it. */
export async function panelHtml(scene: PanelScene): Promise<string> {
  const n = Number(scene.pull.number);
  const gh = installFakeGitHub([
    ["GET", new RegExp(`^/repos/acme/app/pulls/${n}$`), () => ({ body: scene.pull })],
    ["GET", new RegExp(`^/repos/acme/app/pulls/${n}/files`), () => ({ body: scene.files })],
    ["GET", /\/check-runs/, () => ({ body: { total_count: scene.checkRuns.length, check_runs: scene.checkRuns } })],
    ["GET", /\/status/, () => ({ body: { state: "pending", total_count: scene.statuses.length, statuses: scene.statuses } })],
  ]);
  try {
    const api = new GitHubApi({ getToken: async () => "tok" });
    const pr = await api.getPull("acme", "app", n);
    const panel = await PrDescriptionPanel.show(
      { api, ctx: { owner: "acme", repo: "app", remoteName: "origin", entry: {} as never }, extensionUri: vscode.Uri.file("/ext") },
      pr,
    );
    void panel;
    const written = vscode.__pr.panels.filter((p: any) => p.title === `PR #${n}`).at(-1);
    return written.webview.html as string;
  } finally {
    gh.restore();
  }
}

/** Records what the page posts; `__send` delivers a host message. Nonce'd to pass the page's CSP. */
const HOST_STUB = `
window.__posted = [];
window.acquireVsCodeApi = function () {
  return { postMessage: function (m) { window.__posted.push(m); }, getState: function () {}, setState: function () {} };
};
window.__send = function (msg) { window.dispatchEvent(new MessageEvent("message", { data: msg })); };
`;

/** `html` made loadable from file://, themed, under its OWN CSP. */
export function themedPage(html: string, theme: VsCodeTheme): string {
  const nonce = /<script nonce="([^"]+)"/.exec(html)?.[1];
  if (!nonce) throw new Error("the panel's script carries no nonce");
  const bg = theme === "dark" || theme === "hc-dark" ? "#1e1e1e" : "#ffffff";
  const vars: Record<string, string> = {
    ...(VSCODE_THEMES[theme] as Record<string, string>),
    "--vscode-editor-background": bg,
    "--vscode-textCodeBlock-background": theme === "dark" || theme === "hc-dark" ? "#0a0a0a66" : "#dcdcdc66",
  };
  const style = Object.entries(vars)
    .map(([k, v]) => `${k}:${v.replace(/"/g, "&quot;")}`)
    .join(";");
  let out = html
    .replace(/vscode-webview:/g, "file:")
    .replace(/<link href="[^"]*" rel="stylesheet" \/>/, `<link href="${pathToFileURL(CODICONS).href}" rel="stylesheet" />`)
    .replace('<html lang="en">', `<html lang="en" style="${style};background:${bg}">`)
    .replace("<head>", `<head><script nonce="${nonce}">${HOST_STUB}</script>`)
    .replace("<body>", `<body class="${BODY_CLASS[theme]}">`);
  if (!out.includes(`<script nonce="${nonce}">${HOST_STUB}`)) throw new Error("could not install the host stub");
  // The body gets its background from the theme, as a webview's does.
  out = out.replace("</head>", `<style nonce="${nonce}">html, body { background: ${bg}; }</style></head>`);
  return out;
}

export const OUT_DIR = join(fileURLToPath(new URL("../../../", import.meta.url)), "out", "pr-panel");
