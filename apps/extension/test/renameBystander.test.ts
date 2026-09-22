import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// GitStudio is a bystander to every other extension's language features.
//
// Issue #25 reported that with GitStudio enabled, Pylance's Rename Symbol
// updated the definition but not the usages elsewhere in the project. Two
// audits of the extension found no mechanism: it registers nothing that takes
// part in a rename, it never edits a `file:` document outside the custom
// editors that own theirs, and it runs no git command that rewrites the working
// tree without a user action behind it. That is a property of the code as it
// stands, and every one of the ways a git extension COULD break a multi-file
// rename is one line away — a rename provider "for git-tracked files", an
// onWillSaveTextDocument that stages on save, a background applyEdit. This
// census keeps the audit true.
//
// What it pins, and why each would matter:
//   · no provider that participates in rename or reference resolution, or that
//     contributes edits (format, code actions) when another provider's edit
//     is applied — VS Code picks ONE rename provider by score, so ours could
//     shadow the language's;
//   · no "will" participant — onWillSaveTextDocument and the will-create/
//     rename/delete-files hooks contribute edits to, and can delay or fail,
//     someone else's operation;
//   · workspace.applyEdit / document.save only inside the three surfaces that
//     own the document they write (the merge editor, the diff panel, the rebase
//     todo editor) — a write anywhere else can bump a document's version under
//     a rename that is still being computed, and VS Code then drops that file
//     from the edit;
//   · nothing process-wide — the extension host is shared with the language
//     server's client, so a chdir or an env assignment reaches it too;
//   · no `configurationDefaults` (a silent way to change files.* / search.* /
//     another extension's settings for the user), no keybinding on the rename
//     gesture, and the `*` custom editor never at `default` priority.
//
// Hover stays allowed: blame's hover reads, it never writes.

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const MANIFEST = fileURLToPath(new URL("../package.json", import.meta.url));

/**
 * The surfaces that own the `file:` document they write. The merge editor and
 * the diff panel moved to packages/merge-vscode (shared with Merge Studio);
 * that package's test/guards.test.ts holds them to this same rule.
 */
const OWNS_ITS_DOCUMENT = new Set([
  "rebase/rebaseTodoEditor.ts",
]);

const BANNED_EVERYWHERE: { pattern: RegExp; why: string }[] = [
  {
    pattern:
      /languages\.register(?:Rename|Reference|DocumentHighlight|Definition|Declaration|Implementation|TypeDefinition|LinkedEditingRange|WorkspaceSymbol|DocumentSymbol|CodeActions|DocumentFormattingEdit|DocumentRangeFormattingEdit|OnTypeFormattingEdit)Provider\s*\(/,
    why: "takes part in another extension's rename / reference / edit application",
  },
  {
    pattern:
      /workspace\.onWill(?:SaveTextDocument|RenameFiles|CreateFiles|DeleteFiles|SaveNotebookDocument)\b/,
    why: "a will-participant contributes edits to, and can fail, someone else's operation",
  },
  {
    pattern: /workbench\.action\.files\.revert/,
    why: "reverts a document another extension may just have edited",
  },
  {
    pattern: /process\.chdir\s*\(|process\.env\.[A-Za-z_]+\s*=[^=]|process\.env\[[^\]]+\]\s*=[^=]/,
    why: "process-wide state in an extension host shared with the language server's client",
  },
];

const BANNED_OUTSIDE_OWNERS: { pattern: RegExp; why: string }[] = [
  {
    pattern: /workspace\.applyEdit\s*\(/,
    why: "edits a document GitStudio does not own",
  },
  {
    pattern: /\b(?:document|doc|editor\.document)\.save\s*\(\s*\)/,
    why: "saves a document GitStudio does not own",
  },
];

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await tsFiles(full)));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Strip comments so prose that NAMES a banned API is not the violation. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/[^\n]*$/gm, "");
}

test("the extension registers nothing that can take part in another extension's rename", async () => {
  const files = await tsFiles(SRC);
  assert.ok(files.length > 20, "expected to have scanned the extension sources");

  const violations: string[] = [];
  for (const file of files) {
    const rel = relative(SRC, file).split("\\").join("/");
    const code = stripComments(await readFile(file, "utf8"));
    const rules = OWNS_ITS_DOCUMENT.has(rel)
      ? BANNED_EVERYWHERE
      : [...BANNED_EVERYWHERE, ...BANNED_OUTSIDE_OWNERS];
    code.split("\n").forEach((line, i) => {
      for (const { pattern, why } of rules) {
        if (pattern.test(line)) {
          violations.push(`${rel}:${i + 1} — ${line.trim()}\n    ${why}`);
        }
      }
    });
  }

  assert.deepEqual(
    violations,
    [],
    `GitStudio must stay a bystander to other extensions' language features (issue #25):\n\n${violations.join("\n\n")}\n`,
  );
});

test("the surfaces allowed to write a document still exist", async () => {
  // An allowlist that names files which no longer exist would pass for the
  // wrong reason after a move; keep it honest.
  for (const rel of OWNS_ITS_DOCUMENT) {
    await readFile(join(SRC, rel), "utf8");
  }
});

test("the manifest contributes nothing that reaches into other extensions", async () => {
  const manifest = JSON.parse(await readFile(MANIFEST, "utf8")) as {
    contributes?: {
      configurationDefaults?: unknown;
      keybindings?: { command: string; key?: string; mac?: string }[];
      customEditors?: {
        viewType: string;
        selector: { filenamePattern: string }[];
        priority?: string;
      }[];
    };
  };
  const c = manifest.contributes ?? {};

  assert.equal(
    c.configurationDefaults,
    undefined,
    "configurationDefaults silently changes settings for the user, including other extensions'",
  );

  const renameKeys = (c.keybindings ?? []).filter(
    (k) =>
      /^(?:f2|shift\+f2|ctrl\+f2)$/i.test(k.key ?? "") ||
      /^(?:f2|shift\+f2|cmd\+f2)$/i.test(k.mac ?? "") ||
      /^editor\.action\.rename/.test(k.command),
  );
  assert.deepEqual(renameKeys, [], "a keybinding on the rename gesture");

  for (const editor of c.customEditors ?? []) {
    const catchAll = editor.selector.some((s) => s.filenamePattern === "*");
    if (catchAll) {
      assert.equal(
        editor.priority,
        "option",
        `${editor.viewType} matches every file, so it must only ever be an "Open With…" option`,
      );
    }
  }
});
