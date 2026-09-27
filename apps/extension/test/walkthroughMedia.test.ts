// The Get Started walkthrough shows each step's own surface, in each theme,
// and checks off the staging step where people stage.
//
// Every step's image was the GitStudio wordmark (the same file six times; the
// high-contrast theme got the dark one), with the alt text "GitStudio". Each
// step now shows the surface it leads to, rendered from the real page by
// harness/walkthrough/shots.ts in Dark+, Light+ and both high-contrast themes.
// "Stage a hunk & commit" was checked off only by the editor's Stage Hunk /
// Stage Selected Lines — never by staging or committing in the Changes view,
// where almost everyone does it.

import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

type Resolver = { _resolveFilename: (request: unknown, ...rest: unknown[]) => string };
const resolver = Module as unknown as Resolver;
const resolve = resolver._resolveFilename;
resolver._resolveFilename = function (request: unknown, ...rest: unknown[]) {
  return request === "vscode" ? join(__dirname, "vscodeStub.cjs") : resolve.call(this, request, ...rest);
};
/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const { walkthroughKey } = require("../src/ui/walkthroughProgress") as typeof import("../src/ui/walkthroughProgress");
/* eslint-enable @typescript-eslint/no-require-imports */

const ROOT = join(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  contributes: {
    walkthroughs: {
      steps: {
        id: string;
        description: string;
        completionEvents?: string[];
        media: { image: Record<string, string>; altText: string };
      }[];
    }[];
    commands: { command: string; title: string }[];
  };
};
const steps = pkg.contributes.walkthroughs[0].steps;

test("every step shows its own image in every theme — none of them the wordmark", () => {
  const seen = new Map<string, string>();
  let total = 0;
  for (const s of steps) {
    const img = s.media.image;
    assert.deepEqual(Object.keys(img).sort(), ["dark", "hc", "hcLight", "light"], `${s.id}: an image per theme`);
    for (const [theme, rel] of Object.entries(img)) {
      assert.doesNotMatch(rel, /wordmark/, `${s.id}/${theme}`);
      assert.ok(existsSync(join(ROOT, rel)), `${s.id}/${theme}: ${rel} ships`);
      const other = seen.get(rel);
      assert.ok(!other || other === s.id, `${rel} is both ${other}'s and ${s.id}'s`);
      seen.set(rel, s.id);
      const size = statSync(join(ROOT, rel)).size;
      assert.ok(size < 60 * 1024, `${rel} is ${Math.round(size / 1024)} KB — packed with harness/walkthrough/pack.py?`);
      total += size;
    }
    // The four themes are four renders, not one file four times — and not
    // one render under four names: Light+'s merge image was a byte copy of
    // the high-contrast one (the harness matched "-light-" inside
    // "-hc-light-"), and four different paths said nothing about that.
    assert.equal(new Set(Object.values(img)).size, 4, `${s.id}: four different files`);
    const byContent = new Map<string, string>();
    for (const [theme, rel] of Object.entries(img)) {
      const hash = createHash("sha256").update(readFileSync(join(ROOT, rel))).digest("hex");
      const twin = byContent.get(hash);
      assert.ok(!twin, `${s.id}: ${theme}'s image is the same picture as ${twin}'s (${rel})`);
      byContent.set(hash, theme);
    }
    assert.ok(s.media.altText.length > 30 && s.media.altText !== "GitStudio", `${s.id}: its alt text says what it shows`);
  }
  assert.ok(total < 700 * 1024, `the walkthrough's images add ${Math.round(total / 1024)} KB to the VSIX`);
  assert.equal(existsSync(join(ROOT, "media", "wordmark-dark.png")), false, "the wordmark renders, now unused, are gone");
});

test("a command a step names is the command's own title", () => {
  const titles = new Map(pkg.contributes.commands.map((c) => [c.command, c.title]));
  for (const s of steps) {
    for (const m of s.description.matchAll(/\[([^\]]+)\]\(command:(gitstudio\.[\w.]+)\)/g)) {
      const title = titles.get(m[2]);
      assert.ok(title, `${s.id}: ${m[2]} exists`);
      assert.equal(m[1], title, `${s.id}: the link says "${m[1]}", the command is "${title}"`);
    }
    assert.doesNotMatch(s.description, /✨/, `${s.id}: words, not an emoji the UI does not show`);
  }
});

test("staging or committing in the Changes view checks off the staging step", () => {
  const stage = steps.find((s) => s.id === "gitstudio.walkthrough.stage")!;
  assert.ok(stage.completionEvents?.includes(`onContext:${walkthroughKey("staged")}`), JSON.stringify(stage.completionEvents));
  assert.ok(stage.completionEvents?.includes(`onContext:${walkthroughKey("committed")}`));
  const view = readFileSync(join(ROOT, "src", "changes", "commitView.ts"), "utf8");
  assert.match(
    view,
    /if \(failure === undefined && what\?\.verb === "stage"\) \{\s*markWalkthrough\("staged"\);/,
    "a stage that worked marks it",
  );
  assert.match(view, /setStatusBarMessage\("\$\(check\) Committed", 3000\);\s*markWalkthrough\("committed"\);/, "so does a commit");
});
