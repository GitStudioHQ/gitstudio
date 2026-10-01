/**
 * Host-side half of the GitStudio localization seam.
 *
 * VS Code gives an extension one localized bundle per display language, at
 * `vscode.l10n.uri` (declared by the `"l10n"` field in package.json). This
 * module turns that resource into the two things the extension needs:
 *
 *  1. a configured `@vscode/l10n` runtime, so the shared, host-agnostic
 *     packages (engine, git-service, ai, webview-ui, merge-vscode) can call
 *     `l10n.t(...)` from inside the extension host process, and
 *  2. an inline `<script>` snippet that ships the very same bundle into every
 *     webview page (the strict webview CSP forbids fetching it at runtime, so
 *     it has to travel inside the HTML).
 *
 * When VS Code runs in English — or in a language we have no bundle for —
 * `vscode.l10n.uri` is `undefined`, nothing is configured, and `l10n.t()`
 * falls back to the English source string. There is deliberately no other
 * switch: the display language VS Code is already running in is the language
 * GitStudio renders in.
 *
 * The webview half lives in `@gitstudio/l10n/webview`, which must stay free of
 * Node built-ins so it can be bundled for the browser.
 */
import { readFileSync } from "node:fs";

import { config } from "@vscode/l10n";
import type { l10nJsonFormat } from "@vscode/l10n";

/** Raw bundle text as read from disk, ready to be embedded in a page. */
let bundleText: string | undefined;

/** The language the bundle was written for, e.g. `zh-cn`. */
let locale: string | undefined;

/** Set once a webview page has been handed the bundle (avoids rebuilding it). */
let scriptCache: { nonce: string; html: string } | undefined;

/**
 * Load the localized bundle for the running VS Code display language.
 *
 * Safe to call with `undefined` (English / unknown locale): the runtime is then
 * simply left unconfigured and every `l10n.t()` returns its English source.
 *
 * @param uri - `vscode.l10n.uri`, or anything with a filesystem path.
 */
export function configureL10n(uri: { fsPath: string } | undefined): void {
  bundleText = undefined;
  locale = undefined;
  scriptCache = undefined;
  reverse = undefined;
  if (!uri) {
    return;
  }
  try {
    const text = readFileSync(uri.fsPath, "utf8");
    config({ contents: text });
    bundleText = text.trim();
    // `…/bundle.l10n.zh-cn.json` — the same name VS Code builds from its
    // display language.
    locale = /bundle\.l10n\.([^.]+)\.json$/.exec(uri.fsPath)?.[1];
  } catch {
    // A malformed or unreadable bundle must never break activation.
    bundleText = undefined;
  }
}

/**
 * The placeholder syntax `@vscode/l10n` replaces: `{0}`, `{1}`, `{name}`.
 *
 * `String.raw` because the escaped braces must reach the page as written — a
 * plain template literal would eat the backslashes.
 */
const PLACEHOLDER = String.raw`/\{([^}]+)\}/g`;

/** `\u003c`, the JSON escape for `<`, spelled so a template literal cannot cook it. */
const LESS_THAN = String.raw`\u003c`;

/**
 * The page global that translates one message with `{0}`-style placeholders.
 *
 * It is what the extension's own inline programs call: the pages that carry a
 * whole webview program inside a `String.raw` template literal (Changes, the
 * rebase workbench, Compare, the AI report) are authored in this repo's source,
 * but they *run* in the page — so they cannot import `@vscode/l10n` and cannot
 * be translated when the host builds the HTML. They call `l10nT("…", arg)`
 * instead, and this helper resolves it against the bundle that travels with the
 * page. In English the bundle is empty and the message is handed straight back.
 *
 * Substitution runs in ONE pass, exactly as `@vscode/l10n`'s own `format` does:
 * `{0}` is looked up in the arguments and the result is never scanned again, so
 * a value that itself reads `{1}` stays a literal. A placeholder with no
 * argument keeps its braces, and no argument at all hands the message back.
 *
 * Written in ES5 on purpose: it is inlined into `<script>` in a page whose CSP
 * allows no build step of its own, and it must survive whatever the page's own
 * inline program does with `var` and function scope.
 */
