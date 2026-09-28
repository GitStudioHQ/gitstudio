// The files a push review and a branch compare list (collectCompareFiles) are
// named as they are on disk. git quotes an "unusual" path in its plain
// `--name-status` / `--numstat` output ("\303\251t\303\251.txt", with the
// quotes) unless it is asked for NUL-separated output, and a tab or a newline
// in a name split the line: the review listed a name no file has, its line
// counts went missing, and its diff opened nothing.

import Module from "node:module";
import { join } from "node:path";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

type Resolve = (request: string, parent: unknown, ...rest: unknown[]) => string;
const M = Module as unknown as { _resolveFilename: Resolve };
const orig = M._resolveFilename;
M._resolveFilename = function (request: string, parent: unknown, ...rest: unknown[]) {
  return request === "vscode" ? join(__dirname, "vscodeStub.cjs") : orig.call(this, request, parent, ...rest);
};
/* eslint-disable @typescript-eslint/no-require-imports */
const { collectCompareFiles } = require("../src/compare/refCompare") as typeof import("../src/compare/refCompare");
const { GitContext } = require("@gitstudio/git-service/GitContext") as typeof import("@gitstudio/git-service/GitContext");
/* eslint-enable @typescript-eslint/no-require-imports */

const cfg = join(mkdtempSync(join(tmpdir(), "gs-cmp-names-cfg-")), "config");
writeFileSync(cfg, "");
process.env.GIT_CONFIG_GLOBAL = cfg;
process.env.GIT_CONFIG_SYSTEM = cfg;
process.env.GIT_CONFIG_NOSYSTEM = "1";
const dir = realpathSync(mkdtempSync(join(tmpdir(), "gs-cmp-names-")));
const ctx = new GitContext({ root: dir });
after(() => {
  ctx.dispose();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("unicode, spaces, a tab and a rename: every file is named as it is on disk, with its counts", async () => {
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "T"], ["commit.gpgsign", "false"]]) git("config", k, v);
  writeFileSync(join(dir, "old name.txt"), "one\ntwo\nthree\nfour\nfive\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(dir, "été.txt"), "a\nb\n");
  // A tab is a legal character in a file name everywhere but Windows.
  const tab = process.platform !== "win32";
  if (tab) writeFileSync(join(dir, "tab\there.txt"), "t\n");
  git("mv", "old name.txt", "new näme.txt");
  writeFileSync(join(dir, "new näme.txt"), "one\ntwo\nthree\nfour\nfive\nsix\n");
  git("add", ".");
  git("commit", "-qm", "names");
  const files = await collectCompareFiles({ root: dir, ctx } as never, base, "HEAD", false);
  const byPath = new Map(files.map((f) => [f.path, f]));
  assert.deepEqual([...byPath.keys()].sort(), ["new näme.txt", ...(tab ? ["tab\there.txt"] : []), "été.txt"]);
  assert.deepEqual(byPath.get("été.txt"), { path: "été.txt", status: "A", additions: 2, deletions: 0, oldPath: undefined });
  if (tab) assert.deepEqual(byPath.get("tab\there.txt")?.additions, 1);
  assert.deepEqual(byPath.get("new näme.txt"), { path: "new näme.txt", status: "R", additions: 1, deletions: 0, oldPath: "old name.txt" });
});
