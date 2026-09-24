// The commands the Merge Studio docs tell people to run, held to the scripts
// and package.json files they name. The docs were once run by hand, command by
// command, against a scratch export, a contributor's commit and an import; this
// keeps them from drifting after that: every `node scripts/...` line parses
// with the script's own argument reader, and every `npm run <script>` names a
// script that exists where the doc runs it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs as checkParityArgs } from "../check-parity.mjs";
import { GITSTUDIO_ROOT, parseArgs as exportArgs, standaloneFrom } from "../export.mjs";
import { parseArgs as importArgs } from "../import.mjs";

const DOCS = ["docs/merge-studio.md", "apps/merge-studio/RELEASING.md", "apps/merge-studio/CONTRIBUTING.md", "CONTRIBUTING.md"];

/** Placeholders a reader fills in, filled in. */
const fill = (s) =>
  s
    .replace(/<n>/g, "7")
    .replace(/<gitstudio sha>/g, "1a2b3c4")
    .replace(/<path>/g, "docs/")
    .replace(/"Name <email>"/g, '"Jane Contributor <jane@example.com>"');

/** Every command in a doc: the lines of its bash blocks, and inline code that starts like a command. */
export function commandsIn(markdown) {
  const out = [];
  for (const [, body] of markdown.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/g)) {
    for (const line of body.split("\n")) {
      const cmd = line.replace(/\s+#.*$/, "").trim();
      if (cmd) out.push(...cmd.split(/\s+&&\s+/));
    }
  }
  for (const [, span] of markdown.matchAll(/`([^`\n]+)`/g)) {
    if (/^(node|npm|npx|git|gh) /.test(span)) out.push(...span.split(/\s+&&\s+/));
  }
  return [...new Set(out.map((c) => fill(c.trim())))];
}

/** Shell words, quotes removed; a redirect and what follows it are not arguments. */
function words(cmd) {
  const w = [...cmd.matchAll(/"[^"]*"|'[^']*'|\S+/g)].map((m) => m[0].replace(/^(["'])(.*)\1$/, "$2"));
  const redirect = w.indexOf(">");
  return redirect >= 0 ? w.slice(0, redirect) : w;
}

const readJson = (rel) => JSON.parse(readFileSync(join(GITSTUDIO_ROOT, rel), "utf8"));

test("every doc exists, and the contributor guides link the page that explains the arrangement", () => {
  for (const d of DOCS) assert.ok(existsSync(join(GITSTUDIO_ROOT, d)), d);
  assert.match(readFileSync(join(GITSTUDIO_ROOT, "CONTRIBUTING.md"), "utf8"), /\]\(docs\/merge-studio\.md\)/);
  assert.match(readFileSync(join(GITSTUDIO_ROOT, "README.md"), "utf8"), /\]\(docs\/merge-studio\.md\)/);
  for (const d of ["apps/merge-studio/RELEASING.md", "apps/merge-studio/CONTRIBUTING.md"]) {
    // Exported to merge-studio's root, so the link must work from there: an absolute one.
    assert.match(readFileSync(join(GITSTUDIO_ROOT, d), "utf8"), /https:\/\/github\.com\/GitStudioHQ\/gitstudio\/blob\/main\/docs\/merge-studio\.md/, d);
  }
});

test("every `node scripts/...` command in the docs parses with the script's own arguments", () => {
  const seen = { import: 0, export: 0, parity: 0 };
  for (const doc of DOCS) {
    for (const cmd of commandsIn(readFileSync(join(GITSTUDIO_ROOT, doc), "utf8"))) {
      const w = words(cmd);
      if (w[0] !== "node" && !(w[0] === "npm" && w[1] === "run" && w[2] === "check-parity")) continue;
      const where = `${doc}: ${cmd}`;
      if (w[1] === "scripts/merge-studio/import.mjs") {
        const args = importArgs(w.slice(2));
        assert.ok(args.range ? args.from : args.patch, `${where}: a range needs --from, or a --patch`);
        seen.import++;
      } else if (w[1] === "scripts/merge-studio/export.mjs") {
        assert.ok(exportArgs(w.slice(2)).into, `${where}: --into`);
        seen.export++;
      } else if (w[1] === "scripts/check-parity.mjs" || w[1] === "scripts/merge-studio/check-parity.mjs") {
        checkParityArgs(w.slice(2));
        seen.parity++;
      } else if (w[0] === "npm") {
        // npm run check-parity -- <args>: what follows "--" reaches the script.
        checkParityArgs(w.includes("--") ? w.slice(w.indexOf("--") + 1) : []);
        seen.parity++;
      } else {
        assert.fail(`${where}: a script the docs name but this test does not know`);
      }
    }
  }
  assert.ok(seen.import >= 3 && seen.export >= 1 && seen.parity >= 2, JSON.stringify(seen));
});

test("every `npm run` in the docs names a script where it runs", () => {
  // A command runs in gitstudio (the root, or a workspace named with
  // --workspace) or in an exported merge-studio checkout.
  const gitstudio = readJson("package.json").scripts;
  const workspace = (ws) => readJson(`${ws}/package.json`).scripts ?? {};
  const mergeStudio = standaloneFrom().pkg.scripts;
  for (const doc of DOCS) {
    for (const cmd of commandsIn(readFileSync(join(GITSTUDIO_ROOT, doc), "utf8"))) {
      const w = words(cmd);
      if (w[0] !== "npm") continue;
      const script = w[1] === "run" ? w[2] : w[1];
      // npm's own commands, not scripts (RELEASING.md names `npm version` to say never to run it).
      if (["ci", "install", "version"].includes(script)) continue;
      const ws = w.includes("--workspace") ? w[w.indexOf("--workspace") + 1] : undefined;
      const where = `${doc}: ${cmd}`;
      if (ws) assert.ok(workspace(ws)[script], `${where}: ${ws} has no "${script}" script`);
      else assert.ok(gitstudio[script] || mergeStudio[script], `${where}: neither gitstudio nor merge-studio has a "${script}" script`);
    }
  }
});

test("a doc that imports a pull request by --range fetches merge-studio's main first", () => {
  // Run as written against a scratch export, the import refused a pull request
  // opened after an export was merged: `fetch origin pull/<n>/head:pr-<n>`
  // leaves origin/main where it was, so origin/main..pr-<n> took in the
  // export's own commit. The range starts at origin/main, so the doc brings it
  // up to date before it.
  for (const doc of DOCS) {
    const cmds = commandsIn(readFileSync(join(GITSTUDIO_ROOT, doc), "utf8"));
    const pr = cmds.findIndex((c) => /fetch origin \+?pull\/7\/head:pr-7/.test(c));
    const range = cmds.findIndex((c) => /import\.mjs .*--range origin\/main\.\.pr-7/.test(c));
    if (range < 0) continue;
    assert.ok(pr >= 0 && pr < range, `${doc}: fetches the pull request before importing it`);
    const main = cmds.findIndex((c) => c === "git -C ../merge-studio fetch origin");
    assert.ok(main >= 0 && main < pr, `${doc}: fetches merge-studio's main before the range that starts there`);
    // A contributor who pushes again rewrites their branch; a re-import must still get it.
    assert.match(cmds[pr], /fetch origin \+pull\//, `${doc}: the pull request's ref is fetched with a +`);
  }
});

