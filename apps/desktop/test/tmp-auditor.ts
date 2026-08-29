import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "@gitstudio/git-service/index";
import { GitBridge } from "../src/main/gitBridge";
import type { RepoStore } from "../src/main/repoStore";

async function main() {
  const repo = mkdtempSync(join(tmpdir(), "gs-audit-repo-"));
  const cfgDir = mkdtempSync(join(tmpdir(), "gs-audit-cfg-"));
  const cfg = join(cfgDir, "gitconfig");
  writeFileSync(cfg, "");
  process.env.GIT_CONFIG_GLOBAL = cfg;
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo]);

  const ctx = new GitContext({ root: repo });
  const bridge = new GitBridge({ getContext: () => ctx } as unknown as RepoStore);

  const show = (label: string) => {
    console.log(`   gitconfig: ${JSON.stringify(readFileSync(cfg, "utf8"))}`);
  };

  console.log("STEP 1 — save name + email (what a user does first)");
  const r1 = await bridge.setGitIdentity({ name: "Old Name", email: "old@work-corp.com" });
  console.log("   returned:", JSON.stringify(r1));
  show("after 1");
  console.log("   bridge reads back:", JSON.stringify(await bridge.gitIdentity()));

  console.log("\nSTEP 2 — user CLEARS the Email field and presses Save identity");
  const r2 = await bridge.setGitIdentity({ name: "Old Name", email: "" });
  console.log("   returned:", JSON.stringify(r2));
  console.log("   renderer.ts:2894 -> r.ok true => toast('Git identity updated.', 'success')");
  show("after 2");
  console.log("   bridge reads back:", JSON.stringify(await bridge.gitIdentity()));

  console.log("\nSTEP 3 — what a commit is actually stamped with now");
  writeFileSync(join(repo, "a.txt"), "hi\n");
  execFileSync("git", ["add", "a.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "x"], { cwd: repo });
  const who = execFileSync("git", ["log", "-1", "--format=%an <%ae>"], { cwd: repo }).toString().trim();
  console.log("   commit author:", who);

  console.log("\nSTEP 4 — user CLEARS the Name field instead");
  const r3 = await bridge.setGitIdentity({ name: "", email: "old@work-corp.com" });
  console.log("   returned:", JSON.stringify(r3));
  show("after 4");
  console.log("   bridge reads back:", JSON.stringify(await bridge.gitIdentity()));

  ctx?.dispose?.();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
