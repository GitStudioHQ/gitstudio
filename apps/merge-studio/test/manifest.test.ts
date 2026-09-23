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
  // Test VSIXs are packaged as 0.4.9001 and package.json is restored after.
  assert.equal(pkg.version, "0.4.0");
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

test("the launcher path is user-only and protected in Restricted Mode", () => {
  const props = configurationProperties(pkg.contributes.configuration) as Record<string, { scope?: string }>;
  assert.equal(props["jbMerge.jetbrainsPath"].scope, "machine");
  const caps = (pkg as unknown as { capabilities: { untrustedWorkspaces: { restrictedConfigurations: string[] } } })
    .capabilities;
  assert.deepEqual(caps.untrustedWorkspaces.restrictedConfigurations, ["jbMerge.jetbrainsPath"]);
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
  { todo: "POLISH B3: the listing shots are captured from the final 0.4 build (SHOTS.md)" },
  () => {
    for (const m of readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
      if (!/^https?:/.test(m[1])) assert.ok(existsSync(join(ROOT, m[1])), m[1]);
    }
  },
);

// ── CHANGELOG (POLISH B5) ───────────────────────────────────────────────────

const changelog = read("CHANGELOG.md");
const entry040 = changelog.split(/\n## /)[1] ?? "";

test("the 0.4.0 entry comes first and leads with the heads-up about Yours in a rebase", () => {
  assert.match(entry040, /^0\.4\.0\b/);
  const firstLine = entry040.split("\n").slice(1).find((l) => l.trim() !== "") ?? "";
  assert.match(firstLine, /^\*\*Heads-up: during a rebase, Yours is now your commit, on the left\.\*\*/);
});

test("the 0.4.0 entry is in the user's words (no renderer internals)", () => {
  // Code spans are what the user types or sees (a setting's value, a git
  // command), so they are not prose.
  const prose = entry040.replace(/`[^`]*`/g, "");
  for (const word of [/\bSVG\b/, /replaced element/, /\d+\s?px\b/, /\bwebview\b/i, /\besbuild\b/i]) {
    assert.ok(!word.test(prose), String(word));
  }
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
