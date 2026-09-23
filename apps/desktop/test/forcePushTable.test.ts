// The force-push state table: every force door × every way the remote can
// hold work the user has not seen × a git with and without
// `--force-if-includes` — and the one invariant: a force push never deletes a
// commit the user has not seen.
//
//   door:     the desktop's Commit & Push (sync:push {force}, through the real
//             GitBridge), and the engine call every extension force door
//             makes — push({force}) from the Changes view's pill, its modal
//             and the status bar's Push; push({force, lease}) from Sync, leased
//             on the tip read before its own fetch
//   remote:   my own pushed commit, which I amended (an ordinary rewrite) ·
//             the same commit amended on my other machine and fetched here in
//             the background · a colleague's commit on top, fetched in the
//             background · the same, NOT fetched
//   git:      today's · one older than 2.30, which has no --force-if-includes
//             and refuses the flag outright

import "./hermeticGit";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempRepo } from "./tmpRepo";
import { RepoStore } from "../src/main/repoStore";
import { GitBridge } from "../src/main/gitBridge";
import { reportableResultMessage } from "../src/main/expectedError";
import { GitContext } from "@gitstudio/git-service/GitContext";

const scratch = mkdtempSync(join(tmpdir(), "gs-force-table-"));
after(() => removeTempRepo(scratch));

const AUTHORED = "1700000000 +0000";
function git(cwd: string, args: string[], committed?: number): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...(committed === undefined ? {} : { GIT_AUTHOR_DATE: AUTHORED, GIT_COMMITTER_DATE: `${committed} +0000` }),
    },
  });
}
function clone(bare: string, name: string): string {
  const dir = mkdtempSync(join(scratch, `${name.toLowerCase()}-`));
  execFileSync("git", ["clone", "-q", bare, dir], { stdio: "ignore" });
  for (const [k, v] of [["user.name", name], ["user.email", `${name.toLowerCase()}@example.com`], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) {
    git(dir, ["config", k, v]);
  }
  return dir;
}

type Remote = "my own rewrite" | "my other machine's amend, fetched" | "a colleague's push, fetched" | "a colleague's push, not fetched";
type Door = "desktop Commit & Push" | "extension force" | "extension Sync (leased)";
type Git = "git 2.30+" | "git 2.29";

/** Sets the scene; returns the machine to push from and the commit that must survive (or null). */
function scene(remote: Remote): { bare: string; here: string; mustSurvive: string | null } {
  const bare = mkdtempSync(join(scratch, "bare-"));
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare]);
  const laptop = clone(bare, "Me");
  writeFileSync(join(laptop, "base.txt"), "base\n");
  git(laptop, ["add", "."]);
  git(laptop, ["commit", "-q", "-m", "base"], 1699999000);
  writeFileSync(join(laptop, "f.txt"), "v1\n");
  git(laptop, ["add", "."]);
  git(laptop, ["commit", "-q", "-m", "work in progress"], 1700000000);
  git(laptop, ["push", "-q", "-u", "origin", "main"]);
  const here = clone(bare, "Me");
  let mustSurvive: string | null = null;
  if (remote === "my other machine's amend, fetched") {
    git(laptop, ["commit", "-q", "--amend", "-m", "fixed on the laptop"], 1700000050);
    git(laptop, ["push", "-q", "--force", "origin", "main"]);
    mustSurvive = git(laptop, ["rev-parse", "HEAD"]).trim();
    git(here, ["fetch", "-q", "origin"]); // the background fetch
  }
  if (remote.startsWith("a colleague's push")) {
    const colleague = clone(bare, "Colleague");
    writeFileSync(join(colleague, "theirs.txt"), "theirs\n");
    git(colleague, ["add", "."]);
    git(colleague, ["commit", "-q", "-m", "a colleague's commit"], 1700000060);
    git(colleague, ["push", "-q", "origin", "main"]);
    mustSurvive = git(colleague, ["rev-parse", "HEAD"]).trim();
    if (remote.endsWith(", fetched")) git(here, ["fetch", "-q", "origin"]);
  }
  // The rewrite this machine wants to force: its own copy of the pushed commit, amended.
  git(here, ["commit", "-q", "--amend", "-m", "reworded here"], 1700000100);
  return { bare, here, mustSurvive };
}

/** A git older than 2.30: says so, and refuses --force-if-includes as an unknown option. */
function olderGit(proc: { run: (args: string[], o?: unknown) => Promise<{ code: number; stdout: string; stderr: string }> }): void {
  const run = proc.run.bind(proc);
  proc.run = async (args, o) => {
    if (args[0] === "version") return { code: 0, stdout: "git version 2.29.2\n", stderr: "" };
    if (args.includes("--force-if-includes")) return { code: 129, stdout: "", stderr: "error: unknown option `force-if-includes'\n" };
    return run(args, o);
  };
}

async function force(door: Door, g: Git, here: string): Promise<{ ok: boolean; filed?: string; message?: string }> {
  if (door === "desktop Commit & Push") {
    const repos = new RepoStore([]);
    await repos.open(here);
    const bridge = new GitBridge(repos);
    if (g === "git 2.29") olderGit((bridge as unknown as { ctx(): GitContext }).ctx().process as never);
    const r = await bridge.syncPush({ force: true });
    return { ok: r.ok, filed: reportableResultMessage(r), message: r.message };
  }
  const ctx = new GitContext({ root: here });
  try {
    if (g === "git 2.29") olderGit(ctx.process as never);
    const seen = door === "extension Sync (leased)" ? await ctx.sync.upstreamTip() : null;
    if (door === "extension Sync (leased)") await ctx.process.run(["fetch", "-q", "origin"]); // Sync's own fetch
    const r = await ctx.sync.push({ force: true, ...(seen ? { lease: seen } : {}) });
    return { ok: r.ok, message: r.stderr };
  } finally {
    ctx.dispose();
  }
}

const REMOTES: Remote[] = ["my own rewrite", "my other machine's amend, fetched", "a colleague's push, fetched", "a colleague's push, not fetched"];
const DOORS: Door[] = ["desktop Commit & Push", "extension force", "extension Sync (leased)"];
const GITS: Git[] = ["git 2.30+", "git 2.29"];

for (const remote of REMOTES) {
  for (const door of DOORS) {
    for (const g of GITS) {
      test(`${door} × ${remote} × ${g}`, async () => {
        const { bare, here, mustSurvive } = scene(remote);
        const r = await force(door, g, here);
        const tip = git(bare, ["rev-parse", "main"]).trim();
        if (mustSurvive === null) {
          assert.equal(r.ok, true, `an ordinary rewrite is pushed: ${r.message}`);
          assert.equal(tip, git(here, ["rev-parse", "HEAD"]).trim());
          assert.equal(r.filed, undefined);
          return;
        }
        assert.equal(r.ok, false, "refused");
        assert.equal(tip, mustSurvive, "the work the user has not seen is still the remote's tip");
        // Refused by the app itself — the remote tip it would replace was
        // fetched but never this branch's: the user's state, never filed. (Not
        // fetched at all, it is git's own lease that refuses, with git's text.)
        if (door === "desktop Commit & Push" && remote.endsWith(", fetched")) {
          assert.equal(r.filed, undefined, `not filed: ${r.message}`);
          assert.match(r.message ?? "", /Pull them in/);
        }
      });
    }
  }
}
