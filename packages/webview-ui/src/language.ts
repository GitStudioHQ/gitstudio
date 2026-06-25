// Maps a file name to a Monaco language id for syntax highlighting.

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  json: "json",
  jsonc: "json",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  rb: "ruby",
  php: "php",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  go: "go",
  rs: "rust",
  swift: "swift",
  m: "objective-c",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  yml: "yaml",
  yaml: "yaml",
  xml: "xml",
  sql: "sql",
  dockerfile: "dockerfile",
  toml: "ini",
  ini: "ini",
  vue: "html",
  svelte: "html",
  dart: "dart",
  lua: "lua",
  r: "r",
  scala: "scala",
  pl: "perl",
};

export function languageForFile(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  if (base.toLowerCase() === "dockerfile") {
    return "dockerfile";
  }
  const ext = base.includes(".")
    ? base.slice(base.lastIndexOf(".") + 1).toLowerCase()
    : "";
  return EXTENSION_TO_LANGUAGE[ext] ?? "plaintext";
}
