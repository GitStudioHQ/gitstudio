import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configurationProperties } from "@gitstudio/merge-vscode/contract";
import {
  MS_DEFERS_CONTEXT_KEY,
  MS_IDE_CONTEXT_KEY,
  MS_MERGE_VIEW_TYPES,
  MS_WALKTHROUGH_ID,
} from "../src/ids";

// Merge Studio's own listing: the manifest's brand slots, the walkthrough, the
// README and the CHANGELOG (POLISH B1, B2, B4, B5). The shared merge contract
// and the GitStudio twins are parity.test.ts.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

interface Step {
  id: string;
  title: string;
  description: string;
  when?: string;
  media: { svg?: string; image?: string | Record<string, string>; markdown?: string; altText?: string };
  completionEvents?: string[];
}
const pkg = JSON.parse(read("package.json")) as {
  name: string;
  publisher: string;
  version: string;
  license: string;
  engines: { vscode: string };
  repository: { url: string };
  keywords: string[];
  contributes: {
    commands: { command: string; icon?: string }[];
    menus: Record<string, { command?: string; when?: string }[]>;
    configuration: unknown;
    customEditors: { viewType: string; displayName: string; priority?: string }[];
    walkthroughs: { id: string; steps: Step[] }[];
  };
};

test("the extension id, publisher and repository are Merge Studio's", () => {
  assert.equal(`${pkg.publisher}.${pkg.name}`, "gitstudio.merge-studio");
  assert.match(pkg.repository.url, /GitStudioHQ\/merge-studio/);
});

test("the committed version is the release version, never a test build's", () => {
  // The first release on the shared packages is 1.0.0 (the owner's call, not
  // 0.4.0). Test VSIXs are packaged as 1.0.9001, 1.0.9002, … and package.json
  // is restored after.
  assert.equal(pkg.version, "1.0.0");
});

test("keywords: at most 30, and none that only name other editors (POLISH B1)", () => {
  assert.ok(pkg.keywords.length <= 30, `${pkg.keywords.length} keywords`);
  for (const k of ["vscode", "windsurf"]) assert.ok(!pkg.keywords.includes(k), k);
});

test("the merge editor keeps 0.3.4's view type and stays an Open With… option", () => {
  const editor = pkg.contributes.customEditors.find((e) => e.viewType === MS_MERGE_VIEW_TYPES.mergeEditor);
  assert.equal(editor?.priority, "option");
  assert.equal(editor?.displayName, "Merge Studio (3-way merge)");
});

test("every editor-title button has an icon (no text buttons in the tab bar)", () => {
  const icons = new Map(pkg.contributes.commands.map((c) => [c.command, c.icon]));
  for (const e of pkg.contributes.menus["editor/title"]) {
    assert.ok(icons.get(e.command ?? ""), `${e.command} has no icon`);
  }
});

test("the JetBrains commands stay out of the palette without an IDE", () => {
  for (const id of ["jbMerge.mergeWithJetBrains", "jbMerge.diffWithJetBrains"]) {
    const e = pkg.contributes.menus.commandPalette.find((x) => x.command === id);
    assert.ok(e?.when?.includes(MS_IDE_CONTEXT_KEY), `${id}: ${e?.when}`);
  }
});

test("the launcher path is user-only: a workspace can never set the program Merge Studio launches", () => {
  const props = configurationProperties(pkg.contributes.configuration) as Record<string, { scope?: string }>;
  assert.equal(props["jbMerge.jetbrainsPath"].scope, "machine");
});

test("Restricted Mode is declared as it is: Merge Studio needs VS Code's Git extension, which Restricted Mode turns off", () => {
  // Verified in an isolated VS Code 1.138 (review r0923b): in an untrusted
  // folder vscode.git (untrustedWorkspaces.supported: false) is off, so Merge
  // Studio, which depends on it, never activates — its commands are not even
  // in the palette. 0.3.4's "limited … everything else works" was untrue.
  const pkgFull = pkg as unknown as {
    extensionDependencies: string[];
    capabilities: { untrustedWorkspaces: { supported: unknown; description: string; restrictedConfigurations?: unknown } };
  };
  assert.deepEqual(pkgFull.extensionDependencies, ["vscode.git"]);
  const trust = pkgFull.capabilities.untrustedWorkspaces;
  assert.equal(trust.supported, false);
  assert.equal(trust.restrictedConfigurations, undefined, "only meaningful with limited support");
  assert.match(trust.description, /Git extension/);
  assert.doesNotMatch(trust.description, /everything else works/);
  assert.ok(!readme.includes("In Restricted Mode a workspace cannot set"), "the README says the same");
});

// ── The walkthrough (POLISH B2) ─────────────────────────────────────────────

