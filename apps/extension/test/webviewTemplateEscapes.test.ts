import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Our webviews are built by returning a big template literal of HTML with an
// inline <script> inside it. That makes the webview's JavaScript a *string*, and
// a string processes backslash escapes before the browser ever sees it.
//
// `\s` is not a JavaScript escape sequence, so the backslash is silently
// dropped: source `/\s/` reaches the webview as `/s/`. No compiler, linter or
// type check flags it — the literal is valid, it just means something else.
//
// This shipped. `DLG_VALIDATORS.refName` read `if (/s/.test(v)) return "Cannot
// contain spaces."`, so creating or renaming a branch to anything containing the
// letter "s" was rejected for containing a space, while an actual space passed.
// The ref-character check on the next line rotted the same way — `\[` and `\\`
// collapsed and the character class silently stopped rejecting ~ ^ : ? * [ and \.
//
// The fix is `String.raw`, which hands the text over untouched while still
// interpolating ${...}. This guard makes the trap unrepeatable: an untagged
// template literal may not contain an invalid escape sequence. Tag the literal
// `String.raw` (see changes/commitView.ts, ai/aiCommands.ts, compare/comparePanel.ts,
// rebase/rebaseWorkspacePanel.ts), or write the character without its backslash.
//
// Note the one thing String.raw cannot express: a literal backtick or `${`.
// Those still need to be built up some other way.

// Every place webview or renderer JS is authored as a string. The extension is
// where it bit us, but the desktop renderer and the shared webview-ui build the
// same way, so guard them together rather than waiting for the second instance.
const ROOTS = [
  "../src",
  "../../desktop/src",
  "../../mcp/src",
  "../../../packages/webview-ui/src",
  "../../../packages/engine/src",
  "../../../packages/git-service/src",
  "../../../packages/host-bridge/src",
  "../../../packages/ai/src",
  "../../../packages/secret-store/src",
].map((r) => fileURLToPath(new URL(r, import.meta.url)));

const REPO = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * Characters that legitimately follow a backslash in a template literal.
 * Anything else means the backslash is discarded — which is never intentional.
 */
const VALID_ESCAPE = new Set([
  "b", "f", "n", "r", "t", "v", "0", "x", "u", "'", '"', "`", "$", "\\", "\n", "\r",
]);

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await tsFiles(full)));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const TEMPLATE_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
]);

/**
 * True when the literal owning this chunk is tagged `String.raw`.
 *
 * The tag sits on the whole literal, not the chunk, and the chunks are not all
 * the same distance from it: a TemplateHead hangs directly off the
 * TemplateExpression, but a TemplateMiddle/Tail hangs off a TemplateSpan in
 * between. So climb to the literal rather than assuming a fixed depth — reading
 * only `node.parent` silently reports every raw literal as untagged.
 */
function isRawTagged(node: ts.Node): boolean {
  let owner: ts.Node = node;
  while (
    owner.parent &&
    !ts.isTemplateExpression(owner) &&
    owner.kind !== ts.SyntaxKind.NoSubstitutionTemplateLiteral
  ) {
    owner = owner.parent;
  }
  const parent = owner.parent;
  return !!parent && ts.isTaggedTemplateExpression(parent) && parent.tag.getText() === "String.raw";
}

test("no invalid escape sequences in untagged template literals", async () => {
  const files = (await Promise.all(ROOTS.map(tsFiles))).flat();
  assert.ok(files.length > 100, "expected to have scanned the monorepo sources");

  const violations: string[] = [];

  for (const file of files) {
    // readFile, not a text search. Several files here once embedded literal NUL
    // bytes as delimiters, which made rg/grep classify them as binary and skip
    // them silently; those are now written as "\u0000" and noLiteralNulBytes
    // .test.ts keeps them that way. Reading the file directly is still the right
    // call: it cannot be defeated by whatever the next such byte turns out to be.
    const source = await readFile(file, "utf8");
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const rel = relative(REPO, file).split("\\").join("/");
    const lines = source.split("\n");

    const visit = (node: ts.Node): void => {
      if (TEMPLATE_KINDS.has(node.kind) && !isRawTagged(node)) {
        const start = node.getStart(sf);
        const raw = source.slice(start, node.getEnd());
        for (let i = 0; i < raw.length; i++) {
          if (raw[i] !== "\\") continue;
          const next = raw[i + 1];
          if (next === "\\") {
            i++; // an escaped backslash consumes its partner
            continue;
          }
          if (next !== undefined && !VALID_ESCAPE.has(next)) {
            const { line } = sf.getLineAndCharacterOfPosition(start + i);
            violations.push(
              `${rel}:${line + 1} — \\${next} is not an escape, so it reaches the ` +
                `webview as a bare "${next}"\n    ${lines[line].trim().slice(0, 100)}`,
            );
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  assert.deepEqual(
    violations,
    [],
    `Template literals must not swallow backslashes — tag the literal String.raw:\n\n${violations.join("\n\n")}\n`,
  );
});
