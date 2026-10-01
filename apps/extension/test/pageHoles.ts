/**
 * The two holes every webview page carries now that GitStudio is localized.
 *
 * A page-builder test lifts a host file's template literal and fills its holes
 * by name (changesPage.ts, rebasePanelPage.ts). An unknown name throws, so the
 * l10n work turned up twice per page: the words themselves arrived as
 * `${l10n.t("…")}` holes, and the bundle script arrived as a
 * `${l10nWebviewScript(nonce)}` one.
 *
 * Both are filled here, and the page the tests render is the English page —
 * which is what a browser test asserts on. A test that wants the Chinese page
 * passes `messages` (the zh-cn bundle) and configures `@gitstudio/l10n` with
 * it, so the words and the bundle agree:
 *
 *  - `l10n.t("…")` is the host's own call, so its value is the English source
 *    text (in VS Code under a Chinese display language it would be the
 *    translation, and the test pages would read Chinese).
 *  - `l10nWebviewScript(nonce)` is the real inline script, so the page's own
 *    program can call `l10nT(…)` exactly as it does in VS Code.
 *
 * Only `l10n.t("literal")` with one string argument is resolved: a call with
 * placeholders or several arguments needs a value only the live page has, and
 * silently guessing one would hide a page that cannot be built.
 */
import { readFileSync } from "node:fs";

import ts from "typescript";

import { l10nWebviewScript } from "@gitstudio/l10n/index";

/** The hole's name in a template literal: its expression, as written. */
export const L10N_WEBVIEW_SCRIPT = "l10nWebviewScript(nonce)";

/** The hole that injects the bundle into a page built with nonce `nonce`. */
export function l10nHoles(nonce: string): Record<string, string> {
  return { [L10N_WEBVIEW_SCRIPT]: l10nWebviewScript(nonce) };
}

/**
 * The value of one hole of a page template.
 *
 * @param where - Where the template came from, for the error a test would see.
 * @param messages - The bundle to read the `l10n.t("…")` holes from. Missing
 *   means the English source text; a bundle without the message means the same,
 *   which is what VS Code does for a string a translation has not reached yet.
 */
export function fillHole(
  where: string,
  span: ts.TemplateSpan,
  sf: ts.SourceFile,
  holes: Record<string, string>,
  messages?: Record<string, string>,
): string {
  const name = span.expression.getText(sf);
  if (name in holes) {
    return holes[name];
  }
  const english = englishMessage(span.expression);
  if (english !== undefined) {
    return messages?.[english] ?? english;
  }
  throw new Error(`${where}: a hole this page cannot fill: \${${name}}`);
}

/** `l10n.t("…")` as the English text it returns, or undefined for anything else. */
function englishMessage(expression: ts.Expression): string | undefined {
  if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) {
    return undefined;
  }
  const called = expression.expression;
  if (called.expression.getText() !== "l10n" || called.name.text !== "t") {
    return undefined;
  }
  const [first, ...rest] = expression.arguments;
  if (rest.length > 0 || first === undefined || !ts.isStringLiteralLike(first)) {
    return undefined;
  }
  return first.text;
}

/**
 * A host file's `String.raw` page template, with `holes` filled — the first
 * tag whose head holds `marker` (`<!DOCTYPE html>`, say).
 *
 * The template is lifted with the TypeScript parser, never re-typed, so the
 * text is exactly what the webview gets: `String.raw` hands the literal's body
 * over as written, and each span is one hole between two such bodies.
 *
 * @param where - Where the template came from (`"commitView.ts html()"`), for
 * the error a page that cannot be built would raise.
 * @param messages - The bundle the `l10n.t("…")` holes are read from; English
 * source text when it is left out.
 */
export function filledTemplate(
  where: string,
  file: string,
  marker: string,
  holes: Record<string, string>,
  messages?: Record<string, string>,
): string {
  const source = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  let tpl: ts.TemplateExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      !tpl &&
      ts.isTaggedTemplateExpression(node) &&
      node.tag.getText(sf) === "String.raw" &&
      ts.isTemplateExpression(node.template) &&
      node.template.head.getText(sf).includes(marker)
    ) {
      tpl = node.template;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!tpl) throw new Error(`${where}: the String.raw template was not found`);

  // head "`…${", middle "}…${", tail "}…`" — the delimiters come off.
  let html = tpl.head.getText(sf).slice(1, -2);
  for (const span of tpl.templateSpans) {
    html += fillHole(where, span, sf, holes, messages);
    const lit = span.literal.getText(sf);
    html += ts.isTemplateTail(span.literal) ? lit.slice(1, -1) : lit.slice(1, -2);
  }
  return html;
}
