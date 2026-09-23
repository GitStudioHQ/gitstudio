import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GitContext } from "@gitstudio/git-service/GitContext";
import { wireRefs } from "@gitstudio/host-bridge/graphWire";

// The refs a graph row's commit menu and the commit-details pane are built
// from (graphPanel.refsToWire), issue #30's follow-up. It was a copy of the
// graph's chip mapping that kept refs/remotes/origin/HEAD: the default
// branch's row menu offered "Checkout origin/HEAD" (git: "'HEAD' is not a
// valid branch name"), and the pane drew an origin/HEAD chip whose menu, the
// graph's, could only say "Not in the branch list yet". It is the graph's own
// mapping (wireRefs) now. The panel imports `vscode`, so the wiring is pinned
// at source level and the mapping is run against what real git lists.

const SRC = fileURLToPath(new URL("../src/graph/graphPanel.ts", import.meta.url));

test("the panel's menu and pane refs are the graph's chips, not a copy of the mapping", () => {
  const text = readFileSync(SRC, "utf8");
  const at = text.indexOf("private refsToWire(sha: string): MenuRef[] {");
  assert.ok(at > 0, "refsToWire is where it was");
  const body = text.slice(at, text.indexOf("\n  }\n", at));
  assert.match(body, /return wireRefs\(this\.refsBySha\.get\(sha\)\);/, "one mapping for the row, its menu and the pane");
  assert.doesNotMatch(body, /\.map\(/, "no second copy to drift");
});

test("…and that mapping leaves the remote's HEAD pointer out of what git lists", async () => {
  const cfg = join(mkdtempSync(join(tmpdir(), "gs-ext-pr-cfg-")), "config");
  writeFileSync(cfg, "");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_SYSTEM: cfg, GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" };
  const up = mkdtempSync(join(tmpdir(), "gs-ext-pr-up-"));
  const repo = mkdtempSync(join(tmpdir(), "gs-ext-pr-"));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  let ctx: GitContext | undefined;
  try {
    git(up, "init", "-q", "--bare", "-b", "main");
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@t.t");
    git(repo, "config", "user.name", "T");
    git(repo, "remote", "add", "origin", up);
    writeFileSync(join(repo, "f.txt"), "one\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "one");
    git(repo, "push", "-q", "-u", "origin", "refs/heads/main:refs/heads/main");
    git(repo, "remote", "set-head", "origin", "main");
    ctx = new GitContext({ root: repo });
    const tip = git(repo, "rev-parse", "HEAD");
    const listed = (await ctx.refs.listRefs()).filter((r) => r.sha === tip);
    assert.ok(listed.some((r) => r.fullName === "refs/remotes/origin/HEAD"), "git lists the pointer on the tip");
    const chips = wireRefs(listed).map((r) => r.fullName);
    assert.deepEqual(chips, ["refs/heads/main", "refs/remotes/origin/main"]);
  } finally {
    ctx?.dispose();
    rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(up, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