const walkthrough = pkg.contributes.walkthroughs.find((w) => w.id === MS_WALKTHROUGH_ID);

test("the walkthrough keeps 0.3.4's id and the step ids that still mean the same thing", () => {
  assert.ok(walkthrough, "mergeStudio.gettingStarted is gone");
  const ids = walkthrough.steps.map((s) => s.id);
  for (const id of ["mergeStudio.tryMerge", "mergeStudio.realConflicts", "mergeStudio.tryDiff", "mergeStudio.handoff"]) {
    assert.ok(ids.includes(id), id);
  }
});

test("seven steps whichever product owns the automatic behaviour: 'Choose your merge editor' or 'Using GitStudio too?'", () => {
  const steps = walkthrough!.steps;
  assert.equal(steps.length, 8);
  const shown = (defers: boolean) =>
    steps.filter((s) => {
      if (s.when === `!${MS_DEFERS_CONTEXT_KEY}`) return !defers;
      if (s.when === MS_DEFERS_CONTEXT_KEY) return defers;
      return true;
    }).length;
  assert.equal(shown(false), 7);
  assert.equal(shown(true), 7);
  assert.equal(steps.find((s) => s.id === "mergeStudio.handoff")?.when, MS_IDE_CONTEXT_KEY);
});

test("every walkthrough link and completion event names a command that exists", () => {
  const declared = new Set(pkg.contributes.commands.map((c) => c.command));
  const builtIns = new Set(["workbench.action.openSettings"]);
  for (const s of walkthrough!.steps) {
    for (const [, id] of s.description.matchAll(/\(command:([\w.-]+)/g)) {
      assert.ok(declared.has(id) || builtIns.has(id), `${s.id} links to ${id}`);
    }
    for (const ev of s.completionEvents ?? []) {
      const m = /^onCommand:(.+)$/.exec(ev);
      if (m) assert.ok(declared.has(m[1]), `${s.id} completes on ${m[1]}`);
    }
  }
});

test("walkthrough text renders as written: no backticks, every media file present", () => {
  for (const s of walkthrough!.steps) {
    assert.ok(!s.description.includes("`"), `${s.id} has a backtick`);
    const files = [s.media.svg, s.media.markdown, ...(typeof s.media.image === "string" ? [s.media.image] : Object.values(s.media.image ?? {}))]
      .filter((f): f is string => typeof f === "string");
    assert.ok(files.length > 0, `${s.id} has no media`);
    for (const f of files) assert.ok(existsSync(join(ROOT, f)), `${s.id}: ${f} is missing`);
    assert.ok(s.media.altText && s.media.altText.length > 10, `${s.id} has no alt text`);
  }
});

test(
  "the walkthrough shows captures from the final build, never a placeholder",
  { todo: "POLISH B3: the eight media/walkthrough/*.svg still read 'Screenshot pending' (SHOTS.md); a release gate" },
  () => {
    for (const s of walkthrough!.steps) {
      for (const f of [s.media.svg, ...(typeof s.media.image === "string" ? [s.media.image] : Object.values(s.media.image ?? {}))]) {
        if (typeof f === "string") assert.doesNotMatch(read(f), /Screenshot pending|Placeholder/, `${s.id}: ${f}`);
      }
    }
  },
);

// ── README (POLISH B4) ──────────────────────────────────────────────────────

const readme = read("README.md");
const shotList = read("SHOTS.md");

test("the README makes none of 0.3.4's claims that are no longer true", () => {
  for (const phrase of ["never had", "No conflict is missed", "1.74", "vulnerabilities-0", "Cancel Merge", "magic-wand for identical"]) {
    assert.ok(!readme.includes(phrase), phrase);
  }
});

test("every setting is in the README's settings table", () => {
  const props = Object.keys(configurationProperties(pkg.contributes.configuration));
  for (const key of props) assert.ok(readme.includes(`\`${key}\``), key);
});

test("every README image is either in the package or on the shot list captured from the final build", () => {
  const images = [...readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)|<img[^>]+src="([^"]+)"/g)]
    .map((m) => m[1] ?? m[2])
    .filter((src) => !/^https?:/.test(src));
  assert.ok(images.length > 0);
  for (const src of images) {
    assert.ok(existsSync(join(ROOT, src)) || shotList.includes(src), `${src} is neither present nor on SHOTS.md`);
  }
});

test(
  "every README image exists",
  { todo: "POLISH B3: the listing shots are captured from the final 1.0 build (SHOTS.md)" },
  () => {
    for (const m of readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
      if (!/^https?:/.test(m[1])) assert.ok(existsSync(join(ROOT, m[1])), m[1]);
    }
  },
);

// ── CHANGELOG (POLISH B5) ───────────────────────────────────────────────────

