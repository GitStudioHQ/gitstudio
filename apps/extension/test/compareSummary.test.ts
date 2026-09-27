// The Compare panel's summary counts in words that agree with the number, and
// each ref pill wears the icon of what it names.
//
// It read "1 commits" and "1 files changed", and both pills carried the branch
// icon even when a ref was a tag or a commit. The panel's real render() runs
// here under the vscode stand-in; what a ref names is resolved by real git.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Resolver = { _resolveFilename: (request: unknown, ...rest: unknown[]) => string };
const resolver = Module as unknown as Resolver;
const resolve = resolver._resolveFilename;
resolver._resolveFilename = function (request: unknown, ...rest: unknown[]) {
  return request === "vscode" ? join(__dirname, "vscodeStub.cjs") : resolve.call(this, request, ...rest);
};
// comparePanel.ts imports the shared tokens.css as text (esbuild's "text" loader).
const loaders = (Module as unknown as { _extensions: Record<string, (m: { exports: unknown }, f: string) => void> })._extensions;
loaders[".css"] = (m, f) => {
  m.exports = readFileSync(f, "utf8");
};

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const { ComparePanel } = require("../src/compare/comparePanel") as typeof import("../src/compare/comparePanel");
const { compareRefsData } = require("../src/compare/refCompare") as typeof import("../src/compare/refCompare");
const { GitContext } = require("@gitstudio/git-service/GitContext") as typeof import("@gitstudio/git-service/GitContext");
/* eslint-enable @typescript-eslint/no-require-imports */
import type { CompareResult } from "../src/compare/refCompare";

const cfg = join(mkdtempSync(join(tmpdir(), "gs-compare-summary-cfg-")), "config");
writeFileSync(cfg, "");
process.env.GIT_CONFIG_GLOBAL = cfg;
process.env.GIT_CONFIG_SYSTEM = cfg;
process.env.GIT_CONFIG_NOSYSTEM = "1";

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((f) => f()));

/** The panel's render() over `result`, comparing `base` with `head`. */
function render(base: string, head: string, result: CompareResult): string {
  const self = {
    base,
    head,
    threeDot: true,
    extensionUri: {},
    panel: { webview: { asWebviewUri: (u: unknown) => u, cspSource: "" } },
  };
  return (ComparePanel.prototype as unknown as { render: (r: CompareResult) => string }).render.call(self, result);
}

const commit = (i: number) => ({ sha: String(i).repeat(40), subject: `c${i}`, author: "a", authorDate: 0 });
const file = (p: string) => ({ path: p, status: "M", additions: 1, deletions: 0 });

function result(n: number, kinds: Pick<CompareResult, "baseKind" | "headKind">): CompareResult {
  return {
    commits: Array.from({ length: n }, (_, i) => commit(i + 1)),
    files: Array.from({ length: n }, (_, i) => file(`f${i}.ts`)),
    additions: n,
    deletions: 0,
    ahead: n,
    behind: 0,
    filesLeftRef: "b".repeat(40),
    ...kinds,
  } as unknown as CompareResult;
}

const metric = (html: string, id: string): string => {
  const m = new RegExp(`<b id="${id}">\\d+</b> ([a-z ]+)</span>`).exec(html);
  return m ? m[1] : "";
};
const pillIcon = (html: string, id: string): string => {
  const m = new RegExp(`id="${id}"[^>]*><i class="codicon codicon-([a-z-]+)"`).exec(html);
  return m ? m[1] : "";
};

test("one commit and one file read in the singular; two in the plural", () => {
  const one = render("main", "feature", result(1, { baseKind: "branch", headKind: "branch" }));
  assert.equal(metric(one, "m-commits"), "commit");
  assert.equal(metric(one, "m-files"), "file changed");
  const two = render("main", "feature", result(2, { baseKind: "branch", headKind: "branch" }));
  assert.equal(metric(two, "m-commits"), "commits");
  assert.equal(metric(two, "m-files"), "files changed");
});

test("each pill's icon says what its ref is", () => {
  const html = render("v1.0", "origin/main", result(1, { baseKind: "tag", headKind: "remote" }));
  assert.equal(pillIcon(html, "pick-base"), "tag");
  assert.equal(pillIcon(html, "pick-head"), "cloud");
  const shas = render("abc1234", "main", result(1, { baseKind: "commit", headKind: "branch" }));
  assert.equal(pillIcon(shas, "pick-base"), "git-commit");
  assert.equal(pillIcon(shas, "pick-head"), "git-branch");
});

// Between the two pills sat git's own ".." or "..." — range syntax, beside
// the mode buttons that already say in words which comparison it is.
test("the bar goes from one ref to the other with an arrow, never git's dot syntax", () => {
  for (const threeDot of [true, false]) {
    const self = {
      base: "main",
      head: "feature",
      threeDot,
      extensionUri: {},
      panel: { webview: { asWebviewUri: (u: unknown) => u, cspSource: "" } },
    };
    const html = (ComparePanel.prototype as unknown as { render: (r: CompareResult) => string }).render.call(
      self,
      result(2, { baseKind: "branch", headKind: "branch" }),
    );
    const bar = html.slice(html.indexOf('<div class="cmp-bar">'), html.indexOf('<div class="cmp-diffstat">'));
    const between = bar.slice(bar.indexOf('id="pick-base"'), bar.indexOf('id="pick-head"'));
    assert.doesNotMatch(between, />\s*\.{2,3}\s*</, `no dots between the pills (${threeDot ? "three" : "two"}-dot)`);
    assert.match(between, /<span class="cmp-arrow" aria-hidden="true"><i class="codicon codicon-arrow-right"><\/i><\/span>/);
    assert.match(bar, />What feature adds<\/button>/, "the mode buttons say which comparison it is");
    assert.match(bar, />All differences<\/button>/);
  }
});

test("what each ref names, as git resolves it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-compare-summary-"));
  const git = (...a: string[]): string => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-qm", "one");
  git("tag", "v1.0");
  writeFileSync(join(dir, "a.txt"), "b\n");
  git("commit", "-qam", "two");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  const ctx = new GitContext({ root: dir });
  cleanups.push(() => {
    ctx.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  const repo = { root: dir, ctx } as never;
  const tagged = await compareRefsData(repo, "v1.0", "main", true);
  assert.deepEqual([tagged.baseKind, tagged.headKind], ["tag", "branch"]);
  const remote = await compareRefsData(repo, git("rev-parse", "--short", "v1.0"), "origin/main", false);
  assert.deepEqual([remote.baseKind, remote.headKind], ["commit", "remote"]);
});
