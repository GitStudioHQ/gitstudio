// A commit's diff of a file it RENAMED reads the parent under the old name.
//
// The commit page's file list knows the old name (CommitFileChange.oldPath);
// the diff request dropped it, and `fileDiff` read `<parent>:<new name>`,
// which does not exist — so a rename with one edited line rendered as a
// brand-new file, every line added. The extension's Commit Graph had the same
// bug on the same shared commit-details panel.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoStore } from "../src/main/repoStore";
import { GitBridge } from "../src/main/gitBridge";
import { removeTempRepo } from "./tmpRepo";

test("a rename commit's diff shows the one edited line, not a new file", async () => {
  const root = mkdtempSync(join(tmpdir(), "gs-commit-rename-"));
  const git = (...a: string[]): string => execFileSync("git", a, { cwd: root, encoding: "utf8" });
  try {
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", root]);
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("config", "gc.auto", "0");
    git("config", "commit.gpgsign", "false");
    const body = Array.from({ length: 20 }, (_, i) => `line ${i}\n`).join("");
    writeFileSync(join(root, "old.ts"), body);
    git("add", "-A");
    git("commit", "-qm", "add");
    git("mv", "old.ts", "new.ts");
    writeFileSync(join(root, "new.ts"), body.replace("line 3\n", "LINE THREE\n"));
    git("add", "-A");
    git("commit", "-qm", "rename and edit");
    const sha = git("rev-parse", "HEAD").trim();

    const repos = new RepoStore([]);
    await repos.open(root);
    const b = new GitBridge(repos);
    const d = await b.fileDiff({ path: "new.ts", sha, oldPath: "old.ts" });
    assert.ok(d);
    assert.equal(d.leftText, body, "the parent side is the old file");
    assert.match(d.rightText, /LINE THREE/);
    assert.match(d.leftLabel, /old\.ts/, "and it is labelled with the name it had there");
  } finally {
    removeTempRepo(root);
  }
});