const changelog = read("CHANGELOG.md");
const entry100 = changelog.split(/\n## /)[1] ?? "";
const sectionsOf = (entry: string) => entry.split(/\n### /).slice(1);

test("the 1.0.0 entry comes first and leads with the heads-up about Yours in a rebase", () => {
  assert.match(entry100, /^1\.0\.0\b/);
  const firstLine = entry100.split("\n").slice(1).find((l) => l.trim() !== "") ?? "";
  assert.match(firstLine, /^\*\*Heads-up: during a rebase, Yours is now your commit, on the left\.\*\*/);
});

test("the 1.0.0 entry is in the user's words (no internals, no invented symbols)", () => {
  // Code spans are what the user types or sees (a setting's value, a git
  // command), so they are not prose.
  const prose = entry100.replace(/`[^`]*`/g, "");
  for (const word of [/\bSVG\b/, /replaced element/, /\d+\s?px\b/, /\bwebview\b/i, /\besbuild\b/i, /\bstage [123]\b/i, /\bPOLISH\b/, /\bD\d\b/]) {
    assert.ok(!word.test(prose), String(word));
  }
  // The owner's rule for the merge editor holds for its changelog too: no
  // glyphs of our own, and the old conflict colour is gone.
  for (const glyph of ["≠", "≈", "‹", "›", "✨", "⚠"]) assert.ok(!prose.includes(glyph), glyph);
  assert.doesNotMatch(prose, /\borange\b/i);
});

test("the 1.0.0 entry says the colours in words, as the legend names them", () => {
  const colours = sectionsOf(entry100).find((s) => s.startsWith("The colours")) ?? "";
  assert.ok(colours, "a section on the colours");
  const pairs: Array<[string, string]> = [
    ["Conflicts", "red"],
    ["Same on both sides", "violet"],
    ["Changed", "blue"],
    ["Added", "green"],
    ["Removed", "grey"],
  ];
  for (const [name, colour] of pairs) {
    const line = colours.split("\n").find((l) => l.includes(`**${name}**`)) ?? "";
    assert.match(line, new RegExp(`\\b${colour}\\b`), `${name} is said to be ${colour}`);
  }
});

test("the 1.0.0 entry covers the operation, the dashboard, what keeps your work safe, and what changed since 0.3.4", () => {
  const headings = sectionsOf(entry100).map((s) => s.split("\n")[0].trim());
  const want = ["The colours", "Continue, Skip and Abort", "The Conflicts dashboard", "Your work is safe", "Changed since 0.3.4", "Fixed since 0.3.4"];
  assert.deepEqual(
    want.filter((h) => !headings.includes(h)),
    [],
    `headings: ${headings.join(" | ")}`,
  );
});

test("the 0.3.4 history is kept below it", () => {
  assert.ok(changelog.includes("## 0.3.4 — 2026-06-24"));
  assert.ok(changelog.includes("## 0.1.0 — 2026-06-11"));
});

// ── Licence ─────────────────────────────────────────────────────────────────

test("the shell is MIT; the bundled GitStudio packages' Apache-2.0 text and NOTICE ship beside it", () => {
  assert.match(read("LICENSE"), /^MIT License/);
  assert.match(read("LICENSE-APACHE"), /Apache License\s+Version 2\.0/);
  const notice = read("NOTICE");
  assert.match(notice, /Apache License, Version 2\.0/);
  assert.match(notice, /MIT/);
  assert.equal(pkg.license, "MIT AND Apache-2.0");
  const ignore = read(".vscodeignore");
  for (const f of ["LICENSE", "LICENSE-APACHE", "NOTICE"]) {
    assert.ok(!new RegExp(`^${f}$`, "m").test(ignore), `${f} must ship`);
  }
});

test("NOTICE reproduces the bundled GitStudio packages' own attribution notice (Apache-2.0 section 4(d))", () => {
  // GitStudio's NOTICE: the monorepo root, or its vendored copy in merge-studio.
  const gsNotice = [join(ROOT, "vendor/gitstudio/NOTICE"), resolve(ROOT, "../../NOTICE")].find((p) => existsSync(p));
  assert.ok(gsNotice, "GitStudio's NOTICE is not where the build can see it");
  const flat = (s: string) => s.replace(/\s+/g, " ").trim();
  const ours = flat(read("NOTICE"));
  // Its attribution paragraphs: the name and copyright, and "This product includes …".
  const paragraphs = readFileSync(gsNotice, "utf8").split(/\n\s*\n/).map(flat).filter(Boolean);
  const attribution = paragraphs.filter((p, i) => i === 0 || /^This product includes/.test(p));
  assert.equal(attribution.length, 2, JSON.stringify(paragraphs));
  for (const p of attribution) assert.ok(ours.includes(p), `NOTICE lacks GitStudio's "${p}"`);
});
