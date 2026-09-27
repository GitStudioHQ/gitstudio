// The sanitising Markdown renderer now lives in @gitstudio/webview-ui/markdown,
// shared with the VS Code extension's pull request surfaces — one renderer,
// one security boundary (sanitizeHtml), one set of tests
// (packages/webview-ui/test/markdown.test.ts, sanitizerFailsClosed.test.ts).
// This module keeps the desktop's import path.
export { renderMarkdown, sanitizeHtml, type MarkdownOpts } from "@gitstudio/webview-ui/markdown";
