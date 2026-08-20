import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Our webviews' JavaScript lives inside a template literal of HTML, so it is a
// STRING as far as the compiler is concerned. tsc, eslint and esbuild all check
// the literal is a valid string and stop there — none of them ever parse the
// JavaScript inside it. A syntax error there ships, and the surface comes up
// blank at runtime with the error only in the webview devtools console.
//
// This has bitten repeatedly: a stray backtick in a COMMENT silently ends the
// literal (the rest of the "HTML" becomes code, and it still compiles), and an
// unbalanced brace in a handler kills the whole script.
//
// So: find every inline <script> in every template literal under src/ and
// actually parse it.

const SRC = join(fileURLToPath(new URL("../src", import.meta.url)));

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await tsFiles(p)));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** The JS of every inline <script> in this file's template literals. */
function scriptsIn(file: string, text: string): { js: string; at: number }[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: { js: string; at: number }[] = [];
  const visit = (node: ts.Node): void => {
    const isTemplate =
      ts.isTaggedTemplateExpression(node) ||
      ts.isTemplateExpression(node) ||
      ts.isNoSubstitutionTemplateLiteral(node);
    if (isTemplate) {
      const raw = node.getText(sf);
      if (raw.includes("<script") && raw.includes("</script>")) {
        // ${...} holes become a harmless literal so the surrounding JS parses.
        // Nested braces inside a hole are why this counts depth by hand.
        const flat = flattenHoles(raw);
        for (const m of flat.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
          const js = m[1];
          if (js.trim().length > 200) {
            found.push({
              js,
              at: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Replace every ${...} with a string literal, honouring nested braces. */
function flattenHoles(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "$" && text[i + 1] === "{") {
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}") depth--;
        i++;
      }
      i--;
      out += '"__HOLE__"';
      continue;
    }
    out += text[i];
  }
  return out;
}

test("every webview's inline script is syntactically valid JavaScript", async () => {
  const files = await tsFiles(SRC);
  let checked = 0;
  const failures: string[] = [];

  for (const file of files) {
    const text = await readFile(file, "utf8");
    if (!text.includes("<script")) continue;
    for (const { js, at } of scriptsIn(file, text)) {
      checked++;
      try {
        // Function() parses without executing — exactly the check we want.
        new Function(js);
      } catch (err) {
        failures.push(
          `${relative(SRC, file)}:${at} — ${(err as Error).message}`,
        );
      }
    }
  }

  assert.equal(
    failures.join("\n"),
    "",
    `webview script(s) failed to parse:\n${failures.join("\n")}`,
  );
  assert.ok(checked > 0, "found no webview scripts to check — the scan broke");
});