/** A changelog's first entry: Unreleased for GitStudio and the desktop app, 1.0.0 for Merge Studio. */
function firstEntry(rel) {
  const text = readFileSync(join(GITSTUDIO_ROOT, rel), "utf8");
  return text.split(/\n## /)[1] ?? "";
}

test("the three changelogs say the merge editor's colours, its trace and Close the same way", () => {
  // The owner's rule (24 Sep 2026): a colour says the DECISION a change needs,
  // never what it did — "Conflict — you choose" in red, "Same on both sides —
  // either arrow takes it" in green whatever the change did, "One side only —
  // safe to take" in blue whatever it did. A settled change keeps a muted
  // trace of what was taken; Close leaves the editor and keeps the operation.
  // The research's violet is gone, and so is the per-type paint.
  for (const rel of ["apps/extension/CHANGELOG.md", "apps/desktop/CHANGELOG.md", "apps/merge-studio/CHANGELOG.md"]) {
    const entry = firstEntry(rel).replace(/\s+/g, " ");
    assert.doesNotMatch(entry, /\bviolet\b/i, `${rel}: no violet`);
    assert.match(entry, /\*\*Conflict — you choose\*\*,? in red/, `${rel}: red is "Conflict — you choose"`);
    assert.match(entry, /\*\*Same on both sides — either arrow takes it\*\*,? in green/, `${rel}: green is "Same on both sides — either arrow takes it"`);
    assert.match(entry, /\*\*One side only — safe to take\*\*,? in blue/, `${rel}: blue is "One side only — safe to take"`);
    assert.match(entry, /whether they added, changed or removed/i, `${rel}: green whatever the same change did`);
    assert.doesNotMatch(entry, /\*\*(Changed|Added|Removed)\*\*|blue, green or grey/, `${rel}: no merge colour for what a change did`);
    assert.match(entry, /lightness/i, `${rel}: red and green differ in lightness, for colour-blind eyes`);
    assert.match(entry, /either arrow takes it/i, `${rel}: either arrow takes it`);
    assert.match(entry, /muted trace of what you took/i, `${rel}: a settled change keeps a trace`);
    assert.match(entry, /\*\*Close\*\* leaves the (merge )?editor at any point without ending the operation/i, `${rel}: Close keeps the operation`);
  }
});

test("the unreleased changelogs carry the shared git fixes each product ships, once", () => {
  // The r0923 infra lane's fixes live in git-service, so both GitStudio
  // products ship them; the AI git tools are the desktop's only (Assistant,
  // Agent Access). Merge Studio has no stash or AI doors, so none of these.
  const shared = [
    [/stashed by its exact name/i, "a chosen file is stashed by its name, never as a pattern"],
    [/"GitStudio: before merging release"/, "a Stash & Retry stash names the branch the way you write it"],
    [/"continue the rebase", "commit the merge"/, "the unresolved-conflicts message names each operation's way on"],
    [/file\/folder conflict/i, "taking the file's side never deletes the folder"],
  ];
  for (const rel of ["apps/extension/CHANGELOG.md", "apps/desktop/CHANGELOG.md"]) {
    const entry = firstEntry(rel).replace(/\s+/g, " ");
    for (const [re, what] of shared) {
      assert.equal((entry.match(new RegExp(re.source, re.flags + "g")) ?? []).length, 1, `${rel}: says once that ${what}`);
    }
  }
  const desktop = firstEntry("apps/desktop/CHANGELOG.md").replace(/\s+/g, " ");
  assert.match(desktop, /The Assistant and Agent Access could end a stopped merge\.\*\* Asked to check out a branch, create one, or reset/, "the desktop: the AI git tools refuse over a stopped operation");
  const ms = firstEntry("apps/merge-studio/CHANGELOG.md").replace(/\s+/g, " ");
  assert.match(ms, /file\/folder conflict/i, "Merge Studio: taking the file's side never deletes the folder");
  assert.doesNotMatch(ms, /Stash & Retry|Assistant|Agent Access/, "Merge Studio ships neither door");
});

test("the docs name the files the export writes and the ones it never touches, as layout.mjs has them", () => {
  const guide = readFileSync(join(GITSTUDIO_ROOT, "apps/merge-studio/CONTRIBUTING.md"), "utf8");
  for (const f of ["VENDORED_FROM.json", "package-lock.json", "tsconfig.json", ".github/workflows/ci.yml", "scripts/check-parity.mjs"]) {
    assert.ok(guide.includes(`\`${f}\``), `CONTRIBUTING.md names ${f} as written by the export`);
  }
  const releasing = readFileSync(join(GITSTUDIO_ROOT, "apps/merge-studio/RELEASING.md"), "utf8");
  assert.ok(releasing.includes("scripts/merge-studio/merge-studio-ci.yml"), "RELEASING.md says where the CI workflow is kept");
});
