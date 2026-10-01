#!/usr/bin/env node
/**
 * Every message the embedded webview programs ask the `l10nT()` global for.
 *
 * Those programs are TypeScript `String.raw` template literals in the extension
 * host: the calls inside them are text as far as any AST walker is concerned,
 * so the official extractor cannot see them. This script parses each raw body
 * (and, for the pages that are full HTML, the body of every inline
 * `<script>`), then reads the literal first argument of each `l10nT()` call.
 *
 *   node scripts/i18n/embedded-keys.mjs <files…>   # a JSON array on stdout
 */
import ts from "typescript";
import { readFileSync } from "node:fs";

const PH = "\u0001";
const keys = new Set();

for (const file of process.argv.slice(2)) {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);

  /** The JavaScript programs inside one raw template: the whole body, or each inline script. */
  const programs = (lit) => {
    let logical;
    if (ts.isNoSubstitutionTemplateLiteral(lit)) {
      logical = text.slice(lit.getStart(sf) + 1, lit.getEnd() - 1);
    } else {
      logical = text.slice(lit.getStart(sf) + 1, lit.head.getEnd() - 2);
      const spans = lit.templateSpans;
      spans.forEach((span, index) => {
        logical += PH;
        const chunk = span.literal;
        logical += text.slice(chunk.getStart(sf) + 1, chunk.getEnd() - (index === spans.length - 1 ? 1 : 2));
      });
    }
    if (!/^\s*</.test(logical)) return [logical];
    const bodies = [];
    const open = /<script([^>]*)>/gi;
    for (let match = open.exec(logical); match; match = open.exec(logical)) {
      const start = match.index + match[0].length;
      const end = logical.toLowerCase().indexOf("</script>", start);
      if (end === -1) break;
      open.lastIndex = end + 9;
      if (/\bsrc\s*=/.test(match[1])) continue; // external bundle: its own file is a source file
      bodies.push(logical.slice(start, end));
    }
    return bodies;
  };

  (function walk(node) {
    if (ts.isTaggedTemplateExpression(node) && node.tag.getText(sf) === "String.raw") {
      for (const body of programs(node.template)) {
        if (body.includes(PH)) continue; // interpolated: the extractor reads the file it came from
        const jsf = ts.createSourceFile("inline.js", body, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
        (function visit(node) {
          if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "l10nT") {
            const first = node.arguments[0];
            if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) keys.add(first.text);
            else console.error(`embedded-keys: not a literal in ${file}: ${first?.getText(jsf).slice(0, 60)}`);
          }
          ts.forEachChild(node, visit);
        })(jsf);
      }
    }
    ts.forEachChild(node, walk);
  })(sf);
}

console.log(JSON.stringify([...keys].sort()));
