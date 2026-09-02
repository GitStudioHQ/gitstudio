// Syntax highlighting for prose code fences and the remote file quick-look.
//
// github.com highlights every fenced block in every README, PR body, and
// release note; we rendered them all monochrome — a constant, glaring
// readability gap. Monaco is already in this bundle for the diff views, and
// `monaco.editor.colorize` reuses its tokenizers + the app-native theme, so
// highlighting costs nothing new. Output is Monaco-generated token spans over
// escaped text — safe to inject.

import * as monaco from "monaco-editor";
import { languageForFile } from "@gitstudio/webview-ui/language";
import { ensureNativeTheme } from "@gitstudio/webview-ui/theme";
import { bootMonaco } from "./monacoBoot";

/** Fence-info → Monaco language id, for the aliases people actually type. */
const FENCE_LANG: Record<string, string> = {
  js: "javascript", jsx: "javascript", javascript: "javascript", node: "javascript",
  ts: "typescript", tsx: "typescript", typescript: "typescript",
  py: "python", python: "python",
  rb: "ruby", ruby: "ruby",
  sh: "shell", bash: "shell", zsh: "shell", shell: "shell", console: "shell",
  json: "json", jsonc: "json", json5: "json",
  yaml: "yaml", yml: "yaml",
  toml: "ini", ini: "ini",
  css: "css", scss: "scss", less: "less",
  html: "html", xml: "xml", svg: "xml", vue: "html",
  md: "markdown", markdown: "markdown",
  sql: "sql",
  go: "go", golang: "go",
  rust: "rust", rs: "rust",
  java: "java",
  kotlin: "kotlin", kt: "kotlin",
  swift: "swift",
  c: "c", h: "c",
  cpp: "cpp", "c++": "cpp", cc: "cpp", hpp: "cpp",
  cs: "csharp", csharp: "csharp",
  php: "php",
  diff: "diff", patch: "diff",
  dockerfile: "dockerfile", docker: "dockerfile",
  graphql: "graphql", gql: "graphql",
  lua: "lua", perl: "perl", r: "r", scala: "scala", dart: "dart",
  powershell: "powershell", ps1: "powershell",
  txt: "", text: "", plain: "", plaintext: "",
};

function monacoLangFor(hint: string): string | undefined {
  const h = hint.toLowerCase();
  const mapped = FENCE_LANG[h];
  if (mapped !== undefined) return mapped || undefined;
  // Try the alias as a file extension via the shared mapping.
  const viaExt = languageForFile(`x.${h}`);
  if (viaExt && viaExt !== "plaintext") return viaExt;
  // Monaco may know the id directly (e.g. "objective-c").
  return monaco.languages.getLanguages().some((l) => l.id === h) ? h : undefined;
}

let themed = false;
/** Re-derive the Monaco token theme from the live CSS variables — call after a
 *  theme switch so already-highlighted blocks re-color (the token classes are
 *  global; redefining the theme restyles every existing span in place). */
export function refreshHighlightTheme(): void {
  try {
    monaco.editor.setTheme(ensureNativeTheme());
    themed = true;
  } catch {
    /* highlighting is decoration — never let it throw into a render */
  }
}

async function colorize(text: string, lang: string): Promise<string | undefined> {
  bootMonaco();
  if (!themed) refreshHighlightTheme();
  try {
    const html = await monaco.editor.colorize(text, lang, { tabSize: 2 });
    // REAL SPACES. `colorize` emits `&nbsp;` for indentation, which renders
    // identically inside a `<pre>` (both containers that use this are
    // whitespace-preserving) but copies as U+00A0 — so a snippet pasted out of
    // this app into a terminal, a file or a chat carried non-breaking spaces
    // where its indentation used to be. Python and YAML break outright; a diff
    // of the pasted text is unreadable.
    return html?.replace(/&nbsp;/g, " ");
  } catch {
    return undefined;
  }
}

/** Don't tokenize monsters; a fence this big is a data dump, not prose. */
const MAX_HIGHLIGHT_CHARS = 100_000;

/** Highlight every ```lang fence inside a rendered-markdown container.
 *  Fire-and-forget per block; monochrome is the graceful fallback. */
export function highlightProse(container: HTMLElement): void {
  const blocks = container.querySelectorAll<HTMLElement>('pre > code[class*="language-"]');
  for (const code of blocks) {
    if (code.dataset.hl) continue; // already done (observer re-entry)
    const m = /language-([\w+.-]+)/.exec(code.className);
    if (!m) continue;
    const lang = monacoLangFor(m[1]);
    if (!lang) continue;
    const text = code.textContent ?? "";
    if (!text.trim() || text.length > MAX_HIGHLIGHT_CHARS) continue;
    code.dataset.hl = "1";
    void colorize(text, lang).then((html) => {
      if (html && code.isConnected) code.innerHTML = html;
    });
  }
}

/** Highlight one code element in place from its file name (remote file view). */
export async function highlightCode(
  codeEl: HTMLElement,
  text: string,
  fileName: string,
): Promise<void> {
  const lang = languageForFile(fileName);
  if (!lang || lang === "plaintext" || text.length > MAX_HIGHLIGHT_CHARS) return;
  const html = await colorize(text, lang);
  if (html && codeEl.isConnected) codeEl.innerHTML = html;
}