function webviewHelper(bundle: string, language: string | undefined): string {
  const lang = language
    ? `globalThis.__gitstudioLocale="${language}";
try{if(document&&document.documentElement){document.documentElement.setAttribute("lang",globalThis.__gitstudioLocale);}}catch(e){}
`
    : "";
  return `${lang}globalThis.__gitstudioL10n=${bundle};
globalThis.l10nT=function(message){
var args=Array.prototype.slice.call(arguments,1);
var hit=(globalThis.__gitstudioL10n||{})[message];
var text=typeof hit==="string"?hit:(hit&&hit.message)||message;
var values=args.length===1&&args[0]!==null&&typeof args[0]==="object"?args[0]:args;
if(Object.keys(values).length===0){return text;}
return text.replace(${PLACEHOLDER},function(match,key){
var one=values[key];
return one===undefined||one===null?match:String(one);
});
};`;
}

/**
 * The inline script that hands the localized bundle to a webview page.
 *
 * Inject the result BEFORE the first `<script src="...">` of the page; the
 * webview half (`@gitstudio/l10n/webview`) picks the global up while it is
 * being imported, so no entry point needs to wire anything by hand.
 *
 * Always emitted, English included: the page's inline program calls `l10nT` for
 * every user-facing word whether or not a translation exists, so the helper has
 * to be there to hand the message back.
 *
 * @param nonce - The page's CSP nonce (`getNonce()`).
 */
export function l10nWebviewScript(nonce: string): string {
  if (scriptCache?.nonce !== nonce) {
    scriptCache = {
      nonce,
      html: `<script nonce="${nonce}">${webviewHelper(inlineBundle(bundleText ?? "{}"), locale)}</script>`,
    };
  }
  return scriptCache.html;
}

/**
 * The bundle text as it may sit inside a `<script>` element: every `<` becomes
 * `\u003c`, so a message holding `</script>` cannot end the element early. JSON
 * reads `\u003c` back as `<`, so the page sees the bundle we wrote — and `\u003c`
 * cannot appear in the bundle any other way, whichever language it holds.
 */
function inlineBundle(json: string): string {
  return json.replace(/</g, LESS_THAN);
}

/** The parsed bundle, for tests and diagnostics. `undefined` in English. */
export function currentBundle(): l10nJsonFormat | undefined {
  if (!bundleText) {
    return undefined;
  }
  try {
    return JSON.parse(bundleText) as l10nJsonFormat;
  } catch {
    return undefined;
  }
}

/** Each translation as a pattern that gives its English message back. */
type Reverse = { exact: Map<string, string>; patterns: { re: RegExp; names: string[]; message: string }[] };
let reverse: Reverse | undefined;

/**
 * The English a translated message was made from: "合并 feat" → "Merge feat".
 *
 * For what git stores in the repository — a reflog entry, a stash's message, a
 * commit message — which everyone who reads the history sees, whatever
 * language GitStudio was showing the person who ran the operation. The label
 * those are built from is the one the UI showed, so it is turned back here
 * rather than threading a second, English label through every caller.
 *
 * Arguments are matched as wildcards and turned back on their own when they are
 * whole messages ("提交" → "commit"); a branch name stays as written. Text no
 * translation produces (English, or no bundle at all) is handed back unchanged.
 */
export function englishOf(text: string): string {
  if (!reverse) {
    const bundle = currentBundle();
    if (!bundle) return text;
    reverse = buildReverse(bundle);
  }
  const exact = reverse.exact.get(text);
  if (exact !== undefined) return exact;
  for (const { re, names, message } of reverse.patterns) {
    const m = re.exec(text);
    if (!m) continue;
    return message.replace(/\{([^}]+)\}/g, (whole, key: string) => {
      const at = names.indexOf(key);
      if (at < 0) return whole;
      const value = m[at + 1] ?? "";
      return reverse?.exact.get(value) ?? value;
    });
  }
  return text;
}

function buildReverse(bundle: l10nJsonFormat): Reverse {
  const exact = new Map<string, string>();
  const patterns: Reverse["patterns"] = [];
  for (const [message, entry] of Object.entries(bundle)) {
    const translated = typeof entry === "string" ? entry : entry.message;
    if (!translated || translated === message) continue;
    const parts = translated.split(/\{([^}]+)\}/);
    if (parts.length === 1) {
      if (!exact.has(translated)) exact.set(translated, message);
      continue;
    }
    const names: string[] = [];
    let source = "^";
    parts.forEach((part, i) => {
      if (i % 2) {
        names.push(part);
        source += "([\\s\\S]+?)";
      } else {
        source += part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }
    });
    patterns.push({ re: new RegExp(`${source}$`), names, message });
  }
  // The longest literal text first: "{0} 已推送" must not win over "{0} 已推送到 {1}".
  patterns.sort((a, b) => b.re.source.length - a.re.source.length);
  return { exact, patterns };
}
