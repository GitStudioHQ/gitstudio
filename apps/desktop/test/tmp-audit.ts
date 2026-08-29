import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "@gitstudio/git-service/index";
import { GitBridge } from "../src/main/gitBridge";
import type { RepoStore } from "../src/main/repoStore";

async function main() {
  const repo = mkdtempSync(join(tmpdir(), "aud-repo-"));
  const cfgDir = mkdtempSync(join(tmpdir(), "aud-cfg-"));
  const cfg = join(cfgDir, "gitconfig");
  writeFileSync(cfg, "");
  process.env.GIT_CONFIG_GLOBAL = cfg;
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo]);
  const ctx = new GitContext({ root: repo });
  const bridge = new GitBridge({ getContext: () => ctx } as unknown as RepoStore);

  console.log("1) save name+email:", JSON.stringify(
    await bridge.setGitIdentity({ name: "Old Name", email: "old@work-corp.com" })));
  console.log("   gitconfig:", JSON.stringify(readFileSync(cfg, "utf8")));

  console.log("\n2) user CLEARS email, presses Save:");
  const r2 = await bridge.setGitIdentity({ name: "Old Name", email: "" });
  console.log("   returned:", JSON.stringify(r2), "-> renderer toasts:",
    r2.ok ? '"Git identity updated." (success)' : "error");
  console.log("   gitconfig:", JSON.stringify(readFileSync(cfg, "utf8")));
  console.log("   reopened Settings reads:", JSON.stringify(await bridge.gitIdentity()));

  // Does a real commit still carry the old address?
  writeFileSync(join(repo, "a.txt"), "x");
  execFileSync("git", ["add", "a.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "after clearing email"], { cwd: repo });
  console.log("   commit author:", execFileSync("git",
    ["log", "-1", "--format=%an <%ae>"], { cwd: repo, encoding: "utf8" }).trim());

  console.log("\n3) same for a cleared NAME:");
  const r3 = await bridge.setGitIdentity({ name: "", email: "old@work-corp.com" });
  console.log("   returned:", JSON.stringify(r3));
  console.log("   gitconfig:", JSON.stringify(readFileSync(cfg, "utf8")));

  // --- Now evaluate the PROPOSED FIX: --unset ---
  console.log("\n4) proposed fix probe: what does `--unset` do when key is absent?");
  const un1 = await ctx.process.run(["config", "--global", "--unset", "user.nosuchkey"]);
  console.log("   unset absent key -> code:", un1.code, "stderr:", JSON.stringify(un1.stderr.trim()));

  console.log("\n5) proposed fix probe: identity fully unset -> can the user still commit?");
  await ctx.process.run(["config", "--global", "--unset", "user.email"]);
  await ctx.process.run(["config", "--global", "--unset", "user.name"]);
  console.log("   gitconfig:", JSON.stringify(readFileSync(cfg, "utf8")));
  writeFileSync(join(repo, "b.txt"), "y");
  execFileSync("git", ["add", "b.txt"], { cwd: repo });
  try {
    execFileSync("git", ["commit", "-m", "after unset"],
      { cwd: repo, encoding: "utf8", env: { ...process.env, EMAIL: undefined as never } });
    console.log("   commit SUCCEEDED, author:", execFileSync("git",
      ["log", "-1", "--format=%an <%ae>"], { cwd: repo, encoding: "utf8" }).trim());
  } catch (e: unknown) {
    const err = e as { stderr?: string; status?: number };
    console.log("   commit FAILED code", err.status, ":", String(err.stderr).trim().split("\n").slice(0,3).join(" | "));
  }
  ctx?.dispose?.();
}
void main();
