// The bundle script every page is handed (packages/l10n, `l10nWebviewScript`).
//
// A webview page cannot fetch the bundle — the CSP forbids it — so the host
// builds the HTML with the bundle inlined as JSON and a small ES5 helper on
// `globalThis.l10nT`. Two things about that script are easy to get wrong and
// impossible to see in English:
//
//  - Substitution must be ONE pass, as `@vscode/l10n`'s own `format` is: a
//    value that reads `{1}` is a value, not a placeholder to look up again.
//  - `<` may not reach the element literally, or a message holding `</script>`
//    — a code sample, a diff snippet — ends the script early and the page
//    loses every string in it.
//
// The script is run here the way a page runs it (an empty context: it needs no
// DOM unless a language tag is emitted), against a real bundle file read
// through `configureL10n`, and its substitutions are checked against
// `@vscode/l10n.t` on the same inputs — the two halves of the seam must agree.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { config, t } from "@vscode/l10n";

import { configureL10n, l10nWebviewScript } from "@gitstudio/l10n/index";

const BUNDLE: Record<string, string> = {
  "A < B": "甲 < 乙",
  "Closed </script> early": "提前关闭了 </script>",
  "Hello {0}": "你好 {0}",
  "One {0} two {1}": "一 {0} 二 {1}",
};

const dir = mkdtempSync(join(tmpdir(), "gitstudio-l10n-"));
writeFileSync(join(dir, "bundle.l10n.zh-cn.json"), `${JSON.stringify(BUNDLE, null, 1)}\n`);
configureL10n({ fsPath: join(dir, "bundle.l10n.zh-cn.json") });

after(() => {
  // The runtime is global to the process: leave it as unconfigured as it was.
  config({ contents: "{}" });
  configureL10n(undefined);
  rmSync(dir, { recursive: true, force: true });
});

/** The script element for nonce `n`, split into its attributes and its body. */
function script(nonce = "n"): { html: string; js: string } {
  const html = l10nWebviewScript(nonce);
  const match = /^<script nonce="([^"]*)">([\s\S]*)<\/script>$/.exec(html);
  assert.ok(match, `one script element, opened and closed once: ${html.slice(0, 80)}`);
  assert.equal(match[1], nonce, "the page's nonce stays on the tag");
  return { html, js: match[2] };
}

/** The page global the script installs, run in an empty context as a page would. */
function page(): { l10nT: (message: string, ...args: unknown[]) => string; bundle: unknown } {
  const context = vm.createContext({});
  vm.runInContext(script().js, context);
  const globals = context as unknown as {
    l10nT: (message: string, ...args: unknown[]) => string;
    __gitstudioL10n: unknown;
  };
  assert.equal(typeof globals.l10nT, "function", "the page is given l10nT");
  return { l10nT: globals.l10nT, bundle: globals.__gitstudioL10n };
}

/** A cross-realm object (the script ran in its own context) as this realm's. */
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

test("the page gets the bundle, and every message behind it", () => {
  const { l10nT, bundle } = page();
  assert.deepEqual(plain(bundle), BUNDLE, "the whole bundle travels with the page");
  assert.equal(l10nT("Hello {0}", "world"), "你好 world");
  assert.equal(l10nT("Untranslated {0}", "x"), "Untranslated x", "a message with no translation is handed back");
});

test("substitution is one pass, so a value that looks like a placeholder stays a value", () => {
  const { l10nT } = page();
  assert.equal(l10nT("One {0} two {1}", "{1}", "x"), "一 {1} 二 x");
  assert.equal(l10nT("One {0} two {1}", "a", "b"), "一 a 二 b");
});

test("an argument that is missing leaves its placeholder, as @vscode/l10n does", () => {
  const { l10nT } = page();
  assert.equal(l10nT("One {0} two {1}", "a"), "一 a 二 {1}");
  assert.equal(l10nT("One {0} two {1}"), "一 {0} 二 {1}", "no argument at all");
  assert.equal(l10nT("One {0} two {1}", "a"), t("One {0} two {1}", "a"), "the runtime agrees");
  assert.equal(l10nT("Hello {0}", 0), "你好 0", "0 is a value, not a missing argument");
  assert.equal(l10nT("Hello {0}", null), "你好 {0}", "null is not `0` — the placeholder stays");
});

test("a message holding </script> cannot end the script element", () => {
  const { html, js } = script();
  assert.ok(html.includes("\\u003c"), "every < travels as its JSON escape");
  assert.equal(js.includes("</script>"), false, "nothing inside the element spells a closing tag");
  assert.equal(html.split("</script>").length, 2, "the element is closed exactly once");
  const json = /globalThis\.__gitstudioL10n=([\s\S]*?);\nglobalThis\.l10nT=/.exec(js);
  assert.ok(json, "the bundle is inlined as one JSON value");
  assert.deepEqual(JSON.parse(json[1]), BUNDLE, "and reads back as the bundle we wrote");
});

test("the bundle file's own bytes are the bytes the page gets", () => {
  const onDisk = JSON.parse(readFileSync(join(dir, "bundle.l10n.zh-cn.json"), "utf8")) as unknown;
  assert.deepEqual(plain(page().bundle), onDisk);
});
